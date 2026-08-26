/**
 * ContributionService — domain service for contributions.
 *
 * Work order ref: spec/work-orders/NET-W004.md
 *   §3.2 Contribution first-class model.
 *   §4.1 Only `/workflows` may authoritatively transition lifecycle state.
 *   §4.2 Domain/application services may validate business preconditions.
 *
 * Tier compliance: this file is in the `contributions` domain boundary.
 * It imports ONLY:
 *   - its own port (self, same dir — allowed),
 *   - core contracts (ExecutionContext, AuditWriter, Logger, OpenConError
 *     subclasses, randomUUID — all from `../core/*`, allowed).
 * It does NOT import infrastructure or any other domain. The
 * OpportunityLookup structural interface is mirrored in this port so
 * the service can verify opportunity existence/scope without importing
 * the opportunities domain.
 *
 * Lifecycle mutation authority: this service NEVER mutates `state` or
 * `version`. It only:
 *  - creates a contribution in DRAFT state (initial state, version 0)
 *    linked to exactly one opportunity + one contributor (AC-02);
 *  - reads contributions.
 *
 * No economically material behaviour is introduced (work order §5).
 */

import { randomUUID } from "node:crypto";
import type { AuditWriter } from "../core/audit.ts";
import type { ExecutionContext } from "../core/execution-context.ts";
import { NotFoundError, OpenConError } from "../core/errors.ts";
import type { Logger } from "../core/logger.ts";
import type {
  Contribution,
  ContributionRepository,
  ContributionService,
  CreateContributionInput,
  OpportunityLookup,
} from "./port.ts";

const CONTRIBUTION_CREATED = "contribution.created" as const;

export interface ContributionServiceDeps {
  readonly repository: ContributionRepository;
  readonly opportunityLookup: OpportunityLookup;
  readonly auditWriter: AuditWriter;
  readonly logger: Logger;
}

export function createContributionService(deps: ContributionServiceDeps): ContributionService {
  const { repository, opportunityLookup, auditWriter, logger } = deps;

  const service: ContributionService = {
    async createContribution(execution, input) {
      // Validate business preconditions (work order §4.2).
      if (!input.opportunityId?.trim()) {
        throw new OpenConError({
          code: "CONTRIBUTION_VALIDATION",
          classification: "validation",
          message: "opportunityId is required",
          context: { field: "opportunityId" },
        });
      }
      if (!input.contributorId?.trim()) {
        throw new OpenConError({
          code: "CONTRIBUTION_VALIDATION",
          classification: "validation",
          message: "contributorId is required",
          context: { field: "contributorId" },
        });
      }
      if (!input.organizationScopeId?.trim()) {
        throw new OpenConError({
          code: "CONTRIBUTION_VALIDATION",
          classification: "validation",
          message: "organizationScopeId is required",
          context: { field: "organizationScopeId" },
        });
      }
      if (!input.contributionType?.trim()) {
        throw new OpenConError({
          code: "CONTRIBUTION_VALIDATION",
          classification: "validation",
          message: "contributionType is required",
          context: { field: "contributionType" },
        });
      }

      // Verify the opportunity exists AND the contributor's org scope
      // matches the opportunity's scope (AC-02 invariant: a contribution
      // belongs to exactly one opportunity; the contributor must be in
      // the same org scope).
      const opportunityScope =
        await opportunityLookup.getOrganizationScope(input.opportunityId);
      if (opportunityScope === null) {
        throw new NotFoundError(
          `opportunity not found: ${input.opportunityId}`,
          { opportunityId: input.opportunityId },
        );
      }
      if (opportunityScope !== input.organizationScopeId) {
        throw new OpenConError({
          code: "CONTRIBUTION_SCOPE_MISMATCH",
          classification: "validation",
          message: `contribution organization scope ${input.organizationScopeId} does not match opportunity scope ${opportunityScope}`,
          context: {
            opportunityId: input.opportunityId,
            contributionScope: input.organizationScopeId,
            opportunityScope,
          },
        });
      }

      // Create in DRAFT state (canonical initial state, version 0).
      const now = new Date().toISOString();
      const id = randomUUID();
      const contribution: Contribution = {
        id,
        kind: "contribution",
        state: "DRAFT",
        version: 0,
        organizationScopeId: input.organizationScopeId,
        ownerId: input.contributorId, // The contributor is the lifecycle "owner".
        executionId: execution.executionId,
        correlationId: execution.correlationId,
        causationId: execution.causationId,
        createdAt: now,
        updatedAt: now,
        opportunityId: input.opportunityId,
        contributorId: input.contributorId,
        contributionType: input.contributionType,
        submission: input.submission ?? {},
        evidenceReferencePlaceholders: input.evidenceReferencePlaceholders ?? [],
      };
      await repository.save(contribution, execution);
      try {
        await auditWriter.append({
          eventType: CONTRIBUTION_CREATED,
          context: execution,
          actor: execution.actor?.id ?? null,
          subject: contribution.id,
          resourceType: "contribution",
          resourceId: contribution.id,
          metadata: {
            opportunityId: contribution.opportunityId,
            contributorId: contribution.contributorId,
            organizationScopeId: contribution.organizationScopeId,
            contributionType: contribution.contributionType,
          },
        });
      } catch (auditErr) {
        logger.error("contribution.audit_failed", auditErr as Error, {
          eventType: CONTRIBUTION_CREATED,
          contributionId: contribution.id,
        });
      }
      logger.info("contribution.created", { contributionId: contribution.id });
      return contribution;
    },

    async getContribution(_execution, id) {
      const found = await repository.findById(id);
      if (!found) {
        throw new NotFoundError(`contribution not found: ${id}`, { contributionId: id });
      }
      return found;
    },
  };

  return service;
}

export { NotFoundError, OpenConError };
