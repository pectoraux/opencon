import { defineBoundaryModule } from "../core/domain-module.ts";

/**
 * Workflows boundary module.
 *
 * Authority (architecture §17, §18, §19): authoritative lifecycle
 * transitions and orchestration. The SOLE boundary permitted to mutate
 * Opportunity/Contribution lifecycle state (work order §4.1).
 *
 * Concrete behaviour introduced in NET-W004:
 *  - exhaustive transition table (canonical + exceptional states);
 *  - pure state machine evaluator;
 *  - WorkflowService that runs authorized transitions inside the
 *    authoritative transaction established by NET-W003 (idempotent
 *    + optimistic concurrency + audit lineage atomicity).
 *
 * Out of scope (NET-W004 §5): no economic value, reputation, settlement,
 * fraud decision, evidence evaluation or Proof-of-Value. The transition
 * table declares states + preconditions only; later work items
 * (NET-W005..014) attach the downstream semantics.
 */
export const workflowsModule = defineBoundaryModule({
  name: "workflows",
  tier: "domain",
  summary:
    "authoritative lifecycle transitions and orchestration (NET-W004: " +
    "transition table + state machine + WorkflowService; /workflows is the " +
    "sole lifecycle authority)",
});
