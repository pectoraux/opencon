/**
 * Authority-backed ProofOfValueRepository — persists Proof-of-Value
 * objects through the PostgreSQL authority boundary (NET-W003).
 *
 * Work order ref: NET-W005 §3.8 (Proof-of-Value lifecycle; lifecycle
 * mutations route through /workflows — this repository provides the
 * lifecycle surface the WorkflowService consumes).
 *
 * Tier compliance: evidence domain → self + core contracts only.
 *
 * Storage model: Proof-of-Value objects live in the
 * `proofs_of_value` collection; the entity is the record's `value`.
 *
 * Version semantics: the entity's `version` is the LIFECYCLE version
 * — incremented ONLY by workflow transitions (optimistic
 * concurrency). Domain mutations (evidence attachment, aggregation,
 * attestation attachment) update `updatedAt` and the storage revision
 * but NEVER `version`, so a concurrent lifecycle transition with a
 * valid expectedVersion is never spuriously rejected by a domain
 * mutation (mirrors the NET-W004 updateBrief contract).
 */

import { type ExecutionContext } from "../core/execution-context.ts";
import type { AuthorityTransaction, PostgresAuthority } from "../core/postgres-authority.ts";
import { NotFoundError } from "../core/errors.ts";
import type { ProofOfValue, ProofOfValueRepository } from "./port.ts";

const COLLECTION = "proofs_of_value";

export interface AuthorityProofOfValueRepositoryOptions {
  readonly authority: PostgresAuthority;
  readonly logger?: { debug(message: string, fields?: Record<string, unknown>): void };
}

export function createAuthorityProofOfValueRepository(
  opts: AuthorityProofOfValueRepositoryOptions,
): ProofOfValueRepository {
  const authority = opts.authority;
  const logger = opts.logger;

  return {
    async save(proof, execution) {
      return authority.run(execution, async (tx) => {
        await tx.put(COLLECTION, proof.id, proof);
        logger?.debug("proof_of_value.saved", {
          proofId: proof.id,
          state: proof.state,
          executionId: execution.executionId,
        });
        return proof;
      });
    },

    async findById(id) {
      const rec = await authority.get<ProofOfValue>(COLLECTION, id);
      return rec ? rec.value : null;
    },

    async findByIdWithinTx(id, tx) {
      const rec = await tx.get<ProofOfValue>(COLLECTION, id);
      return rec ? rec.value : null;
    },

    async createWithinTx(proof, tx) {
      // Initial creation — no existence/version check (the entity is
      // new: state DRAFT, version 0).
      await tx.put(COLLECTION, proof.id, proof);
      logger?.debug("proof_of_value.created_within_tx", {
        proofId: proof.id,
        transactionId: tx.transactionId,
      });
      return proof;
    },

    async getByIdWithinTx(id, tx) {
      const rec = await tx.get<ProofOfValue>(COLLECTION, id);
      return rec ? rec.value : null;
    },

    async saveWithinTx(subject, expectedVersion, execution, tx) {
      // Re-read the current subject within the tx (sees uncommitted
      // writes in this tx). Defense in depth: the WorkflowService has
      // already checked expectedVersion; we re-check here so even a
      // caller bypassing the workflow service cannot write stale.
      const current = await tx.get<ProofOfValue>(COLLECTION, subject.id);
      if (!current) {
        throw new NotFoundError(`proof_of_value ${subject.id} not found within tx`, {
          proofId: subject.id,
        });
      }
      if (current.value.version !== expectedVersion) {
        const err = new Error(
          `stale writer: expected version ${expectedVersion}, authoritative ${current.value.version}`,
        );
        err.name = "ConcurrentTransitionError";
        throw err;
      }
      // Merge the workflow service's lifecycle mutation onto the current
      // entity, preserving ALL domain fields (subjectReference,
      // outcomeClaimIds, evidenceIds, aggregation, attestationIds).
      // The lifecycle-repository adapter already merged them; the
      // explicit spread keeps this repository correct even when called
      // directly.
      const merged: ProofOfValue = {
        ...current.value,
        ...subject,
        subjectReference: subject.subjectReference ?? current.value.subjectReference,
        outcomeClaimIds: subject.outcomeClaimIds ?? current.value.outcomeClaimIds,
        evidenceIds: subject.evidenceIds ?? current.value.evidenceIds,
        aggregation: subject.aggregation ?? current.value.aggregation,
        attestationIds: subject.attestationIds ?? current.value.attestationIds,
      };
      await tx.put(COLLECTION, subject.id, merged);
      logger?.debug("proof_of_value.saved_within_tx", {
        proofId: subject.id,
        fromVersion: current.value.version,
        toVersion: merged.version,
        transactionId: tx.transactionId,
      });
      return merged;
    },
  };
}

export { COLLECTION as PROOFS_OF_VALUE_COLLECTION };
