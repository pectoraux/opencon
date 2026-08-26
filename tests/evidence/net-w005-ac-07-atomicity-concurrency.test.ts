/**
 * NET-W005-AC-07 — Failure/replay/concurrency prove authoritative
 * atomicity and lineage.
 *
 *  - Deterministic replay on repeated idempotency keys (exactly one
 *    mutation + audit record).
 *  - Stale-writer rejection (optimistic concurrency).
 *  - An audit failure during evidence CREATION rolls the whole
 *    creation back (no evidence record without its audit lineage —
 *    fault-injected audit writer).
 *  - A failed AUTHORITATIVE COMMIT on a PoV transition leaves NO
 *    lifecycle mutation, NO idempotency record, and NO published
 *    audit record (fault-injected failing commit — the NET-W004-AC-07
 *    regression boundary applied to proof_of_value transitions).
 *  - Concurrent same-key transitions produce exactly one mutation.
 *
 * Evidence: fault-injection + concurrency integration tests over the
 * NET-W003 persistence/idempotency boundaries.
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import type { AuditWriter, TransactionalAuditWriter } from "../../src/core/audit.ts";
import type { AuthorityTransaction, PostgresAuthority } from "../../src/core/postgres-authority.ts";
import type { ExecutionContext } from "../../src/core/execution-context.ts";
import { createExecutionContext } from "../../src/core/execution-context.ts";
import { createTransactionalAuditWriter } from "../../src/audit/transactional-audit-writer.ts";
import { createWorkflowService } from "../../src/workflows/workflow-service.ts";
import { createLifecycleRepository } from "../../src/workflows/lifecycle-repository.ts";
import { createAuthorityOpportunityRepository } from "../../src/opportunities/authority-opportunity-repository.ts";
import { createAuthorityContributionRepository } from "../../src/contributions/authority-contribution-repository.ts";
import { createAuthorityProofOfValueRepository } from "../../src/evidence/authority-proof-of-value-repository.ts";
import { createAuthorityMeasuredOutcomeRepository } from "../../src/outcomes/authority-measured-outcome-repository.ts";
import { createPostgresIdempotencyStore } from "../../src/persistence/idempotency-store.ts";
import { createEvidenceService } from "../../src/evidence/evidence-service.ts";
import { createAuthorityEvidenceRepository } from "../../src/evidence/authority-evidence-repository.ts";
import { createProofOfValueService } from "../../src/evidence/proof-of-value-service.ts";
import type { TransitionAuthorizer } from "../../src/workflows/port.ts";
import type { Logger } from "../../src/core/logger.ts";
import {
  createNetW005Harness,
  actorCtx,
  createOpportunitySubject,
  createContributionSubject,
  createEvidence,
  createProofOfValue,
  povTransitionInput,
  type NetW005Harness,
} from "./_net-w005-harness.ts";

let harness: NetW005Harness;

beforeEach(async () => {
  harness = await createNetW005Harness();
});

afterEach(async () => {
  await harness.teardown();
});

/** An authorizer that always allows (the atomicity under test). */
const allowAllAuthorizer: TransitionAuthorizer = {
  async authorizeTransition() {
    return { decision: "allow", reason: "test" };
  },
};

/** A silent logger for the fault-injection service rebuilds. */
const silentLogger = {
  debug() {},
  info() {},
  warn() {},
  error() {},
  child() {
    return this as Logger;
  },
  forModule() {
    return this as Logger;
  },
} as unknown as Logger;

/** A transaction whose AUTHORITATIVE commit fails (after the audit append). */
class CommitFailingTransaction implements AuthorityTransaction {
  public constructor(private readonly inner: AuthorityTransaction) {}
  get transactionId(): string {
    return this.inner.transactionId;
  }
  get settled(): boolean {
    return this.inner.settled;
  }
  get<T = unknown>(collection: string, key: string) {
    return this.inner.get<T>(collection, key);
  }
  scan<T = unknown>(collection: string) {
    return this.inner.scan<T>(collection);
  }
  put<T>(collection: string, key: string, value: T) {
    return this.inner.put<T>(collection, key, value);
  }
  delete(collection: string, key: string) {
    return this.inner.delete(collection, key);
  }
  afterCommit(hook: () => Promise<void>): void {
    this.inner.afterCommit(hook);
  }
  afterRollback(hook: () => Promise<void>): void {
    this.inner.afterRollback(hook);
  }
  async commit(): Promise<void> {
    throw new Error("injected authoritative COMMIT failure");
  }
  async rollback(): Promise<void> {
    return this.inner.rollback();
  }
}

function wrapAuthorityWithFailingCommit(authority: PostgresAuthority): PostgresAuthority {
  return {
    async begin(context: ExecutionContext) {
      return new CommitFailingTransaction(await authority.begin(context));
    },
    async run<T>(context: ExecutionContext, work: (tx: AuthorityTransaction) => Promise<T>) {
      const tx = new CommitFailingTransaction(await authority.begin(context));
      try {
        const result = await work(tx);
        await tx.commit();
        return result;
      } catch (err) {
        await tx.rollback();
        throw err;
      }
    },
    get<T = unknown>(collection: string, key: string) {
      return authority.get<T>(collection, key);
    },
    scan<T = unknown>(collection: string) {
      return authority.scan<T>(collection);
    },
    count(collection: string) {
      return authority.count(collection);
    },
    recover() {
      return authority.recover();
    },
    close() {
      return authority.close();
    },
  };
}

describe("NET-W005-AC-07 failure/replay/concurrency", () => {
  test("repeating a PoV transition with the SAME idempotency key is a deterministic replay (exactly one mutation + audit)", async () => {
    const opp = await createOpportunitySubject(harness);
    const subject = await createContributionSubject(harness, opp.id);
    const proof = await createProofOfValue(harness, subject.id);
    const ctx = actorCtx(harness, "ac07-replay");

    const first = await harness.runtime.proofOfValueService.beginMeasuring(
      ctx,
      povTransitionInput(harness, proof.id, 0, "ac07-replay-key"),
    );
    expect(first.executed).toBe(true);
    expect(first.proof.version).toBe(1);

    const auditBefore = await harness.runtime.auditWriter.count();
    const replay = await harness.runtime.proofOfValueService.beginMeasuring(
      ctx,
      povTransitionInput(harness, proof.id, 0, "ac07-replay-key"),
    );
    expect(replay.executed).toBe(false);
    const auditAfter = await harness.runtime.auditWriter.count();
    // No second mutation, no second audit record.
    expect(auditAfter - auditBefore).toBe(0);
    const stored = await harness.runtime.proofOfValueService.getProofOfValue(ctx, proof.id);
    expect(stored.version).toBe(1);
    expect(stored.state).toBe("MEASURING");
    const transitionEvents = await harness.runtime.auditWriter.query({
      eventType: "proof_of_value.transition.draft_to_measuring",
      resourceId: proof.id,
    });
    expect(transitionEvents.length).toBe(1);
  });

  test("a STALE expectedVersion on a PoV transition is rejected as CONCURRENT_TRANSITION", async () => {
    const opp = await createOpportunitySubject(harness);
    const subject = await createContributionSubject(harness, opp.id);
    const e1 = await createEvidence(harness, subject.id, { sourceId: "s1" });
    const proof = await createProofOfValue(harness, subject.id, {
      evidenceIds: [e1.id],
    });
    const ctx = actorCtx(harness, "ac07-stale");
    await harness.runtime.proofOfValueService.beginMeasuring(
      ctx,
      povTransitionInput(harness, proof.id, 0, "ac07-stale-1"),
    );
    try {
      // The PoV is at version 1; a caller with the stale v0 view is
      // rejected with the stable error code.
      await harness.runtime.proofOfValueService.completeEvidenceGathering(
        ctx,
        povTransitionInput(harness, proof.id, 0, "ac07-stale-2"),
      );
      throw new Error("expected stale writer to be rejected");
    } catch (err) {
      const oce = err as { code?: string };
      expect(oce.code).toBe("CONCURRENT_TRANSITION");
    }
  });

  test("two CONCURRENT PoV transitions with the same idempotency key produce exactly one mutation", async () => {
    const opp = await createOpportunitySubject(harness);
    const subject = await createContributionSubject(harness, opp.id);
    const proof = await createProofOfValue(harness, subject.id);
    const ctx = actorCtx(harness, "ac07-concurrent");
    const input = povTransitionInput(harness, proof.id, 0, "ac07-concurrent-key");
    const [a, b] = await Promise.all([
      harness.runtime.proofOfValueService.beginMeasuring(ctx, input),
      harness.runtime.proofOfValueService.beginMeasuring(ctx, input),
    ]);
    // Exactly one of the two executed the mutation; the other replayed.
    expect(a.executed === true || b.executed === true).toBe(true);
    expect(a.executed && b.executed).toBe(false);
    const stored = await harness.runtime.proofOfValueService.getProofOfValue(ctx, proof.id);
    expect(stored.state).toBe("MEASURING");
    expect(stored.version).toBe(1);
    const events = await harness.runtime.auditWriter.query({
      eventType: "proof_of_value.transition.draft_to_measuring",
      resourceId: proof.id,
    });
    expect(events.length).toBe(1);
  });

  test("an audit PUBLICATION failure after a committed evidence creation retains the event and the explicit recovery publishes it (never loses audit lineage, never rolls back the record)", async () => {
    const opp = await createOpportunitySubject(harness);
    const subject = await createContributionSubject(harness, opp.id);
    const ctx = actorCtx(harness, "ac07-audit-failure");

    // The NET-W004-AC-07 transaction-ordering contract: the evidence
    // record + its audit record commit in ONE authoritative
    // transaction; the audit PUBLICATION happens strictly AFTER the
    // durable commit. A failing underlying writer therefore CANNOT
    // roll the creation back (the durable commit is the source of
    // truth) — the unpublished event is RETAINED for the explicit
    // retryPendingPublications() recovery path.
    const auditBefore = await harness.runtime.auditWriter.count();

    // A flaky underlying writer: the first 2 appends (publication
    // attempts of the single evidence.created event) throw, then heal.
    let failures = 2;
    const flaky = {
      writer: {
        async append(input: Parameters<AuditWriter["append"]>[0]) {
          if (failures > 0) {
            failures -= 1;
            throw new Error("flaky audit writer: publication failed");
          }
          return harness.runtime.auditWriter.append(input);
        },
        async query(query: Parameters<AuditWriter["query"]>[0]) {
          return harness.runtime.auditWriter.query(query);
        },
        async count() {
          return harness.runtime.auditWriter.count();
        },
      } as AuditWriter,
      heal() {
        failures = 0;
      },
    };
    const txWriter = createTransactionalAuditWriter({
      underlying: flaky.writer,
      publicationAttempts: 2,
      publicationBackoffMs: 1,
    });
    const service = createEvidenceService({
      repository: createAuthorityEvidenceRepository({
        authority: harness.runtime.postgresAuthority,
      }),
      authority: harness.runtime.postgresAuthority,
      auditWriter: txWriter,
      logger: silentLogger,
    });

    // The creation SUCCEEDS: the durable commit stands (a publication
    // failure must never undo a committed mutation).
    const evidence = await service.createEvidence(ctx, {
      organizationScopeId: harness.organizationScopeId,
      ownerId: harness.personId,
      subjectReference: { subjectId: subject.id, subjectType: "contribution" },
      provenance: { sourceType: "platform", method: "counter" },
      confidence: { point: 0.9 },
    });
    const stored = await harness.runtime.evidenceService.getEvidence(ctx, evidence.id);
    expect(stored.id).toBe(evidence.id);

    // The audit event is NOT yet visible (publication failed) but is
    // RETAINED — pending recovery, never discarded.
    expect(await harness.runtime.auditWriter.count()).toBe(auditBefore);
    expect(txWriter.pendingPublicationCount()).toBe(1);

    // EXPLICIT RECOVERY: heal the writer, drain the pending
    // publication. The audit record becomes visible with the evidence
    // lineage — converging the audit trail toward the committed state.
    flaky.heal();
    const recovery = await txWriter.retryPendingPublications();
    expect(recovery.published).toBe(1);
    expect(recovery.remaining).toBe(0);
    expect(await harness.runtime.auditWriter.count()).toBe(auditBefore + 1);
    const events = await harness.runtime.auditWriter.query({
      eventType: "evidence.created",
      resourceId: evidence.id,
    });
    expect(events.length).toBe(1);
    expect(events[0]!.resourceType).toBe("evidence");
  });

  test("a FAILED AUTHORITATIVE COMMIT on a PoV transition commits NOTHING (no mutation, no idempotency record, no audit)", async () => {
    const opp = await createOpportunitySubject(harness);
    const subject = await createContributionSubject(harness, opp.id);
    const proof = await createProofOfValue(harness, subject.id);
    const ctx = actorCtx(harness, "ac07-commit-failure");

    // Rebuild the workflow + PoV services over a FAILING-COMMIT
    // authority (the same runtime providers otherwise): the workflow
    // buffers the lifecycle mutation + idempotency record + audit
    // event normally — only the authoritative commit fails.
    const failingAuthority = wrapAuthorityWithFailingCommit(
      harness.runtime.postgresAuthority,
    );
    const failingIdempotency = createPostgresIdempotencyStore({
      authority: failingAuthority,
    });
    const failingWorkflow = createWorkflowService({
      opportunityRepository: createLifecycleRepository(
        createAuthorityOpportunityRepository({ authority: harness.runtime.postgresAuthority }),
      ),
      contributionRepository: createLifecycleRepository(
        createAuthorityContributionRepository({ authority: harness.runtime.postgresAuthority }),
      ),
      proofOfValueRepository: createLifecycleRepository(
        createAuthorityProofOfValueRepository({ authority: failingAuthority }),
      ),
      outcomeMeasurementRepository: createLifecycleRepository(
        createAuthorityMeasuredOutcomeRepository({ authority: failingAuthority }),
      ),
      authorizer: allowAllAuthorizer,
      auditWriter: createTransactionalAuditWriter({
        underlying: harness.runtime.auditWriter,
      }),
      idempotency: failingIdempotency,
      coordination: harness.runtime.coordinationService,
    });
    const failingPovService = createProofOfValueService({
      repository: createAuthorityProofOfValueRepository({
        authority: failingAuthority,
      }),
      evidenceRepository: createAuthorityEvidenceRepository({
        authority: harness.runtime.postgresAuthority,
      }),
      outcomeClaimRepository: {
        // Minimal stubs for the paths this test exercises.
        save: async () => {
          throw new Error("unused");
        },
        saveWithinTx: async () => {
          throw new Error("unused");
        },
        findById: async () => null,
        findByIdWithinTx: async () => null,
        exists: async () => false,
      },
      attestationRepository: {
        save: async () => {
          throw new Error("unused");
        },
        saveWithinTx: async () => {
          throw new Error("unused");
        },
        findById: async () => null,
        exists: async () => false,
      },
      // Stub verifier (these tests exercise beginMeasuring/creation,
      // not the EVALUATING → VERIFIED attestation precondition).
      attestationVerifier: {
        async verify() {
          return { valid: true, reason: "stub" };
        },
      },
      subjectLookup: {
        async getOrganizationScope() {
          return harness.organizationScopeId;
        },
        async exists() {
          return true;
        },
      },
      workflow: failingWorkflow,
      authority: failingAuthority,
      auditWriter: createTransactionalAuditWriter({
        underlying: harness.runtime.auditWriter,
      }),
      logger: silentLogger,
    });

    const auditBefore = await harness.runtime.auditWriter.count();
    await expect(
      failingPovService.beginMeasuring(
        ctx,
        povTransitionInput(harness, proof.id, 0, "ac07-commit-failure-key"),
      ),
    ).rejects.toThrow(/injected authoritative COMMIT failure/);

    // (1) The lifecycle state is UNCHANGED (DRAFT, version 0).
    const stored = await harness.runtime.proofOfValueService.getProofOfValue(ctx, proof.id);
    expect(stored.state).toBe("DRAFT");
    expect(stored.version).toBe(0);
    // (2) NO idempotency record for the failed key.
    const key = `workflow:proof_of_value:${proof.id}:ac07-commit-failure-key`;
    expect(await harness.runtime.idempotency.has(key)).toBe(false);
    expect(await failingIdempotency.has(key)).toBe(false);
    // (3) NO audit record was published (the buffered audit was
    // discarded with the failed transaction).
    expect(await harness.runtime.auditWriter.count()).toBe(auditBefore);
    const events = await harness.runtime.auditWriter.query({
      eventType: "proof_of_value.transition.draft_to_measuring",
      resourceId: proof.id,
    });
    expect(events.length).toBe(0);
    // (4) A RETRY through the healthy runtime executes (the failed
    // attempt committed nothing).
    const retry = await harness.runtime.proofOfValueService.beginMeasuring(
      ctx,
      povTransitionInput(harness, proof.id, 0, "ac07-commit-failure-key"),
    );
    expect(retry.executed).toBe(true);
    expect(retry.proof.state).toBe("MEASURING");
  });

  test("a PoV create over the failing-commit authority commits NOTHING (creation atomicity)", async () => {
    const opp = await createOpportunitySubject(harness);
    const subject = await createContributionSubject(harness, opp.id);
    const ctx = actorCtx(harness, "ac07-create-failure");
    const failingAuthority = wrapAuthorityWithFailingCommit(
      harness.runtime.postgresAuthority,
    );
    const failingPovService = createProofOfValueService({
      repository: createAuthorityProofOfValueRepository({
        authority: failingAuthority,
      }),
      evidenceRepository: createAuthorityEvidenceRepository({
        authority: harness.runtime.postgresAuthority,
      }),
      outcomeClaimRepository: {
        save: async () => {
          throw new Error("unused");
        },
        saveWithinTx: async () => {
          throw new Error("unused");
        },
        findById: async () => null,
        findByIdWithinTx: async () => null,
        exists: async () => false,
      },
      attestationRepository: {
        save: async () => {
          throw new Error("unused");
        },
        saveWithinTx: async () => {
          throw new Error("unused");
        },
        findById: async () => null,
        exists: async () => false,
      },
      // Stub verifier (this test exercises creation atomicity, not the
      // EVALUATING → VERIFIED attestation precondition).
      attestationVerifier: {
        async verify() {
          return { valid: true, reason: "stub" };
        },
      },
      subjectLookup: {
        async getOrganizationScope() {
          return harness.organizationScopeId;
        },
        async exists() {
          return true;
        },
      },
      workflow: createWorkflowService({
        opportunityRepository: createLifecycleRepository(
          createAuthorityOpportunityRepository({ authority: harness.runtime.postgresAuthority }),
        ),
        contributionRepository: createLifecycleRepository(
          createAuthorityContributionRepository({ authority: harness.runtime.postgresAuthority }),
        ),
        proofOfValueRepository: createLifecycleRepository(
          createAuthorityProofOfValueRepository({ authority: failingAuthority }),
        ),
        outcomeMeasurementRepository: createLifecycleRepository(
          createAuthorityMeasuredOutcomeRepository({ authority: failingAuthority }),
        ),
        authorizer: allowAllAuthorizer,
        auditWriter: createTransactionalAuditWriter({
          underlying: harness.runtime.auditWriter,
        }),
        idempotency: createPostgresIdempotencyStore({ authority: failingAuthority }),
        coordination: harness.runtime.coordinationService,
      }),
      authority: failingAuthority,
      auditWriter: createTransactionalAuditWriter({
        underlying: harness.runtime.auditWriter,
      }),
      logger: silentLogger,
    });

    const auditBefore = await harness.runtime.auditWriter.count();
    await expect(
      failingPovService.createProofOfValue(ctx, {
        organizationScopeId: harness.organizationScopeId,
        ownerId: harness.personId,
        subjectReference: { subjectId: subject.id, subjectType: "contribution" },
      }),
    ).rejects.toThrow(/injected authoritative COMMIT failure/);
    expect(await harness.runtime.auditWriter.count()).toBe(auditBefore);

    // The create committed nothing: fetching by a fresh create's
    // outcome — a retry through the healthy runtime succeeds and the
    // total PoV count for the subject is exactly 1.
    const retry = await harness.runtime.proofOfValueService.createProofOfValue(ctx, {
      organizationScopeId: harness.organizationScopeId,
      ownerId: harness.personId,
      subjectReference: { subjectId: subject.id, subjectType: "contribution" },
    });
    expect(retry.state).toBe("DRAFT");
    const { PROOFS_OF_VALUE_COLLECTION } = await import(
      "../../src/evidence/authority-proof-of-value-repository.ts"
    );
    const all = await harness.runtime.postgresAuthority.scan(PROOFS_OF_VALUE_COLLECTION);
    const forSubject = all.filter(
      (r) =>
        (r.value as { subjectReference?: { subjectId?: string } }).subjectReference
          ?.subjectId === subject.id,
    );
    expect(forSubject.length).toBe(1);
  });
});
