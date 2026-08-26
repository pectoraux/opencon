/**
 * Evidence grade rules — the deterministic mapping from provenance
 * source type to evidence grade (NET-W005 §3.2; EVID-003: support
 * multiple evidence grades).
 *
 * Architecture ref: spec/architecture-lock.md §4 (agent/model output
 * is input evidence or a recommendation; it does not directly
 * authorize settlement). The rule table makes that invariant
 * MECHANICAL: model-assessed evidence is admissible (grade
 * MODEL_ASSESSED) but ranks below measured/attested evidence, and a
 * Proof-of-Value can never reach VERIFIED on model-assessed or
 * self-reported evidence alone (see proof-of-value-service.ts).
 *
 * The table is DATA, not judgment:
 *
 * | source type | grade               | rank |
 * |-------------|---------------------|------|
 * | platform    | MEASURED            | 1    |
 * | attested    | ATTESTED            | 2    |
 * | provider    | PROVIDER_REPORTED   | 3    |
 * | model       | MODEL_ASSESSED      | 4    |
 * | self        | SELF_REPORTED       | 5    |
 *
 * The same provenance ALWAYS produces the same grade (deterministic —
 * AC-02). No model inference, no configuration, no context.
 *
 * Out of scope (work order §5): grades carry NO economic weight —
 * the aggregation weights below express relative evidential strength
 * for confidence combination only, never value.
 */

import type {
  EvidenceGrade,
  EvidenceSourceType,
  ProvenanceRecord,
} from "../core/evidence.ts";
import { EVIDENCE_GRADE_RANK } from "../core/evidence.ts";

/** The explicit, exhaustive source-type → grade rule table. */
export const EVIDENCE_GRADE_RULE_TABLE: Readonly<
  Record<EvidenceSourceType, EvidenceGrade>
> = Object.freeze({
  platform: "MEASURED",
  attested: "ATTESTED",
  provider: "PROVIDER_REPORTED",
  model: "MODEL_ASSESSED",
  self: "SELF_REPORTED",
});

/**
 * Grade weights for evidence aggregation (work order §3.7): relative
 * evidential strength used ONLY to combine confidence estimates.
 * MEASURED counts 5x a self-report; MODEL_ASSESSED (AI output — input
 * evidence, never authoritative) counts below every human/system
 * source except self-reports.
 */
export const EVIDENCE_GRADE_WEIGHTS: Readonly<Record<EvidenceGrade, number>> =
  Object.freeze({
    MEASURED: 1.0,
    ATTESTED: 0.8,
    PROVIDER_REPORTED: 0.6,
    MODEL_ASSESSED: 0.3,
    SELF_REPORTED: 0.2,
  });

/**
 * Derive the evidence grade from provenance — the deterministic rule
 * (work order §3.2, invariant 2). Pure: identical provenance always
 * produces the identical grade. The source type is the SOLE input.
 */
export function gradeForProvenance(provenance: ProvenanceRecord): EvidenceGrade {
  const grade = EVIDENCE_GRADE_RULE_TABLE[provenance.sourceType];
  if (!grade) {
    // Unreachable when the input was validated against
    // EVIDENCE_SOURCE_TYPES; defensive for direct construction.
    throw new Error(
      `no grade rule for source type ${String(provenance.sourceType)}`,
    );
  }
  return grade;
}

/** Order grades best-rank-first (deterministic ordering helper). */
export function gradesOrderedBestFirst(a: EvidenceGrade, b: EvidenceGrade): number {
  return EVIDENCE_GRADE_RANK[a] - EVIDENCE_GRADE_RANK[b];
}

/**
 * The grades that can independently support a VERIFIED Proof-of-Value
 * (work order §3.8): platform-measured or independently attested
 * evidence. Model-assessed (AI output) and self-reported evidence are
 * admissible as INPUT but never sufficient alone (architecture-lock
 * §4: evidence — not participant or agent claims — is authoritative
 * for settlement and reputation).
 */
export const HIGH_SUPPORT_GRADES: readonly EvidenceGrade[] = Object.freeze([
  "MEASURED",
  "ATTESTED",
]);

/** Whether the grade can independently support a VERIFIED PoV. */
export function isHighSupportGrade(grade: EvidenceGrade): boolean {
  return HIGH_SUPPORT_GRADES.includes(grade);
}
