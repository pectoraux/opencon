/**
 * NET-W018-AC-05 — compensation remains a REFERENCE to /settlement;
 * no parallel economic state is introduced (issue #35 AC-05;
 * invariant 5).
 */

import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import {
  createNetW018Harness,
  createCommercialRelationship,
  createVerifiedEngagement,
  goldenPathSponsorship,
  key,
  operatorCtx,
  type NetW018Harness,
} from "./_net-w018-harness.ts";

const REPO = join(import.meta.dir, "../..");

let harness: NetW018Harness;

beforeAll(async () => {
  harness = await createNetW018Harness();
});

afterAll(async () => {
  await harness.teardown();
});

describe("NET-W018-AC-05 settlement reference only", () => {
  test("the relationship's compensation is DECLARED reference data (terms + reward-policy reference)", async () => {
    const relationship = await createCommercialRelationship(harness, {
      compensation: {
        format: "short_video",
        unit: "per_deliverable",
        amount: 1200,
        currency: "USD",
        rewardPolicyReference: "reward_policy:fixture-lineage:latest",
      },
    });
    expect(relationship.compensation).toEqual({
      format: "short_video",
      unit: "per_deliverable",
      amount: 1200,
      currency: "USD",
      rewardPolicyReference: "reward_policy:fixture-lineage:latest",
    });
    // The SAME shape as the engagement's declared terms (the W017
    // precedent) — a declaration, never an economic instruction.
    // A null compensation (non-monetary gifting) is equally valid.
    const verified = await createVerifiedEngagement(harness);
    const gifted = await createCommercialRelationship(harness, {
      engagementId: verified.engagementId,
      campaignId: verified.campaignId,
      kind: "gifted_product",
      compensation: null,
    });
    expect(gifted.compensation).toBeNull();
  });

  test("STRUCTURAL: the relationship record carries NO balance, posting, escrow or ledger field", async () => {
    const port = await readFile(join(REPO, "src/creators/port.ts"), "utf8");
    const block = port.slice(
      port.indexOf("export interface CommercialRelationship {"),
      port.indexOf("export interface DisclosureDeclaration {"),
    );
    for (const field of [
      "balance",
      "postedAmount",
      "escrow",
      "ledgerEntry",
      "stakeId",
      "committedAmount",
      "settledAmount",
      "paidAmount",
      "payment",
    ]) {
      expect(block).not.toMatch(new RegExp(`\\b${field}\\b`, "i"));
    }
    // The publication record carries none either.
    const pubBlock = port.slice(
      port.indexOf("export interface PublicationRecord extends LifecycleSubject {"),
      port.indexOf("// ---------------------------------------------------------------------------\n// NET-W018 inputs / results"),
    );
    for (const field of ["balance", "escrow", "ledgerEntry", "payout", "reward"]) {
      expect(pubBlock).not.toMatch(new RegExp(`\\b${field}\\b`, "i"));
    }
  });

  test("STRUCTURAL: the sponsorship service contains NO economic command and NO settlement dependency", async () => {
    const service = await readFile(
      join(REPO, "src/creators/sponsorship-service.ts"),
      "utf8",
    );
    // No economic mutation surface (the W017 out-of-scope vocabulary).
    expect(service).not.toMatch(/\bissueCredits?\b/i);
    expect(service).not.toMatch(/\bmatureEconomicValue\b/);
    expect(service).not.toMatch(/\ballocateRewards?\b/i);
    expect(service).not.toMatch(/\brecordCashObligation\b/);
    expect(service).not.toMatch(/\bpostLedgerTransaction\b/);
    expect(service).not.toMatch(/\bcreateStake\b/);
    expect(service).not.toMatch(/\bcommitStake\b/i);
    // No settlement port in the deps (imports/dependencies — the
    // authority-documentation comments may NAME /settlement).
    expect(service).not.toMatch(/from\s+["']\.\.\/settlement\//);
    expect(service).not.toMatch(/StakeService|RewardService|CreditService|CashService|LedgerService/);
    // The port's service interface exposes no economic command.
    const port = await readFile(join(REPO, "src/creators/port.ts"), "utf8");
    const iface = port.slice(
      port.indexOf("export interface CreatorSponsorshipService {"),
      port.indexOf("export interface CreatorSponsorshipServiceDeps {"),
    );
    expect(iface).not.toMatch(/\bissue|allocate|settle|pay|credit\b/i);
  });

  test("BEHAVIORAL: verifying a publication creates NO economic records (the settlement authority stays untouched)", async () => {
    const before = await countSettlementSideEffects();
    const golden = await goldenPathSponsorship(harness);
    expect(golden.verifiedPublication.state).toBe("VERIFIED");
    const after = await countSettlementSideEffects();
    // No stakes, no economic value records, no reward allocations, no
    // credit issuances, no cash obligations appeared for the
    // sponsorship flow's subjects.
    expect(after.stakes).toBe(before.stakes);
    expect(after.economicValue).toBe(before.economicValue);
    expect(after.rewardAllocations).toBe(before.rewardAllocations);
    expect(after.creditIssuances).toBe(before.creditIssuances);
    expect(after.cashObligations).toBe(before.cashObligations);
  });

  test("BEHAVIORAL: the sponsorship flow emits ONLY its own audit events (no economic event leaks)", async () => {
    const golden = await goldenPathSponsorship(harness);
    // Every audit event emitted for the flow's subjects belongs to
    // the W018 namespaces (relationship/declaration/publication +
    // the workflow transition) — no settlement/economic/reputation
    // event can appear.
    const economicEventTypes = [
      "stake.committed",
      "stake.released",
      "stake.forfeited",
      "economic_value.recorded",
      "economic_value.matured",
      "economic_value.reversed",
      "reward_allocation.recorded",
      "reward_allocation.reversed",
      "credit_issuance.issued",
      "credit_issuance.reversed",
    ];
    for (const eventType of economicEventTypes) {
      const events = await harness.runtime.auditWriter.query({ eventType });
      expect(
        events.filter(
          (e) =>
            e.metadata.organizationScopeId === harness.organizationScopeId,
        ),
      ).toHaveLength(0);
    }
    // And the flow's own events exist exactly once per subject.
    const verified = await harness.runtime.auditWriter.query({
      eventType: "publication.verified",
      resourceId: golden.verifiedPublication.id,
    });
    expect(verified).toHaveLength(1);
  });

  test("the compensation declaration obeys the shared economic bounds (validation only — no mutation)", async () => {
    const verified = await createVerifiedEngagement(harness);
    const ctx = operatorCtx(harness, "w018-ac05-bounds");
    // A negative amount is rejected (declared data still validates
    // through the SHARED economic bounds — the profile-domain
    // validator, code CREATOR_VALIDATION).
    await expect(
      harness.runtime.creatorSponsorshipService.createCommercialRelationship(
        ctx,
        {
          organizationScopeId: harness.organizationScopeId,
          engagementId: verified.engagementId,
          campaignId: verified.campaignId,
          sponsorPersonId: harness.operatorPersonId,
          kind: "sponsorship",
          disclosureObligations: [],
          compensation: {
            format: "short_video",
            unit: "per_deliverable",
            amount: -5,
            currency: "USD",
            rewardPolicyReference: null,
          },
          idempotencyKey: key("w018-ac05-negative"),
        },
      ),
    ).rejects.toMatchObject({ code: "CREATOR_VALIDATION" });
    // An unknown format/unit is rejected.
    await expect(
      harness.runtime.creatorSponsorshipService.createCommercialRelationship(
        ctx,
        {
          organizationScopeId: harness.organizationScopeId,
          engagementId: verified.engagementId,
          campaignId: verified.campaignId,
          sponsorPersonId: harness.operatorPersonId,
          kind: "sponsorship",
          disclosureObligations: [],
          compensation: {
            format: "hologram",
            unit: "per_deliverable",
            amount: 5,
            currency: "USD",
            rewardPolicyReference: null,
          },
          idempotencyKey: key("w018-ac05-format"),
        },
      ),
    ).rejects.toMatchObject({ code: "SPONSORSHIP_VALIDATION" });
  });
});

/** Count the settlement-side audit events the runtime can observe. */
async function countSettlementSideEffects(): Promise<{
  stakes: number;
  economicValue: number;
  rewardAllocations: number;
  creditIssuances: number;
  cashObligations: number;
}> {
  const runtime = harness.runtime;
  const count = async (eventType: string): Promise<number> => {
    const events = await runtime.auditWriter.query({ eventType });
    return events.filter(
      (e) => e.metadata.organizationScopeId === harness.organizationScopeId,
    ).length;
  };
  return {
    stakes:
      (await count("stake.committed")) +
      (await count("stake.released")) +
      (await count("stake.forfeited")),
    economicValue:
      (await count("economic_value.recorded")) +
      (await count("economic_value.matured")) +
      (await count("economic_value.reversed")),
    rewardAllocations:
      (await count("reward_allocation.recorded")) +
      (await count("reward_allocation.reversed")),
    creditIssuances:
      (await count("credit_issuance.issued")) +
      (await count("credit_issuance.reversed")),
    cashObligations: await count("cash_obligation.recorded"),
  };
}
