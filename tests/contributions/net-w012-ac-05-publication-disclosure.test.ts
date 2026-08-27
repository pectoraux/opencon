/**
 * NET-W012-AC-05 — publication is user-controlled; commercial
 * disclosure is explicit and auditable.
 *
 * The protocol may prepare/recommend but NEVER publish: publication
 * requires a person actor == the contributor, walks the workflow
 * authority, and (when policy requires disclosure) commercial
 * mentions must be covered by ACTIVE disclosures. Disclosure history
 * is append-only, first-class and auditable.
 */
import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import {
  createNetW012Harness,
  createHelpfulnessPolicy,
  createHelpfulContribution,
  declareDefaultDisclosure,
  publishHelpfulContribution,
  attachEvidenceBasis,
  contributorCtx,
  otherCtx,
  systemCtx,
  key,
  type NetW012Harness,
} from "./_net-w012-harness.ts";

let harness: NetW012Harness;

beforeAll(async () => {
  harness = await createNetW012Harness();
});

afterAll(async () => {
  await harness.teardown();
});

describe("NET-W012-AC-05 publication + disclosure", () => {
  test("prepareRecommendation records protocol-prepared content and NEVER transitions the contribution", async () => {
    const { contribution, proofOfHelpfulness } =
      await createHelpfulContribution(harness);
    const before = await harness.runtime.contributionService.getContribution(
      harness.bootstrapCtx,
      contribution.id,
    );
    expect(before.state).toBe("DRAFT");
    const poh = await harness.runtime.helpfulnessService.prepareRecommendation(
      otherCtx(harness, "w012-ac05-prepare"),
      {
        contributionId: contribution.id,
        preparedContentRef: "content://recommendations/prepared-draft-1",
        rationale: "matches the question's intent",
        idempotencyKey: key("w012-ac05-prepare"),
      },
    );
    expect(poh.recommendations.length).toBe(1);
    expect(poh.recommendations[0]!.preparedContentRef).toBe(
      "content://recommendations/prepared-draft-1",
    );
    expect(poh.events).toContain("recommendation_prepared");
    // The lifecycle state is UNCHANGED — preparation never publishes.
    const after = await harness.runtime.contributionService.getContribution(
      harness.bootstrapCtx,
      contribution.id,
    );
    expect(after.state).toBe("DRAFT");
    expect(after.version).toBe(before.version);
    void proofOfHelpfulness;
  });

  test("publication walks /workflows to SUBMITTED and records the user-controlled publication", async () => {
    const { contribution } = await createHelpfulContribution(harness);
    const result = await publishHelpfulContribution(harness, contribution.id);
    expect(result.contribution.state).toBe("SUBMITTED");
    expect(result.proofOfHelpfulness.publication).not.toBeNull();
    expect(result.proofOfHelpfulness.publication!.publishedBy).toBe(
      harness.contributorPersonId,
    );
    expect(result.proofOfHelpfulness.publication!.workflowState).toBe(
      "SUBMITTED",
    );
    expect(result.proofOfHelpfulness.events).toContain("published");
  });

  test("a NON-contributor person cannot publish (user-controlled gate)", async () => {
    const { contribution } = await createHelpfulContribution(harness);
    await expect(
      harness.runtime.helpfulnessService.assertPublishable(
        otherCtx(harness, "w012-ac05-other"),
        contribution.id,
      ),
    ).rejects.toThrow(/publication is user-controlled — only the contributor may publish/);
    const after = await harness.runtime.contributionService.getContribution(
      harness.bootstrapCtx,
      contribution.id,
    );
    expect(after.state).toBe("DRAFT");
  });

  test("a SYSTEM actor cannot publish (the protocol never publishes on a user's behalf)", async () => {
    const { contribution } = await createHelpfulContribution(harness);
    await expect(
      harness.runtime.helpfulnessService.assertPublishable(
        systemCtx("w012-ac05-system"),
        contribution.id,
      ),
    ).rejects.toThrow(/person actor is required/i);
  });

  test("prepareRecommendation refuses AFTER publication (preparation is pre-publication only)", async () => {
    const { contribution } = await createHelpfulContribution(harness);
    await publishHelpfulContribution(harness, contribution.id);
    await expect(
      harness.runtime.helpfulnessService.prepareRecommendation(
        contributorCtx(harness, "w012-ac05-late-prepare"),
        {
          contributionId: contribution.id,
          preparedContentRef: "content://recommendations/late",
          idempotencyKey: key("w012-ac05-late-prepare"),
        },
      ),
    ).rejects.toThrow(/already published/);
  });

  test("an undisclosed commercial mention BLOCKS publication while the policy requires disclosure", async () => {
    const policy = await createHelpfulnessPolicy(harness, {
      requiresDisclosure: true,
    });
    const { contribution } = await createHelpfulContribution(harness, {
      helpfulnessPolicyId: policy.policyId,
      mentions: [
        {
          productRef: "product:acme-widget",
          disclosed: false,
          commercialRelationshipRef: "rel-acme",
        },
      ],
    });
    await expect(
      harness.runtime.helpfulnessService.assertPublishable(
        contributorCtx(harness, "w012-ac05-blocked"),
        contribution.id,
      ),
    ).rejects.toThrow(/commercial mentions without compliant active disclosures/);
    // Declare the matching disclosure → publication passes.
    await declareDefaultDisclosure(harness, contribution.id, {
      relationshipRef: "rel-acme",
    });
    await harness.runtime.helpfulnessService.assertPublishable(
      contributorCtx(harness, "w012-ac05-unblocked"),
      contribution.id,
    );
    // The composite now succeeds end-to-end.
    const published = await publishHelpfulContribution(
      harness,
      contribution.id,
    );
    expect(published.contribution.state).toBe("SUBMITTED");
  });

  test("a RETRACTED disclosure no longer covers its mention (append-only retraction re-blocks)", async () => {
    const policy = await createHelpfulnessPolicy(harness, {
      requiresDisclosure: true,
    });
    const { contribution } = await createHelpfulContribution(harness, {
      helpfulnessPolicyId: policy.policyId,
      mentions: [
        {
          productRef: "product:beta-tool",
          disclosed: true,
          commercialRelationshipRef: "rel-beta",
        },
      ],
    });
    const disclosure = await harness.runtime.helpfulnessService.declareDisclosure(
      contributorCtx(harness, "w012-ac05-declare"),
      {
        contributionId: contribution.id,
        contributorPersonId: harness.contributorPersonId,
        relationshipKind: "sponsorship",
        relationshipRef: "rel-beta",
        counterpartyRef: "org:beta",
        idempotencyKey: key("w012-ac05-declare"),
      },
    );
    await harness.runtime.helpfulnessService.assertPublishable(
      contributorCtx(harness, "w012-ac05-covered"),
      contribution.id,
    );
    const retracted = await harness.runtime.helpfulnessService.retractDisclosure(
      contributorCtx(harness, "w012-ac05-retract"),
      { disclosureId: disclosure.id, idempotencyKey: key("w012-ac05-retract") },
    );
    expect(retracted.state).toBe("RETRACTED");
    expect(retracted.events).toEqual(["declared", "retracted"]);
    await expect(
      harness.runtime.helpfulnessService.assertPublishable(
        contributorCtx(harness, "w012-ac05-reblocked"),
        contribution.id,
      ),
    ).rejects.toThrow(/without compliant active disclosures/);
  });

  test("disclosures are first-class auditable records: contributor-only declaration, tenant-scoped, append-only", async () => {
    const { contribution } = await createHelpfulContribution(harness);
    // Only the contributor declares.
    await expect(
      harness.runtime.helpfulnessService.declareDisclosure(
        otherCtx(harness, "w012-ac05-not-contributor"),
        {
          contributionId: contribution.id,
          contributorPersonId: harness.contributorPersonId,
          relationshipKind: "affiliate",
          relationshipRef: "rel-x",
          counterpartyRef: "org:x",
          idempotencyKey: key("w012-ac05-not-contributor"),
        },
      ),
    ).rejects.toThrow(/only the contributor declares/);
    // Only the contributor retracts.
    const d = await declareDefaultDisclosure(harness, contribution.id);
    await expect(
      harness.runtime.helpfulnessService.retractDisclosure(
        otherCtx(harness, "w012-ac05-not-contributor-retract"),
        { disclosureId: d.id, idempotencyKey: key("w012-ac05-ncretract") },
      ),
    ).rejects.toThrow(/not the contributor who declared/);
    // RETRACTED is terminal — retraction cannot un-retract.
    await harness.runtime.helpfulnessService.retractDisclosure(
      contributorCtx(harness, "w012-ac05-retract-once"),
      { disclosureId: d.id, idempotencyKey: key("w012-ac05-retract-once") },
    );
    await expect(
      harness.runtime.helpfulnessService.retractDisclosure(
        contributorCtx(harness, "w012-ac05-retract-twice"),
        { disclosureId: d.id, idempotencyKey: key("w012-ac05-retract-twice") },
      ),
    ).rejects.toThrow(/already RETRACTED \(terminal\)/);
    // The PoH carries the disclosure reference; the record history is
    // append-only and never rewritten.
    const poh = await harness.runtime.helpfulnessService.getProofOfHelpfulness(
      harness.bootstrapCtx,
      contribution.id,
    );
    expect(poh.disclosureIds).toContain(d.id);
    const listed = await harness.runtime.helpfulnessService.listDisclosures(
      harness.bootstrapCtx,
      contribution.id,
    );
    expect(listed[0]!.events).toEqual(["declared", "retracted"]);
  });

  test("evaluation ALSO enforces disclosure compliance (not just the publication gate)", async () => {
    const policy = await createHelpfulnessPolicy(harness, {
      requiresDisclosure: true,
    });
    const { contribution } = await createHelpfulContribution(harness, {
      helpfulnessPolicyId: policy.policyId,
      mentions: [
        {
          productRef: "product:gamma",
          disclosed: false,
          commercialRelationshipRef: "rel-gamma",
        },
      ],
    });
    await attachEvidenceBasis(harness, contribution.id);
    // The publication gate would block; force the state forward via
    // the workflow authority alone (as an authorized actor) to prove
    // the EVALUATION gate independently blocks qualification.
    let current = await harness.runtime.contributionService.getContribution(
      harness.bootstrapCtx,
      contribution.id,
    );
    for (const to of ["READY", "ASSIGNED", "IN_PROGRESS", "SUBMITTED"]) {
      const { policyActionFor } = await import("../../src/core/workflow.ts");
      await harness.runtime.apiCommands.requestTransition(
        contributorCtx(harness, "w012-ac05-walk"),
        harness.contributorPersonId,
        {
          subjectId: contribution.id,
          subjectKind: "contribution",
          targetState: to,
          expectedVersion: current.version,
          idempotencyKey: key("w012-ac05-walk"),
          policyAction: policyActionFor("contribution", current.state, to as never),
        },
      );
      current = await harness.runtime.contributionService.getContribution(
        harness.bootstrapCtx,
        contribution.id,
      );
    }
    const poh = await harness.runtime.helpfulnessService.evaluateHelpfulness(
      contributorCtx(harness, "w012-ac05-eval-blocked"),
      { contributionId: contribution.id, idempotencyKey: key("w012-ac05-eval") },
    );
    expect(poh.state).toBe("NOT_QUALIFIED");
    expect(
      poh.evaluations[poh.evaluations.length - 1]!.reasons.join(" "),
    ).toMatch(/commercial disclosure is explicit/);
  });

  test("publication replays idempotently (the same composite key is safe to retry)", async () => {
    const { contribution } = await createHelpfulContribution(harness);
    const k = key("w012-ac05-replay");
    const first = await publishHelpfulContribution(harness, contribution.id, {
      idempotencyKey: k,
    });
    expect(first.contribution.state).toBe("SUBMITTED");
    const second = await publishHelpfulContribution(harness, contribution.id, {
      idempotencyKey: k,
    });
    expect(second.contribution.state).toBe("SUBMITTED");
    expect(second.contribution.version).toBe(first.contribution.version);
    const poh = await harness.runtime.helpfulnessService.getProofOfHelpfulness(
      harness.bootstrapCtx,
      contribution.id,
    );
    // Exactly ONE publication event was recorded.
    expect(poh.events.filter((e) => e === "published").length).toBe(1);
  });
});
