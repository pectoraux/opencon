/**
 * NET-W023 — deterministic canonical serialization + digest for the
 * OpenRTB / supply-chain adapter tier.
 *
 * The same deterministic sorted-key JSON pattern the W021 matching
 * digest and the W022 report-integrity envelope use: object keys are
 * sorted at every depth so the serialization is a pure function of
 * the CONTENT, not of field order. `computeCanonicalDigest` derives
 * the reproducible SHA-256 digest used by the neutral request facts
 * and the seller-authorization record sets (AC-06 determinism).
 *
 * Adapter tier (src/adapters/openrtb/): imports builtin modules only.
 */

import { createHash } from "node:crypto";

/**
 * Deterministic sorted-key JSON serialization (field-order
 * independence — the W021/W022 canonical-JSON pattern).
 */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value ?? null);
  }
  if (Array.isArray(value)) {
    return `[${value.map((v) => canonicalJson(v)).join(",")}]`;
  }
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).sort();
  return `{${keys
    .map((k) => `${JSON.stringify(k)}:${canonicalJson(record[k])}`)
    .join(",")}}`;
}

/**
 * The deterministic SHA-256 digest of the canonical serialization
 * (hex; reproducible for identical content).
 */
export function computeCanonicalDigest(value: unknown): string {
  return createHash("sha256").update(canonicalJson(value)).digest("hex");
}
