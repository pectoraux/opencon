/**
 * Authority-backed ConversionRepository — persists the immutable
 * cash↔credits conversion records (append-only; reversals are status
 * transitions recorded on the record).
 *
 * Work order ref: NET-W008 §3.6 (explicit conversion entries — the
 * ONLY path between the cash and credits accounting concepts).
 *
 * Storage model: conversions live in the `economic_conversions`
 * collection keyed by conversion id. Idempotent recording is owned by
 * the IdempotencyStore.
 */

import type {
  AuthorityTransaction,
  PostgresAuthority,
} from "../core/postgres-authority.ts";
import type {
  ConversionRepository,
  EconomicConversion,
} from "./port.ts";

const COLLECTION = "economic_conversions";

export interface AuthorityConversionRepositoryOptions {
  readonly authority: PostgresAuthority;
  readonly logger?: {
    debug(message: string, fields?: Record<string, unknown>): void;
  };
}

export function createAuthorityConversionRepository(
  opts: AuthorityConversionRepositoryOptions,
): ConversionRepository {
  const authority = opts.authority;
  const logger = opts.logger;

  return {
    async findById(id) {
      const rec = await authority.get<EconomicConversion>(COLLECTION, id);
      return rec ? rec.value : null;
    },

    async listByOrganization(organizationScopeId) {
      const records = await authority.scan<EconomicConversion>(COLLECTION);
      return records
        .map((r) => r.value)
        .filter((c) => c.organizationScopeId === organizationScopeId)
        .sort((a, b) => {
          const ta = Date.parse(a.convertedAt);
          const tb = Date.parse(b.convertedAt);
          if (ta !== tb) return ta - tb;
          return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
        });
    },

    async findByIdWithinTx(id, tx) {
      const rec = await tx.get<EconomicConversion>(COLLECTION, id);
      return rec ? rec.value : null;
    },

    async createWithinTx(conversion, tx) {
      await tx.put(COLLECTION, conversion.id, conversion);
      logger?.debug("economic_conversion.created_within_tx", {
        conversionId: conversion.id,
        direction: conversion.direction,
        transactionId: tx.transactionId,
      });
      return conversion;
    },

    async saveWithinTx(conversion, tx) {
      await tx.put(COLLECTION, conversion.id, conversion);
      logger?.debug("economic_conversion.saved_within_tx", {
        conversionId: conversion.id,
        status: conversion.status,
        transactionId: tx.transactionId,
      });
      return conversion;
    },
  };
}

export { COLLECTION as ECONOMIC_CONVERSIONS_COLLECTION };
export type { AuthorityTransaction };
