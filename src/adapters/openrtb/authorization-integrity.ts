/**
 * NET-W023 — seller-authorization trust envelope (PR #47 remediation;
 * the W022 report-integrity precedent, ADAPTER-002).
 *
 * Architect review finding (blocking): supply-chain "verification" was
 * only consistency checking of CALLER-SUPPLIED authorization files —
 * nothing established that the files were authoritative/authenticated,
 * so fabricated ads.txt/app-ads.txt/sellers.json content could produce
 * a `verified` chain. This module defines the trust envelope that
 * closes that gap:
 *
 *  - Algorithm: HMAC-SHA256 (node:crypto — the same primitive the W005
 *    HMAC attestation verifier and the W022 report-integrity envelope
 *    use; provider-neutral, no vendor SDK).
 *  - Signing payload: the canonical sorted-key JSON serialization of
 *    the EXACT submission facts the collector attests — sourceKind,
 *    sourceIdentity (whose authorization surface the file is), the raw
 *    file content, and observedAt (null when freshness is absent: the
 *    envelope attests the absence itself). The payload is a pure
 *    function of the submission content, so verification is
 *    deterministic and reproducible.
 *  - Trust root: the seller-authorization trust key (HMAC key) is
 *    resolved ONLY through the SecretProvider at composition time
 *    (`SELLER_AUTHORIZATION_TRUST_KEY`) and injected into the ingress
 *    boundary. When no key is configured, NO submission can be
 *    authenticated and NO chain can be `verified` (fail closed — the
 *    W022 "no secret → fail closed" wiring rule).
 *  - Privacy: the secret, the signature, and the file content NEVER
 *    appear in logs, audit events, error contexts, or normalized
 *    facts (PRIV-002). The envelope itself is consumed at the ingress
 *    boundary and is NOT retained in the evaluation output (the facts
 *    carry their own deterministic digest).
 *
 * Verification failure is NOT an exception: an unauthenticated
 * submission still normalizes (its facts remain facts, §3.4) — it
 * simply can never support a `verified` supply chain (the admission
 * evaluation reports `supply_chain_unauthenticated`). This mirrors
 * the status-matrix semantics of the other non-verified statuses.
 *
 * Adapter tier: imports builtin modules + the neutral port + the
 * boundary-local canonical helper only; no domain imports (tier
 * matrix).
 */

import { createHmac, timingSafeEqual } from "node:crypto";
import { SELLER_AUTHORIZATION_INTEGRITY_ALGORITHM } from "../port.ts";
import type {
  RawSellerAuthorizationSubmission,
  SellerAuthorizationIntegrityBlock,
} from "../port.ts";
import { canonicalJson } from "./canonical-json.ts";

/** Hex-encoded HMAC-SHA256 signatures (64 hex chars). */
const SIGNATURE_RE = /^[0-9a-f]{64}$/;

/** The exact submission facts an envelope attests (the signing payload). */
export interface SellerAuthorizationSigningPayload {
  readonly sourceKind: RawSellerAuthorizationSubmission["sourceKind"];
  readonly sourceIdentity: string;
  readonly content: string;
  readonly observedAt: string | null;
}

/**
 * The canonical signing payload of ONE submission: the exact facts the
 * trust channel attests. `observedAt` is attested as null when absent
 * (an envelope CAN honestly attest content without freshness — the
 * verification evaluation then treats that evidence as NOT fresh).
 */
export function sellerAuthorizationSigningPayload(
  submission: Pick<
    RawSellerAuthorizationSubmission,
    "sourceKind" | "sourceIdentity" | "content" | "observedAt"
  >,
): SellerAuthorizationSigningPayload {
  return {
    sourceKind: submission.sourceKind,
    sourceIdentity: submission.sourceIdentity,
    content: submission.content,
    observedAt: submission.observedAt ?? null,
  };
}

/**
 * Compute the trust-envelope HMAC-SHA256 signature for a submission.
 * Exported for the trusted collector side (tests construct signed
 * submissions with it); the ingress boundary uses it to VERIFY. Pure
 * function of the submission facts + the trust key.
 */
export function computeSellerAuthorizationSignature(
  payload: SellerAuthorizationSigningPayload,
  trustKey: string,
): string {
  return createHmac("sha256", trustKey).update(canonicalJson(payload)).digest("hex");
}

/**
 * Build a valid integrity envelope for a submission (the trusted
 * collector side — tests and future collector integrations).
 */
export function buildSellerAuthorizationIntegrity(
  submission: Pick<
    RawSellerAuthorizationSubmission,
    "sourceKind" | "sourceIdentity" | "content" | "observedAt"
  >,
  trustKey: string,
  signedAt: string,
): SellerAuthorizationIntegrityBlock {
  return Object.freeze({
    algorithm: SELLER_AUTHORIZATION_INTEGRITY_ALGORITHM,
    signature: computeSellerAuthorizationSignature(
      sellerAuthorizationSigningPayload(submission),
      trustKey,
    ),
    signedAt,
  });
}

/**
 * Verify ONE submission's trust envelope. PURE, deterministic and
 * NON-THROWING: any failure (no envelope, no configured trust key,
 * unsupported algorithm, malformed block, or signature mismatch)
 * returns false — the submission's facts remain facts but are
 * UNAUTHENTICATED and can never support a `verified` chain (the
 * architect-review remediation: fabricated content must not be able
 * to produce `verified`). Comparison is timing-safe. Never inspects
 * or returns secret material; the signature itself is never exposed
 * beyond this boundary.
 */
export function verifySellerAuthorizationIntegrity(options: {
  readonly submission: Pick<RawSellerAuthorizationSubmission, "integrity"> &
    Pick<RawSellerAuthorizationSubmission, "sourceKind"> &
    Pick<RawSellerAuthorizationSubmission, "sourceIdentity"> &
    Pick<RawSellerAuthorizationSubmission, "content"> &
    Pick<RawSellerAuthorizationSubmission, "observedAt">;
  readonly trustKey: string | undefined;
}): boolean {
  const { submission, trustKey } = options;
  // No configured trust channel → nothing can be authenticated
  // (fail closed; the W022 no-secret wiring rule).
  if (trustKey === undefined || trustKey.length === 0) return false;
  const integrity = submission.integrity;
  if (integrity === undefined || integrity === null) return false;
  if (
    typeof integrity.algorithm !== "string" ||
    integrity.algorithm !== SELLER_AUTHORIZATION_INTEGRITY_ALGORITHM
  ) {
    return false;
  }
  if (
    typeof integrity.signature !== "string" ||
    !SIGNATURE_RE.test(integrity.signature)
  ) {
    return false;
  }
  if (typeof integrity.signedAt !== "string" || Number.isNaN(Date.parse(integrity.signedAt))) {
    return false;
  }
  const expected = computeSellerAuthorizationSignature(
    sellerAuthorizationSigningPayload(submission),
    trustKey,
  );
  const expectedBytes = Buffer.from(expected, "utf8");
  const actualBytes = Buffer.from(integrity.signature, "utf8");
  if (expectedBytes.length !== actualBytes.length) return false;
  return timingSafeEqual(expectedBytes, actualBytes);
}
