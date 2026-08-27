/**
 * POSITIVE fixture — approved pattern: the workflow authority itself.
 *
 * Mirrors src/workflows/workflow-service.ts: /workflows is the ONLY
 * operational lifecycle authority and therefore the only place where
 * `performTransition` / `transitionWorkflow` / the WorkflowService
 * machinery may exist. The owner is exempt from its own reserved
 * mutation primitives.
 *
 * The authority guard must report ZERO violations for this file.
 */

import type { TransitionRequest, TransitionResult } from "../core/workflow-contract.ts";

export async function performTransition(request: TransitionRequest): Promise<TransitionResult> {
  return { ok: true, from: request.from, to: request.to };
}

export class WorkflowService {
  async transitionWorkflow(request: TransitionRequest): Promise<TransitionResult> {
    return performTransition(request);
  }
}
