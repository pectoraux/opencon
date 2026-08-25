/**
 * LLM boundary — provider-neutral AI execution port.
 *
 * Architecture ref: spec/architecture.md §14 (AI architecture),
 * §18 (Module ownership: "/llm, /agents — provider-neutral AI and
 * agent execution").
 *
 * This port is provider-neutral. Domain modules that need AI behaviour
 * depend on `LlmPort` (this file) — NEVER on a concrete provider in
 * `src/llm/providers/`. The architecture check enforces this (AC-07).
 *
 * Concrete provider behaviour is deferred (NET-W013). The ECHO provider
 * in `providers/echo-llm-provider.ts` exists only to prove adapter
 * isolation; it does not deliver real AI.
 */

import type { ProviderAdapterInfo } from "../core/adapter.ts";

export interface LlmCompletionInput {
  readonly prompt: string;
  /** Caller-stated purpose for telemetry/audit only — not authoritative. */
  readonly purpose?:
    | "matching"
    | "fraud"
    | "helpfulness"
    | "content_scoring"
    | "safety"
    | "procurement"
    | "other";
}

export interface LlmCompletionOutput {
  readonly text: string;
  readonly provider: string;
  readonly latencyMs: number;
  /**
   * AI output is NEVER authoritative for settlement/reputation
   * (architecture-lock.md §4). Consumers MUST treat this as input
   * evidence/recommendation only.
   */
  readonly authoritative: false;
}

/**
 * Provider-neutral LLM port. Concrete adapters implement this AND
 * `ProviderAdapter` (for lifecycle/health).
 */
export interface LlmPort {
  readonly boundary: "llm";
  readonly readiness: "skeleton";
  complete(input: LlmCompletionInput): Promise<LlmCompletionOutput>;
}

export interface LlmProviderInfo extends ProviderAdapterInfo {
  readonly kind: "llm";
}
