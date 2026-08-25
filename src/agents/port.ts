/**
 * Agents boundary — provider-neutral agent execution port.
 *
 * Architecture ref: spec/architecture.md §18 (`/agents`).
 * Agent/model output is input/recommendation only — never directly
 * authoritative (architecture-lock.md §4, §7).
 */

export interface AgentRunInput {
  readonly task: string;
  readonly context?: Readonly<Record<string, unknown>>;
}

export interface AgentRunOutput {
  readonly result: string;
  readonly provider: string;
  readonly authoritative: false;
}

export interface AgentPort {
  readonly boundary: "agents";
  readonly readiness: "skeleton";
  run(input: AgentRunInput): Promise<AgentRunOutput>;
}
