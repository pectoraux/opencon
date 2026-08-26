/**
 * PolicyService — domain service for authorization policies.
 *
 * Work order ref: spec/work-orders/NET-W002.md
 *   §4.5 Authorization / policy: server-side authorization primitives
 *      including policy storage. The {@link AuthorizationService} consumes
 *      policies from the {@link PolicyRepository}; this service is the
 *      auditable writer for policies.
 *   §4.9 Audit: "authorization policy changed" is an auditable material
 *      mutation (NET-W002-AC-08).
 *
 * Tier compliance: domain tier (participants boundary). Imports only its
 * own port (self, same dir — allowed) and core (ExecutionContext, AuditWriter,
 * Logger, OpenConError, randomUUID — all from core, allowed).
 */

import { randomUUID } from "node:crypto";
import type { AuditWriter } from "../core/audit.ts";
import type { ExecutionContext } from "../core/execution-context.ts";
import {
  ConflictError,
  OpenConError,
} from "../core/errors.ts";
import type { Logger } from "../core/logger.ts";
import type {
  Policy,
  PolicyEffect,
  PolicyRepository,
} from "./port.ts";

const POLICY_CHANGED = "authorization.policy_changed" as const;

export interface PolicyServiceDeps {
  readonly policies: PolicyRepository;
  readonly auditWriter: AuditWriter;
  readonly logger: Logger;
}

export interface CreatePolicyInput {
  readonly subject: string;
  readonly action: string;
  readonly resource: string;
  readonly effect: PolicyEffect;
  readonly createdBy: string;
}

export interface PolicyService {
  /**
   * Create an authorization policy. Emits an
   * `authorization.policy_changed` audit record (§4.9, AC-08).
   */
  createPolicy(context: ExecutionContext, input: CreatePolicyInput): Promise<Policy>;
  /** Fetch a policy by id. */
  getPolicy(context: ExecutionContext, id: string): Promise<Policy>;
  /** All policies (for inspection/tests). */
  listPolicies(context: ExecutionContext): Promise<readonly Policy[]>;
}

export function createPolicyService(deps: PolicyServiceDeps): PolicyService {
  const { policies, auditWriter, logger } = deps;

  const service: PolicyService = {
    async createPolicy(context, input) {
      if (!input.subject) {
        throw new OpenConError({
          code: "POLICY_VALIDATION",
          classification: "validation",
          message: "policy subject is required",
          context: { field: "subject" },
        });
      }
      if (!input.action) {
        throw new OpenConError({
          code: "POLICY_VALIDATION",
          classification: "validation",
          message: "policy action is required",
          context: { field: "action" },
        });
      }
      if (!input.resource) {
        throw new OpenConError({
          code: "POLICY_VALIDATION",
          classification: "validation",
          message: "policy resource is required",
          context: { field: "resource" },
        });
      }
      if (!input.createdBy) {
        throw new OpenConError({
          code: "POLICY_VALIDATION",
          classification: "validation",
          message: "createdBy is required (provenance)",
          context: { field: "createdBy" },
        });
      }
      const policy: Policy = {
        id: randomUUID(),
        subject: input.subject,
        action: input.action,
        resource: input.resource,
        effect: input.effect,
        createdAt: new Date().toISOString(),
        createdBy: input.createdBy,
      };
      await policies.save(policy);
      try {
        await auditWriter.append({
          eventType: POLICY_CHANGED,
          context,
          actor: context.actor?.id ?? input.createdBy,
          subject: policy.id,
          resourceType: "policy",
          resourceId: policy.id,
          metadata: {
            policySubject: policy.subject,
            policyAction: policy.action,
            policyResource: policy.resource,
            policyEffect: policy.effect,
            createdBy: input.createdBy,
          },
        });
      } catch (auditErr) {
        logger.error("policy.audit_failed", auditErr as Error, {
          eventType: POLICY_CHANGED,
          policyId: policy.id,
        });
      }
      logger.info("policy.created", { policyId: policy.id, effect: policy.effect });
      return policy;
    },

    async getPolicy(_context, id) {
      const found = await policies.findById(id);
      if (!found) {
        throw new ConflictError(`policy not found: ${id}`, { policyId: id });
      }
      return found;
    },

    async listPolicies(_context) {
      return policies.all();
    },
  };

  return service;
}

export { ConflictError };
