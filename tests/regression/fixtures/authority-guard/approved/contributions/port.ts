/**
 * POSITIVE fixture — approved pattern: provider-neutral PORT contract.
 *
 * Mirrors src/contributions/port.ts (and the evidence/outcome ports):
 * port files declare the neutral callback contracts a domain consumes.
 * Port/module/index files are contracts and wiring, not semantic
 * implementation — the authority guard excludes them by design.
 *
 * The authority guard must report ZERO violations for this file.
 */

import type { TransitionRequest, TransitionResult } from "../core/workflow-contract.ts";

/**
 * The neutral delegation surface: domains REQUEST lifecycle movement;
 * the composition root injects the /workflows authority behind it.
 */
export interface WorkflowLifecycleCallback {
  readonly requestTransition: (
    request: TransitionRequest,
    execution: unknown,
  ) => Promise<TransitionResult>;
}
