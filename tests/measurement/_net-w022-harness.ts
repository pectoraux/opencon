/**
 * NET-W022 shared test harness — attribution and privacy measurement
 * adapters.
 *
 * Wraps the NET-W006 harness pattern: a full runtime whose
 * measurement provider registry is wired with the two reference
 * attribution adapters (ADAPTER-003 browser-attribution +
 * ADAPTER-004 ios-attribution) configured with TEST verification
 * secrets (test-only literals — NOT real credentials). Raw vendor
 * reports are signed TEST-side with the same reference HMAC envelope
 * the adapters verify (the provider side of the boundary).
 *
 * The W021-harness precedent: wrap the predecessor harness so the
 * seeded policies/person/org/subject factories are reused unchanged.
 */

import {
  createNetW006Harness,
  createMeasuredSubject,
  actorCtx,
  type NetW006Harness,
} from "../outcomes/_net-w006-harness.ts";
import { BrowserAttributionAdapter } from "../../src/measurement/providers/browser-attribution-adapter.ts";
import { IOSAttributionAdapter } from "../../src/measurement/providers/ios-attribution-adapter.ts";
import { computeReportSignature } from "../../src/measurement/providers/report-integrity.ts";
import {
  BROWSER_ATTRIBUTION_PROVIDER_ID,
  IOS_ATTRIBUTION_PROVIDER_ID,
} from "../../src/measurement/providers/index.ts";
import type { ExecutionContext } from "../../src/core/execution-context.ts";
import type { ApiMeasurementReportSubmissionView } from "../../src/api/port.ts";

/** TEST-ONLY verification secrets (literals, never real credentials). */
export const BROWSER_TEST_SECRET = "test-browser-verification-secret-v1";
export const IOS_TEST_SECRET = "test-ios-verification-secret-v1";

export interface NetW022Harness {
  /** The wrapped NET-W006 harness (runtime + person/org/policies). */
  readonly w006: NetW006Harness;
  readonly runtime: NetW006Harness["runtime"];
  readonly bootstrapCtx: ExecutionContext;
  readonly personId: string;
  readonly subjectId: string;
  readonly organizationScopeId: string;
  /** The browser attribution adapter (direct unit access). */
  readonly browserAdapter: BrowserAttributionAdapter;
  /** The iOS attribution adapter (direct unit access). */
  readonly iosAdapter: IOSAttributionAdapter;
  teardown(): Promise<void>;
}

export async function createNetW022Harness(): Promise<NetW022Harness> {
  const browserAdapter = new BrowserAttributionAdapter({
    verificationSecret: BROWSER_TEST_SECRET,
  });
  const iosAdapter = new IOSAttributionAdapter({
    verificationSecret: IOS_TEST_SECRET,
  });
  const w006 = await createNetW006Harness({
    measurement: { providers: [browserAdapter, iosAdapter] },
  });
  // NET-W022: seed the measurement-report submission guard policy on
  // top of the W006 harness policy set (the HTTP route requires it).
  await w006.runtime.policyService.createPolicy(w006.bootstrapCtx, {
    subject: "*",
    action: "measurementReport.submit",
    resource: "*",
    effect: "allow",
    createdBy: "bootstrap",
  });
  return {
    w006,
    runtime: w006.runtime,
    bootstrapCtx: w006.bootstrapCtx,
    personId: w006.personId,
    subjectId: w006.subjectId,
    organizationScopeId: w006.organizationScopeId,
    browserAdapter,
    iosAdapter,
    async teardown() {
      await w006.teardown();
    },
  };
}

/** Sign a raw report body the way the reference provider would. */
export function signRawReport(
  body: Record<string, unknown>,
  secret: string,
): { algorithm: string; signature: string; signedAt: string } {
  const { integrity: _integrity, ...rest } = body;
  void _integrity;
  return {
    algorithm: "hmac-sha256",
    signature: computeReportSignature(rest as Record<string, unknown>, secret),
    signedAt: "2026-09-01T00:00:00.000Z",
  };
}

export interface RawReportOverrides {
  readonly remove?: readonly string[];
  /**
   * Field overrides. `integrity` is special: it is applied AFTER the
   * factory signs the body (rejection fixtures replace/remove the
   * signed block); `integrity: null` removes the block entirely.
   */
  readonly set?: Readonly<Record<string, unknown>>;
}

function applyOverrides(
  body: Record<string, unknown>,
  overrides: RawReportOverrides = {},
  secret: string,
): Record<string, unknown> {
  const { integrity: integrityOverride, ...restSet } = overrides.set ?? {};
  const out: Record<string, unknown> = { ...body };
  for (const key of overrides.remove ?? []) {
    delete out[key];
  }
  for (const [key, value] of Object.entries(restSet ?? {})) {
    out[key] = value;
  }
  // Sign the FINAL body (minus any integrity override), then apply
  // the integrity override LAST (rejection fixtures).
  out["integrity"] = signRawReport(out, secret);
  if (integrityOverride !== undefined) {
    if (integrityOverride === null) {
      delete out["integrity"];
    } else {
      out["integrity"] = integrityOverride;
    }
  }
  return out;
}

/**
 * A VALID raw browser/platform attribution report (ADAPTER-003
 * shape), signed with the test secret. Vendor fields
 * (triggerData/userAgent/ipHint/scheduledReportTime/vendorExtensions)
 * are included so privacy redaction is observable.
 */
export function browserRawReport(
  overrides: RawReportOverrides = {},
): Record<string, unknown> {
  const body: Record<string, unknown> = {
    reportId: "browser-report-001",
    sourceEventId: "source-event-77",
    destination: "https://destination.example",
    subjectRefs: ["ext-browser-subject-42"],
    outcomeType: "install",
    observedValue: { value: 18, unit: "installs" },
    confidence: { point: 0.9, lower: 0.85, upper: 0.95 },
    attributionMode: "probabilistic",
    method: "browser-attribution-model",
    methodVersion: "3.1.0",
    collectedAt: "2026-08-24T12:00:00.000Z",
    // Vendor/over-broad fields — MUST be redacted (names only).
    triggerData: "opaque-trigger-payload-XYZ",
    userAgent: "Mozilla/5.0 (compatible; TestClient/1.0)",
    ipHint: "203.0.113.7",
    scheduledReportTime: "2026-08-24T13:00:00.000Z",
    vendorExtensions: { experimentBucket: 9 },
  };
  const patched = applyOverrides(body, overrides, BROWSER_TEST_SECRET);
  return patched;
}

/**
 * A VALID raw iOS attribution postback (ADAPTER-004 shape), signed
 * with the test secret. Vendor fields (adCampaignRef/adGroupRef/
 * deviceHints/vendorPayload) are included so privacy redaction is
 * observable.
 */
export function iosRawPostback(
  overrides: RawReportOverrides = {},
): Record<string, unknown> {
  const body: Record<string, unknown> = {
    postbackId: "ios-postback-001",
    adCampaignRef: "vendor-campaign-1234",
    adGroupRef: "vendor-adgroup-567",
    subjectRefs: ["ext-ios-subject-99"],
    outcomeType: "purchase",
    observedValue: { value: 3, unit: "purchases" },
    confidence: { point: 0.99 },
    attributionMode: "deterministic",
    deterministicLink: "ad-click-ref-abc123",
    method: "ios-attribution-record",
    methodVersion: "2.4.0",
    collectedAt: "2026-08-25T09:30:00.000Z",
    // Vendor/over-broad fields — MUST be redacted (names only).
    deviceHints: { modelFamily: "iPhone", osMajor: 18 },
    vendorPayload: { redownload: false, searchAds: true },
  };
  const patched = applyOverrides(body, overrides, IOS_TEST_SECRET);
  return patched;
}

/** Submit a raw report through the COMPOSED api command (the golden path). */
export async function submitReport(
  harness: NetW022Harness,
  options: {
    readonly providerId: string;
    readonly report: unknown;
    readonly idempotencyKey: string;
    readonly subjectId: string;
    readonly correlationId?: string;
    readonly organizationScopeId?: string;
  },
): Promise<ApiMeasurementReportSubmissionView> {
  const ctx: ExecutionContext = actorCtx(
    harness.w006,
    options.correlationId ?? "w022-submit",
  );
  return harness.runtime.apiCommands.submitMeasurementReport(ctx, harness.personId, {
    organizationScopeId: options.organizationScopeId ?? harness.organizationScopeId,
    subjectReference: {
      subjectId: options.subjectId,
      subjectType: "contribution",
    },
    idempotencyKey: options.idempotencyKey,
    providerId: options.providerId,
    report: options.report,
  });
}

/** Create a contribution subject to measure (reuses the W006 factory). */
export async function createSubject(
  harness: NetW022Harness,
  correlationId = "w022-subject",
): Promise<{ id: string; organizationScopeId: string }> {
  void correlationId;
  return createMeasuredSubject(harness.w006);
}

export { createMeasuredSubject, actorCtx };

export const W022_PROVIDER_IDS = [
  BROWSER_ATTRIBUTION_PROVIDER_ID,
  IOS_ATTRIBUTION_PROVIDER_ID,
] as const;
