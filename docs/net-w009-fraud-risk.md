# NET-W009 — Fraud and risk foundation: evidence document

**Work item:** NET-W009 (Issue #17) — Fraud and risk foundation
**Architecture:** v1.0 (FROZEN) — `spec/architecture.md`, `spec/architecture-lock.md`
**Work order:** `spec/work-orders/NET-W009.md`
**Requirements:** FRAUD-001..005 (foundation subset), AI-003, AUD-005
**Boundary:** `/disputes` (the Phase-3 Trust domain — see §2 below)

## 1. Component map

| Component | File | Role |
|---|---|---|
| Core vocabulary | `src/core/risk.ts` | Frozen signal categories, provenance kinds + the structural advisory rule (`model_output` ⇒ always advisory), severities, risk states + normative ordering, operation classes, control actions, deterministic policy-shape validation (fail-closed missing-data ≥ REVIEW, advisory cap ≤ REVIEW, critical floor ≥ REVIEW, monotonic thresholds/points, required ⊆ consumed) |
| Domain port | `src/disputes/port.ts` | Signals, policies, assessments, cases, controls + 5 repositories + 8 neutral lookups (identity/evidence/PoV/measured-outcome/contribution/economic/reputation/risk-records) + services |
| Pure engine | `src/disputes/risk-engine.ts` | `evaluateRisk` (per-signal contributions, scaled-integer score, threshold state, critical floor, advisory-only cap, fail-closed missing categories, SHA-256 digest) + the velocity/duplicate-pattern detectors over authoritative economic records |
| Signal service | `src/disputes/signal-service.ts` | Provenance + ≥1 authoritative-source gate (neutral-lookup resolution, org-scope enforcement), derived advisory flag, append-only supersession corrections |
| Policy service | `src/disputes/policy-service.ts` | The full NET-W007/008 lineage pattern: (policyId, version) tuple idempotency, monotonic versions, org-independent `risk_policy_lineage:{policyId}` mutex, cross-scope fork rejection on EVERY create incl. v1 |
| Assessment service | `src/disputes/assessment-service.ts` | Preview (pure) + record (in-tx transaction-consistent signal set, exact policy version pinning, append-only supersession of the previous latest) |
| Case service | `src/disputes/case-service.ts` | OPEN → UNDER_REVIEW → RESOLVED deterministic state machine over an append-only decision history; reviewer identity from the execution actor; ≥1 supporting reference on material decisions; explicit CLEARED/UPHELD resolution |
| Control service | `src/disputes/control-service.ts` | Evidence-backed activations (assessment and/or case origin, same org, current), audited resolution flips, the `findGatingControl` registry read |
| Source validation | `src/disputes/source-validation.ts` | Shared neutral-lookup resolution: existence + organization scope for every citable source kind |
| Repositories ×5 | `src/disputes/authority-*-repository.ts` | PostgreSQL-authoritative collections: `risk_signals`, `risk_policies`, `risk_assessments`, `risk_cases`, `risk_control_decisions` |
| Composition root | `src/bootstrap/runtime.ts` | 8 lookups + 5 repos + 5 services; the ECONOMIC GATE (`refuseWhenGated` before maturation/issuance/allocation/cash-settlement commands); the WORKFLOW GATE (`applyWorkflowHold`/`clearWorkflowHold` → control + authorized `workflowService.requestTransition`); apiCommands + view helpers |
| API surface | `src/api/port.ts` + `src/api/server.ts` | 10 guarded mutations + preview + 9 public reads under `/api/risk/*` |

## 2. Boundary placement (design decision of record)

The frozen architecture names no dedicated `/fraud` or `/risk` boundary.
The work order §2 documents the placement decision:

1. `spec/architecture-lock.md` §2 freezes the sixteen core domains — a
   seventeenth domain would require an Architecture Change Request
   (lock invariants 2/8).
2. `/workflows` explicitly renounces fraud decisions
   (`src/workflows/module.ts`, `transition-table.ts`: "not a fraud
   decision — NET-W009/010 own fraud").
3. `/settlement` and `/reputation` are excluded by the work item's own
   invariants 1–2.
4. **`/disputes`** is the only Phase-3 Trust boundary; its declared
   authority ("challenges, disputes, appeals and penalties") covers
   holds and preventive penalties; the dependency graph stacks NET-W010
   directly on NET-W009; lock invariant 21 treats "disputed or
   fraud-held" as sibling control states.

NET-W010 will extend the same boundary with staking, challenges and
the dispute lifecycle.

## 3. Invariant → enforcement mapping

| # | Invariant (Issue #17) | Enforcement |
|---|---|---|
| 1 | No hidden economic authority | The disputes port carries no economic-unit fields and no economic mutation methods; AC-08 asserts no `issueCredits`/`matureValue`/`recordPendingValue`/`settleCashObligation`/`allocateRewards` patterns in the domain; the gate can only REFUSE a wrapped command (AC-05 proves the refused maturation leaves the record PENDING) |
| 2 | No direct reputation mutation | Reputation appears ONLY as the read-only `RiskReputationSnapshotLookup`; AC-08 asserts no `recordReputationInput`/`recordSnapshot` patterns; settlement+reputation sources import nothing from disputes |
| 3 | Evidence-backed material decisions | Signals require ≥1 authoritative source ref resolved through neutral lookups with org-scope enforcement (AC-01); case opens + material decisions require ≥1 supporting ref (AC-04); controls REQUIRE an assessment and/or case origin — current, same-org (AC-04); citations may also name risk signals/assessments themselves |
| 4 | Determinism and versioning | The engine is pure; identical signals + policy/version + evaluatedAt ⇒ identical contributions/score/state/digest (AC-03 preview ≡ record; pure-function bit-for-bit test); policies are immutable versions with tuple idempotency (AC-02) |
| 5 | Model non-authority | `model_output` provenance is structurally advisory (derived, never caller-asserted — AC-07); advisory-only sets cap at ≤ REVIEW regardless of volume (4×CRITICAL advisory = hold-threshold score, still REVIEW); the validator structurally rejects `advisoryOnlyCapState > REVIEW`; the composition order makes the fail-closed missing-data floor dominate the cap only when required data is genuinely absent (precedence test) |
| 6 | Tenant isolation | Org-scope enforced on every source resolution, signal listing, policy lineage, assessment policy match, control origin + registry read (AC-01/02/04/05 isolation tests) |
| 7 | Auditability and atomicity | Every mutation runs through `IdempotencyStore.applyIdempotent` with the transactional audit buffer — mutation + idempotency record + audit event commit in ONE authoritative transaction (AC-06: audit events queryable per type and per resource; exactly-one audit event under concurrency; failed validations leave no partial state) |
| 8 | Fail-safe controls | Required categories with no resolvable signals ⇒ the policy's `missingDataState` (validated ≥ REVIEW — a WATCH/CLEAR missing-data state is structurally inexpressible); AC-03 proves the fail-closed HOLD with an unconsumed-category signal present |

## 4. Design decisions of note

1. **The economic gate lives at the composition root.** The runtime
   command implementations for value maturation, credit issuance,
   reward allocation and cash settlement consult
   `findGatingControl` BEFORE invoking the settlement services and
   refuse with a stable `RISK_CONTROL` error (HTTP 412) on ACTIVE
   HOLD/BLOCK. The settlement domain code is untouched (the non-goal
   "No economic ledger implementation changes" holds literally —
   AC-08 asserts settlement sources import nothing from disputes) and
   the fraud boundary never mutates economic state: it can only
   refuse to allow the wrapped operation. This is exactly the work
   item's constraint: "control hooks ... without allowing the fraud
   domain to mutate those downstream authorities directly. Cross-domain
   integration remains provider-neutral and wired at the composition
   root."
2. **The workflow gate routes through the workflow service.**
   `applyWorkflowHold` records the control FIRST (evidence-backed
   origin required), then requests the `FRAUD_REVIEW` transition via
   `workflowService.requestTransition` — the SOLE lifecycle authority
   (architecture §17, lock §7). The clearing path resolves the control
   and requests the `FRAUD_REVIEW → SUBMITTED` return transition. The
   disputes domain itself never imports workflows (AC-08).
3. **Supersession is append-only with an atomic back-pointer flip.**
   Corrections/re-evaluations are NEW records referencing the
   superseded record (`supersedesSignalId`/`supersedesAssessmentId`);
   the original's forward pointer flips in the SAME transaction — a
   state flip, never a content rewrite (AC-07 proves the original's
   content fields stay byte-identical).
4. **The advisory cap and the fail-safe floor are ordered by
   invariant precedence.** The cap applies to the SCORE-DERIVED state
   first; floors (critical, missing-data) raise afterwards. A HOLD
   caused by missing required data is not caused by model output, so
   the cap cannot mask it; conversely no volume of advisory signals
   can alone cross into HOLD/BLOCKED.
5. **Risk signals/assessments are citable sources.** Invariant 3 says
   material decisions reference "the risk signals and/or authoritative
   upstream records"; the source vocabulary therefore includes
   `risk_signal` and `risk_assessment` (resolved through the
   composition-root-wired `RiskRecordLookup`), while signal-level
   provenance sources remain the authoritative upstream kinds.
6. **`REQUIRE_REVIEW` is decision support, not a block.** The gate
   refuses only on HOLD/BLOCK; a REQUIRE_REVIEW control surfaces in
   the registry (and to reviewers) without hard-refusing the
   operation (AC-05).
7. **Velocity/duplicate detectors are pure and authoritative-data
   based.** They never consume raw activity: callers pass
   authoritative economic record views and cite the matched records as
   the signal's provenance sources (the golden path demonstrates the
   full chain: records → detector → signal → assessment → control →
   gate).

## 5. API surface

| Route | Guard action | Notes |
|---|---|---|
| `POST /api/risk/signals` | `riskSignal.create` | Provenance + source-ref gate |
| `POST /api/risk/signals/:id/supersede` | `riskSignal.supersede` | Append-only correction |
| `GET /api/risk/signals[/:id]` | public | Org (+optional subject) listings |
| `POST /api/risk/policies` | `riskPolicy.create` | Lineage mutex + monotonic versions |
| `GET /api/risk/policies/:policyId/versions` | public | Lineage history |
| `POST /api/risk/assessments` | `riskAssessment.create` | Deterministic engine + supersession |
| `POST /api/risk/assessments/preview` | public | Pure preview, no persist |
| `GET /api/risk/assessments[/:id]` | public | Subject history |
| `POST /api/risk/cases` | `riskCase.open` | ≥1 supporting reference |
| `POST /api/risk/cases/:id/decisions` | `riskCase.decide` | Deterministic state machine |
| `GET /api/risk/cases[/:id]` | public | State filter + decision history |
| `POST /api/risk/controls` | `riskControl.activate` | Evidence-backed origin gate |
| `POST /api/risk/controls/:id/resolve` | `riskControl.resolve` | Audited resolution flip |
| `GET /api/risk/controls[/:id]` | public | Registry reads |
| `GET /api/risk/subjects/:personId/summary` | public | Latest assessment + active controls + open cases |
| `POST /api/risk/workflow-holds` | `riskWorkflowHold.apply` | Control + FRAUD_REVIEW via the workflow service |
| `POST /api/risk/workflow-holds/:contributionId/clear` | `riskWorkflowHold.clear` | Resolve + cleared return transition |

The economic gate is NOT a new route: it wraps the existing settlement
mutation commands (`economicValue.mature`, `creditIssuance.create`,
`rewardAllocation.create`, `cashObligation.settle`) at the composition
root.

## 6. AC → tests mapping

| AC | Evidence | Tests |
|---|---|---|
| NET-W009-AC-01 | First-class durable scoped provenance-backed signals | `tests/disputes/net-w009-ac-01-signals.test.ts` (7 tests) |
| NET-W009-AC-02 | Deterministic, versioned, reproducible rules | `tests/disputes/net-w009-ac-02-policies.test.ts` (7) |
| NET-W009-AC-03 | Multi-signal assessments preserve signal-level provenance | `tests/disputes/net-w009-ac-03-assessments.test.ts` (7) |
| NET-W009-AC-04 | Explicit authorized auditable states/cases/holds | `tests/disputes/net-w009-ac-04-cases-controls.test.ts` (7) |
| NET-W009-AC-05 | Tenant-scoped authoritative-data controls + the gates | `tests/disputes/net-w009-ac-05-controls-gates.test.ts` (7) |
| NET-W009-AC-06 | Idempotent, concurrent-safe, authoritative, audit-linked mutations | `tests/disputes/net-w009-ac-06-atomicity-concurrency.test.ts` (7) |
| NET-W009-AC-07 | Model advisory non-authority + append-only correctable history | `tests/disputes/net-w009-ac-07-advisory-history.test.ts` (7) |
| NET-W009-AC-08 | Architecture/out-of-scope regression | `tests/regression/net-w009-ac-08-architecture-out-of-scope.test.ts` (12) |

## 7. Verification summary

- `bun run typecheck`: PASS.
- `bun run arch:check`: PASS — 0 violations across the full scan
  (domain → core + self only; the gates live in the composition root).
- `bun test`: see the PR body for the final counts (baseline after
  NET-W008: 578 pass / 593 tests / 71 files).
- Frozen specs untouched (`spec/architecture.md`,
  `spec/architecture-lock.md` unchanged; AC-08 asserts the frozen
  16-domain list with no `/risk` or `/fraud` domain).

## 8. Out of scope (work order §5 — none introduced)

No economic ledger changes (settlement sources untouched), no
reputation scoring changes, no Proof-of-Value/evidence truth changes,
no staking/bonding, no challenge or dispute lifecycle (NET-W010), no
fraud reserves, no campaign optimization, no creator marketplace, no
helpfulness scoring, no procurement/demand pools, no benefit-pool
allocation, no external payment execution, no blockchain/decentralized
fraud consensus, no provider-specific fraud SDK semantics.
