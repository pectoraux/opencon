/**
 * Authority-backed ValidationChallengeRepository — persists the
 * validation challenge (round) records with their append-only event
 * histories through the PostgreSQL authority boundary (NET-W003).
 *
 * Work order ref: NET-W032 §3.3 (challenges: bounded window, terminal
 * rounds, idempotent creation).
 *
 * Storage model: rounds live in the `validation_challenges`
 * collection, keyed by record id, storing the frozen target facts, the
 * derived assignment set, the conflict marks and the terminal outcome
 * back-pointer inline. "Live" rounds (the duplicate gate) are the
 * rounds with NO outcome yet — the derived-facts discipline (no
 * status machine: liveness is a projection of the recorded facts).
 */

import type {
  AuthorityTransaction,
  PostgresAuthority,
} from "../core/postgres-authority.ts";
import type { ExecutionContext } from "../core/execution-context.ts";
import type {
  ValidationChallenge,
  ValidationChallengeRepository,
} from "./port.ts";

const COLLECTION = "validation_challenges";

function byCreatedAt(a: ValidationChallenge, b: ValidationChallenge): number {
  if (a.createdAt === b.createdAt) return a.id < b.id ? -1 : 1;
  return a.createdAt < b.createdAt ? -1 : 1;
}

export interface AuthorityValidationChallengeRepositoryOptions {
  readonly authority: PostgresAuthority;
  readonly logger?: {
    debug(message: string, fields?: Record<string, unknown>): void;
  };
}

export function createAuthorityValidationChallengeRepository(
  opts: AuthorityValidationChallengeRepositoryOptions,
): ValidationChallengeRepository {
  const authority = opts.authority;
  const logger = opts.logger;

  return {
    async save(challenge, execution) {
      return authority.run(execution, async (tx) => {
        await tx.put(COLLECTION, challenge.id, challenge);
        logger?.debug("validation_challenge.saved", {
          challengeId: challenge.id,
          executionId: execution.executionId,
        });
        return challenge;
      });
    },

    async findById(id) {
      const rec = await authority.get<ValidationChallenge>(COLLECTION, id);
      return rec ? rec.value : null;
    },

    async findByIdWithinTx(id, tx) {
      const rec = await tx.get<ValidationChallenge>(COLLECTION, id);
      return rec ? rec.value : null;
    },

    async listByOrganization(organizationScopeId) {
      const records = await authority.scan<ValidationChallenge>(COLLECTION);
      return records
        .map((r) => r.value)
        .filter((c) => c.organizationScopeId === organizationScopeId)
        .sort(byCreatedAt);
    },

    async findLiveByTarget(organizationScopeId, targetKind, targetId) {
      const records = await authority.scan<ValidationChallenge>(COLLECTION);
      return records
        .map((r) => r.value)
        .filter((c) => c.organizationScopeId === organizationScopeId)
        .filter(
          (c) => c.target.kind === targetKind && c.target.id === targetId,
        )
        .filter((c) => c.outcome === null)
        .sort(byCreatedAt);
    },

    async findLiveByTargetWithinTx(
      organizationScopeId,
      targetKind,
      targetId,
      tx,
    ) {
      const records = await tx.scan<ValidationChallenge>(COLLECTION);
      return records
        .map((r) => r.value)
        .filter((c) => c.organizationScopeId === organizationScopeId)
        .filter(
          (c) => c.target.kind === targetKind && c.target.id === targetId,
        )
        .filter((c) => c.outcome === null)
        .sort(byCreatedAt);
    },

    async createWithinTx(challenge, tx) {
      await tx.put(COLLECTION, challenge.id, challenge);
      logger?.debug("validation_challenge.created_within_tx", {
        challengeId: challenge.id,
        transactionId: tx.transactionId,
      });
      return challenge;
    },

    async saveWithinTx(challenge, tx) {
      await tx.put(COLLECTION, challenge.id, challenge);
      logger?.debug("validation_challenge.saved_within_tx", {
        challengeId: challenge.id,
        transactionId: tx.transactionId,
      });
      return challenge;
    },
  };
}

export { COLLECTION as VALIDATION_CHALLENGES_COLLECTION };
export type { ExecutionContext, AuthorityTransaction };
