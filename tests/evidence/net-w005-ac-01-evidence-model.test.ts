/**
 * NET-W005-AC-01 — Evidence first-class model and durable persistence.
 *
 * Evidence can be created, retrieved, and listed by subject through
 * authorized application operations; has stable IDs, provenance,
 * confidence, grade, and integrity metadata; is tenant-scoped; persists
 * durably through PostgreSQL (the NET-W003 authority boundary); and
 * SENSITIVE MATERIAL NEVER ENTERS THE DURABLE RECORD (commitment +
 * reference only — architecture-lock §6).
 *
 * Evidence: domain + persistence integration tests, including a
 * raw-payload absence assertion over the authoritative record.
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import type { Evidence } from "../../src/evidence/port.ts";
import {
  createNetW005Harness,
  actorCtx,
  createOpportunitySubject,
  createContributionSubject,
  type NetW005Harness,
} from "./_net-w005-harness.ts";
import { EVIDENCE_COLLECTION } from "../../src/evidence/authority-evidence-repository.ts";

let harness: NetW005Harness;

beforeEach(async () => {
  harness = await createNetW005Harness();
});

afterEach(async () => {
  await harness.teardown();
});

describe("NET-W005-AC-01 evidence first-class model", () => {
  test("evidence is created with stable id, provenance, confidence, grade + lineage and persists durably", async () => {
    const opp = await createOpportunitySubject(harness);
    const subject = await createContributionSubject(harness, opp.id);
    const ctx = actorCtx(harness, "ac01-create");

    const evidence = await harness.runtime.evidenceService.createEvidence(ctx, {
      organizationScopeId: harness.organizationScopeId,
      ownerId: harness.personId,
      subjectReference: { subjectId: subject.id, subjectType: "contribution" },
      provenance: {
        sourceType: "platform",
        sourceId: "platform-instrumentation",
        method: "event-counter",
        collectedAt: "2026-01-01T00:00:00.000Z",
        collectorId: "system",
      },
      confidence: { point: 0.95, lower: 0.9, upper: 0.99, method: "full-census" },
      payload: { events: 1234 },
    });

    // Stable identity + full provenance/confidence/grade metadata.
    expect(evidence.id).toBeTruthy();
    expect(evidence.organizationScopeId).toBe(harness.organizationScopeId);
    expect(evidence.subjectReference.subjectId).toBe(subject.id);
    expect(evidence.provenance.sourceType).toBe("platform");
    expect(evidence.provenance.method).toBe("event-counter");
    expect(evidence.provenance.collectedAt).toBe("2026-01-01T00:00:00.000Z");
    expect(evidence.grade).toBe("MEASURED");
    expect(evidence.confidence.point).toBe(0.95);
    expect(evidence.confidence.lower).toBe(0.9);
    expect(evidence.confidence.upper).toBe(0.99);
    expect(evidence.sensitivity).toBe("standard");
    expect(evidence.payload).toEqual({ events: 1234 });
    expect(evidence.executionId).toBe(ctx.executionId);
    expect(evidence.correlationId).toBe(ctx.correlationId);

    // Durable persistence: re-read through the SAME authority boundary.
    const reread = await harness.runtime.evidenceService.getEvidence(ctx, evidence.id);
    expect(reread.id).toBe(evidence.id);
    expect(reread.grade).toBe("MEASURED");
    expect(reread.confidence).toEqual(evidence.confidence);
    // Lineage is carried onto the durable record.
    const authorityRecord = await harness.runtime.postgresAuthority.get<Evidence>(
      EVIDENCE_COLLECTION,
      evidence.id,
    );
    expect(authorityRecord).not.toBeNull();
    expect(authorityRecord!.value.id).toBe(evidence.id);
  });

  test("evidence records are immutable after creation (no update path)", async () => {
    const opp = await createOpportunitySubject(harness);
    const subject = await createContributionSubject(harness, opp.id);
    const ctx = actorCtx(harness, "ac01-immutable");
    const evidence = await harness.runtime.evidenceService.createEvidence(ctx, {
      organizationScopeId: harness.organizationScopeId,
      ownerId: harness.personId,
      subjectReference: { subjectId: subject.id, subjectType: "contribution" },
      provenance: { sourceType: "platform", method: "counter" },
      confidence: { point: 0.9 },
    });
    // The EvidenceService port exposes NO update/mutate method —
    // corrections are NEW evidence records (append-only semantics).
    const service = harness.runtime.evidenceService as unknown as Record<string, unknown>;
    for (const forbidden of ["updateEvidence", "mutateEvidence", "setGrade", "setConfidence"]) {
      expect(service[forbidden]).toBeUndefined();
    }
    expect(evidence.createdAt).toBeTruthy();
  });

  test("SENSITIVE evidence: the raw material NEVER enters the authoritative record (commitment + reference only)", async () => {
    const opp = await createOpportunitySubject(harness);
    const subject = await createContributionSubject(harness, opp.id);
    const ctx = actorCtx(harness, "ac01-sensitive");
    const sensitiveMaterial = "RAW-SENSITIVE-ACTIVITY-LOG: user-42 viewed ad-7 at 2026-01-01T00:00:00Z";

    const evidence = await harness.runtime.evidenceService.createEvidence(ctx, {
      organizationScopeId: harness.organizationScopeId,
      ownerId: harness.personId,
      subjectReference: { subjectId: subject.id, subjectType: "contribution" },
      provenance: { sourceType: "platform", method: "activity-log" },
      confidence: { point: 0.8 },
      sensitivity: "sensitive",
      sensitivePayload: sensitiveMaterial,
      payloadReference: "objstore://evidence/abc123",
    });

    // The durable record carries the commitment + reference, NOT the payload.
    expect(evidence.sensitivity).toBe("sensitive");
    expect(evidence.payload).toBeNull();
    expect(evidence.commitment).not.toBeNull();
    expect(evidence.commitment!.algorithm).toBe("sha256");
    expect(evidence.commitment!.digest).toMatch(/^[0-9a-f]{64}$/);
    expect(evidence.payloadReference).toBe("objstore://evidence/abc123");

    // THE authoritative-record absence assertion (architecture-lock §6):
    // the raw material appears NOWHERE in the durable record — not in
    // the entity, not in the serialized storage value.
    const authorityRecord = await harness.runtime.postgresAuthority.get<Evidence>(
      EVIDENCE_COLLECTION,
      evidence.id,
    );
    expect(authorityRecord).not.toBeNull();
    const serialized = JSON.stringify(authorityRecord!.value);
    expect(serialized).not.toContain(sensitiveMaterial);
    expect(serialized).not.toContain("RAW-SENSITIVE-ACTIVITY-LOG");
    // The re-read entity also carries no payload.
    const reread = await harness.runtime.evidenceService.getEvidence(ctx, evidence.id);
    expect(reread.payload).toBeNull();
  });

  test("sensitive evidence REJECTS an inline payload (privacy boundary is structural)", async () => {
    const opp = await createOpportunitySubject(harness);
    const subject = await createContributionSubject(harness, opp.id);
    const ctx = actorCtx(harness, "ac01-sensitive-reject");
    await expect(
      harness.runtime.evidenceService.createEvidence(ctx, {
        organizationScopeId: harness.organizationScopeId,
        ownerId: harness.personId,
        subjectReference: { subjectId: subject.id, subjectType: "contribution" },
        provenance: { sourceType: "platform", method: "activity-log" },
        confidence: { point: 0.8 },
        sensitivity: "sensitive",
        payload: { secret: "should-be-rejected" },
      }),
    ).rejects.toThrow(/inline payload is not allowed for sensitive evidence/);
  });

  test("sensitive evidence requires a commitment source (sensitivePayload or pre-computed)", async () => {
    const opp = await createOpportunitySubject(harness);
    const subject = await createContributionSubject(harness, opp.id);
    const ctx = actorCtx(harness, "ac01-sensitive-required");
    await expect(
      harness.runtime.evidenceService.createEvidence(ctx, {
        organizationScopeId: harness.organizationScopeId,
        ownerId: harness.personId,
        subjectReference: { subjectId: subject.id, subjectType: "contribution" },
        provenance: { sourceType: "platform", method: "activity-log" },
        confidence: { point: 0.8 },
        sensitivity: "sensitive",
      }),
    ).rejects.toThrow(/sensitive evidence requires/);
  });

  test("evidence is listed by subject (tenant-scoped query)", async () => {
    const opp = await createOpportunitySubject(harness);
    const subject = await createContributionSubject(harness, opp.id);
    const ctx = actorCtx(harness, "ac01-list");
    const e1 = await harness.runtime.evidenceService.createEvidence(ctx, {
      organizationScopeId: harness.organizationScopeId,
      ownerId: harness.personId,
      subjectReference: { subjectId: subject.id, subjectType: "contribution" },
      provenance: { sourceType: "platform", method: "counter" },
      confidence: { point: 0.9 },
    });
    const e2 = await harness.runtime.evidenceService.createEvidence(ctx, {
      organizationScopeId: harness.organizationScopeId,
      ownerId: harness.personId,
      subjectReference: { subjectId: subject.id, subjectType: "contribution" },
      provenance: { sourceType: "provider", sourceId: "provider-x", method: "report" },
      confidence: { point: 0.7 },
    });
    const listed = await harness.runtime.evidenceService.listEvidenceBySubject(
      ctx,
      subject.id,
    );
    expect(listed.length).toBe(2);
    expect(listed.map((e) => e.id).sort()).toEqual([e1.id, e2.id].sort());
  });

  test("getEvidence throws NotFoundError on unknown id", async () => {
    const ctx = actorCtx(harness, "ac01-notfound");
    await expect(
      harness.runtime.evidenceService.getEvidence(ctx, "urn:unknown:evidence"),
    ).rejects.toThrow(/not found/i);
  });

  test("evidence creation is audited (evidence.created with grade + digest metadata, no raw payload)", async () => {
    const opp = await createOpportunitySubject(harness);
    const subject = await createContributionSubject(harness, opp.id);
    const ctx = actorCtx(harness, "ac01-audit");
    const before = await harness.runtime.auditWriter.count();
    await harness.runtime.evidenceService.createEvidence(ctx, {
      organizationScopeId: harness.organizationScopeId,
      ownerId: harness.personId,
      subjectReference: { subjectId: subject.id, subjectType: "contribution" },
      provenance: { sourceType: "attested", method: "verification" },
      confidence: { point: 0.85 },
      sensitivity: "sensitive",
      sensitivePayload: "private material",
    });
    const after = await harness.runtime.auditWriter.count();
    expect(after - before).toBe(1);
    const events = await harness.runtime.auditWriter.query({ eventType: "evidence.created" });
    const ev = events[events.length - 1]!;
    expect(ev.resourceType).toBe("evidence");
    expect(ev.metadata?.grade).toBe("ATTESTED");
    expect(ev.metadata?.sensitivity).toBe("sensitive");
    // The audit record carries the commitment DIGEST (audit-safe) but
    // NEVER the committed material.
    expect(typeof ev.metadata?.commitmentDigest).toBe("string");
    expect(JSON.stringify(ev)).not.toContain("private material");
  });

  test("evidence creation validates required fields with stable codes", async () => {
    const ctx = actorCtx(harness, "ac01-validation");
    const base = {
      organizationScopeId: harness.organizationScopeId,
      ownerId: harness.personId,
      subjectReference: { subjectId: "sub", subjectType: "contribution" },
      provenance: { sourceType: "platform" as const, method: "counter" },
      confidence: { point: 0.9 },
    };
    await expect(
      harness.runtime.evidenceService.createEvidence(ctx, {
        ...base,
        organizationScopeId: "",
      }),
    ).rejects.toThrow(/organizationScopeId is required/);
    await expect(
      harness.runtime.evidenceService.createEvidence(ctx, {
        ...base,
        provenance: { sourceType: "telepathy", method: "counter" } as never,
      }),
    ).rejects.toThrow(/sourceType/);
    await expect(
      harness.runtime.evidenceService.createEvidence(ctx, {
        ...base,
        provenance: { sourceType: "platform", method: "" },
      }),
    ).rejects.toThrow(/method is required/);
  });

  test("the API creates + reads evidence (sensitive view exposes commitment only)", async () => {
    const opp = await createOpportunitySubject(harness);
    const subject = await createContributionSubject(harness, opp.id);
    const res = await fetch(`http://127.0.0.1:${harness.runtime.api.port}/api/evidence`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-correlation-id": "ac01-api",
        "x-auth-subject-id": harness.subjectId,
        "x-auth-provider-kind": "internal",
      },
      body: JSON.stringify({
        organizationScopeId: harness.organizationScopeId,
        subjectReference: { subjectId: subject.id, subjectType: "contribution" },
        provenance: { sourceType: "platform", method: "counter" },
        confidence: { point: 0.9 },
        sensitivity: "sensitive",
        sensitivePayload: "api-sensitive-material",
      }),
    });
    expect(res.status).toBe(201);
    const view = (await res.json()) as Record<string, unknown>;
    expect(view.grade).toBe("MEASURED");
    expect(view.sensitivity).toBe("sensitive");
    expect(view.payload).toBeNull();
    expect(view.commitment).not.toBeNull();
    // The API response NEVER contains the raw material.
    expect(JSON.stringify(view)).not.toContain("api-sensitive-material");

    // Public read returns the same commitment-only view.
    const getRes = await fetch(
      `http://127.0.0.1:${harness.runtime.api.port}/api/evidence/${view.id}`,
      { method: "GET" },
    );
    expect(getRes.status).toBe(200);
    const getView = (await getRes.json()) as Record<string, unknown>;
    expect(getView.payload).toBeNull();
    expect(JSON.stringify(getView)).not.toContain("api-sensitive-material");
  });
});
