/**
 * NET-W014-AC-06 — cash/credit separation and external-payment
 * boundaries remain intact (issue #27 invariants 5/6; ECON-004/005).
 *
 * The integration layer introduces NO conversion between cash and
 * credits, NO implicit 1:1 exchange, and NO external payment
 * execution: cash draws record internal payable/receivable state
 * only, credit draws go through the PoV-gated issuance, and the
 * /payments boundary remains skeletal and unimported (NET-W030).
 */
import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { readFile } from "node:fs/promises";
import {
  createNetW014Harness,
  createRecognizedMatureValue,
  createClearingCampaign,
  contributorCtx,
  key,
  type NetW014Harness,
} from "./_net-w014-harness.ts";
import { activateReadyCampaign } from "../campaigns/_net-w011-harness.ts";

let harness: NetW014Harness;

beforeAll(async () => {
  harness = await createNetW014Harness();
});

afterAll(async () => {
  await harness.teardown();
});

describe("NET-W014-AC-06 cash/credit separation + external-payment boundary", () => {
  test("a cash draw and a credit draw NEVER convert: the obligation is denominated in cash, the issuance in credits, with no linkage", async () => {
    // One mature value record funds a CREDIT draw; a separate mature
    // value record backs a CASH draw. The two settlement records are
    // distinct primitives with distinct units and no cross-reference.
    const { value: forCredits } = await createRecognizedMatureValue(harness, {
      withMeasuredOutcomeBasis: true,
      withProofOfValueBasis: true,
      amount: 50,
    });
    const creditCampaign = await activateReadyCampaign(harness.w011, {
      totalAmount: 1000,
      clearingDrawKind: "credit_issuance",
    });
    const creditResult = await harness.runtime.apiCommands.executeCampaignClearing(
      contributorCtx(harness, "w014-sep-credit"),
      harness.contributorPersonId,
      {
        campaignId: creditCampaign.id,
        valueRecordId: forCredits.id,
        creditsPerValueUnit: 1,
        idempotencyKey: key("w014-sep-credit"),
      },
    );
    const issuance = creditResult.issuance as {
      creditAmount: number;
      beneficiaryPersonId: string;
    };
    expect(issuance.creditAmount).toBe(50);

    const { value: forCash } = await createRecognizedMatureValue(harness, {
      withMeasuredOutcomeBasis: true,
      amount: 50,
    });
    const cashCampaign = await activateReadyCampaign(harness.w011, {
      totalAmount: 1000,
      clearingDrawKind: "cash_obligation",
    });
    const cashResult = await harness.runtime.apiCommands.executeCampaignClearing(
      contributorCtx(harness, "w014-sep-cash"),
      harness.contributorPersonId,
      {
        campaignId: cashCampaign.id,
        valueRecordId: forCash.id,
        cashKind: "payable",
        counterpartyPersonId: harness.moderatorPersonId,
        cashAmount: 20,
        idempotencyKey: key("w014-sep-cash"),
      },
    );
    const obligation = cashResult.obligation as {
      amount: number;
      kind: string;
    };
    expect(obligation.amount).toBe(20);
    expect(obligation.kind).toBe("payable");
    // No linkage between the issuance and the obligation (distinct
    // primitives, distinct units — conversion remains an EXPLICIT
    // NET-W008 entry with a recorded rate, never created here).
    expect(JSON.stringify(cashResult)).not.toContain(issuance.creditAmount.toString().length > 0 ? "creditAmount" : "credits");
    const serializedIssuance = JSON.stringify(creditResult);
    expect(serializedIssuance).not.toMatch(/obligation/);
  });

  test("the canonical conversion path is untouched: conversions remain explicit NET-W008 commands only", async () => {
    // The conversion count in the authority is unchanged by the
    // reward-integration flows (no composite creates conversions).
    const before = await harness.runtime.postgresAuthority.scan(
      "economic_conversions",
    );
    const { value } = await createRecognizedMatureValue(harness, {
      withMeasuredOutcomeBasis: true,
      amount: 10,
    });
    const campaign = await createClearingCampaign(harness);
    await harness.runtime.apiCommands.executeCampaignClearing(
      contributorCtx(harness, "w014-no-conversion"),
      harness.contributorPersonId,
      {
        campaignId: campaign.id,
        valueRecordId: value.id,
        idempotencyKey: key("w014-no-conversion"),
      },
    );
    await harness.runtime.apiCommands.applySettlementReputationEffect(
      contributorCtx(harness, "w014-no-conversion-rep"),
      harness.contributorPersonId,
      {
        valueRecordId: value.id,
        idempotencyKey: key("w014-no-conversion-rep"),
      },
    );
    const after = await harness.runtime.postgresAuthority.scan(
      "economic_conversions",
    );
    expect(after.length).toBe(before.length);
  });

  test("NO external payment execution: the integration composites never reference the payments boundary (source-level pin)", async () => {
    const runtime = await readFile("src/bootstrap/runtime.ts", "utf8");
    const settlementPort = await readFile("src/settlement/port.ts", "utf8");
    const campaignsPort = await readFile("src/campaigns/port.ts", "utf8");
    const contributionsPort = await readFile("src/contributions/port.ts", "utf8");
    // The settlement/campaigns/contributions domains never import the
    // payments boundary at all.
    for (const [name, source] of [
      ["settlement/port.ts", settlementPort],
      ["campaigns/port.ts", campaignsPort],
      ["contributions/port.ts", contributionsPort],
    ] as const) {
      expect(
        source.match(/from\s+"\.\.\/payments/g) ??
          source.match(/from\s+"\.\/payments/g) ??
          [],
        `${name} must not import the payments boundary`,
      ).toEqual([]);
    }
    // In the composition root, the only payments reference is the
    // skeletal MODULE REGISTRATION (every boundary registers its
    // module — the NET-W001 pattern); the NET-W014 composite regions
    // contain no payments reference at all.
    const moduleImports = runtime.match(/from\s+"\.\.\/payments[^\"]*"/g) ?? [];
    expect(moduleImports).toEqual(['from "../payments/module.ts"']);
    const compositeStart = runtime.indexOf(
      "async recognizeContributionValue",
    );
    const compositeEnd = runtime.indexOf(
      "async applySettlementReputationEffect",
    );
    expect(compositeStart).toBeGreaterThanOrEqual(0);
    expect(compositeEnd).toBeGreaterThan(compositeStart);
    const endOfReputationComposite = runtime.indexOf(
      "\n    },",
      compositeEnd,
    );
    const compositesRegion = runtime.slice(
      compositeStart,
      endOfReputationComposite,
    );
    // No payment SERVICE usage, provider wiring or boundary import
    // inside the composites (prose comments aside).
    expect(compositesRegion).not.toMatch(
      /paymentService|paymentProvider|executePayment|from\s+"\.\.\/payments/,
    );
    // The payments boundary stays skeletal (module marker).
    const paymentsModule = await readFile("src/payments/module.ts", "utf8");
    expect(paymentsModule).toMatch(/skeletal/i);
  });

  test("cash draws record INTERNAL state only — the obligation stays `recognized` until the canonical NET-W008 settle command", async () => {
    const { value } = await createRecognizedMatureValue(harness, {
      withMeasuredOutcomeBasis: true,
      amount: 50,
    });
    const campaign = await activateReadyCampaign(harness.w011, {
      totalAmount: 1000,
      clearingDrawKind: "cash_obligation",
    });
    const result = await harness.runtime.apiCommands.executeCampaignClearing(
      contributorCtx(harness, "w014-cash-internal"),
      harness.contributorPersonId,
      {
        campaignId: campaign.id,
        valueRecordId: value.id,
        cashKind: "receivable",
        counterpartyPersonId: harness.moderatorPersonId,
        cashAmount: 15,
        idempotencyKey: key("w014-cash-internal"),
      },
    );
    expect((result.obligation as { status: string }).status).toBe("recognized");
  });
});
