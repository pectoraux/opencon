/**
 * NET-W026 shared test harness — Supplier offers and competitive
 * selection.
 *
 * Wraps the NET-W025 harness (which wraps the W024 → W008 chain:
 * runtime + persons + organizations + the demand/procurement
 * guard-action policies; the file-backed PostgresAuthorityShim so no
 * real PostgreSQL is needed). This harness creates THREE SUPPLIER
 * actors (tenant members with NO buyer-organization membership — the
 * authorized-supplier gate is ACTIVE tenant membership), seeds the
 * six NET-W026 guard actions, and exposes offer/selection factories
 * plus the qualified-pool-with-offers seed (the multi-supplier
 * competition model).
 */

import { randomUUID } from "node:crypto";
import {
  createNetW025Harness,
  seedThreeOrgPool,
  type NetW025Harness,
} from "./_net-w025-harness.ts";
import type { NetW008HarnessOptions } from "../settlement/_net-w008-harness.ts";
import { createExecutionContext } from "../../src/core/execution-context.ts";
import type { ExecutionContext } from "../../src/core/execution-context.ts";
import type { Runtime } from "../../src/bootstrap/runtime.ts";
import type {
  CompetitiveSelection,
  ProcurementPool,
  SupplierOffer,
} from "../../src/demand/port.ts";
import type { ProcurementRegionCode } from "../../src/core/procurement.ts";

export interface NetW026Harness {
  readonly w025: NetW025Harness;
  readonly runtime: Runtime;
  readonly bootstrapCtx: ExecutionContext;
  readonly organizationScopeId: string;
  /** Supplier A — the W025 supplier-side tenant member. */
  readonly supplierAPersonId: string;
  readonly supplierASubjectId: string;
  /** Supplier B — an additional supplier-side tenant member. */
  readonly supplierBPersonId: string;
  readonly supplierBSubjectId: string;
  /** Supplier C — an additional supplier-side tenant member. */
  readonly supplierCPersonId: string;
  readonly supplierCSubjectId: string;
  teardown(): Promise<void>;
}

/**
 * The NET-W026 API guard actions seeded by this harness (subject "*",
 * resource "*" — the guard is the transport authorization; the
 * domain-layer membership/creator/eligibility gates are the tests'
 * subject).
 */
const GUARD_ACTIONS = [
  "demand.procurement.offers.create",
  "demand.procurement.offers.withdraw",
  "demand.procurement.offers.read",
  "demand.procurement.selections.evaluate",
  "demand.procurement.selections.record",
  "demand.procurement.selections.read",
];

/** The supplier actors' person ids by harness slot. */
export function supplierPersonId(
  harness: NetW026Harness,
  slot: "A" | "B" | "C",
): string {
  if (slot === "A") return harness.supplierAPersonId;
  if (slot === "B") return harness.supplierBPersonId;
  return harness.supplierCPersonId;
}

export async function createNetW026Harness(
  opts: NetW008HarnessOptions = {},
): Promise<NetW026Harness> {
  const w025 = await createNetW025Harness(opts);
  const runtime = w025.runtime;
  const bootstrapCtx = w025.bootstrapCtx;

  // The additional supplier actors: ACTIVE tenant membership ONLY (no
  // buyer-organization membership — suppliers are not buyers; the
  // authorized-supplier gate is the tenant membership).
  const supplierB = await createSupplierMember(
    runtime,
    bootstrapCtx,
    w025.organizationScopeId,
    {
      displayName: "W026 Supplier B",
      subjectId: "w026-supplier-b@example.com",
    },
  );
  const supplierC = await createSupplierMember(
    runtime,
    bootstrapCtx,
    w025.organizationScopeId,
    {
      displayName: "W026 Supplier C",
      subjectId: "w026-supplier-c@example.com",
    },
  );

  for (const action of GUARD_ACTIONS) {
    await runtime.policyService.createPolicy(bootstrapCtx, {
      subject: "*",
      action,
      resource: "*",
      effect: "allow",
      createdBy: "bootstrap",
    });
  }

  return {
    w025,
    runtime,
    bootstrapCtx,
    organizationScopeId: w025.organizationScopeId,
    supplierAPersonId: w025.supplierPersonId,
    supplierASubjectId: w025.supplierSubjectId,
    supplierBPersonId: supplierB.personId,
    supplierBSubjectId: supplierB.subjectId,
    supplierCPersonId: supplierC.personId,
    supplierCSubjectId: supplierC.subjectId,
    async teardown() {
      await runtime.shutdown();
    },
  };
}

/** A supplier actor's execution context by harness slot. */
export function supplierCtxBySlot(
  harness: NetW026Harness,
  slot: "A" | "B" | "C",
  correlationId: string,
): ExecutionContext {
  return createExecutionContext({
    correlationId,
    actor: { id: supplierPersonId(harness, slot), kind: "person" },
  });
}

/**
 * The pool creator's execution context — buyer A (the default pool
 * creator of the W025 factories: createProcurementPool defaults to
 * buyer A's context, so buyer A IS the pool creator / the selection
 * authority).
 */
export function poolCreatorCtx(
  harness: NetW026Harness,
  correlationId: string,
): ExecutionContext {
  const buyerA = harness.w025.buyerAPersonId;
  return createExecutionContext({
    correlationId,
    actor: { id: buyerA, kind: "person" },
  });
}

/** Any person's execution context. */
export function personCtx(
  personId: string,
  correlationId: string,
): ExecutionContext {
  return createExecutionContext({
    correlationId,
    actor: { id: personId, kind: "person" },
  });
}

/** Fresh idempotency keys (unique per call). */
export function key(prefix: string): string {
  return `${prefix}-${randomUUID()}`;
}

/**
 * Create an additional supplier-side person with ACTIVE membership in
 * the TENANT organization ONLY (no buyer-organization membership —
 * the authorized-supplier actor).
 */
export async function createSupplierMember(
  runtime: Runtime,
  bootstrapCtx: ExecutionContext,
  organizationScopeId: string,
  opts: {
    readonly displayName: string;
    readonly subjectId: string;
  },
): Promise<{
  readonly personId: string;
  readonly subjectId: string;
  /** The TENANT membership id (revocation scenarios). */
  readonly tenantMembershipId: string;
}> {
  const person = await runtime.identityService.createIdentity(
    bootstrapCtx,
    {
      displayName: opts.displayName,
      subjectReferences: [
        { subjectId: opts.subjectId, providerKind: "internal" },
      ],
    },
  );
  const granted = await runtime.membershipService.grantMembership(
    bootstrapCtx,
    {
      personId: person.id,
      organizationId: organizationScopeId,
      grantedBy: "bootstrap",
    },
  );
  return {
    personId: person.id,
    subjectId: opts.subjectId,
    tenantMembershipId: granted.membership.id,
  };
}

// ---------------------------------------------------------------------------
// Record factories
// ---------------------------------------------------------------------------

/**
 * Record one supplier offer (defaults: supplier A, NA_EAST,
 * price_b_10_49, window_short_1_3mo, q_100_999, consent
 * competitive_selection, open-ended validity).
 */
export async function createSupplierOffer(
  harness: NetW026Harness,
  opts: {
    readonly poolId: string;
    readonly ctx?: ExecutionContext;
    readonly region?: ProcurementRegionCode;
    readonly unitPriceBand?: string;
    readonly timingWindow?: string;
    readonly quantityBucket?: string;
    readonly validUntil?: string | null;
    readonly consentScope?: string;
  },
): Promise<SupplierOffer> {
  const ctx =
    opts.ctx ?? supplierCtxBySlot(harness, "A", "w026-offer");
  const result = await harness.runtime.supplierOfferService
    .createSupplierOffer(ctx, {
      organizationScopeId: harness.organizationScopeId,
      poolId: opts.poolId,
      attributes: {
        region: opts.region ?? "NA_EAST",
        unitPriceBand: opts.unitPriceBand ?? "price_b_10_49",
        timingWindow: opts.timingWindow ?? "window_short_1_3mo",
        quantityBucket: opts.quantityBucket ?? "q_100_999",
      },
      ...(opts.validUntil !== undefined
        ? { validUntil: opts.validUntil }
        : {}),
      consent: { scope: opts.consentScope ?? "competitive_selection" },
      idempotencyKey: key("w026-offer"),
    });
  return result.offer;
}

/**
 * Seed a QUALIFIED pool with NO offers (the W025 three-organization
 * seed — one commitment from each buyer organization, all NA_EAST so
 * the region group is NAMED above the floor). The base for
 * offer-creation tests that need a clean supplier slate.
 */
export async function seedQualifiedPool(
  harness: NetW026Harness,
  opts: {
    readonly name?: string;
    readonly minimumCommitments?: number;
    readonly minimumOrganizations?: number;
  } = {},
): Promise<ProcurementPool> {
  return seedThreeOrgPool(harness.w025, {
    name: opts.name ?? "W026 Qualified Pool",
    minimumCommitments: opts.minimumCommitments ?? 2,
    minimumOrganizations: opts.minimumOrganizations ?? 2,
  });
}

/**
 * Seed a QUALIFIED pool with THREE competing supplier offers — the
 * full competition model: one commitment from each buyer
 * organization (all NA_EAST so the region group is NAMED above the
 * floor) plus one offer from each supplier (A cheapest, B middle, C
 * most expensive). Returns the pool.
 */
export async function seedCompetitivePool(
  harness: NetW026Harness,
  opts: {
    readonly name?: string;
    readonly minimumCommitments?: number;
    readonly minimumOrganizations?: number;
  } = {},
): Promise<ProcurementPool> {
  const pool = await seedThreeOrgPool(harness.w025, {
    name: opts.name ?? "W026 Competitive Pool",
    minimumCommitments: opts.minimumCommitments ?? 2,
    minimumOrganizations: opts.minimumOrganizations ?? 2,
  });
  await createSupplierOffer(harness, {
    poolId: pool.id,
    ctx: supplierCtxBySlot(harness, "A", "w026-seed-a"),
    region: "NA_EAST",
    unitPriceBand: "price_a_under_10",
    timingWindow: "window_short_1_3mo",
    quantityBucket: "q_100_999",
  });
  await createSupplierOffer(harness, {
    poolId: pool.id,
    ctx: supplierCtxBySlot(harness, "B", "w026-seed-b"),
    region: "NA_EAST",
    unitPriceBand: "price_b_10_49",
    timingWindow: "window_short_1_3mo",
    quantityBucket: "q_100_999",
  });
  await createSupplierOffer(harness, {
    poolId: pool.id,
    ctx: supplierCtxBySlot(harness, "C", "w026-seed-c"),
    region: "NA_EAST",
    unitPriceBand: "price_c_50_99",
    timingWindow: "window_short_1_3mo",
    quantityBucket: "q_100_999",
  });
  return pool;
}

/**
 * Record the authoritative competitive selection for the pool (the
 * pool creator — buyer A — by default).
 */
export async function recordCompetitiveSelection(
  harness: NetW026Harness,
  opts: {
    readonly poolId: string;
    readonly ctx?: ExecutionContext;
    readonly idempotencyKey?: string;
  },
): Promise<CompetitiveSelection> {
  const ctx = opts.ctx ?? poolCreatorCtx(harness, "w026-selection");
  const result = await harness.runtime.supplierOfferService
    .recordCompetitiveSelection(ctx, {
      organizationScopeId: harness.organizationScopeId,
      poolId: opts.poolId,
      idempotencyKey: opts.idempotencyKey ?? key("w026-selection"),
    });
  return result.selection;
}
