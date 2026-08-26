# `secrets` boundary

**Tier:** infrastructure  
**Authority:** secrets isolation boundary  
**Architecture ref:** `spec/architecture.md` §18;
`spec/architecture-lock.md` (no secrets committed)  
**Concrete behaviour:** NET-W001 (env-backed SecretProvider) + NET-W003 (redactor)

## Scope in NET-W003

NET-W003 hardens the secrets boundary established by NET-W001:

- **`SecretMaterialRedactor`** (`src/secrets/secret-redactor.ts`) —
  recursively redacts credential-shaped keys and values from arbitrary
  log/trace field structures. A credential-shaped key (matching
  `password|token|secret|api[-_]?key|private[-_]?key|credential|auth[-_]?header`)
  is redacted to `<redacted>`. A credential-shaped value (long base64/hex,
  bearer token, JWT-ish, connection-string fragment) is also redacted.
  The redactor is INTENTIONALLY conservative (over-redaction is
  acceptable; a leaked secret is not).
- The NET-W001 env-backed `SecretProvider` is unchanged. Secret material
  is resolved ONLY through `SecretProvider.getSecret()` at the
  infrastructure boundary.

## Boundary invariant

Secret material is NEVER:
  - returned through the `ConfigurationProvider` (NET-W001 closed this
    leak — `get()` throws `SecretAccessError` for classified secrets);
  - logged or persisted as audit/trace material (NET-W003 `redactSecrets`
    is applied at observability sinks);
  - stored in domain modules (NET-W002 §4.4 carries forward).

The AC-04 regression test proves the boundary holds: a configured
secret value does not appear in any log line, audit record, or
persisted row.
