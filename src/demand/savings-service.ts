/**
 * The NET-W027 savings/counterfactual domain service — material
 * baseline/savings commands + the derived savings view (PROC-002 +
 * PROC-AC-01's gate + OUT-004/EVID-005 alignment). Lives INSIDE the
 * /demand boundary (verified savings and counterfactuals — the SAME
 * frozen domain NET-W024/W025/W026 activated; there is NO second
 * demand/procurement authority).
 *
 * Work order ref: spec/work-orders/NET-W027.md §4/§5/§6.
 *
 * Material commands follow the NET-W003/004/008/019/020/024/025/026
 * conventions exactly: validation (closed vocabularies, bounds, fail
 * closed) → server-resolved acting person → pre-flight tenant-anchored
 * reads (cross-tenant = NotFoundError — no existence oracle) →
 * membership/pool-creator gates → composite idempotency key →
 * concurrency control where a same-scope invariant must conserve →
 * applyIdempotent on ONE authoritative transaction → in-tx fresh
 * same-boundary reads + gate RE-DERIVATION (TOCTOU closure) →
 * neutral-lookup /evidence + /outcomes fact resolution at the ONE
 * anchor → ...WithinTx writes → transactional audit buffer → COMMIT.
 *
 * The derived evaluation mutates and audits NOTHING (a derived 200
 * decision — the W019/W023/W024/W025/W026 precedent). The savings
 * RECORD fails closed on unsupported derivations (the
 * derived-vs-authoritative split).
 *
 * There is NO economic mutation surface anywhere in this service
 * (/settlement is untouched by NET-W027 — a verified savings claim
 * is a MEASUREMENT DECISION, never an economic one) and NO lifecycle
 * machinery (/workflows is untouched: baseline invalidation is a
 * one-way field mutation; evidence staleness and observation
 * supersession are DERIVED at the evaluation anchor, never mutated).
 */

import { randomUUID } from "node:crypto";
import { AuthorizationError, NotFoundError } from "../core/errors.ts";
import { isEvidenceSourceType } from "../core/evidence.ts";
import type { MeasurementProvenance } from "../core/measurement.ts";
import {
  PROCUREMENT_BASELINE_RECORD_FORMAT,
  PROCUREMENT_SAVINGS_RECORD_FORMAT,
  PROCUREMENT_SAVINGS_SUBJECT_TYPE,
  InvalidProcurementSavingsError,
  ProcurementSavingsConflictError,
  validateProcurementBaselineAttributes,
  validateProcurementBaselineConfidence,
  validateProcurementBaselineEvidenceRefs,
  validateProcurementBaselineInvalidationReason,
  validateProcurementSavingsObservationRefs,
} from "../core/procurement-savings.ts";
import type { ExecutionContext } from "../core/execution-context.ts";
import type { AuthorityTransaction } from "../core/postgres-authority.ts";
import type {
  CreateProcurementBaselineInput,
  CreateProcurementBaselineResult,
  EvaluateProcurementSavingsInput,
  InvalidateProcurementBaselineInput,
  ProcurementBaseline,
  ProcurementPool,
  ProcurementSavings,
  ProcurementSavingsEvidenceFacts,
  ProcurementSavingsOutcomeObservationFacts,
  ProcurementSavingsService,
  ProcurementSavingsServiceDeps,
  ProcurementSavingsView,
  RecordProcurementSavingsInput,
  RecordProcurementSavingsResult,
} from "./port.ts";
import { deriveProcurementSavings } from "./savings-engine.ts";

const PROCUREMENT_BASELINE_CREATED = "procurement_baseline.created" as const;
const PROCUREMENT_BASELINE_INVALIDATED =
  "procurement_baseline.invalidated" as const;
const PROCUREMENT_SAVINGS_RECORDED = "procurement_savings.recorded" as const;

function savingsError(
  message: string,
  context: Readonly<Record<string, unknown>>,
): InvalidProcurementSavingsError {
  return new InvalidProcurementSavingsError(message, context);
}

function assertIdempotencyKey(idempotencyKey: string): string {
  if (typeof idempotencyKey !== "string" || !idempotencyKey.trim()) {
    throw savingsError("idempotencyKey is required", {
      field: "idempotencyKey",
    });
  }
  return idempotencyKey;
}

function assertOrganizationScopeId(organizationScopeId: string): string {
  if (
    typeof organizationScopeId !== "string" ||
    !organizationScopeId.trim()
  ) {
    throw savingsError("organizationScopeId is required", {
      field: "organizationScopeId",
    });
  }
  return organizationScopeId;
}

function assertPoolId(poolId: string): string {
  if (typeof poolId !== "string" || !poolId.trim()) {
    throw savingsError("poolId is required", { field: "poolId" });
  }
  return poolId;
}

function assertBaselineId(baselineId: string): string {
  if (typeof baselineId !== "string" || !baselineId.trim()) {
    throw savingsError("baselineId is required", { field: "baselineId" });
  }
  return baselineId;
}

/** The acting person's id (recorded as createdBy/recordedBy). */
function actingPersonId(execution: ExecutionContext): string {
  if (!execution.actor || execution.actor.kind !== "person") {
    throw new AuthorizationError(
      "procurement savings commands require an authenticated person actor",
      { actorKind: execution.actor?.kind ?? null },
    );
  }
  return execution.actor.id;
}

function nowIso(): string {
  return new Date().toISOString();
}

export function createProcurementSavingsService(
  deps: ProcurementSavingsServiceDeps,
): ProcurementSavingsService {
  const {
    baselineRepository,
    savingsRepository,
    poolRepository,
    selectionRepository,
    membershipLookup,
    evidenceLookup,
    outcomeLookup,
    idempotency,
    auditWriter,
    logger,
  } = deps;

  async function requirePool(
    organizationScopeId: string,
    id: string,
  ): Promise<ProcurementPool> {
    const pool = await poolRepository.findById(id);
    if (!pool || pool.organizationScopeId !== organizationScopeId) {
      // Cross-tenant is indistinguishable from nonexistent (no
      // existence oracle — issue #54 invariant 6).
      throw new NotFoundError(`procurement pool not found: ${id}`, {
        id,
        organizationScopeId,
      });
    }
    return pool;
  }

  async function requirePoolWithinTx(
    organizationScopeId: string,
    id: string,
    tx: AuthorityTransaction,
  ): Promise<ProcurementPool> {
    const pool = await poolRepository.getByIdWithinTx(id, tx);
    if (!pool || pool.organizationScopeId !== organizationScopeId) {
      throw new NotFoundError(`procurement pool not found: ${id}`, {
        id,
        organizationScopeId,
      });
    }
    return pool;
  }

  async function requireBaseline(
    organizationScopeId: string,
    id: string,
  ): Promise<ProcurementBaseline> {
    const baseline = await baselineRepository.findById(id);
    if (!baseline || baseline.organizationScopeId !== organizationScopeId) {
      // Cross-tenant is indistinguishable from nonexistent (no
      // existence oracle — issue #54 invariant 6).
      throw new NotFoundError(`procurement baseline not found: ${id}`, {
        id,
        organizationScopeId,
      });
    }
    return baseline;
  }

  async function requireBaselineWithinTx(
    organizationScopeId: string,
    id: string,
    tx: AuthorityTransaction,
  ): Promise<ProcurementBaseline> {
    const baseline = await baselineRepository.getByIdWithinTx(id, tx);
    if (!baseline || baseline.organizationScopeId !== organizationScopeId) {
      throw new NotFoundError(`procurement baseline not found: ${id}`, {
        id,
        organizationScopeId,
      });
    }
    return baseline;
  }

  /**
   * The derivation's baseline/pool binding: the baseline must belong
   * to the pool the derivation names (fail closed — a baseline of
   * another pool is never a valid reference for this pool's realized
   * outcome comparison).
   */
  function requireBaselineForPool(
    baseline: ProcurementBaseline,
    poolId: string,
  ): void {
    if (baseline.poolId !== poolId) {
      throw savingsError(
        `procurement baseline does not belong to pool ${poolId}`,
        { field: "baselineId", baselineId: baseline.id, poolId },
      );
    }
  }

  /**
   * The neutral W026 lineage reference validation: a named selection
   * must resolve in tenant scope AND belong to the same pool —
   * otherwise it is indistinguishable from nonexistent (no existence
   * oracle; the selection is NEVER savings truth).
   */
  async function requireSelectionReference(
    organizationScopeId: string,
    poolId: string,
    selectionId: string,
  ): Promise<void> {
    const selection = await selectionRepository.findById(selectionId);
    if (
      !selection ||
      selection.organizationScopeId !== organizationScopeId ||
      selection.poolId !== poolId
    ) {
      throw new NotFoundError(
        `competitive selection not found: ${selectionId}`,
        { id: selectionId, organizationScopeId, poolId },
      );
    }
  }

  /**
   * The caller-named evidence references (CREATE path): each id MUST
   * resolve through the NEUTRAL /evidence lookup in tenant scope
   * (missing/cross-tenant ⇒ NotFoundError — indistinguishable from
   * nonexistent) AND be subject-bound to this procurement pool (the
   * W017/W018 evidence-binding precedent). Evidence SUFFICIENCY (the
   * qualifying source-type rule) is NOT enforced here — it is
   * re-derived at every evaluation anchor.
   */
  async function requireEvidenceReferences(
    organizationScopeId: string,
    poolId: string,
    evidenceIds: readonly string[],
  ): Promise<readonly ProcurementSavingsEvidenceFacts[]> {
    const facts: ProcurementSavingsEvidenceFacts[] = [];
    for (const evidenceId of evidenceIds) {
      const resolved = await evidenceLookup.resolve(evidenceId);
      if (
        !resolved ||
        resolved.organizationScopeId !== organizationScopeId
      ) {
        throw new NotFoundError(`evidence record not found: ${evidenceId}`, {
          id: evidenceId,
          organizationScopeId,
        });
      }
      if (
        resolved.subjectType !== PROCUREMENT_SAVINGS_SUBJECT_TYPE ||
        resolved.subjectId !== poolId
      ) {
        throw savingsError(
          `evidence reference is not bound to this procurement pool: ${evidenceId} (subject: ${resolved.subjectType}:${resolved.subjectId})`,
          {
            field: "evidenceIds",
            evidenceId,
            subjectType: resolved.subjectType,
            subjectId: resolved.subjectId,
            poolId,
          },
        );
      }
      facts.push(resolved);
    }
    return facts;
  }

  /**
   * The baseline's stored evidence references re-resolved at the
   * derivation anchor (nullable — an unresolvable reference fails
   * closed through the derivation's evidence-sufficiency check,
   * never a crash: evidence records are immutable, so this is pure
   * defense in depth).
   */
  async function resolveBaselineEvidence(
    organizationScopeId: string,
    baseline: ProcurementBaseline,
  ): Promise<readonly (ProcurementSavingsEvidenceFacts | null)[]> {
    const resolved: (ProcurementSavingsEvidenceFacts | null)[] = [];
    for (const evidenceId of baseline.evidenceIds) {
      const facts = await evidenceLookup.resolve(evidenceId);
      resolved.push(
        facts && facts.organizationScopeId === organizationScopeId
          ? facts
          : null,
      );
    }
    return resolved;
  }

  /**
   * The caller-named observation references: each id MUST resolve
   * through the NEUTRAL /outcomes lookup in tenant scope
   * (missing/cross-tenant ⇒ NotFoundError — indistinguishable from
   * nonexistent). Subject binding, outcome type, chain-head position,
   * source type and freshness are DERIVATION checks (fail closed
   * through the machine-readable verdict — never pre-filtered).
   */
  async function requireObservationReferences(
    organizationScopeId: string,
    observationIds: readonly string[],
  ): Promise<readonly ProcurementSavingsOutcomeObservationFacts[]> {
    const facts: ProcurementSavingsOutcomeObservationFacts[] = [];
    for (const observationId of observationIds) {
      const resolved = await outcomeLookup.resolve(observationId);
      if (
        !resolved ||
        resolved.organizationScopeId !== organizationScopeId
      ) {
        throw new NotFoundError(
          `outcome observation not found: ${observationId}`,
          { id: observationId, organizationScopeId },
        );
      }
      facts.push(resolved);
    }
    return facts;
  }

  async function appendAudit(
    tx: AuthorityTransaction,
    event: {
      eventType: string;
      context: ExecutionContext;
      actor: string;
      subject: string;
      resourceType: string;
      resourceId: string;
      metadata: Record<string, unknown>;
    },
  ): Promise<void> {
    const buffer = auditWriter.forTransaction(tx);
    await buffer.append({
      eventType: event.eventType,
      context: event.context,
      actor: event.actor,
      subject: event.subject,
      resourceType: event.resourceType,
      resourceId: event.resourceId,
      metadata: event.metadata,
    });
  }

  /**
   * The server-enforced TENANT membership gate: the acting person
   * must hold an ACTIVE membership in the tenant organization —
   * resolved through the NEUTRAL lookup over the /organizations
   * authority (never a client claim; membership-based authorization,
   * the W025/W026 precedent).
   */
  async function requireActiveMember(
    organizationScopeId: string,
    personId: string,
  ): Promise<void> {
    const membership = await membershipLookup.resolveMembership(
      personId,
      organizationScopeId,
    );
    if (membership !== "active") {
      throw new AuthorizationError(
        "procurement savings commands require an active organization membership",
        {
          organizationScopeId,
          actorPersonId: personId,
          reason: membership === null ? "not_a_member" : "membership_not_active",
        },
      );
    }
  }

  const service: ProcurementSavingsService = {
    async createProcurementBaseline(
      execution,
      input: CreateProcurementBaselineInput,
    ): Promise<CreateProcurementBaselineResult> {
      assertOrganizationScopeId(input.organizationScopeId);
      assertPoolId(input.poolId);
      assertIdempotencyKey(input.idempotencyKey);
      const actor = actingPersonId(execution);
      // THE TENANT ANCHOR FIRST (the clearing-service principle: a
      // missing or cross-scope record fails closed BEFORE anything —
      // cross-tenant is indistinguishable from nonexistent, no
      // existence oracle).
      const pool = await requirePool(input.organizationScopeId, input.poolId);
      // Server-enforced authorization: an ACTIVE tenant membership +
      // the POOL-CREATOR gate (procurement outcome analysis stays
      // with the demand owner — the W026 selection-surface
      // precedent; a caller cannot fabricate baseline authority).
      await requireActiveMember(input.organizationScopeId, actor);
      requirePoolCreator(actor, pool);

      const submittedAt = nowIso();
      const attributes = validateProcurementBaselineAttributes(
        "input",
        {
          baselineKind: input.baselineKind,
          method: input.method,
          methodVersion: input.methodVersion,
          comparisonWindow: input.comparisonWindow,
          population: input.population,
          baselineValue: input.baselineValue,
        },
        submittedAt,
      );
      const confidence = validateProcurementBaselineConfidence(
        "input.confidence",
        input.confidence,
        attributes.baselineKind,
      );
      const evidenceIds = validateProcurementBaselineEvidenceRefs(
        "input.evidenceIds",
        input.evidenceIds,
      );
      // The baseline material provenance (sourceType from the closed
      // evidence vocabulary; collectedAt REQUIRED, parseable and not
      // in the future; the method + methodVersion are the validated
      // closed-vocabulary pair above — measurement provenance shape
      // is REUSED from the NET-W006 core contract, never redefined).
      const rawProvenance = input.provenance ?? {};
      if (
        typeof rawProvenance.sourceType !== "string" ||
        !isEvidenceSourceType(rawProvenance.sourceType)
      ) {
        throw savingsError(
          `input.provenance.sourceType must be a closed-vocabulary evidence source type (got ${String(rawProvenance.sourceType)})`,
          { field: "input.provenance.sourceType" },
        );
      }
      if (
        typeof rawProvenance.collectedAt !== "string" ||
        Number.isNaN(Date.parse(rawProvenance.collectedAt))
      ) {
        throw savingsError(
          "input.provenance.collectedAt must be a parseable ISO timestamp",
          { field: "input.provenance.collectedAt" },
        );
      }
      if (Date.parse(rawProvenance.collectedAt) > Date.parse(submittedAt)) {
        throw savingsError(
          "input.provenance.collectedAt may not be in the future relative to the submission time",
          {
            field: "input.provenance.collectedAt",
            collectedAt: rawProvenance.collectedAt,
          },
        );
      }
      const provenance: MeasurementProvenance = Object.freeze({
        sourceType: rawProvenance.sourceType,
        ...(rawProvenance.sourceId !== undefined
          ? { sourceId: rawProvenance.sourceId }
          : {}),
        method: attributes.method,
        methodVersion: attributes.methodVersion,
        collectedAt: rawProvenance.collectedAt,
        ...(rawProvenance.collectorId !== undefined
          ? { collectorId: rawProvenance.collectorId }
          : {}),
      });
      // The caller-named evidence references resolve through the
      // NEUTRAL /evidence lookup (scope + subject binding — fail
      // closed; sufficiency is re-derived at every anchor).
      await requireEvidenceReferences(
        input.organizationScopeId,
        input.poolId,
        evidenceIds,
      );

      const compositeKey = `procurement_baseline:${input.organizationScopeId}:${input.poolId}:${actor}:${input.idempotencyKey}`;
      // NOTE: NO per-pool advisory lock — there is NO create-once
      // constraint (multiple distinct baselines per pool are the
      // legitimate lineage: different methods/windows over time);
      // same-key replay is still exactly-once through the
      // IdempotencyStore (the W025 pool-creation precedent).
      const applied = await idempotency.applyIdempotent(
        compositeKey,
        async (ctx) => {
          const tx = ctx.transaction;
          // In-tx fresh pool read + scope + creator re-check (TOCTOU
          // closure — nothing caller-asserted authorizes).
          const freshPool = await requirePoolWithinTx(
            input.organizationScopeId,
            input.poolId,
            tx,
          );
          requirePoolCreator(actor, freshPool);
          const recordedAt = nowIso();
          const baseline: ProcurementBaseline = Object.freeze({
            id: randomUUID(),
            organizationScopeId: input.organizationScopeId,
            poolId: freshPool.id,
            // The creator IS the acting pool creator (server-resolved
            // above — there is no createdBy input).
            createdBy: actor,
            baselineKind: attributes.baselineKind,
            method: attributes.method,
            methodVersion: attributes.methodVersion,
            comparisonWindow: attributes.comparisonWindow,
            population: attributes.population,
            baselineValue: attributes.baselineValue,
            confidence,
            provenance,
            evidenceIds,
            invalidatedAt: null,
            invalidationReason: null,
            recordFormat: PROCUREMENT_BASELINE_RECORD_FORMAT,
            createdAt: recordedAt,
            updatedAt: recordedAt,
            idempotencyKey: input.idempotencyKey,
            executionId: execution.executionId,
            correlationId: execution.correlationId,
            causationId: execution.causationId,
          });
          await baselineRepository.createWithinTx(baseline, tx);
          await appendAudit(tx, {
            eventType: PROCUREMENT_BASELINE_CREATED,
            context: execution,
            actor,
            subject: baseline.id,
            resourceType: "procurement_baseline",
            resourceId: baseline.id,
            metadata: {
              organizationScopeId: baseline.organizationScopeId,
              poolId: baseline.poolId,
              baselineKind: baseline.baselineKind,
              method: baseline.method,
              methodVersion: baseline.methodVersion,
              comparisonWindow: {
                startsAt: baseline.comparisonWindow.startsAt,
                endsAt: baseline.comparisonWindow.endsAt,
              },
              population: baseline.population,
              baselineValue: {
                value: baseline.baselineValue.value,
                unit: baseline.baselineValue.unit,
              },
              confidencePoint: baseline.confidence.point,
              ...(baseline.confidence.lower !== undefined
                ? { confidenceLower: baseline.confidence.lower }
                : {}),
              ...(baseline.confidence.upper !== undefined
                ? { confidenceUpper: baseline.confidence.upper }
                : {}),
              provenanceSourceType: baseline.provenance.sourceType,
              provenanceCollectedAt: baseline.provenance.collectedAt,
              evidenceIds: [...baseline.evidenceIds],
              idempotencyRecordId: ctx.recordId,
              transactionId: tx.transactionId,
            },
          });
          return baseline;
        },
        execution,
      );
      return {
        baseline: applied.result,
        created: applied.executed,
      };
    },

    async invalidateProcurementBaseline(
      execution,
      input: InvalidateProcurementBaselineInput,
    ): Promise<ProcurementBaseline> {
      assertOrganizationScopeId(input.organizationScopeId);
      assertBaselineId(input.baselineId);
      assertIdempotencyKey(input.idempotencyKey);
      const actor = actingPersonId(execution);
      // Tenant anchor from the authority's own record (cross-tenant =
      // NotFoundError — no existence oracle).
      const baseline = await requireBaseline(
        input.organizationScopeId,
        input.baselineId,
      );
      const pool = await requirePool(
        input.organizationScopeId,
        baseline.poolId,
      );
      await requireActiveMember(input.organizationScopeId, actor);
      // The baseline belongs to the pool's demand owner: the
      // POOL-CREATOR gate (server-side — a caller cannot fabricate
      // invalidation authority).
      requirePoolCreator(actor, pool);
      const reason = validateProcurementBaselineInvalidationReason(
        "input.reason",
        input.reason,
      );
      const key = `procurement_baseline_invalidation:${input.organizationScopeId}:${input.baselineId}:${input.idempotencyKey}`;
      // NOTE: NO advisory lock (the one-way invalidation conserves by
      // construction — the idempotent-apply replay path and the
      // repository's already-invalidated guard; the W026
      // offer-withdrawal precedent).
      const applied = await idempotency.applyIdempotent(
        key,
        async (ctx) => {
          const tx = ctx.transaction;
          // In-tx fresh baseline + pool re-read and gate re-check
          // (TOCTOU closure).
          const fresh = await requireBaselineWithinTx(
            input.organizationScopeId,
            input.baselineId,
            tx,
          );
          const freshPool = await requirePoolWithinTx(
            input.organizationScopeId,
            fresh.poolId,
            tx,
          );
          requirePoolCreator(actor, freshPool);
          // One-way semantics: invalidation is TERMINAL — a fresh-key
          // invalidation of an already-invalidated baseline is a
          // stable conflict (never a second lifecycle event).
          if (fresh.invalidatedAt !== null) {
            throw new ProcurementSavingsConflictError(
              `procurement baseline is already invalidated: ${input.baselineId}`,
              {
                organizationScopeId: input.organizationScopeId,
                baselineId: input.baselineId,
                invalidatedAt: fresh.invalidatedAt,
                invalidationReason: fresh.invalidationReason,
              },
            );
          }
          const invalidated = await baselineRepository.invalidateWithinTx(
            fresh.id,
            nowIso(),
            reason,
            tx,
          );
          await appendAudit(tx, {
            eventType: PROCUREMENT_BASELINE_INVALIDATED,
            context: execution,
            actor,
            subject: invalidated.id,
            resourceType: "procurement_baseline",
            resourceId: invalidated.id,
            metadata: {
              organizationScopeId: invalidated.organizationScopeId,
              poolId: invalidated.poolId,
              invalidatedAt: invalidated.invalidatedAt,
              invalidationReason: invalidated.invalidationReason,
              idempotencyRecordId: ctx.recordId,
              transactionId: tx.transactionId,
            },
          });
          return invalidated;
        },
        execution,
      );
      return applied.result;
    },

    async listPoolBaselines(execution, input) {
      assertOrganizationScopeId(input.organizationScopeId);
      assertPoolId(input.poolId);
      const requestor = actingPersonId(execution);
      // Tenant anchor + pool-creator gate (the savings/counterfactual
      // surfaces expose procurement outcome analysis).
      const pool = await requirePool(input.organizationScopeId, input.poolId);
      await requireActiveMember(input.organizationScopeId, requestor);
      requirePoolCreator(requestor, pool);
      return baselineRepository.listByOrganization(
        input.organizationScopeId,
        { poolId: pool.id },
      );
    },

    async evaluateProcurementSavings(
      execution,
      input: EvaluateProcurementSavingsInput,
    ): Promise<ProcurementSavingsView> {
      assertOrganizationScopeId(input.organizationScopeId);
      assertPoolId(input.poolId);
      assertBaselineId(input.baselineId);
      const observationIds = validateProcurementSavingsObservationRefs(
        "input.outcomeObservationIds",
        input.outcomeObservationIds ?? [],
      );
      const requestor = actingPersonId(execution);
      // Tenant anchor + pool-creator gate.
      const pool = await requirePool(input.organizationScopeId, input.poolId);
      await requireActiveMember(input.organizationScopeId, requestor);
      requirePoolCreator(requestor, pool);
      const baseline = await requireBaseline(
        input.organizationScopeId,
        input.baselineId,
      );
      requireBaselineForPool(baseline, pool.id);
      // The neutral W026 lineage reference (validated neutral lineage
      // ONLY — never savings truth).
      const selectionId =
        typeof input.selectionId === "string" && input.selectionId.trim()
          ? input.selectionId
          : null;
      if (selectionId !== null) {
        await requireSelectionReference(
          input.organizationScopeId,
          pool.id,
          selectionId,
        );
      }
      // The ONE explicit evaluation anchor (the W021/W024/W025/W026
      // precedent): no wall clock inside the derivation; recorded on
      // the view. All facts resolve at THIS anchor.
      const evaluatedAt = nowIso();
      const baselineEvidence = await resolveBaselineEvidence(
        input.organizationScopeId,
        baseline,
      );
      const observations = await requireObservationReferences(
        input.organizationScopeId,
        observationIds,
      );
      logger.debug("procurement_savings.evaluated", {
        poolId: pool.id,
        organizationScopeId: pool.organizationScopeId,
        baselineId: baseline.id,
        evaluationAnchor: evaluatedAt,
        observationCount: observations.length,
      });
      // THE DERIVED DECISION: mutates nothing, audits nothing (a
      // derived 200 decision for every outcome — supported or not,
      // the decision is the product).
      return deriveProcurementSavings({
        pool,
        baseline,
        baselineEvidence,
        observations,
        evaluatedAt,
      });
    },

    async recordProcurementSavings(
      execution,
      input: RecordProcurementSavingsInput,
    ): Promise<RecordProcurementSavingsResult> {
      assertOrganizationScopeId(input.organizationScopeId);
      assertPoolId(input.poolId);
      assertBaselineId(input.baselineId);
      assertIdempotencyKey(input.idempotencyKey);
      const observationIds = validateProcurementSavingsObservationRefs(
        "input.outcomeObservationIds",
        input.outcomeObservationIds ?? [],
      );
      const actor = actingPersonId(execution);
      // Tenant anchor + pool-creator gate.
      const pool = await requirePool(input.organizationScopeId, input.poolId);
      await requireActiveMember(input.organizationScopeId, actor);
      requirePoolCreator(actor, pool);
      const baseline = await requireBaseline(
        input.organizationScopeId,
        input.baselineId,
      );
      requireBaselineForPool(baseline, pool.id);
      const selectionId =
        typeof input.selectionId === "string" && input.selectionId.trim()
          ? input.selectionId
          : null;
      if (selectionId !== null) {
        await requireSelectionReference(
          input.organizationScopeId,
          pool.id,
          selectionId,
        );
      }

      const compositeKey = `procurement_savings:${input.organizationScopeId}:${input.poolId}:${input.idempotencyKey}`;
      // The per-pool advisory lock serializes savings records so
      // concurrent recordings over one pool are ordered (each remains
      // deterministic at its own anchor; no nondeterministic savings
      // state can interleave — the W026 selection-record precedent).
      const applied = await idempotency.withLock(
        `procurement_pool_savings:${input.organizationScopeId}:${input.poolId}`,
        () =>
          idempotency.applyIdempotent(
            compositeKey,
            async (ctx) => {
              const tx = ctx.transaction;
              // In-tx fresh pool + baseline reads and gate re-checks
              // (TOCTOU closure — same-boundary state).
              const freshPool = await requirePoolWithinTx(
                input.organizationScopeId,
                input.poolId,
                tx,
              );
              requirePoolCreator(actor, freshPool);
              const freshBaseline = await requireBaselineWithinTx(
                input.organizationScopeId,
                input.baselineId,
                tx,
              );
              requireBaselineForPool(freshBaseline, freshPool.id);
              // The ONE explicit evaluation anchor, set ONCE inside
              // the authoritative transaction; the derivation
              // re-executes from CURRENT records at this anchor (work
              // order §6 — never a stored/caller-asserted value,
              // confidence or support).
              const evaluatedAt = nowIso();
              // Cross-boundary /evidence + /outcomes facts resolve at
              // the anchor through the NEUTRAL composition-root
              // lookups (the dependency-inversion boundary: the
              // same-boundary pool/baseline state is re-read in-tx;
              // the /evidence and /outcomes authorities are read
              // through their neutral committed-state lookups).
              const baselineEvidence = await resolveBaselineEvidence(
                input.organizationScopeId,
                freshBaseline,
              );
              const observations = await requireObservationReferences(
                input.organizationScopeId,
                observationIds,
              );
              const view = deriveProcurementSavings({
                pool: freshPool,
                baseline: freshBaseline,
                baselineEvidence,
                observations,
                evaluatedAt,
              });
              // FAILS CLOSED: an unsupported derivation (invalid,
              // stale or insufficient evidence) can never become an
              // authoritative savings record (issue #54 invariant 5 —
              // the derived view may still show the decision; this
              // command is authoritative).
              if (!view.supported) {
                const failed = view.checks
                  .filter((check) => !check.satisfied)
                  .map((check) => ({
                    check: check.check,
                    detail: check.detail,
                  }));
                throw savingsError(
                  `the savings derivation is not supported by the current evidence (pool ${input.poolId}, baseline ${input.baselineId}: ${failed
                    .map((entry) => entry.check)
                    .join(", ")})`,
                  {
                    field: "savings",
                    poolId: input.poolId,
                    baselineId: input.baselineId,
                    reason: "savings_derivation_not_supported",
                    failedChecks: failed,
                  },
                );
              }
              const savings: ProcurementSavings = Object.freeze({
                id: randomUUID(),
                organizationScopeId: input.organizationScopeId,
                poolId: freshPool.id,
                baselineId: freshBaseline.id,
                // The neutral W026 lineage reference (validated above;
                // never savings truth).
                selectionId,
                // The recorder IS the acting pool creator
                // (server-resolved above).
                recordedBy: actor,
                derivationPolicy: Object.freeze({
                  version: view.derivationPolicy.version,
                  method: view.derivationPolicy.method,
                  criteria: view.derivationPolicy.criteria,
                }),
                baselineKind: view.baselineKind,
                baselineValue: view.baselineValue,
                observedValue: view.observedValue,
                savings: view.savings,
                confidence: view.confidence,
                observationIds: view.observationIds,
                checks: view.checks,
                supported: view.supported,
                evaluationAnchor: view.evaluatedAt,
                digest: view.digest,
                recordFormat: PROCUREMENT_SAVINGS_RECORD_FORMAT,
                createdAt: evaluatedAt,
                updatedAt: evaluatedAt,
                idempotencyKey: input.idempotencyKey,
                executionId: execution.executionId,
                correlationId: execution.correlationId,
                causationId: execution.causationId,
              });
              await savingsRepository.createWithinTx(savings, tx);
              await appendAudit(tx, {
                eventType: PROCUREMENT_SAVINGS_RECORDED,
                context: execution,
                actor,
                subject: savings.id,
                resourceType: "procurement_savings",
                resourceId: savings.id,
                metadata: {
                  organizationScopeId: savings.organizationScopeId,
                  poolId: savings.poolId,
                  baselineId: savings.baselineId,
                  selectionId: savings.selectionId,
                  recordedBy: savings.recordedBy,
                  derivationPolicy: {
                    version: savings.derivationPolicy.version,
                    method: savings.derivationPolicy.method,
                    criteria: [...savings.derivationPolicy.criteria],
                  },
                  baselineKind: savings.baselineKind,
                  baselineValue: {
                    value: savings.baselineValue.value,
                    unit: savings.baselineValue.unit,
                  },
                  observedValue: savings.observedValue,
                  savings: savings.savings,
                  confidence: savings.confidence,
                  observationIds: [...savings.observationIds],
                  checkCount: savings.checks.length,
                  supported: savings.supported,
                  evaluationAnchor: savings.evaluationAnchor,
                  digest: savings.digest,
                  idempotencyRecordId: ctx.recordId,
                  transactionId: tx.transactionId,
                },
              });
              return savings;
            },
            execution,
          ),
      );
      return {
        savings: applied.result,
        created: applied.executed,
      };
    },

    async listPoolSavings(execution, input) {
      assertOrganizationScopeId(input.organizationScopeId);
      assertPoolId(input.poolId);
      const requestor = actingPersonId(execution);
      // Tenant anchor + pool-creator gate.
      const pool = await requirePool(input.organizationScopeId, input.poolId);
      await requireActiveMember(input.organizationScopeId, requestor);
      requirePoolCreator(requestor, pool);
      return savingsRepository.listByOrganization(
        input.organizationScopeId,
        { poolId: pool.id },
      );
    },
  };

  return service;
}

/**
 * Creator-only authorization against the DURABLE pool record: the
 * acting person must be the pool's creator (server-side — a caller
 * cannot fabricate savings/baseline authority; the W026
 * closure-authorization precedent).
 */
function requirePoolCreator(actor: string, pool: ProcurementPool): void {
  if (actor !== pool.createdBy) {
    throw new AuthorizationError(
      "only the procurement pool's creator may perform this action",
      {
        actorPersonId: actor,
        createdBy: pool.createdBy,
        poolId: pool.id,
      },
    );
  }
}
