/**
 * NET-W032-AC-05 — DETERMINISTIC QUORUM / OUTCOME DERIVATION (issue
 * #65; work order §3.5: the versioned policy contract, deterministic
 * thresholds, the closed decision vocabulary, fail-closed behaviour
 * for insufficient participation / invalid observations / conflicting
 * results / expired windows; reproducible from recorded inputs at an
 * explicit evaluation anchor).
 *
 *  - the full decision matrix as deterministic fixtures: UPHELD,
 *    DENIED, INSUFFICIENT_PARTICIPATION, NO_QUORUM,
 *    CONFLICTED_QUORUM, WINDOW_EXPIRED;
 *  - abstention semantics (participation, never agreement);
 *  - invalid-observation exclusion (the pure engine's trace
 *    re-validation: not_assigned / duplicate_validator /
 *    invalid_verdict / outside_window);
 *  - reproducibility: the pure engine is a function (identical input
 *    ⇒ identical result) and the outcome derivation is idempotent +
 *    exactly-once;
 *  - the machine-readable checks (window → participation → quorum)
 *    and the full observation trace;
 *  - the derivation REQUIRES a live assignment (fail closed).
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { deriveQuorumOutcome } from "../../src/disputes/quorum-engine.ts";
import type { ValidationChallenge } from "../../src/disputes/port.ts";
import {
  createNetW032Harness,
  deriveAssignments,
  deriveOutcome,
  key,
  observe,
  openDefaultChallenge,
  personCtx,
  runFullRound,
  shiftIso,
  type NetW032Harness,
} from "./_net-w032-harness.ts";

let harness: NetW032Harness;
let assigned: ValidationChallenge;

beforeEach(async () => {
  harness = await createNetW032Harness();
  const opened = await openDefaultChallenge(harness);
  assigned = await deriveAssignments(harness, opened.challenge);
});

afterEach(async () => {
  await harness.teardown();
});

describe("NET-W032-AC-05 deterministic quorum + outcome derivation", () => {
  test("2-of-3 UPHOLD decides UPHELD with the full machine-readable check trail", async () => {
    await observe(harness, assigned, 0, { verdict: "UPHOLD" });
    await observe(harness, assigned, 1, { verdict: "UPHOLD" });
    await observe(harness, assigned, 2, { verdict: "REJECT" });
    const outcome = await deriveOutcome(harness, assigned);
    expect(outcome.decision).toBe("UPHELD");
    expect(outcome.participation).toEqual({
      assignedCount: 3,
      submittedCount: 3,
      validCount: 3,
      upholdCount: 2,
      rejectCount: 1,
      abstainCount: 0,
      excludedCount: 0,
    });
    expect(outcome.checks).toEqual([
      { check: "window", subject: assigned.windowExpiresAt, passed: true, reason: "window_open" },
      { check: "participation", subject: "3/2", passed: true, reason: "participation_sufficient" },
      { check: "quorum", subject: expect.stringContaining("uphold=2/2"), passed: true, reason: "upheld" },
    ]);
    // The full observation trace (machine-readable, reproducible).
    expect(outcome.observations).toHaveLength(3);
    expect(outcome.observations.every((o) => o.included && o.exclusionReason === null)).toBe(true);
    expect(outcome.assignment.assignedValidatorPersonIds).toEqual(
      assigned.assignment!.entries.map((e) => e.validatorPersonId),
    );
  });

  test("2-of-3 REJECT decides DENIED", async () => {
    await observe(harness, assigned, 0, { verdict: "REJECT" });
    await observe(harness, assigned, 1, { verdict: "REJECT" });
    await observe(harness, assigned, 2, { verdict: "UPHOLD" });
    const outcome = await deriveOutcome(harness, assigned);
    expect(outcome.decision).toBe("DENIED");
    expect(outcome.participation.rejectCount).toBe(2);
    expect(outcome.checks[2]!.reason).toBe("denied");
  });

  test("fewer valid observations than the participation floor fails closed INSUFFICIENT_PARTICIPATION", async () => {
    await observe(harness, assigned, 0, { verdict: "UPHOLD" });
    const outcome = await deriveOutcome(harness, assigned);
    expect(outcome.decision).toBe("INSUFFICIENT_PARTICIPATION");
    expect(outcome.participation.validCount).toBe(1);
    expect(outcome.checks[1]).toMatchObject({
      check: "participation",
      passed: false,
      reason: "insufficient_participation",
    });
    // The fail-closed closure is still TERMINAL (the round closes).
    const closed = await harness.runtime.validationService.getChallenge(
      personCtx(harness, harness.reviewerPersonId, "ac05-closed"),
      harness.organizationScopeId,
      assigned.id,
    );
    expect(closed.outcome).not.toBeNull();
  });

  test("a split with neither threshold met fails closed NO_QUORUM (abstention counts participation, never agreement)", async () => {
    await observe(harness, assigned, 0, { verdict: "UPHOLD" });
    await observe(harness, assigned, 1, { verdict: "ABSTAIN" });
    await observe(harness, assigned, 2, { verdict: "REJECT" });
    const outcome = await deriveOutcome(harness, assigned);
    // valid=3 (abstention IS participation), uphold=1 < 2, reject=1 < 2.
    expect(outcome.participation).toMatchObject({
      validCount: 3,
      upholdCount: 1,
      rejectCount: 1,
      abstainCount: 1,
    });
    expect(outcome.decision).toBe("NO_QUORUM");
    expect(outcome.checks[2]!.reason).toBe("no_quorum");
  });

  test("2 UPHOLD + 1 ABSTAIN decides UPHELD (abstention does not dilute the threshold)", async () => {
    await observe(harness, assigned, 0, { verdict: "UPHOLD" });
    await observe(harness, assigned, 1, { verdict: "UPHOLD" });
    await observe(harness, assigned, 2, { verdict: "ABSTAIN" });
    const outcome = await deriveOutcome(harness, assigned);
    expect(outcome.decision).toBe("UPHELD");
    expect(outcome.participation.abstainCount).toBe(1);
  });

  test("BOTH thresholds met fails closed CONFLICTED_QUORUM (a contradictory split never coin-flips)", async () => {
    // A 4-validator policy with 2/2 thresholds: 2 UPHOLD + 2 REJECT.
    const conflictedPolicyId = `w032-conflicted-${key("p")}`;
    await harness.runtime.validationPolicyService.createPolicyVersion(
      harness.bootstrapCtx,
      {
        organizationScopeId: harness.organizationScopeId,
        policyId: conflictedPolicyId,
        version: 1,
        assignmentCardinality: 4,
        minimumSubmitted: 2,
        upholdThreshold: 2,
        rejectThreshold: 2,
        challengeWindowMs: 14 * 24 * 60 * 60 * 1000,
        validatorStakeRequirementCredits: 0,
      },
    );
    const opened = await openDefaultChallenge(harness, {
      policyId: conflictedPolicyId,
    });
    const four = await deriveAssignments(harness, opened.challenge);
    await observe(harness, four, 0, { verdict: "UPHOLD" });
    await observe(harness, four, 1, { verdict: "UPHOLD" });
    await observe(harness, four, 2, { verdict: "REJECT" });
    await observe(harness, four, 3, { verdict: "REJECT" });
    const outcome = await deriveOutcome(harness, four);
    expect(outcome.decision).toBe("CONFLICTED_QUORUM");
    expect(outcome.checks[2]).toMatchObject({
      passed: true,
      reason: "conflicted_quorum",
    });
  });

  test("an evaluation anchor after the window expiry fails closed WINDOW_EXPIRED (even with a full quorum)", async () => {
    await observe(harness, assigned, 0, { verdict: "UPHOLD" });
    await observe(harness, assigned, 1, { verdict: "UPHOLD" });
    await observe(harness, assigned, 2, { verdict: "UPHOLD" });
    const outcome = await deriveOutcome(harness, assigned, {
      evaluatedAt: shiftIso(assigned.windowExpiresAt, 1000),
    });
    expect(outcome.decision).toBe("WINDOW_EXPIRED");
    expect(outcome.checks[0]).toMatchObject({
      check: "window",
      passed: false,
      reason: "window_expired",
    });
    // The in-window observations are still traced (auditable) but the
    // decision is fail-closed.
    expect(outcome.observations.every((o) => o.included)).toBe(true);
  });

  test("the PURE engine is deterministic (identical input ⇒ identical result) and re-validates observations", () => {
    const policy = {
      assignmentCardinality: 3,
      minimumSubmitted: 2,
      upholdThreshold: 2,
      rejectThreshold: 2,
      challengeWindowMs: 14 * 24 * 60 * 60 * 1000,
      validatorStakeRequirementCredits: 0,
    };
    const windowStartAt = "2024-07-01T00:00:00.000Z";
    const windowExpiresAt = "2024-07-15T00:00:00.000Z";
    const observations = [
      // Assigned + in-window + valid.
      { observationId: "obs-1", validatorPersonId: "v1", verdict: "UPHOLD", observedAt: "2024-07-02T00:00:00.000Z" },
      // NOT assigned → excluded.
      { observationId: "obs-2", validatorPersonId: "vX", verdict: "UPHOLD", observedAt: "2024-07-02T00:00:00.000Z" },
      // Duplicate validator → excluded (obs-3 wins by (observedAt, id)).
      { observationId: "obs-4", validatorPersonId: "v2", verdict: "REJECT", observedAt: "2024-07-03T00:00:00.000Z" },
      { observationId: "obs-3", validatorPersonId: "v2", verdict: "UPHOLD", observedAt: "2024-07-03T00:00:00.000Z" },
      // Outside the window → excluded.
      { observationId: "obs-5", validatorPersonId: "v3", verdict: "UPHOLD", observedAt: "2024-07-16T00:00:00.000Z" },
      // Invalid verdict → excluded.
      { observationId: "obs-6", validatorPersonId: "v3", verdict: "MAYBE", observedAt: "2024-07-04T00:00:00.000Z" },
    ];
    const input = {
      policy,
      windowStartAt,
      windowExpiresAt,
      evaluatedAt: "2024-07-05T00:00:00.000Z",
      assignedValidatorPersonIds: ["v1", "v2", "v3"],
      observations,
    };
    const first = deriveQuorumOutcome(input);
    const second = deriveQuorumOutcome(input);
    expect(first).toEqual(second);
    // The exclusion trace: every invalid observation is excluded with
    // its machine-readable reason and never counted.
    const traceById = new Map(first.trace.map((t) => [t.observationId, t]));
    expect(traceById.get("obs-2")!.exclusionReason).toBe("not_assigned");
    expect(traceById.get("obs-4")!.exclusionReason).toBe("duplicate_validator");
    expect(traceById.get("obs-3")!.exclusionReason).toBeNull();
    expect(traceById.get("obs-5")!.exclusionReason).toBe("outside_window");
    expect(traceById.get("obs-6")!.exclusionReason).toBe("invalid_verdict");
    expect(first.participation).toEqual({
      assignedCount: 3,
      submittedCount: 6,
      validCount: 2,
      upholdCount: 2,
      rejectCount: 0,
      abstainCount: 0,
      excludedCount: 4,
    });
    // validCount 2 ≥ minimumSubmitted 2, uphold 2 ≥ 2 ⇒ UPHELD despite
    // the noise (invalid observations NEVER count).
    expect(first.decision).toBe("UPHELD");
  });

  test("the outcome derivation is idempotent (same key → byte-identical replay) and exactly-once", async () => {
    await observe(harness, assigned, 0, { verdict: "UPHOLD" });
    await observe(harness, assigned, 1, { verdict: "UPHOLD" });
    const first = await deriveOutcome(harness, assigned, {
      idempotencyKey: "ac05-derive-fixed",
    });
    const replay = await deriveOutcome(harness, assigned, {
      idempotencyKey: "ac05-derive-fixed",
    });
    // Byte-identical replay (the immutable record, returned unchanged).
    expect(replay).toEqual(first);
    expect(replay.id).toBe(first.id);
    // A fresh key on the closed round → CONFLICT.
    await expect(
      deriveOutcome(harness, assigned, { idempotencyKey: key("ac05-second") }),
    ).rejects.toMatchObject({
      code: "CONFLICT",
      message: expect.stringContaining("CLOSED"),
    });
  });

  test("derivation requires a LIVE assignment set and a sane anchor (fail closed)", async () => {
    const opened = await openDefaultChallenge(harness);
    await expect(
      deriveOutcome(harness, opened.challenge),
    ).rejects.toMatchObject({
      code: "VALIDATION_VALIDATION",
      message: expect.stringContaining("derive assignments before deriving the outcome"),
    });
    await expect(
      deriveOutcome(harness, assigned, {
        evaluatedAt: shiftIso(assigned.effectiveAt, -1000),
      }),
    ).rejects.toMatchObject({
      code: "VALIDATION_VALIDATION",
      message: expect.stringContaining("precedes the round window start"),
    });
  });

  test("the immutable outcome record carries the assignment snapshot, policy lineage and protocol version", async () => {
    const round = await runFullRound(harness);
    expect(round.outcome.decision).toBe("UPHELD");
    expect(round.outcome.challengeId).toBe(round.challenge.id);
    expect(round.outcome.policyId).toBe(harness.defaultPolicyId);
    expect(round.outcome.policyVersion).toBe(1);
    expect(round.outcome.assignment.setId).toBe(round.challenge.assignment!.setId);
    expect(round.outcome.evaluatedAt).toBe(
      shiftIso(round.challenge.effectiveAt, 3600_000 * 3),
    );
    expect(round.outcome.protocolVersion).toBe("NET-W032:1");
    expect(round.outcome.stakeOutcomes).toEqual([]);
    expect(round.outcome.applied).toBeNull();
  });

  test("the derivation commits the validation_outcome.derived audit event with decision + counts + checks", async () => {
    const round = await runFullRound(harness);
    const events = await harness.runtime.auditWriter.query({
      eventType: "validation_outcome.derived",
      resourceId: round.outcome.id,
    });
    expect(events).toHaveLength(1);
    expect(events[0]!.metadata).toMatchObject({
      organizationScopeId: harness.organizationScopeId,
      outcomeId: round.outcome.id,
      challengeId: round.challenge.id,
      decision: "UPHELD",
      evaluatedAt: round.outcome.evaluatedAt,
      participation: round.outcome.participation,
      idempotencyRecordId: expect.any(String),
      transactionId: expect.any(String),
    });
  });

  test("closed decision vocabulary is pinned (the closed outcome set)", async () => {
    const { VALIDATION_DECISIONS, ACCEPTED_VALIDATION_DECISIONS } = await import(
      "../../src/core/validation.ts"
    );
    expect(VALIDATION_DECISIONS).toEqual([
      "UPHELD",
      "DENIED",
      "INSUFFICIENT_PARTICIPATION",
      "NO_QUORUM",
      "CONFLICTED_QUORUM",
      "WINDOW_EXPIRED",
    ]);
    expect(ACCEPTED_VALIDATION_DECISIONS).toEqual(["UPHELD", "DENIED"]);
  });
});
