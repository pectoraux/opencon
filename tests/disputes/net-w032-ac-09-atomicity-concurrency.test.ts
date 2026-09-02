/**
 * NET-W032-AC-09 — ATOMICITY / CONCURRENCY / AUDIT (issue #65; work
 * order §3.9: composite idempotency keys, stable lock ordering,
 * authoritative transactions, transactional audit and rollback-safe
 * fault injection; concurrent assignment, challenge, observation and
 * resolution converge deterministically; failed authority application
 * never leaves a W032 outcome claiming success).
 *
 *  - rollback-safe fault injection: an audit append failure inside
 *    the transaction rolls EVERYTHING back (no record, no idempotency
 *    record, no audit — the W008/W010 recomposition discipline);
 *  - concurrent observations from different validators all commit
 *    (independent slots); concurrent same-key mutations are
 *    exactly-one;
 *  - the compound-key retry of the resolution composite replays every
 *    step idempotently (no double economic effects);
 *  - the failed-authority-application ordering: recording an
 *    application BEFORE the owner mutation is observable fails closed
 *    (no false success);
 *  - the audit lineage contract on every mutation.
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { randomUUID } from "node:crypto";
import type { AuthorityTransaction } from "../../src/core/postgres-authority.ts";
import type { TransactionalAuditWriter } from "../../src/core/audit.ts";
import type { TransactionalAuditBuffer } from "../../src/core/audit.ts";
import type { ExecutionContext } from "../../src/core/execution-context.ts";
import { createValidationService } from "../../src/disputes/validation-service.ts";
import {
  createAuthorityValidationChallengeRepository,
} from "../../src/disputes/authority-validation-challenge-repository.ts";
import {
  createAuthorityValidationObservationRepository,
} from "../../src/disputes/authority-validation-observation-repository.ts";
import {
  createAuthorityValidationOutcomeRepository,
} from "../../src/disputes/authority-validation-outcome-repository.ts";
import {
  createAuthorityValidationPolicyRepository,
} from "../../src/disputes/authority-validation-policy-repository.ts";
import {
  createAuthorityValidatorParticipantRepository,
} from "../../src/disputes/authority-validator-participant-repository.ts";
import {
  createNetW032Harness,
  createStakedPolicy,
  deriveAssignments,
  deriveOutcome,
  key,
  observe,
  openDefaultChallenge,
  personCtx,
  runFullRound,
  seedProofTarget,
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

describe("NET-W032-AC-09 atomicity + concurrency + audit", () => {
  test("an audit APPEND failure inside the transaction rolls the outcome derivation back ENTIRELY (no outcome without audit lineage)", async () => {
    const opened = await openDefaultChallenge(harness);
    const assigned = await deriveAssignments(harness, opened.challenge);
    await observe(harness, assigned, 0, { verdict: "UPHOLD" });
    await observe(harness, assigned, 1, { verdict: "UPHOLD" });
    const authority = harness.runtime.postgresAuthority;
    const auditCountBefore = await harness.runtime.auditWriter.count();

    // A throwing audit buffer (the W008 recomposition discipline).
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
    const service = createValidationService({
      challengeRepository: createAuthorityValidationChallengeRepository({ authority }),
      observationRepository: createAuthorityValidationObservationRepository({ authority }),
      outcomeRepository: createAuthorityValidationOutcomeRepository({ authority }),
      policyRepository: createAuthorityValidationPolicyRepository({ authority }),
      participantRepository: createAuthorityValidatorParticipantRepository({ authority }),
      lookups: {
        subject: { async exists() { return true; } },
        target: { async resolve() { return null; } },
        attestations: { async resolve() { return null; } },
        proofs: { async resolve() { return null; } },
        stake: { async resolveStake() { return null; } },
      },
      idempotency: harness.runtime.idempotency,
      auditWriter: throwingWriter,
      logger: { info() {}, warn() {}, error() {}, debug() {} } as never,
    });

    const ctx = personCtx(harness, harness.reviewerPersonId, "ac09-fault");
    let err: Error | null = null;
    try {
      await service.deriveOutcome(ctx, {
        organizationScopeId: harness.organizationScopeId,
        challengeId: assigned.id,
        evaluatedAt: shiftIso(assigned.effectiveAt, 10800_000),
        idempotencyKey: key("ac09-fault"),
      });
    } catch (e) {
      err = e as Error;
    }
    expect(err).not.toBeNull();
    expect(err!.message).toContain("injected audit append failure");

    // NOTHING survived: no outcome record, the round is still OPEN
    // (no terminal back-pointer), no audit event was published.
    const outcomes = await authority.scan("validation_outcomes");
    expect(outcomes).toHaveLength(0);
    const stored = (await authority.get("validation_challenges", assigned.id))!
      .value as { outcome: unknown };
    expect(stored.outcome).toBeNull();
    expect(await harness.runtime.auditWriter.count()).toBe(auditCountBefore);

    // The retry (a healthy service, the same authoritative store)
    // completes — the fault left no residue.
    const retried = await harness.runtime.validationService.deriveOutcome(ctx, {
      organizationScopeId: harness.organizationScopeId,
      challengeId: assigned.id,
      evaluatedAt: shiftIso(assigned.effectiveAt, 10800_000),
      idempotencyKey: key("ac09-retry"),
    });
    expect(retried.outcome.decision).toBe("UPHELD");
  });

  test("concurrent observations from DIFFERENT validators all commit (independent slots)", async () => {
    const opened = await openDefaultChallenge(harness);
    const assigned = await deriveAssignments(harness, opened.challenge);
    const entries = assigned.assignment!.entries;
    const attempts = await Promise.allSettled(
      entries.map((entry, i) =>
        harness.runtime.validationService.submitObservation(
          personCtx(harness, entry.validatorPersonId, `ac09-parallel-${i}`),
          {
            organizationScopeId: harness.organizationScopeId,
            challengeId: assigned.id,
            verdict: i === 2 ? "REJECT" : "UPHOLD",
            statement: "parallel observation",
            evidenceRefs: [{ kind: "reputation_proof", id: assigned.target.id }],
            observedAt: shiftIso(assigned.effectiveAt, 7200_000),
            idempotencyKey: key(`ac09-parallel-${i}`),
          },
        ),
      ),
    );
    expect(attempts.every((a) => a.status === "fulfilled")).toBe(true);
    const observations = await harness.runtime.validationService.listObservations(
      personCtx(harness, harness.reviewerPersonId, "ac09-list"),
      harness.organizationScopeId,
      assigned.id,
    );
    expect(observations).toHaveLength(3);
  });

  test("concurrent outcome derivations of the same round converge to exactly one (the record mutex)", async () => {
    const opened = await openDefaultChallenge(harness);
    const assigned = await deriveAssignments(harness, opened.challenge);
    await observe(harness, assigned, 0, { verdict: "UPHOLD" });
    await observe(harness, assigned, 1, { verdict: "UPHOLD" });
    const attempts = await Promise.allSettled([
      deriveOutcome(harness, assigned, { idempotencyKey: key("ac09-derive-a") }),
      deriveOutcome(harness, assigned, { idempotencyKey: key("ac09-derive-b") }),
    ]);
    const fulfilled = attempts.filter((a) => a.status === "fulfilled");
    const rejected = attempts.filter((a) => a.status === "rejected");
    expect(fulfilled.length).toBe(1);
    expect(rejected.length).toBe(1);
    if (rejected[0]!.status === "rejected") {
      expect(rejected[0]!.reason.code).toBe("CONFLICT");
    }
    // Exactly one outcome record exists.
    const outcomes = await harness.runtime.postgresAuthority.scan("validation_outcomes");
    expect(outcomes).toHaveLength(1);
  });

  test("the compound-key retry of the resolution composite replays idempotently (no double economic effects)", async () => {
    const stakedPolicyId = await createStakedPolicy(harness);
    const opened = await openDefaultChallenge(harness, { policyId: stakedPolicyId });
    const assigned = await deriveAssignments(harness, opened.challenge);
    const entry = assigned.assignment!.entries[0]!;
    // Bond + observe (one submitted validator).
    await harness.runtime.apiCommands.bondValidatorAssignmentStake(
      personCtx(harness, entry.validatorPersonId, "ac09-bond"),
      entry.validatorPersonId,
      assigned.id,
      {
        organizationScopeId: harness.organizationScopeId,
        validatorPersonId: entry.validatorPersonId,
        idempotencyKey: key("ac09-bond"),
      },
    );
    await observe(harness, assigned, 0, { verdict: "UPHOLD" });
    const ctx = personCtx(harness, harness.reviewerPersonId, "ac09-retry");
    const input = {
      organizationScopeId: harness.organizationScopeId,
      evaluatedAt: shiftIso(assigned.effectiveAt, 10800_000),
      idempotencyKey: key("ac09-resolve"),
    };
    const first = await harness.runtime.apiCommands.resolveValidationRound(
      ctx,
      harness.reviewerPersonId,
      assigned.id,
      input,
    );
    expect(first.outcome.stakeOutcomes).toHaveLength(1);
    expect(first.outcome.stakeOutcomes[0]!.disposition).toBe("RELEASE");
    const ledgerAfterFirst = await harness.runtime.postgresAuthority.scan(
      "economic_ledger_transactions",
    );
    // The retry replays every step idempotently.
    const retry = await harness.runtime.apiCommands.resolveValidationRound(
      ctx,
      harness.reviewerPersonId,
      assigned.id,
      input,
    );
    expect(retry.outcome.id).toBe(first.outcome.id);
    expect(retry.outcome.stakeOutcomes).toHaveLength(1);
    // NO double economic effects: the ledger is unchanged by the retry.
    const ledgerAfterRetry = await harness.runtime.postgresAuthority.scan(
      "economic_ledger_transactions",
    );
    expect(ledgerAfterRetry).toEqual(ledgerAfterFirst);
    // Exactly one stake disposition audit event per stake.
    const stakeOutcomeEvents = await harness.runtime.auditWriter.query({
      eventType: "validation_outcome.stake_outcome_recorded",
    });
    expect(stakeOutcomeEvents).toHaveLength(1);
  });

  test("failed authority application leaves NO false success (the observable-mutation ordering)", async () => {
    const round = await runFullRound(harness);
    // Attempt to record the application WITHOUT the owning authority's
    // mutation having happened (the proof is NOT revoked): the domain
    // gate fails closed.
    const applier = personCtx(harness, harness.challengerPersonId, "ac09-unapplied");
    await expect(
      harness.runtime.validationService.markOutcomeApplied(applier, {
        organizationScopeId: harness.organizationScopeId,
        outcomeId: round.outcome.id,
        application: "reputation_proof_revocation",
        idempotencyKey: key("ac09-unapplied"),
      }),
    ).rejects.toMatchObject({
      code: "VALIDATION_VALIDATION",
      message: expect.stringContaining("NOT revoked in the reputation authority"),
    });
    // The outcome STILL claims nothing (applied === null).
    const unchanged = await harness.runtime.validationService.getOutcome(
      applier,
      harness.organizationScopeId,
      round.outcome.id,
    );
    expect(unchanged.applied).toBeNull();
    // Only ACCEPTED decisions can be applied at all — a FAIL-CLOSED
    // closure (never a merits decision) is refused outright.
    const insufficientRound = await runFullRound(harness, {
      verdicts: ["UPHOLD", "ABSTAIN", "ABSTAIN"],
      submitCount: 1,
    });
    expect(insufficientRound.outcome.decision).toBe("INSUFFICIENT_PARTICIPATION");
    await expect(
      harness.runtime.validationService.markOutcomeApplied(applier, {
        organizationScopeId: harness.organizationScopeId,
        outcomeId: insufficientRound.outcome.id,
        application: "reputation_proof_revocation",
        idempotencyKey: key("ac09-insufficient"),
      }),
    ).rejects.toMatchObject({
      code: "VALIDATION_VALIDATION",
      message: expect.stringContaining("only ACCEPTED decisions"),
    });
  });

  test("the application composite's retry is idempotent end-to-end (re-revocation is a no-op; the applied fact never duplicates)", async () => {
    const round = await runFullRound(harness);
    const ctx = personCtx(harness, harness.challengerPersonId, "ac09-apply");
    const input = {
      organizationScopeId: harness.organizationScopeId,
      idempotencyKey: key("ac09-apply"),
    };
    const first = await harness.runtime.apiCommands.applyValidationOutcome(
      ctx,
      harness.challengerPersonId,
      round.outcome.id,
      input,
    );
    expect(first.outcome.applied).not.toBeNull();
    const retry = await harness.runtime.apiCommands.applyValidationOutcome(
      ctx,
      harness.challengerPersonId,
      round.outcome.id,
      input,
    );
    expect(retry.outcome.id).toBe(first.outcome.id);
    expect(retry.outcome.applied).toEqual(first.outcome.applied);
    // Exactly ONE application audit event.
    const appliedEvents = await harness.runtime.auditWriter.query({
      eventType: "validation_outcome.applied",
      resourceId: round.outcome.id,
    });
    expect(appliedEvents).toHaveLength(1);
  });

  test("every mutation's audit event carries the idempotencyRecordId + transactionId lineage contract", async () => {
    const round = await runFullRound(harness);
    const reviewerCtx = personCtx(harness, harness.reviewerPersonId, "ac09-lineage");
    const observations = await harness.runtime.validationService.listObservations(
      reviewerCtx,
      harness.organizationScopeId,
      round.challenge.id,
    );
    // The per-resource event sets (challenge + each observation +
    // the outcome).
    const resourceIds: Array<[string, string]> = [
      ["validation_challenge.opened", round.challenge.id],
      ["validation_challenge.assignments_derived", round.challenge.id],
      ["validation_outcome.derived", round.outcome.id],
      ...observations.map(
        (o) => ["validation_observation.recorded", o.id] as [string, string],
      ),
    ];
    for (const [eventType, resourceId] of resourceIds) {
      const events = await harness.runtime.auditWriter.query({
        eventType,
        resourceId,
      });
      expect(events).toHaveLength(1);
      expect(events[0]!.metadata).toMatchObject({
        organizationScopeId: harness.organizationScopeId,
        idempotencyRecordId: expect.any(String),
        transactionId: expect.any(String),
      });
    }
  });

  test("concurrent markConflict + deriveAssignments converge (the round-record mutex; no lost events)", async () => {
    const opened = await openDefaultChallenge(harness);
    // Run a conflict mark and an assignment derivation concurrently
    // against the same round: both serialize on the record mutex —
    // either order is legal, both must COMMIT (no lost update).
    const attempts = await Promise.allSettled([
      harness.runtime.validationService.markConflict(
        personCtx(harness, harness.reviewerPersonId, "ac09-race-conflict"),
        {
          organizationScopeId: harness.organizationScopeId,
          challengeId: opened.challenge.id,
          validatorPersonId: harness.orderedValidatorPersonIds[4]!,
          reason: "concurrent conflict",
          idempotencyKey: key("ac09-race-conflict"),
        },
      ),
      deriveAssignments(harness, opened.challenge, {
        idempotencyKey: key("ac09-race-assign"),
      }),
    ]);
    // Whichever order won: the round must be CONSISTENT — exactly one
    // assignment set; the conflict mark either committed or failed
    // cleanly (never a half-applied record).
    const challenge = await harness.runtime.validationService.getChallenge(
      personCtx(harness, harness.reviewerPersonId, "ac09-consistent"),
      harness.organizationScopeId,
      opened.challenge.id,
    );
    expect(challenge.assignment).not.toBeNull();
    expect(challenge.outcome).toBeNull();
    const conflictCommitted = attempts[0]!.status === "fulfilled";
    if (conflictCommitted) {
      expect(challenge.conflicts).toContain(
        harness.orderedValidatorPersonIds[4]!,
      );
    } else {
      // The conflict mark lost the race to the terminal... no — the
      // round is open; a failure can only be an already-marked
      // conflict (impossible here) — assert the clean rejection.
      const reason = (attempts[0] as PromiseRejectedResult).reason;
      expect(reason.code).toBe("CONFLICT");
      expect(challenge.conflicts).not.toContain(
        harness.orderedValidatorPersonIds[4]!,
      );
    }
    void attempts[1];
  });

  test("the EXECUTION lineage propagates into every validation record", async () => {
    const round = await runFullRound(harness);
    const ctx = round.challenge as unknown as {
      executionId: string;
      correlationId: string;
    };
    expect(ctx.executionId).toBeDefined();
    expect(ctx.correlationId).toBeDefined();
    // The outcome + observation records carry the same lineage shape.
    expect(round.outcome.executionId).toBeDefined();
    expect(round.outcome.correlationId).toBeDefined();
    const observations = await harness.runtime.validationService.listObservations(
      personCtx(harness, harness.reviewerPersonId, "ac09-lineage") as ExecutionContext,
      harness.organizationScopeId,
      round.challenge.id,
    );
    for (const observation of observations) {
      expect(observation.executionId).toBeDefined();
      expect(observation.correlationId).toBeDefined();
    }
  });

  // ------------------------------------------------------------------
  // REPLAY-ORDERING regressions (architect re-review on PR #66): the
  // audit of the other W032 mutations found the same "mutable
  // pre-check before the idempotency lookup" pattern in
  // bondValidatorStake (settlement stake state), openChallenge
  // (duplicate live-round gate), registerValidator (duplicate
  // ACTIVE gate) and recordValidatorStakeOutcome (settlement terminal
  // state). Every state-dependent acceptance check now runs INSIDE
  // the applyIdempotent callback; these regressions pin that a
  // completed same-key replay survives the authority-state changes
  // that FOLLOW a successful first execution.
  // ------------------------------------------------------------------

  test("a bond's same-key replay after /settlement dispositioned the stake returns the CACHED round (replay ordering)", async () => {
    const stakedPolicyId = await createStakedPolicy(harness);
    const opened = await openDefaultChallenge(harness, {
      policyId: stakedPolicyId,
    });
    const assigned = await deriveAssignments(harness, opened.challenge);
    const entry = assigned.assignment!.entries[0]!;
    const validatorCtx = personCtx(
      harness,
      entry.validatorPersonId,
      "ac09-bond-replay",
    );
    // Commit the stake through the SETTLEMENT authority (the economic
    // authority — the same way the composite does).
    const committed = await harness.runtime.stakeService.commitStake(
      validatorCtx,
      {
        organizationScopeId: harness.organizationScopeId,
        ownerPersonId: entry.validatorPersonId,
        amount: 10,
        purpose: {
          kind: "validation_assignment",
          id: `${assigned.id}:${entry.validatorPersonId}`,
        },
        description: "replay-ordering probe stake",
        idempotencyKey: key("ac09-bond-replay-stake"),
      },
    );
    // Bond it (key K).
    const bondInput = (k: string) => ({
      organizationScopeId: harness.organizationScopeId,
      challengeId: assigned.id,
      validatorPersonId: entry.validatorPersonId,
      stakeId: committed.stake.id,
      idempotencyKey: k,
    });
    const k = key("ac09-bond-replay");
    const bonded = await harness.runtime.validationService.bondValidatorStake(
      validatorCtx,
      bondInput(k),
    );
    expect(
      bonded.assignment!.entries.find(
        (e) => e.validatorPersonId === entry.validatorPersonId,
      )!.stake.stakeId,
    ).toBe(committed.stake.id);

    // The round closes and /settlement dispositioned the stake
    // (COMMITTED → RELEASED — terminal, never reverts).
    await observe(harness, assigned, 0, { verdict: "UPHOLD" });
    await deriveOutcome(harness, assigned);
    await harness.runtime.stakeService.releaseStake(
      personCtx(harness, harness.reviewerPersonId, "ac09-bond-replay-release"),
      {
        stakeId: committed.stake.id,
        reason: "released after close (replay-ordering probe)",
        idempotencyKey: key("ac09-bond-replay-release"),
      },
    );

    // SAME-KEY replay: the cached bonded round. The stake's CURRENT
    // terminal state (RELEASED, not COMMITTED) can no longer break a
    // completed replay.
    const replay = await harness.runtime.validationService.bondValidatorStake(
      validatorCtx,
      bondInput(k),
    );
    expect(replay.id).toBe(bonded.id);
    expect(
      replay.assignment!.entries.find(
        (e) => e.validatorPersonId === entry.validatorPersonId,
      )!.stake.stakeId,
    ).toBe(committed.stake.id);
    // Exactly ONE bonding audit event (no re-execution).
    const events = await harness.runtime.auditWriter.query({
      eventType: "validation_challenge.stake_bonded",
      resourceId: assigned.id,
    });
    expect(events).toHaveLength(1);
  });

  test("an open's same-key replay after the round CLOSED and was rechallenged returns the CACHED round (replay ordering)", async () => {
    const seeded = await seedProofTarget(harness);
    const openCtx = personCtx(
      harness,
      harness.challengerPersonId,
      "ac09-open-replay",
    );
    const openInput = (k: string) => ({
      organizationScopeId: harness.organizationScopeId,
      target: { kind: "reputation_proof", id: seeded.proof.id },
      statement: "replay-ordering probe round",
      reasonCodes: ["contested_claim"],
      effectiveAt: shiftIso(seeded.proof.issuedAt, 3600_000),
      policyId: harness.defaultPolicyId,
      idempotencyKey: k,
    });
    const k = key("ac09-open-replay");
    const opened = await harness.runtime.validationService.openChallenge(
      openCtx,
      openInput(k),
    );
    expect(opened.created).toBe(true);

    // Close the round, then RECHALLENGE the same target (a NEW live
    // round with a foreign idempotency key now exists on the target).
    const assigned = await deriveAssignments(harness, opened.challenge);
    await observe(harness, assigned, 0, { verdict: "UPHOLD" });
    await observe(harness, assigned, 1, { verdict: "UPHOLD" });
    await deriveOutcome(harness, assigned);
    const rechallenged = await openDefaultChallenge(harness, {
      targetId: seeded.proof.id,
      proof: seeded.proof,
      rechallengeOfChallengeId: opened.challenge.id,
      idempotencyKey: key("ac09-open-rechallenge"),
    });
    expect(rechallenged.challenge.rechallengeOfChallengeId).toBe(
      opened.challenge.id,
    );

    // SAME-KEY replay of the ORIGINAL open: the duplicate gate (a
    // foreign LIVE round on the target) can no longer break the
    // replay — the cached ORIGINAL round is returned.
    const replay = await harness.runtime.validationService.openChallenge(
      openCtx,
      openInput(k),
    );
    expect(replay.created).toBe(false);
    expect(replay.challenge.id).toBe(opened.challenge.id);
    // Exactly ONE opened audit event for the original round.
    const events = await harness.runtime.auditWriter.query({
      eventType: "validation_challenge.opened",
      resourceId: opened.challenge.id,
    });
    expect(events).toHaveLength(1);
  });

  test("a registration's same-key replay after suspension + re-registration returns the CACHED participant (replay ordering)", async () => {
    // A FRESH person registers THEMSELVES with key K.
    const person = await harness.runtime.identityService.createIdentity(
      harness.bootstrapCtx,
      {
        displayName: "Replay Ordering Person",
        subjectReferences: [
          {
            subjectId: `w032-replay-${randomUUID().slice(0, 8)}@example.com`,
            providerKind: "internal",
          },
        ],
      },
    );
    const regCtx = personCtx(harness, person.id, "ac09-register-replay");
    const regInput = (k: string) => ({
      organizationScopeId: harness.organizationScopeId,
      personId: person.id,
      idempotencyKey: k,
    });
    const k = key("ac09-register-replay");
    const first =
      await harness.runtime.validatorRegistryService.registerValidator(
        regCtx,
        regInput(k),
      );
    expect(first.created).toBe(true);

    // Suspend the participant (one-way), then register AGAIN with a
    // fresh key (the person slot is free — a NEW ACTIVE participant
    // with a foreign idempotency key now exists).
    await harness.runtime.validatorRegistryService.suspendValidator(
      personCtx(harness, harness.reviewerPersonId, "ac09-suspend-replay"),
      {
        organizationScopeId: harness.organizationScopeId,
        validatorId: first.validator.id,
        reason: "replay-ordering probe suspension",
        idempotencyKey: key("ac09-suspend-replay"),
      },
    );
    const second =
      await harness.runtime.validatorRegistryService.registerValidator(
        regCtx,
        regInput(key("ac09-register-second")),
      );
    expect(second.created).toBe(true);
    expect(second.validator.id).not.toBe(first.validator.id);

    // SAME-KEY replay of the ORIGINAL registration: the duplicate
    // gate (a foreign ACTIVE participant) can no longer break the
    // replay — the CACHED original participant (as committed) returns.
    const replay =
      await harness.runtime.validatorRegistryService.registerValidator(
        regCtx,
        regInput(k),
      );
    expect(replay.created).toBe(false);
    expect(replay.validator.id).toBe(first.validator.id);
    // Exactly ONE registration audit event for the original participant.
    const events = await harness.runtime.auditWriter.query({
      eventType: "validator.registered",
      resourceId: first.validator.id,
    });
    expect(events).toHaveLength(1);
  });

  test("the stake-outcome recording's same-key replay short-circuits at the store (single entry, single audit event)", async () => {
    const stakedPolicyId = await createStakedPolicy(harness);
    const opened = await openDefaultChallenge(harness, {
      policyId: stakedPolicyId,
    });
    const assigned = await deriveAssignments(harness, opened.challenge);
    const entry = assigned.assignment!.entries[0]!;
    const validatorCtx = personCtx(
      harness,
      entry.validatorPersonId,
      "ac09-record-replay",
    );
    await harness.runtime.apiCommands.bondValidatorAssignmentStake(
      validatorCtx,
      entry.validatorPersonId,
      assigned.id,
      {
        organizationScopeId: harness.organizationScopeId,
        validatorPersonId: entry.validatorPersonId,
        idempotencyKey: key("ac09-record-bond"),
      },
    );
    await observe(harness, assigned, 0, { verdict: "UPHOLD" });
    const outcome = await deriveOutcome(harness, assigned);
    // The bonded stake id (from the assignment entry).
    const bonded = await harness.runtime.validationService.getChallenge(
      personCtx(harness, harness.reviewerPersonId, "ac09-record-read"),
      harness.organizationScopeId,
      assigned.id,
    );
    const stakeId = bonded.assignment!.entries.find(
      (e) => e.validatorPersonId === entry.validatorPersonId,
    )!.stake.stakeId!;
    // /settlement executes the disposition (RELEASE), THEN the domain
    // records it — the terminal-state verification now runs inside
    // the apply callback.
    await harness.runtime.stakeService.releaseStake(
      personCtx(harness, harness.reviewerPersonId, "ac09-record-release"),
      {
        stakeId,
        reason: "released for the replay-ordering probe",
        idempotencyKey: key("ac09-record-release"),
      },
    );
    const reviewerCtx = personCtx(
      harness,
      harness.reviewerPersonId,
      "ac09-record-replay",
    );
    const recordInput = (kk: string) => ({
      organizationScopeId: harness.organizationScopeId,
      outcomeId: outcome.id,
      validatorPersonId: entry.validatorPersonId,
      stakeId,
      disposition: "RELEASE" as const,
      idempotencyKey: kk,
    });
    const k = key("ac09-record-replay");
    const first =
      await harness.runtime.validationService.recordValidatorStakeOutcome(
        reviewerCtx,
        recordInput(k),
      );
    expect(first.stakeOutcomes).toHaveLength(1);
    // SAME-KEY replay: the cached outcome — no duplicate entry, no
    // second audit event (the settlement-state read never re-executes).
    const replay =
      await harness.runtime.validationService.recordValidatorStakeOutcome(
        reviewerCtx,
        recordInput(k),
      );
    expect(replay.id).toBe(first.id);
    expect(replay.stakeOutcomes).toHaveLength(1);
    const events = await harness.runtime.auditWriter.query({
      eventType: "validation_outcome.stake_outcome_recorded",
      resourceId: outcome.id,
    });
    expect(events).toHaveLength(1);
  });
});
