/**
 * NET-W015-AC-01 — Creator profiles are first-class durable, scoped
 * records anchored to canonical identity (issue #29 AC-1).
 *
 * Proves:
 *  - creation (self-anchored, org-scoped, DRAFT, append-only history);
 *  - the unique-anchor rule (one profile per person per org — the
 *    identity-duplication guard);
 *  - the anchor person must EXIST in the canonical identity authority;
 *  - profiles are SELF-ANCHORED (no person creates another's profile);
 *  - durability through the authority boundary (committed reads);
 *  - the administrative status machine (activation gate, pause/
 *    resume, terminal archive, illegal transitions);
 *  - org listing/anchor lookups are tenant-scoped.
 */
import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import {
  createNetW015Harness,
  createCreatorProfile,
  defineCreatorProfileVersion,
  createFreshPerson,
  personCtx,
  creatorCtx,
  key,
  type NetW015Harness,
} from "./_net-w015-harness.ts";

let harness: NetW015Harness;

beforeAll(async () => {
  harness = await createNetW015Harness();
});

afterAll(async () => {
  await harness.teardown();
});

describe("NET-W015-AC-01 first-class profile records", () => {
  test("createProfile produces a durable, org-scoped, DRAFT record anchored to the canonical person", async () => {
    const personId = await createFreshPerson(harness, "ac01-primary");
    const ctx = personCtx(harness, personId, "w015-ac01-create");
    const { profile, created } = await createCreatorProfile(harness, {
      creatorPersonId: personId,
      displayName: "Primary Creator",
      ctx,
    });
    expect(created).toBe(true);
    expect(profile.organizationScopeId).toBe(harness.organizationScopeId);
    expect(profile.creatorPersonId).toBe(personId);
    expect(profile.status).toBe("DRAFT");
    expect(profile.currentVersion).toBeNull();
    expect(profile.displayName).toBe("Primary Creator");
    expect(profile.events).toHaveLength(1);
    expect(profile.events[0]!.event).toBe("created");
    expect(profile.events[0]!.actorPersonId).toBe(personId);
    expect(profile.executionId).toBeTruthy();
    expect(profile.correlationId).toBeTruthy();

    // Durability: a committed re-read returns the same record.
    const fetched = await harness.runtime.creatorService.getProfile(
      ctx,
      harness.organizationScopeId,
      profile.id,
    );
    expect(fetched.id).toBe(profile.id);
    expect(fetched.createdAt).toBe(profile.createdAt);
    expect(fetched.events).toHaveLength(1);
  });

  test("the unique-anchor rule: one profile per person per organization scope", async () => {
    const personId = await createFreshPerson(harness, "ac01-unique");
    const ctx = personCtx(harness, personId, "w015-ac01-unique");
    const { profile } = await createCreatorProfile(harness, {
      creatorPersonId: personId,
      displayName: "Unique Anchor",
      ctx,
    });
    // A SECOND profile for the same person in the SAME org is the
    // identity-duplication path — refused.
    await expect(
      createCreatorProfile(harness, {
        creatorPersonId: personId,
        displayName: "Duplicate",
        idempotencyKey: key("w015-ac01-dup"),
        ctx,
      }),
    ).rejects.toThrow(/already holds a creator profile/);
    // The SAME idempotency key replays harmlessly (created: false).
    const replay = await createCreatorProfile(harness, {
      creatorPersonId: personId,
      displayName: "Unique Anchor",
      idempotencyKey: profile.idempotencyKey,
      ctx,
    });
    expect(replay.created).toBe(false);
    expect(replay.profile.id).toBe(profile.id);

    // The anchor lookup resolves the profile for the person in-org.
    const byPerson = await harness.runtime.creatorService.getProfileByPerson(
      ctx,
      harness.organizationScopeId,
      personId,
    );
    expect(byPerson?.id).toBe(profile.id);

    // A DIFFERENT person in the same org holds their own profile
    // (per-person anchors, no collision).
    const secondPersonId = await createFreshPerson(harness, "ac01-second");
    const second = await createCreatorProfile(harness, {
      creatorPersonId: secondPersonId,
      displayName: "Second Creator",
      ctx: personCtx(harness, secondPersonId, "w015-ac01-second"),
    });
    expect(second.profile.creatorPersonId).toBe(secondPersonId);
  });

  test("the anchor person must exist in the canonical identity authority", async () => {
    const ghost = "00000000-0000-4000-8000-000000000000";
    // Self-anchored (the actor IS the anchor) but the anchor does not
    // exist in the canonical identity authority → refused.
    await expect(
      harness.runtime.creatorService.createProfile(
        personCtx(harness, ghost, "w015-ac01-ghost"),
        {
          organizationScopeId: harness.organizationScopeId,
          creatorPersonId: ghost,
          displayName: "Ghost",
          idempotencyKey: key("w015-ac01-ghost"),
        },
      ),
    ).rejects.toThrow(/anchor person does not exist/);
  });

  test("profiles are self-anchored: no person creates another person's profile", async () => {
    const personId = await createFreshPerson(harness, "ac01-victim");
    await expect(
      harness.runtime.creatorService.createProfile(
        creatorCtx(harness, "w015-ac01-self-anchor"),
        {
          organizationScopeId: harness.organizationScopeId,
          creatorPersonId: personId,
          displayName: "Stolen Anchor",
          idempotencyKey: key("w015-ac01-stolen"),
        },
      ),
    ).rejects.toThrow(/self-anchored/);
  });

  test("the administrative status machine: gate → ACTIVE → PAUSED → ACTIVE → ARCHIVED", async () => {
    const personId = await createFreshPerson(harness, "ac01-status");
    const ctx = personCtx(harness, personId, "w015-ac01-status");
    const { profile } = await createCreatorProfile(harness, {
      creatorPersonId: personId,
      displayName: "Status Machine",
      ctx,
    });

    // Activation requires a defined version (the CAMP-002 precedent).
    await expect(
      harness.runtime.creatorService.activateProfile(ctx, {
        profileId: profile.id,
        idempotencyKey: key("w015-ac01-early-activate"),
      }),
    ).rejects.toThrow(/cannot activate: no profile version/);

    await defineCreatorProfileVersion(harness, profile.id, {
      subjectPersonId: personId,
      ctx,
    });
    const active = await harness.runtime.creatorService.activateProfile(ctx, {
      profileId: profile.id,
      idempotencyKey: key("w015-ac01-activate"),
    });
    expect(active.status).toBe("ACTIVE");
    expect(active.currentVersion).toBe(1);
    expect(active.events.map((e) => e.event)).toEqual([
      "created",
      "profile_version_defined",
      "activated",
    ]);

    const paused = await harness.runtime.creatorService.pauseProfile(ctx, {
      profileId: profile.id,
      idempotencyKey: key("w015-ac01-pause"),
    });
    expect(paused.status).toBe("PAUSED");

    const resumed = await harness.runtime.creatorService.resumeProfile(ctx, {
      profileId: profile.id,
      idempotencyKey: key("w015-ac01-resume"),
    });
    expect(resumed.status).toBe("ACTIVE");

    // Illegal transitions are refused with the legal source states.
    await expect(
      harness.runtime.creatorService.resumeProfile(ctx, {
        profileId: profile.id,
        idempotencyKey: key("w015-ac01-resume-illegal"),
      }),
    ).rejects.toThrow(/cannot transition ACTIVE → ACTIVE/);

    const archived = await harness.runtime.creatorService.archiveProfile(ctx, {
      profileId: profile.id,
      idempotencyKey: key("w015-ac01-archive"),
    });
    expect(archived.status).toBe("ARCHIVED");

    // ARCHIVED is terminal: no further status or version mutations.
    await expect(
      harness.runtime.creatorService.pauseProfile(ctx, {
        profileId: profile.id,
        idempotencyKey: key("w015-ac01-pause-terminal"),
      }),
    ).rejects.toThrow(/cannot transition ARCHIVED/);
    await expect(
      defineCreatorProfileVersion(harness, profile.id, {
        subjectPersonId: personId,
        ctx,
      }),
    ).rejects.toThrow(/terminal \(ARCHIVED\)/);

    // The event history is append-only and complete.
    const final = await harness.runtime.creatorService.getProfile(
      ctx,
      harness.organizationScopeId,
      profile.id,
    );
    expect(final.events.map((e) => e.event)).toEqual([
      "created",
      "profile_version_defined",
      "activated",
      "paused",
      "resumed",
      "archived",
    ]);
  });

  test("org listing is scoped (tenant isolation on reads)", async () => {
    const personId = await createFreshPerson(harness, "ac01-listing");
    const ctx = personCtx(harness, personId, "w015-ac01-list");
    const { profile } = await createCreatorProfile(harness, {
      creatorPersonId: personId,
      displayName: "Listed Creator",
      ctx,
    });
    const mine = await harness.runtime.creatorService.listProfiles(
      ctx,
      harness.organizationScopeId,
    );
    expect(mine.some((p) => p.id === profile.id)).toBe(true);

    // The OTHER org's listing does NOT leak this profile.
    const theirs = await harness.runtime.creatorService.listProfiles(
      ctx,
      harness.secondOrgId,
    );
    expect(theirs.some((p) => p.id === profile.id)).toBe(false);

    // The anchor lookup in the WRONG org returns null (not an error —
    // absence leaks nothing).
    const cross = await harness.runtime.creatorService.getProfileByPerson(
      ctx,
      harness.secondOrgId,
      personId,
    );
    expect(cross).toBeNull();
  });
});
