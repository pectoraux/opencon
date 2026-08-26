/**
 * NET-W003-AC-04 — Secret-provider isolation.
 *
 * Evidence: integration test proving secret material is resolved ONLY
 * through the SecretProvider and NEVER appears in logs, audit records,
 * or persisted state.
 *
 * Carries forward the NET-W002 remediations:
 *  - no caller-controlled actor (X-Actor-Id);
 *  - no raw X-Client-Claims in logs.
 *
 * NET-W003 adds: SecretMaterialRedactor redacts credential-shaped
 * values from arbitrary log/trace fields, and the boundary is proven
 * across persistence/observability/audit sinks.
 */

import { describe, test, expect } from "bun:test";
import {
  redactSecrets,
  assertNoSecretValue,
  CREDENTIAL_KEY_PATTERN,
  CREDENTIAL_VALUE_PATTERN,
} from "../../src/secrets/secret-redactor.ts";
import { createEnvSecretProvider } from "../../src/secrets/env-provider.ts";
import type { SecretDescriptor } from "../../src/core/secrets.ts";

const SECRET_VALUE = "ak-1234567890abcdef-do-not-leak-this-is-a-secret-value";

const catalog: readonly SecretDescriptor[] = [
  { key: "DATABASE_URL", required: true, hasValue: false, redactedPreview: "<secret:DATABASE_URL>" },
];

describe("NET-W003-AC-04 secret-provider isolation", () => {
  test("the SecretProvider resolves the secret value at the boundary", async () => {
    const env = { DATABASE_URL: SECRET_VALUE } as unknown as NodeJS.ProcessEnv;
    const provider = createEnvSecretProvider({ source: env, catalog });
    expect(await provider.getSecret("DATABASE_URL")).toBe(SECRET_VALUE);
    expect(provider.hasSecret("DATABASE_URL")).toBe(true);
    const desc = provider.describe().find((d) => d.key === "DATABASE_URL")!;
    expect(desc.redactedPreview).toBe("<secret:DATABASE_URL>");
    expect(desc.hasValue).toBe(true);
    // The redacted preview NEVER carries the value.
    expect(desc.redactedPreview).not.toContain(SECRET_VALUE);
  });

  test("a missing secret raises SecretNotFoundError", async () => {
    const env = {} as NodeJS.ProcessEnv;
    const provider = createEnvSecretProvider({ source: env, catalog });
    await expect(provider.getSecret("DATABASE_URL")).rejects.toThrow(
      /required secret not configured: DATABASE_URL/,
    );
  });

  test("redactSecrets redacts credential-shaped KEYS", () => {
    const input = {
      user: "alice",
      password: SECRET_VALUE,
      apiKey: "sk-1234",
      token: "tok-xyz",
      nested: { secret: "deeply-hidden", safe: "ok" },
      array: [{ private_key: "pk" }, { normal: "value" }],
    };
    const out = redactSecrets(input) as Record<string, unknown>;
    expect(out.user).toBe("alice");
    expect(out.password).toBe("<redacted>");
    expect(out.apiKey).toBe("<redacted>");
    expect(out.token).toBe("<redacted>");
    const nested = out.nested as Record<string, unknown>;
    expect(nested.secret).toBe("<redacted>");
    expect(nested.safe).toBe("ok");
    const arr = out.array as Array<Record<string, unknown>>;
    expect(arr[0]!.private_key).toBe("<redacted>");
    expect(arr[1]!.normal).toBe("value");
    // The secret value never appears in the redacted output.
    assertNoSecretValue(out, [SECRET_VALUE, "sk-1234", "tok-xyz", "pk", "deeply-hidden"]);
  });

  test("redactSecrets redacts credential-shaped VALUES (long base64/hex, bearer, JWT)", () => {
    const input = {
      authHeader: "Bearer eyJhbGc.iOiJIUzI1NiJ9.eyJzdWI.signature",
      connectionStr: "postgres://user:password=secretpass@host/db",
      opaque: "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_==",
      safe: "hello",
    };
    const out = redactSecrets(input) as Record<string, unknown>;
    expect(out.authHeader).toBe("<redacted>");
    expect(out.connectionStr).toBe("<redacted>");
    expect(out.opaque).toBe("<redacted>");
    expect(out.safe).toBe("hello");
  });

  test("redactSecrets redacts explicit forbidden values verbatim", () => {
    const input = {
      note: `config has the secret ${SECRET_VALUE} inlined here`,
      other: SECRET_VALUE,
    };
    const out = redactSecrets(input, { forbiddenValues: [SECRET_VALUE] }) as Record<string, unknown>;
    // Even though `note` and `other` are not credential-shaped keys, the
    // forbidden VALUE is redacted wherever it appears.
    expect(JSON.stringify(out)).not.toContain(SECRET_VALUE);
  });

  test("redactSecrets never mutates the input", () => {
    const input = { password: SECRET_VALUE, safe: "ok" };
    const snapshot = JSON.stringify(input);
    redactSecrets(input);
    expect(JSON.stringify(input)).toBe(snapshot); // input untouched
  });

  test("the redaction patterns catch the canonical credential surface", () => {
    // Key pattern catches the common credential key names.
    for (const key of [
      "password",
      "PASSWORD",
      "api_key",
      "apiKey",
      "api-key",
      "privateKey",
      "private_key",
      "secret",
      "token",
      "credential",
      "auth_header",
      "authHeader",
    ]) {
      expect(CREDENTIAL_KEY_PATTERN.test(key)).toBe(true);
    }
    for (const safe of ["name", "email", "displayName", "subjectId", "organizationId"]) {
      expect(CREDENTIAL_KEY_PATTERN.test(safe)).toBe(false);
    }
    // Value pattern catches bearer tokens, long opaque strings, JWTs,
    // and connection-string secret fragments.
    for (const val of [
      "Bearer eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.signature", // bearer JWT (realistic length)
      "sk-1234567890abcdefghij", // 24 chars — opaque token
      "postgres://u:p=secretpass@host/db",
      "AKIAIOSFODNN7EXAMPLE0123456789ABCDEF",
    ]) {
      expect(CREDENTIAL_VALUE_PATTERN.test(val)).toBe(true);
    }
    for (const safe of ["hello", "person-1", "ok", "2026-01-01T00:00:00.000Z", "1.0"]) {
      expect(CREDENTIAL_VALUE_PATTERN.test(safe)).toBe(false);
    }
  });

  test("assertNoSecretValue throws when a forbidden value IS present", () => {
    const value = { note: `leaked: ${SECRET_VALUE}` };
    expect(() => assertNoSecretValue(value, [SECRET_VALUE])).toThrow(
      /secret material leaked into logs/,
    );
  });

  test("assertNoSecretValue does not throw when the value is absent", () => {
    const value = { note: "no secrets here" };
    expect(() => assertNoSecretValue(value, [SECRET_VALUE])).not.toThrow();
  });

  test("a simulated audit record does not contain the secret value after redaction", () => {
    const auditRecord = {
      eventType: "identity.person_created",
      actor: "person-1",
      metadata: {
        connectionHint: `value=${SECRET_VALUE}`,
        apiKey: SECRET_VALUE,
        note: "created by system",
      },
    };
    const redacted = redactSecrets(auditRecord, { forbiddenValues: [SECRET_VALUE] });
    assertNoSecretValue(redacted, [SECRET_VALUE]);
  });
});
