/**
 * Evidence boundary public surface (barrel).
 *
 * NET-W005 promotes the evidence boundary from "skeleton" to "ready":
 * evidence records with deterministic grades + confidence/uncertainty,
 * provider-neutral outcome claims, verifier-neutral attestations,
 * cryptographic commitments for sensitive material, deterministic
 * aggregation, and the Proof-of-Value model whose lifecycle
 * transitions route through /workflows (the SOLE lifecycle authority).
 */

export * from "./port.ts";
export * from "./module.ts";
export * from "./grade-rules.ts";
export * from "./commitments.ts";
export * from "./aggregation.ts";
export * from "./authority-evidence-repository.ts";
export * from "./evidence-service.ts";
export * from "./authority-outcome-claim-repository.ts";
export * from "./outcome-claim-service.ts";
export * from "./authority-attestation-repository.ts";
export * from "./attestation-service.ts";
export * from "./authority-proof-of-value-repository.ts";
export * from "./proof-of-value-service.ts";
export * from "./hmac-attestation-verifier.ts";
// NET-W029 — cryptographic attestations and commitments (issue #58).
export * from "./signed-attestation-input.ts";
export * from "./signed-attestation-service.ts";
export * from "./authority-signed-attestation-repository.ts";
