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
import type { ApiAuth, ApiCommands } from "../api/port.ts";
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
import { selectAttestationSigning, type AttestationSigningMode } from "./attestation-signing.ts";
import type {
  AttestationService,
  AttestationSigner,
  AttestationVerifier,
  CreateEvidenceInput,
  CreateOutcomeClaimInput,
  EvidenceService,
  OutcomeClaimService,
  ProofOfValueService,
  SubjectLookup,
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
  MeasurementProviderAdapter,
} from "../measurement/port.ts";
import { echoMeasurementProvider } from "../measurement/providers/echo-measurement-provider.ts";
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
import type {
  ComputeReputationScoresInput,
  CreateReputationScoringPolicyInput,
  RecordReputationInputInput,
  RecordReputationSnapshotInput,
  ReputationInputService,
  ReputationPolicyService,
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
import { createRewardPolicyService, createRewardService } from "../settlement/reward-service.ts";
import { createCashService } from "../settlement/cash-service.ts";
import { createConversionService } from "../settlement/conversion-service.ts";
import { createStakeService } from "../settlement/stake-service.ts";
import { createEconomicLedgerService } from "../settlement/ledger-service.ts";
import type {
  AllocateRewardsInput,
  CashService,
  ConversionService,
  CreateRewardPolicyInput,
  CreditService,
  EconomicLedgerService,
  EconomicValueService,
  IssueCreditsInput,
  RecordCashObligationInput,
  RecordConversionInput,
  RecordPendingValueInput,
  RewardPolicyService,
  RewardService,
  StakeService,
} from "../settlement/port.ts";

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
import { createCampaignService } from "../campaigns/campaign-service.ts";
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
  CampaignPolicySections,
  CampaignService,
  DefineCampaignPolicyInput,
} from "../campaigns/port.ts";
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
   */
  readonly attestationSigning: { readonly mode: AttestationSigningMode };
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
  // NET-W007 domain services (exposed for integration/security tests).
  readonly reputationPolicyService: ReputationPolicyService;
  readonly reputationInputService: ReputationInputService;
  readonly reputationSnapshotService: ReputationSnapshotService;
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
  // NET-W012 helpful contributions (Proof-of-Helpfulness) service.
  readonly helpfulnessService: HelpfulnessService;
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
   */
  readonly attestation?: {
    readonly signer?: AttestationSigner;
    readonly verifier?: AttestationVerifier;
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
      return null;
    },
    async exists(subjectType, subjectId) {
      if (subjectType === "opportunity") return opportunityRepo.exists(subjectId);
      if (subjectType === "contribution") return contributionRepo.exists(subjectId);
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
      return null;
    },
    async exists(subjectType, subjectId) {
      if (subjectType === "opportunity") return opportunityRepo.exists(subjectId);
      if (subjectType === "contribution") return contributionRepo.exists(subjectId);
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
  const measurementProviders: readonly MeasurementProviderAdapter[] =
    opts.measurement?.providers?.length
      ? opts.measurement.providers
      : [echoMeasurementProvider];
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
  const economicLedgerRepo = createAuthorityEconomicLedgerRepository({
    authority: postgresAuthority,
    logger: { debug: (m, f) => logger.forModule("settlement").debug(m, f) },
  });
  const economicValueRepo = createAuthorityEconomicValueRepository({
    authority: postgresAuthority,
    logger: { debug: (m, f) => logger.forModule("settlement").debug(m, f) },
  });
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
  const riskLookups = {
    subject: riskSubjectLookup,
    evidence: riskEvidenceLookup,
    proofOfValue: riskProofOfValueLookup,
    measuredOutcome: riskMeasuredOutcomeLookup,
    contribution: riskContributionLookup,
    economic: riskEconomicLookup,
    reputation: riskReputationLookup,
    risk: riskRecordLookup,
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
      // control (HOLD/BLOCK) on value_maturation covering this record
      // or its beneficiary refuses the maturation. The composition
      // root consults the risk control registry BEFORE the settlement
      // mutation — the settlement domain code is untouched and the
      // fraud boundary never mutates economic state.
      const gated = await economicValueService.getValue(execution, input.valueRecordId);
      await refuseWhenGated(
        execution,
        gated.organizationScopeId,
        "value_maturation",
        gated.id,
        gated.beneficiaryPersonId,
      );
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
      // credit_issuance covering the source record or the beneficiary
      // refuses the issuance.
      await refuseWhenGated(
        execution,
        input.organizationScopeId,
        "credit_issuance",
        input.sourceValueRecordId,
        input.beneficiaryPersonId,
      );
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
      // reward_allocation covering the source record or its
      // beneficiary refuses the allocation.
      const gatedValue = await economicValueService.getValue(
        execution,
        input.sourceValueRecordId,
      );
      await refuseWhenGated(
        execution,
        input.organizationScopeId,
        "reward_allocation",
        input.sourceValueRecordId,
        gatedValue.beneficiaryPersonId,
      );
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
      // 3. Record the publication (domain bookkeeping + audit).
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
    attestationSigning: { mode: attestationSigning.mode },
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
    proofOfValueService,
    // NET-W006 domain services.
    outcomeObservationService,
    measurementExperimentService,
    attributionService,
    incrementalityService,
    baselineService,
    measuredOutcomeService,
    measurementProviders,
    // NET-W007 domain services.
    reputationPolicyService,
    reputationInputService,
    reputationSnapshotService,
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
    helpfulnessService,
    // NET-W003 IdempotencyStore (exposed for NET-W004 integration tests).
    idempotency,
    async initialize() {
      // Provider-neutral measurement adapters initialize with the
      // runtime (concrete providers establish their clients here).
      for (const provider of measurementProviders) {
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
