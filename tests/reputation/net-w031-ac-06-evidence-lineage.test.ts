/**
 * NET-W031-AC-06 — EVIDENCE LINEAGE (issue #63; REP-004): material
 * reputation changes trace to evidence, and proofs reference the
 * authoritative input/evidence lineage OPAQUELY — counts, never
 * payloads or raw ids.
 *
 *  - the disclosed counts are the authority's own snapshot counts and
 *    match the actual recorded upstream inputs (each itself carrying
 *    ≥1 verified source reference — the W007 provenance gate);
 *  - the lineage tuple (snapshotId / policyId / policyVersion /
 *    referenceAt / digest) is carried and BOUND INTO the signature;
 *  - the only lineage IDS a proof carries are the snapshot + policy
 *    ids — no evidence/input/contribution id appears anywhere;
 *  - supersession is re-issuance: after new evidence-backed inputs and
 *    a new snapshot, a NEW proof carries the incremented counts and
 *    the NEW lineage; the OLD proof is unchanged and still verifies.
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import type { ReputationProof } from "../../src/reputation/port.ts";
import {
  createNetW031Harness,
  seedSubjectSnapshot,
  issueProof,
  verifyStored,
  verifyPresented,
  presentedFrom,
  tamperProof,
  freshAt,
  actorCtx,
  key,
  type NetW031Harness,
} from "./_net-w031-harness.ts";

let harness: NetW031Harness;

beforeEach(async () => {
  harness = await createNetW031Harness();
});

afterEach(async () => {
  await harness.teardown();
});

describe("NET-W031-AC-06 evidence lineage", () => {
  test("the disclosed counts match the authority's snapshot counts AND the recorded upstream inputs", async () => {
    const snapshot = await seedSubjectSnapshot(harness, { inputCount: 3 });
    const { proof } = await issueProof(harness, { snapshotId: snapshot.id });
    const helpfulness = proof.dimensions[0]!;
    expect(helpfulness.inputCount).toBe(3);

    // The authority's OWN input listing agrees (each recorded input
    // itself carries ≥1 verified source — the W007 provenance gate,
    // so the count traces to evidence all the way down).
    const ctx = actorCtx(harness, "ac06-inputs");
    const inputs = await harness.runtime.reputationInputService.listInputs(
      ctx,
      harness.organizationScopeId,
      harness.personId,
    );
    const helpfulnessInputs = inputs.filter((i) => i.dimension === "helpfulness");
    expect(helpfulnessInputs).toHaveLength(3);
    for (const input of helpfulnessInputs) {
      expect(input.sources.length).toBeGreaterThanOrEqual(1);
      expect(input.sources[0]!.kind).toBe("evidence");
    }
    expect(helpfulness.verifiedInputCount).toBe(
      helpfulnessInputs.filter((i) => i.basis === "verified").length,
    );
  });

  test("the lineage tuple is BOUND INTO the signature (tampering any lineage id fails closed)", async () => {
    const snapshot = await seedSubjectSnapshot(harness, { inputCount: 1 });
    const { proof } = await issueProof(harness, { snapshotId: snapshot.id });
    expect(proof.snapshotId).toBe(snapshot.id);
    expect(proof.policyId).toBe(snapshot.policyId);

    await tamperProof(harness, proof.id, (r) => ({ ...r, snapshotId: "rogue-lineage" }));
    const verdict = await verifyStored(harness, proof.id, freshAt(proof));
    expect(verdict.valid).toBe(false);
    expect(verdict.reason).toBe("signature_mismatch");
  });

  test("the ONLY lineage ids a proof carries are the snapshot + policy ids (no upstream record id anywhere)", async () => {
    const snapshot = await seedSubjectSnapshot(harness, { inputCount: 2 });
    const { proof }: { proof: ReputationProof } = await issueProof(harness, {
      snapshotId: snapshot.id,
    });
    const ctx = actorCtx(harness, "ac06-upstream");
    const inputs = await harness.runtime.reputationInputService.listInputs(
      ctx,
      harness.organizationScopeId,
      harness.personId,
    );
    const serialized = JSON.stringify(presentedFrom(proof));
    // The sanctioned lineage ids ARE present (the binding).
    expect(serialized).toContain(snapshot.id);
    expect(serialized).toContain(snapshot.policyId);
    // No upstream record id is.
    for (const input of inputs) {
      expect(serialized).not.toContain(input.id);
      for (const source of input.sources) {
        expect(serialized).not.toContain(source.id);
      }
    }
  });

  test("supersession is re-issuance: new evidence → new snapshot → NEW proof with incremented counts; the OLD proof is unchanged and still verifies", async () => {
    const first = await seedSubjectSnapshot(harness, { inputCount: 1 });
    const firstProof = (await issueProof(harness, { snapshotId: first.id })).proof;

    // New evidence-backed input + a fresh snapshot (the authority's
    // material-change path — every input references evidence).
    const ctx = actorCtx(harness, "ac06-supersede");
    const evidence = await harness.runtime.evidenceService.createEvidence(ctx, {
      organizationScopeId: harness.organizationScopeId,
      ownerId: harness.personId,
      subjectReference: { subjectId: harness.personId, subjectType: "contribution" },
      provenance: { sourceType: "platform", method: "instrumentation" },
      confidence: { point: 0.9 },
    });
    await harness.runtime.reputationInputService.recordInput(ctx, {
      organizationScopeId: harness.organizationScopeId,
      subjectPersonId: harness.personId,
      dimension: "helpfulness",
      sources: [{ kind: "evidence", id: evidence.id }],
      occurredAt: "2024-06-02T00:00:00.000Z",
      idempotencyKey: key("ac06-new-input"),
    });
    const second = await harness.runtime.reputationSnapshotService.recordSnapshot(ctx, {
      organizationScopeId: harness.organizationScopeId,
      subjectPersonId: harness.personId,
      policyId: first.policyId,
      version: 1,
      referenceAt: first.referenceAt,
      idempotencyKey: key("ac06-new-snap"),
    });
    const secondProof = (await issueProof(harness, { snapshotId: second.snapshot.id })).proof;

    // The NEW proof carries the incremented counts + the new lineage.
    expect(secondProof.snapshotId).toBe(second.snapshot.id);
    expect(secondProof.dimensions[0]!.inputCount).toBe(2);
    expect(secondProof.digest).toBe(second.snapshot.digest);
    expect(secondProof.dimensions[0]!.inputCount).toBeGreaterThan(
      firstProof.dimensions[0]!.inputCount,
    );

    // The OLD proof is unchanged and still verifies (re-issuance never
    // rewrites history; staleness governs currency).
    const oldVerdict = await verifyPresented(harness, presentedFrom(firstProof), freshAt(firstProof));
    expect(oldVerdict.valid).toBe(true);
    const storedOld = await harness.runtime.reputationProofService.getProof(
      ctx,
      harness.organizationScopeId,
      firstProof.id,
    );
    expect(storedOld).toEqual(firstProof);
  });

  test("the lineage vocabulary is closed: policy lineage ids are opaque strings, and the proof binds the EXACT version", async () => {
    const snapshot = await seedSubjectSnapshot(harness, { inputCount: 1 });
    const ctx = actorCtx(harness, "ac06-version");
    // A v2 of the SAME policy lineage with IDENTICAL rules — the
    // proof still binds the EXACT (policyId, version) it was issued
    // against (never an ambient "current" policy).
    await harness.runtime.reputationPolicyService.createPolicyVersion(ctx, {
      organizationScopeId: harness.organizationScopeId,
      policyId: snapshot.policyId,
      version: 2,
      rules: (await import("./_net-w007-harness.ts")).DEFAULT_POLICY_RULES,
    });
    const { proof } = await issueProof(harness, { snapshotId: snapshot.id });
    expect(proof.policyId).toBe(snapshot.policyId);
    expect(proof.policyVersion).toBe(1);
  });
});
