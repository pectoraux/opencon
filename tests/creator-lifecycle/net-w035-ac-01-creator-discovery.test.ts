/**
 * NET-W035-AC-01 — Creator authority and discovery (issue #71 §5
 * AC-01; work order §4.1).
 *
 * A deterministic tenant-scoped creator fixture is resolved through
 * /creators and W016. Hard creator restrictions and campaign
 * eligibility are enforced BEFORE ranking; unauthorized and
 * cross-tenant access fails closed; matching does not create
 * placement, settlement or rights mutations.
 */

import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import {
  createNetW035Harness,
  runCreatorScenario,
  runCreatorMatch,
  key,
  personCtx,
  type NetW035Harness,
  type CreatorScenario,
} from "./_net-w035-harness.ts";
import { createMatchCandidate } from "../creators/_net-w016-harness.ts";

let harness: NetW035Harness;
let scenario: CreatorScenario;

beforeAll(async () => {
  harness = await createNetW035Harness();
  scenario = await runCreatorScenario(harness, { skipSettlement: true });
});

afterAll(async () => {
  await harness.teardown();
});

describe("NET-W035-AC-01 creator authority and discovery", () => {
  test("the tenant-scoped creator profile resolves through /creators with an ACTIVE versioned record", async () => {
    const ctx = harness.creatorCtx("w035-ac01-profile");
    const profile = await harness.runtime.creatorService.getProfileByPerson(
      ctx,
      harness.organizationScopeId,
      harness.creatorPersonId,
    );
    expect(profile).not.toBeNull();
    expect(profile!.status).toBe("ACTIVE");
    expect(profile!.organizationScopeId).toBe(harness.organizationScopeId);
    expect(profile!.creatorPersonId).toBe(harness.creatorPersonId);
    const versions =
      await harness.runtime.creatorService.listProfileVersions(
        ctx,
        harness.organizationScopeId,
        profile!.id,
      );
    expect(versions.length).toBeGreaterThanOrEqual(1);
    expect(versions[versions.length - 1]!.version).toBe(
      scenario.creatorProfileVersion,
    );
  });

  test("the creator's OWN context resolves the profile by person (the authorized anchor); the advisory stays disabled", async () => {
    const own = await harness.runtime.creatorService.getProfileByPerson(
      harness.creatorCtx("w035-ac01-own"),
      harness.organizationScopeId,
      harness.creatorPersonId,
    );
    expect(own!.id).toBe(scenario.creatorProfileId);
    // The scenario match: the advisory was never consulted (bounded,
    // non-authoritative by default).
    const run = await harness.runtime.creatorMatchingService.getMatchRun(
      harness.creatorCtx("w035-ac01-run"),
      harness.organizationScopeId,
      scenario.matchRunId,
    );
    expect(run.advisory.used).toBe(false);
  });

  test("the W016 hard gates exclude a restricted candidate BEFORE deterministic ranking", async () => {
    const run = await harness.runtime.creatorMatchingService.getMatchRun(
      harness.creatorCtx("w035-ac01-gates"),
      harness.organizationScopeId,
      scenario.matchRunId,
    );
    // The eligible scenario creator is RANKED (rank 1)…
    const ranked = run.results.find(
      (r) => r.profileId === scenario.creatorProfileId,
    );
    expect(ranked).toBeDefined();
    expect(ranked!.rank).toBe(1);
    // …while the restricted candidate is EXCLUDED with the hard gate
    // reason (never ranked, never scored).
    const excluded = run.excluded.find(
      (e) => e.profileId === scenario.excludedProfileId,
    );
    expect(excluded).toBeDefined();
    expect(excluded!.failedReasons.includes("territory_restricted")).toBe(
      true,
    );
    expect(
      run.results.some((r) => r.profileId === scenario.excludedProfileId),
    ).toBe(false);
    // The deterministic digest is present on the committed run.
    expect(run.digest).toBeTruthy();
  });

  test("a CAMPAIGN-LINKED match unions the campaign rules into the hard gates (still before ranking)", async () => {
    // The campaign-linked variant: the SAME creator set matched against
    // the scenario campaign's pinned policy — the neutral campaign
    // lookup resolves the policy's declared rules and unions them into
    // the effective requirements BEFORE ranking.
    const candidate = await createMatchCandidate(
      harness.w018.w017.w016,
      { restrictedTerritories: ["GH"] },
    );
    const match = await runCreatorMatch(harness, {
      campaign: {
        campaignId: scenario.campaignId,
        policyVersion: scenario.campaignPolicyVersion,
      },
      candidateProfileIds: [scenario.creatorProfileId, candidate.profile.id],
      idempotencyKey: key("w035-ac01-linked"),
    });
    const linked = await harness.runtime.creatorMatchingService.getMatchRun(
      harness.creatorCtx("w035-ac01-linked-read"),
      harness.organizationScopeId,
      match.run.id,
    );
    expect(linked.campaign!.campaignId).toBe(scenario.campaignId);
    expect(linked.campaign!.policyVersion).toBe(scenario.campaignPolicyVersion);
    // The creator's topGeographies (GH/NG) satisfy the campaign's
    // region rule; the restricted candidate is STILL hard-excluded.
    expect(
      linked.results.some((r) => r.profileId === scenario.creatorProfileId),
    ).toBe(true);
    expect(
      linked.excluded.some((e) => e.profileId === candidate.profile.id),
    ).toBe(true);
  });

  test("the match digest is DETERMINISTIC (identical inputs → identical digest, different keys → separate runs)", async () => {
    const a = await runCreatorMatch(harness, {
      candidateProfileIds: [scenario.creatorProfileId],
      idempotencyKey: key("w035-ac01-det-a"),
    });
    const b = await runCreatorMatch(harness, {
      candidateProfileIds: [scenario.creatorProfileId],
      idempotencyKey: key("w035-ac01-det-b"),
    });
    expect(b.created).toBe(true);
    expect(b.run.id).not.toBe(a.run.id);
    expect(b.run.digest).toBe(a.run.digest);
  });

  test("matching creates NO placement, settlement or rights mutations (the ledger is untouched)", async () => {
    const before =
      await harness.runtime.postgresAuthority.scan("economic_ledger_entries");
    const grantsBefore = await harness.runtime.postgresAuthority.scan(
      "usage_rights_grants",
    );
    await runCreatorMatch(harness, {
      candidateProfileIds: [scenario.creatorProfileId],
      idempotencyKey: key("w035-ac01-inert"),
    });
    const after =
      await harness.runtime.postgresAuthority.scan("economic_ledger_entries");
    const grantsAfter = await harness.runtime.postgresAuthority.scan(
      "usage_rights_grants",
    );
    expect(after.length).toBe(before.length);
    expect(grantsAfter.length).toBe(grantsBefore.length);
  });

  test("same-key match replay returns the COMMITTED run verbatim; cross-tenant references fail closed without an oracle", async () => {
    const idem = key("w035-ac01-replay");
    const first = await runCreatorMatch(harness, {
      candidateProfileIds: [scenario.creatorProfileId],
      idempotencyKey: idem,
    });
    expect(first.created).toBe(true);
    const replay = await runCreatorMatch(harness, {
      candidateProfileIds: [scenario.creatorProfileId],
      idempotencyKey: idem,
    });
    expect(replay.created).toBe(false);
    expect(replay.run.id).toBe(first.run.id);

    // Cross-tenant: the second-org actor resolving the first-org
    // creator's profile gets NULL (no existence oracle)…
    const foreign = await harness.runtime.creatorService.getProfileByPerson(
      personCtx(harness, harness.secondOrgPersonId, "w035-ac01-foreign"),
      harness.secondOrgId,
      harness.creatorPersonId,
    );
    expect(foreign).toBeNull();
    // …and a match run read through the foreign scope fails closed.
    await expect(
      harness.runtime.creatorMatchingService.getMatchRun(
        personCtx(harness, harness.secondOrgPersonId, "w035-ac01-foreign-run"),
        harness.secondOrgId,
        scenario.matchRunId,
      ),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
  });
});
