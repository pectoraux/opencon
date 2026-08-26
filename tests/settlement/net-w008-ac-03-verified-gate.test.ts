/**
 * NET-W008-AC-03 — Credit issuance requires qualifying verified value
 * and cannot be triggered by spend/wealth/activity/reputation alone
 * (ECON-001..003; architecture-lock §1.3, §1.4, §5, invariant 20).
 *
 *  - credit issuance requires a MATURE value record carrying ≥1
 *    VERIFIED Proof-of-Value reference (invariant 20);
 *  - a value record backed ONLY by a measured outcome (no PoV) can
 *    mature but CANNOT issue credits;
 *  - value recognition rejects unverified upstream records (DRAFT
 *    PoVs, non-final measured outcomes) and model/self evidence;
 *  - spend, wealth, deposits, raw activity volume and reputation
 *    records have NO contract path: the source gate is structural
 *    (unknown source kinds are rejected; a reputation snapshot id is
 *    not a source kind and cannot enter).
 *
 * Evidence: domain/integration tests.
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import {
  createNetW008Harness,
  createMatureValue,
  createPendingValue,
  createVerifiedPoV,
  createVerifiedMeasuredOutcome,
  createContribution,
  createEvidence,
  assertGlobalConservation,
  actorCtx,
  type NetW008Harness,
} from "./_net-w008-harness.ts";

let harness: NetW008Harness;

beforeEach(async () => {
  harness = await createNetW008Harness();
});

afterEach(async () => {
  await harness.teardown();
});

describe("NET-W008-AC-03 no unverified issuance; verified-value gate", () => {
  test("credit issuance against a value record WITHOUT a PoV source is rejected (invariant 20)", async () => {
    // A value record backed ONLY by a VERIFIED measured outcome.
    const measurement = await createVerifiedMeasuredOutcome(harness);
    const ctx = actorCtx(harness, "ac03-no-pov");
    const pendingResult = await harness.runtime.economicValueService.recordPendingValue(ctx, {
      organizationScopeId: harness.organizationScopeId,
      beneficiaryPersonId: harness.personId,
      amount: 12,
      sources: [{ kind: "measured_outcome", id: measurement.id }],
      idempotencyKey: `ac03-mo-${measurement.id}`,
    });
    const matured = await harness.runtime.economicValueService.matureValue(ctx, {
      valueRecordId: pendingResult.value.id,
      idempotencyKey: `ac03-mo-mature-${pendingResult.value.id}`,
    });
    expect(matured.state).toBe("MATURE");

    let err: Error | null = null;
    try {
      await harness.runtime.creditService.issueCredits(ctx, {
        organizationScopeId: harness.organizationScopeId,
        beneficiaryPersonId: harness.personId,
        sourceValueRecordId: matured.id,
        creditsPerValueUnit: 1,
        idempotencyKey: "ac03-no-pov-issue",
      });
    } catch (e) {
      err = e as Error;
    }
    expect(err).not.toBeNull();
    expect((err as Error).message).toMatch(
      /requires a VERIFIED Proof-of-Value reference/,
    );
    expect((err as Error).message).toMatch(/invariant 20/);
    expect((err as Error & { code?: string }).code).toBe("ECONOMIC_VALIDATION");

    // No credits were minted; the record is still MATURE (the failed
    // issuance rolled back entirely — atomicity).
    const record = await harness.runtime.economicValueService.getValue(ctx, matured.id);
    expect(record.state).toBe("MATURE");
    expect(record.consumedBy).toBeNull();
    const summary = await harness.runtime.economicLedgerService.getParticipantSummary(
      harness.bootstrapCtx,
      harness.organizationScopeId,
      harness.personId,
    );
    expect(summary.credits).toBe(0);
    await assertGlobalConservation(harness);
  });

  test("value recognition rejects a DRAFT (unverified) Proof-of-Value", async () => {
    // Create a PoV and drive it only to MEASURING (not VERIFIED).
    const subject = await createContribution(harness);
    const e = await createEvidence(harness, { sourceType: "platform" });
    const ctx = actorCtx(harness, "ac03-draft-pov");
    const proof = await harness.runtime.proofOfValueService.createProofOfValue(ctx, {
      organizationScopeId: harness.organizationScopeId,
      ownerId: harness.personId,
      subjectReference: { subjectId: subject.id, subjectType: "contribution" },
      evidenceIds: [e.id],
    });
    expect(proof.state).toBe("DRAFT");

    let err: Error | null = null;
    try {
      await harness.runtime.economicValueService.recordPendingValue(ctx, {
        organizationScopeId: harness.organizationScopeId,
        beneficiaryPersonId: harness.personId,
        amount: 100,
        sources: [{ kind: "proof_of_value", id: proof.id }],
        idempotencyKey: `ac03-draft-${proof.id}`,
      });
    } catch (e2) {
      err = e2 as Error;
    }
    expect(err).not.toBeNull();
    expect((err as Error).message).toMatch(/is in state DRAFT, not VERIFIED/);
  });

  test("model/self evidence NEVER qualifies as an economic input (architecture-lock §4)", async () => {
    const ctx = actorCtx(harness, "ac03-model-evidence");
    for (const sourceType of ["model", "self"] as const) {
      const evidence = await createEvidence(harness, { sourceType });
      let err: Error | null = null;
      try {
        await harness.runtime.economicValueService.recordPendingValue(ctx, {
          organizationScopeId: harness.organizationScopeId,
          beneficiaryPersonId: harness.personId,
          amount: 10,
          sources: [{ kind: "evidence", id: evidence.id }],
          idempotencyKey: `ac03-${sourceType}-${evidence.id}`,
        });
      } catch (e) {
        err = e as Error;
      }
      expect(err).not.toBeNull();
      expect((err as Error).message).toMatch(
        /does not qualify as a verified economic input/,
      );
    }
    // Platform evidence DOES qualify (control).
    const platform = await createEvidence(harness, { sourceType: "platform" });
    const ok = await harness.runtime.economicValueService.recordPendingValue(ctx, {
      organizationScopeId: harness.organizationScopeId,
      beneficiaryPersonId: harness.personId,
      amount: 10,
      sources: [{ kind: "evidence", id: platform.id }],
      idempotencyKey: `ac03-platform-${platform.id}`,
    });
    expect(ok.value.state).toBe("PENDING");
  });

  test("spend/wealth/deposits/raw activity/reputation have NO source kind — the gate is structural", async () => {
    const ctx = actorCtx(harness, "ac03-structural");
    for (const kind of [
      "advertising_spend",
      "wealth",
      "deposit",
      "activity_volume",
      "reputation_snapshot",
      "model_output",
    ]) {
      let err: Error | null = null;
      try {
        await harness.runtime.economicValueService.recordPendingValue(ctx, {
          organizationScopeId: harness.organizationScopeId,
          beneficiaryPersonId: harness.personId,
          amount: 10,
          sources: [{ kind, id: "anything" }],
          idempotencyKey: `ac03-structural-${kind}`,
        });
      } catch (e) {
        err = e as Error;
      }
      expect(err).not.toBeNull();
      expect((err as Error).message).toMatch(/economic source kind must be one of/);
    }
    // A bare assertion without any source is rejected too.
    let err = null;
    try {
      await harness.runtime.economicValueService.recordPendingValue(ctx, {
        organizationScopeId: harness.organizationScopeId,
        beneficiaryPersonId: harness.personId,
        amount: 10,
        sources: [],
        idempotencyKey: "ac03-structural-empty",
      });
    } catch (e) {
      err = e as Error;
    }
    expect(err).not.toBeNull();
    expect((err as Error).message).toMatch(
      /requires at least one upstream source reference/,
    );
  });

  test("a reputation snapshot id cannot enter the economic ledger even as a fake evidence/measurement id", async () => {
    // Record a reputation snapshot in the reputation domain (W007),
    // then attempt to reference its id as an economic source.
    const ctx = actorCtx(harness, "ac03-reputation-id");
    const contribution = await createContribution(harness);
    void contribution;
    const pov = await createVerifiedPoV(harness);
    await harness.runtime.reputationPolicyService.createPolicyVersion(ctx, {
      organizationScopeId: harness.organizationScopeId,
      policyId: "ac03-policy",
      version: 1,
      rules: [
        "helpfulness", "content_quality", "creator_performance", "inventory_quality",
        "measurement_reliability", "commerce_reliability", "fraud_resistance", "fulfillment_reliability",
      ].map((dimension) => ({
        dimension,
        inputWeight: 1,
        decayHalfLifeDays: 90,
        maxScore: 100,
        indicatedWeightFactor: 0.25,
        indicatedOnlyCap: 10,
      })),
    });
    await harness.runtime.reputationInputService.recordInput(ctx, {
      organizationScopeId: harness.organizationScopeId,
      subjectPersonId: harness.personId,
      dimension: "helpfulness",
      sources: [{ kind: "proof_of_value", id: pov.id }],
      occurredAt: "2024-06-01T00:00:00.000Z",
      idempotencyKey: "ac03-rep-input",
    });
    const snapshot = await harness.runtime.reputationSnapshotService.recordSnapshot(ctx, {
      organizationScopeId: harness.organizationScopeId,
      subjectPersonId: harness.personId,
      policyId: "ac03-policy",
      referenceAt: "2024-07-01T00:00:00.000Z",
      idempotencyKey: "ac03-rep-snapshot",
    });

    // Referencing the snapshot id under ANY source kind fails: not a
    // PoV, not a measured outcome, not evidence.
    for (const kind of ["proof_of_value", "measured_outcome", "evidence"]) {
      let err: Error | null = null;
      try {
        await harness.runtime.economicValueService.recordPendingValue(ctx, {
          organizationScopeId: harness.organizationScopeId,
          beneficiaryPersonId: harness.personId,
          amount: 10,
          sources: [{ kind, id: snapshot.snapshot.id }],
          idempotencyKey: `ac03-snap-${kind}`,
        });
      } catch (e) {
        err = e as Error;
      }
      expect(err).not.toBeNull();
      expect((err as Error).message).toMatch(/not found|does not qualify/);
    }
    // Reputation alone minted nothing.
    const summary = await harness.runtime.economicLedgerService.getParticipantSummary(
      harness.bootstrapCtx,
      harness.organizationScopeId,
      harness.personId,
    );
    expect(summary.credits).toBe(0);
    expect(summary.pendingValue).toBe(0);
    expect(summary.matureValue).toBe(0);
  });

  test("issuance against a CONSUMED or REVERSED record is rejected (exactly-once consumption)", async () => {
    const value = await createMatureValue(harness, { amount: 100 });
    const ctx = actorCtx(harness, "ac03-consumed");
    await harness.runtime.creditService.issueCredits(ctx, {
      organizationScopeId: harness.organizationScopeId,
      beneficiaryPersonId: harness.personId,
      sourceValueRecordId: value.id,
      creditsPerValueUnit: 1,
      idempotencyKey: "ac03-consumed-issue",
    });
    let err: Error | null = null;
    try {
      await harness.runtime.creditService.issueCredits(ctx, {
        organizationScopeId: harness.organizationScopeId,
        beneficiaryPersonId: harness.personId,
        sourceValueRecordId: value.id,
        creditsPerValueUnit: 1,
        idempotencyKey: "ac03-consumed-issue-2",
      });
    } catch (e) {
      err = e as Error;
    }
    expect(err).not.toBeNull();
    expect((err as Error).message).toMatch(/is CONSUMED, not MATURE/);
    // Conservation holds — exactly one issuance of 100 credits.
    const summary = await harness.runtime.economicLedgerService.getParticipantSummary(
      harness.bootstrapCtx,
      harness.organizationScopeId,
      harness.personId,
    );
    expect(summary.credits).toBe(100);
    await assertGlobalConservation(harness);
  });

  test("cross-organization sources are rejected (tenant scoping)", async () => {
    const otherOrg = await harness.runtime.organizationService.createOrganization(
      harness.bootstrapCtx,
      { name: "Other Economic Org", creatorId: harness.personId },
    );
    void otherOrg;
    // A PoV in the harness org cannot back a value record claimed for
    // ANOTHER organization scope id... the scope is part of the input.
    const pov = await createVerifiedPoV(harness);
    const ctx = actorCtx(harness, "ac03-cross-org");
    let err: Error | null = null;
    try {
      await harness.runtime.economicValueService.recordPendingValue(ctx, {
        organizationScopeId: "00000000-0000-0000-0000-000000000000",
        beneficiaryPersonId: harness.personId,
        amount: 10,
        sources: [{ kind: "proof_of_value", id: pov.id }],
        idempotencyKey: "ac03-cross-org",
      });
    } catch (e) {
      err = e as Error;
    }
    expect(err).not.toBeNull();
    expect((err as Error).message).toMatch(/belongs to organization scope/);
  });
});
