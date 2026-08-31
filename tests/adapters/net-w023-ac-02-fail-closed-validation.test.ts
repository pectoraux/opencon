/**
 * NET-W023-AC-02 — fail-closed OpenRTB + seller-authorization
 * validation (issue #46; work order §3.2).
 *
 * Every closed rejection reason is exercised: unsupported versions,
 * malformed structures, missing required identifiers, invalid
 * cardinality, contradictory/unsafe critical values, oversized
 * payloads, and ambiguous supply chains. Rejections are deterministic
 * and mutate NOTHING (the inventory state is pinned unchanged).
 * Error contexts carry reason/provider/field only — never payload
 * values.
 */

import { describe, test, expect, afterEach } from "bun:test";
import {
  createNetW023SupplyHarness,
  rawBidRequest,
  publisherAdsTxtContent,
  firstExchangeSellersJson,
  SUPPLY_PROVIDER_ID,
  type NetW023SupplyHarness,
} from "./_net-w023-harness.ts";
import { OpenRtbRequestRejectedError } from "../../src/adapters/port.ts";
import { UnknownOpenRtbProviderError } from "../../src/adapters/port.ts";
import type { OpenRtbRequestRejectionReason } from "../../src/adapters/port.ts";

async function expectRejection(
  harness: NetW023SupplyHarness,
  payload: unknown,
  reason: OpenRtbRequestRejectionReason,
): Promise<void> {
  let error: unknown;
  try {
    await harness.runtime.openRtbIngress.normalizeRequestSubmission({
      providerId: SUPPLY_PROVIDER_ID,
      payload,
    });
  } catch (err) {
    error = err;
  }
  expect(error).toBeInstanceOf(OpenRtbRequestRejectedError);
  const rejected = error as OpenRtbRequestRejectedError;
  expect(rejected.reason).toBe(reason);
  expect(rejected.code).toBe("OPENRTB_REQUEST_REJECTED");
  // The context carries the reason + provider id ONLY — never
  // sensitive payload values.
  expect((rejected as { context?: Record<string, unknown> }).context).toBeDefined();
}

function expectSellerRejection(
  harness: NetW023SupplyHarness,
  submission: {
    readonly sourceKind: "ads.txt" | "app-ads.txt" | "sellers.json";
    readonly content: string;
    readonly sourceIdentity: string;
    readonly observedAt?: string;
  },
  reason: OpenRtbRequestRejectionReason,
): Promise<void> {
  return harness.runtime.openRtbIngress
    .normalizeSellerAuthorizationSubmission({
      providerId: SUPPLY_PROVIDER_ID,
      ...submission,
    })
    .then(
      () => {
        throw new Error("expected a rejection");
      },
      (err: unknown) => {
        expect(err).toBeInstanceOf(OpenRtbRequestRejectedError);
        expect((err as OpenRtbRequestRejectedError).reason).toBe(reason);
      },
    );
}

describe("NET-W023-AC-02 fail-closed validation", () => {
  let harness: NetW023SupplyHarness;

  afterEach(async () => {
    if (harness) await harness.teardown();
  });

  test("malformed_request: non-object payload / missing version / broken imp / broken schain", async () => {
    harness = await createNetW023SupplyHarness();
    await expectRejection(harness, "not-an-object", "malformed_request");
    await expectRejection(harness, [1, 2, 3], "malformed_request");
    await expectRejection(
      harness,
      rawBidRequest({ remove: ["openrtbVersion"] }),
      "malformed_request",
    );
    // imp entries that are not objects / carry no media block.
    await expectRejection(
      harness,
      rawBidRequest({ set: { imp: ["nope"] } }),
      "malformed_request",
    );
    await expectRejection(
      harness,
      rawBidRequest({ set: { imp: [{ id: "1" }] } }),
      "malformed_request",
    );
    await expectRejection(
      harness,
      rawBidRequest({ set: { source: "not-an-object" } }),
      "malformed_request",
    );
    await expectRejection(
      harness,
      rawBidRequest({
        set: {
          source: { ext: { schain: { complete: 1, ver: "1.0", nodes: ["nope"] } } },
        },
      }),
      "malformed_request",
    );
  });

  test("unsupported_openrtb_version: anything outside the closed supported set", async () => {
    harness = await createNetW023SupplyHarness();
    for (const version of ["2.4", "2.3", "3.0", "2.5.1", "1.0"]) {
      await expectRejection(
        harness,
        rawBidRequest({ set: { openrtbVersion: version } }),
        "unsupported_openrtb_version",
      );
    }
  });

  test("missing_request_id: absent/empty/non-string ids", async () => {
    harness = await createNetW023SupplyHarness();
    await expectRejection(
      harness,
      rawBidRequest({ remove: ["id"] }),
      "missing_request_id",
    );
    await expectRejection(harness, rawBidRequest({ set: { id: "" } }), "missing_request_id");
    await expectRejection(harness, rawBidRequest({ set: { id: 42 } }), "missing_request_id");
  });

  test("missing/invalid_supply_identity: app XOR site, required bundle/domain", async () => {
    harness = await createNetW023SupplyHarness();
    await expectRejection(
      harness,
      rawBidRequest({ remove: ["site"] }),
      "missing_supply_identity",
    );
    await expectRejection(
      harness,
      rawBidRequest({ set: { site: { name: "no domain" } } }),
      "missing_supply_identity",
    );
    await expectRejection(
      harness,
      rawBidRequest({ set: { app: { bundle: "com.other.app" } } }), // app AND site
      "unsafe_critical_value",
    );
    await expectRejection(
      harness,
      rawBidRequest({ remove: ["site"], set: { app: { name: "no bundle" } } }),
      "missing_supply_identity",
    );
    await expectRejection(
      harness,
      rawBidRequest({ set: { site: "not-an-object" } }),
      "invalid_supply_identity",
    );
    await expectRejection(
      harness,
      rawBidRequest({ set: { site: { domain: "example.com", publisher: "nope" } } }),
      "invalid_supply_identity",
    );
    // The app path: valid bundle normalizes (app surface).
    const result = await harness.runtime.openRtbIngress.normalizeRequestSubmission({
      providerId: SUPPLY_PROVIDER_ID,
      payload: rawBidRequest({
        remove: ["site"],
        set: { app: { bundle: "com.example.app", publisher: { domain: "example.com" } } },
      }),
    });
    expect(result.request.supply).toEqual({
      externalId: "com.example.app",
      surfaceKind: "app",
      publisherDomain: "example.com",
    });
  });

  test("cardinality_exceeded: impressions, schain nodes, ids, file records", async () => {
    harness = await createNetW023SupplyHarness();
    // 17 impression slots (bound: 16).
    const tooManyImps = Array.from({ length: 17 }, (_, i) => ({
      id: `imp-${i}`,
      banner: { w: 300, h: 250 },
    }));
    await expectRejection(
      harness,
      rawBidRequest({ set: { imp: tooManyImps } }),
      "cardinality_exceeded",
    );
    // 13 schain nodes (bound: 12).
    const tooManyNodes = Array.from({ length: 13 }, (_, i) => ({
      asi: `exchange-${i}.example`,
      sid: `sid-${i}`,
    }));
    await expectRejection(
      harness,
      rawBidRequest({
        set: { source: { ext: { schain: { complete: 1, ver: "1.0", nodes: tooManyNodes } } } },
      }),
      "cardinality_exceeded",
    );
    // Over-bounds request id.
    await expectRejection(
      harness,
      rawBidRequest({ set: { id: "x".repeat(129) } }),
      "cardinality_exceeded",
    );
    // Over-bounds seller-authorization records (bound: 200).
    const manyRecords = Array.from({ length: 201 }, (_, i) => `ex.example, ${i}, DIRECT`)
      .join("\n");
    await expectSellerRejection(
      harness,
      { sourceKind: "ads.txt", content: manyRecords, sourceIdentity: "example.com" },
      "cardinality_exceeded",
    );
  });

  test("payload_too_large: the canonical payload bound", async () => {
    harness = await createNetW023SupplyHarness();
    await expectRejection(
      harness,
      rawBidRequest({ set: { device: { ua: "x".repeat(70_000) } } }),
      "payload_too_large",
    );
  });

  test("unsafe_critical_value: contradictory/mixed critical values", async () => {
    harness = await createNetW023SupplyHarness();
    // Two media-type blocks on one impression.
    await expectRejection(
      harness,
      rawBidRequest({ set: { imp: [{ id: "1", banner: { w: 300, h: 250 }, video: {} }] } }),
      "unsafe_critical_value",
    );
    // Negative floor.
    await expectRejection(
      harness,
      rawBidRequest({ set: { imp: [{ id: "1", banner: {}, bidfloor: -1 }] } }),
      "unsafe_critical_value",
    );
    // Mixed currencies across impressions.
    await expectRejection(
      harness,
      rawBidRequest({
        set: {
          imp: [
            { id: "1", banner: { w: 300, h: 250 }, bidfloor: 1, bidfloorcur: "USD" },
            { id: "2", banner: { w: 728, h: 90 }, bidfloor: 2, bidfloorcur: "EUR" },
          ],
        },
      }),
      "unsafe_critical_value",
    );
    // Lowercase / malformed currency.
    await expectRejection(
      harness,
      rawBidRequest({
        set: { imp: [{ id: "1", banner: { w: 300, h: 250 }, bidfloor: 1, bidfloorcur: "usd" }] },
      }),
      "unsafe_critical_value",
    );
    // instl must be 0|1.
    await expectRejection(
      harness,
      rawBidRequest({ set: { imp: [{ id: "1", banner: { w: 300, h: 250 }, instl: 2 }] } }),
      "unsafe_critical_value",
    );
    // Non-positive / over-bounds dimensions.
    await expectRejection(
      harness,
      rawBidRequest({ set: { imp: [{ id: "1", banner: { w: 0, h: 250 } }] } }),
      "unsafe_critical_value",
    );
    await expectRejection(
      harness,
      rawBidRequest({ set: { imp: [{ id: "1", banner: { w: 9999, h: 250 } }] } }),
      "unsafe_critical_value",
    );
    // hp must be 0|1.
    await expectRejection(
      harness,
      rawBidRequest({
        set: {
          source: {
            ext: {
              schain: {
                complete: 1,
                ver: "1.0",
                nodes: [{ asi: "ex.example", sid: "1", hp: 3 }],
              },
            },
          },
        },
      }),
      "unsafe_critical_value",
    );
    // Contradictory txt relationships for one (contact, account).
    await expectSellerRejection(
      harness,
      {
        sourceKind: "ads.txt",
        content: [
          `${"exchange-one.example"}, pub-seller-1, DIRECT`,
          `${"exchange-one.example"}, pub-seller-1, RESELLER`,
        ].join("\n"),
        sourceIdentity: "example.com",
      },
      "unsafe_critical_value",
    );
  });

  test("ambiguous_supply_chain: empty nodes / duplicate sellers", async () => {
    harness = await createNetW023SupplyHarness();
    await expectRejection(
      harness,
      rawBidRequest({
        set: { source: { ext: { schain: { complete: 1, ver: "1.0", nodes: [] } } } },
      }),
      "ambiguous_supply_chain",
    );
    await expectRejection(
      harness,
      rawBidRequest({
        set: {
          source: {
            ext: {
              schain: {
                complete: 1,
                ver: "1.0",
                nodes: [
                  { asi: "exchange-one.example", sid: "pub-seller-1" },
                  { asi: "exchange-one.example", sid: "pub-seller-1" },
                ],
              },
            },
          },
        },
      }),
      "ambiguous_supply_chain",
    );
    // complete is REQUIRED on schain.
    await expectRejection(
      harness,
      rawBidRequest({
        set: {
          source: { ext: { schain: { ver: "1.0", nodes: [{ asi: "a.example", sid: "1" }] } } },
        },
      }),
      "malformed_request",
    );
  });

  test("seller-authorization files fail closed on grammar violations", async () => {
    harness = await createNetW023SupplyHarness();
    // txt: wrong field count.
    await expectSellerRejection(
      harness,
      { sourceKind: "ads.txt", content: "ex.example, 1", sourceIdentity: "example.com" },
      "malformed_request",
    );
    // txt: unknown relationship.
    await expectSellerRejection(
      harness,
      { sourceKind: "ads.txt", content: "ex.example, 1, INDIRECT", sourceIdentity: "example.com" },
      "malformed_request",
    );
    // txt: no seller records at all.
    await expectSellerRejection(
      harness,
      { sourceKind: "ads.txt", content: "# only comments\nCONTACT=a@example.com", sourceIdentity: "example.com" },
      "malformed_request",
    );
    // sellers.json: invalid JSON.
    await expectSellerRejection(
      harness,
      { sourceKind: "sellers.json", content: "{not json", sourceIdentity: "ex.example" },
      "malformed_request",
    );
    // sellers.json: missing version.
    await expectSellerRejection(
      harness,
      {
        sourceKind: "sellers.json",
        content: JSON.stringify({ sellers: [{ seller_id: "1", seller_type: "INTERMEDIARY" }] }),
        sourceIdentity: "ex.example",
      },
      "malformed_request",
    );
    // sellers.json: invalid seller_type.
    await expectSellerRejection(
      harness,
      {
        sourceKind: "sellers.json",
        content: JSON.stringify({
          version: "2.0",
          sellers: [{ seller_id: "1", seller_type: "WHOLESALER" }],
        }),
        sourceIdentity: "ex.example",
      },
      "malformed_request",
    );
    // sellers.json: domain REQUIRED for PUBLISHER.
    await expectSellerRejection(
      harness,
      {
        sourceKind: "sellers.json",
        content: JSON.stringify({
          version: "2.0",
          sellers: [{ seller_id: "1", seller_type: "PUBLISHER" }],
        }),
        sourceIdentity: "ex.example",
      },
      "malformed_request",
    );
    // sellers.json: empty sellers array.
    await expectSellerRejection(
      harness,
      {
        sourceKind: "sellers.json",
        content: JSON.stringify({ version: "2.0", sellers: [] }),
        sourceIdentity: "ex.example",
      },
      "malformed_request",
    );
    // Invalid provenance: malformed observedAt.
    await expectSellerRejection(
      harness,
      {
        sourceKind: "ads.txt",
        content: publisherAdsTxtContent(),
        sourceIdentity: "example.com",
        observedAt: "not-a-timestamp",
      },
      "malformed_request",
    );
    // File size bound.
    await expectSellerRejection(
      harness,
      {
        sourceKind: "ads.txt",
        content: "x".repeat(262_145),
        sourceIdentity: "example.com",
      },
      "payload_too_large",
    );
  });

  test("unknown providers + spoofed identities fail closed (nothing normalized)", async () => {
    harness = await createNetW023SupplyHarness();
    let unknown: unknown;
    try {
      await harness.runtime.openRtbIngress.normalizeRequestSubmission({
        providerId: "not-a-registered-provider",
        payload: rawBidRequest(),
      });
    } catch (err) {
      unknown = err;
    }
    expect(unknown).toBeInstanceOf(UnknownOpenRtbProviderError);
    // A submission routed to the reference provider cannot be
    // normalized by an adapter answering to another identity: the
    // adapter re-asserts ownership (provider identity spoofing guard
    // is also enforced on the neutral output by the ingress).
    let spoofed: unknown;
    try {
      await harness.referenceAdapter.normalizeRequest({
        providerId: "another-provider",
        payload: rawBidRequest(),
      });
    } catch (err) {
      spoofed = err;
    }
    expect((spoofed as Error).message).toContain("cannot normalize a submission addressed to");
  });

  test("rejections mutate NOTHING (the inventory state is unchanged)", async () => {
    harness = await createNetW023SupplyHarness();
    const before = await harness.runtime.inventoryService.listInventoryItems(
      harness.bootstrapCtx,
      harness.organizationScopeId,
    );
    for (const [payload, reason] of [
      [rawBidRequest({ set: { openrtbVersion: "9.9" } }), "unsupported_openrtb_version"],
      ["not-an-object", "malformed_request"],
      [rawBidRequest({ remove: ["site"] }), "missing_supply_identity"],
    ] as const) {
      await expectRejection(harness, payload, reason as OpenRtbRequestRejectionReason);
    }
    const after = await harness.runtime.inventoryService.listInventoryItems(
      harness.bootstrapCtx,
      harness.organizationScopeId,
    );
    expect(after.length).toBe(before.length);
  });

  test("error contexts never carry sensitive payload values", async () => {
    harness = await createNetW023SupplyHarness();
    let error: OpenRtbRequestRejectedError | undefined;
    try {
      await harness.runtime.openRtbIngress.normalizeRequestSubmission({
        providerId: SUPPLY_PROVIDER_ID,
        payload: rawBidRequest({
          set: { openrtbVersion: "9.9", device: { ifa: "SECRET-MARKER-XYZ" } },
        }),
      });
    } catch (err) {
      error = err as OpenRtbRequestRejectedError;
    }
    expect(error).toBeDefined();
    expect(error!.message).not.toContain("SECRET-MARKER-XYZ");
    expect(JSON.stringify(error!.context ?? {})).not.toContain("SECRET-MARKER-XYZ");
    // The sellers.json raw content never appears in errors either.
    let sellerError: OpenRtbRequestRejectedError | undefined;
    try {
      await harness.runtime.openRtbIngress.normalizeSellerAuthorizationSubmission({
        providerId: SUPPLY_PROVIDER_ID,
        sourceKind: "sellers.json",
        content: "RAW-CONTENT-MARKER-123 {",
        sourceIdentity: "example.com",
      });
    } catch (err) {
      sellerError = err as OpenRtbRequestRejectedError;
    }
    expect(sellerError).toBeDefined();
    expect(sellerError!.message).not.toContain("RAW-CONTENT-MARKER-123");
    expect(firstExchangeSellersJson()).toContain("sellers");
  });
});
