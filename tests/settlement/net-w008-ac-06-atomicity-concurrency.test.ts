/**
 * NET-W008-AC-06 — Accounting mutations are authorized, idempotent,
 * concurrent-safe, PostgreSQL-authoritative and audit-linked
 * atomically.
 *
 *  - API mutations are guarded deny-by-default (a runtime without the
 *    settlement allow policies rejects every mutation endpoint — all
 *    13 guard actions);
 *  - deterministic replay on repeated idempotency keys (exactly one
 *    record + one audit event) for value recognition AND credit
 *    issuance;
 *  - concurrent same-key issuances produce exactly one mutation;
 *  - concurrent DIFFERENT-key state mutations of the SAME value record
 *    (mature vs reverse) resolve to exactly one winner — the
 *    per-record serialization boundary (`economic_value_record:{id}`,
 *    IdempotencyStore.withLock — the NET-W007 remediation pattern);
 *  - concurrent conversions against the same credits balance cannot
 *    overdraft (per-account serialization — the posting-layer lock
 *    set);
 *  - an audit append failure INSIDE the transaction rolls the mutation
 *    back entirely (no record without its audit lineage);
 *  - an audit PUBLICATION failure after the durable commit retains the
 *    pending audit record for the explicit recovery path;
 *  - audit lineage carries the AUTHORITATIVE transaction id.
 *
 * Evidence: API security tests + fault-injection + concurrency
 * integration tests over the NET-W003 persistence/idempotency
 * boundaries.
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import type {
  TransactionalAuditWriter,
  TransactionalAuditBuffer,
} from "../../src/core/audit.ts";
import type { AuthorityTransaction } from "../../src/core/postgres-authority.ts";
import { createRuntime } from "../../src/bootstrap/runtime.ts";
import { createPostgresIdempotencyStore } from "../../src/persistence/idempotency-store.ts";
import { createAuthorityEconomicLedgerRepository } from "../../src/settlement/authority-ledger-repository.ts";
import { createAuthorityEconomicValueRepository } from "../../src/settlement/authority-value-repository.ts";
import { createAuthorityCreditIssuanceRepository } from "../../src/settlement/authority-credit-repository.ts";
import { createCreditService } from "../../src/settlement/credit-service.ts";
import {
  createNetW008Harness,
  createMatureValue,
  createPendingValue,
  assertGlobalConservation,
  actorCtx,
  type NetW008Harness,
} from "./_net-w008-harness.ts";

let harness: NetW008Harness;

beforeEach(async () => {
  harness = await createNetW008Harness();
});

afterEach(async () => {
  await harness.teardown();
});

const silentLogger = {
  debug() {},
  info() {},
  warn() {},
  error() {},
  child() {
    return this;
  },
  forModule() {
    return this;
  },
} as unknown as Parameters<typeof createCreditService>[0]["logger"];

const BASE = "http://127.0.0.1";

describe("NET-W008-AC-06 atomicity/idempotency/concurrency", () => {
  test("settlement mutation endpoints are guarded deny-by-default (no policy → 403, authenticated or not)", async () => {
    const bare = createRuntime({
      forceEnv: "test",
      env: { APP_ENV: "test", LOG_LEVEL: "error" },
      port: 0,
    });
    await bare.initialize();
    await bare.api.start();
    try {
      const endpoints: Array<[string, Record<string, unknown>]> = [
        ["/api/settlement/values", { organizationScopeId: "org", beneficiaryPersonId: "x", amount: 1, sources: [], idempotencyKey: "k" }],
        ["/api/settlement/credit-issuances", { organizationScopeId: "org", beneficiaryPersonId: "x", sourceValueRecordId: "y", creditsPerValueUnit: 1, idempotencyKey: "k" }],
        ["/api/settlement/reward-policies", { organizationScopeId: "org", policyId: "p", version: 1, allocations: [] }],
        ["/api/settlement/reward-allocations", { organizationScopeId: "org", sourceValueRecordId: "y", policyId: "p", idempotencyKey: "k" }],
        ["/api/settlement/cash-obligations", { organizationScopeId: "org", kind: "payable", counterpartyPersonId: "x", amount: 1, idempotencyKey: "k" }],
        ["/api/settlement/conversions", { organizationScopeId: "org", personId: "x", direction: "cash_to_credits", cashAmount: 1, creditsAmount: 1, idempotencyKey: "k" }],
        ["/api/settlement/values/x/mature", { idempotencyKey: "k" }],
        ["/api/settlement/values/x/reverse", { reason: "r", idempotencyKey: "k" }],
        ["/api/settlement/credit-issuances/x/reverse", { reason: "r", idempotencyKey: "k" }],
        ["/api/settlement/reward-allocations/x/reverse", { reason: "r", idempotencyKey: "k" }],
        ["/api/settlement/cash-obligations/x/settle", { idempotencyKey: "k" }],
        ["/api/settlement/cash-obligations/x/reverse", { reason: "r", idempotencyKey: "k" }],
        ["/api/settlement/conversions/x/reverse", { reason: "r", idempotencyKey: "k" }],
      ];
      for (const [path, body] of endpoints) {
        const unauth = await fetch(`${BASE}:${bare.api.port}${path}`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
        });
        expect(unauth.status, `${path} unauthenticated`).toBe(403);
        const authed = await fetch(`${BASE}:${bare.api.port}${path}`, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "x-auth-subject-id": "someone@example.com",
            "x-auth-provider-kind": "internal",
          },
          body: JSON.stringify(body),
        });
        expect(authed.status, `${path} authenticated`).toBe(403);
      }
    } finally {
      await bare.shutdown();
    }

    // With the harness policies + authenticated principal the guarded
    // mutation is ALLOWED (201).
    const value = await createPendingValue(harness, { amount: 10 });
    const res = await fetch(`${BASE}:${harness.runtime.api.port}/api/settlement/values/${value.id}/mature`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-auth-subject-id": harness.subjectId,
        "x-auth-provider-kind": "internal",
      },
      body: JSON.stringify({ idempotencyKey: "ac06-api-mature" }),
    });
    expect(res.status).toBe(200);
    const view = (await res.json()) as { state: string };
    expect(view.state).toBe("MATURE");
  });

  test("repeating value recognition with the SAME idempotency key is a deterministic replay (one record, one audit event)", async () => {
    const ctx = actorCtx(harness, "ac06-replay-value");
    const povId = (await createPendingValue(harness, { amount: 30, idempotencyKey: "ac06-replay" })).sources[0]!.id;
    // Same PoV, same beneficiary, SAME idempotency key → replay.
    const second = await harness.runtime.economicValueService.recordPendingValue(ctx, {
      organizationScopeId: harness.organizationScopeId,
      beneficiaryPersonId: harness.personId,
      amount: 30,
      sources: [{ kind: "proof_of_value", id: povId }],
      idempotencyKey: "ac06-replay",
    });
    expect(second.created).toBe(false);
    const values = await harness.runtime.economicValueService.listValues(
      ctx,
      harness.organizationScopeId,
      harness.personId,
    );
    expect(values).toHaveLength(1);
    const events = await harness.runtime.auditWriter.query({
      eventType: "economic_value.recorded",
    });
    expect(events.filter((e) => e.metadata.idempotencyKey === "ac06-replay")).toHaveLength(1);
    // The pending balance was posted ONCE.
    const summary = await harness.runtime.economicLedgerService.getParticipantSummary(
      harness.bootstrapCtx,
      harness.organizationScopeId,
      harness.personId,
    );
    expect(summary.pendingValue).toBe(30);
    await assertGlobalConservation(harness);
  });

  test("CONCURRENT same-key credit issuances produce exactly one issuance (idempotency-store per-key locking)", async () => {
    const value = await createMatureValue(harness, { amount: 100 });
    const ctx = actorCtx(harness, "ac06-concurrent-issue");
    const outcomes = await Promise.allSettled([
      harness.runtime.creditService.issueCredits(ctx, {
        organizationScopeId: harness.organizationScopeId,
        beneficiaryPersonId: harness.personId,
        sourceValueRecordId: value.id,
        creditsPerValueUnit: 1,
        idempotencyKey: "ac06-concurrent-issue",
      }),
      harness.runtime.creditService.issueCredits(ctx, {
        organizationScopeId: harness.organizationScopeId,
        beneficiaryPersonId: harness.personId,
        sourceValueRecordId: value.id,
        creditsPerValueUnit: 1,
        idempotencyKey: "ac06-concurrent-issue",
      }),
      harness.runtime.creditService.issueCredits(ctx, {
        organizationScopeId: harness.organizationScopeId,
        beneficiaryPersonId: harness.personId,
        sourceValueRecordId: value.id,
        creditsPerValueUnit: 1,
        idempotencyKey: "ac06-concurrent-issue",
      }),
    ]);
    const fulfilled = outcomes.filter((o) => o.status === "fulfilled");
    expect(fulfilled).toHaveLength(3); // all resolve (replays)
    const ids = new Set(fulfilled.map((o) => (o.value as { issuance: { id: string } }).issuance.id));
    expect(ids.size).toBe(1);
    const createdFlags = fulfilled.map(
      (o) => (o.value as { created: boolean }).created,
    );
    expect(createdFlags.filter(Boolean)).toHaveLength(1);

    // Exactly ONE issuance record, ONE audit event, 100 credits.
    const issuances = await harness.runtime.creditService.listIssuances(
      ctx,
      harness.organizationScopeId,
      harness.personId,
    );
    expect(issuances).toHaveLength(1);
    const events = await harness.runtime.auditWriter.query({
      eventType: "credit_issuance.issued",
    });
    expect(events.filter((e) => e.metadata.idempotencyKey === "ac06-concurrent-issue")).toHaveLength(1);
    const summary = await harness.runtime.economicLedgerService.getParticipantSummary(
      harness.bootstrapCtx,
      harness.organizationScopeId,
      harness.personId,
    );
    expect(summary.credits).toBe(100);
    await assertGlobalConservation(harness);
  });

  test("CONCURRENT different-key state mutations of the SAME record serialize with no double-apply (mature vs reverse race)", async () => {
    const pending = await createPendingValue(harness, { amount: 100 });
    const ctx = actorCtx(harness, "ac06-mature-vs-reverse");
    const outcomes = await Promise.allSettled([
      harness.runtime.economicValueService.matureValue(ctx, {
        valueRecordId: pending.id,
        idempotencyKey: "ac06-race-mature",
      }),
      harness.runtime.economicValueService.reverseValue(ctx, {
        valueRecordId: pending.id,
        reason: "race reversal",
        idempotencyKey: "ac06-race-reverse",
      }),
    ]);
    // The per-record serialization boundary (economic_value_record:{id})
    // serializes both mutations: EITHER order is legal —
    //   mature-then-reverse: both succeed (PENDING→MATURE→REVERSED);
    //   reverse-then-mature: reverse succeeds, mature observes the
    //   COMMITTED REVERSED state and is rejected.
    // The invariants that hold in BOTH cases:
    const record = await harness.runtime.economicValueService.getValue(ctx, pending.id);
    expect(record.state).toBe("REVERSED");
    // AT MOST one maturation and exactly one reversal applied.
    const transactions = await harness.runtime.economicLedgerService.listTransactionsBySubject(
      ctx,
      { kind: "economic_value", id: pending.id },
    );
    const maturationCount = transactions.filter((t) => t.kind === "maturation").length;
    const reversalCount = transactions.filter((t) => t.kind === "reversal").length;
    expect(maturationCount).toBeLessThanOrEqual(1);
    expect(reversalCount).toBe(1);
    // The version equals 1 (creation) + the number of applied mutations.
    expect([1, 2]).toContain(record.version);
    if (record.version === 2) {
      expect(maturationCount).toBe(1);
      // The reversal negated BOTH the recognition and the maturation.
      const reversalTx = transactions.find((t) => t.kind === "reversal")!;
      expect(reversalTx.entries).toHaveLength(4);
    } else {
      expect(maturationCount).toBe(0);
      const rejected = outcomes.filter((o) => o.status === "rejected");
      expect(rejected).toHaveLength(1);
      expect((rejected[0]!.reason as Error).message).toMatch(/is REVERSED, not PENDING/);
    }
    // Balances are fully restored and the ledger conserves.
    const summary = await harness.runtime.economicLedgerService.getParticipantSummary(
      harness.bootstrapCtx,
      harness.organizationScopeId,
      harness.personId,
    );
    expect(summary.pendingValue).toBe(0);
    expect(summary.matureValue).toBe(0);
    await assertGlobalConservation(harness);
  });

  test("CONCURRENT conversions against the same credits balance cannot overdraft (per-account serialization)", async () => {
    const value = await createMatureValue(harness, { amount: 100 });
    await harness.runtime.creditService.issueCredits(actorCtx(harness, "ac06-issue"), {
      organizationScopeId: harness.organizationScopeId,
      beneficiaryPersonId: harness.personId,
      sourceValueRecordId: value.id,
      creditsPerValueUnit: 1,
      idempotencyKey: "ac06-conv-issue",
    });
    const ctx = actorCtx(harness, "ac06-concurrent-convert");
    // Two conversions each spending the FULL 100 credits concurrently.
    const outcomes = await Promise.allSettled([
      harness.runtime.conversionService.recordConversion(ctx, {
        organizationScopeId: harness.organizationScopeId,
        personId: harness.personId,
        direction: "credits_to_cash",
        cashAmount: 40,
        creditsAmount: 100,
        idempotencyKey: "ac06-conv-a",
      }),
      harness.runtime.conversionService.recordConversion(ctx, {
        organizationScopeId: harness.organizationScopeId,
        personId: harness.personId,
        direction: "credits_to_cash",
        cashAmount: 40,
        creditsAmount: 100,
        idempotencyKey: "ac06-conv-b",
      }),
    ]);
    const fulfilled = outcomes.filter((o) => o.status === "fulfilled");
    const rejected = outcomes.filter((o) => o.status === "rejected");
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect((rejected[0]!.reason as Error).message).toMatch(/would overdraw account/);
    const summary = await harness.runtime.economicLedgerService.getParticipantSummary(
      harness.bootstrapCtx,
      harness.organizationScopeId,
      harness.personId,
    );
    expect(summary.credits).toBe(0);
    expect(summary.cashPayable).toBe(40);
    await assertGlobalConservation(harness);
  });

  test("an audit APPEND failure inside the transaction rolls the issuance back ENTIRELY (no credits without audit lineage)", async () => {
    const value = await createMatureValue(harness, { amount: 100 });
    const ctx = actorCtx(harness, "ac06-audit-append-failure");
    const authority = harness.runtime.postgresAuthority;

    const throwingBuffer: TransactionalAuditBuffer = {
      async append() {
        throw new Error("injected audit append failure");
      },
      async query() {
        return [];
      },
      async count() {
        return 0;
      },
      pendingCount() {
        return 0;
      },
    };
    const throwingWriter: TransactionalAuditWriter = {
      async append(input) {
        return harness.runtime.auditWriter.append(input);
      },
      async query(query) {
        return harness.runtime.auditWriter.query(query);
      },
      async count() {
        return harness.runtime.auditWriter.count();
      },
      forTransaction(_tx: AuthorityTransaction) {
        return throwingBuffer;
      },
      async retryPendingPublications() {
        return { published: 0, remaining: 0 };
      },
      pendingPublicationCount() {
        return 0;
      },
    };

    const ledgerRepo = createAuthorityEconomicLedgerRepository({ authority });
    const valueRepo = createAuthorityEconomicValueRepository({ authority });
    const issuanceRepo = createAuthorityCreditIssuanceRepository({ authority });
    const idempotency = createPostgresIdempotencyStore({ authority });
    const service = createCreditService({
      issuanceRepository: issuanceRepo,
      valueRepository: valueRepo,
      ledgerRepository: ledgerRepo,
      subjectLookup: { async exists() { return true; } },
      proofOfValueLookup: {
        async resolve(id: string) {
          const record = await valueRepo.findById(id);
          void record;
          const pov = value.sources.find((s) => s.kind === "proof_of_value");
          return pov && pov.id === id
            ? { organizationScopeId: harness.organizationScopeId, state: "VERIFIED" }
            : null;
        },
      },
      idempotency,
      auditWriter: throwingWriter,
      logger: silentLogger,
    });

    let err: Error | null = null;
    try {
      await service.issueCredits(ctx, {
        organizationScopeId: harness.organizationScopeId,
        beneficiaryPersonId: harness.personId,
        sourceValueRecordId: value.id,
        creditsPerValueUnit: 1,
        idempotencyKey: "ac06-append-failure",
      });
    } catch (e) {
      err = e as Error;
    }
    expect(err).not.toBeNull();
    expect((err as Error).message).toMatch(/injected audit append failure/);

    // NOTHING survived: no issuance record, the value record is still
    // MATURE, no ledger transaction was posted for an issuance.
    const issuances = await issuanceRepo.listByBeneficiary(
      harness.organizationScopeId,
      harness.personId,
    );
    expect(issuances).toHaveLength(0);
    const record = await valueRepo.findById(value.id);
    expect(record!.state).toBe("MATURE");
    expect(record!.consumedBy).toBeNull();
    await assertGlobalConservation(harness);
  });

  test("an audit PUBLICATION failure after the durable commit retains the pending audit for recovery (the commit is never undone)", async () => {
    const { createTransactionalAuditWriter } = await import(
      "../../src/audit/transactional-audit-writer.ts"
    );
    const value = await createMatureValue(harness, { amount: 100 });
    const ctx = actorCtx(harness, "ac06-publication-failure");
    const authority = harness.runtime.postgresAuthority;

    // An underlying writer whose append fails ONCE (publication
    // failure) — the transactional writer retries then retains.
    let failOnce = true;
    const underlying = {
      async append(input: { eventType: string }) {
        if (failOnce && input.eventType === "credit_issuance.issued") {
          failOnce = false;
          throw new Error("injected publication failure");
        }
        return harness.runtime.auditWriter.append(input as never);
      },
      async query(query: never) {
        return harness.runtime.auditWriter.query(query);
      },
      async count() {
        return harness.runtime.auditWriter.count();
      },
    };
    const transactionalWriter = createTransactionalAuditWriter({
      underlying: underlying as never,
      publicationAttempts: 1,
      publicationBackoffMs: 0,
      logger: silentLogger,
    });

    const ledgerRepo = createAuthorityEconomicLedgerRepository({ authority });
    const valueRepo = createAuthorityEconomicValueRepository({ authority });
    const issuanceRepo = createAuthorityCreditIssuanceRepository({ authority });
    const idempotency = createPostgresIdempotencyStore({ authority });
    const service = createCreditService({
      issuanceRepository: issuanceRepo,
      valueRepository: valueRepo,
      ledgerRepository: ledgerRepo,
      subjectLookup: { async exists() { return true; } },
      proofOfValueLookup: {
        async resolve(id: string) {
          const pov = value.sources.find((s) => s.kind === "proof_of_value");
          return pov && pov.id === id
            ? { organizationScopeId: harness.organizationScopeId, state: "VERIFIED" }
            : null;
        },
      },
      idempotency,
      auditWriter: transactionalWriter,
      logger: silentLogger,
    });

    // The issuance COMMITS (the durable commit is the settle point);
    // only the audit publication failed and is retained.
    const { issuance } = await service.issueCredits(ctx, {
      organizationScopeId: harness.organizationScopeId,
      beneficiaryPersonId: harness.personId,
      sourceValueRecordId: value.id,
      creditsPerValueUnit: 1,
      idempotencyKey: "ac06-publication-failure",
    });
    const committed = await issuanceRepo.findById(issuance.id);
    expect(committed!.status).toBe("issued");
    const record = await valueRepo.findById(value.id);
    expect(record!.state).toBe("CONSUMED");

    // The failed publication is retained pending, then recoverable.
    const remaining = transactionalWriter.pendingPublicationCount();
    expect(remaining).toBeGreaterThan(0);
    const recovery = await transactionalWriter.retryPendingPublications();
    expect(recovery.published).toBeGreaterThan(0);
    expect(transactionalWriter.pendingPublicationCount()).toBe(0);
    // The recovered event is visible with the AUTHORITATIVE tx lineage.
    const events = await harness.runtime.auditWriter.query({
      eventType: "credit_issuance.issued",
    });
    const event = events.find((e) => e.resourceId === issuance.id);
    expect(event).toBeDefined();
    expect((event!.metadata as Record<string, unknown>).transactionId).toBeTruthy();
    await assertGlobalConservation(harness);
  });

  test("audit lineage carries the AUTHORITATIVE transaction id (not the execution id)", async () => {
    const value = await createMatureValue(harness, { amount: 100 });
    const ctx = actorCtx(harness, "ac06-tx-lineage");
    const { issuance } = await harness.runtime.creditService.issueCredits(ctx, {
      organizationScopeId: harness.organizationScopeId,
      beneficiaryPersonId: harness.personId,
      sourceValueRecordId: value.id,
      creditsPerValueUnit: 1,
      idempotencyKey: "ac06-tx-lineage",
    });
    const events = await harness.runtime.auditWriter.query({
      eventType: "credit_issuance.issued",
    });
    const event = events.find((e) => e.resourceId === issuance.id);
    expect(event).toBeDefined();
    const metadata = event!.metadata as Record<string, unknown>;
    const transactionId = metadata.transactionId as string;
    expect(transactionId).toBeTruthy();
    expect(transactionId).not.toBe(event!.executionId);
    // The ledger transaction with the same id exists and carries the
    // same idempotency key.
    const ledgerTx = await harness.runtime.economicLedgerService.getTransaction(
      ctx,
      issuance.transactionId,
    );
    expect(ledgerTx.idempotencyKey).toBe("ac06-tx-lineage");
  });
});
