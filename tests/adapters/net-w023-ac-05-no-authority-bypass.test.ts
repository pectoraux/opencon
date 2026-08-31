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
  signSellerAuthorization,
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

    // ambiguous: two conflicting SIGNED ads.txt observations for the
    // same publisher surface (distinct digests — trusted evidence in
    // genuine conflict).
    const ambiguous = await evaluateRequest(harness, {
      request: rawBidRequest(),
      sellerAuthorizations: [
        signSellerAuthorization({
          providerId: SUPPLY_PROVIDER_ID,
          sourceKind: "ads.txt",
          content: publisherAdsTxtContent(),
          sourceIdentity: PUBLISHER_DOMAIN,
          observedAt: OBSERVED_AT,
        }),
        signSellerAuthorization({
          providerId: SUPPLY_PROVIDER_ID,
          sourceKind: "ads.txt",
          content: publisherAdsTxtContent({ sellerId: "another-seller" }),
          sourceIdentity: PUBLISHER_DOMAIN,
          observedAt: OBSERVED_AT,
        }),
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
    // precedence: incomplete > unauthenticated > ambiguous > stale >
    // mismatched).
    const both = await evaluateRequest(harness, {
      request: rawBidRequest(),
      sellerAuthorizations: [
        signSellerAuthorization({
          providerId: SUPPLY_PROVIDER_ID,
          sourceKind: "ads.txt",
          content: publisherAdsTxtContent(),
          sourceIdentity: PUBLISHER_DOMAIN,
          observedAt: OBSERVED_AT,
        }),
        signSellerAuthorization({
          providerId: SUPPLY_PROVIDER_ID,
          sourceKind: "ads.txt",
          content: publisherAdsTxtContent({ sellerId: "conflicting" }),
          sourceIdentity: PUBLISHER_DOMAIN,
          observedAt: OBSERVED_AT,
        }),
        // NOTE: the intermediate sellers.json is MISSING → incomplete
        // takes precedence over the publisher-side ambiguity.
      ],
      evaluatedAt: EVALUATED_AT,
    });
    expect(both.rejectionReason).toBe("supply_chain_incomplete");
    void firstExchangeSellersJson;
    void freshKey;
  });

  // ---------------------------------------------------------------------
  // PR #47 REMEDIATION REGRESSIONS (architect CHANGES REQUESTED).
  //
  // Blocking finding 1: supply-chain verification was only
  // consistency checking of CALLER-SUPPLIED authorization files —
  // fabricated ads.txt/app-ads.txt/sellers.json content could produce
  // `verified`. Blocking finding 2: `observedAt` was optional, yet
  // missing freshness data could still lead to `verified`. These
  // regressions pin both gates: only AUTHENTICATED + FRESH +
  // CONSISTENT evidence can produce `verified`.
  // ---------------------------------------------------------------------

  test("REMEDIATION (finding 1): fabricated (unauthenticated) authorization files can NEVER produce verified — no envelope", async () => {
    harness = await createNetW023SupplyHarness();
    await registerExternalSupply(harness);
    // Grammar-VALID content — a perfectly consistent authorization
    // set — submitted with NO trust envelope: fabricated caller
    // content (the pre-remediation attack). It must NOT verify.
    const fabricated = await evaluateRequest(harness, {
      request: rawBidRequest(),
      sellerAuthorizations: verifyingAuthorizations({
        integrityMode: "unsigned",
      }),
      evaluatedAt: EVALUATED_AT,
    });
    expect(fabricated.admitted).toBe(false);
    expect(fabricated.rejectionReason).toBe("supply_chain_unauthenticated");
    expect(fabricated.supplyChain.status).toBe("unauthenticated");
    // The facts REMAIN FACTS (§3.4): the untrusted observations are
    // still recorded in the evaluation — they simply cannot govern.
    expect(fabricated.supplyChain.authorizations).toHaveLength(2);
  });

  test("REMEDIATION (finding 1): a TAMPERED signature (envelope does not match the content) can NEVER produce verified", async () => {
    harness = await createNetW023SupplyHarness();
    await registerExternalSupply(harness);
    const tampered = await evaluateRequest(harness, {
      request: rawBidRequest(),
      sellerAuthorizations: verifyingAuthorizations({
        integrityMode: "tampered",
      }),
      evaluatedAt: EVALUATED_AT,
    });
    expect(tampered.admitted).toBe(false);
    expect(tampered.rejectionReason).toBe("supply_chain_unauthenticated");
    expect(tampered.supplyChain.status).toBe("unauthenticated");
  });

  test("REMEDIATION (finding 1): a correctly-computed envelope signed with the WRONG key can NEVER produce verified", async () => {
    harness = await createNetW023SupplyHarness();
    await registerExternalSupply(harness);
    const wrongKey = await evaluateRequest(harness, {
      request: rawBidRequest(),
      sellerAuthorizations: verifyingAuthorizations({
        integrityMode: "wrongKey",
      }),
      evaluatedAt: EVALUATED_AT,
    });
    expect(wrongKey.admitted).toBe(false);
    expect(wrongKey.rejectionReason).toBe("supply_chain_unauthenticated");
    expect(wrongKey.supplyChain.status).toBe("unauthenticated");
  });

  test("REMEDIATION (finding 2): a SIGNED submission with MISSING observedAt can NEVER produce verified (missing freshness = stale)", async () => {
    harness = await createNetW023SupplyHarness();
    await registerExternalSupply(harness);
    // Valid trust envelopes over content WITHOUT any observation
    // timestamp — the signature honestly attests the ABSENCE of
    // freshness. The freshness gate must treat it as NOT fresh.
    const noFreshness = await evaluateRequest(harness, {
      request: rawBidRequest(),
      sellerAuthorizations: verifyingAuthorizations({
        omitObservedAt: true,
      }),
      evaluatedAt: EVALUATED_AT,
    });
    expect(noFreshness.admitted).toBe(false);
    expect(noFreshness.rejectionReason).toBe("supply_chain_stale");
    expect(noFreshness.supplyChain.status).toBe("stale");
    // The freshness-less facts remain recorded facts.
    expect(noFreshness.supplyChain.authorizations).toHaveLength(2);
    expect(noFreshness.supplyChain.authorizations[0]!.observedAt).toBeNull();
  });

  test("REMEDIATION (findings 1+2 combined): authenticated+fresh publisher file + unauthenticated hop file → unauthenticated, never verified", async () => {
    harness = await createNetW023SupplyHarness();
    await registerExternalSupply(harness);
    const mixed = await evaluateRequest(harness, {
      request: rawBidRequest(),
      sellerAuthorizations: [
        verifyingAuthorizations()[0]!,
        // The intermediate hop evidence is fabricated (no envelope).
        verifyingAuthorizations({ integrityMode: "unsigned" })[1]!,
      ],
      evaluatedAt: EVALUATED_AT,
    });
    expect(mixed.admitted).toBe(false);
    expect(mixed.rejectionReason).toBe("supply_chain_unauthenticated");
    expect(mixed.supplyChain.status).toBe("unauthenticated");
  });

  test("REMEDIATION (default runtime): WITHOUT a configured trust channel even correctly-signed facts can NEVER produce verified (fail closed)", async () => {
    // The default runtime has NO SELLER_AUTHORIZATION_TRUST_KEY: the
    // trust channel is unconfigured, so nothing can authenticate.
    harness = await createNetW023SupplyHarness({
      sellerAuthorizationTrustKey: null,
    });
    await registerExternalSupply(harness);
    expect(harness.runtime.openRtbSellerAuthorizationTrust.configured).toBe(false);
    const unconfigured = await evaluateRequest(harness, {
      request: rawBidRequest(),
      sellerAuthorizations: verifyingAuthorizations(),
      evaluatedAt: EVALUATED_AT,
    });
    expect(unconfigured.admitted).toBe(false);
    expect(unconfigured.rejectionReason).toBe("supply_chain_unauthenticated");
    expect(unconfigured.supplyChain.status).toBe("unauthenticated");
    // And the evaluation still writes NOTHING (the pure-derivation
    // guarantee holds under the unauthenticated path too).
    const auditCount = await harness.runtime.auditWriter.count();
    expect(auditCount).toBeGreaterThan(0); // harness setup writes
    const before = await harness.runtime.auditWriter.count();
    await evaluateRequest(harness, {
      request: rawBidRequest({ set: { id: "w023-unconfigured-2" } }),
      sellerAuthorizations: verifyingAuthorizations(),
      evaluatedAt: EVALUATED_AT,
    });
    expect(await harness.runtime.auditWriter.count()).toBe(before);
  });
});
