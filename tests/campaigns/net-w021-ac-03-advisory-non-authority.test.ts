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
  CampaignMatchAdvisory,
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

/** The rule-evaluation anchors the fake supply lookup received. */
interface RuleEvaluationCall {
  readonly evaluatedAt: string;
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

/**
 * A per-consultation advisory: the nth consultation of each kind
 * returns the nth entry (distinct score/provider/modelRef per
 * candidate — the PR #43 per-candidate-advisory regression).
 */
function perCallAdvisory(
  spy: { calls: AdvisoryCall[] },
  matchingByCall: readonly CampaignMatchAdvisoryAssessment[],
  riskByCall: readonly CampaignMatchAdvisoryAssessment[],
): CampaignMatchAdvisory {
  const counts: Record<"matching" | "risk", number> = {
    matching: 0,
    risk: 0,
  };
  const assess = (
    kind: "matching" | "risk",
    byCall: readonly CampaignMatchAdvisoryAssessment[],
  ) =>
    async (input: {
      readonly rubricRef: string;
      readonly neutralFacts: readonly { label: string; value: string }[];
    }): Promise<CampaignMatchAdvisoryAssessment> => {
      spy.calls.push({
        kind,
        rubricRef: input.rubricRef,
        neutralFacts: [...input.neutralFacts],
      });
      const assessment = byCall[counts[kind]]!;
      counts[kind] += 1;
      return assessment;
    };
  return {
    assessMatching: assess("matching", matchingByCall),
    assessRisk: assess("risk", riskByCall),
  };
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
  spy: { calls: AdvisoryCall[]; ruleEvaluations: RuleEvaluationCall[] },
  opts: {
    readonly advisoryScore?: number;
    readonly advisoryPort?: CampaignMatchAdvisory;
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
        async evaluateEligibilityRules(rules, supply, evaluatedAt) {
          // A small per-call delay so a per-call wall-clock defect
          // cannot hide inside a single millisecond: the correct
          // code passes a FIXED anchor string (delay-insensitive);
          // a per-call new Date() would drift across the delays.
          await new Promise((resolve) => setTimeout(resolve, 2));
          // Neutral evaluation: positive language/region rules over
          // the declared supply (the /inventory engine's semantics).
          // The received evaluation anchor is RECORDED (the spy
          // witness for the deterministic-anchor regression).
          spy.ruleEvaluations.push({ evaluatedAt });
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
          return { eligible: satisfied, evaluatedAt, ruleResults };
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
    advisory: opts.advisoryPort ?? spyAdvisory(spy, opts.advisoryScore ?? 80),
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
    const spy: { calls: AdvisoryCall[]; ruleEvaluations: RuleEvaluationCall[] } = {
      calls: [],
      ruleEvaluations: [],
    };
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
    const spy2: {
      calls: AdvisoryCall[];
      ruleEvaluations: RuleEvaluationCall[];
    } = { calls: [], ruleEvaluations: [] };
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
    const spy: { calls: AdvisoryCall[]; ruleEvaluations: RuleEvaluationCall[] } = {
      calls: [],
      ruleEvaluations: [],
    };
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
    const spy: {
      calls: AdvisoryCall[];
      ruleEvaluations: RuleEvaluationCall[];
    } = { calls: [], ruleEvaluations: [] };
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
    const spyZero: {
      calls: AdvisoryCall[];
      ruleEvaluations: RuleEvaluationCall[];
    } = { calls: [], ruleEvaluations: [] };
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

  test("REGRESSION (PR #43 review): the persisted per-candidate advisory is EACH candidate's own assessment — never a top-candidate projection", async () => {
    // The blocking defect under review: buildCandidateResults was
    // handed only ranked[0]'s assessments, so EVERY candidate's
    // persisted result.advisory carried the TOP candidate's matching
    // and risk assessments. This regression pins the per-candidate
    // resolution by candidate id.
    const campaign = await createMatchCampaign(harness);
    const [policy] = await harness.runtime.campaignService.listPolicyVersions(
      operatorCtx(harness, "w021-ac03-per-candidate"),
      campaign.id,
    );
    // Three eligible candidates; each consultation returns an
    // intentionally DISTINCT assessment (score AND provider AND
    // modelRef) — consultation order === the explicit candidate
    // order (matching first, then risk, each in candidate order).
    const itemIds = ["item-a", "item-b", "item-c"];
    const matchingByCall: readonly CampaignMatchAdvisoryAssessment[] = [
      { score: 90, provider: "provider-a", modelRef: "model-a-1" },
      { score: 50, provider: "provider-b", modelRef: "model-b-1" },
      { score: 10, provider: "provider-c", modelRef: "model-c-1" },
    ];
    const riskByCall: readonly CampaignMatchAdvisoryAssessment[] = [
      { score: 15, provider: "risk-provider-a", modelRef: "risk-model-a" },
      { score: 55, provider: "risk-provider-b", modelRef: "risk-model-b" },
      { score: 95, provider: "risk-provider-c", modelRef: "risk-model-c" },
    ];
    const spy: {
      calls: AdvisoryCall[];
      ruleEvaluations: RuleEvaluationCall[];
    } = { calls: [], ruleEvaluations: [] };
    const service = await createSpyService(
      campaign,
      [policy!],
      itemIds,
      spy,
      {
        advisoryPort: perCallAdvisory(spy, matchingByCall, riskByCall),
      },
    );
    const { run } = await spyRun(service, {
      campaignId: campaign.id,
      candidateInventoryItemIds: itemIds,
      advisory: {
        matching: { enabled: true, maxWeight: 25 },
        risk: { enabled: true, maxWeight: 25 },
      },
      idempotencyKey: key("w021-ac03-per-candidate"),
    });
    expect(run.eligibleCount).toBe(3);
    expect(run.results).toHaveLength(3);
    // Exactly one consultation per candidate per purpose.
    expect(spy.calls.filter((c) => c.kind === "matching")).toHaveLength(3);
    expect(spy.calls.filter((c) => c.kind === "risk")).toHaveLength(3);

    // Each persisted result carries ITS OWN candidate's assessments,
    // for BOTH purposes, with the distinct scores AND provider/model
    // metadata preserved per candidate.
    const callIndexOf = new Map(itemIds.map((id, i) => [id, i]));
    for (const result of run.results) {
      const index = callIndexOf.get(result.inventoryItemId)!;
      expect(result.advisory.matching).toEqual(matchingByCall[index]!);
      expect(result.advisory.risk).toEqual(riskByCall[index]!);
      // The per-signal ranking inputs agree with the persisted
      // per-candidate advisory (the same assessment fed both).
      const alignment = result.signals.find((s) => s.signal === "alignment")!;
      expect(alignment.inputs).toMatchObject({
        advisoryScore: matchingByCall[index]!.score,
        advisoryProvider: matchingByCall[index]!.provider,
        advisoryModelRef: matchingByCall[index]!.modelRef,
        advisoryBlend: 0.25,
      });
      const risk = result.signals.find((s) => s.signal === "risk")!;
      expect(risk.inputs).toMatchObject({
        advisoryScore: riskByCall[index]!.score,
        advisoryProvider: riskByCall[index]!.provider,
        advisoryModelRef: riskByCall[index]!.modelRef,
        advisoryBlend: 0.25,
      });
    }
    // The per-candidate scores are pairwise distinct (both purposes).
    expect(new Set(run.results.map((r) => r.advisory.matching!.score)).size).toBe(3);
    expect(new Set(run.results.map((r) => r.advisory.risk!.score)).size).toBe(3);

    // THE ANTI-COLLAPSE PROOF (the exact defect under review): the
    // rank-2 and rank-3 candidates' persisted advisories are NOT the
    // rank-1 candidate's advisory.
    const byRank = [...run.results].sort((a, b) => a.rank - b.rank);
    const topMatching = byRank[0]!.advisory.matching!;
    const topRisk = byRank[0]!.advisory.risk!;
    expect(byRank[1]!.advisory.matching).not.toEqual(topMatching);
    expect(byRank[2]!.advisory.matching).not.toEqual(topMatching);
    expect(byRank[1]!.advisory.risk).not.toEqual(topRisk);
    expect(byRank[2]!.advisory.risk).not.toEqual(topRisk);

    // The run-level advisory block is an honest SUMMARY of a
    // divergent run: used=true, but no single provider/modelRef can
    // faithfully summarize three distinct sources, so both are null
    // (the per-candidate results carry the faithful identities).
    expect(run.advisory.matching).toEqual({
      used: true,
      blend: 0.25,
      provider: null,
      modelRef: null,
    });
    expect(run.advisory.risk).toEqual({
      used: true,
      blend: 0.25,
      provider: null,
      modelRef: null,
    });

    // And for a UNIFORM run the run-level summary still records the
    // shared identity (the single-adapter wiring: echo/spy ports).
    const spyUniform: {
      calls: AdvisoryCall[];
      ruleEvaluations: RuleEvaluationCall[];
    } = { calls: [], ruleEvaluations: [] };
    const uniformService = await createSpyService(
      campaign,
      [policy!],
      itemIds,
      spyUniform,
      { advisoryScore: 70 },
    );
    const uniform = await spyRun(uniformService, {
      campaignId: campaign.id,
      candidateInventoryItemIds: itemIds,
      advisory: {
        matching: { enabled: true, maxWeight: 25 },
        risk: { enabled: true, maxWeight: 25 },
      },
      idempotencyKey: key("w021-ac03-uniform"),
    });
    expect(uniform.run.advisory.matching).toEqual({
      used: true,
      blend: 0.25,
      provider: "spy-provider",
      modelRef: "spy-model",
    });
    // Every candidate still carries its own (here identical) record.
    for (const result of uniform.run.results) {
      expect(result.advisory.matching).toEqual({
        score: 70,
        provider: "spy-provider",
        modelRef: "spy-model",
      });
    }
  });

  test("REGRESSION (PR #43 review): every inventory-rule evaluation in a run receives the run's SINGLE recorded evaluation anchor (no composition-root wall clock)", async () => {
    // The secondary defect under review: the composition-root supply
    // lookup called the /inventory rule engine with
    // new Date().toISOString() — an implicit per-candidate wall-clock
    // dependency at the matching boundary. The anchor is now derived
    // ONCE per run at the service boundary, passed explicitly to the
    // lookup, and recorded on the run record.
    const campaign = await createMatchCampaign(harness);
    const [policy] = await harness.runtime.campaignService.listPolicyVersions(
      operatorCtx(harness, "w021-ac03-anchor"),
      campaign.id,
    );
    const itemIds = ["item-a", "item-b", "item-c"];
    const spy: {
      calls: AdvisoryCall[];
      ruleEvaluations: RuleEvaluationCall[];
    } = { calls: [], ruleEvaluations: [] };
    const service = await createSpyService(
      campaign,
      [policy!],
      itemIds,
      spy,
    );
    const { run } = await spyRun(service, {
      campaignId: campaign.id,
      candidateInventoryItemIds: itemIds,
      idempotencyKey: key("w021-ac03-anchor"),
    });
    // One rule evaluation per candidate — ALL at the SAME anchor,
    // and that anchor is exactly the one recorded on the decision.
    expect(spy.ruleEvaluations).toHaveLength(3);
    expect(
      new Set(spy.ruleEvaluations.map((c) => c.evaluatedAt)).size,
    ).toBe(1);
    for (const call of spy.ruleEvaluations) {
      expect(call.evaluatedAt).toBe(run.evaluatedAt);
    }
    // The anchor is a recorded ISO instant on the run record.
    expect(run.evaluatedAt).toMatch(
      /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/,
    );
    // The anchor is NOT part of the digest (wall-clock identity):
    // mutating it on the stored record cannot change the recomputed
    // digest, and a second run of identical decision content
    // reproduces the digest bit-for-bit.
    const { computeMatchDigest } = await import(
      "../../src/campaigns/matching-engine.ts"
    );
    const reanchored = { ...run, evaluatedAt: "1999-01-01T00:00:00.000Z" };
    expect(computeMatchDigest(reanchored)).toBe(run.digest);
    expect(computeMatchDigest(run)).toBe(run.digest);
    const second = await spyRun(service, {
      campaignId: campaign.id,
      candidateInventoryItemIds: itemIds,
      idempotencyKey: key("w021-ac03-anchor-2"),
    });
    expect(second.run.digest).toBe(run.digest);
  });
});
