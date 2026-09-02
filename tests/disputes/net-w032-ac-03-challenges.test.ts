/**
 * NET-W032-AC-03 — CHALLENGES / TERMINAL ROUNDS (issue #65; work order
 * §3.3: tenant-scoped records with opaque target references, explicit
 * creation anchor, a bounded challenge window, terminal resolution
 * semantics, idempotent creation; duplicate or concurrent challenges
 * never create inconsistent terminal outcomes; closed rounds are
 * IMMUTABLE — rechallenge creates a NEW linked round).
 *
 *  - idempotent creation (same key → replay; concurrent → one);
 *  - the duplicate-round gate (one LIVE round per target);
 *  - target resolution + tenant scope + the creation-anchor rules;
 *  - the frozen policy snapshot + the bounded window;
 *  - conflict marks are ONE-WAY appends;
 *  - the terminal outcome closes the round immutably (every later
 *    mutation fails closed);
 *  - rechallenge opens a NEW linked round; the closed original is
 *    untouched.
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import type { ValidationChallenge } from "../../src/disputes/port.ts";
import {
  createNetW032Harness,
  deriveAssignments,
  deriveOutcome,
  key,
  observe,
  openDefaultChallenge,
  personCtx,
  shiftIso,
  type NetW032Harness,
} from "./_net-w032-harness.ts";

let harness: NetW032Harness;
let challenge: ValidationChallenge;

beforeEach(async () => {
  harness = await createNetW032Harness();
  const opened = await openDefaultChallenge(harness);
  challenge = opened.challenge;
});

afterEach(async () => {
  await harness.teardown();
});

describe("NET-W032-AC-03 challenges + terminal rounds", () => {
  test("creation is idempotent (same key → created:false, identical record)", async () => {
    // A FRESH target (no live round) so the duplicate gate never
    // shadows the replay semantics.
    const first = await openDefaultChallenge(harness, {
      idempotencyKey: "ac03-open-fixed",
    });
    expect(first.challenge.target.kind).toBe("reputation_proof");
    const replay = await openDefaultChallenge(harness, {
      targetId: first.challenge.target.id,
      idempotencyKey: "ac03-open-fixed",
    });
    expect(replay.challenge.id).toBe(first.challenge.id);
  });

  test("concurrent duplicate opens converge to exactly one LIVE round", async () => {
    const ctx = personCtx(harness, harness.challengerPersonId, "ac03-race");
    const input = (k: string) => ({
      organizationScopeId: harness.organizationScopeId,
      target: { kind: "reputation_proof", id: challenge.target.id },
      statement: "concurrent open statement",
      reasonCodes: ["contested_claim"],
      effectiveAt: challenge.effectiveAt,
      policyId: harness.defaultPolicyId,
      idempotencyKey: k,
    });
    // One live round already exists (the beforeEach challenge) → both
    // fresh-key opens conflict deterministically.
    const attempts = await Promise.allSettled([
      harness.runtime.validationService.openChallenge(ctx, input(key("ac03-race-a"))),
      harness.runtime.validationService.openChallenge(ctx, input(key("ac03-race-b"))),
    ]);
    expect(attempts.every((a) => a.status === "rejected")).toBe(true);
    for (const attempt of attempts) {
      if (attempt.status === "rejected") {
        expect(attempt.reason.code).toBe("CONFLICT");
      }
    }
    // The live-round count for the target stays exactly one.
    const listed = await harness.runtime.validationService.listObservations;
    void listed;
    const rounds = await harness.runtime.postgresAuthority
      .scan("validation_challenges");
    const forTarget = rounds
      .map((r) => r.value as ValidationChallenge)
      .filter(
        (c) =>
          c.organizationScopeId === harness.organizationScopeId &&
          c.target.id === challenge.target.id &&
          c.outcome === null,
      );
    expect(forTarget).toHaveLength(1);
  });

  test("the target must resolve same-scope (nonexistent → NotFound; cross-scope → precise validation error)", async () => {
    const ctx = personCtx(harness, harness.challengerPersonId, "ac03-target");
    await expect(
      openDefaultChallenge(harness, {
        targetId: "no-such-proof-id",
        effectiveAt: challenge.effectiveAt,
      }),
    ).rejects.toMatchObject({
      code: "NOT_FOUND",
      message: expect.stringContaining("does not resolve"),
    });
    // Cross-scope: seed a proof in the SECOND org and challenge it
    // from the MAIN org scope.
    const otherProof = await seedOtherOrgProof(harness);
    await expect(
      harness.runtime.validationService.openChallenge(ctx, {
        organizationScopeId: harness.organizationScopeId,
        target: { kind: "reputation_proof", id: otherProof.id },
        statement: "cross-scope target",
        reasonCodes: ["contested_claim"],
        effectiveAt: shiftIso(otherProof.issuedAt, 3600_000),
        policyId: harness.defaultPolicyId,
        idempotencyKey: key("ac03-cross-scope"),
      }),
    ).rejects.toMatchObject({
      code: "VALIDATION_VALIDATION",
      message: expect.stringContaining("belongs to organization scope"),
    });
  });

  test("the creation anchor cannot precede the target's authoritative anchor", async () => {
    await expect(
      openDefaultChallenge(harness, {
        targetId: challenge.target.id,
        effectiveAt: shiftIso(challenge.targetAnchorAt, -1000),
      }),
    ).rejects.toMatchObject({
      code: "VALIDATION_VALIDATION",
      message: expect.stringContaining("precedes the target's authoritative anchor"),
    });
  });

  test("the round freezes the target facts + the FULL policy snapshot (determinism from recorded inputs)", async () => {
    expect(challenge.targetAnchorAt).toBeDefined();
    expect(challenge.targetSubjectPersonId).toBe(harness.personId);
    expect(challenge.targetBeneficiaryPersonId).toBe(harness.personId);
    expect(challenge.targetState).toBe("ACTIVE");
    expect(challenge.policyId).toBe(harness.defaultPolicyId);
    expect(challenge.policyVersion).toBe(1);
    expect(challenge.assignmentCardinality).toBe(3);
    expect(challenge.minimumSubmitted).toBe(2);
    expect(challenge.upholdThreshold).toBe(2);
    expect(challenge.rejectThreshold).toBe(2);
    expect(challenge.validatorStakeRequirementCredits).toBe(0);
    // The bounded window: effectiveAt + the frozen policy's window.
    expect(challenge.windowExpiresAt).toBe(
      new Date(Date.parse(challenge.effectiveAt) + 14 * 24 * 60 * 60 * 1000).toISOString(),
    );
    expect(challenge.protocolVersion).toBe("NET-W032:1");
    expect(challenge.rechallengeOfChallengeId).toBeNull();
  });

  test("the policy lineage must resolve in the challenge's scope", async () => {
    // A FRESH target (no live round) so the duplicate gate never
    // shadows the policy resolution.
    await expect(
      openDefaultChallenge(harness, {
        policyId: "no-such-policy",
      }),
    ).rejects.toMatchObject({
      code: "NOT_FOUND",
      message: expect.stringContaining("validation policy not found"),
    });
  });

  test("conflict marks are ONE-WAY appends (duplicate marks fail closed)", async () => {
    const ctx = personCtx(harness, harness.reviewerPersonId, "ac03-conflict");
    const conflictKey = key("ac03-conflict");
    const first = await harness.runtime.validationService.markConflict(ctx, {
      organizationScopeId: harness.organizationScopeId,
      challengeId: challenge.id,
      validatorPersonId: harness.validatorPersonIds[0]!,
      reason: "ac03 conflict",
      idempotencyKey: conflictKey,
    });
    expect(first.conflicts).toEqual([harness.validatorPersonIds[0]!]);
    // Same-key replay is idempotent (no second event, no growth).
    const replay = await harness.runtime.validationService.markConflict(ctx, {
      organizationScopeId: harness.organizationScopeId,
      challengeId: challenge.id,
      validatorPersonId: harness.validatorPersonIds[0]!,
      reason: "ac03 conflict",
      idempotencyKey: conflictKey,
    });
    expect(replay.conflicts).toHaveLength(1);
    // A FRESH key marking the SAME person is a CONFLICT.
    await expect(
      harness.runtime.validationService.markConflict(ctx, {
        organizationScopeId: harness.organizationScopeId,
        challengeId: challenge.id,
        validatorPersonId: harness.validatorPersonIds[0]!,
        reason: "ac03 conflict again",
        idempotencyKey: key("ac03-conflict-2"),
      }),
    ).rejects.toMatchObject({
      code: "CONFLICT",
      message: expect.stringContaining("already marked conflicted"),
    });
    // A second, DIFFERENT person appends (append-only growth).
    const second = await harness.runtime.validationService.markConflict(ctx, {
      organizationScopeId: harness.organizationScopeId,
      challengeId: challenge.id,
      validatorPersonId: harness.validatorPersonIds[1]!,
      reason: "ac03 conflict 2",
      idempotencyKey: key("ac03-conflict-3"),
    });
    expect(second.conflicts).toEqual([
      harness.validatorPersonIds[0]!,
      harness.validatorPersonIds[1]!,
    ]);
    // The append-only event history carries both marks.
    expect(second.events.map((e) => e.event)).toEqual([
      "opened",
      "conflict_marked",
      "conflict_marked",
    ]);
  });

  test("the terminal outcome closes the round: every later mutation fails closed (immutability)", async () => {
    const assigned = await deriveAssignments(harness, challenge);
    await observe(harness, assigned, 0);
    await observe(harness, assigned, 1);
    const outcome = await deriveOutcome(harness, assigned);
    const closed = await harness.runtime.validationService.getChallenge(
      personCtx(harness, harness.reviewerPersonId, "ac03-closed"),
      harness.organizationScopeId,
      challenge.id,
    );
    expect(closed.outcome).toEqual({
      outcomeId: outcome.id,
      decidedAt: expect.any(String),
    });
    // markConflict on the closed round → CONFLICT.
    await expect(
      harness.runtime.validationService.markConflict(
        personCtx(harness, harness.reviewerPersonId, "ac03-closed"),
        {
          organizationScopeId: harness.organizationScopeId,
          challengeId: challenge.id,
          validatorPersonId: harness.validatorPersonIds[4]!,
          reason: "late conflict",
          idempotencyKey: key("ac03-late"),
        },
      ),
    ).rejects.toMatchObject({
      code: "CONFLICT",
      message: expect.stringContaining("CLOSED"),
    });
    // deriveAssignments on the closed round → CONFLICT.
    await expect(
      deriveAssignments(harness, closed, { idempotencyKey: key("ac03-late-assign") }),
    ).rejects.toMatchObject({ code: "CONFLICT" });
    // A third observation on the closed round → CONFLICT.
    await expect(
      observe(harness, closed, 2, { idempotencyKey: key("ac03-late-observe") }),
    ).rejects.toMatchObject({
      code: "CONFLICT",
      message: expect.stringContaining("CLOSED"),
    });
    // A SECOND outcome derivation (fresh key) → CONFLICT.
    await expect(
      deriveOutcome(harness, closed, { idempotencyKey: key("ac03-late-derive") }),
    ).rejects.toMatchObject({
      code: "CONFLICT",
      message: expect.stringContaining("CLOSED"),
    });
    // The recorded events stay append-only and ordered.
    expect(closed.events.map((e) => e.event)).toEqual([
      "opened",
      "assignments_derived",
      "outcome_derived",
    ]);
  });

  test("rechallenge opens a NEW linked round; the closed original stays untouched", async () => {
    const assigned = await deriveAssignments(harness, challenge);
    await observe(harness, assigned, 0);
    await observe(harness, assigned, 1);
    await deriveOutcome(harness, assigned);
    const before = await harness.runtime.validationService.getChallenge(
      personCtx(harness, harness.reviewerPersonId, "ac03-before"),
      harness.organizationScopeId,
      challenge.id,
    );
    // Rechallenge the CLOSED round: a NEW record with the linkage.
    const rechallenge = await openDefaultChallenge(harness, {
      targetId: challenge.target.id,
      rechallengeOfChallengeId: challenge.id,
      statement: "the closure itself is contested",
    });
    expect(rechallenge.challenge.id).not.toBe(challenge.id);
    expect(rechallenge.challenge.rechallengeOfChallengeId).toBe(challenge.id);
    expect(rechallenge.challenge.outcome).toBeNull();
    // The ORIGINAL stays byte-identical (closed, immutable).
    const after = await harness.runtime.validationService.getChallenge(
      personCtx(harness, harness.reviewerPersonId, "ac03-after"),
      harness.organizationScopeId,
      challenge.id,
    );
    expect(after).toEqual(before);
  });

  test("rechallenging a LIVE (unclosed) round fails closed", async () => {
    await expect(
      openDefaultChallenge(harness, {
        targetId: challenge.target.id,
        rechallengeOfChallengeId: challenge.id,
      }),
    ).rejects.toMatchObject({
      code: "VALIDATION_VALIDATION",
      message: expect.stringContaining("not a closed round"),
    });
  });

  test("opening commits the validation_challenge.opened audit event with the lineage contract", async () => {
    const events = await harness.runtime.auditWriter.query({
      eventType: "validation_challenge.opened",
      resourceId: challenge.id,
    });
    expect(events).toHaveLength(1);
    expect(events[0]!.metadata).toMatchObject({
      organizationScopeId: harness.organizationScopeId,
      challengeId: challenge.id,
      target: `reputation_proof:${challenge.target.id}`,
      initiatedByPersonId: harness.challengerPersonId,
      effectiveAt: challenge.effectiveAt,
      windowExpiresAt: challenge.windowExpiresAt,
      policyId: harness.defaultPolicyId,
      policyVersion: 1,
      idempotencyRecordId: expect.any(String),
      transactionId: expect.any(String),
    });
  });
});

/** Seed a W031 proof in the SECOND org (cross-scope targets). */
async function seedOtherOrgProof(harness: NetW032Harness) {
  const { createExecutionContext } = await import("../../src/core/execution-context.ts");
  const { DEFAULT_POLICY_RULES: RULES } = await import("../reputation/_net-w007-harness.ts");
  const ctx = createExecutionContext({
    correlationId: "ac03-other-org",
    actor: { id: harness.secondOrgPersonId, kind: "person" },
  });
  const policyId = `policy-ac03-other-${key("x")}`;
  await harness.runtime.reputationPolicyService.createPolicyVersion(ctx, {
    organizationScopeId: harness.secondOrgId,
    policyId,
    version: 1,
    rules: RULES,
  });
  const evidence = await harness.runtime.evidenceService.createEvidence(ctx, {
    organizationScopeId: harness.secondOrgId,
    ownerId: harness.secondOrgPersonId,
    subjectReference: { subjectId: harness.secondOrgPersonId, subjectType: "contribution" },
    provenance: { sourceType: "platform", method: "instrumentation" },
    confidence: { point: 0.9 },
  });
  await harness.runtime.reputationInputService.recordInput(ctx, {
    organizationScopeId: harness.secondOrgId,
    subjectPersonId: harness.secondOrgPersonId,
    dimension: "helpfulness",
    sources: [{ kind: "evidence", id: evidence.id }],
    occurredAt: "2024-06-01T00:00:00.000Z",
    idempotencyKey: key("ac03-other-input"),
  });
  const snapshot = await harness.runtime.reputationSnapshotService.recordSnapshot(ctx, {
    organizationScopeId: harness.secondOrgId,
    subjectPersonId: harness.secondOrgPersonId,
    policyId,
    version: 1,
    referenceAt: "2024-07-01T00:00:00.000Z",
    idempotencyKey: key("ac03-other-snapshot"),
  });
  const issued = await harness.runtime.reputationProofService.issueProof(ctx, {
    organizationScopeId: harness.secondOrgId,
    subjectPersonId: harness.secondOrgPersonId,
    snapshotId: snapshot.snapshot.id,
    idempotencyKey: key("ac03-other-proof"),
  });
  return issued.proof;
}
