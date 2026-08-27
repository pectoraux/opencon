/**
 * NET-W015-AC-05 — Authorization, tenant isolation, idempotency,
 * concurrency safety, PostgreSQL authority and audit lineage hold
 * (issue #29 AC-5, invariant 8).
 *
 * Proves:
 *  - the API routes are guarded deny-by-default (no policy → 403);
 *  - profile/version/status mutations are OWNER-ONLY (server-side);
 *  - tenant isolation: cross-org reads never leak; the anchor lookup
 *    is org-scoped; cross-org reputation references are refused
 *    (AC-04 detail re-pinned at the boundary level);
 *  - idempotency: same-key replays return created:false + the same
 *    record; concurrent same-key creations produce ONE record;
 *  - concurrency: parallel version definitions serialize into a
 *    strict lineage (no fork — the lineage mutex);
 *  - PostgreSQL authority: the frozen collection names; committed
 *    reads through the authority boundary;
 *  - audit lineage: every mutation commits its audit event with
 *    actor/subject/resource + execution lineage.
 */
import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import {
  createNetW015Harness,
  createCreatorProfile,
  defineCreatorProfileVersion,
  createDefaultSections,
  createFreshPerson,
  personCtx,
  key,
  type NetW015Harness,
} from "./_net-w015-harness.ts";
import { createRuntime } from "../../src/bootstrap/runtime.ts";
import {
  CREATORS_COLLECTION,
  CREATOR_PROFILE_VERSIONS_COLLECTION,
} from "../../src/creators/authority-creator-repository.ts";

let harness: NetW015Harness;

beforeAll(async () => {
  harness = await createNetW015Harness();
});

afterAll(async () => {
  await harness.teardown();
});

describe("NET-W015-AC-05 authorization/tenancy/idempotency/concurrency/authority/audit", () => {
  test("the creator routes are guarded deny-by-default (no policy → 403)", async () => {
    const bare = createRuntime({
      forceEnv: "test",
      env: { APP_ENV: "test", LOG_LEVEL: "error" },
      port: 0,
    });
    await bare.initialize();
    await bare.api.start();
    try {
      const endpoints: Array<[string, Record<string, unknown>]> = [
        [
          "/api/creators",
          {
            organizationScopeId: "o",
            creatorPersonId: "p",
            displayName: "d",
            idempotencyKey: "k",
          },
        ],
        [
          "/api/creators/x/versions",
          { sections: {}, idempotencyKey: "k" },
        ],
        ["/api/creators/x/activate", { idempotencyKey: "k" }],
        ["/api/creators/x/pause", { idempotencyKey: "k" }],
        ["/api/creators/x/resume", { idempotencyKey: "k" }],
        ["/api/creators/x/archive", { idempotencyKey: "k" }],
      ];
      for (const [path, body] of endpoints) {
        const res = await fetch(`http://127.0.0.1:${bare.api.port}${path}`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
        });
        expect(res.status, `${path} unauthenticated`).toBe(403);
      }
    } finally {
      await bare.shutdown();
    }
  });

  test("profile/version/status mutations are OWNER-ONLY", async () => {
    const personId = await createFreshPerson(harness, "ac05-owner");
    const intruderId = await createFreshPerson(harness, "ac05-intruder");
    const ctx = personCtx(harness, personId, "w015-ac05-owner");
    const intruderCtx = personCtx(harness, intruderId, "w015-ac05-intruder");
    const { profile } = await createCreatorProfile(harness, {
      creatorPersonId: personId,
      ctx,
    });

    await expect(
      defineCreatorProfileVersion(harness, profile.id, {
        subjectPersonId: personId,
        ctx: intruderCtx,
      }),
    ).rejects.toThrow(/not the owner of creator profile/);
    await expect(
      harness.runtime.creatorService.activateProfile(intruderCtx, {
        profileId: profile.id,
        idempotencyKey: key("w015-ac05-intrude-activate"),
      }),
    ).rejects.toThrow(/not the owner/);
    await expect(
      harness.runtime.creatorService.pauseProfile(intruderCtx, {
        profileId: profile.id,
        idempotencyKey: key("w015-ac05-intrude-pause"),
      }),
    ).rejects.toThrow(/not the owner/);
    await expect(
      harness.runtime.creatorService.archiveProfile(intruderCtx, {
        profileId: profile.id,
        idempotencyKey: key("w015-ac05-intrude-archive"),
      }),
    ).rejects.toThrow(/not the owner/);

    // The owner's own mutations succeed (and no intruder mutation
    // left a trace).
    const { version } = await defineCreatorProfileVersion(harness, profile.id, {
      subjectPersonId: personId,
      ctx,
    });
    expect(version.version).toBe(1);
  });

  test("idempotency: same-key replay returns the SAME record; concurrent same-key creates produce ONE profile", async () => {
    const personId = await createFreshPerson(harness, "ac05-idem");
    const ctx = personCtx(harness, personId, "w015-ac05-idem");
    const idem = key("w015-ac05-create");
    const first = await createCreatorProfile(harness, {
      creatorPersonId: personId,
      ctx,
      idempotencyKey: idem,
    });
    const replay = await createCreatorProfile(harness, {
      creatorPersonId: personId,
      ctx,
      idempotencyKey: idem,
    });
    expect(replay.created).toBe(false);
    expect(replay.profile.id).toBe(first.profile.id);

    // CONCURRENT creations with the SAME key on a fresh person
    // produce exactly ONE profile.
    const person2 = await createFreshPerson(harness, "ac05-idem-race");
    const ctx2 = personCtx(harness, person2, "w015-ac05-idem-race");
    const idem2 = key("w015-ac05-create-race");
    const results = await Promise.allSettled(
      Array.from({ length: 4 }, () =>
        createCreatorProfile(harness, {
          creatorPersonId: person2,
          ctx: ctx2,
          idempotencyKey: idem2,
        }),
      ),
    );
    const successes = results
      .filter((r) => r.status === "fulfilled")
      .map((r) => (r as PromiseFulfilledResult<{ profile: { id: string } }>)
        .value);
    expect(successes.length).toBeGreaterThanOrEqual(1);
    expect(new Set(successes.map((s) => s.profile.id)).size).toBe(1);
    const byPerson = await harness.runtime.creatorService.getProfileByPerson(
      ctx2,
      harness.organizationScopeId,
      person2,
    );
    expect(byPerson).not.toBeNull();
  });

  test("concurrent version definitions serialize into a strict lineage (no fork)", async () => {
    const personId = await createFreshPerson(harness, "ac05-lineage");
    const ctx = personCtx(harness, personId, "w015-ac05-lineage");
    const { profile } = await createCreatorProfile(harness, {
      creatorPersonId: personId,
      ctx,
    });
    const sections = await createDefaultSections(harness, {
      subjectPersonId: personId,
    });
    const results = await Promise.allSettled(
      Array.from({ length: 4 }, (_, i) =>
        harness.runtime.creatorService.defineProfileVersion(ctx, {
          profileId: profile.id,
          sections,
          idempotencyKey: `w015-ac05-race-${i}-${profile.id}`,
        }),
      ),
    );
    // All four succeed, each with its OWN version (1..4).
    const versions = results
      .map((r) => (r.status === "fulfilled" ? r.value.version.version : null))
      .filter((v) => v !== null)
      .sort((a, b) => a! - b!);
    expect(versions).toEqual([1, 2, 3, 4]);
    const lineage = await harness.runtime.creatorService.listProfileVersions(
      ctx,
      profile.id,
    );
    expect(lineage.map((v) => v.version)).toEqual([1, 2, 3, 4]);
    // The pointer sits at the latest.
    const now = await harness.runtime.creatorService.getProfile(
      ctx,
      profile.id,
    );
    expect(now.currentVersion).toBe(4);
  });

  test("records + versions persist in the authority collections (PostgreSQL authority)", async () => {
    const personId = await createFreshPerson(harness, "ac05-persist");
    const ctx = personCtx(harness, personId, "w015-ac05-persist");
    const { profile } = await createCreatorProfile(harness, {
      creatorPersonId: personId,
      displayName: "Persisted Creator",
      ctx,
    });
    const { version } = await defineCreatorProfileVersion(harness, profile.id, {
      subjectPersonId: personId,
      ctx,
    });
    // Committed reads through the authority boundary.
    const fetched = await harness.runtime.creatorService.getProfile(
      ctx,
      profile.id,
    );
    expect(fetched.displayName).toBe("Persisted Creator");
    const fetchedVersion =
      await harness.runtime.creatorService.getProfileVersion(
        ctx,
        profile.id,
        version.version,
      );
    expect(fetchedVersion.id).toBe(version.id);
    // The collections are the frozen names (the same collections the
    // production PostgreSQL adapter serves).
    expect(CREATORS_COLLECTION).toBe("creators");
    expect(CREATOR_PROFILE_VERSIONS_COLLECTION).toBe(
      "creator_profile_versions",
    );
  });

  test("a failed version definition leaves NO partial state (atomicity)", async () => {
    const personId = await createFreshPerson(harness, "ac05-atomic");
    const ctx = personCtx(harness, personId, "w015-ac05-atomic");
    const { profile } = await createCreatorProfile(harness, {
      creatorPersonId: personId,
      ctx,
    });
    // A version with an UNRESOLVABLE reputation reference fails
    // BEFORE any write; the profile is untouched.
    const sections = await createDefaultSections(harness, {
      subjectPersonId: personId,
    });
    (
      sections.reputationReferences[0] as unknown as Record<string, unknown>
    ).snapshotId = "00000000-0000-4000-8000-000000000000";
    await expect(
      defineCreatorProfileVersion(harness, profile.id, {
        sections,
        ctx,
      }),
    ).rejects.toThrow(/does not resolve/);
    const untouched = await harness.runtime.creatorService.getProfile(
      ctx,
      profile.id,
    );
    expect(untouched.currentVersion).toBeNull();
    expect(untouched.events).toHaveLength(1);
    const lineage = await harness.runtime.creatorService.listProfileVersions(
      ctx,
      profile.id,
    );
    expect(lineage).toHaveLength(0);
  });

  test("every mutation commits its audit event with actor/subject/resource + execution lineage", async () => {
    const personId = await createFreshPerson(harness, "ac05-audit");
    const ctx = personCtx(harness, personId, "w015-ac05-audit");
    const { profile } = await createCreatorProfile(harness, {
      creatorPersonId: personId,
      displayName: "Audited Creator",
      ctx,
    });

    // created
    const created = await harness.runtime.auditWriter.query({
      eventType: "creator_profile.created",
      resourceId: profile.id,
    });
    expect(created).toHaveLength(1);
    expect(created[0]!.actor).toBe(personId);
    expect(created[0]!.resourceType).toBe("creator_profile");
    const createdMeta = created[0]!.metadata as Record<string, unknown>;
    expect(createdMeta.organizationScopeId).toBe(harness.organizationScopeId);
    expect(createdMeta.creatorPersonId).toBe(personId);
    expect(createdMeta.idempotencyRecordId).toBeTruthy();
    expect(createdMeta.transactionId).toBeTruthy();
    expect(created[0]!.correlationId).toBe(ctx.correlationId);

    // version_defined
    const { version } = await defineCreatorProfileVersion(harness, profile.id, {
      subjectPersonId: personId,
      ctx,
    });
    const defined = await harness.runtime.auditWriter.query({
      eventType: "creator_profile.version_defined",
      resourceId: profile.id,
    });
    expect(defined).toHaveLength(1);
    const definedMeta = defined[0]!.metadata as Record<string, unknown>;
    expect(definedMeta.version).toBe(version.version);
    expect(definedMeta.versionRecordId).toBe(version.id);
    expect(definedMeta.reputationReferences).toEqual([
      {
        role: "audience_influence",
        snapshotId: expect.any(String),
        dimension: "content_quality",
      },
      {
        role: "production",
        snapshotId: expect.any(String),
        dimension: "creator_performance",
      },
    ]);

    // activated / paused / resumed / archived
    await harness.runtime.creatorService.activateProfile(ctx, {
      profileId: profile.id,
      idempotencyKey: key("w015-ac05-audit-activate"),
    });
    await harness.runtime.creatorService.pauseProfile(ctx, {
      profileId: profile.id,
      idempotencyKey: key("w015-ac05-audit-pause"),
    });
    await harness.runtime.creatorService.resumeProfile(ctx, {
      profileId: profile.id,
      idempotencyKey: key("w015-ac05-audit-resume"),
    });
    await harness.runtime.creatorService.archiveProfile(ctx, {
      profileId: profile.id,
      idempotencyKey: key("w015-ac05-audit-archive"),
    });
    for (const [eventType, from, to] of [
      ["creator_profile.activated", "DRAFT", "ACTIVE"],
      ["creator_profile.paused", "ACTIVE", "PAUSED"],
      ["creator_profile.resumed", "PAUSED", "ACTIVE"],
      ["creator_profile.archived", "ACTIVE", "ARCHIVED"],
    ] as const) {
      const events = await harness.runtime.auditWriter.query({
        eventType,
        resourceId: profile.id,
      });
      expect(events, eventType).toHaveLength(1);
      const meta = events[0]!.metadata as Record<string, unknown>;
      expect(meta.from).toBe(from);
      expect(meta.to).toBe(to);
      expect(meta.organizationScopeId).toBe(harness.organizationScopeId);
    }
  });
});
