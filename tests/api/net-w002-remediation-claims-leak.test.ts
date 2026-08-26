/**
 * NET-W002 remediation — client-claims leak regression (PR #4 architect review).
 *
 * Architect concern (Issue 2): "Raw `X-Client-Claims` can flow into
 * authorization logs and potentially expose credential material."
 *
 * Required evidence: "regression tests proving credential-shaped/client-claim
 * values do not appear in captured logs."
 *
 * These tests prove that:
 *  1. The AuthorizationService NEVER emits raw `clientClaims` into logs. It
 *     emits only a safe fingerprint (`clientClaimsPresent`, `clientClaimKeys`
 *     with credential-shaped keys redacted to `<redacted>`, `clientClaimsCount`).
 *  2. Credential values sent in the `X-Client-Claims` header never appear
 *     in any captured log line — neither on the deny path (where claims are
 *     most likely to be logged) nor on the allow path.
 *  3. Credential-shaped claim KEY NAMES are themselves redacted (the
 *     structural indicator that a credential was sent is suppressed).
 *  4. The `clientClaims` field name does not appear in any authorization
 *     log entry (the raw object is gone, replaced by the fingerprint).
 *
 * The fix lives in src/participants/authorization-service.ts:
 * `safeClaimsFingerprint()` replaces `request.clientClaims` in all three
 * deny-path log calls (denied_unauthenticated, denied_policy, denied_default).
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { createRuntime, type Runtime } from "../../src/bootstrap/runtime.ts";
import { createExecutionContext } from "../../src/core/execution-context.ts";
import { safeClaimsFingerprint } from "../../src/participants/authorization-service.ts";

let runtime: Runtime;

beforeEach(async () => {
  runtime = createRuntime({
    forceEnv: "test",
    env: { APP_ENV: "test", LOG_LEVEL: "debug" }, // debug so allowed_policy also emits
    port: 0,
  });
  await runtime.initialize();
  await runtime.api.start();
});

afterEach(async () => {
  await runtime.shutdown();
});

const BASE = "http://127.0.0.1";

// Deliberately credential-shaped claim values an attacker might smuggle
// through the X-Client-Claims header. After the remediation these MUST NOT
// appear in any captured log line.
const SECRET_TOKEN = "SECRET-TOKEN-VALUE-DO-NOT-LEAK";
const SECRET_PASSWORD = "hunter2-password-do-not-leak";
const SECRET_API_KEY = "ak-1234567890-do-not-leak";

describe("NET-W002 remediation — safeClaimsFingerprint (unit contract)", () => {
  test("absent claims → clientClaimsPresent=false, empty keys, count 0", () => {
    expect(safeClaimsFingerprint(undefined)).toEqual({
      clientClaimsPresent: false,
      clientClaimKeys: [],
      clientClaimsCount: 0,
    });
    expect(safeClaimsFingerprint(null as unknown as undefined)).toEqual({
      clientClaimsPresent: false,
      clientClaimKeys: [],
      clientClaimsCount: 0,
    });
  });

  test("non-credential claims → keys listed verbatim, count accurate, NO values", () => {
    const fp = safeClaimsFingerprint({ role: "ADMIN", scope: "org:create", isAdmin: true });
    expect(fp.clientClaimsPresent).toBe(true);
    expect(fp.clientClaimsCount).toBe(3);
    expect(fp.clientClaimKeys).toEqual(["role", "scope", "isAdmin"]);
    // The fingerprint object contains NO claim values.
    const serialized = JSON.stringify(fp);
    expect(serialized).not.toContain("ADMIN");
    expect(serialized).not.toContain("org:create");
  });

  test("credential-shaped claim keys are redacted to <redacted> (even the key name is suppressed)", () => {
    const fp = safeClaimsFingerprint({
      role: "USER",
      accessToken: SECRET_TOKEN,
      password: SECRET_PASSWORD,
      apiKey: SECRET_API_KEY,
      refreshToken: "rt",
      secret: "s",
      privateKey: "pk",
      credential: "c",
    });
    expect(fp.clientClaimsPresent).toBe(true);
    expect(fp.clientClaimsCount).toBe(8);
    // Only the non-credential key survives; all credential-shaped keys are
    // redacted to "<redacted>".
    expect(fp.clientClaimKeys).toEqual([
      "role",
      "<redacted>", // accessToken
      "<redacted>", // password
      "<redacted>", // apiKey
      "<redacted>", // refreshToken
      "<redacted>", // secret
      "<redacted>", // privateKey
      "<redacted>", // credential
    ]);
    // The serialized fingerprint does NOT leak any credential value.
    const serialized = JSON.stringify(fp);
    expect(serialized).not.toContain(SECRET_TOKEN);
    expect(serialized).not.toContain(SECRET_PASSWORD);
    expect(serialized).not.toContain(SECRET_API_KEY);
  });

  test("claim keys are capped at MAX_CLIENT_CLAIM_KEYS with a <truncated> sentinel", () => {
    const big: Record<string, unknown> = {};
    for (let i = 0; i < 50; i++) big[`key${i}`] = `value-${i}`;
    const fp = safeClaimsFingerprint(big);
    expect(fp.clientClaimsPresent).toBe(true);
    expect(fp.clientClaimsCount).toBe(50);
    // 16 visible keys + 1 <truncated> sentinel.
    expect(fp.clientClaimKeys.length).toBe(17);
    expect(fp.clientClaimKeys[fp.clientClaimKeys.length - 1]).toBe("<truncated>");
  });

  test("the fingerprint is safe to serialize — no nested objects, no values", () => {
    const fp = safeClaimsFingerprint({
      nested: { deeply: { secret: "leak" } },
      arr: [{ token: "leak" }],
      role: "ok",
    });
    // Only top-level keys are listed; nested structure is NOT traversed
    // (the fingerprint is intentionally shallow — values are never exposed).
    expect(fp.clientClaimKeys).toContain("nested");
    expect(fp.clientClaimKeys).toContain("arr");
    expect(fp.clientClaimKeys).toContain("role");
    const serialized = JSON.stringify(fp);
    expect(serialized).not.toContain("leak");
    expect(serialized).not.toContain("deeply");
  });
});

describe("NET-W002 remediation — credential client-claim values never appear in captured logs (deny path)", () => {
  test("deny-by-default: credential-shaped claim values do not appear in any log line", async () => {
    // Authenticated principal with NO allow policy → deny-by-default.
    // The deny path emits authorization.denied_default with the safe
    // fingerprint. The raw claims (containing credential material) MUST
    // NOT appear anywhere in runtime.logSink.entries.
    const ctx = createExecutionContext({
      correlationId: "remed-claims-deny-setup",
      actor: { id: "bootstrap", kind: "service" },
    });
    const person = await runtime.identityService.createIdentity(ctx, {
      displayName: "Deny Claims Principal",
      subjectReferences: [{ subjectId: "denyclaims@example.com", providerKind: "internal" }],
    });
    // No allow policy → deny-by-default.

    const beforeCount = runtime.logSink.entries.length;
    const res = await fetch(`${BASE}:${runtime.api.port}/api/organizations`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-correlation-id": "remed-claims-deny",
        "x-auth-subject-id": "denyclaims@example.com",
        "x-auth-provider-kind": "internal",
        "x-client-claims": JSON.stringify({
          role: "ADMIN",
          accessToken: SECRET_TOKEN,
          password: SECRET_PASSWORD,
          apiKey: SECRET_API_KEY,
        }),
      },
      body: JSON.stringify({ name: "Should Be Denied" }),
    });
    expect(res.status).toBe(403);

    const newEntries = runtime.logSink.entries.slice(beforeCount);
    expect(newEntries.length).toBeGreaterThan(0);

    // NONE of the credential values appear in any captured log line.
    const allLogsJson = newEntries.map((e) => JSON.stringify(e)).join("\n");
    expect(allLogsJson).not.toContain(SECRET_TOKEN);
    expect(allLogsJson).not.toContain(SECRET_PASSWORD);
    expect(allLogsJson).not.toContain(SECRET_API_KEY);

    // The authorization.denied_default entry carries the safe fingerprint
    // (clientClaimsPresent + clientClaimKeys + clientClaimsCount) and NOT
    // a raw `clientClaims` field.
    const deniedEntry = newEntries.find((e) => e.message === "authorization.denied_default");
    expect(deniedEntry).toBeDefined();
    const fields = deniedEntry!.fields as Record<string, unknown>;
    expect(fields.clientClaimsPresent).toBe(true);
    expect(fields.clientClaimsCount).toBe(4);
    expect(Array.isArray(fields.clientClaimKeys)).toBe(true);
    // Credential-shaped keys are redacted; the non-credential key survives.
    expect(fields.clientClaimKeys).toEqual(["role", "<redacted>", "<redacted>", "<redacted>"]);
    // The raw clientClaims object is NOT present.
    expect(fields.clientClaims).toBeUndefined();
  });

  test("unauthenticated deny: credential-shaped claim values do not appear in any log line", async () => {
    // No auth subject → unauthenticated → denied_unauthenticated path.
    const beforeCount = runtime.logSink.entries.length;
    const res = await fetch(`${BASE}:${runtime.api.port}/api/organizations`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-correlation-id": "remed-claims-unauth",
        "x-client-claims": JSON.stringify({
          accessToken: SECRET_TOKEN,
          password: SECRET_PASSWORD,
        }),
      },
      body: JSON.stringify({ name: "Unauth" }),
    });
    expect(res.status).toBe(403);

    const newEntries = runtime.logSink.entries.slice(beforeCount);
    const allLogsJson = newEntries.map((e) => JSON.stringify(e)).join("\n");
    expect(allLogsJson).not.toContain(SECRET_TOKEN);
    expect(allLogsJson).not.toContain(SECRET_PASSWORD);

    const deniedEntry = newEntries.find((e) => e.message === "authorization.denied_unauthenticated");
    expect(deniedEntry).toBeDefined();
    const fields = deniedEntry!.fields as Record<string, unknown>;
    expect(fields.clientClaimsPresent).toBe(true);
    expect(fields.clientClaimsCount).toBe(2);
    expect(fields.clientClaimKeys).toEqual(["<redacted>", "<redacted>"]);
    expect(fields.clientClaims).toBeUndefined();
  });

  test("explicit DENY policy: credential-shaped claim values do not appear in any log line", async () => {
    const ctx = createExecutionContext({
      correlationId: "remed-claims-policy-setup",
      actor: { id: "bootstrap", kind: "service" },
    });
    const person = await runtime.identityService.createIdentity(ctx, {
      displayName: "Policy Deny Principal",
      subjectReferences: [{ subjectId: "policydeny@example.com", providerKind: "internal" }],
    });
    await runtime.policyService.createPolicy(ctx, {
      subject: person.id,
      action: "organization.create",
      resource: "*",
      effect: "deny",
      createdBy: "bootstrap",
    });

    const beforeCount = runtime.logSink.entries.length;
    const res = await fetch(`${BASE}:${runtime.api.port}/api/organizations`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-correlation-id": "remed-claims-policy",
        "x-auth-subject-id": "policydeny@example.com",
        "x-auth-provider-kind": "internal",
        "x-client-claims": JSON.stringify({
          role: "ADMIN",
          apiKey: SECRET_API_KEY,
        }),
      },
      body: JSON.stringify({ name: "Policy Denied" }),
    });
    expect(res.status).toBe(403);

    const newEntries = runtime.logSink.entries.slice(beforeCount);
    const allLogsJson = newEntries.map((e) => JSON.stringify(e)).join("\n");
    expect(allLogsJson).not.toContain(SECRET_API_KEY);

    const deniedEntry = newEntries.find((e) => e.message === "authorization.denied_policy");
    expect(deniedEntry).toBeDefined();
    const fields = deniedEntry!.fields as Record<string, unknown>;
    expect(fields.clientClaimsPresent).toBe(true);
    expect(fields.clientClaimKeys).toEqual(["role", "<redacted>"]);
    expect(fields.clientClaims).toBeUndefined();
  });
});

describe("NET-W002 remediation — credential client-claim values never appear in captured logs (allow path)", () => {
  test("allow path: credential-shaped claim values do not appear in any log line even when authorized", async () => {
    // Even on the allow path, the inbound claims were carried through the
    // API server → apiAuth.authorize → AuthorizationService.authorize. The
    // AuthorizationService does NOT log raw claims on allow (only the safe
    // fingerprint would be logged on the deny path). Verify no leakage.
    const ctx = createExecutionContext({
      correlationId: "remed-claims-allow-setup",
      actor: { id: "bootstrap", kind: "service" },
    });
    const person = await runtime.identityService.createIdentity(ctx, {
      displayName: "Allow Claims Principal",
      subjectReferences: [{ subjectId: "allowclaims@example.com", providerKind: "internal" }],
    });
    await runtime.policyService.createPolicy(ctx, {
      subject: person.id,
      action: "organization.create",
      resource: "*",
      effect: "allow",
      createdBy: "bootstrap",
    });

    const beforeCount = runtime.logSink.entries.length;
    const res = await fetch(`${BASE}:${runtime.api.port}/api/organizations`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-correlation-id": "remed-claims-allow",
        "x-auth-subject-id": "allowclaims@example.com",
        "x-auth-provider-kind": "internal",
        "x-client-claims": JSON.stringify({
          role: "USER",
          accessToken: SECRET_TOKEN,
          password: SECRET_PASSWORD,
        }),
      },
      body: JSON.stringify({ name: "Allow Org" }),
    });
    expect(res.status).toBe(201);

    const newEntries = runtime.logSink.entries.slice(beforeCount);
    const allLogsJson = newEntries.map((e) => JSON.stringify(e)).join("\n");
    expect(allLogsJson).not.toContain(SECRET_TOKEN);
    expect(allLogsJson).not.toContain(SECRET_PASSWORD);
    // The allow path does NOT log the fingerprint either (the allow log
    // line carries only action/resource/policyId — never claims).
    const allowedEntry = newEntries.find((e) => e.message === "authorization.allowed_policy");
    if (allowedEntry) {
      const fields = allowedEntry.fields as Record<string, unknown>;
      expect(fields.clientClaims).toBeUndefined();
      expect(fields.clientClaimsPresent).toBeUndefined();
    }
  });
});

describe("NET-W002 remediation — static contract: raw clientClaims never logged", () => {
  test("the AuthorizationService source does not log a raw `clientClaims` field", async () => {
    const { readFile } = await import("node:fs/promises");
    const { join } = await import("node:path");
    const REPO = join(import.meta.dir, "../..");
    const authz = await readFile(join(REPO, "src/participants/authorization-service.ts"), "utf8");
    // Strip line comments so documentation doesn't accidentally match.
    const codeOnly = authz.replace(/^\s*\/\/.*$/gm, "");
    // No logger.* call passes a `clientClaims:` field (the raw object).
    // Match `clientClaims:` only when it appears as a field key inside a
    // logger.* fields object literal (not as a property of a type or a
    // parameter reference).
    expect(codeOnly).not.toMatch(/logger\.\w+\([^)]*clientClaims\s*:/s);
    // The safe fingerprint helper IS defined and exported.
    expect(authz).toMatch(/export function safeClaimsFingerprint/);
    // The three deny-path log calls spread the fingerprint (not raw claims).
    expect(authz).toMatch(/authorization\.denied_unauthenticated[\s\S]*?\.\.\.claimsFingerprint/);
    expect(authz).toMatch(/authorization\.denied_policy[\s\S]*?\.\.\.claimsFingerprint/);
    expect(authz).toMatch(/authorization\.denied_default[\s\S]*?\.\.\.claimsFingerprint/);
  });
});
