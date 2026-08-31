/**
 * NET-W023-AC-01 — the provider-neutral OpenRTB contract (issue #46).
 *
 * The neutral contract is versioned, bounded and contains ONLY the
 * protocol facts OpenCon needs: vendor field containment is pinned by
 * normalizing a request that CARRIES sensitive vendor fields and
 * asserting the exact neutral key set. Provider identity is enforced
 * at the registry (one adapter per provider, closed kind) and the
 * default runtime wires the reference adapter while the measurement
 * registry default stays echo-only (the W006 default is UNCHANGED);
 * the delivery-notice adapter auto-wires only with its secret.
 */

import { describe, test, expect, afterEach } from "bun:test";
import { createRuntime } from "../../src/bootstrap/runtime.ts";
import {
  createNetW023SupplyHarness,
  rawBidRequest,
  type NetW023SupplyHarness,
} from "./_net-w023-harness.ts";
import { createOpenRtbProviderRegistry } from "../../src/adapters/registry.ts";
import {
  OpenRtbReferenceAdapter,
  OPENRTB_REFERENCE_PROVIDER_ID,
} from "../../src/adapters/openrtb/reference-adapter.ts";
import {
  MEASUREMENT_REPORT_REJECTION_REASONS,
} from "../../src/measurement/port.ts";
import {
  OPENRTB_ADAPTER_CONTRACT_VERSION,
  OPENRTB_SUPPORTED_VERSIONS,
  OPENRTB_MAX_IMPRESSIONS,
  OPENRTB_MAX_SCHAIN_NODES,
  SELLER_AUTHORIZATION_INTEGRITY_ALGORITHM,
  SELLER_RELATIONSHIP_KINDS,
  SUPPLY_CHAIN_MAX_AGE_MS,
} from "../../src/adapters/port.ts";

const NEUTRAL_REQUEST_KEYS = [
  "providerId",
  "requestId",
  "openrtbVersion",
  "supply",
  "impressions",
  "floorPrice",
  "supplyChain",
  "digest",
] as const;

describe("NET-W023-AC-01 the provider-neutral contract", () => {
  let harness: NetW023SupplyHarness;

  afterEach(async () => {
    if (harness) await harness.teardown();
  });

  test("the contract is versioned + the closed vocabularies/bounds are pinned", () => {
    expect(OPENRTB_ADAPTER_CONTRACT_VERSION).toBe("NET-W023:1");
    expect([...OPENRTB_SUPPORTED_VERSIONS]).toEqual(["2.5", "2.6"]);
    expect(OPENRTB_MAX_IMPRESSIONS).toBe(16);
    expect(OPENRTB_MAX_SCHAIN_NODES).toBe(12);
    expect(SELLER_RELATIONSHIP_KINDS).toEqual([
      "direct",
      "reseller",
      "publisher",
      "intermediary",
      "both",
    ]);
    expect(SUPPLY_CHAIN_MAX_AGE_MS).toBe(48 * 60 * 60 * 1000);
    // PR #47 remediation: the trust-envelope algorithm is pinned (the
    // closed integrity vocabulary — HMAC-SHA256, no vendor SDK).
    expect(SELLER_AUTHORIZATION_INTEGRITY_ALGORITHM).toBe("hmac-sha256");
    // The frozen W022 vocabulary is unchanged (cross-boundary pin).
    expect(MEASUREMENT_REPORT_REJECTION_REASONS).toHaveLength(7);
  });

  test("the normalized request contains ONLY neutral protocol facts (vendor containment)", async () => {
    harness = await createNetW023SupplyHarness();
    const result = await harness.runtime.openRtbIngress.normalizeRequestSubmission({
      providerId: OPENRTB_REFERENCE_PROVIDER_ID,
      payload: rawBidRequest(),
    });
    // The exact neutral key set — bounded, versioned.
    expect(Object.keys(result.request).sort()).toEqual([...NEUTRAL_REQUEST_KEYS].sort());
    // The neutral facts.
    expect(result.request.requestId).toBe("w023-request-1");
    expect(result.request.openrtbVersion).toBe("2.5");
    expect(result.request.supply).toEqual({
      externalId: "example.com",
      surfaceKind: "publisher",
      publisherDomain: "example.com",
    });
    expect(result.request.impressions).toEqual([
      { id: "1", format: "display", interstitial: false, width: 300, height: 250 },
    ]);
    // The floor price is an ECONOMIC FACT (never a ledger mutation).
    expect(result.request.floorPrice).toEqual({ amount: 1.25, currency: "USD" });
    // The supply chain is normalized (bounded nodes).
    expect(result.request.supplyChain!.complete).toBe(true);
    expect(result.request.supplyChain!.version).toBe("1.0");
    expect(result.request.supplyChain!.nodes).toHaveLength(2);
    // NO vendor field crosses: the sensitive VALUES never appear and
    // only their NAMES are reported.
    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain("opaque-device-id-123");
    expect(serialized).not.toContain("opaque-user-id-456");
    expect(serialized).not.toContain("192.0.2.1");
    expect(result.redactedFieldNames).toContain("device");
    expect(result.redactedFieldNames).toContain("user");
    expect(result.redactedFieldNames).toContain("regs");
    expect(result.redactedFieldNames).toContain("ext");
    // The provider version is attached at the ingress boundary.
    expect(result.providerVersion).toBe("1.0.0");
  });

  test("the registry enforces one adapter per provider identity (closed kind, fail closed)", () => {
    const registry = createOpenRtbProviderRegistry();
    const adapter = new OpenRtbReferenceAdapter();
    registry.register(adapter);
    expect(registry.byProviderId(OPENRTB_REFERENCE_PROVIDER_ID)).toBe(adapter);
    expect(registry.list()).toHaveLength(1);
    // Duplicate provider identity fails closed.
    let duplicate: unknown;
    try {
      registry.register(new OpenRtbReferenceAdapter());
    } catch (err) {
      duplicate = err;
    }
    expect((duplicate as Error).message).toContain("already registered");
    // Wrong kind fails closed.
    const wrongKind = {
      info: { kind: "measurement", provider: "x", version: "1.0.0" },
      initialize: async () => {},
      healthCheck: async () => ({ ok: true }),
      normalizeRequest: async () => {
        throw new Error("unreachable");
      },
      normalizeSellerAuthorization: async () => {
        throw new Error("unreachable");
      },
    };
    let kindError: unknown;
    try {
      registry.register(wrongKind as never);
    } catch (err) {
      kindError = err;
    }
    expect((kindError as Error).message).toContain('info.kind must be "openrtb"');
  });

  test("the default runtime wires the reference adapter + the measurement registry stays echo-only (W006 default UNCHANGED)", async () => {
    harness = await createNetW023SupplyHarness();
    // The OpenRTB ingress is wired with the reference adapter.
    expect(harness.runtime.openRtbProviders).toHaveLength(1);
    expect(harness.runtime.openRtbProviders[0]!.info).toEqual({
      kind: "openrtb",
      provider: OPENRTB_REFERENCE_PROVIDER_ID,
      version: "1.0.0",
    });
    // No secret configured → the delivery-notice adapter is NOT
    // auto-wired into the measurement registry (the W006 default is
    // echo-only; pushed notices fail closed without the secret).
    const measurementProviderIds = harness.runtime.measurementProviders.map(
      (provider) => provider.info.provider,
    );
    expect(measurementProviderIds).toEqual(["echo"]);
  });

  test("the delivery-notice adapter auto-wires ONLY with its secret (SecretProvider boundary)", async () => {
    const runtime = createRuntime({
      forceEnv: "test",
      env: {
        APP_ENV: "test",
        LOG_LEVEL: "fatal",
        MEASUREMENT_OPENRTB_DELIVERY_KEY: "test-only-secret",
      },
      port: 0,
    });
    await runtime.initialize();
    try {
      const ids = runtime.measurementProviders.map((p) => p.info.provider);
      expect(ids).toContain("openrtb-delivery");
    } finally {
      await runtime.shutdown();
    }
    // And without the secret the default stays echo-only.
    const bare = createRuntime({
      forceEnv: "test",
      env: { APP_ENV: "test", LOG_LEVEL: "fatal" },
      port: 0,
    });
    await bare.initialize();
    try {
      expect(bare.measurementProviders.map((p) => p.info.provider)).toEqual(["echo"]);
    } finally {
      await bare.shutdown();
    }
  });

  test("PR #47 remediation: the seller-authorization trust channel wires ONLY with its secret (SecretProvider boundary)", async () => {
    // The secret present → the trust channel is configured.
    const withSecret = createRuntime({
      forceEnv: "test",
      env: {
        APP_ENV: "test",
        LOG_LEVEL: "fatal",
        SELLER_AUTHORIZATION_TRUST_KEY: "test-only-trust-secret",
      },
      port: 0,
    });
    await withSecret.initialize();
    try {
      expect(withSecret.openRtbSellerAuthorizationTrust).toEqual({
        configured: true,
        algorithm: "hmac-sha256",
      });
    } finally {
      await withSecret.shutdown();
    }
    // No secret → the trust channel is NOT configured: nothing can
    // authenticate and no chain can be `verified` (fail closed — the
    // default-runtime remediation semantics).
    const bare = createRuntime({
      forceEnv: "test",
      env: { APP_ENV: "test", LOG_LEVEL: "fatal" },
      port: 0,
    });
    await bare.initialize();
    try {
      expect(bare.openRtbSellerAuthorizationTrust.configured).toBe(false);
    } finally {
      await bare.shutdown();
    }
    // And an explicit composition override configures it without the
    // secret (test/operator wiring).
    const overridden = createRuntime({
      forceEnv: "test",
      env: { APP_ENV: "test", LOG_LEVEL: "fatal" },
      port: 0,
      adapters: { sellerAuthorizationTrustKey: "operator-channel-key" },
    });
    await overridden.initialize();
    try {
      expect(overridden.openRtbSellerAuthorizationTrust.configured).toBe(true);
    } finally {
      await overridden.shutdown();
    }
  });

  test("an explicit openRtbProviders override replaces the default wiring", async () => {
    const custom = new OpenRtbReferenceAdapter({ provider: "custom-exchange" });
    const runtime = createRuntime({
      forceEnv: "test",
      env: { APP_ENV: "test", LOG_LEVEL: "fatal" },
      port: 0,
      adapters: { openRtbProviders: [custom] },
    });
    await runtime.initialize();
    try {
      expect(runtime.openRtbProviders).toHaveLength(1);
      expect(runtime.openRtbProviders[0]!.info.provider).toBe("custom-exchange");
      // The default reference adapter is NOT registered alongside.
      expect(
        runtime.openRtbIngress !== undefined && runtime.openRtbProviders[0] === custom,
      ).toBe(true);
    } finally {
      await runtime.shutdown();
    }
  });
});
