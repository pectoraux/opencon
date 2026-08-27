/**
 * NET-W015 — PR #30 review remediation regressions (CHANGES
 * REQUESTED): the two blocking issues in the creator boundary.
 *
 * FIX 1 — unique-anchor CONCURRENCY is actually enforced:
 *  - concurrent creates for the SAME (organization scope, person)
 *    with DIFFERENT idempotency keys leave exactly ONE profile —
 *    the `creator_profile_anchor:{organizationScopeId}:{creatorPersonId}`
 *    mutex serializes the authoritative transaction (the NET-W007
 *    dispute-subject / NET-W012 transaction-boundary pattern), so
 *    the in-tx anchor re-check observes the prior creator's
 *    COMMITTED profile and the duplicate is refused;
 *  - the mutex does NOT over-serialize: concurrent creates for
 *    DIFFERENT persons all succeed, and the same person may still
 *    anchor one profile per DIFFERENT scope (the rule is per
 *    (scope, person), not per person);
 *  - the winner's same-key REPLAY after the race is a deterministic
 *    idempotent replay (the anchor mutex never breaks idempotency).
 *
 * FIX 2 — tenant isolation is complete on the ID-based reads:
 *  - a caller who knows another tenant's profile id cannot read the
 *    profile (getProfile), cannot enumerate its version lineage
 *    (listProfileVersions / getProfileVersion) and cannot resolve
 *    its creator reputation (resolveCreatorReputation) — every
 *    cross-scope read is NotFoundError, indistinguishable from a
 *    nonexistent id (no existence oracle);
 *  - the HTTP boundary requires organizationScopeId on all three
 *    ID-based GETs: absent → 400, cross-scope → 404, same-scope →
 *    200 with the data.
 */
import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { randomUUID } from "node:crypto";
import {
  createNetW015Harness,
  createCreatorProfile,
  defineCreatorProfileVersion,
  createFreshPerson,
  personCtx,
  key,
  type NetW015Harness,
} from "./_net-w015-harness.ts";
import { ConflictError, NotFoundError } from "../../src/core/errors.ts";
import { PostgresAuthorityShim } from "../../src/persistence/postgres-authority-shim.ts";
import type { ExecutionContext } from "../../src/core/execution-context.ts";
import type { CreatorProfileRecord } from "../../src/creators/port.ts";

let harness: NetW015Harness;

beforeAll(async () => {
  harness = await createNetW015Harness();
});

afterAll(async () => {
  await harness.teardown();
});

/** The shim (file-backed authority double) for boundary interception. */
function shim(): PostgresAuthorityShim {
  return harness.runtime.postgresAuthority as unknown as PostgresAuthorityShim;
}

describe("NET-W015 PR #30 remediation — fix 1: unique-anchor concurrency", () => {
  test("a rival create arriving while the winner's authoritative transaction is OPEN loses (forced interleaving at the boundary)", async () => {
    const personId = await createFreshPerson(harness, "rem-forced");
    const ctxA = personCtx(harness, personId, "w015-rem-forced-a");
    const ctxB = personCtx(harness, personId, "w015-rem-forced-b");
    const authority = shim();

    // The forced interleaving (the NET-W012 transaction-boundary-races
    // interception pattern, adapted): racer A's authoritative
    // transaction is parked OPEN right after it buffers the profile
    // insert (UNCOMMITTED). The concurrent rival from the review —
    // SAME (organization scope, person), DIFFERENT idempotency key —
    // is launched at that exact moment.
    //
    //  - WITH the anchor mutex the rival's whole apply is DEFERRED:
    //    it cannot even OPEN its transaction while A's is in flight
    //    (the rendezvous times out, A commits, then the rival begins,
    //    observes A's COMMITTED profile and loses);
    //  - WITHOUT the mutex the rival's transaction OPENS immediately
    //    (the rendezvous detects the begin), runs to settlement —
    //    its anchor read cannot see A's uncommitted insert — and
    //    BOTH commit, which the final assertions reject loudly.
    const CORR_A = "w015-rem-forced-a";
    const CORR_B = "w015-rem-forced-b";
    const RENDEZVOUS_TIMEOUT_MS = 150;
    let rivalLaunch: Promise<unknown> | null = null;
    let rivalBegan!: () => void;
    const rivalBeganSignal = new Promise<void>((resolve) => {
      rivalBegan = resolve;
    });
    let rendezvousStarted = false;
    let hooked = false;
    const originalBegin = authority.begin.bind(authority);
    authority.begin = async (context: ExecutionContext) => {
      const tx = await originalBegin(context);
      if (context.correlationId === CORR_A && !hooked) {
        hooked = true;
        // Park A AFTER its profile insert is buffered (tx open,
        // insert uncommitted) — the exact moment a concurrent rival
        // is dangerous.
        const originalPut = tx.put.bind(tx) as unknown as (
          collection: string,
          key: string,
          value: unknown,
        ) => Promise<unknown>;
        (
          tx as unknown as {
            put: (
              collection: string,
              key: string,
              value: unknown,
            ) => Promise<unknown>;
          }
        ).put = async (
          collection: string,
          recordKey: string,
          value: unknown,
        ) => {
          const record = await originalPut(collection, recordKey, value);
          if (collection === "creators" && !rendezvousStarted) {
            rendezvousStarted = true;
            rivalLaunch = harness.runtime.creatorService
              .createProfile(ctxB, {
                organizationScopeId: harness.organizationScopeId,
                creatorPersonId: personId,
                displayName: "Rival Racer",
                idempotencyKey: key("w015-rem-forced-b"),
              })
              .catch((err: unknown) => err);
            const outcome = await Promise.race([
              rivalBeganSignal.then(() => "began" as const),
              new Promise((resolve) =>
                setTimeout(resolve, RENDEZVOUS_TIMEOUT_MS),
              ).then(() => "timeout" as const),
            ]);
            if (outcome === "began") {
              // The rival transaction opened while A's insert is
              // UNCOMMITTED — the pre-fix race. Let the rival settle
              // fully so the duplicate (if unserialized) commits and
              // the final assertions catch it.
              await rivalLaunch;
            }
            // "timeout": the rival never opened a transaction — it
            // is parked on the anchor mutex (the fix). A resumes,
            // commits, releases the mutex; only then does the rival
            // begin and lose.
          }
          return record;
        };
      }
      if (context.correlationId === CORR_B) {
        rivalBegan();
      }
      return tx;
    };

    let first: unknown;
    try {
      first = await harness.runtime.creatorService.createProfile(ctxA, {
        organizationScopeId: harness.organizationScopeId,
        creatorPersonId: personId,
        displayName: "Winning Racer",
        idempotencyKey: key("w015-rem-forced-a"),
      });
      const rival = await rivalLaunch!;
      // The rival LOST: ConflictError, never a second profile.
      expect(rival).toBeInstanceOf(ConflictError);
      expect(String((rival as Error).message)).toMatch(
        /already holds a creator profile/,
      );
    } finally {
      authority.begin = originalBegin;
    }

    // Exactly ONE profile survived the race.
    const winner = first as { profile: { id: string }; created: boolean };
    expect(winner.created).toBe(true);
    const byPerson = await harness.runtime.creatorService.getProfileByPerson(
      ctxA,
      harness.organizationScopeId,
      personId,
    );
    expect(byPerson).not.toBeNull();
    expect(byPerson!.id).toBe(winner.profile.id);
    const listed = await harness.runtime.creatorService.listProfiles(
      ctxA,
      harness.organizationScopeId,
    );
    expect(listed.filter((p) => p.creatorPersonId === personId)).toHaveLength(1);
    const created = await harness.runtime.auditWriter.query({
      eventType: "creator_profile.created",
    });
    expect(
      created.filter(
        (e) =>
          (e.metadata as Record<string, unknown>).creatorPersonId ===
          personId,
      ),
    ).toHaveLength(1);
  });

  test("plain concurrent creates (different keys, same org+person) leave exactly ONE profile", async () => {
    const personId = await createFreshPerson(harness, "rem-race");
    const ctx = personCtx(harness, personId, "w015-rem-race");
    const RACERS = 8;
    const keys = Array.from(
      { length: RACERS },
      (_, i) => `w015-rem-race-${i}-${key("anchor")}`,
    );

    const results = await Promise.allSettled(
      keys.map((idempotencyKey, i) =>
        harness.runtime.creatorService.createProfile(ctx, {
          organizationScopeId: harness.organizationScopeId,
          creatorPersonId: personId,
          displayName: `Racer ${i}`,
          idempotencyKey,
        }),
      ),
    );
    const fulfilled = results.filter(
      (
        r,
      ): r is PromiseFulfilledResult<{
        profile: CreatorProfileRecord;
        created: boolean;
      }> => r.status === "fulfilled",
    );
    const rejected = results.filter(
      (r): r is PromiseRejectedResult => r.status === "rejected",
    );

    // Exactly ONE create committed.
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(RACERS - 1);
    const winner = fulfilled[0]!;
    expect(winner.value.created).toBe(true);

    // Every loser is the unique-anchor ConflictError — not a
    // snapshot race artifact, not an idempotency replay, not a 500.
    for (const r of rejected) {
      expect(r.reason).toBeInstanceOf(ConflictError);
      expect(String(r.reason.message)).toMatch(
        /already holds a creator profile/,
      );
    }

    // The anchor lookup finds EXACTLY the winner.
    const byPerson = await harness.runtime.creatorService.getProfileByPerson(
      ctx,
      harness.organizationScopeId,
      personId,
    );
    expect(byPerson).not.toBeNull();
    expect(byPerson!.id).toBe(winner.value.profile.id);

    // The organization listing carries exactly one profile for this
    // person (no duplicate rows committed under different ids).
    const listed = await harness.runtime.creatorService.listProfiles(
      ctx,
      harness.organizationScopeId,
    );
    expect(listed.filter((p) => p.creatorPersonId === personId)).toHaveLength(1);

    // Exactly ONE created audit event for this person (atomic
    // commit-or-nothing per racer).
    const created = await harness.runtime.auditWriter.query({
      eventType: "creator_profile.created",
    });
    expect(
      created.filter(
        (e) =>
          (e.metadata as Record<string, unknown>).creatorPersonId ===
          personId,
      ),
    ).toHaveLength(1);

    // The winner's SAME-KEY replay after the race is a deterministic
    // idempotent replay (the anchor mutex never breaks idempotency).
    const winnerIndex = results.findIndex((r) => r.status === "fulfilled");
    const winnerKey = keys[winnerIndex]!;
    const replay = await harness.runtime.creatorService.createProfile(ctx, {
      organizationScopeId: harness.organizationScopeId,
      creatorPersonId: personId,
      displayName: "Racer replay",
      idempotencyKey: winnerKey,
    });
    expect(replay.created).toBe(false);
    expect(replay.profile.id).toBe(winner.value.profile.id);
  });

  test("a sequential second create with a DIFFERENT key is refused (deterministic control)", async () => {
    const personId = await createFreshPerson(harness, "rem-sequential");
    const ctx = personCtx(harness, personId, "w015-rem-sequential");
    const first = await createCreatorProfile(harness, {
      creatorPersonId: personId,
      ctx,
    });
    expect(first.created).toBe(true);
    await expect(
      createCreatorProfile(harness, {
        creatorPersonId: personId,
        ctx,
        idempotencyKey: key("w015-rem-sequential-second"),
      }),
    ).rejects.toThrow(/already holds a creator profile/);
  });

  test("the anchor mutex does NOT over-serialize: different persons create concurrently; one person may anchor per DIFFERENT scope", async () => {
    // Four DIFFERENT persons racing in the same org: no shared
    // anchor, so all four commit.
    const persons = await Promise.all(
      [0, 1, 2, 3].map((i) => createFreshPerson(harness, `rem-multi-${i}`)),
    );
    const results = await Promise.allSettled(
      persons.map((personId, i) => {
        const ctx = personCtx(harness, personId, `w015-rem-multi-${i}`);
        return harness.runtime.creatorService.createProfile(ctx, {
          organizationScopeId: harness.organizationScopeId,
          creatorPersonId: personId,
          displayName: `Multi ${i}`,
          idempotencyKey: `w015-rem-multi-${i}-${key("person")}`,
        });
      }),
    );
    expect(results.every((r) => r.status === "fulfilled")).toBe(true);
    const ids = results.map(
      (r) => (r as PromiseFulfilledResult<{ profile: { id: string } }>).value
        .profile.id,
    );
    expect(new Set(ids).size).toBe(4);

    // The SAME person in a DIFFERENT organization scope: the anchor
    // rule is per (scope, person) — the second scope still creates
    // (and neither scope ever holds two profiles for the person).
    const personId = persons[0]!;
    const ctx = personCtx(harness, personId, "w015-rem-cross-scope");
    const second = await harness.runtime.creatorService.createProfile(ctx, {
      organizationScopeId: harness.secondOrgId,
      creatorPersonId: personId,
      displayName: "Second Scope",
      idempotencyKey: key("w015-rem-second-scope"),
    });
    expect(second.created).toBe(true);
    expect(second.profile.id).not.toBe(ids[0]);
    const inFirst = await harness.runtime.creatorService.getProfileByPerson(
      ctx,
      harness.organizationScopeId,
      personId,
    );
    const inSecond = await harness.runtime.creatorService.getProfileByPerson(
      ctx,
      harness.secondOrgId,
      personId,
    );
    expect(inFirst!.id).toBe(ids[0]!);
    expect(inSecond!.id).toBe(second.profile.id);
    // A SECOND profile in the second scope is still refused there.
    await expect(
      harness.runtime.creatorService.createProfile(ctx, {
        organizationScopeId: harness.secondOrgId,
        creatorPersonId: personId,
        displayName: "Duplicate in second scope",
        idempotencyKey: key("w015-rem-second-scope-dup"),
      }),
    ).rejects.toThrow(/already holds a creator profile/);
  });
});

describe("NET-W015 PR #30 remediation — fix 2: tenant isolation on the ID-based reads", () => {
  test("cross-tenant: Org B cannot read Org A's profile by id (NotFoundError — no existence oracle)", async () => {
    const personId = await createFreshPerson(harness, "rem-tenancy");
    const ctx = personCtx(harness, personId, "w015-rem-tenancy");
    const { profile } = await createCreatorProfile(harness, {
      creatorPersonId: personId,
      displayName: "Tenant Secret Name",
      ctx,
    });

    // Same scope reads it fine.
    const mine = await harness.runtime.creatorService.getProfile(
      ctx,
      harness.organizationScopeId,
      profile.id,
    );
    expect(mine.displayName).toBe("Tenant Secret Name");

    // Org B context: NOT FOUND — never the profile, never a
    // "forbidden, it exists elsewhere" signal.
    const crossError = await harness.runtime.creatorService
      .getProfile(ctx, harness.secondOrgId, profile.id)
      .catch((err: unknown) => err);
    expect(crossError).toBeInstanceOf(NotFoundError);
    expect(String((crossError as Error).message)).toMatch(
      /creator profile not found/,
    );

    // The cross-scope failure is INDISTINGUISHABLE from the
    // unknown-id failure (no existence oracle for foreign tenants):
    // same error class, same classification, same message shape.
    const unknownError = await harness.runtime.creatorService
      .getProfile(ctx, harness.secondOrgId, randomUUID())
      .catch((err: unknown) => err);
    expect(unknownError).toBeInstanceOf(NotFoundError);
    expect((crossError as Error).name).toBe((unknownError as Error).name);
    expect(String((unknownError as Error).message)).toMatch(
      /creator profile not found/,
    );

    // A missing scope is refused loudly (the boundary is explicit).
    await expect(
      harness.runtime.creatorService.getProfile(ctx, "", profile.id),
    ).rejects.toThrow(/organizationScopeId is required/);
  });

  test("cross-tenant versions: Org B cannot enumerate Org A's profile versions", async () => {
    const personId = await createFreshPerson(harness, "rem-versions");
    const ctx = personCtx(harness, personId, "w015-rem-versions");
    const { profile } = await createCreatorProfile(harness, {
      creatorPersonId: personId,
      ctx,
    });
    const { version } = await defineCreatorProfileVersion(harness, profile.id, {
      subjectPersonId: personId,
      ctx,
    });

    // Same scope enumerates the lineage.
    const mine = await harness.runtime.creatorService.listProfileVersions(
      ctx,
      harness.organizationScopeId,
      profile.id,
    );
    expect(mine.map((v) => v.version)).toEqual([version.version]);
    const mineV1 = await harness.runtime.creatorService.getProfileVersion(
      ctx,
      harness.organizationScopeId,
      profile.id,
      version.version,
    );
    expect(mineV1.id).toBe(version.id);

    // Org B CANNOT enumerate the lineage — not even learn it exists.
    await expect(
      harness.runtime.creatorService.listProfileVersions(
        ctx,
        harness.secondOrgId,
        profile.id,
      ),
    ).rejects.toThrow(/creator profile not found/);

    // Org B cannot fetch a specific version by id+version either.
    await expect(
      harness.runtime.creatorService.getProfileVersion(
        ctx,
        harness.secondOrgId,
        profile.id,
        version.version,
      ),
    ).rejects.toThrow(/creator profile version not found/);
  });

  test("cross-tenant reputation: Org B cannot resolve Org A's creator reputation", async () => {
    const personId = await createFreshPerson(harness, "rem-reputation");
    const ctx = personCtx(harness, personId, "w015-rem-reputation");
    const { profile } = await createCreatorProfile(harness, {
      creatorPersonId: personId,
      ctx,
    });
    await defineCreatorProfileVersion(harness, profile.id, {
      subjectPersonId: personId,
      ctx,
    });

    // Same scope resolves the canonical references.
    const mine = await harness.runtime.apiCommands.resolveCreatorReputation(
      ctx,
      harness.organizationScopeId,
      profile.id,
    );
    expect(mine.profileId).toBe(profile.id);
    expect(mine.currentVersion).toBe(1);
    expect(mine.references).toHaveLength(2);

    // Org B CANNOT resolve Org A's creator reputation — the profile
    // does not resolve in the foreign scope, so neither do its
    // reputation references.
    await expect(
      harness.runtime.apiCommands.resolveCreatorReputation(
        ctx,
        harness.secondOrgId,
        profile.id,
      ),
    ).rejects.toThrow(/creator profile not found/);
  });

  test("the HTTP ID-based reads REQUIRE organizationScopeId (400 absent; 404 cross-scope; 200 same-scope)", async () => {
    const personId = await createFreshPerson(harness, "rem-http");
    const ctx = personCtx(harness, personId, "w015-rem-http");
    const { profile } = await createCreatorProfile(harness, {
      creatorPersonId: personId,
      displayName: "HTTP Tenant Name",
      ctx,
    });
    const { version } = await defineCreatorProfileVersion(harness, profile.id, {
      subjectPersonId: personId,
      ctx,
    });
    const base = `http://127.0.0.1:${harness.runtime.api.port}`;

    // (a) GET /api/creators/:id
    const missingScope = await fetch(`${base}/api/creators/${profile.id}`);
    expect(missingScope.status).toBe(400);
    const wrongScope = await fetch(
      `${base}/api/creators/${profile.id}?organizationScopeId=${encodeURIComponent(harness.secondOrgId)}`,
    );
    expect(wrongScope.status).toBe(404);
    const wrongBody = (await wrongScope.json()) as { message?: string };
    expect(String(wrongBody.message)).not.toContain("HTTP Tenant Name");
    const ok = await fetch(
      `${base}/api/creators/${profile.id}?organizationScopeId=${encodeURIComponent(harness.organizationScopeId)}`,
    );
    expect(ok.status).toBe(200);
    const okBody = (await ok.json()) as { displayName?: string };
    expect(okBody.displayName).toBe("HTTP Tenant Name");

    // (b) GET /api/creators/:id/versions
    const versionsMissing = await fetch(
      `${base}/api/creators/${profile.id}/versions`,
    );
    expect(versionsMissing.status).toBe(400);
    const versionsWrong = await fetch(
      `${base}/api/creators/${profile.id}/versions?organizationScopeId=${encodeURIComponent(harness.secondOrgId)}`,
    );
    expect(versionsWrong.status).toBe(404);
    const versionsOk = await fetch(
      `${base}/api/creators/${profile.id}/versions?organizationScopeId=${encodeURIComponent(harness.organizationScopeId)}`,
    );
    expect(versionsOk.status).toBe(200);
    const versionsBody = (await versionsOk.json()) as {
      versions: { version: number }[];
    };
    expect(versionsBody.versions.map((v) => v.version)).toEqual([
      version.version,
    ]);

    // (c) GET /api/creators/:id/reputation
    const reputationMissing = await fetch(
      `${base}/api/creators/${profile.id}/reputation`,
    );
    expect(reputationMissing.status).toBe(400);
    const reputationWrong = await fetch(
      `${base}/api/creators/${profile.id}/reputation?organizationScopeId=${encodeURIComponent(harness.secondOrgId)}`,
    );
    expect(reputationWrong.status).toBe(404);
    const reputationOk = await fetch(
      `${base}/api/creators/${profile.id}/reputation?organizationScopeId=${encodeURIComponent(harness.organizationScopeId)}`,
    );
    expect(reputationOk.status).toBe(200);
    const reputationBody = (await reputationOk.json()) as {
      references: { digestMatches: boolean }[];
    };
    expect(reputationBody.references).toHaveLength(2);
    expect(reputationBody.references.every((r) => r.digestMatches)).toBe(true);
  });
});
