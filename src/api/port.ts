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
    | "outcome_measurement";
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
}

export type { ExecutionContext };
