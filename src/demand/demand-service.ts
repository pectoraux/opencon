/**
 * The NET-W024 demand domain service — material pool/commitment
 * commands + the derived qualified-aggregate view (DEM-001..003).
 *
 * Work order ref: spec/work-orders/NET-W024.md §3.3/§3.4.
 *
 * Material commands follow the NET-W003/004/008/019/020 conventions
 * exactly: validation (closed vocabularies, bounds, fail closed) →
 * server-resolved acting person → pre-flight tenant-anchored reads
 * (cross-tenant = NotFoundError — no existence oracle) → membership/
 * owner gates (server-enforced authorization/consent) → composite
 * idempotency key → per-pool advisory lock for commitment writes →
 * applyIdempotent on ONE authoritative transaction → in-tx fresh
 * reads + gate re-derivation (TOCTOU closure) → ...WithinTx writes →
 * transactional audit buffer → COMMIT.
 *
 * The derived evaluation mutates and audits NOTHING (a derived 200
 * decision — the W019 readiness / W023 admission precedent).
 *
 * There is NO economic mutation surface anywhere in this service
 * (/settlement is untouched by NET-W024) and NO lifecycle machinery
 * (/workflows is untouched: closure and withdrawal are one-way field
 * mutations).
 */

import { randomUUID } from "node:crypto";
import { AuthorizationError, NotFoundError } from "../core/errors.ts";
import {
  DEMAND_CATEGORY_KEYS,
  DEMAND_CATEGORY_VERSION,
  DEMAND_COMMITMENT_RECORD_FORMAT,
  DEMAND_CONSENT_SCOPE,
  DEMAND_CONSENT_VERSION,
  DEMAND_MAX_PROSE_CHARS,
  DEMAND_POOL_RECORD_FORMAT,
  DemandCommitmentConflictError,
  InvalidDemandError,
  isDemandCategoryKey,
  validateDemandAttributes,
  validateDemandPoolName,
  validateQualificationPolicy,
} from "../core/demand.ts";
import type { ExecutionContext } from "../core/execution-context.ts";
import type { AuthorityTransaction } from "../core/postgres-authority.ts";
import type {
  CloseDemandPoolInput,
  CreateDemandCommitmentInput,
  CreateDemandCommitmentResult,
  CreateDemandPoolInput,
  CreateDemandPoolResult,
  DemandCommitment,
  DemandPool,
  DemandService,
  DemandServiceDeps,
  QualifiedDemandAggregate,
  WithdrawDemandCommitmentInput,
} from "./port.ts";
import { deriveQualifiedDemandAggregate, hasValidAggregateConsent } from "./aggregation-engine.ts";

const DEMAND_POOL_CREATED = "demand_pool.created" as const;
const DEMAND_POOL_CLOSED = "demand_pool.closed" as const;
const DEMAND_COMMITMENT_RECORDED = "demand_commitment.recorded" as const;
const DEMAND_COMMITMENT_WITHDRAWN = "demand_commitment.withdrawn" as const;

function demandError(
  message: string,
  context: Readonly<Record<string, unknown>>,
): InvalidDemandError {
  return new InvalidDemandError(message, context);
}

function assertIdempotencyKey(idempotencyKey: string): string {
  if (typeof idempotencyKey !== "string" || !idempotencyKey.trim()) {
    throw demandError("idempotencyKey is required", {
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
    throw demandError("organizationScopeId is required", {
      field: "organizationScopeId",
    });
  }
  return organizationScopeId;
}

/** The acting person's id (recorded as createdBy/consumer on records). */
function actingPersonId(execution: ExecutionContext): string {
  if (!execution.actor || execution.actor.kind !== "person") {
    throw new AuthorizationError(
      "demand commands require an authenticated person actor",
      { actorKind: execution.actor?.kind ?? null },
    );
  }
  return execution.actor.id;
}

function nowIso(): string {
  return new Date().toISOString();
}

function validateOptionalProse(
  field: string,
  value: string | null | undefined,
): string | null {
  if (value === undefined || value === null) return null;
  const prose = String(value);
  if (prose.length > DEMAND_MAX_PROSE_CHARS) {
    throw demandError(
      `${field} must be at most ${String(DEMAND_MAX_PROSE_CHARS)} characters`,
      { field },
    );
  }
  return prose;
}

export function createDemandService(
  deps: DemandServiceDeps,
): DemandService {
  const {
    poolRepository,
    commitmentRepository,
    membershipLookup,
    idempotency,
    auditWriter,
    logger,
  } = deps;

  async function requirePool(
    organizationScopeId: string,
    id: string,
  ): Promise<DemandPool> {
    const pool = await poolRepository.findById(id);
    if (!pool || pool.organizationScopeId !== organizationScopeId) {
      // Cross-tenant is indistinguishable from nonexistent (no
      // existence oracle — issue #48).
      throw new NotFoundError(`demand pool not found: ${id}`, {
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
  ): Promise<DemandPool> {
    const pool = await poolRepository.getByIdWithinTx(id, tx);
    if (!pool || pool.organizationScopeId !== organizationScopeId) {
      throw new NotFoundError(`demand pool not found: ${id}`, {
        id,
        organizationScopeId,
      });
    }
    return pool;
  }

  async function requireCommitment(
    organizationScopeId: string,
    id: string,
  ): Promise<DemandCommitment> {
    const commitment = await commitmentRepository.findById(id);
    if (
      !commitment ||
      commitment.organizationScopeId !== organizationScopeId
    ) {
      throw new NotFoundError(`demand commitment not found: ${id}`, {
        id,
        organizationScopeId,
      });
    }
    return commitment;
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
   * The server-enforced membership gate (issue #48 invariant 2: pool
   * membership requires server-side authorization + tenant scope):
   * the acting person must hold an ACTIVE membership in the
   * organization — resolved through the NEUTRAL lookup over the
   * /organizations authority (never a client claim).
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
        "demand commands require an active organization membership",
        {
          organizationScopeId,
          actorPersonId: personId,
          reason: membership === null ? "not_a_member" : "membership_not_active",
        },
      );
    }
  }

  const service: DemandService = {
    async createDemandPool(
      execution,
      input: CreateDemandPoolInput,
    ): Promise<CreateDemandPoolResult> {
      assertOrganizationScopeId(input.organizationScopeId);
      assertIdempotencyKey(input.idempotencyKey);
      const actor = actingPersonId(execution);
      // Server-enforced authorization: the pool creator must be an
      // active member of the tenant (never a client claim).
      await requireActiveMember(input.organizationScopeId, actor);
      const name = validateDemandPoolName("name", input.name);
      const categoryKey = input.categoryKey;
      if (
        typeof categoryKey !== "string" ||
        !isDemandCategoryKey(categoryKey)
      ) {
        throw demandError(
          `categoryKey must be a closed-vocabulary demand category (got ${String(input.categoryKey)}; vocabulary: ${DEMAND_CATEGORY_KEYS.join(", ")})`,
          { field: "categoryKey", categoryKey: String(input.categoryKey) },
        );
      }
      const policy = validateQualificationPolicy(
        "qualificationPolicy",
        input.qualificationPolicy,
      );

      const key = `demand_pool:${input.organizationScopeId}:${input.idempotencyKey}`;
      const applied = await idempotency.applyIdempotent(
        key,
        async (ctx) => {
          const tx = ctx.transaction;
          const pool: DemandPool = Object.freeze({
            id: randomUUID(),
            organizationScopeId: input.organizationScopeId,
            // The pool creator IS the acting person — there is no
            // creatorPersonId input (pool ownership cannot be
            // fabricated by client claims).
            createdBy: actor,
            name,
            categoryKey,
            categoryVersion: DEMAND_CATEGORY_VERSION,
            policy: Object.freeze({
              version: policy.version,
              minimumCommitments: policy.minimumCommitments,
            }),
            closedAt: null,
            closureReason: null,
            recordFormat: DEMAND_POOL_RECORD_FORMAT,
            createdAt: nowIso(),
            updatedAt: nowIso(),
            idempotencyKey: input.idempotencyKey,
            executionId: execution.executionId,
            correlationId: execution.correlationId,
            causationId: execution.causationId,
          });
          await poolRepository.createWithinTx(pool, tx);
          await appendAudit(tx, {
            eventType: DEMAND_POOL_CREATED,
            context: execution,
            actor,
            subject: pool.id,
            resourceType: "demand_pool",
            resourceId: pool.id,
            metadata: {
              organizationScopeId: pool.organizationScopeId,
              createdBy: pool.createdBy,
              name: pool.name,
              categoryKey: pool.categoryKey,
              categoryVersion: pool.categoryVersion,
              policy: {
                version: pool.policy.version,
                minimumCommitments: pool.policy.minimumCommitments,
              },
              idempotencyRecordId: ctx.recordId,
              transactionId: tx.transactionId,
            },
          });
          return pool;
        },
        execution,
      );
      return { pool: applied.result, created: applied.executed };
    },

    async closeDemandPool(
      execution,
      input: CloseDemandPoolInput,
    ): Promise<DemandPool> {
      assertOrganizationScopeId(input.organizationScopeId);
      assertIdempotencyKey(input.idempotencyKey);
      const actor = actingPersonId(execution);
      // Tenant anchor from the authority's own record (cross-tenant =
      // NotFoundError — no existence oracle).
      const pool = await requirePool(input.organizationScopeId, input.poolId);
      requirePoolCreator(actor, pool);
      await requireActiveMember(input.organizationScopeId, actor);
      const reason = validateOptionalProse("reason", input.reason ?? null);
      const key = `demand_pool_close:${input.organizationScopeId}:${input.poolId}:${input.idempotencyKey}`;
      const applied = await idempotency.applyIdempotent(
        key,
        async (ctx) => {
          const tx = ctx.transaction;
          // In-tx fresh existence + scope + creator check (TOCTOU
          // closure).
          const fresh = await requirePoolWithinTx(
            input.organizationScopeId,
            pool.id,
            tx,
          );
          requirePoolCreator(actor, fresh);
          const closed = await poolRepository.closeWithinTx(
            fresh.id,
            nowIso(),
            reason,
            tx,
          );
          await appendAudit(tx, {
            eventType: DEMAND_POOL_CLOSED,
            context: execution,
            actor,
            subject: closed.id,
            resourceType: "demand_pool",
            resourceId: closed.id,
            metadata: {
              organizationScopeId: closed.organizationScopeId,
              createdBy: closed.createdBy,
              categoryKey: closed.categoryKey,
              closedAt: closed.closedAt,
              closureReason: closed.closureReason,
              idempotencyRecordId: ctx.recordId,
              transactionId: tx.transactionId,
            },
          });
          return closed;
        },
        execution,
      );
      return applied.result;
    },

    async createDemandCommitment(
      execution,
      input: CreateDemandCommitmentInput,
    ): Promise<CreateDemandCommitmentResult> {
      assertOrganizationScopeId(input.organizationScopeId);
      assertIdempotencyKey(input.idempotencyKey);
      const actor = actingPersonId(execution);
      // THE TENANT ANCHOR FIRST (the clearing-service principle: a
      // missing or cross-scope record fails closed BEFORE anything —
      // cross-tenant is indistinguishable from nonexistent, no
      // existence oracle).
      const pool = await requirePool(input.organizationScopeId, input.poolId);
      // Server-enforced demand membership: the consumer must be an
      // ACTIVE organization member (never a client claim — issue #48
      // invariant 2).
      await requireActiveMember(input.organizationScopeId, actor);
      const attributes = validateDemandAttributes(
        "attributes",
        input.attributes ?? {},
      );
      // The consent scope may only NAME the one closed scope; the
      // grant (who + when + version) is server-written below.
      if (
        !input.consent ||
        typeof input.consent.scope !== "string" ||
        input.consent.scope !== DEMAND_CONSENT_SCOPE
      ) {
        throw demandError(
          `consent.scope must be the closed consent scope "${DEMAND_CONSENT_SCOPE}" (got ${String(input.consent?.scope)})`,
          { field: "consent.scope", scope: String(input.consent?.scope) },
        );
      }
      // The pool must be open (pre-flight; re-checked in-tx).
      if (pool.closedAt !== null) {
        throw demandError(
          `demand pool is closed: ${input.poolId}`,
          { field: "poolId", poolId: input.poolId, reason: "pool_closed" },
        );
      }

      const compositeKey = `demand_commitment:${input.organizationScopeId}:${input.poolId}:${actor}:${input.idempotencyKey}`;
      // The per-pool advisory lock serializes commitment writes so
      // the derived aggregate count CONSERVES under concurrent
      // submissions (the W020 pair-mutex precedent, scoped to the
      // pool).
      const applied = await idempotency.withLock(
        `demand_pool_commitment:${input.organizationScopeId}:${input.poolId}`,
        () =>
          idempotency.applyIdempotent(
            compositeKey,
            async (ctx) => {
              const tx = ctx.transaction;
              // In-tx fresh pool read + scope + open re-check
              // (TOCTOU closure — nothing caller-asserted qualifies).
              const freshPool = await requirePoolWithinTx(
                input.organizationScopeId,
                input.poolId,
                tx,
              );
              if (freshPool.closedAt !== null) {
                throw demandError(
                  `demand pool is closed: ${input.poolId}`,
                  {
                    field: "poolId",
                    poolId: input.poolId,
                    reason: "pool_closed",
                  },
                );
              }
              // In-tx create-once constraint: ONE active commitment
              // per (pool, consumer) — a stable conflict otherwise.
              const existing = await commitmentRepository.findActiveByPoolAndConsumerWithinTx(
                input.organizationScopeId,
                input.poolId,
                actor,
                tx,
              );
              if (existing !== null) {
                throw new DemandCommitmentConflictError(
                  `an active commitment already exists for this consumer in pool ${input.poolId}`,
                  {
                    organizationScopeId: input.organizationScopeId,
                    poolId: input.poolId,
                    consumerPersonId: actor,
                    existingCommitmentId: existing.id,
                  },
                );
              }
              const grantedAt = nowIso();
              const commitment: DemandCommitment = Object.freeze({
                id: randomUUID(),
                organizationScopeId: input.organizationScopeId,
                poolId: input.poolId,
                // The consumer IS the acting person — there is no
                // consumerPersonId input (demand membership cannot be
                // fabricated by client claims).
                consumerPersonId: actor,
                categoryKey: freshPool.categoryKey,
                categoryVersion: freshPool.categoryVersion,
                attributes: Object.freeze({
                  region: attributes.region,
                  quantity: attributes.quantity,
                  budgetBand: attributes.budgetBand,
                }),
                consent: Object.freeze({
                  scope: DEMAND_CONSENT_SCOPE,
                  version: DEMAND_CONSENT_VERSION,
                  grantedAt,
                  grantedBy: actor,
                }),
                withdrawnAt: null,
                withdrawalReason: null,
                recordFormat: DEMAND_COMMITMENT_RECORD_FORMAT,
                createdAt: grantedAt,
                updatedAt: grantedAt,
                idempotencyKey: input.idempotencyKey,
                executionId: execution.executionId,
                correlationId: execution.correlationId,
                causationId: execution.causationId,
              });
              await commitmentRepository.createWithinTx(commitment, tx);
              await appendAudit(tx, {
                eventType: DEMAND_COMMITMENT_RECORDED,
                context: execution,
                actor,
                subject: commitment.id,
                resourceType: "demand_commitment",
                resourceId: commitment.id,
                metadata: {
                  organizationScopeId: commitment.organizationScopeId,
                  poolId: commitment.poolId,
                  categoryKey: commitment.categoryKey,
                  categoryVersion: commitment.categoryVersion,
                  attributes: {
                    region: commitment.attributes.region,
                    quantity: commitment.attributes.quantity,
                    budgetBand: commitment.attributes.budgetBand,
                  },
                  consentScope: commitment.consent.scope,
                  consentVersion: commitment.consent.version,
                  idempotencyRecordId: ctx.recordId,
                  transactionId: tx.transactionId,
                },
              });
              return commitment;
            },
            execution,
          ),
      );
      return {
        commitment: applied.result,
        created: applied.executed,
      };
    },

    async withdrawDemandCommitment(
      execution,
      input: WithdrawDemandCommitmentInput,
    ): Promise<DemandCommitment> {
      assertOrganizationScopeId(input.organizationScopeId);
      assertIdempotencyKey(input.idempotencyKey);
      const actor = actingPersonId(execution);
      // Tenant anchor + consumer-only gate (pre-flight; re-checked
      // in-tx).
      const commitment = await requireCommitment(
        input.organizationScopeId,
        input.commitmentId,
      );
      requireConsumer(actor, commitment);
      await requireActiveMember(input.organizationScopeId, actor);
      const reason = validateOptionalProse("reason", input.reason ?? null);
      const key = `demand_commitment_withdraw:${input.organizationScopeId}:${input.commitmentId}:${input.idempotencyKey}`;
      const applied = await idempotency.applyIdempotent(
        key,
        async (ctx) => {
          const tx = ctx.transaction;
          // In-tx fresh existence + scope + consumer re-check
          // (TOCTOU closure).
          const fresh = await commitmentRepository.getByIdWithinTx(
            commitment.id,
            tx,
          );
          if (
            !fresh ||
            fresh.organizationScopeId !== input.organizationScopeId
          ) {
            throw new NotFoundError(
              `demand commitment not found: ${input.commitmentId}`,
              { id: input.commitmentId, organizationScopeId: input.organizationScopeId },
            );
          }
          requireConsumer(actor, fresh);
          const withdrawn = await commitmentRepository.withdrawWithinTx(
            fresh.id,
            nowIso(),
            reason,
            tx,
          );
          await appendAudit(tx, {
            eventType: DEMAND_COMMITMENT_WITHDRAWN,
            context: execution,
            actor,
            subject: withdrawn.id,
            resourceType: "demand_commitment",
            resourceId: withdrawn.id,
            metadata: {
              organizationScopeId: withdrawn.organizationScopeId,
              poolId: withdrawn.poolId,
              withdrawnAt: withdrawn.withdrawnAt,
              withdrawalReason: withdrawn.withdrawalReason,
              idempotencyRecordId: ctx.recordId,
              transactionId: tx.transactionId,
            },
          });
          return withdrawn;
        },
        execution,
      );
      return applied.result;
    },

    async getDemandPool(execution, organizationScopeId, poolId) {
      assertOrganizationScopeId(organizationScopeId);
      return requirePool(organizationScopeId, poolId);
    },

    async listDemandPools(execution, organizationScopeId, filters) {
      assertOrganizationScopeId(organizationScopeId);
      return poolRepository.listByOrganization(organizationScopeId, filters);
    },

    async getDemandCommitment(execution, organizationScopeId, commitmentId) {
      assertOrganizationScopeId(organizationScopeId);
      return requireCommitment(organizationScopeId, commitmentId);
    },

    async listDemandCommitments(execution, organizationScopeId, filters) {
      assertOrganizationScopeId(organizationScopeId);
      return commitmentRepository.listByOrganization(
        organizationScopeId,
        filters,
      );
    },

    async evaluateQualifiedDemand(
      execution,
      input,
    ): Promise<QualifiedDemandAggregate> {
      assertOrganizationScopeId(input.organizationScopeId);
      if (typeof input.poolId !== "string" || !input.poolId.trim()) {
        throw demandError("poolId is required", { field: "poolId" });
      }
      // The acting person authorizes the supplier-facing view (the
      // guard action + membership check below; the requestor's own
      // membership becomes a DERIVED check, never an exception, so
      // the view stays a 200 decision).
      const requestor = actingPersonId(execution);
      // Tenant anchor from the authority's own record (cross-tenant =
      // NotFoundError — no existence oracle).
      const pool = await requirePool(input.organizationScopeId, input.poolId);
      // The authoritative inputs, re-read at evaluation time: the
      // CURRENT active commitments (withdrawn excluded), consent
      // re-checked, deterministically ordered by (createdAt, id).
      const active = (await commitmentRepository.listActiveByPool(pool.id))
        .filter((commitment) => hasValidAggregateConsent(commitment))
        .sort(byCreatedAt);
      const requestorMembership = await membershipLookup.resolveMembership(
        requestor,
        input.organizationScopeId,
      );
      // The ONE explicit evaluation anchor (the W021 precedent): no
      // wall clock inside the derivation; recorded on the view.
      const evaluatedAt = nowIso();
      logger.debug("demand_aggregate.evaluated", {
        poolId: pool.id,
        organizationScopeId: pool.organizationScopeId,
        evaluationAnchor: evaluatedAt,
      });
      return deriveQualifiedDemandAggregate({
        pool,
        commitments: active,
        requestorMembership,
        evaluatedAt,
      });
    },
  };

  return service;
}

/**
 * Creator-only authorization against the DURABLE pool record: the
 * acting person must be the pool's creator (server-side — a caller
 * cannot fabricate pool ownership).
 */
function requirePoolCreator(actor: string, pool: DemandPool): void {
  if (actor !== pool.createdBy) {
    throw new AuthorizationError(
      "only the demand pool's creator may perform this action",
      {
        actorPersonId: actor,
        createdBy: pool.createdBy,
        poolId: pool.id,
      },
    );
  }
}

/**
 * Consumer-only authorization against the DURABLE commitment record:
 * the acting person must be the commitment's consumer (server-side —
 * only the consumer may withdraw their consent).
 */
function requireConsumer(
  actor: string,
  commitment: DemandCommitment,
): void {
  if (actor !== commitment.consumerPersonId) {
    throw new AuthorizationError(
      "only the demand commitment's consumer may perform this action",
      {
        actorPersonId: actor,
        consumerPersonId: commitment.consumerPersonId,
        commitmentId: commitment.id,
      },
    );
  }
}

function byCreatedAt(
  a: { readonly createdAt: string; readonly id: string },
  b: { readonly createdAt: string; readonly id: string },
): number {
  if (a.createdAt === b.createdAt) return a.id < b.id ? -1 : 1;
  return a.createdAt < b.createdAt ? -1 : 1;
}
