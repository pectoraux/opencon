/**
 * Bootstrap — composition root.
 *
 * Wires the modular-monolith runtime: configuration (fail-fast), logger,
 * audit writer, object store, secret provider, job queue, worker loop
 * (with a representative non-domain ECHO job handler for AC-03/AC-05),
 * module registry (registers every boundary), health aggregator, and
 * the HTTP API server.
 *
 * This is the ONLY place that imports concrete adapter/provider
 * implementations for wiring (the architecture check treats
 * `src/bootstrap/**` as the composition root and permits any import).
 */

import { loadConfig } from "../config/provider.ts";
import { createLogger, type LogEntrySink } from "../observability/logger.ts";
import { HealthAggregator } from "../observability/health.ts";
import { createInMemoryAuditWriter } from "../audit/audit-writer.ts";
// NET-W004-AC-07 remediation: the runtime's audit writer is the
// TRANSACTIONAL audit writer. The workflow service obtains a
// transaction-scoped buffer via forTransaction(tx) so the audit record
// commits atomically with the lifecycle mutation + the idempotency
// record (same AuthorityTransaction). The concrete implementation is
// wired HERE (composition root) — domain tiers consume only the core
// contract (src/core/audit.ts TransactionalAuditWriter).
import { createTransactionalAuditWriter } from "../audit/transactional-audit-writer.ts";
import { createInMemoryObjectStore } from "../object-storage/in-memory-store.ts";
import { createEnvSecretProvider, buildSecretCatalog } from "../secrets/env-provider.ts";
import { createInMemoryJobQueue } from "../queues/in-memory-queue.ts";
import { createWorkerLoop } from "../workers/worker-loop.ts";
import { createModuleRegistry } from "./module-registry.ts";
import { createApiServer } from "../api/server.ts";
import {
  createExecutionContext,
  runWithExecutionContextAsync,
  deriveExecutionContext,
  getExecutionContext,
} from "../core/execution-context.ts";
import type { ConfigurationProvider } from "../core/config.ts";
import type { Logger } from "../core/logger.ts";
import type { TransactionalAuditWriter } from "../core/audit.ts";
import type { ObjectStore } from "../core/object-store.ts";
import type { SecretProvider } from "../core/secrets.ts";
import type { JobQueue } from "../core/queue.ts";
import type { JobHandler } from "../core/queue.ts";
import type { ModuleRegistry } from "../core/module.ts";
import type {
  ApiAuth,
  ApiCommands,
  ApiReputationProofView,
  ApiSignedAttestationView,
} from "../api/port.ts";
import type { ApiServer } from "../api/server.ts";
import type { PostgresAuthority } from "../core/postgres-authority.ts";
import type { CoordinationService } from "../core/coordination.ts";
import type { ProviderSelection } from "./provider-selection.ts";
// NET-W002 domain wiring (composition root imports concrete in-memory
// implementations for wiring — the only place permitted to do so).
import { createInMemoryIdentityRepository } from "../identity/in-memory-identity-repository.ts";
import { createIdentityService } from "../identity/identity-service.ts";
import { createInMemoryPrincipalResolver } from "../identity/in-memory-principal-resolver.ts";
import { createInMemoryOrganizationRepository, createInMemoryMembershipRepository } from "../organizations/in-memory-organization-repository.ts";
import { createOrganizationService, createMembershipService } from "../organizations/organization-service.ts";
import { createInMemoryParticipantRepository, createInMemoryPolicyRepository } from "../participants/in-memory-participant-repository.ts";
import { createParticipantService } from "../participants/participant-service.ts";
import { createAuthorizationService } from "../participants/authorization-service.ts";
import { createPolicyService } from "../participants/policy-service.ts";
import type { IdentityService } from "../identity/identity-service.ts";
import type { OrganizationService, MembershipService } from "../organizations/organization-service.ts";
import type { ParticipantService } from "../participants/participant-service.ts";
import type { AuthorizationService, MembershipLookup, IdentityLookup } from "../participants/port.ts";
import type { PolicyService } from "../participants/policy-service.ts";
// NET-W003 composition-root provider selection. The bootstrap tier is
// the ONLY non-adapter tier permitted to import the concrete
// PostgresAuthorityAdapter / RedisCoordinationAdapter classes; it does
// so via selectProviders, which resolves the connection strings
// through the SecretProvider and constructs the REAL adapters in
// configured production/staging deployments (failing fast when
// required provider configuration is missing). In development/test it
// selects the clearly-marked test/dev doubles.
import { selectProviders } from "./provider-selection.ts";
// NET-W003 IdempotencyStore (PostgresAuthority-backed; exactly-once-per-key).
import { createPostgresIdempotencyStore } from "../persistence/idempotency-store.ts";
import type { IdempotencyStore } from "../core/idempotency.ts";
// NET-W004 domain wiring (composition root imports concrete in-memory
// implementations for wiring — the only place permitted to do so).
import { createAuthorityOpportunityRepository } from "../opportunities/authority-opportunity-repository.ts";
import { createOpportunityService } from "../opportunities/opportunity-service.ts";
import { createAuthorityContributionRepository } from "../contributions/authority-contribution-repository.ts";
import { createContributionService } from "../contributions/contribution-service.ts";
// NET-W012 helpful contributions: the helpfulness repositories + service.
import {
  createAuthorityCommercialDisclosureRepository,
  createAuthorityHelpfulnessPolicyRepository,
  createAuthorityProofOfHelpfulnessRepository,
} from "../contributions/authority-helpfulness-repository.ts";
import { createHelpfulnessService } from "../contributions/helpfulness-service.ts";
// NET-W013 quality/moderation/anti-spam: the quality + moderation
// repositories and services, and the provider-neutral LLM port whose
// FIRST concrete consumption (advisory quality scoring) happens at
// the composition root below.
import {
  createAuthorityAdvisoryQualityScoreRepository,
  createAuthorityModerationDecisionRepository,
  createAuthorityQualityEvaluationRepository,
  createAuthorityQualityPolicyRepository,
} from "../contributions/authority-quality-repository.ts";
import { createQualityService } from "../contributions/quality-service.ts";
import { createModerationService } from "../contributions/moderation-service.ts";
import type {
  ModerationService,
  QualityService,
} from "../contributions/port.ts";
import type { LlmPort } from "../llm/port.ts";
import type { ProviderAdapter } from "../core/adapter.ts";
import { echoLlmProvider } from "../llm/providers/echo-llm-provider.ts";
import { createWorkflowService } from "../workflows/workflow-service.ts";
import { createLifecycleRepository } from "../workflows/lifecycle-repository.ts";
import type { OpportunityService } from "../opportunities/port.ts";
import type {
  ContributionService,
  HelpfulnessService,
  OpportunityLookup,
} from "../contributions/port.ts";
import type { WorkflowService, TransitionAuthorizer } from "../workflows/port.ts";
import type { TransitionRequest, TransitionResult } from "../core/workflow.ts";
// NET-W005 evidence boundary: evidence records (deterministic grades +
// confidence/uncertainty), provider-neutral outcome claims,
// verifier-neutral attestations, cryptographic commitments for
// sensitive material, deterministic aggregation, and the
// Proof-of-Value model whose lifecycle transitions route through the
// workflow service (the SOLE lifecycle authority).
import { createAuthorityEvidenceRepository } from "../evidence/authority-evidence-repository.ts";
import { createEvidenceService } from "../evidence/evidence-service.ts";
import { createAuthorityOutcomeClaimRepository } from "../evidence/authority-outcome-claim-repository.ts";
import { createOutcomeClaimService } from "../evidence/outcome-claim-service.ts";
import { createAuthorityAttestationRepository } from "../evidence/authority-attestation-repository.ts";
import { createAttestationService } from "../evidence/attestation-service.ts";
import { createAuthorityProofOfValueRepository } from "../evidence/authority-proof-of-value-repository.ts";
import { createProofOfValueService } from "../evidence/proof-of-value-service.ts";
// NET-W005 remediation (architect review on PR #10): attestation
// signing selection is a composition-root concern that FAILS CLOSED —
// production/staging require a configured ATTESTATION_SIGNING_KEY
// secret or an explicit production signer/verifier adapter pair; the
// well-known dev default is permitted only in development/test.
import {
  selectAttestationSigning,
  selectVersionedAttestationSigning,
  type AttestationSigningMode,
} from "./attestation-signing.ts";
import type {
  AttestationService,
  AttestationSigner,
  AttestationVerifier,
  CreateEvidenceInput,
  CreateOutcomeClaimInput,
  EvidenceService,
  OutcomeClaimService,
  ProofOfValueService,
  ReputationInputCoverageFacts,
  ReputationInputCoverageLookup,
  SettlementValueCoverageFacts,
  SettlementValueCoverageLookup,
  SignedAttestation,
  SignedAttestationService,
  SignedAttestationSigner,
  SignedAttestationVerifier,
  SubjectLookup,
} from "../evidence/port.ts";
import { createAuthoritySignedAttestationRepository } from "../evidence/authority-signed-attestation-repository.ts";
import { createSignedAttestationService } from "../evidence/signed-attestation-service.ts";
// NET-W031 composes the W029 machinery: the FROZEN algorithm +
// key-reference vocabularies are injected INTO the reputation proof
// service as data (single source of truth — no mirrored constants;
// the composition root is the ONLY join).
import {
  SIGNED_ATTESTATION_ALGORITHMS,
  SIGNED_ATTESTATION_KEY_REFERENCES,
  SIGNED_ATTESTATION_KEY_REFERENCE_BY_ALGORITHM,
} from "../evidence/port.ts";
// NET-W006 outcomes boundary: first-class immutable/append-corrected
// outcome observations, distinct deterministic/probabilistic/
// experimental attribution representation, experiments/holdouts +
// incrementality (derived causal status), explicit counterfactual
// baselines, provider-neutral provider ingestion, and the
// measured-outcome maturation lifecycle (transitions route through
// the workflow service — the SOLE lifecycle authority). Measurement
// establishes facts + uncertainty; it NEVER creates economic
// authority.
import { createAuthorityOutcomeObservationRepository } from "../outcomes/authority-outcome-observation-repository.ts";
import { createOutcomeObservationService } from "../outcomes/observation-service.ts";
import { createAuthorityMeasurementExperimentRepository } from "../outcomes/authority-measurement-experiment-repository.ts";
import { createMeasurementExperimentService } from "../outcomes/experiment-service.ts";
import { createAuthorityAttributionRepository } from "../outcomes/authority-attribution-repository.ts";
import { createAttributionService } from "../outcomes/attribution-service.ts";
import { createAuthorityIncrementalityObservationRepository } from "../outcomes/authority-incrementality-repository.ts";
import { createIncrementalityService } from "../outcomes/incrementality-service.ts";
import { createAuthorityCounterfactualBaselineRepository } from "../outcomes/authority-baseline-repository.ts";
import { createBaselineService } from "../outcomes/baseline-service.ts";
import { createAuthorityMeasuredOutcomeRepository } from "../outcomes/authority-measured-outcome-repository.ts";
import { createMeasuredOutcomeService } from "../outcomes/measured-outcome-service.ts";
import type {
  AttributionService,
  BaselineService,
  CreateAttributionInput,
  CreateCounterfactualBaselineInput,
  CreateIncrementalityObservationInput,
  CreateMeasuredOutcomeInput,
  CreateMeasurementExperimentInput,
  CreateOutcomeObservationInput,
  EvidenceRecordLookup,
  IncrementalityService,
  MeasurementExperimentService,
  MeasurementSubjectLookup,
  MeasuredOutcomeService,
  OutcomeClaimLookup,
  OutcomeObservationService,
} from "../outcomes/port.ts";
// NET-W006 measurement boundary: the provider-neutral adapter contract
// + the clearly-marked reference adapter. Concrete platform adapters
// (browser/platform + iOS attribution) arrive in NET-W022 behind the
// SAME neutral port.
import type {
  MeasurementIngestionService,
  MeasurementProviderAdapter,
} from "../measurement/port.ts";
import { echoMeasurementProvider } from "../measurement/providers/echo-measurement-provider.ts";
// NET-W022: the reference attribution adapters (ADAPTER-003 browser/
// platform attribution + ADAPTER-004 iOS attribution), the provider
// registration boundary, and the neutral ingestion service. All are
// ADAPTER tier: they import core + the neutral port only; the raw
// vendor shapes never cross into /outcomes (architecture-lock
// §14.24/§14.25).
import { BrowserAttributionAdapter } from "../measurement/providers/browser-attribution-adapter.ts";
import { IOSAttributionAdapter } from "../measurement/providers/ios-attribution-adapter.ts";
import { createMeasurementProviderRegistry } from "../measurement/registry.ts";
import { createMeasurementIngestionService } from "../measurement/ingestion.ts";
// NET-W023: the OpenRTB / supply-chain adapters (ADAPTER-001..002) —
// the reference provider adapter, the provider registration boundary
// and the neutral ingress service live in the /adapters boundary
// (adapter tier: core + neutral ports only; no domain imports). The
// delivery-notice measurement adapter (the sanctioned measurement
// routing path) implements the W022 OPTIONAL normalizeReport contract
// from the /measurement provider tier and is registered in the
// measurement registry below.
import { OpenRtbReferenceAdapter } from "../adapters/openrtb/reference-adapter.ts";
import { createOpenRtbProviderRegistry } from "../adapters/registry.ts";
import { createOpenRtbIngressService } from "../adapters/ingress.ts";
import { OpenRtbDeliveryNoticeAdapter } from "../measurement/providers/openrtb-delivery-adapter.ts";
import type {
  ExternalInventorySupplyLookup,
  OpenRtbIngressService,
  OpenRtbProviderAdapter,
} from "../adapters/port.ts";

/** NET-W022 secret key names (resolved ONLY through the SecretProvider). */
export const MEASUREMENT_BROWSER_ATTRIBUTION_SECRET_KEY =
  "MEASUREMENT_BROWSER_ATTRIBUTION_KEY" as const;
export const MEASUREMENT_IOS_ATTRIBUTION_SECRET_KEY =
  "MEASUREMENT_IOS_ATTRIBUTION_KEY" as const;
/** NET-W023 secret key name (the delivery-notice HMAC verification key). */
export const MEASUREMENT_OPENRTB_DELIVERY_SECRET_KEY =
  "MEASUREMENT_OPENRTB_DELIVERY_KEY" as const;
/**
 * NET-W023 PR #47 remediation secret key name: the seller-authorization
 * trust channel HMAC key (supply-chain verification). Resolved ONLY
 * through the SecretProvider at composition time; present → the
 * ingress authenticates trust envelopes; absent → NO chain can be
 * `verified` (fail closed). NEVER logged, persisted, or echoed into
 * audit/error payloads (PRIV-002).
 */
export const SELLER_AUTHORIZATION_TRUST_SECRET_KEY =
  "SELLER_AUTHORIZATION_TRUST_KEY" as const;
// NET-W007 reputation boundary: the multidimensional reputation engine
// — evidence-backed inputs (basis DERIVED from upstream records
// through neutral lookups), immutable versioned deterministic scoring
// policies, pure deterministic scoring + time decay (explicit
// referenceAt, no wall clock), and append-only reconstructable
// snapshots/history. Reputation is a derived trust signal: NOT
// purchasable (no spend/wealth/credit/raw-activity channel) and
// separate from the economic ledger.
import { createAuthorityReputationPolicyRepository } from "../reputation/authority-policy-repository.ts";
import { createReputationPolicyService } from "../reputation/policy-service.ts";
import { createAuthorityReputationInputRepository } from "../reputation/authority-input-repository.ts";
import { createReputationInputService } from "../reputation/input-service.ts";
import { createAuthorityReputationSnapshotRepository } from "../reputation/authority-snapshot-repository.ts";
import { createReputationSnapshotService } from "../reputation/snapshot-service.ts";
// NET-W031 (additive): portable reputation proofs — the DERIVED,
// aggregate-disclosure, self-contained presentation layer over the
// SAME /reputation authority, composing the W029 versioned signing
// machinery through the NEUTRAL contracts declared on the reputation
// port (wired below; the composition root is the ONLY join).
import { createAuthorityReputationProofRepository } from "../reputation/authority-proof-repository.ts";
import { createReputationProofService } from "../reputation/proof-service.ts";
import type {
  ComputeReputationScoresInput,
  CreateReputationScoringPolicyInput,
  PresentedReputationProof,
  RecordReputationInputInput,
  RecordReputationSnapshotInput,
  ReputationInputService,
  ReputationPolicyService,
  ReputationProof,
  ReputationProofService,
  ReputationProofSigner,
  ReputationProofSigningVocabulary,
  ReputationProofVerifier,
  ReputationSnapshotService,
} from "../reputation/port.ts";
// NET-W008 settlement boundary: the economic ledger — pending/mature
// value with an explicit maturation gate (verified-source input gate:
// a VERIFIED PoV / VERIFIED measured outcome / platform-attested-
// provider evidence), PoV-gated Participation Credit issuance
// (architecture-lock invariant 20), deterministic versioned reward
// allocation, cash obligations with internal settlement state, and
// explicit cash↔credits conversions — all on a double-entry ledger
// whose every transaction balances per unit (conservation) and whose
// balances derive from the immutable entry set (reconstructable).
import { createAuthorityEconomicLedgerRepository } from "../settlement/authority-ledger-repository.ts";
import { createAuthorityEconomicValueRepository } from "../settlement/authority-value-repository.ts";
import { createAuthorityCreditIssuanceRepository } from "../settlement/authority-credit-repository.ts";
import { createAuthorityRewardPolicyRepository } from "../settlement/authority-reward-policy-repository.ts";
import { createAuthorityRewardAllocationRepository } from "../settlement/authority-reward-repository.ts";
import { createAuthorityCashObligationRepository } from "../settlement/authority-cash-repository.ts";
import { createAuthorityConversionRepository } from "../settlement/authority-conversion-repository.ts";
import { createAuthorityStakeRepository } from "../settlement/authority-stake-repository.ts";
import { createEconomicValueService } from "../settlement/value-service.ts";
import { createCreditService } from "../settlement/credit-service.ts";
import { createRewardPolicyService, createRewardService, allocationAccountIds } from "../settlement/reward-service.ts";
import { createCashService } from "../settlement/cash-service.ts";
import { createConversionService } from "../settlement/conversion-service.ts";
import { createStakeService } from "../settlement/stake-service.ts";
import { createEconomicLedgerService } from "../settlement/ledger-service.ts";
import {
  createCrossPromotionClearingService,
  clearingPairLockKey,
  CrossPromotionClearingConflictError,
} from "../settlement/clearing-service.ts";
import { clearingOperationClass } from "../settlement/clearing-eligibility.ts";
import { createAuthorityCrossPromotionClearingRepository } from "../settlement/authority-clearing-repository.ts";
import type {
  AllocateRewardsInput,
  CashService,
  ConversionService,
  CreateRewardPolicyInput,
  CreditService,
  CrossPromotionClearingService,
  EconomicLedgerService,
  EconomicValueService,
  ExternalSettlementProviderAdapter,
  ExternalSettlementService,
  IssueCreditsInput,
  RecordCashObligationInput,
  RecordConversionInput,
  RecordPendingValueInput,
  RewardPolicyService,
  RewardService,
  StakeService,
} from "../settlement/port.ts";

// NET-W030 — external settlement adapters (ADAPTER-008; issue #61):
// the reference provider adapter (adapter tier — structurally
// implements the NEUTRAL contract declared in the /settlement port;
// the composition root is the ONLY join) + the trust-channel
// selection (per-provider HMAC material resolved exclusively through
// the SecretProvider — fail closed when absent) + the fact
// repository and the authenticated ingestion/reconciliation service
// INSIDE the /settlement authority (facts, never economic mutation).
import { ExternalSettlementReferenceAdapter } from "../adapters/settlement/reference-adapter.ts";
import {
  selectExternalSettlementAuthentication,
  EXTERNAL_SETTLEMENT_TRUST_SECRET_KEYS,
} from "./external-settlement-authentication.ts";
import { createAuthorityExternalSettlementFactRepository } from "../settlement/authority-external-settlement-repository.ts";
import { createExternalSettlementService } from "../settlement/external-settlement-service.ts";

// NET-W009 disputes boundary (the Phase-3 Trust domain): the fraud/risk
// foundation — first-class provenance-backed risk signals, versioned
// deterministic risk policies (org-independent lineage mutex),
// multi-signal provenance-preserving assessments (pure deterministic
// engine), evidence-backed review cases with append-only decision
// history, and the control-decision registry the composition-root
// economic gates consult (lock invariant 21 enforcement point). The
// boundary is a decision-support and CONTROL authority ONLY: no
// economic mutation, no reputation mutation, no lifecycle mutation.
import { createAuthorityRiskSignalRepository } from "../disputes/authority-signal-repository.ts";
import { createAuthorityRiskPolicyRepository } from "../disputes/authority-policy-repository.ts";
import { createAuthorityRiskAssessmentRepository } from "../disputes/authority-assessment-repository.ts";
import { createAuthorityRiskCaseRepository } from "../disputes/authority-case-repository.ts";
import { createAuthorityRiskControlRepository } from "../disputes/authority-control-repository.ts";
import { createAuthorityDisputeRepository } from "../disputes/authority-dispute-repository.ts";
import { createRiskSignalService } from "../disputes/signal-service.ts";
import { createRiskPolicyService } from "../disputes/policy-service.ts";
import { createRiskAssessmentService } from "../disputes/assessment-service.ts";
import { createRiskCaseService } from "../disputes/case-service.ts";
import { createRiskControlService } from "../disputes/control-service.ts";
import { createDisputeService } from "../disputes/dispute-service.ts";
import {
  createAuthorityCampaignRepository,
  createAuthorityCampaignPolicyRepository,
} from "../campaigns/authority-campaign-repository.ts";
import { createCampaignService, campaignLockKey } from "../campaigns/campaign-service.ts";
import { createCampaignMatchingService } from "../campaigns/matching-service.ts";
import { createAuthorityCampaignMatchRunRepository } from "../campaigns/authority-match-run-repository.ts";
import {
  createAuthorityCreatorProfileRepository,
  createAuthorityCreatorProfileVersionRepository,
} from "../creators/authority-creator-repository.ts";
import { createCreatorService } from "../creators/creator-service.ts";
import { createAuthorityCreatorMatchRunRepository } from "../creators/authority-match-run-repository.ts";
import { createCreatorMatchingService } from "../creators/matching-service.ts";
import {
  createAuthorityEngagementRepository,
  createAuthorityAcceptancePolicyRepository,
  createAuthorityUsageRightsRepository,
  createAuthorityUgcProductionRepository,
  createAuthorityUgcDeliverableRepository,
  createAuthorityUgcSubmissionRepository,
  createAuthorityEngagementBatchRepository,
} from "../creators/authority-engagement-repositories.ts";
import { createCreatorEngagementService } from "../creators/engagement-service.ts";
import {
  createAuthorityCommercialRelationshipRepository,
  createAuthorityDisclosureDeclarationRepository,
  createAuthorityPublicationRepository,
} from "../creators/authority-sponsorship-repositories.ts";
import { createCreatorSponsorshipService } from "../creators/sponsorship-service.ts";
import type {
  CreatorEngagementService,
  CreatorSponsorshipService,
  EngagementCampaignLookup,
  EngagementOpportunityLookup,
  EngagementContributionLookup,
  ProductionEvidenceLookup,
  CampaignDisclosurePolicyLookup,
  SponsorshipWorkflowPort,
} from "../creators/port.ts";
// NET-W019 inventory (supply registration + placement context).
import {
  createAuthorityInventoryItemRepository,
  createAuthorityPlacementRepository,
} from "../inventory/authority-inventory-repositories.ts";
import { createInventoryService } from "../inventory/inventory-service.ts";
import { evaluatePlacementEligibility } from "../inventory/eligibility-engine.ts";
import type {
  InventoryCampaignLookup,
  InventoryEvidenceLookup,
  InventoryItem,
  InventoryService,
  PlacementRecord,
} from "../inventory/port.ts";
// NET-W024 demand (consumer demand pools).
import {
  createAuthorityDemandCommitmentRepository,
  createAuthorityDemandPoolRepository,
} from "../demand/authority-demand-repositories.ts";
import { createDemandService } from "../demand/demand-service.ts";
import type {
  DemandCommitment,
  DemandMembershipLookup,
  DemandPool,
  DemandService,
  QualifiedDemandAggregate,
} from "../demand/port.ts";
// NET-W025 demand (business procurement pools — the SAME /demand
// boundary extended, NOT a second demand/procurement authority).
import {
  createAuthorityProcurementCommitmentRepository,
  createAuthorityProcurementPoolRepository,
} from "../demand/authority-procurement-repositories.ts";
import { createProcurementService } from "../demand/procurement-pool-service.ts";
import type {
  ProcurementCommitment,
  ProcurementPool,
  ProcurementService,
  QualifiedProcurementAggregate,
} from "../demand/port.ts";
// NET-W026 demand (supplier offers + competitive selection — the
// SAME /demand boundary extended AGAIN, NOT a second demand/
// procurement/selection authority).
import {
  createAuthorityCompetitiveSelectionRepository,
  createAuthoritySupplierOfferRepository,
} from "../demand/authority-supplier-offer-repositories.ts";
import { createSupplierOfferService } from "../demand/supplier-offer-service.ts";
import type {
  CompetitiveSelection,
  CompetitiveSelectionView,
  SupplierOffer,
  SupplierOfferService,
} from "../demand/port.ts";
// NET-W027 demand (verified savings and counterfactuals — the SAME
// /demand boundary extended AGAIN, NOT a second demand/procurement
// authority; /outcomes stays the measurement authority and
// /evidence stays the provenance/truth authority — both are
// consumed read-only through NEUTRAL lookups wired below).
import {
  createAuthorityProcurementBaselineRepository,
  createAuthorityProcurementSavingsRepository,
} from "../demand/authority-savings-repositories.ts";
import { createProcurementSavingsService } from "../demand/savings-service.ts";
import type {
  ProcurementBaseline,
  ProcurementSavings,
  ProcurementSavingsEvidenceLookup,
  ProcurementSavingsOutcomeLookup,
  ProcurementSavingsService,
  ProcurementSavingsView,
} from "../demand/port.ts";
import {
  createAuthorityBenefitPoolAllocationRepository,
  createAuthorityBenefitPoolPolicyRepository,
  createAuthorityBenefitPoolRepository,
} from "../benefits/authority-benefit-repositories.ts";
import { createBenefitPoolService } from "../benefits/benefit-pool-service.ts";
import type {
  BenefitEconomicDrawPort,
  BenefitMembershipLookup,
  BenefitPoolService,
  BenefitRewardPolicyLookup,
  BenefitSavingsFundingLookup,
  BenefitValueFundingFacts,
  BenefitValueFundingLookup,
} from "../benefits/port.ts";
import { valueRecordLockKey } from "../settlement/posting.ts";
import type {
  ActivateRiskControlInput,
  AppealDisputeInput,
  CreateRiskPolicyInput,
  CreateRiskSignalInput,
  OpenDisputeInput,
  OpenRiskCaseInput,
  RecordRiskAssessmentInput,
  RecordRiskCaseDecisionInput,
  RejectDisputeInput,
  ResolveDisputeInput,
  ResolveRiskControlInput,
  RiskAssessmentService,
  RiskCaseService,
  RiskControlService,
  RiskPolicyService,
  RiskSignalService,
  SupersedeRiskSignalInput,
  DisputeService,
} from "../disputes/port.ts";
import type {
  CampaignMatchInventoryItemView,
  CampaignMatchOutcomeLookup,
  CampaignMatchReputationLookup,
  CampaignMatchRunRecord,
  CampaignMatchSafetyLookup,
  CampaignMatchSupplyLookup,
  CampaignMatchingService,
  CampaignPolicySections,
  CampaignService,
  DefineCampaignPolicyInput,
  RunCampaignMatchInput,
} from "../campaigns/port.ts";
import type {
  CreatorAcceptancePolicyRecord,
  CreatorMatchRunRecord,
  CreatorProfileRecord,
  CreatorProfileSections,
  CreatorProfileVersion,
  CreatorService,
  CreatorMatchingService,
  Engagement,
  EngagementBatchOutcomeRecord,
  EngagementBatchRecord,
  CommercialRelationship,
  DisclosureDeclaration,
  PublicationRecord,
  PublicationDisclosureStatus,
  RunCreatorMatchInput,
  UgcDeliverableVersion,
  UgcProduction,
  UgcSubmission,
  UsageRightsView,
} from "../creators/port.ts";
import type { RiskOperationClass } from "../core/risk.ts";

// Boundary module registrations (composition root imports all).
import { identityModule } from "../identity/module.ts";
import { organizationsModule } from "../organizations/module.ts";
import { participantsModule } from "../participants/module.ts";
import { opportunitiesModule } from "../opportunities/module.ts";
import { contributionsModule } from "../contributions/module.ts";
import { campaignsModule } from "../campaigns/module.ts";
import { inventoryModule } from "../inventory/module.ts";
import { creatorsModule } from "../creators/module.ts";
import { demandModule } from "../demand/module.ts";
import { benefitsModule } from "../benefits/module.ts";
import { reputationModule } from "../reputation/module.ts";
import { evidenceModule } from "../evidence/module.ts";
import { outcomesModule } from "../outcomes/module.ts";
import { settlementModule } from "../settlement/module.ts";
import { disputesModule } from "../disputes/module.ts";
import { workflowsModule } from "../workflows/module.ts";
import { apiModule } from "../api/module.ts";
import { workersModule } from "../workers/module.ts";
import { auditModule } from "../audit/module.ts";
import { persistenceModule } from "../persistence/module.ts";
import { queuesModule } from "../queues/module.ts";
import { objectStorageModule } from "../object-storage/module.ts";
import { secretsModule } from "../secrets/module.ts";
import { observabilityModule } from "../observability/module.ts";
import { configModule } from "../config/module.ts";
import { llmModule } from "../llm/module.ts";
import { agentsModule } from "../agents/module.ts";
import { adaptersModule } from "../adapters/module.ts";
import { measurementModule } from "../measurement/module.ts";
import { paymentsModule } from "../payments/module.ts";
import { ledgerModule } from "../ledger/module.ts";

export interface Runtime {
  readonly config: ConfigurationProvider;
  readonly logger: Logger;
  /**
   * The runtime's audit writer. NET-W004-AC-07 remediation: this is the
   * TRANSACTIONAL audit writer (createTransactionalAuditWriter wrapping
   * the in-memory append-only writer). It is assignable to AuditWriter
   * for non-transactional consumers; the workflow service uses
   * forTransaction(tx) for atomic audit lineage.
   */
  readonly auditWriter: TransactionalAuditWriter;
  readonly objectStore: ObjectStore;
  readonly secretProvider: SecretProvider;
  readonly queue: JobQueue;
  // NET-W003 composition-root provider selection. The authoritative
  // persistence boundary (PostgresAuthority) and the non-authoritative
  // coordination boundary (CoordinationService) are exposed via
  // provider-neutral contracts. In configured production/staging these
  // are the REAL pg/ioredis adapter instances; in development/test they
  // are the clearly-marked test/dev doubles. The `providerSelection`
  // field records which concrete implementation was selected for
  // diagnostics and composition-root tests.
  readonly postgresAuthority: PostgresAuthority;
  readonly coordinationService: CoordinationService;
  readonly providerSelection: ProviderSelection;
  /**
   * NET-W005 remediation: which attestation signing implementation was
   * selected by the composition root. Production/staging boot only
   * with "explicit-adapters" or "configured-secret" — the insecure
   * "dev-default" is structurally confined to development/test
   * (selection throws otherwise). Diagnostics only; no key material.
   *
   * NET-W029 (additive): `algorithm` + `keyReference` expose the
   * ACTIVE closed-vocabulary identifiers of the VERSIONED
   * (signed-attestation) selection (e.g. "ed25519/v1" +
   * "attestation-signing/ed25519/v1") for diagnostics and tests.
   */
  readonly attestationSigning: {
    readonly mode: AttestationSigningMode;
    readonly algorithm: string;
    readonly keyReference: string;
  };
  readonly workerLoop: {
    registerHandler(handler: JobHandler): void;
    start(): void;
    stop(): Promise<void>;
    processOne(): Promise<boolean>;
    drain(): Promise<{
      processed: number;
      succeeded: number;
      failed: number;
      deadLettered: number;
      retried: number;
    }>;
    stats(): { processed: number; succeeded: number; failed: number; deadLettered: number; retried: number };
  };
  readonly registry: ModuleRegistry;
  readonly health: HealthAggregator;
  readonly api: ApiServer;
  readonly logSink: LogEntrySink;
  // NET-W002 domain services (exposed for integration/security tests).
  readonly identityService: IdentityService;
  readonly organizationService: OrganizationService;
  readonly membershipService: MembershipService;
  readonly participantService: ParticipantService;
  readonly authorizationService: AuthorizationService;
  readonly policyService: PolicyService;
  readonly apiAuth: ApiAuth;
  readonly apiCommands: ApiCommands;
  // NET-W004 domain services (exposed for integration/security tests).
  readonly opportunityService: OpportunityService;
  readonly contributionService: ContributionService;
  readonly workflowService: WorkflowService;
  // NET-W005 domain services (exposed for integration/security tests).
  readonly evidenceService: EvidenceService;
  readonly outcomeClaimService: OutcomeClaimService;
  readonly attestationService: AttestationService;
  // NET-W029 domain service (the versioned signed-attestation surface).
  readonly signedAttestationService: SignedAttestationService;
  readonly proofOfValueService: ProofOfValueService;
  // NET-W006 domain services (exposed for integration/security tests).
  readonly outcomeObservationService: OutcomeObservationService;
  readonly measurementExperimentService: MeasurementExperimentService;
  readonly attributionService: AttributionService;
  readonly incrementalityService: IncrementalityService;
  readonly baselineService: BaselineService;
  readonly measuredOutcomeService: MeasuredOutcomeService;
  /** The wired provider-neutral measurement adapters (diagnostics). */
  readonly measurementProviders: readonly MeasurementProviderAdapter[];
  /**
   * NET-W022: the provider-neutral measurement ingestion boundary —
   * routes raw provider report submissions to the registered adapter
   * and returns the normalized neutral report (no mutation; the
   * persistence composition lives in the apiCommands composite).
   */
  readonly measurementIngestion: MeasurementIngestionService;
  /**
   * NET-W023: the wired OpenRTB / supply-chain provider adapters
   * (diagnostics).
   */
  readonly openRtbProviders: readonly OpenRtbProviderAdapter[];
  /**
   * NET-W023: the provider-neutral OpenRTB ingress boundary — routes
   * raw submissions to the registered adapter, enforces the neutral
   * contract, and derives the external ad-request admission
   * evaluation through the neutral read-only inventory lookup (no
   * mutation; the ONLY sanctioned material path routes measurement
   * facts through the W022 ingestion composite).
   */
  readonly openRtbIngress: OpenRtbIngressService;
  /**
   * NET-W023 PR #47 remediation: whether the seller-authorization
   * trust channel is configured (the SELLER_AUTHORIZATION_TRUST_KEY
   * secret, resolved ONLY through the SecretProvider at composition
   * time — or the explicit composition override). When NOT
   * configured, no seller-authorization submission can be
   * authenticated and no supply chain can be `verified` (fail
   * closed — the admission evaluation reports
   * `supply_chain_unauthenticated`). Diagnostics only: the secret
   * value is NEVER exposed here.
   */
  readonly openRtbSellerAuthorizationTrust: {
    readonly configured: boolean;
    readonly algorithm: "hmac-sha256";
  };
  // NET-W007 domain services (exposed for integration/security tests).
  readonly reputationPolicyService: ReputationPolicyService;
  readonly reputationInputService: ReputationInputService;
  readonly reputationSnapshotService: ReputationSnapshotService;
  // NET-W031 domain service (the portable reputation proof surface).
  readonly reputationProofService: ReputationProofService;
  // NET-W008 domain services (exposed for integration/security tests).
  readonly economicValueService: EconomicValueService;
  readonly creditService: CreditService;
  readonly rewardPolicyService: RewardPolicyService;
  readonly rewardService: RewardService;
  readonly cashService: CashService;
  readonly conversionService: ConversionService;
  readonly economicLedgerService: EconomicLedgerService;
  // NET-W010 stake escrow (the settlement authority's stake commands).
  readonly stakeService: StakeService;
  /**
   * NET-W030: the external settlement service — authenticated,
   * fail-closed ingestion of append-only external transaction FACTS
   * inside the /settlement authority + the DERIVED deterministic
   * reconciliation. An external fact can never mint, consume, reverse
   * or mutate internal economic state (architecture-lock §14
   * invariant 25).
   */
  readonly externalSettlementService: ExternalSettlementService;
  /** NET-W030: the wired external settlement provider adapters (diagnostics). */
  readonly externalSettlementProviders: readonly ExternalSettlementProviderAdapter[];
  /**
   * NET-W030: the external settlement trust-channel diagnostic — the
   * providers whose verification material resolved through the
   * SecretProvider (or the explicit composition override). Unlisted
   * providers fail closed at ingestion (`unauthenticated`). The
   * secret values are NEVER exposed here.
   */
  readonly externalSettlementTrust: {
    readonly configuredProviders: readonly string[];
  };
  // NET-W009 disputes (fraud/risk foundation) services.
  readonly riskSignalService: RiskSignalService;
  readonly riskPolicyService: RiskPolicyService;
  readonly riskAssessmentService: RiskAssessmentService;
  readonly riskCaseService: RiskCaseService;
  readonly riskControlService: RiskControlService;
  // NET-W010 disputes (challenges/disputes/appeals) service.
  readonly disputeService: DisputeService;
  // NET-W011 campaigns (campaign policy/configuration) service.
  readonly campaignService: CampaignService;
  // NET-W021 campaign matching and optimization (selection, not
  // authority — hard gates, evidence-backed ranking, bounded AI
  // advisory, explainable ordering).
  readonly campaignMatchingService: CampaignMatchingService;
  // NET-W015 creators (creator identity and preferences) service.
  readonly creatorService: CreatorService;
  // NET-W016 creator matching (deterministic eligibility + ranking).
  readonly creatorMatchingService: CreatorMatchingService;
  readonly creatorEngagementService: CreatorEngagementService;
  readonly creatorSponsorshipService: CreatorSponsorshipService;
  // NET-W019 inventory (supply registration + placement context) service.
  readonly inventoryService: InventoryService;
  // NET-W020 cross-promotion clearing (records + derived eligibility).
  readonly crossPromotionClearingService: CrossPromotionClearingService;
  // NET-W024 demand (consumer demand pools: privacy-preserving
  // aggregation, server-enforced consent/membership, derived
  // qualified-aggregate views — zero economic surface) service.
  readonly demandService: DemandService;
  // NET-W025 demand (business procurement pools: competition-policy
  // aggregation behind the frozen commitment + distinct-organization
  // floors, buyer-organization-authorized commitments, derived
  // supplier-facing minimized demand views — still zero economic
  // surface; still the SAME /demand authority) service.
  readonly procurementService: ProcurementService;
  // NET-W026 demand (supplier offers + competitive selection:
  // authorized offers against currently qualified demand,
  // server-derived hard eligibility, deterministic auditable
  // selection lineage — still zero economic surface, W025 privacy
  // intact upstream; still the SAME /demand authority) service.
  readonly supplierOfferService: SupplierOfferService;
  // NET-W027 demand (verified savings and counterfactuals:
  // evidence-backed explicit baselines with preserved uncertainty,
  // authoritative /outcomes observations + /evidence facts through
  // neutral lookups, deterministic anchor-aware derivation that
  // fails closed on invalid/stale/insufficient evidence — still
  // zero economic surface; still the SAME /demand authority)
  // service.
  readonly procurementSavingsService: ProcurementSavingsService;
  // NET-W028 benefits (Benefit Pools) service — the /benefits
  // boundary's allocation orchestrator; every economic mutation
  // routes through /settlement's existing reward-allocation draw
  // (via the neutral draw port below), never a second ledger.
  readonly benefitPoolService: BenefitPoolService;
  // NET-W012 helpful contributions (Proof-of-Helpfulness) service.
  readonly helpfulnessService: HelpfulnessService;
  // NET-W013 quality/moderation/anti-spam services.
  readonly qualityService: QualityService;
  readonly moderationService: ModerationService;
  /** NET-W013 provider-neutral LLM providers (echo reference default). */
  readonly llmProviders: readonly (LlmPort & ProviderAdapter)[];
  /** The default LLM provider (llmProviders[0]) used by the composites. */
  readonly llmProvider: LlmPort;
  // NET-W003 IdempotencyStore (exposed for NET-W004 integration tests).
  readonly idempotency: IdempotencyStore;
  initialize(): Promise<readonly { name: string; initialized: boolean }[]>;
  shutdown(): Promise<void>;
  /** Enqueue a representative non-domain ECHO job (AC-03/AC-05 demo). */
  enqueueEchoJob(message: string): Promise<string>;
}

export interface CreateRuntimeOptions {
  readonly env?: NodeJS.ProcessEnv;
  readonly collector?: LogEntrySink;
  /** Override env classification (test helper). */
  readonly forceEnv?: "development" | "test" | "staging" | "production";
  readonly failOnMissingRequiredSecrets?: boolean;
  readonly port?: number;
  /**
   * NET-W005 remediation: explicitly configured attestation signer/
   * verifier adapters (e.g. a production Ed25519 signing service).
   * When provided as a PAIR they take precedence over the
   * ATTESTATION_SIGNING_KEY secret in every environment. Partial
   * wiring is rejected (fail closed). Production/staging require
   * EITHER this pair OR the configured secret — never the dev default.
   *
   * NET-W029 (additive): `versionedSigner`/`versionedVerifier` are the
   * versioned (algorithm + key reference) adapters for the
   * signed-attestation surface — also PAIR-required, also taking
   * precedence in every environment. The two pairs are independent
   * (the W005 surface and the W029 surface can be wired separately).
   */
  readonly attestation?: {
    readonly signer?: AttestationSigner;
    readonly verifier?: AttestationVerifier;
    readonly versionedSigner?: SignedAttestationSigner;
    readonly versionedVerifier?: SignedAttestationVerifier;
  };
  /**
   * NET-W006: explicitly configured measurement provider adapters
   * (e.g. the browser/platform + iOS attribution adapters arriving in
   * NET-W022, or test doubles). When omitted, the reference ECHO
   * adapter is wired (it reports no observations). The outcomes
   * domain consumes ONLY the neutral MeasurementProviderAdapter
   * contract — concrete providers never cross into the domain.
   */
  readonly measurement?: {
    readonly providers?: readonly MeasurementProviderAdapter[];
  };
  /**
   * NET-W023: explicitly configured OpenRTB / supply-chain provider
   * adapters (test doubles or future concrete exchange adapters).
   * When omitted, the reference adapter is wired (request +
   * seller-authorization normalization). Consumers use ONLY the
   * neutral OpenRtbProviderAdapter contract.
   */
  readonly adapters?: {
    readonly openRtbProviders?: readonly OpenRtbProviderAdapter[];
    /**
     * NET-W023 PR #47 remediation: explicitly configured
     * seller-authorization trust key (HMAC-SHA256) for the OpenRTB
     * ingress (test wiring or an operator-provided channel key). When
     * omitted, the key resolves through the SecretProvider
     * (SELLER_AUTHORIZATION_TRUST_KEY); when neither is present the
     * trust channel is NOT configured and no supply chain can be
     * `verified` (fail closed).
     */
    readonly sellerAuthorizationTrustKey?: string;
    /**
     * NET-W030: explicitly configured external settlement provider
     * adapters (test doubles or future concrete payment-network
     * adapters). When omitted, the reference adapter is wired.
     * Consumers use ONLY the neutral ExternalSettlementProviderAdapter
     * contract declared in the /settlement port.
     */
    readonly externalSettlementProviders?: readonly ExternalSettlementProviderAdapter[];
    /**
     * NET-W030: explicitly configured per-provider external settlement
     * trust keys (HMAC-SHA256; test wiring or operator-provided
     * channel keys). When omitted for a provider, the key resolves
     * through the SecretProvider; when neither is present, ingestion
     * for that provider fails closed (`unauthenticated` — nothing is
     * ever recorded).
     */
    readonly externalSettlementTrustKeys?: Readonly<Record<string, string>>;
  };
  /**
   * NET-W013: explicitly configured LLM provider adapters (test
   * doubles or future concrete adapters). When omitted, the
   * deterministic reference ECHO provider is wired. Consumers use
   * ONLY the neutral LlmPort contract — outputs are structurally
   * non-authoritative (architecture-lock §4).
   */
  readonly llm?: {
    readonly providers?: readonly (LlmPort & ProviderAdapter)[];
  };
}

export function createRuntime(opts: CreateRuntimeOptions = {}): Runtime {
  const { provider: config } = loadConfig({
    source: opts.env,
    forceEnv: opts.forceEnv,
    failOnMissingRequiredSecrets: opts.failOnMissingRequiredSecrets,
  });
  const snapshot = config.snapshot;

  const logSink: LogEntrySink = opts.collector ?? { entries: [] };
  const logger = createLogger({
    module: "bootstrap",
    minLevel: snapshot.logLevel as "trace" | "debug" | "info" | "warn" | "error" | "fatal",
    pretty: snapshot.environment === "development",
    collector: logSink,
  });

  // NET-W004-AC-07 remediation (transaction-ordering): the runtime's
  // audit writer is the TRANSACTIONAL audit writer wrapping the
  // in-memory append-only writer. Non-transactional consumers
  // (identity, organizations, participants, opportunities,
  // contributions, workers) call append/query/count — the
  // transactional writer delegates those directly to the underlying
  // append-only writer (identical NET-W001/NET-W002 behaviour). The
  // workflow authority calls forTransaction(tx) to obtain a
  // transaction-scoped buffer whose publication is registered on the
  // transaction's afterCommit hook and whose discard is registered on
  // afterRollback: the lifecycle mutation + idempotency record commit
  // durably first, the audit record is published STRICTLY AFTER the
  // commit succeeds, and it is discarded when the commit fails or the
  // tx rolls back (no audit record can survive for a mutation that
  // never committed). A post-commit publication failure is retried,
  // then retained for the explicit retryPendingPublications()
  // recovery path — the durable commit is never undone.
  const auditWriter = createTransactionalAuditWriter({
    underlying: createInMemoryAuditWriter({ logger: logger.child("audit") }),
    logger: { debug: (m, f) => logger.child("audit").debug(m, f) },
  });
  const objectStore = createInMemoryObjectStore();
  const secretProvider = createEnvSecretProvider({
    source: opts.env ?? process.env,
    catalog: buildSecretCatalog(config.describe()),
  });

  // -- NET-W003 composition-root provider selection ---------------
  // Resolve the persistence + coordination providers through the
  // SecretProvider. In configured production/staging this constructs
  // the REAL PostgresAuthorityAdapter + RedisCoordinationAdapter
  // (failing fast if required provider configuration is missing —
  // NEVER silently selecting a shim). In development/test it selects
  // the clearly-marked test/dev doubles so the runtime is operable
  // out-of-the-box without a real PostgreSQL or Redis.
  const providerSelection = selectProviders({
    config,
    secretProvider,
    logger,
    forceEnv: opts.forceEnv,
  });
  const postgresAuthority = providerSelection.postgresAuthority;
  const coordinationService = providerSelection.coordinationService;

  const queue = createInMemoryJobQueue();

  // -- NET-W002 domain wiring ------------------------------------------
  // Identity boundary.
  const identityRepo = createInMemoryIdentityRepository({ logger: logger.child("identity") });
  const identityService = createIdentityService({
    repository: identityRepo,
    auditWriter,
    logger: logger.forModule("identity"),
  });
  const principalResolver = createInMemoryPrincipalResolver({ repository: identityRepo });

  // Organizations boundary.
  const organizationRepo = createInMemoryOrganizationRepository({ logger: logger.child("organizations") });
  const membershipRepo = createInMemoryMembershipRepository({ logger: logger.child("organizations") });
  const organizationService = createOrganizationService({
    organizations: organizationRepo,
    memberships: membershipRepo,
    auditWriter,
    logger: logger.forModule("organizations"),
  });
  const membershipService = createMembershipService({
    organizations: organizationRepo,
    memberships: membershipRepo,
    auditWriter,
    logger: logger.forModule("organizations"),
  });

  // Participants boundary.
  const participantRepo = createInMemoryParticipantRepository({ logger: logger.child("participants") });
  const policyRepo = createInMemoryPolicyRepository({ logger: logger.child("participants") });
  const participantService = createParticipantService({
    participants: participantRepo,
    auditWriter,
    logger: logger.forModule("participants"),
  });

  // Cross-domain lookup adapters (the AuthorizationService needs org
  // membership + identity existence, but participants cannot import the
  // other domains' ports. We wire thin structural adapters here.)
  const membershipLookup: MembershipLookup = {
    async membershipStatus(personId, organizationId) {
      const m = await membershipRepo.findByPersonAndOrganization(personId, organizationId);
      return m ? m.status : null;
    },
  };
  const identityLookup: IdentityLookup = {
    async exists(personId) {
      return identityRepo.exists(personId);
    },
  };
  const authorizationService = createAuthorizationService({
    participants: participantRepo,
    policies: policyRepo,
    membershipLookup,
    identityLookup,
    logger: logger.forModule("participants"),
  });
  const policyService = createPolicyService({
    policies: policyRepo,
    auditWriter,
    logger: logger.forModule("participants"),
  });

  // -- NET-W003 IdempotencyStore ------------------------------------
  // PostgresAuthority-backed idempotency store. Used by the NET-W004
  // WorkflowService for exactly-once-per-key material mutation. The
  // store's idempotency records are durable (committed in the SAME
  // authoritative tx as the lifecycle mutation + the audit record).
  const idempotency = createPostgresIdempotencyStore({
    authority: postgresAuthority,
    logger: { debug: (m, f) => logger.forModule("idempotency").debug(m, f) },
  });

  // -- NET-W004 domain wiring ---------------------------------------
  // Opportunities boundary (PostgresAuthority-backed repository).
  const opportunityRepo = createAuthorityOpportunityRepository({
    authority: postgresAuthority,
    logger: { debug: (m, f) => logger.forModule("opportunities").debug(m, f) },
  });
  const opportunityService = createOpportunityService({
    repository: opportunityRepo,
    auditWriter,
    logger: logger.forModule("opportunities"),
  });

  // Contributions boundary (PostgresAuthority-backed repository).
  const contributionRepo = createAuthorityContributionRepository({
    authority: postgresAuthority,
    logger: { debug: (m, f) => logger.forModule("contributions").debug(m, f) },
  });
  // OpportunityLookup structural adapter: the ContributionService needs
  // to verify the opportunity exists + resolve its org scope, but the
  // contributions domain cannot import the opportunities domain. Wire
  // a thin adapter that delegates to the OpportunityRepository.
  const opportunityLookup: OpportunityLookup = {
    async getOrganizationScope(opportunityId) {
      const opp = await opportunityRepo.findById(opportunityId);
      return opp ? opp.organizationScopeId : null;
    },
    async exists(opportunityId) {
      return opportunityRepo.exists(opportunityId);
    },
  };
  const contributionService = createContributionService({
    repository: contributionRepo,
    opportunityLookup,
    auditWriter,
    logger: logger.forModule("contributions"),
  });

  // Workflows boundary (the SOLE lifecycle authority).
  // The lifecycle repository adapters wrap the domain repositories so
  // the WorkflowService (which operates on plain LifecycleSubject)
  // can mutate lifecycle state uniformly. The adapter does read-modify-
  // write: reads the current domain entity within the authoritative tx,
  // merges the workflow service's lifecycle mutation onto it (preserving
  // all domain-specific fields), and writes the merged result back.
  // The TransitionAuthorizer adapter delegates to the existing deny-by-
  // default AuthorizationService (NET-W002 §4.5). The subject's
  // organizationScopeId is the resource checked against the actor's
  // organization scope so cross-org transitions are denied.
  const transitionAuthorizer: TransitionAuthorizer = {
    async authorizeTransition(input) {
      const resolved = await authorizationService.resolvePrincipal(
        input.execution,
        input.actorPersonId,
      );
      const decision = await authorizationService.authorize({
        principal: resolved,
        action: input.policyAction,
        resource: input.subject.organizationScopeId,
        clientClaims: undefined,
      });
      return {
        decision: decision.decision,
        reason: decision.reason,
      };
    },
  };
  // -- NET-W005 evidence domain wiring --------------------------------
  // Evidence boundary: evidence records (deterministic grade rule table
  // + confidence/uncertainty + sensitivity/privacy boundary), outcome
  // claims (OUT-001 vocabulary), attestations (verifier-neutral
  // signer/verifier — the HMAC default is a clearly-marked dev/test
  // implementation; production verifiers arrive as adapters), and the
  // Proof-of-Value (lifecycle transitions route through the workflow
  // service — the SOLE lifecycle authority).
  const evidenceRepo = createAuthorityEvidenceRepository({
    authority: postgresAuthority,
    logger: { debug: (m, f) => logger.forModule("evidence").debug(m, f) },
  });
  // NET-W017 engagement/UGC repositories (PostgresAuthority-backed,
  // append-only collections). Created here — before the evidence
  // subject lookup — so canonical evidence records can bind to
  // "ugc_production" subjects (validated through the lookup below).
  const engagementRepo = createAuthorityEngagementRepository({
    authority: postgresAuthority,
    logger: { debug: (m, f) => logger.forModule("creators").debug(m, f) },
  });
  const creatorAcceptancePolicyRepo = createAuthorityAcceptancePolicyRepository({
    authority: postgresAuthority,
    logger: { debug: (m, f) => logger.forModule("creators").debug(m, f) },
  });
  const usageRightsRepo = createAuthorityUsageRightsRepository({
    authority: postgresAuthority,
    logger: { debug: (m, f) => logger.forModule("creators").debug(m, f) },
  });
  const ugcProductionRepo = createAuthorityUgcProductionRepository({
    authority: postgresAuthority,
    logger: { debug: (m, f) => logger.forModule("creators").debug(m, f) },
  });
  const ugcDeliverableRepo = createAuthorityUgcDeliverableRepository({
    authority: postgresAuthority,
    logger: { debug: (m, f) => logger.forModule("creators").debug(m, f) },
  });
  const ugcSubmissionRepo = createAuthorityUgcSubmissionRepository({
    authority: postgresAuthority,
    logger: { debug: (m, f) => logger.forModule("creators").debug(m, f) },
  });
  const engagementBatchRepo = createAuthorityEngagementBatchRepository({
    authority: postgresAuthority,
    logger: { debug: (m, f) => logger.forModule("creators").debug(m, f) },
  });
  // NET-W018 sponsorship/disclosure repositories (PostgresAuthority-
  // backed, append-only collections). Created here — before the
  // evidence subject lookup — so canonical evidence records can bind
  // to "publication" subjects (validated through the lookup below).
  const commercialRelationshipRepo =
    createAuthorityCommercialRelationshipRepository({
      authority: postgresAuthority,
      logger: { debug: (m, f) => logger.forModule("creators").debug(m, f) },
    });
  const disclosureDeclarationRepo =
    createAuthorityDisclosureDeclarationRepository({
      authority: postgresAuthority,
      logger: { debug: (m, f) => logger.forModule("creators").debug(m, f) },
    });
  const publicationRepo = createAuthorityPublicationRepository({
    authority: postgresAuthority,
    logger: { debug: (m, f) => logger.forModule("creators").debug(m, f) },
  });
  // NET-W019 inventory repositories (PostgresAuthority-backed,
  // append-only collections). Created here — before the evidence
  // subject lookup — so canonical evidence records can bind to
  // "inventory_item" subjects (the INV-003 supply-verification
  // signal, validated through the lookup below).
  const inventoryItemRepo = createAuthorityInventoryItemRepository({
    authority: postgresAuthority,
    logger: { debug: (m, f) => logger.forModule("inventory").debug(m, f) },
  });
  const inventoryPlacementRepo = createAuthorityPlacementRepository({
    authority: postgresAuthority,
    logger: { debug: (m, f) => logger.forModule("inventory").debug(m, f) },
  });
  // NET-W024 demand repositories (PostgresAuthority-backed,
  // append-only collections). The pool + commitment records are the
  // demand boundary's OWN durable state (DEM-001); the private
  // commitment records never cross into any other boundary.
  const demandPoolRepo = createAuthorityDemandPoolRepository({
    authority: postgresAuthority,
    logger: { debug: (m, f) => logger.forModule("demand").debug(m, f) },
  });
  const demandCommitmentRepo = createAuthorityDemandCommitmentRepository({
    authority: postgresAuthority,
    logger: { debug: (m, f) => logger.forModule("demand").debug(m, f) },
  });
  // NET-W025 procurement repositories (PostgresAuthority-backed,
  // append-only collections — the SAME /demand boundary's durable
  // state for business procurement pools; the private business
  // commitment records never cross into any other boundary).
  const procurementPoolRepo = createAuthorityProcurementPoolRepository({
    authority: postgresAuthority,
    logger: { debug: (m, f) => logger.forModule("demand").debug(m, f) },
  });
  const procurementCommitmentRepo =
    createAuthorityProcurementCommitmentRepository({
      authority: postgresAuthority,
      logger: { debug: (m, f) => logger.forModule("demand").debug(m, f) },
    });
  // NET-W026 supplier-offer/selection repositories
  // (PostgresAuthority-backed, append-only collections — the SAME
  // /demand boundary's durable state for supplier offers and the
  // authoritative selection lineage records; the private supplier
  // offer records never cross into any other boundary; selection
  // records are immutable append-only lineage).
  const supplierOfferRepo = createAuthoritySupplierOfferRepository({
    authority: postgresAuthority,
    logger: { debug: (m, f) => logger.forModule("demand").debug(m, f) },
  });
  const competitiveSelectionRepo =
    createAuthorityCompetitiveSelectionRepository({
      authority: postgresAuthority,
      logger: { debug: (m, f) => logger.forModule("demand").debug(m, f) },
    });
  // NET-W027 baseline/savings repositories (PostgresAuthority-backed,
  // append-only collections — the SAME /demand boundary's durable
  // state for the explicit baselines (one-way invalidation) and the
  // immutable savings lineage records; no economic state exists
  // anywhere in these collections).
  const procurementBaselineRepo =
    createAuthorityProcurementBaselineRepository({
      authority: postgresAuthority,
      logger: { debug: (m, f) => logger.forModule("demand").debug(m, f) },
    });
  const procurementSavingsRepo =
    createAuthorityProcurementSavingsRepository({
      authority: postgresAuthority,
      logger: { debug: (m, f) => logger.forModule("demand").debug(m, f) },
    });
  const evidenceService = createEvidenceService({
    repository: evidenceRepo,
    authority: postgresAuthority,
    auditWriter,
    logger: logger.forModule("evidence"),
  });
  const outcomeClaimRepo = createAuthorityOutcomeClaimRepository({
    authority: postgresAuthority,
    logger: { debug: (m, f) => logger.forModule("evidence").debug(m, f) },
  });
  const outcomeClaimService = createOutcomeClaimService({
    repository: outcomeClaimRepo,
    evidenceRepository: evidenceRepo,
    authority: postgresAuthority,
    auditWriter,
    logger: logger.forModule("evidence"),
  });
  const attestationRepo = createAuthorityAttestationRepository({
    authority: postgresAuthority,
    logger: { debug: (m, f) => logger.forModule("evidence").debug(m, f) },
  });
  // NET-W005 remediation (architect review on PR #10): FAIL CLOSED.
  // The previous wiring permitted the dev-insecure fallback outside
  // test environments — and because it read a field the configuration
  // snapshot never carried, the fallback was effectively unconditional
  // (even a configured ATTESTATION_SIGNING_KEY was ignored). The key is
  // now resolved through the SecretProvider (the only boundary that
  // returns secret material), and a configured production/staging
  // deployment without either the secret or an explicit signer/
  // verifier adapter pair fails startup with ProviderConfigurationError.
  const attestationSigning = selectAttestationSigning({
    environment: snapshot.environment,
    secretProvider,
    logger,
    attestation: opts.attestation,
  });
  const attestationService = createAttestationService({
    repository: attestationRepo,
    evidenceRepository: evidenceRepo,
    signer: attestationSigning.signer,
    verifier: attestationSigning.verifier,
    authority: postgresAuthority,
    auditWriter,
    logger: logger.forModule("evidence"),
  });
  // NET-W029: the VERSIONED (algorithm + key reference) signing
  // selection for the signed-attestation surface — the same
  // fail-closed provider-selection discipline as the W005 surface,
  // extended with REAL asymmetric production algorithms (Ed25519 /
  // ECDSA P-256 via node:crypto) behind the injected interfaces. Key
  // material resolves ONLY through the SecretProvider (never env, never
  // the domain); the default "hmac-sha256" keeps existing configured
  // deployments booting unchanged (the W005 remediation contract).
  const versionedAttestationSigning = selectVersionedAttestationSigning({
    environment: snapshot.environment,
    secretProvider,
    logger,
    algorithm: snapshot.attestationSigningAlgorithm,
    attestation: opts.attestation,
  });
  const signedAttestationRepo = createAuthoritySignedAttestationRepository({
    authority: postgresAuthority,
    logger: { debug: (m, f) => logger.forModule("evidence").debug(m, f) },
  });
  // Proof-of-Value: the subject lookup adapter delegates to the wired
  // opportunity/contribution repositories WITHOUT a domain→domain
  // import (the same structural-interface pattern as OpportunityLookup
  // in the contributions domain).
  const povSubjectLookup: SubjectLookup = {
    async getOrganizationScope(subjectType, subjectId) {
      if (subjectType === "opportunity") {
        const opp = await opportunityRepo.findById(subjectId);
        return opp ? opp.organizationScopeId : null;
      }
      if (subjectType === "contribution") {
        const c = await contributionRepo.findById(subjectId);
        return c ? c.organizationScopeId : null;
      }
      // NET-W017: canonical evidence records may bind to UGC
      // production subjects (the submission evidence lineage — work
      // order §3.4/AC-05).
      if (subjectType === "ugc_production") {
        const production = await ugcProductionRepo.findById(subjectId);
        return production ? production.organizationScopeId : null;
      }
      // NET-W018: canonical evidence records may bind to PUBLICATION
      // subjects (the publication-evidence + disclosure-declaration
      // evidence lineage — work order §3.4).
      if (subjectType === "publication") {
        const publication = await publicationRepo.findById(subjectId);
        return publication ? publication.organizationScopeId : null;
      }
      // NET-W019: canonical evidence records may bind to INVENTORY
      // ITEM subjects (the INV-003 supply-verification signal — work
      // order §3.2).
      if (subjectType === "inventory_item") {
        const item = await inventoryItemRepo.findById(subjectId);
        return item ? item.organizationScopeId : null;
      }
      return null;
    },
    async exists(subjectType, subjectId) {
      if (subjectType === "opportunity") return opportunityRepo.exists(subjectId);
      if (subjectType === "contribution") return contributionRepo.exists(subjectId);
      if (subjectType === "ugc_production") {
        return (await ugcProductionRepo.findById(subjectId)) !== null;
      }
      if (subjectType === "publication") {
        return (await publicationRepo.findById(subjectId)) !== null;
      }
      if (subjectType === "inventory_item") {
        return (await inventoryItemRepo.findById(subjectId)) !== null;
      }
      return false;
    },
  };
  const proofOfValueRepo = createAuthorityProofOfValueRepository({
    authority: postgresAuthority,
    logger: { debug: (m, f) => logger.forModule("evidence").debug(m, f) },
  });
  const proofOfValueService = createProofOfValueService({
    repository: proofOfValueRepo,
    evidenceRepository: evidenceRepo,
    outcomeClaimRepository: outcomeClaimRepo,
    attestationRepository: attestationRepo,
    // NET-W005 remediation: the SAME verifier selected above — PoV
    // verification (EVALUATING → VERIFIED) now cryptographically
    // verifies at least one attached attestation against the current
    // stored commitment digests before the transition may execute.
    attestationVerifier: attestationSigning.verifier,
    subjectLookup: povSubjectLookup,
    workflow: {
      // Delegate to the SAME workflow service instance (the /workflows
      // boundary is the SOLE lifecycle authority for proof_of_value
      // transitions, exactly as for opportunities/contributions).
      async requestTransition(request, execution) {
        return workflowService.requestTransition(request, execution);
      },
    },
    authority: postgresAuthority,
    auditWriter,
    logger: logger.forModule("evidence"),
  });

  const measuredOutcomeRepo = createAuthorityMeasuredOutcomeRepository({
    authority: postgresAuthority,
    logger: { debug: (m, f) => logger.forModule("outcomes").debug(m, f) },
  });
  const workflowService = createWorkflowService({
    opportunityRepository: createLifecycleRepository(opportunityRepo),
    contributionRepository: createLifecycleRepository(contributionRepo),
    proofOfValueRepository: createLifecycleRepository(proofOfValueRepo),
    outcomeMeasurementRepository: createLifecycleRepository(measuredOutcomeRepo),
    engagementRepository: createLifecycleRepository(engagementRepo),
    publicationRepository: createLifecycleRepository(publicationRepo),
    authorizer: transitionAuthorizer,
    auditWriter,
    idempotency,
    coordination: coordinationService,
  });

  // -- NET-W006 outcomes domain wiring --------------------------------
  // Measurement semantics (architecture §18: /outcomes owns them;
  // /measurement owns provider integrations only). Cross-domain
  // lookups arrive as thin adapters over the wired repositories —
  // the same dependency-inversion pattern as povSubjectLookup.
  const measurementSubjectLookup: MeasurementSubjectLookup = {
    async getOrganizationScope(subjectType, subjectId) {
      if (subjectType === "opportunity") {
        const opp = await opportunityRepo.findById(subjectId);
        return opp ? opp.organizationScopeId : null;
      }
      if (subjectType === "contribution") {
        const c = await contributionRepo.findById(subjectId);
        return c ? c.organizationScopeId : null;
      }
      // NET-W021: measured outcomes may be subject-scoped to
      // INVENTORY ITEM subjects — the campaign-matching performance
      // evidence (verified measured outcomes for a supply option —
      // the W019 PoV-lookup precedent for evidence subjects).
      if (subjectType === "inventory_item") {
        const item = await inventoryItemRepo.findById(subjectId);
        return item ? item.organizationScopeId : null;
      }
      return null;
    },
    async exists(subjectType, subjectId) {
      if (subjectType === "opportunity") return opportunityRepo.exists(subjectId);
      if (subjectType === "contribution") return contributionRepo.exists(subjectId);
      // NET-W021: inventory-item measurement subjects (see above).
      if (subjectType === "inventory_item") {
        return (await inventoryItemRepo.findById(subjectId)) !== null;
      }
      return false;
    },
  };
  const outcomeClaimLookup: OutcomeClaimLookup = {
    async exists(id) {
      return outcomeClaimRepo.exists(id);
    },
    async getOrganizationScope(id) {
      const claim = await outcomeClaimRepo.findById(id);
      return claim ? claim.organizationScopeId : null;
    },
  };
  const evidenceRecordLookup: EvidenceRecordLookup = {
    async exists(id) {
      return evidenceRepo.exists(id);
    },
    async getOrganizationScope(id) {
      const evidence = await evidenceRepo.findById(id);
      return evidence ? evidence.organizationScopeId : null;
    },
  };
  // Provider-neutral measurement adapters: explicitly configured
  // adapters (opts.measurement.providers — test doubles today, the
  // NET-W022 platform attribution adapters later) or the reference
  // ECHO adapter. The outcomes domain consumes only the neutral
  // contract.
  // NET-W022: when NO explicit providers are configured, the
  // reference browser/platform + iOS attribution adapters (ADAPTER-
  // 003..004) are auto-wired IFF their verification secrets are
  // configured (SecretProvider boundary). Without the secrets the
  // default wiring stays ECHO-only (the W006 default) and pushed
  // attribution reports for those providers fail closed.
  const browserAttributionSecret = secretProvider.hasSecret(
    MEASUREMENT_BROWSER_ATTRIBUTION_SECRET_KEY,
  )
    ? secretProvider.getSecretSync(MEASUREMENT_BROWSER_ATTRIBUTION_SECRET_KEY)
    : undefined;
  const iosAttributionSecret = secretProvider.hasSecret(
    MEASUREMENT_IOS_ATTRIBUTION_SECRET_KEY,
  )
    ? secretProvider.getSecretSync(MEASUREMENT_IOS_ATTRIBUTION_SECRET_KEY)
    : undefined;
  // NET-W023: the delivery-notice verification secret (the sanctioned
  // measurement routing path — OpenRTB delivery facts flow through the
  // W022 push-report ingestion chain). Same wiring rule as the
  // attribution adapters: no secret → the adapter is NOT wired and
  // pushed notices fail closed.
  const openRtbDeliverySecret = secretProvider.hasSecret(
    MEASUREMENT_OPENRTB_DELIVERY_SECRET_KEY,
  )
    ? secretProvider.getSecretSync(MEASUREMENT_OPENRTB_DELIVERY_SECRET_KEY)
    : undefined;
  const measurementProviders: readonly MeasurementProviderAdapter[] =
    opts.measurement?.providers?.length
      ? opts.measurement.providers
      : [
          echoMeasurementProvider,
          ...(browserAttributionSecret !== undefined
            ? [new BrowserAttributionAdapter({ verificationSecret: browserAttributionSecret })]
            : []),
          ...(iosAttributionSecret !== undefined
            ? [new IOSAttributionAdapter({ verificationSecret: iosAttributionSecret })]
            : []),
          ...(openRtbDeliverySecret !== undefined
            ? [
                new OpenRtbDeliveryNoticeAdapter({
                  verificationSecret: openRtbDeliverySecret,
                }),
              ]
            : []),
        ];
  // NET-W022: the provider registration boundary. Every wired
  // measurement adapter is registered exactly once (duplicate
  // provider identity fails closed); the ingestion service routes
  // raw report submissions by provider id. The measurement tier
  // performs NO mutation — normalization only; persistence,
  // idempotency and audit stay in /outcomes, composed by THIS root
  // (the adapter tier may not import domain modules).
  const measurementRegistry = createMeasurementProviderRegistry();
  for (const adapter of measurementProviders) {
    measurementRegistry.register(adapter);
  }
  const measurementIngestion = createMeasurementIngestionService({
    registry: measurementRegistry,
    logger: logger.forModule("measurement"),
  });
  // NET-W013: the provider-neutral LLM adapters (explicit override or
  // the deterministic ECHO reference provider). The FIRST consumer is
  // the generateAdvisoryQualityScore composition-root composite below
  // — never a domain module (the domain-must-not-import-adapter rule).
  const llmProviders: readonly (LlmPort & ProviderAdapter)[] =
    opts.llm?.providers?.length ? opts.llm.providers : [echoLlmProvider];
  const llmProvider: LlmPort = llmProviders[0]!;
  const outcomeObservationRepo = createAuthorityOutcomeObservationRepository({
    authority: postgresAuthority,
    logger: { debug: (m, f) => logger.forModule("outcomes").debug(m, f) },
  });
  const measurementExperimentRepo = createAuthorityMeasurementExperimentRepository({
    authority: postgresAuthority,
    logger: { debug: (m, f) => logger.forModule("outcomes").debug(m, f) },
  });
  const attributionRepo = createAuthorityAttributionRepository({
    authority: postgresAuthority,
    logger: { debug: (m, f) => logger.forModule("outcomes").debug(m, f) },
  });
  const incrementalityRepo = createAuthorityIncrementalityObservationRepository({
    authority: postgresAuthority,
    logger: { debug: (m, f) => logger.forModule("outcomes").debug(m, f) },
  });
  const baselineRepo = createAuthorityCounterfactualBaselineRepository({
    authority: postgresAuthority,
    logger: { debug: (m, f) => logger.forModule("outcomes").debug(m, f) },
  });
  const outcomeObservationService = createOutcomeObservationService({
    repository: outcomeObservationRepo,
    outcomeClaimLookup,
    evidenceLookup: evidenceRecordLookup,
    providerAdapters: measurementProviders,
    // NET-W022: push report ingestion (ingestProviderReport) is
    // exactly-once-per-key through the authority-backed store.
    idempotency,
    authority: postgresAuthority,
    auditWriter,
    logger: logger.forModule("outcomes"),
  });
  const measurementExperimentService = createMeasurementExperimentService({
    repository: measurementExperimentRepo,
    authority: postgresAuthority,
    auditWriter,
    logger: logger.forModule("outcomes"),
  });
  const attributionService = createAttributionService({
    repository: attributionRepo,
    observationRepository: outcomeObservationRepo,
    experimentRepository: measurementExperimentRepo,
    evidenceLookup: evidenceRecordLookup,
    authority: postgresAuthority,
    auditWriter,
    logger: logger.forModule("outcomes"),
  });
  const incrementalityService = createIncrementalityService({
    repository: incrementalityRepo,
    experimentRepository: measurementExperimentRepo,
    authority: postgresAuthority,
    auditWriter,
    logger: logger.forModule("outcomes"),
  });
  const baselineService = createBaselineService({
    repository: baselineRepo,
    evidenceLookup: evidenceRecordLookup,
    authority: postgresAuthority,
    auditWriter,
    logger: logger.forModule("outcomes"),
  });
  // The measured-outcome lifecycle routes through the SAME workflow
  // service instance (the /workflows boundary is the SOLE lifecycle
  // authority for outcome_measurement transitions).
  const measuredOutcomeService = createMeasuredOutcomeService({
    repository: measuredOutcomeRepo,
    observationRepository: outcomeObservationRepo,
    attributionRepository: attributionRepo,
    baselineRepository: baselineRepo,
    incrementalityRepository: incrementalityRepo,
    subjectLookup: measurementSubjectLookup,
    outcomeClaimLookup,
    workflow: {
      async requestTransition(request, execution) {
        return workflowService.requestTransition(request, execution);
      },
    },
    authority: postgresAuthority,
    auditWriter,
    logger: logger.forModule("outcomes"),
  });

  // -- NET-W007 reputation domain wiring ------------------------------
  // Reputation is a DERIVED trust signal (architecture §11: not
  // purchasable; every major change traceable to evidence). Upstream
  // record resolution arrives as thin adapters over the ALREADY-WIRED
  // repositories of the owning domains (identity/evidence/outcomes/
  // contributions) — the same dependency-inversion pattern as the
  // NET-W005/W006 lookups; the reputation domain imports core only.
  const reputationSubjectLookup = {
    async exists(personId: string) {
      return identityRepo.exists(personId);
    },
  };
  const reputationEvidenceLookup = {
    async resolve(id: string) {
      const evidence = await evidenceRepo.findById(id);
      return evidence
        ? {
            organizationScopeId: evidence.organizationScopeId,
            sourceType: evidence.provenance.sourceType,
          }
        : null;
    },
  };
  const reputationProofOfValueLookup = {
    async resolve(id: string) {
      const pov = await proofOfValueRepo.findById(id);
      return pov
        ? { organizationScopeId: pov.organizationScopeId, state: pov.state }
        : null;
    },
  };
  const reputationMeasuredOutcomeLookup = {
    async resolve(id: string) {
      const measurement = await measuredOutcomeRepo.findById(id);
      return measurement
        ? {
            organizationScopeId: measurement.organizationScopeId,
            state: measurement.state,
          }
        : null;
    },
  };
  const reputationContributionLookup = {
    async resolve(id: string) {
      const contribution = await contributionRepo.findById(id);
      return contribution
        ? {
            organizationScopeId: contribution.organizationScopeId,
            state: contribution.state,
          }
        : null;
    },
  };
  const reputationPolicyRepo = createAuthorityReputationPolicyRepository({
    authority: postgresAuthority,
    logger: { debug: (m, f) => logger.forModule("reputation").debug(m, f) },
  });
  const reputationInputRepo = createAuthorityReputationInputRepository({
    authority: postgresAuthority,
    logger: { debug: (m, f) => logger.forModule("reputation").debug(m, f) },
  });
  const reputationSnapshotRepo = createAuthorityReputationSnapshotRepository({
    authority: postgresAuthority,
    logger: { debug: (m, f) => logger.forModule("reputation").debug(m, f) },
  });
  const reputationPolicyService = createReputationPolicyService({
    repository: reputationPolicyRepo,
    idempotency,
    auditWriter,
    logger: logger.forModule("reputation"),
  });
  const reputationInputService = createReputationInputService({
    repository: reputationInputRepo,
    subjectLookup: reputationSubjectLookup,
    evidenceLookup: reputationEvidenceLookup,
    proofOfValueLookup: reputationProofOfValueLookup,
    measuredOutcomeLookup: reputationMeasuredOutcomeLookup,
    contributionLookup: reputationContributionLookup,
    idempotency,
    auditWriter,
    logger: logger.forModule("reputation"),
  });
  const reputationSnapshotService = createReputationSnapshotService({
    policyRepository: reputationPolicyRepo,
    inputRepository: reputationInputRepo,
    snapshotRepository: reputationSnapshotRepo,
    idempotency,
    auditWriter,
    logger: logger.forModule("reputation"),
  });

  // -- NET-W008 settlement domain wiring --------------------------------
  // The economic ledger: pending/mature value with an explicit
  // maturation gate, PoV-gated Participation Credit issuance,
  // deterministic reward allocation, cash obligations with internal
  // settlement state and explicit conversions. Upstream record
  // resolution arrives as thin adapters over the ALREADY-WIRED
  // repositories of the owning domains (identity/evidence/outcomes) —
  // the same dependency-inversion pattern as NET-W005/006/007; the
  // settlement domain imports core only. Reputation is deliberately
  // NOT consulted here: it is a trust signal, never an economic
  // input (architecture-lock §1.8 / NET-W007 §2).
  const economicSubjectLookup = {
    async exists(personId: string) {
      return identityRepo.exists(personId);
    },
  };
  const economicEvidenceLookup = {
    async resolve(id: string) {
      const evidence = await evidenceRepo.findById(id);
      return evidence
        ? {
            organizationScopeId: evidence.organizationScopeId,
            sourceType: evidence.provenance.sourceType,
          }
        : null;
    },
  };
  const economicProofOfValueLookup = {
    async resolve(id: string) {
      const pov = await proofOfValueRepo.findById(id);
      return pov
        ? { organizationScopeId: pov.organizationScopeId, state: pov.state }
        : null;
    },
  };
  const economicMeasuredOutcomeLookup = {
    async resolve(id: string) {
      const measurement = await measuredOutcomeRepo.findById(id);
      return measurement
        ? {
            organizationScopeId: measurement.organizationScopeId,
            state: measurement.state,
          }
        : null;
    },
  };
  // NET-W014: the verified helpful contribution as a first-class
  // economic source (read-only over the contributions repository —
  // the same dependency inversion as the lookups above).
  const economicContributionLookup = {
    async resolve(id: string) {
      const contribution = await contributionRepo.findById(id);
      return contribution
        ? {
            organizationScopeId: contribution.organizationScopeId,
            state: contribution.state,
          }
        : null;
    },
  };
  const economicLedgerRepo = createAuthorityEconomicLedgerRepository({
    authority: postgresAuthority,
    logger: { debug: (m, f) => logger.forModule("settlement").debug(m, f) },
  });
  const economicValueRepo = createAuthorityEconomicValueRepository({
    authority: postgresAuthority,
    logger: { debug: (m, f) => logger.forModule("settlement").debug(m, f) },
  });

  // ------------------------------------------------------------------
  // NET-W029 signed attestations wiring (the /evidence boundary,
  // extended — issue #58).
  //
  // The coverage lookups are thin READ-ONLY adapters over the
  // /reputation and /settlement authorities' OWN repositories
  // (committed + in-tx fresh reads) — the same dependency-inversion
  // pattern as every neutral join above. The /evidence domain imports
  // core contracts only; it never imports /reputation or /settlement,
  // and neither of those ports gains a signed-attestation surface.
  // ------------------------------------------------------------------
  function toReputationInputCoverageFacts(record: {
    readonly id: string;
    readonly organizationScopeId: string;
    readonly subjectPersonId: string;
    readonly dimension: string;
    readonly basis: string;
    readonly sources: readonly { readonly kind: string; readonly id: string }[];
    readonly description: string | null;
    readonly occurredAt: string;
    readonly recordedAt: string;
    readonly idempotencyKey: string;
    readonly executionId: string;
    readonly correlationId: string;
    readonly causationId: string | null;
  }): ReputationInputCoverageFacts {
    return {
      id: record.id,
      organizationScopeId: record.organizationScopeId,
      subjectPersonId: record.subjectPersonId,
      dimension: record.dimension,
      basis: record.basis,
      sources: record.sources.map((s) => ({ kind: s.kind, id: s.id })),
      description: record.description,
      occurredAt: record.occurredAt,
      recordedAt: record.recordedAt,
      idempotencyKey: record.idempotencyKey,
      executionId: record.executionId,
      correlationId: record.correlationId,
      causationId: record.causationId,
    };
  }
  const reputationInputCoverageLookup: ReputationInputCoverageLookup = {
    async resolve(id) {
      const record = await reputationInputRepo.findById(id);
      return record === null ? null : toReputationInputCoverageFacts(record);
    },
    async resolveWithinTx(id, tx) {
      const record = await reputationInputRepo.findByIdWithinTx(id, tx);
      return record === null ? null : toReputationInputCoverageFacts(record);
    },
  };
  function toSettlementValueCoverageFacts(record: {
    readonly id: string;
    readonly organizationScopeId: string;
    readonly beneficiaryPersonId: string;
    readonly state: string;
    readonly version: number;
    readonly amount: number;
    readonly sources: readonly { readonly kind: string; readonly id: string }[];
    readonly maturation: { readonly strategy: string; readonly windowEndAt?: string };
    readonly description: string | null;
    readonly recordedAt: string;
    readonly recognitionTransactionId: string;
    readonly idempotencyKey: string;
    readonly executionId: string;
    readonly correlationId: string;
    readonly causationId: string | null;
  }): SettlementValueCoverageFacts {
    return {
      id: record.id,
      organizationScopeId: record.organizationScopeId,
      beneficiaryPersonId: record.beneficiaryPersonId,
      state: record.state,
      version: record.version,
      amount: record.amount,
      sources: record.sources.map((s) => ({ kind: s.kind, id: s.id })),
      maturation: record.maturation as Readonly<Record<string, unknown>>,
      description: record.description,
      recordedAt: record.recordedAt,
      recognitionTransactionId: record.recognitionTransactionId,
      idempotencyKey: record.idempotencyKey,
      executionId: record.executionId,
      correlationId: record.correlationId,
      causationId: record.causationId,
    };
  }
  const settlementValueCoverageLookup: SettlementValueCoverageLookup = {
    async resolve(id) {
      const record = await economicValueRepo.findById(id);
      return record === null ? null : toSettlementValueCoverageFacts(record);
    },
    async resolveWithinTx(id, tx) {
      const record = await economicValueRepo.findByIdWithinTx(id, tx);
      return record === null ? null : toSettlementValueCoverageFacts(record);
    },
  };
  function toApiSignedAttestationView(attestation: SignedAttestation): ApiSignedAttestationView {
    return {
      id: attestation.id,
      organizationScopeId: attestation.organizationScopeId,
      verifierId: attestation.verifierId,
      statement: attestation.statement,
      coverage: attestation.coverage.map((entry) => ({
        family: entry.family,
        recordId: entry.recordId,
        commitment: entry.commitment as unknown as Record<string, unknown>,
      })),
      algorithm: attestation.algorithm,
      keyReference: attestation.keyReference,
      signature: attestation.signature,
      signedAt: attestation.signedAt,
      revokedAt: attestation.revokedAt,
      revocationReason: attestation.revocationReason,
      createdAt: attestation.createdAt,
      recordFormat: attestation.recordFormat,
    };
  }
  const signedAttestationService = createSignedAttestationService({
    repository: signedAttestationRepo,
    evidenceRepository: evidenceRepo,
    coverageLookups: {
      reputationInput: reputationInputCoverageLookup,
      settlementValue: settlementValueCoverageLookup,
    },
    signer: versionedAttestationSigning.signer,
    verifier: versionedAttestationSigning.verifier,
    idempotency,
    auditWriter,
    logger: logger.forModule("evidence"),
  });

  // ------------------------------------------------------------------
  // NET-W031 portable reputation proofs wiring (the /reputation
  // boundary, EXTENDED — issue #63).
  //
  // Proofs COMPOSE the W029 machinery: the SAME versioned signing pair
  // selected above is adapted to the NEUTRAL ReputationProofSigner /
  // ReputationProofVerifier contracts declared on the reputation port
  // (thin adapters — the composition root is the ONLY join; the
  // reputation domain imports core contracts only and never imports
  // /evidence), and W029's FROZEN vocabularies are injected as DATA
  // (single source of truth — no mirrored constants to drift; a new
  // algorithm id remains a W029 frozen-vocabulary change). Proof
  // issuance reads the /reputation authority's OWN snapshot store
  // (this boundary's records) — no cross-domain surface is gained.
  // ------------------------------------------------------------------
  const reputationProofRepo = createAuthorityReputationProofRepository({
    authority: postgresAuthority,
    logger: { debug: (m, f) => logger.forModule("reputation").debug(m, f) },
  });
  const reputationProofSigningVocabulary: ReputationProofSigningVocabulary = {
    algorithms: SIGNED_ATTESTATION_ALGORITHMS,
    keyReferences: SIGNED_ATTESTATION_KEY_REFERENCES,
    keyReferenceByAlgorithm:
      SIGNED_ATTESTATION_KEY_REFERENCE_BY_ALGORITHM as Readonly<Record<string, readonly string[]>>,
  };
  const reputationProofSigner: ReputationProofSigner = {
    algorithm: versionedAttestationSigning.signer.algorithm,
    keyReference: versionedAttestationSigning.signer.keyReference,
    signProof: (canonicalInput) =>
      versionedAttestationSigning.signer.signVersioned(canonicalInput),
  };
  const reputationProofVerifier: ReputationProofVerifier = {
    verifyProof: (canonicalInput, envelope) =>
      versionedAttestationSigning.verifier.verifyVersioned(canonicalInput, envelope),
  };
  const reputationProofService = createReputationProofService({
    proofRepository: reputationProofRepo,
    snapshotRepository: reputationSnapshotRepo,
    signer: reputationProofSigner,
    verifier: reputationProofVerifier,
    signingVocabulary: reputationProofSigningVocabulary,
    idempotency,
    auditWriter,
    logger: logger.forModule("reputation"),
  });
  function toApiReputationProofView(proof: ReputationProof): ApiReputationProofView {
    return {
      id: proof.id,
      organizationScopeId: proof.organizationScopeId,
      subjectPersonId: proof.subjectPersonId,
      snapshotId: proof.snapshotId,
      policyId: proof.policyId,
      policyVersion: proof.policyVersion,
      referenceAt: proof.referenceAt,
      digest: proof.digest,
      dimensions: proof.dimensions.map((d) => ({
        dimension: d.dimension,
        score: d.score,
        capped: d.capped,
        inputCount: d.inputCount,
        verifiedInputCount: d.verifiedInputCount,
        indicatedInputCount: d.indicatedInputCount,
      })),
      algorithm: proof.algorithm,
      keyReference: proof.keyReference,
      signature: proof.signature,
      issuedAt: proof.issuedAt,
      revokedAt: proof.revokedAt,
      revocationReason: proof.revocationReason,
      createdAt: proof.createdAt,
      recordFormat: proof.recordFormat,
    };
  }
  function fromApiReputationProofView(
    view: ApiReputationProofView,
  ): PresentedReputationProof {
    return {
      id: view.id,
      organizationScopeId: view.organizationScopeId,
      subjectPersonId: view.subjectPersonId,
      snapshotId: view.snapshotId,
      policyId: view.policyId,
      policyVersion: view.policyVersion,
      referenceAt: view.referenceAt,
      digest: view.digest,
      // The string dimensions cross into the domain shape; the domain
      // shape validator re-checks the closed frozen vocabulary at
      // runtime (fail closed) — the presented artifact is untrusted.
      dimensions:
        view.dimensions as unknown as PresentedReputationProof["dimensions"],
      algorithm: view.algorithm,
      keyReference: view.keyReference,
      signature: view.signature,
      issuedAt: view.issuedAt,
      revokedAt: view.revokedAt,
      revocationReason: view.revocationReason,
      createdAt: view.createdAt,
      recordFormat: view.recordFormat,
    };
  }
  const creditIssuanceRepo = createAuthorityCreditIssuanceRepository({
    authority: postgresAuthority,
    logger: { debug: (m, f) => logger.forModule("settlement").debug(m, f) },
  });
  const rewardPolicyRepo = createAuthorityRewardPolicyRepository({
    authority: postgresAuthority,
    logger: { debug: (m, f) => logger.forModule("settlement").debug(m, f) },
  });
  const rewardAllocationRepo = createAuthorityRewardAllocationRepository({
    authority: postgresAuthority,
    logger: { debug: (m, f) => logger.forModule("settlement").debug(m, f) },
  });
  const cashObligationRepo = createAuthorityCashObligationRepository({
    authority: postgresAuthority,
    logger: { debug: (m, f) => logger.forModule("settlement").debug(m, f) },
  });
  const conversionRepo = createAuthorityConversionRepository({
    authority: postgresAuthority,
    logger: { debug: (m, f) => logger.forModule("settlement").debug(m, f) },
  });
  const economicValueService = createEconomicValueService({
    repository: economicValueRepo,
    ledgerRepository: economicLedgerRepo,
    subjectLookup: economicSubjectLookup,
    proofOfValueLookup: economicProofOfValueLookup,
    measuredOutcomeLookup: economicMeasuredOutcomeLookup,
    evidenceLookup: economicEvidenceLookup,
    contributionLookup: economicContributionLookup,
    idempotency,
    auditWriter,
    logger: logger.forModule("settlement"),
  });
  const creditService = createCreditService({
    issuanceRepository: creditIssuanceRepo,
    valueRepository: economicValueRepo,
    ledgerRepository: economicLedgerRepo,
    subjectLookup: economicSubjectLookup,
    proofOfValueLookup: economicProofOfValueLookup,
    idempotency,
    auditWriter,
    logger: logger.forModule("settlement"),
  });
  const rewardPolicyService = createRewardPolicyService({
    policyRepository: rewardPolicyRepo,
    ledgerRepository: economicLedgerRepo,
    subjectLookup: economicSubjectLookup,
    idempotency,
    auditWriter,
    logger: logger.forModule("settlement"),
  });
  const rewardService = createRewardService({
    policyRepository: rewardPolicyRepo,
    allocationRepository: rewardAllocationRepo,
    valueRepository: economicValueRepo,
    ledgerRepository: economicLedgerRepo,
    idempotency,
    auditWriter,
    logger: logger.forModule("settlement"),
  });
  const cashService = createCashService({
    repository: cashObligationRepo,
    ledgerRepository: economicLedgerRepo,
    subjectLookup: economicSubjectLookup,
    idempotency,
    auditWriter,
    logger: logger.forModule("settlement"),
  });
  const conversionService = createConversionService({
    repository: conversionRepo,
    ledgerRepository: economicLedgerRepo,
    subjectLookup: economicSubjectLookup,
    idempotency,
    auditWriter,
    logger: logger.forModule("settlement"),
  });
  const economicLedgerService = createEconomicLedgerService({
    repository: economicLedgerRepo,
  });
  // NET-W010 stake escrow: the settlement authority's stake commands
  // (commit/release/forfeit). The /disputes boundary consumes these
  // ONLY through composition-root orchestration (never a direct
  // domain call) — /settlement stays the sole economic authority.
  const stakeRepo = createAuthorityStakeRepository({
    authority: postgresAuthority,
    logger: { debug: (m, f) => logger.forModule("settlement").debug(m, f) },
  });
  const stakeService = createStakeService({
    stakeRepository: stakeRepo,
    ledgerRepository: economicLedgerRepo,
    subjectLookup: economicSubjectLookup,
    idempotency,
    auditWriter,
    logger: logger.forModule("settlement"),
  });

  // ------------------------------------------------------------------
  // NET-W030 — external settlement adapters wiring (ADAPTER-008; issue
  // #61).
  //
  // The /adapters boundary owns provider-specific payload parsing; the
  // /settlement authority owns the authenticated ingestion + the
  // derived reconciliation. This composition root is the ONLY join:
  //  - the provider adapter list (explicit test doubles or the
  //    reference adapter) implements the NEUTRAL contract declared in
  //    the /settlement port STRUCTURALLY (the adapter tier may not
  //    import /settlement — the tier matrix);
  //  - the per-provider trust material resolves through the
  //    SecretProvider (or the explicit composition override) — the
  //    W023 trust-channel wiring rule; absent ⇒ ingestion fails
  //    closed, NEVER a silent fallback;
  //  - the service records append-only FACTS and derives the
  //    deterministic reconciliation — it performs NO economic
  //    mutation (architecture-lock §14 invariant 25: payment adapters
  //    provide transaction facts; /settlement retains semantic
  //    authority).
  // ------------------------------------------------------------------
  const externalSettlementProviders: readonly ExternalSettlementProviderAdapter[] =
    opts.adapters?.externalSettlementProviders?.length
      ? opts.adapters.externalSettlementProviders
      : [new ExternalSettlementReferenceAdapter()];
  const externalSettlementAuthentication = selectExternalSettlementAuthentication({
    secretProvider,
    logger,
    ...(opts.adapters?.externalSettlementTrustKeys !== undefined
      ? { overrides: opts.adapters.externalSettlementTrustKeys }
      : {}),
  });
  const externalSettlementFactRepo = createAuthorityExternalSettlementFactRepository({
    authority: postgresAuthority,
    logger: { debug: (m, f) => logger.forModule("settlement").debug(m, f) },
  });
  function toApiExternalSettlementFactView(
    fact: import("../settlement/port.ts").ExternalSettlementFactRecord,
  ): import("../api/port.ts").ApiExternalSettlementFactView {
    return {
      id: fact.id,
      organizationScopeId: fact.organizationScopeId,
      provider: fact.provider,
      providerVersion: fact.providerVersion,
      externalId: fact.externalId,
      internalTransactionId: fact.internalTransactionId,
      reportedAmount: fact.reportedAmount,
      reportedUnit: fact.reportedUnit,
      observedAt: fact.observedAt,
      recordedAt: fact.recordedAt,
      correctionOf: fact.correctionOf,
      idempotencyKey: fact.idempotencyKey,
      recordFormat: fact.recordFormat,
    };
  }
  function toApiExternalSettlementReconciliationView(
    view: import("../settlement/port.ts").ExternalSettlementReconciliationView,
  ): import("../api/port.ts").ApiExternalSettlementReconciliationView {
    return {
      factId: view.factId,
      organizationScopeId: view.organizationScopeId,
      provider: view.provider,
      externalId: view.externalId,
      internalTransactionId: view.internalTransactionId,
      verdict: view.verdict,
      reason: view.reason,
      checks: view.checks.map((c) => ({
        check: c.check,
        satisfied: c.satisfied,
        reason: c.reason,
        detail: c.detail as unknown as Record<string, unknown>,
      })),
      internalTransaction: view.internalTransaction,
      derivedAt: view.derivedAt,
    };
  }
  const externalSettlementService = createExternalSettlementService({
    repository: externalSettlementFactRepo,
    ledgerRepository: economicLedgerRepo,
    adapters: externalSettlementProviders,
    authenticator: externalSettlementAuthentication.authenticator,
    idempotency,
    auditWriter,
    logger: logger.forModule("settlement"),
  });

  // ------------------------------------------------------------------
  // NET-W009 disputes boundary wiring (fraud/risk foundation).
  //
  // Cross-domain resolution arrives as thin adapters over the
  // ALREADY-WIRED repositories of the owning domains (identity/
  // evidence/outcomes/contributions/settlement/reputation) — the same
  // dependency-inversion pattern as NET-W005/006/007/008; the disputes
  // domain imports core only. Reputation is consulted READ-ONLY here
  // (historical_reputation signals cite snapshots as authoritative
  // sources; the risk boundary NEVER mutates reputation — work order
  // §4 invariant 2).
  // ------------------------------------------------------------------
  const riskSubjectLookup = {
    async exists(personId: string) {
      return identityRepo.exists(personId);
    },
  };
  const riskEvidenceLookup = {
    async resolve(id: string) {
      const evidence = await evidenceRepo.findById(id);
      return evidence
        ? {
            organizationScopeId: evidence.organizationScopeId,
            sourceType: evidence.provenance.sourceType,
          }
        : null;
    },
  };
  const riskProofOfValueLookup = {
    async resolve(id: string) {
      const pov = await proofOfValueRepo.findById(id);
      return pov
        ? { organizationScopeId: pov.organizationScopeId, state: pov.state }
        : null;
    },
  };
  const riskMeasuredOutcomeLookup = {
    async resolve(id: string) {
      const measurement = await measuredOutcomeRepo.findById(id);
      return measurement
        ? {
            organizationScopeId: measurement.organizationScopeId,
            state: measurement.state,
          }
        : null;
    },
  };
  const riskContributionLookup = {
    async resolve(id: string) {
      const contribution = await contributionRepo.findById(id);
      return contribution
        ? {
            organizationScopeId: contribution.organizationScopeId,
            state: contribution.state,
          }
        : null;
    },
  };
  const riskEconomicLookup = {
    async resolveValue(id: string) {
      const value = await economicValueRepo.findById(id);
      return value
        ? {
            organizationScopeId: value.organizationScopeId,
            state: value.state,
            beneficiaryPersonId: value.beneficiaryPersonId,
          }
        : null;
    },
    async resolveCreditIssuance(id: string) {
      const issuance = await creditIssuanceRepo.findById(id);
      return issuance
        ? {
            organizationScopeId: issuance.organizationScopeId,
            state: issuance.status,
            beneficiaryPersonId: issuance.beneficiaryPersonId,
          }
        : null;
    },
    async resolveCashObligation(id: string) {
      const obligation = await cashObligationRepo.findById(id);
      return obligation
        ? {
            organizationScopeId: obligation.organizationScopeId,
            state: obligation.status,
            beneficiaryPersonId: obligation.counterpartyPersonId,
          }
        : null;
    },
  };
  const riskReputationLookup = {
    async resolve(organizationScopeId: string, subjectPersonId: string) {
      const snapshots = await reputationSnapshotRepo.listBySubject(
        organizationScopeId,
        subjectPersonId,
      );
      const latest = snapshots.length > 0 ? snapshots[snapshots.length - 1]! : null;
      return latest
        ? {
            organizationScopeId: latest.organizationScopeId,
            subjectPersonId: latest.subjectPersonId,
            policyId: latest.policyId,
            policyVersion: latest.policyVersion,
            digest: latest.digest,
          }
        : null;
    },
    async resolveById(id: string) {
      const snapshot = await reputationSnapshotRepo.findById(id);
      return snapshot
        ? {
            organizationScopeId: snapshot.organizationScopeId,
            subjectPersonId: snapshot.subjectPersonId,
            policyId: snapshot.policyId,
            policyVersion: snapshot.policyVersion,
            digest: snapshot.digest,
          }
        : null;
    },
  };
  const riskRecordLookup = {
    async resolveSignal(id: string) {
      const signal = await riskSignalRepo.findById(id);
      return signal ? { organizationScopeId: signal.organizationScopeId } : null;
    },
    async resolveAssessment(id: string) {
      const assessment = await riskAssessmentRepo.findById(id);
      return assessment
        ? { organizationScopeId: assessment.organizationScopeId }
        : null;
    },
    // NET-W010: a risk CASE is an authoritative prior decision —
    // resolvable as a challenge subject / supporting source.
    async resolveCase(id: string) {
      const riskCase = await riskCaseRepo.findById(id);
      return riskCase ? { organizationScopeId: riskCase.organizationScopeId } : null;
    },
  };
  // NET-W013: the moderation-decision repo is created BEFORE the risk
  // lookups so the moderation source resolver can be wired here; the
  // moderation service below reuses the SAME repo instance (the
  // riskSignalRepo/riskCaseRepo hoists above follow the same pattern).
  const moderationDecisionRepo = createAuthorityModerationDecisionRepository({
    authority: postgresAuthority,
    logger: { debug: (m, f) => logger.forModule("contributions").debug(m, f) },
  });
  const riskModerationLookup = {
    async resolve(id: string) {
      const decision = await moderationDecisionRepo.findById(id);
      return decision
        ? { organizationScopeId: decision.organizationScopeId }
        : null;
    },
  };
  const riskLookups = {
    subject: riskSubjectLookup,
    evidence: riskEvidenceLookup,
    proofOfValue: riskProofOfValueLookup,
    measuredOutcome: riskMeasuredOutcomeLookup,
    contribution: riskContributionLookup,
    economic: riskEconomicLookup,
    reputation: riskReputationLookup,
    risk: riskRecordLookup,
    moderation: riskModerationLookup,
  };
  const riskSignalRepo = createAuthorityRiskSignalRepository({
    authority: postgresAuthority,
    logger: { debug: (m, f) => logger.forModule("disputes").debug(m, f) },
  });
  const riskPolicyRepo = createAuthorityRiskPolicyRepository({
    authority: postgresAuthority,
    logger: { debug: (m, f) => logger.forModule("disputes").debug(m, f) },
  });
  const riskAssessmentRepo = createAuthorityRiskAssessmentRepository({
    authority: postgresAuthority,
    logger: { debug: (m, f) => logger.forModule("disputes").debug(m, f) },
  });
  const riskCaseRepo = createAuthorityRiskCaseRepository({
    authority: postgresAuthority,
    logger: { debug: (m, f) => logger.forModule("disputes").debug(m, f) },
  });
  const riskControlRepo = createAuthorityRiskControlRepository({
    authority: postgresAuthority,
    logger: { debug: (m, f) => logger.forModule("disputes").debug(m, f) },
  });
  const riskSignalService = createRiskSignalService({
    repository: riskSignalRepo,
    lookups: riskLookups,
    idempotency,
    auditWriter,
    logger: logger.forModule("disputes"),
  });
  const riskPolicyService = createRiskPolicyService({
    repository: riskPolicyRepo,
    idempotency,
    auditWriter,
    logger: logger.forModule("disputes"),
  });
  const riskAssessmentService = createRiskAssessmentService({
    assessmentRepository: riskAssessmentRepo,
    signalRepository: riskSignalRepo,
    policyRepository: riskPolicyRepo,
    idempotency,
    auditWriter,
    logger: logger.forModule("disputes"),
  });
  const riskCaseService = createRiskCaseService({
    repository: riskCaseRepo,
    lookups: riskLookups,
    idempotency,
    auditWriter,
    logger: logger.forModule("disputes"),
  });
  const riskControlService = createRiskControlService({
    repository: riskControlRepo,
    assessmentRepository: riskAssessmentRepo,
    caseRepository: riskCaseRepo,
    idempotency,
    auditWriter,
    logger: logger.forModule("disputes"),
  });

  // ------------------------------------------------------------------
  // NET-W010 disputes wiring (challenges, disputes, appeals).
  //
  // The dispute subject lookup is a thin adapter over the OWNING
  // domains' repositories (risk cases/controls here, contributions/
  // PoV/outcomes/economic records above) returning the subject's
  // deterministic eligibility anchor + interested beneficiary; the
  // stake lookup is read-only over the settlement authority's stake
  // records. The /disputes domain imports core contracts only —
  // stake/economic EXECUTION happens through the stakeService at the
  // composition-root commands below (never inside the disputes
  // domain: no hidden economic authority).
  // ------------------------------------------------------------------
  const disputeSubjectLookup = {
    async resolveSubject(subjectType: string, id: string) {
      switch (subjectType) {
        case "contribution": {
          const contribution = await contributionRepo.findById(id);
          return contribution
            ? {
                organizationScopeId: contribution.organizationScopeId,
                anchorAt: contribution.createdAt,
                beneficiaryPersonId: contribution.contributorId,
                state: contribution.state,
              }
            : null;
        }
        case "proof_of_value": {
          const pov = await proofOfValueRepo.findById(id);
          return pov
            ? {
                organizationScopeId: pov.organizationScopeId,
                anchorAt: pov.createdAt,
                beneficiaryPersonId: pov.ownerId,
                state: pov.state,
              }
            : null;
        }
        case "measured_outcome": {
          const measurement = await measuredOutcomeRepo.findById(id);
          return measurement
            ? {
                organizationScopeId: measurement.organizationScopeId,
                anchorAt: measurement.createdAt,
                beneficiaryPersonId: measurement.ownerId,
                state: measurement.state,
              }
            : null;
        }
        case "economic_value": {
          const value = await economicValueRepo.findById(id);
          return value
            ? {
                organizationScopeId: value.organizationScopeId,
                anchorAt: value.recordedAt,
                beneficiaryPersonId: value.beneficiaryPersonId,
                state: value.state,
              }
            : null;
        }
        case "credit_issuance": {
          const issuance = await creditIssuanceRepo.findById(id);
          return issuance
            ? {
                organizationScopeId: issuance.organizationScopeId,
                anchorAt: issuance.issuedAt,
                beneficiaryPersonId: issuance.beneficiaryPersonId,
                state: issuance.status,
              }
            : null;
        }
        case "cash_obligation": {
          const obligation = await cashObligationRepo.findById(id);
          return obligation
            ? {
                organizationScopeId: obligation.organizationScopeId,
                anchorAt: obligation.recordedAt,
                beneficiaryPersonId: obligation.counterpartyPersonId,
                state: obligation.status,
              }
            : null;
        }
        case "risk_case": {
          const riskCase = await riskCaseRepo.findById(id);
          if (!riskCase) return null;
          const lastDecision =
            riskCase.decisions[riskCase.decisions.length - 1] ?? null;
          return {
            organizationScopeId: riskCase.organizationScopeId,
            anchorAt: lastDecision
              ? lastDecision.recordedAt
              : riskCase.openedAt,
            beneficiaryPersonId: riskCase.subjectPersonId,
            state: riskCase.state,
          };
        }
        case "risk_control_decision": {
          const control = await riskControlRepo.findById(id);
          return control
            ? {
                organizationScopeId: control.organizationScopeId,
                anchorAt: control.activatedAt,
                beneficiaryPersonId: control.subjectPersonId,
                state: control.state,
              }
            : null;
        }
        default:
          return null;
      }
    },
  };
  const disputeStakeLookup = {
    async resolveStake(id: string) {
      const stake = await stakeRepo.findById(id);
      return stake
        ? {
            organizationScopeId: stake.organizationScopeId,
            ownerPersonId: stake.ownerPersonId,
            amount: stake.amount,
            unit: stake.unit,
            state: stake.state,
            purposeKind: stake.purpose.kind,
            purposeId: stake.purpose.id,
            committedAt: stake.committedAt,
          }
        : null;
    },
  };
  const disputeRepo = createAuthorityDisputeRepository({
    authority: postgresAuthority,
    logger: { debug: (m, f) => logger.forModule("disputes").debug(m, f) },
  });
  const disputeService = createDisputeService({
    repository: disputeRepo,
    lookups: {
      subject: riskSubjectLookup,
      sources: riskLookups,
      disputeSubject: disputeSubjectLookup,
      stake: disputeStakeLookup,
    },
    idempotency,
    auditWriter,
    logger: logger.forModule("disputes"),
  });

  // ------------------------------------------------------------------
  // NET-W011 campaigns wiring (campaign policy/configuration).
  //
  // The campaign lookups are thin read-only adapters over the OWNING
  // domains' repositories (settlement stakes + reward policies,
  // opportunities, identity) — the same dependency-inversion pattern
  // as the dispute lookups above. The /campaigns domain imports core
  // contracts only; economic EXECUTION (the budget escrow) and
  // opportunity COMPOSITION happen through the wired services at the
  // composition-root commands below (never inside the campaigns
  // domain: no hidden economic or lifecycle authority).
  // ------------------------------------------------------------------
  const campaignPersonLookup = {
    async exists(personId: string) {
      return identityRepo.exists(personId);
    },
  };
  const campaignStakeLookup = {
    async resolveStake(id: string) {
      const stake = await stakeRepo.findById(id);
      return stake
        ? {
            organizationScopeId: stake.organizationScopeId,
            ownerPersonId: stake.ownerPersonId,
            amount: stake.amount,
            unit: stake.unit,
            state: stake.state,
            purposeKind: stake.purpose.kind,
            purposeId: stake.purpose.id,
            committedAt: stake.committedAt,
          }
        : null;
    },
  };
  const campaignRewardPolicyLookup = {
    async resolvePolicy(policyId: string) {
      const latest = await rewardPolicyRepo.findLatestVersion(policyId);
      return latest
        ? {
            organizationScopeId: latest.organizationScopeId,
            latestVersion: latest.version,
          }
        : null;
    },
  };
  const campaignOpportunityLookup = {
    async resolveOpportunity(id: string) {
      const opportunity = await opportunityRepo.findById(id);
      return opportunity
        ? {
            organizationScopeId: opportunity.organizationScopeId,
            state: opportunity.state,
            opportunityType: opportunity.opportunityType,
            eligibilityPolicyReference: opportunity.eligibilityPolicyReference,
          }
        : null;
    },
  };
  const campaignRepo = createAuthorityCampaignRepository({
    authority: postgresAuthority,
    logger: { debug: (m, f) => logger.forModule("campaigns").debug(m, f) },
  });
  const campaignPolicyRepo = createAuthorityCampaignPolicyRepository({
    authority: postgresAuthority,
    logger: { debug: (m, f) => logger.forModule("campaigns").debug(m, f) },
  });
  const campaignService = createCampaignService({
    repository: campaignRepo,
    policyRepository: campaignPolicyRepo,
    lookups: {
      person: campaignPersonLookup,
      stake: campaignStakeLookup,
      rewardPolicy: campaignRewardPolicyLookup,
      opportunity: campaignOpportunityLookup,
    },
    idempotency,
    auditWriter,
    logger: logger.forModule("campaigns"),
  });

  // ------------------------------------------------------------------
  // NET-W015 creators wiring (creator identity and preferences).
  //
  // The creator lookups are thin READ-ONLY adapters over the OWNING
  // domains' repositories (identity, reputation) — the same
  // dependency-inversion pattern as the campaign lookups above. The
  // /creators domain imports core contracts only: /identity stays
  // the person identity authority (the profile anchor is validated
  // through the neutral person lookup), /reputation stays the
  // trust-signal authority (every reputation reference is verified
  // through the neutral snapshot lookup — references only, never
  // scores, never mutation). No economic command exists here at all
  // (declared rates are preferences, not commitments); matching is
  // NET-W016, UGC/rights NET-W017, sponsorship/disclosure NET-W018.
  // ------------------------------------------------------------------
  const creatorPersonLookup = {
    async exists(personId: string) {
      return identityRepo.exists(personId);
    },
  };
  const creatorReputationSnapshotLookup = {
    async resolve(snapshotId: string) {
      const snapshot = await reputationSnapshotRepo.findById(snapshotId);
      return snapshot
        ? {
            id: snapshot.id,
            organizationScopeId: snapshot.organizationScopeId,
            subjectPersonId: snapshot.subjectPersonId,
            digest: snapshot.digest,
          }
        : null;
    },
  };
  const creatorProfileRepo = createAuthorityCreatorProfileRepository({
    authority: postgresAuthority,
    logger: { debug: (m, f) => logger.forModule("creators").debug(m, f) },
  });
  const creatorProfileVersionRepo =
    createAuthorityCreatorProfileVersionRepository({
      authority: postgresAuthority,
      logger: { debug: (m, f) => logger.forModule("creators").debug(m, f) },
    });
  const creatorService = createCreatorService({
    repository: creatorProfileRepo,
    versionRepository: creatorProfileVersionRepo,
    lookups: {
      person: creatorPersonLookup,
      reputation: creatorReputationSnapshotLookup,
    },
    idempotency,
    auditWriter,
    logger: logger.forModule("creators"),
  });

  // ------------------------------------------------------------------
  // NET-W016 creator matching wiring (deterministic eligibility +
  // explicit-signal ranking + bounded advisory).
  //
  // MATCHING IS SELECTION, NOT AUTHORITY: the matching lookups are
  // thin READ-ONLY adapters over the OWNING domains' repositories
  // (campaigns policy, reputation snapshots, disputes risk-control
  // registry) — the same dependency-inversion pattern as every
  // lookup above. The /creators domain imports core contracts only:
  // /campaigns stays the campaign policy authority (requirements
  // derived read-only from a pinned policy version), /reputation
  // stays the trust-signal authority (references verified + scores
  // resolved read-only), /disputes stays the risk-control authority
  // (an active participant_eligibility control is a hard gate).
  // The advisory is the provider-neutral LlmPort (AI-002 — purpose
  // "matching"); AI output is advisory evidence only: it never
  // flips eligibility and only blends (capped) into the relevance
  // ranking signal. The ONLY mutation is the append-only,
  // idempotent, tenant-scoped match-run record + its audit event.
  // ------------------------------------------------------------------
  const creatorMatchCampaignLookup = {
    async resolve(campaignId: string, policyVersion?: number) {
      // The pinned policy version (or the lineage's latest when
      // omitted). /campaigns stays the campaign policy authority.
      let policy =
        policyVersion === undefined
          ? null
          : await campaignPolicyRepo.findVersion(campaignId, policyVersion);
      if (policyVersion === undefined) {
        const versions = await campaignPolicyRepo.listByCampaign(campaignId);
        const latest =
          versions.length > 0
            ? versions.reduce((a, b) => (b.version > a.version ? b : a))
            : null;
        policy = latest;
      }
      if (!policy) return null;
      // Derive the creator-relevant requirements from the policy's
      // closed eligibility vocabulary: language rules → required
      // languages; region rules → target territories (the operators
      // equals/not_equals/in/not_in map to requires/excludes; for
      // creator matching only the positive requirement side is a
      // hard gate — the W011 eligibility contract remains owned by
      // /campaigns and enforced on contributions downstream).
      const requiredLanguages: string[] = [];
      const targetTerritories: string[] = [];
      for (const rule of policy.eligibility.rules) {
        if (rule.attribute !== "language" && rule.attribute !== "region") {
          continue;
        }
        const positive =
          rule.operator === "equals" || rule.operator === "in";
        if (!positive) continue;
        for (const value of rule.values) {
          if (rule.attribute === "language") {
            requiredLanguages.push(value);
          } else {
            targetTerritories.push(value);
          }
        }
      }
      return {
        campaignId: policy.campaignId,
        policyVersion: policy.version,
        organizationScopeId: policy.organizationScopeId,
        requiredLanguages: [...new Set(requiredLanguages)],
        targetTerritories: [...new Set(targetTerritories)],
        objectiveKinds: policy.objectives.map((o) => o.kind),
        budgetUnit: policy.budget.unit,
        budgetTotalAmount: policy.budget.totalAmount,
      };
    },
  };
  const creatorMatchReputationLookup = {
    async resolveScore(snapshotId: string, dimension: string) {
      const snapshot = await reputationSnapshotRepo.findById(snapshotId);
      if (!snapshot) return null;
      const score = snapshot.scores.find(
        (s) => s.dimension === dimension,
      );
      if (!score) return null;
      return {
        snapshotId: snapshot.id,
        organizationScopeId: snapshot.organizationScopeId,
        subjectPersonId: snapshot.subjectPersonId,
        dimension: score.dimension,
        digest: snapshot.digest,
        score: score.score,
      };
    },
  };
  const creatorMatchSafetyLookup = {
    async activeHold(organizationScopeId: string, creatorPersonId: string) {
      // The active-control registry read (the composition-root gate
      // read): ACTIVE participant_eligibility controls covering the
      // creator person. Read-only — /disputes stays the authority.
      const controls = await riskControlRepo.findActiveControls(
        organizationScopeId,
        "participant_eligibility",
        creatorPersonId,
      );
      const control = controls.find(
        (c) => c.action === "HOLD" || c.action === "BLOCK",
      );
      return {
        held: control !== undefined,
        controlId: control?.id ?? null,
        action: control?.action ?? null,
      };
    },
  };
  // The advisory adapter over the provider-neutral LlmPort (AI-002):
  // [0,1] → 0–100 with provider identity preserved. Deterministic
  // per provider for identical inputs (the echo reference provider
  // is bit-reproducible; any external provider enters identically).
  const creatorMatchAdvisory = {
    async assess(input: {
      readonly rubricRef: string;
      readonly neutralFacts: readonly {
        readonly label: string;
        readonly value: string;
      }[];
    }) {
      const scored = await llmProvider.score({
        purpose: "matching",
        rubricRef: input.rubricRef,
        neutralFacts: input.neutralFacts,
      });
      return {
        score: Math.round(scored.score * 1000) / 10,
        provider: scored.provider,
        modelRef: scored.modelRef,
      };
    },
  };
  const creatorMatchRunRepo = createAuthorityCreatorMatchRunRepository({
    authority: postgresAuthority,
    logger: { debug: (m, f) => logger.forModule("creators").debug(m, f) },
  });
  const creatorMatchingService = createCreatorMatchingService({
    profileRepository: creatorProfileRepo,
    versionRepository: creatorProfileVersionRepo,
    runRepository: creatorMatchRunRepo,
    lookups: {
      campaign: creatorMatchCampaignLookup,
      reputation: creatorMatchReputationLookup,
      safety: creatorMatchSafetyLookup,
    },
    advisory: creatorMatchAdvisory,
    idempotency,
    auditWriter,
    logger: logger.forModule("creators"),
  });

  // ------------------------------------------------------------------
  // NET-W017 — UGC workflow and rights (creator engagements).
  //
  // The engagement is a NEW canonical lifecycle subject kind: every
  // state change routes through the SAME WorkflowService (the SOLE
  // lifecycle authority — the Proof-of-Value/measured-outcome
  // precedent; there is NO second lifecycle engine). The cross-domain
  // reads (campaign status/policy, opportunity/contribution lineage,
  // safety, evidence subject binding) are thin read-only adapters
  // over the OWNING domains' wired repositories. Acceptance/production
  // composes domain records + workflow transitions through the
  // composition root. NO economic/reputation/risk/outcome mutation,
  // NO AI path (work order §2).
  // ------------------------------------------------------------------
  const engagementCampaignLookup: EngagementCampaignLookup = {
    async resolve(campaignId, policyVersion) {
      // The campaign record (existence + tenant scope + the
      // administrative status the tender precondition reads).
      // /campaigns stays the campaign policy authority.
      const campaign = await campaignRepo.findById(campaignId);
      if (!campaign) return null;
      let pinned: number | null = null;
      if (policyVersion !== undefined) {
        const policy = await campaignPolicyRepo.findVersion(
          campaignId,
          policyVersion,
        );
        if (!policy) return null;
        pinned = policy.version;
      } else {
        const versions = await campaignPolicyRepo.listByCampaign(campaignId);
        pinned =
          versions.length > 0
            ? versions.reduce((a, b) => (b.version > a.version ? b : a))
                .version
            : null;
      }
      return {
        campaignId: campaign.id,
        policyVersion: pinned,
        organizationScopeId: campaign.organizationScopeId,
        status: campaign.status,
      };
    },
  };
  const engagementOpportunityLookup: EngagementOpportunityLookup = {
    async getOrganizationScope(opportunityId) {
      const opp = await opportunityRepo.findById(opportunityId);
      return opp ? opp.organizationScopeId : null;
    },
    async exists(opportunityId) {
      return opportunityRepo.exists(opportunityId);
    },
  };
  const engagementContributionLookup: EngagementContributionLookup = {
    async getOrganizationScope(contributionId) {
      const c = await contributionRepo.findById(contributionId);
      return c ? c.organizationScopeId : null;
    },
    async exists(contributionId) {
      return contributionRepo.exists(contributionId);
    },
  };
  const engagementEvidenceLookup: ProductionEvidenceLookup = {
    async resolve(evidenceId) {
      // The canonical /evidence authority read: existence + tenant
      // scope + subject binding. The UGC boundary only VALIDATES
      // references through this view — it never fabricates evidence.
      const evidence = await evidenceRepo.findById(evidenceId);
      if (!evidence) return null;
      return {
        id: evidence.id,
        organizationScopeId: evidence.organizationScopeId,
        subjectType: evidence.subjectReference.subjectType,
        subjectId: evidence.subjectReference.subjectId,
      };
    },
  };
  const creatorEngagementService = createCreatorEngagementService({
    engagementRepository: engagementRepo,
    acceptancePolicyRepository: creatorAcceptancePolicyRepo,
    usageRightsRepository: usageRightsRepo,
    productionRepository: ugcProductionRepo,
    deliverableRepository: ugcDeliverableRepo,
    submissionRepository: ugcSubmissionRepo,
    batchRepository: engagementBatchRepo,
    profileRepository: creatorProfileRepo,
    versionRepository: creatorProfileVersionRepo,
    runRepository: creatorMatchRunRepo,
    lookups: {
      campaign: engagementCampaignLookup,
      opportunity: engagementOpportunityLookup,
      contribution: engagementContributionLookup,
      safety: creatorMatchSafetyLookup,
      evidence: engagementEvidenceLookup,
    },
    workflow: {
      // Delegate to the SAME workflow service instance (the
      // /workflows boundary is the SOLE lifecycle authority for
      // engagement transitions, exactly as for opportunities/
      // contributions/proofs/measured outcomes). NET-W017 remediation:
      // the composite commands execute the transition IN-TX through
      // the sanctioned twin so the material record + the transition
      // commit as ONE authoritative unit.
      async requestTransitionWithinTx(request, execution, tx, idempotencyRecordId) {
        return workflowService.requestTransitionWithinTx(
          request,
          execution,
          tx,
          idempotencyRecordId,
        );
      },
    },
    idempotency,
    auditWriter,
    logger: logger.forModule("creators"),
  });

  // ------------------------------------------------------------------
  // NET-W018 — Sponsorship and disclosure (commercial relationships,
  // disclosure declarations, publications).
  //
  // The publication is a NEW canonical lifecycle subject kind: every
  // state change routes through the SAME WorkflowService (the SOLE
  // lifecycle authority — the engagement precedent; there is NO
  // second lifecycle engine). The disclosure POLICY arrives through
  // a thin READ-ONLY adapter over the campaigns boundary's policy
  // repository (the dependency-inversion pattern); disclosure/
  // publication EVIDENCE references validate through the same
  // neutral evidence lookup as the engagement service. The
  // verification composite executes the DRAFT → VERIFIED transition
  // IN-TX through the sanctioned twin (the NET-W017 remediation
  // pattern applied from the start). NO economic/reputation/risk/
  // outcome mutation, NO AI path (work order §2).
  // ------------------------------------------------------------------
  const campaignDisclosurePolicyLookup: CampaignDisclosurePolicyLookup = {
    async resolve(campaignId, policyVersion) {
      // /campaigns stays the campaign policy authority: resolve the
      // campaign (existence + tenant scope), then the pinned-or-
      // latest policy version's declared disclosure section. An
      // absent section (pre-W018 versions) reads as EMPTY — no
      // requirements declared.
      const campaign = await campaignRepo.findById(campaignId);
      if (!campaign) return null;
      let policy: import("../campaigns/port.ts").CampaignPolicy | null = null;
      if (policyVersion !== undefined) {
        policy = await campaignPolicyRepo.findVersion(campaignId, policyVersion);
        if (!policy) return null;
      } else {
        const versions = await campaignPolicyRepo.listByCampaign(campaignId);
        policy =
          versions.length > 0
            ? versions.reduce((a, b) => (b.version > a.version ? b : a))
            : null;
      }
      return {
        campaignId: campaign.id,
        organizationScopeId: campaign.organizationScopeId,
        policyVersion: policy ? policy.version : null,
        requiredKinds: policy?.disclosurePolicy?.requiredKinds ?? [],
      };
    },
  };
  const sponsorshipEvidenceLookup: ProductionEvidenceLookup = {
    async resolve(evidenceId) {
      // The canonical /evidence authority read: existence + tenant
      // scope + subject binding. The sponsorship boundary only
      // VALIDATES references through this view — it never fabricates
      // disclosure/publication proof.
      const evidence = await evidenceRepo.findById(evidenceId);
      if (!evidence) return null;
      return {
        id: evidence.id,
        organizationScopeId: evidence.organizationScopeId,
        subjectType: evidence.subjectReference.subjectType,
        subjectId: evidence.subjectReference.subjectId,
      };
    },
  };
  const sponsorshipWorkflowPort: SponsorshipWorkflowPort = {
    // Delegate to the SAME workflow service instance (the /workflows
    // boundary is the SOLE lifecycle authority for publication
    // transitions, exactly as for engagements). The verification
    // composite executes the transition IN-TX through the sanctioned
    // twin so the material bookkeeping + the transition commit as
    // ONE authoritative unit. The `sanction` argument passes through
    // VERBATIM: the DRAFT → VERIFIED edge resolves only for the
    // composite presenting PUBLICATION_VERIFICATION_SANCTION (the
    // PR #36 remediation); the generic path passes no sanction.
    async requestTransitionWithinTx(
      request,
      execution,
      tx,
      idempotencyRecordId,
      sanction,
    ) {
      return workflowService.requestTransitionWithinTx(
        request,
        execution,
        tx,
        idempotencyRecordId,
        sanction,
      );
    },
  };
  const creatorSponsorshipService = createCreatorSponsorshipService({
    relationshipRepository: commercialRelationshipRepo,
    declarationRepository: disclosureDeclarationRepo,
    publicationRepository: publicationRepo,
    engagementRepository: engagementRepo,
    productionRepository: ugcProductionRepo,
    lookups: {
      campaignDisclosurePolicy: campaignDisclosurePolicyLookup,
      evidence: sponsorshipEvidenceLookup,
    },
    workflow: sponsorshipWorkflowPort,
    idempotency,
    auditWriter,
    logger: logger.forModule("creators"),
  });

  // ------------------------------------------------------------------
  // NET-W019 — Inventory and placements (supply registration,
  // placement context, supply authorization, source provenance).
  //
  // The inventory boundary (one of the SIXTEEN frozen core domains —
  // NO 17th domain) owns supply registration + placement context.
  // The campaign policy scope (status + pinned-or-latest version +
  // the version's ELIGIBILITY RULES) arrives through a thin READ-ONLY
  // adapter over the campaigns boundary's repositories (the same
  // dependency-inversion pattern); the supply-verification evidence
  // reference validates through the same neutral evidence lookup
  // pattern. Items and placements carry NO lifecycle subject kind —
  // /workflows stays untouched (withdrawal/retirement are one-way
  // field mutations, the W018 termination precedent). NO economic/
  // reputation/risk/outcome mutation, NO AI path (work order §2).
  // ------------------------------------------------------------------
  const inventoryCampaignLookup: InventoryCampaignLookup = {
    async resolvePolicy(campaignId, policyVersion) {
      // /campaigns stays the campaign policy authority: resolve the
      // campaign (existence + tenant scope + administrative status),
      // then the pinned-or-latest policy version's ELIGIBILITY
      // section. A campaign with no policy versions resolves to null
      // (nothing to scope a placement to).
      const campaign = await campaignRepo.findById(campaignId);
      if (!campaign) return null;
      let policy: import("../campaigns/port.ts").CampaignPolicy | null = null;
      if (policyVersion !== undefined) {
        policy = await campaignPolicyRepo.findVersion(campaignId, policyVersion);
        if (!policy) return null;
      } else {
        const versions = await campaignPolicyRepo.listByCampaign(campaignId);
        policy =
          versions.length > 0
            ? versions.reduce((a, b) => (b.version > a.version ? b : a))
            : null;
        if (!policy) return null;
      }
      return {
        campaignId: campaign.id,
        organizationScopeId: campaign.organizationScopeId,
        campaignStatus: campaign.status,
        policyVersion: policy.version,
        eligibilityRules: policy.eligibility.rules.map((rule) => ({
          attribute: rule.attribute,
          operator: rule.operator,
          values: [...rule.values],
        })),
      };
    },
  };
  const inventoryEvidenceLookup: InventoryEvidenceLookup = {
    async resolve(evidenceId) {
      // The canonical /evidence authority read: existence + tenant
      // scope + subject binding. The inventory boundary only
      // VALIDATES references through this view — it never fabricates
      // supply proof (the INV-003 ecosystem signal).
      const evidence = await evidenceRepo.findById(evidenceId);
      if (!evidence) return null;
      return {
        id: evidence.id,
        organizationScopeId: evidence.organizationScopeId,
        subjectType: evidence.subjectReference.subjectType,
        subjectId: evidence.subjectReference.subjectId,
      };
    },
  };
  const inventoryService = createInventoryService({
    itemRepository: inventoryItemRepo,
    placementRepository: inventoryPlacementRepo,
    lookups: {
      campaign: inventoryCampaignLookup,
      evidence: inventoryEvidenceLookup,
    },
    idempotency,
    auditWriter,
    logger: logger.forModule("inventory"),
  });

  // ------------------------------------------------------------------
  // NET-W023 — OpenRTB / supply-chain adapters wiring (ADAPTER-001..002).
  //
  // The /adapters boundary owns provider-specific protocol parsing;
  // this composition root is the ONLY join between normalized adapter
  // output and the existing domain authorities:
  //  - the NEUTRAL read-only inventory lookup below resolves external
  //    (provider, externalId) references against REGISTERED supply
  //    through the inventory authority's own org-scoped reads (the
  //    adapter tier may not import /inventory — tier matrix);
  //  - the ingress service routes raw submissions to the registered
  //    provider adapter, enforces the neutral contract, and derives
  //    the admission evaluation (a PURE derivation — NO mutation);
  //  - the ONLY sanctioned material path (delivery-notice measurement
  //    facts) flows through the W022 submitMeasurementReport composite
  //    into /outcomes exactly-once ingestion + atomic audit.
  // ------------------------------------------------------------------
  const openRtbProviders: readonly OpenRtbProviderAdapter[] =
    opts.adapters?.openRtbProviders?.length
      ? opts.adapters.openRtbProviders
      : [new OpenRtbReferenceAdapter()];
  const openRtbProviderRegistry = createOpenRtbProviderRegistry();
  for (const adapter of openRtbProviders) {
    openRtbProviderRegistry.register(adapter);
  }
  const adaptersServiceCtx = createExecutionContext({
    correlationId: "adapters-supply-lookup",
    actor: { id: "adapters", kind: "service" },
  });
  const externalInventoryLookup: ExternalInventorySupplyLookup = {
    // READ-ONLY + tenant-scoped: the inventory authority's own
    // org-scoped list (cross-org identifiers resolve to zero matches —
    // not-found semantics, no existence oracle). Exact-one
    // resolution is enforced by the ingress evaluation.
    async resolveByExternalReference(organizationScopeId, provider, externalId) {
      const items = await inventoryService.listInventoryItems(
        getExecutionContext() ?? adaptersServiceCtx,
        organizationScopeId,
      );
      const matches = items.filter(
        (item) =>
          item.externalReference !== null &&
          item.externalReference.provider === provider &&
          item.externalReference.externalId === externalId,
      );
      return matches.map((item) => ({
        itemId: item.id,
        organizationScopeId: item.organizationScopeId,
        surfaceKind: item.surfaceKind,
        format: item.format,
        ownerPersonId: item.ownerPersonId,
        retiredAt: item.retiredAt,
      }));
    },
  };
  // PR #47 remediation: the seller-authorization trust channel key.
  // Resolution order: the explicit composition override (test
  // wiring / operator-provided channel key) FIRST, then the
  // SELLER_AUTHORIZATION_TRUST_KEY secret through the SecretProvider
  // — the SAME wiring rule as the measurement attribution adapters.
  // Neither present → the trust channel is NOT configured: no
  // seller-authorization submission can be authenticated and no
  // supply chain can be `verified` (fail closed; the W022
  // no-secret rule). The value NEVER crosses into logs, audit, or
  // domain modules (PRIV-002).
  const sellerAuthorizationTrustKey =
    opts.adapters?.sellerAuthorizationTrustKey !== undefined
      ? opts.adapters.sellerAuthorizationTrustKey
      : secretProvider.hasSecret(SELLER_AUTHORIZATION_TRUST_SECRET_KEY)
        ? secretProvider.getSecretSync(SELLER_AUTHORIZATION_TRUST_SECRET_KEY)
        : undefined;
  const openRtbIngress = createOpenRtbIngressService({
    registry: openRtbProviderRegistry,
    inventoryLookup: externalInventoryLookup,
    logger: logger.forModule("adapters"),
    ...(sellerAuthorizationTrustKey !== undefined
      ? { sellerAuthorizationTrustKey }
      : {}),
  });

  // ------------------------------------------------------------------
  // NET-W024 demand wiring (consumer demand pools).
  //
  // The membership lookup is a thin READ-ONLY adapter over the
  // /organizations membership repository (the W002 structural-lookup
  // precedent): the demand domain imports core contracts only and
  // NEVER the organizations port. The /demand domain has ZERO
  // economic surface (/settlement untouched by NET-W024) and NO
  // lifecycle machinery (/workflows untouched — pool closure and
  // commitment withdrawal are one-way field mutations).
  // ------------------------------------------------------------------
  const demandMembershipLookup: DemandMembershipLookup = {
    async resolveMembership(personId, organizationScopeId) {
      const membership = await membershipRepo.findByPersonAndOrganization(
        personId,
        organizationScopeId,
      );
      return membership ? membership.status : null;
    },
  };
  const demandService = createDemandService({
    poolRepository: demandPoolRepo,
    commitmentRepository: demandCommitmentRepo,
    membershipLookup: demandMembershipLookup,
    idempotency,
    auditWriter,
    logger: logger.forModule("demand"),
  });

  // ------------------------------------------------------------------
  // NET-W025 procurement wiring (business procurement pools — the
  // SAME /demand boundary, NOT a second authority).
  //
  // The procurement service reuses the SAME neutral membership
  // lookup adapter (resolveMembership answers for ANY organization:
  // the tenant gate AND the buyer-organization gate alike — the
  // /organizations authority stays the single membership source,
  // read-only through the composition root). The /demand boundary
  // still has ZERO economic surface (/settlement untouched by
  // NET-W025) and NO lifecycle machinery (/workflows untouched).
  // ------------------------------------------------------------------
  const procurementService = createProcurementService({
    poolRepository: procurementPoolRepo,
    commitmentRepository: procurementCommitmentRepo,
    membershipLookup: demandMembershipLookup,
    idempotency,
    auditWriter,
    logger: logger.forModule("demand"),
  });

  // ------------------------------------------------------------------
  // NET-W026 supplier-offer/selection wiring (supplier offers +
  // competitive selection — the SAME /demand boundary, NOT a second
  // authority).
  //
  // The supplier-offer service reuses the SAME neutral membership
  // lookup adapter (the authorized-supplier gate is an ACTIVE tenant
  // membership, resolved through the /organizations authority) AND
  // the SAME procurement pool/commitment repositories (the
  // qualified-demand gate re-derives the W025 aggregate from the
  // /demand boundary's own records — the demand authority is
  // /demand itself, never a caller). The /demand boundary still has
  // ZERO economic surface (/settlement untouched by NET-W026: a
  // selection is a procurement decision, never an economic one) and
  // NO lifecycle machinery (/workflows untouched: offer withdrawal
  // is a one-way field mutation; expiry is derived from the recorded
  // validity window).
  // ------------------------------------------------------------------
  const supplierOfferService = createSupplierOfferService({
    offerRepository: supplierOfferRepo,
    selectionRepository: competitiveSelectionRepo,
    poolRepository: procurementPoolRepo,
    commitmentRepository: procurementCommitmentRepo,
    membershipLookup: demandMembershipLookup,
    idempotency,
    auditWriter,
    logger: logger.forModule("demand"),
  });

  // ------------------------------------------------------------------
  // NET-W027 savings/counterfactual wiring (verified savings and
  // counterfactuals — the SAME /demand boundary, NOT a second
  // authority).
  //
  // The savings service reuses the SAME neutral membership lookup
  // adapter (the pool-creator + active-membership gates resolve
  // through the /organizations authority) AND the SAME procurement
  // pool/selection repositories (same-boundary state). The
  // cross-boundary facts are consumed through the TWO NEUTRAL
  // read-only lookups declared in the /demand port and wired here
  // (the dependency-inversion pattern — /evidence stays the
  // provenance/truth authority, /outcomes stays the normalized
  // measurement authority; the adapters expose scope/subject/source
  // facts, observed values/confidence/provenance/chain position —
  // never measurement semantics). The /demand boundary still has
  // ZERO economic surface (/settlement untouched by NET-W027: a
  // verified savings claim is a measurement decision, never an
  // economic one) and NO lifecycle machinery (/workflows untouched:
  // baseline invalidation is a one-way field mutation; evidence
  // staleness and observation supersession are DERIVED at the
  // evaluation anchor).
  // ------------------------------------------------------------------
  const procurementSavingsEvidenceLookup: ProcurementSavingsEvidenceLookup =
    {
      async resolve(evidenceId) {
        // Read-only facts over the /evidence authority's repository:
        // scope, subject binding and source type ONLY.
        const record = await evidenceRepo.findById(evidenceId);
        if (!record) return null;
        return {
          id: record.id,
          organizationScopeId: record.organizationScopeId,
          subjectId: record.subjectReference.subjectId,
          subjectType: record.subjectReference.subjectType,
          sourceType: record.provenance.sourceType,
        };
      },
    };
  const procurementSavingsOutcomeLookup: ProcurementSavingsOutcomeLookup =
    {
      async resolve(observationId) {
        // Read-only facts over the /outcomes authority's observation
        // repository: scope, subject binding, outcome type, observed
        // value + unit, confidence, provenance source type +
        // collection time, and the correction-chain position (a
        // superseded observation is not chain head — the /outcomes
        // authority owns the chain semantics; the adapter only
        // exposes the derived position fact).
        const record =
          await outcomeObservationRepo.findById(observationId);
        if (!record) return null;
        const corrections =
          await outcomeObservationRepo.findByCorrectionOf(observationId);
        const superseding = corrections
          .map((correction) => correction.id)
          .sort()[0] ?? null;
        return {
          id: record.id,
          organizationScopeId: record.organizationScopeId,
          subjectId: record.subjectReference.subjectId,
          subjectType: record.subjectReference.subjectType,
          outcomeType: record.outcomeType,
          observedValue: {
            value: record.observedValue.value,
            unit: record.observedValue.unit,
          },
          confidence: record.confidence,
          provenance: {
            sourceType: record.provenance.sourceType,
            collectedAt: record.provenance.collectedAt,
          },
          correctsObservationId: record.correctsObservationId,
          supersededByObservationId: superseding,
        };
      },
    };
  const procurementSavingsService = createProcurementSavingsService({
    baselineRepository: procurementBaselineRepo,
    savingsRepository: procurementSavingsRepo,
    poolRepository: procurementPoolRepo,
    selectionRepository: competitiveSelectionRepo,
    membershipLookup: demandMembershipLookup,
    evidenceLookup: procurementSavingsEvidenceLookup,
    outcomeLookup: procurementSavingsOutcomeLookup,
    idempotency,
    auditWriter,
    logger: logger.forModule("demand"),
  });

  // ------------------------------------------------------------------
  // NET-W028 Benefit Pools wiring (the /benefits boundary).
  //
  // The /benefits domain imports core contracts only; EVERY
  // cross-domain fact arrives read-only through the neutral
  // structural lookups wired HERE (the W024–W027
  // dependency-inversion precedent):
  //  - membership over the /organizations authority (the same
  //    demand membership lookup);
  //  - value-record facts over the /settlement economic authority's
  //    OWN repository (committed + in-tx fresh reads);
  //  - the CURRENT savings verdict over the /demand savings
  //    authority's re-derivation (the record's OWN derivation
  //    inputs, evaluated with the record's own recorder identity —
  //    read-only; a lapsed creator membership, an invalidated
  //    baseline or stale evidence makes funding fail closed);
  //  - reward-policy facts over the /settlement policy authority;
  //  - THE ECONOMIC DRAW over the /settlement RewardService's
  //    same-domain `...WithinTx` form (the W020 remediation
  //    pattern) + the EXACT lock-key set the draw's standalone form
  //    would acquire — /settlement stays the SOLE economic authority.
  // ------------------------------------------------------------------
  const benefitPoolPolicyRepo = createAuthorityBenefitPoolPolicyRepository({
    authority: postgresAuthority,
    logger: { debug: (m, f) => logger.forModule("benefits").debug(m, f) },
  });
  const benefitPoolRepo = createAuthorityBenefitPoolRepository({
    authority: postgresAuthority,
    logger: { debug: (m, f) => logger.forModule("benefits").debug(m, f) },
  });
  const benefitPoolAllocationRepo =
    createAuthorityBenefitPoolAllocationRepository({
      authority: postgresAuthority,
      logger: { debug: (m, f) => logger.forModule("benefits").debug(m, f) },
    });
  const benefitsMembershipLookup: BenefitMembershipLookup = {
    async isActiveMember(organizationScopeId, personId) {
      const state = await demandMembershipLookup.resolveMembership(
        personId,
        organizationScopeId,
      );
      return state === "active";
    },
  };
  function toBenefitValueFacts(record: {
    readonly id: string;
    readonly organizationScopeId: string;
    readonly state: string;
    readonly amount: number;
    readonly beneficiaryPersonId: string;
    readonly consumedBy: unknown;
    readonly reversal: unknown;
  }): BenefitValueFundingFacts {
    return {
      valueRecordId: record.id,
      organizationScopeId: record.organizationScopeId,
      state: record.state,
      amount: record.amount,
      beneficiaryPersonId: record.beneficiaryPersonId,
      consumed: record.consumedBy !== null && record.consumedBy !== undefined,
      reversed: record.reversal !== null && record.reversal !== undefined,
    };
  }
  const benefitsValueFundingLookup: BenefitValueFundingLookup = {
    async resolve(valueRecordId) {
      const record = await economicValueRepo.findById(valueRecordId);
      return record === null ? null : toBenefitValueFacts(record);
    },
    async resolveWithinTx(valueRecordId, tx) {
      const record = await economicValueRepo.findByIdWithinTx(valueRecordId, tx);
      return record === null ? null : toBenefitValueFacts(record);
    },
  };
  const benefitsSavingsFundingLookup: BenefitSavingsFundingLookup = {
    async resolveCurrent(savingsId) {
      const record = await procurementSavingsRepo.findById(savingsId);
      if (!record) return null;
      // The CURRENT re-derivation: the record's OWN derivation inputs,
      // evaluated with the record's own recorder identity (read-only —
      // the derivation mutates and audits nothing; a lapsed creator
      // membership, a missing pool or an invalidated baseline makes
      // the funding fail closed — supported:false).
      const derivationCtx = createExecutionContext({
        correlationId: "benefits-savings-funding-lookup",
        actor: { id: record.recordedBy, kind: "person" },
      });
      try {
        const view = await procurementSavingsService.evaluateProcurementSavings(
          derivationCtx,
          {
            organizationScopeId: record.organizationScopeId,
            poolId: record.poolId,
            baselineId: record.baselineId,
            outcomeObservationIds: [...record.observationIds],
            selectionId: record.selectionId,
          },
        );
        return {
          savingsId: record.id,
          organizationScopeId: record.organizationScopeId,
          procurementPoolId: record.poolId,
          supported: view.supported,
          savingsValue: view.savings === null ? null : view.savings.value,
          unit: view.savings === null ? null : view.savings.unit,
          digest: view.digest,
          derivationPolicyVersion: view.derivationPolicy.version,
          recordFormat: record.recordFormat,
        };
      } catch {
        // The current re-derivation refused — funding fails closed.
        return {
          savingsId: record.id,
          organizationScopeId: record.organizationScopeId,
          procurementPoolId: record.poolId,
          supported: false,
          savingsValue: null,
          unit: null,
          digest: null,
          derivationPolicyVersion: record.derivationPolicy.version,
          recordFormat: record.recordFormat,
        };
      }
    },
  };
  const benefitsRewardPolicyLookup: BenefitRewardPolicyLookup = {
    async resolveLatest(policyId) {
      const policy = await rewardPolicyRepo.findLatestVersion(policyId, undefined);
      if (!policy) return null;
      return {
        policyId: policy.policyId,
        version: policy.version,
        organizationScopeId: policy.organizationScopeId,
        allocations: policy.allocations.map((allocation) => ({
          beneficiaryPersonId: allocation.beneficiaryPersonId,
          weight: allocation.weight,
        })),
      };
    },
  };
  const benefitsEconomicDrawPort: BenefitEconomicDrawPort = {
    async allocateRewardDrawWithinTx(execution, input, ctx) {
      // The EXISTING /settlement reward-allocation primitive on the
      // CALLER'S authoritative transaction (never the
      // transaction-owning command): the balanced allocation
      // postings, the draw record, the exactly-once value consumption
      // and the buffered audit event stage on the pool allocation's
      // transaction — /settlement stays the sole economic authority.
      const allocation = await rewardService.allocateRewardsWithinTx(
        execution,
        {
          organizationScopeId: input.organizationScopeId,
          sourceValueRecordId: input.sourceValueRecordId,
          policyId: input.policyId,
          ...(input.version !== undefined ? { version: input.version } : {}),
          idempotencyKey: input.idempotencyKey,
        },
        ctx,
      );
      return {
        drawResultId: allocation.id,
        transactionId: allocation.transactionId,
        sourceValueRecordId: allocation.sourceValueRecordId,
        policyId: allocation.policyId,
        policyVersion: allocation.policyVersion,
        totalAllocated: allocation.totalAllocated,
        shares: allocation.shares.map((share) => ({
          beneficiaryPersonId: share.beneficiaryPersonId,
          amount: share.amount,
          weight: share.weight,
        })),
      };
    },
    drawLockKeys(input) {
      // The EXACT lock set the draw's standalone form would acquire
      // (the value-record lock + the allocation account set) so the
      // composite holds them ACROSS its authoritative transaction.
      return {
        recordLockKey: valueRecordLockKey(input.sourceValueRecordId),
        accountIds: allocationAccountIds(
          input.organizationScopeId,
          input.sourceBeneficiaryPersonId,
          input.memberPersonIds,
        ),
      };
    },
  };
  const benefitPoolService = createBenefitPoolService({
    policyRepository: benefitPoolPolicyRepo,
    poolRepository: benefitPoolRepo,
    allocationRepository: benefitPoolAllocationRepo,
    lookups: {
      membership: benefitsMembershipLookup,
      valueFunding: benefitsValueFundingLookup,
      savingsFunding: benefitsSavingsFundingLookup,
      rewardPolicy: benefitsRewardPolicyLookup,
      economicDraw: benefitsEconomicDrawPort,
    },
    idempotency,
    auditWriter,
    logger: logger.forModule("benefits"),
  });

  // ------------------------------------------------------------------
  // NET-W012 helpful contributions wiring (Proof-of-Helpfulness).
  //
  // The helpfulness lookups are thin READ-ONLY adapters over the
  // OWNING domains' repositories (campaigns, opportunities, evidence,
  // outcomes) — the same dependency-inversion pattern as the campaign
  // lookups above. The /contributions domain imports core contracts
  // only; lifecycle EXECUTION (the publication transitions) happens
  // through the wired WorkflowService at the composition-root
  // publishHelpfulContribution command below (never inside the
  // contributions domain: no hidden lifecycle authority — and NO
  // economic command exists here at all; reward integration is
  // NET-W014).
  // ------------------------------------------------------------------
  const helpfulnessCampaignLookup = {
    async resolveEligibilityPolicy(reference: string) {
      // Parse the deterministic NET-W011 reference
      // `campaign_policy:{campaignId}:{version}:{specId}`.
      const match = /^campaign_policy:([^:]+):(\d+):(.+)$/.exec(reference);
      if (!match) return null;
      const [, campaignId, versionRaw, specId] = match;
      const policy = await campaignPolicyRepo.findVersion(
        campaignId!,
        Number(versionRaw),
      );
      if (!policy) return null;
      const campaign = await campaignRepo.findById(campaignId!);
      if (!campaign) return null;
      return {
        organizationScopeId: policy.organizationScopeId,
        campaignId: campaignId!,
        policyVersion: policy.version,
        specId: specId!,
        campaignStatus: campaign.status,
        rules: policy.eligibility.rules,
      };
    },
  };
  const helpfulnessOpportunityLookup = {
    async resolveOpportunity(id: string) {
      const opportunity = await opportunityRepo.findById(id);
      return opportunity
        ? {
            organizationScopeId: opportunity.organizationScopeId,
            opportunityType: opportunity.opportunityType,
            eligibilityPolicyReference: opportunity.eligibilityPolicyReference,
          }
        : null;
    },
  };
  const helpfulnessEvidenceLookup = {
    async resolveEvidence(id: string) {
      const evidence = await evidenceRepo.findById(id);
      return evidence
        ? {
            organizationScopeId: evidence.organizationScopeId,
            subjectId: evidence.subjectReference.subjectId,
            subjectType: evidence.subjectReference.subjectType,
            sourceType: evidence.provenance.sourceType,
            grade: evidence.grade,
            confidence: evidence.confidence,
            provenanceSourceId: evidence.provenance.sourceId ?? null,
          }
        : null;
    },
  };
  const helpfulnessMeasurementLookup = {
    async resolveMeasuredOutcome(id: string) {
      const measured = await measuredOutcomeRepo.findById(id);
      return measured
        ? {
            organizationScopeId: measured.organizationScopeId,
            subjectId: measured.subjectReference.subjectId,
            subjectType: measured.subjectReference.subjectType,
            outcomeType: measured.outcomeType,
            state: measured.state,
            rollupConfidence: measured.rollup?.confidence ?? null,
          }
        : null;
    },
  };
  const helpfulnessProofOfValueLookup = {
    async resolveProofOfValue(id: string) {
      const pov = await proofOfValueRepo.findById(id);
      return pov
        ? {
            organizationScopeId: pov.organizationScopeId,
            subjectId: pov.subjectReference.subjectId,
            subjectType: pov.subjectReference.subjectType,
            state: pov.state,
          }
        : null;
    },
  };
  const helpfulnessPolicyRepo = createAuthorityHelpfulnessPolicyRepository({
    authority: postgresAuthority,
    logger: {
      debug: (m, f) => logger.forModule("contributions").debug(m, f),
    },
  });
  const proofOfHelpfulnessRepo =
    createAuthorityProofOfHelpfulnessRepository({
      authority: postgresAuthority,
      logger: {
        debug: (m, f) => logger.forModule("contributions").debug(m, f),
      },
    });
  const commercialDisclosureRepo =
    createAuthorityCommercialDisclosureRepository({
      authority: postgresAuthority,
      logger: {
        debug: (m, f) => logger.forModule("contributions").debug(m, f),
      },
    });
  const helpfulnessService = createHelpfulnessService({
    contributionRepository: contributionRepo,
    policyRepository: helpfulnessPolicyRepo,
    pohRepository: proofOfHelpfulnessRepo,
    disclosureRepository: commercialDisclosureRepo,
    lookups: {
      campaign: helpfulnessCampaignLookup,
      opportunity: helpfulnessOpportunityLookup,
      evidence: helpfulnessEvidenceLookup,
      measurement: helpfulnessMeasurementLookup,
      proofOfValue: helpfulnessProofOfValueLookup,
    },
    idempotency,
    auditWriter,
    logger: logger.forModule("contributions"),
  });

  // ------------------------------------------------------------------
  // NET-W013 quality/moderation/anti-spam wiring.
  //
  // The quality service reads the truth authorities through the SAME
  // neutral lookups the helpfulness service consumes (the quality
  // engine re-resolves the PoH's recorded bases at evaluation time),
  // plus a PoH lookup over this domain's own repository. The
  // moderation service shares the contribution repository and the
  // quality evaluation repository (same-domain reads). The
  // spam/abuse RISK-SIGNAL emission is composed ONLY in the
  // apiCommands below (never inside a domain: no second fraud
  // authority); the LLM provider is consumed ONLY by the
  // generateAdvisoryQualityScore composite (never a domain module —
  // the domain-must-not-import-adapter rule).
  // ------------------------------------------------------------------
  const qualityPolicyRepo = createAuthorityQualityPolicyRepository({
    authority: postgresAuthority,
    logger: { debug: (m, f) => logger.forModule("contributions").debug(m, f) },
  });
  const qualityEvaluationRepo = createAuthorityQualityEvaluationRepository({
    authority: postgresAuthority,
    logger: { debug: (m, f) => logger.forModule("contributions").debug(m, f) },
  });
  const advisoryQualityScoreRepo =
    createAuthorityAdvisoryQualityScoreRepository({
      authority: postgresAuthority,
      logger: { debug: (m, f) => logger.forModule("contributions").debug(m, f) },
    });
  const qualityPohLookup = {
    async resolveByContribution(contributionId: string) {
      return proofOfHelpfulnessRepo.findByContributionId(contributionId);
    },
  };
  const qualityService = createQualityService({
    contributionRepository: contributionRepo,
    policyRepository: qualityPolicyRepo,
    evaluationRepository: qualityEvaluationRepo,
    advisoryRepository: advisoryQualityScoreRepo,
    pohRepository: proofOfHelpfulnessRepo,
    lookups: {
      proofOfHelpfulness: qualityPohLookup,
      evidence: helpfulnessEvidenceLookup,
      measurement: helpfulnessMeasurementLookup,
      proofOfValue: helpfulnessProofOfValueLookup,
    },
    idempotency,
    auditWriter,
    logger: logger.forModule("contributions"),
  });
  const moderationService = createModerationService({
    contributionRepository: contributionRepo,
    decisionRepository: moderationDecisionRepo,
    evaluationRepository: qualityEvaluationRepo,
    idempotency,
    auditWriter,
    logger: logger.forModule("contributions"),
  });

  // ------------------------------------------------------------------
  // NET-W020 — Cross-promotion clearing (issue #39).
  //
  // Clearing is an ORCHESTRATION/INTEGRATION concern composed HERE
  // (the W014 executeCampaignClearing precedent); /settlement stays
  // the SOLE economic authority and owns the clearing RECORDS (pure
  // lineage — no postings of its own; no new account/transaction/
  // value-source kind exists). The neutral lookups below are thin
  // READ-ONLY adapters over the OWNING authorities (contributions +
  // W012/W013 derived states; the W019 inventory settlement
  // readiness; the campaigns clearing rules; the disputes risk/
  // dispute gate). /workflows is COMPLETELY untouched; /inventory,
  // /campaigns, /contributions and /disputes are never mutated. NO
  // AI path (the deterministic quality band is the only W013 signal
  // consumed and it can only BLOCK).
  // ------------------------------------------------------------------
  /** A service execution context for the neutral lookup reads. */
  function executionContextForLookups(correlationId: string) {
    return createExecutionContext({
      correlationId,
      actor: { id: "clearing-lookup", kind: "service" },
    });
  }
  const clearingContributionLookup = {
    async resolve(contributionId: string) {
      // The EXACT W014 recognition-bar views, read-only (lifecycle
      // state from the /workflows authority's field on the
      // contribution record; PoH state; derived moderation status;
      // the latest DETERMINISTIC quality band).
      const contribution = await contributionRepo.findById(contributionId);
      if (!contribution) return null;
      const poh = await proofOfHelpfulnessRepo.findByContributionId(
        contributionId,
      );
      const moderation = await moderationService.getModerationSummary(
        executionContextForLookups("w020-contribution-moderation"),
        contributionId,
      );
      let qualityBand: string | null = null;
      const evaluation = await qualityService.getLatestQualityEvaluation(
        executionContextForLookups("w020-contribution-quality"),
        contributionId,
      );
      if (evaluation) qualityBand = evaluation.band;
      return {
        organizationScopeId: contribution.organizationScopeId,
        lifecycleState: contribution.state,
        contributorPersonId: contribution.contributorId,
        proofOfHelpfulnessState: poh ? poh.state : "NONE",
        moderationStatus: moderation.status,
        qualityBand,
      };
    },
  };
  const clearingPlacementLookup = {
    async readiness(organizationScopeId: string, placementId: string) {
      // The W019 DERIVED settlement readiness (re-derived from CURRENT
      // durable records on every read) + the placement's campaign
      // binding and registered owner. A placement that does not
      // resolve in the requested scope resolves to null (fail-closed).
      try {
        const readiness =
          await inventoryService.getPlacementSettlementReadiness(
            executionContextForLookups("w020-placement-readiness"),
            organizationScopeId,
            placementId,
          );
        const placement = await inventoryPlacementRepo.findById(placementId);
        if (!placement) return null;
        return {
          placementId: readiness.placementId,
          organizationScopeId: readiness.organizationScopeId,
          campaignId: readiness.sourceContext.campaignId,
          campaignPolicyVersion: readiness.sourceContext.campaignPolicyVersion,
          ownerPersonId: readiness.sourceContext.ownerPersonId,
          settlementReady: readiness.eligible,
        };
      } catch {
        // A missing or cross-scope placement is NotFoundError — the
        // lookup resolves null (fail-closed; no existence oracle).
        return null;
      }
    },
  };
  const clearingCampaignLookup = {
    async resolve(campaignId: string) {
      // /campaigns stays the campaign policy authority: existence +
      // tenant scope + administrative status + the CURRENT policy
      // version's declared clearing rules (read-only).
      const campaign = await campaignRepo.findById(campaignId);
      if (!campaign) return null;
      const versions = await campaignPolicyRepo.listByCampaign(campaignId);
      const latest =
        versions.length > 0
          ? versions.reduce((a, b) => (b.version > a.version ? b : a))
          : null;
      if (!latest) return null;
      return {
        campaignId: campaign.id,
        organizationScopeId: campaign.organizationScopeId,
        administrativeStatus: campaign.status,
        currentPolicyVersion: latest.version,
        clearingRules: latest.clearingRules.map((rule) => ({
          id: rule.id,
          objectiveId: rule.objectiveId,
          basis: rule.basis,
          drawKind: rule.drawKind,
          rewardPolicyId: rule.rewardPolicyId,
          maxDrawAmount: rule.maxDrawAmount,
        })),
      };
    },
  };
  const clearingGateLookup = {
    async assess(input: {
      readonly organizationScopeId: string;
      readonly operationClass: string;
      readonly recordSubjectIds: readonly string[];
      readonly personSubjectId: string | null;
    }) {
      // The W014 gate discipline as a READ: active HOLD/BLOCK controls
      // matching the operation class + any record/person subject, then
      // ACTIVE disputes (OPEN/UNDER_REVIEW/APPEALED — PENDING_STAKE
      // never gates: griefing resistance). Read-only; /disputes stays
      // the authority.
      const execution = executionContextForLookups("w020-gate");
      const operationClass = input.operationClass as RiskOperationClass;
      for (const recordSubjectId of input.recordSubjectIds) {
        const control = await riskControlService.findGatingControl(
          execution,
          input.organizationScopeId,
          operationClass,
          recordSubjectId,
          input.personSubjectId,
        );
        if (control && (control.action === "HOLD" || control.action === "BLOCK")) {
          return {
            clear: false,
            source: "risk_control",
            controlId: control.id,
            disputeId: null,
            detail: {
              action: control.action,
              operationClass: input.operationClass,
              recordSubjectId,
              originAssessmentId: control.originAssessmentId,
              originCaseId: control.originCaseId,
            },
          };
        }
      }
      const active = await disputeService.listActiveBySubjectIds(
        execution,
        input.organizationScopeId,
        input.recordSubjectIds,
      );
      if (active.length > 0) {
        const dispute = active[0]!;
        return {
          clear: false,
          source: "active_dispute",
          controlId: null,
          disputeId: dispute.id,
          detail: {
            disputeState: dispute.state,
            disputeKind: dispute.kind,
            subjectType: dispute.subjectRef.subjectType,
            subjectId: dispute.subjectRef.subjectId,
          },
        };
      }
      return {
        clear: true,
        source: null,
        controlId: null,
        disputeId: null,
        detail: {},
      };
    },
  };
  const clearingRepo = createAuthorityCrossPromotionClearingRepository({
    authority: postgresAuthority,
    logger: { debug: (m, f) => logger.forModule("settlement").debug(m, f) },
  });
  // NET-W020 remediation (PR #40 review): the campaign clearing
  // bookkeeping participates IN the clearing's SINGLE authoritative
  // transaction through this neutral port — /campaigns stays the
  // bookkeeping authority (the service's `...WithinTx` body runs on
  // the caller's transaction), and the port exposes the campaign
  // record's own serialization key so the composite holds it ACROSS
  // the transaction.
  const clearingCampaignBookkeeping = {
    async recordClearingExecutionWithinTx(
      execution: import("../core/execution-context.ts").ExecutionContext,
      input: import("../settlement/port.ts").ClearingCampaignBookkeepingInput,
      ctx: import("../core/idempotency.ts").IdempotentApplyContext,
    ) {
      const updated = await campaignService.recordClearingExecutionWithinTx(
        execution,
        {
          campaignId: input.campaignId,
          clearingRuleId: input.clearingRuleId,
          drawKind: input.drawKind,
          valueRecordId: input.valueRecordId,
          resultId: input.resultId,
          amount: input.amount,
          description: input.description,
          idempotencyKey: input.idempotencyKey,
        },
        ctx,
      );
      return {
        campaignId: updated.id,
        eventCount: updated.events.length,
      };
    },
    bookkeepingLockKey(campaignId: string) {
      return campaignLockKey(campaignId);
    },
  };
  const crossPromotionClearingService = createCrossPromotionClearingService({
    clearingRepository: clearingRepo,
    valueRepository: economicValueRepo,
    allocationRepository: rewardAllocationRepo,
    issuanceRepository: creditIssuanceRepo,
    obligationRepository: cashObligationRepo,
    lookups: {
      contribution: clearingContributionLookup,
      placement: clearingPlacementLookup,
      campaign: clearingCampaignLookup,
      gate: clearingGateLookup,
    },
    rewardService,
    creditService,
    cashService,
    rewardPolicyRepository: rewardPolicyRepo,
    campaignBookkeeping: clearingCampaignBookkeeping,
    idempotency,
    auditWriter,
    logger: logger.forModule("settlement"),
  });

  // ------------------------------------------------------------------
  // NET-W021 — Campaign matching and optimization (selection, not
  // authority). The matching service lives in the /campaigns domain
  // (the campaign is the matching subject); EVERY cross-domain read
  // arrives through thin READ-ONLY adapters over the OWNING
  // authorities' wired repositories:
  //  - supply (candidates + the already-placed set) + the policy
  //    eligibility-rule EVALUATION come from /inventory (the pure
  //    W019 eligibility engine is THE rule-semantics authority —
  //    matching never re-implements eligibility semantics);
  //  - reputation scores come from /reputation (latest snapshots —
  //    digest-pinned evidence bases);
  //  - the safety gate read comes from /disputes (the active
  //    participant_eligibility control registry);
  //  - the performance evidence comes from /outcomes (ONLY
  //    lifecycle-VERIFIED measured outcomes — the additive
  //    verified-evidence read);
  //  - the AI advisory (AI-002 matching + AI-003 risk analysis) is
  //    the provider-neutral LlmPort (purposes "matching" and
  //    "safety"), bounded and identity-recorded.
  // The ONLY write is the append-only run record + its audit event.
  // ------------------------------------------------------------------
  const campaignMatchSupplyLookup: CampaignMatchSupplyLookup = {
    async listCandidateItems(organizationScopeId, filters) {
      const items = await inventoryItemRepo.listByOrganization(
        organizationScopeId,
        {
          retired: filters?.retired ?? false,
        },
      );
      return items.map((item) => ({
        id: item.id,
        organizationScopeId: item.organizationScopeId,
        ownerPersonId: item.ownerPersonId,
        surfaceKind: item.surfaceKind,
        format: item.format,
        territories: [...item.attributes.territories],
        languages: [...item.attributes.languages],
        verificationEvidenceReference: item.verificationEvidenceReference,
        retiredAt: item.retiredAt,
      }));
    },
    async getItem(organizationScopeId, itemId) {
      const item = await inventoryItemRepo.findById(itemId);
      if (
        !item ||
        item.organizationScopeId !== organizationScopeId
      ) {
        // Cross-scope or nonexistent: indistinguishable.
        return null;
      }
      return {
        id: item.id,
        organizationScopeId: item.organizationScopeId,
        ownerPersonId: item.ownerPersonId,
        surfaceKind: item.surfaceKind,
        format: item.format,
        territories: [...item.attributes.territories],
        languages: [...item.attributes.languages],
        verificationEvidenceReference: item.verificationEvidenceReference,
        retiredAt: item.retiredAt,
      };
    },
    async placedItemIds(organizationScopeId, campaignId) {
      const placements = await inventoryPlacementRepo.listByOrganization(
        organizationScopeId,
        { campaignId },
      );
      return placements.map((p) => p.inventoryItemId);
    },
    async evaluateEligibilityRules(rules, supply, evaluatedAt) {
      // THE /inventory authority's own rule semantics (the W019 pure
      // engine) — the composition root may import it; the campaigns
      // domain sees only the neutral interface. The evaluation
      // anchor is the run's EXPLICIT deterministic anchor (derived
      // once per run by the matching service and recorded on the
      // decision) — this adapter NEVER consults wall-clock time
      // (the PR #43 review fix: no implicit nondeterministic
      // dependency at the matching boundary).
      const evaluation = evaluatePlacementEligibility(
        rules.map((rule) => ({
          attribute: rule.attribute,
          operator: rule.operator,
          values: [...rule.values],
        })),
        {
          territories: [...supply.territories],
          languages: [...supply.languages],
        },
        evaluatedAt,
      );
      return {
        eligible: evaluation.eligible,
        evaluatedAt: evaluation.evaluatedAt,
        ruleResults: evaluation.ruleResults.map((r) => ({
          attribute: r.attribute,
          operator: r.operator,
          values: [...r.values],
          satisfied: r.satisfied,
          reason: r.reason,
        })),
      };
    },
  };
  const campaignMatchReputationLookup: CampaignMatchReputationLookup = {
    async latestScore(organizationScopeId, subjectPersonId, dimension) {
      // The canonical LATEST snapshot for the owner person (W007):
      // existence + org scope + the dimension score + the digest (the
      // pinned evidence base). Read-only — /reputation stays the
      // trust-signal authority.
      const snapshot = await reputationSnapshotRepo
        .listBySubject(organizationScopeId, subjectPersonId)
        .then((snapshots) =>
          snapshots.length > 0
            ? snapshots.reduce((a, b) =>
                b.computedAt > a.computedAt ? b : a,
              )
            : null,
        );
      if (!snapshot) return null;
      const score = snapshot.scores.find((s) => s.dimension === dimension);
      if (!score) return null;
      return {
        snapshotId: snapshot.id,
        organizationScopeId: snapshot.organizationScopeId,
        subjectPersonId: snapshot.subjectPersonId,
        dimension: score.dimension,
        digest: snapshot.digest,
        score: score.score,
      };
    },
  };
  const campaignMatchSafetyLookup: CampaignMatchSafetyLookup = {
    async activeHold(organizationScopeId, ownerPersonId) {
      // The active-control registry read (the W016 gate-read
      // precedent): ACTIVE participant_eligibility controls covering
      // the supply owner. Read-only — /disputes stays the authority.
      const controls = await riskControlRepo.findActiveControls(
        organizationScopeId,
        "participant_eligibility",
        ownerPersonId,
      );
      const control = controls.find(
        (c) => c.action === "HOLD" || c.action === "BLOCK",
      );
      return {
        held: control !== undefined,
        controlId: control?.id ?? null,
        action: control?.action ?? null,
      };
    },
  };
  const campaignMatchOutcomeLookup: CampaignMatchOutcomeLookup = {
    async listVerifiedOutcomesBySubject(
      execution,
      organizationScopeId,
      subjectId,
    ) {
      // The canonical verified-performance read (the /outcomes
      // authority owns the lifecycle semantics: only VERIFIED
      // measurements are evidence). The measured value + confidence
      // + rollup strategy come from the measurement's rollup.
      const verified = await measuredOutcomeService
        .listVerifiedMeasuredOutcomesBySubject(
          execution,
          organizationScopeId,
          subjectId,
        );
      return verified.map((m) => ({
        measuredOutcomeId: m.id,
        outcomeType: m.outcomeType,
        state: "VERIFIED" as const,
        value: m.rollup?.measuredValue.value ?? 0,
        unit: m.rollup?.measuredValue.unit ?? "units",
        confidencePoint: m.rollup?.confidence?.point ?? 0,
        rollupStrategy: m.rollupStrategy,
        verifiedAt: m.rollup?.computedAt ?? null,
      }));
    },
  };
  // The advisory adapter over the provider-neutral LlmPort: [0,1] →
  // 0–100 with provider identity preserved (the W016 precedent,
  // twice: AI-002 purpose "matching" + AI-003 purpose "safety").
  const campaignMatchAdvisory = {
    async assessMatching(input: {
      readonly rubricRef: string;
      readonly neutralFacts: readonly {
        readonly label: string;
        readonly value: string;
      }[];
    }) {
      const scored = await llmProvider.score({
        purpose: "matching",
        rubricRef: input.rubricRef,
        neutralFacts: input.neutralFacts,
      });
      return {
        score: Math.round(scored.score * 1000) / 10,
        provider: scored.provider,
        modelRef: scored.modelRef,
      };
    },
    async assessRisk(input: {
      readonly rubricRef: string;
      readonly neutralFacts: readonly {
        readonly label: string;
        readonly value: string;
      }[];
    }) {
      const scored = await llmProvider.score({
        purpose: "safety",
        rubricRef: input.rubricRef,
        neutralFacts: input.neutralFacts,
      });
      return {
        score: Math.round(scored.score * 1000) / 10,
        provider: scored.provider,
        modelRef: scored.modelRef,
      };
    },
  };
  const campaignMatchRunRepo = createAuthorityCampaignMatchRunRepository({
    authority: postgresAuthority,
    logger: { debug: (m, f) => logger.forModule("campaigns").debug(m, f) },
  });
  const campaignMatchingService = createCampaignMatchingService({
    campaignRepository: campaignRepo,
    campaignPolicyRepository: campaignPolicyRepo,
    runRepository: campaignMatchRunRepo,
    lookups: {
      supply: campaignMatchSupplyLookup,
      reputation: campaignMatchReputationLookup,
      safety: campaignMatchSafetyLookup,
      outcomes: campaignMatchOutcomeLookup,
    },
    advisory: campaignMatchAdvisory,
    idempotency,
    auditWriter,
    logger: logger.forModule("campaigns"),
  });

  // ------------------------------------------------------------------
  // NET-W009 §3.7 ECONOMIC GATE (the lock-invariant-21 enforcement
  // point). The composition root — NOT the risk domain, NOT the
  // settlement domain — consults the active-control registry before
  // the guarded settlement commands and refuses the call when an
  // ACTIVE HOLD/BLOCK control matches (operation class + subject:
  // record id OR beneficiary person). The settlement code is
  // untouched; the fraud boundary never mutates economic state (it
  // can only refuse to allow the wrapped operation to proceed).
  // ------------------------------------------------------------------
  async function refuseWhenGated(
    execution: import("../core/execution-context.ts").ExecutionContext,
    organizationScopeId: string,
    operationClass: RiskOperationClass,
    recordSubjectId: string | null,
    personSubjectId: string | null,
  ): Promise<void> {
    const control = await riskControlService.findGatingControl(
      execution,
      organizationScopeId,
      operationClass,
      recordSubjectId,
      personSubjectId,
    );
    if (control && (control.action === "HOLD" || control.action === "BLOCK")) {
      const { OpenConError: GateError } = await import("../core/errors.ts");
      throw new GateError({
        code: "RISK_CONTROL",
        classification: "precondition",
        message: `operation ${operationClass} is refused: active risk control ${control.id} (${control.action}) covers this subject`,
        context: {
          controlDecisionId: control.id,
          action: control.action,
          operationClass,
          originAssessmentId: control.originAssessmentId,
          originCaseId: control.originCaseId,
          reasonCodes: control.reasonCodes,
          organizationScopeId,
          recordSubjectId,
          personSubjectId,
        },
      });
    }
  }

  // ------------------------------------------------------------------
  // NET-W010 DISPUTE GATE (lock invariant 21, the disputed half): a
  // disputed claim cannot mature (or be consumed) until the dispute
  // resolves. The composition root consults the dispute registry for
  // ACTIVE disputes (OPEN/UNDER_REVIEW/APPEALED — a PENDING_STAKE
  // request never freezes value: griefing resistance) whose subject
  // covers the guarded record id OR any of its upstream source ids,
  // and refuses the call. As with the risk gate: neither the disputes
  // domain nor the settlement domain performs this check — the
  // composition root owns the wiring, /settlement's code is untouched.
  // ------------------------------------------------------------------
  async function refuseWhenDisputed(
    execution: import("../core/execution-context.ts").ExecutionContext,
    organizationScopeId: string,
    subjectIds: readonly string[],
  ): Promise<void> {
    if (subjectIds.length === 0) return;
    const active = await disputeService.listActiveBySubjectIds(
      execution,
      organizationScopeId,
      subjectIds,
    );
    if (active.length > 0) {
      const { OpenConError: GateError } = await import("../core/errors.ts");
      const dispute = active[0]!;
      throw new GateError({
        code: "DISPUTE_CHALLENGE",
        classification: "precondition",
        message: `operation is refused: active dispute ${dispute.id} (${dispute.state}, subject ${dispute.subjectRef.subjectType}:${dispute.subjectRef.subjectId}) covers this record`,
        context: {
          disputeId: dispute.id,
          disputeState: dispute.state,
          disputeKind: dispute.kind,
          subjectType: dispute.subjectRef.subjectType,
          subjectId: dispute.subjectRef.subjectId,
          challengerPersonId: dispute.challengerPersonId,
          activeDisputeIds: active.map((d) => d.id),
          organizationScopeId,
        },
      });
    }
  }

  // API auth + commands adapter (dependency inversion: the API server
  // consumes ApiAuth/ApiCommands; we bridge to the real domain services).
  const apiAuth: ApiAuth = {
    async resolvePrincipal(subject) {
      const identity = await principalResolver.resolve({
        subject: { subjectId: subject.subjectId, providerKind: subject.providerKind },
        clientClaims: subject.clientClaims,
      });
      return { personId: identity ? identity.id : null };
    },
    async authorize(request) {
      const resolved = await authorizationService.resolvePrincipal(
        request.execution,
        request.personId,
      );
      const decision = await authorizationService.authorize({
        principal: resolved,
        action: request.action,
        resource: request.resource,
        clientClaims: request.clientClaims,
      });
      return {
        decision: decision.decision,
        reason: decision.reason,
        matchedPolicyId: decision.matchedPolicyId,
      };
    },
  };
  // NET-W006 view helpers (domain entity → API view).
  function toObservationView(observation: import("../outcomes/port.ts").OutcomeObservation) {
    return {
      id: observation.id,
      organizationScopeId: observation.organizationScopeId,
      observerId: observation.observerId,
      subjectReference: observation.subjectReference,
      outcomeType: observation.outcomeType,
      outcomeClaimId: observation.outcomeClaimId,
      evidenceId: observation.evidenceId,
      observedValue: observation.observedValue,
      confidence: observation.confidence as unknown as Record<string, unknown>,
      provenance: observation.provenance as unknown as Record<string, unknown>,
      correctsObservationId: observation.correctsObservationId,
      providerAttributionMode: observation.providerAttributionMode,
      externalSubjectRef: observation.externalSubjectRef,
      createdAt: observation.createdAt,
    };
  }
  function toExperimentView(experiment: import("../outcomes/port.ts").MeasurementExperiment) {
    return {
      id: experiment.id,
      organizationScopeId: experiment.organizationScopeId,
      ownerId: experiment.ownerId,
      experimentType: experiment.experimentType,
      hypothesis: experiment.hypothesis,
      status: experiment.status,
      startedAt: experiment.startedAt,
      completedAt: experiment.completedAt,
      invalidatedAt: experiment.invalidatedAt,
      invalidationReason: experiment.invalidationReason,
      createdAt: experiment.createdAt,
      updatedAt: experiment.updatedAt,
      version: experiment.version,
    };
  }
  function toMeasurementView(measurement: import("../outcomes/port.ts").MeasuredOutcome) {
    return {
      id: measurement.id,
      organizationScopeId: measurement.organizationScopeId,
      ownerId: measurement.ownerId,
      subjectReference: measurement.subjectReference,
      outcomeType: measurement.outcomeType,
      outcomeClaimId: measurement.outcomeClaimId,
      observationIds: measurement.observationIds,
      attributionIds: measurement.attributionIds,
      baselineIds: measurement.baselineIds,
      incrementalityIds: measurement.incrementalityIds,
      maturation: measurement.maturation as unknown as Record<string, unknown>,
      rollupStrategy: measurement.rollupStrategy,
      state: measurement.state,
      version: measurement.version,
      createdAt: measurement.createdAt,
      updatedAt: measurement.updatedAt,
    };
  }

  // NET-W007 view helpers (domain entity → API view).
  function toReputationPolicyView(
    policy: import("../reputation/port.ts").ReputationScoringPolicy,
  ) {
    return {
      id: policy.id,
      policyId: policy.policyId,
      version: policy.version,
      organizationScopeId: policy.organizationScopeId,
      description: policy.description,
      rules: policy.rules as unknown as readonly Record<string, unknown>[],
      createdBy: policy.createdBy,
      createdAt: policy.createdAt,
    };
  }
  function toReputationInputView(
    input: import("../reputation/port.ts").ReputationInput,
  ) {
    return {
      id: input.id,
      organizationScopeId: input.organizationScopeId,
      subjectPersonId: input.subjectPersonId,
      dimension: input.dimension,
      basis: input.basis,
      sources: input.sources as unknown as readonly Record<string, unknown>[],
      description: input.description,
      occurredAt: input.occurredAt,
      recordedAt: input.recordedAt,
      idempotencyKey: input.idempotencyKey,
    };
  }
  function toReputationScoreView(
    score: import("../reputation/port.ts").ReputationDimensionScore,
  ) {
    return {
      dimension: score.dimension,
      score: score.score,
      inputCount: score.inputCount,
      verifiedInputCount: score.verifiedInputCount,
      indicatedInputCount: score.indicatedInputCount,
      decayedVerifiedWeight: score.decayedVerifiedWeight,
      decayedIndicatedWeight: score.decayedIndicatedWeight,
      capped: score.capped,
    };
  }
  function toReputationScoresView(
    result: import("../reputation/port.ts").ComputeReputationScoresResult,
  ) {
    return {
      organizationScopeId: result.organizationScopeId,
      subjectPersonId: result.subjectPersonId,
      policyId: result.policyId,
      policyVersion: result.policyVersion,
      referenceAt: result.referenceAt,
      scores: result.scores.map(toReputationScoreView),
      inputIds: result.inputIds,
      digest: result.digest,
    };
  }
  function toReputationSnapshotView(
    snapshot: import("../reputation/port.ts").ReputationSnapshot,
  ) {
    return {
      id: snapshot.id,
      organizationScopeId: snapshot.organizationScopeId,
      subjectPersonId: snapshot.subjectPersonId,
      policyId: snapshot.policyId,
      policyVersion: snapshot.policyVersion,
      referenceAt: snapshot.referenceAt,
      computedAt: snapshot.computedAt,
      scores: snapshot.scores.map(toReputationScoreView),
      inputIds: snapshot.inputIds,
      digest: snapshot.digest,
      idempotencyKey: snapshot.idempotencyKey,
    };
  }

  // NET-W008 view helpers (domain entity → API view).
  function toEconomicValueView(
    value: import("../settlement/port.ts").EconomicValueRecord,
  ) {
    return {
      id: value.id,
      organizationScopeId: value.organizationScopeId,
      beneficiaryPersonId: value.beneficiaryPersonId,
      state: value.state,
      version: value.version,
      amount: value.amount,
      unit: "value",
      sources: value.sources as unknown as readonly Record<string, unknown>[],
      maturation: value.maturation as unknown as Record<string, unknown>,
      description: value.description,
      recordedAt: value.recordedAt,
      maturedAt: value.maturedAt,
      consumedBy: value.consumedBy as unknown as Record<string, unknown> | null,
      reversal: value.reversal as unknown as Record<string, unknown> | null,
      recognitionTransactionId: value.recognitionTransactionId,
      maturationTransactionId: value.maturationTransactionId,
      idempotencyKey: value.idempotencyKey,
    };
  }
  function toCreditIssuanceView(
    issuance: import("../settlement/port.ts").CreditIssuance,
  ) {
    return {
      id: issuance.id,
      organizationScopeId: issuance.organizationScopeId,
      beneficiaryPersonId: issuance.beneficiaryPersonId,
      creditAmount: issuance.creditAmount,
      sourceValueRecordId: issuance.sourceValueRecordId,
      sourceValueAmount: issuance.sourceValueAmount,
      proofOfValueId: issuance.proofOfValueId,
      creditsPerValueUnit: issuance.creditsPerValueUnit,
      status: issuance.status,
      reversal: issuance.reversal as unknown as Record<string, unknown> | null,
      transactionId: issuance.transactionId,
      issuedAt: issuance.issuedAt,
      description: issuance.description,
      idempotencyKey: issuance.idempotencyKey,
    };
  }
  function toRewardPolicyView(
    policy: import("../settlement/port.ts").RewardAllocationPolicy,
  ) {
    return {
      id: policy.id,
      policyId: policy.policyId,
      version: policy.version,
      organizationScopeId: policy.organizationScopeId,
      description: policy.description,
      allocations: policy.allocations as unknown as readonly Record<string, unknown>[],
      createdBy: policy.createdBy,
      createdAt: policy.createdAt,
    };
  }
  function toRewardAllocationView(
    allocation: import("../settlement/port.ts").RewardAllocation,
  ) {
    return {
      id: allocation.id,
      organizationScopeId: allocation.organizationScopeId,
      sourceValueRecordId: allocation.sourceValueRecordId,
      sourceValueAmount: allocation.sourceValueAmount,
      sourceBeneficiaryPersonId: allocation.sourceBeneficiaryPersonId,
      policyId: allocation.policyId,
      policyVersion: allocation.policyVersion,
      totalAllocated: allocation.totalAllocated,
      shares: allocation.shares as unknown as readonly Record<string, unknown>[],
      status: allocation.status,
      reversal: allocation.reversal as unknown as Record<string, unknown> | null,
      transactionId: allocation.transactionId,
      allocatedAt: allocation.allocatedAt,
      idempotencyKey: allocation.idempotencyKey,
    };
  }
  function toCashObligationView(
    obligation: import("../settlement/port.ts").CashObligation,
  ) {
    return {
      id: obligation.id,
      organizationScopeId: obligation.organizationScopeId,
      kind: obligation.kind,
      counterpartyPersonId: obligation.counterpartyPersonId,
      amount: obligation.amount,
      unit: "cash",
      status: obligation.status,
      settledAt: obligation.settledAt,
      settlementReference: obligation.settlementReference,
      reversal: obligation.reversal as unknown as Record<string, unknown> | null,
      transactionId: obligation.transactionId,
      description: obligation.description,
      recordedAt: obligation.recordedAt,
      idempotencyKey: obligation.idempotencyKey,
    };
  }
  function toConversionView(
    conversion: import("../settlement/port.ts").EconomicConversion,
  ) {
    return {
      id: conversion.id,
      organizationScopeId: conversion.organizationScopeId,
      personId: conversion.personId,
      direction: conversion.direction,
      cashAmount: conversion.cashAmount,
      creditsAmount: conversion.creditsAmount,
      rate: conversion.rate,
      status: conversion.status,
      reversal: conversion.reversal as unknown as Record<string, unknown> | null,
      transactionId: conversion.transactionId,
      convertedAt: conversion.convertedAt,
      description: conversion.description,
      idempotencyKey: conversion.idempotencyKey,
    };
  }
  function toCrossPromotionClearingView(
    clearing: import("../settlement/port.ts").CrossPromotionClearingRecord,
  ) {
    return {
      id: clearing.id,
      organizationScopeId: clearing.organizationScopeId,
      campaignId: clearing.campaignId,
      campaignPolicyVersion: clearing.campaignPolicyVersion,
      clearingRuleId: clearing.clearingRuleId,
      sourceContributionId: clearing.sourceContributionId,
      targetPlacementId: clearing.targetPlacementId,
      valueRecordId: clearing.valueRecordId,
      drawKind: clearing.drawKind,
      drawResultId: clearing.drawResultId,
      drawTransactionId: clearing.drawTransactionId,
      amount: clearing.amount,
      eligibility: clearing.eligibility as unknown as Record<string, unknown>,
      status: clearing.status,
      clearedAt: clearing.clearedAt,
      idempotencyKey: clearing.idempotencyKey,
    };
  }
  function toLedgerTransactionView(
    transaction: import("../settlement/port.ts").EconomicLedgerTransaction,
  ) {
    return {
      id: transaction.id,
      organizationScopeId: transaction.organizationScopeId,
      kind: transaction.kind,
      description: transaction.description,
      subject: transaction.subject as unknown as Record<string, unknown> | null,
      entries: transaction.entries as unknown as readonly Record<string, unknown>[],
      recordedAt: transaction.recordedAt,
      idempotencyKey: transaction.idempotencyKey,
    };
  }
  // NET-W009 view helpers (domain entity → API view).
  function toRiskSignalView(signal: import("../disputes/port.ts").RiskSignal) {
    return {
      id: signal.id,
      organizationScopeId: signal.organizationScopeId,
      subjectPersonId: signal.subjectPersonId,
      subjectRef: signal.subjectRef,
      category: signal.category,
      severity: signal.severity,
      confidence: signal.confidence,
      provenance: signal.provenance,
      advisory: signal.advisory,
      description: signal.description,
      detectedAt: signal.detectedAt,
      recordedAt: signal.recordedAt,
      supersedesSignalId: signal.supersedesSignalId,
      supersededBySignalId: signal.supersededBySignalId,
    };
  }
  function toRiskPolicyView(policy: import("../disputes/port.ts").RiskPolicy) {
    return {
      id: policy.id,
      policyId: policy.policyId,
      version: policy.version,
      organizationScopeId: policy.organizationScopeId,
      description: policy.description,
      rules: policy.rules as unknown as readonly Record<string, unknown>[],
      thresholds: policy.thresholds as unknown as Record<string, unknown>,
      criticalFloorState: policy.criticalFloorState,
      advisoryOnlyCapState: policy.advisoryOnlyCapState,
      requiredCategories: policy.requiredCategories,
      missingDataState: policy.missingDataState,
      createdAt: policy.createdAt,
    };
  }
  function toRiskAssessmentView(
    assessment: import("../disputes/port.ts").RiskAssessment,
  ) {
    return {
      id: assessment.id,
      organizationScopeId: assessment.organizationScopeId,
      subjectPersonId: assessment.subjectPersonId,
      subjectRef: assessment.subjectRef,
      policyId: assessment.policyId,
      policyVersion: assessment.policyVersion,
      evaluatedAt: assessment.evaluatedAt,
      recordedAt: assessment.recordedAt,
      signalIds: assessment.signalIds,
      contributions: assessment.contributions as unknown as readonly Record<
        string,
        unknown
      >[],
      score: assessment.score,
      state: assessment.state,
      missingCategories: assessment.missingCategories,
      digest: assessment.digest,
      supersedesAssessmentId: assessment.supersedesAssessmentId,
      supersededByAssessmentId: assessment.supersededByAssessmentId,
    };
  }
  function toRiskCaseView(riskCase: import("../disputes/port.ts").RiskCase) {
    return {
      id: riskCase.id,
      organizationScopeId: riskCase.organizationScopeId,
      subjectPersonId: riskCase.subjectPersonId,
      subjectRef: riskCase.subjectRef,
      title: riskCase.title,
      description: riskCase.description,
      state: riskCase.state,
      reasonCodes: riskCase.reasonCodes,
      decisions: riskCase.decisions as unknown as readonly Record<string, unknown>[],
      openedBy: riskCase.openedBy,
      openedAt: riskCase.openedAt,
      resolvedAt: riskCase.resolvedAt,
      resolution: riskCase.resolution,
    };
  }
  function toRiskControlView(
    control: import("../disputes/port.ts").RiskControlDecision,
  ) {
    return {
      id: control.id,
      organizationScopeId: control.organizationScopeId,
      operationClass: control.operationClass,
      action: control.action,
      subjectPersonId: control.subjectPersonId,
      subjectRef: control.subjectRef,
      originAssessmentId: control.originAssessmentId,
      originCaseId: control.originCaseId,
      reasonCodes: control.reasonCodes,
      description: control.description,
      state: control.state,
      activatedBy: control.activatedBy,
      activatedAt: control.activatedAt,
      resolvedBy: control.resolvedBy,
      resolvedAt: control.resolvedAt,
      resolvedViaCaseDecisionId: control.resolvedViaCaseDecisionId,
    };
  }
  // NET-W010 view helpers (domain entity → API view).
  function toDisputeView(
    dispute: import("../disputes/port.ts").DisputeRecord,
  ) {
    return {
      id: dispute.id,
      organizationScopeId: dispute.organizationScopeId,
      kind: dispute.kind,
      appealOfDisputeId: dispute.appealOfDisputeId,
      challengerPersonId: dispute.challengerPersonId,
      subjectRef: dispute.subjectRef,
      subjectAnchorAt: dispute.subjectAnchorAt,
      subjectBeneficiaryPersonId: dispute.subjectBeneficiaryPersonId,
      statement: dispute.statement,
      reasonCodes: dispute.reasonCodes,
      supportingRefs: dispute.supportingRefs as unknown as readonly {
        kind: string;
        id: string;
      }[],
      state: dispute.state,
      stake: dispute.stake as unknown as {
        requirement: { amount: number; unit: string };
        stakeId: string | null;
        bondedAt: string | null;
        disposition: string | null;
        dispositionAt: string | null;
      },
      window: dispute.window,
      reviewerPersonId: dispute.reviewerPersonId,
      reviewStartedAt: dispute.reviewStartedAt,
      resolution: dispute.resolution as unknown as Record<string, unknown> | null,
      appealDisputeId: dispute.appealDisputeId,
      events: dispute.events as unknown as readonly Record<string, unknown>[],
      policyVersion: dispute.policyVersion,
    };
  }
  function toStakeView(stake: import("../settlement/port.ts").EconomicStake) {
    return {
      id: stake.id,
      organizationScopeId: stake.organizationScopeId,
      ownerPersonId: stake.ownerPersonId,
      amount: stake.amount,
      unit: stake.unit,
      state: stake.state,
      purpose: stake.purpose as unknown as { kind: string; id: string },
      committedAt: stake.committedAt,
      outcome: stake.outcome as unknown as Record<string, unknown> | null,
      transactionId: stake.transactionId,
      description: stake.description,
    };
  }
  // NET-W011 view helpers (domain entity → API view).
  function toCampaignView(
    campaign: import("../campaigns/port.ts").CampaignRecord,
  ) {
    return {
      id: campaign.id,
      organizationScopeId: campaign.organizationScopeId,
      ownerPersonId: campaign.ownerPersonId,
      name: campaign.name,
      description: campaign.description,
      status: campaign.status,
      currentPolicyVersion: campaign.currentPolicyVersion,
      budget: campaign.budget as unknown as {
        stakeId: string | null;
        committedAmount: number | null;
        committedAt: string | null;
        releasedAt: string | null;
      },
      events: campaign.events as unknown as readonly Record<string, unknown>[],
      createdAt: campaign.createdAt,
      updatedAt: campaign.updatedAt,
    };
  }
  function toCampaignPolicyView(
    policy: import("../campaigns/port.ts").CampaignPolicy,
  ) {
    return {
      id: policy.id,
      campaignId: policy.campaignId,
      organizationScopeId: policy.organizationScopeId,
      version: policy.version,
      formatVersion: policy.formatVersion,
      objectives: policy.objectives as unknown as readonly Record<
        string,
        unknown
      >[],
      eligibility: policy.eligibility as unknown as Record<string, unknown>,
      outcomePolicy: policy.outcomePolicy as unknown as Record<string, unknown>,
      evidencePolicy: policy.evidencePolicy as unknown as Record<
        string,
        unknown
      >,
      budget: policy.budget as unknown as Record<string, unknown>,
      attributionRules: policy.attributionRules as unknown as readonly Record<
        string,
        unknown
      >[],
      clearingRules: policy.clearingRules as unknown as readonly Record<
        string,
        unknown
      >[],
      opportunitySpecs: policy.opportunitySpecs as unknown as readonly Record<
        string,
        unknown
      >[],
      createdBy: policy.createdBy,
      createdAt: policy.createdAt,
    };
  }
  function toCreatorProfileView(profile: CreatorProfileRecord) {
    return {
      id: profile.id,
      organizationScopeId: profile.organizationScopeId,
      creatorPersonId: profile.creatorPersonId,
      displayName: profile.displayName,
      status: profile.status,
      currentVersion: profile.currentVersion,
      events: profile.events as unknown as readonly Record<string, unknown>[],
      createdAt: profile.createdAt,
      updatedAt: profile.updatedAt,
    };
  }
  function toCreatorProfileVersionView(version: CreatorProfileVersion) {
    return {
      id: version.id,
      profileId: version.profileId,
      organizationScopeId: version.organizationScopeId,
      version: version.version,
      sections: version.sections as unknown as Record<string, unknown>,
      createdBy: version.createdBy,
      createdAt: version.createdAt,
    };
  }
  function toCreatorMatchRunView(run: CreatorMatchRunRecord) {
    return {
      id: run.id,
      organizationScopeId: run.organizationScopeId,
      formatVersion: run.formatVersion,
      campaign: run.campaign,
      requirements: run.requirements as unknown as Record<string, unknown>,
      weights: run.weights,
      advisory: run.advisory,
      candidateCount: run.candidateCount,
      eligibleCount: run.eligibleCount,
      results: run.results as unknown as readonly Record<string, unknown>[],
      excluded: run.excluded as unknown as readonly Record<string, unknown>[],
      digest: run.digest,
      createdBy: run.createdBy,
      createdAt: run.createdAt,
    };
  }
  // -- NET-W021 view builder (provenance-preserving) ------------------
  function toCampaignMatchRunView(run: CampaignMatchRunRecord) {
    return {
      id: run.id,
      organizationScopeId: run.organizationScopeId,
      formatVersion: run.formatVersion,
      campaign: run.campaign,
      targeting: run.targeting as unknown as Record<string, unknown>,
      requiredOutcomeTypes: [...run.requiredOutcomeTypes],
      weights: run.weights,
      advisory: run.advisory,
      candidateCount: run.candidateCount,
      eligibleCount: run.eligibleCount,
      results: run.results as unknown as readonly Record<string, unknown>[],
      excluded: run.excluded as unknown as readonly Record<string, unknown>[],
      digest: run.digest,
      createdBy: run.createdBy,
      createdAt: run.createdAt,
      evaluatedAt: run.evaluatedAt,
    };
  }
  // -- NET-W017 view builders (provenance-preserving) ------------------
  function toEngagementView(engagement: Engagement) {
    return {
      id: engagement.id,
      kind: engagement.kind,
      state: engagement.state,
      version: engagement.version,
      organizationScopeId: engagement.organizationScopeId,
      creatorPersonId: engagement.creatorPersonId,
      creatorProfileId: engagement.creatorProfileId,
      creatorProfileVersion: engagement.creatorProfileVersion,
      campaignId: engagement.campaignId,
      campaignPolicyVersion: engagement.campaignPolicyVersion,
      matchRunId: engagement.matchRunId,
      opportunityId: engagement.opportunityId,
      requestedRights:
        engagement.requestedRights as unknown as Record<string, unknown>,
      compensation:
        engagement.compensation as unknown as Record<string, unknown> | null,
      brief: engagement.brief,
      formatVersion: engagement.formatVersion,
      executionId: engagement.executionId,
      correlationId: engagement.correlationId,
      causationId: engagement.causationId,
      createdAt: engagement.createdAt,
      updatedAt: engagement.updatedAt,
    };
  }
  function toUsageRightsView(view: UsageRightsView) {
    return {
      grant: {
        id: view.grant.id,
        organizationScopeId: view.grant.organizationScopeId,
        engagementId: view.grant.engagementId,
        grantorPersonId: view.grant.grantorPersonId,
        uses: view.grant.uses,
        channels: view.grant.channels,
        territories: view.grant.territories,
        formats: view.grant.formats,
        exclusions: view.grant.exclusions,
        startsAt: view.grant.startsAt,
        endsAt: view.grant.endsAt,
        contentOwnership: view.grant.contentOwnership,
        formatVersion: view.grant.formatVersion,
        createdBy: view.grant.createdBy,
        createdAt: view.grant.createdAt,
        executionId: view.grant.executionId,
        correlationId: view.grant.correlationId,
        causationId: view.grant.causationId,
      },
      revocation: view.revocation
        ? {
            id: view.revocation.id,
            grantId: view.revocation.grantId,
            revokedBy: view.revocation.revokedBy,
            reason: view.revocation.reason,
            revokedAt: view.revocation.revokedAt,
            effectiveAt: view.revocation.effectiveAt,
          }
        : null,
      effectiveStatus: view.effectiveStatus,
      viewedAsOf: view.viewedAsOf,
    };
  }
  function toUgcProductionView(production: UgcProduction) {
    return {
      id: production.id,
      organizationScopeId: production.organizationScopeId,
      engagementId: production.engagementId,
      creatorPersonId: production.creatorPersonId,
      creatorProfileId: production.creatorProfileId,
      campaignId: production.campaignId,
      campaignPolicyVersion: production.campaignPolicyVersion,
      matchRunId: production.matchRunId,
      opportunityId: production.opportunityId,
      contributionId: production.contributionId,
      formatVersion: production.formatVersion,
      createdBy: production.createdBy,
      openedAt: production.openedAt,
      executionId: production.executionId,
      correlationId: production.correlationId,
      causationId: production.causationId,
    };
  }
  function toUgcDeliverableView(deliverable: UgcDeliverableVersion) {
    return {
      id: deliverable.id,
      organizationScopeId: deliverable.organizationScopeId,
      productionId: deliverable.productionId,
      deliverableKey: deliverable.deliverableKey,
      version: deliverable.version,
      format: deliverable.format,
      title: deliverable.title,
      contentReference: deliverable.contentReference,
      externalPlatform: deliverable.externalPlatform,
      notes: deliverable.notes,
      createdBy: deliverable.createdBy,
      createdAt: deliverable.createdAt,
      executionId: deliverable.executionId,
      correlationId: deliverable.correlationId,
      causationId: deliverable.causationId,
    };
  }
  function toUgcSubmissionView(submission: UgcSubmission) {
    return {
      id: submission.id,
      organizationScopeId: submission.organizationScopeId,
      productionId: submission.productionId,
      engagementId: submission.engagementId,
      deliverableCount: submission.deliverableCount,
      evidenceReferences: submission.evidenceReferences,
      createdBy: submission.createdBy,
      submittedAt: submission.submittedAt,
      executionId: submission.executionId,
      correlationId: submission.correlationId,
      causationId: submission.causationId,
    };
  }
  function toEngagementBatchView(
    batch: EngagementBatchRecord,
    journalOutcomes?: readonly EngagementBatchOutcomeRecord[],
  ) {
    return {
      id: batch.id,
      organizationScopeId: batch.organizationScopeId,
      matchRunId: batch.matchRunId,
      campaignId: batch.campaignId,
      campaignPolicyVersion: batch.campaignPolicyVersion,
      candidateCount: batch.candidateCount,
      status: batch.status,
      // COMPLETED carries the finalized snapshot; RUNNING/ABORTED
      // expose the LIVE journal (accurate partial execution — the
      // NET-W017 remediation requirement).
      outcomes:
        batch.status === "COMPLETED"
          ? batch.outcomes
          : (journalOutcomes ?? []).map((row) => row.outcome),
      createdBy: batch.createdBy,
      createdAt: batch.createdAt,
      completedAt: batch.completedAt,
      abortedAt: batch.abortedAt,
      abortedReason: batch.abortedReason,
      executionId: batch.executionId,
      correlationId: batch.correlationId,
      causationId: batch.causationId,
    };
  }
  function toAcceptancePolicyView(
    policy: CreatorAcceptancePolicyRecord,
  ) {
    return {
      id: policy.id,
      organizationScopeId: policy.organizationScopeId,
      creatorPersonId: policy.creatorPersonId,
      version: policy.version,
      mode: policy.mode,
      maxActiveEngagements: policy.maxActiveEngagements,
      rateFloor: policy.rateFloor,
      autoGrantableRights: policy.autoGrantableRights,
      maxGrantDurationDays: policy.maxGrantDurationDays,
      createdBy: policy.createdBy,
      createdAt: policy.createdAt,
    };
  }
  // -- NET-W018 view builders (provenance-preserving) ------------------
  function toCommercialRelationshipView(relationship: CommercialRelationship) {
    return {
      id: relationship.id,
      organizationScopeId: relationship.organizationScopeId,
      campaignId: relationship.campaignId,
      engagementId: relationship.engagementId,
      creatorPersonId: relationship.creatorPersonId,
      sponsorPersonId: relationship.sponsorPersonId,
      kind: relationship.kind,
      disclosureObligations: relationship.disclosureObligations,
      // REFERENCE DATA ONLY — no balances, no postings (AC-05).
      compensation: relationship.compensation,
      terminatedAt: relationship.terminatedAt,
      terminationReason: relationship.terminationReason,
      formatVersion: relationship.formatVersion,
      createdBy: relationship.createdBy,
      createdAt: relationship.createdAt,
      executionId: relationship.executionId,
      correlationId: relationship.correlationId,
      causationId: relationship.causationId,
    };
  }
  function toDisclosureDeclarationView(declaration: DisclosureDeclaration) {
    return {
      id: declaration.id,
      organizationScopeId: declaration.organizationScopeId,
      publicationId: declaration.publicationId,
      kind: declaration.kind,
      declaredByPersonId: declaration.declaredByPersonId,
      statement: declaration.statement,
      evidenceReferences: declaration.evidenceReferences,
      formatVersion: declaration.formatVersion,
      createdAt: declaration.createdAt,
      executionId: declaration.executionId,
      correlationId: declaration.correlationId,
      causationId: declaration.causationId,
    };
  }
  function toPublicationView(publication: PublicationRecord) {
    return {
      id: publication.id,
      kind: publication.kind,
      organizationScopeId: publication.organizationScopeId,
      state: publication.state,
      version: publication.version,
      engagementId: publication.engagementId,
      productionId: publication.productionId,
      creatorPersonId: publication.creatorPersonId,
      campaignId: publication.campaignId,
      channel: publication.channel,
      publicationEvidenceReferences: publication.publicationEvidenceReferences,
      verifiedAt: publication.verifiedAt,
      formatVersion: publication.formatVersion,
      ownerId: publication.ownerId,
      createdAt: publication.createdAt,
      updatedAt: publication.updatedAt,
      executionId: publication.executionId,
      correlationId: publication.correlationId,
      causationId: publication.causationId,
    };
  }
  function toPublicationDisclosureStatusView(status: PublicationDisclosureStatus) {
    return {
      publicationId: status.publicationId,
      organizationScopeId: status.organizationScopeId,
      state: status.state,
      obligations: status.obligations.map((o) => ({
        kind: o.kind,
        sources: o.sources,
        satisfied: o.satisfied,
        declarationIds: o.declarationIds,
      })),
      satisfied: status.satisfied,
      evaluatedAt: status.evaluatedAt,
    };
  }
  function toInventoryItemView(item: InventoryItem) {
    return {
      id: item.id,
      organizationScopeId: item.organizationScopeId,
      // EXPLICIT registered ownership (INV-001 — the acting person at
      // registration; never caller-asserted).
      ownerPersonId: item.ownerPersonId,
      surfaceKind: item.surfaceKind,
      format: item.format,
      // PROVIDER-NEUTRAL external reference (AC-05 — no credentials).
      externalReference: item.externalReference,
      attributes: item.attributes,
      description: item.description,
      // The INV-003 ecosystem provenance signal (canonical evidence,
      // subject-bound to this item; null when unavailable).
      verificationEvidenceReference: item.verificationEvidenceReference,
      retiredAt: item.retiredAt,
      retirementReason: item.retirementReason,
      formatVersion: item.formatVersion,
      createdBy: item.createdBy,
      createdAt: item.createdAt,
      updatedAt: item.updatedAt,
      executionId: item.executionId,
      correlationId: item.correlationId,
      causationId: item.causationId,
    };
  }
  function toDemandPoolView(pool: DemandPool) {
    return {
      id: pool.id,
      organizationScopeId: pool.organizationScopeId,
      // EXPLICIT pool ownership (the acting person at creation;
      // never caller-asserted).
      createdBy: pool.createdBy,
      name: pool.name,
      categoryKey: pool.categoryKey,
      categoryVersion: pool.categoryVersion,
      policy: pool.policy,
      closedAt: pool.closedAt,
      closureReason: pool.closureReason,
      recordFormat: pool.recordFormat,
      createdAt: pool.createdAt,
      updatedAt: pool.updatedAt,
      idempotencyKey: pool.idempotencyKey,
      executionId: pool.executionId,
      correlationId: pool.correlationId,
      causationId: pool.causationId,
    };
  }
  function toDemandCommitmentView(commitment: DemandCommitment) {
    return {
      id: commitment.id,
      organizationScopeId: commitment.organizationScopeId,
      poolId: commitment.poolId,
      // The consumer (owner) is visible ONLY on the owner-scoped
      // surface (this view is returned exclusively by the mutation
      // results and the actor-scoped listMyDemandCommitments
      // command) — never in any supplier-facing aggregate.
      consumerPersonId: commitment.consumerPersonId,
      categoryKey: commitment.categoryKey,
      categoryVersion: commitment.categoryVersion,
      attributes: commitment.attributes,
      consent: commitment.consent,
      withdrawnAt: commitment.withdrawnAt,
      withdrawalReason: commitment.withdrawalReason,
      recordFormat: commitment.recordFormat,
      createdAt: commitment.createdAt,
      updatedAt: commitment.updatedAt,
      idempotencyKey: commitment.idempotencyKey,
      executionId: commitment.executionId,
      correlationId: commitment.correlationId,
      causationId: commitment.causationId,
    };
  }
  function toQualifiedDemandAggregateView(view: QualifiedDemandAggregate) {
    // The derived supplier-facing view passes through as-is: it is
    // already the minimized aggregate contract (counts/ranges only;
    // no person/commitment identifiers; anchor + digest recorded).
    return {
      poolId: view.poolId,
      organizationScopeId: view.organizationScopeId,
      category: view.category,
      policy: view.policy,
      qualified: view.qualified,
      checks: view.checks,
      aggregate: view.aggregate,
      digest: view.digest,
      evaluatedAt: view.evaluatedAt,
    };
  }
  function toProcurementPoolView(pool: ProcurementPool) {
    return {
      id: pool.id,
      organizationScopeId: pool.organizationScopeId,
      // EXPLICIT pool ownership (the acting person at creation;
      // never caller-asserted).
      createdBy: pool.createdBy,
      name: pool.name,
      categoryKey: pool.categoryKey,
      categoryVersion: pool.categoryVersion,
      policy: pool.policy,
      closedAt: pool.closedAt,
      closureReason: pool.closureReason,
      recordFormat: pool.recordFormat,
      createdAt: pool.createdAt,
      updatedAt: pool.updatedAt,
      idempotencyKey: pool.idempotencyKey,
      executionId: pool.executionId,
      correlationId: pool.correlationId,
      causationId: pool.causationId,
    };
  }
  function toProcurementCommitmentView(commitment: ProcurementCommitment) {
    return {
      id: commitment.id,
      organizationScopeId: commitment.organizationScopeId,
      poolId: commitment.poolId,
      // The buyer organization + submitter are visible ONLY on the
      // owner-scoped surfaces (this view is returned exclusively by
      // the mutation results and the actor-scoped
      // listMyProcurementCommitments command) — never in any
      // supplier-facing aggregate.
      buyerOrganizationId: commitment.buyerOrganizationId,
      submittedBy: commitment.submittedBy,
      categoryKey: commitment.categoryKey,
      categoryVersion: commitment.categoryVersion,
      attributes: commitment.attributes,
      consent: commitment.consent,
      withdrawnAt: commitment.withdrawnAt,
      withdrawalReason: commitment.withdrawalReason,
      recordFormat: commitment.recordFormat,
      createdAt: commitment.createdAt,
      updatedAt: commitment.updatedAt,
      idempotencyKey: commitment.idempotencyKey,
      executionId: commitment.executionId,
      correlationId: commitment.correlationId,
      causationId: commitment.causationId,
    };
  }
  function toQualifiedProcurementAggregateView(
    view: QualifiedProcurementAggregate,
  ) {
    // The derived supplier-facing view passes through as-is: it is
    // already the minimized aggregate contract (counts +
    // bands/buckets/windows only; no person/commitment/buyer-
    // organization identifiers; anchor + digest recorded).
    return {
      poolId: view.poolId,
      organizationScopeId: view.organizationScopeId,
      category: view.category,
      policy: view.policy,
      qualified: view.qualified,
      checks: view.checks,
      aggregate: view.aggregate,
      digest: view.digest,
      evaluatedAt: view.evaluatedAt,
    };
  }
  function toSupplierOfferView(offer: SupplierOffer) {
    return {
      id: offer.id,
      organizationScopeId: offer.organizationScopeId,
      poolId: offer.poolId,
      // The supplier is visible ONLY on the owner-scoped surfaces
      // (this view is returned exclusively by the mutation results
      // and the actor-scoped listMySupplierOffers command) — never
      // in any buyer-side or competitor-facing surface.
      supplierPersonId: offer.supplierPersonId,
      categoryKey: offer.categoryKey,
      categoryVersion: offer.categoryVersion,
      attributes: offer.attributes,
      consent: offer.consent,
      withdrawnAt: offer.withdrawnAt,
      withdrawalReason: offer.withdrawalReason,
      validFrom: offer.validFrom,
      validUntil: offer.validUntil,
      recordFormat: offer.recordFormat,
      createdAt: offer.createdAt,
      updatedAt: offer.updatedAt,
      idempotencyKey: offer.idempotencyKey,
      executionId: offer.executionId,
      correlationId: offer.correlationId,
      causationId: offer.causationId,
    };
  }
  function toCompetitiveSelectionView(view: CompetitiveSelectionView) {
    // The derived pool-creator-scoped selection view passes through
    // as-is: it is already the supplier/offer-facts-only contract
    // (supplier + bands/buckets/windows + pool digest; NO buyer
    // commitment data, NO aggregate facts, NO exact buyer terms;
    // anchor + digest recorded). Offer facts (supplier identity +
    // bands) are the explicit W026 selection contract — they never
    // cross to non-creator surfaces (the guard action + the
    // pool-creator gate are the transport/domain authorization).
    return {
      poolId: view.poolId,
      organizationScopeId: view.organizationScopeId,
      selectionPolicy: view.selectionPolicy,
      poolDigest: view.poolDigest,
      qualified: view.qualified,
      checks: view.checks,
      offerEvaluations: view.offerEvaluations,
      consideredOfferIds: view.consideredOfferIds,
      eligibleOfferIds: view.eligibleOfferIds,
      ranking: view.ranking,
      selectedOfferId: view.selectedOfferId,
      digest: view.digest,
      evaluatedAt: view.evaluatedAt,
    };
  }
  function toCompetitiveSelectionRecordView(
    selection: CompetitiveSelection,
  ) {
    // The persisted selection lineage record (immutable): the full
    // decision snapshot + provenance (PROC-AC-03 — the selection
    // records the offer set and the selection rationale).
    return {
      id: selection.id,
      organizationScopeId: selection.organizationScopeId,
      poolId: selection.poolId,
      recordedBy: selection.recordedBy,
      selectionPolicy: selection.selectionPolicy,
      poolDigest: selection.poolDigest,
      qualified: selection.qualified,
      evaluationAnchor: selection.evaluationAnchor,
      consideredOfferIds: selection.consideredOfferIds,
      eligibleOfferIds: selection.eligibleOfferIds,
      offerEvaluations: selection.offerEvaluations,
      checks: selection.checks,
      ranking: selection.ranking,
      selectedOfferId: selection.selectedOfferId,
      digest: selection.digest,
      recordFormat: selection.recordFormat,
      createdAt: selection.createdAt,
      updatedAt: selection.updatedAt,
      idempotencyKey: selection.idempotencyKey,
      executionId: selection.executionId,
      correlationId: selection.correlationId,
      causationId: selection.causationId,
    };
  }
  function toProcurementBaselineView(baseline: ProcurementBaseline) {
    // The explicit baseline/counterfactual record (pool-creator-
    // scoped surface: baseline analysis stays with the demand
    // owner; the view carries the full explicit contract — kind,
    // method + version, window, population, value + unit,
    // confidence with preserved uncertainty, provenance, evidence
    // references and the one-way invalidation fields).
    return {
      id: baseline.id,
      organizationScopeId: baseline.organizationScopeId,
      poolId: baseline.poolId,
      createdBy: baseline.createdBy,
      baselineKind: baseline.baselineKind,
      method: baseline.method,
      methodVersion: baseline.methodVersion,
      comparisonWindow: baseline.comparisonWindow,
      population: baseline.population,
      baselineValue: baseline.baselineValue,
      confidence: baseline.confidence,
      provenance: baseline.provenance,
      evidenceIds: baseline.evidenceIds,
      invalidatedAt: baseline.invalidatedAt,
      invalidationReason: baseline.invalidationReason,
      recordFormat: baseline.recordFormat,
      createdAt: baseline.createdAt,
      updatedAt: baseline.updatedAt,
      idempotencyKey: baseline.idempotencyKey,
      executionId: baseline.executionId,
      correlationId: baseline.correlationId,
      causationId: baseline.causationId,
    };
  }
  function toProcurementSavingsView(view: ProcurementSavingsView) {
    // The derived pool-creator-scoped savings view passes through
    // as-is: it is already the explicit contract (policy + baseline
    // + checks + conservatively combined values/confidence +
    // observation ids; anchor + digest recorded; uncertainty
    // preserved; anchor EXCLUDED from the digest so identical
    // authoritative state yields the identical digest). Savings
    // surfaces are pool-creator-only (the guard action + the
    // pool-creator gate are the transport/domain authorization).
    return {
      poolId: view.poolId,
      organizationScopeId: view.organizationScopeId,
      derivationPolicy: view.derivationPolicy,
      baselineId: view.baselineId,
      baselineKind: view.baselineKind,
      supported: view.supported,
      checks: view.checks,
      baselineValue: view.baselineValue,
      observedValue: view.observedValue,
      savings: view.savings,
      confidence: view.confidence,
      observationIds: view.observationIds,
      digest: view.digest,
      evaluatedAt: view.evaluatedAt,
    };
  }
  function toProcurementSavingsRecordView(savings: ProcurementSavings) {
    // The persisted savings lineage record (immutable): the full
    // derivation snapshot + provenance (the selection reference is
    // NEUTRAL W026 lineage, never savings truth).
    return {
      id: savings.id,
      organizationScopeId: savings.organizationScopeId,
      poolId: savings.poolId,
      baselineId: savings.baselineId,
      selectionId: savings.selectionId,
      recordedBy: savings.recordedBy,
      derivationPolicy: savings.derivationPolicy,
      baselineKind: savings.baselineKind,
      baselineValue: savings.baselineValue,
      observedValue: savings.observedValue,
      savings: savings.savings,
      confidence: savings.confidence,
      observationIds: savings.observationIds,
      checks: savings.checks,
      supported: savings.supported,
      evaluationAnchor: savings.evaluationAnchor,
      digest: savings.digest,
      recordFormat: savings.recordFormat,
      createdAt: savings.createdAt,
      updatedAt: savings.updatedAt,
      idempotencyKey: savings.idempotencyKey,
      executionId: savings.executionId,
      correlationId: savings.correlationId,
      causationId: savings.causationId,
    };
  }
  function toPlacementView(placement: PlacementRecord) {
    return {
      id: placement.id,
      organizationScopeId: placement.organizationScopeId,
      inventoryItemId: placement.inventoryItemId,
      campaignId: placement.campaignId,
      campaignPolicyVersion: placement.campaignPolicyVersion,
      context: placement.context,
      // The server-written provenance snapshot (INV-002 source
      // identity — no caller input exists for any field).
      sourceContext: placement.sourceContext,
      // The DERIVED eligibility snapshot (INV-002 — deterministic;
      // re-derived live by the settlement-readiness view).
      eligibility: {
        eligible: placement.eligibility.eligible,
        ruleResults: placement.eligibility.ruleResults.map((r) => ({
          attribute: r.attribute,
          operator: r.operator,
          values: r.values,
          satisfied: r.satisfied,
          reason: r.reason,
        })),
        evaluatedAt: placement.eligibility.evaluatedAt,
      },
      retiredAt: placement.retiredAt,
      retirementReason: placement.retirementReason,
      formatVersion: placement.formatVersion,
      createdBy: placement.createdBy,
      createdAt: placement.createdAt,
      updatedAt: placement.updatedAt,
      executionId: placement.executionId,
      correlationId: placement.correlationId,
      causationId: placement.causationId,
    };
  }
  function toPlacementSettlementReadinessView(
    readiness: import("../inventory/port.ts").PlacementSettlementReadiness,
  ) {
    return {
      placementId: readiness.placementId,
      organizationScopeId: readiness.organizationScopeId,
      eligible: readiness.eligible,
      checks: readiness.checks.map((check) => ({
        check: check.check,
        satisfied: check.satisfied,
        detail: check.detail,
      })),
      sourceContext: readiness.sourceContext,
      verificationEvidenceReference: readiness.verificationEvidenceReference,
      evaluatedAt: readiness.evaluatedAt,
    };
  }
  function toHelpfulnessPolicyView(
    policy: import("../contributions/port.ts").HelpfulnessPolicy,
  ) {
    return {
      id: policy.id,
      policyId: policy.policyId,
      organizationScopeId: policy.organizationScopeId,
      version: policy.version,
      formatVersion: policy.formatVersion,
      sections: policy.sections as unknown as Record<string, unknown>,
      createdBy: policy.createdBy,
      createdAt: policy.createdAt,
    };
  }
  function toProofOfHelpfulnessView(
    poh: import("../contributions/port.ts").ProofOfHelpfulness,
  ) {
    return {
      id: poh.id,
      organizationScopeId: poh.organizationScopeId,
      contributionId: poh.contributionId,
      contributorId: poh.contributorId,
      helpfulnessPolicyId: poh.helpfulnessPolicyId,
      helpfulnessPolicyVersion: poh.helpfulnessPolicyVersion,
      formatVersion: poh.formatVersion,
      eligibility: poh.eligibility as unknown as Record<string, unknown> | null,
      mentions: poh.mentions as unknown as readonly Record<string, unknown>[],
      disclosureIds: poh.disclosureIds,
      advisoryScores: poh.advisoryScores as unknown as readonly Record<
        string,
        unknown
      >[],
      bases: poh.bases as unknown as readonly Record<string, unknown>[],
      evaluations: poh.evaluations as unknown as readonly Record<
        string,
        unknown
      >[],
      recommendations: poh.recommendations as unknown as readonly Record<
        string,
        unknown
      >[],
      publication: poh.publication as unknown as Record<string, unknown> | null,
      state: poh.state,
      events: poh.events,
      createdAt: poh.createdAt,
      updatedAt: poh.updatedAt,
    };
  }
  function toCommercialDisclosureView(
    disclosure: import("../contributions/port.ts").CommercialDisclosureRecord,
  ) {
    return {
      id: disclosure.id,
      organizationScopeId: disclosure.organizationScopeId,
      contributionId: disclosure.contributionId,
      contributorId: disclosure.contributorId,
      relationshipKind: disclosure.relationshipKind,
      relationshipRef: disclosure.relationshipRef,
      productRef: disclosure.productRef,
      counterpartyRef: disclosure.counterpartyRef,
      description: disclosure.description,
      state: disclosure.state,
      events: disclosure.events,
      createdAt: disclosure.createdAt,
      updatedAt: disclosure.updatedAt,
    };
  }
  function toHelpfulContributionView(
    contribution: import("../contributions/port.ts").Contribution,
  ) {
    return {
      id: contribution.id,
      organizationScopeId: contribution.organizationScopeId,
      opportunityId: contribution.opportunityId,
      contributorId: contribution.contributorId,
      contributionType: contribution.contributionType,
      state: contribution.state,
      version: contribution.version,
      submission: contribution.submission as unknown as Record<string, unknown>,
      createdAt: contribution.createdAt,
      updatedAt: contribution.updatedAt,
    };
  }
  function toQualityPolicyView(
    policy: import("../contributions/port.ts").QualityPolicy,
  ) {
    return {
      id: policy.id,
      policyId: policy.policyId,
      organizationScopeId: policy.organizationScopeId,
      version: policy.version,
      formatVersion: policy.formatVersion,
      inputs: policy.inputs as unknown as readonly Record<string, unknown>[],
      advisory: policy.advisory as unknown as Record<string, unknown>,
      minimumGrade: policy.minimumGrade,
      qualifyingSourceTypes: policy.qualifyingSourceTypes,
      qualifyingOutcomeTypes: policy.qualifyingOutcomeTypes,
      minimumConfidence: policy.minimumConfidence,
      thresholds: policy.thresholds as unknown as Record<string, unknown>,
      structural: policy.structural as unknown as Record<string, unknown>,
      description: policy.description,
      createdBy: policy.createdBy,
      createdAt: policy.createdAt,
    };
  }
  function toQualityEvaluationView(
    evaluation: import("../contributions/port.ts").QualityEvaluation,
  ) {
    return {
      id: evaluation.id,
      organizationScopeId: evaluation.organizationScopeId,
      contributionId: evaluation.contributionId,
      qualityPolicyId: evaluation.qualityPolicyId,
      qualityPolicyVersion: evaluation.qualityPolicyVersion,
      formatVersion: evaluation.formatVersion,
      evaluatedAt: evaluation.evaluatedAt,
      recordedAt: evaluation.recordedAt,
      inputContributions: evaluation.inputContributions as unknown as readonly Record<
        string,
        unknown
      >[],
      advisoryCount: evaluation.advisoryCount,
      advisoryAverage: evaluation.advisoryAverage,
      score: evaluation.score,
      band: evaluation.band,
      reasons: evaluation.reasons,
      evaluator: evaluation.evaluator,
      digest: evaluation.digest,
      supersedesEvaluationId: evaluation.supersedesEvaluationId,
      supersededByEvaluationId: evaluation.supersededByEvaluationId,
    };
  }
  function toAdvisoryQualityScoreView(
    score: import("../contributions/port.ts").AdvisoryQualityScore,
  ) {
    return {
      id: score.id,
      organizationScopeId: score.organizationScopeId,
      contributionId: score.contributionId,
      kind: score.kind,
      methodRef: score.methodRef,
      methodVersion: score.methodVersion,
      provider: score.provider,
      modelRef: score.modelRef,
      score: score.score,
      recordedBy: score.recordedBy,
      recordedAt: score.recordedAt,
    };
  }
  function toModerationDecisionView(
    decision: import("../contributions/port.ts").ModerationDecisionRecord,
  ) {
    return {
      id: decision.id,
      organizationScopeId: decision.organizationScopeId,
      contributionId: decision.contributionId,
      decision: decision.decision,
      reasonKinds: decision.reasonKinds,
      notes: decision.notes,
      qualityEvaluationIds: decision.qualityEvaluationIds,
      decidedBy: decision.decidedBy,
      decidedAt: decision.decidedAt,
    };
  }
  function toModerationSummaryView(
    summary: import("../contributions/port.ts").ModerationSummary,
  ) {
    return {
      contributionId: summary.contributionId,
      organizationScopeId: summary.organizationScopeId,
      status: summary.status,
      decisionCount: summary.decisionCount,
      latestDecision:
        summary.latestDecision === null
          ? null
          : toModerationDecisionView(summary.latestDecision),
    };
  }

  const apiCommands: ApiCommands = {
    async createIdentity(execution, input) {
      const identity = await identityService.createIdentity(execution, {
        displayName: input.displayName,
        subjectReferences: [{ subjectId: input.subjectId, providerKind: input.providerKind }],
      });
      return { id: identity.id, displayName: identity.displayName };
    },
    async getPublicIdentity(execution, id) {
      try {
        const view = await identityService.getPublicView(
          // The API server passes the request's execution context. Use the
          // active context if available (the API server wraps requests in
          // one), falling back to the passed-in execution.
          getExecutionContext() ?? execution,
          id,
        );
        return view;
      } catch {
        return null;
      }
    },
    async createOrganization(execution, actorPersonId, input) {
      const org = await organizationService.createOrganization(execution, {
        name: input.name,
        creatorId: actorPersonId,
      });
      return { id: org.id, name: org.name, createdBy: org.createdBy, createdAt: org.createdAt };
    },
    async grantMembership(execution, actorPersonId, organizationId, input) {
      const result = await membershipService.grantMembership(execution, {
        personId: input.personId,
        organizationId,
        grantedBy: actorPersonId,
      });
      const m = result.membership;
      return {
        membership: {
          id: m.id,
          personId: m.personId,
          organizationId: m.organizationId,
          status: m.status,
          grantedAt: m.grantedAt,
          grantedBy: m.grantedBy,
          revokedAt: m.revokedAt,
          revokedBy: m.revokedBy,
        },
        created: result.created,
      };
    },
    async revokeMembership(execution, actorPersonId, membershipId) {
      const result = await membershipService.revokeMembership(execution, membershipId, actorPersonId);
      const m = result.membership;
      return {
        membership: {
          id: m.id,
          personId: m.personId,
          organizationId: m.organizationId,
          status: m.status,
          grantedAt: m.grantedAt,
          grantedBy: m.grantedBy,
          revokedAt: m.revokedAt,
          revokedBy: m.revokedBy,
        },
        already: result.already,
      };
    },
    // -- NET-W004 opportunity/contribution/transition commands -----------
    async createOpportunity(execution, actorPersonId, input) {
      const opp = await opportunityService.createOpportunity(execution, {
        organizationScopeId: input.organizationScopeId,
        ownerId: actorPersonId,
        opportunityType: input.opportunityType,
        title: input.title,
        brief: input.brief,
        eligibilityPolicyReference: input.eligibilityPolicyReference,
        contributionRequirements: input.contributionRequirements,
        evidenceReferencePlaceholders: input.evidenceReferencePlaceholders,
      });
      return {
        id: opp.id,
        organizationScopeId: opp.organizationScopeId,
        ownerId: opp.ownerId,
        opportunityType: opp.opportunityType,
        title: opp.title,
        state: opp.state,
        version: opp.version,
        createdAt: opp.createdAt,
      };
    },
    async getOpportunity(execution, id) {
      try {
        const opp = await opportunityService.getOpportunity(
          getExecutionContext() ?? execution,
          id,
        );
        return {
          id: opp.id,
          organizationScopeId: opp.organizationScopeId,
          ownerId: opp.ownerId,
          opportunityType: opp.opportunityType,
          title: opp.title,
          brief: opp.brief,
          eligibilityPolicyReference: opp.eligibilityPolicyReference,
          contributionRequirements: opp.contributionRequirements,
          evidenceReferencePlaceholders: opp.evidenceReferencePlaceholders,
          state: opp.state,
          version: opp.version,
          createdAt: opp.createdAt,
          updatedAt: opp.updatedAt,
        };
      } catch {
        return null;
      }
    },
    async createContribution(execution, actorPersonId, input) {
      const c = await contributionService.createContribution(execution, {
        opportunityId: input.opportunityId,
        contributorId: actorPersonId,
        organizationScopeId: input.organizationScopeId,
        contributionType: input.contributionType,
        submission: input.submission,
        evidenceReferencePlaceholders: input.evidenceReferencePlaceholders,
      });
      return {
        id: c.id,
        opportunityId: c.opportunityId,
        contributorId: c.contributorId,
        organizationScopeId: c.organizationScopeId,
        contributionType: c.contributionType,
        submission: c.submission,
        state: c.state,
        version: c.version,
        createdAt: c.createdAt,
      };
    },
    async getContribution(execution, id) {
      try {
        const c = await contributionService.getContribution(
          getExecutionContext() ?? execution,
          id,
        );
        return {
          id: c.id,
          opportunityId: c.opportunityId,
          contributorId: c.contributorId,
          organizationScopeId: c.organizationScopeId,
          contributionType: c.contributionType,
          submission: c.submission,
          evidenceReferencePlaceholders: c.evidenceReferencePlaceholders,
          state: c.state,
          version: c.version,
          createdAt: c.createdAt,
          updatedAt: c.updatedAt,
        };
      } catch {
        return null;
      }
    },
    async requestTransition(execution, actorPersonId, input) {
      // Build the TransitionRequest from the API input. The workflow
      // service does the authorization + idempotency + audit. The
      // actorPersonId is the server-resolved principal (the API guard
      // has already authenticated and authorized the caller — see
      // guardMutation in api/server.ts).
      const request: TransitionRequest = {
        subjectId: input.subjectId,
        subjectKind: input.subjectKind,
        targetState: input.targetState as TransitionRequest["targetState"],
        expectedVersion: input.expectedVersion,
        idempotencyKey: input.idempotencyKey,
        actorPersonId,
        policyAction: input.policyAction,
        metadata: input.metadata,
      };
      const result: TransitionResult = await workflowService.requestTransition(
        request,
        execution,
      );
      return {
        subjectId: result.subject.id,
        subjectKind: result.subject.kind,
        state: result.subject.state,
        version: result.subject.version,
        executed: result.executed,
        transitionId: result.transitionId,
        recordId: result.recordId,
        auditEventName: result.auditEventName,
        executionId: result.executionId,
        correlationId: result.correlationId,
        causationId: result.causationId,
        transactionId: result.transactionId,
      };
    },
    // -- NET-W005 evidence/proof-of-value commands -----------------------
    async createEvidence(execution, actorPersonId, input) {
      const evidence = await evidenceService.createEvidence(execution, {
        organizationScopeId: input.organizationScopeId,
        ownerId: actorPersonId,
        subjectReference: input.subjectReference,
        provenance: input.provenance as unknown as CreateEvidenceInput["provenance"],
        confidence: input.confidence as unknown as CreateEvidenceInput["confidence"],
        sensitivity: input.sensitivity as CreateEvidenceInput["sensitivity"],
        payload: input.payload,
        sensitivePayload: input.sensitivePayload,
        commitment: input.commitment as unknown as CreateEvidenceInput["commitment"],
        payloadReference: input.payloadReference,
      });
      return {
        id: evidence.id,
        organizationScopeId: evidence.organizationScopeId,
        ownerId: evidence.ownerId,
        subjectReference: evidence.subjectReference,
        provenance: evidence.provenance as unknown as Record<string, unknown>,
        grade: evidence.grade,
        confidence: evidence.confidence as unknown as Record<string, unknown>,
        sensitivity: evidence.sensitivity,
        // For sensitive evidence this is null BY CONSTRUCTION (the raw
        // material is never stored, so it can never be returned).
        payload: evidence.payload as Record<string, unknown> | null,
        commitment: evidence.commitment as unknown as Record<string, unknown> | null,
        payloadReference: evidence.payloadReference,
        createdAt: evidence.createdAt,
      };
    },
    async getEvidence(execution, id) {
      try {
        const evidence = await evidenceService.getEvidence(
          getExecutionContext() ?? execution,
          id,
        );
        return {
          id: evidence.id,
          organizationScopeId: evidence.organizationScopeId,
          ownerId: evidence.ownerId,
          subjectReference: evidence.subjectReference,
          provenance: evidence.provenance as unknown as Record<string, unknown>,
          grade: evidence.grade,
          confidence: evidence.confidence as unknown as Record<string, unknown>,
          sensitivity: evidence.sensitivity,
          payload: evidence.payload as Record<string, unknown> | null,
          commitment: evidence.commitment as unknown as Record<string, unknown> | null,
          payloadReference: evidence.payloadReference,
          createdAt: evidence.createdAt,
        };
      } catch {
        return null;
      }
    },
    async verifyEvidenceCommitment(execution, id, presentedPayload) {
      const result = await evidenceService.verifyEvidenceCommitment(
        getExecutionContext() ?? execution,
        id,
        presentedPayload,
      );
      return { evidenceId: result.evidenceId, valid: result.valid, reason: result.reason };
    },
    async createOutcomeClaim(execution, actorPersonId, input) {
      const claim = await outcomeClaimService.createOutcomeClaim(execution, {
        organizationScopeId: input.organizationScopeId,
        claimantId: actorPersonId,
        subjectReference: input.subjectReference,
        outcomeType: input.outcomeType as CreateOutcomeClaimInput["outcomeType"],
        claimedValue: input.claimedValue,
        confidence: input.confidence as unknown as CreateOutcomeClaimInput["confidence"],
        evidenceIds: input.evidenceIds,
        statement: input.statement,
      });
      return {
        id: claim.id,
        organizationScopeId: claim.organizationScopeId,
        claimantId: claim.claimantId,
        subjectReference: claim.subjectReference,
        outcomeType: claim.outcomeType,
        claimedValue: claim.claimedValue,
        confidence: claim.confidence as unknown as Record<string, unknown>,
        evidenceIds: claim.evidenceIds,
        statement: claim.statement,
        createdAt: claim.createdAt,
        updatedAt: claim.updatedAt,
        version: claim.version,
      };
    },
    async getOutcomeClaim(execution, id) {
      try {
        const claim = await outcomeClaimService.getOutcomeClaim(
          getExecutionContext() ?? execution,
          id,
        );
        return {
          id: claim.id,
          organizationScopeId: claim.organizationScopeId,
          claimantId: claim.claimantId,
          subjectReference: claim.subjectReference,
          outcomeType: claim.outcomeType,
          claimedValue: claim.claimedValue,
          confidence: claim.confidence as unknown as Record<string, unknown>,
          evidenceIds: claim.evidenceIds,
          statement: claim.statement,
          createdAt: claim.createdAt,
          updatedAt: claim.updatedAt,
          version: claim.version,
        };
      } catch {
        return null;
      }
    },
    async attachEvidenceToClaim(execution, _actorPersonId, claimId, evidenceId) {
      const claim = await outcomeClaimService.attachEvidence(
        execution,
        claimId,
        evidenceId,
      );
      return {
        id: claim.id,
        organizationScopeId: claim.organizationScopeId,
        claimantId: claim.claimantId,
        subjectReference: claim.subjectReference,
        outcomeType: claim.outcomeType,
        claimedValue: claim.claimedValue,
        confidence: claim.confidence as unknown as Record<string, unknown>,
        evidenceIds: claim.evidenceIds,
        statement: claim.statement,
        createdAt: claim.createdAt,
        updatedAt: claim.updatedAt,
        version: claim.version,
      };
    },
    async createAttestation(execution, _actorPersonId, input) {
      const attestation = await attestationService.createAttestation(execution, {
        organizationScopeId: input.organizationScopeId,
        verifierId: input.verifierId,
        statement: input.statement,
        evidenceIds: input.evidenceIds,
      });
      return {
        id: attestation.id,
        organizationScopeId: attestation.organizationScopeId,
        verifierId: attestation.verifierId,
        statement: attestation.statement,
        evidenceIds: attestation.evidenceIds,
        algorithm: attestation.algorithm,
        signature: attestation.signature,
        signedAt: attestation.signedAt,
        createdAt: attestation.createdAt,
      };
    },
    async verifyAttestation(execution, id) {
      const result = await attestationService.verifyAttestation(
        getExecutionContext() ?? execution,
        id,
      );
      return { attestationId: result.attestationId, valid: result.valid, reason: result.reason };
    },
    // -- NET-W029 signed-attestation commands ---------------------------
    async createSignedAttestation(execution, _actorPersonId, input) {
      const result = await signedAttestationService.createSignedAttestation(execution, {
        organizationScopeId: input.organizationScopeId,
        verifierId: input.verifierId,
        statement: input.statement,
        coverage: input.coverage.map((ref) => ({ family: ref.family, recordId: ref.recordId })),
        idempotencyKey: input.idempotencyKey,
      });
      return toApiSignedAttestationView(result.attestation);
    },
    async getSignedAttestation(execution, id, input) {
      try {
        const attestation = await signedAttestationService.getSignedAttestation(
          getExecutionContext() ?? execution,
          input.organizationScopeId,
          id,
        );
        return toApiSignedAttestationView(attestation);
      } catch {
        // Cross-tenant + nonexistent are indistinguishable (no
        // existence oracle) — the route renders 404.
        return null;
      }
    },
    async verifySignedAttestation(execution, id, input) {
      const verdict = await signedAttestationService.verifySignedAttestation(
        getExecutionContext() ?? execution,
        input.organizationScopeId,
        id,
      );
      return {
        attestationId: verdict.attestationId,
        valid: verdict.valid,
        reason: verdict.reason,
        checks: verdict.checks.map((c) => ({
          check: c.check,
          subject: c.subject,
          passed: c.passed,
          reason: c.reason,
        })),
      };
    },
    async revokeSignedAttestation(execution, _actorPersonId, id, input) {
      const attestation = await signedAttestationService.revokeSignedAttestation(execution, {
        organizationScopeId: input.organizationScopeId,
        attestationId: id,
        reason: input.reason,
        idempotencyKey: input.idempotencyKey,
      });
      return toApiSignedAttestationView(attestation);
    },
    // -- NET-W030 external settlement commands --------------------------
    async recordExternalSettlementFact(execution, _actorPersonId, input) {
      const result = await externalSettlementService.recordExternalSettlementFact(execution, {
        organizationScopeId: input.organizationScopeId,
        provider: input.provider,
        payload: input.payload,
        idempotencyKey: input.idempotencyKey,
      });
      return {
        fact: toApiExternalSettlementFactView(result.fact),
        created: result.created,
        reconciliation: toApiExternalSettlementReconciliationView(result.reconciliation),
      };
    },
    async getExternalSettlementFact(execution, id, input) {
      try {
        const fact = await externalSettlementService.getExternalSettlementFact(
          getExecutionContext() ?? execution,
          input.organizationScopeId,
          id,
        );
        return fact === null ? null : toApiExternalSettlementFactView(fact);
      } catch {
        // Cross-tenant + nonexistent are indistinguishable (no
        // existence oracle) — the route renders 404.
        return null;
      }
    },
    async evaluateExternalSettlementReconciliation(execution, id, input) {
      const view = await externalSettlementService.evaluateExternalSettlementReconciliation(
        getExecutionContext() ?? execution,
        { organizationScopeId: input.organizationScopeId, factId: id },
      );
      return toApiExternalSettlementReconciliationView(view);
    },
    async listExternalSettlementFactsByTransaction(execution, input) {
      const facts = await externalSettlementService.listExternalSettlementFactsByTransaction(
        getExecutionContext() ?? execution,
        input.organizationScopeId,
        input.internalTransactionId,
      );
      return {
        internalTransactionId: input.internalTransactionId,
        facts: facts.map((f) => toApiExternalSettlementFactView(f)),
      };
    },
    async createProofOfValue(execution, actorPersonId, input) {
      const proof = await proofOfValueService.createProofOfValue(execution, {
        organizationScopeId: input.organizationScopeId,
        ownerId: actorPersonId,
        subjectReference: input.subjectReference,
        outcomeClaimIds: input.outcomeClaimIds,
        evidenceIds: input.evidenceIds,
      });
      return {
        id: proof.id,
        organizationScopeId: proof.organizationScopeId,
        ownerId: proof.ownerId,
        subjectReference: proof.subjectReference,
        outcomeClaimIds: proof.outcomeClaimIds,
        evidenceIds: proof.evidenceIds,
        attestationIds: proof.attestationIds,
        state: proof.state,
        version: proof.version,
        createdAt: proof.createdAt,
        updatedAt: proof.updatedAt,
      };
    },
    async getProofOfValue(execution, id) {
      try {
        const proof = await proofOfValueService.getProofOfValue(
          getExecutionContext() ?? execution,
          id,
        );
        return {
          id: proof.id,
          organizationScopeId: proof.organizationScopeId,
          ownerId: proof.ownerId,
          subjectReference: proof.subjectReference,
          outcomeClaimIds: proof.outcomeClaimIds,
          evidenceIds: proof.evidenceIds,
          attestationIds: proof.attestationIds,
          state: proof.state,
          version: proof.version,
          createdAt: proof.createdAt,
          updatedAt: proof.updatedAt,
          aggregation: proof.aggregation as unknown as Record<string, unknown> | null,
        };
      } catch {
        return null;
      }
    },
    async attachEvidenceToProof(execution, _actorPersonId, proofId, evidenceId) {
      const proof = await proofOfValueService.attachEvidence(execution, proofId, evidenceId);
      return {
        id: proof.id,
        organizationScopeId: proof.organizationScopeId,
        ownerId: proof.ownerId,
        subjectReference: proof.subjectReference,
        outcomeClaimIds: proof.outcomeClaimIds,
        evidenceIds: proof.evidenceIds,
        attestationIds: proof.attestationIds,
        state: proof.state,
        version: proof.version,
        createdAt: proof.createdAt,
        updatedAt: proof.updatedAt,
      };
    },
    async aggregateProofEvidence(execution, _actorPersonId, proofId) {
      const proof = await proofOfValueService.aggregateEvidence(execution, proofId);
      return {
        id: proof.id,
        organizationScopeId: proof.organizationScopeId,
        ownerId: proof.ownerId,
        subjectReference: proof.subjectReference,
        outcomeClaimIds: proof.outcomeClaimIds,
        evidenceIds: proof.evidenceIds,
        attestationIds: proof.attestationIds,
        state: proof.state,
        version: proof.version,
        createdAt: proof.createdAt,
        updatedAt: proof.updatedAt,
        aggregation: proof.aggregation as unknown as Record<string, unknown> | null,
      };
    },
    async attachAttestationToProof(execution, _actorPersonId, proofId, attestationId) {
      const proof = await proofOfValueService.attachAttestation(
        execution,
        proofId,
        attestationId,
      );
      return {
        id: proof.id,
        organizationScopeId: proof.organizationScopeId,
        ownerId: proof.ownerId,
        subjectReference: proof.subjectReference,
        outcomeClaimIds: proof.outcomeClaimIds,
        evidenceIds: proof.evidenceIds,
        attestationIds: proof.attestationIds,
        state: proof.state,
        version: proof.version,
        createdAt: proof.createdAt,
        updatedAt: proof.updatedAt,
      };
    },
    // -- NET-W006 outcomes/measurement commands -------------------------
    async createOutcomeObservation(execution, actorPersonId, input) {
      const observation = await outcomeObservationService.createOutcomeObservation(
        execution,
        {
          organizationScopeId: input.organizationScopeId,
          observerId: actorPersonId,
          subjectReference: input.subjectReference,
          outcomeType: input.outcomeType as CreateOutcomeObservationInput["outcomeType"],
          ...(input.outcomeClaimId !== undefined ? { outcomeClaimId: input.outcomeClaimId } : {}),
          ...(input.evidenceId !== undefined ? { evidenceId: input.evidenceId } : {}),
          observedValue: input.observedValue,
          confidence: input.confidence as unknown as CreateOutcomeObservationInput["confidence"],
          provenance: input.provenance as unknown as CreateOutcomeObservationInput["provenance"],
        },
      );
      return toObservationView(observation);
    },
    async getOutcomeObservation(execution, id) {
      try {
        const observation = await outcomeObservationService.getOutcomeObservation(
          getExecutionContext() ?? execution,
          id,
        );
        return toObservationView(observation);
      } catch {
        return null;
      }
    },
    async correctOutcomeObservation(execution, actorPersonId, observationId, input) {
      const correction = await outcomeObservationService.correctOutcomeObservation(
        execution,
        {
          organizationScopeId: input.organizationScopeId,
          observerId: actorPersonId,
          ...(input.outcomeClaimId !== undefined ? { outcomeClaimId: input.outcomeClaimId } : {}),
          ...(input.evidenceId !== undefined ? { evidenceId: input.evidenceId } : {}),
          observedValue: input.observedValue,
          confidence: input.confidence as unknown as CreateOutcomeObservationInput["confidence"],
          provenance: input.provenance as unknown as CreateOutcomeObservationInput["provenance"],
          correctsObservationId: observationId,
        },
      );
      return toObservationView(correction);
    },
    async ingestProviderObservations(execution, actorPersonId, input) {
      const result = await outcomeObservationService.ingestProviderObservations(
        execution,
        {
          organizationScopeId: input.organizationScopeId,
          observerId: actorPersonId,
          subjectReference: input.subjectReference,
          ...(input.since !== undefined ? { since: input.since } : {}),
        },
      );
      return {
        providerId: result.providerId,
        createdObservations: result.createdObservations.map(toObservationView),
      };
    },
    async submitMeasurementReport(execution, actorPersonId, input) {
      // NET-W022 composition-root composite (the adapter tier cannot
      // import /outcomes — the tier matrix forbids it): (1) the
      // measurement boundary normalizes the raw vendor report (fail
      // closed), (2) the /outcomes domain validates the neutral report
      // and persists it exactly-once-per-key with atomic audit. The
      // observer is the server-resolved authenticated actor.
      const normalized = await measurementIngestion.normalizeSubmission({
        providerId: input.providerId,
        payload: input.report,
      });
      const result = await outcomeObservationService.ingestProviderReport(
        execution,
        {
          organizationScopeId: input.organizationScopeId,
          observerId: actorPersonId,
          subjectReference: input.subjectReference,
          report: normalized.report,
          providerAdapterVersion: normalized.providerVersion,
          idempotencyKey: input.idempotencyKey,
        },
      );
      return {
        providerId: normalized.report.providerId,
        providerVersion: normalized.providerVersion,
        redactedFieldNames: normalized.redactedFieldNames,
        created: result.created,
        observation: toObservationView(result.observation),
      };
    },
    async evaluateExternalAdRequest(execution, _actorPersonId, input) {
      // NET-W023 composition-root composite (the adapter tier cannot
      // import /inventory — the tier matrix forbids it): the /adapters
      // ingress normalizes the raw vendor request (fail closed),
      // resolves the supply identity through the NEUTRAL read-only
      // inventory lookup, and derives the admission evaluation. This
      // composite performs NO material mutation — the evaluation is a
      // pure derivation (issue #46 scope 4/6); the guard has already
      // authenticated the acting principal.
      void execution;
      return openRtbIngress.evaluateAdRequest({
        organizationScopeId: input.organizationScopeId,
        providerId: input.providerId,
        payload: input.request,
        ...(input.sellerAuthorizations !== undefined
          ? { sellerAuthorizations: input.sellerAuthorizations }
          : {}),
        ...(input.evaluatedAt !== undefined ? { evaluatedAt: input.evaluatedAt } : {}),
      });
    },
    async createMeasurementExperiment(execution, actorPersonId, input) {
      const experiment = await measurementExperimentService.createMeasurementExperiment(
        execution,
        {
          organizationScopeId: input.organizationScopeId,
          ownerId: actorPersonId,
          experimentType: input.experimentType,
          ...(input.hypothesis !== undefined ? { hypothesis: input.hypothesis } : {}),
        },
      );
      return toExperimentView(experiment);
    },
    async getMeasurementExperiment(execution, id) {
      try {
        const experiment = await measurementExperimentService.getMeasurementExperiment(
          getExecutionContext() ?? execution,
          id,
        );
        return toExperimentView(experiment);
      } catch {
        return null;
      }
    },
    async startMeasurementExperiment(execution, _actorPersonId, experimentId, input) {
      return toExperimentView(
        await measurementExperimentService.startExperiment(execution, {
          experimentId,
          expectedVersion: input.expectedVersion,
        }),
      );
    },
    async completeMeasurementExperiment(execution, _actorPersonId, experimentId, input) {
      return toExperimentView(
        await measurementExperimentService.completeExperiment(execution, {
          experimentId,
          expectedVersion: input.expectedVersion,
        }),
      );
    },
    async invalidateMeasurementExperiment(execution, _actorPersonId, experimentId, input) {
      const reason = input.reason ?? "invalidated via API";
      return toExperimentView(
        await measurementExperimentService.invalidateExperiment(execution, {
          experimentId,
          expectedVersion: input.expectedVersion,
          reason,
        }),
      );
    },
    async createAttribution(execution, actorPersonId, input) {
      const attribution = await attributionService.createAttribution(execution, {
        organizationScopeId: input.organizationScopeId,
        observationId: input.observationId,
        attributedSubject: input.attributedSubject,
        mode: input.mode,
        attributionValue: input.attributionValue,
        confidence: input.confidence as unknown as CreateAttributionInput["confidence"],
        provenance: input.provenance as unknown as CreateAttributionInput["provenance"],
        ...(input.deterministicLink !== undefined
          ? { deterministicLink: input.deterministicLink }
          : {}),
        ...(input.experimentId !== undefined ? { experimentId: input.experimentId } : {}),
        evidenceIds: input.evidenceIds ?? [],
      });
      return {
        id: attribution.id,
        organizationScopeId: attribution.organizationScopeId,
        observationId: attribution.observationId,
        attributedSubject: attribution.attributedSubject,
        mode: attribution.mode,
        attributionValue: attribution.attributionValue,
        confidence: attribution.confidence as unknown as Record<string, unknown>,
        provenance: attribution.provenance as unknown as Record<string, unknown>,
        deterministicLink: attribution.deterministicLink as unknown as Record<string, unknown> | null,
        experimentId: attribution.experimentId,
        evidenceIds: attribution.evidenceIds,
        createdAt: attribution.createdAt,
      };
    },
    async getAttribution(execution, id) {
      try {
        const attribution = await attributionService.getAttribution(
          getExecutionContext() ?? execution,
          id,
        );
        return {
          id: attribution.id,
          organizationScopeId: attribution.organizationScopeId,
          observationId: attribution.observationId,
          attributedSubject: attribution.attributedSubject,
          mode: attribution.mode,
          attributionValue: attribution.attributionValue,
          confidence: attribution.confidence as unknown as Record<string, unknown>,
          provenance: attribution.provenance as unknown as Record<string, unknown>,
          deterministicLink: attribution.deterministicLink as unknown as Record<string, unknown> | null,
          experimentId: attribution.experimentId,
          evidenceIds: attribution.evidenceIds,
          createdAt: attribution.createdAt,
        };
      } catch {
        return null;
      }
    },
    async createIncrementalityObservation(execution, actorPersonId, input) {
      const observation = await incrementalityService.createIncrementalityObservation(
        execution,
        {
          organizationScopeId: input.organizationScopeId,
          ownerId: actorPersonId,
          subjectReference: input.subjectReference,
          outcomeType: input.outcomeType as CreateIncrementalityObservationInput["outcomeType"],
          lift: input.lift,
          baselineValue: input.baselineValue,
          confidence: input.confidence as unknown as CreateIncrementalityObservationInput["confidence"],
          provenance: input.provenance as unknown as CreateIncrementalityObservationInput["provenance"],
          ...(input.experimentId !== undefined ? { experimentId: input.experimentId } : {}),
          evidenceIds: input.evidenceIds ?? [],
        },
      );
      return {
        id: observation.id,
        organizationScopeId: observation.organizationScopeId,
        ownerId: observation.ownerId,
        subjectReference: observation.subjectReference,
        outcomeType: observation.outcomeType,
        lift: observation.lift,
        baselineValue: observation.baselineValue,
        confidence: observation.confidence as unknown as Record<string, unknown>,
        provenance: observation.provenance as unknown as Record<string, unknown>,
        experimentId: observation.experimentId,
        causalStatus: observation.causalStatus,
        evidenceIds: observation.evidenceIds,
        createdAt: observation.createdAt,
      };
    },
    async getIncrementalityObservation(execution, id) {
      try {
        const observation = await incrementalityService.getIncrementalityObservation(
          getExecutionContext() ?? execution,
          id,
        );
        return {
          id: observation.id,
          organizationScopeId: observation.organizationScopeId,
          ownerId: observation.ownerId,
          subjectReference: observation.subjectReference,
          outcomeType: observation.outcomeType,
          lift: observation.lift,
          baselineValue: observation.baselineValue,
          confidence: observation.confidence as unknown as Record<string, unknown>,
          provenance: observation.provenance as unknown as Record<string, unknown>,
          experimentId: observation.experimentId,
          causalStatus: observation.causalStatus,
          evidenceIds: observation.evidenceIds,
          createdAt: observation.createdAt,
        };
      } catch {
        return null;
      }
    },
    async createCounterfactualBaseline(execution, actorPersonId, input) {
      const baseline = await baselineService.createCounterfactualBaseline(execution, {
        organizationScopeId: input.organizationScopeId,
        ownerId: actorPersonId,
        subjectReference: input.subjectReference,
        outcomeType: input.outcomeType as CreateCounterfactualBaselineInput["outcomeType"],
        baselineKind: input.baselineKind,
        baselineValue: input.baselineValue,
        ...(input.comparisonValue !== undefined ? { comparisonValue: input.comparisonValue } : {}),
        confidence: input.confidence as unknown as CreateCounterfactualBaselineInput["confidence"],
        provenance: input.provenance as unknown as CreateCounterfactualBaselineInput["provenance"],
        evidenceIds: input.evidenceIds ?? [],
      });
      return {
        id: baseline.id,
        organizationScopeId: baseline.organizationScopeId,
        ownerId: baseline.ownerId,
        subjectReference: baseline.subjectReference,
        outcomeType: baseline.outcomeType,
        baselineKind: baseline.baselineKind,
        baselineValue: baseline.baselineValue,
        comparisonValue: baseline.comparisonValue,
        confidence: baseline.confidence as unknown as Record<string, unknown>,
        provenance: baseline.provenance as unknown as Record<string, unknown>,
        evidenceIds: baseline.evidenceIds,
        createdAt: baseline.createdAt,
      };
    },
    async getCounterfactualBaseline(execution, id) {
      try {
        const baseline = await baselineService.getCounterfactualBaseline(
          getExecutionContext() ?? execution,
          id,
        );
        return {
          id: baseline.id,
          organizationScopeId: baseline.organizationScopeId,
          ownerId: baseline.ownerId,
          subjectReference: baseline.subjectReference,
          outcomeType: baseline.outcomeType,
          baselineKind: baseline.baselineKind,
          baselineValue: baseline.baselineValue,
          comparisonValue: baseline.comparisonValue,
          confidence: baseline.confidence as unknown as Record<string, unknown>,
          provenance: baseline.provenance as unknown as Record<string, unknown>,
          evidenceIds: baseline.evidenceIds,
          createdAt: baseline.createdAt,
        };
      } catch {
        return null;
      }
    },
    async createMeasuredOutcome(execution, actorPersonId, input) {
      const maturation = input.maturation as unknown as CreateMeasuredOutcomeInput["maturation"];
      const measurement = await measuredOutcomeService.createMeasuredOutcome(execution, {
        organizationScopeId: input.organizationScopeId,
        ownerId: actorPersonId,
        subjectReference: input.subjectReference,
        outcomeType: input.outcomeType as CreateMeasuredOutcomeInput["outcomeType"],
        ...(input.outcomeClaimId !== undefined ? { outcomeClaimId: input.outcomeClaimId } : {}),
        maturation,
        ...(input.rollupStrategy !== undefined ? { rollupStrategy: input.rollupStrategy } : {}),
        observationIds: input.observationIds ?? [],
      });
      return toMeasurementView(measurement);
    },
    async getMeasuredOutcome(execution, id) {
      try {
        const measurement = await measuredOutcomeService.getMeasuredOutcome(
          getExecutionContext() ?? execution,
          id,
        );
        return {
          ...toMeasurementView(measurement),
          rollup: measurement.rollup as unknown as Record<string, unknown> | null,
        };
      } catch {
        return null;
      }
    },
    async attachObservationToMeasurement(execution, _actorPersonId, measurementId, observationId) {
      return toMeasurementView(
        await measuredOutcomeService.attachObservation(execution, measurementId, observationId),
      );
    },
    async attachAttributionToMeasurement(execution, _actorPersonId, measurementId, attributionId) {
      return toMeasurementView(
        await measuredOutcomeService.attachAttribution(execution, measurementId, attributionId),
      );
    },
    async attachBaselineToMeasurement(execution, _actorPersonId, measurementId, baselineId) {
      return toMeasurementView(
        await measuredOutcomeService.attachBaseline(execution, measurementId, baselineId),
      );
    },
    async attachIncrementalityToMeasurement(execution, _actorPersonId, measurementId, incrementalityId) {
      return toMeasurementView(
        await measuredOutcomeService.attachIncrementality(execution, measurementId, incrementalityId),
      );
    },
    async recordMeasurementRollup(execution, _actorPersonId, measurementId) {
      const measurement = await measuredOutcomeService.recordMeasurementRollup(
        execution,
        measurementId,
      );
      return {
        ...toMeasurementView(measurement),
        rollup: measurement.rollup as unknown as Record<string, unknown> | null,
      };
    },
    // -- NET-W007 reputation commands -----------------------------------
    async createReputationPolicy(execution, actorPersonId, input) {
      const policy = await reputationPolicyService.createPolicyVersion(execution, {
        organizationScopeId: input.organizationScopeId,
        policyId: input.policyId,
        version: input.version,
        ...(input.description !== undefined ? { description: input.description } : {}),
        rules: input.rules as unknown as CreateReputationScoringPolicyInput["rules"],
      });
      return toReputationPolicyView(policy);
    },
    async getReputationPolicy(execution, id) {
      try {
        const policy = await reputationPolicyService.getPolicy(
          getExecutionContext() ?? execution,
          id,
        );
        return toReputationPolicyView(policy);
      } catch {
        return null;
      }
    },
    async listReputationPolicyVersions(execution, policyId, organizationScopeId) {
      const versions = await reputationPolicyService.listPolicyVersions(
        getExecutionContext() ?? execution,
        policyId,
        organizationScopeId,
      );
      return versions.map(toReputationPolicyView);
    },
    async recordReputationInput(execution, _actorPersonId, input) {
      const result = await reputationInputService.recordInput(execution, {
        organizationScopeId: input.organizationScopeId,
        subjectPersonId: input.subjectPersonId,
        dimension: input.dimension,
        sources: input.sources as unknown as RecordReputationInputInput["sources"],
        ...(input.description !== undefined ? { description: input.description } : {}),
        occurredAt: input.occurredAt,
        idempotencyKey: input.idempotencyKey,
      });
      return { input: toReputationInputView(result.input), created: result.created };
    },
    async getReputationInput(execution, id) {
      try {
        const found = await reputationInputService.getInput(
          getExecutionContext() ?? execution,
          id,
        );
        return toReputationInputView(found);
      } catch {
        return null;
      }
    },
    async listReputationInputs(execution, organizationScopeId, subjectPersonId) {
      const inputs = await reputationInputService.listInputs(
        getExecutionContext() ?? execution,
        organizationScopeId,
        subjectPersonId,
      );
      return inputs.map(toReputationInputView);
    },
    async computeReputationScores(execution, input) {
      const result = await reputationSnapshotService.computeScores(execution, {
        organizationScopeId: input.organizationScopeId,
        subjectPersonId: input.subjectPersonId,
        policyId: input.policyId,
        ...(input.version !== undefined ? { version: input.version } : {}),
        referenceAt: input.referenceAt,
      });
      return toReputationScoresView(result);
    },
    async recordReputationSnapshot(execution, _actorPersonId, input) {
      const result = await reputationSnapshotService.recordSnapshot(execution, {
        organizationScopeId: input.organizationScopeId,
        subjectPersonId: input.subjectPersonId,
        policyId: input.policyId,
        ...(input.version !== undefined ? { version: input.version } : {}),
        referenceAt: input.referenceAt,
        idempotencyKey: input.idempotencyKey,
      });
      return { snapshot: toReputationSnapshotView(result.snapshot), created: result.created };
    },
    async getReputationSnapshot(execution, id) {
      try {
        const snapshot = await reputationSnapshotService.getSnapshot(
          getExecutionContext() ?? execution,
          id,
        );
        return toReputationSnapshotView(snapshot);
      } catch {
        return null;
      }
    },
    async getReputationSnapshotHistory(execution, organizationScopeId, subjectPersonId) {
      const history = await reputationSnapshotService.getSnapshotHistory(
        getExecutionContext() ?? execution,
        organizationScopeId,
        subjectPersonId,
      );
      return history.map(toReputationSnapshotView);
    },
    async getLatestReputationSnapshot(execution, organizationScopeId, subjectPersonId) {
      const latest = await reputationSnapshotService.getLatestSnapshot(
        getExecutionContext() ?? execution,
        organizationScopeId,
        subjectPersonId,
      );
      return latest ? toReputationSnapshotView(latest) : null;
    },

    // -- NET-W031 portable reputation proof commands --------------------

    async issueReputationProof(execution, _actorPersonId, input) {
      const result = await reputationProofService.issueProof(execution, {
        organizationScopeId: input.organizationScopeId,
        subjectPersonId: input.subjectPersonId,
        ...(input.snapshotId !== undefined ? { snapshotId: input.snapshotId } : {}),
        idempotencyKey: input.idempotencyKey,
      });
      return { proof: toApiReputationProofView(result.proof), created: result.created };
    },
    async getReputationProof(execution, id, input) {
      try {
        const proof = await reputationProofService.getProof(
          getExecutionContext() ?? execution,
          input.organizationScopeId,
          id,
        );
        return toApiReputationProofView(proof);
      } catch {
        // Cross-tenant + nonexistent are indistinguishable (no
        // existence oracle) — the route renders 404.
        return null;
      }
    },
    async verifyReputationProof(execution, id, input) {
      const verdict = await reputationProofService.verifyProof(
        getExecutionContext() ?? execution,
        {
          organizationScopeId: input.organizationScopeId,
          proofId: id,
          evaluatedAt: input.evaluatedAt,
        },
      );
      return {
        proofId: verdict.proofId,
        valid: verdict.valid,
        reason: verdict.reason,
        checks: verdict.checks.map((c) => ({
          check: c.check,
          subject: c.subject,
          passed: c.passed,
          reason: c.reason,
        })),
      };
    },
    async verifyPresentedReputationProof(execution, input) {
      const verdict = await reputationProofService.verifyPresentedProof(
        getExecutionContext() ?? execution,
        {
          presented: fromApiReputationProofView(input.proof),
          currentProof: fromApiReputationProofView(input.currentProof),
          evaluatedAt: input.evaluatedAt,
        },
      );
      return {
        proofId: verdict.proofId,
        valid: verdict.valid,
        reason: verdict.reason,
        checks: verdict.checks.map((c) => ({
          check: c.check,
          subject: c.subject,
          passed: c.passed,
          reason: c.reason,
        })),
      };
    },
    async revokeReputationProof(execution, _actorPersonId, id, input) {
      const proof = await reputationProofService.revokeProof(execution, {
        organizationScopeId: input.organizationScopeId,
        proofId: id,
        reason: input.reason,
        idempotencyKey: input.idempotencyKey,
      });
      return toApiReputationProofView(proof);
    },

    // -- NET-W008 settlement commands ------------------------------------

    async createEconomicValue(execution, input) {
      const result = await economicValueService.recordPendingValue(execution, {
        organizationScopeId: input.organizationScopeId,
        beneficiaryPersonId: input.beneficiaryPersonId,
        amount: input.amount,
        sources: input.sources as unknown as RecordPendingValueInput["sources"],
        maturation: input.maturation as unknown as
          | RecordPendingValueInput["maturation"]
          | undefined,
        ...(input.description !== undefined ? { description: input.description } : {}),
        idempotencyKey: input.idempotencyKey,
      });
      return { value: toEconomicValueView(result.value), created: result.created };
    },

    async getEconomicValue(execution, id) {
      try {
        const value = await economicValueService.getValue(
          getExecutionContext() ?? execution,
          id,
        );
        return toEconomicValueView(value);
      } catch {
        return null;
      }
    },

    async listEconomicValues(execution, organizationScopeId, beneficiaryPersonId, states) {
      const values = await economicValueService.listValues(
        getExecutionContext() ?? execution,
        organizationScopeId,
        beneficiaryPersonId,
        states,
      );
      return values.map(toEconomicValueView);
    },

    async matureEconomicValue(execution, input) {
      // NET-W009 economic gate (lock invariant 21): an ACTIVE risk
      // control (HOLD/BLOCK) on value_maturation covering this record,
      // its beneficiary OR any of its upstream SOURCE records
      // (NET-W014 extension: contribution-level controls now gate
      // value recognized from that contribution) refuses the
      // maturation. The composition root consults the risk control
      // registry BEFORE the settlement mutation — the settlement
      // domain code is untouched and the fraud boundary never
      // mutates economic state.
      const gated = await economicValueService.getValue(execution, input.valueRecordId);
      for (const riskSubjectId of [
        gated.id,
        ...gated.sources.map((s) => s.id),
      ]) {
        await refuseWhenGated(
          execution,
          gated.organizationScopeId,
          "value_maturation",
          riskSubjectId,
          gated.beneficiaryPersonId,
        );
      }
      // NET-W010 dispute gate (lock invariant 21, disputed half): an
      // ACTIVE dispute covering this record OR any of its upstream
      // sources refuses the maturation until the dispute resolves.
      await refuseWhenDisputed(execution, gated.organizationScopeId, [
        gated.id,
        ...gated.sources.map((s) => s.id),
      ]);
      const value = await economicValueService.matureValue(execution, {
        valueRecordId: input.valueRecordId,
        ...(input.effectiveAt !== undefined
          ? { effectiveAt: input.effectiveAt }
          : {}),
        idempotencyKey: input.idempotencyKey,
      });
      return toEconomicValueView(value);
    },

    async reverseEconomicValue(execution, input) {
      const value = await economicValueService.reverseValue(execution, {
        valueRecordId: input.valueRecordId,
        reason: input.reason,
        idempotencyKey: input.idempotencyKey,
      });
      return toEconomicValueView(value);
    },

    async issueCredits(execution, input) {
      // NET-W009 economic gate: an ACTIVE risk control on
      // credit_issuance covering the source record, the beneficiary
      // or any upstream SOURCE record (NET-W014 extension) refuses
      // the issuance.
      const gatedIssue = await economicValueService.getValue(
        execution,
        input.sourceValueRecordId,
      );
      for (const riskSubjectId of [
        gatedIssue.id,
        ...gatedIssue.sources.map((s) => s.id),
      ]) {
        await refuseWhenGated(
          execution,
          input.organizationScopeId,
          "credit_issuance",
          riskSubjectId,
          input.beneficiaryPersonId,
        );
      }
      // NET-W010 dispute gate: an ACTIVE dispute covering the source
      // record or its upstream sources refuses the consumption.
      const gatedValue = await economicValueService.getValue(
        execution,
        input.sourceValueRecordId,
      );
      await refuseWhenDisputed(execution, gatedValue.organizationScopeId, [
        gatedValue.id,
        ...gatedValue.sources.map((s) => s.id),
      ]);
      const result = await creditService.issueCredits(execution, {
        organizationScopeId: input.organizationScopeId,
        beneficiaryPersonId: input.beneficiaryPersonId,
        sourceValueRecordId: input.sourceValueRecordId,
        creditsPerValueUnit: input.creditsPerValueUnit,
        ...(input.description !== undefined ? { description: input.description } : {}),
        idempotencyKey: input.idempotencyKey,
      });
      return {
        issuance: toCreditIssuanceView(result.issuance),
        created: result.created,
      };
    },

    async getCreditIssuance(execution, id) {
      try {
        const issuance = await creditService.getIssuance(
          getExecutionContext() ?? execution,
          id,
        );
        return toCreditIssuanceView(issuance);
      } catch {
        return null;
      }
    },

    async listCreditIssuances(execution, organizationScopeId, beneficiaryPersonId) {
      const issuances = await creditService.listIssuances(
        getExecutionContext() ?? execution,
        organizationScopeId,
        beneficiaryPersonId,
      );
      return issuances.map(toCreditIssuanceView);
    },

    async reverseCreditIssuance(execution, input) {
      const issuance = await creditService.reverseIssuance(execution, {
        issuanceId: input.issuanceId,
        reason: input.reason,
        idempotencyKey: input.idempotencyKey,
      });
      return toCreditIssuanceView(issuance);
    },

    async createRewardPolicy(execution, input) {
      const policy = await rewardPolicyService.createPolicyVersion(execution, {
        organizationScopeId: input.organizationScopeId,
        policyId: input.policyId,
        version: input.version,
        ...(input.description !== undefined ? { description: input.description } : {}),
        allocations: input.allocations as unknown as CreateRewardPolicyInput["allocations"],
      });
      return toRewardPolicyView(policy);
    },

    async getRewardPolicy(execution, id) {
      try {
        const policy = await rewardPolicyService.getPolicy(
          getExecutionContext() ?? execution,
          id,
        );
        return toRewardPolicyView(policy);
      } catch {
        return null;
      }
    },

    async listRewardPolicyVersions(execution, policyId, organizationScopeId) {
      const versions = await rewardPolicyService.listPolicyVersions(
        getExecutionContext() ?? execution,
        policyId,
        organizationScopeId,
      );
      return versions.map(toRewardPolicyView);
    },

    async allocateRewards(execution, input) {
      // NET-W009 economic gate: an ACTIVE risk control on
      // reward_allocation covering the source record, its beneficiary
      // or any upstream SOURCE record (NET-W014 extension) refuses
      // the allocation.
      const gatedValue = await economicValueService.getValue(
        execution,
        input.sourceValueRecordId,
      );
      for (const riskSubjectId of [
        gatedValue.id,
        ...gatedValue.sources.map((s) => s.id),
      ]) {
        await refuseWhenGated(
          execution,
          input.organizationScopeId,
          "reward_allocation",
          riskSubjectId,
          gatedValue.beneficiaryPersonId,
        );
      }
      // NET-W010 dispute gate: an ACTIVE dispute covering the source
      // record or its upstream sources refuses the consumption.
      await refuseWhenDisputed(execution, gatedValue.organizationScopeId, [
        gatedValue.id,
        ...gatedValue.sources.map((s) => s.id),
      ]);
      const result = await rewardService.allocateRewards(execution, {
        organizationScopeId: input.organizationScopeId,
        sourceValueRecordId: input.sourceValueRecordId,
        policyId: input.policyId,
        ...(input.version !== undefined ? { version: input.version } : {}),
        idempotencyKey: input.idempotencyKey,
      });
      return {
        allocation: toRewardAllocationView(result.allocation),
        created: result.created,
      };
    },

    async getRewardAllocation(execution, id) {
      try {
        const allocation = await rewardService.getAllocation(
          getExecutionContext() ?? execution,
          id,
        );
        return toRewardAllocationView(allocation);
      } catch {
        return null;
      }
    },

    async listRewardAllocations(execution, organizationScopeId) {
      const allocations = await rewardService.listAllocations(
        getExecutionContext() ?? execution,
        organizationScopeId,
      );
      return allocations.map(toRewardAllocationView);
    },

    async reverseRewardAllocation(execution, input) {
      const allocation = await rewardService.reverseAllocation(execution, {
        allocationId: input.allocationId,
        reason: input.reason,
        idempotencyKey: input.idempotencyKey,
      });
      return toRewardAllocationView(allocation);
    },

    async recordCashObligation(execution, input) {
      const result = await cashService.recordCashObligation(execution, {
        organizationScopeId: input.organizationScopeId,
        kind: input.kind,
        counterpartyPersonId: input.counterpartyPersonId,
        amount: input.amount,
        ...(input.description !== undefined ? { description: input.description } : {}),
        idempotencyKey: input.idempotencyKey,
      });
      return {
        obligation: toCashObligationView(result.obligation),
        created: result.created,
      };
    },

    async getCashObligation(execution, id) {
      try {
        const obligation = await cashService.getObligation(
          getExecutionContext() ?? execution,
          id,
        );
        return toCashObligationView(obligation);
      } catch {
        return null;
      }
    },

    async listCashObligations(execution, organizationScopeId) {
      const obligations = await cashService.listObligations(
        getExecutionContext() ?? execution,
        organizationScopeId,
      );
      return obligations.map(toCashObligationView);
    },

    async settleCashObligation(execution, input) {
      // NET-W009 economic gate: an ACTIVE risk control on
      // cash_settlement covering the obligation or its counterparty
      // refuses the settlement.
      const gatedObligation = await cashService.getObligation(
        execution,
        input.obligationId,
      );
      await refuseWhenGated(
        execution,
        gatedObligation.organizationScopeId,
        "cash_settlement",
        gatedObligation.id,
        gatedObligation.counterpartyPersonId,
      );
      const obligation = await cashService.settleCashObligation(execution, {
        obligationId: input.obligationId,
        ...(input.reference !== undefined ? { reference: input.reference } : {}),
        idempotencyKey: input.idempotencyKey,
      });
      return toCashObligationView(obligation);
    },

    async reverseCashObligation(execution, input) {
      const obligation = await cashService.reverseCashObligation(execution, {
        obligationId: input.obligationId,
        reason: input.reason,
        idempotencyKey: input.idempotencyKey,
      });
      return toCashObligationView(obligation);
    },

    async recordConversion(execution, input) {
      const result = await conversionService.recordConversion(execution, {
        organizationScopeId: input.organizationScopeId,
        personId: input.personId,
        direction: input.direction,
        cashAmount: input.cashAmount,
        creditsAmount: input.creditsAmount,
        ...(input.description !== undefined ? { description: input.description } : {}),
        idempotencyKey: input.idempotencyKey,
      });
      return {
        conversion: toConversionView(result.conversion),
        created: result.created,
      };
    },

    async getConversion(execution, id) {
      try {
        const conversion = await conversionService.getConversion(
          getExecutionContext() ?? execution,
          id,
        );
        return toConversionView(conversion);
      } catch {
        return null;
      }
    },

    async listConversions(execution, organizationScopeId) {
      const conversions = await conversionService.listConversions(
        getExecutionContext() ?? execution,
        organizationScopeId,
      );
      return conversions.map(toConversionView);
    },

    async reverseConversion(execution, input) {
      const conversion = await conversionService.reverseConversion(execution, {
        conversionId: input.conversionId,
        reason: input.reason,
        idempotencyKey: input.idempotencyKey,
      });
      return toConversionView(conversion);
    },

    async getLedgerTransaction(execution, id) {
      try {
        const transaction = await economicLedgerService.getTransaction(
          getExecutionContext() ?? execution,
          id,
        );
        return toLedgerTransactionView(transaction);
      } catch {
        return null;
      }
    },

    async listLedgerTransactionsBySubject(execution, subjectKind, subjectId) {
      const kind = subjectKind as
        import("../settlement/port.ts").EconomicLedgerSubjectRef["kind"];
      const transactions = await economicLedgerService.listTransactionsBySubject(
        getExecutionContext() ?? execution,
        { kind, id: subjectId },
      );
      return transactions.map(toLedgerTransactionView);
    },

    async listLedgerAccountBalances(execution, organizationScopeId) {
      const balances = await economicLedgerService.listAccountBalances(
        getExecutionContext() ?? execution,
        organizationScopeId,
      );
      return balances.map((balance) => ({
        accountId: balance.accountId,
        organizationScopeId: balance.organizationScopeId,
        ownerPersonId: balance.ownerPersonId,
        kind: balance.kind,
        unit: balance.unit,
        balance: balance.balance,
      }));
    },

    async getParticipantEconomicSummary(execution, organizationScopeId, personId) {
      const summary = await economicLedgerService.getParticipantSummary(
        getExecutionContext() ?? execution,
        organizationScopeId,
        personId,
      );
      return {
        organizationScopeId: summary.organizationScopeId,
        personId: summary.personId,
        pendingValue: summary.pendingValue,
        matureValue: summary.matureValue,
        credits: summary.credits,
        rewards: summary.rewards,
        cashPayable: summary.cashPayable,
        cashReceivable: summary.cashReceivable,
      };
    },

    // -- NET-W009 fraud/risk commands -------------------------------------

    async createRiskSignal(execution, _actorPersonId, input) {
      const result = await riskSignalService.createSignal(execution, {
        organizationScopeId: input.organizationScopeId as string,
        subjectPersonId: input.subjectPersonId as string,
        ...(input.subjectRef !== undefined
          ? {
              subjectRef: input.subjectRef as unknown as CreateRiskSignalInput["subjectRef"],
            }
          : {}),
        category: input.category as string,
        severity: input.severity as string,
        confidence: input.confidence as number,
        provenance: input.provenance as unknown as CreateRiskSignalInput["provenance"],
        ...(input.description !== undefined ? { description: input.description as string } : {}),
        detectedAt: input.detectedAt as string,
        idempotencyKey: input.idempotencyKey as string,
      });
      return { signal: toRiskSignalView(result.signal), created: result.created };
    },

    async supersedeRiskSignal(execution, _actorPersonId, input) {
      const result = await riskSignalService.supersedeSignal(execution, {
        signalId: input.signalId as string,
        category: input.category as string,
        severity: input.severity as string,
        confidence: input.confidence as number,
        provenance: input.provenance as unknown as SupersedeRiskSignalInput["provenance"],
        ...(input.description !== undefined ? { description: input.description as string } : {}),
        detectedAt: input.detectedAt as string,
        idempotencyKey: input.idempotencyKey as string,
      });
      return toRiskSignalView(result.correction);
    },

    async getRiskSignal(execution, id) {
      try {
        const signal = await riskSignalService.getSignal(
          getExecutionContext() ?? execution,
          id,
        );
        return toRiskSignalView(signal);
      } catch {
        return null;
      }
    },

    async listRiskSignals(execution, organizationScopeId, subjectPersonId) {
      const signals = await riskSignalService.listSignals(
        getExecutionContext() ?? execution,
        organizationScopeId,
        subjectPersonId,
      );
      return signals.map(toRiskSignalView);
    },

    async createRiskPolicy(execution, _actorPersonId, input) {
      const policy = await riskPolicyService.createPolicyVersion(execution, {
        organizationScopeId: input.organizationScopeId as string,
        policyId: input.policyId as string,
        version: input.version as number,
        ...(input.description !== undefined ? { description: input.description as string } : {}),
        rules: input.rules as unknown as CreateRiskPolicyInput["rules"],
        thresholds: input.thresholds as unknown as CreateRiskPolicyInput["thresholds"],
        criticalFloorState: input.criticalFloorState as string,
        advisoryOnlyCapState: input.advisoryOnlyCapState as string,
        requiredCategories: input.requiredCategories as readonly string[],
        missingDataState: input.missingDataState as string,
      });
      return toRiskPolicyView(policy);
    },

    async listRiskPolicyVersions(execution, policyId, organizationScopeId) {
      const versions = await riskPolicyService.listPolicyVersions(
        getExecutionContext() ?? execution,
        policyId,
        organizationScopeId,
      );
      return versions.map(toRiskPolicyView);
    },

    async recordRiskAssessment(execution, _actorPersonId, input) {
      const result = await riskAssessmentService.recordAssessment(execution, {
        organizationScopeId: input.organizationScopeId as string,
        subjectPersonId: input.subjectPersonId as string,
        ...(input.subjectRef !== undefined
          ? {
              subjectRef: input.subjectRef as unknown as RecordRiskAssessmentInput["subjectRef"],
            }
          : {}),
        policyId: input.policyId as string,
        ...(input.version !== undefined ? { version: input.version as number } : {}),
        evaluatedAt: input.evaluatedAt as string,
        idempotencyKey: input.idempotencyKey as string,
      });
      return { assessment: toRiskAssessmentView(result.assessment), created: result.created };
    },

    async previewRiskAssessment(execution, input) {
      const preview = await riskAssessmentService.previewAssessment(execution, {
        organizationScopeId: input.organizationScopeId as string,
        subjectPersonId: input.subjectPersonId as string,
        ...(input.subjectRef !== undefined
          ? {
              subjectRef: input.subjectRef as unknown as RecordRiskAssessmentInput["subjectRef"],
            }
          : {}),
        policyId: input.policyId as string,
        ...(input.version !== undefined ? { version: input.version as number } : {}),
        evaluatedAt: input.evaluatedAt as string,
      });
      return {
        organizationScopeId: preview.organizationScopeId,
        subjectPersonId: preview.subjectPersonId,
        subjectRef: preview.subjectRef,
        policyId: preview.policyId,
        policyVersion: preview.policyVersion,
        evaluatedAt: preview.evaluatedAt,
        signalIds: preview.signalIds,
        contributions: preview.contributions as unknown as readonly Record<string, unknown>[],
        score: preview.score,
        state: preview.state,
        missingCategories: preview.missingCategories,
        digest: preview.digest,
      };
    },

    async getRiskAssessment(execution, id) {
      try {
        const assessment = await riskAssessmentService.getAssessment(
          getExecutionContext() ?? execution,
          id,
        );
        return toRiskAssessmentView(assessment);
      } catch {
        return null;
      }
    },

    async listRiskAssessments(execution, organizationScopeId, subjectPersonId) {
      const history = await riskAssessmentService.getAssessmentHistory(
        getExecutionContext() ?? execution,
        organizationScopeId,
        subjectPersonId,
      );
      return history.map(toRiskAssessmentView);
    },

    async openRiskCase(execution, _actorPersonId, input) {
      const result = await riskCaseService.openCase(execution, {
        organizationScopeId: input.organizationScopeId as string,
        ...(input.subjectPersonId !== undefined
          ? { subjectPersonId: input.subjectPersonId as string }
          : {}),
        ...(input.subjectRef !== undefined
          ? { subjectRef: input.subjectRef as unknown as OpenRiskCaseInput["subjectRef"] }
          : {}),
        title: input.title as string,
        ...(input.description !== undefined ? { description: input.description as string } : {}),
        reasonCodes: input.reasonCodes as readonly string[],
        sourceRefs: input.sourceRefs as unknown as OpenRiskCaseInput["sourceRefs"],
        idempotencyKey: input.idempotencyKey as string,
      });
      return { riskCase: toRiskCaseView(result.riskCase), created: result.created };
    },

    async recordRiskCaseDecision(execution, _actorPersonId, input) {
      const riskCase = await riskCaseService.recordDecision(execution, {
        caseId: input.caseId as string,
        decision: input.decision as string,
        reasonCodes: input.reasonCodes as readonly string[],
        ...(input.note !== undefined ? { note: input.note as string } : {}),
        sourceRefs: input.sourceRefs as unknown as RecordRiskCaseDecisionInput["sourceRefs"],
        idempotencyKey: input.idempotencyKey as string,
      });
      return toRiskCaseView(riskCase);
    },

    async getRiskCase(execution, id) {
      try {
        const riskCase = await riskCaseService.getCase(
          getExecutionContext() ?? execution,
          id,
        );
        return toRiskCaseView(riskCase);
      } catch {
        return null;
      }
    },

    async listRiskCases(execution, organizationScopeId, states) {
      const cases = await riskCaseService.listCases(
        getExecutionContext() ?? execution,
        organizationScopeId,
        states,
      );
      return cases.map(toRiskCaseView);
    },

    async activateRiskControl(execution, _actorPersonId, input) {
      const result = await riskControlService.activateControl(execution, {
        organizationScopeId: input.organizationScopeId as string,
        operationClass: input.operationClass as string,
        action: input.action as string,
        ...(input.subjectPersonId !== undefined
          ? { subjectPersonId: input.subjectPersonId as string }
          : {}),
        ...(input.subjectRef !== undefined
          ? { subjectRef: input.subjectRef as unknown as ActivateRiskControlInput["subjectRef"] }
          : {}),
        ...(input.originAssessmentId !== undefined
          ? { originAssessmentId: input.originAssessmentId as string }
          : {}),
        ...(input.originCaseId !== undefined
          ? { originCaseId: input.originCaseId as string }
          : {}),
        reasonCodes: input.reasonCodes as readonly string[],
        ...(input.description !== undefined ? { description: input.description as string } : {}),
        idempotencyKey: input.idempotencyKey as string,
      });
      return { control: toRiskControlView(result.control), created: result.created };
    },

    async resolveRiskControl(execution, _actorPersonId, input) {
      const control = await riskControlService.resolveControl(execution, {
        controlDecisionId: input.controlDecisionId as string,
        ...(input.caseDecisionId !== undefined
          ? { caseDecisionId: input.caseDecisionId as string }
          : {}),
        ...(input.note !== undefined ? { note: input.note as string } : {}),
        idempotencyKey: input.idempotencyKey as string,
      });
      return toRiskControlView(control);
    },

    async getRiskControl(execution, id) {
      try {
        const control = await riskControlService.getControl(
          getExecutionContext() ?? execution,
          id,
        );
        return toRiskControlView(control);
      } catch {
        return null;
      }
    },

    async listRiskControls(execution, organizationScopeId, states) {
      const controls = await riskControlService.listControls(
        getExecutionContext() ?? execution,
        organizationScopeId,
        states,
      );
      return controls.map(toRiskControlView);
    },

    async getRiskSubjectSummary(execution, organizationScopeId, subjectPersonId) {
      const [latest, signals, controls, cases] = await Promise.all([
        riskAssessmentService.getLatestAssessment(
          getExecutionContext() ?? execution,
          organizationScopeId,
          subjectPersonId,
        ),
        riskSignalService.listSignals(
          getExecutionContext() ?? execution,
          organizationScopeId,
          subjectPersonId,
        ),
        riskControlService.listControls(
          getExecutionContext() ?? execution,
          organizationScopeId,
        ),
        riskCaseService.listCases(
          getExecutionContext() ?? execution,
          organizationScopeId,
        ),
      ]);
      return {
        organizationScopeId,
        subjectPersonId,
        latestAssessment: latest ? toRiskAssessmentView(latest) : null,
        activeControls: controls
          .filter(
            (c) =>
              c.state === "ACTIVE" &&
              (c.subjectPersonId === subjectPersonId ||
                (c.subjectRef !== null && c.subjectRef.subjectId === subjectPersonId)),
          )
          .map(toRiskControlView),
        openCases: cases
          .filter(
            (c) =>
              c.state !== "RESOLVED" &&
              (c.subjectPersonId === subjectPersonId ||
                (c.subjectRef !== null && c.subjectRef.subjectId === subjectPersonId)),
          )
          .map(toRiskCaseView),
        signalCount: signals.length,
      };
    },

    async applyWorkflowHold(execution, actorPersonId, input) {
      // NET-W009 §3.7 WORKFLOW GATE: the composition root requests the
      // FRAUD_REVIEW transition THROUGH the workflow service (the
      // sole lifecycle authority) for a contribution, and records the
      // control that motivated it. The risk domain never mutates
      // lifecycle state itself.
      const contributionId = input.contributionId as string;
      const originCaseId = input.originCaseId as string | undefined;
      const originAssessmentId = input.originAssessmentId as string | undefined;
      const idempotencyKey = input.idempotencyKey as string;
      const contribution = await contributionService.getContribution(
        execution,
        contributionId,
      );
      // 1. The control FIRST (evidence-backed origin required): an
      //    ACTIVE workflow_transition HOLD covering the contribution.
      const control = await riskControlService.activateControl(execution, {
        organizationScopeId: contribution.organizationScopeId,
        operationClass: "workflow_transition",
        action: "HOLD",
        subjectPersonId: contribution.contributorId,
        subjectRef: { subjectType: "contribution", subjectId: contributionId },
        ...(originAssessmentId !== undefined ? { originAssessmentId } : {}),
        ...(originCaseId !== undefined ? { originCaseId } : {}),
        reasonCodes: (input.reasonCodes as readonly string[]) ?? ["workflow_hold"],
        ...(input.description !== undefined
          ? { description: input.description as string }
          : {}),
        idempotencyKey: `${idempotencyKey}:control`,
      });
      // 2. The authorized transition THROUGH the workflow service.
      const { policyActionFor } = await import("../core/workflow.ts");
      const transition = await workflowService.requestTransition(
        {
          subjectId: contributionId,
          subjectKind: "contribution",
          targetState: "FRAUD_REVIEW",
          expectedVersion: contribution.version,
          idempotencyKey: `${idempotencyKey}:transition`,
          actorPersonId,
          policyAction: policyActionFor(
            "contribution",
            contribution.state as import("../core/workflow.ts").LifecycleState,
            "FRAUD_REVIEW",
          ),
          metadata: {
            riskControlDecisionId: control.control.id,
            ...(originCaseId !== undefined ? { originCaseId } : {}),
            ...(originAssessmentId !== undefined ? { originAssessmentId } : {}),
          },
        },
        execution,
      );
      return {
        control: toRiskControlView(control.control),
        transition: {
          subjectId: transition.subject.id,
          subjectKind: transition.subject.kind,
          state: transition.subject.state,
          version: transition.subject.version,
          executed: transition.executed,
          transitionId: transition.transitionId,
          transactionId: transition.transactionId,
        },
      };
    },

    async clearWorkflowHold(execution, actorPersonId, input) {
      // Clear the workflow hold: resolve the active control and
      // request the cleared return transition (FRAUD_REVIEW →
      // SUBMITTED) through the workflow service.
      const contributionId = input.contributionId as string;
      const controlDecisionId = input.controlDecisionId as string;
      const idempotencyKey = input.idempotencyKey as string;
      const contribution = await contributionService.getContribution(
        execution,
        contributionId,
      );
      const control = await riskControlService.resolveControl(execution, {
        controlDecisionId,
        ...(input.note !== undefined ? { note: input.note as string } : {}),
        idempotencyKey: `${idempotencyKey}:resolve`,
      });
      const { policyActionFor } = await import("../core/workflow.ts");
      const transition = await workflowService.requestTransition(
        {
          subjectId: contributionId,
          subjectKind: "contribution",
          targetState: "SUBMITTED",
          expectedVersion: contribution.version,
          idempotencyKey: `${idempotencyKey}:transition`,
          actorPersonId,
          policyAction: policyActionFor(
            "contribution",
            contribution.state as import("../core/workflow.ts").LifecycleState,
            "SUBMITTED",
          ),
          metadata: {
            riskControlDecisionId: controlDecisionId,
            cleared: true,
          },
        },
        execution,
      );
      return {
        control: toRiskControlView(control),
        transition: {
          subjectId: transition.subject.id,
          subjectKind: transition.subject.kind,
          state: transition.subject.state,
          version: transition.subject.version,
          executed: transition.executed,
          transitionId: transition.transitionId,
          transactionId: transition.transactionId,
        },
      };
    },

    // -- NET-W010 dispute commands ---------------------------------------
    //
    // COMPOSITION-ROOT ORCHESTRATION (the authority-separation
    // pattern): the dispute domain records decisions; the settlement
    // authority moves the stake; the composition root sequences them
    // with COMPOUND idempotency keys (`${key}:stake`, `${key}:bond`,
    // …) so a retried composite replays each step idempotently (the
    // NET-W009 applyWorkflowHold precedent). The /disputes domain
    // code never calls /settlement.

    async openDispute(execution, _actorPersonId, input) {
      const result = await disputeService.openDispute(execution, {
        organizationScopeId: input.organizationScopeId as string,
        subjectRef: input.subjectRef as unknown as OpenDisputeInput["subjectRef"],
        statement: input.statement as string,
        reasonCodes: input.reasonCodes as readonly string[],
        supportingRefs:
          input.supportingRefs as unknown as OpenDisputeInput["supportingRefs"],
        effectiveAt: input.effectiveAt as string,
        idempotencyKey: input.idempotencyKey as string,
      });
      return { dispute: toDisputeView(result.dispute), created: result.created };
    },

    async bondDisputeStake(execution, actorPersonId, input) {
      // 1. Verify the dispute is bondable by this actor (the dispute
      //    service re-verifies everything in-transaction).
      const dispute = await disputeService.getDispute(
        execution,
        input.disputeId as string,
      );
      // 2. THE STAKE through the settlement authority (the economic
      //    authority — never the disputes domain).
      const staked = await stakeService.commitStake(execution, {
        organizationScopeId: dispute.organizationScopeId,
        ownerPersonId: dispute.challengerPersonId,
        amount: dispute.stake.requirement.amount,
        purpose: { kind: "dispute_challenge", id: dispute.id },
        description: `challenge stake for dispute ${dispute.id}`,
        idempotencyKey: `${input.idempotencyKey}:stake`,
      });
      // 3. Bond it to the dispute (verifies owner/amount/state/purpose
      //    linkage + the window through the read-only stake lookup).
      const bonded = await disputeService.bondStake(execution, {
        disputeId: dispute.id,
        stakeId: staked.stake.id,
        idempotencyKey: `${input.idempotencyKey}:bond`,
      });
      void actorPersonId;
      return { dispute: toDisputeView(bonded), stake: toStakeView(staked.stake) };
    },

    async startDisputeReview(execution, _actorPersonId, input) {
      const updated = await disputeService.startReview(execution, {
        disputeId: input.disputeId as string,
        ...(input.reasonCodes !== undefined
          ? { reasonCodes: input.reasonCodes as readonly string[] }
          : {}),
        ...(input.note !== undefined ? { note: input.note as string } : {}),
        idempotencyKey: input.idempotencyKey as string,
      });
      return toDisputeView(updated);
    },

    async rejectDispute(execution, _actorPersonId, input) {
      // 1. The dispute decision (REJECTED — inadmissible; the stake
      //    disposition is deterministically RELEASE).
      const rejected = await disputeService.rejectDispute(execution, {
        disputeId: input.disputeId as string,
        reasonCodes: input.reasonCodes as readonly string[],
        ...(input.note !== undefined ? { note: input.note as string } : {}),
        sourceRefs:
          input.sourceRefs as unknown as RejectDisputeInput["sourceRefs"],
        idempotencyKey: input.idempotencyKey as string,
      });
      // 2. The economic consequence through the settlement authority
      //    (release the challenger's stake), then 3. record the
      //    outcome on the dispute (append-only bookkeeping).
      let dispute = rejected;
      let stakeView: ReturnType<typeof toStakeView> | null = null;
      if (rejected.stake.stakeId !== null) {
        const released = await stakeService.releaseStake(execution, {
          stakeId: rejected.stake.stakeId,
          reason: `dispute ${rejected.id} rejected (inadmissible)`,
          idempotencyKey: `${input.idempotencyKey}:release`,
        });
        dispute = await disputeService.markStakeOutcome(execution, {
          disputeId: rejected.id,
          disposition: "RELEASE",
          stakeId: released.id,
          transactionId: released.outcome?.transactionId ?? null,
          idempotencyKey: `${input.idempotencyKey}:record`,
        });
        stakeView = toStakeView(released);
      }
      return { dispute: toDisputeView(dispute), ...(stakeView !== null ? { stake: stakeView } : {}) };
    },

    async resolveDispute(execution, _actorPersonId, input) {
      // 1. The dispute decision on the merits (records the outcome,
      //    the control disposition and the DETERMINISTIC stake
      //    mapping — the reviewer cannot override it).
      const resolved = await disputeService.resolveDispute(execution, {
        disputeId: input.disputeId as string,
        outcome: input.outcome as string,
        controlDisposition: input.controlDisposition as string,
        reasonCodes: input.reasonCodes as readonly string[],
        ...(input.note !== undefined ? { note: input.note as string } : {}),
        sourceRefs:
          input.sourceRefs as unknown as ResolveDisputeInput["sourceRefs"],
        idempotencyKey: input.idempotencyKey as string,
      });
      // 2. The economic consequence through the settlement authority
      //    (release or forfeit per the deterministic mapping), then
      //    3. record the outcome on the dispute.
      let dispute = resolved;
      let stakeView: ReturnType<typeof toStakeView> | null = null;
      if (
        resolved.stake.stakeId !== null &&
        resolved.resolution !== null &&
        resolved.resolution.stakeDisposition !== "NONE"
      ) {
        const disposition = resolved.resolution.stakeDisposition;
        const stake =
          disposition === "FORFEIT"
            ? await stakeService.forfeitStake(execution, {
                stakeId: resolved.stake.stakeId,
                reason: `dispute ${resolved.id} resolved ${resolved.resolution.outcome} (challenge DENIED)`,
                idempotencyKey: `${input.idempotencyKey}:forfeit`,
              })
            : await stakeService.releaseStake(execution, {
                stakeId: resolved.stake.stakeId,
                reason: `dispute ${resolved.id} resolved ${resolved.resolution.outcome}`,
                idempotencyKey: `${input.idempotencyKey}:release`,
              });
        dispute = await disputeService.markStakeOutcome(execution, {
          disputeId: resolved.id,
          disposition,
          stakeId: stake.id,
          transactionId: stake.outcome?.transactionId ?? null,
          idempotencyKey: `${input.idempotencyKey}:record`,
        });
        stakeView = toStakeView(stake);
      }
      return { dispute: toDisputeView(dispute), ...(stakeView !== null ? { stake: stakeView } : {}) };
    },

    async appealDispute(execution, _actorPersonId, input) {
      const result = await disputeService.appealDispute(execution, {
        disputeId: input.disputeId as string,
        statement: input.statement as string,
        reasonCodes: input.reasonCodes as readonly string[],
        supportingRefs:
          input.supportingRefs as unknown as AppealDisputeInput["supportingRefs"],
        effectiveAt: input.effectiveAt as string,
        idempotencyKey: input.idempotencyKey as string,
      });
      return {
        original: toDisputeView(result.original),
        appeal: toDisputeView(result.appeal),
        created: result.created,
      };
    },

    async withdrawDispute(execution, _actorPersonId, input) {
      // 1. The challenger's withdrawal (stake disposition
      //    deterministically RELEASE when bonded).
      const withdrawn = await disputeService.withdrawDispute(execution, {
        disputeId: input.disputeId as string,
        ...(input.reason !== undefined ? { reason: input.reason as string } : {}),
        idempotencyKey: input.idempotencyKey as string,
      });
      // 2. Release the bonded stake through the settlement authority,
      //    then 3. record the outcome on the dispute.
      let dispute = withdrawn;
      let stakeView: ReturnType<typeof toStakeView> | null = null;
      if (withdrawn.stake.stakeId !== null) {
        const released = await stakeService.releaseStake(execution, {
          stakeId: withdrawn.stake.stakeId,
          reason: `dispute ${withdrawn.id} withdrawn by the challenger`,
          idempotencyKey: `${input.idempotencyKey}:release`,
        });
        dispute = await disputeService.markStakeOutcome(execution, {
          disputeId: withdrawn.id,
          disposition: "RELEASE",
          stakeId: released.id,
          transactionId: released.outcome?.transactionId ?? null,
          idempotencyKey: `${input.idempotencyKey}:record`,
        });
        stakeView = toStakeView(released);
      }
      return { dispute: toDisputeView(dispute), ...(stakeView !== null ? { stake: stakeView } : {}) };
    },

    async getDispute(execution, id) {
      try {
        const dispute = await disputeService.getDispute(
          getExecutionContext() ?? execution,
          id,
        );
        return toDisputeView(dispute);
      } catch {
        return null;
      }
    },

    async listDisputes(execution, organizationScopeId, states) {
      const disputes = await disputeService.listDisputes(
        getExecutionContext() ?? execution,
        organizationScopeId,
        states,
      );
      return disputes.map(toDisputeView);
    },

    async getStake(execution, id) {
      try {
        const stake = await stakeService.getStake(
          getExecutionContext() ?? execution,
          id,
        );
        return toStakeView(stake);
      } catch {
        return null;
      }
    },

    // -- NET-W011 campaign commands ---------------------------------------
    //
    // COMPOSITION-ROOT ORCHESTRATION (the authority-separation
    // pattern): the campaign domain owns policy/configuration
    // decisions; the SETTLEMENT authority escrows the budget (the
    // campaign_budget stake); the OPPORTUNITIES/WORKFLOWS authorities
    // own opportunity creation + lifecycle. The composition root
    // sequences them with COMPOUND idempotency keys (`${key}:stake`,
    // `${key}:record`, `${key}:opportunity`, …) so a retried
    // composite replays each step idempotently (the NET-W009/010
    // precedent). The /campaigns domain code never calls /settlement
    // or /opportunities.

    async createCampaign(execution, _actorPersonId, input) {
      const result = await campaignService.createCampaign(execution, {
        organizationScopeId: input.organizationScopeId as string,
        name: input.name as string,
        ...(input.description !== undefined
          ? { description: input.description as string }
          : {}),
        idempotencyKey: input.idempotencyKey as string,
      });
      return { campaign: toCampaignView(result.campaign), created: result.created };
    },

    async defineCampaignPolicy(execution, _actorPersonId, input) {
      const result = await campaignService.defineCampaignPolicy(execution, {
        campaignId: input.campaignId as string,
        policy: input.policy as unknown as CampaignPolicySections,
        idempotencyKey: input.idempotencyKey as string,
      });
      return {
        policy: toCampaignPolicyView(result.policy),
        created: result.created,
      };
    },

    async activateCampaign(execution, _actorPersonId, input) {
      const updated = await campaignService.activateCampaign(execution, {
        campaignId: input.campaignId as string,
        ...(input.reason !== undefined ? { reason: input.reason as string } : {}),
        idempotencyKey: input.idempotencyKey as string,
      });
      return toCampaignView(updated);
    },

    async pauseCampaign(execution, _actorPersonId, input) {
      const updated = await campaignService.pauseCampaign(execution, {
        campaignId: input.campaignId as string,
        ...(input.reason !== undefined ? { reason: input.reason as string } : {}),
        idempotencyKey: input.idempotencyKey as string,
      });
      return toCampaignView(updated);
    },

    async resumeCampaign(execution, _actorPersonId, input) {
      const updated = await campaignService.resumeCampaign(execution, {
        campaignId: input.campaignId as string,
        ...(input.reason !== undefined ? { reason: input.reason as string } : {}),
        idempotencyKey: input.idempotencyKey as string,
      });
      return toCampaignView(updated);
    },

    async completeCampaign(execution, _actorPersonId, input) {
      const updated = await campaignService.completeCampaign(execution, {
        campaignId: input.campaignId as string,
        ...(input.reason !== undefined ? { reason: input.reason as string } : {}),
        idempotencyKey: input.idempotencyKey as string,
      });
      return toCampaignView(updated);
    },

    async cancelCampaign(execution, _actorPersonId, input) {
      const updated = await campaignService.cancelCampaign(execution, {
        campaignId: input.campaignId as string,
        ...(input.reason !== undefined ? { reason: input.reason as string } : {}),
        idempotencyKey: input.idempotencyKey as string,
      });
      return toCampaignView(updated);
    },

    async commitCampaignBudget(execution, _actorPersonId, input) {
      // 1. Resolve the campaign + its current declared budget (the
      //    domain re-verifies everything in-transaction).
      const campaign = await campaignService.getCampaign(
        execution,
        input.campaignId as string,
      );
      const versions = await campaignService.listPolicyVersions(
        execution,
        campaign.id,
      );
      const policy = versions[versions.length - 1];
      if (policy === undefined || policy.budget.totalAmount <= 0) {
        const { OpenConError: CampaignError } = await import("../core/errors.ts");
        throw new CampaignError({
          code: "CAMPAIGN_VALIDATION",
          classification: "validation",
          message: `campaign ${campaign.id} declares no positive budget to commit`,
          context: { campaignId: campaign.id },
        });
      }
      // 2. THE ESCROW through the settlement authority (the economic
      //    authority — never the campaigns domain). One COMMITTED
      //    stake per purpose is enforced by the settlement boundary.
      const staked = await stakeService.commitStake(execution, {
        organizationScopeId: campaign.organizationScopeId,
        ownerPersonId: campaign.ownerPersonId,
        amount: policy.budget.totalAmount,
        purpose: { kind: "campaign_budget", id: campaign.id },
        description: `campaign budget escrow for campaign ${campaign.id}`,
        idempotencyKey: `${input.idempotencyKey}:stake`,
      });
      // 3. Record the commitment on the campaign (verifies
      //    owner/purpose/state/amount through the read-only stake
      //    lookup).
      const updated = await campaignService.recordBudgetCommitment(execution, {
        campaignId: campaign.id,
        stakeId: staked.stake.id,
        idempotencyKey: `${input.idempotencyKey}:record`,
      });
      return { campaign: toCampaignView(updated), stake: toStakeView(staked.stake) };
    },

    async releaseCampaignBudget(execution, _actorPersonId, input) {
      // 1. The campaign must be terminal with a recorded commitment.
      const campaign = await campaignService.getCampaign(
        execution,
        input.campaignId as string,
      );
      if (campaign.budget.stakeId === null) {
        const { OpenConError: CampaignError } = await import("../core/errors.ts");
        throw new CampaignError({
          code: "CAMPAIGN_VALIDATION",
          classification: "validation",
          message: `campaign ${campaign.id} carries no budget commitment to release`,
          context: { campaignId: campaign.id },
        });
      }
      // 2. The release through the settlement authority, then 3.
      //    record the outcome on the campaign (append-only
      //    bookkeeping).
      const released = await stakeService.releaseStake(execution, {
        stakeId: campaign.budget.stakeId,
        reason: `campaign ${campaign.id} ${campaign.status.toLowerCase()} — budget release`,
        idempotencyKey: `${input.idempotencyKey}:release`,
      });
      const updated = await campaignService.recordBudgetRelease(execution, {
        campaignId: campaign.id,
        stakeId: released.id,
        idempotencyKey: `${input.idempotencyKey}:record`,
      });
      return { campaign: toCampaignView(updated), stake: toStakeView(released) };
    },

    async publishCampaignOpportunity(execution, _actorPersonId, input) {
      // 1. Resolve the neutral publish draft (campaign ACTIVE + spec
      //    in the current policy version + the deterministic
      //    versioned eligibility reference).
      const draft = await campaignService.resolveOpportunityDraft(
        execution,
        input.campaignId as string,
        input.specId as string,
      );
      // 2. COMPOSE the real opportunity through the opportunities
      //    boundary (DRAFT, version 0 — every lifecycle transition
      //    stays with /workflows).
      const opportunity = await opportunityService.createOpportunity(
        execution,
        {
          organizationScopeId: draft.organizationScopeId,
          ownerId: (await campaignService.getCampaign(execution, draft.campaignId))
            .ownerPersonId,
          opportunityType: draft.opportunityType,
          title: draft.title,
          brief: draft.brief,
          eligibilityPolicyReference: draft.eligibilityPolicyReference,
          contributionRequirements: draft.contributionRequirements,
          evidenceReferencePlaceholders: draft.evidenceReferencePlaceholders,
        },
      );
      // 3. Record the publication (verifies the opportunity through
      //    the read-only lookup: scope, type, exact reference).
      const updated = await campaignService.recordOpportunityPublication(
        execution,
        {
          campaignId: draft.campaignId,
          specId: draft.specId,
          policyVersion: draft.policyVersion,
          opportunityId: opportunity.id,
          idempotencyKey: `${input.idempotencyKey}:record`,
        },
      );
      return {
        campaign: toCampaignView(updated),
        opportunity: {
          id: opportunity.id,
          organizationScopeId: opportunity.organizationScopeId,
          ownerId: opportunity.ownerId,
          opportunityType: opportunity.opportunityType,
          title: opportunity.title,
          state: opportunity.state,
          version: opportunity.version,
          createdAt: opportunity.createdAt,
        },
      };
    },

    async getCampaign(execution, id) {
      try {
        const campaign = await campaignService.getCampaign(
          getExecutionContext() ?? execution,
          id,
        );
        return toCampaignView(campaign);
      } catch {
        return null;
      }
    },

    async listCampaigns(execution, organizationScopeId, statuses) {
      const campaigns = await campaignService.listCampaigns(
        getExecutionContext() ?? execution,
        organizationScopeId,
        statuses,
      );
      return campaigns.map(toCampaignView);
    },

    async listCampaignPolicies(execution, campaignId) {
      const policies = await campaignService.listPolicyVersions(
        getExecutionContext() ?? execution,
        campaignId,
      );
      return policies.map(toCampaignPolicyView);
    },

    async listCampaignOpportunities(execution, campaignId) {
      return campaignService.listPublishedOpportunities(
        getExecutionContext() ?? execution,
        campaignId,
      );
    },

    // -- NET-W015 creator commands ---------------------------------------
    // Composition-root orchestration (the authority-separation
    // pattern): the /creators domain owns profile/policy decisions;
    // /identity validates the anchor (neutral lookup); /reputation
    // verifies every reference (neutral lookup — references only,
    // never scores, never mutation). No economic command exists
    // here; matching is NET-W016, UGC/rights NET-W017,
    // sponsorship/disclosure NET-W018.

    async createCreatorProfile(execution, _actorPersonId, input) {
      const result = await creatorService.createProfile(execution, {
        organizationScopeId: input.organizationScopeId as string,
        creatorPersonId: input.creatorPersonId as string,
        displayName: input.displayName as string,
        idempotencyKey: input.idempotencyKey as string,
      });
      return {
        profile: toCreatorProfileView(result.profile),
        created: result.created,
      };
    },

    async defineCreatorProfileVersion(execution, _actorPersonId, input) {
      const result = await creatorService.defineProfileVersion(execution, {
        profileId: input.profileId as string,
        sections: input.sections as unknown as CreatorProfileSections,
        idempotencyKey: input.idempotencyKey as string,
      });
      return {
        version: toCreatorProfileVersionView(result.version),
        created: result.created,
      };
    },

    async activateCreatorProfile(execution, _actorPersonId, input) {
      const updated = await creatorService.activateProfile(execution, {
        profileId: input.profileId as string,
        ...(input.reason !== undefined
          ? { reason: input.reason as string }
          : {}),
        idempotencyKey: input.idempotencyKey as string,
      });
      return toCreatorProfileView(updated);
    },

    async pauseCreatorProfile(execution, _actorPersonId, input) {
      const updated = await creatorService.pauseProfile(execution, {
        profileId: input.profileId as string,
        ...(input.reason !== undefined
          ? { reason: input.reason as string }
          : {}),
        idempotencyKey: input.idempotencyKey as string,
      });
      return toCreatorProfileView(updated);
    },

    async resumeCreatorProfile(execution, _actorPersonId, input) {
      const updated = await creatorService.resumeProfile(execution, {
        profileId: input.profileId as string,
        ...(input.reason !== undefined
          ? { reason: input.reason as string }
          : {}),
        idempotencyKey: input.idempotencyKey as string,
      });
      return toCreatorProfileView(updated);
    },

    async archiveCreatorProfile(execution, _actorPersonId, input) {
      const updated = await creatorService.archiveProfile(execution, {
        profileId: input.profileId as string,
        ...(input.reason !== undefined
          ? { reason: input.reason as string }
          : {}),
        idempotencyKey: input.idempotencyKey as string,
      });
      return toCreatorProfileView(updated);
    },

    async getCreatorProfile(execution, organizationScopeId, id) {
      try {
        const profile = await creatorService.getProfile(
          getExecutionContext() ?? execution,
          organizationScopeId,
          id,
        );
        return toCreatorProfileView(profile);
      } catch {
        // Not found — including the cross-scope case, which stays
        // indistinguishable from absence (tenant isolation, PR #30
        // review remediation).
        return null;
      }
    },

    async getCreatorProfileByPerson(
      execution,
      organizationScopeId,
      creatorPersonId,
    ) {
      const profile = await creatorService.getProfileByPerson(
        getExecutionContext() ?? execution,
        organizationScopeId,
        creatorPersonId,
      );
      return profile ? toCreatorProfileView(profile) : null;
    },

    async listCreatorProfiles(execution, organizationScopeId, statuses) {
      const profiles = await creatorService.listProfiles(
        getExecutionContext() ?? execution,
        organizationScopeId,
        statuses,
      );
      return profiles.map(toCreatorProfileView);
    },

    async listCreatorProfileVersions(execution, organizationScopeId, profileId) {
      const versions = await creatorService.listProfileVersions(
        getExecutionContext() ?? execution,
        organizationScopeId,
        profileId,
      );
      return versions.map(toCreatorProfileVersionView);
    },

    async resolveCreatorReputation(execution, organizationScopeId, profileId) {
      // The reference-resolution read (work order §3.4): the profile
      // record NEVER stores reputation scores — this read resolves
      // the CURRENT profile version's references through the
      // CANONICAL /reputation snapshot service at the composition
      // root. The creator boundary never computes a score. The read
      // is TENANT-SCOPED: the profile must resolve in the caller's
      // organization scope (a foreign scope cannot resolve another
      // tenant's creator reputation — PR #30 review remediation).
      const profile = await creatorService.getProfile(
        getExecutionContext() ?? execution,
        organizationScopeId,
        profileId,
      );
      if (profile.currentVersion === null) {
        return {
          profileId,
          currentVersion: null,
          references: [] as readonly Record<string, unknown>[],
        };
      }
      const version = await creatorService.getProfileVersion(
        getExecutionContext() ?? execution,
        organizationScopeId,
        profileId,
        profile.currentVersion,
      );
      const references: Record<string, unknown>[] = [];
      for (const reference of version.sections.reputationReferences) {
        const snapshot = await reputationSnapshotService.getSnapshot(
          getExecutionContext() ?? execution,
          reference.snapshotId,
        );
        references.push({
          role: reference.role,
          dimension: reference.dimension,
          snapshotId: reference.snapshotId,
          declaredDigest: reference.digest,
          resolvedDigest: snapshot.digest,
          digestMatches: snapshot.digest === reference.digest,
          computedAt: snapshot.computedAt,
          policyId: snapshot.policyId,
          policyVersion: snapshot.policyVersion,
          referenceAt: snapshot.referenceAt,
        });
      }
      return {
        profileId,
        currentVersion: profile.currentVersion,
        references,
      };
    },

    // -- NET-W016 creator-matching commands ------------------------------
    // Composition-root orchestration (the authority-separation
    // pattern): the /creators domain owns the matching rules
    // (deterministic eligibility + explicit-signal ranking); the
    // campaign/reputation/safety lookups are thin read-only adapters
    // over the OWNING domains; the advisory is the provider-neutral
    // LlmPort (AI-002 — advisory evidence only, never the
    // eligibility authority). Matching is SELECTION, not authority:
    // the only mutation is the append-only match-run record.

    async runCreatorMatch(execution, _actorPersonId, input) {
      const result = await creatorMatchingService.runMatch(
        execution,
        input as unknown as RunCreatorMatchInput,
      );
      return {
        run: toCreatorMatchRunView(result.run),
        created: result.created,
      };
    },

    async getCreatorMatchRun(execution, organizationScopeId, id) {
      const run = await creatorMatchingService.getMatchRun(
        getExecutionContext() ?? execution,
        organizationScopeId,
        id,
      );
      return toCreatorMatchRunView(run);
    },

    async listCreatorMatchRuns(execution, organizationScopeId, campaignId) {
      const runs = await creatorMatchingService.listMatchRuns(
        getExecutionContext() ?? execution,
        organizationScopeId,
        campaignId,
      );
      return runs.map(toCreatorMatchRunView);
    },

    // -- NET-W021 campaign matching commands ----------------------------
    // Selection, not authority: the run record + its audit event are
    // the only writes; every cross-domain read flows through the
    // neutral lookups wired above.

    async runCampaignMatch(execution, _actorPersonId, input) {
      const result = await campaignMatchingService.runCampaignMatch(
        execution,
        input as unknown as RunCampaignMatchInput,
      );
      return {
        run: toCampaignMatchRunView(result.run),
        created: result.created,
      };
    },

    async getCampaignMatchRun(execution, organizationScopeId, id) {
      const run = await campaignMatchingService.getMatchRun(
        getExecutionContext() ?? execution,
        organizationScopeId,
        id,
      );
      return toCampaignMatchRunView(run);
    },

    async listCampaignMatchRuns(execution, organizationScopeId, campaignId) {
      const runs = await campaignMatchingService.listMatchRuns(
        getExecutionContext() ?? execution,
        organizationScopeId,
        campaignId,
      );
      return runs.map(toCampaignMatchRunView);
    },

    // -- NET-W017 engagement/UGC commands --------------------------------
    // The engagement lifecycle is the canonical /workflows authority;
    // these commands compose domain records + workflow transitions.
    // NO economic/reputation/risk/outcome mutation, NO AI path.

    async createEngagement(execution, _actorPersonId, input) {
      const result = await creatorEngagementService.createEngagement(
        execution,
        input as unknown as import("../creators/port.ts").CreateEngagementInput,
      );
      return {
        engagement: toEngagementView(result.engagement),
        created: result.created,
      };
    },

    async createEngagementsFromMatch(execution, _actorPersonId, input) {
      const result = await creatorEngagementService.createEngagementsFromMatch(
        execution,
        input as unknown as import("../creators/port.ts").CreateEngagementsFromMatchInput,
      );
      // RUNNING/ABORTED batches expose the LIVE journal (accurate
      // partial execution) — read it for the view.
      const journal =
        result.batch.status === "COMPLETED"
          ? []
          : await engagementBatchRepo.listOutcomes(result.batch.id);
      return {
        batch: toEngagementBatchView(result.batch, journal),
        created: result.created,
      };
    },

    async acceptEngagement(execution, _actorPersonId, input) {
      const result = await creatorEngagementService.acceptEngagement(
        execution,
        input as unknown as import("../creators/port.ts").AcceptEngagementInput,
      );
      return {
        engagement: toEngagementView(result.engagement),
        grant: toUsageRightsView({
          grant: result.grant,
          revocation: null,
          effectiveStatus: "ACTIVE",
          viewedAsOf: result.grant.createdAt,
        }).grant,
        transition: {
          executed: result.transition.executed,
          transitionId: result.transition.transitionId,
          auditEventName: result.transition.auditEventName,
          transactionId: result.transition.transactionId,
          fromState: "READY",
          toState: "ASSIGNED",
        },
      };
    },

    async autoAcceptEngagement(execution, _actorPersonId, input) {
      const result = await creatorEngagementService.autoAcceptEngagement(
        execution,
        input as unknown as import("../creators/port.ts").AutoAcceptEngagementInput,
      );
      return {
        accepted: result.accepted,
        evaluation: result.evaluation,
        engagement: toEngagementView(result.engagement),
        grant: result.grant
          ? toUsageRightsView({
              grant: result.grant,
              revocation: null,
              effectiveStatus: "ACTIVE",
              viewedAsOf: result.grant.createdAt,
            }).grant
          : null,
        transition: result.transition
          ? {
              executed: result.transition.executed,
              transitionId: result.transition.transitionId,
              auditEventName: result.transition.auditEventName,
              transactionId: result.transition.transactionId,
              fromState: "READY",
              toState: "ASSIGNED",
            }
          : null,
      };
    },

    async revokeUsageRights(execution, _actorPersonId, input) {
      const result = await creatorEngagementService.revokeUsageRights(
        execution,
        input as unknown as import("../creators/port.ts").RevokeUsageRightsInput,
      );
      return {
        ...toUsageRightsView(result.view),
        created: result.created,
      };
    },

    async setCreatorAcceptancePolicy(execution, _actorPersonId, input) {
      const result = await creatorEngagementService.setAcceptancePolicy(
        execution,
        input as unknown as import("../creators/port.ts").SetAcceptancePolicyInput,
      );
      return {
        policy: toAcceptancePolicyView(result.policy),
        created: result.created,
      };
    },

    async openUgcProduction(execution, _actorPersonId, input) {
      const result = await creatorEngagementService.openProduction(
        execution,
        input as unknown as import("../creators/port.ts").OpenProductionInput,
      );
      return {
        production: toUgcProductionView(result.production),
        transition: {
          executed: result.transition.executed,
          transitionId: result.transition.transitionId,
          auditEventName: result.transition.auditEventName,
          transactionId: result.transition.transactionId,
          fromState: "ASSIGNED",
          toState: "IN_PROGRESS",
        },
      };
    },

    async recordUgcDeliverable(execution, _actorPersonId, input) {
      const result = await creatorEngagementService.recordDeliverable(
        execution,
        input as unknown as import("../creators/port.ts").RecordDeliverableInput,
      );
      return {
        deliverable: toUgcDeliverableView(result.deliverable),
        created: result.created,
      };
    },

    async submitUgcProduction(execution, _actorPersonId, input) {
      const result = await creatorEngagementService.submitProduction(
        execution,
        input as unknown as import("../creators/port.ts").SubmitProductionInput,
      );
      return {
        submission: toUgcSubmissionView(result.submission),
        transition: {
          executed: result.transition.executed,
          transitionId: result.transition.transitionId,
          auditEventName: result.transition.auditEventName,
          transactionId: result.transition.transactionId,
          fromState: "IN_PROGRESS",
          toState: "SUBMITTED",
        },
      };
    },

    async getEngagement(execution, organizationScopeId, id) {
      const engagement = await creatorEngagementService.getEngagement(
        getExecutionContext() ?? execution,
        organizationScopeId,
        id,
      );
      return toEngagementView(engagement);
    },

    async listEngagements(execution, organizationScopeId, campaignId, creatorPersonId) {
      const engagements = await creatorEngagementService.listEngagements(
        getExecutionContext() ?? execution,
        organizationScopeId,
        campaignId !== undefined || creatorPersonId !== undefined
          ? {
              ...(campaignId !== undefined ? { campaignId } : {}),
              ...(creatorPersonId !== undefined ? { creatorPersonId } : {}),
            }
          : undefined,
      );
      return engagements.map(toEngagementView);
    },

    async getCreatorAcceptancePolicy(execution, organizationScopeId, creatorPersonId) {
      const policy = await creatorEngagementService.getAcceptancePolicy(
        getExecutionContext() ?? execution,
        organizationScopeId,
        creatorPersonId,
      );
      return policy ? toAcceptancePolicyView(policy) : null;
    },

    async getUsageRights(execution, organizationScopeId, grantId, asOf) {
      const view = await creatorEngagementService.getUsageRights(
        getExecutionContext() ?? execution,
        organizationScopeId,
        grantId,
        asOf ?? null,
      );
      return toUsageRightsView(view);
    },

    async listUsageRights(execution, organizationScopeId, engagementId) {
      const views = await creatorEngagementService.listUsageRights(
        getExecutionContext() ?? execution,
        organizationScopeId,
        engagementId,
      );
      return views.map(toUsageRightsView);
    },

    async getUgcProduction(execution, organizationScopeId, id) {
      const production = await creatorEngagementService.getProduction(
        getExecutionContext() ?? execution,
        organizationScopeId,
        id,
      );
      return toUgcProductionView(production);
    },

    async listUgcProductions(execution, organizationScopeId, engagementId) {
      const productions = await creatorEngagementService.listProductions(
        getExecutionContext() ?? execution,
        organizationScopeId,
        engagementId,
      );
      return productions.map(toUgcProductionView);
    },

    async listUgcDeliverables(execution, organizationScopeId, productionId) {
      const deliverables = await creatorEngagementService.listDeliverables(
        getExecutionContext() ?? execution,
        organizationScopeId,
        productionId,
      );
      return deliverables.map(toUgcDeliverableView);
    },

    async listUgcSubmissions(execution, organizationScopeId, productionId) {
      const submissions = await creatorEngagementService.listSubmissions(
        getExecutionContext() ?? execution,
        organizationScopeId,
        productionId,
      );
      return submissions.map(toUgcSubmissionView);
    },

    // -- NET-W018 sponsorship/disclosure commands -----------------------
    // The publication lifecycle is the canonical /workflows
    // authority; the verification composite (the disclosure gate)
    // composes the material bookkeeping + the DRAFT → VERIFIED
    // transition as ONE authoritative unit. NO economic/reputation/
    // risk/outcome mutation, NO AI path.
    async createCommercialRelationship(execution, _actorPersonId, input) {
      const result = await creatorSponsorshipService.createCommercialRelationship(
        execution,
        input as unknown as import("../creators/port.ts").CreateCommercialRelationshipInput,
      );
      return {
        relationship: toCommercialRelationshipView(result.relationship),
        created: result.created,
      };
    },

    async terminateCommercialRelationship(execution, _actorPersonId, input) {
      const relationship =
        await creatorSponsorshipService.terminateCommercialRelationship(
          execution,
          input as unknown as import("../creators/port.ts").TerminateCommercialRelationshipInput,
        );
      return toCommercialRelationshipView(relationship);
    },

    async createPublication(execution, _actorPersonId, input) {
      const result = await creatorSponsorshipService.createPublication(
        execution,
        input as unknown as import("../creators/port.ts").CreatePublicationInput,
      );
      return {
        publication: toPublicationView(result.publication),
        created: result.created,
      };
    },

    async recordDisclosureDeclaration(execution, _actorPersonId, input) {
      const result = await creatorSponsorshipService.recordDisclosureDeclaration(
        execution,
        input as unknown as import("../creators/port.ts").RecordDisclosureDeclarationInput,
      );
      return {
        declaration: toDisclosureDeclarationView(result.declaration),
        created: result.created,
      };
    },

    async verifyPublication(execution, _actorPersonId, input) {
      const result = await creatorSponsorshipService.verifyPublication(
        execution,
        input as unknown as import("../creators/port.ts").VerifyPublicationInput,
      );
      return {
        publication: toPublicationView(result.publication),
        transition: {
          executed: result.transition.executed,
          transitionId: result.transition.transitionId,
          auditEventName: result.transition.auditEventName,
          transactionId: result.transition.transactionId,
          fromState: "DRAFT",
          toState: "VERIFIED",
        },
        disclosureStatus: toPublicationDisclosureStatusView(
          result.disclosureStatus,
        ),
      };
    },

    async getCommercialRelationship(
      execution,
      organizationScopeId,
      relationshipId,
    ) {
      const relationship = await creatorSponsorshipService.getCommercialRelationship(
        getExecutionContext() ?? execution,
        organizationScopeId,
        relationshipId,
      );
      return toCommercialRelationshipView(relationship);
    },

    async listCommercialRelationships(
      execution,
      organizationScopeId,
      campaignId,
      engagementId,
      creatorPersonId,
    ) {
      const relationships =
        await creatorSponsorshipService.listCommercialRelationships(
          getExecutionContext() ?? execution,
          organizationScopeId,
          {
            ...(campaignId !== undefined ? { campaignId } : {}),
            ...(engagementId !== undefined ? { engagementId } : {}),
            ...(creatorPersonId !== undefined ? { creatorPersonId } : {}),
          },
        );
      return relationships.map(toCommercialRelationshipView);
    },

    async getPublication(execution, organizationScopeId, publicationId) {
      const publication = await creatorSponsorshipService.getPublication(
        getExecutionContext() ?? execution,
        organizationScopeId,
        publicationId,
      );
      return toPublicationView(publication);
    },

    async listPublications(
      execution,
      organizationScopeId,
      engagementId,
      campaignId,
      creatorPersonId,
    ) {
      const publications = await creatorSponsorshipService.listPublications(
        getExecutionContext() ?? execution,
        organizationScopeId,
        {
          ...(engagementId !== undefined ? { engagementId } : {}),
          ...(campaignId !== undefined ? { campaignId } : {}),
          ...(creatorPersonId !== undefined ? { creatorPersonId } : {}),
        },
      );
      return publications.map(toPublicationView);
    },

    async listDisclosureDeclarations(
      execution,
      organizationScopeId,
      publicationId,
    ) {
      const declarations =
        await creatorSponsorshipService.listDisclosureDeclarations(
          getExecutionContext() ?? execution,
          organizationScopeId,
          publicationId,
        );
      return declarations.map(toDisclosureDeclarationView);
    },

    async getPublicationDisclosureStatus(
      execution,
      organizationScopeId,
      publicationId,
    ) {
      const status = await creatorSponsorshipService.getPublicationDisclosureStatus(
        getExecutionContext() ?? execution,
        organizationScopeId,
        publicationId,
      );
      return toPublicationDisclosureStatusView(status);
    },

    // -- NET-W019 inventory/placement commands ---------------------------
    // Supply registration + placement context. Items and placements
    // carry NO lifecycle subject kind (/workflows untouched); the
    // settlement gate is the DERIVED readiness view (no economic
    // command exists — /settlement stays the economic authority).
    async registerInventoryItem(execution, _actorPersonId, input) {
      const result = await inventoryService.registerInventoryItem(
        execution,
        input as unknown as import("../inventory/port.ts").RegisterInventoryItemInput,
      );
      return {
        item: toInventoryItemView(result.item),
        created: result.created,
      };
    },

    async retireInventoryItem(execution, _actorPersonId, input) {
      const item = await inventoryService.retireInventoryItem(
        execution,
        input as unknown as import("../inventory/port.ts").RetireInventoryItemInput,
      );
      return toInventoryItemView(item);
    },

    async attachSupplyVerification(execution, _actorPersonId, input) {
      const item = await inventoryService.attachSupplyVerification(
        execution,
        input as unknown as import("../inventory/port.ts").AttachSupplyVerificationInput,
      );
      return toInventoryItemView(item);
    },

    async createPlacement(execution, _actorPersonId, input) {
      const result = await inventoryService.createPlacement(
        execution,
        input as unknown as import("../inventory/port.ts").CreatePlacementInput,
      );
      return {
        placement: toPlacementView(result.placement),
        created: result.created,
      };
    },

    async retirePlacement(execution, _actorPersonId, input) {
      const placement = await inventoryService.retirePlacement(
        execution,
        input as unknown as import("../inventory/port.ts").RetirePlacementInput,
      );
      return toPlacementView(placement);
    },

    async getInventoryItem(execution, organizationScopeId, itemId) {
      const item = await inventoryService.getInventoryItem(
        getExecutionContext() ?? execution,
        organizationScopeId,
        itemId,
      );
      return toInventoryItemView(item);
    },

    async listInventoryItems(
      execution,
      organizationScopeId,
      surfaceKind,
      format,
      ownerPersonId,
      retired,
    ) {
      const items = await inventoryService.listInventoryItems(
        getExecutionContext() ?? execution,
        organizationScopeId,
        {
          ...(surfaceKind !== undefined ? { surfaceKind } : {}),
          ...(format !== undefined ? { format } : {}),
          ...(ownerPersonId !== undefined ? { ownerPersonId } : {}),
          ...(retired !== undefined ? { retired } : {}),
        },
      );
      return items.map(toInventoryItemView);
    },

    async getPlacement(execution, organizationScopeId, placementId) {
      const placement = await inventoryService.getPlacement(
        getExecutionContext() ?? execution,
        organizationScopeId,
        placementId,
      );
      return toPlacementView(placement);
    },

    async listPlacements(
      execution,
      organizationScopeId,
      inventoryItemId,
      campaignId,
      ownerPersonId,
      retired,
    ) {
      const placements = await inventoryService.listPlacements(
        getExecutionContext() ?? execution,
        organizationScopeId,
        {
          ...(inventoryItemId !== undefined ? { inventoryItemId } : {}),
          ...(campaignId !== undefined ? { campaignId } : {}),
          ...(ownerPersonId !== undefined ? { ownerPersonId } : {}),
          ...(retired !== undefined ? { retired } : {}),
        },
      );
      return placements.map(toPlacementView);
    },

    async getPlacementSettlementReadiness(
      execution,
      organizationScopeId,
      placementId,
    ) {
      const readiness = await inventoryService.getPlacementSettlementReadiness(
        getExecutionContext() ?? execution,
        organizationScopeId,
        placementId,
      );
      return toPlacementSettlementReadinessView(readiness);
    },

    // -- NET-W024 demand commands ----------------------------------------
    async createDemandPool(execution, _actorPersonId, input) {
      const result = await demandService.createDemandPool(
        execution,
        input as unknown as import("../demand/port.ts").CreateDemandPoolInput,
      );
      return {
        pool: toDemandPoolView(result.pool),
        created: result.created,
      };
    },

    async closeDemandPool(execution, _actorPersonId, input) {
      const pool = await demandService.closeDemandPool(
        execution,
        input as unknown as import("../demand/port.ts").CloseDemandPoolInput,
      );
      return toDemandPoolView(pool);
    },

    async createDemandCommitment(execution, _actorPersonId, input) {
      const result = await demandService.createDemandCommitment(
        execution,
        input as unknown as import("../demand/port.ts").CreateDemandCommitmentInput,
      );
      return {
        commitment: toDemandCommitmentView(result.commitment),
        created: result.created,
      };
    },

    async withdrawDemandCommitment(execution, _actorPersonId, input) {
      const commitment = await demandService.withdrawDemandCommitment(
        execution,
        input as unknown as import("../demand/port.ts").WithdrawDemandCommitmentInput,
      );
      return toDemandCommitmentView(commitment);
    },

    async evaluateQualifiedDemand(execution, _actorPersonId, input) {
      // THE SUPPLIER-FACING DERIVATION: no aggregate/threshold input
      // exists — every caller field beyond scope/pool identity is
      // ignored and the evaluation re-derives everything.
      const view = await demandService.evaluateQualifiedDemand(execution, {
        organizationScopeId: input.organizationScopeId as string,
        poolId: input.poolId as string,
      });
      return toQualifiedDemandAggregateView(view);
    },

    async listMyDemandCommitments(execution, actorPersonId, input) {
      // The consumer is the SERVER-RESOLVED authenticated actor —
      // there is no consumerPersonId input on this route. This is the
      // ONLY commitment read surface (individual commitments are
      // never exposed through any other route).
      const commitments = await demandService.listDemandCommitments(
        execution,
        input.organizationScopeId as string,
        {
          consumerPersonId: actorPersonId,
          ...(input.poolId !== undefined && input.poolId !== null
            ? { poolId: input.poolId as string }
            : {}),
        },
      );
      return commitments.map(toDemandCommitmentView);
    },

    async getDemandPool(execution, organizationScopeId, poolId) {
      const pool = await demandService.getDemandPool(
        getExecutionContext() ?? execution,
        organizationScopeId,
        poolId,
      );
      return toDemandPoolView(pool);
    },

    async listDemandPools(
      execution,
      organizationScopeId,
      categoryKey,
      closed,
    ) {
      const pools = await demandService.listDemandPools(
        getExecutionContext() ?? execution,
        organizationScopeId,
        {
          ...(categoryKey !== undefined ? { categoryKey } : {}),
          ...(closed !== undefined ? { closed } : {}),
        },
      );
      return pools.map(toDemandPoolView);
    },

    // -- NET-W025 procurement commands ------------------------------------
    async createProcurementPool(execution, _actorPersonId, input) {
      const result = await procurementService.createProcurementPool(
        execution,
        input as unknown as import("../demand/port.ts").CreateProcurementPoolInput,
      );
      return {
        pool: toProcurementPoolView(result.pool),
        created: result.created,
      };
    },

    async closeProcurementPool(execution, _actorPersonId, input) {
      const pool = await procurementService.closeProcurementPool(
        execution,
        input as unknown as import("../demand/port.ts").CloseProcurementPoolInput,
      );
      return toProcurementPoolView(pool);
    },

    async createProcurementCommitment(execution, _actorPersonId, input) {
      const result = await procurementService.createProcurementCommitment(
        execution,
        input as unknown as import("../demand/port.ts").CreateProcurementCommitmentInput,
      );
      return {
        commitment: toProcurementCommitmentView(result.commitment),
        created: result.created,
      };
    },

    async withdrawProcurementCommitment(execution, _actorPersonId, input) {
      const commitment = await procurementService.withdrawProcurementCommitment(
        execution,
        input as unknown as import("../demand/port.ts").WithdrawProcurementCommitmentInput,
      );
      return toProcurementCommitmentView(commitment);
    },

    async evaluateQualifiedProcurementDemand(
      execution,
      _actorPersonId,
      input,
    ) {
      // THE SUPPLIER-FACING DERIVATION: no aggregate/threshold input
      // exists — every caller field beyond scope/pool identity is
      // ignored and the evaluation re-derives everything.
      const view = await procurementService.evaluateQualifiedProcurementDemand(
        execution,
        {
          organizationScopeId: input.organizationScopeId as string,
          poolId: input.poolId as string,
        },
      );
      return toQualifiedProcurementAggregateView(view);
    },

    async listMyProcurementCommitments(
      execution,
      actorPersonId,
      input,
    ) {
      // The submitter is the SERVER-RESOLVED authenticated actor —
      // there is no submittedBy input on this route. This is the
      // ONLY commitment read surface (individual business
      // commitments are never exposed through any other route).
      const commitments = await procurementService.listProcurementCommitments(
        execution,
        input.organizationScopeId as string,
        {
          submittedBy: actorPersonId,
          ...(input.poolId !== undefined && input.poolId !== null
            ? { poolId: input.poolId as string }
            : {}),
        },
      );
      return commitments.map(toProcurementCommitmentView);
    },

    async getProcurementPool(execution, organizationScopeId, poolId) {
      const pool = await procurementService.getProcurementPool(
        getExecutionContext() ?? execution,
        organizationScopeId,
        poolId,
      );
      return toProcurementPoolView(pool);
    },

    async listProcurementPools(
      execution,
      organizationScopeId,
      categoryKey,
      closed,
    ) {
      const pools = await procurementService.listProcurementPools(
        getExecutionContext() ?? execution,
        organizationScopeId,
        {
          ...(categoryKey !== undefined ? { categoryKey } : {}),
          ...(closed !== undefined ? { closed } : {}),
        },
      );
      return pools.map(toProcurementPoolView);
    },

    // -- NET-W026 supplier-offer/selection commands -----------------------
    async createSupplierOffer(execution, _actorPersonId, input) {
      const result = await supplierOfferService.createSupplierOffer(
        execution,
        input as unknown as import("../demand/port.ts").CreateSupplierOfferInput,
      );
      return {
        offer: toSupplierOfferView(result.offer),
        created: result.created,
      };
    },

    async withdrawSupplierOffer(execution, _actorPersonId, input) {
      const offer = await supplierOfferService.withdrawSupplierOffer(
        execution,
        input as unknown as import("../demand/port.ts").WithdrawSupplierOfferInput,
      );
      return toSupplierOfferView(offer);
    },

    async listMySupplierOffers(execution, actorPersonId, input) {
      // The supplier is the SERVER-RESOLVED authenticated actor —
      // there is no supplierPersonId input on this route. This is
      // the ONLY offer read surface (individual supplier offers are
      // never exposed through any other route).
      const offers = await supplierOfferService.listSupplierOffers(
        execution,
        input.organizationScopeId as string,
        {
          supplierPersonId: actorPersonId,
          ...(input.poolId !== undefined && input.poolId !== null
            ? { poolId: input.poolId as string }
            : {}),
        },
      );
      return offers.map(toSupplierOfferView);
    },

    async evaluateCompetitiveSelection(
      execution,
      _actorPersonId,
      input,
    ) {
      // THE DERIVED SELECTION VIEW: no offer-set/eligibility/ranking
      // or selection input exists — every caller field beyond
      // scope/pool identity is ignored and the evaluation re-derives
      // everything (a derived 200 decision for every outcome).
      const view = await supplierOfferService.evaluateCompetitiveSelection(
        execution,
        {
          organizationScopeId: input.organizationScopeId as string,
          poolId: input.poolId as string,
        },
      );
      return toCompetitiveSelectionView(view);
    },

    async recordCompetitiveSelection(
      execution,
      _actorPersonId,
      input,
    ) {
      // THE AUTHORITATIVE SELECTION LINEAGE RECORD: no offer-set,
      // eligibility, ranking or selected-offer input exists — the
      // selection is re-derived INSIDE the authoritative transaction
      // from CURRENT records.
      const result = await supplierOfferService.recordCompetitiveSelection(
        execution,
        {
          organizationScopeId: input.organizationScopeId as string,
          poolId: input.poolId as string,
          idempotencyKey: input.idempotencyKey as string,
        },
      );
      return {
        selection: toCompetitiveSelectionRecordView(result.selection),
        created: result.created,
      };
    },

    async listPoolSelections(execution, _actorPersonId, input) {
      // The pool-creator-scoped selection lineage read (the service
      // re-derives the creator gate server-side).
      const selections = await supplierOfferService.listPoolSelections(
        execution,
        {
          organizationScopeId: input.organizationScopeId as string,
          poolId: input.poolId as string,
        },
      );
      return selections.map(toCompetitiveSelectionRecordView);
    },

    // -- NET-W027 savings/counterfactual commands -----------------------
    async createProcurementBaseline(execution, _actorPersonId, input) {
      // The explicit baseline/counterfactual record (pool-creator-
      // only; the kind/method/version/window/population/value/
      // confidence/provenance/evidence contract is validated
      // fail-closed; evidence references resolve through the NEUTRAL
      // /evidence lookup — scope + subject binding enforced).
      const result = await procurementSavingsService.createProcurementBaseline(
        execution,
        input as unknown as import("../demand/port.ts").CreateProcurementBaselineInput,
      );
      return {
        baseline: toProcurementBaselineView(result.baseline),
        created: result.created,
      };
    },

    async invalidateProcurementBaseline(
      execution,
      _actorPersonId,
      input,
    ) {
      // The ONE-WAY invalidation (pool-creator-only; closed-vocabulary
      // reason; an invalidated baseline can never again support a
      // savings derivation — derived fail-closed, never a status
      // transition).
      const baseline =
        await procurementSavingsService.invalidateProcurementBaseline(
          execution,
          input as unknown as import("../demand/port.ts").InvalidateProcurementBaselineInput,
        );
      return toProcurementBaselineView(baseline);
    },

    async listPoolBaselines(execution, _actorPersonId, input) {
      // The pool-creator-scoped baseline read (the service re-derives
      // the creator gate server-side).
      const baselines = await procurementSavingsService.listPoolBaselines(
        execution,
        {
          organizationScopeId: input.organizationScopeId as string,
          poolId: input.poolId as string,
        },
      );
      return baselines.map(toProcurementBaselineView);
    },

    async evaluateProcurementSavings(
      execution,
      _actorPersonId,
      input,
    ) {
      // THE DERIVED SAVINGS VIEW: no savings value, confidence,
      // supported flag or baseline-facts input exists — every caller
      // field beyond identities is ignored and the derivation
      // re-derives everything (a derived 200 decision for every
      // outcome — supported or not, the decision is the product).
      const view = await procurementSavingsService.evaluateProcurementSavings(
        execution,
        {
          organizationScopeId: input.organizationScopeId as string,
          poolId: input.poolId as string,
          baselineId: input.baselineId as string,
          outcomeObservationIds: Array.isArray(input.outcomeObservationIds)
            ? (input.outcomeObservationIds as string[])
            : [],
          ...(input.selectionId !== undefined && input.selectionId !== null
            ? { selectionId: input.selectionId as string }
            : {}),
        },
      );
      return toProcurementSavingsView(view);
    },

    async recordProcurementSavings(
      execution,
      _actorPersonId,
      input,
    ) {
      // THE AUTHORITATIVE SAVINGS LINEAGE RECORD: the derivation is
      // re-executed INSIDE the authoritative transaction from CURRENT
      // records and FAILS CLOSED when unsupported — nothing
      // caller-asserted values or supports the claim.
      const result = await procurementSavingsService.recordProcurementSavings(
        execution,
        {
          organizationScopeId: input.organizationScopeId as string,
          poolId: input.poolId as string,
          baselineId: input.baselineId as string,
          outcomeObservationIds: Array.isArray(input.outcomeObservationIds)
            ? (input.outcomeObservationIds as string[])
            : [],
          ...(input.selectionId !== undefined && input.selectionId !== null
            ? { selectionId: input.selectionId as string }
            : {}),
          idempotencyKey: input.idempotencyKey as string,
        },
      );
      return {
        savings: toProcurementSavingsRecordView(result.savings),
        created: result.created,
      };
    },

    async listPoolSavings(execution, _actorPersonId, input) {
      // The pool-creator-scoped savings lineage read (the service
      // re-derives the creator gate server-side).
      const records = await procurementSavingsService.listPoolSavings(
        execution,
        {
          organizationScopeId: input.organizationScopeId as string,
          poolId: input.poolId as string,
        },
      );
      return records.map(toProcurementSavingsRecordView);
    },

    // -- NET-W028 benefit-pool commands -----------------------------
    async createBenefitPoolPolicy(execution, _actorPersonId, input) {
      // The versioned allocation policy (append-only; the
      // organization-independent lineage mutex prevents cross-tenant
      // forks; the declaration set is validated fail-closed).
      const result = await benefitPoolService.createPolicyVersion(
        execution,
        input as unknown as import("../benefits/port.ts").CreateBenefitPoolPolicyInput,
      );
      return {
        policy: result.policy as unknown as Record<string, unknown>,
        created: result.created,
      };
    },

    async listBenefitPolicyVersions(execution, _actorPersonId, input) {
      // The in-scope policy lineage read.
      const policies = await benefitPoolService.listPolicyVersions(execution, {
        organizationScopeId: input.organizationScopeId as string,
        policyId: input.policyId as string,
      });
      return policies as unknown as readonly Record<string, unknown>[];
    },

    async createBenefitPool(execution, _actorPersonId, input) {
      // The tenant-scoped pool record (funding REFERENCES only —
      // there is deliberately NO funded-amount input anywhere;
      // funding resolves server-side at every use).
      const result = await benefitPoolService.createBenefitPool(
        execution,
        input as unknown as import("../benefits/port.ts").CreateBenefitPoolInput,
      );
      return {
        pool: result.pool as unknown as Record<string, unknown>,
        created: result.created,
      };
    },

    async closeBenefitPool(execution, _actorPersonId, input) {
      // The ONE-WAY closure (pool-creator-only; a closed pool can
      // never re-open or allocate again).
      const pool = await benefitPoolService.closeBenefitPool(
        execution,
        input as unknown as import("../benefits/port.ts").CloseBenefitPoolInput,
      );
      return pool as unknown as Record<string, unknown>;
    },

    async listBenefitPools(execution, _actorPersonId, input) {
      // The creator-scoped pool listing.
      const pools = await benefitPoolService.listBenefitPools(execution, {
        organizationScopeId: input.organizationScopeId as string,
      });
      return pools as unknown as readonly Record<string, unknown>[];
    },

    async evaluatePoolAllocation(execution, _actorPersonId, input) {
      // THE DERIVED ALLOCATION VIEW: a derived 200 decision — the
      // current funding + eligibility + plan derivation (no command
      // asserts, stores or waives eligibility).
      const view = await benefitPoolService.evaluatePoolAllocation(execution, {
        organizationScopeId: input.organizationScopeId as string,
        poolId: input.poolId as string,
      });
      return view as unknown as Record<string, unknown>;
    },

    async allocatePoolBenefits(execution, _actorPersonId, input) {
      // THE ATOMIC ALLOCATION OPERATION: funding + eligibility
      // re-derived IN the authoritative transaction, the deterministic
      // plan, conservation, and (for economic draws) the /settlement
      // reward-allocation draw WithinTx — everything commits together
      // or nothing does.
      const result = await benefitPoolService.allocatePoolBenefits(
        execution,
        input as unknown as import("../benefits/port.ts").AllocatePoolBenefitsInput,
      );
      return {
        allocation: result.allocation as unknown as Record<string, unknown>,
        created: result.created,
      };
    },

    async listPoolAllocations(execution, _actorPersonId, input) {
      // The pool-creator-scoped allocation lineage read.
      const allocations = await benefitPoolService.listPoolAllocations(
        execution,
        {
          organizationScopeId: input.organizationScopeId as string,
          poolId: input.poolId as string,
        },
      );
      return allocations as unknown as readonly Record<string, unknown>[];
    },

    async getMemberBenefitView(execution, _actorPersonId, input) {
      // THE PRIVACY-PRESERVING MEMBER VIEW: the acting member sees
      // THEIR OWN shares and totals ONLY.
      const view = await benefitPoolService.getMemberBenefitView(execution, {
        organizationScopeId: input.organizationScopeId as string,
        poolId: input.poolId as string,
      });
      return view as unknown as Record<string, unknown>;
    },

    // -- NET-W012 helpful-contribution commands -------------------------
    async defineHelpfulnessPolicy(execution, _actorPersonId, input) {
      const result = await helpfulnessService.defineHelpfulnessPolicy(
        execution,
        {
          organizationScopeId: input.organizationScopeId as string,
          policyId: input.policyId as string,
          sections:
            input.sections as unknown as import("../contributions/port.ts").HelpfulnessPolicySections,
          idempotencyKey: input.idempotencyKey as string,
        },
      );
      return {
        policy: toHelpfulnessPolicyView(result.policy),
        created: result.created,
      };
    },

    async listHelpfulnessPolicies(execution, policyId) {
      const policies = await helpfulnessService.listPolicyVersions(
        getExecutionContext() ?? execution,
        policyId,
      );
      return policies.map(toHelpfulnessPolicyView);
    },

    async createHelpfulContribution(execution, actorPersonId, input) {
      const result = await helpfulnessService.createHelpfulContribution(
        execution,
        {
          opportunityId: input.opportunityId as string,
          contributorId: actorPersonId,
          organizationScopeId: input.organizationScopeId as string,
          contributionType:
            input.contributionType as import("../core/contributions.ts").HelpfulContributionKind,
          submission:
            input.submission as unknown as import("../contributions/port.ts").HelpfulSubmission,
          helpfulnessPolicyId: input.helpfulnessPolicyId as string,
          idempotencyKey: input.idempotencyKey as string,
        },
      );
      return {
        contribution: toHelpfulContributionView(result.contribution),
        proofOfHelpfulness: toProofOfHelpfulnessView(
          result.proofOfHelpfulness,
        ),
        created: result.created,
      };
    },

    async getHelpfulContribution(execution, contributionId) {
      try {
        const result = await helpfulnessService.getHelpfulContribution(
          getExecutionContext() ?? execution,
          contributionId,
        );
        return {
          contribution: toHelpfulContributionView(result.contribution),
          proofOfHelpfulness: toProofOfHelpfulnessView(
            result.proofOfHelpfulness,
          ),
        };
      } catch {
        return null;
      }
    },

    async prepareHelpfulRecommendation(execution, _actorPersonId, input) {
      const poh = await helpfulnessService.prepareRecommendation(execution, {
        contributionId: input.contributionId as string,
        preparedContentRef: input.preparedContentRef as string,
        rationale: input.rationale as string | undefined,
        idempotencyKey: input.idempotencyKey as string,
      });
      return toProofOfHelpfulnessView(poh);
    },

    async publishHelpfulContribution(execution, actorPersonId, input) {
      const contributionId = input.contributionId as string;
      const idempotencyKey = input.idempotencyKey as string;
      // 1. The USER-CONTROLLED publication gate (person actor ==
      //    contributor; disclosure compliance when required).
      await helpfulnessService.assertPublishable(execution, contributionId);
      // 2. Walk the workflow transitions to SUBMITTED through the
      //    LIFECYCLE authority (/workflows — never the domain).
      //    Replay tolerance: already-published contributions skip
      //    straight to the recording step.
      const path = ["READY", "ASSIGNED", "IN_PROGRESS", "SUBMITTED"];
      const { policyActionFor } = await import("../core/workflow.ts");
      let current =
        await helpfulnessService.getHelpfulContribution(
          execution,
          contributionId,
        );
      let step = 0;
      while (current.contribution.state !== "SUBMITTED") {
        const from = current.contribution.state;
        // DRAFT → path[0]; READY → path[1]; … one legal step at a time.
        const to = path[path.indexOf(from) + 1]!;
        step += 1;
        const transition = await workflowService.requestTransition(
          {
            subjectId: contributionId,
            subjectKind: "contribution",
            targetState: to as TransitionRequest["targetState"],
            expectedVersion: current.contribution.version,
            idempotencyKey: `${idempotencyKey}:t${String(step)}`,
            actorPersonId,
            policyAction: policyActionFor(
              "contribution",
              from as TransitionRequest["targetState"],
              to as TransitionRequest["targetState"],
            ),
            metadata: {
              publication: "helpful_contribution",
              actorPersonId,
            },
          },
          execution,
        );
        current = await helpfulnessService.getHelpfulContribution(
          execution,
          contributionId,
        );
        void transition;
      }
      // 3. Record the publication (domain bookkeeping + audit). This
      //    step RE-RESOLVES the pinned policy and the active
      //    disclosures INSIDE its authoritative transaction — a
      //    disclosure retracted after step 1's pre-flight check
      //    blocks the publication here (TOCTOU closure).
      const poh = await helpfulnessService.recordPublication(execution, {
        contributionId,
        workflowState: current.contribution.state,
        idempotencyKey: `${idempotencyKey}:record`,
      });
      return {
        contribution: toHelpfulContributionView(current.contribution),
        proofOfHelpfulness: toProofOfHelpfulnessView(poh),
      };
    },

    async declareCommercialDisclosure(execution, _actorPersonId, input) {
      const disclosure = await helpfulnessService.declareDisclosure(
        execution,
        {
          contributionId: input.contributionId as string,
          contributorPersonId: _actorPersonId,
          relationshipKind:
            input.relationshipKind as import("../core/contributions.ts").DisclosureRelationshipKind,
          relationshipRef: input.relationshipRef as string,
          productRef: input.productRef as string | undefined,
          counterpartyRef: input.counterpartyRef as string,
          description: input.description as string | undefined,
          idempotencyKey: input.idempotencyKey as string,
        },
      );
      return toCommercialDisclosureView(disclosure);
    },

    async retractCommercialDisclosure(execution, _actorPersonId, input) {
      const disclosure = await helpfulnessService.retractDisclosure(
        execution,
        {
          disclosureId: input.disclosureId as string,
          idempotencyKey: input.idempotencyKey as string,
        },
      );
      return toCommercialDisclosureView(disclosure);
    },

    async listCommercialDisclosures(execution, contributionId) {
      const disclosures = await helpfulnessService.listDisclosures(
        getExecutionContext() ?? execution,
        contributionId,
      );
      return disclosures.map(toCommercialDisclosureView);
    },

    async attachHelpfulAdvisoryScore(execution, _actorPersonId, input) {
      const poh = await helpfulnessService.attachAdvisoryScore(execution, {
        contributionId: input.contributionId as string,
        kind: input.kind as import("../core/contributions.ts").HelpfulAdvisoryKind,
        methodRef: input.methodRef as string,
        methodVersion: input.methodVersion as string,
        score: input.score as number,
        idempotencyKey: input.idempotencyKey as string,
      });
      return toProofOfHelpfulnessView(poh);
    },

    async attachHelpfulnessBasis(execution, _actorPersonId, input) {
      const poh = await helpfulnessService.attachBasis(execution, {
        contributionId: input.contributionId as string,
        kind: input.kind as import("../core/contributions.ts").HelpfulnessBasisKind,
        referenceId: input.referenceId as string,
        idempotencyKey: input.idempotencyKey as string,
      });
      return toProofOfHelpfulnessView(poh);
    },

    async evaluateHelpfulness(execution, _actorPersonId, input) {
      const poh = await helpfulnessService.evaluateHelpfulness(execution, {
        contributionId: input.contributionId as string,
        idempotencyKey: input.idempotencyKey as string,
      });
      return toProofOfHelpfulnessView(poh);
    },

    // ------------------------------------------------------------------
    // NET-W013 commands (quality, moderation, anti-spam).
    // ------------------------------------------------------------------
    async defineQualityPolicy(execution, _actorPersonId, input) {
      const result = await qualityService.defineQualityPolicy(execution, {
        organizationScopeId: input.organizationScopeId as string,
        policyId: input.policyId as string,
        shape: input.shape as unknown as Parameters<
          typeof qualityService.defineQualityPolicy
        >[1]["shape"],
        idempotencyKey: input.idempotencyKey as string,
      });
      return {
        policy: toQualityPolicyView(result.policy),
        created: result.created,
      };
    },

    async listQualityPolicies(execution, policyId) {
      const policies = await qualityService.listQualityPolicyVersions(
        getExecutionContext() ?? execution,
        policyId,
      );
      return policies.map(toQualityPolicyView);
    },

    async attachAdvisoryQualityScore(execution, actorPersonId, input) {
      const score = await qualityService.attachAdvisoryScore(execution, {
        contributionId: input.contributionId as string,
        organizationScopeId: input.organizationScopeId as string,
        kind: input.kind as import("../core/moderation.ts").QualityAdvisoryKind,
        methodRef: input.methodRef as string,
        methodVersion: input.methodVersion as string,
        provider: (input.provider as string | null | undefined) ?? null,
        modelRef: (input.modelRef as string | null | undefined) ?? null,
        score: input.score as number,
        idempotencyKey: input.idempotencyKey as string,
      });
      void actorPersonId;
      return toAdvisoryQualityScoreView(score);
    },

    async listAdvisoryQualityScores(execution, contributionId) {
      const scores = await qualityService.listAdvisoryScores(
        getExecutionContext() ?? execution,
        contributionId,
      );
      return scores.map(toAdvisoryQualityScoreView);
    },

    /**
     * The FIRST LlmPort consumer (NET-W013, AI-004): build the NEUTRAL
     * record-level fact set (never user content), request an advisory
     * score from the provider-neutral port, and attach it through the
     * domain's advisory API with provider identity preserved. The
     * model output is structurally non-authoritative evidence.
     *
     * PR #26 remediation (HELP-002): the fact set carries NO
     * mention-derived feature. Product mentions are recorded metadata
     * with no path into ANY quality signal — neither the deterministic
     * engine (structurally absent input kind) NOR the advisory input
     * assembled here. Mentions never enter the LLM scoring request.
     */
    async generateAdvisoryQualityScore(execution, _actorPersonId, input) {
      const contributionId = input.contributionId as string;
      const idempotencyKey = input.idempotencyKey as string;
      const contribution = await contributionService.getContribution(
        execution,
        contributionId,
      );
      const organizationScopeId = contribution.organizationScopeId;
      // Neutral record-level facts ONLY (no user content, no
      // authoritative assertions — the provider receives labels +
      // values from the authoritative records). NO mention-derived
      // feature: a contribution's mentions must not move the advisory
      // score (HELP-002 — mention ≠ helpfulness, mention ≠ quality).
      let pohState = "none";
      let qualifyingBasisCount = 0;
      let independentSourceCount = 0;
      try {
        const poh = await helpfulnessService.getProofOfHelpfulness(
          execution,
          contributionId,
        );
        pohState = poh.state;
        const latest =
          poh.evaluations.length > 0
            ? poh.evaluations[poh.evaluations.length - 1]!
            : null;
        qualifyingBasisCount = latest ? latest.qualifyingBasisCount : 0;
        independentSourceCount = latest ? latest.independentSourceCount : 0;
      } catch {
        // No PoH for this contribution — the facts stay at their
        // neutral defaults (quality evaluates non-helpful kinds too).
      }
      // The rubric reference: the pinned quality policy when supplied,
      // else the neutral default rubric.
      let rubricRef = "contribution-quality:default";
      if (input.qualityPolicyId) {
        const versions = await qualityService.listQualityPolicyVersions(
          execution,
          input.qualityPolicyId as string,
        );
        const latest = versions[versions.length - 1];
        if (latest) {
          rubricRef = `quality_policy:${latest.policyId}:v${String(latest.version)}`;
        }
      }
      const scored = await llmProvider.score({
        purpose: "content_scoring",
        rubricRef,
        neutralFacts: [
          { label: "contribution_type", value: contribution.contributionType },
          { label: "contribution_state", value: contribution.state },
          { label: "poh_state", value: pohState },
          {
            label: "poh_qualifying_basis_count",
            value: String(qualifyingBasisCount),
          },
          {
            label: "poh_independent_source_count",
            value: String(independentSourceCount),
          },
        ],
      });
      const attached = await qualityService.attachAdvisoryScore(execution, {
        contributionId,
        organizationScopeId,
        kind: "model_score",
        methodRef: rubricRef,
        methodVersion: scored.modelRef,
        provider: scored.provider,
        modelRef: scored.modelRef,
        score: scored.score,
        idempotencyKey: `${idempotencyKey}:attach`,
      });
      return {
        advisoryScore: toAdvisoryQualityScoreView(attached),
        provider: scored.provider,
        modelRef: scored.modelRef,
        authoritative: scored.authoritative,
      };
    },

    async previewQualityEvaluation(execution, _actorPersonId, input) {
      const preview = await qualityService.previewQualityEvaluation(
        execution,
        {
          contributionId: input.contributionId as string,
          organizationScopeId: input.organizationScopeId as string,
          qualityPolicyId: input.qualityPolicyId as string,
          ...(input.qualityPolicyVersion !== undefined
            ? { qualityPolicyVersion: input.qualityPolicyVersion as number }
            : {}),
          evaluatedAt: input.evaluatedAt as string,
        },
      );
      return {
        policy: toQualityPolicyView(preview.policy),
        inputContributions: preview.inputContributions as unknown as readonly Record<
          string,
          unknown
        >[],
        advisoryCount: preview.advisoryCount,
        advisoryAverage: preview.advisoryAverage,
        score: preview.score,
        band: preview.band,
        reasons: preview.reasons,
        evaluator: preview.evaluator,
      };
    },

    async recordQualityEvaluation(execution, _actorPersonId, input) {
      const result = await qualityService.recordQualityEvaluation(execution, {
        contributionId: input.contributionId as string,
        organizationScopeId: input.organizationScopeId as string,
        qualityPolicyId: input.qualityPolicyId as string,
        ...(input.qualityPolicyVersion !== undefined
          ? { qualityPolicyVersion: input.qualityPolicyVersion as number }
          : {}),
        evaluatedAt: input.evaluatedAt as string,
        idempotencyKey: input.idempotencyKey as string,
      });
      return {
        evaluation: toQualityEvaluationView(result.evaluation),
        created: result.created,
      };
    },

    async getQualityEvaluationHistory(execution, contributionId) {
      const [history, latest] = await Promise.all([
        qualityService.listQualityEvaluationHistory(
          getExecutionContext() ?? execution,
          contributionId,
        ),
        qualityService.getLatestQualityEvaluation(
          getExecutionContext() ?? execution,
          contributionId,
        ),
      ]);
      return {
        evaluations: history.map(toQualityEvaluationView),
        latest: latest === null ? null : toQualityEvaluationView(latest),
      };
    },

    /**
     * The moderation composite: the domain records the append-only
     * decision; when the decision carries a spam/abuse reason, the
     * composition root emits ONE evidence-backed risk signal into the
     * EXISTING /disputes risk authority (subject: the CONTRIBUTOR;
     * sources: the moderation decision + the contribution) with a
     * compound idempotency key. This is the ONLY spam/abuse emission
     * path — no second fraud authority exists.
     */
    async recordModerationDecision(execution, _actorPersonId, input) {
      const contributionId = input.contributionId as string;
      const idempotencyKey = input.idempotencyKey as string;
      const contribution = await contributionService.getContribution(
        execution,
        contributionId,
      );
      const organizationScopeId = contribution.organizationScopeId;
      const decision = await moderationService.recordModerationDecision(
        execution,
        {
          contributionId,
          organizationScopeId,
          decision: input.decision as import("../core/moderation.ts").ModerationDecision,
          reasonKinds: input.reasonKinds as readonly import("../core/moderation.ts").ModerationReasonKind[],
          ...(input.notes !== undefined
            ? { notes: input.notes as string | null }
            : {}),
          ...(input.qualityEvaluationIds !== undefined
            ? {
                qualityEvaluationIds:
                  input.qualityEvaluationIds as readonly string[],
              }
            : {}),
          idempotencyKey,
        },
      );
      // Spam/abuse emission (composition root ONLY).
      const reasons = decision.reasonKinds as readonly string[];
      const abuseReasons = reasons.filter((r) => r === "spam" || r === "abuse");
      let riskSignal: ReturnType<typeof toRiskSignalView> | null = null;
      let signalCreated = false;
      if (abuseReasons.length > 0) {
        const category = abuseReasons.includes("spam") ? "spam" : "abuse";
        const signalResult = await riskSignalService.createSignal(execution, {
          organizationScopeId,
          subjectPersonId: contribution.contributorId,
          subjectRef: {
            subjectType: "contribution",
            subjectId: contributionId,
          },
          category,
          severity: (input.signalSeverity as string | undefined) ?? "MEDIUM",
          confidence:
            typeof input.signalConfidence === "number"
              ? input.signalConfidence
              : 0.9,
          provenance: {
            kind: "manual_review",
            detectionMethod: "net-w013-moderation",
            detectionVersion: "1",
            sources: [
              { kind: "moderation_decision", id: decision.id },
              { kind: "contribution", id: contributionId },
            ],
          },
          description: `moderation ${decision.decision} (${decision.reasonKinds.join(", ")}) on contribution ${contributionId}`,
          detectedAt: decision.decidedAt,
          idempotencyKey: `${idempotencyKey}:signal`,
        });
        riskSignal = toRiskSignalView(signalResult.signal);
        signalCreated = signalResult.created;
      }
      return {
        decision: toModerationDecisionView(decision),
        riskSignal,
        signalCreated,
      };
    },

    async listModerationDecisions(execution, contributionId) {
      const decisions = await moderationService.listModerationDecisions(
        getExecutionContext() ?? execution,
        contributionId,
      );
      return decisions.map(toModerationDecisionView);
    },

    async getModerationSummary(execution, contributionId) {
      const summary = await moderationService.getModerationSummary(
        getExecutionContext() ?? execution,
        contributionId,
      );
      return toModerationSummaryView(summary);
    },

    // ------------------------------------------------------------------
    // NET-W014 — reward and settlement integration composites.
    //
    // The integration layer (issue #27): orchestration ONLY over the
    // existing authority services. Every economic mutation goes
    // through /settlement's canonical commands (recordPendingValue /
    // allocateRewards / issueCredits / recordCashObligation — each
    // atomic, idempotent, conserved and audited); reputation goes
    // through /reputation's input service (basis DERIVED, never
    // caller-asserted); campaigns only record REFERENCES. No parallel
    // ledger, no payment execution, no AI authority.
    // ------------------------------------------------------------------

    /**
     * Composite 1 (AC-01): recognize qualifying verified contribution
     * value as canonical PENDING economic value. The deterministic
     * qualification gate (VERIFIED lifecycle + QUALIFIED
     * Proof-of-Helpfulness + moderation + quality floor) runs here;
     * the AUTHORITATIVE input gate (each source resolved same-scope +
     * VERIFIED) runs inside recordPendingValue as always.
     */
    async recognizeContributionValue(execution, _actorPersonId, input) {
      const contributionId = input.contributionId as string;
      const idempotencyKey = input.idempotencyKey as string;
      const contribution = await contributionService.getContribution(
        execution,
        contributionId,
      );
      const organizationScopeId = contribution.organizationScopeId;
      // Gate 1 — the /workflows authority's terminal confirmation.
      if (contribution.state !== "VERIFIED") {
        const { OpenConError: GateError } = await import("../core/errors.ts");
        throw new GateError({
          code: "ECONOMIC_VALIDATION",
          classification: "precondition",
          message: `contribution ${contributionId} is in lifecycle state ${contribution.state}, not VERIFIED — only verified contributions can enter pending settlement`,
          context: {
            contributionId,
            contributionState: contribution.state,
            organizationScopeId,
          },
        });
      }
      // Gate 2 — the W012 verified-usefulness claim.
      const poh = await helpfulnessService.getProofOfHelpfulness(
        execution,
        contributionId,
      );
      if (poh.state !== "QUALIFIED") {
        const { OpenConError: GateError } = await import("../core/errors.ts");
        throw new GateError({
          code: "ECONOMIC_VALIDATION",
          classification: "precondition",
          message: `contribution ${contributionId} has Proof-of-Helpfulness state ${poh.state}, not QUALIFIED — unverified helpfulness cannot create economic value`,
          context: {
            contributionId,
            pohState: poh.state,
            organizationScopeId,
          },
        });
      }
      // Gate 3 — the W013 derived moderation status.
      const moderation = await moderationService.getModerationSummary(
        execution,
        contributionId,
      );
      if (
        moderation.status === "REJECTED" ||
        moderation.status === "FLAGGED_FOR_REVIEW"
      ) {
        const { OpenConError: GateError } = await import("../core/errors.ts");
        throw new GateError({
          code: "ECONOMIC_VALIDATION",
          classification: "precondition",
          message: `contribution ${contributionId} moderation status is ${moderation.status} — a moderated-down contribution cannot enter pending settlement`,
          context: {
            contributionId,
            moderationStatus: moderation.status,
            organizationScopeId,
          },
        });
      }
      // Gate 4 — the W013 deterministic quality evaluation (IF one
      // exists, its band must not be UNSATISFACTORY; advisory scores
      // are never consulted here — only the deterministic record).
      const latestEvaluation =
        await qualityService.getLatestQualityEvaluation(execution, contributionId);
      if (latestEvaluation && latestEvaluation.band === "UNSATISFACTORY") {
        const { OpenConError: GateError } = await import("../core/errors.ts");
        throw new GateError({
          code: "ECONOMIC_VALIDATION",
          classification: "precondition",
          message: `contribution ${contributionId} has an UNSATISFACTORY latest quality evaluation (${latestEvaluation.id}) — bottom-band quality cannot enter pending settlement`,
          context: {
            contributionId,
            evaluationId: latestEvaluation.id,
            band: latestEvaluation.band,
            organizationScopeId,
          },
        });
      }
      // Deterministic source derivation: the contribution itself
      // (first-class NET-W014 economic source) + the PoH's qualifying
      // bases (re-resolved + VERIFIED-enforced by the settlement
      // input gate). Basis kinds map 1:1 onto economic source kinds.
      const basisKindToSourceKind: Record<string, string> = {
        proof_of_value: "proof_of_value",
        measured_outcome: "measured_outcome",
        evidence_record: "evidence",
      };
      const sources: { kind: string; id: string }[] = [
        { kind: "contribution", id: contributionId },
      ];
      for (const basis of poh.bases) {
        const kind = basisKindToSourceKind[basis.kind];
        if (kind) {
          sources.push({ kind, id: basis.referenceId });
        }
      }
      const result = await economicValueService.recordPendingValue(execution, {
        organizationScopeId,
        beneficiaryPersonId: contribution.contributorId,
        amount: input.amount as number,
        sources,
        ...(input.maturation !== undefined
          ? {
              maturation: input.maturation as {
                strategy: string;
                windowEndAt?: string;
              },
            }
          : {}),
        ...(input.description !== undefined
          ? { description: input.description as string }
          : {}),
        idempotencyKey,
      });
      return {
        value: toEconomicValueView(result.value),
        created: result.created,
        proofOfHelpfulnessId: poh.id,
      };
    },

    /**
     * Composite 2 (AC-03): execute a declared campaign clearing rule —
     * the deterministic draw of ONE mature value record through the
     * canonical /settlement primitive the rule selects, capped by the
     * rule's declared maxDrawAmount, gated by risk controls and
     * ACTIVE disputes over the record + beneficiary + ALL upstream
     * sources, and recorded as campaign bookkeeping (references only).
     */
    async executeCampaignClearing(execution, _actorPersonId, input) {
      const campaignId = input.campaignId as string;
      const idempotencyKey = input.idempotencyKey as string;
      const campaign = await campaignService.getCampaign(execution, campaignId);
      // The value record FIRST (the tenant-isolation boundary — a
      // cross-scope reference is rejected before any status or rule
      // logic runs): same scope as the campaign.
      const value = await economicValueService.getValue(
        execution,
        input.valueRecordId as string,
      );
      if (value.organizationScopeId !== campaign.organizationScopeId) {
        const { OpenConError: GateError } = await import("../core/errors.ts");
        throw new GateError({
          code: "ECONOMIC_VALIDATION",
          classification: "precondition",
          message: `value record ${value.id} belongs to organization scope ${value.organizationScopeId}, not the campaign's ${campaign.organizationScopeId}`,
          context: {
            valueRecordId: value.id,
            valueScope: value.organizationScopeId,
            campaignScope: campaign.organizationScopeId,
          },
        });
      }
      if (campaign.status !== "ACTIVE") {
        const { OpenConError: GateError } = await import("../core/errors.ts");
        throw new GateError({
          code: "CAMPAIGN_VALIDATION",
          classification: "precondition",
          message: `campaign ${campaignId} is ${campaign.status} — clearing executes only from an ACTIVE campaign`,
          context: { campaignId, status: campaign.status },
        });
      }
      const organizationScopeId = campaign.organizationScopeId;
      const policy = await campaignService.getPolicyVersion(
        execution,
        campaignId,
        campaign.currentPolicyVersion ?? 1,
      );
      const rules = policy.clearingRules;
      if (rules.length === 0) {
        const { OpenConError: GateError } = await import("../core/errors.ts");
        throw new GateError({
          code: "CAMPAIGN_VALIDATION",
          classification: "precondition",
          message: `campaign ${campaignId} policy version ${String(policy.version)} declares no clearing rules`,
          context: { campaignId, policyVersion: policy.version },
        });
      }
      // Resolve the rule: by explicit id, else the single declared
      // rule (deterministic when exactly one exists).
      const ruleId = input.clearingRuleId as string | undefined;
      const rule =
        ruleId !== undefined && ruleId !== null && String(ruleId).trim() !== ""
          ? rules.find((r) => r.id === ruleId)
          : rules.length === 1
            ? rules[0]!
            : undefined;
      if (!rule) {
        const { OpenConError: GateError } = await import("../core/errors.ts");
        throw new GateError({
          code: "CAMPAIGN_VALIDATION",
          classification: "precondition",
          message: `clearing rule not found on campaign ${campaignId} policy version ${String(policy.version)}${ruleId ? ` (requested ${String(ruleId)})` : " (pass clearingRuleId — multiple rules are declared)"}`,
          context: {
            campaignId,
            policyVersion: policy.version,
            requestedRuleId: ruleId ?? null,
            declaredRuleIds: rules.map((r) => r.id),
          },
        });
      }
      // The state gate: only MATURE value may be drawn. A CONSUMED
      // record is tolerated ONLY as the replay path of a CONSUMING
      // draw (reward/credit) — the underlying settlement primitive
      // replays an idempotent draw (same compound key) and REFUSES a
      // fresh one (consume-only-MATURE), so exactly-once semantics
      // hold either way (the W012 publication-composite
      // replay-tolerance pattern). Cash draws never consume and
      // therefore always require MATURE.
      const drawConsumes =
        rule.drawKind === "reward_allocation" ||
        rule.drawKind === "credit_issuance";
      const isReplayPath = drawConsumes && value.state === "CONSUMED";
      if (value.state !== "MATURE" && !isReplayPath) {
        const { OpenConError: GateError } = await import("../core/errors.ts");
        throw new GateError({
          code: "ECONOMIC_VALIDATION",
          classification: "precondition",
          message: `value record ${value.id} is ${value.state}, not MATURE — only mature value may be cleared`,
          context: { valueRecordId: value.id, state: value.state },
        });
      }
      if (value.amount > rule.maxDrawAmount) {
        const { OpenConError: GateError } = await import("../core/errors.ts");
        throw new GateError({
          code: "ECONOMIC_VALIDATION",
          classification: "precondition",
          message: `value record ${value.id} amount ${String(value.amount)} exceeds clearing rule ${rule.id} max draw amount ${String(rule.maxDrawAmount)}`,
          context: {
            valueRecordId: value.id,
            amount: value.amount,
            clearingRuleId: rule.id,
            maxDrawAmount: rule.maxDrawAmount,
          },
        });
      }
      // Deterministic basis check (CAMP-005): the value record's
      // sources must satisfy the rule's declared basis (the sources
      // are immutable — replay-safe).
      const sourceKinds = new Set(value.sources.map((s) => s.kind));
      const basisSatisfied =
        rule.basis === "attributed_outcome"
          ? sourceKinds.has("measured_outcome")
          : rule.basis === "verified_evidence"
            ? sourceKinds.has("evidence")
            : sourceKinds.has("proof_of_value");
      if (!basisSatisfied) {
        const { OpenConError: GateError } = await import("../core/errors.ts");
        throw new GateError({
          code: "ECONOMIC_VALIDATION",
          classification: "precondition",
          message: `value record ${value.id} sources (${value.sources.map((s) => s.kind).join(", ")}) do not satisfy clearing rule ${rule.id} basis ${rule.basis}`,
          context: {
            valueRecordId: value.id,
            sourceKinds: [...sourceKinds],
            clearingRuleId: rule.id,
            basis: rule.basis,
          },
        });
      }
      // Gates: risk controls (record + person + EVERY source) and
      // ACTIVE disputes (record + every source) — the composition
      // root consults; neither domain mutates economic state. On the
      // CONSUMED replay path the draw has already committed; the
      // gates must not block the idempotent replay.
      const allSubjectIds = [
        value.id,
        ...value.sources.map((s) => s.id),
      ];
      if (!isReplayPath) {
        await refuseWhenDisputed(execution, organizationScopeId, allSubjectIds);
        const drawOperationClass: RiskOperationClass =
          rule.drawKind === "reward_allocation"
            ? "reward_allocation"
            : rule.drawKind === "credit_issuance"
              ? "credit_issuance"
              : "cash_settlement";
        for (const subjectId of allSubjectIds) {
          await refuseWhenGated(
            execution,
            organizationScopeId,
            drawOperationClass,
            subjectId,
            value.beneficiaryPersonId,
          );
        }
      }
      // The draw itself — the EXISTING settlement primitive.
      if (rule.drawKind === "reward_allocation") {
        if (!rule.rewardPolicyId) {
          const { OpenConError: GateError } = await import("../core/errors.ts");
          throw new GateError({
            code: "ECONOMIC_VALIDATION",
            classification: "precondition",
            message: `clearing rule ${rule.id} draw kind reward_allocation requires a reward policy reference`,
            context: { clearingRuleId: rule.id },
          });
        }
        const result = await rewardService.allocateRewards(execution, {
          organizationScopeId,
          sourceValueRecordId: value.id,
          policyId: rule.rewardPolicyId,
          idempotencyKey: `${idempotencyKey}:reward`,
        });
        const campaignAfter = await campaignService.recordClearingExecution(
          execution,
          {
            campaignId,
            clearingRuleId: rule.id,
            drawKind: rule.drawKind,
            valueRecordId: value.id,
            resultId: result.allocation.id,
            amount: result.allocation.totalAllocated,
            description: `campaign clearing draw (reward allocation ${result.allocation.id})`,
            idempotencyKey: `${idempotencyKey}:record`,
          },
        );
        return {
          drawKind: "reward_allocation",
          allocation: toRewardAllocationView(result.allocation),
          created: result.created,
          value: toEconomicValueView(
            await economicValueService.getValue(execution, value.id),
          ),
          campaignEventCount: campaignAfter.events.length,
        };
      }
      if (rule.drawKind === "credit_issuance") {
        const creditsPerValueUnit = input.creditsPerValueUnit as
          | number
          | undefined;
        if (
          creditsPerValueUnit === undefined ||
          !Number.isFinite(creditsPerValueUnit) ||
          creditsPerValueUnit <= 0
        ) {
          const { OpenConError: GateError } = await import("../core/errors.ts");
          throw new GateError({
            code: "ECONOMIC_VALIDATION",
            classification: "validation",
            message: "credit draw requires creditsPerValueUnit > 0",
            context: { creditsPerValueUnit: creditsPerValueUnit ?? null },
          });
        }
        const result = await creditService.issueCredits(execution, {
          organizationScopeId,
          beneficiaryPersonId: value.beneficiaryPersonId,
          sourceValueRecordId: value.id,
          creditsPerValueUnit,
          description: `campaign clearing draw (credits) — rule ${rule.id}`,
          idempotencyKey: `${idempotencyKey}:credit`,
        });
        const campaignAfter = await campaignService.recordClearingExecution(
          execution,
          {
            campaignId,
            clearingRuleId: rule.id,
            drawKind: rule.drawKind,
            valueRecordId: value.id,
            resultId: result.issuance.id,
            amount: result.issuance.creditAmount,
            description: `campaign clearing draw (credit issuance ${result.issuance.id})`,
            idempotencyKey: `${idempotencyKey}:record`,
          },
        );
        return {
          drawKind: "credit_issuance",
          issuance: toCreditIssuanceView(result.issuance),
          created: result.created,
          value: toEconomicValueView(
            await economicValueService.getValue(execution, value.id),
          ),
          campaignEventCount: campaignAfter.events.length,
        };
      }
      // cash_obligation — internal payable/receivable state ONLY
      // (NO external payment execution: /payments stays skeletal,
      // NET-W030).
      const cashKind = (input.cashKind as string | undefined) ?? "payable";
      if (cashKind !== "payable" && cashKind !== "receivable") {
        const { OpenConError: GateError } = await import("../core/errors.ts");
        throw new GateError({
          code: "ECONOMIC_VALIDATION",
          classification: "validation",
          message: `cashKind must be payable | receivable (got ${String(cashKind)})`,
          context: { cashKind },
        });
      }
      const counterpartyPersonId = input.counterpartyPersonId as
        | string
        | undefined;
      if (!counterpartyPersonId || !String(counterpartyPersonId).trim()) {
        const { OpenConError: GateError } = await import("../core/errors.ts");
        throw new GateError({
          code: "ECONOMIC_VALIDATION",
          classification: "validation",
          message: "cash draw requires counterpartyPersonId",
          context: {},
        });
      }
      const cashAmount = input.cashAmount as number | undefined;
      if (
        cashAmount === undefined ||
        !Number.isFinite(cashAmount) ||
        cashAmount <= 0 ||
        cashAmount > rule.maxDrawAmount
      ) {
        const { OpenConError: GateError } = await import("../core/errors.ts");
        throw new GateError({
          code: "ECONOMIC_VALIDATION",
          classification: "validation",
          message: `cash draw amount must be > 0 and ≤ the rule max draw amount ${String(rule.maxDrawAmount)}`,
          context: {
            cashAmount: cashAmount ?? null,
            maxDrawAmount: rule.maxDrawAmount,
          },
        });
      }
      const result = await cashService.recordCashObligation(execution, {
        organizationScopeId,
        kind: cashKind,
        counterpartyPersonId,
        amount: cashAmount,
        description: `campaign clearing draw — rule ${rule.id}, value record ${value.id}`,
        idempotencyKey: `${idempotencyKey}:cash`,
      });
      const campaignAfter = await campaignService.recordClearingExecution(
        execution,
        {
          campaignId,
          clearingRuleId: rule.id,
          drawKind: rule.drawKind,
          valueRecordId: value.id,
          resultId: result.obligation.id,
          amount: result.obligation.amount,
          description: `campaign clearing draw (cash obligation ${result.obligation.id})`,
          idempotencyKey: `${idempotencyKey}:record`,
        },
      );
      return {
        drawKind: "cash_obligation",
        obligation: toCashObligationView(result.obligation),
        created: result.created,
        value: toEconomicValueView(value),
        campaignEventCount: campaignAfter.events.length,
      };
    },

    /**
     * Composite 3 (AC-04): feed ONE evidence-backed reputation input
     * from a MATERIAL settlement outcome (a MATURE or CONSUMED value
     * record). The input service DERIVES the basis from the resolved
     * sources (all verified-grade by construction); no economic field
     * is copied — the reputation record carries references only.
     */
    async applySettlementReputationEffect(execution, _actorPersonId, input) {
      const value = await economicValueService.getValue(
        execution,
        input.valueRecordId as string,
      );
      if (value.state !== "MATURE" && value.state !== "CONSUMED") {
        const { OpenConError: GateError } = await import("../core/errors.ts");
        throw new GateError({
          code: "REPUTATION_VALIDATION",
          classification: "precondition",
          message: `value record ${value.id} is ${value.state} — only MATURE or CONSUMED outcomes (material, gate-passed) may feed reputation`,
          context: { valueRecordId: value.id, state: value.state },
        });
      }
      const dimension = (input.dimension as string | undefined) ?? "helpfulness";
      const result = await reputationInputService.recordInput(execution, {
        organizationScopeId: value.organizationScopeId,
        subjectPersonId: value.beneficiaryPersonId,
        dimension,
        // The value record's sources — every kind is a legal
        // reputation source kind (contribution / proof_of_value /
        // measured_outcome / evidence), all verified-grade by the
        // settlement input gate. References only: no amounts.
        sources: value.sources.map((s) => ({ kind: s.kind, id: s.id })),
        description:
          (input.description as string | undefined) ??
          `material settlement outcome (value record ${value.id}, ${value.state.toLowerCase()})`,
        // The decay anchor: when the outcome HAPPENED (maturation /
        // consumption), not when this effect was recorded.
        occurredAt: value.maturedAt ?? value.recordedAt,
        idempotencyKey: input.idempotencyKey as string,
      });
      return {
        input: toReputationInputView(result.input),
        created: result.created,
        valueState: value.state,
      };
    },

    // -- NET-W020 cross-promotion clearing commands ----------------------
    /**
     * Composite 1 (AC-01..07): execute ONE cross-promotion clearing —
     * the deterministic draw of a qualifying source contribution's
     * MATURE value through the canonical /settlement primitive the
     * campaign's clearing rule selects, against a settlement-ready
     * target placement (the W019 derived gate), capped by the rule's
     * maxDrawAmount, gated by risk controls + ACTIVE disputes over
     * the value record, ALL upstream sources and the placement (with
     * the value beneficiary AND the placement owner as person
     * subjects), recorded as the durable clearing record + campaign
     * bookkeeping (references only).
     *
     * NET-W020 REMEDIATION (PR #40 review — the single authoritative
     * transaction boundary): the WHOLE operation is ONE exactly-once
     * economic unit in ONE authoritative transaction owned by the
     * settlement domain's executeCrossPromotionClearing (the draw, the
     * clearing record, the campaign bookkeeping and the audit lineage
     * commit together or not at all — a failed authoritative COMMIT
     * leaves NO partial economic mutation). This adapter is the thin
     * composition-root bridge: input coercion + the view mapping over
     * the committed composite result; the same-key replay returns the
     * stored result verbatim (created:false).
     */
    async executeCrossPromotionClearing(execution, _actorPersonId, input) {
      const result = await crossPromotionClearingService.executeCrossPromotionClearing(
        getExecutionContext() ?? execution,
        {
          sourceContributionId: input.sourceContributionId as string,
          targetPlacementId: input.targetPlacementId as string,
          valueRecordId: input.valueRecordId as string,
          idempotencyKey: input.idempotencyKey as string,
          ...(input.clearingRuleId !== undefined
            ? { clearingRuleId: input.clearingRuleId as string }
            : {}),
          ...(input.creditsPerValueUnit !== undefined
            ? { creditsPerValueUnit: input.creditsPerValueUnit as number }
            : {}),
          ...(input.cashKind !== undefined
            ? { cashKind: input.cashKind as string }
            : {}),
          ...(input.counterpartyPersonId !== undefined
            ? { counterpartyPersonId: input.counterpartyPersonId as string }
            : {}),
          ...(input.cashAmount !== undefined
            ? { cashAmount: input.cashAmount as number }
            : {}),
          ...(input.description !== undefined
            ? { description: input.description as string }
            : {}),
        },
      );
      return {
        drawKind: result.drawKind,
        clearing: toCrossPromotionClearingView(result.clearing),
        ...(result.allocation !== undefined
          ? { allocation: toRewardAllocationView(result.allocation) }
          : {}),
        ...(result.issuance !== undefined
          ? { issuance: toCreditIssuanceView(result.issuance) }
          : {}),
        ...(result.obligation !== undefined
          ? { obligation: toCashObligationView(result.obligation) }
          : {}),
        created: result.created,
        value: toEconomicValueView(result.value),
        campaignEventCount: result.campaignEventCount,
      };
    },
    /** The DERIVED eligibility view (AC-02; public read). */
    async evaluateCrossPromotionClearing(execution, input) {
      return crossPromotionClearingService.evaluateClearingEligibility(
        getExecutionContext() ?? execution,
        {
          organizationScopeId: input.organizationScopeId as string,
          sourceContributionId: input.sourceContributionId as string,
          targetPlacementId: input.targetPlacementId as string,
          valueRecordId: input.valueRecordId as string,
          ...(input.clearingRuleId !== undefined
            ? { clearingRuleId: input.clearingRuleId as string }
            : {}),
        },
      );
    },

    async getCrossPromotionClearing(execution, organizationScopeId, clearingId) {
      const clearing = await crossPromotionClearingService.getCrossPromotionClearing(
        getExecutionContext() ?? execution,
        organizationScopeId,
        clearingId,
      );
      return toCrossPromotionClearingView(clearing);
    },

    async listCrossPromotionClearings(execution, organizationScopeId) {
      const clearings = await crossPromotionClearingService.listCrossPromotionClearings(
        getExecutionContext() ?? execution,
        organizationScopeId,
      );
      return clearings.map(toCrossPromotionClearingView);
    },
  };

  const registry = createModuleRegistry(snapshot, logger);
  // Register all boundary modules. Domain modules are skeletal (§5).
  const boundaryModules = [
    identityModule, organizationsModule, participantsModule,
    opportunitiesModule, contributionsModule, campaignsModule,
    inventoryModule, creatorsModule, demandModule, benefitsModule,
    reputationModule, evidenceModule, outcomesModule, settlementModule,
    disputesModule, workflowsModule,
    apiModule, workersModule, auditModule, persistenceModule,
    queuesModule, objectStorageModule, secretsModule, observabilityModule,
    configModule,
    llmModule, agentsModule, adaptersModule, measurementModule,
    paymentsModule, ledgerModule,
  ];
  for (const m of boundaryModules) registry.register(m);

  // Representative non-domain ECHO job handler (AC-03, AC-05). It does
  // NOT perform domain behaviour: it logs, audits, and returns.
  const echoHandler: JobHandler<{ message: string }> = {
    type: "echo",
    async handle(ctx, payload) {
      ctx.logger.info("echo.handled", { message: payload.message });
      return { echoed: payload.message };
    },
  };

  const workerLoop = createWorkerLoop({
    queue,
    logger,
    auditWriter,
    pollIntervalMs: 25,
  });
  workerLoop.registerHandler(echoHandler);

  const health = new HealthAggregator();
  health.register("config", {
    name: "config",
    async check() {
      return { name: "config", status: "pass" as const, observedAt: new Date().toISOString() };
    },
  });
  health.register("queue", {
    name: "queue",
    async check() {
      return { name: "queue", status: "pass" as const, observedAt: new Date().toISOString() };
    },
  });
  health.register("audit", {
    name: "audit",
    async check() {
      return { name: "audit", status: "pass" as const, observedAt: new Date().toISOString() };
    },
  });

  const runtime: Runtime = {
    config,
    logger,
    auditWriter,
    objectStore,
    secretProvider,
    postgresAuthority,
    coordinationService,
    providerSelection,
    attestationSigning: {
      mode: attestationSigning.mode,
      // NET-W029: the ACTIVE closed-vocabulary identifiers of the
      // versioned selection (diagnostics only; no key material).
      algorithm: versionedAttestationSigning.algorithm,
      keyReference: versionedAttestationSigning.keyReference,
    },
    queue,
    workerLoop,
    registry,
    health,
    api: createApiServer({
      port: opts.port ?? snapshot.port,
      logger: logger.forModule("api"),
      config: snapshot,
      health,
      registry,
      enqueueEchoJob: (message) => runtime.enqueueEchoJob(message),
      auth: apiAuth,
      commands: apiCommands,
    }),
    logSink,
    identityService,
    organizationService,
    membershipService,
    participantService,
    authorizationService,
    policyService,
    apiAuth,
    apiCommands,
    // NET-W004 domain services.
    opportunityService,
    contributionService,
    workflowService,
    // NET-W005 domain services.
    evidenceService,
    outcomeClaimService,
    attestationService,
    // NET-W029 domain service (the versioned signed-attestation surface).
    signedAttestationService,
    proofOfValueService,
    // NET-W006 domain services.
    outcomeObservationService,
    measurementExperimentService,
    attributionService,
    incrementalityService,
    baselineService,
    measuredOutcomeService,
    measurementProviders,
    measurementIngestion,
    openRtbProviders,
    openRtbIngress,
    openRtbSellerAuthorizationTrust: {
      configured: sellerAuthorizationTrustKey !== undefined,
      algorithm: "hmac-sha256",
    },
    // NET-W007 domain services.
    reputationPolicyService,
    reputationInputService,
    reputationSnapshotService,
    // NET-W031 domain service (portable reputation proofs).
    reputationProofService,
    // NET-W008 domain services.
    economicValueService,
    creditService,
    rewardPolicyService,
    rewardService,
    cashService,
    conversionService,
    economicLedgerService,
    // NET-W010 stake escrow.
    stakeService,
    // NET-W030 external settlement adapters (facts, never authority).
    externalSettlementService,
    externalSettlementProviders,
    externalSettlementTrust: {
      configuredProviders: externalSettlementAuthentication.configuredProviders,
    },
    // NET-W009 disputes (fraud/risk foundation) services.
    riskSignalService,
    riskPolicyService,
    riskAssessmentService,
    riskCaseService,
    riskControlService,
    // NET-W010 disputes (challenges/disputes/appeals) service.
    disputeService,
    // NET-W011 campaigns (campaign policy/configuration) service.
    campaignService,
    // NET-W021 campaign matching and optimization.
    campaignMatchingService,
    // NET-W015 creators (creator identity and preferences) service.
    creatorService,
    // NET-W016 creator matching (deterministic eligibility + ranking).
    creatorMatchingService,
    // NET-W017 UGC workflow and rights (creator engagements).
    creatorEngagementService,
    creatorSponsorshipService,
    // NET-W019 inventory (supply registration + placement context).
    inventoryService,
    // NET-W020 cross-promotion clearing (records + derived eligibility).
    crossPromotionClearingService,
    // NET-W024 demand (consumer demand pools) service.
    demandService,
    // NET-W025 demand (business procurement pools) service.
    procurementService,
    // NET-W026 demand (supplier offers + competitive selection)
    // service.
    supplierOfferService,
    // NET-W027 demand (verified savings and counterfactuals) service.
    procurementSavingsService,
    // NET-W028 benefits (Benefit Pools) service.
    benefitPoolService,
    helpfulnessService,
    // NET-W013 quality/moderation/anti-spam services + LLM providers.
    qualityService,
    moderationService,
    llmProviders,
    llmProvider,
    // NET-W003 IdempotencyStore (exposed for NET-W004 integration tests).
    idempotency,
    async initialize() {
      // Provider-neutral measurement adapters initialize with the
      // runtime (concrete providers establish their clients here).
      for (const provider of measurementProviders) {
        await provider.initialize();
      }
      // NET-W013: the provider-neutral LLM adapters initialize with
      // the runtime as well (concrete providers establish clients
      // here; the echo reference adapter is a no-op).
      for (const provider of llmProviders) {
        await provider.initialize();
      }
      const states = await registry.initializeAll();
      return states.map((s) => ({ name: s.name, initialized: s.initialized }));
    },
    async shutdown() {
      await workerLoop.stop();
      await runtime.api.stop();
      await registry.shutdownAll();
      // Release the selected providers' resources (real adapter
      // pools/connections in production/staging; no-op for dev/test
      // shims). Best-effort: never let a provider-close failure mask
      // other shutdown errors.
      await providerSelection.close();
    },
    async enqueueEchoJob(message) {
      const parent = getExecutionContext();
      const ctx = parent
        ? deriveExecutionContext(parent, {})
        : createExecutionContext({ actor: { id: "api", kind: "service" } });
      const result = await queue.enqueue(
        "echo",
        { message },
        ctx,
        { idempotencyKey: `echo:${message}` },
      );
      return result.id;
    },
  };

  return runtime;
}

export { runWithExecutionContextAsync };
