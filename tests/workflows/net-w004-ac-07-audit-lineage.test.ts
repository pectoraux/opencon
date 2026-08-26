/**
 * NET-W004-AC-07 — Trace/audit lineage.
 *
 * Every material lifecycle mutation records stable execution/
 * correlation/causation identifiers, actor/subject/resource lineage,
 * and an append-oriented audit record that is committed atomically with
 * the authoritative state mutation.
 *
 * Evidence: audit/trace integration tests.
 *
 * NET-W004-AC-07 REMEDIATION v2 (transaction-ordering, architect
 * re-review on PR #8): the transactional audit buffer must NOT publish
 * from inside `performTransition()` — publication happens via the
 * authoritative transaction's `afterCommit` lifecycle hook, strictly
 * AFTER `tx.commit()` makes the lifecycle mutation + idempotency
 * record durable; discard happens via `afterRollback` when the
 * transaction settles without committing. These tests prove:
 *
 *  - the runtime's audit writer IS the transactional audit writer
 *    (bootstrap wiring, not the ordinary in-memory direct writer);
 *  - the audit record carries the AUTHORITATIVE transactionId
 *    (tx.transactionId — NOT the execution id);
 *  - ORDERING: the audit publication happens strictly AFTER the
 *    durable commit (a spy timeline proves durable-commit precedes
 *    audit-publish);
 *  - REGRESSION (the architect-required test): the authoritative
 *    transaction commit itself FAILS after the workflow has already
 *    appended its audit event → lifecycle state unchanged,
 *    idempotency record absent, audit record absent (the buffered
 *    audit is discarded by afterRollback — no "audit exists, mutation
 *    doesn't");
 *  - a mid-transaction failure (stale writer) rolls the tx back and
 *    discards the buffered audit;
 *  - PUBLICATION FAILURE RECOVERY: an underlying audit-writer failure
 *    AFTER a successful commit does not undo the durable commit — the
 *    unpublished event is RETAINED and republished by the explicit
 *    `retryPendingPublications()` recovery path, so the recovery can
 *    never create "audit exists, mutation doesn't" (retained events
 *    belong to a COMMITTED transaction);
 *  - the idempotency-record lineage in the audit metadata references
 *    the REAL idempotency record id (not the tx id).
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { createExecutionContext } from "../../src/core/execution-context.ts";
import type { AuditWriter, TransactionalAuditWriter } from "../../src/core/audit.ts";
import type { AuthorityTransaction, PostgresAuthority } from "../../src/core/postgres-authority.ts";
import type { ExecutionContext } from "../../src/core/execution-context.ts";
import {
  createNetW004Harness,
  createOpportunity,
  type NetW004Harness,
} from "./_net-w004-harness.ts";
import type { Runtime } from "../../src/bootstrap/runtime.ts";
// Direct construction for the fault-injection tests: the workflow
// service is rebuilt over the SAME authority/idempotency/coordination
// providers with instrumented audit writers / wrapped authorities,
// proving the ordering + atomicity invariants at the exact failure
// boundaries the architect identified.
import { createTransactionalAuditWriter } from "../../src/audit/transactional-audit-writer.ts";
import { createWorkflowService } from "../../src/workflows/workflow-service.ts";
import { createLifecycleRepository } from "../../src/workflows/lifecycle-repository.ts";
import { createAuthorityOpportunityRepository } from "../../src/opportunities/authority-opportunity-repository.ts";
import { createAuthorityContributionRepository } from "../../src/contributions/authority-contribution-repository.ts";
import { createAuthorityProofOfValueRepository } from "../../src/evidence/authority-proof-of-value-repository.ts";
import { createPostgresIdempotencyStore } from "../../src/persistence/idempotency-store.ts";
import type { PostgresAuthorityShim } from "../../src/persistence/postgres-authority-shim.ts";
import type { TransitionAuthorizer } from "../../src/workflows/port.ts";

let harness: NetW004Harness;

beforeEach(async () => {
  harness = await createNetW004Harness();
});

afterEach(async () => {
  await harness.teardown();
});

/** An authorizer that always allows (the audit atomicity under test). */
const allowAllAuthorizer: TransitionAuthorizer = {
  async authorizeTransition() {
    return { decision: "allow", reason: "test" };
  },
};

/** Build a workflow service over the given audit writer + idempotency store. */
function buildWorkflow(
  runtime: Runtime,
  auditWriter: TransactionalAuditWriter,
  idempotency: ReturnType<typeof createPostgresIdempotencyStore>,
) {
  return createWorkflowService({
    opportunityRepository: createLifecycleRepository(
      createAuthorityOpportunityRepository({ authority: runtime.postgresAuthority }),
    ),
    contributionRepository: createLifecycleRepository(
      createAuthorityContributionRepository({ authority: runtime.postgresAuthority }),
    ),
    // NET-W005: the workflow service now routes proof_of_value
    // transitions to a PoV lifecycle repository; this NET-W004 test
    // rebuilds the service with the same shape the runtime wires.
    proofOfValueRepository: createLifecycleRepository(
      createAuthorityProofOfValueRepository({ authority: runtime.postgresAuthority }),
    ),
    authorizer: allowAllAuthorizer,
    auditWriter,
    idempotency,
    coordination: runtime.coordinationService,
  });
}

/**
 * A counting spy around an AuditWriter: records every append call made
 * against the underlying append-only writer. Buffered transactional
 * audit events reach the underlying writer ONLY on publication (the
 * transaction's afterCommit hook), so `calls` counts PUBLICATIONS.
 * An optional `timeline` records "audit-publish" markers for ordering
 * proofs.
 */
function createPublicationSpy(
  inner: AuditWriter,
  timeline?: string[],
): { writer: AuditWriter; calls: () => number } {
  let calls = 0;
  return {
    calls: () => calls,
    writer: {
      async append(input) {
        calls += 1;
        timeline?.push("audit-publish");
        return inner.append(input);
      },
      async query(query) {
        return inner.query(query);
      },
      async count() {
        return inner.count();
      },
    },
  };
}

/**
 * A spy around a TransactionalAuditWriter that counts appends made to
 * transaction-scoped buffers (i.e. audit events the workflow BUFFERED
 * inside an open transaction, before any commit). Combined with the
 * publication spy this distinguishes "appended to the buffer" from
 * "published to the underlying writer".
 */
function createBufferAppendSpy(inner: TransactionalAuditWriter): {
  writer: TransactionalAuditWriter;
  appended: () => number;
} {
  let appended = 0;
  return {
    appended: () => appended,
    writer: {
      async append(input) {
        return inner.append(input);
      },
      async query(query) {
        return inner.query(query);
      },
      async count() {
        return inner.count();
      },
      forTransaction(tx) {
        const buffer = inner.forTransaction(tx);
        return {
          async append(input) {
            const ev = await buffer.append(input);
            appended += 1;
            return ev;
          },
          async query(query) {
            return buffer.query(query);
          },
          async count() {
            return buffer.count();
          },
          pendingCount() {
            return buffer.pendingCount();
          },
        };
      },
      retryPendingPublications() {
        return inner.retryPendingPublications();
      },
      pendingPublicationCount() {
        return inner.pendingPublicationCount();
      },
    },
  };
}

/**
 * An authority whose transactions' COMMIT itself fails (the durable
 * commit never happens — e.g. a connection drop or serialization
 * failure at COMMIT time). Everything else delegates to the real
 * authority, so the workflow buffers its mutation, its idempotency
 * record AND its audit event normally — only the authoritative commit
 * fails. This is the architect-required regression boundary.
 */
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
    // The AUTHORITATIVE commit fails. The buffered writes never reach
    // committed state; the caller (idempotency store) rolls the tx
    // back, which fires the afterRollback hooks (audit discard).
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

/**
 * A flaky underlying audit writer: the first `failures` append calls
 * throw; after `heal()` every append succeeds. Used to inject a
 * publication failure AFTER a successful durable commit and prove the
 * explicit recovery path (retry → retain → retryPendingPublications).
 */
function createFlakyAuditWriter(delegate: AuditWriter): {
  writer: AuditWriter;
  heal(): void;
} {
  let failures = 2;
  return {
    heal() {
      failures = 0;
    },
    writer: {
      async append(input) {
        if (failures > 0) {
          failures -= 1;
          throw new Error("flaky audit writer: publication failed");
        }
        return delegate.append(input);
      },
      async query(query) {
        return delegate.query(query);
      },
      async count() {
        return delegate.count();
      },
    },
  };
}

describe("NET-W004-AC-07 trace/audit lineage", () => {
  test("a transition result carries execution/correlation/causation identifiers + the AUTHORITATIVE transaction id", async () => {
    const opp = await createOpportunity(harness);
    const parent = createExecutionContext({
      correlationId: "ac07-lineage-flow",
      actor: { id: "bootstrap", kind: "service" },
    });
    // The request execution context is a CHILD of the parent (causation
    // chain: parent.executionId → child.causationId).
    const child = createExecutionContext({
      correlationId: "ac07-lineage-flow", // inherited
      causationId: parent.executionId,
      actor: { id: harness.personId, kind: "person" },
    });
    const result = await harness.runtime.workflowService.requestTransition(
      {
        subjectId: opp.id,
        subjectKind: "opportunity",
        targetState: "READY",
        expectedVersion: 0,
        idempotencyKey: "ac07-lineage",
        actorPersonId: harness.personId,
        policyAction: "opportunity.transition.draft_to_ready",
      },
      child,
    );
    expect(result.executionId).toBeTruthy();
    expect(result.executionId).toBe(child.executionId);
    expect(result.correlationId).toBe(child.correlationId);
    expect(result.causationId).toBe(child.causationId);
    // The transaction id is the AUTHORITATIVE AuthorityTransaction id —
    // a distinct identifier from the execution id (the execution id
    // identifies the request; the transaction id identifies the durable
    // tx that committed the mutation + idempotency record + audit
    // record). REMEDIATION: previously this returned executionId.
    expect(result.transactionId).toBeTruthy();
    expect(result.transactionId).not.toBe(child.executionId);
    // The audit event name is namespaced + reflects the transition.
    expect(result.auditEventName).toBe("opportunity.transition.draft_to_ready");
  });

  test("an audit record is published atomically with the lifecycle mutation (published only after the durable commit)", async () => {
    const opp = await createOpportunity(harness);
    const ctx = createExecutionContext({
      correlationId: "ac07-atomic",
      actor: { id: harness.personId, kind: "person" },
    });
    const before = await harness.runtime.auditWriter.count();
    const result = await harness.runtime.workflowService.requestTransition(
      {
        subjectId: opp.id,
        subjectKind: "opportunity",
        targetState: "READY",
        expectedVersion: 0,
        idempotencyKey: "ac07-atomic",
        actorPersonId: harness.personId,
        policyAction: "opportunity.transition.draft_to_ready",
      },
      ctx,
    );
    const after = await harness.runtime.auditWriter.count();
    // Exactly one audit record was published for this transition. The
    // publication happens inside the request (the tx's afterCommit
    // hook runs — and is awaited — within tx.commit()), so when the
    // request resolves the audit record is visible.
    expect(after - before).toBe(1);
    // The audit record carries actor/subject/resource lineage.
    const events = await harness.runtime.auditWriter.query({
      eventType: "opportunity.transition.draft_to_ready",
      resourceId: opp.id,
    });
    expect(events.length).toBe(1);
    const ev = events[0]!;
    expect(ev.actor).toBe(harness.personId);
    expect(ev.subject).toBe(opp.id);
    expect(ev.resourceType).toBe("opportunity");
    expect(ev.resourceId).toBe(opp.id);
    expect(ev.correlationId).toBe(ctx.correlationId);
    expect(ev.executionId).toBe(ctx.executionId);
    // Metadata carries from/to state + version + idempotency lineage.
    expect(ev.metadata?.fromState).toBe("DRAFT");
    expect(ev.metadata?.toState).toBe("READY");
    expect(ev.metadata?.fromVersion).toBe(0);
    expect(ev.metadata?.toVersion).toBe(1);
    expect(ev.metadata?.policyAction).toBe("opportunity.transition.draft_to_ready");
    expect(ev.metadata?.idempotencyKey).toBe("ac07-atomic");
    expect(ev.metadata?.idempotencyRecordId).toBe(result.recordId);
    expect(ev.metadata?.transitionId).toBe(result.transitionId);
    expect(ev.metadata?.organizationScopeId).toBe(harness.organizationScopeId);
    // REMEDIATION — correct transactionId lineage: the audit record's
    // metadata.transactionId is the AUTHORITATIVE AuthorityTransaction
    // id (the SAME tx that committed the lifecycle mutation + the
    // idempotency record), stamped by the transactional audit buffer.
    // It is NOT the execution id.
    expect(ev.metadata?.transactionId).toBe(result.transactionId);
    expect(ev.metadata?.transactionId).not.toBe(ctx.executionId);
    // REMEDIATION — correct idempotency-record lineage: the audit
    // metadata references the REAL idempotency record id (the store's
    // record for this key), which equals result.recordId — NOT the tx
    // id (the tx id and the record id are distinct identifiers).
    const stored = await harness.runtime.idempotency.get<{
      subject: { id: string; version: number };
    }>(`workflow:opportunity:${opp.id}:ac07-atomic`);
    expect(stored).not.toBeNull();
    expect(stored!.recordId).toBe(result.recordId);
    expect(ev.metadata?.idempotencyRecordId).toBe(stored!.recordId);
    expect(ev.metadata?.idempotencyRecordId).not.toBe(result.transactionId);
  });

  test("a rolled-back transition does NOT publish an audit record (atomicity: audit + mutation commit together)", async () => {
    const opp = await createOpportunity(harness);
    const ctx = createExecutionContext({
      correlationId: "ac07-rollback",
      actor: { id: harness.personId, kind: "person" },
    });
    const before = await harness.runtime.auditWriter.count();
    // A transition with a stale expectedVersion triggers a
    // ConcurrentTransitionError, which rolls the tx back. The buffered
    // audit record is discarded by the tx's afterRollback hook (it was
    // buffered within the tx and never published).
    await expect(
      harness.runtime.workflowService.requestTransition(
        {
          subjectId: opp.id,
          subjectKind: "opportunity",
          targetState: "READY",
          expectedVersion: 999, // stale
          idempotencyKey: "ac07-rollback",
          actorPersonId: harness.personId,
          policyAction: "opportunity.transition.draft_to_ready",
        },
        ctx,
      ),
    ).rejects.toThrow();
    const after = await harness.runtime.auditWriter.count();
    expect(after - before).toBe(0);
  });

  test("REMEDIATION v2 — ordering: the audit publication happens STRICTLY AFTER the authoritative durable commit", async () => {
    // A shared timeline records (a) when the authority's durable
    // commit completes and (b) when the buffered audit event is
    // published to the underlying writer. A successful transition
    // MUST produce durable-commit FIRST, audit-publish SECOND — the
    // publication is registered on the tx's afterCommit hook and can
    // never precede the durable commit.
    const opp = await createOpportunity(harness);
    const timeline: string[] = [];

    // (a) Instrument the authority shim's durable commit application.
    const shim = harness.runtime.postgresAuthority as unknown as PostgresAuthorityShim;
    const originalApplyCommit = shim.applyCommit.bind(shim);
    shim.applyCommit = async (txId, writes) => {
      await originalApplyCommit(txId, writes);
      timeline.push("durable-commit");
    };

    // (b) Instrument the underlying audit writer via a publication spy
    //     that records "audit-publish" markers into the timeline.
    const publicationSpy = createPublicationSpy(harness.runtime.auditWriter, timeline);
    const auditWriter = createTransactionalAuditWriter({
      underlying: publicationSpy.writer,
      logger: undefined,
    });
    // Rebuild the workflow service exactly like the runtime does, but
    // over the instrumented audit writer (same authority, same
    // idempotency store, same coordination service).
    const workflow = buildWorkflow(harness.runtime, auditWriter, harness.runtime.idempotency);

    const ctx = createExecutionContext({
      correlationId: "ac07-ordering",
      actor: { id: harness.personId, kind: "person" },
    });
    const result = await workflow.requestTransition(
      {
        subjectId: opp.id,
        subjectKind: "opportunity",
        targetState: "READY",
        expectedVersion: 0,
        idempotencyKey: "ac07-ordering",
        actorPersonId: harness.personId,
        policyAction: "opportunity.transition.draft_to_ready",
      },
      ctx,
    );
    expect(result.executed).toBe(true);
    // The durable commit precedes the audit publication — and the
    // audit publication happened exactly once, never before it.
    expect(timeline).toEqual(["durable-commit", "audit-publish"]);

    // The published event is visible in the REAL audit log and carries
    // the committed tx's id (the lineage of the durable commit).
    const events = await harness.runtime.auditWriter.query({
      eventType: "opportunity.transition.draft_to_ready",
      resourceId: opp.id,
    });
    expect(events.length).toBe(1);
    expect(events[0]!.metadata?.transactionId).toBe(result.transactionId);
  });

  test("REGRESSION (architect-required): the authoritative tx commit FAILS after the audit event was appended → nothing commits, nothing publishes", async () => {
    // THE regression test required by the architect re-review: force
    // the AUTHORITATIVE transaction commit itself to fail AFTER the
    // workflow has successfully appended its audit event, then prove:
    //   lifecycle state unchanged
    //   idempotency record absent
    //   audit record absent
    // The pre-remediation design flushed the audit buffer from inside
    // performTransition() (before tx.commit()), so this failure mode
    // left a published audit record for a rolled-back mutation. The
    // remediated design registers publication on tx.afterCommit —
    // which never runs when the durable commit fails — and discard on
    // tx.afterRollback, which the idempotency store's error path
    // triggers by rolling the failed transaction back.
    const opp = await createOpportunity(harness);
    const ctx = createExecutionContext({
      correlationId: "ac07-commit-failure",
      actor: { id: harness.personId, kind: "person" },
    });

    // Instrument BOTH boundaries:
    //  - the publication spy counts appends that reached the
    //    underlying append-only writer (publications);
    //  - the buffer-append spy counts audit events the workflow
    //    BUFFERED inside the open transaction.
    const publicationSpy = createPublicationSpy(harness.runtime.auditWriter);
    const txWriter = createTransactionalAuditWriter({ underlying: publicationSpy.writer });
    const bufferSpy = createBufferAppendSpy(txWriter);

    // The authoritative commit fails for every transaction the
    // idempotency store opens over this authority.
    const failingAuthority = wrapAuthorityWithFailingCommit(harness.runtime.postgresAuthority);
    const idempotency = createPostgresIdempotencyStore({ authority: failingAuthority });
    const workflow = buildWorkflow(harness.runtime, bufferSpy.writer, idempotency);

    const auditBefore = await harness.runtime.auditWriter.count();

    // The transition fails — the authoritative commit failed.
    await expect(
      workflow.requestTransition(
        {
          subjectId: opp.id,
          subjectKind: "opportunity",
          targetState: "READY",
          expectedVersion: 0,
          idempotencyKey: "ac07-commit-failure-key",
          actorPersonId: harness.personId,
          policyAction: "opportunity.transition.draft_to_ready",
        },
        ctx,
      ),
    ).rejects.toThrow(/injected authoritative COMMIT failure/);

    // The test exercises the RIGHT failure boundary: the workflow
    // DID append its audit event to the transactional buffer (before
    // the commit attempt), and NOTHING was published.
    expect(bufferSpy.appended()).toBe(1);
    expect(publicationSpy.calls()).toBe(0);

    // (1) The lifecycle mutation was NOT committed: the subject is
    //     still DRAFT at version 0.
    const subject = await harness.runtime.opportunityService.getOpportunity(ctx, opp.id);
    expect(subject.state).toBe("DRAFT");
    expect(subject.version).toBe(0);

    // (2) The idempotency record was NOT committed: no record for the
    //     failed key under the real authority (the failed apply was
    //     rolled back wholesale).
    const key = `workflow:opportunity:${opp.id}:ac07-commit-failure-key`;
    expect(await harness.runtime.idempotency.has(key)).toBe(false);
    expect(await idempotency.has(key)).toBe(false);

    // (3) The audit record was NOT published: no transition audit for
    //     this subject in the real audit log, and the total count is
    //     unchanged — the buffered audit was discarded with the failed
    //     transaction (afterRollback), NOT published before it.
    const events = await harness.runtime.auditWriter.query({
      eventType: "opportunity.transition.draft_to_ready",
      resourceId: opp.id,
    });
    expect(events.length).toBe(0);
    expect(await harness.runtime.auditWriter.count()).toBe(auditBefore);
    // Nothing was retained for recovery either — retention only ever
    // holds events of COMMITTED transactions; this tx never committed.
    expect(txWriter.pendingPublicationCount()).toBe(0);

    // (4) A RETRY with the same idempotency key executes again (the
    //     failed apply left no idempotency record) and this time —
    //     through the REAL runtime workflow service with a healthy
    //     authority — the transition commits and publishes exactly one
    //     audit record. This proves the failed attempt committed
    //     NOTHING (otherwise the retry would be a replay).
    const retry = await harness.runtime.workflowService.requestTransition(
      {
        subjectId: opp.id,
        subjectKind: "opportunity",
        targetState: "READY",
        expectedVersion: 0,
        idempotencyKey: "ac07-commit-failure-key",
        actorPersonId: harness.personId,
        policyAction: "opportunity.transition.draft_to_ready",
      },
      ctx,
    );
    expect(retry.executed).toBe(true);
    expect(retry.subject.state).toBe("READY");
    expect(retry.subject.version).toBe(1);
    const retriedEvents = await harness.runtime.auditWriter.query({
      eventType: "opportunity.transition.draft_to_ready",
      resourceId: opp.id,
    });
    expect(retriedEvents.length).toBe(1);
    expect(retriedEvents[0]!.metadata?.transactionId).toBe(retry.transactionId);
  });

  test("REMEDIATION v2 — audit publication failure AFTER a successful commit: durable commit stands, event retained, explicit recovery publishes it", async () => {
    // The OTHER side of the ordering contract: the durable commit
    // succeeded, but publishing the buffered audit event to the
    // underlying writer fails. The publication is retried; on
    // exhaustion the event is RETAINED (never discarded — the
    // mutation IS committed) for the explicit retryPendingPublications()
    // recovery path. Because retained events always belong to a
    // COMMITTED transaction, the recovery can never create "audit
    // exists, mutation doesn't".
    const opp = await createOpportunity(harness);
    const ctx = createExecutionContext({
      correlationId: "ac07-publication-failure",
      actor: { id: harness.personId, kind: "person" },
    });

    // The underlying writer fails the first 2 appends (the publication
    // attempts of the single buffered transition event), then heals.
    const flaky = createFlakyAuditWriter(harness.runtime.auditWriter);
    const auditWriter = createTransactionalAuditWriter({
      underlying: flaky.writer,
      publicationAttempts: 2,
      publicationBackoffMs: 1,
    });
    // The workflow service uses the REAL runtime authority +
    // idempotency store (the durable commit path is healthy); only the
    // audit publication is faulty.
    const workflow = buildWorkflow(harness.runtime, auditWriter, harness.runtime.idempotency);

    const auditBefore = await harness.runtime.auditWriter.count();
    const key = `workflow:opportunity:${opp.id}:ac07-publication-failure-key`;

    // The transition SUCCEEDS: the durable commit is the source of
    // truth and is never undone by a publication failure (undoing it
    // could make callers retry a committed mutation).
    const result = await workflow.requestTransition(
      {
        subjectId: opp.id,
        subjectKind: "opportunity",
        targetState: "READY",
        expectedVersion: 0,
        idempotencyKey: "ac07-publication-failure-key",
        actorPersonId: harness.personId,
        policyAction: "opportunity.transition.draft_to_ready",
      },
      ctx,
    );
    expect(result.executed).toBe(true);
    expect(result.subject.state).toBe("READY");
    expect(result.subject.version).toBe(1);

    // (1) The lifecycle mutation IS committed.
    const subject = await harness.runtime.opportunityService.getOpportunity(ctx, opp.id);
    expect(subject.state).toBe("READY");
    expect(subject.version).toBe(1);
    // (2) The idempotency record IS committed (the apply succeeded).
    expect(await harness.runtime.idempotency.has(key)).toBe(true);
    // (3) The audit event is NOT yet visible (publication failed) but
    //     is RETAINED — pending recovery, never discarded.
    const invisible = await harness.runtime.auditWriter.query({
      eventType: "opportunity.transition.draft_to_ready",
      resourceId: opp.id,
    });
    expect(invisible.length).toBe(0);
    expect(await harness.runtime.auditWriter.count()).toBe(auditBefore);
    expect(auditWriter.pendingPublicationCount()).toBe(1);

    // (4) EXPLICIT RECOVERY: heal the underlying writer, then retry
    //     the retained publication. The event is published with the
    //     COMMITTED transaction's lineage — converging the audit trail
    //     toward the committed state (never the other way around).
    flaky.heal();
    const recovery = await auditWriter.retryPendingPublications();
    expect(recovery.published).toBe(1);
    expect(recovery.remaining).toBe(0);
    expect(auditWriter.pendingPublicationCount()).toBe(0);

    const events = await harness.runtime.auditWriter.query({
      eventType: "opportunity.transition.draft_to_ready",
      resourceId: opp.id,
    });
    expect(events.length).toBe(1);
    expect(events[0]!.metadata?.transactionId).toBe(result.transactionId);
    expect(events[0]!.metadata?.transactionId).not.toBe(ctx.executionId);
    // Exactly one audit record exists for the transition — the failed
    // publication attempts did not partially publish anything.
    expect(await harness.runtime.auditWriter.count()).toBe(auditBefore + 1);
  });

  test("REMEDIATION: the runtime's audit writer IS the transactional audit writer (bootstrap wiring; buffer publishes on tx.commit, discards on tx.rollback)", async () => {
    // The bootstrap composition root wires createTransactionalAuditWriter
    // (the ordinary in-memory DIRECT writer is only the underlying
    // append-only store). The runtime's auditWriter must expose
    // forTransaction(tx) — the workflow authority depends on it for
    // ordered (post-commit) audit publication.
    const writer = harness.runtime.auditWriter as unknown;
    expect(typeof (writer as { forTransaction?: unknown }).forTransaction).toBe("function");
    expect(typeof (writer as { retryPendingPublications?: unknown }).retryPendingPublications).toBe(
      "function",
    );

    const ctx = createExecutionContext({
      correlationId: "ac07-tx-wiring",
      actor: { id: harness.personId, kind: "person" },
    });

    // COMMIT path: appends are BUFFERED (invisible) until the bound
    // transaction commits; tx.commit() publishes them with the
    // authoritative transactionId lineage.
    const tx = await harness.runtime.postgresAuthority.begin(ctx);
    const buffer = harness.runtime.auditWriter.forTransaction(tx);
    expect(buffer.pendingCount()).toBe(0);
    const before = await harness.runtime.auditWriter.count();
    await buffer.append({
      eventType: "system.startup",
      context: ctx,
      metadata: { probe: "ac07-tx-wiring-commit" },
    });
    expect(buffer.pendingCount()).toBe(1);
    // Buffered events are NOT visible while the tx is open.
    expect(await harness.runtime.auditWriter.count()).toBe(before);
    // There is NO way to publish the buffer from inside the tx (the
    // remediated design removed buffer.commit()); the ONLY publisher
    // is the transaction's afterCommit hook.
    expect((buffer as { commit?: unknown }).commit).toBeUndefined();
    // Committing the tx publishes the buffered event.
    await tx.commit();
    expect(await harness.runtime.auditWriter.count()).toBe(before + 1);
    const events = await harness.runtime.auditWriter.query({ eventType: "system.startup" });
    const probe = events.find((e) => e.metadata?.probe === "ac07-tx-wiring-commit");
    expect(probe).toBeDefined();
    expect(probe!.metadata?.transactionId).toBe(tx.transactionId);

    // ROLLBACK path: a rolled-back transaction discards its buffer —
    // the buffered event is never published.
    const tx2 = await harness.runtime.postgresAuthority.begin(ctx);
    const buffer2 = harness.runtime.auditWriter.forTransaction(tx2);
    const before2 = await harness.runtime.auditWriter.count();
    await buffer2.append({
      eventType: "system.shutdown",
      context: ctx,
      metadata: { probe: "ac07-tx-wiring-rollback" },
    });
    expect(buffer2.pendingCount()).toBe(1);
    await tx2.rollback();
    expect(await harness.runtime.auditWriter.count()).toBe(before2);
    const rolled = await harness.runtime.auditWriter.query({ eventType: "system.shutdown" });
    expect(rolled.find((e) => e.metadata?.probe === "ac07-tx-wiring-rollback")).toBeUndefined();
    // The buffer settled with the tx: further appends are rejected.
    await expect(
      buffer2.append({
        eventType: "system.shutdown",
        context: ctx,
        metadata: { probe: "ac07-tx-wiring-rollback" },
      }),
    ).rejects.toThrow(/settled/);
    // And a buffer cannot be bound to an already-settled transaction.
    expect(() => harness.runtime.auditWriter.forTransaction(tx2)).toThrow();
  });

  test("audit records are append-only and immutable (deeply frozen)", async () => {
    const opp = await createOpportunity(harness);
    const ctx = createExecutionContext({
      correlationId: "ac07-immutable",
      actor: { id: harness.personId, kind: "person" },
    });
    await harness.runtime.workflowService.requestTransition(
      {
        subjectId: opp.id,
        subjectKind: "opportunity",
        targetState: "READY",
        expectedVersion: 0,
        idempotencyKey: "ac07-immutable",
        actorPersonId: harness.personId,
        policyAction: "opportunity.transition.draft_to_ready",
      },
      ctx,
    );
    const events = await harness.runtime.auditWriter.query({
      eventType: "opportunity.transition.draft_to_ready",
    });
    for (const ev of events) {
      // NET-W001-AC-06 deep immutability — the audit record itself is frozen.
      expect(Object.isFrozen(ev)).toBe(true);
      // Mutation attempts throw in strict mode (or fail silently).
      expect(() => {
        // @ts-expect-error: attempting to mutate a frozen object
        ev.actor = "tampered";
      }).toThrow();
    }
  });

  test("the audit record carries the actor/subject/resource lineage even on cross-domain transitions (opportunity vs contribution)", async () => {
    const opp = await createOpportunity(harness);
    const ctx = createExecutionContext({
      correlationId: "ac07-cross-domain",
      actor: { id: harness.personId, kind: "person" },
    });
    const c = await harness.runtime.contributionService.createContribution(ctx, {
      opportunityId: opp.id,
      contributorId: harness.personId,
      organizationScopeId: harness.organizationScopeId,
      contributionType: "test",
    });
    // Transition the contribution DRAFT → READY.
    const result = await harness.runtime.workflowService.requestTransition(
      {
        subjectId: c.id,
        subjectKind: "contribution",
        targetState: "READY",
        expectedVersion: 0,
        idempotencyKey: "ac07-contribution",
        actorPersonId: harness.personId,
        policyAction: "contribution.transition.draft_to_ready",
      },
      ctx,
    );
    expect(result.auditEventName).toBe("contribution.transition.draft_to_ready");
    const events = await harness.runtime.auditWriter.query({
      eventType: "contribution.transition.draft_to_ready",
      resourceId: c.id,
    });
    expect(events.length).toBe(1);
    const ev = events[0]!;
    expect(ev.resourceType).toBe("contribution");
    expect(ev.resourceId).toBe(c.id);
    expect(ev.actor).toBe(harness.personId);
    expect(ev.subject).toBe(c.id);
    // Contribution transitions carry the same authoritative tx lineage.
    expect(ev.metadata?.transactionId).toBe(result.transactionId);
    expect(ev.metadata?.transactionId).not.toBe(ctx.executionId);
  });
});
