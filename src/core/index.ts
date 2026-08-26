/**
 * OpenCon core contracts barrel.
 *
 * This is the canonical, documented public interface surface (NET-W001 §6).
 * All modules — domain, infrastructure and adapter — import contracts from
 * `@opencon/core` (i.e. this file). Importing a concrete implementation
 * from another tier is an architecture violation enforced by
 * scripts/check-architecture.ts (AC-02, AC-07).
 *
 * See docs/module-conventions.md for the full convention document.
 */

export * from "./errors.ts";
export * from "./execution-context.ts";
export * from "./logger.ts";
export * from "./config.ts";
export * from "./module.ts";
export * from "./queue.ts";
export * from "./audit.ts";
export * from "./object-store.ts";
export * from "./secrets.ts";
export * from "./adapter.ts";
export * from "./domain-module.ts";
// NET-W003 provider-neutral contracts (persistence/coordination/
// idempotency/observability). Infrastructure tier implements these;
// domain tier consumes via infrastructure, never a concrete driver.
export * from "./postgres-authority.ts";
export * from "./coordination.ts";
export * from "./idempotency.ts";
export * from "./trace.ts";
