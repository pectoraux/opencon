/**
 * NET-W007-AC-02 — Score calculations are deterministic,
 * policy/version aware and reproducible.
 *
 *  - identical inputs + policy + referenceAt ALWAYS produce identical
 *    scores and digests (bit-identical, asserted via the digest);
 *  - scoring policies are immutable versioned records: a new version
 *    never rewrites an old one, and historical snapshots remain
 *    reproducible against the exact recorded version;
 *  - versioning is monotonic (latest+1) and idempotent per
 *    (policyId, version) tuple;
 *  - the decay reference timestamp is part of the computation (a
 *    different referenceAt is a DIFFERENT computation).
 *
 * Evidence: domain integration tests + pure-engine assertions.
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import {
  createNetW007Harness,
  actorCtx,
  createDefaultPolicy,
  createVerifiedContribution,
  DEFAULT_POLICY_RULES,
  REF_AT,
  type NetW007Harness,
} from "./_net-w007-harness.ts";
import { computeScoresDigest, round6 } from "../../src/reputation/scoring.ts";

let harness: NetW007Harness;

beforeEach(async () => {
  harness = await createNetW007Harness();
});

afterEach(async () => {
  await harness.teardown();
});

describe("NET-W007-AC-02 determinism", () => {
  test("identical inputs + policy + referenceAt produce bit-identical scores AND digests (repeated computation)", async () => {
    await createDefaultPolicy(harness);
    const ctx = actorCtx(harness, "ac02-reproducible");
    const contributionId = await createVerifiedContribution(harness);
    await harness.runtime.reputationInputService.recordInput(ctx, {
      organizationScopeId: harness.organizationScopeId,
      subjectPersonId: harness.personId,
      dimension: "helpfulness",
      sources: [{ kind: "contribution", id: contributionId }],
      occurredAt: "2024-05-01T00:00:00.000Z",
      idempotencyKey: "ac02-input",
    });
    const input = {
      organizationScopeId: harness.organizationScopeId,
      subjectPersonId: harness.personId,
      policyId: "policy-w007-default",
      version: 1 as const,
      referenceAt: REF_AT,
    };
    const a = await harness.runtime.reputationSnapshotService.computeScores(ctx, input);
    const b = await harness.runtime.reputationSnapshotService.computeScores(ctx, input);
    expect(a.scores).toEqual(b.scores);
    expect(a.digest).toBe(b.digest);
    // The digest is stable and non-trivial.
    expect(a.digest).toMatch(/^[0-9a-f]{64}$/);
  });

  test("the snapshot digest equals the pure computeScores digest for the same triple", async () => {
    const policy = await createDefaultPolicy(harness);
    const ctx = actorCtx(harness, "ac02-digest");
    const contributionId = await createVerifiedContribution(harness);
    await harness.runtime.reputationInputService.recordInput(ctx, {
      organizationScopeId: harness.organizationScopeId,
      subjectPersonId: harness.personId,
      dimension: "measurement_reliability",
      sources: [{ kind: "contribution", id: contributionId }],
      occurredAt: REF_AT,
      idempotencyKey: "ac02-digest-input",
    });
    const snapshot = await harness.runtime.reputationSnapshotService.recordSnapshot(ctx, {
      organizationScopeId: harness.organizationScopeId,
      subjectPersonId: harness.personId,
      policyId: policy.policyId,
      version: 1,
      referenceAt: REF_AT,
      idempotencyKey: "ac02-digest-snapshot",
    });
    const recomputed = await harness.runtime.reputationSnapshotService.computeScores(ctx, {
      organizationScopeId: harness.organizationScopeId,
      subjectPersonId: harness.personId,
      policyId: policy.policyId,
      version: 1,
      referenceAt: REF_AT,
    });
    expect(snapshot.snapshot.digest).toBe(recomputed.digest);
    // The digest is derivable from the pure function over the recorded
    // scores — deterministic serialization at fixed precision.
    expect(computeScoresDigest(policy.policyId, 1, REF_AT, snapshot.snapshot.scores))
      .toBe(snapshot.snapshot.digest);
  });

  test("policy versions are immutable: v2 changes scoring but the v1 snapshot stays reproducible", async () => {
    const policy = await createDefaultPolicy(harness);
    const ctx = actorCtx(harness, "ac02-versioned");
    const contributionId = await createVerifiedContribution(harness);
    await harness.runtime.reputationInputService.recordInput(ctx, {
      organizationScopeId: harness.organizationScopeId,
      subjectPersonId: harness.personId,
      dimension: "helpfulness",
      sources: [{ kind: "contribution", id: contributionId }],
      occurredAt: REF_AT,
      idempotencyKey: "ac02-versioned-input",
    });

    // Snapshot against v1.
    const v1Snapshot = await harness.runtime.reputationSnapshotService.recordSnapshot(ctx, {
      organizationScopeId: harness.organizationScopeId,
      subjectPersonId: harness.personId,
      policyId: policy.policyId,
      version: 1,
      referenceAt: REF_AT,
      idempotencyKey: "ac02-v1-snapshot",
    });
    const v1Score = v1Snapshot.snapshot.scores.find((s) => s.dimension === "helpfulness")!.score;

    // Publish v2 with double the input weight.
    const v2 = await harness.runtime.reputationPolicyService.createPolicyVersion(ctx, {
      organizationScopeId: harness.organizationScopeId,
      policyId: policy.policyId,
      version: 2,
      description: "doubled weights",
      rules: DEFAULT_POLICY_RULES.map((r) => ({ ...r, inputWeight: r.inputWeight * 2 })),
    });
    expect(v2.version).toBe(2);
    // v1 record is UNCHANGED after v2 exists.
    const v1After = await harness.runtime.reputationPolicyService.getPolicyVersion(
      ctx,
      policy.policyId,
      1,
    );
    expect(v1After.rules.find((r) => r.dimension === "helpfulness")!.inputWeight).toBe(1);

    // Latest-version computation now uses v2 (different score)…
    const latest = await harness.runtime.reputationSnapshotService.computeScores(ctx, {
      organizationScopeId: harness.organizationScopeId,
      subjectPersonId: harness.personId,
      policyId: policy.policyId,
      referenceAt: REF_AT,
    });
    expect(latest.policyVersion).toBe(2);
    expect(latest.scores.find((s) => s.dimension === "helpfulness")!.score).toBe(v1Score * 2);

    // …but the v1 snapshot recomputes EXACTLY against version 1
    // (historical reproducibility).
    const pinned = await harness.runtime.reputationSnapshotService.computeScores(ctx, {
      organizationScopeId: harness.organizationScopeId,
      subjectPersonId: harness.personId,
      policyId: policy.policyId,
      version: 1,
      referenceAt: REF_AT,
    });
    expect(pinned.digest).toBe(v1Snapshot.snapshot.digest);
    expect(pinned.scores).toEqual(v1Snapshot.snapshot.scores);
  });

  test("versioning is monotonic: skipping versions is rejected; the same tuple replays idempotently", async () => {
    await createDefaultPolicy(harness, "policy-monotonic");
    const ctx = actorCtx(harness, "ac02-monotonic");
    // v3 before v2 → conflict (skip-ahead).
    await expect(
      harness.runtime.reputationPolicyService.createPolicyVersion(ctx, {
        organizationScopeId: harness.organizationScopeId,
        policyId: "policy-monotonic",
        version: 3,
        rules: DEFAULT_POLICY_RULES,
      }),
    ).rejects.toThrow(/next version is 2/);
    // A NEW lineage cannot start above 1.
    await expect(
      harness.runtime.reputationPolicyService.createPolicyVersion(ctx, {
        organizationScopeId: harness.organizationScopeId,
        policyId: "policy-new-lineage",
        version: 2,
        rules: DEFAULT_POLICY_RULES,
      }),
    ).rejects.toThrow(/starts at version 1/);

    // Re-creating v1 (a completed (policyId, version) tuple) is an
    // IDEMPOTENT REPLAY — the tuple IS the idempotency key, so the
    // committed record returns unchanged even with a different payload.
    const v1Existing = await harness.runtime.reputationPolicyService.getPolicyVersion(
      ctx,
      "policy-monotonic",
      1,
    );
    const v1Replay = await harness.runtime.reputationPolicyService.createPolicyVersion(ctx, {
      organizationScopeId: harness.organizationScopeId,
      policyId: "policy-monotonic",
      version: 1,
      rules: DEFAULT_POLICY_RULES.map((r) => ({ ...r, inputWeight: 999 })),
    });
    expect(v1Replay.id).toBe(v1Existing.id);
    expect(v1Replay.rules.find((r) => r.dimension === "helpfulness")!.inputWeight).toBe(1);
    // Still exactly one v1 record in the lineage listing.
    const versions = await harness.runtime.reputationPolicyService.listPolicyVersions(
      ctx,
      "policy-monotonic",
    );
    expect(versions.filter((v) => v.version === 1)).toHaveLength(1);

    // Retrying the same (policyId, version=2) create replays the SAME
    // record (idempotent) even with different rule payloads — the
    // committed version is authoritative.
    const first = await harness.runtime.reputationPolicyService.createPolicyVersion(ctx, {
      organizationScopeId: harness.organizationScopeId,
      policyId: "policy-monotonic",
      version: 2,
      rules: DEFAULT_POLICY_RULES,
    });
    const retry = await harness.runtime.reputationPolicyService.createPolicyVersion(ctx, {
      organizationScopeId: harness.organizationScopeId,
      policyId: "policy-monotonic",
      version: 2,
      rules: DEFAULT_POLICY_RULES.map((r) => ({ ...r, inputWeight: 999 })),
    });
    expect(retry.id).toBe(first.id);
    expect(retry.rules.find((r) => r.dimension === "helpfulness")!.inputWeight).toBe(1);

    // Skip-ahead still conflicts after v2 exists (v4 while latest=2).
    await expect(
      harness.runtime.reputationPolicyService.createPolicyVersion(ctx, {
        organizationScopeId: harness.organizationScopeId,
        policyId: "policy-monotonic",
        version: 4,
        rules: DEFAULT_POLICY_RULES,
      }),
    ).rejects.toThrow(/next version is 3/);
  });

  test("a policy lineage cannot be forked across organization scopes", async () => {
    await createDefaultPolicy(harness, "policy-scoped");
    const bootstrapCtx = harness.bootstrapCtx;
    const otherOrg = await harness.runtime.organizationService.createOrganization(bootstrapCtx, {
      name: "Other Org",
      creatorId: harness.personId,
    });
    const ctx = actorCtx(harness, "ac02-fork");
    await expect(
      harness.runtime.reputationPolicyService.createPolicyVersion(ctx, {
        organizationScopeId: otherOrg.id,
        policyId: "policy-scoped",
        version: 2,
        rules: DEFAULT_POLICY_RULES,
      }),
    ).rejects.toThrow(/belongs to organization scope/);
  });

  test("rounding is deterministic at 6 decimals (no float drift in scores or digests)", async () => {
    await createDefaultPolicy(harness);
    const ctx = actorCtx(harness, "ac02-rounding");
    const contributionId = await createVerifiedContribution(harness);
    // 30 days before REF_AT with a 90-day half-life → 0.5^(1/3), an
    // irrational factor: rounding is exercised.
    await harness.runtime.reputationInputService.recordInput(ctx, {
      organizationScopeId: harness.organizationScopeId,
      subjectPersonId: harness.personId,
      dimension: "helpfulness",
      sources: [{ kind: "contribution", id: contributionId }],
      occurredAt: "2024-06-01T00:00:00.000Z",
      idempotencyKey: "ac02-rounding-input",
    });
    const a = await harness.runtime.reputationSnapshotService.computeScores(ctx, {
      organizationScopeId: harness.organizationScopeId,
      subjectPersonId: harness.personId,
      policyId: "policy-w007-default",
      version: 1,
      referenceAt: REF_AT,
    });
    const score = a.scores.find((s) => s.dimension === "helpfulness")!;
    expect(score.score).toBe(round6(0.5 ** (30 / 90)));
    expect(score.score).toBe(0.793701);
    // Decimal places are bounded (deterministic serialization).
    expect(String(score.score).split(".")[1]?.length ?? 0).toBeLessThanOrEqual(6);
    const b = await harness.runtime.reputationSnapshotService.computeScores(ctx, {
      organizationScopeId: harness.organizationScopeId,
      subjectPersonId: harness.personId,
      policyId: "policy-w007-default",
      version: 1,
      referenceAt: REF_AT,
    });
    expect(b.digest).toBe(a.digest);
  });

  test("referenceAt is part of the computation: a different reference timestamp is a different digest", async () => {
    await createDefaultPolicy(harness);
    const ctx = actorCtx(harness, "ac02-reference");
    const contributionId = await createVerifiedContribution(harness);
    await harness.runtime.reputationInputService.recordInput(ctx, {
      organizationScopeId: harness.organizationScopeId,
      subjectPersonId: harness.personId,
      dimension: "helpfulness",
      sources: [{ kind: "contribution", id: contributionId }],
      occurredAt: "2024-06-01T00:00:00.000Z",
      idempotencyKey: "ac02-reference-input",
    });
    const at1 = await harness.runtime.reputationSnapshotService.computeScores(ctx, {
      organizationScopeId: harness.organizationScopeId,
      subjectPersonId: harness.personId,
      policyId: "policy-w007-default",
      version: 1,
      referenceAt: REF_AT,
    });
    const at2 = await harness.runtime.reputationSnapshotService.computeScores(ctx, {
      organizationScopeId: harness.organizationScopeId,
      subjectPersonId: harness.personId,
      policyId: "policy-w007-default",
      version: 1,
      referenceAt: "2024-07-02T00:00:00.000Z",
    });
    expect(at1.digest).not.toBe(at2.digest);
    expect(at2.scores.find((s) => s.dimension === "helpfulness")!.score)
      .toBeLessThan(at1.scores.find((s) => s.dimension === "helpfulness")!.score);
  });
});
