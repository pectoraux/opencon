/**
 * Authority-backed ExternalSettlementFactRepository — persists the
 * append-only external settlement transaction facts through the
 * PostgreSQL authority boundary (NET-W003; work order NET-W030 §3.1).
 *
 * Storage model: facts live in the `external_settlement_facts`
 * collection keyed by record id. The records are CREATE-ONLY — the
 * repository exposes NO save/update path (a fact is immutable after
 * recording; corrections are NEW records referencing the corrected
 * one). The exactly-once identity (organization scope, provider,
 * external id) is enforced by the service inside the authoritative
 * transaction through the in-tx identity lookups below.
 */

import type {
  AuthorityTransaction,
  PostgresAuthority,
} from "../core/postgres-authority.ts";
import { OpenConError } from "../core/errors.ts";
import type {
  ExternalSettlementFactRecord,
  ExternalSettlementFactRepository,
} from "./port.ts";

const COLLECTION = "external_settlement_facts";

export interface AuthorityExternalSettlementFactRepositoryOptions {
  readonly authority: PostgresAuthority;
  readonly logger?: {
    debug(message: string, fields?: Record<string, unknown>): void;
  };
}

export class ExternalSettlementFactConflictError extends OpenConError {
  public constructor(message: string, context?: Readonly<Record<string, unknown>>) {
    super({
      code: "EXTERNAL_SETTLEMENT_FACT_CONFLICT",
      classification: "conflict",
      message,
      retryable: false,
      context,
    });
  }
}

function ordered(a: ExternalSettlementFactRecord, b: ExternalSettlementFactRecord): number {
  const ta = Date.parse(a.recordedAt);
  const tb = Date.parse(b.recordedAt);
  if (ta !== tb) return ta - tb;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

export function createAuthorityExternalSettlementFactRepository(
  opts: AuthorityExternalSettlementFactRepositoryOptions,
): ExternalSettlementFactRepository {
  const authority = opts.authority;
  const logger = opts.logger;

  function identityMatches(
    record: ExternalSettlementFactRecord,
    organizationScopeId: string,
    provider: string,
    externalId: string,
  ): boolean {
    return (
      record.organizationScopeId === organizationScopeId &&
      record.provider === provider &&
      record.externalId === externalId
    );
  }

  return {
    async findById(id) {
      const rec = await authority.get<ExternalSettlementFactRecord>(COLLECTION, id);
      return rec ? rec.value : null;
    },

    async findByIdWithinTx(id, tx) {
      const rec = await tx.get<ExternalSettlementFactRecord>(COLLECTION, id);
      return rec ? rec.value : null;
    },

    async findByIdentity(organizationScopeId, provider, externalId) {
      const records = await authority.scan<ExternalSettlementFactRecord>(COLLECTION);
      const match = records
        .map((r) => r.value)
        .find((r) => identityMatches(r, organizationScopeId, provider, externalId));
      return match ?? null;
    },

    async findByIdentityWithinTx(organizationScopeId, provider, externalId, tx) {
      const records = await tx.scan<ExternalSettlementFactRecord>(COLLECTION);
      const match = records
        .map((r) => r.value)
        .find((r) => identityMatches(r, organizationScopeId, provider, externalId));
      return match ?? null;
    },

    async listByOrganization(organizationScopeId) {
      const records = await authority.scan<ExternalSettlementFactRecord>(COLLECTION);
      return records
        .map((r) => r.value)
        .filter((r) => r.organizationScopeId === organizationScopeId)
        .sort(ordered);
    },

    async listByInternalTransaction(organizationScopeId, internalTransactionId) {
      const records = await authority.scan<ExternalSettlementFactRecord>(COLLECTION);
      return records
        .map((r) => r.value)
        .filter(
          (r) =>
            r.organizationScopeId === organizationScopeId &&
            r.internalTransactionId === internalTransactionId,
        )
        .sort(ordered);
    },

    async createWithinTx(record, tx) {
      // Create-once backstop: the authoritative transaction may race a
      // concurrently committed twin identity (the advisory mutex makes
      // this unreachable in practice; the in-tx scan still sees
      // same-transaction writes only, so a duplicate put of the SAME id
      // is a defensive conflict).
      const existing = await tx.get<ExternalSettlementFactRecord>(COLLECTION, record.id);
      if (existing) {
        throw new ExternalSettlementFactConflictError(
          `external settlement fact ${record.id} already exists`,
          { factId: record.id },
        );
      }
      await tx.put(COLLECTION, record.id, record);
      logger?.debug("external_settlement_fact.created_within_tx", {
        factId: record.id,
        provider: record.provider,
        externalId: record.externalId,
        transactionId: tx.transactionId,
      });
      return record;
    },
  };
}

export { COLLECTION as EXTERNAL_SETTLEMENT_FACTS_COLLECTION };
export type { AuthorityTransaction };
