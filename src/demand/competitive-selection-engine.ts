/**
 * The NET-W026 deterministic competitive-selection engine — a PURE,
 * deterministic derivation (DEM-003 + PROC-001 + PROC-003).
 *
 * Work order ref: spec/work-orders/NET-W026.md §4.2/§4.3.
 *
 * Purity contract: no I/O, no wall-clock reads, no mutation. The
 * caller (the supplier-offer service) supplies the durable pool, the
 * re-derived NET-W025 qualified aggregate at the SAME anchor, the
 * CURRENT active (non-withdrawn) offers (already deterministically
 * ordered by (createdAt, id)), the suppliers' re-resolved
 * memberships, and the ONE explicit evaluation anchor (the W021/
 * W024/W025 anchor precedent — the anchor is derived ONCE at the
 * service boundary, never inside the engine).
 *
 * Hard-eligibility contract (work order §4.2 — eligibility is
 * re-derived from authoritative records; no caller-provided
 * `eligible`, `qualified`, ranking score or selection result is
 * trusted):
 *  - `pool_qualified` — the pool-level qualified-demand gate: the
 *    re-derived NET-W025 qualification (both frozen floors + the
 *    pool's thresholds + the pool open). Unqualified, closed or
 *    withdrawn demand cannot enter competitive selection;
 *  - `offer_validity` — the offer is valid at the anchor (the anchor
 *    falls inside the recorded validity window; expiry is DERIVED,
 *    never mutated);
 *  - `region_served` — the offer's region appears in the qualified
 *    aggregate's NAMED (above-floor) region groups — a supplier may
 *    compete only where the minimized demand contract actually names
 *    demand (below-floor regions are never named, so they can never
 *    be targeted — the W025 privacy contract preserved);
 *  - `supplier_authorized` — the supplier holds an ACTIVE tenant
 *    membership at the anchor (re-resolved server-side).
 *
 * Determinism contract (work order §4.3): identical authoritative
 * state + evaluation anchor produce the identical ranking/selection.
 * The ranking is the explicit, versioned, server-owned policy
 * (SUPPLIER_OFFER_UNIT_PRICE_RANK ascending, SUPPLIER_OFFER_TIMING_
 * RANK ascending, SUPPLIER_OFFER_CAPACITY_RANK ascending — larger
 * capacity first, then the stable offer id ascending as the final
 * tie-break; the W021 orderCandidates precedent). The digest covers
 * the decision facts and EXCLUDES the evaluation anchor; all arrays
 * are canonically ordered (offer ids ascending; the ranked order IS
 * the decision).
 *
 * Privacy contract (work order §4.4 — PROC-003): the output carries
 * SUPPLIER/offer facts only — the pool digest links the demand state
 * WITHOUT carrying the aggregate facts; no person identifiers from
 * buyer commitments, no buyer-organization identifiers, no
 * commitment ids, no exact buyer quantities/prices/budgets/timing
 * ever appear (the buyer-side data stays behind the W025 minimized
 * contract).
 */

import {
  SUPPLIER_OFFER_CAPACITY_RANK,
  SUPPLIER_OFFER_RANKING_CRITERIA,
  SUPPLIER_OFFER_SELECTION_POLICY_VERSION,
  SUPPLIER_OFFER_TIMING_RANK,
  SUPPLIER_OFFER_UNIT_PRICE_RANK,
} from "../core/procurement-offer.ts";
import { demandDigest } from "./aggregation-engine.ts";
import type {
  CompetitiveSelectionCheck,
  CompetitiveSelectionRankEntry,
  CompetitiveSelectionView,
  ProcurementPool,
  QualifiedProcurementAggregate,
  SupplierOffer,
  SupplierOfferCheck,
  SupplierOfferEvaluation,
} from "./port.ts";

/**
 * The validity predicate of one offer at the evaluation anchor:
 * the anchor must fall inside the recorded window [validFrom,
 * validUntil] (validUntil null = open; the upper bound is
 * INCLUSIVE). Expiry is derived here — it is never a mutation.
 */
function offerValidAtAnchor(
  offer: SupplierOffer,
  evaluatedAt: string,
): boolean {
  if (evaluatedAt < offer.validFrom) return false;
  if (offer.validUntil !== null && evaluatedAt > offer.validUntil) {
    return false;
  }
  return true;
}

/**
 * The region gate: the offer's region must appear in the qualified
 * aggregate's NAMED (above-floor) region groups. When the pool is
 * not qualified the gate fails closed without consulting (or
 * disclosing) any demand facts.
 */
function regionServedByOffer(
  qualifiedAggregate: QualifiedProcurementAggregate,
  offer: SupplierOffer,
): boolean {
  if (!qualifiedAggregate.qualified) return false;
  const facts = qualifiedAggregate.aggregate;
  if (facts === null) return false;
  return facts.regionGroups.some(
    (group) => group.group === offer.attributes.region,
  );
}

/**
 * The deterministic total order over ELIGIBLE offers (work order
 * §4.3 — explicit, bounded, versioned, server-owned):
 *  1. unit-price band ascending (cheaper ranks first);
 *  2. delivery-timing window ascending (faster ranks first);
 *  3. capacity bucket descending (larger ranks first — the capacity
 *     table is pre-reversed so every ordinal is ascending);
 *  4. offer id ascending (the stable final tie-break — the W021
 *     precedent; no input ordering ever leaks into the decision).
 */
function compareOffers(a: SupplierOffer, b: SupplierOffer): number {
  const priceA = SUPPLIER_OFFER_UNIT_PRICE_RANK.indexOf(
    a.attributes.unitPriceBand,
  );
  const priceB = SUPPLIER_OFFER_UNIT_PRICE_RANK.indexOf(
    b.attributes.unitPriceBand,
  );
  if (priceA !== priceB) return priceA < priceB ? -1 : 1;
  const timingA = SUPPLIER_OFFER_TIMING_RANK.indexOf(a.attributes.timingWindow);
  const timingB = SUPPLIER_OFFER_TIMING_RANK.indexOf(b.attributes.timingWindow);
  if (timingA !== timingB) return timingA < timingB ? -1 : 1;
  const capacityA = SUPPLIER_OFFER_CAPACITY_RANK.indexOf(
    a.attributes.quantityBucket,
  );
  const capacityB = SUPPLIER_OFFER_CAPACITY_RANK.indexOf(
    b.attributes.quantityBucket,
  );
  if (capacityA !== capacityB) return capacityA < capacityB ? -1 : 1;
  return a.id < b.id ? -1 : 1;
}

/**
 * THE DERIVATION (work order §4.2/§4.3): the deterministic
 * hard-eligibility evaluation + competitive ranking of one pool's
 * active supplier offers. `offers` MUST be the pool's ACTIVE
 * (non-withdrawn) offers, deterministically ordered by (createdAt,
 * id) — the service guarantees this; the RANKING ignores that input
 * order entirely (it re-sorts over the explicit policy so the output
 * is reproducible from the records alone). `qualifiedAggregate` MUST
 * be the re-derived NET-W025 view at the SAME anchor;
 * `supplierMemberships` maps each DISTINCT supplier person id to its
 * re-resolved membership at the anchor; `evaluatedAt` is the ONE
 * explicit evaluation anchor.
 */
export function deriveCompetitiveSelection(input: {
  readonly pool: ProcurementPool;
  readonly qualifiedAggregate: QualifiedProcurementAggregate;
  readonly offers: readonly SupplierOffer[];
  readonly supplierMemberships: Readonly<
    Record<string, "active" | "revoked" | null>
  >;
  readonly evaluatedAt: string;
}): CompetitiveSelectionView {
  const { pool, qualifiedAggregate, offers, supplierMemberships, evaluatedAt } =
    input;

  const checks: CompetitiveSelectionCheck[] = [];

  // 1) The pool-level qualified-demand gate (the re-derived NET-W025
  //    qualification at the same anchor — unqualified, closed or
  //    withdrawn demand cannot enter competitive selection; never a
  //    caller-asserted flag).
  const qualified = qualifiedAggregate.qualified;
  checks.push({
    check: "pool_qualified",
    satisfied: qualified,
    detail: qualified
      ? { poolId: pool.id, poolDigest: qualifiedAggregate.digest }
      : {
          poolId: pool.id,
          reason: "pool_not_qualified",
        },
  });

  // 2) The per-offer hard-eligibility evaluation (server-derived at
  //    the anchor; offer facts only).
  const offerEvaluations: SupplierOfferEvaluation[] = offers.map((offer) => {
    const offerChecks: SupplierOfferCheck[] = [];

    const validitySatisfied = offerValidAtAnchor(offer, evaluatedAt);
    offerChecks.push({
      check: "offer_validity",
      satisfied: validitySatisfied,
      detail: validitySatisfied
        ? { offerId: offer.id }
        : {
            offerId: offer.id,
            reason:
              evaluatedAt < offer.validFrom
                ? "offer_not_yet_effective"
                : "offer_validity_expired",
          },
    });

    const regionSatisfied = regionServedByOffer(qualifiedAggregate, offer);
    offerChecks.push({
      check: "region_served",
      satisfied: regionSatisfied,
      detail: regionSatisfied
        ? { offerId: offer.id, region: offer.attributes.region }
        : {
            offerId: offer.id,
            region: offer.attributes.region,
            reason: qualified
              ? "region_not_in_named_demand"
              : "pool_not_qualified",
          },
    });

    const supplierMembership = supplierMemberships[offer.supplierPersonId] ??
      null;
    const supplierAuthorized = supplierMembership === "active";
    offerChecks.push({
      check: "supplier_authorized",
      satisfied: supplierAuthorized,
      detail: supplierAuthorized
        ? { offerId: offer.id }
        : {
            offerId: offer.id,
            reason:
              supplierMembership === null
                ? "supplier_not_a_member"
                : "supplier_membership_not_active",
          },
    });

    return Object.freeze({
      offerId: offer.id,
      supplierPersonId: offer.supplierPersonId,
      eligible: validitySatisfied && regionSatisfied && supplierAuthorized,
      checks: Object.freeze(offerChecks),
    });
  });

  // 3) The deterministic ranking over the ELIGIBLE offers only (hard
  //    eligibility PRECEDES ranking — the work order's authority
  //    order; an AI/model signal could only ever blend in AFTER this
  //    gate, advisory-only, which NET-W026 does not introduce).
  const eligibleOffers = offers.filter(
    (offer, index) => offerEvaluations[index]!.eligible,
  );
  const ranked = [...eligibleOffers].sort(compareOffers);
  const ranking: CompetitiveSelectionRankEntry[] = ranked.map((offer, index) =>
    Object.freeze({
      rank: index + 1,
      offerId: offer.id,
      supplierPersonId: offer.supplierPersonId,
      region: offer.attributes.region,
      unitPriceBand: offer.attributes.unitPriceBand,
      timingWindow: offer.attributes.timingWindow,
      quantityBucket: offer.attributes.quantityBucket,
    }),
  );
  const eligibleOfferIds = ranked.map((offer) => offer.id);
  const selectedOfferId = eligibleOfferIds[0] ?? null;

  // 4) The eligible-offer presence check (a null selection is a
  //    legitimate deterministic outcome when no offer is eligible).
  checks.push({
    check: "eligible_offers_present",
    satisfied: eligibleOffers.length > 0,
    detail:
      eligibleOffers.length > 0
        ? { poolId: pool.id, eligibleOfferCount: eligibleOffers.length }
        : { poolId: pool.id, reason: "no_eligible_offers" },
  });

  // The offer set (all ACTIVE offers, ascending id — the PROC-AC-03
  // offer-set record).
  const consideredOfferIds = offers.map((offer) => offer.id).sort();

  // 5) The deterministic digest over the canonical decision facts —
  // EXCLUDING the evaluation anchor (identical authoritative state ⇒
  // identical digest across evaluations; any governing-fact change ⇒
  // different digest). Reuses the /demand canonical digest helper.
  const digest = demandDigest({
    poolId: pool.id,
    organizationScopeId: pool.organizationScopeId,
    selectionPolicy: {
      version: SUPPLIER_OFFER_SELECTION_POLICY_VERSION,
      rankingCriteria: [...SUPPLIER_OFFER_RANKING_CRITERIA],
    },
    poolDigest: qualifiedAggregate.digest,
    qualified,
    checks: checks.map((check) => ({
      check: check.check,
      satisfied: check.satisfied,
    })),
    consideredOfferIds,
    eligibleOfferIds,
    offerEvaluations: offerEvaluations.map((evaluation) => ({
      offerId: evaluation.offerId,
      supplierPersonId: evaluation.supplierPersonId,
      eligible: evaluation.eligible,
      checks: evaluation.checks.map((check) => ({
        check: check.check,
        satisfied: check.satisfied,
      })),
    })),
    ranking,
    selectedOfferId,
  });

  return Object.freeze({
    poolId: pool.id,
    organizationScopeId: pool.organizationScopeId,
    selectionPolicy: Object.freeze({
      version: SUPPLIER_OFFER_SELECTION_POLICY_VERSION,
      rankingCriteria: Object.freeze([...SUPPLIER_OFFER_RANKING_CRITERIA]),
    }),
    poolDigest: qualifiedAggregate.digest,
    qualified,
    checks: Object.freeze(checks),
    offerEvaluations: Object.freeze(offerEvaluations),
    consideredOfferIds: Object.freeze(consideredOfferIds),
    eligibleOfferIds: Object.freeze(eligibleOfferIds),
    ranking: Object.freeze(ranking),
    selectedOfferId,
    digest,
    evaluatedAt,
  });
}
