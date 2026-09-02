/**
 * Shared economic vocabulary (core contracts).
 *
 * Architecture ref: spec/architecture.md §4 (Participation Credit: an
 * earned utility/accounting unit representing verified participation
 * value — distinct from cash), §5 (economic model), §17 (authoritative
 * workflow — the ledger consumes VERIFIED upstream records), §18
 * (module ownership: /settlement owns credits, pending/mature value,
 * cash/credit settlement), §19 (PostgreSQL authoritative; AI/model
 * output never sufficient by itself); spec/architecture-lock.md §1
 * (core invariants 3/4/7: no economically material reward from raw
 * activity alone; evidence is authoritative for settlement;
 * Participation Credits are distinct from cash settlement and are not
 * inherently speculative assets), §5 (economic authority: the economic
 * engine owns Credits, pending value, matured value, reward
 * calculations and settlement records; credit issuance must reference
 * verified value), §13 (economic safety invariants 19–21), §14
 * (invariant 25: payment adapters provide transaction facts;
 * /settlement retains semantic authority).
 *
 * Work order ref: spec/work-orders/NET-W008.md §3.1.
 * Requirements: ECON-001..005 (credits as earned accounting units; no
 * raw-activity minting; issuance tied to verified value; cash/pending/
 * mature/credits/reputation separation; no speculative-asset
 * semantics), SETTLE-001..003, AUD-003.
 *
 * The `/settlement` domain implements the behaviour; the vocabulary is
 * shared so infrastructure (API) and later work items consume the same
 * frozen terms. This module is data + pure validation ONLY — no I/O,
 * no wall clock, no posting behaviour (the deterministic ledger math
 * lives in /settlement/ledger.ts).
 */

import { OpenConError } from "./errors.ts";

/**
 * The frozen economic unit vocabulary (ECON-004). Pending value,
 * mature value and rewards are accounted in the internal `value` unit;
 * Participation Credits in `credits`; cash obligations/receivables in
 * `cash`. The three concepts are structurally distinct: an amount
 * always carries exactly one unit, and every ledger transaction
 * balances per unit, so value can never silently become credits or
 * cash (architecture-lock invariant 7).
 */
export const ECONOMIC_UNIT_TYPES = ["value", "credits", "cash"] as const;

export type EconomicUnitType = (typeof ECONOMIC_UNIT_TYPES)[number];

export function isEconomicUnitType(value: string): value is EconomicUnitType {
  return (ECONOMIC_UNIT_TYPES as readonly string[]).includes(value);
}

/**
 * The upstream record kinds that may back an economic value record
 * (work order §3.3 — the economic input gate). Every pending value
 * record MUST reference at least one of these, and each reference must
 * resolve to a QUALIFYING VERIFIED record:
 *  - `proof_of_value` — a Proof-of-Value in state VERIFIED (the
 *    settlement-claim precursor; REQUIRED for credit issuance,
 *    architecture-lock invariant 20);
 *  - `measured_outcome` — a measured outcome in state VERIFIED
 *    (finalized measurement — NET-W006);
 *  - `evidence` — an evidence record from a platform/attested/provider
 *    source (see QUALIFYING_ECONOMIC_EVIDENCE_SOURCE_TYPES);
 *  - `contribution` — a helpful contribution in lifecycle state
 *    VERIFIED (NET-W014 AMENDMENT — the reward-integration layer
 *    consumes the verified-usefulness claim as a first-class economic
 *    source; resolved through the settlement boundary's neutral
 *    EconomicContributionLookup with the SAME qualifying bar: same
 *    organization scope + VERIFIED. Including the contribution in the
 *    value record's sources means the EXISTING dispute/risk gates —
 *    which check source ids at the composition root — automatically
 *    cover contribution-level disputes and controls).
 *
 * There is deliberately NO source kind for spend, wealth, deposits,
 * raw activity volume, reputation records or model output: a bare
 * economic assertion cannot enter the system (ECON-002, architecture-
 * lock §1.3/§1.4 — the gate is structural, exactly like the reputation
 * input gate in NET-W007).
 */
export const ECONOMIC_VALUE_SOURCES = [
  "proof_of_value",
  "measured_outcome",
  "evidence",
  // NET-W014 AMENDMENT (the RISK_SIGNAL_CATEGORIES additive precedent):
  // the verified helpful contribution as a first-class economic source.
  "contribution",
] as const;

export type EconomicValueSourceKind =
  (typeof ECONOMIC_VALUE_SOURCES)[number];

export function isEconomicValueSourceKind(
  value: string,
): value is EconomicValueSourceKind {
  return (ECONOMIC_VALUE_SOURCES as readonly string[]).includes(value);
}

/**
 * The evidence source types that qualify as verified-grade economic
 * inputs. `model` and `self` evidence NEVER qualify — model output is
 * input evidence, never authoritative for settlement
 * (architecture-lock §4). This mirrors the reputation engine's
 * VERIFIED_GRADE_EVIDENCE_SOURCE_TYPES rule over the evidence domain's
 * own source-type vocabulary; the two gates are intentionally separate
 * constants so each domain's qualifying set is frozen independently.
 */
export const QUALIFYING_ECONOMIC_EVIDENCE_SOURCE_TYPES = [
  "platform",
  "attested",
  "provider",
] as const;

/**
 * The lifecycle states of an economic value record (work order §3.3).
 *
 *  - `PENDING` — recognized from verified sources; visible as pending
 *    accounting state ONLY (architecture-lock invariant 19: pending
 *    value is not equivalent to mature value and cannot be consumed).
 *  - `MATURE` — passed the explicit maturation gate; consumable by
 *    credit issuance or reward allocation.
 *  - `CONSUMED` — terminal for consumption: consumed exactly once by
 *    a credit issuance or a reward allocation.
 *  - `REVERSED` — append-only correction: the record's postings were
 *    negated by an explicit reversal; it can never mature or be
 *    consumed afterwards.
 */
export const ECONOMIC_VALUE_STATES = [
  "PENDING",
  "MATURE",
  "CONSUMED",
  "REVERSED",
] as const;

export type EconomicValueState = (typeof ECONOMIC_VALUE_STATES)[number];

export function isEconomicValueState(value: string): value is EconomicValueState {
  return (ECONOMIC_VALUE_STATES as readonly string[]).includes(value);
}

/**
 * Maturation strategies for pending value (SETTLE-002 settlement
 * windows).
 *  - `immediate` — maturation is legal as soon as the record is
 *    PENDING (the explicit command + audit trail IS the gate).
 *  - `fixed_window` — maturation is legal only once the explicit
 *    `effectiveAt` reference timestamp is at or after the policy's
 *    `windowEndAt` (delayed settlement/finality windows — OUT-005
 *    semantics carried into the economic layer; no wall clock).
 */
export const ECONOMIC_MATURATION_STRATEGIES = [
  "immediate",
  "fixed_window",
] as const;

export type EconomicMaturationStrategy =
  (typeof ECONOMIC_MATURATION_STRATEGIES)[number];

export function isEconomicMaturationStrategy(
  value: string,
): value is EconomicMaturationStrategy {
  return (ECONOMIC_MATURATION_STRATEGIES as readonly string[]).includes(value);
}

/**
 * The maturation policy attached to a pending value record at
 * recognition time. For `fixed_window`, `windowEndAt` is REQUIRED.
 */
export interface EconomicMaturationPolicy {
  readonly strategy: EconomicMaturationStrategy;
  /** Present iff strategy is `fixed_window`. */
  readonly windowEndAt?: string;
}

/**
 * The frozen ledger account vocabulary. Person-owned accounts are the
 * protocol's obligations to (or claims on) a participant; the
 * `protocol_recognition` system account (owner = null) is the contra
 * account against which value is recognized, credits are minted and
 * cash obligations are booked — it keeps every transaction balanced
 * per unit.
 *
 * NET-W010 (additive, non-breaking): `stake_escrow` is the
 * person-owned, credit-normal encumbrance account for challenge
 * participation stakes — committing a stake debits the person's
 * `credits` and credits their `stake_escrow` (the amount stays
 * visible as the participant's locked commitment; releasing moves it
 * back; forfeiting moves it to `protocol_recognition(credits)`). The
 * /settlement StakeService owns every posting; the /disputes domain
 * only records intent and outcome references.
 */
export const ECONOMIC_ACCOUNT_KINDS = [
  "pending_value",
  "mature_value",
  "credits",
  "rewards",
  "cash_payable",
  "cash_receivable",
  "protocol_recognition",
  "stake_escrow",
] as const;

export type EconomicAccountKind = (typeof ECONOMIC_ACCOUNT_KINDS)[number];

export function isEconomicAccountKind(value: string): value is EconomicAccountKind {
  return (ECONOMIC_ACCOUNT_KINDS as readonly string[]).includes(value);
}

/**
 * The normal balance side of an account kind. Credit-normal accounts
 * (the protocol's obligations: pending/mature value, credits, rewards,
 * cash payables) increase with CREDIT postings; debit-normal accounts
 * (protocol recognition, cash receivables) increase with DEBIT
 * postings. The posting layer uses this to enforce the post-balance
 * ≥ 0 conservation invariant on every account.
 */
export function economicAccountNormalSide(
  kind: EconomicAccountKind,
): "debit" | "credit" {
  switch (kind) {
    case "protocol_recognition":
    case "cash_receivable":
      return "debit";
    case "pending_value":
    case "mature_value":
    case "credits":
    case "rewards":
    case "cash_payable":
    case "stake_escrow":
      return "credit";
  }
}

/**
 * The unit every account kind is denominated in. Pending/mature value
 * and rewards are accounted in the internal `value` unit (a reward is
 * an entitlement to source value, not a credit — converting it to
 * credits/cash is a later explicit ledger operation); credits accounts
 * are `credits`; cash accounts are `cash`; the protocol_recognition
 * contra account exists per unit (it bridges value→credits conversions
 * and books cash obligations).
 */
export function economicAccountUnit(kind: EconomicAccountKind): EconomicUnitType {
  switch (kind) {
    case "pending_value":
    case "mature_value":
    case "rewards":
      return "value";
    case "credits":
    case "stake_escrow":
      return "credits";
    case "cash_payable":
    case "cash_receivable":
      return "cash";
    case "protocol_recognition":
      return "value"; // overridden per-unit at the call site
  }
}

/** Posting directions in the double-entry ledger. */
export const ECONOMIC_ENTRY_DIRECTIONS = ["debit", "credit"] as const;

export type EconomicEntryDirection = (typeof ECONOMIC_ENTRY_DIRECTIONS)[number];

export function isEconomicEntryDirection(
  value: string,
): value is EconomicEntryDirection {
  return (ECONOMIC_ENTRY_DIRECTIONS as readonly string[]).includes(value);
}

/**
 * The kinds of ledger transaction (each maps to exactly one authorized
 * economic command — value/credits never move outside these).
 *
 * NET-W010 (additive, non-breaking): the three stake commands —
 * `stake_commit` (encumber credits into the owner's stake escrow),
 * `stake_release` (return the escrow to the owner's credits) and
 * `stake_forfeit` (move the escrow to protocol recognition — the
 * unsuccessful-challenge penalty). Each balances per unit like every
 * other kind; the /disputes domain can never post these directly.
 */
export const ECONOMIC_LEDGER_TX_KINDS = [
  "value_recognition",
  "maturation",
  "reversal",
  "credit_issuance",
  "reward_allocation",
  "cash_accounting",
  "conversion",
  "settlement",
  "stake_commit",
  "stake_release",
  "stake_forfeit",
] as const;

export type EconomicLedgerTxKind = (typeof ECONOMIC_LEDGER_TX_KINDS)[number];

export function isEconomicLedgerTxKind(
  value: string,
): value is EconomicLedgerTxKind {
  return (ECONOMIC_LEDGER_TX_KINDS as readonly string[]).includes(value);
}

/** Cash obligation kinds (work order §3.6). */
export const ECONOMIC_CASH_KINDS = ["payable", "receivable"] as const;

/**
 * The stake-record lifecycle states (NET-W010 §3.2). A stake is
 * `COMMITTED` while it encumbers the owner's credits in escrow;
 * `RELEASED` (returned to the owner) and `FORFEITED` (moved to
 * protocol recognition) are terminal and append-only — the outcome
 * lineage (reason + transaction) is carried on the record, never a
 * destructive rewrite.
 */
export const ECONOMIC_STAKE_STATES = [
  "COMMITTED",
  "RELEASED",
  "FORFEITED",
] as const;

export type EconomicStakeState = (typeof ECONOMIC_STAKE_STATES)[number];

export function isEconomicStakeState(value: string): value is EconomicStakeState {
  return (ECONOMIC_STAKE_STATES as readonly string[]).includes(value);
}

/**
 * The purposes a stake may be committed for. NET-W010 shipped
 * `dispute_challenge` (challenge/appeal participation). NET-W011 adds
 * `campaign_budget` (additive, non-breaking): a campaign's declared
 * budget is ESCROWED through the settlement authority's stake
 * commands before the campaign may activate — the campaign domain
 * only records the references (no hidden ledger; the /campaigns
 * boundary carries no economic-unit mutation methods). The purpose
 * is the linkage each boundary verifies against its own records.
 * NET-W032 adds `validation_assignment` (additive, non-breaking): a
 * validator's per-round eligibility bond — committed through the
 * settlement authority at the composition root with the purpose id
 * `{challengeId}:{validatorPersonId}` (one bonded validator per
 * assignment slot); the /disputes domain only VERIFIES the linkage
 * when bonding and RECORDS the disposition the settlement authority
 * executed after a terminal closure.
 */
export const ECONOMIC_STAKE_PURPOSE_KINDS = [
  "campaign_budget",
  "dispute_challenge",
  "validation_assignment",
] as const;

export type EconomicStakePurposeKind = (typeof ECONOMIC_STAKE_PURPOSE_KINDS)[number];

export function isEconomicStakePurposeKind(
  value: string,
): value is EconomicStakePurposeKind {
  return (ECONOMIC_STAKE_PURPOSE_KINDS as readonly string[]).includes(value);
}

export type EconomicCashKind = (typeof ECONOMIC_CASH_KINDS)[number];

export function isEconomicCashKind(value: string): value is EconomicCashKind {
  return (ECONOMIC_CASH_KINDS as readonly string[]).includes(value);
}

/** Conversion directions between cash obligations and credits. */
export const ECONOMIC_CONVERSION_DIRECTIONS = [
  "cash_to_credits",
  "credits_to_cash",
] as const;

export type EconomicConversionDirection =
  (typeof ECONOMIC_CONVERSION_DIRECTIONS)[number];

export function isEconomicConversionDirection(
  value: string,
): value is EconomicConversionDirection {
  return (ECONOMIC_CONVERSION_DIRECTIONS as readonly string[]).includes(value);
}

/**
 * Deterministic decimal precision for economic amounts. Amounts are
 * validated to at most 6 decimals and all conservation arithmetic runs
 * on scaled integers (amount × 10^6), so floating-point drift can
 * never break a balance check.
 */
export const ECONOMIC_DECIMALS = 6;

/** The scale factor: amounts are compared as integer minor units. */
export const ECONOMIC_SCALE = 1_000_000;

/** Sanity cap on any single economic amount (scaled: 10^12 major units). */
export const ECONOMIC_MAX_AMOUNT = 1_000_000_000_000;

/**
 * Scale a validated amount to integer minor units. The input MUST
 * already be validated (finite, > 0, ≤ 6 decimals); Math.round removes
 * any residual floating-point representation noise deterministically
 * (the same approach the reputation engine uses for score rounding).
 */
export function toEconomicMinorUnits(amount: number): number {
  return Math.round(amount * ECONOMIC_SCALE);
}

/** Convert integer minor units back to a display amount. */
export function fromEconomicMinorUnits(minor: number): number {
  return minor / ECONOMIC_SCALE;
}

/**
 * Validate an economic amount (pure). Throws {@link OpenConError} with
 * the stable code `ECONOMIC_VALIDATION` unless the amount is a finite
 * number > 0 with at most {@link ECONOMIC_DECIMALS} decimals and not
 * larger than {@link ECONOMIC_MAX_AMOUNT}.
 */
export function validateEconomicAmount(
  field: string,
  amount: number,
): number {
  if (typeof amount !== "number" || !Number.isFinite(amount)) {
    throw new OpenConError({
      code: "ECONOMIC_VALIDATION",
      classification: "validation",
      message: `economic amount field ${field} must be a finite number (got ${String(amount)})`,
      context: { field, amount },
    });
  }
  if (amount <= 0) {
    throw new OpenConError({
      code: "ECONOMIC_VALIDATION",
      classification: "validation",
      message: `economic amount field ${field} must be > 0 (got ${String(amount)})`,
      context: { field, amount },
    });
  }
  if (amount > ECONOMIC_MAX_AMOUNT) {
    throw new OpenConError({
      code: "ECONOMIC_VALIDATION",
      classification: "validation",
      message: `economic amount field ${field} exceeds the maximum representable amount ${String(ECONOMIC_MAX_AMOUNT)} (got ${String(amount)})`,
      context: { field, amount },
    });
  }
  const minor = toEconomicMinorUnits(amount);
  if (Math.abs(minor / ECONOMIC_SCALE - amount) > 1e-9 || minor <= 0) {
    throw new OpenConError({
      code: "ECONOMIC_VALIDATION",
      classification: "validation",
      message: `economic amount field ${field} must carry at most ${String(ECONOMIC_DECIMALS)} decimals (got ${String(amount)})`,
      context: { field, amount },
    });
  }
  return amount;
}

/**
 * Deterministically compute the credit amount issued for a source
 * value amount at an explicit rate (credits per value unit). Pure
 * scaled-integer arithmetic: creditsMinor = round(sourceMinor × rate),
 * so the result is reproducible and never drifts. Throws
 * `ECONOMIC_VALIDATION` if the rate is not a finite positive number
 * with at most 6 decimals, or the product rounds to zero minor units.
 */
export function computeCreditAmount(
  sourceAmount: number,
  creditsPerValueUnit: number,
): number {
  if (
    typeof creditsPerValueUnit !== "number" ||
    !Number.isFinite(creditsPerValueUnit) ||
    creditsPerValueUnit <= 0
  ) {
    throw new OpenConError({
      code: "ECONOMIC_VALIDATION",
      classification: "validation",
      message: `creditsPerValueUnit must be a finite number > 0 (got ${String(creditsPerValueUnit)})`,
      context: { creditsPerValueUnit },
    });
  }
  const rateMinor = toEconomicMinorUnits(creditsPerValueUnit);
  if (rateMinor <= 0) {
    throw new OpenConError({
      code: "ECONOMIC_VALIDATION",
      classification: "validation",
      message: `creditsPerValueUnit must carry at most ${String(ECONOMIC_DECIMALS)} decimals (got ${String(creditsPerValueUnit)})`,
      context: { creditsPerValueUnit },
    });
  }
  const sourceMinor = toEconomicMinorUnits(sourceAmount);
  const creditsMinor = Math.round((sourceMinor * rateMinor) / ECONOMIC_SCALE);
  if (creditsMinor <= 0) {
    throw new OpenConError({
      code: "ECONOMIC_VALIDATION",
      classification: "validation",
      message:
        `the computed credit amount rounds to zero (source ${String(sourceAmount)} at rate ${String(creditsPerValueUnit)}) — the issuance would create no credits`,
      context: { sourceAmount, creditsPerValueUnit },
    });
  }
  return fromEconomicMinorUnits(creditsMinor);
}

/**
 * Validate a maturation policy (pure). `fixed_window` REQUIRES a valid
 * ISO-8601 `windowEndAt`.
 */
export function validateEconomicMaturationPolicy(
  policy: EconomicMaturationPolicy,
): EconomicMaturationPolicy {
  if (!isEconomicMaturationStrategy(policy.strategy)) {
    throw new OpenConError({
      code: "ECONOMIC_VALIDATION",
      classification: "validation",
      message: `maturation strategy must be one of immediate | fixed_window (got ${String(policy.strategy)})`,
      context: { strategy: policy.strategy },
    });
  }
  if (policy.strategy === "fixed_window") {
    if (!policy.windowEndAt || Number.isNaN(Date.parse(policy.windowEndAt))) {
      throw new OpenConError({
        code: "ECONOMIC_VALIDATION",
        classification: "validation",
        message: `fixed_window maturation requires a valid ISO-8601 windowEndAt (got ${String(policy.windowEndAt)})`,
        context: { windowEndAt: policy.windowEndAt },
      });
    }
  }
  return policy;
}

export { OpenConError };
