/**
 * NET-W012 — transaction-boundary race regressions (PR #24 review
 * remediation).
 *
 * The ordinary tenant-isolation and disclosure suites prove the
 * pre-flight behavior; these tests prove the AUTHORITATIVE
 * transaction boundaries hold under the races the review identified:
 *
 *  1. Policy pinning tenancy: a contribution in Org A can NEVER pin
 *     a helpfulness-policy lineage whose LATEST version belongs to
 *     Org B — neither a PRE-EXISTING foreign lineage head nor one
 *     committed CONCURRENTLY between the pre-flight read and the
 *     creation transaction. The pinned policy is re-resolved and
 *     same-scope-validated INSIDE the transaction (the NET-W007
 *     lesson: organization lineage is checked at the authoritative
 *     boundary, not just in a pre-flight read).
 *
 *  2. Publication authorization TOCTOU: assertPublishable()'s
 *     disclosure-compliance check is pre-flight and NECESSARY but NOT
 *     sufficient. When a disclosure is RETRACTED between the
 *     pre-flight check and the publication commit (after the workflow
 *     transition to SUBMITTED), recordPublication() re-resolves the
 *     pinned policy and the ACTIVE disclosures INSIDE its
 *     authoritative transaction, rejects, and persists NO publication
 *     record.
 */
import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { randomUUID } from "node:crypto";
import type { ExecutionContext } from "../../src/core/execution-context.ts";
import type { HelpfulnessPolicy } from "../../src/contributions/port.ts";
import { PostgresAuthorityShim } from "../../src/persistence/postgres-authority-shim.ts";
import {
  HELPFULNESS_POLICIES_COLLECTION,
  PROOFS_OF_HELPFULNESS_COLLECTION,
} from "../../src/contributions/authority-helpfulness-repository.ts";
import { CONTRIBUTIONS_COLLECTION } from "../../src/contributions/authority-contribution-repository.ts";
import {
  createNetW012Harness,
  createHelpfulnessPolicy,
  createHelpfulCampaign,
  createHelpfulContribution,
  declareDefaultDisclosure,
  contributorCtx,
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

/** The shim (file-backed authority double) for direct store seeding. */
function shim(): PostgresAuthorityShim {
  return harness.runtime
    .postgresAuthority as unknown as PostgresAuthorityShim;
}

/**
 * Seed a foreign-organization version directly into the policy
 * lineage through the AUTHORITY (a previously existing or externally
 * created lineage head — defineHelpfulnessPolicy itself correctly
 * rejects cross-scope forks, so the store is seeded the way any
 * pre-existing/conflicting lineage state would present itself).
 */
async function seedForeignPolicyVersion(
  base: HelpfulnessPolicy,
  version: number,
  organizationScopeId: string,
): Promise<void> {
  const foreign: HelpfulnessPolicy = {
    ...base,
    id: randomUUID(),
    organizationScopeId,
    version,
  };
  await shim().run(systemCtx("w012-race-seed"), async (tx) => {
    await tx.put(
      HELPFULNESS_POLICIES_COLLECTION,
      `${base.policyId}:v${String(version)}`,
      foreign,
    );
  });
}

/** Attempt a helpful contribution in the HARNESS org against `policyId`. */
async function attemptCreate(policyId: string, opportunityId: string) {
  return harness.runtime.helpfulnessService.createHelpfulContribution(
    contributorCtx(harness, "w012-race-create"),
    {
      opportunityId,
      contributorId: harness.contributorPersonId,
      organizationScopeId: harness.organizationScopeId,
      contributionType: "helpful_recommendation",
      submission: {
        claimantAttributes: {
          participant_class: ["contributor"],
          region: ["test-region"],
        },
        mentions: [],
        contentRef: "content://drafts/race-test",
        channel: "test-channel",
      },
      helpfulnessPolicyId: policyId,
      idempotencyKey: key("w012-race-create"),
    },
  );
}

/** Walk the contribution to SUBMITTED through the WORKFLOW authority. */
async function walkToSubmitted(contributionId: string): Promise<void> {
  const { policyActionFor } = await import("../../src/core/workflow.ts");
  let current = await harness.runtime.contributionService.getContribution(
    harness.bootstrapCtx,
    contributionId,
  );
  for (const to of ["READY", "ASSIGNED", "IN_PROGRESS", "SUBMITTED"]) {
    await harness.runtime.apiCommands.requestTransition(
      contributorCtx(harness, "w012-race-walk"),
      harness.contributorPersonId,
      {
        subjectId: contributionId,
        subjectKind: "contribution",
        targetState: to as never,
        expectedVersion: current.version,
        idempotencyKey: key("w012-race-walk"),
        policyAction: policyActionFor("contribution", current.state, to as never),
      },
    );
    current = await harness.runtime.contributionService.getContribution(
      harness.bootstrapCtx,
      contributionId,
    );
  }
  expect(current.state).toBe("SUBMITTED");
}

describe("NET-W012 transaction-boundary races (PR #24 review fixes)", () => {
  describe("fix 1 — helpfulness-policy pinning is same-scope at the authoritative boundary", () => {
    test("a PRE-EXISTING foreign-scope lineage head cannot be pinned by an Org A contribution", async () => {
      // Org A owns v1 (the pre-flight-visible same-org version)…
      const policy = await createHelpfulnessPolicy(harness);
      expect(policy.organizationScopeId).toBe(harness.organizationScopeId);
      // …but the lineage's LATEST version belongs to Org B (a
      // previously existing foreign head: v2 > v1).
      await seedForeignPolicyVersion(
        policy,
        2,
        harness.secondOrgId,
      );
      const { opportunityId } = await createHelpfulCampaign(harness);

      const pohCountBefore = await shim().count(PROOFS_OF_HELPFULNESS_COLLECTION);
      const contributionCountBefore = await shim().count(CONTRIBUTIONS_COLLECTION);

      // The pre-flight passes (an Org A version exists); the
      // AUTHORITATIVE transaction must reject the cross-tenant pin.
      await expect(attemptCreate(policy.policyId, opportunityId)).rejects.toThrow(
        /cross-tenant policy pin rejected at the authoritative transaction boundary/,
      );

      // Nothing persisted: no Contribution, no PoH.
      expect(await shim().count(PROOFS_OF_HELPFULNESS_COLLECTION)).toBe(
        pohCountBefore,
      );
      expect(await shim().count(CONTRIBUTIONS_COLLECTION)).toBe(
        contributionCountBefore,
      );
    });

    test("a foreign-scope version committed BETWEEN pre-flight and the creation transaction cannot be pinned (concurrent race)", async () => {
      const policy = await createHelpfulnessPolicy(harness);
      const { opportunityId } = await createHelpfulCampaign(harness);
      const authority = shim();
      const originalBegin = authority.begin.bind(authority);
      let armed = true;
      // When the creation's authoritative transaction opens (its
      // pre-flight already read Org A v1), a "concurrent" Org B v2
      // definition commits — while the creation tx is in flight.
      authority.begin = async (context: ExecutionContext) => {
        const tx = await originalBegin(context);
        if (armed) {
          armed = false;
          await seedForeignPolicyVersion(policy, 2, harness.secondOrgId);
        }
        return tx;
      };
      const pohCountBefore = await authority.count(PROOFS_OF_HELPFULNESS_COLLECTION);
      const contributionCountBefore = await authority.count(CONTRIBUTIONS_COLLECTION);
      try {
        await expect(
          attemptCreate(policy.policyId, opportunityId),
        ).rejects.toThrow(
          /cross-tenant policy pin rejected at the authoritative transaction boundary/,
        );
      } finally {
        authority.begin = originalBegin;
      }
      // No cross-tenant pin was persisted.
      expect(await authority.count(PROOFS_OF_HELPFULNESS_COLLECTION)).toBe(
        pohCountBefore,
      );
      expect(await authority.count(CONTRIBUTIONS_COLLECTION)).toBe(
        contributionCountBefore,
      );
      // The conflicting lineage head itself remains (Org B v2 is
      // still the latest) — a LATER same-org lineage must fail too.
      const versions = await harness.runtime.helpfulnessService.listPolicyVersions(
        harness.bootstrapCtx,
        policy.policyId,
      );
      expect(versions.map((v) => v.version)).toEqual([1, 2]);
      expect(versions[1]!.organizationScopeId).toBe(harness.secondOrgId);
    });

    test("a SUCCESSFUL create proves the persisted Contribution + PoH carry a same-scope pinned policy", async () => {
      const policy = await createHelpfulnessPolicy(harness);
      const { opportunityId } = await createHelpfulCampaign(harness);
      const created = await harness.runtime.helpfulnessService.createHelpfulContribution(
        contributorCtx(harness, "w012-race-happy"),
        {
          opportunityId,
          contributorId: harness.contributorPersonId,
          organizationScopeId: harness.organizationScopeId,
          contributionType: "helpful_recommendation",
          submission: {
            claimantAttributes: {
              participant_class: ["contributor"],
              region: ["test-region"],
            },
            mentions: [],
            contentRef: "content://drafts/race-happy",
            channel: "test-channel",
          },
          helpfulnessPolicyId: policy.policyId,
          idempotencyKey: key("w012-race-happy"),
        },
      );
      const { contribution, proofOfHelpfulness } = created;
      expect(contribution.organizationScopeId).toBe(harness.organizationScopeId);
      expect(proofOfHelpfulness.organizationScopeId).toBe(
        harness.organizationScopeId,
      );
      // The pinned version is the lineage latest AND same-scope.
      expect(proofOfHelpfulness.helpfulnessPolicyId).toBe(policy.policyId);
      expect(proofOfHelpfulness.helpfulnessPolicyVersion).toBe(1);
      const pinned = await harness.runtime.helpfulnessService.getPolicyVersion(
        harness.bootstrapCtx,
        proofOfHelpfulness.helpfulnessPolicyId,
        proofOfHelpfulness.helpfulnessPolicyVersion,
      );
      expect(pinned.organizationScopeId).toBe(contribution.organizationScopeId);
    });
  });

  describe("fix 2 — publication authorization re-resolves inside the authoritative transaction (TOCTOU closure)", () => {
    async function setupCommercialContribution(): Promise<{
      contributionId: string;
      disclosureId: string;
    }> {
      const policy = await createHelpfulnessPolicy(harness, {
        requiresDisclosure: true,
      });
      const { contribution } = await createHelpfulContribution(harness, {
        helpfulnessPolicyId: policy.policyId,
        mentions: [
          {
            productRef: "product:acme-widget",
            disclosed: true,
            commercialRelationshipRef: "rel-acme",
          },
        ],
      });
      const disclosure = await declareDefaultDisclosure(harness, contribution.id, {
        relationshipRef: "rel-acme",
      });
      return { contributionId: contribution.id, disclosureId: disclosure.id };
    }

    test("a disclosure RETRACTED after assertPublishable but before the publication commit blocks the publication", async () => {
      const { contributionId, disclosureId } =
        await setupCommercialContribution();

      // (1) The pre-flight gate PASSES (the disclosure is active).
      await harness.runtime.helpfulnessService.assertPublishable(
        contributorCtx(harness, "w012-toctou-preflight"),
        contributionId,
      );

      // (2) The disclosure is RETRACTED mid-flight — after the
      //     pre-flight check, before the publication commit.
      await harness.runtime.helpfulnessService.retractDisclosure(
        contributorCtx(harness, "w012-toctou-retract"),
        { disclosureId, idempotencyKey: key("w012-toctou-retract") },
      );

      // (3) The workflow authority completes its walk (its own
      //     authority — publication recording is the domain's).
      await walkToSubmitted(contributionId);

      // (4) The authoritative publication mutation REJECTS: the
      //     disclosure state is re-resolved INSIDE the transaction.
      await expect(
        harness.runtime.helpfulnessService.recordPublication(
          contributorCtx(harness, "w012-toctou-record"),
          {
            contributionId,
            workflowState: "SUBMITTED",
            idempotencyKey: key("w012-toctou-record"),
          },
        ),
      ).rejects.toThrow(
        /without compliant active disclosures at the publication transaction boundary/,
      );

      // (5) NO publication record was persisted.
      const poh = await harness.runtime.helpfulnessService.getProofOfHelpfulness(
        harness.bootstrapCtx,
        contributionId,
      );
      expect(poh.publication).toBeNull();
      expect(poh.events).not.toContain("published");
      // The workflow authority's own state is untouched by the
      // refusal (authorities are separate); the DOMAIN recorded no
      // publication for it.
      const contribution = await harness.runtime.contributionService.getContribution(
        harness.bootstrapCtx,
        contributionId,
      );
      expect(contribution.state).toBe("SUBMITTED");
    });

    test("recordPublication still succeeds when the disclosure REMAINS active (the in-tx re-check does not over-block)", async () => {
      const { contributionId } = await setupCommercialContribution();

      await harness.runtime.helpfulnessService.assertPublishable(
        contributorCtx(harness, "w012-toctou-ok-preflight"),
        contributionId,
      );
      // NO retraction: the walk completes and the publication records.
      await walkToSubmitted(contributionId);
      const poh = await harness.runtime.helpfulnessService.recordPublication(
        contributorCtx(harness, "w012-toctou-ok-record"),
        {
          contributionId,
          workflowState: "SUBMITTED",
          idempotencyKey: key("w012-toctou-ok-record"),
        },
      );
      expect(poh.publication).not.toBeNull();
      expect(poh.publication!.workflowState).toBe("SUBMITTED");
      expect(poh.events).toContain("published");
    });

    test("the FULL composite also refuses when the disclosure is retracted before it runs (assertPublishable still first)", async () => {
      const { contributionId, disclosureId } =
        await setupCommercialContribution();
      await harness.runtime.helpfulnessService.retractDisclosure(
        contributorCtx(harness, "w012-toctou-composite-retract"),
        { disclosureId, idempotencyKey: key("w012-toctou-composite") },
      );
      await expect(
        harness.runtime.apiCommands.publishHelpfulContribution(
          contributorCtx(harness, "w012-toctou-composite"),
          harness.contributorPersonId,
          {
            contributionId,
            idempotencyKey: key("w012-toctou-composite-pub"),
          },
        ),
      ).rejects.toThrow(/without compliant active disclosures/);
      const contribution = await harness.runtime.contributionService.getContribution(
        harness.bootstrapCtx,
        contributionId,
      );
      // The composite refused BEFORE any workflow transition.
      expect(contribution.state).toBe("DRAFT");
    });
  });
});
