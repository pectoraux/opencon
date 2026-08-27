# `disputes` boundary

**Tier:** domain
**Authority:** challenges, disputes, appeals and penalties — the Phase-3
Trust boundary
**Architecture ref:** `spec/architecture.md` §12 (fraud architecture),
§17 (workflow authority), §18 (module ownership), §19;
`spec/architecture-lock.md` §2, §4/§5 (model non-authority), §13
invariant 21 (fraud-held claims cannot mature)
**Concrete behaviour:** NET-W009 (fraud/risk foundation); NET-W010 will
add staking, challenges and the dispute lifecycle

## Scope in NET-W009

The fraud/risk foundation (see `spec/work-orders/NET-W009.md` §2 for the
boundary-placement decision):

- **Risk signals** (`signal-service.ts`) — first-class, append-only,
  provenance-backed findings. ≥1 authoritative source ref required
  (evidence-backed material decisions); `model_output` provenance is
  structurally ADVISORY; corrections append superseding signals.
- **Risk policies** (`policy-service.ts`) — immutable, versioned,
  deterministic rule sets. The full NET-W007/W008 policy-lineage
  pattern: (policyId, version) tuple idempotency, strictly monotonic
  versions, one org scope per lineage (cross-scope forks rejected on
  every create including v1, under the org-independent
  `risk_policy_lineage:{policyId}` mutex).
- **Deterministic engine** (`risk-engine.ts`, PURE) — multi-signal
  evaluation preserving per-signal provenance (contributions, not an
  opaque score), scaled-integer arithmetic, SHA-256 digest. Structural
  rules: advisory-only cap (≤ REVIEW — model output can never ALONE
  produce HOLD/BLOCKED), critical-signal floor, fail-closed
  missing-required-category state. Includes the pure velocity /
  duplicate-pattern detectors over authoritative economic records.
- **Risk assessments** (`assessment-service.ts`) — append-only
  evaluations with explicit `evaluatedAt`, exact policy version
  pinning, supersedes semantics (re-evaluation creates new records).
- **Review cases** (`case-service.ts`) — OPEN → UNDER_REVIEW →
  RESOLVED with append-only decision history; reviewer identity from
  the execution actor; material decisions require supporting refs;
  explicit CLEARED/UPHELD resolution semantics.
- **Control decisions** (`control-service.ts`) — the workflow/economic
  gate registry (operation class + subject + action + origin).
  Evidence-backed: an assessment and/or case origin is REQUIRED. The
  composition-root economic gates consult `findGatingControl` and
  refuse their OWN operations (lock invariant 21) — this boundary
  never mutates `/workflows` or `/settlement` state itself.

All mutations run through `IdempotencyStore.applyIdempotent` (mutation
+ idempotency record + audit event in ONE authoritative transaction —
NET-W004-AC-07 semantics).

## Non-goals (NET-W009)

No staking/bonding, no challenge/dispute lifecycle (NET-W010), no
fraud reserves accounting, no economic ledger or reputation changes,
no lifecycle mutation, no provider-specific fraud SDK semantics, no
decentralized fraud consensus.

## Dependencies

`core` contracts only. Upstream records resolve through the neutral
lookup interfaces declared in `port.ts` (identity, evidence,
Proof-of-Value, measured outcomes, contributions, economic records,
reputation snapshots) — wired at the bootstrap composition root.
