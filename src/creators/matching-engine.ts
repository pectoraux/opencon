/**
 * The NET-W016 creator matching engine — PURE and DETERMINISTIC.
 *
 * Architecture ref: spec/architecture.md §18 (Module ownership:
 * `/creators` owns creator domain rules — creator matching is a
 * creator-domain rule), §14 (AI outputs remain
 * recommendations/evidence inputs, never unilateral truth), §19
 * (AI never establishes eligibility); spec/architecture-lock.md §2
 * (the frozen core domains — NO 17th domain), §3 (PostgreSQL
 * authoritative — the engine itself performs NO I/O), §12
 * (execution lineage), §14 (provider neutrality).
 *
 * Work order ref: spec/work-orders/NET-W016.md
 *   §3.1 The deterministic eligibility gates (closed reason
 *        vocabulary; conjunction semantics; complete traces).
 *   §3.2 Ranking by explicit signals (six CRE-002 signals, explicit
 *        weights, deterministic total order).
 *   §3.3 The advisory blend — bounded, relevance-only, structurally
 *        unable to flip eligibility.
 *   §3.4 The deterministic digest (canonical serialization at
 *        fixed precision — the reputation-digest precedent).
 *
 * Requirements: CRE-002 (match creators and campaigns by relevance,
 * audience quality, historic outcomes, safety, price and
 * availability), AI-002 (AI-assisted matching — advisory only).
 *
 * MATCHING IS SELECTION, NOT AUTHORITY (the work item's strongest
 * constraint): this engine is a pure function over resolved facts.
 * It mutates NOTHING — no workflow, no settlement, no reputation,
 * no risk state. All I/O (profile/version loads, reputation score
 * resolution, safety reads, the advisory call) happens in the
 * matching SERVICE before/around the engine; the engine receives
 * fully-resolved facts and returns verdicts, scores and digests.
 *
 * DETERMINISM: identical inputs produce identical outputs — every
 * numeric output is rounded to 1 decimal and the digest serializes
 * at that fixed precision (floating-point drift can never change a
 * digest; the NET-W007 scoring precedent). The ranked order is a
 * deterministic total order: totalScore DESC, then profileId ASC.
 *
 * Tier compliance: creators domain → self + core contracts only.
 */

import { createHash } from "node:crypto";
import {
  creatorAudienceSizeBandRank,
  creatorEngagementBandRank,
  type CreatorAudienceSizeBand,
  type CreatorMatchGateReason,
  type CreatorMatchSignal,
  type CreatorMatchWeightsShape,
} from "../core/creators.ts";
import type {
  CreatorMatchAdvisoryAssessment,
  CreatorMatchCandidateResult,
  CreatorMatchEligibility,
  CreatorMatchExcludedCandidate,
  CreatorMatchGateEvaluation,
  CreatorMatchRequirements,
  CreatorMatchRunRecord,
  CreatorMatchSafetyView,
  CreatorMatchSignalScore,
  CreatorProfileRecord,
  CreatorProfileSections,
  CreatorProfileVersion,
  ResolvedCreatorReputationScore,
} from "./port.ts";

/** Fixed 1-decimal rounding (deterministic digests). */
export function round1(value: number): number {
  return Math.round(value * 10) / 10;
}

// ---------------------------------------------------------------------------
// The resolved candidate facts (the engine's only per-candidate input)
// ---------------------------------------------------------------------------

/**
 * The per-candidate reputation facts, already VERIFIED by the
 * service (existence + org scope + subject person + pinned digest +
 * frozen dimension — the W015 reference-verification semantics
 * re-applied at match time). `verified` false fails the
 * `reputation_reference_unresolvable` hard gate.
 */
export interface CreatorMatchReputationFacts {
  readonly verified: boolean;
  /** Which role failed verification (when !verified). */
  readonly failedRole: string | null;
  readonly audienceInfluence: ResolvedCreatorReputationScore | null;
  readonly production: ResolvedCreatorReputationScore | null;
}

/**
 * Everything the pure engine needs about ONE candidate: the pinned
 * profile record + versioned sections + the verified reputation
 * facts + the safety read. Assembled by the matching service (all
 * I/O outside the engine).
 */
export interface CreatorMatchCandidateFacts {
  readonly profile: CreatorProfileRecord;
  readonly version: CreatorProfileVersion | null;
  readonly sections: CreatorProfileSections | null;
  readonly reputation: CreatorMatchReputationFacts;
  readonly safety: CreatorMatchSafetyView;
}

// ---------------------------------------------------------------------------
// Hard-gate evaluation (work order §3.1; AC-01)
// ---------------------------------------------------------------------------

function gate(
  reason: CreatorMatchGateReason,
  passed: boolean,
  detail: string | null,
): CreatorMatchGateEvaluation {
  return { gate: reason, passed, detail };
}

function caseInsensitiveSet(values: readonly string[]): Set<string> {
  return new Set(values.map((v) => v.trim().toLowerCase()));
}

/**
 * Evaluate the deterministic hard gates for one candidate against
 * the effective requirements. Every APPLICABLE gate is evaluated
 * (no short-circuit) so the trace is complete; eligibility is the
 * conjunction of all gates. The closed reason vocabulary is
 * `CREATOR_MATCH_GATE_REASONS` (core/creators.ts).
 */
export function evaluateEligibility(
  facts: CreatorMatchCandidateFacts,
  requirements: CreatorMatchRequirements,
): CreatorMatchEligibility {
  const gates: CreatorMatchGateEvaluation[] = [];
  const failed: CreatorMatchGateReason[] = [];
  const fail = (reason: CreatorMatchGateReason, detail: string | null) => {
    gates.push(gate(reason, false, detail));
    failed.push(reason);
  };
  const pass = (reason: CreatorMatchGateReason, detail: string | null) => {
    gates.push(gate(reason, true, detail));
  };

  const sections = facts.sections;

  // -- record-level gates (apply with or without sections) ---------
  if (sections === null || facts.version === null) {
    fail("no_profile_version", "the profile has no versioned sections");
  } else {
    pass("no_profile_version", `version ${String(facts.version.version)}`);
  }

  if (facts.profile.status !== "ACTIVE") {
    fail(
      "profile_not_active",
      `administrative status is ${facts.profile.status}`,
    );
  } else {
    pass("profile_not_active", "ACTIVE");
  }

  if (facts.safety.held) {
    fail(
      "active_risk_control",
      facts.safety.controlId
        ? `active participant_eligibility control ${facts.safety.controlId} (${facts.safety.action ?? "UNKNOWN"})`
        : "active participant_eligibility control",
    );
  } else {
    pass("active_risk_control", "no active control");
  }

  if (!facts.reputation.verified) {
    fail(
      "reputation_reference_unresolvable",
      facts.reputation.failedRole
        ? `the ${facts.reputation.failedRole} reputation reference failed re-verification`
        : "a reputation reference failed re-verification",
    );
  } else {
    pass("reputation_reference_unresolvable", "references re-verified");
  }

  // -- section-level gates (skipped when there are no sections) ----
  if (sections !== null) {
    const offeredFormats = new Set(
      sections.platforms.flatMap((p) => [...p.capabilities]),
    );
    const publishedLanguages = new Set(
      sections.platforms.flatMap((p) => [...p.languages]),
    );

    if (!sections.availability.acceptingWork) {
      fail("not_accepting_work", "availability.acceptingWork is false");
    } else {
      pass("not_accepting_work", "accepting work");
    }

    if (sections.availability.weeklyCapacity <= 0) {
      fail(
        "no_capacity",
        `weeklyCapacity is ${String(sections.availability.weeklyCapacity)}`,
      );
    } else {
      pass(
        "no_capacity",
        `weeklyCapacity ${String(sections.availability.weeklyCapacity)}`,
      );
    }

    if (requirements.noticeWindowDays !== null) {
      if (
        sections.availability.minimumNoticeDays > requirements.noticeWindowDays
      ) {
        fail(
          "notice_window_exceeded",
          `minimumNoticeDays ${String(sections.availability.minimumNoticeDays)} > noticeWindowDays ${String(requirements.noticeWindowDays)}`,
        );
      } else {
        pass(
          "notice_window_exceeded",
          `notice ${String(sections.availability.minimumNoticeDays)}d within ${String(requirements.noticeWindowDays)}d`,
        );
      }
    }

    if (!sections.participation.acceptsDirectCampaigns) {
      fail(
        "direct_campaigns_not_accepted",
        "participation.acceptsDirectCampaigns is false",
      );
    } else {
      pass("direct_campaigns_not_accepted", "direct campaigns accepted");
    }

    if (sections.participation.requiresInvitation) {
      fail("invitation_required", "participation.requiresInvitation is true");
    } else {
      pass("invitation_required", "no invitation required");
    }

    if (requirements.requiredFormats.length > 0) {
      const missing = requirements.requiredFormats.filter(
        (f) => !offeredFormats.has(f),
      );
      if (missing.length > 0) {
        fail("format_unsupported", `unsupported formats: ${missing.join(", ")}`);
      } else {
        pass(
          "format_unsupported",
          `all required formats offered: ${requirements.requiredFormats.join(", ")}`,
        );
      }
    }

    if (requirements.requiredFormats.length > 0) {
      const restricted = requirements.requiredFormats.filter((f) =>
        sections.restrictions.restrictedFormats.includes(f),
      );
      if (restricted.length > 0) {
        fail(
          "format_restricted",
          `restricted formats: ${restricted.join(", ")}`,
        );
      } else {
        pass("format_restricted", "no required format restricted");
      }
    }

    if (requirements.requiredLanguages.length > 0) {
      const missing = requirements.requiredLanguages.filter(
        (l) => !publishedLanguages.has(l),
      );
      if (missing.length > 0) {
        fail(
          "language_unsupported",
          `unsupported languages: ${missing.join(", ")}`,
        );
      } else {
        pass(
          "language_unsupported",
          `all required languages published: ${requirements.requiredLanguages.join(", ")}`,
        );
      }
    }

    if (requirements.targetTerritories.length > 0) {
      const audienceTerritories = new Set(
        sections.audience.topGeographies.map((g) => g.territory),
      );
      const reached = requirements.targetTerritories.filter((t) =>
        audienceTerritories.has(t),
      );
      if (reached.length === 0) {
        fail(
          "territory_unsupported",
          `audience does not reach any target territory: ${requirements.targetTerritories.join(", ")}`,
        );
      } else {
        pass(
          "territory_unsupported",
          `audience reaches: ${reached.join(", ")}`,
        );
      }
    }

    if (requirements.targetTerritories.length > 0) {
      const blocked = requirements.targetTerritories.filter((t) =>
        sections.restrictions.restrictedTerritories.includes(t),
      );
      if (blocked.length > 0) {
        fail(
          "territory_restricted",
          `restricted target territories: ${blocked.join(", ")}`,
        );
      } else {
        pass("territory_restricted", "no target territory restricted");
      }
    }

    if (requirements.campaignTopics.length > 0) {
      const restrictedTopics = caseInsensitiveSet(
        sections.restrictions.restrictedTopics,
      );
      const blocked = requirements.campaignTopics.filter((t) =>
        restrictedTopics.has(t.trim().toLowerCase()),
      );
      if (blocked.length > 0) {
        fail(
          "topic_restricted",
          `restricted campaign topics: ${blocked.join(", ")}`,
        );
      } else {
        pass("topic_restricted", "no campaign topic restricted");
      }
    }

    if (requirements.requiredRightsKinds.length > 0) {
      const granted = new Set(sections.rights.map((r) => r.kind));
      const missing = requirements.requiredRightsKinds.filter(
        (k) => !granted.has(k),
      );
      if (missing.length > 0) {
        fail("rights_not_granted", `ungranted rights: ${missing.join(", ")}`);
      } else {
        pass(
          "rights_not_granted",
          `all required rights granted: ${requirements.requiredRightsKinds.join(", ")}`,
        );
      }
    }

    if (requirements.rateCeiling !== null) {
      const ceiling = requirements.rateCeiling;
      const qualifying = sections.commercial.rates.filter(
        (r) =>
          requirements.requiredFormats.includes(r.format) &&
          r.currency === ceiling.currency &&
          r.unit === ceiling.unit &&
          r.amount <= ceiling.amount,
      );
      if (qualifying.length === 0) {
        fail(
          "rate_exceeds_ceiling",
          `no rate for a required format within ${ceiling.currency} ${String(ceiling.amount)} (${ceiling.unit})`,
        );
      } else {
        pass(
          "rate_exceeds_ceiling",
          `cheapest qualifying rate ${qualifying[0]!.currency} ${String(qualifying[0]!.amount)}`,
        );
      }
    }

    if (requirements.minimumAudienceSizeBand !== null) {
      const floor = creatorAudienceSizeBandRank(
        requirements.minimumAudienceSizeBand,
      );
      const actual = creatorAudienceSizeBandRank(sections.audience.sizeBand);
      if (actual < floor) {
        fail(
          "audience_band_below_minimum",
          `audience sizeBand ${sections.audience.sizeBand} is below the required ${requirements.minimumAudienceSizeBand}`,
        );
      } else {
        pass(
          "audience_band_below_minimum",
          `sizeBand ${sections.audience.sizeBand} ≥ ${requirements.minimumAudienceSizeBand}`,
        );
      }
    }

    if (
      requirements.minimumReputation.audienceInfluence !== null ||
      requirements.minimumReputation.production !== null
    ) {
      const failures: string[] = [];
      if (requirements.minimumReputation.audienceInfluence !== null) {
        const score = facts.reputation.audienceInfluence?.score;
        if (
          score === undefined ||
          score < requirements.minimumReputation.audienceInfluence
        ) {
          failures.push(
            `audience_influence ${score === undefined ? "unresolved" : String(score)} < ${String(requirements.minimumReputation.audienceInfluence)}`,
          );
        }
      }
      if (requirements.minimumReputation.production !== null) {
        const score = facts.reputation.production?.score;
        if (
          score === undefined ||
          score < requirements.minimumReputation.production
        ) {
          failures.push(
            `production ${score === undefined ? "unresolved" : String(score)} < ${String(requirements.minimumReputation.production)}`,
          );
        }
      }
      if (failures.length > 0) {
        fail("reputation_below_minimum", failures.join("; "));
      } else {
        pass("reputation_below_minimum", "canonical scores meet thresholds");
      }
    }
  }

  return {
    eligible: failed.length === 0,
    gates: Object.freeze(gates),
    failedReasons: Object.freeze(failed),
  };
}

// ---------------------------------------------------------------------------
// Signal scoring (work order §3.2; AC-02)
// ---------------------------------------------------------------------------

function engagementBandScore(band: string): number {
  // low = 0 … very_high = 100 (ordinal over the closed vocabulary).
  const ranks = ["low", "medium", "high", "very_high"];
  const rank = ranks.indexOf(band);
  if (rank < 0) return 0;
  return round1((rank / (ranks.length - 1)) * 100);
}

/**
 * The price signal: affordability headroom against the declared rate
 * ceiling. The cheapest qualifying rate (required format, ceiling
 * currency + unit) maps linearly: rate = ceiling → 0; rate = 0 → 100.
 * No ceiling declared → 100 (price unconstrained).
 */
export function priceSignalScore(
  sections: CreatorProfileSections,
  requirements: CreatorMatchRequirements,
): number {
  const ceiling = requirements.rateCeiling;
  if (ceiling === null) {
    return 100;
  }
  const qualifying = sections.commercial.rates
    .filter(
      (r) =>
        requirements.requiredFormats.includes(r.format) &&
        r.currency === ceiling.currency &&
        r.unit === ceiling.unit,
    )
    .map((r) => r.amount);
  if (qualifying.length === 0) {
    return 0;
  }
  const cheapest = Math.min(...qualifying);
  const headroom = (100 * (ceiling.amount - cheapest)) / ceiling.amount;
  return round1(Math.max(0, Math.min(100, headroom)));
}

/**
 * Score the six explicit CRE-002 signals for one ELIGIBLE candidate.
 * Every signal carries the inputs it used (the machine-readable
 * explanation). The advisory assessment (when present) blends ONLY
 * into `relevance` under the capped blend — there is no path from
 * advisory output to any other signal or to eligibility.
 */
export function scoreCandidate(
  facts: CreatorMatchCandidateFacts,
  requirements: CreatorMatchRequirements,
  weights: CreatorMatchWeightsShape,
  advisory: CreatorMatchAdvisoryAssessment | null,
  blend: number,
): readonly CreatorMatchSignalScore[] {
  const sections = facts.sections!;
  const offeredFormats = new Set(
    sections.platforms.flatMap((p) => [...p.capabilities]),
  );
  const publishedLanguages = new Set(
    sections.platforms.flatMap((p) => [...p.languages]),
  );

  // -- relevance: format coverage + language coverage + territory
  //    alignment (share of the audience inside target territories,
  //    capped at 100; 100 when no targets are declared).
  const formatCoverage =
    requirements.requiredFormats.length === 0
      ? 100
      : (100 *
          requirements.requiredFormats.filter((f) => offeredFormats.has(f))
            .length) /
        requirements.requiredFormats.length;
  const languageCoverage =
    requirements.requiredLanguages.length === 0
      ? 100
      : (100 *
          requirements.requiredLanguages.filter((l) =>
            publishedLanguages.has(l),
          ).length) /
        requirements.requiredLanguages.length;
  const targetSet = new Set(requirements.targetTerritories);
  const territoryAlignment =
    requirements.targetTerritories.length === 0
      ? 100
      : Math.min(
          100,
          sections.audience.topGeographies
            .filter((g) => targetSet.has(g.territory))
            .reduce((sum, g) => sum + g.share, 0),
        );
  const deterministicRelevance = round1(
    (formatCoverage + languageCoverage + territoryAlignment) / 3,
  );

  const signals: {
    signal: CreatorMatchSignal;
    score: number;
    inputs: Record<string, unknown>;
  }[] = [];

  if (advisory !== null && blend > 0) {
    const blended = round1(
      (1 - blend) * deterministicRelevance + blend * advisory.score,
    );
    signals.push({
      signal: "relevance",
      score: blended,
      inputs: {
        deterministicScore: deterministicRelevance,
        formatCoverage: round1(formatCoverage),
        languageCoverage: round1(languageCoverage),
        territoryAlignment: round1(territoryAlignment),
        advisoryScore: advisory.score,
        advisoryProvider: advisory.provider,
        advisoryModelRef: advisory.modelRef,
        advisoryBlend: blend,
      },
    });
  } else {
    signals.push({
      signal: "relevance",
      score: deterministicRelevance,
      inputs: {
        formatCoverage: round1(formatCoverage),
        languageCoverage: round1(languageCoverage),
        territoryAlignment: round1(territoryAlignment),
      },
    });
  }

  // -- audience quality: engagement band blended 50/50 with the
  //    canonical audience_influence reference score.
  const engagement = engagementBandScore(sections.audience.engagementBand);
  const audienceScore = facts.reputation.audienceInfluence?.score ?? 0;
  signals.push({
    signal: "audience_quality",
    score: round1(0.5 * engagement + 0.5 * audienceScore),
    inputs: {
      engagementBand: sections.audience.engagementBand,
      engagementScore: engagement,
      audienceInfluenceScore: audienceScore,
      audienceInfluenceSnapshotId:
        facts.reputation.audienceInfluence?.snapshotId ?? null,
    },
  });

  // -- historic outcomes: the canonical production reference score.
  const productionScore = facts.reputation.production?.score ?? 0;
  signals.push({
    signal: "historic_outcomes",
    score: round1(productionScore),
    inputs: {
      productionScore,
      productionSnapshotId:
        facts.reputation.production?.snapshotId ?? null,
      productionDimension: facts.reputation.production?.dimension ?? null,
    },
  });

  // -- safety: the gate carries the semantics (held candidates are
  //    ineligible); the signal keeps the six-signal contract uniform.
  signals.push({
    signal: "safety",
    score: facts.safety.held ? 0 : 100,
    inputs: { activeControl: facts.safety.controlId },
  });

  // -- price: affordability headroom (see priceSignalScore).
  signals.push({
    signal: "price",
    score: priceSignalScore(sections, requirements),
    inputs: {
      rateCeiling: requirements.rateCeiling,
      cheapestQualifyingRate:
        requirements.rateCeiling === null
          ? null
          : (() => {
              const amounts = sections.commercial.rates
                .filter(
                  (r) =>
                    requirements.requiredFormats.includes(r.format) &&
                    r.currency === requirements.rateCeiling!.currency &&
                    r.unit === requirements.rateCeiling!.unit,
                )
                .map((r) => r.amount);
              return amounts.length === 0 ? null : Math.min(...amounts);
            })(),
    },
  });

  // -- availability: capacity headroom (each weekly slot is 25
  //    points; capacity ≥ 4 saturates).
  signals.push({
    signal: "availability",
    score: round1(Math.min(100, sections.availability.weeklyCapacity * 25)),
    inputs: {
      weeklyCapacity: sections.availability.weeklyCapacity,
      minimumNoticeDays: sections.availability.minimumNoticeDays,
    },
  });

  const weightOf = (signal: CreatorMatchSignal): number => {
    switch (signal) {
      case "relevance":
        return weights.relevance;
      case "audience_quality":
        return weights.audienceQuality;
      case "historic_outcomes":
        return weights.historicOutcomes;
      case "safety":
        return weights.safety;
      case "price":
        return weights.price;
      case "availability":
        return weights.availability;
    }
  };

  return Object.freeze(
    signals.map((s) => {
      const weight = weightOf(s.signal);
      return Object.freeze({
        signal: s.signal,
        score: s.score,
        weight,
        contribution: round1((s.score * weight) / 100),
        inputs: Object.freeze(s.inputs),
      } satisfies CreatorMatchSignalScore);
    }),
  );
}

/** totalScore = Σ rounded contributions (deterministic). */
export function totalScoreOf(
  signals: readonly CreatorMatchSignalScore[],
): number {
  return round1(signals.reduce((sum, s) => sum + s.contribution, 0));
}

// ---------------------------------------------------------------------------
// Ranking (deterministic total order; AC-02)
// ---------------------------------------------------------------------------

export interface RankedCandidate {
  readonly facts: CreatorMatchCandidateFacts;
  readonly signals: readonly CreatorMatchSignalScore[];
  readonly totalScore: number;
  readonly advisory: CreatorMatchAdvisoryAssessment | null;
}

/**
 * Rank scored candidates: totalScore DESC, then profileId ASC — a
 * deterministic total order (no ties survive; identical inputs rank
identically). */
export function rankCandidates(
  scored: readonly RankedCandidate[],
): readonly (RankedCandidate & { readonly rank: number })[] {
  return [...scored]
    .sort((a, b) => {
      if (b.totalScore !== a.totalScore) return b.totalScore - a.totalScore;
      return a.facts.profile.id < b.facts.profile.id ? -1 : 1;
    })
    .map((c, index) => ({ ...c, rank: index + 1 }));
}

/** Build the ranked candidate result view (the run's `results`). */
export function buildCandidateResults(
  ranked: readonly (RankedCandidate & { readonly rank: number })[],
): readonly CreatorMatchCandidateResult[] {
  return Object.freeze(
    ranked.map((c) =>
      Object.freeze({
        profileId: c.facts.profile.id,
        creatorPersonId: c.facts.profile.creatorPersonId,
        displayName: c.facts.profile.displayName,
        profileVersion: c.facts.version?.version ?? 0,
        rank: c.rank,
        totalScore: c.totalScore,
        signals: c.signals,
        advisory: c.advisory
          ? {
              score: c.advisory.score,
              provider: c.advisory.provider,
              modelRef: c.advisory.modelRef,
            }
          : null,
      } satisfies CreatorMatchCandidateResult),
    ),
  );
}

/** Build the excluded-candidate view (the run's `excluded`). */
export function buildExcludedCandidates(
  factsList: readonly CreatorMatchCandidateFacts[],
  eligibilityOf: (
    facts: CreatorMatchCandidateFacts,
  ) => CreatorMatchEligibility,
): readonly CreatorMatchExcludedCandidate[] {
  return Object.freeze(
    factsList
      .map((facts) => ({ facts, eligibility: eligibilityOf(facts) }))
      .filter((c) => !c.eligibility.eligible)
      .sort((a, b) =>
        a.facts.profile.id < b.facts.profile.id ? -1 : 1,
      )
      .map((c) =>
        Object.freeze({
          profileId: c.facts.profile.id,
          creatorPersonId: c.facts.profile.creatorPersonId,
          displayName: c.facts.profile.displayName,
          profileVersion: c.facts.version?.version ?? null,
          failedReasons: c.eligibility.failedReasons,
        } satisfies CreatorMatchExcludedCandidate),
      ),
  );
}

// ---------------------------------------------------------------------------
// The deterministic digest (work order §3.4; AC-06)
// ---------------------------------------------------------------------------

/**
 * SHA-256 over the canonical serialization of a run's decision
 * content at fixed 1-decimal precision (the NET-W007
 * computeScoresDigest precedent): identical inputs + results →
 * identical digest. Re-running the same match reproduces it
 * bit-for-bit (advisory-off); with the advisory on, the provider
 * identity is part of the recorded decision.
 */
export function computeMatchDigest(
  run: Omit<
    CreatorMatchRunRecord,
    "digest" | "idempotencyKey" | "executionId" | "correlationId" | "causationId" | "id" | "createdBy" | "createdAt"
  >,
): string {
  const canonical = JSON.stringify({
    formatVersion: run.formatVersion,
    organizationScopeId: run.organizationScopeId,
    campaign: run.campaign
      ? [run.campaign.campaignId, run.campaign.policyVersion]
      : null,
    requirements: {
      requiredFormats: [...run.requirements.requiredFormats].sort(),
      requiredLanguages: [...run.requirements.requiredLanguages].sort(),
      targetTerritories: [...run.requirements.targetTerritories].sort(),
      campaignTopics: [...run.requirements.campaignTopics].sort(),
      requiredRightsKinds: [...run.requirements.requiredRightsKinds].sort(),
      rateCeiling: run.requirements.rateCeiling
        ? [
            run.requirements.rateCeiling.amount.toFixed(2),
            run.requirements.rateCeiling.currency,
            run.requirements.rateCeiling.unit,
          ]
        : null,
      minimumAudienceSizeBand: run.requirements.minimumAudienceSizeBand,
      minimumReputation: run.requirements.minimumReputation,
      noticeWindowDays: run.requirements.noticeWindowDays,
    },
    weights: run.weights,
    advisory: [
      run.advisory.used,
      run.advisory.blend.toFixed(2),
      run.advisory.provider,
      run.advisory.modelRef,
    ],
    candidateCount: run.candidateCount,
    eligibleCount: run.eligibleCount,
    results: run.results.map((r) => [
      r.profileId,
      r.profileVersion,
      r.rank,
      r.totalScore.toFixed(1),
      r.signals.map((s) => [
        s.signal,
        s.score.toFixed(1),
        s.weight,
        s.contribution.toFixed(1),
      ]),
      r.advisory ? [r.advisory.score.toFixed(1), r.advisory.provider] : null,
    ]),
    excluded: run.excluded.map((e) => [
      e.profileId,
      e.profileVersion,
      [...e.failedReasons].sort(),
    ]),
  });
  return createHash("sha256").update(canonical, "utf8").digest("hex");
}
