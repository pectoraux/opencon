/**
 * Default HMAC-SHA256 attestation signer/verifier (NET-W005 §3.5).
 *
 * This is the DEVELOPMENT/TEST DEFAULT implementation behind the
 * verifier-neutral AttestationSigner / AttestationVerifier structural
 * interfaces. It uses standard HMAC-SHA256 (node:crypto — builtin,
 * provider-neutral, no external dependency) with a configured key.
 *
 * Production deployments swap this for a real verifier (e.g. an
 * Ed25519 signing service behind an adapter) WITHOUT touching the
 * evidence domain: the interfaces stay, only the composition root's
 * wiring changes.
 *
 * The signature is opaque to the domain: hex(HMAC-SHA256(key,
 * canonicalInput)). Verification recomputes and compares in constant
 * time.
 */

import { createHmac, timingSafeEqual } from "node:crypto";
import type { AttestationSigner, AttestationVerifier } from "./port.ts";

export const HMAC_ATTESTATION_ALGORITHM = "hmac-sha256" as const;

export interface HmacAttestationSignerOptions {
  /** The HMAC key. Configure via the secret/config boundary in production. */
  readonly key: string;
}

export function createHmacAttestationSignerVerifier(
  opts: HmacAttestationSignerOptions,
): AttestationSigner & AttestationVerifier {
  const key = opts.key;

  function signCanonical(canonicalInput: string): string {
    return createHmac("sha256", key).update(canonicalInput, "utf8").digest("hex");
  }

  return {
    async sign(canonicalInput) {
      return {
        algorithm: HMAC_ATTESTATION_ALGORITHM,
        signature: signCanonical(canonicalInput),
      };
    },
    async verify(canonicalInput, attestation) {
      if (attestation.algorithm !== HMAC_ATTESTATION_ALGORITHM) {
        return {
          valid: false,
          reason: `unsupported attestation algorithm ${String(attestation.algorithm)} (this verifier accepts ${HMAC_ATTESTATION_ALGORITHM})`,
        };
      }
      const expected = Buffer.from(signCanonical(canonicalInput), "utf8");
      const actual = Buffer.from(attestation.signature ?? "", "utf8");
      if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) {
        return {
          valid: false,
          reason:
            "attestation signature does not match the rebuilt canonical input (tampered statement, evidence set, or commitments)",
        };
      }
      return { valid: true, reason: "attestation signature verified" };
    },
  };
}
