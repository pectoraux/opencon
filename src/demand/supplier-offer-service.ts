/**
 * The NET-W026 supplier-offer/competitive-selection domain service —
 * material offer/selection commands + the derived selection view
 * (DEM-003 + PROC-001 + PROC-003). Lives INSIDE the /demand boundary
 * (supplier offers and competitive selection — the SAME frozen
 * domain NET-W024/W025 activated; there is NO second demand/
 * procurement/selection authority).
 *
 * Work order ref: spec/work-orders/NET-W026.md §4/§5/§6.
 *
 * Material commands follow the NET-W003/004/008/019/020/024/025
 * conventions exactly: validation (closed vocabularies, bounds, fail
 * closed) → server-resolved acting person → pre-flight
 * tenant-anchored reads (cross-tenant = NotFoundError — no existence
 * oracle) → membership/owner gates (the authorized-supplier gate for
 * offers; the pool-creator gate for selection surfaces) → composite
 * idempotency key → per-pool advisory lock → applyIdempotent on ONE
 * authoritative transaction → in-tx fresh reads + gate RE-DERIVATION
 * (TOCTOU closure: the pool's CURRENT qualification is re-derived
 * from tx-scanned commitments, never trusted from a pre-flight
 * snapshot) → ...WithinTx writes → transactional audit buffer →
 * COMMIT.
 *
 * The derived evaluation mutates and audits NOTHING (a derived 200
 * decision — the W019/W023/W024/W025 precedent).
 *
 * There is NO economic mutation surface anywhere in this service
 * (/settlement is untouched by NET-W026 — a selection is a
 * procurement decision, never an economic one) and NO lifecycle
 * machinery (/workflows is untouched: offer withdrawal is a one-way
 * field mutation; expiry is derived from the recorded validity
 * window at the evaluation anchor).
 */

import { randomUUID } from "node:crypto";
import { AuthorizationError, NotFoundError } from "../core/errors.ts";
import {
  PROCUREMENT_MAX_PROSE_CHARS,
} from "../core/procurement.ts";
import {
  COMPETITIVE_SELECTION_RECORD_FORMAT,
  SUPPLIER_OFFER_CONSENT_SCOPE,
  SUPPLIER_OFFER_CONSENT_VERSION,
  SUPPLIER_OFFER_RECORD_FORMAT,
  InvalidSupplierOfferError,
  SupplierOfferConflictError,
  validateSupplierOfferAttributes,
  validateSupplierOfferValidity,
} from "../core/procurement-offer.ts";
import type { ExecutionContext } from "../core/execution-context.ts";
import type { AuthorityTransaction } from "../core/postgres-authority.ts";
import type {
  CompetitiveSelection,
  CompetitiveSelectionView,
  CreateSupplierOfferInput,
  CreateSupplierOfferResult,
  ProcurementPool,
  QualifiedProcurementAggregate,
  RecordCompetitiveSelectionInput,
  RecordCompetitiveSelectionResult,
  SupplierOffer,
  SupplierOfferService,
  SupplierOfferServiceDeps,
  WithdrawSupplierOfferInput,
} from "./port.ts";
import {
  deriveQualifiedProcurementAggregate,
  hasValidProcurementConsent,
} from "./procurement-aggregation-engine.ts";
import { deriveCompetitiveSelection } from "./competitive-selection-engine.ts";

const PROCUREMENT_OFFER_RECORDED = "procurement_offer.recorded" as const;
const PROCUREMENT_OFFER_WITHDRAWN = "procurement_offer.withdrawn" as const;
const PROCUREMENT_SELECTION_RECORDED =
  "procurement_selection.recorded" as const;

function offerError(
  message: string,
  context: Readonly<Record<string, unknown>>,
): InvalidSupplierOfferError {
  return new InvalidSupplierOfferError(message, context);
}

function assertIdempotencyKey(idempotencyKey: string): string {
  if (typeof idempotencyKey !== "string" || !idempotencyKey.trim()) {
    throw offerError("idempotencyKey is required", {
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
    throw offerError("organizationScopeId is required", {
      field: "organizationScopeId",
    });
  }
  return organizationScopeId;
}

function assertPoolId(poolId: string): string {
  if (typeof poolId !== "string" || !poolId.trim()) {
    throw offerError("poolId is required", { field: "poolId" });
  }
  return poolId;
}

/** The acting person's id (recorded as supplierPersonId/recordedBy). */
function actingPersonId(execution: ExecutionContext): string {
  if (!execution.actor || execution.actor.kind !== "person") {
    throw new AuthorizationError(
      "supplier offer commands require an authenticated person actor",
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
    throw offerError(
      `${field} must be at most ${String(PROCUREMENT_MAX_PROSE_CHARS)} characters`,
      { field },
    );
  }
  return prose;
}

export function createSupplierOfferService(
  deps: SupplierOfferServiceDeps,
): SupplierOfferService {
  const {
    offerRepository,
    selectionRepository,
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
      // existence oracle — issue #52).
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

  async function requireOffer(
    organizationScopeId: string,
    id: string,
  ): Promise<SupplierOffer> {
    const offer = await offerRepository.findById(id);
    if (!offer || offer.organizationScopeId !== organizationScopeId) {
      throw new NotFoundError(`supplier offer not found: ${id}`, {
        id,
        organizationScopeId,
      });
    }
    return offer;
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
   * The server-enforced TENANT membership gate (the authorized
   * supplier actor gate — issue #52): the acting person must hold an
   * ACTIVE membership in the tenant organization — resolved through
   * the NEUTRAL lookup over the /organizations authority (never a
   * client claim; the participant-role vocabulary stays unconsumed —
   * authorization is membership-based, the W025 precedent).
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
        "supplier offer commands require an active organization membership",
        {
          organizationScopeId,
          actorPersonId: personId,
          reason: membership === null ? "not_a_member" : "membership_not_active",
        },
      );
    }
  }

  /**
   * The re-resolved membership map of every DISTINCT supplier behind
   * the given offers (the supplier-authorization input of the
   * derived selection — re-resolved at the anchor, never cached).
   */
  async function resolveSupplierMemberships(
    organizationScopeId: string,
    offers: readonly SupplierOffer[],
  ): Promise<Readonly<Record<string, "active" | "revoked" | null>>> {
    const distinctSuppliers = [
      ...new Set(offers.map((offer) => offer.supplierPersonId)),
    ];
    const memberships: Record<string, "active" | "revoked" | null> = {};
    for (const supplierPersonId of distinctSuppliers) {
      memberships[supplierPersonId] = await membershipLookup.resolveMembership(
        supplierPersonId,
        organizationScopeId,
      );
    }
    return memberships;
  }

  /**
   * The in-tx qualification re-derivation (the W026 TOCTOU closure):
   * the pool's CURRENT qualification is re-derived from the
   * tx-scanned ACTIVE commitments at the ONE explicit anchor — never
   * trusted from a pre-flight snapshot or a caller assertion. The
   * requestor membership is "active" by construction (the membership
   * gate already passed — the derivation's own requestor check is
   * satisfied for the acting person).
   */
  async function deriveQualifiedWithinTx(
    organizationScopeId: string,
    pool: ProcurementPool,
    tx: AuthorityTransaction,
    evaluatedAt: string,
  ): Promise<QualifiedProcurementAggregate> {
    const active = (
      await commitmentRepository.listActiveByPoolWithinTx(pool.id, tx)
    )
      .filter((commitment) => hasValidProcurementConsent(commitment))
      .sort(byCreatedAt);
    return deriveQualifiedProcurementAggregate({
      pool,
      commitments: active,
      requestorMembership: "active",
      evaluatedAt,
    });
  }

  const service: SupplierOfferService = {
    async createSupplierOffer(
      execution,
      input: CreateSupplierOfferInput,
    ): Promise<CreateSupplierOfferResult> {
      assertOrganizationScopeId(input.organizationScopeId);
      assertPoolId(input.poolId);
      assertIdempotencyKey(input.idempotencyKey);
      const actor = actingPersonId(execution);
      // THE TENANT ANCHOR FIRST (the clearing-service principle: a
      // missing or cross-scope record fails closed BEFORE anything —
      // cross-tenant is indistinguishable from nonexistent, no
      // existence oracle).
      const pool = await requirePool(input.organizationScopeId, input.poolId);
      // Server-enforced supplier authorization: the acting person
      // must be an ACTIVE member of the tenant organization (never a
      // client claim — issue #52 invariant 1).
      await requireActiveMember(input.organizationScopeId, actor);
      const attributes = validateSupplierOfferAttributes(
        "attributes",
        input.attributes ?? {},
      );
      const submittedAt = nowIso();
      const validUntil = validateSupplierOfferValidity(
        "input",
        input.validUntil ?? null,
        submittedAt,
      );
      // The consent scope may only NAME the one closed scope; the
      // grant (who + when + version) is server-written below.
      if (
        !input.consent ||
        typeof input.consent.scope !== "string" ||
        input.consent.scope !== SUPPLIER_OFFER_CONSENT_SCOPE
      ) {
        throw offerError(
          `consent.scope must be the closed consent scope "${SUPPLIER_OFFER_CONSENT_SCOPE}" (got ${String(input.consent?.scope)})`,
          { field: "consent.scope", scope: String(input.consent?.scope) },
        );
      }
      // The pool must be OPEN (pre-flight; re-checked in-tx).
      if (pool.closedAt !== null) {
        throw offerError(
          `procurement pool is closed: ${input.poolId}`,
          { field: "poolId", poolId: input.poolId, reason: "pool_closed" },
        );
      }
      // THE QUALIFIED-DEMAND GATE (pre-flight; re-derived in-tx):
      // offers may only be submitted against CURRENTLY QUALIFIED
      // NET-W025 demand — derived server-side from the CURRENT active
      // commitments, never caller-asserted.
      const preflight = await deriveQualifiedAggregate(
        pool,
        submittedAt,
      );
      if (!preflight.qualified) {
        throw offerError(
          `procurement pool is not currently qualified: ${input.poolId}`,
          {
            field: "poolId",
            poolId: input.poolId,
            reason: "pool_not_qualified",
          },
        );
      }

      const compositeKey = `procurement_offer:${input.organizationScopeId}:${input.poolId}:${actor}:${input.idempotencyKey}`;
      // The per-pool advisory lock serializes offer writes so the
      // create-once constraint CONSERVES under concurrent submissions
      // (the W020/W025 pair-mutex precedent, scoped to the pool).
      const applied = await idempotency.withLock(
        `procurement_pool_offer:${input.organizationScopeId}:${input.poolId}`,
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
                throw offerError(
                  `procurement pool is closed: ${input.poolId}`,
                  {
                    field: "poolId",
                    poolId: input.poolId,
                    reason: "pool_closed",
                  },
                );
              }
              // In-tx qualified-demand re-derivation (TOCTOU closure:
              // the CURRENT qualification state, from tx-scanned
              // commitments).
              const anchor = nowIso();
              const current = await deriveQualifiedWithinTx(
                input.organizationScopeId,
                freshPool,
                tx,
                anchor,
              );
              if (!current.qualified) {
                throw offerError(
                  `procurement pool is not currently qualified: ${input.poolId}`,
                  {
                    field: "poolId",
                    poolId: input.poolId,
                    reason: "pool_not_qualified",
                  },
                );
              }
              // In-tx create-once constraint: ONE active offer per
              // (pool, supplier) — a stable conflict otherwise. A
              // withdrawn offer never blocks re-offering.
              const existing =
                await offerRepository.findActiveByPoolAndSupplierWithinTx(
                  input.organizationScopeId,
                  input.poolId,
                  actor,
                  tx,
                );
              if (existing !== null) {
                throw new SupplierOfferConflictError(
                  `an active offer already exists for this supplier in pool ${input.poolId}`,
                  {
                    organizationScopeId: input.organizationScopeId,
                    poolId: input.poolId,
                    actorPersonId: actor,
                    existingOfferId: existing.id,
                  },
                );
              }
              const offer: SupplierOffer = Object.freeze({
                id: randomUUID(),
                organizationScopeId: input.organizationScopeId,
                poolId: input.poolId,
                // The supplier IS the acting person — there is no
                // supplierPersonId input (offer ownership cannot be
                // fabricated by client claims).
                supplierPersonId: actor,
                categoryKey: freshPool.categoryKey,
                categoryVersion: freshPool.categoryVersion,
                attributes: Object.freeze({
                  region: attributes.region,
                  unitPriceBand: attributes.unitPriceBand,
                  timingWindow: attributes.timingWindow,
                  quantityBucket: attributes.quantityBucket,
                }),
                consent: Object.freeze({
                  scope: SUPPLIER_OFFER_CONSENT_SCOPE,
                  version: SUPPLIER_OFFER_CONSENT_VERSION,
                  grantedAt: anchor,
                  grantedBy: actor,
                }),
                withdrawnAt: null,
                withdrawalReason: null,
                validFrom: anchor,
                validUntil,
                recordFormat: SUPPLIER_OFFER_RECORD_FORMAT,
                createdAt: anchor,
                updatedAt: anchor,
                idempotencyKey: input.idempotencyKey,
                executionId: execution.executionId,
                correlationId: execution.correlationId,
                causationId: execution.causationId,
              });
              await offerRepository.createWithinTx(offer, tx);
              await appendAudit(tx, {
                eventType: PROCUREMENT_OFFER_RECORDED,
                context: execution,
                actor,
                subject: offer.id,
                resourceType: "procurement_offer",
                resourceId: offer.id,
                metadata: {
                  organizationScopeId: offer.organizationScopeId,
                  poolId: offer.poolId,
                  supplierPersonId: offer.supplierPersonId,
                  categoryKey: offer.categoryKey,
                  categoryVersion: offer.categoryVersion,
                  attributes: {
                    region: offer.attributes.region,
                    unitPriceBand: offer.attributes.unitPriceBand,
                    timingWindow: offer.attributes.timingWindow,
                    quantityBucket: offer.attributes.quantityBucket,
                  },
                  consentScope: offer.consent.scope,
                  consentVersion: offer.consent.version,
                  validFrom: offer.validFrom,
                  validUntil: offer.validUntil,
                  idempotencyRecordId: ctx.recordId,
                  transactionId: tx.transactionId,
                },
              });
              return offer;
            },
            execution,
          ),
      );
      return {
        offer: applied.result,
        created: applied.executed,
      };
    },

    async withdrawSupplierOffer(
      execution,
      input: WithdrawSupplierOfferInput,
    ): Promise<SupplierOffer> {
      assertOrganizationScopeId(input.organizationScopeId);
      assertIdempotencyKey(input.idempotencyKey);
      const actor = actingPersonId(execution);
      // Tenant anchor + supplier-only gate (pre-flight; re-checked
      // in-tx).
      const offer = await requireOffer(
        input.organizationScopeId,
        input.offerId,
      );
      requireOfferSupplier(actor, offer);
      await requireActiveMember(input.organizationScopeId, actor);
      const reason = validateOptionalProse("reason", input.reason ?? null);
      const key = `procurement_offer_withdraw:${input.organizationScopeId}:${input.offerId}:${input.idempotencyKey}`;
      const applied = await idempotency.applyIdempotent(
        key,
        async (ctx) => {
          const tx = ctx.transaction;
          // In-tx fresh existence + scope + supplier re-check
          // (TOCTOU closure).
          const fresh = await offerRepository.getByIdWithinTx(
            offer.id,
            tx,
          );
          if (
            !fresh ||
            fresh.organizationScopeId !== input.organizationScopeId
          ) {
            throw new NotFoundError(
              `supplier offer not found: ${input.offerId}`,
              {
                id: input.offerId,
                organizationScopeId: input.organizationScopeId,
              },
            );
          }
          requireOfferSupplier(actor, fresh);
          const withdrawn = await offerRepository.withdrawWithinTx(
            fresh.id,
            nowIso(),
            reason,
            tx,
          );
          await appendAudit(tx, {
            eventType: PROCUREMENT_OFFER_WITHDRAWN,
            context: execution,
            actor,
            subject: withdrawn.id,
            resourceType: "procurement_offer",
            resourceId: withdrawn.id,
            metadata: {
              organizationScopeId: withdrawn.organizationScopeId,
              poolId: withdrawn.poolId,
              supplierPersonId: withdrawn.supplierPersonId,
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

    async getSupplierOffer(execution, organizationScopeId, offerId) {
      assertOrganizationScopeId(organizationScopeId);
      return requireOffer(organizationScopeId, offerId);
    },

    async listSupplierOffers(
      execution,
      organizationScopeId,
      filters,
    ) {
      assertOrganizationScopeId(organizationScopeId);
      return offerRepository.listByOrganization(organizationScopeId, filters);
    },

    async evaluateCompetitiveSelection(
      execution,
      input,
    ): Promise<CompetitiveSelectionView> {
      assertOrganizationScopeId(input.organizationScopeId);
      assertPoolId(input.poolId);
      // The acting person authorizes the selection view (the guard
      // action + the creator gate below).
      const requestor = actingPersonId(execution);
      // Tenant anchor from the authority's own record (cross-tenant =
      // NotFoundError — no existence oracle).
      const pool = await requirePool(input.organizationScopeId, input.poolId);
      await requireActiveMember(input.organizationScopeId, requestor);
      // Pool-creator-only: the selection view exposes individual
      // supplier offer terms — supplier commercial terms never cross
      // to other pool participants (PROC-003 / PROC-AC-02; the
      // closure-authorization precedent).
      requirePoolCreator(requestor, pool);
      // The ONE explicit evaluation anchor (the W021/W024/W025
      // precedent): no wall clock inside the derivation; recorded on
      // the view. The qualified aggregate is re-derived at the SAME
      // anchor from the CURRENT active commitments.
      const evaluatedAt = nowIso();
      const aggregate = await deriveQualifiedAggregate(
        pool,
        evaluatedAt,
      );
      // The authoritative offer inputs, re-read at evaluation time:
      // the CURRENT active offers, deterministically ordered.
      const offers = [...(await offerRepository.listActiveByPool(pool.id))].sort(
        byCreatedAt,
      );
      const supplierMemberships = await resolveSupplierMemberships(
        input.organizationScopeId,
        offers,
      );
      logger.debug("procurement_selection.evaluated", {
        poolId: pool.id,
        organizationScopeId: pool.organizationScopeId,
        evaluationAnchor: evaluatedAt,
      });
      return deriveCompetitiveSelection({
        pool,
        qualifiedAggregate: aggregate,
        offers,
        supplierMemberships,
        evaluatedAt,
      });
    },

    async recordCompetitiveSelection(
      execution,
      input: RecordCompetitiveSelectionInput,
    ): Promise<RecordCompetitiveSelectionResult> {
      assertOrganizationScopeId(input.organizationScopeId);
      assertPoolId(input.poolId);
      assertIdempotencyKey(input.idempotencyKey);
      const actor = actingPersonId(execution);
      // Tenant anchor from the authority's own record (cross-tenant =
      // NotFoundError — no existence oracle).
      const pool = await requirePool(input.organizationScopeId, input.poolId);
      await requireActiveMember(input.organizationScopeId, actor);
      // The competitive selection is the DEMAND OWNER's decision:
      // pool-creator-only (the closure-authorization precedent —
      // a caller cannot fabricate selection authority).
      requirePoolCreator(actor, pool);

      const compositeKey = `procurement_selection:${input.organizationScopeId}:${input.poolId}:${input.idempotencyKey}`;
      // The per-pool advisory lock serializes selection records so
      // concurrent selections over one pool are ordered (each remains
      // deterministic at its own anchor; no nondeterministic
      // selection state can interleave).
      const applied = await idempotency.withLock(
        `procurement_pool_selection:${input.organizationScopeId}:${input.poolId}`,
        () =>
          idempotency.applyIdempotent(
            compositeKey,
            async (ctx) => {
              const tx = ctx.transaction;
              // In-tx fresh pool read + scope + creator re-check
              // (TOCTOU closure).
              const freshPool = await requirePoolWithinTx(
                input.organizationScopeId,
                input.poolId,
                tx,
              );
              requirePoolCreator(actor, freshPool);
              // The ONE explicit evaluation anchor, set ONCE inside
              // the authoritative transaction; the selection is
              // re-derived from CURRENT tx-scanned records at this
              // anchor (work order §6 — never a stored/caller-
              // asserted qualification or ranking).
              const evaluatedAt = nowIso();
              const aggregate = await deriveQualifiedWithinTx(
                input.organizationScopeId,
                freshPool,
                tx,
                evaluatedAt,
              );
              // Unqualified (incl. closed or withdrawn) demand
              // cannot ENTER competitive selection — the material
              // record fails closed (the derived view may still show
              // the decision; this command is authoritative).
              if (!aggregate.qualified) {
                throw offerError(
                  `procurement pool is not currently qualified: ${input.poolId}`,
                  {
                    field: "poolId",
                    poolId: input.poolId,
                    reason: "pool_not_qualified",
                  },
                );
              }
              const offers = [
                ...(await offerRepository.listActiveByPoolWithinTx(
                  freshPool.id,
                  tx,
                )),
              ].sort(byCreatedAt);
              const supplierMemberships =
                await resolveSupplierMemberships(
                  input.organizationScopeId,
                  offers,
                );
              const view = deriveCompetitiveSelection({
                pool: freshPool,
                qualifiedAggregate: aggregate,
                offers,
                supplierMemberships,
                evaluatedAt,
              });
              const selection: CompetitiveSelection = Object.freeze({
                id: randomUUID(),
                organizationScopeId: input.organizationScopeId,
                poolId: freshPool.id,
                // The recorder IS the acting pool creator (server-
                // resolved above).
                recordedBy: actor,
                selectionPolicy: Object.freeze({
                  version: view.selectionPolicy.version,
                  rankingCriteria: view.selectionPolicy.rankingCriteria,
                }),
                poolDigest: view.poolDigest,
                qualified: view.qualified,
                evaluationAnchor: view.evaluatedAt,
                consideredOfferIds: view.consideredOfferIds,
                eligibleOfferIds: view.eligibleOfferIds,
                offerEvaluations: view.offerEvaluations,
                checks: view.checks,
                ranking: view.ranking,
                selectedOfferId: view.selectedOfferId,
                digest: view.digest,
                recordFormat: COMPETITIVE_SELECTION_RECORD_FORMAT,
                createdAt: evaluatedAt,
                updatedAt: evaluatedAt,
                idempotencyKey: input.idempotencyKey,
                executionId: execution.executionId,
                correlationId: execution.correlationId,
                causationId: execution.causationId,
              });
              await selectionRepository.createWithinTx(selection, tx);
              await appendAudit(tx, {
                eventType: PROCUREMENT_SELECTION_RECORDED,
                context: execution,
                actor,
                subject: selection.id,
                resourceType: "procurement_selection",
                resourceId: selection.id,
                metadata: {
                  organizationScopeId: selection.organizationScopeId,
                  poolId: selection.poolId,
                  recordedBy: selection.recordedBy,
                  selectionPolicy: {
                    version: selection.selectionPolicy.version,
                    rankingCriteria: selection.selectionPolicy.rankingCriteria,
                  },
                  poolDigest: selection.poolDigest,
                  qualified: selection.qualified,
                  evaluationAnchor: selection.evaluationAnchor,
                  consideredOfferCount: selection.consideredOfferIds.length,
                  eligibleOfferCount: selection.eligibleOfferIds.length,
                  selectedOfferId: selection.selectedOfferId,
                  digest: selection.digest,
                  idempotencyRecordId: ctx.recordId,
                  transactionId: tx.transactionId,
                },
              });
              return selection;
            },
            execution,
          ),
      );
      return {
        selection: applied.result,
        created: applied.executed,
      };
    },

    async listPoolSelections(execution, input) {
      assertOrganizationScopeId(input.organizationScopeId);
      assertPoolId(input.poolId);
      const requestor = actingPersonId(execution);
      // Tenant anchor + pool-creator gate (the lineage exposes
      // individual supplier offer terms — PROC-003).
      const pool = await requirePool(input.organizationScopeId, input.poolId);
      await requireActiveMember(input.organizationScopeId, requestor);
      requirePoolCreator(requestor, pool);
      return selectionRepository.listByOrganization(
        input.organizationScopeId,
        { poolId: pool.id },
      );
    },
  };

  /**
   * The committed (non-tx) qualified-aggregate derivation used by the
   * pre-flight gate and the derived evaluation view.
   */
  async function deriveQualifiedAggregate(
    pool: ProcurementPool,
    evaluatedAt: string,
  ): Promise<QualifiedProcurementAggregate> {
    const active = (await commitmentRepository.listActiveByPool(pool.id))
      .filter((commitment) => hasValidProcurementConsent(commitment))
      .sort(byCreatedAt);
    return deriveQualifiedProcurementAggregate({
      pool,
      commitments: active,
      // "active" by construction: every caller of this helper has
      // already passed the membership gate for the acting person.
      requestorMembership: "active",
      evaluatedAt,
    });
  }

  return service;
}

/**
 * Creator-only authorization against the DURABLE pool record: the
 * acting person must be the pool's creator (server-side — a caller
 * cannot fabricate selection authority; the closure-authorization
 * precedent).
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
 * Supplier-only authorization against the DURABLE offer record: the
 * acting person must be the offer's supplier (server-side — only the
 * supplier may withdraw the consent they granted).
 */
function requireOfferSupplier(actor: string, offer: SupplierOffer): void {
  if (actor !== offer.supplierPersonId) {
    throw new AuthorizationError(
      "only the supplier offer's supplier may perform this action",
      {
        actorPersonId: actor,
        supplierPersonId: offer.supplierPersonId,
        offerId: offer.id,
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
