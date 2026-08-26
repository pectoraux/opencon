/**
 * NET-W007 shared test harness.
 *
 * Extends the NET-W005/W006 harness patterns: runtime + authenticated
 * principal + organization + allow policies for the reputation-layer
 * API guard actions (reputationPolicy.create, reputationInput.create,
 * reputationSnapshot.create) + the per-transition policies seeded from
 * the OPPORTUNITY/CONTRIBUTION/PROOF_OF_VALUE/OUTCOME_MEASUREMENT
 * transition tables (so the harness person can drive contributions,
 * Proofs-of-Value and measured outcomes to VERIFIED — the upstream
 * records reputation inputs reference).
 *
 * The harness uses the file-backed PostgresAuthorityShim (test/dev
 * double from NET-W003) so it runs without a real PostgreSQL.
 */

import { createRuntime, type Runtime } from "../../src/bootstrap/runtime.ts";
import { createExecutionContext } from "../../src/core/execution-context.ts";
import type { ExecutionContext } from "../../src/core/execution-context.ts";
import type { ReputationDimension } from "../../src/core/reputation.ts";
import {
  CONTRIBUTION_TRANSITION_TABLE,
  OPPORTUNITY_TRANSITION_TABLE,
  OUTCOME_MEASUREMENT_TRANSITION_TABLE,
  PROOF_OF_VALUE_TRANSITION_TABLE,
} from "../../src/workflows/transition-table.ts";
import type {
  MeasuredOutcome,
  OutcomeObservation,
} from "../../src/outcomes/port.ts";
import type { Evidence, ProofOfValue } from "../../src/evidence/port.ts";
import type {
  ReputationScoringPolicy,
} from "../../src/reputation/port.ts";

export interface NetW007Harness {
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

export async function createNetW007Harness(): Promise<NetW007Harness> {
  const runtime = createRuntime({
    forceEnv: "test",
    env: { APP_ENV: "test", LOG_LEVEL: "warn" },
    port: 0,
  });
  await runtime.initialize();
  await runtime.api.start();
  const bootstrapCtx = createExecutionContext({
    correlationId: "net-w007-bootstrap",
    actor: { id: "bootstrap", kind: "service" },
  });
  // Create a canonical person identity for the authorized actor.
  const person = await runtime.identityService.createIdentity(bootstrapCtx, {
    displayName: "Reputation Actor",
    subjectReferences: [{ subjectId: "rep-actor@example.com", providerKind: "internal" }],
  });
  // Create an organization the actor will act in.
  const org = await runtime.organizationService.createOrganization(bootstrapCtx, {
    name: "Reputation Org",
    creatorId: person.id,
  });

  // Seed ALLOW policies:
  //  - API guard actions for the NET-W007 endpoints (resource "*").
  //  - Per-transition policies scoped to the HARNESS PERSON on the
  //    harness organization so upstream records (contributions, PoVs,
  //    measured outcomes) can be driven to VERIFIED.
  const guardActions = [
    "opportunity.create",
    "contribution.create",
    "workflow.transition",
    "evidence.create",
    "outcomeClaim.create",
    "attestation.create",
    "proofOfValue.create",
    "proofOfValue.attachEvidence",
    "proofOfValue.aggregate",
    "proofOfValue.attest",
    "outcomeObservation.create",
    "measuredOutcome.create",
    "measuredOutcome.recordRollup",
    "reputationPolicy.create",
    "reputationInput.create",
    "reputationSnapshot.create",
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
    ...OUTCOME_MEASUREMENT_TRANSITION_TABLE,
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
    subjectId: "rep-actor@example.com",
    organizationScopeId: org.id,
    async teardown() {
      await runtime.shutdown();
    },
  };
}

/** Create an execution context for the harness person. */
export function actorCtx(harness: NetW007Harness, correlationId: string): ExecutionContext {
  return createExecutionContext({
    correlationId,
    actor: { id: harness.personId, kind: "person" },
  });
}

// ---------------------------------------------------------------------------
// Upstream record factories (evidence / contribution / PoV / measured
// outcome) — the verified records reputation inputs reference.
// ---------------------------------------------------------------------------

export interface CreateEvidenceOptions {
  readonly sourceType?: "platform" | "attested" | "provider" | "model" | "self";
  readonly sourceId?: string;
  readonly point?: number;
}

export async function createEvidence(
  harness: NetW007Harness,
  opts: CreateEvidenceOptions = {},
): Promise<Evidence> {
  const ctx = actorCtx(harness, "w007-evidence");
  return harness.runtime.evidenceService.createEvidence(ctx, {
    organizationScopeId: harness.organizationScopeId,
    ownerId: harness.personId,
    subjectReference: { subjectId: harness.personId, subjectType: "contribution" },
    provenance: {
      sourceType: opts.sourceType ?? "platform",
      ...(opts.sourceId !== undefined ? { sourceId: opts.sourceId } : {}),
      method: "instrumentation",
    },
    confidence: { point: opts.point ?? 0.9 },
  });
}

/** Create an opportunity + contribution (DRAFT). */
export async function createContribution(harness: NetW007Harness): Promise<{
  id: string;
  organizationScopeId: string;
}> {
  const oppCtx = actorCtx(harness, "w007-contribution-opp");
  const opp = await harness.runtime.opportunityService.createOpportunity(oppCtx, {
    organizationScopeId: harness.organizationScopeId,
    ownerId: harness.personId,
    opportunityType: "test-opportunity",
    title: "Reputation Opportunity",
    brief: { kind: "test" },
  });
  const cCtx = actorCtx(harness, "w007-contribution");
  const c = await harness.runtime.contributionService.createContribution(cCtx, {
    opportunityId: opp.id,
    contributorId: harness.personId,
    organizationScopeId: harness.organizationScopeId,
    contributionType: "test-contribution",
    submission: { kind: "test" },
  });
  return { id: c.id, organizationScopeId: c.organizationScopeId };
}

/**
 * Drive a contribution DRAFT → … → VERIFIED through the workflow
 * authority (the full canonical path). Returns the verified
 * contribution id.
 */
export async function createVerifiedContribution(harness: NetW007Harness): Promise<string> {
  const contribution = await createContribution(harness);
  const ctx = actorCtx(harness, "w007-contribution-verified");
  const path: string[] = [
    "READY",
    "ASSIGNED",
    "IN_PROGRESS",
    "SUBMITTED",
    "MEASURING",
    "EVALUATING",
    "CHALLENGE_WINDOW",
    "SETTLING",
    "SETTLED",
    "VERIFIED",
  ];
  let current = "DRAFT";
  let version = 0;
  for (const target of path) {
    const result = await harness.runtime.workflowService.requestTransition(
      {
        subjectId: contribution.id,
        subjectKind: "contribution",
        targetState: target as never,
        expectedVersion: version,
        idempotencyKey: `w007-c-${contribution.id}-${target.toLowerCase()}`,
        actorPersonId: harness.personId,
        policyAction: `contribution.transition.${current.toLowerCase()}_to_${target.toLowerCase()}`,
      },
      ctx,
    );
    current = target;
    version = result.subject.version;
  }
  return contribution.id;
}

/**
 * Create a VERIFIED Proof-of-Value (evidence → PoV → transitions →
 * aggregation → attestation → verify). Returns the verified PoV.
 */
export async function createVerifiedPoV(harness: NetW007Harness): Promise<ProofOfValue> {
  const subject = await createContribution(harness);
  const eMeasured = await createEvidence(harness, { sourceType: "platform", sourceId: "inst-a" });
  const eProvider = await createEvidence(harness, { sourceType: "provider", sourceId: "provider-x" });
  const ctx = actorCtx(harness, "w007-pov");
  const proof = await harness.runtime.proofOfValueService.createProofOfValue(ctx, {
    organizationScopeId: harness.organizationScopeId,
    ownerId: harness.personId,
    subjectReference: { subjectId: subject.id, subjectType: "contribution" },
    evidenceIds: [eMeasured.id, eProvider.id],
  });
  const t = (version: number, key: string) => ({
    proofId: proof.id,
    expectedVersion: version,
    idempotencyKey: `w007-pov-${key}`,
    actorPersonId: harness.personId,
  });
  await harness.runtime.proofOfValueService.beginMeasuring(ctx, t(0, "begin"));
  const attestation = await harness.runtime.attestationService.createAttestation(ctx, {
    organizationScopeId: harness.organizationScopeId,
    verifierId: harness.personId,
    statement: "Independently reviewed the attached evidence.",
    evidenceIds: [eMeasured.id, eProvider.id],
  });
  await harness.runtime.proofOfValueService.attachAttestation(ctx, proof.id, attestation.id);
  await harness.runtime.proofOfValueService.completeEvidenceGathering(ctx, t(1, "evaluating"));
  await harness.runtime.proofOfValueService.aggregateEvidence(ctx, proof.id);
  const verified = await harness.runtime.proofOfValueService.verify(ctx, t(2, "verify"));
  return verified.proof;
}

/**
 * Create a VERIFIED measured outcome (immediate maturation). Returns
 * the verified measured outcome.
 */
export async function createVerifiedMeasuredOutcome(
  harness: NetW007Harness,
): Promise<MeasuredOutcome> {
  const subject = await createContribution(harness);
  const ctx = actorCtx(harness, "w007-measurement");
  const observation: OutcomeObservation =
    await harness.runtime.outcomeObservationService.createOutcomeObservation(ctx, {
      organizationScopeId: harness.organizationScopeId,
      observerId: harness.personId,
      subjectReference: { subjectId: subject.id, subjectType: "contribution" },
      outcomeType: "install",
      observedValue: { value: 12, unit: "installs" },
      confidence: { point: 0.95 },
      provenance: {
        sourceType: "platform",
        sourceId: "inst-a",
        method: "platform-counter",
        methodVersion: "1.0.0",
      },
    });
  const measurement = await harness.runtime.measuredOutcomeService.createMeasuredOutcome(ctx, {
    organizationScopeId: harness.organizationScopeId,
    ownerId: harness.personId,
    subjectReference: { subjectId: subject.id, subjectType: "contribution" },
    outcomeType: "install",
    maturation: { strategy: "immediate" },
    observationIds: [observation.id],
  });
  await harness.runtime.measuredOutcomeService.beginMaturation(ctx, {
    measurementId: measurement.id,
    expectedVersion: 0,
    idempotencyKey: `w007-mo-begin-${measurement.id}`,
    actorPersonId: harness.personId,
  });
  await harness.runtime.measuredOutcomeService.recordMeasurementRollup(ctx, measurement.id);
  const result = await harness.runtime.measuredOutcomeService.finalize(ctx, {
    measurementId: measurement.id,
    expectedVersion: 1,
    idempotencyKey: `w007-mo-finalize-${measurement.id}`,
    actorPersonId: harness.personId,
  });
  return result.measurement;
}

// ---------------------------------------------------------------------------
// Reputation factories (policies / inputs / snapshots).
// ---------------------------------------------------------------------------

/** A deterministic default rule set: uniform parameters per dimension. */
export const DEFAULT_POLICY_RULES = [
  "helpfulness",
  "content_quality",
  "creator_performance",
  "inventory_quality",
  "measurement_reliability",
  "commerce_reliability",
  "fraud_resistance",
  "fulfillment_reliability",
].map((dimension) => ({
  dimension,
  inputWeight: 1,
  decayHalfLifeDays: 90,
  maxScore: 100,
  indicatedWeightFactor: 0.25,
  indicatedOnlyCap: 10,
}));

/** Create the default scoring policy (version 1) and return it. */
export async function createDefaultPolicy(
  harness: NetW007Harness,
  policyId = "policy-w007-default",
): Promise<ReputationScoringPolicy> {
  const ctx = actorCtx(harness, "w007-policy");
  return harness.runtime.reputationPolicyService.createPolicyVersion(ctx, {
    organizationScopeId: harness.organizationScopeId,
    policyId,
    version: 1,
    description: "NET-W007 test policy",
    rules: DEFAULT_POLICY_RULES,
  });
}

export interface RecordInputOptions {
  readonly dimension?: ReputationDimension;
  readonly sources?: readonly { kind: string; id: string }[];
  readonly occurredAt?: string;
  readonly idempotencyKey?: string;
  readonly description?: string;
}

/**
 * Record a reputation input for the harness person. By default the
 * input references a fresh VERIFIED contribution (verified basis).
 */
export async function recordVerifiedInput(
  harness: NetW007Harness,
  opts: RecordInputOptions = {},
) {
  const contributionId = await createVerifiedContribution(harness);
  const ctx = actorCtx(harness, "w007-input");
  return harness.runtime.reputationInputService.recordInput(ctx, {
    organizationScopeId: harness.organizationScopeId,
    subjectPersonId: harness.personId,
    dimension: opts.dimension ?? "helpfulness",
    sources: opts.sources ?? [{ kind: "contribution", id: contributionId }],
    ...(opts.description !== undefined ? { description: opts.description } : {}),
    occurredAt: opts.occurredAt ?? "2024-06-01T00:00:00.000Z",
    idempotencyKey: opts.idempotencyKey ?? `w007-input-${contributionId}`,
  });
}

/** Fixed reference timestamps for deterministic decay assertions. */
export const REF_AT = "2024-07-01T00:00:00.000Z";
export const REF_AT_LATER = "2024-09-29T00:00:00.000Z"; // +90d = one half-life
