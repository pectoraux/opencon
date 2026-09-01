/**
 * The NET-W027 deterministic savings-derivation engine — a PURE,
 * deterministic, uncertainty-preserving derivation (PROC-002 + PROC-AC-01
 * gate + OUT-004/EVID-005 alignment).
 *
 * Work order ref: spec/work-orders/NET-W027.md §4.4/§4.5.
 *
 * Purity contract: no I/O, no wall-clock reads, no mutation. The
 * caller (the savings service) supplies the durable pool, the CURRENT
 * baseline, the baseline's re-resolved /evidence facts (through the
 * neutral lookup), the re-resolved /outcomes observation facts
 * (through the neutral lookup), and the ONE explicit evaluation
 * anchor (the W021/W024/W025/W026 anchor precedent — the anchor is
 * derived ONCE at the service boundary, never inside the engine).
 *
 * Sufficiency contract (work order §4.5 — evidence sufficiency is
 * re-derived from authoritative records; no caller-provided
 * `supported`, value, confidence or quality is trusted): the twelve
 * machine-readable checks below re-derive EVERY governing fact at
 * the anchor —
 *  - `baseline_valid` — the baseline was not one-way invalidated;
 *  - `baseline_kind_interval` — a `counterfactual` baseline carries
 *    a quantified confidence interval (the NET-W006 rule, re-derived:
 *    an exact counterfactual claim without quantified uncertainty is
 *    manufactured and rejected);
 *  - `baseline_evidence_supported` — ≥1 referenced /evidence record
 *    with a QUALIFYING source type (platform/attested/provider —
 *    architecture-lock §4: model/self output alone is input
 *    evidence, never authoritative);
 *  - `baseline_evidence_fresh` — the comparison window end is within
 *    the frozen staleness bound of the anchor (staleness is DERIVED,
 *    never mutated);
 *  - `observation_present` — ≥1 authoritative observation;
 *  - `observation_supported` — ≥1 observation from a qualifying
 *    source type;
 *  - `observation_chain_head` — no referenced observation has been
 *    superseded by a later correction (the /outcomes correction
 *    chain; a superseded observation is stale evidence);
 *  - `observation_subject_bound` — every observation is subject-bound
 *    to THIS procurement pool;
 *  - `observation_outcome_type_savings` — every observation is an
 *    OUT-001 `savings` outcome (W027 fabricates no measurements);
 *  - `observation_evidence_fresh` — every observation's provenance
 *    collection time is within the frozen staleness bound;
 *  - `unit_consistent` — one unit across the baseline and every
 *    observation;
 *  - `uncertainty_preserved` — the derived claim carries a quantified
 *    interval whenever the derivation is counterfactual OR any input
 *    carries one (uncertainty is never silently collapsed).
 * `supported` is the CONJUNCTION — there is NO command that asserts,
 * stores or waives it.
 *
 * Determinism contract (work order §4.4): the observed value combines
 * conservatively (SUM of the chain-head observation values with unit
 * consistency; confidence = MIN point over the baseline AND the
 * observations, interval = the conservative envelope — the NET-W006
 * measurement-rollup precedent); savings = baseline − observed
 * (SERVER-OWNED arithmetic — never caller arithmetic, never offer
 * price, never spend or reputation). The digest covers the decision
 * facts and EXCLUDES the evaluation anchor; the observation order is
 * the deduplicated input order (the SUM is order-independent and the
 * digest serializes that order canonically).
 */

import {
  PROCUREMENT_SAVINGS_DERIVATION_CRITERIA,
  PROCUREMENT_SAVINGS_DERIVATION_METHOD,
  PROCUREMENT_SAVINGS_DERIVATION_POLICY_VERSION,
  PROCUREMENT_SAVINGS_EVIDENCE_MAX_AGE_DAYS,
  PROCUREMENT_SAVINGS_QUALIFYING_SOURCE_TYPES,
  PROCUREMENT_SAVINGS_SUBJECT_TYPE,
} from "../core/procurement-savings.ts";
import { demandDigest } from "./aggregation-engine.ts";
import type {
  ProcurementBaseline,
  ProcurementPool,
  ProcurementSavingsCheck,
  ProcurementSavingsEvidenceFacts,
  ProcurementSavingsOutcomeObservationFacts,
  ProcurementSavingsView,
} from "./port.ts";

/** The conservative confidence-combination method label (recorded). */
const CONSERVATIVE_CONFIDENCE_METHOD = "conservative-savings-derivation";

const MAX_AGE_MS =
  PROCUREMENT_SAVINGS_EVIDENCE_MAX_AGE_DAYS * 24 * 60 * 60 * 1000;

/** The qualifying-source predicate (architecture-lock §4 rule). */
function isQualifyingSource(sourceType: string): boolean {
  return (
    PROCUREMENT_SAVINGS_QUALIFYING_SOURCE_TYPES as readonly string[]
  ).includes(sourceType);
}

/**
 * The baseline-freshness predicate at the anchor: the comparison
 * window ends no later than the anchor AND within the frozen
 * staleness bound of it (staleness is DERIVED here — it is never a
 * mutation).
 */
function baselineWindowFreshAtAnchor(
  baseline: ProcurementBaseline,
  evaluatedAt: string,
): { satisfied: boolean; reason: string } {
  const anchorMs = Date.parse(evaluatedAt);
  const endsAtMs = Date.parse(baseline.comparisonWindow.endsAt);
  if (Number.isNaN(anchorMs) || Number.isNaN(endsAtMs)) {
    return { satisfied: false, reason: "unparseable_timestamp" };
  }
  if (endsAtMs > anchorMs) {
    return { satisfied: false, reason: "window_ends_after_anchor" };
  }
  if (anchorMs - endsAtMs > MAX_AGE_MS) {
    return {
      satisfied: false,
      reason: "baseline_evidence_stale",
    };
  }
  return { satisfied: true, reason: "" };
}

/**
 * The observation-freshness predicate at the anchor: the provenance
 * collection time is no later than the anchor AND within the frozen
 * staleness bound of it.
 */
function observationFreshAtAnchor(
  observation: ProcurementSavingsOutcomeObservationFacts,
  evaluatedAt: string,
): { satisfied: boolean; reason: string } {
  const anchorMs = Date.parse(evaluatedAt);
  const collectedAtMs = Date.parse(observation.provenance.collectedAt);
  if (Number.isNaN(anchorMs) || Number.isNaN(collectedAtMs)) {
    return { satisfied: false, reason: "unparseable_timestamp" };
  }
  if (collectedAtMs > anchorMs) {
    return { satisfied: false, reason: "collected_after_anchor" };
  }
  if (anchorMs - collectedAtMs > MAX_AGE_MS) {
    return { satisfied: false, reason: "observation_evidence_stale" };
  }
  return { satisfied: true, reason: "" };
}

/** Does this confidence carry a quantified interval? */
function hasInterval(confidence: {
  readonly lower?: number;
  readonly upper?: number;
}): boolean {
  return confidence.lower !== undefined && confidence.upper !== undefined;
}

/**
 * THE DERIVATION (work order §4.4/§4.5): the deterministic,
 * uncertainty-preserving savings evaluation of one pool's realized
 * outcome against one explicit baseline. `baselineEvidence` MUST be
 * the baseline's re-resolved /evidence facts in `baseline.evidenceIds`
 * order — an UNRESOLVABLE reference is carried as `null` and fails
 * closed through the evidence-sufficiency check (never a crash);
 * `observations` MUST be the re-resolved /outcomes observation
 * facts in the deduplicated input order (possibly EMPTY, which
 * legitimately fails closed); `evaluatedAt` is the ONE explicit
 * evaluation anchor.
 */
export function deriveProcurementSavings(input: {
  readonly pool: ProcurementPool;
  readonly baseline: ProcurementBaseline;
  readonly baselineEvidence: readonly (
    | ProcurementSavingsEvidenceFacts
    | null
  )[];
  readonly observations: readonly ProcurementSavingsOutcomeObservationFacts[];
  readonly evaluatedAt: string;
}): ProcurementSavingsView {
  const { pool, baseline, baselineEvidence, evaluatedAt } = input;
  // The CANONICAL observation order (id ascending — the W026
  // consideredOfferIds precedent): the derivation is INDEPENDENT of
  // the caller's input order (the sum is order-independent; the
  // confidence combination is order-independent; the digest
  // serializes the canonical order so identical authoritative state
  // yields the identical digest whichever order the caller listed
  // the ids in).
  const observations = [...input.observations].sort((a, b) =>
    a.id < b.id ? -1 : 1,
  );
  const { baselineValue } = baseline;

  const checks: ProcurementSavingsCheck[] = [];

  // 1) The one-way invalidation gate (fail-closed re-derivation —
  //    never a status transition).
  const baselineValid = baseline.invalidatedAt === null;
  checks.push({
    check: "baseline_valid",
    satisfied: baselineValid,
    detail: baselineValid
      ? { baselineId: baseline.id }
      : {
          baselineId: baseline.id,
          reason: "baseline_invalidated",
          invalidatedAt: baseline.invalidatedAt,
          invalidationReason: baseline.invalidationReason,
        },
  });

  // 2) The counterfactual-interval gate (the NET-W006 rule,
  //    re-derived at every anchor — an exact counterfactual claim
  //    without quantified uncertainty is manufactured and rejected).
  const kindIntervalSatisfied =
    baseline.baselineKind !== "counterfactual" || hasInterval(baseline.confidence);
  checks.push({
    check: "baseline_kind_interval",
    satisfied: kindIntervalSatisfied,
    detail: kindIntervalSatisfied
      ? { baselineId: baseline.id, baselineKind: baseline.baselineKind }
      : {
          baselineId: baseline.id,
          baselineKind: baseline.baselineKind,
          reason: "counterfactual_requires_quantified_interval",
        },
  });

  // 3) The baseline-evidence sufficiency gate (the qualifying
  //    source-type rule — model/self evidence alone is input
  //    evidence, never authoritative for a savings claim; an
  //    unresolvable evidence reference is a missing, non-supporting
  //    fact — the claim fails closed, it never crashes).
  const supportingEvidence = baselineEvidence.filter(
    (facts) => facts !== null && isQualifyingSource(facts.sourceType),
  );
  const missingEvidenceCount = baselineEvidence.filter(
    (facts) => facts === null,
  ).length;
  const evidenceSupported =
    supportingEvidence.length > 0 && missingEvidenceCount === 0;
  checks.push({
    check: "baseline_evidence_supported",
    satisfied: evidenceSupported,
    detail: evidenceSupported
      ? {
          baselineId: baseline.id,
          evidenceCount: baselineEvidence.length,
          supportingEvidenceCount: supportingEvidence.length,
        }
      : {
          baselineId: baseline.id,
          evidenceCount: baselineEvidence.length,
          supportingEvidenceCount: supportingEvidence.length,
          missingEvidenceCount,
          reason: "no_qualifying_baseline_evidence",
          sourceTypes: baselineEvidence.map((facts) =>
            facts === null ? null : facts.sourceType,
          ),
        },
  });

  // 4) The baseline-evidence staleness gate (DERIVED at the anchor).
  const baselineFreshness = baselineWindowFreshAtAnchor(baseline, evaluatedAt);
  checks.push({
    check: "baseline_evidence_fresh",
    satisfied: baselineFreshness.satisfied,
    detail: baselineFreshness.satisfied
      ? {
          baselineId: baseline.id,
          windowEndsAt: baseline.comparisonWindow.endsAt,
        }
      : {
          baselineId: baseline.id,
          windowEndsAt: baseline.comparisonWindow.endsAt,
          reason: baselineFreshness.reason,
        },
  });

  // 5) The observation-presence gate (an empty input set is a
  //    legitimate derived DECISION — it fails closed here).
  const observationPresent = observations.length > 0;
  checks.push({
    check: "observation_present",
    satisfied: observationPresent,
    detail: observationPresent
      ? { poolId: pool.id, observationCount: observations.length }
      : { poolId: pool.id, reason: "no_observations" },
  });

  // 6) The observation-source sufficiency gate.
  const supportingObservations = observations.filter((facts) =>
    isQualifyingSource(facts.provenance.sourceType),
  );
  const observationSupported = supportingObservations.length > 0;
  checks.push({
    check: "observation_supported",
    satisfied: observationSupported,
    detail: observationSupported
      ? {
          observationCount: observations.length,
          supportingObservationCount: supportingObservations.length,
        }
      : {
          observationCount: observations.length,
          reason: "no_qualifying_observation_source",
          sourceTypes: observations.map(
            (facts) => facts.provenance.sourceType,
          ),
        },
  });

  // 7) The correction-chain-head gate (a superseded observation is
  //    stale evidence — /outcomes owns the chain semantics; the
  //    neutral lookup exposes the supersession fact).
  const superseded = observations.filter(
    (facts) => facts.supersededByObservationId !== null,
  );
  const chainHead = superseded.length === 0;
  checks.push({
    check: "observation_chain_head",
    satisfied: chainHead,
    detail: chainHead
      ? { observationCount: observations.length }
      : {
          reason: "observation_superseded",
          supersededObservationIds: superseded.map((facts) => facts.id),
        },
  });

  // 8) The subject-binding gate (every observation is about THIS
  //    procurement pool — realized-outcome linkage, never loose
  //    measurements).
  const unbound = observations.filter(
    (facts) =>
      facts.subjectType !== PROCUREMENT_SAVINGS_SUBJECT_TYPE ||
      facts.subjectId !== pool.id,
  );
  const subjectBound = unbound.length === 0;
  checks.push({
    check: "observation_subject_bound",
    satisfied: subjectBound,
    detail: subjectBound
      ? {
          poolId: pool.id,
          subjectType: PROCUREMENT_SAVINGS_SUBJECT_TYPE,
        }
      : {
          poolId: pool.id,
          reason: "observation_not_bound_to_pool",
          unboundObservationIds: unbound.map((facts) => facts.id),
        },
  });

  // 9) The outcome-type gate (the OUT-001 `savings` vocabulary
  //    value — W027 fabricates no measurements).
  const wrongType = observations.filter(
    (facts) => facts.outcomeType !== "savings",
  );
  const outcomeTypeOk = wrongType.length === 0;
  checks.push({
    check: "observation_outcome_type_savings",
    satisfied: outcomeTypeOk,
    detail: outcomeTypeOk
      ? { outcomeType: "savings", observationCount: observations.length }
      : {
          reason: "observation_outcome_type_not_savings",
          offendingObservationIds: wrongType.map((facts) => facts.id),
        },
  });

  // 10) The observation-staleness gate (DERIVED at the anchor).
  const staleObservations = observations
    .map((facts) => ({ facts, fresh: observationFreshAtAnchor(facts, evaluatedAt) }))
    .filter((entry) => !entry.fresh.satisfied);
  const observationsFresh = staleObservations.length === 0;
  checks.push({
    check: "observation_evidence_fresh",
    satisfied: observationsFresh,
    detail: observationsFresh
      ? {
          observationCount: observations.length,
          maxAgeDays: PROCUREMENT_SAVINGS_EVIDENCE_MAX_AGE_DAYS,
        }
      : {
          reason: "observation_evidence_stale",
          maxAgeDays: PROCUREMENT_SAVINGS_EVIDENCE_MAX_AGE_DAYS,
          staleObservationIds: staleObservations.map((entry) => entry.facts.id),
        },
  });

  // 11) The unit-consistency gate (a derivation sums/compares one
  //     unit — the NET-W006 rollup rule).
  const unitMismatched = observations.filter(
    (facts) => facts.observedValue.unit !== baselineValue.unit,
  );
  const unitConsistent = unitMismatched.length === 0;
  checks.push({
    check: "unit_consistent",
    satisfied: unitConsistent,
    detail: unitConsistent
      ? { unit: baselineValue.unit, observationCount: observations.length }
      : {
          unit: baselineValue.unit,
          reason: "mixed_units",
          offendingUnits: unitMismatched.map(
            (facts) => facts.observedValue.unit,
          ),
        },
  });

  // THE CONSERVATIVE COMBINATION (the NET-W006 rollup precedent):
  // the observed value is the SUM of the chain-head observation
  // values; the confidence is as confident as its LEAST confident
  // constituent (baseline included — the savings claim depends on
  // BOTH), with the interval as the conservative envelope over the
  // contributing intervals.
  const combinable = observationPresent && unitConsistent;
  const observedValue = combinable
    ? {
        value: observations.reduce(
          (sum, facts) => sum + facts.observedValue.value,
          0,
        ),
        unit: baselineValue.unit,
      }
    : null;
  const savingsValue = combinable
    ? {
        // SERVER-OWNED arithmetic: savings = baseline − observed.
        // May be negative — an honest realized dis-savings finding
        // (the sufficiency verdict governs authoritative use, not
        // the sign).
        value: baselineValue.value - observedValue!.value,
        unit: baselineValue.unit,
      }
    : null;

  const contributors = [
    baseline.confidence,
    ...observations.map((facts) => facts.confidence),
  ];
  const confidence = combinable
    ? combineConfidenceConservatively(contributors)
    : null;

  // 12) The uncertainty-preservation gate: the derived claim carries
  //     a quantified interval whenever the derivation is
  //     counterfactual OR any input carries one (uncertainty is
  //     never silently collapsed into a manufactured point claim).
  const needsInterval =
    baseline.baselineKind === "counterfactual" ||
    contributors.some((contributor) => hasInterval(contributor));
  const uncertaintyPreserved =
    !needsInterval ||
    (confidence !== null && hasInterval(confidence));
  checks.push({
    check: "uncertainty_preserved",
    satisfied: uncertaintyPreserved,
    detail: uncertaintyPreserved
      ? {
          needsInterval,
          confidenceMethod: CONSERVATIVE_CONFIDENCE_METHOD,
        }
      : {
          needsInterval,
          reason: "uncertainty_collapsed",
        },
  });

  const supported = checks.every((check) => check.satisfied);

  // The deterministic digest over the canonical decision facts —
  // EXCLUDING the evaluation anchor (identical authoritative state ⇒
  // identical digest across evaluations; any governing-fact change ⇒
  // different digest). Reuses the /demand canonical digest helper.
  const digest = demandDigest({
    poolId: pool.id,
    organizationScopeId: pool.organizationScopeId,
    derivationPolicy: {
      version: PROCUREMENT_SAVINGS_DERIVATION_POLICY_VERSION,
      method: PROCUREMENT_SAVINGS_DERIVATION_METHOD,
      criteria: [...PROCUREMENT_SAVINGS_DERIVATION_CRITERIA],
    },
    baseline: {
      id: baseline.id,
      kind: baseline.baselineKind,
      method: baseline.method,
      methodVersion: baseline.methodVersion,
      comparisonWindow: {
        startsAt: baseline.comparisonWindow.startsAt,
        endsAt: baseline.comparisonWindow.endsAt,
      },
      value: baselineValue.value,
      unit: baselineValue.unit,
      confidencePoint: baseline.confidence.point,
      ...(baseline.confidence.lower !== undefined
        ? { confidenceLower: baseline.confidence.lower }
        : {}),
      ...(baseline.confidence.upper !== undefined
        ? { confidenceUpper: baseline.confidence.upper }
        : {}),
      evidence: baselineEvidence.map((facts) =>
        facts === null ? null : { id: facts.id, sourceType: facts.sourceType },
      ),
    },
    observations: observations.map((facts) => ({
      id: facts.id,
      outcomeType: facts.outcomeType,
      subjectId: facts.subjectId,
      subjectType: facts.subjectType,
      value: facts.observedValue.value,
      unit: facts.observedValue.unit,
      confidencePoint: facts.confidence.point,
      ...(facts.confidence.lower !== undefined
        ? { confidenceLower: facts.confidence.lower }
        : {}),
      ...(facts.confidence.upper !== undefined
        ? { confidenceUpper: facts.confidence.upper }
        : {}),
      sourceType: facts.provenance.sourceType,
      collectedAt: facts.provenance.collectedAt,
      correctsObservationId: facts.correctsObservationId,
      supersededByObservationId: facts.supersededByObservationId,
    })),
    checks: checks.map((check) => ({
      check: check.check,
      satisfied: check.satisfied,
    })),
    supported,
    observedValue,
    savings: savingsValue,
    confidence:
      confidence === null
        ? null
        : {
            point: confidence.point,
            ...(confidence.lower !== undefined
              ? { lower: confidence.lower }
              : {}),
            ...(confidence.upper !== undefined
              ? { upper: confidence.upper }
              : {}),
            method: confidence.method,
          },
  });

  return Object.freeze({
    poolId: pool.id,
    organizationScopeId: pool.organizationScopeId,
    derivationPolicy: Object.freeze({
      version: PROCUREMENT_SAVINGS_DERIVATION_POLICY_VERSION,
      method: PROCUREMENT_SAVINGS_DERIVATION_METHOD,
      criteria: Object.freeze([...PROCUREMENT_SAVINGS_DERIVATION_CRITERIA]),
    }),
    baselineId: baseline.id,
    baselineKind: baseline.baselineKind,
    supported,
    checks: Object.freeze(checks),
    baselineValue: Object.freeze({
      value: baselineValue.value,
      unit: baselineValue.unit,
    }),
    observedValue:
      observedValue === null
        ? null
        : Object.freeze({ ...observedValue }),
    savings:
      savingsValue === null ? null : Object.freeze({ ...savingsValue }),
    confidence,
    observationIds: Object.freeze(observations.map((facts) => facts.id)),
    digest,
    evaluatedAt,
  });
}

/**
 * The conservative confidence combination (the NET-W006 rollup
 * precedent, extended to include the baseline): the point is the
 * MINIMUM over all contributing points (the claim is as confident as
 * its least confident constituent); the interval is the envelope
 * [min lower, max upper] over the contributing intervals and is
 * present whenever ANY contributor carries one. The interval always
 * brackets the combined point (each contributor's interval brackets
 * its own point, and the minimum point's own interval is inside the
 * envelope).
 */
function combineConfidenceConservatively(
  contributors: readonly {
    readonly point: number;
    readonly lower?: number;
    readonly upper?: number;
  }[],
): {
  readonly point: number;
  readonly lower?: number;
  readonly upper?: number;
  readonly method: string;
} {
  const point = contributors.reduce(
    (min, contributor) => Math.min(min, contributor.point),
    contributors[0]!.point,
  );
  const withInterval = contributors.filter((contributor) =>
    hasInterval(contributor),
  );
  if (withInterval.length === 0) {
    return Object.freeze({ point, method: CONSERVATIVE_CONFIDENCE_METHOD });
  }
  const lower = withInterval.reduce(
    (min, contributor) => Math.min(min, contributor.lower!),
    withInterval[0]!.lower!,
  );
  const upper = withInterval.reduce(
    (max, contributor) => Math.max(max, contributor.upper!),
    withInterval[0]!.upper!,
  );
  return Object.freeze({
    point,
    lower,
    upper,
    method: CONSERVATIVE_CONFIDENCE_METHOD,
  });
}
