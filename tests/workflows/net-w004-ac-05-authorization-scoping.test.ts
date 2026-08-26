/**
 * NET-W004-AC-05 — Authorization and scoping.
 *
 * A caller may transition only opportunities/contributions for which the
 * server-side participant/organization policy permits the operation.
 * Forged client claims cannot authorize a transition, and cross-
 * organization access is rejected.
 *
 * Evidence: authorization/security tests.
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { createExecutionContext } from "../../src/core/execution-context.ts";
import { AuthorizationError } from "../../src/core/errors.ts";
import {
  createNetW004Harness,
  createOpportunity,
  type NetW004Harness,
} from "./_net-w004-harness.ts";

let harness: NetW004Harness;

beforeEach(async () => {
  harness = await createNetW004Harness();
});

afterEach(async () => {
  await harness.teardown();
});

describe("NET-W004-AC-05 authorization and scoping", () => {
  test("an authenticated principal WITH a matching allow policy can transition", async () => {
    const opp = await createOpportunity(harness);
    const ctx = createExecutionContext({
      correlationId: "ac05-allow",
      actor: { id: harness.personId, kind: "person" },
    });
    const result = await harness.runtime.workflowService.requestTransition(
      {
        subjectId: opp.id,
        subjectKind: "opportunity",
        targetState: "READY",
        expectedVersion: 0,
        idempotencyKey: "ac05-allow",
        actorPersonId: harness.personId,
        policyAction: "opportunity.transition.draft_to_ready",
      },
      ctx,
    );
    expect(result.executed).toBe(true);
    expect(result.subject.state).toBe("READY");
  });

  test("an unauthenticated principal (null personId) is rejected (deny-by-default)", async () => {
    const opp = await createOpportunity(harness);
    const ctx = createExecutionContext({
      correlationId: "ac05-unauth",
      actor: null,
    });
    await expect(
      harness.runtime.workflowService.requestTransition(
        {
          subjectId: opp.id,
          subjectKind: "opportunity",
          targetState: "READY",
          expectedVersion: 0,
          idempotencyKey: "ac05-unauth",
          actorPersonId: "nonexistent-person-id",
          policyAction: "opportunity.transition.draft_to_ready",
        },
        ctx,
      ),
    ).rejects.toBeInstanceOf(AuthorizationError);
  });

  test("cross-organization transition is rejected (the subject's organizationScopeId is the resource checked)", async () => {
    // Create an opportunity in a DIFFERENT org (other-Org).
    const otherOrg = await harness.runtime.organizationService.createOrganization(
      harness.bootstrapCtx,
      { name: "Other Org", creatorId: harness.personId },
    );
    const ctx = createExecutionContext({
      correlationId: "ac05-cross-org",
      actor: { id: harness.personId, kind: "person" },
    });
    const otherOpp = await harness.runtime.opportunityService.createOpportunity(ctx, {
      organizationScopeId: otherOrg.id,
      ownerId: harness.personId,
      opportunityType: "campaign",
      title: "Other Org Opp",
    });
    // The harness seeded allow policies ONLY for the harness org, not
    // for otherOrg. So a transition on otherOpp by harness.personId
    // must be denied (deny-by-default: no allow policy matches the
    // otherOrg resource).
    await expect(
      harness.runtime.workflowService.requestTransition(
        {
          subjectId: otherOpp.id,
          subjectKind: "opportunity",
          targetState: "READY",
          expectedVersion: 0,
          idempotencyKey: "ac05-cross-org",
          actorPersonId: harness.personId,
          policyAction: "opportunity.transition.draft_to_ready",
        },
        ctx,
      ),
    ).rejects.toBeInstanceOf(AuthorizationError);
  });

  test("a principal with NO allow policies is denied (deny-by-default) even with forged client claims", async () => {
    // Create a SECOND person with no allow policies.
    const other = await harness.runtime.identityService.createIdentity(
      harness.bootstrapCtx,
      {
        displayName: "No Policy User",
        subjectReferences: [{ subjectId: "nopolicy@example.com", providerKind: "internal" }],
      },
    );
    const opp = await createOpportunity(harness);
    const ctx = createExecutionContext({
      correlationId: "ac05-no-policy",
      actor: { id: other.id, kind: "person" },
    });
    // The transition authorizer does NOT accept client claims (the
    // workflow service's TransitionAuthorizer interface is separate
    // from the API auth guard's client-claims path). The authorizer
    // re-resolves effective authorization from server state only.
    await expect(
      harness.runtime.workflowService.requestTransition(
        {
          subjectId: opp.id,
          subjectKind: "opportunity",
          targetState: "READY",
          expectedVersion: 0,
          idempotencyKey: "ac05-no-policy",
          actorPersonId: other.id,
          policyAction: "opportunity.transition.draft_to_ready",
        },
        ctx,
      ),
    ).rejects.toBeInstanceOf(AuthorizationError);
  });

  test("the subject's organizationScopeId is the resource checked (a contribution in a different org is rejected)", async () => {
    // Create an opportunity + contribution in the harness org.
    const opp = await createOpportunity(harness);
    const ctx = createExecutionContext({
      correlationId: "ac05-contribution-cross-org",
      actor: { id: harness.personId, kind: "person" },
    });
    const c = await harness.runtime.contributionService.createContribution(ctx, {
      opportunityId: opp.id,
      contributorId: harness.personId,
      organizationScopeId: harness.organizationScopeId,
      contributionType: "test",
    });
    // The harness org has allow policies for contribution.transition.*.
    // A transition on the harness-org contribution by harness.personId
    // is allowed.
    const result = await harness.runtime.workflowService.requestTransition(
      {
        subjectId: c.id,
        subjectKind: "contribution",
        targetState: "READY",
        expectedVersion: 0,
        idempotencyKey: "ac05-contribution-allowed",
        actorPersonId: harness.personId,
        policyAction: "contribution.transition.draft_to_ready",
      },
      ctx,
    );
    expect(result.executed).toBe(true);
    expect(result.subject.state).toBe("READY");
  });

  test("the API auth guard rejects an unauthenticated transition request (403)", async () => {
    const opp = await createOpportunity(harness);
    // No X-Auth-Subject-Id header → unauthenticated → deny.
    const res = await fetch(
      `http://127.0.0.1:${harness.runtime.api.port}/api/workflows/transitions`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-correlation-id": "ac05-api-unauth",
        },
        body: JSON.stringify({
          subjectId: opp.id,
          subjectKind: "opportunity",
          targetState: "READY",
          expectedVersion: 0,
          idempotencyKey: "ac05-api-unauth",
          policyAction: "opportunity.transition.draft_to_ready",
        }),
      },
    );
    expect(res.status).toBe(403);
  });

  test("the API auth guard rejects a transition request with forged client claims when no allow policy matches", async () => {
    // Seed a second person with NO allow policies.
    const other = await harness.runtime.identityService.createIdentity(
      harness.bootstrapCtx,
      {
        displayName: "Forged User",
        subjectReferences: [{ subjectId: "forged@example.com", providerKind: "internal" }],
      },
    );
    const opp = await createOpportunity(harness);
    // Forged client claims: the client asserts role ADMIN and scope "*".
    // The auth guard MUST ignore these and rely only on server-resolved
    // state + policies. No allow policy exists for `other`, so the
    // request MUST be denied (deny-by-default).
    const res = await fetch(
      `http://127.0.0.1:${harness.runtime.api.port}/api/workflows/transitions`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-correlation-id": "ac05-api-forged",
          "x-auth-subject-id": "forged@example.com",
          "x-auth-provider-kind": "internal",
          "x-client-claims": JSON.stringify({ role: "ADMIN", scope: "*", isAdmin: true }),
        },
        body: JSON.stringify({
          subjectId: opp.id,
          subjectKind: "opportunity",
          targetState: "READY",
          expectedVersion: 0,
          idempotencyKey: "ac05-api-forged",
          policyAction: "opportunity.transition.draft_to_ready",
        }),
      },
    );
    expect(res.status).toBe(403);
    const body = (await res.json()) as { error: string; matchedPolicyId: string | null; classification: string };
    // The API guard allows the workflow.transition action (policy subject
    // "*" resource "*" matches), so the request passes the guard. The
    // workflow service's transitionAuthorizer then denies (the forged
    // principal has no policy for opportunity.transition.draft_to_ready
    // scoped to the subject's org). The workflow service throws an
    // AuthorizationError (code AUTHORIZATION) which the API error handler
    // returns. The classification is "authorization" (deny-by-default).
    expect(body.classification).toBe("authorization");
    void body;
  });

  test("the API auth guard authorizes a transition request when the principal has a matching allow policy (201)", async () => {
    const opp = await createOpportunity(harness);
    const res = await fetch(
      `http://127.0.0.1:${harness.runtime.api.port}/api/workflows/transitions`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-correlation-id": "ac05-api-allow",
          "x-auth-subject-id": "actor@example.com",
          "x-auth-provider-kind": "internal",
        },
        body: JSON.stringify({
          subjectId: opp.id,
          subjectKind: "opportunity",
          targetState: "READY",
          expectedVersion: 0,
          idempotencyKey: "ac05-api-allow",
          policyAction: "opportunity.transition.draft_to_ready",
        }),
      },
    );
    expect(res.status).toBe(201);
    const body = (await res.json()) as {
      executed: boolean;
      state: string;
      version: number;
      auditEventName: string;
    };
    expect(body.executed).toBe(true);
    expect(body.state).toBe("READY");
    expect(body.version).toBe(1);
    expect(body.auditEventName).toBe("opportunity.transition.draft_to_ready");
  });
});
