/**
 * NET-W023 — the reference vendor bid-request shape: parsing +
 * fail-closed validation + neutral normalization (ADAPTER-001; issue
 * #46 scope 1).
 *
 * This module owns the PROVIDER-SPECIFIC wire vocabulary (the
 * OpenRTB-style raw request shape the reference adapter accepts).
 * Nothing here is imported by a domain authority (architecture-lock
 * §14.24 — provider SDK/types never cross into core domain modules).
 *
 * Reference raw request shape (this adapter's vendor tier):
 *  - `openrtbVersion`    REQUIRED — must be in the closed supported
 *                        set (2.5 / 2.6); anything else fails closed.
 *  - `id`                REQUIRED — the request id (≤ 128 chars).
 *  - `imp`               REQUIRED — 1..16 impression objects, each
 *                        carrying EXACTLY ONE media-type block
 *                        (banner | video | audio | native), a
 *                        non-empty `id`, optional `instl` 0|1,
 *                        optional `bidfloor` (finite, ≥ 0) and
 *                        optional `bidfloorcur` (ISO-4217-style,
 *                        default USD; MIXED currencies are a
 *                        contradictory critical value).
 *  - `app` XOR `site`    REQUIRED — the supply identity: `app.bundle`
 *                        (≤ 200) or `site.domain` (≤ 200); both
 *                        present is contradictory; neither is
 *                        unresolvable. Optional `publisher.domain`.
 *  - `source.ext.schain` OPTIONAL — the embedded supply chain
 *                        ({ complete: 0|1, ver, nodes: [{ asi, sid,
 *                        hp?, name?, rid? }] }, 1..12 nodes, no
 *                        duplicate (asi, sid) pairs).
 *  - EVERY other field (device, user, regs, ext, badv, bcat, cur,
 *    at, tmax, test, …) is REDACTED: dropped and reported by NAME
 *    only in `redactedFieldNames` (bounded; PRIV-002/PRIV-003 —
 *    sensitive vendor values never cross the boundary).
 *
 * Normalization is PURE and deterministic: the same payload always
 * produces the identical neutral facts + digest. The floor price is
 * an ECONOMIC FACT (the binding minimum across impressions), never a
 * ledger mutation.
 *
 * Adapter tier: imports core contracts + the neutral port + the local
 * canonical helper only; no domain imports (tier matrix).
 */

import { isInventoryFormat } from "../../core/inventory.ts";
import type { InventoryFormat } from "../../core/inventory.ts";
import {
  OpenRtbRequestRejectedError,
} from "../port.ts";
import type {
  NormalizedOpenRtbImpression,
  NormalizedOpenRtbRequest,
  NormalizedOpenRtbSupply,
  NormalizedFloorPrice,
  NormalizedSupplyChain,
  NormalizedSupplyChainNode,
  OpenRtbRequestRejectionReason,
  RawOpenRtbRequestSubmission,
} from "../port.ts";
import {
  OPENRTB_MAX_CANONICAL_PAYLOAD_CHARS,
  OPENRTB_MAX_DIMENSION,
  OPENRTB_MAX_FIELD_CHARS,
  OPENRTB_MAX_IMPRESSIONS,
  OPENRTB_MAX_REQUEST_ID_CHARS,
  OPENRTB_MAX_SCHAIN_NODES,
  OPENRTB_SUPPORTED_VERSIONS,
  isOpenRtbSupportedVersion,
} from "../port.ts";
import { canonicalJson, computeCanonicalDigest } from "./canonical-json.ts";

/** Max vendor field names reported in redactedFieldNames (bounded). */
export const MAX_REDACTED_FIELD_NAMES = 24;

/** The default floor currency (the OpenRTB wire default). */
const DEFAULT_FLOOR_CURRENCY = "USD";

const CURRENCY_RE = /^[A-Z]{3}$/;

/**
 * The media-type block → provider-neutral inventory format mapping
 * (the closed, deterministic mapping — no vendor creative specs
 * cross the boundary).
 */
const MEDIA_TYPE_FORMATS: Readonly<Record<string, InventoryFormat>> = {
  banner: "display",
  video: "video",
  audio: "audio",
  native: "native",
};

/** Build the fail-closed rejection error (context never carries values). */
function reject(
  reason: OpenRtbRequestRejectionReason,
  providerId: string,
  message: string,
  field?: string,
): OpenRtbRequestRejectedError {
  return new OpenRtbRequestRejectedError(
    reason,
    `provider ${providerId} request rejected: ${message}`,
    { providerId, ...(field !== undefined ? { field } : {}) },
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

/** Validate a bounded non-empty string field. */
function boundedString(
  raw: Record<string, unknown>,
  field: string,
  providerId: string,
  maxChars: number,
  onMissing: OpenRtbRequestRejectionReason,
): string {
  const value = raw[field];
  if (!nonEmptyString(value)) {
    throw reject(onMissing, providerId, `${field} must be a non-empty string`, field);
  }
  if (value.length > maxChars) {
    throw reject(
      "cardinality_exceeded",
      providerId,
      `${field} exceeds the ${String(maxChars)}-character bound`,
      field,
    );
  }
  return value;
}

/** Validate an OpenRTB 0|1 integer flag. */
function zeroOneFlag(
  raw: Record<string, unknown>,
  field: string,
  providerId: string,
): number | null {
  const value = raw[field];
  if (value === undefined || value === null) return null;
  if (typeof value !== "number" || !Number.isInteger(value) || (value !== 0 && value !== 1)) {
    throw reject(
      "unsafe_critical_value",
      providerId,
      `${field} must be the integer 0 or 1`,
      field,
    );
  }
  return value;
}

/** Validate a positive integer dimension (banner width/height). */
function dimension(
  raw: Record<string, unknown>,
  field: string,
  providerId: string,
): number | null {
  const value = raw[field];
  if (value === undefined || value === null) return null;
  if (
    typeof value !== "number" ||
    !Number.isInteger(value) ||
    value <= 0 ||
    value > OPENRTB_MAX_DIMENSION
  ) {
    throw reject(
      "unsafe_critical_value",
      providerId,
      `${field} must be a positive integer of at most ${String(OPENRTB_MAX_DIMENSION)}`,
      field,
    );
  }
  return value;
}

// ---------------------------------------------------------------------------
// The supply identity (app XOR site)
// ---------------------------------------------------------------------------

function normalizeSupply(
  raw: Record<string, unknown>,
  providerId: string,
): NormalizedOpenRtbSupply {
  const app = raw["app"];
  const site = raw["site"];
  const hasApp = app !== undefined && app !== null;
  const hasSite = site !== undefined && site !== null;
  if (hasApp && hasSite) {
    // Contradictory critical values: a request cannot describe BOTH
    // an app surface and a site surface.
    throw reject(
      "unsafe_critical_value",
      providerId,
      "a request may describe an app surface or a site surface, not both",
      "app/site",
    );
  }
  if (!hasApp && !hasSite) {
    throw reject(
      "missing_supply_identity",
      providerId,
      "a request must carry an app or site supply identity",
      "app/site",
    );
  }
  const surface = (hasApp ? app : site) as unknown;
  if (!isRecord(surface)) {
    throw reject(
      "invalid_supply_identity",
      providerId,
      hasApp ? "app must be an object" : "site must be an object",
      hasApp ? "app" : "site",
    );
  }
  const identityField = hasApp ? "bundle" : "domain";
  if (surface[identityField] === undefined || surface[identityField] === null) {
    throw reject(
      "missing_supply_identity",
      providerId,
      hasApp
        ? "app.bundle is required (the app supply identity)"
        : "site.domain is required (the site supply identity)",
      identityField,
    );
  }
  const externalId = boundedString(
    surface,
    identityField,
    providerId,
    OPENRTB_MAX_FIELD_CHARS,
    "invalid_supply_identity",
  );
  const publisher = surface["publisher"];
  let publisherDomain: string | null = null;
  if (publisher !== undefined && publisher !== null) {
    if (!isRecord(publisher)) {
      throw reject(
        "invalid_supply_identity",
        providerId,
        "publisher must be an object",
        "publisher",
      );
    }
    if (publisher["domain"] !== undefined && publisher["domain"] !== null) {
      if (!nonEmptyString(publisher["domain"]) || publisher["domain"].length > OPENRTB_MAX_FIELD_CHARS) {
        throw reject(
          "invalid_supply_identity",
          providerId,
          "publisher.domain must be a non-empty string",
          "publisher.domain",
        );
      }
      publisherDomain = publisher["domain"];
    }
  }
  return Object.freeze({
    externalId,
    surfaceKind: hasApp ? ("app" as const) : ("publisher" as const),
    publisherDomain,
  });
}

// ---------------------------------------------------------------------------
// The impression slots
// ---------------------------------------------------------------------------

function normalizeImpression(
  imp: unknown,
  providerId: string,
): NormalizedOpenRtbImpression {
  if (!isRecord(imp)) {
    throw reject("malformed_request", providerId, "each imp entry must be an object", "imp");
  }
  const id = boundedString(imp, "id", providerId, OPENRTB_MAX_REQUEST_ID_CHARS, "malformed_request");
  // EXACTLY ONE media-type block per impression (deterministic format
  // mapping; multiple blocks are contradictory).
  const presentMediaTypes = Object.keys(MEDIA_TYPE_FORMATS).filter(
    (media) => imp[media] !== undefined && imp[media] !== null,
  );
  if (presentMediaTypes.length === 0) {
    throw reject(
      "malformed_request",
      providerId,
      "each imp entry must carry exactly one media-type block (banner, video, audio or native)",
      "imp",
    );
  }
  if (presentMediaTypes.length > 1) {
    throw reject(
      "unsafe_critical_value",
      providerId,
      `an impression may carry one media type only (found ${presentMediaTypes.join("+")})`,
      "imp",
    );
  }
  const mediaType = presentMediaTypes[0]!;
  const mediaBlock = imp[mediaType];
  if (!isRecord(mediaBlock)) {
    throw reject(
      "malformed_request",
      providerId,
      `imp.${mediaType} must be an object`,
      `imp.${mediaType}`,
    );
  }
  // Placement requirements from the banner block (w/h); other media
  // blocks carry no bounded size facts in the neutral contract.
  const width = mediaType === "banner" ? dimension(mediaBlock, "w", providerId) : null;
  const height = mediaType === "banner" ? dimension(mediaBlock, "h", providerId) : null;
  const instl = zeroOneFlag(imp, "instl", providerId);
  return Object.freeze({
    id,
    format: MEDIA_TYPE_FORMATS[mediaType]!,
    interstitial: instl === 1,
    width,
    height,
  });
}

// ---------------------------------------------------------------------------
// The embedded supply chain (source.ext.schain)
// ---------------------------------------------------------------------------

function normalizeSupplyChain(
  raw: Record<string, unknown>,
  providerId: string,
): NormalizedSupplyChain | null {
  const source = raw["source"];
  if (source === undefined || source === null) return null;
  if (!isRecord(source)) {
    throw reject("malformed_request", providerId, "source must be an object", "source");
  }
  const ext = source["ext"];
  if (ext === undefined || ext === null) return null;
  if (!isRecord(ext)) {
    throw reject("malformed_request", providerId, "source.ext must be an object", "source.ext");
  }
  const schain = ext["schain"];
  if (schain === undefined || schain === null) return null;
  if (!isRecord(schain)) {
    throw reject(
      "malformed_request",
      providerId,
      "source.ext.schain must be an object",
      "source.ext.schain",
    );
  }
  const complete = zeroOneFlag(schain, "complete", providerId);
  if (complete === null) {
    throw reject(
      "malformed_request",
      providerId,
      "schain.complete is required (0 or 1)",
      "source.ext.schain.complete",
    );
  }
  const version = boundedString(
    schain,
    "ver",
    providerId,
    16,
    "malformed_request",
  );
  const nodes = schain["nodes"];
  if (!Array.isArray(nodes) || nodes.length === 0) {
    // A supply chain with no nodes cannot be evaluated — ambiguous.
    throw reject(
      "ambiguous_supply_chain",
      providerId,
      "schain.nodes must be a non-empty array",
      "source.ext.schain.nodes",
    );
  }
  if (nodes.length > OPENRTB_MAX_SCHAIN_NODES) {
    throw reject(
      "cardinality_exceeded",
      providerId,
      `schain.nodes exceeds the ${String(OPENRTB_MAX_SCHAIN_NODES)}-node bound`,
      "source.ext.schain.nodes",
    );
  }
  const seen = new Set<string>();
  const normalizedNodes: NormalizedSupplyChainNode[] = [];
  for (const node of nodes) {
    if (!isRecord(node)) {
      throw reject(
        "malformed_request",
        providerId,
        "each schain node must be an object",
        "source.ext.schain.nodes",
      );
    }
    const asi = boundedString(node, "asi", providerId, OPENRTB_MAX_FIELD_CHARS, "malformed_request");
    const sid = boundedString(node, "sid", providerId, OPENRTB_MAX_FIELD_CHARS, "malformed_request");
    const pair = `${asi}\u0000${sid}`;
    if (seen.has(pair)) {
      throw reject(
        "ambiguous_supply_chain",
        providerId,
        "schain carries a duplicate (asi, sid) seller entry",
        "source.ext.schain.nodes",
      );
    }
    seen.add(pair);
    const hp = zeroOneFlag(node, "hp", providerId);
    const name =
      node["name"] === undefined || node["name"] === null
        ? null
        : boundedString(node, "name", providerId, OPENRTB_MAX_FIELD_CHARS, "malformed_request");
    const rid =
      node["rid"] === undefined || node["rid"] === null
        ? null
        : boundedString(node, "rid", providerId, OPENRTB_MAX_FIELD_CHARS, "malformed_request");
    normalizedNodes.push(
      Object.freeze({
        asi,
        sid,
        name,
        rid,
        paymentHop: hp === null ? null : hp === 1,
      }),
    );
  }
  return Object.freeze({
    complete: complete === 1,
    version,
    nodes: Object.freeze(normalizedNodes),
  });
}

// ---------------------------------------------------------------------------
// The request-level floor price (an ECONOMIC FACT, never a mutation)
// ---------------------------------------------------------------------------

function normalizeFloorPrice(
  impressions: readonly Record<string, unknown>[],
  providerId: string,
): NormalizedFloorPrice | null {
  let minFloor: number | null = null;
  let currency: string | null = null;
  for (const imp of impressions) {
    const bidfloor = imp["bidfloor"];
    if (bidfloor === undefined || bidfloor === null) continue;
    if (typeof bidfloor !== "number" || !Number.isFinite(bidfloor) || bidfloor < 0) {
      throw reject(
        "unsafe_critical_value",
        providerId,
        "imp.bidfloor must be a finite non-negative number",
        "imp.bidfloor",
      );
    }
    const rawCurrency = imp["bidfloorcur"];
    let impCurrency = DEFAULT_FLOOR_CURRENCY;
    if (rawCurrency !== undefined && rawCurrency !== null) {
      if (typeof rawCurrency !== "string" || !CURRENCY_RE.test(rawCurrency)) {
        throw reject(
          "unsafe_critical_value",
          providerId,
          "imp.bidfloorcur must be a 3-letter uppercase currency code",
          "imp.bidfloorcur",
        );
      }
      impCurrency = rawCurrency;
    }
    if (currency === null) {
      currency = impCurrency;
    } else if (currency !== impCurrency) {
      // Contradictory critical values: one request, one currency.
      throw reject(
        "unsafe_critical_value",
        providerId,
        "all impression floors must share one currency",
        "imp.bidfloorcur",
      );
    }
    if (minFloor === null || bidfloor < minFloor) minFloor = bidfloor;
  }
  if (minFloor === null || currency === null) return null;
  return Object.freeze({ amount: minFloor, currency });
}

// ---------------------------------------------------------------------------
// The privacy redaction summary (top-level names only, bounded)
// ---------------------------------------------------------------------------

/**
 * Collect the NAMES of top-level fields dropped by redaction (privacy
 * minimization: names only, never values; bounded — the W022
 * convention). `imp`, `app`, `site` and `source` are consumed by
 * normalization (their sub-beyond-contract fields are dropped without
 * a separate names summary — nesting is bounded by the parent caps).
 */
export function collectRequestRedactedFieldNames(
  raw: Record<string, unknown>,
): readonly string[] {
  const consumed = new Set(["openrtbVersion", "id", "imp", "app", "site", "source"]);
  const names: string[] = [];
  for (const key of Object.keys(raw)) {
    if (consumed.has(key)) continue;
    if (raw[key] === undefined) continue;
    if (names.length >= MAX_REDACTED_FIELD_NAMES) break;
    names.push(key);
  }
  return names;
}

// ---------------------------------------------------------------------------
// The request normalization entry point
// ---------------------------------------------------------------------------

/**
 * Normalize ONE raw vendor bid request into the neutral request
 * facts. PURE + fail closed: unsupported versions, malformed
 * structures, missing required identifiers, invalid cardinality,
 * contradictory critical values, oversized payloads and ambiguous
 * supply chains are rejected with the closed
 * {@link OpenRtbRequestRejectionReason} vocabulary (AC-02). The same
 * payload always produces the identical facts + digest (AC-06).
 */
export function normalizeVendorRequest(options: {
  readonly providerId: string;
  readonly payload: unknown;
}): {
  readonly request: NormalizedOpenRtbRequest;
  readonly redactedFieldNames: readonly string[];
} {
  const { providerId, payload } = options;
  if (!isRecord(payload)) {
    throw reject(
      "malformed_request",
      providerId,
      "the bid request payload must be a JSON object",
    );
  }
  // Size bound FIRST (fail closed before any deep parsing).
  const canonicalLength = canonicalJson(payload).length;
  if (canonicalLength > OPENRTB_MAX_CANONICAL_PAYLOAD_CHARS) {
    throw reject(
      "payload_too_large",
      providerId,
      `the canonical request payload exceeds ${String(OPENRTB_MAX_CANONICAL_PAYLOAD_CHARS)} characters`,
    );
  }
  // Protocol version (closed supported set).
  const version = payload["openrtbVersion"];
  if (typeof version !== "string" || !version.trim()) {
    throw reject(
      "malformed_request",
      providerId,
      "openrtbVersion is required",
      "openrtbVersion",
    );
  }
  if (!isOpenRtbSupportedVersion(version)) {
    throw reject(
      "unsupported_openrtb_version",
      providerId,
      `unsupported OpenRTB version ${JSON.stringify(version)} (supported: ${OPENRTB_SUPPORTED_VERSIONS.join(", ")})`,
      "openrtbVersion",
    );
  }
  // Request id.
  const requestId = boundedString(
    payload,
    "id",
    providerId,
    OPENRTB_MAX_REQUEST_ID_CHARS,
    "missing_request_id",
  );
  // Impression slots.
  const imp = payload["imp"];
  if (!Array.isArray(imp) || imp.length === 0) {
    throw reject(
      "malformed_request",
      providerId,
      "imp is required (a non-empty array of impression slots)",
      "imp",
    );
  }
  if (imp.length > OPENRTB_MAX_IMPRESSIONS) {
    throw reject(
      "cardinality_exceeded",
      providerId,
      `imp exceeds the ${String(OPENRTB_MAX_IMPRESSIONS)}-slot bound`,
      "imp",
    );
  }
  const impressions = imp.map((entry) => normalizeImpression(entry, providerId));
  for (const impression of impressions) {
    if (!isInventoryFormat(impression.format)) {
      // Defensive: the media-type mapping is closed; unreachable in
      // practice but keeps the neutral-contract invariant explicit.
      throw reject(
        "malformed_request",
        providerId,
        "the normalized impression format must be an inventory format",
        "imp",
      );
    }
  }
  // Supply identity + supply chain + floor price.
  const supply = normalizeSupply(payload, providerId);
  const supplyChain = normalizeSupplyChain(payload, providerId);
  const floorPrice = normalizeFloorPrice(imp as readonly Record<string, unknown>[], providerId);
  const digest = computeCanonicalDigest(payload);
  const request: NormalizedOpenRtbRequest = Object.freeze({
    providerId,
    requestId,
    openrtbVersion: version,
    supply,
    impressions: Object.freeze(impressions),
    floorPrice,
    supplyChain,
    digest,
  });
  return {
    request,
    redactedFieldNames: collectRequestRedactedFieldNames(payload),
  };
}
