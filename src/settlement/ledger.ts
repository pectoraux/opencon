/**
 * Deterministic ledger math — pure functions only (no I/O, no wall
 * clock), the accounting core of the /settlement domain (NET-W008
 * work order §3.2/§3.5).
 *
 * Every conservation guarantee in the economic engine is expressed
 * here as pure scaled-integer arithmetic over immutable entries:
 *
 *  1. Per-unit conservation (work order §4 invariant 3): a ledger
 *     transaction balances iff, for EVERY unit, Σdebit === Σcredit in
 *     integer minor units. `validatePostings` enforces this BEFORE
 *     anything is persisted.
 *  2. Non-negative balances: `normalSideBalance` computes an
 *     account's normal-side signed balance from its immutable entry
 *     set; the posting layer applies new entries to the existing
 *     balance and REJECTS any posting that would drive an account
 *     below zero (no value/credit destruction or creation outside
 *     authorized entries).
 *  3. Deterministic reward split (§3.5): floor-division in policy
 *     order with last-share remainder absorption, so Σ shares ===
 *     source EXACTLY.
 *
 * Mirrors the role of src/reputation/scoring.ts for the reputation
 * engine: the pure, testable heart of the domain.
 */

import {
  ECONOMIC_SCALE,
  economicAccountNormalSide,
  fromEconomicMinorUnits,
  toEconomicMinorUnits,
  type EconomicAccountKind,
  type EconomicEntryDirection,
  type EconomicLedgerTxKind,
  type EconomicUnitType,
} from "../core/economics.ts";
import { OpenConError } from "../core/errors.ts";
import type {
  EconomicLedgerEntry,
  EconomicPostingInput,
} from "./port.ts";

/** Stable error code for mechanical ledger violations. */
export const ECONOMIC_LEDGER_ERROR = "ECONOMIC_LEDGER_VALIDATION" as const;

/** A minimal entry shape both persisted entries and postings satisfy. */
interface EntryLike {
  readonly direction: EconomicEntryDirection;
  readonly amount: number;
  readonly unit: EconomicUnitType;
  readonly accountId: string;
  readonly accountKind: EconomicAccountKind;
}

/**
 * Validate that a set of postings balances per unit
 * (Σdebit === Σcredit for EVERY unit, in integer minor units).
 * Throws {@link OpenConError} with code ECONOMIC_LEDGER_VALIDATION on
 * any imbalance. Returns the postings unchanged.
 */
export function validatePostings(entries: readonly EntryLike[]): readonly EntryLike[] {
  if (entries.length === 0) {
    throw new OpenConError({
      code: ECONOMIC_LEDGER_ERROR,
      classification: "validation",
      message: "a ledger transaction requires at least one posting",
      context: {},
    });
  }
  const perUnit = new Map<EconomicUnitType, { debit: number; credit: number }>();
  for (const entry of entries) {
    if (!(entry.amount > 0) || !Number.isFinite(entry.amount)) {
      throw new OpenConError({
        code: ECONOMIC_LEDGER_ERROR,
        classification: "validation",
        message: `ledger postings must carry positive finite amounts (got ${String(entry.amount)} on account ${entry.accountId})`,
        context: { accountId: entry.accountId, amount: entry.amount },
      });
    }
    const bucket = perUnit.get(entry.unit) ?? { debit: 0, credit: 0 };
    const minor = toEconomicMinorUnits(entry.amount);
    if (entry.direction === "debit") bucket.debit += minor;
    else bucket.credit += minor;
    perUnit.set(entry.unit, bucket);
  }
  for (const [unit, bucket] of perUnit) {
    if (bucket.debit !== bucket.credit) {
      throw new OpenConError({
        code: ECONOMIC_LEDGER_ERROR,
        classification: "validation",
        message:
          `ledger transaction is not balanced for unit "${unit}": debits ${String(fromEconomicMinorUnits(bucket.debit))} ≠ credits ${String(fromEconomicMinorUnits(bucket.credit))} (conservation invariant — no value may be created or destroyed outside authorized entries)`,
        context: {
          unit,
          debit: fromEconomicMinorUnits(bucket.debit),
          credit: fromEconomicMinorUnits(bucket.credit),
        },
      });
    }
  }
  return entries;
}

/**
 * Compute an account's normal-side signed balance from its immutable
 * entry set. Credit-normal accounts (obligations) increase with
 * credit postings; debit-normal accounts (protocol recognition,
 * receivables) increase with debit postings. A balance of 0 means no
 * entries; negative balances are impossible through the posting layer
 * (enforced by applyPostings).
 */
export function normalSideBalance(
  accountKind: EconomicAccountKind,
  entries: readonly EconomicLedgerEntry[],
): number {
  let minor = 0;
  const normal = economicAccountNormalSide(accountKind);
  for (const entry of entries) {
    const amount = toEconomicMinorUnits(entry.amount);
    const isNormal = (entry.direction === "credit") === (normal === "credit");
    minor += isNormal ? amount : -amount;
  }
  return fromEconomicMinorUnits(minor);
}

/**
 * Apply new postings to an account's existing entries and assert the
 * post-balance stays ≥ 0 (the conservation guard: no posting may
 * overdraw ANY account — value/credits can only move through
 * authorized entries that the account actually holds).
 *
 * Throws {@link OpenConError} (ECONOMIC_LEDGER_VALIDATION,
 * classification "conflict") when the posting would overdraw.
 */
export function assertNonNegativeAfterPostings(
  accountKind: EconomicAccountKind,
  accountId: string,
  existing: readonly EconomicLedgerEntry[],
  postings: readonly EntryLike[],
): void {
  let minor = 0;
  const normal = economicAccountNormalSide(accountKind);
  for (const entry of existing) {
    const amount = toEconomicMinorUnits(entry.amount);
    const isNormal = (entry.direction === "credit") === (normal === "credit");
    minor += isNormal ? amount : -amount;
  }
  for (const posting of postings) {
    const amount = toEconomicMinorUnits(posting.amount);
    const isNormal = (posting.direction === "credit") === (normal === "credit");
    minor += isNormal ? amount : -amount;
  }
  if (minor < 0) {
    throw new OpenConError({
      code: ECONOMIC_LEDGER_ERROR,
      classification: "conflict",
      message:
        `ledger posting would overdraw account ${accountId} (${accountKind}): post-balance ${String(fromEconomicMinorUnits(minor))} < 0 — conservation rejects the mutation`,
      context: {
        accountId,
        accountKind,
        postBalance: fromEconomicMinorUnits(minor),
      },
    });
  }
}

/**
 * Negate a set of postings (append-only reversal): swap debit/credit
 * directions, preserve everything else. Generic over the entry shape
 * so full ledger entries (with denormalized owner/org fields) pass
 * through unchanged. Used by every reversal command so corrections
 * are mechanically exact inversions of the original authorized
 * entries.
 */
export function negatePostings<T extends EntryLike>(entries: readonly T[]): T[] {
  return entries.map((entry) => ({
    ...entry,
    direction: entry.direction === "debit" ? ("credit" as const) : ("debit" as const),
  }));
}

/**
 * The deterministic account key: a stable composite identity for
 * (organizationScopeId, owner, kind, unit). Deterministic keys make
 * account provisioning idempotent — a tenant can never accumulate
 * duplicate accounts for the same role, and every balance/lineage
 * query reconstructs from the key alone (reconstructability, AC-01).
 */
export function economicAccountId(
  organizationScopeId: string,
  ownerPersonId: string | null,
  kind: EconomicAccountKind,
  unit: EconomicUnitType,
): string {
  const owner = ownerPersonId ?? "system";
  return `${organizationScopeId}|${owner}|${kind}|${unit}`;
}

/** Deterministic ledger-transaction kind for an economic reversal. */
export function reversalTxKind(
  originalKind: EconomicLedgerTxKind,
): EconomicLedgerTxKind {
  return "reversal";
}

/**
 * The deterministic reward split (work order §3.5). Given a source
 * amount and an ordered allocation set (beneficiary + weight, weights
 * > 0), computes each beneficiary's amount with scaled-integer floor
 * division; the LAST allocation absorbs the rounding remainder so the
 * shares sum to the source amount EXACTLY (conservation — no dust,
 * no value creation or destruction).
 *
 * Throws ECONOMIC_LEDGER_VALIDATION when a computed share (including
 * the remainder-absorbing last share) is ≤ 0.
 */
export function computeRewardSplit(
  sourceAmount: number,
  allocations: readonly {
    readonly beneficiaryPersonId: string;
    readonly weight: number;
  }[],
): readonly { beneficiaryPersonId: string; amount: number }[] {
  if (allocations.length === 0) {
    throw new OpenConError({
      code: ECONOMIC_LEDGER_ERROR,
      classification: "validation",
      message: "reward allocation requires at least one allocation entry",
      context: {},
    });
  }
  const sourceMinor = toEconomicMinorUnits(sourceAmount);
  const weights = allocations.map((a) => {
    const w = toEconomicMinorUnits(a.weight);
    if (!(w > 0)) {
      throw new OpenConError({
        code: ECONOMIC_LEDGER_ERROR,
        classification: "validation",
        message: `reward allocation weight must be > 0 with ≤ 6 decimals (got ${String(a.weight)} for ${a.beneficiaryPersonId})`,
        context: { beneficiaryPersonId: a.beneficiaryPersonId, weight: a.weight },
      });
    }
    return w;
  });
  const totalWeight = weights.reduce((sum, w) => sum + w, 0);
  const shares: { beneficiaryPersonId: string; amount: number }[] = [];
  let allocated = 0;
  for (let i = 0; i < allocations.length; i++) {
    const allocation = allocations[i]!;
    let shareMinor: number;
    if (i === allocations.length - 1) {
      // The last share absorbs the rounding remainder so Σ === source.
      shareMinor = sourceMinor - allocated;
    } else {
      shareMinor = Math.floor((sourceMinor * weights[i]!) / totalWeight);
    }
    if (shareMinor <= 0) {
      throw new OpenConError({
        code: ECONOMIC_LEDGER_ERROR,
        classification: "validation",
        message:
          `deterministic reward split produced a non-positive share for beneficiary ${allocation.beneficiaryPersonId} (source ${String(sourceAmount)}, weight ${String(allocation.weight)}) — the policy is too fine for this source amount`,
        context: {
          beneficiaryPersonId: allocation.beneficiaryPersonId,
          sourceAmount,
          weight: allocation.weight,
        },
      });
    }
    allocated += shareMinor;
    shares.push({
      beneficiaryPersonId: allocation.beneficiaryPersonId,
      amount: fromEconomicMinorUnits(shareMinor),
    });
  }
  if (allocated !== sourceMinor) {
    // Mechanically impossible (last-share absorption); keep the guard.
    throw new OpenConError({
      code: ECONOMIC_LEDGER_ERROR,
      classification: "invariant",
      message: `deterministic reward split does not conserve the source amount (${String(fromEconomicMinorUnits(allocated))} ≠ ${String(sourceAmount)})`,
      context: { allocated: fromEconomicMinorUnits(allocated), sourceAmount },
    });
  }
  return shares;
}

/**
 * Global conservation audit (used by tests + the ledger service):
 * Σdebit === Σcredit per unit over an arbitrary entry set.
 */
export function assertGlobalConservation(
  entries: readonly EconomicLedgerEntry[],
): void {
  const perUnit = new Map<string, { debit: number; credit: number }>();
  for (const entry of entries) {
    const bucket = perUnit.get(entry.unit) ?? { debit: 0, credit: 0 };
    const minor = toEconomicMinorUnits(entry.amount);
    if (entry.direction === "debit") bucket.debit += minor;
    else bucket.credit += minor;
    perUnit.set(entry.unit, bucket);
  }
  for (const [unit, bucket] of perUnit) {
    if (bucket.debit !== bucket.credit) {
      throw new OpenConError({
        code: ECONOMIC_LEDGER_ERROR,
        classification: "invariant",
        message: `global conservation violated for unit "${unit}": Σdebit ${String(bucket.debit)} ≠ Σcredit ${String(bucket.credit)}`,
        context: { unit, debit: bucket.debit, credit: bucket.credit },
      });
    }
  }
}

/** Scale helper re-export for services (single arithmetic source). */
export { ECONOMIC_SCALE, toEconomicMinorUnits, fromEconomicMinorUnits };

export type { EconomicPostingInput };
