/**
 * Authority-backed ReputationSnapshotRepository — persists the
 * immutable, append-only reputation snapshots through the PostgreSQL
 * authority boundary (NET-W003).
 *
 * Work order ref: NET-W007 §3.5 (snapshots + history).
 *
 * Storage model: snapshots live in the `reputation_snapshots`
 * collection, keyed by snapshot id. Records are immutable (created
 * once; there is no update path). The subject history listing scans
 * the collection and orders by (computedAt, id) — the append-only
 * audit history (AUD-004). Idempotent recording is owned by the
 * IdempotencyStore (exactly-once-per-key, atomic with the mutation —
 * the NET-W004 primitive), not by this repository.
 */

import type {
  AuthorityTransaction,
  PostgresAuthority,
} from "../core/postgres-authority.ts";
import type { ExecutionContext } from "../core/execution-context.ts";
import type {
  ReputationSnapshot,
  ReputationSnapshotRepository,
} from "./port.ts";

const COLLECTION = "reputation_snapshots";

export interface AuthorityReputationSnapshotRepositoryOptions {
  readonly authority: PostgresAuthority;
  readonly logger?: {
    debug(message: string, fields?: Record<string, unknown>): void;
  };
}

export function createAuthorityReputationSnapshotRepository(
  opts: AuthorityReputationSnapshotRepositoryOptions,
): ReputationSnapshotRepository {
  const authority = opts.authority;
  const logger = opts.logger;

  async function historyFrom(
    organizationScopeId: string,
    subjectPersonId: string,
    scan: () => Promise<readonly { value: ReputationSnapshot }[]>,
  ): Promise<readonly ReputationSnapshot[]> {
    const records = await scan();
    return records
      .map((r) => r.value)
      .filter(
        (s) =>
          s.organizationScopeId === organizationScopeId &&
          s.subjectPersonId === subjectPersonId,
      )
      .sort((a, b) => {
        const ca = Date.parse(a.computedAt);
        const cb = Date.parse(b.computedAt);
        if (ca !== cb) return ca - cb;
        return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
      });
  }

  return {
    async save(snapshot, execution) {
      return authority.run(execution, async (tx) => {
        await tx.put(COLLECTION, snapshot.id, snapshot);
        logger?.debug("reputation_snapshot.saved", {
          snapshotId: snapshot.id,
          subjectPersonId: snapshot.subjectPersonId,
          executionId: execution.executionId,
        });
        return snapshot;
      });
    },

    async findById(id) {
      const rec = await authority.get<ReputationSnapshot>(COLLECTION, id);
      return rec ? rec.value : null;
    },

    async listBySubject(organizationScopeId, subjectPersonId) {
      return historyFrom(organizationScopeId, subjectPersonId, () =>
        authority.scan<ReputationSnapshot>(COLLECTION),
      );
    },

    async findByIdWithinTx(id, tx) {
      const rec = await tx.get<ReputationSnapshot>(COLLECTION, id);
      return rec ? rec.value : null;
    },

    async createWithinTx(snapshot, tx) {
      await tx.put(COLLECTION, snapshot.id, snapshot);
      logger?.debug("reputation_snapshot.created_within_tx", {
        snapshotId: snapshot.id,
        subjectPersonId: snapshot.subjectPersonId,
        transactionId: tx.transactionId,
      });
      return snapshot;
    },
  };
}

export { COLLECTION as REPUTATION_SNAPSHOTS_COLLECTION };
export type { ExecutionContext, AuthorityTransaction };
