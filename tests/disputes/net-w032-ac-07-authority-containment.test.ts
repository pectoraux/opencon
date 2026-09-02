/**
 * NET-W032-AC-07 — AUTHORITY CONTAINMENT (issue #65; work order §3.8:
 * validators cannot directly mutate workflow/reputation/evidence/
 * settlement state; a quorum result is a RECOMMENDATION/DECISION — the
 * owning authority alone applies it; the presentation/read surfaces
 * are not hidden mutation paths).
 *
 *  - a full validation lifecycle (open → conflict → assign → observe →
 *    derive) leaves the owning authorities' collections byte-identical
 *    (the W010 trustSurface discipline);
 *  - the derivation itself adds ZERO economic records (no second
 *    balance or reserve ledger — /settlement is the only economic
 *    surface, and nothing is touched before the sanctioned composite);
 *  - the challenge record carries NO economic mutation surface
 *    (bookkeeping-only key-set pin);
 *  - the application composite is the ONLY path that mutates the
 *    target proof (through the /reputation authority's own command);
 *  - observation evidence references stay OPAQUE (no attestation
 *    statement/coverage content crosses into validation records).
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import type { ValidationChallenge } from "../../src/disputes/port.ts";
import {
  createAttestation,
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

beforeEach(async () => {
  harness = await createNetW032Harness();
});

afterEach(async () => {
  await harness.teardown();
});

/**
 * The trust surface: the owning authorities' collections that a
 * validation lifecycle must leave UNTOUCHED (the W010-AC-07
 * discipline; reputation proofs count as untouched until the explicit
 * application composite runs).
 */
async function trustSurface(harness: NetW032Harness) {
  const authority = harness.runtime.postgresAuthority;
  const scan = async (collection: string) =>
    (await authority.scan(collection)).map((r) => r.value);
  return {
    proofs: await scan("reputation_proofs"),
    snapshots: await scan("reputation_snapshots"),
    evidence: await scan("evidence_records"),
    contributions: await scan("contributions"),
    stakes: await scan("stakes"),
    ledgerTransactions: await scan("economic_ledger_transactions"),
    ledgerEntries: await scan("economic_ledger_entries"),
  };
}

describe("NET-W032-AC-07 authority containment", () => {
  test("a FULL validation lifecycle does NOT mutate reputation/evidence/lifecycle/settlement state", async () => {
    // Seed the target FIRST so the trust surface includes it (the
    // lifecycle then runs over the seeded target).
    const seeded = await import("./_net-w032-harness.ts").then((m) =>
      m.seedProofTarget(harness),
    );
    const before = await trustSurface(harness);
    const opened = await openDefaultChallenge(harness, {
      targetId: seeded.proof.id,
      proof: seeded.proof,
      evidenceId: seeded.evidenceId,
    });
    const ctx = personCtx(harness, harness.reviewerPersonId, "ac07-conflict");
    await harness.runtime.validationService.markConflict(ctx, {
      organizationScopeId: harness.organizationScopeId,
      challengeId: opened.challenge.id,
      validatorPersonId: harness.validatorPersonIds[4]!,
      reason: "ac07 conflict",
      idempotencyKey: key("ac07-conflict"),
    });
    const assigned = await deriveAssignments(harness, opened.challenge);
    const attestation = await createAttestation(harness, opened.evidenceId);
    await observe(harness, assigned, 0, {
      verdict: "UPHOLD",
      evidenceRefs: [
        { kind: "signed_attestation", id: attestation.id },
      ],
    });
    await observe(harness, assigned, 1, { verdict: "UPHOLD" });
    await deriveOutcome(harness, assigned);
    const after = await trustSurface(harness);
    // The owning authorities are untouched by the coordination layer
    // (the derivation records decisions ONLY in the disputes
    // collections; the application composite below is the sanctioned
    // mutation path).
    expect(after.proofs).toEqual(before.proofs);
    expect(after.snapshots).toEqual(before.snapshots);
    expect(after.evidence).toEqual(before.evidence);
    expect(after.contributions).toEqual(before.contributions);
    expect(after.stakes).toEqual(before.stakes);
    expect(after.ledgerTransactions).toEqual(before.ledgerTransactions);
    expect(after.ledgerEntries).toEqual(before.ledgerEntries);
  });

  test("the disputes coordination layer writes NO economic records (no second balance/reserve ledger)", async () => {
    const before = await trustSurface(harness);
    await runFullRound(harness);
    const after = await trustSurface(harness);
    expect(after.stakes).toEqual(before.stakes);
    expect(after.ledgerTransactions).toEqual(before.ledgerTransactions);
    expect(after.ledgerEntries).toEqual(before.ledgerEntries);
  });

  test("a VALIDATOR cannot apply the round's outcome (influence only through observations — the domain conflict gate)", async () => {
    const round = await runFullRound(harness);
    const validatorPersonId = round.challenge.assignment!.entries[0]!.validatorPersonId;
    await expect(
      harness.runtime.validationService.markOutcomeApplied(
        personCtx(harness, validatorPersonId, "ac07-validator-apply"),
        {
          organizationScopeId: harness.organizationScopeId,
          outcomeId: round.outcome.id,
          application: "reputation_proof_revocation",
          idempotencyKey: key("ac07-validator-apply"),
        },
      ),
    ).rejects.toMatchObject({
      code: "VALIDATION_VALIDATION",
      context: expect.objectContaining({ conflict: "assigned_validator" }),
    });
    // The proof is NOT revoked (no authority mutation happened).
    const proof = await harness.runtime.reputationProofService.getProof(
      personCtx(harness, harness.reviewerPersonId, "ac07-unrevoked"),
      harness.organizationScopeId,
      round.proof.id,
    );
    expect(proof.revokedAt).toBeNull();
  });

  test("the application COMPOSITE is the only path that mutates the target proof (through the /reputation authority)", async () => {
    const round = await runFullRound(harness);
    // The composition-root command: revoke the proof through the
    // reputation authority's OWN command, then record the application.
    const applier = personCtx(harness, harness.challengerPersonId, "ac07-apply");
    const result = await harness.runtime.apiCommands.applyValidationOutcome(
      applier,
      harness.challengerPersonId,
      round.outcome.id,
      {
        organizationScopeId: harness.organizationScopeId,
        idempotencyKey: key("ac07-apply"),
      },
    );
    expect(result.outcome.applied).toMatchObject({
      application: "reputation_proof_revocation",
    });
    // The owning authority's OWN verification surface confirms the
    // one-way mutation (the W031 fail-closed pipeline).
    const verdict = await harness.runtime.reputationProofService.verifyProof(
      applier,
      {
        organizationScopeId: harness.organizationScopeId,
        proofId: round.proof.id,
        evaluatedAt: shiftIso(round.proof.issuedAt, 1000),
      },
    );
    expect(verdict.valid).toBe(false);
    expect(verdict.reason).toBe("proof_revoked");
  });

  test("the challenge record carries NO economic mutation surface (bookkeeping-only key set)", async () => {
    const opened = await openDefaultChallenge(harness);
    const assigned = await deriveAssignments(harness, opened.challenge);
    // The assignment entry's stake block is BOOKKEEPING ONLY: the
    // frozen requirement + the settlement authority's stake id (never
    // amounts moved here — the exact key-set pin).
    for (const entry of assigned.assignment!.entries) {
      expect(Object.keys(entry.stake).sort()).toEqual([
        "bondedAt",
        "requirementCredits",
        "stakeId",
      ]);
    }
    // No ledger/posting reference ever appears on the challenge record.
    const serialized = JSON.stringify(assigned);
    expect(serialized).not.toContain("transactionId");
    expect(serialized).not.toContain("posting");
    expect(serialized).not.toContain("accountId");
  });

  test("observation evidence references stay OPAQUE (no attestation content crosses)", async () => {
    const opened = await openDefaultChallenge(harness);
    const assigned = await deriveAssignments(harness, opened.challenge);
    const attestation = await createAttestation(harness, opened.evidenceId);
    const observation = await observe(harness, assigned, 0, {
      evidenceRefs: [{ kind: "signed_attestation", id: attestation.id }],
    });
    // The reference is the {kind, id} pair ONLY — the ATTESTATION's
    // statement/coverage/commitment content never crosses into the
    // validation record (minimum aggregate disclosure; the
    // observation's OWN statement field is the validator's verdict
    // explanation, by design).
    expect(observation.evidenceRefs).toEqual([
      { kind: "signed_attestation", id: attestation.id },
    ]);
    const serialized = JSON.stringify(observation);
    expect(serialized).not.toContain(attestation.statement);
    expect(serialized).not.toContain("coverage");
    expect(serialized).not.toContain("commitment");
  });

  test("deriving an outcome for a NON-proof target records the decision without touching the claim's authority", async () => {
    // A measured_outcome target: the round + outcome record the
    // decision; the outcome's lifecycle/economic authority is never
    // mutated (lifecycle application composites are W033+ scope).
    const { createMatureValue } = await import("../settlement/_net-w008-harness.ts");
    const value = await createMatureValue(harness.w010.w009.w008, {
      amount: 100,
      beneficiaryPersonId: harness.personId,
    });
    const before = await trustSurface(harness);
    const opened = await openDefaultChallenge(harness, {
      targetKind: "economic_value",
      targetId: value.id,
      effectiveAt: shiftIso(value.recordedAt, 3600_000),
    });
    const assigned = await deriveAssignments(harness, opened.challenge);
    await observe(harness, assigned, 0, { verdict: "ABSTAIN", evidenceRefs: [] });
    await observe(harness, assigned, 1, { verdict: "ABSTAIN", evidenceRefs: [] });
    const outcome = await deriveOutcome(harness, assigned);
    // 2 abstentions: participation met, no threshold met → NO_QUORUM
    // (fail-closed — no lifecycle application surface for it anyway).
    expect(outcome.decision).toBe("NO_QUORUM");
    expect(outcome.applied).toBeNull();
    const after = await trustSurface(harness);
    expect(after.contributions).toEqual(before.contributions);
    expect(after.ledgerTransactions).toEqual(before.ledgerTransactions);
    expect(after.stakes).toEqual(before.stakes);
    void opened;
    void value;
  });

  test("a closed-round challenge projection exposes read-only views (no hidden mutation path)", async () => {
    const round = await runFullRound(harness);
    // The read surface returns the immutable records (presentation
    // never mutates: getChallenge/getOutcome/listObservations).
    const before = await trustSurface(harness);
    await harness.runtime.validationService.getChallenge(
      personCtx(harness, harness.reviewerPersonId, "ac07-read"),
      harness.organizationScopeId,
      round.challenge.id,
    );
    await harness.runtime.validationService.getOutcome(
      personCtx(harness, harness.reviewerPersonId, "ac07-read"),
      harness.organizationScopeId,
      round.outcome.id,
    );
    await harness.runtime.validationService.listObservations(
      personCtx(harness, harness.reviewerPersonId, "ac07-read"),
      harness.organizationScopeId,
      round.challenge.id,
    );
    const after = await trustSurface(harness);
    expect(after).toEqual(before);
    // And the disputes collections themselves are unchanged by reads.
    const challenges = await harness.runtime.postgresAuthority.scan(
      "validation_challenges",
    );
    expect(challenges).toHaveLength(1);
    const stored = challenges[0]!.value as ValidationChallenge;
    expect(stored.outcome).not.toBeNull();
  });
});
