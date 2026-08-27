/**
 * NET-W010-AC-07 — Resolution/control outputs remain separate from
 * economic/reputation/evidence authority.
 *
 * Evidence:
 *  - the composition-root `refuseWhenDisputed` gate (lock invariant
 *    21, the disputed half): an ACTIVE dispute covering a value
 *    record (or its upstream sources) refuses maturation, credit
 *    issuance and reward allocation through the guarded API commands;
 *    a PENDING_STAKE (unbonded) dispute NEVER gates (griefing
 *    resistance); after resolution the gate reopens;
 *  - resolution NEVER mutates reputation/evidence/workflow state
 *    (counts and states unchanged across a full dispute lifecycle);
 *  - the stake consequence executes ONLY through the settlement
 *    authority's stake commands (forfeit posts the escrow→protocol
 *    movement; conservation holds) — the dispute record only carries
 *    bookkeeping fields;
 *  - disputed-value cannot mature prematurely (the work-item DoD).
 */

import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import {
  createNetW010Harness,
  createChallengeableValue,
  ensureCreditsFor,
  openDefaultDispute,
  bondDefaultStake,
  reviewerCtx,
  type NetW010Harness,
} from "./_net-w010-harness.ts";
import { createExecutionContext } from "../../src/core/execution-context.ts";

let harness: NetW010Harness;

beforeAll(async () => {
  harness = await createNetW010Harness();
});

afterAll(async () => {
  await harness.teardown();
});

/** Count reputation snapshots + evidence records + contributions. */
async function trustSurface() {
  const snapshots = await harness.runtime.postgresAuthority.scan(
    "reputation_snapshots",
  );
  const evidence = await harness.runtime.postgresAuthority.scan(
    "evidence_records",
  );
  const contributions = await harness.runtime.postgresAuthority.scan<{
    id: string;
    state: string;
  }>("contributions");
  return {
    snapshots: snapshots.length,
    evidence: evidence.length,
    contributions: contributions.length,
    contributionStates: contributions.map((c) => `${c.value.id}:${c.value.state}`),
  };
}

describe("NET-W010-AC-07 authority separation", () => {
  test("an ACTIVE dispute refuses maturation of the disputed value (lock invariant 21)", async () => {
    await ensureCreditsFor(harness, harness.challengerPersonId, 50);
    const { createPendingValue } = await import(
      "../settlement/_net-w008-harness.ts"
    );
    // A PENDING value record matured through the GUARDED composition
    // command (the gate lives there — never in the settlement domain).
    const pending = await createPendingValue(harness.w009.w008, {
      beneficiaryPersonId: harness.personId,
    });
    // Dispute the PENDING value and bond it (formal/OPEN).
    const opened = await openDefaultDispute(harness, {
      subjectId: pending.id,
      supportingRefs: [{ kind: "economic_value", id: pending.id }],
      effectiveAt: new Date(
        Date.parse(pending.recordedAt) + 3600_000,
      ).toISOString(),
    });
    const bonded = await bondDefaultStake(harness, opened.dispute);
    expect(bonded.state).toBe("OPEN");

    const ctx = createExecutionContext({
      correlationId: "w010-ac07-gate",
      actor: { id: harness.personId, kind: "person" },
    });
    await expect(
      harness.runtime.apiCommands.matureEconomicValue(ctx, {
        valueRecordId: pending.id,
        idempotencyKey: `w010-ac07-mature-refused-${pending.id}`,
      }),
    ).rejects.toMatchObject({
      code: "DISPUTE_CHALLENGE",
      classification: "precondition",
      context: expect.objectContaining({ disputeId: bonded.id }),
    });
    // The value record is UNCHANGED (still PENDING — the disputed
    // claim did not mature).
    const still = await harness.runtime.economicValueService.getValue(
      ctx,
      pending.id,
    );
    expect(still.state).toBe("PENDING");
  });

  test("the maturation gate: PENDING_STAKE disputes never gate; resolution reopens the gate", async () => {
    await ensureCreditsFor(harness, harness.challengerPersonId, 50);
    const { createPendingValue } = await import(
      "../settlement/_net-w008-harness.ts"
    );
    const pending = await createPendingValue(harness.w009.w008, {
      beneficiaryPersonId: harness.personId,
    });

    // 1. PENDING_STAKE (unbonded) dispute on the value: the gate must
    //    NOT refuse (griefing resistance) — verify via the gate read.
    const opened = await openDefaultDispute(harness, {
      subjectId: pending.id,
      supportingRefs: [{ kind: "economic_value", id: pending.id }],
      effectiveAt: new Date(
        Date.parse(pending.recordedAt) + 3600_000,
      ).toISOString(),
    });
    const activeWhilePending =
      await harness.runtime.disputeService.listActiveBySubjectIds(
        harness.bootstrapCtx,
        harness.organizationScopeId,
        [pending.id, ...pending.sources.map((s) => s.id)],
      );
    expect(activeWhilePending).toHaveLength(0);

    // 2. Bond → formal dispute → the gate read now sees it.
    const bonded = await bondDefaultStake(harness, opened.dispute);
    const activeWhileOpen =
      await harness.runtime.disputeService.listActiveBySubjectIds(
        harness.bootstrapCtx,
        harness.organizationScopeId,
        [pending.id, ...pending.sources.map((s) => s.id)],
      );
    expect(activeWhileOpen.map((d) => d.id)).toContain(bonded.id);

    // 3. Resolve (UPHELD — the challenge wins; the claim does not
    //    mature through the dispute itself) → the gate read clears.
    await harness.runtime.disputeService.startReview(
      reviewerCtx(harness, "w010-ac07-review"),
      { disputeId: bonded.id, idempotencyKey: `w010-ac07-rv-${bonded.id}` },
    );
    const resolved = await harness.runtime.disputeService.resolveDispute(
      reviewerCtx(harness, "w010-ac07-resolve"),
      {
        disputeId: bonded.id,
        outcome: "UPHELD",
        controlDisposition: "REQUIRE_REEVALUATION",
        reasonCodes: ["merits"],
        sourceRefs: [{ kind: "economic_value", id: pending.id }],
        idempotencyKey: `w010-ac07-rz-${bonded.id}`,
      },
    );
    expect(resolved.state).toBe("RESOLVED");
    const activeAfter =
      await harness.runtime.disputeService.listActiveBySubjectIds(
        harness.bootstrapCtx,
        harness.organizationScopeId,
        [pending.id, ...pending.sources.map((s) => s.id)],
      );
    expect(activeAfter).toHaveLength(0);
  });

  test("the dispute gate covers the value's UPSTREAM SOURCES too (disputing the PoV blocks the value)", async () => {
    await ensureCreditsFor(harness, harness.reviewerPersonId, 50);
    const subject = await createChallengeableValue(harness);
    const povId = subject.sources.find((s) => s.kind === "proof_of_value")!.id;
    // Challenge the PoV itself (the value's upstream source). The
    // PoV was created moments ago — `now` is safely inside the window.
    const opened = await openDefaultDispute(harness, {
      subjectType: "proof_of_value",
      subjectId: povId,
      supportingRefs: [{ kind: "proof_of_value", id: povId }],
      effectiveAt: new Date().toISOString(),
      challengerPersonId: harness.reviewerPersonId,
    });
    const bonded = await bondDefaultStakeFor(
      opened.dispute,
      harness.reviewerPersonId,
    );
    expect(bonded.state).toBe("OPEN");
    // The gate read for the VALUE record (by its own id + sources)
    // finds the dispute on its source.
    const active = await harness.runtime.disputeService.listActiveBySubjectIds(
      harness.bootstrapCtx,
      harness.organizationScopeId,
      [subject.id, ...subject.sources.map((s) => s.id)],
    );
    expect(active.map((d) => d.id)).toContain(bonded.id);

    async function bondDefaultStakeFor(dispute: typeof opened.dispute, who: string) {
      const ctx = createExecutionContext({
        correlationId: "w010-ac07-bond",
        actor: { id: who, kind: "person" },
      });
      const staked = await harness.runtime.stakeService.commitStake(ctx, {
        organizationScopeId: dispute.organizationScopeId,
        ownerPersonId: who,
        amount: dispute.stake.requirement.amount,
        purpose: { kind: "dispute_challenge", id: dispute.id },
        idempotencyKey: `w010-ac07-src-stake-${dispute.id}`,
      });
      return harness.runtime.disputeService.bondStake(ctx, {
        disputeId: dispute.id,
        stakeId: staked.stake.id,
        idempotencyKey: `w010-ac07-src-bond-${dispute.id}`,
      });
    }
  });

  test("a full dispute lifecycle does NOT mutate reputation/evidence/workflow state", async () => {
    // Credit provisioning + subject creation FIRST (they legitimately
    // create upstream records); the trust snapshot is taken after so
    // ONLY the dispute lifecycle is measured.
    await ensureCreditsFor(harness, harness.challengerPersonId, 50);
    const subject = await createChallengeableValue(harness);
    const before = await trustSurface();
    // Full lifecycle: open → bond → review → resolve (DENIED →
    // forfeit) — the whole economic + control flow.
    const opened = await openDefaultDispute(harness, {
      subjectId: subject.id,
      supportingRefs: [{ kind: "economic_value", id: subject.id }],
      effectiveAt: new Date(
        Date.parse(subject.recordedAt) + 3600_000,
      ).toISOString(),
    });
    const bonded = await bondDefaultStake(harness, opened.dispute);
    await harness.runtime.disputeService.startReview(
      reviewerCtx(harness, "w010-ac07-lifecycle-review"),
      { disputeId: bonded.id, idempotencyKey: `w010-ac07-lr-${bonded.id}` },
    );
    const resolved = await harness.runtime.disputeService.resolveDispute(
      reviewerCtx(harness, "w010-ac07-lifecycle-resolve"),
      {
        disputeId: bonded.id,
        outcome: "DENIED",
        controlDisposition: "MAINTAIN_CONTROL",
        reasonCodes: ["no_merit"],
        sourceRefs: [
          { kind: "economic_value", id: bonded.subjectRef.subjectId },
        ],
        idempotencyKey: `w010-ac07-lz-${bonded.id}`,
      },
    );
    // The stake consequence through the settlement authority.
    const forfeited = await harness.runtime.stakeService.forfeitStake(
      harness.bootstrapCtx,
      {
        stakeId: resolved.stake.stakeId!,
        reason: "challenge denied",
        idempotencyKey: `w010-ac07-lf-${bonded.id}`,
      },
    );
    expect(forfeited.state).toBe("FORFEITED");
    await harness.runtime.disputeService.markStakeOutcome(
      harness.bootstrapCtx,
      {
        disputeId: resolved.id,
        disposition: "FORFEIT",
        stakeId: forfeited.id,
        transactionId: forfeited.outcome?.transactionId ?? null,
        idempotencyKey: `w010-ac07-lm-${bonded.id}`,
      },
    );

    const after = await trustSurface();
    // Reputation snapshots, evidence records and contribution states
    // are untouched by the dispute lifecycle (authority separation:
    // /reputation, /evidence and /workflows stay authoritative).
    expect(after.snapshots).toBe(before.snapshots);
    expect(after.evidence).toBe(before.evidence);
    expect(after.contributionStates).toEqual(before.contributionStates);
  });

  test("the dispute record carries NO economic-unit mutation surface (bookkeeping only)", async () => {
    const { dispute } = await openDefaultAndBond();
    // The only economic fields are the frozen requirement snapshot +
    // the settlement record reference + the recorded disposition —
    // no balances, no postings, no ledger transaction ids of its OWN.
    expect(Object.keys(dispute.stake).sort()).toEqual([
      "bondedAt",
      "disposition",
      "dispositionAt",
      "requirement",
      "stakeId",
    ]);
    expect(Object.keys(dispute.stake.requirement).sort()).toEqual([
      "amount",
      "unit",
    ]);

    async function openDefaultAndBond() {
      const { ensureCreditsFor, openBondedDispute } = await import(
        "./_net-w010-harness.ts"
      );
      await ensureCreditsFor(harness, harness.challengerPersonId, 50);
      return openBondedDispute(harness);
    }
  });

  test("the forfeited stake conserves globally (the penalty never mints or destroys)", async () => {
    const { assertGlobalConservation } = await import(
      "../settlement/_net-w008-harness.ts"
    );
    await assertGlobalConservation(harness.w009.w008);
  });
});
