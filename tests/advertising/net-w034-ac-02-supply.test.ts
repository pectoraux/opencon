/**
 * NET-W034-AC-02 — Supply provenance and inventory authority (issue
 * #69 §5 AC-02).
 *
 * A W019 inventory item is resolved as the sole eligible supply source
 * for the scenario. W023-normalized external supply-chain facts
 * resolve to exactly one inventory record; ambiguous/cross-tenant/
 * unauthenticated/stale facts cannot self-authorize ownership or
 * settlement readiness.
 *  - the W019 settlement-readiness derivation (ELIGIBLE, from
 *    CURRENT durable records: registered owner + available supply +
 *    resolved ACTIVE policy scope + satisfied eligibility);
 *  - the W023 normalized provenance fact (the verified two-hop supply
 *    chain + the exact-one inventory resolution);
 *  - ambiguous resolution fails closed (ambiguous_supply);
 *  - unauthenticated / tampered / wrong-key / stale seller
 *    authorizations fail closed (the trust envelope);
 *  - cross-tenant evaluation resolves nothing (supply_not_found — no
 *    existence oracle);
 *  - a RETIRED source fails the settlement readiness (fail closed);
 *  - no direct inventory repository writes (the W034 surface composes
 *    ONLY through the inventory service — every mutation audited).
 */

import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import {
  createNetW034Harness,
  runAdvertisingScenario,
  registerScenarioSupply,
  evaluateSupplyProvenance,
  key,
  personCtx,
  EVALUATED_AT,
  PUBLISHER_DOMAIN,
  type NetW034Harness,
  type AdvertisingScenario,
} from "./_net-w034-harness.ts";
import {
  rawBidRequest,
  verifyingAuthorizations,
  PUBLISHER_DOMAIN as W023_PUBLISHER_DOMAIN,
} from "../adapters/_net-w023-harness.ts";

let harness: NetW034Harness;
let scenario: AdvertisingScenario;

beforeAll(async () => {
  harness = await createNetW034Harness();
  scenario = await runAdvertisingScenario(harness, { skipSettlement: true });
  // The DEFAULT-domain supply (PUBLISHER_DOMAIN) the W023-fixture
  // evaluations resolve: the unauthenticated/stale fail-closed
  // fixtures evaluate the DEFAULT bid request, whose supply chain
  // then fails closed (the scenario's own supply uses a UNIQUE
  // domain — re-runnable).
  await registerScenarioSupply(harness);
});

afterAll(async () => {
  await harness.teardown();
});

describe("NET-W034-AC-02 supply provenance and inventory authority", () => {
  test("the scenario supply resolves as the SOLE eligible source: registered + verified + the W019 settlement-readiness derivation", async () => {
    const ctx = harness.operatorCtx("w034-ac02-read");
    // The REGISTERED record is the truth (read through the inventory
    // authority's tenant-scoped read).
    const item = await harness.runtime.inventoryService.getInventoryItem(
      ctx,
      harness.organizationScopeId,
      scenario.inventoryItemId,
    );
    expect(item.id).toBe(scenario.inventoryItemId);
    expect(item.organizationScopeId).toBe(harness.organizationScopeId);
    expect(item.ownerPersonId).toBe(harness.creatorPersonId);
    expect(item.retiredAt).toBeNull();
    // The INV-003 supply-verification evidence reference is attached
    // (the canonical, subject-bound evidence — read from the record,
    // never caller-asserted).
    expect(item.verificationEvidenceReference).toBe(
      scenario.supplyVerificationEvidenceId,
    );
    // The W019 settlement readiness (from the scenario's placement):
    // ELIGIBLE — re-derived from CURRENT durable records.
    const readiness =
      await harness.runtime.inventoryService.getPlacementSettlementReadiness(
        ctx,
        harness.organizationScopeId,
        scenario.placementId,
      );
    expect(readiness.eligible).toBe(true);
    expect(readiness.checks.every((c) => c.satisfied)).toBe(true);
    // The source context is frozen from durable records: the
    // registered owner + the durable supply identity.
    expect(readiness.sourceContext.inventoryItemId).toBe(item.id);
    expect(readiness.sourceContext.ownerPersonId).toBe(item.ownerPersonId);
    expect(readiness.verificationEvidenceReference).toBe(
      item.verificationEvidenceReference,
    );
  });

  test("the W023 normalized provenance fact resolves EXACTLY ONE inventory item (admitted, verified chain)", async () => {
    const evaluation = scenario.provenanceEvaluation;
    // The evaluation admitted the request on a VERIFIED supply chain.
    expect(evaluation.admitted).toBe(true);
    expect(evaluation.rejectionReason).toBeNull();
    expect(evaluation.supplyChain.status).toBe("verified");
    // The resolved supply IS the registered record — nothing is
    // fabricated (the ownership comes from /inventory only).
    expect(evaluation.resolvedSupply).toEqual({
      itemId: scenario.inventoryItemId,
      organizationScopeId: harness.organizationScopeId,
      surfaceKind: "publisher",
      format: "display",
      ownerPersonId: harness.creatorPersonId,
    });
    // The deterministic evaluation anchor is honored (never a wall
    // clock).
    expect(evaluation.evaluatedAt).toBe(EVALUATED_AT);
  });

  test("the W023 evaluation mutates NOTHING (external facts never create ownership or readiness)", async () => {
    // A pure derivation: the inventory state is unchanged by an
    // evaluation (the W023 contract).
    const before = await harness.runtime.inventoryService.listInventoryItems(
      harness.operatorCtx("w034-ac02-before"),
      harness.organizationScopeId,
    );
    await evaluateSupplyProvenance(harness);
    const after = await harness.runtime.inventoryService.listInventoryItems(
      harness.operatorCtx("w034-ac02-after"),
      harness.organizationScopeId,
    );
    expect(after.length).toBe(before.length);
  });

  test("ambiguous resolution fails closed (two items share one external reference)", async () => {
    const externalId = `ambiguous-${key("ext")}`;
    await registerScenarioSupply(harness, { externalId });
    await registerScenarioSupply(harness, { externalId });
    const evaluation = await evaluateSupplyProvenance(harness, {
      request: rawBidRequest({
        set: { site: { domain: externalId, name: "Ambiguous", publisher: { domain: externalId, name: "Ambiguous" } } },
      }),
    });
    expect(evaluation.admitted).toBe(false);
    expect(evaluation.rejectionReason).toBe("ambiguous_supply");
    expect(evaluation.resolvedSupply).toBeNull();
  });

  test("unauthenticated supply chains fail closed (unsigned / tampered / wrong-key trust envelopes)", async () => {
    for (const mode of ["unsigned", "tampered", "wrongKey"] as const) {
      const evaluation = await evaluateSupplyProvenance(harness, {
        sellerAuthorizations: verifyingAuthorizations({
          integrityMode: mode,
        }),
      });
      expect(evaluation.admitted).toBe(false);
      expect(evaluation.rejectionReason).toBe("supply_chain_unauthenticated");
      expect(evaluation.supplyChain.status).toBe("unauthenticated");
      // The resolution is a READ-ONLY neutral lookup — the registered
      // record may still resolve, but the unauthenticated chain can
      // never ADMIT (authorize) the request: no ownership, no
      // readiness, nothing fabricated.
    }
  });

  test("a STALE seller authorization fails closed (the mandatory-freshness gate)", async () => {
    const evaluation = await evaluateSupplyProvenance(harness, {
      sellerAuthorizations: verifyingAuthorizations({
        omitObservedAt: true,
      }),
    });
    expect(evaluation.admitted).toBe(false);
    expect(evaluation.rejectionReason).toBe("supply_chain_stale");
    // A stale authorization cannot ADMIT the request (fail closed):
    // no ownership, no readiness, nothing fabricated.
  });

  test("cross-tenant evaluation resolves NOTHING (supply_not_found — no existence oracle)", async () => {
    const evaluation = await evaluateSupplyProvenance(harness, {
      organizationScopeId: harness.secondOrgId,
      actorPersonId: harness.secondOrgPersonId,
    });
    expect(evaluation.admitted).toBe(false);
    expect(evaluation.rejectionReason).toBe("supply_not_found");
    expect(evaluation.resolvedSupply).toBeNull();
  });

  test("a RETIRED source fails the settlement readiness (fail closed, current durable records)", async () => {
    // A fresh placement on fresh supply, then the supply is retired —
    // the readiness re-derivation fails (supply_available).
    const item = await registerScenarioSupply(harness, {
      externalId: `retire-${key("ext")}`,
    });
    const placement = await harness.runtime.inventoryService.createPlacement(
      harness.creatorCtx("w034-ac02-retire-placement"),
      {
        organizationScopeId: harness.organizationScopeId,
        inventoryItemId: item.id,
        campaignId: scenario.campaignId,
        campaignPolicyVersion: scenario.campaignPolicyVersion,
        context: { territories: ["US", "CA"], languages: ["en"] },
        idempotencyKey: key("w034-ac02-retire-placement"),
      },
    );
    // Retire the supply through the inventory authority (one-way).
    await harness.runtime.inventoryService.retireInventoryItem(
      harness.creatorCtx("w034-ac02-retire"),
      {
        organizationScopeId: harness.organizationScopeId,
        itemId: item.id,
        reason: "supply withdrawn",
        idempotencyKey: key("w034-ac02-retire"),
      },
    );
    const readiness =
      await harness.runtime.inventoryService.getPlacementSettlementReadiness(
        harness.operatorCtx("w034-ac02-retired-read"),
        harness.organizationScopeId,
        placement.placement.id,
      );
    expect(readiness.eligible).toBe(false);
    expect(
      readiness.checks.some((c) => !c.satisfied),
    ).toBe(true);
  });

  test("no direct inventory repository writes: every supply mutation is audited through the inventory authority", async () => {
    const audit = harness.runtime.auditWriter;
    // The scenario supply's material mutations are all present and
    // transaction-bound (the registered + verification-attached +
    // placement-recorded events).
    const registered = await audit.query({
      eventType: "inventory_item.registered",
      resourceId: scenario.inventoryItemId,
    });
    expect(registered).toHaveLength(1);
    const verified = await audit.query({
      eventType: "inventory_item.supply_verification_attached",
      resourceId: scenario.inventoryItemId,
    });
    expect(verified).toHaveLength(1);
    const placed = await audit.query({
      eventType: "placement.recorded",
      resourceId: scenario.placementId,
    });
    expect(placed).toHaveLength(1);
    for (const event of [...registered, ...verified, ...placed]) {
      expect(typeof event.metadata?.transactionId).toBe("string");
    }
    // The committed order: registered → verification attached →
    // placement recorded (the supply precedes the placement).
    const log = await audit.query({ limit: 1_000_000 });
    const pos = (eventType: string, resourceId: string): number =>
      log.findIndex(
        (e) => e.eventType === eventType && e.resourceId === resourceId,
      );
    const registeredAt = pos("inventory_item.registered", scenario.inventoryItemId);
    const verifiedAt = pos(
      "inventory_item.supply_verification_attached",
      scenario.inventoryItemId,
    );
    const placedAt = pos("placement.recorded", scenario.placementId);
    expect(registeredAt).toBeGreaterThanOrEqual(0);
    expect(verifiedAt).toBeGreaterThan(registeredAt);
    expect(placedAt).toBeGreaterThan(verifiedAt);
  });

  test("the canonical publisher identity is shared across the boundary (the W023 constants)", () => {
    // The W034 scenario uses the SAME canonical publisher domain as
    // the W023 reference fixtures (the provider identity space is
    // uniform across the composed path).
    expect(PUBLISHER_DOMAIN).toBe(W023_PUBLISHER_DOMAIN);
    expect(PUBLISHER_DOMAIN).toBe("example.com");
  });
});
