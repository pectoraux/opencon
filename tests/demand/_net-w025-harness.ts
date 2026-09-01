/**
 * NET-W025 shared test harness — Business procurement pools.
 *
 * Wraps the NET-W024 harness (which wraps the NET-W008 harness:
 * runtime + two persons + organization + the demand-layer
 * guard-action policies; the file-backed PostgresAuthorityShim so no
 * real PostgreSQL is needed). This harness creates THREE buyer
 * organizations (the multi-buyer competition model: the aggregate
 * spans DISTINCT buyer organizations), grants each buyer person
 * ACTIVE membership in BOTH the tenant organization AND their buyer
 * organization (the dual authorization gates), seeds the six
 * procurement guard actions, and exposes person factories for the
 * non-member, supplier-side and extra-buyer-member scenarios.
 */

import { randomUUID } from "node:crypto";
import {
  createNetW024Harness,
  type NetW024Harness,
} from "./_net-w024-harness.ts";
import type { NetW008HarnessOptions } from "../settlement/_net-w008-harness.ts";
import { createExecutionContext } from "../../src/core/execution-context.ts";
import type { ExecutionContext } from "../../src/core/execution-context.ts";
import type { Runtime } from "../../src/bootstrap/runtime.ts";
import type {
  ProcurementCommitment,
  ProcurementPool,
} from "../../src/demand/port.ts";
import type { ProcurementRegionCode } from "../../src/core/procurement.ts";

export interface NetW025Harness {
  readonly w024: NetW024Harness;
  readonly runtime: Runtime;
  readonly bootstrapCtx: ExecutionContext;
  readonly organizationScopeId: string;
  /** Buyer organization A (+ its authorized representative). */
  readonly buyerOrgAId: string;
  readonly buyerAPersonId: string;
  readonly buyerASubjectId: string;
  /** Buyer organization B (+ its authorized representative). */
  readonly buyerOrgBId: string;
  readonly buyerBPersonId: string;
  readonly buyerBSubjectId: string;
  /** Buyer organization C (+ its authorized representative). */
  readonly buyerOrgCId: string;
  readonly buyerCPersonId: string;
  readonly buyerCSubjectId: string;
  /**
   * A tenant member with NO buyer-organization membership (the
   * supplier-side requestor / buyer-authorization failure actor).
   */
  readonly supplierPersonId: string;
  readonly supplierSubjectId: string;
  teardown(): Promise<void>;
}

/**
 * The procurement API guard actions seeded by this harness (subject
 * "*", resource "*" — the guard is the transport authorization; the
 * domain-layer dual-membership/consent/owner gates are the tests'
 * subject).
 */
const GUARD_ACTIONS = [
  "demand.procurement.pools.create",
  "demand.procurement.pools.close",
  "demand.procurement.commitments.create",
  "demand.procurement.commitments.withdraw",
  "demand.procurement.aggregates.evaluate",
  "demand.procurement.commitments.read",
];

/** The buyer organizations' identifiers by harness slot. */
export function buyerOrgId(
  harness: NetW025Harness,
  slot: "A" | "B" | "C",
): string {
  if (slot === "A") return harness.buyerOrgAId;
  if (slot === "B") return harness.buyerOrgBId;
  return harness.buyerOrgCId;
}

/** The default buyer representative's person id by harness slot. */
export function buyerPersonId(
  harness: NetW025Harness,
  slot: "A" | "B" | "C",
): string {
  if (slot === "A") return harness.buyerAPersonId;
  if (slot === "B") return harness.buyerBPersonId;
  return harness.buyerCPersonId;
}

export async function createNetW025Harness(
  opts: NetW008HarnessOptions = {},
): Promise<NetW025Harness> {
  const w024 = await createNetW024Harness(opts);
  const runtime = w024.runtime;
  const bootstrapCtx = w024.bootstrapCtx;

  // The three buyer organizations (created through the /organizations
  // authority — the membership source for the buyer-authorization
  // gate).
  const orgA = await runtime.organizationService.createOrganization(
    bootstrapCtx,
    { name: "W025 Buyer Org A", creatorId: w024.consumerPersonId },
  );
  const orgB = await runtime.organizationService.createOrganization(
    bootstrapCtx,
    { name: "W025 Buyer Org B", creatorId: w024.consumerPersonId },
  );
  const orgC = await runtime.organizationService.createOrganization(
    bootstrapCtx,
    { name: "W025 Buyer Org C", creatorId: w024.consumerPersonId },
  );

  // The buyer representatives: ACTIVE membership in BOTH the tenant
  // organization AND their buyer organization (the dual
  // server-enforced authorization input).
  const buyerA = await createBuyerMember(
    runtime,
    bootstrapCtx,
    w024.organizationScopeId,
    orgA.id,
    {
      displayName: "W025 Buyer A",
      subjectId: "w025-buyer-a@example.com",
    },
  );
  const buyerB = await createBuyerMember(
    runtime,
    bootstrapCtx,
    w024.organizationScopeId,
    orgB.id,
    {
      displayName: "W025 Buyer B",
      subjectId: "w025-buyer-b@example.com",
    },
  );
  const buyerC = await createBuyerMember(
    runtime,
    bootstrapCtx,
    w024.organizationScopeId,
    orgC.id,
    {
      displayName: "W025 Buyer C",
      subjectId: "w025-buyer-c@example.com",
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
    w024,
    runtime,
    bootstrapCtx,
    organizationScopeId: w024.organizationScopeId,
    buyerOrgAId: orgA.id,
    buyerAPersonId: buyerA.personId,
    buyerASubjectId: buyerA.subjectId,
    buyerOrgBId: orgB.id,
    buyerBPersonId: buyerB.personId,
    buyerBSubjectId: buyerB.subjectId,
    buyerOrgCId: orgC.id,
    buyerCPersonId: buyerC.personId,
    buyerCSubjectId: buyerC.subjectId,
    supplierPersonId: w024.supplierPersonId,
    supplierSubjectId: w024.supplierSubjectId,
    async teardown() {
      await runtime.shutdown();
    },
  };
}

/** A buyer representative's execution context by harness slot. */
export function buyerCtx(
  harness: NetW025Harness,
  slot: "A" | "B" | "C",
  correlationId: string,
): ExecutionContext {
  return createExecutionContext({
    correlationId,
    actor: { id: buyerPersonId(harness, slot), kind: "person" },
  });
}

/** The supplier-side member's execution context (tenant member only). */
export function supplierCtx(
  harness: NetW025Harness,
  correlationId: string,
): ExecutionContext {
  return createExecutionContext({
    correlationId,
    actor: { id: harness.supplierPersonId, kind: "person" },
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
 * Create an additional person with ACTIVE membership in BOTH the
 * tenant organization and the given buyer organization (the extra
 * buyer-member scenarios: multi-commitment single-organization
 * aggregates, concurrency, extra submitters).
 */
export async function createBuyerMember(
  runtime: Runtime,
  bootstrapCtx: ExecutionContext,
  organizationScopeId: string,
  orgId: string,
  opts: {
    readonly displayName: string;
    readonly subjectId: string;
  },
): Promise<{ readonly personId: string; readonly subjectId: string }> {
  const person = await runtime.identityService.createIdentity(
    bootstrapCtx,
    {
      displayName: opts.displayName,
      subjectReferences: [
        { subjectId: opts.subjectId, providerKind: "internal" },
      ],
    },
  );
  await runtime.membershipService.grantMembership(bootstrapCtx, {
    personId: person.id,
    organizationId: organizationScopeId,
    grantedBy: "bootstrap",
  });
  await runtime.membershipService.grantMembership(bootstrapCtx, {
    personId: person.id,
    organizationId: orgId,
    grantedBy: "bootstrap",
  });
  return { personId: person.id, subjectId: opts.subjectId };
}

// ---------------------------------------------------------------------------
// Record factories
// ---------------------------------------------------------------------------

/** Create a procurement pool (buyer A by default; bounded defaults). */
export async function createProcurementPool(
  harness: NetW025Harness,
  opts: {
    readonly ctx?: ExecutionContext;
    readonly name?: string;
    readonly categoryKey?: string;
    readonly minimumCommitments?: number;
    readonly minimumOrganizations?: number;
  } = {},
): Promise<ProcurementPool> {
  const ctx = opts.ctx ?? buyerCtx(harness, "A", "w025-pool");
  const result = await harness.runtime.procurementService
    .createProcurementPool(ctx, {
      organizationScopeId: harness.organizationScopeId,
      name: opts.name ?? "W025 Test Pool",
      categoryKey: opts.categoryKey ?? "cloud_infrastructure",
      qualificationPolicy: {
        minimumCommitments: opts.minimumCommitments ?? 2,
        minimumOrganizations: opts.minimumOrganizations ?? 2,
      },
      idempotencyKey: key("w025-pool"),
    });
  return result.pool;
}

/**
 * Record one business demand commitment (defaults: buyer A for
 * organization A, NA_EAST, 12; consent aggregate_disclosure).
 */
export async function createProcurementCommitment(
  harness: NetW025Harness,
  opts: {
    readonly poolId: string;
    readonly ctx?: ExecutionContext;
    readonly buyerOrganizationId?: string;
    readonly region?: ProcurementRegionCode;
    readonly quantity?: number;
    readonly budgetBand?: string | null;
    readonly unitPriceBand?: string | null;
    readonly timingWindow?: string | null;
  },
): Promise<ProcurementCommitment> {
  const ctx = opts.ctx ?? buyerCtx(harness, "A", "w025-commitment");
  const result = await harness.runtime.procurementService
    .createProcurementCommitment(ctx, {
      organizationScopeId: harness.organizationScopeId,
      poolId: opts.poolId,
      buyerOrganizationId:
        opts.buyerOrganizationId ?? harness.buyerOrgAId,
      attributes: {
        region: opts.region ?? "NA_EAST",
        quantity: opts.quantity ?? 12,
        ...(opts.budgetBand !== undefined
          ? { budgetBand: opts.budgetBand }
          : {}),
        ...(opts.unitPriceBand !== undefined
          ? { unitPriceBand: opts.unitPriceBand }
          : {}),
        ...(opts.timingWindow !== undefined
          ? { timingWindow: opts.timingWindow }
          : {}),
      },
      consent: { scope: "aggregate_disclosure" },
      idempotencyKey: key("w025-commitment"),
    });
  return result.commitment;
}

/**
 * Seed a QUALIFIED pool: one commitment from each of the three buyer
 * organizations (distinct regions so no group is suppressed by
 * default). Returns the pool.
 */
export async function seedThreeOrgPool(
  harness: NetW025Harness,
  opts: {
    readonly name?: string;
    readonly minimumCommitments?: number;
    readonly minimumOrganizations?: number;
  } = {},
): Promise<ProcurementPool> {
  const pool = await createProcurementPool(harness, {
    name: opts.name ?? "W025 Three Org Pool",
    minimumCommitments: opts.minimumCommitments ?? 2,
    minimumOrganizations: opts.minimumOrganizations ?? 2,
  });
  await createProcurementCommitment(harness, {
    poolId: pool.id,
    ctx: buyerCtx(harness, "A", "w025-seed-a"),
    buyerOrganizationId: harness.buyerOrgAId,
    region: "NA_EAST",
    quantity: 12,
    budgetBand: "band_b_1k_9k",
    unitPriceBand: "price_b_10_49",
    timingWindow: "window_short_1_3mo",
  });
  await createProcurementCommitment(harness, {
    poolId: pool.id,
    ctx: buyerCtx(harness, "B", "w025-seed-b"),
    buyerOrganizationId: harness.buyerOrgBId,
    region: "NA_EAST",
    quantity: 40,
    budgetBand: "band_b_1k_9k",
    unitPriceBand: "price_b_10_49",
    timingWindow: "window_short_1_3mo",
  });
  await createProcurementCommitment(harness, {
    poolId: pool.id,
    ctx: buyerCtx(harness, "C", "w025-seed-c"),
    buyerOrganizationId: harness.buyerOrgCId,
    region: "NA_EAST",
    quantity: 75,
    budgetBand: "band_b_1k_9k",
    unitPriceBand: "price_b_10_49",
    timingWindow: "window_short_1_3mo",
  });
  return pool;
}
