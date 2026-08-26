/**
 * Contributions boundary — declared public interface (port).
 *
 * Architecture ref: spec/architecture.md §17 (canonical lifecycle),
 * §18 (Module ownership): `/contributions` owns the Contribution entity.
 * Lifecycle mutation authority is delegated to `/workflows` (work order
 * §4.1).
 * Architecture ref: spec/architecture-lock.md §2 (core domain
 * `/contributions`).
 *
 * Work order ref: spec/work-orders/NET-W004.md
 *   §3.2 Contribution: stable identifier; opportunity reference;
 *      contributor reference; submission payload/reference appropriate
 *      to the contribution type; lifecycle state; timestamps; revision/
 *      version; evidence-reference placeholders only (no Proof-of-Value
 *      evaluation in this work item); execution/correlation lineage.
 *   §4 Required invariants:
 *      2. Domain/application services may validate business preconditions
 *         but may not bypass workflow authority.
 *      7. Every material mutation preserves execution/correlation/causation
 *         lineage and append-oriented audit evidence.
 *
 * CROSS-BOUNDARY NOTE: the contributions domain is `domain` tier. The
 * tier allow matrix prohibits domain→infrastructure and domain→other-
 * domain imports. The ContributionRepository therefore consumes the
 * provider-neutral {@link PostgresAuthority} contract from
 * `src/core/postgres-authority.ts` (core→core is allowed). The
 * OpportunityLookup structural interface is mirrored here so the
 * ContributionService can verify the opportunity exists without
 * importing the opportunities domain — the bootstrap composition root
 * wires a thin adapter that delegates to the real OpportunityRepository.
 *
 * The ContributionRepository extends the {@link LifecycleRepository}
 * structural interface from `/workflows` so the workflow service can
 * mutate lifecycle state uniformly.
 *
 * Out of scope (work order §5): no evidence evaluation or Proof-of-
 * Value, no outcome/measurement, no reputation, no settlement. Evidence
 * references are placeholders only.
 */

import type { ExecutionContext } from "../core/execution-context.ts";
import type { AuthorityTransaction } from "../core/postgres-authority.ts";
import type {
  LifecycleState,
  LifecycleSubject,
} from "../core/workflow.ts";

/**
 * The kind of contribution. Provider-neutral — the string discriminator
 * is opaque; downstream work items (helpful contributions, UGC, etc.)
 * attach concrete semantics. NET-W004 does not interpret the kind.
 */
export type ContributionType = string;

/**
 * A submission payload/reference appropriate to the contribution type
 * (work order §3.2). Provider-neutral — opaque shape so different
 * contribution types can carry different submission structures without
 * changing the workflow model. NET-W004 does not interpret the payload.
 */
export type ContributionSubmission = Readonly<Record<string, unknown>>;

/**
 * A Contribution — a first-class protocol object linked to exactly one
 * Opportunity and one contributor (work order §3.2).
 *
 * Invariants:
 *  - `id` is stable and opaque.
 *  - `opportunityId` references exactly one Opportunity. The
 *    Contribution belongs to exactly one Opportunity (AC-02).
 *  - `contributorId` is the canonical identity id of the contributor.
 *    The Contribution belongs to exactly one contributor (AC-02).
 *  - `organizationScopeId` is the tenant/participant scope inherited
 *    from the opportunity; transitions are scoped to this org.
 *  - `state` is the lifecycle state (canonical or exceptional).
 *  - `version` is monotonic; the workflow service uses optimistic
 *    concurrency (work order §4.8).
 *  - `contributionType` is opaque; extensible.
 *  - `submission` is the structured payload (provider-neutral shape).
 *  - `evidenceReferencePlaceholders` are neutral IDs only; no
 *    Proof-of-Value evaluation (work order §5).
 *  - `executionId` / `correlationId` / `causationId` are stable lineage
 *    identifiers (work order §4.7).
 *  - `createdAt` / `updatedAt` are ISO-8601 timestamps.
 */
export interface Contribution extends LifecycleSubject {
  /** The opportunity this contribution belongs to (AC-02 invariant). */
  readonly opportunityId: string;
  /** The contributor this contribution belongs to (AC-02 invariant). */
  readonly contributorId: string;
  /** The contribution type (opaque; extensible). */
  readonly contributionType: ContributionType;
  /** Structured submission payload/reference (provider-neutral). */
  readonly submission: ContributionSubmission;
  /** Neutral IDs only; no Proof-of-Value evaluation in this work item. */
  readonly evidenceReferencePlaceholders: readonly string[];
}

/**
 * Inputs to create a contribution. The contribution is created in
 * `DRAFT` state with version 0; transitions out of DRAFT go through
 * the workflow service.
 */
export interface CreateContributionInput {
  readonly opportunityId: string;
  readonly contributorId: string;
  readonly organizationScopeId: string;
  readonly contributionType: ContributionType;
  readonly submission?: ContributionSubmission;
  readonly evidenceReferencePlaceholders?: readonly string[];
}

/**
 * ContributionRepository — persistence port for contributions.
 *
 * The repository is the authoritative application state boundary for
 * Contribution entities (work order §4.6). All material mutations
 * persist through the {@link PostgresAuthority} boundary.
 *
 * The repository exposes BOTH:
 *  - domain-specific operations (save, findById, listByOpportunity,
 *    listByContributor); AND
 *  - the {@link LifecycleRepository} structural interface
 *    (getByIdWithinTx, saveWithinTx) consumed by the WorkflowService.
 */
export interface ContributionRepository {
  save(contribution: Contribution, execution: ExecutionContext): Promise<Contribution>;
  findById(id: string): Promise<Contribution | null>;
  listByOpportunity(opportunityId: string): Promise<readonly Contribution[]>;
  listByContributor(contributorId: string): Promise<readonly Contribution[]>;
  exists(id: string): Promise<boolean>;

  /**
   * LifecycleRepository structural surface (consumed by the
   * WorkflowService).
   */
  getByIdWithinTx(
    id: string,
    tx: AuthorityTransaction,
  ): Promise<Contribution | null>;
  saveWithinTx(
    subject: Contribution,
    expectedVersion: number,
    execution: ExecutionContext,
    tx: AuthorityTransaction,
  ): Promise<Contribution>;
}

/**
 * OpportunityLookup — structural surface the ContributionService
 * consumes to verify the opportunity exists and resolve its
 * organization scope. Mirrored from `/opportunities`. The bootstrap
 * wires the concrete OpportunityRepository to satisfy this.
 */
export interface OpportunityLookup {
  /** Returns the opportunity's organization scope id, or null if absent. */
  getOrganizationScope(opportunityId: string): Promise<string | null>;
  /** Returns true iff the opportunity exists. */
  exists(opportunityId: string): Promise<boolean>;
}

/**
 * ContributionService — domain service for contributions (work order §3.2).
 *
 * Owns:
 *  - createContribution → persists a new contribution in DRAFT state
 *    linked to exactly one opportunity + one contributor. Validates
 *    the opportunity exists + the contributor's organization scope
 *    matches the opportunity's scope (AC-02 invariant).
 *  - getContribution → reads by id.
 *
 * Does NOT mutate lifecycle state — that goes through the WorkflowService
 * (work order §4.1, §4.2).
 */
export interface ContributionService {
  createContribution(
    execution: ExecutionContext,
    input: CreateContributionInput,
  ): Promise<Contribution>;
  getContribution(
    execution: ExecutionContext,
    id: string,
  ): Promise<Contribution>;
}

/**
 * The ContributionsPort describes the boundary's readiness. After
 * NET-W004 it is `"ready"`.
 */
export interface ContributionsPort {
  readonly boundary: "contributions";
  readonly readiness: "ready";
  readonly auditEventTypes: {
    readonly created: "contribution.created";
  };
}

export type { ExecutionContext, LifecycleState, LifecycleSubject };
