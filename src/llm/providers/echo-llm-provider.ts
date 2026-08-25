/**
 * Concrete LLM adapter (ECHO provider) — demonstrates adapter isolation.
 *
 * AC-07: a domain module depends on the provider-neutral `LlmPort`
 * (src/llm/port.ts), NOT on this concrete provider. The architecture
 * check enforces that no domain file imports this module.
 *
 * This provider does not call any external LLM; it echoes its input.
 * It exists to prove adapter isolation, NOT to deliver AI behaviour
 * (deferred to NET-W013).
 */

import type { LlmCompletionInput, LlmCompletionOutput, LlmPort } from "../port.ts";
import type { ProviderAdapter } from "../../core/adapter.ts";

export class EchoLlmProvider implements LlmPort, ProviderAdapter {
  public readonly boundary = "llm" as const;
  public readonly readiness = "skeleton" as const;
  public readonly info = {
    kind: "llm" as const,
    provider: "echo",
    version: "0.1.0",
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
}

export const echoLlmProvider = new EchoLlmProvider();
