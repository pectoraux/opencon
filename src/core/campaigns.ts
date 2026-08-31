/**
 * Shared campaign vocabulary (core contracts).
 *
 * Architecture ref: spec/architecture.md §7 (Farmable contribution
 * market — campaigns generalize the Farmable model into the protocol),
 * §18 (module ownership: `/campaigns` owns campaign domain rules —
 * campaign policy/configuration ONLY); spec/architecture-lock.md §2
 * (the sixteen frozen core domains — `/campaigns` is the Phase-4
 * Campaign boundary), §5 (economic authority: every economic
 * commitment and clearing goes through `/settlement` — campaigns
 * declare policy, they never move value), §7 (`/workflows` is the
 * sole lifecycle authority for opportunities/contributions).
 *
 * Work order ref: spec/work-orders/NET-W011.md
 *   §3.1 Campaign records + the administrative status machine.
 *   §3.2 Versioned campaign policy (objectives, eligibility,
 *        outcome/evidence policy, budget, attribution rules,
 *        clearing rules, opportunity specs).
 *   §3.3 Budget commitments through the settlement authority.
 *   §3.4 Campaign-to-opportunity composition through /workflows.
 * Requirements: CAMP-001 (objective kinds), CAMP-002 (policy defined
 * before activation), CAMP-003 (ad-ecosystem interop — neutral
 * vocabularies only), CAMP-004 (non-reciprocal cross-promotion),
 * CAMP-005 (multilateral clearing rules).
 *
 * THE KEY RULES (work order §4 — authority separation):
 *  - `/campaigns` owns campaign POLICY/CONFIGURATION only: objectives,
 *    eligibility, outcome/evidence policy, budget declarations,
 *    attribution rules and clearing rules are declared here;
 *  - `/workflows` remains the lifecycle authority: campaigns compose
 *    contribution opportunities THROUGH the opportunity/workflow
 *    services at the composition root — campaign code never mutates a
 *    lifecycle state;
 *  - `/settlement` remains the economic authority: budget commitments
 *    and every clearing consequence execute ONLY through settlement
 *    commands (the campaign domain carries NO economic-unit mutation
 *    methods and NO balances — the budget block on a campaign record
 *    is bookkeeping REFERENCES to settlement records, the exact
 *    NET-W010 stake-block precedent);
 *  - `/evidence` remains the truth authority and `/outcomes` the
 *    measurement authority: campaign policies REFERENCE the frozen
 *    evidence grades/source types and outcome/attribution
 *    vocabularies — they never redefine them;
 *  - provider-specific semantics stay OUTSIDE the campaign domain
 *    (AC-06): every vocabulary here is closed and provider-neutral.
 *
 * This module is data + pure validation ONLY — no I/O, no wall clock
 * reads inside pure helpers, no lifecycle behaviour (the status
 * machine validation lives in the campaign service).
 */

import { OpenConError } from "./errors.ts";
import {
  ECONOMIC_DECIMALS,
  ECONOMIC_MAX_AMOUNT,
  ECONOMIC_SCALE,
} from "./economics.ts";
import { isEvidenceGrade, isEvidenceSourceType } from "./evidence.ts";
import { isAttributionMode } from "./measurement.ts";
import { isStandardOutcomeType } from "./evidence.ts";

/**
 * The campaign administrative status machine (work order §3.1). This
 * is the CAMPAIGN RECORD's own administrative lifecycle (a policy/
 * configuration lifecycle owned by /campaigns — the dispute-record
 * precedent); it is deliberately NOT a `LifecycleSubjectKind`:
 * contribution OPPORTUNITIES remain the workflow-lifecycle subjects,
 * owned exclusively by `/workflows`.
 *
 * ```text
 * DRAFT ──activate──→ ACTIVE ⇄ pause/resume ⇄ PAUSED
 *   │                    │ │
 *   │                    └──┼── complete ──→ COMPLETED (terminal)
 *   └── cancel ──────────┴── cancel ──→ CANCELLED (terminal)
 * ```
 *
 *  - `DRAFT` — the campaign exists; policy versions may be defined;
 *    nothing can be published.
 *  - `ACTIVE` — the activation gate passed (a complete policy version
 *    is pinned and the declared budget, if any, is committed through
 *    the settlement authority); opportunity publication is allowed.
 *  - `PAUSED` — temporarily not publishable; can be resumed.
 *  - `COMPLETED` / `CANCELLED` — terminal; no further mutations
 *    except recording the budget release.
 */
export const CAMPAIGN_STATUSES = [
  "DRAFT",
  "ACTIVE",
  "PAUSED",
  "COMPLETED",
  "CANCELLED",
] as const;

export type CampaignStatus = (typeof CAMPAIGN_STATUSES)[number];

export function isCampaignStatus(value: string): value is CampaignStatus {
  return (CAMPAIGN_STATUSES as readonly string[]).includes(value);
}

/** The terminal administrative statuses (no forward transitions). */
export const CAMPAIGN_TERMINAL_STATUSES: readonly CampaignStatus[] = [
  "COMPLETED",
  "CANCELLED",
];

export function isTerminalCampaignStatus(value: string): boolean {
  return (CAMPAIGN_TERMINAL_STATUSES as readonly string[]).includes(value);
}

/** The statuses in which contribution opportunities may be published. */
export const CAMPAIGN_PUBLISHABLE_STATUSES: readonly CampaignStatus[] = [
  "ACTIVE",
];

/**
 * The campaign objective kinds (requirement CAMP-001): the closed,
 * provider-neutral vocabulary a campaign objective may declare. The
 * Farmable-derived model generalized into the protocol — awareness,
 * attention, engagement, intent, conversion, incremental conversion,
 * creator content, (non-reciprocal) cross-promotion and referral.
 */
export const CAMPAIGN_OBJECTIVE_KINDS = [
  "awareness",
  "attention",
  "engagement",
  "intent",
  "conversion",
  "incremental_conversion",
  "creator_content",
  "cross_promotion",
  "referral",
] as const;

export type CampaignObjectiveKind = (typeof CAMPAIGN_OBJECTIVE_KINDS)[number];

export function isCampaignObjectiveKind(
  value: string,
): value is CampaignObjectiveKind {
  return (CAMPAIGN_OBJECTIVE_KINDS as readonly string[]).includes(value);
}

/**
 * The closed eligibility-rule attribute vocabulary (AC-06:
 * provider-neutral). Eligibility rules reference NEUTRAL participant/
 * contribution/evidence/measurement attributes; provider-specific
 * targeting semantics (platform accounts, proprietary segments,
 * publisher inventories) are out of scope for the campaign domain.
 */
export const CAMPAIGN_ELIGIBILITY_ATTRIBUTES = [
  "participant_class",
  "region",
  "language",
  "contribution_type",
  "evidence_grade",
  "measurement_kind",
] as const;

export type CampaignEligibilityAttribute =
  (typeof CAMPAIGN_ELIGIBILITY_ATTRIBUTES)[number];

export function isCampaignEligibilityAttribute(
  value: string,
): value is CampaignEligibilityAttribute {
  return (CAMPAIGN_ELIGIBILITY_ATTRIBUTES as readonly string[]).includes(value);
}

/** The closed eligibility-rule operator vocabulary. */
export const CAMPAIGN_ELIGIBILITY_OPERATORS = [
  "equals",
  "not_equals",
  "in",
  "not_in",
  "gte",
  "lte",
] as const;

export type CampaignEligibilityOperator =
  (typeof CAMPAIGN_ELIGIBILITY_OPERATORS)[number];

export function isCampaignEligibilityOperator(
  value: string,
): value is CampaignEligibilityOperator {
  return (
    (CAMPAIGN_ELIGIBILITY_OPERATORS as readonly string[]).includes(value)
  );
}

/**
 * The kinds of authoritative records an evidence requirement may
 * demand (work order §3.2): each REFERENCES an existing authority —
 * `proof_of_value` (the /evidence Proof-of-Value object), 
 * `measured_outcome` (the /outcomes measured record) or
 * `evidence_record` (a raw /evidence record). The campaign domain
 * never re-implements their semantics.
 */
export const CAMPAIGN_EVIDENCE_REQUIREMENT_KINDS = [
  "proof_of_value",
  "measured_outcome",
  "evidence_record",
] as const;

export type CampaignEvidenceRequirementKind =
  (typeof CAMPAIGN_EVIDENCE_REQUIREMENT_KINDS)[number];

export function isCampaignEvidenceRequirementKind(
  value: string,
): value is CampaignEvidenceRequirementKind {
  return (
    (CAMPAIGN_EVIDENCE_REQUIREMENT_KINDS as readonly string[]).includes(value)
  );
}

/**
 * The bases a clearing rule may draw against (CAMP-005): attributed
 * normalized outcomes, verified evidence, or measured value — all
 * REFERENCES to authoritative records produced downstream; clearing
 * EXECUTION is NET-W014 (explicit non-goal here).
 */
export const CAMPAIGN_CLEARING_BASES = [
  "attributed_outcome",
  "verified_evidence",
  "measured_value",
] as const;

export type CampaignClearingBasis = (typeof CAMPAIGN_CLEARING_BASES)[number];

export function isCampaignClearingBasis(
  value: string,
): value is CampaignClearingBasis {
  return (CAMPAIGN_CLEARING_BASES as readonly string[]).includes(value);
}

/**
 * The settlement primitives a clearing rule may draw through (CAMP-005
 * multilateral clearing). These are REFERENCES to the canonical
 * `/settlement` commands (`reward_allocation`, `credit_issuance`,
 * `cash_obligation`) — the campaign domain itself never executes
 * them (NET-W014 will, consuming these declared rules).
 */
export const CAMPAIGN_CLEARING_DRAW_KINDS = [
  "reward_allocation",
  "credit_issuance",
  "cash_obligation",
] as const;

export type CampaignClearingDrawKind =
  (typeof CAMPAIGN_CLEARING_DRAW_KINDS)[number];

export function isCampaignClearingDrawKind(
  value: string,
): value is CampaignClearingDrawKind {
  return (CAMPAIGN_CLEARING_DRAW_KINDS as readonly string[]).includes(value);
}

/**
 * The kinds of commercial disclosures a campaign policy may require
 * (NET-W018 — CRE-006: "Represent required commercial disclosures";
 * DISC-001: "Explicitly represent commercial relationships"). The
 * vocabulary is CLOSED and provider-neutral:
 *
 *  - `material_connection`: the publication must disclose the material
 *    connection between creator and sponsor (the canonical #ad-style
 *    declaration).
 *  - `paid_partnership`: the publication must carry the platform-native
 *    paid-partnership label where the channel provides one.
 *  - `gifted_product`: the publication must disclose that the product
 *    was gifted/free.
 *  - `genuine_experience`: the publication must declare that any
 *    personal-experience claims are GENUINE (DISC-002: fabricated
 *    personal-experience claims are prevented — the declaration is the
 *    auditable creator attestation, evidence-bound and disputable).
 *  - `brand_affiliation`: the publication must disclose an ongoing
 *    brand affiliation (ambassador/employment).
 *
 * The campaign policy DECLARES which kinds are required; the creators
 * domain's disclosure gate DERIVES the applicable obligations (campaign
 * policy ∪ commercial-relationship obligations) and enforces them at
 * the publication boundary. Neither the campaign nor the creator
 * domain evaluates disclosure CONTENT — presence + evidence binding
 * are deterministic; semantics belong to /disputes when challenged.
 */
export const CAMPAIGN_DISCLOSURE_KINDS = [
  "material_connection",
  "paid_partnership",
  "gifted_product",
  "genuine_experience",
  "brand_affiliation",
] as const;

export type CampaignDisclosureKind =
  (typeof CAMPAIGN_DISCLOSURE_KINDS)[number];

export function isCampaignDisclosureKind(
  value: string,
): value is CampaignDisclosureKind {
  return (CAMPAIGN_DISCLOSURE_KINDS as readonly string[]).includes(value);
}

/**
 * Validate a list of disclosure kinds against the closed vocabulary
 * (deterministic: duplicates are rejected so the derived obligation
 * set is canonical). Returns a frozen copy.
 */
export function validateCampaignDisclosureKinds(
  field: string,
  kinds: readonly string[],
): readonly CampaignDisclosureKind[] {
  if (!Array.isArray(kinds)) {
    throw new InvalidCampaignPolicyError(
      `${field} must be an array of disclosure kinds`,
      { field },
    );
  }
  const seen = new Set<string>();
  for (const kind of kinds) {
    if (typeof kind !== "string" || !isCampaignDisclosureKind(kind)) {
      throw new InvalidCampaignPolicyError(
        `${field} contains an unknown disclosure kind (got ${String(kind)})`,
        { field, kind },
      );
    }
    if (seen.has(kind)) {
      throw new InvalidCampaignPolicyError(
        `${field} contains duplicate disclosure kind ${kind}`,
        { field, kind },
      );
    }
    seen.add(kind);
  }
  return Object.freeze([...kinds]) as readonly CampaignDisclosureKind[];
}

/**
 * The campaign's DECLARED disclosure policy (NET-W018 — one section of
 * the versioned campaign policy): which disclosure kinds every
 * publication under the campaign must satisfy. POLICY ONLY — the
 * campaign domain never evaluates declarations or blocks anything;
 * the creators domain's publication gate consumes this section
 * through the neutral composition-root lookup (the same
 * dependency-inversion as every other campaign-policy section).
 *
 * An EMPTY `requiredKinds` is a legitimate declared stance (a
 * non-commercial campaign); obligations may still arrive from the
 * commercial relationship's own declarations (the gate derives the
 * UNION — disclosure can only be ADDED, never removed, by the
 * relationship).
 */
export interface CampaignDisclosurePolicy {
  readonly requiredKinds: readonly CampaignDisclosureKind[];
}

/**
 * The recorded policy-format lineage. Every campaign policy version
 * carries it; determinism (CAMP-002) requires that the policy that
 * governed activation is reproducible from the stored version.
 *
 * NET-W018 note: the format lineage is UNCHANGED ("NET-W011:1") — the
 * disclosure-policy section is ADDITIVE with an empty default, so
 * pre-W018 policy versions remain format-compatible (they read as
 * "no disclosure requirements declared"; relationship obligations and
 * later policy versions can still declare them).
 */
export const CAMPAIGN_POLICY_FORMAT = "NET-W011:1" as const;

/**
 * The stake purpose kind campaign budget commitments use (additive to
 * the NET-W010 `dispute_challenge` purpose). The settlement authority
 * owns the escrow postings; the campaign domain only records the
 * references (the stake-block precedent).
 */
export const CAMPAIGN_BUDGET_STAKE_PURPOSE_KIND = "campaign_budget" as const;

// ---------------------------------------------------------------------------
// Pure validation helpers
// ---------------------------------------------------------------------------

export class InvalidCampaignPolicyError extends OpenConError {
  constructor(
    message: string,
    context?: Readonly<Record<string, unknown>>,
  ) {
    super({
      code: "CAMPAIGN_POLICY_VALIDATION",
      classification: "validation",
      message,
      context,
    });
  }
}

/**
 * Validate a campaign budget amount — NON-NEGATIVE (0 allowed: a
 * zero-budget campaign — e.g. a non-reciprocal cross-promotion,
 * CAMP-004 — declares no economic encumbrance), ≤ 6 decimals and ≤
 * the frozen economic maximum. Reuses the frozen arithmetic bounds
 * (ECONOMIC_SCALE/ECONOMIC_MAX_AMOUNT) so campaign-declared amounts
 * obey the SAME arithmetic as the ledger, with the campaign-specific
 * zero allowance (the ledger's own validator demands strictly
 * positive MOVEMENTS; a declaration may legitimately be empty).
 */
export function validateCampaignAmount(
  field: string,
  amount: number,
): number {
  if (typeof amount !== "number" || !Number.isFinite(amount)) {
    throw new InvalidCampaignPolicyError(
      `${field} must be a finite number (got ${String(amount)})`,
      { field, amount },
    );
  }
  if (amount < 0) {
    throw new InvalidCampaignPolicyError(
      `${field} must be >= 0 (got ${String(amount)})`,
      { field, amount },
    );
  }
  if (amount > ECONOMIC_MAX_AMOUNT) {
    throw new InvalidCampaignPolicyError(
      `${field} exceeds the maximum representable amount ${String(ECONOMIC_MAX_AMOUNT)} (got ${String(amount)})`,
      { field, amount },
    );
  }
  const minor = Math.round(amount * ECONOMIC_SCALE);
  if (Math.abs(minor / ECONOMIC_SCALE - amount) > Number.EPSILON) {
    throw new InvalidCampaignPolicyError(
      `${field} must have at most ${ECONOMIC_DECIMALS} decimals (got ${String(amount)})`,
      { field, amount },
    );
  }
  return amount;
}

/** Validate a confidence threshold ∈ [0, 1] (CAMP-002 confidence policy). */
export function validateCampaignConfidenceThreshold(
  field: string,
  value: number,
): number {
  if (
    typeof value !== "number" ||
    !Number.isFinite(value) ||
    value < 0 ||
    value > 1
  ) {
    throw new InvalidCampaignPolicyError(
      `${field} must be a confidence threshold in [0, 1] (got ${String(value)})`,
      { field, value },
    );
  }
  return value;
}

/** Validate a positive whole-day window (attribution/outcome windows). */
export function validateCampaignWindowDays(
  field: string,
  windowDays: number,
): number {
  if (
    typeof windowDays !== "number" ||
    !Number.isInteger(windowDays) ||
    windowDays <= 0 ||
    windowDays > 3650
  ) {
    throw new InvalidCampaignPolicyError(
      `${field} must be a whole number of days in (0, 3650] (got ${String(windowDays)})`,
      { field, windowDays },
    );
  }
  return windowDays;
}

/** Validate that an evidence grade reference is a frozen core grade. */
export function assertCampaignEvidenceGrade(
  field: string,
  grade: string,
): void {
  if (!isEvidenceGrade(grade)) {
    throw new InvalidCampaignPolicyError(
      `${field} must reference a frozen evidence grade (got ${String(grade)})`,
      { field, grade },
    );
  }
}

/** Validate that evidence source-type references are frozen core types. */
export function assertCampaignEvidenceSourceTypes(
  field: string,
  sourceTypes: readonly string[],
): void {
  for (const sourceType of sourceTypes) {
    if (!isEvidenceSourceType(sourceType)) {
      throw new InvalidCampaignPolicyError(
        `${field} must reference frozen evidence source types (got ${String(sourceType)})`,
        { field, sourceType },
      );
    }
  }
}

/** Validate that an outcome-type reference is a frozen standard type. */
export function assertCampaignOutcomeType(
  field: string,
  outcomeType: string,
): void {
  if (!isStandardOutcomeType(outcomeType)) {
    throw new InvalidCampaignPolicyError(
      `${field} must reference a standard outcome type (got ${String(outcomeType)})`,
      { field, outcomeType },
    );
  }
}

/** Validate that an attribution-mode reference is a frozen core mode. */
export function assertCampaignAttributionMode(
  field: string,
  mode: string,
): void {
  if (!isAttributionMode(mode)) {
    throw new InvalidCampaignPolicyError(
      `${field} must reference a frozen attribution mode (deterministic, probabilistic or experimental — got ${String(mode)})`,
      { field, mode },
    );
  }
}

/**
 * The deterministic incremental-conversion attribution constraint
 * (CAMP-002 confidence policy): an `incremental_conversion` objective's
 * attribution rules MUST use the experimental attribution mode with
 * `requiresExperiment` — incremental claims are only attributable
 * through controlled experiments (architecture §13).
 */
export function assertIncrementalAttributionConstraint(
  objectiveKind: string,
  model: string,
  requiresExperiment: boolean,
): void {
  if (objectiveKind === "incremental_conversion") {
    if (model !== "experimental" || requiresExperiment !== true) {
      throw new InvalidCampaignPolicyError(
        "an incremental_conversion objective requires experimental attribution with requiresExperiment=true (incremental claims are only attributable through controlled experiments)",
        { objectiveKind, model, requiresExperiment },
      );
    }
  }
}

/**
 * The stable, versioned eligibility-policy reference a published
 * opportunity carries (consumed by later enforcement — NET-W012+).
 * Deterministic: `campaign_policy:{campaignId}:{version}:{specId}`.
 */
export function campaignEligibilityPolicyReference(
  campaignId: string,
  policyVersion: number,
  specId: string,
): string {
  return `campaign_policy:${campaignId}:${policyVersion}:${specId}`;
}

// ---------------------------------------------------------------------------
// NET-W021 — Campaign matching and optimization vocabulary
// (campaign-to-inventory/creator supply matching; selection, not
// authority). Mirrors the NET-W016 creator-matching core block
// (core/creators.ts) with the campaign-side semantics: the campaign
// is the matching SUBJECT and W019 inventory items are the candidate
// SUPPLY (creator supply enters through surfaceKind "creator" items —
// the W019 unified-supply decision; /creators matching stays its own
// authority and is deliberately NOT a dependency).
// ---------------------------------------------------------------------------

/**
 * The six explicit W021 ranking signals. Hard constraints are
 * enforced FIRST (the gate vocabulary below); ONLY eligible options
 * are ranked, by these signals with explicit weights. Performance
 * signals are EVIDENCE-BACKED (VERIFIED measured outcomes + canonical
 * reputation snapshots) — the advisory AI path may only blend
 * (bounded) into `alignment` (AI-002) and `risk` (AI-003) and can
 * never flip a hard gate.
 */
export const CAMPAIGN_MATCH_SIGNALS = [
  "alignment",
  "performance",
  "standing",
  "reliability",
  "risk",
  "coverage",
] as const;

export type CampaignMatchSignal = (typeof CAMPAIGN_MATCH_SIGNALS)[number];

export function isCampaignMatchSignal(
  value: string,
): value is CampaignMatchSignal {
  return (CAMPAIGN_MATCH_SIGNALS as readonly string[]).includes(value);
}

/**
 * The closed hard-gate reason vocabulary (NET-W021 §3.1). An
 * ineligible supply option carries one or more of these reasons —
 * the complete, machine-readable explanation. Hard restrictions
 * (tenant boundary, policy scope, supply verification, eligibility
 * rules, targeting, risk holds) can NEVER be overridden by model
 * ranking (structural — the gates are evaluated before any advisory
 * is consulted and the engine has no advisory input on the gate
 * path).
 */
export const CAMPAIGN_MATCH_GATE_REASONS = [
  "campaign_not_publishable",
  "policy_version_unresolved",
  "policy_scope_out_of_tenant",
  "item_out_of_scope",
  "item_retired",
  "supply_not_verified",
  "eligibility_rules_not_satisfied",
  "format_not_targeted",
  "surface_kind_not_targeted",
  "territory_not_reached",
  "language_not_supported",
  "owner_risk_control",
] as const;

export type CampaignMatchGateReason =
  (typeof CAMPAIGN_MATCH_GATE_REASONS)[number];

export function isCampaignMatchGateReason(
  value: string,
): value is CampaignMatchGateReason {
  return (CAMPAIGN_MATCH_GATE_REASONS as readonly string[]).includes(value);
}

/**
 * The frozen matching-run format lineage (the creator-match format
 * precedent): pinned on every campaign match-run record so the
 * contract shape stays reproducible.
 */
export const CAMPAIGN_MATCH_FORMAT = "NET-W021:1" as const;

/** Match weights are integers 0–100 summing to EXACTLY this. */
export const CAMPAIGN_MATCH_WEIGHT_SUM = 100;

/**
 * The maximum advisory blend into each blendable signal
 * (advisoryMaxWeight/100 ≤ 0.25 — AI is advisory, never the
 * eligibility authority, and never dominant in ranking). Applies
 * independently to the AI-002 matching assessment (alignment) and
 * the AI-003 risk analysis (risk).
 */
export const CAMPAIGN_MATCH_ADVISORY_MAX_BLEND = 0.25;

/** The maximum number of supply candidates a single run may rank. */
export const CAMPAIGN_MATCH_MAX_CANDIDATES = 200;

/**
 * Validation error for campaign-match-request violations (NET-W021).
 */
export class InvalidCampaignMatchError extends OpenConError {
  constructor(
    message: string,
    context?: Readonly<Record<string, unknown>>,
  ) {
    super({
      code: "CAMPAIGN_MATCH_VALIDATION",
      classification: "validation",
      message,
      context,
    });
  }
}

/**
 * The canonical default weight profile (integers, sum = 100):
 * alignment 25, performance 30, standing 15, reliability 10, risk
 * 10, coverage 10. Evidence-backed performance carries the largest
 * share (the work item's definition of done). Explicit weights may
 * override it but must satisfy the same constraints.
 */
export const CAMPAIGN_MATCH_DEFAULT_WEIGHTS = Object.freeze({
  alignment: 25,
  performance: 30,
  standing: 15,
  reliability: 10,
  risk: 10,
  coverage: 10,
} as const);

export interface CampaignMatchWeightsShape {
  readonly alignment: number;
  readonly performance: number;
  readonly standing: number;
  readonly reliability: number;
  readonly risk: number;
  readonly coverage: number;
}

/**
 * Validate a weight profile: six integers 0–100 (inclusive), each
 * signal present, summing to EXACTLY {@link CAMPAIGN_MATCH_WEIGHT_SUM}.
 * Ranking is by explicit signals — the weights are part of the
 * reproducible decision record.
 */
export function validateCampaignMatchWeights(
  weights: CampaignMatchWeightsShape,
): CampaignMatchWeightsShape {
  const entries: readonly (readonly [
    keyof CampaignMatchWeightsShape,
    number,
  ])[] = [
    ["alignment", weights.alignment],
    ["performance", weights.performance],
    ["standing", weights.standing],
    ["reliability", weights.reliability],
    ["risk", weights.risk],
    ["coverage", weights.coverage],
  ];
  let sum = 0;
  for (const [field, value] of entries) {
    if (
      typeof value !== "number" ||
      !Number.isInteger(value) ||
      value < 0 ||
      value > 100
    ) {
      throw new InvalidCampaignMatchError(
        `weights.${field} must be an integer between 0 and 100 (got ${String(value)})`,
        { field, value },
      );
    }
    sum += value;
  }
  if (sum !== CAMPAIGN_MATCH_WEIGHT_SUM) {
    throw new InvalidCampaignMatchError(
      `campaign match weights must sum to exactly ${String(CAMPAIGN_MATCH_WEIGHT_SUM)} (got ${String(sum)})`,
      { sum },
    );
  }
  return weights;
}

/**
 * Validate the advisory blend bound: 0 ≤ maxWeight ≤
 * CAMPAIGN_MATCH_ADVISORY_MAX_BLEND × 100. The advisory is advisory —
 * its influence on ranking is structurally capped (AI-002 matching
 * and AI-003 risk analysis are each independently bounded).
 */
export function validateCampaignMatchAdvisoryMaxWeight(
  maxWeight: number,
): number {
  const bound = CAMPAIGN_MATCH_ADVISORY_MAX_BLEND * 100;
  if (
    typeof maxWeight !== "number" ||
    !Number.isFinite(maxWeight) ||
    maxWeight < 0 ||
    maxWeight > bound
  ) {
    throw new InvalidCampaignMatchError(
      `advisory maxWeight must be between 0 and ${String(bound)} (got ${String(maxWeight)}) — AI-assisted matching/optimization is bounded, never the ranking authority`,
      { maxWeight, bound },
    );
  }
  return maxWeight;
}

/**
 * The frozen surface-kind → standing-dimension mapping: which
 * canonical reputation dimension supplies the `standing` signal for
 * a supply option's owner. Creator surfaces use `creator_performance`;
 * publisher/app surfaces use `inventory_quality` (both are frozen
 * /reputation dimensions — matching never recomputes a score, it
 * only resolves the canonical snapshot read-only).
 */
export const CAMPAIGN_MATCH_STANDING_DIMENSION_BY_SURFACE = Object.freeze({
  publisher: "inventory_quality",
  app: "inventory_quality",
  creator: "creator_performance",
} as const) as {
  readonly publisher: "inventory_quality";
  readonly app: "inventory_quality";
  readonly creator: "creator_performance";
};
