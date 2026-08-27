/**
 * Authority-backed HelpfulnessPolicyRepository +
 * ProofOfHelpfulnessRepository + CommercialDisclosureRepository —
 * persists the NET-W012 helpful-contribution records through the
 * PostgreSQL authority boundary (NET-W003).
 *
 * Work order ref: NET-W012 §3.5.
 *
 * Storage model:
 *  - helpfulness policies live in the `helpfulness_policies`
 *    collection, keyed by record id, one immutable record per
 *    (policyId, version) — existing versions are never rewritten;
 *  - proofs-of-helpfulness live in the `proofs_of_helpfulness`
 *    collection, keyed by record id AND by contribution id (1:1),
 *    storing the full append-only event/evaluation history inline;
 *  - commercial disclosures live in the `commercial_disclosures`
 *    collection, keyed by record id, append-only event history inline.
 */

import type {
  AuthorityTransaction,
  PostgresAuthority,
} from "../core/postgres-authority.ts";
import type { ExecutionContext } from "../core/execution-context.ts";
import type {
  CommercialDisclosureRecord,
  CommercialDisclosureRepository,
  HelpfulnessPolicy,
  HelpfulnessPolicyRepository,
  ProofOfHelpfulness,
  ProofOfHelpfulnessRepository,
} from "./port.ts";

const HELPFULNESS_POLICIES_COLLECTION = "helpfulness_policies";
const PROOFS_OF_HELPFULNESS_COLLECTION = "proofs_of_helpfulness";
const COMMERCIAL_DISCLOSURES_COLLECTION = "commercial_disclosures";

/** The neutral contribution-id → PoH-id index key (1:1 mapping). */
function contributionIndexKey(contributionId: string): string {
  return `contribution:${contributionId}`;
}

function byVersion(a: HelpfulnessPolicy, b: HelpfulnessPolicy): number {
  return a.version - b.version;
}

function byCreatedAt(
  a: CommercialDisclosureRecord,
  b: CommercialDisclosureRecord,
): number {
  if (a.createdAt === b.createdAt) return a.id < b.id ? -1 : 1;
  return a.createdAt < b.createdAt ? -1 : 1;
}

export interface AuthorityHelpfulnessRepositoryOptions {
  readonly authority: PostgresAuthority;
  readonly logger?: {
    debug(message: string, fields?: Record<string, unknown>): void;
  };
}

export function createAuthorityHelpfulnessPolicyRepository(
  opts: AuthorityHelpfulnessRepositoryOptions,
): HelpfulnessPolicyRepository {
  const authority = opts.authority;
  const logger = opts.logger;

  async function scanPolicies(): Promise<HelpfulnessPolicy[]> {
    const records = await authority.scan<HelpfulnessPolicy>(
      HELPFULNESS_POLICIES_COLLECTION,
    );
    return records.map((r) => r.value);
  }

  return {
    async findById(id) {
      const rec = await authority.get<HelpfulnessPolicy>(
        HELPFULNESS_POLICIES_COLLECTION,
        id,
      );
      return rec ? rec.value : null;
    },

    async findVersion(policyId, version) {
      const all = await scanPolicies();
      return (
        all.find(
          (p) => p.policyId === policyId && p.version === version,
        ) ?? null
      );
    },

    async listByPolicyId(policyId) {
      const all = await scanPolicies();
      return all.filter((p) => p.policyId === policyId).sort(byVersion);
    },

    async findVersionWithinTx(policyId, version, tx) {
      const rec = await tx.get<HelpfulnessPolicy>(
        HELPFULNESS_POLICIES_COLLECTION,
        `${policyId}:v${String(version)}`,
      );
      if (rec) return rec.value;
      // Fallback: scan within the transaction (the shim's tx.get is
      // key-exact; the canonical PostgreSQL adapter scans the same).
      const records = await tx.scan<HelpfulnessPolicy>(
        HELPFULNESS_POLICIES_COLLECTION,
      );
      return (
        records
          .map((r) => r.value)
          .find((p) => p.policyId === policyId && p.version === version) ??
        null
      );
    },

    async findLatestWithinTx(policyId, tx) {
      const records = await tx.scan<HelpfulnessPolicy>(
        HELPFULNESS_POLICIES_COLLECTION,
      );
      const versions = records
        .map((r) => r.value)
        .filter((p) => p.policyId === policyId)
        .sort(byVersion);
      return versions.length > 0 ? versions[versions.length - 1]! : null;
    },

    async createWithinTx(policy, tx) {
      await tx.put(
        HELPFULNESS_POLICIES_COLLECTION,
        `${policy.policyId}:v${String(policy.version)}`,
        policy,
      );
      logger?.debug("helpfulness_policy.created_within_tx", {
        policyId: policy.policyId,
        version: policy.version,
        transactionId: tx.transactionId,
      });
      return policy;
    },
  };
}

export function createAuthorityProofOfHelpfulnessRepository(
  opts: AuthorityHelpfulnessRepositoryOptions,
): ProofOfHelpfulnessRepository {
  const authority = opts.authority;
  const logger = opts.logger;

  return {
    async findById(id) {
      const rec = await authority.get<ProofOfHelpfulness>(
        PROOFS_OF_HELPFULNESS_COLLECTION,
        id,
      );
      return rec ? rec.value : null;
    },

    async findByContributionId(contributionId) {
      const index = await authority.get<string>(
        PROOFS_OF_HELPFULNESS_COLLECTION,
        contributionIndexKey(contributionId),
      );
      if (index) {
        const rec = await authority.get<ProofOfHelpfulness>(
          PROOFS_OF_HELPFULNESS_COLLECTION,
          index.value,
        );
        if (rec) return rec.value;
      }
      const records = await authority.scan<ProofOfHelpfulness>(
        PROOFS_OF_HELPFULNESS_COLLECTION,
      );
      return (
        records
          .map((r) => r.value)
          .find((p) => p.contributionId === contributionId) ?? null
      );
    },

    async findByIdWithinTx(id, tx) {
      const rec = await tx.get<ProofOfHelpfulness>(
        PROOFS_OF_HELPFULNESS_COLLECTION,
        id,
      );
      return rec ? rec.value : null;
    },

    async createWithinTx(record, tx) {
      await tx.put(PROOFS_OF_HELPFULNESS_COLLECTION, record.id, record);
      await tx.put(
        PROOFS_OF_HELPFULNESS_COLLECTION,
        contributionIndexKey(record.contributionId),
        record.id,
      );
      logger?.debug("proof_of_helpfulness.created_within_tx", {
        proofOfHelpfulnessId: record.id,
        contributionId: record.contributionId,
        transactionId: tx.transactionId,
      });
      return record;
    },

    async saveWithinTx(record, tx) {
      await tx.put(PROOFS_OF_HELPFULNESS_COLLECTION, record.id, record);
      logger?.debug("proof_of_helpfulness.saved_within_tx", {
        proofOfHelpfulnessId: record.id,
        state: record.state,
        transactionId: tx.transactionId,
      });
      return record;
    },
  };
}

export function createAuthorityCommercialDisclosureRepository(
  opts: AuthorityHelpfulnessRepositoryOptions,
): CommercialDisclosureRepository {
  const authority = opts.authority;
  const logger = opts.logger;

  return {
    async findById(id) {
      const rec = await authority.get<CommercialDisclosureRecord>(
        COMMERCIAL_DISCLOSURES_COLLECTION,
        id,
      );
      return rec ? rec.value : null;
    },

    async listByContribution(contributionId) {
      const records = await authority.scan<CommercialDisclosureRecord>(
        COMMERCIAL_DISCLOSURES_COLLECTION,
      );
      return records
        .map((r) => r.value)
        .filter((d) => d.contributionId === contributionId)
        .sort(byCreatedAt);
    },

    async findByIdWithinTx(id, tx) {
      const rec = await tx.get<CommercialDisclosureRecord>(
        COMMERCIAL_DISCLOSURES_COLLECTION,
        id,
      );
      return rec ? rec.value : null;
    },

    async listByContributionWithinTx(contributionId, tx) {
      const records = await tx.scan<CommercialDisclosureRecord>(
        COMMERCIAL_DISCLOSURES_COLLECTION,
      );
      return records
        .map((r) => r.value)
        .filter((d) => d.contributionId === contributionId)
        .sort(byCreatedAt);
    },

    async createWithinTx(record, tx) {
      await tx.put(COMMERCIAL_DISCLOSURES_COLLECTION, record.id, record);
      logger?.debug("commercial_disclosure.created_within_tx", {
        disclosureId: record.id,
        contributionId: record.contributionId,
        transactionId: tx.transactionId,
      });
      return record;
    },

    async saveWithinTx(record, tx) {
      await tx.put(COMMERCIAL_DISCLOSURES_COLLECTION, record.id, record);
      logger?.debug("commercial_disclosure.saved_within_tx", {
        disclosureId: record.id,
        state: record.state,
        transactionId: tx.transactionId,
      });
      return record;
    },
  };
}

export {
  HELPFULNESS_POLICIES_COLLECTION,
  PROOFS_OF_HELPFULNESS_COLLECTION,
  COMMERCIAL_DISCLOSURES_COLLECTION,
};

export type { ExecutionContext, AuthorityTransaction };
