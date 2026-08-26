/**
 * OpenCon core error taxonomy.
 *
 * All cross-module errors extend {@link OpenConError} and carry a stable
 * `code` and `classification` so callers (and the structured logger) can
 * route, classify and retry deterministically without instanceof checks.
 *
 * Module contract convention (see docs/module-conventions.md):
 * - Domain modules throw these (or module-specific subclasses).
 * - Infrastructure rethrows with added context, never swallows.
 * - No domain module silently decides economic/material state.
 */

export type ErrorClassification =
  /** Invalid caller input, configuration, or contract usage. Not retryable as-is. */
  | "validation"
  /** Caller lacks authority or the operation is not permitted. Not retryable. */
  | "authorization"
  /** Requested resource or state does not exist. */
  | "not_found"
  /** Operation conflicts with existing state (duplicate, idempotent replay). */
  | "conflict"
  /** Transient infrastructure failure; retry per policy is appropriate. */
  | "transient"
  /** A precondition for the operation was not met. */
  | "precondition"
  /** An architectural or invariant violation. Never retryable. */
  | "invariant"
  /** Anything not classified above. Treated as a bug. */
  | "unknown";

export interface OpenConErrorOptions {
  readonly code: string;
  readonly classification: ErrorClassification;
  readonly message: string;
  readonly cause?: unknown;
  readonly retryable?: boolean;
  readonly context?: Readonly<Record<string, unknown>>;
}

/**
 * Base class for all OpenCon errors. Carrying `code` + `classification`
 * lets the logger emit structured `error.classification` and lets the
 * worker boundary decide retry behaviour without parsing strings.
 */
export class OpenConError extends Error {
  public readonly code: string;
  public readonly classification: ErrorClassification;
  public readonly retryable: boolean;
  public readonly context: Readonly<Record<string, unknown>>;

  public constructor(opts: OpenConErrorOptions) {
    super(opts.message, { cause: opts.cause });
    this.name = this.constructor.name;
    this.code = opts.code;
    this.classification = opts.classification;
    this.retryable = opts.retryable ?? opts.classification === "transient";
    this.context = opts.context ?? {};
    if (typeof (Error as unknown as { captureStackTrace?: unknown }).captureStackTrace === "function") {
      (
        Error as unknown as {
          captureStackTrace: (target: unknown, ctor?: unknown) => void;
        }
      ).captureStackTrace(this, this.constructor);
    }
  }

  public toJSON(): Readonly<Record<string, unknown>> {
    return {
      name: this.name,
      code: this.code,
      classification: this.classification,
      retryable: this.retryable,
      message: this.message,
      context: this.context,
      cause: this.cause instanceof Error ? this.cause.message : this.cause,
    };
  }
}

export class ConfigurationValidationError extends OpenConError {
  public constructor(
    message: string,
    context?: Readonly<Record<string, unknown>>,
    cause?: unknown,
  ) {
    super({
      code: "CONFIG_VALIDATION",
      classification: "validation",
      message,
      cause,
      retryable: false,
      context,
    });
  }
}

/**
 * Raised when a caller attempts to read secret material through the
 * {@link ConfigurationProvider} (e.g. `config.get("DATABASE_URL")`).
 *
 * Classification: `invariant` — this is an architectural boundary
 * violation, never retryable. Secret material MUST be resolved
 * exclusively through the {@link SecretProvider}; the
 * ConfigurationProvider only returns non-secret configuration values
 * and opaque secret *references* (never the value).
 */
export class SecretAccessError extends OpenConError {
  public constructor(
    message: string,
    context?: Readonly<Record<string, unknown>>,
  ) {
    super({
      code: "SECRET_ACCESS",
      classification: "invariant",
      message,
      retryable: false,
      context,
    });
  }
}

export class AuthorizationError extends OpenConError {
  public constructor(
    message: string,
    context?: Readonly<Record<string, unknown>>,
  ) {
    super({
      code: "AUTHORIZATION",
      classification: "authorization",
      message,
      retryable: false,
      context,
    });
  }
}

export class NotFoundError extends OpenConError {
  public constructor(
    message: string,
    context?: Readonly<Record<string, unknown>>,
  ) {
    super({
      code: "NOT_FOUND",
      classification: "not_found",
      message,
      retryable: false,
      context,
    });
  }
}

export class ConflictError extends OpenConError {
  public constructor(
    message: string,
    context?: Readonly<Record<string, unknown>>,
  ) {
    super({
      code: "CONFLICT",
      classification: "conflict",
      message,
      retryable: false,
      context,
    });
  }
}

export class TransientError extends OpenConError {
  public constructor(
    message: string,
    context?: Readonly<Record<string, unknown>>,
    cause?: unknown,
  ) {
    super({
      code: "TRANSIENT",
      classification: "transient",
      message,
      retryable: true,
      cause,
      context,
    });
  }
}

export class InvariantError extends OpenConError {
  public constructor(
    message: string,
    context?: Readonly<Record<string, unknown>>,
  ) {
    super({
      code: "INVARIANT",
      classification: "invariant",
      message,
      retryable: false,
      context,
    });
  }
}

/**
 * Raised at the composition root when a required provider's configuration
 * cannot be resolved through the {@link SecretProvider} for a configured
 * (production/staging) deployment.
 *
 * Classification: `validation` — NEVER retryable. The frozen architecture
 * places external provider integrations (PostgreSQL, Redis) behind
 * `/adapters` and requires that their connection material be resolved
 * through the {@link SecretProvider} at the bootstrap boundary. A
 * configured production/staging deployment MUST NOT silently fall back
 * to a file/in-memory test double when the real provider's configuration
 * is missing — the boundary fails fast so an operator can remediate
 * rather than discover data loss later.
 *
 * Work order ref: NET-W003 §4.1 (PostgreSQL authoritative persistence),
 * §4.2 (Redis non-authoritative coordination) — architect re-review on
 * PR #6 (composition-root provider selection): missing required provider
 * configuration must fail fast rather than silently selecting a shim.
 */
export class ProviderConfigurationError extends OpenConError {
  public constructor(
    message: string,
    context?: Readonly<Record<string, unknown>>,
    cause?: unknown,
  ) {
    super({
      code: "PROVIDER_CONFIGURATION",
      classification: "validation",
      message,
      retryable: false,
      cause,
      context,
    });
  }
}

/**
 * Raised when the authoritative persistence boundary detects that its
 * durable committed state is corrupt (e.g. a file-backed authority test
 * double finds a malformed committed snapshot on recovery).
 *
 * Classification: `invariant` — NEVER retryable. An authority boundary
 * MUST NOT silently convert storage corruption into an empty store
 * (that would turn corruption into data loss). The operator must
 * restore from backup / investigate; surfacing an explicit error is
 * the safe recovery posture.
 *
 * Work order ref: NET-W003 §4.1 (PostgreSQL authoritative persistence),
 * §4.5 (recovery restores only committed state) — architect re-review
 * on PR #6: corruption of the committed snapshot must be surfaced as an
 * explicit recovery/storage error rather than converting the
 * authoritative state to empty.
 */
export class StorageCorruptionError extends OpenConError {
  public constructor(
    message: string,
    context?: Readonly<Record<string, unknown>>,
    cause?: unknown,
  ) {
    super({
      code: "STORAGE_CORRUPTION",
      classification: "invariant",
      message,
      retryable: false,
      cause,
      context,
    });
  }
}

/**
 * Classify an arbitrary thrown value into a serializable error record.
 * Used by the logger and worker boundary to normalize unknown failures.
 */
export function classifyError(err: unknown): {
  readonly message: string;
  readonly code: string;
  readonly classification: ErrorClassification;
  readonly retryable: boolean;
  readonly context: Readonly<Record<string, unknown>>;
  readonly cause: unknown;
} {
  if (err instanceof OpenConError) {
    return {
      message: err.message,
      code: err.code,
      classification: err.classification,
      retryable: err.retryable,
      context: err.context,
      cause: err.cause,
    };
  }
  const message =
    err instanceof Error
      ? err.message
      : typeof err === "string"
        ? err
        : "unknown_error";
  return {
    message,
    code: "UNKNOWN",
    classification: "unknown",
    retryable: false,
    context: {},
    cause: err,
  };
}
