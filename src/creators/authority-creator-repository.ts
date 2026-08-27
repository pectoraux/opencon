/**
 * Authority-backed CreatorProfileRepository +
 * CreatorProfileVersionRepository — persists the creator profile
 * records (with their append-only event histories) and the immutable
 * versioned profile sections through the PostgreSQL authority
 * boundary (NET-W003).
 *
 * Work order ref: NET-W015 §3.1–§3.2, §3.5.
 *
 * Storage model:
 *  - creator profiles live in the `creators` collection, keyed by
 *    record id, storing the full event history inline (append-only:
 *    events are only ever appended; the derived `status` flips
 *    through the audited creator-service command in the same
 *    transaction);
 *  - creator profile versions live in the
 *    `creator_profile_versions` collection, keyed by record id, one
 *    immutable record per (profileId, version) — existing versions
 *    are never rewritten.
 */

import type {
  AuthorityTransaction,
  PostgresAuthority,
} from "../core/postgres-authority.ts";
import type { ExecutionContext } from "../core/execution-context.ts";
import type {
  CreatorProfileRecord,
  CreatorProfileRepository,
  CreatorProfileVersion,
  CreatorProfileVersionRepository,
} from "./port.ts";

export const CREATORS_COLLECTION = "creators";
export const CREATOR_PROFILE_VERSIONS_COLLECTION =
  "creator_profile_versions";

function byCreatedAt(a: CreatorProfileRecord, b: CreatorProfileRecord): number {
  if (a.createdAt === b.createdAt) return a.id < b.id ? -1 : 1;
  return a.createdAt < b.createdAt ? -1 : 1;
}

function byVersion(a: CreatorProfileVersion, b: CreatorProfileVersion): number {
  return a.version - b.version;
}

export interface AuthorityCreatorRepositoryOptions {
  readonly authority: PostgresAuthority;
  readonly logger?: {
    debug(message: string, fields?: Record<string, unknown>): void;
  };
}

export function createAuthorityCreatorProfileRepository(
  opts: AuthorityCreatorRepositoryOptions,
): CreatorProfileRepository {
  const authority = opts.authority;
  const logger = opts.logger;

  return {
    async save(profile, execution) {
      return authority.run(execution, async (tx) => {
        await tx.put(CREATORS_COLLECTION, profile.id, profile);
        logger?.debug("creator_profile.saved", {
          profileId: profile.id,
          status: profile.status,
          executionId: execution.executionId,
        });
        return profile;
      });
    },

    async findById(id) {
      const rec = await authority.get<CreatorProfileRecord>(
        CREATORS_COLLECTION,
        id,
      );
      return rec ? rec.value : null;
    },

    async findByPerson(organizationScopeId, creatorPersonId) {
      const records = await authority.scan<CreatorProfileRecord>(
        CREATORS_COLLECTION,
      );
      let found: CreatorProfileRecord | null = null;
      for (const rec of records) {
        if (
          rec.value.organizationScopeId === organizationScopeId &&
          rec.value.creatorPersonId === creatorPersonId
        ) {
          // Deterministic pick on a structurally-impossible duplicate
          // (the service-level unique-anchor rule prevents these).
          if (found === null || rec.value.createdAt < found.createdAt) {
            found = rec.value;
          }
        }
      }
      return found;
    },

    async listByOrganization(organizationScopeId, statuses) {
      const records = await authority.scan<CreatorProfileRecord>(
        CREATORS_COLLECTION,
      );
      return records
        .map((rec) => rec.value)
        .filter(
          (profile) =>
            profile.organizationScopeId === organizationScopeId &&
            (statuses === undefined || statuses.includes(profile.status)),
        )
        .sort(byCreatedAt);
    },

    async findByIdWithinTx(id, tx) {
      const rec = await tx.get<CreatorProfileRecord>(
        CREATORS_COLLECTION,
        id,
      );
      return rec ? rec.value : null;
    },

    async findByPersonWithinTx(organizationScopeId, creatorPersonId, tx) {
      const records = await tx.scan<CreatorProfileRecord>(
        CREATORS_COLLECTION,
      );
      let found: CreatorProfileRecord | null = null;
      for (const rec of records) {
        if (
          rec.value.organizationScopeId === organizationScopeId &&
          rec.value.creatorPersonId === creatorPersonId
        ) {
          if (found === null || rec.value.createdAt < found.createdAt) {
            found = rec.value;
          }
        }
      }
      return found;
    },

    async createWithinTx(profile, tx) {
      const existing = await tx.get<CreatorProfileRecord>(
        CREATORS_COLLECTION,
        profile.id,
      );
      if (existing) {
        throw new Error(
          `creator profile already persisted: ${profile.id} (idempotent replay must go through the IdempotencyStore)`,
        );
      }
      await tx.put(CREATORS_COLLECTION, profile.id, profile);
      return profile;
    },

    async saveWithinTx(profile, tx) {
      await tx.put(CREATORS_COLLECTION, profile.id, profile);
      return profile;
    },
  };
}

export function createAuthorityCreatorProfileVersionRepository(
  opts: AuthorityCreatorRepositoryOptions,
): CreatorProfileVersionRepository {
  const authority = opts.authority;
  const logger = opts.logger;

  return {
    async findById(id) {
      const rec = await authority.get<CreatorProfileVersion>(
        CREATOR_PROFILE_VERSIONS_COLLECTION,
        id,
      );
      return rec ? rec.value : null;
    },

    async findVersion(profileId, version) {
      const records = await authority.scan<CreatorProfileVersion>(
        CREATOR_PROFILE_VERSIONS_COLLECTION,
      );
      for (const rec of records) {
        if (
          rec.value.profileId === profileId &&
          rec.value.version === version
        ) {
          return rec.value;
        }
      }
      return null;
    },

    async listByProfile(profileId) {
      const records = await authority.scan<CreatorProfileVersion>(
        CREATOR_PROFILE_VERSIONS_COLLECTION,
      );
      return records
        .map((rec) => rec.value)
        .filter((version) => version.profileId === profileId)
        .sort(byVersion);
    },

    async findVersionWithinTx(profileId, version, tx) {
      const records = await tx.scan<CreatorProfileVersion>(
        CREATOR_PROFILE_VERSIONS_COLLECTION,
      );
      for (const rec of records) {
        if (
          rec.value.profileId === profileId &&
          rec.value.version === version
        ) {
          return rec.value;
        }
      }
      return null;
    },

    async findLatestWithinTx(profileId, tx) {
      const records = await tx.scan<CreatorProfileVersion>(
        CREATOR_PROFILE_VERSIONS_COLLECTION,
      );
      let latest: CreatorProfileVersion | null = null;
      for (const rec of records) {
        if (rec.value.profileId !== profileId) continue;
        if (latest === null || rec.value.version > latest.version) {
          latest = rec.value;
        }
      }
      return latest;
    },

    async createWithinTx(version, tx) {
      const records = await tx.scan<CreatorProfileVersion>(
        CREATOR_PROFILE_VERSIONS_COLLECTION,
      );
      for (const rec of records) {
        if (
          rec.value.profileId === version.profileId &&
          rec.value.version === version.version
        ) {
          throw new Error(
            `creator profile version already persisted: ${version.profileId} v${String(version.version)} (idempotent replay must go through the IdempotencyStore)`,
          );
        }
      }
      await tx.put(
        CREATOR_PROFILE_VERSIONS_COLLECTION,
        version.id,
        version,
      );
      logger?.debug("creator_profile_version.created", {
        profileId: version.profileId,
        version: version.version,
      });
      return version;
    },
  };
}
