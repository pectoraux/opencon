/**
 * NET-W022-AC-03 — Fail-closed validation of malformed provider
 * reports (issue #44 scope 5).
 *
 * Every rejection path in the closed reason vocabulary is exercised
 * through the composed boundary: malformed reports, unsupported
 * attribution modes (incl. experimental claims — protocol-owned),
 * invalid mode consistency, missing provenance, ambiguous subject
 * mapping, and unverifiable integrity (tampering, wrong secret,
 * unsupported algorithm, missing block). NOTHING is persisted on
 * rejection.
 */

import { describe, test, expect, afterEach } from "bun:test";
import {
  createNetW022Harness,
  browserRawReport,
  iosRawPostback,
  submitReport,
  createSubject,
  actorCtx,
  type NetW022Harness,
} from "./_net-w022-harness.ts";
import { MeasurementReportRejectedError } from "../../src/measurement/port.ts";
import type { MeasurementReportRejectionReason } from "../../src/measurement/port.ts";

async function expectRejection(
  fn: () => Promise<unknown>,
  reason: MeasurementReportRejectionReason,
  label: string,
): Promise<void> {
  let caught: unknown;
  try {
    await fn();
    throw new Error(`expected a rejection for ${label}`);
  } catch (err) {
    caught = err;
  }
  expect(caught, label).toBeInstanceOf(MeasurementReportRejectedError);
  const rejected = caught as MeasurementReportRejectedError;
  expect(rejected.reason, `${label}: reason`).toBe(reason);
  expect(rejected.code, `${label}: code`).toBe("MEASUREMENT_REPORT_REJECTED");
  // The error context NEVER carries payload values or secret material.
  const context = JSON.stringify(rejected.context ?? {});
  expect(context, `${label}: no payload values in context`).not.toContain("opaque-trigger-payload");
  expect(context, `${label}: no secret in context`).not.toContain("test-browser-verification-secret");
}

describe("NET-W022-AC-03 fail-closed validation", () => {
  let harness: NetW022Harness;

  afterEach(async () => {
    if (harness) await harness.teardown();
  });

  async function freshHarness(): Promise<NetW022Harness> {
    if (harness) await harness.teardown();
    harness = await createNetW022Harness();
    return harness;
  }

  test("malformed_report: non-object payloads, missing ids, bad field shapes", async () => {
    const h = await freshHarness();
    const subject = await createSubject(h);
    const cases: Array<[string, unknown]> = [
      ["a string payload", "not-an-object"],
      ["an array payload", [browserRawReport()]],
      ["a null payload", null],
      ["missing reportId", browserRawReport({ remove: ["reportId"] })],
      ["empty reportId", browserRawReport({ set: { reportId: "" } })],
      ["non-string reportId", browserRawReport({ set: { reportId: 42 } })],
      ["missing observedValue", browserRawReport({ remove: ["observedValue"] })],
      ["non-finite observed value", browserRawReport({ set: { observedValue: { value: "x", unit: "u" } } })],
      ["negative observed value", browserRawReport({ set: { observedValue: { value: -3, unit: "u" } } })],
      ["missing unit", browserRawReport({ set: { observedValue: { value: 3 } } })],
      ["invalid confidence point", browserRawReport({ set: { confidence: { point: 1.5, lower: 0.5, upper: 0.9 } } })],
      ["non-standard outcome type", browserRawReport({ set: { outcomeType: "vendor-outcome-kind" } })],
    ];
    for (const [label, payload] of cases) {
      await expectRejection(
        () =>
          submitReport(h, {
            providerId: "browser-attribution",
            report: payload,
            idempotencyKey: `ac03-${label.replace(/\W+/g, "-")}`,
            subjectId: subject.id,
          }),
        "malformed_report",
        label,
      );
    }
    // iOS postback shape: missing postbackId.
    await expectRejection(
      () =>
        submitReport(h, {
          providerId: "ios-attribution",
          report: iosRawPostback({ remove: ["postbackId"] }),
          idempotencyKey: "ac03-ios-malformed",
          subjectId: subject.id,
        }),
      "malformed_report",
      "iOS missing postbackId",
    );
  });

  test("unsupported_attribution_mode: unknown + EXPERIMENTAL claims (experimental is protocol-owned)", async () => {
    const h = await freshHarness();
    const subject = await createSubject(h);
    for (const mode of ["experimental", "last-touch-vendor-mode", 7]) {
      await expectRejection(
        () =>
          submitReport(h, {
            providerId: "browser-attribution",
            report: browserRawReport({ set: { attributionMode: mode } }),
            idempotencyKey: `ac03-mode-${String(mode)}`,
            subjectId: subject.id,
          }),
        "unsupported_attribution_mode",
        `attributionMode=${String(mode)}`,
      );
    }
    // The iOS adapter rejects experimental claims too.
    await expectRejection(
      () =>
        submitReport(h, {
          providerId: "ios-attribution",
          report: iosRawPostback({ set: { attributionMode: "experimental" } }),
          idempotencyKey: "ac03-ios-experimental",
          subjectId: subject.id,
        }),
      "unsupported_attribution_mode",
      "iOS experimental claim",
    );
  });

  test("invalid_attribution_mode: deterministic without a link; probabilistic WITH a link; probabilistic WITHOUT an interval", async () => {
    const h = await freshHarness();
    const subject = await createSubject(h);
    // deterministic without deterministicLink (iOS postback ships one).
    await expectRejection(
      () =>
        submitReport(h, {
          providerId: "ios-attribution",
          report: iosRawPostback({ remove: ["deterministicLink"] }),
          idempotencyKey: "ac03-det-no-link",
          subjectId: subject.id,
        }),
      "invalid_attribution_mode",
      "deterministic without link",
    );
    // probabilistic WITH deterministicLink.
    await expectRejection(
      () =>
        submitReport(h, {
          providerId: "browser-attribution",
          report: browserRawReport({ set: { deterministicLink: "click-id-1" } }),
          idempotencyKey: "ac03-prob-with-link",
          subjectId: subject.id,
        }),
      "invalid_attribution_mode",
      "probabilistic with link",
    );
    // probabilistic WITHOUT a quantified interval.
    await expectRejection(
      () =>
        submitReport(h, {
          providerId: "browser-attribution",
          report: browserRawReport({ set: { confidence: { point: 0.9 } } }),
          idempotencyKey: "ac03-prob-no-interval",
          subjectId: subject.id,
        }),
      "invalid_attribution_mode",
      "probabilistic without interval",
    );
    // confidence ABSENT entirely (no interval to quantify).
    await expectRejection(
      () =>
        submitReport(h, {
          providerId: "browser-attribution",
          report: browserRawReport({ remove: ["confidence"] }),
          idempotencyKey: "ac03-prob-no-confidence",
          subjectId: subject.id,
        }),
      "invalid_attribution_mode",
      "probabilistic without confidence",
    );
  });

  test("missing_provenance: absent/empty method, methodVersion, collectedAt", async () => {
    const h = await freshHarness();
    const subject = await createSubject(h);
    for (const field of ["method", "methodVersion", "collectedAt"]) {
      await expectRejection(
        () =>
          submitReport(h, {
            providerId: "browser-attribution",
            report: browserRawReport({ set: { [field]: "" } }),
            idempotencyKey: `ac03-prov-${field}`,
            subjectId: subject.id,
          }),
        "missing_provenance",
        `empty ${field}`,
      );
      await expectRejection(
        () =>
          submitReport(h, {
            providerId: "browser-attribution",
            report: browserRawReport({ remove: [field] }),
            idempotencyKey: `ac03-prov-absent-${field}`,
            subjectId: subject.id,
          }),
        "missing_provenance",
        `absent ${field}`,
      );
    }
  });

  test("ambiguous_subject_mapping: zero refs, multiple refs, non-string refs, wrong shape", async () => {
    const h = await freshHarness();
    const subject = await createSubject(h);
    const cases: Array<[string, unknown]> = [
      ["empty subject list", []],
      ["two candidate refs", ["ref-a", "ref-b"]],
      ["non-string entries", ["ref-a", 42]],
      ["non-array subjectRefs", "just-a-string"],
      ["missing subjectRefs", undefined],
    ];
    for (const [label, refs] of cases) {
      const body = browserRawReport(
        refs === undefined ? { remove: ["subjectRefs"] } : { set: { subjectRefs: refs } },
      );
      await expectRejection(
        () =>
          submitReport(h, {
            providerId: "browser-attribution",
            report: body,
            idempotencyKey: `ac03-subject-${label.replace(/\W+/g, "-")}`,
            subjectId: subject.id,
          }),
        "ambiguous_subject_mapping",
        label,
      );
    }
  });

  test("unverifiable_integrity: missing block, unsupported algorithm, tampered payload, wrong secret, bad signature", async () => {
    const h = await freshHarness();
    const subject = await createSubject(h);
    // Missing integrity block entirely (the factory applies the null
    // integrity override AFTER signing — the report carries NO block).
    await expectRejection(
      () =>
        submitReport(h, {
          providerId: "browser-attribution",
          report: browserRawReport({ set: { integrity: null } }),
          idempotencyKey: "ac03-no-integrity",
          subjectId: subject.id,
        }),
      "unverifiable_integrity",
      "missing integrity block",
    );
    // Unsupported algorithm.
    await expectRejection(
      () =>
        submitReport(h, {
          providerId: "browser-attribution",
          report: browserRawReport({
            set: {
              integrity: { algorithm: "rsa-sha256", signature: "ab", signedAt: "2026-09-01T00:00:00.000Z" },
            },
          }),
          idempotencyKey: "ac03-bad-algo",
          subjectId: subject.id,
        }),
      "unverifiable_integrity",
      "unsupported algorithm",
    );
    // Tampered payload: the report was signed, then the value changed
    // (signature no longer matches).
    const tampered = browserRawReport();
    (tampered["observedValue"] as Record<string, unknown>)["value"] = 999;
    await expectRejection(
      () =>
        submitReport(h, {
          providerId: "browser-attribution",
          report: tampered,
          idempotencyKey: "ac03-tampered",
          subjectId: subject.id,
        }),
      "unverifiable_integrity",
      "tampered payload",
    );
    // Wrong provider secret (iOS secret used to sign a browser report).
    const { signRawReport, IOS_TEST_SECRET } = await import("./_net-w022-harness.ts");
    const wrongSecret = browserRawReport();
    wrongSecret["integrity"] = signRawReport(wrongSecret, IOS_TEST_SECRET);
    await expectRejection(
      () =>
        submitReport(h, {
          providerId: "browser-attribution",
          report: wrongSecret,
          idempotencyKey: "ac03-wrong-secret",
          subjectId: subject.id,
        }),
      "unverifiable_integrity",
      "wrong secret",
    );
    // Empty signature.
    await expectRejection(
      () =>
        submitReport(h, {
          providerId: "browser-attribution",
          report: browserRawReport({
            set: { integrity: { algorithm: "hmac-sha256", signature: "", signedAt: "2026-09-01T00:00:00.000Z" } },
          }),
          idempotencyKey: "ac03-empty-signature",
          subjectId: subject.id,
        }),
      "unverifiable_integrity",
      "empty signature",
    );
    // Missing signedAt.
    await expectRejection(
      () =>
        submitReport(h, {
          providerId: "browser-attribution",
          report: browserRawReport({
            set: { integrity: { algorithm: "hmac-sha256", signature: "ab" } },
          }),
          idempotencyKey: "ac03-no-signedAt",
          subjectId: subject.id,
        }),
      "unverifiable_integrity",
      "missing signedAt",
    );
  });

  test("NOTHING IS PERSISTED on rejection (fail closed end-to-end)", async () => {
    const h = await freshHarness();
    const subject = await createSubject(h);
    const before = await h.runtime.outcomeObservationService.listObservationsBySubject(
      actorCtx(h.w006, "ac03-after"),
      subject.id,
    );
    expect(before.length).toBe(0);
    let rejected = false;
    try {
      await submitReport(h, {
        providerId: "browser-attribution",
        report: browserRawReport({ set: { integrity: null } }),
        idempotencyKey: "ac03-nothing-persisted",
        subjectId: subject.id,
      });
    } catch {
      rejected = true;
    }
    expect(rejected).toBe(true);
    const after = await h.runtime.outcomeObservationService.listObservationsBySubject(
      actorCtx(h.w006, "ac03-after-2"),
      subject.id,
    );
    expect(after.length).toBe(0);
    // No audit events for a rejected report either.
    const events = await h.runtime.auditWriter.query({
      eventType: "outcome_observation.created",
    });
    expect(events.length).toBe(0);
  });
});
