/**
 * NET-W022-AC-06 — HTTP integration: POST /api/measurement-reports
 * (issue #44; the API-003..005 conventions).
 *
 * The route is guarded (measurementReport.submit): unauthenticated ⇒
 * 403; authenticated + policy ⇒ 201 with the submission view; a
 * missing report body ⇒ 400; a rejected (fail-closed) report surfaces
 * the classified validation error. The raw vendor payload is an
 * opaque JSON passthrough at the API tier.
 */

import { describe, test, expect, afterEach } from "bun:test";
import {
  createNetW022Harness,
  browserRawReport,
  createSubject,
  type NetW022Harness,
} from "./_net-w022-harness.ts";
import { createRuntime } from "../../src/bootstrap/runtime.ts";

describe("NET-W022-AC-06 HTTP integration (POST /api/measurement-reports)", () => {
  let harness: NetW022Harness;

  afterEach(async () => {
    if (harness) await harness.teardown();
  });

  test("unauthenticated submissions are rejected with 403 (guard: measurementReport.submit)", async () => {
    const bare = createRuntime({
      forceEnv: "test",
      env: { APP_ENV: "test", LOG_LEVEL: "fatal" },
      port: 0,
    });
    await bare.initialize();
    await bare.api.start();
    try {
      const res = await fetch(`http://127.0.0.1:${bare.api.port}/api/measurement-reports`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          organizationScopeId: "o",
          subjectReference: { subjectId: "s", subjectType: "contribution" },
          idempotencyKey: "k",
          providerId: "browser-attribution",
          report: {},
        }),
      });
      expect(res.status).toBe(403);
      const body = (await res.json()) as Record<string, unknown>;
      expect(body["error"]).toBe("authorization");
    } finally {
      await bare.shutdown();
    }
  });

  test("an authenticated submission with policy returns 201 + the submission view", async () => {
    harness = await createNetW022Harness();
    const subject = await createSubject(harness);
    const raw = browserRawReport();
    const res = await fetch(`http://127.0.0.1:${harness.runtime.api.port}/api/measurement-reports`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-auth-subject-id": harness.subjectId,
      },
      body: JSON.stringify({
        organizationScopeId: harness.organizationScopeId,
        subjectReference: { subjectId: subject.id, subjectType: "contribution" },
        idempotencyKey: "ac06-http-submit",
        providerId: "browser-attribution",
        report: raw,
      }),
    });
    expect(res.status).toBe(201);
    const view = (await res.json()) as Record<string, unknown>;
    expect(view["providerId"]).toBe("browser-attribution");
    expect(view["providerVersion"]).toBe("1.0.0");
    expect(view["created"]).toBe(true);
    const observation = view["observation"] as Record<string, unknown>;
    expect(typeof observation["id"]).toBe("string");
    const provenance = observation["provenance"] as Record<string, unknown>;
    expect(provenance["sourceType"]).toBe("provider");
    expect(provenance["sourceId"]).toBe("browser-attribution");
    // The redaction summary crossed the API boundary (names only).
    expect(Array.isArray(view["redactedFieldNames"])).toBe(true);
    // The persisted observation is retrievable through the public
    // read surface (provider facts are durable).
    const ctx = harness.w006.bootstrapCtx;
    const stored = await harness.runtime.outcomeObservationService.getOutcomeObservation(
      ctx,
      observation["id"] as string,
    );
    expect(stored.externalSubjectRef).toBe("ext-browser-subject-42");
  });

  test("a missing report field is rejected with 400 (validation)", async () => {
    harness = await createNetW022Harness();
    const res = await fetch(`http://127.0.0.1:${harness.runtime.api.port}/api/measurement-reports`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-auth-subject-id": harness.subjectId,
      },
      body: JSON.stringify({
        organizationScopeId: harness.organizationScopeId,
        subjectReference: { subjectId: "s", subjectType: "contribution" },
        idempotencyKey: "ac06-missing-report",
        providerId: "browser-attribution",
      }),
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body["error"]).toBe("validation");
  });

  test("a fail-closed rejection surfaces as a classified validation error (nothing persisted)", async () => {
    harness = await createNetW022Harness();
    const subject = await createSubject(harness);
    const tampered = browserRawReport();
    tampered["observedValue"] = { value: 555, unit: "installs" }; // post-signature tamper
    const res = await fetch(`http://127.0.0.1:${harness.runtime.api.port}/api/measurement-reports`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-auth-subject-id": harness.subjectId,
      },
      body: JSON.stringify({
        organizationScopeId: harness.organizationScopeId,
        subjectReference: { subjectId: subject.id, subjectType: "contribution" },
        idempotencyKey: "ac06-tampered",
        providerId: "browser-attribution",
        report: tampered,
      }),
    });
    // The fail-closed rejection surfaces as a 4xx classification
    // (the api error mapping turns classification "validation" into
    // 400), never a 5xx and never a persisted observation.
    expect(res.status).toBe(400);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body["error"]).toBe("MEASUREMENT_REPORT_REJECTED");
    const listed = await harness.runtime.outcomeObservationService.listObservationsBySubject(
      harness.w006.bootstrapCtx,
      subject.id,
    );
    expect(listed.length).toBe(0);
  });
});
