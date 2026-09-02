/**
 * Authority-backed ReputationProofRepository — persists NET-W031
 * portable reputation proofs through the PostgreSQL authority boundary
 * established by NET-W003.
 *
 * Work order ref: NET-W031 §3.6 (tenancy, idempotency, atomicity — the
 * service drives ONE authoritative transaction via the IdempotencyStore
 * context and writes through `saveWithinTx`).
 *
 * Tier compliance: reputation domain → self + core contracts only.
 *
 * Storage model: proofs live in the `reputation_proofs` collection,
 * keyed by proof id; the entity is the record's `value`. Records are
 * IMMUTABLE after issuance except the ONE-WAY revocation fields
 * (revokedAt/revocationReason) — replaced via a full-record `put`
 * inside the authoritative revocation transaction (the W029
 * discipline). There is no update path: re-issuance produces a NEW
 * proof.
 */

import { type ExecutionContext } from "../core/execution-context.ts";
import type { AuthorityTransaction, PostgresAuthority } from "../core/postgres-authority.ts";
import type { ReputationProof, ReputationProofRepository } from "./port.ts";

const COLLECTION = "reputation_proofs";

export interface AuthorityReputationProofRepositoryOptions {
  readonly authority: PostgresAuthority;
  readonly logger?: {
    debug(message: string, fields?: Record<string, unknown>): void;
  };
}

export function createAuthorityReputationProofRepository(
  opts: AuthorityReputationProofRepositoryOptions,
): ReputationProofRepository {
  const authority = opts.authority;
  const logger = opts.logger;

  return {
    async save(proof, execution) {
      return authority.run(execution, async (tx) => {
        await tx.put(COLLECTION, proof.id, proof);
        logger?.debug("reputation_proof.saved", {
          proofId: proof.id,
          subjectPersonId: proof.subjectPersonId,
          algorithm: proof.algorithm,
          executionId: execution.executionId,
        });
        return proof;
      });
    },

    async saveWithinTx(proof, tx) {
      await tx.put(COLLECTION, proof.id, proof);
      logger?.debug("reputation_proof.saved_within_tx", {
        proofId: proof.id,
        subjectPersonId: proof.subjectPersonId,
        algorithm: proof.algorithm,
        transactionId: tx.transactionId,
      });
      return proof;
    },

    async findById(id) {
      const rec = await authority.get<ReputationProof>(COLLECTION, id);
      return rec ? rec.value : null;
    },

    async findByIdWithinTx(id, tx) {
      const rec = await tx.get<ReputationProof>(COLLECTION, id);
      return rec ? rec.value : null;
    },

    async exists(id) {
      const rec = await authority.get<ReputationProof>(COLLECTION, id);
      return rec !== null;
    },
  };
}

export { COLLECTION as REPUTATION_PROOFS_COLLECTION };
export type { AuthorityTransaction };
