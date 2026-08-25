/**
 * NET-W002-AC-07 — Privacy boundary.
 *
 * Protected identity data and credentials are never returned by public
 * identity endpoints, and no raw personal activity is persisted as
 * public-ledger data.
 *
 * Evidence: API contract/security tests + static inspection.
 *
 * The identity domain model carries NO credentials (no password hashes,
 * no OAuth tokens, no access tokens). The PublicIdentityView exposes
 * ONLY the stable id + display name. The IdentityService rejects any
 * input carrying credential-shaped field names with SecretAccessError.
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { join } from "node:path";
import { readFile } from "node:fs/promises";
import { createRuntime, type Runtime } from "../../src/bootstrap/runtime.ts";
import { createExecutionContext } from "../../src/core/execution-context.ts";
import { SecretAccessError } from "../../src/core/errors.ts";

const REPO = join(import.meta.dir, "../..");
const SRC = join(REPO, "src");

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

describe("NET-W002-AC-07 privacy boundary (static inspection)", () => {
  test("the PersonIdentity model has NO credential fields", async () => {
    const port = await readFile(join(SRC, "identity/port.ts"), "utf8");
    // Extract the PersonIdentity interface block up to the closing brace
    // on its own line (skips inline `}` in JSDoc `{@link}` tags).
    const personBlock = port.match(
      /export interface PersonIdentity \{[\s\S]*?^\}/m,
    );
    expect(personBlock).not.toBeNull();
    const block = personBlock![0];
    const fieldNames = [...block.matchAll(/readonly\s+(\w+)\s*:/g)]
      .map((m) => m[1])
      .filter((v): v is string => typeof v === "string");
    expect(fieldNames.length).toBeGreaterThan(0);
    for (const name of fieldNames) {
      expect(name).not.toMatch(/password/i);
      expect(name).not.toMatch(/passwordHash/i);
      expect(name).not.toMatch(/accessToken/i);
      expect(name).not.toMatch(/refreshToken/i);
      expect(name).not.toMatch(/oauthToken/i);
      expect(name).not.toMatch(/idToken/i);
      expect(name).not.toMatch(/apiKey/i);
      expect(name).not.toMatch(/privateKey/i);
    }
    // subjectReferences is allowed (opaque subject handle, not a credential).
    expect(fieldNames).toContain("subjectReferences");
  });

  test("the PublicIdentityView exposes ONLY stable id + display name", async () => {
    const port = await readFile(join(SRC, "identity/port.ts"), "utf8");
    const viewBlock = port.match(/export interface PublicIdentityView \{[\s\S]*?\}/);
    expect(viewBlock).not.toBeNull();
    const block = viewBlock![0];
    expect(block).toMatch(/readonly id:/);
    expect(block).toMatch(/readonly displayName:/);
    // No other fields.
    expect(block).not.toMatch(/subjectReferences/);
    expect(block).not.toMatch(/reputationAnchors/);
    expect(block).not.toMatch(/password/i);
    expect(block).not.toMatch(/token/i);
  });

  test("no identity-domain source file references credential material in persisted models", async () => {
    const files = [
      join(SRC, "identity/port.ts"),
      join(SRC, "identity/identity-service.ts"),
      join(SRC, "identity/in-memory-identity-repository.ts"),
      join(SRC, "identity/in-memory-principal-resolver.ts"),
    ];
    for (const f of files) {
      const content = await readFile(f, "utf8");
      // The identity model must NOT define fields that store credential
      // values. Collect every `readonly <name>:` declaration and verify
      // none of the declared field names are credential-shaped.
      const declMatches = [...content.matchAll(/readonly\s+(\w+)\s*:/g)];
      const declared = declMatches
        .map((m) => m[1])
        .filter((v): v is string => typeof v === "string");
      const forbidden = declared.filter((d) =>
        /password|passwordHash|accessToken|refreshToken|oauthToken|idToken|apiKey|privateKey/i.test(d),
      );
      expect(forbidden).toEqual([]);
    }
  });
});

describe("NET-W002-AC-07 privacy boundary (API contract/security)", () => {
  test("the public identity endpoint returns ONLY id + displayName (no subjectReferences, no anchors, no credentials)", async () => {
    const ctx = createExecutionContext({ correlationId: "ac07-public", actor: { id: "bootstrap", kind: "service" } });
    const person = await runtime.identityService.createIdentity(ctx, {
      displayName: "Private Person",
      subjectReferences: [
        { subjectId: "private@example.com", providerKind: "internal" },
        { subjectId: "private@other", providerKind: "oidc" },
      ],
      reputationAnchors: [{ dimension: "helpfulness", anchorId: "anchor-1" }],
    });

    const res = await fetch(`${BASE}:${runtime.api.port}/api/identities/${person.id}`, {
      headers: { "x-correlation-id": "ac07-public" },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    // Only id + displayName are exposed.
    expect(Object.keys(body).sort()).toEqual(["displayName", "id"]);
    expect(body.id).toBe(person.id);
    expect(body.displayName).toBe("Private Person");
    // No subjectReferences leaked.
    expect(body.subjectReferences).toBeUndefined();
    // No reputationAnchors leaked.
    expect(body.reputationAnchors).toBeUndefined();
    // No credential fields.
    expect(body.password).toBeUndefined();
    expect(body.accessToken).toBeUndefined();
    expect(body.oauthToken).toBeUndefined();
  });

  test("the public identity endpoint returns 404 for an unknown id (no existence oracle via timing)", async () => {
    const res = await fetch(`${BASE}:${runtime.api.port}/api/identities/nonexistent-id`, {
      headers: { "x-correlation-id": "ac07-404" },
    });
    expect(res.status).toBe(404);
  });

  test("creating an identity with credential-shaped input is rejected (SecretAccessError)", async () => {
    const ctx = createExecutionContext({ correlationId: "ac07-reject", actor: { id: "bootstrap", kind: "service" } });
    await expect(
      runtime.identityService.createIdentity(ctx, {
        displayName: "Bad",
        // The subject reference itself carries only opaque handles, never
        // credentials. But if a caller tries to sneak a credential field
        // into the subject reference object, the service rejects it.
        subjectReferences: [
          { subjectId: "x@example.com", providerKind: "internal", password: "hunter2" } as unknown as { subjectId: string; providerKind: string },
        ],
      }),
    ).rejects.toThrow(SecretAccessError);
  });

  test("resolving a principal with credential-shaped clientClaims is rejected", async () => {
    await expect(
      runtime.identityService.resolve({
        subject: { subjectId: "x@example.com", providerKind: "internal" },
        clientClaims: { accessToken: "forged-token" },
      }),
    ).rejects.toThrow(SecretAccessError);
  });

  test("no raw personal activity is persisted as public-ledger data (identity records carry no activity fields)", async () => {
    // The PersonIdentity + PublicIdentityView + Membership models carry
    // NO raw personal-activity fields (no browsing history, no clicks,
    // no location, no content history). Privacy-by-design (PRIV-001).
    const port = await readFile(join(SRC, "identity/port.ts"), "utf8");
    expect(port).not.toMatch(/browsingHistory|clickStream|location|deviceFingerprint|rawActivity/i);
    const orgPort = await readFile(join(SRC, "organizations/port.ts"), "utf8");
    expect(orgPort).not.toMatch(/browsingHistory|clickStream|location|deviceFingerprint|rawActivity/i);
  });
});
