/**
 * NET-W032-AC-04 — INDEPENDENT VALIDATOR OBSERVATIONS (issue #65;
 * work order §3.4: observations tied to validator identity,
 * assignment, target reference, evaluation anchor and
 * evidence/attestation references sufficient to explain the decision;
 * validators cannot submit on behalf of another validator and cannot
 * create observations outside their assignment/scope).
 *
 *  - assignment-bound + actor-bound submission (the record's
 *    validator IS the server-derived actor);
 *  - exactly ONE observation per (round, validator) — duplicates and
 *    concurrent duplicates fail closed;
 *  - the observation anchor must fall within the round window;
 *  - the closed verdict vocabulary + evidence-backed UPHOLD/REJECT
 *    (ABSTAIN may carry none);
 *  - opaque evidence references resolve (same scope, current —
 *    W029/W031 integrity composition, revoked references fail closed).
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import type { ValidationChallenge } from "../../src/disputes/port.ts";
import {
  createAttestation,
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
  challenge = await deriveAssignments(harness, opened.challenge);
});

afterEach(async () => {
  await harness.teardown();
});

describe("NET-W032-AC-04 independent validator observations", () => {
  test("an assigned validator submits: the record is assignment/actor/target-bound with the explicit anchor", async () => {
    const entry = challenge.assignment!.entries[0]!;
    const ctx = personCtx(harness, entry.validatorPersonId, "ac04-submit");
    const result = await harness.runtime.validationService.submitObservation(ctx, {
      organizationScopeId: harness.organizationScopeId,
      challengeId: challenge.id,
      verdict: "UPHOLD",
      statement: "the referenced evidence supports the challenge",
      evidenceRefs: [{ kind: "reputation_proof", id: challenge.target.id }],
      observedAt: shiftIso(challenge.effectiveAt, 7200_000),
      idempotencyKey: key("ac04-submit"),
    });
    expect(result.created).toBe(true);
    expect(result.observation.validatorPersonId).toBe(entry.validatorPersonId);
    expect(result.observation.participantId).toBe(entry.participantId);
    expect(result.observation.assignmentSetId).toBe(challenge.assignment!.setId);
    expect(result.observation.challengeId).toBe(challenge.id);
    expect(result.observation.target).toEqual(challenge.target);
    expect(result.observation.verdict).toBe("UPHOLD");
    expect(result.observation.evidenceRefs).toEqual([
      { kind: "reputation_proof", id: challenge.target.id },
    ]);
    expect(result.observation.protocolVersion).toBe("NET-W032:1");
  });

  test("an UNASSIGNED person cannot observe (no observation outside the assignment)", async () => {
    const unassigned = harness.orderedValidatorPersonIds[4]!;
    const ctx = personCtx(harness, unassigned, "ac04-unassigned");
    await expect(
      harness.runtime.validationService.submitObservation(ctx, {
        organizationScopeId: harness.organizationScopeId,
        challengeId: challenge.id,
        verdict: "UPHOLD",
        statement: "outside the assignment",
        evidenceRefs: [{ kind: "reputation_proof", id: challenge.target.id }],
        observedAt: shiftIso(challenge.effectiveAt, 7200_000),
        idempotencyKey: key("ac04-unassigned"),
      }),
    ).rejects.toMatchObject({
      code: "VALIDATION_VALIDATION",
      message: expect.stringContaining("not an assigned validator"),
    });
  });

  test("the subject person (interested party) can never observe — they are never assigned", async () => {
    // The proof subject was never selected (the conflict-of-interest
    // exclusion at assignment derivation) — their observation attempt
    // fails the assignment binding.
    const ctx = personCtx(harness, harness.personId, "ac04-subject");
    await expect(
      harness.runtime.validationService.submitObservation(ctx, {
        organizationScopeId: harness.organizationScopeId,
        challengeId: challenge.id,
        verdict: "UPHOLD",
        statement: "self-observation attempt",
        evidenceRefs: [{ kind: "reputation_proof", id: challenge.target.id }],
        observedAt: shiftIso(challenge.effectiveAt, 7200_000),
        idempotencyKey: key("ac04-subject"),
      }),
    ).rejects.toMatchObject({
      code: "VALIDATION_VALIDATION",
      message: expect.stringContaining("not an assigned validator"),
    });
  });

  test("a second observation by the same validator fails closed (exactly one per round, fresh key)", async () => {
    const entry = challenge.assignment!.entries[1]!;
    const ctx = personCtx(harness, entry.validatorPersonId, "ac04-dup");
    const input = (k: string) => ({
      organizationScopeId: harness.organizationScopeId,
      challengeId: challenge.id,
      verdict: "REJECT",
      statement: "first observation",
      evidenceRefs: [{ kind: "reputation_proof", id: challenge.target.id }],
      observedAt: shiftIso(challenge.effectiveAt, 7200_000),
      idempotencyKey: k,
    });
    const first = await harness.runtime.validationService.submitObservation(
      ctx,
      input("ac04-dup-fixed"),
    );
    expect(first.created).toBe(true);
    // Same-key replay: created:false, identical record.
    const replay = await harness.runtime.validationService.submitObservation(
      ctx,
      input("ac04-dup-fixed"),
    );
    expect(replay.created).toBe(false);
    expect(replay.observation.id).toBe(first.observation.id);
    // Fresh key → CONFLICT.
    await expect(
      harness.runtime.validationService.submitObservation(ctx, input(key("ac04-dup-2"))),
    ).rejects.toMatchObject({
      code: "CONFLICT",
      message: expect.stringContaining("exactly one observation per validator per round"),
    });
  });

  test("concurrent duplicate submissions converge to exactly one", async () => {
    const entry = challenge.assignment!.entries[2]!;
    const ctx = personCtx(harness, entry.validatorPersonId, "ac04-race");
    const input = (k: string) => ({
      organizationScopeId: harness.organizationScopeId,
      challengeId: challenge.id,
      verdict: "UPHOLD",
      statement: "concurrent observation",
      evidenceRefs: [{ kind: "reputation_proof", id: challenge.target.id }],
      observedAt: shiftIso(challenge.effectiveAt, 7200_000),
      idempotencyKey: k,
    });
    const attempts = await Promise.allSettled([
      harness.runtime.validationService.submitObservation(ctx, input(key("ac04-race-a"))),
      harness.runtime.validationService.submitObservation(ctx, input(key("ac04-race-b"))),
    ]);
    const created = attempts.filter((a) => a.status === "fulfilled");
    const conflicts = attempts.filter((a) => a.status === "rejected");
    expect(created.length).toBe(1);
    expect(conflicts.length).toBe(1);
    if (conflicts[0]!.status === "rejected") {
      expect(conflicts[0]!.reason.code).toBe("CONFLICT");
    }
  });

  test("the observation anchor must fall within the round window (inclusive bounds)", async () => {
    const entry = challenge.assignment!.entries[0]!;
    const ctx = personCtx(harness, entry.validatorPersonId, "ac04-window");
    const base = {
      organizationScopeId: harness.organizationScopeId,
      challengeId: challenge.id,
      verdict: "ABSTAIN",
      statement: "window probe",
      evidenceRefs: [],
      idempotencyKey: key("ac04-window"),
    } as const;
    await expect(
      harness.runtime.validationService.submitObservation(ctx, {
        ...base,
        observedAt: shiftIso(challenge.effectiveAt, -1000),
        idempotencyKey: key("ac04-window-early"),
      }),
    ).rejects.toMatchObject({
      code: "VALIDATION_VALIDATION",
      message: expect.stringContaining("outside the round window"),
    });
    await expect(
      harness.runtime.validationService.submitObservation(ctx, {
        ...base,
        observedAt: shiftIso(challenge.windowExpiresAt, 1000),
        idempotencyKey: key("ac04-window-late"),
      }),
    ).rejects.toMatchObject({
      code: "VALIDATION_VALIDATION",
      message: expect.stringContaining("outside the round window"),
    });
    // The exact bounds are legal (inclusive).
    const atStart = await harness.runtime.validationService.submitObservation(ctx, {
      ...base,
      observedAt: challenge.effectiveAt,
      idempotencyKey: key("ac04-window-exact"),
    });
    expect(atStart.created).toBe(true);
  });

  test("the verdict vocabulary is closed; UPHOLD/REJECT require ≥1 evidence reference; ABSTAIN carries none", async () => {
    const entry = challenge.assignment!.entries[0]!;
    const ctx = personCtx(harness, entry.validatorPersonId, "ac04-verdict");
    const base = {
      organizationScopeId: harness.organizationScopeId,
      challengeId: challenge.id,
      statement: "verdict probe",
      observedAt: shiftIso(challenge.effectiveAt, 7200_000),
      evidenceRefs: [] as { kind: string; id: string }[],
    } as const;
    await expect(
      harness.runtime.validationService.submitObservation(ctx, {
        ...base,
        verdict: "MAYBE",
        evidenceRefs: [{ kind: "reputation_proof", id: challenge.target.id }],
        idempotencyKey: key("ac04-verdict-bad"),
      }),
    ).rejects.toMatchObject({
      code: "VALIDATION_VALIDATION",
      message: expect.stringContaining("UPHOLD, REJECT or ABSTAIN"),
    });
    await expect(
      harness.runtime.validationService.submitObservation(ctx, {
        ...base,
        verdict: "UPHOLD",
        idempotencyKey: key("ac04-verdict-noevidence"),
      }),
    ).rejects.toMatchObject({
      code: "VALIDATION_VALIDATION",
      message: expect.stringContaining("at least one evidence reference"),
    });
    // ABSTAIN with no references is legal (explicit abstention).
    const abstain = await harness.runtime.validationService.submitObservation(ctx, {
      ...base,
      verdict: "ABSTAIN",
      idempotencyKey: key("ac04-verdict-abstain"),
    });
    expect(abstain.observation.verdict).toBe("ABSTAIN");
    expect(abstain.observation.evidenceRefs).toHaveLength(0);
  });

  test("evidence references must RESOLVE (unknown ids fail closed)", async () => {
    const entry = challenge.assignment!.entries[0]!;
    const ctx = personCtx(harness, entry.validatorPersonId, "ac04-unresolved");
    await expect(
      harness.runtime.validationService.submitObservation(ctx, {
        organizationScopeId: harness.organizationScopeId,
        challengeId: challenge.id,
        verdict: "UPHOLD",
        statement: "unresolved reference",
        evidenceRefs: [{ kind: "signed_attestation", id: "no-such-attestation" }],
        observedAt: shiftIso(challenge.effectiveAt, 7200_000),
        idempotencyKey: key("ac04-unresolved-att"),
      }),
    ).rejects.toMatchObject({
      code: "NOT_FOUND",
      message: expect.stringContaining("does not resolve to a signed attestation"),
    });
    await expect(
      harness.runtime.validationService.submitObservation(ctx, {
        organizationScopeId: harness.organizationScopeId,
        challengeId: challenge.id,
        verdict: "UPHOLD",
        statement: "unresolved proof reference",
        evidenceRefs: [{ kind: "reputation_proof", id: "no-such-proof" }],
        observedAt: shiftIso(challenge.effectiveAt, 7200_000),
        idempotencyKey: key("ac04-unresolved-proof"),
      }),
    ).rejects.toMatchObject({
      code: "NOT_FOUND",
      message: expect.stringContaining("does not resolve to a reputation proof"),
    });
  });

  test("evidence references are closed-vocabulary and scope-checked (fail closed)", async () => {
    const entry = challenge.assignment!.entries[0]!;
    const ctx = personCtx(harness, entry.validatorPersonId, "ac04-scope");
    await expect(
      harness.runtime.validationService.submitObservation(ctx, {
        organizationScopeId: harness.organizationScopeId,
        challengeId: challenge.id,
        verdict: "UPHOLD",
        statement: "bad kind",
        evidenceRefs: [{ kind: "evidence_record", id: "x" }],
        observedAt: shiftIso(challenge.effectiveAt, 7200_000),
        idempotencyKey: key("ac04-kind"),
      }),
    ).rejects.toMatchObject({
      code: "VALIDATION_VALIDATION",
      message: expect.stringContaining("signed_attestation or reputation_proof"),
    });
  });

  test("W029 integrity composition: a SIGNED ATTESTATION is a valid opaque evidence reference", async () => {
    // Create a W029 signed attestation covering the target proof's
    // platform evidence (through the evidence authority's own
    // service) and cite it.
    const opened = await openDefaultChallenge(harness);
    const assigned = await deriveAssignments(harness, opened.challenge);
    const attestation = await createAttestation(harness, opened.evidenceId);
    const entry = assigned.assignment!.entries[0]!;
    const ctx = personCtx(harness, entry.validatorPersonId, "ac04-att");
    const result = await harness.runtime.validationService.submitObservation(ctx, {
      organizationScopeId: harness.organizationScopeId,
      challengeId: assigned.id,
      verdict: "UPHOLD",
      statement: "the signed attestation covers the underlying evidence",
      evidenceRefs: [{ kind: "signed_attestation", id: attestation.id }],
      observedAt: shiftIso(assigned.effectiveAt, 7200_000),
      idempotencyKey: key("ac04-att"),
    });
    expect(result.created).toBe(true);
    expect(result.observation.evidenceRefs).toEqual([
      { kind: "signed_attestation", id: attestation.id },
    ]);
  });

  test("REVOKED evidence references fail closed (W029 attestation + W031 proof)", async () => {
    // A revoked W031 proof as evidence: challenge a DIFFERENT fresh
    // proof, revoke the target proof itself... the target proof is
    // the challenge's target; use ANOTHER proof as the evidence ref.
    const opened = await openDefaultChallenge(harness);
    const assigned = await deriveAssignments(harness, opened.challenge);
    const other = await openDefaultChallenge(harness);
    // Revoke the second proof through the reputation authority's own
    // command (the one-way mutation).
    const revokeCtx = personCtx(harness, harness.reviewerPersonId, "ac04-revoke");
    await harness.runtime.reputationProofService.revokeProof(revokeCtx, {
      organizationScopeId: harness.organizationScopeId,
      proofId: other.proof.id,
      reason: "ac04 revoked evidence",
      idempotencyKey: key("ac04-revoke"),
    });
    const entry = assigned.assignment!.entries[0]!;
    const ctx = personCtx(harness, entry.validatorPersonId, "ac04-revoked");
    await expect(
      harness.runtime.validationService.submitObservation(ctx, {
        organizationScopeId: harness.organizationScopeId,
        challengeId: assigned.id,
        verdict: "UPHOLD",
        statement: "cites revoked evidence",
        evidenceRefs: [{ kind: "reputation_proof", id: other.proof.id }],
        observedAt: shiftIso(assigned.effectiveAt, 7200_000),
        idempotencyKey: key("ac04-revoked"),
      }),
    ).rejects.toMatchObject({
      code: "VALIDATION_VALIDATION",
      message: expect.stringContaining("REVOKED reputation proof"),
    });

    // A REVOKED W029 signed attestation as evidence: revoke the
    // attestation through the evidence authority's own one-way
    // command, then cite it.
    const attestation = await createAttestation(harness, opened.evidenceId);
    await harness.runtime.signedAttestationService.revokeSignedAttestation(
      personCtx(harness, harness.reviewerPersonId, "ac04-revoke-att"),
      {
        organizationScopeId: harness.organizationScopeId,
        attestationId: attestation.id,
        reason: "ac04 revoked attestation evidence",
        idempotencyKey: key("ac04-revoke-att"),
      },
    );
    await expect(
      harness.runtime.validationService.submitObservation(ctx, {
        organizationScopeId: harness.organizationScopeId,
        challengeId: assigned.id,
        verdict: "UPHOLD",
        statement: "cites a revoked attestation",
        evidenceRefs: [{ kind: "signed_attestation", id: attestation.id }],
        observedAt: shiftIso(assigned.effectiveAt, 7200_000),
        idempotencyKey: key("ac04-revoked-att"),
      }),
    ).rejects.toMatchObject({
      code: "VALIDATION_VALIDATION",
      message: expect.stringContaining("REVOKED signed attestation"),
    });
  });

  test("the eligibility bond gates observations when the policy requires a stake (fail closed)", async () => {
    const { createStakedPolicy } = await import("./_net-w032-harness.ts");
    const stakedPolicyId = await createStakedPolicy(harness);
    const opened = await openDefaultChallenge(harness, {
      policyId: stakedPolicyId,
    });
    const assigned = await deriveAssignments(harness, opened.challenge);
    const entry = assigned.assignment!.entries[0]!;
    const ctx = personCtx(harness, entry.validatorPersonId, "ac04-stake");
    await expect(
      harness.runtime.validationService.submitObservation(ctx, {
        organizationScopeId: harness.organizationScopeId,
        challengeId: assigned.id,
        verdict: "UPHOLD",
        statement: "unbonded observation attempt",
        evidenceRefs: [{ kind: "reputation_proof", id: assigned.target.id }],
        observedAt: shiftIso(assigned.effectiveAt, 7200_000),
        idempotencyKey: key("ac04-stake"),
      }),
    ).rejects.toMatchObject({
      code: "VALIDATION_VALIDATION",
      message: expect.stringContaining("not bonded the required stake"),
    });
  });

  test("observation submission commits the validation_observation.recorded audit event with the lineage contract", async () => {
    const entry = challenge.assignment!.entries[0]!;
    const ctx = personCtx(harness, entry.validatorPersonId, "ac04-audit");
    const result = await harness.runtime.validationService.submitObservation(ctx, {
      organizationScopeId: harness.organizationScopeId,
      challengeId: challenge.id,
      verdict: "UPHOLD",
      statement: "audited observation",
      evidenceRefs: [{ kind: "reputation_proof", id: challenge.target.id }],
      observedAt: shiftIso(challenge.effectiveAt, 7200_000),
      idempotencyKey: key("ac04-audit"),
    });
    const events = await harness.runtime.auditWriter.query({
      eventType: "validation_observation.recorded",
      resourceId: result.observation.id,
    });
    expect(events).toHaveLength(1);
    expect(events[0]!.metadata).toMatchObject({
      organizationScopeId: harness.organizationScopeId,
      observationId: result.observation.id,
      challengeId: challenge.id,
      assignmentSetId: challenge.assignment!.setId,
      validatorPersonId: entry.validatorPersonId,
      verdict: "UPHOLD",
      target: `reputation_proof:${challenge.target.id}`,
      idempotencyRecordId: expect.any(String),
      transactionId: expect.any(String),
    });
  });
});
