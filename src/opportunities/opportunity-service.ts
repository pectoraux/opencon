/**
 * OpportunityService — domain service for opportunities.
 *
 * Work order ref: spec/work-orders/NET-W004.md
 *   §3.1 Opportunity first-class model.
 *   §4.1 Only `/workflows` may authoritatively transition lifecycle state.
 *   §4.2 Domain/application services may validate business preconditions
 *      but may NOT bypass workflow authority.
 *   §4.7 Every material mutation preserves execution/correlation/causation
 *      lineage and append-oriented audit evidence.
 *
 * Tier compliance: this file is in the `opportunities` domain boundary.
 * It imports ONLY:
 *   - its own port (self, same dir — allowed),
 *   - core contracts (ExecutionContext, AuditWriter, Logger, OpenConError
 *     subclasses, randomUUID — all from `../core/*`, allowed).
 * It does NOT import infrastructure or any other domain. The AuditWriter
 * is the CORE contract declared in src/core/audit.ts; the concrete writer
 * is injected by the bootstrap composition root.
 *
 * Lifecycle mutation authority: this service NEVER mutates `state` or
 * `version` (those go through the WorkflowService). It only:
 *  - creates an opportunity in DRAFT state (initial state, version 0);
 *  - reads opportunities;
 *  - updates non-lifecycle fields (title, brief, etc.).
 *
 * No economically material behaviour is introduced (work order §5).
 */

import { randomUUID } from "node:crypto";
import type { AuditWriter } from "../core/audit.ts";
import type { ExecutionContext } from "../core/execution-context.ts";
import { NotFoundError, OpenConError } from "../core/errors.ts";
import type { Logger } from "../core/logger.ts";
import type {
  CreateOpportunityInput,
  Opportunity,
  OpportunityRepository,
  OpportunityService,
  UpdateOpportunityInput,
} from "./port.ts";

const OPPORTUNITY_CREATED = "opportunity.created" as const;
const BRIEF_UPDATED = "opportunity.brief_updated" as const;

export interface OpportunityServiceDeps {
  readonly repository: OpportunityRepository;
  readonly auditWriter: AuditWriter;
  readonly logger: Logger;
}

export function createOpportunityService(deps: OpportunityServiceDeps): OpportunityService {
  const { repository, auditWriter, logger } = deps;

  const service: OpportunityService = {
    async createOpportunity(execution, input) {
      // Validate business preconditions (work order §4.2).
      if (!input.organizationScopeId?.trim()) {
        throw new OpenConError({
          code: "OPPORTUNITY_VALIDATION",
          classification: "validation",
          message: "organizationScopeId is required",
          context: { field: "organizationScopeId" },
        });
      }
      if (!input.ownerId?.trim()) {
        throw new OpenConError({
          code: "OPPORTUNITY_VALIDATION",
          classification: "validation",
          message: "ownerId is required",
          context: { field: "ownerId" },
        });
      }
      if (!input.opportunityType?.trim()) {
        throw new OpenConError({
          code: "OPPORTUNITY_VALIDATION",
          classification: "validation",
          message: "opportunityType is required",
          context: { field: "opportunityType" },
        });
      }
      if (!input.title?.trim()) {
        throw new OpenConError({
          code: "OPPORTUNITY_VALIDATION",
          classification: "validation",
          message: "title is required",
          context: { field: "title" },
        });
      }

      // Create in DRAFT state (canonical initial state, version 0).
      const now = new Date().toISOString();
      const id = randomUUID();
      const opportunity: Opportunity = {
        id,
        kind: "opportunity",
        state: "DRAFT",
        version: 0,
        organizationScopeId: input.organizationScopeId,
        ownerId: input.ownerId,
        executionId: execution.executionId,
        correlationId: execution.correlationId,
        causationId: execution.causationId,
        createdAt: now,
        updatedAt: now,
        opportunityType: input.opportunityType,
        title: input.title,
        brief: input.brief ?? {},
        eligibilityPolicyReference: input.eligibilityPolicyReference ?? null,
        contributionRequirements: input.contributionRequirements ?? {},
        evidenceReferencePlaceholders: input.evidenceReferencePlaceholders ?? [],
      };
      // Persist through the authoritative boundary (work order §4.6).
      await repository.save(opportunity, execution);
      // Audit lineage (work order §4.7).
      try {
        await auditWriter.append({
          eventType: OPPORTUNITY_CREATED,
          context: execution,
          actor: execution.actor?.id ?? null,
          subject: opportunity.id,
          resourceType: "opportunity",
          resourceId: opportunity.id,
          metadata: {
            opportunityType: opportunity.opportunityType,
            organizationScopeId: opportunity.organizationScopeId,
            ownerId: opportunity.ownerId,
            title: opportunity.title,
          },
        });
      } catch (auditErr) {
        logger.error("opportunity.audit_failed", auditErr as Error, {
          eventType: OPPORTUNITY_CREATED,
          opportunityId: opportunity.id,
        });
      }
      logger.info("opportunity.created", { opportunityId: opportunity.id });
      return opportunity;
    },

    async getOpportunity(_execution, id) {
      const found = await repository.findById(id);
      if (!found) {
        throw new NotFoundError(`opportunity not found: ${id}`, { opportunityId: id });
      }
      return found;
    },

    async updateBrief(execution, id, input) {
      const current = await repository.findById(id);
      if (!current) {
        throw new NotFoundError(`opportunity not found: ${id}`, { opportunityId: id });
      }
      // Only mutate non-lifecycle fields. Lifecycle state + version are
      // untouched here — they go through the WorkflowService.
      const updated: Opportunity = {
        ...current,
        title: input.title ?? current.title,
        brief: input.brief ?? current.brief,
        eligibilityPolicyReference:
          input.eligibilityPolicyReference ?? current.eligibilityPolicyReference,
        contributionRequirements:
          input.contributionRequirements ?? current.contributionRequirements,
        executionId: execution.executionId,
        correlationId: execution.correlationId,
        causationId: execution.causationId,
        updatedAt: new Date().toISOString(),
      };
      await repository.save(updated, execution);
      try {
        await auditWriter.append({
          eventType: BRIEF_UPDATED,
          context: execution,
          actor: execution.actor?.id ?? null,
          subject: id,
          resourceType: "opportunity",
          resourceId: id,
          metadata: {
            fieldsUpdated: Object.keys(input),
            version: updated.version,
            state: updated.state,
          },
        });
      } catch (auditErr) {
        logger.error("opportunity.audit_failed", auditErr as Error, {
          eventType: BRIEF_UPDATED,
          opportunityId: id,
        });
      }
      logger.info("opportunity.brief_updated", { opportunityId: id });
      return updated;
    },
  };

  return service;
}

export { NotFoundError, OpenConError };
