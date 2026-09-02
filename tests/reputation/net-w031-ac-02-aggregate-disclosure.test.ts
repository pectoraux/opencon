/**
 * NET-W031-AC-02 — AGGREGATE DISCLOSURE ONLY (issue #63; PRIV-001..003).
 *
 *  - the proof artifact (stored record, presented projection AND the
 *    canonical signed input) carries NO raw personal activity: no
 *    input ids, no evidence/contribution source ids, no descriptions,
 *    no occurredAt, no decayed-weight internals, no execution lineage
 *    on the presentation surface, no payload material — the
 *    evidence-reference COUNTS are the only lineage (REP-004);
 *  - the canonical input is line-disciplined: exactly the sanctioned
 *    prefixes, no upstream record ids anywhere;
 *  - cross-scope and subject-mismatched issuance fail closed;
 *  - SENSITIVE evidence payloads never cross into a proof.
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import type { ReputationProof } from "../../src/reputation/port.ts";
import {
  buildReputationProofDigestInput,
  reputationProofCanonicalFacts,
} from "../../src/reputation/proof-input.ts";
import { DEFAULT_POLICY_RULES } from "./_net-w007-harness.ts";
import {
  createNetW031Harness,
  seedSubjectSnapshot,
  issueProof,
  presentedFrom,
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

describe("NET-W031-AC-02 aggregate disclosure containment", () => {
  test("the proof artifact contains NO raw private record material (ids, descriptions, occurredAt, weights, execution lineage on the surface)", async () => {
    const snapshot = await seedSubjectSnapshot(harness, { inputCount: 2 });
    const { proof } = await issueProof(harness, { snapshotId: snapshot.id });

    // Collect the upstream raw-record identifiers the inputs reference.
    const ctx = actorCtx(harness, "ac02-upstream");
    const inputs = await harness.runtime.reputationInputService.listInputs(
      ctx,
      harness.organizationScopeId,
      harness.personId,
    );
    expect(inputs.length).toBeGreaterThan(0);
    const upstreamIds: string[] = [snapshot.id];
    for (const input of inputs) {
      upstreamIds.push(input.id);
      for (const source of input.sources) {
        upstreamIds.push(source.id);
      }
    }

    // The PRESENTED artifact (the portable surface): no upstream record
    // id except the bound snapshot id, no raw-private vocabulary.
    const presented = presentedFrom(proof);
    const serialized = JSON.stringify(presented);
    for (const upstreamId of upstreamIds) {
      if (upstreamId === snapshot.id) continue; // the sanctioned lineage binding
      expect(serialized).not.toContain(upstreamId);
    }
    for (const forbidden of [
      "occurredAt",
      "decayedVerifiedWeight",
      "decayedIndicatedWeight",
      "description",
      "sources",
      "idempotencyKey",
      "executionId",
      "correlationId",
      "causationId",
      "inputIds",
    ]) {
      expect(serialized).not.toContain(`"${forbidden}"`);
    }
    // The STORED record's disclosed facts are equally aggregate-only
    // (the record carries write bookkeeping, but never raw input
    // material).
    const recordSerialized = JSON.stringify(proof);
    for (const upstreamId of upstreamIds) {
      if (upstreamId === snapshot.id) continue;
      expect(recordSerialized).not.toContain(upstreamId);
    }
    expect(recordSerialized).not.toContain("occurredAt");
    expect(recordSerialized).not.toContain("decayedVerifiedWeight");
    expect(recordSerialized).not.toContain('"sources"');
  });

  test("the canonical signed input is line-disciplined: exactly the sanctioned prefixes, no upstream record ids", async () => {
    const snapshot = await seedSubjectSnapshot(harness, { inputCount: 1 });
    const { proof } = await issueProof(harness, { snapshotId: snapshot.id });
    const canonical = buildReputationProofDigestInput(
      reputationProofCanonicalFacts(proof),
    );
    const lines = canonical.split("\n");
    // The header + the seven fixed fact lines + exactly 8 dimension lines.
    expect(lines).toHaveLength(16);
    expect(lines[0]).toBe("reputation-proof/v1");
    expect(lines[1]).toBe(`subject:${harness.personId}`);
    expect(lines[2]).toBe(`organization:${harness.organizationScopeId}`);
    expect(lines[3]).toBe(`snapshot:${snapshot.id}`);
    expect(lines[4]).toBe(`policy:${snapshot.policyId}:1`);
    expect(lines[5]).toBe(`reference-at:${snapshot.referenceAt}`);
    expect(lines[6]).toBe(`issued-at:${proof.issuedAt}`);
    expect(lines[7]).toBe(`digest:${snapshot.digest}`);
    for (let i = 8; i < 16; i += 1) {
      expect(lines[i]).toMatch(/^dimension:[a-z_]+:[0-9]+\.[0-9]{6}:(true|false):[0-9]+:[0-9]+:[0-9]+$/);
    }
    // No upstream evidence/input ids appear anywhere in the input.
    const ctx = actorCtx(harness, "ac02-canonical-upstream");
    const inputs = await harness.runtime.reputationInputService.listInputs(
      ctx,
      harness.organizationScopeId,
      harness.personId,
    );
    for (const input of inputs) {
      expect(canonical).not.toContain(input.id);
      for (const source of input.sources) {
        expect(canonical).not.toContain(source.id);
      }
    }
  });

  test("cross-scope issuance fails closed (explicit id and latest-resolution paths)", async () => {
    const snapshot = await seedSubjectSnapshot(harness, { inputCount: 1 });

    // Explicit snapshotId, wrong scope.
    await expect(
      issueProof(harness, {
        organizationScopeId: harness.otherOrganizationScopeId,
        subjectPersonId: harness.personId,
        snapshotId: snapshot.id,
      }),
    ).rejects.toThrow(/reputation snapshot not found/);

    // Latest-resolution path in a scope where the subject has NO snapshot.
    await expect(
      issueProof(harness, {
        organizationScopeId: harness.otherOrganizationScopeId,
        subjectPersonId: harness.personId,
      }),
    ).rejects.toThrow(/no reputation snapshot recorded for subject/);
  });

  test("a snapshot belonging to ANOTHER subject fails closed (subject binding)", async () => {
    const snapshot = await seedSubjectSnapshot(harness, { inputCount: 1 });
    await expect(
      issueProof(harness, {
        subjectPersonId: harness.otherPersonId,
        snapshotId: snapshot.id,
      }),
    ).rejects.toThrow(/belongs to subject/);
  });

  test("SENSITIVE evidence payload material never crosses into a proof", async () => {
    const ctx = actorCtx(harness, "ac02-sensitive");
    const sensitivePayload = "ac02-secret-payload-material";
    const evidence = await harness.runtime.evidenceService.createEvidence(ctx, {
      organizationScopeId: harness.organizationScopeId,
      ownerId: harness.personId,
      subjectReference: { subjectId: harness.personId, subjectType: "contribution" },
      provenance: { sourceType: "platform", method: "instrumentation" },
      confidence: { point: 0.9 },
      sensitivity: "sensitive",
      sensitivePayload,
    });
    await harness.runtime.reputationInputService.recordInput(ctx, {
      organizationScopeId: harness.organizationScopeId,
      subjectPersonId: harness.personId,
      dimension: "helpfulness",
      sources: [{ kind: "evidence", id: evidence.id }],
      description: "ac02 sensitive-backed input",
      occurredAt: "2024-06-01T00:00:00.000Z",
      idempotencyKey: key("ac02-input"),
    });
    const policy = await harness.runtime.reputationPolicyService.createPolicyVersion(ctx, {
      organizationScopeId: harness.organizationScopeId,
      policyId: `policy-ac02-${key("x")}`,
      version: 1,
      rules: DEFAULT_POLICY_RULES,
    });
    const snap = await harness.runtime.reputationSnapshotService.recordSnapshot(ctx, {
      organizationScopeId: harness.organizationScopeId,
      subjectPersonId: harness.personId,
      policyId: policy.policyId,
      version: 1,
      referenceAt: "2024-07-01T00:00:00.000Z",
      idempotencyKey: key("ac02-snap"),
    });
    const { proof }: { proof: ReputationProof } = await issueProof(harness, {
      snapshotId: snap.snapshot.id,
    });
    const serialized = JSON.stringify(presentedFrom(proof));
    expect(serialized).not.toContain(sensitivePayload);
    expect(serialized).not.toContain(evidence.id);
    // The dimension fact still discloses the aggregate count (the
    // sensitive input is counted, its material is not disclosed).
    expect(proof.dimensions[0]!.inputCount).toBe(1);
    expect(proof.dimensions[0]!.verifiedInputCount).toBe(1);
  });

  test("the presentation projection strips ALL write bookkeeping (the exact portable key set)", async () => {
    const snapshot = await seedSubjectSnapshot(harness, { inputCount: 1 });
    const { proof } = await issueProof(harness, { snapshotId: snapshot.id });
    expect(Object.keys(presentedFrom(proof)).sort()).toEqual([
      "algorithm",
      "createdAt",
      "digest",
      "dimensions",
      "id",
      "issuedAt",
      "keyReference",
      "organizationScopeId",
      "policyId",
      "policyVersion",
      "recordFormat",
      "referenceAt",
      "revocationReason",
      "revokedAt",
      "signature",
      "snapshotId",
      "subjectPersonId",
    ]);
  });

  test("counts are the ONLY evidence-reference lineage on the proof (REP-004 opaque references)", async () => {
    const snapshot = await seedSubjectSnapshot(harness, { inputCount: 4 });
    const { proof } = await issueProof(harness, { snapshotId: snapshot.id });
    const helpfulness = proof.dimensions[0]!;
    expect(helpfulness.inputCount).toBe(4);
    expect(helpfulness.verifiedInputCount).toBe(4);
    // No dimension fact carries ANY id-bearing field.
    for (const fact of proof.dimensions) {
      for (const fieldKey of Object.keys(fact)) {
        const value = (fact as unknown as Record<string, unknown>)[fieldKey];
        expect(typeof value === "string" && value.includes("-")).toBe(false);
      }
    }
  });
});
