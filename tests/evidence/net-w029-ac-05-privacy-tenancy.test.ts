/**
 * NET-W029 AC-05 — privacy + tenancy + authorization (issue #58; work
 * order §3.6, §6).
 *
 * Creation/verification surfaces follow the established guard-action
 * pattern (server-resolved actor, policy-checked, 403 on deny).
 * Attestations are tenant-scoped: cross-tenant and unauthorized access
 * fails closed WITHOUT existence oracles (cross-tenant reads are
 * indistinguishable from nonexistent ones at every surface).
 */

import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import {
  createNetW029Harness,
  createEvidenceRecord,
  createSignedAttestation,
  type NetW029Harness,
} from "./_net-w029-harness.ts";

let harness: NetW029Harness;
let attestationId: string;

function apiUrl(path: string): string {
  return `http://127.0.0.1:${harness.runtime.api.port}${path}`;
}

async function postJson(
  path: string,
  body: unknown,
  subjectId: string | null,
): Promise<{ status: number; body: Record<string, unknown> }> {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (subjectId !== null) {
    headers["x-auth-subject-id"] = subjectId;
  }
  const res = await fetch(apiUrl(path), {
    method: "POST",
    headers,
    body: JSON.stringify(body ?? {}),
  });
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

beforeAll(async () => {
  harness = await createNetW029Harness();
  const evidence = await createEvidenceRecord(harness);
  const result = await createSignedAttestation(harness, [
    { family: "evidence", recordId: evidence.id },
  ]);
  attestationId = result.attestation.id;
});

afterAll(async () => {
  await harness.teardown();
});

describe("NET-W029-AC-05 privacy + tenancy + authorization (HTTP surfaces)", () => {
  test("creation is GUARDED: authenticated + allowed actor creates via POST /api/evidence/signed-attestations (201)", async () => {
    const evidence = await createEvidenceRecord(harness);
    const res = await postJson(
      "/api/evidence/signed-attestations",
      {
        organizationScopeId: harness.organizationScopeId,
        verifierId: harness.personId,
        statement: "http-created attestation",
        coverage: [{ family: "evidence", recordId: evidence.id }],
        idempotencyKey: `ac05-http-${crypto.randomUUID()}`,
      },
      harness.subjectId,
    );
    expect(res.status).toBe(201);
    expect(res.body.id).toBeTruthy();
    expect(res.body.algorithm).toBe("hmac-sha256/v1");
    expect(res.body.keyReference).toBe("attestation-signing/dev-insecure/v1");
    expect(Array.isArray(res.body.coverage)).toBe(true);
  });

  test("UNAUTHENTICATED creation is denied (403) — no record, no oracle leakage", async () => {
    const evidence = await createEvidenceRecord(harness);
    const auditBefore = (
      await harness.runtime.auditWriter.query({ eventType: "signed_attestation.created" })
    ).length;
    const res = await postJson(
      "/api/evidence/signed-attestations",
      {
        organizationScopeId: harness.organizationScopeId,
        verifierId: harness.personId,
        statement: "unauth attempt",
        coverage: [{ family: "evidence", recordId: evidence.id }],
        idempotencyKey: `ac05-unauth-${crypto.randomUUID()}`,
      },
      null,
    );
    expect(res.status).toBe(403);
    expect(res.body.error).toBe("authorization");
    const auditAfter = (
      await harness.runtime.auditWriter.query({ eventType: "signed_attestation.created" })
    ).length;
    expect(auditAfter).toBe(auditBefore);
  });

  test("tenant-scoped READ: in-scope 200; cross-tenant 404 IDENTICAL to a nonexistent id (no existence oracle)", async () => {
    // In scope.
    const inScope = await postJson(
      `/api/evidence/signed-attestations/${attestationId}/read`,
      { organizationScopeId: harness.organizationScopeId },
      harness.subjectId,
    );
    expect(inScope.status).toBe(200);
    expect(inScope.body.id).toBe(attestationId);

    // Cross-tenant (the second person, requesting THEIR scope for a
    // record that belongs to the first org).
    const crossTenant = await postJson(
      `/api/evidence/signed-attestations/${attestationId}/read`,
      { organizationScopeId: harness.otherOrganizationScopeId },
      harness.otherSubjectId,
    );
    expect(crossTenant.status).toBe(404);

    // A genuinely nonexistent id, same route + scope.
    const nonexistent = await postJson(
      `/api/evidence/signed-attestations/00000000-0000-0000-0000-000000000000/read`,
      { organizationScopeId: harness.otherOrganizationScopeId },
      harness.otherSubjectId,
    );
    expect(nonexistent.status).toBe(404);
    // INDISTINGUISHABLE: same error code + the same message shape (the
    // message echoes only the CALLER-SUPPLIED id — never any
    // existence/ownership detail of the actual record).
    expect(crossTenant.body.error).toBe(nonexistent.body.error);
    expect(String(crossTenant.body.message)).toMatch(/^signed attestation not found: /);
    expect(String(nonexistent.body.message)).toMatch(/^signed attestation not found: /);
  });

  test("tenant-scoped VERIFICATION: in-scope 200 verdict; cross-tenant 404 indistinguishable from nonexistent", async () => {
    const inScope = await postJson(
      `/api/evidence/signed-attestations/${attestationId}/verification`,
      { organizationScopeId: harness.organizationScopeId },
      harness.subjectId,
    );
    expect(inScope.status).toBe(200);
    expect(inScope.body.valid).toBe(true);
    expect(inScope.body.reason).toBe("verified");
    expect(Array.isArray(inScope.body.checks)).toBe(true);

    const crossTenant = await postJson(
      `/api/evidence/signed-attestations/${attestationId}/verification`,
      { organizationScopeId: harness.otherOrganizationScopeId },
      harness.otherSubjectId,
    );
    expect(crossTenant.status).toBe(404);
    const nonexistent = await postJson(
      `/api/evidence/signed-attestations/00000000-0000-0000-0000-000000000000/verification`,
      { organizationScopeId: harness.otherOrganizationScopeId },
      harness.otherSubjectId,
    );
    expect(nonexistent.status).toBe(404);
    expect(crossTenant.body.error).toBe(nonexistent.body.error);
    expect(String(crossTenant.body.message)).toMatch(/^signed attestation not found: /);
    expect(String(nonexistent.body.message)).toMatch(/^signed attestation not found: /);
  });

  test("an in-scope actor requesting the WRONG org scope is also not-found (scope mismatch ≡ missing)", async () => {
    const res = await postJson(
      `/api/evidence/signed-attestations/${attestationId}/read`,
      { organizationScopeId: harness.otherOrganizationScopeId },
      harness.subjectId,
    );
    expect(res.status).toBe(404);
  });

  test("revocation via HTTP is guarded + audited; the revoked attestation NEVER verifies again", async () => {
    const evidence = await createEvidenceRecord(harness);
    const result = await createSignedAttestation(harness, [
      { family: "evidence", recordId: evidence.id },
    ]);
    const revokeRes = await postJson(
      `/api/evidence/signed-attestations/${result.attestation.id}/revocation`,
      {
        organizationScopeId: harness.organizationScopeId,
        reason: "ac05 revocation",
        idempotencyKey: `ac05-revoke-${crypto.randomUUID()}`,
      },
      harness.subjectId,
    );
    expect(revokeRes.status).toBe(200);
    expect(revokeRes.body.revokedAt).toBeTruthy();
    expect(revokeRes.body.revocationReason).toBe("ac05 revocation");

    const verifyRes = await postJson(
      `/api/evidence/signed-attestations/${result.attestation.id}/verification`,
      { organizationScopeId: harness.organizationScopeId },
      harness.subjectId,
    );
    expect(verifyRes.status).toBe(200);
    expect(verifyRes.body.valid).toBe(false);
    expect(verifyRes.body.reason).toBe("attestation_revoked");

    // Cross-tenant revocation fails closed identically.
    const crossRevoke = await postJson(
      `/api/evidence/signed-attestations/${result.attestation.id}/revocation`,
      {
        organizationScopeId: harness.otherOrganizationScopeId,
        reason: "should not work",
        idempotencyKey: `ac05-cross-${crypto.randomUUID()}`,
      },
      harness.otherSubjectId,
    );
    expect(crossRevoke.status).toBe(404);
  });

  test("invalid request bodies fail closed with 400 (validation before any mutation)", async () => {
    const res = await postJson(
      "/api/evidence/signed-attestations",
      { organizationScopeId: harness.organizationScopeId, statement: "no coverage" },
      harness.subjectId,
    );
    expect(res.status).toBe(400);
  });
});
