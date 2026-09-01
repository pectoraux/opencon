/**
 * Authority-backed SignedAttestationRepository — persists NET-W029
 * signed attestations through the PostgreSQL authority boundary
 * established by NET-W003.
 *
 * Work order ref: NET-W029 §3.7 (atomicity + composite idempotency —
 * the service drives ONE authoritative transaction via the
 * IdempotencyStore context and writes through `saveWithinTx`).
 *
 * Tier compliance: evidence domain → self + core contracts only.
 *
 * Storage model: signed attestations live in the
 * `signed_attestations` collection; the entity is the record's
 * `value`. Records are IMMUTABLE after creation except the ONE-WAY
 * revocation fields (revokedAt/revocationReason) — replaced via a
 * full-record `put` inside the authoritative revocation transaction.
 */

import { type ExecutionContext } from "../core/execution-context.ts";
import type { AuthorityTransaction, PostgresAuthority } from "../core/postgres-authority.ts";
import type { SignedAttestation, SignedAttestationRepository } from "./port.ts";

const COLLECTION = "signed_attestations";

export interface AuthoritySignedAttestationRepositoryOptions {
  readonly authority: PostgresAuthority;
  readonly logger?: { debug(message: string, fields?: Record<string, unknown>): void };
}

export function createAuthoritySignedAttestationRepository(
  opts: AuthoritySignedAttestationRepositoryOptions,
): SignedAttestationRepository {
  const authority = opts.authority;
  const logger = opts.logger;

  return {
    async save(attestation, execution) {
      return authority.run(execution, async (tx) => {
        await tx.put(COLLECTION, attestation.id, attestation);
        logger?.debug("signed_attestation.saved", {
          attestationId: attestation.id,
          verifierId: attestation.verifierId,
          algorithm: attestation.algorithm,
          executionId: execution.executionId,
        });
        return attestation;
      });
    },

    async saveWithinTx(attestation, tx) {
      await tx.put(COLLECTION, attestation.id, attestation);
      logger?.debug("signed_attestation.saved_within_tx", {
        attestationId: attestation.id,
        verifierId: attestation.verifierId,
        algorithm: attestation.algorithm,
        transactionId: tx.transactionId,
      });
      return attestation;
    },

    async findById(id) {
      const rec = await authority.get<SignedAttestation>(COLLECTION, id);
      return rec ? rec.value : null;
    },

    async findByIdWithinTx(id, tx) {
      const rec = await tx.get<SignedAttestation>(COLLECTION, id);
      return rec ? rec.value : null;
    },

    async exists(id) {
      const rec = await authority.get<SignedAttestation>(COLLECTION, id);
      return rec !== null;
    },
  };
}

export { COLLECTION as SIGNED_ATTESTATIONS_COLLECTION };
export type { AuthorityTransaction };
