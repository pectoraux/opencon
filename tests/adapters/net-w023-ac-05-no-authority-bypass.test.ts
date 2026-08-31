/**
 * NET-W023-AC-05 — no authority bypass (issue #46; work order §3.4/§2).
 *
 * External protocol facts cannot authorize campaigns, make supply
 * settlement-ready, clear risk, manufacture evidence truth, create
 * finalized measurements or create economic value. The admission
 * evaluation is a PURE derivation: no audit events, no inventory /
 * placement / verification mutations, and the derived settlement
 * readiness is re-derived UNCHANGED. Unverified / incomplete /
 * mismatched / stale / ambiguous supply chains are recorded as FACTS
 * but never promote to admission.
 */

import { describe, test, expect, afterEach } from "bun:test";
import {
  createNetW023SupplyHarness,
  rawBidRequest,
  verifyingAuthorizations,
  registerExternalSupply,
  evaluateRequest,
  publisherAdsTxtContent,
  firstExchangeSellersJson,
  supplyActorCtx,
  freshKey,
  PUBLISHER_DOMAIN,
  EVALUATED_AT,
  OBSERVED_AT,
  SUPPLY_PROVIDER_ID,
  FIRST_EXCHANGE,
  type NetW023SupplyHarness,
} from "./_net-w023-harness.ts";
import { goldenPathPlacement } from "../inventory/_net-w019-harness.ts";

describe("NET-W023-AC-05 no authority bypass", () => {
  let harness: NetW023SupplyHarness;

  afterEach(async () => {
    if (harness) await harness.teardown();
  });

  test("supply-chain status matrix: every non-verified status is NOT admitted (facts never promote to authorization)", async () => {
    harness = await createNetW023SupplyHarness();
    await registerExternalSupply(harness);

    // absent: no chain on the request.
    const absent = await evaluateRequest(harness, {
      request: rawBidRequest({ remove: ["source"] }),
      sellerAuthorizations: verifyingAuthorizations(),
      evaluatedAt: EVALUATED_AT,
    });
    expect(absent.admitted).toBe(false);
    expect(absent.rejectionReason).toBe("supply_chain_absent");
    expect(absent.supplyChain.status).toBe("absent");

    // incomplete: chain present but NO publisher file submitted.
    const incomplete = await evaluateRequest(harness, {
      request: rawBidRequest(),
      sellerAuthorizations: [],
      evaluatedAt: EVALUATED_AT,
    });
    expect(incomplete.admitted).toBe(false);
    expect(incomplete.rejectionReason).toBe("supply_chain_incomplete");

    // incomplete: the intermediate sellers.json is missing.
    const missingHop = await evaluateRequest(harness, {
      request: rawBidRequest(),
      sellerAuthorizations: [verifyingAuthorizations()[0]!],
      evaluatedAt: EVALUATED_AT,
    });
    expect(missingHop.admitted).toBe(false);
    expect(missingHop.rejectionReason).toBe("supply_chain_incomplete");

    // mismatched: the publisher's ads.txt authorizes a DIFFERENT seller id.
    const mismatched = await evaluateRequest(harness, {
      request: rawBidRequest(),
      sellerAuthorizations: verifyingAuthorizations({
        adsTxtContent: publisherAdsTxtContent({ sellerId: "someone-else" }),
      }),
      evaluatedAt: EVALUATED_AT,
    });
    expect(mismatched.admitted).toBe(false);
    expect(mismatched.rejectionReason).toBe("supply_chain_mismatched");

    // mismatched: the schain is INCOMPLETE (complete: 0).
    const incompleteChain = await evaluateRequest(harness, {
      request: rawBidRequest({
        set: {
          source: {
            ext: {
              schain: {
                complete: 0,
                ver: "1.0",
                nodes: [
                  { asi: FIRST_EXCHANGE, sid: "pub-seller-1" },
                  { asi: "exchange-two.example", sid: "inter-seller-7" },
                ],
              },
            },
          },
        },
      }),
      sellerAuthorizations: verifyingAuthorizations(),
      evaluatedAt: EVALUATED_AT,
    });
    expect(incompleteChain.admitted).toBe(false);
    expect(incompleteChain.rejectionReason).toBe("supply_chain_incomplete");

    // stale: the authorization facts are older than the bound.
    const stale = await evaluateRequest(harness, {
      request: rawBidRequest(),
      sellerAuthorizations: verifyingAuthorizations({
        observedAt: "2026-08-01T00:00:00.000Z",
      }),
      evaluatedAt: EVALUATED_AT,
    });
    expect(stale.admitted).toBe(false);
    expect(stale.rejectionReason).toBe("supply_chain_stale");
    // Stale facts REMAIN FACTS (recorded in the evaluation) — they
    // simply cannot support admission.
    expect(stale.supplyChain.status).toBe("stale");
    expect(stale.supplyChain.authorizations).toHaveLength(2);

    // ambiguous: two conflicting ads.txt observations for the same
    // publisher surface (distinct digests).
    const ambiguous = await evaluateRequest(harness, {
      request: rawBidRequest(),
      sellerAuthorizations: [
        {
          providerId: SUPPLY_PROVIDER_ID,
          sourceKind: "ads.txt",
          content: publisherAdsTxtContent(),
          sourceIdentity: PUBLISHER_DOMAIN,
          observedAt: OBSERVED_AT,
        },
        {
          providerId: SUPPLY_PROVIDER_ID,
          sourceKind: "ads.txt",
          content: publisherAdsTxtContent({ sellerId: "another-seller" }),
          sourceIdentity: PUBLISHER_DOMAIN,
          observedAt: OBSERVED_AT,
        },
        verifyingAuthorizations()[1]!,
      ],
      evaluatedAt: EVALUATED_AT,
    });
    expect(ambiguous.admitted).toBe(false);
    expect(ambiguous.rejectionReason).toBe("supply_chain_ambiguous");

    // And the VERIFIED chain admits (the control).
    const verified = await evaluateRequest(harness, {
      request: rawBidRequest(),
      sellerAuthorizations: verifyingAuthorizations(),
      evaluatedAt: EVALUATED_AT,
    });
    expect(verified.admitted).toBe(true);
  });

  test("an ADMITTED request writes NOTHING: no audit events, no inventory/placement/verification mutations", async () => {
    harness = await createNetW023SupplyHarness();
    await registerExternalSupply(harness);
    const auditCountBefore = await harness.runtime.auditWriter.count();
    const itemsBefore = await harness.runtime.inventoryService.listInventoryItems(
      harness.bootstrapCtx,
      harness.organizationScopeId,
    );
    const evaluation = await evaluateRequest(harness, {
      request: rawBidRequest(),
      sellerAuthorizations: verifyingAuthorizations(),
      evaluatedAt: EVALUATED_AT,
    });
    expect(evaluation.admitted).toBe(true);
    // The evaluation is a pure derivation: no audit events at all
    // (every material mutation in this protocol is audited — the
    // evaluation emitted NONE).
    const auditCountAfter = await harness.runtime.auditWriter.count();
    expect(auditCountAfter).toBe(auditCountBefore);
    // Inventory + placements unchanged.
    const itemsAfter = await harness.runtime.inventoryService.listInventoryItems(
      harness.bootstrapCtx,
      harness.organizationScopeId,
    );
    expect(itemsAfter.length).toBe(itemsBefore.length);
    const placements = await harness.runtime.inventoryService.listPlacements(
      harness.bootstrapCtx,
      harness.organizationScopeId,
    );
    expect(placements).toHaveLength(0);
  });

  test("external facts cannot make supply settlement-ready OR alter the derived readiness (the /inventory gate is untouched)", async () => {
    harness = await createNetW023SupplyHarness();
    // The W019 golden path: an ELIGIBLE placement exists.
    const golden = await goldenPathPlacement(harness.w019);
    expect(golden.readiness.eligible).toBe(true);
    // The item is bound to the default W019 external reference; the
    // evaluation for an UNRELATED identity (not registered here)
    // changes nothing.
    const unrelated = await evaluateRequest(harness, {
      request: rawBidRequest({ set: { site: { domain: "unregistered.example" } } }),
      sellerAuthorizations: verifyingAuthorizations(),
      evaluatedAt: EVALUATED_AT,
    });
    expect(unrelated.admitted).toBe(false);
    // Re-derive the settlement readiness: UNCHANGED.
    const rederived = await harness.runtime.inventoryService.getPlacementSettlementReadiness(
      supplyActorCtx(harness, "w023-rederive", harness.operatorPersonId),
      harness.organizationScopeId,
      golden.placement.id,
    );
    expect(rederived.eligible).toBe(true);
    expect(rederived.sourceContext).toEqual(golden.readiness.sourceContext);
    // The placement's inventory item is untouched by the evaluation.
    const item = await harness.runtime.inventoryService.getInventoryItem(
      harness.bootstrapCtx,
      harness.organizationScopeId,
      golden.item.id,
    );
    expect(item.retiredAt).toBeNull();
  });

  test("unverified/stale chain data cannot make inventory settlement-ready (no promotion path exists)", async () => {
    harness = await createNetW023SupplyHarness();
    const golden = await goldenPathPlacement(harness.w019);
    // An item registered for the OpenRTB provider + a STALE chain:
    // admission denied; the settlement readiness of the EXISTING
    // placement is still exactly the /inventory derivation.
    await registerExternalSupply(harness);
    const stale = await evaluateRequest(harness, {
      request: rawBidRequest(),
      sellerAuthorizations: verifyingAuthorizations({
        observedAt: "2026-08-01T00:00:00.000Z",
      }),
      evaluatedAt: EVALUATED_AT,
    });
    expect(stale.admitted).toBe(false);
    expect(stale.rejectionReason).toBe("supply_chain_stale");
    // No new placements, no readiness change, no verification attach.
    const placements = await harness.runtime.inventoryService.listPlacements(
      harness.bootstrapCtx,
      harness.organizationScopeId,
    );
    const openRtbItems = await harness.runtime.inventoryService.listInventoryItems(
      harness.bootstrapCtx,
      harness.organizationScopeId,
    );
    expect(placements).toHaveLength(1);
    for (const item of openRtbItems) {
      if (item.externalReference?.provider === SUPPLY_PROVIDER_ID) {
        expect(item.verificationEvidenceReference).toBeNull();
      }
    }
  });

  test("external facts cannot manufacture supply verification evidence (the owner-only /evidence command is the only path)", async () => {
    harness = await createNetW023SupplyHarness();
    const { itemId } = await registerExternalSupply(harness);
    const evidenceEventsBefore = (
      await harness.runtime.auditWriter.query({ resourceType: "evidence" })
    ).length;
    // Submit MANY verified evaluations: the verification evidence
    // reference stays null (attaching it is the owner-only, canonical
    // /evidence-backed command — W019's surface, unchanged).
    for (let i = 0; i < 3; i += 1) {
      const evaluation = await evaluateRequest(harness, {
        request: rawBidRequest({ set: { id: `w023-request-${i}` } }),
        sellerAuthorizations: verifyingAuthorizations(),
        evaluatedAt: EVALUATED_AT,
      });
      expect(evaluation.admitted).toBe(true);
    }
    const item = await harness.runtime.inventoryService.getInventoryItem(
      harness.bootstrapCtx,
      harness.organizationScopeId,
      itemId,
    );
    expect(item.verificationEvidenceReference).toBeNull();
    // No evidence records were created either (the /evidence surface
    // is untouched by the evaluation — it emits no writes at all).
    const evidenceEventsAfter = (
      await harness.runtime.auditWriter.query({ resourceType: "evidence" })
    ).length;
    expect(evidenceEventsAfter).toBe(evidenceEventsBefore);
  });

  test("the evaluation result carries NO economic authority: no ledger postings exist after any evaluation", async () => {
    harness = await createNetW023SupplyHarness();
    await registerExternalSupply(harness);
    const auditCountBefore = await harness.runtime.auditWriter.count();
    const admitted = await evaluateRequest(harness, {
      request: rawBidRequest(),
      sellerAuthorizations: verifyingAuthorizations(),
      evaluatedAt: EVALUATED_AT,
    });
    expect(admitted.admitted).toBe(true);
    // The floor price is an ECONOMIC FACT on the evaluation — it
    // never created ledger state: no economic audit events, no
    // postings (the audit count is the total-write proxy — every
    // material mutation is audited; the evaluation wrote NOTHING).
    const auditCountAfter = await harness.runtime.auditWriter.count();
    expect(auditCountAfter).toBe(auditCountBefore);
    // The floor stays a fact of the normalized request.
    expect(admitted.request.floorPrice).toEqual({ amount: 1.25, currency: "USD" });
  });

  test("deterministic precedence: conflicting evidence + missing evidence are distinguishable decisions", async () => {
    harness = await createNetW023SupplyHarness();
    await registerExternalSupply(harness);
    // Missing evidence dominates conflicting evidence (deterministic
    // precedence: incomplete > ambiguous > stale > mismatched).
    const both = await evaluateRequest(harness, {
      request: rawBidRequest(),
      sellerAuthorizations: [
        {
          providerId: SUPPLY_PROVIDER_ID,
          sourceKind: "ads.txt",
          content: publisherAdsTxtContent(),
          sourceIdentity: PUBLISHER_DOMAIN,
          observedAt: OBSERVED_AT,
        },
        {
          providerId: SUPPLY_PROVIDER_ID,
          sourceKind: "ads.txt",
          content: publisherAdsTxtContent({ sellerId: "conflicting" }),
          sourceIdentity: PUBLISHER_DOMAIN,
          observedAt: OBSERVED_AT,
        },
        // NOTE: the intermediate sellers.json is MISSING → incomplete
        // takes precedence over the publisher-side ambiguity.
      ],
      evaluatedAt: EVALUATED_AT,
    });
    expect(both.rejectionReason).toBe("supply_chain_incomplete");
    void firstExchangeSellersJson;
    void freshKey;
  });
});
