/**
 * Signed-attestation canonical inputs — NET-W029 (issue #58).
 *
 * PURE + DETERMINISTIC helpers for the "attestation/v2" canonical
 * digest-input discipline. This file EXTENDS the W005 foundation
 * (commitments.ts salted sha256/sha512 commitments + the
 * "attestation/v1" builder in attestation-service.ts) — it never
 * rewrites any of it. The v1 discipline stays byte-identical and
 * untouched; v2 is ADDITIVE and serves the NET-W029 signed
 * attestations.
 *
 * Canonical input (deterministic; built identically at signing and at
 * verification, from the STORED coverage commitments — NEVER from
 * plaintext):
 *
 * ```text
 * attestation/v2
 * statement:       <statement>
 * verifier:        <verifierId>
 * algorithm:       <algorithm>
 * key-reference:   <keyReference>
 * coverage:        <family>:<recordId>:<commitmentAlgorithm>:<digest>
 *                  (sorted by (family, recordId))
 * ```
 *
 * Because every covered digest comes from the STORED commitments, the
 * canonical input can be rebuilt at any time WITHOUT plaintext
 * disclosure. Tampering with the statement, the verifier, the
 * algorithm, the key reference, the covered set or the underlying
 * commitments invalidates the rebuilt input or the current-state
 * re-derivation and verification fails closed (work order §3.4).
 *
 * Privacy (PRIV-003): coverage commitments are SALTed sha256 digests
 * over the canonical facts of the covered authoritative records. The
 * facts string is built server-side, hashed ONCE, and never persisted
 * — the durable attestation record carries only
 * (algorithm, digest, salt) per covered record.
 *
 * The settlement_value family deliberately excludes the MUTABLE
 * lifecycle bookkeeping (state, version, maturedAt, consumedBy,
 * reversal) AND the per-write lineage stamps (executionId,
 * correlationId, causationId — every authorized mutation restamps
 * them) from the canonical facts: legitimate lifecycle progression
 * (PENDING → MATURE → CONSUMED) must not invalidate a sound
 * attestation, while lifecycle invalidation (REVERSED) is caught by
 * the explicit current-state gate in the service (the precise
 * machine-readable reason — an attestation never makes invalidated
 * authoritative state verify as current).
 *
 * Tier compliance: evidence domain → self + core contracts only.
 */

import type { EvidenceCommitment } from "../core/evidence.ts";
import type { Evidence } from "./port.ts";
import type {
  ReputationInputCoverageFacts,
  SettlementValueCoverageFacts,
} from "./port.ts";
import { createEvidenceCommitment } from "./commitments.ts";

/**
 * Deterministic JSON serialization: object keys sorted recursively,
 * `undefined` values dropped, no insignificant whitespace. The same
 * value always serializes to the same string — the reproducibility
 * requirement behind coverage commitments (identical authoritative
 * record content ⇒ identical canonical facts ⇒ identical digest).
 */
export function canonicalJson(value: unknown): string {
  if (
    value === null ||
    typeof value === "number" ||
    typeof value === "boolean" ||
    typeof value === "string"
  ) {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalJson(item)).join(",")}]`;
  }
  if (typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`);
    return `{${entries.join(",")}}`;
  }
  // Functions/symbols/bigints never appear in the authoritative record
  // shapes; stringify defensively rather than throwing so a malformed
  // fact can never produce a non-deterministic input.
  return JSON.stringify(String(value));
}

/**
 * Canonical facts of an EVIDENCE record (the "evidence" coverage
 * family). Evidence records are immutable after creation, so the whole
 * authoritative record is substantive: the commitment binds the
 * record's exact content (subject, provenance, grade, confidence,
 * sensitivity classification, payload/commitment/payloadReference,
 * lineage). For SENSITIVE evidence the payload is already off-record
 * (the stored commitment + derived facts only) — hashing the stored
 * shape reveals nothing more; the raw material never participates.
 */
export function canonicalEvidenceCoverageFacts(record: Evidence): string {
  return canonicalJson(record);
}

/**
 * Canonical facts of a REPUTATION INPUT (the "reputation_input"
 * coverage family). Reputation inputs are immutable + append-only, so
 * the whole record is substantive. The projection below is explicit
 * and stable: adding a field to the facts shape is a deliberate
 * vocabulary-visible change, never accidental.
 */
export function canonicalReputationInputCoverageFacts(
  facts: ReputationInputCoverageFacts,
): string {
  return canonicalJson({
    id: facts.id,
    organizationScopeId: facts.organizationScopeId,
    subjectPersonId: facts.subjectPersonId,
    dimension: facts.dimension,
    basis: facts.basis,
    sources: facts.sources.map((s) => ({ kind: s.kind, id: s.id })),
    description: facts.description,
    occurredAt: facts.occurredAt,
    recordedAt: facts.recordedAt,
    idempotencyKey: facts.idempotencyKey,
    executionId: facts.executionId,
    correlationId: facts.correlationId,
    causationId: facts.causationId,
  });
}

/**
 * Canonical facts of a SETTLEMENT VALUE RECORD (the "settlement_value"
 * coverage family) — the SUBSTANTIVE subset only: beneficiary, amount,
 * sources, maturation policy, description, recognition lineage,
 * idempotency key, recordedAt. Deliberately EXCLUDED: (a) the MUTABLE
 * lifecycle bookkeeping (state, version, maturedAt, consumedBy,
 * reversal) — legitimate lifecycle progression (PENDING → MATURE →
 * CONSUMED) must not invalidate a sound attestation, while lifecycle
 * invalidation (REVERSED) is caught by the explicit current-state gate;
 * and (b) the per-WRITE lineage stamps (executionId, correlationId,
 * causationId) — every authorized mutation restamps them, so they are
 * write bookkeeping, not substantive content.
 */
export function canonicalSettlementValueCoverageFacts(
  facts: SettlementValueCoverageFacts,
): string {
  return canonicalJson({
    id: facts.id,
    organizationScopeId: facts.organizationScopeId,
    beneficiaryPersonId: facts.beneficiaryPersonId,
    amount: facts.amount,
    sources: facts.sources.map((s) => ({ kind: s.kind, id: s.id })),
    maturation: facts.maturation,
    description: facts.description,
    recordedAt: facts.recordedAt,
    recognitionTransactionId: facts.recognitionTransactionId,
    idempotencyKey: facts.idempotencyKey,
  });
}

/**
 * Derive a coverage commitment: a SALTED sha256 commitment over the
 * canonical facts (payload-hiding, binding — the W005 discipline
 * through the W005 primitive `createEvidenceCommitment`). The salt is
 * server-generated per covered record at creation time and STORED
 * beside the digest so verification can re-derive the current digest
 * and compare in constant time (`verifyEvidenceCommitment`).
 */
export function deriveCoverageCommitment(
  canonicalFacts: string,
  salt: string,
): EvidenceCommitment {
  return createEvidenceCommitment(canonicalFacts, { algorithm: "sha256", salt });
}

/**
 * Build the "attestation/v2" canonical digest input for a signed
 * attestation from the statement, the verifier id, the (closed,
 * versioned) algorithm + key reference, and the covered
 * (family, recordId, commitment algorithm, digest) set. PURE +
 * deterministic: sorted coverage lines make the input order-insensitive
 * — the same covered set always produces the same input string.
 *
 * The digests come from the STORED coverage commitments at BOTH
 * signing and verification (no plaintext disclosure anywhere on this
 * path — PRIV-003).
 */
export function buildSignedAttestationDigestInput(
  statement: string,
  verifierId: string,
  algorithm: string,
  keyReference: string,
  coverage: readonly {
    readonly family: string;
    readonly recordId: string;
    readonly algorithm: string;
    readonly digest: string;
  }[],
): string {
  const lines = coverage
    .slice()
    .sort((a, b) =>
      a.family < b.family
        ? -1
        : a.family > b.family
          ? 1
          : a.recordId < b.recordId
            ? -1
            : a.recordId > b.recordId
              ? 1
              : 0,
    )
    .map((c) => `coverage:${c.family}:${c.recordId}:${c.algorithm}:${c.digest}`);
  return [
    "attestation/v2",
    `statement:${statement}`,
    `verifier:${verifierId}`,
    `algorithm:${algorithm}`,
    `key-reference:${keyReference}`,
    ...lines,
  ].join("\n");
}
