/**
 * NET-W028 benefit-allocation engine — PURE deterministic derivation
 * (no I/O, no wall clock inside the pure helpers, no mutation).
 *
 * Architecture ref: spec/architecture.md §18 (/benefits owns benefit
 * allocation), §13 (measurement architecture — deterministic,
 * reproducible derivations); spec/architecture-lock.md §5 (economic
 * authority — the ARITHMETIC here plans allocations; the POSTINGS
 * stay exclusively in /settlement), §13 (economic safety).
 *
 * Work order ref: spec/work-orders/NET-W028.md §3.3/§3.5/§3.7.
 * Requirements: BEN-003 (allocation by defined eligibility policies),
 * BEN-004 (measurable value delivered to members).
 *
 * THE DETERMINISM CONTRACT (issue #56 key invariant 3 / work order
 * §3.5 — conservation):
 *  - ALL arithmetic runs on scaled integer minor units (the
 *    core/economics ECONOMIC_SCALE discipline) — floating-point
 *    drift can never break a conservation check;
 *  - shares are computed by floor-division of the amount × weight in
 *    member DECLARATION order;
 *  - `last_member_absorbs`: the LAST member's share absorbs the
 *    rounding remainder so Σ shares === amount EXACTLY (the IDENTICAL
 *    semantics as the /settlement deterministic reward split —
 *    required for economic draws so the benefits plan and the
 *    settlement draw result are always equal);
 *  - `retained_in_pool`: every share is floored and the remainder is
 *    EXPLICITLY computed and returned — the caller records it on the
 *    allocation lineage and it stays inside the pool's available
 *    funding envelope (conserved, never lost, never silently
 *    redistributed);
 *  - the digest excludes the evaluation/allocation anchor (identical
 *    authoritative state ⇒ identical digest — the W021/W024/W025/
 *    W026/W027 decision-digest precedent).
 */

import { createHash } from "node:crypto";
import {
  fromEconomicMinorUnits,
  toEconomicMinorUnits,
} from "../core/economics.ts";
import { InvalidBenefitPoolError } from "./port.ts";
import type { BenefitRemainderDisposition } from "./port.ts";

/** The share-plan member order source (declaration order is canonical). */
export interface BenefitPlanMember {
  readonly personId: string;
  readonly weight: number;
}

/** The computed deterministic plan. */
export interface BenefitAllocationPlan {
  readonly shares: readonly {
    readonly personId: string;
    readonly amount: number;
    readonly weight: number;
  }[];
  readonly totalAllocated: number;
  /** The EXPLICIT remainder (0 for last_member_absorbs). */
  readonly remainderAmount: number;
  readonly remainderDisposition: BenefitRemainderDisposition;
}

/**
 * Compute the deterministic benefit-allocation plan (pure). Throws
 * InvalidBenefitPoolError when the members set is empty, a weight is
 * not a positive ≤ 6-decimal number, the amount is not a positive ≤
 * 6-decimal number, or a computed share (including the
 * remainder-absorbing last share) is ≤ 0.
 */
export function computeBenefitAllocationPlan(
  amount: number,
  members: readonly BenefitPlanMember[],
  remainderDisposition: BenefitRemainderDisposition,
): BenefitAllocationPlan {
  if (members.length === 0) {
    throw new InvalidBenefitPoolError(
      "a benefit allocation requires at least one eligible member",
      { memberCount: 0 },
    );
  }
  const amountMinor = toEconomicMinorUnits(amount);
  if (!(amountMinor > 0)) {
    throw new InvalidBenefitPoolError(
      `the allocation amount must be a positive number with ≤ 6 decimals (got ${String(amount)})`,
      { amount },
    );
  }
  const weights = members.map((member) => {
    const weightMinor = toEconomicMinorUnits(member.weight);
    if (!(weightMinor > 0)) {
      throw new InvalidBenefitPoolError(
        `member ${member.personId} weight must be > 0 with ≤ 6 decimals (got ${String(member.weight)})`,
        { personId: member.personId, weight: member.weight },
      );
    }
    return weightMinor;
  });
  const totalWeight = weights.reduce((sum, w) => sum + w, 0);
  const shares: {
    personId: string;
    amount: number;
    weight: number;
  }[] = [];
  let allocated = 0;
  for (let i = 0; i < members.length; i++) {
    const member = members[i]!;
    let shareMinor: number;
    if (remainderDisposition === "last_member_absorbs" && i === members.length - 1) {
      // The last share absorbs the rounding remainder so Σ === amount
      // EXACTLY (the /settlement deterministic reward-split semantics).
      shareMinor = amountMinor - allocated;
    } else {
      shareMinor = Math.floor((amountMinor * weights[i]!) / totalWeight);
    }
    if (shareMinor <= 0) {
      throw new InvalidBenefitPoolError(
        `the deterministic benefit split produced a non-positive share for member ${member.personId} (amount ${String(amount)}, weight ${String(member.weight)}) — the member set is too fine for this amount`,
        { personId: member.personId, amount, weight: member.weight },
      );
    }
    allocated += shareMinor;
    shares.push({
      personId: member.personId,
      amount: fromEconomicMinorUnits(shareMinor),
      weight: member.weight,
    });
  }
  const remainderMinor = amountMinor - allocated;
  if (remainderMinor < 0) {
    // Mechanically impossible (floor + last-absorb); keep the guard.
    throw new InvalidBenefitPoolError(
      `the deterministic benefit split does not conserve the allocation amount (${String(fromEconomicMinorUnits(allocated))} allocated of ${String(amount)})`,
      { allocated: fromEconomicMinorUnits(allocated), amount },
    );
  }
  return {
    shares,
    totalAllocated: fromEconomicMinorUnits(allocated),
    remainderAmount: fromEconomicMinorUnits(remainderMinor),
    remainderDisposition,
  };
}

/**
 * Deterministically compute the allocation digest over the CANONICAL
 * decision facts (policy lineage + funding resolutions + eligible
 * members + plan + conservation facts) — EXCLUDING the anchor. The
 * canonical serialization is field-ordered JSON with sorted member
 * order preserved as declaration order (identical authoritative state
 * ⇒ identical digest; the W027 decision-digest precedent).
 */
export function computeBenefitAllocationDigest(input: {
  readonly poolId: string;
  readonly organizationScopeId: string;
  readonly policyId: string;
  readonly policyVersion: number;
  readonly benefitType: string;
  readonly funding: readonly {
    readonly kind: string;
    readonly id: string;
    readonly resolvedAmount: number | null;
  }[];
  readonly members: readonly {
    readonly personId: string;
    readonly weight: number;
  }[];
  readonly plan: {
    readonly shares: readonly {
      readonly personId: string;
      readonly amount: number;
      readonly weight: number;
    }[];
    readonly totalAllocated: number;
    readonly remainderAmount: number;
    readonly remainderDisposition: string;
  } | null;
  readonly availableFunding: number;
  readonly priorAllocatedTotal: number;
}): string {
  const canonical = JSON.stringify({
    poolId: input.poolId,
    organizationScopeId: input.organizationScopeId,
    policyId: input.policyId,
    policyVersion: input.policyVersion,
    benefitType: input.benefitType,
    funding: input.funding.map((ref) => ({
      kind: ref.kind,
      id: ref.id,
      resolvedAmount: ref.resolvedAmount,
    })),
    members: input.members.map((member) => ({
      personId: member.personId,
      weight: member.weight,
    })),
    plan:
      input.plan === null
        ? null
        : {
            shares: input.plan.shares.map((share) => ({
              personId: share.personId,
              amount: share.amount,
              weight: share.weight,
            })),
            totalAllocated: input.plan.totalAllocated,
            remainderAmount: input.plan.remainderAmount,
            remainderDisposition: input.plan.remainderDisposition,
          },
    availableFunding: input.availableFunding,
    priorAllocatedTotal: input.priorAllocatedTotal,
  });
  return createHash("sha256").update(canonical).digest("hex");
}
