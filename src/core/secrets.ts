/**
 * SecretProvider contract — secrets isolation boundary.
 *
 * Work order ref: NET-W001 §4.3 (no committed secrets, required/optional
 * secret classification), architecture-lock.md (no secrets committed),
 * §9 implementation constraints (do not commit secrets/credentials/tokens).
 *
 * Concrete implementation lives in src/secrets/. Secret material is NEVER
 * returned into domain modules; it is resolved by infrastructure wiring
 * only (e.g. when constructing an adapter client). This contract enforces
 * that boundary at the type level: secrets are accessed by reference
 * (`getSecret`) which resolves the value at the boundary, and `describe`
 * returns only redacted diagnostics.
 */

export interface SecretDescriptor {
  readonly key: string;
  readonly required: boolean;
  readonly hasValue: boolean;
  /** NEVER the secret value. Redacted presence indicator only. */
  readonly redactedPreview: string;
}

export interface SecretProvider {
  /**
   * Resolve secret material by key. The value is intended to be consumed
   * immediately at the infrastructure boundary (e.g. constructing a DB
   * client) and MUST NOT be persisted or logged.
   */
  getSecret(key: string): Promise<string>;
  /** Redacted diagnostics for the secret catalog (safe to log/audit). */
  describe(): readonly SecretDescriptor[];
  /** True iff a value is present for `key`. */
  hasSecret(key: string): boolean;
}

export class SecretNotFoundError extends Error {
  public constructor(key: string) {
    super(`required secret not configured: ${key}`);
    this.name = "SecretNotFoundError";
  }
}
