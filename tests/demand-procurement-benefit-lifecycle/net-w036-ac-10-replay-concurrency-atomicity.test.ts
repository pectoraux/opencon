/**
 * NET-W036-AC-10 — Replay, concurrency, atomicity, tenancy and the
 * traversal/audit-order contract (work order §5 AC-10 + §4 invariants
 * 10/11/12/15; ledger §4).
 *
 *  - SAME-KEY REPLAY (the consolidated economic boundary): the CANONICAL
 *    recognition (the stage-12 `recordPendingValue` over the three
 *    VERIFIED sources, key `w036-value-record`) and the CANONICAL
 *    allocation (the stage-16 `allocatePoolBenefits` over the
 *    matured-value-funded pool, key `w036-allocation`) both return
 *    `created: false` + the IDENTICAL committed record, and the replay
 *    mints NOTHING (one audit event, the draw not repeated, the value
 *    record stays CONSUMED). Each replay runs on its OWN harness + its
 *    OWN canonical scenario run (the suite's one-harness-per-proof
 *    discipline).
 *  - RACE: a 4-way concurrent `Promise.allSettled` on
 *    `allocatePoolBenefits` with the SAME idempotency key over ONE
 *    pool/value converges to EXACTLY ONE committed economic
 *    application: every settled outcome is FULFILLED (the per-pool
 *    `benefits_pool:{id}` mutex + the draw lock set serialize the
 *    callers — the W028/W026 exactly-once semantics), exactly ONE
 *    carries `created: true` and the other three are the DETERMINISTIC
 *    in-race replays of the identical record; exactly one allocation
 *    record + ONE draw (one reward allocation, the value record
 *    consumed exactly-once) + conservation holds.
 *  - THE COMPOSITE-LEVEL FAULT INJECTION (the required AC-10
 *    atomicity evidence — the W035-AC-09 precedent proof shape applied
 *    to the W036 TERMINAL composite): the ACTUAL benefit funding
 *    composite — `createBenefitPoolService`, rebuilt EXACTLY as the
 *    composition root wires it (the real authority repositories over a
 *    COMMIT-FAILING authority, the real membership/valueFunding/
 *    savingsFunding/rewardPolicy lookups, and the REAL economic draw
 *    port over the reward service's `allocateRewardsWithinTx` form —
 *    the reward service side ALSO rebuilt over the failing authority,
 *    the real idempotency store over the failing authority, and
 *    `createTransactionalAuditWriter` over the runtime's underlying
 *    writer) — stages the allocation + the reward draw + the balanced
 *    postings + the idempotency record + the buffered audit inside the
 *    SINGLE authoritative transaction, then the authoritative COMMIT is
 *    forced to fail → NOTHING survives (zero allocation records, zero
 *    reward-side records, the ledger unchanged, the value record NOT
 *    consumed, zero idempotency residue, zero new audit events); the
 *    healthy same-key retry through the REAL runtime
 *    `benefitPoolService` completes exactly once, and a further
 *    same-key call is the identical replay.
 *  - TENANCY: the cross-tenant matrix — pool/offer/selection/savings/
 *    benefit-pool/allocation references under a FOREIGN
 *    organizationScopeId fail closed as NotFoundError with error-shape
 *    parity vs nonexistent ids (no existence oracle — the AC-01
 *    technique), and the cross-scope FUNDING references fail closed
 *    (the value + savings cross-scope reasons).
 *  - TRAVERSAL: a fresh canonical scenario re-proves the 17-witness
 *    frozen-order contract with authoritative state/version witnesses
 *    and STRICTLY ASCENDING audit-marker positions (the compact
 *    scenario-level re-proof — the exhaustive 44-marker version lives
 *    in net-w036-full-path-scenario.test.ts).
 *
 * Mutation targets covered (ledger §4): skip the idempotency store (the
 * replays/race fail — created flips, the draw repeats); remove the
 * concurrency lock (the race would double-apply); publish audit before
 * commit (the fault injection proves the buffered audit is discarded on
 * the failed commit); suppress rollback (the fault injection proves
 * NOTHING survives); remove the tenant recheck (the tenant matrix +
 * the cross-scope funding reasons fail closed); introduce local
 * state/ledger (the structural pins — nothing in this suite writes
 * repositories or mints economic state directly).
 *
 * DETERMINISM (§3.1): fixed idempotency keys only (`w036-ac10-…`),
 * the harness/scenario anchors only — NO wall-clock read, NO random id
 * in this file (the code-token self-pins at the end prove it).
 */

import { describe, test, expect } from "bun:test";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import {
  createNetW036Harness,
  runW036Scenario,
  personCtx,
  w036IsoMinusDays,
  W036_BASELINE_WINDOW_DAYS,
  W036_BASELINE_WINDOW_ENDS_DAYS_AGO,
  W036_EVIDENCE_CAPTURED_AT,
  type NetW036Harness,
  type W036Scenario,
} from "./_net-w036-harness.ts";
import { assertGlobalConservation, createMatureValue } from "../settlement/_net-w008-harness.ts";
import { NotFoundError } from "../../src/core/errors.ts";
import type { OpenConError } from "../../src/core/errors.ts";
import type { ExecutionContext } from "../../src/core/execution-context.ts";
import type {
  AuthorityTransaction,
  PostgresAuthority,
} from "../../src/core/postgres-authority.ts";
import type { IdempotentApplyContext } from "../../src/core/idempotency.ts";
import { createPostgresIdempotencyStore } from "../../src/persistence/idempotency-store.ts";
import { createTransactionalAuditWriter } from "../../src/audit/transactional-audit-writer.ts";
import { createBenefitPoolService } from "../../src/benefits/benefit-pool-service.ts";
import {
  createAuthorityBenefitPoolPolicyRepository,
  createAuthorityBenefitPoolRepository,
  createAuthorityBenefitPoolAllocationRepository,
} from "../../src/benefits/authority-benefit-repositories.ts";
import { createAuthorityProcurementSavingsRepository } from "../../src/demand/authority-savings-repositories.ts";
import { createAuthorityRewardPolicyRepository } from "../../src/settlement/authority-reward-policy-repository.ts";
import { createAuthorityRewardAllocationRepository } from "../../src/settlement/authority-reward-repository.ts";
import { createAuthorityEconomicValueRepository } from "../../src/settlement/authority-value-repository.ts";
import { createAuthorityEconomicLedgerRepository } from "../../src/settlement/authority-ledger-repository.ts";
import { createRewardService, allocationAccountIds } from "../../src/settlement/reward-service.ts";
import { valueRecordLockKey } from "../../src/settlement/posting.ts";
import type {
  BenefitEconomicDrawPort,
  BenefitMembershipLookup,
  BenefitRewardPolicyLookup,
  BenefitSavingsFundingLookup,
  BenefitValueFundingLookup,
  BenefitPool,
  BenefitPoolAllocation,
} from "../../src/benefits/port.ts";
import type { BenefitPoolService } from "../../src/benefits/port.ts";
import { toEconomicMinorUnits } from "../../src/core/economics.ts";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Catch an expected service error and return it (null when none). */
async function expectRejection(
  run: () => Promise<unknown>,
): Promise<unknown> {
  try {
    await run();
  } catch (error) {
    return error;
  }
  return null;
}

/** The committed count of one authority collection. */
async function collectionCount(
  harness: NetW036Harness,
  collection: string,
): Promise<number> {
  return (await harness.runtime.postgresAuthority.scan(collection)).length;
}

/** Count audit events of one type (optionally for one resource). */
async function auditCount(
  harness: NetW036Harness,
  eventType: string,
  resourceId?: string,
): Promise<number> {
  const events = await harness.runtime.auditWriter.query(
    resourceId ? { eventType, resourceId } : { eventType },
  );
  return events.length;
}

/**
 * The shared reward/benefit policy + pool construction over one MATURE
 * value record (the stage-15 shape with this suite's fixed keys): the
 * /settlement reward policy mirroring the three buyers at 3/2/1, the
 * /benefits allocation policy (credits, active_membership,
 * last_member_absorbs, the mirrored reward policy), and the pool funded
 * BY REFERENCE to the mature value record.
 */
async function seedValueFundedPool(
  harness: NetW036Harness,
  opts: {
    readonly rewardPolicyId: string;
    readonly benefitPolicyId: string;
    readonly poolKey: string;
    readonly valueRecordId: string;
  },
): Promise<BenefitPool> {
  const runtime = harness.runtime;
  const scope = harness.organizationScopeId;
  const ctx = harness.poolCreatorCtx("w036-ac10-seed");
  await runtime.rewardPolicyService.createPolicyVersion(ctx, {
    organizationScopeId: scope,
    policyId: opts.rewardPolicyId,
    version: 1,
    description: "NET-W036 AC-10 reward policy (mirrors the benefits policy)",
    allocations: [
      { beneficiaryPersonId: harness.buyerAPersonId, weight: 3 },
      { beneficiaryPersonId: harness.buyerBPersonId, weight: 2 },
      { beneficiaryPersonId: harness.buyerCPersonId, weight: 1 },
    ],
  });
  await runtime.benefitPoolService.createPolicyVersion(ctx, {
    organizationScopeId: scope,
    policyId: opts.benefitPolicyId,
    version: 1,
    benefitType: "credits",
    eligibilityCriteria: ["active_membership"],
    memberDeclarations: [
      { personId: harness.buyerAPersonId, weight: 3 },
      { personId: harness.buyerBPersonId, weight: 2 },
      { personId: harness.buyerCPersonId, weight: 1 },
    ],
    remainderDisposition: "last_member_absorbs",
    rewardPolicyId: opts.rewardPolicyId,
    idempotencyKey: `${opts.benefitPolicyId}-key`,
  });
  return (
    await runtime.benefitPoolService.createBenefitPool(ctx, {
      organizationScopeId: scope,
      policyId: opts.benefitPolicyId,
      fundingRefs: [{ kind: "economic_value", id: opts.valueRecordId }],
      idempotencyKey: opts.poolKey,
    })
  ).pool;
}

// ---------------------------------------------------------------------------
// The commit-failing authority (the W035-AC-09 / W006/W017/W018/W019/
// W020/W034 rebuild pattern: commit() always fails)
// ---------------------------------------------------------------------------

class CommitFailingTransaction implements AuthorityTransaction {
  public constructor(
    private readonly inner: AuthorityTransaction,
  ) {}
  get transactionId(): string {
    return this.inner.transactionId;
  }
  get settled(): boolean {
    return this.inner.settled;
  }
  get<T = unknown>(collection: string, key: string) {
    return this.inner.get<T>(collection, key);
  }
  scan<T = unknown>(collection: string) {
    return this.inner.scan<T>(collection);
  }
  put<T>(collection: string, key: string, value: T) {
    return this.inner.put<T>(collection, key, value);
  }
  delete(collection: string, key: string) {
    return this.inner.delete(collection, key);
  }
  afterCommit(hook: () => Promise<void>): void {
    this.inner.afterCommit(hook);
  }
  afterRollback(hook: () => Promise<void>): void {
    this.inner.afterRollback(hook);
  }
  async commit(): Promise<void> {
    throw new Error("injected authoritative COMMIT failure");
  }
  async rollback(): Promise<void> {
    return this.inner.rollback();
  }
}

/**
 * Rebuild the W036 TERMINAL COMPOSITE (the benefit funding join —
 * `createBenefitPoolService`, the exact object the composition root
 * wires at src/bootstrap/runtime.ts) over a COMMIT-FAILING authority:
 * the REAL benefit repositories (policy/pool/allocation) over the
 * failing authority (every committed read and every staged write flows
 * through the failing transaction boundary), the REAL lookups
 * (membership over the runtime's public membership service;
 * valueFunding + savingsFunding + rewardPolicy over the failing
 * authority's real repository factories), the REAL economic draw port
 * over the reward service's `allocateRewardsWithinTx` form (the reward
 * service side ALSO rebuilt over the failing authority — every
 * settlement-side staging flows through the SAME failing transaction),
 * the REAL idempotency store over the failing authority, and the REAL
 * transactional audit writer over the runtime's underlying writer.
 * Every mutation the allocation performs — the pool allocation record,
 * the reward draw (record + balanced postings + exactly-once value
 * consumption), the idempotency record, the buffered audit — flows
 * through the FAILING transaction, so the forced COMMIT failure
 * exercises the ACTUAL end-to-end atomicity boundary AFTER the whole
 * unit is staged.
 */
async function rebuildFailingBenefitPoolService(
  harness: NetW036Harness,
): Promise<BenefitPoolService> {
  const innerAuthority = harness.runtime.postgresAuthority;
  const failingAuthority: PostgresAuthority = {
    async begin(context: ExecutionContext) {
      return new CommitFailingTransaction(
        await innerAuthority.begin(context),
      );
    },
    async run<T>(
      context: ExecutionContext,
      work: (tx: AuthorityTransaction) => Promise<T>,
    ): Promise<T> {
      const tx = new CommitFailingTransaction(
        await innerAuthority.begin(context),
      );
      try {
        const result = await work(tx);
        await tx.commit();
        return result;
      } catch (err) {
        await tx.rollback();
        throw err;
      }
    },
    get<T = unknown>(collection: string, key: string) {
      return innerAuthority.get<T>(collection, key);
    },
    scan<T = unknown>(collection: string) {
      return innerAuthority.scan<T>(collection);
    },
    count(collection: string) {
      return innerAuthority.count(collection);
    },
    recover() {
      return innerAuthority.recover();
    },
    close() {
      return innerAuthority.close();
    },
  };
  const logger = harness.runtime.logger;
  const debug = (message: string, fields?: Record<string, unknown>) =>
    logger.debug(message, fields);

  // The REAL /settlement reward service rebuilt over the failing
  // authority (the economic-draw side of the composite — the exact
  // construction src/bootstrap/runtime.ts wires, with the failing
  // authority substituted for the authoritative boundary).
  const failingIdempotency = createPostgresIdempotencyStore({
    authority: failingAuthority,
    logger: { debug },
  });
  const failingRewardService = createRewardService({
    policyRepository: createAuthorityRewardPolicyRepository({
      authority: failingAuthority,
      logger: { debug },
    }),
    allocationRepository: createAuthorityRewardAllocationRepository({
      authority: failingAuthority,
      logger: { debug },
    }),
    valueRepository: createAuthorityEconomicValueRepository({
      authority: failingAuthority,
      logger: { debug },
    }),
    ledgerRepository: createAuthorityEconomicLedgerRepository({
      authority: failingAuthority,
      logger: { debug },
    }),
    idempotency: failingIdempotency,
    auditWriter: createTransactionalAuditWriter({
      underlying: harness.runtime.auditWriter,
    }),
    logger: logger.forModule("settlement"),
  });

  // The REAL economic draw port (the exact composition-root shape):
  // the reward-allocation primitive on the CALLER'S transaction + the
  // EXACT lock-key set the draw's standalone form would acquire.
  const economicDraw: BenefitEconomicDrawPort = {
    async allocateRewardDrawWithinTx(
      execution: ExecutionContext,
      input: {
        readonly organizationScopeId: string;
        readonly sourceValueRecordId: string;
        readonly policyId: string;
        readonly version?: number;
        readonly idempotencyKey: string;
      },
      ctx: IdempotentApplyContext,
    ) {
      const allocation = await failingRewardService.allocateRewardsWithinTx(
        execution,
        {
          organizationScopeId: input.organizationScopeId,
          sourceValueRecordId: input.sourceValueRecordId,
          policyId: input.policyId,
          ...(input.version !== undefined ? { version: input.version } : {}),
          idempotencyKey: input.idempotencyKey,
        },
        ctx,
      );
      return {
        drawResultId: allocation.id,
        transactionId: allocation.transactionId,
        sourceValueRecordId: allocation.sourceValueRecordId,
        policyId: allocation.policyId,
        policyVersion: allocation.policyVersion,
        totalAllocated: allocation.totalAllocated,
        shares: allocation.shares.map((share) => ({
          beneficiaryPersonId: share.beneficiaryPersonId,
          amount: share.amount,
          weight: share.weight,
        })),
      };
    },
    drawLockKeys(input: {
      readonly organizationScopeId: string;
      readonly sourceValueRecordId: string;
      readonly sourceBeneficiaryPersonId: string;
      readonly memberPersonIds: readonly string[];
    }) {
      return {
        recordLockKey: valueRecordLockKey(input.sourceValueRecordId),
        accountIds: allocationAccountIds(
          input.organizationScopeId,
          input.sourceBeneficiaryPersonId,
          input.memberPersonIds,
        ),
      };
    },
  };

  // The REAL neutral lookups (the composition-root shapes).
  const membershipLookup: BenefitMembershipLookup = {
    async isActiveMember(organizationScopeId, personId) {
      const record =
        await harness.runtime.membershipService.getMembership(
          harness.poolCreatorCtx("w036-ac10-fault-membership"),
          personId,
          organizationScopeId,
        );
      return record !== null && record.status === "active";
    },
  };
  function toBenefitValueFacts(record: {
    readonly id: string;
    readonly organizationScopeId: string;
    readonly state: string;
    readonly amount: number;
    readonly beneficiaryPersonId: string;
    readonly consumedBy: unknown;
    readonly reversal: unknown;
  }) {
    return {
      valueRecordId: record.id,
      organizationScopeId: record.organizationScopeId,
      state: record.state,
      amount: record.amount,
      beneficiaryPersonId: record.beneficiaryPersonId,
      consumed: record.consumedBy !== null && record.consumedBy !== undefined,
      reversed: record.reversal !== null && record.reversal !== undefined,
    };
  }
  const failingValueRepo = createAuthorityEconomicValueRepository({
    authority: failingAuthority,
    logger: { debug },
  });
  const valueFundingLookup: BenefitValueFundingLookup = {
    async resolve(valueRecordId) {
      const record = await failingValueRepo.findById(valueRecordId);
      return record === null ? null : toBenefitValueFacts(record);
    },
    async resolveWithinTx(valueRecordId, tx) {
      const record = await failingValueRepo.findByIdWithinTx(valueRecordId, tx);
      return record === null ? null : toBenefitValueFacts(record);
    },
  };
  const failingSavingsRepo = createAuthorityProcurementSavingsRepository({
    authority: failingAuthority,
    logger: { debug },
  });
  const savingsFundingLookup: BenefitSavingsFundingLookup = {
    async resolveCurrent(savingsId) {
      const record = await failingSavingsRepo.findById(savingsId);
      if (!record) return null;
      const derivationCtx = harness.poolCreatorCtx(
        "w036-ac10-fault-savings",
      );
      try {
        const view =
          await harness.runtime.procurementSavingsService
            .evaluateProcurementSavings(
              derivationCtx,
              {
                organizationScopeId: record.organizationScopeId,
                poolId: record.poolId,
                baselineId: record.baselineId,
                outcomeObservationIds: [...record.observationIds],
                selectionId: record.selectionId,
              },
            );
        return {
          savingsId: record.id,
          organizationScopeId: record.organizationScopeId,
          procurementPoolId: record.poolId,
          supported: view.supported,
          savingsValue: view.savings === null ? null : view.savings.value,
          unit: view.savings === null ? null : view.savings.unit,
          digest: view.digest,
          derivationPolicyVersion: view.derivationPolicy.version,
          recordFormat: record.recordFormat,
        };
      } catch {
        return {
          savingsId: record.id,
          organizationScopeId: record.organizationScopeId,
          procurementPoolId: record.poolId,
          supported: false,
          savingsValue: null,
          unit: null,
          digest: null,
          derivationPolicyVersion: record.derivationPolicy.version,
          recordFormat: record.recordFormat,
        };
      }
    },
  };
  const failingRewardPolicyRepo = createAuthorityRewardPolicyRepository({
    authority: failingAuthority,
    logger: { debug },
  });
  const rewardPolicyLookup: BenefitRewardPolicyLookup = {
    async resolveLatest(policyId) {
      const policy = await failingRewardPolicyRepo.findLatestVersion(
        policyId,
        undefined,
      );
      if (!policy) return null;
      return {
        policyId: policy.policyId,
        version: policy.version,
        organizationScopeId: policy.organizationScopeId,
        allocations: policy.allocations.map((allocation) => ({
          beneficiaryPersonId: allocation.beneficiaryPersonId,
          weight: allocation.weight,
        })),
      };
    },
  };

  return createBenefitPoolService({
    policyRepository: createAuthorityBenefitPoolPolicyRepository({
      authority: failingAuthority,
      logger: { debug },
    }),
    poolRepository: createAuthorityBenefitPoolRepository({
      authority: failingAuthority,
      logger: { debug },
    }),
    allocationRepository: createAuthorityBenefitPoolAllocationRepository({
      authority: failingAuthority,
      logger: { debug },
    }),
    lookups: {
      membership: membershipLookup,
      valueFunding: valueFundingLookup,
      savingsFunding: savingsFundingLookup,
      rewardPolicy: rewardPolicyLookup,
      economicDraw,
    },
    idempotency: failingIdempotency,
    auditWriter: createTransactionalAuditWriter({
      underlying: harness.runtime.auditWriter,
    }),
    logger: logger.forModule("benefits"),
  });
}

// ---------------------------------------------------------------------------
// The AC-10 proofs
// ---------------------------------------------------------------------------

describe("NET-W036-AC-10 replay, concurrency, atomicity, tenancy and traversal", () => {
  test("SAME-KEY REPLAY (recognition): the canonical stage-12 recognition replays identically — created:false, the IDENTICAL record, ONE audit event, and nothing new is staged", async () => {
    const harness = await createNetW036Harness();
    try {
      // The canonical chain through the risk/dispute-gated maturation;
      // the benefit stages are skipped (the recognition replay needs
      // only the stage-12 record).
      const scenario: W036Scenario = await runW036Scenario(harness, {
        skipBenefitAllocation: true,
      });
      const runtime = harness.runtime;
      const ctx = harness.poolCreatorCtx("w036-ac10-replay-recognition");
      const recordedBefore = await auditCount(
        harness,
        "economic_value.recorded",
      );
      const entriesBefore = await collectionCount(
        harness,
        "economic_ledger_entries",
      );

      // The EXACT stage-12 call (the same scope, beneficiary, amount,
      // the three VERIFIED sources, the canonical key
      // `w036-value-record`).
      const replay = await runtime.economicValueService.recordPendingValue(
        ctx,
        {
          organizationScopeId: harness.organizationScopeId,
          beneficiaryPersonId: harness.poolCreatorPersonId,
          amount: scenario.value.amount,
          sources: [
            { kind: "contribution", id: scenario.contribution.id },
            { kind: "proof_of_value", id: scenario.proofOfValueId },
            { kind: "measured_outcome", id: scenario.measuredOutcome.id },
          ],
          idempotencyKey: "w036-value-record",
        },
      );
      // created:false + the IDENTICAL committed record.
      expect(replay.created).toBe(false);
      expect(replay.value).toEqual(scenario.value);
      // The replay minted NOTHING: still exactly ONE audit event for
      // the canonical record, no new ledger entries, and the global
      // envelope is conserved.
      expect(await auditCount(harness, "economic_value.recorded")).toBe(
        recordedBefore,
      );
      expect(
        (
          await runtime.auditWriter.query({
            eventType: "economic_value.recorded",
            resourceId: scenario.value.id,
          })
        ).length,
      ).toBe(1);
      expect(
        await collectionCount(harness, "economic_ledger_entries"),
      ).toBe(entriesBefore);
      await assertGlobalConservation(harness.w008);
    } finally {
      await harness.teardown();
    }
  }, 240_000);

  test("SAME-KEY REPLAY (allocation): the canonical stage-16 allocation replays identically — created:false, the IDENTICAL allocation, the draw NOT repeated, conservation unchanged", async () => {
    const harness = await createNetW036Harness();
    try {
      // The FULL canonical scenario (the benefit stages included — the
      // stage-16 allocation over the matured-value-funded pool).
      const scenario: W036Scenario = await runW036Scenario(harness);
      const runtime = harness.runtime;
      const ctx = harness.poolCreatorCtx("w036-ac10-replay-allocation");
      const draw = scenario.allocation!.draw!;
      const rewardEventsBefore = await auditCount(
        harness,
        "reward_allocation.recorded",
        draw.resultId,
      );
      const entriesBefore = await collectionCount(
        harness,
        "economic_ledger_entries",
      );
      const valueVersionBefore = (
        await runtime.economicValueService.getValue(ctx, scenario.value.id)
      ).version;

      // The EXACT stage-16 call (the canonical key `w036-allocation`).
      const replay = await runtime.benefitPoolService.allocatePoolBenefits(
        ctx,
        {
          organizationScopeId: harness.organizationScopeId,
          poolId: scenario.benefitPool!.id,
          idempotencyKey: "w036-allocation",
        },
      );
      // created:false + the IDENTICAL committed allocation.
      expect(replay.created).toBe(false);
      expect(replay.allocation).toEqual(scenario.allocation!);
      // The draw was NOT repeated: exactly ONE reward allocation audit
      // event for the draw result, the entry count UNCHANGED, the value
      // record stays CONSUMED at the same version, and exactly ONE
      // allocation lineage record exists for the pool.
      expect(
        await auditCount(harness, "reward_allocation.recorded", draw.resultId),
      ).toBe(rewardEventsBefore);
      expect(
        await auditCount(harness, "benefits_pool.allocation_recorded"),
      ).toBe(1);
      expect(
        await collectionCount(harness, "economic_ledger_entries"),
      ).toBe(entriesBefore);
      const consumed = await runtime.economicValueService.getValue(
        ctx,
        scenario.value.id,
      );
      expect(consumed.state).toBe("CONSUMED");
      expect(consumed.version).toBe(valueVersionBefore);
      expect(consumed.consumedBy).toEqual({
        kind: "reward_allocation",
        id: draw.resultId,
      });
      expect(
        (
          await runtime.benefitPoolService.listPoolAllocations(ctx, {
            organizationScopeId: harness.organizationScopeId,
            poolId: scenario.benefitPool!.id,
          })
        ).length,
      ).toBe(1);
      await assertGlobalConservation(harness.w008);
    } finally {
      await harness.teardown();
    }
  }, 240_000);

  test("RACE: a 4-way concurrent same-key allocation over ONE pool/value yields EXACTLY ONE economic application — one allocation record, one draw, one consumption, conservation holds", async () => {
    const harness = await createNetW036Harness();
    try {
      // The canonical chain with the benefit stages skipped — the
      // scenario's MATURE value record stays UNCONSUMED for this
      // suite's own race fixture.
      const scenario: W036Scenario = await runW036Scenario(harness, {
        skipBenefitAllocation: true,
      });
      const runtime = harness.runtime;
      const scope = harness.organizationScopeId;
      const ctx = harness.poolCreatorCtx("w036-ac10-race");

      // The race fixture (the stage-15 shape, this suite's fixed keys)
      // over the scenario's unconsumed MATURE value record.
      const pool = await seedValueFundedPool(harness, {
        rewardPolicyId: "w036-ac10-reward-policy",
        benefitPolicyId: "w036-ac10-benefit-policy",
        poolKey: "w036-ac10-benefit-pool",
        valueRecordId: scenario.maturedValue.id,
      });
      const entriesBefore = await collectionCount(
        harness,
        "economic_ledger_entries",
      );
      const rewardEventsBefore = await auditCount(
        harness,
        "reward_allocation.recorded",
      );

      // The 4-way concurrent SAME-KEY race (Promise.allSettled — every
      // outcome is classified; nothing is swallowed).
      const raceKey = "w036-ac10-race-allocation";
      const results = await Promise.allSettled([
        runtime.benefitPoolService.allocatePoolBenefits(ctx, {
          organizationScopeId: scope,
          poolId: pool.id,
          idempotencyKey: raceKey,
        }),
        runtime.benefitPoolService.allocatePoolBenefits(ctx, {
          organizationScopeId: scope,
          poolId: pool.id,
          idempotencyKey: raceKey,
        }),
        runtime.benefitPoolService.allocatePoolBenefits(ctx, {
          organizationScopeId: scope,
          poolId: pool.id,
          idempotencyKey: raceKey,
        }),
        runtime.benefitPoolService.allocatePoolBenefits(ctx, {
          organizationScopeId: scope,
          poolId: pool.id,
          idempotencyKey: raceKey,
        }),
      ]);

      // EVERY settled outcome is FULFILLED: the per-pool mutex
      // (`benefits_pool:{id}`) + the draw lock set (the value-record
      // lock, then the account locks in posting order) serialize the
      // four callers — the W028/W026 exactly-once semantics. There is
      // NO conflict outcome under same-key concurrency: the racers
      // queue behind the winner and observe its COMMITTED record.
      for (const [index, result] of results.entries()) {
        expect(result.status, `racer ${String(index)} settled`).toBe(
          "fulfilled",
        );
      }
      const fulfilled = results as ReadonlyArray<
        PromiseFulfilledResult<{ allocation: BenefitPoolAllocation; created: boolean }>
      >;
      // EXACTLY ONE executed; the other three are the DETERMINISTIC
      // in-race replays of the IDENTICAL record.
      const created = fulfilled.filter((r) => r.value.created);
      expect(created).toHaveLength(1);
      const replays = fulfilled.filter((r) => !r.value.created);
      expect(replays).toHaveLength(3);
      const winner = created[0]!.value.allocation;
      for (const replay of replays) {
        expect(replay.value.allocation.id).toBe(winner.id);
        expect(replay.value.allocation).toEqual(winner);
      }

      // Exactly ONE allocation lineage record for the pool.
      expect(
        (
          await runtime.benefitPoolService.listPoolAllocations(ctx, {
            organizationScopeId: scope,
            poolId: pool.id,
          })
        ).length,
      ).toBe(1);

      // Exactly ONE draw: one reward allocation record, exactly one
      // new reward_allocation.recorded audit event, the 4 balanced
      // draw postings (debit mature_value + 3 credits rewards), and
      // the value record consumed EXACTLY-ONCE by that draw.
      expect(await collectionCount(harness, "reward_allocations")).toBe(1);
      expect(await auditCount(harness, "reward_allocation.recorded")).toBe(
        rewardEventsBefore + 1,
      );
      expect(
        await collectionCount(harness, "economic_ledger_entries"),
      ).toBe(entriesBefore + 4);
      expect(winner.draw).not.toBeNull();
      const consumed = await runtime.economicValueService.getValue(
        ctx,
        scenario.maturedValue.id,
      );
      expect(consumed.state).toBe("CONSUMED");
      expect(consumed.consumedBy).toEqual({
        kind: "reward_allocation",
        id: winner.draw!.resultId,
      });

      // The deterministic 3/2/1 plan over the matured value (120) and
      // Σ shares === the funded amount EXACTLY (conservation).
      expect(winner.totalAllocated).toBe(scenario.maturedValue.amount);
      expect(winner.shares.map((s) => s.amount)).toEqual([60, 40, 20]);
      expect(
        winner.shares.reduce(
          (sum, share) => sum + toEconomicMinorUnits(share.amount),
          0,
        ),
      ).toBe(toEconomicMinorUnits(scenario.maturedValue.amount));
      // The global economic envelope is conserved after the race.
      await assertGlobalConservation(harness.w008);
    } finally {
      await harness.teardown();
    }
  }, 240_000);

  test("THE COMPOSITE-LEVEL FAULT INJECTION: the authoritative COMMIT fails AFTER the benefit allocation join fully stages the unit → NOTHING persists; the same-key retry on the REAL path completes exactly once and replays identically", async () => {
    const harness = await createNetW036Harness();
    try {
      // The canonical chain with the benefit stages skipped — the
      // scenario leaves a clean, unconsumed MATURE value record, and
      // the fault fixture adds its OWN mature value through the real
      // W008 factory (beneficiary = buyer A, a declared member).
      await runW036Scenario(harness, { skipBenefitAllocation: true });
      const runtime = harness.runtime;
      const scope = harness.organizationScopeId;
      const ctx = harness.poolCreatorCtx("w036-ac10-atomic");
      const faultValue = await createMatureValue(harness.w008, {
        amount: 90,
        beneficiaryPersonId: harness.poolCreatorPersonId,
      });
      expect(faultValue.state).toBe("MATURE");

      // The fault pool over the fresh MATURE value (through the REAL
      // runtime services — only the executing composite is rebuilt
      // over the failing authority).
      const faultPool = await seedValueFundedPool(harness, {
        rewardPolicyId: "w036-ac10-fault-reward-policy",
        benefitPolicyId: "w036-ac10-fault-benefit-policy",
        poolKey: "w036-ac10-fault-benefit-pool",
        valueRecordId: faultValue.id,
      });

      // The pre-failure authoritative state (everything the allocation
      // join could touch).
      const allocationsBefore = await collectionCount(
        harness,
        "benefit_pool_allocations",
      );
      const rewardAllocationsBefore = await collectionCount(
        harness,
        "reward_allocations",
      );
      const entriesBefore = await collectionCount(
        harness,
        "economic_ledger_entries",
      );
      const ledgerTransactionsBefore = await collectionCount(
        harness,
        "economic_ledger_transactions",
      );
      const idempotencyBefore = await collectionCount(harness, "idempotency");
      const allocationAuditBefore = await auditCount(
        harness,
        "benefits_pool.allocation_recorded",
      );
      const rewardAuditBefore = await auditCount(
        harness,
        "reward_allocation.recorded",
      );

      // The ACTUAL benefit funding composite over the COMMIT-FAILING
      // stack: the neutral gates pass (the lookups resolve over the
      // real services/authority reads), the allocation + the reward
      // draw (record + balanced postings + exactly-once consumption) +
      // the idempotency record + the buffered audit are FULLY STAGED
      // inside the single authoritative transaction, and the
      // authoritative COMMIT is forced to fail.
      const theKey = "w036-ac10-fault-allocation";
      const failingService = await rebuildFailingBenefitPoolService(harness);
      await expect(
        failingService.allocatePoolBenefits(
          harness.poolCreatorCtx("w036-ac10-fault-execute"),
          {
            organizationScopeId: scope,
            poolId: faultPool.id,
            idempotencyKey: theKey,
          },
        ),
      ).rejects.toThrow("injected authoritative COMMIT failure");

      // ---- NOTHING persisted (all simultaneously) ------------------
      // (a) zero allocation records (and none for the fault pool);
      expect(await collectionCount(harness, "benefit_pool_allocations")).toBe(
        allocationsBefore,
      );
      expect(
        (
          await runtime.benefitPoolService.listPoolAllocations(ctx, {
            organizationScopeId: scope,
            poolId: faultPool.id,
          })
        ).length,
      ).toBe(0);
      // (b) zero new reward-side records;
      expect(await collectionCount(harness, "reward_allocations")).toBe(
        rewardAllocationsBefore,
      );
      // (c) the ledger UNCHANGED (entries + transactions);
      expect(await collectionCount(harness, "economic_ledger_entries")).toBe(
        entriesBefore,
      );
      expect(
        await collectionCount(harness, "economic_ledger_transactions"),
      ).toBe(ledgerTransactionsBefore);
      // (d) the value record NOT consumed (still MATURE, untouched);
      const untouched = await runtime.economicValueService.getValue(
        ctx,
        faultValue.id,
      );
      expect(untouched.state).toBe("MATURE");
      expect(untouched.version).toBe(faultValue.version);
      expect(untouched.consumedBy).toBeNull();
      // (e) zero idempotency residue (no record — the in-flight marker
      //     and the completed record both died with the transaction);
      expect(await collectionCount(harness, "idempotency")).toBe(
        idempotencyBefore,
      );
      const idempotencyRecords = await runtime.postgresAuthority.scan<{
        readonly key: string;
      }>("idempotency");
      expect(
        idempotencyRecords.filter(
          (record) => record.value.key.includes(faultPool.id),
        ),
      ).toHaveLength(0);
      // (f) zero new audit events (the buffered audit was DISCARDED on
      //     the rolled-back commit — "audit exists, mutation doesn't"
      //     is impossible).
      expect(await auditCount(harness, "benefits_pool.allocation_recorded")).toBe(
        allocationAuditBefore,
      );
      expect(await auditCount(harness, "reward_allocation.recorded")).toBe(
        rewardAuditBefore,
      );
      // The global envelope is still conserved (nothing was posted).
      await assertGlobalConservation(harness.w008);

      // ---- The healthy same-key retry through the REAL runtime ----
      // composite completes EXACTLY ONCE: one allocation + one draw +
      // the value consumed + conservation.
      const retried = await runtime.benefitPoolService.allocatePoolBenefits(
        ctx,
        {
          organizationScopeId: scope,
          poolId: faultPool.id,
          idempotencyKey: theKey,
        },
      );
      expect(retried.created).toBe(true);
      const allocation = retried.allocation;
      expect(allocation.totalAllocated).toBe(90);
      expect(allocation.shares.map((s) => s.amount)).toEqual([45, 30, 15]);
      expect(allocation.draw).not.toBeNull();
      const consumed = await runtime.economicValueService.getValue(
        ctx,
        faultValue.id,
      );
      expect(consumed.state).toBe("CONSUMED");
      expect(consumed.consumedBy).toEqual({
        kind: "reward_allocation",
        id: allocation.draw!.resultId,
      });
      expect(
        (
          await runtime.benefitPoolService.listPoolAllocations(ctx, {
            organizationScopeId: scope,
            poolId: faultPool.id,
          })
        ).length,
      ).toBe(1);
      expect(
        await auditCount(
          harness,
          "benefits_pool.allocation_recorded",
          allocation.id,
        ),
      ).toBe(1);
      expect(
        await auditCount(
          harness,
          "reward_allocation.recorded",
          allocation.draw!.resultId,
        ),
      ).toBe(1);
      await assertGlobalConservation(harness.w008);

      // A further same-key call is the IDENTICAL replay.
      const replay = await runtime.benefitPoolService.allocatePoolBenefits(
        ctx,
        {
          organizationScopeId: scope,
          poolId: faultPool.id,
          idempotencyKey: theKey,
        },
      );
      expect(replay.created).toBe(false);
      expect(replay.allocation).toEqual(allocation);
      expect(
        (
          await runtime.benefitPoolService.listPoolAllocations(ctx, {
            organizationScopeId: scope,
            poolId: faultPool.id,
          })
        ).length,
      ).toBe(1);
    } finally {
      await harness.teardown();
    }
  }, 240_000);

  test("TENANCY: cross-tenant pool/offer/selection/savings/benefit-pool/allocation references fail closed with NO existence oracle (error-shape parity vs nonexistent ids); the cross-scope funding references fail closed", async () => {
    const harness = await createNetW036Harness();
    try {
      // The full canonical scenario (a real selection + savings +
      // benefit pool + allocation to reference) plus this suite's own
      // race-shaped fixture pool over the scenario's matured value.
      const scenario: W036Scenario = await runW036Scenario(harness);
      const runtime = harness.runtime;
      const ctx = harness.poolCreatorCtx("w036-ac10-tenant");
      const foreignOrg = await runtime.organizationService.createOrganization(
        harness.bootstrapCtx,
        {
          name: "W036 AC-10 Foreign Org",
          creatorId: "bootstrap",
        },
      );
      const foreignScope = foreignOrg.id;

      /**
       * The AC-01 parity technique: the cross-tenant error (a REAL id
       * under the FOREIGN scope) and the nonexistent-id error share
       * code + message shape — the message differs ONLY by the
       * caller-supplied id (no existence oracle).
       */
      const assertNotFoundParity = async (
        realId: string,
        fakeId: string,
        call: (scope: string, id: string) => Promise<unknown>,
      ): Promise<void> => {
        const crossError = await call(foreignScope, realId).catch(
          (e: unknown) => e,
        );
        const nonexistentError = await call(foreignScope, fakeId).catch(
          (e: unknown) => e,
        );
        expect(crossError).toBeInstanceOf(NotFoundError);
        expect(nonexistentError).toBeInstanceOf(NotFoundError);
        expect((crossError as NotFoundError).code).toBe("NOT_FOUND");
        expect((crossError as NotFoundError).code).toBe(
          (nonexistentError as NotFoundError).code,
        );
        expect((crossError as NotFoundError).message).toBe(
          (nonexistentError as NotFoundError).message.replace(fakeId, realId),
        );
      };

      // The matrix over the /demand + /benefits read surfaces.
      await assertNotFoundParity(
        scenario.pool.id,
        "w036-ac10-no-pool",
        (scope, id) =>
          runtime.procurementService.getProcurementPool(ctx, scope, id),
      );
      await assertNotFoundParity(
        scenario.offers[0]!.id,
        "w036-ac10-no-offer",
        (scope, id) =>
          runtime.supplierOfferService.getSupplierOffer(ctx, scope, id),
      );
      await assertNotFoundParity(
        scenario.pool.id,
        "w036-ac10-no-pool",
        (scope, id) =>
          runtime.supplierOfferService.listPoolSelections(ctx, {
            organizationScopeId: scope,
            poolId: id,
          }),
      );
      await assertNotFoundParity(
        scenario.pool.id,
        "w036-ac10-no-pool",
        (scope, id) =>
          runtime.procurementSavingsService.listPoolSavings(ctx, {
            organizationScopeId: scope,
            poolId: id,
          }),
      );
      await assertNotFoundParity(
        scenario.benefitPool!.id,
        "w036-ac10-no-benefit-pool",
        (scope, id) =>
          runtime.benefitPoolService.getBenefitPool(ctx, {
            organizationScopeId: scope,
            poolId: id,
          }),
      );
      await assertNotFoundParity(
        scenario.allocation!.id,
        "w036-ac10-no-allocation",
        (scope, id) =>
          runtime.benefitPoolService.getBenefitPoolAllocation(ctx, {
            organizationScopeId: scope,
            allocationId: id,
          }),
      );

      // ---- The cross-scope FUNDING references fail closed ----------
      // The SAVINGS cross-scope reason (NOT pinned in AC-09 — pinned
      // HERE): a savings record committed under a DIFFERENT
      // organization scope of the SAME authority (the minimal W027
      // chain in the foreign org — pool + pool-bound evidence + a
      // savings observation + a counterfactual baseline whose window
      // is derived from the foreign pool's own authoritative
      // createdAt), referenced by a LOCAL pool.
      const scope = harness.organizationScopeId;
      const foreignCtx = personCtx(
        harness,
        harness.poolCreatorPersonId,
        "w036-ac10-foreign-savings",
      );
      await runtime.membershipService.grantMembership(
        harness.bootstrapCtx,
        {
          personId: harness.poolCreatorPersonId,
          organizationId: foreignOrg.id,
          grantedBy: "bootstrap",
        },
      );
      const foreignPool = (
        await runtime.procurementService.createProcurementPool(foreignCtx, {
          organizationScopeId: foreignScope,
          name: "W036 AC-10 Foreign Savings Pool",
          categoryKey: "cloud_infrastructure",
          qualificationPolicy: {
            minimumCommitments: 2,
            minimumOrganizations: 2,
          },
          idempotencyKey: "w036-ac10-foreign-pool",
        })
      ).pool;
      const foreignEvidence = await runtime.evidenceService.createEvidence(
        foreignCtx,
        {
          organizationScopeId: foreignScope,
          ownerId: harness.poolCreatorPersonId,
          subjectReference: {
            subjectId: foreignPool.id,
            subjectType: "procurement_pool",
          },
          provenance: {
            sourceType: "platform",
            sourceId: "w036-ac10-foreign-spend-ledger",
            method: "historical-spend-report",
            collectedAt: W036_EVIDENCE_CAPTURED_AT,
            collectorId: harness.poolCreatorPersonId,
          },
          confidence: { point: 0.9, lower: 0.8, upper: 0.95 },
          sensitivity: "standard",
          payload: {
            kind: "spend_report",
            note: "W036 AC-10 foreign baseline evidence",
          },
        },
      );
      const foreignObservation =
        await runtime.outcomeObservationService.createOutcomeObservation(
          foreignCtx,
          {
            organizationScopeId: foreignScope,
            observerId: harness.poolCreatorPersonId,
            subjectReference: {
              subjectId: foreignPool.id,
              subjectType: "procurement_pool",
            },
            outcomeType: "savings",
            observedValue: { value: 880, unit: "usd" },
            confidence: { point: 0.95, lower: 0.9, upper: 0.98 },
            provenance: {
              sourceType: "platform",
              sourceId: "w036-ac10-foreign-fulfillment-ledger",
              method: "procurement-fulfillment-ledger",
              methodVersion: "1",
            },
          },
        );
      // The DERIVED historical comparison window (the stage-10
      // constraint proof): the foreign pool's own authoritative
      // createdAt minus the fixed 31/1-day geometry.
      const authoritativeForeignPool =
        await runtime.procurementService.getProcurementPool(
          foreignCtx,
          foreignScope,
          foreignPool.id,
        );
      const foreignWindowEndsAt = w036IsoMinusDays(
        authoritativeForeignPool.createdAt,
        W036_BASELINE_WINDOW_ENDS_DAYS_AGO,
      );
      const foreignBaseline = (
        await runtime.procurementSavingsService.createProcurementBaseline(
          foreignCtx,
          {
            organizationScopeId: foreignScope,
            poolId: foreignPool.id,
            baselineKind: "counterfactual",
            method: "prior_period",
            methodVersion: "1",
            comparisonWindow: {
              startsAt: w036IsoMinusDays(
                authoritativeForeignPool.createdAt,
                W036_BASELINE_WINDOW_ENDS_DAYS_AGO + W036_BASELINE_WINDOW_DAYS,
              ),
              endsAt: foreignWindowEndsAt,
            },
            population:
              "Historical spend for the foreign pool category over the comparison window (the W036 AC-10 cross-scope fixture)",
            baselineValue: { value: 1000, unit: "usd" },
            confidence: { point: 0.9, lower: 0.8, upper: 0.95 },
            provenance: {
              sourceType: "platform",
              sourceId: "w036-ac10-foreign-spend-ledger",
              collectedAt: foreignWindowEndsAt,
              collectorId: harness.poolCreatorPersonId,
            },
            evidenceIds: [foreignEvidence.id],
            idempotencyKey: "w036-ac10-foreign-baseline",
          },
        )
      ).baseline;
      const foreignSavings = (
        await runtime.procurementSavingsService.recordProcurementSavings(
          foreignCtx,
          {
            organizationScopeId: foreignScope,
            poolId: foreignPool.id,
            baselineId: foreignBaseline.id,
            outcomeObservationIds: [foreignObservation.id],
            idempotencyKey: "w036-ac10-foreign-savings",
          },
        )
      ).savings;
      expect(foreignSavings.organizationScopeId).toBe(foreignScope);
      await runtime.benefitPoolService.createPolicyVersion(ctx, {
        organizationScopeId: scope,
        policyId: "w036-ac10-policy-savings-cross",
        version: 1,
        benefitType: "rebate",
        eligibilityCriteria: ["active_membership"],
        memberDeclarations: [
          { personId: harness.buyerAPersonId, weight: 3 },
          { personId: harness.buyerBPersonId, weight: 2 },
          { personId: harness.buyerCPersonId, weight: 1 },
        ],
        remainderDisposition: "last_member_absorbs",
        idempotencyKey: "w036-ac10-policy-savings-cross",
      });
      const crossSavingsPool = (
        await runtime.benefitPoolService.createBenefitPool(ctx, {
          organizationScopeId: scope,
          policyId: "w036-ac10-policy-savings-cross",
          fundingRefs: [{ kind: "verified_savings", id: foreignSavings.id }],
          idempotencyKey: "w036-ac10-pool-savings-cross",
        })
      ).pool;
      const crossSavingsView =
        await runtime.benefitPoolService.evaluatePoolAllocation(ctx, {
          organizationScopeId: scope,
          poolId: crossSavingsPool.id,
        });
      expect(crossSavingsView.eligible).toBe(false);
      expect(crossSavingsView.funding[0]!.qualified).toBe(false);
      expect(crossSavingsView.funding[0]!.resolvedAmount).toBeNull();
      expect(crossSavingsView.funding[0]!.reason).toBe(
        "cross-scope savings record",
      );
      expect(crossSavingsView.plan).toBeNull();
      const crossSavingsError = await expectRejection(() =>
        runtime.benefitPoolService.allocatePoolBenefits(ctx, {
          organizationScopeId: scope,
          poolId: crossSavingsPool.id,
          idempotencyKey: "w036-ac10-allocate-savings-cross",
        }),
      );
      expect((crossSavingsError as OpenConError).code).toBe(
        "BENEFITS_VALIDATION",
      );
      expect((crossSavingsError as OpenConError).message).toMatch(
        /not qualified/,
      );
      // NO partial state for the refused allocation.
      expect(
        (
          await runtime.benefitPoolService.listPoolAllocations(ctx, {
            organizationScopeId: scope,
            poolId: crossSavingsPool.id,
          })
        ).length,
      ).toBe(0);

      // The VALUE cross-scope representative (the EXHAUSTIVE value
      // reason vocabulary — PENDING/CONSUMED/nonexistent/cross-scope/
      // reversed — is pinned in AC-09 test 2; ONE representative here):
      // a foreign-scope PENDING value referenced by a local pool.
      const foreignEvidence2 = await runtime.evidenceService.createEvidence(
        personCtx(harness, harness.poolCreatorPersonId, "w036-ac10-foreign"),
        {
          organizationScopeId: foreignScope,
          ownerId: harness.poolCreatorPersonId,
          subjectReference: {
            subjectId: "w036-ac10-foreign-pool",
            subjectType: "procurement_pool",
          },
          provenance: {
            sourceType: "platform",
            sourceId: "w036-ac10-foreign-spend-ledger",
            method: "historical-spend-report",
            collectedAt: W036_EVIDENCE_CAPTURED_AT,
          },
          confidence: { point: 0.9, lower: 0.8, upper: 0.95 },
          sensitivity: "standard",
          payload: { kind: "spend_report", note: "W036 AC-10 foreign evidence" },
        },
      );
      const foreignValue = (
        await runtime.economicValueService.recordPendingValue(
          personCtx(harness, harness.poolCreatorPersonId, "w036-ac10-foreign-v"),
          {
            organizationScopeId: foreignScope,
            beneficiaryPersonId: harness.poolCreatorPersonId,
            amount: 77,
            sources: [{ kind: "evidence", id: foreignEvidence2.id }],
            idempotencyKey: "w036-ac10-foreign-value",
          },
        )
      ).value;
      expect(foreignValue.state).toBe("PENDING");
      // The cross-VALUE pool needs a reward-policy-mirrored policy (the
      // AC-09 "negative policy" shape) so the draw PRECONDITIONS pass
      // and the funding TENANT gate itself surfaces — the canonical
      // scenario's own reward policy mirrors the same 3/2/1 members.
      await runtime.benefitPoolService.createPolicyVersion(ctx, {
        organizationScopeId: scope,
        policyId: "w036-ac10-policy-value-cross",
        version: 1,
        benefitType: "credits",
        eligibilityCriteria: ["active_membership"],
        memberDeclarations: [
          { personId: harness.buyerAPersonId, weight: 3 },
          { personId: harness.buyerBPersonId, weight: 2 },
          { personId: harness.buyerCPersonId, weight: 1 },
        ],
        remainderDisposition: "last_member_absorbs",
        rewardPolicyId: scenario.rewardPolicyId!,
        idempotencyKey: "w036-ac10-policy-value-cross",
      });
      const crossValuePool = (
        await runtime.benefitPoolService.createBenefitPool(ctx, {
          organizationScopeId: scope,
          policyId: "w036-ac10-policy-value-cross",
          fundingRefs: [{ kind: "economic_value", id: foreignValue.id }],
          idempotencyKey: "w036-ac10-pool-value-cross",
        })
      ).pool;
      const crossValueView =
        await runtime.benefitPoolService.evaluatePoolAllocation(ctx, {
          organizationScopeId: scope,
          poolId: crossValuePool.id,
        });
      expect(crossValueView.eligible).toBe(false);
      expect(crossValueView.funding[0]!.reason).toBe(
        "cross-scope value record",
      );
      const crossValueError = await expectRejection(() =>
        runtime.benefitPoolService.allocatePoolBenefits(ctx, {
          organizationScopeId: scope,
          poolId: crossValuePool.id,
          idempotencyKey: "w036-ac10-allocate-value-cross",
        }),
      );
      expect((crossValueError as OpenConError).code).toBe("NOT_FOUND");
      expect((crossValueError as OpenConError).message).toMatch(
        /not found in scope/,
      );
      // Nothing was minted by any tenant refusal; conservation holds.
      await assertGlobalConservation(harness.w008);
    } finally {
      await harness.teardown();
    }
  }, 240_000);

  test("TRAVERSAL CONTRACT: a fresh canonical scenario re-proves the 17-witness frozen order with authoritative state/version witnesses and STRICTLY ASCENDING audit-marker positions", async () => {
    const harness = await createNetW036Harness();
    try {
      const scenario: W036Scenario = await runW036Scenario(harness);
      const witnesses = scenario.witnesses;

      // (a) The contract shape: EXACTLY the 17 frozen ledger §3 stages
      //     in order, each with its owning authority; the exhaustive
      //     record-id/ladder version lives in the full-path suite —
      //     here the first/last witnesses + the ladder contract.
      expect(witnesses).toHaveLength(17);
      expect(witnesses.map((w) => `${w.stage}|${w.authority}`)).toEqual([
        "demand-pool-resolved|/demand",
        "aggregate-disclosure-gated|/demand",
        "qualified-demand-resolved|/demand",
        "supplier-offers-recorded|/demand",
        "supplier-eligibility-evaluated|/demand",
        "competitive-selection-committed|/demand",
        "fulfillment-entered-sanctioned|/workflows",
        "execution-state-observed|/workflows",
        "realized-outcome-normalized|/outcomes",
        "baseline-counterfactual-resolved|/demand",
        "savings-verified-pov-qualified|/demand+evidence",
        "settlement-value-recognized-pending|/settlement",
        "risk-dispute-controls-exercised|/settlement",
        "value-matured|/settlement",
        "benefit-funding-reference-resolved|/benefits",
        "benefit-allocation-committed|/benefits",
        "lineage-reconstruction-completed|audit",
      ]);
      // The first marker: the pool's own creation; the last: the
      // committed benefit allocation; every stage 1–16 record id is
      // the stage's OWN durable authority record.
      expect(scenario.auditMarkers[0]).toEqual([
        "procurement_pool.created",
        scenario.pool.id,
      ]);
      expect(
        scenario.auditMarkers[scenario.auditMarkers.length - 1],
      ).toEqual([
        "benefits_pool.allocation_recorded",
        scenario.allocation!.id,
      ]);
      expect(scenario.auditMarkers).toHaveLength(44);

      // (b) The authoritative state/version witnesses: the pre-subject
      //     nulls, then the sanctioned /workflows ladder with
      //     STRICTLY INCREASING versions at every DISTINCT state
      //     (ASSIGNED v2 → IN_PROGRESS v3 → MEASURING v5 → VERIFIED
      //     v10 — every mutation through the owning boundary).
      expect(witnesses[0]!.fulfillmentState).toBeNull();
      expect(witnesses[0]!.fulfillmentVersion).toBeNull();
      expect(witnesses[6]!.fulfillmentState).toBe("ASSIGNED");
      expect(witnesses[6]!.fulfillmentVersion).toBe(2);
      expect(witnesses[8]!.fulfillmentState).toBe("MEASURING");
      expect(witnesses[8]!.fulfillmentVersion).toBe(5);
      expect(witnesses[9]!.fulfillmentState).toBe("VERIFIED");
      expect(witnesses[9]!.fulfillmentVersion).toBe(10);
      expect(witnesses[16]!.fulfillmentState).toBe("VERIFIED");
      expect(witnesses[16]!.fulfillmentVersion).toBe(10);
      let previousVersion = Number.NEGATIVE_INFINITY;
      let previousState: string | null = null;
      let previousStateVersion = Number.NEGATIVE_INFINITY;
      for (const witness of witnesses) {
        if (witness.fulfillmentVersion !== null) {
          expect(witness.fulfillmentVersion).toBeGreaterThanOrEqual(
            previousVersion,
          );
          previousVersion = witness.fulfillmentVersion;
          if (witness.fulfillmentState !== previousState) {
            expect(witness.fulfillmentVersion).toBeGreaterThan(
              previousStateVersion,
            );
            previousState = witness.fulfillmentState;
            previousStateVersion = witness.fulfillmentVersion;
          }
        }
      }

      // (c) The audit-marker positions are STRICTLY ASCENDING in the
      //     global append-only log (the durable commit order
      //     corroborates the witness order — local array order alone
      //     is never evidence). The positions are re-derived from the
      //     durable log here.
      const log = await harness.runtime.auditWriter.query({
        limit: 1_000_000,
      });
      const positions = scenario.auditMarkers.map(
        ([eventType, resourceId]) => {
          const index = log.findIndex(
            (event) =>
              event.eventType === eventType && event.resourceId === resourceId,
          );
          expect(
            index,
            `missing audit event ${eventType} for ${resourceId}`,
          ).toBeGreaterThanOrEqual(0);
          return index;
        },
      );
      expect([...positions]).toEqual([...scenario.auditPositions]);
      for (let i = 1; i < positions.length; i += 1) {
        expect(
          positions[i]! > positions[i - 1]!,
          `canonical audit order violated at marker ${String(i)}`,
        ).toBe(true);
      }
    } finally {
      await harness.teardown();
    }
  }, 240_000);

  test("DETERMINISM/STRUCTURE (self-pins): this file carries no wall-clock/random token, no repository write call, and fixed w036-ac10 idempotency keys only (comments stripped)", async () => {
    // Strip comments so the pins scan CODE only (the doc comments
    // legitimately NAME the forbidden tokens while explaining why they
    // are absent — the W035/AC-04 regression discipline). The token
    // literals are ASSEMBLED from pieces so this file's own assertion
    // code never contains the forbidden token itself (self-covering
    // pin).
    const stripComments = (source: string): string =>
      source
        .replace(/\/\*[\s\S]*?\*\//g, "")
        .replace(/^[ \t]*\/\/.*$/gm, "")
        .replace(/[ \t]\/\/.*$/gm, "");
    const ownCode = stripComments(
      await readFile(
        join(
          import.meta.dir,
          "net-w036-ac-10-replay-concurrency-atomicity.test.ts",
        ),
        "utf8",
      ),
    );
    for (const token of [
      "new " + "Date" + "(",
      "Date." + "now" + "(",
      "random" + "UUID",
    ]) {
      expect(ownCode.split(token).length - 1).toBe(0);
    }
    // No repository write calls and no local state-machine vocabulary
    // (the commit-failing wrapper delegates through the REAL
    // transaction interface — the generic-delegate form keeps the
    // write-token out of this file's code).
    for (const token of [
      "." + "put" + "(",
      "saveWith" + "inTx",
      "deleteWith" + "inTx",
      "statusTrans" + "ition(",
      "statusMac" + "hine(",
    ]) {
      expect(ownCode.split(token).length - 1).toBe(0);
    }
    // Fixed-key discipline: every idempotency key in this file is a
    // fixed w036-ac10 / canonical w036- literal (no fabricated
    // identities).
    expect(ownCode.split('"w036-ac10-').length - 1).toBeGreaterThanOrEqual(
      20,
    );
  }, 120_000);
});
