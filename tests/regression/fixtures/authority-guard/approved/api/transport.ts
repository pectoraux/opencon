/**
 * POSITIVE fixture — approved pattern: HTTP transport over the composed
 * command surface.
 *
 * Mirrors src/api/server.ts + src/api/port.ts: the transport layer
 * calls cross-authority commands ONLY through the composition-root
 * command surface (`commands.requestTransition(...)`,
 * `commands.createRiskSignal(...)`, `commands.issueCredits(...)`).
 * /api is not a domain implementation and is never scanned for
 * authority-mutation rules.
 *
 * The authority guard must report ZERO violations for this file.
 */

import type { TransitionRequest } from "../core/workflow-contract.ts";

export interface ComposedCommands {
  readonly requestTransition: (
    execution: unknown,
    personId: string,
    input: TransitionRequest,
  ) => Promise<unknown>;
  readonly createRiskSignal: (
    execution: unknown,
    personId: string,
    input: Record<string, unknown>,
  ) => Promise<unknown>;
  readonly issueCredits: (
    execution: unknown,
    input: Record<string, unknown>,
  ) => Promise<unknown>;
}

export async function handleWorkflowTransition(
  commands: ComposedCommands,
  execution: unknown,
  personId: string,
  input: TransitionRequest,
): Promise<unknown> {
  return commands.requestTransition(execution, personId, input);
}

export async function handleRiskSignal(
  commands: ComposedCommands,
  execution: unknown,
  personId: string,
  input: Record<string, unknown>,
): Promise<unknown> {
  return commands.createRiskSignal(execution, personId, input);
}

export async function handleCreditIssue(
  commands: ComposedCommands,
  execution: unknown,
  input: Record<string, unknown>,
): Promise<unknown> {
  return commands.issueCredits(execution, input);
}
