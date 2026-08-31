/**
 * OpenRTB ingress service — the NET-W023 provider-neutral routing +
 * normalization + admission-evaluation boundary (issue #46 scope 2/4/6).
 *
 * Routes ONE raw OpenRTB / seller-authorization submission to the
 * registered adapter that owns its provider id, ENFORCES the neutral
 * contract on adapter output (a mis-implemented adapter can never
 * inject invalid facts or claim another provider's identity), and
 * derives the external ad-request admission evaluation through the
 * NEUTRAL read-only inventory lookup.
 *
 * This boundary performs NO mutation and imports NO domain module
 * (tier matrix: adapter → domain is forbidden). Persistence — where
 * the sanctioned measurement path requires it — lives in `/outcomes`
 * behind the W022 ingestion composite composed by the bootstrap root;
 * the exact-one inventory lookup is implemented at the composition
 * root over `/inventory` reads and injected here as the neutral
 * {@link ExternalInventorySupplyLookup}.
 *
 * Fail-closed guarantees (issue #46 architectural constraints):
 *  - unknown provider ids → UnknownOpenRtbProviderError;
 *  - adapter output violating the neutral contract or claiming
 *    another provider's identity → rejected (`malformed_request`);
 *  - zero/multiple/cross-tenant inventory matches → the evaluation
 *    fails closed (`supply_not_found` / `ambiguous_supply`);
 *  - unverified/incomplete/mismatched/stale/absent supply chains →
 *    NOT admitted (external assertions never become authorization);
 *  - deterministic: the evaluation is a pure function of the inputs
 *    + the evaluation anchor (the W021 evaluation-anchor precedent).
 */

import type { Logger } from "../core/logger.ts";
import { isInventoryFormat } from "../core/inventory.ts";
import { INVENTORY_FORMATS } from "../core/inventory.ts";
import {
  OpenRtbRequestRejectedError,
  UnknownOpenRtbProviderError,
} from "./port.ts";
import type {
  ExternalAdRequestEvaluation,
  ExternalAdRequestEvaluationInput,
  ExternalInventorySupplyLookup,
  NormalizedOpenRtbRequest,
  OpenRtbIngressService,
  OpenRtbProviderRegistry,
  OpenRtbRequestNormalizationResult,
  RawOpenRtbRequestSubmission,
  RawSellerAuthorizationSubmission,
  SellerAuthorizationFacts,
  SellerAuthorizationNormalizationResult,
  SupplyChainVerificationStatus,
} from "./port.ts";
import {
  OPENRTB_MAX_FIELD_CHARS,
  OPENRTB_MAX_IMPRESSIONS,
  OPENRTB_MAX_REQUEST_ID_CHARS,
  OPENRTB_MAX_SCHAIN_NODES,
  OPENRTB_SUPPORTED_VERSIONS,
  SELLER_AUTHORIZATION_MAX_RECORDS,
  SUPPLY_CHAIN_MAX_AGE_MS,
  isOpenRtbSupportedVersion,
  isSellerRelationshipKind,
  isSellerAuthorizationSourceKind,
} from "./port.ts";

export interface OpenRtbIngressServiceDeps {
  readonly registry: OpenRtbProviderRegistry;
  readonly inventoryLookup: ExternalInventorySupplyLookup;
  readonly logger: Logger;
}

const DIGEST_RE = /^[0-9a-f]{64}$/;
const CURRENCY_RE = /^[A-Z]{3}$/;

/**
 * The deterministic non-verified-status → admission-reason mapping
 * (only a VERIFIED supply chain can support admission).
 */
const CHAIN_STATUS_TO_REASON: Readonly<
  Record<
    Exclude<SupplyChainVerificationStatus, "verified">,
    ExternalAdRequestEvaluation["rejectionReason"]
  >
> = {
  absent: "supply_chain_absent",
  incomplete: "supply_chain_incomplete",
  mismatched: "supply_chain_mismatched",
  stale: "supply_chain_stale",
  ambiguous: "supply_chain_ambiguous",
};

/** Validate that an adapter's REQUEST output satisfies the NEUTRAL contract. */
function assertNeutralRequest(providerId: string, request: unknown): void {
  const reject = (message: string, field: string): never => {
    throw new OpenRtbRequestRejectedError(
      "malformed_request",
      `provider ${providerId} request rejected: the adapter produced neutral request facts violating the contract — ${message}`,
      { providerId, field },
    );
  };
  if (request === null || typeof request !== "object" || Array.isArray(request)) {
    reject("the normalized request must be an object", "request");
  }
  const r = request as Record<string, unknown>;
  if (r["providerId"] !== providerId) {
    reject(
      `the normalized request claims provider id ${String(r["providerId"])} but was routed as ${providerId}`,
      "providerId",
    );
  }
  const requestId = r["requestId"];
  if (
    typeof requestId !== "string" ||
    !requestId.trim() ||
    requestId.length > OPENRTB_MAX_REQUEST_ID_CHARS
  ) {
    reject("requestId must be a non-empty bounded string", "requestId");
  }
  const version = r["openrtbVersion"];
  if (typeof version !== "string" || !isOpenRtbSupportedVersion(version)) {
    reject(
      `openrtbVersion must be one of the supported versions (${OPENRTB_SUPPORTED_VERSIONS.join(", ")})`,
      "openrtbVersion",
    );
  }
  const supply = r["supply"];
  if (supply === null || typeof supply !== "object" || Array.isArray(supply)) {
    reject("supply is required", "supply");
  }
  const s = supply as Record<string, unknown>;
  const externalId = s["externalId"];
  if (
    typeof externalId !== "string" ||
    !externalId.trim() ||
    externalId.length > OPENRTB_MAX_FIELD_CHARS
  ) {
    reject("supply.externalId must be a non-empty bounded string", "supply.externalId");
  }
  if (s["surfaceKind"] !== "app" && s["surfaceKind"] !== "publisher") {
    reject("supply.surfaceKind must be app or publisher", "supply.surfaceKind");
  }
  const publisherDomain = s["publisherDomain"];
  if (
    publisherDomain !== undefined &&
    publisherDomain !== null &&
    (typeof publisherDomain !== "string" || !publisherDomain.trim())
  ) {
    reject("supply.publisherDomain must be a non-empty string or null", "supply.publisherDomain");
  }
  const impressions = r["impressions"];
  if (!Array.isArray(impressions) || impressions.length === 0 || impressions.length > OPENRTB_MAX_IMPRESSIONS) {
    reject(
      `impressions must be a non-empty array of at most ${String(OPENRTB_MAX_IMPRESSIONS)} slots`,
      "impressions",
    );
  }
  for (const impression of impressions as readonly unknown[]) {
    if (impression === null || typeof impression !== "object" || Array.isArray(impression)) {
      reject("each impression must be an object", "impressions");
    }
    const i = impression as Record<string, unknown>;
    if (typeof i["id"] !== "string" || !i["id"].trim()) {
      reject("each impression must carry a non-empty id", "impressions[].id");
    }
    if (typeof i["format"] !== "string" || !isInventoryFormat(i["format"])) {
      reject(
        `each impression format must be one of the inventory formats (${INVENTORY_FORMATS.join(", ")})`,
        "impressions[].format",
      );
    }
    if (typeof i["interstitial"] !== "boolean") {
      reject("each impression must carry the interstitial flag", "impressions[].interstitial");
    }
    for (const dim of ["width", "height"] as const) {
      const value = i[dim];
      if (
        value !== undefined &&
        value !== null &&
        (typeof value !== "number" || !Number.isInteger(value) || value <= 0)
      ) {
        reject(`impression ${dim} must be a positive integer`, `impressions[].${dim}`);
      }
    }
  }
  const floorPrice = r["floorPrice"];
  if (floorPrice !== undefined && floorPrice !== null) {
    if (floorPrice === null || typeof floorPrice !== "object" || Array.isArray(floorPrice)) {
      reject("floorPrice must be an object", "floorPrice");
    }
    const f = floorPrice as Record<string, unknown>;
    if (typeof f["amount"] !== "number" || !Number.isFinite(f["amount"]) || f["amount"] < 0) {
      reject("floorPrice.amount must be a finite non-negative number", "floorPrice.amount");
    }
    if (typeof f["currency"] !== "string" || !CURRENCY_RE.test(f["currency"])) {
      reject("floorPrice.currency must be a 3-letter uppercase code", "floorPrice.currency");
    }
  }
  const chain = r["supplyChain"];
  if (chain !== undefined && chain !== null) {
    if (typeof chain !== "object" || Array.isArray(chain)) {
      reject("supplyChain must be an object", "supplyChain");
    }
    const c = chain as Record<string, unknown>;
    if (typeof c["complete"] !== "boolean") {
      reject("supplyChain.complete must be a boolean", "supplyChain.complete");
    }
    if (typeof c["version"] !== "string" || !c["version"].trim()) {
      reject("supplyChain.version must be a non-empty string", "supplyChain.version");
    }
    const nodes = c["nodes"];
    if (!Array.isArray(nodes) || nodes.length === 0 || nodes.length > OPENRTB_MAX_SCHAIN_NODES) {
      reject(
        `supplyChain.nodes must be a non-empty array of at most ${String(OPENRTB_MAX_SCHAIN_NODES)} nodes`,
        "supplyChain.nodes",
      );
    }
    for (const node of nodes as readonly unknown[]) {
      if (node === null || typeof node !== "object" || Array.isArray(node)) {
        reject("each supply-chain node must be an object", "supplyChain.nodes");
      }
      const n = node as Record<string, unknown>;
      if (typeof n["asi"] !== "string" || !n["asi"].trim()) {
        reject("each supply-chain node must carry a non-empty asi", "supplyChain.nodes[].asi");
      }
      if (typeof n["sid"] !== "string" || !n["sid"].trim()) {
        reject("each supply-chain node must carry a non-empty sid", "supplyChain.nodes[].sid");
      }
    }
  }
  if (typeof r["digest"] !== "string" || !DIGEST_RE.test(r["digest"])) {
    reject("digest must be the 64-hex-char canonical digest", "digest");
  }
}

/** Validate that an adapter's SELLER-AUTHORIZATION output satisfies the contract. */
function assertNeutralSellerFacts(providerId: string, facts: unknown): void {
  const reject = (message: string, field: string): never => {
    throw new OpenRtbRequestRejectedError(
      "malformed_request",
      `provider ${providerId} seller authorization rejected: the adapter produced neutral facts violating the contract — ${message}`,
      { providerId, field },
    );
  };
  if (facts === null || typeof facts !== "object" || Array.isArray(facts)) {
    reject("the normalized facts must be an object", "facts");
  }
  const f = facts as Record<string, unknown>;
  if (typeof f["sourceKind"] !== "string" || !isSellerAuthorizationSourceKind(f["sourceKind"])) {
    reject("facts.sourceKind must be a seller-authorization source kind", "facts.sourceKind");
  }
  if (typeof f["sourceIdentity"] !== "string" || !f["sourceIdentity"].trim()) {
    reject("facts.sourceIdentity must be a non-empty string", "facts.sourceIdentity");
  }
  const records = f["records"];
  if (!Array.isArray(records) || records.length === 0 || records.length > SELLER_AUTHORIZATION_MAX_RECORDS) {
    reject(
      `facts.records must be a non-empty array of at most ${String(SELLER_AUTHORIZATION_MAX_RECORDS)} records`,
      "facts.records",
    );
  }
  for (const record of records as readonly unknown[]) {
    if (record === null || typeof record !== "object" || Array.isArray(record)) {
      reject("each seller-authorization record must be an object", "facts.records");
    }
    const rcrd = record as Record<string, unknown>;
    if (typeof rcrd["sourceIdentity"] !== "string" || !rcrd["sourceIdentity"].trim()) {
      reject("each record must carry a non-empty sourceIdentity", "facts.records[].sourceIdentity");
    }
    if (typeof rcrd["externalSellerId"] !== "string" || !rcrd["externalSellerId"].trim()) {
      reject("each record must carry a non-empty externalSellerId", "facts.records[].externalSellerId");
    }
    if (
      typeof rcrd["relationship"] !== "string" ||
      !isSellerRelationshipKind(rcrd["relationship"])
    ) {
      reject("each record relationship must be part of the closed vocabulary", "facts.records[].relationship");
    }
  }
  if (typeof f["digest"] !== "string" || !DIGEST_RE.test(f["digest"])) {
    reject("facts.digest must be the 64-hex-char canonical digest", "facts.digest");
  }
}

// ---------------------------------------------------------------------------
// The supply-chain verification evaluation (pure; §3.3/§3.4)
// ---------------------------------------------------------------------------

/**
 * Verify the request's supply chain against the submitted
 * seller-authorization facts. PURE and deterministic. Only VERIFIED
 * chains can support admission; unverified, incomplete, stale or
 * ambiguous chains remain FACTS but are never promoted to
 * authorization (§3.4).
 *
 * Verification model (bounded, deterministic):
 *  - node 1 (the publisher's direct seller) must be authorized by the
 *    publisher-side ads.txt / app-ads.txt facts whose sourceIdentity
 *    is the request's supply identity (site domain / app bundle);
 *  - every later node must be authorized by the PRECEDING node's
 *    sellers.json (facts whose sourceIdentity is the preceding
 *    node's asi);
 *  - missing required evidence → `incomplete`; conflicting evidence
 *    (multiple distinct digests for the same required source) →
 *    `ambiguous`; evidence older than the staleness bound → `stale`;
 *    an unauthorized seller → `mismatched`.
 */
export function evaluateSupplyChainVerification(options: {
  readonly requestSupplyChain: NormalizedOpenRtbRequest["supplyChain"];
  readonly requestSupplyIdentity: string;
  readonly authorizations: readonly SellerAuthorizationFacts[];
  readonly evaluatedAt: string;
}): SupplyChainVerificationStatus {
  const { requestSupplyChain, requestSupplyIdentity, authorizations, evaluatedAt } =
    options;
  const chain = requestSupplyChain;
  if (chain === null || chain === undefined) return "absent";
  if (!chain.complete) return "incomplete";
  const evaluatedAtMs = Date.parse(evaluatedAt);
  const staleBeforeMs = evaluatedAtMs - SUPPLY_CHAIN_MAX_AGE_MS;

  let sawMissing = false;
  let sawAmbiguous = false;
  let sawStale = false;
  let sawMismatched = false;

  /**
   * The facts that must govern ONE required authorization source
   * (a publisher surface or an intermediate exchange). Multiple
   * observations of the IDENTICAL fact set are one source; distinct
   * digests are conflicting evidence.
   */
  const requiredFacts = (sourceIdentity: string, kinds: readonly string[]) => {
    const matching = authorizations.filter(
      (facts) => kinds.includes(facts.sourceKind) && facts.sourceIdentity === sourceIdentity,
    );
    if (matching.length === 0) {
      sawMissing = true;
      return null;
    }
    const digests = new Set(matching.map((facts) => facts.digest));
    if (digests.size > 1) {
      sawAmbiguous = true;
      return null;
    }
    if (
      matching.some(
        (facts) =>
          facts.observedAt !== null && Date.parse(facts.observedAt) < staleBeforeMs,
      )
    ) {
      sawStale = true;
    }
    return matching[0]!;
  };

  // Node 1: the publisher-side authorization.
  const publisherFacts = requiredFacts(requestSupplyIdentity, ["ads.txt", "app-ads.txt"]);
  if (publisherFacts !== null) {
    const first = chain.nodes[0]!;
    const authorized = publisherFacts.records.some(
      (record) =>
        record.sourceIdentity === first.asi && record.externalSellerId === first.sid,
    );
    if (!authorized) sawMismatched = true;
  }
  // Later nodes: each authorized by the PRECEDING node's sellers.json.
  for (let index = 1; index < chain.nodes.length; index += 1) {
    const upstream = chain.nodes[index - 1]!;
    const node = chain.nodes[index]!;
    const hopFacts = requiredFacts(upstream.asi, ["sellers.json"]);
    if (hopFacts !== null) {
      const authorized = hopFacts.records.some(
        (record) => record.externalSellerId === node.sid,
      );
      if (!authorized) sawMismatched = true;
    }
  }
  // Deterministic precedence: cannot verify at all > conflicting
  // evidence > stale evidence > unauthorized seller.
  if (sawMissing) return "incomplete";
  if (sawAmbiguous) return "ambiguous";
  if (sawStale) return "stale";
  if (sawMismatched) return "mismatched";
  return "verified";
}

// ---------------------------------------------------------------------------
// The ingress service
// ---------------------------------------------------------------------------

export function createOpenRtbIngressService(
  deps: OpenRtbIngressServiceDeps,
): OpenRtbIngressService {
  const { registry, inventoryLookup, logger } = deps;

  const routeRequest = (submission: { readonly providerId: string }) => {
    if (!submission || typeof submission !== "object") {
      throw new OpenRtbRequestRejectedError(
        "malformed_request",
        "a raw OpenRTB request submission must be an object",
      );
    }
    if (typeof submission.providerId !== "string" || !submission.providerId.trim()) {
      throw new UnknownOpenRtbProviderError(
        "a raw OpenRTB request submission must carry a non-empty providerId",
      );
    }
    const adapter = registry.byProviderId(submission.providerId);
    if (!adapter) {
      throw new UnknownOpenRtbProviderError(
        `no OpenRTB provider adapter is registered for provider id ${submission.providerId}`,
        { providerId: submission.providerId },
      );
    }
    return adapter;
  };

  return {
    async normalizeRequestSubmission(
      submission: RawOpenRtbRequestSubmission,
    ): Promise<OpenRtbRequestNormalizationResult> {
      const adapter = routeRequest(submission);
      const normalized = await adapter.normalizeRequest({
        providerId: submission.providerId,
        payload: submission.payload,
      });
      // Contract enforcement at the boundary: a mis-implemented
      // adapter can never inject neutral facts that violate the
      // frozen contract or claim another provider's identity.
      assertNeutralRequest(submission.providerId, normalized.request);
      const result: OpenRtbRequestNormalizationResult = {
        request: normalized.request,
        redactedFieldNames: normalized.redactedFieldNames,
        providerVersion: adapter.info.version,
      };
      logger.debug("openrtb_request.normalized", {
        providerId: submission.providerId,
        providerVersion: adapter.info.version,
        redactedFieldCount: normalized.redactedFieldNames.length,
      });
      return result;
    },

    async normalizeSellerAuthorizationSubmission(
      submission: RawSellerAuthorizationSubmission,
    ): Promise<SellerAuthorizationNormalizationResult> {
      const adapter = routeRequest(submission);
      if (typeof submission.sourceKind !== "string" || !isSellerAuthorizationSourceKind(submission.sourceKind)) {
        throw new OpenRtbRequestRejectedError(
          "malformed_request",
          `provider ${submission.providerId} seller authorization rejected: sourceKind must be a seller-authorization source kind`,
          { providerId: submission.providerId, field: "sourceKind" },
        );
      }
      const normalized = await adapter.normalizeSellerAuthorization({
        providerId: submission.providerId,
        sourceKind: submission.sourceKind,
        content: submission.content,
        sourceIdentity: submission.sourceIdentity,
        ...(submission.observedAt !== undefined ? { observedAt: submission.observedAt } : {}),
      });
      assertNeutralSellerFacts(submission.providerId, normalized.facts);
      const result: SellerAuthorizationNormalizationResult = {
        facts: normalized.facts,
        redactedFieldNames: normalized.redactedFieldNames,
        providerVersion: adapter.info.version,
      };
      logger.debug("seller_authorization.normalized", {
        providerId: submission.providerId,
        providerVersion: adapter.info.version,
        sourceKind: normalized.facts.sourceKind,
        recordCount: normalized.facts.records.length,
      });
      return result;
    },

    async evaluateAdRequest(
      input: ExternalAdRequestEvaluationInput,
    ): Promise<ExternalAdRequestEvaluation> {
      if (!input || typeof input !== "object") {
        throw new OpenRtbRequestRejectedError(
          "malformed_request",
          "an external ad-request evaluation input must be an object",
        );
      }
      // 1. Normalization (fail closed BEFORE any resolution).
      const normalized = await this.normalizeRequestSubmission({
        providerId: input.providerId,
        payload: input.payload,
      });
      const authorizations: SellerAuthorizationFacts[] = [];
      for (const submission of input.sellerAuthorizations ?? []) {
        const normalizedFacts = await this.normalizeSellerAuthorizationSubmission(submission);
        authorizations.push(normalizedFacts.facts);
      }
      const evaluatedAt = input.evaluatedAt ?? new Date().toISOString();
      if (typeof evaluatedAt !== "string" || Number.isNaN(Date.parse(evaluatedAt))) {
        throw new OpenRtbRequestRejectedError(
          "malformed_request",
          "evaluatedAt must be an ISO-8601 timestamp when provided",
          { field: "evaluatedAt" },
        );
      }

      const request = normalized.request;
      let rejectionReason: ExternalAdRequestEvaluation["rejectionReason"] = null;
      let resolvedSupply: ExternalAdRequestEvaluation["resolvedSupply"] = null;

      // 2. Exact-one inventory resolution through the NEUTRAL read-only
      //    lookup (§3.4: zero/multiple/cross-tenant matches fail
      //    closed; external assertions never create ownership).
      const matches = await inventoryLookup.resolveByExternalReference(
        input.organizationScopeId,
        request.providerId,
        request.supply.externalId,
      );
      if (matches.length === 0) {
        rejectionReason = "supply_not_found";
      } else if (matches.length > 1) {
        rejectionReason = "ambiguous_supply";
      } else {
        const match = matches[0]!;
        resolvedSupply = {
          itemId: match.itemId,
          organizationScopeId: match.organizationScopeId,
          surfaceKind: match.surfaceKind,
          format: match.format,
          ownerPersonId: match.ownerPersonId,
        };
        // 3. Registered supply must still be available (a retired
        //    item's supply is withdrawn — one-way, /inventory-owned).
        if (match.retiredAt !== null) {
          rejectionReason = "supply_retired";
        } else {
          // 4. Every requested impression slot must match the
          //    registered supply's declared format (the conservative
          //    direction — the request cannot widen the supply).
          const formatMismatch = request.impressions.some(
            (impression) => impression.format !== match.format,
          );
          if (formatMismatch) {
            rejectionReason = "supply_format_mismatch";
          }
        }
      }

      // 5. Supply-chain verification (facts never promote to
      //    authorization: only a VERIFIED chain supports admission).
      const chainStatus = evaluateSupplyChainVerification({
        requestSupplyChain: request.supplyChain,
        requestSupplyIdentity: request.supply.externalId,
        authorizations,
        evaluatedAt,
      });
      if (chainStatus !== "verified" && rejectionReason === null) {
        rejectionReason = CHAIN_STATUS_TO_REASON[chainStatus];
      }

      const evaluation: ExternalAdRequestEvaluation = {
        providerId: request.providerId,
        providerVersion: normalized.providerVersion,
        organizationScopeId: input.organizationScopeId,
        requestId: request.requestId,
        admitted: rejectionReason === null,
        rejectionReason,
        request,
        resolvedSupply,
        supplyChain: {
          status: chainStatus,
          chain: request.supplyChain,
          authorizations: Object.freeze([...authorizations]),
        },
        redactedFieldNames: normalized.redactedFieldNames,
        evaluatedAt,
      };
      logger.debug("external_ad_request.evaluated", {
        providerId: request.providerId,
        requestId: request.requestId,
        admitted: evaluation.admitted,
        ...(rejectionReason !== null ? { rejectionReason } : {}),
        supplyChainStatus: chainStatus,
      });
      return evaluation;
    },

    async checkHealth() {
      return registry.checkHealth();
    },
  };
}
