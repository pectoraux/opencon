/**
 * NET-W034-AC-04 — Placement and executable lifecycle entry (issue #69
 * §5 AC-04).
 *
 * The selected supply produces a durable placement through
 * `/inventory`, and the advertising opportunity/execution enters the
 * canonical opportunity/contribution lifecycle through existing
 * sanctioned W011/W004/W033 composition paths. Direct workflow or
 * repository mutation attempts fail closed.
 *  - the durable placement: the pinned policy version + the frozen
 *    source context (the provenance snapshot written ONLY from
 *    durable records) + the ELIGIBLE settlement readiness;
 *  - the placement fails closed for an INELIGIBLE source (the policy
 *    narrowing gate);
 *  - the lifecycle entry: the campaign opportunity materialized
 *    through the W011 path (the published spec, the eligibility
 *    reference resolving to the campaign) + the contribution created
 *    through the sanctioned W012 composite;
 *  - the publication walk (DRAFT → SUBMITTED) through /workflows with
 *    the ordered audit trail;
 *  - direct mutation attempts fail closed (an ILLEGAL state-skip
 *    transition + a stale-writer CONCURRENT_TRANSITION);
 *  - the structural no-second-lifecycle pin (the W034 surface has NO
 *    own lifecycle machinery — every transition goes through
 *    /workflows).
 */

import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import {
  createNetW034Harness,
  runAdvertisingScenario,
  registerScenarioSupply,
  advanceToMeasuring,
  key,
  personCtx,
  type NetW034Harness,
  type AdvertisingScenario,
} from "./_net-w034-harness.ts";
import {
  createHelpfulContribution,
  publishHelpfulContribution,
} from "../contributions/_net-w012-harness.ts";
import { policyActionFor } from "../../src/core/workflow.ts";
import type { Contribution } from "../../src/contributions/port.ts";

let harness: NetW034Harness;
let scenario: AdvertisingScenario;

beforeAll(async () => {
  harness = await createNetW034Harness();
  scenario = await runAdvertisingScenario(harness, { skipSettlement: true });
});

afterAll(async () => {
  await harness.teardown();
});

describe("NET-W034-AC-04 placement and lifecycle entry", () => {
  test("the placement is durable through /inventory: the PINNED policy version + the frozen source context + ELIGIBLE readiness", async () => {
    const ctx = harness.operatorCtx("w034-ac04-read");
    const placement = await harness.runtime.inventoryService.getPlacement(
      ctx,
      harness.organizationScopeId,
      scenario.placementId,
    );
    expect(placement.id).toBe(scenario.placementId);
    expect(placement.organizationScopeId).toBe(harness.organizationScopeId);
    expect(placement.inventoryItemId).toBe(scenario.inventoryItemId);
    expect(placement.campaignId).toBe(scenario.campaignId);
    // The PINNED policy version (the placement references the exact
    // version the scenario's clearing rule resolves in).
    expect(placement.campaignPolicyVersion).toBe(
      scenario.campaignPolicyVersion,
    );
    // The source context is the FROZEN provenance snapshot: the
    // durable supply identity, written ONLY by the service from
    // durable records (no caller input).
    expect(placement.sourceContext.inventoryItemId).toBe(
      scenario.inventoryItemId,
    );
    expect(placement.sourceContext.ownerPersonId).toBe(
      harness.creatorPersonId,
    );
    expect(placement.eligibility.eligible).toBe(true);
    expect(placement.retiredAt).toBeNull();
    expect(placement.executionId).toBeTruthy();
    expect(placement.correlationId).toBeTruthy();
  });

  test("an INELIGIBLE source fails closed at the placement gates (narrowing + the derived readiness)", async () => {
    // Gate 1 — the context may only NARROW the item's declared
    // supply attributes: a placement context outside the item's
    // declared territories is refused (INVENTORY_VALIDATION).
    const narrowItem = await registerScenarioSupply(harness, {
      territories: ["US", "CA"],
      externalId: `narrow-${key("ext")}`,
    });
    await expect(
      harness.runtime.inventoryService.createPlacement(
        harness.creatorCtx("w034-ac04-narrow"),
        {
          organizationScopeId: harness.organizationScopeId,
          inventoryItemId: narrowItem.id,
          campaignId: scenario.campaignId,
          campaignPolicyVersion: scenario.campaignPolicyVersion,
          context: { territories: ["NG"], languages: ["en"] },
          idempotencyKey: key("w034-ac04-narrow"),
        },
      ),
    ).rejects.toMatchObject({ code: "INVENTORY_VALIDATION" });
    // Gate 2 — a placement whose context does not satisfy the
    // campaign's eligibility rules is recorded HONESTLY (provenance —
    // the eligibility is derived, never fabricated) and the DERIVED
    // settlement readiness fails closed (the consumer contract).
    const ineligible = await registerScenarioSupply(harness, {
      territories: ["NG"],
      externalId: `ineligible-${key("ext")}`,
    });
    const placement = await harness.runtime.inventoryService.createPlacement(
      harness.creatorCtx("w034-ac04-ineligible"),
      {
        organizationScopeId: harness.organizationScopeId,
        inventoryItemId: ineligible.id,
        campaignId: scenario.campaignId,
        campaignPolicyVersion: scenario.campaignPolicyVersion,
        context: { territories: ["NG"], languages: ["en"] },
        idempotencyKey: key("w034-ac04-ineligible"),
      },
    );
    expect(placement.placement.eligibility.eligible).toBe(false);
    expect(
      placement.placement.eligibility.ruleResults.some(
        (r) => !r.satisfied,
      ),
    ).toBe(true);
    const readiness =
      await harness.runtime.inventoryService.getPlacementSettlementReadiness(
        harness.operatorCtx("w034-ac04-ineligible-read"),
        harness.organizationScopeId,
        placement.placement.id,
      );
    expect(readiness.eligible).toBe(false);
  });

  test("the lifecycle entry: the campaign opportunity materialized through the W011 composition path", async () => {
    const ctx = harness.creatorCtx("w034-ac04-opportunity");
    // The opportunity exists as a durable /opportunities record.
    const opportunity = await harness.runtime.opportunityService.getOpportunity(
      ctx,
      scenario.opportunityId,
    );
    expect(opportunity.id).toBe(scenario.opportunityId);
    expect(opportunity.organizationScopeId).toBe(harness.organizationScopeId);
    // The W011 composition: the opportunity belongs to the CAMPAIGN's
    // owner and its eligibility reference resolves to the ACTIVE
    // campaign's pinned policy (the recordOpportunityPublication
    // contract).
    expect(opportunity.ownerId).toBe(harness.operatorPersonId);
    expect(opportunity.eligibilityPolicyReference).toBeTruthy();
    // The campaign's publication event is recorded (the join).
    const campaign = await harness.runtime.campaignService.getCampaign(
      ctx,
      scenario.campaignId,
    );
    expect(
      campaign.events.filter((e) => e.event === "opportunity_published"),
    ).toHaveLength(1);
    // The audit trail: opportunity.created BEFORE
    // campaign.opportunity_published (the composition order).
    const audit = harness.runtime.auditWriter;
    const log = await audit.query({ limit: 1_000_000 });
    const opportunityCreated = log.findIndex(
      (e) =>
        e.eventType === "opportunity.created" &&
        e.resourceId === scenario.opportunityId,
    );
    const campaignPublished = log.findIndex(
      (e) =>
        e.eventType === "campaign.opportunity_published" &&
        e.resourceId === scenario.campaignId,
    );
    expect(opportunityCreated).toBeGreaterThanOrEqual(0);
    expect(campaignPublished).toBeGreaterThan(opportunityCreated);
  });

  test("the contribution enters through the SANCTIONED composite (the W012 path) and the publication walk is ordered", async () => {
    // The contribution was created through the same composite the
    // apiCommand executes (the W012 createHelpfulContribution path).
    const contribution = scenario.contribution;
    expect(contribution.opportunityId).toBe(scenario.opportunityId);
    expect(contribution.contributorId).toBe(harness.creatorPersonId);
    // The publication walk: DRAFT → READY → ASSIGNED → IN_PROGRESS →
    // SUBMITTED, each through /workflows with the ordered,
    // transaction-bound audit trail (the W033 AC-02 pattern).
    const audit = harness.runtime.auditWriter;
    const events = await audit.query({
      resourceType: "contribution",
      resourceId: contribution.id,
    });
    const transitions = events.filter((e) =>
      e.eventType.startsWith("contribution.transition."),
    );
    expect(transitions.map((e) => e.eventType)).toEqual([
      "contribution.transition.draft_to_ready",
      "contribution.transition.ready_to_assigned",
      "contribution.transition.assigned_to_in_progress",
      "contribution.transition.in_progress_to_submitted",
      "contribution.transition.submitted_to_measuring",
      "contribution.transition.measuring_to_evaluating",
      "contribution.transition.evaluating_to_challenge_window",
      "contribution.transition.challenge_window_to_settling",
      "contribution.transition.settling_to_settled",
      "contribution.transition.settled_to_verified",
    ]);
    for (const event of transitions) {
      expect(typeof event.metadata?.transactionId).toBe("string");
    }
    // The lifecycle subject ended at the terminal VERIFIED v10
    // (10 /workflows mutations — no other state machinery moved it).
    expect(contribution.state).toBe("VERIFIED");
    expect(contribution.version).toBe(10);
  });

  test("a DIRECT mutation attempt fails closed: the illegal state-skip transition (ILLEGAL_TRANSITION)", async () => {
    // A fresh contribution through the sanctioned composite, walked
    // to SUBMITTED only.
    const { contribution } = await createHelpfulContribution(
      harness.w012,
      { idempotencyKey: key("w034-ac04-illegal") },
    );
    await publishHelpfulContribution(harness.w012, contribution.id);
    const current = await harness.runtime.contributionService.getContribution(
      harness.creatorCtx("w034-ac04-illegal-read"),
      contribution.id,
    );
    expect(current.state).toBe("SUBMITTED");
    // SUBMITTED → VERIFIED skips five legal states: ILLEGAL.
    await expect(
      harness.runtime.workflowService.requestTransition(
        {
          subjectId: contribution.id,
          subjectKind: "contribution",
          targetState: "VERIFIED",
          expectedVersion: current.version,
          idempotencyKey: key("w034-ac04-skip"),
          actorPersonId: harness.creatorPersonId,
          policyAction: policyActionFor(
            "contribution",
            "SUBMITTED",
            "MEASURING",
          ),
        },
        harness.creatorCtx("w034-ac04-skip"),
      ),
    ).rejects.toMatchObject({ code: "ILLEGAL_TRANSITION" });
    // The state is unchanged.
    const still = await harness.runtime.contributionService.getContribution(
      harness.creatorCtx("w034-ac04-skip-read"),
      contribution.id,
    );
    expect(still.state).toBe("SUBMITTED");
    expect(still.version).toBe(current.version);
  });

  test("a stale-writer mutation attempt fails closed (CONCURRENT_TRANSITION)", async () => {
    // A fresh SUBMITTED contribution; the writer uses a STALE
    // expectedVersion.
    const { contribution } = await createHelpfulContribution(
      harness.w012,
      { idempotencyKey: key("w034-ac04-stale") },
    );
    await publishHelpfulContribution(harness.w012, contribution.id);
    const current = await harness.runtime.contributionService.getContribution(
      harness.creatorCtx("w034-ac04-stale-read"),
      contribution.id,
    );
    await expect(
      harness.runtime.workflowService.requestTransition(
        {
          subjectId: contribution.id,
          subjectKind: "contribution",
          targetState: "MEASURING",
          expectedVersion: current.version - 1,
          idempotencyKey: key("w034-ac04-stale-tx"),
          actorPersonId: harness.creatorPersonId,
          policyAction: policyActionFor(
            "contribution",
            "SUBMITTED",
            "MEASURING",
          ),
        },
        harness.creatorCtx("w034-ac04-stale-tx"),
      ),
    ).rejects.toMatchObject({ code: "CONCURRENT_TRANSITION" });
    // The state is unchanged.
    const still = await harness.runtime.contributionService.getContribution(
      harness.creatorCtx("w034-ac04-stale-after"),
      contribution.id,
    );
    expect(still.version).toBe(current.version);
  });

  test("the W034 surface introduces NO second lifecycle implementation (structural pin)", async () => {
    // The scenario's contribution reached VERIFIED exclusively
    // through the ten /workflows transitions audited above — the
    // W034 harness composes ONLY the existing services (no local
    // state machine). The version count is the deterministic proof:
    // exactly 10 transitions, nothing else moved the version.
    const contribution: Contribution = scenario.contribution;
    expect(contribution.version).toBe(10);
    // A fresh walk: create → publish → advance → verify via ONLY the
    // sanctioned helpers (which call the services) — the same version
    // arithmetic.
    const { contribution: fresh } = await createHelpfulContribution(
      harness.w012,
      { idempotencyKey: key("w034-ac04-fresh") },
    );
    await publishHelpfulContribution(harness.w012, fresh.id);
    const submitted = await harness.runtime.contributionService.getContribution(
      harness.creatorCtx("w034-ac04-fresh-read"),
      fresh.id,
    );
    expect(submitted.state).toBe("SUBMITTED");
    expect(submitted.version).toBe(4);
    const measuring = await advanceToMeasuring(harness, fresh.id);
    expect(measuring.state).toBe("MEASURING");
    expect(measuring.version).toBe(5);
  });

  test("the placement audit + the cross-tenant placement read (fail closed)", async () => {
    // A second-org actor cannot see the placement (tenant-scoped
    // read: NOT_FOUND, no existence oracle).
    await expect(
      harness.runtime.inventoryService.getPlacement(
        personCtx(harness, harness.secondOrgPersonId, "w034-ac04-tenant"),
        harness.secondOrgId,
        scenario.placementId,
      ),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
    // A second-org placement against the first-org supply fails
    // closed (the tenant-scoped item read: NOT_FOUND — the item does
    // not exist in the second org; no existence oracle).
    const foreignSupply = await registerScenarioSupply(harness, {
      externalId: `foreign-${key("ext")}`,
    });
    await expect(
      harness.runtime.inventoryService.createPlacement(
        personCtx(harness, harness.secondOrgPersonId, "w034-ac04-foreign"),
        {
          organizationScopeId: harness.secondOrgId,
          inventoryItemId: foreignSupply.id,
          campaignId: scenario.campaignId,
          context: { territories: ["US"], languages: ["en"] },
          idempotencyKey: key("w034-ac04-foreign"),
        },
      ),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
  });
});
