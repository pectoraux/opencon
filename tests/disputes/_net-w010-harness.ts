/**
 * NET-W010 shared test harness.
 *
 * Wraps the NET-W009 harness (runtime + persons + organizations + the
 * risk guard actions + the upstream verified-record factories) and
 * adds:
 *  - the dispute guard actions (7 mutations);
 *  - a dedicated reviewer person (conflict-of-interest proofs need a
 *    third party: the harness person owns the challenged value, the
 *    second person challenges it, the reviewer reviews it);
 *  - credit issuance for challengers (staking requires credits — the
 *    full verified chain: PoV → pending value → mature → issuance);
 *  - challengeable-subject factories (a fresh economic value record
 *    with a known anchor timestamp);
 *  - the full open + bond flow helper used by most suites.
 *
 * The harness uses the file-backed PostgresAuthorityShim (test/dev
 * double from NET-W003) so it runs without a real PostgreSQL.
 */

import { createNetW009Harness, type NetW009Harness } from "./_net-w009-harness.ts";
import { createExecutionContext } from "../../src/core/execution-context.ts";
import type { ExecutionContext } from "../../src/core/execution-context.ts";
import type { DisputeRecord } from "../../src/disputes/port.ts";
import type { EconomicValueRecord } from "../../src/settlement/port.ts";
import { createMatureValue } from "../settlement/_net-w008-harness.ts";

export interface NetW010Harness {
  /** The wrapped NET-W009 harness (all its factories work unchanged). */
  readonly w009: NetW009Harness;
  readonly runtime: NetW009Harness["runtime"];
  readonly bootstrapCtx: ExecutionContext;
  /** The value beneficiary (the harness person — never the challenger). */
  readonly personId: string;
  /** The default challenger (a different person). */
  readonly challengerPersonId: string;
  /** A dedicated reviewer (neither challenger nor beneficiary). */
  readonly reviewerPersonId: string;
  readonly organizationScopeId: string;
  readonly secondOrgId: string;
  readonly secondOrgPersonId: string;
  teardown(): Promise<void>;
}

export async function createNetW010Harness(): Promise<NetW010Harness> {
  const w009 = await createNetW009Harness();
  const runtime = w009.runtime;
  const bootstrapCtx = w009.bootstrapCtx;

  // Seed ALLOW policies for the NET-W010 dispute guard actions.
  const guardActions = [
    "dispute.open",
    "dispute.bond",
    "dispute.review",
    "dispute.reject",
    "dispute.resolve",
    "dispute.appeal",
    "dispute.withdraw",
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

  // A dedicated reviewer person (tenant of the main org, but neither
  // the challenger nor the subject beneficiary).
  const reviewer = await runtime.identityService.createIdentity(bootstrapCtx, {
    displayName: "W010 Reviewer",
    subjectReferences: [
      { subjectId: "w010-reviewer@example.com", providerKind: "internal" },
    ],
  });

  return {
    w009,
    runtime,
    bootstrapCtx,
    personId: w009.personId,
    challengerPersonId: w009.secondPersonId,
    reviewerPersonId: reviewer.id,
    organizationScopeId: w009.organizationScopeId,
    secondOrgId: w009.secondOrgId,
    secondOrgPersonId: w009.secondOrgPersonId,
    async teardown() {
      await runtime.shutdown();
    },
  };
}

/** An execution context for a specific person. */
export function personCtx(
  harness: NetW010Harness,
  personId: string,
  correlationId: string,
): ExecutionContext {
  return createExecutionContext({
    correlationId,
    actor: { id: personId, kind: "person" },
  });
}

/** The challenger's context. */
export function challengerCtx(
  harness: NetW010Harness,
  correlationId: string,
): ExecutionContext {
  return personCtx(harness, harness.challengerPersonId, correlationId);
}

/** The dedicated reviewer's context. */
export function reviewerCtx(
  harness: NetW010Harness,
  correlationId: string,
): ExecutionContext {
  return personCtx(harness, harness.reviewerPersonId, correlationId);
}

/** The beneficiary's context (the challenged person). */
export function beneficiaryCtx(
  harness: NetW010Harness,
  correlationId: string,
): ExecutionContext {
  return personCtx(harness, harness.personId, correlationId);
}

// ---------------------------------------------------------------------------
// Subject + stake factories
// ---------------------------------------------------------------------------

/**
 * A fresh challengeable subject: a MATURE economic value record owned
 * by the harness person (the beneficiary), with a deterministic
 * anchor (its recordedAt) for window arithmetic.
 */
export async function createChallengeableValue(
  harness: NetW010Harness,
  opts: { readonly amount?: number } = {},
): Promise<EconomicValueRecord> {
  return createMatureValue(harness.w009.w008, {
    amount: opts.amount ?? 100,
    beneficiaryPersonId: harness.personId,
  });
}

/**
 * Ensure a person holds ≥ `amount` Participation Credits (issuing
 * fresh verified value for them through the REAL chain, then issuing
 * credits at rate 1).
 */
export async function ensureCreditsFor(
  harness: NetW010Harness,
  personId: string,
  amount: number,
): Promise<void> {
  const valueAmount = Math.max(amount, 100);
  const mature = await createMatureValue(harness.w009.w008, {
    amount: valueAmount,
    beneficiaryPersonId: personId,
  });
  const ctx = personCtx(harness, personId, "w010-ensure-credits");
  await harness.runtime.creditService.issueCredits(ctx, {
    organizationScopeId: harness.organizationScopeId,
    beneficiaryPersonId: personId,
    sourceValueRecordId: mature.id,
    creditsPerValueUnit: 1,
    idempotencyKey: `w010-credits-${mature.id}`,
  });
}

export interface OpenDisputeOptions {
  readonly subjectType?: string;
  readonly subjectId?: string;
  readonly effectiveAt?: string;
  readonly statement?: string;
  readonly reasonCodes?: readonly string[];
  readonly supportingRefs?: readonly { kind: string; id: string }[];
  readonly challengerPersonId?: string;
  readonly idempotencyKey?: string;
  readonly organizationScopeId?: string;
}

/**
 * Open a dispute as the default challenger over a subject (default: a
 * fresh MATURE economic value record). Returns the PENDING_STAKE
 * dispute plus the subject record it challenged.
 */
export async function openDefaultDispute(
  harness: NetW010Harness,
  opts: OpenDisputeOptions = {},
): Promise<{ dispute: DisputeRecord; subject: EconomicValueRecord }> {
  const subject =
    opts.subjectType === undefined && opts.subjectId === undefined
      ? await createChallengeableValue(harness)
      : (null as unknown as EconomicValueRecord);
  const subjectType = opts.subjectType ?? "economic_value";
  const subjectId = opts.subjectId ?? subject.id;
  const effectiveAt =
    opts.effectiveAt ??
    (subject ? new Date(Date.parse(subject.recordedAt) + 3600_000).toISOString() : new Date().toISOString());
  const ctx = personCtx(
    harness,
    opts.challengerPersonId ?? harness.challengerPersonId,
    "w010-open",
  );
  const result = await harness.runtime.disputeService.openDispute(ctx, {
    organizationScopeId: opts.organizationScopeId ?? harness.organizationScopeId,
    subjectRef: { subjectType, subjectId },
    statement: opts.statement ?? "the challenged record misstates verified value",
    reasonCodes: opts.reasonCodes ?? ["contested_verification"],
    supportingRefs:
      opts.supportingRefs ??
      (subject
        ? [{ kind: "economic_value", id: subject.id }]
        : [{ kind: "economic_value", id: subjectId }]),
    effectiveAt,
    idempotencyKey:
      opts.idempotencyKey ??
      `w010-open-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
  });
  return { dispute: result.dispute, subject };
}

/**
 * Bond the default stake through the settlement authority (the exact
 * composition-root sequence: commit the stake, then bond it). The
 * challenger must hold enough credits (the harness pre-issues them).
 */
export async function bondDefaultStake(
  harness: NetW010Harness,
  dispute: DisputeRecord,
  opts: { readonly idempotencyKey?: string } = {},
): Promise<DisputeRecord> {
  const key =
    opts.idempotencyKey ??
    `w010-bond-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const ctx = challengerCtx(harness, "w010-bond");
  const staked = await harness.runtime.stakeService.commitStake(ctx, {
    organizationScopeId: dispute.organizationScopeId,
    ownerPersonId: dispute.challengerPersonId,
    amount: dispute.stake.requirement.amount,
    purpose: { kind: "dispute_challenge", id: dispute.id },
    description: `challenge stake for dispute ${dispute.id}`,
    idempotencyKey: `${key}:stake`,
  });
  return harness.runtime.disputeService.bondStake(ctx, {
    disputeId: dispute.id,
    stakeId: staked.stake.id,
    idempotencyKey: `${key}:bond`,
  });
}

/**
 * The full flow: open + bond (+ optionally start the review). Returns
 * the dispute in at least the OPEN state.
 */
export async function openBondedDispute(
  harness: NetW010Harness,
  opts: OpenDisputeOptions & { readonly withReview?: boolean } = {},
): Promise<{ dispute: DisputeRecord; subject: EconomicValueRecord }> {
  await ensureCreditsFor(harness, opts.challengerPersonId ?? harness.challengerPersonId, 50);
  const opened = await openDefaultDispute(harness, opts);
  const bonded = await bondDefaultStake(harness, opened.dispute);
  const dispute = opts.withReview
    ? await harness.runtime.disputeService.startReview(
        reviewerCtx(harness, "w010-review"),
        {
          disputeId: bonded.id,
          idempotencyKey: `w010-review-${bonded.id}`,
        },
      )
    : bonded;
  return { dispute, subject: opened.subject };
}

/** Deterministic resolution reference timestamps. */
export const RESOLVED_AT = "2024-07-01T00:00:00.000Z";
