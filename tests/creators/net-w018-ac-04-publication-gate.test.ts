/**
 * NET-W018-AC-04 — THE DISCLOSURE GATE (issue #35 AC-04; invariant 4):
 * publication cannot proceed while required disclosure obligations
 * are unsatisfied, and CALLER-CONTROLLED CLAIMS CANNOT OVERRIDE the
 * policy. Producing or owning content does not itself imply
 * publication authority.
 */

import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import {
  createNetW018Harness,
  createCampaignWithDisclosurePolicy,
  createVerifiedEngagement,
  createCommercialRelationship,
  createPublication,
  createPublicationEvidence,
  declareKind,
  key,
  operatorCtx,
  personCtx,
  type NetW018Harness,
} from "./_net-w018-harness.ts";
import { DisclosureObligationsUnsatisfiedError } from "../../src/core/creators.ts";
import {
  IllegalTransitionError,
  policyActionFor,
} from "../../src/core/workflow.ts";

const REPO = join(import.meta.dir, "../..");

let harness: NetW018Harness;

beforeAll(async () => {
  harness = await createNetW018Harness();
});

afterAll(async () => {
  await harness.teardown();
});

describe("NET-W018-AC-04 the disclosure gate", () => {
  test("publication is BLOCKED while required obligations are unsatisfied (stable error + machine-readable context)", async () => {
    const publication = await createPublication(harness, {
      requiredKinds: ["material_connection", "genuine_experience"],
    });
    const { evidenceId } = await createPublicationEvidence(
      harness,
      publication.id,
    );
    const attempt = harness.runtime.creatorSponsorshipService.verifyPublication(
      operatorCtx(harness, "w018-ac04-block"),
      {
        organizationScopeId: harness.organizationScopeId,
        publicationId: publication.id,
        expectedVersion: publication.version,
        evidenceReferences: [evidenceId],
        idempotencyKey: key("w018-ac04-block"),
      },
    );
    await expect(attempt).rejects.toBeInstanceOf(
      DisclosureObligationsUnsatisfiedError,
    );
    const error = await attempt.catch((e) => e);
    expect(error.code).toBe("DISCLOSURE_OBLIGATIONS_UNSATISFIED");
    expect(error.context.requiredKinds).toEqual([
      "material_connection",
      "genuine_experience",
    ]);
    expect(error.context.satisfiedKinds).toEqual([]);
    expect(error.context.missingKinds).toEqual([
      "material_connection",
      "genuine_experience",
    ]);

    // The block committed NOTHING: the publication stays DRAFT with
    // no verification bookkeeping, and no verification audit exists.
    const after = await harness.runtime.creatorSponsorshipService.getPublication(
      operatorCtx(harness, "w018-ac04-block-read"),
      harness.organizationScopeId,
      publication.id,
    );
    expect(after.state).toBe("DRAFT");
    expect(after.verifiedAt).toBeNull();
    expect(after.publicationEvidenceReferences).toEqual([]);
    const events = await harness.runtime.auditWriter.query({
      eventType: "publication.verified",
      resourceId: publication.id,
    });
    expect(events).toHaveLength(0);
  });

  test("PARTIAL satisfaction is still blocked; the error names exactly the missing kinds", async () => {
    const publication = await createPublication(harness, {
      requiredKinds: ["material_connection", "genuine_experience"],
    });
    await declareKind(harness, publication.id, "material_connection");
    const { evidenceId } = await createPublicationEvidence(
      harness,
      publication.id,
    );
    const attempt = harness.runtime.creatorSponsorshipService.verifyPublication(
      operatorCtx(harness, "w018-ac04-partial"),
      {
        organizationScopeId: harness.organizationScopeId,
        publicationId: publication.id,
        expectedVersion: publication.version,
        evidenceReferences: [evidenceId],
        idempotencyKey: key("w018-ac04-partial"),
      },
    );
    const error = await attempt.catch((e) => e);
    expect(error.code).toBe("DISCLOSURE_OBLIGATIONS_UNSATISFIED");
    expect(error.context.satisfiedKinds).toEqual(["material_connection"]);
    expect(error.context.missingKinds).toEqual(["genuine_experience"]);
  });

  test("a declaration for a DIFFERENT publication does not count (satisfaction is per-publication)", async () => {
    const publication = await createPublication(harness, {
      requiredKinds: ["material_connection"],
    });
    // Satisfy the SAME kind on a DIFFERENT publication.
    const other = await createPublication(harness, {
      requiredKinds: ["material_connection"],
    });
    await declareKind(harness, other.id, "material_connection");
    const { evidenceId } = await createPublicationEvidence(
      harness,
      publication.id,
    );
    await expect(
      harness.runtime.creatorSponsorshipService.verifyPublication(
        operatorCtx(harness, "w018-ac04-crosspub"),
        {
          organizationScopeId: harness.organizationScopeId,
          publicationId: publication.id,
          expectedVersion: publication.version,
          evidenceReferences: [evidenceId],
          idempotencyKey: key("w018-ac04-crosspub"),
        },
      ),
    ).rejects.toMatchObject({ code: "DISCLOSURE_OBLIGATIONS_UNSATISFIED" });
  });

  test("NO CALLER INPUT CAN OVERRIDE THE GATE: the verify input carries no compliance/waiver field (structural pin)", async () => {
    const source = await readFile(
      join(REPO, "src/creators/port.ts"),
      "utf8",
    );
    // The verify input is EXACTLY the five neutral fields — there is
    // structurally no place for a caller to assert compliance.
    const block = source.slice(
      source.indexOf("export interface VerifyPublicationInput"),
      source.indexOf("export interface VerifyPublicationResult"),
    );
    expect(block).toMatch(/organizationScopeId/);
    expect(block).toMatch(/publicationId/);
    expect(block).toMatch(/expectedVersion/);
    expect(block).toMatch(/evidenceReferences/);
    expect(block).toMatch(/idempotencyKey/);
    expect(block).not.toMatch(/satisf/i);
    expect(block).not.toMatch(/complian/i);
    expect(block).not.toMatch(/waiv/i);
    expect(block).not.toMatch(/override/i);
    expect(block).not.toMatch(/skip/i);
    expect(block).not.toMatch(/force/i);
    // The gate is DERIVED: the service source carries no caller-
    // asserted disclosure input anywhere.
    const service = await readFile(
      join(REPO, "src/creators/sponsorship-service.ts"),
      "utf8",
    );
    expect(service).not.toMatch(/input\.satisfied/);
    expect(service).not.toMatch(/input\.compliant/);
    expect(service).not.toMatch(/input\.waiv/);
    expect(service).not.toMatch(/assertCompliance/);
    // Unknown extra input fields are IGNORED (a record carrying
    // `disclosuresSatisfied: true` still hits the derived gate).
    const publication = await createPublication(harness, {
      requiredKinds: ["material_connection"],
    });
    const { evidenceId } = await createPublicationEvidence(
      harness,
      publication.id,
    );
    const claimInput: Record<string, unknown> = {
      organizationScopeId: harness.organizationScopeId,
      publicationId: publication.id,
      expectedVersion: publication.version,
      evidenceReferences: [evidenceId],
      idempotencyKey: key("w018-ac04-claim"),
      // Caller-controlled compliance claims — IGNORED by the service
      // (no such input field exists; the derivation is the only
      // path to satisfaction).
      disclosuresSatisfied: true,
      complianceClaimed: true,
      force: true,
    };
    await expect(
      harness.runtime.creatorSponsorshipService.verifyPublication(
        operatorCtx(harness, "w018-ac04-claim"),
        claimInput as never,
      ),
    ).rejects.toMatchObject({ code: "DISCLOSURE_OBLIGATIONS_UNSATISFIED" });
  });

  test("satisfaction arrives only through RECORDED declarations; then verification SUCCEEDS atomically", async () => {
    const campaign = await createCampaignWithDisclosurePolicy(harness, {
      requiredKinds: ["material_connection"],
    });
    const verified = await createVerifiedEngagement(harness, {
      campaignId: campaign.id,
    });
    // The relationship adds a second obligation (the union).
    await createCommercialRelationship(harness, {
      engagementId: verified.engagementId,
      campaignId: campaign.id,
      disclosureObligations: ["genuine_experience"],
    });
    const publication = await createPublication(harness, {
      engagementId: verified.engagementId,
      productionId: verified.productionId,
    });
    // Before: blocked with both kinds missing.
    const { evidenceId } = await createPublicationEvidence(
      harness,
      publication.id,
    );
    await expect(
      harness.runtime.creatorSponsorshipService.verifyPublication(
        operatorCtx(harness, "w018-ac04-union-blocked"),
        {
          organizationScopeId: harness.organizationScopeId,
          publicationId: publication.id,
          expectedVersion: publication.version,
          evidenceReferences: [evidenceId],
          idempotencyKey: key("w018-ac04-union-blocked"),
        },
      ),
    ).rejects.toMatchObject({
      code: "DISCLOSURE_OBLIGATIONS_UNSATISFIED",
      context: { missingKinds: ["material_connection", "genuine_experience"] },
    });

    // Record BOTH declarations (the only path to satisfaction).
    await declareKind(harness, publication.id, "material_connection");
    await declareKind(harness, publication.id, "genuine_experience");
    const result = await harness.runtime.creatorSponsorshipService.verifyPublication(
      operatorCtx(harness, "w018-ac04-union-pass"),
      {
        organizationScopeId: harness.organizationScopeId,
        publicationId: publication.id,
        expectedVersion: publication.version,
        evidenceReferences: [evidenceId],
        idempotencyKey: key("w018-ac04-union-pass"),
      },
    );
    expect(result.transition.executed).toBe(true);
    expect(result.transition.auditEventName).toBe(
      "publication.transition.draft_to_verified",
    );
    expect(result.publication.state).toBe("VERIFIED");
    expect(result.publication.verifiedAt).toBeTruthy();
    expect(result.publication.publicationEvidenceReferences).toEqual([
      evidenceId,
    ]);
    expect(result.publication.version).toBe(publication.version + 1);
    // The gate snapshot rides the result (auditable derivation).
    expect(result.disclosureStatus.satisfied).toBe(true);
    expect(result.disclosureStatus.obligations.map((o) => o.kind)).toEqual([
      "material_connection",
      "genuine_experience",
    ]);

    // The verification is DURABLE + audited atomically.
    const stored = await harness.runtime.creatorSponsorshipService.getPublication(
      operatorCtx(harness, "w018-ac04-union-read"),
      harness.organizationScopeId,
      publication.id,
    );
    expect(stored.state).toBe("VERIFIED");
    const auditEvents = await harness.runtime.auditWriter.query({
      eventType: "publication.verified",
      resourceId: publication.id,
    });
    expect(auditEvents).toHaveLength(1);
    const gate = auditEvents[0]!.metadata.disclosureGate as Record<
      string,
      unknown
    >;
    expect(gate.requiredKinds).toEqual([
      "material_connection",
      "genuine_experience",
    ]);
    expect(gate.satisfiedKinds).toEqual([
      "material_connection",
      "genuine_experience",
    ]);
  });

  test("PRODUCING OR OWNING CONTENT DOES NOT IMPLY PUBLICATION AUTHORITY: a non-VERIFIED engagement admits no publication", async () => {
    // An engagement stuck in SUBMITTED (produced + submitted, but NOT
    // verified) cannot host a publication.
    const campaign = await createCampaignWithDisclosurePolicy(harness, {
      requiredKinds: ["material_connection"],
    });
    const { createEngagement, tenderEngagement, acceptEngagement, openProduction, recordDeliverable, createProductionEvidence, submitProduction } =
      await import("./_net-w017-harness.ts");
    const { engagement } = await createEngagement(harness.w017, {
      campaignId: campaign.id,
    });
    await tenderEngagement(harness.w017, engagement.id, engagement.version);
    const accepted = await acceptEngagement(harness.w017, engagement.id, 1);
    const opened = await openProduction(harness.w017, accepted.engagement.id, 2);
    await recordDeliverable(harness.w017, opened.production.id);
    const { evidenceId } = await createProductionEvidence(
      harness.w017,
      opened.production.id,
    );
    const submitted = await submitProduction(
      harness.w017,
      opened.production.id,
      opened.engagementVersion,
      [evidenceId],
    );
    expect(submitted.submissionId).toBeTruthy();
    // SUBMITTED (not VERIFIED): the publication is REFUSED.
    await expect(
      createPublication(harness, {
        engagementId: accepted.engagement.id,
        productionId: opened.production.id,
      }),
    ).rejects.toMatchObject({
      code: "SPONSORSHIP_VALIDATION",
      context: { state: "SUBMITTED" },
    });
  });

  test("a TERMINATED relationship still imposes its obligations (the conservative direction)", async () => {
    const verified = await createVerifiedEngagement(harness, {
      requiredKinds: [],
    });
    const relationship = await createCommercialRelationship(harness, {
      engagementId: verified.engagementId,
      campaignId: verified.campaignId,
      disclosureObligations: ["material_connection"],
    });
    await harness.runtime.creatorSponsorshipService.terminateCommercialRelationship(
      operatorCtx(harness, "w018-ac04-terminate"),
      {
        organizationScopeId: harness.organizationScopeId,
        relationshipId: relationship.id,
        reason: "concluded",
        idempotencyKey: key("w018-ac04-terminate"),
      },
    );
    const publication = await createPublication(harness, {
      engagementId: verified.engagementId,
      productionId: verified.productionId,
    });
    const { evidenceId } = await createPublicationEvidence(
      harness,
      publication.id,
    );
    // Terminated, but the obligation STILL gates the publication
    // (content produced under the relationship stays disclosed).
    await expect(
      harness.runtime.creatorSponsorshipService.verifyPublication(
        operatorCtx(harness, "w018-ac04-terminated"),
        {
          organizationScopeId: harness.organizationScopeId,
          publicationId: publication.id,
          expectedVersion: publication.version,
          evidenceReferences: [evidenceId],
          idempotencyKey: key("w018-ac04-terminated"),
        },
      ),
    ).rejects.toMatchObject({ code: "DISCLOSURE_OBLIGATIONS_UNSATISFIED" });
  });

  test("the pinned campaign policy VERSION governs (the engagement's pinned version, not a later one)", async () => {
    // Version 1 requires material_connection. The engagement pins
    // version 1 (created under it). A LATER version 2 drops the
    // requirement — the gate STILL enforces the pinned version.
    // The engagement created under version 1 (pins v1), THEN version
    // 2 drops the requirement — the gate still enforces the PINNED
    // version.
    const campaign = await createCampaignWithDisclosurePolicy(harness, {
      requiredKinds: ["material_connection"],
    });
    const { createEngagement, tenderEngagement, acceptEngagement, openProduction, recordDeliverable, createProductionEvidence, submitProduction } =
      await import("./_net-w017-harness.ts");
    const { engagement } = await createEngagement(harness.w017, {
      campaignId: campaign.id,
    });
    // The engagement pinned the version at creation — assert it is 1.
    expect(engagement.campaignPolicyVersion).toBe(1);
    // NOW define version 2 (drops the requirement).
    const ownerCtx = personCtx(harness, harness.operatorPersonId, "w018-ac04-v2");
    await harness.runtime.campaignService.defineCampaignPolicy(ownerCtx, {
      campaignId: campaign.id,
      policy: {
        objectives: [
          { id: "obj-1", kind: "creator_content", description: null, successCriteria: null },
        ],
        eligibility: { rules: [] },
        outcomePolicy: {
          requirements: [
            {
              objectiveId: "obj-1",
              outcomeType: "view",
              attributionMode: "deterministic",
              windowDays: 30,
              requiresExperiment: false,
            },
          ],
        },
        evidencePolicy: {
          requirements: [
            {
              objectiveId: "obj-1",
              requirementKind: "proof_of_value",
              minimumGrade: "ATTESTED",
              qualifyingSourceTypes: ["platform"],
            },
          ],
        },
        budget: { unit: "credits", totalAmount: 0, perObjective: [] },
        attributionRules: [
          {
            id: "attr-1",
            objectiveId: "obj-1",
            model: "deterministic",
            confidenceThreshold: 0.9,
            windowDays: 30,
            requiresExperiment: false,
          },
        ],
        clearingRules: [],
        opportunitySpecs: [
          {
            id: "spec-1",
            title: "Produce UGC",
            opportunityType: "campaign_contribution",
            brief: { neutral: true },
            contributionRequirements: { deliverables: 1 },
            evidenceReferencePlaceholders: [],
          },
        ],
        // Version 2 DROPS the requirement.
        disclosurePolicy: { requiredKinds: [] },
      },
      idempotencyKey: key("w018-ac04-v2"),
    });
    await tenderEngagement(harness.w017, engagement.id, engagement.version);
    const accepted = await acceptEngagement(harness.w017, engagement.id, 1);
    const opened = await openProduction(harness.w017, accepted.engagement.id, 2);
    await recordDeliverable(harness.w017, opened.production.id);
    const { evidenceId: w017Evidence } = await createProductionEvidence(
      harness.w017,
      opened.production.id,
    );
    const submitted = await submitProduction(
      harness.w017,
      opened.production.id,
      opened.engagementVersion,
      [w017Evidence],
    );
    await harness.runtime.apiCommands.requestTransition(
      operatorCtx(harness, "w018-ac04-verify-eng"),
      harness.operatorPersonId,
      {
        subjectId: accepted.engagement.id,
        subjectKind: "engagement",
        targetState: "VERIFIED",
        expectedVersion: submitted.engagementVersion,
        idempotencyKey: key("w018-ac04-verify-eng"),
        policyAction: "engagement.transition.submitted_to_verified",
      },
    );
    const publication = await createPublication(harness, {
      engagementId: accepted.engagement.id,
      productionId: opened.production.id,
    });
    const { evidenceId } = await createPublicationEvidence(
      harness,
      publication.id,
    );
    // Version 2 (latest) requires NOTHING — but the engagement
    // PINNED version 1, and the gate derives from the PINNED policy.
    await expect(
      harness.runtime.creatorSponsorshipService.verifyPublication(
        operatorCtx(harness, "w018-ac04-pinned"),
        {
          organizationScopeId: harness.organizationScopeId,
          publicationId: publication.id,
          expectedVersion: publication.version,
          evidenceReferences: [evidenceId],
          idempotencyKey: key("w018-ac04-pinned"),
        },
      ),
    ).rejects.toMatchObject({
      code: "DISCLOSURE_OBLIGATIONS_UNSATISFIED",
      context: { missingKinds: ["material_connection"] },
    });
  });
});

// ---------------------------------------------------------------------------
// THE PR #36 REMEDIATION REGRESSION (architect CHANGES REQUESTED):
// the publication DRAFT → VERIFIED transition is THE DISCLOSURE GATE
// and must be unreachable through the GENERIC workflow transition
// path. An authorized caller able to invoke
// `publication.transition.draft_to_verified` through
// /api/workflows/transitions must be REJECTED — the edge is not in
// the generic table (structural), and only the creators domain's
// publication-verification composite, presenting
// PUBLICATION_VERIFICATION_SANCTION through the in-tx twin, can
// resolve it.
// ---------------------------------------------------------------------------

describe("NET-W018-AC-04 the disclosure gate is UNREACHABLE through the generic workflow path (PR #36 remediation)", () => {
  test("authorized direct generic transition + valid publication + UNSATISFIED obligations → REJECTED; publication remains DRAFT; NO verification audit", async () => {
    // A valid DRAFT publication with UNSATISFIED obligations (the
    // architect's regression scenario: exactly the state in which the
    // generic path would have bypassed the disclosure derivation).
    const publication = await createPublication(harness, {
      requiredKinds: ["material_connection", "genuine_experience"],
    });
    const { evidenceId } = await createPublicationEvidence(
      harness,
      publication.id,
    );

    // The operator IS authorized for the policy action (the harness
    // seeds the ALLOW policy) — authorization is deliberately NOT the
    // thing under test. The generic transition request is rejected
    // STRUCTURALLY: the verification edge does not exist for the
    // generic path.
    const attempt = harness.runtime.apiCommands.requestTransition(
      operatorCtx(harness, "w018-ac04-generic-unsat"),
      harness.operatorPersonId,
      {
        subjectId: publication.id,
        subjectKind: "publication",
        targetState: "VERIFIED",
        expectedVersion: publication.version,
        idempotencyKey: key("w018-ac04-generic-unsat"),
        policyAction: policyActionFor("publication", "DRAFT", "VERIFIED"),
      },
    );
    await expect(attempt).rejects.toBeInstanceOf(IllegalTransitionError);
    const error = await attempt.catch((e) => e);
    expect(error.code).toBe("ILLEGAL_TRANSITION");
    // The rejection is PRECISE: it names the required sanction and
    // records that none was presented.
    expect(error.context.requiredSanction).toBe(
      "creators.publication-verification",
    );
    expect(error.context.presentedSanction).toBeNull();

    // NOTHING committed: the publication remains DRAFT with no
    // verification bookkeeping…
    const after = await harness.runtime.creatorSponsorshipService.getPublication(
      operatorCtx(harness, "w018-ac04-generic-unsat-read"),
      harness.organizationScopeId,
      publication.id,
    );
    expect(after.state).toBe("DRAFT");
    expect(after.version).toBe(publication.version);
    expect(after.verifiedAt).toBeNull();
    expect(after.publicationEvidenceReferences).toEqual([]);
    // …and NO verification audit exists (neither the composite's
    // publication.verified event nor the workflow transition event).
    expect(
      await harness.runtime.auditWriter.query({
        eventType: "publication.verified",
        resourceId: publication.id,
      }),
    ).toHaveLength(0);
    expect(
      await harness.runtime.auditWriter.query({
        eventType: "publication.transition.draft_to_verified",
        resourceId: publication.id,
      }),
    ).toHaveLength(0);

    // The gate itself still holds for the sanctioned path: the
    // composite on this publication (obligations still unsatisfied)
    // rejects with the DISCLOSURE error — the obligations were never
    // derivable away.
    await expect(
      harness.runtime.creatorSponsorshipService.verifyPublication(
        operatorCtx(harness, "w018-ac04-generic-unsat-composite"),
        {
          organizationScopeId: harness.organizationScopeId,
          publicationId: publication.id,
          expectedVersion: publication.version,
          evidenceReferences: [evidenceId],
          idempotencyKey: key("w018-ac04-generic-unsat-composite"),
        },
      ),
    ).rejects.toMatchObject({ code: "DISCLOSURE_OBLIGATIONS_UNSATISFIED" });
  });

  test("the block is STRUCTURAL, not obligation-dependent: obligations SATISFIED → generic path STILL REJECTED; the sanctioned composite then verifies the SAME publication", async () => {
    // Stage a publication whose obligations are FULLY satisfied (the
    // composite would pass the gate right now).
    const publication = await createPublication(harness, {
      requiredKinds: ["material_connection"],
    });
    await declareKind(harness, publication.id, "material_connection");
    const { evidenceId } = await createPublicationEvidence(
      harness,
      publication.id,
    );

    // The generic transition STILL cannot verify — the edge is absent
    // from the generic table REGARDLESS of the disclosure state.
    const attempt = harness.runtime.apiCommands.requestTransition(
      operatorCtx(harness, "w018-ac04-generic-sat"),
      harness.operatorPersonId,
      {
        subjectId: publication.id,
        subjectKind: "publication",
        targetState: "VERIFIED",
        expectedVersion: publication.version,
        idempotencyKey: key("w018-ac04-generic-sat"),
        policyAction: policyActionFor("publication", "DRAFT", "VERIFIED"),
      },
    );
    await expect(attempt).rejects.toMatchObject({
      code: "ILLEGAL_TRANSITION",
      context: {
        requiredSanction: "creators.publication-verification",
        presentedSanction: null,
      },
    });
    const after = await harness.runtime.creatorSponsorshipService.getPublication(
      operatorCtx(harness, "w018-ac04-generic-sat-read"),
      harness.organizationScopeId,
      publication.id,
    );
    expect(after.state).toBe("DRAFT");
    expect(after.verifiedAt).toBeNull();
    expect(
      await harness.runtime.auditWriter.query({
        eventType: "publication.verified",
        resourceId: publication.id,
      }),
    ).toHaveLength(0);

    // The SANCTIONED path verifies the SAME publication through the
    // composite (the only route to VERIFIED — via the derived gate).
    const result =
      await harness.runtime.creatorSponsorshipService.verifyPublication(
        operatorCtx(harness, "w018-ac04-generic-sat-composite"),
        {
          organizationScopeId: harness.organizationScopeId,
          publicationId: publication.id,
          expectedVersion: publication.version,
          evidenceReferences: [evidenceId],
          idempotencyKey: key("w018-ac04-generic-sat-composite"),
        },
      );
    expect(result.transition.executed).toBe(true);
    expect(result.transition.auditEventName).toBe(
      "publication.transition.draft_to_verified",
    );
    expect(result.publication.state).toBe("VERIFIED");
    expect(result.publication.publicationEvidenceReferences).toEqual([
      evidenceId,
    ]);
    expect(
      await harness.runtime.auditWriter.query({
        eventType: "publication.verified",
        resourceId: publication.id,
      }),
    ).toHaveLength(1);
  });

  test("DRAFT → CANCELLED remains an ordinary GENERIC transition (withdrawal is not gated)", async () => {
    // The remediation must not over-block: cancelling a publication
    // through the generic workflow path keeps working.
    const publication = await createPublication(harness, {
      requiredKinds: ["material_connection"],
    });
    const result = await harness.runtime.apiCommands.requestTransition(
      operatorCtx(harness, "w018-ac04-generic-cancel"),
      harness.operatorPersonId,
      {
        subjectId: publication.id,
        subjectKind: "publication",
        targetState: "CANCELLED",
        expectedVersion: publication.version,
        idempotencyKey: key("w018-ac04-generic-cancel"),
        policyAction: policyActionFor("publication", "DRAFT", "CANCELLED"),
      },
    );
    expect(result.state).toBe("CANCELLED");
    expect(result.auditEventName).toBe(
      "publication.transition.draft_to_cancelled",
    );
    const after = await harness.runtime.creatorSponsorshipService.getPublication(
      operatorCtx(harness, "w018-ac04-generic-cancel-read"),
      harness.organizationScopeId,
      publication.id,
    );
    expect(after.state).toBe("CANCELLED");
  });
});
