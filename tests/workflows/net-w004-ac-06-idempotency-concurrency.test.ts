/**
 * NET-W004-AC-06 — Idempotency and concurrency.
 *
 * Repeated delivery of the same transition request with the same
 * idempotency key results in exactly one authoritative mutation/audit
 * lineage. Concurrent stale writers are rejected or deterministically
 * serialized; no lost update occurs.
 *
 * Evidence: concurrency/integration tests using NET-W003 persistence/
 * idempotency boundaries.
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { createExecutionContext } from "../../src/core/execution-context.ts";
import { ConcurrentTransitionError } from "../../src/core/workflow.ts";
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

describe("NET-W004-AC-06 idempotency and concurrency", () => {
  test("repeating the same transition with the same idempotency key is a deterministic replay (executed=false, single mutation, single audit)", async () => {
    const opp = await createOpportunity(harness);
    const ctx = createExecutionContext({
      correlationId: "ac06-idempotent",
      actor: { id: harness.personId, kind: "person" },
    });
    const request = {
      subjectId: opp.id,
      subjectKind: "opportunity" as const,
      targetState: "READY" as const,
      expectedVersion: 0,
      idempotencyKey: "ac06-idempotent-key",
      actorPersonId: harness.personId,
      policyAction: "opportunity.transition.draft_to_ready",
    };
    // First call — executes the transition.
    const r1 = await harness.runtime.workflowService.requestTransition(request, ctx);
    expect(r1.executed).toBe(true);
    expect(r1.subject.state).toBe("READY");
    expect(r1.subject.version).toBe(1);
    const firstTransitionId = r1.transitionId;
    const firstRecordId = r1.recordId;

    // Second call with the SAME idempotency key — deterministic replay.
    const r2 = await harness.runtime.workflowService.requestTransition(request, ctx);
    expect(r2.executed).toBe(false);
    // The returned subject reflects the SAME authoritative state (READY, v1).
    expect(r2.subject.state).toBe("READY");
    expect(r2.subject.version).toBe(1);
    // The transition + record ids are stable (deterministic replay).
    expect(r2.transitionId).toBe(firstTransitionId);
    expect(r2.recordId).toBe(firstRecordId);

    // Confirm the audit log has exactly ONE record for this transition.
    const auditEvents = await harness.runtime.auditWriter.query({
      eventType: "opportunity.transition.draft_to_ready",
    });
    expect(auditEvents.length).toBe(1);
    // The single audit record carries the idempotency key + record id.
    expect(auditEvents[0]!.metadata?.idempotencyKey).toBe("ac06-idempotent-key");
    expect(auditEvents[0]!.metadata?.idempotencyRecordId).toBe(firstRecordId);
  });

  test("different idempotency keys produce different transitions (no false replays)", async () => {
    const opp1 = await createOpportunity(harness);
    const opp2 = await createOpportunity(harness);
    const ctx = createExecutionContext({
      correlationId: "ac06-distinct",
      actor: { id: harness.personId, kind: "person" },
    });
    const r1 = await harness.runtime.workflowService.requestTransition(
      {
        subjectId: opp1.id,
        subjectKind: "opportunity",
        targetState: "READY",
        expectedVersion: 0,
        idempotencyKey: "key-1",
        actorPersonId: harness.personId,
        policyAction: "opportunity.transition.draft_to_ready",
      },
      ctx,
    );
    const r2 = await harness.runtime.workflowService.requestTransition(
      {
        subjectId: opp2.id,
        subjectKind: "opportunity",
        targetState: "READY",
        expectedVersion: 0,
        idempotencyKey: "key-2",
        actorPersonId: harness.personId,
        policyAction: "opportunity.transition.draft_to_ready",
      },
      ctx,
    );
    expect(r1.executed).toBe(true);
    expect(r2.executed).toBe(true);
    expect(r1.transitionId).not.toBe(r2.transitionId);
    expect(r1.recordId).not.toBe(r2.recordId);
  });

  test("a stale writer (wrong expectedVersion) is rejected as ConcurrentTransitionError", async () => {
    const opp = await createOpportunity(harness);
    const ctx = createExecutionContext({
      correlationId: "ac06-stale",
      actor: { id: harness.personId, kind: "person" },
    });
    // First transition: DRAFT (v0) → READY (v1).
    await harness.runtime.workflowService.requestTransition(
      {
        subjectId: opp.id,
        subjectKind: "opportunity",
        targetState: "READY",
        expectedVersion: 0,
        idempotencyKey: "ac06-stale-1",
        actorPersonId: harness.personId,
        policyAction: "opportunity.transition.draft_to_ready",
      },
      ctx,
    );
    // A stale writer attempts to transition from v0 again — but the
    // authoritative version is now 1. The workflow service MUST reject
    // with ConcurrentTransitionError (optimistic concurrency).
    await expect(
      harness.runtime.workflowService.requestTransition(
        {
          subjectId: opp.id,
          subjectKind: "opportunity",
          targetState: "ASSIGNED",
          expectedVersion: 0, // stale — should be 1
          idempotencyKey: "ac06-stale-2",
          actorPersonId: harness.personId,
          policyAction: "opportunity.transition.ready_to_assigned",
        },
        ctx,
      ),
    ).rejects.toBeInstanceOf(ConcurrentTransitionError);
  });

  test("two concurrent transition requests with the SAME idempotency key produce exactly one mutation", async () => {
    const opp = await createOpportunity(harness);
    const ctx = createExecutionContext({
      correlationId: "ac06-concurrent",
      actor: { id: harness.personId, kind: "person" },
    });
    const request = {
      subjectId: opp.id,
      subjectKind: "opportunity" as const,
      targetState: "READY" as const,
      expectedVersion: 0,
      idempotencyKey: "ac06-concurrent-key",
      actorPersonId: harness.personId,
      policyAction: "opportunity.transition.draft_to_ready",
    };
    // Fire two concurrent requests with the same idempotency key.
    // The idempotency store's per-key mutex serializes them: one
    // executes, the other is a deterministic replay.
    const [r1, r2] = await Promise.all([
      harness.runtime.workflowService.requestTransition(request, ctx),
      harness.runtime.workflowService.requestTransition(request, ctx),
    ]);
    // Exactly one executed.
    const executedCount = [r1.executed, r2.executed].filter(Boolean).length;
    expect(executedCount).toBe(1);
    // Both return the SAME authoritative subject (state=READY, version=1).
    expect(r1.subject.state).toBe("READY");
    expect(r2.subject.state).toBe("READY");
    expect(r1.subject.version).toBe(1);
    expect(r2.subject.version).toBe(1);
    // The audit log has exactly ONE record.
    const auditEvents = await harness.runtime.auditWriter.query({
      eventType: "opportunity.transition.draft_to_ready",
    });
    expect(auditEvents.length).toBe(1);
  });

  test("the idempotency record persists durably (survives the workflow service's lifetime)", async () => {
    // The IdempotencyStore is backed by the PostgresAuthority boundary.
    // A record written by one apply call is visible to a subsequent
    // has() call.
    const opp = await createOpportunity(harness);
    const ctx = createExecutionContext({
      correlationId: "ac06-durable",
      actor: { id: harness.personId, kind: "person" },
    });
    const idempotencyKey = "ac06-durable-key";
    await harness.runtime.workflowService.requestTransition(
      {
        subjectId: opp.id,
        subjectKind: "opportunity",
        targetState: "READY",
        expectedVersion: 0,
        idempotencyKey,
        actorPersonId: harness.personId,
        policyAction: "opportunity.transition.draft_to_ready",
      },
      ctx,
    );
    // The idempotency store has a record for this key. The key the
    // workflow service uses is namespaced: "workflow:opportunity:<id>:<idempotencyKey>".
    const fullKey = `workflow:opportunity:${opp.id}:${idempotencyKey}`;
    const has = await harness.runtime.idempotency.has(fullKey);
    expect(has).toBe(true);
    const count = await harness.runtime.idempotency.count();
    expect(count).toBeGreaterThan(0);
  });
});
