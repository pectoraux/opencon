# Work Order — NET-W009: Fraud and risk foundation

**Status:** READY_FOR_IMPLEMENTATION
**Architecture:** v1.0 (FROZEN — `spec/architecture.md`, `spec/architecture-lock.md`)
**Requirements:** FRAUD-001..005 (foundation subset), AI-003 (advisory model inputs), AUD-005 (administrative action logging)
**Acceptance criteria:** NET-W009-AC-01..08
**Dependencies:** NET-W002, NET-W005, NET-W006, NET-W007, NET-W008 (all merged)
**Canonical issue:** #17

## 1. Objective

Implement the provider-neutral fraud/risk foundation for Open Contribution
Protocol v1.0: first-class risk signals with provenance, deterministic
versioned risk policies, multi-signal risk assessments that preserve
signal-level provenance, evidence-backed risk cases with append-only decision
history, explicit risk states (`CLEAR` / `WATCH` / `REVIEW` / `HOLD` /
`BLOCKED`), and auditable control decisions consumed by downstream workflow
and economic gates.

Fraud/risk is a **decision-support and control authority** — never an
economic authority and never a reputation authority.

## 2. Boundary placement (design decision)

The frozen architecture names no dedicated `/fraud` or `/risk` boundary.
The placement decision for this work item:

- `spec/architecture-lock.md` §2 freezes the sixteen core domains; a
  seventeenth domain would require an Architecture Change Request (lock
  invariants 2/8) and is therefore out of scope.
- `/workflows` explicitly renounces fraud decisions (`src/workflows/module.ts`
  and `src/workflows/transition-table.ts`: "not a fraud decision —
  NET-W009/010 own fraud").
- `/settlement` and `/reputation` are excluded by this work item's own
  invariants 1–2 (no economic mutation, no reputation mutation).
- **`/disputes`** is the only Phase-3 Trust boundary, its declared authority
  ("challenges, disputes, appeals and penalties") covers holds and
  preventive penalties, the dependency graph stacks NET-W010 (stake,
  challenges, disputes) directly on NET-W009, and lock invariant 21 treats
  "disputed or fraud-held" as sibling control states of one trust boundary.

Therefore the fraud/risk foundation is implemented in the `/disputes`
boundary. NET-W010 will extend the same boundary with staking, challenges
and the dispute lifecycle.

## 3. Scope

### 3.1 Core risk vocabulary (`src/core/risk.ts`)

Frozen signal categories (architecture §12 families + the named controls +
model advisory): `identity`, `behavioral`, `device_integrity`, `graph`,
`economic_anomaly`, `velocity`, `duplicate_pattern`, `historical_reputation`,
`model_advisory`.

- `RiskSignalCategory`, `RiskSignalSeverity` (`LOW`/`MEDIUM`/`HIGH`/`CRITICAL`),
  `RiskSignalProvenanceKind` (`authoritative_record` / `rule_detection` /
  `model_output` / `manual_review`) with the structural advisory rule:
  `model_output` provenance is ALWAYS advisory (invariant 5).
- `RiskState` (`CLEAR`/`WATCH`/`REVIEW`/`HOLD`/`BLOCKED`) with the severity
  ordering used by deterministic transitions.
- `RiskOperationClass` (control-hook classes): `value_maturation`,
  `credit_issuance`, `reward_allocation`, `cash_settlement`,
  `workflow_transition`, `participant_eligibility`.
- `RiskControlAction`: `REQUIRE_REVIEW` / `HOLD` / `BLOCK`.
- `RiskEvaluationRule` + `validateRiskEvaluationRule` (deterministic
  parameters only: weight, advisory weight factor, severity points,
  thresholds, required-category fail-safe state).
- `RISK_SCORE_DECIMALS = 6` scaled-integer score arithmetic.

### 3.2 Risk signals (§Work Item "First-class risk signals")

Immutable append-only records: organization scope, optional person subject
+ generic subject reference (contribution / proof_of_value / measured_outcome
/ economic_value / credit_issuance / cash_obligation), category, severity,
confidence (0..1), provenance (kind + detection method + detection version +
≥1 authoritative source refs — validated through neutral lookups, same-scope
enforced), advisory derivation (`model_output` ⇒ advisory), detection time
vs. record time, description, supersession (`supersededBySignalId` —
corrections append, never rewrite), execution/correlation/causation lineage.

### 3.3 Versioned deterministic risk policies (§Work Item "Deterministic, versioned fraud/risk rules")

The FULL NET-W007/NET-W008 policy-lineage pattern: stable `policyId`,
strictly monotonic versions (new lineage at 1, else latest+1),
(policyId, version) tuple idempotency (replay semantics), one organization
scope per lineage (cross-scope fork rejected on EVERY create including
version 1), the ORGANIZATION-INDEPENDENT lineage mutex
`risk_policy_lineage:{policyId}` serializing the whole apply (lock → read
lineage → verify scope → verify version → create → commit → release).

Per-category rules: weight, advisory weight factor, severity→points map,
score thresholds per state, `criticalSignalFloorState` (any non-advisory
CRITICAL signal floors the assessment), `requiredCategories` +
`missingDataState` (fail-closed, invariant 8), `advisoryOnlyCapState`
(structural REVIEW cap — advisory signals can never ALONE produce
HOLD/BLOCKED, invariant 5).

### 3.4 Deterministic risk engine (`src/disputes/risk-engine.ts`, PURE)

`evaluateRisk(policy, signals, evaluatedAt)` → per-signal contributions
(signal id, category, severity, weight, advisory, points — provenance is
NEVER collapsed into an opaque score), scaled-integer total score,
deterministic state (thresholds + critical floor + advisory cap + fail-safe
missing-data state), deterministic ordering, and a SHA-256 digest over
(policyId, version, evaluatedAt, signal ids, contributions, score, state).
Identical inputs + policy/version + evaluation time ⇒ bit-for-bit identical
output (invariant 4). Includes pure velocity/duplicate-pattern detectors
operating over authoritative economic record views (invariant: raw activity
alone is never a risk source; detectors consume authoritative records via
neutral lookups and cite them as source refs).

### 3.5 Risk assessments (§Work Item "Multi-signal assessments")

Append-only records: subject (org + person + optional subject ref), exact
policy lineage + version, explicit `evaluatedAt`, the per-signal
contributions, total score, state, digest, the exact signal ids, and
supersession (`supersededByAssessmentId`) — re-evaluation creates a NEW
assessment; history is never rewritten. Preview computation (pure,
read-only) uses the exact engine.

### 3.6 Risk cases and reviews (§Work Item "Risk cases/reviews")

Cases: `OPEN` → `UNDER_REVIEW` → `RESOLVED` (direct `OPEN` → `RESOLVED`
allowed), state derived deterministically from an append-only decision
history (open / start_review / escalate / resolve_clear / resolve_uphold),
each decision carrying reviewer identity (from the execution actor — never
caller-asserted), reason codes, note, and ≥1 supporting reference for
material decisions (invariant 3). Resolution semantics: `resolve_clear`
releases holds, `resolve_uphold` keeps them (control resolution is a
separate explicit command referencing the case).

### 3.7 Control decisions and the gates (§Work Item "Control hooks")

`RiskControlDecision`: operation class, subject ref (person- or
record-scoped), action (`REQUIRE_REVIEW`/`HOLD`/`BLOCK`), origin (assessment
id and/or case id — a material HOLD/BLOCK/REVIEW control MUST reference the
assessment/case that caused it, invariant 3), reason codes, `ACTIVE`/
`RESOLVED` state, activation/resolution lineage.

Consumption (composition root ONLY — the risk domain never imports
`/workflows` or `/settlement`):

- **Economic gate**: the runtime command implementations for value
  maturation, credit issuance, reward allocation and cash settlement
  consult the active-control registry first; an active `HOLD`/`BLOCK`
  control matching the operation class + subject (record id or beneficiary
  person) refuses the call with a stable `RISK_CONTROL` error. The
  settlement domain code is untouched (non-goal: "No economic ledger
  implementation changes").
- **Workflow gate**: an explicit composition-root command applies/clears a
  workflow hold by requesting the `FRAUD_REVIEW` transition (and the
  cleared return transition) through the workflow service — the SOLE
  lifecycle authority. The transition is an authorized, audited workflow
  service call, never a hidden mutation.

### 3.8 Persistence, idempotency, audit, tenancy

Five authority collections (`risk_signals`, `risk_policies`,
`risk_assessments`, `risk_cases`, `risk_control_decisions`) over the
PostgreSQL authority boundary. EVERY mutation runs through
`IdempotencyStore.applyIdempotent` (mutation + idempotency record + audit
event commit in ONE authoritative transaction; NET-W004-AC-07 semantics
including publication-failure recovery). Audit events (AUD-005): 
`risk_policy.version_created`, `risk_signal.recorded`,
`risk_signal.superseded`, `risk_assessment.recorded`, `risk_case.opened`,
`risk_case.decision_recorded`, `risk_control.activated`,
`risk_control.resolved`. Organization scoping is enforced on every read and
write (invariant 6).

## 4. Required invariants (from Issue #17, binding)

1. **No hidden economic authority** — the risk boundary cannot mint,
   destroy, or transfer money, Participation Credits, or value (structural:
   no economic-unit fields, no settlement/reputation imports).
2. **No direct reputation mutation** — risk assessments may later be
   consumed by reputation policies; this work item never changes reputation
   scores itself.
3. **Evidence-backed material decisions** — every material HOLD/BLOCK/
   REVIEW decision references the risk signals and/or authoritative
   upstream records that caused it (signals require ≥1 authoritative source
   ref; controls require an assessment and/or case origin).
4. **Determinism and versioning** — same signals + policy/version +
   evaluation time ⇒ same decision (digest-reproducible).
5. **Model non-authority** — `model_output` signals are structurally
   advisory; advisory-only contributions can never alone produce HOLD/
   BLOCKED (the engine caps advisory-only assessments at `REVIEW`).
6. **Tenant isolation** — signals, assessments, cases and controls never
   cross organization scopes.
7. **Auditability and atomicity** — every material risk mutation commits
   with its idempotency record and audit lineage in one authoritative
   transaction.
8. **Fail-safe controls** — when a policy requires a signal category and
   the required data is unavailable, the decision fails closed to the
   policy-defined `missingDataState` rather than silently clearing risk.

## 5. Explicit non-goals

No economic ledger implementation changes (NET-W008 files untouched), no
reputation scoring changes (NET-W007 files untouched), no
Proof-of-Value/evidence truth changes, no staking/bonding, no challenge or
dispute lifecycle (NET-W010 — the /disputes boundary hosts the foundation
but challenges/disputes themselves are NOT implemented here), no fraud
reserves accounting, no campaign optimization, no creator marketplace, no
helpfulness scoring, no procurement/demand pools, no benefit-pool
allocation, no external payment execution, no blockchain/decentralized
fraud consensus, no provider-specific fraud SDK semantics, no changes to
frozen specs.

## 6. Acceptance criteria mapping

- **NET-W009-AC-01** — first-class durable scoped provenance-backed signals
  → `tests/disputes/net-w009-ac-01-signals.test.ts`
- **NET-W009-AC-02** — deterministic, versioned, reproducible rules →
  `tests/disputes/net-w009-ac-02-policies.test.ts`
- **NET-W009-AC-03** — multi-signal assessments preserve signal-level
  provenance → `tests/disputes/net-w009-ac-03-assessments.test.ts`
- **NET-W009-AC-04** — explicit authorized auditable states/cases/holds →
  `tests/disputes/net-w009-ac-04-cases-controls.test.ts`
- **NET-W009-AC-05** — tenant-scoped authoritative-data velocity/anomaly/
  duplicate controls (incl. the held-maturation golden path) →
  `tests/disputes/net-w009-ac-05-controls-gates.test.ts`
- **NET-W009-AC-06** — idempotent, concurrent-safe, authoritative,
  atomically audit-linked mutations →
  `tests/disputes/net-w009-ac-06-atomicity-concurrency.test.ts`
- **NET-W009-AC-07** — model advisory non-authority + append-only
  correctable history →
  `tests/disputes/net-w009-ac-07-advisory-history.test.ts`
- **NET-W009-AC-08** — architecture/out-of-scope regression (frozen specs
  unchanged) → `tests/regression/net-w009-ac-08-architecture-out-of-scope.test.ts`

## 7. Verification

`bun run verify` (typecheck + `arch:check` + full unit suite) must pass.
The PR binds to frozen Architecture v1.0 and Issue #17 and carries the
evidence document `docs/net-w009-fraud-risk.md` mapping every AC to
automated verification.
