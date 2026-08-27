/**
 * POSITIVE fixture — approved pattern: workflow DELEGATION from a domain.
 *
 * Mirrors src/outcomes/measured-outcome-service.ts (NET-W006): a domain
 * service that needs lifecycle movement REQUESTS the transition through
 * the provider-neutral `requestTransition` callback injected at the
 * composition root, and references the shared `TransitionRequest`
 * CONTRACT TYPE from /core.
 *
 * This file was one of the original false-positive classes (the guard
 * must NOT match generic identifiers such as `TransitionRequest`, and
 * must NOT treat the sanctioned `requestTransition` delegation callback
 * as local workflow authority). The authority guard must report ZERO
 * violations for this file.
 */

import type { TransitionRequest, TransitionResult } from "../core/workflow-contract.ts";

export interface WorkflowDelegation {
  readonly requestTransition: (
    request: TransitionRequest,
    execution: unknown,
  ) => Promise<TransitionResult>;
}

export async function finalizeThroughWorkflowAuthority(
  workflow: WorkflowDelegation,
  targetState: TransitionRequest["to"],
  subjectId: string,
): Promise<TransitionResult> {
  const request: TransitionRequest = {
    subjectKind: "measured_outcome",
    subjectId,
    from: "MEASURING",
    to: targetState,
  };
  return workflow.requestTransition(request, undefined);
}
