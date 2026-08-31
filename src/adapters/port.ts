/**
 * Adapters boundary — external platform/provider integration port.
 *
 * Architecture ref: spec/architecture.md §15 (Interoperability),
 * §18 (`/adapters` — external platform/provider integrations),
 * architecture-lock.md §14 (provider-specific SDK/types do not cross
 * into core domain modules).
 *
 * Concrete adapters live under `src/adapters/<provider>/` and implement
 * `ProviderAdapter`. Domain code never imports a concrete adapter; it
 * consumes provider-neutral ports declared here or in the relevant
 * integration boundary (`/llm`, `/measurement`, `/payments`, etc.).
 */

import { OpenConError } from "../core/errors.ts";
import type { ProviderAdapter } from "../core/adapter.ts";
import type { InventoryFormat } from "../core/inventory.ts";

/**
 * External platform adapter port (e.g. OpenRTB, creator platforms,
 * attribution, affiliate). Each concrete adapter implements
 * `ProviderAdapter`; domain-facing contracts are provider-neutral.
 */
export interface AdaptersPort {
  readonly boundary: "adapters";
  readonly readiness: "ready";
  /** Look up a registered concrete adapter by provider id (for wiring only). */
  resolve(providerId: string): ProviderAdapter | null;
}

// ---------------------------------------------------------------------------
// NET-W023 — OpenRTB and supply-chain adapters (ADAPTER-001..002)
//
// Work order ref: spec/work-orders/NET-W023.md; issue #46.
//
// This file is the NEUTRAL tier (root port of the adapters boundary):
// it may import ONLY core contracts. Provider-specific wire formats,
// SDK types, parsers and field names stay inside the adapter tier
// (`src/adapters/openrtb/`, `src/adapters/registry.ts`,
// `src/adapters/ingress.ts`). Domain authorities consume ONLY the
// neutral contracts below; the bootstrap composition root is the only
// place normalized adapter output connects to existing domain
// authorities (architecture-lock §14: provider SDK/types never cross
// into core domain modules).
// ---------------------------------------------------------------------------

/**
 * The recorded contract lineage of the NET-W023 neutral surface
 * (determinism: the shape that governed a normalization is
 * reproducible — the W019 format-lineage precedent).
 */
export const OPENRTB_ADAPTER_CONTRACT_VERSION = "NET-W023:1" as const;

/**
 * The OpenRTB protocol versions the reference surface accepts (closed
 * set — AC-02: unsupported versions fail closed).
 */
export const OPENRTB_SUPPORTED_VERSIONS = ["2.5", "2.6"] as const;
export type OpenRtbSupportedVersion = (typeof OPENRTB_SUPPORTED_VERSIONS)[number];

export function isOpenRtbSupportedVersion(value: string): value is OpenRtbSupportedVersion {
  return (OPENRTB_SUPPORTED_VERSIONS as readonly string[]).includes(value);
}

/** Closed bounds for the neutral OpenRTB surface (fail closed beyond). */
export const OPENRTB_MAX_REQUEST_ID_CHARS = 128;
export const OPENRTB_MAX_IMPRESSIONS = 16;
export const OPENRTB_MAX_SCHAIN_NODES = 12;
export const OPENRTB_MAX_CANONICAL_PAYLOAD_CHARS = 65_536;
export const OPENRTB_MAX_DIMENSION = 4096;
/** Generic vendor string-field bound (ids, domains, names, refs). */
export const OPENRTB_MAX_FIELD_CHARS = 200;

/** Closed bounds for seller-authorization file normalization. */
export const SELLER_AUTHORIZATION_MAX_RECORDS = 200;
export const SELLER_AUTHORIZATION_MAX_FILE_CHARS = 262_144;
export const SELLER_AUTHORIZATION_MAX_FILE_LINES = 2000;

/**
 * The seller-authorization sources that normalize into ONE neutral
 * representation (ADAPTER-002): ads.txt, app-ads.txt and sellers.json
 * files, plus the SupplyChain object embedded in OpenRTB bid requests.
 */
export const SELLER_AUTHORIZATION_SOURCE_KINDS = [
  "ads.txt",
  "app-ads.txt",
  "sellers.json",
] as const;
export type SellerAuthorizationSourceKind =
  (typeof SELLER_AUTHORIZATION_SOURCE_KINDS)[number];

export function isSellerAuthorizationSourceKind(
  value: string,
): value is SellerAuthorizationSourceKind {
  return (SELLER_AUTHORIZATION_SOURCE_KINDS as readonly string[]).includes(value);
}

/**
 * The closed relationship/type vocabulary for normalized
 * seller-authorization records (§3.3 — one bounded vocabulary across
 * ads.txt DIRECT/RESELLER and sellers.json PUBLISHER/INTERMEDIARY/BOTH).
 */
export const SELLER_RELATIONSHIP_KINDS = [
  "direct",
  "reseller",
  "publisher",
  "intermediary",
  "both",
] as const;
export type SellerRelationshipKind = (typeof SELLER_RELATIONSHIP_KINDS)[number];

export function isSellerRelationshipKind(value: string): value is SellerRelationshipKind {
  return (SELLER_RELATIONSHIP_KINDS as readonly string[]).includes(value);
}

/**
 * The closed rejection-reason vocabulary for OpenRTB /
 * seller-authorization NORMALIZATION (fail closed, stable reasons —
 * the W019 gate-reason / W022 rejection-reason pattern):
 *
 *  - `malformed_request` — the raw payload violates the vendor shape.
 *  - `unsupported_openrtb_version` — protocol version outside the
 *    closed supported set.
 *  - `missing_request_id` — no usable request identifier.
 *  - `missing_supply_identity` — no resolvable app/site supply identity.
 *  - `invalid_supply_identity` — supply identity fields malformed.
 *  - `cardinality_exceeded` — arrays beyond the closed bounds.
 *  - `payload_too_large` — canonical payload over the size bound.
 *  - `unsafe_critical_value` — contradictory or unsafe critical values
 *    (mixed currencies, non-positive dimensions, both app and site…).
 *  - `ambiguous_supply_chain` — the embedded supply chain is invalid
 *    or ambiguous (empty node list, duplicate sellers…).
 */
export const OPENRTB_REQUEST_REJECTION_REASONS = [
  "malformed_request",
  "unsupported_openrtb_version",
  "missing_request_id",
  "missing_supply_identity",
  "invalid_supply_identity",
  "cardinality_exceeded",
  "payload_too_large",
  "unsafe_critical_value",
  "ambiguous_supply_chain",
] as const;
export type OpenRtbRequestRejectionReason =
  (typeof OPENRTB_REQUEST_REJECTION_REASONS)[number];

export function isOpenRtbRequestRejectionReason(
  value: string,
): value is OpenRtbRequestRejectionReason {
  return (OPENRTB_REQUEST_REJECTION_REASONS as readonly string[]).includes(value);
}

/**
 * The closed rejection vocabulary for external ad-request ADMISSION
 * evaluations. These are DECISION facts returned in the evaluation
 * (not thrown): a rejected evaluation is a deterministic derivation
 * outcome — like the W019 settlement-readiness checks — never an
 * authority mutation. Supply-side reasons only: campaign matching
 * stays NET-W021, settlement stays /settlement. PR #47 remediation:
 * `supply_chain_unauthenticated` — the authorization evidence is
 * grammar-valid but not authenticated against the trust channel.
 */
export const EXTERNAL_ADMISSION_REJECTION_REASONS = [
  "supply_not_found",
  "ambiguous_supply",
  "supply_retired",
  "supply_format_mismatch",
  "supply_chain_absent",
  "supply_chain_incomplete",
  "supply_chain_unauthenticated",
  "supply_chain_mismatched",
  "supply_chain_stale",
  "supply_chain_ambiguous",
] as const;
export type ExternalAdmissionRejectionReason =
  (typeof EXTERNAL_ADMISSION_REJECTION_REASONS)[number];

export function isExternalAdmissionRejectionReason(
  value: string,
): value is ExternalAdmissionRejectionReason {
  return (EXTERNAL_ADMISSION_REJECTION_REASONS as readonly string[]).includes(value);
}

/**
 * The closed supply-chain verification statuses (§3.3).
 *
 * PR #47 remediation (architect review): `verified` means the
 * authorization evidence was AUTHENTICATED against the configured
 * seller-authorization trust channel (HMAC integrity envelope over
 * the exact file content + provenance), is FRESH (a non-null
 * `observedAt` within the staleness bound) and is CONSISTENT with
 * the chain. Grammar-valid but UNAUTHENTICATED caller-supplied
 * content — fabricated ads.txt/app-ads.txt/sellers.json — can never
 * produce `verified`: it caps at `unauthenticated` (the facts remain
 * facts, §3.4, but are never promoted to authorization).
 */
export const SUPPLY_CHAIN_VERIFICATION_STATUSES = [
  "verified",
  "absent",
  "incomplete",
  "unauthenticated",
  "mismatched",
  "stale",
  "ambiguous",
] as const;
export type SupplyChainVerificationStatus =
  (typeof SUPPLY_CHAIN_VERIFICATION_STATUSES)[number];

/**
 * How old submitted seller-authorization facts may be before the
 * verification evaluation reports `stale` (the facts may remain facts
 * — they simply cannot support admission; §3.4).
 *
 * PR #47 remediation (architect review): freshness is now REQUIRED —
 * facts whose `observedAt` is MISSING (null) or older than this bound
 * can never support `verified` (missing freshness data is treated as
 * NOT fresh, fail closed).
 */
export const SUPPLY_CHAIN_MAX_AGE_MS = 48 * 60 * 60 * 1000;

/**
 * The only supported seller-authorization integrity algorithm (the
 * PR #47 remediation trust envelope — the W022 report-integrity
 * precedent: HMAC-SHA256, provider-neutral, no vendor SDK). The
 * verification key resolves ONLY through the SecretProvider at
 * composition time (`SELLER_AUTHORIZATION_TRUST_KEY`).
 */
export const SELLER_AUTHORIZATION_INTEGRITY_ALGORITHM = "hmac-sha256" as const;

// ---------------------------------------------------------------------------
// NET-W023 neutral protocol facts (bounded, versioned — AC-01)
// ---------------------------------------------------------------------------

/**
 * One normalized impression slot (bounded placement requirements).
 * The format is the provider-neutral inventory format vocabulary
 * (media-type mapping happens inside the owning adapter).
 */
export interface NormalizedOpenRtbImpression {
  readonly id: string;
  readonly format: InventoryFormat;
  readonly interstitial: boolean;
  readonly width: number | null;
  readonly height: number | null;
}

/** The normalized external supply identity of a request. */
export interface NormalizedOpenRtbSupply {
  /**
   * The canonical external identifier of the supply surface (app
   * bundle or site domain) — resolved against registered inventory
   * through the neutral lookup by (provider, externalId).
   */
  readonly externalId: string;
  readonly surfaceKind: "app" | "publisher";
  /** The publisher's declared domain (site pages or publisher block). */
  readonly publisherDomain: string | null;
}

/** One normalized supply-chain node (OpenRTB `schain` style). */
export interface NormalizedSupplyChainNode {
  /** The ad-system identity declaring this node (exchange domain). */
  readonly asi: string;
  /** The seller's identifier at that ad system. */
  readonly sid: string;
  readonly name: string | null;
  /** The seller's own request identifier, when present. */
  readonly rid: string | null;
  /** The payment-hop flag, when present. */
  readonly paymentHop: boolean | null;
}

/** The normalized supply chain attached to a request. */
export interface NormalizedSupplyChain {
  readonly complete: boolean;
  readonly version: string;
  readonly nodes: readonly NormalizedSupplyChainNode[];
}

/**
 * The request-level floor price — an ECONOMIC FACT (§3.1), never a
 * ledger mutation: the binding (minimum) impression floor and its
 * currency.
 */
export interface NormalizedFloorPrice {
  readonly amount: number;
  readonly currency: string;
}

/**
 * The provider-neutral OpenRTB request facts — the ONLY request
 * content that crosses the adapter boundary. Raw payloads are opaque
 * outside the owning adapter and are never retained by default;
 * sensitive vendor fields (device, user, regs…) never appear here
 * (§3.6 privacy). `digest` is the deterministic SHA-256 digest of the
 * canonical raw payload (reproducibility — AC-06).
 */
export interface NormalizedOpenRtbRequest {
  readonly providerId: string;
  readonly requestId: string;
  readonly openrtbVersion: string;
  readonly supply: NormalizedOpenRtbSupply;
  readonly impressions: readonly NormalizedOpenRtbImpression[];
  readonly floorPrice: NormalizedFloorPrice | null;
  readonly supplyChain: NormalizedSupplyChain | null;
  readonly digest: string;
}

/**
 * One normalized seller-authorization record (the unified neutral
 * representation for ads.txt / app-ads.txt / sellers.json — AC-03).
 */
export interface SellerAuthorizationRecord {
  /** The exchange/ad-system identity this record authorizes. */
  readonly sourceIdentity: string;
  /** The seller's account id at that ad system. */
  readonly externalSellerId: string;
  readonly relationship: SellerRelationshipKind;
  readonly name: string | null;
  readonly domain: string | null;
}

/**
 * The normalized seller-authorization facts for ONE source file:
 * source kind, whose authorization surface it is (publisher domain /
 * exchange domain / app bundle), the canonically SORTED records
 * (record-set semantics — identical authorization sets normalize
 * identically), observed time, source version where available, and the
 * deterministic digest of the canonical record set.
 */
export interface SellerAuthorizationFacts {
  readonly sourceKind: SellerAuthorizationSourceKind;
  readonly sourceIdentity: string;
  readonly records: readonly SellerAuthorizationRecord[];
  readonly observedAt: string | null;
  readonly version: string | null;
  readonly digest: string;
}

// ---------------------------------------------------------------------------
// NET-W023 raw submissions (opaque payloads) + the trust envelope
// ---------------------------------------------------------------------------

/**
 * The integrity envelope a TRUSTED supply-chain collector attaches to
 * a seller-authorization submission (PR #47 remediation — the W022
 * report-integrity precedent). The signature is HMAC-SHA256 over the
 * canonical serialization of the submission facts it attests
 * (`sourceKind`, `sourceIdentity`, the exact file `content`, and
 * `observedAt` — the ABSENCE of freshness is attested as null), so
 * the envelope binds the exact authorization content + provenance the
 * trust channel observed. The verification key resolves ONLY through
 * the SecretProvider at composition time; the envelope NEVER carries
 * the key, and neither the signature nor the file content is ever
 * logged, persisted, or echoed into audit/error payloads (PRIV-002).
 */
export interface SellerAuthorizationIntegrityBlock {
  /** MUST equal "hmac-sha256" (the closed algorithm vocabulary). */
  readonly algorithm: string;
  /** The trusted collector's HMAC signature over the canonical submission facts. */
  readonly signature: string;
  /** When the collector signed (ISO-8601 provenance fact). */
  readonly signedAt: string;
}

/**
 * A raw OpenRTB bid-request submission. `payload` is the vendor-shaped
 * request exactly as the provider delivered it — OPAQUE at every tier
 * except the adapter that owns `providerId`.
 */
export interface RawOpenRtbRequestSubmission {
  readonly providerId: string;
  readonly payload: unknown;
}

/**
 * A raw seller-authorization file submission: the TEXT content of an
 * ads.txt / app-ads.txt file or the JSON content of a sellers.json
 * file, plus the identity whose authorization surface the file is and
 * the observation time (the staleness evaluation input). Opaque outside
 * the owning adapter.
 *
 * PR #47 remediation (architect review): `integrity` is the OPTIONAL
 * trust envelope. Submissions WITHOUT a valid envelope still normalize
 * (their facts remain facts, §3.4) but can NEVER support a `verified`
 * supply chain — grammar-valid fabricated caller content caps at the
 * `unauthenticated` verification status. Freshness is likewise
 * REQUIRED: a submission whose `observedAt` is missing may carry a
 * valid envelope (the signature attests the absence) but its facts
 * can never support `verified` either (`stale`).
 */
export interface RawSellerAuthorizationSubmission {
  readonly providerId: string;
  readonly sourceKind: SellerAuthorizationSourceKind;
  readonly content: string;
  readonly sourceIdentity: string;
  readonly observedAt?: string;
  readonly integrity?: SellerAuthorizationIntegrityBlock;
}

// ---------------------------------------------------------------------------
// NET-W023 normalization results (privacy transparency)
// ---------------------------------------------------------------------------

/**
 * The result of ONE adapter's request normalization.
 * `redactedFieldNames` is the NAMES-only privacy summary of dropped
 * vendor fields (bounded — values NEVER cross the boundary).
 */
export interface OpenRtbRequestNormalization {
  readonly request: NormalizedOpenRtbRequest;
  readonly redactedFieldNames: readonly string[];
}

/** The result of ONE adapter's seller-authorization normalization. */
export interface SellerAuthorizationNormalization {
  readonly facts: SellerAuthorizationFacts;
  readonly redactedFieldNames: readonly string[];
}

/** Normalization result at the ingress boundary (adapter version attached). */
export interface OpenRtbRequestNormalizationResult
  extends OpenRtbRequestNormalization {
  readonly providerVersion: string;
}

/** Seller-authorization normalization result at the ingress boundary. */
export interface SellerAuthorizationNormalizationResult
  extends SellerAuthorizationNormalization {
  readonly providerVersion: string;
}

// ---------------------------------------------------------------------------
// NET-W023 the adapter contract + registry (AC-01/AC-02)
// ---------------------------------------------------------------------------

/**
 * OpenRtbProviderAdapter — the provider-neutral contract every
 * external OpenRTB / supply-chain integration implements (ADAPTER-
 * 001..002). Concrete adapters live under `src/adapters/openrtb/` and
 * are wired by the bootstrap composition root. Normalization is PURE
 * and deterministic: the same payload always produces the identical
 * neutral facts.
 */
export interface OpenRtbProviderAdapter {
  readonly info: {
    readonly kind: "openrtb";
    readonly provider: string;
    readonly version: string;
  };
  /** Initialize the adapter (called once at composition time). */
  initialize(): Promise<void>;
  /** Health check (aggregated into runtime readiness). */
  healthCheck(): Promise<{ readonly ok: boolean; readonly detail?: string }>;
  /**
   * Normalize ONE raw bid request into neutral request facts. MUST
   * fail closed on malformed/unsupported/oversized/contradictory
   * input and REDACT every field beyond the neutral contract
   * (names only).
   */
  normalizeRequest(
    submission: RawOpenRtbRequestSubmission,
  ): Promise<OpenRtbRequestNormalization>;
  /**
   * Normalize ONE raw seller-authorization file into neutral facts
   * with provenance (source kind/identity/observedAt/version) and a
   * deterministic digest. Fail closed on invalid/ambiguous input.
   */
  normalizeSellerAuthorization(
    submission: RawSellerAuthorizationSubmission,
  ): Promise<SellerAuthorizationNormalization>;
}

/**
 * The OpenRTB provider registration boundary (one adapter per provider
 * identity — duplicates fail closed; the W022 measurement-registry
 * pattern).
 */
export interface OpenRtbProviderRegistry {
  /** Register an adapter (composition root only). Fails closed on invalid/duplicate identity. */
  register(adapter: OpenRtbProviderAdapter): void;
  /** The adapter registered under a provider id (undefined when unknown). */
  byProviderId(providerId: string): OpenRtbProviderAdapter | undefined;
  /** All registered adapters (iteration order = registration order). */
  list(): readonly OpenRtbProviderAdapter[];
  /** Aggregate health of every registered adapter. */
  checkHealth(): Promise<
    readonly {
      readonly provider: string;
      readonly ok: boolean;
      readonly detail?: string;
    }[]
  >;
}

// ---------------------------------------------------------------------------
// NET-W023 the neutral read-only inventory lookup (AC-04 — exact-one
// resolution; dependency inversion: declared here, implemented at the
// composition root over /inventory reads; the adapter tier may not
// import domain modules)
// ---------------------------------------------------------------------------

/** A neutral registered-supply match returned by the lookup. */
export interface ExternalInventorySupplyMatch {
  readonly itemId: string;
  readonly organizationScopeId: string;
  readonly surfaceKind: string;
  readonly format: string;
  readonly ownerPersonId: string;
  readonly retiredAt: string | null;
}

/**
 * The neutral, READ-ONLY inventory lookup through which external
 * seller/publisher/app identifiers resolve against REGISTERED supply
 * (§3.4). The lookup returns ALL in-scope matches; exact-one
 * resolution is enforced by the evaluation (zero or multiple matches
 * fail closed). Cross-tenant identifiers resolve as zero matches
 * (not-found semantics — no existence oracle).
 */
export interface ExternalInventorySupplyLookup {
  resolveByExternalReference(
    organizationScopeId: string,
    provider: string,
    externalId: string,
  ): Promise<readonly ExternalInventorySupplyMatch[]>;
}

// ---------------------------------------------------------------------------
// NET-W023 the admission evaluation (AC-04/AC-05 — a derivation, never
// an authority mutation)
// ---------------------------------------------------------------------------

/** The supply-chain verification evaluation result. */
export interface SupplyChainVerification {
  readonly status: SupplyChainVerificationStatus;
  readonly chain: NormalizedSupplyChain | null;
  readonly authorizations: readonly SellerAuthorizationFacts[];
}

/** The resolved registered supply (present iff resolved exactly one). */
export interface ResolvedExternalSupply {
  readonly itemId: string;
  readonly organizationScopeId: string;
  readonly surfaceKind: string;
  readonly format: string;
  readonly ownerPersonId: string;
}

/**
 * The external ad-request admission evaluation — a PURE derivation
 * over (normalized request facts + neutral inventory reads +
 * seller-authorization facts). `admitted` is a supply-side decision
 * ONLY: it authorizes nothing (no campaign authorization, no
 * settlement readiness, no risk clearance, no economic value); every
 * material authority remains owned by its frozen boundary.
 */
export interface ExternalAdRequestEvaluation {
  readonly providerId: string;
  readonly providerVersion: string;
  readonly organizationScopeId: string;
  readonly requestId: string;
  readonly admitted: boolean;
  readonly rejectionReason: ExternalAdmissionRejectionReason | null;
  readonly request: NormalizedOpenRtbRequest;
  readonly resolvedSupply: ResolvedExternalSupply | null;
  readonly supplyChain: SupplyChainVerification;
  readonly redactedFieldNames: readonly string[];
  /**
   * The evaluation anchor: the input anchor when provided (the
   * deterministic W021 evaluation-anchor precedent), else the
   * evaluation-time instant (view-only; never persisted).
   */
  readonly evaluatedAt: string;
}

/** The evaluation input (raw submissions + org scope + anchor). */
export interface ExternalAdRequestEvaluationInput {
  readonly organizationScopeId: string;
  readonly providerId: string;
  readonly payload: unknown;
  readonly sellerAuthorizations?: readonly RawSellerAuthorizationSubmission[];
  readonly evaluatedAt?: string;
}

/**
 * The provider-neutral OpenRTB ingress boundary: routes raw
 * submissions to the registered adapter that owns each provider id
 * (fail closed on unknown providers, spoofed identities and neutral
 * contract violations), and derives the admission evaluation through
 * the neutral read-only inventory lookup. This boundary performs NO
 * mutation and imports no domain module (tier matrix); the bootstrap
 * composition root is the only join to domain authorities.
 */
export interface OpenRtbIngressService {
  normalizeRequestSubmission(
    submission: RawOpenRtbRequestSubmission,
  ): Promise<OpenRtbRequestNormalizationResult>;
  normalizeSellerAuthorizationSubmission(
    submission: RawSellerAuthorizationSubmission,
  ): Promise<SellerAuthorizationNormalizationResult>;
  evaluateAdRequest(
    input: ExternalAdRequestEvaluationInput,
  ): Promise<ExternalAdRequestEvaluation>;
  /** Aggregate health of the registered provider adapters. */
  checkHealth(): Promise<
    readonly {
      readonly provider: string;
      readonly ok: boolean;
      readonly detail?: string;
    }[]
  >;
}

// ---------------------------------------------------------------------------
// NET-W023 errors (closed codes; contexts carry reason/provider/field
// only — never payload values, secrets, or raw content)
// ---------------------------------------------------------------------------

/**
 * NET-W023: raised when a raw submission is addressed to a provider id
 * that is not registered (fail closed).
 */
export class UnknownOpenRtbProviderError extends OpenConError {
  public constructor(
    message: string,
    context?: Readonly<Record<string, unknown>>,
  ) {
    super({
      code: "UNKNOWN_OPENRTB_PROVIDER",
      classification: "validation",
      message,
      retryable: false,
      context,
    });
  }
}

/**
 * NET-W023: raised when a raw OpenRTB / seller-authorization
 * submission is rejected fail closed during NORMALIZATION (stable
 * code OPENRTB_REQUEST_REJECTED + the closed
 * {@link OPENRTB_REQUEST_REJECTION_REASONS} vocabulary in the error
 * context). The context NEVER includes payload values or secret
 * material — only the reason, the provider id, and optionally a field
 * name.
 */
export class OpenRtbRequestRejectedError extends OpenConError {
  public readonly reason: OpenRtbRequestRejectionReason;
  public constructor(
    reason: OpenRtbRequestRejectionReason,
    message: string,
    context?: Readonly<Record<string, unknown>>,
  ) {
    super({
      code: "OPENRTB_REQUEST_REJECTED",
      classification: "validation",
      message,
      retryable: false,
      context: { ...context, reason },
    });
    this.reason = reason;
  }
}

export type { InventoryFormat };
