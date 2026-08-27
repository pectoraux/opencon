/**
 * NET-W014-AC-03 — campaign clearing rules drive deterministic reward
 * allocation through /settlement (SETTLE-001..003; issue #27
 * invariant 3).
 *
 * The clearing composite selects the EXISTING settlement primitive
 * the declared rule names, enforces the CAMP-005 basis + cap, and
 * records the draw as campaign bookkeeping. Conservation and
 * determinism come from the UNTOUCHED NET-W008 reward service.
 */
import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import {
  createNetW014Harness,
  createRecognizedMatureValue,
  createClearingCampaign,
  recognizeContributionValue,
  createVerifiedSettledContribution,
  matureValue,
  contributorCtx,
  personCtx,
  key,
  type NetW014Harness,
} from "./_net-w014-harness.ts";
import { activateReadyCampaign } from "../campaigns/_net-w011-harness.ts";
import type { RewardAllocation } from "../../src/settlement/port.ts";

let harness: NetW014Harness;

beforeAll(async () => {
  harness = await createNetW014Harness();
});

afterAll(async () => {
  await harness.teardown();
});

/** The clearing composite exactly as the apiCommand runs it. */
async function clear(
  campaignId: string,
  valueRecordId: string,
  opts: {
    readonly clearingRuleId?: string;
    readonly creditsPerValueUnit?: number;
    readonly cashKind?: string;
    readonly counterpartyPersonId?: string;
    readonly cashAmount?: number;
    readonly idempotencyKey?: string;
  } = {},
): Promise<Record<string, unknown>> {
  return harness.runtime.apiCommands.executeCampaignClearing(
    contributorCtx(harness, "w014-clear"),
    harness.contributorPersonId,
    {
      campaignId,
      valueRecordId,
      ...(opts.clearingRuleId !== undefined
        ? { clearingRuleId: opts.clearingRuleId }
        : {}),
      ...(opts.creditsPerValueUnit !== undefined
        ? { creditsPerValueUnit: opts.creditsPerValueUnit }
        : {}),
      ...(opts.cashKind !== undefined ? { cashKind: opts.cashKind } : {}),
      ...(opts.counterpartyPersonId !== undefined
        ? { counterpartyPersonId: opts.counterpartyPersonId }
        : {}),
      ...(opts.cashAmount !== undefined
        ? { cashAmount: opts.cashAmount }
        : {}),
      idempotencyKey: opts.idempotencyKey ?? key("w014-clear"),
    },
  );
}

describe("NET-W014-AC-03 campaign clearing drives deterministic reward allocation", () => {
  test("the declared reward_allocation rule draws through the canonical settlement primitive (conserved, idempotent, recorded)", async () => {
    const { value, contribution } = await createRecognizedMatureValue(harness, {
      withMeasuredOutcomeBasis: true,
      amount: 200,
    });
    const campaign = await createClearingCampaign(harness);
    const result = await clear(campaign.id, value.id);
    expect(result.drawKind).toBe("reward_allocation");
    const allocation = result.allocation as unknown as RewardAllocation;
    // The rule's reward policy (weight 1 → the campaign owner, i.e.
    // the contributor in the harness chain): the WHOLE mature amount,
    // conserved exactly.
    expect(allocation.totalAllocated).toBe(200);
    expect(
      allocation.shares.reduce((sum, s) => sum + s.amount, 0),
    ).toBe(200);
    expect(allocation.sourceValueRecordId).toBe(value.id);
    // The value record is CONSUMED by exactly this allocation.
    expect(result.created).toBe(true);
    const consumed = result.value as { state: string; consumedBy: { kind: string; id: string } };
    expect(consumed.state).toBe("CONSUMED");
    expect(consumed.consumedBy.kind).toBe("reward_allocation");
    expect(consumed.consumedBy.id).toBe(allocation.id);
    // The campaign bookkeeping event (references only).
    const campaignAfter = await harness.runtime.campaignService.getCampaign(
      contributorCtx(harness, "w014-clear-read"),
      campaign.id,
    );
    const clearingEvents = campaignAfter.events.filter(
      (e) => e.event === "clearing_executed",
    );
    expect(clearingEvents.length).toBe(1);
    expect(clearingEvents[0]!.details).toMatchObject({
      clearingRuleId: "clear-1",
      drawKind: "reward_allocation",
      valueRecordId: value.id,
      resultId: allocation.id,
      amount: 200,
    });
    void contribution;
  });

  test("clearing replays idempotently (the compound keys replay the allocation + bookkeeping)", async () => {
    const { value } = await createRecognizedMatureValue(harness, {
      withMeasuredOutcomeBasis: true,
      amount: 60,
    });
    const campaign = await createClearingCampaign(harness);
    const idem = key("w014-clear-idem");
    const first = await clear(campaign.id, value.id, { idempotencyKey: idem });
    const replay = await clear(campaign.id, value.id, { idempotencyKey: idem });
    expect(replay.created).toBe(false);
    expect(
      (replay.allocation as unknown as RewardAllocation).id,
    ).toBe((first.allocation as unknown as RewardAllocation).id);
    // The campaign carries exactly ONE clearing event for this key.
    const campaignAfter = await harness.runtime.campaignService.getCampaign(
      contributorCtx(harness, "w014-clear-read"),
      campaign.id,
    );
    expect(
      campaignAfter.events.filter((e) => e.event === "clearing_executed")
        .length,
    ).toBe(1);
  });

  test("the CAMP-005 hard cap is enforced (amount above maxDrawAmount is refused)", async () => {
    const { value } = await createRecognizedMatureValue(harness, {
      withMeasuredOutcomeBasis: true,
      amount: 500,
    });
    // A campaign whose single clearing rule caps draws at 100.
    const campaign = await activateReadyCampaign(harness.w011, {
      totalAmount: 100,
    });
    await expect(clear(campaign.id, value.id)).rejects.toMatchObject({
      code: "ECONOMIC_VALIDATION",
      context: expect.objectContaining({
        amount: 500,
        maxDrawAmount: 100,
      }),
    });
  });

  test("the declared BASIS is enforced (attributed_outcome requires a measured-outcome source)", async () => {
    // A value record WITHOUT a measured-outcome basis (only evidence).
    const { value } = await createRecognizedMatureValue(harness, {
      amount: 80,
    });
    const campaign = await createClearingCampaign(harness);
    await expect(clear(campaign.id, value.id)).rejects.toMatchObject({
      code: "ECONOMIC_VALIDATION",
      context: expect.objectContaining({
        basis: "attributed_outcome",
      }),
    });
  });

  test("only MATURE value may be cleared (PENDING is refused)", async () => {
    const { contribution } = await createVerifiedSettledContribution(harness, {
      withMeasuredOutcomeBasis: true,
    });
    const recognized = await recognizeContributionValue(harness, contribution.id, {
      amount: 50,
    });
    const campaign = await createClearingCampaign(harness);
    await expect(clear(campaign.id, recognized.value.id)).rejects.toMatchObject({
      code: "ECONOMIC_VALIDATION",
      context: expect.objectContaining({ state: "PENDING" }),
    });
  });

  test("a cross-scope value record is refused (tenant isolation at the clearing boundary)", async () => {
    // A MATURE value record in the HARNESS org; a campaign in the
    // SECOND org. The composite checks the value record's scope
    // FIRST (the authoritative tenant-isolation boundary) — the
    // refusal fires before any campaign status logic.
    const { value } = await createRecognizedMatureValue(harness, {
      withMeasuredOutcomeBasis: true,
      amount: 50,
    });
    const secondOrgCampaign =
      await harness.runtime.campaignService.createCampaign(
        personCtx(harness, harness.secondOrgPersonId, "w014-foreign-campaign"),
        {
          organizationScopeId: harness.secondOrgId,
          name: "Foreign Campaign",
          idempotencyKey: key("w014-foreign-campaign"),
        },
      );
    await expect(
      clear(secondOrgCampaign.campaign.id, value.id),
    ).rejects.toMatchObject({
      code: "ECONOMIC_VALIDATION",
      context: expect.objectContaining({
        valueScope: harness.organizationScopeId,
        campaignScope: harness.secondOrgId,
      }),
    });
  });

  test("a credit_issuance rule draws credits through the canonical issuance (ECON-003; lock invariant 20)", async () => {
    // Credit issuance requires a VERIFIED Proof-of-Value reference
    // (architecture-lock invariant 20) — the fixture carries a PoV
    // basis so the recognized value record's sources include one.
    const { value } = await createRecognizedMatureValue(harness, {
      withMeasuredOutcomeBasis: true,
      withProofOfValueBasis: true,
      amount: 40,
    });
    const campaign = await activateReadyCampaign(harness.w011, {
      totalAmount: 1000,
      clearingDrawKind: "credit_issuance",
    });
    const result = await clear(campaign.id, value.id, {
      creditsPerValueUnit: 2,
    });
    expect(result.drawKind).toBe("credit_issuance");
    const issuance = result.issuance as {
      creditAmount: number;
      sourceValueRecordId: string;
    };
    expect(issuance.creditAmount).toBe(80);
    expect(issuance.sourceValueRecordId).toBe(value.id);
    expect((result.value as { state: string }).state).toBe("CONSUMED");
  });

  test("a credit draw on a value record with NO PoV source is refused by the settlement authority (lock invariant 20 holds through clearing)", async () => {
    const { value } = await createRecognizedMatureValue(harness, {
      withMeasuredOutcomeBasis: true,
      amount: 40,
    });
    const campaign = await activateReadyCampaign(harness.w011, {
      totalAmount: 1000,
      clearingDrawKind: "credit_issuance",
    });
    await expect(
      clear(campaign.id, value.id, { creditsPerValueUnit: 1 }),
    ).rejects.toThrow(/requires a VERIFIED Proof-of-Value reference/i);
  });

  test("a cash_obligation rule records an internal obligation (NO payment execution)", async () => {
    const { value } = await createRecognizedMatureValue(harness, {
      withMeasuredOutcomeBasis: true,
      amount: 40,
    });
    const campaign = await activateReadyCampaign(harness.w011, {
      totalAmount: 1000,
      clearingDrawKind: "cash_obligation",
    });
    const result = await clear(campaign.id, value.id, {
      cashKind: "payable",
      counterpartyPersonId: harness.moderatorPersonId,
      cashAmount: 25,
    });
    expect(result.drawKind).toBe("cash_obligation");
    const obligation = result.obligation as {
      kind: string;
      amount: number;
      counterpartyPersonId: string;
      status: string;
    };
    expect(obligation.kind).toBe("payable");
    expect(obligation.amount).toBe(25);
    expect(obligation.counterpartyPersonId).toBe(harness.moderatorPersonId);
    // Internal state only — the obligation is freshly recognized
    // (no payment execution happened anywhere).
    expect(obligation.status).toBe("recognized");
    // Cash draws do NOT consume the value record (obligations are
    // standalone primitives in NET-W008).
    expect((result.value as { state: string }).state).toBe("MATURE");
  });

  test("a cash draw above the rule cap is refused", async () => {
    const { value } = await createRecognizedMatureValue(harness, {
      withMeasuredOutcomeBasis: true,
      amount: 40,
    });
    const campaign = await activateReadyCampaign(harness.w011, {
      totalAmount: 100,
      clearingDrawKind: "cash_obligation",
    });
    await expect(
      clear(campaign.id, value.id, {
        cashKind: "payable",
        counterpartyPersonId: harness.moderatorPersonId,
        cashAmount: 200,
      }),
    ).rejects.toMatchObject({ code: "ECONOMIC_VALIDATION" });
  });

  test("a NON-ACTIVE campaign cannot clear (paused is refused)", async () => {
    const { value } = await createRecognizedMatureValue(harness, {
      withMeasuredOutcomeBasis: true,
      amount: 40,
    });
    const campaign = await createClearingCampaign(harness);
    const paused = await harness.runtime.campaignService.pauseCampaign(
      contributorCtx(harness, "w014-pause"),
      { campaignId: campaign.id, idempotencyKey: key("w014-pause") },
    );
    expect(paused.status).toBe("PAUSED");
    await expect(clear(campaign.id, value.id)).rejects.toMatchObject({
      code: "CAMPAIGN_VALIDATION",
    });
    // Resume → clearing succeeds (the gate is status-driven).
    await harness.runtime.campaignService.resumeCampaign(
      contributorCtx(harness, "w014-resume"),
      { campaignId: campaign.id, idempotencyKey: key("w014-resume") },
    );
    const result = await clear(campaign.id, value.id);
    expect(result.drawKind).toBe("reward_allocation");
  });

  test("a MATURE value record can be drawn exactly once through consumption (reward path)", async () => {
    const { value } = await createRecognizedMatureValue(harness, {
      withMeasuredOutcomeBasis: true,
      amount: 30,
    });
    const campaign = await createClearingCampaign(harness);
    await clear(campaign.id, value.id);
    // The record is CONSUMED — a second (differently-keyed) clearing
    // draw on the same record is refused by the settlement
    // authority's consume-only-MATURE bar.
    await expect(clear(campaign.id, value.id)).rejects.toMatchObject({
      code: "ECONOMIC_VALIDATION",
      context: expect.objectContaining({ state: "CONSUMED" }),
    });
  });

  test("the deterministic maturation gate still applies (fixed_window before window end is refused)", async () => {
    const { contribution } = await createVerifiedSettledContribution(harness, {
      withMeasuredOutcomeBasis: true,
    });
    const recognized = await recognizeContributionValue(harness, contribution.id, {
      amount: 50,
      maturation: {
        strategy: "fixed_window",
        windowEndAt: "2099-01-01T00:00:00.000Z",
      },
    });
    await expect(
      matureValue(harness, recognized.value.id),
    ).rejects.toThrow(/window/i);
  });
});
