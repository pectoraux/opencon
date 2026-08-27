/**
 * POSITIVE fixture — approved pattern: workflow DELEGATION from a domain.
 *
 * Mirrors src/evidence/proof-of-value-service.ts (NET-W005): the domain
 * validates preconditions and REQUESTS lifecycle movement through the
 * provider-neutral `requestTransition` callback; the shared
 * `TransitionRequest` contract type comes from /core.
 *
 * Original false-positive class: referencing the `TransitionRequest`
 * vocabulary type and delegating via `requestTransition` is NOT local
 * workflow authority. The authority guard must report ZERO violations
 * for this file.
 */

import type { TransitionRequest, TransitionResult } from "../core/workflow-contract.ts";

export interface WorkflowDelegation {
  readonly requestTransition: (
    request: TransitionRequest,
    execution: unknown,
  ) => Promise<TransitionResult>;
}

export async function evaluateThroughWorkflowAuthority(
  workflow: WorkflowDelegation,
  subjectId: string,
): Promise<TransitionResult> {
  const request: TransitionRequest = {
    subjectKind: "proof_of_value",
    subjectId,
    from: "MEASURING",
    to: "EVALUATING",
  };
  return workflow.requestTransition(request, undefined);
}
