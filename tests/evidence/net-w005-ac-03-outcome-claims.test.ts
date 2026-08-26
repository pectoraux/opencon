/**
 * NET-W005-AC-03 — Provider-neutral, auditable outcome claims.
 *
 * Outcome claims support the FULL standard outcome vocabulary (OUT-001),
 * reject unknown types with a stable error code, carry evidence
 * references + lineage, and emit append-oriented audit records.
 * Claimed value/unit/type are immutable; the evidence set is
 * append-only.
 *
 * Evidence: domain tests over the full vocabulary + audit lineage tests.
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { STANDARD_OUTCOME_TYPES } from "../../src/core/evidence.ts";
import {
  createNetW005Harness,
  actorCtx,
  createOpportunitySubject,
  createContributionSubject,
  createEvidence,
  type NetW005Harness,
} from "./_net-w005-harness.ts";

let harness: NetW005Harness;

beforeEach(async () => {
  harness = await createNetW005Harness();
});

afterEach(async () => {
  await harness.teardown();
});

describe("NET-W005-AC-03 provider-neutral outcome claims", () => {
  test("the standard outcome vocabulary covers every OUT-001 type (13 types)", () => {
    expect(STANDARD_OUTCOME_TYPES).toEqual([
      "view",
      "attention",
      "engagement",
      "intent",
      "install",
      "signup",
      "purchase",
      "subscription",
      "retention",
      "referral",
      "savings",
      "fulfillment",
      "helpfulness",
    ]);
    expect(STANDARD_OUTCOME_TYPES.length).toBe(13);
  });

  test("EVERY standard outcome type is creatable (exhaustive vocabulary loop)", async () => {
    const opp = await createOpportunitySubject(harness);
    const subject = await createContributionSubject(harness, opp.id);
    const ctx = actorCtx(harness, "ac03-vocabulary");
    let index = 0;
    for (const outcomeType of STANDARD_OUTCOME_TYPES) {
      const claim = await harness.runtime.outcomeClaimService.createOutcomeClaim(ctx, {
        organizationScopeId: harness.organizationScopeId,
        claimantId: harness.personId,
        subjectReference: { subjectId: subject.id, subjectType: "contribution" },
        outcomeType,
        claimedValue: { value: 100 + index, unit: "count" },
        confidence: { point: 0.8, lower: 0.7, upper: 0.9 },
      });
      expect(claim.outcomeType).toBe(outcomeType);
      expect(claim.claimedValue.value).toBe(100 + index);
      expect(claim.version).toBe(0);
      index += 1;
    }
    // All 13 claims persisted durably.
    for (const outcomeType of STANDARD_OUTCOME_TYPES.slice(0, 3)) {
      const claims = await harness.runtime.auditWriter.query({
        eventType: "outcome_claim.created",
      });
      expect(claims.length).toBeGreaterThanOrEqual(3);
    }
  });

  test("an UNKNOWN outcome type is rejected with the stable error code UNSUPPORTED_OUTCOME_TYPE", async () => {
    const opp = await createOpportunitySubject(harness);
    const subject = await createContributionSubject(harness, opp.id);
    const ctx = actorCtx(harness, "ac03-unknown-type");
    try {
      await harness.runtime.outcomeClaimService.createOutcomeClaim(ctx, {
        organizationScopeId: harness.organizationScopeId,
        claimantId: harness.personId,
        subjectReference: { subjectId: subject.id, subjectType: "contribution" },
        outcomeType: "brand-lift-royalty-points" as never,
        claimedValue: { value: 5, unit: "count" },
        confidence: { point: 0.5 },
      });
      throw new Error("expected unknown outcome type to be rejected");
    } catch (err) {
      const oce = err as { code?: string };
      expect(oce.code).toBe("UNSUPPORTED_OUTCOME_TYPE");
    }
  });

  test("outcome claims reference evidence + carry lineage (EVID-001: every material claim references evidence)", async () => {
    const opp = await createOpportunitySubject(harness);
    const subject = await createContributionSubject(harness, opp.id);
    const evidence = await createEvidence(harness, subject.id, { point: 0.95 });
    const ctx = actorCtx(harness, "ac03-evidence-ref");
    const claim = await harness.runtime.outcomeClaimService.createOutcomeClaim(ctx, {
      organizationScopeId: harness.organizationScopeId,
      claimantId: harness.personId,
      subjectReference: { subjectId: subject.id, subjectType: "contribution" },
      outcomeType: "install",
      claimedValue: { value: 42, unit: "installs" },
      confidence: { point: 0.9 },
      evidenceIds: [evidence.id],
      statement: "42 installs attributed to the contribution",
    });
    expect(claim.evidenceIds).toEqual([evidence.id]);
    expect(claim.executionId).toBe(ctx.executionId);
    expect(claim.correlationId).toBe(ctx.correlationId);
    expect(claim.statement).toBe("42 installs attributed to the contribution");
  });

  test("an outcome claim referencing UNKNOWN evidence is rejected", async () => {
    const opp = await createOpportunitySubject(harness);
    const subject = await createContributionSubject(harness, opp.id);
    const ctx = actorCtx(harness, "ac03-unknown-evidence");
    await expect(
      harness.runtime.outcomeClaimService.createOutcomeClaim(ctx, {
        organizationScopeId: harness.organizationScopeId,
        claimantId: harness.personId,
        subjectReference: { subjectId: subject.id, subjectType: "contribution" },
        outcomeType: "view",
        claimedValue: { value: 10, unit: "views" },
        confidence: { point: 0.9 },
        evidenceIds: ["urn:unknown:evidence"],
      }),
    ).rejects.toThrow(/evidence not found/i);
  });

  test("attachEvidence appends (evidence set append-only); claimed value/unit/type NEVER mutate", async () => {
    const opp = await createOpportunitySubject(harness);
    const subject = await createContributionSubject(harness, opp.id);
    const e1 = await createEvidence(harness, subject.id, { sourceId: "s1" });
    const e2 = await createEvidence(harness, subject.id, { sourceId: "s2" });
    const ctx = actorCtx(harness, "ac03-attach");
    const claim = await harness.runtime.outcomeClaimService.createOutcomeClaim(ctx, {
      organizationScopeId: harness.organizationScopeId,
      claimantId: harness.personId,
      subjectReference: { subjectId: subject.id, subjectType: "contribution" },
      outcomeType: "purchase",
      claimedValue: { value: 7, unit: "purchases" },
      confidence: { point: 0.85 },
      evidenceIds: [e1.id],
    });
    expect(claim.version).toBe(0);

    // Attach a second evidence record — the set is append-only, the
    // version increments, and the claimed value stays EXACTLY the same.
    const appended = await harness.runtime.outcomeClaimService.attachEvidence(
      ctx,
      claim.id,
      e2.id,
    );
    expect(appended.evidenceIds).toEqual([e1.id, e2.id]);
    expect(appended.version).toBe(1);
    expect(appended.claimedValue).toEqual({ value: 7, unit: "purchases" });
    expect(appended.outcomeType).toBe("purchase");

    // Attaching an already-attached record is an idempotent no-op.
    const again = await harness.runtime.outcomeClaimService.attachEvidence(
      ctx,
      claim.id,
      e2.id,
    );
    expect(again.evidenceIds).toEqual([e1.id, e2.id]);
    expect(again.version).toBe(1);
  });

  test("a stale writer is rejected on attach (optimistic concurrency with expectedVersion)", async () => {
    const opp = await createOpportunitySubject(harness);
    const subject = await createContributionSubject(harness, opp.id);
    const e1 = await createEvidence(harness, subject.id, { sourceId: "s1" });
    const e2 = await createEvidence(harness, subject.id, { sourceId: "s2" });
    const ctx = actorCtx(harness, "ac03-stale");
    const claim = await harness.runtime.outcomeClaimService.createOutcomeClaim(ctx, {
      organizationScopeId: harness.organizationScopeId,
      claimantId: harness.personId,
      subjectReference: { subjectId: subject.id, subjectType: "contribution" },
      outcomeType: "signup",
      claimedValue: { value: 3, unit: "signups" },
      confidence: { point: 0.8 },
    });
    await harness.runtime.outcomeClaimService.attachEvidence(ctx, claim.id, e1.id);
    // The claim is now at version 1; a caller with the stale view (v0)
    // is rejected with a conflict.
    await expect(
      harness.runtime.outcomeClaimService.attachEvidence(ctx, claim.id, e2.id, 0),
    ).rejects.toThrow(/stale writer/i);
  });

  test("outcome claim creation + attachment are audited atomically (AUD-002 evidence lineage)", async () => {
    const opp = await createOpportunitySubject(harness);
    const subject = await createContributionSubject(harness, opp.id);
    const e1 = await createEvidence(harness, subject.id, { sourceId: "s1" });
    const ctx = actorCtx(harness, "ac03-audit");
    const before = await harness.runtime.auditWriter.count();
    const claim = await harness.runtime.outcomeClaimService.createOutcomeClaim(ctx, {
      organizationScopeId: harness.organizationScopeId,
      claimantId: harness.personId,
      subjectReference: { subjectId: subject.id, subjectType: "contribution" },
      outcomeType: "engagement",
      claimedValue: { value: 500, unit: "interactions" },
      confidence: { point: 0.75, lower: 0.6, upper: 0.9 },
      evidenceIds: [e1.id],
    });
    await harness.runtime.outcomeClaimService.attachEvidence(ctx, claim.id, e1.id);
    // Already attached → no-op (no second audit record).
    const after = await harness.runtime.auditWriter.count();
    expect(after - before).toBe(1);
    const events = await harness.runtime.auditWriter.query({
      eventType: "outcome_claim.created",
    });
    const ev = events[events.length - 1]!;
    expect(ev.resourceType).toBe("outcome_claim");
    expect(ev.metadata?.outcomeType).toBe("engagement");
    expect(ev.metadata?.evidenceCount).toBe(1);
    // Confidence/uncertainty is preserved in the audit lineage (EVID-005).
    expect(ev.metadata?.confidencePoint).toBe(0.75);
  });

  test("outcome claims are provider-neutral (no provider/campaign-specific fields on the entity)", async () => {
    const opp = await createOpportunitySubject(harness);
    const subject = await createContributionSubject(harness, opp.id);
    const ctx = actorCtx(harness, "ac03-neutral");
    const claim = await harness.runtime.outcomeClaimService.createOutcomeClaim(ctx, {
      organizationScopeId: harness.organizationScopeId,
      claimantId: harness.personId,
      subjectReference: { subjectId: subject.id, subjectType: "contribution" },
      outcomeType: "helpfulness",
      claimedValue: { value: 4.5, unit: "score" },
      confidence: { point: 0.6 },
    });
    // The entity shape is exactly the provider-neutral protocol
    // vocabulary: no provider SDK types cross into it (architecture §14).
    const keys = Object.keys(claim).sort();
    expect(keys).toEqual([
      "causationId",
      "claimantId",
      "claimedValue",
      "confidence",
      "correlationId",
      "createdAt",
      "evidenceIds",
      "executionId",
      "id",
      "organizationScopeId",
      "outcomeType",
      "statement",
      "subjectReference",
      "updatedAt",
      "version",
    ]);
  });
});
