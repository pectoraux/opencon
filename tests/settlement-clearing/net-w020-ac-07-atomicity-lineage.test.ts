/**
 * NET-W020-AC-07 — audit and transaction lineage are complete; an
 * authoritative commit failure leaves no partial economic mutation
 * (issue #39 AC-7; invariant 7; the PR #40 remediation regression).
 *
 * The WHOLE clearing operation commits in ONE authoritative
 * transaction — the economic draw (postings + allocation record +
 * exactly-once value consumption), the clearing record, the campaign
 * clearing bookkeeping, the idempotency record and every buffered
 * audit event TOGETHER OR NOT AT ALL.
 *
 * The COMPOSITE-LEVEL fault injection proves it (the PR #40 review's
 * required regression): the ACTUAL end-to-end clearing operation runs
 * against an authority whose COMMIT always fails — the economic draw
 * is fully staged INSIDE the transaction, then the authoritative
 * COMMIT is forced to fail — and NOTHING survives: no ledger
 * entries, no reward allocation, no value consumption, no clearing
 * record, no campaign bookkeeping event, no clearing audit event, no
 * idempotency record; the value remains in its pre-clearing state;
 * and the healthy retry with the SAME idempotency key succeeds
 * exactly once.
 *
 * The successful path proves the SAME AUTHORITATIVE TRANSACTION
 * LINEAGE: the clearing record's economic mutation, the campaign
 * bookkeeping and every audit event reference ONE transaction id and
 * ONE idempotency record.
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
import {
  createAuthorityRewardPolicyRepository,
} from "../../src/settlement/authority-reward-policy-repository.ts";
import { createCrossPromotionClearingService } from "../../src/settlement/clearing-service.ts";
import { campaignLockKey } from "../../src/campaigns/campaign-service.ts";
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
              detail: {
                action: control.action,
                operationClass: input.operationClass,
                recordSubjectId,
                originAssessmentId: control.originAssessmentId,
                originCaseId: control.originCaseId,
              },
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
            detail: {
              disputeState: active[0]!.state,
              disputeKind: active[0]!.kind,
              subjectType: active[0]!.subjectRef.subjectType,
              subjectId: active[0]!.subjectRef.subjectId,
            },
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

/**
 * Rebuild the CLEARING SERVICE (the atomic composite itself) over a
 * COMMIT-FAILING authority — the REAL runtime draw services
 * (their `...WithinTx` bodies stage through the caller's failing
 * transaction), the REAL campaign bookkeeping (same), the REAL
 * reward-policy repository (committed pin reads) and the real neutral
 * lookups. Every mutation the composite performs — the economic draw,
 * the clearing record, the campaign bookkeeping, the idempotency
 * record — flows through the FAILING transaction, so the forced
 * COMMIT failure exercises the ACTUAL end-to-end atomicity boundary.
 */
async function rebuildFailingClearingService(): Promise<
  ReturnType<typeof createCrossPromotionClearingService>
> {
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
  return createCrossPromotionClearingService({
    clearingRepository: createAuthorityCrossPromotionClearingRepository({
      authority: failingAuthority,
    }),
    valueRepository: {
      findById: async (id: string) =>
        harness.runtime.economicValueService.getValue(
          operatorCtx(harness, "w020-fault-value"),
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
    // The REAL draw services: their ...WithinTx bodies stage every
    // mutation on the caller's (failing) transaction.
    rewardService: harness.runtime.rewardService,
    creditService: harness.runtime.creditService,
    cashService: harness.runtime.cashService,
    rewardPolicyRepository: createAuthorityRewardPolicyRepository({
      authority: harness.runtime.postgresAuthority,
    }),
    // The REAL campaign bookkeeping on the caller's (failing)
    // transaction, through the same port shape the runtime wires.
    campaignBookkeeping: {
      async recordClearingExecutionWithinTx(execution, input, ctx) {
        const updated =
          await harness.runtime.campaignService.recordClearingExecutionWithinTx(
            execution,
            {
              campaignId: input.campaignId,
              clearingRuleId: input.clearingRuleId,
              drawKind: input.drawKind,
              valueRecordId: input.valueRecordId,
              resultId: input.resultId,
              amount: input.amount,
              description: input.description,
              idempotencyKey: input.idempotencyKey,
            },
            ctx,
          );
        return {
          campaignId: updated.id,
          eventCount: updated.events.length,
        };
      },
      bookkeepingLockKey(campaignId: string) {
        return campaignLockKey(campaignId);
      },
    },
    idempotency: createPostgresIdempotencyStore({
      authority: failingAuthority,
    }),
    auditWriter: createTransactionalAuditWriter({
      underlying: harness.runtime.auditWriter,
    }),
    logger: harness.runtime.logger.forModule("settlement"),
  });
}

describe("NET-W020-AC-07 atomicity + lineage", () => {
  test("THE COMPOSITE-LEVEL FAULT INJECTION: the authoritative COMMIT fails AFTER the economic draw is staged → NOTHING persists; the same-key retry succeeds exactly once", async () => {
    const world = await createCrossPromotionWorld(harness, { amount: 100 });
    const theKey = key("w020-atomic");

    // The pre-clearing state (the value is MATURE, nothing drawn).
    const entriesBefore = await harness.runtime.postgresAuthority.scan(
      "economic_ledger_entries",
    );
    const transactionsBefore = await harness.runtime.postgresAuthority.scan(
      "economic_ledger_transactions",
    );
    const idempotencyBefore = await harness.runtime.postgresAuthority.scan(
      "idempotency",
    );
    const auditClearingBefore = await auditCount("cross_promotion_clearing.recorded");
    const auditDrawBefore = await auditCount("reward_allocation.recorded");
    const auditCampaignBefore = await auditCount("campaign.clearing_executed");

    // The ACTUAL end-to-end clearing operation against the
    // COMMIT-FAILING stack: the gates pass, the eligibility
    // re-derives, THE ECONOMIC DRAW IS FULLY STAGED inside the
    // single authoritative transaction (postings + allocation record
    // + value consumption), the clearing record is created, the
    // campaign bookkeeping is appended — and the authoritative COMMIT
    // is forced to fail.
    const failingService = await rebuildFailingClearingService();
    await expect(
      failingService.executeCrossPromotionClearing(
        operatorCtx(harness, "w020-atomic-execute"),
        {
          sourceContributionId: world.contribution.id,
          targetPlacementId: world.placement.id,
          valueRecordId: world.value.id,
          idempotencyKey: theKey,
        },
      ),
    ).rejects.toThrow("injected authoritative COMMIT failure");

    // ---- NOTHING persisted (all simultaneously) --------------------
    // (a) no clearing record for the pair;
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
    // (b) no reward allocation for the value;
    const allocations = await harness.runtime.rewardService.listAllocations(
      operatorCtx(harness, "w020-atomic-alloc"),
      harness.organizationScopeId,
    );
    expect(
      allocations.filter((a) => a.sourceValueRecordId === world.value.id)
        .length,
    ).toBe(0);
    // (c) no economic ledger entries/transactions from the clearing;
    const entriesAfter = await harness.runtime.postgresAuthority.scan(
      "economic_ledger_entries",
    );
    const transactionsAfter = await harness.runtime.postgresAuthority.scan(
      "economic_ledger_transactions",
    );
    expect(entriesAfter.length).toBe(entriesBefore.length);
    expect(transactionsAfter.length).toBe(transactionsBefore.length);
    // (d) no campaign clearing bookkeeping event;
    const campaignAfterFailure =
      await harness.runtime.campaignService.getCampaign(
        operatorCtx(harness, "w020-atomic-campaign"),
        world.campaign.id,
      );
    expect(
      campaignAfterFailure.events.filter((e) => e.event === "clearing_executed")
        .length,
    ).toBe(0);
    // (e) no clearing audit event, no draw audit event, no campaign
    // bookkeeping audit event;
    expect(await auditCount("cross_promotion_clearing.recorded")).toBe(
      auditClearingBefore,
    );
    expect(await auditCount("reward_allocation.recorded")).toBe(
      auditDrawBefore,
    );
    expect(await auditCount("campaign.clearing_executed")).toBe(
      auditCampaignBefore,
    );
    // (f) no idempotency record for the composite key;
    const idempotencyAfter = await harness.runtime.postgresAuthority.scan(
      "idempotency",
    );
    expect(idempotencyAfter.length).toBe(idempotencyBefore.length);
    // (g) the value remains in its PRE-CLEARING state (MATURE,
    // unconsumed — exactly the pre-clearing amount).
    const valueAfterFailure =
      await harness.runtime.economicValueService.getValue(
        operatorCtx(harness, "w020-atomic-value"),
        world.value.id,
      );
    expect(valueAfterFailure.state).toBe("MATURE");
    expect(valueAfterFailure.amount).toBe(100);

    // ---- THE RETRY with the SAME idempotency key succeeds exactly
    // once: the whole unit re-executes on the healthy stack and
    // commits atomically.
    const converged = await executeCrossPromotionClearing(harness, world, {
      idempotencyKey: theKey,
    });
    expect(converged.created).toBe(true);
    expect((converged.value as { state: string }).state).toBe("CONSUMED");
    // EXACTLY ONE allocation + ONE clearing record + ONE campaign
    // bookkeeping event + ONE audit event of each kind.
    const allocationsAfterRetry =
      await harness.runtime.rewardService.listAllocations(
        operatorCtx(harness, "w020-atomic-alloc-2"),
        harness.organizationScopeId,
      );
    expect(
      allocationsAfterRetry.filter(
        (a) => a.sourceValueRecordId === world.value.id,
      ).length,
    ).toBe(1);
    const clearingsAfterRetry =
      await harness.runtime.crossPromotionClearingService.listCrossPromotionClearings(
        operatorCtx(harness, "w020-atomic-list-2"),
        harness.organizationScopeId,
      );
    expect(
      clearingsAfterRetry.filter(
        (c) => c.sourceContributionId === world.contribution.id,
      ).length,
    ).toBe(1);
    const campaignAfterRetry =
      await harness.runtime.campaignService.getCampaign(
        operatorCtx(harness, "w020-atomic-campaign-2"),
        world.campaign.id,
      );
    expect(
      campaignAfterRetry.events.filter((e) => e.event === "clearing_executed")
        .length,
    ).toBe(1);
    expect(
      await auditCount(
        "cross_promotion_clearing.recorded",
        (converged.clearing as { id: string }).id,
      ),
    ).toBe(1);
    expect(
      await auditCount("reward_allocation.recorded"),
    ).toBe(auditDrawBefore + 1);
    expect(
      await auditCount("campaign.clearing_executed"),
    ).toBe(auditCampaignBefore + 1);

    // ---- The SAME-KEY replay after the successful retry returns the
    // IDENTICAL committed outcome (exactly-once: created:false, same
    // clearing id, same allocation id, no new draw).
    const replay = await executeCrossPromotionClearing(harness, world, {
      idempotencyKey: theKey,
    });
    expect(replay.created).toBe(false);
    expect((replay.clearing as { id: string }).id).toBe(
      (converged.clearing as { id: string }).id,
    );
    expect((replay.allocation as { id: string }).id).toBe(
      (converged.allocation as { id: string }).id,
    );
    const allocationsAfterReplay =
      await harness.runtime.rewardService.listAllocations(
        operatorCtx(harness, "w020-atomic-alloc-3"),
        harness.organizationScopeId,
      );
    expect(
      allocationsAfterReplay.filter(
        (a) => a.sourceValueRecordId === world.value.id,
      ).length,
    ).toBe(1);
  });

  test("THE SAME AUTHORITATIVE TRANSACTION LINEAGE: the clearing record, the economic draw, the campaign bookkeeping and every audit event reference ONE transaction + ONE idempotency record", async () => {
    const world = await createCrossPromotionWorld(harness, { amount: 100 });
    const result = await executeCrossPromotionClearing(harness, world);
    const clearing = result.clearing as {
      id: string;
      campaignId: string;
      sourceContributionId: string;
      targetPlacementId: string;
      valueRecordId: string;
      drawTransactionId: string;
      drawResultId: string;
      idempotencyKey: string;
    };
    const allocation = result.allocation as { id: string };
    expect(allocation.id).toBe(clearing.drawResultId);

    // The audit events from the ONE transaction: the draw's, the
    // clearing record's and the campaign bookkeeping's.
    const drawEvents = await harness.runtime.auditWriter.query({
      eventType: "reward_allocation.recorded",
      resourceId: allocation.id,
    });
    expect(drawEvents.length).toBe(1);
    const clearingEvents = await harness.runtime.auditWriter.query({
      eventType: "cross_promotion_clearing.recorded",
      resourceId: clearing.id,
    });
    expect(clearingEvents.length).toBe(1);
    const campaignEvents = await harness.runtime.auditWriter.query({
      eventType: "campaign.clearing_executed",
      resourceId: clearing.campaignId,
    });
    const campaignEvent = campaignEvents.find(
      (e) =>
        (e.metadata as Record<string, unknown>).resultId ===
        clearing.drawResultId,
    );
    expect(campaignEvent).toBeDefined();

    const drawMetadata = drawEvents[0]!.metadata as Record<string, unknown>;
    const clearingMetadata = clearingEvents[0]!.metadata as Record<
      string,
      unknown
    >;
    const bookkeepingMetadata = campaignEvent!.metadata as Record<
      string,
      unknown
    >;

    // THE SAME authoritative transaction: every mutation and every
    // audit event carries the SAME transaction id.
    const transactionId = clearingMetadata.transactionId as string;
    expect(typeof transactionId).toBe("string");
    expect(drawMetadata.transactionId).toBe(transactionId);
    expect(bookkeepingMetadata.transactionId).toBe(transactionId);
    // THE SAME idempotency record: the composite's record deduplicated
    // the WHOLE unit (the draw's audit, the clearing record's audit
    // and the bookkeeping's audit all reference it).
    const idempotencyRecordId = clearingMetadata.idempotencyRecordId as string;
    expect(typeof idempotencyRecordId).toBe("string");
    expect(drawMetadata.idempotencyRecordId).toBe(idempotencyRecordId);
    expect(bookkeepingMetadata.idempotencyRecordId).toBe(idempotencyRecordId);
    // The clearing record's ledger footprint is EXACTLY the draw's
    // own transaction (posted inside the same authoritative tx).
    expect(clearing.drawTransactionId).toBe(
      drawMetadata.ledgerTransactionId as string,
    );
    expect(clearingMetadata.drawTransactionId).toBe(clearing.drawTransactionId);

    // The full lineage binding (invariant 7): campaign +
    // contribution + placement + clearing record + idempotency
    // record + authoritative transaction + draw transaction.
    expect(clearingMetadata.campaignId).toBe(world.campaign.id);
    expect(clearingMetadata.sourceContributionId).toBe(
      world.contribution.id,
    );
    expect(clearingMetadata.targetPlacementId).toBe(world.placement.id);
    expect(clearingMetadata.valueRecordId).toBe(world.value.id);
    expect(clearingMetadata.drawTransactionId).toBe(clearing.drawTransactionId);
    expect(clearingMetadata.drawResultId).toBe(clearing.drawResultId);
    expect(clearingMetadata.idempotencyKey).toBe(clearing.idempotencyKey);
    // The eligibility trace snapshot is bound too (the derived state
    // the clearing executed under).
    const checks = clearingMetadata.eligibilityChecks as string[];
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
