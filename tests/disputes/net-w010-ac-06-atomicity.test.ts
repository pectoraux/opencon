/**
 * NET-W010-AC-06 — Dispute mutations are concurrent-safe,
 * PostgreSQL-authoritative, and audit-linked atomically.
 *
 * Evidence: same-key concurrency produces exactly one committed
 * mutation (the other replays or conflicts); different-key
 * concurrent mutations of the SAME dispute serialize on the
 * per-record mutex to exactly one committed history (the second sees
 * the committed state and fails deterministically); concurrent opens
 * of the SAME subject produce exactly one live dispute; failed
 * mutations leave NO record and NO audit event (rollback cleanliness
 * — the transactional audit buffer discards with the transaction);
 * every committed mutation's audit event carries idempotency +
 * transaction lineage.
 */

import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import {
  createNetW010Harness,
  createChallengeableValue,
  openDefaultDispute,
  bondDefaultStake,
  challengerCtx,
  reviewerCtx,
  type NetW010Harness,
} from "./_net-w010-harness.ts";

let harness: NetW010Harness;

beforeAll(async () => {
  harness = await createNetW010Harness();
});

afterAll(async () => {
  await harness.teardown();
});

describe("NET-W010-AC-06 atomicity + concurrency safety", () => {
  test("concurrent SAME-KEY opens produce exactly one dispute (replay semantics)", async () => {
    const subject = await createChallengeableValue(harness);
    const key = `w010-ac06-same-key-${subject.id}`;
    const mk = () =>
      harness.runtime.disputeService.openDispute(
        challengerCtx(harness, "w010-ac06-same"),
        {
          organizationScopeId: harness.organizationScopeId,
          subjectRef: { subjectType: "economic_value", subjectId: subject.id },
          statement: "concurrent identical request",
          reasonCodes: ["contested_verification"],
          supportingRefs: [{ kind: "economic_value", id: subject.id }],
          effectiveAt: new Date(
            Date.parse(subject.recordedAt) + 3600_000,
          ).toISOString(),
          idempotencyKey: key,
        },
      );
    const results = await Promise.allSettled([mk(), mk()]);
    const fulfilled = results.filter((r) => r.status === "fulfilled");
    expect(fulfilled).toHaveLength(2);
    const [a, b] = fulfilled.map((r) => r.value);
    expect(a!.dispute.id).toBe(b!.dispute.id);
    expect(a!.created || b!.created).toBe(true);
    expect(a!.created && b!.created).toBe(false);
    // Exactly ONE record + ONE audit event.
    const records = await harness.runtime.postgresAuthority.scan<{
      id: string;
    }>("disputes");
    expect(records.filter((r) => r.value.id === a!.dispute.id)).toHaveLength(1);
    const audit = await harness.runtime.auditWriter.query({
      eventType: "dispute.opened",
      resourceId: a!.dispute.id,
    });
    expect(audit).toHaveLength(1);
  });

  test("concurrent DIFFERENT-KEY opens of the SAME subject produce exactly one live dispute", async () => {
    const subject = await createChallengeableValue(harness);
    const mk = (n: number) =>
      harness.runtime.disputeService.openDispute(
        challengerCtx(harness, `w010-ac06-dup-${n}`),
        {
          organizationScopeId: harness.organizationScopeId,
          subjectRef: { subjectType: "economic_value", subjectId: subject.id },
          statement: `competing challenge ${n}`,
          reasonCodes: ["contested_verification"],
          supportingRefs: [{ kind: "economic_value", id: subject.id }],
          effectiveAt: new Date(
            Date.parse(subject.recordedAt) + 3600_000,
          ).toISOString(),
          idempotencyKey: `w010-ac06-dup-${n}-${subject.id}`,
        },
      );
    const results = await Promise.allSettled([mk(1), mk(2)]);
    const fulfilled = results.filter((r) => r.status === "fulfilled");
    const rejected = results.filter((r) => r.status === "rejected");
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect((rejected[0] as PromiseRejectedResult).reason).toMatchObject({
      code: "CONFLICT",
    });
  });

  test("concurrent resolves of the same dispute serialize to exactly one committed history", async () => {
    const { dispute, subject } = await openDefaultBondedReviewed();
    const resolve = (n: number, outcome: "UPHELD" | "DENIED") =>
      harness.runtime.disputeService.resolveDispute(
        reviewerCtx(harness, `w010-ac06-resolve-${n}`),
        {
          disputeId: dispute.id,
          outcome,
          controlDisposition: "MAINTAIN_CONTROL",
          reasonCodes: ["merits"],
          sourceRefs: [{ kind: "economic_value", id: subject.id }],
          idempotencyKey: `w010-ac06-resolve-${n}-${dispute.id}`,
        },
      );
    const results = await Promise.allSettled([resolve(1, "UPHELD"), resolve(2, "DENIED")]);
    const fulfilled = results.filter((r) => r.status === "fulfilled");
    expect(fulfilled).toHaveLength(1);
    const winner = fulfilled[0] as PromiseFulfilledResult<
      Awaited<ReturnType<typeof resolve>>
    >;
    expect(winner.value.state).toBe("RESOLVED");
    // Exactly ONE resolved event in the committed history + one audit
    // event (the loser never wrote).
    const refetched = await harness.runtime.disputeService.getDispute(
      harness.bootstrapCtx,
      dispute.id,
    );
    expect(
      refetched.events.filter((e) => e.event === "resolved"),
    ).toHaveLength(1);
    const audit = await harness.runtime.auditWriter.query({
      eventType: "dispute.resolved",
      resourceId: dispute.id,
    });
    expect(audit).toHaveLength(1);

    async function openDefaultBondedReviewed() {
      const { ensureCreditsFor, openBondedDispute } = await import(
        "./_net-w010-harness.ts"
      );
      await ensureCreditsFor(harness, harness.challengerPersonId, 50);
      const opened = await openBondedDispute(harness, { withReview: true });
      return opened;
    }
  });

  test("failed mutations leave NO record and NO audit event (rollback cleanliness)", async () => {
    const subject = await createChallengeableValue(harness);
    const disputesBefore = (
      await harness.runtime.postgresAuthority.scan("disputes")
    ).length;
    const auditBefore = await harness.runtime.auditWriter.count();
    // A supporting reference that does not resolve fails AFTER the
    // pure validation but BEFORE the transaction — and a window
    // failure likewise; either way nothing may be persisted.
    await expect(
      harness.runtime.disputeService.openDispute(
        challengerCtx(harness, "w010-ac06-rollback"),
        {
          organizationScopeId: harness.organizationScopeId,
          subjectRef: { subjectType: "economic_value", subjectId: subject.id },
          statement: "doomed request",
          reasonCodes: ["contested_verification"],
          supportingRefs: [{ kind: "proof_of_value", id: "never-existed" }],
          effectiveAt: subject.recordedAt,
          idempotencyKey: `w010-ac06-rollback-${subject.id}`,
        },
      ),
    ).rejects.toMatchObject({ code: "RISK_SIGNAL_VALIDATION" });
    expect((await harness.runtime.postgresAuthority.scan("disputes")).length).toBe(
      disputesBefore,
    );
    expect(await harness.runtime.auditWriter.count()).toBe(auditBefore);
  });

  test("audit lineage is atomic: exactly one audit event per committed mutation, with lineage", async () => {
    const opened = await openDefaultDispute(harness);
    const openedAudit = await harness.runtime.auditWriter.query({
      eventType: "dispute.opened",
      resourceId: opened.dispute.id,
    });
    expect(openedAudit).toHaveLength(1);
    expect(openedAudit[0]!.metadata).toMatchObject({
      idempotencyRecordId: expect.any(String),
      transactionId: expect.any(String),
      organizationScopeId: harness.organizationScopeId,
    });

    const bonded = await bondDefaultStake(harness, opened.dispute);
    const bondAudit = await harness.runtime.auditWriter.query({
      eventType: "dispute.stake_bonded",
      resourceId: bonded.id,
    });
    expect(bondAudit).toHaveLength(1);
    expect(bondAudit[0]!.metadata).toMatchObject({
      stakeId: bonded.stake.stakeId,
      transactionId: expect.any(String),
    });
    // The stake's own settlement-side audit event is separate and
    // carries the ledger transaction lineage.
    const stakeAudit = await harness.runtime.auditWriter.query({
      eventType: "stake.committed",
      resourceId: bonded.stake.stakeId ?? "",
    });
    expect(stakeAudit).toHaveLength(1);
    expect(stakeAudit[0]!.metadata).toMatchObject({
      ledgerTransactionId: expect.any(String),
      purposeId: bonded.id,
    });
  });
});
