# `disputes` boundary

**Tier:** domain
**Authority:** challenges, disputes, appeals and penalties — the Phase-3
Trust boundary
**Architecture ref:** `spec/architecture.md` §12 (fraud architecture),
§17 (workflow authority), §18 (module ownership), §19;
`spec/architecture-lock.md` §2, §4/§5 (model non-authority), §13
invariant 21 (fraud-held claims cannot mature)
**Concrete behaviour:** NET-W009 (fraud/risk foundation) + NET-W010
(stake, challenges, disputes and appeals)

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

No fraud reserves accounting, no economic ledger or reputation changes,
no lifecycle mutation, no provider-specific fraud SDK semantics, no
decentralized fraud consensus. (Staking/bonding and the challenge/
dispute lifecycle — deferred to NET-W010 at the time — are now
implemented; see below.)

## Scope in NET-W010 — stake, challenges, disputes and appeals

The participant-initiated challenge lifecycle on the NET-W009
foundation (see `spec/work-orders/NET-W010.md` and
`docs/net-w010-disputes.md`):

- **Dispute aggregate** (`dispute-service.ts`, collection `disputes`)
  — first-class CHALLENGE/APPEAL records with an append-only event
  history and the deterministic state machine PENDING_STAKE → OPEN →
  UNDER_REVIEW → RESOLVED (→ APPEALED via a NEW linked appeal record),
  with REJECTED / WITHDRAWN terminals. The eligibility gate (person
  actor, same-scope authoritative subject, explicit-timestamp
  challenge window, one live cycle per subject, ≥1 supporting
  references) and the conflict-of-interest gate (the challenger and
  the subject's beneficiary can never review) are deterministic.
- **Stake bonding** — explicit two-step: the settlement authority
  commits the escrow (`/settlement` stake commands — NEVER here), then
  `bondStake` verifies the committed stake through the read-only
  lookup (owner/amount/unit/state/purpose linkage + window) and flips
  the dispute to formal OPEN. `markStakeOutcome` only RECORDS the
  settlement-executed release/forfeit.
- **Deterministic disposition** — resolution records the outcome
  (UPHELD/DENIED/DISMISSED), the provider-neutral control disposition
  (MAINTAIN_CONTROL/RELEASE_CONTROL/REQUIRE_REEVALUATION) for
  workflow/control consumers, and the DERIVED stake mapping
  (UPHELD/DISMISSED → RELEASE; DENIED → FORFEIT). The economic
  consequence executes through the settlement authority at the
  composition root (compound idempotency keys — the applyWorkflowHold
  precedent).
- **The dispute gate** (composition root, `refuseWhenDisputed` —
  lock invariant 21's disputed half): an ACTIVE dispute (OPEN /
  UNDER_REVIEW / APPEALED) covering a value record OR its upstream
  sources refuses maturation, credit issuance and reward allocation;
  an unbonded PENDING_STAKE request never gates (griefing resistance).

## Dependencies

`core` contracts only. Upstream records resolve through the neutral
lookup interfaces declared in `port.ts` (identity, evidence,
Proof-of-Value, measured outcomes, contributions, economic records,
reputation snapshots, and — for NET-W010 — dispute subjects with their
authoritative anchors/beneficiaries plus the read-only settlement
stake lookup) — wired at the bootstrap composition root. A resolved
risk CASE is citable as a supporting reference (`risk_case` source
kind).
