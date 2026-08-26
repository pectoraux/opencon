/**
 * Authority-backed AttestationRepository — persists attestations
 * through the PostgreSQL authority boundary (NET-W003).
 *
 * Work order ref: NET-W005 §3.5 (attestations, verifier-neutral).
 *
 * Tier compliance: evidence domain → self + core contracts only.
 *
 * Storage model: attestations live in the `attestations` collection;
 * the entity is the record's `value`. Attestations are immutable
 * after creation.
 */

import { type ExecutionContext } from "../core/execution-context.ts";
import type { AuthorityTransaction, PostgresAuthority } from "../core/postgres-authority.ts";
import type { Attestation, AttestationRepository } from "./port.ts";

const COLLECTION = "attestations";

export interface AuthorityAttestationRepositoryOptions {
  readonly authority: PostgresAuthority;
  readonly logger?: { debug(message: string, fields?: Record<string, unknown>): void };
}

export function createAuthorityAttestationRepository(
  opts: AuthorityAttestationRepositoryOptions,
): AttestationRepository {
  const authority = opts.authority;
  const logger = opts.logger;

  return {
    async save(attestation, execution) {
      return authority.run(execution, async (tx) => {
        await tx.put(COLLECTION, attestation.id, attestation);
        logger?.debug("attestation.saved", {
          attestationId: attestation.id,
          verifierId: attestation.verifierId,
          executionId: execution.executionId,
        });
        return attestation;
      });
    },

    async saveWithinTx(attestation, tx) {
      await tx.put(COLLECTION, attestation.id, attestation);
      logger?.debug("attestation.saved_within_tx", {
        attestationId: attestation.id,
        verifierId: attestation.verifierId,
        transactionId: tx.transactionId,
      });
      return attestation;
    },

    async findById(id) {
      const rec = await authority.get<Attestation>(COLLECTION, id);
      return rec ? rec.value : null;
    },

    async exists(id) {
      const rec = await authority.get<Attestation>(COLLECTION, id);
      return rec !== null;
    },
  };
}

export { COLLECTION as ATTESTATIONS_COLLECTION };
export type { AuthorityTransaction };
