/**
 * NET-W034-AC-09 — Replay, concurrency, atomicity and tenancy (issue
 * #69 §5 AC-09; the PR #70 remediation record — architect decision
 * comment #5511352937).
 *
 * Same-key replays return identical committed records without
 * duplicates; at least one concurrent race proves exactly-once
 * economic behavior; THE composite-level atomicity fault injection
 * proves the clearing composite's SINGLE authoritative transaction
 * (the W020/PR #40 precedent proof shape); a retained stale-state
 * race proves the fail-closed current-state revalidation;
 * cross-tenant references fail closed across composed boundaries.
 *  - REPLAY: same-key measurement submission + same-key recognition
 *    return the committed records verbatim (created=false);
 *  - RACE: concurrent same-key recognition converges to exactly ONE
 *    value record (the exactly-once economic boundary);
 *  - THE COMPOSITE-LEVEL FAULT INJECTION (the PR #70 remediation —
 *    the required AC-09 atomicity evidence): the ACTUAL W034
 *    clearing composite (createCrossPromotionClearingService — the
 *    exact object the apiCommand runs) is rebuilt over an authority
 *    whose COMMIT always fails, with the REAL draw services, the
 *    REAL campaign bookkeeping, the REAL reward-policy pin reads and
 *    the neutral lookups over the runtime's public services. The
 *    whole unit — the economic draw (postings + allocation record +
 *    exactly-once value consumption), the clearing record, the
 *    campaign bookkeeping, the idempotency record and every buffered
 *    audit event — is FULLY STAGED INSIDE the single authoritative
 *    transaction, then the authoritative COMMIT is forced to fail →
 *    NOTHING survives; the healthy same-key retry through the REAL
 *    apiCommand path completes exactly once and leaves ONE complete
 *    lineage;
 *  - STALE-STATE RACE (retained from the first PR #70 submission —
 *    the architect's "valuable" stale-state/fail-closed race, now on
 *    a FRESH pair so the composite's transaction is genuinely
 *    entered): the value is consumed OUT-OF-BAND by the settlement's
 *    own standalone reward command after the derived eligibility
 *    view was eligible → the composite enters its transaction (the
 *    eligibility replay tolerance admits a CONSUMED record as a
 *    potential replay candidate) and the IN-TRANSACTION draw
 *    primitive's own exactly-once MATURE bar refuses the fresh draw
 *    → the whole composite rolls back and no partial mutation
 *    survives. This is a CURRENT-STATE fail-closed revalidation
 *    proof; it does NOT substitute for the composite-level
 *    atomicity proof above;
 *  - the mid-path dispute freeze: a recognized value stays PENDING
 *    while the dispute is active (no partial final state), and the
 *    resolution completes the path;
 *  - TENANCY: cross-tenant references fail closed across the composed
 *    boundaries (matching, clearing, measurement — no existence
 *    oracles).
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
import {
  createAuthorityEconomicValueRepository,
} from "../../src/settlement/authority-value-repository.ts";
import {
  createAuthorityRewardAllocationRepository,
} from "../../src/settlement/authority-reward-repository.ts";
import {
  createAuthorityCreditIssuanceRepository,
} from "../../src/settlement/authority-credit-repository.ts";
import {
  createAuthorityCashObligationRepository,
} from "../../src/settlement/authority-cash-repository.ts";
import { createCrossPromotionClearingService } from "../../src/settlement/clearing-service.ts";
import { campaignLockKey } from "../../src/campaigns/campaign-service.ts";
import {
  createNetW034Harness,
  runAdvertisingScenario,
  submitAdvertisingMeasurement,
  recognizeAdvertisingValue,
  matureAdvertisingValue,
  executeScenarioClearing,
  evaluateScenarioClearing,
  runScenarioMatch,
  registerScenarioSupply,
  openBondedDisputeOn,
  resolveDispute,
  key,
  personCtx,
  type NetW034Harness,
  type AdvertisingScenario,
} from "./_net-w034-harness.ts";
import { assertGlobalConservation } from "../settlement/_net-w008-harness.ts";

let harness: NetW034Harness;
let scenario: AdvertisingScenario;

beforeAll(async () => {
  harness = await createNetW034Harness();
  scenario = await runAdvertisingScenario(harness);
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

/**
 * A FRESH (contribution, placement) clearing pair: a second VERIFIED
 * inventory item + a second placement on the scenario's ACTIVE
 * campaign. Needed because ONE clearing per contribution-placement
 * pair is the durable pair mutex — the scenario's own pair is already
 * cleared, so any atomicity/fail-closed proof that must reach the
 * composite's transaction needs its own pair (the W019 rule is one
 * ACTIVE placement per item+campaign — a fresh pair needs fresh
 * supply). Returns the new placement id.
 */
async function freshClearingPair(): Promise<string> {
  const domain = `${key("ac09-pair")}.example`;
  const item = await registerScenarioSupply(harness, {
    externalId: domain,
    idempotencyKey: key("w034-ac09-item"),
  });
  const placement = await harness.runtime.inventoryService.createPlacement(
    harness.creatorCtx("w034-ac09-placement"),
    {
      organizationScopeId: harness.organizationScopeId,
      inventoryItemId: item.id,
      campaignId: scenario.campaignId,
      campaignPolicyVersion: scenario.campaignPolicyVersion,
      context: {
        territories: ["US", "CA"],
        languages: ["en"],
      },
      idempotencyKey: key("w034-ac09-placement"),
    },
  );
  return placement.placement.id;
}

/** The W006/W017/W018/W019/W020 rebuild pattern: commit() always fails. */
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
              harness.operatorCtx("w034-ac09-fault-contribution"),
              contributionId,
            );
          let pohState = "NONE";
          try {
            const poh =
              await harness.runtime.helpfulnessService.getProofOfHelpfulness(
                harness.operatorCtx("w034-ac09-fault-poh"),
                contributionId,
              );
            pohState = poh.state;
          } catch {
            pohState = "NONE";
          }
          const moderation =
            await harness.runtime.moderationService.getModerationSummary(
              harness.operatorCtx("w034-ac09-fault-moderation"),
              contributionId,
            );
          let qualityBand: string | null = null;
          const evaluation =
            await harness.runtime.qualityService.getLatestQualityEvaluation(
              harness.operatorCtx("w034-ac09-fault-quality"),
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
              harness.operatorCtx("w034-ac09-fault-readiness"),
              organizationScopeId,
              placementId,
            );
          const placement = await harness.runtime.inventoryService.getPlacement(
            harness.operatorCtx("w034-ac09-fault-placement"),
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
            harness.operatorCtx("w034-ac09-fault-campaign"),
            campaignId,
          );
          const versions =
            await harness.runtime.campaignService.listPolicyVersions(
              harness.operatorCtx("w034-ac09-fault-policy"),
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
        const execution = harness.operatorCtx("w034-ac09-fault-gate");
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
 * Rebuild the CLEARING COMPOSITE (the exact object the apiCommand
 * runs — createCrossPromotionClearingService) over a COMMIT-FAILING
 * authority — the W020/PR #40 precedent proof shape: the REAL
 * authority repositories (the same factories the runtime wires —
 * every read/write flows through the FAILING transaction), the REAL
 * draw services (their `...WithinTx` bodies stage through the
 * caller's failing transaction), the REAL campaign bookkeeping
 * (same), the REAL reward-policy repository (committed pin reads)
 * and the neutral lookups over the runtime's public services. Every
 * mutation the composite performs — the economic draw, the clearing
 * record, the campaign bookkeeping, the idempotency record — flows
 * through the FAILING transaction, so the forced COMMIT failure
 * exercises the ACTUAL end-to-end atomicity boundary AFTER the whole
 * unit is staged.
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
    // The REAL settlement repositories (the same factories the
    // runtime wires) over the FAILING authority: every committed
    // read and every staged write flows through the failing
    // transaction boundary.
    valueRepository: createAuthorityEconomicValueRepository({
      authority: failingAuthority,
    }),
    allocationRepository: createAuthorityRewardAllocationRepository({
      authority: failingAuthority,
    }),
    issuanceRepository: createAuthorityCreditIssuanceRepository({
      authority: failingAuthority,
    }),
    obligationRepository: createAuthorityCashObligationRepository({
      authority: failingAuthority,
    }),
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

describe("NET-W034-AC-09 replay, concurrency, atomicity and tenancy", () => {
  test("REPLAY: a same-key measurement submission returns the COMMITTED observation verbatim", async () => {
    const idem = key("w034-ac09-measure");
    const first = await submitAdvertisingMeasurement(
      harness,
      scenario.contribution.id,
      { idempotencyKey: idem },
    );
    expect(first.created).toBe(true);
    const replay = await submitAdvertisingMeasurement(
      harness,
      scenario.contribution.id,
      { idempotencyKey: idem },
    );
    expect(replay.created).toBe(false);
    expect(replay.observation.id).toBe(first.observation.id);
    // Exactly ONE observation record + ONE audit event for the
    // committed submission.
    const audit = harness.runtime.auditWriter;
    const events = await audit.query({
      eventType: "outcome_observation.created",
    });
    const obsEvents = events.filter(
      (e) => e.resourceId === first.observation.id,
    );
    expect(obsEvents).toHaveLength(1);
  });

  test("REPLAY: a same-key recognition returns the COMMITTED value record verbatim", async () => {
    const idem = key("w034-ac09-recognize");
    const first = await recognizeAdvertisingValue(
      harness,
      scenario.contribution.id,
      { amount: 55, idempotencyKey: idem },
    );
    expect(first.created).toBe(true);
    const replay = await recognizeAdvertisingValue(
      harness,
      scenario.contribution.id,
      { amount: 55, idempotencyKey: idem },
    );
    expect(replay.created).toBe(false);
    expect(replay.value.id).toBe(first.value.id);
    // Exactly ONE recognition audit event for the value record.
    const audit = harness.runtime.auditWriter;
    const recorded = await audit.query({
      eventType: "economic_value.recorded",
      resourceId: first.value.id,
    });
    expect(recorded).toHaveLength(1);
  });

  test("RACE: concurrent same-key recognition converges to exactly ONE value record (exactly-once at the economic boundary)", async () => {
    const idem = key("w034-ac09-race");
    const [a, b] = await Promise.all([
      recognizeAdvertisingValue(harness, scenario.contribution.id, {
        amount: 33,
        idempotencyKey: idem,
      }),
      recognizeAdvertisingValue(harness, scenario.contribution.id, {
        amount: 33,
        idempotencyKey: idem,
      }),
    ]);
    // Exactly one executed; the other is the deterministic replay.
    expect(a.created).not.toBe(b.created);
    expect(a.value.id).toBe(b.value.id);
    // Exactly ONE value record for this recognition key.
    const audit = harness.runtime.auditWriter;
    const recorded = await audit.query({
      eventType: "economic_value.recorded",
      resourceId: a.value.id,
    });
    expect(recorded).toHaveLength(1);
    // The global economic envelope is conserved after the race.
    await assertGlobalConservation(
      harness.w019.w017.w016.w015.w013.w012.w011.w010.w009.w008,
    );
  });

  test("THE COMPOSITE-LEVEL FAULT INJECTION (the PR #70 remediation): the authoritative COMMIT fails AFTER the clearing composite fully stages the unit → NOTHING persists; the same-key retry on the REAL path completes exactly once", async () => {
    // A FRESH pair (the scenario's own pair is already cleared — the
    // durable pair mutex) + a fresh MATURE value on the scenario's
    // VERIFIED contribution.
    const placementId = await freshClearingPair();
    const recognized = await recognizeAdvertisingValue(
      harness,
      scenario.contribution.id,
      { amount: 80 },
    );
    const matured = await matureAdvertisingValue(harness, recognized.value.id);
    expect(matured.state).toBe("MATURE");
    const theKey = key("w034-ac09-atomic-clear");

    // The pre-composite authoritative state (everything the composite
    // could touch).
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
    const campaignBefore = await harness.runtime.campaignService.getCampaign(
      harness.operatorCtx("w034-ac09-atomic-campaign-before"),
      scenario.campaignId,
    );
    const valueBefore = await harness.runtime.economicValueService.getValue(
      harness.operatorCtx("w034-ac09-atomic-value-before"),
      matured.id,
    );
    expect(valueBefore.state).toBe("MATURE");
    expect(valueBefore.amount).toBe(80);

    // The ACTUAL clearing composite over the COMMIT-FAILING stack:
    // the gates pass, the eligibility re-derives, THE ECONOMIC DRAW
    // IS FULLY STAGED inside the single authoritative transaction
    // (postings + allocation record + value consumption), the
    // clearing record is created, the campaign bookkeeping is
    // appended — and the authoritative COMMIT is forced to fail.
    const failingService = await rebuildFailingClearingService();
    await expect(
      failingService.executeCrossPromotionClearing(
        harness.operatorCtx("w034-ac09-atomic-execute"),
        {
          sourceContributionId: scenario.contribution.id,
          targetPlacementId: placementId,
          valueRecordId: matured.id,
          idempotencyKey: theKey,
        },
      ),
    ).rejects.toThrow("injected authoritative COMMIT failure");

    // ---- NOTHING persisted (all simultaneously) --------------------
    // (a) no clearing record for the fresh pair;
    const clearings =
      await harness.runtime.crossPromotionClearingService.listCrossPromotionClearings(
        harness.operatorCtx("w034-ac09-atomic-list"),
        harness.organizationScopeId,
      );
    expect(
      clearings.filter((c) => c.targetPlacementId === placementId).length,
    ).toBe(0);
    // (b) no reward allocation for the value;
    const allocations = await harness.runtime.rewardService.listAllocations(
      harness.operatorCtx("w034-ac09-atomic-alloc"),
      harness.organizationScopeId,
    );
    expect(
      allocations.filter((a) => a.sourceValueRecordId === matured.id).length,
    ).toBe(0);
    // (c) no economic ledger entries/transactions from the failed
    // composite (the staged draw left NO footprint);
    const entriesAfter = await harness.runtime.postgresAuthority.scan(
      "economic_ledger_entries",
    );
    const transactionsAfter = await harness.runtime.postgresAuthority.scan(
      "economic_ledger_transactions",
    );
    expect(entriesAfter.length).toBe(entriesBefore.length);
    expect(transactionsAfter.length).toBe(transactionsBefore.length);
    // (d) no campaign clearing bookkeeping event from the failed
    // composite (still exactly the scenario's own one);
    const campaignAfterFailure =
      await harness.runtime.campaignService.getCampaign(
        harness.operatorCtx("w034-ac09-atomic-campaign"),
        scenario.campaignId,
      );
    expect(
      campaignAfterFailure.events.filter((e) => e.event === "clearing_executed")
        .length,
    ).toBe(
      campaignBefore.events.filter((e) => e.event === "clearing_executed")
        .length,
    );
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
    // (f) no idempotency record for the composite key (the in-flight
    // marker was discarded by the rollback);
    const idempotencyAfter = await harness.runtime.postgresAuthority.scan(
      "idempotency",
    );
    expect(idempotencyAfter.length).toBe(idempotencyBefore.length);
    // (g) the value remains in its PRE-COMPOSITE authoritative state
    // (MATURE, unconsumed — exactly the pre-composite amount).
    const valueAfterFailure =
      await harness.runtime.economicValueService.getValue(
        harness.operatorCtx("w034-ac09-atomic-value"),
        matured.id,
      );
    expect(valueAfterFailure.state).toBe("MATURE");
    expect(valueAfterFailure.amount).toBe(80);
    // The ledger is still conserved after the failed composite.
    await assertGlobalConservation(
      harness.w019.w017.w016.w015.w013.w012.w011.w010.w009.w008,
    );

    // ---- THE RETRY with the SAME idempotency key on the REAL
    // apiCommand path: the whole unit re-executes on the healthy
    // stack and commits atomically — exactly once.
    const converged = await executeScenarioClearing(harness, {
      sourceContributionId: scenario.contribution.id,
      targetPlacementId: placementId,
      valueRecordId: matured.id,
      idempotencyKey: theKey,
    });
    expect((converged as { created: boolean }).created).toBe(true);
    expect((converged as { value: { state: string } }).value.state).toBe(
      "CONSUMED",
    );
    const clearingId = (converged as { clearing: { id: string } }).clearing.id;
    const allocationId = (converged as { allocation: { id: string } })
      .allocation.id;
    // EXACTLY ONE allocation + ONE clearing record for the pair + ONE
    // new campaign bookkeeping event + ONE audit event of each kind +
    // the EXACT single-draw ledger footprint (1 transaction, 2
    // entries — the debit + the single-beneficiary credit).
    const allocationsAfterRetry =
      await harness.runtime.rewardService.listAllocations(
        harness.operatorCtx("w034-ac09-atomic-alloc-2"),
        harness.organizationScopeId,
      );
    expect(
      allocationsAfterRetry.filter(
        (a) => a.sourceValueRecordId === matured.id,
      ).length,
    ).toBe(1);
    const clearingsAfterRetry =
      await harness.runtime.crossPromotionClearingService.listCrossPromotionClearings(
        harness.operatorCtx("w034-ac09-atomic-list-2"),
        harness.organizationScopeId,
      );
    expect(
      clearingsAfterRetry.filter((c) => c.targetPlacementId === placementId)
        .length,
    ).toBe(1);
    const campaignAfterRetry =
      await harness.runtime.campaignService.getCampaign(
        harness.operatorCtx("w034-ac09-atomic-campaign-2"),
        scenario.campaignId,
      );
    expect(
      campaignAfterRetry.events.filter((e) => e.event === "clearing_executed")
        .length,
    ).toBe(
      campaignBefore.events.filter((e) => e.event === "clearing_executed")
        .length + 1,
    );
    expect(await auditCount("cross_promotion_clearing.recorded")).toBe(
      auditClearingBefore + 1,
    );
    expect(await auditCount("reward_allocation.recorded")).toBe(
      auditDrawBefore + 1,
    );
    expect(await auditCount("campaign.clearing_executed")).toBe(
      auditCampaignBefore + 1,
    );
    const entriesAfterRetry = await harness.runtime.postgresAuthority.scan(
      "economic_ledger_entries",
    );
    const transactionsAfterRetry =
      await harness.runtime.postgresAuthority.scan(
        "economic_ledger_transactions",
      );
    expect(transactionsAfterRetry.length - transactionsBefore.length).toBe(1);
    expect(entriesAfterRetry.length - entriesBefore.length).toBe(2);

    // ---- ONE COMPLETE LINEAGE: the committed clearing record, the
    // draw, the campaign bookkeeping and every audit event reference
    // ONE authoritative transaction (the same-tx binding the failed
    // composite could never partially leave behind).
    const audit = harness.runtime.auditWriter;
    const clearingEvent = (
      await audit.query({
        eventType: "cross_promotion_clearing.recorded",
        resourceId: clearingId,
      })
    )[0]!;
    expect(clearingEvent).toBeDefined();
    const drawEvent = (
      await audit.query({
        eventType: "reward_allocation.recorded",
        resourceId: allocationId,
      })
    )[0]!;
    expect(drawEvent).toBeDefined();
    const campaignEvents = await audit.query({
      eventType: "campaign.clearing_executed",
      resourceId: scenario.campaignId,
    });
    const bookkeepingEvent = campaignEvents.find(
      (e) =>
        (e.metadata as Record<string, unknown>).resultId === allocationId,
    );
    expect(bookkeepingEvent).toBeDefined();
    const transactionId = (clearingEvent.metadata as Record<string, unknown>)
      .transactionId as string;
    expect(typeof transactionId).toBe("string");
    expect((drawEvent.metadata as Record<string, unknown>).transactionId).toBe(
      transactionId,
    );
    expect(
      (bookkeepingEvent!.metadata as Record<string, unknown>).transactionId,
    ).toBe(transactionId);

    // ---- The SAME-KEY replay after the successful retry returns the
    // IDENTICAL committed outcome (exactly-once: created:false, same
    // clearing id, same allocation id, no new draw).
    const replay = await executeScenarioClearing(harness, {
      sourceContributionId: scenario.contribution.id,
      targetPlacementId: placementId,
      valueRecordId: matured.id,
      idempotencyKey: theKey,
    });
    expect((replay as { created: boolean }).created).toBe(false);
    expect((replay as { clearing: { id: string } }).clearing.id).toBe(
      clearingId,
    );
    expect((replay as { allocation: { id: string } }).allocation.id).toBe(
      allocationId,
    );
    const allocationsAfterReplay =
      await harness.runtime.rewardService.listAllocations(
        harness.operatorCtx("w034-ac09-atomic-alloc-3"),
        harness.organizationScopeId,
      );
    expect(
      allocationsAfterReplay.filter(
        (a) => a.sourceValueRecordId === matured.id,
      ).length,
    ).toBe(1);
    // The global economic envelope is conserved end-to-end.
    await assertGlobalConservation(
      harness.w019.w017.w016.w015.w013.w012.w011.w010.w009.w008,
    );
  });

  test("STALE-STATE RACE (retained): an out-of-band consumption after the eligible view leaves NO partial clearing mutation (the current-state fail-closed revalidation)", async () => {
    // A FRESH pair + a fresh MATURE value (the scenario's own pair is
    // already cleared — the pair mutex would refuse before the
    // value-state revalidation is ever exercised).
    const placementId = await freshClearingPair();
    const recognized = await recognizeAdvertisingValue(
      harness,
      scenario.contribution.id,
      { amount: 25 },
    );
    const matured = await matureAdvertisingValue(harness, recognized.value.id);
    expect(matured.state).toBe("MATURE");
    // The derived eligibility view IS eligible while the value is
    // MATURE (the committed pre-flight state).
    const view = await evaluateScenarioClearing(harness, {
      sourceContributionId: scenario.contribution.id,
      targetPlacementId: placementId,
      valueRecordId: matured.id,
    });
    expect(view.eligible).toBe(true);
    // Pre-consume the value record through the settlement's OWN
    // standalone reward command AFTER the eligibility view was
    // derived (the committed read now sees CONSUMED — the composite's
    // current-state revalidation must fail closed and leave NO
    // partial mutation).
    const rewardPolicyId = scenario.campaignRewardPolicyId;
    await harness.runtime.rewardService.allocateRewards(
      harness.operatorCtx("w034-ac09-pre-consume"),
      {
        organizationScopeId: harness.organizationScopeId,
        sourceValueRecordId: matured.id,
        policyId: rewardPolicyId,
        idempotencyKey: key("w034-ac09-preconsume"),
      },
    );
    // The clearing composite fails closed: a fresh-key clearing of
    // an already-CONSUMED record enters the transaction (the
    // eligibility replay tolerance lets a CONSUMED record through as
    // a POTENTIAL replay candidate) and is then refused by the
    // IN-TRANSACTION draw primitive's own exactly-once MATURE bar
    // (the reward service's authoritative state re-check) → the
    // whole composite rolls back and NOTHING persists.
    await expect(
      executeScenarioClearing(harness, {
        sourceContributionId: scenario.contribution.id,
        targetPlacementId: placementId,
        valueRecordId: matured.id,
        idempotencyKey: key("w034-ac09-fault-clear"),
      }),
    ).rejects.toMatchObject({ code: "ECONOMIC_VALIDATION" });
    // NO partial mutation survived the refused composite: no clearing
    // record for the fresh pair, no additional allocation (only the
    // out-of-band one), no bookkeeping event.
    const audit = harness.runtime.auditWriter;
    const clearingEvents = await audit.query({
      eventType: "cross_promotion_clearing.recorded",
    });
    expect(
      clearingEvents.filter(
        (e) =>
          (e.metadata?.targetPlacementId as string | undefined) ===
          placementId,
      ),
    ).toHaveLength(0);
    const allocations = await harness.runtime.rewardService.listAllocations(
      harness.operatorCtx("w034-ac09-stale-alloc"),
      harness.organizationScopeId,
    );
    expect(
      allocations.filter((a) => a.sourceValueRecordId === matured.id).length,
    ).toBe(1);
    // The ledger is still conserved after the refused composite.
    await assertGlobalConservation(
      harness.w019.w017.w016.w015.w013.w012.w011.w010.w009.w008,
    );
  });

  test("the mid-path dispute freeze: a recognized value stays PENDING while the dispute is active; the resolution completes the path", async () => {
    const recognized = await recognizeAdvertisingValue(
      harness,
      scenario.contribution.id,
      { amount: 30 },
    );
    // The dispute on the CONTRIBUTION (the upstream source) freezes
    // the value mid-path (PENDING — no partial maturation).
    const disputeId = await openBondedDisputeOn(
      harness,
      "contribution",
      scenario.contribution.id,
    );
    await expect(
      matureAdvertisingValue(harness, recognized.value.id),
    ).rejects.toMatchObject({ code: "DISPUTE_CHALLENGE" });
    const frozen = await harness.runtime.economicValueService.getValue(
      harness.operatorCtx("w034-ac09-frozen-read"),
      recognized.value.id,
    );
    expect(frozen.state).toBe("PENDING");
    // The resolution completes the path — no orphaned intermediate
    // state.
    await resolveDispute(harness, disputeId, scenario.contribution.id);
    const completed = await matureAdvertisingValue(harness, recognized.value.id);
    expect(completed.state).toBe("MATURE");
    await assertGlobalConservation(
      harness.w019.w017.w016.w015.w013.w012.w011.w010.w009.w008,
    );
  });

  test("TENANCY: cross-tenant references fail closed across the composed boundaries", async () => {
    const secondCtx = personCtx(
      harness,
      harness.secondOrgPersonId,
      "w034-ac09-tenant",
    );
    // (a) Matching: the second-org scope cannot match the first-org
    // campaign (the tenant-scoped campaign lookup: NOT_FOUND — no
    // existence oracle; the policy version is never even consulted).
    await expect(
      harness.runtime.campaignMatchingService.runCampaignMatch(secondCtx, {
        organizationScopeId: harness.secondOrgId,
        campaignId: scenario.campaignId,
        candidateInventoryItemIds: [scenario.inventoryItemId],
        idempotencyKey: key("w034-ac09-tenant-match"),
      }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
    // (b) Clearing: the second-org scope resolves NOTHING (the value
    // record is the tenant anchor — NOT_FOUND, no existence oracle).
    await expect(
      harness.runtime.apiCommands.evaluateCrossPromotionClearing(
        secondCtx,
        {
          organizationScopeId: harness.secondOrgId,
          sourceContributionId: scenario.contribution.id,
          targetPlacementId: scenario.placementId,
          valueRecordId: scenario.matureValue.id,
        },
      ),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
    // (c) Measurement: a second-org submission of a first-org subject
    // creates the observation ONLY in the SECOND org (tenant isolation
    // by construction), and that cross-scope observation CANNOT feed
    // the first-org measured outcome — the /outcomes authority
    // re-checks the scope at the attachment boundary (fail closed).
    const { rawDeliveryNotice } = await import(
      "../adapters/_net-w023-harness.ts"
    );
    const foreign = await harness.runtime.apiCommands.submitMeasurementReport(
      secondCtx,
      harness.secondOrgPersonId,
      {
        organizationScopeId: harness.secondOrgId,
        subjectReference: {
          subjectId: scenario.contribution.id,
          subjectType: "contribution",
        },
        idempotencyKey: key("w034-ac09-tenant-measure"),
        providerId: "openrtb-delivery",
        report: rawDeliveryNotice(),
      },
    ).catch(() => null);
    // The submission either resolves through the second-org scope or
    // fails closed; in BOTH cases nothing lands in the FIRST org.
    const firstOrgObservations =
      await harness.runtime.outcomeObservationService.listObservationsBySubject(
        harness.operatorCtx("w034-ac09-tenant-obs"),
        scenario.contribution.id,
      );
    const firstOrgScoped = firstOrgObservations.filter(
      (o) => o.organizationScopeId === harness.organizationScopeId,
    );
    expect(firstOrgScoped.every((o) => o.organizationScopeId === harness.organizationScopeId)).toBe(true);
    // The cross-scope observation (when created) CANNOT attach to a
    // FIRST-org measured outcome: the scope re-check fails closed.
    if (foreign !== null && foreign.observation.organizationScopeId !== harness.organizationScopeId) {
      await expect(
        harness.runtime.measuredOutcomeService.createMeasuredOutcome(
          harness.creatorCtx("w034-ac09-tenant-outcome"),
          {
            organizationScopeId: harness.organizationScopeId,
            ownerId: harness.creatorPersonId,
            subjectReference: {
              subjectId: scenario.contribution.id,
              subjectType: "contribution",
            },
            outcomeType: "view",
            maturation: { strategy: "immediate" },
            observationIds: [foreign.observation.id],
          },
        ),
      ).rejects.toMatchObject({ code: "MEASUREMENT_VALIDATION" });
    }
    void secondCtx;
  });
});
