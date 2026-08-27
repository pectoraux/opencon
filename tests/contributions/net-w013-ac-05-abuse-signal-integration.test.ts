/**
 * NET-W013-AC-05 — spam/abuse conclusions integrate into the EXISTING
 * /disputes risk authority (FRAUD-001..003) — never a second fraud
 * authority.
 *
 * A moderation decision carrying a spam/abuse reason emits ONE
 * evidence-backed risk signal through riskSignalService.createSignal
 * (the composition-root composite is the ONLY emission path): the
 * subject is the CONTRIBUTOR, the subjectRef is the contribution, the
 * sources are the moderation decision + the contribution, and the
 * provenance is manual_review with the net-w013-moderation detection
 * identity. The signal then participates in ordinary multi-signal
 * risk assessments.
 */
import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import {
  createNetW013Harness,
  createQualifiedContribution,
  recordModerationDecision,
  moderatorCtx,
  key,
  type NetW013Harness,
} from "./_net-w013-harness.ts";

let harness: NetW013Harness;

beforeAll(async () => {
  harness = await createNetW013Harness();
});

afterAll(async () => {
  await harness.teardown();
});

/** List the contributor's risk signals (the W009 authority). */
async function contributorSignals() {
  return harness.runtime.riskSignalService.listSignals(
    harness.bootstrapCtx,
    harness.organizationScopeId,
    harness.contributorPersonId,
  );
}

describe("NET-W013-AC-05 abuse-signal integration into /disputes", () => {
  test("a REJECT+spam decision emits ONE evidence-backed risk signal into the EXISTING risk authority", async () => {
    const { contribution } = await createQualifiedContribution(harness);
    const signalsBefore = await contributorSignals();
    const result = await recordModerationDecision(harness, contribution.id, {
      decision: "REJECT",
      reasonKinds: ["spam"],
      notes: "unsolicited repetition",
    });
    expect(result.signalCreated).toBe(true);
    const signal = result.riskSignal as Record<string, unknown>;
    expect(signal.category).toBe("spam");
    expect(signal.subjectPersonId).toBe(harness.contributorPersonId);
    expect(signal.subjectRef).toEqual({
      subjectType: "contribution",
      subjectId: contribution.id,
    });
    expect(signal.advisory).toBe(false); // manual_review provenance
    const provenance = signal.provenance as Record<string, unknown>;
    expect(provenance.kind).toBe("manual_review");
    expect(provenance.detectionMethod).toBe("net-w013-moderation");
    const sources = provenance.sources as readonly {
      kind: string;
      id: string;
    }[];
    expect(sources).toEqual([
      { kind: "moderation_decision", id: result.decision.id },
      { kind: "contribution", id: contribution.id },
    ]);

    // The signal is IN the /disputes authority (exactly one new one).
    const signalsAfter = await contributorSignals();
    expect(signalsAfter.length).toBe(signalsBefore.length + 1);
  });

  test("an abuse classification emits the ABUSE category; non-abuse decisions emit NOTHING", async () => {
    const spam = await createQualifiedContribution(harness);
    const abuse = await createQualifiedContribution(harness);
    const clean = await createQualifiedContribution(harness);
    const offTopic = await createQualifiedContribution(harness);

    const spamResult = await recordModerationDecision(harness, spam.contribution.id, {
      decision: "REJECT",
      reasonKinds: ["spam", "policy_violation"],
    });
    expect((spamResult.riskSignal as Record<string, unknown>).category).toBe("spam");

    const abuseResult = await recordModerationDecision(harness, abuse.contribution.id, {
      decision: "REJECT",
      reasonKinds: ["abuse"],
    });
    expect((abuseResult.riskSignal as Record<string, unknown>).category).toBe("abuse");

    // APPROVE + no_violation → NO signal.
    const cleanResult = await recordModerationDecision(harness, clean.contribution.id, {
      decision: "APPROVE",
      reasonKinds: ["no_violation"],
    });
    expect(cleanResult.riskSignal).toBeNull();
    expect(cleanResult.signalCreated).toBe(false);

    // Non-abuse REJECT reasons → NO signal.
    const offTopicResult = await recordModerationDecision(harness, offTopic.contribution.id, {
      decision: "REJECT",
      reasonKinds: ["off_topic", "low_evidence_quality"],
    });
    expect(offTopicResult.riskSignal).toBeNull();
  });

  test("the moderation composite replays idempotently: the SAME key emits exactly ONE signal", async () => {
    const { contribution } = await createQualifiedContribution(harness);
    const k = key("w013-signal-replay");
    const first = await recordModerationDecision(harness, contribution.id, {
      decision: "REJECT",
      reasonKinds: ["spam"],
      idempotencyKey: k,
    });
    expect(first.signalCreated).toBe(true);
    const second = await recordModerationDecision(harness, contribution.id, {
      decision: "REJECT",
      reasonKinds: ["spam"],
      idempotencyKey: k,
    });
    expect(second.decision.id).toBe(first.decision.id);
    expect(second.signalCreated).toBe(false); // the :signal key replayed
    expect((second.riskSignal as Record<string, unknown>).id).toBe(
      (first.riskSignal as Record<string, unknown>).id,
    );
    const signals = await contributorSignals();
    const matching = signals.filter(
      (s) => s.subjectRef?.subjectId === contribution.id,
    );
    expect(matching.length).toBe(1);
  });

  test("the spam signal participates in ordinary MULTI-SIGNAL risk assessments (FRAUD-001: no single signal is authoritative)", async () => {
    const { contribution } = await createQualifiedContribution(harness);
    await recordModerationDecision(harness, contribution.id, {
      decision: "REJECT",
      reasonKinds: ["spam"],
      signalSeverity: "HIGH",
    });
    // A risk policy that consumes the spam category (an explicit rule
    // — the category is never ambiently authoritative).
    const spamPolicy = await harness.runtime.riskPolicyService.createPolicyVersion(
      moderatorCtx(harness, "w013-risk-policy"),
      {
        organizationScopeId: harness.organizationScopeId,
        policyId: key("w013-risk-policy"),
        version: 1,
        description: "NET-W013 integration risk policy",
        rules: [
          {
            category: "spam",
            weight: 1,
            advisoryWeightFactor: 0.25,
            severityPoints: { LOW: 1, MEDIUM: 2, HIGH: 4, CRITICAL: 8 },
          },
        ],
        thresholds: { watch: 2, review: 4, hold: 8, blocked: 12 },
        criticalFloorState: "HOLD",
        advisoryOnlyCapState: "REVIEW",
        requiredCategories: [],
        missingDataState: "REVIEW",
      },
    );
    const assessmentResult =
      await harness.runtime.riskAssessmentService.recordAssessment(
        moderatorCtx(harness, "w013-risk-assessment"),
        {
          organizationScopeId: harness.organizationScopeId,
          subjectPersonId: harness.contributorPersonId,
          subjectRef: { subjectType: "contribution", subjectId: contribution.id },
          policyId: spamPolicy.policyId,
          version: 1,
          evaluatedAt: "2026-01-02T03:04:05.000Z",
          idempotencyKey: key("w013-risk-assessment"),
        },
      );
    const assessment = assessmentResult.assessment;
    // The contributor's signals (this suite's earlier emissions share
    // the fixture contributor) all participate: the assessment
    // consumes them as ORDINARY multi-signal inputs — the spam
    // category is consumed ONLY through the explicit rule (never
    // ambient authority), and the state is at least WATCH (the HIGH
    // spam signal's 4 points ≥ the 2-point watch threshold).
    const { riskStateRank } = await import("../../src/core/risk.ts");
    expect(riskStateRank(assessment.state as never)).toBeGreaterThanOrEqual(
      riskStateRank("WATCH"),
    );
    const spamContributions = assessment.contributions.filter(
      (c) => c.category === "spam",
    );
    expect(spamContributions.length).toBeGreaterThanOrEqual(1);
    expect(spamContributions[0]!.points).toBeGreaterThan(0);
    expect(spamContributions[0]!.advisory).toBe(false);
    // THIS contribution's signal is among the consumed set.
    const thisSignal = assessment.contributions.find(
      (c) => c.category === "spam" && c.signalId !== "",
    );
    expect(thisSignal).toBeDefined();
    expect(assessment.signalIds.length).toBeGreaterThanOrEqual(1);
  });

  test("the emission is tenant-isolated (a second-org decision never creates a first-org signal)", async () => {
    const { contribution } = await createQualifiedContribution(harness);
    const before = await contributorSignals();
    // A moderator in the SECOND org attempts to decide on the FIRST
    // org's contribution — the domain rejects the cross-scope record.
    await expect(
      harness.runtime.moderationService.recordModerationDecision(
        moderatorCtx(harness, "w013-cross-decide"),
        {
          contributionId: contribution.id,
          organizationScopeId: harness.secondOrgId,
          decision: "REJECT",
          reasonKinds: ["spam"],
          idempotencyKey: key("w013-cross-decide"),
        },
      ),
    ).rejects.toThrow(/belongs to organization scope/i);
    const after = await contributorSignals();
    expect(after.length).toBe(before.length);
  });

  test("the quality/moderation DOMAIN never calls the risk authority (the emission is composition-root only)", async () => {
    const { readFile } = await import("node:fs/promises");
    const { join } = await import("node:path");
    const { readdir } = await import("node:fs/promises");
    const dir = "src/contributions";
    const entries = await readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith(".ts")) continue;
      const content = await readFile(join(dir, entry.name), "utf8");
      expect(
        content,
        `${entry.name} must not call the risk authority`,
      ).not.toMatch(/\bcreateSignal\b/);
      expect(content).not.toMatch(/\briskSignalService\b/);
      expect(content).not.toMatch(/\briskControlService\b/);
    }
  });
});
