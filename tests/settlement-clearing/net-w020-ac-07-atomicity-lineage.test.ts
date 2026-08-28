/**
 * NET-W020-AC-07 — audit and transaction lineage are complete; an
 * authoritative commit failure leaves no partial economic mutation
 * (issue #39 AC-7; invariant 7).
 *
 * The clearing record commits in ONE authoritative transaction (the
 * record + the idempotency record + the transactional audit event
 * together or not at all). The fault injection proves the record
 * boundary: a failing COMMIT persists NOTHING and a healthy replay
 * converges (the draw replays identically — exactly one allocation).
 * The audit event binds campaign + contribution + placement +
 * clearing record + idempotency record + authoritative transaction +
 * draw transaction.
 */
import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import type { ExecutionContext } from "../../src/core/execution-context.ts";
import type {
  AuthorityTransaction,
  PostgresAuthority,
} from "../../src/core/postgres-authority.ts";
import { createPostgresIdempotencyStore } from "../../src/persistence/idempotency-store.ts";
import { createTransactionalAuditWriter } from "../../src/audit/transactional-audit-writer.ts";
import {
  createAuthorityCrossPromotionClearingRepository,
} from "../../src/settlement/authority-clearing-repository.ts";
import { createCrossPromotionClearingService } from "../../src/settlement/clearing-service.ts";
import {
  createNetW020Harness,
  createCrossPromotionWorld,
  executeCrossPromotionClearing,
  operatorCtx,
  key,
  type NetW020Harness,
} from "./_net-w020-harness.ts";

let harness: NetW020Harness;

beforeAll(async () => {
  harness = await createNetW020Harness();
});

afterAll(async () => {
  await harness.teardown();
});

/** Count audit events of one type (optionally for one resource). */
async function auditCount(
  eventType: string,
  resourceId?: string,
): Promise<number> {
  const events = await harness.runtime.auditWriter.query(
    resourceId ? { eventType, resourceId } : { eventType },
  );
  return events.length;
}

/** The W006/W017/W018/W019 rebuild pattern: commit() always fails. */
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

/** Test-local neutral lookups over the runtime's public services. */
function rebuildLookups() {
  return {
    contribution: {
      async resolve(contributionId: string) {
        try {
          const contribution =
            await harness.runtime.contributionService.getContribution(
              operatorCtx(harness, "w020-fault-contribution"),
              contributionId,
            );
          let pohState = "NONE";
          try {
            const poh =
              await harness.runtime.helpfulnessService.getProofOfHelpfulness(
                operatorCtx(harness, "w020-fault-poh"),
                contributionId,
              );
            pohState = poh.state;
          } catch {
            pohState = "NONE";
          }
          const moderation =
            await harness.runtime.moderationService.getModerationSummary(
              operatorCtx(harness, "w020-fault-moderation"),
              contributionId,
            );
          let qualityBand: string | null = null;
          const evaluation =
            await harness.runtime.qualityService.getLatestQualityEvaluation(
              operatorCtx(harness, "w020-fault-quality"),
              contributionId,
            );
          if (evaluation) qualityBand = evaluation.band;
          return {
            organizationScopeId: contribution.organizationScopeId,
            lifecycleState: contribution.state,
            contributorPersonId: contribution.contributorId,
            proofOfHelpfulnessState: pohState,
            moderationStatus: moderation.status,
            qualityBand,
          };
        } catch {
          return null;
        }
      },
    },
    placement: {
      async readiness(organizationScopeId: string, placementId: string) {
        try {
          const readiness =
            await harness.runtime.inventoryService.getPlacementSettlementReadiness(
              operatorCtx(harness, "w020-fault-readiness"),
              organizationScopeId,
              placementId,
            );
          const placement = await harness.runtime.inventoryService.getPlacement(
            operatorCtx(harness, "w020-fault-placement"),
            organizationScopeId,
            placementId,
          );
          return {
            placementId: readiness.placementId,
            organizationScopeId: readiness.organizationScopeId,
            campaignId: placement.sourceContext.campaignId,
            campaignPolicyVersion: placement.sourceContext.campaignPolicyVersion,
            ownerPersonId: placement.sourceContext.ownerPersonId,
            settlementReady: readiness.eligible,
          };
        } catch {
          return null;
        }
      },
    },
    campaign: {
      async resolve(campaignId: string) {
        try {
          const campaign = await harness.runtime.campaignService.getCampaign(
            operatorCtx(harness, "w020-fault-campaign"),
            campaignId,
          );
          const versions =
            await harness.runtime.campaignService.listPolicyVersions(
              operatorCtx(harness, "w020-fault-policy"),
              campaignId,
            );
          const latest = versions[versions.length - 1]!;
          return {
            campaignId: campaign.id,
            organizationScopeId: campaign.organizationScopeId,
            administrativeStatus: campaign.status,
            currentPolicyVersion: latest.version,
            clearingRules: latest.clearingRules.map((rule) => ({
              id: rule.id,
              objectiveId: rule.objectiveId,
              basis: rule.basis,
              drawKind: rule.drawKind,
              rewardPolicyId: rule.rewardPolicyId,
              maxDrawAmount: rule.maxDrawAmount,
            })),
          };
        } catch {
          return null;
        }
      },
    },
    gate: {
      async assess(input: {
        readonly organizationScopeId: string;
        readonly operationClass: string;
        readonly recordSubjectIds: readonly string[];
        readonly personSubjectId: string | null;
      }) {
        const execution = operatorCtx(harness, "w020-fault-gate");
        for (const recordSubjectId of input.recordSubjectIds) {
          const control = await harness.runtime.riskControlService.findGatingControl(
            execution,
            input.organizationScopeId,
            input.operationClass as never,
            recordSubjectId,
            input.personSubjectId,
          );
          if (control && (control.action === "HOLD" || control.action === "BLOCK")) {
            return {
              clear: false,
              source: "risk_control",
              controlId: control.id,
              disputeId: null,
              detail: {},
            };
          }
        }
        const active = await harness.runtime.disputeService.listActiveBySubjectIds(
          execution,
          input.organizationScopeId,
          input.recordSubjectIds,
        );
        if (active.length > 0) {
          return {
            clear: false,
            source: "active_dispute",
            controlId: null,
            disputeId: active[0]!.id,
            detail: {},
          };
        }
        return {
          clear: true,
          source: null,
          controlId: null,
          disputeId: null,
          detail: {},
        };
      },
    },
  };
}

describe("NET-W020-AC-07 atomicity + lineage", () => {
  test("the record command's authoritative COMMIT fails → NOTHING persists (no record, no audit); the healthy replay converges with NO duplicated draw", async () => {
    const world = await createCrossPromotionWorld(harness, { amount: 100 });
    const theKey = key("w020-atomic");
    // The DRAW step exactly as the composite executes it (the first
    // economic mutation, committing on the REAL authority).
    const policy = await harness.runtime.campaignService.getPolicyVersion(
      operatorCtx(harness, "w020-atomic-policy"),
      world.campaign.id,
      world.campaign.currentPolicyVersion ?? 1,
    );
    const rule = policy.clearingRules[0]!;
    const drawn = await harness.runtime.rewardService.allocateRewards(
      operatorCtx(harness, "w020-atomic-draw"),
      {
        organizationScopeId: harness.organizationScopeId,
        sourceValueRecordId: world.value.id,
        policyId: rule.rewardPolicyId!,
        idempotencyKey: `${theKey}:draw`,
      },
    );
    expect(drawn.created).toBe(true);
    const auditsBefore = await auditCount("cross_promotion_clearing.recorded");

    // The REBUILT service whose authoritative COMMIT always fails.
    const failingAuthority: PostgresAuthority = {
      async begin(context: ExecutionContext) {
        return new CommitFailingTransaction(
          await harness.runtime.postgresAuthority.begin(context),
        );
      },
      async run<T>(
        context: ExecutionContext,
        work: (tx: AuthorityTransaction) => Promise<T>,
      ): Promise<T> {
        const tx = new CommitFailingTransaction(
          await harness.runtime.postgresAuthority.begin(context),
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
        return harness.runtime.postgresAuthority.get<T>(collection, key);
      },
      scan<T = unknown>(collection: string) {
        return harness.runtime.postgresAuthority.scan<T>(collection);
      },
      count(collection: string) {
        return harness.runtime.postgresAuthority.count(collection);
      },
      recover() {
        return harness.runtime.postgresAuthority.recover();
      },
      close() {
        return harness.runtime.postgresAuthority.close();
      },
    };
    const failingService = createCrossPromotionClearingService({
      clearingRepository: createAuthorityCrossPromotionClearingRepository({
        authority: failingAuthority,
      }),
      valueRepository: {
        findById: async (id: string) =>
          harness.runtime.economicValueService.getValue(
            operatorCtx(harness, "w020-atomic-value"),
            id,
          ),
        listByBeneficiary: async () => [],
        findByIdWithinTx: async (
          id: string,
          tx: AuthorityTransaction,
        ) => {
          const rec = await tx.get("economic_value_records", id);
          return rec ? rec.value : null;
        },
        createWithinTx: async () => {
          throw new Error("not used in this test");
        },
        saveWithinTx: async () => {
          throw new Error("not used in this test");
        },
      } as never,
      allocationRepository: {
        findById: async () => null,
        listByOrganization: async () => [],
        findByIdWithinTx: async (
          id: string,
          tx: AuthorityTransaction,
        ) => {
          const rec = await tx.get("reward_allocations", id);
          return rec ? rec.value : null;
        },
        createWithinTx: async () => {
          throw new Error("not used in this test");
        },
        saveWithinTx: async () => {
          throw new Error("not used in this test");
        },
      } as never,
      issuanceRepository: {
        findById: async () => null,
        listByBeneficiary: async () => [],
        findByIdWithinTx: async () => null,
        createWithinTx: async () => {
          throw new Error("not used in this test");
        },
        saveWithinTx: async () => {
          throw new Error("not used in this test");
        },
      } as never,
      obligationRepository: {
        findById: async () => null,
        listByOrganization: async () => [],
        findByIdWithinTx: async () => null,
        createWithinTx: async () => {
          throw new Error("not used in this test");
        },
        saveWithinTx: async () => {
          throw new Error("not used in this test");
        },
      } as never,
      lookups: rebuildLookups() as never,
      idempotency: createPostgresIdempotencyStore({
        authority: failingAuthority,
      }),
      auditWriter: createTransactionalAuditWriter({
        underlying: harness.runtime.auditWriter,
      }),
      logger: harness.runtime.logger.forModule("settlement"),
    });
    await expect(
      failingService.recordCrossPromotionClearing(
        operatorCtx(harness, "w020-atomic-record"),
        {
          organizationScopeId: harness.organizationScopeId,
          sourceContributionId: world.contribution.id,
          targetPlacementId: world.placement.id,
          valueRecordId: world.value.id,
          clearingRuleId: rule.id,
          drawKind: "reward_allocation",
          drawResultId: drawn.allocation.id,
          idempotencyKey: `${theKey}:record`,
        },
      ),
    ).rejects.toThrow("injected authoritative COMMIT failure");

    // NOTHING persisted: no clearing record for the pair, no audit
    // event (the partial-economic-mutation fence: the DRAW committed
    // — a complete, conserved primitive transaction — and the RECORD
    // contributed nothing).
    const clearings =
      await harness.runtime.crossPromotionClearingService.listCrossPromotionClearings(
        operatorCtx(harness, "w020-atomic-list"),
        harness.organizationScopeId,
      );
    expect(
      clearings.filter(
        (c) => c.sourceContributionId === world.contribution.id,
      ).length,
    ).toBe(0);
    expect(await auditCount("cross_promotion_clearing.recorded")).toBe(
      auditsBefore,
    );

    // The HEALTHY replay converges: the FULL composite with the same
    // key replays the identical draw and commits the record.
    const converged = await executeCrossPromotionClearing(harness, world, {
      idempotencyKey: theKey,
    });
    expect(converged.created).toBe(true);
    expect((converged.allocation as { id: string }).id).toBe(
      drawn.allocation.id,
    );
    // EXACTLY ONE allocation (no duplicated value) + ONE record + ONE
    // audit event.
    const allocations = await harness.runtime.rewardService.listAllocations(
      operatorCtx(harness, "w020-atomic-alloc"),
      harness.organizationScopeId,
    );
    expect(
      allocations.filter((a) => a.sourceValueRecordId === world.value.id)
        .length,
    ).toBe(1);
    const clearingsAfter =
      await harness.runtime.crossPromotionClearingService.listCrossPromotionClearings(
        operatorCtx(harness, "w020-atomic-list-2"),
        harness.organizationScopeId,
      );
    expect(
      clearingsAfter.filter(
        (c) => c.sourceContributionId === world.contribution.id,
      ).length,
    ).toBe(1);
    expect(
      await auditCount(
        "cross_promotion_clearing.recorded",
        (converged.clearing as { id: string }).id,
      ),
    ).toBe(1);
  });

  test("the audit event binds campaign + contribution + placement + clearing record + idempotency record + transactions (invariant 7)", async () => {
    const world = await createCrossPromotionWorld(harness, { amount: 100 });
    const result = await executeCrossPromotionClearing(harness, world);
    const clearing = result.clearing as {
      id: string;
      campaignId: string;
      sourceContributionId: string;
      targetPlacementId: string;
      drawTransactionId: string;
      drawResultId: string;
      idempotencyKey: string;
    };
    const events = await harness.runtime.auditWriter.query({
      eventType: "cross_promotion_clearing.recorded",
      resourceId: clearing.id,
    });
    expect(events.length).toBe(1);
    const metadata = events[0]!.metadata as Record<string, unknown>;
    expect(metadata.campaignId).toBe(world.campaign.id);
    expect(metadata.sourceContributionId).toBe(world.contribution.id);
    expect(metadata.targetPlacementId).toBe(world.placement.id);
    expect(metadata.valueRecordId).toBe(world.value.id);
    expect(metadata.drawTransactionId).toBe(clearing.drawTransactionId);
    expect(metadata.drawResultId).toBe(clearing.drawResultId);
    expect(metadata.idempotencyKey).toBe(clearing.idempotencyKey);
    expect(typeof metadata.idempotencyRecordId).toBe("string");
    expect((metadata.idempotencyRecordId as string).length).toBeGreaterThan(
      0,
    );
    expect(typeof metadata.transactionId).toBe("string");
    // The eligibility trace snapshot is bound too (the derived state
    // the clearing executed under).
    const checks = metadata.eligibilityChecks as string[];
    expect(checks.length).toBe(6);
    expect(checks.every((c) => c.endsWith(":satisfied"))).toBe(true);
  });

  test("the clearing record posts NOTHING to the ledger — its only ledger footprint is the draw's own transaction", async () => {
    const world = await createCrossPromotionWorld(harness, { amount: 40 });
    const entriesBefore = await harness.runtime.postgresAuthority.scan(
      "economic_ledger_entries",
    );
    const transactionsBefore = await harness.runtime.postgresAuthority.scan(
      "economic_ledger_transactions",
    );
    const result = await executeCrossPromotionClearing(harness, world);
    const clearing = result.clearing as {
      drawTransactionId: string;
    };
    const entriesAfter = await harness.runtime.postgresAuthority.scan(
      "economic_ledger_entries",
    );
    const transactionsAfter = await harness.runtime.postgresAuthority.scan(
      "economic_ledger_transactions",
    );
    // The reward draw posts exactly ONE transaction (2 entries: the
    // debit + the single-beneficiary credit).
    expect(transactionsAfter.length - transactionsBefore.length).toBe(1);
    expect(entriesAfter.length - entriesBefore.length).toBe(2);
    const newTransaction = transactionsAfter.find(
      (t) => !transactionsBefore.some((b) => b.key === t.key),
    )! as { key: string; value: { id: string } };
    expect(newTransaction.value.id).toBe(clearing.drawTransactionId);
  });
});
