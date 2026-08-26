# NET-W006 — Measured-Outcome Transition Matrix

**Work item:** NET-W006 — Outcomes and measurement semantics  
**Work order:** `spec/work-orders/NET-W006.md` §3.5  
**Architecture:** v1.0 (FROZEN) — §17 (authoritative workflow), architecture-lock §7 (workflow authority)  
**Subject kind:** `outcome_measurement` (registered in `src/core/workflow.ts` `LifecycleSubjectKind`; table owned by `src/workflows/transition-table.ts` — the SOLE lifecycle authority)

The measured-outcome maturation lifecycle reuses the canonical state
vocabulary with MATURATION semantics. Transitions are authorized,
deterministic, idempotent (same idempotency key = deterministic
replay), version-checked (optimistic concurrency) and audited
atomically with the authoritative transaction id — exactly the
NET-W004/NET-W005 machinery.

```text
                    ┌────────────┐
                    │   DRAFT    │ (pending: observations/attributions/
                    └─────┬──────┘  baselines/incrementality attachable)
              beginMaturation │            cancel
             ┌────────────────┘            │
             ▼                             ▼
      ┌────────────┐                ┌────────────┐
      │ MEASURING  │───────────────▶│ CANCELLED  │ (terminal)
      └─────┬──────┘   cancel       └────────────┘
            │ finalize (explicit, gated)
            ▼
      ┌────────────┐
      │  VERIFIED  │ (FINALIZED — terminal; attachments frozen)
      └────────────┘
```

## Exhaustive legal-transition table

| # | From | To | Policy action | Audit event | Domain precondition (validated by the outcomes service BEFORE the transition is requested) |
|---|------|----|---------------|-------------|-------------------------------------------------------------------------------------------|
| 1 | `DRAFT` | `MEASURING` | `outcome_measurement.transition.draft_to_measuring` | same name | none (the maturation window opens empty; observations may arrive during maturation) |
| 2 | `MEASURING` | `VERIFIED` | `outcome_measurement.transition.measuring_to_verified` | same name | **finalize gate** (see below) |
| 3 | `DRAFT` | `CANCELLED` | `outcome_measurement.transition.draft_to_cancelled` | same name | none |
| 4 | `MEASURING` | `CANCELLED` | `outcome_measurement.transition.measuring_to_cancelled` | same name | none |

## The finalize gate (work order §3.5/§3.6 — "cannot silently become final")

`MEASURING → VERIFIED` is requested only after the outcomes domain
service validates ALL of:

1. **A recorded deterministic rollup** (`recordMeasurementRollup` —
   legal only in `MEASURING`, requires ≥1 attached observation incl.
   ≥1 platform/attested/provider source; the finalized value is
   DERIVED by the pure rollup function, never caller-asserted).
2. **Maturation strategy gate**:
   - `immediate` — no additional gate;
   - `fixed_window` — `now >= windowEndAt` (finalizing before the
     delayed-outcome window elapses is rejected with
     `MEASUREMENT_VALIDATION`);
   - `event_driven` — an explicit, non-empty `maturationEvent`
     reference (recorded in the transition's audit metadata as the
     auditable basis for why the outcome matured).

## Explicitly ILLEGAL transitions (exhaustive rejection)

Every (from, to) pair not in the table is rejected with the stable
error code `ILLEGAL_TRANSITION`. Notably:

- **`DRAFT → VERIFIED` is intentionally NOT legal** — finalization can
  never be silent: every measurement passes through the maturation
  state and finalization is an explicit authorized operation.
- `VERIFIED → *` and `CANCELLED → *` — terminal states admit no
  transitions (`TERMINAL_STATE`).
- No `BLOCKED` / `FRAUD_REVIEW` / `DISPUTED` states for the measured
  outcome — fraud/dispute semantics are NET-W009..010 non-goals
  (NET-W006 §5).
- No `REJECTED` state — a measurement that cannot mature is
  `CANCELLED`; rejection is an evaluation outcome owned by the
  Proof-of-Value lifecycle (NET-W005 §3.8), not a measurement fact.

## Attachment freeze

Observations, attributions, baselines and incrementality observations
attach ONLY while `DRAFT` or `MEASURING` (delayed outcomes arrive
during maturation). A `VERIFIED` (finalized) or `CANCELLED`
measurement is frozen — attachment attempts are rejected with
`MEASUREMENT_VALIDATION`.
