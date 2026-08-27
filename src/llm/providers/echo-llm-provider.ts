/**
 * Concrete LLM adapter (ECHO provider) — the deterministic reference
 * implementation of the provider-neutral LlmPort.
 *
 * AC-07: a domain module depends on the provider-neutral `LlmPort`
 * (src/llm/port.ts), NOT on this concrete provider. The architecture
 * check enforces that no domain file imports this module (the
 * domain-must-not-import-adapter rule) — provider instantiation and
 * invocation happen at the composition root ONLY.
 *
 * NET-W013 makes the boundary concrete (its designated purpose): this
 * provider still calls no external LLM, but its `score` implementation
 * is a REAL deterministic function of the scoring input (SHA-256 over
 * the canonical serialization) so advisory quality scores are
 * reproducible in tests and CI without network access. Concrete
 * external providers (OpenAI-style adapters) are adapter-tier
 * extensions of the same neutral port.
 */

import { createHash } from "node:crypto";
import type {
  LlmCompletionInput,
  LlmCompletionOutput,
  LlmPort,
  LlmScoringInput,
  LlmScoringResult,
} from "../port.ts";
import type { ProviderAdapter } from "../../core/adapter.ts";

const ECHO_MODEL_REF = "echo-scoring-v1";

export class EchoLlmProvider implements LlmPort, ProviderAdapter {
  public readonly boundary = "llm" as const;
  public readonly readiness = "ready" as const;
  public readonly info = {
    kind: "llm" as const,
    provider: "echo",
    version: "0.2.0",
  };

  public async initialize(): Promise<void> {
    /* no-op */
  }

  public async healthCheck(): Promise<{ ok: boolean; detail?: string }> {
    return { ok: true, detail: "echo llm always available" };
  }

  public async complete(input: LlmCompletionInput): Promise<LlmCompletionOutput> {
    const start = Date.now();
    return {
      text: `[echo] ${input.prompt}`,
      provider: "echo",
      latencyMs: Date.now() - start,
      authoritative: false,
    };
  }

  /**
   * The deterministic advisory score: SHA-256 over the canonical
   * serialization of {purpose, rubricRef, neutralFacts}, mapped onto
   * [0, 1). Identical inputs always produce identical scores
   * (reproducible advisory evidence); the result is structurally
   * non-authoritative.
   */
  public async score(input: LlmScoringInput): Promise<LlmScoringResult> {
    const start = Date.now();
    const canonical = JSON.stringify({
      purpose: input.purpose,
      rubricRef: input.rubricRef,
      neutralFacts: input.neutralFacts.map((f) => ({
        label: f.label,
        value: f.value,
      })),
    });
    const digest = createHash("sha256").update(canonical, "utf8").digest("hex");
    // First 8 hex chars → a 32-bit unsigned integer → [0, 1).
    const head = Number.parseInt(digest.slice(0, 8), 16);
    const score = head / 0x1_0000_0000;
    return {
      score,
      provider: "echo",
      modelRef: ECHO_MODEL_REF,
      latencyMs: Date.now() - start,
      authoritative: false,
    };
  }
}

export const echoLlmProvider = new EchoLlmProvider();
export { ECHO_MODEL_REF };
