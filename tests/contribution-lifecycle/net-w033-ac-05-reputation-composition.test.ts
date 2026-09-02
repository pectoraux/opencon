/**
 * NET-W033-AC-05 — Reputation composition (issue #67 §4 AC-05).
 *
 * The qualifying contribution changes reputation only through
 * /reputation; the resulting authoritative state is evidence/outcome-
 * derived; caller-supplied scores or value injection fail closed:
 *  - BOTH canonical inputs (the direct evidence/outcome-derived one
 *    and the settlement-effect one) carry the SERVER-DERIVED
 *    "verified" basis (the sources are VERIFIED authority records);
 *  - a fact-anchored snapshot covers BOTH inputs with deterministic,
 *    reproducible scores + digest;
 *  - an input over NON-verified sources derives "indicated" (never
 *    "verified") — no caller can purchase the verified basis;
 *  - the settlement→reputation join on a PENDING record fails closed;
 *  - a nonexistent source reference fails closed;
 *  - STRUCTURAL: the reputation input carries NO score/basis/value
 *    field — there is nothing for a caller to assert.
 */

import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import {
  createNetW033Harness,
  runCanonicalScenario,
  key,
  OCCURRED_AT,
  REFERENCE_AT,
  type NetW033Harness,
} from "./_net-w033-harness.ts";

const REPO = join(import.meta.dir, "../..");

let harness: NetW033Harness;
let scenario: Awaited<ReturnType<typeof runCanonicalScenario>>;

beforeAll(async () => {
  harness = await createNetW033Harness();
  scenario = await runCanonicalScenario(harness, {
    skipBenefitAllocation: true,
  });
});

afterAll(async () => {
  await harness.teardown();
});

describe("NET-W033-AC-05 reputation composition", () => {
  test("the qualifying contribution feeds reputation ONLY through /reputation with the server-derived verified basis", async () => {
    const ctx = harness.contributorCtx("w033-ac05-basis");
    // The direct input: sources = the VERIFIED contribution + PoV +
    // measured outcome → the DERIVED basis is "verified".
    const direct = await harness.runtime.reputationInputService.getInput(
      ctx,
      scenario.directInputId,
    );
    expect(direct.basis).toBe("verified");
    expect(direct.subjectPersonId).toBe(harness.contributorPersonId);
    expect(direct.dimension).toBe("helpfulness");
    expect(direct.occurredAt).toBe(OCCURRED_AT);
    expect(direct.sources.map((s) => s.id)).toContain(scenario.contribution.id);
    expect(direct.sources.map((s) => s.id)).toContain(scenario.proofOfValueId);
    expect(direct.sources.map((s) => s.id)).toContain(
      scenario.measuredOutcomeId,
    );
    // The settlement-effect input: sources = the value record's
    // upstream sources (all verified-grade by the settlement input
    // gate) → the DERIVED basis is "verified".
    const effect = await harness.runtime.reputationInputService.getInput(
      ctx,
      scenario.settlementEffectInputId,
    );
    expect(effect.basis).toBe("verified");
  });

  test("a fact-anchored snapshot covers BOTH inputs with deterministic, reproducible scores", async () => {
    const ctx = harness.contributorCtx("w033-ac05-snapshot");
    // The fact-anchored reference: strictly AFTER the recorded
    // maturation anchor (the settlement-effect input's decay anchor is
    // the value record's maturedAt) — deterministic from recorded
    // facts, never the test wall clock.
    const maturedAt = Date.parse(scenario.matureValue.maturedAt as string);
    const anchor = new Date(maturedAt + 1).toISOString();
    const computed =
      await harness.runtime.reputationSnapshotService.computeScores(ctx, {
        organizationScopeId: harness.organizationScopeId,
        subjectPersonId: harness.contributorPersonId,
        policyId: scenario.reputationPolicyId,
        referenceAt: anchor,
      });
    expect(computed.inputIds).toContain(scenario.directInputId);
    expect(computed.inputIds).toContain(scenario.settlementEffectInputId);
    // The helpfulness score is positive (both verified inputs at full
    // weight, decayed from their respective anchors).
    const helpfulness = computed.scores.find(
      (s) => s.dimension === "helpfulness",
    )!;
    expect(helpfulness.score).toBeGreaterThan(0);
    // Determinism: a second compute at the SAME anchor is identical
    // (scores + digest).
    const again =
      await harness.runtime.reputationSnapshotService.computeScores(ctx, {
        organizationScopeId: harness.organizationScopeId,
        subjectPersonId: harness.contributorPersonId,
        policyId: scenario.reputationPolicyId,
        referenceAt: anchor,
      });
    expect(again.scores).toEqual(computed.scores);
    expect(again.digest).toBe(computed.digest);
    // The recorded canonical snapshot (fixed 2024 anchor) is
    // reproducible from its recorded facts as well.
    const snapshot = await harness.runtime.reputationSnapshotService.getSnapshot(
      ctx,
      scenario.snapshot.id,
    );
    const recomputed =
      await harness.runtime.reputationSnapshotService.computeScores(ctx, {
        organizationScopeId: harness.organizationScopeId,
        subjectPersonId: harness.contributorPersonId,
        policyId: scenario.reputationPolicyId,
        referenceAt: REFERENCE_AT,
      });
    expect(recomputed.digest).toBe(snapshot.digest);
  });

  test("an input over NON-verified sources derives the 'indicated' basis (the verified basis is NOT purchasable)", async () => {
    const ctx = harness.contributorCtx("w033-ac05-indicated");
    // A self-reported evidence record (SELF_REPORTED grade) — NOT a
    // verified authority record: the derived basis must be
    // "indicated", never "verified".
    const evidence = await harness.runtime.evidenceService.createEvidence(ctx, {
      organizationScopeId: harness.organizationScopeId,
      ownerId: harness.contributorPersonId,
      subjectReference: {
        subjectId: scenario.contribution.id,
        subjectType: "contribution",
      },
      provenance: {
        sourceType: "self",
        sourceId: "self-report-w033-ac05",
        method: "self-report",
      },
      confidence: { point: 0.9, lower: 0.8, upper: 0.95 },
      sensitivity: "standard",
      payload: { claimed: "helpful" },
    });
    const result = await harness.runtime.reputationInputService.recordInput(
      ctx,
      {
        organizationScopeId: harness.organizationScopeId,
        subjectPersonId: harness.contributorPersonId,
        dimension: "helpfulness",
        sources: [{ kind: "evidence", id: evidence.id }],
        description: "self-reported basis (must be indicated)",
        occurredAt: OCCURRED_AT,
        idempotencyKey: key("w033-ac05-indicated"),
      },
    );
    expect(result.input.basis).toBe("indicated");
    // An indicated-only input caps the dimension (the policy's
    // indicatedOnlyCap = 10, indicatedWeightFactor = 0.25): the score
    // contribution stays bounded — no purchased score.
    const computed =
      await harness.runtime.reputationSnapshotService.computeScores(ctx, {
        organizationScopeId: harness.organizationScopeId,
        subjectPersonId: harness.contributorPersonId,
        policyId: scenario.reputationPolicyId,
        referenceAt: REFERENCE_AT,
      });
    const helpfulness = computed.scores.find(
      (s) => s.dimension === "helpfulness",
    )!;
    expect(helpfulness.score).toBeLessThanOrEqual(100);
  });

  test("the settlement→reputation join on a NON-MATURE record fails closed", async () => {
    // A genuinely PENDING value record: a fresh VERIFIED contribution
    // recognized WITHOUT maturation (the canonical one is already
    // MATURE — the composite re-reads the CURRENT state).
    const { createVerifiedSettledContribution, recognizeContributionValue } =
      await import("../reward-integration/_net-w014-harness.ts");
    const { contribution } = await createVerifiedSettledContribution(
      harness.w014,
      { withMeasuredOutcomeBasis: true, withProofOfValueBasis: true },
    );
    const pending = await recognizeContributionValue(
      harness.w014,
      contribution.id,
      { amount: 40 },
    );
    expect(pending.value.state).toBe("PENDING");
    await expect(
      harness.runtime.apiCommands.applySettlementReputationEffect(
        harness.moderatorCtx("w033-ac05-pending"),
        harness.moderatorPersonId,
        {
          valueRecordId: pending.value.id,
          idempotencyKey: key("w033-ac05-pending"),
        },
      ),
    ).rejects.toMatchObject({ code: "REPUTATION_VALIDATION" });
  });

  test("a NONEXISTENT source reference fails closed (no score without authoritative sources)", async () => {
    const ctx = harness.contributorCtx("w033-ac05-nonexistent");
    await expect(
      harness.runtime.reputationInputService.recordInput(ctx, {
        organizationScopeId: harness.organizationScopeId,
        subjectPersonId: harness.contributorPersonId,
        dimension: "helpfulness",
        sources: [{ kind: "contribution", id: "nonexistent-contribution" }],
        description: "bogus source",
        occurredAt: OCCURRED_AT,
        idempotencyKey: key("w033-ac05-nonexistent"),
      }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  test("STRUCTURAL: the reputation input carries NO score/basis/value field (nothing to assert)", async () => {
    const port = await readFile(
      join(REPO, "src/reputation/port.ts"),
      "utf8",
    );
    const inputMatch = port.match(
      /export interface RecordReputationInputInput \{[\s\S]*?\n\}/,
    );
    expect(inputMatch).not.toBeNull();
    const input = inputMatch![0]!;
    // Scope, subject, dimension, sources, description, occurredAt,
    // idempotencyKey — but NO score, NO basis, NO amount/value: the
    // basis + any score weight is DERIVED server-side from the
    // sources' authoritative state.
    expect(input).toContain("sources");
    expect(input).toContain("occurredAt");
    expect(input).not.toMatch(/\bscore\b/i);
    expect(input).not.toMatch(/\bbasis\b/i);
    expect(input).not.toMatch(/\bweight\b/i);
    expect(input).not.toMatch(/\bamount\b/i);
    // The snapshot computation input carries the reference anchor +
    // policy reference only (never scores).
    const snapMatch = port.match(
      /export interface RecordReputationSnapshotInput \{[\s\S]*?\n\}/,
    );
    expect(snapMatch).not.toBeNull();
    expect(snapMatch![0]!).not.toMatch(/\bscore\b/i);
    expect(snapMatch![0]!).toContain("referenceAt");
  });
});
