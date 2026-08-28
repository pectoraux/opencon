/**
 * NET-W018-AC-01 — sponsorship/commercial relationships are
 * first-class durable records linked to creator/campaign/engagement
 * lineage (issue #35 AC-01; DISC-001; invariant 1).
 */

import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import {
  createNetW018Harness,
  createVerifiedEngagement,
  createCommercialRelationship,
  createPublication,
  key,
  operatorCtx,
  personCtx,
  type NetW018Harness,
} from "./_net-w018-harness.ts";
import { NotFoundError } from "../../src/core/errors.ts";
import { CommercialRelationshipConflictError } from "../../src/core/creators.ts";

let harness: NetW018Harness;

beforeAll(async () => {
  harness = await createNetW018Harness();
});

afterAll(async () => {
  await harness.teardown();
});

describe("NET-W018-AC-01 commercial relationships", () => {
  test("a relationship is a first-class durable record with full creator/campaign/engagement lineage", async () => {
    const relationship = await createCommercialRelationship(harness);
    expect(relationship.id).toBeTruthy();
    expect(relationship.organizationScopeId).toBe(harness.organizationScopeId);
    // Lineage: creator + campaign + engagement (invariant 1).
    expect(relationship.engagementId).toBeTruthy();
    expect(relationship.campaignId).toBeTruthy();
    expect(relationship.creatorPersonId).toBe(harness.creatorPersonId);
    expect(relationship.sponsorPersonId).toBe(harness.operatorPersonId);
    expect(relationship.kind).toBe("sponsorship");
    // The declared obligations + reference-only compensation.
    expect(relationship.disclosureObligations).toEqual([
      "genuine_experience",
    ]);
    expect(relationship.compensation).toMatchObject({
      format: "short_video",
      unit: "per_deliverable",
      amount: 750,
      currency: "USD",
      rewardPolicyReference: null,
    });
    expect(relationship.terminatedAt).toBeNull();
    expect(relationship.formatVersion).toBe("NET-W018:1");
    expect(relationship.executionId).toBeTruthy();
    expect(relationship.correlationId).toBeTruthy();

    // The record is DURABLE: the tenant-scoped read resolves it.
    const fetched = await harness.runtime.creatorSponsorshipService.getCommercialRelationship(
      operatorCtx(harness, "w018-ac01-read"),
      harness.organizationScopeId,
      relationship.id,
    );
    expect(fetched.id).toBe(relationship.id);
  });

  test("the recorded lineage is COHERENT: the relationship mirrors the engagement's campaign and creator", async () => {
    const verified = await createVerifiedEngagement(harness);
    const ctx = operatorCtx(harness, "w018-ac01-lineage");
    const result =
      await harness.runtime.creatorSponsorshipService.createCommercialRelationship(
        ctx,
        {
          organizationScopeId: harness.organizationScopeId,
          engagementId: verified.engagementId,
          campaignId: verified.campaignId,
          sponsorPersonId: harness.operatorPersonId,
          kind: "paid_placement",
          disclosureObligations: ["material_connection"],
          compensation: null,
          idempotencyKey: key("w018-ac01-rel"),
        },
      );
    expect(result.created).toBe(true);
    // The record's campaign + creator mirror the ENGAGEMENT (not the
    // caller's free-form claim).
    expect(result.relationship.campaignId).toBe(verified.campaignId);
    expect(result.relationship.creatorPersonId).toBe(harness.creatorPersonId);

    // A mismatched campaignId is REJECTED (lineage coherence).
    const other = await createVerifiedEngagement(harness);
    await expect(
      harness.runtime.creatorSponsorshipService.createCommercialRelationship(
        ctx,
        {
          organizationScopeId: harness.organizationScopeId,
          engagementId: other.engagementId,
          campaignId: verified.campaignId,
          sponsorPersonId: harness.operatorPersonId,
          kind: "sponsorship",
          disclosureObligations: [],
          compensation: null,
          idempotencyKey: key("w018-ac01-mismatch"),
        },
      ),
    ).rejects.toMatchObject({ code: "SPONSORSHIP_VALIDATION" });

    // The sponsor cannot BE the creator (a commercial relationship
    // needs a counterparty).
    await expect(
      harness.runtime.creatorSponsorshipService.createCommercialRelationship(
        ctx,
        {
          organizationScopeId: harness.organizationScopeId,
          engagementId: verified.engagementId,
          campaignId: verified.campaignId,
          sponsorPersonId: harness.creatorPersonId,
          kind: "sponsorship",
          disclosureObligations: [],
          compensation: null,
          idempotencyKey: key("w018-ac01-selfsponsor"),
        },
      ),
    ).rejects.toMatchObject({ code: "SPONSORSHIP_VALIDATION" });
  });

  test("ONE relationship per engagement (create-once; a second is a stable conflict)", async () => {
    const verified = await createVerifiedEngagement(harness);
    const first = await createCommercialRelationship(harness, {
      engagementId: verified.engagementId,
      campaignId: verified.campaignId,
    });
    expect(first.id).toBeTruthy();
    await expect(
      createCommercialRelationship(harness, {
        engagementId: verified.engagementId,
        campaignId: verified.campaignId,
        idempotencyKey: key("w018-ac01-dup"),
      }),
    ).rejects.toBeInstanceOf(CommercialRelationshipConflictError);
  });

  test("idempotent replay: the same key returns the committed record with created=false", async () => {
    const verified = await createVerifiedEngagement(harness);
    const idempotencyKey = key("w018-ac01-replay");
    const first = await createCommercialRelationship(harness, {
      engagementId: verified.engagementId,
      campaignId: verified.campaignId,
      idempotencyKey,
    });
    const replay = await createCommercialRelationship(harness, {
      engagementId: verified.engagementId,
      campaignId: verified.campaignId,
      idempotencyKey,
    });
    expect(replay.id).toBe(first.id);
    const ctx = operatorCtx(harness, "w018-ac01-replay");
    const result =
      await harness.runtime.creatorSponsorshipService.createCommercialRelationship(
        ctx,
        {
          organizationScopeId: harness.organizationScopeId,
          engagementId: verified.engagementId,
          campaignId: verified.campaignId,
          sponsorPersonId: harness.operatorPersonId,
          kind: "gifted_product",
          disclosureObligations: ["gifted_product"],
          compensation: null,
          idempotencyKey,
        },
      );
    expect(result.created).toBe(false);
    expect(result.relationship.id).toBe(first.id);
    // The replay did NOT overwrite the committed kind (immutable
    // record; the idempotent apply returns the committed result).
    expect(result.relationship.kind).toBe("sponsorship");
  });

  test("termination is one-way, keeps the disclosure obligations, and is audited", async () => {
    const relationship = await createCommercialRelationship(harness, {
      disclosureObligations: ["material_connection", "genuine_experience"],
    });
    const ctx = operatorCtx(harness, "w018-ac01-terminate");
    const terminated =
      await harness.runtime.creatorSponsorshipService.terminateCommercialRelationship(
        ctx,
        {
          organizationScopeId: harness.organizationScopeId,
          relationshipId: relationship.id,
          reason: "arrangement concluded",
          idempotencyKey: key("w018-ac01-terminate"),
        },
      );
    expect(terminated.terminatedAt).toBeTruthy();
    expect(terminated.terminationReason).toBe("arrangement concluded");
    // The CONSERVATIVE direction: obligations SURVIVE termination
    // (content produced under the relationship stays disclosed).
    expect(terminated.disclosureObligations).toEqual([
      "material_connection",
      "genuine_experience",
    ]);

    // The termination is DURABLE + audited.
    const events = await harness.runtime.auditWriter.query({
      eventType: "commercial_relationship.terminated",
      resourceId: relationship.id,
    });
    expect(events).toHaveLength(1);
    expect(events[0]!.metadata.terminationReason).toBe(
      "arrangement concluded",
    );

    // One-way: re-terminating (same or fresh key) does not move it.
    const again =
      await harness.runtime.creatorSponsorshipService.terminateCommercialRelationship(
        ctx,
        {
          organizationScopeId: harness.organizationScopeId,
          relationshipId: relationship.id,
          reason: "second attempt",
          idempotencyKey: key("w018-ac01-terminate-2"),
        },
      );
    expect(again.terminatedAt).toBe(terminated.terminatedAt);
    expect(again.terminationReason).toBe("arrangement concluded");
  });

  test("tenant isolation: a cross-scope relationship id is indistinguishable from a nonexistent one", async () => {
    const relationship = await createCommercialRelationship(harness);
    await expect(
      harness.runtime.creatorSponsorshipService.getCommercialRelationship(
        personCtx(harness, harness.secondOrgPersonId, "w018-ac01-cross"),
        harness.secondOrgId,
        relationship.id,
      ),
    ).rejects.toBeInstanceOf(NotFoundError);
    // And a relationship cannot be created against another org's
    // engagement (the engagement read is tenant-scoped — the
    // cross-scope engagement is indistinguishable from a nonexistent
    // one).
    await expect(
      harness.runtime.creatorSponsorshipService.createCommercialRelationship(
        personCtx(harness, harness.secondOrgPersonId, "w018-ac01-cross2"),
        {
          organizationScopeId: harness.secondOrgId,
          engagementId: relationship.engagementId,
          campaignId: relationship.campaignId,
          sponsorPersonId: harness.secondOrgPersonId,
          kind: "sponsorship",
          disclosureObligations: [],
          compensation: null,
          idempotencyKey: key("w018-ac01-cross"),
        },
      ),
    ).rejects.toBeInstanceOf(NotFoundError);
  });

  test("the relationship flows END-TO-END into the publication lineage (chain: campaign → relationship → engagement → publication)", async () => {
    const verified = await createVerifiedEngagement(harness);
    const relationship = await createCommercialRelationship(harness, {
      engagementId: verified.engagementId,
      campaignId: verified.campaignId,
    });
    const publication = await createPublication(harness, {
      engagementId: verified.engagementId,
      productionId: verified.productionId,
    });
    expect(publication.engagementId).toBe(relationship.engagementId);
    expect(publication.campaignId).toBe(relationship.campaignId);
    expect(publication.creatorPersonId).toBe(relationship.creatorPersonId);
    // The list views filter by the lineage.
    const relationships =
      await harness.runtime.creatorSponsorshipService.listCommercialRelationships(
        operatorCtx(harness, "w018-ac01-list"),
        harness.organizationScopeId,
        { engagementId: verified.engagementId },
      );
    expect(relationships).toHaveLength(1);
    expect(relationships[0]!.id).toBe(relationship.id);
  });
});
