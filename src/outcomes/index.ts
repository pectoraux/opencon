/**
 * Outcomes boundary public surface (barrel).
 *
 * NET-W006 promotes the outcomes boundary from "skeleton" to "ready":
 * first-class immutable/append-corrected outcome observations linked
 * to NET-W005 Outcome Claims and Evidence, distinct
 * deterministic/probabilistic/experimental attribution representation
 * with preserved method/version/uncertainty, experiments/holdouts and
 * incrementality with DERIVED causal status, explicit
 * counterfactual/baselines, provider-neutral measurement ingestion,
 * and the measured-outcome maturation lifecycle whose transitions
 * route through /workflows (the SOLE lifecycle authority).
 *
 * Measurement ≠ economic truth: this boundary establishes outcomes and
 * their uncertainty; credits, settlement, reputation and pricing are
 * later work items (NET-W007+).
 */

export * from "./port.ts";
export * from "./module.ts";
export * from "./observation-chains.ts";
export * from "./measurement-rollup.ts";
export * from "./authority-outcome-observation-repository.ts";
export * from "./observation-service.ts";
export * from "./authority-measurement-experiment-repository.ts";
export * from "./experiment-service.ts";
export * from "./authority-attribution-repository.ts";
export * from "./attribution-service.ts";
export * from "./authority-incrementality-repository.ts";
export * from "./incrementality-service.ts";
export * from "./authority-baseline-repository.ts";
export * from "./baseline-service.ts";
export * from "./authority-measured-outcome-repository.ts";
export * from "./measured-outcome-service.ts";
