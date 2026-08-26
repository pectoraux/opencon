/**
 * NET-W005 shared test harness.
 *
 * Extends the NET-W004 harness pattern: runtime + authenticated
 * principal + organization + allow policies for the evidence-layer
 * API guard actions (evidence.create, outcomeClaim.create,
 * attestation.create, proofOfValue.*, workflow.transition) + the
 * per-transition policies seeded from the PROOF_OF_VALUE_TRANSITION_
 * TABLE (so every legal PoV transition's policyAction matches a
 * policy for the harness person on the harness organization).
 *
 * The harness uses the file-backed PostgresAuthorityShim (test/dev
 * double from NET-W003) so it runs without a real PostgreSQL.
 */

import { createRuntime, type Runtime } from "../../src/bootstrap/runtime.ts";
import { createExecutionContext } from "../../src/core/execution-context.ts";
import type { ExecutionContext } from "../../src/core/execution-context.ts";
import {
  OPPORTUNITY_TRANSITION_TABLE,
  CONTRIBUTION_TRANSITION_TABLE,
  PROOF_OF_VALUE_TRANSITION_TABLE,
} from "../../src/workflows/transition-table.ts";
import type {
  AttestationSigner,
  AttestationVerifier,
  Evidence,
  ProofOfValue,
} from "../../src/evidence/port.ts";

export interface NetW005Harness {
  readonly runtime: Runtime;
  /** Bootstrap execution context (system actor). */
  readonly bootstrapCtx: ExecutionContext;
  /** The canonical person identity id of the authorized actor. */
  readonly personId: string;
  /** The subject id used by the API auth guard (X-Auth-Subject-Id). */
  readonly subjectId: string;
  /** The organization scope id (the tenant). */
  readonly organizationScopeId: string;
  /** Tear down the harness (shutdown the runtime). */
  teardown(): Promise<void>;
}

export interface NetW005HarnessOptions {
  /**
   * Explicit attestation signer/verifier adapters wired through the
   * composition root (exercises the "explicit-adapters" selection
   * mode). When omitted the dev/test default applies (test env).
   */
  readonly attestation?: {
    readonly signer?: AttestationSigner;
    readonly verifier?: AttestationVerifier;
  };
}

export async function createNetW005Harness(
  opts: NetW005HarnessOptions = {},
): Promise<NetW005Harness> {
  const runtime = createRuntime({
    forceEnv: "test",
    env: { APP_ENV: "test", LOG_LEVEL: "warn" },
    port: 0,
    ...(opts.attestation ? { attestation: opts.attestation } : {}),
  });
  await runtime.initialize();
  await runtime.api.start();
  const bootstrapCtx = createExecutionContext({
    correlationId: "net-w005-bootstrap",
    actor: { id: "bootstrap", kind: "service" },
  });
  // Create a canonical person identity for the authorized actor.
  const person = await runtime.identityService.createIdentity(bootstrapCtx, {
    displayName: "Test Actor",
    subjectReferences: [{ subjectId: "actor@example.com", providerKind: "internal" }],
  });
  // Create an organization the actor will act in.
  const org = await runtime.organizationService.createOrganization(bootstrapCtx, {
    name: "Test Org",
    creatorId: person.id,
  });

  // Seed ALLOW policies:
  //  - API guard actions for the NET-W005 endpoints (resource "*":
  //    any authenticated principal with an allow policy can call the
  //    endpoint; per-record org scoping is enforced by the services).
  //  - Per-transition policies scoped to the HARNESS PERSON on the
  //    harness organization (so the workflow service's per-subject
  //    authorization matches for every legal transition; other persons
  //    and other orgs are denied deny-by-default).
  const guardActions = [
    "opportunity.create",
    "contribution.create",
    "workflow.transition",
    "evidence.create",
    "outcomeClaim.create",
    "outcomeClaim.attachEvidence",
    "attestation.create",
    "proofOfValue.create",
    "proofOfValue.attachEvidence",
    "proofOfValue.aggregate",
    "proofOfValue.attest",
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
  for (const rule of [
    ...OPPORTUNITY_TRANSITION_TABLE,
    ...CONTRIBUTION_TRANSITION_TABLE,
    ...PROOF_OF_VALUE_TRANSITION_TABLE,
  ]) {
    await runtime.policyService.createPolicy(bootstrapCtx, {
      subject: person.id,
      action: rule.policyAction,
      resource: org.id,
      effect: "allow",
      createdBy: "bootstrap",
    });
  }

  return {
    runtime,
    bootstrapCtx,
    personId: person.id,
    subjectId: "actor@example.com",
    organizationScopeId: org.id,
    async teardown() {
      await runtime.shutdown();
    },
  };
}

/** Create an execution context for the harness person. */
export function actorCtx(harness: NetW005Harness, correlationId: string): ExecutionContext {
  return createExecutionContext({
    correlationId,
    actor: { id: harness.personId, kind: "person" },
  });
}

/** Create an opportunity through the OpportunityService (a PoV subject). */
export async function createOpportunitySubject(
  harness: NetW005Harness,
): Promise<{ id: string; organizationScopeId: string }> {
  const ctx = actorCtx(harness, "w005-subject-opportunity");
  const opp = await harness.runtime.opportunityService.createOpportunity(ctx, {
    organizationScopeId: harness.organizationScopeId,
    ownerId: harness.personId,
    opportunityType: "test-opportunity",
    title: "Test Opportunity",
    brief: { kind: "test" },
  });
  return { id: opp.id, organizationScopeId: opp.organizationScopeId };
}

/**
 * Create a contribution through the ContributionService (the typical
 * PoV subject).
 */
export async function createContributionSubject(
  harness: NetW005Harness,
  opportunityId: string,
): Promise<{ id: string; organizationScopeId: string }> {
  const ctx = actorCtx(harness, "w005-subject-contribution");
  const c = await harness.runtime.contributionService.createContribution(ctx, {
    opportunityId,
    contributorId: harness.personId,
    organizationScopeId: harness.organizationScopeId,
    contributionType: "test-contribution",
    submission: { kind: "test" },
  });
  return { id: c.id, organizationScopeId: c.organizationScopeId };
}

/** Default evidence input factory for the harness subject. */
export interface CreateEvidenceOptions {
  readonly sourceType?: "platform" | "attested" | "provider" | "model" | "self";
  readonly sourceId?: string;
  readonly method?: string;
  readonly point?: number;
  readonly lower?: number;
  readonly upper?: number;
  readonly sensitivity?: "standard" | "sensitive";
  readonly sensitivePayload?: string;
  readonly payload?: Readonly<Record<string, unknown>>;
  readonly payloadReference?: string;
}

export async function createEvidence(
  harness: NetW005Harness,
  subjectId: string,
  opts: CreateEvidenceOptions = {},
): Promise<Evidence> {
  const ctx = actorCtx(harness, "w005-evidence");
  return harness.runtime.evidenceService.createEvidence(ctx, {
    organizationScopeId: harness.organizationScopeId,
    ownerId: harness.personId,
    subjectReference: { subjectId, subjectType: "contribution" },
    provenance: {
      sourceType: opts.sourceType ?? "platform",
      ...(opts.sourceId !== undefined ? { sourceId: opts.sourceId } : {}),
      method: opts.method ?? "instrumentation",
    },
    confidence: {
      point: opts.point ?? 0.9,
      ...(opts.lower !== undefined ? { lower: opts.lower } : {}),
      ...(opts.upper !== undefined ? { upper: opts.upper } : {}),
    },
    ...(opts.sensitivity !== undefined ? { sensitivity: opts.sensitivity } : {}),
    ...(opts.payload !== undefined ? { payload: opts.payload } : {}),
    ...(opts.sensitivePayload !== undefined
      ? { sensitivePayload: opts.sensitivePayload }
      : {}),
    ...(opts.payloadReference !== undefined
      ? { payloadReference: opts.payloadReference }
      : {}),
  });
}

/** Create a Proof-of-Value for the given subject (DRAFT, version 0). */
export async function createProofOfValue(
  harness: NetW005Harness,
  subjectId: string,
  opts: { evidenceIds?: readonly string[] } = {},
): Promise<ProofOfValue> {
  const ctx = actorCtx(harness, "w005-pov");
  return harness.runtime.proofOfValueService.createProofOfValue(ctx, {
    organizationScopeId: harness.organizationScopeId,
    ownerId: harness.personId,
    subjectReference: { subjectId, subjectType: "contribution" },
    evidenceIds: opts.evidenceIds ?? [],
  });
}

/** Build the transition input for a PoV lifecycle operation. */
export function povTransitionInput(
  harness: NetW005Harness,
  proofId: string,
  expectedVersion: number,
  idempotencyKey: string,
): {
  proofId: string;
  expectedVersion: number;
  idempotencyKey: string;
  actorPersonId: string;
} {
  return {
    proofId,
    expectedVersion,
    idempotencyKey,
    actorPersonId: harness.personId,
  };
}
