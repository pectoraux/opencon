/**
 * NET-W018-AC-03 — disclosure declarations and publication evidence
 * preserve provenance and canonical evidence references (issue #35
 * AC-03; invariant 3 + invariant 6 — disclosure proof cannot be
 * fabricated in the creator domain).
 */

import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import {
  createNetW018Harness,
  createPublication,
  createPublicationEvidence,
  createW017ProductionEvidence,
  declareKind,
  key,
  operatorCtx,
  personCtx,
  type NetW018Harness,
} from "./_net-w018-harness.ts";
import { AuthorizationError } from "../../src/core/errors.ts";

let harness: NetW018Harness;

beforeAll(async () => {
  harness = await createNetW018Harness();
});

afterAll(async () => {
  await harness.teardown();
});

describe("NET-W018-AC-03 declarations + evidence", () => {
  test("a declaration is an auditable, provenance-preserving record bound to the publication", async () => {
    const publication = await createPublication(harness);
    const { evidenceId } = await createPublicationEvidence(
      harness,
      publication.id,
    );
    const ctx = personCtx(harness, harness.creatorPersonId, "w018-ac03-decl");
    const result =
      await harness.runtime.creatorSponsorshipService.recordDisclosureDeclaration(
        ctx,
        {
          organizationScopeId: harness.organizationScopeId,
          publicationId: publication.id,
          kind: "material_connection",
          statement: "Paid partnership with the campaign sponsor.",
          evidenceReferences: [evidenceId],
          idempotencyKey: key("w018-ac03-decl"),
        },
      );
    expect(result.created).toBe(true);
    const declaration = result.declaration;
    expect(declaration.publicationId).toBe(publication.id);
    expect(declaration.kind).toBe("material_connection");
    expect(declaration.declaredByPersonId).toBe(harness.creatorPersonId);
    expect(declaration.statement).toBe(
      "Paid partnership with the campaign sponsor.",
    );
    // Canonical evidence reference preserved verbatim.
    expect(declaration.evidenceReferences).toEqual([evidenceId]);
    expect(declaration.formatVersion).toBe("NET-W018:1");
    // Provenance: full execution lineage.
    expect(declaration.executionId).toBeTruthy();
    expect(declaration.correlationId).toBeTruthy();
    expect(declaration.causationId).toBeDefined();

    // AUDITED: the disclosure_declaration.recorded event carries the
    // binding + evidence references.
    const events = await harness.runtime.auditWriter.query({
      eventType: "disclosure_declaration.recorded",
      resourceId: declaration.id,
    });
    expect(events).toHaveLength(1);
    expect(events[0]!.metadata.publicationId).toBe(publication.id);
    expect(events[0]!.metadata.kind).toBe("material_connection");
    expect(events[0]!.metadata.evidenceReferences).toEqual([evidenceId]);

    // Durable + listable.
    const listed =
      await harness.runtime.creatorSponsorshipService.listDisclosureDeclarations(
        operatorCtx(harness, "w018-ac03-list"),
        harness.organizationScopeId,
        publication.id,
      );
    expect(listed).toHaveLength(1);
    expect(listed[0]!.id).toBe(declaration.id);
  });

  test("declaration evidence must resolve in the canonical /evidence authority with the EXACT publication binding", async () => {
    const publication = await createPublication(harness);
    const otherPublication = await createPublication(harness);
    const ctx = personCtx(harness, harness.creatorPersonId, "w018-ac03-bind");

    const base = {
      organizationScopeId: harness.organizationScopeId,
      publicationId: publication.id,
      kind: "material_connection",
      statement: "fixture",
      idempotencyKey: key("w018-ac03-bind"),
    } as const;

    // Nonexistent evidence → rejected.
    await expect(
      harness.runtime.creatorSponsorshipService.recordDisclosureDeclaration(
        ctx,
        { ...base, evidenceReferences: ["ev-does-not-exist"] },
      ),
    ).rejects.toMatchObject({ code: "SPONSORSHIP_VALIDATION" });

    // Cross-scope evidence → rejected (tenant isolation).
    const crossScope = await createPublicationEvidence(harness, publication.id, {
      organizationScopeId: harness.secondOrgId,
      ownerId: harness.secondOrgPersonId,
    });
    await expect(
      harness.runtime.creatorSponsorshipService.recordDisclosureDeclaration(
        ctx,
        { ...base, evidenceReferences: [crossScope.evidenceId] },
      ),
    ).rejects.toMatchObject({ code: "SPONSORSHIP_VALIDATION" });

    // Wrong subject TYPE (a ugc_production-bound evidence record) →
    // rejected: disclosure proof must be publication-bound.
    const productionBound = await createW017ProductionEvidence(
      harness.w017,
      "any-production",
      { subjectType: "ugc_production", subjectId: publication.id },
    );
    await expect(
      harness.runtime.creatorSponsorshipService.recordDisclosureDeclaration(
        ctx,
        { ...base, evidenceReferences: [productionBound.evidenceId] },
      ),
    ).rejects.toMatchObject({ code: "SPONSORSHIP_VALIDATION" });

    // Wrong subject ID (another publication's evidence) → rejected:
    // declarations for THIS publication cannot be satisfied with
    // another publication's proof.
    const otherEvidence = await createPublicationEvidence(
      harness,
      otherPublication.id,
    );
    await expect(
      harness.runtime.creatorSponsorshipService.recordDisclosureDeclaration(
        ctx,
        { ...base, evidenceReferences: [otherEvidence.evidenceId] },
      ),
    ).rejects.toMatchObject({ code: "SPONSORSHIP_VALIDATION" });

    // ≥1 evidence reference required.
    await expect(
      harness.runtime.creatorSponsorshipService.recordDisclosureDeclaration(
        ctx,
        { ...base, evidenceReferences: [] },
      ),
    ).rejects.toMatchObject({ code: "SPONSORSHIP_VALIDATION" });
    // Duplicates rejected.
    const valid = await createPublicationEvidence(harness, publication.id);
    await expect(
      harness.runtime.creatorSponsorshipService.recordDisclosureDeclaration(
        ctx,
        { ...base, evidenceReferences: [valid.evidenceId, valid.evidenceId] },
      ),
    ).rejects.toMatchObject({ code: "SPONSORSHIP_VALIDATION" });

    // NOTHING was recorded by the rejected attempts.
    const listed =
      await harness.runtime.creatorSponsorshipService.listDisclosureDeclarations(
        operatorCtx(harness, "w018-ac03-bind"),
        harness.organizationScopeId,
        publication.id,
      );
    expect(listed).toHaveLength(0);
  });

  test("the declaration kind obeys the frozen disclosure vocabulary", async () => {
    const publication = await createPublication(harness);
    const { evidenceId } = await createPublicationEvidence(
      harness,
      publication.id,
    );
    const ctx = personCtx(harness, harness.creatorPersonId, "w018-ac03-kind");
    await expect(
      harness.runtime.creatorSponsorshipService.recordDisclosureDeclaration(
        ctx,
        {
          organizationScopeId: harness.organizationScopeId,
          publicationId: publication.id,
          kind: "shoutout",
          statement: "fixture",
          evidenceReferences: [evidenceId],
          idempotencyKey: key("w018-ac03-kind"),
        },
      ),
    ).rejects.toMatchObject({ code: "SPONSORSHIP_VALIDATION" });
  });

  test("the declaration is CREATOR-only (the acting person must be the engagement's creator)", async () => {
    const publication = await createPublication(harness);
    const { evidenceId } = await createPublicationEvidence(
      harness,
      publication.id,
    );
    await expect(
      harness.runtime.creatorSponsorshipService.recordDisclosureDeclaration(
        personCtx(harness, harness.operatorPersonId, "w018-ac03-operator"),
        {
          organizationScopeId: harness.organizationScopeId,
          publicationId: publication.id,
          kind: "material_connection",
          statement: "operator attempting to declare",
          evidenceReferences: [evidenceId],
          idempotencyKey: key("w018-ac03-operator"),
        },
      ),
    ).rejects.toBeInstanceOf(AuthorizationError);
  });

  test("declarations attach to DRAFT publications only; idempotent replay returns the committed record", async () => {
    const publication = await createPublication(harness);
    const idempotencyKey = key("w018-ac03-replay");
    const first = await declareKind(harness, publication.id, "material_connection");
    // Same-key replay of the same declaration.
    const { evidenceId } = await createPublicationEvidence(
      harness,
      publication.id,
    );
    const ctx = personCtx(harness, harness.creatorPersonId, "w018-ac03-replay");
    const replay =
      await harness.runtime.creatorSponsorshipService.recordDisclosureDeclaration(
        ctx,
        {
          organizationScopeId: harness.organizationScopeId,
          publicationId: publication.id,
          kind: "material_connection",
          statement: "replay attempt",
          evidenceReferences: [evidenceId],
          idempotencyKey: first.idempotencyKey,
        },
      );
    expect(replay.created).toBe(false);
    expect(replay.declaration.id).toBe(first.id);

    // Terminal publications accept no declarations: cancel the
    // publication through the workflow authority, then attempt.
    await harness.runtime.apiCommands.requestTransition(
      operatorCtx(harness, "w018-ac03-cancel"),
      harness.operatorPersonId,
      {
        subjectId: publication.id,
        subjectKind: "publication",
        targetState: "CANCELLED",
        expectedVersion: publication.version,
        idempotencyKey: key("w018-ac03-cancel"),
        policyAction: "publication.transition.draft_to_cancelled",
      },
    );
    await expect(
      harness.runtime.creatorSponsorshipService.recordDisclosureDeclaration(
        ctx,
        {
          organizationScopeId: harness.organizationScopeId,
          publicationId: publication.id,
          kind: "genuine_experience",
          statement: "late declaration",
          evidenceReferences: [evidenceId],
          idempotencyKey,
        },
      ),
    ).rejects.toMatchObject({ code: "SPONSORSHIP_VALIDATION" });
  });

  test("append-only bound: at most 16 declarations per publication", async () => {
    const publication = await createPublication(harness, {
      requiredKinds: [],
    });
    // 16 valid declarations of distinct/dupe kinds.
    for (let i = 0; i < 16; i += 1) {
      const { evidenceId } = await createPublicationEvidence(
        harness,
        publication.id,
      );
      await harness.runtime.creatorSponsorshipService.recordDisclosureDeclaration(
        personCtx(harness, harness.creatorPersonId, `w018-ac03-cap-${i}`),
        {
          organizationScopeId: harness.organizationScopeId,
          publicationId: publication.id,
          kind: "material_connection",
          statement: `declaration ${i}`,
          evidenceReferences: [evidenceId],
          idempotencyKey: key(`w018-ac03-cap-${i}`),
        },
      );
    }
    const { evidenceId } = await createPublicationEvidence(
      harness,
      publication.id,
    );
    await expect(
      harness.runtime.creatorSponsorshipService.recordDisclosureDeclaration(
        personCtx(harness, harness.creatorPersonId, "w018-ac03-cap-16"),
        {
          organizationScopeId: harness.organizationScopeId,
          publicationId: publication.id,
          kind: "material_connection",
          statement: "the 17th declaration",
          evidenceReferences: [evidenceId],
          idempotencyKey: key("w018-ac03-cap-16"),
        },
      ),
    ).rejects.toMatchObject({ code: "SPONSORSHIP_VALIDATION" });
  });

  test("publication evidence itself is canonical + subject-bound (the verification input validates the same way)", async () => {
    const publication = await createPublication(harness);
    // Cross-scope publication evidence.
    const crossScope = await createPublicationEvidence(harness, publication.id, {
      organizationScopeId: harness.secondOrgId,
      ownerId: harness.secondOrgPersonId,
    });
    // Another publication's evidence.
    const other = await createPublication(harness);
    const otherEvidence = await createPublicationEvidence(harness, other.id);
    const ctx = operatorCtx(harness, "w018-ac03-pubev");
    for (const evidenceReferences of [
      [],
      [crossScope.evidenceId],
      [otherEvidence.evidenceId],
    ]) {
      await expect(
        harness.runtime.creatorSponsorshipService.verifyPublication(ctx, {
          organizationScopeId: harness.organizationScopeId,
          publicationId: publication.id,
          expectedVersion: publication.version,
          evidenceReferences,
          idempotencyKey: key("w018-ac03-pubev"),
        }),
      ).rejects.toMatchObject({ code: "SPONSORSHIP_VALIDATION" });
    }
    // Nothing verified, nothing recorded.
    const after = await harness.runtime.creatorSponsorshipService.getPublication(
      ctx,
      harness.organizationScopeId,
      publication.id,
    );
    expect(after.state).toBe("DRAFT");
    expect(after.verifiedAt).toBeNull();
    expect(after.publicationEvidenceReferences).toEqual([]);
  });
});
