/**
 * NEGATIVE fixture — must be REJECTED: local workflow authority.
 *
 * A domain implementation (here: /inventory) re-implementing operational
 * lifecycle machinery — defining its own transition primitives and a
 * local WorkflowService — instead of delegating through the provider-
 * neutral requestTransition callback. Operational lifecycle belongs to
 * /workflows alone.
 *
 * Expected violations: workflow-authority-mutation (transitionWorkflow,
 * performTransition, and the local WorkflowService machinery).
 */

export interface LocalTransition {
  readonly subjectId: string;
  readonly to: string;
}

export async function transitionWorkflow(request: LocalTransition): Promise<void> {
  void request;
}

export async function performTransition(request: LocalTransition): Promise<void> {
  await transitionWorkflow(request);
}

export class WorkflowService {
  async run(request: LocalTransition): Promise<void> {
    await performTransition(request);
  }
}
