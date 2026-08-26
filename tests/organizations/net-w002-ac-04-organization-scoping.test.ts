/**
 * NET-W002-AC-04 — Organization scoping.
 *
 * A principal cannot access or mutate another organization's protected
 * participant/membership data unless explicitly authorized by server-side
 * policy.
 *
 * Evidence: multi-organization integration/security test.
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

describe("NET-W002-AC-04 organization scoping", () => {
  test("a principal authorized for org A cannot grant memberships in org B (no allow policy for B)", async () => {
    const ctx = createExecutionContext({ correlationId: "ac04-cross", actor: { id: "bootstrap", kind: "service" } });

    // Setup: two orgs, each with an admin identity.
    const adminA = await runtime.identityService.createIdentity(ctx, {
      displayName: "Admin A",
      subjectReferences: [{ subjectId: "adminA@example.com", providerKind: "internal" }],
    });
    const adminB = await runtime.identityService.createIdentity(ctx, {
      displayName: "Admin B",
      subjectReferences: [{ subjectId: "adminB@example.com", providerKind: "internal" }],
    });
    const orgA = await runtime.organizationService.createOrganization(ctx, {
      name: "Org A",
      creatorId: adminA.id,
    });
    const orgB = await runtime.organizationService.createOrganization(ctx, {
      name: "Org B",
      creatorId: adminB.id,
    });
    const targetInB = await runtime.identityService.createIdentity(ctx, {
      displayName: "Target In B",
      subjectReferences: [{ subjectId: "targetB@example.com", providerKind: "internal" }],
    });

    // Seed an ALLOW policy for adminA to grant memberships ONLY in orgA.
    await runtime.policyService.createPolicy(ctx, {
      subject: adminA.id,
      action: "organization.membership.grant",
      resource: orgA.id,
      effect: "allow",
      createdBy: "bootstrap",
    });

    // adminA attempts to grant a membership in orgB (cross-org). The
    // allow policy is scoped to orgA only; orgB is not covered → deny.
    const res = await fetch(`${BASE}:${runtime.api.port}/api/organizations/${orgB.id}/memberships`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-correlation-id": "ac04-cross",
        "x-auth-subject-id": "adminA@example.com",
        "x-auth-provider-kind": "internal",
        "x-client-claims": JSON.stringify({ role: "ADMIN", scope: "*" }),
      },
      body: JSON.stringify({ personId: targetInB.id }),
    });
    expect(res.status).toBe(403);
    const body = (await res.json()) as { error: string; matchedPolicyId: string | null; message: string };
    expect(body.error).toBe("authorization");
    expect(body.message).toMatch(/deny-by-default|no allow policy/i);
  });

  test("a principal authorized for a specific org CAN grant memberships in that org (scoped allow)", async () => {
    const ctx = createExecutionContext({ correlationId: "ac04-scope", actor: { id: "bootstrap", kind: "service" } });

    const adminA = await runtime.identityService.createIdentity(ctx, {
      displayName: "Admin A",
      subjectReferences: [{ subjectId: "adminA2@example.com", providerKind: "internal" }],
    });
    const orgA = await runtime.organizationService.createOrganization(ctx, {
      name: "Org A",
      creatorId: adminA.id,
    });
    const target = await runtime.identityService.createIdentity(ctx, {
      displayName: "Target",
      subjectReferences: [{ subjectId: "target2@example.com", providerKind: "internal" }],
    });

    // Scoped allow policy: adminA can grant memberships in orgA.
    await runtime.policyService.createPolicy(ctx, {
      subject: adminA.id,
      action: "organization.membership.grant",
      resource: orgA.id,
      effect: "allow",
      createdBy: "bootstrap",
    });

    const res = await fetch(`${BASE}:${runtime.api.port}/api/organizations/${orgA.id}/memberships`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-correlation-id": "ac04-scope",
        "x-auth-subject-id": "adminA2@example.com",
        "x-auth-provider-kind": "internal",
      },
      body: JSON.stringify({ personId: target.id }),
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as { id: string; personId: string; organizationId: string; status: string };
    expect(body.personId).toBe(target.id);
    expect(body.organizationId).toBe(orgA.id);
    expect(body.status).toBe("active");
  });

  test("wildcard allow policy still requires authentication; an unauthenticated principal is denied even with wildcard policy present", async () => {
    const ctx = createExecutionContext({ correlationId: "ac04-wild", actor: { id: "bootstrap", kind: "service" } });
    const adminA = await runtime.identityService.createIdentity(ctx, {
      displayName: "Admin A",
      subjectReferences: [{ subjectId: "adminA3@example.com", providerKind: "internal" }],
    });
    const orgA = await runtime.organizationService.createOrganization(ctx, {
      name: "Org A",
      creatorId: adminA.id,
    });
    // A second identity — the "anyone" who the wildcard policy will allow
    // once they are authenticated (linked to a canonical identity).
    const anyone = await runtime.identityService.createIdentity(ctx, {
      displayName: "Anyone",
      subjectReferences: [{ subjectId: "anyone@example.com", providerKind: "internal" }],
    });

    // A wildcard allow policy (subject "*" → any authenticated principal
    // may create organizations).
    await runtime.policyService.createPolicy(ctx, {
      subject: "*",
      action: "organization.create",
      resource: "*",
      effect: "allow",
      createdBy: "bootstrap",
    });

    // Unauthenticated request (no subject id header) → still denied
    // (deny-by-default for unauthenticated, even with a wildcard policy).
    const res = await fetch(`${BASE}:${runtime.api.port}/api/organizations`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-correlation-id": "ac04-wild-unauth",
        "x-client-claims": JSON.stringify({ role: "ADMIN" }),
      },
      body: JSON.stringify({ name: "Wild Org" }),
    });
    expect(res.status).toBe(403);

    // Authenticated request (subject resolves to the canonical "anyone"
    // identity) → allowed by the wildcard policy.
    const res2 = await fetch(`${BASE}:${runtime.api.port}/api/organizations`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-correlation-id": "ac04-wild-auth",
        "x-auth-subject-id": "anyone@example.com",
        "x-auth-provider-kind": "internal",
      },
      body: JSON.stringify({ name: "Wild Org 2" }),
    });
    expect(res2.status).toBe(201);
  });
});
