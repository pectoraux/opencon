/**
 * Outcomes boundary — declared public interface (port).
 *
 * Architecture ref: spec/architecture.md §18 (Module ownership),
 * §13 (Measurement architecture).
 * Authority: outcome evaluation and measurement semantics.
 *
 * NET-W001 ships the boundary and contract ONLY. Concrete behaviour is
 * deferred to NET-W006.
 *
 * AC-07 demonstration: this domain port declares a provider-neutral
 * dependency on `LlmPort` (src/llm/port.ts) — a *provider-neutral
 * adapter interface*. The domain imports the neutral port only; it
 * NEVER imports a concrete provider from `src/llm/providers/`. The
 * architecture check enforces this. AI output consumed here is
 * non-authoritative (architecture-lock.md §4).
 */

import type { LlmPort } from "../llm/port.ts";

export interface OutcomesPort {
  readonly boundary: "outcomes";
  readonly readiness: "skeleton";
  /**
   * Provider-neutral AI dependency (deferred). The concrete provider is
   * injected at the composition root; this domain never imports it.
   */
  readonly llm?: LlmPort;
}
