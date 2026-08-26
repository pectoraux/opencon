# NET-W005 — Evidence and Proof-of-Value Foundation

**Status:** READY_FOR_IMPLEMENTATION  
**Architecture:** v1.0 (FROZEN)  
**Requirements:** EVID-001..006, OUT-001, AUD-002  
**Dependencies:** NET-W004 (merged ec23dbf), NET-W003 (merged), NET-W002 (merged)  
**Acceptance Criteria:** NET-W005-AC-01..08  
**Tracking issue:** https://github.com/pectoraux/opencon/issues/9  

## 1. Objective

Implement the provider-neutral evidence and Proof-of-Value foundation
consumed by later measurement, fraud, reputation, advertising, creator,
and procurement work.

The system must represent evidence provenance, evidence grades,
confidence/uncertainty, outcome claims, attestations, and cryptographic
commitments without making downstream economic settlement
authoritative yet.

## 2. Architectural binding

This work item is bound to frozen Architecture v1.0.

- `/evidence` owns evidence, evidence provenance, confidence and
  verification semantics (architecture-lock §4). Agent/model output is
  input evidence or a recommendation; it never directly authorizes
  settlement.
- Sensitive evidence may remain off-chain/off-platform. Cryptographic
  commitments, aggregate evidence, and attestations prove integrity
  without publishing raw personal data (architecture-lock §6; core
  invariant 6: raw personal activity data is not placed on the public
  ledger).
- PostgreSQL remains the authoritative application state
  (architecture-lock §3). Evidence, outcome claims, attestations, and
  Proof-of-Value objects persist through the NET-W003 authority
  boundaries with transaction/audit semantics.
- The Proof-of-Value lifecycle is authoritative workflow state:
  lifecycle transitions go through `/workflows` (architecture §17,
  architecture-lock §7) — the same deterministic, idempotent,
  authorized, audited machinery established by NET-W004.

## 3. Scope

### 3.1 Evidence first-class model

Evidence is a first-class durable object with at minimum:

- stable identifier
- organization/participant scope
- subject reference (what the evidence supports)
- provenance: source type, source id, method, collection timestamp,
  collector
- confidence with uncertainty (point estimate and optional interval)
- evidence grade (deterministic — see §3.2)
- integrity metadata: optional cryptographic commitment
- sensitivity classification: standard (inline non-sensitive facts) or
  sensitive (commitment + reference only — the raw material NEVER
  enters the authoritative record)
- execution/correlation/causation lineage

### 3.2 Evidence grades — deterministic

Evidence grades are derived deterministically from provenance by an
explicit rule table (never from model judgment):

| source type        | grade              | rank |
|--------------------|--------------------|------|
| `platform`         | `MEASURED`         | 1 (best) |
| `attested`         | `ATTESTED`         | 2 |
| `provider`         | `PROVIDER_REPORTED`| 3 |
| `model`            | `MODEL_ASSESSED`   | 4 |
| `self`             | `SELF_REPORTED`    | 5 |

Model-assessed evidence (AI/agent output) is explicitly supported as
INPUT evidence but is never authoritative (architecture-lock §4): a
Proof-of-Value cannot reach `VERIFIED` on model-assessed or
self-reported evidence alone.

### 3.3 Confidence and uncertainty (EVID-005)

A confidence estimate carries a point in [0, 1] and an optional
interval `[lower, upper]` with `lower <= point <= upper`. Unsupported
exact claims are not manufactured: where an interval is meaningful it
is preserved end-to-end (record → aggregation → Proof-of-Value).

### 3.4 Outcome claims (OUT-001, provider-neutral)

An outcome claim is a provider-neutral, auditable claim about a
measured outcome supporting the protocol's standard outcome vocabulary
(view, attention, engagement, intent, install, signup, purchase,
subscription, retention, referral, savings, fulfillment,
helpfulness). A claim carries: claimed value + unit, confidence,
subject reference, evidence references, and lineage.

Claimed value, unit, and outcome type are immutable after creation;
the evidence set is append-only. Measurement semantics, attribution
modes, and incrementality remain NET-W006 (`/outcomes`).

### 3.5 Attestations (verifier-neutral)

An attestation object binds a verifier's statement to a set of
evidence commitments. Signing and verification are delegated to
injected verifier-neutral interfaces (`AttestationSigner` /
`AttestationVerifier` structural interfaces); the domain never
performs provider-specific crypto itself. Verification proves
integrity WITHOUT plaintext disclosure (the attestation covers the
commitment digests).

### 3.6 Evidence commitments (EVID-006)

Sensitive evidence material is committed cryptographically
(SHA-256/SHA-512 digest, optional salt). The durable record stores the
commitment (and an optional payload reference); the raw material stays
off-record. Integrity verification recomputes the digest when the
plaintext is presented; non-matching plaintext fails verification.

### 3.7 Evidence aggregation (EVID-004)

Evidence from multiple independent sources is aggregated by a
deterministic, pure function: grade-weighted combination of confidence
point estimates (weights: MEASURED 1.0, ATTESTED 0.8,
PROVIDER_REPORTED 0.6, MODEL_ASSESSED 0.3, SELF_REPORTED 0.2), a
conservative uncertainty envelope over the contributing intervals,
and an independence count over distinct sources. Aggregation consumes
durable evidence records only — it never touches (or exposes) raw
sensitive payloads.

### 3.8 Proof-of-Value lifecycle

A Proof-of-Value is an evidence-backed claim object (the settlement
claim precursor of architecture §4) referencing a subject
(contribution/opportunity), outcome claims, an evidence set, an
aggregation result, and attestations.

Lifecycle (reuses the canonical state vocabulary; transitions owned by
`/workflows`):

```text
DRAFT → MEASURING → EVALUATING → VERIFIED
```

Exceptional states:

```text
REJECTED   (from MEASURING or EVALUATING — deterministic rules failed)
CANCELLED  (from DRAFT, MEASURING, or EVALUATING)
```

`VERIFIED`, `REJECTED`, and `CANCELLED` are terminal. Domain
preconditions (validated by the evidence domain service; the workflow
remains the sole lifecycle mutator):

- `MEASURING → EVALUATING` requires at least one attached evidence
  record.
- `EVALUATING → VERIFIED` requires a recorded aggregation, at least
  one MEASURED or ATTESTED evidence record (never model-assessed or
  self-reported alone), and at least one attached attestation that
  verifies CRYPTOGRAPHICALLY against the current stored commitment
  digests (the injected verifier-neutral AttestationVerifier must
  return `valid: true` for at least one attached attestation — the
  mere existence of an attestation record is not sufficient;
  architect review on PR #10).

No economic value is created by this lifecycle (see §5).

## 4. Required invariants

1. Raw sensitive evidence material never enters the authoritative
   record (architecture-lock §6): sensitive records store commitments,
   references, and approved derived facts only.
2. Evidence grades are deterministic functions of provenance
   (explicit rule table; no model judgment).
3. Confidence/uncertainty is preserved, never manufactured: exact
   claims without support are rejected.
4. Evidence, outcome claims, attestations, and Proof-of-Value objects
   persist through PostgreSQL-backed authority boundaries (NET-W003)
   with execution/correlation/causation lineage and append-oriented
   audit records committed atomically with the mutation
   (AUD-002 evidence lineage).
5. Only `/workflows` may authoritatively transition Proof-of-Value
   lifecycle state (architecture-lock §7); the evidence domain service
   validates preconditions but never bypasses workflow authority.
6. Every Proof-of-Value transition is tenant/participant scoped,
   server-authorized, deterministic, idempotent (same idempotency key
   = deterministic replay), and version-checked (optimistic
   concurrency).
7. Agent/model output is admissible only as MODEL_ASSESSED input
   evidence and can never alone support a verified Proof-of-Value
   (architecture-lock §4).
8. Attestation signing/verification is verifier-neutral (injected
   structural interfaces); no provider-specific crypto crosses the
   domain boundary. Production attestation signing FAILS CLOSED at
   the composition root: a configured production/staging deployment
   requires the ATTESTATION_SIGNING_KEY secret (resolved through the
   SecretProvider) or an explicitly configured signer/verifier
   adapter pair — never the well-known development key (architect
   review on PR #10).
9. Outcome claims are provider-neutral: no campaign-, platform-, or
   provider-specific semantics; unknown outcome types are rejected
   with a stable error code.

## 5. Explicit non-goals

Do not implement:

- reputation scoring (NET-W007)
- Participation Credits, pending/mature value, or any economic
  settlement (NET-W008)
- advertising campaigns (NET-W011)
- creator marketplace behavior
- helpfulness scoring (NET-W012)
- demand/procurement/benefit pools
- fraud scoring or challenge economics (NET-W009..010)
- blockchain consensus or decentralized validation
- model-specific AI truth authority
- outcome measurement semantics, attribution modes, or incrementality
  testing (NET-W006 `/outcomes` — that boundary remains skeletal)

## 6. Required acceptance criteria

### NET-W005-AC-01 — Evidence first-class model

Evidence can be created, retrieved, and listed by subject through
authorized application operations; has stable IDs, provenance,
confidence, grade, and integrity metadata; is tenant-scoped; persists
durably through PostgreSQL; and sensitive material NEVER enters the
durable record (commitment + reference only).

**Required evidence:** domain + persistence integration tests,
including a raw-payload absence assertion over the authoritative
record.

### NET-W005-AC-02 — Deterministic provenance/grade/confidence

The provenance/grade/confidence model is explicit and deterministic:
every source type maps to exactly one grade via the explicit rule
table; identical inputs produce identical grades; confidence
invariants (range, interval ordering) are enforced with stable error
codes.

**Required evidence:** exhaustive rule-table tests + validation tests.

### NET-W005-AC-03 — Provider-neutral, auditable outcome claims

Outcome claims support the full standard outcome vocabulary, reject
unknown types with a stable error code, carry evidence references +
lineage, and emit append-oriented audit records. Claimed value/unit/
type are immutable; the evidence set is append-only.

**Required evidence:** domain tests over the full vocabulary +
audit lineage tests.

### NET-W005-AC-04 — Evidence aggregation without exposure

Multiple independent evidence sources can be aggregated
deterministically (grade-weighted confidence + conservative interval
envelope + independence count) without exposing raw sensitive
records.

**Required evidence:** aggregation unit tests (determinism, weights,
independence, no-raw-payload) + Proof-of-Value aggregation test.

### NET-W005-AC-05 — Commitments and attestations prove integrity

Evidence commitments verify integrity when plaintext is presented
(and fail on tampered plaintext/digest); attestations verify over
commitment digests WITHOUT plaintext disclosure; tampered
attestations fail verification.

**Required evidence:** commitment/attestation roundtrip tests +
tampering tests.

### NET-W005-AC-06 — Deterministic, idempotent, authorized,
auditable Proof-of-Value lifecycle

The Proof-of-Value lifecycle transition matrix is exhaustive (legal
transitions enumerated; every unspecified transition rejected with a
stable error code); transitions are authorized and tenant-scoped;
terminal states admit no further transitions; VERIFIED requires
high-grade evidence + attestation (never model/self-assessed alone);
every transition emits audit lineage carrying the authoritative
transaction id.

**Required evidence:** exhaustive matrix tests + authorization +
audit lineage tests.

### NET-W005-AC-07 — Failure/replay/concurrency atomicity

Failure, replay, and concurrency tests prove authoritative atomicity
and lineage: deterministic replay on repeated idempotency keys;
stale-writer rejection; audit failure during evidence creation rolls
the creation back; a failed authoritative commit leaves NO lifecycle
mutation, NO idempotency record, and NO published audit record.

**Required evidence:** fault-injection + concurrency integration
tests over the NET-W003 persistence/idempotency boundaries.

### NET-W005-AC-08 — Architecture and out-of-scope regression

The architecture checker passes, frozen architecture files remain
unchanged, `/outcomes` remains skeletal (NET-W006), and no downstream
economic/reputation/settlement behavior is introduced.

**Required evidence:** static architecture check + regression tests.

## 7. Suggested API/application operations

Provider-neutral operations may include:

```text
createEvidence / getEvidence / verifyEvidenceCommitment
createOutcomeClaim / getOutcomeClaim
createAttestation / verifyAttestation
createProofOfValue / getProofOfValue
attachEvidenceToProof / aggregateProofEvidence / attachAttestationToProof
requestTransition (existing workflow endpoint, subjectKind "proof_of_value")
```

Exact transport shape is implementation-defined, but domain semantics
must remain independent of HTTP or any external platform.

## 8. Required evidence package

The implementation PR must contain:

- `docs/net-w005-evidence.md`
- tests mapped 1:1 to AC-01..08
- Proof-of-Value transition matrix artifact (`docs/net-w005-pov-transition-matrix.md`)
- deterministic grade-rule table artifact
- reproducible `bun run verify` output

## 9. Definition of done

NET-W005 is complete only when:

1. EVID-001..006 and OUT-001 (vocabulary) are implemented.
2. Every material claim (outcome claim / Proof-of-Value) references
   persisted evidence with traceable lineage (AUD-002).
3. Confidence/uncertainty is preserved through record → aggregation →
   Proof-of-Value.
4. Multiple evidence sources can be combined without exposing raw
   sensitive records.
5. Sensitive evidence can be committed (and attestations verified)
   without plaintext disclosure.
6. The Proof-of-Value lifecycle is deterministic, idempotent,
   authorized, and auditable through `/workflows`.
7. Architecture/out-of-scope regression passes with frozen specs
   unchanged.
8. One implementation PR is bound to frozen Architecture v1.0 and
   this work item.
