/**
 * NET-W021 AC-04 — Optimization is explainable and adversarially
 * safe (the optimization fixtures + adversarial tests).
 *
 * Proves: the OPTIMIZATION QUALITY fixture (evidence-backed
 * performers outrank unevidenced supply under identical hard
 * constraints — the definition of done); baseline and final
 * orderings with per-candidate rank deltas are recorded; advisory
 * influence is visible and bounded; adversarial inputs (huge raw
 * observations, still-maturing measurements, unevidenced credit)
 * never influence the ranking; the alreadyPlaced flag explains
 * existing supply; performance normalization is run-relative and
 * recorded.
 */

import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import {
  createNetW021Harness,
  createMatchCampaign,
  registerSupplyItem,
  createVerifiedItemOutcome,
  createOwnerReputationSnapshot,
  placeSupplyOnCampaign,
  runCampaignMatch,
  key,
  type NetW021Harness,
} from "./_net-w021-harness.ts";

let harness: NetW021Harness;

beforeAll(async () => {
  harness = await createNetW021Harness();
});

afterAll(async () => {
  await harness.teardown();
});

describe("NET-W021 AC-04: optimization is explainable and adversarially safe", () => {
  test("THE OPTIMIZATION FIXTURE: evidence-backed performers outrank unevidenced supply under identical constraints", async () => {
    // Three supply options, IDENTICAL hard-constraint shape (same
    // surface, format, territories, languages, verification) — the
    // ranking differentiators are ONLY the evidence-backed signals.
    const campaign = await createMatchCampaign(harness);
    const performer = await registerSupplyItem(harness, {
      actorPersonId: harness.operatorPersonId,
    });
    const established = await registerSupplyItem(harness, {
      actorPersonId: harness.operatorPersonId,
    });
    const ghost = await registerSupplyItem(harness, {
      actorPersonId: harness.operatorPersonId,
    });
    // The performer: the strongest verified view performance.
    await createVerifiedItemOutcome(harness, performer.id, {
      value: 100_000,
    });
    // The established option: a weaker verified performance.
    await createVerifiedItemOutcome(harness, established.id, {
      value: 20_000,
    });
    // The ghost: NO evidence of any kind.

    const { run } = await runCampaignMatch(harness, {
      campaignId: campaign.id,
      candidateInventoryItemIds: [performer.id, established.id, ghost.id],
      idempotencyKey: key("w021-ac04-fixture"),
    });
    // Definition of done: hard constraints first (all eligible),
    // then evidence-backed performance decides.
    expect(run.eligibleCount).toBe(3);
    expect(run.results.map((r) => r.inventoryItemId)).toEqual([
      performer.id,
      established.id,
      ghost.id,
    ]);
    expect(run.results[0]!.rank).toBe(1);
    expect(run.results[1]!.rank).toBe(2);
    expect(run.results[2]!.rank).toBe(3);
    // performance: 100 / 80 / 0 ((20000-10000... min-max over
    // {100000, 20000}: performer 100, established 0? No — min is
    // 20000 among HOLDERS only (ghost has no evidence), so
    // performer 100, established 0, ghost 0.
    const perf = (id: string) =>
      run.results.find((r) => r.inventoryItemId === id)!.signals.find(
        (s) => s.signal === "performance",
      )!;
    expect(perf(performer.id).baselineScore).toBe(100);
    expect(perf(established.id).baselineScore).toBe(0);
    expect(perf(ghost.id).baselineScore).toBe(0);
    // The established option still outranks the ghost through the
    // COVERAGE signal (evidence completeness, not magnitude).
    const coverage = (id: string) =>
      run.results.find((r) => r.inventoryItemId === id)!.signals.find(
        (s) => s.signal === "coverage",
      )!;
    expect(coverage(established.id).baselineScore).toBe(100);
    expect(coverage(ghost.id).baselineScore).toBe(0);
    // Totals: performer 65, established 35, ghost 25.
    expect(run.results.map((r) => r.totalScore)).toEqual([65, 35, 25]);
  });

  test("baseline and final orderings are both recorded with per-candidate rank deltas", async () => {
    const campaign = await createMatchCampaign(harness);
    const strong = await registerSupplyItem(harness, {
      actorPersonId: harness.operatorPersonId,
    });
    const weak = await registerSupplyItem(harness, {
      actorPersonId: harness.operatorPersonId,
    });
    // Baseline: weak outranks strong through verified performance.
    await createVerifiedItemOutcome(harness, weak.id, { value: 900 });
    // ...but the ADVISORY (echo, deterministic) may reorder them.
    const { run } = await runCampaignMatch(harness, {
      campaignId: campaign.id,
      candidateInventoryItemIds: [strong.id, weak.id],
      advisory: {
        matching: { enabled: true, maxWeight: 25 },
        risk: { enabled: true, maxWeight: 25 },
      },
      idempotencyKey: key("w021-ac04-deltas"),
    });
    // Every result carries BOTH orderings.
    for (const result of run.results) {
      expect(result.rank).toBeGreaterThan(0);
      expect(result.baselineRank).toBeGreaterThan(0);
      expect(result.totalScore).toBeGreaterThan(0);
      expect(result.baselineTotalScore).toBeGreaterThan(0);
      // Signals carry baseline scores alongside final scores.
      for (const s of result.signals) {
        expect(s.baselineScore).toBeGreaterThanOrEqual(0);
        expect(s.score).toBeGreaterThanOrEqual(0);
        expect(s.weight).toBeGreaterThan(0);
      }
    }
    // The baseline ranking places the evidenced option first.
    const byBaseline = [...run.results].sort(
      (a, b) => a.baselineRank - b.baselineRank,
    );
    expect(byBaseline[0]!.inventoryItemId).toBe(weak.id);
    expect(byBaseline[0]!.baselineTotalScore).toBe(65);
    expect(byBaseline[0]!.totalScore).not.toBe(byBaseline[0]!.baselineTotalScore);
    // Advisory-off re-run: the orderings coincide bit-for-bit with
    // the recorded baseline (pure-deterministic re-derivation).
    const { run: baselineRun } = await runCampaignMatch(harness, {
      campaignId: campaign.id,
      candidateInventoryItemIds: [strong.id, weak.id],
      idempotencyKey: key("w021-ac04-baseline"),
    });
    expect(baselineRun.results.map((r) => r.rank)).toEqual(
      baselineRun.results.map((r) => r.baselineRank),
    );
    expect(baselineRun.results.map((r) => r.inventoryItemId)).toEqual(
      byBaseline.map((r) => r.inventoryItemId),
    );
  });

  test("ADVERSARIAL: a billion-value raw observation cannot buy ranking without VERIFIED evidence", async () => {
    const campaign = await createMatchCampaign(harness);
    const honest = await registerSupplyItem(harness, {
      actorPersonId: harness.operatorPersonId,
    });
    const adversarial = await registerSupplyItem(harness, {
      actorPersonId: harness.operatorPersonId,
    });
    // The adversarial supply carries a RAW (unmeasured) observation
    // of absurd magnitude + a still-MEASURING measurement.
    await createVerifiedItemOutcome(harness, adversarial.id, {
      value: 1_000_000_000,
      observationOnly: true,
    });
    await createVerifiedItemOutcome(harness, adversarial.id, {
      value: 999_999_999,
      leaveMeasuring: true,
    });
    await createVerifiedItemOutcome(harness, honest.id, { value: 1 });

    const { run } = await runCampaignMatch(harness, {
      campaignId: campaign.id,
      candidateInventoryItemIds: [honest.id, adversarial.id],
      idempotencyKey: key("w021-ac04-adversarial"),
    });
    const honestResult = run.results.find(
      (r) => r.inventoryItemId === honest.id,
    )!;
    const adversarialResult = run.results.find(
      (r) => r.inventoryItemId === adversarial.id,
    )!;
    expect(honestResult.rank).toBe(1);
    expect(
      honestResult.signals.find((s) => s.signal === "performance")!
        .baselineScore,
    ).toBe(100);
    expect(
      adversarialResult.signals.find((s) => s.signal === "performance")!
        .baselineScore,
    ).toBe(0);
    expect(
      adversarialResult.signals.find((s) => s.signal === "coverage")!
        .baselineScore,
    ).toBe(0);
  });

  test("ADVERSARIAL: no unevidenced standing credit — reputation must resolve through the canonical authority", async () => {
    const campaign = await createMatchCampaign(harness);
    const evidenced = await registerSupplyItem(harness, {
      actorPersonId: harness.creatorPersonId,
    });
    const unknown = await registerSupplyItem(harness, {
      actorPersonId: harness.operatorPersonId,
    });
    // Only the EVIDENCED owner carries a canonical snapshot.
    await createOwnerReputationSnapshot(harness, {
      subjectPersonId: harness.creatorPersonId,
      dimension: "inventory_quality",
      qualifiedInput: true,
    });
    const { run } = await runCampaignMatch(harness, {
      campaignId: campaign.id,
      candidateInventoryItemIds: [evidenced.id, unknown.id],
      idempotencyKey: key("w021-ac04-standing"),
    });
    const evidencedStanding = run.results.find(
      (r) => r.inventoryItemId === evidenced.id,
    )!.signals.find((s) => s.signal === "standing")!;
    const unknownStanding = run.results.find(
      (r) => r.inventoryItemId === unknown.id,
    )!.signals.find((s) => s.signal === "standing")!;
    expect(evidencedStanding.baselineScore).toBe(0.2);
    expect(evidencedStanding.inputs).toMatchObject({ snapshotId: expect.any(String) });
    expect(unknownStanding.baselineScore).toBe(0);
    expect(unknownStanding.inputs).toMatchObject({ snapshotId: null });
  });

  test("the alreadyPlaced flag explains existing supply (no score effect)", async () => {
    const campaign = await createCampaignAndPlacement();
    async function createCampaignAndPlacement() {
      const c = await createMatchCampaign(harness);
      const placed = await registerSupplyItem(harness, {});
      const fresh = await registerSupplyItem(harness, {
        actorPersonId: harness.operatorPersonId,
      });
      await placeSupplyOnCampaign(harness, placed.id, c.id);
      return { c, placed, fresh };
    }
    const { c, placed, fresh } = await createCampaignAndPlacement();
    const { run } = await runCampaignMatch(harness, {
      campaignId: c.id,
      candidateInventoryItemIds: [placed.id, fresh.id],
      idempotencyKey: key("w021-ac04-placed"),
    });
    const placedResult = run.results.find(
      (r) => r.inventoryItemId === placed.id,
    )!;
    const freshResult = run.results.find(
      (r) => r.inventoryItemId === fresh.id,
    )!;
    expect(placedResult.alreadyPlaced).toBe(true);
    expect(freshResult.alreadyPlaced).toBe(false);
    // The flag is explainability ONLY — identical supply scores
    // identically (the digest carries it, the score does not).
    expect(placedResult.totalScore).toBe(freshResult.totalScore);
  });

  test("performance normalization is run-relative with bounds recorded (deterministic per run)", async () => {
    const campaign = await createMatchCampaign(harness);
    const a = await registerSupplyItem(harness, {
      actorPersonId: harness.operatorPersonId,
    });
    const b = await registerSupplyItem(harness, {
      actorPersonId: harness.operatorPersonId,
    });
    await createVerifiedItemOutcome(harness, a.id, { value: 100 });
    await createVerifiedItemOutcome(harness, b.id, { value: 300 });
    // Run 1: {a:100, b:300} → b 100, a 0.
    const run1 = await runCampaignMatch(harness, {
      campaignId: campaign.id,
      candidateInventoryItemIds: [a.id, b.id],
      idempotencyKey: key("w021-ac04-relative1"),
    });
    const score1 = (id: string) =>
      run1.run.results.find((r) => r.inventoryItemId === id)!.signals.find(
        (s) => s.signal === "performance",
      )!;
    expect(score1(b.id).baselineScore).toBe(100);
    expect(score1(a.id).baselineScore).toBe(0);
    // Run 2: only b → min==max → 100 (sole holder).
    const run2 = await runCampaignMatch(harness, {
      campaignId: campaign.id,
      candidateInventoryItemIds: [b.id],
      idempotencyKey: key("w021-ac04-relative2"),
    });
    expect(
      run2.run.results[0]!.signals.find((s) => s.signal === "performance")!
        .baselineScore,
    ).toBe(100);
    // Run 3: only a → sole holder → 100 (relative within the run).
    const run3 = await runCampaignMatch(harness, {
      campaignId: campaign.id,
      candidateInventoryItemIds: [a.id],
      idempotencyKey: key("w021-ac04-relative3"),
    });
    expect(
      run3.run.results[0]!.signals.find((s) => s.signal === "performance")!
        .baselineScore,
    ).toBe(100);
    // Each run records its own bounds (reproducible explanation).
    expect(score1(a.id).inputs.perType).toEqual([
      {
        outcomeType: "view",
        evidence: {
          measuredOutcomeId: expect.any(String),
          value: 100,
          unit: "views",
          confidencePoint: 0.95,
        },
        runMin: 100,
        runMax: 300,
        typeScore: 0,
      },
    ]);
  });
});
