/**
 * NET-W032-AC-02 — DETERMINISTIC ASSIGNMENT (issue #65; work order
 * §3.2: deterministic for an explicit evaluation anchor; ineligible/
 * conflicted/self-dealing candidates excluded BEFORE deterministic
 * ordering; tie-breaking and assignment cardinality frozen in code
 * and tests; wall clock forbidden).
 *
 *  - exactly ONE set per round, of exactly the policy cardinality,
 *    in the frozen (registeredAt, participant-id) order;
 *  - the §3.6 conflict-of-interest exclusions (target subject, target
 *    beneficiary, challenge initiator, explicitly conflicted,
 *    suspended) fail closed BEFORE the ordering, each recorded on
 *    the auditable considered-but-excluded trace;
 *  - cross-tenant candidates are never candidates (no default
 *    cross-tenant leakage);
 *  - an insufficient pool fails closed (no set; the round stays
 *    open);
 *  - the derivation anchor must fall within the round window.
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import type { ValidationChallenge } from "../../src/disputes/port.ts";
import {
  createNetW032Harness,
  deriveAssignments,
  key,
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

describe("NET-W032-AC-02 deterministic assignment", () => {
  test("selects exactly the cardinality in the frozen (registeredAt, id) order with selectionOrder 1..n", async () => {
    const assigned = await deriveAssignments(harness, challenge);
    expect(assigned.assignment).not.toBeNull();
    expect(assigned.assignment!.entries).toHaveLength(3);
    // The first three of the pool in the frozen deterministic order
    // ((registeredAt, id) — the repository sort; the id tie-break
    // applies when registration timestamps tie).
    expect(assigned.assignment!.entries.map((e) => e.validatorPersonId)).toEqual(
      harness.orderedValidatorPersonIds.slice(0, 3),
    );
    expect(assigned.assignment!.entries.map((e) => e.selectionOrder)).toEqual([1, 2, 3]);
    // Each entry carries the participant binding + the frozen stake
    // requirement (bookkeeping only).
    for (const entry of assigned.assignment!.entries) {
      expect(entry.participantId).toBeDefined();
      expect(entry.stake.requirementCredits).toBe(0);
      expect(entry.stake.stakeId).toBeNull();
      expect(entry.stake.bondedAt).toBeNull();
    }
  });

  test("the set derivation is idempotent (replay: created=false, same setId) and exactly-once per round", async () => {
    const first = await deriveAssignments(harness, challenge, {
      idempotencyKey: "ac02-assign-fixed",
    });
    const replay = await deriveAssignments(harness, challenge, {
      idempotencyKey: "ac02-assign-fixed",
    });
    expect(replay.assignment!.setId).toBe(first.assignment!.setId);
    // A SECOND set with a fresh key is a CONFLICT (exactly one set).
    await expect(
      deriveAssignments(harness, challenge, { idempotencyKey: key("ac02-second") }),
    ).rejects.toMatchObject({
      code: "CONFLICT",
      message: expect.stringContaining("already has a derived assignment set"),
    });
  });

  test("the TARGET SUBJECT is excluded (target_subject on the trace)", async () => {
    // Register the proof's own subject as a validator, then derive:
    // they must never be selected (self-dealing fails closed).
    const ctx = personCtx(harness, harness.personId, "ac02-subject-register");
    await harness.runtime.validatorRegistryService.registerValidator(ctx, {
      organizationScopeId: harness.organizationScopeId,
      personId: harness.personId,
      idempotencyKey: key("ac02-subject-register"),
    });
    const assigned = await deriveAssignments(harness, challenge);
    expect(assigned.assignment!.entries.map((e) => e.validatorPersonId)).not.toContain(
      harness.personId,
    );
    expect(assigned.assignment!.excluded).toContainEqual({
      personId: harness.personId,
      reason: "target_subject",
    });
  });

  test("the CHALLENGE INITIATOR is excluded (challenge_initiator)", async () => {
    const initiatorCtx = personCtx(harness, harness.challengerPersonId, "ac02-initiator");
    await harness.runtime.validatorRegistryService.registerValidator(initiatorCtx, {
      organizationScopeId: harness.organizationScopeId,
      personId: harness.challengerPersonId,
      idempotencyKey: key("ac02-initiator"),
    });
    const assigned = await deriveAssignments(harness, challenge);
    expect(assigned.assignment!.entries.map((e) => e.validatorPersonId)).not.toContain(
      harness.challengerPersonId,
    );
    expect(assigned.assignment!.excluded).toContainEqual({
      personId: harness.challengerPersonId,
      reason: "challenge_initiator",
    });
  });

  test("the target BENEFICIARY is excluded (target_beneficiary — a distinct economic claim)", async () => {
    // An economic_value target whose beneficiary is validator 4:
    // register a value owned by validator 4 through the W010 factory.
    const { createMatureValue } = await import("../settlement/_net-w008-harness.ts");
    const value = await createMatureValue(harness.w010.w009.w008, {
      amount: 100,
      beneficiaryPersonId: harness.validatorPersonIds[4]!,
    });
    const opened = await openDefaultChallenge(harness, {
      targetKind: "economic_value",
      targetId: value.id,
      effectiveAt: shiftIso(value.recordedAt, 3600_000),
    });
    const assigned = await deriveAssignments(harness, opened.challenge);
    expect(assigned.assignment!.entries.map((e) => e.validatorPersonId)).not.toContain(
      harness.validatorPersonIds[4]!,
    );
    expect(assigned.assignment!.excluded).toContainEqual({
      personId: harness.validatorPersonIds[4]!,
      reason: "target_beneficiary",
    });
    // The assignment still selects THREE eligible validators.
    expect(assigned.assignment!.entries).toHaveLength(3);
  });

  test("an EXPLICITLY CONFLICTED validator is excluded (explicitly_conflicted)", async () => {
    // Conflict the FIRST-SELECTED validator: they must drop out and
    // the next candidate (deterministic order position 4) is promoted.
    const conflictedPersonId = harness.orderedValidatorPersonIds[0]!;
    const markCtx = personCtx(harness, harness.reviewerPersonId, "ac02-conflict");
    const marked = await harness.runtime.validationService.markConflict(markCtx, {
      organizationScopeId: harness.organizationScopeId,
      challengeId: challenge.id,
      validatorPersonId: conflictedPersonId,
      reason: "ac02 declared conflict",
      idempotencyKey: key("ac02-conflict"),
    });
    expect(marked.conflicts).toEqual([conflictedPersonId]);
    const assigned = await deriveAssignments(harness, marked);
    expect(assigned.assignment!.entries.map((e) => e.validatorPersonId)).not.toContain(
      conflictedPersonId,
    );
    // The next candidate in the deterministic order is promoted.
    expect(assigned.assignment!.entries.map((e) => e.validatorPersonId)).toEqual(
      harness.orderedValidatorPersonIds.slice(1, 4),
    );
    expect(assigned.assignment!.excluded).toContainEqual({
      personId: conflictedPersonId,
      reason: "explicitly_conflicted",
    });
  });

  test("a SUSPENDED validator is excluded (suspended) and the trace is auditable", async () => {
    const suspendCtx = personCtx(harness, harness.reviewerPersonId, "ac02-suspend");
    const validators = await harness.runtime.validatorRegistryService.listValidators(
      suspendCtx,
      harness.organizationScopeId,
      "ACTIVE",
    );
    await harness.runtime.validatorRegistryService.suspendValidator(suspendCtx, {
      organizationScopeId: harness.organizationScopeId,
      validatorId: validators.find(
        (v) => v.personId === harness.validatorPersonIds[1]!,
      )!.id,
      reason: "ac02 suspension",
      idempotencyKey: key("ac02-suspend"),
    });
    const assigned = await deriveAssignments(harness, challenge);
    expect(assigned.assignment!.entries.map((e) => e.validatorPersonId)).not.toContain(
      harness.validatorPersonIds[1]!,
    );
    expect(assigned.assignment!.excluded).toContainEqual({
      personId: harness.validatorPersonIds[1]!,
      reason: "suspended",
    });
    // The auditable derivation event carries the assignment + the
    // full exclusion trace (the lineage contract).
    const events = await harness.runtime.auditWriter.query({
      eventType: "validation_challenge.assignments_derived",
      resourceId: challenge.id,
    });
    expect(events).toHaveLength(1);
    expect(events[0]!.metadata).toMatchObject({
      challengeId: challenge.id,
      assignedValidatorPersonIds: assigned.assignment!.entries.map(
        (e) => e.validatorPersonId,
      ),
      excludedCandidates: expect.arrayContaining([
        `${harness.validatorPersonIds[1]!}:suspended`,
      ]),
      idempotencyRecordId: expect.any(String),
      transactionId: expect.any(String),
    });
  });

  test("CROSS-TENANT candidates are never candidates (no leakage into the pool)", async () => {
    // Register a validator in the SECOND org — they must not appear
    // anywhere on the main-org round (neither selected nor excluded).
    const otherCtx = personCtx(harness, harness.secondOrgPersonId, "ac02-cross");
    await harness.runtime.validatorRegistryService.registerValidator(otherCtx, {
      organizationScopeId: harness.secondOrgId,
      personId: harness.secondOrgPersonId,
      idempotencyKey: key("ac02-cross"),
    });
    const assigned = await deriveAssignments(harness, challenge);
    const allPersons = [
      ...assigned.assignment!.entries.map((e) => e.validatorPersonId),
      ...assigned.assignment!.excluded.map((e) => e.personId),
    ];
    expect(allPersons).not.toContain(harness.secondOrgPersonId);
  });

  test("an INSUFFICIENT pool fails closed (no set recorded; the round stays open; retry succeeds)", async () => {
    // Suspend three of the five validators → only two remain (< 3).
    const ctx = personCtx(harness, harness.reviewerPersonId, "ac02-insufficient");
    const validators = await harness.runtime.validatorRegistryService.listValidators(
      ctx,
      harness.organizationScopeId,
      "ACTIVE",
    );
    for (const personId of harness.validatorPersonIds.slice(2)) {
      await harness.runtime.validatorRegistryService.suspendValidator(ctx, {
        organizationScopeId: harness.organizationScopeId,
        validatorId: validators.find((v) => v.personId === personId)!.id,
        reason: "ac02 insufficiency",
        idempotencyKey: key("ac02-insufficient"),
      });
    }
    await expect(
      deriveAssignments(harness, challenge, { idempotencyKey: key("ac02-insufficient") }),
    ).rejects.toMatchObject({
      code: "VALIDATION_VALIDATION",
      message: expect.stringContaining("insufficient eligible validators"),
    });
    // The round stays OPEN with no set (fail-closed, not terminal).
    const unchanged = await harness.runtime.validationService.getChallenge(
      ctx,
      harness.organizationScopeId,
      challenge.id,
    );
    expect(unchanged.assignment).toBeNull();
    expect(unchanged.outcome).toBeNull();
    // Register a fresh validator → the retry succeeds.
    const person = await harness.runtime.identityService.createIdentity(
      harness.bootstrapCtx,
      {
        displayName: "AC-02 Late Validator",
        subjectReferences: [
          { subjectId: `ac02-late-${key("p")}@example.com`, providerKind: "internal" },
        ],
      },
    );
    await harness.runtime.validatorRegistryService.registerValidator(
      personCtx(harness, person.id, "ac02-late"),
      {
        organizationScopeId: harness.organizationScopeId,
        personId: person.id,
        idempotencyKey: key("ac02-late"),
      },
    );
    const assigned = await deriveAssignments(harness, unchanged);
    expect(assigned.assignment!.entries).toHaveLength(3);
  });

  test("the derivation anchor must fall within the round window (inclusive bounds)", async () => {
    await expect(
      deriveAssignments(harness, challenge, {
        derivedAt: shiftIso(challenge.effectiveAt, -1000),
      }),
    ).rejects.toMatchObject({
      code: "VALIDATION_VALIDATION",
      message: expect.stringContaining("outside the round window"),
    });
    await expect(
      deriveAssignments(harness, challenge, {
        derivedAt: shiftIso(challenge.windowExpiresAt, 1000),
      }),
    ).rejects.toMatchObject({
      code: "VALIDATION_VALIDATION",
      message: expect.stringContaining("outside the round window"),
    });
    // The exact bounds are legal (inclusive).
    const atExpiry = await deriveAssignments(harness, challenge, {
      derivedAt: challenge.windowExpiresAt,
    });
    expect(atExpiry.assignment).not.toBeNull();
  });

  test("deriving on a CLOSED round is a CONFLICT (frozen set)", async () => {
    const assigned = await deriveAssignments(harness, challenge);
    const { observe, deriveOutcome } = await import("./_net-w032-harness.ts");
    await observe(harness, assigned, 0);
    await observe(harness, assigned, 1);
    await deriveOutcome(harness, assigned);
    await expect(
      deriveAssignments(harness, assigned, { idempotencyKey: key("ac02-closed") }),
    ).rejects.toMatchObject({
      code: "CONFLICT",
      message: expect.stringContaining("CLOSED"),
    });
  });

  test("concurrent derivations of the same round converge to exactly one set", async () => {
    const attempts = await Promise.allSettled([
      deriveAssignments(harness, challenge, { idempotencyKey: key("ac02-race-a") }),
      deriveAssignments(harness, challenge, { idempotencyKey: key("ac02-race-b") }),
    ]);
    const created = attempts.filter((a) => a.status === "fulfilled");
    const conflicts = attempts.filter((a) => a.status === "rejected");
    expect(created.length).toBe(1);
    expect(conflicts.length).toBe(1);
    if (conflicts[0]!.status === "rejected") {
      expect(conflicts[0]!.reason.code).toBe("CONFLICT");
    }
  });
});
