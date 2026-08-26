/**
 * NET-W007-AC-03 — Evidence/verified-value provenance is retained for
 * material score changes (REP-004, AUD-004).
 *
 *  - every input MUST reference ≥1 upstream record (evidence /
 *    Proof-of-Value / measured outcome / contribution) resolved through
 *    the neutral lookups: nonexistent or cross-scope sources are
 *    rejected;
 *  - the derived basis is deterministic: VERIFIED lifecycle records
 *    and platform/attested/provider evidence → verified; model/self
 *    evidence and non-VERIFIED lifecycle records → indicated;
 *  - snapshots record the exact inputIds they cover, and the audit
 *    trail (reputation_input.recorded / reputation_snapshot.recorded)
 *    carries the upstream references + digest + policy version —
 *    reputation lineage (AUD-004).
 *
 * Evidence: domain integration tests over the wired neutral lookups +
 * audit queries.
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import {
  createNetW007Harness,
  actorCtx,
  createDefaultPolicy,
  createContribution,
  createVerifiedContribution,
  createVerifiedPoV,
  createVerifiedMeasuredOutcome,
  createEvidence,
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

describe("NET-W007-AC-03 provenance", () => {
  test("an input WITHOUT upstream source references is rejected (a bare activity assertion cannot enter)", async () => {
    await createDefaultPolicy(harness);
    const ctx = actorCtx(harness, "ac03-no-sources");
    await expect(
      harness.runtime.reputationInputService.recordInput(ctx, {
        organizationScopeId: harness.organizationScopeId,
        subjectPersonId: harness.personId,
        dimension: "helpfulness",
        sources: [],
        occurredAt: REF_AT,
        idempotencyKey: "ac03-no-sources",
      }),
    ).rejects.toThrow(/at least one upstream source reference/);
  });

  test("an input referencing a NONEXISTENT source is rejected (fail closed)", async () => {
    await createDefaultPolicy(harness);
    const ctx = actorCtx(harness, "ac03-unknown-source");
    await expect(
      harness.runtime.reputationInputService.recordInput(ctx, {
        organizationScopeId: harness.organizationScopeId,
        subjectPersonId: harness.personId,
        dimension: "helpfulness",
        sources: [{ kind: "evidence", id: "does-not-exist" }],
        occurredAt: REF_AT,
        idempotencyKey: "ac03-unknown",
      }),
    ).rejects.toThrow(/upstream evidence not found/);
    // Same fail-closed behaviour for every source kind.
    for (const kind of ["proof_of_value", "measured_outcome", "contribution"] as const) {
      await expect(
        harness.runtime.reputationInputService.recordInput(ctx, {
          organizationScopeId: harness.organizationScopeId,
          subjectPersonId: harness.personId,
          dimension: "helpfulness",
          sources: [{ kind, id: "does-not-exist" }],
          occurredAt: REF_AT,
          idempotencyKey: `ac03-unknown-${kind}`,
        }),
      ).rejects.toThrow();
    }
  });

  test("an input referencing a source from ANOTHER organization scope is rejected (tenant isolation)", async () => {
    await createDefaultPolicy(harness);
    const bootstrapCtx = harness.bootstrapCtx;
    const otherPerson = await harness.runtime.identityService.createIdentity(bootstrapCtx, {
      displayName: "Other Person",
      subjectReferences: [{ subjectId: "other@example.com", providerKind: "internal" }],
    });
    const otherOrg = await harness.runtime.organizationService.createOrganization(bootstrapCtx, {
      name: "Other Org",
      creatorId: otherPerson.id,
    });
    // An evidence record in the OTHER org.
    const otherCtx = {
      ...actorCtx(harness, "ac03-other-org-evidence"),
    };
    const otherEvidence = await harness.runtime.evidenceService.createEvidence(otherCtx, {
      organizationScopeId: otherOrg.id,
      ownerId: otherPerson.id,
      subjectReference: { subjectId: otherPerson.id, subjectType: "contribution" },
      provenance: { sourceType: "platform", method: "instrumentation" },
      confidence: { point: 0.9 },
    });
    const ctx = actorCtx(harness, "ac03-cross-scope");
    await expect(
      harness.runtime.reputationInputService.recordInput(ctx, {
        organizationScopeId: harness.organizationScopeId,
        subjectPersonId: harness.personId,
        dimension: "helpfulness",
        sources: [{ kind: "evidence", id: otherEvidence.id }],
        occurredAt: REF_AT,
        idempotencyKey: "ac03-cross-scope",
      }),
    ).rejects.toThrow(/belongs to organization scope/);
  });

  test("the basis is DERIVED deterministically from the resolved upstream records (never caller-asserted)", async () => {
    await createDefaultPolicy(harness);
    const ctx = actorCtx(harness, "ac03-basis");
    const record = async (sources: readonly { kind: string; id: string }[], key: string) =>
      harness.runtime.reputationInputService.recordInput(ctx, {
        organizationScopeId: harness.organizationScopeId,
        subjectPersonId: harness.personId,
        dimension: "helpfulness",
        sources,
        occurredAt: REF_AT,
        idempotencyKey: key,
      });

    // VERIFIED contribution → verified.
    const verifiedContribution = await createVerifiedContribution(harness);
    expect(
      (await record([{ kind: "contribution", id: verifiedContribution }], "ac03-b-v")).input.basis,
    ).toBe("verified");

    // A DRAFT (non-VERIFIED) contribution → indicated.
    const draftContribution = await createContribution(harness);
    expect(
      (await record([{ kind: "contribution", id: draftContribution.id }], "ac03-b-d")).input.basis,
    ).toBe("indicated");

    // VERIFIED Proof-of-Value → verified.
    const pov = await createVerifiedPoV(harness);
    expect((await record([{ kind: "proof_of_value", id: pov.id }], "ac03-b-pov")).input.basis)
      .toBe("verified");

    // VERIFIED measured outcome → verified.
    const measurement = await createVerifiedMeasuredOutcome(harness);
    expect(
      (await record([{ kind: "measured_outcome", id: measurement.id }], "ac03-b-mo")).input.basis,
    ).toBe("verified");

    // Platform / attested / provider evidence → verified.
    for (const sourceType of ["platform", "attested", "provider"] as const) {
      const evidence = await createEvidence(harness, { sourceType });
      expect(
        (await record([{ kind: "evidence", id: evidence.id }], `ac03-b-e-${sourceType}`)).input
          .basis,
      ).toBe("verified");
    }

    // Model-assessed / self-reported evidence → indicated (non-authoritative).
    for (const sourceType of ["model", "self"] as const) {
      const evidence = await createEvidence(harness, { sourceType });
      expect(
        (await record([{ kind: "evidence", id: evidence.id }], `ac03-b-e-${sourceType}`)).input
          .basis,
      ).toBe("indicated");
    }

    // Mixed: one verified source among indicated sources → verified
    // (ANY verified-grade source establishes the verified basis).
    const modelEvidence = await createEvidence(harness, { sourceType: "model" });
    expect(
      (
        await record(
          [
            { kind: "evidence", id: modelEvidence.id },
            { kind: "contribution", id: verifiedContribution },
          ],
          "ac03-b-mixed",
        )
      ).input.basis,
    ).toBe("verified");
  });

  test("the reputation_input.recorded audit event carries the upstream source references (AUD-004 lineage)", async () => {
    await createDefaultPolicy(harness);
    const contributionId = await createVerifiedContribution(harness);
    const ctx = actorCtx(harness, "ac03-audit-input");
    const result = await harness.runtime.reputationInputService.recordInput(ctx, {
      organizationScopeId: harness.organizationScopeId,
      subjectPersonId: harness.personId,
      dimension: "helpfulness",
      sources: [{ kind: "contribution", id: contributionId }],
      occurredAt: REF_AT,
      idempotencyKey: "ac03-audit-input",
    });
    const events = await harness.runtime.auditWriter.query({
      eventType: "reputation_input.recorded",
      resourceId: result.input.id,
    });
    expect(events).toHaveLength(1);
    const metadata = events[0]!.metadata as Record<string, unknown>;
    expect(metadata.sources).toEqual([`contribution:${contributionId}`]);
    expect(metadata.basis).toBe("verified");
    expect(metadata.dimension).toBe("helpfulness");
    // Correlation/execution lineage is carried.
    expect(events[0]!.correlationId).toBe(ctx.correlationId);
  });

  test("the reputation_snapshot.recorded audit event carries inputIds + digest + policyVersion (reputation lineage)", async () => {
    const policy = await createDefaultPolicy(harness);
    const contributionId = await createVerifiedContribution(harness);
    const ctx = actorCtx(harness, "ac03-audit-snapshot");
    const input = await harness.runtime.reputationInputService.recordInput(ctx, {
      organizationScopeId: harness.organizationScopeId,
      subjectPersonId: harness.personId,
      dimension: "helpfulness",
      sources: [{ kind: "contribution", id: contributionId }],
      occurredAt: REF_AT,
      idempotencyKey: "ac03-audit-snapshot-input",
    });
    const snapshot = await harness.runtime.reputationSnapshotService.recordSnapshot(ctx, {
      organizationScopeId: harness.organizationScopeId,
      subjectPersonId: harness.personId,
      policyId: policy.policyId,
      version: 1,
      referenceAt: REF_AT,
      idempotencyKey: "ac03-audit-snapshot",
    });
    const events = await harness.runtime.auditWriter.query({
      eventType: "reputation_snapshot.recorded",
      resourceId: snapshot.snapshot.id,
    });
    expect(events).toHaveLength(1);
    const metadata = events[0]!.metadata as Record<string, unknown>;
    expect(metadata.inputIds).toEqual([input.input.id]);
    expect(metadata.digest).toBe(snapshot.snapshot.digest);
    expect(metadata.policyVersion).toBe(1);
    expect(metadata.referenceAt).toBe(REF_AT);
    // The AUTHORITATIVE transaction id (not the execution id) is in the
    // audit lineage — the same NET-W004-AC-07 contract.
    expect(metadata.transactionId).toBeTruthy();
    expect(metadata.transactionId).not.toBe(events[0]!.executionId);
  });

  test("a material score change between snapshots traces to the inputs added between them", async () => {
    const policy = await createDefaultPolicy(harness);
    const ctx = actorCtx(harness, "ac03-material");
    const recordInput = async (key: string) => {
      const contributionId = await createVerifiedContribution(harness);
      return harness.runtime.reputationInputService.recordInput(ctx, {
        organizationScopeId: harness.organizationScopeId,
        subjectPersonId: harness.personId,
        dimension: "helpfulness",
        sources: [{ kind: "contribution", id: contributionId }],
        occurredAt: REF_AT,
        idempotencyKey: key,
      });
    };
    await recordInput("ac03-material-1");
    const first = await harness.runtime.reputationSnapshotService.recordSnapshot(ctx, {
      organizationScopeId: harness.organizationScopeId,
      subjectPersonId: harness.personId,
      policyId: policy.policyId,
      version: 1,
      referenceAt: REF_AT,
      idempotencyKey: "ac03-material-s1",
    });
    const secondInput = await recordInput("ac03-material-2");
    const second = await harness.runtime.reputationSnapshotService.recordSnapshot(ctx, {
      organizationScopeId: harness.organizationScopeId,
      subjectPersonId: harness.personId,
      policyId: policy.policyId,
      version: 1,
      referenceAt: REF_AT,
      idempotencyKey: "ac03-material-s2",
    });

    // The score delta (material change) is fully explained by the
    // input ids that appear in the second snapshot but not the first —
    // and every one of those inputs references a verified contribution.
    const added = second.snapshot.inputIds.filter((id) => !first.snapshot.inputIds.includes(id));
    expect(added).toEqual([secondInput.input.id]);
    const helpfulness1 = first.snapshot.scores.find((s) => s.dimension === "helpfulness")!;
    const helpfulness2 = second.snapshot.scores.find((s) => s.dimension === "helpfulness")!;
    expect(helpfulness2.score - helpfulness1.score).toBe(1);
    const stored = await harness.runtime.reputationInputService.getInput(ctx, added[0]!);
    expect(stored.sources.length).toBeGreaterThan(0);
    expect(stored.sources[0]!.kind).toBe("contribution");
  });
});
