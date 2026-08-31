/**
 * NET-W023-AC-06 — determinism and privacy (issue #46; work order
 * §3.6).
 *
 * Normalization is reproducible for identical inputs (including
 * field-order independence via the canonical serialization); the
 * admission evaluation is deterministic given the explicit evaluation
 * anchor. Raw payloads are NOT retained by default; sensitive vendor
 * values and secrets never appear in normalized records, logs, audit
 * payloads or error contexts; redaction summaries contain field NAMES
 * only and are bounded.
 */

import { describe, test, expect, afterEach } from "bun:test";
import {
  createNetW023SupplyHarness,
  createNetW023NoticeHarness,
  rawBidRequest,
  rawDeliveryNotice,
  verifyingAuthorizations,
  registerExternalSupply,
  evaluateRequest,
  submitNotice,
  publisherAdsTxtContent,
  EVALUATED_AT,
  OPENRTB_DELIVERY_TEST_SECRET,
  type NetW023SupplyHarness,
  type NetW023NoticeHarness,
} from "./_net-w023-harness.ts";
import { computeCanonicalDigest } from "../../src/adapters/openrtb/canonical-json.ts";
import { createMeasuredSubject } from "../outcomes/_net-w006-harness.ts";

describe("NET-W023-AC-06 determinism and privacy", () => {
  let supplyHarness: NetW023SupplyHarness;
  let noticeHarness: NetW023NoticeHarness;

  afterEach(async () => {
    if (supplyHarness) await supplyHarness.teardown();
    if (noticeHarness) await noticeHarness.teardown();
  });

  test("normalization is deterministic: identical payloads produce IDENTICAL facts + digests", async () => {
    supplyHarness = await createNetW023SupplyHarness();
    const a = await supplyHarness.runtime.openRtbIngress.normalizeRequestSubmission({
      providerId: "openrtb-reference",
      payload: rawBidRequest(),
    });
    const b = await supplyHarness.runtime.openRtbIngress.normalizeRequestSubmission({
      providerId: "openrtb-reference",
      payload: rawBidRequest(),
    });
    expect(b.request).toEqual(a.request);
    expect(b.redactedFieldNames).toEqual(a.redactedFieldNames);
    // The digest recomputes from the canonical raw payload.
    expect(a.request.digest).toBe(computeCanonicalDigest(rawBidRequest()));
  });

  test("field-order independence: shuffled keys produce the SAME canonical digest", async () => {
    supplyHarness = await createNetW023SupplyHarness();
    const a = await supplyHarness.runtime.openRtbIngress.normalizeRequestSubmission({
      providerId: "openrtb-reference",
      payload: rawBidRequest(),
    });
    // The same payload with every object's keys in a DIFFERENT order
    // (canonical sorted-key serialization is order-independent).
    const shuffled: Record<string, unknown> = {
      bcat: ["IAB1-1"],
      badv: ["blocklisted.example"],
      ext: { vendor: "opaque-extension" },
      regs: { coppa: 0 },
      device: { ip: "192.0.2.1", ifa: "opaque-device-id-123", ua: "Mozilla/5.0" },
      user: { id: "opaque-user-id-456" },
      source: {
        ext: {
          schain: {
            nodes: [
              { rid: "w023-request-1", name: "Exchange One", hp: 1, sid: "pub-seller-1", asi: "exchange-one.example" },
              { name: "Exchange Two", hp: 1, sid: "inter-seller-7", asi: "exchange-two.example" },
            ],
            ver: "1.0",
            complete: 1,
          },
        },
      },
      site: {
        publisher: { name: "Example Publisher", domain: "example.com" },
        name: "Example Publisher",
        domain: "example.com",
      },
      imp: [{ bidfloorcur: "USD", bidfloor: 1.25, banner: { h: 250, w: 300 }, id: "1" }],
      id: "w023-request-1",
      openrtbVersion: "2.5",
    };
    const b = await supplyHarness.runtime.openRtbIngress.normalizeRequestSubmission({
      providerId: "openrtb-reference",
      payload: shuffled,
    });
    expect(b.request.digest).toBe(a.request.digest);
    expect(b.request).toEqual(a.request);
  });

  test("the evaluation is deterministic given the explicit anchor (and only the anchor moves without one)", async () => {
    supplyHarness = await createNetW023SupplyHarness();
    await registerExternalSupply(supplyHarness);
    const input = {
      request: rawBidRequest(),
      sellerAuthorizations: verifyingAuthorizations(),
      evaluatedAt: EVALUATED_AT,
    };
    const a = await evaluateRequest(supplyHarness, input);
    const b = await evaluateRequest(supplyHarness, input);
    expect(b).toEqual(a);
    // Without an explicit anchor the evaluation-time instant differs —
    // and NOTHING else does (the derivation is stable).
    const c = await evaluateRequest(supplyHarness, {
      ...input,
      evaluatedAt: "2026-09-01T12:00:01.000Z",
    });
    expect({ ...c, evaluatedAt: null }).toEqual({ ...a, evaluatedAt: null });
    expect(c.evaluatedAt).not.toBe(a.evaluatedAt);
  });

  test("raw payloads are NOT retained: no raw request content in the evaluation, logs or audit", async () => {
    supplyHarness = await createNetW023SupplyHarness();
    await registerExternalSupply(supplyHarness);
    const marker = "RAW-PAYLOAD-MARKER-XYZ";
    const evaluation = await evaluateRequest(supplyHarness, {
      request: rawBidRequest({
        set: {
          device: { ip: "192.0.2.1", ifa: marker, ua: "Mozilla/5.0" },
          user: { id: marker },
        },
      }),
      sellerAuthorizations: verifyingAuthorizations({
        adsTxtContent: `${"exchange-one.example"}, pub-seller-1, DIRECT`,
      }),
      evaluatedAt: EVALUATED_AT,
    });
    expect(evaluation.admitted).toBe(true);
    // The normalized facts never carry the raw vendor values.
    const serialized = JSON.stringify(evaluation);
    expect(serialized).not.toContain(marker);
    expect(serialized).not.toContain("192.0.2.1");
    expect(serialized).not.toContain("Mozilla");
    // Logs never carry the raw vendor values.
    const logs = JSON.stringify(supplyHarness.runtime.logSink.entries);
    expect(logs).not.toContain(marker);
    expect(logs).not.toContain("192.0.2.1");
    // The audit trail never carries the raw vendor values (the
    // evaluation emits no audit events at all).
    const audit = JSON.stringify(
      await supplyHarness.runtime.auditWriter.query({ limit: 1000 }),
    );
    expect(audit).not.toContain(marker);
  });

  test("redaction summaries carry NAMES only and are bounded (24)", async () => {
    supplyHarness = await createNetW023SupplyHarness();
    const overbroad: Record<string, unknown> = {};
    for (let i = 0; i < 30; i += 1) {
      overbroad[`vendorExtra${i}`] = `value-${i}`;
    }
    const result = await supplyHarness.runtime.openRtbIngress.normalizeRequestSubmission({
      providerId: "openrtb-reference",
      payload: rawBidRequest({ set: overbroad }),
    });
    // Bounded at 24 names — and the VALUES never cross.
    expect(result.redactedFieldNames.length).toBeLessThanOrEqual(24);
    expect(result.redactedFieldNames).toContain("device");
    expect(result.redactedFieldNames).toContain("user");
    const serialized = JSON.stringify(result);
    for (let i = 0; i < 30; i += 1) {
      expect(serialized).not.toContain(`value-${i}`);
    }
  });

  test("the delivery-notice path: raw notice content + secrets never appear in observations, logs or errors", async () => {
    noticeHarness = await createNetW023NoticeHarness();
    const subject = await createMeasuredSubject(noticeHarness.w006);
    const view = await submitNotice(noticeHarness, {
      notice: rawDeliveryNotice(),
      idempotencyKey: "ac06-notice",
      subjectId: subject.id,
    });
    expect(view.providerId).toBe("openrtb-delivery");
    // The redacted vendor fields are reported by NAME only.
    expect(view.redactedFieldNames).toContain("device");
    expect(view.redactedFieldNames).toContain("user");
    expect(view.redactedFieldNames).toContain("vendorExtensions");
    // The persisted observation carries NO raw notice values (the
    // neutral contract fields only — W022 minimization reused).
    const serialized = JSON.stringify(view);
    expect(serialized).not.toContain("opaque-device-id-123");
    expect(serialized).not.toContain("opaque-user-id-456");
    expect(serialized).not.toContain("experimentBucket");
    // The submission view never carries the verification secret.
    expect(serialized).not.toContain(OPENRTB_DELIVERY_TEST_SECRET);
    // The observation chain (persisted state) carries no raw content.
    const stored = await noticeHarness.runtime.outcomeObservationService.getOutcomeObservation(
      noticeHarness.w006.bootstrapCtx,
      view.observation.id,
    );
    expect(JSON.stringify(stored)).not.toContain("opaque-device-id-123");
    // Logs: no raw notice content, no verification secret.
    const logs = JSON.stringify(noticeHarness.runtime.logSink.entries);
    expect(logs).not.toContain("opaque-device-id-123");
    expect(logs).not.toContain(OPENRTB_DELIVERY_TEST_SECRET);
    // Audit: no raw notice content, no secret.
    const audit = JSON.stringify(
      await noticeHarness.runtime.auditWriter.query({ limit: 1000 }),
    );
    expect(audit).not.toContain("opaque-device-id-123");
    expect(audit).not.toContain(OPENRTB_DELIVERY_TEST_SECRET);
  });

  test("a tampered notice fails closed WITHOUT leaking the secret or raw content", async () => {
    noticeHarness = await createNetW023NoticeHarness();
    const subject = await createMeasuredSubject(noticeHarness.w006);
    const tampered = rawDeliveryNotice();
    tampered["observedValue"] = { value: 999, unit: "impressions" };
    let error: unknown;
    try {
      await submitNotice(noticeHarness, {
        notice: tampered,
        idempotencyKey: "ac06-tampered",
        subjectId: subject.id,
      });
    } catch (err) {
      error = err;
    }
    expect((error as Error).message).toContain("report rejected");
    const errorSerialized = JSON.stringify(
      (error as { context?: Record<string, unknown> }).context ?? {},
    );
    expect(errorSerialized).not.toContain(OPENRTB_DELIVERY_TEST_SECRET);
    expect(errorSerialized).not.toContain("opaque-device-id-123");
    // Nothing persisted for the rejected notice.
    const listed =
      await noticeHarness.runtime.outcomeObservationService.listObservationsBySubject(
        noticeHarness.w006.bootstrapCtx,
        subject.id,
      );
    expect(listed.length).toBe(0);
  });

  test("the seller-authorization file content never crosses the boundary (facts + names only)", async () => {
    supplyHarness = await createNetW023SupplyHarness();
    const result = await supplyHarness.runtime.openRtbIngress
      .normalizeSellerAuthorizationSubmission({
        providerId: "openrtb-reference",
        sourceKind: "ads.txt",
        content: publisherAdsTxtContent(),
        sourceIdentity: "example.com",
        observedAt: "2026-09-01T11:00:00.000Z",
      });
    const serialized = JSON.stringify(result);
    // The raw file text (contact email, comments) never crosses.
    expect(serialized).not.toContain("admin@example.com");
    expect(serialized).not.toContain("# authorized sellers");
    expect(serialized).not.toContain("cert-123");
    // Only the records + provenance + digest cross.
    expect(result.facts.records).toHaveLength(2);
  });
});
