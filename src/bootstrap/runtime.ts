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
import { createWorkflowService } from "../workflows/workflow-service.ts";
import { createLifecycleRepository } from "../workflows/lifecycle-repository.ts";
import type { OpportunityService } from "../opportunities/port.ts";
import type { ContributionService, OpportunityLookup } from "../contributions/port.ts";
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
