/**
 * NET-W006-AC-01 — First-class outcome observations.
 *
 * Outcome observations are first-class, durable, immutable/
 * append-corrected records with provenance and lineage:
 *  - create/get/list through authorized operations; stable ids;
 *  - tenant scoping (cross-scope links rejected);
 *  - optional validated links to NET-W005 Outcome Claims + Evidence;
 *  - REQUIRED method/version provenance (identity never collapsed);
 *  - corrections append as NEW records targeting the chain head;
 *    branching correction chains are rejected; the original record is
 *    never rewritten;
 *  - chain resolution exposes the full correction lineage;
 *  - atomic audit lineage (outcome_observation.created/.corrected).
 *
 * Evidence: domain + persistence integration tests, including
 * correction-chain tests and raw-record immutability.
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import {
  createNetW006Harness,
  actorCtx,
  createMeasuredSubject,
  createObservation,
  type NetW006Harness,
} from "./_net-w006-harness.ts";

let harness: NetW006Harness;

beforeEach(async () => {
  harness = await createNetW006Harness();
});

afterEach(async () => {
  await harness.teardown();
});

describe("NET-W006-AC-01 first-class outcome observations", () => {
  test("an observation can be created, retrieved, and listed by subject with stable identity + lineage", async () => {
    const subject = await createMeasuredSubject(harness);
    const observation = await createObservation(harness, subject.id, {
      value: 42,
      unit: "installs",
      sourceType: "platform",
    });
    expect(observation.id).toBeTruthy();
    expect(observation.organizationScopeId).toBe(harness.organizationScopeId);
    expect(observation.outcomeType).toBe("install");
    expect(observation.observedValue).toEqual({ value: 42, unit: "installs" });
    expect(observation.provenance.method).toBe("platform-counter");
    expect(observation.provenance.methodVersion).toBe("1.0.0");
    expect(observation.correctsObservationId).toBeNull();
    // Execution lineage is carried on the durable record.
    expect(observation.executionId).toBeTruthy();
    expect(observation.correlationId).toBe("w006-observation");

    const ctx = actorCtx(harness, "ac01-read");
    const fetched = await harness.runtime.outcomeObservationService.getOutcomeObservation(
      ctx,
      observation.id,
    );
    expect(fetched).toEqual(observation);

    const listed = await harness.runtime.outcomeObservationService.listObservationsBySubject(
      ctx,
      subject.id,
    );
    expect(listed.map((o) => o.id)).toContain(observation.id);
  });

  test("the outcome type must come from the OUT-001 vocabulary (stable error code)", async () => {
    const subject = await createMeasuredSubject(harness);
    try {
      await createObservation(harness, subject.id, { outcomeType: "vibes" });
      throw new Error("expected unsupported outcome type to be rejected");
    } catch (err) {
      const oce = err as { code?: string };
      expect(oce.code).toBe("UNSUPPORTED_OUTCOME_TYPE");
    }
  });

  test("methodVersion is REQUIRED — model/method identity is never collapsed", async () => {
    const subject = await createMeasuredSubject(harness);
    const ctx = actorCtx(harness, "ac01-no-version");
    try {
      await harness.runtime.outcomeObservationService.createOutcomeObservation(ctx, {
        organizationScopeId: harness.organizationScopeId,
        observerId: harness.personId,
        subjectReference: { subjectId: subject.id, subjectType: "contribution" },
        outcomeType: "install",
        observedValue: { value: 1, unit: "installs" },
        confidence: { point: 0.9 },
        provenance: {
          sourceType: "platform",
          method: "platform-counter",
          methodVersion: "",
        },
      });
      throw new Error("expected missing methodVersion to be rejected");
    } catch (err) {
      const oce = err as { code?: string };
      expect(oce.code).toBe("INVALID_MEASUREMENT_PROVENANCE");
    }
  });

  test("optional OutcomeClaim and Evidence links are validated (existence + organization scope)", async () => {
    const subject = await createMeasuredSubject(harness);
    // A missing claim link is rejected.
    try {
      await createObservation(harness, subject.id, {
        outcomeClaimId: "urn:missing-claim",
      });
      throw new Error("expected missing outcome claim to be rejected");
    } catch (err) {
      const oce = err as { code?: string; classification?: string };
      expect(oce.classification).toBe("not_found");
    }
    // A missing evidence link is rejected.
    try {
      await createObservation(harness, subject.id, {
        evidenceId: "urn:missing-evidence",
      });
      throw new Error("expected missing evidence to be rejected");
    } catch (err) {
      const oce = err as { classification?: string };
      expect(oce.classification).toBe("not_found");
    }

    // A REAL claim in the same org scope links cleanly.
    const claimCtx = actorCtx(harness, "ac01-claim");
    const claim = await harness.runtime.outcomeClaimService.createOutcomeClaim(claimCtx, {
      organizationScopeId: harness.organizationScopeId,
      claimantId: harness.personId,
      subjectReference: { subjectId: subject.id, subjectType: "contribution" },
      outcomeType: "install",
      claimedValue: { value: 40, unit: "installs" },
      confidence: { point: 0.9 },
    });
    const linked = await createObservation(harness, subject.id, {
      outcomeClaimId: claim.id,
    });
    expect(linked.outcomeClaimId).toBe(claim.id);

    // A claim from ANOTHER organization scope is rejected (tenant
    // scoping) — a SECOND org in the SAME authoritative store, so the
    // claim EXISTS but its scope differs.
    const secondOrg = await harness.runtime.organizationService.createOrganization(
      harness.bootstrapCtx,
      { name: "Other Org", creatorId: harness.personId },
    );
    const otherClaim = await harness.runtime.outcomeClaimService.createOutcomeClaim(
      actorCtx(harness, "ac01-other-claim"),
      {
        organizationScopeId: secondOrg.id,
        claimantId: harness.personId,
        subjectReference: { subjectId: subject.id, subjectType: "contribution" },
        outcomeType: "install",
        claimedValue: { value: 5, unit: "installs" },
        confidence: { point: 0.9 },
      },
    );
    try {
      await createObservation(harness, subject.id, { outcomeClaimId: otherClaim.id });
      throw new Error("expected cross-scope claim link to be rejected");
    } catch (err) {
      const oce = err as { code?: string };
      expect(oce.code).toBe("MEASUREMENT_VALIDATION");
    }
  });

  test("observations are immutable — a correction appends a NEW record and never rewrites the original", async () => {
    const subject = await createMeasuredSubject(harness);
    const original = await createObservation(harness, subject.id, { value: 10 });
    const ctx = actorCtx(harness, "ac01-correct");

    const correction = await harness.runtime.outcomeObservationService.correctOutcomeObservation(
      ctx,
      {
        organizationScopeId: harness.organizationScopeId,
        observerId: harness.personId,
        observedValue: { value: 15, unit: "installs" },
        confidence: { point: 0.97 },
        provenance: {
          sourceType: "platform",
          method: "platform-counter",
          methodVersion: "1.1.0",
        },
        correctsObservationId: original.id,
      },
    );
    expect(correction.id).not.toBe(original.id);
    expect(correction.correctsObservationId).toBe(original.id);
    expect(correction.observedValue.value).toBe(15);

    // The ORIGINAL record is unchanged (immutable): same id, same
    // value, no rewrite, no supersede marker mutation.
    const storedOriginal = await harness.runtime.outcomeObservationService.getOutcomeObservation(
      ctx,
      original.id,
    );
    expect(storedOriginal.observedValue.value).toBe(10);
    expect(storedOriginal.correctsObservationId).toBeNull();
    expect(storedOriginal).toEqual(original);

    // Chain resolution: root → head with the correction lineage.
    const chain = await harness.runtime.outcomeObservationService.resolveObservationChain(
      ctx,
      original.id,
    );
    expect(chain.root.id).toBe(original.id);
    expect(chain.corrections.map((c) => c.id)).toEqual([correction.id]);
    expect(chain.head.id).toBe(correction.id);
    expect(chain.head.observedValue.value).toBe(15);
    // Resolving from the CORRECTION reaches the same chain.
    const fromHead = await harness.runtime.outcomeObservationService.resolveObservationChain(
      ctx,
      correction.id,
    );
    expect(fromHead.root.id).toBe(original.id);
    expect(fromHead.head.id).toBe(correction.id);
  });

  test("branching correction chains are REJECTED — corrections must target the chain head", async () => {
    const subject = await createMeasuredSubject(harness);
    const original = await createObservation(harness, subject.id, { value: 10 });
    const ctx = actorCtx(harness, "ac01-branch");
    const first = await harness.runtime.outcomeObservationService.correctOutcomeObservation(ctx, {
      organizationScopeId: harness.organizationScopeId,
      observerId: harness.personId,
      observedValue: { value: 15, unit: "installs" },
      confidence: { point: 0.95 },
      provenance: {
        sourceType: "platform",
        method: "platform-counter",
        methodVersion: "1.1.0",
      },
      correctsObservationId: original.id,
    });
    // Correcting the ORIGINAL (now mid-chain) is a branching attempt.
    try {
      await harness.runtime.outcomeObservationService.correctOutcomeObservation(ctx, {
        organizationScopeId: harness.organizationScopeId,
        observerId: harness.personId,
        observedValue: { value: 20, unit: "installs" },
        confidence: { point: 0.95 },
        provenance: {
          sourceType: "platform",
          method: "platform-counter",
          methodVersion: "1.2.0",
        },
        correctsObservationId: original.id,
      });
      throw new Error("expected branching correction to be rejected");
    } catch (err) {
      const oce = err as { code?: string };
      expect(oce.code).toBe("MEASUREMENT_VALIDATION");
      expect((oce as { context?: Record<string, unknown> }).context).toMatchObject({
        observationId: original.id,
      });
    }
    // Correcting the HEAD chains linearly (2-deep chain).
    const second = await harness.runtime.outcomeObservationService.correctOutcomeObservation(ctx, {
      organizationScopeId: harness.organizationScopeId,
      observerId: harness.personId,
      observedValue: { value: 22, unit: "installs" },
      confidence: { point: 0.95 },
      provenance: {
        sourceType: "platform",
        method: "platform-counter",
        methodVersion: "1.2.0",
      },
      correctsObservationId: first.id,
    });
    const chain = await harness.runtime.outcomeObservationService.resolveObservationChain(
      ctx,
      original.id,
    );
    expect(chain.corrections.map((c) => c.id)).toEqual([first.id, second.id]);
    expect(chain.head.id).toBe(second.id);
  });

  test("a correction inherits the target's subject + outcome type (a different subject/type is a different observation)", async () => {
    const subject = await createMeasuredSubject(harness);
    const original = await createObservation(harness, subject.id, {
      outcomeType: "install",
      value: 10,
    });
    const ctx = actorCtx(harness, "ac01-inherit");
    const correction = await harness.runtime.outcomeObservationService.correctOutcomeObservation(
      ctx,
      {
        organizationScopeId: harness.organizationScopeId,
        observerId: harness.personId,
        observedValue: { value: 11, unit: "installs" },
        confidence: { point: 0.95 },
        provenance: {
          sourceType: "platform",
          method: "platform-counter",
          methodVersion: "1.1.0",
        },
        correctsObservationId: original.id,
      },
    );
    // Inherited from the target — the correction input carries NO
    // subject/type fields at all.
    expect(correction.subjectReference).toEqual(original.subjectReference);
    expect(correction.outcomeType).toBe("install");
  });

  test("create + correct emit atomic audit lineage (committed with the mutation)", async () => {
    const subject = await createMeasuredSubject(harness);
    const before = await harness.runtime.auditWriter.count();
    const observation = await createObservation(harness, subject.id, { value: 7 });
    const afterCreate = await harness.runtime.auditWriter.count();
    expect(afterCreate - before).toBe(1);
    const created = await harness.runtime.auditWriter.query({
      eventType: "outcome_observation.created",
      resourceId: observation.id,
    });
    expect(created.length).toBe(1);
    expect(created[0]!.metadata).toMatchObject({
      outcomeType: "install",
      observedValue: 7,
      sourceType: "platform",
    });

    const ctx = actorCtx(harness, "ac01-audit");
    const correction = await harness.runtime.outcomeObservationService.correctOutcomeObservation(
      ctx,
      {
        organizationScopeId: harness.organizationScopeId,
        observerId: harness.personId,
        observedValue: { value: 9, unit: "installs" },
        confidence: { point: 0.95 },
        provenance: {
          sourceType: "platform",
          method: "platform-counter",
          methodVersion: "1.1.0",
        },
        correctsObservationId: observation.id,
      },
    );
    const corrected = await harness.runtime.auditWriter.query({
      eventType: "outcome_observation.corrected",
      resourceId: correction.id,
    });
    expect(corrected.length).toBe(1);
    expect(corrected[0]!.metadata).toMatchObject({
      correctsObservationId: observation.id,
      supersededValue: 7,
    });
  });

  test("observations persist durably through the PostgreSQL authority (authoritative store)", async () => {
    const subject = await createMeasuredSubject(harness);
    const observation = await createObservation(harness, subject.id, { value: 33 });
    // The authoritative record collection carries the observation.
    const rec = await harness.runtime.postgresAuthority.get<{ id: string }>(
      "outcome_observations",
      observation.id,
    );
    expect(rec).not.toBeNull();
    expect(rec!.value.id).toBe(observation.id);
    expect(rec!.executionId).toBe(observation.executionId);
  });
});
