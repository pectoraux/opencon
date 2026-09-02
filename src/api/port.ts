/**
 * Api boundary — declared public interface (port).
 *
 * Architecture ref: spec/architecture.md §18 (Module ownership): `/api`
 *   authority: "external application/API contract" (versioned,
 *   provider-independent).
 * Architecture ref: spec/architecture-lock.md §2 (infrastructure boundary).
 *
 * Work order ref: spec/work-orders/NET-W002.md
 *   §4.6 API integration: "Add the minimum API middleware/guarding needed
 *      to demonstrate that protected operations cannot be executed by an
 *      unauthenticated or unauthorized principal. Use the execution/
 *      correlation context established by NET-W001 to carry actor/subject
 *      identity where available."
 *   §4.5 Authorization: server-side authorization enforced at the server
 *      boundary; client-provided role/scope claims not trusted.
 *
 * CROSS-BOUNDARY NOTE: the `/api` boundary is infrastructure tier. The
 * tier allow matrix (scripts/lib/architecture.ts) PROHIBITS infrastructure
 * → domain imports. The API server therefore CANNOT import the identity
 * or participants domain ports directly. Instead this port declares a
 * minimal {@link ApiAuth} interface that the API server consumes; the
 * bootstrap composition root wires a thin adapter that delegates to the
 * real `PrincipalResolver` (identity) and `AuthorizationService`
 * (participants). Dependency inversion at the composition root.
 *
 * The {@link ApiAuth} interface deliberately uses only primitive shapes
 * (strings + a decision union) so it carries no domain DTO coupling. The
 * adapter in bootstrap translates between these primitives and the domain
 * DTOs (ResolvedPrincipal, AuthorizationDecision, PersonIdentity).
 */

import type { ExecutionContext } from "../core/execution-context.ts";
// NET-W023: the neutral adapters-boundary evaluation contract (the
// /api tier is infrastructure — it may import NEUTRAL ports only,
// never the adapter tier; the composition root wires the join).
import type {
  ExternalAdRequestEvaluation,
  SellerAuthorizationIntegrityBlock,
} from "../adapters/port.ts";

/**
 * The ApiPort describes the boundary's readiness. After NET-W002 it is
 * `"ready"` (the boundary now carries protected endpoints + auth guard).
 */
export interface ApiPort {
  readonly boundary: "api";
  readonly readiness: "ready";
}

/**
 * An opaque auth subject extracted from the request (e.g. from headers).
 * Carries NO credential material — only the resolved subject id + provider
 * kind + any client-asserted claims. Client claims are NEVER trusted for
 * authorization (§4.5, API-AC-02); they are carried only so they can be
 * logged/audited when a forged claim is rejected.
 */
export interface ApiAuthSubject {
  readonly subjectId: string;
  readonly providerKind: string;
  readonly clientClaims?: Readonly<Record<string, unknown>>;
}

/**
 * The result of resolving an auth subject into a canonical person identity.
 * `personId` is null when the subject is not linked to any canonical
 * identity (unauthenticated).
 */
export interface ApiResolvedPrincipal {
  readonly personId: string | null;
}

/**
 * The authorization decision returned by the API auth guard. Deny-by-
 * default: any protected mutation not matched by an allow policy is
 * denied (§4.5, API-AC-02).
 */
export interface ApiAuthDecision {
  readonly decision: "allow" | "deny";
  readonly reason: string;
  readonly matchedPolicyId: string | null;
}

/**
 * Inputs to an API authorization check.
 */
export interface ApiAuthorizeRequest {
  readonly execution: ExecutionContext;
  readonly personId: string | null;
  readonly action: string;
  readonly resource: string;
  readonly clientClaims?: Readonly<Record<string, unknown>>;
}

/**
 * ApiAuth — the minimal auth surface the API server consumes. The
 * bootstrap composition root wires a thin adapter that delegates to the
 * real identity PrincipalResolver + participants AuthorizationService.
 */
export interface ApiAuth {
  /** Resolve an auth subject into a canonical person id (server-side). */
  resolvePrincipal(subject: ApiAuthSubject): Promise<ApiResolvedPrincipal>;
  /** Authorize a protected mutation (deny-by-default). */
  authorize(request: ApiAuthorizeRequest): Promise<ApiAuthDecision>;
}

/** The public view of an identity returned by public read endpoints. */
export interface ApiPublicIdentityView {
  readonly id: string;
  readonly displayName: string;
}

/** The public view of an organization returned by endpoints. */
export interface ApiOrganizationView {
  readonly id: string;
  readonly name: string;
  readonly createdBy: string;
  readonly createdAt: string;
}

/** Inputs to create an organization via the API. */
export interface ApiCreateOrganizationInput {
  readonly name: string;
}

/** The membership view returned by the API. */
export interface ApiMembershipView {
  readonly id: string;
  readonly personId: string;
  readonly organizationId: string;
  readonly status: "active" | "revoked";
  readonly grantedAt: string;
  readonly grantedBy: string;
  readonly revokedAt: string | null;
  readonly revokedBy: string | null;
}

/** Inputs to grant a membership via the API. */
export interface ApiGrantMembershipInput {
  readonly personId: string;
}

// -- NET-W004 opportunity/contribution/transition views + inputs ----

/** The public view of an opportunity (NET-W004 AC-01). */
export interface ApiOpportunityView {
  readonly id: string;
  readonly organizationScopeId: string;
  readonly ownerId: string;
  readonly opportunityType: string;
  readonly title: string;
  readonly state: string;
  readonly version: number;
  readonly createdAt: string;
}

/** The detailed opportunity view (includes brief + policy references). */
export interface ApiOpportunityDetailView extends ApiOpportunityView {
  readonly brief: Readonly<Record<string, unknown>>;
  readonly eligibilityPolicyReference: string | null;
  readonly contributionRequirements: Readonly<Record<string, unknown>>;
  readonly evidenceReferencePlaceholders: readonly string[];
  readonly updatedAt: string;
}

/** Inputs to create an opportunity via the API (NET-W004 AC-01). */
export interface ApiCreateOpportunityInput {
  readonly organizationScopeId: string;
  readonly opportunityType: string;
  readonly title: string;
  readonly brief?: Readonly<Record<string, unknown>>;
  readonly eligibilityPolicyReference?: string | null;
  readonly contributionRequirements?: Readonly<Record<string, unknown>>;
  readonly evidenceReferencePlaceholders?: readonly string[];
}

/** The public view of a contribution (NET-W004 AC-02). */
export interface ApiContributionView {
  readonly id: string;
  readonly opportunityId: string;
  readonly contributorId: string;
  readonly organizationScopeId: string;
  readonly contributionType: string;
  readonly submission: Readonly<Record<string, unknown>>;
  readonly state: string;
  readonly version: number;
  readonly createdAt: string;
}

/** The detailed contribution view. */
export interface ApiContributionDetailView extends ApiContributionView {
  readonly evidenceReferencePlaceholders: readonly string[];
  readonly updatedAt: string;
}

/** Inputs to create a contribution via the API (NET-W004 AC-02). */
export interface ApiCreateContributionInput {
  readonly opportunityId: string;
  readonly organizationScopeId: string;
  readonly contributionType: string;
  readonly submission?: Readonly<Record<string, unknown>>;
  readonly evidenceReferencePlaceholders?: readonly string[];
}

/**
 * Inputs to request an authorized lifecycle transition via the API
 * (NET-W004 §3.4, §4.4). Material mutation operations must be idempotent
 * where duplicate delivery/retry is possible and must return stable
 * identifiers plus execution references.
 */
export interface ApiRequestTransitionInput {
  readonly subjectId: string;
  readonly subjectKind:
    | "opportunity"
    | "contribution"
    | "proof_of_value"
    | "outcome_measurement"
    | "engagement"
    | "publication";
  readonly targetState: string;
  readonly expectedVersion: number;
  readonly idempotencyKey: string;
  readonly policyAction: string;
  readonly metadata?: Readonly<Record<string, unknown>>;
}

/** The result of an authorized lifecycle transition. */
export interface ApiTransitionResultView {
  readonly subjectId: string;
  readonly subjectKind: string;
  readonly state: string;
  readonly version: number;
  readonly executed: boolean;
  readonly transitionId: string;
  readonly recordId: string;
  readonly auditEventName: string;
  readonly executionId: string;
  readonly correlationId: string;
  readonly causationId: string | null;
  readonly transactionId: string;
}

// -- NET-W005 evidence/proof-of-value views + inputs ----------------

/**
 * The public view of an evidence record (NET-W005 AC-01). For
 * sensitive evidence the view carries the commitment + reference
 * ONLY — the raw material is never stored, so it can never be
 * returned (architecture-lock §6).
 */
export interface ApiEvidenceView {
  readonly id: string;
  readonly organizationScopeId: string;
  readonly ownerId: string;
  readonly subjectReference: { readonly subjectId: string; readonly subjectType: string };
  readonly provenance: Readonly<Record<string, unknown>>;
  readonly grade: string;
  readonly confidence: Readonly<Record<string, unknown>>;
  readonly sensitivity: string;
  readonly payload: Readonly<Record<string, unknown>> | null;
  readonly commitment: Readonly<Record<string, unknown>> | null;
  readonly payloadReference: string | null;
  readonly createdAt: string;
}

/** Inputs to create evidence via the API (NET-W005 §3.1). */
export interface ApiCreateEvidenceInput {
  readonly organizationScopeId: string;
  readonly subjectReference: { readonly subjectId: string; readonly subjectType: string };
  readonly provenance: {
    readonly sourceType: string;
    readonly sourceId?: string;
    readonly method: string;
    readonly collectedAt?: string;
    readonly collectorId?: string;
  };
  readonly confidence: Readonly<Record<string, unknown>>;
  readonly sensitivity?: string;
  readonly payload?: Readonly<Record<string, unknown>>;
  readonly sensitivePayload?: string;
  readonly commitment?: Readonly<Record<string, unknown>>;
  readonly payloadReference?: string;
}

/** The result of a commitment verification (NET-W005 AC-05). */
export interface ApiCommitmentVerificationView {
  readonly evidenceId: string;
  readonly valid: boolean;
  readonly reason: string;
}

/** The public view of an outcome claim (NET-W005 AC-03). */
export interface ApiOutcomeClaimView {
  readonly id: string;
  readonly organizationScopeId: string;
  readonly claimantId: string;
  readonly subjectReference: { readonly subjectId: string; readonly subjectType: string };
  readonly outcomeType: string;
  readonly claimedValue: { readonly value: number; readonly unit: string };
  readonly confidence: Readonly<Record<string, unknown>>;
  readonly evidenceIds: readonly string[];
  readonly statement: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly version: number;
}

/** Inputs to create an outcome claim via the API (NET-W005 §3.4). */
export interface ApiCreateOutcomeClaimInput {
  readonly organizationScopeId: string;
  readonly subjectReference: { readonly subjectId: string; readonly subjectType: string };
  readonly outcomeType: string;
  readonly claimedValue: { readonly value: number; readonly unit: string };
  readonly confidence: Readonly<Record<string, unknown>>;
  readonly evidenceIds?: readonly string[];
  readonly statement?: string;
}

/** The public view of an attestation (NET-W005 AC-05). */
export interface ApiAttestationView {
  readonly id: string;
  readonly organizationScopeId: string;
  readonly verifierId: string;
  readonly statement: string;
  readonly evidenceIds: readonly string[];
  readonly algorithm: string;
  readonly signature: string;
  readonly signedAt: string;
  readonly createdAt: string;
}

/** Inputs to create an attestation via the API (NET-W005 §3.5). */
export interface ApiCreateAttestationInput {
  readonly organizationScopeId: string;
  readonly verifierId: string;
  readonly statement: string;
  readonly evidenceIds: readonly string[];
}

/** The result of an attestation verification (NET-W005 AC-05). */
export interface ApiAttestationVerificationView {
  readonly attestationId: string;
  readonly valid: boolean;
  readonly reason: string;
}

// ---------------------------------------------------------------------
// NET-W029 — signed attestations (cryptographic attestations and
// commitments, issue #58). The /evidence boundary EXTENDED: production
// signed attestations with closed, versioned algorithm + key-reference
// vocabularies over the three authoritative coverage families.
// ---------------------------------------------------------------------

/** One covered record on a signed attestation (public view). */
export interface ApiSignedAttestationCoverageView {
  readonly family: string;
  readonly recordId: string;
  readonly commitment: Readonly<Record<string, unknown>>;
}

/** The public view of a signed attestation (NET-W029). */
export interface ApiSignedAttestationView {
  readonly id: string;
  readonly organizationScopeId: string;
  readonly verifierId: string;
  readonly statement: string;
  readonly coverage: readonly ApiSignedAttestationCoverageView[];
  readonly algorithm: string;
  readonly keyReference: string;
  readonly signature: string;
  readonly signedAt: string;
  readonly revokedAt: string | null;
  readonly revocationReason: string | null;
  readonly createdAt: string;
  readonly recordFormat: string;
}

/** Inputs to create a signed attestation via the API (NET-W029). */
export interface ApiCreateSignedAttestationInput {
  readonly organizationScopeId: string;
  readonly verifierId: string;
  readonly statement: string;
  readonly coverage: readonly { readonly family: string; readonly recordId: string }[];
  readonly idempotencyKey: string;
}

/** One machine-readable verification check outcome (NET-W029). */
export interface ApiSignedAttestationCheckView {
  readonly check: string;
  readonly subject: string | null;
  readonly passed: boolean;
  readonly reason: string;
}

/** The deterministic verification verdict for a signed attestation (NET-W029). */
export interface ApiSignedAttestationVerificationView {
  readonly attestationId: string;
  readonly valid: boolean;
  readonly reason: string;
  readonly checks: readonly ApiSignedAttestationCheckView[];
}

/** Inputs to revoke a signed attestation via the API (NET-W029; ONE-WAY). */
export interface ApiRevokeSignedAttestationInput {
  readonly organizationScopeId: string;
  readonly reason: string;
  readonly idempotencyKey: string;
}

// ---------------------------------------------------------------------
// NET-W030 — external settlement adapters (issue #61). The /settlement
// boundary EXTENDED: external settlement transactions arrive as
// AUTHENTICATED, IDEMPOTENT, append-only FACTS (provider-reported, never
// authority) with the DERIVED deterministic reconciliation (matched /
// pending / mismatched — machine-readable reasons, never auto-corrected).
// ---------------------------------------------------------------------

/** The public view of a recorded external settlement transaction fact (NET-W030). */
export interface ApiExternalSettlementFactView {
  readonly id: string;
  readonly organizationScopeId: string;
  readonly provider: string;
  readonly providerVersion: string;
  readonly externalId: string;
  readonly internalTransactionId: string;
  /** AS REPORTED by the provider — a transaction fact, never authority. */
  readonly reportedAmount: number;
  readonly reportedUnit: string;
  readonly observedAt: string;
  readonly recordedAt: string;
  /** Append-only correction linkage (the corrected fact's id). */
  readonly correctionOf: string | null;
  readonly idempotencyKey: string;
  readonly recordFormat: string;
}

/** Inputs to ingest an external settlement transaction fact (NET-W030). */
export interface ApiRecordExternalSettlementFactInput {
  readonly organizationScopeId: string;
  /** The delivering provider (closed vocabulary — adapter routing). */
  readonly provider: string;
  /** The raw provider notification payload (opaque to the transport). */
  readonly payload: Readonly<Record<string, unknown>>;
  readonly idempotencyKey: string;
}

/** The result of an ingestion (the recorded fact + the derived reconciliation). */
export interface ApiRecordExternalSettlementFactResult {
  readonly fact: ApiExternalSettlementFactView;
  /** false when the identity replayed the committed record. */
  readonly created: boolean;
  readonly reconciliation: ApiExternalSettlementReconciliationView;
}

/** One machine-readable reconciliation check outcome (NET-W030). */
export interface ApiExternalSettlementReconciliationCheckView {
  readonly check: string;
  readonly satisfied: boolean;
  readonly reason: string;
  readonly detail: Readonly<Record<string, unknown>>;
}

/**
 * The DERIVED deterministic reconciliation verdict for one fact
 * (NET-W030): matched / pending / mismatched with machine-readable
 * reasons; re-derived from the CURRENT authoritative ledger lineage on
 * every evaluation — never stored, never auto-corrected.
 */
export interface ApiExternalSettlementReconciliationView {
  readonly factId: string;
  readonly organizationScopeId: string;
  readonly provider: string;
  readonly externalId: string;
  readonly internalTransactionId: string;
  readonly verdict: "matched" | "pending" | "mismatched";
  readonly reason: string;
  readonly checks: readonly ApiExternalSettlementReconciliationCheckView[];
  readonly internalTransaction: {
    readonly id: string;
    readonly kind: string;
    readonly recordedAt: string;
    /** The derived per-unit debit total of the referenced transaction. */
    readonly unitAmount: number;
  } | null;
  readonly derivedAt: string;
}

/** The public view of a proof of value (NET-W005 AC-06). */
export interface ApiProofOfValueView {
  readonly id: string;
  readonly organizationScopeId: string;
  readonly ownerId: string;
  readonly subjectReference: { readonly subjectId: string; readonly subjectType: string };
  readonly outcomeClaimIds: readonly string[];
  readonly evidenceIds: readonly string[];
  readonly attestationIds: readonly string[];
  readonly state: string;
  readonly version: number;
  readonly createdAt: string;
  readonly updatedAt: string;
}

/** The detailed proof-of-value view (includes the aggregation). */
export interface ApiProofOfValueDetailView extends ApiProofOfValueView {
  readonly aggregation: Readonly<Record<string, unknown>> | null;
}

/** Inputs to create a proof of value via the API (NET-W005 §3.8). */
export interface ApiCreateProofOfValueInput {
  readonly organizationScopeId: string;
  readonly subjectReference: { readonly subjectId: string; readonly subjectType: string };
  readonly outcomeClaimIds?: readonly string[];
  readonly evidenceIds?: readonly string[];
}

// -- NET-W006 outcomes/measurement views + inputs --------------------

/** The public view of an outcome observation (NET-W006 AC-01). */
export interface ApiOutcomeObservationView {
  readonly id: string;
  readonly organizationScopeId: string;
  readonly observerId: string;
  readonly subjectReference: { readonly subjectId: string; readonly subjectType: string };
  readonly outcomeType: string;
  readonly outcomeClaimId: string | null;
  readonly evidenceId: string | null;
  readonly observedValue: { readonly value: number; readonly unit: string };
  readonly confidence: Readonly<Record<string, unknown>>;
  readonly provenance: Readonly<Record<string, unknown>>;
  readonly correctsObservationId: string | null;
  readonly providerAttributionMode: string | null;
  readonly externalSubjectRef: string | null;
  readonly createdAt: string;
}

/** Inputs to create an outcome observation via the API (§3.1). */
export interface ApiCreateOutcomeObservationInput {
  readonly organizationScopeId: string;
  readonly subjectReference: { readonly subjectId: string; readonly subjectType: string };
  readonly outcomeType: string;
  readonly outcomeClaimId?: string;
  readonly evidenceId?: string;
  readonly observedValue: { readonly value: number; readonly unit: string };
  readonly confidence: Readonly<Record<string, unknown>>;
  readonly provenance: Readonly<Record<string, unknown>>;
}

/** The result of a provider ingestion pass (NET-W006 AC-07). */
export interface ApiProviderIngestionResultView {
  readonly providerId: string;
  readonly createdObservations: readonly ApiOutcomeObservationView[];
}

/**
 * Inputs to submit ONE raw provider attribution report through the
 * measurement adapter boundary (NET-W022, ADAPTER-003..004). The
 * `report` field is the RAW vendor-shaped payload — OPAQUE at the API
 * tier; only the provider's adapter (selected by `providerId`)
 * interprets it. The observer is the server-resolved authenticated
 * actor.
 */
export interface ApiSubmitMeasurementReportInput {
  readonly organizationScopeId: string;
  readonly subjectReference: { readonly subjectId: string; readonly subjectType: string };
  readonly idempotencyKey: string;
  readonly providerId: string;
  /** The raw vendor report payload (untyped passthrough to the adapter). */
  readonly report: unknown;
}

/**
 * The result of a pushed measurement report submission (NET-W022):
 * the persisted provider-sourced observation + the normalization
 * provenance (provider id/version + the NAMES of the privacy-redacted
 * vendor fields — never values). `created` is false on a
 * deterministic idempotent replay.
 */
export interface ApiMeasurementReportSubmissionView {
  readonly providerId: string;
  readonly providerVersion: string;
  readonly redactedFieldNames: readonly string[];
  readonly created: boolean;
  readonly observation: ApiOutcomeObservationView;
}

/**
 * Inputs to submit ONE raw seller-authorization file alongside an
 * external ad-request evaluation (NET-W023). The `content` is the raw
 * file text (ads.txt / app-ads.txt / sellers.json) — opaque at the API
 * tier; only the provider's adapter interprets it. `sourceIdentity`
 * declares whose authorization surface the file is; `observedAt` is
 * the observation time (the staleness evaluation input). `integrity`
 * is the OPTIONAL trust envelope (PR #47 remediation): submissions
 * without a valid envelope still normalize but can never support a
 * `verified` supply chain (grammar-valid fabricated content caps at
 * `supply_chain_unauthenticated`).
 */
export interface ApiSellerAuthorizationSubmissionInput {
  readonly providerId: string;
  readonly sourceKind: "ads.txt" | "app-ads.txt" | "sellers.json";
  readonly content: string;
  readonly sourceIdentity: string;
  readonly observedAt?: string;
  readonly integrity?: SellerAuthorizationIntegrityBlock;
}

/**
 * Inputs to evaluate ONE external ad request (NET-W023). The
 * `request` field is the RAW vendor-shaped bid-request payload —
 * OPAQUE at the API tier; only the provider's adapter (selected by
 * `providerId`) interprets it. The evaluation is a read-only
 * derivation against registered supply.
 */
export interface ApiEvaluateExternalAdRequestInput {
  readonly organizationScopeId: string;
  readonly providerId: string;
  readonly request: unknown;
  readonly sellerAuthorizations?: readonly ApiSellerAuthorizationSubmissionInput[];
  readonly evaluatedAt?: string;
}

/**
 * The result of an external ad-request evaluation (NET-W023): the
 * neutral admission decision (supply-side only — it authorizes
 * nothing), the normalized request facts, the resolved registered
 * supply, the supply-chain verification status, and the NAMES of the
 * privacy-redacted vendor fields (never values).
 */
export type ApiExternalAdRequestEvaluationView = ExternalAdRequestEvaluation;

/** The public view of a measurement experiment (NET-W006 AC-03). */
export interface ApiMeasurementExperimentView {
  readonly id: string;
  readonly organizationScopeId: string;
  readonly ownerId: string;
  readonly experimentType: string;
  readonly hypothesis: string | null;
  readonly status: string;
  readonly startedAt: string | null;
  readonly completedAt: string | null;
  readonly invalidatedAt: string | null;
  readonly invalidationReason: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly version: number;
}

/** Inputs to create a measurement experiment via the API (§3.3). */
export interface ApiCreateMeasurementExperimentInput {
  readonly organizationScopeId: string;
  readonly experimentType: string;
  readonly hypothesis?: string;
}

/** Inputs to an experiment status change via the API. */
export interface ApiExperimentStatusChangeInput {
  readonly expectedVersion: number;
  readonly reason?: string;
}

/** The public view of an attribution record (NET-W006 AC-02). */
export interface ApiAttributionView {
  readonly id: string;
  readonly organizationScopeId: string;
  readonly observationId: string;
  readonly attributedSubject: { readonly subjectId: string; readonly subjectType: string };
  readonly mode: string;
  readonly attributionValue: { readonly value: number; readonly unit: string };
  readonly confidence: Readonly<Record<string, unknown>>;
  readonly provenance: Readonly<Record<string, unknown>>;
  readonly deterministicLink: Readonly<Record<string, unknown>> | null;
  readonly experimentId: string | null;
  readonly evidenceIds: readonly string[];
  readonly createdAt: string;
}

/** Inputs to create an attribution via the API (§3.2). */
export interface ApiCreateAttributionInput {
  readonly organizationScopeId: string;
  readonly observationId: string;
  readonly attributedSubject: { readonly subjectId: string; readonly subjectType: string };
  readonly mode: string;
  readonly attributionValue: { readonly value: number; readonly unit: string };
  readonly confidence: Readonly<Record<string, unknown>>;
  readonly provenance: Readonly<Record<string, unknown>>;
  readonly deterministicLink?: { readonly linkType: string; readonly linkIdentifier: string };
  readonly experimentId?: string;
  readonly evidenceIds?: readonly string[];
}

/** The public view of an incrementality observation (NET-W006 AC-03). */
export interface ApiIncrementalityObservationView {
  readonly id: string;
  readonly organizationScopeId: string;
  readonly ownerId: string;
  readonly subjectReference: { readonly subjectId: string; readonly subjectType: string };
  readonly outcomeType: string;
  readonly lift: { readonly value: number; readonly unit: string };
  readonly baselineValue: { readonly value: number; readonly unit: string };
  readonly confidence: Readonly<Record<string, unknown>>;
  readonly provenance: Readonly<Record<string, unknown>>;
  readonly experimentId: string | null;
  readonly causalStatus: string;
  readonly evidenceIds: readonly string[];
  readonly createdAt: string;
}

/** Inputs to create an incrementality observation via the API (§3.3). */
export interface ApiCreateIncrementalityObservationInput {
  readonly organizationScopeId: string;
  readonly subjectReference: { readonly subjectId: string; readonly subjectType: string };
  readonly outcomeType: string;
  readonly lift: { readonly value: number; readonly unit: string };
  readonly baselineValue: { readonly value: number; readonly unit: string };
  readonly confidence: Readonly<Record<string, unknown>>;
  readonly provenance: Readonly<Record<string, unknown>>;
  readonly experimentId?: string;
  readonly evidenceIds?: readonly string[];
}

/** The public view of a counterfactual/baseline (NET-W006 AC-04). */
export interface ApiCounterfactualBaselineView {
  readonly id: string;
  readonly organizationScopeId: string;
  readonly ownerId: string;
  readonly subjectReference: { readonly subjectId: string; readonly subjectType: string };
  readonly outcomeType: string;
  readonly baselineKind: string;
  readonly baselineValue: { readonly value: number; readonly unit: string };
  readonly comparisonValue: { readonly value: number; readonly unit: string } | null;
  readonly confidence: Readonly<Record<string, unknown>>;
  readonly provenance: Readonly<Record<string, unknown>>;
  readonly evidenceIds: readonly string[];
  readonly createdAt: string;
}

/** Inputs to create a counterfactual/baseline via the API (§3.4). */
export interface ApiCreateCounterfactualBaselineInput {
  readonly organizationScopeId: string;
  readonly subjectReference: { readonly subjectId: string; readonly subjectType: string };
  readonly outcomeType: string;
  readonly baselineKind: string;
  readonly baselineValue: { readonly value: number; readonly unit: string };
  readonly comparisonValue?: { readonly value: number; readonly unit: string };
  readonly confidence: Readonly<Record<string, unknown>>;
  readonly provenance: Readonly<Record<string, unknown>>;
  readonly evidenceIds?: readonly string[];
}

/** The public view of a measured outcome (NET-W006 AC-05). */
export interface ApiMeasuredOutcomeView {
  readonly id: string;
  readonly organizationScopeId: string;
  readonly ownerId: string;
  readonly subjectReference: { readonly subjectId: string; readonly subjectType: string };
  readonly outcomeType: string;
  readonly outcomeClaimId: string | null;
  readonly observationIds: readonly string[];
  readonly attributionIds: readonly string[];
  readonly baselineIds: readonly string[];
  readonly incrementalityIds: readonly string[];
  readonly maturation: Readonly<Record<string, unknown>>;
  readonly rollupStrategy: string;
  readonly state: string;
  readonly version: number;
  readonly createdAt: string;
  readonly updatedAt: string;
}

/** The detailed measured-outcome view (includes the rollup). */
export interface ApiMeasuredOutcomeDetailView extends ApiMeasuredOutcomeView {
  readonly rollup: Readonly<Record<string, unknown>> | null;
}

/** Inputs to create a measured outcome via the API (§3.5). */
export interface ApiCreateMeasuredOutcomeInput {
  readonly organizationScopeId: string;
  readonly subjectReference: { readonly subjectId: string; readonly subjectType: string };
  readonly outcomeType: string;
  readonly outcomeClaimId?: string;
  readonly maturation: Readonly<Record<string, unknown>>;
  readonly rollupStrategy?: string;
  readonly observationIds?: readonly string[];
}

// -- NET-W007 reputation views/inputs ----------------------------------

/** The public view of a reputation scoring policy version. */
export interface ApiReputationPolicyView {
  readonly id: string;
  readonly policyId: string;
  readonly version: number;
  readonly organizationScopeId: string;
  readonly description: string | null;
  readonly rules: readonly Record<string, unknown>[];
  readonly createdBy: string;
  readonly createdAt: string;
}

/** Inputs to create a scoring policy version (NET-W007 §3.3). */
export interface ApiCreateReputationPolicyInput {
  readonly organizationScopeId: string;
  readonly policyId: string;
  readonly version: number;
  readonly description?: string;
  readonly rules: readonly Record<string, unknown>[];
}

/** The public view of a reputation input. */
export interface ApiReputationInputView {
  readonly id: string;
  readonly organizationScopeId: string;
  readonly subjectPersonId: string;
  readonly dimension: string;
  readonly basis: string;
  readonly sources: readonly Record<string, unknown>[];
  readonly description: string | null;
  readonly occurredAt: string;
  readonly recordedAt: string;
  readonly idempotencyKey: string;
}

/** Inputs to record a reputation input (NET-W007 §3.2). */
export interface ApiRecordReputationInputInput {
  readonly organizationScopeId: string;
  readonly subjectPersonId: string;
  readonly dimension: string;
  readonly sources: readonly Record<string, unknown>[];
  readonly description?: string;
  readonly occurredAt: string;
  readonly idempotencyKey: string;
}

/** The public view of one dimension score. */
export interface ApiReputationDimensionScoreView {
  readonly dimension: string;
  readonly score: number;
  readonly inputCount: number;
  readonly verifiedInputCount: number;
  readonly indicatedInputCount: number;
  readonly decayedVerifiedWeight: number;
  readonly decayedIndicatedWeight: number;
  readonly capped: boolean;
}

/** The public view of a computed reputation score set (preview). */
export interface ApiReputationScoresView {
  readonly organizationScopeId: string;
  readonly subjectPersonId: string;
  readonly policyId: string;
  readonly policyVersion: number;
  readonly referenceAt: string;
  readonly scores: readonly ApiReputationDimensionScoreView[];
  readonly inputIds: readonly string[];
  readonly digest: string;
}

/** Inputs to compute scores / record a snapshot (NET-W007 §3.4/§3.5). */
export interface ApiReputationComputationInput {
  readonly organizationScopeId: string;
  readonly subjectPersonId: string;
  readonly policyId: string;
  readonly version?: number;
  readonly referenceAt: string;
}

/** Inputs to record a snapshot (adds the required idempotency key). */
export interface ApiRecordReputationSnapshotInput extends ApiReputationComputationInput {
  readonly idempotencyKey: string;
}

/** The public view of a reputation snapshot. */
export interface ApiReputationSnapshotView {
  readonly id: string;
  readonly organizationScopeId: string;
  readonly subjectPersonId: string;
  readonly policyId: string;
  readonly policyVersion: number;
  readonly referenceAt: string;
  readonly computedAt: string;
  readonly scores: readonly ApiReputationDimensionScoreView[];
  readonly inputIds: readonly string[];
  readonly digest: string;
  readonly idempotencyKey: string;
}

// -- NET-W031 portable reputation proof views/inputs --------------------

/**
 * ONE disclosed dimension fact (AGGREGATE ONLY — the authority's own
 * time-decayed score + cap flag + the three evidence-reference counts;
 * the REP-004 opaque lineage; PRIV-001..003: no raw personal activity,
 * no input ids, no payloads ever appear).
 */
export interface ApiReputationProofDimensionView {
  readonly dimension: string;
  readonly score: number;
  readonly capped: boolean;
  readonly inputCount: number;
  readonly verifiedInputCount: number;
  readonly indicatedInputCount: number;
}

/**
 * The public view of a portable reputation proof (NET-W031) — the
 * SELF-CONTAINED presentation artifact: identity + lineage binding
 * (snapshot id, policy id + version, referenceAt, the snapshot
 * digest), the aggregate dimension facts, the composed W029 signed
 * envelope (algorithm, key reference, signature), the one-way
 * revocation fields and the record-format marker.
 */
export interface ApiReputationProofView {
  readonly id: string;
  readonly organizationScopeId: string;
  readonly subjectPersonId: string;
  readonly snapshotId: string;
  readonly policyId: string;
  readonly policyVersion: number;
  readonly referenceAt: string;
  readonly digest: string;
  readonly dimensions: readonly ApiReputationProofDimensionView[];
  readonly algorithm: string;
  readonly keyReference: string;
  readonly signature: string;
  readonly issuedAt: string;
  readonly revokedAt: string | null;
  readonly revocationReason: string | null;
  readonly createdAt: string;
  readonly recordFormat: string;
}

/**
 * Inputs to issue a portable reputation proof (NET-W031). Deliberately
 * carries NO facts: the disclosed values are always DERIVED from the
 * authoritative snapshot (non-purchasable — REP-002: no score-altering
 * input exists on the proof surface).
 */
export interface ApiIssueReputationProofInput {
  readonly organizationScopeId: string;
  readonly subjectPersonId: string;
  /** Omitted → the subject's LATEST recorded snapshot in scope. */
  readonly snapshotId?: string;
  readonly idempotencyKey: string;
}

/** The issuance result (201 + replay-safe `created` flag). */
export interface ApiIssueReputationProofResult {
  readonly proof: ApiReputationProofView;
  readonly created: boolean;
}

/** One machine-readable verification check outcome (NET-W031). */
export interface ApiReputationProofCheckView {
  readonly check: string;
  readonly subject: string | null;
  readonly passed: boolean;
  readonly reason: string;
}

/** The deterministic verification verdict for a proof (NET-W031). */
export interface ApiReputationProofVerificationView {
  readonly proofId: string;
  readonly valid: boolean;
  readonly reason: string;
  readonly checks: readonly ApiReputationProofCheckView[];
}

/** Inputs to verify a STORED proof by id (NET-W031). */
export interface ApiVerifyReputationProofInput {
  readonly organizationScopeId: string;
  /** The EXPLICIT staleness evaluation timestamp (determinism). */
  readonly evaluatedAt: string;
}

/**
 * Inputs to verify a PRESENTED, self-contained proof artifact
 * (NET-W031 — the portable path: no tenant state is queried).
 */
export interface ApiVerifyPresentedReputationProofInput {
  readonly proof: ApiReputationProofView;
  readonly evaluatedAt: string;
}

/** Inputs to revoke a proof (NET-W031; ONE-WAY). */
export interface ApiRevokeReputationProofInput {
  readonly organizationScopeId: string;
  readonly reason: string;
  readonly idempotencyKey: string;
}

// -- NET-W008 settlement views/inputs ----------------------------------

/** The public view of an economic value record (pending/mature value). */
export interface ApiEconomicValueView {
  readonly id: string;
  readonly organizationScopeId: string;
  readonly beneficiaryPersonId: string;
  readonly state: string;
  readonly version: number;
  readonly amount: number;
  readonly unit: string;
  readonly sources: readonly Record<string, unknown>[];
  readonly maturation: Record<string, unknown>;
  readonly description: string | null;
  readonly recordedAt: string;
  readonly maturedAt: string | null;
  readonly consumedBy: Record<string, unknown> | null;
  readonly reversal: Record<string, unknown> | null;
  readonly recognitionTransactionId: string;
  readonly maturationTransactionId: string | null;
  readonly idempotencyKey: string;
}

/** Inputs to record pending economic value (NET-W008 §3.3). */
export interface ApiRecordEconomicValueInput {
  readonly organizationScopeId: string;
  readonly beneficiaryPersonId: string;
  readonly amount: number;
  readonly sources: readonly Record<string, unknown>[];
  readonly maturation?: Record<string, unknown>;
  readonly description?: string;
  readonly idempotencyKey: string;
}

/** Inputs to mature a value record (the explicit maturation gate). */
export interface ApiMatureEconomicValueInput {
  readonly valueRecordId: string;
  readonly effectiveAt?: string;
  readonly idempotencyKey: string;
}

/** Inputs to reverse a value record (append-only correction). */
export interface ApiReverseEconomicValueInput {
  readonly valueRecordId: string;
  readonly reason: string;
  readonly idempotencyKey: string;
}

/** The public view of a Participation Credit issuance. */
export interface ApiCreditIssuanceView {
  readonly id: string;
  readonly organizationScopeId: string;
  readonly beneficiaryPersonId: string;
  readonly creditAmount: number;
  readonly sourceValueRecordId: string;
  readonly sourceValueAmount: number;
  readonly proofOfValueId: string;
  readonly creditsPerValueUnit: number;
  readonly status: string;
  readonly reversal: Record<string, unknown> | null;
  readonly transactionId: string;
  readonly issuedAt: string;
  readonly description: string | null;
  readonly idempotencyKey: string;
}

/** Inputs to issue Participation Credits (NET-W008 §3.4). */
export interface ApiIssueCreditsInput {
  readonly organizationScopeId: string;
  readonly beneficiaryPersonId: string;
  readonly sourceValueRecordId: string;
  readonly creditsPerValueUnit: number;
  readonly description?: string;
  readonly idempotencyKey: string;
}

/** Inputs to reverse a credit issuance. */
export interface ApiReverseCreditIssuanceInput {
  readonly issuanceId: string;
  readonly reason: string;
  readonly idempotencyKey: string;
}

/** The public view of a reward allocation policy version. */
export interface ApiRewardPolicyView {
  readonly id: string;
  readonly policyId: string;
  readonly version: number;
  readonly organizationScopeId: string;
  readonly description: string | null;
  readonly allocations: readonly Record<string, unknown>[];
  readonly createdBy: string;
  readonly createdAt: string;
}

/** Inputs to create a reward-policy version (NET-W008 §3.5). */
export interface ApiCreateRewardPolicyInput {
  readonly organizationScopeId: string;
  readonly policyId: string;
  readonly version: number;
  readonly description?: string;
  readonly allocations: readonly Record<string, unknown>[];
}

/** The public view of a reward allocation. */
export interface ApiRewardAllocationView {
  readonly id: string;
  readonly organizationScopeId: string;
  readonly sourceValueRecordId: string;
  readonly sourceValueAmount: number;
  readonly sourceBeneficiaryPersonId: string;
  readonly policyId: string;
  readonly policyVersion: number;
  readonly totalAllocated: number;
  readonly shares: readonly Record<string, unknown>[];
  readonly status: string;
  readonly reversal: Record<string, unknown> | null;
  readonly transactionId: string;
  readonly allocatedAt: string;
  readonly idempotencyKey: string;
}

/** Inputs to allocate rewards from a mature value record. */
export interface ApiAllocateRewardsInput {
  readonly organizationScopeId: string;
  readonly sourceValueRecordId: string;
  readonly policyId: string;
  readonly version?: number;
  readonly idempotencyKey: string;
}

/** Inputs to reverse a reward allocation. */
export interface ApiReverseRewardAllocationInput {
  readonly allocationId: string;
  readonly reason: string;
  readonly idempotencyKey: string;
}

/** The public view of a cash obligation. */
export interface ApiCashObligationView {
  readonly id: string;
  readonly organizationScopeId: string;
  readonly kind: string;
  readonly counterpartyPersonId: string;
  readonly amount: number;
  readonly unit: string;
  readonly status: string;
  readonly settledAt: string | null;
  readonly settlementReference: string | null;
  readonly reversal: Record<string, unknown> | null;
  readonly transactionId: string;
  readonly description: string | null;
  readonly recordedAt: string;
  readonly idempotencyKey: string;
}

/** Inputs to record a cash obligation (NET-W008 §3.6). */
export interface ApiRecordCashObligationInput {
  readonly organizationScopeId: string;
  readonly kind: string;
  readonly counterpartyPersonId: string;
  readonly amount: number;
  readonly description?: string;
  readonly idempotencyKey: string;
}

/** Inputs to internally settle a cash obligation. */
export interface ApiSettleCashObligationInput {
  readonly obligationId: string;
  readonly reference?: string;
  readonly idempotencyKey: string;
}

/** Inputs to reverse a cash obligation. */
export interface ApiReverseCashObligationInput {
  readonly obligationId: string;
  readonly reason: string;
  readonly idempotencyKey: string;
}

/** The public view of a cash↔credits conversion. */
export interface ApiConversionView {
  readonly id: string;
  readonly organizationScopeId: string;
  readonly personId: string;
  readonly direction: string;
  readonly cashAmount: number;
  readonly creditsAmount: number;
  readonly rate: number;
  readonly status: string;
  readonly reversal: Record<string, unknown> | null;
  readonly transactionId: string;
  readonly convertedAt: string;
  readonly description: string | null;
  readonly idempotencyKey: string;
}

/** Inputs to record an explicit conversion (NET-W008 §3.6). */
export interface ApiRecordConversionInput {
  readonly organizationScopeId: string;
  readonly personId: string;
  readonly direction: string;
  readonly cashAmount: number;
  readonly creditsAmount: number;
  readonly description?: string;
  readonly idempotencyKey: string;
}

/** Inputs to reverse a conversion. */
export interface ApiReverseConversionInput {
  readonly conversionId: string;
  readonly reason: string;
  readonly idempotencyKey: string;
}

/** The public view of a ledger transaction (AUD-003 lineage). */
export interface ApiLedgerTransactionView {
  readonly id: string;
  readonly organizationScopeId: string;
  readonly kind: string;
  readonly description: string | null;
  readonly subject: Record<string, unknown> | null;
  readonly entries: readonly Record<string, unknown>[];
  readonly recordedAt: string;
  readonly idempotencyKey: string;
}

/** The public view of an account balance (derived from entries). */
export interface ApiLedgerAccountBalanceView {
  readonly accountId: string;
  readonly organizationScopeId: string;
  readonly ownerPersonId: string | null;
  readonly kind: string;
  readonly unit: string;
  readonly balance: number;
}

/** A participant's economic summary (balances derived from entries). */
export interface ApiParticipantEconomicSummaryView {
  readonly organizationScopeId: string;
  readonly personId: string;
  readonly pendingValue: number;
  readonly matureValue: number;
  readonly credits: number;
  readonly rewards: number;
  readonly cashPayable: number;
  readonly cashReceivable: number;
}

/**
 * ApiCommands — the protected mutation surface the API server consumes
 * (after the {@link ApiAuth} guard has authorized the request). The
 * bootstrap composition root wires a thin adapter that delegates to the
 * real domain services (IdentityService, OrganizationService,
 * MembershipService, ParticipantService). The API server never imports
 * the domain ports directly (infrastructure→domain is prohibited by the
 * tier allow matrix).
 *
 * Every method here corresponds to a protected mutation that has ALREADY
 * been authorized by the {@link ApiAuth.authorize} guard before the
 * command is invoked. The adapter is the dependency-inversion seam.
 */
// ---------------------------------------------------------------------------
// NET-W009 fraud/risk foundation views + inputs (/disputes boundary)
// ---------------------------------------------------------------------------

export interface ApiRiskSignalView {
  readonly id: string;
  readonly organizationScopeId: string;
  readonly subjectPersonId: string;
  readonly subjectRef: { subjectType: string; subjectId: string } | null;
  readonly category: string;
  readonly severity: string;
  readonly confidence: number;
  readonly provenance: {
    kind: string;
    detectionMethod: string;
    detectionVersion: string;
    sources: readonly { kind: string; id: string }[];
  };
  readonly advisory: boolean;
  readonly description: string | null;
  readonly detectedAt: string;
  readonly recordedAt: string;
  readonly supersedesSignalId: string | null;
  readonly supersededBySignalId: string | null;
}

export interface ApiRiskPolicyView {
  readonly id: string;
  readonly policyId: string;
  readonly version: number;
  readonly organizationScopeId: string;
  readonly description: string | null;
  readonly rules: readonly Record<string, unknown>[];
  readonly thresholds: Record<string, unknown>;
  readonly criticalFloorState: string;
  readonly advisoryOnlyCapState: string;
  readonly requiredCategories: readonly string[];
  readonly missingDataState: string;
  readonly createdAt: string;
}

export interface ApiRiskAssessmentView {
  readonly id: string;
  readonly organizationScopeId: string;
  readonly subjectPersonId: string;
  readonly subjectRef: { subjectType: string; subjectId: string } | null;
  readonly policyId: string;
  readonly policyVersion: number;
  readonly evaluatedAt: string;
  readonly recordedAt: string;
  readonly signalIds: readonly string[];
  readonly contributions: readonly Record<string, unknown>[];
  readonly score: number;
  readonly state: string;
  readonly missingCategories: readonly string[];
  readonly digest: string;
  readonly supersedesAssessmentId: string | null;
  readonly supersededByAssessmentId: string | null;
}

export interface ApiRiskCaseView {
  readonly id: string;
  readonly organizationScopeId: string;
  readonly subjectPersonId: string | null;
  readonly subjectRef: { subjectType: string; subjectId: string } | null;
  readonly title: string;
  readonly description: string | null;
  readonly state: string;
  readonly reasonCodes: readonly string[];
  readonly decisions: readonly Record<string, unknown>[];
  readonly openedBy: string;
  readonly openedAt: string;
  readonly resolvedAt: string | null;
  readonly resolution: string | null;
}

export interface ApiRiskControlView {
  readonly id: string;
  readonly organizationScopeId: string;
  readonly operationClass: string;
  readonly action: string;
  readonly subjectPersonId: string | null;
  readonly subjectRef: { subjectType: string; subjectId: string } | null;
  readonly originAssessmentId: string | null;
  readonly originCaseId: string | null;
  readonly reasonCodes: readonly string[];
  readonly description: string | null;
  readonly state: string;
  readonly activatedBy: string;
  readonly activatedAt: string;
  readonly resolvedBy: string | null;
  readonly resolvedAt: string | null;
  readonly resolvedViaCaseDecisionId: string | null;
}

export interface ApiRiskSubjectSummaryView {
  readonly organizationScopeId: string;
  readonly subjectPersonId: string;
  readonly latestAssessment: ApiRiskAssessmentView | null;
  readonly activeControls: readonly ApiRiskControlView[];
  readonly openCases: readonly ApiRiskCaseView[];
  readonly signalCount: number;
}

// ---------------------------------------------------------------------------
// NET-W010 challenges/disputes/appeals views (/disputes boundary)
// ---------------------------------------------------------------------------

export interface ApiDisputeView {
  readonly id: string;
  readonly organizationScopeId: string;
  readonly kind: string;
  readonly appealOfDisputeId: string | null;
  readonly challengerPersonId: string;
  readonly subjectRef: { subjectType: string; subjectId: string };
  readonly subjectAnchorAt: string;
  readonly subjectBeneficiaryPersonId: string | null;
  readonly statement: string;
  readonly reasonCodes: readonly string[];
  readonly supportingRefs: readonly { kind: string; id: string }[];
  readonly state: string;
  readonly stake: {
    readonly requirement: { amount: number; unit: string };
    readonly stakeId: string | null;
    readonly bondedAt: string | null;
    readonly disposition: string | null;
    readonly dispositionAt: string | null;
  };
  readonly window: {
    readonly challengeWindowExpiresAt: string;
    readonly appealWindowExpiresAt: string | null;
  };
  readonly reviewerPersonId: string | null;
  readonly reviewStartedAt: string | null;
  readonly resolution: Record<string, unknown> | null;
  readonly appealDisputeId: string | null;
  readonly events: readonly Record<string, unknown>[];
  readonly policyVersion: string;
}

export interface ApiStakeView {
  readonly id: string;
  readonly organizationScopeId: string;
  readonly ownerPersonId: string;
  readonly amount: number;
  readonly unit: string;
  readonly state: string;
  readonly purpose: { kind: string; id: string };
  readonly committedAt: string;
  readonly outcome: Record<string, unknown> | null;
  readonly transactionId: string;
  readonly description: string | null;
}

// ---------------------------------------------------------------------------
// NET-W011 campaign views (/campaigns boundary)
// ---------------------------------------------------------------------------

export interface ApiCampaignView {
  readonly id: string;
  readonly organizationScopeId: string;
  readonly ownerPersonId: string;
  readonly name: string;
  readonly description: string | null;
  readonly status: string;
  readonly currentPolicyVersion: number | null;
  readonly budget: {
    readonly stakeId: string | null;
    readonly committedAmount: number | null;
    readonly committedAt: string | null;
    readonly releasedAt: string | null;
  };
  readonly events: readonly Record<string, unknown>[];
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface ApiCampaignPolicyView {
  readonly id: string;
  readonly campaignId: string;
  readonly organizationScopeId: string;
  readonly version: number;
  readonly formatVersion: string;
  readonly objectives: readonly Record<string, unknown>[];
  readonly eligibility: Record<string, unknown>;
  readonly outcomePolicy: Record<string, unknown>;
  readonly evidencePolicy: Record<string, unknown>;
  readonly budget: Record<string, unknown>;
  readonly attributionRules: readonly Record<string, unknown>[];
  readonly clearingRules: readonly Record<string, unknown>[];
  readonly opportunitySpecs: readonly Record<string, unknown>[];
  readonly createdBy: string;
  readonly createdAt: string;
}

/** The API view of a helpfulness policy version (NET-W012). */
export interface ApiHelpfulnessPolicyView {
  readonly id: string;
  readonly policyId: string;
  readonly organizationScopeId: string;
  readonly version: number;
  readonly formatVersion: string;
  readonly sections: Record<string, unknown>;
  readonly createdBy: string;
  readonly createdAt: string;
}

/** The API view of a Proof-of-Helpfulness record (NET-W012). */
export interface ApiProofOfHelpfulnessView {
  readonly id: string;
  readonly organizationScopeId: string;
  readonly contributionId: string;
  readonly contributorId: string;
  readonly helpfulnessPolicyId: string;
  readonly helpfulnessPolicyVersion: number;
  readonly formatVersion: string;
  readonly eligibility: Record<string, unknown> | null;
  readonly mentions: readonly Record<string, unknown>[];
  readonly disclosureIds: readonly string[];
  readonly advisoryScores: readonly Record<string, unknown>[];
  readonly bases: readonly Record<string, unknown>[];
  readonly evaluations: readonly Record<string, unknown>[];
  readonly recommendations: readonly Record<string, unknown>[];
  readonly publication: Record<string, unknown> | null;
  readonly state: string;
  readonly events: readonly string[];
  readonly createdAt: string;
  readonly updatedAt: string;
}

/** The API view of a commercial disclosure record (NET-W012). */
export interface ApiCommercialDisclosureView {
  readonly id: string;
  readonly organizationScopeId: string;
  readonly contributionId: string;
  readonly contributorId: string;
  readonly relationshipKind: string;
  readonly relationshipRef: string;
  readonly productRef: string | null;
  readonly counterpartyRef: string;
  readonly description: string | null;
  readonly state: string;
  readonly events: readonly string[];
  readonly createdAt: string;
  readonly updatedAt: string;
}

/** The API view of a quality policy version (NET-W013). */
export interface ApiQualityPolicyView {
  readonly id: string;
  readonly policyId: string;
  readonly organizationScopeId: string;
  readonly version: number;
  readonly formatVersion: string;
  readonly inputs: readonly Record<string, unknown>[];
  readonly advisory: Record<string, unknown>;
  readonly minimumGrade: string;
  readonly qualifyingSourceTypes: readonly string[];
  readonly qualifyingOutcomeTypes: readonly string[];
  readonly minimumConfidence: number;
  readonly thresholds: Record<string, unknown>;
  readonly structural: Record<string, unknown>;
  readonly description: string | null;
  readonly createdBy: string;
  readonly createdAt: string;
}

/** The API view of an advisory quality score (NET-W013). */
export interface ApiAdvisoryQualityScoreView {
  readonly id: string;
  readonly organizationScopeId: string;
  readonly contributionId: string;
  readonly kind: string;
  readonly methodRef: string;
  readonly methodVersion: string;
  readonly provider: string | null;
  readonly modelRef: string | null;
  readonly score: number;
  readonly recordedBy: string;
  readonly recordedAt: string;
}

/** The API view of a recorded quality evaluation (NET-W013). */
export interface ApiQualityEvaluationView {
  readonly id: string;
  readonly organizationScopeId: string;
  readonly contributionId: string;
  readonly qualityPolicyId: string;
  readonly qualityPolicyVersion: number;
  readonly formatVersion: string;
  readonly evaluatedAt: string;
  readonly recordedAt: string;
  readonly inputContributions: readonly Record<string, unknown>[];
  readonly advisoryCount: number;
  readonly advisoryAverage: number | null;
  readonly score: number;
  readonly band: string;
  readonly reasons: readonly string[];
  readonly evaluator: string;
  readonly digest: string;
  readonly supersedesEvaluationId: string | null;
  readonly supersededByEvaluationId: string | null;
}

/** The API view of a quality-evaluation preview (NET-W013). */
export interface ApiQualityEvaluationPreviewView {
  readonly policy: ApiQualityPolicyView;
  readonly inputContributions: readonly Record<string, unknown>[];
  readonly advisoryCount: number;
  readonly advisoryAverage: number | null;
  readonly score: number;
  readonly band: string;
  readonly reasons: readonly string[];
  readonly evaluator: string;
}

/** The API view of a moderation decision record (NET-W013). */
export interface ApiModerationDecisionView {
  readonly id: string;
  readonly organizationScopeId: string;
  readonly contributionId: string;
  readonly decision: string;
  readonly reasonKinds: readonly string[];
  readonly notes: string | null;
  readonly qualityEvaluationIds: readonly string[];
  readonly decidedBy: string;
  readonly decidedAt: string;
}

/** The API view of a contribution's derived moderation status (NET-W013). */
export interface ApiModerationSummaryView {
  readonly contributionId: string;
  readonly organizationScopeId: string;
  readonly status: string;
  readonly decisionCount: number;
  readonly latestDecision: ApiModerationDecisionView | null;
}

export interface ApiCommands {
  /** Create a canonical person identity. Returns the public view. */
  createIdentity(
    execution: ExecutionContext,
    input: { readonly displayName: string; readonly subjectId: string; readonly providerKind: string },
  ): Promise<ApiPublicIdentityView>;

  /** Fetch the public view of an identity (privacy-safe — PRIV-001, AC-07). */
  getPublicIdentity(execution: ExecutionContext, id: string): Promise<ApiPublicIdentityView | null>;

  /** Create an organization (protected mutation). */
  createOrganization(
    execution: ExecutionContext,
    actorPersonId: string,
    input: ApiCreateOrganizationInput,
  ): Promise<ApiOrganizationView>;

  /** Grant a membership in an organization (protected mutation). */
  grantMembership(
    execution: ExecutionContext,
    actorPersonId: string,
    organizationId: string,
    input: ApiGrantMembershipInput,
  ): Promise<{ membership: ApiMembershipView; created: boolean }>;

  /** Revoke a membership (protected mutation). */
  revokeMembership(
    execution: ExecutionContext,
    actorPersonId: string,
    membershipId: string,
  ): Promise<{ membership: ApiMembershipView; already: boolean }>;

  // -- NET-W004 opportunity/contribution/transition commands ----

  /** Create an opportunity (NET-W004 AC-01, protected mutation). */
  createOpportunity(
    execution: ExecutionContext,
    actorPersonId: string,
    input: ApiCreateOpportunityInput,
  ): Promise<ApiOpportunityView>;

  /** Fetch the detailed view of an opportunity (NET-W004 AC-01). */
  getOpportunity(
    execution: ExecutionContext,
    id: string,
  ): Promise<ApiOpportunityDetailView | null>;

  /** Create a contribution (NET-W004 AC-02, protected mutation). */
  createContribution(
    execution: ExecutionContext,
    actorPersonId: string,
    input: ApiCreateContributionInput,
  ): Promise<ApiContributionView>;

  /** Fetch the detailed view of a contribution (NET-W004 AC-02). */
  getContribution(
    execution: ExecutionContext,
    id: string,
  ): Promise<ApiContributionDetailView | null>;

  /**
   * Request an authorized lifecycle transition (NET-W004 §3.4, §4.1 —
   * the SOLE entry point for authoritative lifecycle mutation).
   * Idempotent: repeating with the same idempotencyKey is a deterministic
   * replay (NET-W004 §4.4). NET-W005 extends the endpoint to
   * subjectKind "proof_of_value".
   */
  requestTransition(
    execution: ExecutionContext,
    actorPersonId: string,
    input: ApiRequestTransitionInput,
  ): Promise<ApiTransitionResultView>;

  // -- NET-W005 evidence/proof-of-value commands ------------------

  /** Create an evidence record (NET-W005 AC-01, protected mutation). */
  createEvidence(
    execution: ExecutionContext,
    actorPersonId: string,
    input: ApiCreateEvidenceInput,
  ): Promise<ApiEvidenceView>;

  /** Fetch an evidence record (public read). */
  getEvidence(
    execution: ExecutionContext,
    id: string,
  ): Promise<ApiEvidenceView | null>;

  /** Verify presented plaintext against a stored commitment (AC-05). */
  verifyEvidenceCommitment(
    execution: ExecutionContext,
    id: string,
    presentedPayload: string,
  ): Promise<ApiCommitmentVerificationView>;

  /** Create an outcome claim (NET-W005 AC-03, protected mutation). */
  createOutcomeClaim(
    execution: ExecutionContext,
    actorPersonId: string,
    input: ApiCreateOutcomeClaimInput,
  ): Promise<ApiOutcomeClaimView>;

  /** Fetch an outcome claim (public read). */
  getOutcomeClaim(
    execution: ExecutionContext,
    id: string,
  ): Promise<ApiOutcomeClaimView | null>;

  /** Attach evidence to an outcome claim (protected mutation). */
  attachEvidenceToClaim(
    execution: ExecutionContext,
    actorPersonId: string,
    claimId: string,
    evidenceId: string,
  ): Promise<ApiOutcomeClaimView>;

  /** Create an attestation (NET-W005 AC-05, protected mutation). */
  createAttestation(
    execution: ExecutionContext,
    actorPersonId: string,
    input: ApiCreateAttestationInput,
  ): Promise<ApiAttestationView>;

  /** Verify an attestation WITHOUT plaintext disclosure (AC-05). */
  verifyAttestation(
    execution: ExecutionContext,
    id: string,
  ): Promise<ApiAttestationVerificationView>;

  // -----------------------------------------------------------------
  // NET-W029 — signed attestations (cryptographic attestations and
  // commitments, issue #58).
  // -----------------------------------------------------------------

  /**
   * Create a signed attestation (NET-W029, protected mutation; guard
   * action `signedAttestation.create`): the coverage set re-derives
   * INSIDE the authoritative transaction (missing/cross-scope/REVERSED
   * covered records fail closed), the "attestation/v2" canonical input
   * is signed by the injected versioned signer (closed algorithm +
   * key-reference vocabularies), and the record commits atomically with
   * its audit event (composite idempotency).
   */
  createSignedAttestation(
    execution: ExecutionContext,
    actorPersonId: string,
    input: ApiCreateSignedAttestationInput,
  ): Promise<ApiSignedAttestationView>;

  /**
   * Fetch a signed attestation (NET-W029, tenant-scoped read; guard
   * action `signedAttestation.read`): cross-tenant and nonexistent are
   * indistinguishable (null → 404; no existence oracle).
   */
  getSignedAttestation(
    execution: ExecutionContext,
    id: string,
    input: { readonly organizationScopeId: string },
  ): Promise<ApiSignedAttestationView | null>;

  /**
   * Verify a signed attestation (NET-W029, derived decision; guard
   * action `signedAttestation.verify`): deterministic, server-side,
   * fail-closed verification with machine-readable reasons — rebuilds
   * the canonical input from the STORED coverage commitments (no
   * plaintext disclosure) and re-derives the covered records' current
   * state + integrity.
   */
  verifySignedAttestation(
    execution: ExecutionContext,
    id: string,
    input: { readonly organizationScopeId: string },
  ): Promise<ApiSignedAttestationVerificationView>;

  /**
   * Revoke a signed attestation (NET-W029, ONE-WAY mutation; guard
   * action `signedAttestation.revoke`): a revoked attestation NEVER
   * verifies again; revoking an already-revoked record is an idempotent
   * no-op returning the record.
   */
  revokeSignedAttestation(
    execution: ExecutionContext,
    actorPersonId: string,
    id: string,
    input: ApiRevokeSignedAttestationInput,
  ): Promise<ApiSignedAttestationView>;

  /**
   * Ingest an external settlement transaction fact (NET-W030,
   * authenticated ingestion; guard action
   * `externalSettlementFact.record`): routes the raw provider payload
   * through the neutral adapter, verifies the trust envelope
   * (SecretProvider material — unauthenticated/stale/malformed fail
   * closed with machine-readable reasons), and records the fact
   * exactly-once per (organization scope, provider, external id) with
   * the in-tx derived reconciliation audited atomically. The fact is
   * NEVER economic authority — no ledger entry, no mutation.
   */
  recordExternalSettlementFact(
    execution: ExecutionContext,
    actorPersonId: string,
    input: ApiRecordExternalSettlementFactInput,
  ): Promise<ApiRecordExternalSettlementFactResult>;

  /**
   * Fetch an external settlement fact (NET-W030, tenant-scoped read;
   * guard action `externalSettlementFact.read`): cross-tenant and
   * nonexistent are indistinguishable (null → 404; no existence
   * oracle).
   */
  getExternalSettlementFact(
    execution: ExecutionContext,
    id: string,
    input: { readonly organizationScopeId: string },
  ): Promise<ApiExternalSettlementFactView | null>;

  /**
   * Derive the reconciliation verdict for one fact (NET-W030, derived
   * decision; guard action `externalSettlementFact.reconcile`):
   * deterministic, server-side matched/pending/mismatched with
   * machine-readable reasons, re-derived from the CURRENT ledger
   * lineage — never stored, never auto-corrected.
   */
  evaluateExternalSettlementReconciliation(
    execution: ExecutionContext,
    id: string,
    input: { readonly organizationScopeId: string },
  ): Promise<ApiExternalSettlementReconciliationView>;

  /**
   * Reverse traceability (NET-W030; guard action
   * `externalSettlementFact.read`): every recorded fact referencing
   * an internal ledger transaction (tenant-scoped).
   */
  listExternalSettlementFactsByTransaction(
    execution: ExecutionContext,
    input: { readonly organizationScopeId: string; readonly internalTransactionId: string },
  ): Promise<{
    readonly internalTransactionId: string;
    readonly facts: readonly ApiExternalSettlementFactView[];
  }>;

  /** Create a proof of value (NET-W005 AC-06, protected mutation). */
  createProofOfValue(
    execution: ExecutionContext,
    actorPersonId: string,
    input: ApiCreateProofOfValueInput,
  ): Promise<ApiProofOfValueView>;

  /** Fetch the detailed view of a proof of value (public read). */
  getProofOfValue(
    execution: ExecutionContext,
    id: string,
  ): Promise<ApiProofOfValueDetailView | null>;

  /** Attach evidence to a proof of value (protected mutation). */
  attachEvidenceToProof(
    execution: ExecutionContext,
    actorPersonId: string,
    proofId: string,
    evidenceId: string,
  ): Promise<ApiProofOfValueView>;

  /** Aggregate the attached evidence on a proof of value (protected). */
  aggregateProofEvidence(
    execution: ExecutionContext,
    actorPersonId: string,
    proofId: string,
  ): Promise<ApiProofOfValueDetailView>;

  /** Attach an attestation to a proof of value (protected mutation). */
  attachAttestationToProof(
    execution: ExecutionContext,
    actorPersonId: string,
    proofId: string,
    attestationId: string,
  ): Promise<ApiProofOfValueView>;

  // -- NET-W006 outcomes/measurement commands --------------------

  /** Create an outcome observation (NET-W006 AC-01, protected mutation). */
  createOutcomeObservation(
    execution: ExecutionContext,
    actorPersonId: string,
    input: ApiCreateOutcomeObservationInput,
  ): Promise<ApiOutcomeObservationView>;

  /** Fetch an outcome observation (public read). */
  getOutcomeObservation(
    execution: ExecutionContext,
    id: string,
  ): Promise<ApiOutcomeObservationView | null>;

  /**
   * Correct an observation (append-corrected; protected mutation).
   * The correction targets the observation identified by the
   * `observationId` path parameter; it inherits the target's subject
   * reference + outcome type server-side.
   */
  correctOutcomeObservation(
    execution: ExecutionContext,
    actorPersonId: string,
    observationId: string,
    input: ApiCreateOutcomeObservationInput,
  ): Promise<ApiOutcomeObservationView>;

  /** Ingest provider observations through the neutral adapter (AC-07). */
  ingestProviderObservations(
    execution: ExecutionContext,
    actorPersonId: string,
    input: {
      readonly organizationScopeId: string;
      readonly subjectReference: { readonly subjectId: string; readonly subjectType: string };
      readonly since?: string;
    },
  ): Promise<ApiProviderIngestionResultView>;

  /**
   * Submit ONE raw provider attribution report (NET-W022,
   * ADAPTER-003..004): normalize it through the provider's adapter
   * (measurement boundary) and persist the resulting provider-sourced
   * observation through /outcomes semantics — exactly-once-per
   * idempotency key, atomically audited. The observer is the
   * authenticated actor.
   */
  submitMeasurementReport(
    execution: ExecutionContext,
    actorPersonId: string,
    input: ApiSubmitMeasurementReportInput,
  ): Promise<ApiMeasurementReportSubmissionView>;

  /**
   * Evaluate ONE external ad request (NET-W023, ADAPTER-001..002):
   * normalize the raw vendor bid-request payload through the
   * provider's adapter (adapters boundary), resolve the external
   * supply identity against REGISTERED inventory through the neutral
   * read-only lookup (exact-one or fail closed), and derive the
   * supply-side admission evaluation. A READ-ONLY derivation — it
   * mutates nothing and authorizes nothing.
   */
  evaluateExternalAdRequest(
    execution: ExecutionContext,
    actorPersonId: string,
    input: ApiEvaluateExternalAdRequestInput,
  ): Promise<ApiExternalAdRequestEvaluationView>;

  /** Create a measurement experiment (NET-W006 AC-03, protected). */
  createMeasurementExperiment(
    execution: ExecutionContext,
    actorPersonId: string,
    input: ApiCreateMeasurementExperimentInput,
  ): Promise<ApiMeasurementExperimentView>;

  /** Fetch a measurement experiment (public read). */
  getMeasurementExperiment(
    execution: ExecutionContext,
    id: string,
  ): Promise<ApiMeasurementExperimentView | null>;

  /** PLANNED → RUNNING (protected mutation). */
  startMeasurementExperiment(
    execution: ExecutionContext,
    actorPersonId: string,
    experimentId: string,
    input: ApiExperimentStatusChangeInput,
  ): Promise<ApiMeasurementExperimentView>;

  /** RUNNING → COMPLETED (protected mutation). */
  completeMeasurementExperiment(
    execution: ExecutionContext,
    actorPersonId: string,
    experimentId: string,
    input: ApiExperimentStatusChangeInput,
  ): Promise<ApiMeasurementExperimentView>;

  /** PLANNED|RUNNING → INVALIDATED (protected mutation). */
  invalidateMeasurementExperiment(
    execution: ExecutionContext,
    actorPersonId: string,
    experimentId: string,
    input: ApiExperimentStatusChangeInput,
  ): Promise<ApiMeasurementExperimentView>;

  /** Create an attribution record (NET-W006 AC-02, protected). */
  createAttribution(
    execution: ExecutionContext,
    actorPersonId: string,
    input: ApiCreateAttributionInput,
  ): Promise<ApiAttributionView>;

  /** Fetch an attribution record (public read). */
  getAttribution(
    execution: ExecutionContext,
    id: string,
  ): Promise<ApiAttributionView | null>;

  /** Create an incrementality observation (AC-03, protected). */
  createIncrementalityObservation(
    execution: ExecutionContext,
    actorPersonId: string,
    input: ApiCreateIncrementalityObservationInput,
  ): Promise<ApiIncrementalityObservationView>;

  /** Fetch an incrementality observation (public read). */
  getIncrementalityObservation(
    execution: ExecutionContext,
    id: string,
  ): Promise<ApiIncrementalityObservationView | null>;

  /** Create a counterfactual/baseline (NET-W006 AC-04, protected). */
  createCounterfactualBaseline(
    execution: ExecutionContext,
    actorPersonId: string,
    input: ApiCreateCounterfactualBaselineInput,
  ): Promise<ApiCounterfactualBaselineView>;

  /** Fetch a counterfactual/baseline (public read). */
  getCounterfactualBaseline(
    execution: ExecutionContext,
    id: string,
  ): Promise<ApiCounterfactualBaselineView | null>;

  /** Create a measured outcome (NET-W006 AC-05, protected). */
  createMeasuredOutcome(
    execution: ExecutionContext,
    actorPersonId: string,
    input: ApiCreateMeasuredOutcomeInput,
  ): Promise<ApiMeasuredOutcomeView>;

  /** Fetch the detailed view of a measured outcome (public read). */
  getMeasuredOutcome(
    execution: ExecutionContext,
    id: string,
  ): Promise<ApiMeasuredOutcomeDetailView | null>;

  /** Attach an observation to a measured outcome (protected). */
  attachObservationToMeasurement(
    execution: ExecutionContext,
    actorPersonId: string,
    measurementId: string,
    observationId: string,
  ): Promise<ApiMeasuredOutcomeView>;

  /** Attach an attribution to a measured outcome (protected). */
  attachAttributionToMeasurement(
    execution: ExecutionContext,
    actorPersonId: string,
    measurementId: string,
    attributionId: string,
  ): Promise<ApiMeasuredOutcomeView>;

  /** Attach a baseline to a measured outcome (protected). */
  attachBaselineToMeasurement(
    execution: ExecutionContext,
    actorPersonId: string,
    measurementId: string,
    baselineId: string,
  ): Promise<ApiMeasuredOutcomeView>;

  /** Attach an incrementality observation to a measured outcome (protected). */
  attachIncrementalityToMeasurement(
    execution: ExecutionContext,
    actorPersonId: string,
    measurementId: string,
    incrementalityId: string,
  ): Promise<ApiMeasuredOutcomeView>;

  /** Record the deterministic rollup on a measured outcome (protected). */
  recordMeasurementRollup(
    execution: ExecutionContext,
    actorPersonId: string,
    measurementId: string,
  ): Promise<ApiMeasuredOutcomeDetailView>;

  // -- NET-W007 reputation commands -------------------------------------

  /** Create a scoring-policy version (protected mutation). */
  createReputationPolicy(
    execution: ExecutionContext,
    actorPersonId: string,
    input: ApiCreateReputationPolicyInput,
  ): Promise<ApiReputationPolicyView>;

  /** Fetch a scoring-policy version by record id (public read). */
  getReputationPolicy(
    execution: ExecutionContext,
    id: string,
  ): Promise<ApiReputationPolicyView | null>;

  /** List a policy lineage's versions (public read). */
  listReputationPolicyVersions(
    execution: ExecutionContext,
    policyId: string,
    organizationScopeId?: string,
  ): Promise<readonly ApiReputationPolicyView[]>;

  /** Record a reputation input (protected mutation). */
  recordReputationInput(
    execution: ExecutionContext,
    actorPersonId: string,
    input: ApiRecordReputationInputInput,
  ): Promise<{ input: ApiReputationInputView; created: boolean }>;

  /** Fetch a reputation input (public read). */
  getReputationInput(
    execution: ExecutionContext,
    id: string,
  ): Promise<ApiReputationInputView | null>;

  /** List a subject's reputation inputs (public read). */
  listReputationInputs(
    execution: ExecutionContext,
    organizationScopeId: string,
    subjectPersonId: string,
  ): Promise<readonly ApiReputationInputView[]>;

  /** Compute scores without persisting (deterministic preview, public read). */
  computeReputationScores(
    execution: ExecutionContext,
    input: ApiReputationComputationInput,
  ): Promise<ApiReputationScoresView>;

  /** Record a reputation snapshot (protected mutation). */
  recordReputationSnapshot(
    execution: ExecutionContext,
    actorPersonId: string,
    input: ApiRecordReputationSnapshotInput,
  ): Promise<{ snapshot: ApiReputationSnapshotView; created: boolean }>;

  /** Fetch a reputation snapshot (public read). */
  getReputationSnapshot(
    execution: ExecutionContext,
    id: string,
  ): Promise<ApiReputationSnapshotView | null>;

  /** List a subject's snapshot history (public read). */
  getReputationSnapshotHistory(
    execution: ExecutionContext,
    organizationScopeId: string,
    subjectPersonId: string,
  ): Promise<readonly ApiReputationSnapshotView[]>;

  /** Fetch a subject's latest snapshot (public read). */
  getLatestReputationSnapshot(
    execution: ExecutionContext,
    organizationScopeId: string,
    subjectPersonId: string,
  ): Promise<ApiReputationSnapshotView | null>;

  // -----------------------------------------------------------------
  // NET-W031 — portable reputation proofs (issue #63).
  // -----------------------------------------------------------------

  /**
   * Issue a portable reputation proof (NET-W031, protected mutation;
   * guard action `reputationProof.create`): derives the AGGREGATE
   * dimension facts from the authoritative snapshot INSIDE the
   * issuance transaction (exact id or the subject's latest in scope —
   * missing/cross-scope/subject-mismatch fail closed), signs the
   * "reputation-proof/v1" canonical input through the composed W029
   * versioned signer, and commits the immutable proof + its audit
   * event atomically (composite idempotency). The input carries NO
   * caller-asserted facts (REP-002).
   */
  issueReputationProof(
    execution: ExecutionContext,
    actorPersonId: string,
    input: ApiIssueReputationProofInput,
  ): Promise<ApiIssueReputationProofResult>;

  /**
   * Fetch a portable proof artifact (NET-W031, tenant-scoped read;
   * guard action `reputationProof.read`): cross-tenant and nonexistent
   * are indistinguishable (null → 404; no existence oracle).
   */
  getReputationProof(
    execution: ExecutionContext,
    id: string,
    input: { readonly organizationScopeId: string },
  ): Promise<ApiReputationProofView | null>;

  /**
   * Verify a STORED proof (NET-W031, derived decision; guard action
   * `reputationProof.verify`): deterministic, fail-closed, non-mutating
   * verification with machine-readable reasons — the fixed pipeline
   * revocation → shape → vocabularies → pairing → signature →
   * staleness at the EXPLICIT evaluatedAt.
   */
  verifyReputationProof(
    execution: ExecutionContext,
    id: string,
    input: ApiVerifyReputationProofInput,
  ): Promise<ApiReputationProofVerificationView>;

  /**
   * Verify a PRESENTED, self-contained proof artifact (NET-W031, the
   * PORTABLE path; guard action `reputationProof.verify`): the same
   * deterministic fail-closed pipeline WITHOUT querying any
   * tenant-scoped state (no store reads, no mutations, no audit).
   */
  verifyPresentedReputationProof(
    execution: ExecutionContext,
    input: ApiVerifyPresentedReputationProofInput,
  ): Promise<ApiReputationProofVerificationView>;

  /**
   * Revoke a proof (NET-W031, ONE-WAY mutation; guard action
   * `reputationProof.revoke`): a revoked proof NEVER verifies again;
   * revoking an already-revoked record is an idempotent no-op
   * returning the record.
   */
  revokeReputationProof(
    execution: ExecutionContext,
    actorPersonId: string,
    id: string,
    input: ApiRevokeReputationProofInput,
  ): Promise<ApiReputationProofView>;

  // -- NET-W008 settlement commands --------------------------------------

  /** Record pending economic value (protected; the verified-source gate). */
  createEconomicValue(
    execution: ExecutionContext,
    input: ApiRecordEconomicValueInput,
  ): Promise<{ value: ApiEconomicValueView; created: boolean }>;

  /** Fetch an economic value record (public read). */
  getEconomicValue(
    execution: ExecutionContext,
    id: string,
  ): Promise<ApiEconomicValueView | null>;

  /** List a beneficiary's value records, optionally filtered by state. */
  listEconomicValues(
    execution: ExecutionContext,
    organizationScopeId: string,
    beneficiaryPersonId: string,
    states?: readonly string[],
  ): Promise<readonly ApiEconomicValueView[]>;

  /** Mature a pending value record (protected; the explicit gate). */
  matureEconomicValue(
    execution: ExecutionContext,
    input: ApiMatureEconomicValueInput,
  ): Promise<ApiEconomicValueView>;

  /** Reverse a value record (protected; append-only correction). */
  reverseEconomicValue(
    execution: ExecutionContext,
    input: ApiReverseEconomicValueInput,
  ): Promise<ApiEconomicValueView>;

  /** Issue Participation Credits (protected; PoV-gated). */
  issueCredits(
    execution: ExecutionContext,
    input: ApiIssueCreditsInput,
  ): Promise<{ issuance: ApiCreditIssuanceView; created: boolean }>;

  /** Fetch a credit issuance (public read). */
  getCreditIssuance(
    execution: ExecutionContext,
    id: string,
  ): Promise<ApiCreditIssuanceView | null>;

  /** List a beneficiary's credit issuances (public read). */
  listCreditIssuances(
    execution: ExecutionContext,
    organizationScopeId: string,
    beneficiaryPersonId: string,
  ): Promise<readonly ApiCreditIssuanceView[]>;

  /** Reverse a credit issuance (protected; append-only correction). */
  reverseCreditIssuance(
    execution: ExecutionContext,
    input: ApiReverseCreditIssuanceInput,
  ): Promise<ApiCreditIssuanceView>;

  /** Create a reward-policy version (protected). */
  createRewardPolicy(
    execution: ExecutionContext,
    input: ApiCreateRewardPolicyInput,
  ): Promise<ApiRewardPolicyView>;

  /** Fetch a reward policy version by record id (public read). */
  getRewardPolicy(
    execution: ExecutionContext,
    id: string,
  ): Promise<ApiRewardPolicyView | null>;

  /** List a reward-policy lineage's versions (public read). */
  listRewardPolicyVersions(
    execution: ExecutionContext,
    policyId: string,
    organizationScopeId?: string,
  ): Promise<readonly ApiRewardPolicyView[]>;

  /** Allocate rewards from a mature value record (protected). */
  allocateRewards(
    execution: ExecutionContext,
    input: ApiAllocateRewardsInput,
  ): Promise<{ allocation: ApiRewardAllocationView; created: boolean }>;

  /** Fetch a reward allocation (public read). */
  getRewardAllocation(
    execution: ExecutionContext,
    id: string,
  ): Promise<ApiRewardAllocationView | null>;

  /** List an organization's reward allocations (public read). */
  listRewardAllocations(
    execution: ExecutionContext,
    organizationScopeId: string,
  ): Promise<readonly ApiRewardAllocationView[]>;

  /** Reverse a reward allocation (protected; append-only correction). */
  reverseRewardAllocation(
    execution: ExecutionContext,
    input: ApiReverseRewardAllocationInput,
  ): Promise<ApiRewardAllocationView>;

  /** Record a cash obligation (protected). */
  recordCashObligation(
    execution: ExecutionContext,
    input: ApiRecordCashObligationInput,
  ): Promise<{ obligation: ApiCashObligationView; created: boolean }>;

  /** Fetch a cash obligation (public read). */
  getCashObligation(
    execution: ExecutionContext,
    id: string,
  ): Promise<ApiCashObligationView | null>;

  /** List an organization's cash obligations (public read). */
  listCashObligations(
    execution: ExecutionContext,
    organizationScopeId: string,
  ): Promise<readonly ApiCashObligationView[]>;

  /** Internally settle a cash obligation (protected). */
  settleCashObligation(
    execution: ExecutionContext,
    input: ApiSettleCashObligationInput,
  ): Promise<ApiCashObligationView>;

  /** Reverse a cash obligation (protected; append-only correction). */
  reverseCashObligation(
    execution: ExecutionContext,
    input: ApiReverseCashObligationInput,
  ): Promise<ApiCashObligationView>;

  /** Record an explicit cash↔credits conversion (protected). */
  recordConversion(
    execution: ExecutionContext,
    input: ApiRecordConversionInput,
  ): Promise<{ conversion: ApiConversionView; created: boolean }>;

  /** Fetch a conversion (public read). */
  getConversion(
    execution: ExecutionContext,
    id: string,
  ): Promise<ApiConversionView | null>;

  /** List an organization's conversions (public read). */
  listConversions(
    execution: ExecutionContext,
    organizationScopeId: string,
  ): Promise<readonly ApiConversionView[]>;

  /** Reverse a conversion (protected; append-only correction). */
  reverseConversion(
    execution: ExecutionContext,
    input: ApiReverseConversionInput,
  ): Promise<ApiConversionView>;

  /** Fetch a ledger transaction (public read; AUD-003 lineage). */
  getLedgerTransaction(
    execution: ExecutionContext,
    id: string,
  ): Promise<ApiLedgerTransactionView | null>;

  /** List every ledger transaction for an economic record (public read). */
  listLedgerTransactionsBySubject(
    execution: ExecutionContext,
    subjectKind: string,
    subjectId: string,
  ): Promise<readonly ApiLedgerTransactionView[]>;

  /** List account balances for an organization (public read). */
  listLedgerAccountBalances(
    execution: ExecutionContext,
    organizationScopeId: string,
  ): Promise<readonly ApiLedgerAccountBalanceView[]>;

  /** A participant's economic summary (public read). */
  getParticipantEconomicSummary(
    execution: ExecutionContext,
    organizationScopeId: string,
    personId: string,
  ): Promise<ApiParticipantEconomicSummaryView>;

  // -- NET-W009 fraud/risk commands ---------------------------------------

  /** Record a risk signal (protected; provenance + source-ref gate). */
  createRiskSignal(
    execution: ExecutionContext,
    actorPersonId: string,
    input: Record<string, unknown>,
  ): Promise<{ signal: ApiRiskSignalView; created: boolean }>;

  /** Supersede a signal with a correction (protected; append-only). */
  supersedeRiskSignal(
    execution: ExecutionContext,
    actorPersonId: string,
    input: Record<string, unknown>,
  ): Promise<ApiRiskSignalView>;

  /** Fetch a risk signal (public read). */
  getRiskSignal(execution: ExecutionContext, id: string): Promise<ApiRiskSignalView | null>;

  /** List signals for an org, optionally narrowed to a subject (public read). */
  listRiskSignals(
    execution: ExecutionContext,
    organizationScopeId: string,
    subjectPersonId?: string,
  ): Promise<readonly ApiRiskSignalView[]>;

  /** Create a risk policy version (protected; lineage mutex). */
  createRiskPolicy(
    execution: ExecutionContext,
    actorPersonId: string,
    input: Record<string, unknown>,
  ): Promise<ApiRiskPolicyView>;

  /** List a policy lineage's versions (public read). */
  listRiskPolicyVersions(
    execution: ExecutionContext,
    policyId: string,
    organizationScopeId?: string,
  ): Promise<readonly ApiRiskPolicyView[]>;

  /** Record a risk assessment (protected; deterministic engine). */
  recordRiskAssessment(
    execution: ExecutionContext,
    actorPersonId: string,
    input: Record<string, unknown>,
  ): Promise<{ assessment: ApiRiskAssessmentView; created: boolean }>;

  /** Deterministic assessment preview — pure, no persist (public read). */
  previewRiskAssessment(
    execution: ExecutionContext,
    input: Record<string, unknown>,
  ): Promise<Omit<ApiRiskAssessmentView, "id" | "recordedAt" | "supersedesAssessmentId" | "supersededByAssessmentId">>;

  /** Fetch an assessment (public read). */
  getRiskAssessment(execution: ExecutionContext, id: string): Promise<ApiRiskAssessmentView | null>;

  /** List a subject's assessment history (public read). */
  listRiskAssessments(
    execution: ExecutionContext,
    organizationScopeId: string,
    subjectPersonId: string,
  ): Promise<readonly ApiRiskAssessmentView[]>;

  /** Open a risk case (protected; ≥1 supporting reference). */
  openRiskCase(
    execution: ExecutionContext,
    actorPersonId: string,
    input: Record<string, unknown>,
  ): Promise<{ riskCase: ApiRiskCaseView; created: boolean }>;

  /** Append a case decision (protected; deterministic state machine). */
  recordRiskCaseDecision(
    execution: ExecutionContext,
    actorPersonId: string,
    input: Record<string, unknown>,
  ): Promise<ApiRiskCaseView>;

  /** Fetch a case with its decision history (public read). */
  getRiskCase(execution: ExecutionContext, id: string): Promise<ApiRiskCaseView | null>;

  /** List an org's cases, optionally filtered by state (public read). */
  listRiskCases(
    execution: ExecutionContext,
    organizationScopeId: string,
    states?: readonly string[],
  ): Promise<readonly ApiRiskCaseView[]>;

  /** Activate a risk control (protected; evidence-backed origin gate). */
  activateRiskControl(
    execution: ExecutionContext,
    actorPersonId: string,
    input: Record<string, unknown>,
  ): Promise<{ control: ApiRiskControlView; created: boolean }>;

  /** Resolve a risk control (protected). */
  resolveRiskControl(
    execution: ExecutionContext,
    actorPersonId: string,
    input: Record<string, unknown>,
  ): Promise<ApiRiskControlView>;

  /** Fetch a control decision (public read). */
  getRiskControl(execution: ExecutionContext, id: string): Promise<ApiRiskControlView | null>;

  /** List an org's controls, optionally filtered by state (public read). */
  listRiskControls(
    execution: ExecutionContext,
    organizationScopeId: string,
    states?: readonly string[],
  ): Promise<readonly ApiRiskControlView[]>;

  /** A subject's risk summary (public read). */
  getRiskSubjectSummary(
    execution: ExecutionContext,
    organizationScopeId: string,
    subjectPersonId: string,
  ): Promise<ApiRiskSubjectSummaryView>;

  /**
   * Apply a workflow hold (protected): record/require an active
   * workflow_transition control and request the FRAUD_REVIEW
   * transition THROUGH the workflow service (the sole lifecycle
   * authority). The composition root — not the risk domain — performs
   * the authorized request.
   */
  applyWorkflowHold(
    execution: ExecutionContext,
    actorPersonId: string,
    input: Record<string, unknown>,
  ): Promise<{ control: ApiRiskControlView; transition: Record<string, unknown> }>;

  /**
   * Clear a workflow hold (protected): resolve the control and request
   * the cleared return transition (FRAUD_REVIEW → SUBMITTED) through
   * the workflow service.
   */
  clearWorkflowHold(
    execution: ExecutionContext,
    actorPersonId: string,
    input: Record<string, unknown>,
  ): Promise<{ control: ApiRiskControlView; transition: Record<string, unknown> }>;

  // -----------------------------------------------------------------
  // NET-W010 challenges/disputes/appeals (/disputes boundary)
  // -----------------------------------------------------------------

  /**
   * Open a dispute (the challenge request; protected). Runs the
   * deterministic eligibility gate and creates the PENDING_STAKE
   * record — the stake is committed in a separate explicit step.
   */
  openDispute(
    execution: ExecutionContext,
    actorPersonId: string,
    input: Record<string, unknown>,
  ): Promise<{ dispute: ApiDisputeView; created: boolean }>;

  /**
   * Bond the challenge stake (protected): commits the stake through
   * the settlement authority and bonds it to the PENDING_STAKE
   * dispute, making it a formal OPEN dispute.
   */
  bondDisputeStake(
    execution: ExecutionContext,
    actorPersonId: string,
    input: Record<string, unknown>,
  ): Promise<{ dispute: ApiDisputeView; stake: ApiStakeView }>;

  /** Start the review (protected; conflict-of-interest gate). */
  startDisputeReview(
    execution: ExecutionContext,
    actorPersonId: string,
    input: Record<string, unknown>,
  ): Promise<ApiDisputeView>;

  /**
   * Reject the dispute as inadmissible (protected). Releases the
   * bonded stake through the settlement authority and records the
   * outcome on the dispute.
   */
  rejectDispute(
    execution: ExecutionContext,
    actorPersonId: string,
    input: Record<string, unknown>,
  ): Promise<{ dispute: ApiDisputeView; stake?: ApiStakeView }>;

  /**
   * Resolve the dispute on the merits (protected). Records the
   * outcome + control disposition + deterministic stake mapping, then
   * executes the stake consequence (release/forfeit) through the
   * settlement authority and records the outcome on the dispute.
   */
  resolveDispute(
    execution: ExecutionContext,
    actorPersonId: string,
    input: Record<string, unknown>,
  ): Promise<{ dispute: ApiDisputeView; stake?: ApiStakeView }>;

  /**
   * Appeal a resolved dispute's outcome (protected, within the appeal
   * window): creates a NEW linked appeal record; the original flips
   * to terminal APPEALED.
   */
  appealDispute(
    execution: ExecutionContext,
    actorPersonId: string,
    input: Record<string, unknown>,
  ): Promise<{
    original: ApiDisputeView;
    appeal: ApiDisputeView;
    created: boolean;
  }>;

  /**
   * Withdraw the dispute (protected; the challenger only). Releases
   * the bonded stake through the settlement authority.
   */
  withdrawDispute(
    execution: ExecutionContext,
    actorPersonId: string,
    input: Record<string, unknown>,
  ): Promise<{ dispute: ApiDisputeView; stake?: ApiStakeView }>;

  /** Fetch a dispute with its immutable event history (public read). */
  getDispute(execution: ExecutionContext, id: string): Promise<ApiDisputeView | null>;

  /** List an org's disputes, optionally filtered by state (public read). */
  listDisputes(
    execution: ExecutionContext,
    organizationScopeId: string,
    states?: readonly string[],
  ): Promise<readonly ApiDisputeView[]>;

  /** Fetch a stake record from the settlement authority (public read). */
  getStake(execution: ExecutionContext, id: string): Promise<ApiStakeView | null>;

  // -----------------------------------------------------------------
  // NET-W011 campaigns (/campaigns boundary)
  // -----------------------------------------------------------------

  /**
   * Create a campaign (protected; the person actor becomes the
   * owner). The record starts DRAFT with an append-only history.
   */
  createCampaign(
    execution: ExecutionContext,
    actorPersonId: string,
    input: Record<string, unknown>,
  ): Promise<{ campaign: ApiCampaignView; created: boolean }>;

  /**
   * Define the next immutable campaign policy version (protected;
   * owner-only): objectives, eligibility, outcome/evidence policy,
   * budget, attribution rules, clearing rules and opportunity specs
   * — validated against the frozen vocabularies (CAMP-002).
   */
  defineCampaignPolicy(
    execution: ExecutionContext,
    actorPersonId: string,
    input: Record<string, unknown>,
  ): Promise<{ policy: ApiCampaignPolicyView; created: boolean }>;

  /**
   * Activate (protected; owner-only; the CAMP-002 gate: complete
   * policy + escrowed budget before ACTIVE).
   */
  activateCampaign(
    execution: ExecutionContext,
    actorPersonId: string,
    input: Record<string, unknown>,
  ): Promise<ApiCampaignView>;

  /** Pause (protected; owner-only; ACTIVE → PAUSED). */
  pauseCampaign(
    execution: ExecutionContext,
    actorPersonId: string,
    input: Record<string, unknown>,
  ): Promise<ApiCampaignView>;

  /** Resume (protected; owner-only; PAUSED → ACTIVE; re-runs the gate). */
  resumeCampaign(
    execution: ExecutionContext,
    actorPersonId: string,
    input: Record<string, unknown>,
  ): Promise<ApiCampaignView>;

  /** Complete (protected; owner-only; → COMPLETED terminal). */
  completeCampaign(
    execution: ExecutionContext,
    actorPersonId: string,
    input: Record<string, unknown>,
  ): Promise<ApiCampaignView>;

  /** Cancel (protected; owner-only; → CANCELLED terminal). */
  cancelCampaign(
    execution: ExecutionContext,
    actorPersonId: string,
    input: Record<string, unknown>,
  ): Promise<ApiCampaignView>;

  /**
   * Commit the campaign budget (protected; owner-only): escrows the
   * declared total through the SETTLEMENT authority's stake commands
   * (`campaign_budget` purpose) and records the reference on the
   * campaign. No second economic system (AC-03).
   */
  commitCampaignBudget(
    execution: ExecutionContext,
    actorPersonId: string,
    input: Record<string, unknown>,
  ): Promise<{ campaign: ApiCampaignView; stake: ApiStakeView }>;

  /**
   * Release the campaign budget (protected; owner-only; terminal
   * campaign only): the settlement authority releases the escrow,
   * then the release is recorded on the campaign.
   */
  releaseCampaignBudget(
    execution: ExecutionContext,
    actorPersonId: string,
    input: Record<string, unknown>,
  ): Promise<{ campaign: ApiCampaignView; stake: ApiStakeView }>;

  /**
   * Publish a contribution opportunity from a policy spec (protected;
   * owner-only; ACTIVE campaign): composes a real Opportunity through
   * the opportunities boundary carrying the versioned eligibility
   * reference `campaign_policy:{campaignId}:{version}:{specId}`, then
   * records the publication. Lifecycle stays with /workflows (AC-04).
   */
  publishCampaignOpportunity(
    execution: ExecutionContext,
    actorPersonId: string,
    input: Record<string, unknown>,
  ): Promise<{ campaign: ApiCampaignView; opportunity: ApiOpportunityView }>;

  /** Fetch a campaign with its immutable history (public read). */
  getCampaign(
    execution: ExecutionContext,
    id: string,
  ): Promise<ApiCampaignView | null>;

  /** List an org's campaigns, optionally filtered by status (public read). */
  listCampaigns(
    execution: ExecutionContext,
    organizationScopeId: string,
    statuses?: readonly string[],
  ): Promise<readonly ApiCampaignView[]>;

  /** List a campaign's immutable policy versions (public read). */
  listCampaignPolicies(
    execution: ExecutionContext,
    campaignId: string,
  ): Promise<readonly ApiCampaignPolicyView[]>;

  /** List a campaign's published opportunities (public read). */
  listCampaignOpportunities(
    execution: ExecutionContext,
    campaignId: string,
  ): Promise<readonly {
    opportunityId: string;
    specId: string;
    policyVersion: number;
    publishedAt: string;
  }[]>;

  // -----------------------------------------------------------------
  // NET-W015 — creator identity and preferences (issue #29).
  // -----------------------------------------------------------------

  /**
   * Create a creator profile anchored to the acting person's
   * canonical identity (protected; self-anchored; unique per person
   * per organization scope; DRAFT).
   */
  createCreatorProfile(
    execution: ExecutionContext,
    actorPersonId: string,
    input: Record<string, unknown>,
  ): Promise<{ profile: Record<string, unknown>; created: boolean }>;

  /**
   * Define the next immutable creator profile version — ALL declared
   * sections (platforms, audience aggregates, commercial
   * preferences, rights, restrictions, availability, participation
   * rules, reputation references) at once (protected; owner-only;
   * every reputation reference verified against the canonical
   * /reputation authority).
   */
  defineCreatorProfileVersion(
    execution: ExecutionContext,
    actorPersonId: string,
    input: Record<string, unknown>,
  ): Promise<{ version: Record<string, unknown>; created: boolean }>;

  /** Activate a creator profile (protected; owner-only). */
  activateCreatorProfile(
    execution: ExecutionContext,
    actorPersonId: string,
    input: Record<string, unknown>,
  ): Promise<Record<string, unknown>>;

  /** Pause a creator profile (protected; owner-only). */
  pauseCreatorProfile(
    execution: ExecutionContext,
    actorPersonId: string,
    input: Record<string, unknown>,
  ): Promise<Record<string, unknown>>;

  /** Resume a creator profile (protected; owner-only). */
  resumeCreatorProfile(
    execution: ExecutionContext,
    actorPersonId: string,
    input: Record<string, unknown>,
  ): Promise<Record<string, unknown>>;

  /** Archive a creator profile (protected; owner-only; terminal). */
  archiveCreatorProfile(
    execution: ExecutionContext,
    actorPersonId: string,
    input: Record<string, unknown>,
  ): Promise<Record<string, unknown>>;

  /**
   * Fetch a creator profile by id WITHIN an organization scope
   * (public read; tenant-scoped — a cross-scope id is not found; PR
   * #30 review remediation).
   */
  getCreatorProfile(
    execution: ExecutionContext,
    organizationScopeId: string,
    id: string,
  ): Promise<Record<string, unknown> | null>;

  /** Fetch the creator profile anchored to a person in an org (public read). */
  getCreatorProfileByPerson(
    execution: ExecutionContext,
    organizationScopeId: string,
    creatorPersonId: string,
  ): Promise<Record<string, unknown> | null>;

  /** List an org's creator profiles, optionally by status (public read). */
  listCreatorProfiles(
    execution: ExecutionContext,
    organizationScopeId: string,
    statuses?: readonly string[],
  ): Promise<readonly Record<string, unknown>[]>;

  /**
   * List a creator profile's immutable versions (public read;
   * tenant-scoped — the profile must resolve in the caller's
   * organization scope).
   */
  listCreatorProfileVersions(
    execution: ExecutionContext,
    organizationScopeId: string,
    profileId: string,
  ): Promise<readonly Record<string, unknown>[]>;

  /**
   * Resolve the CURRENT profile version's reputation references
   * through the canonical /reputation snapshot service (public
   * read; tenant-scoped — a foreign organization scope cannot
   * resolve another tenant's creator reputation) — the creator
   * record stores references only; the trust signal resolves on
   * demand from the authority that owns it.
   */
  resolveCreatorReputation(
    execution: ExecutionContext,
    organizationScopeId: string,
    profileId: string,
  ): Promise<{
    profileId: string;
    currentVersion: number | null;
    references: readonly Record<string, unknown>[];
  }>;

  // -----------------------------------------------------------------
  // NET-W016 — creator matching (deterministic eligibility +
  // explicit-signal ranking; matching is SELECTION, not authority).
  // -----------------------------------------------------------------

  /**
   * Run a creator match (protected; guard action
   * `creators.matching.run`): deterministic hard-gate eligibility +
   * ranked candidate set with per-signal explanations, persisted as
   * ONE append-only, idempotent, tenant-scoped match-run record.
   * Optional campaign linkage is resolved read-only against the
   * pinned campaign policy version; the optional advisory (AI-002)
   * blends only into the relevance signal under a capped weight and
   * can never flip a hard gate.
   */
  runCreatorMatch(
    execution: ExecutionContext,
    actorPersonId: string,
    input: Record<string, unknown>,
  ): Promise<{ run: Record<string, unknown>; created: boolean }>;

  /** Fetch one match run (public read; tenant-scoped). */
  getCreatorMatchRun(
    execution: ExecutionContext,
    organizationScopeId: string,
    id: string,
  ): Promise<Record<string, unknown>>;

  /** List an org's match runs, optionally by campaign (public read). */
  listCreatorMatchRuns(
    execution: ExecutionContext,
    organizationScopeId: string,
    campaignId?: string,
  ): Promise<readonly Record<string, unknown>[]>;

  // -----------------------------------------------------------------
  // NET-W021 — Campaign matching and optimization (selection, not
  // authority): hard gates → evidence-backed features → deterministic
  // baseline ranking → bounded AI advisory (AI-002 + AI-003) →
  // explainable candidate ordering. The run record + audit event are
  // the only writes.
  // -----------------------------------------------------------------

  /** Run a campaign match (guarded: campaigns.matching.run). */
  runCampaignMatch(
    execution: ExecutionContext,
    actorPersonId: string,
    input: Record<string, unknown>,
  ): Promise<{ run: Record<string, unknown>; created: boolean }>;

  /** Fetch one campaign match run (public read; tenant-scoped). */
  getCampaignMatchRun(
    execution: ExecutionContext,
    organizationScopeId: string,
    id: string,
  ): Promise<Record<string, unknown>>;

  /** List an org's campaign match runs, optionally by campaign (public read). */
  listCampaignMatchRuns(
    execution: ExecutionContext,
    organizationScopeId: string,
    campaignId?: string,
  ): Promise<readonly Record<string, unknown>[]>;

  // -----------------------------------------------------------------
  // NET-W017 — UGC workflow and rights (creator engagements). The
  // engagement is a canonical /workflows lifecycle subject: composed
  // commands (accept / auto-accept / production open / submit) are
  // guarded here; pure lifecycle transitions (tender / verify /
  // reject / cancel) go through the EXISTING
  // `requestTransition` command with subjectKind "engagement".
  // -----------------------------------------------------------------

  /**
   * Create an engagement offer (protected; guard action
   * `creators.engagements.create`): DRAFT record with the explicit
   * requested-rights envelope + campaign/match/opportunity lineage,
   * serialized by the advisory-lock unique anchor (one non-terminal
   * engagement per org/campaign/creator).
   */
  createEngagement(
    execution: ExecutionContext,
    actorPersonId: string,
    input: Record<string, unknown>,
  ): Promise<{ engagement: Record<string, unknown>; created: boolean }>;

  /**
   * Auto-match batch (protected; guard action
   * `creators.engagements.createFromMatch`): turn ONE match run's
   * eligible candidates into DRAFT offers with the template terms;
   * per-candidate outcomes are recorded in the batch record.
   */
  createEngagementsFromMatch(
    execution: ExecutionContext,
    actorPersonId: string,
    input: Record<string, unknown>,
  ): Promise<{ batch: Record<string, unknown>; created: boolean }>;

  /**
   * Manual acceptance (protected; guard action
   * `creators.engagements.accept`): validates the granted rights
   * against the requested envelope, records the usage-rights grant
   * (creator-retained ownership), then requests the READY → ASSIGNED
   * transition through /workflows.
   */
  acceptEngagement(
    execution: ExecutionContext,
    actorPersonId: string,
    input: Record<string, unknown>,
  ): Promise<Record<string, unknown>>;

  /**
   * Deterministic auto-accept (protected; guard action
   * `creators.engagements.autoAccept`): evaluates the creator's
   * acceptance policy (closed gate vocabulary, full trace); a
   * qualifying evaluation records the auto-grant + requests the
   * transition; a non-qualifying evaluation mutates NOTHING.
   */
  autoAcceptEngagement(
    execution: ExecutionContext,
    actorPersonId: string,
    input: Record<string, unknown>,
  ): Promise<Record<string, unknown>>;

  /**
   * Revoke a usage-rights grant (protected; guard action
   * `creators.usageRights.revoke`; grantor-only).
   */
  revokeUsageRights(
    execution: ExecutionContext,
    actorPersonId: string,
    input: Record<string, unknown>,
  ): Promise<Record<string, unknown>>;

  /**
   * Set the next acceptance-policy version (protected; guard action
   * `creators.acceptancePolicy.set`).
   */
  setCreatorAcceptancePolicy(
    execution: ExecutionContext,
    actorPersonId: string,
    input: Record<string, unknown>,
  ): Promise<{ policy: Record<string, unknown>; created: boolean }>;

  /**
   * Open UGC production (protected; guard action
   * `creators.productions.open`): the production record + the
   * ASSIGNED → IN_PROGRESS transition.
   */
  openUgcProduction(
    execution: ExecutionContext,
    actorPersonId: string,
    input: Record<string, unknown>,
  ): Promise<Record<string, unknown>>;

  /**
   * Record a deliverable version (protected; guard action
   * `creators.productions.deliverable`): immutable, deterministic
   * monotonic version per (production, deliverableKey).
   */
  recordUgcDeliverable(
    execution: ExecutionContext,
    actorPersonId: string,
    input: Record<string, unknown>,
  ): Promise<{ deliverable: Record<string, unknown>; created: boolean }>;

  /**
   * Submit the production (protected; guard action
   * `creators.productions.submit`): the submission record + the
   * IN_PROGRESS → SUBMITTED transition; every evidence reference is
   * validated against the canonical /evidence authority.
   */
  submitUgcProduction(
    execution: ExecutionContext,
    actorPersonId: string,
    input: Record<string, unknown>,
  ): Promise<Record<string, unknown>>;

  /** Fetch one engagement (public read; tenant-scoped). */
  getEngagement(
    execution: ExecutionContext,
    organizationScopeId: string,
    id: string,
  ): Promise<Record<string, unknown>>;

  /** List an org's engagements, optionally filtered (public read). */
  listEngagements(
    execution: ExecutionContext,
    organizationScopeId: string,
    campaignId?: string,
    creatorPersonId?: string,
  ): Promise<readonly Record<string, unknown>[]>;

  /** Fetch the creator's effective acceptance policy (public read). */
  getCreatorAcceptancePolicy(
    execution: ExecutionContext,
    organizationScopeId: string,
    creatorPersonId: string,
  ): Promise<Record<string, unknown> | null>;

  /** Fetch one usage-rights grant view (public read; tenant-scoped). */
  getUsageRights(
    execution: ExecutionContext,
    organizationScopeId: string,
    grantId: string,
    asOf?: string | null,
  ): Promise<Record<string, unknown>>;

  /** List an org's usage-rights grants (public read; tenant-scoped). */
  listUsageRights(
    execution: ExecutionContext,
    organizationScopeId: string,
    engagementId?: string,
  ): Promise<readonly Record<string, unknown>[]>;

  /** Fetch one UGC production (public read; tenant-scoped). */
  getUgcProduction(
    execution: ExecutionContext,
    organizationScopeId: string,
    id: string,
  ): Promise<Record<string, unknown>>;

  /** List an org's UGC productions (public read; tenant-scoped). */
  listUgcProductions(
    execution: ExecutionContext,
    organizationScopeId: string,
    engagementId?: string,
  ): Promise<readonly Record<string, unknown>[]>;

  /** List a production's deliverable versions (public read). */
  listUgcDeliverables(
    execution: ExecutionContext,
    organizationScopeId: string,
    productionId: string,
  ): Promise<readonly Record<string, unknown>[]>;

  /** List a production's submissions (public read). */
  listUgcSubmissions(
    execution: ExecutionContext,
    organizationScopeId: string,
    productionId: string,
  ): Promise<readonly Record<string, unknown>[]>;

  // -----------------------------------------------------------------
  // NET-W018 — Sponsorship and disclosure (commercial relationships,
  // disclosure declarations, publications). The publication is a
  // canonical /workflows lifecycle subject: the VERIFICATION
  // composite (the disclosure gate) is guarded here; pure lifecycle
  // cancellation goes through the EXISTING `requestTransition`
  // command with subjectKind "publication". Compensation on the
  // relationship is REFERENCE DATA ONLY (no economic command).
  // -----------------------------------------------------------------

  /**
   * Record the commercial relationship for an engagement
   * (protected; guard action
   * `creators.commercialRelationships.create`): the explicit,
   * durable, tenant-scoped commercial record (DISC-001) with
   * campaign/engagement/creator lineage, relationship-declared
   * disclosure obligations and reference-only compensation terms.
   */
  createCommercialRelationship(
    execution: ExecutionContext,
    actorPersonId: string,
    input: Record<string, unknown>,
  ): Promise<{ relationship: Record<string, unknown>; created: boolean }>;

  /**
   * Terminate the commercial relationship (protected; guard action
   * `creators.commercialRelationships.terminate`): one-way; the
   * relationship KEEPS its disclosure obligations for content
   * produced under it.
   */
  terminateCommercialRelationship(
    execution: ExecutionContext,
    actorPersonId: string,
    input: Record<string, unknown>,
  ): Promise<Record<string, unknown>>;

  /**
   * Record a publication (protected; guard action
   * `creators.publications.create`): the DRAFT publication record
   * for a VERIFIED engagement's production with a provider-neutral
   * channel descriptor.
   */
  createPublication(
    execution: ExecutionContext,
    actorPersonId: string,
    input: Record<string, unknown>,
  ): Promise<{ publication: Record<string, unknown>; created: boolean }>;

  /**
   * Append a disclosure declaration (protected; guard action
   * `creators.publications.declareDisclosure`; creator-only
   * declarant): the auditable, evidence-bound disclosure record —
   * every evidence reference validates against the canonical
   * /evidence authority subject-bound to THIS publication.
   */
  recordDisclosureDeclaration(
    execution: ExecutionContext,
    actorPersonId: string,
    input: Record<string, unknown>,
  ): Promise<{ declaration: Record<string, unknown>; created: boolean }>;

  /**
   * THE DISCLOSURE GATE (protected; guard action
   * `creators.publications.verify`): verify the publication — the
   * derived disclosure obligations (campaign policy ∪ relationship
   * obligations) must ALL be satisfied by evidence-bound
   * declarations, and ≥1 canonical publication-evidence reference
   * must validate, before the DRAFT → VERIFIED transition executes
   * in ONE authoritative transaction. There is NO input that can
   * bypass the derivation.
   */
  verifyPublication(
    execution: ExecutionContext,
    actorPersonId: string,
    input: Record<string, unknown>,
  ): Promise<Record<string, unknown>>;

  /** Fetch one commercial relationship (public read; tenant-scoped). */
  getCommercialRelationship(
    execution: ExecutionContext,
    organizationScopeId: string,
    relationshipId: string,
  ): Promise<Record<string, unknown>>;

  /** List an org's commercial relationships (public read). */
  listCommercialRelationships(
    execution: ExecutionContext,
    organizationScopeId: string,
    campaignId?: string,
    engagementId?: string,
    creatorPersonId?: string,
  ): Promise<readonly Record<string, unknown>[]>;

  /** Fetch one publication (public read; tenant-scoped). */
  getPublication(
    execution: ExecutionContext,
    organizationScopeId: string,
    publicationId: string,
  ): Promise<Record<string, unknown>>;

  /** List an org's publications (public read). */
  listPublications(
    execution: ExecutionContext,
    organizationScopeId: string,
    engagementId?: string,
    campaignId?: string,
    creatorPersonId?: string,
  ): Promise<readonly Record<string, unknown>[]>;

  /** List a publication's disclosure declarations (public read). */
  listDisclosureDeclarations(
    execution: ExecutionContext,
    organizationScopeId: string,
    publicationId: string,
  ): Promise<readonly Record<string, unknown>[]>;

  /**
   * The DERIVED disclosure status of a publication (public read):
   * required obligations with provenance + satisfaction state — a
   * pure derivation over durable records.
   */
  getPublicationDisclosureStatus(
    execution: ExecutionContext,
    organizationScopeId: string,
    publicationId: string,
  ): Promise<Record<string, unknown>>;

  // -----------------------------------------------------------------
  // NET-W019 — Inventory and placements (supply registration,
  // placement context, supply authorization, source provenance).
  // Items and placements carry NO lifecycle subject kind (/workflows
  // untouched); the settlement gate is the DERIVED readiness view
  // (no economic command exists — /settlement stays the economic
  // authority).
  // -----------------------------------------------------------------

  /**
   * Register supply (protected; guard action
   * `inventory.items.register`): the acting person BECOMES the
   * registered owner (there is no ownerPersonId input — ownership
   * cannot be fabricated by client claims).
   */
  registerInventoryItem(
    execution: ExecutionContext,
    actorPersonId: string,
    input: Record<string, unknown>,
  ): Promise<{ item: Record<string, unknown>; created: boolean }>;

  /**
   * Withdraw supply (protected; guard action
   * `inventory.items.retire`; owner-only): one-way; a retired item's
   * placements are never settlement-ready (derived).
   */
  retireInventoryItem(
    execution: ExecutionContext,
    actorPersonId: string,
    input: Record<string, unknown>,
  ): Promise<Record<string, unknown>>;

  /**
   * Attach the supply-verification evidence reference (protected;
   * guard action `inventory.items.attachSupplyVerification`;
   * owner-only, one-time): the reference must resolve to a canonical
   * /evidence record subject-bound to THIS item.
   */
  attachSupplyVerification(
    execution: ExecutionContext,
    actorPersonId: string,
    input: Record<string, unknown>,
  ): Promise<Record<string, unknown>>;

  /**
   * Record the placement context (protected; guard action
   * `inventory.placements.create`; the acting person must be the
   * item's registered owner — server-enforced): policy-scoped
   * (campaign + pinned-or-latest policy version through the neutral
   * lookup), provenance-aware (the server-written source-context
   * snapshot) with the DERIVED eligibility evaluation. ONE active
   * placement per (item, campaign) — a stable conflict otherwise.
   */
  createPlacement(
    execution: ExecutionContext,
    actorPersonId: string,
    input: Record<string, unknown>,
  ): Promise<{ placement: Record<string, unknown>; created: boolean }>;

  /**
   * Retire the placement (protected; guard action
   * `inventory.placements.retire`; owner-only): one-way.
   */
  retirePlacement(
    execution: ExecutionContext,
    actorPersonId: string,
    input: Record<string, unknown>,
  ): Promise<Record<string, unknown>>;

  /** Fetch one inventory item (public read; tenant-scoped). */
  getInventoryItem(
    execution: ExecutionContext,
    organizationScopeId: string,
    itemId: string,
  ): Promise<Record<string, unknown>>;

  /** List an org's inventory items (public read). */
  listInventoryItems(
    execution: ExecutionContext,
    organizationScopeId: string,
    surfaceKind?: string,
    format?: string,
    ownerPersonId?: string,
    retired?: boolean,
  ): Promise<readonly Record<string, unknown>[]>;

  /** Fetch one placement (public read; tenant-scoped). */
  getPlacement(
    execution: ExecutionContext,
    organizationScopeId: string,
    placementId: string,
  ): Promise<Record<string, unknown>>;

  /** List an org's placements (public read). */
  listPlacements(
    execution: ExecutionContext,
    organizationScopeId: string,
    inventoryItemId?: string,
    campaignId?: string,
    ownerPersonId?: string,
    retired?: boolean,
  ): Promise<readonly Record<string, unknown>[]>;

  /**
   * THE SETTLEMENT GATE (public read): the DERIVED settlement
   * readiness of a placement — the validated source context a
   * settlement-affecting consumer must require (registered owner +
   * available supply + resolved publishable policy scope + satisfied
   * eligibility), re-derived from CURRENT durable records on every
   * read. There is NO command that asserts, stores or waives
   * readiness.
   */
  getPlacementSettlementReadiness(
    execution: ExecutionContext,
    organizationScopeId: string,
    placementId: string,
  ): Promise<Record<string, unknown>>;

  // -----------------------------------------------------------------
  // NET-W024 — Consumer Demand Pools (privacy-preserving aggregation,
  // server-enforced consent/membership, derived qualified aggregates).
  // Pools and commitments carry NO lifecycle subject kind (/workflows
  // untouched); the aggregate is a DERIVED view (never stored, never
  // caller-asserted) and the boundary carries NO economic surface
  // (/settlement stays the economic authority).
  // -----------------------------------------------------------------

  /**
   * Create a demand pool (protected; guard action
   * `demand.pools.create`): the acting person BECOMES the pool
   * creator (there is no creatorPersonId input — pool ownership
   * cannot be fabricated by client claims) and must hold an ACTIVE
   * organization membership (server-enforced). The qualification
   * policy is explicit, bounded and versioned on the record.
   */
  createDemandPool(
    execution: ExecutionContext,
    actorPersonId: string,
    input: Record<string, unknown>,
  ): Promise<{ pool: Record<string, unknown>; created: boolean }>;

  /**
   * Close the pool (protected; guard action `demand.pools.close`;
   * creator-only): one-way; a closed pool accepts no new commitments
   * and never qualifies (derived).
   */
  closeDemandPool(
    execution: ExecutionContext,
    actorPersonId: string,
    input: Record<string, unknown>,
  ): Promise<Record<string, unknown>>;

  /**
   * Record a consumer demand commitment (protected; guard action
   * `demand.commitments.create`): the acting person BECOMES the
   * consumer (there is no consumerPersonId input — demand membership
   * cannot be fabricated) and must hold an ACTIVE organization
   * membership. The consent grant is SERVER-WRITTEN (the input may
   * only name the closed "aggregate_disclosure" scope). ONE active
   * commitment per (pool, consumer).
   */
  createDemandCommitment(
    execution: ExecutionContext,
    actorPersonId: string,
    input: Record<string, unknown>,
  ): Promise<{ commitment: Record<string, unknown>; created: boolean }>;

  /**
   * Withdraw the commitment (protected; guard action
   * `demand.commitments.withdraw`; consumer-only): one-way; the
   * consent revocation — a withdrawn commitment vanishes from every
   * derived aggregate immediately (derived).
   */
  withdrawDemandCommitment(
    execution: ExecutionContext,
    actorPersonId: string,
    input: Record<string, unknown>,
  ): Promise<Record<string, unknown>>;

  /**
   * THE SUPPLIER-FACING DERIVATION (protected; guard action
   * `demand.aggregates.evaluate`): the privacy-preserving qualified
   * aggregate demand of one pool — a DERIVED 200 decision re-computed
   * from CURRENT durable records at ONE explicit evaluation anchor.
   * There is NO aggregate/threshold input (every caller field beyond
   * scope/pool identity is ignored); aggregate facts exist only
   * above the frozen privacy floor; below-floor groups are suppressed
   * (counted, never named).
   */
  evaluateQualifiedDemand(
    execution: ExecutionContext,
    actorPersonId: string,
    input: Record<string, unknown>,
  ): Promise<Record<string, unknown>>;

  /**
   * List the AUTHENTICATED ACTOR'S OWN commitments (protected; guard
   * action `demand.commitments.read`): the consumer is the
   * server-resolved actor — there is no consumerPersonId input. This
   * is the ONLY commitment read surface; individual commitments are
   * never exposed through any other route (privacy: consumer records
   * stay private; suppliers see aggregates only).
   */
  listMyDemandCommitments(
    execution: ExecutionContext,
    actorPersonId: string,
    input: Record<string, unknown>,
  ): Promise<readonly Record<string, unknown>[]>;

  /** Fetch one demand pool (public read; tenant-scoped; pool metadata only). */
  getDemandPool(
    execution: ExecutionContext,
    organizationScopeId: string,
    poolId: string,
  ): Promise<Record<string, unknown>>;

  /** List an org's demand pools (public read; pool metadata only). */
  listDemandPools(
    execution: ExecutionContext,
    organizationScopeId: string,
    categoryKey?: string,
    closed?: boolean,
  ): Promise<readonly Record<string, unknown>[]>;

  // -----------------------------------------------------------------
  // NET-W025 — Business procurement pools (privacy/competition-
  // preserving aggregation inside the SAME /demand boundary; explicit
  // buyer-organization/actor authorization; derived supplier-facing
  // minimized demand views). Procurement pools and commitments carry
  // NO lifecycle subject kind (/workflows untouched); the aggregate is
  // a DERIVED view (never stored, never caller-asserted) and the
  // boundary carries NO economic surface (/settlement stays the
  // economic authority).
  // -----------------------------------------------------------------

  /**
   * Create a business procurement pool (protected; guard action
   * `demand.procurement.pools.create`): the acting person BECOMES the
   * pool creator (there is no creatorPersonId input — pool ownership
   * cannot be fabricated by client claims) and must hold an ACTIVE
   * tenant organization membership (server-enforced). The
   * qualification/competition policy (commitment threshold +
   * distinct-organization threshold) is explicit, bounded and
   * versioned on the record.
   */
  createProcurementPool(
    execution: ExecutionContext,
    actorPersonId: string,
    input: Record<string, unknown>,
  ): Promise<{ pool: Record<string, unknown>; created: boolean }>;

  /**
   * Close the procurement pool (protected; guard action
   * `demand.procurement.pools.close`; creator-only): one-way; a
   * closed pool accepts no new commitments and never qualifies
   * (derived).
   */
  closeProcurementPool(
    execution: ExecutionContext,
    actorPersonId: string,
    input: Record<string, unknown>,
  ): Promise<Record<string, unknown>>;

  /**
   * Record a business demand commitment (protected; guard action
   * `demand.procurement.commitments.create`): the acting person
   * BECOMES the submitter (there is no submittedBy input —
   * commitment ownership cannot be fabricated) and must hold ACTIVE
   * membership in BOTH the tenant organization AND the named buyer
   * organization (server-enforced; a failed buyer authorization is
   * indistinguishable from a nonexistent organization). The consent
   * grant is SERVER-WRITTEN (the input may only name the closed
   * "aggregate_disclosure" scope). ONE active commitment per (pool,
   * buyer organization).
   */
  createProcurementCommitment(
    execution: ExecutionContext,
    actorPersonId: string,
    input: Record<string, unknown>,
  ): Promise<{ commitment: Record<string, unknown>; created: boolean }>;

  /**
   * Withdraw the procurement commitment (protected; guard action
   * `demand.procurement.commitments.withdraw`; submitter-only):
   * one-way; the consent revocation — a withdrawn commitment
   * vanishes from every derived aggregate immediately (derived).
   */
  withdrawProcurementCommitment(
    execution: ExecutionContext,
    actorPersonId: string,
    input: Record<string, unknown>,
  ): Promise<Record<string, unknown>>;

  /**
   * THE SUPPLIER-FACING DERIVATION (protected; guard action
   * `demand.procurement.aggregates.evaluate`): the
   * privacy/competition-preserving qualified aggregate of one
   * procurement pool — a DERIVED 200 decision re-computed from
   * CURRENT durable records at ONE explicit evaluation anchor. There
   * is NO aggregate/threshold input (every caller field beyond
   * scope/pool identity is ignored); aggregate facts exist only
   * above BOTH frozen floors (the commitment floor AND the
   * distinct-organization floor); below-floor groups are suppressed
   * (counted, never named); exact quantities, unit prices, budgets
   * and timing never appear (bands/buckets/windows only).
   */
  evaluateQualifiedProcurementDemand(
    execution: ExecutionContext,
    actorPersonId: string,
    input: Record<string, unknown>,
  ): Promise<Record<string, unknown>>;

  /**
   * List the AUTHENTICATED ACTOR'S OWN commitments (protected; guard
   * action `demand.procurement.commitments.read`): the submitter is
   * the server-resolved actor — there is no submittedBy input. This
   * is the ONLY commitment read surface; individual business
   * commitments are never exposed through any other route (privacy:
   * competitor terms stay private; suppliers see minimized
   * aggregates only).
   */
  listMyProcurementCommitments(
    execution: ExecutionContext,
    actorPersonId: string,
    input: Record<string, unknown>,
  ): Promise<readonly Record<string, unknown>[]>;

  /**
   * Fetch one procurement pool (public read; tenant-scoped; pool
   * metadata only — no commitment data).
   */
  getProcurementPool(
    execution: ExecutionContext,
    organizationScopeId: string,
    poolId: string,
  ): Promise<Record<string, unknown>>;

  /**
   * List an org's procurement pools (public read; pool metadata
   * only).
   */
  listProcurementPools(
    execution: ExecutionContext,
    organizationScopeId: string,
    categoryKey?: string,
    closed?: boolean,
  ): Promise<readonly Record<string, unknown>[]>;

  // -----------------------------------------------------------------
  // NET-W026 — Supplier offers and competitive selection (inside the
  // SAME /demand boundary; offers compete only against currently
  // qualified W025 demand; hard eligibility is server-derived;
  // selection is deterministic, auditable and NEVER an economic
  // mutation — /settlement stays the sole economic authority). Offer
  // withdrawal is a one-way field mutation and expiry is derived
  // (/workflows untouched); selection surfaces are pool-creator-only
  // (supplier commercial terms never cross to other pool
  // participants).
  // -----------------------------------------------------------------

  /**
   * Record a supplier offer against a qualified procurement pool
   * (protected; guard action `demand.procurement.offers.create`): the
   * acting person BECOMES the supplier (there is no supplierPersonId
   * input — offer ownership cannot be fabricated by client claims)
   * and must hold an ACTIVE tenant membership (the authorized-
   * supplier gate, server-enforced). The pool must be OPEN and
   * CURRENTLY QUALIFIED (re-derived server-side, never
   * caller-asserted). The consent grant is SERVER-WRITTEN (the input
   * may only name the closed "competitive_selection" scope). ONE
   * active offer per (pool, supplier).
   */
  createSupplierOffer(
    execution: ExecutionContext,
    actorPersonId: string,
    input: Record<string, unknown>,
  ): Promise<{ offer: Record<string, unknown>; created: boolean }>;

  /**
   * Withdraw the supplier offer (protected; guard action
   * `demand.procurement.offers.withdraw`; supplier-only): one-way; a
   * withdrawn offer vanishes from every derived selection
   * immediately (derived).
   */
  withdrawSupplierOffer(
    execution: ExecutionContext,
    actorPersonId: string,
    input: Record<string, unknown>,
  ): Promise<Record<string, unknown>>;

  /**
   * List the AUTHENTICATED ACTOR'S OWN offers (protected; guard
   * action `demand.procurement.offers.read`): the supplier is the
   * server-resolved actor — there is no supplierPersonId input. This
   * is the ONLY offer read surface; individual supplier offers are
   * never exposed through any other route (privacy: supplier
   * commercial terms stay private — PROC-003).
   */
  listMySupplierOffers(
    execution: ExecutionContext,
    actorPersonId: string,
    input: Record<string, unknown>,
  ): Promise<readonly Record<string, unknown>[]>;

  /**
   * THE DERIVED SELECTION VIEW (protected; guard action
   * `demand.procurement.selections.evaluate`; pool-creator-only): the
   * deterministic hard-eligibility + ranking derivation of one pool's
   * active offers at ONE explicit evaluation anchor — a DERIVED 200
   * decision for every outcome (qualified or not, eligible offers or
   * none — the decision is the product). There is NO
   * offer-set/eligibility/ranking/selection input (every caller field
   * beyond scope/pool identity is ignored); buyer commitment data
   * never crosses into the selection view (W025 privacy intact).
   */
  evaluateCompetitiveSelection(
    execution: ExecutionContext,
    actorPersonId: string,
    input: Record<string, unknown>,
  ): Promise<Record<string, unknown>>;

  /**
   * Record the AUTHORITATIVE competitive selection lineage record
   * (protected; guard action `demand.procurement.selections.record`;
   * pool-creator-only): the selection is re-derived INSIDE the
   * authoritative transaction from CURRENT records (in-tx pool,
   * commitments, offers) at ONE explicit anchor — nothing
   * caller-asserted qualifies, ranks or selects. Fails closed when
   * the pool is not currently qualified. The persisted record
   * snapshots the offer set and the selection rationale (PROC-AC-03)
   * and is immutable lineage. A selection is a PROCUREMENT DECISION —
   * never an economic mutation.
   */
  recordCompetitiveSelection(
    execution: ExecutionContext,
    actorPersonId: string,
    input: Record<string, unknown>,
  ): Promise<{ selection: Record<string, unknown>; created: boolean }>;

  /**
   * List the pool's selection lineage records (protected; guard
   * action `demand.procurement.selections.read`; pool-creator-only —
   * the service re-derives the creator gate server-side). The
   * lineage exposes individual supplier offer terms — PROC-003.
   */
  listPoolSelections(
    execution: ExecutionContext,
    actorPersonId: string,
    input: Record<string, unknown>,
  ): Promise<readonly Record<string, unknown>[]>;

  // -----------------------------------------------------------------
  // NET-W027 — Verified savings and counterfactuals (inside the SAME
  // /demand boundary; savings are claims about REALIZED OUTCOMES
  // against explicit evidence-backed baselines — never offers, spend,
  // reputation or caller arithmetic; uncertainty is preserved and
  // the derivation is deterministic + anchor-aware; invalid, stale
  // or insufficient evidence FAILS CLOSED for authoritative use;
  // /settlement stays the sole economic authority and W028 Benefit
  // Pools stay excluded; all savings/baseline surfaces are
  // pool-creator-only; /outcomes stays the measurement authority and
  // /evidence the provenance/truth authority — both consumed through
  // neutral read-only lookups).
  // -----------------------------------------------------------------

  /**
   * Establish the explicit baseline/counterfactual record for a
   * procurement pool (protected; guard action
   * `demand.procurement.baselines.create`; pool-creator-only): the
   * kind/method/version/window/population/value/confidence/
   * provenance/evidence contract is validated fail-closed (a
   * counterfactual REQUIRES a quantified confidence interval), and
   * every evidence reference resolves through the NEUTRAL /evidence
   * lookup (scope + subject binding enforced — cross-tenant is
   * indistinguishable from nonexistent). Evidence sufficiency is
   * re-derived at every evaluation anchor, never stored.
   */
  createProcurementBaseline(
    execution: ExecutionContext,
    actorPersonId: string,
    input: Record<string, unknown>,
  ): Promise<{ baseline: Record<string, unknown>; created: boolean }>;

  /**
   * Invalidate the baseline (protected; guard action
   * `demand.procurement.baselines.invalidate`; pool-creator-only):
   * ONE-WAY with a closed-vocabulary reason — an invalidated baseline
   * can never again support a savings derivation (fail-closed
   * re-derivation, never a status transition).
   */
  invalidateProcurementBaseline(
    execution: ExecutionContext,
    actorPersonId: string,
    input: Record<string, unknown>,
  ): Promise<Record<string, unknown>>;

  /**
   * List the pool's baselines (protected; guard action
   * `demand.procurement.baselines.read`; pool-creator-only — the
   * service re-derives the creator gate server-side).
   */
  listPoolBaselines(
    execution: ExecutionContext,
    actorPersonId: string,
    input: Record<string, unknown>,
  ): Promise<readonly Record<string, unknown>[]>;

  /**
   * THE DERIVED SAVINGS VIEW (protected; guard action
   * `demand.procurement.savings.evaluate`; pool-creator-only): the
   * deterministic, uncertainty-preserving derivation at ONE explicit
   * evaluation anchor — a DERIVED 200 decision for every outcome
   * (supported or not, the decision is the product). There is NO
   * savings value, confidence, supported flag or baseline-facts
   * input (every caller field beyond identities is ignored; the
   * arithmetic is server-owned); observation ids resolve through the
   * NEUTRAL /outcomes lookup.
   */
  evaluateProcurementSavings(
    execution: ExecutionContext,
    actorPersonId: string,
    input: Record<string, unknown>,
  ): Promise<Record<string, unknown>>;

  /**
   * Record the AUTHORITATIVE savings lineage record (protected;
   * guard action `demand.procurement.savings.record`;
   * pool-creator-only): the derivation is re-executed INSIDE the
   * authoritative transaction from CURRENT records at ONE explicit
   * anchor and FAILS CLOSED when the evidence is invalid, stale or
   * insufficient — nothing caller-asserted values or supports the
   * claim. The persisted record is an immutable lineage snapshot
   * (the W026 selection-record precedent). A verified savings claim
   * is a MEASUREMENT DECISION — never an economic mutation.
   */
  recordProcurementSavings(
    execution: ExecutionContext,
    actorPersonId: string,
    input: Record<string, unknown>,
  ): Promise<{ savings: Record<string, unknown>; created: boolean }>;

  /**
   * List the pool's savings lineage records (protected; guard action
   * `demand.procurement.savings.read`; pool-creator-only — the
   * service re-derives the creator gate server-side). Economically
   * authoritative consumers must consume the DERIVED evaluation for
   * current verdicts, never stale snapshots.
   */
  listPoolSavings(
    execution: ExecutionContext,
    actorPersonId: string,
    input: Record<string, unknown>,
  ): Promise<readonly Record<string, unknown>[]>;

  // -----------------------------------------------------------------
  // NET-W028 — Benefit Pools (/benefits).
  // -----------------------------------------------------------------

  /**
   * Create a benefit allocation policy version (protected; guard
   * action `benefits.policy.create`): append-only versioned lineage
   * under the organization-independent mutex (a lineage can never
   * fork); the declaration set (members + weights, eligibility
   * criteria, remainder disposition, benefit type) is validated
   * fail-closed.
   */
  createBenefitPoolPolicy(
    execution: ExecutionContext,
    actorPersonId: string,
    input: Record<string, unknown>,
  ): Promise<{ policy: Record<string, unknown>; created: boolean }>;

  /**
   * List the policy lineage versions (protected; guard action
   * `benefits.policy.read`).
   */
  listBenefitPolicyVersions(
    execution: ExecutionContext,
    actorPersonId: string,
    input: Record<string, unknown>,
  ): Promise<readonly Record<string, unknown>[]>;

  /**
   * Create the Benefit Pool (protected; guard action
   * `benefits.pool.create`): tenant-scoped, funding REFERENCES only —
   * there is deliberately NO funded-amount input (funding resolves
   * server-side at every use; a caller-asserted balance is never
   * authority).
   */
  createBenefitPool(
    execution: ExecutionContext,
    actorPersonId: string,
    input: Record<string, unknown>,
  ): Promise<{ pool: Record<string, unknown>; created: boolean }>;

  /**
   * Close the pool (ONE-WAY; protected; guard action
   * `benefits.pool.close`; pool-creator-only — a closed pool can
   * never re-open or allocate again).
   */
  closeBenefitPool(
    execution: ExecutionContext,
    actorPersonId: string,
    input: Record<string, unknown>,
  ): Promise<Record<string, unknown>>;

  /**
   * List the acting member's benefit pools (protected; guard action
   * `benefits.pool.read`; creator-scoped).
   */
  listBenefitPools(
    execution: ExecutionContext,
    actorPersonId: string,
    input: Record<string, unknown>,
  ): Promise<readonly Record<string, unknown>[]>;

  /**
   * THE DERIVED ALLOCATION VIEW (protected; guard action
   * `benefits.allocation.evaluate`; pool-creator-only): the current
   * funding + eligibility + deterministic plan derivation — a derived
   * 200 decision (no command asserts, stores or waives eligibility).
   */
  evaluatePoolAllocation(
    execution: ExecutionContext,
    actorPersonId: string,
    input: Record<string, unknown>,
  ): Promise<Record<string, unknown>>;

  /**
   * THE ATOMIC ALLOCATION OPERATION (protected; guard action
   * `benefits.allocation.execute`; pool-creator-only): funding +
   * eligibility re-derived INSIDE the authoritative transaction, the
   * deterministic conservation-preserving plan, and (for economic
   * draws) the /settlement reward-allocation draw WithinTx — ONE
   * exactly-once economic unit (everything commits together or
   * nothing does).
   */
  allocatePoolBenefits(
    execution: ExecutionContext,
    actorPersonId: string,
    input: Record<string, unknown>,
  ): Promise<{ allocation: Record<string, unknown>; created: boolean }>;

  /**
   * List the pool's allocation lineage (protected; guard action
   * `benefits.allocation.read`; pool-creator-only).
   */
  listPoolAllocations(
    execution: ExecutionContext,
    actorPersonId: string,
    input: Record<string, unknown>,
  ): Promise<readonly Record<string, unknown>[]>;

  /**
   * THE PRIVACY-PRESERVING MEMBER VIEW (protected; guard action
   * `benefits.member.read`): the acting member sees THEIR OWN shares
   * and totals ONLY — never other members' identities or amounts.
   */
  getMemberBenefitView(
    execution: ExecutionContext,
    actorPersonId: string,
    input: Record<string, unknown>,
  ): Promise<Record<string, unknown>>;

  // -----------------------------------------------------------------
  // NET-W012 — helpful contributions (Proof-of-Helpfulness).
  // -----------------------------------------------------------------

  /**
   * Define the next immutable helpfulness policy version
   * (protected; person actor; deterministic usefulness criteria).
   */
  defineHelpfulnessPolicy(
    execution: ExecutionContext,
    actorPersonId: string,
    input: Record<string, unknown>,
  ): Promise<{ policy: ApiHelpfulnessPolicyView; created: boolean }>;

  /** List a helpfulness policy lineage's versions (public read). */
  listHelpfulnessPolicies(
    execution: ExecutionContext,
    policyId: string,
  ): Promise<readonly ApiHelpfulnessPolicyView[]>;

  /**
   * Create a helpful contribution + its Proof-of-Helpfulness record
   * atomically (protected; person actor = contributor; fail-closed
   * campaign-eligibility enforcement when the opportunity carries a
   * NET-W011 eligibility reference).
   */
  createHelpfulContribution(
    execution: ExecutionContext,
    actorPersonId: string,
    input: Record<string, unknown>,
  ): Promise<{
    contribution: Record<string, unknown>;
    proofOfHelpfulness: ApiProofOfHelpfulnessView;
    created: boolean;
  }>;

  /** Fetch a helpful contribution + its PoH (public read). */
  getHelpfulContribution(
    execution: ExecutionContext,
    contributionId: string,
  ): Promise<{
    contribution: Record<string, unknown>;
    proofOfHelpfulness: ApiProofOfHelpfulnessView;
  } | null>;

  /**
   * Record a protocol-prepared recommendation (protected; person
   * actor; DRAFT contributions only; NEVER publishes — publication is
   * user-controlled).
   */
  prepareHelpfulRecommendation(
    execution: ExecutionContext,
    actorPersonId: string,
    input: Record<string, unknown>,
  ): Promise<ApiProofOfHelpfulnessView>;

  /**
   * Publish a helpful contribution (protected; person actor MUST be
   * the contributor — the user-controlled publication gate; the
   * composite walks the workflow transitions DRAFT → … → SUBMITTED
   * through /workflows and records the publication).
   */
  publishHelpfulContribution(
    execution: ExecutionContext,
    actorPersonId: string,
    input: Record<string, unknown>,
  ): Promise<{
    contribution: Record<string, unknown>;
    proofOfHelpfulness: ApiProofOfHelpfulnessView;
  }>;

  /** Declare a commercial disclosure (protected; contributor-only). */
  declareCommercialDisclosure(
    execution: ExecutionContext,
    actorPersonId: string,
    input: Record<string, unknown>,
  ): Promise<ApiCommercialDisclosureView>;

  /** Retract a commercial disclosure (protected; contributor-only; terminal). */
  retractCommercialDisclosure(
    execution: ExecutionContext,
    actorPersonId: string,
    input: Record<string, unknown>,
  ): Promise<ApiCommercialDisclosureView>;

  /** List a contribution's commercial disclosures (public read). */
  listCommercialDisclosures(
    execution: ExecutionContext,
    contributionId: string,
  ): Promise<readonly ApiCommercialDisclosureView[]>;

  /**
   * Attach an advisory model/heuristic score (protected; advisory
   * only — never qualifies; method identity required).
   */
  attachHelpfulAdvisoryScore(
    execution: ExecutionContext,
    actorPersonId: string,
    input: Record<string, unknown>,
  ): Promise<ApiProofOfHelpfulnessView>;

  /** Attach a qualifying-basis reference (protected; lookup-verified). */
  attachHelpfulnessBasis(
    execution: ExecutionContext,
    actorPersonId: string,
    input: Record<string, unknown>,
  ): Promise<ApiProofOfHelpfulnessView>;

  /**
   * Evaluate the Proof-of-Helpfulness deterministically (protected;
   * truth authorities re-resolved at evaluation; pure engine).
   */
  evaluateHelpfulness(
    execution: ExecutionContext,
    actorPersonId: string,
    input: Record<string, unknown>,
  ): Promise<ApiProofOfHelpfulnessView>;

  // -----------------------------------------------------------------
  // NET-W013 — quality, moderation and anti-spam controls.
  // -----------------------------------------------------------------

  /**
   * Define the next immutable quality policy version (protected;
   * person actor; deterministic evaluation criteria).
   */
  defineQualityPolicy(
    execution: ExecutionContext,
    actorPersonId: string,
    input: Record<string, unknown>,
  ): Promise<{ policy: ApiQualityPolicyView; created: boolean }>;

  /** List a quality policy lineage's versions (public read). */
  listQualityPolicies(
    execution: ExecutionContext,
    policyId: string,
  ): Promise<readonly ApiQualityPolicyView[]>;

  /**
   * Attach an advisory quality score manually (protected; advisory
   * only; method identity required; provider identity optional).
   */
  attachAdvisoryQualityScore(
    execution: ExecutionContext,
    actorPersonId: string,
    input: Record<string, unknown>,
  ): Promise<ApiAdvisoryQualityScoreView>;

  /** List a contribution's advisory quality scores (public read). */
  listAdvisoryQualityScores(
    execution: ExecutionContext,
    contributionId: string,
  ): Promise<readonly ApiAdvisoryQualityScoreView[]>;

  /**
   * Generate an advisory quality score through the provider-neutral
   * LLM port (protected; the FIRST LlmPort consumer — neutral
   * record-level facts only; the output is structurally
   * non-authoritative evidence with provider identity preserved).
   */
  generateAdvisoryQualityScore(
    execution: ExecutionContext,
    actorPersonId: string,
    input: Record<string, unknown>,
  ): Promise<{
    advisoryScore: ApiAdvisoryQualityScoreView;
    provider: string;
    modelRef: string;
    authoritative: false;
  }>;

  /**
   * Preview a deterministic quality evaluation (protected; pure
   * engine over re-resolved facts; no persistence).
   */
  previewQualityEvaluation(
    execution: ExecutionContext,
    actorPersonId: string,
    input: Record<string, unknown>,
  ): Promise<ApiQualityEvaluationPreviewView>;

  /**
   * Record the authoritative quality evaluation (protected; the
   * pinned policy is same-scope-validated IN-TX; append-only
   * supersession).
   */
  recordQualityEvaluation(
    execution: ExecutionContext,
    actorPersonId: string,
    input: Record<string, unknown>,
  ): Promise<{ evaluation: ApiQualityEvaluationView; created: boolean }>;

  /**
   * A contribution's quality-evaluation history + latest (public
   * read).
   */
  getQualityEvaluationHistory(
    execution: ExecutionContext,
    contributionId: string,
  ): Promise<{
    evaluations: readonly ApiQualityEvaluationView[];
    latest: ApiQualityEvaluationView | null;
  }>;

  /**
   * Record a moderation decision (protected; person actor —
   * moderator-controlled; append-only history). When the decision
   * carries a spam/abuse reason, the composite emits ONE
   * evidence-backed risk signal into the EXISTING /disputes risk
   * authority (no second fraud authority).
   */
  recordModerationDecision(
    execution: ExecutionContext,
    actorPersonId: string,
    input: Record<string, unknown>,
  ): Promise<{
    decision: ApiModerationDecisionView;
    riskSignal: Record<string, unknown> | null;
    signalCreated: boolean;
  }>;

  /** A contribution's append-only moderation history (public read). */
  listModerationDecisions(
    execution: ExecutionContext,
    contributionId: string,
  ): Promise<readonly ApiModerationDecisionView[]>;

  /** A contribution's DERIVED moderation status (public read). */
  getModerationSummary(
    execution: ExecutionContext,
    contributionId: string,
  ): Promise<ApiModerationSummaryView>;

  // -----------------------------------------------------------------
  // NET-W014 — reward and settlement integration (issue #27).
  // -----------------------------------------------------------------

  /**
   * Recognize qualifying verified contribution value as canonical
   * PENDING economic value (protected; the deterministic qualification
   * gate: VERIFIED lifecycle + QUALIFIED Proof-of-Helpfulness +
   * moderation + quality floor; the AUTHORITATIVE source gate runs
   * inside /settlement's recordPendingValue as always).
   */
  recognizeContributionValue(
    execution: ExecutionContext,
    actorPersonId: string,
    input: Record<string, unknown>,
  ): Promise<{
    value: Record<string, unknown>;
    created: boolean;
    proofOfHelpfulnessId: string;
  }>;

  /**
   * Execute a declared campaign clearing rule — the deterministic
   * draw of ONE mature value record through the canonical /settlement
   * primitive the rule selects (protected; capped by the rule's
   * maxDrawAmount; risk/dispute-gated over the record + beneficiary +
   * all upstream sources; recorded as campaign bookkeeping).
   */
  executeCampaignClearing(
    execution: ExecutionContext,
    actorPersonId: string,
    input: Record<string, unknown>,
  ): Promise<{
    drawKind: string;
    allocation?: Record<string, unknown>;
    issuance?: Record<string, unknown>;
    obligation?: Record<string, unknown>;
    created: boolean;
    value: Record<string, unknown>;
    campaignEventCount: number;
  }>;

  /**
   * Feed ONE evidence-backed reputation input from a MATERIAL
   * settlement outcome (protected; MATURE/CONSUMED value records
   * only; the reputation input service DERIVES the basis — never
   * caller-asserted; references only, no amounts).
   */
  applySettlementReputationEffect(
    execution: ExecutionContext,
    actorPersonId: string,
    input: Record<string, unknown>,
  ): Promise<{
    input: Record<string, unknown>;
    created: boolean;
    valueState: string;
  }>;

  // -----------------------------------------------------------------
  // NET-W020 — cross-promotion clearing (issue #39).
  // -----------------------------------------------------------------

  /**
   * Execute ONE cross-promotion clearing — the composition-root
   * composite over the existing authorities (protected; the
   * deterministic draw of a qualifying source contribution's MATURE
   * value through the canonical /settlement primitive the campaign's
   * clearing rule selects, against a settlement-ready target placement
   * (the W019 derived gate); risk/dispute-gated; recorded as the
   * durable clearing record + campaign bookkeeping; exactly-once per
   * idempotency key and per contribution-placement pair).
   */
  executeCrossPromotionClearing(
    execution: ExecutionContext,
    actorPersonId: string,
    input: Record<string, unknown>,
  ): Promise<{
    drawKind: string;
    clearing: Record<string, unknown>;
    allocation?: Record<string, unknown>;
    issuance?: Record<string, unknown>;
    obligation?: Record<string, unknown>;
    created: boolean;
    value: Record<string, unknown>;
    campaignEventCount: number;
  }>;

  /**
   * The DERIVED cross-promotion clearing eligibility view (public
   * read; re-derived from CURRENT authoritative records on every
   * call — never stored, never caller-asserted).
   */
  evaluateCrossPromotionClearing(
    execution: ExecutionContext,
    input: Record<string, unknown>,
  ): Promise<Record<string, unknown>>;

  /** One clearing record by id (public; tenant-scoped). */
  getCrossPromotionClearing(
    execution: ExecutionContext,
    organizationScopeId: string,
    clearingId: string,
  ): Promise<Record<string, unknown>>;

  /** The tenant's clearing records (public; tenant-scoped). */
  listCrossPromotionClearings(
    execution: ExecutionContext,
    organizationScopeId: string,
  ): Promise<readonly Record<string, unknown>[]>;
}

export type { ExecutionContext };
