/**
 * NET-W009 shared test harness.
 *
 * Wraps the NET-W008 harness (runtime + persons + organization + the
 * full transition-table policy seeding + the upstream verified-record
 * factories: VERIFIED PoVs / measured outcomes / pending+mature value
 * records) and adds:
 *  - the risk guard actions (8 mutations + 2 workflow-hold actions);
 *  - the default risk policy factory (deterministic parameters);
 *  - risk signal / assessment / control factories over authoritative
 *    records;
 *  - a second organization for tenant-isolation proofs.
 *
 * The harness uses the file-backed PostgresAuthorityShim (test/dev
 * double from NET-W003) so it runs without a real PostgreSQL.
 */

import {
  createNetW008Harness,
  type NetW008Harness,
  type NetW008HarnessOptions,
} from "../settlement/_net-w008-harness.ts";
export type { NetW008HarnessOptions };
import { createExecutionContext } from "../../src/core/execution-context.ts";
import type { ExecutionContext } from "../../src/core/execution-context.ts";
import type { RiskPolicy } from "../../src/disputes/port.ts";

export interface NetW009Harness {
  /** The wrapped NET-W008 harness (all its factories work unchanged). */
  readonly w008: NetW008Harness;
  readonly runtime: NetW008Harness["runtime"];
  readonly bootstrapCtx: ExecutionContext;
  readonly personId: string;
  readonly subjectId: string;
  readonly organizationScopeId: string;
  readonly secondPersonId: string;
  readonly secondSubjectId: string;
  /** A second organization (tenant-isolation proofs). */
  readonly secondOrgId: string;
  /** The person acting in the second org. */
  readonly secondOrgPersonId: string;
  teardown(): Promise<void>;
}

export async function createNetW009Harness(
  opts: NetW008HarnessOptions = {},
): Promise<NetW009Harness> {
  const w008 = await createNetW008Harness(opts);
  const runtime = w008.runtime;
  const bootstrapCtx = w008.bootstrapCtx;

  // Seed ALLOW policies for the NET-W009 risk guard actions.
  const guardActions = [
    "riskSignal.create",
    "riskSignal.supersede",
    "riskPolicy.create",
    "riskAssessment.create",
    "riskCase.open",
    "riskCase.decide",
    "riskControl.activate",
    "riskControl.resolve",
    "riskWorkflowHold.apply",
    "riskWorkflowHold.clear",
  ];
  for (const action of guardActions) {
    await runtime.policyService.createPolicy(bootstrapCtx, {
      subject: "*",
      action,
      resource: "*",
      effect: "allow",
      createdBy: "bootstrap",
    });
  }

  // A second organization (with its own person) for tenant isolation.
  const secondOrgPerson = await runtime.identityService.createIdentity(bootstrapCtx, {
    displayName: "Risk Second Org Actor",
    subjectReferences: [{ subjectId: "risk-second-org@example.com", providerKind: "internal" }],
  });
  const secondOrg = await runtime.organizationService.createOrganization(bootstrapCtx, {
    name: "Risk Second Org",
    creatorId: secondOrgPerson.id,
  });

  return {
    w008,
    runtime,
    bootstrapCtx,
    personId: w008.personId,
    subjectId: w008.subjectId,
    organizationScopeId: w008.organizationScopeId,
    secondPersonId: w008.secondPersonId,
    secondSubjectId: w008.secondSubjectId,
    secondOrgId: secondOrg.id,
    secondOrgPersonId: secondOrgPerson.id,
    async teardown() {
      await runtime.shutdown();
    },
  };
}

/**
 * A FRESH subject person for tests that need an isolated signal set
 * (the engine evaluates ALL of a subject's signals — tests asserting
 * exact contribution sets must not share subjects).
 */
export async function freshSubject(harness: NetW009Harness): Promise<string> {
  const person = await harness.runtime.identityService.createIdentity(
    harness.bootstrapCtx,
    {
      displayName: `Risk Subject ${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
      subjectReferences: [
        {
          subjectId: `risk-subject-${Date.now()}-${Math.random().toString(36).slice(2, 8)}@example.com`,
          providerKind: "internal",
        },
      ],
    },
  );
  return person.id;
}

/** Create an execution context for the harness person. */
export function actorCtx(harness: NetW009Harness, correlationId: string): ExecutionContext {
  return createExecutionContext({
    correlationId,
    actor: { id: harness.personId, kind: "person" },
  });
}

/** An execution context for a DIFFERENT authenticated reviewer. */
export function reviewerCtx(harness: NetW009Harness, correlationId: string): ExecutionContext {
  return createExecutionContext({
    correlationId,
    actor: { id: harness.secondPersonId, kind: "person" },
  });
}

// ---------------------------------------------------------------------------
// Risk factories
// ---------------------------------------------------------------------------

/**
 * The default risk policy: consumes identity + velocity +
 * duplicate_pattern + model_advisory; requires identity (fail-closed
 * HOLD when absent); thresholds 2/4/8/12; advisory-only capped at
 * REVIEW; any non-advisory CRITICAL floors at HOLD.
 */
export async function createDefaultRiskPolicy(
  harness: NetW009Harness,
  policyId = "risk-policy-w009-default",
): Promise<RiskPolicy> {
  const ctx = actorCtx(harness, "w009-risk-policy");
  return harness.runtime.riskPolicyService.createPolicyVersion(ctx, {
    organizationScopeId: harness.organizationScopeId,
    policyId,
    version: 1,
    description: "NET-W009 test risk policy",
    rules: [
      {
        category: "identity",
        weight: 1,
        advisoryWeightFactor: 0.25,
        severityPoints: { LOW: 1, MEDIUM: 2, HIGH: 4, CRITICAL: 8 },
      },
      {
        category: "velocity",
        weight: 1,
        advisoryWeightFactor: 0.25,
        severityPoints: { LOW: 1, MEDIUM: 2, HIGH: 4, CRITICAL: 8 },
      },
      {
        category: "duplicate_pattern",
        weight: 1,
        advisoryWeightFactor: 0.25,
        severityPoints: { LOW: 1, MEDIUM: 2, HIGH: 4, CRITICAL: 8 },
      },
      {
        category: "model_advisory",
        weight: 1,
        advisoryWeightFactor: 0.25,
        severityPoints: { LOW: 1, MEDIUM: 2, HIGH: 4, CRITICAL: 8 },
      },
    ],
    thresholds: { watch: 2, review: 4, hold: 8, blocked: 12 },
    criticalFloorState: "HOLD",
    advisoryOnlyCapState: "REVIEW",
    requiredCategories: ["identity"],
    missingDataState: "HOLD",
  });
}

export interface CreateSignalOptions {
  readonly category?: string;
  readonly severity?: string;
  readonly confidence?: number;
  readonly provenanceKind?: string;
  readonly detectionMethod?: string;
  readonly sourceRefs?: readonly { kind: string; id: string }[];
  readonly description?: string;
  readonly subjectPersonId?: string;
  readonly idempotencyKey?: string;
}

/**
 * Create a risk signal for the harness person, by default citing a
 * fresh VERIFIED PoV as the authoritative source (proof_of_value kind,
 * authoritative_record provenance). The caller can override any field.
 */
export async function createDefaultSignal(
  harness: NetW009Harness,
  opts: CreateSignalOptions = {},
) {
  const { createVerifiedPoV } = await import("../settlement/_net-w008-harness.ts");
  const pov = await createVerifiedPoV(harness.w008);
  const ctx = actorCtx(harness, "w009-signal");
  return harness.runtime.riskSignalService.createSignal(ctx, {
    organizationScopeId: harness.organizationScopeId,
    subjectPersonId: opts.subjectPersonId ?? harness.personId,
    category: opts.category ?? "identity",
    severity: opts.severity ?? "HIGH",
    confidence: opts.confidence ?? 1,
    provenance: {
      kind: opts.provenanceKind ?? "authoritative_record",
      detectionMethod: opts.detectionMethod ?? "test-detector",
      detectionVersion: "1.0.0",
      sources: opts.sourceRefs ?? [{ kind: "proof_of_value", id: pov.id }],
    },
    ...(opts.description !== undefined ? { description: opts.description } : {}),
    detectedAt: "2024-05-01T00:00:00.000Z",
    idempotencyKey:
      opts.idempotencyKey ??
      `w009-signal-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
  });
}

/** Deterministic evaluation timestamps. */
export const EVALUATED_AT = "2024-06-01T00:00:00.000Z";
export const EVALUATED_AT_LATER = "2024-06-02T00:00:00.000Z";
