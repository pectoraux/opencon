/**
 * NET-W023-AC-04 — exact-one inventory resolution (issue #46; work
 * order §3.4).
 *
 * An external seller/publisher/app identifier resolves to EXACTLY ONE
 * registered inventory source or fails closed: zero matches →
 * `supply_not_found`; multiple matches → `ambiguous_supply`;
 * cross-tenant matches are NOT visible (not-found semantics — no
 * existence oracle). The adapter can never fabricate ownership,
 * placement or settlement readiness (the resolved supply is the
 * REGISTERED record; the evaluation mutates nothing).
 */

import { describe, test, expect, afterEach } from "bun:test";
import {
  createNetW023SupplyHarness,
  rawBidRequest,
  verifyingAuthorizations,
  registerExternalSupply,
  evaluateRequest,
  freshKey,
  supplyActorCtx,
  PUBLISHER_DOMAIN,
  EVALUATED_AT,
  SUPPLY_PROVIDER_ID,
  type NetW023SupplyHarness,
} from "./_net-w023-harness.ts";

describe("NET-W023-AC-04 exact-one inventory resolution", () => {
  let harness: NetW023SupplyHarness;

  afterEach(async () => {
    if (harness) await harness.teardown();
  });

  test("the golden path: a verified supply chain resolves EXACTLY ONE registered item and is ADMITTED", async () => {
    harness = await createNetW023SupplyHarness();
    const { itemId } = await registerExternalSupply(harness);
    const evaluation = await evaluateRequest(harness, {
      request: rawBidRequest(),
      sellerAuthorizations: verifyingAuthorizations(),
      evaluatedAt: EVALUATED_AT,
    });
    expect(evaluation.admitted).toBe(true);
    expect(evaluation.rejectionReason).toBeNull();
    expect(evaluation.requestId).toBe("w023-request-1");
    expect(evaluation.supplyChain.status).toBe("verified");
    // The resolved supply IS the registered record (the owner is the
    // registered owner — nothing is fabricated).
    expect(evaluation.resolvedSupply).toEqual({
      itemId,
      organizationScopeId: harness.organizationScopeId,
      surfaceKind: "publisher",
      format: "display",
      ownerPersonId: harness.creatorPersonId,
    });
  });

  test("zero matches fail closed: supply_not_found (and NOTHING is registered by the evaluation)", async () => {
    harness = await createNetW023SupplyHarness();
    const before = await harness.runtime.inventoryService.listInventoryItems(
      harness.bootstrapCtx,
      harness.organizationScopeId,
    );
    const evaluation = await evaluateRequest(harness, {
      request: rawBidRequest({ set: { site: { domain: "unregistered.example" } } }),
      sellerAuthorizations: verifyingAuthorizations(),
      evaluatedAt: EVALUATED_AT,
    });
    expect(evaluation.admitted).toBe(false);
    expect(evaluation.rejectionReason).toBe("supply_not_found");
    expect(evaluation.resolvedSupply).toBeNull();
    // External assertions NEVER create InventoryItem ownership: the
    // inventory state is unchanged.
    const after = await harness.runtime.inventoryService.listInventoryItems(
      harness.bootstrapCtx,
      harness.organizationScopeId,
    );
    expect(after.length).toBe(before.length);
  });

  test("multiple matches fail closed: ambiguous_supply (two items share one external reference)", async () => {
    harness = await createNetW023SupplyHarness();
    await registerExternalSupply(harness, { externalId: PUBLISHER_DOMAIN });
    await registerExternalSupply(harness, { externalId: PUBLISHER_DOMAIN });
    const evaluation = await evaluateRequest(harness, {
      request: rawBidRequest(),
      sellerAuthorizations: verifyingAuthorizations(),
      evaluatedAt: EVALUATED_AT,
    });
    expect(evaluation.admitted).toBe(false);
    expect(evaluation.rejectionReason).toBe("ambiguous_supply");
  });

  test("cross-tenant matches are NOT visible (not-found semantics — no existence oracle)", async () => {
    harness = await createNetW023SupplyHarness();
    // Register the SAME external reference in the SECOND organization.
    const ctx = supplyActorCtx(harness, "w023-cross-org", harness.secondOrgPersonId);
    await harness.runtime.inventoryService.registerInventoryItem(ctx, {
      organizationScopeId: harness.secondOrgId,
      surfaceKind: "publisher",
      format: "display",
      externalReference: {
        provider: SUPPLY_PROVIDER_ID,
        externalId: PUBLISHER_DOMAIN,
        url: "https://example.com",
      },
      attributes: { territories: ["US"], languages: ["en"] },
      description: "second-org supply",
      idempotencyKey: freshKey("w023-second-org-item"),
    });
    // Evaluating in the FIRST organization: zero in-scope matches →
    // not found (the other tenant's item is invisible).
    const evaluation = await evaluateRequest(harness, {
      request: rawBidRequest(),
      sellerAuthorizations: verifyingAuthorizations(),
      evaluatedAt: EVALUATED_AT,
    });
    expect(evaluation.admitted).toBe(false);
    expect(evaluation.rejectionReason).toBe("supply_not_found");
    // Evaluating in the SECOND organization resolves exactly one.
    const secondOrgEvaluation = await evaluateRequest(harness, {
      request: rawBidRequest(),
      sellerAuthorizations: verifyingAuthorizations(),
      evaluatedAt: EVALUATED_AT,
      organizationScopeId: harness.secondOrgId,
      actorPersonId: harness.secondOrgPersonId,
    });
    expect(secondOrgEvaluation.admitted).toBe(true);
    expect(secondOrgEvaluation.resolvedSupply!.organizationScopeId).toBe(harness.secondOrgId);
  });

  test("a withdrawn (retired) supply is NOT admitted: supply_retired (one-way /inventory retirement)", async () => {
    harness = await createNetW023SupplyHarness();
    const { itemId } = await registerExternalSupply(harness);
    await harness.runtime.inventoryService.retireInventoryItem(
      supplyActorCtx(harness, "w023-retire"),
      {
        organizationScopeId: harness.organizationScopeId,
        itemId,
        reason: "withdrawn for W023 test",
        idempotencyKey: freshKey("w023-retire"),
      },
    );
    const evaluation = await evaluateRequest(harness, {
      request: rawBidRequest(),
      sellerAuthorizations: verifyingAuthorizations(),
      evaluatedAt: EVALUATED_AT,
    });
    expect(evaluation.admitted).toBe(false);
    expect(evaluation.rejectionReason).toBe("supply_retired");
    // The resolved supply is still reported (the fact of the match),
    // but admission is denied.
    expect(evaluation.resolvedSupply!.itemId).toBe(itemId);
  });

  test("format mismatch fails closed: every impression slot must match the registered format", async () => {
    harness = await createNetW023SupplyHarness();
    await registerExternalSupply(harness, { format: "display" });
    const evaluation = await evaluateRequest(harness, {
      request: rawBidRequest({ set: { imp: [{ id: "1", video: {} }] } }),
      sellerAuthorizations: verifyingAuthorizations(),
      evaluatedAt: EVALUATED_AT,
    });
    expect(evaluation.admitted).toBe(false);
    expect(evaluation.rejectionReason).toBe("supply_format_mismatch");
  });

  test("the app supply identity resolves the same way (bundle → externalId)", async () => {
    harness = await createNetW023SupplyHarness();
    await registerExternalSupply(harness, {
      externalId: "com.example.app",
      surfaceKind: "app",
    });
    const evaluation = await evaluateRequest(harness, {
      request: rawBidRequest({
        remove: ["site"],
        set: { app: { bundle: "com.example.app" } },
      }),
      sellerAuthorizations: [
        // app-ads.txt bound to the app bundle (the publisher surface).
        {
          providerId: SUPPLY_PROVIDER_ID,
          sourceKind: "app-ads.txt",
          content: "exchange-one.example, pub-seller-1, DIRECT",
          sourceIdentity: "com.example.app",
          observedAt: "2026-09-01T11:00:00.000Z",
        },
        {
          providerId: SUPPLY_PROVIDER_ID,
          sourceKind: "sellers.json",
          content: JSON.stringify({
            version: "2.0",
            sellers: [
              {
                seller_id: "inter-seller-7",
                domain: "exchange-two.example",
                seller_type: "INTERMEDIARY",
              },
            ],
          }),
          sourceIdentity: "exchange-one.example",
          observedAt: "2026-09-01T11:00:00.000Z",
        },
      ],
      evaluatedAt: EVALUATED_AT,
    });
    expect(evaluation.admitted).toBe(true);
    expect(evaluation.resolvedSupply!.surfaceKind).toBe("app");
  });

  test("external authorization facts NEVER assert placement settlement-readiness (the derived /inventory gate is untouched)", async () => {
    harness = await createNetW023SupplyHarness();
    // No placements exist: nothing is settlement-ready, no matter how
    // verified the external supply chain is.
    const { itemId } = await registerExternalSupply(harness);
    const evaluation = await evaluateRequest(harness, {
      request: rawBidRequest(),
      sellerAuthorizations: verifyingAuthorizations(),
      evaluatedAt: EVALUATED_AT,
    });
    expect(evaluation.admitted).toBe(true);
    const placements = await harness.runtime.inventoryService.listPlacements(
      harness.bootstrapCtx,
      harness.organizationScopeId,
    );
    expect(placements).toHaveLength(0);
    // The admitted evaluation did not attach supply verification
    // either (that remains the owner-only /evidence-backed command).
    const item = await harness.runtime.inventoryService.getInventoryItem(
      harness.bootstrapCtx,
      harness.organizationScopeId,
      itemId,
    );
    expect(item.verificationEvidenceReference).toBeNull();
  });
});
