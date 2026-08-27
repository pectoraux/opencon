/**
 * NET-W017 AC-02 — UGC production records, lineage + deterministic
 * versioning.
 *
 * Proves (work order §3.4, issue #33 AC-2): UGC production/
 * submission records preserve creator/opportunity/contribution/
 * evidence lineage and deterministic versioning:
 *  - the production record carries the FULL lineage (creator,
 *    engagement, campaign + pinned policy version, match run,
 *    opportunity, contribution references);
 *  - deliverable versions are immutable, append-only and
 *    deterministic (monotonic per (production, deliverableKey);
 *    concurrent recordings serialize — no forked sequences);
 *  - submission requires ≥1 deliverable version + ≥1 canonical
 *    evidence reference;
 *  - the submission preserves lineage + execution/correlation
 *    provenance.
 */

import { describe, expect, test } from "bun:test";
import {
  acceptEngagement,
  createEngagement,
  createProductionEvidence,
  createActiveCampaign,
  key,
  openProduction,
  personCtx,
  recordDeliverable,
  tenderEngagement,
  createNetW017Harness,
} from "./_net-w017-harness.ts";
import { InvalidEngagementError } from "../../src/core/creators.ts";
import { NotFoundError } from "../../src/core/errors.ts";

describe("NET-W017 AC-02 — production lineage + deterministic versioning", () => {
  test("the production record preserves the full creator/campaign/match lineage", async () => {
    const harness = await createNetW017Harness();
    try {
      const campaign = await createActiveCampaign(harness);
      const { engagement } = await createEngagement(harness, {
        campaignId: campaign.id,
      });
      await tenderEngagement(harness, engagement.id, 0);
      const accepted = await acceptEngagement(harness, engagement.id, 1);
      const { production } = await openProduction(
        harness,
        accepted.engagement.id,
        2,
      );
      // The FULL lineage is preserved on the production record.
      expect(production.engagementId).toBe(accepted.engagement.id);
      expect(production.creatorPersonId).toBe(harness.creatorPersonId);
      expect(production.creatorProfileId).toBe(engagement.creatorProfileId);
      expect(production.campaignId).toBe(campaign.id);
      expect(production.campaignPolicyVersion).toBe(1);
      expect(production.matchRunId).toBe(engagement.matchRunId);
      expect(production.opportunityId).toBe(engagement.opportunityId);
      // The production carries execution provenance.
      expect(production.executionId).toBeTypeOf("string");
      expect(production.correlationId).toBeTypeOf("string");
    } finally {
      await harness.teardown();
    }
  }, 60_000);

  test("the production record preserves opportunity + contribution lineage when declared", async () => {
    const harness = await createNetW017Harness();
    try {
      // A real opportunity in the harness org.
      const ctx = personCtx(harness, harness.operatorPersonId, "w017-opp");
      const opportunity =
        await harness.runtime.opportunityService.createOpportunity(ctx, {
          organizationScopeId: harness.organizationScopeId,
          ownerId: harness.operatorPersonId,
          opportunityType: "campaign_contribution",
          title: "W017 opportunity",
          brief: { neutral: true },
        });
      const { engagement } = await createEngagement(harness, {
        opportunityId: opportunity.id,
      });
      expect(engagement.opportunityId).toBe(opportunity.id);
      await tenderEngagement(harness, engagement.id, 0);
      const accepted = await acceptEngagement(harness, engagement.id, 1);
      // A real contribution in the harness org.
      const contribution =
        await harness.runtime.contributionService.createContribution(ctx, {
          opportunityId: opportunity.id,
          contributorId: harness.creatorPersonId,
          organizationScopeId: harness.organizationScopeId,
          contributionType: "ugc",
          submission: { note: "w017 lineage" },
        });
      const { production } = await openProduction(
        harness,
        accepted.engagement.id,
        2,
        { contributionId: contribution.id },
      );
      expect(production.opportunityId).toBe(opportunity.id);
      expect(production.contributionId).toBe(contribution.id);
    } finally {
      await harness.teardown();
    }
  }, 60_000);

  test("a cross-scope opportunity reference is refused (tenant isolation on lineage)", async () => {
    const harness = await createNetW017Harness();
    try {
      // An opportunity in the SECOND org.
      const ctx = personCtx(
        harness,
        harness.secondOrgPersonId,
        "w017-opp-second",
      );
      const opportunity =
        await harness.runtime.opportunityService.createOpportunity(ctx, {
          organizationScopeId: harness.secondOrgId,
          ownerId: harness.secondOrgPersonId,
          opportunityType: "campaign_contribution",
          title: "foreign opportunity",
          brief: {},
        });
      await expect(
        createEngagement(harness, {
          opportunityId: opportunity.id,
        }),
      ).rejects.toBeInstanceOf(NotFoundError);
    } finally {
      await harness.teardown();
    }
  }, 60_000);

  test("a cross-scope contribution reference is refused on production", async () => {
    const harness = await createNetW017Harness();
    try {
      const foreignCtx = personCtx(
        harness,
        harness.secondOrgPersonId,
        "w017-foreign",
      );
      const foreignOpp =
        await harness.runtime.opportunityService.createOpportunity(foreignCtx, {
          organizationScopeId: harness.secondOrgId,
          ownerId: harness.secondOrgPersonId,
          opportunityType: "x",
          title: "foreign",
          brief: {},
        });
      const foreignContribution =
        await harness.runtime.contributionService.createContribution(
          foreignCtx,
          {
            opportunityId: foreignOpp.id,
            contributorId: harness.secondOrgPersonId,
            organizationScopeId: harness.secondOrgId,
            contributionType: "ugc",
            submission: {},
          },
        );
      const { engagement } = await createEngagement(harness);
      await tenderEngagement(harness, engagement.id, 0);
      const accepted = await acceptEngagement(harness, engagement.id, 1);
      await expect(
        openProduction(harness, accepted.engagement.id, 2, {
          contributionId: foreignContribution.id,
        }),
      ).rejects.toBeInstanceOf(NotFoundError);
    } finally {
      await harness.teardown();
    }
  }, 60_000);

  test("deliverable versions are immutable, monotonic and per-key deterministic", async () => {
    const harness = await createNetW017Harness();
    try {
      const { engagement } = await createEngagement(harness);
      await tenderEngagement(harness, engagement.id, 0);
      const accepted = await acceptEngagement(harness, engagement.id, 1);
      const { production } = await openProduction(
        harness,
        accepted.engagement.id,
        2,
      );
      // v1, v2, v3 for the same key.
      const v1 = await recordDeliverable(harness, production.id, {
        deliverableKey: "hero-video",
      });
      expect(v1.deliverable.version).toBe(1);
      expect(v1.created).toBe(true);
      const v2 = await recordDeliverable(harness, production.id, {
        deliverableKey: "hero-video",
      });
      expect(v2.deliverable.version).toBe(2);
      // A DIFFERENT key starts its own sequence.
      const other = await recordDeliverable(harness, production.id, {
        deliverableKey: "still-images",
        format: "image_set",
      });
      expect(other.deliverable.version).toBe(1);
      // The same idempotency key replays byte-identically.
      const ctx = personCtx(harness, harness.creatorPersonId, "w017-replay");
      const replay = await harness.runtime.creatorEngagementService.recordDeliverable(
        ctx,
        {
          organizationScopeId: harness.organizationScopeId,
          productionId: production.id,
          deliverableKey: "hero-video",
          format: "short_video",
          idempotencyKey: v1.deliverable.idempotencyKey,
        },
      );
      expect(replay.created).toBe(false);
      expect(replay.deliverable).toEqual(v1.deliverable);
      // Listing shows both keys with per-key monotonic versions.
      const all = await harness.runtime.creatorEngagementService.listDeliverables(
        ctx,
        harness.organizationScopeId,
        production.id,
      );
      expect(
        all
          .filter((d) => d.deliverableKey === "hero-video")
          .map((d) => d.version),
      ).toEqual([1, 2]);
      expect(
        all.filter((d) => d.deliverableKey === "still-images").length,
      ).toBe(1);
    } finally {
      await harness.teardown();
    }
  }, 60_000);

  test("concurrent deliverable recordings serialize — the version sequence never forks", async () => {
    const harness = await createNetW017Harness();
    try {
      const { engagement } = await createEngagement(harness);
      await tenderEngagement(harness, engagement.id, 0);
      const accepted = await acceptEngagement(harness, engagement.id, 1);
      const { production } = await openProduction(
        harness,
        accepted.engagement.id,
        2,
      );
      // 8 concurrent recordings with DISTINCT idempotency keys: the
      // advisory-lock anchor serializes them into versions 1..8 —
      // no duplicates, no gaps.
      const ctx = personCtx(harness, harness.creatorPersonId, "w017-concurrent");
      const results = await Promise.all(
        Array.from({ length: 8 }, (_, i) =>
          harness.runtime.creatorEngagementService.recordDeliverable(ctx, {
            organizationScopeId: harness.organizationScopeId,
            productionId: production.id,
            deliverableKey: "hero-video",
            format: "short_video",
            idempotencyKey: `w017-concurrent-${i}-${key("k")}`,
          }),
        ),
      );
      const versions = results
        .map((r) => r.deliverable.version)
        .sort((a, b) => a - b);
      expect(versions).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
    } finally {
      await harness.teardown();
    }
  }, 60_000);

  test("deliverables require an IN_PROGRESS engagement", async () => {
    const harness = await createNetW017Harness();
    try {
      const { engagement } = await createEngagement(harness);
      await tenderEngagement(harness, engagement.id, 0);
      const accepted = await acceptEngagement(harness, engagement.id, 1);
      // Open the production, then CANCEL the engagement: recording
      // further deliverables is refused (lifecycle discipline).
      const { production } = await openProduction(
        harness,
        accepted.engagement.id,
        2,
      );
      await harness.runtime.apiCommands.requestTransition(
        personCtx(harness, harness.operatorPersonId, "w017-cancel"),
        harness.operatorPersonId,
        {
          subjectId: accepted.engagement.id,
          subjectKind: "engagement",
          targetState: "CANCELLED",
          expectedVersion: 3,
          idempotencyKey: key("w017-cancel"),
          policyAction: "engagement.transition.in_progress_to_cancelled",
        },
      );
      await expect(
        recordDeliverable(harness, production.id),
      ).rejects.toBeInstanceOf(InvalidEngagementError);
    } finally {
      await harness.teardown();
    }
  }, 60_000);

  test("submission requires ≥1 deliverable version and ≥1 evidence reference", async () => {
    const harness = await createNetW017Harness();
    try {
      const { engagement } = await createEngagement(harness);
      await tenderEngagement(harness, engagement.id, 0);
      const accepted = await acceptEngagement(harness, engagement.id, 1);
      const { production, engagementVersion } = await openProduction(
        harness,
        accepted.engagement.id,
        2,
      );
      const ctx = personCtx(harness, harness.creatorPersonId, "w017-submit");
      // No deliverables yet.
      await expect(
        harness.runtime.creatorEngagementService.submitProduction(ctx, {
          organizationScopeId: harness.organizationScopeId,
          productionId: production.id,
          expectedVersion: engagementVersion,
          evidenceReferences: ["ev-anything"],
          idempotencyKey: key("w017-submit"),
        }),
      ).rejects.toBeInstanceOf(InvalidEngagementError);
      // Deliverable but NO evidence references.
      await recordDeliverable(harness, production.id);
      await expect(
        harness.runtime.creatorEngagementService.submitProduction(ctx, {
          organizationScopeId: harness.organizationScopeId,
          productionId: production.id,
          expectedVersion: engagementVersion,
          evidenceReferences: [],
          idempotencyKey: key("w017-submit"),
        }),
      ).rejects.toBeInstanceOf(InvalidEngagementError);
    } finally {
      await harness.teardown();
    }
  }, 60_000);

  test("the submission preserves the evidence + lineage + provenance (immutable record)", async () => {
    const harness = await createNetW017Harness();
    try {
      const { engagement } = await createEngagement(harness);
      await tenderEngagement(harness, engagement.id, 0);
      const accepted = await acceptEngagement(harness, engagement.id, 1);
      const { production, engagementVersion } = await openProduction(
        harness,
        accepted.engagement.id,
        2,
      );
      await recordDeliverable(harness, production.id);
      const { evidenceId } = await createProductionEvidence(
        harness,
        production.id,
      );
      const ctx = personCtx(harness, harness.creatorPersonId, "w017-submit");
      const result =
        await harness.runtime.creatorEngagementService.submitProduction(ctx, {
          organizationScopeId: harness.organizationScopeId,
          productionId: production.id,
          expectedVersion: engagementVersion,
          evidenceReferences: [evidenceId],
          idempotencyKey: key("w017-submit"),
        });
      const submission = result.submission;
      expect(submission.productionId).toBe(production.id);
      expect(submission.engagementId).toBe(accepted.engagement.id);
      expect(submission.evidenceReferences).toEqual([evidenceId]);
      expect(submission.deliverableCount).toBe(1);
      expect(submission.executionId).toBeTypeOf("string");
      expect(submission.correlationId).toBeTypeOf("string");
      // One submission per production.
      await expect(
        harness.runtime.creatorEngagementService.submitProduction(ctx, {
          organizationScopeId: harness.organizationScopeId,
          productionId: production.id,
          expectedVersion: engagementVersion + 1,
          evidenceReferences: [evidenceId],
          idempotencyKey: key("w017-submit-2"),
        }),
      ).rejects.toBeTruthy();
    } finally {
      await harness.teardown();
    }
  }, 60_000);

  test("a match-run lineage is verified at creation: only eligible candidates may become engagements", async () => {
    const harness = await createNetW017Harness();
    try {
      // Build a match run with one eligible + one excluded candidate.
      const { createMatchCandidate, runMatch, baselineRequirements } =
        await import("./_net-w016-harness.ts");
      const w016 = harness.w016;
      const eligible = await createMatchCandidate(w016, {});
      const excluded = await createMatchCandidate(w016, {
        acceptingWork: false,
        skipActivation: true,
      });
      const { run } = await runMatch(w016, {
        requirements: baselineRequirements(),
        candidateProfileIds: [eligible.profile.id, excluded.profile.id],
        idempotencyKey: key("w017-match"),
      });
      expect(run.results.some((r) => r.profileId === eligible.profile.id)).toBe(
        true,
      );
      expect(
        run.excluded.some((r) => r.profileId === excluded.profile.id),
      ).toBe(true);
      // The eligible candidate's engagement creation succeeds with
      // the match-run lineage pinned.
      const { engagement } = await createEngagement(harness, {
        matchRunId: run.id,
        creatorPersonId: eligible.personId,
      });
      expect(engagement.matchRunId).toBe(run.id);
      // The EXCLUDED candidate cannot claim the run's lineage.
      await expect(
        createEngagement(harness, {
          matchRunId: run.id,
          creatorPersonId: excluded.personId,
        }),
      ).rejects.toBeInstanceOf(Error);
    } finally {
      await harness.teardown();
    }
  }, 90_000);
});
