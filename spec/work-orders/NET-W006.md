# NET-W006 — Outcomes and Measurement Semantics

**Status:** READY_FOR_IMPLEMENTATION  
**Architecture:** v1.0 (FROZEN)  
**Requirements:** OUT-001..005, API-003..005 (as applicable to outcome/measurement semantics), ADAPTER-003..004 (provider-neutral boundary only; concrete platform adapters are NET-W022)  
**Dependencies:** NET-W005 (merged 2d2cc6f), NET-W004 (merged), NET-W003 (merged), NET-W002 (merged)  
**Acceptance Criteria:** NET-W006-AC-01..08  
**Tracking issue:** https://github.com/pectoraux/opencon/issues/11  

## 1. Objective

Implement the provider-neutral outcomes and measurement layer that
gives the protocol a rigorous representation of real-world outcomes
without making attribution, campaign economics, reputation, credits,
or settlement authoritative.

NET-W005 established the outcome-claim vocabulary and the Evidence /
Proof-of-Value foundation. NET-W006 now owns the **measurement
semantics** behind those claims: outcome observations, attribution
evidence, deterministic/probabilistic attribution representations,
experiments/holdouts, incrementality, counterfactual baselines,
delayed outcome maturation, and measurement confidence.

## 2. Architectural binding

This work item is bound to frozen Architecture v1.0.

- `/outcomes` owns outcome evaluation and **measurement semantics**
  (architecture §18); `/measurement` owns **measurement provider
  integrations** — semantics remain in `/outcomes` (architecture §18;
  architecture-lock §14.25: "Measurement and payment adapters provide
  evidence/transaction facts; `/outcomes` and `/settlement` retain
  semantic authority").
- Measurement supports deterministic attribution, probabilistic
  attribution, experimental incrementality, and counterfactual savings
  measurement; **all economically material values retain
  confidence/uncertainty information** (architecture §13).
- Agent/model output is input evidence or a recommendation; it never
  directly authorizes settlement and never becomes authoritative truth
  solely because a model produced it (architecture-lock §4; §19
  authority rules).
- PostgreSQL remains the authoritative application state
  (architecture-lock §3). Every measurement record persists through
  the NET-W003 authority boundaries with transaction/audit semantics.
- The measured-outcome maturation lifecycle is authoritative workflow
  state: lifecycle transitions go through `/workflows`
  (architecture §17; architecture-lock §7) — the same deterministic,
  idempotent, authorized, audited machinery established by NET-W004
  and reused by NET-W005 for the Proof-of-Value.

**The key rule: measurement ≠ economic truth.** NET-W006 can
establish an outcome and its uncertainty. It cannot issue credits,
settle cash, mutate reputation, optimize ad pricing, or otherwise
create economic authority.

```text
Evidence / Outcome Claim (NET-W005)
            ↓
       Outcome Observation
            ↓
         Attribution
       ┌────┴────────┐
Deterministic    Probabilistic
            ↓
    Experiment / Holdout
            ↓
      Incrementality
            ↓
  Counterfactual / Baseline
            ↓
     Outcome Maturation
            ↓
  Finalized Measurement
            ↓
Proof-of-Value / later domains
```

## 3. Scope

### 3.1 Outcome observations (first-class, immutable, append-corrected)

An outcome observation is a first-class durable record of a measured
outcome event/fact, linked to the existing NET-W005 vocabulary:

- stable identifier, organization scope, observer id
- subject reference (what was measured — typically a contribution)
- outcome type from the standard OUT-001 vocabulary (core/evidence.ts)
- OPTIONAL links to an OutcomeClaim and/or an Evidence record
  (NET-W005) — validated for existence + organization scope when
  present
- observed value + unit
- confidence with uncertainty (EVID-005 invariants)
- measurement provenance: source type, source id, method, method
  **version**, collection timestamp, collector (method and version are
  REQUIRED so model/method identity is never collapsed)
- execution/correlation/causation lineage

Observations are IMMUTABLE: a correction is a NEW observation record
with `correctsObservationId` pointing at the record it corrects
(append-corrected). Corrections must target the CHAIN HEAD (branching
correction chains are rejected); the original record is never
rewritten. Chain resolution (`resolveObservationChain`) exposes the
full correction lineage; the chain head is the current measurement.

### 3.2 Attribution representation (OUT-002, provider-neutral)

An attribution record attributes an outcome observation to a subject
(typically a contribution) with an EXPLICIT mode:

- `deterministic` — an unambiguous causal/mechanical link exists. The
  record MUST carry a `deterministicLink` (link type + opaque link
  identifier, e.g. a click id or referral code). Confidence is
  required (a mechanical link carries no sampling uncertainty, so an
  interval is OPTIONAL).
- `probabilistic` — deterministic identity linkage is unavailable. The
  record MUST carry method + methodVersion (model identity preserved)
  and a confidence estimate **with a quantified interval** — a
  probabilistic attribution without an interval is a manufactured
  exact claim and is REJECTED (architecture §13: uncertainty is
  retained, never collapsed). A `deterministicLink` on a
  probabilistic record is REJECTED (the modes are represented
  distinctly).
- `experimental` — attribution derived from a controlled experiment.
  The record MUST reference an existing experiment in the same
  organization scope whose status is RUNNING or COMPLETED (an
  INVALIDATED experiment cannot back attribution — fail closed), and
  MUST carry a confidence interval (experimental estimates are
  statistical).

Every attribution record carries: attribution value + unit,
confidence, measurement provenance (method/version/source), optional
supporting evidence ids, and lineage.

### 3.3 Experiments / holdouts and incrementality (OUT-003)

A measurement experiment represents a controlled experiment or holdout:

- experiment type (provider-neutral design label, e.g. "holdout",
  "geo-split"), hypothesis, start/end dates
- deterministic status lifecycle: `PLANNED → RUNNING → COMPLETED` with
  `INVALIDATED` reachable from PLANNED or RUNNING; every status change
  is a domain-authorized, audited, atomic mutation (experiment status
  is measurement INPUT state, not protocol lifecycle state — it does
  not route through `/workflows`)
- owner, organization scope, lineage

An incrementality observation records measured LIFT explicitly:

- lift value + unit + confidence (interval REQUIRED — a statistical
  estimate)
- baseline (control-arm) value + unit for comparison
- measurement provenance (method/version)
- `experimentId` (optional) + derived `causalStatus`:
  - when `experimentId` is present, the experiment MUST exist in the
    same organization scope and be `COMPLETED` — referencing a
    PLANNED/RUNNING/INVALIDATED experiment is REJECTED (fail closed) —
    and `causalStatus` is `experiment_backed`
  - when `experimentId` is absent, `causalStatus` is `observational`:
    the record represents measured lift WITHOUT claiming causality
    (no valid experiment exists)

### 3.4 Counterfactual / baseline measurements (OUT-004)

A counterfactual/baseline record represents "what would have happened
without the contribution" or a reference level, explicitly and
auditable:

- `baselineKind`: `counterfactual` (estimated no-treatment outcome) or
  `baseline` (reference level)
- baseline value + unit; optional comparison (observed) value + unit
- outcome type (OUT-001 vocabulary), subject reference
- measurement provenance (method/version — REQUIRED), confidence with
  uncertainty (EVID-005 invariants; interval REQUIRED for
  counterfactual estimates — an exact counterfactual claim without
  quantified uncertainty is manufactured and rejected)
- optional supporting evidence ids, lineage, audit record

### 3.5 Measured outcome + maturation (OUT-005)

A measured outcome is the maturation aggregate: it references a
subject, an outcome type, optionally a NET-W005 outcome claim, and
collects (append-only, pre-finalization) observation ids, attribution
ids, baseline ids, and incrementality ids.

Maturation policy (fixed at creation):

- `immediate` — no maturation gate; finalizable as soon as a rollup
  is recorded
- `fixed_window` — `windowEndAt` REQUIRED; finalization before
  `windowEndAt` is REJECTED (the delayed-outcome window must elapse)
- `event_driven` — a `maturationEvent` reference (non-empty, recorded
  in the audit trail) is REQUIRED at finalization (the explicit,
  auditable basis for why the outcome matured)

Lifecycle (canonical state vocabulary reused with measurement
semantics; transitions owned by `/workflows`):

```text
DRAFT → MEASURING → VERIFIED
DRAFT → CANCELLED
MEASURING → CANCELLED
```

- `DRAFT` — measurement created (pending); observations/attributions/
  baselines/incrementality attachable
- `MEASURING` — maturation window open; attachments still legal
  (delayed outcomes arrive during maturation)
- `VERIFIED` — FINALIZED (terminal): the explicit, auditable terminal
  state of the measurement. Attachments are frozen.
- `CANCELLED` — exceptional terminal.

`VERIFIED` and `CANCELLED` are terminal. No `DRAFT → VERIFIED` edge
exists: finalization is ALWAYS explicit and ALWAYS passes through the
maturation state.

### 3.6 Deterministic measurement rollup

The finalized measured value is DERIVED (never caller-asserted —
architecture-lock §4: evidence, not participant or agent claims, is
authoritative) by a deterministic, pure rollup function over the
attached observations:

- only CHAIN-HEAD observations (non-superseded corrections) count
- all included observations must share one unit (mixed units are
  rejected with a stable error code)
- rollup strategy (fixed at measurement creation):
  - `sum` — the finalized value is the sum of chain-head values
    (event/count-like outcomes)
  - `latest` — the finalized value is the value of the
    most-recently-collected chain head (state-like outcomes such as
    retention; deterministic tiebreak by observation id)
- confidence: conservative combination — the point estimate is the
  MINIMUM contributing point; the interval (when any contributor
  quantifies one) is the conservative envelope [min lower, max upper]
- the rollup records the exact observation ids it covers (auditability)

The rollup is recorded by an explicit `recordRollup` operation (legal
only in MEASURING; requires ≥1 attached observation) and REQUIRES at
least one observation whose source type is `platform`, `attested`, or
`provider` — model-assessed or self-reported observations alone can
never produce a finalized measurement (architecture-lock §4).

### 3.7 Provider-neutral measurement ingestion (AC-07)

External measurement platforms integrate behind the provider-neutral
`MeasurementProviderAdapter` contract (`src/measurement/port.ts`,
neutral tier). The outcomes domain consumes ONLY the neutral port;
concrete providers (browser/platform attribution, iOS attribution —
ADAPTER-003..004) arrive as adapters in `src/measurement/providers/`
in NET-W022. Provider-reported facts are normalized into outcome
observations with `sourceType: "provider"`, the provider id as source
id, and full method/version/confidence provenance. Provider (and
model) outputs are measurement INPUTS — never authoritative truth by
virtue of their origin.

## 4. Required invariants

1. Outcome observations, attributions, experiments, incrementality
   observations, counterfactual baselines, and measured outcomes
   persist through PostgreSQL-backed authority boundaries (NET-W003)
   with execution/correlation/causation lineage and append-oriented
   audit records committed atomically with the mutation (AUD-002).
2. Observations are immutable; corrections are new records (append-
   corrected) and must target the chain head; the original record is
   never rewritten.
3. Attribution modes are represented DISTINCTLY with deterministic
   mode-specific validation rules (stable error codes): deterministic
   requires a mechanical link; probabilistic forbids a mechanical
   link and requires method/version + a quantified interval;
   experimental requires a non-invalidated experiment reference + a
   quantified interval.
4. Incrementality never claims causality without a valid experiment:
   `experiment_backed` requires a COMPLETED experiment; otherwise the
   record is explicitly `observational`.
5. Counterfactual/baseline measurements are explicit records with
   method/version provenance and quantified uncertainty.
6. Delayed outcomes cannot silently become final: finalization is an
   explicit authorized workflow transition; `fixed_window`
   measurements cannot finalize before `windowEndAt`; `event_driven`
   measurements require an auditable `maturationEvent`; a recorded
   rollup (≥1 observation incl. ≥1 platform/attested/provider source)
   is a hard precondition.
7. Only `/workflows` may authoritatively transition measured-outcome
   lifecycle state (architecture-lock §7); the outcomes domain service
   validates preconditions but never bypasses workflow authority.
   Every transition is tenant/participant scoped, server-authorized,
   deterministic, idempotent (same idempotency key = deterministic
   replay), and version-checked (optimistic concurrency).
8. Measurement establishes facts/estimates and their uncertainty — it
   NEVER issues credits, settles cash, mutates reputation, prices
   advertising, or creates any economic authority. No measurement
   record carries an economic value dimension.
9. The outcomes domain imports ONLY core + self + the neutral
   measurement port; provider SDKs/types never cross into the domain
   (architecture-lock §14.24); model output is admissible only as
   MODEL_ASSESSED input and can never alone support a finalized
   measurement (architecture-lock §4).

## 5. Explicit non-goals

Do not implement:

- reputation scoring (NET-W007)
- Participation Credits, pending/mature ECONOMIC value, cash
  settlement (NET-W008)
- ad campaign optimization or campaign delivery (NET-W011+)
- creator marketplace behavior
- helpfulness scoring (NET-W012)
- demand/procurement/benefit pools
- fraud scoring or challenge economics (NET-W009..010)
- blockchain consensus or decentralized validation
- browser/platform/iOS attribution adapters or privacy-preserving
  platform attribution internals (NET-W022 — this item delivers the
  provider-neutral boundary they plug into)
- economic settlement of any kind: a finalized measurement is a
  measured fact with uncertainty, NOT a payable value

## 6. Required acceptance criteria

### NET-W006-AC-01 — First-class outcome observations

Outcome observations are first-class, durable, immutable/
append-corrected records with provenance and lineage: create/get/list
through authorized operations; stable ids; tenant scoping; optional
validated links to Outcome Claims and Evidence; corrections append as
new records targeting the chain head (branching rejected); chain
resolution exposes the correction lineage.

**Required evidence:** domain + persistence integration tests,
including correction-chain tests and raw-record immutability.

### NET-W006-AC-02 — Distinct attribution representations

Deterministic and probabilistic (and experimental) attribution are
represented distinctly with uncertainty and method/version metadata:
mode-specific validation fails closed with stable error codes
(deterministic without a link; probabilistic with a link; probabilistic
without an interval; experimental without a valid experiment).

**Required evidence:** exhaustive mode-rule tests over the attribution
service.

### NET-W006-AC-03 — Experiments, holdouts, incrementality

Experiment/holdout and incrementality semantics represent measured
lift without claiming causality where no valid experiment exists:
experiment status lifecycle is deterministic and audited;
`experiment_backed` requires a COMPLETED experiment; observational
lift is explicitly non-causal.

**Required evidence:** experiment lifecycle tests + incrementality
causality-rule tests.

### NET-W006-AC-04 — Explicit counterfactual/baselines

Counterfactual/baseline measurements are explicit and auditable:
distinct kinds, method/version provenance, quantified uncertainty
(interval required for counterfactuals), comparison values, atomic
audit lineage.

**Required evidence:** baseline/counterfactual domain tests.

### NET-W006-AC-05 — Maturation cannot silently finalize

Delayed outcomes support pending/maturation/finalized states
(DRAFT/MEASURING/VERIFIED) and cannot silently become final: no
DRAFT→VERIFIED edge; finalization requires a recorded rollup;
fixed_window enforces the window; event_driven requires the
maturationEvent; finalization is an authorized, idempotent, audited
workflow transition carrying the authoritative transaction id.

**Required evidence:** maturation gate tests + transition-matrix
exhaustiveness tests.

### NET-W006-AC-06 — Atomicity, idempotency, concurrency

Measurement mutations are authorized, idempotent, concurrent-safe,
PostgreSQL-authoritative, and audit-linked atomically: deterministic
replay on repeated idempotency keys; stale-writer rejection; audit
failure during a measurement mutation rolls the mutation back; a
failed authoritative commit leaves NO mutation and NO published audit
record; attachments are append-only idempotent.

**Required evidence:** fault-injection + concurrency integration
tests over the NET-W003 persistence/idempotency boundaries.

### NET-W006-AC-07 — Provider-neutral adapters, non-authoritative models

External measurement providers are behind provider-neutral adapters:
the domain consumes only the neutral port; provider ingestion
normalizes reports into observations with full provenance; model
outputs are admissible inputs but never authoritative (the rollup
gate enforces ≥1 platform/attested/provider source); the reference
provider satisfies the adapter contract.

**Required evidence:** provider-ingestion tests (stub adapter through
the composition root) + architecture isolation tests.

### NET-W006-AC-08 — Architecture and out-of-scope regression

The architecture checker passes, frozen architecture files remain
unchanged, no downstream economic/reputation/settlement behavior is
introduced, and the outcomes domain remains provider-independent
(core + self + neutral measurement port only).

**Required evidence:** static architecture check + regression tests.

## 7. Suggested API/application operations

Provider-neutral operations may include:

```text
createOutcomeObservation / getOutcomeObservation / correctOutcomeObservation
ingestProviderObservations
createMeasurementExperiment / startExperiment / completeExperiment / invalidateExperiment
createAttribution
createIncrementalityObservation
createCounterfactualBaseline
createMeasuredOutcome / getMeasuredOutcome
attachObservationToMeasurement / attachAttributionToMeasurement /
attachBaselineToMeasurement / attachIncrementalityToMeasurement
recordMeasurementRollup
requestTransition (existing workflow endpoint, subjectKind "outcome_measurement")
```

Exact transport shape is implementation-defined, but domain semantics
must remain independent of HTTP or any external platform.

## 8. Required evidence package

The implementation PR must contain:

- `docs/net-w006-outcomes-measurement.md` (evidence document mapping
  every AC to automated verification)
- `docs/net-w006-measured-outcome-transition-matrix.md`
- tests mapped 1:1 to AC-01..08
- reproducible `bun run verify` output

## 9. Definition of done

NET-W006 is complete only when:

1. OUT-001..005 are implemented at the measurement-semantics level
   (vocabulary OUT-001 arrived in NET-W005).
2. Every measurement record is durable, tenant-scoped, lineage-carrying,
   and audit-linked atomically (AUD-002).
3. Deterministic/probabilistic/experimental attribution and
   observational/experiment-backed incrementality are represented
   distinctly, preserving method/version/confidence/uncertainty.
4. Counterfactual/baseline measurements are explicit and auditable.
5. Delayed outcomes mature through an explicit, authorized, audited
   lifecycle and cannot silently become final.
6. The finalized measured value is deterministically derived from
   observations (never caller-asserted) with preserved uncertainty.
7. Provider integration is provider-neutral (concrete adapters are
   NET-W022); model output is never authoritative.
8. Architecture/out-of-scope regression passes with frozen specs
   unchanged.
9. One implementation PR is bound to frozen Architecture v1.0 and
   this work item.
