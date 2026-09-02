/**
 * NET-W034-AC-03 — Matching/selection integrity (issue #69 §5 AC-03).
 *
 * The existing W021 matching path selects only candidates that pass
 * hard campaign, policy, supply and risk gates. Ranking remains
 * deterministic after hard gates, and any AI advisory is bounded,
 * recorded and demonstrably non-authoritative.
 *  - the hard-gate exclusion (an UNVERIFIED candidate is excluded
 *    with a closed-vocabulary reason — never ranked);
 *  - only eligible candidates are ranked (the eligible result set);
 *  - the deterministic ranking digest (same facts ⇒ same digest);
 *  - the advisory is bounded + recorded + non-authoritative (the
 *    blend is capped; the baseline ordering is preserved);
 *  - matching itself creates NO placement or economic mutation
 *    (before/after state comparison — the W021 AC-05 pattern);
 *  - an ineligible-candidate hard gate (wrong-territory supply is
 *    excluded by the eligibility rules).
 */

import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import {
  createNetW034Harness,
  runAdvertisingScenario,
  createAdvertisingCampaign,
  registerScenarioSupply,
  runScenarioMatch,
  key,
  type NetW034Harness,
  type AdvertisingScenario,
} from "./_net-w034-harness.ts";

let harness: NetW034Harness;
let scenario: AdvertisingScenario;

beforeAll(async () => {
  harness = await createNetW034Harness();
  scenario = await runAdvertisingScenario(harness, { skipSettlement: true });
});

afterAll(async () => {
  await harness.teardown();
});

describe("NET-W034-AC-03 matching/selection integrity", () => {
  test("the scenario match run: the eligible supply is SELECTED and the unverified supply is hard-EXCLUDED (closed vocabulary)", async () => {
    const ctx = harness.operatorCtx("w034-ac03-read");
    // The scenario run is durable: read through the list (the
    // authoritative record).
    const runs = await harness.runtime.campaignMatchingService.listMatchRuns(
      ctx,
      harness.organizationScopeId,
    );
    const scenarioRun = runs.find((r) => r.id === scenario.matchRunId);
    expect(scenarioRun).toBeDefined();
    expect(scenarioRun!.campaign.campaignId).toBe(scenario.campaignId);
    expect(scenarioRun!.campaign.policyVersion).toBe(
      scenario.campaignPolicyVersion,
    );
    // ONLY eligible candidates are ranked: the eligible item, at
    // rank 1 (the sole ranked candidate).
    expect(scenarioRun!.results.map((r) => r.inventoryItemId)).toEqual([
      scenario.selectedItemId,
    ]);
    expect(scenarioRun!.results[0]!.rank).toBe(1);
    expect(scenarioRun!.results[0]!.inventoryItemId).toBe(
      scenario.inventoryItemId,
    );
    // The unverified candidate is EXCLUDED with closed-vocabulary
    // reasons (never ranked, never selected).
    const excluded = scenarioRun!.excluded.find(
      (e) => e.inventoryItemId === scenario.excludedItemId,
    );
    expect(excluded).toBeDefined();
    expect(excluded!.failedReasons).toContain("supply_not_verified");
    expect(scenarioRun!.eligibleCount).toBe(1);
    expect(scenarioRun!.candidateCount).toBe(2);
  });

  test("an INELIGIBLE-territory supply is hard-excluded by the campaign eligibility rules", async () => {
    // Supply registered outside the campaign's region rule — the
    // eligibility gate excludes it even though it IS verified.
    const offTerritory = await registerScenarioSupply(harness, {
      territories: ["NG"],
      externalId: `offregion-${key("ext")}`,
    });
    const { run } = await runScenarioMatch(harness, {
      campaignId: scenario.campaignId,
      candidateInventoryItemIds: [offTerritory.id],
      idempotencyKey: key("w034-ac03-ineligible"),
    });
    expect(run.results).toHaveLength(0);
    expect(run.excluded).toHaveLength(1);
    expect(run.excluded[0]!.inventoryItemId).toBe(offTerritory.id);
    expect(
      run.excluded[0]!.failedReasons.includes("eligibility_rules_not_satisfied"),
    ).toBe(true);
  });

  test("the ranking digest is DETERMINISTIC (identical facts ⇒ identical digest)", async () => {
    const first = await runScenarioMatch(harness, {
      campaignId: scenario.campaignId,
      candidateInventoryItemIds: [scenario.inventoryItemId],
      idempotencyKey: key("w034-ac03-det-1"),
    });
    const second = await runScenarioMatch(harness, {
      campaignId: scenario.campaignId,
      candidateInventoryItemIds: [scenario.inventoryItemId],
      idempotencyKey: key("w034-ac03-det-2"),
    });
    expect(second.run.id).not.toBe(first.run.id);
    // Same facts, different runs: the digest (the pinned decision
    // fingerprint) is identical.
    expect(second.run.digest).toBe(first.run.digest);
    // The ranked ordering is identical.
    expect(second.run.results.map((r) => r.inventoryItemId)).toEqual(
      first.run.results.map((r) => r.inventoryItemId),
    );
  });

  test("the advisory is bounded, recorded and NON-AUTHORITATIVE", async () => {
    // An explicitly-bounded advisory request: the matching advisory
    // capped at a max weight (the only knobs the caller controls).
    const { run } = await runScenarioMatch(harness, {
      campaignId: scenario.campaignId,
      candidateInventoryItemIds: [scenario.inventoryItemId],
      idempotencyKey: key("w034-ac03-advisory"),
      advisory: {
        matching: { enabled: true, maxWeight: 0.25 },
        risk: { enabled: false },
      },
    });
    // The advisory configuration is RECORDED on the run (the
    // record-of-decision contract).
    expect(run.advisory.config.matching.enabled).toBe(true);
    expect(run.advisory.config.matching.maxWeight).toBe(0.25);
    expect(run.advisory.config.risk.enabled).toBe(false);
    // The advisory summary is bounded: the blend NEVER exceeds the
    // capped max weight.
    expect(run.advisory.matching.blend).toBeLessThanOrEqual(0.25);
    // The ELIGIBILITY is untouched by the advisory: the same single
    // eligible candidate, the same rank — the advisory NEVER
    // overrides the hard gates (AI is selection input, not
    // authority).
    expect(run.results.map((r) => r.inventoryItemId)).toEqual([
      scenario.inventoryItemId,
    ]);
    expect(run.excluded.map((e) => e.inventoryItemId)).toEqual([]);
    // Every ranked candidate carries its own advisory assessment
    // identity (never a run-level projection).
    for (const result of run.results) {
      if (result.advisory.matching !== null) {
        expect(typeof result.advisory.matching.provider).toBe("string");
      }
    }
  });

  test("matching performs NO placement or economic mutation (before/after)", async () => {
    const audit = harness.runtime.auditWriter;
    const ctx = harness.operatorCtx("w034-ac03-state");
    const before = {
      placements: (
        await harness.runtime.inventoryService.listPlacements(
          ctx,
          harness.organizationScopeId,
          {},
        )
      ).length,
      items: (
        await harness.runtime.inventoryService.listInventoryItems(
          ctx,
          harness.organizationScopeId,
        )
      ).length,
      placementEvents: (await audit.query({ eventType: "placement.recorded" }))
        .length,
      valueEvents: (await audit.query({ eventType: "economic_value.recorded" }))
        .length,
      clearingEvents: (
        await audit.query({ eventType: "cross_promotion_clearing.recorded" })
      ).length,
    };
    await runScenarioMatch(harness, {
      campaignId: scenario.campaignId,
      candidateInventoryItemIds: [scenario.inventoryItemId],
      idempotencyKey: key("w034-ac03-no-mutation"),
    });
    const after = {
      placements: (
        await harness.runtime.inventoryService.listPlacements(
          ctx,
          harness.organizationScopeId,
          {},
        )
      ).length,
      items: (
        await harness.runtime.inventoryService.listInventoryItems(
          ctx,
          harness.organizationScopeId,
        )
      ).length,
      placementEvents: (await audit.query({ eventType: "placement.recorded" }))
        .length,
      valueEvents: (await audit.query({ eventType: "economic_value.recorded" }))
        .length,
      clearingEvents: (
        await audit.query({ eventType: "cross_promotion_clearing.recorded" })
      ).length,
    };
    // Selection is not authority: NO new items, placements, values or
    // clearings — the ONLY durable effect is the append-only run
    // record itself.
    expect(after).toEqual(before);
  });

  test("the match run's own lineage is complete and its record-of-decision is audited", async () => {
    const audit = harness.runtime.auditWriter;
    const events = await audit.query({
      eventType: "campaign_match.recorded",
      resourceId: scenario.matchRunId,
    });
    expect(events).toHaveLength(1);
    expect(typeof events[0]!.metadata?.transactionId).toBe("string");
    expect(events[0]!.metadata?.digest).toBe(
      (await harness.runtime.campaignMatchingService.listMatchRuns(
        harness.operatorCtx("w034-ac03-digest"),
        harness.organizationScopeId,
      )).find((r) => r.id === scenario.matchRunId)!.digest,
    );
  });

  test("same-key replay of a match run returns the COMMITTED run (created=false)", async () => {
    const idempotencyKey = key("w034-ac03-replay");
    const first = await runScenarioMatch(harness, {
      campaignId: scenario.campaignId,
      candidateInventoryItemIds: [scenario.inventoryItemId],
      idempotencyKey,
    });
    expect(first.created).toBe(true);
    const replay = await runScenarioMatch(harness, {
      campaignId: scenario.campaignId,
      candidateInventoryItemIds: [scenario.inventoryItemId],
      idempotencyKey,
    });
    expect(replay.created).toBe(false);
    expect(replay.run.id).toBe(first.run.id);
    expect(replay.run.digest).toBe(first.run.digest);
  });

  test("a NEW campaign with the SAME policy produces the same selection shape (the reusable fixture)", async () => {
    // A second identical campaign (fresh reward policy lineage) — the
    // match path composes identically against the same supply.
    const { campaign } = await createAdvertisingCampaign(harness);
    const { run } = await runScenarioMatch(harness, {
      campaignId: campaign.id,
      candidateInventoryItemIds: [scenario.inventoryItemId],
      idempotencyKey: key("w034-ac03-second"),
    });
    expect(run.results.map((r) => r.inventoryItemId)).toEqual([
      scenario.inventoryItemId,
    ]);
    expect(run.results[0]!.rank).toBe(1);
  });
});
