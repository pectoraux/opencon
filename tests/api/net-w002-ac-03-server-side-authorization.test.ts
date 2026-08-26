/**
 * NET-W002-AC-03 — Server-side authorization.
 *
 * Protected mutations reject unauthenticated and unauthorized principals
 * regardless of client-supplied role/scope claims.
 *
 * Evidence: API/security integration tests with forged client role/scope
 * inputs.
 *
 * The API server's guardMutation() resolves the canonical identity
 * server-side (via PrincipalResolver) and authorizes via the
 * AuthorizationService (deny-by-default). Client-asserted role/scope
 * claims (X-Client-Claims header) are NEVER trusted — they are carried
 * only so forged claims can be logged/audited when rejected (§4.5, API-AC-02).
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { createRuntime, type Runtime } from "../../src/bootstrap/runtime.ts";
import { createExecutionContext } from "../../src/core/execution-context.ts";

let runtime: Runtime;

beforeEach(async () => {
  runtime = createRuntime({
    forceEnv: "test",
    env: { APP_ENV: "test", LOG_LEVEL: "warn" },
    port: 0,
  });
  await runtime.initialize();
  await runtime.api.start();
});

afterEach(async () => {
  await runtime.shutdown();
});

const BASE = "http://127.0.0.1";

describe("NET-W002-AC-03 server-side authorization", () => {
  test("unauthenticated request to a protected mutation is rejected (403)", async () => {
    // No X-Auth-Subject-Id header → unauthenticated → deny.
    const res = await fetch(`${BASE}:${runtime.api.port}/api/organizations`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-correlation-id": "ac03-unauth",
      },
      body: JSON.stringify({ name: "Should Fail" }),
    });
    expect(res.status).toBe(403);
    const body = (await res.json()) as { error: string; reason?: string; matchedPolicyId: string | null };
    expect(body.error).toBe("authorization");
    expect(body.matchedPolicyId).toBe(null);
  });

  test("authenticated principal with forged ADMIN client-claims is rejected when no allow policy matches (claims not trusted)", async () => {
    // Seed an identity + participant (but NO allow policy for org creation).
    const ctx = createExecutionContext({ correlationId: "ac03-forge", actor: { id: "bootstrap", kind: "service" } });
    const person = await runtime.identityService.createIdentity(ctx, {
      displayName: "Attacker",
      subjectReferences: [{ subjectId: "attacker@example.com", providerKind: "internal" }],
    });

    // Forged client claims: the client asserts role ADMIN and scope "*".
    // The AuthorizationService MUST ignore these and rely only on server-
    // resolved state + policies. No allow policy exists for this principal,
    // so the request MUST be denied (deny-by-default).
    const res = await fetch(`${BASE}:${runtime.api.port}/api/organizations`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-correlation-id": "ac03-forge",
        "x-auth-subject-id": "attacker@example.com",
        "x-auth-provider-kind": "internal",
        "x-client-claims": JSON.stringify({ role: "ADMIN", scope: "*", isAdmin: true }),
      },
      body: JSON.stringify({ name: "Forged Org" }),
    });
    expect(res.status).toBe(403);
    const body = (await res.json()) as { error: string; matchedPolicyId: string | null; message: string };
    expect(body.error).toBe("authorization");
    expect(body.matchedPolicyId).toBe(null);
    expect(body.message).toMatch(/deny-by-default|no allow policy/i);
  });

  test("authenticated principal with an explicit DENY policy is rejected even with forged allow claims", async () => {
    const ctx = createExecutionContext({ correlationId: "ac03-deny", actor: { id: "bootstrap", kind: "service" } });
    const person = await runtime.identityService.createIdentity(ctx, {
      displayName: "Denied User",
      subjectReferences: [{ subjectId: "denied@example.com", providerKind: "internal" }],
    });
    // Seed an explicit DENY policy for this principal.
    await runtime.policyService.createPolicy(ctx, {
      subject: person.id,
      action: "organization.create",
      resource: "*",
      effect: "deny",
      createdBy: "bootstrap",
    });

    const res = await fetch(`${BASE}:${runtime.api.port}/api/organizations`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-correlation-id": "ac03-deny",
        "x-auth-subject-id": "denied@example.com",
        "x-auth-provider-kind": "internal",
        "x-client-claims": JSON.stringify({ role: "ADMIN", allowAll: true }),
      },
      body: JSON.stringify({ name: "Should Be Denied" }),
    });
    expect(res.status).toBe(403);
    const body = (await res.json()) as { error: string; matchedPolicyId: string | null; message: string };
    expect(body.error).toBe("authorization");
    expect(body.matchedPolicyId).not.toBe(null); // The deny policy matched.
    expect(body.message).toMatch(/deny policy/i);
  });

  test("authenticated principal WITH a matching allow policy succeeds (mutation executes)", async () => {
    const ctx = createExecutionContext({ correlationId: "ac03-allow", actor: { id: "bootstrap", kind: "service" } });
    const person = await runtime.identityService.createIdentity(ctx, {
      displayName: "Authorized User",
      subjectReferences: [{ subjectId: "allowed@example.com", providerKind: "internal" }],
    });
    // Seed an ALLOW policy for this principal.
    await runtime.policyService.createPolicy(ctx, {
      subject: person.id,
      action: "organization.create",
      resource: "*",
      effect: "allow",
      createdBy: "bootstrap",
    });

    const res = await fetch(`${BASE}:${runtime.api.port}/api/organizations`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-correlation-id": "ac03-allow",
        "x-auth-subject-id": "allowed@example.com",
        "x-auth-provider-kind": "internal",
      },
      body: JSON.stringify({ name: "Authorized Org" }),
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as { id: string; name: string; createdBy: string };
    expect(body.name).toBe("Authorized Org");
    expect(body.createdBy).toBe(person.id);
  });

  test("forged allow claims do NOT elevate a principal whose server-resolved state has no allow policy", async () => {
    // Even when the client asserts a role that would normally grant access,
    // the AuthorizationService re-resolves effective authorization from
    // server state + policies. Forged claims are ignored.
    const ctx = createExecutionContext({ correlationId: "ac03-elevate", actor: { id: "bootstrap", kind: "service" } });
    const person = await runtime.identityService.createIdentity(ctx, {
      displayName: "No Policy User",
      subjectReferences: [{ subjectId: "nopolicy@example.com", providerKind: "internal" }],
    });
    // No allow policy seeded for this principal.

    const res = await fetch(`${BASE}:${runtime.api.port}/api/organizations`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-correlation-id": "ac03-elevate",
        "x-auth-subject-id": "nopolicy@example.com",
        "x-auth-provider-kind": "internal",
        "x-client-claims": JSON.stringify({
          role: "ADMIN",
          scopes: ["org:create", "*"],
          elevated: true,
        }),
      },
      body: JSON.stringify({ name: "Elevation Attempt" }),
    });
    expect(res.status).toBe(403);
  });

  test("correlation + execution IDs propagate on a denied request", async () => {
    const res = await fetch(`${BASE}:${runtime.api.port}/api/organizations`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-correlation-id": "ac03-corr-prop",
      },
      body: JSON.stringify({ name: "Corr" }),
    });
    expect(res.status).toBe(403);
    // Correlation id is echoed back for traceability.
    expect(res.headers.get("x-correlation-id")).toBe("ac03-corr-prop");
    expect(res.headers.get("x-execution-id")).toBeTruthy();
  });
});
