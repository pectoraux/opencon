/**
 * NET-W004 shared test harness.
 *
 * Sets up the runtime + an authenticated principal + an organization
 * + an opportunity + (optionally) a contribution. Used by the AC-01..07
 * test suites so they don't repeat the same setup boilerplate.
 *
 * The harness uses the file-backed PostgresAuthorityShim (test/dev double
 * from NET-W003) so it runs without a real PostgreSQL. The shim proves
 * the SAME authority semantics (durability, transactional atomicity,
 * recovery) required by the workflow service.
 */

import { createRuntime, type Runtime } from "../../src/bootstrap/runtime.ts";
import { createExecutionContext } from "../../src/core/execution-context.ts";
import type { ExecutionContext } from "../../src/core/execution-context.ts";
// Import the transition table to enumerate every legal transition's
// policyAction so the test harness seeds an allow policy for each. This
// guarantees the workflow service's authorization check matches a policy
// for every legal transition (no test is silently denied because of a
// missing policy). The transition table is data — importing it here
// does not couple the tests to the workflow service's internals.
import {
  OPPORTUNITY_TRANSITION_TABLE,
  CONTRIBUTION_TRANSITION_TABLE,
} from "../../src/workflows/transition-table.ts";

export interface NetW004Harness {
  readonly runtime: Runtime;
  /** Bootstrap execution context (system actor). */
  readonly bootstrapCtx: ExecutionContext;
  /** The canonical person identity id of the authorized actor. */
  readonly personId: string;
  /** The subject id used by the API auth guard (X-Auth-Subject-Id). */
  readonly subjectId: string;
  /** The organization scope id (the tenant). */
  readonly organizationScopeId: string;
  /** Tear down the harness (shutdown the runtime). */
  teardown(): Promise<void>;
}

export interface CreateHarnessOptions {
  /**
   * When true (default), seed an ALLOW policy for the person covering
   * all opportunity/contribution/transition actions on the organization
   * scope. When false, the person is authenticated but has NO allow
   * policies (deny-by-default).
   */
  readonly seedAllowPolicy?: boolean;
}

export async function createNetW004Harness(
  opts: CreateHarnessOptions = {},
): Promise<NetW004Harness> {
  const seedAllowPolicy = opts.seedAllowPolicy ?? true;
  const runtime = createRuntime({
    forceEnv: "test",
    env: { APP_ENV: "test", LOG_LEVEL: "warn" },
    port: 0,
  });
  await runtime.initialize();
  await runtime.api.start();
  const bootstrapCtx = createExecutionContext({
    correlationId: "net-w004-bootstrap",
    actor: { id: "bootstrap", kind: "service" },
  });
  // Create a canonical person identity for the authorized actor.
  const person = await runtime.identityService.createIdentity(bootstrapCtx, {
    displayName: "Test Actor",
    subjectReferences: [{ subjectId: "actor@example.com", providerKind: "internal" }],
  });
  // Create an organization the actor will act in.
  const org = await runtime.organizationService.createOrganization(bootstrapCtx, {
    name: "Test Org",
    creatorId: person.id,
  });
  if (seedAllowPolicy) {
    // Seed an ALLOW policy covering the NET-W004 opportunity/contribution
    // CREATION actions. The API guard authorizes opportunity.create and
    // contribution.create at resource "*" (any authenticated principal
    // with an allow policy can create). The actual organization-scope
    // scoping is enforced later by the workflow service's per-subject
    // authorization (which checks the subject's organizationScopeId
    // against the policy's resource).
    await runtime.policyService.createPolicy(bootstrapCtx, {
      subject: "*",
      action: "opportunity.create",
      resource: "*",
      effect: "allow",
      createdBy: "bootstrap",
    });
    await runtime.policyService.createPolicy(bootstrapCtx, {
      subject: "*",
      action: "contribution.create",
      resource: "*",
      effect: "allow",
      createdBy: "bootstrap",
    });
    // Seed an ALLOW policy for the API endpoint's guard action
    // "workflow.transition" at resource "*" so any authenticated
    // principal with the harness's allow-policy set can call the
    // transition endpoint. The workflow service then does per-subject
    // authorization (checking the subject's org scope against the
    // transition-specific policies below).
    await runtime.policyService.createPolicy(bootstrapCtx, {
      subject: "*",
      action: "workflow.transition",
      resource: "*",
      effect: "allow",
      createdBy: "bootstrap",
    });
    // Seed per-transition allow policies scoped to the HARNESS PERSON
    // (not "*") so only the harness person can transition opportunities
    // and contributions in this org. Other persons (with no matching
    // policy) are denied (deny-by-default). The workflow service's
    // transitionAuthorizer checks the subject's organizationScopeId
    // against the policy's resource, so cross-org transitions are
    // denied even for the harness person.
    for (const rule of OPPORTUNITY_TRANSITION_TABLE) {
      await runtime.policyService.createPolicy(bootstrapCtx, {
        subject: person.id,
        action: rule.policyAction,
        resource: org.id,
        effect: "allow",
        createdBy: "bootstrap",
      });
    }
    for (const rule of CONTRIBUTION_TRANSITION_TABLE) {
      await runtime.policyService.createPolicy(bootstrapCtx, {
        subject: person.id,
        action: rule.policyAction,
        resource: org.id,
        effect: "allow",
        createdBy: "bootstrap",
      });
    }
  }
  return {
    runtime,
    bootstrapCtx,
    personId: person.id,
    subjectId: "actor@example.com",
    organizationScopeId: org.id,
    async teardown() {
      await runtime.shutdown();
    },
  };
}

/**
 * Create an opportunity through the OpportunityService (direct domain call,
 * not via the API). Returns the new opportunity (DRAFT state, version 0).
 */
export async function createOpportunity(
  harness: NetW004Harness,
): Promise<{ id: string; version: number; state: string }> {
  const ctx = createExecutionContext({
    correlationId: `opp-${Date.now()}`,
    actor: { id: harness.personId, kind: "person" },
  });
  const opp = await harness.runtime.opportunityService.createOpportunity(ctx, {
    organizationScopeId: harness.organizationScopeId,
    ownerId: harness.personId,
    opportunityType: "test-opportunity",
    title: "Test Opportunity",
    brief: { kind: "test" },
  });
  return { id: opp.id, version: opp.version, state: opp.state };
}

/**
 * Create a contribution through the ContributionService. Requires an
 * existing opportunity (whose organizationScopeId is used).
 */
export async function createContribution(
  harness: NetW004Harness,
  opportunityId: string,
): Promise<{ id: string; version: number; state: string }> {
  const ctx = createExecutionContext({
    correlationId: `contrib-${Date.now()}`,
    actor: { id: harness.personId, kind: "person" },
  });
  const c = await harness.runtime.contributionService.createContribution(ctx, {
    opportunityId,
    contributorId: harness.personId,
    organizationScopeId: harness.organizationScopeId,
    contributionType: "test-contribution",
    submission: { kind: "test" },
  });
  return { id: c.id, version: c.version, state: c.state };
}
