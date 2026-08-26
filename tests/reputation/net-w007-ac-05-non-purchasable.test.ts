/**
 * NET-W007-AC-05 — Spend/wealth/deposits/credits/raw activity cannot
 * directly increase reputation (REP-002).
 *
 *  - the input contract carries NO field for advertising spend,
 *    deposits, wealth, credits or raw activity volume — REP-002 is
 *    STRUCTURAL: there is no channel through which money can enter
 *    (extra caller-supplied fields are not persisted);
 *  - every input requires ≥1 upstream evidence/verified-value
 *    reference — a bare activity assertion is rejected;
 *  - inputs backed only by model-assessed/self-reported evidence
 *    (`indicated` basis) are strictly bounded by the policy's
 *    indicatedOnlyCap < maxScore: NO volume of raw activity can reach
 *    a fully verified score;
 *  - a policy attempting indicatedOnlyCap >= maxScore is rejected.
 *
 * Evidence: domain integration tests + contract-shape assertions.
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import {
  createNetW007Harness,
  actorCtx,
  createDefaultPolicy,
  createVerifiedContribution,
  createEvidence,
  DEFAULT_POLICY_RULES,
  REF_AT,
  type NetW007Harness,
} from "./_net-w007-harness.ts";

let harness: NetW007Harness;

beforeEach(async () => {
  harness = await createNetW007Harness();
});

afterEach(async () => {
  await harness.teardown();
});

describe("NET-W007-AC-05 reputation is not purchasable", () => {
  test("the input contract carries NO economic field: spend/wealth/credit fields supplied by a caller are NOT persisted", async () => {
    await createDefaultPolicy(harness);
    const contributionId = await createVerifiedContribution(harness);
    const ctx = actorCtx(harness, "ac05-no-economic-field");
    // A caller tries to smuggle spend/wealth/credits/raw-activity
    // volume through extra fields.
    const result = await harness.runtime.reputationInputService.recordInput(ctx, {
      organizationScopeId: harness.organizationScopeId,
      subjectPersonId: harness.personId,
      dimension: "helpfulness",
      sources: [{ kind: "contribution", id: contributionId }],
      occurredAt: REF_AT,
      idempotencyKey: "ac05-smuggle",
      ...({
        advertisingSpend: 1_000_000,
        depositAmount: 500_000,
        wealth: 10_000_000,
        participationCredits: 250_000,
        activityVolume: 99_999,
      } as Record<string, unknown>),
    } as Parameters<typeof harness.runtime.reputationInputService.recordInput>[1]);
    const persisted = result.input as unknown as Record<string, unknown>;
    expect(persisted.advertisingSpend).toBeUndefined();
    expect(persisted.depositAmount).toBeUndefined();
    expect(persisted.wealth).toBeUndefined();
    expect(persisted.participationCredits).toBeUndefined();
    expect(persisted.activityVolume).toBeUndefined();
    // The only persisted fields are the trust-relevant ones.
    expect(Object.keys(persisted).sort()).toEqual([
      "basis",
      "causationId",
      "correlationId",
      "description",
      "dimension",
      "executionId",
      "id",
      "idempotencyKey",
      "occurredAt",
      "organizationScopeId",
      "recordedAt",
      "sources",
      "subjectPersonId",
    ]);
  });

  test("raw activity without upstream references is rejected outright", async () => {
    await createDefaultPolicy(harness);
    const ctx = actorCtx(harness, "ac05-raw-activity");
    await expect(
      harness.runtime.reputationInputService.recordInput(ctx, {
        organizationScopeId: harness.organizationScopeId,
        subjectPersonId: harness.personId,
        dimension: "helpfulness",
        sources: [],
        occurredAt: REF_AT,
        idempotencyKey: "ac05-raw-activity",
      }),
    ).rejects.toThrow(/bare activity or spend assertion cannot enter/);
  });

  test("massive raw-activity volume (model/self-only inputs) is capped at indicatedOnlyCap — volume cannot buy score", async () => {
    await createDefaultPolicy(harness);
    const ctx = actorCtx(harness, "ac05-capped");
    // 80 model-assessed "activity" inputs — raw unverified weight
    // 80 × 0.25 = 20, far beyond the 10-point indicatedOnlyCap.
    for (let i = 0; i < 80; i++) {
      const evidence = await createEvidence(harness, {
        sourceType: i % 2 === 0 ? "model" : "self",
        sourceId: `activity-${i}`,
      });
      await harness.runtime.reputationInputService.recordInput(ctx, {
        organizationScopeId: harness.organizationScopeId,
        subjectPersonId: harness.personId,
        dimension: "helpfulness",
        sources: [{ kind: "evidence", id: evidence.id }],
        occurredAt: REF_AT,
        idempotencyKey: `ac05-activity-${i}`,
      });
    }
    const computed = await harness.runtime.reputationSnapshotService.computeScores(ctx, {
      organizationScopeId: harness.organizationScopeId,
      subjectPersonId: harness.personId,
      policyId: "policy-w007-default",
      version: 1,
      referenceAt: REF_AT,
    });
    const helpfulness = computed.scores.find((s) => s.dimension === "helpfulness")!;
    // Raw unverified weight is 80 × 0.25 = 20 — but the
    // indicatedOnlyCap (10) binds: capped=true, score exactly 10.
    expect(helpfulness.capped).toBe(true);
    expect(helpfulness.score).toBe(10);
    expect(helpfulness.verifiedInputCount).toBe(0);
    expect(helpfulness.indicatedInputCount).toBe(80);
    expect(helpfulness.score).toBeLessThan(
      DEFAULT_POLICY_RULES[0]!.maxScore,
    );
  });

  test("the indicatedOnlyCap is validated: it must be strictly below maxScore", async () => {
    const ctx = actorCtx(harness, "ac05-cap-validation");
    await expect(
      harness.runtime.reputationPolicyService.createPolicyVersion(ctx, {
        organizationScopeId: harness.organizationScopeId,
        policyId: "policy-purchasable",
        version: 1,
        rules: DEFAULT_POLICY_RULES.map((r) => ({ ...r, indicatedOnlyCap: r.maxScore })),
      }),
    ).rejects.toThrow(/indicatedOnlyCap must be within \[0, maxScore\)/);
    await expect(
      harness.runtime.reputationPolicyService.createPolicyVersion(ctx, {
        organizationScopeId: harness.organizationScopeId,
        policyId: "policy-purchasable-2",
        version: 1,
        rules: DEFAULT_POLICY_RULES.map((r) => ({ ...r, indicatedOnlyCap: r.maxScore + 1 })),
      }),
    ).rejects.toThrow(/indicatedOnlyCap must be within \[0, maxScore\)/);
  });

  test("ONE verified contribution outweighs unlimited raw activity: verified evidence is the only path to real score", async () => {
    await createDefaultPolicy(harness);
    const ctx = actorCtx(harness, "ac05-verified-wins");
    // 80 model/self inputs (raw activity) → capped at 10.
    for (let i = 0; i < 80; i++) {
      const evidence = await createEvidence(harness, { sourceType: "model", sourceId: `m-${i}` });
      await harness.runtime.reputationInputService.recordInput(ctx, {
        organizationScopeId: harness.organizationScopeId,
        subjectPersonId: harness.personId,
        dimension: "helpfulness",
        sources: [{ kind: "evidence", id: evidence.id }],
        occurredAt: REF_AT,
        idempotencyKey: `ac05-model-${i}`,
      });
    }
    // 12 verified contributions → 12 (uncapped, above the raw cap).
    for (let i = 0; i < 12; i++) {
      const contributionId = await createVerifiedContribution(harness);
      await harness.runtime.reputationInputService.recordInput(ctx, {
        organizationScopeId: harness.organizationScopeId,
        subjectPersonId: harness.personId,
        dimension: "helpfulness",
        sources: [{ kind: "contribution", id: contributionId }],
        occurredAt: REF_AT,
        idempotencyKey: `ac05-verified-${i}`,
      });
    }
    const computed = await harness.runtime.reputationSnapshotService.computeScores(ctx, {
      organizationScopeId: harness.organizationScopeId,
      subjectPersonId: harness.personId,
      policyId: "policy-w007-default",
      version: 1,
      referenceAt: REF_AT,
    });
    const helpfulness = computed.scores.find((s) => s.dimension === "helpfulness")!;
    // 12 verified + 80 indicated: verified weight 12 + indicated
    // 80×0.25=20 → total 32 (below maxScore 100, cap not binding).
    expect(helpfulness.verifiedInputCount).toBe(12);
    expect(helpfulness.indicatedInputCount).toBe(80);
    expect(helpfulness.decayedVerifiedWeight).toBe(12);
    expect(helpfulness.decayedIndicatedWeight).toBe(20);
    expect(helpfulness.score).toBe(32);
  });

  test("a non-VERIFIED contribution (settled work without verification) is indicated-only — cannot lift score above the cap by itself", async () => {
    await createDefaultPolicy(harness);
    const ctx = actorCtx(harness, "ac05-unverified-contribution");
    // Drive a contribution only to SUBMITTED (NOT VERIFIED).
    const oppCtx = actorCtx(harness, "ac05-opp");
    const opp = await harness.runtime.opportunityService.createOpportunity(oppCtx, {
      organizationScopeId: harness.organizationScopeId,
      ownerId: harness.personId,
      opportunityType: "test-opportunity",
      title: "Unverified Opportunity",
      brief: { kind: "test" },
    });
    const cCtx = actorCtx(harness, "ac05-contrib");
    const contribution = await harness.runtime.contributionService.createContribution(cCtx, {
      opportunityId: opp.id,
      contributorId: harness.personId,
      organizationScopeId: harness.organizationScopeId,
      contributionType: "test-contribution",
      submission: { kind: "test" },
    });
    for (let i = 0; i < 48; i++) {
      await harness.runtime.reputationInputService.recordInput(ctx, {
        organizationScopeId: harness.organizationScopeId,
        subjectPersonId: harness.personId,
        dimension: "helpfulness",
        sources: [{ kind: "contribution", id: contribution.id }],
        occurredAt: REF_AT,
        idempotencyKey: `ac05-unverified-${i}`,
      });
    }
    const computed = await harness.runtime.reputationSnapshotService.computeScores(ctx, {
      organizationScopeId: harness.organizationScopeId,
      subjectPersonId: harness.personId,
      policyId: "policy-w007-default",
      version: 1,
      referenceAt: REF_AT,
    });
    const helpfulness = computed.scores.find((s) => s.dimension === "helpfulness")!;
    expect(helpfulness.verifiedInputCount).toBe(0);
    expect(helpfulness.capped).toBe(true);
    expect(helpfulness.score).toBe(10);
  });

  test("snapshots never carry economic units: the score shape is trust-only (no spendable value)", async () => {
    const policy = await createDefaultPolicy(harness);
    const ctx = actorCtx(harness, "ac05-trust-only");
    const contributionId = await createVerifiedContribution(harness);
    await harness.runtime.reputationInputService.recordInput(ctx, {
      organizationScopeId: harness.organizationScopeId,
      subjectPersonId: harness.personId,
      dimension: "helpfulness",
      sources: [{ kind: "contribution", id: contributionId }],
      occurredAt: REF_AT,
      idempotencyKey: "ac05-trust-only-input",
    });
    const snapshot = await harness.runtime.reputationSnapshotService.recordSnapshot(ctx, {
      organizationScopeId: harness.organizationScopeId,
      subjectPersonId: harness.personId,
      policyId: policy.policyId,
      version: 1,
      referenceAt: REF_AT,
      idempotencyKey: "ac05-trust-only-snapshot",
    });
    for (const score of snapshot.snapshot.scores) {
      expect(Object.keys(score).sort()).toEqual([
        "capped",
        "decayedIndicatedWeight",
        "decayedVerifiedWeight",
        "dimension",
        "indicatedInputCount",
        "inputCount",
        "score",
        "verifiedInputCount",
      ]);
    }
  });
});
