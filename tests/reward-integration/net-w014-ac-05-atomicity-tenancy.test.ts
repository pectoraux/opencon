/**
 * NET-W014-AC-05 — accounting conservation, idempotency,
 * concurrency, tenant isolation and audit lineage hold end-to-end
 * (SETTLE-003; issue #27 invariant 7).
 *
 * The integration layer inherits every property from the UNTOUCHED
 * settlement primitives; this suite proves the properties hold
 * THROUGH the new composites (recognition → maturation → clearing →
 * reputation) and at the new boundaries.
 */
import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import {
  createNetW014Harness,
  createRecognizedMatureValue,
  createVerifiedSettledContribution,
  createClearingCampaign,
  recognizeContributionValue,
  moderatorCtx,
  contributorCtx,
  key,
  type NetW014Harness,
} from "./_net-w014-harness.ts";
import { assertGlobalConservation } from "../settlement/_net-w008-harness.ts";
import { createRuntime } from "../../src/bootstrap/runtime.ts";

let harness: NetW014Harness;

beforeAll(async () => {
  harness = await createNetW014Harness();
});

afterAll(async () => {
  await harness.teardown();
});

const BASE = "http://127.0.0.1";

describe("NET-W014-AC-05 atomicity/tenancy/conservation end-to-end", () => {
  test("the three reward-integration routes are guarded deny-by-default (no policy → 403)", async () => {
    const bare = createRuntime({
      forceEnv: "test",
      env: { APP_ENV: "test", LOG_LEVEL: "error" },
      port: 0,
    });
    await bare.initialize();
    await bare.api.start();
    try {
      const endpoints: Array<[string, Record<string, unknown>]> = [
        [
          "/api/settlement/contribution-value",
          { contributionId: "c", amount: 1, idempotencyKey: "k" },
        ],
        [
          "/api/settlement/clearing-executions",
          { campaignId: "x", valueRecordId: "y", idempotencyKey: "k" },
        ],
        [
          "/api/settlement/reputation-effects",
          { valueRecordId: "y", idempotencyKey: "k" },
        ],
      ];
      for (const [path, body] of endpoints) {
        const res = await fetch(`${BASE}:${bare.api.port}${path}`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
        });
        expect(res.status, `${path} unauthenticated`).toBe(403);
      }
    } finally {
      await bare.shutdown();
    }
  });

  test("CONCURRENT recognitions with the same idempotency key produce exactly ONE value record", async () => {
    const { contribution } = await createVerifiedSettledContribution(harness, {
      withMeasuredOutcomeBasis: true,
    });
    const idem = key("w014-concurrent");
    const results = await Promise.all(
      [0, 1, 2, 3, 4].map(() =>
        recognizeContributionValue(harness, contribution.id, {
          amount: 25,
          idempotencyKey: idem,
        }).catch((err: unknown) => err),
      ),
    );
    const successes = results.filter(
      (r): r is Awaited<ReturnType<typeof recognizeContributionValue>> =>
        !(r instanceof Error),
    );
    expect(successes.length).toBeGreaterThanOrEqual(1);
    const ids = new Set(successes.map((r) => r.value.id));
    expect(ids.size).toBe(1);
    const values = await harness.runtime.economicValueService.listValues(
      harness.bootstrapCtx,
      harness.organizationScopeId,
      harness.contributorPersonId,
    );
    expect(values.filter((v) => v.idempotencyKey === idem).length).toBe(1);
  });

  test("END-TO-END conservation: recognize → mature → clear keeps every ledger transaction balanced and balances non-negative", async () => {
    const { value } = await createRecognizedMatureValue(harness, {
      withMeasuredOutcomeBasis: true,
      amount: 90,
    });
    const campaign = await createClearingCampaign(harness);
    const result = await harness.runtime.apiCommands.executeCampaignClearing(
      contributorCtx(harness, "w014-conservation-clear"),
      harness.contributorPersonId,
      {
        campaignId: campaign.id,
        valueRecordId: value.id,
        idempotencyKey: key("w014-conservation-clear"),
      },
    );
    expect(result.drawKind).toBe("reward_allocation");
    const allocation = result.allocation as {
      totalAllocated: number;
      shares: { amount: number }[];
    };
    expect(allocation.totalAllocated).toBe(90);
    expect(allocation.shares.reduce((s, x) => s + x.amount, 0)).toBe(90);
    // The global conservation assertion (balanced entries per unit +
    // non-negative balances) over the WHOLE authority state.
    await assertGlobalConservation(harness.w012.w011.w010.w009.w008);
  });

  test("a cross-tenant contribution SOURCE is rejected at the authoritative input gate", async () => {
    // A verified contribution recognized in the harness org, then
    // referenced by a record scoped to the SECOND org: the
    // settlement input gate rejects the cross-scope source.
    const { contribution } = await createVerifiedSettledContribution(harness, {
      withMeasuredOutcomeBasis: true,
    });
    await expect(
      harness.runtime.economicValueService.recordPendingValue(
        harness.bootstrapCtx,
        {
          organizationScopeId: harness.secondOrgId,
          beneficiaryPersonId: harness.secondOrgPersonId,
          amount: 10,
          sources: [
            { kind: "contribution", id: contribution.id },
          ],
          idempotencyKey: key("w014-cross-tenant"),
        },
      ),
    ).rejects.toThrow(/organization scope/i);
  });

  test("audit lineage: recognition, maturation and clearing each carry the AUTHORITATIVE transaction ids", async () => {
    const { value } = await createRecognizedMatureValue(harness, {
      withMeasuredOutcomeBasis: true,
      amount: 35,
    });
    // Recognition + maturation lineage (the authoritative transaction
    // ids are stamped on the record — each committed atomically with
    // its audit event, NET-W008-proven; the composite inherits it).
    expect(value.recognitionTransactionId).toBeTruthy();
    expect(value.maturationTransactionId).toBeTruthy();
    // The clearing bookkeeping event carries the settlement result
    // reference + the campaign audit lineage.
    const campaign = await createClearingCampaign(harness);
    const clearResult = await harness.runtime.apiCommands.executeCampaignClearing(
      contributorCtx(harness, "w014-lineage-clear"),
      harness.contributorPersonId,
      {
        campaignId: campaign.id,
        valueRecordId: value.id,
        idempotencyKey: key("w014-lineage-clear"),
      },
    );
    const allocationId = (clearResult.allocation as { id: string }).id;
    const campaignAfter = await harness.runtime.campaignService.getCampaign(
      moderatorCtx(harness, "w014-lineage-read"),
      campaign.id,
    );
    const event = campaignAfter.events.find(
      (e) => e.event === "clearing_executed",
    )!;
    expect(event.details).toMatchObject({
      resultId: allocationId,
      valueRecordId: value.id,
      drawKind: "reward_allocation",
    });
    expect(event.executionId).toBeTruthy();
    // The allocation itself resolves through the settlement authority
    // (the economic record of the draw).
    const allocation = await harness.runtime.rewardService.getAllocation(
      harness.bootstrapCtx,
      allocationId,
    );
    expect(allocation.sourceValueRecordId).toBe(value.id);
  });

  test("the recognized record's version increments exactly once per authoritative mutation (optimistic concurrency through the composites)", async () => {
    const { contribution } = await createVerifiedSettledContribution(harness, {
      withMeasuredOutcomeBasis: true,
    });
    const recognized = await recognizeContributionValue(harness, contribution.id, {
      amount: 20,
    });
    expect(recognized.value.version).toBe(0);
    const matured = await harness.runtime.apiCommands.matureEconomicValue(
      moderatorCtx(harness, "w014-version-mature"),
      {
        valueRecordId: recognized.value.id,
        idempotencyKey: key("w014-version-mature"),
      },
    );
    expect((matured as { version: number }).version).toBe(1);
  });
});
