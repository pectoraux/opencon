/**
 * External-settlement canonical inputs — NET-W030 (issue #61).
 *
 * PURE + DETERMINISTIC helpers for the external settlement fact
 * layer: the canonical submission facts (the EXACT set the provider
 * trust envelope attests), submission validation against the closed
 * vocabularies, and the reconciliation derivation inputs. This file
 * EXTENDS the /settlement boundary additively (the W029
 * signed-attestation-input.ts discipline): the port stays the
 * declared-contract surface; pure helpers live beside it.
 *
 * Canonical facts (deterministic; built identically at signing and at
 * verification — the same facts string is HMAC-attested by the
 * trusted provider channel and re-derived by the composition root's
 * authenticator):
 *
 * ```text
 * external-settlement/v1
 * provider:                <provider>
 * external-id:             <externalId>
 * internal-transaction:    <internalTransactionId>
 * reported-amount:         <reportedAmount>
 * reported-unit:           <reportedUnit>
 * observed-at:             <observedAt>
 * correction-of:           <correctionOf | null>
 * ```
 *
 * The organization scope is DELIBERATELY NOT part of the attested
 * facts: it is the ingesting tenant's request parameter (validated
 * server-side), not provider-attested material. The ledger-lineage
 * amount comparison happens server-side against the AUTHORITATIVE
 * entries of the referenced internal transaction — the reported
 * amount is a fact, never authority (work order §3.4).
 *
 * Privacy (PRIV-002): no secret, no signature value and no raw
 * payload content ever enters logs, audit events, or error contexts —
 * validation failures carry machine-readable reasons plus bounded
 * identifiers only.
 *
 * Tier compliance: settlement domain → self + core contracts only.
 */

import { isEconomicUnitType, type EconomicUnitType } from "../core/economics.ts";
import type { EconomicLedgerTransaction } from "./port.ts";
import {
  EXTERNAL_SETTLEMENT_MAX_AGE_MS,
  isExternalSettlementIntegrityAlgorithm,
  isExternalSettlementProvider,
  type ExternalSettlementIntegrityBlock,
  type ExternalSettlementRejectionReason,
  type ExternalSettlementTransactionFacts,
} from "./port.ts";

/**
 * Deterministic JSON serialization: object keys sorted recursively,
 * `undefined` values dropped, no insignificant whitespace (the same
 * discipline as the W029 canonical inputs — identical content always
 * serializes identically).
 */
export function canonicalJson(value: unknown): string {
  if (
    value === null ||
    typeof value === "number" ||
    typeof value === "boolean" ||
    typeof value === "string"
  ) {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalJson(item)).join(",")}]`;
  }
  if (typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`);
    return `{${entries.join(",")}}`;
  }
  return JSON.stringify(String(value));
}

/** The exact attested facts a provider trust envelope covers. */
export interface ExternalSettlementAttestedFacts {
  readonly provider: string;
  readonly externalId: string;
  readonly internalTransactionId: string;
  readonly reportedAmount: number;
  readonly reportedUnit: string;
  readonly observedAt: string;
  readonly correctionOf: string | null;
}

/**
 * The canonical attested-facts object of ONE submission (the signing
 * payload). Pure function of the submission's substantive content —
 * field order, envelope metadata and the caller's idempotency key
 * never participate.
 */
export function externalSettlementAttestedFacts(
  submission: ExternalSettlementTransactionFacts,
): ExternalSettlementAttestedFacts {
  return {
    provider: submission.provider,
    externalId: submission.externalId,
    internalTransactionId: submission.internalTransactionId,
    reportedAmount: submission.reportedAmount,
    reportedUnit: submission.reportedUnit,
    observedAt: submission.observedAt,
    correctionOf: submission.correctionOf,
  };
}

/** The canonical serialization of the attested facts (HMAC payload). */
export function externalSettlementCanonicalFacts(
  submission: ExternalSettlementAttestedFacts,
): string {
  // EXPLICIT projection (the W029 discipline): only the seven
  // attested facts participate — envelope metadata, adapter version
  // bookkeeping and any caller-supplied extra fields never do. The
  // projection is stable: adding a field here is a deliberate
  // vocabulary-visible change, never accidental.
  return canonicalJson({
    provider: submission.provider,
    externalId: submission.externalId,
    internalTransactionId: submission.internalTransactionId,
    reportedAmount: submission.reportedAmount,
    reportedUnit: submission.reportedUnit,
    observedAt: submission.observedAt,
    correctionOf: submission.correctionOf,
  });
}

/** Hex-encoded HMAC-SHA256 signatures (64 hex chars). */
const SIGNATURE_RE = /^[0-9a-f]{64}$/;

/** Bounded identifier length (closed inputs, no unbounded strings). */
const MAX_IDENTIFIER_LENGTH = 256;

/**
 * One validated field issue: the machine-readable rejection reason
 * plus the offending field (bounded identifier — never a payload
 * value).
 */
export interface ExternalSettlementValidationIssue {
  readonly reason: ExternalSettlementRejectionReason;
  readonly field: string;
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function isParseableTimestamp(value: string): boolean {
  return !Number.isNaN(Date.parse(value));
}

/** Positive finite number with at most 6 decimals (the economic scale). */
export function isReportedAmountScale(value: number): boolean {
  if (!Number.isFinite(value) || value <= 0) return false;
  const scaled = Math.round(value * 1_000_000);
  return Math.abs(value * 1_000_000 - scaled) < 1e-9;
}

/**
 * Validate adapter-normalized facts against the closed vocabularies
 * and bounded shapes. Returns the issues in CLOSED order (provider →
 * algorithm → shape); the service maps the first issue to the
 * ingestion rejection. NEVER throws and NEVER inspects secrets.
 */
export function validateExternalSettlementFacts(
  facts: ExternalSettlementTransactionFacts,
  expectedProvider: string,
): readonly ExternalSettlementValidationIssue[] {
  const issues: ExternalSettlementValidationIssue[] = [];
  const push = (reason: ExternalSettlementRejectionReason, field: string) =>
    issues.push({ reason, field });

  // ---- Provider vocabulary + adapter identity ------------------------
  if (facts.provider !== expectedProvider) {
    push("malformed_submission", "provider");
  } else if (!isExternalSettlementProvider(facts.provider)) {
    push("unsupported_provider", "provider");
  }
  if (!nonEmptyString(facts.providerVersion) || facts.providerVersion.length > 32) {
    push("malformed_submission", "providerVersion");
  }

  // ---- Bounded identifiers --------------------------------------------
  for (const [field, value] of [
    ["externalId", facts.externalId],
    ["internalTransactionId", facts.internalTransactionId],
  ] as const) {
    if (!nonEmptyString(value) || value.length > MAX_IDENTIFIER_LENGTH) {
      push("malformed_submission", field);
    }
  }
  if (
    facts.correctionOf !== null &&
    (!nonEmptyString(facts.correctionOf) || facts.correctionOf.length > MAX_IDENTIFIER_LENGTH)
  ) {
    push("malformed_submission", "correctionOf");
  }

  // ---- Reported amount/unit (facts, never authority) -------------------
  if (!isReportedAmountScale(facts.reportedAmount)) {
    push("malformed_submission", "reportedAmount");
  }
  if (!isEconomicUnitType(facts.reportedUnit)) {
    push("malformed_submission", "reportedUnit");
  }

  // ---- Timestamps -------------------------------------------------------
  if (!nonEmptyString(facts.observedAt) || !isParseableTimestamp(facts.observedAt)) {
    push("malformed_submission", "observedAt");
  }

  // ---- Trust envelope shape ---------------------------------------------
  const integrity: ExternalSettlementIntegrityBlock | undefined = facts.integrity;
  if (
    integrity === null ||
    integrity === undefined ||
    typeof integrity !== "object"
  ) {
    push("malformed_submission", "integrity");
    return issues;
  }
  if (
    typeof integrity.algorithm !== "string" ||
    !nonEmptyString(integrity.algorithm)
  ) {
    push("malformed_submission", "integrity.algorithm");
  } else if (!isExternalSettlementIntegrityAlgorithm(integrity.algorithm)) {
    // A well-formed but out-of-vocabulary algorithm is a VOCABULARY
    // rejection (distinct from a malformed envelope).
    push("unsupported_algorithm", "integrity.algorithm");
  }
  if (typeof integrity.signature !== "string" || !SIGNATURE_RE.test(integrity.signature)) {
    push("malformed_submission", "integrity.signature");
  }
  if (
    typeof integrity.signedAt !== "string" ||
    !isParseableTimestamp(integrity.signedAt)
  ) {
    push("malformed_submission", "integrity.signedAt");
  }
  return issues;
}

/**
 * The freshness decision over the provider-attested observation time
 * (the W023 semantics): an observation older than the window is
 * STALE and fails closed. `observedAt` validity itself is a shape
 * concern (validated above).
 */
export function isExternalSettlementObservationFresh(
  observedAt: string,
  now: number,
): boolean {
  const observedMs = Date.parse(observedAt);
  if (Number.isNaN(observedMs)) return false;
  return now - observedMs <= EXTERNAL_SETTLEMENT_MAX_AGE_MS;
}

// ---------------------------------------------------------------------------
// Reconciliation derivation inputs (pure).
// ---------------------------------------------------------------------------

/**
 * The derived per-unit debit total of an internal ledger
 * transaction: the deterministic reconciliation comparison target.
 * Ledger transactions are balanced per unit (`Σdebit === Σcredit`,
 * the posting layer validates BEFORE persistence), so the debit total
 * IS the transaction's per-unit amount. Entries participate in
 * summation order (sums are order-independent).
 */
export function ledgerTransactionUnitAmount(
  transaction: EconomicLedgerTransaction,
  unit: EconomicUnitType,
): number {
  let total = 0;
  for (const entry of transaction.entries) {
    if (entry.unit === unit && entry.direction === "debit") {
      total += entry.amount;
    }
  }
  return total;
}

/**
 * The closed set of reasons a satisfied/unsatisfied reconciliation
 * check may carry (pinned exactly by the AC-08 regression):
 * `internal_lineage_not_found` | `lineage_resolved` |
 * `unit_absent_in_lineage` | `unit_present` | `amount_matched` |
 * `amount_mismatched`.
 */
export const EXTERNAL_SETTLEMENT_RECONCILIATION_CHECK_REASONS = [
  "internal_lineage_not_found",
  "lineage_resolved",
  "unit_absent_in_lineage",
  "unit_present",
  "amount_matched",
  "amount_mismatched",
] as const;
