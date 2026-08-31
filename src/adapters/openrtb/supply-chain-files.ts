/**
 * NET-W023 — seller-authorization file normalization (ADAPTER-002;
 * issue #46 scope 3): ads.txt, app-ads.txt and sellers.json parsing
 * into ONE provider-neutral representation with provenance,
 * verification-relevant facts and deterministic digests.
 *
 * This module owns the PROVIDER-SPECIFIC file grammars. Nothing here
 * is imported by a domain authority (architecture-lock §14.24).
 *
 * ads.txt / app-ads.txt grammar (the IAB line grammar, bounded):
 *  - `#`-prefixed lines and blank lines are ignored;
 *  - variable lines (`KEY=VALUE`, no commas) are dropped (not seller
 *    records; not part of the neutral facts);
 *  - seller record lines: `contact_domain, account_id,
 *    DIRECT|RESELLER[, certification_id]` — EXACTLY 3 or 4 comma-
 *    separated fields, relationship case-sensitive. DIRECT maps to
 *    the neutral `direct`, RESELLER to `reseller`. The optional
 *    certification id is dropped (reported by name once).
 *
 * sellers.json grammar: a JSON object with `version` (number or
 * numeric string) and a REQUIRED `sellers` array (1..200) of
 * `{ seller_id, name?, domain?, seller_type:
 * PUBLISHER|INTERMEDIARY|BOTH }` — `domain` REQUIRED for
 * PUBLISHER/BOTH per the specification. `contacts`, `$schema` and
 * per-seller extras are dropped (names recorded, bounded).
 *
 * Normalization is PURE and deterministic: records are canonically
 * SORTED (record-set semantics — identical authorization sets
 * normalize identically regardless of file order) and the digest is
 * the SHA-256 over the canonical serialization of the fact set.
 * Duplicate (contact, account) entries with the SAME relationship
 * dedupe; with DIFFERENT relationships the file is contradictory and
 * fails closed.
 *
 * Adapter tier: imports core contracts + the neutral port + the local
 * canonical helper only; no domain imports (tier matrix).
 */

import {
  OpenRtbRequestRejectedError,
} from "../port.ts";
import type {
  SellerAuthorizationFacts,
  SellerAuthorizationRecord,
  SellerAuthorizationSourceKind,
  OpenRtbRequestRejectionReason,
  RawSellerAuthorizationSubmission,
} from "../port.ts";
import {
  SELLER_AUTHORIZATION_MAX_FILE_CHARS,
  SELLER_AUTHORIZATION_MAX_FILE_LINES,
  SELLER_AUTHORIZATION_MAX_RECORDS,
  OPENRTB_MAX_FIELD_CHARS,
} from "../port.ts";
import { canonicalJson, computeCanonicalDigest } from "./canonical-json.ts";

/** Max names reported in redactedFieldNames (bounded). */
export const MAX_FILE_REDACTED_FIELD_NAMES = 24;

/** Max characters per ads.txt/app-ads.txt line. */
const MAX_LINE_CHARS = 2000;

/** The ads.txt/app-ads.txt relationship mapping (closed). */
const TXT_RELATIONSHIPS: Readonly<Record<string, "direct" | "reseller">> = {
  DIRECT: "direct",
  RESELLER: "reseller",
};

/** The sellers.json seller-type mapping (closed). */
const SELLERS_JSON_TYPES: Readonly<
  Record<string, "publisher" | "intermediary" | "both">
> = {
  PUBLISHER: "publisher",
  INTERMEDIARY: "intermediary",
  BOTH: "both",
};

function reject(
  reason: OpenRtbRequestRejectionReason,
  providerId: string,
  message: string,
  field?: string,
): OpenRtbRequestRejectedError {
  return new OpenRtbRequestRejectedError(
    reason,
    `provider ${providerId} seller authorization rejected: ${message}`,
    { providerId, ...(field !== undefined ? { field } : {}) },
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

/** Validate the submission-level identity + provenance fields. */
function validateSubmissionShape(
  submission: RawSellerAuthorizationSubmission,
): { readonly sourceIdentity: string; readonly observedAt: string | null } {
  const { providerId } = submission;
  if (!nonEmptyString(submission.sourceIdentity) || submission.sourceIdentity.length > OPENRTB_MAX_FIELD_CHARS) {
    throw reject(
      "invalid_supply_identity",
      providerId,
      "sourceIdentity must be a non-empty string identifying whose authorization surface the file is",
      "sourceIdentity",
    );
  }
  if (typeof submission.content !== "string") {
    throw reject(
      "malformed_request",
      providerId,
      "content (the raw file text) is required",
      "content",
    );
  }
  if (submission.content.length > SELLER_AUTHORIZATION_MAX_FILE_CHARS) {
    throw reject(
      "payload_too_large",
      providerId,
      `the file exceeds ${String(SELLER_AUTHORIZATION_MAX_FILE_CHARS)} characters`,
    );
  }
  let observedAt: string | null = null;
  if (submission.observedAt !== undefined && submission.observedAt !== null) {
    if (!nonEmptyString(submission.observedAt) || Number.isNaN(Date.parse(submission.observedAt))) {
      throw reject(
        "malformed_request",
        providerId,
        "observedAt must be an ISO-8601 timestamp",
        "observedAt",
      );
    }
    observedAt = submission.observedAt;
  }
  return { sourceIdentity: submission.sourceIdentity, observedAt };
}

/** Sort records canonically (record-set semantics). */
function sortRecords(
  records: readonly SellerAuthorizationRecord[],
): readonly SellerAuthorizationRecord[] {
  return [...records].sort((a, b) => {
    const bySource = a.sourceIdentity.localeCompare(b.sourceIdentity);
    if (bySource !== 0) return bySource;
    return a.externalSellerId.localeCompare(b.externalSellerId);
  });
}

/** Dedupe identical records; contradictory duplicates fail closed. */
function dedupeRecords(
  records: readonly SellerAuthorizationRecord[],
  providerId: string,
): readonly SellerAuthorizationRecord[] {
  const byKey = new Map<string, SellerAuthorizationRecord>();
  for (const record of records) {
    const key = `${record.sourceIdentity}\u0000${record.externalSellerId}`;
    const existing = byKey.get(key);
    if (existing === undefined) {
      byKey.set(key, record);
      continue;
    }
    if (existing.relationship !== record.relationship) {
      // One file, one relationship per (contact, account) — anything
      // else is a contradictory critical value.
      throw reject(
        "unsafe_critical_value",
        providerId,
        `the file declares contradictory relationships for seller ${record.externalSellerId} at ${record.sourceIdentity}`,
      );
    }
  }
  return [...byKey.values()];
}

/** Build the deterministic facts (sorted records + digest). */
function buildFacts(options: {
  readonly sourceKind: SellerAuthorizationSourceKind;
  readonly sourceIdentity: string;
  readonly observedAt: string | null;
  readonly version: string | null;
  readonly records: readonly SellerAuthorizationRecord[];
}): SellerAuthorizationFacts {
  const sorted = sortRecords(options.records);
  const digestMaterial = {
    sourceKind: options.sourceKind,
    sourceIdentity: options.sourceIdentity,
    observedAt: options.observedAt,
    version: options.version,
    records: sorted,
  };
  return Object.freeze({
    sourceKind: options.sourceKind,
    sourceIdentity: options.sourceIdentity,
    records: Object.freeze(sorted),
    observedAt: options.observedAt,
    version: options.version,
    digest: computeCanonicalDigest(digestMaterial),
  });
}

// ---------------------------------------------------------------------------
// ads.txt / app-ads.txt (the shared line grammar)
// ---------------------------------------------------------------------------

function parseTxtFile(
  submission: RawSellerAuthorizationSubmission,
): {
  readonly facts: SellerAuthorizationFacts;
  readonly redactedFieldNames: readonly string[];
} {
  const { providerId } = submission;
  const { sourceIdentity, observedAt } = validateSubmissionShape(submission);
  const lines = submission.content.split(/\r?\n/);
  if (lines.length > SELLER_AUTHORIZATION_MAX_FILE_LINES) {
    throw reject(
      "cardinality_exceeded",
      providerId,
      `the file exceeds ${String(SELLER_AUTHORIZATION_MAX_FILE_LINES)} lines`,
    );
  }
  const records: SellerAuthorizationRecord[] = [];
  let sawCertificationField = false;
  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (line.length === 0) continue;
    if (line.startsWith("#")) continue;
    if (line.length > MAX_LINE_CHARS) {
      throw reject(
        "malformed_request",
        providerId,
        `a line exceeds ${String(MAX_LINE_CHARS)} characters`,
      );
    }
    // Variable lines (`KEY=VALUE`, no commas) carry publisher metadata,
    // not seller authorizations — dropped (not neutral facts).
    if (!line.includes(",") && line.includes("=")) continue;
    const fields = line.split(",").map((f) => f.trim());
    if (fields.length < 3 || fields.length > 4) {
      throw reject(
        "malformed_request",
        providerId,
        `an ads.txt record line must have 3 or 4 comma-separated fields (got ${String(fields.length)})`,
      );
    }
    const [contact, accountId, relationship, certification] = fields;
    if (!nonEmptyString(contact) || contact.length > OPENRTB_MAX_FIELD_CHARS) {
      throw reject(
        "malformed_request",
        providerId,
        "the ads.txt contact domain must be a non-empty string",
      );
    }
    if (!nonEmptyString(accountId) || accountId.length > OPENRTB_MAX_FIELD_CHARS) {
      throw reject(
        "malformed_request",
        providerId,
        "the ads.txt seller account id must be a non-empty string",
      );
    }
    const mapped = TXT_RELATIONSHIPS[relationship ?? ""];
    if (mapped === undefined) {
      throw reject(
        "malformed_request",
        providerId,
        `the ads.txt relationship must be DIRECT or RESELLER (got ${JSON.stringify(relationship ?? "")})`,
      );
    }
    if (certification !== undefined && nonEmptyString(certification)) {
      sawCertificationField = true;
    }
    records.push({
      sourceIdentity: contact,
      externalSellerId: accountId,
      relationship: mapped,
      name: null,
      domain: null,
    });
  }
  if (records.length === 0) {
    throw reject(
      "malformed_request",
      providerId,
      "the file declares no seller records",
    );
  }
  if (records.length > SELLER_AUTHORIZATION_MAX_RECORDS) {
    throw reject(
      "cardinality_exceeded",
      providerId,
      `the file exceeds ${String(SELLER_AUTHORIZATION_MAX_RECORDS)} seller records`,
    );
  }
  const deduped = dedupeRecords(records, providerId);
  const facts = buildFacts({
    sourceKind: submission.sourceKind,
    sourceIdentity,
    observedAt,
    version: null,
    records: deduped,
  });
  const redactedFieldNames = sawCertificationField ? ["certificationId"] : [];
  return { facts, redactedFieldNames };
}

// ---------------------------------------------------------------------------
// sellers.json
// ---------------------------------------------------------------------------

function parseSellersJson(
  submission: RawSellerAuthorizationSubmission,
): {
  readonly facts: SellerAuthorizationFacts;
  readonly redactedFieldNames: readonly string[];
} {
  const { providerId } = submission;
  const { sourceIdentity, observedAt } = validateSubmissionShape(submission);
  let parsed: unknown;
  try {
    parsed = JSON.parse(submission.content);
  } catch {
    throw reject(
      "malformed_request",
      providerId,
      "the sellers.json content is not valid JSON",
    );
  }
  if (!isRecord(parsed)) {
    throw reject(
      "malformed_request",
      providerId,
      "the sellers.json root must be a JSON object",
    );
  }
  // The redaction summary: top-level extras + per-seller extras
  // (names only, bounded).
  const redacted = new Set<string>();
  for (const key of Object.keys(parsed)) {
    if (key !== "version" && key !== "sellers" && parsed[key] !== undefined) {
      if (redacted.size >= MAX_FILE_REDACTED_FIELD_NAMES) break;
      redacted.add(key);
    }
  }
  // Version (number or numeric string — normalized to a string).
  const version = parsed["version"];
  if (version === undefined || version === null) {
    throw reject(
      "malformed_request",
      providerId,
      "sellers.json version is required",
      "version",
    );
  }
  let versionString: string;
  if (typeof version === "number" && Number.isFinite(version)) {
    versionString = JSON.stringify(version);
  } else if (nonEmptyString(version)) {
    versionString = version;
  } else {
    throw reject(
      "malformed_request",
      providerId,
      "sellers.json version must be a number or string",
      "version",
    );
  }
  const sellers = parsed["sellers"];
  if (!Array.isArray(sellers) || sellers.length === 0) {
    throw reject(
      "malformed_request",
      providerId,
      "sellers.json sellers is required (a non-empty array)",
      "sellers",
    );
  }
  if (sellers.length > SELLER_AUTHORIZATION_MAX_RECORDS) {
    throw reject(
      "cardinality_exceeded",
      providerId,
      `sellers.json exceeds ${String(SELLER_AUTHORIZATION_MAX_RECORDS)} seller records`,
    );
  }
  const records: SellerAuthorizationRecord[] = [];
  for (const seller of sellers) {
    if (!isRecord(seller)) {
      throw reject(
        "malformed_request",
        providerId,
        "each sellers.json entry must be an object",
        "sellers",
      );
    }
    for (const key of Object.keys(seller)) {
      if (
        key !== "seller_id" &&
        key !== "name" &&
        key !== "domain" &&
        key !== "seller_type" &&
        seller[key] !== undefined
      ) {
        if (redacted.size >= MAX_FILE_REDACTED_FIELD_NAMES) break;
        redacted.add(`seller.${key}`);
      }
    }
    const sellerId = seller["seller_id"];
    if (!nonEmptyString(sellerId) || sellerId.length > OPENRTB_MAX_FIELD_CHARS) {
      throw reject(
        "malformed_request",
        providerId,
        "each sellers.json entry must carry a non-empty seller_id",
        "sellers[].seller_id",
      );
    }
    const sellerType = seller["seller_type"];
    if (typeof sellerType !== "string" || SELLERS_JSON_TYPES[sellerType] === undefined) {
      throw reject(
        "malformed_request",
        providerId,
        `sellers.json seller_type must be PUBLISHER, INTERMEDIARY or BOTH (got ${JSON.stringify(String(sellerType ?? ""))})`,
        "sellers[].seller_type",
      );
    }
    const relationship = SELLERS_JSON_TYPES[sellerType]!;
    const domain = seller["domain"];
    if (domain !== undefined && domain !== null && !nonEmptyString(domain)) {
      throw reject(
        "malformed_request",
        providerId,
        "sellers.json domain must be a non-empty string when present",
        "sellers[].domain",
      );
    }
    if (domain !== undefined && domain !== null && domain.length > OPENRTB_MAX_FIELD_CHARS) {
      throw reject(
        "malformed_request",
        providerId,
        "sellers.json domain exceeds the field bound",
        "sellers[].domain",
      );
    }
    // Specification rule: domain is REQUIRED for PUBLISHER and BOTH
    // sellers (an inventory owner must be reachable).
    if ((relationship === "publisher" || relationship === "both") && (domain === undefined || domain === null)) {
      throw reject(
        "malformed_request",
        providerId,
        "sellers.json domain is required for PUBLISHER and BOTH sellers",
        "sellers[].domain",
      );
    }
    const name = seller["name"];
    if (name !== undefined && name !== null && !nonEmptyString(name)) {
      throw reject(
        "malformed_request",
        providerId,
        "sellers.json name must be a non-empty string when present",
        "sellers[].name",
      );
    }
    records.push({
      // The publishing exchange's own identity authorizes its listed
      // sellers (the file's sourceIdentity).
      sourceIdentity,
      externalSellerId: sellerId,
      relationship,
      ...(name !== undefined && name !== null ? { name } : { name: null }),
      ...(domain !== undefined && domain !== null ? { domain } : { domain: null }),
    });
  }
  const deduped = dedupeRecords(records, providerId);
  const facts = buildFacts({
    sourceKind: "sellers.json",
    sourceIdentity,
    observedAt,
    version: versionString,
    records: deduped,
  });
  return { facts, redactedFieldNames: [...redacted] };
}

// ---------------------------------------------------------------------------
// The normalization entry point
// ---------------------------------------------------------------------------

/**
 * Normalize ONE raw seller-authorization file into the neutral
 * facts. PURE + fail closed: grammar violations, contradictory
 * relationships, over-broad files and invalid provenance are rejected
 * with the closed {@link OpenRtbRequestRejectionReason} vocabulary
 * (AC-03). Identical authorization sets normalize identically
 * (record-set semantics; AC-06).
 */
export function normalizeSellerAuthorizationFile(
  submission: RawSellerAuthorizationSubmission,
): {
  readonly facts: SellerAuthorizationFacts;
  readonly redactedFieldNames: readonly string[];
} {
  switch (submission.sourceKind) {
    case "ads.txt":
    case "app-ads.txt":
      return parseTxtFile(submission);
    case "sellers.json":
      return parseSellersJson(submission);
    default:
      throw reject(
        "malformed_request",
        submission.providerId,
        `unknown seller-authorization source kind ${JSON.stringify(String(submission.sourceKind))}`,
        "sourceKind",
      );
  }
}

/** Exposed for documentation/pinning: the closed txt vocabulary. */
export const TXT_RELATIONSHIP_VOCABULARY: readonly string[] = Object.keys(
  TXT_RELATIONSHIPS,
);

/** Exposed for documentation/pinning: the closed sellers.json vocabulary. */
export const SELLERS_JSON_TYPE_VOCABULARY: readonly string[] = Object.keys(
  SELLERS_JSON_TYPES,
);

export { canonicalJson };
