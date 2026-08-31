/**
 * NET-W024 shared test harness — Consumer Demand Pools.
 *
 * Wraps the NET-W008 harness (runtime + two persons + organization +
 * the settlement-layer guard-action policies; the file-backed
 * PostgresAuthorityShim so no real PostgreSQL is needed). This
 * harness grants ACTIVE memberships for both persons (the consumer /
 * pool creator and the supplier-side requestor / second consumer),
 * seeds the six demand guard actions, and exposes person factories
 * for the non-member and multi-consumer acceptance scenarios.
 */

import { randomUUID } from "node:crypto";
import {
  createNetW008Harness,
  type NetW008Harness,
  type NetW008HarnessOptions,
} from "../settlement/_net-w008-harness.ts";
import { createExecutionContext } from "../../src/core/execution-context.ts";
import type { ExecutionContext } from "../../src/core/execution-context.ts";
import type { Runtime } from "../../src/bootstrap/runtime.ts";
import type {
  DemandCommitment,
  DemandPool,
} from "../../src/demand/port.ts";
import type { DemandRegionCode } from "../../src/core/demand.ts";

export interface NetW024Harness {
  readonly w008: NetW008Harness;
  readonly runtime: Runtime;
  readonly bootstrapCtx: ExecutionContext;
  readonly organizationScopeId: string;
  /** The consumer + pool creator (an ACTIVE org member). */
  readonly consumerPersonId: string;
  readonly consumerSubjectId: string;
  /** A second ACTIVE member: supplier-side requestor / second consumer. */
  readonly supplierPersonId: string;
  readonly supplierSubjectId: string;
  teardown(): Promise<void>;
}

/**
 * The demand API guard actions seeded by this harness (subject "*",
 * resource "*" — the guard is the transport authorization; the
 * domain-layer membership/consent/owner gates are the tests' subject).
 */
const GUARD_ACTIONS = [
  "demand.pools.create",
  "demand.pools.close",
  "demand.commitments.create",
  "demand.commitments.withdraw",
  "demand.aggregates.evaluate",
  "demand.commitments.read",
];

export async function createNetW024Harness(
  opts: NetW008HarnessOptions = {},
): Promise<NetW024Harness> {
  const w008 = await createNetW008Harness(opts);
  const runtime = w008.runtime;
  const bootstrapCtx = w008.bootstrapCtx;

  // ACTIVE memberships (the server-side demand authorization input —
  // /organizations stays the membership authority):
  //  - the consumer (pool creator + commitment owner);
  //  - the supplier-side requestor (also a second consumer).
  await runtime.membershipService.grantMembership(bootstrapCtx, {
    personId: w008.personId,
    organizationId: w008.organizationScopeId,
    grantedBy: "bootstrap",
  });
  await runtime.membershipService.grantMembership(bootstrapCtx, {
    personId: w008.secondPersonId,
    organizationId: w008.organizationScopeId,
    grantedBy: "bootstrap",
  });

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
    w008,
    runtime,
    bootstrapCtx,
    organizationScopeId: w008.organizationScopeId,
    consumerPersonId: w008.personId,
    consumerSubjectId: w008.subjectId,
    supplierPersonId: w008.secondPersonId,
    supplierSubjectId: w008.secondSubjectId,
    async teardown() {
      await runtime.shutdown();
    },
  };
}

/** The consumer's execution context. */
export function consumerCtx(
  harness: NetW024Harness,
  correlationId: string,
): ExecutionContext {
  return createExecutionContext({
    correlationId,
    actor: { id: harness.consumerPersonId, kind: "person" },
  });
}

/** The supplier-side member's execution context. */
export function supplierCtx(
  harness: NetW024Harness,
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
 * Create an additional person (identity + subject reference) in the
 * harness runtime; optionally grant ACTIVE membership in the harness
 * organization (default: NOT a member — the non-member scenarios).
 */
export async function createPerson(
  harness: NetW024Harness,
  opts: {
    readonly displayName: string;
    readonly subjectId: string;
    readonly member?: boolean;
  },
): Promise<{ readonly personId: string; readonly subjectId: string }> {
  const person = await harness.runtime.identityService.createIdentity(
    harness.bootstrapCtx,
    {
      displayName: opts.displayName,
      subjectReferences: [
        { subjectId: opts.subjectId, providerKind: "internal" },
      ],
    },
  );
  if (opts.member) {
    await harness.runtime.membershipService.grantMembership(
      harness.bootstrapCtx,
      {
        personId: person.id,
        organizationId: harness.organizationScopeId,
        grantedBy: "bootstrap",
      },
    );
  }
  return { personId: person.id, subjectId: opts.subjectId };
}

// ---------------------------------------------------------------------------
// Record factories
// ---------------------------------------------------------------------------

/** Create a demand pool (the consumer by default; bounded defaults). */
export async function createPool(
  harness: NetW024Harness,
  opts: {
    readonly ctx?: ExecutionContext;
    readonly name?: string;
    readonly categoryKey?: string;
    readonly minimumCommitments?: number;
  } = {},
): Promise<DemandPool> {
  const ctx = opts.ctx ?? consumerCtx(harness, "w024-pool");
  const result = await harness.runtime.demandService.createDemandPool(ctx, {
    organizationScopeId: harness.organizationScopeId,
    name: opts.name ?? "W024 Test Pool",
    categoryKey: opts.categoryKey ?? "utilities_energy",
    qualificationPolicy: {
      minimumCommitments: opts.minimumCommitments ?? 2,
    },
    idempotencyKey: key("w024-pool"),
  });
  return result.pool;
}

/** Record one consumer demand commitment (defaults: consumer, NA_EAST, 12). */
export async function createCommitment(
  harness: NetW024Harness,
  opts: {
    readonly poolId: string;
    readonly ctx?: ExecutionContext;
    readonly region?: DemandRegionCode;
    readonly quantity?: number;
    readonly budgetBand?: string | null;
  },
): Promise<DemandCommitment> {
  const ctx = opts.ctx ?? consumerCtx(harness, "w024-commitment");
  const result = await harness.runtime.demandService.createDemandCommitment(
    ctx,
    {
      organizationScopeId: harness.organizationScopeId,
      poolId: opts.poolId,
      attributes: {
        region: opts.region ?? "NA_EAST",
        quantity: opts.quantity ?? 12,
        ...(opts.budgetBand !== undefined
          ? { budgetBand: opts.budgetBand }
          : {}),
      },
      consent: { scope: "aggregate_disclosure" },
      idempotencyKey: key("w024-commitment"),
    },
  );
  return result.commitment;
}
