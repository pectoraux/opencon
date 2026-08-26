# Work Order NET-W007 — Reputation engine

**Architecture:** v1.0 (FROZEN) — binds to `spec/architecture.md` + `spec/architecture-lock.md`; changes neither.
**Issue:** #13 (READY_FOR_IMPLEMENTATION)
**Requirements:** REP-001..004, AUD-004
**Acceptance criteria:** NET-W007-AC-01..08
**Dependencies:** NET-W002 (merged), NET-W003 (merged), NET-W005 (merged, PR #10 → 2d2cc6f), NET-W006 (merged, PR #12 → 63f24e3)

## 1. Objective

Implement the provider-neutral, multidimensional reputation foundation.
Reputation is a **derived trust signal**, never an economic authority:
multidimensional dimensions with independent scores and provenance,
evidence-backed contributions, deterministic + versioned scoring,
deterministic time decay, and append-only auditable snapshots/history.

Consumes the merged Evidence/Proof-of-Value layer (NET-W005) and the
Outcomes/Measurement layer (NET-W006) through **provider-neutral
structural lookups** wired by the composition root.

```text
Evidence / Measurement / Verified Contribution
                  ↓
          Reputation Inputs
                  ↓
       Deterministic Scoring Policy
                  ↓
        Time-Decay / Snapshot Engine
                  ↓
       Multidimensional Reputation
```

## 2. The key rule

**Reputation ≠ purchasable, and reputation ≠ economic ledger.**

- Advertising spend, deposits, wealth, Participation Credits and raw
  activity volume can NEVER directly increase reputation. The input
  contract has no field for any of them, and every input MUST reference
  at least one upstream record (evidence, Proof-of-Value, measured
  outcome, verified contribution) — a bare activity assertion cannot
  enter the system.
- Inputs backed ONLY by model-assessed/self-reported evidence are
  `indicated` basis: they contribute at a reduced weight and can never
  lift a dimension above a policy `indicatedOnlyCap` — AI/model output
  remains non-authoritative (architecture-lock §4).
- The reputation domain issues no credits, settles no cash, prices no
  advertising, allocates no benefits, and mutates no other domain.
- Reputation cannot be spent: it has no economic units, and the
  settlement/ledger domains remain skeletal (AC-08 asserts).

## 3. Scope

### 3.1 Core reputation vocabulary (`src/core/reputation.ts`)

- `REPUTATION_DIMENSIONS` — the frozen eight dimensions (architecture
  §11; REP-001): `helpfulness`, `content_quality`, `creator_performance`,
  `inventory_quality`, `measurement_reliability`, `commerce_reliability`,
  `fraud_resistance`, `fulfillment_reliability` + type guard.
- `REPUTATION_INPUT_SOURCES` — `evidence` | `proof_of_value` |
  `measured_outcome` | `contribution` + type guard.
- `REPUTATION_INPUT_BASES` — `verified` | `indicated` + type guard.
- `VERIFIED_GRADE_EVIDENCE_SOURCE_TYPES` — `platform` | `attested` |
  `provider` (evidence source types that yield a verified basis; `model`
  and `self` yield `indicated`).
- `ReputationScoringRule` — per-dimension deterministic parameters:
  `inputWeight > 0`, `decayHalfLifeDays > 0`, `maxScore > 0`,
  `indicatedWeightFactor ∈ [0,1]`, `indicatedOnlyCap ∈ [0, maxScore)`
  + `validateReputationScoringRule` (stable error code
  `REPUTATION_POLICY_VALIDATION`).

### 3.2 Reputation inputs (`/reputation`)

- A `ReputationInput` is immutable + append-only: subject person,
  organization scope, dimension, `≥1` upstream source references
  (`{ kind, id }`), `occurredAt` (decay anchor), idempotency key,
  execution lineage.
- The service RESOLVES every source through injected neutral lookups
  (existence + same organization scope enforced) and DETERMINES the
  `basis` — never caller-asserted:
  - `contribution`/`proof_of_value`/`measured_outcome` → `verified`
    iff state `VERIFIED`;
  - `evidence` → `verified` iff `sourceType ∈ {platform, attested,
    provider}`.
  - Basis is `verified` iff ANY source resolves verified-grade.
- Recording is authorized (API guard), idempotent (idempotency key),
  PostgreSQL-authoritative, and commits atomically with its audit
  record (`reputation_input.recorded`).

### 3.3 Versioned deterministic scoring policies

- A `ReputationScoringPolicy` is an immutable, versioned record:
  stable `policyId`, monotonically increasing `version` (exactly
  latest+1; version 1 starts a new lineage), one `ReputationScoringRule`
  per dimension (ALL eight required, exactly once), description,
  creator, lineage. New version = new record; existing versions are
  never rewritten (reproducibility).
- All versions of a lineage share one organization scope; a lineage
  cannot be forked across scopes — enforced for EVERY version create,
  including version 1 (the org-INDEPENDENT lineage read runs inside
  the create transaction).
- Lineage serialization under concurrency (PR #14 remediation): the
  mutation idempotency key is org-scoped
  (`reputation_policy:{organizationScopeId}:{policyId}:{version}`), so
  it cannot serialize concurrent creates of the same `policyId` from
  DIFFERENT organizations. The whole create — lineage read → scope
  check → version check → create → commit — therefore runs under an
  ORGANIZATION-INDEPENDENT mutex `reputation_policy_lineage:{policyId}`
  on the idempotency store (`IdempotencyStore.withLock`, the store's
  per-key mutex — its documented stand-in for PostgreSQL
  `SELECT … FOR UPDATE` row locking; OpenCon is a single-process
  modular monolith, and all policy mutations flow through the one
  runtime-wired store instance). A queued cross-scope caller observes
  the first caller's COMMITTED lineage and receives the cross-scope
  lineage error.
- Snapshot computation references `policyId + version` explicitly, so a
  historical snapshot can ALWAYS be recomputed bit-for-bit.

### 3.4 Deterministic scoring + time decay (`src/reputation/scoring.ts`)

- Pure functions, no I/O, no wall clock: the decay reference timestamp
  `referenceAt` is an EXPLICIT input (AC-04 — no wall-clock races).
- Temporal scoping: inputs with `occurredAt > referenceAt` are excluded
  (a snapshot at T is computed from events up to T).
- Per input: `weight = inputWeight × basisFactor × 0.5^(elapsedDays /
  halfLifeDays)`; `basisFactor` = 1 (verified) or
  `indicatedWeightFactor` (indicated).
- Per dimension (independence is mechanical — a dimension is scored
  ONLY from its own inputs):
  - zero verified inputs → `score = min(Σ indicatedWeight,
    indicatedOnlyCap)` (raw activity/model output alone is capped);
  - ≥1 verified input → `score = min(Σ weights, maxScore)`.
- Deterministic rounding to 6 decimals; a canonical SHA-256 digest over
  `(policyId, policyVersion, referenceAt, scores)` makes reproducibility
  assertable (AC-02).

### 3.5 Snapshots + history

- A `ReputationSnapshot` is immutable + append-only: subject person,
  organization scope, `policyId + policyVersion`, `referenceAt`,
  computed `scores` (one per dimension, always all eight), the exact
  `inputIds` included (reconstructability — AUD-004), the deterministic
  `digest`, idempotency key, lineage.
- `computeScores` is a read-only preview (same engine, no persistence).
- `recordSnapshot` computes + persists + audits atomically
  (`reputation_snapshot.recorded`); idempotent by key; concurrent-safe.
- History = ordered snapshots for a subject; every score change is
  auditable and reconstructable from `inputIds + policyVersion +
  referenceAt`.

### 3.6 API surface (guarded, tenant-scoped)

- `POST /api/reputation/policies` (`reputationPolicy.create`);
  `GET /api/reputation/policies/:id`; `GET /api/reputation/policies/:policyId/versions`.
- `POST /api/reputation/inputs` (`reputationInput.create`);
  `GET /api/reputation/inputs/:id`; `GET /api/reputation/subjects/:personId/inputs`.
- `POST /api/reputation/snapshots` (`reputationSnapshot.create`);
  `GET /api/reputation/snapshots/:id`;
  `GET /api/reputation/subjects/:personId/snapshots` (history);
  `GET /api/reputation/subjects/:personId/snapshots/latest`.
- `GET /api/reputation/subjects/:personId/scores` (deterministic compute
  preview — read-only).
- Mutations deny-by-default via the API guard; reads are public
  non-mutating (same convention as NET-W005/006).

## 4. Required invariants

1. Dimensions are independent: a dimension's score derives ONLY from
   that dimension's inputs (mechanically enforced by the engine).
2. Scoring is deterministic and policy/version aware: identical inputs
   + policy + `referenceAt` → bit-identical scores and digest.
3. Every input references ≥1 upstream evidence/PoV/measured-outcome/
   contribution record resolved through neutral lookups (same org
   scope); basis is DERIVED, never caller-asserted.
4. Time decay is deterministic and reproducible; `referenceAt` is an
   explicit input everywhere (no hidden wall clock).
5. Spend/wealth/deposits/credits/raw-activity can never directly
   increase reputation (no contract field; source gate; indicated-only
   cap). `indicated`-only inputs are capped by `indicatedOnlyCap`.
6. Model/AI output contributes only as `indicated` basis — never
   authoritative (architecture-lock §4).
7. Reputation mutations are authorized, idempotent, concurrent-safe,
   PostgreSQL-authoritative, and audit-linked ATOMICALLY (transactional
   audit buffer bound to the same authority transaction — NET-W004-AC-07
   semantics). A publication failure never fabricates a committed
   change (retryable recovery, mirroring NET-W005/W006). Concurrent
   policy-version creates of the same `policyId` — including from
   DIFFERENT organization scopes — are serialized under the
   organization-independent lineage mutex
   (`reputation_policy_lineage:{policyId}`), and the cross-scope
   lineage check runs against the ORG-INDEPENDENT lineage read on
   EVERY create (including version 1): a lineage can never fork.
8. Reputation is separate from the economic ledger: no credit issuance,
   settlement, pricing, benefit allocation, or campaign delivery
   (AC-08 forbids the patterns); `settlement`/`ledger` stay skeletal.

## 5. Non-goals (out of scope)

No Participation Credits or economic ledger (NET-W008), cash settlement
(NET-W008), ad campaign optimization (NET-W019+), creator marketplace
behavior (NET-W015+), helpfulness workflow/Proof-of-Helpfulness
(NET-W012 — the `helpfulness` DIMENSION exists, the helpfulness
PIPELINE does not), fraud decisions/challenge economics (NET-W009/010),
blockchain consensus, decentralized/portable reputation proofs
(NET-W031), external payment integration (NET-W024+), and no
provider-specific scoring semantics (provider adapters arrive with
their own work items; reputation consumes the neutral contracts only).

## 6. Acceptance criteria → verification mapping

- **AC-01 dimensions first-class/independent/reconstructable** —
  `tests/reputation/net-w007-ac-01-dimensions.test.ts`.
- **AC-02 deterministic, policy/version aware, reproducible** —
  `tests/reputation/net-w007-ac-02-determinism.test.ts`.
- **AC-03 evidence/verified-value provenance retained** —
  `tests/reputation/net-w007-ac-03-provenance.test.ts`.
- **AC-04 deterministic time decay (no wall-clock races)** —
  `tests/reputation/net-w007-ac-04-decay.test.ts`.
- **AC-05 spend/wealth/raw activity cannot buy reputation** —
  `tests/reputation/net-w007-ac-05-non-purchasable.test.ts`.
- **AC-06 authorized, idempotent, concurrent-safe, authoritative,
  audit-atomic mutations** —
  `tests/reputation/net-w007-ac-06-atomicity-concurrency.test.ts`.
- **AC-07 provider/model inputs provider-neutral + non-authoritative** —
  `tests/reputation/net-w007-ac-07-neutrality.test.ts`.
- **AC-08 architecture/out-of-scope regression (Architecture v1.0 +
  architecture-lock unchanged)** —
  `tests/regression/net-w007-ac-08-architecture-out-of-scope.test.ts`
  + baseline updates in `tests/regression/ac-08-no-premature-domain-logic.test.ts`.

Evidence document: `docs/net-w007-reputation.md`.
