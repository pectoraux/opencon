/**
 * NET-W022 — shared report-integrity verification for provider
 * attribution adapters (ADAPTER-003..004).
 *
 * Provider attribution reports must be VERIFIABLE before their facts
 * can enter the measurement layer: an integrity-less or
 * unverifiable report is rejected fail-closed with the
 * `unverifiable_integrity` reason (issue #44 scope 5). This module
 * defines the provider-neutral reference integrity envelope:
 *
 *  - Algorithm: HMAC-SHA256 (node:crypto — the same primitive the
 *    W005 HMAC attestation verifier uses; provider-neutral, no
 *    vendor SDK).
 *  - Signing payload: the canonical sorted-key JSON serialization of
 *    the raw report WITHOUT its `integrity` block — a deterministic
 *    function of the report content, so normalization and
 *    verification are reproducible.
 *  - Secret: the provider verification secret is injected at
 *    composition time (SecretProvider boundary) and NEVER crosses
 *    into normalized reports, logs, audit payloads, or error
 *    contexts (PRIV-002; issue #44 privacy constraints).
 *
 * Adapter tier (this file sits under `src/measurement/providers/`):
 * may import core contracts + the neutral port; may NOT import
 * domain modules (tier matrix). `node:crypto` is a builtin.
 */

import { createHmac, timingSafeEqual } from "node:crypto";
import { MeasurementReportRejectedError } from "../port.ts";
import type { MeasurementReportRejectionReason } from "../port.ts";

/** The only supported report-integrity algorithm (reference envelope). */
export const REPORT_INTEGRITY_ALGORITHM = "hmac-sha256" as const;

/** The integrity block every reference raw report must carry. */
export interface ReportIntegrityBlock {
  /** MUST equal "hmac-sha256" (anything else fails closed). */
  readonly algorithm: string;
  /** The provider's HMAC signature over the canonical report payload. */
  readonly signature: string;
  /** When the provider signed (ISO-8601; provenance fact). */
  readonly signedAt: string;
}

/**
 * Deterministic sorted-key JSON serialization (the W021 canonical
 * JSON pattern — the W022 reference integrity envelope). Object keys
 * are sorted at every depth so the signing payload is a pure function
 * of the report CONTENT, not of field order.
 */
export function canonicalReportJson(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value ?? null);
  }
  if (Array.isArray(value)) {
    return `[${value.map((v) => canonicalReportJson(v)).join(",")}]`;
  }
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).sort();
  return `{${keys
    .map((k) => `${JSON.stringify(k)}:${canonicalReportJson(record[k])}`)
    .join(",")}}`;
}

/**
 * Compute the reference HMAC-SHA256 signature for a raw report.
 * Exported for the provider side (tests construct signed reports
 * with it); the adapters use it to VERIFY. Pure function of the
 * report content + secret.
 */
export function computeReportSignature(
  reportWithoutIntegrity: Record<string, unknown>,
  secret: string,
): string {
  return createHmac("sha256", secret)
    .update(canonicalReportJson(reportWithoutIntegrity))
    .digest("hex");
}

/** Build the signing payload: the report minus its integrity block. */
function signingPayload(raw: Record<string, unknown>): string {
  const { integrity: _integrity, ...rest } = raw;
  void _integrity;
  return canonicalReportJson(rest);
}

function reject(
  providerId: string,
  detail: string,
  extra?: Readonly<Record<string, unknown>>,
): MeasurementReportRejectedError {
  return new MeasurementReportRejectedError(
    "unverifiable_integrity" satisfies MeasurementReportRejectionReason,
    `provider ${providerId} report rejected: ${detail}`,
    { providerId, ...extra },
  );
}

/**
 * Verify ONE raw report's integrity block. Fail closed
 * (`unverifiable_integrity`) when the block is missing/malformed, the
 * algorithm is unsupported, the verification secret is not
 * configured, or the signature does not match the payload. The error
 * context carries only the provider id + algorithm/field names —
 * never the signature, the payload, or the secret.
 */
export function verifyReportIntegrity(options: {
  readonly providerId: string;
  readonly raw: Record<string, unknown>;
  readonly verificationSecret: string | undefined;
}): void {
  const { providerId, raw, verificationSecret } = options;
  const integrity = raw["integrity"];
  if (integrity === null || typeof integrity !== "object" || Array.isArray(integrity)) {
    throw reject(
      providerId,
      "the report carries no verifiable integrity block (provider attribution reports MUST be signed)",
      { field: "integrity" },
    );
  }
  const block = integrity as Record<string, unknown>;
  const algorithm = block["algorithm"];
  if (algorithm !== REPORT_INTEGRITY_ALGORITHM) {
    throw reject(
      providerId,
      `unsupported integrity algorithm ${String(algorithm)} (only ${REPORT_INTEGRITY_ALGORITHM} is supported)`,
      { field: "integrity.algorithm", algorithm: null },
    );
  }
  const signature = block["signature"];
  if (typeof signature !== "string" || !signature.trim()) {
    throw reject(providerId, "the integrity signature is missing", {
      field: "integrity.signature",
    });
  }
  const signedAt = block["signedAt"];
  if (typeof signedAt !== "string" || !signedAt.trim()) {
    throw reject(providerId, "the integrity signedAt is missing", {
      field: "integrity.signedAt",
    });
  }
  if (
    verificationSecret === undefined ||
    verificationSecret === null ||
    verificationSecret === ""
  ) {
    // The secret is configuration state, not report content: report
    // its ABSENCE only, never the value.
    throw reject(
      providerId,
      "no verification secret is configured for this provider (report cannot be verified — failing closed)",
      { secretConfigured: false },
    );
  }
  const expected = createHmac("sha256", verificationSecret)
    .update(signingPayload(raw))
    .digest("hex");
  const a = Buffer.from(expected, "utf8");
  const b = Buffer.from(signature, "utf8");
  if (a.length !== b.length || !timingSafeEqual(a, b)) {
    throw reject(
      providerId,
      "the integrity signature does not match the report payload (tampered or wrong provider secret)",
      { field: "integrity.signature", matched: false },
    );
  }
}
