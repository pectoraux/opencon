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
import type { AuditWriter } from "../core/audit.ts";
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
  readonly auditWriter: AuditWriter;
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

  const auditWriter = createInMemoryAuditWriter({ logger: logger.child("audit") });
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
    async initialize() {
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
