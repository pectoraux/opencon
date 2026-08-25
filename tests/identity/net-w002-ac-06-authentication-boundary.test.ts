/**
 * NET-W002-AC-06 — Authentication boundary.
 *
 * Canonical identity resolution depends on a provider-neutral
 * authentication interface; no production authentication provider is
 * coupled into domain code.
 *
 * Evidence: static architecture test + adapter contract test.
 *
 * Static architecture test: the identity domain declares the
 * PrincipalResolver interface and ships a deterministic in-memory
 * resolver. Domain code imports ONLY core + the identity port — never
 * a concrete external auth provider (OIDC/SAML/JWT library). The
 * architecture check (NET-W001-AC-02) enforces this via the tier allow
 * matrix.
 *
 * Adapter contract test: the PrincipalResolver resolves an
 * AuthenticatedSubject (opaque subject ref + provider kind, NO
 * credentials) into a canonical PersonIdentity. The resolver never
 * receives or returns credential material.
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { join } from "node:path";
import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { scanArchitecture } from "../../scripts/lib/architecture.ts";
import { createRuntime, type Runtime } from "../../src/bootstrap/runtime.ts";
import { createExecutionContext } from "../../src/core/execution-context.ts";
import { SecretAccessError } from "../../src/core/errors.ts";
import type { PrincipalResolver, AuthenticatedSubject } from "../../src/identity/port.ts";

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
});

afterEach(async () => {
  await runtime.shutdown();
});

describe("NET-W002-AC-06 authentication boundary (static architecture)", () => {
  test("the identity port declares PrincipalResolver + AuthenticatedSubject (provider-neutral interface)", async () => {
    const port = await readFile(join(SRC, "identity/port.ts"), "utf8");
    expect(port).toMatch(/export interface PrincipalResolver/);
    expect(port).toMatch(/export interface AuthenticatedSubject/);
    expect(port).toMatch(/export interface SubjectReference/);
    // Provider-neutral: subject references carry subjectId + providerKind
    // (NOT a specific provider SDK type).
    expect(port).toMatch(/providerKind/);
  });

  test("no domain code imports a concrete external auth provider (OIDC/SAML/JWT)", async () => {
    // The architecture check already enforces no domain→adapter imports
    // (NET-W001-AC-02). Here we additionally assert that NO file under
    // src/identity/ or src/participants/ references an external auth
    // SDK (openid-client, passport, jose, jose.*, jsonwebtoken, etc.).
    const domainDirs = ["identity", "participants", "organizations"];
    const forbidden = /\bfrom\s+["'](openid-client|passport|passport-.+|jose|jsonwebtoken|@auth0\/.+|next-auth|firebase-admin|@aws-sdk\/client-cognito|oauth4webapi)["']/;
    for (const dir of domainDirs) {
      const dirPath = join(SRC, dir);
      if (!existsSync(dirPath)) continue;
      await scanAndAssertNoMatch(dirPath, forbidden, dir);
    }
  });

  test("the in-memory PrincipalResolver is clearly a test/dev implementation", async () => {
    const impl = await readFile(join(SRC, "identity/in-memory-principal-resolver.ts"), "utf8");
    // The file documents that it is NOT a production auth provider.
    expect(impl).toMatch(/NOT a production auth provider/i);
    expect(impl).toMatch(/test\/dev ONLY|deterministic in-memory/i);
  });

  test("the architecture check still passes (no auth-provider leak)", async () => {
    const result = await scanArchitecture({ root: SRC, repoSrc: SRC });
    expect(result.violations).toEqual([]);
  });
});

describe("NET-W002-AC-06 authentication boundary (adapter contract)", () => {
  test("the PrincipalResolver resolves an AuthenticatedSubject to the canonical identity", async () => {
    const ctx = createExecutionContext({ correlationId: "ac06-resolve", actor: { id: "bootstrap", kind: "service" } });
    const person = await runtime.identityService.createIdentity(ctx, {
      displayName: "Resolver Subject",
      subjectReferences: [{ subjectId: "resolver@example.com", providerKind: "internal" }],
    });

    // The resolver is exposed via the runtime (wired by bootstrap). It
    // implements the PrincipalResolver contract.
    const resolver: PrincipalResolver = {
      async resolve(subject: AuthenticatedSubject) {
        return runtime.identityService.resolve(subject);
      },
    };

    const resolved = await resolver.resolve({
      subject: { subjectId: "resolver@example.com", providerKind: "internal" },
    });
    expect(resolved).not.toBeNull();
    expect(resolved!.id).toBe(person.id);
  });

  test("the resolver returns null for an unlinked subject (no identity)", async () => {
    const resolver: PrincipalResolver = {
      async resolve(subject: AuthenticatedSubject) {
        return runtime.identityService.resolve(subject);
      },
    };
    const resolved = await resolver.resolve({
      subject: { subjectId: "unlinked@example.com", providerKind: "internal" },
    });
    expect(resolved).toBeNull();
  });

  test("the resolver rejects AuthenticatedSubject inputs carrying credential material (privacy boundary)", async () => {
    const resolver: PrincipalResolver = {
      async resolve(subject: AuthenticatedSubject) {
        return runtime.identityService.resolve(subject);
      },
    };
    // Forged subject carrying a credential-shaped client claim. The
    // IdentityService.assertNoCredentialMaterial guard rejects it.
    await expect(
      resolver.resolve({
        subject: { subjectId: "x@example.com", providerKind: "internal" },
        clientClaims: { accessToken: "secret-token-value" },
      }),
    ).rejects.toThrow(SecretAccessError);
  });
});

// Helper: scan a directory tree for .ts files matching a regex.
async function scanAndAssertNoMatch(
  dir: string,
  pattern: RegExp,
  label: string,
): Promise<void> {
  const { readdir } = await import("node:fs/promises");
  const entries = await readdir(dir, { withFileTypes: true });
  for (const e of entries) {
    const full = join(dir, e.name);
    if (e.isDirectory()) {
      await scanAndAssertNoMatch(full, pattern, label);
    } else if (e.isFile() && e.name.endsWith(".ts")) {
      const content = await readFile(full, "utf8");
      if (pattern.test(content)) {
        throw new Error(`Forbidden external auth-provider import found in ${label}: ${full}`);
      }
    }
  }
}
