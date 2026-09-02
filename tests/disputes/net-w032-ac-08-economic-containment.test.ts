/**
 * NET-W032-AC-08 — ECONOMIC CONTAINMENT (issue #65; work order §3.8:
 * economic consequences — stake lock, reserve, penalty, refund or
 * slash — execute ONLY through /settlement and remain subject to
 * settlement's authority and atomicity rules; W032 maintains no
 * second balance or reserve ledger; failed authority application must
 * not leave a W032 outcome claiming success).
 *
 *  - the validator eligibility bond commits through the settlement
 *    authority's own stake command (the composite), with the frozen
 *    purpose linkage `validation_assignment:{challenge}:{person}`;
 *  - the bond gate fails closed (unbonded assignments cannot observe);
 *  - the domain-side bonding VERIFIES the settlement record (owner,
 *    amount, state, purpose, window) — nothing moves here;
 *  - terminal closure dispositions the bonds deterministically:
 *    submitted → RELEASE (refund), bonded-silent → FORFEIT (slash)
 *    — through /settlement only;
 *  - global conservation holds across the whole flow (the escrow and
 *    the protocol recognition account absorb the movements);
 *  - a mid-composite failure leaves no false success (compound-key
 *    retry completes).
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import type { ValidationChallenge } from "../../src/disputes/port.ts";
import {
  createNetW032Harness,
  createStakedPolicy,
  deriveAssignments,
  key,
  openDefaultChallenge,
  personCtx,
  shiftIso,
  type NetW032Harness,
} from "./_net-w032-harness.ts";

let harness: NetW032Harness;
let stakedPolicyId: string;

beforeEach(async () => {
  harness = await createNetW032Harness();
  stakedPolicyId = await createStakedPolicy(harness);
});

afterEach(async () => {
  await harness.teardown();
});

/** Global conservation across credits + escrow + protocol recognition. */
async function conservation(harness: NetW032Harness): Promise<number> {
  const authority = harness.runtime.postgresAuthority;
  const accounts = (await authority.scan("economic_accounts")).map(
    (r) => r.value as { balance: number },
  );
  return accounts.reduce((sum, account) => sum + account.balance, 0);
}

/** A staked, assigned round ready for observations. */
async function openStakedRound(): Promise<ValidationChallenge> {
  const opened = await openDefaultChallenge(harness, {
    policyId: stakedPolicyId,
  });
  return deriveAssignments(harness, opened.challenge);
}

describe("NET-W032-AC-08 economic containment", () => {
  test("the validator eligibility bond commits through the SETTLEMENT authority (the composite) with the frozen purpose linkage", async () => {
    const assigned = await openStakedRound();
    const entry = assigned.assignment!.entries[0]!;
    const before = await conservation(harness);
    // The composition-root composite: commitStake (:stake) + bond (:bond).
    const bonded = await harness.runtime.apiCommands.bondValidatorAssignmentStake(
      personCtx(harness, entry.validatorPersonId, "ac08-bond"),
      entry.validatorPersonId,
      assigned.id,
      {
        organizationScopeId: harness.organizationScopeId,
        validatorPersonId: entry.validatorPersonId,
        idempotencyKey: key("ac08-bond"),
      },
    );
    // The domain-side bookkeeping: the assignment entry now references
    // the settlement authority's stake record.
    expect(bonded.challenge.assignment!.entries[0]!.stake.stakeId).toBe(
      bonded.stake.id,
    );
    expect(bonded.stake.state).toBe("COMMITTED");
    expect(bonded.stake.purpose).toEqual({
      kind: "validation_assignment",
      id: `${assigned.id}:${entry.validatorPersonId}`,
    });
    expect(bonded.stake.amount).toBe(10);
    // Conservation: the escrow absorbed the commitment (no value moved
    // outside settlement's accounts).
    expect(await conservation(harness)).toBe(before);
    // A second bond for the SAME validator slot fails closed (one
    // COMMITTED stake per purpose — the settlement invariant).
    await expect(
      harness.runtime.apiCommands.bondValidatorAssignmentStake(
        personCtx(harness, entry.validatorPersonId, "ac08-bond-2"),
        entry.validatorPersonId,
        assigned.id,
        {
          organizationScopeId: harness.organizationScopeId,
          validatorPersonId: entry.validatorPersonId,
          idempotencyKey: key("ac08-bond-2"),
        },
      ),
    ).rejects.toMatchObject({ code: "CONFLICT" });
  });

  test("an unbonded assignment cannot observe under a stake-requiring policy (fail-closed eligibility)", async () => {
    const assigned = await openStakedRound();
    const entry = assigned.assignment!.entries[0]!;
    await expect(
      harness.runtime.validationService.submitObservation(
        personCtx(harness, entry.validatorPersonId, "ac08-unbonded"),
        {
          organizationScopeId: harness.organizationScopeId,
          challengeId: assigned.id,
          verdict: "UPHOLD",
          statement: "unbonded attempt",
          evidenceRefs: [{ kind: "reputation_proof", id: assigned.target.id }],
          observedAt: shiftIso(assigned.effectiveAt, 7200_000),
          idempotencyKey: key("ac08-unbonded"),
        },
      ),
    ).rejects.toMatchObject({
      code: "VALIDATION_VALIDATION",
      message: expect.stringContaining("not bonded the required stake"),
    });
  });

  test("the domain-side bonding VERIFIES the settlement record (owner/amount/state/purpose/window — nothing moves here)", async () => {
    const assigned = await openStakedRound();
    const entry = assigned.assignment!.entries[0]!;
    const validatorCtx = personCtx(harness, entry.validatorPersonId, "ac08-verify");
    // SELF-BONDING only: another actor cannot bond a validator's
    // stake for them (the actor gate).
    const foreignStakeForOther = await harness.runtime.stakeService.commitStake(
      personCtx(harness, harness.reviewerPersonId, "ac08-other-actor"),
      {
        organizationScopeId: harness.organizationScopeId,
        ownerPersonId: entry.validatorPersonId,
        amount: 10,
        purpose: {
          kind: "validation_assignment",
          id: `${assigned.id}:${entry.validatorPersonId}`,
        },
        description: "stake committed by a third party",
        idempotencyKey: key("ac08-other-actor-stake"),
      },
    );
    await expect(
      harness.runtime.validationService.bondValidatorStake(
        personCtx(harness, harness.reviewerPersonId, "ac08-other-actor-bond"),
        {
          organizationScopeId: harness.organizationScopeId,
          challengeId: assigned.id,
          validatorPersonId: entry.validatorPersonId,
          stakeId: foreignStakeForOther.stake.id,
          idempotencyKey: key("ac08-other-actor-bond"),
        },
      ),
    ).rejects.toMatchObject({
      code: "VALIDATION_VALIDATION",
      message: expect.stringContaining("self-bonded"),
    });
    // A stake committed for the WRONG purpose (a dispute_challenge
    // purpose instead of validation_assignment) — directly through
    // the settlement authority: the domain bonding must refuse it.
    const foreignStake = await harness.runtime.stakeService.commitStake(
      validatorCtx,
      {
        organizationScopeId: harness.organizationScopeId,
        ownerPersonId: entry.validatorPersonId,
        amount: 10,
        purpose: { kind: "dispute_challenge", id: assigned.id },
        description: "wrong purpose stake",
        idempotencyKey: key("ac08-foreign-stake"),
      },
    );
    await expect(
      harness.runtime.validationService.bondValidatorStake(validatorCtx, {
        organizationScopeId: harness.organizationScopeId,
        challengeId: assigned.id,
        validatorPersonId: entry.validatorPersonId,
        stakeId: foreignStake.stake.id,
        idempotencyKey: key("ac08-foreign-bond"),
      }),
    ).rejects.toMatchObject({
      code: "VALIDATION_VALIDATION",
      message: expect.stringContaining("does not link validator assignment"),
    });
    // A stake with the WRONG AMOUNT is refused (the frozen exact
    // requirement) — a DIFFERENT validator slot's purpose (settlement
    // allows one COMMITTED stake per purpose).
    const secondEntry = assigned.assignment!.entries[1]!;
    const wrongAmount = await harness.runtime.stakeService.commitStake(
      validatorCtx,
      {
        organizationScopeId: harness.organizationScopeId,
        ownerPersonId: secondEntry.validatorPersonId,
        amount: 20,
        purpose: {
          kind: "validation_assignment",
          id: `${assigned.id}:${secondEntry.validatorPersonId}`,
        },
        description: "wrong amount stake",
        idempotencyKey: key("ac08-wrong-amount"),
      },
    );
    await expect(
      harness.runtime.validationService.bondValidatorStake(
        personCtx(harness, secondEntry.validatorPersonId, "ac08-wrong-amount-bond"),
        {
          organizationScopeId: harness.organizationScopeId,
          challengeId: assigned.id,
          validatorPersonId: secondEntry.validatorPersonId,
          stakeId: wrongAmount.stake.id,
          idempotencyKey: key("ac08-wrong-amount-bond"),
        },
      ),
    ).rejects.toMatchObject({
      code: "VALIDATION_VALIDATION",
      message: expect.stringContaining("does not match the frozen requirement"),
    });
  });

  test("terminal closure dispositions the bonds deterministically through /settlement: submitted → RELEASE, bonded-silent → FORFEIT", async () => {
    const assigned = await openStakedRound();
    const entries = assigned.assignment!.entries;
    const before = await conservation(harness);
    // Bond all three validators; only the first two submit.
    for (const entry of entries) {
      await harness.runtime.apiCommands.bondValidatorAssignmentStake(
        personCtx(harness, entry.validatorPersonId, "ac08-bond"),
        entry.validatorPersonId,
        assigned.id,
        {
          organizationScopeId: harness.organizationScopeId,
          validatorPersonId: entry.validatorPersonId,
          idempotencyKey: key("ac08-bond"),
        },
      );
    }
    for (const entry of entries.slice(0, 2)) {
      await harness.runtime.validationService.submitObservation(
        personCtx(harness, entry.validatorPersonId, "ac08-observe"),
        {
          organizationScopeId: harness.organizationScopeId,
          challengeId: assigned.id,
          verdict: "UPHOLD",
          statement: "bonded observation",
          evidenceRefs: [{ kind: "reputation_proof", id: assigned.target.id }],
          observedAt: shiftIso(assigned.effectiveAt, 7200_000),
          idempotencyKey: key("ac08-observe"),
        },
      );
    }
    // The resolution composite: derive + disposition + record.
    const resolved = await harness.runtime.apiCommands.resolveValidationRound(
      personCtx(harness, harness.reviewerPersonId, "ac08-resolve"),
      harness.reviewerPersonId,
      assigned.id,
      {
        organizationScopeId: harness.organizationScopeId,
        evaluatedAt: shiftIso(assigned.effectiveAt, 10800_000),
        idempotencyKey: key("ac08-resolve"),
      },
    );
    expect(resolved.outcome.decision).toBe("UPHELD");
    expect(resolved.stakes).toHaveLength(3);
    const byDisposition = new Map(
      resolved.stakes.map((s) => [s.id, s.state]),
    );
    // The two SUBMITTERS were RELEASED (refund).
    for (const entry of entries.slice(0, 2)) {
      const stakeId = (await harness.runtime.validationService.getChallenge(
        personCtx(harness, harness.reviewerPersonId, "ac08-check"),
        harness.organizationScopeId,
        assigned.id,
      )).assignment!.entries.find((e) => e.validatorPersonId === entry.validatorPersonId)!.stake.stakeId!;
      expect(byDisposition.get(stakeId)).toBe("RELEASED");
    }
    // The bonded-SILENT validator was FORFEITED (the slash).
    const silentStakeId = (await harness.runtime.validationService.getChallenge(
      personCtx(harness, harness.reviewerPersonId, "ac08-check"),
      harness.organizationScopeId,
      assigned.id,
    )).assignment!.entries[2]!.stake.stakeId!;
    expect(byDisposition.get(silentStakeId)).toBe("FORFEITED");
    // The outcome records ALL THREE stake outcomes (append-only).
    expect(resolved.outcome.stakeOutcomes).toHaveLength(3);
    expect(
      resolved.outcome.stakeOutcomes.filter((s) => s.disposition === "RELEASE"),
    ).toHaveLength(2);
    expect(
      resolved.outcome.stakeOutcomes.filter((s) => s.disposition === "FORFEIT"),
    ).toHaveLength(1);
    // Global conservation: 2 releases refunded + 1 forfeit moved to the
    // protocol recognition account (a ZERO-SUM closed system).
    expect(await conservation(harness)).toBe(before);
  });

  test("a mid-composite failure leaves NO false success (retry with the same compound keys completes)", async () => {
    const assigned = await openStakedRound();
    const entry = assigned.assignment!.entries[0]!;
    await harness.runtime.apiCommands.bondValidatorAssignmentStake(
      personCtx(harness, entry.validatorPersonId, "ac08-bond"),
      entry.validatorPersonId,
      assigned.id,
      {
        organizationScopeId: harness.organizationScopeId,
        validatorPersonId: entry.validatorPersonId,
        idempotencyKey: key("ac08-bond"),
      },
    );
    await harness.runtime.validationService.submitObservation(
      personCtx(harness, entry.validatorPersonId, "ac08-observe"),
      {
        organizationScopeId: harness.organizationScopeId,
        challengeId: assigned.id,
        verdict: "UPHOLD",
        statement: "bonded observation",
        evidenceRefs: [{ kind: "reputation_proof", id: assigned.target.id }],
        observedAt: shiftIso(assigned.effectiveAt, 7200_000),
        idempotencyKey: key("ac08-observe"),
      },
    );
    // A resolution attempt with an INVALID anchor fails BEFORE any
    // economic effect: the derived outcome never happens (the anchor
    // validation precedes the composite).
    await expect(
      harness.runtime.apiCommands.resolveValidationRound(
        personCtx(harness, harness.reviewerPersonId, "ac08-bad-anchor"),
        harness.reviewerPersonId,
        assigned.id,
        {
          organizationScopeId: harness.organizationScopeId,
          evaluatedAt: shiftIso(assigned.effectiveAt, -1000),
          idempotencyKey: key("ac08-bad-anchor"),
        },
      ),
    ).rejects.toMatchObject({
      code: "VALIDATION_VALIDATION",
      message: expect.stringContaining("precedes the round window start"),
    });
    // The round is still OPEN (no outcome, no stake dispositions).
    const unchanged = await harness.runtime.validationService.getChallenge(
      personCtx(harness, harness.reviewerPersonId, "ac08-open"),
      harness.organizationScopeId,
      assigned.id,
    );
    expect(unchanged.outcome).toBeNull();
    const stakesBefore = (await harness.runtime.postgresAuthority.scan("stakes"))
      .map((r) => (r.value as { state: string }).state);
    expect(stakesBefore.every((s) => s === "COMMITTED")).toBe(true);
    // The retry with a correct anchor completes the whole composite.
    const resolved = await harness.runtime.apiCommands.resolveValidationRound(
      personCtx(harness, harness.reviewerPersonId, "ac08-retry"),
      harness.reviewerPersonId,
      assigned.id,
      {
        organizationScopeId: harness.organizationScopeId,
        evaluatedAt: shiftIso(assigned.effectiveAt, 10800_000),
        idempotencyKey: key("ac08-retry"),
      },
    );
    expect(resolved.outcome.decision).toBe("INSUFFICIENT_PARTICIPATION");
    // The single bonded SUBMITTED validator was released.
    expect(resolved.outcome.stakeOutcomes).toHaveLength(1);
    expect(resolved.outcome.stakeOutcomes[0]!.disposition).toBe("RELEASE");
  });

  test("the domain-only derivation adds ZERO settlement records (no second economic ledger)", async () => {
    const assigned = await openStakedRound();
    const before = await harness.runtime.postgresAuthority.scan("stakes");
    const txBefore = await harness.runtime.postgresAuthority.scan(
      "economic_ledger_transactions",
    );
    // Derive the outcome WITHOUT the composite (service level): no
    // stake dispositions happen (they are the composite's job).
    await harness.runtime.validationService.deriveOutcome(
      personCtx(harness, harness.reviewerPersonId, "ac08-domain-derive"),
      {
        organizationScopeId: harness.organizationScopeId,
        challengeId: assigned.id,
        evaluatedAt: shiftIso(assigned.effectiveAt, 10800_000),
        idempotencyKey: key("ac08-domain-derive"),
      },
    );
    const after = await harness.runtime.postgresAuthority.scan("stakes");
    const txAfter = await harness.runtime.postgresAuthority.scan(
      "economic_ledger_transactions",
    );
    expect(after).toEqual(before);
    expect(txAfter).toEqual(txBefore);
  });

  test("the stake events carry the settlement audit lineage + the domain bookkeeping events", async () => {
    const assigned = await openStakedRound();
    const entry = assigned.assignment!.entries[0]!;
    const bonded = await harness.runtime.apiCommands.bondValidatorAssignmentStake(
      personCtx(harness, entry.validatorPersonId, "ac08-audit"),
      entry.validatorPersonId,
      assigned.id,
      {
        organizationScopeId: harness.organizationScopeId,
        validatorPersonId: entry.validatorPersonId,
        idempotencyKey: key("ac08-audit"),
      },
    );
    // The SETTLEMENT authority's own audit event (stake.committed).
    const stakeEvents = await harness.runtime.auditWriter.query({
      eventType: "stake.committed",
      resourceId: bonded.stake.id,
    });
    expect(stakeEvents).toHaveLength(1);
    // The DOMAIN bookkeeping event (validation_challenge.stake_bonded).
    const bondEvents = await harness.runtime.auditWriter.query({
      eventType: "validation_challenge.stake_bonded",
      resourceId: assigned.id,
    });
    expect(bondEvents).toHaveLength(1);
    expect(bondEvents[0]!.metadata).toMatchObject({
      challengeId: assigned.id,
      validatorPersonId: entry.validatorPersonId,
      stakeId: bonded.stake.id,
      idempotencyRecordId: expect.any(String),
      transactionId: expect.any(String),
    });
  });
});
