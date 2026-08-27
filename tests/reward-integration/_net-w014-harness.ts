/**
 * NET-W014 shared test harness.
 *
 * Wraps the NET-W013 harness (runtime + the full helpful-contribution
 * chain incl. the qualified PoH fixture) and adds:
 *  - the reward-integration guard actions (3 mutations);
 *  - the VERIFIED-settled-contribution factory (a qualified helpful
 *    contribution driven through the /workflows canonical path to the
 *    terminal VERIFIED state — the recognition composite's gate 1);
 *  - the measured-outcome basis factory (a VERIFIED measured outcome
 *    attached to the PoH — the attributed_outcome clearing basis);
 *  - the recognition/maturation composite helpers (exactly as the
 *    runtime apiCommands execute them);
 *  - the ACTIVE-campaign factory (re-exported W011 helpers + the
 *    default clearing rule with a REAL reward policy).
 *
 * The harness uses the file-backed PostgresAuthorityShim (test/dev
 * double from NET-W003) so it runs without a real PostgreSQL.
 */

import {
  createNetW013Harness,
  createQualityPolicy,
  createQualifiedContribution,
  recordQualityEvaluation,
  contributorCtx as w013ContributorCtx,
  moderatorCtx,
  personCtx,
  key as w013Key,
  type NetW013Harness,
} from "../contributions/_net-w013-harness.ts";
import {
  createHelpfulnessPolicy,
  createHelpfulContribution,
  attachEvidenceBasis,
  publishHelpfulContribution,
  type NetW012Harness,
} from "../contributions/_net-w012-harness.ts";
import {
  activateReadyCampaign,
  type NetW011Harness,
} from "../campaigns/_net-w011-harness.ts";
import { createExecutionContext } from "../../src/core/execution-context.ts";
import type { ExecutionContext } from "../../src/core/execution-context.ts";
import type { Contribution } from "../../src/contributions/port.ts";
import type { EconomicValueRecord } from "../../src/settlement/port.ts";
import type { CampaignRecord } from "../../src/campaigns/port.ts";

export interface NetW014Harness {
  /** The wrapped NET-W013 harness (all its factories work unchanged). */
  readonly w013: NetW013Harness;
  readonly w012: NetW012Harness;
  readonly w011: NetW011Harness;
  readonly runtime: NetW013Harness["runtime"];
  readonly bootstrapCtx: ExecutionContext;
  /** The contributor (also the campaign owner in the harness chain). */
  readonly contributorPersonId: string;
  /** A different person in the same org (the moderator in tests). */
  readonly moderatorPersonId: string;
  readonly organizationScopeId: string;
  readonly secondOrgId: string;
  readonly secondOrgPersonId: string;
  teardown(): Promise<void>;
}

const GUARD_ACTIONS = [
  "reward.recognize",
  "reward.clear",
  "reward.reputation",
];

export async function createNetW014Harness(): Promise<NetW014Harness> {
  const w013 = await createNetW013Harness();
  const runtime = w013.runtime;
  const bootstrapCtx = w013.bootstrapCtx;

  for (const action of GUARD_ACTIONS) {
    await runtime.policyService.createPolicy(bootstrapCtx, {
      subject: "*",
      action,
      resource: "*",
      effect: "allow",
      createdBy: "bootstrap",
    });
  }

  return {
    w013,
    w012: w013.w012,
    w011: w013.w012.w011,
    runtime,
    bootstrapCtx,
    contributorPersonId: w013.contributorPersonId,
    moderatorPersonId: w013.moderatorPersonId,
    organizationScopeId: w013.organizationScopeId,
    secondOrgId: w013.secondOrgId,
    secondOrgPersonId: w013.secondOrgPersonId,
    async teardown() {
      await runtime.shutdown();
    },
  };
}

/** The contributor's execution context. */
export function contributorCtx(
  harness: NetW014Harness,
  correlationId: string,
): ExecutionContext {
  return personCtx(harness, harness.contributorPersonId, correlationId);
}

export { moderatorCtx, personCtx, w013ContributorCtx, w013Key };

/** Fresh idempotency keys (unique per call). */
export function key(prefix: string): string {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

// ---------------------------------------------------------------------------
// The VERIFIED-settled-contribution factory (the canonical fixture)
// ---------------------------------------------------------------------------

export interface CreateVerifiedSettledContributionOptions {
  readonly withMeasuredOutcomeBasis?: boolean;
  readonly withProofOfValueBasis?: boolean;
  readonly mentions?: readonly {
    readonly productRef: string;
    readonly disclosed: boolean;
    readonly commercialRelationshipRef: string | null;
  }[];
}

/**
 * A QUALIFIED helpful contribution driven through the /workflows
 * canonical path to the terminal VERIFIED lifecycle state: policy →
 * contribution → evidence basis (optionally + a VERIFIED measured
 * outcome basis) → publish (SUBMITTED) → PoH QUALIFIED → the six
 * forward transitions to VERIFIED.
 */
export async function createVerifiedSettledContribution(
  harness: NetW014Harness,
  opts: CreateVerifiedSettledContributionOptions = {},
): Promise<{
  contribution: Contribution;
  measuredOutcomeId: string | null;
  proofOfValueId: string | null;
}> {
  const helpfulnessPolicy = await createHelpfulnessPolicy(harness.w012);
  const { contribution } = await createHelpfulContribution(harness.w012, {
    helpfulnessPolicyId: helpfulnessPolicy.policyId,
    ...(opts.mentions !== undefined ? { mentions: opts.mentions } : {}),
  });
  await attachEvidenceBasis(harness.w012, contribution.id);
  const measuredOutcomeId = opts.withMeasuredOutcomeBasis
    ? (await attachMeasuredOutcomeBasis(harness, contribution.id))
        .measuredOutcomeId
    : null;
  const proofOfValueId = opts.withProofOfValueBasis
    ? (await attachProofOfValueBasis(harness, contribution.id))
        .proofOfValueId
    : null;
  await publishHelpfulContribution(harness.w012, contribution.id);
  const poh = await harness.runtime.helpfulnessService.evaluateHelpfulness(
    contributorCtx(harness, "w014-poh-eval"),
    { contributionId: contribution.id, idempotencyKey: key("w014-poh") },
  );
  if (poh.state !== "QUALIFIED") {
    throw new Error(
      `W014 harness fixture failed: PoH state ${poh.state} (reasons: ${poh.evaluations[poh.evaluations.length - 1]?.reasons.join("; ")})`,
    );
  }
  // Drive the lifecycle to the terminal VERIFIED state through the
  // /workflows authority (the W008 harness seeded the per-person
  // transition policies for the contributor).
  const ctx = contributorCtx(harness, "w014-verify-walk");
  const { policyActionFor } = await import("../../src/core/workflow.ts");
  const path = [
    "MEASURING",
    "EVALUATING",
    "CHALLENGE_WINDOW",
    "SETTLING",
    "SETTLED",
    "VERIFIED",
  ] as const;
  let current = await harness.runtime.contributionService.getContribution(
    ctx,
    contribution.id,
  );
  let step = 0;
  while (current.state !== "VERIFIED") {
    const from = current.state;
    const to = path[path.indexOf(from as (typeof path)[number]) + 1]!;
    step += 1;
    await harness.runtime.workflowService.requestTransition(
      {
        subjectId: contribution.id,
        subjectKind: "contribution",
        targetState: to,
        expectedVersion: current.version,
        idempotencyKey: key(`w014-t${String(step)}`),
        actorPersonId: harness.contributorPersonId,
        policyAction: policyActionFor(
          "contribution",
          from as "MEASURING",
          to as "VERIFIED",
        ),
        metadata: { rewardIntegration: "net-w014" },
      },
      ctx,
    );
    current = await harness.runtime.contributionService.getContribution(
      ctx,
      contribution.id,
    );
  }
  return { contribution: current, measuredOutcomeId, proofOfValueId };
}

/**
 * Create a VERIFIED measured outcome with the contribution as its
 * subject (outcomeType "helpfulness", platform provenance, rollup
 * confidence above the policy minimum) and attach it as a PoH
 * measured_outcome basis — the attributed_outcome clearing basis.
 */
export async function attachMeasuredOutcomeBasis(
  harness: NetW014Harness,
  contributionId: string,
): Promise<{ measuredOutcomeId: string }> {
  const ctx = contributorCtx(harness, "w014-measured-outcome");
  const observation =
    await harness.runtime.outcomeObservationService.createOutcomeObservation(
      ctx,
      {
        organizationScopeId: harness.organizationScopeId,
        observerId: harness.contributorPersonId,
        subjectReference: {
          subjectId: contributionId,
          subjectType: "contribution",
        },
        outcomeType: "helpfulness",
        observedValue: { value: 1, unit: "helpful-resolutions" },
        confidence: { point: 0.95, lower: 0.9, upper: 0.98 },
        provenance: {
          sourceType: "platform",
          sourceId: "platform-counter-w014",
          method: "platform-counter",
          methodVersion: "1.0.0",
        },
      },
    );
  const measurement =
    await harness.runtime.measuredOutcomeService.createMeasuredOutcome(ctx, {
      organizationScopeId: harness.organizationScopeId,
      ownerId: harness.contributorPersonId,
      subjectReference: {
        subjectId: contributionId,
        subjectType: "contribution",
      },
      outcomeType: "helpfulness",
      maturation: { strategy: "immediate" },
      observationIds: [observation.id],
    });
  await harness.runtime.measuredOutcomeService.beginMaturation(ctx, {
    measurementId: measurement.id,
    expectedVersion: 0,
    idempotencyKey: key("w014-mo-begin"),
    actorPersonId: harness.contributorPersonId,
  });
  await harness.runtime.measuredOutcomeService.recordMeasurementRollup(
    ctx,
    measurement.id,
  );
  const finalized = await harness.runtime.measuredOutcomeService.finalize(ctx, {
    measurementId: measurement.id,
    expectedVersion: 1,
    idempotencyKey: key("w014-mo-finalize"),
    actorPersonId: harness.contributorPersonId,
  });
  await harness.runtime.helpfulnessService.attachBasis(ctx, {
    contributionId,
    kind: "measured_outcome",
    referenceId: finalized.measurement.id,
    idempotencyKey: key("w014-mo-basis"),
  });
  return { measuredOutcomeId: finalized.measurement.id };
}

/**
 * Create a VERIFIED Proof-of-Value with the contribution as its
 * subject (the W008 chain: platform + provider evidence, an
 * attestation, aggregation → VERIFIED) and attach it as a PoH
 * proof_of_value basis — required for credit draws (architecture-lock
 * invariant 20: credit issuance requires a VERIFIED PoV reference)
 * and the measured_value clearing basis.
 */
export async function attachProofOfValueBasis(
  harness: NetW014Harness,
  contributionId: string,
): Promise<{ proofOfValueId: string }> {
  const ctx = contributorCtx(harness, "w014-pov");
  const eMeasured = await harness.runtime.evidenceService.createEvidence(ctx, {
    organizationScopeId: harness.organizationScopeId,
    ownerId: harness.contributorPersonId,
    subjectReference: { subjectId: contributionId, subjectType: "contribution" },
    provenance: { sourceType: "platform", sourceId: "platform-w014", method: "platform-counter" },
    confidence: { point: 0.9, lower: 0.85, upper: 0.95 },
    sensitivity: "standard",
    payload: { verified: true },
  });
  const eProvider = await harness.runtime.evidenceService.createEvidence(ctx, {
    organizationScopeId: harness.organizationScopeId,
    ownerId: harness.contributorPersonId,
    subjectReference: { subjectId: contributionId, subjectType: "contribution" },
    provenance: { sourceType: "provider", sourceId: "provider-w014", method: "provider-report" },
    confidence: { point: 0.9, lower: 0.85, upper: 0.95 },
    sensitivity: "standard",
    payload: { verified: true },
  });
  const proof = await harness.runtime.proofOfValueService.createProofOfValue(
    ctx,
    {
      organizationScopeId: harness.organizationScopeId,
      ownerId: harness.contributorPersonId,
      subjectReference: { subjectId: contributionId, subjectType: "contribution" },
      evidenceIds: [eMeasured.id, eProvider.id],
    },
  );
  await harness.runtime.proofOfValueService.beginMeasuring(ctx, {
    proofId: proof.id,
    expectedVersion: 0,
    idempotencyKey: key("w014-pov-begin"),
    actorPersonId: harness.contributorPersonId,
  });
  const attestation = await harness.runtime.attestationService.createAttestation(
    ctx,
    {
      organizationScopeId: harness.organizationScopeId,
      verifierId: harness.moderatorPersonId,
      statement: "Independently reviewed the attached evidence.",
      evidenceIds: [eMeasured.id, eProvider.id],
    },
  );
  await harness.runtime.proofOfValueService.attachAttestation(
    ctx,
    proof.id,
    attestation.id,
  );
  await harness.runtime.proofOfValueService.completeEvidenceGathering(ctx, {
    proofId: proof.id,
    expectedVersion: 1,
    idempotencyKey: key("w014-pov-evaluating"),
    actorPersonId: harness.contributorPersonId,
  });
  await harness.runtime.proofOfValueService.aggregateEvidence(ctx, proof.id);
  const verified = await harness.runtime.proofOfValueService.verify(ctx, {
    proofId: proof.id,
    expectedVersion: 2,
    idempotencyKey: key("w014-pov-verify"),
    actorPersonId: harness.contributorPersonId,
  });
  await harness.runtime.helpfulnessService.attachBasis(ctx, {
    contributionId,
    kind: "proof_of_value",
    referenceId: verified.proof.id,
    idempotencyKey: key("w014-pov-basis"),
  });
  return { proofOfValueId: verified.proof.id };
}

// ---------------------------------------------------------------------------
// Recognition + maturation composite helpers (as the apiCommands run)
// ---------------------------------------------------------------------------

export interface RecognizeValueOptions {
  readonly amount?: number;
  readonly maturation?: { readonly strategy: string; readonly windowEndAt?: string };
  readonly description?: string;
  readonly idempotencyKey?: string;
  readonly actorPersonId?: string;
}

/** The recognition composite (AC-01) exactly as the apiCommand runs it. */
export async function recognizeContributionValue(
  harness: NetW014Harness,
  contributionId: string,
  opts: RecognizeValueOptions = {},
): Promise<{
  value: EconomicValueRecord;
  created: boolean;
  proofOfHelpfulnessId: string;
}> {
  const ctx = personCtx(
    harness,
    opts.actorPersonId ?? harness.moderatorPersonId,
    "w014-recognize",
  );
  const result = await harness.runtime.apiCommands.recognizeContributionValue(
    ctx,
    opts.actorPersonId ?? harness.moderatorPersonId,
    {
      contributionId,
      amount: opts.amount ?? 100,
      ...(opts.maturation !== undefined ? { maturation: opts.maturation } : {}),
      ...(opts.description !== undefined
        ? { description: opts.description }
        : {}),
      idempotencyKey: opts.idempotencyKey ?? key("w014-recognize"),
    },
  );
  return {
    value: result.value as unknown as EconomicValueRecord,
    created: result.created,
    proofOfHelpfulnessId: result.proofOfHelpfulnessId,
  };
}

/** The matureEconomicValue apiCommand (gates included). */
export async function matureValue(
  harness: NetW014Harness,
  valueRecordId: string,
  opts: { readonly idempotencyKey?: string } = {},
): Promise<EconomicValueRecord> {
  const ctx = moderatorCtx(harness, "w014-mature");
  return (await harness.runtime.apiCommands.matureEconomicValue(ctx, {
    valueRecordId,
    idempotencyKey: opts.idempotencyKey ?? key("w014-mature"),
  })) as unknown as EconomicValueRecord;
}

/**
 * The full pipeline: verified contribution → PENDING → MATURE.
 */
export async function createRecognizedMatureValue(
  harness: NetW014Harness,
  opts: CreateVerifiedSettledContributionOptions &
    Pick<RecognizeValueOptions, "amount"> = {},
): Promise<{
  contribution: Contribution;
  measuredOutcomeId: string | null;
  proofOfValueId: string | null;
  value: EconomicValueRecord;
}> {
  const { contribution, measuredOutcomeId, proofOfValueId } =
    await createVerifiedSettledContribution(harness, opts);
  const recognized = await recognizeContributionValue(
    harness,
    contribution.id,
    { amount: opts.amount },
  );
  const matured = await matureValue(harness, recognized.value.id);
  return { contribution, measuredOutcomeId, proofOfValueId, value: matured };
}

// ---------------------------------------------------------------------------
// Campaign factory (ACTIVE with the default clearing rule)
// ---------------------------------------------------------------------------

export interface CreateClearingCampaignOptions {
  readonly totalAmount?: number;
}

/**
 * An ACTIVE campaign carrying the default W011 policy (objective
 * obj-1, clearing rule clear-1: basis attributed_outcome, draw kind
 * reward_allocation, a REAL same-scope reward policy lineage, budget
 * escrowed + recorded).
 */
export async function createClearingCampaign(
  harness: NetW014Harness,
  opts: CreateClearingCampaignOptions = {},
): Promise<CampaignRecord> {
  return activateReadyCampaign(harness.w011, {
    totalAmount: opts.totalAmount ?? 1000,
  });
}

// ---------------------------------------------------------------------------
// Quality + reputation helpers (re-exports for AC fixtures)
// ---------------------------------------------------------------------------

export { createQualityPolicy, recordQualityEvaluation };
export { EVALUATED_AT } from "../contributions/_net-w013-harness.ts";

/** A system-actor context (can never own campaigns). */
export function systemCtx(correlationId: string): ExecutionContext {
  return createExecutionContext({
    correlationId,
    actor: { id: "system-worker", kind: "system" },
  });
}
