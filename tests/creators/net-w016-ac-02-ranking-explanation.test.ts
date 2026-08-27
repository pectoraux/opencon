/**
 * NET-W016-AC-02 — ranking by explicit signals + explanation (work
 * order §3.2).
 *
 * The six CRE-002 signals score deterministically with exact
 * expected values; weights are validated (integers 0–100, sum
 * EXACTLY 100); the total order is score DESC then profileId ASC
 * (stable tie-break); every signal carries a machine-readable
 * explanation naming the inputs used; canonical reputation scores
 * flow bit-for-bit from the /reputation authority into the signals.
 */

import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import {
  baselineRequirements,
  createMatchCandidate,
  createNetW016Harness,
  key,
  runMatch,
  type NetW016Harness,
} from "./_net-w016-harness.ts";
import { round1 } from "../../src/creators/matching-engine.ts";
import type { CreatorMatchSignalScore } from "../../src/creators/port.ts";
import { InvalidCreatorMatchError } from "../../src/core/creators.ts";

let harness: NetW016Harness;

beforeAll(async () => {
  harness = await createNetW016Harness();
});

afterAll(async () => {
  await harness.teardown();
});

function signalOf(
  run: Awaited<ReturnType<typeof runMatch>>["run"],
  profileId: string,
  signal: CreatorMatchSignalScore["signal"],
): CreatorMatchSignalScore {
  const result = run.results.find((r) => r.profileId === profileId);
  expect(result).toBeDefined();
  const found = result!.signals.find((s) => s.signal === signal);
  expect(found).toBeDefined();
  return found!;
}

describe("NET-W016-AC-02 ranking by explicit signals", () => {
  test("all six CRE-002 signals are present with score/weight/contribution/inputs", async () => {
    const candidate = await createMatchCandidate(harness);
    const { run } = await runMatch(harness, {
      requirements: {
        ...baselineRequirements(),
        requiredFormats: ["short_video"],
        requiredLanguages: ["en"],
        targetTerritories: ["GH"],
      },
      candidateProfileIds: [candidate.profile.id],
      idempotencyKey: key("w016-ac02-signals"),
    });
    const result = run.results[0]!;
    expect(result.signals.map((s) => s.signal)).toEqual([
      "relevance",
      "audience_quality",
      "historic_outcomes",
      "safety",
      "price",
      "availability",
    ]);
    for (const signal of result.signals) {
      expect(signal.score).toBeGreaterThanOrEqual(0);
      expect(signal.score).toBeLessThanOrEqual(100);
      expect(Number.isInteger(signal.weight)).toBe(true);
      expect(signal.contribution).toBe(
        round1((signal.score * signal.weight) / 100),
      );
      expect(Object.keys(signal.inputs).length).toBeGreaterThan(0);
    }
    // Default weights (relevance 30, audienceQuality 20,
    // historicOutcomes 20, safety 10, price 10, availability 10).
    expect(result.signals.map((s) => s.weight)).toEqual([30, 20, 20, 10, 10, 10]);
  });

  test("exact deterministic scores for the default fixture (fresh candidate, canonical empty snapshots)", async () => {
    const candidate = await createMatchCandidate(harness);
    const { run } = await runMatch(harness, {
      requirements: {
        ...baselineRequirements(),
        requiredFormats: ["short_video"],
        requiredLanguages: ["en"],
        targetTerritories: ["GH"],
      },
      candidateProfileIds: [candidate.profile.id],
      idempotencyKey: key("w016-ac02-exact"),
    });
    // relevance: coverage 100/100 + territory alignment min(100, GH 40)
    //   = round1((100 + 100 + 40) / 3) = 80
    expect(signalOf(run, candidate.profile.id, "relevance").score).toBe(80);
    // audience_quality: engagement "high" (66.7) blended 50/50 with
    //   the canonical audience_influence score (empty snapshot → 0):
    //   round1(0.5 × 66.7 + 0.5 × 0) = 33.4
    expect(signalOf(run, candidate.profile.id, "audience_quality").score).toBe(33.4);
    // historic_outcomes: the canonical production score (empty → 0).
    expect(signalOf(run, candidate.profile.id, "historic_outcomes").score).toBe(0);
    // safety: no active control.
    expect(signalOf(run, candidate.profile.id, "safety").score).toBe(100);
    // price: no ceiling declared → unconstrained (100).
    expect(signalOf(run, candidate.profile.id, "price").score).toBe(100);
    // availability: capacity 3 × 25 = 75.
    expect(signalOf(run, candidate.profile.id, "availability").score).toBe(75);
    // total = 24 + 6.7 + 0 + 10 + 10 + 7.5 = 58.2
    expect(run.results[0]!.totalScore).toBe(58.2);
  });

  test("the price signal is affordability headroom against the ceiling (cheapest qualifying rate)", async () => {
    const candidate = await createMatchCandidate(harness);
    // Fixture rate: short_video 750.5 USD per_deliverable.
    const atCeiling = await runMatch(harness, {
      requirements: {
        ...baselineRequirements(),
        requiredFormats: ["short_video"],
        rateCeiling: { amount: 750.5, currency: "USD", unit: "per_deliverable" },
      },
      candidateProfileIds: [candidate.profile.id],
      idempotencyKey: key("w016-ac02-price-0"),
    });
    expect(signalOf(atCeiling.run, candidate.profile.id, "price").score).toBe(0);

    const withHeadroom = await runMatch(harness, {
      requirements: {
        ...baselineRequirements(),
        requiredFormats: ["short_video"],
        rateCeiling: { amount: 1000, currency: "USD", unit: "per_deliverable" },
      },
      candidateProfileIds: [candidate.profile.id],
      idempotencyKey: key("w016-ac02-price-25"),
    });
    // headroom = 100 × (1000 − 750.5) / 1000 = 24.95 → 25.0
    expect(signalOf(withHeadroom.run, candidate.profile.id, "price").score).toBe(25);
    const price = signalOf(withHeadroom.run, candidate.profile.id, "price");
    expect(price.inputs.cheapestQualifyingRate).toBe(750.5);
    expect(price.inputs.rateCeiling).toEqual({
      amount: 1000,
      currency: "USD",
      unit: "per_deliverable",
    });
  });

  test("canonical reputation scores flow BIT-FOR-BIT from /reputation into the audience/production signals", async () => {
    // The DEFAULT harness creator has nonzero canonical snapshots
    // (one qualified contribution input per referenced dimension).
    const candidate = await createMatchCandidate(harness, {
      subjectPersonId: harness.creatorPersonId,
    });
    const references = candidate.version!.sections.reputationReferences;
    const audienceRef = references.find(
      (r) => r.role === "audience_influence",
    )!;
    const productionRef = references.find((r) => r.role === "production")!;

    const readScore = async (snapshotId: string, dimension: string) => {
      const snapshot = await harness.runtime.reputationSnapshotService.getSnapshot(
        harness.bootstrapCtx,
        snapshotId,
      );
      const score = snapshot.scores.find((s) => s.dimension === dimension);
      expect(score).toBeDefined();
      return score!.score;
    };
    const audienceScore = await readScore(
      audienceRef.snapshotId,
      audienceRef.dimension,
    );
    const productionScore = await readScore(
      productionRef.snapshotId,
      productionRef.dimension,
    );
    expect(audienceScore).toBeGreaterThan(0);
    expect(productionScore).toBeGreaterThan(0);

    const { run } = await runMatch(harness, {
      requirements: baselineRequirements(),
      candidateProfileIds: [candidate.profile.id],
      idempotencyKey: key("w016-ac02-canonical"),
    });
    const audience = signalOf(run, candidate.profile.id, "audience_quality");
    // engagement "high" = 66.7; blend 50/50 with the canonical score.
    expect(audience.score).toBe(
      round1(0.5 * 66.7 + 0.5 * audienceScore),
    );
    expect(audience.inputs.audienceInfluenceScore).toBe(audienceScore);
    expect(audience.inputs.audienceInfluenceSnapshotId).toBe(
      audienceRef.snapshotId,
    );
    const historic = signalOf(run, candidate.profile.id, "historic_outcomes");
    expect(historic.score).toBe(round1(productionScore));
    expect(historic.inputs.productionScore).toBe(productionScore);
    expect(historic.inputs.productionSnapshotId).toBe(productionRef.snapshotId);
    expect(historic.inputs.productionDimension).toBe(productionRef.dimension);
  });

  test("engagement band variation changes the audience_quality signal deterministically", async () => {
    const high = await createMatchCandidate(harness, { engagementBand: "high" });
    const veryHigh = await createMatchCandidate(harness, {
      engagementBand: "very_high",
    });
    const { run } = await runMatch(harness, {
      requirements: baselineRequirements(),
      candidateProfileIds: [high.profile.id, veryHigh.profile.id],
      idempotencyKey: key("w016-ac02-engagement"),
    });
    expect(signalOf(run, high.profile.id, "audience_quality").score).toBe(33.4);
    expect(signalOf(run, veryHigh.profile.id, "audience_quality").score).toBe(50);
  });

  test("ranking is totalScore DESC with the stable profileId ASC tie-break", async () => {
    const strong = await createMatchCandidate(harness, {
      engagementBand: "very_high",
      weeklyCapacity: 4,
    });
    const weak = await createMatchCandidate(harness);
    const { run } = await runMatch(harness, {
      requirements: baselineRequirements(),
      candidateProfileIds: [weak.profile.id, strong.profile.id],
      idempotencyKey: key("w016-ac02-order"),
    });
    expect(run.results).toHaveLength(2);
    expect(run.results[0]!.profileId).toBe(strong.profile.id);
    expect(run.results[0]!.rank).toBe(1);
    expect(run.results[1]!.profileId).toBe(weak.profile.id);
    expect(run.results[1]!.rank).toBe(2);
    expect(run.results[0]!.totalScore).toBeGreaterThan(
      run.results[1]!.totalScore,
    );

    // Tie-break: two identical fresh candidates score identically;
    // the deterministic total order is profileId ASC.
    const tieA = await createMatchCandidate(harness);
    const tieB = await createMatchCandidate(harness);
    const tieRun = await runMatch(harness, {
      requirements: baselineRequirements(),
      candidateProfileIds: [tieA.profile.id, tieB.profile.id],
      idempotencyKey: key("w016-ac02-tie"),
    });
    expect(tieRun.run.results[0]!.totalScore).toBe(
      tieRun.run.results[1]!.totalScore,
    );
    const ids = tieRun.run.results.map((r) => r.profileId);
    expect(ids).toEqual([...ids].sort());
    expect(tieRun.run.results.map((r) => r.rank)).toEqual([1, 2]);
  });

  test("custom weights are validated: integers 0–100 summing EXACTLY to 100", async () => {
    const candidate = await createMatchCandidate(harness);
    const input = {
      requirements: baselineRequirements(),
      candidateProfileIds: [candidate.profile.id],
    };
    await expect(
      runMatch(harness, {
        ...input,
        weights: { relevance: 30, audienceQuality: 20, historicOutcomes: 20, safety: 10, price: 10, availability: 9 },
        idempotencyKey: key("w016-ac02-w-sum"),
      }),
    ).rejects.toThrow(InvalidCreatorMatchError);
    await expect(
      runMatch(harness, {
        ...input,
        weights: { relevance: -1, audienceQuality: 21, historicOutcomes: 20, safety: 10, price: 10, availability: 10 },
        idempotencyKey: key("w016-ac02-w-neg"),
      }),
    ).rejects.toThrow(InvalidCreatorMatchError);
    await expect(
      runMatch(harness, {
        ...input,
        weights: { relevance: 30.5, audienceQuality: 19.5, historicOutcomes: 20, safety: 10, price: 10, availability: 10 },
        idempotencyKey: key("w016-ac02-w-frac"),
      }),
    ).rejects.toThrow(InvalidCreatorMatchError);

    // A valid custom profile changes the total deterministically:
    // everything on availability.
    const custom = await runMatch(harness, {
      ...input,
      weights: { relevance: 0, audienceQuality: 0, historicOutcomes: 0, safety: 0, price: 0, availability: 100 },
      idempotencyKey: key("w016-ac02-w-custom"),
    });
    expect(custom.run.results[0]!.totalScore).toBe(75);
    expect(custom.run.results[0]!.signals.map((s) => s.weight)).toEqual([0, 0, 0, 0, 0, 100]);
  });

  test("the relevance explanation names the deterministic inputs (coverage + territory alignment)", async () => {
    const candidate = await createMatchCandidate(harness, {
      topGeographies: [
        { territory: "GH", share: 40 },
        { territory: "NG", share: 25 },
      ],
    });
    // ELIGIBLE candidate: both required formats offered, both
    // required languages published (full coverage — partial coverage
    // would fail the hard gates); the territory ALIGNMENT is partial
    // (GH share 40; KE not reached but the intersection is non-empty).
    const { run } = await runMatch(harness, {
      requirements: {
        ...baselineRequirements(),
        requiredFormats: ["short_video", "article"],
        requiredLanguages: ["en", "fr"],
        targetTerritories: ["GH", "KE"],
      },
      candidateProfileIds: [candidate.profile.id],
      idempotencyKey: key("w016-ac02-relevance"),
    });
    const relevance = signalOf(run, candidate.profile.id, "relevance");
    expect(relevance.score).toBe(round1((100 + 100 + 40) / 3));
    expect(relevance.inputs.formatCoverage).toBe(100);
    expect(relevance.inputs.languageCoverage).toBe(100);
    expect(relevance.inputs.territoryAlignment).toBe(40);
    expect(relevance.inputs).not.toHaveProperty("advisoryScore");
  });

  test("ENGINE UNIT: partial format/language coverage scores by the documented fraction (pure engine, pre-gate)", async () => {
    // The pure engine scores ANY facts (gates are a separate pass —
    // partial coverage is exactly what makes a candidate
    // ineligible, so the fraction is proven at the engine contract
    // level).
    const candidate = await createMatchCandidate(harness, {
      topGeographies: [{ territory: "GH", share: 40 }],
    });
    const facts = {
      profile: candidate.profile,
      version: candidate.version,
      sections: candidate.version!.sections,
      reputation: {
        verified: true,
        failedRole: null,
        audienceInfluence: null,
        production: null,
      },
      safety: { held: false, controlId: null, action: null },
    };
    const { scoreCandidate } = await import(
      "../../src/creators/matching-engine.ts"
    );
    const signals = scoreCandidate(
      facts,
      {
        ...baselineRequirements(),
        requiredFormats: ["short_video", "post"],
        requiredLanguages: ["en", "de"],
        targetTerritories: ["GH", "KE"],
      },
      { relevance: 100, audienceQuality: 0, historicOutcomes: 0, safety: 0, price: 0, availability: 0 },
      null,
      0,
    );
    const relevance = signals.find((s) => s.signal === "relevance")!;
    // Coverage 50/50 (short_video + en offered; post + de not),
    // territory alignment 40 (GH only).
    expect(relevance.score).toBe(round1((50 + 50 + 40) / 3));
    expect(relevance.inputs.formatCoverage).toBe(50);
    expect(relevance.inputs.languageCoverage).toBe(50);
  });
});
