/**
 * NET-W031-AC-05 — TIME-DECAY CONSISTENCY (issue #63; REP-003): a
 * proof's disclosed scores are the SAME deterministic decayed values
 * the authority computed and recorded at snapshot time — never
 * recomputed at presentation.
 *
 *  - bit-identical disclosure: every dimension fact equals the
 *    snapshot's stored value, and the proof's digest equals the
 *    snapshot's digest;
 *  - two snapshots at different decay reference times yield proofs
 *    that each disclose THEIR OWN snapshot's decayed values (a
 *    one-half-life gap halves the score — no drift, no mixing);
 *  - presentation-side recomputation is forbidden: the verification
 *    time NEVER enters the signed facts (the canonical input has no
 *    evaluatedAt line) and never alters the disclosed values — only
 *    the staleness gate consumes it;
 *  - the decay anchor (occurredAt far in the past) flows through the
 *    authority's engine into the proof exactly.
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import type { ReputationProof, ReputationSnapshot } from "../../src/reputation/port.ts";
import {
  buildReputationProofDigestInput,
  reputationProofCanonicalFacts,
} from "../../src/reputation/proof-input.ts";
import { REPUTATION_PROOF_FRESHNESS_WINDOW_MS } from "../../src/reputation/port.ts";
import {
  createNetW031Harness,
  seedSubjectSnapshot,
  issueProof,
  verifyStored,
  freshAt,
  staleAt,
  shiftIso,
  REF_AT,
  REF_AT_LATER,
  type NetW031Harness,
} from "./_net-w031-harness.ts";

let harness: NetW031Harness;

beforeEach(async () => {
  harness = await createNetW031Harness();
});

afterEach(async () => {
  await harness.teardown();
});

describe("NET-W031-AC-05 decay consistency", () => {
  test("bit-identical disclosure: every fact equals the snapshot's stored value; the lineage digest is the snapshot's digest", async () => {
    const snapshot: ReputationSnapshot = await seedSubjectSnapshot(harness, { inputCount: 2 });
    const { proof }: { proof: ReputationProof } = await issueProof(harness, {
      snapshotId: snapshot.id,
    });
    snapshot.scores.forEach((score, i) => {
      expect(Object.is(proof.dimensions[i]!.score, score.score)).toBe(true);
      expect(Object.is(proof.dimensions[i]!.inputCount, score.inputCount)).toBe(true);
      expect(Object.is(proof.dimensions[i]!.verifiedInputCount, score.verifiedInputCount)).toBe(true);
      expect(Object.is(proof.dimensions[i]!.indicatedInputCount, score.indicatedInputCount)).toBe(true);
      expect(proof.dimensions[i]!.capped).toBe(score.capped);
    });
    expect(proof.digest).toBe(snapshot.digest);
    expect(proof.referenceAt).toBe(snapshot.referenceAt);
  });

  test("two snapshots at different decay reference times: each proof discloses ITS OWN snapshot's decayed values (one half-life halves the score)", async () => {
    // Two ISOLATED subjects (the second tenant's person — the default
    // rules are identical), same occurredAt, reference times 90 days
    // apart (= one 90-day half-life under the default rules).
    const early = await seedSubjectSnapshot(harness, {
      inputCount: 1,
      occurredAt: "2024-06-01T00:00:00.000Z",
      referenceAt: REF_AT,
    });
    const late = await seedSubjectSnapshot(harness, {
      inputCount: 1,
      occurredAt: "2024-06-01T00:00:00.000Z",
      referenceAt: REF_AT_LATER,
      otherOrg: true,
    });
    const earlyProof = (await issueProof(harness, { snapshotId: early.id })).proof;
    const lateProof = (await issueProof(harness, {
      snapshotId: late.id,
      otherOrg: true,
    })).proof;

    const earlyScore = earlyProof.dimensions[0]!.score;
    const lateScore = lateProof.dimensions[0]!.score;
    // The AUTHORITY's decay: one half-life halves the weight. (5dp
    // tolerance: both disclosed values pass through the authority's
    // independent round6 rounding, which may differ by 1 ulp.)
    expect(lateScore).toBeCloseTo(earlyScore / 2, 5);
    // The proofs disclose THEIR OWN snapshots' values exactly — the
    // late proof does NOT re-derive from the early one, and neither
    // drifts.
    expect(earlyScore).toBe(early.scores[0]!.score);
    expect(lateScore).toBe(late.scores[0]!.score);
    expect(lateProof.digest).toBe(late.digest);
    expect(earlyProof.digest).toBe(early.digest);
    // A re-derived deterministic recomputation by the authority's OWN
    // engine still reproduces the recorded snapshot (and hence the
    // disclosed values) — reconstructability through the lineage.
    const recomputed = await harness.runtime.reputationSnapshotService.computeScores(
      (await import("../../src/core/execution-context.ts")).createExecutionContext({
        correlationId: "ac05-recompute",
        actor: { id: harness.personId, kind: "person" },
      }),
      {
        organizationScopeId: harness.organizationScopeId,
        subjectPersonId: harness.personId,
        policyId: early.policyId,
        version: 1,
        referenceAt: REF_AT,
      },
    );
    expect(recomputed.digest).toBe(early.digest);
    expect(recomputed.scores[0]!.score).toBe(earlyScore);
  });

  test("presentation-side recomputation is FORBIDDEN: the verification time never enters the signed facts and never alters the disclosure", async () => {
    const snapshot = await seedSubjectSnapshot(harness, { inputCount: 2 });
    const { proof } = await issueProof(harness, { snapshotId: snapshot.id });

    // The canonical input has NO evaluatedAt line — the only time it
    // carries is the signed issuance timestamp.
    const canonical = buildReputationProofDigestInput(reputationProofCanonicalFacts(proof));
    expect(canonical).toContain(`issued-at:${proof.issuedAt}`);
    expect(canonical).not.toContain("evaluatedAt");

    // Verifying at DIFFERENT fresh times leaves the artifact (and its
    // disclosed values) byte-identical; even a STALE verdict mutates
    // nothing on the record.
    const before = JSON.stringify(proof);
    const t1 = await verifyStored(harness, proof.id, freshAt(proof));
    const t2 = await verifyStored(
      harness,
      proof.id,
      shiftIso(proof.issuedAt, REPUTATION_PROOF_FRESHNESS_WINDOW_MS - 1000),
    );
    const t3 = await verifyStored(harness, proof.id, staleAt(proof));
    expect(t1.valid).toBe(true);
    expect(t2.valid).toBe(true);
    expect(t3.valid).toBe(false);
    expect(t3.reason).toBe("proof_stale");
    const stored = await harness.runtime.reputationProofService.getProof(
      (await import("../../src/core/execution-context.ts")).createExecutionContext({
        correlationId: "ac05-read",
        actor: { id: harness.personId, kind: "person" },
      }),
      harness.organizationScopeId,
      proof.id,
    );
    expect(JSON.stringify(stored)).toBe(before);
    expect(stored.dimensions[0]!.score).toBe(snapshot.scores[0]!.score);
  });

  test("the decay anchor (occurredAt far in the past) flows through the authority's engine into the proof exactly", async () => {
    // Two ISOLATED subjects (the second tenant's person): one input
    // ~11 days before the reference, one a full YEAR earlier (≈ 4
    // half-lives at 90 days). The authority's score for the ancient
    // subject is ~0.5^4 of the recent one; each proof discloses
    // exactly its own recorded value.
    const recent = await seedSubjectSnapshot(harness, {
      inputCount: 1,
      occurredAt: "2024-06-20T00:00:00.000Z",
      referenceAt: "2024-07-01T00:00:00.000Z",
    });
    const ancient = await seedSubjectSnapshot(harness, {
      inputCount: 1,
      occurredAt: "2023-07-01T00:00:00.000Z",
      referenceAt: "2024-07-01T00:00:00.000Z",
      otherOrg: true,
    });
    const recentProof = (await issueProof(harness, { snapshotId: recent.id })).proof;
    const ancientProof = (await issueProof(harness, {
      snapshotId: ancient.id,
      otherOrg: true,
    })).proof;
    expect(recentProof.dimensions[0]!.score).toBeGreaterThan(
      ancientProof.dimensions[0]!.score * 4,
    );
    expect(ancientProof.dimensions[0]!.score).toBe(ancient.scores[0]!.score);
    expect(recentProof.dimensions[0]!.score).toBe(recent.scores[0]!.score);
  });
});
