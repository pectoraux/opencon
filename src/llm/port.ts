/**
 * LLM boundary — provider-neutral AI execution port.
 *
 * Architecture ref: spec/architecture.md §14 (AI architecture),
 * §18 (Module ownership: "/llm, /agents — provider-neutral AI and
 * agent execution").
 *
 * This port is provider-neutral. Callers depend on `LlmPort` (this
 * file) — NEVER on a concrete provider in `src/llm/providers/`. The
 * architecture check enforces this (domain-must-not-import-adapter;
 * AC-07). Concrete provider instantiation and invocation happen at the
 * composition root ONLY.
 *
 * NET-W013 makes the boundary concrete (its designated purpose): the
 * scoring contract below is the provider-neutral quality/safety
 * advisory path. The ECHO provider in `providers/echo-llm-provider.ts`
 * is the deterministic reference adapter (no real AI, no external
 * calls); concrete external providers are adapter-tier extensions.
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
 * A provider-neutral ADVISORY scoring request (NET-W013, AI-004;
 * NET-W016 extends the purpose union with "matching" for AI-002 —
 * the creator-matching advisory path).
 *
 * `neutralFacts` carries RECORD-LEVEL neutral facts (labels + values
 * assembled by the composition root from authoritative records) — never
 * raw user content and never authoritative assertions. `rubricRef`
 * identifies the deterministic rubric the score is being requested
 * against (e.g. a pinned quality-policy version reference).
 */
export interface LlmScoringInput {
  readonly purpose: "content_scoring" | "safety" | "matching";
  readonly rubricRef: string;
  readonly neutralFacts: readonly {
    readonly label: string;
    readonly value: string;
  }[];
}

/**
 * A provider-neutral ADVISORY scoring result. The literal `false` type
 * is retained from the completion contract: AI output is NEVER
 * authoritative. `provider` + `modelRef` identify WHO produced the
 * score (recorded on the advisory record — provider independence means
 * any provider's output enters identically, with identity preserved).
 */
export interface LlmScoringResult {
  readonly score: number;
  readonly provider: string;
  readonly modelRef: string;
  readonly latencyMs: number;
  readonly authoritative: false;
}

/**
 * Provider-neutral LLM port. Concrete adapters implement this AND
 * `ProviderAdapter` (for lifecycle/health).
 */
export interface LlmPort {
  readonly boundary: "llm";
  readonly readiness: "ready";
  complete(input: LlmCompletionInput): Promise<LlmCompletionOutput>;
  /**
   * Produce an ADVISORY score for a neutral-fact set against a rubric
   * (NET-W013). Implementations MUST be deterministic for identical
   * inputs (reproducible advisory evidence) and MUST return a score
   * in [0, 1].
   */
  score(input: LlmScoringInput): Promise<LlmScoringResult>;
}

export interface LlmProviderInfo extends ProviderAdapterInfo {
  readonly kind: "llm";
}
