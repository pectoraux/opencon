/**
 * NET-W028 shared test harness — Benefit Pools.
 *
 * Wraps the NET-W027 harness (which wraps the W026 → W025 → W024 →
 * W008 chain: runtime + persons + organizations + the demand/
 * procurement pools + the REAL /evidence, /outcomes and savings
 * machinery; the file-backed PostgresAuthorityShim so no real
 * PostgreSQL is needed). This harness seeds the NET-W028 guard
 * actions and exposes the benefit-pool scenario factories:
 *  - a VALUE-FUNDED pool: one MATURE /settlement EconomicValueRecord
 *    (the W008 factory) + a mirrored /settlement reward policy +
 *    the benefits policy + the pool (economic draws execute the
 *    settlement primitive);
 *  - a SAVINGS-FUNDED pool: one W027 recorded verified savings claim
 *    (entitlement-only allocations — nothing posts).
 */

import { randomUUID } from "node:crypto";
import {
  createNetW027Harness,
  key as w027Key,
  recordSavings,
  seedSavingsScenario,
  type NetW027Harness,
} from "../demand/_net-w027-harness.ts";
import { createExecutionContext } from "../../src/core/execution-context.ts";
import type { ExecutionContext } from "../../src/core/execution-context.ts";
import type { NetW008HarnessOptions } from "../settlement/_net-w008-harness.ts";
import type { Runtime } from "../../src/bootstrap/runtime.ts";
import { createMatureValue } from "../settlement/_net-w008-harness.ts";
import type { EconomicValueRecord } from "../../src/settlement/port.ts";
import type { ProcurementSavings } from "../../src/demand/port.ts";
import type {
  BenefitAllocationPolicy,
  BenefitPool,
} from "../../src/benefits/port.ts";

export interface NetW028Harness {
  readonly w027: NetW027Harness;
  readonly runtime: Runtime;
  readonly bootstrapCtx: ExecutionContext;
  readonly organizationScopeId: string;
  /** The pool creator (buyer A — the W027 savings surface owner). */
  readonly poolCreatorPersonId: string;
  readonly memberBPersonId: string;
  readonly memberCPersonId: string;
  /** The W008 harness person (value-record beneficiary default). */
  readonly valueBeneficiaryPersonId: string;
  poolCreatorCtx(correlationId: string): ExecutionContext;
  memberBCtx(correlationId: string): ExecutionContext;
  memberCCtx(correlationId: string): ExecutionContext;
  teardown(): Promise<void>;
}

/**
 * The NET-W028 API guard actions seeded by this harness (subject "*",
 * resource "*" — the guard is the transport authorization; the
 * domain-layer creator/membership gates are the tests' subject).
 */
const GUARD_ACTIONS = [
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

export async function createNetW028Harness(
  opts: NetW008HarnessOptions = {},
): Promise<NetW028Harness> {
  const w027 = await createNetW027Harness(opts);
  const runtime = w027.runtime;
  const bootstrapCtx = w027.bootstrapCtx;

  for (const action of GUARD_ACTIONS) {
    await runtime.policyService.createPolicy(bootstrapCtx, {
      subject: "*",
      action,
      resource: "*",
      effect: "allow",
      createdBy: "bootstrap",
    });
  }

  const w008 = w027.w026.w025.w024.w008;
  return {
    w027,
    runtime,
    bootstrapCtx,
    organizationScopeId: w027.organizationScopeId,
    poolCreatorPersonId: w027.w026.w025.buyerAPersonId,
    memberBPersonId: w027.w026.w025.buyerBPersonId,
    memberCPersonId: w027.w026.w025.buyerCPersonId,
    valueBeneficiaryPersonId: w008.personId,
    poolCreatorCtx(correlationId: string) {
      return createExecutionContext({
        correlationId,
        actor: { id: w027.w026.w025.buyerAPersonId, kind: "person" },
      });
    },
    memberBCtx(correlationId: string) {
      return createExecutionContext({
        correlationId,
        actor: { id: w027.w026.w025.buyerBPersonId, kind: "person" },
      });
    },
    memberCCtx(correlationId: string) {
      return createExecutionContext({
        correlationId,
        actor: { id: w027.w026.w025.buyerCPersonId, kind: "person" },
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

/** The W027 harness key helper (re-exported for convenience). */
export const w027IdemKey = w027Key;

// ---------------------------------------------------------------------------
// Record factories
// ---------------------------------------------------------------------------

/**
 * Create the benefits allocation policy (versioned lineage). When
 * `rewardPolicyId` is set the policy is expected to mirror the
 * referenced /settlement reward policy's member declarations exactly
 * (economic draws verify this mirror server-side, fail closed).
 */
export async function createBenefitPolicy(
  harness: NetW028Harness,
  opts: {
    readonly policyId: string;
    readonly benefitType?: string;
    readonly remainderDisposition?: string;
    readonly rewardPolicyId?: string | null;
    readonly members?: readonly {
      readonly personId: string;
      readonly weight: number;
    }[];
    readonly version?: number;
    readonly ctx?: ExecutionContext;
    readonly idempotencyKey?: string;
  },
): Promise<BenefitAllocationPolicy> {
  const ctx = opts.ctx ?? harness.poolCreatorCtx("w028-policy");
  const result = await harness.runtime.benefitPoolService.createPolicyVersion(
    ctx,
    {
      organizationScopeId: harness.organizationScopeId,
      policyId: opts.policyId,
      version: opts.version ?? 1,
      benefitType: opts.benefitType ?? "credits",
      eligibilityCriteria: ["active_membership"],
      memberDeclarations:
        opts.members ?? [
          { personId: harness.poolCreatorPersonId, weight: 3 },
          { personId: harness.memberBPersonId, weight: 2 },
          { personId: harness.memberCPersonId, weight: 1 },
        ],
      remainderDisposition: opts.remainderDisposition ?? "last_member_absorbs",
      ...(opts.rewardPolicyId !== undefined
        ? { rewardPolicyId: opts.rewardPolicyId }
        : {}),
      idempotencyKey: opts.idempotencyKey ?? key("w028-policy"),
    },
  );
  return result.policy;
}

/** Create the Benefit Pool (funding references only — never amounts). */
export async function createBenefitPool(
  harness: NetW028Harness,
  opts: {
    readonly policyId: string;
    readonly fundingRefs: readonly {
      readonly kind: string;
      readonly id: string;
    }[];
    readonly policyVersion?: number;
    readonly ctx?: ExecutionContext;
    readonly idempotencyKey?: string;
  },
): Promise<BenefitPool> {
  const ctx = opts.ctx ?? harness.poolCreatorCtx("w028-pool");
  const result = await harness.runtime.benefitPoolService.createBenefitPool(
    ctx,
    {
      organizationScopeId: harness.organizationScopeId,
      policyId: opts.policyId,
      ...(opts.policyVersion !== undefined
        ? { policyVersion: opts.policyVersion }
        : {}),
      fundingRefs: [...opts.fundingRefs],
      idempotencyKey: opts.idempotencyKey ?? key("w028-pool"),
    },
  );
  return result.pool;
}

/**
 * The full VALUE-FUNDED scenario (defaults): one MATURE
 * EconomicValueRecord (100 value, the W008 PoV-backed factory — the
 * W014-compatible authoritative value), one /settlement reward policy
 * mirroring the three buyers at weights 3/2/1, the benefits policy
 * (credits, last_member_absorbs, rewardPolicyId set) and the pool
 * funded by the value record. Allocations execute the settlement
 * reward-allocation draw.
 */
export async function seedValueFundedPool(
  harness: NetW028Harness,
  opts: {
    readonly amount?: number;
    readonly policyId?: string;
    readonly rewardPolicyId?: string;
    readonly benefitType?: string;
    readonly remainderDisposition?: string;
  } = {},
): Promise<{
  readonly value: EconomicValueRecord;
  readonly rewardPolicyId: string;
  readonly policy: BenefitAllocationPolicy;
  readonly pool: BenefitPool;
}> {
  const w008 = harness.w027.w026.w025.w024.w008;
  const value = await createMatureValue(w008, {
    amount: opts.amount ?? 100,
  });
  const rewardPolicyId =
    opts.rewardPolicyId ?? `reward-policy-w028-${randomUUID()}`;
  const rewardCtx = harness.poolCreatorCtx("w028-reward-policy");
  await harness.runtime.rewardPolicyService.createPolicyVersion(rewardCtx, {
    organizationScopeId: harness.organizationScopeId,
    policyId: rewardPolicyId,
    version: 1,
    description: "NET-W028 test reward policy (mirrors the benefits policy)",
    allocations: [
      { beneficiaryPersonId: harness.poolCreatorPersonId, weight: 3 },
      { beneficiaryPersonId: harness.memberBPersonId, weight: 2 },
      { beneficiaryPersonId: harness.memberCPersonId, weight: 1 },
    ],
  });
  const policyId = opts.policyId ?? `benefit-policy-w028-${randomUUID()}`;
  const policy = await createBenefitPolicy(harness, {
    policyId,
    rewardPolicyId,
    benefitType: opts.benefitType ?? "credits",
    remainderDisposition: opts.remainderDisposition ?? "last_member_absorbs",
  });
  const pool = await createBenefitPool(harness, {
    policyId,
    fundingRefs: [{ kind: "economic_value", id: value.id }],
  });
  return { value, rewardPolicyId, policy, pool };
}

/**
 * The full SAVINGS-FUNDED scenario (defaults): one recorded W027
 * verified savings claim (1000 usd baseline − 800 usd observed =
 * 200 usd supported savings), the benefits policy (rebate,
 * retained_in_pool by default, NO reward policy — entitlement-only)
 * and the pool funded by the savings record. Allocations post
 * NOTHING (no drawable economic value exists for the savings).
 */
export async function seedSavingsFundedPool(
  harness: NetW028Harness,
  opts: {
    readonly policyId?: string;
    readonly benefitType?: string;
    readonly remainderDisposition?: string;
    readonly observationValue?: number;
    readonly baselineValue?: number;
  } = {},
): Promise<{
  readonly savings: ProcurementSavings;
  readonly policy: BenefitAllocationPolicy;
  readonly pool: BenefitPool;
}> {
  const scenario = await seedSavingsScenario(harness.w027, {
    name: "W028 Savings-Funded Pool",
    ...(opts.observationValue !== undefined
      ? { observationValue: opts.observationValue }
      : {}),
  });
  const savings = await recordSavings(harness.w027, {
    poolId: scenario.poolId,
    baselineId: scenario.baseline.id,
    outcomeObservationIds: [scenario.observation.id],
    ...(opts.baselineValue !== undefined
      ? {}
      : {}),
  });
  const policyId = opts.policyId ?? `benefit-policy-w028-${randomUUID()}`;
  const policy = await createBenefitPolicy(harness, {
    policyId,
    benefitType: opts.benefitType ?? "rebate",
    remainderDisposition: opts.remainderDisposition ?? "retained_in_pool",
    rewardPolicyId: null,
  });
  const pool = await createBenefitPool(harness, {
    policyId,
    fundingRefs: [{ kind: "verified_savings", id: savings.id }],
  });
  return { savings, policy, pool };
}

/** Evaluate the derived allocation view (pool creator by default). */
export async function evaluateAllocation(
  harness: NetW028Harness,
  opts: {
    readonly poolId: string;
    readonly ctx?: ExecutionContext;
  },
) {
  const ctx = opts.ctx ?? harness.poolCreatorCtx("w028-evaluate");
  return harness.runtime.benefitPoolService.evaluatePoolAllocation(ctx, {
    organizationScopeId: harness.organizationScopeId,
    poolId: opts.poolId,
  });
}

/** Execute the atomic allocation (pool creator by default). */
export async function allocateBenefits(
  harness: NetW028Harness,
  opts: {
    readonly poolId: string;
    readonly ctx?: ExecutionContext;
    readonly valueRecordId?: string;
    readonly amount?: number;
    readonly idempotencyKey?: string;
  },
) {
  const ctx = opts.ctx ?? harness.poolCreatorCtx("w028-allocate");
  return harness.runtime.benefitPoolService.allocatePoolBenefits(ctx, {
    organizationScopeId: harness.organizationScopeId,
    poolId: opts.poolId,
    ...(opts.valueRecordId !== undefined
      ? { valueRecordId: opts.valueRecordId }
      : {}),
    ...(opts.amount !== undefined ? { amount: opts.amount } : {}),
    idempotencyKey: opts.idempotencyKey ?? key("w028-allocation"),
  });
}

/** The member view read (any active member). */
export async function memberView(
  harness: NetW028Harness,
  opts: {
    readonly poolId: string;
    readonly ctx?: ExecutionContext;
  },
) {
  const ctx = opts.ctx ?? harness.memberBCtx("w028-member-view");
  return harness.runtime.benefitPoolService.getMemberBenefitView(ctx, {
    organizationScopeId: harness.organizationScopeId,
    poolId: opts.poolId,
  });
}
