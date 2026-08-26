/**
 * SecretMaterialRedactor — redact credential-shaped values from logs/traces.
 *
 * Work order ref: NET-W003 §4.4 (SecretProvider boundary), AC-04
 * (Secret-provider isolation). Carries forward the NET-W002 remediation
 * that suppressed raw `X-Client-Claims` from authorization logs.
 *
 * The SecretProvider resolves secret material at the infrastructure
 * boundary. NET-W003 ensures that boundary holds across persistence,
 * observability and audit: secret material is NEVER logged, NEVER
 * persisted as audit/trace material, and NEVER returned through the
 * ConfigurationProvider.
 *
 * This module provides:
 *  - `redactSecrets(value)` — recursively redact credential-shaped keys
 *    and values from an arbitrary log/trace field structure. A
 *    credential-shaped key (matching `password|token|secret|api[-_]?key|
 *    private[-_]?key|credential`) is redacted to `<redacted>`. A
 *    credential-shaped VALUE (a string that looks like a bearer token /
 *    password / connection-string secret) is replaced with `<redacted>`.
 *  - `assertNoSecretValue(value, forbidden)` — test helper asserting that
 *    none of the forbidden secret values appears anywhere in a serialized
 *    structure (used by the AC-04 regression test).
 *  - `CREDENTIAL_KEY_PATTERN` / `CREDENTIAL_VALUE_PATTERN` — exported
 *    patterns so tests can assert the redaction surface.
 *
 * The redactor is INTENTIONALLY conservative: it over-redacts (false
 * positives are acceptable; a leaked secret is not).
 */

export const CREDENTIAL_KEY_PATTERN =
  /password|token|secret|api[-_]?key|private[-_]?key|credential|auth[-_]?header/i;

// A credential-shaped VALUE: a long base64/hex-ish string, a bearer
// token, a `password=`/`secret=` connection-string fragment, a JWT-ish
// `xxx.yyy.zzz` shape, or a URL with embedded credentials
// (`scheme://user:pass@host`). These patterns catch the common
// accidental leak shapes; the test suite verifies the canonical
// synthetic secret values are caught. The redactor is INTENTIONALLY
// conservative (false positives are acceptable; a leaked secret is not).
export const CREDENTIAL_VALUE_PATTERN =
  /^(?:[A-Za-z0-9+/_-]{32,}={0,3}|(?:Bearer\s+)?[A-Za-z0-9._\-]{20,}|[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+|[a-z][a-z0-9+.\-]*:\/\/[^\s:/@]+:[^\s/@]+@[^\s/@]+(?:\/\S*)?|.*(?:password|secret|token|apikey|api_key)=.+)$/i;

export interface RedactOptions {
  /** When true, credential-shaped VALUES are also redacted (default true). */
  readonly redactValues?: boolean;
  /** Optional set of known secret values to redact verbatim. */
  readonly forbiddenValues?: readonly string[];
}

const REDACTED = "<redacted>";

function isPlainObject(v: unknown): v is Record<string, unknown> {
  if (v === null || typeof v !== "object") return false;
  const tag = Object.prototype.toString.call(v);
  return tag === "[object Object]";
}

function redactString(value: string, opts: RedactOptions): string {
  if (opts.forbiddenValues) {
    for (const forbidden of opts.forbiddenValues) {
      if (forbidden && value.includes(forbidden)) {
        return REDACTED;
      }
    }
  }
  if (opts.redactValues !== false && CREDENTIAL_VALUE_PATTERN.test(value)) {
    return REDACTED;
  }
  return value;
}

/**
 * Recursively redact credential-shaped keys and values from an arbitrary
 * structure. Returns a NEW deeply-redacted copy; the input is never
 * mutated. Non-plain values (Date, RegExp, Uint8Array, class instances)
 * are returned untouched so runtime semantics are preserved.
 */
export function redactSecrets(value: unknown, opts: RedactOptions = {}): unknown {
  if (typeof value === "string") {
    return redactString(value, opts);
  }
  if (Array.isArray(value)) {
    return value.map((v) => redactSecrets(v, opts));
  }
  if (isPlainObject(value)) {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) {
      if (CREDENTIAL_KEY_PATTERN.test(k)) {
        out[k] = REDACTED;
      } else {
        out[k] = redactSecrets(v, opts);
      }
    }
    return out;
  }
  return value;
}

/**
 * Test helper: serialize `value` to JSON and assert that NONE of the
 * forbidden secret values appears anywhere in the serialized output.
 * Used by the AC-04 regression test to prove the secret boundary holds
 * across logs, audit records and persisted state.
 */
export function assertNoSecretValue(value: unknown, forbidden: readonly string[]): void {
  const serialized = JSON.stringify(value ?? null);
  for (const secret of forbidden) {
    if (secret && serialized.includes(secret)) {
      throw new Error(
        `Secret boundary violation: a forbidden secret value appeared in serialized output. ` +
          `This proves secret material leaked into logs/audit/persisted state. ` +
          `(prefix=${secret.slice(0, 4)}…, length=${secret.length}) `,
      );
    }
  }
}
