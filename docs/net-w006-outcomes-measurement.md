# NET-W006 — Outcomes and Measurement Semantics: Evidence Document

**Work item:** NET-W006 — Outcomes and measurement semantics  
**Tracking issue:** https://github.com/pectoraux/opencon/issues/11  
**Work order:** `spec/work-orders/NET-W006.md`  
**Architecture:** v1.0 (FROZEN) — `spec/architecture.md` §4/§13/§17/§18; `spec/architecture-lock.md` §4/§7/§14  
**Key rule:** **measurement ≠ economic truth** — NET-W006 establishes outcomes and their uncertainty; it never issues credits, settles cash, mutates reputation, prices advertising, or otherwise creates economic authority.

This document maps every acceptance criterion (NET-W006-AC-01..08) to
its implementation and automated verification. Reproduce with
`bun run verify` (typecheck + `arch:check` + `bun test`).

## Implementation surface

| Layer | Location | Contents |
|---|---|---|
| Core vocabulary | `src/core/measurement.ts` | attribution modes (OUT-002), `MeasurementProvenance` (method + version REQUIRED), maturation strategies (OUT-005), rollup strategies, experiment statuses (OUT-003), baseline kinds (OUT-04), causal statuses, stable error types |
| Workflow extension | `src/core/workflow.ts`, `src/workflows/transition-table.ts`, `src/workflows/port.ts`, `src/workflows/workflow-service.ts` | `outcome_measurement` lifecycle subject kind + `OUTCOME_MEASUREMENT_TRANSITION_TABLE` (DRAFT → MEASURING → VERIFIED + CANCELLED) routed through the SAME authoritative workflow machinery as opportunities/contributions/PoV |
| Outcomes domain (semantics) | `src/outcomes/` | observation service (+ append-corrected chains), experiment service, attribution service, incrementality service, baseline service, measured-outcome service, deterministic rollup (pure), 6 authority-backed repositories |
| Measurement boundary (integration) | `src/measurement/port.ts`, `src/measurement/providers/echo-measurement-provider.ts` | the provider-neutral `MeasurementProviderAdapter` contract (NET-W022 plugs in here) + the reference adapter |
| Composition root | `src/bootstrap/runtime.ts` | wiring, cross-domain structural lookups (`MeasurementSubjectLookup`, `OutcomeClaimLookup`, `EvidenceRecordLookup`), provider-adapter selection (`opts.measurement.providers` or the ECHO reference) |
| API | `src/api/port.ts`, `src/api/server.ts` | ~20 guarded mutation endpoints + public reads; lifecycle transitions via the existing `/api/workflows/transitions` endpoint (`subjectKind: "outcome_measurement"`) |

---

## AC-01 — First-class outcome observations

**Claim.** Outcome observations are first-class, durable, immutable/
append-corrected records with provenance and lineage.

**Implementation.** `src/outcomes/observation-service.ts` +
`src/outcomes/authority-outcome-observation-repository.ts` +
`src/outcomes/observation-chains.ts`. Observations carry stable ids,
org scope, observer, subject reference, OUT-001 outcome type,
optional validated OutcomeClaim/Evidence links (existence + scope),
observed value + unit, EVID-005 confidence, and measurement
provenance with REQUIRED method + methodVersion. Corrections are NEW
records (`correctsObservationId` → the chain head; branching
rejected); `resolveObservationChain` walks root → head.

**Automated verification.**
`tests/outcomes/net-w006-ac-01-observations.test.ts` (9 tests):
create/get/list + lineage; OUT-001 vocabulary rejection
(`UNSUPPORTED_OUTCOME_TYPE`); methodVersion REQUIRED
(`INVALID_MEASUREMENT_PROVENANCE`); claim/evidence link validation
incl. cross-scope rejection; immutability (original record
byte-identical after correction); append-corrected chains (root →
correction → head, both directions); branching rejection; subject/type
inheritance; atomic audit lineage (created + corrected); durable
persistence through the authority.

## AC-02 — Distinct attribution representations

**Claim.** Deterministic and probabilistic (and experimental)
attribution are represented distinctly with uncertainty and
method/version metadata.

**Implementation.** `src/outcomes/attribution-service.ts` +
`src/outcomes/authority-attribution-repository.ts`. Mode-specific
fail-closed rules (`INVALID_ATTRIBUTION`): deterministic REQUIRES a
mechanical `deterministicLink` (interval optional); probabilistic
FORBIDS a link and REQUIRES method/version + a quantified interval;
experimental REQUIRES a non-invalidated experiment reference + a
quantified interval. All modes carry attribution value + unit,
confidence, provenance, optional evidence links, lineage.

**Automated verification.**
`tests/outcomes/net-w006-ac-02-attribution.test.ts` (10 tests):
deterministic happy path (link + method/version + audit);
deterministic-without-link rejection; probabilistic happy path
(model identity + interval preserved); probabilistic-without-interval
rejection (uncertainty never collapsed); probabilistic-with-link
rejection (modes distinct); experimental with COMPLETED and RUNNING
experiments; INVALIDATED-experiment rejection (fail closed);
no-experiment rejection; no-interval rejection; unknown mode
rejection; observation existence + cross-scope validation.

## AC-03 — Experiments, holdouts, incrementality

**Claim.** Experiment/holdout and incrementality semantics represent
measured lift without claiming causality where no valid experiment
exists.

**Implementation.** `src/outcomes/experiment-service.ts` +
`src/outcomes/incrementality-service.ts` (+ repositories). The
experiment status lifecycle (PLANNED → RUNNING → COMPLETED;
INVALIDATED from PLANNED/RUNNING) is deterministic, version-checked
and audited atomically. Incrementality observations derive
`causalStatus`: `experiment_backed` REQUIRES a COMPLETED experiment
(PLANNED/RUNNING/INVALIDATED references rejected fail-closed);
without an experiment the record is explicitly `observational`
(measured lift WITHOUT a causality claim). Lift estimates REQUIRE a
quantified confidence interval.

**Automated verification.**
`tests/outcomes/net-w006-ac-03-experiments-incrementality.test.ts`
(8 tests): lifecycle happy path (audited + versioned per step);
illegal transitions (PLANNED → COMPLETED, COMPLETED → anything);
stale-writer rejection (CONFLICT); INVALIDATED with reason (+
required-reason rule); experiment_backed requires COMPLETED (fail
closed on PLANNED/RUNNING/INVALIDATED); observational lift explicitly
non-causal; interval-less lift rejection; causal status in the audit
record.

## AC-04 — Explicit counterfactual/baselines

**Claim.** Counterfactual/baseline measurements are explicit and
auditable.

**Implementation.** `src/outcomes/baseline-service.ts` +
`src/outcomes/authority-baseline-repository.ts`. Distinct kinds:
`counterfactual` (the no-treatment estimate — a quantified interval
is REQUIRED; an exact counterfactual claim without quantified
uncertainty is manufactured and rejected) and `baseline` (a reference
level). Optional comparison (observed) values; method/version
provenance; OUT-001 outcome types; atomic audit lineage.

**Automated verification.**
`tests/outcomes/net-w006-ac-04-counterfactual-baselines.test.ts`
(6 tests): counterfactual with interval + comparison + audit; plain
baseline without interval; interval-less counterfactual rejection;
unknown baselineKind rejection; OUT-001 vocabulary enforcement;
durable persistence + lineage.

## AC-05 — Maturation cannot silently finalize

**Claim.** Delayed outcomes support pending/maturation/finalized
states (DRAFT/MEASURING/VERIFIED) and cannot silently become final.

**Implementation.** `src/outcomes/measured-outcome-service.ts` +
`src/outcomes/measurement-rollup.ts` + the workflow extension. The
transition matrix has NO DRAFT → VERIFIED edge; finalization is an
explicit authorized workflow transition gated by: a recorded
deterministic rollup (derived by the pure function — sum/latest,
chain-head resolution, unit consistency, conservative confidence,
supporting-source gate ≥1 platform/attested/provider) and the
maturation strategy gate (fixed_window elapsed / event_driven
maturationEvent, recorded in the audit trail). Attachments freeze at
VERIFIED. See `docs/net-w006-measured-outcome-transition-matrix.md`.

**Automated verification.**
`tests/outcomes/net-w006-ac-05-maturation.test.ts` (13 tests):
exhaustive matrix assertions (edges, legal targets, terminal states,
policy-action shape, NO DRAFT→VERIFIED); full happy path (authorized
+ audited transitions with the authoritative transaction id);
finalize-without-rollup rejection; empty-measurement rejection; the
model/self rollup gate (rejected alone, unblocked by ONE platform
observation); fixed_window early-finalization rejection + elapsed
success; windowEndAt creation rules; event_driven maturationEvent
requirement (auditable in metadata); attachment freeze at VERIFIED;
deterministic rollup (sum + latest + conservative confidence +
chain-head resolution + superseded count); mixed-unit rejection;
cancellation from DRAFT and MEASURING; the no-economic-dimension
assertion over the finalized entity.

## AC-06 — Atomicity, idempotency, concurrency

**Claim.** Measurement mutations are authorized, idempotent,
concurrent-safe, PostgreSQL-authoritative, and audit-linked
atomically.

**Implementation.** Every mutation commits with its audit record in
ONE authoritative transaction (transactional audit buffer bound to
the same tx — the NET-W004-AC-07 semantics); lifecycle transitions
additionally commit with the idempotency record through the workflow
service (exactly-once-per-key, optimistic concurrency).

**Automated verification.**
`tests/outcomes/net-w006-ac-06-atomicity-concurrency.test.ts`
(7 tests): deterministic replay on repeated idempotency keys
(exactly one mutation + audit record); stale expectedVersion →
`CONCURRENT_TRANSITION`; concurrent same-key transitions → exactly
one mutation; append-only attachment idempotency (no-op, no second
audit record); audit publication failure after a committed creation
(retained + explicit `retryPendingPublications()` recovery — the
durable commit is never undone); fault-injected failing COMMIT on a
transition (NO mutation, NO idempotency record, NO published audit
record; the same key replays cleanly after recovery); deny-by-default
authorization (unauthorized actor rejected, measurement untouched).

## AC-07 — Provider-neutral adapters, non-authoritative models

**Claim.** External measurement providers are behind provider-neutral
adapters; domain logic remains provider-independent; model outputs
are non-authoritative inputs.

**Implementation.** `src/measurement/port.ts` declares the
provider-neutral `MeasurementProviderAdapter` contract
(`ProviderObservationReport` — normalized facts + provenance only; no
provider payloads cross the boundary). The outcomes domain imports
ONLY this neutral port; concrete adapters (browser/platform + iOS
attribution — ADAPTER-003..004) arrive in NET-W022 under
`src/measurement/providers/`. Ingestion normalizes reports into
provider-sourced observations (sourceType "provider", provider id as
source id, full method/version/confidence); invalid reports are
rejected fail-closed. The provider-reported attribution mode is
recorded as a PROVENANCE fact, not a protocol AttributionRecord. The
rollup gate (AC-05) enforces that model/self observations alone can
never finalize a measurement.

**Automated verification.**
`tests/outcomes/net-w006-ac-07-provider-adapters.test.ts` (8 tests):
ingestion through the composition root (stub adapter) with full
provenance + audit metadata; provider attribution mode as provenance
fact; multi-provider ingestion; fail-closed invalid report rejection
(nothing ingested); provider-sourced observations satisfy the
supporting-source rollup gate; the reference ECHO adapter satisfies
the contract; static isolation (outcomes domain imports only the
neutral port — no providers/, no other domains); composition-root
wiring (configured adapters + the ECHO default).

## AC-08 — Architecture and out-of-scope regression

**Claim.** The architecture checker passes, frozen architecture files
remain unchanged, no downstream economic/reputation/settlement
behavior is introduced, and the outcomes domain remains
provider-independent.

**Implementation.** The outcomes domain imports ONLY core + self +
the neutral measurement port (tier matrix compliant); measurement
semantics live in `/outcomes`, provider integrations in
`/measurement` (architecture §18; architecture-lock §14.24/§14.25);
frozen specs untouched.

**Automated verification.**
`tests/regression/net-w006-ac-08-architecture-out-of-scope.test.ts`
(13 tests): architecture check (0 violations); frozen-spec
content assertions; work-order binding; non-skeletal outcomes module;
NO forbidden economic patterns in the outcomes domain; import-tier
isolation (core + self + neutral measurement only); no provider
drivers; no committed secrets; the workflows boundary owns the
transition table; the measurement boundary carries the neutral
adapter contract; the core measurement vocabulary; the transition
matrix + evidence artifacts exist; settlement/reputation remain
skeletal (NET-W006 introduces NO economic authority).

Baseline updates for the new state of the world:
`tests/regression/net-w005-ac-08-architecture-out-of-scope.test.ts`
(the /outcomes domain is now implemented by NET-W006),
`tests/regression/net-w004-ac-08-architecture-out-of-scope.test.ts`
(outcomes removed from the deferred set),
`tests/regression/ac-08-no-premature-domain-logic.test.ts`
(NET-W006 non-skeletal assertions + outcomes removed from the
skeleton set), and `tests/adapters/ac-07-adapter-isolation.test.ts`
(the outcomes domain now depends on the neutral measurement port —
the real NET-W006 dependency replaces the NET-W001-era LlmPort
placeholder proof).

---

## Verification summary

```text
bun run verify
  = bun run typecheck   (tsc --noEmit — PASS)
  + bun run arch:check  (191 files scanned, 0 violations)
  + bun test            (all suites green; NET-W006 adds 76 tests:
                         62 in tests/outcomes/ (AC-01..07 + harness)
                         + 13 AC-08 regression tests + 1 baseline
                         update in the NET-W001 no-premature-logic
                         suite)
```

The API surface (`src/api/server.ts`) exposes the provider-neutral
operations from work-order §7: create/get/correct observations,
provider ingestion, experiment create/start/complete/invalidate,
attributions, incrementality, counterfactual baselines, measured
outcomes (create/get/attach×4/rollup), and lifecycle transitions
through the existing workflow endpoint (`subjectKind
"outcome_measurement"`) — API-003 (authorized workflow operations),
API-004 (idempotent material mutations: transitions are
idempotency-keyed; attachments are append-only idempotent),
API-005 (stable identifiers + traceable execution references on every
material operation).
