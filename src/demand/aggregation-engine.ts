/**
 * The NET-W024 privacy-preserving aggregation engine — a PURE,
 * deterministic derivation (DEM-002/003).
 *
 * Work order ref: spec/work-orders/NET-W024.md §3.4.
 *
 * Purity contract: no I/O, no wall-clock reads, no mutation. The
 * caller (the demand service) supplies the durable pool, the CURRENT
 * active commitments (already deterministically ordered by
 * (createdAt, id)), the requestor's resolved membership, and the ONE
 * explicit evaluation anchor (the W021 anchor precedent — the anchor
 * is derived ONCE at the service boundary, never inside the engine).
 *
 * Privacy contract (the frozen floor — src/core/demand.ts
 * DEMAND_PRIVACY_MINIMUM_COMMITMENTS):
 *  - aggregate facts (including the commitment COUNT itself) exist
 *    only when the active count is at or above the floor AND the
 *    requestor is an active organization member;
 *  - every distribution group (region / budget band / quantity
 *    bucket) is NAMED only when the group's own count is at or above
 *    the floor; below-floor groups fold into `suppressedGroups`
 *    (counted, NEVER named);
 *  - quantities cross ONLY as fixed-bucket distributions — never
 *    exact per-person values; no person ids, commitment ids or
 *    per-commitment timestamps appear anywhere in the output.
 *
 * Determinism contract: identical (pool, commitment multiset) yields
 * the identical digest — the digest covers the decision facts
 * (checks + aggregate + policy + category + pool identity) and
 * EXCLUDES the evaluation anchor. All arrays are canonically ordered
 * (groups sorted by name; commitments pre-sorted by the caller).
 */

import { createHash } from "node:crypto";
import {
  DEMAND_CONSENT_SCOPE,
  DEMAND_PRIVACY_MINIMUM_COMMITMENTS,
  demandQuantityBucket,
} from "../core/demand.ts";
import type {
  DemandAggregateCheck,
  DemandAggregateFacts,
  DemandCommitment,
  DemandDistributionGroup,
  DemandPool,
  QualifiedDemandAggregate,
} from "./port.ts";

/**
 * Canonical JSON serialization (sorted object keys, preserved array
 * order — every digested array is canonically ordered by the engine
 * BEFORE serialization): the boundary-local W021/W022
 * deterministic-digest precedent. Numbers are integers here (counts,
 * thresholds, versions) so no float-formatting ambiguity exists.
 */
function canonicalJson(value: unknown): string {
  if (value === null || typeof value === "number" || typeof value === "boolean") {
    return JSON.stringify(value);
  }
  if (typeof value === "string") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalJson(item)).join(",")}]`;
  }
  if (typeof value === "object") {
    const keys = Object.keys(value as Record<string, unknown>).sort();
    return `{${keys
      .map((key) => `${JSON.stringify(key)}:${canonicalJson((value as Record<string, unknown>)[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(String(value));
}

/** SHA-256 hex digest over the canonical serialization. */
export function demandDigest(input: unknown): string {
  return createHash("sha256").update(canonicalJson(input)).digest("hex");
}

/**
 * Build one above-floor distribution group set over a grouping key:
 * groups are sorted by name (deterministic total order); a non-empty
 * group is NAMED only when its count is at or above the frozen
 * privacy floor — below-floor groups fold into the suppressed count
 * (NEVER named; no existence oracle for small groups).
 */
function buildDistribution(
  commitments: readonly DemandCommitment[],
  groupOf: (commitment: DemandCommitment) => string,
): {
  readonly groups: readonly DemandDistributionGroup[];
  readonly suppressedGroups: number;
} {
  const counts = new Map<string, number>();
  for (const commitment of commitments) {
    const key = groupOf(commitment);
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  const groups: DemandDistributionGroup[] = [];
  let suppressedGroups = 0;
  // Deterministic total order: ascending group name.
  for (const key of [...counts.keys()].sort()) {
    const count = counts.get(key)!;
    if (count >= DEMAND_PRIVACY_MINIMUM_COMMITMENTS) {
      groups.push(Object.freeze({ group: key, count }));
    } else {
      // Below-floor group: suppressed (counted, never named).
      suppressedGroups += 1;
    }
  }
  return { groups: Object.freeze(groups), suppressedGroups };
}

/**
 * THE DERIVATION (work order §3.4): the privacy-preserving qualified
 * aggregate demand of one pool, re-derived from CURRENT durable
 * records on every evaluation. `commitments` MUST be the pool's
 * ACTIVE (non-withdrawn) commitments with a VALID consent grant
 * (scope "aggregate_disclosure"), deterministically ordered by
 * (createdAt, id) — the service guarantees both. `requestorMembership`
 * is the server-resolved membership of the requesting person (the
 * neutral lookup view); `evaluatedAt` is the ONE explicit evaluation
 * anchor.
 */
export function deriveQualifiedDemandAggregate(input: {
  readonly pool: DemandPool;
  readonly commitments: readonly DemandCommitment[];
  readonly requestorMembership: "active" | "revoked" | null;
  readonly evaluatedAt: string;
}): QualifiedDemandAggregate {
  const { pool, commitments, requestorMembership, evaluatedAt } = input;
  const count = commitments.length;

  const checks: DemandAggregateCheck[] = [];

  // 1) The pool is open (a closed pool never qualifies — derived).
  checks.push({
    check: "pool_open",
    satisfied: pool.closedAt === null,
    detail:
      pool.closedAt === null
        ? { poolId: pool.id }
        : { poolId: pool.id, reason: "pool_closed", closedAt: pool.closedAt },
  });

  // 2) The requestor is an active organization member (server-side
  //    authorization for the supplier-facing view).
  const requestorActive = requestorMembership === "active";
  checks.push({
    check: "requestor_membership",
    satisfied: requestorActive,
    detail: requestorActive
      ? { poolId: pool.id }
      : {
          poolId: pool.id,
          reason: "requestor_not_active_member",
        },
  });

  // 3) Active consented commitments exist. Detail never carries the
  //    count below the privacy floor (PRIV-003 minimization).
  const privacyFloorMet = count >= DEMAND_PRIVACY_MINIMUM_COMMITMENTS;
  checks.push({
    check: "commitments_present",
    satisfied: count > 0,
    detail:
      count > 0
        ? { poolId: pool.id }
        : { poolId: pool.id, reason: "no_active_commitments" },
  });

  // 4) The frozen privacy disclosure floor is met (this check gates
  //    EVERY aggregate fact — including the count — and no policy can
  //    lower it). Below the floor the count is NOT disclosed.
  checks.push({
    check: "privacy_floor_met",
    satisfied: privacyFloorMet,
    detail: privacyFloorMet
      ? { poolId: pool.id }
      : {
          poolId: pool.id,
          reason: "insufficient_commitments_for_disclosure",
        },
  });

  // 5) The pool's versioned qualification threshold is met (the
  //    DERIVED comparison — never caller-asserted).
  const thresholdMet = count >= pool.policy.minimumCommitments;
  // Counts are disclosed ONLY when the aggregate is disclosable to
  // THIS requestor (the floor is met AND the requestor is an active
  // member) — the same gate as the aggregate facts themselves.
  const countsDisclosable = privacyFloorMet && requestorActive;
  checks.push({
    check: "qualification_threshold_met",
    satisfied: thresholdMet,
    // The threshold is public policy; the count is disclosed only
    // when the aggregate facts are (otherwise suppressed above).
    detail: countsDisclosable
      ? {
          poolId: pool.id,
          policyVersion: pool.policy.version,
          minimumCommitments: pool.policy.minimumCommitments,
          commitmentCount: count,
        }
      : {
          poolId: pool.id,
          policyVersion: pool.policy.version,
          minimumCommitments: pool.policy.minimumCommitments,
          reason:
            count >= DEMAND_PRIVACY_MINIMUM_COMMITMENTS
              ? "commitment_count_suppressed_for_requestor"
              : "commitment_count_suppressed_below_privacy_floor",
        },
  });

  const qualified = checks.every((check) => check.satisfied);

  // The minimized aggregate facts: emitted ONLY when the frozen
  // privacy floor is met AND the requestor is an active member
  // (supplier-facing disclosure requires both; below the floor even
  // the commitment count is suppressed).
  let aggregate: DemandAggregateFacts | null = null;
  if (privacyFloorMet && requestorActive) {
    const quantity = buildDistribution(commitments, (c) =>
      demandQuantityBucket(c.attributes.quantity),
    );
    const regions = buildDistribution(commitments, (c) => c.attributes.region);
    const bands = buildDistribution(
      commitments.filter((c) => c.attributes.budgetBand !== null),
      (c) => c.attributes.budgetBand as string,
    );
    aggregate = Object.freeze({
      commitmentCount: count,
      quantityBuckets: quantity.groups,
      regionGroups: regions.groups,
      budgetBandGroups: bands.groups,
      suppressedGroups:
        quantity.suppressedGroups +
        regions.suppressedGroups +
        bands.suppressedGroups,
    });
  }

  // The deterministic digest over the canonical decision facts —
  // EXCLUDING the evaluation anchor (identical commitment state ⇒
  // identical digest across evaluations; any governing-fact change ⇒
  // different digest).
  const digest = demandDigest({
    poolId: pool.id,
    organizationScopeId: pool.organizationScopeId,
    category: { key: pool.categoryKey, version: pool.categoryVersion },
    policy: { version: pool.policy.version, minimumCommitments: pool.policy.minimumCommitments },
    qualified,
    checks: checks.map((check) => ({
      check: check.check,
      satisfied: check.satisfied,
    })),
    aggregate,
  });

  return Object.freeze({
    poolId: pool.id,
    organizationScopeId: pool.organizationScopeId,
    category: Object.freeze({
      key: pool.categoryKey,
      version: pool.categoryVersion,
    }),
    policy: Object.freeze({
      version: pool.policy.version,
      minimumCommitments: pool.policy.minimumCommitments,
    }),
    qualified,
    checks: Object.freeze(checks),
    aggregate,
    digest,
    evaluatedAt,
  });
}

/**
 * The consent validity predicate the service applies before a
 * commitment may govern an aggregate: the consent grant must name the
 * ONE closed consent scope (aggregate_disclosure). A commitment
 * without a valid grant cannot exist (the create command fails
 * closed on any other scope), so this predicate is the belt-and-
 * braces re-check for the derivation input contract.
 */
export function hasValidAggregateConsent(
  commitment: DemandCommitment,
): boolean {
  return commitment.consent.scope === DEMAND_CONSENT_SCOPE;
}
