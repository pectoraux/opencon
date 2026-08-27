/**
 * NET-W013 shared test harness.
 *
 * Wraps the NET-W012 harness (runtime + persons + organizations + the
 * helpful-contribution factories incl. the PoH/publish/evaluate
 * sequences) and adds:
 *  - the quality/moderation guard actions (6 mutations);
 *  - the quality-policy factory (a complete deterministic shape);
 *  - the QUALIFIED-contribution factory (an evidence-backed, published
 *    and evaluated helpful contribution — the quality engine's
 *    canonical input fixture);
 *  - the quality-evaluation factory (preview + record);
 *  - the moderation-decision composite helper (exactly as the runtime
 *    apiCommand executes it, incl. the spam/abuse risk-signal
 *    emission into /disputes).
 *
 * The harness uses the file-backed PostgresAuthorityShim (test/dev
 * double from NET-W003) so it runs without a real PostgreSQL.
 */

import {
  createNetW012Harness,
  createHelpfulnessPolicy,
  createHelpfulContribution,
  attachEvidenceBasis,
  publishHelpfulContribution,
  personCtx as w012PersonCtx,
  contributorCtx as w012ContributorCtx,
  key as w012Key,
  type NetW008HarnessOptions,
  type NetW012Harness,
} from "./_net-w012-harness.ts";
import { createExecutionContext } from "../../src/core/execution-context.ts";
import type { ExecutionContext } from "../../src/core/execution-context.ts";
import type {
  ModerationDecisionRecord,
  QualityEvaluation,
  QualityPolicy,
} from "../../src/contributions/port.ts";
import type { QualityPolicyShape } from "../../src/core/moderation.ts";
import type { Contribution } from "../../src/contributions/port.ts";

export interface NetW013Harness {
  /** The wrapped NET-W012 harness (all its factories work unchanged). */
  readonly w012: NetW012Harness;
  readonly runtime: NetW012Harness["runtime"];
  readonly bootstrapCtx: ExecutionContext;
  /** The contributor (the harness person; also the campaign owner). */
  readonly contributorPersonId: string;
  /** A different person in the same org (the moderator in tests). */
  readonly moderatorPersonId: string;
  readonly organizationScopeId: string;
  readonly secondOrgId: string;
  readonly secondOrgPersonId: string;
  teardown(): Promise<void>;
}

const GUARD_ACTIONS = [
  "quality.policy",
  "quality.advisory.attach",
  "quality.advisory.generate",
  "quality.evaluation.preview",
  "quality.evaluation.record",
  "moderation.decide",
];

export async function createNetW013Harness(
  opts: NetW008HarnessOptions = {},
): Promise<NetW013Harness> {
  const w012 = await createNetW012Harness(opts);
  const runtime = w012.runtime;
  const bootstrapCtx = w012.bootstrapCtx;

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
    w012,
    runtime,
    bootstrapCtx,
    contributorPersonId: w012.contributorPersonId,
    moderatorPersonId: w012.otherPersonId,
    organizationScopeId: w012.organizationScopeId,
    secondOrgId: w012.secondOrgId,
    secondOrgPersonId: w012.secondOrgPersonId,
    async teardown() {
      await runtime.shutdown();
    },
  };
}

/** An execution context for a specific person. */
export function personCtx(
  harness: NetW013Harness,
  personId: string,
  correlationId: string,
): ExecutionContext {
  return createExecutionContext({
    correlationId,
    actor: { id: personId, kind: "person" },
  });
}

/** The contributor's context. */
export function contributorCtx(
  harness: NetW013Harness,
  correlationId: string,
): ExecutionContext {
  return personCtx(harness, harness.contributorPersonId, correlationId);
}

/** The moderator's context (a different person in the same org). */
export function moderatorCtx(
  harness: NetW013Harness,
  correlationId: string,
): ExecutionContext {
  return personCtx(harness, harness.moderatorPersonId, correlationId);
}

/** Fresh idempotency keys (unique per call). */
export function key(prefix: string): string {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

/** Deterministic evaluation anchors. */
export const EVALUATED_AT = "2026-01-02T03:04:05.000Z";
export const EVALUATED_AT_LATER = "2026-02-03T04:05:06.000Z";

// ---------------------------------------------------------------------------
// Quality policy factory
// ---------------------------------------------------------------------------

export interface QualityShapeOptions {
  readonly advisoryWeightFactor?: number;
  readonly highQualityAt?: number;
  readonly adequateAt?: number;
  readonly lowQualityAt?: number;
  readonly advisoryOnlyCapBand?: string;
  readonly requiredInputs?: readonly string[];
  readonly missingInputFloorBand?: string;
  /** NET-W014: explicit input rules (default: PoH + evidence + outcome). */
  readonly inputs?: readonly {
    readonly kind: string;
    readonly weight: number;
    readonly minimumCount: number;
  }[];
}

/**
 * A complete, valid deterministic quality shape: PoH + evidence +
 * measured-outcome inputs (weights 0.5/0.3/0.2, minimum 1 each),
 * model/heuristic advisory at factor 0.2, ATTESTED minimum grade,
 * platform/attested sources, helpfulness outcomes, confidence 0.7,
 * thresholds 0.8/0.5/0.2, advisory-only cap ADEQUATE, PoH required
 * with a LOW_QUALITY missing-input floor.
 */
export function defaultQualityShape(
  opts: QualityShapeOptions = {},
): QualityPolicyShape {
  return {
    inputs: (opts.inputs ?? [
      { kind: "proof_of_helpfulness", weight: 0.5, minimumCount: 1 },
      { kind: "evidence_record", weight: 0.3, minimumCount: 1 },
      { kind: "measured_outcome", weight: 0.2, minimumCount: 1 },
    ]) as QualityPolicyShape["inputs"],
    advisory: {
      allowedKinds: ["model_score", "heuristic_score"],
      advisoryWeightFactor: opts.advisoryWeightFactor ?? 0.2,
    },
    minimumGrade: "ATTESTED",
    qualifyingSourceTypes: ["platform", "attested"],
    qualifyingOutcomeTypes: ["helpfulness"],
    minimumConfidence: 0.7,
    thresholds: {
      highQualityAt: opts.highQualityAt ?? 0.8,
      adequateAt: opts.adequateAt ?? 0.5,
      lowQualityAt: opts.lowQualityAt ?? 0.2,
    },
    structural: {
      advisoryOnlyCapBand: (opts.advisoryOnlyCapBand ??
        "ADEQUATE") as QualityPolicyShape["structural"]["advisoryOnlyCapBand"],
      requiredInputs: (opts.requiredInputs ?? [
        "proof_of_helpfulness",
      ]) as QualityPolicyShape["structural"]["requiredInputs"],
      missingInputFloorBand: (opts.missingInputFloorBand ??
        "LOW_QUALITY") as QualityPolicyShape["structural"]["missingInputFloorBand"],
    },
    description: "deterministic quality criteria (test policy)",
  };
}

export interface CreateQualityPolicyOptions extends QualityShapeOptions {
  readonly policyId?: string;
  readonly organizationScopeId?: string;
  readonly idempotencyKey?: string;
}

/** Define quality policy version 1 (or the next version). */
export async function createQualityPolicy(
  harness: NetW013Harness,
  opts: CreateQualityPolicyOptions = {},
): Promise<QualityPolicy> {
  const ctx = personCtx(
    harness,
    harness.moderatorPersonId,
    "w013-quality-policy",
  );
  const result = await harness.runtime.qualityService.defineQualityPolicy(
    ctx,
    {
      organizationScopeId:
        opts.organizationScopeId ?? harness.organizationScopeId,
      policyId: opts.policyId ?? key("w013-quality-policy"),
      shape: defaultQualityShape(opts),
      idempotencyKey: opts.idempotencyKey ?? key("w013-quality-policy"),
    },
  );
  return result.policy;
}

// ---------------------------------------------------------------------------
// Qualified-contribution factory (the quality engine's canonical input)
// ---------------------------------------------------------------------------

export interface CreateQualifiedContributionOptions {
  readonly mentions?: readonly {
    readonly productRef: string;
    readonly disclosed: boolean;
    readonly commercialRelationshipRef: string | null;
  }[];
}

/**
 * An evidence-backed, PUBLISHED and EVALUATED helpful contribution
 * whose Proof-of-Helpfulness is QUALIFIED (the W012 chain: policy →
 * contribution → ATTESTED evidence basis → publish → evaluate).
 */
export async function createQualifiedContribution(
  harness: NetW013Harness,
  opts: CreateQualifiedContributionOptions = {},
): Promise<{
  contribution: Contribution;
  qualityPolicy: QualityPolicy;
}> {
  const helpfulnessPolicy = await createHelpfulnessPolicy(harness.w012);
  const { contribution } = await createHelpfulContribution(harness.w012, {
    helpfulnessPolicyId: helpfulnessPolicy.policyId,
    ...(opts.mentions !== undefined
      ? { mentions: opts.mentions }
      : {}),
  });
  await attachEvidenceBasis(harness.w012, contribution.id);
  await publishHelpfulContribution(harness.w012, contribution.id);
  const poh = await harness.runtime.helpfulnessService.evaluateHelpfulness(
    contributorCtx(harness, "w013-qualified-poh"),
    { contributionId: contribution.id, idempotencyKey: key("w013-poh-eval") },
  );
  if (poh.state !== "QUALIFIED") {
    throw new Error(
      `W013 harness fixture failed: PoH state ${poh.state} (reasons: ${poh.evaluations[poh.evaluations.length - 1]?.reasons.join("; ")})`,
    );
  }
  const qualityPolicy = await createQualityPolicy(harness);
  return { contribution, qualityPolicy };
}

// ---------------------------------------------------------------------------
// Quality evaluation factory
// ---------------------------------------------------------------------------

export async function recordQualityEvaluation(
  harness: NetW013Harness,
  contributionId: string,
  qualityPolicyId: string,
  opts: { readonly evaluatedAt?: string; readonly idempotencyKey?: string } = {},
): Promise<QualityEvaluation> {
  const result = await harness.runtime.qualityService.recordQualityEvaluation(
    moderatorCtx(harness, "w013-quality-eval"),
    {
      contributionId,
      organizationScopeId: harness.organizationScopeId,
      qualityPolicyId,
      evaluatedAt: opts.evaluatedAt ?? EVALUATED_AT,
      idempotencyKey: opts.idempotencyKey ?? key("w013-quality-eval"),
    },
  );
  return result.evaluation;
}

// ---------------------------------------------------------------------------
// Moderation composite helper (exactly as the apiCommand executes it)
// ---------------------------------------------------------------------------

export interface RecordDecisionOptions {
  readonly decision?: string;
  readonly reasonKinds?: readonly string[];
  readonly notes?: string | null;
  readonly qualityEvaluationIds?: readonly string[];
  readonly signalSeverity?: string;
  readonly signalConfidence?: number;
  readonly idempotencyKey?: string;
  readonly actorPersonId?: string;
}

/** Record a moderation decision through the COMPOSITION-ROOT composite. */
export async function recordModerationDecision(
  harness: NetW013Harness,
  contributionId: string,
  opts: RecordDecisionOptions = {},
): Promise<{
  decision: ModerationDecisionRecord;
  riskSignal: Record<string, unknown> | null;
  signalCreated: boolean;
}> {
  const ctx = personCtx(
    harness,
    opts.actorPersonId ?? harness.moderatorPersonId,
    "w013-moderation",
  );
  const result = await harness.runtime.apiCommands.recordModerationDecision(
    ctx,
    opts.actorPersonId ?? harness.moderatorPersonId,
    {
      contributionId,
      decision: opts.decision ?? "REJECT",
      reasonKinds: opts.reasonKinds ?? ["spam"],
      ...(opts.notes !== undefined ? { notes: opts.notes } : {}),
      ...(opts.qualityEvaluationIds !== undefined
        ? { qualityEvaluationIds: opts.qualityEvaluationIds }
        : {}),
      ...(opts.signalSeverity !== undefined
        ? { signalSeverity: opts.signalSeverity }
        : {}),
      ...(opts.signalConfidence !== undefined
        ? { signalConfidence: opts.signalConfidence }
        : {}),
      idempotencyKey: opts.idempotencyKey ?? key("w013-moderation"),
    },
  );
  return {
    decision: result.decision as unknown as ModerationDecisionRecord,
    riskSignal: result.riskSignal,
    signalCreated: result.signalCreated,
  };
}

export { w012PersonCtx, w012ContributorCtx, w012Key };

/** A system-actor context (the protocol — can NEVER moderate). */
export function systemCtx(correlationId: string): ExecutionContext {
  return createExecutionContext({
    correlationId,
    actor: { id: "system-worker", kind: "system" },
  });
}
