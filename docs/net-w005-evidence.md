# NET-W005 — Evidence

**Work item:** NET-W005 — Evidence and Proof-of-Value foundation
**Work order:** spec/work-orders/NET-W005.md
**Architecture:** v1.0 (FROZEN)
**Requirements:** EVID-001..006, OUT-001, AUD-002
**Acceptance Criteria:** NET-W005-AC-01..08
**Dependencies:** NET-W004 (merged ec23dbf), NET-W003 (merged), NET-W002 (merged)
**Branch:** feat/net-w005-evidence-proof-of-value
**Tracking issue:** https://github.com/pectoraux/opencon/issues/9

## 1. Verification commands

| command                              | purpose                                                    | result                                |
|--------------------------------------|------------------------------------------------------------|---------------------------------------|
| `bun run typecheck`                  | TypeScript strict-mode typecheck                           | PASS                                  |
| `bun run arch:check`                 | Architecture import-scanner (tier allow matrix)           | PASS — 0 violations                   |
| `bun test`                           | Run all unit/integration tests (skips real PG/Redis)       | PASS — see final counts below         |
| `bun run verify`                     | typecheck + arch:check + tests                             | exit 0                                |

(The NET-W001..004 regression suites continue to pass alongside the new
NET-W005 suites.)

## 2. Design summary

### 2.1 Evidence model (§3.1)

Evidence is a first-class durable object: stable id, organization
scope, subject reference, provenance (source type, source id, method,
collection timestamp, collector), confidence with uncertainty, a
deterministic grade, integrity metadata (optional cryptographic
commitment), a sensitivity classification, and execution/correlation/
causation lineage. Evidence records are IMMUTABLE after creation —
corrections are new records (append-only semantics).

### 2.2 Privacy boundary (work order §4 invariant 1)

- `sensitivity: "standard"` — inline non-sensitive facts allowed.
- `sensitivity: "sensitive"` — the raw material NEVER enters the
  authoritative record. The caller presents `sensitivePayload` (the
  service computes the SHA-256 commitment and DISCARDS the plaintext)
  or a pre-computed commitment. The durable record stores the
  commitment + optional payload reference + approved derived facts
  (grade, confidence, source metadata) only. An inline payload on
  sensitive evidence is structurally REJECTED.

### 2.3 Deterministic grades (§3.2, EVID-003)

The explicit rule table (`src/evidence/grade-rules.ts`):

| source type | grade              | rank | aggregation weight |
|-------------|--------------------|------|--------------------|
| `platform`  | `MEASURED`         | 1    | 1.0                |
| `attested`  | `ATTESTED`         | 2    | 0.8                |
| `provider`  | `PROVIDER_REPORTED`| 3    | 0.6                |
| `model`     | `MODEL_ASSESSED`   | 4    | 0.3                |
| `self`      | `SELF_REPORTED`    | 5    | 0.2                |

The source type is the SOLE input — no model judgment, no
configuration. MODEL_ASSESSED evidence (AI/agent output) is admissible
as INPUT evidence but never authoritative (architecture-lock §4): a
Proof-of-Value can never reach `VERIFIED` on model-assessed or
self-reported evidence alone.

### 2.4 Confidence and uncertainty (§3.3, EVID-005)

`ConfidenceEstimate { point ∈ [0,1], lower?, upper?, method? }` with
`lower ≤ point ≤ upper` validated at every entry point
(`validateConfidenceEstimate`, stable code
`INVALID_CONFIDENCE_ESTIMATE`). Uncertainty is preserved end-to-end:
record → aggregation (conservative envelope) → Proof-of-Value.

### 2.5 Outcome claims (§3.4, OUT-001)

Provider-neutral claims over the full standard outcome vocabulary (13
types: view, attention, engagement, intent, install, signup, purchase,
subscription, retention, referral, savings, fulfillment,
helpfulness). Unknown types are rejected with
`UNSUPPORTED_OUTCOME_TYPE`. Claimed value/unit/type are immutable; the
evidence set is append-only (version increments on attach; stale
writers rejected with `CONFLICT`-classified errors). Measurement
semantics/attribution stay in NET-W006 (`/outcomes` remains skeletal).

### 2.6 Commitments (§3.6, EVID-006)

SHA-256/SHA-512 digests with optional salt
(`src/evidence/commitments.ts`). Verification recomputes the digest
when plaintext is presented (constant-time compare); tampered
plaintext or tampered digests fail. The durable record stores only the
commitment.

### 2.7 Attestations (§3.5)

An attestation binds a verifier's statement to a set of evidence
COMMITMENT DIGESTS via a canonical input
(`buildAttestationDigestInput`: statement + verifier + sorted
evidenceId:digest pairs). Signing/verification are delegated to the
verifier-neutral `AttestationSigner`/`AttestationVerifier` structural
interfaces; the wired default is the clearly-marked HMAC-SHA256
dev/test implementation (`hmac-attestation-verifier.ts`, key from
`ATTESTATION_SIGNING_KEY`; production verifiers arrive as adapters).
Verification rebuilds the canonical input from the STORED commitments —
NO plaintext disclosure anywhere on the verification path. Tampering
with the statement, the covered set, or the underlying commitments
invalidates the rebuilt input.

### 2.8 Aggregation (§3.7, EVID-004)

Pure deterministic function (`src/evidence/aggregation.ts`):
grade-weighted mean of point estimates; conservative interval envelope
(min of contributing lowers/points, max of uppers/points — null when no
record quantifies uncertainty); independence = distinct source keys
(`sourceId ?? unknown:<sourceType>` — same-source records are NOT
independent); dominant grade by total weight (ties → better rank).
Consumes durable records only — the result contains no payload fields
by construction.

### 2.9 Proof-of-Value lifecycle (§3.8)

The PoV (an evidence-backed claim object — the settlement-claim
precursor of architecture §4) references a subject, outcome claims, an
evidence set, a recorded aggregation, and attestations. Its lifecycle
(`DRAFT → MEASURING → EVALUATING → VERIFIED` with `REJECTED`/
`CANCELLED`) is owned by `/workflows` via
`PROOF_OF_VALUE_TRANSITION_TABLE` — the SAME machinery as
opportunities/contributions (authorization, idempotency, optimistic
concurrency, atomic audit). The evidence domain service validates
preconditions and REQUESTS transitions (never mutates state). Full
matrix: `docs/net-w005-pov-transition-matrix.md`.

### 2.10 Atomicity

Every evidence-layer mutation (create evidence/claim/attestation/PoV,
attach, aggregate) runs in ONE authoritative transaction with its audit
record appended through the transactional audit buffer
(`forTransaction(tx)`) — the audit publishes strictly after the durable
commit and is retained for `retryPendingPublications()` on publication
failure (the NET-W004-AC-07 transaction-ordering contract, now applied
across the evidence layer).

## 3. Acceptance criteria → changed files → test mapping

### AC-01 — Evidence first-class model

**Changed files:** `src/core/evidence.ts` (NEW — shared vocabulary),
`src/evidence/port.ts` (MODIFIED — Evidence entity, repositories,
service), `src/evidence/authority-evidence-repository.ts` (NEW),
`src/evidence/evidence-service.ts` (NEW), `src/evidence/module.ts`
(MODIFIED — readiness "ready"), `src/evidence/index.ts` (MODIFIED).

**Test evidence:** `tests/evidence/net-w005-ac-01-evidence-model.test.ts` (9 tests):
- created with stable id + full provenance/confidence/grade + lineage; durable (re-read + authority record);
- immutable after creation (no update path on the port);
- SENSITIVE evidence: raw material NEVER in the authoritative record (serialized-record absence assertion + commitment/reference only);
- inline payload on sensitive evidence REJECTED (structural privacy boundary);
- sensitive evidence without a commitment source REJECTED;
- listed by subject (tenant-scoped);
- NotFoundError on unknown id;
- creation audited (evidence.created; grade + digest metadata; no raw payload in the audit record);
- API create + read (sensitive view exposes commitment only; response never contains the raw material).

### AC-02 — Deterministic provenance/grade/confidence

**Changed files:** `src/core/evidence.ts` (NEW — grades, source types,
ranks, confidence validation), `src/evidence/grade-rules.ts` (NEW — the
rule table + weights + high-support predicate).

**Test evidence:** `tests/evidence/net-w005-ac-02-grade-confidence.test.ts` (7 tests):
- the rule table is exhaustive (every source type → exactly one grade; the exact §3.2 mapping);
- gradeForProvenance deterministic (identical input → identical grade);
- ranks strictly ordered; aggregation weights follow the order;
- MODEL_ASSESSED admissible as input but NEVER high-support (lock §4);
- confidence accepted (points, intervals, frozen normalization);
- out-of-range points rejected with `INVALID_CONFIDENCE_ESTIMATE`;
- non-bracketing intervals rejected (EVID-005).

### AC-03 — Provider-neutral, auditable outcome claims

**Changed files:** `src/evidence/port.ts` (OutcomeClaim entity),
`src/evidence/authority-outcome-claim-repository.ts` (NEW),
`src/evidence/outcome-claim-service.ts` (NEW).

**Test evidence:** `tests/evidence/net-w005-ac-03-outcome-claims.test.ts` (9 tests):
- the vocabulary covers every OUT-001 type (13);
- EVERY type is creatable (exhaustive loop, durable);
- unknown type rejected with `UNSUPPORTED_OUTCOME_TYPE`;
- claims reference evidence + carry lineage (EVID-001);
- unknown evidence reference rejected;
- attach appends (set append-only; value/unit/type immutable; idempotent re-attach);
- stale writer rejected (optimistic concurrency);
- creation + attachment audited atomically (AUD-002; confidence preserved in lineage);
- entity shape is exactly the provider-neutral vocabulary.

### AC-04 — Aggregation without exposure

**Changed files:** `src/evidence/aggregation.ts` (NEW — pure function),
`src/evidence/proof-of-value-service.ts` (aggregateEvidence).

**Test evidence:** `tests/evidence/net-w005-ac-04-aggregation.test.ts` (11 tests):
- empty input is a deterministic validation error;
- weighted mean exactness (hand-computed values);
- weights matter (grade-dominant pull, hand-computed);
- independence counts DISTINCT sources (same-source ≠ independent);
- conservative interval envelope; null when no interval quantified;
- deterministic (same input → identical output);
- aggregate result contains NO raw payload fields (exact key surface);
- hasHighSupportEvidence semantics;
- PoV integration: aggregation recorded + audited (no raw payloads; exact weighted values) and only legal in EVALUATING;
- empty PoV cannot complete evidence gathering.

### AC-05 — Commitments and attestations prove integrity

**Changed files:** `src/evidence/commitments.ts` (NEW),
`src/evidence/attestation-service.ts` (NEW — canonical input builder),
`src/evidence/authority-attestation-repository.ts` (NEW),
`src/evidence/hmac-attestation-verifier.ts` (NEW — dev/test default
behind the verifier-neutral interfaces), `src/config/schema.ts`
(MODIFIED — ATTESTATION_SIGNING_KEY, classified secret).

**Test evidence:** `tests/evidence/net-w005-ac-05-commitments-attestations.test.ts` (12 tests):
- commitment roundtrip sha256 + sha512 (deterministic, verify);
- tampered plaintext fails; tampered digest fails (length-safe);
- salted commitments participate correctly;
- unsupported algorithms / malformed digests rejected with stable codes;
- service-level verification against the STORED commitment (valid + tampered);
- verification fails closed without a commitment;
- attestation verifies over digests with NO plaintext disclosure anywhere;
- tampered statement invalidates; tampered underlying commitment invalidates;
- attestation validation (empty coverage, unknown evidence, cross-org evidence rejected);
- creation audited;
- canonical input deterministic + order-insensitive;
- API verification endpoint (public, no plaintext).

### AC-06 — Deterministic, idempotent, authorized, auditable PoV lifecycle

**Changed files:** `src/core/workflow.ts` (MODIFIED — subject kind +
policyActionFor/auditEventFor moved to core),
`src/workflows/transition-table.ts` (MODIFIED —
PROOF_OF_VALUE_TRANSITION_TABLE), `src/workflows/port.ts` (MODIFIED —
proofOfValueRepository dep), `src/workflows/workflow-service.ts`
(MODIFIED — routing),
`src/evidence/authority-proof-of-value-repository.ts` (NEW),
`src/evidence/proof-of-value-service.ts` (NEW),
`src/bootstrap/runtime.ts` (MODIFIED — wiring + SubjectLookup adapter).

**Test evidence:** `tests/evidence/net-w005-ac-06-pov-lifecycle.test.ts` (11 tests):
- the table enumerates EXACTLY the 8 legal transitions (§3.8);
- exhaustive matrix: every legal pair legal + every other pair rejected (ILLEGAL_TRANSITION / TERMINAL_STATE); terminal states have no outgoing; DRAFT's targets exact; opportunity/contribution tables unaffected;
- DRAFT→REJECTED intentionally illegal;
- full happy path DRAFT→MEASURING→EVALUATING→aggregate→attest→VERIFIED (with authoritative transactionId lineage);
- VERIFIED BLOCKED on model/self evidence alone (lock §4) → PoV REJECTED instead;
- VERIFIED requires aggregation first;
- VERIFIED requires ≥1 attached attestation;
- MEASURING→EVALUATING requires ≥1 evidence;
- evidence set freezes at EVALUATING;
- the PoV service never mutates lifecycle state (port + runtime);
- cross-org transition denied (tenant scoping);
- transition audit carries the AUTHORITATIVE transactionId (not the execution id).

### AC-07 — Failure/replay/concurrency atomicity

**Changed files:** same as AC-01/AC-06 (the atomicity machinery is the
same transactional audit writer + idempotency store).

**Test evidence:** `tests/evidence/net-w005-ac-07-atomicity-concurrency.test.ts` (6 tests):
- same idempotency key → deterministic replay (executed=false, single mutation, single audit);
- stale expectedVersion → `CONCURRENT_TRANSITION`;
- concurrent same-key transitions → exactly one mutation;
- audit PUBLICATION failure after a committed creation → the record stands, the event is RETAINED, retryPendingPublications() publishes it (explicit recovery; never loses lineage, never rolls back the commit);
- failed AUTHORITATIVE COMMIT on a PoV transition → no mutation, no idempotency record, no audit, retry executes;
- failed commit on a PoV CREATE → nothing committed (exactly one record after the healthy retry).

### AC-08 — Architecture and out-of-scope regression

**Changed files:** `tests/regression/ac-08-no-premature-domain-logic.test.ts`
(MODIFIED — evidence joins the non-skeleton set; the bare
/ProofOfValue/i pattern is removed with rationale — the workflows
domain legitimately references the proof_of_value lifecycle subject for
routing; PoV CREATION remains evidence-only via the createProofOfValue
pattern), `tests/regression/net-w004-ac-08-architecture-out-of-scope.test.ts`
(MODIFIED — evidence leaves the deferred set),
`tests/regression/net-w005-ac-08-architecture-out-of-scope.test.ts` (NEW).

**Test evidence:** `tests/regression/net-w005-ac-08-architecture-out-of-scope.test.ts` (13 tests):
- architecture check passes (0 violations);
- frozen specs unchanged + still declare the evidence authority rules;
- NET-W005 work order exists + binds to frozen Architecture v1.0;
- evidence domain non-skeletal (references NET-W005);
- /outcomes REMAINS skeletal (NET-W006 — only module.ts/port.ts/index.ts);
- no forbidden economic-material patterns (credits/settlement/reputation/campaigns/cash);
- evidence imports ONLY core + self;
- no provider drivers;
- no secrets committed;
- the PoV transition matrix artifact + this document exist;
- the shared evidence vocabulary lives in core (barrel-exported);
- the workflows boundary owns the PoV transition table (evidence declares none);
- this document maps every acceptance criterion.

## 4. API surface (work order §7)

Protected mutations (guardMutation, deny-by-default):
`POST /api/evidence`, `POST /api/outcome-claims`,
`POST /api/outcome-claims/:id/evidence`, `POST /api/attestations`,
`POST /api/proofs-of-value`, `POST /api/proofs-of-value/:id/evidence`,
`POST /api/proofs-of-value/:id/aggregate`,
`POST /api/proofs-of-value/:id/attestations`, and the existing
`POST /api/workflows/transitions` (now accepts subjectKind
`"proof_of_value"`).

Public reads / non-mutating verifications: `GET /api/evidence/:id`,
`GET /api/outcome-claims/:id`, `GET /api/proofs-of-value/:id`,
`POST /api/evidence/:id/commitment:verify`,
`POST /api/attestations/:id/verify`.

## 5. Out of scope confirmation (work order §5)

NET-W005 introduces NO: reputation scoring (NET-W007), Participation
Credits or any economic settlement (NET-W008), advertising campaigns
(NET-W011), creator marketplace behavior, helpfulness scoring
(NET-W012), demand/procurement/benefit pools, fraud scoring or
challenge economics (NET-W009..010), blockchain consensus, model truth
authority, or outcome measurement semantics (NET-W006 — `/outcomes`
remains skeletal). The PoV carries evidence lineage ONLY; the
aggregation weights express evidential strength for CONFIDENCE
combination, never economic value.

## 6. Frozen architecture confirmation

- `spec/architecture.md` and `spec/architecture-lock.md` are UNCHANGED.
- The implementation binds to lock §4 (evidence authority; model output
  never authoritative — enforced by the VERIFIED high-support
  precondition), §6 (privacy authority — commitment/reference-only
  sensitive records, verified by absence assertions), §7 (workflow
  authority — PoV transitions route through /workflows), §12 (data
  authority — durable PostgreSQL records, off-record raw material).
- `src/core/workflow.ts` was extended ADDITIVELY (subject kind +
  policyActionFor/auditEventFor pure string builders moved to core so
  the evidence domain derives identical actions without a domain→domain
  import); the frozen spec files themselves are unchanged.

## 7. NET-W001..004 regression confirmation

All prior suites pass unchanged alongside the new NET-W005 suites
(NET-W001 52, NET-W002 60, NET-W003 58 + 15 skipped integration,
NET-W004 88). The two updated regression tests preserve their
guarantees: the forbidden economic patterns still apply to ALL 16
domains; PoV creation remains evidence-domain-only.

## 8. CI

The existing `.github/workflows/ci.yml` continues to gate every
push/PR (verify + integration with real PostgreSQL/Redis service
containers). No CI changes are required — the NET-W005 tests use the
file-backed PostgresAuthorityShim and the wired HMAC dev default.

## 9. Definition of done (work order §9)

1. ✅ EVID-001..006 and OUT-001 (vocabulary) implemented.
2. ✅ Every material claim references persisted evidence with traceable lineage (AUD-002).
3. ✅ Confidence/uncertainty preserved record → aggregation → PoV.
4. ✅ Multiple sources aggregate without exposing raw sensitive records.
5. ✅ Sensitive evidence commits + attestations verify without plaintext disclosure.
6. ✅ PoV lifecycle deterministic, idempotent, authorized, auditable through /workflows.
7. ✅ Architecture/out-of-scope regression passes with frozen specs unchanged.
8. ⏳ One implementation PR bound to frozen Architecture v1.0 and this work item (this PR; awaiting architect review).
