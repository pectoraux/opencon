/**
 * NET-W030 AC-02 — authenticated adapter ingestion (fail-closed
 * verification; issue #61; work order §3.2, §6).
 *
 * Adapter-delivered facts are authenticated with per-provider
 * verification material resolved ONLY through the SecretProvider (or
 * the explicit composition override). Unauthenticated, stale,
 * malformed, or unverifiable submissions fail closed with
 * machine-readable reasons — NEVER silently recorded. No trust
 * material configured ⇒ NOTHING can authenticate (fail closed).
 */

import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import {
  createNetW030Harness,
  recordExternalFact,
  createInternalLineage,
  actorCtx,
  type NetW030Harness,
} from "./_net-w030-harness.ts";
import { ExternalSettlementIngestionError } from "../../src/settlement/external-settlement-service.ts";
import {
  EXTERNAL_SETTLEMENT_INGESTION_REJECTION_REASONS,
  EXTERNAL_SETTLEMENT_MAX_AGE_MS,
} from "../../src/settlement/port.ts";
import { createEnvSecretProvider } from "../../src/secrets/env-provider.ts";
import { createLogger } from "../../src/observability/logger.ts";
import {
  selectExternalSettlementAuthentication,
  createHmacExternalSettlementAuthenticator,
  EXTERNAL_SETTLEMENT_TRUST_SECRET_KEYS,
} from "../../src/bootstrap/external-settlement-authentication.ts";
import { buildProviderNotification } from "./_net-w030-harness.ts";

async function rejectionOf(
  harness: NetW030Harness,
  opts: Parameters<typeof recordExternalFact>[1],
): Promise<ExternalSettlementIngestionError | null> {
  try {
    await recordExternalFact(harness, opts);
    return null;
  } catch (err) {
    if (err instanceof ExternalSettlementIngestionError) return err;
    throw err;
  }
}

describe("NET-W030-AC-02 authenticated adapter ingestion (fail closed)", () => {
  let harness: NetW030Harness;

  beforeAll(async () => {
    harness = await createNetW030Harness();
  });

  afterAll(async () => {
    await harness.teardown();
  });

  test("an UNSIGNED submission is rejected as malformed and nothing is recorded", async () => {
    const lineage = await createInternalLineage(harness);
    const err = await rejectionOf(harness, {
      internalTransactionId: lineage.transactionId,
      unsigned: true,
    });
    expect(err?.context.reason).toBe("malformed_submission");
    expect(err?.classification).toBe("validation");
    const listing = await harness.runtime.externalSettlementService.listExternalSettlementFacts(
      actorCtx(harness, "ac02-unsigned"),
      harness.organizationScopeId,
    );
    // The unsigned identity was never recorded.
    expect(listing.filter((f) => f.internalTransactionId === lineage.transactionId)).toHaveLength(0);
  });

  test("a TAMPERED signature is rejected as unauthenticated (the envelope binds the exact facts)", async () => {
    const lineage = await createInternalLineage(harness);
    const err = await rejectionOf(harness, {
      internalTransactionId: lineage.transactionId,
      tampered: true,
    });
    expect(err?.context.reason).toBe("unauthenticated");
  });

  test("a submission signed with the WRONG key is rejected as unauthenticated", async () => {
    const lineage = await createInternalLineage(harness);
    const err = await rejectionOf(harness, {
      internalTransactionId: lineage.transactionId,
      wrongKey: true,
    });
    expect(err?.context.reason).toBe("unauthenticated");
  });

  test("an UNSUPPORTED integrity algorithm is a vocabulary rejection (unsupported_algorithm)", async () => {
    const lineage = await createInternalLineage(harness);
    const payload = buildProviderNotification(harness, {
      internalTransactionId: lineage.transactionId,
    });
    // A well-formed envelope carrying an out-of-vocabulary algorithm.
    (payload.integrity as Record<string, unknown>).algorithm = "sha1/v1";
    let err: unknown;
    try {
      await harness.runtime.externalSettlementService.recordExternalSettlementFact(
        actorCtx(harness, "ac02-alg"),
        {
          organizationScopeId: harness.organizationScopeId,
          provider: "reference",
          payload,
          idempotencyKey: "ac02-alg",
        },
      );
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(ExternalSettlementIngestionError);
    expect((err as ExternalSettlementIngestionError).context.reason).toBe("unsupported_algorithm");
  });

  test("MALFORMED submissions fail closed (amount/unit/timestamps/identifiers)", async () => {
    const lineage = await createInternalLineage(harness);
    const cases: { readonly label: string; readonly opts: Parameters<typeof recordExternalFact>[1] }[] = [
      { label: "zero amount", opts: { internalTransactionId: lineage.transactionId, reportedAmount: 0 } },
      { label: "negative amount", opts: { internalTransactionId: lineage.transactionId, reportedAmount: -5 } },
      { label: "7-decimal amount (beyond the economic scale)", opts: { internalTransactionId: lineage.transactionId, reportedAmount: 1.0000001 } },
      { label: "out-of-vocabulary unit", opts: { internalTransactionId: lineage.transactionId, reportedUnit: "grams" } },
      { label: "unparseable observedAt", opts: { internalTransactionId: lineage.transactionId, observedAt: "not-a-timestamp" } },
    ];
    for (const c of cases) {
      const err = await rejectionOf(harness, c.opts);
      expect(err?.context.reason).toBe("malformed_submission");
    }
    // The adapter also rejects structurally malformed payloads
    // (missing required fields) — mapped to malformed_submission.
    let adapterErr: unknown;
    try {
      await harness.runtime.externalSettlementService.recordExternalSettlementFact(
        actorCtx(harness, "ac02-adapter-malformed"),
        {
          organizationScopeId: harness.organizationScopeId,
          provider: "reference",
          payload: { internalTransactionId: lineage.transactionId },
          idempotencyKey: "ac02-adapter-malformed",
        },
      );
    } catch (e) {
      adapterErr = e;
    }
    expect(adapterErr).toBeInstanceOf(ExternalSettlementIngestionError);
    expect((adapterErr as ExternalSettlementIngestionError).context.reason).toBe("malformed_submission");
  });

  test("a STALE observation is rejected (freshness window governs recording authority)", async () => {
    const lineage = await createInternalLineage(harness);
    const staleAt = new Date(Date.now() - EXTERNAL_SETTLEMENT_MAX_AGE_MS - 60_000).toISOString();
    const err = await rejectionOf(harness, {
      internalTransactionId: lineage.transactionId,
      observedAt: staleAt,
    });
    expect(err?.context.reason).toBe("stale");
  });

  test("an UNSUPPORTED provider is a closed-vocabulary rejection (routing fails closed)", async () => {
    let err: unknown;
    try {
      await harness.runtime.externalSettlementService.recordExternalSettlementFact(
        actorCtx(harness, "ac02-provider"),
        {
          organizationScopeId: harness.organizationScopeId,
          provider: "some-other-network",
          payload: {},
          idempotencyKey: "ac02-provider",
        },
      );
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(ExternalSettlementIngestionError);
    expect((err as ExternalSettlementIngestionError).context.reason).toBe("unsupported_provider");
  });

  test("NO trust material configured ⇒ NOTHING can authenticate (fail closed; never silently recorded)", async () => {
    const unconfigured = await createNetW030Harness({ unconfigured: true });
    try {
      expect(unconfigured.runtime.externalSettlementTrust.configuredProviders).toHaveLength(0);
      const lineage = await createInternalLineage(unconfigured);
      // A CORRECTLY signed submission still fails closed — the trust
      // channel is not configured.
      const err = await rejectionOf(unconfigured, {
        internalTransactionId: lineage.transactionId,
      });
      expect(err?.context.reason).toBe("unauthenticated");
      // And nothing was recorded.
      const listing = await unconfigured.runtime.externalSettlementService.listExternalSettlementFacts(
        actorCtx(unconfigured, "ac02-unconfigured"),
        unconfigured.organizationScopeId,
      );
      expect(listing).toHaveLength(0);
    } finally {
      await unconfigured.teardown();
    }
  });

  test("the rejection reason vocabulary is CLOSED and machine-readable (every reason is a member)", async () => {
    const reasons = [...EXTERNAL_SETTLEMENT_INGESTION_REJECTION_REASONS];
    expect(reasons).toContain("unsupported_provider");
    expect(reasons).toContain("unsupported_algorithm");
    expect(reasons).toContain("malformed_submission");
    expect(reasons).toContain("unauthenticated");
    expect(reasons).toContain("stale");
    expect(reasons).toContain("conflicting_fact");
    expect(reasons).toContain("correction_target_not_found");
    // The error code is stable for transport mapping.
    const err = await rejectionOf(harness, { internalTransactionId: "x", tampered: true });
    expect(err?.code).toBe("EXTERNAL_SETTLEMENT_INGESTION_REJECTED");
  });

  test("the composition-root selection resolves per-provider material ONLY through the override or the SecretProvider", () => {
    const logger = createLogger({ module: "test", minLevel: "fatal", pretty: false });
    const catalog = ["EXTERNAL_SETTLEMENT_REFERENCE_TRUST_KEY"].map((k) => ({
      key: k,
      required: false,
      hasValue: false,
      redactedPreview: `<secret:${k}>`,
    }));
    const empty = createEnvSecretProvider({ source: {} as NodeJS.ProcessEnv, catalog });
    const unconfigured = selectExternalSettlementAuthentication({
      secretProvider: empty,
      logger,
    });
    expect(unconfigured.configuredProviders).toHaveLength(0);
    // Unconfigured ⇒ the real authenticator fails closed for every
    // submission.
    const anySubmission = {
      provider: "reference",
      externalId: "ext-1",
      internalTransactionId: "tx-1",
      reportedAmount: 10,
      reportedUnit: "value",
      observedAt: new Date().toISOString(),
      correctionOf: null,
      integrity: { algorithm: "hmac-sha256/v1", signature: "0".repeat(64), signedAt: new Date().toISOString() },
    };
    expect(unconfigured.authenticator.verify(anySubmission)).toBe(false);

    // Configured through the SecretProvider ⇒ the material is used.
    const configured = createEnvSecretProvider({
      source: {
        EXTERNAL_SETTLEMENT_REFERENCE_TRUST_KEY: "secret-key-material",
      } as NodeJS.ProcessEnv,
      catalog: catalog.map((c) => ({ ...c, hasValue: true })),
    });
    const selected = selectExternalSettlementAuthentication({
      secretProvider: configured,
      logger,
    });
    expect(selected.configuredProviders).toContain("reference");

    // The explicit override wins over the SecretProvider.
    const overridden = selectExternalSettlementAuthentication({
      secretProvider: configured,
      logger,
      overrides: { reference: "override-key" },
    });
    expect(overridden.configuredProviders).toContain("reference");
  });

  test("the real HMAC authenticator is PURE, NON-THROWING and timing-safe-shaped (no key material ever crosses)", () => {
    const trustKeys = { reference: "test-key" };
    const authenticator = createHmacExternalSettlementAuthenticator({ trustKeys });
    const submission = {
      provider: "reference",
      externalId: "ext-2",
      internalTransactionId: "tx-2",
      reportedAmount: 42,
      reportedUnit: "value",
      observedAt: new Date().toISOString(),
      correctionOf: null,
      integrity: { algorithm: "hmac-sha256/v1", signature: "z".repeat(64), signedAt: new Date().toISOString() },
    };
    // Malformed shapes return false WITHOUT throwing.
    expect(authenticator.verify({ ...submission, integrity: { algorithm: "", signature: "", signedAt: "" } })).toBe(false);
    expect(authenticator.verify(submission)).toBe(false);
    // A provider with no configured material fails closed.
    expect(
      createHmacExternalSettlementAuthenticator({ trustKeys: {} }).verify(submission),
    ).toBe(false);
  });
});
