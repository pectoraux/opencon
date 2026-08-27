/**
 * NET-W009-AC-02 — Risk rules are deterministic, versioned, and
 * reproducible.
 *
 * Work order ref: spec/work-orders/NET-W009.md §3.3, §4 invariant 4.
 * Issue #17 acceptance evidence 2. Includes the policy-lineage
 * concurrency regression (the NET-W007 PR #14 + NET-W008 pattern:
 * org-independent lineage mutex + cross-scope check on EVERY create
 * including v1).
 */

import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import {
  createNetW009Harness,
  createDefaultRiskPolicy,
  actorCtx,
  type NetW009Harness,
} from "./_net-w009-harness.ts";

let h: NetW009Harness;
beforeAll(async () => {
  h = await createNetW009Harness();
});
afterAll(async () => {
  await h.teardown();
});

describe("NET-W009-AC-02 deterministic versioned risk policies", () => {
  test("versioning is strictly monotonic: v1 starts a lineage, next is latest+1", async () => {
    const policy = await createDefaultRiskPolicy(h, "ac02-monotone");
    expect(policy.version).toBe(1);
    const ctx = actorCtx(h, "ac02-v2");
    const v2 = await h.runtime.riskPolicyService.createPolicyVersion(ctx, {
      organizationScopeId: h.organizationScopeId,
      policyId: "ac02-monotone",
      version: 2,
      description: "tightened thresholds",
      rules: [
        { category: "identity", weight: 1, advisoryWeightFactor: 0.25, severityPoints: { LOW: 1, MEDIUM: 2, HIGH: 4, CRITICAL: 8 } },
        { category: "velocity", weight: 1, advisoryWeightFactor: 0.25, severityPoints: { LOW: 1, MEDIUM: 2, HIGH: 4, CRITICAL: 8 } },
        { category: "duplicate_pattern", weight: 1, advisoryWeightFactor: 0.25, severityPoints: { LOW: 1, MEDIUM: 2, HIGH: 4, CRITICAL: 8 } },
        { category: "model_advisory", weight: 1, advisoryWeightFactor: 0.25, severityPoints: { LOW: 1, MEDIUM: 2, HIGH: 4, CRITICAL: 8 } },
      ],
      thresholds: { watch: 1, review: 2, hold: 4, blocked: 8 },
      criticalFloorState: "HOLD",
      advisoryOnlyCapState: "REVIEW",
      requiredCategories: ["identity"],
      missingDataState: "HOLD",
    });
    expect(v2.version).toBe(2);
    // A gap (v4 while latest is v2) is a conflict.
    await expect(
      h.runtime.riskPolicyService.createPolicyVersion(ctx, {
        organizationScopeId: h.organizationScopeId,
        policyId: "ac02-monotone",
        version: 4,
        rules: v2.rules.map((r) => ({
          category: r.category,
          weight: r.weight,
          advisoryWeightFactor: r.advisoryWeightFactor,
          severityPoints: r.severityPoints,
        })),
        thresholds: v2.thresholds,
        criticalFloorState: "HOLD",
        advisoryOnlyCapState: "REVIEW",
        requiredCategories: ["identity"],
        missingDataState: "HOLD",
      }),
    ).rejects.toMatchObject({ code: "CONFLICT" });
    // A new lineage cannot start above v1.
    await expect(
      h.runtime.riskPolicyService.createPolicyVersion(ctx, {
        organizationScopeId: h.organizationScopeId,
        policyId: "ac02-fresh-lineage",
        version: 2,
        rules: v2.rules.map((r) => ({
          category: r.category,
          weight: r.weight,
          advisoryWeightFactor: r.advisoryWeightFactor,
          severityPoints: r.severityPoints,
        })),
        thresholds: v2.thresholds,
        criticalFloorState: "HOLD",
        advisoryOnlyCapState: "REVIEW",
        requiredCategories: [],
        missingDataState: "REVIEW",
      }),
    ).rejects.toMatchObject({ code: "CONFLICT" });
  });

  test("the (policyId, version) tuple replays idempotently; versions are immutable", async () => {
    const v1 = await createDefaultRiskPolicy(h, "ac02-replay");
    const ctx = actorCtx(h, "ac02-replay-ctx");
    const replay = await h.runtime.riskPolicyService.createPolicyVersion(ctx, {
      organizationScopeId: h.organizationScopeId,
      policyId: "ac02-replay",
      version: 1,
      rules: v1.rules.map((r) => ({
        category: r.category,
        weight: r.weight,
        advisoryWeightFactor: r.advisoryWeightFactor,
        severityPoints: r.severityPoints,
      })),
      thresholds: v1.thresholds,
      criticalFloorState: v1.criticalFloorState,
      advisoryOnlyCapState: v1.advisoryOnlyCapState,
      requiredCategories: v1.requiredCategories,
      missingDataState: v1.missingDataState,
    });
    // Same tuple ⇒ deterministic replay of the committed record.
    expect(replay.id).toBe(v1.id);
    const versions = await h.runtime.riskPolicyService.listPolicyVersions(
      ctx,
      "ac02-replay",
    );
    expect(versions).toHaveLength(1);
  });

  test("deterministic shape validation: monotonic severity points, monotonic thresholds, fail-closed missing-data, advisory cap", async () => {
    const ctx = actorCtx(h, "ac02-shape");
    const goodRules = [
      { category: "identity", weight: 1, advisoryWeightFactor: 0.25, severityPoints: { LOW: 1, MEDIUM: 2, HIGH: 4, CRITICAL: 8 } },
    ];
    const good = {
      organizationScopeId: h.organizationScopeId,
      policyId: "ac02-shape",
      version: 1,
      rules: goodRules,
      thresholds: { watch: 2, review: 4, hold: 8, blocked: 12 },
      criticalFloorState: "HOLD",
      advisoryOnlyCapState: "REVIEW",
      requiredCategories: ["identity"],
      missingDataState: "HOLD",
    };
    // Non-monotonic severity points.
    await expect(
      h.runtime.riskPolicyService.createPolicyVersion(ctx, {
        ...good,
        rules: [
          { category: "identity", weight: 1, advisoryWeightFactor: 0.25, severityPoints: { LOW: 8, MEDIUM: 2, HIGH: 4, CRITICAL: 8 } },
        ],
      }),
    ).rejects.toMatchObject({ code: "RISK_POLICY_VALIDATION" });
    // Non-monotonic thresholds.
    await expect(
      h.runtime.riskPolicyService.createPolicyVersion(ctx, {
        ...good,
        thresholds: { watch: 8, review: 4, hold: 6, blocked: 12 },
      }),
    ).rejects.toMatchObject({ code: "RISK_POLICY_VALIDATION" });
    // missingDataState must fail CLOSED (≥ REVIEW).
    await expect(
      h.runtime.riskPolicyService.createPolicyVersion(ctx, {
        ...good,
        missingDataState: "CLEAR",
      }),
    ).rejects.toMatchObject({
      code: "RISK_POLICY_VALIDATION",
      message: expect.stringMatching(/fail CLOSED/i),
    });
    await expect(
      h.runtime.riskPolicyService.createPolicyVersion(ctx, {
        ...good,
        missingDataState: "WATCH",
      }),
    ).rejects.toMatchObject({ code: "RISK_POLICY_VALIDATION" });
    // advisoryOnlyCapState must be ≤ REVIEW (model non-authority).
    await expect(
      h.runtime.riskPolicyService.createPolicyVersion(ctx, {
        ...good,
        advisoryOnlyCapState: "HOLD",
      }),
    ).rejects.toMatchObject({
      code: "RISK_POLICY_VALIDATION",
      message: expect.stringMatching(/advisory-only/i),
    });
    // criticalFloorState must be ≥ REVIEW.
    await expect(
      h.runtime.riskPolicyService.createPolicyVersion(ctx, {
        ...good,
        criticalFloorState: "WATCH",
      }),
    ).rejects.toMatchObject({ code: "RISK_POLICY_VALIDATION" });
    // A required category with no rule is rejected.
    await expect(
      h.runtime.riskPolicyService.createPolicyVersion(ctx, {
        ...good,
        requiredCategories: ["identity", "velocity"],
      }),
    ).rejects.toMatchObject({ code: "RISK_POLICY_VALIDATION" });
  });

  test("cross-organization lineage fork is rejected — INCLUDING version 1 (sequential)", async () => {
    await createDefaultRiskPolicy(h, "ac02-fork-guard");
    const ctx = actorCtx(h, "ac02-fork");
    await expect(
      h.runtime.riskPolicyService.createPolicyVersion(ctx, {
        organizationScopeId: h.secondOrgId,
        policyId: "ac02-fork-guard",
        version: 1,
        rules: [
          { category: "identity", weight: 1, advisoryWeightFactor: 0.25, severityPoints: { LOW: 1, MEDIUM: 2, HIGH: 4, CRITICAL: 8 } },
        ],
        thresholds: { watch: 2, review: 4, hold: 8, blocked: 12 },
        criticalFloorState: "HOLD",
        advisoryOnlyCapState: "REVIEW",
        requiredCategories: ["identity"],
        missingDataState: "HOLD",
      }),
    ).rejects.toMatchObject({
      code: "RISK_POLICY_VALIDATION",
      message: expect.stringMatching(/belongs to organization scope/),
    });
  });

  test("concurrent cross-org v1 vs v1: exactly ONE lineage is created (org-independent mutex)", async () => {
    const ctx = actorCtx(h, "ac02-concurrent-fork");
    const mk = (orgId: string) =>
      h.runtime.riskPolicyService.createPolicyVersion(ctx, {
        organizationScopeId: orgId,
        policyId: "ac02-concurrent-lineage",
        version: 1,
        rules: [
          { category: "identity", weight: 1, advisoryWeightFactor: 0.25, severityPoints: { LOW: 1, MEDIUM: 2, HIGH: 4, CRITICAL: 8 } },
        ],
        thresholds: { watch: 2, review: 4, hold: 8, blocked: 12 },
        criticalFloorState: "HOLD",
        advisoryOnlyCapState: "REVIEW",
        requiredCategories: [],
        missingDataState: "REVIEW",
      });
    const results = await Promise.allSettled([
      mk(h.organizationScopeId),
      mk(h.secondOrgId),
    ]);
    const fulfilled = results.filter((r) => r.status === "fulfilled");
    const rejected = results.filter((r) => r.status === "rejected");
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    const rejection = (rejected[0] as PromiseRejectedResult).reason as { code: string; message: string };
    expect(rejection.code).toBe("RISK_POLICY_VALIDATION");
    expect(rejection.message).toMatch(/belongs to organization scope/);
    // The single v1 belongs to the winner's org.
    const winner = (fulfilled[0] as PromiseFulfilledResult<{ organizationScopeId: string }>).value;
    const versions = await h.runtime.riskPolicyService.listPolicyVersions(
      ctx,
      "ac02-concurrent-lineage",
    );
    expect(versions).toHaveLength(1);
    expect(versions[0]!.organizationScopeId).toBe(winner.organizationScopeId);
  });

  test("concurrent same-org same-tuple creates resolve to exactly one record", async () => {
    const ctx = actorCtx(h, "ac02-concurrent-same");
    const mk = () =>
      h.runtime.riskPolicyService.createPolicyVersion(ctx, {
        organizationScopeId: h.organizationScopeId,
        policyId: "ac02-same-tuple",
        version: 1,
        rules: [
          { category: "identity", weight: 1, advisoryWeightFactor: 0.25, severityPoints: { LOW: 1, MEDIUM: 2, HIGH: 4, CRITICAL: 8 } },
        ],
        thresholds: { watch: 2, review: 4, hold: 8, blocked: 12 },
        criticalFloorState: "HOLD",
        advisoryOnlyCapState: "REVIEW",
        requiredCategories: [],
        missingDataState: "REVIEW",
      });
    const results = await Promise.allSettled([mk(), mk()]);
    const fulfilled = results.filter((r) => r.status === "fulfilled");
    expect(fulfilled).toHaveLength(2); // tuple replay: both resolve to the SAME record
    const ids = new Set(
      fulfilled.map(
        (r) => (r as PromiseFulfilledResult<{ id: string }>).value.id,
      ),
    );
    expect(ids.size).toBe(1);
    const versions = await h.runtime.riskPolicyService.listPolicyVersions(
      ctx,
      "ac02-same-tuple",
    );
    expect(versions).toHaveLength(1);
  });

  test("policies are reproducible inputs: the same version read twice is identical; versions list ordered", async () => {
    const policy = await createDefaultRiskPolicy(h, "ac02-repro");
    const ctx = actorCtx(h, "ac02-repro-ctx");
    const a = await h.runtime.riskPolicyService.getPolicyVersion(
      ctx,
      "ac02-repro",
      1,
    );
    const b = await h.runtime.riskPolicyService.getPolicyVersion(
      ctx,
      "ac02-repro",
      1,
    );
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
    // Canonical rule order = the frozen category vocabulary order
    // (deterministic serialization).
    expect(a.rules.map((r) => r.category).join(",")).toBe(
      "identity,velocity,duplicate_pattern,model_advisory",
    );
    expect(policy.rules).toHaveLength(4);
  });
});
