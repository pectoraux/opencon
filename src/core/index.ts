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
// NET-W004 shared lifecycle vocabulary (canonical + exceptional states,
// LifecycleSubject, TransitionRequest/Result, IllegalTransitionError,
// ConcurrentTransitionError). Domain tiers import this to declare their
// lifecycle subject shape; the transition table + state machine live in
// the workflows boundary (the SOLE lifecycle authority).
export * from "./workflow.ts";
// NET-W005 shared evidence vocabulary (standard outcome types OUT-001,
// evidence source types + grades, confidence estimates with uncertainty
// EVID-005, provenance records EVID-002, cryptographic commitments
// EVID-006). The /evidence domain implements the behaviour; later work
// items (/outcomes, /reputation, /settlement) consume the vocabulary.
export * from "./evidence.ts";
// NET-W006 shared measurement vocabulary (attribution modes OUT-002,
// measurement provenance with REQUIRED method/version, maturation
// strategies OUT-005, rollup strategies, experiment statuses OUT-003,
// baseline kinds OUT-004, causal statuses). The /outcomes domain
// implements the behaviour; the neutral /measurement port and later
// work items (/reputation, /settlement, NET-W022 providers) consume
// the vocabulary.
export * from "./measurement.ts";
