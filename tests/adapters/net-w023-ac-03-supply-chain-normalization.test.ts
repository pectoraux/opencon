/**
 * NET-W023-AC-03 — supply-chain normalization (issue #46; work order
 * §3.3): ads.txt, app-ads.txt, sellers.json and schain-style inputs
 * normalize to ONE provider-neutral representation with provenance,
 * verification status inputs and a bounded vocabulary; invalid or
 * ambiguous input fails closed (covered by AC-02's grammar corpus).
 *
 * This suite pins the unified normalization: record-set semantics
 * (line-order independence), canonical sorting, digest
 * recomputation, the closed relationship vocabulary, provenance
 * (source kind/identity/observedAt/version) and the redaction
 * summaries (names only).
 */

import { describe, test, expect, afterEach } from "bun:test";
import {
  createNetW023SupplyHarness,
  rawBidRequest,
  publisherAdsTxtContent,
  firstExchangeSellersJson,
  SUPPLY_PROVIDER_ID,
  PUBLISHER_DOMAIN,
  FIRST_EXCHANGE,
  OBSERVED_AT,
  type NetW023SupplyHarness,
} from "./_net-w023-harness.ts";
import { computeCanonicalDigest } from "../../src/adapters/openrtb/canonical-json.ts";

describe("NET-W023-AC-03 supply-chain normalization", () => {
  let harness: NetW023SupplyHarness;

  afterEach(async () => {
    if (harness) await harness.teardown();
  });

  test("ads.txt normalizes into the unified neutral representation (DIRECT/RESELLER mapping, bounded)", async () => {
    harness = await createNetW023SupplyHarness();
    const result = await harness.runtime.openRtbIngress.normalizeSellerAuthorizationSubmission({
      providerId: SUPPLY_PROVIDER_ID,
      sourceKind: "ads.txt",
      content: publisherAdsTxtContent(),
      sourceIdentity: PUBLISHER_DOMAIN,
      observedAt: OBSERVED_AT,
    });
    // The unified shape: source kind + identity + records + provenance + digest.
    expect(result.facts.sourceKind).toBe("ads.txt");
    expect(result.facts.sourceIdentity).toBe(PUBLISHER_DOMAIN);
    expect(result.facts.observedAt).toBe(OBSERVED_AT);
    expect(result.facts.version).toBeNull();
    // Comments/variables are not records; the two seller records
    // cross (the certification id is dropped and reported by name).
    expect(result.facts.records).toHaveLength(2);
    expect(result.facts.records).toContainEqual({
      sourceIdentity: FIRST_EXCHANGE,
      externalSellerId: "pub-seller-1",
      relationship: "direct",
      name: null,
      domain: null,
    });
    expect(result.facts.records).toContainEqual({
      sourceIdentity: "exchange-other.example",
      externalSellerId: "999",
      relationship: "reseller",
      name: null,
      domain: null,
    });
    expect(result.redactedFieldNames).toEqual(["certificationId"]);
  });

  test("app-ads.txt normalizes with the SAME grammar (provenance distinguishes the surface)", async () => {
    harness = await createNetW023SupplyHarness();
    const result = await harness.runtime.openRtbIngress.normalizeSellerAuthorizationSubmission({
      providerId: SUPPLY_PROVIDER_ID,
      sourceKind: "app-ads.txt",
      content: publisherAdsTxtContent(),
      sourceIdentity: "com.example.app",
      observedAt: OBSERVED_AT,
    });
    expect(result.facts.sourceKind).toBe("app-ads.txt");
    expect(result.facts.sourceIdentity).toBe("com.example.app");
    expect(result.facts.records).toHaveLength(2);
  });

  test("sellers.json normalizes with the PUBLISHER/INTERMEDIARY/BOTH mapping + version provenance", async () => {
    harness = await createNetW023SupplyHarness();
    const result = await harness.runtime.openRtbIngress.normalizeSellerAuthorizationSubmission({
      providerId: SUPPLY_PROVIDER_ID,
      sourceKind: "sellers.json",
      content: firstExchangeSellersJson(),
      sourceIdentity: FIRST_EXCHANGE,
      observedAt: OBSERVED_AT,
    });
    expect(result.facts.sourceKind).toBe("sellers.json");
    expect(result.facts.sourceIdentity).toBe(FIRST_EXCHANGE);
    expect(result.facts.version).toBe("2.0");
    expect(result.facts.records).toEqual([
      {
        sourceIdentity: FIRST_EXCHANGE,
        externalSellerId: "inter-seller-7",
        relationship: "intermediary",
        name: "Exchange Two",
        domain: "exchange-two.example",
      },
    ]);
    // The top-level `contacts` + per-seller `ext` extras are reported
    // by NAME only (values never cross).
    expect(result.redactedFieldNames).toContain("contacts");
    expect(result.redactedFieldNames).toContain("seller.ext");
    expect(JSON.stringify(result)).not.toContain("Opaque Contact");
    expect(JSON.stringify(result)).not.toContain("contact@example.com");
  });

  test("record-set semantics: file line order does NOT change the facts or digest (canonical sorting)", async () => {
    harness = await createNetW023SupplyHarness();
    const lines = publisherAdsTxtContent().split("\n");
    const reordered = [...lines.slice(0, 3), ...lines.slice(3).reverse()].join("\n");
    const a = await harness.runtime.openRtbIngress.normalizeSellerAuthorizationSubmission({
      providerId: SUPPLY_PROVIDER_ID,
      sourceKind: "ads.txt",
      content: publisherAdsTxtContent(),
      sourceIdentity: PUBLISHER_DOMAIN,
      observedAt: OBSERVED_AT,
    });
    const b = await harness.runtime.openRtbIngress.normalizeSellerAuthorizationSubmission({
      providerId: SUPPLY_PROVIDER_ID,
      sourceKind: "ads.txt",
      content: reordered,
      sourceIdentity: PUBLISHER_DOMAIN,
      observedAt: OBSERVED_AT,
    });
    // Identical authorization SETS normalize identically.
    expect(b.facts.records).toEqual(a.facts.records);
    expect(b.facts.digest).toBe(a.facts.digest);
    // Records are canonically sorted (sourceIdentity, externalSellerId).
    const sortedIds = a.facts.records.map((r) => `${r.sourceIdentity}:${r.externalSellerId}`);
    expect(sortedIds).toEqual([...sortedIds].sort());
    // The digest recomputes from the canonical material (AC-06
    // evidence: deterministic digest recomputation).
    expect(a.facts.digest).toBe(
      computeCanonicalDigest({
        sourceKind: a.facts.sourceKind,
        sourceIdentity: a.facts.sourceIdentity,
        observedAt: a.facts.observedAt,
        version: a.facts.version,
        records: a.facts.records,
      }),
    );
  });

  test("duplicate identical records dedupe (one authorization, one record)", async () => {
    harness = await createNetW023SupplyHarness();
    const content = [
      `${FIRST_EXCHANGE}, pub-seller-1, DIRECT`,
      `${FIRST_EXCHANGE}, pub-seller-1, DIRECT`,
    ].join("\n");
    const result = await harness.runtime.openRtbIngress.normalizeSellerAuthorizationSubmission({
      providerId: SUPPLY_PROVIDER_ID,
      sourceKind: "ads.txt",
      content,
      sourceIdentity: PUBLISHER_DOMAIN,
      observedAt: OBSERVED_AT,
    });
    expect(result.facts.records).toHaveLength(1);
  });

  test("the embedded schain normalizes through the REQUEST path (the same bounded node vocabulary)", async () => {
    harness = await createNetW023SupplyHarness();
    const result = await harness.runtime.openRtbIngress.normalizeRequestSubmission({
      providerId: SUPPLY_PROVIDER_ID,
      payload: rawBidRequest(),
    });
    const chain = result.request.supplyChain!;
    expect(chain.complete).toBe(true);
    expect(chain.version).toBe("1.0");
    expect(chain.nodes).toEqual([
      {
        asi: FIRST_EXCHANGE,
        sid: "pub-seller-1",
        name: "Exchange One",
        rid: "w023-request-1",
        paymentHop: true,
      },
      {
        asi: "exchange-two.example",
        sid: "inter-seller-7",
        name: "Exchange Two",
        rid: null,
        paymentHop: true,
      },
    ]);
    // A request WITHOUT a supply chain normalizes to null (absent —
    // the evaluation then fails closed, never invents one).
    const withoutChain = await harness.runtime.openRtbIngress.normalizeRequestSubmission({
      providerId: SUPPLY_PROVIDER_ID,
      payload: rawBidRequest({ remove: ["source"] }),
    });
    expect(withoutChain.request.supplyChain).toBeNull();
    expect(withoutChain.request.digest).toMatch(/^[0-9a-f]{64}$/);
  });

  test("normalization determinism: identical inputs produce identical facts + digests", async () => {
    harness = await createNetW023SupplyHarness();
    const a = await harness.runtime.openRtbIngress.normalizeSellerAuthorizationSubmission({
      providerId: SUPPLY_PROVIDER_ID,
      sourceKind: "sellers.json",
      content: firstExchangeSellersJson(),
      sourceIdentity: FIRST_EXCHANGE,
      observedAt: OBSERVED_AT,
    });
    const b = await harness.runtime.openRtbIngress.normalizeSellerAuthorizationSubmission({
      providerId: SUPPLY_PROVIDER_ID,
      sourceKind: "sellers.json",
      content: firstExchangeSellersJson(),
      sourceIdentity: FIRST_EXCHANGE,
      observedAt: OBSERVED_AT,
    });
    expect(b.facts).toEqual(a.facts);
    // A different content → a different digest.
    const c = await harness.runtime.openRtbIngress.normalizeSellerAuthorizationSubmission({
      providerId: SUPPLY_PROVIDER_ID,
      sourceKind: "sellers.json",
      content: firstExchangeSellersJson({ sellerId: "someone-else" }),
      sourceIdentity: FIRST_EXCHANGE,
      observedAt: OBSERVED_AT,
    });
    expect(c.facts.digest).not.toBe(a.facts.digest);
  });
});
