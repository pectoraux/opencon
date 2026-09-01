/**
 * Benefits boundary — declared public interface (port) — NET-W028
 * Benefit Pools.
 *
 * Architecture ref: spec/architecture.md §4 (Participation Credit), §5
 * (economic model), §17 (authoritative workflow — the ledger consumes
 * VERIFIED upstream records), §18 (Module ownership: `/demand`,
 * `/benefits` own demand aggregation and benefit allocation — the
 * /benefits boundary is one of the SIXTEEN frozen v1.0 domains, NOT a
 * new seventeenth domain), §19 (PostgreSQL authoritative; model output
 * never sufficient by itself); spec/architecture-lock.md §2 (the frozen
 * domain list), §3 (PostgreSQL authoritative), §4 (model output is
 * input evidence, never authoritative), §5 (economic authority —
 * /settlement owns Credits, pending/mature value, reward calculations
 * and settlement records), §12 (execution lineage), §13 (economic
 * safety invariants 19–21).
 *
 * Work order ref: spec/work-orders/NET-W028.md
 * Requirements: BEN-001..004 (benefit types; funding from advertising,
 * procurement, sponsorship and approved network contributions;
 * eligibility-policy-governed allocation; value delivered to members).
 * Issue: #56 (NET-W028 — Benefit Pools, READY_FOR_IMPLEMENTATION).
 *
 * THE KEY RULES (work order §2–§4 + issue #56 architectural
 * constraints):
 *  - `/benefits` is the EXISTING frozen boundary (NET-W001 declared
 *    it skeletal; NET-W028 ships the concrete behaviour INSIDE it —
 *    no 17th domain, no second benefits authority);
 *  - `/settlement` remains the SOLE economic authority for value,
 *    balances, credits, cash, rewards and postings. Benefit Pools
 *    orchestrate allocation semantics but NEVER create a second
 *    ledger: the only economic mutation a pool performs is the
 *    EXISTING /settlement reward-allocation draw
 *    (`allocateRewardsWithinTx` — balanced postings + exactly-once
 *    consumption + conservation + audit, all inside the caller's
 *    authoritative transaction through the neutral draw port below);
 *    entitlement-only allocations (savings-funded) post NOTHING and
 *    mint NOTHING;
 *  - FUNDING AUTHORITY: only already-authoritative upstream value may
 *    fund a pool — `economic_value` references resolve to /settlement
 *    EconomicValueRecords (the NET-W008/W014 authoritative value
 *    records) and `verified_savings` references resolve to the
 *    /demand NET-W027 savings-lineage records consumed as
 *    verified/derived FACTS (re-derived through the neutral lookup —
 *    never recalculated here, never caller-asserted). Unverified
 *    savings, offers, reputation, raw activity and caller-supplied
 *    amounts cannot mint or manufacture pool value: there is NO
 *    contract field for a caller-asserted funded balance anywhere;
 *  - CONSERVATION: allocation never exceeds the server-derived
 *    authoritative funding envelope; rounding/remainders are
 *    deterministic scaled-integer arithmetic and are EXPLICITLY
 *    represented (the last-member-absorbs disposition matches the
 *    settlement reward-split semantics EXACTLY; the retained-in-pool
 *    disposition keeps the remainder available — conserved, never
 *    lost through floating-point drift);
 *  - ELIGIBILITY: member eligibility and weights are server-derived
 *    from the explicit versioned policy + authoritative participant
 *    inputs (the neutral membership lookup); caller-supplied
 *    eligibility, weight, balance or allocation assertions are never
 *    authority;
 *  - CURRENT-STATE AUTHORIZATION: before every material effect the
 *    current funding availability and current eligibility are
 *    RE-DERIVED inside the authoritative transaction (in-tx fresh
 *    reads for economic value records; current re-derivation for
 *    savings); a stale pool snapshot can never authorize new value
 *    movement;
 *  - PRIVACY: pool/member views expose only policy-authorized
 *    information — protected procurement commitments and exact
 *    competitor terms never cross normal surfaces (the savings
 *    funding lookup exposes ONLY the derived verdict + amount +
 *    digest), and member views expose ONLY the requesting member's
 *    own shares (never other members' identities or amounts);
 *  - TENANCY: cross-tenant and unauthorized access fails closed
 *    without existence oracles (cross-scope ids resolve as
 *    not-found);
 *  - ATOMICITY/AUDIT: material mutations use composite idempotency,
 *    per-pool serialization, ONE authoritative transaction and
 *    transactional audit buffering with post-commit publication;
 *  - `/workflows` remains the lifecycle authority — there is NO local
 *    workflow machinery (pool closure is a ONE-WAY field mutation,
 *    never a status machine);
 *  - AI/model output is advisory only and NEVER authorizes funding,
 *    eligibility, privacy release, allocation or economics (no AI
 *    surface exists here at all);
 *  - W029+ decentralization and W033+ end-to-end flows are excluded.
 *
 * Cross-boundary discipline (the NET-W024–W027 dependency-inversion
 * precedent): this port imports CORE contracts only. Every
 * cross-domain fact arrives READ-ONLY through the neutral structural
 * interfaces declared below, wired at the composition root
 * (src/bootstrap/runtime.ts) over the OWNING authorities'
 * repositories/services. The /benefits domain never imports
 * /settlement, /demand, /organizations, /evidence or /outcomes
 * implementation modules.
 */

import type { AuthorityTransaction } from "../core/postgres-authority.ts";
import type { ExecutionContext } from "../core/execution-context.ts";
import type { IdempotentApplyContext, IdempotencyStore } from "../core/idempotency.ts";
import type { TransactionalAuditWriter } from "../core/audit.ts";
import { OpenConError } from "../core/errors.ts";

// ---------------------------------------------------------------------------
// Frozen NET-W028 vocabularies (closed, versioned, bounded)
// ---------------------------------------------------------------------------

/**
 * The record-format lineage for the NET-W028 records (determinism: the
 * shape that governed a record's creation is reproducible).
 */
export const BENEFIT_POOL_POLICY_RECORD_FORMAT = "NET-W028:1" as const;
export const BENEFIT_POOL_RECORD_FORMAT = "NET-W028:1" as const;
export const BENEFIT_POOL_ALLOCATION_RECORD_FORMAT = "NET-W028:1" as const;

/**
 * The closed benefit-type vocabulary (BEN-001: cash, discounts,
 * services, credits, rebates, inventory and other benefit types —
 * these six are the W028 vocabulary; "other" types arrive as future
 * additive vocabulary, never silently). The benefit type is
 * DECLARATIVE pool classification: the economic execution is always
 * the EXISTING /settlement reward-allocation primitive (or nothing,
 * for entitlement-only pools) — no new economic primitive exists for
 * any benefit type (work order §4 explicit non-goal).
 */
export const BENEFIT_TYPES = [
  "credits",
  "cash",
  "discount",
  "service",
  "rebate",
  "inventory",
] as const;

export type BenefitType = (typeof BENEFIT_TYPES)[number];

export function isBenefitType(value: string): value is BenefitType {
  return (BENEFIT_TYPES as readonly string[]).includes(value);
}

/**
 * The closed funding-source-kind vocabulary (BEN-002: funding from
 * advertising, procurement, sponsorship and approved network
 * contributions — all four arrive through the TWO authoritative
 * upstream record kinds the frozen architecture already owns):
 *  - `economic_value` — a /settlement EconomicValueRecord (the
 *    NET-W008/W014 authoritative pending→mature value records; the
 *    advertising/sponsorship/network-contribution flows recognize
 *    their value through these records' verified upstream sources);
 *  - `verified_savings` — a /demand NET-W027 ProcurementSavings
 *    lineage record (procurement funding — the verified realized
 *    savings claim, consumed as a verified/derived FACT).
 */
export const BENEFIT_FUNDING_SOURCE_KINDS = [
  "economic_value",
  "verified_savings",
] as const;

export type BenefitFundingSourceKind =
  (typeof BENEFIT_FUNDING_SOURCE_KINDS)[number];

export function isBenefitFundingSourceKind(
  value: string,
): value is BenefitFundingSourceKind {
  return (BENEFIT_FUNDING_SOURCE_KINDS as readonly string[]).includes(value);
}

/**
 * The closed eligibility-criteria vocabulary the server re-derives
 * for every allocation (BEN-003: allocation by DEFINED eligibility
 * policies, not raw spending). Exactly one criterion exists in
 * NET-W028 — `active_membership`: every declared member must hold
 * ACTIVE membership in the tenant organization (resolved through the
 * neutral membership lookup). Future criteria arrive as new versions
 * of this closed vocabulary, never silently.
 */
export const BENEFIT_ELIGIBILITY_CRITERIA = [
  "active_membership",
] as const;

export type BenefitEligibilityCriterion =
  (typeof BENEFIT_ELIGIBILITY_CRITERIA)[number];

export function isBenefitEligibilityCriterion(
  value: string,
): value is BenefitEligibilityCriterion {
  return (BENEFIT_ELIGIBILITY_CRITERIA as readonly string[]).includes(value);
}

/**
 * The closed deterministic remainder-disposition vocabulary (work
 * order §3.5/issue #56 invariant 3 — rounding/remainders deterministic
 * and explicitly accounted for):
 *  - `last_member_absorbs` — the LAST declared member's share absorbs
 *    the rounding remainder so Σ shares === amount EXACTLY (the
 *    IDENTICAL semantics as the /settlement deterministic reward
 *    split — REQUIRED for pools whose allocations execute the
 *    economic draw, because the settlement primitive computes exactly
 *    this split);
 *  - `retained_in_pool` — every share is floored and the remainder is
 *    EXPLICITLY represented on the allocation record and stays inside
 *    the pool's available funding envelope (conserved for future
 *    allocations — never lost, never redistributed silently).
 */
export const BENEFIT_REMAINDER_DISPOSITIONS = [
  "last_member_absorbs",
  "retained_in_pool",
] as const;

export type BenefitRemainderDisposition =
  (typeof BENEFIT_REMAINDER_DISPOSITIONS)[number];

export function isBenefitRemainderDisposition(
  value: string,
): value is BenefitRemainderDisposition {
  return (BENEFIT_REMAINDER_DISPOSITIONS as readonly string[]).includes(value);
}

/**
 * The versioned, server-owned allocation-derivation policy recorded
 * on every derived view/allocation record so the plan that governed
 * an allocation is always reproducible from the record itself (the
 * W026 selection-policy / W027 savings-derivation-policy precedent).
 */
export const BENEFIT_ALLOCATION_POLICY_VERSION = 1;
export const BENEFIT_ALLOCATION_METHOD =
  "proportional-weights-scaled-floor" as const;
export const BENEFIT_ALLOCATION_CRITERIA = [
  "pool_active",
  "policy_version_pinned",
  "funding_qualified",
  "funding_available",
  "members_eligible",
  "draw_policy_consistent",
  "conservation_preserved",
] as const;

/** The bounded funding-reference and member-declaration set sizes. */
export const BENEFIT_MAX_FUNDING_REFS = 8;
export const BENEFIT_MAX_MEMBERS = 64;

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

/**
 * Validation error for benefit-pool request violations (NET-W028):
 * malformed inputs, vocabulary or bounds violations, policy lineage
 * violations, funding/eligibility gate failures and conservation
 * violations.
 */
export class InvalidBenefitPoolError extends OpenConError {
  constructor(
    message: string,
    context?: Readonly<Record<string, unknown>>,
  ) {
    super({
      code: "BENEFITS_VALIDATION",
      classification: "validation",
      message,
      context,
    });
  }
}

/**
 * Stable conflict on benefit-pool state: lineage version conflicts,
 * one-way closure conflicts and allocation-envelope conflicts
 * (machine-readable context).
 */
export class BenefitPoolConflictError extends OpenConError {
  constructor(
    message: string,
    context?: Readonly<Record<string, unknown>>,
  ) {
    super({
      code: "BENEFITS_CONFLICT",
      classification: "conflict",
      message,
      context,
    });
  }
}

// ---------------------------------------------------------------------------
// Neutral lookups (composition-root wired; read-only facts ONLY)
// ---------------------------------------------------------------------------

/**
 * Neutral membership lookup over the /organizations authority (the
 * W025 dual-authorization precedent): answers whether a person holds
 * ACTIVE membership in an organization scope. Read-only.
 */
export interface BenefitMembershipLookup {
  isActiveMember(
    organizationScopeId: string,
    personId: string,
  ): Promise<boolean>;
}

/**
 * Neutral, read-only facts about one /settlement EconomicValueRecord
 * (the economic authority's own durable record), resolved at the
 * composition root. The benefits boundary consumes EXACTLY these
 * facts: tenancy scope, the state, the immutable amount and the
 * beneficiary. The economic authority keeps everything else.
 */
export interface BenefitValueFundingFacts {
  readonly valueRecordId: string;
  readonly organizationScopeId: string;
  /** The record's authoritative state (see ECONOMIC_VALUE_STATES). */
  readonly state: string;
  /** The record's immutable positive amount (internal `value` unit). */
  readonly amount: number;
  readonly beneficiaryPersonId: string;
  /** True once the record was consumed exactly-once by a draw. */
  readonly consumed: boolean;
  /** True once the record's postings were reversed. */
  readonly reversed: boolean;
}

/**
 * The neutral /settlement value-record lookup consumed by the
 * benefits funding gate. `resolveWithinTx` is the IN-TRANSACTION
 * fresh read (TOCTOU closure — the composite allocation re-derives
 * the funding source state inside the authoritative transaction; the
 * composition root wires this over the /settlement authority's
 * EconomicValueRepository).
 */
export interface BenefitValueFundingLookup {
  resolve(valueRecordId: string): Promise<BenefitValueFundingFacts | null>;
  resolveWithinTx(
    valueRecordId: string,
    tx: AuthorityTransaction,
  ): Promise<BenefitValueFundingFacts | null>;
}

/**
 * Neutral, read-only facts about one /demand NET-W027 verified
 * savings claim (procurement funding), resolved at the composition
 * root. The adapter RE-DERIVES the CURRENT savings verdict by running
 * the /demand savings evaluation with the record's OWN derivation
 * inputs (baseline + observations + selection reference) — the
 * W027 port contract "Economically authoritative consumers (NET-W028+)
 * must consume the DERIVED evaluation for current verdicts, never
 * stale snapshots". The benefits boundary consumes EXACTLY these
 * facts: tenancy scope, the procurement pool binding, the CURRENT
 * derived verdict (supported + savings value + unit + digest), the
 * derivation-policy version and the record format. Protected
 * procurement demand/commitment data NEVER crosses this surface.
 */
export interface BenefitSavingsFundingFacts {
  readonly savingsId: string;
  readonly organizationScopeId: string;
  /** The /demand procurement pool the savings claim belongs to. */
  readonly procurementPoolId: string;
  /** The CURRENT re-derived verdict (false ⇒ funding fails closed). */
  readonly supported: boolean;
  /** The current derived savings value (null when unsupported). */
  readonly savingsValue: number | null;
  readonly unit: string | null;
  /** The current derivation digest (null when unsupported). */
  readonly digest: string | null;
  readonly derivationPolicyVersion: number;
  readonly recordFormat: string;
}

export interface BenefitSavingsFundingLookup {
  /**
   * Resolve the CURRENT derived savings verdict for one savings
   * record. A record that cannot be re-derived (invalidated baseline,
   * stale evidence, superseded observations, lapsed membership)
   * resolves with `supported: false` — funding fails closed.
   */
  resolveCurrent(savingsId: string): Promise<BenefitSavingsFundingFacts | null>;
}

/**
 * Neutral, read-only facts about one /settlement RewardAllocationPolicy
 * version (the economic authority's deterministic-split policy
 * records), resolved at the composition root. The benefits boundary
 * verifies that the settlement policy version referenced by a pool's
 * benefits policy mirrors the benefits policy's member declarations
 * EXACTLY (the consistency bridge — the locked accounts are always
 * the posted accounts, the W020 pinned-policy precedent).
 */
export interface BenefitRewardPolicyFacts {
  readonly policyId: string;
  readonly version: number;
  readonly organizationScopeId: string;
  readonly allocations: readonly {
    readonly beneficiaryPersonId: string;
    readonly weight: number;
  }[];
}

export interface BenefitRewardPolicyLookup {
  resolveLatest(policyId: string): Promise<BenefitRewardPolicyFacts | null>;
}

/** The committed facts of one executed economic draw (lineage only). */
export interface BenefitEconomicDrawFacts {
  /** The executed draw primitive's own result id (reward allocation). */
  readonly drawResultId: string;
  /** The draw's ledger transaction (lineage only — never re-posted). */
  readonly transactionId: string;
  readonly sourceValueRecordId: string;
  readonly policyId: string;
  readonly policyVersion: number;
  readonly totalAllocated: number;
  readonly shares: readonly {
    readonly beneficiaryPersonId: string;
    readonly amount: number;
    readonly weight: number;
  }[];
}

/** The draw input (references + idempotency only — never amounts). */
export interface BenefitEconomicDrawInput {
  readonly organizationScopeId: string;
  readonly sourceValueRecordId: string;
  readonly policyId: string;
  /** Omitted ⇒ the lineage's latest version (pinned by the caller). */
  readonly version?: number;
  readonly idempotencyKey: string;
}

/**
 * BenefitEconomicDrawPort — THE neutral economic-execution port over
 * the /settlement reward-allocation primitive (the ONLY economic
 * mutation a Benefit Pool performs). The composition root wires this
 * over the RewardService's `allocateRewardsWithinTx` (the same-domain
 * `...WithinTx` form — the W020 remediation pattern): the balanced
 * allocation postings, the draw record, the exactly-once value
 * consumption (MATURE → CONSUMED) and the buffered audit event all
 * stage on the CALLER'S authoritative transaction and commit (or roll
 * back) WITH the pool allocation. /settlement remains the sole
 * economic authority; /benefits posts NOTHING itself.
 */
export interface BenefitEconomicDrawPort {
  /**
   * Execute the reward-allocation draw on the caller's authoritative
   * transaction (never the transaction-owning command).
   */
  allocateRewardDrawWithinTx(
    execution: ExecutionContext,
    input: BenefitEconomicDrawInput,
    ctx: IdempotentApplyContext,
  ): Promise<BenefitEconomicDrawFacts>;
  /**
   * The EXACT lock keys the draw's standalone form would acquire (the
   * value-record lock + the account ids in posting order) so the
   * composite allocation holds them ACROSS its authoritative
   * transaction — the locked accounts are always the posted accounts.
   */
  drawLockKeys(input: {
    readonly organizationScopeId: string;
    readonly sourceValueRecordId: string;
    readonly sourceBeneficiaryPersonId: string;
    readonly memberPersonIds: readonly string[];
  }): {
    readonly recordLockKey: string;
    readonly accountIds: readonly string[];
  };
}

/** The neutral lookup bundle consumed by the benefits boundary. */
export interface BenefitPoolLookups {
  readonly membership: BenefitMembershipLookup;
  readonly valueFunding: BenefitValueFundingLookup;
  readonly savingsFunding: BenefitSavingsFundingLookup;
  readonly rewardPolicy: BenefitRewardPolicyLookup;
  readonly economicDraw: BenefitEconomicDrawPort;
}

// ---------------------------------------------------------------------------
// Records — the versioned allocation policy
// ---------------------------------------------------------------------------

/**
 * A BenefitAllocationPolicy — the immutable, versioned record of a
 * deterministic benefit-allocation policy (work order §3.3; the exact
 * NET-W007/W008 policy-lineage pattern).
 *
 * Invariants:
 *  - `policyId` is stable across versions; `version` increases by
 *    exactly 1 (version 1 starts a new lineage); a (policyId, version)
 *    pair is unique — existing versions are NEVER rewritten;
 *  - all versions of a lineage share one organization scope; lineage
 *    creates are serialized under the ORGANIZATION-INDEPENDENT mutex
 *    `benefits_pool_policy_lineage:{policyId}` and the cross-scope
 *    check runs against the org-independent lineage read on EVERY
 *    create (including version 1) — a lineage can never fork (work
 *    order §3.3: policy identity uses the established
 *    organization-independent lineage serialization);
 *  - `memberDeclarations` is non-empty and bounded; each entry
 *    carries a member person + weight > 0; members are unique (the
 *    order is the deterministic allocation order);
 *  - `remainderDisposition` is the closed vocabulary above;
 *    `last_member_absorbs` is REQUIRED for pools that execute the
 *    economic draw (the settlement split semantics — enforced at
 *    allocation time, fail closed);
 *  - `rewardPolicyId` (optional) references the /settlement
 *    RewardAllocationPolicy whose allocation set MUST mirror the
 *    member declarations exactly for economic draws (verified
 *    server-side at every allocation);
 *  - the policy carries NO funding amounts, NO balances and NO
 *    eligibility assertions — only the explicit declaration set the
 *    server re-derives everything from.
 */
export interface BenefitAllocationPolicy {
  readonly id: string;
  readonly policyId: string;
  readonly version: number;
  readonly organizationScopeId: string;
  readonly benefitType: BenefitType;
  /** The closed-vocabulary eligibility criteria (server re-derived). */
  readonly eligibilityCriteria: readonly BenefitEligibilityCriterion[];
  /** The deterministic member + weight declaration set (ordered). */
  readonly memberDeclarations: readonly {
    readonly personId: string;
    readonly weight: number;
  }[];
  readonly remainderDisposition: BenefitRemainderDisposition;
  /** The /settlement reward policy mirrored by this policy (draws). */
  readonly rewardPolicyId: string | null;
  readonly description: string | null;
  readonly createdBy: string;
  readonly createdAt: string;
  readonly recordFormat: string;
  readonly idempotencyKey: string;
  readonly executionId: string;
  readonly correlationId: string;
  readonly causationId: string | null;
}

// ---------------------------------------------------------------------------
// Records — the benefit pool
// ---------------------------------------------------------------------------

/**
 * A BenefitPool — the first-class, tenant-scoped, durable pool record
 * (issue #56 key invariant 1): the explicit funding REFERENCE set
 * (kind + id only — never amounts), the pinned policy lineage, the
 * benefit type, the privacy-preserving views' governing rules and the
 * audit lineage. The pool NEVER accepts a caller-asserted
 * authoritative funded balance: funding amounts are re-derived
 * server-side at EVERY use from the authoritative upstream records.
 *
 * The record is STATIC after creation except the ONE-WAY closure
 * (`closedAt`) — a closed pool can never again allocate (fail-closed
 * re-derivation; /workflows is untouched — closure is a one-way field
 * mutation, NEVER a status machine; no lifecycle subject kind and NO
 * transition machinery exist here).
 */
export interface BenefitPool {
  readonly id: string;
  readonly organizationScopeId: string;
  readonly policyId: string;
  /** The pinned policy version governing this pool's allocations. */
  readonly policyVersion: number;
  readonly benefitType: BenefitType;
  /**
   * The explicit funding references (kind + id ONLY — the authoritative
   * amounts are re-derived at every evaluation/allocation anchor,
   * never stored, never caller-asserted).
   */
  readonly fundingRefs: readonly {
    readonly kind: BenefitFundingSourceKind;
    readonly id: string;
  }[];
  /** The pool creator (server-resolved acting person). */
  readonly createdBy: string;
  readonly createdAt: string;
  /** One-way closure (null while the pool is open). */
  readonly closedAt: string | null;
  readonly recordFormat: string;
  readonly idempotencyKey: string;
  readonly executionId: string;
  readonly correlationId: string;
  readonly causationId: string | null;
}

// ---------------------------------------------------------------------------
// Records — the allocation lineage
// ---------------------------------------------------------------------------

/**
 * One machine-readable sufficiency check of the derived allocation
 * evaluation (issue #56 — evidence is the machine-readable checks, not
 * prose). Every check re-derives from CURRENT authoritative records at
 * the evaluation/allocation anchor.
 */
export interface BenefitPoolCheck {
  readonly check:
    | "pool_active"
    | "policy_version_pinned"
    | "funding_qualified"
    | "funding_available"
    | "members_eligible"
    | "draw_policy_consistent"
    | "conservation_preserved";
  readonly satisfied: boolean;
  /** Deterministic machine-readable detail (funding/policy facts only). */
  readonly detail: Record<string, unknown>;
}

/**
 * A BenefitPoolAllocation — the first-class, durable, tenant-scoped,
 * append-only ALLOCATION LINEAGE record (work order §2: "allocation
 * lineage / execution request"): the server-derived funding snapshot
 * (per reference — the CURRENT authoritative resolution at the
 * allocation anchor), the server-derived eligible member set + weights
 * (re-derived from the pinned policy version + the membership
 * lookup), the deterministic plan (shares + explicit remainder +
 * disposition), the conservation facts (the available envelope + prior
 * allocated total), and — for economic draws ONLY — the executed draw
 * references (the settlement primitive's own result id + ledger
 * transaction id — LINEAGE ONLY: the allocation record posts
 * NOTHING itself; /settlement stays the sole economic authority).
 *
 * IMMUTABLE after creation (append-only lineage — each record is one
 * allocation event; re-allocation records a NEW record). Entitlement-
 * only allocations (savings-funded pools) carry `draw: null` and post
 * nothing: they record the deterministic entitlement plan bounded by
 * the authoritative savings value (no value is minted — when drawable
 * economic value later exists through /settlement's own recognition
 * gates, the draw executes there).
 */
export interface BenefitPoolAllocation {
  readonly id: string;
  readonly organizationScopeId: string;
  readonly poolId: string;
  readonly policyId: string;
  readonly policyVersion: number;
  readonly benefitType: BenefitType;
  /** The server-derived funding snapshot at the allocation anchor. */
  readonly funding: readonly {
    readonly kind: BenefitFundingSourceKind;
    readonly id: string;
    /** The resolved authoritative amount (null when unqualified). */
    readonly resolvedAmount: number | null;
  }[];
  /** The server-derived eligible member set + weights (ordered). */
  readonly members: readonly {
    readonly personId: string;
    readonly weight: number;
  }[];
  /** The deterministic plan (shares in member order). */
  readonly shares: readonly {
    readonly personId: string;
    readonly amount: number;
    readonly weight: number;
  }[];
  readonly totalAllocated: number;
  /** The EXPLICIT remainder (0 for last_member_absorbs). */
  readonly remainderAmount: number;
  readonly remainderDisposition: BenefitRemainderDisposition;
  /** The server-derived available funding envelope at the anchor. */
  readonly availableFunding: number;
  /** The pool's cumulative allocated total BEFORE this allocation. */
  readonly priorAllocatedTotal: number;
  /**
   * The executed economic draw (economic draws only): the settlement
   * reward-allocation result + ledger transaction (lineage only).
   */
  readonly draw:
    | { readonly resultId: string; readonly transactionId: string }
    | null;
  readonly status: "recorded";
  /**
   * The deterministic digest over the canonical allocation facts
   * (policy + funding + members + plan + conservation) — EXCLUDING
   * the allocation anchor (the W021/W024/W025/W026/W027
   * decision-digest precedent).
   */
  readonly digest: string;
  /** The explicit allocation anchor (recorded, never digested). */
  readonly allocatedAt: string;
  readonly recordFormat: string;
  readonly idempotencyKey: string;
  readonly executionId: string;
  readonly correlationId: string;
  readonly causationId: string | null;
}

// ---------------------------------------------------------------------------
// Inputs / results / derived views
// ---------------------------------------------------------------------------

export interface CreateBenefitPoolPolicyInput {
  readonly organizationScopeId: string;
  readonly policyId: string;
  /** Exactly latest+1 for an existing lineage, or 1 to start a new one. */
  readonly version: number;
  readonly benefitType: string;
  readonly eligibilityCriteria: readonly string[];
  readonly memberDeclarations: readonly {
    readonly personId: string;
    readonly weight: number;
  }[];
  readonly remainderDisposition: string;
  readonly rewardPolicyId?: string | null;
  readonly description?: string;
  readonly idempotencyKey: string;
}

export interface CreateBenefitPoolPolicyResult {
  readonly policy: BenefitAllocationPolicy;
  /** false when the idempotency key replayed the committed version. */
  readonly created: boolean;
}

export interface CreateBenefitPoolInput {
  readonly organizationScopeId: string;
  readonly policyId: string;
  /** Omitted ⇒ the lineage's latest version at creation. */
  readonly policyVersion?: number;
  /**
   * The funding references (kind + id ONLY). There is deliberately NO
   * funded-amount input: funding resolves server-side at every use
   * (issue #56 key invariant 2 — a caller-asserted balance is never
   * authority).
   */
  readonly fundingRefs: readonly {
    readonly kind: string;
    readonly id: string;
  }[];
  readonly idempotencyKey: string;
}

export interface CreateBenefitPoolResult {
  readonly pool: BenefitPool;
  /** false when the idempotency key replayed the committed pool. */
  readonly created: boolean;
}

export interface CloseBenefitPoolInput {
  readonly organizationScopeId: string;
  readonly poolId: string;
  readonly idempotencyKey: string;
}

/**
 * The allocation input (references + idempotency only):
 *  - `valueRecordId` — OPTIONAL: which declared `economic_value`
 *    funding reference executes the economic draw (required when the
 *    pool declares MORE THAN ONE economic value reference; defaults
 *    to the single one);
 *  - `amount` — OPTIONAL for entitlement-only (savings-funded) pools:
 *    the requested entitlement amount, which must be ≤ the
 *    server-derived available envelope (the envelope itself is ALWAYS
 *    server-owned); FORBIDDEN for economic draws (the draw allocates
 *    the authoritative record amount exactly — no partial draws, no
 *    caller arithmetic).
 */
export interface AllocatePoolBenefitsInput {
  readonly organizationScopeId: string;
  readonly poolId: string;
  readonly valueRecordId?: string;
  readonly amount?: number;
  readonly idempotencyKey: string;
}

export interface AllocatePoolBenefitsResult {
  readonly allocation: BenefitPoolAllocation;
  /** false when the idempotency key replayed the committed allocation. */
  readonly created: boolean;
}

export interface EvaluatePoolAllocationInput {
  readonly organizationScopeId: string;
  readonly poolId: string;
}

/**
 * The DERIVED allocation view (the W027 evaluate precedent — a
 * derived 200 decision, never a command): the current funding
 * resolution per reference, the current eligibility derivation, the
 * deterministic plan preview, the machine-readable checks and the
 * digest. Mutates nothing; audits nothing.
 */
export interface BenefitPoolAllocationView {
  readonly poolId: string;
  readonly organizationScopeId: string;
  readonly policyId: string;
  readonly policyVersion: number;
  readonly benefitType: BenefitType;
  readonly eligible: boolean;
  readonly checks: readonly BenefitPoolCheck[];
  readonly funding: readonly {
    readonly kind: BenefitFundingSourceKind;
    readonly id: string;
    readonly qualified: boolean;
    readonly resolvedAmount: number | null;
    readonly reason: string | null;
  }[];
  /** The server-derived available funding envelope (qualified only). */
  readonly availableFunding: number;
  /** The pool's cumulative allocated total (committed lineage). */
  readonly priorAllocatedTotal: number;
  /** The deterministic plan preview (null when not eligible). */
  readonly plan: {
    readonly draw: boolean;
    readonly amount: number;
    readonly shares: readonly {
      readonly personId: string;
      readonly amount: number;
      readonly weight: number;
    }[];
    readonly totalAllocated: number;
    readonly remainderAmount: number;
    readonly remainderDisposition: BenefitRemainderDisposition;
  } | null;
  readonly digest: string | null;
  readonly evaluatedAt: string;
}

/**
 * The privacy-preserving MEMBER view (issue #56 invariant 5): a member
 * sees THEIR OWN shares and totals ONLY — never other members'
 * identities, weights or amounts, never the funding reference
 * resolution details, never protected procurement demand data.
 */
export interface BenefitMemberView {
  readonly poolId: string;
  readonly organizationScopeId: string;
  readonly benefitType: BenefitType;
  readonly policyId: string;
  readonly policyVersion: number;
  readonly ownShares: readonly {
    readonly allocationId: string;
    readonly amount: number;
    readonly allocatedAt: string;
  }[];
  readonly ownTotal: number;
  readonly poolTotalAllocated: number;
}

// ---------------------------------------------------------------------------
// Repositories
// ---------------------------------------------------------------------------

export interface BenefitPoolPolicyRepository {
  findById(id: string): Promise<BenefitAllocationPolicy | null>;
  findVersion(
    policyId: string,
    version: number,
  ): Promise<BenefitAllocationPolicy | null>;
  findLatestVersion(
    policyId: string,
    organizationScopeId?: string,
  ): Promise<BenefitAllocationPolicy | null>;
  listVersions(
    policyId: string,
    organizationScopeId?: string,
  ): Promise<readonly BenefitAllocationPolicy[]>;
  /**
   * The ORGANIZATION-INDEPENDENT lineage read (the cross-scope fork
   * guard — any version of the lineage, any scope).
   */
  findAnyVersion(policyId: string): Promise<BenefitAllocationPolicy | null>;
  findByIdWithinTx(
    id: string,
    tx: AuthorityTransaction,
  ): Promise<BenefitAllocationPolicy | null>;
  findVersionWithinTx(
    policyId: string,
    version: number,
    tx: AuthorityTransaction,
  ): Promise<BenefitAllocationPolicy | null>;
  createWithinTx(
    policy: BenefitAllocationPolicy,
    tx: AuthorityTransaction,
  ): Promise<BenefitAllocationPolicy>;
}

export interface BenefitPoolRepository {
  findById(id: string): Promise<BenefitPool | null>;
  findByIdWithinTx(
    id: string,
    tx: AuthorityTransaction,
  ): Promise<BenefitPool | null>;
  createWithinTx(
    pool: BenefitPool,
    tx: AuthorityTransaction,
  ): Promise<BenefitPool>;
  /** One-way closure (in-tx with the closure audit event). */
  closeWithinTx(
    poolId: string,
    closedAt: string,
    tx: AuthorityTransaction,
  ): Promise<BenefitPool>;
  listByOrganization(
    organizationScopeId: string,
    filters?: {
      readonly createdBy?: string;
      readonly openOnly?: boolean;
    },
  ): Promise<readonly BenefitPool[]>;
}

export interface BenefitPoolAllocationRepository {
  findById(id: string): Promise<BenefitPoolAllocation | null>;
  /** The pool's allocation lineage, newest-first by (allocatedAt, id). */
  listByPool(
    organizationScopeId: string,
    poolId: string,
  ): Promise<readonly BenefitPoolAllocation[]>;
  /** In-tx fresh read (the conservation TOCTOU closure). */
  listByPoolWithinTx(
    organizationScopeId: string,
    poolId: string,
    tx: AuthorityTransaction,
  ): Promise<readonly BenefitPoolAllocation[]>;
  createWithinTx(
    allocation: BenefitPoolAllocation,
    tx: AuthorityTransaction,
  ): Promise<BenefitPoolAllocation>;
}

// ---------------------------------------------------------------------------
// The NET-W028 benefit-pool service
// ---------------------------------------------------------------------------

export interface BenefitPoolService {
  /**
   * Create a policy version (append-only). Validates the declaration
   * set (bounded, weights > 0, unique members, closed-vocabulary
   * criteria/disposition, benefit type), enforces version
   * monotonicity + single-scope lineages under the
   * ORGANIZATION-INDEPENDENT lineage mutex
   * `benefits_pool_policy_lineage:{policyId}` (a lineage can never
   * fork — the NET-W007 pattern) and commits the
   * `benefits_policy.version_created` audit event atomically.
   */
  createPolicyVersion(
    execution: ExecutionContext,
    input: CreateBenefitPoolPolicyInput,
  ): Promise<CreateBenefitPoolPolicyResult>;
  getPolicy(
    execution: ExecutionContext,
    input: {
      readonly organizationScopeId: string;
      readonly policyId: string;
      readonly version?: number;
    },
  ): Promise<BenefitAllocationPolicy>;
  listPolicyVersions(
    execution: ExecutionContext,
    input: {
      readonly organizationScopeId: string;
      readonly policyId: string;
    },
  ): Promise<readonly BenefitAllocationPolicy[]>;

  /**
   * Create the Benefit Pool (tenant-scoped; active-member-only): the
   * funding REFERENCE set (kind + id only — never amounts), the
   * pinned policy version (resolved server-side) and the benefit
   * type. Funding references are SHAPE-validated here; the
   * authoritative amounts are re-derived at every evaluation and
   * allocation. Commits the `benefits_pool.created` audit event
   * atomically.
   */
  createBenefitPool(
    execution: ExecutionContext,
    input: CreateBenefitPoolInput,
  ): Promise<CreateBenefitPoolResult>;
  /**
   * Close the pool (ONE-WAY, pool-creator-only): a closed pool can
   * never again allocate (fail-closed re-derivation — closure is a
   * one-way field mutation, never a status transition; /workflows
   * untouched). Commits the `benefits_pool.closed` audit event
   * atomically.
   */
  closeBenefitPool(
    execution: ExecutionContext,
    input: CloseBenefitPoolInput,
  ): Promise<BenefitPool>;
  /** The pool detail view (pool-creator-only; funding resolved). */
  getBenefitPool(
    execution: ExecutionContext,
    input: {
      readonly organizationScopeId: string;
      readonly poolId: string;
    },
  ): Promise<BenefitPool>;
  listBenefitPools(
    execution: ExecutionContext,
    input: {
      readonly organizationScopeId: string;
    },
  ): Promise<readonly BenefitPool[]>;

  /**
   * THE DERIVED ALLOCATION VIEW: the deterministic, privacy-preserving
   * derivation of the pool's CURRENT funding + eligibility + plan at
   * ONE explicit evaluation anchor (the W027 evaluate precedent — a
   * derived 200 decision for every outcome; no command asserts,
   * stores or waives eligibility). Pool-creator-only.
   */
  evaluatePoolAllocation(
    execution: ExecutionContext,
    input: EvaluatePoolAllocationInput,
  ): Promise<BenefitPoolAllocationView>;

  /**
   * THE ATOMIC ALLOCATION OPERATION (work order §3.7/§3.8 + issue #56
   * invariants 6/7): funding re-derivation + eligibility
   * re-derivation + deterministic plan + (for economic draws) the
   * /settlement reward-allocation draw + the allocation lineage
   * record + the buffered audit event as ONE exactly-once economic
   * unit inside ONE authoritative transaction:
   *
   * ```text
   * pool mutex → (economic draws: pinned reward policy + economic
   *   record/account locks) → IdempotencyStore.applyIdempotent(key)
   *       → SINGLE AuthorityTransaction
   *           ├── in-tx fresh pool read (tenant anchor; closure check)
   *           ├── in-tx policy pin (the pool's exact version)
   *           ├── in-tx funding re-derivation (value records in-tx;
   *           │   savings re-derived through the neutral lookup)
   *           ├── in-tx eligibility re-derivation (membership)
   *           ├── the deterministic plan (scaled-integer; explicit
   *           │   remainder; conservation vs the envelope)
   *           ├── (economic draws) the draw WITHIN THE SAME TX
   *           │   through the neutral draw port — the settlement
   *           │   primitive's postings + consumption + audit
   *           ├── the allocation lineage record (same tx)
   *           └── the buffered audit lineage (same tx)
   *       COMMIT — everything durable together, or NOTHING
   * ```
   *
   * A failed authoritative COMMIT leaves NO partial mutation — no
   * postings, no draw record, no value consumption, no allocation
   * record, no audit event — and a retry with the same idempotency
   * key re-executes the whole unit exactly once. Pool-creator-only.
   */
  allocatePoolBenefits(
    execution: ExecutionContext,
    input: AllocatePoolBenefitsInput,
  ): Promise<AllocatePoolBenefitsResult>;

  getBenefitPoolAllocation(
    execution: ExecutionContext,
    input: {
      readonly organizationScopeId: string;
      readonly allocationId: string;
    },
  ): Promise<BenefitPoolAllocation>;
  listPoolAllocations(
    execution: ExecutionContext,
    input: {
      readonly organizationScopeId: string;
      readonly poolId: string;
    },
  ): Promise<readonly BenefitPoolAllocation[]>;

  /**
   * THE PRIVACY-PRESERVING MEMBER VIEW: any ACTIVE member of the
   * tenant organization reads THEIR OWN shares and totals ONLY —
   * never another member's identity, weight or amount, never funding
   * resolution details, never protected procurement data (issue #56
   * invariant 5).
   */
  getMemberBenefitView(
    execution: ExecutionContext,
    input: {
      readonly organizationScopeId: string;
      readonly poolId: string;
    },
  ): Promise<BenefitMemberView>;
}

export interface BenefitPoolServiceDeps {
  readonly policyRepository: BenefitPoolPolicyRepository;
  readonly poolRepository: BenefitPoolRepository;
  readonly allocationRepository: BenefitPoolAllocationRepository;
  readonly lookups: BenefitPoolLookups;
  readonly idempotency: IdempotencyStore;
  readonly auditWriter: TransactionalAuditWriter;
  readonly logger: {
    info(message: string, fields?: Record<string, unknown>): void;
    debug(message: string, fields?: Record<string, unknown>): void;
  };
}
