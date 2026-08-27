/**
 * NET-W013-AC-04 — moderation is auditable with append-only history.
 *
 * Decisions are immutable records; the current moderation status is
 * DERIVED from the latest decision (never stored, never rewritten);
 * only an authenticated PERSON actor may decide (moderator-controlled);
 * cited quality evaluations must belong to the same contribution in
 * the same organization; decisions never transition workflow state.
 */
import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import {
  createNetW013Harness,
  createQualityPolicy,
  createQualifiedContribution,
  recordQualityEvaluation,
  recordModerationDecision,
  moderatorCtx,
  contributorCtx,
  systemCtx,
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

describe("NET-W013-AC-04 moderation append-only + auditable", () => {
  test("decisions are immutable append-only history and the status is DERIVED from the latest", async () => {
    const { contribution } = await createQualifiedContribution(harness);

    // Initially UNMODERATED.
    const before = await harness.runtime.moderationService.getModerationSummary(
      harness.bootstrapCtx,
      contribution.id,
    );
    expect(before.status).toBe("UNMODERATED");
    expect(before.latestDecision).toBeNull();
    expect(before.decisionCount).toBe(0);

    // FLAG_FOR_REVIEW → FLAGGED_FOR_REVIEW.
    const flag = await recordModerationDecision(harness, contribution.id, {
      decision: "FLAG_FOR_REVIEW",
      reasonKinds: ["low_evidence_quality"],
    });
    expect(flag.riskSignal).toBeNull(); // no spam/abuse → NO signal
    let summary = await harness.runtime.moderationService.getModerationSummary(
      harness.bootstrapCtx,
      contribution.id,
    );
    expect(summary.status).toBe("FLAGGED_FOR_REVIEW");
    expect(summary.decisionCount).toBe(1);

    // REJECT (spam) → REJECTED (+ the risk signal; covered in AC-05).
    const reject = await recordModerationDecision(harness, contribution.id, {
      decision: "REJECT",
      reasonKinds: ["spam"],
    });
    expect(reject.decision.decision).toBe("REJECT");
    summary = await harness.runtime.moderationService.getModerationSummary(
      harness.bootstrapCtx,
      contribution.id,
    );
    expect(summary.status).toBe("REJECTED");
    expect(summary.decisionCount).toBe(2);

    // A LATER APPROVE appends (never rewrites) → APPROVED; the
    // history preserves every prior decision.
    const reinstate = await recordModerationDecision(harness, contribution.id, {
      decision: "APPROVE",
      reasonKinds: ["no_violation"],
      notes: "reinstated after review",
    });
    expect(reinstate.decision.notes).toBe("reinstated after review");
    summary = await harness.runtime.moderationService.getModerationSummary(
      harness.bootstrapCtx,
      contribution.id,
    );
    expect(summary.status).toBe("APPROVED");
    expect(summary.decisionCount).toBe(3);

    const history = await harness.runtime.moderationService.listModerationDecisions(
      harness.bootstrapCtx,
      contribution.id,
    );
    expect(history.map((d) => d.decision)).toEqual([
      "FLAG_FOR_REVIEW",
      "REJECT",
      "APPROVE",
    ]);
    // The earlier decisions are UNCHANGED (append-only).
    expect(history[0]!.id).toBe(flag.decision.id);
    expect(history[1]!.id).toBe(reject.decision.id);
    expect(history[0]!.decidedBy).toBe(harness.moderatorPersonId);
  });

  test("only an authenticated PERSON actor may decide (moderator-controlled; the protocol never moderates)", async () => {
    const { contribution } = await createQualifiedContribution(harness);
    await expect(
      harness.runtime.moderationService.recordModerationDecision(
        systemCtx("w013-sys-decide"),
        {
          contributionId: contribution.id,
          organizationScopeId: harness.organizationScopeId,
          decision: "APPROVE",
          reasonKinds: ["no_violation"],
          idempotencyKey: key("w013-sys"),
        },
      ),
    ).rejects.toThrow(/person actor is required/i);
    const summary = await harness.runtime.moderationService.getModerationSummary(
      harness.bootstrapCtx,
      contribution.id,
    );
    expect(summary.status).toBe("UNMODERATED");
  });

  test("cited quality evaluations must belong to the SAME contribution in the SAME organization", async () => {
    const { contribution, qualityPolicy } = await createQualifiedContribution(
      harness,
    );
    const other = await createQualifiedContribution(harness);
    const evaluation = await recordQualityEvaluation(
      harness,
      contribution.id,
      qualityPolicy.policyId,
    );
    // An evaluation for a DIFFERENT contribution is rejected.
    await expect(
      harness.runtime.moderationService.recordModerationDecision(
        moderatorCtx(harness, "w013-cite-1"),
        {
          contributionId: other.contribution.id,
          organizationScopeId: harness.organizationScopeId,
          decision: "REJECT",
          reasonKinds: ["spam"],
          qualityEvaluationIds: [evaluation.id],
          idempotencyKey: key("w013-cite"),
        },
      ),
    ).rejects.toThrow(/does not belong to contribution/i);
    // A well-cited decision records the references.
    const cited = await recordModerationDecision(harness, contribution.id, {
      decision: "REJECT",
      reasonKinds: ["spam"],
      qualityEvaluationIds: [evaluation.id],
    });
    expect(cited.decision.qualityEvaluationIds).toEqual([evaluation.id]);
  });

  test("decisions NEVER transition the contribution's workflow state (lifecycle authority stays with /workflows)", async () => {
    const { contribution } = await createQualifiedContribution(harness);
    // The fixture's returned object predates its internal publish —
    // re-read the CURRENT state as the true baseline.
    const baseline = await harness.runtime.contributionService.getContribution(
      harness.bootstrapCtx,
      contribution.id,
    );
    const stateBefore = baseline.state;
    const versionBefore = baseline.version;
    await recordModerationDecision(harness, contribution.id, {
      decision: "REJECT",
      reasonKinds: ["spam", "policy_violation"],
    });
    const after = await harness.runtime.contributionService.getContribution(
      harness.bootstrapCtx,
      contribution.id,
    );
    expect(after.state).toBe(stateBefore);
    expect(after.version).toBe(versionBefore);
  });

  test("decision inputs are validated against the closed vocabularies", async () => {
    const { contribution } = await createQualifiedContribution(harness);
    await expect(
      harness.runtime.moderationService.recordModerationDecision(
        moderatorCtx(harness, "w013-vocab-1"),
        {
          contributionId: contribution.id,
          organizationScopeId: harness.organizationScopeId,
          decision: "DELETE" as never,
          reasonKinds: ["spam"],
          idempotencyKey: key("w013-vocab"),
        },
      ),
    ).rejects.toThrow(/decision must be one of APPROVE, REJECT, FLAG_FOR_REVIEW/i);
    await expect(
      harness.runtime.moderationService.recordModerationDecision(
        moderatorCtx(harness, "w013-vocab-2"),
        {
          contributionId: contribution.id,
          organizationScopeId: harness.organizationScopeId,
          decision: "APPROVE",
          reasonKinds: [] as never,
          idempotencyKey: key("w013-vocab"),
        },
      ),
    ).rejects.toThrow(/reasonKinds must be a non-empty array/i);
    await expect(
      harness.runtime.moderationService.recordModerationDecision(
        moderatorCtx(harness, "w013-vocab-3"),
        {
          contributionId: contribution.id,
          organizationScopeId: harness.organizationScopeId,
          decision: "APPROVE",
          reasonKinds: ["hostile_sentiment" as never],
          idempotencyKey: key("w013-vocab"),
        },
      ),
    ).rejects.toThrow(/reasonKinds must be a non-empty array/i);
  });

  test("a decision replays idempotently (same key → the same record, no duplicate history entry)", async () => {
    const { contribution } = await createQualifiedContribution(harness);
    const k = key("w013-replay");
    const first = await recordModerationDecision(harness, contribution.id, {
      decision: "REJECT",
      reasonKinds: ["spam"],
      idempotencyKey: k,
    });
    const second = await recordModerationDecision(harness, contribution.id, {
      decision: "REJECT",
      reasonKinds: ["spam"],
      idempotencyKey: k,
    });
    expect(second.decision.id).toBe(first.decision.id);
    const history = await harness.runtime.moderationService.listModerationDecisions(
      harness.bootstrapCtx,
      contribution.id,
    );
    expect(history.length).toBe(1);
    void contributorCtx;
  });
});
