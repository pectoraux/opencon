/**
 * Evidence commitments — cryptographic commitments over sensitive
 * evidence material (NET-W005 §3.6; EVID-006).
 *
 * Architecture ref: spec/architecture-lock.md §6 (privacy authority:
 * sensitive evidence may remain off-chain/off-platform; cryptographic
 * commitments prove integrity without publishing raw personal data),
 * §12 invariant 6 (raw personal activity data is not placed on a
 * public ledger).
 *
 * A commitment is a standard hash digest (SHA-256 or SHA-512,
 * provider-neutral, no external dependency) of the committed material
 * with an optional salt. The durable evidence record stores ONLY the
 * commitment (algorithm + digest + optional salt); the raw material
 * stays off-record. Integrity is verified by recomputing the digest
 * when the plaintext is presented — verification never requires the
 * record to have stored the plaintext, and non-matching plaintext
 * fails verification (AC-05).
 *
 * Digest comparison is constant-time (crypto.timingSafeEqual) so
 * verification does not leak prefix matches.
 */

import { createHash, timingSafeEqual } from "node:crypto";
import type { EvidenceCommitment } from "../core/evidence.ts";
import { InvalidCommitmentError, isCommitmentAlgorithm } from "../core/evidence.ts";

/**
 * Compute the digest input for a commitment: the salt (when present)
 * and the payload are joined with a separator that cannot appear in
 * hex-encoded salt values... salts are free-form, so the separator
 * convention is fixed and documented: `salt + ":" + payload`. The
 * same convention is used at creation and verification, so it is
 * deterministic for any (salt, payload) pair.
 */
function digestInput(payload: string, salt?: string): string {
  return salt !== undefined && salt !== "" ? `${salt}:${payload}` : payload;
}

/**
 * Create a cryptographic commitment over sensitive evidence material.
 * Pure + deterministic: the same (payload, algorithm, salt) always
 * produces the same commitment.
 */
export function createEvidenceCommitment(
  payload: string,
  opts: { algorithm?: "sha256" | "sha512"; salt?: string } = {},
): EvidenceCommitment {
  const algorithm = opts.algorithm ?? "sha256";
  if (!isCommitmentAlgorithm(algorithm)) {
    throw new InvalidCommitmentError(
      `unsupported commitment algorithm: ${String(algorithm)} (supported: sha256, sha512)`,
      { algorithm },
    );
  }
  if (typeof payload !== "string") {
    throw new InvalidCommitmentError("committed payload must be a string", {});
  }
  const digest = createHash(algorithm)
    .update(digestInput(payload, opts.salt), "utf8")
    .digest("hex");
  const commitment: EvidenceCommitment = {
    algorithm,
    digest,
    ...(opts.salt !== undefined && opts.salt !== "" ? { salt: opts.salt } : {}),
  };
  return Object.freeze(commitment);
}

/**
 * Verify presented plaintext against a stored commitment: recompute
 * the digest with the commitment's algorithm + salt and compare in
 * constant time. Returns true ONLY when the presented material
 * matches the committed material exactly.
 */
export function verifyEvidenceCommitment(
  payload: string,
  commitment: EvidenceCommitment,
): boolean {
  if (!isCommitmentAlgorithm(commitment.algorithm)) {
    return false;
  }
  const expected = createEvidenceCommitment(payload, {
    algorithm: commitment.algorithm,
    salt: commitment.salt,
  });
  // Constant-time comparison over the hex digests.
  const a = Buffer.from(expected.digest, "utf8");
  const b = Buffer.from(commitment.digest, "utf8");
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

/**
 * Validate a caller-provided (pre-computed) commitment: the algorithm
 * must be supported and the digest must be a non-empty hex string of
 * the algorithm's output length.
 */
export function validateEvidenceCommitment(
  commitment: EvidenceCommitment,
): EvidenceCommitment {
  if (!isCommitmentAlgorithm(commitment.algorithm)) {
    throw new InvalidCommitmentError(
      `unsupported commitment algorithm: ${String(commitment.algorithm)} (supported: sha256, sha512)`,
      { algorithm: commitment.algorithm },
    );
  }
  const expectedLength = commitment.algorithm === "sha256" ? 64 : 128;
  if (
    typeof commitment.digest !== "string" ||
    !/^[0-9a-f]+$/.test(commitment.digest) ||
    commitment.digest.length !== expectedLength
  ) {
    throw new InvalidCommitmentError(
      `commitment digest must be a ${expectedLength}-character hex string for ${commitment.algorithm}`,
      { digestLength: commitment.digest?.length },
    );
  }
  return Object.freeze({
    algorithm: commitment.algorithm,
    digest: commitment.digest,
    ...(commitment.salt !== undefined ? { salt: commitment.salt } : {}),
  });
}
