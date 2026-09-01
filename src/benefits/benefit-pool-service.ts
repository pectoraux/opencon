/**
 * BenefitPoolService — NET-W028 Benefit Pools: the versioned
 * allocation policies, the tenant-scoped pool records, the DERIVED
 * allocation view and THE ATOMIC ALLOCATION OPERATION.
 *
 * Architecture ref: spec/architecture.md §5 (economic model), §17
 * (authoritative workflow), §18 (/benefits owns benefit allocation;
 * /settlement owns the economic ledger), §19 (PostgreSQL
 * authoritative); spec/architecture-lock.md §5 (economic authority),
 * §12 (execution lineage), §13 (economic safety invariants 19–21).
 *
 * AUTHORITY MODEL (the decision of record, work order §2 + issue #56
 * architectural constraints):
 *  - this service owns the POOL/POLICY/ALLOCATION-LINEAGE records
 *    (tenant-scoped, idempotent, atomically audited). It posts
 *    NOTHING to the ledger itself and creates no balances/accounts/
 *    credits/cash/rewards primitives: /settlement stays the SOLE
 *    economic authority;
 *  - the ONLY economic mutation is the /settlement reward-allocation
 *    DRAW executed through the neutral BenefitEconomicDrawPort on
 *    the CALLER'S authoritative transaction (the W020 remediation
 *    pattern — the draw's postings, draw record, exactly-once value
 *    consumption and buffered audit event commit WITH the pool
 *    allocation in ONE transaction, or nothing commits);
 *  - entitlement-only allocations (savings-funded pools) post
 *    NOTHING and mint NOTHING: they record the deterministic
 *    entitlement plan bounded by the AUTHORITATIVE verified savings
 *    value re-derived at the allocation anchor;
 *  - every cross-domain fact arrives READ-ONLY through the neutral
 *    lookups (membership over /organizations; value-record facts over
 *    /settlement's own repository; the CURRENT savings verdict over
 *    /demand's re-derivation; the reward-policy facts over
 *    /settlement) — nothing caller-asserted is ever authority.
 *
 * CONCURRENCY MODEL:
 *  - policy lineages: the ORGANIZATION-INDEPENDENT mutex
 *    `benefits_pool_policy_lineage:{policyId}` around the whole
 *    create (lineage read → scope check → version check → create →
 *    commit — the NET-W007 pattern; a lineage can never fork);
 *  - pools: the per-pool mutex `benefits_pool:{id}` around every
 *    material pool mutation (the W027 per-pool serialization);
 *  - economic draws: the EXACT lock set the draw's standalone form
 *    would acquire (the value-record lock, then the account locks in
 *    ascending id order — the posting.ts discipline) held ACROSS the
 *    authoritative transaction so the locked accounts are always the
 *    posted accounts;
 *  - every material mutation runs inside ONE
 *    IdempotencyStore.applyIdempotent composite on ONE
 *    AuthorityTransaction with the audit buffered on that transaction
 *    (post-commit publication — a failed commit discards the audit;
 *    a successful commit publishes it).
 */

import { randomUUID } from "node:crypto";
import { toEconomicMinorUnits } from "../core/economics.ts";
import { AuthorizationError, NotFoundError } from "../core/errors.ts";
import type { ExecutionContext } from "../core/execution-context.ts";
import type { IdempotentApplyContext } from "../core/idempotency.ts";
import {
  BENEFIT_ALLOCATION_POLICY_VERSION,
  BENEFIT_ELIGIBILITY_CRITERIA,
  BENEFIT_MAX_FUNDING_REFS,
  BENEFIT_MAX_MEMBERS,
  BENEFIT_POOL_ALLOCATION_RECORD_FORMAT,
  BENEFIT_POOL_POLICY_RECORD_FORMAT,
  BENEFIT_POOL_RECORD_FORMAT,
  BENEFIT_REMAINDER_DISPOSITIONS,
  BENEFIT_TYPES,
  InvalidBenefitPoolError,
  isBenefitEligibilityCriterion,
  isBenefitFundingSourceKind,
  isBenefitRemainderDisposition,
  isBenefitType,
} from "./port.ts";
import type {
  AllocatePoolBenefitsInput,
  AllocatePoolBenefitsResult,
  BenefitAllocationPolicy,
  BenefitEconomicDrawFacts,
  BenefitMemberView,
  BenefitPool,
  BenefitPoolAllocation,
  BenefitPoolAllocationView,
  BenefitPoolCheck,
  BenefitPoolRepository,
  BenefitPoolService,
  BenefitPoolServiceDeps,
  BenefitRemainderDisposition,
  CloseBenefitPoolInput,
  CreateBenefitPoolInput,
  CreateBenefitPoolPolicyInput,
  CreateBenefitPoolPolicyResult,
  CreateBenefitPoolResult,
} from "./port.ts";
import {
  computeBenefitAllocationDigest,
  computeBenefitAllocationPlan,
} from "./allocation-engine.ts";

const BENEFITS_POLICY_VERSION_CREATED = "benefits_policy.version_created" as const;
const BENEFITS_POOL_CREATED = "benefits_pool.created" as const;
const BENEFITS_POOL_CLOSED = "benefits_pool.closed" as const;
const BENEFITS_POOL_ALLOCATION_RECORDED =
  "benefits_pool.allocation_recorded" as const;

/** The bounded prose length for descriptions. */
const BENEFIT_MAX_PROSE_CHARS = 2000;

function benefitsError(
  message: string,
  context: Readonly<Record<string, unknown>>,
): InvalidBenefitPoolError {
  return new InvalidBenefitPoolError(message, context);
}

function assertIdempotencyKey(idempotencyKey: string): string {
  if (typeof idempotencyKey !== "string" || !idempotencyKey.trim()) {
    throw benefitsError("idempotencyKey is required", {
      field: "idempotencyKey",
    });
  }
  return idempotencyKey;
}

function assertOrganizationScopeId(organizationScopeId: string): string {
  if (
    typeof organizationScopeId !== "string" ||
    !organizationScopeId.trim()
  ) {
    throw benefitsError("organizationScopeId is required", {
      field: "organizationScopeId",
    });
  }
  return organizationScopeId;
}

function assertPolicyId(policyId: string): string {
  if (typeof policyId !== "string" || !policyId.trim()) {
    throw benefitsError("policyId is required", { field: "policyId" });
  }
  return policyId;
}

function assertPoolId(poolId: string): string {
  if (typeof poolId !== "string" || !poolId.trim()) {
    throw benefitsError("poolId is required", { field: "poolId" });
  }
  return poolId;
}

/** The acting person's id (recorded as createdBy). */
function actingPersonId(execution: ExecutionContext): string {
  if (!execution.actor || execution.actor.kind !== "person") {
    throw new AuthorizationError(
      "benefit pool commands require an authenticated person actor",
      { actorKind: execution.actor?.kind ?? null },
    );
  }
  return execution.actor.id;
}

function nowIso(): string {
  return new Date().toISOString();
}

export function createBenefitPoolService(
  deps: BenefitPoolServiceDeps,
): BenefitPoolService {
  const {
    policyRepository,
    poolRepository,
    allocationRepository,
    lookups,
    idempotency,
    auditWriter,
    logger,
  } = deps;

  async function requireActiveMember(
    organizationScopeId: string,
    personId: string,
  ): Promise<void> {
    const active = await lookups.membership.isActiveMember(
      organizationScopeId,
      personId,
    );
    if (!active) {
      throw new AuthorizationError(
        "the acting person must hold active membership in the organization scope",
        { organizationScopeId, actorPersonId: personId },
      );
    }
  }

  async function requirePool(
    organizationScopeId: string,
    poolId: string,
  ): Promise<BenefitPool> {
    const pool = await poolRepository.findById(poolId);
    if (!pool || pool.organizationScopeId !== organizationScopeId) {
      // Cross-tenant is indistinguishable from nonexistent (no
      // existence oracle — issue #56 invariant 8).
      throw new NotFoundError(`benefit pool not found: ${poolId}`, {
        poolId,
        organizationScopeId,
      });
    }
    return pool;
  }

  function requirePoolCreator(actor: string, pool: BenefitPool): void {
    if (actor !== pool.createdBy) {
      throw new AuthorizationError(
        "only the benefit pool's creator may perform this action",
        {
          actorPersonId: actor,
          createdBy: pool.createdBy,
          poolId: pool.id,
        },
      );
    }
  }

  async function requirePolicy(
    organizationScopeId: string,
    policyId: string,
    version: number,
  ): Promise<BenefitAllocationPolicy> {
    const policy = await policyRepository.findVersion(policyId, version);
    if (
      !policy ||
      policy.organizationScopeId !== organizationScopeId
    ) {
      throw new NotFoundError(
        `benefit allocation policy version not found: ${policyId}#${version}`,
        { policyId, version, organizationScopeId },
      );
    }
    return policy;
  }

  async function appendAudit(
    tx: IdempotentApplyContext["transaction"],
    execution: ExecutionContext,
    event: {
      readonly eventType: string;
      readonly actor: string;
      readonly subject: string;
      readonly resourceType: string;
      readonly resourceId: string;
      readonly metadata: Record<string, unknown>;
    },
  ): Promise<void> {
    const buffer = auditWriter.forTransaction(tx);
    await buffer.append({
      eventType: event.eventType,
      context: execution,
      actor: event.actor,
      subject: event.subject,
      resourceType: event.resourceType,
      resourceId: event.resourceId,
      metadata: {
        ...event.metadata,
        transactionId: tx.transactionId,
      },
    });
  }

  /**
   * Acquire the draw lock set: the value-record lock first, then the
   * account locks in ascending id order (the posting.ts discipline —
   * domain-record lock before account locks, accounts globally
   * sorted; no wait cycle can form).
   */
  async function withDrawLocks<T>(
    lockKeys: {
      readonly recordLockKey: string;
      readonly accountIds: readonly string[];
    },
    fn: () => Promise<T>,
  ): Promise<T> {
    const run = async (keys: readonly string[]): Promise<T> => {
      if (keys.length === 0) return fn();
      const [head, ...rest] = keys;
      return idempotency.withLock(head!, () => run(rest));
    };
    const accountKeys = [...new Set(lockKeys.accountIds)]
      .sort()
      .map((accountId) => `economic_ledger_account:${accountId}`);
    return run([lockKeys.recordLockKey, ...accountKeys]);
  }

  // -----------------------------------------------------------------
  // Funding + eligibility re-derivation (the authoritative bar)
  // -----------------------------------------------------------------

  /**
   * Re-derive the CURRENT funding resolution for every declared
   * reference. Economic value records resolve IN-TX (fresh reads over
   * the economic authority's own repository); savings resolve through
   * the neutral re-derivation lookup (committed reads — the W020
   * in-tx neutral-lookup precedent). EVERY reference must qualify or
   * the funding fails closed (work order §3.2).
   */
  async function deriveFunding(
    pool: BenefitPool,
    tx: IdempotentApplyContext["transaction"],
  ): Promise<{
    readonly funding: readonly {
      readonly kind: string;
      readonly id: string;
      readonly qualified: boolean;
      readonly resolvedAmount: number | null;
      readonly reason: string | null;
    }[];
    readonly availableFunding: number;
  }> {
    const funding: {
      kind: string;
      id: string;
      qualified: boolean;
      resolvedAmount: number | null;
      reason: string | null;
    }[] = [];
    let availableMinor = 0;
    for (const ref of pool.fundingRefs) {
      if (ref.kind === "economic_value") {
        const facts = await lookups.valueFunding.resolveWithinTx(ref.id, tx);
        if (!facts) {
          funding.push({
            kind: ref.kind,
            id: ref.id,
            qualified: false,
            resolvedAmount: null,
            reason: "value record not found",
          });
          continue;
        }
        if (facts.organizationScopeId !== pool.organizationScopeId) {
          funding.push({
            kind: ref.kind,
            id: ref.id,
            qualified: false,
            resolvedAmount: null,
            reason: "cross-scope value record",
          });
          continue;
        }
        if (facts.reversed) {
          funding.push({
            kind: ref.kind,
            id: ref.id,
            qualified: false,
            resolvedAmount: null,
            reason: "value record reversed",
          });
          continue;
        }
        if (facts.consumed) {
          funding.push({
            kind: ref.kind,
            id: ref.id,
            qualified: false,
            resolvedAmount: null,
            reason: "value record already consumed exactly-once",
          });
          continue;
        }
        if (facts.state !== "MATURE") {
          funding.push({
            kind: ref.kind,
            id: ref.id,
            qualified: false,
            resolvedAmount: null,
            reason: `value record state ${facts.state} is not MATURE (pending value is not consumable — architecture-lock invariant 19)`,
          });
          continue;
        }
        if (!(facts.amount > 0)) {
          funding.push({
            kind: ref.kind,
            id: ref.id,
            qualified: false,
            resolvedAmount: null,
            reason: "value record amount is not positive",
          });
          continue;
        }
        availableMinor += toEconomicMinorUnits(facts.amount);
        funding.push({
          kind: ref.kind,
          id: ref.id,
          qualified: true,
          resolvedAmount: facts.amount,
          reason: null,
        });
      } else {
        const facts = await lookups.savingsFunding.resolveCurrent(ref.id);
        if (!facts) {
          funding.push({
            kind: ref.kind,
            id: ref.id,
            qualified: false,
            resolvedAmount: null,
            reason: "savings record not found",
          });
          continue;
        }
        if (facts.organizationScopeId !== pool.organizationScopeId) {
          funding.push({
            kind: ref.kind,
            id: ref.id,
            qualified: false,
            resolvedAmount: null,
            reason: "cross-scope savings record",
          });
          continue;
        }
        if (!facts.supported || facts.savingsValue === null) {
          funding.push({
            kind: ref.kind,
            id: ref.id,
            qualified: false,
            resolvedAmount: null,
            reason:
              "the CURRENT savings re-derivation is not supported (invalid, stale or insufficient evidence — funding fails closed)",
          });
          continue;
        }
        if (!(facts.savingsValue > 0)) {
          funding.push({
            kind: ref.kind,
            id: ref.id,
            qualified: false,
            resolvedAmount: null,
            reason:
              "the current derived savings value is not positive (honest realized dis-savings cannot fund a pool)",
          });
          continue;
        }
        availableMinor += toEconomicMinorUnits(facts.savingsValue);
        funding.push({
          kind: ref.kind,
          id: ref.id,
          qualified: true,
          resolvedAmount: facts.savingsValue,
          reason: null,
        });
      }
    }
    return { funding, availableFunding: availableMinor / 1_000_000 };
  }

  /**
   * Re-derive the CURRENT member eligibility (server-side, from the
   * pinned policy version + the authoritative membership lookup —
   * never caller-asserted).
   */
  async function deriveEligibility(
    organizationScopeId: string,
    policy: BenefitAllocationPolicy,
  ): Promise<{
    readonly eligible: boolean;
    readonly members: readonly {
      readonly personId: string;
      readonly weight: number;
    }[];
    readonly ineligibleMemberIds: readonly string[];
  }> {
    const ineligible: string[] = [];
    for (const declaration of policy.memberDeclarations) {
      const active = await lookups.membership.isActiveMember(
        organizationScopeId,
        declaration.personId,
      );
      if (!active) ineligible.push(declaration.personId);
    }
    return {
      eligible: ineligible.length === 0,
      members: policy.memberDeclarations,
      ineligibleMemberIds: ineligible,
    };
  }

  // -----------------------------------------------------------------
  // The service
  // -----------------------------------------------------------------

  const service: BenefitPoolService = {
    async createPolicyVersion(
      execution,
      input,
    ): Promise<CreateBenefitPoolPolicyResult> {
      assertOrganizationScopeId(input.organizationScopeId);
      assertPolicyId(input.policyId);
      assertIdempotencyKey(input.idempotencyKey);
      if (
        typeof input.version !== "number" ||
        !Number.isInteger(input.version) ||
        input.version < 1
      ) {
        throw benefitsError(
          "policy version must be a positive integer (exactly latest+1 for an existing lineage, or 1 to start a new one)",
          { version: input.version },
        );
      }
      const actor = actingPersonId(execution);
      await requireActiveMember(input.organizationScopeId, actor);

      // ---- Validation of the declaration set (pure) ----------------
      if (!isBenefitType(input.benefitType)) {
        throw benefitsError(
          `benefitType must be a closed-vocabulary benefit type (got ${String(input.benefitType)}; vocabulary: ${BENEFIT_TYPES.join(", ")})`,
          { benefitType: String(input.benefitType) },
        );
      }
      // Narrowed capture-locals (the W018 capture-local pattern — the
      // narrowing survives the nested closures below).
      const benefitType: import("./port.ts").BenefitType = input.benefitType;
      if (
        !Array.isArray(input.eligibilityCriteria) ||
        input.eligibilityCriteria.length === 0
      ) {
        throw benefitsError(
          "eligibilityCriteria must be a non-empty array of closed-vocabulary criteria",
          { field: "eligibilityCriteria" },
        );
      }
      const criteria: import("./port.ts").BenefitEligibilityCriterion[] = [];
      for (const criterion of input.eligibilityCriteria) {
        if (
          typeof criterion !== "string" ||
          !isBenefitEligibilityCriterion(criterion)
        ) {
          throw benefitsError(
            `eligibility criterion must be from the closed vocabulary (got ${String(criterion)}; vocabulary: ${BENEFIT_ELIGIBILITY_CRITERIA.join(", ")})`,
            { criterion: String(criterion) },
          );
        }
        if (!criteria.includes(criterion)) criteria.push(criterion);
      }
      if (
        !Array.isArray(input.memberDeclarations) ||
        input.memberDeclarations.length === 0
      ) {
        throw benefitsError(
          "memberDeclarations must be a non-empty ordered array (the deterministic allocation order)",
          { field: "memberDeclarations" },
        );
      }
      if (input.memberDeclarations.length > BENEFIT_MAX_MEMBERS) {
        throw benefitsError(
          `memberDeclarations may declare at most ${String(BENEFIT_MAX_MEMBERS)} members (got ${String(input.memberDeclarations.length)})`,
          { memberCount: input.memberDeclarations.length },
        );
      }
      const memberDeclarations: {
        personId: string;
        weight: number;
      }[] = [];
      const seenPersonIds = new Set<string>();
      for (const declaration of input.memberDeclarations) {
        if (!declaration || typeof declaration !== "object") {
          throw benefitsError(
            "each member declaration must be an object {personId, weight}",
            { field: "memberDeclarations" },
          );
        }
        const personId = (declaration as { readonly personId?: unknown }).personId;
        if (typeof personId !== "string" || !personId.trim()) {
          throw benefitsError(
            "each member declaration requires a non-empty personId",
            { field: "memberDeclarations.personId" },
          );
        }
        if (seenPersonIds.has(personId)) {
          throw benefitsError(
            `member ${personId} is declared more than once (members are unique)`,
            { personId },
          );
        }
        seenPersonIds.add(personId);
        const weight = (declaration as { readonly weight?: unknown }).weight;
        if (
          typeof weight !== "number" ||
          !Number.isFinite(weight) ||
          weight <= 0
        ) {
          throw benefitsError(
            `member ${personId} weight must be a finite number > 0 (got ${String(weight)})`,
            { personId, weight },
          );
        }
        // ≤ 6 decimals (the scaled-integer arithmetic discipline).
        const weightMinor = toEconomicMinorUnits(weight);
        if (weightMinor <= 0) {
          throw benefitsError(
            `member ${personId} weight must carry at most 6 decimals (got ${String(weight)})`,
            { personId, weight },
          );
        }
        memberDeclarations.push({ personId, weight });
      }
      if (!isBenefitRemainderDisposition(input.remainderDisposition)) {
        throw benefitsError(
          `remainderDisposition must be from the closed vocabulary (got ${String(input.remainderDisposition)}; vocabulary: ${BENEFIT_REMAINDER_DISPOSITIONS.join(", ")})`,
          { remainderDisposition: String(input.remainderDisposition) },
        );
      }
      const remainderDisposition: import("./port.ts").BenefitRemainderDisposition =
        input.remainderDisposition;
      if (
        input.rewardPolicyId !== undefined &&
        input.rewardPolicyId !== null &&
        (typeof input.rewardPolicyId !== "string" || !input.rewardPolicyId.trim())
      ) {
        throw benefitsError(
          "rewardPolicyId, when present, must be a non-empty /settlement reward policy id",
          { rewardPolicyId: String(input.rewardPolicyId) },
        );
      }
      const description =
        input.description === undefined || input.description === null
          ? null
          : String(input.description);
      if (description !== null && description.length > BENEFIT_MAX_PROSE_CHARS) {
        throw benefitsError(
          `description must be at most ${String(BENEFIT_MAX_PROSE_CHARS)} characters`,
          { descriptionLength: description.length },
        );
      }

      // ---- The ORG-INDEPENDENT lineage mutex (fork prevention) ----
      return idempotency.withLock(
        `benefits_pool_policy_lineage:${input.policyId}`,
        async (): Promise<CreateBenefitPoolPolicyResult> => {
          const key = `benefits_policy:${input.organizationScopeId}:${input.policyId}:${input.version}:${actor}:${input.idempotencyKey}`;
          const applied = await idempotency.applyIdempotent(
            key,
            async (ctx): Promise<CreateBenefitPoolPolicyResult> => {
              const tx = ctx.transaction;
              // In-tx lineage reads (TOCTOU closure): the
              // ORGANIZATION-INDEPENDENT lineage read (any scope) +
              // the in-scope latest version.
              const anyVersion = await policyRepository.findAnyVersion(
                input.policyId,
              );
              if (
                anyVersion &&
                anyVersion.organizationScopeId !== input.organizationScopeId
              ) {
                throw new InvalidBenefitPoolError(
                  `benefit policy lineage ${input.policyId} already exists in organization scope ${anyVersion.organizationScopeId} — a lineage can never fork across tenant scope`,
                  {
                    policyId: input.policyId,
                    lineageScope: anyVersion.organizationScopeId,
                    inputScope: input.organizationScopeId,
                  },
                );
              }
              const latest = await policyRepository.findLatestVersion(
                input.policyId,
                input.organizationScopeId,
              );
              if (input.version === 1) {
                if (latest) {
                  throw new InvalidBenefitPoolError(
                    `benefit policy lineage ${input.policyId} already exists in this scope at version ${String(latest.version)} — start-new lineages at a fresh policyId`,
                    { policyId: input.policyId, existingVersion: latest.version },
                  );
                }
              } else {
                if (!latest) {
                  throw new InvalidBenefitPoolError(
                    `benefit policy lineage ${input.policyId} does not exist in this scope — start a new lineage at version 1`,
                    { policyId: input.policyId },
                  );
                }
                if (input.version !== latest.version + 1) {
                  throw new InvalidBenefitPoolError(
                    `benefit policy version must be exactly latest+1 (${String(latest.version + 1)} for lineage ${input.policyId}; got ${String(input.version)})`,
                    {
                      policyId: input.policyId,
                      latestVersion: latest.version,
                      requestedVersion: input.version,
                    },
                  );
                }
              }
              const policy: BenefitAllocationPolicy = {
                id: randomUUID(),
                policyId: input.policyId,
                version: input.version,
                organizationScopeId: input.organizationScopeId,
                benefitType,
                eligibilityCriteria: Object.freeze([...criteria]),
                memberDeclarations: Object.freeze(
                  memberDeclarations.map((d) => Object.freeze({ ...d })),
                ),
                remainderDisposition,
                rewardPolicyId:
                  input.rewardPolicyId === undefined ||
                  input.rewardPolicyId === null
                    ? null
                    : input.rewardPolicyId,
                description,
                createdBy: actor,
                createdAt: nowIso(),
                recordFormat: BENEFIT_POOL_POLICY_RECORD_FORMAT,
                idempotencyKey: input.idempotencyKey,
                executionId: execution.executionId,
                correlationId: execution.correlationId,
                causationId: execution.causationId,
              };
              const created = await policyRepository.createWithinTx(
                policy,
                tx,
              );
              await appendAudit(tx, execution, {
                eventType: BENEFITS_POLICY_VERSION_CREATED,
                actor,
                subject: input.policyId,
                resourceType: "benefit_allocation_policy",
                resourceId: created.id,
                metadata: {
                  policyId: created.policyId,
                  version: created.version,
                  organizationScopeId: created.organizationScopeId,
                  benefitType: created.benefitType,
                  memberCount: created.memberDeclarations.length,
                  remainderDisposition: created.remainderDisposition,
                  rewardPolicyId: created.rewardPolicyId,
                  idempotencyRecordId: ctx.recordId,
                },
              });
              return { policy: created, created: true };
            },
            execution,
          );
          const result = applied.result;
          logger.info("benefits_policy.version_created", {
            policyId: result.policy.policyId,
            version: result.policy.version,
            organizationScopeId: result.policy.organizationScopeId,
            executionId: execution.executionId,
          });
          return { policy: result.policy, created: applied.executed };
        },
      );
    },

    async getPolicy(execution, input) {
      assertOrganizationScopeId(input.organizationScopeId);
      assertPolicyId(input.policyId);
      actingPersonId(execution);
      const policy =
        input.version === undefined
          ? await policyRepository.findLatestVersion(
              input.policyId,
              input.organizationScopeId,
            )
          : await policyRepository.findVersion(input.policyId, input.version);
      if (!policy || policy.organizationScopeId !== input.organizationScopeId) {
        throw new NotFoundError(
          `benefit allocation policy not found in scope ${input.organizationScopeId}: ${input.policyId}`,
          { policyId: input.policyId },
        );
      }
      return policy;
    },

    async listPolicyVersions(execution, input) {
      assertOrganizationScopeId(input.organizationScopeId);
      assertPolicyId(input.policyId);
      actingPersonId(execution);
      const versions = await policyRepository.listVersions(
        input.policyId,
        input.organizationScopeId,
      );
      if (versions.length === 0) {
        throw new NotFoundError(
          `benefit allocation policy not found in scope ${input.organizationScopeId}: ${input.policyId}`,
          { policyId: input.policyId },
        );
      }
      return versions;
    },

    async createBenefitPool(
      execution,
      input,
    ): Promise<CreateBenefitPoolResult> {
      assertOrganizationScopeId(input.organizationScopeId);
      assertPolicyId(input.policyId);
      assertIdempotencyKey(input.idempotencyKey);
      const actor = actingPersonId(execution);
      await requireActiveMember(input.organizationScopeId, actor);

      // ---- Funding reference SHAPE validation (pure) ---------------
      // NOTE: there is deliberately NO funded-amount input anywhere —
      // funding resolves server-side at EVERY use (issue #56 key
      // invariant 2: a caller-asserted balance is never authority).
      if (
        !Array.isArray(input.fundingRefs) ||
        input.fundingRefs.length === 0
      ) {
        throw benefitsError(
          "fundingRefs must be a non-empty array of {kind, id} references",
          { field: "fundingRefs" },
        );
      }
      if (input.fundingRefs.length > BENEFIT_MAX_FUNDING_REFS) {
        throw benefitsError(
          `fundingRefs may declare at most ${String(BENEFIT_MAX_FUNDING_REFS)} references (got ${String(input.fundingRefs.length)})`,
          { fundingRefCount: input.fundingRefs.length },
        );
      }
      const fundingRefs: {
        kind: "economic_value" | "verified_savings";
        id: string;
      }[] = [];
      const seenRefs = new Set<string>();
      for (const ref of input.fundingRefs) {
        if (!ref || typeof ref !== "object") {
          throw benefitsError(
            "each funding reference must be an object {kind, id}",
            { field: "fundingRefs" },
          );
        }
        const kind = (ref as { readonly kind?: unknown }).kind;
        if (
          typeof kind !== "string" ||
          !isBenefitFundingSourceKind(kind)
        ) {
          throw benefitsError(
            `funding reference kind must be from the closed vocabulary (got ${String(kind)}; vocabulary: economic_value | verified_savings)`,
            { kind: String(kind) },
          );
        }
        const id = (ref as { readonly id?: unknown }).id;
        if (typeof id !== "string" || !id.trim()) {
          throw benefitsError(
            "each funding reference requires a non-empty id",
            { field: "fundingRefs.id" },
          );
        }
        const composite = `${kind}:${id}`;
        if (seenRefs.has(composite)) {
          throw benefitsError(
            `funding reference ${composite} is declared more than once (references are unique)`,
            { kind, id },
          );
        }
        seenRefs.add(composite);
        fundingRefs.push({ kind, id });
      }

      // ---- Committed pre-flight: the pinned policy version ---------
      const policy = await requirePolicy(
        input.organizationScopeId,
        input.policyId,
        input.policyVersion === undefined
          ? ((
              await policyRepository.findLatestVersion(
                input.policyId,
                input.organizationScopeId,
              )
            )?.version ?? -1)
          : input.policyVersion,
      );
      if (
        input.policyVersion !== undefined &&
        input.policyVersion !== policy.version
      ) {
        // Unreachable (requirePolicy resolved the exact version);
        // kept as the defensive guard.
        throw benefitsError(
          `the pinned policy version ${String(input.policyVersion)} does not resolve`,
          { policyId: input.policyId, version: input.policyVersion },
        );
      }

      const key = `benefits_pool:${input.organizationScopeId}:${input.policyId}:${policy.version}:${actor}:${input.idempotencyKey}`;
      const applied = await idempotency.applyIdempotent(
        key,
        async (ctx): Promise<CreateBenefitPoolResult> => {
          const tx = ctx.transaction;
          // In-tx fresh policy re-read (TOCTOU closure — the pinned
          // version must still resolve in-scope at commit time).
          const freshPolicy = await policyRepository.findVersionWithinTx(
            input.policyId,
            policy.version,
            tx,
          );
          if (
            !freshPolicy ||
            freshPolicy.organizationScopeId !== input.organizationScopeId
          ) {
            throw new NotFoundError(
              `benefit allocation policy version not found within tx: ${input.policyId}#${policy.version}`,
              { policyId: input.policyId, version: policy.version },
            );
          }
          const pool: BenefitPool = {
            id: randomUUID(),
            organizationScopeId: input.organizationScopeId,
            policyId: freshPolicy.policyId,
            policyVersion: freshPolicy.version,
            benefitType: freshPolicy.benefitType,
            fundingRefs: Object.freeze(
              fundingRefs.map((ref) => Object.freeze({ ...ref })),
            ),
            createdBy: actor,
            createdAt: nowIso(),
            closedAt: null,
            recordFormat: BENEFIT_POOL_RECORD_FORMAT,
            idempotencyKey: input.idempotencyKey,
            executionId: execution.executionId,
            correlationId: execution.correlationId,
            causationId: execution.causationId,
          };
          const created = await poolRepository.createWithinTx(pool, tx);
          await appendAudit(tx, execution, {
            eventType: BENEFITS_POOL_CREATED,
            actor,
            subject: created.id,
            resourceType: "benefit_pool",
            resourceId: created.id,
            metadata: {
              organizationScopeId: created.organizationScopeId,
              policyId: created.policyId,
              policyVersion: created.policyVersion,
              benefitType: created.benefitType,
              fundingRefCount: created.fundingRefs.length,
              fundingKinds: created.fundingRefs.map((ref) => ref.kind),
              idempotencyRecordId: ctx.recordId,
            },
          });
          return { pool: created, created: true };
        },
        execution,
      );
      const result = applied.result;
      logger.info("benefits_pool.created", {
        poolId: result.pool.id,
        organizationScopeId: result.pool.organizationScopeId,
        executionId: execution.executionId,
      });
      return { pool: result.pool, created: applied.executed };
    },

    async closeBenefitPool(
      execution,
      input: CloseBenefitPoolInput,
    ): Promise<BenefitPool> {
      assertOrganizationScopeId(input.organizationScopeId);
      assertPoolId(input.poolId);
      assertIdempotencyKey(input.idempotencyKey);
      const actor = actingPersonId(execution);
      await requireActiveMember(input.organizationScopeId, actor);
      // Committed pre-flight (the in-tx re-check below is the
      // authoritative backstop).
      const pool = await requirePool(input.organizationScopeId, input.poolId);
      requirePoolCreator(actor, pool);

      return idempotency.withLock(
        `benefits_pool:${input.poolId}`,
        async (): Promise<BenefitPool> => {
          const key = `benefits_pool_close:${input.organizationScopeId}:${input.poolId}:${actor}:${input.idempotencyKey}`;
          const applied = await idempotency.applyIdempotent(
            key,
            async (ctx): Promise<BenefitPool> => {
              const tx = ctx.transaction;
              // In-tx fresh pool read + scope + creator re-check.
              const freshPool = await poolRepository.findByIdWithinTx(
                input.poolId,
                tx,
              );
              if (
                !freshPool ||
                freshPool.organizationScopeId !== input.organizationScopeId
              ) {
                throw new NotFoundError(
                  `benefit pool not found: ${input.poolId}`,
                  { poolId: input.poolId },
                );
              }
              requirePoolCreator(actor, freshPool);
              if (freshPool.closedAt !== null) {
                throw new InvalidBenefitPoolError(
                  `benefit pool ${input.poolId} is already closed (ONE-WAY closure — a closed pool can never re-open or allocate again)`,
                  { poolId: input.poolId, closedAt: freshPool.closedAt },
                );
              }
              const closed = await poolRepository.closeWithinTx(
                input.poolId,
                nowIso(),
                tx,
              );
              await appendAudit(tx, execution, {
                eventType: BENEFITS_POOL_CLOSED,
                actor,
                subject: closed.id,
                resourceType: "benefit_pool",
                resourceId: closed.id,
                metadata: {
                  organizationScopeId: closed.organizationScopeId,
                  closedAt: closed.closedAt,
                  idempotencyRecordId: ctx.recordId,
                },
              });
              return closed;
            },
            execution,
          );
          logger.info("benefits_pool.closed", {
            poolId: applied.result.id,
            organizationScopeId: applied.result.organizationScopeId,
            executionId: execution.executionId,
          });
          return applied.result;
        },
      );
    },

    async getBenefitPool(execution, input) {
      assertOrganizationScopeId(input.organizationScopeId);
      assertPoolId(input.poolId);
      const actor = actingPersonId(execution);
      const pool = await requirePool(input.organizationScopeId, input.poolId);
      requirePoolCreator(actor, pool);
      return pool;
    },

    async listBenefitPools(execution, input) {
      assertOrganizationScopeId(input.organizationScopeId);
      const actor = actingPersonId(execution);
      // Creator-scoped listing (the W027 pool-creator read surface).
      return poolRepository.listByOrganization(input.organizationScopeId, {
        createdBy: actor,
      });
    },

    async evaluatePoolAllocation(
      execution,
      input,
    ): Promise<BenefitPoolAllocationView> {
      assertOrganizationScopeId(input.organizationScopeId);
      assertPoolId(input.poolId);
      const actor = actingPersonId(execution);
      await requireActiveMember(input.organizationScopeId, actor);
      const pool = await requirePool(input.organizationScopeId, input.poolId);
      requirePoolCreator(actor, pool);

      const evaluatedAt = nowIso();
      // Committed reads (the derived 200 decision; the allocation
      // command re-derives everything IN-TX as the authoritative bar).
      const policy = await requirePolicy(
        input.organizationScopeId,
        pool.policyId,
        pool.policyVersion,
      );
      const funding = await deriveFundingCommitted(pool);
      const eligibility = await deriveEligibility(
        input.organizationScopeId,
        policy,
      );
      const priorAllocations = await allocationRepository.listByPool(
        input.organizationScopeId,
        pool.id,
      );
      const priorAllocatedTotal = sumAllocated(priorAllocations);
      const economicRefs = pool.fundingRefs.filter(
        (ref): ref is { readonly kind: "economic_value"; readonly id: string } =>
          ref.kind === "economic_value",
      );

      const checks: BenefitPoolCheck[] = [];
      checks.push({
        check: "pool_active",
        satisfied: pool.closedAt === null,
        detail: { poolId: pool.id, closedAt: pool.closedAt },
      });
      checks.push({
        check: "policy_version_pinned",
        satisfied: true,
        detail: {
          policyId: pool.policyId,
          policyVersion: pool.policyVersion,
          benefitType: policy.benefitType,
        },
      });
      const fundingQualified = funding.funding.every((ref) => ref.qualified);
      checks.push({
        check: "funding_qualified",
        satisfied: fundingQualified,
        detail: {
          refs: funding.funding.map((ref) => ({
            kind: ref.kind,
            id: ref.id,
            qualified: ref.qualified,
            resolvedAmount: ref.resolvedAmount,
            reason: ref.reason,
          })),
        },
      });
      const available = funding.availableFunding;
      const remaining = available - priorAllocatedTotal;
      const fundingAvailable = fundingQualified && remaining > 0;
      checks.push({
        check: "funding_available",
        satisfied: fundingAvailable,
        detail: {
          availableFunding: available,
          priorAllocatedTotal,
          remaining,
        },
      });
      checks.push({
        check: "members_eligible",
        satisfied: eligibility.eligible,
        detail: {
          memberCount: eligibility.members.length,
          ineligibleMemberIds: eligibility.ineligibleMemberIds,
          criteria: policy.eligibilityCriteria,
        },
      });

      // The draw-policy consistency preview (economic draws only).
      let draw = false;
      let drawPolicyConsistent = true;
      let drawPolicyDetail: Record<string, unknown> = {
        applicable: false,
      };
      if (economicRefs.length > 0) {
        draw = true;
        if (
          policy.rewardPolicyId === null ||
          policy.remainderDisposition !== "last_member_absorbs"
        ) {
          drawPolicyConsistent = false;
          drawPolicyDetail = {
            applicable: true,
            reason:
              policy.rewardPolicyId === null
                ? "the policy declares no rewardPolicyId (economic draws require the settlement reward-policy mirror)"
                : "the policy remainderDisposition is not last_member_absorbs (the settlement deterministic split semantics — required for economic draws)",
            rewardPolicyId: policy.rewardPolicyId,
            remainderDisposition: policy.remainderDisposition,
          };
        } else {
          const rewardPolicy = await lookups.rewardPolicy.resolveLatest(
            policy.rewardPolicyId,
          );
          if (
            !rewardPolicy ||
            rewardPolicy.organizationScopeId !== input.organizationScopeId
          ) {
            drawPolicyConsistent = false;
            drawPolicyDetail = {
              applicable: true,
              reason: "the referenced settlement reward policy does not resolve in scope",
              rewardPolicyId: policy.rewardPolicyId,
            };
          } else if (
            !rewardPolicyMirrorsDeclarations(rewardPolicy, policy)
          ) {
            drawPolicyConsistent = false;
            drawPolicyDetail = {
              applicable: true,
              reason:
                "the settlement reward policy version does not mirror the benefits policy member declarations exactly (order, persons, weights)",
              rewardPolicyId: policy.rewardPolicyId,
              rewardPolicyVersion: rewardPolicy.version,
            };
          } else {
            drawPolicyDetail = {
              applicable: true,
              rewardPolicyId: rewardPolicy.policyId,
              rewardPolicyVersion: rewardPolicy.version,
              mirrors: true,
            };
          }
        }
      }
      checks.push({
        check: "draw_policy_consistent",
        satisfied: drawPolicyConsistent,
        detail: drawPolicyDetail,
      });

      const baseEligible =
        checks[0]!.satisfied &&
        checks[1]!.satisfied &&
        checks[2]!.satisfied &&
        checks[3]!.satisfied &&
        checks[4]!.satisfied &&
        checks[5]!.satisfied;

      let plan: BenefitPoolAllocationView["plan"] = null;
      let conservationPreserved = true;
      if (baseEligible) {
        try {
          const amount = draw
            ? // The single economic value record's authoritative amount
              // (preview; the draw allocates the record amount exactly).
              (funding.funding.find(
                (ref) => ref.kind === "economic_value" && ref.qualified,
              )?.resolvedAmount ?? 0)
            : remaining;
          const computed = computeBenefitAllocationPlan(
            amount,
            eligibility.members,
            policy.remainderDisposition,
          );
          const conserved =
            toEconomicMinorUnits(priorAllocatedTotal) +
              toEconomicMinorUnits(computed.totalAllocated) <=
            toEconomicMinorUnits(available);
          conservationPreserved = conserved;
          checks.push({
            check: "conservation_preserved",
            satisfied: conserved,
            detail: {
              priorAllocatedTotal,
              totalAllocated: computed.totalAllocated,
              remainderAmount: computed.remainderAmount,
              availableFunding: available,
            },
          });
          if (conserved) {
            plan = {
              draw,
              amount,
              shares: computed.shares,
              totalAllocated: computed.totalAllocated,
              remainderAmount: computed.remainderAmount,
              remainderDisposition: computed.remainderDisposition,
            };
          }
        } catch (error) {
          conservationPreserved = false;
          checks.push({
            check: "conservation_preserved",
            satisfied: false,
            detail: {
              reason:
                error instanceof Error
                  ? error.message
                  : "the deterministic plan could not be computed",
            },
          });
        }
      } else {
        checks.push({
          check: "conservation_preserved",
          satisfied: false,
          detail: { reason: "not evaluated (an earlier check failed)" },
        });
      }

      const eligible =
        baseEligible && conservationPreserved && plan !== null;
      const digest =
        plan === null
          ? null
          : computeBenefitAllocationDigest({
              poolId: pool.id,
              organizationScopeId: pool.organizationScopeId,
              policyId: pool.policyId,
              policyVersion: pool.policyVersion,
              benefitType: pool.benefitType,
              funding: funding.funding.map((ref) => ({
                kind: ref.kind,
                id: ref.id,
                resolvedAmount: ref.resolvedAmount,
              })),
              members: eligibility.members,
              plan: {
                shares: plan.shares,
                totalAllocated: plan.totalAllocated,
                remainderAmount: plan.remainderAmount,
                remainderDisposition: plan.remainderDisposition,
              },
              availableFunding: available,
              priorAllocatedTotal,
            });

      logger.debug("benefits_pool.allocation_evaluated", {
        poolId: pool.id,
        organizationScopeId: pool.organizationScopeId,
        eligible,
        executionId: execution.executionId,
      });
      return {
        poolId: pool.id,
        organizationScopeId: pool.organizationScopeId,
        policyId: pool.policyId,
        policyVersion: pool.policyVersion,
        benefitType: pool.benefitType,
        eligible,
        checks,
        funding: funding.funding,
        availableFunding: available,
        priorAllocatedTotal,
        plan,
        digest,
        evaluatedAt,
      };
    },

    async allocatePoolBenefits(
      execution,
      input: AllocatePoolBenefitsInput,
    ): Promise<AllocatePoolBenefitsResult> {
      assertOrganizationScopeId(input.organizationScopeId);
      assertPoolId(input.poolId);
      assertIdempotencyKey(input.idempotencyKey);
      const actor = actingPersonId(execution);
      await requireActiveMember(input.organizationScopeId, actor);

      // ---- Committed pre-flight: the tenant anchor + creator gate --
      const pool = await requirePool(input.organizationScopeId, input.poolId);
      requirePoolCreator(actor, pool);
      if (pool.closedAt !== null) {
        throw new InvalidBenefitPoolError(
          `benefit pool ${input.poolId} is closed — a closed pool can never allocate again (ONE-WAY closure)`,
          { poolId: input.poolId, closedAt: pool.closedAt },
        );
      }
      const policy = await requirePolicy(
        input.organizationScopeId,
        pool.policyId,
        pool.policyVersion,
      );

      // ---- The draw source resolution (references only) -----------
      const economicRefs = pool.fundingRefs.filter(
        (ref): ref is { readonly kind: "economic_value"; readonly id: string } =>
          ref.kind === "economic_value",
      );
      let drawRef: { kind: "economic_value"; id: string } | null = null;
      if (input.valueRecordId !== undefined) {
        if (typeof input.valueRecordId !== "string" || !input.valueRecordId.trim()) {
          throw benefitsError(
            "valueRecordId, when present, must be a non-empty economic value record id",
            { field: "valueRecordId" },
          );
        }
        const match = economicRefs.find(
          (ref) => ref.id === input.valueRecordId,
        );
        if (!match) {
          throw benefitsError(
            `valueRecordId ${input.valueRecordId} is not a declared economic_value funding reference of pool ${input.poolId}`,
            { poolId: input.poolId, valueRecordId: input.valueRecordId },
          );
        }
        drawRef = match;
      } else if (economicRefs.length === 1) {
        drawRef = economicRefs[0]!;
      } else if (economicRefs.length > 1) {
        throw benefitsError(
          `pool ${input.poolId} declares ${String(economicRefs.length)} economic value funding references — the allocation must select the draw source explicitly (valueRecordId)`,
          { poolId: input.poolId, economicRefCount: economicRefs.length },
        );
      }

      if (drawRef !== null) {
        // ---- The economic-draw preconditions (fail closed) --------
        if (policy.rewardPolicyId === null) {
          throw benefitsError(
            `the pool's policy ${policy.policyId}#${policy.version} declares no rewardPolicyId — economic draws require the settlement reward-policy mirror`,
            { policyId: policy.policyId, policyVersion: policy.version },
          );
        }
        if (policy.remainderDisposition !== "last_member_absorbs") {
          throw benefitsError(
            `the pool's policy ${policy.policyId}#${policy.version} remainderDisposition is ${policy.remainderDisposition} — economic draws require last_member_absorbs (the settlement deterministic split semantics: Σ shares === source EXACTLY)`,
            {
              policyId: policy.policyId,
              policyVersion: policy.version,
              remainderDisposition: policy.remainderDisposition,
            },
          );
        }
        if (input.amount !== undefined) {
          throw benefitsError(
            "an explicit amount is forbidden for economic draws — the draw allocates the authoritative value record amount exactly (no partial draws, no caller arithmetic)",
            { poolId: input.poolId, amount: input.amount },
          );
        }
        // Committed pre-flight value-record read (the in-tx fresh
        // re-derivation below is the authoritative backstop).
        const valueFacts = await lookups.valueFunding.resolve(drawRef.id);
        if (
          !valueFacts ||
          valueFacts.organizationScopeId !== input.organizationScopeId
        ) {
          throw new NotFoundError(
            `economic value record not found in scope ${input.organizationScopeId}: ${drawRef.id}`,
            { valueRecordId: drawRef.id },
          );
        }
        // ---- The pinned settlement reward policy + mirror check ---
        const pinnedRewardPolicy = await lookups.rewardPolicy.resolveLatest(
          policy.rewardPolicyId,
        );
        if (
          !pinnedRewardPolicy ||
          pinnedRewardPolicy.organizationScopeId !== input.organizationScopeId
        ) {
          throw new NotFoundError(
            `settlement reward policy not found in scope ${input.organizationScopeId}: ${policy.rewardPolicyId}`,
            { rewardPolicyId: policy.rewardPolicyId },
          );
        }
        if (!rewardPolicyMirrorsDeclarations(pinnedRewardPolicy, policy)) {
          throw new InvalidBenefitPoolError(
            `the settlement reward policy ${pinnedRewardPolicy.policyId}#${pinnedRewardPolicy.version} does not mirror the benefits policy member declarations exactly (order, persons, weights) — fail closed (the locked accounts must always be the posted accounts)`,
            {
              rewardPolicyId: pinnedRewardPolicy.policyId,
              rewardPolicyVersion: pinnedRewardPolicy.version,
              policyId: policy.policyId,
              policyVersion: policy.version,
            },
          );
        }

        // ---- THE LOCK SET (the exact keys the draw's standalone --
        // form would acquire — pinned so the locked accounts are
        // always the posted accounts) then the pool mutex → ONE
        // applyIdempotent → ONE AuthorityTransaction.
        const lockKeys = lookups.economicDraw.drawLockKeys({
          organizationScopeId: input.organizationScopeId,
          sourceValueRecordId: drawRef.id,
          sourceBeneficiaryPersonId: valueFacts.beneficiaryPersonId,
          memberPersonIds: policy.memberDeclarations.map((m) => m.personId),
        });
        return idempotency.withLock(
          `benefits_pool:${input.poolId}`,
          () =>
            withDrawLocks(lockKeys, async () => {
              const key = `benefits_allocation:${input.organizationScopeId}:${input.poolId}:${actor}:${input.idempotencyKey}`;
              const applied = await idempotency.applyIdempotent(
                key,
                async (ctx): Promise<AllocatePoolBenefitsResult> => {
                  const allocation = await applyAllocation(
                    execution,
                    input,
                    drawRef!,
                    {
                      rewardPolicyId: pinnedRewardPolicy.policyId,
                      rewardPolicyVersion: pinnedRewardPolicy.version,
                    },
                    ctx,
                  );
                  return { allocation, created: true };
                },
                execution,
              );
              logger.info("benefits_pool.allocation_recorded", {
                allocationId: applied.result.allocation.id,
                poolId: applied.result.allocation.poolId,
                organizationScopeId:
                  applied.result.allocation.organizationScopeId,
                draw: applied.result.allocation.draw !== null,
                totalAllocated: applied.result.allocation.totalAllocated,
                executionId: execution.executionId,
              });
              return {
                allocation: applied.result.allocation,
                created: applied.executed,
              };
            }),
        );
      }

      // ---- Entitlement-only allocation (savings-funded; posts
      // NOTHING — the deterministic plan bounded by the authoritative
      // verified savings value) -------------------------------------
      if (input.amount !== undefined) {
        if (
          typeof input.amount !== "number" ||
          !Number.isFinite(input.amount) ||
          input.amount <= 0
        ) {
          throw benefitsError(
            `the requested entitlement amount must be a finite number > 0 (got ${String(input.amount)})`,
            { amount: input.amount },
          );
        }
        if (toEconomicMinorUnits(input.amount) <= 0) {
          throw benefitsError(
            `the requested entitlement amount must carry at most 6 decimals (got ${String(input.amount)})`,
            { amount: input.amount },
          );
        }
      }
      return idempotency.withLock(
        `benefits_pool:${input.poolId}`,
        async (): Promise<AllocatePoolBenefitsResult> => {
          const key = `benefits_allocation:${input.organizationScopeId}:${input.poolId}:${actor}:${input.idempotencyKey}`;
          const applied = await idempotency.applyIdempotent(
            key,
            async (ctx): Promise<AllocatePoolBenefitsResult> => {
              const allocation = await applyAllocation(
                execution,
                input,
                null,
                null,
                ctx,
              );
              return { allocation, created: true };
            },
            execution,
          );
          logger.info("benefits_pool.allocation_recorded", {
            allocationId: applied.result.allocation.id,
            poolId: applied.result.allocation.poolId,
            organizationScopeId: applied.result.allocation.organizationScopeId,
            draw: applied.result.allocation.draw !== null,
            totalAllocated: applied.result.allocation.totalAllocated,
            executionId: execution.executionId,
          });
          return {
            allocation: applied.result.allocation,
            created: applied.executed,
          };
        },
      );
    },

    async getBenefitPoolAllocation(execution, input) {
      assertOrganizationScopeId(input.organizationScopeId);
      if (typeof input.allocationId !== "string" || !input.allocationId.trim()) {
        throw benefitsError("allocationId is required", {
          field: "allocationId",
        });
      }
      const actor = actingPersonId(execution);
      const allocation = await allocationRepository.findById(
        input.allocationId,
      );
      if (
        !allocation ||
        allocation.organizationScopeId !== input.organizationScopeId
      ) {
        throw new NotFoundError(
          `benefit pool allocation not found: ${input.allocationId}`,
          { allocationId: input.allocationId },
        );
      }
      // Allocation reads are pool-creator-scoped (the lineage owner).
      const pool = await requirePool(
        input.organizationScopeId,
        allocation.poolId,
      );
      requirePoolCreator(actor, pool);
      return allocation;
    },

    async listPoolAllocations(execution, input) {
      assertOrganizationScopeId(input.organizationScopeId);
      assertPoolId(input.poolId);
      const actor = actingPersonId(execution);
      const pool = await requirePool(input.organizationScopeId, input.poolId);
      requirePoolCreator(actor, pool);
      return allocationRepository.listByPool(
        input.organizationScopeId,
        input.poolId,
      );
    },

    async getMemberBenefitView(
      execution,
      input,
    ): Promise<BenefitMemberView> {
      assertOrganizationScopeId(input.organizationScopeId);
      assertPoolId(input.poolId);
      // The requesting person must be an ACTIVE member (privacy: a
      // non-member's read is indistinguishable from a nonexistent
      // pool — no existence oracle).
      const actor = actingPersonId(execution);
      const pool = await requirePool(input.organizationScopeId, input.poolId);
      const active = await lookups.membership.isActiveMember(
        input.organizationScopeId,
        actor,
      );
      if (!active) {
        throw new NotFoundError(
          `benefit pool not found: ${input.poolId}`,
          { poolId: input.poolId },
        );
      }
      const allocations = await allocationRepository.listByPool(
        input.organizationScopeId,
        input.poolId,
      );
      // PRIVACY (issue #56 invariant 5): the member sees THEIR OWN
      // shares and totals ONLY — never other members' identities,
      // weights or amounts, never funding resolution details, never
      // protected procurement demand data.
      const ownShares: {
        allocationId: string;
        amount: number;
        allocatedAt: string;
      }[] = [];
      let ownTotalMinor = 0;
      let poolTotalMinor = 0;
      for (const allocation of allocations) {
        poolTotalMinor += toEconomicMinorUnits(allocation.totalAllocated);
        for (const share of allocation.shares) {
          if (share.personId === actor) {
            ownShares.push({
              allocationId: allocation.id,
              amount: share.amount,
              allocatedAt: allocation.allocatedAt,
            });
            ownTotalMinor += toEconomicMinorUnits(share.amount);
          }
        }
      }
      return {
        poolId: pool.id,
        organizationScopeId: pool.organizationScopeId,
        benefitType: pool.benefitType,
        policyId: pool.policyId,
        policyVersion: pool.policyVersion,
        ownShares,
        ownTotal: ownTotalMinor / 1_000_000,
        poolTotalAllocated: poolTotalMinor / 1_000_000,
      };
    },
  };

  // -----------------------------------------------------------------
  // The single allocation body (in-tx; shared by the draw and the
  // entitlement-only paths)
  // -----------------------------------------------------------------

  async function applyAllocation(
    execution: ExecutionContext,
    input: AllocatePoolBenefitsInput,
    drawRef: { kind: "economic_value"; id: string } | null,
    pinnedRewardPolicy: {
      readonly rewardPolicyId: string;
      readonly rewardPolicyVersion: number;
    } | null,
    ctx: IdempotentApplyContext,
  ): Promise<BenefitPoolAllocation> {
    const tx = ctx.transaction;

    // (1) In-tx fresh pool read (tenant anchor + creator + closure).
    const pool = await poolRepository.findByIdWithinTx(input.poolId, tx);
    if (
      !pool ||
      pool.organizationScopeId !== input.organizationScopeId
    ) {
      throw new NotFoundError(
        `benefit pool not found: ${input.poolId}`,
        { poolId: input.poolId },
      );
    }
    requirePoolCreator(actingPersonId(execution), pool);
    if (pool.closedAt !== null) {
      throw new InvalidBenefitPoolError(
        `benefit pool ${input.poolId} is closed — a closed pool can never allocate again (ONE-WAY closure)`,
        { poolId: input.poolId, closedAt: pool.closedAt },
      );
    }

    // (2) In-tx policy pin (the pool's exact version; immutable
    // lineage — the re-read guards repository drift).
    const policy = await policyRepository.findVersionWithinTx(
      pool.policyId,
      pool.policyVersion,
      tx,
    );
    if (
      !policy ||
      policy.organizationScopeId !== input.organizationScopeId
    ) {
      throw new NotFoundError(
        `benefit allocation policy version not found within tx: ${pool.policyId}#${pool.policyVersion}`,
        { policyId: pool.policyId, policyVersion: pool.policyVersion },
      );
    }

    // (3) In-tx funding re-derivation (the authoritative bar — every
    // reference must qualify or the allocation fails closed).
    const funding = await deriveFunding(pool, tx);
    const unqualified = funding.funding.filter((ref) => !ref.qualified);
    if (unqualified.length > 0) {
      throw new InvalidBenefitPoolError(
        `the current funding resolution of pool ${pool.id} is not qualified: ${unqualified
          .map((ref) => `${ref.kind}:${ref.id} (${ref.reason ?? "unqualified"})`)
          .join("; ")} — funding fails closed (work order §3.2)`,
        {
          poolId: pool.id,
          unqualified: unqualified.map((ref) => ({
            kind: ref.kind,
            id: ref.id,
            reason: ref.reason,
          })),
        },
      );
    }
    const availableFunding = funding.availableFunding;

    // (4) In-tx eligibility re-derivation (the authoritative bar).
    const eligibility = await deriveEligibility(
      input.organizationScopeId,
      policy,
    );
    if (!eligibility.eligible) {
      throw new InvalidBenefitPoolError(
        `the current member eligibility of pool ${pool.id} is not satisfied (inactive members: ${eligibility.ineligibleMemberIds.join(", ")}) — eligibility is server-derived, never caller-asserted`,
        {
          poolId: pool.id,
          ineligibleMemberIds: eligibility.ineligibleMemberIds,
        },
      );
    }

    // (5) The conservation facts (in-tx lineage read — the TOCTOU
    // closure over the cumulative allocation envelope).
    const priorAllocations = await allocationRepository.listByPoolWithinTx(
      input.organizationScopeId,
      input.poolId,
      tx,
    );
    const priorAllocatedTotal = sumAllocated(priorAllocations);

    // (6) The amount resolution + the deterministic plan.
    let amount: number;
    if (drawRef !== null) {
      // The draw allocates the authoritative record amount EXACTLY
      // (server-derived — no caller arithmetic).
      const drawFacts = funding.funding.find((ref) => ref.id === drawRef.id);
      if (!drawFacts || !drawFacts.qualified || drawFacts.resolvedAmount === null) {
        throw new InvalidBenefitPoolError(
          `the draw source ${drawRef.id} did not qualify in the in-tx funding re-derivation`,
          { poolId: pool.id, valueRecordId: drawRef.id },
        );
      }
      amount = drawFacts.resolvedAmount;
    } else {
      amount = input.amount ?? availableFunding - priorAllocatedTotal;
    }
    const plan = computeBenefitAllocationPlan(
      amount,
      eligibility.members,
      policy.remainderDisposition,
    );

    // (7) The conservation check (scaled integers — no drift).
    if (
      toEconomicMinorUnits(priorAllocatedTotal) +
        toEconomicMinorUnits(plan.totalAllocated) >
      toEconomicMinorUnits(availableFunding)
    ) {
      throw new InvalidBenefitPoolError(
        `the allocation would exceed the authoritative funding envelope of pool ${pool.id} (prior ${String(priorAllocatedTotal)} + ${String(plan.totalAllocated)} > available ${String(availableFunding)}) — conservation rejects the mutation (issue #56 invariant 3)`,
        {
          poolId: pool.id,
          priorAllocatedTotal,
          totalAllocated: plan.totalAllocated,
          availableFunding,
        },
      );
    }

    // (8) THE ECONOMIC DRAW (economic draws only) — the settlement
    // reward-allocation primitive on THIS transaction (postings +
    // draw record + exactly-once value consumption + buffered audit —
    // /settlement stays the sole economic authority).
    let drawFacts: BenefitEconomicDrawFacts | null = null;
    if (drawRef !== null && pinnedRewardPolicy !== null) {
      drawFacts = await lookups.economicDraw.allocateRewardDrawWithinTx(
        execution,
        {
          organizationScopeId: input.organizationScopeId,
          sourceValueRecordId: drawRef.id,
          policyId: pinnedRewardPolicy.rewardPolicyId,
          version: pinnedRewardPolicy.rewardPolicyVersion,
          idempotencyKey: input.idempotencyKey,
        },
        ctx,
      );
      // Verify the staged draw result against the benefits plan (the
      // W020 staged-draw-verification precedent — a drifted draw can
      // never be recorded).
      if (drawFacts.sourceValueRecordId !== drawRef.id) {
        throw new InvalidBenefitPoolError(
          `the draw executed against value record ${drawFacts.sourceValueRecordId}, not the declared draw source ${drawRef.id} — fail closed`,
          { poolId: pool.id, expected: drawRef.id, actual: drawFacts.sourceValueRecordId },
        );
      }
      if (drawFacts.policyId !== policy.rewardPolicyId) {
        throw new InvalidBenefitPoolError(
          `the draw executed under reward policy ${drawFacts.policyId}, not the pinned ${String(policy.rewardPolicyId)} — fail closed`,
          { poolId: pool.id, expected: policy.rewardPolicyId, actual: drawFacts.policyId },
        );
      }
      if (
        toEconomicMinorUnits(drawFacts.totalAllocated) !==
        toEconomicMinorUnits(plan.totalAllocated)
      ) {
        throw new InvalidBenefitPoolError(
          `the draw total ${String(drawFacts.totalAllocated)} does not equal the deterministic plan total ${String(plan.totalAllocated)} — fail closed (the settlement split and the benefits plan must agree exactly)`,
          {
            poolId: pool.id,
            drawTotal: drawFacts.totalAllocated,
            planTotal: plan.totalAllocated,
          },
        );
      }
      if (drawFacts.shares.length !== plan.shares.length) {
        throw new InvalidBenefitPoolError(
          "the draw share set does not match the deterministic plan share set — fail closed",
          { poolId: pool.id },
        );
      }
      for (let i = 0; i < plan.shares.length; i++) {
        const planned = plan.shares[i]!;
        const drawn = drawFacts.shares[i]!;
        if (
          drawn.beneficiaryPersonId !== planned.personId ||
          toEconomicMinorUnits(drawn.amount) !==
            toEconomicMinorUnits(planned.amount)
        ) {
          throw new InvalidBenefitPoolError(
            `the draw share ${String(drawn.beneficiaryPersonId)} → ${String(drawn.amount)} does not match the deterministic plan share ${planned.personId} → ${String(planned.amount)} — fail closed`,
            {
              poolId: pool.id,
              index: i,
              drawn: {
                personId: drawn.beneficiaryPersonId,
                amount: drawn.amount,
              },
              planned: {
                personId: planned.personId,
                amount: planned.amount,
              },
            },
          );
        }
      }
    }

    // (9) The allocation lineage record + the digest + the buffered
    // audit event (all on THIS transaction).
    const allocatedAt = nowIso();
    const digest = computeBenefitAllocationDigest({
      poolId: pool.id,
      organizationScopeId: pool.organizationScopeId,
      policyId: pool.policyId,
      policyVersion: pool.policyVersion,
      benefitType: pool.benefitType,
      funding: funding.funding.map((ref) => ({
        kind: ref.kind,
        id: ref.id,
        resolvedAmount: ref.resolvedAmount,
      })),
      members: eligibility.members,
      plan: {
        shares: plan.shares,
        totalAllocated: plan.totalAllocated,
        remainderAmount: plan.remainderAmount,
        remainderDisposition: plan.remainderDisposition,
      },
      availableFunding,
      priorAllocatedTotal,
    });
    const allocation: BenefitPoolAllocation = {
      id: randomUUID(),
      organizationScopeId: pool.organizationScopeId,
      poolId: pool.id,
      policyId: pool.policyId,
      policyVersion: pool.policyVersion,
      benefitType: pool.benefitType,
      funding: Object.freeze(
        funding.funding.map((ref) =>
          Object.freeze({
            kind: ref.kind as "economic_value" | "verified_savings",
            id: ref.id,
            resolvedAmount: ref.resolvedAmount,
          }),
        ),
      ),
      members: Object.freeze(
        eligibility.members.map((m) => Object.freeze({ ...m })),
      ),
      shares: Object.freeze(
        plan.shares.map((share) => Object.freeze({ ...share })),
      ),
      totalAllocated: plan.totalAllocated,
      remainderAmount: plan.remainderAmount,
      remainderDisposition: plan.remainderDisposition,
      availableFunding,
      priorAllocatedTotal,
      draw:
        drawFacts === null
          ? null
          : {
              resultId: drawFacts.drawResultId,
              transactionId: drawFacts.transactionId,
            },
      status: "recorded",
      digest,
      allocatedAt,
      recordFormat: BENEFIT_POOL_ALLOCATION_RECORD_FORMAT,
      idempotencyKey: input.idempotencyKey,
      executionId: execution.executionId,
      correlationId: execution.correlationId,
      causationId: execution.causationId,
    };
    const created = await allocationRepository.createWithinTx(
      allocation,
      tx,
    );
    await appendAudit(tx, execution, {
      eventType: BENEFITS_POOL_ALLOCATION_RECORDED,
      actor: actingPersonId(execution),
      subject: pool.id,
      resourceType: "benefit_pool_allocation",
      resourceId: created.id,
      metadata: {
        poolId: pool.id,
        organizationScopeId: pool.organizationScopeId,
        policyId: pool.policyId,
        policyVersion: pool.policyVersion,
        benefitType: pool.benefitType,
        derivationPolicy: {
          version: BENEFIT_ALLOCATION_POLICY_VERSION,
          method: "proportional-weights-scaled-floor",
        },
        totalAllocated: created.totalAllocated,
        remainderAmount: created.remainderAmount,
        remainderDisposition: created.remainderDisposition,
        availableFunding: created.availableFunding,
        priorAllocatedTotal: created.priorAllocatedTotal,
        drawResultId: created.draw?.resultId ?? null,
        drawTransactionId: created.draw?.transactionId ?? null,
        idempotencyRecordId: ctx.recordId,
      },
    });
    return created;
  }

  /** The committed-read funding derivation (the derived view path). */
  async function deriveFundingCommitted(pool: BenefitPool) {
    // The derived evaluate path resolves every reference through the
    // SAME neutral lookups on committed reads (a derived 200 decision
    // — the allocation command re-derives IN-TX as the bar).
    const funding: {
      kind: import("./port.ts").BenefitFundingSourceKind;
      id: string;
      qualified: boolean;
      resolvedAmount: number | null;
      reason: string | null;
    }[] = [];
    let availableMinor = 0;
    for (const ref of pool.fundingRefs) {
      if (ref.kind === "economic_value") {
        const facts = await lookups.valueFunding.resolve(ref.id);
        const qualified =
          facts !== null &&
          facts.organizationScopeId === pool.organizationScopeId &&
          facts.state === "MATURE" &&
          !facts.consumed &&
          !facts.reversed &&
          facts.amount > 0;
        if (qualified) availableMinor += toEconomicMinorUnits(facts!.amount);
        funding.push({
          kind: ref.kind,
          id: ref.id,
          qualified,
          resolvedAmount: qualified ? facts!.amount : null,
          reason: qualified
            ? null
            : facts === null
              ? "value record not found"
              : facts.organizationScopeId !== pool.organizationScopeId
                ? "cross-scope value record"
                : facts.reversed
                  ? "value record reversed"
                  : facts.consumed
                    ? "value record already consumed exactly-once"
                    : facts.state !== "MATURE"
                      ? `value record state ${facts.state} is not MATURE`
                      : "value record amount is not positive",
        });
      } else {
        const facts = await lookups.savingsFunding.resolveCurrent(ref.id);
        const qualified =
          facts !== null &&
          facts.organizationScopeId === pool.organizationScopeId &&
          facts.supported &&
          facts.savingsValue !== null &&
          facts.savingsValue > 0;
        if (qualified) {
          availableMinor += toEconomicMinorUnits(facts!.savingsValue!);
        }
        funding.push({
          kind: ref.kind,
          id: ref.id,
          qualified,
          resolvedAmount: qualified ? facts!.savingsValue! : null,
          reason: qualified
            ? null
            : facts === null
              ? "savings record not found"
              : facts.organizationScopeId !== pool.organizationScopeId
                ? "cross-scope savings record"
                : !facts.supported
                  ? "the current savings re-derivation is not supported"
                  : "the current derived savings value is not positive",
        });
      }
    }
    return { funding, availableFunding: availableMinor / 1_000_000 };
  }

  return service;
}

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

function sumAllocated(
  allocations: readonly BenefitPoolAllocation[],
): number {
  let minor = 0;
  for (const allocation of allocations) {
    minor += toEconomicMinorUnits(allocation.totalAllocated);
  }
  return minor / 1_000_000;
}

/**
 * Whether the settlement reward policy version mirrors the benefits
 * policy member declarations EXACTLY (order, persons, weights) — the
 * consistency bridge for economic draws (the locked accounts are
 * always the posted accounts; the settlement split and the benefits
 * plan must agree).
 */
function rewardPolicyMirrorsDeclarations(
  rewardPolicy: {
    readonly allocations: readonly {
      readonly beneficiaryPersonId: string;
      readonly weight: number;
    }[];
  },
  policy: BenefitAllocationPolicy,
): boolean {
  if (rewardPolicy.allocations.length !== policy.memberDeclarations.length) {
    return false;
  }
  for (let i = 0; i < policy.memberDeclarations.length; i++) {
    const declared = policy.memberDeclarations[i]!;
    const mirrored = rewardPolicy.allocations[i]!;
    if (
      mirrored.beneficiaryPersonId !== declared.personId ||
      toEconomicMinorUnits(mirrored.weight) !==
        toEconomicMinorUnits(declared.weight)
    ) {
      return false;
    }
  }
  return true;
}
