/**
 * NET-W016-AC-06 — the match-run record contract (work order §3.4;
 * issue #31 invariants 1 and 7).
 *
 * The run record's shape is stable and pinned (format lineage,
 * frozen requirements, weights, advisory metadata, counts, results,
 * excluded candidates); the digest is deterministic over the
 * canonical decision content (identical inputs → identical digest;
 * different inputs → different digest; recomputation reproduces
 * it); the campaign linkage PINS the exact policy version; the
 * stored requirements are frozen copies (caller mutations cannot
 * rewrite a committed decision).
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
import { computeMatchDigest } from "../../src/creators/matching-engine.ts";
import { CREATOR_MATCH_FORMAT } from "../../src/core/creators.ts";

let harness: NetW016Harness;

beforeAll(async () => {
  harness = await createNetW016Harness();
});

afterAll(async () => {
  await harness.teardown();
});

describe("NET-W016-AC-06 the match-run record contract", () => {
  test("the run record carries the pinned contract shape (format lineage, frozen inputs, counts, digest)", async () => {
    const candidate = await createMatchCandidate(harness);
    const requirements = {
      ...baselineRequirements(),
      requiredFormats: ["short_video"] as const,
    };
    const { run } = await runMatch(harness, {
      requirements,
      candidateProfileIds: [candidate.profile.id],
      idempotencyKey: key("w016-ac06-shape"),
    });
    expect(run.formatVersion).toBe(CREATOR_MATCH_FORMAT);
    expect(run.organizationScopeId).toBe(harness.organizationScopeId);
    expect(run.campaign).toBeNull();
    expect(run.requirements).toEqual(requirements);
    expect(run.requirements.requiredFormats).toEqual(["short_video"]);
    expect(run.weights).toEqual({
      relevance: 30,
      audienceQuality: 20,
      historicOutcomes: 20,
      safety: 10,
      price: 10,
      availability: 10,
    });
    expect(run.advisory).toEqual({
      used: false,
      blend: 0,
      provider: null,
      modelRef: null,
    });
    expect(run.candidateCount).toBe(1);
    expect(run.eligibleCount).toBe(1);
    expect(run.results).toHaveLength(1);
    expect(run.excluded).toHaveLength(0);
    expect(run.digest).toMatch(/^[0-9a-f]{64}$/);
    expect(run.createdBy).toBe(harness.operatorPersonId);
    expect(run.idempotencyKey).toBeTruthy();
    expect(run.executionId).toBeTruthy();
    expect(run.correlationId).toBeTruthy();
    // The ranked result shape.
    const result = run.results[0]!;
    expect(result.profileId).toBe(candidate.profile.id);
    expect(result.profileVersion).toBe(1);
    expect(result.rank).toBe(1);
    expect(typeof result.totalScore).toBe("number");
    expect(result.signals).toHaveLength(6);
  });

  test("the digest is DETERMINISTIC over the decision content (identical inputs → identical; different → different; recomputable)", async () => {
    const a = await createMatchCandidate(harness);
    const b = await createMatchCandidate(harness);
    const requirements = {
      ...baselineRequirements(),
      requiredFormats: ["short_video"] as const,
    };
    const first = await runMatch(harness, {
      requirements,
      candidateProfileIds: [a.profile.id, b.profile.id],
      idempotencyKey: key("w016-ac06-digest-1"),
    });
    const second = await runMatch(harness, {
      requirements,
      candidateProfileIds: [a.profile.id, b.profile.id],
      idempotencyKey: key("w016-ac06-digest-2"),
    });
    // Identical decision content → identical digest (ids, timestamps
    // and idempotency metadata are NOT part of the digest).
    expect(second.run.digest).toBe(first.run.digest);

    // Recomputing the digest from the record's decision content
    // reproduces it (the reproducibility anchor).
    expect(
      computeMatchDigest({
        organizationScopeId: first.run.organizationScopeId,
        formatVersion: first.run.formatVersion,
        campaign: first.run.campaign,
        requirements: first.run.requirements,
        weights: first.run.weights,
        advisory: first.run.advisory,
        candidateCount: first.run.candidateCount,
        eligibleCount: first.run.eligibleCount,
        results: first.run.results,
        excluded: first.run.excluded,
      }),
    ).toBe(first.run.digest);

    // Different inputs → different digest.
    const different = await runMatch(harness, {
      requirements: {
        ...requirements,
        requiredFormats: ["article"] as const,
      },
      candidateProfileIds: [a.profile.id, b.profile.id],
      idempotencyKey: key("w016-ac06-digest-3"),
    });
    expect(different.run.digest).not.toBe(first.run.digest);

    // Different candidates → different digest.
    const c = await createMatchCandidate(harness);
    const otherCandidates = await runMatch(harness, {
      requirements,
      candidateProfileIds: [a.profile.id, c.profile.id],
      idempotencyKey: key("w016-ac06-digest-4"),
    });
    expect(otherCandidates.run.digest).not.toBe(first.run.digest);

    // CANONICALIZATION: the digest is independent of the INPUT ARRAY
    // ORDER of the requirement sets (reordered requirements are the
    // same decision content → the same digest).
    const reordered = await runMatch(harness, {
      requirements: {
        ...requirements,
        requiredFormats: ["post", "short_video"] as never,
        campaignTopics: ["b-topic", "a-topic"],
        targetTerritories: ["NG", "GH"],
      },
      candidateProfileIds: [a.profile.id, b.profile.id],
      idempotencyKey: key("w016-ac06-digest-5"),
    });
    // Note: this reordered run declares MORE constraints than `first`
    // (post + topics + territories) — compare it against a re-ordered
    // IDENTICAL constraint set instead.
    const baseMulti = await runMatch(harness, {
      requirements: {
        ...baselineRequirements(),
        requiredFormats: ["short_video", "post"] as never,
        campaignTopics: ["a-topic", "b-topic"],
        targetTerritories: ["GH", "NG"],
      },
      candidateProfileIds: [a.profile.id, b.profile.id],
      idempotencyKey: key("w016-ac06-digest-6"),
    });
    expect(reordered.run.digest).toBe(baseMulti.run.digest);
  });

  test("the campaign linkage PINS the exact policy version (later versions do not rewrite a pinned run)", async () => {
    const { campaign } = await createCampaignWithRules(harness, {
      eligibilityRules: [
        { attribute: "language", operator: "equals", values: ["en"] },
      ],
    });
    const enOnly = await createMatchCandidate(harness, { languages: ["en"] });
    const frOnly = await createMatchCandidate(harness, { languages: ["fr"] });

    // v1 requires EN: the fr-only candidate is excluded.
    const pinnedV1 = await runMatch(harness, {
      campaign: { campaignId: campaign.id, policyVersion: 1 },
      requirements: baselineRequirements(),
      candidateProfileIds: [enOnly.profile.id, frOnly.profile.id],
      idempotencyKey: key("w016-ac06-pin-v1"),
    });
    expect(pinnedV1.run.campaign).toEqual({
      campaignId: campaign.id,
      policyVersion: 1,
    });
    expect(pinnedV1.run.eligibleCount).toBe(1);
    expect(pinnedV1.run.results[0]!.profileId).toBe(enOnly.profile.id);

    // Define policy version 2 that requires FR instead.
    const operatorCtx2 = matchCtx(
      harness,
      harness.operatorPersonId,
      "w016-policy-v2",
    );
    await harness.runtime.campaignService.defineCampaignPolicy(operatorCtx2, {
      campaignId: campaign.id,
      policy: {
        objectives: [
          {
            id: "obj-1",
            kind: "creator_content",
            description: "creator content objective",
            successCriteria: null,
          },
        ],
        eligibility: {
          rules: [
            { attribute: "language", operator: "equals", values: ["fr"] },
          ],
        },
        outcomePolicy: {
          requirements: [
            {
              objectiveId: "obj-1",
              outcomeType: "view",
              attributionMode: "deterministic",
              windowDays: 30,
              requiresExperiment: false,
            },
          ],
        },
        evidencePolicy: {
          requirements: [
            {
              objectiveId: "obj-1",
              requirementKind: "proof_of_value",
              minimumGrade: "ATTESTED",
              qualifyingSourceTypes: ["platform"],
            },
          ],
        },
        budget: { unit: "credits", totalAmount: 0, perObjective: [] },
        attributionRules: [
          {
            id: "attr-1",
            objectiveId: "obj-1",
            model: "deterministic",
            confidenceThreshold: 0.9,
            windowDays: 30,
            requiresExperiment: false,
          },
        ],
        clearingRules: [],
        opportunitySpecs: [],
      },
      idempotencyKey: key("w016-policy-v2"),
    });

    // An EXPLICIT v1 pin still evaluates v1's requirements (the
    // pinned decision is reproducible — later versions cannot
    // rewrite it).
    const stillV1 = await runMatch(harness, {
      campaign: { campaignId: campaign.id, policyVersion: 1 },
      requirements: baselineRequirements(),
      candidateProfileIds: [enOnly.profile.id, frOnly.profile.id],
      idempotencyKey: key("w016-ac06-pin-v1-again"),
    });
    expect(stillV1.run.campaign!.policyVersion).toBe(1);
    expect(stillV1.run.results[0]!.profileId).toBe(enOnly.profile.id);
    expect(stillV1.run.digest).toBe(pinnedV1.run.digest);

    // Omitting the version resolves the LATEST (v2: FR required).
    const latest = await runMatch(harness, {
      campaign: { campaignId: campaign.id },
      requirements: baselineRequirements(),
      candidateProfileIds: [enOnly.profile.id, frOnly.profile.id],
      idempotencyKey: key("w016-ac06-pin-latest"),
    });
    expect(latest.run.campaign!.policyVersion).toBe(2);
    expect(latest.run.results[0]!.profileId).toBe(frOnly.profile.id);
    expect(latest.run.digest).not.toBe(pinnedV1.run.digest);
  });

  test("excluded candidates carry the complete explanation (id, person, version, reasons)", async () => {
    const eligible = await createMatchCandidate(harness);
    const gated = await createMatchCandidate(harness, {
      acceptingWork: false,
      skipActivation: false,
    });
    const { run } = await runMatch(harness, {
      requirements: baselineRequirements(),
      candidateProfileIds: [eligible.profile.id, gated.profile.id],
      idempotencyKey: key("w016-ac06-excluded"),
    });
    expect(run.excluded).toHaveLength(1);
    const excluded = run.excluded[0]!;
    expect(excluded.profileId).toBe(gated.profile.id);
    expect(excluded.creatorPersonId).toBe(gated.personId);
    expect(excluded.displayName).toBe(gated.profile.displayName);
    expect(excluded.profileVersion).toBe(gated.profile.currentVersion);
    expect(excluded.failedReasons).toEqual(["not_accepting_work"]);
    // The excluded set is deterministically ordered (profileId ASC).
    const second = await createMatchCandidate(harness, {
      weeklyCapacity: 0,
    });
    const multi = await runMatch(harness, {
      requirements: baselineRequirements(),
      candidateProfileIds: [
        second.profile.id,
        gated.profile.id,
        eligible.profile.id,
      ],
      idempotencyKey: key("w016-ac06-excluded-order"),
    });
    const ids = multi.run.excluded.map((e) => e.profileId);
    expect(ids).toEqual([...ids].sort());
    expect(multi.run.candidateCount).toBe(3);
    expect(multi.run.eligibleCount).toBe(1);
  });

  test("the stored requirements are a FROZEN copy (caller-side mutation cannot rewrite the decision)", async () => {
    const candidate = await createMatchCandidate(harness);
    const requirements = baselineRequirements();
    const { run } = await runMatch(harness, {
      requirements,
      candidateProfileIds: [candidate.profile.id],
      idempotencyKey: key("w016-ac06-frozen"),
    });
    // Mutate the caller's object after the run.
    (requirements as unknown as { requiredFormats: string[] }).requiredFormats = [
      "post",
    ];
    // The committed record is unchanged.
    const stored = await harness.runtime.creatorMatchingService.getMatchRun(
      matchCtx(harness, harness.operatorPersonId, "w016-frozen-read"),
      harness.organizationScopeId,
      run.id,
    );
    expect(stored.requirements.requiredFormats).toEqual([]);
    expect(Object.isFrozen(stored.requirements)).toBe(true);
  });
});
