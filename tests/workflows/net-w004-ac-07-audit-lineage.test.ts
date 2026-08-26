/**
 * NET-W004-AC-07 — Trace/audit lineage.
 *
 * Every material lifecycle mutation records stable execution/
 * correlation/causation identifiers, actor/subject/resource lineage,
 * and an append-oriented audit record that is committed atomically with
 * the authoritative state mutation.
 *
 * Evidence: audit/trace integration tests.
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { createExecutionContext } from "../../src/core/execution-context.ts";
import {
  createNetW004Harness,
  createOpportunity,
  type NetW004Harness,
} from "./_net-w004-harness.ts";

let harness: NetW004Harness;

beforeEach(async () => {
  harness = await createNetW004Harness();
});

afterEach(async () => {
  await harness.teardown();
});

describe("NET-W004-AC-07 trace/audit lineage", () => {
  test("a transition result carries execution/correlation/causation identifiers + transaction id", async () => {
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
    expect(result.transactionId).toBeTruthy();
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
  });
});
