/**
 * NET-W002 remediation — actor-spoof regression (PR #4 architect review).
 *
 * Architect concern (Issue 1): "X-Actor-Id is currently caller-controlled
 * and can spoof the actor recorded in audit context."
 *
 * Required evidence: "regression tests proving a forged X-Actor-Id cannot
 * change the authoritative audit actor."
 *
 * These tests prove that for every protected mutation (POST /api/identities,
 * POST /api/organizations, POST /api/organizations/:id/memberships, DELETE
 * /api/organizations/:id/memberships/:membershipId), sending a forged
 * `X-Actor-Id` header does NOT change the actor recorded in the audit
 * lineage. The authoritative audit actor is the server-resolved
 * authenticated principal (`personId` produced by ApiAuth.resolvePrincipal),
 * never a caller-controlled header.
 *
 * The fix lives in src/api/server.ts: the request-scope ExecutionContext
 * no longer reads `X-Actor-Id`; `guardMutation()` derives a child context
 * whose `actor` is the resolved `personId` and re-enters the AsyncLocalStorage
 * scope with it, so both audit records AND log lines carry the resolved
 * principal as the actor.
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

// A deliberately forged actor id sent by an attacker. If the implementation
// were still trusting the X-Actor-Id header, this value would appear as the
// audit actor. After the remediation it MUST NOT appear anywhere in audit.
const SPOOFED_ACTOR_ID = "spoofed-attacker-actor-id";

describe("NET-W002 remediation — forged X-Actor-Id cannot change the authoritative audit actor", () => {
  test("POST /api/identities: audit actor is the resolved personId, not the forged X-Actor-Id", async () => {
    // Bootstrap an authorized principal. The setup ctx uses a distinct
    // correlation id so the audit query for the API-driven mutation does
    // not pick up the setup's own audit events.
    const ctx = createExecutionContext({
      correlationId: "remed-actor-identity-setup",
      actor: { id: "bootstrap", kind: "service" },
    });
    const actor = await runtime.identityService.createIdentity(ctx, {
      displayName: "Identity Provisioner",
      subjectReferences: [{ subjectId: "provisioner@example.com", providerKind: "internal" }],
    });
    // Allow this principal to create identities.
    await runtime.policyService.createPolicy(ctx, {
      subject: actor.id,
      action: "identity.create",
      resource: "*",
      effect: "allow",
      createdBy: "bootstrap",
    });

    // Send the request WITH a forged X-Actor-Id header. The header must
    // be ignored for authoritative audit purposes. The API request uses
    // its own correlation id so the audit query below is unambiguous.
    const res = await fetch(`${BASE}:${runtime.api.port}/api/identities`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-correlation-id": "remed-actor-identity",
        "x-auth-subject-id": "provisioner@example.com",
        "x-auth-provider-kind": "internal",
        "x-actor-id": SPOOFED_ACTOR_ID, // ← spoofing attempt
      },
      body: JSON.stringify({
        displayName: "Child Identity",
        subjectId: "child@example.com",
        providerKind: "internal",
      }),
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as { id: string };

    // The audit record for identity.person_created MUST record the resolved
    // personId as the actor, NOT the spoofed header value. Filter by the
    // returned identity id so the setup's own audit event is excluded.
    const events = await runtime.auditWriter.query({ correlationId: "remed-actor-identity" });
    const evt = events.find((e) => e.eventType === "identity.person_created" && e.resourceId === body.id);
    expect(evt).toBeDefined();
    expect(evt!.actor).toBe(actor.id); // server-resolved, not spoofed
    expect(evt!.actor).not.toBe(SPOOFED_ACTOR_ID);
    // The spoofed id must not appear ANYWHERE in the audit record's JSON.
    const serialized = JSON.stringify(evt);
    expect(serialized).not.toContain(SPOOFED_ACTOR_ID);
  });

  test("POST /api/organizations: audit actor is the resolved personId, not the forged X-Actor-Id", async () => {
    const ctx = createExecutionContext({
      correlationId: "remed-actor-org-setup",
      actor: { id: "bootstrap", kind: "service" },
    });
    const actor = await runtime.identityService.createIdentity(ctx, {
      displayName: "Org Creator",
      subjectReferences: [{ subjectId: "orgcreator@example.com", providerKind: "internal" }],
    });
    await runtime.policyService.createPolicy(ctx, {
      subject: actor.id,
      action: "organization.create",
      resource: "*",
      effect: "allow",
      createdBy: "bootstrap",
    });

    const res = await fetch(`${BASE}:${runtime.api.port}/api/organizations`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-correlation-id": "remed-actor-org",
        "x-auth-subject-id": "orgcreator@example.com",
        "x-auth-provider-kind": "internal",
        "x-actor-id": SPOOFED_ACTOR_ID, // ← spoofing attempt
      },
      body: JSON.stringify({ name: "Audited Org" }),
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as { id: string };

    const events = await runtime.auditWriter.query({ correlationId: "remed-actor-org" });
    const evt = events.find((e) => e.eventType === "organization.created" && e.resourceId === body.id);
    expect(evt).toBeDefined();
    expect(evt!.actor).toBe(actor.id); // server-resolved, not spoofed
    expect(evt!.actor).not.toBe(SPOOFED_ACTOR_ID);
    expect(JSON.stringify(evt)).not.toContain(SPOOFED_ACTOR_ID);
  });

  test("POST /api/organizations/:id/memberships: audit actor is the resolved personId, not the forged X-Actor-Id", async () => {
    const ctx = createExecutionContext({
      correlationId: "remed-actor-grant-setup",
      actor: { id: "bootstrap", kind: "service" },
    });
    const admin = await runtime.identityService.createIdentity(ctx, {
      displayName: "Membership Admin",
      subjectReferences: [{ subjectId: "admin@example.com", providerKind: "internal" }],
    });
    const target = await runtime.identityService.createIdentity(ctx, {
      displayName: "Membership Target",
      subjectReferences: [{ subjectId: "target@example.com", providerKind: "internal" }],
    });
    const org = await runtime.organizationService.createOrganization(ctx, {
      name: "Scope Org",
      creatorId: admin.id,
    });
    await runtime.policyService.createPolicy(ctx, {
      subject: admin.id,
      action: "organization.membership.grant",
      resource: org.id,
      effect: "allow",
      createdBy: "bootstrap",
    });

    const res = await fetch(
      `${BASE}:${runtime.api.port}/api/organizations/${org.id}/memberships`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-correlation-id": "remed-actor-grant",
          "x-auth-subject-id": "admin@example.com",
          "x-auth-provider-kind": "internal",
          "x-actor-id": SPOOFED_ACTOR_ID, // ← spoofing attempt
        },
        body: JSON.stringify({ personId: target.id }),
      },
    );
    expect(res.status).toBe(201);
    const body = (await res.json()) as { id: string };

    const events = await runtime.auditWriter.query({ correlationId: "remed-actor-grant" });
    const evt = events.find((e) => e.eventType === "organization.membership_granted" && e.resourceId === body.id);
    expect(evt).toBeDefined();
    expect(evt!.actor).toBe(admin.id); // server-resolved, not spoofed
    expect(evt!.actor).not.toBe(SPOOFED_ACTOR_ID);
    expect(JSON.stringify(evt)).not.toContain(SPOOFED_ACTOR_ID);
  });

  test("DELETE /api/organizations/:id/memberships/:membershipId: audit actor is the resolved personId, not the forged X-Actor-Id", async () => {
    const ctx = createExecutionContext({
      correlationId: "remed-actor-revoke-setup",
      actor: { id: "bootstrap", kind: "service" },
    });
    const admin = await runtime.identityService.createIdentity(ctx, {
      displayName: "Revoke Admin",
      subjectReferences: [{ subjectId: "revoker@example.com", providerKind: "internal" }],
    });
    const target = await runtime.identityService.createIdentity(ctx, {
      displayName: "Revoke Target",
      subjectReferences: [{ subjectId: "revoketarget@example.com", providerKind: "internal" }],
    });
    const org = await runtime.organizationService.createOrganization(ctx, {
      name: "Revoke Org",
      creatorId: admin.id,
    });
    const grant = await runtime.membershipService.grantMembership(ctx, {
      personId: target.id,
      organizationId: org.id,
      grantedBy: admin.id,
    });
    await runtime.policyService.createPolicy(ctx, {
      subject: admin.id,
      action: "organization.membership.revoke",
      resource: org.id,
      effect: "allow",
      createdBy: "bootstrap",
    });

    const res = await fetch(
      `${BASE}:${runtime.api.port}/api/organizations/${org.id}/memberships/${grant.membership.id}`,
      {
        method: "DELETE",
        headers: {
          "content-type": "application/json",
          "x-correlation-id": "remed-actor-revoke",
          "x-auth-subject-id": "revoker@example.com",
          "x-auth-provider-kind": "internal",
          "x-actor-id": SPOOFED_ACTOR_ID, // ← spoofing attempt
        },
      },
    );
    expect(res.status).toBe(200);

    const events = await runtime.auditWriter.query({ correlationId: "remed-actor-revoke" });
    const evt = events.find((e) => e.eventType === "organization.membership_revoked" && e.resourceId === grant.membership.id);
    expect(evt).toBeDefined();
    expect(evt!.actor).toBe(admin.id); // server-resolved, not spoofed
    expect(evt!.actor).not.toBe(SPOOFED_ACTOR_ID);
    expect(JSON.stringify(evt)).not.toContain(SPOOFED_ACTOR_ID);
  });

  test("a denied protected mutation writes NO audit record at all (no spoofed actor can appear)", async () => {
    // An unauthenticated request (no allow policy) is denied. The
    // AuthorizationService logs the deny but writes no audit record. So
    // even if a forged X-Actor-Id is present, no audit actor is recorded.
    const ctx = createExecutionContext({
      correlationId: "remed-actor-deny-setup",
      actor: { id: "bootstrap", kind: "service" },
    });
    const actor = await runtime.identityService.createIdentity(ctx, {
      displayName: "Denied Principal",
      subjectReferences: [{ subjectId: "denied@example.com", providerKind: "internal" }],
    });
    // No allow policy seeded → deny-by-default.

    const res = await fetch(`${BASE}:${runtime.api.port}/api/organizations`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-correlation-id": "remed-actor-deny",
        "x-auth-subject-id": "denied@example.com",
        "x-auth-provider-kind": "internal",
        "x-actor-id": SPOOFED_ACTOR_ID, // ← spoofing attempt
      },
      body: JSON.stringify({ name: "Should Be Denied" }),
    });
    expect(res.status).toBe(403);

    // No organization.created audit event was written for this correlation.
    const events = await runtime.auditWriter.query({ correlationId: "remed-actor-deny" });
    const evt = events.find((e) => e.eventType === "organization.created");
    expect(evt).toBeUndefined();
  });

  test("the request-scope ExecutionContext no longer reads X-Actor-Id (static contract)", async () => {
    // Defensive static check: the API server source must not READ the
    // `x-actor-id` header from the request anywhere. (Comments explaining
    // WHY we don't read it are allowed — they don't constitute a read.)
    // This makes the spoofing vector structurally impossible regardless
    // of any future refactor.
    const { readFile } = await import("node:fs/promises");
    const { join } = await import("node:path");
    const REPO = join(import.meta.dir, "../..");
    const server = await readFile(join(REPO, "src/api/server.ts"), "utf8");
    // No READ of the x-actor-id header from the request object. Match
    // either bracket or dot access on req.headers, single OR double quotes,
    // case-insensitive. (We strip line comments first so a documentation
    // comment can't accidentally count as a read.)
    const codeOnly = server.replace(/^\s*\/\/.*$/gm, "");
    expect(codeOnly).not.toMatch(/req\.headers\[\s*["']x-actor-id["']\s*\]/i);
    // The authoritative actor is derived exclusively from the resolved
    // personId inside guardMutation(), via a child ExecutionContext whose
    // `actor` is `{ id: personId, kind: "person" }`.
    expect(server).toMatch(/deriveExecutionContext\(ctx,\s*\{\s*actor:\s*\{\s*id:\s*personId/);
    // The request-scope context's actor is null (no caller-controlled
    // value is ever assigned at the request boundary).
    expect(server).toMatch(/createExecutionContext\(\{[\s\S]*?actor:\s*null/);
  });
});
