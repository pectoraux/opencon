/**
 * Logger contract — structured, JSON-capable, execution-aware.
 *
 * Work order ref: NET-W001 §4.6 (Logging and observability).
 *
 * Concrete infrastructure implementation lives in src/observability/logger.ts
 * and is imported ONLY by infrastructure-tier modules. Domain modules
 * consume the {@link Logger} interface (declared here) so they never
 * depend on a concrete sink.
 */

import type { ErrorClassification } from "./errors.ts";

export type LogLevel = "trace" | "debug" | "info" | "warn" | "error" | "fatal";

export interface LogFields {
  readonly [key: string]: unknown;
}

/**
 * A structured log entry. The concrete logger emits this shape (plus the
 * active execution context identifiers) as a single JSON line.
 */
export interface LogEntry {
  readonly timestamp: string;
  readonly level: LogLevel;
  readonly message: string;
  readonly module: string;
  readonly component?: string;
  readonly executionId?: string;
  readonly correlationId?: string;
  readonly actorId?: string;
  readonly fields: LogFields;
  readonly error?: {
    readonly message: string;
    readonly code: string;
    readonly classification: ErrorClassification;
    readonly retryable: boolean;
    readonly stack?: string;
  };
}

/**
 * Provider-neutral logger interface. Implementations MUST:
 *  - attach active execution/correlation IDs from the AsyncLocalStorage;
 *  - emit JSON in production and pretty text in development;
 *  - classify errors via the shared error taxonomy;
 *  - never throw on bad input (degraded logging > crash).
 */
export interface Logger {
  readonly module: string;
  trace(message: string, fields?: LogFields): void;
  debug(message: string, fields?: LogFields): void;
  info(message: string, fields?: LogFields): void;
  warn(message: string, errorOrFields?: unknown, fields?: LogFields): void;
  error(message: string, errorOrFields?: unknown, fields?: LogFields): void;
  fatal(message: string, errorOrFields?: unknown, fields?: LogFields): void;
  /** Create a child logger bound to a sub-component. */
  child(component: string): Logger;
  /** Bind a module name (used by domain modules to self-identify). */
  forModule(module: string): Logger;
}

/**
 * Health-check contract surfaced through observability. The minimal
 * health/readiness/liveness surface required to operate the skeleton.
 */
export type HealthStatus = "pass" | "warn" | "fail";

export interface HealthCheckResult {
  readonly name: string;
  readonly status: HealthStatus;
  readonly message?: string;
  readonly observedAt: string;
}

export interface HealthReport {
  readonly status: HealthStatus;
  readonly checks: readonly HealthCheckResult[];
  readonly observedAt: string;
}
