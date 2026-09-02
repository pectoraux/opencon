/**
 * NET-W031-AC-04 — NON-PURCHASABILITY containment (issue #63; REP-002).
 *
 *  - the proof surface adds NO score-altering input: the issuance
 *    input carries exactly (scope, subject, optional snapshot
 *    reference, idempotency key) — no score, spend, wealth, amount or
 *    activity field exists on the path;
 *  - caller-asserted facts are structurally impossible: extra request
 *    fields cannot alter the derived facts;
 *  - proof issuance mutates NO economic and NO reputation authority
 *    state;
 *  - spend never becomes reputation substance: a large settled value
 *    for the subject changes nothing about subsequently derived
 *    dimension facts.
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { ReputationProof } from "../../src/reputation/port.ts";
import { REPUTATION_PROOFS_COLLECTION } from "../../src/reputation/authority-proof-repository.ts";
import {
  REPUTATION_INPUTS_COLLECTION,
} from "../../src/reputation/authority-input-repository.ts";
import {
  REPUTATION_SNAPSHOTS_COLLECTION,
} from "../../src/reputation/authority-snapshot-repository.ts";
import { ECONOMIC_VALUE_RECORDS_COLLECTION } from "../../src/settlement/authority-value-repository.ts";
import {
  createNetW031Harness,
  seedSubjectSnapshot,
  issueProof,
  actorCtx,
  key,
  type NetW031Harness,
} from "./_net-w031-harness.ts";

const REPO = join(import.meta.dir, "../..");

let harness: NetW031Harness;

beforeEach(async () => {
  harness = await createNetW031Harness();
});

afterEach(async () => {
  await harness.teardown();
});

describe("NET-W031-AC-04 non-purchasability containment", () => {
  test("the issuance input surface carries NO score-altering field (structural pin)", async () => {
    const portSource = await readFile(join(REPO, "src/reputation/port.ts"), "utf8");
    // The exact IssueReputationProofInput declaration — scope,
    // subject, optional snapshot reference, idempotency key ONLY.
    expect(portSource).toContain("export interface IssueReputationProofInput {");
    const inputBlock = portSource.slice(
      portSource.indexOf("export interface IssueReputationProofInput {"),
      portSource.indexOf("export interface IssueReputationProofResult {"),
    );
    expect(inputBlock).toContain("organizationScopeId");
    expect(inputBlock).toContain("subjectPersonId");
    expect(inputBlock).toContain("snapshotId?: string");
    expect(inputBlock).toContain("idempotencyKey");
    for (const forbidden of [
      "score",
      "amount",
      "spend",
      "wealth",
      "credits",
      "deposit",
      "payment",
      "reward",
      "boost",
    ]) {
      expect(inputBlock).not.toContain(forbidden);
    }
    // The proof record itself carries no economic vocabulary either.
    const proofBlock = portSource.slice(
      portSource.indexOf("export interface ReputationProofDimensionFact {"),
      portSource.indexOf("export interface PresentedReputationProof {"),
    );
    for (const forbidden of ["amount", "spend", "wealth", "credits", "payment", "reward"]) {
      expect(proofBlock.toLowerCase()).not.toContain(forbidden);
    }
  });

  test("caller-asserted facts are structurally impossible: extra fields cannot alter the derivation", async () => {
    const snapshot = await seedSubjectSnapshot(harness, { inputCount: 1 });
    // A request carrying "wishful" extra fields — the service accepts
    // the input shape and derives EVERYTHING from the snapshot; the
    // extras are ignored (never read, never persisted).
    const result = await harness.runtime.reputationProofService.issueProof(
      actorCtx(harness, "ac04-extras"),
      {
        organizationScopeId: harness.organizationScopeId,
        subjectPersonId: harness.personId,
        snapshotId: snapshot.id,
        idempotencyKey: key("ac04-extras"),
        ...({ score: 1000, amount: 1_000_000, spend: 5000 } as Record<string, unknown>),
      } as never,
    );
    expect(result.proof.dimensions[0]!.score).toBe(snapshot.scores[0]!.score);
    expect(result.proof.dimensions[0]!.inputCount).toBe(snapshot.scores[0]!.inputCount);
    const serialized = JSON.stringify(result.proof);
    expect(serialized).not.toContain("1000");
    expect(serialized).not.toContain("5000");
  });

  test("proof issuance mutates NO economic and NO reputation authority state", async () => {
    const snapshot = await seedSubjectSnapshot(harness, { inputCount: 1 });
    const authority = harness.runtime.postgresAuthority;
    const economicBefore = await authority.count(ECONOMIC_VALUE_RECORDS_COLLECTION);
    const inputsBefore = await authority.count(REPUTATION_INPUTS_COLLECTION);
    const snapshotsBefore = await authority.count(REPUTATION_SNAPSHOTS_COLLECTION);
    const proofsBefore = await authority.count(REPUTATION_PROOFS_COLLECTION);

    const { proof }: { proof: ReputationProof } = await issueProof(harness, {
      snapshotId: snapshot.id,
    });

    // ONLY the proof collection grew.
    expect(await authority.count(ECONOMIC_VALUE_RECORDS_COLLECTION)).toBe(economicBefore);
    expect(await authority.count(REPUTATION_INPUTS_COLLECTION)).toBe(inputsBefore);
    expect(await authority.count(REPUTATION_SNAPSHOTS_COLLECTION)).toBe(snapshotsBefore);
    expect(await authority.count(REPUTATION_PROOFS_COLLECTION)).toBe(proofsBefore + 1);
    // The bound snapshot is byte-identical after issuance.
    const after = await harness.runtime.reputationSnapshotService.getSnapshot(
      actorCtx(harness, "ac04-snap-read"),
      snapshot.id,
    );
    expect(after).toEqual(snapshot);
  });

  test("spend never becomes reputation substance: a large settled value changes NOTHING about derived facts", async () => {
    const ctx = actorCtx(harness, "ac04-spend");
    // Baseline: one helpfulness input + snapshot + proof.
    const baseline = await seedSubjectSnapshot(harness, { inputCount: 1 });
    const baselineProof = (await issueProof(harness, { snapshotId: baseline.id })).proof;

    // A LARGE matured economic value for the SAME subject (spend on
    // the platform — the exact substance REP-002 forbids).
    const evidence = await harness.runtime.evidenceService.createEvidence(ctx, {
      organizationScopeId: harness.organizationScopeId,
      ownerId: harness.personId,
      subjectReference: { subjectId: harness.personId, subjectType: "contribution" },
      provenance: { sourceType: "platform", method: "instrumentation" },
      confidence: { point: 0.9 },
    });
    const value = await harness.runtime.economicValueService.recordPendingValue(ctx, {
      organizationScopeId: harness.organizationScopeId,
      beneficiaryPersonId: harness.personId,
      amount: 1_000_000,
      sources: [{ kind: "evidence", id: evidence.id }],
      maturation: { strategy: "immediate" },
      description: "ac04 large spend",
      idempotencyKey: key("ac04-value"),
    });
    await harness.runtime.economicValueService.matureValue(ctx, {
      valueRecordId: value.value.id,
      idempotencyKey: key("ac04-mature"),
    });

    // A NEW snapshot (no new reputation input — the value record is
    // NOT a reputation source) derives IDENTICAL facts, and so does a
    // proof over it.
    const policy = await harness.runtime.reputationPolicyService.createPolicyVersion(ctx, {
      organizationScopeId: harness.organizationScopeId,
      policyId: baseline.policyId,
      version: 2,
      description: "ac04 v2",
      rules: (await import("./_net-w007-harness.ts")).DEFAULT_POLICY_RULES,
    });
    const after = await harness.runtime.reputationSnapshotService.recordSnapshot(ctx, {
      organizationScopeId: harness.organizationScopeId,
      subjectPersonId: harness.personId,
      policyId: policy.policyId,
      version: 2,
      referenceAt: baseline.referenceAt,
      idempotencyKey: key("ac04-snap-after"),
    });
    const afterProof = (await issueProof(harness, { snapshotId: after.snapshot.id })).proof;

    expect(afterProof.dimensions.map((d) => [d.dimension, d.score, d.inputCount])).toEqual(
      baselineProof.dimensions.map((d) => [d.dimension, d.score, d.inputCount]),
    );
    // The million-unit value appears NOWHERE in the proof artifact.
    expect(JSON.stringify(afterProof)).not.toContain("1000000");
  });
});
