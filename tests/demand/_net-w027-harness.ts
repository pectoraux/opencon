/**
 * NET-W027 shared test harness — Verified savings and counterfactuals.
 *
 * Wraps the NET-W026 harness (which wraps the W025 → W024 → W008
 * chain: runtime + persons + organizations + the demand/procurement
 * guard-action policies; the file-backed PostgresAuthorityShim so no
 * real PostgreSQL is needed). This harness seeds the six NET-W027
 * guard actions and exposes the savings-scenario factories over the
 * REAL /evidence and /outcomes authority services (the neutral
 * composition-root lookups resolve through the real repositories —
 * evidence records are subject-bound to the procurement pool; savings
 * observations are outcome type "savings" on the same subject).
 */

import { randomUUID } from "node:crypto";
import {
  createNetW026Harness,
  seedQualifiedPool,
  type NetW026Harness,
} from "./_net-w026-harness.ts";
import { personCtx } from "./_net-w026-harness.ts";
import { createExecutionContext } from "../../src/core/execution-context.ts";
import type { ExecutionContext } from "../../src/core/execution-context.ts";
import type { NetW008HarnessOptions } from "../settlement/_net-w008-harness.ts";
import type { Runtime } from "../../src/bootstrap/runtime.ts";
import type {
  ProcurementBaseline,
  ProcurementSavings,
  ProcurementSavingsView,
} from "../../src/demand/port.ts";
import type { Evidence } from "../../src/evidence/port.ts";
import type { OutcomeObservation } from "../../src/outcomes/port.ts";

export interface NetW027Harness {
  readonly w026: NetW026Harness;
  readonly runtime: Runtime;
  readonly bootstrapCtx: ExecutionContext;
  readonly organizationScopeId: string;
  /** The pool creator's execution context (buyer A). */
  poolCreatorCtx(correlationId: string): ExecutionContext;
  teardown(): Promise<void>;
}

/**
 * The NET-W027 API guard actions seeded by this harness (subject "*",
 * resource "*" — the guard is the transport authorization; the
 * domain-layer pool-creator/membership gates are the tests' subject).
 */
const GUARD_ACTIONS = [
  "demand.procurement.baselines.create",
  "demand.procurement.baselines.invalidate",
  "demand.procurement.baselines.read",
  "demand.procurement.savings.evaluate",
  "demand.procurement.savings.record",
  "demand.procurement.savings.read",
];

export async function createNetW027Harness(
  opts: NetW008HarnessOptions = {},
): Promise<NetW027Harness> {
  const w026 = await createNetW026Harness(opts);
  const runtime = w026.runtime;
  const bootstrapCtx = w026.bootstrapCtx;

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
    w026,
    runtime,
    bootstrapCtx,
    organizationScopeId: w026.organizationScopeId,
    poolCreatorCtx(correlationId: string) {
      return createExecutionContext({
        correlationId,
        actor: { id: w026.w025.buyerAPersonId, kind: "person" },
      });
    },
    async teardown() {
      await runtime.shutdown();
    },
  };
}

/** The pool creator's execution context (buyer A — the W027 surface owner). */
export function poolCreatorCtx(
  harness: NetW027Harness,
  correlationId: string,
): ExecutionContext {
  return harness.poolCreatorCtx(correlationId);
}

/** Fresh idempotency keys (unique per call). */
export function key(prefix: string): string {
  return `${prefix}-${randomUUID()}`;
}

export { personCtx };

// ---------------------------------------------------------------------------
// Record factories (over the REAL /evidence and /outcomes services)
// ---------------------------------------------------------------------------

/**
 * Create one subject-bound /evidence record for a pool (defaults:
 * platform source, historical-spend-report method). The savings
 * boundary's neutral evidence lookup resolves exactly these records.
 */
export async function createPoolEvidence(
  harness: NetW027Harness,
  opts: {
    readonly poolId: string;
    readonly ctx?: ExecutionContext;
    readonly sourceType?: string;
    readonly organizationScopeId?: string;
  },
): Promise<Evidence> {
  const ctx = opts.ctx ?? poolCreatorCtx(harness, "w027-evidence");
  return harness.runtime.evidenceService.createEvidence(ctx, {
    organizationScopeId:
      opts.organizationScopeId ?? harness.organizationScopeId,
    ownerId: (ctx.actor as { readonly id: string }).id,
    subjectReference: {
      subjectId: opts.poolId,
      subjectType: "procurement_pool",
    },
    provenance: {
      sourceType: (opts.sourceType ?? "platform") as "platform",
      method: "historical-spend-report",
      collectorId: (ctx.actor as { readonly id: string }).id,
    },
    confidence: { point: 0.9, method: "platform-counter" },
    sensitivity: "standard",
    payload: { kind: "spend_report", note: "W027 harness evidence" },
  });
}

/**
 * Create one savings outcome observation for a pool (defaults: 800
 * usd, platform source, chain-head root observation) through the REAL
 * /outcomes authority service. The savings boundary's neutral
 * outcome lookup resolves exactly these records.
 */
export async function createSavingsObservation(
  harness: NetW027Harness,
  opts: {
    readonly poolId: string;
    readonly ctx?: ExecutionContext;
    readonly value?: number;
    readonly unit?: string;
    readonly confidence?: { readonly point: number; readonly lower?: number; readonly upper?: number };
    readonly sourceType?: string;
    readonly collectedAt?: string;
    readonly organizationScopeId?: string;
  },
): Promise<OutcomeObservation> {
  const ctx = opts.ctx ?? poolCreatorCtx(harness, "w027-observation");
  return harness.runtime.outcomeObservationService.createOutcomeObservation(
    ctx,
    {
      organizationScopeId:
        opts.organizationScopeId ?? harness.organizationScopeId,
      observerId: (ctx.actor as { readonly id: string }).id,
      subjectReference: {
        subjectId: opts.poolId,
        subjectType: "procurement_pool",
      },
      outcomeType: "savings",
      observedValue: {
        value: opts.value ?? 800,
        unit: opts.unit ?? "usd",
      },
      confidence:
        opts.confidence ?? { point: 0.95, method: "platform-counter" },
      provenance: {
        sourceType: (opts.sourceType ?? "platform") as "platform",
        method: "procurement-fulfillment-ledger",
        methodVersion: "1",
        ...(opts.collectedAt !== undefined
          ? { collectedAt: opts.collectedAt }
          : {}),
      },
    },
  );
}

/** ISO timestamp N days before `now` (the historical-window helper). */
export function daysAgoIso(days: number): string {
  return new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
}

/**
 * Create one explicit baseline for a pool (defaults: counterfactual
 * kind with a quantified interval, prior_period method v1, a 30-day
 * historical comparison window ending 1 day ago, 1000 usd, platform
 * provenance, over the given evidence references).
 */
export async function createBaseline(
  harness: NetW027Harness,
  opts: {
    readonly poolId: string;
    readonly evidenceIds: readonly string[];
    readonly ctx?: ExecutionContext;
    readonly baselineKind?: string;
    readonly method?: string;
    readonly methodVersion?: string;
    readonly windowEndsDaysAgo?: number;
    readonly windowDays?: number;
    readonly population?: string;
    readonly baselineValue?: { readonly value: number; readonly unit: string };
    readonly confidence?: {
      readonly point: number;
      readonly lower?: number;
      readonly upper?: number;
    };
    readonly provenanceSourceType?: string;
    readonly provenanceCollectedAt?: string;
    readonly idempotencyKey?: string;
  },
): Promise<ProcurementBaseline> {
  const ctx = opts.ctx ?? poolCreatorCtx(harness, "w027-baseline");
  const windowDays = opts.windowDays ?? 30;
  const endsAt = daysAgoIso(opts.windowEndsDaysAgo ?? 1);
  const startsAt = daysAgoIso((opts.windowEndsDaysAgo ?? 1) + windowDays);
  const kind = opts.baselineKind ?? "counterfactual";
  const result =
    await harness.runtime.procurementSavingsService.createProcurementBaseline(
      ctx,
      {
        organizationScopeId: harness.organizationScopeId,
        poolId: opts.poolId,
        baselineKind: kind,
        method: opts.method ?? "prior_period",
        methodVersion: opts.methodVersion ?? "1",
        comparisonWindow: { startsAt, endsAt },
        population:
          opts.population ??
          "Historical spend for the pool category over the comparison window",
        baselineValue: opts.baselineValue ?? { value: 1000, unit: "usd" },
        confidence:
          opts.confidence ??
          (kind === "counterfactual"
            ? { point: 0.9, lower: 0.8, upper: 0.95 }
            : { point: 0.9 }),
        provenance: {
          sourceType: (opts.provenanceSourceType ?? "platform") as "platform",
          collectedAt:
            opts.provenanceCollectedAt ?? new Date().toISOString(),
        },
        evidenceIds: [...opts.evidenceIds],
        idempotencyKey: opts.idempotencyKey ?? key("w027-baseline"),
      },
    );
  return result.baseline;
}

/**
 * The full supported savings scenario (defaults): a qualified pool
 * (the W026 three-organization seed), one platform evidence record,
 * one counterfactual baseline (1000 usd, interval [0.8, 0.95]) and
 * one platform savings observation (800 usd, point 0.95) — derivation:
 * supported, savings 200 usd, conservative confidence point 0.9 with
 * the interval [0.8, 0.95].
 */
export async function seedSavingsScenario(
  harness: NetW027Harness,
  opts: {
    readonly name?: string;
    readonly baselineKind?: string;
    readonly observationConfidence?: {
      readonly point: number;
      readonly lower?: number;
      readonly upper?: number;
    };
    readonly observationValue?: number;
    readonly evidenceSourceType?: string;
    readonly observationSourceType?: string;
  } = {},
): Promise<{
  readonly poolId: string;
  readonly evidence: Evidence;
  readonly baseline: ProcurementBaseline;
  readonly observation: OutcomeObservation;
}> {
  const pool = await seedQualifiedPool(harness.w026, {
    name: opts.name ?? "W027 Savings Pool",
  });
  const evidence = await createPoolEvidence(harness, {
    poolId: pool.id,
    ...(opts.evidenceSourceType !== undefined
      ? { sourceType: opts.evidenceSourceType }
      : {}),
  });
  const baseline = await createBaseline(harness, {
    poolId: pool.id,
    evidenceIds: [evidence.id],
    ...(opts.baselineKind !== undefined
      ? { baselineKind: opts.baselineKind }
      : {}),
  });
  const observation = await createSavingsObservation(harness, {
    poolId: pool.id,
    ...(opts.observationConfidence !== undefined
      ? { confidence: opts.observationConfidence }
      : {}),
    ...(opts.observationValue !== undefined
      ? { value: opts.observationValue }
      : {}),
    ...(opts.observationSourceType !== undefined
      ? { sourceType: opts.observationSourceType }
      : {}),
  });
  return { poolId: pool.id, evidence, baseline, observation };
}

/** Evaluate the derived savings view (pool creator by default). */
export async function evaluateSavings(
  harness: NetW027Harness,
  opts: {
    readonly poolId: string;
    readonly baselineId: string;
    readonly outcomeObservationIds: readonly string[];
    readonly ctx?: ExecutionContext;
    readonly selectionId?: string;
  },
): Promise<ProcurementSavingsView> {
  const ctx = opts.ctx ?? poolCreatorCtx(harness, "w027-evaluate");
  return harness.runtime.procurementSavingsService
    .evaluateProcurementSavings(ctx, {
      organizationScopeId: harness.organizationScopeId,
      poolId: opts.poolId,
      baselineId: opts.baselineId,
      outcomeObservationIds: [...opts.outcomeObservationIds],
      ...(opts.selectionId !== undefined
        ? { selectionId: opts.selectionId }
        : {}),
    });
}

/** Record the authoritative savings lineage (pool creator by default). */
export async function recordSavings(
  harness: NetW027Harness,
  opts: {
    readonly poolId: string;
    readonly baselineId: string;
    readonly outcomeObservationIds: readonly string[];
    readonly ctx?: ExecutionContext;
    readonly selectionId?: string;
    readonly idempotencyKey?: string;
  },
): Promise<ProcurementSavings> {
  const ctx = opts.ctx ?? poolCreatorCtx(harness, "w027-record");
  const result = await harness.runtime.procurementSavingsService
    .recordProcurementSavings(ctx, {
      organizationScopeId: harness.organizationScopeId,
      poolId: opts.poolId,
      baselineId: opts.baselineId,
      outcomeObservationIds: [...opts.outcomeObservationIds],
      ...(opts.selectionId !== undefined
        ? { selectionId: opts.selectionId }
        : {}),
      idempotencyKey: opts.idempotencyKey ?? key("w027-savings"),
    });
  return result.savings;
}
