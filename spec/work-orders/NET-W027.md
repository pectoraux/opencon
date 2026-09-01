# NET-W027 — Verified savings and counterfactuals

**Status:** READY_FOR_IMPLEMENTATION  
**Architecture:** v1.0 (FROZEN — `spec/architecture.md`, `spec/architecture-lock.md` MUST remain unchanged)  
**Dependencies:** NET-W006, NET-W026 — VERIFIED/MERGED  
**Tracking:** GitHub issue #54  
**Implementation branch:** `feat/net-w027-verified-savings-counterfactuals`

## §1 Objective

Establish evidence-backed procurement baselines, counterfactual representations with explicit assumptions and uncertainty, and deterministic, reproducible realized-savings derivation inside the existing `/demand` procurement boundary — so savings claims can never be manufactured from offer prices, spend, reputation, raw activity or caller arithmetic, and can never be treated as economically authoritative without supported causal evidence (PROC-002).

## §2 Architecture decision of record

```text
W026 supplier selection / procurement outcome context (neutral lineage only)
        ↓
explicit baseline record (kind, method + version, comparison window,
population, value + unit, confidence, provenance, evidence refs)
        ↓
authoritative observed outcomes from /outcomes (neutral lookups)
+ supporting evidence from /evidence (neutral lookups)
        ↓
deterministic, uncertainty-preserving savings derivation
at ONE explicit evaluation anchor (conservative combination)
        ↓
verified savings view / immutable savings lineage record
(fails closed when evidence is invalid, stale or insufficient)
        ↓
/settlement remains the SOLE economic authority (W027 mints nothing)
```

`/demand` remains the single authority for procurement semantics and now carries the savings/counterfactual **decision** surface. `/outcomes` remains the normalized measurement authority — W027 consumes its observations read-only through neutral composition-root lookups and never redefines measurement semantics. `/evidence` remains the provenance/truth authority — baseline provenance must trace to evidence records resolved read-only through neutral lookups. No 17th domain, no second procurement authority (an Architecture Change Request would be required).

## §3 Authority rules

- `/demand` owns the baseline records, the counterfactual representation, the savings derivation policy and the savings lineage records; `/settlement` owns ALL economic state and effects — W027 mints no value, creates no ledger/credit/cash/reward state and settles nothing.
- Savings are claims about REALIZED OUTCOMES, never offers: the W026 offer/selection context enters ONLY as neutral lineage references; no offer price, spend, reputation, raw activity or caller arithmetic can produce or influence a savings claim.
- `/outcomes` is the normalized measurement authority: observed savings facts are `OutcomeObservation` records (outcome type `savings`, the existing OUT-001 vocabulary); W027 fabricates no measurements.
- `/evidence` is the provenance/truth authority: baseline claims require traceable evidence records; evidence sufficiency follows the qualifying source-type rule (platform/attested/provider — model/self alone never qualify, architecture-lock §4).
- Uncertainty is first-class: confidence intervals are preserved and conservatively combined; a `counterfactual` baseline REQUIRES a quantified interval (the NET-W006 CounterfactualBaseline rule — an exact counterfactual claim without quantified uncertainty is manufactured and rejected); unsupported exact claims fail closed.
- Cross-tenant references fail closed without existence oracles (cross-tenant is indistinguishable from nonexistent).
- All savings/baseline surfaces are pool-creator-authorized (server-resolved; the W026 selection-surface precedent — procurement outcome analysis stays with the demand owner).
- AI/model output, if ever introduced, is advisory only and can never establish evidence sufficiency, approve a savings claim, release privacy or authorize economics.
- No W028 Benefit Pool semantics (no allocation, no member benefits).
- `/workflows` remains the lifecycle authority; no local lifecycle machinery — baseline invalidation is a ONE-WAY field mutation; evidence staleness/expiry and observation supersession are DERIVED at the evaluation anchor, never mutated.

## §4 Scope

### §4.1 Baseline record

A first-class, tenant/pool-scoped, durable `ProcurementBaseline` with:

- the explicit baseline KIND (`baseline` | `counterfactual` — the NET-W006 `BaselineKind` vocabulary, reused verbatim);
- an explicit METHOD from a closed vocabulary plus a REQUIRED method version (method identity never collapsed);
- an explicit comparison WINDOW (bounded: 1..365 days, historical — the window ends no later than submission) and a bounded POPULATION description;
- a baseline VALUE + unit with a validated `ConfidenceEstimate` (a `counterfactual` baseline requires a quantified [lower, upper] interval);
- measurement PROVENANCE (sourceType from the closed evidence vocabulary; method + methodVersion + collectedAt required);
- ≥1 traceable EVIDENCE references resolved through the neutral `/evidence` lookup (fail closed on missing/cross-tenant; subject-bound to the procurement pool);
- one-way invalidation (closed reason vocabulary) — an invalidated baseline can never again support savings;
- record-format/version lineage, idempotency/execution lineage fields;
- immutability after creation except the one-way invalidation fields.

### §4.2 Counterfactual representation

The counterfactual is carried by the baseline record's `counterfactual` kind with its explicit assumptions (method + version + population + comparison window), its quantified uncertainty and its invalidation semantics. Caller-asserted counterfactual arithmetic is never trusted.

### §4.3 Realized-outcome linkage

The savings derivation consumes ONLY:

1. one explicit, currently-valid `ProcurementBaseline` of the pool, and
2. ≥1 authoritative `OutcomeObservation` records from `/outcomes` (outcome type `savings`, subject-bound to the pool, chain-head only, qualifying source type, fresh), resolved through the neutral composition-root lookup.

The optional W026 `CompetitiveSelection` reference is validated neutral lineage only (scope + pool match); it is never savings truth.

### §4.4 Deterministic savings derivation

- The derivation is a PURE engine: observed values combine conservatively (sum of chain-head values with unit consistency; confidence = MIN point + conservative interval envelope — the NET-W006 rollup precedent); savings = baseline − observed, server-derived.
- ONE explicit evaluation anchor per derivation; the canonical digest EXCLUDES the anchor (identical authoritative state ⇒ identical digest) and covers every governing fact (policy version/method, baseline identity + kind + value, observation set, checks).
- The derivation emits machine-readable checks (baseline validity/interval/evidence support/freshness; observation presence/support/chain-head/subject/outcome-type/freshness; unit consistency; uncertainty preservation). `supported` is the conjunction — there is NO command that asserts, stores or waives sufficiency.
- The derived view is a 200 DECISION for every outcome; the RECORD command fails closed on unsupported derivations (the derived-vs-authoritative split).

### §4.5 Evidence sufficiency / staleness / fail-closed

- Invalidated baselines, superseded (corrected) observations, non-qualifying-only source types, mixed units, missing evidence, and evidence older than the frozen staleness bound (365 days) all fail closed for the authoritative record.
- The derived evaluation is the CURRENT verdict surface: economically authoritative consumers (NET-W028+) must consume the derived evaluation, never stale snapshots.

### §4.6 Economic boundary

No W027 command may mint value, create credits, cash obligations, rewards, balances, payment instructions, benefit pools or any parallel economic record. A verified savings claim is a MEASUREMENT DECISION, not a settlement transaction; any economic consequence crosses `/settlement` only through an explicitly scoped future work item.

## §5 Material mutation pattern

Follow the established W003/W004/W020/W025/W026 pattern:

`validation → server-resolved actor → tenant/pool reads → pool-creator authorization → composite idempotency → concurrency control → ONE authoritative transaction → WithinTx writes (same-boundary state) + neutral-lookup fact resolution at the anchor → transactional audit buffer → COMMIT → publish audit`

Same-key replays are exactly once. Concurrency must not permit conflicting duplicate durable records or nondeterministic savings state.

## §6 Derived evaluation

Savings sufficiency is derived from CURRENT authoritative records at ONE explicit evaluation anchor. The normal evaluation path never trusts stored or caller-asserted support, values or confidence. Where a material savings decision is persisted, the stored record is the authoritative savings lineage (an immutable snapshot of the derivation facts), while anything purely derivable stays derived and reproducible.

## §7 Acceptance criteria

### AC-01 — First-class baseline records

Baselines are durable, tenant/pool-scoped, pool-creator-authorized, provenance-bearing, versioned and immutable except one-way invalidation; invalid vocabulary, bounds, provenance, confidence or evidence references fail closed.

### AC-02 — Counterfactual representation

Counterfactual baselines preserve assumptions (method + version + population + window), REQUIRE a quantified confidence interval, and carry explicit one-way invalidation semantics that fail closed on every later savings derivation.

### AC-03 — Authoritative derivation only

Realized savings derive only from an explicit valid baseline plus authoritative /outcomes observations (+ /evidence-backed baseline provenance). Offer price, spend, reputation, raw activity or caller arithmetic alone cannot produce a verified savings claim; the server owns the arithmetic.

### AC-04 — Deterministic, anchor-aware derivation

Identical authoritative state + evaluation anchor produce identical derivations and digests; the digest excludes the anchor; any governing-fact change changes the digest; tie/combination rules are explicit and versioned.

### AC-05 — Uncertainty preservation and fail-closed evidence

Intervals and method/version lineage are preserved and conservatively combined; unsupported exact claims, non-qualifying-only sources, superseded observations, stale evidence, invalidated baselines and mixed units fail closed for authoritative savings use.

### AC-06 — Tenancy / authorization

Cross-tenant references and unauthorized actors fail closed without existence leakage (cross-tenant is indistinguishable from nonexistent); every savings/baseline surface is pool-creator-only.

### AC-07 — Idempotency / concurrency / atomicity

Baseline creation/invalidation and savings recording are exactly-once under same-key replay, concurrency-safe under the per-pool lock, and atomically audited in one authoritative transaction (no record without its audit event, no audit without a record).

### AC-08 — Economic-authority containment

No `/demand` W027 code writes economic state or bypasses `/settlement`; no economic vocabulary, ledger, credit, cash or reward surface exists; W028 Benefit Pool semantics remain absent.

### AC-09 — Architecture / out-of-scope regression

Frozen architecture and architecture-lock are unchanged; no second procurement/domain authority; no unauthorized workflow lifecycle machinery; architecture/authority guards remain clean; the shared-file vocabulary amendments are scoped exactly to the sanctioned NET-W027 contracts.

## §8 Required evidence

- `spec/work-orders/NET-W027.md`
- `docs/net-w027-verified-savings-counterfactuals.md`
- shared W027 harness built on the W026 fixtures (pool creator, evidence + observation factories over the real `/evidence` and `/outcomes` services, supported/unsupported savings seeds);
- one-to-one AC suites `tests/demand/net-w027-ac-0N-*.test.ts` (AC-01..08) plus the regression suite `tests/regression/net-w027-ac-09-architecture-out-of-scope.test.ts`;
- targeted mutation checks: counterfactual-interval bypass, qualifying-source bypass, anchor-in-digest, caller-arithmetic/unsupported-record bypass, tenant-scope bypass, idempotency-key randomization, staleness/supersession bypass;
- sanctioned amendment of the NET-W025/W026 ac-08 shared-file `counterfactual` bans (the shared `/demand` port/module now carry the NET-W027 contracts; the W025/W026-owned files keep the full bans);
- `bun run verify` plus configured real PostgreSQL/Redis integration tests;
- evidence ledger updated before PR review.

## §9 Explicit non-goals

No Benefit Pools (W028), no external settlement execution, no decentralized consensus, no new ledger/credit/cash primitives, no replacement of `/outcomes` or `/evidence` authorities, no AI path, no new config/secrets.

## §10 Merge gate

Exactly one canonical implementation PR for W027. Do not merge until implementation evidence, CI, architecture/authority checks, mutation checks and recorded architect approval are all green.
