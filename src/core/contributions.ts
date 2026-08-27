/**
 * Shared helpful-contribution vocabulary (core contracts).
 *
 * Architecture ref: spec/architecture.md §8 (Helpfulness architecture:
 * "Question / unmet need → Opportunity discovery → Suggested relevant
 * solutions → User-authored contribution → Community + outcome
 * evidence → Proof-of-Helpfulness"; "Automated discovery/drafting may
 * assist the participant, but public posting remains a user-controlled
 * action"), §18 (module ownership: `/contributions` owns contribution
 * lifecycle and submission state); spec/architecture-lock.md §2 (the
 * sixteen frozen core domains), §1 invariant 9 ("Commercial
 * recommendations must preserve required disclosure and must not
 * condition reward on positive sentiment"), §4 (model/self evidence
 * never solely authoritative), §7 (`/workflows` is the sole lifecycle
 * authority).
 *
 * Work order ref: spec/work-orders/NET-W012.md
 *   §3.1 Core vocabulary + the PURE campaign-eligibility evaluator.
 * Requirements: HELP-001..005.
 *
 * THE KEY RULES (work order §4 — binding invariants):
 *  - MENTION ≠ HELPFULNESS: a product mention is recorded metadata;
 *    no vocabulary here and no evaluator path lets a mention produce
 *    a rewardable result (architecture-lock §1 invariant 9);
 *  - HELPFULNESS IS EVIDENCED: final Proof-of-Helpfulness claims
 *    reference qualifying authority records (proof_of_value /
 *    measured_outcome / evidence_record) with provenance and
 *    uncertainty — never a bare assertion;
 *  - AI IS ADVISORY: model/heuristic scores are recorded signals with
 *    REQUIRED method identity (`methodRef` + `methodVersion` — the
 *    frozen measurement rule) and NEVER qualify; `model` and `self`
 *    evidence source types NEVER qualify (mirrors the frozen
 *    QUALIFYING_ECONOMIC_EVIDENCE_SOURCE_TYPES rule);
 *  - PUBLICATION IS USER-CONTROLLED: nothing in this vocabulary can
 *    publish — publication is a person-actor composition-root command
 *    that transitions the contribution through `/workflows`;
 *  - COMMERCIAL DISCLOSURE IS EXPLICIT: commercial relationship kinds
 *    and disclosure states are closed vocabularies; disclosure is
 *    first-class and auditable.
 *
 * This module is data + pure validation ONLY — no I/O, no wall clock
 * reads inside pure helpers, no lifecycle behaviour.
 */

import { OpenConError } from "./errors.ts";
import { isEvidenceGrade, isEvidenceSourceType } from "./evidence.ts";
import { isStandardOutcomeType } from "./evidence.ts";
import {
  isCampaignEligibilityAttribute,
  isCampaignEligibilityOperator,
} from "./campaigns.ts";
import type {
  CampaignEligibilityAttribute,
  CampaignEligibilityOperator,
} from "./campaigns.ts";

/**
 * The closed helpful-opportunity/contribution vocabulary (HELP-001).
 * Opportunities typed with these values are the useful-recommendation
 * opportunities; a helpful contribution's `contributionType` uses the
 * same closed set. Provider-neutral: no platform/product semantics.
 */
export const HELPFUL_OPPORTUNITY_TYPES = [
  "helpful_recommendation",
  "helpful_guidance",
  "helpful_answer",
  "helpful_comparison",
] as const;

export type HelpfulOpportunityType = (typeof HELPFUL_OPPORTUNITY_TYPES)[number];

export function isHelpfulOpportunityType(
  value: string,
): value is HelpfulOpportunityType {
  return (HELPFUL_OPPORTUNITY_TYPES as readonly string[]).includes(value);
}

/** Alias — the contribution kinds share the opportunity vocabulary. */
export const HELPFUL_CONTRIBUTION_KINDS = HELPFUL_OPPORTUNITY_TYPES;

export type HelpfulContributionKind = HelpfulOpportunityType;

export function isHelpfulContributionKind(
  value: string,
): value is HelpfulContributionKind {
  return isHelpfulOpportunityType(value);
}

/**
 * The recorded policy-format lineage. Every helpfulness policy version
 * carries it; determinism requires that the policy that governed an
 * evaluation is reproducible from the stored version.
 */
export const HELPFULNESS_POLICY_FORMAT = "NET-W012:1" as const;

/**
 * The Proof-of-Helpfulness administrative state machine (work order
 * §3.2 — a DOMAIN-OWNED bookkeeping lifecycle, the dispute-record and
 * campaign-record precedent; deliberately NOT a `LifecycleSubjectKind`:
 * the CONTRIBUTION remains the workflow-lifecycle subject).
 *
 * ```text
 * PENDING ──evaluate──→ QUALIFIED (terminal, the final evidenced claim)
 *    │  ↑
 *    │  └── new bases attach → re-evaluate
 *    └──evaluate──→ NOT_QUALIFIED ──evaluate (new bases)──→ …
 * ```
 *
 * QUALIFIED is terminal: a final claim is never silently rewritten —
 * contradicting evidence is challenged through `/disputes` (NET-W010).
 */
export const PROOF_OF_HELPFULNESS_STATUSES = [
  "PENDING",
  "QUALIFIED",
  "NOT_QUALIFIED",
] as const;

export type ProofOfHelpfulnessStatus =
  (typeof PROOF_OF_HELPFULNESS_STATUSES)[number];

export function isProofOfHelpfulnessStatus(
  value: string,
): value is ProofOfHelpfulnessStatus {
  return (PROOF_OF_HELPFULNESS_STATUSES as readonly string[]).includes(value);
}

/** The terminal statuses (no further transitions). */
export const PROOF_OF_HELPFULNESS_TERMINAL_STATUSES: readonly ProofOfHelpfulnessStatus[] =
  ["QUALIFIED"];

export function isTerminalProofOfHelpfulnessStatus(value: string): boolean {
  return (PROOF_OF_HELPFULNESS_TERMINAL_STATUSES as readonly string[]).includes(
    value,
  );
}

/**
 * The kinds of authoritative records a qualifying Proof-of-Helpfulness
 * basis may reference — the SAME three authority-record kinds the
 * NET-W011 campaign evidence policy references (`proof_of_value` from
 * `/evidence`, `measured_outcome` from `/outcomes`, `evidence_record`
 * from `/evidence`). The helpful-contribution domain never
 * re-implements their semantics; it re-RESOLVES them through neutral
 * lookups at evaluation time.
 */
export const HELPFULNESS_BASIS_KINDS = [
  "proof_of_value",
  "measured_outcome",
  "evidence_record",
] as const;

export type HelpfulnessBasisKind = (typeof HELPFULNESS_BASIS_KINDS)[number];

export function isHelpfulnessBasisKind(
  value: string,
): value is HelpfulnessBasisKind {
  return (HELPFULNESS_BASIS_KINDS as readonly string[]).includes(value);
}

/**
 * The evidence source types that may EVER qualify a helpfulness basis.
 * `model` and `self` NEVER qualify — AI outputs are advisory evidence
 * only (work order §4 invariant 3; mirrors the frozen
 * QUALIFYING_ECONOMIC_EVIDENCE_SOURCE_TYPES and the architecture-lock
 * §4 rule that model/self evidence is never solely authoritative).
 */
export const QUALIFYING_HELPFULNESS_SOURCE_TYPES = [
  "platform",
  "attested",
  "provider",
] as const;

export type QualifyingHelpfulnessSourceType =
  (typeof QUALIFYING_HELPFULNESS_SOURCE_TYPES)[number];

export function isQualifyingHelpfulnessSourceType(value: string): boolean {
  return (
    (QUALIFYING_HELPFULNESS_SOURCE_TYPES as readonly string[]).includes(value)
  );
}

/**
 * The advisory-score kinds (AI is advisory — work order §4 invariant
 * 3). Advisory scores are recorded SIGNALS: they never qualify a
 * basis, never count toward minimums, and never influence the
 * deterministic outcome.
 */
export const HELPFUL_ADVISORY_KINDS = [
  "model_score",
  "heuristic_score",
] as const;

export type HelpfulAdvisoryKind = (typeof HELPFUL_ADVISORY_KINDS)[number];

export function isHelpfulAdvisoryKind(
  value: string,
): value is HelpfulAdvisoryKind {
  return (HELPFUL_ADVISORY_KINDS as readonly string[]).includes(value);
}

/**
 * The commercial-relationship kinds a disclosure may declare (HELP-005:
 * commercial disclosure is first-class and auditable). Closed and
 * provider-neutral.
 */
export const DISCLOSURE_RELATIONSHIP_KINDS = [
  "employment",
  "sponsorship",
  "affiliate",
  "gifted_product",
  "investment",
  "partnership",
  "other",
] as const;

export type DisclosureRelationshipKind =
  (typeof DISCLOSURE_RELATIONSHIP_KINDS)[number];

export function isDisclosureRelationshipKind(
  value: string,
): value is DisclosureRelationshipKind {
  return (DISCLOSURE_RELATIONSHIP_KINDS as readonly string[]).includes(value);
}

/**
 * The disclosure administrative states (append-only events; retraction
 * is terminal — a retracted disclosure never un-retracts, mirroring
 * the append-only correction discipline of evidence records).
 */
export const DISCLOSURE_STATES = ["DECLARED", "RETRACTED"] as const;

export type DisclosureState = (typeof DISCLOSURE_STATES)[number];

export function isDisclosureState(value: string): value is DisclosureState {
  return (DISCLOSURE_STATES as readonly string[]).includes(value);
}

// ---------------------------------------------------------------------------
// Pure validation helpers
// ---------------------------------------------------------------------------

export class InvalidHelpfulnessPolicyError extends OpenConError {
  constructor(
    message: string,
    context?: Readonly<Record<string, unknown>>,
  ) {
    super({
      code: "HELPFULNESS_POLICY_VALIDATION",
      classification: "validation",
      message,
      context,
    });
  }
}

/** Validate a confidence threshold ∈ [0, 1]. */
export function validateHelpfulnessConfidence(
  field: string,
  value: number,
): number {
  if (
    typeof value !== "number" ||
    !Number.isFinite(value) ||
    value < 0 ||
    value > 1
  ) {
    throw new InvalidHelpfulnessPolicyError(
      `${field} must be a confidence threshold in [0, 1] (got ${String(value)})`,
      { field, value },
    );
  }
  return value;
}

/** Validate a positive whole count (minimums). */
export function validateHelpfulnessCount(
  field: string,
  value: number,
  max = 1000,
): number {
  if (
    typeof value !== "number" ||
    !Number.isInteger(value) ||
    value < 1 ||
    value > max
  ) {
    throw new InvalidHelpfulnessPolicyError(
      `${field} must be a whole number in [1, ${String(max)}] (got ${String(value)})`,
      { field, value },
    );
  }
  return value;
}

/** Validate an advisory weight ∈ [0, 1]. */
export function validateHelpfulnessAdvisoryWeight(
  field: string,
  value: number,
): number {
  if (
    typeof value !== "number" ||
    !Number.isFinite(value) ||
    value < 0 ||
    value > 1
  ) {
    throw new InvalidHelpfulnessPolicyError(
      `${field} must be an advisory weight in [0, 1] (got ${String(value)})`,
      { field, value },
    );
  }
  return value;
}

// ---------------------------------------------------------------------------
// The PURE campaign-eligibility evaluator (the FIRST consumer of the
// NET-W011 eligibility-policy reference — work order §3.1)
// ---------------------------------------------------------------------------

/**
 * One provider-neutral campaign eligibility rule, as carried by a
 * published NET-W011 campaign policy (core/campaigns.ts closed
 * vocabularies). Re-declared here structurally so the evaluator stays
 * core-pure without importing the campaigns domain module (it imports
 * only core contracts — this file).
 */
export interface HelpfulEligibilityRule {
  readonly attribute: CampaignEligibilityAttribute;
  readonly operator: CampaignEligibilityOperator;
  readonly values: readonly string[];
}

/**
 * The claimant attributes a helpful submission declares (provider-
 * neutral, closed attribute vocabulary). Claimants declare a SUBSET
 * — rules referencing attributes the claimant did NOT declare FAIL
 * CLOSED (an undeclared attribute can never satisfy an eligibility
 * rule).
 */
export type HelpfulClaimantAttributes = Readonly<
  Partial<Record<CampaignEligibilityAttribute, readonly string[]>>
>;

export interface EligibilityEvaluation {
  readonly eligible: boolean;
  /** One human-readable reason per failed rule (empty when eligible). */
  readonly failures: readonly string[];
}

function compare(
  operator: CampaignEligibilityOperator,
  claimed: readonly string[],
  values: readonly string[],
): boolean {
  switch (operator) {
    case "equals":
      return claimed.length === 1 && values.includes(claimed[0]!);
    case "not_equals":
      return !claimed.some((c) => values.includes(c));
    case "in":
      return claimed.length > 0 && claimed.every((c) => values.includes(c));
    case "not_in":
      return claimed.every((c) => !values.includes(c));
    case "gte":
    case "lte": {
      // Numeric/lexicographic comparison over the FIRST declared value
      // and the FIRST rule value (deterministic; the closed vocabulary
      // uses scalar attributes for ordering operators).
      const a = claimed[0];
      const b = values[0];
      if (a === undefined || b === undefined) return false;
      const na = Number(a);
      const nb = Number(b);
      if (Number.isFinite(na) && Number.isFinite(nb)) {
        return operator === "gte" ? na >= nb : na <= nb;
      }
      return operator === "gte" ? a >= b : a <= b;
    }
    default:
      return false;
  }
}

/**
 * Evaluate campaign eligibility rules against declared claimant
 * attributes — PURE and FAIL-CLOSED:
 *  - every rule must pass;
 *  - a rule referencing an attribute the claimant did not declare
 *    REJECTS (absence of evidence is not eligibility);
 *  - unknown attributes/operators are structurally impossible (closed
 *    vocabularies validated upstream).
 */
export function evaluateCampaignEligibility(
  rules: readonly HelpfulEligibilityRule[],
  claimantAttributes: Readonly<Record<string, readonly string[]>>,
): EligibilityEvaluation {
  const failures: string[] = [];
  for (const rule of rules) {
    if (!isCampaignEligibilityAttribute(rule.attribute)) {
      failures.push(
        `eligibility rule references unknown attribute ${String(rule.attribute)}`,
      );
      continue;
    }
    if (!isCampaignEligibilityOperator(rule.operator)) {
      failures.push(
        `eligibility rule references unknown operator ${String(rule.operator)}`,
      );
      continue;
    }
    const claimed = claimantAttributes[rule.attribute];
    if (claimed === undefined || claimed === null) {
      failures.push(
        `claimant did not declare attribute '${rule.attribute}' (fail-closed)`,
      );
      continue;
    }
    if (!Array.isArray(claimed) || claimed.length === 0) {
      failures.push(
        `claimant declared no values for attribute '${rule.attribute}' (fail-closed)`,
      );
      continue;
    }
    if (!compare(rule.operator, claimed, rule.values)) {
      failures.push(
        `attribute '${rule.attribute}' failed ${rule.operator} against [${rule.values.join(", ")}]`,
      );
    }
  }
  return { eligible: failures.length === 0, failures };
}

/** Validate that evidence grade/source/outcome references are frozen. */
export function assertHelpfulnessEvidenceGrade(
  field: string,
  grade: string,
): void {
  if (!isEvidenceGrade(grade)) {
    throw new InvalidHelpfulnessPolicyError(
      `${field} must reference a frozen evidence grade (got ${String(grade)})`,
      { field, grade },
    );
  }
}

export function assertHelpfulnessSourceTypes(
  field: string,
  sourceTypes: readonly string[],
): void {
  for (const sourceType of sourceTypes) {
    if (!isEvidenceSourceType(sourceType)) {
      throw new InvalidHelpfulnessPolicyError(
        `${field} must reference frozen evidence source types (got ${String(sourceType)})`,
        { field, sourceType },
      );
    }
  }
}

export function assertHelpfulnessOutcomeTypes(
  field: string,
  outcomeTypes: readonly string[],
): void {
  for (const outcomeType of outcomeTypes) {
    if (!isStandardOutcomeType(outcomeType)) {
      throw new InvalidHelpfulnessPolicyError(
        `${field} must reference standard outcome types (got ${String(outcomeType)})`,
        { field, outcomeType },
      );
    }
  }
}
