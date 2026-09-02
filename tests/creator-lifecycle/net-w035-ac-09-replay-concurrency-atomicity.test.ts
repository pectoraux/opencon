/**
 * NET-W035-AC-09 — Replay, concurrency, atomicity and tenancy (issue
 * #71 §5 AC-09; work order §4.9).
 *
 *  - REPLAY: same-key measurement + recognition return the committed
 *    records verbatim (created=false);
 *  - RACE: concurrent same-key recognition converges to exactly ONE
 *    value record (the exactly-once economic boundary);
 *  - THE COMPOSITE-LEVEL FAULT INJECTION (the required AC-09
 *    atomicity evidence — the W034/PR #70 remediation precedent proof
 *    shape): the ACTUAL creator-to-settlement join — the recognition
 *    composite's authoritative mutation service
 *    (`createEconomicValueService`, the exact object the apiCommand
 *    calls) — is rebuilt over an authority whose COMMIT always fails,
 *    with the REAL settlement repositories (the same factories the
 *    runtime wires — every read/write flows through the FAILING
 *    transaction), the REAL ledger postings and the neutral lookups
 *    over the runtime's public services. The whole unit — the value
 *    record + the balanced recognition postings (ledger transaction +
 *    entries) + the idempotency record + every buffered audit event —
 *    is FULLY STAGED INSIDE the single authoritative transaction, then
 *    the authoritative COMMIT is forced to fail → NOTHING survives;
 *    the healthy same-key retry through the REAL apiCommand path
 *    completes exactly once and leaves ONE complete lineage;
 *  - the mid-path dispute freeze: a recognized value stays PENDING
 *    while the dispute is active (no partial final state), and the
 *    resolution completes the path;
 *  - TENANCY: cross-tenant creator/campaign/rights/evidence/value/
 *    payment references fail closed without existence oracles;
 *  - LINEAGE: the finished creator engagement reconstructs backward
 *    from the payment fact across durable identifiers + audit order.
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
  createAuthorityEconomicValueRepository,
} from "../../src/settlement/authority-value-repository.ts";
import {
  createAuthorityEconomicLedgerRepository,
} from "../../src/settlement/authority-ledger-repository.ts";
import { createEconomicValueService } from "../../src/settlement/value-service.ts";
import {
  createNetW035Harness,
  runCreatorScenario,
  submitCreatorMeasurement,
  recognizeCreatorValue,
  matureCreatorValue,
  recordCreatorPayment,
  openBondedDisputeOn,
  resolveDispute,
  key,
  personCtx,
  W035_RIGHTS_EVALUATION_AS_OF,
  type NetW035Harness,
  type CreatorScenario,
} from "./_net-w035-harness.ts";
import { assertGlobalConservation } from "../settlement/_net-w008-harness.ts";

let harness: NetW035Harness;
let scenario: CreatorScenario;

beforeAll(async () => {
  harness = await createNetW035Harness();
  scenario = await runCreatorScenario(harness);
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

/** The W006/W017/W018/W019/W020/W034 rebuild pattern: commit() always fails. */
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
 * Rebuild the CREATOR-TO-SETTLEMENT JOIN (the recognition composite's
 * authoritative mutation service — `createEconomicValueService`, the
 * exact object the apiCommand calls) over a COMMIT-FAILING authority:
 * the REAL value + ledger repositories over the failing authority
 * (every committed read and every staged write flows through the
 * failing transaction boundary), the REAL idempotency store over the
 * failing authority, the REAL transactional audit writer, and the
 * neutral lookups over the runtime's public services. Every mutation
 * the recognition performs — the value record, the balanced
 * recognition postings, the idempotency record, the buffered audit —
 * flows through the FAILING transaction, so the forced COMMIT failure
 * exercises the ACTUAL end-to-end atomicity boundary AFTER the whole
 * unit is staged.
 */
async function rebuildFailingRecognitionService() {
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
  return createEconomicValueService({
    repository: createAuthorityEconomicValueRepository({
      authority: failingAuthority,
    }),
    ledgerRepository: createAuthorityEconomicLedgerRepository({
      authority: failingAuthority,
    }),
    // The neutral lookups over the runtime's PUBLIC services (the
    // same read-only shapes the runtime wires).
    subjectLookup: {
      async exists(personId: string) {
        try {
          await harness.runtime.identityService.getIdentity(
            harness.operatorCtx("w035-ac09-fault-identity"),
            personId,
          );
          return true;
        } catch {
          return false;
        }
      },
    },
    evidenceLookup: {
      async resolve(id: string) {
        try {
          const evidence = await harness.runtime.evidenceService.getEvidence(
            harness.operatorCtx("w035-ac09-fault-evidence"),
            id,
          );
          return {
            organizationScopeId: evidence.organizationScopeId,
            sourceType: evidence.provenance.sourceType,
          };
        } catch {
          return null;
        }
      },
    },
    proofOfValueLookup: {
      async resolve(id: string) {
        try {
          const proof = await harness.runtime.proofOfValueService.getProofOfValue(
            harness.operatorCtx("w035-ac09-fault-pov"),
            id,
          );
          return {
            organizationScopeId: proof.organizationScopeId,
            state: proof.state,
          };
        } catch {
          return null;
        }
      },
    },
    measuredOutcomeLookup: {
      async resolve(id: string) {
        try {
          const measurement =
            await harness.runtime.measuredOutcomeService.getMeasuredOutcome(
              harness.operatorCtx("w035-ac09-fault-outcome"),
              id,
            );
          return {
            organizationScopeId: measurement.organizationScopeId,
            state: measurement.state,
          };
        } catch {
          return null;
        }
      },
    },
    contributionLookup: {
      async resolve(id: string) {
        try {
          const contribution =
            await harness.runtime.contributionService.getContribution(
              harness.operatorCtx("w035-ac09-fault-contribution"),
              id,
            );
          return {
            organizationScopeId: contribution.organizationScopeId,
            state: contribution.state,
          };
        } catch {
          return null;
        }
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

describe("NET-W035-AC-09 replay, concurrency, atomicity and tenancy", () => {
  test("REPLAY: a same-key measurement submission returns the COMMITTED observation verbatim", async () => {
    const idem = key("w035-ac09-measure");
    const first = await submitCreatorMeasurement(
      harness,
      scenario.contribution.id,
      { idempotencyKey: idem },
    );
    expect(first.created).toBe(true);
    const replay = await submitCreatorMeasurement(
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
    const idem = key("w035-ac09-recognize");
    const first = await recognizeCreatorValue(
      harness,
      scenario.contribution.id,
      { amount: 55, idempotencyKey: idem },
    );
    expect(first.created).toBe(true);
    const replay = await recognizeCreatorValue(
      harness,
      scenario.contribution.id,
      { amount: 55, idempotencyKey: idem },
    );
    expect(replay.created).toBe(false);
    expect(replay.value.id).toBe(first.value.id);
    // Exactly ONE recognition audit event for the value record.
    const recorded = await harness.runtime.auditWriter.query({
      eventType: "economic_value.recorded",
      resourceId: first.value.id,
    });
    expect(recorded).toHaveLength(1);
  });

  test("RACE: concurrent same-key recognition converges to exactly ONE value record (exactly-once at the economic boundary)", async () => {
    const idem = key("w035-ac09-race");
    const [a, b] = await Promise.all([
      recognizeCreatorValue(harness, scenario.contribution.id, {
        amount: 33,
        idempotencyKey: idem,
      }),
      recognizeCreatorValue(harness, scenario.contribution.id, {
        amount: 33,
        idempotencyKey: idem,
      }),
    ]);
    // Exactly one executed; the other is the deterministic replay.
    expect(a.created).not.toBe(b.created);
    expect(a.value.id).toBe(b.value.id);
    // Exactly ONE value record for this recognition key.
    const recorded = await harness.runtime.auditWriter.query({
      eventType: "economic_value.recorded",
      resourceId: a.value.id,
    });
    expect(recorded).toHaveLength(1);
    // The global economic envelope is conserved after the race.
    await assertGlobalConservation(
      harness.w018.w017.w016.w015.w013.w012.w011.w010.w009.w008,
    );
  });

  test("THE COMPOSITE-LEVEL FAULT INJECTION: the authoritative COMMIT fails AFTER the recognition join fully stages the unit → NOTHING persists; the same-key retry on the REAL path completes exactly once", async () => {
    const theKey = key("w035-ac09-atomic-recognize");

    // The pre-failure authoritative state (everything the recognition
    // join could touch).
    const valuesBefore = await harness.runtime.postgresAuthority.scan(
      "economic_value_records",
    );
    const entriesBefore = await harness.runtime.postgresAuthority.scan(
      "economic_ledger_entries",
    );
    const transactionsBefore = await harness.runtime.postgresAuthority.scan(
      "economic_ledger_transactions",
    );
    const idempotencyBefore = await harness.runtime.postgresAuthority.scan(
      "idempotency",
    );
    const auditRecordedBefore = await auditCount("economic_value.recorded");

    // Derive the EXACT sources the apiCommand derives (the
    // contribution + the QUALIFIED PoH's bases mapped 1:1 onto the
    // economic source kinds) — the recognition join's input contract.
    const poh = await harness.runtime.helpfulnessService.getProofOfHelpfulness(
      harness.operatorCtx("w035-ac09-atomic-poh"),
      scenario.contribution.id,
    );
    const basisKindToSourceKind: Record<string, string> = {
      proof_of_value: "proof_of_value",
      measured_outcome: "measured_outcome",
      evidence_record: "evidence",
    };
    const sources: { kind: string; id: string }[] = [
      { kind: "contribution", id: scenario.contribution.id },
    ];
    for (const basis of poh.bases) {
      const kind = basisKindToSourceKind[basis.kind];
      if (kind) {
        sources.push({ kind, id: basis.referenceId });
      }
    }

    // The ACTUAL creator-to-settlement join over the COMMIT-FAILING
    // stack: the neutral gates pass (the lookups resolve over the
    // public services), THE RECOGNITION IS FULLY STAGED inside the
    // single authoritative transaction (the value record + the
    // balanced recognition postings + the idempotency record + the
    // buffered audit), and the authoritative COMMIT is forced to fail.
    const failingService = await rebuildFailingRecognitionService();
    await expect(
      failingService.recordPendingValue(
        harness.operatorCtx("w035-ac09-atomic-execute"),
        {
          organizationScopeId: harness.organizationScopeId,
          beneficiaryPersonId: harness.creatorPersonId,
          amount: 44,
          sources,
          idempotencyKey: theKey,
        },
      ),
    ).rejects.toThrow("injected authoritative COMMIT failure");

    // ---- NOTHING persisted (all simultaneously) --------------------
    // (a) no value record;
    const valuesAfter = await harness.runtime.postgresAuthority.scan(
      "economic_value_records",
    );
    expect(valuesAfter.length).toBe(valuesBefore.length);
    // (b) no ledger entries + no ledger transactions;
    const entriesAfter = await harness.runtime.postgresAuthority.scan(
      "economic_ledger_entries",
    );
    const transactionsAfter = await harness.runtime.postgresAuthority.scan(
      "economic_ledger_transactions",
    );
    expect(entriesAfter.length).toBe(entriesBefore.length);
    expect(transactionsAfter.length).toBe(transactionsBefore.length);
    // (c) no idempotency record;
    const idempotencyAfter = await harness.runtime.postgresAuthority.scan(
      "idempotency",
    );
    expect(idempotencyAfter.length).toBe(idempotencyBefore.length);
    // (d) no audit event (the buffered writer discards on rollback).
    const auditRecordedAfter = await auditCount("economic_value.recorded");
    expect(auditRecordedAfter).toBe(auditRecordedBefore);

    // ---- The healthy same-key retry through the REAL apiCommand ----
    // completes exactly once (ONE value record, ONE recognition
    // audit event, ONE complete lineage).
    const retried = await recognizeCreatorValue(
      harness,
      scenario.contribution.id,
      { amount: 44, idempotencyKey: theKey },
    );
    expect(retried.created).toBe(true);
    const retriedValue = await harness.runtime.economicValueService.getValue(
      harness.operatorCtx("w035-ac09-atomic-retry-read"),
      retried.value.id,
    );
    expect(retriedValue.state).toBe("PENDING");
    expect(retriedValue.amount).toBe(44);
    expect(retriedValue.sources.map((s) => s.id)).toContain(
      scenario.contribution.id,
    );
    const recordedEvents = await harness.runtime.auditWriter.query({
      eventType: "economic_value.recorded",
      resourceId: retried.value.id,
    });
    expect(recordedEvents).toHaveLength(1);
    // The same-key replay returns the SAME record.
    const replay = await recognizeCreatorValue(
      harness,
      scenario.contribution.id,
      { amount: 44, idempotencyKey: theKey },
    );
    expect(replay.created).toBe(false);
    expect(replay.value.id).toBe(retried.value.id);
    // The global economic envelope is conserved throughout.
    await assertGlobalConservation(
      harness.w018.w017.w016.w015.w013.w012.w011.w010.w009.w008,
    );
  });

  test("the mid-path dispute freeze: the value stays PENDING while disputed; the resolution completes the economic path", async () => {
    const recognized = await recognizeCreatorValue(
      harness,
      scenario.contribution.id,
      { amount: 66, idempotencyKey: key("w035-ac09-freeze") },
    );
    const dispute = await openBondedDisputeOn(
      harness,
      "economic_value",
      recognized.value.id,
    );
    let matured = null;
    try {
      matured = await matureCreatorValue(harness, recognized.value.id);
    } catch (error) {
      expect((error as { code?: string }).code).toBe("DISPUTE_CHALLENGE");
    }
    expect(matured).toBeNull();
    const frozen = await harness.runtime.economicValueService.getValue(
      harness.operatorCtx("w035-ac09-freeze-read"),
      recognized.value.id,
    );
    expect(frozen.state).toBe("PENDING");
    // The resolution completes the path.
    await resolveDispute(harness, dispute, scenario.contribution.id);
    const completed = await matureCreatorValue(harness, recognized.value.id);
    expect(completed.state).toBe("MATURE");
  });

  test("TENANCY: cross-tenant creator/campaign/rights/evidence/value/payment references fail closed without existence oracles", async () => {
    const foreignCtx = personCtx(
      harness,
      harness.secondOrgPersonId,
      "w035-ac09-foreign",
    );
    // The engagement does not resolve in the foreign scope.
    await expect(
      harness.runtime.creatorEngagementService.getEngagement(
        foreignCtx,
        harness.secondOrgId,
        scenario.engagement.id,
      ),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
    // The usage-rights grant does not resolve in the foreign scope.
    await expect(
      harness.runtime.creatorEngagementService.getUsageRights(
        foreignCtx,
        harness.secondOrgId,
        scenario.usageRightsGrantId,
        // FIXED deterministic anchor (§3.1) — the call fails NOT_FOUND
        // on the tenant boundary before any status derivation.
        W035_RIGHTS_EVALUATION_AS_OF,
      ),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
    // The publication does not resolve in the foreign scope.
    await expect(
      harness.runtime.creatorSponsorshipService.getPublication(
        foreignCtx,
        harness.secondOrgId,
        scenario.publication.id,
      ),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
    // The foreign-scope measurement submission for the first-org
    // subject fails closed (no oracle).
    await expect(
      harness.runtime.apiCommands.submitMeasurementReport(
        foreignCtx,
        harness.secondOrgPersonId,
        {
          organizationScopeId: harness.secondOrgId,
          subjectReference: {
            subjectId: scenario.contribution.id,
            subjectType: "contribution",
          },
          idempotencyKey: key("w035-ac09-foreign-measure"),
          providerId: scenario.measurementProviderId,
          report: {} as never,
        },
      ),
    ).rejects.toThrow();
    // The foreign-scope payment fact does not fabricate a linkage to
    // the first-org lineage (the derived reconciliation stays
    // pending — never an error, never a mutation).
    const fact = await recordCreatorPayment(harness, {
      valueRecordId: scenario.matureValue.id,
      internalTransactionId: scenario.matureValue.recognitionTransactionId,
      reportedAmount: scenario.matureValue.amount,
      organizationScopeId: harness.secondOrgId,
    });
    const view =
      await harness.runtime.externalSettlementService.evaluateExternalSettlementReconciliation(
        harness.operatorCtx("w035-ac09-foreign-reconcile"),
        {
          organizationScopeId: harness.secondOrgId,
          factId: fact.id,
        },
      );
    expect(view.verdict).toBe("pending");
    expect(view.reason).toBe("internal_lineage_not_found");
    // The tenant-scoped fact read in the foreign scope returns the
    // foreign fact (the first-org fact does NOT leak).
    const foreignRead =
      await harness.runtime.externalSettlementService.getExternalSettlementFact(
        foreignCtx,
        harness.secondOrgId,
        scenario.paymentFact!.id,
      );
    expect(foreignRead).toBeNull();
  });

  test("LINEAGE: the finished creator engagement reconstructs BACKWARD from the payment fact across durable identifiers + audit order", async () => {
    // Payment fact → recognition transaction → value → sources →
    // production → engagement → campaign → match run → creator
    // profile, all through the owning boundaries.
    const fact =
      await harness.runtime.externalSettlementService.getExternalSettlementFact(
        harness.operatorCtx("w035-ac09-lineage-fact"),
        harness.organizationScopeId,
        scenario.paymentFact!.id,
      );
    expect(fact!.internalTransactionId).toBe(
      scenario.matureValue.recognitionTransactionId,
    );
    const value = await harness.runtime.economicValueService.getValue(
      harness.operatorCtx("w035-ac09-lineage-value"),
      scenario.matureValue.id,
    );
    expect(value.recognitionTransactionId).toBe(fact!.internalTransactionId);
    expect(value.beneficiaryPersonId).toBe(harness.creatorPersonId);
    // The sources walk back to the measurement/outcome/evidence
    // records and the contribution.
    expect(value.sources.map((s) => s.id)).toContain(scenario.contribution.id);
    expect(value.sources.map((s) => s.id)).toContain(scenario.measuredOutcome.id);
    expect(value.sources.map((s) => s.id)).toContain(scenario.proofOfValueId);
    // The contribution's lineage: the opportunity → the campaign.
    const contribution = await harness.runtime.contributionService.getContribution(
      harness.operatorCtx("w035-ac09-lineage-contribution"),
      scenario.contribution.id,
    );
    expect(contribution.opportunityId).toBe(scenario.opportunityId);
    const campaign = await harness.runtime.campaignService.getCampaign(
      harness.operatorCtx("w035-ac09-lineage-campaign"),
      scenario.campaignId,
    );
    expect(campaign.ownerPersonId).toBe(harness.operatorPersonId);
    // The UGC production binds the contribution to the engagement.
    const production = await harness.runtime.creatorEngagementService.getProduction(
      harness.operatorCtx("w035-ac09-lineage-production"),
      harness.organizationScopeId,
      scenario.production.id,
    );
    expect(production.contributionId).toBe(contribution.id);
    const engagement = await harness.runtime.creatorEngagementService.getEngagement(
      harness.operatorCtx("w035-ac09-lineage-engagement"),
      harness.organizationScopeId,
      scenario.engagement.id,
    );
    expect(production.engagementId).toBe(engagement.id);
    expect(engagement.campaignId).toBe(scenario.campaignId);
    expect(engagement.campaignPolicyVersion).toBe(1);
    expect(engagement.matchRunId).toBe(scenario.matchRunId);
    expect(engagement.creatorProfileId).toBe(scenario.creatorProfileId);
    // The match run walks back to the creator profile.
    const run = await harness.runtime.creatorMatchingService.getMatchRun(
      harness.operatorCtx("w035-ac09-lineage-run"),
      harness.organizationScopeId,
      scenario.matchRunId,
    );
    expect(
      run.results.some((r) => r.profileId === scenario.creatorProfileId),
    ).toBe(true);
    // The publication + relationship complete the disclosure lineage.
    const publication = await harness.runtime.creatorSponsorshipService.getPublication(
      harness.operatorCtx("w035-ac09-lineage-publication"),
      harness.organizationScopeId,
      scenario.publication.id,
    );
    expect(publication.engagementId).toBe(engagement.id);
    expect(publication.state).toBe("VERIFIED");

    // The audit order corroborates the full chain: the creator match
    // BEFORE the campaign; the acceptance BEFORE the disclosure; the
    // disclosure verification BEFORE the MEASURING point; the walk
    // completion BEFORE the recognition; the maturation BEFORE the
    // payment fact.
    const log = await harness.runtime.auditWriter.query({ limit: 1_000_000 });
    const pos = (eventType: string, resourceId: string): number =>
      log.findIndex(
        (e) => e.eventType === eventType && e.resourceId === resourceId,
      );
    expect(pos("campaign.created", scenario.campaignId)).toBeGreaterThan(
      pos("creator_match.recorded", scenario.matchRunId),
    );
    expect(pos("publication.verified", scenario.publication.id)).toBeGreaterThan(
      pos("usage_rights.granted", scenario.usageRightsGrantId),
    );
    expect(
      pos("contribution.transition.submitted_to_measuring", scenario.contribution.id),
    ).toBeGreaterThan(pos("publication.verified", scenario.publication.id));
    expect(
      pos("economic_value.recorded", scenario.value.id),
    ).toBeGreaterThan(
      pos("contribution.transition.settled_to_verified", scenario.contribution.id),
    );
    expect(
      pos("external_settlement_fact.recorded", scenario.paymentFact!.id),
    ).toBeGreaterThan(pos("economic_value.matured", scenario.value.id));
  });
});
