/**
 * The NET-W025 procurement domain service — material pool/commitment
 * commands + the derived supplier-facing minimized demand view
 * (DEM-001..003 + PROC-003). Lives INSIDE the /demand boundary
 * (business procurement pools — the SAME frozen domain NET-W024
 * activated; there is NO second demand/procurement authority).
 *
 * Work order ref: spec/work-orders/NET-W025.md §3.3/§3.4.
 *
 * Material commands follow the NET-W003/004/008/019/020/024
 * conventions exactly: validation (closed vocabularies, bounds, fail
 * closed) → server-resolved acting person → pre-flight
 * tenant-anchored reads (cross-tenant = NotFoundError — no existence
 * oracle) → membership/owner gates (tenant membership; PLUS the
 * buyer-organization membership gate for commitments — a failed
 * buyer authorization is indistinguishable from a nonexistent
 * organization) → composite idempotency key → per-pool advisory lock
 * for commitment writes → applyIdempotent on ONE authoritative
 * transaction → in-tx fresh reads + gate re-derivation (TOCTOU
 * closure) → ...WithinTx writes → transactional audit buffer →
 * COMMIT.
 *
 * The derived evaluation mutates and audits NOTHING (a derived 200
 * decision — the W019/W023/W024 precedent).
 *
 * There is NO economic mutation surface anywhere in this service
 * (/settlement is untouched by NET-W025) and NO lifecycle machinery
 * (/workflows is untouched: closure and withdrawal are one-way field
 * mutations).
 */

import { randomUUID } from "node:crypto";
import { AuthorizationError, NotFoundError } from "../core/errors.ts";
import {
  PROCUREMENT_CATEGORY_KEYS,
  PROCUREMENT_CATEGORY_VERSION,
  PROCUREMENT_COMMITMENT_RECORD_FORMAT,
  PROCUREMENT_CONSENT_SCOPE,
  PROCUREMENT_CONSENT_VERSION,
  PROCUREMENT_MAX_PROSE_CHARS,
  PROCUREMENT_POOL_RECORD_FORMAT,
  InvalidProcurementError,
  ProcurementCommitmentConflictError,
  isProcurementCategoryKey,
  validateProcurementAttributes,
  validateProcurementPoolName,
  validateProcurementQualificationPolicy,
} from "../core/procurement.ts";
import type { ExecutionContext } from "../core/execution-context.ts";
import type { AuthorityTransaction } from "../core/postgres-authority.ts";
import type {
  CloseProcurementPoolInput,
  CreateProcurementCommitmentInput,
  CreateProcurementCommitmentResult,
  CreateProcurementPoolInput,
  CreateProcurementPoolResult,
  ProcurementCommitment,
  ProcurementPool,
  ProcurementService,
  ProcurementServiceDeps,
  QualifiedProcurementAggregate,
  WithdrawProcurementCommitmentInput,
} from "./port.ts";
import {
  deriveQualifiedProcurementAggregate,
  hasValidProcurementConsent,
} from "./procurement-aggregation-engine.ts";

const PROCUREMENT_POOL_CREATED = "procurement_pool.created" as const;
const PROCUREMENT_POOL_CLOSED = "procurement_pool.closed" as const;
const PROCUREMENT_COMMITMENT_RECORDED =
  "procurement_commitment.recorded" as const;
const PROCUREMENT_COMMITMENT_WITHDRAWN =
  "procurement_commitment.withdrawn" as const;

function procurementError(
  message: string,
  context: Readonly<Record<string, unknown>>,
): InvalidProcurementError {
  return new InvalidProcurementError(message, context);
}

function assertIdempotencyKey(idempotencyKey: string): string {
  if (typeof idempotencyKey !== "string" || !idempotencyKey.trim()) {
    throw procurementError("idempotencyKey is required", {
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
    throw procurementError("organizationScopeId is required", {
      field: "organizationScopeId",
    });
  }
  return organizationScopeId;
}

function assertBuyerOrganizationId(buyerOrganizationId: string): string {
  if (
    typeof buyerOrganizationId !== "string" ||
    !buyerOrganizationId.trim()
  ) {
    throw procurementError("buyerOrganizationId is required", {
      field: "buyerOrganizationId",
    });
  }
  return buyerOrganizationId;
}

/** The acting person's id (recorded as createdBy/submittedBy on records). */
function actingPersonId(execution: ExecutionContext): string {
  if (!execution.actor || execution.actor.kind !== "person") {
    throw new AuthorizationError(
      "procurement commands require an authenticated person actor",
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
  if (prose.length > PROCUREMENT_MAX_PROSE_CHARS) {
    throw procurementError(
      `${field} must be at most ${String(PROCUREMENT_MAX_PROSE_CHARS)} characters`,
      { field },
    );
  }
  return prose;
}

export function createProcurementService(
  deps: ProcurementServiceDeps,
): ProcurementService {
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
  ): Promise<ProcurementPool> {
    const pool = await poolRepository.findById(id);
    if (!pool || pool.organizationScopeId !== organizationScopeId) {
      // Cross-tenant is indistinguishable from nonexistent (no
      // existence oracle — issue #50).
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

  async function requireCommitment(
    organizationScopeId: string,
    id: string,
  ): Promise<ProcurementCommitment> {
    const commitment = await commitmentRepository.findById(id);
    if (
      !commitment ||
      commitment.organizationScopeId !== organizationScopeId
    ) {
      throw new NotFoundError(
        `procurement commitment not found: ${id}`,
        { id, organizationScopeId },
      );
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
   * The server-enforced TENANT membership gate (issue #50 invariant
   * 2): the acting person must hold an ACTIVE membership in the
   * tenant organization — resolved through the NEUTRAL lookup over
   * the /organizations authority (never a client claim).
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
        "procurement commands require an active organization membership",
        {
          organizationScopeId,
          actorPersonId: personId,
          reason: membership === null ? "not_a_member" : "membership_not_active",
        },
      );
    }
  }

  /**
   * The server-enforced BUYER-ORGANIZATION authorization gate (issue
   * #50: "Business demand commitments with explicit
   * organization/actor authorization"): the acting person must hold
   * an ACTIVE membership in the NAMED buyer organization to commit
   * on its behalf. A failed authorization is indistinguishable from
   * a nonexistent organization (the neutral lookup returns null for
   * both — no existence oracle).
   */
  async function requireBuyerAuthorization(
    organizationScopeId: string,
    buyerOrganizationId: string,
    personId: string,
  ): Promise<void> {
    const membership = await membershipLookup.resolveMembership(
      personId,
      buyerOrganizationId,
    );
    if (membership !== "active") {
      throw new AuthorizationError(
        "procurement commitments require the acting person to be an active member of the named buyer organization",
        {
          organizationScopeId,
          buyerOrganizationId,
          actorPersonId: personId,
          reason: membership === null ? "not_a_member" : "membership_not_active",
        },
      );
    }
  }

  const service: ProcurementService = {
    async createProcurementPool(
      execution,
      input: CreateProcurementPoolInput,
    ): Promise<CreateProcurementPoolResult> {
      assertOrganizationScopeId(input.organizationScopeId);
      assertIdempotencyKey(input.idempotencyKey);
      const actor = actingPersonId(execution);
      // Server-enforced authorization: the pool creator must be an
      // active member of the tenant (never a client claim).
      await requireActiveMember(input.organizationScopeId, actor);
      const name = validateProcurementPoolName("name", input.name);
      const categoryKey = input.categoryKey;
      if (
        typeof categoryKey !== "string" ||
        !isProcurementCategoryKey(categoryKey)
      ) {
        throw procurementError(
          `categoryKey must be a closed-vocabulary procurement category (got ${String(input.categoryKey)}; vocabulary: ${PROCUREMENT_CATEGORY_KEYS.join(", ")})`,
          { field: "categoryKey", categoryKey: String(input.categoryKey) },
        );
      }
      const policy = validateProcurementQualificationPolicy(
        "qualificationPolicy",
        input.qualificationPolicy,
      );

      const key = `procurement_pool:${input.organizationScopeId}:${input.idempotencyKey}`;
      const applied = await idempotency.applyIdempotent(
        key,
        async (ctx) => {
          const tx = ctx.transaction;
          const pool: ProcurementPool = Object.freeze({
            id: randomUUID(),
            organizationScopeId: input.organizationScopeId,
            // The pool creator IS the acting person — there is no
            // creatorPersonId input (pool ownership cannot be
            // fabricated by client claims).
            createdBy: actor,
            name,
            categoryKey,
            categoryVersion: PROCUREMENT_CATEGORY_VERSION,
            policy: Object.freeze({
              version: policy.version,
              minimumCommitments: policy.minimumCommitments,
              minimumOrganizations: policy.minimumOrganizations,
            }),
            closedAt: null,
            closureReason: null,
            recordFormat: PROCUREMENT_POOL_RECORD_FORMAT,
            createdAt: nowIso(),
            updatedAt: nowIso(),
            idempotencyKey: input.idempotencyKey,
            executionId: execution.executionId,
            correlationId: execution.correlationId,
            causationId: execution.causationId,
          });
          await poolRepository.createWithinTx(pool, tx);
          await appendAudit(tx, {
            eventType: PROCUREMENT_POOL_CREATED,
            context: execution,
            actor,
            subject: pool.id,
            resourceType: "procurement_pool",
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
                minimumOrganizations: pool.policy.minimumOrganizations,
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

    async closeProcurementPool(
      execution,
      input: CloseProcurementPoolInput,
    ): Promise<ProcurementPool> {
      assertOrganizationScopeId(input.organizationScopeId);
      assertIdempotencyKey(input.idempotencyKey);
      const actor = actingPersonId(execution);
      // Tenant anchor from the authority's own record (cross-tenant =
      // NotFoundError — no existence oracle).
      const pool = await requirePool(input.organizationScopeId, input.poolId);
      requirePoolCreator(actor, pool);
      await requireActiveMember(input.organizationScopeId, actor);
      const reason = validateOptionalProse("reason", input.reason ?? null);
      const key = `procurement_pool_close:${input.organizationScopeId}:${input.poolId}:${input.idempotencyKey}`;
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
            eventType: PROCUREMENT_POOL_CLOSED,
            context: execution,
            actor,
            subject: closed.id,
            resourceType: "procurement_pool",
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

    async createProcurementCommitment(
      execution,
      input: CreateProcurementCommitmentInput,
    ): Promise<CreateProcurementCommitmentResult> {
      assertOrganizationScopeId(input.organizationScopeId);
      assertIdempotencyKey(input.idempotencyKey);
      assertBuyerOrganizationId(input.buyerOrganizationId);
      const actor = actingPersonId(execution);
      // THE TENANT ANCHOR FIRST (the clearing-service principle: a
      // missing or cross-scope record fails closed BEFORE anything —
      // cross-tenant is indistinguishable from nonexistent, no
      // existence oracle).
      const pool = await requirePool(input.organizationScopeId, input.poolId);
      // Server-enforced tenant membership: the submitter must be an
      // ACTIVE member of the tenant organization (never a client
      // claim — issue #50 invariant 2).
      await requireActiveMember(input.organizationScopeId, actor);
      // Server-enforced BUYER-ORGANIZATION authorization: the acting
      // person must be an ACTIVE member of the named buyer
      // organization to commit on its behalf (indistinguishable from
      // a nonexistent organization — no existence oracle).
      await requireBuyerAuthorization(
        input.organizationScopeId,
        input.buyerOrganizationId,
        actor,
      );
      const attributes = validateProcurementAttributes(
        "attributes",
        input.attributes ?? {},
      );
      // The consent scope may only NAME the one closed scope; the
      // grant (who + when + version) is server-written below.
      if (
        !input.consent ||
        typeof input.consent.scope !== "string" ||
        input.consent.scope !== PROCUREMENT_CONSENT_SCOPE
      ) {
        throw procurementError(
          `consent.scope must be the closed consent scope "${PROCUREMENT_CONSENT_SCOPE}" (got ${String(input.consent?.scope)})`,
          { field: "consent.scope", scope: String(input.consent?.scope) },
        );
      }
      // The pool must be open (pre-flight; re-checked in-tx).
      if (pool.closedAt !== null) {
        throw procurementError(
          `procurement pool is closed: ${input.poolId}`,
          { field: "poolId", poolId: input.poolId, reason: "pool_closed" },
        );
      }

      const compositeKey = `procurement_commitment:${input.organizationScopeId}:${input.poolId}:${actor}:${input.idempotencyKey}`;
      // The per-pool advisory lock serializes commitment writes so
      // the derived aggregate count CONSERVES under concurrent
      // submissions (the W020 pair-mutex precedent, scoped to the
      // pool).
      const applied = await idempotency.withLock(
        `procurement_pool_commitment:${input.organizationScopeId}:${input.poolId}`,
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
                throw procurementError(
                  `procurement pool is closed: ${input.poolId}`,
                  {
                    field: "poolId",
                    poolId: input.poolId,
                    reason: "pool_closed",
                  },
                );
              }
              // In-tx create-once constraint: ONE active commitment
              // per (pool, submitter) — a stable conflict otherwise.
              // The buyer organization is NOT part of the constraint
              // (an organization may hold multiple commitments from
              // different members — the distinct-organization floor
              // governs that dimension).
              const existing =
                await commitmentRepository.findActiveByPoolAndSubmitterWithinTx(
                  input.organizationScopeId,
                  input.poolId,
                  actor,
                  tx,
                );
              if (existing !== null) {
                throw new ProcurementCommitmentConflictError(
                  `an active commitment already exists for this submitter in pool ${input.poolId}`,
                  {
                    organizationScopeId: input.organizationScopeId,
                    poolId: input.poolId,
                    actorPersonId: actor,
                    existingCommitmentId: existing.id,
                  },
                );
              }
              const grantedAt = nowIso();
              const commitment: ProcurementCommitment = Object.freeze({
                id: randomUUID(),
                organizationScopeId: input.organizationScopeId,
                poolId: input.poolId,
                // The buyer organization the ACTING PERSON is
                // authorized to commit for (server-verified above —
                // buyer eligibility cannot be fabricated by client
                // claims).
                buyerOrganizationId: input.buyerOrganizationId,
                // The submitter IS the acting person — there is no
                // submittedBy input (commitment ownership cannot be
                // fabricated by client claims).
                submittedBy: actor,
                categoryKey: freshPool.categoryKey,
                categoryVersion: freshPool.categoryVersion,
                attributes: Object.freeze({
                  region: attributes.region,
                  quantity: attributes.quantity,
                  budgetBand: attributes.budgetBand,
                  unitPriceBand: attributes.unitPriceBand,
                  timingWindow: attributes.timingWindow,
                }),
                consent: Object.freeze({
                  scope: PROCUREMENT_CONSENT_SCOPE,
                  version: PROCUREMENT_CONSENT_VERSION,
                  grantedAt,
                  grantedBy: actor,
                }),
                withdrawnAt: null,
                withdrawalReason: null,
                recordFormat: PROCUREMENT_COMMITMENT_RECORD_FORMAT,
                createdAt: grantedAt,
                updatedAt: grantedAt,
                idempotencyKey: input.idempotencyKey,
                executionId: execution.executionId,
                correlationId: execution.correlationId,
                causationId: execution.causationId,
              });
              await commitmentRepository.createWithinTx(commitment, tx);
              await appendAudit(tx, {
                eventType: PROCUREMENT_COMMITMENT_RECORDED,
                context: execution,
                actor,
                subject: commitment.id,
                resourceType: "procurement_commitment",
                resourceId: commitment.id,
                metadata: {
                  organizationScopeId: commitment.organizationScopeId,
                  poolId: commitment.poolId,
                  buyerOrganizationId: commitment.buyerOrganizationId,
                  categoryKey: commitment.categoryKey,
                  categoryVersion: commitment.categoryVersion,
                  attributes: {
                    region: commitment.attributes.region,
                    quantity: commitment.attributes.quantity,
                    budgetBand: commitment.attributes.budgetBand,
                    unitPriceBand: commitment.attributes.unitPriceBand,
                    timingWindow: commitment.attributes.timingWindow,
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

    async withdrawProcurementCommitment(
      execution,
      input: WithdrawProcurementCommitmentInput,
    ): Promise<ProcurementCommitment> {
      assertOrganizationScopeId(input.organizationScopeId);
      assertIdempotencyKey(input.idempotencyKey);
      const actor = actingPersonId(execution);
      // Tenant anchor + submitter-only gate (pre-flight; re-checked
      // in-tx).
      const commitment = await requireCommitment(
        input.organizationScopeId,
        input.commitmentId,
      );
      requireSubmitter(actor, commitment);
      await requireActiveMember(input.organizationScopeId, actor);
      const reason = validateOptionalProse("reason", input.reason ?? null);
      const key = `procurement_commitment_withdraw:${input.organizationScopeId}:${input.commitmentId}:${input.idempotencyKey}`;
      const applied = await idempotency.applyIdempotent(
        key,
        async (ctx) => {
          const tx = ctx.transaction;
          // In-tx fresh existence + scope + submitter re-check
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
              `procurement commitment not found: ${input.commitmentId}`,
              {
                id: input.commitmentId,
                organizationScopeId: input.organizationScopeId,
              },
            );
          }
          requireSubmitter(actor, fresh);
          const withdrawn = await commitmentRepository.withdrawWithinTx(
            fresh.id,
            nowIso(),
            reason,
            tx,
          );
          await appendAudit(tx, {
            eventType: PROCUREMENT_COMMITMENT_WITHDRAWN,
            context: execution,
            actor,
            subject: withdrawn.id,
            resourceType: "procurement_commitment",
            resourceId: withdrawn.id,
            metadata: {
              organizationScopeId: withdrawn.organizationScopeId,
              poolId: withdrawn.poolId,
              buyerOrganizationId: withdrawn.buyerOrganizationId,
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

    async getProcurementPool(execution, organizationScopeId, poolId) {
      assertOrganizationScopeId(organizationScopeId);
      return requirePool(organizationScopeId, poolId);
    },

    async listProcurementPools(execution, organizationScopeId, filters) {
      assertOrganizationScopeId(organizationScopeId);
      return poolRepository.listByOrganization(organizationScopeId, filters);
    },

    async getProcurementCommitment(
      execution,
      organizationScopeId,
      commitmentId,
    ) {
      assertOrganizationScopeId(organizationScopeId);
      return requireCommitment(organizationScopeId, commitmentId);
    },

    async listProcurementCommitments(
      execution,
      organizationScopeId,
      filters,
    ) {
      assertOrganizationScopeId(organizationScopeId);
      return commitmentRepository.listByOrganization(
        organizationScopeId,
        filters,
      );
    },

    async evaluateQualifiedProcurementDemand(
      execution,
      input,
    ): Promise<QualifiedProcurementAggregate> {
      assertOrganizationScopeId(input.organizationScopeId);
      if (typeof input.poolId !== "string" || !input.poolId.trim()) {
        throw procurementError("poolId is required", { field: "poolId" });
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
      const active = (
        await commitmentRepository.listActiveByPool(pool.id)
      )
        .filter((commitment) => hasValidProcurementConsent(commitment))
        .sort(byCreatedAt);
      const requestorMembership = await membershipLookup.resolveMembership(
        requestor,
        input.organizationScopeId,
      );
      // The ONE explicit evaluation anchor (the W021/W024 precedent):
      // no wall clock inside the derivation; recorded on the view.
      const evaluatedAt = nowIso();
      logger.debug("procurement_aggregate.evaluated", {
        poolId: pool.id,
        organizationScopeId: pool.organizationScopeId,
        evaluationAnchor: evaluatedAt,
      });
      return deriveQualifiedProcurementAggregate({
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

/**
 * Submitter-only authorization against the DURABLE commitment
 * record: the acting person must be the commitment's submitter
 * (server-side — only the submitter may withdraw the consent they
 * granted).
 */
function requireSubmitter(
  actor: string,
  commitment: ProcurementCommitment,
): void {
  if (actor !== commitment.submittedBy) {
    throw new AuthorizationError(
      "only the procurement commitment's submitter may perform this action",
      {
        actorPersonId: actor,
        submittedBy: commitment.submittedBy,
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
