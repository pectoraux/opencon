/**
 * NET-W023-AC-07 — tenancy/idempotency/transaction lineage (issue
 * #46; work order §3.7).
 *
 * The ONE material adapter-to-domain operation (the sanctioned
 * measurement routing path) preserves every convention: the delivery
 * notice flows through the EXISTING W022 authoritative ingestion
 * composite (`submitMeasurementReport` → /measurement normalization
 * → /outcomes persistence) — tenant-scoped, guard-authorized,
 * exactly-once-per-key, concurrency-safe, atomically audited. The
 * evaluation route is guarded (403/200/400) and performs NO material
 * mutation at all.
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
  EVALUATED_AT,
  type NetW023SupplyHarness,
  type NetW023NoticeHarness,
} from "./_net-w023-harness.ts";
import { createMeasuredSubject, actorCtx } from "../outcomes/_net-w006-harness.ts";
import { createRuntime } from "../../src/bootstrap/runtime.ts";

describe("NET-W023-AC-07 tenancy / idempotency / transaction lineage", () => {
  let supplyHarness: NetW023SupplyHarness;
  let noticeHarness: NetW023NoticeHarness;

  afterEach(async () => {
    if (supplyHarness) await supplyHarness.teardown();
    if (noticeHarness) await noticeHarness.teardown();
  });

  test("the delivery notice persists through the /outcomes authority with ONE atomic audit event", async () => {
    noticeHarness = await createNetW023NoticeHarness();
    const subject = await createMeasuredSubject(noticeHarness.w006);
    const view = await submitNotice(noticeHarness, {
      notice: rawDeliveryNotice(),
      idempotencyKey: "ac07-atomic",
      subjectId: subject.id,
    });
    expect(view.created).toBe(true);
    // Durable through the authoritative store, with provider
    // provenance (the neutral measurement contract fields).
    const stored = await noticeHarness.runtime.outcomeObservationService.getOutcomeObservation(
      actorCtx(noticeHarness.w006, "ac07-read"),
      view.observation.id,
    );
    expect(stored).toBeDefined();
    expect(stored.externalSubjectRef).toBe("ext-openrtb-subject-7");
    expect(stored.provenance.sourceType).toBe("provider");
    expect(stored.provenance.sourceId).toBe("openrtb-delivery");
    expect(stored.observedValue).toEqual({ value: 1, unit: "impressions" });
    // Exactly ONE audit event, committed atomically with the
    // mutation, carrying the provider ingestion metadata +
    // idempotency/transaction lineage.
    const events = await noticeHarness.runtime.auditWriter.query({
      eventType: "outcome_observation.created",
      resourceId: view.observation.id,
    });
    expect(events.length).toBe(1);
    const metadata = events[0]!.metadata as Record<string, unknown>;
    expect(metadata).toMatchObject({
      ingestedFromProvider: "openrtb-delivery",
      organizationScopeId: noticeHarness.organizationScopeId,
      subjectId: subject.id,
      subjectType: "contribution",
      outcomeType: "view",
      sourceType: "provider",
    });
    expect(typeof metadata["idempotencyRecordId"]).toBe("string");
    expect(typeof metadata["transactionId"]).toBe("string");
  });

  test("exactly-once-per-key: deterministic replay (created: false, same observation, no duplicate)", async () => {
    noticeHarness = await createNetW023NoticeHarness();
    const subject = await createMeasuredSubject(noticeHarness.w006);
    const first = await submitNotice(noticeHarness, {
      notice: rawDeliveryNotice(),
      idempotencyKey: "ac07-replay",
      subjectId: subject.id,
    });
    expect(first.created).toBe(true);
    const replay = await submitNotice(noticeHarness, {
      notice: rawDeliveryNotice(),
      idempotencyKey: "ac07-replay",
      subjectId: subject.id,
      correlationId: "ac07-replay-2",
    });
    expect(replay.created).toBe(false);
    expect(replay.observation.id).toBe(first.observation.id);
    // A different key ⇒ a new observation.
    const second = await submitNotice(noticeHarness, {
      notice: rawDeliveryNotice({ set: { noticeId: "delivery-notice-002" } }),
      idempotencyKey: "ac07-replay-3",
      subjectId: subject.id,
      correlationId: "ac07-replay-3",
    });
    expect(second.created).toBe(true);
    expect(second.observation.id).not.toBe(first.observation.id);
    const listed = await noticeHarness.runtime.outcomeObservationService.listObservationsBySubject(
      actorCtx(noticeHarness.w006, "ac07-list"),
      subject.id,
    );
    expect(listed.length).toBe(2);
  });

  test("tenant scoping: the idempotency key namespace is per-organization", async () => {
    noticeHarness = await createNetW023NoticeHarness();
    const subject = await createMeasuredSubject(noticeHarness.w006);
    const otherOrg = await noticeHarness.runtime.organizationService.createOrganization(
      noticeHarness.bootstrapCtx,
      { name: "Other W023 Org", creatorId: noticeHarness.personId },
    );
    const first = await submitNotice(noticeHarness, {
      notice: rawDeliveryNotice(),
      idempotencyKey: "ac07-tenant",
      subjectId: subject.id,
    });
    const second = await submitNotice(noticeHarness, {
      notice: rawDeliveryNotice(),
      idempotencyKey: "ac07-tenant",
      subjectId: subject.id,
      organizationScopeId: otherOrg.id,
      correlationId: "ac07-tenant-2",
    });
    expect(second.created).toBe(true);
    expect(second.observation.id).not.toBe(first.observation.id);
    expect(second.observation.organizationScopeId).toBe(otherOrg.id);
  });

  test("concurrency: parallel same-key submissions create EXACTLY ONE observation", async () => {
    noticeHarness = await createNetW023NoticeHarness();
    const subject = await createMeasuredSubject(noticeHarness.w006);
    const results = await Promise.all(
      Array.from({ length: 4 }, (_, i) =>
        submitNotice(noticeHarness, {
          notice: rawDeliveryNotice(),
          idempotencyKey: "ac07-concurrent",
          subjectId: subject.id,
          correlationId: `ac07-concurrent-${i}`,
        }),
      ),
    );
    const createdCount = results.filter((r) => r.created).length;
    const observationIds = new Set(results.map((r) => r.observation.id));
    expect(createdCount).toBe(1);
    expect(observationIds.size).toBe(1);
    const listed = await noticeHarness.runtime.outcomeObservationService.listObservationsBySubject(
      actorCtx(noticeHarness.w006, "ac07-concurrent-read"),
      subject.id,
    );
    expect(listed.length).toBe(1);
  });

  test("HTTP: the evaluation route is guarded — 403 unauthenticated, 200 decision, 400 malformed", async () => {
    // Unauthenticated → 403 (guard: adRequest.evaluate).
    const bare = createRuntime({
      forceEnv: "test",
      env: { APP_ENV: "test", LOG_LEVEL: "fatal" },
      port: 0,
    });
    await bare.initialize();
    await bare.api.start();
    try {
      const res = await fetch(`http://127.0.0.1:${bare.api.port}/api/external-ad-requests`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          organizationScopeId: "o",
          providerId: "openrtb-reference",
          request: {},
        }),
      });
      expect(res.status).toBe(403);
      const body = (await res.json()) as Record<string, unknown>;
      expect(body["error"]).toBe("authorization");
    } finally {
      await bare.shutdown();
    }

    // Authenticated + policy: the evaluation decision (200 for BOTH
    // admitted and non-admitted outcomes — a decision is a result).
    supplyHarness = await createNetW023SupplyHarness();
    await registerExternalSupply(supplyHarness);
    const httpSubject = "w023-http-actor@example.com";
    await supplyHarness.runtime.identityService.createIdentity(
      supplyHarness.bootstrapCtx,
      {
        displayName: "W023 HTTP Actor",
        subjectReferences: [
          { subjectId: httpSubject, providerKind: "internal" },
        ],
      },
    );
    const authHeaders = {
      "content-type": "application/json",
      "x-auth-subject-id": httpSubject,
    };
    const admitted = await fetch(
      `http://127.0.0.1:${supplyHarness.runtime.api.port}/api/external-ad-requests`,
      {
        method: "POST",
        headers: authHeaders,
        body: JSON.stringify({
          organizationScopeId: supplyHarness.organizationScopeId,
          providerId: "openrtb-reference",
          request: rawBidRequest(),
          sellerAuthorizations: verifyingAuthorizations(),
          evaluatedAt: EVALUATED_AT,
        }),
      },
    );
    expect(admitted.status).toBe(200);
    const admittedView = (await admitted.json()) as Record<string, unknown>;
    expect(admittedView["admitted"]).toBe(true);
    expect(admittedView["rejectionReason"]).toBeNull();

    // A non-admitted evaluation is ALSO a 200 (the decision is the
    // product — like the settlement-readiness derivation view).
    const rejected = await fetch(
      `http://127.0.0.1:${supplyHarness.runtime.api.port}/api/external-ad-requests`,
      {
        method: "POST",
        headers: authHeaders,
        body: JSON.stringify({
          organizationScopeId: supplyHarness.organizationScopeId,
          providerId: "openrtb-reference",
          request: rawBidRequest({ set: { site: { domain: "unregistered.example" } } }),
          sellerAuthorizations: verifyingAuthorizations(),
          evaluatedAt: EVALUATED_AT,
        }),
      },
    );
    expect(rejected.status).toBe(200);
    const rejectedView = (await rejected.json()) as Record<string, unknown>;
    expect(rejectedView["admitted"]).toBe(false);
    expect(rejectedView["rejectionReason"]).toBe("supply_not_found");

    // Missing request field → 400.
    const missing = await fetch(
      `http://127.0.0.1:${supplyHarness.runtime.api.port}/api/external-ad-requests`,
      {
        method: "POST",
        headers: authHeaders,
        body: JSON.stringify({
          organizationScopeId: supplyHarness.organizationScopeId,
          providerId: "openrtb-reference",
        }),
      },
    );
    expect(missing.status).toBe(400);

    // A fail-closed (unsupported version) payload → 400 classified
    // validation error, nothing normalized or persisted.
    const malformed = await fetch(
      `http://127.0.0.1:${supplyHarness.runtime.api.port}/api/external-ad-requests`,
      {
        method: "POST",
        headers: authHeaders,
        body: JSON.stringify({
          organizationScopeId: supplyHarness.organizationScopeId,
          providerId: "openrtb-reference",
          request: rawBidRequest({ set: { openrtbVersion: "9.9" } }),
        }),
      },
    );
    expect(malformed.status).toBe(400);
    const malformedBody = (await malformed.json()) as Record<string, unknown>;
    expect(malformedBody["error"]).toBe("OPENRTB_REQUEST_REJECTED");

    // PR #47 remediation (HTTP transport): an envelope that does not
    // verify is a DERIVED decision (200 + `unauthenticated`), never a
    // transport error — fabricated caller content is a verification
    // outcome, not a malformed request.
    const fabricated = await fetch(
      `http://127.0.0.1:${supplyHarness.runtime.api.port}/api/external-ad-requests`,
      {
        method: "POST",
        headers: authHeaders,
        body: JSON.stringify({
          organizationScopeId: supplyHarness.organizationScopeId,
          providerId: "openrtb-reference",
          request: rawBidRequest(),
          sellerAuthorizations: verifyingAuthorizations({
            integrityMode: "unsigned",
          }),
          evaluatedAt: EVALUATED_AT,
        }),
      },
    );
    expect(fabricated.status).toBe(200);
    const fabricatedView = (await fabricated.json()) as Record<string, unknown>;
    expect(fabricatedView["admitted"]).toBe(false);
    expect(fabricatedView["rejectionReason"]).toBe("supply_chain_unauthenticated");

    // A MALFORMED integrity block (wrong shape) IS a transport 400
    // (fail closed at the parse layer — the cryptographic check stays
    // at the boundary).
    const malformedIntegrity = await fetch(
      `http://127.0.0.1:${supplyHarness.runtime.api.port}/api/external-ad-requests`,
      {
        method: "POST",
        headers: authHeaders,
        body: JSON.stringify({
          organizationScopeId: supplyHarness.organizationScopeId,
          providerId: "openrtb-reference",
          request: rawBidRequest(),
          sellerAuthorizations: [
            {
              providerId: "openrtb-reference",
              sourceKind: "ads.txt",
              content: "exchange-one.example, pub-seller-1, DIRECT",
              sourceIdentity: "example.com",
              observedAt: EVALUATED_AT,
              integrity: { algorithm: "hmac-sha256" },
            },
          ],
          evaluatedAt: EVALUATED_AT,
        }),
      },
    );
    expect(malformedIntegrity.status).toBe(400);
  });

  test("the evaluation command itself performs NO material mutation (read-only derivation)", async () => {
    supplyHarness = await createNetW023SupplyHarness();
    await registerExternalSupply(supplyHarness);
    const auditBefore = await supplyHarness.runtime.auditWriter.count();
    // MANY evaluations (admitted + rejected).
    for (const domain of ["example.com", "unregistered.example"]) {
      await evaluateRequest(supplyHarness, {
        request: rawBidRequest({ set: { site: { domain } } }),
        sellerAuthorizations: verifyingAuthorizations(),
        evaluatedAt: EVALUATED_AT,
      });
    }
    const auditAfter = await supplyHarness.runtime.auditWriter.count();
    expect(auditAfter).toBe(auditBefore);
  });
});
