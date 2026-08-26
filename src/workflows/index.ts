export * from "./port.ts";
export * from "./module.ts";
// NET-W004: the authoritative lifecycle authority. The transition table
// is data (the canonical legal-transition matrix); the state machine is
// a pure evaluator; the workflow service is the only entry point that
// mutates lifecycle state. Domain services (opportunities, contributions)
// route transitions through the workflow service rather than mutating
// state directly.
export * from "./transition-table.ts";
export * from "./state-machine.ts";
export * from "./workflow-service.ts";
export * from "./lifecycle-repository.ts";
