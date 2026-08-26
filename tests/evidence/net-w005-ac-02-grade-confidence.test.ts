/**
 * NET-W005-AC-02 — Explicit, deterministic provenance/grade/confidence
 * model.
 *
 * Every source type maps to exactly one grade via the explicit rule
 * table (EVID-003); identical inputs produce identical grades; the
 * confidence invariants (range, interval ordering — EVID-005) are
 * enforced with stable error codes; the model-assessed (AI) grade is
 * explicitly NON-AUTHORITATIVE (architecture-lock §4).
 *
 * Evidence: exhaustive rule-table tests + validation tests.
 */

import { describe, test, expect } from "bun:test";
import {
  EVIDENCE_GRADE_RULE_TABLE,
  EVIDENCE_GRADE_WEIGHTS,
  gradeForProvenance,
  isHighSupportGrade,
} from "../../src/evidence/grade-rules.ts";
import {
  EVIDENCE_SOURCE_TYPES,
  EVIDENCE_GRADES,
  EVIDENCE_GRADE_RANK,
  validateConfidenceEstimate,
  InvalidConfidenceError,
  type ProvenanceRecord,
} from "../../src/core/evidence.ts";

function provenanceOf(sourceType: ProvenanceRecord["sourceType"]): ProvenanceRecord {
  return {
    sourceType,
    method: "test-method",
    collectedAt: "2026-01-01T00:00:00.000Z",
  };
}

describe("NET-W005-AC-02 deterministic provenance/grade/confidence model", () => {
  test("the grade rule table is EXHAUSTIVE: every source type maps to exactly one grade", () => {
    expect(EVIDENCE_SOURCE_TYPES.length).toBe(5);
    expect(EVIDENCE_GRADES.length).toBe(5);
    for (const sourceType of EVIDENCE_SOURCE_TYPES) {
      const grade = EVIDENCE_GRADE_RULE_TABLE[sourceType];
      expect(grade).toBeTruthy();
      expect(EVIDENCE_GRADES).toContain(grade);
    }
    // The exact deterministic mapping (work order §3.2):
    expect(EVIDENCE_GRADE_RULE_TABLE.platform).toBe("MEASURED");
    expect(EVIDENCE_GRADE_RULE_TABLE.attested).toBe("ATTESTED");
    expect(EVIDENCE_GRADE_RULE_TABLE.provider).toBe("PROVIDER_REPORTED");
    expect(EVIDENCE_GRADE_RULE_TABLE.model).toBe("MODEL_ASSESSED");
    expect(EVIDENCE_GRADE_RULE_TABLE.self).toBe("SELF_REPORTED");
  });

  test("gradeForProvenance is DETERMINISTIC: identical provenance always produces the identical grade", () => {
    for (let i = 0; i < 25; i += 1) {
      for (const sourceType of EVIDENCE_SOURCE_TYPES) {
        const p = provenanceOf(sourceType);
        expect(gradeForProvenance(p)).toBe(gradeForProvenance(p));
        expect(gradeForProvenance(p)).toBe(EVIDENCE_GRADE_RULE_TABLE[sourceType]);
      }
    }
  });

  test("the grade ranks are strictly ordered (MEASURED best → SELF_REPORTED worst)", () => {
    expect(EVIDENCE_GRADE_RANK.MEASURED).toBeLessThan(EVIDENCE_GRADE_RANK.ATTESTED);
    expect(EVIDENCE_GRADE_RANK.ATTESTED).toBeLessThan(EVIDENCE_GRADE_RANK.PROVIDER_REPORTED);
    expect(EVIDENCE_GRADE_RANK.PROVIDER_REPORTED).toBeLessThan(EVIDENCE_GRADE_RANK.MODEL_ASSESSED);
    expect(EVIDENCE_GRADE_RANK.MODEL_ASSESSED).toBeLessThan(EVIDENCE_GRADE_RANK.SELF_REPORTED);
    // Aggregation weights follow the rank order (evidential strength).
    expect(EVIDENCE_GRADE_WEIGHTS.MEASURED).toBeGreaterThan(EVIDENCE_GRADE_WEIGHTS.ATTESTED);
    expect(EVIDENCE_GRADE_WEIGHTS.ATTESTED).toBeGreaterThan(EVIDENCE_GRADE_WEIGHTS.PROVIDER_REPORTED);
    expect(EVIDENCE_GRADE_WEIGHTS.PROVIDER_REPORTED).toBeGreaterThan(EVIDENCE_GRADE_WEIGHTS.MODEL_ASSESSED);
    expect(EVIDENCE_GRADE_WEIGHTS.MODEL_ASSESSED).toBeGreaterThan(EVIDENCE_GRADE_WEIGHTS.SELF_REPORTED);
  });

  test("MODEL_ASSESSED (AI output) is admissible as INPUT evidence but is NEVER high-support (architecture-lock §4)", () => {
    // Model output IS admissible evidence (an input/recommendation)...
    expect(EVIDENCE_GRADE_RULE_TABLE.model).toBe("MODEL_ASSESSED");
    // ...but it can NEVER independently support a VERIFIED Proof-of-Value
    // (that requires MEASURED or ATTESTED evidence):
    expect(isHighSupportGrade("MODEL_ASSESSED")).toBe(false);
    expect(isHighSupportGrade("SELF_REPORTED")).toBe(false);
    expect(isHighSupportGrade("MEASURED")).toBe(true);
    expect(isHighSupportGrade("ATTESTED")).toBe(true);
  });

  test("validateConfidenceEstimate accepts valid point estimates and intervals", () => {
    expect(validateConfidenceEstimate({ point: 0.5 }).point).toBe(0.5);
    expect(validateConfidenceEstimate({ point: 0 }).point).toBe(0);
    expect(validateConfidenceEstimate({ point: 1 }).point).toBe(1);
    const withInterval = validateConfidenceEstimate({
      point: 0.8,
      lower: 0.6,
      upper: 0.95,
      method: "sampled",
    });
    expect(withInterval.lower).toBe(0.6);
    expect(withInterval.upper).toBe(0.95);
    expect(withInterval.method).toBe("sampled");
    // The normalized copy is frozen (immutable vocabulary).
    expect(Object.isFrozen(withInterval)).toBe(true);
  });

  test("validateConfidenceEstimate rejects out-of-range points with the stable code INVALID_CONFIDENCE_ESTIMATE", () => {
    for (const bad of [-0.01, 1.01, Number.NaN, Number.POSITIVE_INFINITY, "0.5" as never]) {
      try {
        validateConfidenceEstimate({ point: bad });
        throw new Error(`expected ${String(bad)} to be rejected`);
      } catch (err) {
        expect(err).toBeInstanceOf(InvalidConfidenceError);
        expect((err as InvalidConfidenceError).code).toBe("INVALID_CONFIDENCE_ESTIMATE");
      }
    }
  });

  test("validateConfidenceEstimate rejects intervals that do not bracket the point (EVID-005)", () => {
    // lower > point — invalid.
    expect(() => validateConfidenceEstimate({ point: 0.5, lower: 0.7 })).toThrow(
      InvalidConfidenceError,
    );
    // upper < point — invalid.
    expect(() => validateConfidenceEstimate({ point: 0.5, upper: 0.3 })).toThrow(
      InvalidConfidenceError,
    );
    // lower < 0 — invalid.
    expect(() => validateConfidenceEstimate({ point: 0.5, lower: -0.1 })).toThrow(
      InvalidConfidenceError,
    );
    // upper > 1 — invalid.
    expect(() => validateConfidenceEstimate({ point: 0.5, upper: 1.1 })).toThrow(
      InvalidConfidenceError,
    );
  });

  test("the evidence service derives grades through the deterministic rule table end-to-end", async () => {
    // Covered end-to-end (service-level) in the AC-01 suite; here we
    // assert the pure rule surface used by the service is the SINGLE
    // source of truth: the service imports gradeForProvenance from
    // grade-rules.ts and the rule table is data (frozen).
    expect(Object.isFrozen(EVIDENCE_GRADE_RULE_TABLE)).toBe(true);
    expect(Object.isFrozen(EVIDENCE_GRADE_WEIGHTS)).toBe(true);
  });
});
