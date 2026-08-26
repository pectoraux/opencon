/**
 * Opportunities boundary — declared public interface (port).
 *
 * Architecture ref: spec/architecture.md §17 (canonical lifecycle),
 * §18 (Module ownership): `/opportunities` owns the Opportunity entity
 * and its business rules. Lifecycle mutation authority is delegated to
 * `/workflows` (work order §4.1).
 * Architecture ref: spec/architecture-lock.md §2 (core domain
 * `/opportunities`).
 *
 * Work order ref: spec/work-orders/NET-W004.md
 *   §3.1 Opportunity: stable identifier; org/participant owner;
 *      opportunity type; title/description or structured brief;
 *      eligibility policy reference; contribution requirements;
 *      lifecycle state; timestamps; version/revision; execution/
 *      correlation lineage for material mutations.
 *   §4.1 Only `/workflows` may authoritatively transition lifecycle state.
 *   §4.2 Domain/application services may validate business preconditions
 *      but may NOT bypass workflow authority.
 *   §4.6 Material lifecycle mutations persist through PostgreSQL-backed
 *      authority boundaries established by NET-W003.
 *
 * CROSS-BOUNDARY NOTE: the opportunities domain is `domain` tier. The
 * tier allow matrix (scripts/lib/architecture.ts) prohibits
 * domain→infrastructure imports. The OpportunityRepository therefore
 * consumes the provider-neutral {@link PostgresAuthority} contract from
 * `src/core/postgres-authority.ts` (core→core is allowed). The concrete
 * PostgreSQL driver lives in `src/adapters/postgres/` and is wired by
 * the bootstrap composition root.
 *
 * The OpportunityRepository extends the {@link LifecycleRepository}
 * structural interface from `/workflows` so the workflow service can
 * mutate lifecycle state uniformly. The repository implementation
 * lives in `authority-opportunity-repository.ts` (same dir, self-import
 * allowed).
 *
 * Out of scope (work order §5): no economic value, reputation, settlement,
 * fraud, evidence evaluation or Proof-of-Value. Evidence references are
 * placeholders only.
 */

import type { ExecutionContext } from "../core/execution-context.ts";
import type { AuthorityTransaction } from "../core/postgres-authority.ts";
import type {
  LifecycleState,
  LifecycleSubject,
} from "../core/workflow.ts";

/**
 * The kind of opportunity. The protocol is provider-neutral — opportunity
 * types are extensible without creating product-specific alternate
 * workflow systems (work order §3.1: "Opportunity types shall remain
 * extensible"). The string discriminator is opaque; downstream work
 * items (campaigns, helpful contributions, demand pools) attach concrete
 * semantics.
 */
export type OpportunityType = string;

/**
 * A structured brief for an opportunity. Provider-neutral — the shape
 * is intentionally loose so domain-specific briefs (campaign briefs,
 * demand briefs, etc.) can be carried without changing the workflow
 * model. NET-W004 does not interpret the brief; later work items do.
 */
export type OpportunityBrief = Readonly<Record<string, unknown>>;

/**
 * An Opportunity — a first-class protocol object (work order §3.1).
 * Satisfies the {@link LifecycleSubject} contract so the workflow
 * service can mutate its lifecycle state uniformly.
 *
 * Invariants:
 *  - `id` is stable and opaque.
 *  - `organizationScopeId` is the tenant/participant scope; transitions
 *    are scoped to this org (work order §4.5).
 *  - `ownerId` is the canonical identity id of the opportunity's owner.
 *  - `state` is the lifecycle state (canonical or exceptional).
 *  - `version` is monotonic; the workflow service uses optimistic
 *    concurrency (work order §4.8).
 *  - `opportunityType` is opaque; extensible.
 *  - `brief` is the structured content (provider-neutral shape).
 *  - `eligibilityPolicyReference` is a stable reference to a policy
 *    (NOT evaluated in NET-W004; later work items enforce it).
 *  - `contributionRequirements` is a description of what a contribution
 *    must satisfy (provider-neutral shape; NOT evaluated in NET-W004).
 *  - `evidenceReferencePlaceholders` are neutral IDs only; no
 *    Proof-of-Value evaluation (work order §5).
 *  - `executionId` / `correlationId` / `causationId` are stable lineage
 *    identifiers carried forward so audit records can be traced back to
 *    the execution that produced the mutation (work order §4.7).
 *  - `createdAt` / `updatedAt` are ISO-8601 timestamps.
 */
export interface Opportunity extends LifecycleSubject {
  /** The opportunity type (opaque; extensible). */
  readonly opportunityType: OpportunityType;
  /** Title (display surface). */
  readonly title: string;
  /** Structured brief (provider-neutral shape). */
  readonly brief: OpportunityBrief;
  /** Stable reference to an eligibility policy (NOT evaluated here). */
  readonly eligibilityPolicyReference: string | null;
  /** Provider-neutral description of what a contribution must satisfy. */
  readonly contributionRequirements: Readonly<Record<string, unknown>>;
  /** Neutral IDs only; no Proof-of-Value evaluation in this work item. */
  readonly evidenceReferencePlaceholders: readonly string[];
}

/**
 * Inputs to create an opportunity. The opportunity is created in
 * `DRAFT` state with version 0; transitions out of DRAFT go through
 * the workflow service.
 */
export interface CreateOpportunityInput {
  readonly organizationScopeId: string;
  readonly ownerId: string;
  readonly opportunityType: OpportunityType;
  readonly title: string;
  readonly brief?: OpportunityBrief;
  readonly eligibilityPolicyReference?: string | null;
  readonly contributionRequirements?: Readonly<Record<string, unknown>>;
  readonly evidenceReferencePlaceholders?: readonly string[];
}

/**
 * Inputs to update the brief / non-lifecycle fields of an opportunity.
 * The lifecycle state is NOT mutated here — only through the workflow
 * service. NET-W004 ships a minimal updateBrief operation so AC-01 can
 * prove non-lifecycle mutations persist durably.
 */
export interface UpdateOpportunityInput {
  readonly title?: string;
  readonly brief?: OpportunityBrief;
  readonly eligibilityPolicyReference?: string | null;
  readonly contributionRequirements?: Readonly<Record<string, unknown>>;
}

/**
 * OpportunityRepository — persistence port for opportunities.
 *
 * The repository is the authoritative application state boundary for
 * Opportunity entities (work order §4.6). All material mutations
 * persist through the {@link PostgresAuthority} boundary established
 * by NET-W003.
 *
 * The repository exposes BOTH:
 *  - domain-specific operations (save, findById, listByOrganization)
 *    used by the OpportunityService; AND
 *  - the {@link LifecycleRepository} structural interface
 *    (getByIdWithinTx, saveWithinTx) used by the WorkflowService.
 *
 * The two sets are kept on the same interface so the workflow service's
 * lifecycle mutations and the opportunity service's domain mutations
 * share the SAME authoritative boundary (no second write path).
 */
export interface OpportunityRepository {
  /**
   * Save an opportunity (create or update). The caller provides the
   * full entity; the repository persists it within an authoritative
   * transaction. Used by OpportunityService.createOpportunity and
   * updateBrief.
   */
  save(opportunity: Opportunity, execution: ExecutionContext): Promise<Opportunity>;
  /** Read an opportunity by id (committed state). */
  findById(id: string): Promise<Opportunity | null>;
  /** List opportunities for an organization (committed state). */
  listByOrganization(organizationScopeId: string): Promise<readonly Opportunity[]>;
  /** Check existence. */
  exists(id: string): Promise<boolean>;

  /**
   * LifecycleRepository structural surface (consumed by the
   * WorkflowService). Reads + writes within an authoritative
   * transaction so the lifecycle mutation commits atomically with
   * the idempotency record + the audit record.
   */
  getByIdWithinTx(
    id: string,
    tx: AuthorityTransaction,
  ): Promise<Opportunity | null>;
  saveWithinTx(
    subject: Opportunity,
    expectedVersion: number,
    execution: ExecutionContext,
    tx: AuthorityTransaction,
  ): Promise<Opportunity>;
}

/**
 * OpportunityService — domain service for opportunities (work order §3.1).
 *
 * Owns:
 *  - createOpportunity → persists a new opportunity in DRAFT state
 *    (lifecycle state DRAFT, version 0).
 *  - getOpportunity → reads by id.
 *  - updateBrief → updates non-lifecycle fields (title, brief, etc.).
 *
 * Does NOT mutate lifecycle state — that goes through the WorkflowService
 * (work order §4.1, §4.2). The OpportunityService may validate business
 * preconditions but never bypasses workflow authority.
 */
export interface OpportunityService {
  createOpportunity(
    execution: ExecutionContext,
    input: CreateOpportunityInput,
  ): Promise<Opportunity>;
  getOpportunity(
    execution: ExecutionContext,
    id: string,
  ): Promise<Opportunity>;
  updateBrief(
    execution: ExecutionContext,
    id: string,
    input: UpdateOpportunityInput,
  ): Promise<Opportunity>;
}

/**
 * The OpportunitiesPort describes the boundary's readiness. After
 * NET-W004 it is `"ready"` (the boundary carries the Opportunity entity
 * + repository + service).
 */
export interface OpportunitiesPort {
  readonly boundary: "opportunities";
  readonly readiness: "ready";
  readonly auditEventTypes: {
    readonly created: "opportunity.created";
    readonly briefUpdated: "opportunity.brief_updated";
  };
}

export type { ExecutionContext, LifecycleState, LifecycleSubject };
