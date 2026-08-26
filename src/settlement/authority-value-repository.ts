/**
 * Authority-backed EconomicValueRepository — persists the pending/
 * mature economic value records through the PostgreSQL authority
 * boundary (NET-W003).
 *
 * Work order ref: NET-W008 §3.3 (pending value / explicit maturation).
 *
 * Storage model: value records live in the `economic_value_records`
 * collection keyed by record id. Records are created once; state
 * mutations (PENDING → MATURE → CONSUMED / REVERSED, and the
 * CONSUMED → MATURE restore on reversal of a consumption) are
 * version-checked read-modify-write operations inside the caller's
 * authoritative transaction (the same optimistic-concurrency contract
 * as the PoV lifecycle repositories). The amount, sources and
 * maturation policy are IMMUTABLE after recognition.
 */

import type {
  AuthorityTransaction,
  PostgresAuthority,
} from "../core/postgres-authority.ts";
import { OpenConError } from "../core/errors.ts";
import type { EconomicValueState } from "../core/economics.ts";
import type {
  EconomicValueRecord,
  EconomicValueRepository,
} from "./port.ts";

const COLLECTION = "economic_value_records";

export interface AuthorityEconomicValueRepositoryOptions {
  readonly authority: PostgresAuthority;
  readonly logger?: {
    debug(message: string, fields?: Record<string, unknown>): void;
  };
}

export class EconomicValueConflictError extends OpenConError {
  public constructor(message: string, context?: Readonly<Record<string, unknown>>) {
    super({
      code: "ECONOMIC_VALUE_CONFLICT",
      classification: "conflict",
      message,
      retryable: false,
      context,
    });
  }
}

export function createAuthorityEconomicValueRepository(
  opts: AuthorityEconomicValueRepositoryOptions,
): EconomicValueRepository {
  const authority = opts.authority;
  const logger = opts.logger;

  async function listFrom(
    organizationScopeId: string,
    beneficiaryPersonId: string,
    states: readonly EconomicValueState[] | undefined,
    scan: () => Promise<readonly { value: EconomicValueRecord }[]>,
  ): Promise<readonly EconomicValueRecord[]> {
    const records = await scan();
    return records
      .map((r) => r.value)
      .filter(
        (v) =>
          v.organizationScopeId === organizationScopeId &&
          v.beneficiaryPersonId === beneficiaryPersonId &&
          (states === undefined || states.includes(v.state)),
      )
      .sort((a, b) => {
        const ta = Date.parse(a.recordedAt);
        const tb = Date.parse(b.recordedAt);
        if (ta !== tb) return ta - tb;
        return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
      });
  }

  return {
    async findById(id) {
      const rec = await authority.get<EconomicValueRecord>(COLLECTION, id);
      return rec ? rec.value : null;
    },

    async listByBeneficiary(organizationScopeId, beneficiaryPersonId, states) {
      return listFrom(
        organizationScopeId,
        beneficiaryPersonId,
        states,
        () => authority.scan<EconomicValueRecord>(COLLECTION),
      );
    },

    async findByIdWithinTx(id, tx) {
      const rec = await tx.get<EconomicValueRecord>(COLLECTION, id);
      return rec ? rec.value : null;
    },

    async createWithinTx(record, tx) {
      await tx.put(COLLECTION, record.id, record);
      logger?.debug("economic_value.created_within_tx", {
        valueRecordId: record.id,
        amount: record.amount,
        transactionId: tx.transactionId,
      });
      return record;
    },

    async saveWithinTx(record, expectedVersion, tx) {
      const current = await tx.get<EconomicValueRecord>(COLLECTION, record.id);
      if (!current) {
        throw new EconomicValueConflictError(
          `economic value record ${record.id} not found for update`,
          { valueRecordId: record.id },
        );
      }
      if (current.value.version !== expectedVersion) {
        throw new EconomicValueConflictError(
          `stale writer for economic value record ${record.id}: expected version ${String(expectedVersion)}, authoritative version ${String(current.value.version)}`,
          {
            valueRecordId: record.id,
            expectedVersion,
            authoritativeVersion: current.value.version,
          },
        );
      }
      await tx.put(COLLECTION, record.id, record);
      logger?.debug("economic_value.saved_within_tx", {
        valueRecordId: record.id,
        state: record.state,
        version: record.version,
        transactionId: tx.transactionId,
      });
      return record;
    },
  };
}

export { COLLECTION as ECONOMIC_VALUE_RECORDS_COLLECTION };
export type { AuthorityTransaction };
