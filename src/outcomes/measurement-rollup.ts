/**
 * Deterministic measurement rollup (NET-W006 §3.6).
 *
 * Architecture ref: spec/architecture.md §13 (all economically
 * material values retain confidence/uncertainty information);
 * spec/architecture-lock.md §4 (evidence, not participant or agent
 * claims, is authoritative — the finalized measured value is DERIVED
 * from observations, never caller-asserted).
 *
 * The rollup is a PURE, DETERMINISTIC function over the CHAIN-HEAD
 * attached observations:
 *
 *  - only chain-head observations (non-superseded corrections) count;
 *  - all included observations must share ONE unit (mixed units are
 *    rejected with a stable error code);
 *  - rollup strategy:
 *      `sum`    — the finalized value is the sum of chain-head values
 *                 (event/count-like outcomes);
 *      `latest` — the finalized value is the value of the
 *                 most-recently-collected chain head (state-like
 *                 outcomes such as retention; deterministic tiebreak
 *                 by observation id);
 *  - confidence: conservative combination — the point estimate is the
 *    MINIMUM contributing point (the measurement is as confident as
 *    its least confident constituent); the interval (when ANY
 *    contributor quantifies one) is the conservative envelope
 *    [min lower, max upper];
 *  - the rollup records the exact observation ids it covers
 *    (auditability) and the number of superseded corrections excluded.
 *
 * The supporting-source gate (work order §3.6 / invariant 6): the
 * rollup REQUIRES at least one chain-head observation whose source
 * type is `platform`, `attested`, or `provider` — model-assessed or
 * self-reported observations alone can never produce a finalized
 * measurement (architecture-lock §4: agent/model output is input
 * evidence, never authoritative).
 *
 * Tier compliance: outcomes domain → self + core contracts only.
 */

import { OpenConError } from "../core/errors.ts";
import type { ConfidenceEstimate } from "../core/evidence.ts";
import type { RollupStrategy } from "../core/measurement.ts";
import type { MeasurementRollup, OutcomeObservation } from "./port.ts";

/** Source types that can support a finalized measurement. */
const SUPPORTING_SOURCE_TYPES: readonly string[] = [
  "platform",
  "attested",
  "provider",
];

/**
 * Compute the deterministic rollup over chain-head observations.
 * Throws:
 *  - MEASUREMENT_VALIDATION when no observations are attached;
 *  - MEASUREMENT_VALIDATION when the observation units are mixed;
 *  - MEASUREMENT_VALIDATION when no observation carries a supporting
 *    (platform/attested/provider) source type.
 */
export function rollupObservations(
  heads: readonly OutcomeObservation[],
  supersededCount: number,
  strategy: RollupStrategy,
  computedAt: string,
): MeasurementRollup {
  if (heads.length === 0) {
    throw new OpenConError({
      code: "MEASUREMENT_VALIDATION",
      classification: "validation",
      message:
        "the measurement rollup requires at least one attached outcome observation",
      context: {},
    });
  }
  // Unit consistency: a measurement sums/compares one unit.
  const unit = heads[0]!.observedValue.unit;
  for (const head of heads) {
    if (head.observedValue.unit !== unit) {
      throw new OpenConError({
        code: "MEASUREMENT_VALIDATION",
        classification: "validation",
        message: `the measurement rollup requires a single unit across observations (found ${unit} and ${head.observedValue.unit})`,
        context: {
          observationId: head.id,
          expectedUnit: unit,
          actualUnit: head.observedValue.unit,
        },
      });
    }
  }
  // Supporting-source gate (architecture-lock §4): model/self
  // observations alone can never produce a finalized measurement.
  const hasSupportingSource = heads.some((head) =>
    SUPPORTING_SOURCE_TYPES.includes(head.provenance.sourceType),
  );
  if (!hasSupportingSource) {
    throw new OpenConError({
      code: "MEASUREMENT_VALIDATION",
      classification: "validation",
      message:
        "the measurement rollup requires at least one observation from a platform, attested, or provider source — model-assessed or self-reported observations alone can never produce a finalized measurement (architecture-lock §4)",
      context: {
        observationCount: heads.length,
        sourceTypes: heads.map((h) => h.provenance.sourceType),
      },
    });
  }

  // Deterministic value derivation.
  let value: number;
  let includedHeads: readonly OutcomeObservation[];
  if (strategy === "latest") {
    // Most-recently-collected head; deterministic tiebreak by id.
    const ordered = [...heads].sort((a, b) => {
      const aTime = a.provenance.collectedAt;
      const bTime = b.provenance.collectedAt;
      if (aTime !== bTime) return aTime < bTime ? 1 : aTime > bTime ? -1 : 0;
      return a.id < b.id ? 1 : a.id > b.id ? -1 : 0;
    });
    const latest = ordered[0]!;
    value = latest.observedValue.value;
    includedHeads = heads; // all heads remain covered by the rollup
  } else {
    value = heads.reduce((sum, head) => sum + head.observedValue.value, 0);
    includedHeads = heads;
  }

  // Conservative confidence combination: the measurement is as
  // confident as its least confident constituent; the interval is the
  // conservative envelope over the contributing intervals.
  const point = heads.reduce(
    (min, head) => Math.min(min, head.confidence.point),
    heads[0]!.confidence.point,
  );
  const withInterval = heads.filter(
    (head) =>
      head.confidence.lower !== undefined && head.confidence.upper !== undefined,
  );
  let confidence: ConfidenceEstimate;
  if (withInterval.length > 0) {
    const lower = withInterval.reduce(
      (min, head) => Math.min(min, head.confidence.lower!),
      withInterval[0]!.confidence.lower!,
    );
    const upper = withInterval.reduce(
      (max, head) => Math.max(max, head.confidence.upper!),
      withInterval[0]!.confidence.upper!,
    );
    confidence = {
      point,
      lower,
      upper,
      method: "conservative-observation-rollup",
    };
  } else {
    confidence = { point, method: "conservative-observation-rollup" };
  }

  return Object.freeze({
    strategy,
    measuredValue: Object.freeze({ value, unit }),
    confidence: Object.freeze(confidence),
    observationIds: includedHeads.map((head) => head.id),
    supersededObservationCount: supersededCount,
    computedAt,
  });
}
