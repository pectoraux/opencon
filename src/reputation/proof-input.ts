/**
 * Portable reputation proof canonical inputs — NET-W031 (issue #63).
 *
 * PURE + DETERMINISTIC helpers for the "reputation-proof/v1" canonical
 * digest-input discipline (the W029/W030 pure-input precedent:
 * signed-attestation-input.ts / external-settlement-input.ts). This file
 * EXTENDS the W007 reputation boundary — it never rewrites the scoring
 * engine, the snapshot service or any W007 contract; every W031
 * artifact is ADDITIVE.
 *
 * Canonical input (deterministic; built identically at signing and at
 * verification from the PROOF's OWN presented facts — the proof is
 * SELF-CONTAINED at presentation, so verification NEVER queries
 * tenant-scoped state; work order §3.3):
 *
 * ```text
 * reputation-proof/v1
 * proof:            <proofId>
 * subject:          <subjectPersonId>
 * organization:     <organizationScopeId>
 * snapshot:         <snapshotId>
 * policy:           <policyId>:<policyVersion>
 * reference-at:     <referenceAt>
 * issued-at:        <issuedAt>
 * digest:           <snapshotDigest>
 * dimension:        <dimension>:<score(6dp)>:<capped>:<inputCount>:<verifiedInputCount>:<indicatedInputCount>
 *                   (exactly the eight frozen dimensions, in frozen
 *                    vocabulary order)
 * revoked-at:       none | <revokedAt ISO-8601>
 * revocation-reason: none | <the reason, JSON-string-escaped>
 * ```
 *
 * The lineage block (snapshot id, policy id + version, referenceAt and
 * the SNAPSHOT's digest), the proof id, ANY aggregate dimension fact,
 * the subject, the scope, the issuance timestamp AND the one-way
 * revocation representation are ALL bound INTO the signature: tampering
 * ANY signed line — including STRIPPING or RESETTING `revokedAt` /
 * `revocationReason` on a revoked artifact — changes the rebuilt
 * canonical input and verification fails closed (`signature_mismatch`).
 *
 * Revocation coverage rationale (the architect review remediation on
 * PR #64): the presentation-side verifier is self-contained (zero
 * tenant-state queries), so the artifact's own revocation state is the
 * ONLY revocation signal it can evaluate — it must therefore be
 * UNFORGEABLE, i.e. SIGNED. Revocation remains the W029 one-way field
 * mutation; because the mutation now changes signed content, the
 * authority RE-SEALS the record (re-signs the canonical input
 * including the revocation lines) inside the same revocation
 * transaction — every CURRENT presentation of a revoked proof carries
 * a signature over its revoked state and fails closed on every
 * surface. The per-write bookkeeping (idempotency / execution lineage
 * stamps) stays deliberately unsigned (the W029 exclusion discipline).
 *
 * AGGREGATE DISCLOSURE ONLY (PRIV-001..003, work order §3.2): the
 * canonical facts and the durable proof record carry ONLY the
 * subject/scope references, the lineage tuple, and per-dimension
 * aggregates (score, the authority's capped flag, and the three
 * evidence-reference counts — the REP-004 opaque lineage). No raw
 * personal activity, no input ids, no descriptions, no source refs, no
 * decayed weight internals, no payloads, no cross-tenant data.
 *
 * Tier compliance: reputation domain → self + core contracts only.
 */

import {
  REPUTATION_DIMENSIONS,
  REPUTATION_SCORE_DECIMALS,
} from "../core/reputation.ts";
import type {
  PresentedReputationProof,
  ReputationProof,
  ReputationProofDimensionFact,
} from "./port.ts";
import { REPUTATION_PROOF_FRESHNESS_WINDOW_MS } from "./port.ts";

/**
 * The substantive facts a proof's signature covers. Deliberately a
 * STRUCTURAL type: the same projection is derived at issuance (from the
 * authoritative snapshot) and rebuilt at verification (from the
 * presented proof) — identical content ⇒ identical canonical input.
 * The one-way revocation representation (`revokedAt` /
 * `revocationReason`) is part of the SIGNED content: the proof id
 * (claim identity — tamper-evident on every surface), the issuance
 * state (`none`/`none`) and, after the one-way revocation re-seal, the
 * revoked state.
 */
export interface ReputationProofCanonicalFacts {
  readonly id: string;
  readonly subjectPersonId: string;
  readonly organizationScopeId: string;
  readonly snapshotId: string;
  readonly policyId: string;
  readonly policyVersion: number;
  readonly referenceAt: string;
  readonly issuedAt: string;
  readonly digest: string;
  readonly dimensions: readonly ReputationProofDimensionFact[];
  readonly revokedAt: string | null;
  readonly revocationReason: string | null;
}

/** One machine-readable shape-validation failure (field path + issue). */
export interface ReputationProofShapeIssue {
  readonly field: string;
  readonly issue: string;
}

const SHA256_HEX = /^[0-9a-f]{64}$/;
const SIGNATURE_HEX = /^[0-9a-f]+$/;

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function isParseableTimestamp(value: unknown): boolean {
  return typeof value === "string" && value.length > 0 && !Number.isNaN(Date.parse(value));
}

function isNonNegativeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0;
}

/**
 * Build the "reputation-proof/v1" canonical digest input (PURE +
 * deterministic). Dimension lines are emitted in the ORDER GIVEN — the
 * shape validation requires the frozen vocabulary order, issuance
 * derives from the snapshot's frozen-order scores, so a reordering of
 * the presented facts changes the input and fails the signature check.
 * Scores serialize at the W007 fixed precision (REPUTATION_SCORE_DECIMALS)
 * so floating-point representation can never change a digest.
 *
 * The REVOCATION tail: `revoked-at` carries `none` for a live proof or
 * the one-way revocation timestamp; `revocation-reason` carries `none`
 * or the reason under standard JSON string escaping (deterministic,
 * single-line for ANY reason text — embedded newlines can never
 * fabricate canonical-line ambiguity). Both lines are SIGNED, so a
 * revoked artifact whose revocation representation is stripped, reset
 * or altered fails the signature check; the proof id line makes the
 * claim identity tamper-evident on every surface.
 */
export function buildReputationProofDigestInput(
  facts: ReputationProofCanonicalFacts,
): string {
  const dimensionLines = facts.dimensions.map(
    (d) =>
      `dimension:${d.dimension}:${d.score.toFixed(REPUTATION_SCORE_DECIMALS)}:${d.capped}:${d.inputCount}:${d.verifiedInputCount}:${d.indicatedInputCount}`,
  );
  return [
    "reputation-proof/v1",
    `proof:${facts.id}`,
    `subject:${facts.subjectPersonId}`,
    `organization:${facts.organizationScopeId}`,
    `snapshot:${facts.snapshotId}`,
    `policy:${facts.policyId}:${facts.policyVersion}`,
    `reference-at:${facts.referenceAt}`,
    `issued-at:${facts.issuedAt}`,
    `digest:${facts.digest}`,
    ...dimensionLines,
    `revoked-at:${facts.revokedAt ?? "none"}`,
    `revocation-reason:${facts.revocationReason === null ? "none" : JSON.stringify(facts.revocationReason)}`,
  ].join("\n");
}

/**
 * The substantive-facts projection of a (stored or presented) proof —
 * the exact input to the canonical builder. Includes the SIGNED
 * revocation representation (see the discipline header: revocation is
 * an unforgeable, one-way, tamper-evident statement on the proof
 * surface); write bookkeeping (idempotency / execution lineage stamps)
 * is excluded (never signed — the W029 exclusion discipline).
 */
export function reputationProofCanonicalFacts(
  proof: ReputationProof | PresentedReputationProof,
): ReputationProofCanonicalFacts {
  return {
    id: proof.id,
    subjectPersonId: proof.subjectPersonId,
    organizationScopeId: proof.organizationScopeId,
    snapshotId: proof.snapshotId,
    policyId: proof.policyId,
    policyVersion: proof.policyVersion,
    referenceAt: proof.referenceAt,
    issuedAt: proof.issuedAt,
    digest: proof.digest,
    dimensions: proof.dimensions,
    revokedAt: proof.revokedAt ?? null,
    revocationReason: proof.revocationReason ?? null,
  };
}

/**
 * The SUBSTANTIVE (revocation-excluded) facts projection used for PAIR
 * BINDING on the presentation-side surface: the captured/presented
 * artifact and the authority's current sealed record of the SAME proof
 * share these facts EXACTLY — the one-way revocation mutation (and the
 * re-sealed envelope covering it) is the ONLY legitimate difference
 * between a pre-revocation capture and the current record. A pair
 * whose substantive facts differ is NOT a presentation of the same
 * proof and fails closed (`proof_pair_mismatch`).
 */
export function reputationProofSubstantiveFacts(
  proof: ReputationProof | PresentedReputationProof,
): Omit<ReputationProofCanonicalFacts, "revokedAt" | "revocationReason"> {
  return {
    id: proof.id,
    subjectPersonId: proof.subjectPersonId,
    organizationScopeId: proof.organizationScopeId,
    snapshotId: proof.snapshotId,
    policyId: proof.policyId,
    policyVersion: proof.policyVersion,
    referenceAt: proof.referenceAt,
    issuedAt: proof.issuedAt,
    digest: proof.digest,
    dimensions: proof.dimensions,
  };
}

/**
 * The FIRST substantive field that differs between two artifacts'
 * revocation-excluded facts (machine-readable pair-binding detail;
 * null when the facts are identical). Dimensions are compared
 * element-wise with full precision.
 */
export function firstReputationProofFactDifference(
  a: Omit<ReputationProofCanonicalFacts, "revokedAt" | "revocationReason">,
  b: Omit<ReputationProofCanonicalFacts, "revokedAt" | "revocationReason">,
): string | null {
  if (a.id !== b.id) return "id";
  if (a.subjectPersonId !== b.subjectPersonId) return "subjectPersonId";
  if (a.organizationScopeId !== b.organizationScopeId) return "organizationScopeId";
  if (a.snapshotId !== b.snapshotId) return "snapshotId";
  if (a.policyId !== b.policyId) return "policyId";
  if (a.policyVersion !== b.policyVersion) return "policyVersion";
  if (a.referenceAt !== b.referenceAt) return "referenceAt";
  if (a.issuedAt !== b.issuedAt) return "issuedAt";
  if (a.digest !== b.digest) return "digest";
  if (a.dimensions.length !== b.dimensions.length) return "dimensions";
  for (let i = 0; i < a.dimensions.length; i += 1) {
    const da = a.dimensions[i];
    const db = b.dimensions[i];
    if (da === undefined || db === undefined) return `dimensions[${i}]`;
    if (
      da.dimension !== db.dimension ||
      da.score !== db.score ||
      da.capped !== db.capped ||
      da.inputCount !== db.inputCount ||
      da.verifiedInputCount !== db.verifiedInputCount ||
      da.indicatedInputCount !== db.indicatedInputCount
    ) {
      return `dimensions[${i}]`;
    }
  }
  return null;
}

/**
 * Pure shape validation of a PRESENTED proof (runtime-tolerant: the
 * presented artifact is untrusted JSON, so every field is re-checked).
 * A proof is shape-valid iff:
 *  - the record format is exactly "NET-W031:1";
 *  - the identity/lineage fields are non-empty strings, the policy
 *    version a positive integer, the timestamps parseable ISO-8601,
 *    the digest a 64-char lowercase sha256 hex string;
 *  - `dimensions` is EXACTLY the eight frozen dimensions, in the FROZEN
 *    vocabulary order, each carrying a finite non-negative score,
 *    non-negative integer counts summing consistently
 *    (inputCount === verifiedInputCount + indicatedInputCount — the
 *    W007 scoring invariant), and a boolean capped flag;
 *  - the envelope fields (algorithm, keyReference, signature) are
 *    non-empty strings with a hex signature;
 *  - the one-way revocation fields are null or (parseable timestamp /
 *    non-empty reason).
 *
 * Returns the (possibly empty) list of machine-readable issues; the
 * FIRST issue's field becomes the `proof_shape` check subject so the
 * verdict pins exactly where the artifact is malformed.
 */
export function validateReputationProofShape(
  proof: PresentedReputationProof,
): readonly ReputationProofShapeIssue[] {
  const issues: ReputationProofShapeIssue[] = [];

  if (proof?.recordFormat !== "NET-W031:1") {
    issues.push({ field: "recordFormat", issue: "unsupported_record_format" });
  }
  const fields = proof as unknown as Record<string, unknown>;
  for (const field of [
    "id",
    "organizationScopeId",
    "subjectPersonId",
    "snapshotId",
    "policyId",
    "algorithm",
    "keyReference",
  ] as const) {
    if (!isNonEmptyString(fields[field])) {
      issues.push({ field, issue: "not_a_nonempty_string" });
    }
  }
  if (
    typeof proof.policyVersion !== "number" ||
    !Number.isInteger(proof.policyVersion) ||
    proof.policyVersion < 1
  ) {
    issues.push({ field: "policyVersion", issue: "not_a_positive_integer" });
  }
  for (const field of ["referenceAt", "issuedAt", "createdAt"] as const) {
    if (!isParseableTimestamp(fields[field])) {
      issues.push({ field, issue: "not_a_parseable_timestamp" });
    }
  }
  if (typeof proof.digest !== "string" || !SHA256_HEX.test(proof.digest)) {
    issues.push({ field: "digest", issue: "not_a_sha256_hex_digest" });
  }
  if (typeof proof.signature !== "string" || !SIGNATURE_HEX.test(proof.signature)) {
    issues.push({ field: "signature", issue: "not_a_hex_signature" });
  }
  if (proof.revokedAt !== null && proof.revokedAt !== undefined) {
    if (!isParseableTimestamp(proof.revokedAt)) {
      issues.push({ field: "revokedAt", issue: "not_a_parseable_timestamp" });
    }
  }
  if (
    proof.revocationReason !== null &&
    proof.revocationReason !== undefined &&
    !isNonEmptyString(proof.revocationReason)
  ) {
    issues.push({ field: "revocationReason", issue: "not_a_nonempty_string" });
  }

  // ---- The closed dimension vocabulary (exactly eight, frozen order) --
  const dims = fields.dimensions;
  if (!Array.isArray(dims)) {
    issues.push({ field: "dimensions", issue: "not_an_array" });
    return issues;
  }
  if (dims.length !== REPUTATION_DIMENSIONS.length) {
    issues.push({
      field: "dimensions",
      issue: `expected_${REPUTATION_DIMENSIONS.length}_dimensions`,
    });
  }
  const seen = new Set<string>();
  dims.forEach((entry: unknown, index: number) => {
    const base = `dimensions[${index}]`;
    if (entry === null || typeof entry !== "object") {
      issues.push({ field: base, issue: "not_an_object" });
      return;
    }
    const fact = entry as Record<string, unknown>;
    const dimension = fact.dimension;
    if (
      typeof dimension !== "string" ||
      !(REPUTATION_DIMENSIONS as readonly string[]).includes(dimension)
    ) {
      issues.push({ field: `${base}.dimension`, issue: "not_in_the_frozen_vocabulary" });
    } else if (seen.has(dimension)) {
      issues.push({ field: `${base}.dimension`, issue: "duplicate_dimension" });
    } else {
      seen.add(dimension);
    }
    if (
      typeof fact.score !== "number" ||
      !Number.isFinite(fact.score) ||
      fact.score < 0
    ) {
      issues.push({ field: `${base}.score`, issue: "not_a_finite_nonnegative_number" });
    }
    for (const countField of [
      "inputCount",
      "verifiedInputCount",
      "indicatedInputCount",
    ] as const) {
      if (!isNonNegativeInteger(fact[countField])) {
        issues.push({ field: `${base}.${countField}`, issue: "not_a_nonnegative_integer" });
      }
    }
    if (typeof fact.capped !== "boolean") {
      issues.push({ field: `${base}.capped`, issue: "not_a_boolean" });
    }
    if (
      isNonNegativeInteger(fact.inputCount) &&
      isNonNegativeInteger(fact.verifiedInputCount) &&
      isNonNegativeInteger(fact.indicatedInputCount) &&
      fact.inputCount !== fact.verifiedInputCount + fact.indicatedInputCount
    ) {
      issues.push({
        field: `${base}.inputCount`,
        issue: "count_mismatch (inputCount !== verified + indicated)",
      });
    }
  });
  // Frozen ORDER check (only meaningful when the vocabulary matches).
  if (issues.length === 0) {
    for (let i = 0; i < REPUTATION_DIMENSIONS.length; i += 1) {
      if (dims[i]?.dimension !== REPUTATION_DIMENSIONS[i]) {
        issues.push({ field: "dimensions", issue: "not_in_the_frozen_vocabulary_order" });
        break;
      }
    }
  }
  return issues;
}

/**
 * The staleness/freshness decision (work order §5: staleness is a
 * VERIFICATION-TIME derivation over the issuance timestamp — never a
 * stored lifecycle state). A proof is fresh at `evaluatedAt` iff
 * `0 <= evaluatedAt - issuedAt <= REPUTATION_PROOF_FRESHNESS_WINDOW_MS`:
 * too old is stale, and an evaluatedAt BEFORE issuance (a proof
 * presented as valid before it existed — e.g. a tampered future
 * issuedAt, which the signature check already catches, but fail-closed
 * here too) is equally NOT fresh. PURE + deterministic: the freshness
 * window is a frozen constant, the inputs are explicit; there is no
 * wall clock anywhere on this path.
 */
export function isReputationProofFresh(
  issuedAt: string,
  evaluatedAt: string,
  windowMs: number = REPUTATION_PROOF_FRESHNESS_WINDOW_MS,
): boolean {
  const issued = Date.parse(issuedAt);
  const evaluated = Date.parse(evaluatedAt);
  if (Number.isNaN(issued) || Number.isNaN(evaluated)) return false;
  const age = evaluated - issued;
  return age >= 0 && age <= windowMs;
}
