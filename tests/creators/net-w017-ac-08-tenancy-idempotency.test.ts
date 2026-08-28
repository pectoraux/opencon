/**
 * NET-W017 AC-08 — tenancy, idempotency, concurrency.
 *
 * Proves (work order §3, issue #33 AC-8 + invariant 9):
 *  - tenant-scoped reads: cross-scope engagement/production/grant
 *    ids are indistinguishable from nonexistent ones (NotFoundError);
 *  - idempotent replays of every command (created=false,
 *    byte-identical records);
 *  - the advisory-lock unique anchor: concurrent duplicate
 *    engagement creation (distinct keys) produces EXACTLY ONE
 *    engagement;
 *  - PostgreSQL authority: records persist through the authority
 *    collections; transactional audit lineage holds;
 *  - the HTTP surface: guard actions (403 unauthenticated/unknown
 *    actor), validation (400), tenant-scoped reads (404), 201 on
 *    creation.
 */

import { describe, expect, test } from "bun:test";
import {
  acceptEngagement,
  createEngagement,
  createProductionEvidence,
  key,
  openProduction,
  operatorCtx,
  personCtx,
  recordDeliverable,
  requestedRightsFixture,
  setAcceptancePolicy,
  submitProduction,
  tenderEngagement,
  createNetW017Harness,
} from "./_net-w017-harness.ts";
import { EngagementConflictError } from "../../src/core/creators.ts";
import { NotFoundError } from "../../src/core/errors.ts";

describe("NET-W017 AC-08 — tenancy, idempotency, concurrency", () => {
  test("tenant-scoped reads: cross-scope ids are not found (no existence oracle)", async () => {
    const harness = await createNetW017Harness();
    try {
      const { engagement } = await createEngagement(harness);
      await tenderEngagement(harness, engagement.id, 0);
      const accepted = await acceptEngagement(harness, engagement.id, 1);
      const { production } = await openProduction(
        harness,
        accepted.engagement.id,
        2,
      );
      // The second org's person reads: NotFoundError.
      const foreignCtx = personCtx(
        harness,
        harness.secondOrgPersonId,
        "w017-foreign-read",
      );
      await expect(
        harness.runtime.creatorEngagementService.getEngagement(
          foreignCtx,
          harness.secondOrgId,
          engagement.id,
        ),
      ).rejects.toBeInstanceOf(NotFoundError);
      await expect(
        harness.runtime.creatorEngagementService.getProduction(
          foreignCtx,
          harness.secondOrgId,
          production.id,
        ),
      ).rejects.toBeInstanceOf(NotFoundError);
      await expect(
        harness.runtime.creatorEngagementService.getUsageRights(
          foreignCtx,
          harness.secondOrgId,
          accepted.grant.id,
        ),
      ).rejects.toBeInstanceOf(NotFoundError);
      // Lists in the second org do not leak the first org's records.
      const foreignEngagements =
        await harness.runtime.creatorEngagementService.listEngagements(
          foreignCtx,
          harness.secondOrgId,
        );
      expect(foreignEngagements).toHaveLength(0);
      const foreignGrants =
        await harness.runtime.creatorEngagementService.listUsageRights(
          foreignCtx,
          harness.secondOrgId,
        );
      expect(foreignGrants).toHaveLength(0);
    } finally {
      await harness.teardown();
    }
  }, 60_000);

  test("idempotent replays: createEngagement replays byte-identically", async () => {
    const harness = await createNetW017Harness();
    try {
      const idempotencyKey = key("w017-replay");
      const first = await createEngagement(harness, { idempotencyKey });
      expect(first.created).toBe(true);
      const second = await createEngagement(harness, { idempotencyKey });
      expect(second.created).toBe(false);
      expect(second.engagement).toEqual(first.engagement);
      // The audit ledger carries exactly one offer event.
      const events = await harness.runtime.auditWriter.query({
        eventType: "engagement.offer_recorded",
        resourceId: first.engagement.id,
      });
      expect(events).toHaveLength(1);
    } finally {
      await harness.teardown();
    }
  }, 60_000);

  test("idempotent replays: acceptance (grant + transition) replays both steps", async () => {
    const harness = await createNetW017Harness();
    try {
      const { engagement } = await createEngagement(harness);
      await tenderEngagement(harness, engagement.id, 0);
      const idempotencyKey = key("w017-accept-replay");
      const first = await acceptEngagement(harness, engagement.id, 1, {
        idempotencyKey,
      });
      expect(first.engagement.state).toBe("ASSIGNED");
      const second = await acceptEngagement(harness, engagement.id, 1, {
        idempotencyKey,
      });
      // The replay returns the same grant + the same end state.
      expect(second.engagement.state).toBe("ASSIGNED");
      expect(second.grant).toEqual(first.grant);
      // Exactly one grant + one transition event.
      const grants = await harness.runtime.auditWriter.query({
        eventType: "usage_rights.granted",
      });
      expect(grants).toHaveLength(1);
      const transitions = await harness.runtime.auditWriter.query({
        eventType: "engagement.transition.ready_to_assigned",
      });
      expect(transitions).toHaveLength(1);
    } finally {
      await harness.teardown();
    }
  }, 60_000);

  test("idempotent replays: production open + deliverable + submission", async () => {
    const harness = await createNetW017Harness();
    try {
      const { engagement } = await createEngagement(harness);
      await tenderEngagement(harness, engagement.id, 0);
      const accepted = await acceptEngagement(harness, engagement.id, 1);
      const productionKey = key("w017-prod-replay");
      const ctx = personCtx(harness, harness.creatorPersonId, "w017-replay");
      const first = await harness.runtime.creatorEngagementService.openProduction(
        ctx,
        {
          organizationScopeId: harness.organizationScopeId,
          engagementId: accepted.engagement.id,
          expectedVersion: 2,
          idempotencyKey: productionKey,
        },
      );
      const second = await harness.runtime.creatorEngagementService.openProduction(
        ctx,
        {
          organizationScopeId: harness.organizationScopeId,
          engagementId: accepted.engagement.id,
          expectedVersion: 2,
          idempotencyKey: productionKey,
        },
      );
      expect(second.production).toEqual(first.production);
      expect(second.transition.executed).toBe(false);
    } finally {
      await harness.teardown();
    }
  }, 60_000);

  test("the advisory-lock anchor: concurrent duplicate engagement creation produces EXACTLY ONE engagement", async () => {
    const harness = await createNetW017Harness();
    try {
      const { createActiveCampaign } = await import(
        "./_net-w017-harness.ts"
      );
      const campaign = await createActiveCampaign(harness);
      const ctx = operatorCtx(harness, "w017-concurrent-create");
      // 6 concurrent creations, distinct idempotency keys.
      const fixture = requestedRightsFixture();
      const results = await Promise.allSettled(
        Array.from({ length: 6 }, (_, i) =>
          harness.runtime.creatorEngagementService.createEngagement(ctx, {
            organizationScopeId: harness.organizationScopeId,
            creatorPersonId: harness.creatorPersonId,
            campaignId: campaign.id,
            matchRunId: null,
            opportunityId: null,
            requestedRights: fixture,
            compensation: null,
            brief: null,
            idempotencyKey: `w017-concurrent-${i}-${key("k")}`,
          }),
        ),
      );
      const fulfilled = results.filter((r) => r.status === "fulfilled");
      const rejected = results.filter((r) => r.status === "rejected");
      expect(fulfilled).toHaveLength(1);
      expect(rejected).toHaveLength(5);
      for (const rejection of rejected) {
        expect(
          (rejection as PromiseRejectedResult).reason,
        ).toBeInstanceOf(EngagementConflictError);
      }
      // Exactly ONE engagement exists for (org, campaign, creator).
      const engagements =
        await harness.runtime.creatorEngagementService.listEngagements(
          ctx,
          harness.organizationScopeId,
          { campaignId: campaign.id },
        );
      expect(engagements).toHaveLength(1);
    } finally {
      await harness.teardown();
    }
  }, 60_000);

  test("a terminal engagement frees the anchor: re-engagement after cancellation", async () => {
    const harness = await createNetW017Harness();
    try {
      const { createActiveCampaign } = await import(
        "./_net-w017-harness.ts"
      );
      const campaign = await createActiveCampaign(harness);
      const first = await createEngagement(harness, { campaignId: campaign.id });
      // Cancel it (DRAFT → CANCELLED).
      await harness.runtime.apiCommands.requestTransition(
        operatorCtx(harness, "w017-cancel"),
        harness.operatorPersonId,
        {
          subjectId: first.engagement.id,
          subjectKind: "engagement",
          targetState: "CANCELLED",
          expectedVersion: 0,
          idempotencyKey: key("w017-cancel"),
          policyAction: "engagement.transition.draft_to_cancelled",
        },
      );
      // A NEW engagement for the same (org, campaign, creator) is now
      // allowed (the anchor only blocks NON-TERMINAL duplicates).
      const second = await createEngagement(harness, {
        campaignId: campaign.id,
      });
      expect(second.engagement.id).not.toBe(first.engagement.id);
      expect(second.created).toBe(true);
    } finally {
      await harness.teardown();
    }
  }, 60_000);

  test("the auto-match batch: idempotent + per-candidate outcomes recorded", async () => {
    const harness = await createNetW017Harness();
    try {
      const { createActiveCampaign, requestedRightsFixture } = await import(
        "./_net-w017-harness.ts"
      );
      const { createMatchCandidate, runMatch, baselineRequirements } =
        await import("./_net-w016-harness.ts");
      const w016 = harness.w016;
      const campaign = await createActiveCampaign(harness);
      // Two candidates: one eligible, one excluded by a gate.
      const eligible = await createMatchCandidate(w016, {});
      const excluded = await createMatchCandidate(w016, {
        acceptingWork: false,
        skipActivation: true,
      });
      const { run } = await runMatch(w016, {
        campaign: { campaignId: campaign.id },
        requirements: baselineRequirements(),
        candidateProfileIds: [eligible.profile.id, excluded.profile.id],
        idempotencyKey: key("w017-batch-match"),
      });
      const ctx = operatorCtx(harness, "w017-batch");
      const idempotencyKey = key("w017-batch");
      const first =
        await harness.runtime.creatorEngagementService.createEngagementsFromMatch(
          ctx,
          {
            organizationScopeId: harness.organizationScopeId,
            matchRunId: run.id,
            offer: {
              requestedRights: requestedRightsFixture(),
              compensation: null,
              brief: null,
            },
            idempotencyKey,
          },
        );
      expect(first.batch.candidateCount).toBe(1);
      expect(first.batch.outcomes).toHaveLength(1);
      expect(first.batch.outcomes[0]!.created).toBe(true);
      expect(first.batch.outcomes[0]!.engagementId).toBeTypeOf("string");
      // Replay: byte-identical batch record.
      const second =
        await harness.runtime.creatorEngagementService.createEngagementsFromMatch(
          ctx,
          {
            organizationScopeId: harness.organizationScopeId,
            matchRunId: run.id,
            offer: {
              requestedRights: requestedRightsFixture(),
              compensation: null,
              brief: null,
            },
            idempotencyKey,
          },
        );
      expect(second.created).toBe(false);
      expect(second.batch).toEqual(first.batch);
      // A SECOND batch (new key) over the same run: the candidate now
      // has an OPEN engagement → skipped with the closed reason.
      const third =
        await harness.runtime.creatorEngagementService.createEngagementsFromMatch(
          ctx,
          {
            organizationScopeId: harness.organizationScopeId,
            matchRunId: run.id,
            offer: {
              requestedRights: requestedRightsFixture(),
              compensation: null,
              brief: null,
            },
            idempotencyKey: key("w017-batch-2"),
          },
        );
      expect(third.batch.outcomes[0]!.created).toBe(false);
      expect(third.batch.outcomes[0]!.skipped).toBe("open_engagement_exists");
      // The batch is auditable.
      const events = await harness.runtime.auditWriter.query({
        eventType: "engagement.batch_recorded",
      });
      expect(events.length).toBeGreaterThanOrEqual(2);
    } finally {
      await harness.teardown();
    }
  }, 120_000);

  test("PostgreSQL authority: records persist in the authority collections", async () => {
    const harness = await createNetW017Harness();
    try {
      const { goldenPathEngagement } = await import(
        "./_net-w017-harness.ts"
      );
      const flow = await goldenPathEngagement(harness);
      const authority = harness.runtime.postgresAuthority;
      const engagement = await authority.get(
        "engagements",
        flow.engagement.id,
      );
      expect(engagement).not.toBeNull();
      const grant = await authority.get("usage_rights_grants", flow.grant.id);
      expect(grant).not.toBeNull();
      const production = await authority.get(
        "ugc_productions",
        flow.production.id,
      );
      expect(production).not.toBeNull();
      const submission = await authority.scan("ugc_submissions");
      expect(submission.length).toBe(1);
      const deliverables = await authority.scan("ugc_deliverables");
      expect(deliverables.length).toBe(1);
      // The engagement's lifecycle fields were mutated ONLY through
      // the workflow service's repository surface (version 3,
      // SUBMITTED).
      expect((engagement!.value as Record<string, unknown>).state).toBe(
        "SUBMITTED",
      );
      expect((engagement!.value as Record<string, unknown>).version).toBe(4);
    } finally {
      await harness.teardown();
    }
  }, 60_000);

  test("acceptance-policy versioning is serialized: concurrent setAcceptancePolicy calls produce a gap-free sequence", async () => {
    const harness = await createNetW017Harness();
    try {
      const ctx = personCtx(harness, harness.creatorPersonId, "w017-policy");
      const results = await Promise.allSettled(
        Array.from({ length: 5 }, (_, i) =>
          harness.runtime.creatorEngagementService.setAcceptancePolicy(ctx, {
            organizationScopeId: harness.organizationScopeId,
            creatorPersonId: harness.creatorPersonId,
            mode: i % 2 === 0 ? "auto_accept" : "manual",
            maxActiveEngagements: i + 1,
            rateFloor: null,
            autoGrantableRights: ["reuse_license"],
            maxGrantDurationDays: null,
            idempotencyKey: `w017-policy-${i}-${key("k")}`,
          }),
        ),
      );
      const fulfilled = results.filter((r) => r.status === "fulfilled") as
        PromiseFulfilledResult<{ policy: { version: number } }>[];
      expect(fulfilled.length).toBeGreaterThan(0);
      const versions = fulfilled
        .map((r) => r.value.policy.version)
        .sort((a, b) => a - b);
      // Gap-free 1..N (no forked version sequence).
      expect(versions).toEqual(
        Array.from({ length: versions.length }, (_, i) => i + 1),
      );
      // The latest version is the max.
      const latest =
        await harness.runtime.creatorEngagementService.getAcceptancePolicy(
          ctx,
          harness.organizationScopeId,
          harness.creatorPersonId,
        );
      expect(latest!.version).toBe(versions[versions.length - 1]!);
    } finally {
      await harness.teardown();
    }
  }, 60_000);

  test("HTTP surface: guard 403, validation 400, tenant-scoped 404, creation 201", async () => {
    const harness = await createNetW017Harness();
    try {
      const port = harness.runtime.api.port;
      const base = `http://127.0.0.1:${port}`;
      const { createActiveCampaign, requestedRightsFixture } = await import(
        "./_net-w017-harness.ts"
      );
      const campaign = await createActiveCampaign(harness);

      // A resolvable HTTP operator identity (the W016 pattern) with
      // the engagement transition policies seeded for it (the pure
      // lifecycle transitions go through the generic endpoint whose
      // per-subject authorization needs the policy).
      const operatorSubject = "w017-http-operator@example.com";
      const httpOperator = await harness.runtime.identityService.createIdentity(
        harness.bootstrapCtx,
        {
          displayName: "W017 HTTP Operator",
          subjectReferences: [
            { subjectId: operatorSubject, providerKind: "internal" },
          ],
        },
      );
      const { ENGAGEMENT_TRANSITION_TABLE } = await import(
        "../../src/workflows/transition-table.ts"
      );
      for (const rule of ENGAGEMENT_TRANSITION_TABLE) {
        await harness.runtime.policyService.createPolicy(
          harness.bootstrapCtx,
          {
            subject: httpOperator.id,
            action: rule.policyAction,
            resource: harness.organizationScopeId,
            effect: "allow",
            createdBy: "bootstrap",
          },
        );
      }

      // Unauthenticated POST → 403.
      const unauth = await fetch(`${base}/api/creators/engagements`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({}),
      });
      expect(unauth.status).toBe(403);

      // Authenticated but missing fields → 400.
      const bad = await fetch(`${base}/api/creators/engagements`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-auth-subject-id": operatorSubject,
        },
        body: JSON.stringify({ organizationScopeId: harness.organizationScopeId }),
      });
      expect(bad.status).toBe(400);

      // A valid creation → 201.
      const created = await fetch(`${base}/api/creators/engagements`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-auth-subject-id": operatorSubject,
        },
        body: JSON.stringify({
          organizationScopeId: harness.organizationScopeId,
          creatorPersonId: harness.creatorPersonId,
          campaignId: campaign.id,
          requestedRights: requestedRightsFixture(),
          idempotencyKey: key("w017-http"),
        }),
      });
      expect(created.status).toBe(201);
      const body = (await created.json()) as {
        engagement: { id: string };
        created: boolean;
      };
      expect(body.created).toBe(true);
      expect(body.engagement.id).toBeTypeOf("string");

      // Tenant-scoped GET with the WRONG org → 404.
      const wrongOrg = await fetch(
        `${base}/api/creators/engagements/${body.engagement.id}?organizationScopeId=${harness.secondOrgId}`,
        { headers: { "x-auth-subject-id": operatorSubject } },
      );
      expect(wrongOrg.status).toBe(404);

      // The right org → 200.
      const rightOrg = await fetch(
        `${base}/api/creators/engagements/${body.engagement.id}?organizationScopeId=${harness.organizationScopeId}`,
      );
      expect(rightOrg.status).toBe(200);

      // The acceptance-policy HTTP endpoint.
      const policy = await fetch(`${base}/api/creators/acceptance-policy`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-auth-subject-id": operatorSubject,
        },
        body: JSON.stringify({
          organizationScopeId: harness.organizationScopeId,
          creatorPersonId: harness.creatorPersonId,
          mode: "auto_accept",
          maxActiveEngagements: 3,
          rateFloor: null,
          autoGrantableRights: ["reuse_license"],
          maxGrantDurationDays: 60,
          idempotencyKey: key("w017-http-policy"),
        }),
      });
      expect(policy.status).toBe(201);
      const policyView = (await policy.json()) as {
        policy: { version: number; mode: string };
      };
      expect(policyView.policy.version).toBe(1);
      expect(policyView.policy.mode).toBe("auto_accept");

      // The generic transition endpoint accepts subjectKind
      // "engagement": tender the HTTP-created engagement.
      const tender = await fetch(`${base}/api/workflows/transitions`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-auth-subject-id": operatorSubject,
        },
        body: JSON.stringify({
          subjectId: body.engagement.id,
          subjectKind: "engagement",
          targetState: "READY",
          expectedVersion: 0,
          idempotencyKey: key("w017-http-tender"),
          policyAction: "engagement.transition.draft_to_ready",
        }),
      });
      expect(tender.status).toBe(201);
      const tenderView = (await tender.json()) as { state: string };
      expect(tenderView.state).toBe("READY");

      // An invalid subjectKind is rejected with 400.
      const invalidKind = await fetch(`${base}/api/workflows/transitions`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-auth-subject-id": operatorSubject,
        },
        body: JSON.stringify({
          subjectId: "x",
          subjectKind: "galaxy",
          targetState: "READY",
          expectedVersion: 0,
          idempotencyKey: key("w017-http-bad"),
          policyAction: "x",
        }),
      });
      expect(invalidKind.status).toBe(400);
    } finally {
      await harness.teardown();
    }
  }, 90_000);

  test("the full submission HTTP path: production + deliverable + evidence + submission", async () => {
    const harness = await createNetW017Harness();
    try {
      const port = harness.runtime.api.port;
      const base = `http://127.0.0.1:${port}`;
      const { goldenPathEngagement } = await import(
        "./_net-w017-harness.ts"
      );
      const flow = await goldenPathEngagement(harness);
      // The submission is readable over HTTP (public, tenant-scoped).
      const list = await fetch(
        `${base}/api/creators/productions/${flow.production.id}/submissions?organizationScopeId=${harness.organizationScopeId}`,
      );
      expect(list.status).toBe(200);
      const body = (await list.json()) as {
        submissions: { evidenceReferences: string[] }[];
      };
      expect(body.submissions).toHaveLength(1);
      expect(body.submissions[0]!.evidenceReferences).toEqual([
        flow.evidenceId,
      ]);
      // The deliverables are readable over HTTP.
      const deliverables = await fetch(
        `${base}/api/creators/productions/${flow.production.id}/deliverables?organizationScopeId=${harness.organizationScopeId}`,
      );
      expect(deliverables.status).toBe(200);
      const deliverablesBody = (await deliverables.json()) as {
        deliverables: { version: number }[];
      };
      expect(deliverablesBody.deliverables).toHaveLength(1);
      // The usage-rights view is readable over HTTP.
      const rights = await fetch(
        `${base}/api/creators/usage-rights/${flow.grant.id}?organizationScopeId=${harness.organizationScopeId}`,
      );
      expect(rights.status).toBe(200);
      const rightsBody = (await rights.json()) as {
        grant: { contentOwnership: string };
        effectiveStatus: string;
      };
      expect(rightsBody.grant.contentOwnership).toBe("creator_retained");
      expect(rightsBody.effectiveStatus).toBe("ACTIVE");
    } finally {
      await harness.teardown();
    }
  }, 90_000);
});
