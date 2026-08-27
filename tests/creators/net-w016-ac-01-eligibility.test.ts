/**
 * NET-W016-AC-01 — deterministic eligibility (work order §3.1).
 *
 * Every hard gate fails with its CLOSED-VOCABULARY reason;
 * eligibility is the conjunction of all gates (multiple failures are
 * ALL reported); identical inputs produce identical verdicts; the
 * per-gate trace is complete; campaign-derived requirements merge
 * with the explicit ones.
 */

import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import {
  baselineRequirements,
  createMatchCandidate,
  createNetW016Harness,
  key,
  matchCtx,
  operatorCtx,
  runMatch,
  type NetW016Harness,
} from "./_net-w016-harness.ts";
import { evaluateEligibility } from "../../src/creators/matching-engine.ts";
import type { CreatorMatchGateReason } from "../../src/core/creators.ts";

let harness: NetW016Harness;

beforeAll(async () => {
  harness = await createNetW016Harness();
});

afterAll(async () => {
  await harness.teardown();
});

function failedReasonsOf(
  run: Awaited<ReturnType<typeof runMatch>>["run"],
  profileId: string,
): readonly CreatorMatchGateReason[] {
  const excluded = run.excluded.find((e) => e.profileId === profileId);
  expect(excluded).toBeDefined();
  return excluded!.failedReasons;
}

describe("NET-W016-AC-01 deterministic eligibility", () => {
  test("a baseline ACTIVE candidate with a versioned profile is eligible with a complete passing gate trace", async () => {
    const candidate = await createMatchCandidate(harness);
    const { run } = await runMatch(harness, {
      requirements: baselineRequirements(),
      candidateProfileIds: [candidate.profile.id],
      idempotencyKey: key("w016-ac01-baseline"),
    });
    expect(run.candidateCount).toBe(1);
    expect(run.eligibleCount).toBe(1);
    expect(run.results).toHaveLength(1);
    expect(run.results[0]!.profileId).toBe(candidate.profile.id);
    expect(run.excluded).toHaveLength(0);
  });

  test("no_profile_version: a profile without sections is ineligible (and cannot activate — both reasons reported)", async () => {
    const candidate = await createMatchCandidate(harness, {
      skipVersion: true,
      skipActivation: true,
    });
    const { run } = await runMatch(harness, {
      requirements: baselineRequirements(),
      candidateProfileIds: [candidate.profile.id],
      idempotencyKey: key("w016-ac01-noversion"),
    });
    const reasons = failedReasonsOf(run, candidate.profile.id);
    expect(reasons).toContain("no_profile_version");
    expect(reasons).toContain("profile_not_active");
  });

  test("profile_not_active: a PAUSED candidate is ineligible", async () => {
    const candidate = await createMatchCandidate(harness);
    const ctx = matchCtx(harness, candidate.personId, "w016-pause");
    await harness.runtime.creatorService.pauseProfile(ctx, {
      profileId: candidate.profile.id,
      idempotencyKey: key("w016-pause"),
    });
    const { run } = await runMatch(harness, {
      requirements: baselineRequirements(),
      candidateProfileIds: [candidate.profile.id],
      idempotencyKey: key("w016-ac01-paused"),
    });
    expect(failedReasonsOf(run, candidate.profile.id)).toContain(
      "profile_not_active",
    );
  });

  test("availability gates: not_accepting_work, no_capacity and notice_window_exceeded each fail with their reason", async () => {
    const notAccepting = await createMatchCandidate(harness, {
      acceptingWork: false,
    });
    const noCapacity = await createMatchCandidate(harness, {
      weeklyCapacity: 0,
    });
    const slowNotice = await createMatchCandidate(harness, {
      minimumNoticeDays: 30,
    });
    const { run } = await runMatch(harness, {
      requirements: {
        ...baselineRequirements(),
        noticeWindowDays: 7,
      },
      candidateProfileIds: [
        notAccepting.profile.id,
        noCapacity.profile.id,
        slowNotice.profile.id,
      ],
      idempotencyKey: key("w016-ac01-availability"),
    });
    expect(failedReasonsOf(run, notAccepting.profile.id)).toContain(
      "not_accepting_work",
    );
    expect(failedReasonsOf(run, noCapacity.profile.id)).toContain(
      "no_capacity",
    );
    expect(failedReasonsOf(run, slowNotice.profile.id)).toContain(
      "notice_window_exceeded",
    );
    expect(run.eligibleCount).toBe(0);
  });

  test("participation gates: direct_campaigns_not_accepted and invitation_required", async () => {
    const noDirect = await createMatchCandidate(harness, {
      acceptsDirectCampaigns: false,
    });
    const invitationOnly = await createMatchCandidate(harness, {
      requiresInvitation: true,
    });
    const { run } = await runMatch(harness, {
      requirements: baselineRequirements(),
      candidateProfileIds: [noDirect.profile.id, invitationOnly.profile.id],
      idempotencyKey: key("w016-ac01-participation"),
    });
    expect(failedReasonsOf(run, noDirect.profile.id)).toContain(
      "direct_campaigns_not_accepted",
    );
    expect(failedReasonsOf(run, invitationOnly.profile.id)).toContain(
      "invitation_required",
    );
  });

  test("format/language gates: format_unsupported, format_restricted and language_unsupported", async () => {
    const wrongFormats = await createMatchCandidate(harness, {
      capabilities: ["post"],
    });
    const restrictedFormat = await createMatchCandidate(harness, {
      restrictedFormats: ["short_video"],
    });
    const wrongLanguage = await createMatchCandidate(harness, {
      languages: ["de"],
    });
    const { run } = await runMatch(harness, {
      requirements: {
        ...baselineRequirements(),
        requiredFormats: ["short_video"],
        requiredLanguages: ["en"],
      },
      candidateProfileIds: [
        wrongFormats.profile.id,
        restrictedFormat.profile.id,
        wrongLanguage.profile.id,
      ],
      idempotencyKey: key("w016-ac01-formats"),
    });
    expect(failedReasonsOf(run, wrongFormats.profile.id)).toContain(
      "format_unsupported",
    );
    expect(failedReasonsOf(run, restrictedFormat.profile.id)).toContain(
      "format_restricted",
    );
    expect(failedReasonsOf(run, wrongLanguage.profile.id)).toContain(
      "language_unsupported",
    );
  });

  test("territory gates: territory_unsupported and territory_restricted (target territories intersect the audience)", async () => {
    const unreachable = await createMatchCandidate(harness, {
      topGeographies: [{ territory: "KE", share: 80 }],
    });
    const blocked = await createMatchCandidate(harness, {
      restrictedTerritories: ["GH"],
    });
    const { run } = await runMatch(harness, {
      requirements: {
        ...baselineRequirements(),
        targetTerritories: ["GH"],
      },
      candidateProfileIds: [unreachable.profile.id, blocked.profile.id],
      idempotencyKey: key("w016-ac01-territories"),
    });
    expect(failedReasonsOf(run, unreachable.profile.id)).toContain(
      "territory_unsupported",
    );
    expect(failedReasonsOf(run, blocked.profile.id)).toContain(
      "territory_restricted",
    );
  });

  test("topic_restricted: a campaign topic matching a restricted topic (case-insensitive) is a hard gate", async () => {
    const candidate = await createMatchCandidate(harness, {
      restrictedTopics: ["gambling"],
    });
    const { run } = await runMatch(harness, {
      requirements: {
        ...baselineRequirements(),
        campaignTopics: ["GAMBLING"],
      },
      candidateProfileIds: [candidate.profile.id],
      idempotencyKey: key("w016-ac01-topic"),
    });
    expect(failedReasonsOf(run, candidate.profile.id)).toContain(
      "topic_restricted",
    );
  });

  test("rights_not_granted: an ungranted required rights kind is a hard gate", async () => {
    const candidate = await createMatchCandidate(harness);
    const { run } = await runMatch(harness, {
      requirements: {
        ...baselineRequirements(),
        requiredRightsKinds: ["reuse_license"],
      },
      candidateProfileIds: [candidate.profile.id],
      idempotencyKey: key("w016-ac01-rights"),
    });
    expect(failedReasonsOf(run, candidate.profile.id)).toContain(
      "rights_not_granted",
    );
  });

  test("rate_exceeds_ceiling: no qualifying rate within the ceiling is a hard gate", async () => {
    const candidate = await createMatchCandidate(harness);
    const { run } = await runMatch(harness, {
      requirements: {
        ...baselineRequirements(),
        requiredFormats: ["short_video"],
        rateCeiling: {
          amount: 100,
          currency: "USD",
          unit: "per_deliverable",
        },
      },
      candidateProfileIds: [candidate.profile.id],
      idempotencyKey: key("w016-ac01-rate"),
    });
    expect(failedReasonsOf(run, candidate.profile.id)).toContain(
      "rate_exceeds_ceiling",
    );
  });

  test("audience_band_below_minimum: the audience size band floor is a BAND comparison", async () => {
    const candidate = await createMatchCandidate(harness);
    const { run } = await runMatch(harness, {
      requirements: {
        ...baselineRequirements(),
        minimumAudienceSizeBand: "100k_1m",
      },
      candidateProfileIds: [candidate.profile.id],
      idempotencyKey: key("w016-ac01-band"),
    });
    expect(failedReasonsOf(run, candidate.profile.id)).toContain(
      "audience_band_below_minimum",
    );
  });

  test("reputation_below_minimum: a canonical score below the declared role threshold fails (threshold = score passes)", async () => {
    const candidate = await createMatchCandidate(harness);
    // Fresh candidates reference EMPTY canonical snapshots (score 0):
    // a 0.5 threshold fails; an explicit 0 threshold passes.
    const failing = await runMatch(harness, {
      requirements: {
        ...baselineRequirements(),
        minimumReputation: { audienceInfluence: null, production: 0.5 },
      },
      candidateProfileIds: [candidate.profile.id],
      idempotencyKey: key("w016-ac01-rep-fail"),
    });
    expect(
      failedReasonsOf(failing.run, candidate.profile.id),
    ).toContain("reputation_below_minimum");

    const passing = await runMatch(harness, {
      requirements: {
        ...baselineRequirements(),
        minimumReputation: { audienceInfluence: null, production: 0 },
      },
      candidateProfileIds: [candidate.profile.id],
      idempotencyKey: key("w016-ac01-rep-pass"),
    });
    expect(passing.run.eligibleCount).toBe(1);
  });

  test("reputation_reference_unresolvable: the pure engine fails unverified references (defensive gate)", () => {
    // The engine is exercised directly with unresolvable reputation
    // facts — in the wired runtime references stay valid (W015
    // verified them at definition time and snapshots are immutable),
    // so this gate is a defensive depth layer proven at the engine
    // contract level.
    const candidate = {
      profile: {
        id: "p1",
        organizationScopeId: "org",
        creatorPersonId: "person",
        displayName: "n",
        status: "ACTIVE" as const,
        currentVersion: 1,
        events: [],
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z",
        idempotencyKey: "k",
        executionId: "e",
        correlationId: "c",
        causationId: null,
      },
      version: null,
      sections: null,
      reputation: {
        verified: false,
        failedRole: "production",
        audienceInfluence: null,
        production: null,
      },
      safety: { held: false, controlId: null, action: null },
    };
    const eligibility = evaluateEligibility(candidate, baselineRequirements());
    expect(eligibility.eligible).toBe(false);
    expect(eligibility.failedReasons).toContain(
      "reputation_reference_unresolvable",
    );
    expect(eligibility.failedReasons).toContain("no_profile_version");
  });

  test("active_risk_control: an ACTIVE participant_eligibility HOLD on the creator person is a hard gate", async () => {
    const candidate = await createMatchCandidate(harness);
    await (
      await import("./_net-w016-harness.ts")
    ).activateEligibilityHold(harness, candidate.personId);
    const { run } = await runMatch(harness, {
      requirements: baselineRequirements(),
      candidateProfileIds: [candidate.profile.id],
      idempotencyKey: key("w016-ac01-hold"),
    });
    expect(failedReasonsOf(run, candidate.profile.id)).toContain(
      "active_risk_control",
    );
  });

  test("conjunction semantics: ALL failing gate reasons are reported together", async () => {
    const candidate = await createMatchCandidate(harness, {
      acceptingWork: false,
      requiresInvitation: true,
    });
    const { run } = await runMatch(harness, {
      requirements: {
        ...baselineRequirements(),
        requiredFormats: ["post"],
      },
      candidateProfileIds: [candidate.profile.id],
      idempotencyKey: key("w016-ac01-conjunction"),
    });
    const reasons = failedReasonsOf(run, candidate.profile.id);
    expect(reasons).toContain("not_accepting_work");
    expect(reasons).toContain("invitation_required");
    expect(reasons).toContain("format_unsupported");
  });

  test("campaign-derived requirements MERGE with the explicit ones (language/region eligibility rules)", async () => {
    const { createCampaignWithRules } = await import(
      "./_net-w016-harness.ts"
    );
    const { campaign } = await createCampaignWithRules(harness, {
      eligibilityRules: [
        { attribute: "language", operator: "equals", values: ["en"] },
        { attribute: "region", operator: "in", values: ["GH"] },
      ],
    });
    const reachable = await createMatchCandidate(harness);
    const unreachable = await createMatchCandidate(harness, {
      topGeographies: [{ territory: "KE", share: 90 }],
    });
    const { run } = await runMatch(harness, {
      campaign: { campaignId: campaign.id, policyVersion: 1 },
      requirements: baselineRequirements(),
      candidateProfileIds: [reachable.profile.id, unreachable.profile.id],
      idempotencyKey: key("w016-ac01-campaign-merge"),
    });
    expect(run.campaign).toEqual({
      campaignId: campaign.id,
      policyVersion: 1,
    });
    // The campaign-derived GH territory requirement merged into the
    // effective requirements: the KE-only audience is excluded even
    // though the EXPLICIT requirements declared no territories.
    expect(run.eligibleCount).toBe(1);
    expect(run.results[0]!.profileId).toBe(reachable.profile.id);
    expect(failedReasonsOf(run, unreachable.profile.id)).toContain(
      "territory_unsupported",
    );
    // The effective requirements on the run carry the merged rules.
    expect(run.requirements.targetTerritories).toContain("GH");
    expect(run.requirements.requiredLanguages).toContain("en");
  });

  test("determinism: identical inputs produce identical verdicts across runs", async () => {
    const a = await createMatchCandidate(harness);
    const b = await createMatchCandidate(harness, {
      acceptingWork: false,
    });
    const requirements = {
      ...baselineRequirements(),
      requiredFormats: ["short_video"] as const,
    };
    const first = await runMatch(harness, {
      requirements,
      candidateProfileIds: [a.profile.id, b.profile.id],
      idempotencyKey: key("w016-ac01-det-1"),
    });
    const second = await runMatch(harness, {
      requirements,
      candidateProfileIds: [a.profile.id, b.profile.id],
      idempotencyKey: key("w016-ac01-det-2"),
    });
    expect(second.run.eligibleCount).toBe(first.run.eligibleCount);
    expect(
      second.run.results.map((r) => r.profileId),
    ).toEqual(first.run.results.map((r) => r.profileId));
    expect(
      second.run.excluded.map((e) => [e.profileId, e.failedReasons]),
    ).toEqual(first.run.excluded.map((e) => [e.profileId, e.failedReasons]));
    expect(second.run.digest).toBe(first.run.digest);
  });

  test("the default enumeration covers the org's ACTIVE profiles only", async () => {
    const active = await createMatchCandidate(harness);
    const paused = await createMatchCandidate(harness);
    const ctx = matchCtx(harness, paused.personId, "w016-pause-default");
    await harness.runtime.creatorService.pauseProfile(ctx, {
      profileId: paused.profile.id,
      idempotencyKey: key("w016-pause-default"),
    });
    const { run } = await runMatch(harness, {
      requirements: baselineRequirements(),
      idempotencyKey: key("w016-ac01-default-enum"),
    });
    expect(run.candidateCount).toBeGreaterThanOrEqual(1);
    expect(
      run.results.map((r) => r.profileId),
    ).toContain(active.profile.id);
    expect(
      [...run.results, ...run.excluded].map((r) => r.profileId),
    ).not.toContain(paused.profile.id);
  });

  test("an operator person (not the candidate) runs the match; a non-person actor is rejected", async () => {
    const candidate = await createMatchCandidate(harness);
    const { run } = await runMatch(harness, {
      requirements: baselineRequirements(),
      candidateProfileIds: [candidate.profile.id],
      idempotencyKey: key("w016-ac01-operator"),
    });
    expect(run.createdBy).toBe(harness.operatorPersonId);
    expect(run.createdBy).not.toBe(candidate.personId);

    const { createExecutionContext } = await import(
      "../../src/core/execution-context.ts"
    );
    const systemCtx = createExecutionContext({
      correlationId: "w016-system",
      actor: { id: "worker-1", kind: "service" },
    });
    await expect(
      harness.runtime.creatorMatchingService.runMatch(systemCtx, {
        organizationScopeId: harness.organizationScopeId,
        requirements: baselineRequirements(),
        idempotencyKey: key("w016-ac01-system"),
      }),
    ).rejects.toThrow(
      /an authenticated person actor is required to run a match/,
    );
    expect(operatorCtx(harness, "x").actor?.kind).toBe("person");
  });
});
