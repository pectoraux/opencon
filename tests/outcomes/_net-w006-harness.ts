/**
 * NET-W006 shared test harness.
 *
 * Extends the NET-W005 harness pattern: runtime + authenticated
 * principal + organization + allow policies for the outcomes-layer
 * API guard actions (outcomeObservation.*, measurementExperiment.*,
 * attribution.create, incrementality.create, baseline.create,
 * measuredOutcome.*, workflow.transition) + the per-transition
 * policies seeded from the OUTCOME_MEASUREMENT_TRANSITION_TABLE (so
 * every legal measured-outcome transition's policyAction matches a
 * policy for the harness person on the harness organization).
 *
 * The harness uses the file-backed PostgresAuthorityShim (test/dev
 * double from NET-W003) so it runs without a real PostgreSQL.
 */

import { createRuntime, type Runtime } from "../../src/bootstrap/runtime.ts";
import { createExecutionContext } from "../../src/core/execution-context.ts";
import type { ExecutionContext } from "../../src/core/execution-context.ts";
import { OUTCOME_MEASUREMENT_TRANSITION_TABLE } from "../../src/workflows/transition-table.ts";
import type {
  MeasurementProviderAdapter,
  ProviderObservationFetchResult,
  ProviderObservationFetchRequest,
  ProviderObservationReport,
} from "../../src/measurement/port.ts";
import type {
  MeasurementExperiment,
  MeasuredOutcome,
  OutcomeObservation,
} from "../../src/outcomes/port.ts";

export interface NetW006Harness {
  readonly runtime: Runtime;
  /** Bootstrap execution context (system actor). */
  readonly bootstrapCtx: ExecutionContext;
  /** The canonical person identity id of the authorized actor. */
  readonly personId: string;
  /** The subject id used by the API auth guard (X-Auth-Subject-Id). */
  readonly subjectId: string;
  /** The organization scope id (the tenant). */
  readonly organizationScopeId: string;
  /** Tear down the harness (shutdown the runtime). */
  teardown(): Promise<void>;
}

export interface NetW006HarnessOptions {
  /**
   * Provider-neutral measurement provider adapters wired through the
   * composition root (exercises the provider ingestion path). When
   * omitted the reference ECHO adapter applies (it reports nothing).
   */
  readonly measurement?: {
    readonly providers?: readonly MeasurementProviderAdapter[];
  };
}

/**
 * A configurable stub measurement provider (test double for the
 * provider-neutral adapter contract — the same shape NET-W022's
 * concrete attribution adapters will implement).
 */
export function createStubProvider(
  providerId: string,
  reports: readonly ProviderObservationReport[],
): MeasurementProviderAdapter {
  return {
    info: { kind: "measurement", provider: providerId, version: "1.0.0" },
    async initialize() {},
    async healthCheck() {
      return { ok: true };
    },
    async fetchObservations(
      _request: ProviderObservationFetchRequest,
    ): Promise<ProviderObservationFetchResult> {
      return { observations: reports, nextCursor: null };
    },
  };
}

export async function createNetW006Harness(
  opts: NetW006HarnessOptions = {},
): Promise<NetW006Harness> {
  const runtime = createRuntime({
    forceEnv: "test",
    env: { APP_ENV: "test", LOG_LEVEL: "warn" },
    port: 0,
    ...(opts.measurement ? { measurement: opts.measurement } : {}),
  });
  await runtime.initialize();
  await runtime.api.start();
  const bootstrapCtx = createExecutionContext({
    correlationId: "net-w006-bootstrap",
    actor: { id: "bootstrap", kind: "service" },
  });
  // Create a canonical person identity for the authorized actor.
  const person = await runtime.identityService.createIdentity(bootstrapCtx, {
    displayName: "Measurement Actor",
    subjectReferences: [{ subjectId: "measurer@example.com", providerKind: "internal" }],
  });
  // Create an organization the actor will act in.
  const org = await runtime.organizationService.createOrganization(bootstrapCtx, {
    name: "Measurement Org",
    creatorId: person.id,
  });

  // Seed ALLOW policies: API guard actions for the NET-W006 endpoints
  // (resource "*") + per-transition policies scoped to the HARNESS
  // PERSON on the harness organization.
  const guardActions = [
    "opportunity.create",
    "contribution.create",
    "workflow.transition",
    "outcomeObservation.create",
    "outcomeObservation.correct",
    "outcomeObservation.ingest",
    "measurementExperiment.create",
    "measurementExperiment.start",
    "measurementExperiment.complete",
    "measurementExperiment.invalidate",
    "attribution.create",
    "incrementality.create",
    "baseline.create",
    "measuredOutcome.create",
    "measuredOutcome.attachObservation",
    "measuredOutcome.attachAttribution",
    "measuredOutcome.attachBaseline",
    "measuredOutcome.attachIncrementality",
    "measuredOutcome.recordRollup",
  ];
  for (const action of guardActions) {
    await runtime.policyService.createPolicy(bootstrapCtx, {
      subject: "*",
      action,
      resource: "*",
      effect: "allow",
      createdBy: "bootstrap",
    });
  }
  for (const rule of OUTCOME_MEASUREMENT_TRANSITION_TABLE) {
    await runtime.policyService.createPolicy(bootstrapCtx, {
      subject: person.id,
      action: rule.policyAction,
      resource: org.id,
      effect: "allow",
      createdBy: "bootstrap",
    });
  }

  return {
    runtime,
    bootstrapCtx,
    personId: person.id,
    subjectId: "measurer@example.com",
    organizationScopeId: org.id,
    async teardown() {
      await runtime.shutdown();
    },
  };
}

/** Create an execution context for the harness person. */
export function actorCtx(harness: NetW006Harness, correlationId: string): ExecutionContext {
  return createExecutionContext({
    correlationId,
    actor: { id: harness.personId, kind: "person" },
  });
}

/** Create a contribution to measure (opportunity → contribution). */
export async function createMeasuredSubject(
  harness: NetW006Harness,
): Promise<{ id: string; organizationScopeId: string }> {
  const oppCtx = actorCtx(harness, "w006-subject-opportunity");
  const opp = await harness.runtime.opportunityService.createOpportunity(oppCtx, {
    organizationScopeId: harness.organizationScopeId,
    ownerId: harness.personId,
    opportunityType: "test-opportunity",
    title: "Measured Opportunity",
    brief: { kind: "test" },
  });
  const cCtx = actorCtx(harness, "w006-subject-contribution");
  const c = await harness.runtime.contributionService.createContribution(cCtx, {
    opportunityId: opp.id,
    contributorId: harness.personId,
    organizationScopeId: harness.organizationScopeId,
    contributionType: "test-contribution",
    submission: { kind: "test" },
  });
  return { id: c.id, organizationScopeId: c.organizationScopeId };
}

/** Default provenance factory for observations. */
export interface CreateObservationOptions {
  readonly sourceType?: "platform" | "attested" | "provider" | "model" | "self";
  readonly sourceId?: string;
  readonly method?: string;
  readonly methodVersion?: string;
  readonly collectedAt?: string;
  readonly value?: number;
  readonly unit?: string;
  readonly point?: number;
  readonly lower?: number;
  readonly upper?: number;
  readonly outcomeType?: string;
  readonly outcomeClaimId?: string;
  readonly evidenceId?: string;
}

export async function createObservation(
  harness: NetW006Harness,
  subjectId: string,
  opts: CreateObservationOptions = {},
): Promise<OutcomeObservation> {
  const ctx = actorCtx(harness, "w006-observation");
  return harness.runtime.outcomeObservationService.createOutcomeObservation(ctx, {
    organizationScopeId: harness.organizationScopeId,
    observerId: harness.personId,
    subjectReference: { subjectId, subjectType: "contribution" },
    outcomeType: (opts.outcomeType ?? "install") as "install",
    ...(opts.outcomeClaimId !== undefined ? { outcomeClaimId: opts.outcomeClaimId } : {}),
    ...(opts.evidenceId !== undefined ? { evidenceId: opts.evidenceId } : {}),
    observedValue: { value: opts.value ?? 12, unit: opts.unit ?? "installs" },
    confidence: {
      point: opts.point ?? 0.95,
      ...(opts.lower !== undefined ? { lower: opts.lower } : {}),
      ...(opts.upper !== undefined ? { upper: opts.upper } : {}),
    },
    provenance: {
      sourceType: opts.sourceType ?? "platform",
      ...(opts.sourceId !== undefined ? { sourceId: opts.sourceId } : {}),
      method: opts.method ?? "platform-counter",
      methodVersion: opts.methodVersion ?? "1.0.0",
      ...(opts.collectedAt !== undefined ? { collectedAt: opts.collectedAt } : {}),
    },
  });
}

/** Create a measured outcome (DRAFT, version 0) for a subject. */
export interface CreateMeasurementOptions {
  readonly outcomeType?: string;
  readonly maturationStrategy?: "immediate" | "fixed_window" | "event_driven";
  readonly windowStartAt?: string;
  readonly windowEndAt?: string;
  readonly maturationBasis?: string;
  readonly rollupStrategy?: "sum" | "latest";
  readonly observationIds?: readonly string[];
}

export async function createMeasuredOutcome(
  harness: NetW006Harness,
  subjectId: string,
  opts: CreateMeasurementOptions = {},
): Promise<MeasuredOutcome> {
  const ctx = actorCtx(harness, "w006-measurement");
  return harness.runtime.measuredOutcomeService.createMeasuredOutcome(ctx, {
    organizationScopeId: harness.organizationScopeId,
    ownerId: harness.personId,
    subjectReference: { subjectId, subjectType: "contribution" },
    outcomeType: (opts.outcomeType ?? "install") as "install",
    maturation: {
      strategy: opts.maturationStrategy ?? "immediate",
      ...(opts.windowStartAt !== undefined ? { windowStartAt: opts.windowStartAt } : {}),
      ...(opts.windowEndAt !== undefined ? { windowEndAt: opts.windowEndAt } : {}),
      ...(opts.maturationBasis !== undefined ? { maturationBasis: opts.maturationBasis } : {}),
    },
    ...(opts.rollupStrategy !== undefined ? { rollupStrategy: opts.rollupStrategy } : {}),
    observationIds: opts.observationIds ?? [],
  });
}

/** Create + run an experiment to COMPLETED status. */
export async function createCompletedExperiment(
  harness: NetW006Harness,
  experimentType = "holdout",
): Promise<MeasurementExperiment> {
  const ctx = actorCtx(harness, "w006-experiment");
  const experiment = await harness.runtime.measurementExperimentService.createMeasurementExperiment(
    ctx,
    {
      organizationScopeId: harness.organizationScopeId,
      ownerId: harness.personId,
      experimentType,
      hypothesis: "treatment lifts installs",
    },
  );
  const started = await harness.runtime.measurementExperimentService.startExperiment(ctx, {
    experimentId: experiment.id,
    expectedVersion: experiment.version,
  });
  return harness.runtime.measurementExperimentService.completeExperiment(ctx, {
    experimentId: started.id,
    expectedVersion: started.version,
  });
}

/** Build the transition input for a measured-outcome lifecycle operation. */
export function measurementTransitionInput(
  harness: NetW006Harness,
  measurementId: string,
  expectedVersion: number,
  idempotencyKey: string,
): {
  measurementId: string;
  expectedVersion: number;
  idempotencyKey: string;
  actorPersonId: string;
} {
  return {
    measurementId,
    expectedVersion,
    idempotencyKey,
    actorPersonId: harness.personId,
  };
}

/**
 * Drive a measurement DRAFT → MEASURING → (rollup) → VERIFIED using
 * the immediate strategy (no maturation gate). Returns the finalized
 * measurement.
 */
export async function finalizeImmediateMeasurement(
  harness: NetW006Harness,
  subjectId: string,
  observationIds: readonly string[],
): Promise<MeasuredOutcome> {
  const ctx = actorCtx(harness, "w006-finalize");
  const measurement = await createMeasuredOutcome(harness, subjectId, {
    observationIds,
    maturationStrategy: "immediate",
  });
  await harness.runtime.measuredOutcomeService.beginMaturation(
    ctx,
    measurementTransitionInput(harness, measurement.id, 0, `begin-${measurement.id}`),
  );
  await harness.runtime.measuredOutcomeService.recordMeasurementRollup(ctx, measurement.id);
  const result = await harness.runtime.measuredOutcomeService.finalize(
    ctx,
    measurementTransitionInput(harness, measurement.id, 1, `finalize-${measurement.id}`),
  );
  return result.measurement;
}
