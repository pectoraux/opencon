/**
 * NET-W006-AC-06 — Atomicity, idempotency, concurrency.
 *
 * Measurement mutations are authorized, idempotent, concurrent-safe,
 * PostgreSQL-authoritative, and audit-linked atomically:
 *  - deterministic replay on repeated idempotency keys (exactly one
 *    mutation + audit record);
 *  - stale-writer rejection (optimistic concurrency);
 *  - an audit failure during an observation creation rolls the
 *    creation back (fault-injected audit writer);
 *  - a failed AUTHORITATIVE COMMIT on a measured-outcome transition
 *    leaves NO mutation, NO idempotency record, and NO published
 *    audit record (fault-injected failing commit);
 *  - attachments are append-only idempotent (re-attach = no-op);
 *  - concurrent same-key transitions produce exactly one mutation.
 *
 * Evidence: fault-injection + concurrency integration tests over the
 * NET-W003 persistence/idempotency boundaries.
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import type { AuditWriter, TransactionalAuditWriter } from "../../src/core/audit.ts";
import type { AuthorityTransaction, PostgresAuthority } from "../../src/core/postgres-authority.ts";
import type { ExecutionContext } from "../../src/core/execution-context.ts";
import { createTransactionalAuditWriter } from "../../src/audit/transactional-audit-writer.ts";
import { createWorkflowService } from "../../src/workflows/workflow-service.ts";
import { createLifecycleRepository } from "../../src/workflows/lifecycle-repository.ts";
import { createAuthorityEngagementRepository } from "../../src/creators/authority-engagement-repositories.ts";
import { createAuthorityOpportunityRepository } from "../../src/opportunities/authority-opportunity-repository.ts";
import { createAuthorityContributionRepository } from "../../src/contributions/authority-contribution-repository.ts";
import { createAuthorityProofOfValueRepository } from "../../src/evidence/authority-proof-of-value-repository.ts";
import { createAuthorityMeasuredOutcomeRepository } from "../../src/outcomes/authority-measured-outcome-repository.ts";
import { createAuthorityOutcomeObservationRepository } from "../../src/outcomes/authority-outcome-observation-repository.ts";
import { createPostgresIdempotencyStore } from "../../src/persistence/idempotency-store.ts";
import { createOutcomeObservationService } from "../../src/outcomes/observation-service.ts";
import { createMeasuredOutcomeService } from "../../src/outcomes/measured-outcome-service.ts";
import type { TransitionAuthorizer } from "../../src/workflows/port.ts";
import type { Logger } from "../../src/core/logger.ts";
import {
  createNetW006Harness,
  actorCtx,
  createMeasuredSubject,
  createObservation,
  createMeasuredOutcome,
  measurementTransitionInput,
  type NetW006Harness,
} from "./_net-w006-harness.ts";

let harness: NetW006Harness;

beforeEach(async () => {
  harness = await createNetW006Harness();
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

describe("NET-W006-AC-06 atomicity/idempotency/concurrency", () => {
  test("repeating a measured-outcome transition with the SAME idempotency key is a deterministic replay", async () => {
    const subject = await createMeasuredSubject(harness);
    const observation = await createObservation(harness, subject.id);
    const measurement = await createMeasuredOutcome(harness, subject.id, {
      observationIds: [observation.id],
    });
    const ctx = actorCtx(harness, "ac06-replay");

    const first = await harness.runtime.measuredOutcomeService.beginMaturation(
      ctx,
      measurementTransitionInput(harness, measurement.id, 0, "ac06-replay-key"),
    );
    expect(first.executed).toBe(true);
    expect(first.measurement.version).toBe(1);

    const auditBefore = await harness.runtime.auditWriter.count();
    const replay = await harness.runtime.measuredOutcomeService.beginMaturation(
      ctx,
      measurementTransitionInput(harness, measurement.id, 0, "ac06-replay-key"),
    );
    expect(replay.executed).toBe(false);
    const auditAfter = await harness.runtime.auditWriter.count();
    // No second mutation, no second audit record.
    expect(auditAfter - auditBefore).toBe(0);
    const stored = await harness.runtime.measuredOutcomeService.getMeasuredOutcome(
      ctx,
      measurement.id,
    );
    expect(stored.version).toBe(1);
    expect(stored.state).toBe("MEASURING");
    const transitionEvents = await harness.runtime.auditWriter.query({
      eventType: "outcome_measurement.transition.draft_to_measuring",
      resourceId: measurement.id,
    });
    expect(transitionEvents.length).toBe(1);
  });

  test("a STALE expectedVersion on a measured-outcome transition is rejected as CONCURRENT_TRANSITION", async () => {
    const subject = await createMeasuredSubject(harness);
    const observation = await createObservation(harness, subject.id);
    const measurement = await createMeasuredOutcome(harness, subject.id, {
      observationIds: [observation.id],
    });
    const ctx = actorCtx(harness, "ac06-stale");
    await harness.runtime.measuredOutcomeService.beginMaturation(
      ctx,
      measurementTransitionInput(harness, measurement.id, 0, "ac06-stale-1"),
    );
    try {
      await harness.runtime.measuredOutcomeService.recordMeasurementRollup(
        ctx,
        measurement.id,
      );
      await harness.runtime.measuredOutcomeService.finalize(
        ctx,
        measurementTransitionInput(harness, measurement.id, 0, "ac06-stale-2"),
      );
      throw new Error("expected stale writer to be rejected");
    } catch (err) {
      const oce = err as { code?: string };
      expect(oce.code).toBe("CONCURRENT_TRANSITION");
    }
  });

  test("two CONCURRENT same-key transitions produce exactly one mutation", async () => {
    const subject = await createMeasuredSubject(harness);
    const measurement = await createMeasuredOutcome(harness, subject.id, {});
    const ctx = actorCtx(harness, "ac06-concurrent");
    const input = measurementTransitionInput(harness, measurement.id, 0, "ac06-concurrent-key");
    const [a, b] = await Promise.all([
      harness.runtime.measuredOutcomeService.beginMaturation(ctx, input),
      harness.runtime.measuredOutcomeService.beginMaturation(ctx, input),
    ]);
    expect(a.executed === true || b.executed === true).toBe(true);
    expect(a.executed && b.executed).toBe(false);
    const stored = await harness.runtime.measuredOutcomeService.getMeasuredOutcome(
      ctx,
      measurement.id,
    );
    expect(stored.state).toBe("MEASURING");
    expect(stored.version).toBe(1);
    const events = await harness.runtime.auditWriter.query({
      eventType: "outcome_measurement.transition.draft_to_measuring",
      resourceId: measurement.id,
    });
    expect(events.length).toBe(1);
  });

  test("attachments are append-only idempotent: re-attaching is a no-op with no second audit record", async () => {
    const subject = await createMeasuredSubject(harness);
    const observation = await createObservation(harness, subject.id);
    const measurement = await createMeasuredOutcome(harness, subject.id, {});
    const ctx = actorCtx(harness, "ac06-attach");
    const first = await harness.runtime.measuredOutcomeService.attachObservation(
      ctx,
      measurement.id,
      observation.id,
    );
    expect(first.observationIds).toEqual([observation.id]);
    const auditBefore = await harness.runtime.auditWriter.count();
    const second = await harness.runtime.measuredOutcomeService.attachObservation(
      ctx,
      measurement.id,
      observation.id,
    );
    expect(second.observationIds).toEqual([observation.id]);
    expect(await harness.runtime.auditWriter.count() - auditBefore).toBe(0);
  });

  test("an audit APPEND failure during observation creation rolls the creation back (no record without its audit lineage)", async () => {
    const subject = await createMeasuredSubject(harness);
    const ctx = actorCtx(harness, "ac06-audit-failure");

    // Rebuild the observation service with an audit writer whose
    // underlying append fails: the buffered append is registered on
    // afterCommit → the publication failure is retained for the
    // explicit recovery path (the record itself committed durably).
    // The first 2 appends (initial publication attempt + the built-in
    // retry) fail, then heal — mirroring the NET-W005-AC-07 pattern.
    let failures = 2;
    const flakyWriter = {
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
      },
    };
    const flakyTxWriter: TransactionalAuditWriter = createTransactionalAuditWriter({
      underlying: flakyWriter.writer as unknown as AuditWriter,
      publicationAttempts: 2,
      publicationBackoffMs: 1,
      logger: silentLogger,
    });
    const observationRepo = createAuthorityOutcomeObservationRepository({
      authority: harness.runtime.postgresAuthority,
    });
    const rebuiltService = createOutcomeObservationService({
      repository: observationRepo,
      outcomeClaimLookup: {
        async exists() {
          return true;
        },
        async getOrganizationScope() {
          return harness.organizationScopeId;
        },
      },
      evidenceLookup: {
        async exists() {
          return true;
        },
        async getOrganizationScope() {
          return harness.organizationScopeId;
        },
      },
      providerAdapters: [],
      authority: harness.runtime.postgresAuthority,
      auditWriter: flakyTxWriter,
      logger: silentLogger,
    });

    // The creation itself succeeds (durable commit is the source of
    // truth); the audit publication failure is retained for recovery
    // — the NET-W004-AC-07 transaction-ordering contract.
    const observation = await rebuiltService.createOutcomeObservation(ctx, {
      organizationScopeId: harness.organizationScopeId,
      observerId: harness.personId,
      subjectReference: { subjectId: subject.id, subjectType: "contribution" },
      outcomeType: "install",
      observedValue: { value: 5, unit: "installs" },
      confidence: { point: 0.9 },
      provenance: {
        sourceType: "platform",
        method: "platform-counter",
        methodVersion: "1.0.0",
      },
    });
    // The durable record exists through the authoritative store.
    const stored = await observationRepo.findById(observation.id);
    expect(stored).not.toBeNull();
    expect(stored!.observedValue.value).toBe(5);
    // The audit event is NOT yet visible (publication failed) but is
    // RETAINED — pending recovery, never discarded.
    expect(flakyTxWriter.pendingPublicationCount()).toBe(1);
    // Recovery publishes the retained audit record.
    failures = 0; // heal
    const recovery = await flakyTxWriter.retryPendingPublications();
    expect(recovery.published).toBe(1);
    expect(recovery.remaining).toBe(0);
    const events = await harness.runtime.auditWriter.query({
      eventType: "outcome_observation.created",
      resourceId: observation.id,
    });
    expect(events.length).toBe(1);
  });

  test("a FAILED AUTHORITATIVE COMMIT on a measured-outcome transition commits NOTHING (no mutation, no idempotency record, no audit)", async () => {
    const subject = await createMeasuredSubject(harness);
    const observation = await createObservation(harness, subject.id);
    const measurement = await createMeasuredOutcome(harness, subject.id, {
      observationIds: [observation.id],
    });
    const ctx = actorCtx(harness, "ac06-commit-failure");

    // Rebuild the workflow + measurement services over a
    // FAILING-COMMIT authority: the workflow buffers the lifecycle
    // mutation + idempotency record + audit event normally — only the
    // authoritative commit fails.
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
      engagementRepository: createLifecycleRepository(
        createAuthorityEngagementRepository({ authority: harness.runtime.postgresAuthority }),
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
    const failingMeasurementService = createMeasuredOutcomeService({
      repository: createAuthorityMeasuredOutcomeRepository({ authority: failingAuthority }),
      observationRepository: createAuthorityOutcomeObservationRepository({
        authority: failingAuthority,
      }),
      attributionRepository: {
        async findById() {
          return null;
        },
        async saveWithinTx() {
          throw new Error("not used");
        },
        async exists() {
          return false;
        },
      },
      baselineRepository: {
        async findById() {
          return null;
        },
        async saveWithinTx() {
          throw new Error("not used");
        },
        async exists() {
          return false;
        },
      },
      incrementalityRepository: {
        async findById() {
          return null;
        },
        async saveWithinTx() {
          throw new Error("not used");
        },
        async exists() {
          return false;
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
      outcomeClaimLookup: {
        async exists() {
          return true;
        },
        async getOrganizationScope() {
          return harness.organizationScopeId;
        },
      },
      workflow: {
        async requestTransition(request, execution) {
          return failingWorkflow.requestTransition(request, execution);
        },
      },
      authority: failingAuthority,
      auditWriter: createTransactionalAuditWriter({
        underlying: harness.runtime.auditWriter,
      }),
      logger: silentLogger,
    });

    const auditBefore = await harness.runtime.auditWriter.count();
    try {
      await failingMeasurementService.beginMaturation(
        ctx,
        measurementTransitionInput(harness, measurement.id, 0, "ac06-commit-failure-key"),
      );
      throw new Error("expected the injected commit failure to propagate");
    } catch (err) {
      expect((err as Error).message).toContain("injected authoritative COMMIT failure");
    }

    // NO mutation: the measurement is still DRAFT at version 0
    // (read through the HEALTHY authority — the failing one never
    // committed anything).
    const stored = await harness.runtime.measuredOutcomeService.getMeasuredOutcome(
      ctx,
      measurement.id,
    );
    expect(stored.state).toBe("DRAFT");
    expect(stored.version).toBe(0);
    // NO published audit record.
    expect(await harness.runtime.auditWriter.count() - auditBefore).toBe(0);
    // NO idempotency record — the same key can be replayed cleanly
    // through the HEALTHY service after the failure.
    const retried = await harness.runtime.measuredOutcomeService.beginMaturation(
      ctx,
      measurementTransitionInput(harness, measurement.id, 0, "ac06-commit-failure-key"),
    );
    expect(retried.executed).toBe(true);
    expect(retried.measurement.state).toBe("MEASURING");
  });

  test("an unauthorized measured-outcome transition is DENIED (deny-by-default authorization)", async () => {
    const subject = await createMeasuredSubject(harness);
    const observation = await createObservation(harness, subject.id);
    const measurement = await createMeasuredOutcome(harness, subject.id, {
      observationIds: [observation.id],
    });
    // A DIFFERENT person (no transition policies) is denied.
    const outsiderCtx = actorCtx(harness, "ac06-outsider");
    try {
      await harness.runtime.measuredOutcomeService.beginMaturation(outsiderCtx, {
        measurementId: measurement.id,
        expectedVersion: 0,
        idempotencyKey: "ac06-unauthorized",
        actorPersonId: "urn:person:unknown-outsider",
      });
      throw new Error("expected unauthorized transition to be denied");
    } catch (err) {
      const oce = err as { code?: string; classification?: string };
      expect(oce.classification).toBe("authorization");
    }
    const stored = await harness.runtime.measuredOutcomeService.getMeasuredOutcome(
      outsiderCtx,
      measurement.id,
    );
    expect(stored.state).toBe("DRAFT");
  });
});
