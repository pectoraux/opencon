/**
 * NET-W021 AC-02 — Evidence-backed ranking.
 *
 * Proves: only eligible options are ranked; the six explicit signals
 * carry exact deterministic scores; weights are validated (sum 100);
 * the ordering is a deterministic total order (score DESC, then
 * stable id ASC); per-signal machine-readable explanations name the
 * inputs used; ONLY lifecycle-VERIFIED measured outcomes count as
 * performance evidence; reputation evidence bases are digest-pinned.
 */

import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import {
  createNetW021Harness,
  createMatchCampaign,
  registerSupplyItem,
  createVerifiedItemOutcome,
  createOwnerReputationSnapshot,
  runCampaignMatch,
  key,
  type NetW021Harness,
} from "./_net-w021-harness.ts";
import {
  InvalidCampaignMatchError,
  CAMPAIGN_MATCH_DEFAULT_WEIGHTS,
  CAMPAIGN_MATCH_FORMAT,
} from "../../src/core/campaigns.ts";

let harness: NetW021Harness;

beforeAll(async () => {
  harness = await createNetW021Harness();
});

afterAll(async () => {
  await harness.teardown();
});

describe("NET-W021 AC-02: evidence-backed ranking", () => {
  test("the six signals with exact deterministic scores (the performer/ghost fixture)", async () => {
    // The campaign demands `view` performance evidence.
    const campaign = await createMatchCampaign(harness);
    // The performer: verified 50k views; owner carries a qualified
    // inventory_quality snapshot (score 0.248082 → 0.2 at 1 decimal).
    const performer = await registerSupplyItem(harness, {});
    await createVerifiedItemOutcome(harness, performer.id, { value: 50_000 });
    await createOwnerReputationSnapshot(harness, {
      subjectPersonId: harness.creatorPersonId,
      dimension: "inventory_quality",
      qualifiedInput: true,
    });
    // The ghost: same shape, NO evidence, NO snapshots.
    const ghost = await registerSupplyItem(harness, {
      actorPersonId: harness.operatorPersonId,
    });

    const { run } = await runCampaignMatch(harness, {
      campaignId: campaign.id,
      candidateInventoryItemIds: [performer.id, ghost.id],
      idempotencyKey: key("w021-ac02-scores"),
    });

    expect(run.candidateCount).toBe(2);
    expect(run.eligibleCount).toBe(2);
    expect(run.formatVersion).toBe(CAMPAIGN_MATCH_FORMAT);
    expect(run.requiredOutcomeTypes).toEqual(["view"]);
    expect(run.weights).toEqual(CAMPAIGN_MATCH_DEFAULT_WEIGHTS);

    const top = run.results[0]!;
    expect(top.inventoryItemId).toBe(performer.id);
    expect(top.rank).toBe(1);
    expect(top.baselineRank).toBe(1);
    // Signals (baseline = final; advisory off):
    //   alignment 100 (no targeting declared), performance 100 (the
    //   sole evidence holder), standing 0.2 (qualified snapshot),
    //   reliability 0 (no snapshot), risk 0 (no snapshot),
    //   coverage 100 (view covered).
    const signalScore = (name: string) =>
      top.signals.find((s) => s.signal === name)!;
    expect(signalScore("alignment").baselineScore).toBe(100);
    expect(signalScore("performance").baselineScore).toBe(100);
    expect(signalScore("standing").baselineScore).toBe(0.2);
    expect(signalScore("reliability").baselineScore).toBe(0);
    expect(signalScore("risk").baselineScore).toBe(0);
    expect(signalScore("coverage").baselineScore).toBe(100);
    // total = 25 + 30 + round1(0.2*15/100)=0 + 0 + 0 + 10 = 65
    expect(top.totalScore).toBe(65);
    expect(top.baselineTotalScore).toBe(65);

    const bottom = run.results[1]!;
    expect(bottom.inventoryItemId).toBe(ghost.id);
    expect(bottom.totalScore).toBe(25);
    const ghostPerformance = bottom.signals.find(
      (s) => s.signal === "performance",
    )!;
    expect(ghostPerformance.baselineScore).toBe(0);
    // No evidence → the recorded per-type entry is null evidence.
    const perType = ghostPerformance.inputs.perType as readonly {
      outcomeType: string;
      evidence: unknown;
      typeScore: number;
    }[];
    expect(perType).toEqual([
      { outcomeType: "view", evidence: null, typeScore: 0 },
    ]);
  });

  test("the standing signal pins the canonical snapshot evidence base (id + digest)", async () => {
    const campaign = await createMatchCampaign(harness);
    const item = await registerSupplyItem(harness, {});
    const snapshot = await createOwnerReputationSnapshot(harness, {
      subjectPersonId: harness.creatorPersonId,
      dimension: "inventory_quality",
      qualifiedInput: true,
    });
    const { run } = await runCampaignMatch(harness, {
      campaignId: campaign.id,
      candidateInventoryItemIds: [item.id],
      idempotencyKey: key("w021-ac02-standing"),
    });
    const standing = run.results[0]!.signals.find(
      (s) => s.signal === "standing",
    )!;
    expect(standing.inputs).toMatchObject({
      dimension: "inventory_quality",
      snapshotId: snapshot.id,
      digest: snapshot.digest,
      score: snapshot.scores.find((s) => s.dimension === "inventory_quality")!
        .score,
    });
  });

  test("ONLY lifecycle-VERIFIED measured outcomes count (DRAFT/MEASURING/raw observations never influence)", async () => {
    const campaign = await createMatchCampaign(harness);
    const performer = await registerSupplyItem(harness, {
      actorPersonId: harness.operatorPersonId,
    });
    const ghost = await registerSupplyItem(harness, {
      actorPersonId: harness.operatorPersonId,
    });
    // Adversarial: a HUGE raw observation (no measurement) and a
    // still-maturing measurement on the GHOST item — never evidence.
    await createVerifiedItemOutcome(harness, ghost.id, {
      value: 1_000_000_000,
      observationOnly: true,
    });
    await createVerifiedItemOutcome(harness, ghost.id, {
      value: 900_000_000,
      leaveMeasuring: true,
    });
    // The performer's modest VERIFIED outcome wins.
    await createVerifiedItemOutcome(harness, performer.id, { value: 10 });

    const { run } = await runCampaignMatch(harness, {
      campaignId: campaign.id,
      candidateInventoryItemIds: [performer.id, ghost.id],
      idempotencyKey: key("w021-ac02-verified-only"),
    });
    const performerResult = run.results.find(
      (r) => r.inventoryItemId === performer.id,
    )!;
    const ghostResult = run.results.find(
      (r) => r.inventoryItemId === ghost.id,
    )!;
    expect(
      performerResult.signals.find((s) => s.signal === "performance")!
        .baselineScore,
    ).toBe(100);
    expect(
      ghostResult.signals.find((s) => s.signal === "performance")!
        .baselineScore,
    ).toBe(0);
    expect(
      ghostResult.signals.find((s) => s.signal === "coverage")!
        .baselineScore,
    ).toBe(0);
    expect(performerResult.rank).toBe(1);
    expect(ghostResult.rank).toBe(2);
  });

  test("performance is min-max relative per required outcome type (values + bounds recorded)", async () => {
    const campaign = await createMatchCampaign(harness);
    const high = await registerSupplyItem(harness, {
      actorPersonId: harness.operatorPersonId,
    });
    const mid = await registerSupplyItem(harness, {
      actorPersonId: harness.operatorPersonId,
    });
    const low = await registerSupplyItem(harness, {
      actorPersonId: harness.operatorPersonId,
    });
    await createVerifiedItemOutcome(harness, high.id, { value: 50_000 });
    await createVerifiedItemOutcome(harness, mid.id, { value: 30_000 });
    await createVerifiedItemOutcome(harness, low.id, { value: 10_000 });

    const { run } = await runCampaignMatch(harness, {
      campaignId: campaign.id,
      candidateInventoryItemIds: [high.id, mid.id, low.id],
      idempotencyKey: key("w021-ac02-minmax"),
    });
    const scoreOf = (itemId: string) =>
      run.results.find((r) => r.inventoryItemId === itemId)!.signals.find(
        (s) => s.signal === "performance",
      )!;
    expect(scoreOf(high.id).baselineScore).toBe(100);
    expect(scoreOf(mid.id).baselineScore).toBe(50);
    expect(scoreOf(low.id).baselineScore).toBe(0);
    // The explanation records the raw evidence value + run bounds.
    expect(scoreOf(mid.id).inputs.perType).toEqual([
      {
        outcomeType: "view",
        evidence: {
          measuredOutcomeId: expect.any(String),
          value: 30_000,
          unit: "views",
          confidencePoint: 0.95,
        },
        runMin: 10_000,
        runMax: 50_000,
        typeScore: 50,
      },
    ]);
  });

  test("alignment measures territory + language overlap depth (exact)", async () => {
    const campaign = await createMatchCampaign(harness);
    const full = await registerSupplyItem(harness, {
      actorPersonId: harness.operatorPersonId,
      territories: ["US", "CA", "GH"],
      languages: ["en", "fr"],
    });
    const partial = await registerSupplyItem(harness, {
      actorPersonId: harness.operatorPersonId,
      territories: ["US"],
      languages: ["en"],
    });
    const { run } = await runCampaignMatch(harness, {
      campaignId: campaign.id,
      targeting: {
        targetTerritories: ["US", "CA", "GH"],
        requiredLanguages: ["en", "fr"],
      },
      candidateInventoryItemIds: [full.id, partial.id],
      idempotencyKey: key("w021-ac02-alignment"),
    });
    const fullAlignment = run.results.find(
      (r) => r.inventoryItemId === full.id,
    )!.signals.find((s) => s.signal === "alignment")!;
    expect(fullAlignment.baselineScore).toBe(100);
    const partialAlignment = run.results.find(
      (r) => r.inventoryItemId === partial.id,
    )!.signals.find((s) => s.signal === "alignment")!;
    // territory 1/3 + language 1/2 → (33.3 + 50)/2 = 41.7
    expect(partialAlignment.baselineScore).toBe(41.7);
    expect(partialAlignment.inputs).toMatchObject({
      territoryAlignment: 33.3,
      languageAlignment: 50,
    });
  });

  test("coverage: multiple required outcome types (2 declared, 1 covered → 50)", async () => {
    const campaign = await createMatchCampaign(harness, {
      outcomeRequirements: [
        {
          objectiveId: "obj-1",
          outcomeType: "view",
          attributionMode: "deterministic",
          windowDays: 30,
          requiresExperiment: false,
        },
        {
          objectiveId: "obj-1",
          outcomeType: "engagement",
          attributionMode: "deterministic",
          windowDays: 30,
          requiresExperiment: false,
        },
      ],
    });
    expect((await import("../../src/core/evidence.ts")).isStandardOutcomeType("engagement")).toBe(true);
    const item = await registerSupplyItem(harness, {});
    // Only `view` verified for this item.
    await createVerifiedItemOutcome(harness, item.id, {
      outcomeType: "view",
      value: 100,
    });
    const { run } = await runCampaignMatch(harness, {
      campaignId: campaign.id,
      candidateInventoryItemIds: [item.id],
      idempotencyKey: key("w021-ac02-coverage"),
    });
    expect(run.requiredOutcomeTypes).toEqual(["engagement", "view"]);
    const coverage = run.results[0]!.signals.find(
      (s) => s.signal === "coverage",
    )!;
    expect(coverage.baselineScore).toBe(50);
    expect(coverage.inputs).toMatchObject({
      coveredTypes: ["view"],
    });
  });

  test("deterministic total order: score DESC, then inventoryItemId ASC", async () => {
    const campaign = await createMatchCampaign(harness);
    const a = await registerSupplyItem(harness, {
      actorPersonId: harness.operatorPersonId,
    });
    const b = await registerSupplyItem(harness, {
      actorPersonId: harness.operatorPersonId,
    });
    // Identical facts → identical scores → the tie breaks by id ASC.
    const { run } = await runCampaignMatch(harness, {
      campaignId: campaign.id,
      candidateInventoryItemIds: [a.id, b.id],
      idempotencyKey: key("w021-ac02-order"),
    });
    expect(run.results.map((r) => r.totalScore)).toEqual([25, 25]);
    const ids = [a.id, b.id].sort();
    expect(run.results.map((r) => r.inventoryItemId)).toEqual(ids);
    expect(run.results.map((r) => r.rank)).toEqual([1, 2]);
  });

  test("weights are validated (sum exactly 100; integers 0..100)", async () => {
    const campaign = await createMatchCampaign(harness);
    const item = await registerSupplyItem(harness, {});
    const bad = [
      { alignment: 25, performance: 30, standing: 15, reliability: 10, risk: 10, coverage: 11 },
      { alignment: 25.5, performance: 30, standing: 15, reliability: 10, risk: 10, coverage: 9.5 },
      { alignment: -1, performance: 31, standing: 15, reliability: 10, risk: 10, coverage: 10 },
    ];
    for (const weights of bad) {
      await expect(
        runCampaignMatch(harness, {
          campaignId: campaign.id,
          weights,
          candidateInventoryItemIds: [item.id],
          idempotencyKey: key("w021-ac02-weights"),
        }),
      ).rejects.toBeInstanceOf(InvalidCampaignMatchError);
    }
    // The canonical default profile sums to 100.
    const sum = Object.values(CAMPAIGN_MATCH_DEFAULT_WEIGHTS).reduce(
      (a, b) => a + b,
      0,
    );
    expect(sum).toBe(100);
  });

  test("explicit targeting vocabulary is validated (formats/surface kinds closed)", async () => {
    const campaign = await createMatchCampaign(harness);
    const item = await registerSupplyItem(harness, {});
    await expect(
      runCampaignMatch(harness, {
        campaignId: campaign.id,
        targeting: { requiredFormats: ["billboard"] },
        candidateInventoryItemIds: [item.id],
        idempotencyKey: key("w021-ac02-vocab"),
      }),
    ).rejects.toBeInstanceOf(InvalidCampaignMatchError);
    await expect(
      runCampaignMatch(harness, {
        campaignId: campaign.id,
        targeting: { requiredSurfaceKinds: ["podcast"] },
        candidateInventoryItemIds: [item.id],
        idempotencyKey: key("w021-ac02-vocab2"),
      }),
    ).rejects.toBeInstanceOf(InvalidCampaignMatchError);
    await expect(
      runCampaignMatch(harness, {
        campaignId: campaign.id,
        targeting: { targetTerritories: ["usa"] },
        candidateInventoryItemIds: [item.id],
        idempotencyKey: key("w021-ac02-vocab3"),
      }),
    ).rejects.toBeInstanceOf(InvalidCampaignMatchError);
  });
});
