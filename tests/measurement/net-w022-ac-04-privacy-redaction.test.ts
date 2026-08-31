/**
 * NET-W022-AC-04 — Privacy controls, redaction and secret isolation
 * (issue #44 scope 4; requirements PRIV-002/PRIV-003).
 *
 * Adapters expose only the minimum fields required by the neutral
 * contract; over-broad vendor payloads (identifiers, device hints,
 * user-agent/IP hints, vendor extensions) are REDACTED (names only,
 * never values); verification secrets never enter normalized reports,
 * persisted observations, audit payloads, log entries, or error
 * contexts. The adapter never retains or mutates the caller's raw
 * payload object (raw platform state stays on the provider side).
 */

import { describe, test, expect, afterEach } from "bun:test";
import {
  createNetW022Harness,
  browserRawReport,
  iosRawPostback,
  submitReport,
  createSubject,
  actorCtx,
  BROWSER_TEST_SECRET,
  IOS_TEST_SECRET,
  type NetW022Harness,
} from "./_net-w022-harness.ts";
import { BrowserAttributionAdapter } from "../../src/measurement/providers/browser-attribution-adapter.ts";
import { IOSAttributionAdapter } from "../../src/measurement/providers/ios-attribution-adapter.ts";
import { MAX_REDACTED_FIELD_NAMES } from "../../src/measurement/providers/report-normalization.ts";

describe("NET-W022-AC-04 privacy controls, redaction, secret isolation", () => {
  let harness: NetW022Harness;

  afterEach(async () => {
    if (harness) await harness.teardown();
  });

  test("over-broad vendor payloads are REDACTED: only the neutral contract fields cross (names only)", async () => {
    const adapter = new BrowserAttributionAdapter({ verificationSecret: BROWSER_TEST_SECRET });
    const raw = browserRawReport();
    const { report, redactedFieldNames } = await adapter.normalizeReport({
      providerId: "browser-attribution",
      payload: raw,
    });
    // The neutral report carries EXACTLY the contract fields.
    expect(Object.keys(report).sort()).toEqual([
      "attributionMode",
      "collectedAt",
      "confidence",
      "externalSubjectRef",
      "method",
      "methodVersion",
      "observedValue",
      "outcomeType",
      "providerId",
    ]);
    // The redaction summary carries NAMES ONLY — every input field
    // that is NOT part of the neutral output (vendor fields AND
    // consumed-for-validation fields alike).
    expect([...redactedFieldNames].sort()).toEqual([
      "destination",
      "integrity",
      "ipHint",
      "reportId",
      "scheduledReportTime",
      "sourceEventId",
      "subjectRefs",
      "triggerData",
      "userAgent",
      "vendorExtensions",
    ]);
    // No vendor VALUE crosses in any form.
    const serialized = JSON.stringify(report) + JSON.stringify(redactedFieldNames);
    for (const vendorValue of [
      "opaque-trigger-payload-XYZ",
      "Mozilla/5.0",
      "203.0.113.7",
      "experimentBucket",
      "source-event-77",
      "destination.example",
    ]) {
      expect(serialized).not.toContain(vendorValue);
    }
  });

  test("iOS vendor ad references + device hints never cross (names only)", async () => {
    const adapter = new IOSAttributionAdapter({ verificationSecret: IOS_TEST_SECRET });
    const raw = iosRawPostback();
    const { report, redactedFieldNames } = await adapter.normalizeReport({
      providerId: "ios-attribution",
      payload: raw,
    });
    expect(Object.keys(report).sort()).toEqual([
      "attributionMode",
      "collectedAt",
      "confidence",
      "externalSubjectRef",
      "method",
      "methodVersion",
      "observedValue",
      "outcomeType",
      "providerId",
    ]);
    expect([...redactedFieldNames].sort()).toEqual([
      "adCampaignRef",
      "adGroupRef",
      "deterministicLink",
      "deviceHints",
      "integrity",
      "postbackId",
      "subjectRefs",
      "vendorPayload",
    ]);
    const serialized = JSON.stringify(report) + JSON.stringify(redactedFieldNames);
    for (const vendorValue of [
      "vendor-campaign-1234",
      "vendor-adgroup-567",
      "iPhone",
      "searchAds",
      "ad-click-ref-abc123",
    ]) {
      expect(serialized).not.toContain(vendorValue);
    }
  });

  test("the verification SECRET never leaks into reports, observations, audit, logs, or errors", async () => {
    harness = await createNetW022Harness();
    const subject = await createSubject(harness);
    const view = await submitReport(harness, {
      providerId: "browser-attribution",
      report: browserRawReport(),
      idempotencyKey: "ac04-secret-isolation",
      subjectId: subject.id,
    });
    // 1. The API view is secret-free.
    expect(JSON.stringify(view)).not.toContain(BROWSER_TEST_SECRET);
    // 2. The persisted observation is secret-free.
    const observation = await harness.runtime.outcomeObservationService.getOutcomeObservation(
      actorCtx(harness.w006, "ac04-read"),
      view.observation.id,
    );
    expect(JSON.stringify(observation)).not.toContain(BROWSER_TEST_SECRET);
    // 3. The audit record is secret-free.
    const events = await harness.runtime.auditWriter.query({
      eventType: "outcome_observation.created",
      resourceId: view.observation.id,
    });
    expect(events.length).toBe(1);
    expect(JSON.stringify(events[0])).not.toContain(BROWSER_TEST_SECRET);
    // 4. Log entries collected by the runtime sink are secret-free.
    const logSerialized = JSON.stringify(
      (harness.runtime.logSink as { entries: unknown[] }).entries ?? [],
    );
    expect(logSerialized).not.toContain(BROWSER_TEST_SECRET);
    // 5. Rejection error contexts never carry the secret (tamper the
    // report AFTER signing — the signature no longer matches).
    let caught: unknown;
    try {
      const tampered = browserRawReport();
      tampered["reportId"] = "tampered-after-signing";
      await submitReport(harness, {
        providerId: "browser-attribution",
        report: tampered,
        idempotencyKey: "ac04-secret-error",
        subjectId: subject.id,
      });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeDefined();
    expect(JSON.stringify(caught)).not.toContain(BROWSER_TEST_SECRET);
  });

  test("the raw vendor payload object is not RETAINED or MUTATED by the adapter (raw platform state stays provider-side)", async () => {
    const adapter = new BrowserAttributionAdapter({ verificationSecret: BROWSER_TEST_SECRET });
    const raw = browserRawReport();
    const snapshot = JSON.parse(JSON.stringify(raw)) as Record<string, unknown>;
    await adapter.normalizeReport({ providerId: "browser-attribution", payload: raw });
    // The caller's object is unchanged (no in-place redaction).
    expect(raw).toEqual(snapshot);
    // A second normalization of the SAME object is identical (no
    // state accumulated between calls).
    const first = await adapter.normalizeReport({ providerId: "browser-attribution", payload: raw });
    const second = await adapter.normalizeReport({ providerId: "browser-attribution", payload: raw });
    expect(second.report).toEqual(first.report);
  });

  test("the redaction summary is BOUNDED (no unbounded payload reflection)", async () => {
    const adapter = new BrowserAttributionAdapter({ verificationSecret: BROWSER_TEST_SECRET });
    const set: Record<string, unknown> = {};
    for (let i = 0; i < MAX_REDACTED_FIELD_NAMES + 10; i++) {
      set[`unknownVendorField${i}`] = `value-${i}`;
    }
    const { redactedFieldNames } = await adapter.normalizeReport({
      providerId: "browser-attribution",
      payload: browserRawReport({ set }),
    });
    expect(redactedFieldNames.length).toBeLessThanOrEqual(MAX_REDACTED_FIELD_NAMES);
    // Names only — the injected VALUES never appear.
    expect(JSON.stringify(redactedFieldNames)).not.toContain("value-30");
  });

  test("privacy minimization holds through the FULL composed path (API view + persisted observation)", async () => {
    harness = await createNetW022Harness();
    const subject = await createSubject(harness);
    const view = await submitReport(harness, {
      providerId: "ios-attribution",
      report: iosRawPostback(),
      idempotencyKey: "ac04-end-to-end",
      subjectId: subject.id,
    });
    expect([...view.redactedFieldNames].sort()).toEqual([
      "adCampaignRef",
      "adGroupRef",
      "deterministicLink",
      "deviceHints",
      "integrity",
      "postbackId",
      "subjectRefs",
      "vendorPayload",
    ]);
    const observation = await harness.runtime.outcomeObservationService.getOutcomeObservation(
      actorCtx(harness.w006, "ac04-read-2"),
      view.observation.id,
    );
    const serialized = JSON.stringify(view) + JSON.stringify(observation);
    for (const vendorValue of [
      "vendor-campaign-1234",
      "vendor-adgroup-567",
      "iPhone",
      "redownload",
      "searchAds",
    ]) {
      expect(serialized).not.toContain(vendorValue);
    }
    // The protocol subject binding is the caller-declared subject
    // (the observation is subject-scoped; no vendor subject leaks
    // into protocol identity).
    expect(observation.subjectReference.subjectId).toBe(subject.id);
    expect(observation.subjectReference.subjectType).toBe("contribution");
    expect(observation.externalSubjectRef).toBe("ext-ios-subject-99");
  });
});
