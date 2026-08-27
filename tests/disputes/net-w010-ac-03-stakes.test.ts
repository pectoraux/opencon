/**
 * NET-W010-AC-03 — Stake semantics are explicit and use the
 * settlement authority without hidden balance mutation.
 *
 * Evidence: committing a stake moves credits into the owner's
 * stake_escrow through balanced ledger postings (conservation holds);
 * an over-commitment is rejected by the posting layer's balance
 * guard; one COMMITTED stake per purpose; release returns the escrow;
 * forfeit moves it to protocol recognition; the ledger transactions
 * carry the stake subject lineage; the disputes domain only reads
 * stakes (bonding verifies through the read-only lookup).
 */

import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import {
  createNetW010Harness,
  ensureCreditsFor,
  openBondedDispute,
  challengerCtx,
  reviewerCtx,
  type NetW010Harness,
} from "./_net-w010-harness.ts";
import {
  economicAccountId,
  assertGlobalConservation,
} from "../../src/settlement/ledger.ts";

let harness: NetW010Harness;

beforeAll(async () => {
  harness = await createNetW010Harness();
});

afterAll(async () => {
  await harness.teardown();
});

/** The owner's current credits + escrow balances (from the ledger). */
async function balances(personId: string) {
  const summary = await harness.runtime.economicLedgerService.getParticipantSummary(
    harness.bootstrapCtx,
    harness.organizationScopeId,
    personId,
  );
  const entries = await harness.runtime.postgresAuthority.scan<{
    accountId: string;
    direction: string;
    amount: number;
    unit: string;
  }>("economic_ledger_entries");
  const escrowAccountId = economicAccountId(
    harness.organizationScopeId,
    personId,
    "stake_escrow",
    "credits",
  );
  const escrowEntries = entries
    .map((r) => r.value)
    .filter((e) => e.accountId === escrowAccountId);
  const escrow =
    escrowEntries.reduce(
      (sum, e) => sum + (e.direction === "credit" ? e.amount : -e.amount),
      0,
    );
  return { credits: summary.credits, escrow };
}

describe("NET-W010-AC-03 explicit stake semantics through the settlement authority", () => {
  test("committing a stake encumbers credits into the owner's escrow (balanced postings)", async () => {
    await ensureCreditsFor(harness, harness.challengerPersonId, 100);
    const before = await balances(harness.challengerPersonId);

    // Open + bond manually (openBondedDispute would ensure MORE
    // credits between the balance snapshots).
    const { openDefaultDispute, bondDefaultStake } = await import(
      "./_net-w010-harness.ts"
    );
    const opened = await openDefaultDispute(harness);
    const dispute = await bondDefaultStake(harness, opened.dispute);
    expect(dispute.stake.stakeId).toBeTruthy();
    expect(dispute.state).toBe("OPEN");

    const after = await balances(harness.challengerPersonId);
    expect(after.credits).toBe(before.credits - 10);
    expect(after.escrow).toBe(before.escrow + 10);
    // Global conservation still holds (no value/credits created or
    // destroyed by staking).
    const { assertGlobalConservation: assert } = await import(
      "../settlement/_net-w008-harness.ts"
    );
    await assert(harness.w009.w008);
  });

  test("the stake record carries the purpose linkage + ledger subject lineage", async () => {
    const { dispute } = await openBondedDispute(harness);
    const stake = await harness.runtime.stakeService.getStake(
      harness.bootstrapCtx,
      dispute.stake.stakeId!,
    );
    expect(stake.state).toBe("COMMITTED");
    expect(stake.unit).toBe("credits");
    expect(stake.amount).toBe(dispute.stake.requirement.amount);
    expect(stake.ownerPersonId).toBe(dispute.challengerPersonId);
    expect(stake.purpose).toEqual({
      kind: "dispute_challenge",
      id: dispute.id,
    });
    expect(stake.transactionId).toBeTruthy();
    // The commit ledger transaction carries the stake subject lineage.
    const tx = await harness.runtime.economicLedgerService.getTransaction(
      harness.bootstrapCtx,
      stake.transactionId,
    );
    expect(tx.kind).toBe("stake_commit");
    expect(tx.subject).toEqual({ kind: "stake", id: stake.id });
    expect(tx.entries).toHaveLength(2);
  });

  test("an over-commitment is rejected by the ledger's balance guard (conservation)", async () => {
    // The dedicated reviewer never earned credits.
    const subject = await (
      await import("./_net-w010-harness.ts")
    ).createChallengeableValue(harness);
    const opened = await harness.runtime.disputeService.openDispute(
      personReviewerCtx(),
      {
        organizationScopeId: harness.organizationScopeId,
        subjectRef: { subjectType: "economic_value", subjectId: subject.id },
        statement: "a stakeless reviewer cannot challenge-and-bond",
        reasonCodes: ["contested_verification"],
        supportingRefs: [{ kind: "economic_value", id: subject.id }],
        effectiveAt: new Date(
          Date.parse(subject.recordedAt) + 3600_000,
        ).toISOString(),
        idempotencyKey: `w010-ac03-nostake-${subject.id}`,
      },
    );
    await expect(
      harness.runtime.stakeService.commitStake(personReviewerCtx(), {
        organizationScopeId: harness.organizationScopeId,
        ownerPersonId: harness.reviewerPersonId,
        amount: 10,
        purpose: { kind: "dispute_challenge", id: opened.dispute.id },
        idempotencyKey: `w010-ac03-nostake-commit-${opened.dispute.id}`,
      }),
    ).rejects.toMatchObject({
      code: "ECONOMIC_LEDGER_VALIDATION",
    });

    function personReviewerCtx() {
      return reviewerCtx(harness, "w010-ac03-no-credits");
    }
  });

  test("one COMMITTED stake per purpose (double commit → CONFLICT)", async () => {
    const { dispute } = await openBondedDispute(harness);
    await expect(
      harness.runtime.stakeService.commitStake(
        challengerCtx(harness, "w010-ac03-double"),
        {
          organizationScopeId: dispute.organizationScopeId,
          ownerPersonId: dispute.challengerPersonId,
          amount: 10,
          purpose: { kind: "dispute_challenge", id: dispute.id },
          idempotencyKey: `w010-ac03-double-${dispute.id}`,
        },
      ),
    ).rejects.toMatchObject({ code: "CONFLICT" });
  });

  test("bonding verifies the settlement record — a foreign stake cannot bond", async () => {
    await ensureCreditsFor(harness, harness.challengerPersonId, 100);
    // A stake committed for a DIFFERENT purpose (a fresh dispute).
    const { dispute: other } = await (
      await import("./_net-w010-harness.ts")
    ).openDefaultDispute(harness);
    const staked = await harness.runtime.stakeService.commitStake(
      challengerCtx(harness, "w010-ac03-foreign"),
      {
        organizationScopeId: harness.organizationScopeId,
        ownerPersonId: harness.challengerPersonId,
        amount: 10,
        purpose: { kind: "dispute_challenge", id: other.id },
        idempotencyKey: `w010-ac03-foreign-stake-${other.id}`,
      },
    );
    // A second dispute tries to bond the first dispute's stake.
    const { dispute: target } = await (
      await import("./_net-w010-harness.ts")
    ).openDefaultDispute(harness);
    await expect(
      harness.runtime.disputeService.bondStake(
        challengerCtx(harness, "w010-ac03-foreign2"),
        {
          disputeId: target.id,
          stakeId: staked.stake.id,
          idempotencyKey: `w010-ac03-foreign-bond-${target.id}`,
        },
      ),
    ).rejects.toMatchObject({
      code: "DISPUTE_VALIDATION",
      message: expect.stringContaining("does not link dispute"),
    });
  });

  test("releasing returns the escrow to the owner (balanced, append-only outcome)", async () => {
    const { dispute } = await openBondedDispute(harness);
    const before = await balances(harness.challengerPersonId);
    const released = await harness.runtime.stakeService.releaseStake(
      harness.bootstrapCtx,
      {
        stakeId: dispute.stake.stakeId!,
        reason: "test release",
        idempotencyKey: `w010-ac03-release-${dispute.id}`,
      },
    );
    expect(released.state).toBe("RELEASED");
    expect(released.outcome).toMatchObject({
      disposition: "RELEASED",
      reason: "test release",
    });
    const after = await balances(harness.challengerPersonId);
    expect(after.credits).toBe(before.credits + 10);
    expect(after.escrow).toBe(before.escrow - 10);
    // Terminal: a second release is refused.
    await expect(
      harness.runtime.stakeService.releaseStake(harness.bootstrapCtx, {
        stakeId: dispute.stake.stakeId!,
        reason: "double release",
        idempotencyKey: `w010-ac03-release2-${dispute.id}`,
      }),
    ).rejects.toMatchObject({ code: "ECONOMIC_VALIDATION" });
  });

  test("forfeiting moves the escrow to protocol recognition (the penalty)", async () => {
    const { dispute } = await openBondedDispute(harness);
    const before = await balances(harness.challengerPersonId);
    const forfeited = await harness.runtime.stakeService.forfeitStake(
      harness.bootstrapCtx,
      {
        stakeId: dispute.stake.stakeId!,
        reason: "unsuccessful challenge",
        idempotencyKey: `w010-ac03-forfeit-${dispute.id}`,
      },
    );
    expect(forfeited.state).toBe("FORFEITED");
    expect(forfeited.outcome).toMatchObject({ disposition: "FORFEITED" });
    const after = await balances(harness.challengerPersonId);
    // The owner's credits do NOT come back; the escrow drains to the
    // protocol contra account.
    expect(after.credits).toBe(before.credits);
    expect(after.escrow).toBe(before.escrow - 10);
    const { assertGlobalConservation: assert } = await import(
      "../settlement/_net-w008-harness.ts"
    );
    await assert(harness.w009.w008);
  });

  test("conservation holds across the whole suite's ledger", async () => {
    void economicAccountId;
    void assertGlobalConservation;
    const { assertGlobalConservation: assert } = await import(
      "../settlement/_net-w008-harness.ts"
    );
    await assert(harness.w009.w008);
  });
});
