/**
 * The NET-W025 privacy/competition-preserving aggregation engine — a
 * PURE, deterministic derivation (DEM-002 + PROC-003).
 *
 * Work order ref: spec/work-orders/NET-W025.md §3.4.
 *
 * Purity contract: no I/O, no wall-clock reads, no mutation. The
 * caller (the procurement service) supplies the durable pool, the
 * CURRENT active commitments (already deterministically ordered by
 * (createdAt, id)), the requestor's resolved membership, and the ONE
 * explicit evaluation anchor (the W021/W024 anchor precedent — the
 * anchor is derived ONCE at the service boundary, never inside the
 * engine).
 *
 * Privacy contract (the TWO frozen floors — src/core/procurement.ts
 * PROCUREMENT_PRIVACY_MINIMUM_COMMITMENTS and
 * PROCUREMENT_PRIVACY_MINIMUM_ORGANIZATIONS):
 *  - aggregate facts (including the commitment COUNT and the
 *    organization count itself) exist only when the active commitment
 *    count is at or above the commitment floor AND the commitments
 *    span at least the organization floor's worth of DISTINCT buyer
 *    organizations AND the requestor is an active organization
 *    member (PROC-003: below the organization floor a single buyer —
 *    or a two-buyer duopoly — could be identified and its exact
 *    commercial terms reconstructed, so the aggregate suppresses
 *    entirely);
 *  - every distribution group (region / budget band / unit-price
 *    band / timing window / quantity bucket) is NAMED only when the
 *    group's own count is at or above the frozen commitment floor;
 *    below-floor groups fold into `suppressedGroups` (counted, NEVER
 *    named);
 *  - quantities cross ONLY as fixed-bucket distributions, budgets /
 *    unit prices ONLY as fixed bands and timing ONLY as coarse
 *    windows — never exact values; no person ids, commitment ids or
 *    buyer-organization ids appear anywhere in the output.
 *
 * Determinism contract: identical (pool, commitment multiset) yields
 * the identical digest — the digest covers the decision facts
 * (checks + aggregate + policy + category + pool identity) and
 * EXCLUDES the evaluation anchor. All arrays are canonically ordered
 * (groups sorted by name; commitments pre-sorted by the caller).
 */

import {
  PROCUREMENT_CONSENT_SCOPE,
  PROCUREMENT_PRIVACY_MINIMUM_COMMITMENTS,
  PROCUREMENT_PRIVACY_MINIMUM_ORGANIZATIONS,
  procurementQuantityBucket,
} from "../core/procurement.ts";
import { demandDigest } from "./aggregation-engine.ts";
import type {
  ProcurementAggregateCheck,
  ProcurementAggregateFacts,
  ProcurementCommitment,
  ProcurementDistributionGroup,
  ProcurementPool,
  QualifiedProcurementAggregate,
} from "./port.ts";

/**
 * Build one above-floor distribution group set over a grouping key:
 * groups are sorted by name (deterministic total order); a non-empty
 * group is NAMED only when its count is at or above the frozen
 * commitment floor — below-floor groups fold into the suppressed
 * count (NEVER named; no existence oracle for small groups).
 */
function buildDistribution(
  commitments: readonly ProcurementCommitment[],
  groupOf: (commitment: ProcurementCommitment) => string,
): {
  readonly groups: readonly ProcurementDistributionGroup[];
  readonly suppressedGroups: number;
} {
  const counts = new Map<string, number>();
  for (const commitment of commitments) {
    const key = groupOf(commitment);
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  const groups: ProcurementDistributionGroup[] = [];
  let suppressedGroups = 0;
  // Deterministic total order: ascending group name.
  for (const key of [...counts.keys()].sort()) {
    const count = counts.get(key)!;
    if (count >= PROCUREMENT_PRIVACY_MINIMUM_COMMITMENTS) {
      groups.push(Object.freeze({ group: key, count }));
    } else {
      // Below-floor group: suppressed (counted, never named).
      suppressedGroups += 1;
    }
  }
  return { groups: Object.freeze(groups), suppressedGroups };
}

/**
 * THE DERIVATION (work order §3.4): the privacy/competition-
 * preserving qualified aggregate of one procurement pool, re-derived
 * from CURRENT durable records on every evaluation. `commitments`
 * MUST be the pool's ACTIVE (non-withdrawn) commitments with a VALID
 * consent grant (scope "aggregate_disclosure"), deterministically
 * ordered by (createdAt, id) — the service guarantees both.
 * `requestorMembership` is the server-resolved membership of the
 * requesting person (the neutral lookup view); `evaluatedAt` is the
 * ONE explicit evaluation anchor.
 */
export function deriveQualifiedProcurementAggregate(input: {
  readonly pool: ProcurementPool;
  readonly commitments: readonly ProcurementCommitment[];
  readonly requestorMembership: "active" | "revoked" | null;
  readonly evaluatedAt: string;
}): QualifiedProcurementAggregate {
  const { pool, commitments, requestorMembership, evaluatedAt } = input;
  const count = commitments.length;
  const distinctOrganizations = new Set(
    commitments.map((commitment) => commitment.buyerOrganizationId),
  ).size;

  const checks: ProcurementAggregateCheck[] = [];

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
  //    count below the disclosure floors (PRIV-003 minimization).
  checks.push({
    check: "commitments_present",
    satisfied: count > 0,
    detail:
      count > 0
        ? { poolId: pool.id }
        : { poolId: pool.id, reason: "no_active_commitments" },
  });

  // 4) The frozen commitment disclosure floor is met (this check
  //    gates EVERY aggregate fact — including the count — and no
  //    policy can lower it). Below the floor the count is NOT
  //    disclosed.
  const commitmentFloorMet =
    count >= PROCUREMENT_PRIVACY_MINIMUM_COMMITMENTS;
  checks.push({
    check: "privacy_floor_met",
    satisfied: commitmentFloorMet,
    detail: commitmentFloorMet
      ? { poolId: pool.id }
      : {
          poolId: pool.id,
          reason: "insufficient_commitments_for_disclosure",
        },
  });

  // 5) The frozen DISTINCT-ORGANIZATION (competition) floor is met —
  //    the NET-W025 addition: no aggregate disclosure until the
  //    commitments span enough distinct buyer organizations that no
  //    single buyer's terms can be attributed or reconstructed
  //    (PROC-003). Below this floor even the organization count is
  //    NOT disclosed.
  const organizationFloorMet =
    distinctOrganizations >= PROCUREMENT_PRIVACY_MINIMUM_ORGANIZATIONS;
  checks.push({
    check: "organization_floor_met",
    satisfied: organizationFloorMet,
    detail: organizationFloorMet
      ? { poolId: pool.id }
      : {
          poolId: pool.id,
          reason: "insufficient_distinct_organizations_for_disclosure",
        },
  });

  // 6) The pool's versioned qualification thresholds are met — BOTH
  //    the commitment threshold AND the distinct-organization
  //    threshold (the DERIVED comparison — never caller-asserted).
  const commitmentsThresholdMet =
    count >= pool.policy.minimumCommitments;
  const organizationsThresholdMet =
    distinctOrganizations >= pool.policy.minimumOrganizations;
  const thresholdsMet = commitmentsThresholdMet && organizationsThresholdMet;
  // Counts are disclosed ONLY when the aggregate is disclosable to
  // THIS requestor (both floors met AND the requestor is an active
  // member) — the same gate as the aggregate facts themselves.
  const countsDisclosable =
    commitmentFloorMet && organizationFloorMet && requestorActive;
  checks.push({
    check: "qualification_thresholds_met",
    satisfied: thresholdsMet,
    // The thresholds are public policy; the counts are disclosed only
    // when the aggregate facts are (otherwise suppressed above).
    detail: countsDisclosable
      ? {
          poolId: pool.id,
          policyVersion: pool.policy.version,
          minimumCommitments: pool.policy.minimumCommitments,
          minimumOrganizations: pool.policy.minimumOrganizations,
          commitmentCount: count,
          organizationCount: distinctOrganizations,
        }
      : {
          poolId: pool.id,
          policyVersion: pool.policy.version,
          minimumCommitments: pool.policy.minimumCommitments,
          minimumOrganizations: pool.policy.minimumOrganizations,
          reason: commitmentFloorMet
            ? "counts_suppressed_below_disclosure_floors"
            : "counts_suppressed_below_privacy_floor",
        },
  });

  const qualified = checks.every((check) => check.satisfied);

  // The minimized aggregate facts: emitted ONLY when BOTH frozen
  // floors are met AND the requestor is an active member
  // (supplier-facing disclosure requires all three; below either
  // floor even the counts are suppressed).
  let aggregate: ProcurementAggregateFacts | null = null;
  if (countsDisclosable) {
    const quantity = buildDistribution(commitments, (c) =>
      procurementQuantityBucket(c.attributes.quantity),
    );
    const regions = buildDistribution(
      commitments,
      (c) => c.attributes.region,
    );
    const bands = buildDistribution(
      commitments.filter((c) => c.attributes.budgetBand !== null),
      (c) => c.attributes.budgetBand as string,
    );
    const priceBands = buildDistribution(
      commitments.filter((c) => c.attributes.unitPriceBand !== null),
      (c) => c.attributes.unitPriceBand as string,
    );
    const windows = buildDistribution(
      commitments.filter((c) => c.attributes.timingWindow !== null),
      (c) => c.attributes.timingWindow as string,
    );
    aggregate = Object.freeze({
      commitmentCount: count,
      organizationCount: distinctOrganizations,
      quantityBuckets: quantity.groups,
      regionGroups: regions.groups,
      budgetBandGroups: bands.groups,
      unitPriceBandGroups: priceBands.groups,
      timingWindowGroups: windows.groups,
      suppressedGroups:
        quantity.suppressedGroups +
        regions.suppressedGroups +
        bands.suppressedGroups +
        priceBands.suppressedGroups +
        windows.suppressedGroups,
    });
  }

  // The deterministic digest over the canonical decision facts —
  // EXCLUDING the evaluation anchor (identical commitment state ⇒
  // identical digest across evaluations; any governing-fact change ⇒
  // different digest). Reuses the /demand canonical digest helper.
  const digest = demandDigest({
    poolId: pool.id,
    organizationScopeId: pool.organizationScopeId,
    category: { key: pool.categoryKey, version: pool.categoryVersion },
    policy: {
      version: pool.policy.version,
      minimumCommitments: pool.policy.minimumCommitments,
      minimumOrganizations: pool.policy.minimumOrganizations,
    },
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
      minimumOrganizations: pool.policy.minimumOrganizations,
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
export function hasValidProcurementConsent(
  commitment: ProcurementCommitment,
): boolean {
  return commitment.consent.scope === PROCUREMENT_CONSENT_SCOPE;
}
