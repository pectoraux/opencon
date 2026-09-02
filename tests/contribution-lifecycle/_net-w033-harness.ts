/**
 * NET-W033 shared test harness — the complete contribution lifecycle
 * (Phase-9 end-to-end composition proof).
 *
 * Wraps the NET-W014 harness (the full helpful-contribution chain:
 * runtime + persons + organizations + the contribution/opportunity /
 * evidence / PoV / measured-outcome / workflow / recognition /
 * maturation machinery, on the file-backed PostgresAuthorityShim) and
 * adds exactly the MISSING composition joins the canonical path needs:
 *
 *  - ACTIVE /organizations memberships for the three benefit-pool
 *    members (the sanctioned membership authority — the W024/W028
 *    precedent; /benefits derives member eligibility server-side);
 *  - the NET-W028 benefits guard actions (the transport guards, so
 *    the composed benefit surfaces can also be exercised over HTTP);
 *  - the canonical end-to-end scenario factory
 *    `runCanonicalScenario` — ONE deterministic contribution
 *    traversing the ENTIRE frozen authoritative chain:
 *
 *      opportunity → contribution → /workflows lifecycle →
 *      /evidence Proof-of-Value → /outcomes measurement →
 *      /reputation → /settlement pending/mature → /benefits
 *
 *    with fixed evaluation anchors (OCCURRED_AT / REFERENCE_AT —
 *    never a wall clock) and every durable identifier returned.
 *
 * W033 adds NO source file, domain, authority or state machine: this
 * harness is pure test composition over the existing contracts.
 */

import { randomUUID } from "node:crypto";
import {
  createNetW014Harness,
  attachProofOfValueBasis,
  recognizeContributionValue,
  matureValue,
  type NetW014Harness,
} from "../reward-integration/_net-w014-harness.ts";
import {
  createHelpfulnessPolicy,
  createHelpfulContribution,
  createHelpfulCampaign,
  attachEvidenceBasis,
  publishHelpfulContribution,
  type NetW012Harness,
} from "../contributions/_net-w012-harness.ts";
import { DEFAULT_POLICY_RULES } from "../reputation/_net-w007-harness.ts";
import { createExecutionContext } from "../../src/core/execution-context.ts";
import type { ExecutionContext } from "../../src/core/execution-context.ts";
import { policyActionFor } from "../../src/core/workflow.ts";
import type { Contribution } from "../../src/contributions/port.ts";
import type {
  BenefitAllocationPolicy,
  BenefitPool,
} from "../../src/benefits/port.ts";
import type { EconomicValueRecord } from "../../src/settlement/port.ts";
import type { ReputationSnapshot } from "../../src/reputation/port.ts";

/** Deterministic decay/evaluation anchors (NEVER the wall clock). */
export const OCCURRED_AT = "2024-03-01T00:00:00.000Z";
export const REFERENCE_AT = "2024-07-01T00:00:00.000Z";
/** A LATER anchor (one full decay half-life) for determinism proofs. */
export const REFERENCE_AT_LATER = "2024-09-29T00:00:00.000Z";

export interface NetW033Harness {
  /** The wrapped NET-W014 harness (all its factories work unchanged). */
  readonly w014: NetW014Harness;
  readonly runtime: NetW014Harness["runtime"];
  readonly bootstrapCtx: ExecutionContext;
  /** The contributor (the canonical scenario's sole contributor). */
  readonly contributorPersonId: string;
  /** A different person in the same org (moderator / risk officer). */
  readonly moderatorPersonId: string;
  /** A third distinct person (the W010 dedicated reviewer — the third
   *  benefit-pool member; NOT the moderator, who IS the W008 second
   *  person in this harness chain). */
  readonly memberCPersonId: string;
  readonly organizationScopeId: string;
  readonly secondOrgId: string;
  readonly secondOrgPersonId: string;
  contributorCtx(correlationId: string): ExecutionContext;
  moderatorCtx(correlationId: string): ExecutionContext;
  memberCCtx(correlationId: string): ExecutionContext;
  teardown(): Promise<void>;
}

/** The NET-W028 benefit transport guard actions (seeded, as W028 did). */
const BENEFIT_GUARD_ACTIONS = [
  "benefits.policy.create",
  "benefits.policy.read",
  "benefits.pool.create",
  "benefits.pool.close",
  "benefits.pool.read",
  "benefits.allocation.evaluate",
  "benefits.allocation.execute",
  "benefits.allocation.read",
  "benefits.member.read",
];

/** The three canonical benefit-pool member weights (3 / 2 / 1). */
export const POOL_MEMBER_WEIGHTS = { a: 3, b: 2, c: 1 } as const;

export async function createNetW033Harness(): Promise<NetW033Harness> {
  const w014 = await createNetW014Harness();
  const runtime = w014.runtime;
  const bootstrapCtx = w014.bootstrapCtx;
  const memberCPersonId = w014.w013.w012.w011.w010.reviewerPersonId;

  // ACTIVE memberships for the three benefit-pool members — granted
  // through the SANCTIONED membership authority (/organizations; the
  // W024/W028 precedent). /benefits re-derives eligibility from this
  // state server-side (never caller-asserted).
  for (const personId of [
    w014.contributorPersonId,
    w014.moderatorPersonId,
    memberCPersonId,
  ]) {
    await runtime.membershipService.grantMembership(bootstrapCtx, {
      personId,
      organizationId: w014.organizationScopeId,
      grantedBy: "bootstrap",
    });
  }

  for (const action of BENEFIT_GUARD_ACTIONS) {
    await runtime.policyService.createPolicy(bootstrapCtx, {
      subject: "*",
      action,
      resource: "*",
      effect: "allow",
      createdBy: "bootstrap",
    });
  }

  return {
    w014,
    runtime,
    bootstrapCtx,
    contributorPersonId: w014.contributorPersonId,
    moderatorPersonId: w014.moderatorPersonId,
    memberCPersonId,
    organizationScopeId: w014.organizationScopeId,
    secondOrgId: w014.secondOrgId,
    secondOrgPersonId: w014.secondOrgPersonId,
    contributorCtx(correlationId: string) {
      return createExecutionContext({
        correlationId,
        actor: { id: w014.contributorPersonId, kind: "person" },
      });
    },
    moderatorCtx(correlationId: string) {
      return createExecutionContext({
        correlationId,
        actor: { id: w014.moderatorPersonId, kind: "person" },
      });
    },
    memberCCtx(correlationId: string) {
      return createExecutionContext({
        correlationId,
        actor: { id: memberCPersonId, kind: "person" },
      });
    },
    async teardown() {
      await runtime.shutdown();
    },
  };
}

/** Fresh idempotency keys (unique per call). */
export function key(prefix: string): string {
  return `${prefix}-${randomUUID()}`;
}

/** A person context for an arbitrary person id (cross-tenant proofs). */
export function personCtx(
  harness: NetW033Harness,
  personId: string,
  correlationId: string,
): ExecutionContext {
  return createExecutionContext({
    correlationId,
    actor: { id: personId, kind: "person" },
  });
}

// ---------------------------------------------------------------------------
// The canonical scenario — ONE contribution through the FULL frozen
// authoritative chain, with every durable identifier returned.
// ---------------------------------------------------------------------------

export interface CanonicalScenario {
  // Stage 1 — opportunity / contribution (AC-01)
  readonly campaignId: string;
  readonly opportunityId: string;
  readonly contribution: Contribution;
  readonly proofOfHelpfulnessId: string;
  // Stage 3 — evidence / Proof-of-Value (AC-03)
  readonly basisEvidenceId: string;
  readonly povPlatformEvidenceId: string;
  readonly povProviderEvidenceId: string;
  readonly attestationId: string;
  readonly proofOfValueId: string;
  // Stage 4 — normalized outcome (AC-04)
  readonly observationId: string;
  readonly measuredOutcomeId: string;
  // Stage 5 — reputation (AC-05)
  readonly reputationPolicyId: string;
  readonly directInputId: string;
  readonly settlementEffectInputId: string;
  // Stage 6 — settlement (AC-06)
  readonly value: EconomicValueRecord;
  readonly matureValue: EconomicValueRecord;
  // Stage 7 — reputation snapshot (AC-05)
  readonly snapshot: ReputationSnapshot;
  // Stage 8 — benefits (AC-07)
  readonly rewardPolicyId: string;
  readonly benefitPolicyId: string;
  readonly poolId: string;
  readonly allocationId: string;
  readonly allocation: {
    readonly id: string;
    readonly totalAllocated: number;
    readonly draw: unknown;
  };
}

export interface RunCanonicalScenarioOptions {
  /**
   * Skip the benefit allocation (the scenario stops after maturation +
   * reputation) — used by the AC-06/AC-09 gates-before-benefit tests.
   */
  readonly skipBenefitAllocation?: boolean;
  /** The recognized amount (default 100). */
  readonly amount?: number;
}

/**
 * The canonical deterministic scenario: ONE helpful contribution
 * traversing every authority in the frozen order. Every step runs
 * through the OWNING boundary (service or composition-root composite)
 * — never a direct repository write. Returns every durable identifier
 * in the lineage.
 */
export async function runCanonicalScenario(
  harness: NetW033Harness,
  opts: RunCanonicalScenarioOptions = {},
): Promise<CanonicalScenario> {
  const runtime = harness.runtime;
  const ctx = harness.contributorCtx("w033-canonical");

  // -- Stage 1: an ACTIVE campaign publishing a HELPFUL opportunity
  //    (the eligibility rule: participant_class equals contributor),
  //    then the contribution through the sanctioned contribution
  //    service (the helpfulness composite — same path as apiCommand).
  const { campaign, opportunityId } = await createHelpfulCampaign(
    harness.w014.w012,
  );
  const helpfulnessPolicy = await createHelpfulnessPolicy(
    harness.w014.w012,
    { policyId: key("w033-helpfulness-policy") },
  );
  const { contribution, proofOfHelpfulness } = await createHelpfulContribution(
    harness.w014.w012,
    {
      opportunityId,
      helpfulnessPolicyId: helpfulnessPolicy.policyId,
    },
  );

  // -- Stage 3a: the ATTESTED evidence basis for the PoH.
  const { evidenceId: basisEvidenceId } = await attachEvidenceBasis(
    harness.w014.w012,
    contribution.id,
  );

  // -- Stage 3b: the VERIFIED Proof-of-Value (platform + provider
  //    evidence, an independent attestation, aggregation → VERIFIED).
  const { proofOfValueId, platformEvidenceId, providerEvidenceId, attestationId } =
    await createVerifiedProofOfValueForSubject(harness, contribution.id);

  // -- Stage 4: the VERIFIED normalized measured outcome — a platform
  //    observation EXPLICITLY LINKED to the PoV's platform evidence
  //    (evidence lineage), immediate maturation, rollup, finalize.
  const { observationId, measuredOutcomeId } =
    await createVerifiedMeasuredOutcomeForSubject(
      harness,
      contribution.id,
      platformEvidenceId,
    );

  // -- Stage 2: the lifecycle walk through /workflows — the
  //    publication composite (DRAFT → … → SUBMITTED), then the PoH
  //    evaluation, then the six forward transitions to VERIFIED.
  await publishHelpfulContribution(harness.w014.w012, contribution.id);
  const poh = await runtime.helpfulnessService.evaluateHelpfulness(ctx, {
    contributionId: contribution.id,
    idempotencyKey: key("w033-poh-eval"),
  });
  if (poh.state !== "QUALIFIED") {
    throw new Error(
      `W033 canonical scenario failed: PoH state ${poh.state} (reasons: ${poh.evaluations[poh.evaluations.length - 1]?.reasons.join("; ")})`,
    );
  }
  const verifiedContribution = await walkToVerified(
    harness,
    contribution.id,
  );

  // -- Stage 5a: the reputation policy (the 8-dimension default rules)
  //    and the DIRECT evidence/outcome-derived reputation input
  //    (sources: the VERIFIED contribution + PoV + measured outcome —
  //    the basis is DERIVED server-side).
  const reputationPolicyId = `reputation-policy-w033-${randomUUID()}`;
  await runtime.reputationPolicyService.createPolicyVersion(ctx, {
    organizationScopeId: harness.organizationScopeId,
    policyId: reputationPolicyId,
    version: 1,
    description: "NET-W033 canonical scenario reputation policy",
    rules: DEFAULT_POLICY_RULES,
  });
  const directInput = await runtime.reputationInputService.recordInput(ctx, {
    organizationScopeId: harness.organizationScopeId,
    subjectPersonId: harness.contributorPersonId,
    dimension: "helpfulness",
    sources: [
      { kind: "contribution", id: contribution.id },
      { kind: "proof_of_value", id: proofOfValueId },
      { kind: "measured_outcome", id: measuredOutcomeId },
    ],
    description:
      "canonical contribution lifecycle: verified contribution + PoV + measured outcome",
    occurredAt: OCCURRED_AT,
    idempotencyKey: key("w033-reputation-direct"),
  });

  // -- Stage 6: settlement — the recognition composite (VERIFIED
  //    contribution → PENDING economic value) and the maturation
  //    composite (risk/dispute-gated PENDING → MATURE).
  const recognized = await recognizeContributionValue(
    harness.w014,
    contribution.id,
    { amount: opts.amount ?? 100 },
  );
  const matured = await matureValue(harness.w014, recognized.value.id);

  // -- Stage 5b: the settlement → reputation join (the sanctioned
  //    composition-root composite over the MATURE record).
  const settlementEffect = await runtime.apiCommands.applySettlementReputationEffect(
    harness.moderatorCtx("w033-reputation-effect"),
    harness.moderatorPersonId,
    {
      valueRecordId: matured.id,
      description:
        "canonical contribution lifecycle: material settlement outcome",
      idempotencyKey: key("w033-reputation-effect"),
    },
  );

  // -- Stage 7: the reputation snapshot at the FIXED reference anchor.
  const snapshotResult = await runtime.reputationSnapshotService.recordSnapshot(
    ctx,
    {
      organizationScopeId: harness.organizationScopeId,
      subjectPersonId: harness.contributorPersonId,
      policyId: reputationPolicyId,
      referenceAt: REFERENCE_AT,
      idempotencyKey: key("w033-reputation-snapshot"),
    },
  );

  if (opts.skipBenefitAllocation === true) {
    return {
      campaignId: campaign.id,
      opportunityId,
      contribution: verifiedContribution,
      proofOfHelpfulnessId: proofOfHelpfulness.id,
      basisEvidenceId,
      povPlatformEvidenceId: platformEvidenceId,
      povProviderEvidenceId: providerEvidenceId,
      attestationId,
      proofOfValueId,
      observationId,
      measuredOutcomeId,
      reputationPolicyId,
      directInputId: directInput.input.id,
      settlementEffectInputId: (settlementEffect.input as { id: string }).id,
      value: recognized.value,
      matureValue: matured,
      snapshot: snapshotResult.snapshot,
      rewardPolicyId: "",
      benefitPolicyId: "",
      poolId: "",
      allocationId: "",
      allocation: { id: "", totalAllocated: 0, draw: null },
    };
  }

  // -- Stage 8: benefits — the W028 value-funded pool composition: a
  //    /settlement reward policy mirroring the three members (3/2/1),
  //    the /benefits allocation policy (funding REFERENCES only), the
  //    pool funded by the MATURE value record, then the atomic
  //    allocation (the economic draw stays INSIDE /settlement).
  const rewardPolicyId = `reward-policy-w033-${randomUUID()}`;
  await runtime.rewardPolicyService.createPolicyVersion(
    harness.moderatorCtx("w033-reward-policy"),
    {
      organizationScopeId: harness.organizationScopeId,
      policyId: rewardPolicyId,
      version: 1,
      description: "NET-W033 canonical scenario reward policy (mirrors benefits)",
      allocations: [
        {
          beneficiaryPersonId: harness.contributorPersonId,
          weight: POOL_MEMBER_WEIGHTS.a,
        },
        {
          beneficiaryPersonId: harness.moderatorPersonId,
          weight: POOL_MEMBER_WEIGHTS.b,
        },
        { beneficiaryPersonId: harness.memberCPersonId, weight: POOL_MEMBER_WEIGHTS.c },
      ],
    },
  );
  const benefitPolicyId = `benefit-policy-w033-${randomUUID()}`;
  const benefitPolicyResult =
    await runtime.benefitPoolService.createPolicyVersion(
      harness.moderatorCtx("w033-benefit-policy"),
      {
        organizationScopeId: harness.organizationScopeId,
        policyId: benefitPolicyId,
        version: 1,
        benefitType: "credits",
        eligibilityCriteria: ["active_membership"],
        memberDeclarations: [
          {
            personId: harness.contributorPersonId,
            weight: POOL_MEMBER_WEIGHTS.a,
          },
          {
            personId: harness.moderatorPersonId,
            weight: POOL_MEMBER_WEIGHTS.b,
          },
          { personId: harness.memberCPersonId, weight: POOL_MEMBER_WEIGHTS.c },
        ],
        remainderDisposition: "last_member_absorbs",
        rewardPolicyId,
        idempotencyKey: key("w033-benefit-policy"),
      },
    );
  const poolResult = await runtime.benefitPoolService.createBenefitPool(
    harness.moderatorCtx("w033-benefit-pool"),
    {
      organizationScopeId: harness.organizationScopeId,
      policyId: benefitPolicyId,
      fundingRefs: [{ kind: "economic_value", id: matured.id }],
      idempotencyKey: key("w033-benefit-pool"),
    },
  );
  const allocationResult = await runtime.benefitPoolService.allocatePoolBenefits(
    harness.moderatorCtx("w033-benefit-allocate"),
    {
      organizationScopeId: harness.organizationScopeId,
      poolId: poolResult.pool.id,
      idempotencyKey: key("w033-benefit-allocation"),
    },
  );

  return {
    campaignId: campaign.id,
    opportunityId,
    contribution: verifiedContribution,
    proofOfHelpfulnessId: proofOfHelpfulness.id,
    basisEvidenceId,
    povPlatformEvidenceId: platformEvidenceId,
    povProviderEvidenceId: providerEvidenceId,
    attestationId,
    proofOfValueId,
    observationId,
    measuredOutcomeId,
    reputationPolicyId,
    directInputId: directInput.input.id,
    settlementEffectInputId: (settlementEffect.input as { id: string }).id,
    value: recognized.value,
    matureValue: matured,
    snapshot: snapshotResult.snapshot,
    rewardPolicyId,
    benefitPolicyId: (benefitPolicyResult.policy as BenefitAllocationPolicy).id,
    poolId: (poolResult.pool as BenefitPool).id,
    allocationId: allocationResult.allocation.id,
    allocation: {
      id: allocationResult.allocation.id,
      totalAllocated: allocationResult.allocation.totalAllocated,
      draw: allocationResult.allocation.draw,
    },
  };
}

// ---------------------------------------------------------------------------
// Scenario building blocks (the W033 composition specifics)
// ---------------------------------------------------------------------------

/**
 * A VERIFIED Proof-of-Value for the given subject — the W014 chain
 * (platform + provider evidence, an independent moderator attestation,
 * aggregation, verification) with every durable id returned.
 */
export async function createVerifiedProofOfValueForSubject(
  harness: NetW033Harness,
  subjectId: string,
): Promise<{
  readonly proofOfValueId: string;
  readonly platformEvidenceId: string;
  readonly providerEvidenceId: string;
  readonly attestationId: string;
}> {
  // The W014 factory attaches the PoV as a PoH basis and returns only
  // the proof id; W033 needs the intermediate ids for the lineage, so
  // it re-reads the committed proof record (the authoritative read).
  const w014Result = await attachProofOfValueBasis(harness.w014, subjectId);
  const proof = await harness.runtime.proofOfValueService.getProofOfValue(
    harness.contributorCtx("w033-pov-read"),
    w014Result.proofOfValueId,
  );
  const evidenceIds = proof.evidenceIds as readonly string[];
  // The W014 chain attaches platform evidence FIRST, then provider.
  const [platformEvidenceId, providerEvidenceId] = [evidenceIds[0]!, evidenceIds[1]!];
  const attestations = proof.attestationIds as readonly string[];
  return {
    proofOfValueId: proof.id,
    platformEvidenceId,
    providerEvidenceId,
    attestationId: attestations[0]!,
  };
}

/**
 * A VERIFIED normalized measured outcome for the given subject — a
 * platform observation EXPLICITLY LINKED to the cited /evidence record
 * (the evidence lineage AC-04 requires), immediate maturation, the
 * recorded rollup, finalization — attached as the PoH measured_outcome
 * basis exactly as the W014 factory does.
 */
export async function createVerifiedMeasuredOutcomeForSubject(
  harness: NetW033Harness,
  subjectId: string,
  evidenceId: string,
): Promise<{
  readonly observationId: string;
  readonly measuredOutcomeId: string;
}> {
  const runtime = harness.runtime;
  const ctx = harness.contributorCtx("w033-measured-outcome");
  const observation = await runtime.outcomeObservationService.createOutcomeObservation(
    ctx,
    {
      organizationScopeId: harness.organizationScopeId,
      observerId: harness.contributorPersonId,
      subjectReference: { subjectId, subjectType: "contribution" },
      outcomeType: "helpfulness",
      evidenceId,
      observedValue: { value: 1, unit: "helpful-resolutions" },
      confidence: { point: 0.95, lower: 0.9, upper: 0.98 },
      provenance: {
        sourceType: "platform",
        sourceId: "platform-counter-w033",
        method: "platform-counter",
        methodVersion: "1.0.0",
      },
    },
  );
  const measurement = await runtime.measuredOutcomeService.createMeasuredOutcome(
    ctx,
    {
      organizationScopeId: harness.organizationScopeId,
      ownerId: harness.contributorPersonId,
      subjectReference: { subjectId, subjectType: "contribution" },
      outcomeType: "helpfulness",
      maturation: { strategy: "immediate" },
      observationIds: [observation.id],
    },
  );
  await runtime.measuredOutcomeService.beginMaturation(ctx, {
    measurementId: measurement.id,
    expectedVersion: 0,
    idempotencyKey: key("w033-mo-begin"),
    actorPersonId: harness.contributorPersonId,
  });
  await runtime.measuredOutcomeService.recordMeasurementRollup(
    ctx,
    measurement.id,
  );
  const finalized = await runtime.measuredOutcomeService.finalize(ctx, {
    measurementId: measurement.id,
    expectedVersion: 1,
    idempotencyKey: key("w033-mo-finalize"),
    actorPersonId: harness.contributorPersonId,
  });
  if (finalized.measurement.state !== "VERIFIED") {
    throw new Error(
      `W033 canonical scenario failed: measured outcome state ${finalized.measurement.state}`,
    );
  }
  await runtime.helpfulnessService.attachBasis(ctx, {
    contributionId: subjectId,
    kind: "measured_outcome",
    referenceId: finalized.measurement.id,
    idempotencyKey: key("w033-mo-basis"),
  });
  return { observationId: observation.id, measuredOutcomeId: finalized.measurement.id };
}

/**
 * Walk a SUBMITTED contribution to the terminal VERIFIED state through
 * the /workflows authority (the six forward transitions — exactly the
 * W014 sequence, with fresh idempotency keys).
 */
export async function walkToVerified(
  harness: NetW033Harness,
  contributionId: string,
): Promise<Contribution> {
  const ctx = harness.contributorCtx("w033-verify-walk");
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
    contributionId,
  );
  let step = 0;
  while (current.state !== "VERIFIED") {
    const from = current.state;
    const to = path[path.indexOf(from as (typeof path)[number]) + 1]!;
    step += 1;
    await harness.runtime.workflowService.requestTransition(
      {
        subjectId: contributionId,
        subjectKind: "contribution",
        targetState: to,
        expectedVersion: current.version,
        idempotencyKey: key(`w033-t${String(step)}`),
        actorPersonId: harness.contributorPersonId,
        policyAction: policyActionFor(
          "contribution",
          from as "MEASURING",
          to as "VERIFIED",
        ),
        metadata: { contributionLifecycle: "net-w033" },
      },
      ctx,
    );
    current = await harness.runtime.contributionService.getContribution(
      ctx,
      contributionId,
    );
  }
  return current;
}

/** The W012 harness (re-exported for the AC fixtures). */
export type { NetW012Harness };
