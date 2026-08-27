/**
 * NET-W016-AC-05 — tenancy, idempotency, persistence, audit lineage
 * (work order §3.4/§3.5; issue #31 invariant 8).
 *
 * Every read is tenant-scoped (a cross-scope run id, campaign or
 * candidate profile is indistinguishable from a nonexistent one —
 * NotFoundError, no existence oracle); the default enumeration
 * covers ONLY the caller's organization scope; runs are durable,
 * idempotent (byte-identical replays) and carry transactional audit
 * lineage; the HTTP surface enforces the same boundaries
 * (unauthenticated 403; 400 missing scope; 404 cross-scope; 200
 * same-scope).
 */

import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import {
  baselineRequirements,
  createCampaignWithRules,
  createMatchCandidate,
  createNetW016Harness,
  key,
  matchCtx,
  runMatch,
  type NetW016Harness,
} from "./_net-w016-harness.ts";

let harness: NetW016Harness;

beforeAll(async () => {
  harness = await createNetW016Harness();
});

afterAll(async () => {
  await harness.teardown();
});

describe("NET-W016-AC-05 tenancy/idempotency/persistence/audit", () => {
  test("run reads are tenant-scoped: cross-scope and nonexistent ids are NotFoundError (no existence oracle)", async () => {
    const candidate = await createMatchCandidate(harness);
    const { run } = await runMatch(harness, {
      requirements: baselineRequirements(),
      candidateProfileIds: [candidate.profile.id],
      idempotencyKey: key("w016-ac05-scope"),
    });
    // Same scope resolves.
    const same = await harness.runtime.creatorMatchingService.getMatchRun(
      matchCtx(harness, harness.operatorPersonId, "w016-read"),
      harness.organizationScopeId,
      run.id,
    );
    expect(same.id).toBe(run.id);
    // Cross-scope is indistinguishable from nonexistent.
    await expect(
      harness.runtime.creatorMatchingService.getMatchRun(
        matchCtx(harness, harness.operatorPersonId, "w016-read-x"),
        harness.secondOrgId,
        run.id,
      ),
    ).rejects.toThrow(/creator match run not found/);
    await expect(
      harness.runtime.creatorMatchingService.getMatchRun(
        matchCtx(harness, harness.operatorPersonId, "w016-read-n"),
        harness.organizationScopeId,
        "no-such-run",
      ),
    ).rejects.toThrow(/creator match run not found/);
  });

  test("a campaign from ANOTHER organization scope is refused (indistinguishable from nonexistent)", async () => {
    const secondOrgCampaign = await createCampaignWithRules(harness, {
      organizationScopeId: harness.secondOrgId,
      ownerPersonId: harness.secondOrgPersonId,
    });
    await expect(
      runMatch(harness, {
        campaign: { campaignId: secondOrgCampaign.campaign.id },
        requirements: baselineRequirements(),
        idempotencyKey: key("w016-ac05-campaign-x"),
      }),
    ).rejects.toThrow(/campaign not found/);
    await expect(
      runMatch(harness, {
        campaign: { campaignId: "no-such-campaign" },
        requirements: baselineRequirements(),
        idempotencyKey: key("w016-ac05-campaign-n"),
      }),
    ).rejects.toThrow(/campaign not found/);
  });

  test("a candidate profile from ANOTHER organization scope is refused", async () => {
    // A profile anchored in the second org by a FRESH person (the
    // unique-anchor rule forbids a second profile for a person who
    // already holds one there).
    const secondOrgPerson = await harness.runtime.identityService.createIdentity(
      harness.bootstrapCtx,
      {
        displayName: "W016 Second Org Candidate",
        subjectReferences: [
          {
            subjectId: `w016-second-candidate-${key("s")}@example.com`,
            providerKind: "internal",
          },
        ],
      },
    );
    const secondCtx = matchCtx(
      harness,
      secondOrgPerson.id,
      "w016-second-org-profile",
    );
    const secondProfile =
      await harness.runtime.creatorService.createProfile(secondCtx, {
        organizationScopeId: harness.secondOrgId,
        creatorPersonId: secondOrgPerson.id,
        displayName: "Second Org Creator",
        idempotencyKey: key("w016-second-org-profile"),
      });
    await expect(
      runMatch(harness, {
        requirements: baselineRequirements(),
        candidateProfileIds: [secondProfile.profile.id],
        idempotencyKey: key("w016-ac05-candidate-x"),
      }),
    ).rejects.toThrow(/creator profile not found/);
  });

  test("the default enumeration covers ONLY the caller's organization scope", async () => {
    const local = await createMatchCandidate(harness);
    // A FRESH person anchored in the second org (the unique-anchor
    // rule gives each person at most one profile per org scope).
    const secondOrgPerson = await harness.runtime.identityService.createIdentity(
      harness.bootstrapCtx,
      {
        displayName: "W016 Second Org Default",
        subjectReferences: [
          {
            subjectId: `w016-second-default-${key("s")}@example.com`,
            providerKind: "internal",
          },
        ],
      },
    );
    const secondCtx = matchCtx(
      harness,
      secondOrgPerson.id,
      "w016-second-org-default",
    );
    await harness.runtime.creatorService.createProfile(secondCtx, {
      organizationScopeId: harness.secondOrgId,
      creatorPersonId: secondOrgPerson.id,
      displayName: "Second Org Creator",
      idempotencyKey: key("w016-second-org-default"),
    });
    const { run } = await runMatch(harness, {
      requirements: baselineRequirements(),
      idempotencyKey: key("w016-ac05-default"),
    });
    const seen = [
      ...run.results.map((r) => r.profileId),
      ...run.excluded.map((e) => e.profileId),
    ];
    expect(seen).toContain(local.profile.id);
    for (const id of seen) {
      // Every evaluated candidate belongs to the caller's scope (the
      // second-org anchor profile must never appear).
      const profile = await harness.runtime.creatorService.getProfile(
        matchCtx(harness, harness.operatorPersonId, "w016-verify-scope"),
        harness.organizationScopeId,
        id,
      );
      expect(profile.organizationScopeId).toBe(harness.organizationScopeId);
    }
  });

  test("runs persist and list (optionally narrowed by campaign); the campaign pin is traceable", async () => {
    const { campaign } = await createCampaignWithRules(harness);
    const a = await createMatchCandidate(harness);
    const b = await createMatchCandidate(harness);
    const withCampaign = await runMatch(harness, {
      campaign: { campaignId: campaign.id, policyVersion: 1 },
      requirements: baselineRequirements(),
      candidateProfileIds: [a.profile.id],
      idempotencyKey: key("w016-ac05-list-a"),
    });
    const without = await runMatch(harness, {
      requirements: baselineRequirements(),
      candidateProfileIds: [b.profile.id],
      idempotencyKey: key("w016-ac05-list-b"),
    });
    expect(withCampaign.run.campaign).toEqual({
      campaignId: campaign.id,
      policyVersion: 1,
    });
    expect(without.run.campaign).toBeNull();

    const all = await harness.runtime.creatorMatchingService.listMatchRuns(
      matchCtx(harness, harness.operatorPersonId, "w016-list"),
      harness.organizationScopeId,
    );
    const ids = all.map((r) => r.id);
    expect(ids).toContain(withCampaign.run.id);
    expect(ids).toContain(without.run.id);

    const narrowed =
      await harness.runtime.creatorMatchingService.listMatchRuns(
        matchCtx(harness, harness.operatorPersonId, "w016-list-c"),
        harness.organizationScopeId,
        campaign.id,
      );
    expect(narrowed.map((r) => r.id)).toEqual([withCampaign.run.id]);

    // Cross-scope listing sees nothing.
    const foreign = await harness.runtime.creatorMatchingService.listMatchRuns(
      matchCtx(harness, harness.secondOrgPersonId, "w016-list-x"),
      harness.secondOrgId,
    );
    expect(foreign.map((r) => r.id)).not.toContain(withCampaign.run.id);
  });

  test("audit + execution lineage: the run carries the execution identity and the audit event references the run", async () => {
    const candidate = await createMatchCandidate(harness);
    const ctx = matchCtx(harness, harness.operatorPersonId, "w016-lineage");
    const { run } = await harness.runtime.creatorMatchingService.runMatch(
      ctx,
      {
        organizationScopeId: harness.organizationScopeId,
        requirements: baselineRequirements(),
        candidateProfileIds: [candidate.profile.id],
        idempotencyKey: key("w016-ac05-lineage"),
      },
    );
    expect(run.executionId).toBe(ctx.executionId);
    expect(run.correlationId).toBe(ctx.correlationId);
    expect(run.createdBy).toBe(harness.operatorPersonId);

    const events = await harness.runtime.auditWriter.query({
      eventType: "creator_match.recorded",
      limit: 1000,
    });
    const event = events.find((e) => e.resourceId === run.id);
    expect(event).toBeDefined();
    expect(event!.executionId).toBe(ctx.executionId);
    expect(event!.correlationId).toBe(ctx.correlationId);
    expect(event!.actor).toBe(harness.operatorPersonId);
  });

  test("HTTP: POST /api/creators/matching is guarded (403 unauthenticated) and runs (201; replay 200 created=false)", async () => {
    const base = `http://127.0.0.1:${harness.runtime.api.port}`;
    const candidate = await createMatchCandidate(harness);
    const idempotencyKey = key("w016-ac05-http");
    const body = {
      organizationScopeId: harness.organizationScopeId,
      requirements: baselineRequirements(),
      candidateProfileIds: [candidate.profile.id],
      idempotencyKey,
    };
    // Unauthenticated: the guard refuses (403).
    const unauthenticated = await fetch(`${base}/api/creators/matching`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    expect(unauthenticated.status).toBe(403);

    // Authenticated operator: 201 + the run view.
    const operatorSubject = "w016-http-operator@example.com";
    await harness.runtime.identityService.createIdentity(
      harness.bootstrapCtx,
      {
        displayName: "W016 HTTP Operator",
        subjectReferences: [
          { subjectId: operatorSubject, providerKind: "internal" },
        ],
      },
    );
    const created = await fetch(`${base}/api/creators/matching`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-auth-subject-id": operatorSubject,
      },
      body: JSON.stringify(body),
    });
    expect(created.status).toBe(201);
    const createdBody = (await created.json()) as {
      created: boolean;
      run: { id: string; eligibleCount: number; digest: string };
    };
    expect(createdBody.created).toBe(true);
    expect(createdBody.run.eligibleCount).toBe(1);

    // Idempotent replay over HTTP: the codebase POST convention
    // (201 + the created flag distinguishing replays).
    const replay = await fetch(`${base}/api/creators/matching`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-auth-subject-id": operatorSubject,
      },
      body: JSON.stringify(body),
    });
    expect(replay.status).toBe(201);
    const replayBody = (await replay.json()) as {
      created: boolean;
      run: { id: string; digest: string };
    };
    expect(replayBody.created).toBe(false);
    expect(replayBody.run.id).toBe(createdBody.run.id);
    expect(replayBody.run.digest).toBe(createdBody.run.digest);

    // GET list (same scope).
    const list = await fetch(
      `${base}/api/creators/matching?organizationScopeId=${encodeURIComponent(
        harness.organizationScopeId,
      )}`,
    );
    expect(list.status).toBe(200);
    const listBody = (await list.json()) as {
      runs: { id: string }[];
    };
    expect(listBody.runs.map((r) => r.id)).toContain(createdBody.run.id);

    // GET by id: 400 missing scope; 404 cross-scope; 200 same-scope.
    const missingScope = await fetch(
      `${base}/api/creators/matching/${createdBody.run.id}`,
    );
    expect(missingScope.status).toBe(400);
    const wrongScope = await fetch(
      `${base}/api/creators/matching/${createdBody.run.id}?organizationScopeId=${encodeURIComponent(
        harness.secondOrgId,
      )}`,
    );
    expect(wrongScope.status).toBe(404);
    const ok = await fetch(
      `${base}/api/creators/matching/${createdBody.run.id}?organizationScopeId=${encodeURIComponent(
        harness.organizationScopeId,
      )}`,
    );
    expect(ok.status).toBe(200);
    const okBody = (await ok.json()) as { id: string; digest: string };
    expect(okBody.id).toBe(createdBody.run.id);
    expect(okBody.digest).toBe(createdBody.run.digest);
  });

  test("requirement validation rejects malformed inputs (closed vocabularies, bounded arrays)", async () => {
    const candidate = await createMatchCandidate(harness);
    await expect(
      runMatch(harness, {
        requirements: {
          ...baselineRequirements(),
          requiredFormats: ["hologram"] as never,
        },
        candidateProfileIds: [candidate.profile.id],
        idempotencyKey: key("w016-ac05-bad-format"),
      }),
    ).rejects.toThrow(/creator content formats/);
    await expect(
      runMatch(harness, {
        requirements: {
          ...baselineRequirements(),
          targetTerritories: ["GHA"],
        },
        candidateProfileIds: [candidate.profile.id],
        idempotencyKey: key("w016-ac05-bad-territory"),
      }),
    ).rejects.toThrow(/ISO 3166-1 alpha-2/);
    await expect(
      runMatch(harness, {
        requirements: {
          ...baselineRequirements(),
          noticeWindowDays: 400,
        },
        candidateProfileIds: [candidate.profile.id],
        idempotencyKey: key("w016-ac05-bad-notice"),
      }),
    ).rejects.toThrow(/integer between 0 and 365/);
    // Credential-shaped keys cannot enter the requirements input.
    await expect(
      runMatch(harness, {
        requirements: {
          ...baselineRequirements(),
          apiToken: "x",
        } as never,
        candidateProfileIds: [candidate.profile.id],
        idempotencyKey: key("w016-ac05-cred"),
      }),
    ).rejects.toThrow(/credential-shaped field/);
  });
});
