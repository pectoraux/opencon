/**
 * POSITIVE fixture — approved pattern: composition-root orchestration.
 *
 * Mirrors src/bootstrap/runtime.ts (NET-W013/W014 composites): the
 * bootstrap boundary is the ONE place where cross-authority
 * orchestration is allowed — it translates moderation outcomes into
 * /disputes risk signals, drives /settlement economic effects, and
 * requests /workflows transitions.
 *
 * /bootstrap is not a domain implementation and is never scanned for
 * authority-mutation rules. The authority guard must report ZERO
 * violations for this file.
 */

import type { TransitionRequest, TransitionResult } from "../core/workflow-contract.ts";

export interface OrchestratedAuthorities {
  readonly riskGateway: {
    readonly createRiskSignal: (input: Record<string, unknown>) => Promise<unknown>;
    readonly createRiskAssessment: (input: Record<string, unknown>) => Promise<unknown>;
  };
  readonly settlement: {
    readonly issueCredits: (input: Record<string, unknown>) => Promise<unknown>;
    readonly allocateRewards: (input: Record<string, unknown>) => Promise<unknown>;
  };
  readonly workflow: {
    readonly requestTransition: (
      request: TransitionRequest,
      execution: unknown,
    ) => Promise<TransitionResult>;
  };
}

export async function translateModerationOutcome(
  authorities: OrchestratedAuthorities,
  subjectId: string,
): Promise<void> {
  await authorities.riskGateway.createRiskSignal({
    subjectKind: "contribution",
    subjectId,
    category: "abuse",
  });
}

export async function recognizeAndReward(
  authorities: OrchestratedAuthorities,
  contributionId: string,
): Promise<void> {
  await authorities.settlement.issueCredits({ contributionId, amount: "10" });
  await authorities.settlement.allocateRewards({ contributionId, basis: "qualifying" });
}

export async function advanceLifecycle(
  authorities: OrchestratedAuthorities,
  subjectId: string,
): Promise<TransitionResult> {
  return authorities.workflow.requestTransition(
    { subjectKind: "contribution", subjectId, from: "SUBMITTED", to: "ACCEPTED" },
    undefined,
  );
}
