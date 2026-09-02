/**
 * NET-W031-AC-07 — TENANCY + AUTHORIZATION (issue #63; work order §3.6).
 *
 *  - the proof routes are guarded DENY-BY-DEFAULT (a runtime without
 *    the reputationProof allow policies rejects every route,
 *    authenticated or not);
 *  - with the harness policies + an authenticated principal, the full
 *    guarded round-trip works (issue → read → verify by id → verify
 *    presented → revoke);
 *  - cross-tenant reads and revocations fail closed and are
 *    INDISTINGUISHABLE from nonexistent ids (no existence oracle) —
 *    at the service surface AND the HTTP surface;
 *  - subject binding is enforced with a precise, distinct error.
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { createRuntime } from "../../src/bootstrap/runtime.ts";
import { createExecutionContext } from "../../src/core/execution-context.ts";
import type { ReputationProof } from "../../src/reputation/port.ts";
import {
  createNetW031Harness,
  seedSubjectSnapshot,
  issueProof,
  verifyStored,
  freshAt,
  actorCtx,
  key,
  type NetW031Harness,
} from "./_net-w031-harness.ts";

const BASE = "http://127.0.0.1";

let harness: NetW031Harness;
let proof: ReputationProof;

beforeEach(async () => {
  harness = await createNetW031Harness();
  const snapshot = await seedSubjectSnapshot(harness, { inputCount: 1 });
  proof = (await issueProof(harness, { snapshotId: snapshot.id })).proof;
});

afterEach(async () => {
  await harness.teardown();
});

describe("NET-W031-AC-07 tenancy + authorization", () => {
  test("proof routes are guarded deny-by-default (no policy → 403, authenticated or not)", async () => {
    // A bare runtime WITHOUT the reputationProof allow policies.
    const bare = createRuntime({
      forceEnv: "test",
      env: { APP_ENV: "test", LOG_LEVEL: "error" },
      port: 0,
    });
    await bare.initialize();
    await bare.api.start();
    try {
      const cases: Array<[string, Record<string, unknown>]> = [
        [
          "/api/reputation/proofs",
          {
            organizationScopeId: "org",
            subjectPersonId: "x",
            idempotencyKey: "k",
          },
        ],
        ["/api/reputation/proofs/presented-verification", { proof: {}, evaluatedAt: "2026-01-01T00:00:00.000Z" }],
        [
          `/api/reputation/proofs/${proof.id}/read`,
          { organizationScopeId: "org" },
        ],
        [
          `/api/reputation/proofs/${proof.id}/verification`,
          { organizationScopeId: "org", evaluatedAt: "2026-01-01T00:00:00.000Z" },
        ],
        [
          `/api/reputation/proofs/${proof.id}/revocation`,
          { organizationScopeId: "org", reason: "r", idempotencyKey: "k" },
        ],
      ];
      for (const [path, body] of cases) {
        // Unauthenticated.
        const unauth = await fetch(`${BASE}:${bare.api.port}${path}`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
        });
        expect(unauth.status).toBe(403);
        // Authenticated but no allow policy → still denied.
        const authed = await fetch(`${BASE}:${bare.api.port}${path}`, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "x-auth-subject-id": "someone@example.com",
            "x-auth-provider-kind": "internal",
          },
          body: JSON.stringify(body),
        });
        expect(authed.status).toBe(403);
      }
    } finally {
      await bare.shutdown();
    }
  });

  test("with the harness policies + authenticated principal, the full guarded round-trip works", async () => {
    const snapshot = await seedSubjectSnapshot(harness, { inputCount: 2 });
    const issueResponse = await fetch(`${BASE}:${harness.runtime.api.port}/api/reputation/proofs`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-auth-subject-id": harness.subjectId,
        "x-auth-provider-kind": "internal",
      },
      body: JSON.stringify({
        organizationScopeId: harness.organizationScopeId,
        subjectPersonId: harness.personId,
        snapshotId: snapshot.id,
        idempotencyKey: key("ac07-api-issue"),
      }),
    });
    expect(issueResponse.status).toBe(201);
    const issued = (await issueResponse.json()) as {
      created: boolean;
      proof: { id: string; dimensions: unknown[] };
    };
    expect(issued.created).toBe(true);
    expect(issued.proof.dimensions).toHaveLength(8);

    const readResponse = await fetch(
      `${BASE}:${harness.runtime.api.port}/api/reputation/proofs/${issued.proof.id}/read`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-auth-subject-id": harness.subjectId,
          "x-auth-provider-kind": "internal",
        },
        body: JSON.stringify({ organizationScopeId: harness.organizationScopeId }),
      },
    );
    expect(readResponse.status).toBe(200);
    const readProof = (await readResponse.json()) as { id: string };
    expect(readProof.id).toBe(issued.proof.id);

    const verifyResponse = await fetch(
      `${BASE}:${harness.runtime.api.port}/api/reputation/proofs/${issued.proof.id}/verification`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-auth-subject-id": harness.subjectId,
          "x-auth-provider-kind": "internal",
        },
        body: JSON.stringify({
          organizationScopeId: harness.organizationScopeId,
          evaluatedAt: freshAt({ issuedAt: new Date().toISOString() }),
        }),
      },
    );
    expect(verifyResponse.status).toBe(200);
    const verdict = (await verifyResponse.json()) as { valid: boolean; reason: string };
    expect(verdict.valid).toBe(true);
    expect(verdict.reason).toBe("verified");

    const presentedResponse = await fetch(
      `${BASE}:${harness.runtime.api.port}/api/reputation/proofs/presented-verification`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-auth-subject-id": harness.subjectId,
          "x-auth-provider-kind": "internal",
        },
        body: JSON.stringify({
          // The PR #64 pair protocol over HTTP: the holder's captured
          // artifact + the CURRENT sealed record (just re-read).
          proof: readProof,
          currentProof: readProof,
          evaluatedAt: freshAt({ issuedAt: new Date().toISOString() }),
        }),
      },
    );
    expect(presentedResponse.status).toBe(200);
    const presentedVerdict = (await presentedResponse.json()) as { valid: boolean };
    expect(presentedVerdict.valid).toBe(true);

    // THE PR #64 REMEDIATION CASE over HTTP: capture the artifact, then
    // revoke the proof — the CAPTURED copy can no longer return
    // `verified` when paired with the current sealed record.
    const captured = JSON.parse(JSON.stringify(readProof)) as Record<string, unknown>;
    const revokeResponse = await fetch(
      `${BASE}:${harness.runtime.api.port}/api/reputation/proofs/${issued.proof.id}/revocation`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-auth-subject-id": harness.subjectId,
          "x-auth-provider-kind": "internal",
        },
        body: JSON.stringify({
          organizationScopeId: harness.organizationScopeId,
          reason: "ac07 api revocation",
          idempotencyKey: key("ac07-api-revoke"),
        }),
      },
    );
    expect(revokeResponse.status).toBe(200);
    const revoked = (await revokeResponse.json()) as { revokedAt: string | null };
    expect(revoked.revokedAt).not.toBeNull();

    // Re-read the CURRENT sealed record; the captured pre-revocation
    // copy paired with it fails closed.
    const currentResponse = await fetch(
      `${BASE}:${harness.runtime.api.port}/api/reputation/proofs/${issued.proof.id}/read`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-auth-subject-id": harness.subjectId,
          "x-auth-provider-kind": "internal",
        },
        body: JSON.stringify({ organizationScopeId: harness.organizationScopeId }),
      },
    );
    expect(currentResponse.status).toBe(200);
    const currentProof = await currentResponse.json();
    const postRevocationResponse = await fetch(
      `${BASE}:${harness.runtime.api.port}/api/reputation/proofs/presented-verification`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-auth-subject-id": harness.subjectId,
          "x-auth-provider-kind": "internal",
        },
        body: JSON.stringify({
          proof: captured,
          currentProof,
          evaluatedAt: freshAt({ issuedAt: new Date().toISOString() }),
        }),
      },
    );
    expect(postRevocationResponse.status).toBe(200);
    const postRevocationVerdict = (await postRevocationResponse.json()) as {
      valid: boolean;
      reason: string;
    };
    expect(postRevocationVerdict.valid).toBe(false);
    expect(postRevocationVerdict.reason).toBe("proof_revoked");
  });

  test("cross-tenant reads are INDISTINGUISHABLE from nonexistent ids at the service surface (no existence oracle)", async () => {
    const ctx = actorCtx(harness, "ac07-oracle");
    let crossTenantError: Error | null = null;
    try {
      await harness.runtime.reputationProofService.getProof(
        ctx,
        harness.otherOrganizationScopeId,
        proof.id,
      );
    } catch (error) {
      crossTenantError = error as Error;
    }
    let missingError: Error | null = null;
    try {
      await harness.runtime.reputationProofService.getProof(
        ctx,
        harness.otherOrganizationScopeId,
        "no-such-proof-id",
      );
    } catch (error) {
      missingError = error as Error;
    }
    // Same class, same code, same generic message shape — the only
    // difference is the caller's own requested id (no existence or
    // ownership detail of the actual record leaks).
    expect(crossTenantError).toBeInstanceOf(Error);
    expect(missingError).toBeInstanceOf(Error);
    expect((crossTenantError as Error).name).toBe((missingError as Error).name);
    expect((crossTenantError as Error).message).toMatch(/^reputation proof not found: /);
    expect((missingError as Error).message).toMatch(/^reputation proof not found: /);
    expect((crossTenantError as Error).message).not.toContain("organization");
    // The in-scope read works.
    const inScope = await harness.runtime.reputationProofService.getProof(
      ctx,
      harness.organizationScopeId,
      proof.id,
    );
    expect(inScope.id).toBe(proof.id);
  });

  test("cross-tenant reads are INDISTINGUISHABLE from nonexistent ids at the HTTP surface (identical error shape)", async () => {
    const headers = {
      "content-type": "application/json",
      "x-auth-subject-id": harness.subjectId,
      "x-auth-provider-kind": "internal",
    };
    const crossTenant = await fetch(
      `${BASE}:${harness.runtime.api.port}/api/reputation/proofs/${proof.id}/read`,
      {
        method: "POST",
        headers,
        body: JSON.stringify({ organizationScopeId: harness.otherOrganizationScopeId }),
      },
    );
    const missing = await fetch(
      `${BASE}:${harness.runtime.api.port}/api/reputation/proofs/no-such-proof-id/read`,
      {
        method: "POST",
        headers,
        body: JSON.stringify({ organizationScopeId: harness.otherOrganizationScopeId }),
      },
    );
    expect(crossTenant.status).toBe(404);
    expect(missing.status).toBe(404);
    const crossBody = (await crossTenant.json()) as { error: string; message: string };
    const missingBody = (await missing.json()) as { error: string; message: string };
    expect(crossBody.error).toBe(missingBody.error);
    expect(crossBody.message).toMatch(/^reputation proof not found: /);
    expect(missingBody.message).toMatch(/^reputation proof not found: /);
  });

  test("cross-tenant revocation fails closed (tenant-scoped mutation)", async () => {
    await expect(
      harness.runtime.reputationProofService.revokeProof(
        actorCtx(harness, "ac07-cross-revoke"),
        {
          organizationScopeId: harness.otherOrganizationScopeId,
          proofId: proof.id,
          reason: "cross-tenant attempt",
          idempotencyKey: key("ac07-cross-revoke"),
        },
      ),
    ).rejects.toThrow(/reputation proof not found/);
    // The proof is untouched and still verifies.
    expect((await verifyStored(harness, proof.id, freshAt(proof))).valid).toBe(true);
  });

  test("a proof issued in the SECOND tenant is invisible to the first (symmetric isolation)", async () => {
    const otherSnapshot = await seedSubjectSnapshot(harness, { inputCount: 1, otherOrg: true });
    const otherProof = await issueProof(harness, { snapshotId: otherSnapshot.id, otherOrg: true });
    // The first tenant cannot read or verify it...
    await expect(
      harness.runtime.reputationProofService.getProof(
        actorCtx(harness, "ac07-sym-read"),
        harness.organizationScopeId,
        otherProof.proof.id,
      ),
    ).rejects.toThrow(/reputation proof not found/);
    // ...and the second tenant CAN.
    const read = await harness.runtime.reputationProofService.getProof(
      otherActorCtxRead(harness),
      harness.otherOrganizationScopeId,
      otherProof.proof.id,
    );
    expect(read.id).toBe(otherProof.proof.id);
  });

  test("subject binding violations carry a PRECISE, distinct error", async () => {
    const snapshot = await seedSubjectSnapshot(harness, { inputCount: 1 });
    await expect(
      issueProof(harness, {
        subjectPersonId: harness.otherPersonId,
        snapshotId: snapshot.id,
      }),
    ).rejects.toThrow(
      new RegExp(`snapshot .* belongs to subject .*, not ${harness.otherPersonId}`),
    );
  });

  test("the presented-verification route requires a well-formed request body (transport-shape failures)", async () => {
    const response = await fetch(
      `${BASE}:${harness.runtime.api.port}/api/reputation/proofs/presented-verification`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-auth-subject-id": harness.subjectId,
          "x-auth-provider-kind": "internal",
        },
        body: JSON.stringify({ evaluatedAt: "2026-01-01T00:00:00.000Z" }),
      },
    );
    expect(response.status).toBe(400);
    // The pair protocol REQUIRES the current sealed record — its
    // absence is a validation failure with a precise message (the PR
    // #64 remediation contract).
    const missingCurrent = await fetch(
      `${BASE}:${harness.runtime.api.port}/api/reputation/proofs/presented-verification`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-auth-subject-id": harness.subjectId,
          "x-auth-provider-kind": "internal",
        },
        body: JSON.stringify({
          proof: JSON.parse(JSON.stringify(proof)) as Record<string, unknown>,
          evaluatedAt: "2026-01-01T00:00:00.000Z",
        }),
      },
    );
    expect(missingCurrent.status).toBe(400);
    const error = (await missingCurrent.json()) as { message: string };
    expect(error.message).toContain("currentProof");
    // A malformed evaluatedAt on the by-id route is likewise a
    // validation failure (never a silent accept).
    const badEvaluated = await fetch(
      `${BASE}:${harness.runtime.api.port}/api/reputation/proofs/${proof.id}/verification`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-auth-subject-id": harness.subjectId,
          "x-auth-provider-kind": "internal",
        },
        body: JSON.stringify({
          organizationScopeId: harness.organizationScopeId,
          evaluatedAt: "not-a-timestamp",
        }),
      },
    );
    expect(badEvaluated.status).toBe(400);
  });
});

function otherActorCtxRead(harness: NetW031Harness) {
  return createExecutionContext({
    correlationId: "ac07-sym-read-other",
    actor: { id: harness.otherPersonId, kind: "person" },
  });
}
