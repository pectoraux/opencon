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
 * NET-W004-AC-07 REMEDIATION (architect re-review on PR #8): the
 * workflow's audit writes go through the TRANSACTIONAL audit writer
 * (forTransaction(tx) buffer bound to the SAME AuthorityTransaction as
 * the lifecycle mutation + the idempotency record). These tests prove:
 *  - the runtime's audit writer IS the transactional audit writer
 *    (bootstrap wiring, not the ordinary in-memory direct writer);
 *  - the audit record carries the AUTHORITATIVE transactionId
 *    (tx.transactionId — NOT the execution id);
 *  - rollback-on-audit-failure: an audit write failure rolls back the
 *    WHOLE authoritative tx (lifecycle mutation + idempotency record +
 *    audit record all discarded — no committed mutation without
 *    committed audit lineage);
 *  - the idempotency-record lineage in the audit metadata references
 *    the REAL idempotency record id (not the tx id).
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { createExecutionContext } from "../../src/core/execution-context.ts";
import type { AuditWriter } from "../../src/core/audit.ts";
import {
  createNetW004Harness,
  createOpportunity,
  type NetW004Harness,
} from "./_net-w004-harness.ts";
// Direct construction for the rollback-on-audit-failure fault injection:
// the workflow service is rebuilt with a FAULTY transactional audit
// writer over the SAME authority/idempotency/coordination providers,
// proving that the mutation rolls back when the audit write fails.
import { createTransactionalAuditWriter } from "../../src/audit/transactional-audit-writer.ts";
import { createWorkflowService } from "../../src/workflows/workflow-service.ts";
import { createLifecycleRepository } from "../../src/workflows/lifecycle-repository.ts";
import { createAuthorityOpportunityRepository } from "../../src/opportunities/authority-opportunity-repository.ts";
import { createAuthorityContributionRepository } from "../../src/contributions/authority-contribution-repository.ts";
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

/**
 * A FAULTY underlying audit writer: every append throws. Used to prove
 * rollback-on-audit-failure — the workflow's buffered audit record is
 * flushed through the underlying writer at buffer commit; when that
 * flush fails the whole authoritative tx rolls back.
 */
function createFaultyAuditWriter(): AuditWriter {
  return {
    async append() {
      throw new Error("faulty audit writer: append failed");
    },
    async query() {
      return [];
    },
    async count() {
      return 0;
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

  test("an audit record is appended atomically with the lifecycle mutation (single commit)", async () => {
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
    // Exactly one audit record was appended for this transition.
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

  test("a rolled-back transition does NOT append an audit record (atomicity: audit + mutation commit together)", async () => {
    const opp = await createOpportunity(harness);
    const ctx = createExecutionContext({
      correlationId: "ac07-rollback",
      actor: { id: harness.personId, kind: "person" },
    });
    const before = await harness.runtime.auditWriter.count();
    // A transition with a stale expectedVersion triggers a
    // ConcurrentTransitionError, which rolls back the tx. The audit
    // record is discarded (it was buffered within the tx).
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

  test("REMEDIATION: rollback-on-audit-failure — an audit write failure rolls back the WHOLE authoritative tx", async () => {
    // Rebuild the workflow service over the SAME authority /
    // idempotency store / coordination service, but with a FAULTY
    // transactional audit writer (every underlying append throws). The
    // audit buffer's flush calls the underlying writer; when the flush
    // fails the workflow service throws so the idempotency store rolls
    // back the authoritative tx — the lifecycle mutation + the
    // idempotency record + the audit record are ALL discarded.
    const faultyWorkflow = createWorkflowService({
      opportunityRepository: createLifecycleRepository(
        createAuthorityOpportunityRepository({
          authority: harness.runtime.postgresAuthority,
        }),
      ),
      contributionRepository: createLifecycleRepository(
        createAuthorityContributionRepository({
          authority: harness.runtime.postgresAuthority,
        }),
      ),
      authorizer: allowAllAuthorizer,
      auditWriter: createTransactionalAuditWriter({
        underlying: createFaultyAuditWriter(),
      }),
      idempotency: harness.runtime.idempotency,
      coordination: harness.runtime.coordinationService,
    });

    const opp = await createOpportunity(harness);
    const ctx = createExecutionContext({
      correlationId: "ac07-audit-failure",
      actor: { id: harness.personId, kind: "person" },
    });
    const auditBefore = await harness.runtime.auditWriter.count();

    // The transition MUST fail (the audit flush throws).
    await expect(
      faultyWorkflow.requestTransition(
        {
          subjectId: opp.id,
          subjectKind: "opportunity",
          targetState: "READY",
          expectedVersion: 0,
          idempotencyKey: "ac07-audit-failure-key",
          actorPersonId: harness.personId,
          policyAction: "opportunity.transition.draft_to_ready",
        },
        ctx,
      ),
    ).rejects.toThrow(/faulty audit writer/);

    // (1) The lifecycle mutation was ROLLED BACK: the subject is still
    //     DRAFT at version 0 — no committed mutation without committed
    //     audit lineage.
    const subject = await harness.runtime.opportunityService.getOpportunity(ctx, opp.id);
    expect(subject.state).toBe("DRAFT");
    expect(subject.version).toBe(0);

    // (2) The idempotency record was ROLLED BACK: no record for the
    //     failed key (a retry with the same key executes again).
    const key = `workflow:opportunity:${opp.id}:ac07-audit-failure-key`;
    expect(await harness.runtime.idempotency.has(key)).toBe(false);

    // (3) No audit records were appended to the runtime's real audit
    //     log for this subject's transition (the faulty writer
    //     discarded them with the tx).
    const events = await harness.runtime.auditWriter.query({
      eventType: "opportunity.transition.draft_to_ready",
      resourceId: opp.id,
    });
    expect(events.length).toBe(0);
    expect(await harness.runtime.auditWriter.count()).toBe(auditBefore);

    // (4) A RETRY with the same idempotency key executes again (the
    //     failed apply left no idempotency record) — proving the whole
    //     apply rolled back atomically. This time use the REAL workflow
    //     service (healthy audit writer): the transition succeeds.
    const retry = await harness.runtime.workflowService.requestTransition(
      {
        subjectId: opp.id,
        subjectKind: "opportunity",
        targetState: "READY",
        expectedVersion: 0,
        idempotencyKey: "ac07-audit-failure-key",
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

  test("REMEDIATION: the runtime's audit writer IS the transactional audit writer (bootstrap wiring)", async () => {
    // The bootstrap composition root wires createTransactionalAuditWriter
    // (the ordinary in-memory DIRECT writer is only the underlying
    // append-only store). The runtime's auditWriter must expose
    // forTransaction(tx) — the workflow authority depends on it for
    // atomic audit lineage.
    const writer = harness.runtime.auditWriter as unknown;
    expect(typeof (writer as { forTransaction?: unknown }).forTransaction).toBe("function");
    // The transactional buffer bound to a real authoritative tx:
    // appends are BUFFERED (not visible via query/count) until the
    // buffer commits, and the buffer stamps the AUTHORITATIVE tx id.
    const ctx = createExecutionContext({
      correlationId: "ac07-tx-wiring",
      actor: { id: harness.personId, kind: "person" },
    });
    const tx = await harness.runtime.postgresAuthority.begin(ctx);
    try {
      const buffer = harness.runtime.auditWriter.forTransaction(tx);
      expect(buffer.pendingCount()).toBe(0);
      const before = await harness.runtime.auditWriter.count();
      await buffer.append({
        eventType: "system.startup",
        context: ctx,
        metadata: { probe: "ac07-tx-wiring" },
      });
      expect(buffer.pendingCount()).toBe(1);
      // Buffered events are NOT visible until the buffer commits.
      expect(await harness.runtime.auditWriter.count()).toBe(before);
      // Flush the buffer WITHOUT committing the tx — the event becomes
      // visible and carries the authoritative transactionId lineage.
      await buffer.commit();
      expect(await harness.runtime.auditWriter.count()).toBe(before + 1);
      const events = await harness.runtime.auditWriter.query({
        eventType: "system.startup",
      });
      const probe = events.find((e) => e.metadata?.probe === "ac07-tx-wiring");
      expect(probe).toBeDefined();
      expect(probe!.metadata?.transactionId).toBe(tx.transactionId);
    } finally {
      // The probe tx had no authority writes; rolling it back discards
      // nothing authoritative (the audit buffer was already flushed).
      await tx.rollback();
    }
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
