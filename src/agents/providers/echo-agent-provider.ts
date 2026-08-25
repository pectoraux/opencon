/**
 * Concrete agent adapter (ECHO) — demonstrates agent isolation.
 * Domain code depends on `AgentPort`, never this concrete provider.
 */

import type { AgentPort, AgentRunInput, AgentRunOutput } from "../port.ts";
import type { ProviderAdapter } from "../../core/adapter.ts";

export class EchoAgentProvider implements AgentPort, ProviderAdapter {
  public readonly boundary = "agents" as const;
  public readonly readiness = "skeleton" as const;
  public readonly info = {
    kind: "agent" as const,
    provider: "echo",
    version: "0.1.0",
  };

  public async initialize(): Promise<void> {}
  public async healthCheck(): Promise<{ ok: boolean; detail?: string }> {
    return { ok: true };
  }
  public async run(input: AgentRunInput): Promise<AgentRunOutput> {
    return { result: `[echo-agent] ${input.task}`, provider: "echo", authoritative: false };
  }
}

export const echoAgentProvider = new EchoAgentProvider();
