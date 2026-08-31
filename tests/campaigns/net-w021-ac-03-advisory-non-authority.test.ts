/**
 * NET-W021 AC-03 — The bounded AI advisory is structurally
 * non-authoritative (AI-002 + AI-003).
 *
 * Proves: both advisory consultations are disabled by default
 * (pure-deterministic ranking); when enabled they are consulted ONLY
 * for already-eligible candidates; the blends are capped at 25% and
 * blend into `alignment` (AI-002) and `risk` (AI-003) ONLY; provider
 * identity is recorded on the run; the advisory inputs are
 * privacy-minimized neutral facts (no owner identity, no reputation
 * scores, no evidence values); hard restrictions can NEVER be
 * overridden — an ineligible option is excluded before any advisory
 * is consulted, and no advisory score can promote it.
 */

import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { createHash } from "node:crypto";
import {
  createNetW021Harness,
  createMatchCampaign,
  registerSupplyItem,
  runCampaignMatch,
  key,
  operatorCtx,
  type NetW021Harness,
} from "./_net-w021-harness.ts";
import { createCampaignMatchingService } from "../../src/campaigns/matching-service.ts";
import type {
  CampaignMatchAdvisoryAssessment,
  CampaignMatchRunRecord,
  CampaignMatchRunRepository,
  CampaignRepository,
  CampaignPolicyRepository,
  CampaignMatchingService,
  RunCampaignMatchInput,
  RunCampaignMatchResult,
} from "../../src/campaigns/port.ts";
import type { CampaignRecord, CampaignPolicy } from "../../src/campaigns/port.ts";
import type { ExecutionContext } from "../../src/core/execution-context.ts";
import { createExecutionContext } from "../../src/core/execution-context.ts";
import { InvalidCampaignMatchError } from "../../src/core/campaigns.ts";
import { SILENT_LOGGER } from "../../src/observability/logger.ts";

let harness: NetW021Harness;

beforeAll(async () => {
  harness = await createNetW021Harness();
});

afterAll(async () => {
  await harness.teardown();
});

const SILENT = SILENT_LOGGER;

// ---------------------------------------------------------------------------
// The recording advisory (the spy)
// ---------------------------------------------------------------------------

interface AdvisoryCall {
  readonly kind: "matching" | "risk";
  readonly rubricRef: string;
  readonly neutralFacts: readonly { label: string; value: string }[];
}

function spyAdvisory(spy: { calls: AdvisoryCall[] }, score: number) {
  const assess = (kind: "matching" | "risk") => {
    return async (input: {
      readonly rubricRef: string;
      readonly neutralFacts: readonly { label: string; value: string }[];
    }): Promise<CampaignMatchAdvisoryAssessment> => {
      spy.calls.push({
        kind,
        rubricRef: input.rubricRef,
        neutralFacts: [...input.neutralFacts],
      });
      return { score, provider: "spy-provider", modelRef: "spy-model" };
    };
  };
  return { assessMatching: assess("matching"), assessRisk: assess("risk") };
}

function fakeCampaignRepo(
  campaigns: readonly CampaignRecord[],
): CampaignRepository {
  return {
    async save(c) {
      return c;
    },
    async findById(id) {
      return campaigns.find((c) => c.id === id) ?? null;
    },
    async listByOrganization(org) {
      return campaigns.filter((c) => c.organizationScopeId === org);
    },
    async findByIdWithinTx(id) {
      return campaigns.find((c) => c.id === id) ?? null;
    },
    async createWithinTx(c) {
      return c;
    },
    async saveWithinTx(c) {
      return c;
    },
  } as CampaignRepository;
}

function fakePolicyRepo(
  policies: readonly CampaignPolicy[],
): CampaignPolicyRepository {
  return {
    async findById(id) {
      return policies.find((p) => p.id === id) ?? null;
    },
    async findVersion(campaignId, version) {
      return (
        policies.find(
          (p) => p.campaignId === campaignId && p.version === version,
        ) ?? null
      );
    },
    async listByCampaign(campaignId) {
      return policies.filter((p) => p.campaignId === campaignId);
    },
    async findVersionWithinTx(campaignId, version) {
      return (
        policies.find(
          (p) => p.campaignId === campaignId && p.version === version,
        ) ?? null
      );
    },
    async findLatestWithinTx(campaignId) {
      const list = policies.filter((p) => p.campaignId === campaignId);
      return list.length > 0 ? list[list.length - 1]! : null;
    },
    async createWithinTx(p) {
      return p;
    },
  } as CampaignPolicyRepository;
}

function fakeRunRepo(): CampaignMatchRunRepository & {
  readonly runs: CampaignMatchRunRecord[];
} {
  const runs: CampaignMatchRunRecord[] = [];
  return {
    runs,
    async findById(id) {
      return runs.find((r) => r.id === id) ?? null;
    },
    async listByOrganization(org) {
      return runs.filter((r) => r.organizationScopeId === org);
    },
    async createWithinTx(run) {
      runs.push(run);
      return run;
    },
  } as CampaignMatchRunRepository & { readonly runs: CampaignMatchRunRecord[] };
}

/** Build the standalone spy service over a real campaign + controlled supply. */
async function createSpyService(
  campaign: CampaignRecord,
  policies: readonly CampaignPolicy[],
  itemIds: readonly string[],
  spy: { calls: AdvisoryCall[] },
  opts: {
    readonly advisoryScore?: number;
    readonly supplyVerified?: boolean;
    readonly safetyHeld?: boolean;
    readonly standingScore?: number;
  } = {},
): Promise<CampaignMatchingService> {
  const runRepo = fakeRunRepo();
  const verified = opts.supplyVerified !== false;
  return createCampaignMatchingService({
    campaignRepository: fakeCampaignRepo([campaign]),
    campaignPolicyRepository: fakePolicyRepo(policies),
    runRepository: runRepo,
    lookups: {
      supply: {
        async listCandidateItems(org) {
          return itemIds.map((id) => ({
            id,
            organizationScopeId: org,
            ownerPersonId: `owner-${id}`,
            surfaceKind: "publisher",
            format: "display",
            territories: ["US"],
            languages: ["en"],
            verificationEvidenceReference: verified ? "evidence-1" : null,
            retiredAt: null,
          }));
        },
        async getItem(org, itemId) {
          return {
            id: itemId,
            organizationScopeId: org,
            ownerPersonId: `owner-${itemId}`,
            surfaceKind: "publisher",
            format: "display",
            territories: ["US"],
            languages: ["en"],
            verificationEvidenceReference: verified ? "evidence-1" : null,
            retiredAt: null,
          };
        },
        async placedItemIds() {
          return [];
        },
        async evaluateEligibilityRules(rules, supply) {
          // Neutral evaluation: positive language/region rules over
          // the declared supply (the /inventory engine's semantics).
          let satisfied = true;
          const ruleResults = rules.map((rule) => {
            const offered =
              rule.attribute === "region"
                ? supply.territories
                : rule.attribute === "language"
                  ? supply.languages
                  : [];
            const ok =
              rule.attribute !== "region" && rule.attribute !== "language"
                ? false
                : rule.operator === "in" || rule.operator === "equals"
                  ? rule.values.every((v) => offered.includes(v))
                  : rule.values.every((v) => !offered.includes(v));
            if (!ok) satisfied = false;
            return {
              attribute: rule.attribute,
              operator: rule.operator,
              values: [...rule.values],
              satisfied: ok,
              reason: ok ? "satisfied" : "offered_value_outside_rule",
            };
          });
          return { eligible: satisfied, ruleResults };
        },
      },
      reputation: {
        async latestScore(org, personId, dimension) {
          if (opts.standingScore === undefined) return null;
          return {
            snapshotId: `snap-${personId}-${dimension}`,
            organizationScopeId: org,
            subjectPersonId: personId,
            dimension,
            digest: `digest-${dimension}`,
            score: opts.standingScore,
          };
        },
      },
      safety: {
        async activeHold() {
          return {
            held: opts.safetyHeld === true,
            controlId: null,
            action: null,
          };
        },
      },
      outcomes: {
        async listVerifiedOutcomesBySubject() {
          return [];
        },
      },
    },
    advisory: spyAdvisory(spy, opts.advisoryScore ?? 80),
    idempotency: harness.runtime.idempotency,
    auditWriter: harness.runtime.auditWriter,
    logger: SILENT,
  });
}

function personExecution(): ExecutionContext {
  return createExecutionContext({
    correlationId: "w021-ac03-spy",
    actor: { id: harness.operatorPersonId, kind: "person" },
  });
}

async function spyRun(
  service: CampaignMatchingService,
  input: Partial<RunCampaignMatchInput> & {
    readonly campaignId: string;
    readonly idempotencyKey: string;
  },
): Promise<RunCampaignMatchResult> {
  return service.runCampaignMatch(personExecution(), {
    organizationScopeId: harness.organizationScopeId,
    ...input,
  } as RunCampaignMatchInput);
}

// ---------------------------------------------------------------------------
// Full-runtime tests (the echo provider path)
// ---------------------------------------------------------------------------

describe("NET-W021 AC-03: advisory is non-authoritative (AI-002 + AI-003)", () => {
  test("both advisories are DISABLED by default: pure deterministic ranking", async () => {
    const campaign = await createMatchCampaign(harness);
    const item = await registerSupplyItem(harness, {});
    const { run } = await runCampaignMatch(harness, {
      campaignId: campaign.id,
      candidateInventoryItemIds: [item.id],
      idempotencyKey: key("w021-ac03-disabled"),
    });
    expect(run.advisory.config.matching).toEqual({
      enabled: false,
      maxWeight: 0,
    });
    expect(run.advisory.config.risk).toEqual({ enabled: false, maxWeight: 0 });
    expect(run.advisory.matching).toEqual({
      used: false,
      blend: 0,
      provider: null,
      modelRef: null,
    });
    expect(run.advisory.risk).toEqual({
      used: false,
      blend: 0,
      provider: null,
      modelRef: null,
    });
    const result = run.results[0]!;
    expect(result.advisory.matching).toBeNull();
    expect(result.advisory.risk).toBeNull();
    // Baseline == final for every signal.
    for (const s of result.signals) {
      expect(s.score).toBe(s.baselineScore);
    }
    expect(result.totalScore).toBe(result.baselineTotalScore);
    expect(result.rank).toBe(result.baselineRank);
  });

  test("the echo advisory blends into alignment (AI-002) with provider identity recorded — bit-for-bit reproducible", async () => {
    const campaign = await createMatchCampaign(harness);
    const item = await registerSupplyItem(harness, {});
    const { run } = await runCampaignMatch(harness, {
      campaignId: campaign.id,
      candidateInventoryItemIds: [item.id],
      advisory: { matching: { enabled: true, maxWeight: 25 } },
      idempotencyKey: key("w021-ac03-echo"),
    });
    expect(run.advisory.matching).toEqual({
      used: true,
      blend: 0.25,
      provider: "echo",
      modelRef: "echo-scoring-v1",
    });
    expect(run.advisory.risk.used).toBe(false);

    const result = run.results[0]!;
    const assessment = result.advisory.matching!;
    expect(assessment.provider).toBe("echo");
    // The echo provider's deterministic score over the recorded
    // neutral facts — recomputed bit-for-bit (the provider-input
    // proof: the composition-root adapter feeds EXACTLY the declared
    // fact set to LlmPort.score with purpose "matching").
    const canonical = JSON.stringify({
      purpose: "matching",
      rubricRef: `campaign-matching:NET-W021:1`,
      neutralFacts: [
        { label: "campaign_required_outcome_type", value: "view" },
        { label: "supply_surface_kind", value: "publisher" },
        { label: "supply_format", value: "display" },
        { label: "supply_territory_count", value: "2" },
        { label: "supply_language_count", value: "1" },
        { label: "evidence_present", value: "view:no" },
      ].map((f) => ({ label: f.label, value: f.value })),
    });
    const echoScore =
      Math.round(
        (Number.parseInt(
          createHash("sha256").update(canonical, "utf8").digest("hex").slice(0, 8),
          16,
        ) /
          0x1_0000_0000) *
          1000,
      ) / 10;
    expect(assessment.score).toBe(echoScore);

    // The blend: alignment' = 0.75×baseline + 0.25×echo (1-decimal).
    const alignment = result.signals.find((s) => s.signal === "alignment")!;
    expect(alignment.baselineScore).toBe(100);
    expect(alignment.score).toBe(
      Math.round((0.75 * 100 + 0.25 * echoScore) * 10) / 10,
    );
    expect(alignment.inputs).toMatchObject({
      advisoryScore: echoScore,
      advisoryProvider: "echo",
      advisoryBlend: 0.25,
    });
    // The risk signal is untouched by the matching advisory.
    const risk = result.signals.find((s) => s.signal === "risk")!;
    expect(risk.score).toBe(risk.baselineScore);
    expect(risk.inputs).not.toHaveProperty("advisoryScore");
  });

  test("the risk advisory (AI-003) blends into the risk signal ONLY (purpose safety)", async () => {
    const campaign = await createMatchCampaign(harness);
    const item = await registerSupplyItem(harness, {});
    const { run } = await runCampaignMatch(harness, {
      campaignId: campaign.id,
      candidateInventoryItemIds: [item.id],
      advisory: { risk: { enabled: true, maxWeight: 20 } },
      idempotencyKey: key("w021-ac03-echo-risk"),
    });
    expect(run.advisory.risk).toEqual({
      used: true,
      blend: 0.2,
      provider: "echo",
      modelRef: "echo-scoring-v1",
    });
    expect(run.advisory.matching.used).toBe(false);
    const result = run.results[0]!;
    const risk = result.signals.find((s) => s.signal === "risk")!;
    expect(risk.baselineScore).toBe(0);
    const assessment = result.advisory.risk!;
    expect(risk.score).toBeCloseTo(0.8 * 0 + 0.2 * assessment.score, 1);
    expect(risk.inputs).toMatchObject({
      advisoryProvider: "echo",
      advisoryBlend: 0.2,
    });
    // The alignment signal is untouched by the risk advisory.
    const alignment = result.signals.find((s) => s.signal === "alignment")!;
    expect(alignment.inputs).not.toHaveProperty("advisoryBlend");
  });

  test("the blend caps are enforced (maxWeight ≤ 25, ≥ 0)", async () => {
    const campaign = await createMatchCampaign(harness);
    const item = await registerSupplyItem(harness, {});
    for (const maxWeight of [26, 100, -1]) {
      await expect(
        runCampaignMatch(harness, {
          campaignId: campaign.id,
          candidateInventoryItemIds: [item.id],
          advisory: { matching: { enabled: true, maxWeight } },
          idempotencyKey: key("w021-ac03-cap"),
        }),
      ).rejects.toBeInstanceOf(InvalidCampaignMatchError);
      await expect(
        runCampaignMatch(harness, {
          campaignId: campaign.id,
          candidateInventoryItemIds: [item.id],
          advisory: { risk: { enabled: true, maxWeight } },
          idempotencyKey: key("w021-ac03-cap-risk"),
        }),
      ).rejects.toBeInstanceOf(InvalidCampaignMatchError);
    }
  });
});

// ---------------------------------------------------------------------------
// Spy-service tests (only-eligible consultation + privacy + flips)
// ---------------------------------------------------------------------------

describe("NET-W021 AC-03: advisory consultation + privacy (spy service)", () => {
  test("the advisory is consulted ONLY for already-eligible candidates", async () => {
    const campaign = await createMatchCampaign(harness);
    const [policy] = await harness.runtime.campaignService.listPolicyVersions(
      operatorCtx(harness, "w021-ac03-policy"),
      campaign.id,
    );
    const spy: { calls: AdvisoryCall[] } = { calls: [] };
    // One ELIGIBLE item, one INELIGIBLE item (unverified supply).
    const service = await createSpyService(
      campaign,
      [policy!],
      ["item-eligible", "item-ineligible"],
      spy,
      { supplyVerified: true },
    );
    // The ineligible candidate is introduced through explicit ids
    // with a separate service instance whose supply is unverified.
    const spy2: { calls: AdvisoryCall[] } = { calls: [] };
    const service2 = await createSpyService(
      campaign,
      [policy!],
      ["item-x"],
      spy2,
      { supplyVerified: false },
    );
    const { run } = await spyRun(service, {
      campaignId: campaign.id,
      candidateInventoryItemIds: ["item-eligible"],
      advisory: {
        matching: { enabled: true, maxWeight: 25 },
        risk: { enabled: true, maxWeight: 25 },
      },
      idempotencyKey: key("w021-ac03-spy-eligible"),
    });
    expect(run.eligibleCount).toBe(1);
    // ONE matching consultation + ONE risk consultation for the ONE
    // eligible candidate.
    expect(spy.calls.filter((c) => c.kind === "matching")).toHaveLength(1);
    expect(spy.calls.filter((c) => c.kind === "risk")).toHaveLength(1);

    // The ineligible-only run: ZERO consultations.
    const refused = await spyRun(service2, {
      campaignId: campaign.id,
      candidateInventoryItemIds: ["item-x"],
      advisory: {
        matching: { enabled: true, maxWeight: 25 },
        risk: { enabled: true, maxWeight: 25 },
      },
      idempotencyKey: key("w021-ac03-spy-ineligible"),
    });
    expect(refused.run.eligibleCount).toBe(0);
    expect(refused.run.excluded[0]!.failedReasons).toEqual(["supply_not_verified"]);
    expect(spy2.calls).toHaveLength(0);
  });

  test("the advisory inputs are privacy-minimized neutral facts (no identity, no scores, no evidence values)", async () => {
    const campaign = await createMatchCampaign(harness);
    const [policy] = await harness.runtime.campaignService.listPolicyVersions(
      operatorCtx(harness, "w021-ac03-policy2"),
      campaign.id,
    );
    const spy: { calls: AdvisoryCall[] } = { calls: [] };
    const service = await createSpyService(
      campaign,
      [policy!],
      ["item-eligible"],
      spy,
      { standingScore: 77 },
    );
    await spyRun(service, {
      campaignId: campaign.id,
      candidateInventoryItemIds: ["item-eligible"],
      advisory: {
        matching: { enabled: true, maxWeight: 25 },
        risk: { enabled: true, maxWeight: 25 },
      },
      idempotencyKey: key("w021-ac03-spy-privacy"),
    });
    const matchingCall = spy.calls.find((c) => c.kind === "matching")!;
    const riskCall = spy.calls.find((c) => c.kind === "risk")!;
    // The exact matching fact set (pinned bit-for-bit).
    expect(matchingCall.rubricRef).toBe("campaign-matching:NET-W021:1");
    expect(matchingCall.neutralFacts).toEqual([
      { label: "campaign_required_outcome_type", value: "view" },
      { label: "supply_surface_kind", value: "publisher" },
      { label: "supply_format", value: "display" },
      { label: "supply_territory_count", value: "1" },
      { label: "supply_language_count", value: "1" },
      { label: "evidence_present", value: "view:no" },
    ]);
    // The risk fact set: aggregate supply facts + evidence presence +
    // snapshot PRESENCE booleans (never scores).
    expect(riskCall.rubricRef).toBe("campaign-matching-risk:NET-W021:1");
    const riskLabels = riskCall.neutralFacts.map((f) => f.label);
    expect(riskLabels).toEqual([
      "supply_surface_kind",
      "supply_format",
      "supply_territory_count",
      "supply_language_count",
      "evidence_present",
      "owner_has_standing_snapshot",
      "owner_has_reliability_snapshot",
      "owner_has_fraud_resistance_snapshot",
    ]);
    expect(riskCall.neutralFacts.find((f) => f.label === "owner_has_standing_snapshot")!.value).toBe("yes");
    // NO owner identity, NO reputation scores, NO digests, NO
    // evidence values anywhere in either fact set.
    const allFacts = [...matchingCall.neutralFacts, ...riskCall.neutralFacts];
    const serialized = JSON.stringify(allFacts);
    expect(serialized).not.toContain("owner-item-eligible");
    expect(serialized).not.toContain("77");
    expect(serialized).not.toContain("snap-");
    expect(serialized).not.toContain("digest-");
    for (const fact of allFacts) {
      expect(Object.keys(fact).sort()).toEqual(["label", "value"]);
    }
  });

  test("no advisory score can flip eligibility or override a hard restriction/hold (structural)", async () => {
    const campaign = await createMatchCampaign(harness);
    const [policy] = await harness.runtime.campaignService.listPolicyVersions(
      operatorCtx(harness, "w021-ac03-policy3"),
      campaign.id,
    );
    // A maximal advisory score (100) + maximal blend on BOTH signals.
    const spy: { calls: AdvisoryCall[] } = { calls: [] };
    const heldService = await createSpyService(
      campaign,
      [policy!],
      ["item-held"],
      spy,
      { safetyHeld: true, advisoryScore: 100 },
    );
    const held = await spyRun(heldService, {
      campaignId: campaign.id,
      candidateInventoryItemIds: ["item-held"],
      advisory: {
        matching: { enabled: true, maxWeight: 25 },
        risk: { enabled: true, maxWeight: 25 },
      },
      idempotencyKey: key("w021-ac03-spy-flip"),
    });
    // The held option is excluded BEFORE any consultation.
    expect(held.run.results).toHaveLength(0);
    expect(held.run.excluded[0]!.failedReasons).toEqual(["owner_risk_control"]);
    expect(spy.calls).toHaveLength(0);

    // And an eligible option stays eligible regardless of a ZERO
    // advisory score (no demotion to ineligible either).
    const spyZero: { calls: AdvisoryCall[] } = { calls: [] };
    const zeroService = await createSpyService(
      campaign,
      [policy!],
      ["item-ok"],
      spyZero,
      { advisoryScore: 0 },
    );
    const zero = await spyRun(zeroService, {
      campaignId: campaign.id,
      candidateInventoryItemIds: ["item-ok"],
      advisory: {
        matching: { enabled: true, maxWeight: 25 },
        risk: { enabled: true, maxWeight: 25 },
      },
      idempotencyKey: key("w021-ac03-spy-zero"),
    });
    expect(zero.run.eligibleCount).toBe(1);
    expect(zero.run.results[0]!.rank).toBe(1);
  });
});
