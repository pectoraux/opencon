# `outcomes` boundary

**Tier:** domain
**Authority:** outcome evaluation and **measurement semantics**
(architecture §18; architecture-lock §14 invariant 25: measurement
adapters provide facts; `/outcomes` retains semantic authority)
**Architecture ref:** `spec/architecture.md` §4, §13, §18;
`spec/architecture-lock.md` §4, §7
**Work order:** `spec/work-orders/NET-W006.md`

## Scope after NET-W006

- **Outcome observations** — first-class, durable, IMMUTABLE records
  with provenance (method + version REQUIRED), confidence with
  uncertainty, optional validated links to NET-W005 Outcome Claims and
  Evidence, and append-corrected corrections (corrections are NEW
  records targeting the chain head; branching is rejected).
- **Attribution representation** (OUT-002) — deterministic (mechanical
  link REQUIRED), probabilistic (link FORBIDDEN, method/version +
  quantified interval REQUIRED), experimental (non-invalidated
  experiment + quantified interval REQUIRED). The modes are
  represented distinctly with stable error codes.
- **Experiments / holdouts + incrementality** (OUT-003) — deterministic
  experiment status lifecycle (PLANNED → RUNNING → COMPLETED /
  INVALIDATED, audited atomically); incrementality observations with
  DERIVED causal status (`experiment_backed` requires a COMPLETED
  experiment; otherwise explicitly `observational`).
- **Counterfactual / baselines** (OUT-004) — explicit, auditable
  records; counterfactual estimates REQUIRE a quantified confidence
  interval.
- **Measured outcome + maturation** (OUT-005) — the maturation
  aggregate (DRAFT → MEASURING → VERIFIED + CANCELLED through
  `/workflows`); finalization is explicit, authorized, idempotent and
  audited, gated by the maturation strategy (fixed_window elapsed /
  event_driven maturationEvent) and a recorded deterministic rollup.
- **Deterministic rollup** — the finalized measured value is DERIVED
  from chain-head observations by a pure function (sum/latest,
  conservative confidence), never caller-asserted, and requires ≥1
  platform/attested/provider source (model/self alone can never
  finalize — architecture-lock §4).
- **Provider ingestion** — provider-neutral ingestion through the
  `MeasurementProviderAdapter` contract (src/measurement/port.ts).

**The key rule: measurement ≠ economic truth.** This boundary
establishes outcomes and their uncertainty; it does NOT issue credits,
settle cash, mutate reputation, price advertising, or create any
economic authority.

## The NET-W021 additive read (verified performance evidence)

`MeasuredOutcomeService.listVerifiedMeasuredOutcomesBySubject` — the
canonical "verified performance evidence" read consumed (through the
composition root's neutral lookup) by the campaign-matching boundary:
the lifecycle-VERIFIED measured outcomes for a subject within an
organization scope. Only VERIFIED (finalized) measurements are
evidence — DRAFT/MEASURING are still maturing and CANCELLED is void;
the lifecycle semantics and the transition table stay in this
authority (the repository gained a read-only `listBySubject`).

## Dependencies


Core contracts (workflow lifecycle vocabulary, evidence vocabulary,
measurement vocabulary) + the NEUTRAL measurement port only.
Cross-domain access (opportunities/contributions/evidence) occurs
through structural lookup interfaces wired by the bootstrap
composition root (`MeasurementSubjectLookup`, `OutcomeClaimLookup`,
`EvidenceRecordLookup`).

Concrete provider adapters live in `/measurement` (adapter tier) and
are wired by the composition root; provider SDKs never cross into this
domain (architecture-lock §14 invariant 24).
