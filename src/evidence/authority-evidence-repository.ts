/**
 * Authority-backed EvidenceRepository — persists evidence records
 * through the PostgreSQL authority boundary established by NET-W003.
 *
 * Work order ref: NET-W005 §3.1 (evidence first-class model), §4
 * invariant 4 (PostgreSQL-backed persistence with lineage + atomic
 * audit).
 *
 * Tier compliance: this file is in the `evidence` domain boundary. It
 * imports ONLY its own port (self) and core contracts
 * (PostgresAuthority, ExecutionContext). The concrete driver is
 * injected by the bootstrap composition root.
 *
 * Storage model: evidence records live in the `evidence` collection
 * of the authoritative store; the entity is the record's `value`.
 * Evidence records are IMMUTABLE after creation (corrections are new
 * records) — the repository exposes save-for-create only.
 */

import { type ExecutionContext } from "../core/execution-context.ts";
import type { PostgresAuthority } from "../core/postgres-authority.ts";
import type { Evidence, EvidenceRepository } from "./port.ts";

const COLLECTION = "evidence";

export interface AuthorityEvidenceRepositoryOptions {
  readonly authority: PostgresAuthority;
  readonly logger?: { debug(message: string, fields?: Record<string, unknown>): void };
}

export function createAuthorityEvidenceRepository(
  opts: AuthorityEvidenceRepositoryOptions,
): EvidenceRepository {
  const authority = opts.authority;
  const logger = opts.logger;

  return {
    async save(evidence, execution) {
      return authority.run(execution, async (tx) => {
        await tx.put(COLLECTION, evidence.id, evidence);
        logger?.debug("evidence.saved", {
          evidenceId: evidence.id,
          grade: evidence.grade,
          sensitivity: evidence.sensitivity,
          executionId: execution.executionId,
        });
        return evidence;
      });
    },

    async saveWithinTx(evidence, tx) {
      await tx.put(COLLECTION, evidence.id, evidence);
      logger?.debug("evidence.saved_within_tx", {
        evidenceId: evidence.id,
        grade: evidence.grade,
        sensitivity: evidence.sensitivity,
        transactionId: tx.transactionId,
      });
      return evidence;
    },

    async findById(id) {
      const rec = await authority.get<Evidence>(COLLECTION, id);
      return rec ? rec.value : null;
    },

    async findByIdWithinTx(id, tx) {
      // NET-W029 (additive): the in-tx twin for the evidence coverage
      // family — sees uncommitted writes in the caller's transaction.
      const rec = await tx.get<Evidence>(COLLECTION, id);
      return rec ? rec.value : null;
    },

    async listBySubject(subjectId) {
      const all = await authority.scan<Evidence>(COLLECTION);
      return all
        .map((r) => r.value)
        .filter((e) => e.subjectReference.subjectId === subjectId);
    },

    async exists(id) {
      const rec = await authority.get<Evidence>(COLLECTION, id);
      return rec !== null;
    },
  };
}

export { COLLECTION as EVIDENCE_COLLECTION };
