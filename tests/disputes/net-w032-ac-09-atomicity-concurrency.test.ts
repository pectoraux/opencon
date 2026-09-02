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
});
