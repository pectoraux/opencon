/**
 * NET-W021 AC-01 — Deterministic hard eligibility gates.
 *
 * Proves: every hard gate fails with its closed-vocabulary reason;
 * conjunction semantics (all applicable gates evaluated, complete
 * traces); the run-level CAMP-002 constraints fail closed; identical
 * inputs yield identical verdicts; ineligible options are NEVER
 * ranked (regardless of advisory).
 */

import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import {
  createNetW021Harness,
  createMatchCampaign,
  registerSupplyItem,
  runCampaignMatch,
  key,
  operatorCtx,
  type NetW021Harness,
} from "./_net-w021-harness.ts";
import { evaluateEligibility } from "../../src/campaigns/matching-engine.ts";
import type { CampaignMatchCandidateFacts } from "../../src/campaigns/matching-engine.ts";
import type { CampaignMatchInventoryItemView } from "../../src/campaigns/port.ts";
import { InvalidCampaignMatchError } from "../../src/core/campaigns.ts";
import { NotFoundError } from "../../src/core/errors.ts";

let harness: NetW021Harness;

beforeAll(async () => {
  harness = await createNetW021Harness();
});

afterAll(async () => {
  await harness.teardown();
});

// ---------------------------------------------------------------------------
// Engine-level: closed vocabulary, conjunction, complete traces
// ---------------------------------------------------------------------------

function factsFor(overrides: {
  surfaceKind?: string;
  format?: string;
  territories?: readonly string[];
  languages?: readonly string[];
  verified?: boolean;
  retired?: boolean;
  held?: boolean;
  rulesSatisfied?: boolean;
}): CampaignMatchCandidateFacts {
  const item: CampaignMatchInventoryItemView = {
    id: "item-1",
    organizationScopeId: "org-1",
    ownerPersonId: "person-1",
    surfaceKind: overrides.surfaceKind ?? "publisher",
    format: overrides.format ?? "display",
    territories: [...(overrides.territories ?? ["US", "CA"])],
    languages: [...(overrides.languages ?? ["en"])],
    verificationEvidenceReference:
      overrides.verified === false ? null : "evidence-1",
    retiredAt: overrides.retired === true ? "2026-01-01T00:00:00.000Z" : null,
  };
  return {
    item,
    eligibility: {
      eligible: overrides.rulesSatisfied !== false,
      evaluatedAt: "2026-01-01T00:00:00.000Z",
      ruleResults:
        overrides.rulesSatisfied === false
          ? [
              {
                attribute: "region",
                operator: "in",
                values: ["GH"],
                satisfied: false,
                reason: "offered_value_outside_rule",
              },
            ]
          : [],
    },
    reputation: { standing: null, reliability: null, fraudResistance: null },
    safety: overrides.held === true
      ? { held: true, controlId: "control-1", action: "HOLD" }
      : { held: false, controlId: null, action: null },
    outcomeEvidence: [],
  };
}

const permissiveTargeting = {
  requiredFormats: [],
  requiredSurfaceKinds: [],
  targetTerritories: [],
  requiredLanguages: [],
};

describe("NET-W021 AC-01: hard gates (engine, closed vocabulary)", () => {
  test("a fully-compliant candidate is eligible with a complete passing trace", () => {
    const eligibility = evaluateEligibility(factsFor({}), permissiveTargeting);
    expect(eligibility.eligible).toBe(true);
    expect(eligibility.failedReasons).toEqual([]);
    // Complete trace: every applicable gate appears, passed.
    expect(eligibility.gates.map((g) => [g.gate, g.passed])).toEqual([
      ["item_retired", true],
      ["supply_not_verified", true],
      ["eligibility_rules_not_satisfied", true],
      ["owner_risk_control", true],
    ]);
  });

  test("each supply-side gate fails with its closed-vocabulary reason", () => {
    expect(
      evaluateEligibility(factsFor({ retired: true }), permissiveTargeting)
        .failedReasons,
    ).toEqual(["item_retired"]);
    expect(
      evaluateEligibility(factsFor({ verified: false }), permissiveTargeting)
        .failedReasons,
    ).toEqual(["supply_not_verified"]);
    expect(
      evaluateEligibility(factsFor({ rulesSatisfied: false }), permissiveTargeting)
        .failedReasons,
    ).toEqual(["eligibility_rules_not_satisfied"]);
    expect(
      evaluateEligibility(factsFor({ held: true }), permissiveTargeting)
        .failedReasons,
    ).toEqual(["owner_risk_control"]);
  });

  test("each targeting gate fails with its closed-vocabulary reason", () => {
    expect(
      evaluateEligibility(factsFor({}), {
        ...permissiveTargeting,
        requiredFormats: ["video"],
      }).failedReasons,
    ).toEqual(["format_not_targeted"]);
    expect(
      evaluateEligibility(factsFor({}), {
        ...permissiveTargeting,
        requiredSurfaceKinds: ["app"],
      }).failedReasons,
    ).toEqual(["surface_kind_not_targeted"]);
    expect(
      evaluateEligibility(factsFor({}), {
        ...permissiveTargeting,
        targetTerritories: ["GH"],
      }).failedReasons,
    ).toEqual(["territory_not_reached"]);
    expect(
      evaluateEligibility(factsFor({ languages: ["fr"] }), {
        ...permissiveTargeting,
        requiredLanguages: ["en"],
      }).failedReasons,
    ).toEqual(["language_not_supported"]);
  });

  test("conjunction semantics: every failing gate appears (no short-circuit)", () => {
    const eligibility = evaluateEligibility(
      factsFor({ retired: true, verified: false, held: true }),
      {
        ...permissiveTargeting,
        requiredFormats: ["video"],
        targetTerritories: ["GH"],
      },
    );
    expect(eligibility.failedReasons).toEqual([
      "item_retired",
      "supply_not_verified",
      "format_not_targeted",
      "territory_not_reached",
      "owner_risk_control",
    ]);
    // The passing gates are still in the trace (complete).
    const passed = eligibility.gates.filter((g) => g.passed).map((g) => g.gate);
    expect(passed).toContain("eligibility_rules_not_satisfied");
  });

  test("identical inputs yield identical verdicts (determinism)", () => {
    const a = evaluateEligibility(factsFor({}), permissiveTargeting);
    const b = evaluateEligibility(factsFor({}), permissiveTargeting);
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });
});

// ---------------------------------------------------------------------------
// Service-level: the run behavior
// ---------------------------------------------------------------------------

describe("NET-W021 AC-01: hard gates (service, fail-closed)", () => {
  test("CAMP-002: a non-ACTIVE campaign fails the whole run closed (no partial run)", async () => {
    const draft = await createMatchCampaign(harness, { skipActivation: true });
    const attempt = runCampaignMatch(harness, {
      campaignId: draft.id,
      idempotencyKey: key("w021-ac01-draft"),
    });
    await expect(attempt).rejects.toBeInstanceOf(InvalidCampaignMatchError);
    await expect(attempt).rejects.toMatchObject({
      context: { reason: "campaign_not_publishable", campaignStatus: "DRAFT" },
    });
    // No run record was persisted for the refused run.
    const runs = await harness.runtime.campaignMatchingService.listMatchRuns(
      operatorCtx(harness, "w021-ac01-list"),
      harness.organizationScopeId,
      draft.id,
    );
    expect(runs).toHaveLength(0);
  });

  test("an unresolvable pinned policy version fails closed", async () => {
    const campaign = await createMatchCampaign(harness);
    const attempt = runCampaignMatch(harness, {
      campaignId: campaign.id,
      policyVersion: 99,
      idempotencyKey: key("w021-ac01-policy"),
    });
    await expect(attempt).rejects.toBeInstanceOf(InvalidCampaignMatchError);
    await expect(attempt).rejects.toMatchObject({
      context: { reason: "policy_version_unresolved", policyVersion: 99 },
    });
  });

  test("each supply-side exclusion carries its closed-vocabulary reason on the run", async () => {
    const campaign = await createMatchCampaign(harness, {
      rules: [{ attribute: "region", operator: "in", values: ["GH"] }],
    });
    // GH rule: the default US/CA supply fails BOTH the policy rule
    // and (after the merge) the territory gate.
    const inUS = await registerSupplyItem(harness, {});
    const unverified = await registerSupplyItem(harness, {
      actorPersonId: harness.operatorPersonId,
      territories: ["GH"],
      verified: false,
    });
    const gh = await registerSupplyItem(harness, {
      actorPersonId: harness.operatorPersonId,
      territories: ["GH"],
    });
    const { run } = await runCampaignMatch(harness, {
      campaignId: campaign.id,
      candidateInventoryItemIds: [inUS.id, unverified.id, gh.id],
      idempotencyKey: key("w021-ac01-exclusions"),
    });
    expect(run.excluded.map((e) => e.inventoryItemId)).toEqual(
      [inUS.id, unverified.id].sort(),
    );
    const usExcluded = run.excluded.find((e) => e.inventoryItemId === inUS.id)!;
    expect(usExcluded.failedReasons).toEqual([
      "eligibility_rules_not_satisfied",
      "territory_not_reached",
    ]);
    const unverifiedExcluded = run.excluded.find(
      (e) => e.inventoryItemId === unverified.id,
    )!;
    expect(unverifiedExcluded.failedReasons).toEqual(["supply_not_verified"]);
    // The only compliant supply (GH, verified) is ranked.
    expect(run.results.map((r) => r.inventoryItemId)).toEqual([gh.id]);
  });

  test("an active participant_eligibility HOLD on the supply owner excludes the option", async () => {
    const campaign = await createMatchCampaign(harness);
    const owner = harness.operatorPersonId;
    const held = await registerSupplyItem(harness, { actorPersonId: owner });
    // The W016 risk-control factory (policy → assessment → control).
    const { activateEligibilityHold } = await import(
      "../creators/_net-w016-harness.ts"
    );
    await activateEligibilityHold(harness.w019.w017.w016, owner);
    const { run } = await runCampaignMatch(harness, {
      campaignId: campaign.id,
      candidateInventoryItemIds: [held.id],
      idempotencyKey: key("w021-ac01-hold"),
    });
    expect(run.results).toHaveLength(0);
    expect(run.excluded[0]!.failedReasons).toEqual(["owner_risk_control"]);
  });

  test("an unknown candidate item is NotFound (no existence oracle)", async () => {
    const campaign = await createMatchCampaign(harness);
    await expect(
      runCampaignMatch(harness, {
        campaignId: campaign.id,
        candidateInventoryItemIds: ["urn:missing-item"],
        idempotencyKey: key("w021-ac01-missing"),
      }),
    ).rejects.toBeInstanceOf(NotFoundError);
  });

  test("an unknown campaign is NotFound (no existence oracle)", async () => {
    await expect(
      runCampaignMatch(harness, {
        campaignId: "urn:missing-campaign",
        idempotencyKey: key("w021-ac01-missing-campaign"),
      }),
    ).rejects.toBeInstanceOf(NotFoundError);
  });
});
