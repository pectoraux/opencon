/**
 * NET-W016-AC-03 — AI-assisted matching is ADVISORY, never authority
 * (work order §3.3; AI-002).
 *
 * The advisory is disabled by default (pure deterministic ranking);
 * when enabled it is consulted ONLY for already-eligible candidates,
 * blends ONLY into the relevance signal under a capped weight
 * (≤ 25%), records its provider identity, and can NEVER flip a hard
 * gate — structurally (hard-gated candidates are excluded before the
 * advisory is ever consulted; there is no code path from advisory
 * output to an eligibility verdict). The advisory input is a
 * privacy-minimized neutral-fact set (no rates, no restricted
 * topics, no reputation scores, no identity material) and the
 * composition-root adapter feeds EXACTLY that fact set to the
 * provider-neutral LlmPort with purpose "matching" (bit-for-bit,
 * proven by reproducing the echo provider's deterministic score).
 *
 * The spy stack builds a STANDALONE matching service over the
 * runtime's REAL transactional primitives (idempotency + audit
 * writer) with fake repositories, controlled lookups and a recording
 * advisory — proving consultation behavior and input shape at the
 * service-contract level.
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
import {
  buildAdvisoryFacts,
  createCreatorMatchingService,
} from "../../src/creators/matching-service.ts";
import type {
  CreatorMatchAdvisoryAssessment,
  CreatorMatchAdvisoryInput,
  CreatorMatchRunRecord,
  CreatorMatchingService,
  CreatorProfileRecord,
  CreatorProfileRepository,
  CreatorProfileVersion,
  CreatorProfileVersionRepository,
  CreatorMatchRunRepository,
  ResolvedCreatorReputationScore,
  RunCreatorMatchInput,
  RunCreatorMatchResult,
} from "../../src/creators/port.ts";
import type { AuthorityTransaction } from "../../src/core/postgres-authority.ts";
import type { ExecutionContext } from "../../src/core/execution-context.ts";
import { createExecutionContext } from "../../src/core/execution-context.ts";
import { InvalidCreatorMatchError } from "../../src/core/creators.ts";
import { SILENT_LOGGER } from "../../src/observability/logger.ts";

let harness: NetW016Harness;

beforeAll(async () => {
  harness = await createNetW016Harness();
});

afterAll(async () => {
  await harness.teardown();
});

// ---------------------------------------------------------------------------
// The spy advisory + the standalone service stack
// ---------------------------------------------------------------------------

interface SpyAdvisory {
  readonly calls: CreatorMatchAdvisoryInput[];
  scoreFor: (input: CreatorMatchAdvisoryInput) => number;
  provider: string;
}

function createSpyAdvisory(
  scoreFor: SpyAdvisory["scoreFor"] = () => 50,
): SpyAdvisory {
  return { calls: [], scoreFor, provider: "spy-advisory" };
}

function spyAdvisoryPort(spy: SpyAdvisory) {
  return {
    async assess(
      input: CreatorMatchAdvisoryInput,
    ): Promise<CreatorMatchAdvisoryAssessment> {
      spy.calls.push(input);
      return {
        score: spy.scoreFor(input),
        provider: spy.provider,
        modelRef: "spy-model-v1",
      };
    },
  };
}

function fakeProfileRepo(
  profiles: readonly CreatorProfileRecord[],
): CreatorProfileRepository {
  return {
    async save(profile) {
      return profile;
    },
    async findById(id) {
      return profiles.find((p) => p.id === id) ?? null;
    },
    async findByPerson() {
      return null;
    },
    async listByOrganization(organizationScopeId, statuses) {
      return profiles.filter(
        (p) =>
          p.organizationScopeId === organizationScopeId &&
          (statuses === undefined || statuses.includes(p.status)),
      );
    },
    async findByIdWithinTx(id) {
      return profiles.find((p) => p.id === id) ?? null;
    },
    async findByPersonWithinTx() {
      return null;
    },
    async createWithinTx(profile) {
      return profile;
    },
    async saveWithinTx(profile) {
      return profile;
    },
  };
}

function fakeVersionRepo(
  versions: readonly CreatorProfileVersion[],
): CreatorProfileVersionRepository {
  const find = (profileId: string, version: number) =>
    versions.find(
      (v) => v.profileId === profileId && v.version === version,
    ) ?? null;
  return {
    async findById(id) {
      return versions.find((v) => v.id === id) ?? null;
    },
    async findVersion(profileId, version) {
      return find(profileId, version);
    },
    async listByProfile(profileId) {
      return versions.filter((v) => v.profileId === profileId);
    },
    async findVersionWithinTx(profileId, version) {
      return find(profileId, version);
    },
    async findLatestWithinTx() {
      return null;
    },
    async createWithinTx(version) {
      return version;
    },
  };
}

function fakeRunRepo(): CreatorMatchRunRepository & {
  runs(): readonly CreatorMatchRunRecord[];
} {
  const stored: CreatorMatchRunRecord[] = [];
  return {
    runs: () => stored.slice(),
    async save(run) {
      return run;
    },
    async findById(id) {
      return stored.find((r) => r.id === id) ?? null;
    },
    async listByOrganization(organizationScopeId, campaignId) {
      return stored.filter(
        (r) =>
          r.organizationScopeId === organizationScopeId &&
          (campaignId === undefined ||
            r.campaign?.campaignId === campaignId),
      );
    },
    async createWithinTx(run: CreatorMatchRunRecord, _tx: AuthorityTransaction) {
      stored.push(run);
      return run;
    },
  };
}

function resolvedScore(
  snapshotId: string,
  dimension: string,
  score: number,
  profile: CreatorProfileRecord,
  digest: string,
): ResolvedCreatorReputationScore {
  return {
    snapshotId,
    organizationScopeId: profile.organizationScopeId,
    subjectPersonId: profile.creatorPersonId,
    dimension: dimension as ResolvedCreatorReputationScore["dimension"],
    digest,
    score,
  };
}

/** Build the standalone spy service over a set of runtime-made candidates. */
async function createSpyService(
  candidates: readonly {
    profile: CreatorProfileRecord;
    version: CreatorProfileVersion | null;
  }[],
  spy: SpyAdvisory,
  opts: {
    readonly reputationScore?: number;
    readonly held?: boolean;
  } = {},
) {
  const versions = candidates
    .map((c) => c.version)
    .filter((v): v is CreatorProfileVersion => v !== null);
  const references = versions.flatMap(
    (v) => v.sections.reputationReferences,
  );
  const runRepo = fakeRunRepo();
  const service = createCreatorMatchingService({
    profileRepository: fakeProfileRepo(candidates.map((c) => c.profile)),
    versionRepository: fakeVersionRepo(versions),
    runRepository: runRepo,
    lookups: {
      campaign: {
        async resolve() {
          return null;
        },
      },
      reputation: {
        async resolveScore(snapshotId, dimension) {
          const reference = references.find(
            (r) => r.snapshotId === snapshotId,
          );
          if (!reference) return null;
          return resolvedScore(
            snapshotId,
            dimension,
            opts.reputationScore ?? 40,
            candidates
              .map((c) => c.profile)
              .find(
                (p) =>
                  p.organizationScopeId ===
                    versions.find((v) =>
                      v.sections.reputationReferences.some(
                        (r) => r.snapshotId === snapshotId,
                      ),
                    )?.organizationScopeId,
              ) ?? candidates[0]!.profile,
            reference.digest,
          );
        },
      },
      safety: {
        async activeHold() {
          return {
            held: opts.held === true,
            controlId: null,
            action: null,
          };
        },
      },
    },
    advisory: spyAdvisoryPort(spy),
    idempotency: harness.runtime.idempotency,
    auditWriter: harness.runtime.auditWriter,
    logger: SILENT_LOGGER,
  });
  return { service, runRepo, spy };
}

function personExecution(personId: string): ExecutionContext {
  return createExecutionContext({
    correlationId: "w016-ac03-spy",
    actor: { id: personId, kind: "person" },
  });
}

async function spyRun(
  service: CreatorMatchingService,
  input: Partial<RunCreatorMatchInput> & { readonly idempotencyKey: string },
): Promise<RunCreatorMatchResult> {
  return service.runMatch(personExecution(harness.operatorPersonId), {
    organizationScopeId: harness.organizationScopeId,
    requirements: baselineRequirements(),
    ...input,
  } as RunCreatorMatchInput);
}

describe("NET-W016-AC-03 advisory is non-authoritative (AI-002)", () => {
  test("advisory is DISABLED by default: pure deterministic ranking, no provider consulted", async () => {
    const candidate = await createMatchCandidate(harness);
    const { run } = await runMatch(harness, {
      requirements: baselineRequirements(),
      candidateProfileIds: [candidate.profile.id],
      idempotencyKey: key("w016-ac03-disabled"),
    });
    expect(run.advisory).toEqual({
      used: false,
      blend: 0,
      provider: null,
      modelRef: null,
    });
    expect(run.results[0]!.advisory).toBeNull();
    const relevance = run.results[0]!.signals.find(
      (s) => s.signal === "relevance",
    )!;
    expect(relevance.inputs).not.toHaveProperty("advisoryScore");
    expect(relevance.inputs).not.toHaveProperty("advisoryProvider");
  });

  test("enabled advisory blends into relevance under the capped weight, with provider identity recorded (bit-for-bit provider-input proof)", async () => {
    const candidate = await createMatchCandidate(harness);
    const { run } = await runMatch(harness, {
      requirements: baselineRequirements(),
      candidateProfileIds: [candidate.profile.id],
      advisory: { enabled: true, maxWeight: 10 },
      idempotencyKey: key("w016-ac03-enabled"),
    });
    expect(run.advisory.used).toBe(true);
    expect(run.advisory.blend).toBe(0.1);
    expect(run.advisory.provider).toBe("echo");
    expect(run.advisory.modelRef).toBe("echo-scoring-v1");
    const result = run.results[0]!;
    expect(result.advisory).not.toBeNull();
    expect(result.advisory!.provider).toBe("echo");

    // BIT-FOR-BIT provider-input proof: the composition-root adapter
    // feeds EXACTLY the privacy-minimized fact set (rebuilt here via
    // the exported builder) to the provider-neutral LlmPort with
    // purpose "matching" — reproducing the echo provider's
    // deterministic score reproduces the blended relevance exactly.
    const version = await harness.runtime.creatorService.getProfileVersion(
      personExecution(candidate.personId),
      harness.organizationScopeId,
      candidate.profile.id,
      candidate.profile.currentVersion!,
    );
    const resolve = async (role: string) => {
      const reference = version.sections.reputationReferences.find(
        (r) => r.role === role,
      )!;
      const snapshot = await harness.runtime.reputationSnapshotService.getSnapshot(
        personExecution(candidate.personId),
        reference.snapshotId,
      );
      return resolvedScore(
        snapshot.id,
        reference.dimension,
        snapshot.scores.find((s) => s.dimension === reference.dimension)!
          .score,
        candidate.profile,
        snapshot.digest,
      );
    };
    const facts = {
      profile: candidate.profile,
      version,
      sections: version.sections,
      reputation: {
        verified: true,
        failedRole: null,
        audienceInfluence: await resolve("audience_influence"),
        production: await resolve("production"),
      },
      safety: { held: false, controlId: null, action: null },
    };
    const neutralFacts = buildAdvisoryFacts(baselineRequirements(), facts);
    const scored = await harness.runtime.llmProvider.score({
      purpose: "matching",
      rubricRef: "creator-matching:NET-W016:1",
      neutralFacts,
    });
    const advisoryScore = Math.round(scored.score * 1000) / 10;
    expect(result.advisory!.score).toBe(advisoryScore);

    const relevance = result.signals.find((s) => s.signal === "relevance")!;
    expect(relevance.inputs.advisoryScore).toBe(advisoryScore);
    expect(relevance.inputs.advisoryProvider).toBe("echo");
    expect(relevance.inputs.advisoryModelRef).toBe("echo-scoring-v1");
    expect(relevance.inputs.advisoryBlend).toBe(0.1);
    expect(relevance.inputs.deterministicScore).toBe(100);
    expect(relevance.score).toBe(
      Math.round((0.9 * 100 + 0.1 * advisoryScore) * 10) / 10,
    );
  });

  test("STRUCTURAL: hard-gated candidates are excluded BEFORE the advisory is ever consulted", async () => {
    const eligible = await createMatchCandidate(harness);
    const gated = await createMatchCandidate(harness, {
      acceptingWork: false,
    });
    const { service, spy } = await createSpyService(
      [eligible, gated],
      createSpyAdvisory(() => 100),
    );
    const { run } = await spyRun(service, {
      candidateProfileIds: [eligible.profile.id, gated.profile.id],
      advisory: { enabled: true, maxWeight: 25 },
      idempotencyKey: key("w016-ac03-never"),
    });
    // The advisory was consulted EXACTLY once — for the eligible
    // candidate only. The hard-gated candidate never reached it.
    expect(spy.calls).toHaveLength(1);
    expect(run.excluded).toHaveLength(1);
    expect(run.excluded[0]!.profileId).toBe(gated.profile.id);
    expect(run.excluded[0]!.failedReasons).toContain("not_accepting_work");
    expect(run.results).toHaveLength(1);
    expect(run.results[0]!.profileId).toBe(eligible.profile.id);
    // Even an all-100 advisory cannot resurrect the gated candidate.
    expect(
      run.results.map((r) => r.profileId),
    ).not.toContain(gated.profile.id);
  });

  test("BOUND: the advisory's influence on the TOTAL score is capped by the blend × relevance weight", async () => {
    const candidate = await createMatchCandidate(harness);
    const withZero = createSpyAdvisory(() => 0);
    const withHundred = createSpyAdvisory(() => 100);
    const zeroService = await createSpyService([candidate], withZero);
    const hundredService = await createSpyService([candidate], withHundred);
    const zero = await spyRun(zeroService.service, {
      candidateProfileIds: [candidate.profile.id],
      advisory: { enabled: true, maxWeight: 25 },
      idempotencyKey: key("w016-ac03-bound-0"),
    });
    const hundred = await spyRun(hundredService.service, {
      candidateProfileIds: [candidate.profile.id],
      advisory: { enabled: true, maxWeight: 25 },
      idempotencyKey: key("w016-ac03-bound-100"),
    });
    // Deterministic relevance is 100 (no constraints): advisory 0 →
    // 75, advisory 100 → 100. Total difference = 25 × 30% = 7.5 —
    // the advisory can NEVER move a total by more than
    // maxWeight × relevanceWeight / 100.
    const zeroRelevance = zero.run.results[0]!.signals.find(
      (s) => s.signal === "relevance",
    )!;
    const hundredRelevance = hundred.run.results[0]!.signals.find(
      (s) => s.signal === "relevance",
    )!;
    expect(zeroRelevance.score).toBe(75);
    expect(hundredRelevance.score).toBe(100);
    expect(
      hundred.run.results[0]!.totalScore -
        zero.run.results[0]!.totalScore,
    ).toBe(7.5);
    expect(zero.run.advisory.provider).toBe("spy-advisory");
    expect(hundred.run.results[0]!.advisory!.modelRef).toBe("spy-model-v1");
  });

  test("CAP VALIDATION: maxWeight above 25 is rejected; 25 is the boundary", async () => {
    const candidate = await createMatchCandidate(harness);
    await expect(
      runMatch(harness, {
        requirements: baselineRequirements(),
        candidateProfileIds: [candidate.profile.id],
        advisory: { enabled: true, maxWeight: 26 },
        idempotencyKey: key("w016-ac03-cap-26"),
      }),
    ).rejects.toThrow(InvalidCreatorMatchError);
    const boundary = await runMatch(harness, {
      requirements: baselineRequirements(),
      candidateProfileIds: [candidate.profile.id],
      advisory: { enabled: true, maxWeight: 25 },
      idempotencyKey: key("w016-ac03-cap-25"),
    });
    expect(boundary.run.advisory.blend).toBe(0.25);
  });

  test("PRIVACY: the advisory input is the privacy-minimized neutral-fact set (closed labels; no rates/restrictions/reputation/identity)", async () => {
    const candidate = await createMatchCandidate(harness, {
      rates: [
        {
          format: "short_video",
          unit: "per_deliverable",
          amount: 777.77,
          currency: "USD",
        },
      ],
      restrictedTopics: ["confidential-topic"],
      restrictedTerritories: ["ZZ"],
    });
    const { service, spy } = await createSpyService(
      [candidate],
      createSpyAdvisory(() => 50),
      { reputationScore: 66 },
    );
    await spyRun(service, {
      candidateProfileIds: [candidate.profile.id],
      advisory: { enabled: true },
      idempotencyKey: key("w016-ac03-privacy"),
    });
    expect(spy.calls).toHaveLength(1);
    const input = spy.calls[0]!;
    expect(input.rubricRef).toBe("creator-matching:NET-W016:1");
    // The CLOSED label set (exactly these labels, nothing else).
    expect(input.neutralFacts.map((f) => f.label)).toEqual([
      "campaign_required_formats",
      "campaign_required_languages",
      "campaign_target_territories",
      "campaign_topics",
      "creator_platform_kinds",
      "creator_format_capabilities",
      "creator_languages",
      "creator_audience_size_band",
      "creator_audience_engagement_band",
      "creator_audience_top_geographies",
    ]);
    // NO rates, NO restricted topics/territories, NO reputation
    // scores, NO identity material may appear in ANY fact value.
    const allValues = input.neutralFacts.map((f) => f.value).join("\n");
    expect(allValues).not.toContain("777.77");
    expect(allValues).not.toContain("confidential-topic");
    expect(allValues).not.toContain("ZZ");
    expect(allValues).not.toContain("66");
    expect(allValues).not.toContain(candidate.personId);
    expect(allValues).not.toContain(candidate.profile.id);
    // The public aggregate facts ARE present.
    expect(allValues).toContain("short_video");
    expect(allValues).toContain("en");
    expect(allValues).toContain("10k_100k");
    expect(allValues).toContain("high");
    expect(allValues).toContain("GH:40");
  });
});
