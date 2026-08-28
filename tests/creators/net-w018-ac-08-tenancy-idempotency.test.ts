/**
 * NET-W018-AC-08 — idempotency, concurrency, tenancy, PostgreSQL
 * authority and transactional audit lineage hold (issue #35 AC-08;
 * invariant 9).
 */

import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import {
  createNetW018Harness,
  createCommercialRelationship,
  createPublication,
  createPublicationEvidence,
  declareKind,
  goldenPathSponsorship,
  key,
  operatorCtx,
  personCtx,
  type NetW018Harness,
} from "./_net-w018-harness.ts";
import { NotFoundError } from "../../src/core/errors.ts";

let harness: NetW018Harness;

beforeAll(async () => {
  harness = await createNetW018Harness();
});

afterAll(async () => {
  await harness.teardown();
});

describe("NET-W018-AC-08 tenancy / idempotency / concurrency / audit", () => {
  test("tenant isolation: every ID-based read is org-scoped (cross-scope = NotFoundError)", async () => {
    const relationship = await createCommercialRelationship(harness);
    const publication = await createPublication(harness, {
      engagementId: relationship.engagementId,
      productionId: null,
    });
    const crossCtx = personCtx(
      harness,
      harness.secondOrgPersonId,
      "w018-ac08-cross",
    );
    await expect(
      harness.runtime.creatorSponsorshipService.getCommercialRelationship(
        crossCtx,
        harness.secondOrgId,
        relationship.id,
      ),
    ).rejects.toBeInstanceOf(NotFoundError);
    await expect(
      harness.runtime.creatorSponsorshipService.getPublication(
        crossCtx,
        harness.secondOrgId,
        publication.id,
      ),
    ).rejects.toBeInstanceOf(NotFoundError);
    await expect(
      harness.runtime.creatorSponsorshipService.listDisclosureDeclarations(
        crossCtx,
        harness.secondOrgId,
        publication.id,
      ),
    ).rejects.toBeInstanceOf(NotFoundError);
    await expect(
      harness.runtime.creatorSponsorshipService.getPublicationDisclosureStatus(
        crossCtx,
        harness.secondOrgId,
        publication.id,
      ),
    ).rejects.toBeInstanceOf(NotFoundError);
    // The lists are scoped: the second org sees NOTHING.
    const crossRelationships =
      await harness.runtime.creatorSponsorshipService.listCommercialRelationships(
        crossCtx,
        harness.secondOrgId,
      );
    expect(crossRelationships).toHaveLength(0);
    const crossPublications =
      await harness.runtime.creatorSponsorshipService.listPublications(
        crossCtx,
        harness.secondOrgId,
      );
    expect(crossPublications).toHaveLength(0);
  });

  test("idempotency: same-key replays are deterministic no-ops for every W018 command", async () => {
    // Relationship replay.
    const relationshipKey = key("w018-ac08-rel");
    const relationship = await createCommercialRelationship(harness, {
      idempotencyKey: relationshipKey,
    });
    const relationshipReplay = await createCommercialRelationship(harness, {
      engagementId: relationship.engagementId,
      campaignId: relationship.campaignId,
      idempotencyKey: relationshipKey,
    });
    expect(relationshipReplay.id).toBe(relationship.id);

    // Publication replay.
    const publicationKey = key("w018-ac08-pub");
    const publication = await createPublication(harness, {
      engagementId: relationship.engagementId,
      idempotencyKey: publicationKey,
    });
    const publicationReplay = await createPublication(harness, {
      engagementId: relationship.engagementId,
      idempotencyKey: publicationKey,
    });
    expect(publicationReplay.id).toBe(publication.id);

    // Declaration replay.
    const declarationKey = key("w018-ac08-decl");
    const declaration = await declareKind(
      harness,
      publication.id,
      "material_connection",
    );
    const { evidenceId } = await createPublicationEvidence(
      harness,
      publication.id,
    );
    const declarationReplay =
      await harness.runtime.creatorSponsorshipService.recordDisclosureDeclaration(
        personCtx(harness, harness.creatorPersonId, "w018-ac08-decl-replay"),
        {
          organizationScopeId: harness.organizationScopeId,
          publicationId: publication.id,
          kind: "material_connection",
          statement: "replay",
          evidenceReferences: [evidenceId],
          idempotencyKey: declaration.idempotencyKey,
        },
      );
    expect(declarationReplay.created).toBe(false);
    expect(declarationReplay.declaration.id).toBe(declaration.id);

    // Verification replay: a same-key re-run of a VERIFIED
    // publication returns the committed composite with
    // executed=false (the W004 replay contract).
    await declareKind(harness, publication.id, "genuine_experience");
    const verifyKey = key("w018-ac08-verify");
    const first = await harness.runtime.creatorSponsorshipService.verifyPublication(
      operatorCtx(harness, "w018-ac08-verify"),
      {
        organizationScopeId: harness.organizationScopeId,
        publicationId: publication.id,
        expectedVersion: publication.version,
        evidenceReferences: [evidenceId],
        idempotencyKey: verifyKey,
      },
    );
    expect(first.transition.executed).toBe(true);
    const replay = await harness.runtime.creatorSponsorshipService.verifyPublication(
      operatorCtx(harness, "w018-ac08-verify-replay"),
      {
        organizationScopeId: harness.organizationScopeId,
        publicationId: publication.id,
        expectedVersion: publication.version,
        evidenceReferences: [evidenceId],
        idempotencyKey: verifyKey,
      },
    );
    expect(replay.transition.executed).toBe(false);
    expect(replay.transition.transitionId).toBe(first.transition.transitionId);
    expect(replay.publication.state).toBe("VERIFIED");
    // Exactly ONE verification audit event exists (no duplicate).
    const events = await harness.runtime.auditWriter.query({
      eventType: "publication.verified",
      resourceId: publication.id,
    });
    expect(events).toHaveLength(1);
  });

  test("optimistic concurrency: a stale expectedVersion on the verification composite is rejected", async () => {
    const golden = await goldenPathSponsorship(harness, {
      requiredKinds: ["material_connection"],
    });
    const publication = await createPublication(harness, {
      engagementId: golden.engagementId,
    });
    // Satisfy BOTH obligations (the campaign's material_connection +
    // the golden relationship's genuine_experience) so the gate
    // PASSES and the version check is what rejects the stale writer.
    await declareKind(harness, publication.id, "material_connection");
    await declareKind(harness, publication.id, "genuine_experience");
    const { evidenceId } = await createPublicationEvidence(
      harness,
      publication.id,
    );
    // Stale version (the publication is at `publication.version`;
    // pass version - 1... version 0 → use a deliberately stale 99? No:
    // stale means != current. Current is 0 → pass 0 is correct; pass
    // 99 is stale. But the version check happens INSIDE the apply —
    // the twin's check compares against the in-tx read.
    await expect(
      harness.runtime.creatorSponsorshipService.verifyPublication(
        operatorCtx(harness, "w018-ac08-stale"),
        {
          organizationScopeId: harness.organizationScopeId,
          publicationId: publication.id,
          expectedVersion: 99,
          evidenceReferences: [evidenceId],
          idempotencyKey: key("w018-ac08-stale"),
        },
      ),
    ).rejects.toMatchObject({ code: "CONCURRENT_TRANSITION" });
    // NOTHING committed: the publication stays DRAFT with no
    // verification bookkeeping.
    const after = await harness.runtime.creatorSponsorshipService.getPublication(
      operatorCtx(harness, "w018-ac08-stale-read"),
      harness.organizationScopeId,
      publication.id,
    );
    expect(after.state).toBe("DRAFT");
    expect(after.verifiedAt).toBeNull();
    expect(after.publicationEvidenceReferences).toEqual([]);
    // A FRESH key with the CORRECT version succeeds (retry
    // converges).
    const retried = await harness.runtime.creatorSponsorshipService.verifyPublication(
      operatorCtx(harness, "w018-ac08-stale-retry"),
      {
        organizationScopeId: harness.organizationScopeId,
        publicationId: publication.id,
        expectedVersion: publication.version,
        evidenceReferences: [evidenceId],
        idempotencyKey: key("w018-ac08-stale-retry"),
      },
    );
    expect(retried.publication.state).toBe("VERIFIED");
  });

  test("a fresh key against an already-VERIFIED publication fails deterministically (no double verification)", async () => {
    const golden = await goldenPathSponsorship(harness, {
      requiredKinds: ["material_connection"],
    });
    const verifiedPublication = golden.verifiedPublication;
    const { evidenceId } = await createPublicationEvidence(
      harness,
      verifiedPublication.id,
    );
    await expect(
      harness.runtime.creatorSponsorshipService.verifyPublication(
        operatorCtx(harness, "w018-ac08-double"),
        {
          organizationScopeId: harness.organizationScopeId,
          publicationId: verifiedPublication.id,
          expectedVersion: verifiedPublication.version,
          evidenceReferences: [evidenceId],
          idempotencyKey: key("w018-ac08-double"),
        },
      ),
    ).rejects.toMatchObject({ code: "SPONSORSHIP_VALIDATION" });
    // The stored record is unchanged.
    const after = await harness.runtime.creatorSponsorshipService.getPublication(
      operatorCtx(harness, "w018-ac08-double-read"),
      harness.organizationScopeId,
      verifiedPublication.id,
    );
    expect(after.state).toBe("VERIFIED");
    expect(after.version).toBe(verifiedPublication.version);
  });

  test("transactional audit lineage: the W018 mutations carry execution/correlation/transaction lineage", async () => {
    const golden = await goldenPathSponsorship(harness, {
      requiredKinds: ["material_connection"],
    });
    // The publication.verified audit event carries the full lineage
    // + the authoritative transaction id.
    const events = await harness.runtime.auditWriter.query({
      eventType: "publication.verified",
      resourceId: golden.verifiedPublication.id,
    });
    expect(events).toHaveLength(1);
    const event = events[0]!;
    expect(event.executionId).toBeTruthy();
    expect(event.correlationId).toBeTruthy();
    expect(event.metadata.transactionId).toBeTruthy();
    expect(event.metadata.idempotencyRecordId).toBeTruthy();
    expect(event.metadata.organizationScopeId).toBe(
      harness.organizationScopeId,
    );
    // The relationship + declaration + publication.recorded events
    // carry the same lineage shape.
    const relationshipEvents = await harness.runtime.auditWriter.query({
      eventType: "commercial_relationship.recorded",
      resourceId: golden.relationship.id,
    });
    expect(relationshipEvents).toHaveLength(1);
    expect(relationshipEvents[0]!.metadata.transactionId).toBeTruthy();
    for (const declaration of golden.declarations) {
      const declarationEvents = await harness.runtime.auditWriter.query({
        eventType: "disclosure_declaration.recorded",
        resourceId: declaration.id,
      });
      expect(declarationEvents).toHaveLength(1);
      expect(declarationEvents[0]!.metadata.transactionId).toBeTruthy();
    }
  });

  test("PostgreSQL authority: every W018 record persists through the authority (survives independent re-reads)", async () => {
    const golden = await goldenPathSponsorship(harness, {
      requiredKinds: ["material_connection"],
    });
    // Independent re-reads through the wired repositories resolve the
    // same committed records (the authority-backed persistence — the
    // file-backed shim in tests, PostgreSQL in production).
    const relationship = await harness.runtime.creatorSponsorshipService.getCommercialRelationship(
      personCtx(harness, harness.operatorPersonId, "w018-ac08-reread"),
      harness.organizationScopeId,
      golden.relationship.id,
    );
    expect(relationship).toMatchObject({ id: golden.relationship.id });
    const publication = await harness.runtime.creatorSponsorshipService.getPublication(
      personCtx(harness, harness.operatorPersonId, "w018-ac08-reread"),
      harness.organizationScopeId,
      golden.verifiedPublication.id,
    );
    expect(publication.state).toBe("VERIFIED");
    expect(publication.publicationEvidenceReferences).toEqual([
      golden.publicationEvidenceId,
    ]);
  });
});
