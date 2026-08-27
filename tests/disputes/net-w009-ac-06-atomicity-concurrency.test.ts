/**
 * NET-W009-AC-06 — Risk mutations are idempotent, concurrent-safe,
 * PostgreSQL-authoritative, and audit-linked atomically.
 *
 * Work order ref: spec/work-orders/NET-W009.md §3.8, §4 invariant 7
 * (auditability and atomicity — every material risk mutation commits
 * with its idempotency record and audit lineage in ONE authoritative
 * transaction); NET-W004-AC-07 semantics.
 * Issue #17 acceptance evidence 6.
 */

import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import {
  createNetW009Harness,
  createDefaultRiskPolicy,
  createDefaultSignal,
  actorCtx,
  freshSubject,
  EVALUATED_AT,
  type NetW009Harness,
} from "./_net-w009-harness.ts";

let h: NetW009Harness;
beforeAll(async () => {
  h = await createNetW009Harness();
});
afterAll(async () => {
  await h.teardown();
});

describe("NET-W009-AC-06 idempotent, concurrent-safe, authoritative, audit-linked mutations", () => {
  test("audit events for the risk mutations are queryable through the authority (AUD-005)", async () => {
    const ctx = actorCtx(h, "ac06-audit");
    const subject = await freshSubject(h);
    await createDefaultRiskPolicy(h, "ac06-audit-policy");
    const { signal } = await createDefaultSignal(h, {
      subjectPersonId: subject,
      idempotencyKey: "ac06-audit-signal",
    });
    const assessment = await h.runtime.riskAssessmentService.recordAssessment(ctx, {
      organizationScopeId: h.organizationScopeId,
      subjectPersonId: subject,
      policyId: "ac06-audit-policy",
      evaluatedAt: EVALUATED_AT,
      idempotencyKey: "ac06-audit-assessment",
    });
    const control = await h.runtime.riskControlService.activateControl(ctx, {
      organizationScopeId: h.organizationScopeId,
      operationClass: "value_maturation",
      action: "HOLD",
      subjectPersonId: subject,
      originAssessmentId: assessment.assessment.id,
      reasonCodes: ["audit_probe"],
      idempotencyKey: "ac06-audit-control",
    });
    await h.runtime.riskControlService.resolveControl(ctx, {
      controlDecisionId: control.control.id,
      idempotencyKey: "ac06-audit-resolve",
    });
    // The audit log (flushed through the transactional audit writer,
    // committed WITH each mutation) carries every event type.
    const query = async (eventType: string) =>
      (await h.runtime.auditWriter.query({ eventType })) as readonly {
        resourceId: string;
        metadata: Record<string, unknown>;
      }[];
    for (const expected of [
      "risk_policy.version_created",
      "risk_signal.recorded",
      "risk_assessment.recorded",
      "risk_control.activated",
      "risk_control.resolved",
    ]) {
      const events = await query(expected);
      expect(events.length, `audit event ${expected} should exist`).toBeGreaterThan(0);
    }
    // The signal audit record names the exact resource.
    const signalEvents = await query("risk_signal.recorded");
    expect(
      signalEvents.filter((e) => e.resourceId === signal.id),
    ).toHaveLength(1);
  });

  test("idempotent replay: every mutation type replays its committed record (created=false)", async () => {
    const ctx = actorCtx(h, "ac06-replay");
    const subject = await freshSubject(h);
    await createDefaultRiskPolicy(h, "ac06-replay-policy");
    const first = await createDefaultSignal(h, {
      subjectPersonId: subject,
      idempotencyKey: "ac06-replay-signal",
    });
    // Signal replay.
    const signalReplay = await h.runtime.riskSignalService.createSignal(ctx, {
      organizationScopeId: h.organizationScopeId,
      subjectPersonId: subject,
      category: first.signal.category,
      severity: first.signal.severity,
      confidence: first.signal.confidence,
      provenance: {
        kind: first.signal.provenance.kind,
        detectionMethod: first.signal.provenance.detectionMethod,
        detectionVersion: first.signal.provenance.detectionVersion,
        sources: first.signal.provenance.sources.map((s) => ({ kind: s.kind, id: s.id })),
      },
      detectedAt: first.signal.detectedAt,
      idempotencyKey: "ac06-replay-signal",
    });
    expect(signalReplay.created).toBe(false);
    // Assessment replay.
    const a1 = await h.runtime.riskAssessmentService.recordAssessment(ctx, {
      organizationScopeId: h.organizationScopeId,
      subjectPersonId: subject,
      policyId: "ac06-replay-policy",
      evaluatedAt: EVALUATED_AT,
      idempotencyKey: "ac06-replay-assessment",
    });
    const a2 = await h.runtime.riskAssessmentService.recordAssessment(ctx, {
      organizationScopeId: h.organizationScopeId,
      subjectPersonId: subject,
      policyId: "ac06-replay-policy",
      evaluatedAt: EVALUATED_AT,
      idempotencyKey: "ac06-replay-assessment",
    });
    expect(a2.created).toBe(false);
    expect(a2.assessment.id).toBe(a1.assessment.id);
    // Control replay.
    const c1 = await h.runtime.riskControlService.activateControl(ctx, {
      organizationScopeId: h.organizationScopeId,
      operationClass: "value_maturation",
      action: "HOLD",
      subjectPersonId: subject,
      originAssessmentId: a1.assessment.id,
      reasonCodes: ["replay"],
      idempotencyKey: "ac06-replay-control",
    });
    const c2 = await h.runtime.riskControlService.activateControl(ctx, {
      organizationScopeId: h.organizationScopeId,
      operationClass: "value_maturation",
      action: "HOLD",
      subjectPersonId: subject,
      originAssessmentId: a1.assessment.id,
      reasonCodes: ["replay"],
      idempotencyKey: "ac06-replay-control",
    });
    expect(c2.created).toBe(false);
    expect(c2.control.id).toBe(c1.control.id);
  });

  test("concurrent same-key signal creates: exactly one record + one audit event", async () => {
    const ctx = actorCtx(h, "ac06-concurrent-signal");
    const subject = await freshSubject(h);
    const { createVerifiedPoV } = await import("../settlement/_net-w008-harness.ts");
    const pov = await createVerifiedPoV(h.w008);
    const mk = () =>
      h.runtime.riskSignalService.createSignal(ctx, {
        organizationScopeId: h.organizationScopeId,
        subjectPersonId: subject,
        category: "identity",
        severity: "MEDIUM",
        confidence: 1,
        provenance: {
          kind: "rule_detection",
          detectionMethod: "concurrent",
          detectionVersion: "1",
          sources: [{ kind: "proof_of_value", id: pov.id }],
        },
        detectedAt: "2024-05-01T00:00:00.000Z",
        idempotencyKey: "ac06-conc-signal-key",
      });
    const results = await Promise.allSettled([mk(), mk()]);
    const fulfilled = results.filter((r) => r.status === "fulfilled") as (
      | PromiseFulfilledResult<{ signal: { id: string }; created: boolean }>
    )[];
    expect(fulfilled).toHaveLength(2);
    const ids = new Set(fulfilled.map((r) => r.value.signal.id));
    expect(ids.size).toBe(1);
    expect(fulfilled.filter((r) => r.value.created)).toHaveLength(1);
    const auditRecords = (await h.runtime.auditWriter.query({
      eventType: "risk_signal.recorded",
    })) as readonly { resourceId: string; metadata: Record<string, unknown> }[];
    const matching = auditRecords.filter((r) =>
      fulfilled.some((f) => f.value.signal.id === r.resourceId),
    );
    // exactly-one audit event for the exactly-one record
    expect(matching).toHaveLength(1);
  });

  test("concurrent signal supersession: exactly one correction wins; the other conflicts", async () => {
    const ctx = actorCtx(h, "ac06-concurrent-supersede");
    const subject = await freshSubject(h);
    const { createVerifiedPoV } = await import("../settlement/_net-w008-harness.ts");
    const pov = await createVerifiedPoV(h.w008);
    const { signal } = await h.runtime.riskSignalService.createSignal(ctx, {
      organizationScopeId: h.organizationScopeId,
      subjectPersonId: subject,
      category: "identity",
      severity: "HIGH",
      confidence: 1,
      provenance: {
        kind: "authoritative_record",
        detectionMethod: "d",
        detectionVersion: "1",
        sources: [{ kind: "proof_of_value", id: pov.id }],
      },
      detectedAt: "2024-05-01T00:00:00.000Z",
      idempotencyKey: "ac06-sup-original",
    });
    const mk = (key: string) =>
      h.runtime.riskSignalService.supersedeSignal(ctx, {
        signalId: signal.id,
        category: "identity",
        severity: "LOW",
        confidence: 1,
        provenance: {
          kind: "authoritative_record",
          detectionMethod: "d",
          detectionVersion: "1",
          sources: [{ kind: "proof_of_value", id: pov.id }],
        },
        detectedAt: "2024-05-01T00:00:00.000Z",
        idempotencyKey: key,
      });
    const results = await Promise.allSettled([mk("ac06-sup-a"), mk("ac06-sup-b")]);
    const ok = results.filter((r) => r.status === "fulfilled");
    const rejected = results.filter((r) => r.status === "rejected");
    expect(ok).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect((rejected[0] as PromiseRejectedResult).reason.code).toBe("CONFLICT");
    // The original is superseded exactly once.
    const original = await h.runtime.riskSignalService.getSignal(ctx, signal.id);
    expect(original.supersededBySignalId).toBe((ok[0] as PromiseFulfilledResult<{ correction: { id: string } }>).value.correction.id);
  });

  test("concurrent case decisions on one case serialize to a consistent append-only history", async () => {
    const ctx = actorCtx(h, "ac06-concurrent-case");
    const { signal } = await createDefaultSignal(h, { idempotencyKey: "ac06-cc-signal" });
    const { riskCase } = await h.runtime.riskCaseService.openCase(ctx, {
      organizationScopeId: h.organizationScopeId,
      subjectPersonId: h.personId,
      title: "Concurrent decisions",
      reasonCodes: ["probe"],
      sourceRefs: [{ kind: "risk_signal", id: signal.id }],
      idempotencyKey: "ac06-cc-case",
    });
    const reviewer = (await import("./_net-w009-harness.ts")).reviewerCtx(h, "ac06-cc-review");
    const start1 = h.runtime.riskCaseService.recordDecision(reviewer, {
      caseId: riskCase.id,
      decision: "start_review",
      reasonCodes: ["triage"],
      sourceRefs: [],
      idempotencyKey: "ac06-cc-start-1",
    });
    const start2 = h.runtime.riskCaseService.recordDecision(reviewer, {
      caseId: riskCase.id,
      decision: "start_review",
      reasonCodes: ["triage"],
      sourceRefs: [],
      idempotencyKey: "ac06-cc-start-2",
    });
    const results = await Promise.allSettled([start1, start2]);
    // One wins; the other deterministically fails (OPEN is required
    // for start_review — the winner moved it to UNDER_REVIEW).
    const ok = results.filter((r) => r.status === "fulfilled");
    expect(ok).toHaveLength(1);
    const final = await h.runtime.riskCaseService.getCase(ctx, riskCase.id);
    expect(final.decisions).toHaveLength(2); // open + one start_review
    expect(final.state).toBe("UNDER_REVIEW");
  });

  test("durability: risk records live in the PostgreSQL-authoritative collections", async () => {
    const ctx = actorCtx(h, "ac06-durable");
    const subject = await freshSubject(h);
    await createDefaultRiskPolicy(h, "ac06-durable-policy");
    await createDefaultSignal(h, { subjectPersonId: subject, idempotencyKey: "ac06-du-signal" });
    await h.runtime.riskAssessmentService.recordAssessment(ctx, {
      organizationScopeId: h.organizationScopeId,
      subjectPersonId: subject,
      policyId: "ac06-durable-policy",
      evaluatedAt: EVALUATED_AT,
      idempotencyKey: "ac06-du-assessment",
    });
    for (const collection of [
      "risk_signals",
      "risk_policies",
      "risk_assessments",
      "risk_cases",
      "risk_control_decisions",
    ]) {
      const records = await h.runtime.postgresAuthority.scan(collection);
      expect(records.length).toBeGreaterThan(0);
    }
  });

  test("publication-failure recovery posture: failed validations leave NO partial state", async () => {
    const ctx = actorCtx(h, "ac06-atomic");
    const subject = await freshSubject(h);
    // A control activation with an invalid origin rolls back entirely
    // (no control record, no audit event).
    await expect(
      h.runtime.riskControlService.activateControl(ctx, {
        organizationScopeId: h.organizationScopeId,
        operationClass: "value_maturation",
        action: "HOLD",
        subjectPersonId: subject,
        originAssessmentId: "nonexistent-assessment",
        reasonCodes: ["probe"],
        idempotencyKey: "ac06-atomic-bad",
      }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
    const controls = await h.runtime.riskControlService.listControls(
      ctx,
      h.organizationScopeId,
    );
    expect(
      controls.filter((c) => c.reasonCodes.includes("probe")),
    ).toHaveLength(0);
  });
});
