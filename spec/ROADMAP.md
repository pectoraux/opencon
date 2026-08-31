# OpenCon Persistent Roadmap

**Architecture:** Open Contribution Protocol Architecture v1.0
**Status:** Frozen architecture / approved requirements; implementation progressing by sequential NET-W work items
**Canonical backlog:** `spec/work-items.md`
**Canonical dependency graph:** `spec/dependency-graph.md`
**Canonical frozen constraints:** `spec/architecture.md`, `spec/architecture-lock.md`
**Operational state:** `spec/PROJECT-STATE.md`

## Purpose

This document is the durable roadmap for the implementation program. It is intentionally repository-local so a new LLM architect can resume the project without access to previous conversation history.

The roadmap describes what each work item is intended to accomplish, its dependencies, its authority boundary, and the non-drift rule that applies to it. Exact acceptance criteria remain in the corresponding work item/work order and evidence artifacts.

## Program invariant

OpenCon is built as one protocol with explicit authorities. Do not solve a new problem by creating a second authority for something an existing boundary already owns.

The v1.0 frozen architecture has sixteen domain boundaries. A new seventeenth domain requires an explicit Architecture Change Request and a new architecture version.

### Authority map

| Responsibility | Authoritative boundary |
|---|---|
| identity / organizations / participants | `/identity`, `/organizations`, `/participants` |
| opportunities / contributions | `/opportunities`, `/contributions` |
| lifecycle state | `/workflows` |
| evidence / commitments / Proof-of-Value | `/evidence` |
| normalized outcomes / measurement semantics | `/outcomes` |
| reputation | `/reputation` |
| economic ledger / value / credits / cash / settlement | `/settlement` |
| risk / controls / disputes | `/disputes` |
| campaign policy | `/campaigns` |
| creator identity / preferences / matching / creator records | `/creators` |
| inventory / placements | `/inventory` |
| provider-specific integrations | `/adapters` |
| LLM / provider-neutral AI boundary | `/llm` |
| agents / orchestration mechanisms | `/agents` |
| API / workers / persistence / audit / config / observability | infrastructure boundaries |

Composition-root orchestration is allowed, but an orchestration function must not become a hidden second authority.

## Development state

### Phase 1 — Foundation

- **NET-W001 — Platform and modular-monolith foundation** — **COMPLETE**. Established module boundaries, configuration/secrets boundary, workers, logging, execution/correlation IDs, API conventions, static architecture enforcement.
- **NET-W002 — Identity, organizations and participant model** — **COMPLETE**. Established identity, roles, organizations, server-side authorization, tenancy and audit lineage.
- **NET-W003 — Persistence, queues, objects, secrets and observability** — **COMPLETE**. PostgreSQL is authoritative; Redis is coordination only; durable objects are referenced from authority; real provider adapters and integration tests exist.

### Phase 2 — Protocol core

- **NET-W004 — Opportunity and contribution lifecycle** — **COMPLETE**. `/workflows` owns lifecycle transitions.
- **NET-W005 — Evidence and Proof-of-Value** — **COMPLETE**. Evidence provenance, confidence, commitments, attestations and PoV lifecycle established.
- **NET-W006 — Outcomes and measurement abstraction** — **COMPLETE**. Normalized outcome semantics, attribution and uncertainty preservation established.
- **NET-W007 — Reputation engine** — **COMPLETE**. Multidimensional deterministic reputation, provenance and decay established.
- **NET-W008 — Participation Credits and economic ledger** — **COMPLETE**. Double-entry ledger, value maturation, credits, rewards and cash accounting established.

### Phase 3 — Trust

- **NET-W009 — Fraud and risk engine** — **COMPLETE**. Risk signals, assessments, cases and economic/workflow gates established in `/disputes`.
- **NET-W010 — Stake, challenges and disputes** — **COMPLETE**. Stakes, challenge windows, dispute lifecycle, appeals and risk gating established.

### Phase 4 — Farmable contribution market

- **NET-W011 — Campaign domain** — **COMPLETE**. Campaign policy, budgets, clearing rules and campaign bookkeeping established.
- **NET-W012 — Helpful contributions** — **COMPLETE**. Proof-of-Helpfulness, disclosure-aware recommendations and publication controls established.
- **NET-W013 — Quality, moderation and anti-spam controls** — **COMPLETE**. Provider-neutral quality, moderation and spam/abuse integration established; AI remains advisory.
- **NET-W014 — Reward and settlement integration** — **COMPLETE**. Contribution outcomes integrate into existing settlement/reputation authorities.

### Phase 5 — Creator network

- **NET-W015 — Creator identity and preferences** — **COMPLETE**. Creator profiles, preference sections, rights/restrictions and reputation references established.
- **NET-W016 — Creator matching** — **COMPLETE**. Hard eligibility gates precede deterministic ranking; AI advisory is bounded and cannot override eligibility.
- **NET-W017 — UGC workflow and rights** — **COMPLETE**. Engagement lifecycle, auto-acceptance, UGC production, rights and evidence capture established.
- **NET-W018 — Sponsorship and disclosure** — **COMPLETE**. Commercial relationships, disclosure obligations, publication evidence and sanctioned publication verification established.

### Phase 6 — Advertising network

- **NET-W019 — Inventory and placements** — **COMPLETE**. Supply registration, ownership, placement context, provenance and derived settlement-readiness established.
- **NET-W020 — Cross-promotion and clearing** — **COMPLETE**. Clearing orchestration established inside `/settlement`; the economic draw, clearing record, campaign bookkeeping and audit lineage share one authoritative transaction.
- **NET-W021 — Campaign matching and optimization** — **NEXT IMPLEMENTATION TARGET**. Optimize campaign-to-inventory/creator matching under hard constraints and measured-performance signals. AI may advise ranking only after eligibility and risk gates.
- **NET-W022 — Attribution and privacy measurement adapters** — **PLANNED**. Integrate browser/platform attribution through `/adapters`; normalize into evidence/outcomes while retaining provenance and uncertainty.
- **NET-W023 — OpenRTB and supply-chain adapters** — **PLANNED**. Connect existing ad supply through provider-specific adapters without bypassing inventory, evidence, risk or settlement semantics.

### Phase 7 — Demand economy

- **NET-W024 — Consumer Demand Pools** — **PLANNED**. Aggregate privacy-preserving consumer demand commitments and expose qualified aggregate demand.
- **NET-W025 — Business procurement pools** — **PLANNED**. Aggregate business procurement demand while minimizing competitively sensitive disclosure.
- **NET-W026 — Supplier offers and competitive selection** — **PLANNED**. Collect offers, selection criteria and reproducible selection results.
- **NET-W027 — Verified savings and counterfactuals** — **PLANNED**. Evidence-backed baseline, counterfactual and uncertainty for procurement savings.
- **NET-W028 — Benefit Pools** — **PLANNED**. Pools funded by verified contributions and allocated under explicit eligibility policy.

### Phase 8 — Decentralization

- **NET-W029 — Cryptographic attestations and commitments** — **PLANNED**. Strengthen portable integrity/privacy proofs while PostgreSQL remains semantic authority.
- **NET-W030 — External settlement adapters** — **PLANNED**. Connect internal settlement state to external payment/settlement networks through adapters.
- **NET-W031 — Portable reputation proofs** — **PLANNED**. Prove reputation claims without exporting raw private history.
- **NET-W032 — Decentralized validation/dispute layer** — **PLANNED**. Introduce independent validation/challenge participants without allowing unilateral rewrite of authoritative state.

### Phase 9 — End-to-end proof

- **NET-W033 — Complete contribution lifecycle** — **PLANNED**. Prove contribution → evidence → outcome → reputation → settlement → benefit.
- **NET-W034 — Complete advertising lifecycle** — **PLANNED**. Prove advertiser → inventory/creator → measurement → Proof-of-Value → settlement.
- **NET-W035 — Complete creator lifecycle** — **PLANNED**. Prove creator discovery → contract → UGC → disclosure → measurement → payment.
- **NET-W036 — Complete demand/procurement/benefit lifecycle** — **PLANNED**. Prove demand → supplier → fulfillment → verified savings → benefit allocation.

## Dependency sequence

The frozen backlog defines the primary dependency order:

```text
W001 → W002/W003 → W004 → W005 → W006 → W007 → W008
                                 └→ W009 → W010
W004/W005/W008 → W011 → W012 → W013 → W014
W002/W007 → W015 → W016 → W017 → W018
W002/W011 → W019 → W020 → W021 → W022 → W023
W002/W008 → W024 → W025 → W026 → W027 → W028
W005/W007/W008 → W029 → W030/W031 → W032
W014/W018/W023/W028 → W033 → W034 → W035
W028/W033 → W036
```

The precise dependency and readiness rules remain authoritative in `spec/dependency-graph.md` and `spec/work-items.md`.

## W021 implementation contract

W021 is the next implementation target after W020. Its scope must remain inside the existing frozen boundaries.

### Inputs

- campaign policy and hard requirements from `/campaigns`;
- inventory and placement context from `/inventory`;
- creator profile/matching attributes from `/creators`;
- measured historical performance from `/outcomes` and `/evidence`;
- reputation scores from `/reputation`;
- risk/control status from `/disputes`;
- provider-neutral AI advisory through `/llm` only.

### Required flow

```text
current authoritative records
        ↓
hard eligibility / policy / rights / risk gates
        ↓
eligible candidate set
        ↓
evidence-backed deterministic performance features
        ↓
baseline deterministic ranking
        ↓
bounded AI advisory ranking (optional)
        ↓
explainable optimized ordering
        ↓
append-only optimization/match result if required
```

### W021 non-negotiables

- Hard constraints MUST run before optimization.
- AI MUST NOT override hard constraints, rights, tenant boundaries, risk holds, or settlement-readiness requirements.
- AI outputs are advisory evidence, never authorization.
- Ranking inputs must be traceable to authoritative records and evidence.
- Ranking must be deterministic for identical facts/policy/reference time unless an explicitly recorded stochastic policy is introduced and accepted.
- Matching/optimization must not become a second campaign-policy authority, inventory authority, reputation authority, risk authority, workflow authority or economic authority.
- No provider SDK/types may cross into domain semantics.
- Material mutations require audit/trace lineage and established idempotency/transaction semantics.
- Any cross-authority composite with coupled material mutation must use a single authoritative transaction or an explicitly approved recoverable saga.
- New domain boundaries are forbidden without Architecture Change Request.

## Work-item operating procedure

For the next item, an implementation agent should:

1. Confirm the item is `READY_FOR_IMPLEMENTATION` in GitHub and the dependency graph.
2. Read the corresponding issue and create/update `spec/work-orders/NET-WXXX.md` as the decision record.
3. Inspect the relevant existing authorities and tests before designing new primitives.
4. Prefer existing contracts and `...WithinTx` primitives over new transaction or authority layers.
5. Implement tests mapped one-to-one with acceptance criteria plus architecture/out-of-scope regressions.
6. Run `bun run verify` and any required real-provider integration tests.
7. Perform targeted mutation checks for the highest-risk architectural invariants.
8. Create exactly one implementation PR for the work item.
9. Wait for architect review.
10. On `CHANGES_REQUESTED`, remediate on the same branch/PR; do not create a second implementation PR.
11. On approval + green verification, merge and update `spec/PROJECT-STATE.md` before advancing.

## Merge policy

```text
implementation complete
+ verification/CI green
+ architect approval
→ merge
```

No chat message can override this gate.
