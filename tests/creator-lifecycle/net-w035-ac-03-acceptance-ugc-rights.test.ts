/**
 * NET-W035-AC-03 — Creator acceptance and UGC production (issue #71
 * §5 AC-03; work order §4.3).
 *
 * The creator engagement enters the existing sanctioned
 * opportunity/contribution lifecycle. W017 creates a durable UGC
 * reference and explicit usage-rights terms. Rights are scoped to the
 * intended campaign/engagement and are not implied by creator
 * acceptance or artifact existence.
 */

import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import {
  createNetW035Harness,
  runCreatorScenario,
  createCreatorCampaign,
  key,
  personCtx,
  W035_RIGHTS_STARTS_AT,
  W035_RIGHTS_REQUESTED_ENDS_AT,
  W035_RIGHTS_GRANTED_ENDS_AT,
  W035_RIGHTS_EVALUATION_AS_OF,
  W035_RIGHTS_EXPIRED_AS_OF,
  W035_EVIDENCE_CAPTURED_AT,
  type NetW035Harness,
  type CreatorScenario,
} from "./_net-w035-harness.ts";

let harness: NetW035Harness;
let scenario: CreatorScenario;

beforeAll(async () => {
  harness = await createNetW035Harness();
  scenario = await runCreatorScenario(harness, { skipSettlement: true });
});

afterAll(async () => {
  await harness.teardown();
});

describe("NET-W035-AC-03 creator acceptance and UGC production", () => {
  test("the acceptance composite commits the usage-rights grant + the ASSIGNED transition as ONE authoritative unit", async () => {
    const ctx = harness.operatorCtx("w035-ac03-accept");
    // The grant exists, scoped to the engagement, with the frozen
    // creator-retained ownership.
    const rightsView = await harness.runtime.creatorEngagementService.getUsageRights(
      ctx,
      harness.organizationScopeId,
      scenario.usageRightsGrantId,
      // FIXED evaluation anchor INSIDE the granted window (§3.1).
      W035_RIGHTS_EVALUATION_AS_OF,
    );
    expect(rightsView.effectiveStatus).toBe("ACTIVE");
    expect(rightsView.grant.engagementId).toBe(scenario.engagement.id);
    expect(rightsView.grant.grantorPersonId).toBe(harness.creatorPersonId);
    expect(rightsView.grant.contentOwnership).toBe("creator_retained");
    // The granted envelope is WITHIN the requested one (the explicit
    // scope: channel/territory/format subsets).
    expect(rightsView.grant.uses.map((u) => u.kind)).toEqual([
      "channel_publication",
    ]);
    expect(rightsView.grant.channels).toEqual(["creator_owned_channel"]);
    expect(rightsView.grant.territories).toEqual(["GH"]);
    // The engagement reached ASSIGNED through the composite (now
    // VERIFIED after the full walk — the audit trail proves the
    // ready_to_assigned transition arrived in the SAME transaction as
    // the grant).
    const grantEvents = await harness.runtime.auditWriter.query({
      resourceType: "usage_rights_grant",
      resourceId: scenario.usageRightsGrantId,
    });
    expect(grantEvents.map((e) => e.eventType)).toContain(
      "usage_rights.granted",
    );
    const transitionEvents = (
      await harness.runtime.auditWriter.query({
        resourceType: "engagement",
        resourceId: scenario.engagement.id,
      })
    ).filter(
      (e) => e.eventType === "engagement.transition.ready_to_assigned",
    );
    expect(transitionEvents).toHaveLength(1);
    expect(transitionEvents[0]!.metadata.transactionId).toBe(
      grantEvents[0]!.metadata.transactionId,
    );
  });

  test("rights are NOT implied by acceptance or artifact existence (the derived lifecycle)", async () => {
    const ctx = harness.operatorCtx("w035-ac03-derived");
    // EXPIRED: the derived status evaluated AFTER the fixed grant window.
    const expiredView =
      await harness.runtime.creatorEngagementService.getUsageRights(
        ctx,
        harness.organizationScopeId,
        scenario.usageRightsGrantId,
        // FIXED evaluation anchor after every rights window (§3.1 —
        // never Date.now() + offset).
        W035_RIGHTS_EXPIRED_AS_OF,
      );
    expect(expiredView.effectiveStatus).toBe("EXPIRED");
    // REVOKED: the one-way revocation flips the derived status.
    const revoked = await harness.runtime.creatorEngagementService.revokeUsageRights(
      harness.creatorCtx("w035-ac03-revoke"),
      {
        organizationScopeId: harness.organizationScopeId,
        grantId: scenario.usageRightsGrantId,
        reason: "the W035 AC-03 revocation fixture",
        idempotencyKey: key("w035-ac03-revoke"),
      } as never,
    );
    expect(revoked.created).toBe(true);
    expect(revoked.view.effectiveStatus).toBe("REVOKED");
    const revokedView = await harness.runtime.creatorEngagementService.getUsageRights(
      ctx,
      harness.organizationScopeId,
      scenario.usageRightsGrantId,
      // FIXED evaluation anchor (§3.1): after the fixed window AND
      // after the recorded revocation's effectiveAt — REVOKED takes
      // precedence over EXPIRED.
      W035_RIGHTS_EXPIRED_AS_OF,
    );
    expect(revokedView.effectiveStatus).toBe("REVOKED");
  });

  test("the UGC production binds the contribution (the engagement → production → contribution lineage) + the durable deliverable", async () => {
    const ctx = harness.creatorCtx("w035-ac03-production");
    const production = await harness.runtime.creatorEngagementService.getProduction(
      ctx,
      harness.organizationScopeId,
      scenario.production.id,
    );
    expect(production.engagementId).toBe(scenario.engagement.id);
    expect(production.contributionId).toBe(scenario.contribution.id);
    expect(production.creatorPersonId).toBe(harness.creatorPersonId);
    // The durable deliverable: the content reference + the external
    // platform reference (provider-neutral).
    const deliverables =
      await harness.runtime.creatorEngagementService.listDeliverables(
        ctx,
        harness.organizationScopeId,
        scenario.production.id,
      );
    expect(deliverables.length).toBeGreaterThanOrEqual(1);
    const hero = deliverables.find(
      (d) => d.id === scenario.deliverableId,
    );
    expect(hero).toBeDefined();
    expect(hero!.contentReference).toContain("object-store://w035/");
    expect(hero!.externalPlatform!.provider).toBe("example-platform");
  });

  test("publication requires the engagement to be VERIFIED (produced UGC never implies publication authorization)", async () => {
    // A FRESH engagement on a fresh campaign, walked to SUBMITTED with
    // its OWN production + deliverable + subject-bound evidence — the
    // ONLY remaining precondition is the engagement's VERIFIED state,
    // so the fail-closed proof isolates exactly that gate (produced
    // UGC never implies publication authorization).
    const { campaign } = await createCreatorCampaign(harness);
    const offer = await harness.runtime.creatorEngagementService.createEngagement(
      harness.operatorCtx("w035-ac03-fresh-offer"),
      {
        organizationScopeId: harness.organizationScopeId,
        creatorPersonId: harness.creatorPersonId,
        campaignId: campaign.id,
        matchRunId: null,
        opportunityId: null,
        requestedRights: {
          uses: [{ kind: "channel_publication", terms: null }],
          channels: ["creator_owned_channel"],
          territories: ["GH"],
          formats: ["short_video"],
          // FIXED deterministic anchors (§3.1 — never Date.now()).
          startsAt: W035_RIGHTS_STARTS_AT,
          endsAt: W035_RIGHTS_REQUESTED_ENDS_AT,
          exclusions: [],
        },
        compensation: null,
        brief: null,
        idempotencyKey: key("w035-ac03-fresh-offer"),
      } as never,
    );
    await harness.runtime.apiCommands.requestTransition(
      harness.operatorCtx("w035-ac03-fresh-tender"),
      harness.operatorPersonId,
      {
        subjectId: offer.engagement.id,
        subjectKind: "engagement",
        targetState: "READY",
        expectedVersion: offer.engagement.version,
        idempotencyKey: key("w035-ac03-fresh-tender"),
        policyAction: "engagement.transition.draft_to_ready",
      },
    );
    const accepted = await harness.runtime.creatorEngagementService.acceptEngagement(
      harness.creatorCtx("w035-ac03-fresh-accept"),
      {
        organizationScopeId: harness.organizationScopeId,
        engagementId: offer.engagement.id,
        expectedVersion: 1,
        grantedRights: {
          uses: [{ kind: "channel_publication", terms: null }],
          channels: ["creator_owned_channel"],
          territories: ["GH"],
          formats: ["short_video"],
          // FIXED deterministic anchors (§3.1 — the granted window
          // sits strictly within the requested envelope).
          startsAt: W035_RIGHTS_STARTS_AT,
          endsAt: W035_RIGHTS_GRANTED_ENDS_AT,
          exclusions: [],
        },
        idempotencyKey: key("w035-ac03-fresh-accept"),
      } as never,
    );
    // The engagement's OWN production + deliverable + subject-bound
    // evidence, submitted (the engagement reaches SUBMITTED — the
    // production is complete but the engagement is NOT verified).
    const opened = await harness.runtime.creatorEngagementService.openProduction(
      harness.creatorCtx("w035-ac03-fresh-production"),
      {
        organizationScopeId: harness.organizationScopeId,
        engagementId: accepted.engagement.id,
        expectedVersion: accepted.engagement.version,
        contributionId: null,
        idempotencyKey: key("w035-ac03-fresh-production"),
      } as never,
    );
    await harness.runtime.creatorEngagementService.recordDeliverable(
      harness.creatorCtx("w035-ac03-fresh-deliverable"),
      {
        organizationScopeId: harness.organizationScopeId,
        productionId: opened.production.id,
        deliverableKey: "hero-video",
        format: "short_video",
        title: "Hero video",
        contentReference: "object-store://w035/ac03-hero",
        externalPlatform: null,
        notes: null,
        idempotencyKey: key("w035-ac03-fresh-deliverable"),
      } as never,
    );
    const evidence = await harness.runtime.evidenceService.createEvidence(
      harness.creatorCtx("w035-ac03-fresh-evidence"),
      {
        organizationScopeId: harness.organizationScopeId,
        ownerId: harness.creatorPersonId,
        subjectReference: {
          subjectType: "ugc_production",
          subjectId: opened.production.id,
        },
        provenance: {
          sourceType: "platform",
          sourceId: "example-platform",
          method: "w035 fixture production capture",
          // FIXED deterministic anchor (§3.1 — never wall-clock).
          collectedAt: W035_EVIDENCE_CAPTURED_AT,
          collectorId: harness.creatorPersonId,
        },
        confidence: { point: 0.9, lower: 0.8, upper: 0.95 },
        sensitivity: "standard",
        payload: {
          kind: "ugc_production_capture",
          productionId: opened.production.id,
        },
      },
    );
    await harness.runtime.creatorEngagementService.submitProduction(
      harness.creatorCtx("w035-ac03-fresh-submit"),
      {
        organizationScopeId: harness.organizationScopeId,
        productionId: opened.production.id,
        expectedVersion: opened.transition.subject.version,
        evidenceReferences: [evidence.id],
        idempotencyKey: key("w035-ac03-fresh-submit"),
      } as never,
    );
    // The engagement is only SUBMITTED — the publication fails closed
    // on the engagement state (the production itself is complete).
    const engagement = await harness.runtime.creatorEngagementService.getEngagement(
      harness.operatorCtx("w035-ac03-fresh-state"),
      harness.organizationScopeId,
      accepted.engagement.id,
    );
    expect(engagement.state).toBe("SUBMITTED");
    await expect(
      harness.runtime.creatorSponsorshipService.createPublication(
        harness.creatorCtx("w035-ac03-fresh-publication"),
        {
          organizationScopeId: harness.organizationScopeId,
          engagementId: accepted.engagement.id,
          productionId: opened.production.id,
          channel: {
            kind: "creator_owned_channel",
            externalPlatform: {
              provider: "example-platform",
              externalId: key("w035-ac03-fresh-pub"),
              url: "https://example.com/w035-ac03",
            },
          },
          idempotencyKey: key("w035-ac03-fresh-publication"),
        } as never,
      ),
    ).rejects.toMatchObject({ code: "SPONSORSHIP_VALIDATION" });
  });

  test("the UGC submission requires SUBJECT-BOUND canonical evidence (a foreign-bound reference fails closed)", async () => {
    // A fresh production on the scenario engagement is impossible (the
    // production already exists — one per engagement); build the
    // fixture on a fresh engagement instead, then submit with evidence
    // bound to the SCENARIO production (a foreign subject).
    const { campaign } = await createCreatorCampaign(harness);
    const offer = await harness.runtime.creatorEngagementService.createEngagement(
      harness.operatorCtx("w035-ac03-evidence-offer"),
      {
        organizationScopeId: harness.organizationScopeId,
        creatorPersonId: harness.creatorPersonId,
        campaignId: campaign.id,
        matchRunId: null,
        opportunityId: null,
        requestedRights: {
          uses: [{ kind: "channel_publication", terms: null }],
          channels: ["creator_owned_channel"],
          territories: ["GH"],
          formats: ["short_video"],
          // FIXED deterministic anchors (§3.1 — never Date.now()).
          startsAt: W035_RIGHTS_STARTS_AT,
          endsAt: W035_RIGHTS_REQUESTED_ENDS_AT,
          exclusions: [],
        },
        compensation: null,
        brief: null,
        idempotencyKey: key("w035-ac03-evidence-offer"),
      } as never,
    );
    await harness.runtime.apiCommands.requestTransition(
      harness.operatorCtx("w035-ac03-evidence-tender"),
      harness.operatorPersonId,
      {
        subjectId: offer.engagement.id,
        subjectKind: "engagement",
        targetState: "READY",
        expectedVersion: offer.engagement.version,
        idempotencyKey: key("w035-ac03-evidence-tender"),
        policyAction: "engagement.transition.draft_to_ready",
      },
    );
    const accepted = await harness.runtime.creatorEngagementService.acceptEngagement(
      harness.creatorCtx("w035-ac03-evidence-accept"),
      {
        organizationScopeId: harness.organizationScopeId,
        engagementId: offer.engagement.id,
        expectedVersion: 1,
        grantedRights: {
          uses: [{ kind: "channel_publication", terms: null }],
          channels: ["creator_owned_channel"],
          territories: ["GH"],
          formats: ["short_video"],
          // FIXED deterministic anchors (§3.1 — the granted window
          // sits strictly within the requested envelope).
          startsAt: W035_RIGHTS_STARTS_AT,
          endsAt: W035_RIGHTS_GRANTED_ENDS_AT,
          exclusions: [],
        },
        idempotencyKey: key("w035-ac03-evidence-accept"),
      } as never,
    );
    const opened = await harness.runtime.creatorEngagementService.openProduction(
      harness.creatorCtx("w035-ac03-evidence-production"),
      {
        organizationScopeId: harness.organizationScopeId,
        engagementId: accepted.engagement.id,
        expectedVersion: accepted.engagement.version,
        contributionId: null,
        idempotencyKey: key("w035-ac03-evidence-production"),
      } as never,
    );
    await harness.runtime.creatorEngagementService.recordDeliverable(
      harness.creatorCtx("w035-ac03-evidence-deliverable"),
      {
        organizationScopeId: harness.organizationScopeId,
        productionId: opened.production.id,
        deliverableKey: "fixture-video",
        format: "short_video",
        title: "Fixture",
        contentReference: "object-store://w035/fixture",
        externalPlatform: null,
        notes: null,
        idempotencyKey: key("w035-ac03-evidence-deliverable"),
      } as never,
    );
    // The submission citing the SCENARIO production's evidence (a
    // foreign subject id) fails closed — evidence must be subject
    // bound to THIS production.
    await expect(
      harness.runtime.creatorEngagementService.submitProduction(
        harness.creatorCtx("w035-ac03-evidence-submit"),
        {
          organizationScopeId: harness.organizationScopeId,
          productionId: opened.production.id,
          expectedVersion: opened.transition.subject.version,
          evidenceReferences: [scenario.productionEvidenceId],
          idempotencyKey: key("w035-ac03-evidence-submit"),
        } as never,
      ),
    ).rejects.toMatchObject({ code: "ENGAGEMENT_VALIDATION" });
  });

  test("the contribution entry is the ONLY lifecycle vehicle (no parallel creator state machine — the structural pin)", async () => {
    // The scenario's execution subject is a CONTRIBUTION (the W012
    // composite's subject) walking the CANONICAL states; the
    // engagement is an W017 subject walking its own table — both under
    // /workflows (the sole lifecycle authority). The creators module
    // owns no lifecycle machinery of its own: the engagement subject
    // kind is administered by the workflow authority.
    const contribution = await harness.runtime.contributionService.getContribution(
      harness.creatorCtx("w035-ac03-structural"),
      scenario.contribution.id,
    );
    expect(contribution.state).toBe("VERIFIED");
    expect(contribution.opportunityId).toBe(scenario.opportunityId);
    const engagement = await harness.runtime.creatorEngagementService.getEngagement(
      harness.operatorCtx("w035-ac03-structural-engagement"),
      harness.organizationScopeId,
      scenario.engagement.id,
    );
    expect(engagement.state).toBe("VERIFIED");
    // The two subjects are DISTINCT durable records bound by the
    // production lineage (engagement → production → contribution).
    expect(engagement.id).not.toBe(contribution.id);
    const production = await harness.runtime.creatorEngagementService.getProduction(
      harness.creatorCtx("w035-ac03-structural-production"),
      harness.organizationScopeId,
      scenario.production.id,
    );
    expect(production.engagementId).toBe(engagement.id);
    expect(production.contributionId).toBe(contribution.id);
  });
});
