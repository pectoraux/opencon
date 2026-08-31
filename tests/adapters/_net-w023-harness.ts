/**
 * NET-W023 shared test harness — OpenRTB and supply-chain adapters.
 *
 * Two sub-harnesses (both wrap predecessor harnesses — the W022 wrap
 * precedent):
 *
 *  1. `createNetW023SupplyHarness` — wraps the NET-W019 harness
 *     (runtime + persons + registered-supply factories + the
 *     `adRequest.evaluate` guard policy) for the request/supply-chain
 *     evaluation surface. The runtime's OpenRTB ingress is the
 *     DEFAULT composition (the reference adapter; no secrets needed).
 *  2. `createNetW023NoticeHarness` — wraps the NET-W006 harness with
 *     the reference delivery-notice measurement adapter configured
 *     with a TEST verification secret (test-only literal — never a
 *     real credential) + the `measurementReport.submit` guard policy
 *     for the sanctioned measurement routing path.
 *
 * Raw payloads are TEST-side factories: bid requests carry the vendor
 * fields the privacy redaction must drop; delivery notices are signed
 * with the same reference HMAC envelope the adapter verifies.
 */

import {
  createNetW019Harness,
  registerInventoryItem,
  personCtx,
  key as w019Key,
  type NetW019Harness,
} from "../inventory/_net-w019-harness.ts";
import { createNetW006Harness, actorCtx, type NetW006Harness } from "../outcomes/_net-w006-harness.ts";
import { signRawReport } from "../measurement/_net-w022-harness.ts";
import {
  OpenRtbReferenceAdapter,
  OPENRTB_REFERENCE_PROVIDER_ID,
} from "../../src/adapters/openrtb/reference-adapter.ts";
import { buildSellerAuthorizationIntegrity } from "../../src/adapters/openrtb/authorization-integrity.ts";
import type { SellerAuthorizationIntegrityBlock } from "../../src/adapters/port.ts";
import {
  OpenRtbDeliveryNoticeAdapter,
  OPENRTB_DELIVERY_PROVIDER_ID,
} from "../../src/measurement/providers/openrtb-delivery-adapter.ts";
import type { ExecutionContext } from "../../src/core/execution-context.ts";
import type {
  ApiExternalAdRequestEvaluationView,
  ApiMeasurementReportSubmissionView,
} from "../../src/api/port.ts";

/** TEST-ONLY verification secret (a literal, never a real credential). */
export const OPENRTB_DELIVERY_TEST_SECRET = "test-openrtb-delivery-secret-v1";

/**
 * TEST-ONLY seller-authorization trust channel key (PR #47
 * remediation; a literal, never a real credential). The supply
 * harness wires this as the runtime trust key so signed fixtures
 * authenticate; the wrong-key fixtures sign with a DIFFERENT literal
 * to exercise the authentication gate.
 */
export const SELLER_AUTH_TRUST_TEST_SECRET = "test-seller-auth-trust-secret-v1";

/** A DIFFERENT test key (the untrusted signer — wrong-key fixtures). */
export const SELLER_AUTH_TRUST_WRONG_KEY = "test-seller-auth-trust-WRONG-key";

/** The provider id the supply harness registers inventory under. */
export const SUPPLY_PROVIDER_ID = OPENRTB_REFERENCE_PROVIDER_ID;

/** The canonical test publisher supply identity (site domain). */
export const PUBLISHER_DOMAIN = "example.com";

/** The canonical test app supply identity (app bundle). */
export const APP_BUNDLE = "com.example.app";

/** The canonical exchange identities used by the test supply chain. */
export const FIRST_EXCHANGE = "exchange-one.example";
export const SECOND_EXCHANGE = "exchange-two.example";
export const FIRST_SELLER_ID = "pub-seller-1";
export const SECOND_SELLER_ID = "inter-seller-7";

/** The fixed evaluation anchor (determinism). */
export const EVALUATED_AT = "2026-09-01T12:00:00.000Z";

/** A fresh observation timestamp (well inside the staleness bound). */
export const OBSERVED_AT = "2026-09-01T11:00:00.000Z";

// ---------------------------------------------------------------------------
// The supply-side harness (evaluation surface)
// ---------------------------------------------------------------------------

export interface NetW023SupplyHarness {
  readonly w019: NetW019Harness;
  readonly runtime: NetW019Harness["runtime"];
  readonly bootstrapCtx: ExecutionContext;
  readonly creatorPersonId: string;
  readonly operatorPersonId: string;
  readonly organizationScopeId: string;
  readonly secondOrgId: string;
  readonly secondOrgPersonId: string;
  /** The wired OpenRTB reference adapter (direct unit access). */
  readonly referenceAdapter: OpenRtbReferenceAdapter;
  teardown(): Promise<void>;
}

export interface NetW023SupplyHarnessOptions {
  /**
   * The seller-authorization trust channel key the runtime wires
   * (PR #47 remediation). DEFAULT: the TEST secret — signed fixtures
   * authenticate. Pass `null` to run UNCONFIGURED (fail closed:
   * even correctly signed facts are `unauthenticated` — the
   * default-runtime remediation regression).
   */
  readonly sellerAuthorizationTrustKey?: string | null;
}

export async function createNetW023SupplyHarness(
  opts: NetW023SupplyHarnessOptions = {},
): Promise<NetW023SupplyHarness> {
  const trustKey =
    opts.sellerAuthorizationTrustKey === null
      ? undefined
      : (opts.sellerAuthorizationTrustKey ?? SELLER_AUTH_TRUST_TEST_SECRET);
  const w019 = await createNetW019Harness(
    trustKey !== undefined
      ? { adapters: { sellerAuthorizationTrustKey: trustKey } }
      : {},
  );
  const runtime = w019.runtime;
  // Seed the guard policy for the evaluation command (the harness
  // pattern: ALLOW for everyone on the harness organization).
  await runtime.policyService.createPolicy(w019.bootstrapCtx, {
    subject: "*",
    action: "adRequest.evaluate",
    resource: "*",
    effect: "allow",
    createdBy: "bootstrap",
  });
  const referenceAdapter = runtime.openRtbProviders.find(
    (adapter) => adapter.info.provider === OPENRTB_REFERENCE_PROVIDER_ID,
  ) as OpenRtbReferenceAdapter | undefined;
  if (!referenceAdapter) {
    throw new Error("the default runtime must wire the OpenRTB reference adapter");
  }
  return {
    w019,
    runtime,
    bootstrapCtx: w019.bootstrapCtx,
    creatorPersonId: w019.creatorPersonId,
    operatorPersonId: w019.operatorPersonId,
    organizationScopeId: w019.organizationScopeId,
    secondOrgId: w019.secondOrgId,
    secondOrgPersonId: w019.secondOrgPersonId,
    referenceAdapter,
    async teardown() {
      await w019.teardown();
    },
  };
}

// ---------------------------------------------------------------------------
// The seller-authorization trust-envelope fixtures (PR #47 remediation)
// ---------------------------------------------------------------------------

/** The canonical signing timestamp for the trust-envelope fixtures. */
export const SIGNED_AT = "2026-09-01T11:30:00.000Z";

/**
 * Sign ONE seller-authorization submission with a trust key (the
 * trusted collector side of the boundary). Returns the submission
 * with its integrity envelope attached.
 */
export function signSellerAuthorization<
  T extends {
    readonly providerId: string;
    readonly sourceKind: "ads.txt" | "app-ads.txt" | "sellers.json";
    readonly content: string;
    readonly sourceIdentity: string;
    readonly observedAt?: string;
  },
>(
  submission: T,
  trustKey: string = SELLER_AUTH_TRUST_TEST_SECRET,
): T & { integrity: SellerAuthorizationIntegrityBlock } {
  const { integrity: _existing, ...rest } = submission as T & {
    integrity?: SellerAuthorizationIntegrityBlock;
  };
  void _existing;
  const body = rest as T;
  return {
    ...body,
    integrity: buildSellerAuthorizationIntegrity(
      {
        sourceKind: body.sourceKind,
        sourceIdentity: body.sourceIdentity,
        content: body.content,
        ...(body.observedAt !== undefined ? { observedAt: body.observedAt } : {}),
      },
      trustKey,
      SIGNED_AT,
    ),
  };
}

/**
 * How the `verifyingAuthorizations` fixture bundle authenticates (the
 * remediation regression knobs):
 *  - `signed`   — the default: valid envelopes from the trusted key;
 *  - `unsigned` — no envelope at all (fabricated caller content);
 *  - `tampered` — a syntactically valid envelope whose signature does
 *                 NOT match the content (tamper/forge);
 *  - `wrongKey` — a correctly-computed envelope signed with a
 *                 DIFFERENT key (an untrusted signer).
 */
export type SellerAuthorizationIntegrityMode =
  | "signed"
  | "unsigned"
  | "tampered"
  | "wrongKey";

/**
 * Apply an integrity mode to ONE submission-shaped fixture.
 * `unsigned` returns the body WITHOUT an envelope; `tampered` keeps a
 * valid-shape envelope but flips its signature; `wrongKey` signs
 * with the untrusted test key.
 */
function applyIntegrityMode<
  T extends {
    readonly providerId: string;
    readonly sourceKind: "ads.txt" | "app-ads.txt" | "sellers.json";
    readonly content: string;
    readonly sourceIdentity: string;
    readonly observedAt?: string;
  },
>(submission: T, mode: SellerAuthorizationIntegrityMode): T {
  switch (mode) {
    case "unsigned":
      return submission;
    case "tampered": {
      const signed = signSellerAuthorization(submission);
      // Flip the first hex nibble — a well-formed but WRONG signature
      // (the envelope must fail content verification).
      const flipped = signed.integrity.signature.startsWith("0")
        ? signed.integrity.signature.replace(/^0/, "1")
        : signed.integrity.signature.replace(/^./, "0");
      return { ...submission, integrity: { ...signed.integrity, signature: flipped } };
    }
    case "wrongKey":
      return signSellerAuthorization(submission, SELLER_AUTH_TRUST_WRONG_KEY);
    case "signed":
      return signSellerAuthorization(submission);
  }
}

/** A person's execution context (defaults to the creator). */
export function supplyActorCtx(
  harness: NetW023SupplyHarness,
  correlationId: string,
  personId?: string,
): ExecutionContext {
  return personCtx(harness.w019, personId ?? harness.creatorPersonId, correlationId);
}

/** Fresh idempotency keys (unique per call). */
export function freshKey(prefix: string): string {
  return w019Key(prefix);
}

/** Register inventory supply bound to the OpenRTB provider identity. */
export async function registerExternalSupply(
  harness: NetW023SupplyHarness,
  opts: {
    readonly externalId?: string;
    readonly format?: string;
    readonly surfaceKind?: string;
    readonly actorPersonId?: string;
    readonly idempotencyKey?: string;
  } = {},
): Promise<{ itemId: string; organizationScopeId: string }> {
  const item = await registerInventoryItem(harness.w019, {
    surfaceKind: opts.surfaceKind ?? "publisher",
    format: opts.format ?? "display",
    externalReference: {
      provider: SUPPLY_PROVIDER_ID,
      externalId: opts.externalId ?? PUBLISHER_DOMAIN,
      url: `https://${opts.externalId ?? PUBLISHER_DOMAIN}`,
    },
    ...(opts.actorPersonId !== undefined ? { actorPersonId: opts.actorPersonId } : {}),
    idempotencyKey: opts.idempotencyKey ?? freshKey("w023-item"),
  });
  return { itemId: item.id, organizationScopeId: item.organizationScopeId };
}

// ---------------------------------------------------------------------------
// The notice-side harness (measurement routing path)
// ---------------------------------------------------------------------------

export interface NetW023NoticeHarness {
  readonly w006: NetW006Harness;
  readonly runtime: NetW006Harness["runtime"];
  readonly bootstrapCtx: ExecutionContext;
  readonly personId: string;
  readonly subjectId: string;
  readonly organizationScopeId: string;
  /** The delivery-notice adapter (direct unit access). */
  readonly noticeAdapter: OpenRtbDeliveryNoticeAdapter;
  teardown(): Promise<void>;
}

export async function createNetW023NoticeHarness(): Promise<NetW023NoticeHarness> {
  const noticeAdapter = new OpenRtbDeliveryNoticeAdapter({
    verificationSecret: OPENRTB_DELIVERY_TEST_SECRET,
  });
  const w006 = await createNetW006Harness({
    measurement: { providers: [noticeAdapter] },
  });
  // Seed the measurement-report submission guard policy (the W022
  // harness pattern — the HTTP route requires it).
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
    noticeAdapter,
    async teardown() {
      await w006.teardown();
    },
  };
}

// ---------------------------------------------------------------------------
// Raw payload factories (the provider side of the boundary)
// ---------------------------------------------------------------------------

export interface RawPayloadOverrides {
  readonly remove?: readonly string[];
  readonly set?: Readonly<Record<string, unknown>>;
}

function applyOverrides(
  body: Record<string, unknown>,
  overrides: RawPayloadOverrides = {},
): Record<string, unknown> {
  const out: Record<string, unknown> = { ...body };
  for (const key of overrides.remove ?? []) {
    delete out[key];
  }
  for (const [key, value] of Object.entries(overrides.set ?? {})) {
    out[key] = value;
  }
  return out;
}

/**
 * A VALID raw vendor bid request (the reference OpenRTB shape),
 * carrying a complete two-hop supply chain and the SENSITIVE vendor
 * fields (device/user/regs/ext) the privacy redaction must drop.
 */
export function rawBidRequest(overrides: RawPayloadOverrides = {}): Record<string, unknown> {
  const body: Record<string, unknown> = {
    openrtbVersion: "2.5",
    id: "w023-request-1",
    imp: [
      {
        id: "1",
        banner: { w: 300, h: 250 },
        bidfloor: 1.25,
        bidfloorcur: "USD",
      },
    ],
    site: {
      domain: PUBLISHER_DOMAIN,
      name: "Example Publisher",
      publisher: { domain: PUBLISHER_DOMAIN, name: "Example Publisher" },
    },
    source: {
      ext: {
        schain: {
          complete: 1,
          ver: "1.0",
          nodes: [
            { asi: FIRST_EXCHANGE, sid: FIRST_SELLER_ID, hp: 1, name: "Exchange One", rid: "w023-request-1" },
            { asi: SECOND_EXCHANGE, sid: SECOND_SELLER_ID, hp: 1, name: "Exchange Two" },
          ],
        },
      },
    },
    // Sensitive vendor fields — MUST be redacted (names only).
    device: { ifa: "opaque-device-id-123", ip: "192.0.2.1", ua: "Mozilla/5.0" },
    user: { id: "opaque-user-id-456" },
    regs: { coppa: 0 },
    ext: { vendor: "opaque-extension" },
    badv: ["blocklisted.example"],
    bcat: ["IAB1-1"],
  };
  return applyOverrides(body, overrides);
}

/** The publisher-side ads.txt content authorizing the FIRST node. */
export function publisherAdsTxtContent(options: {
  readonly sellerId?: string;
  readonly relationship?: string;
} = {}): string {
  return [
    "# authorized sellers",
    "CONTACT=admin@example.com",
    `SUBDOMAIN=cdn.example.com`,
    `${FIRST_EXCHANGE}, ${options.sellerId ?? FIRST_SELLER_ID}, ${options.relationship ?? "DIRECT"}, cert-123`,
    "exchange-other.example, 999, RESELLER",
  ].join("\n");
}

/** The FIRST exchange's sellers.json authorizing the SECOND node. */
export function firstExchangeSellersJson(options: {
  readonly sellerId?: string;
  readonly sellerType?: string;
} = {}): string {
  return JSON.stringify({
    version: "2.0",
    sellers: [
      {
        seller_id: options.sellerId ?? SECOND_SELLER_ID,
        name: "Exchange Two",
        domain: SECOND_EXCHANGE,
        seller_type: options.sellerType ?? "INTERMEDIARY",
        ext: { note: "opaque" },
      },
    ],
    contacts: [{ name: "Opaque Contact", email: "contact@example.com" }],
  });
}

/**
 * A seller-authorization submission bundle that VERIFIES the chain.
 * PR #47 remediation: every fixture is SIGNED with the harness trust
 * key by default (integrityMode "signed"); the remediation knobs
 * produce unauthenticated / tampered / wrong-key evidence instead.
 * `omitObservedAt` drops the observation timestamp (a signed
 * submission without freshness — the mandatory-freshness gate).
 */
export function verifyingAuthorizations(overrides: {
  readonly adsTxtContent?: string;
  readonly sellersJsonContent?: string;
  readonly observedAt?: string;
  readonly omitObservedAt?: boolean;
  readonly integrityMode?: SellerAuthorizationIntegrityMode;
} = {}): {
  readonly providerId: string;
  readonly sourceKind: "ads.txt" | "sellers.json";
  readonly content: string;
  readonly sourceIdentity: string;
  readonly observedAt?: string;
  readonly integrity?: SellerAuthorizationIntegrityBlock;
}[] {
  const mode = overrides.integrityMode ?? "signed";
  const withObservedAt =
    overrides.observedAt ?? (overrides.omitObservedAt === true ? undefined : OBSERVED_AT);
  return [
    applyIntegrityMode(
      {
        providerId: SUPPLY_PROVIDER_ID,
        sourceKind: "ads.txt",
        content: overrides.adsTxtContent ?? publisherAdsTxtContent(),
        sourceIdentity: PUBLISHER_DOMAIN,
        ...(withObservedAt !== undefined ? { observedAt: withObservedAt } : {}),
      },
      mode,
    ),
    applyIntegrityMode(
      {
        providerId: SUPPLY_PROVIDER_ID,
        sourceKind: "sellers.json",
        content: overrides.sellersJsonContent ?? firstExchangeSellersJson(),
        sourceIdentity: FIRST_EXCHANGE,
        ...(withObservedAt !== undefined ? { observedAt: withObservedAt } : {}),
      },
      mode,
    ),
  ];
}

/** A VALID raw delivery notice, signed with the test secret. */
export function rawDeliveryNotice(overrides: RawPayloadOverrides = {}): Record<string, unknown> {
  const body: Record<string, unknown> = {
    noticeId: "delivery-notice-001",
    requestRef: "w023-request-1",
    impressionRef: "1",
    subjectRefs: ["ext-openrtb-subject-7"],
    outcomeType: "view",
    observedValue: { value: 1, unit: "impressions" },
    confidence: { point: 0.99 },
    attributionMode: "deterministic",
    deterministicLink: "w023-request-1",
    method: "openrtb-delivery-notice",
    methodVersion: "1.0.0",
    collectedAt: "2026-08-30T10:00:00.000Z",
    // Sensitive vendor fields — MUST be redacted (names only).
    device: { ifa: "opaque-device-id-123" },
    user: { id: "opaque-user-id-456" },
    vendorExtensions: { experimentBucket: 4 },
  };
  const patched = applyOverrides(body, overrides);
  patched["integrity"] = signRawReport(patched, OPENRTB_DELIVERY_TEST_SECRET);
  return patched;
}

// ---------------------------------------------------------------------------
// The composed command helpers (the golden paths)
// ---------------------------------------------------------------------------

/** Evaluate ONE external ad request through the COMPOSED api command. */
export async function evaluateRequest(
  harness: NetW023SupplyHarness,
  options: {
    readonly request: unknown;
    readonly sellerAuthorizations?: readonly {
      readonly providerId: string;
      readonly sourceKind: "ads.txt" | "app-ads.txt" | "sellers.json";
      readonly content: string;
      readonly sourceIdentity: string;
      readonly observedAt?: string;
      readonly integrity?: SellerAuthorizationIntegrityBlock;
    }[];
    readonly evaluatedAt?: string;
    readonly organizationScopeId?: string;
    readonly actorPersonId?: string;
    readonly providerId?: string;
  },
): Promise<ApiExternalAdRequestEvaluationView> {
  const ctx = supplyActorCtx(harness, "w023-evaluate", options.actorPersonId);
  return harness.runtime.apiCommands.evaluateExternalAdRequest(ctx, harness.creatorPersonId, {
    organizationScopeId: options.organizationScopeId ?? harness.organizationScopeId,
    providerId: options.providerId ?? SUPPLY_PROVIDER_ID,
    request: options.request,
    ...(options.sellerAuthorizations !== undefined
      ? { sellerAuthorizations: options.sellerAuthorizations }
      : {}),
    ...(options.evaluatedAt !== undefined ? { evaluatedAt: options.evaluatedAt } : {}),
  });
}

/** Submit ONE delivery notice through the COMPOSED measurement command. */
export async function submitNotice(
  harness: NetW023NoticeHarness,
  options: {
    readonly notice: unknown;
    readonly idempotencyKey: string;
    readonly subjectId: string;
    readonly organizationScopeId?: string;
    readonly correlationId?: string;
  },
): Promise<ApiMeasurementReportSubmissionView> {
  const ctx = actorCtx(harness.w006, options.correlationId ?? "w023-submit");
  return harness.runtime.apiCommands.submitMeasurementReport(ctx, harness.personId, {
    organizationScopeId: options.organizationScopeId ?? harness.organizationScopeId,
    subjectReference: {
      subjectId: options.subjectId,
      subjectType: "contribution",
    },
    idempotencyKey: options.idempotencyKey,
    providerId: OPENRTB_DELIVERY_PROVIDER_ID,
    report: options.notice,
  });
}

export { actorCtx, createNetW006Harness };
