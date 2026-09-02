# NET-W033 — Complete contribution lifecycle

**Status:** ACTIVE / READY_FOR_IMPLEMENTATION  
**Architecture:** v1.0 FROZEN  
**GitHub Issue:** #67  
**Dependencies:** NET-W014, NET-W018, NET-W023, NET-W028 — merged/verified  
**Authority:** Existing domain authorities only; W033 is an end-to-end composition/proof milestone, not a new authority.

## 1. Objective

Prove one canonical contribution can traverse the existing OpenCon protocol end-to-end:

```text
opportunity/contribution
  → evidence / Proof-of-Value
  → normalized outcome / measurement
  → reputation
  → settlement
  → benefit allocation
```

W033 is a Phase-9 composition proof. It must exercise existing contracts and sanctioned composition-root orchestration without recreating or relocating authority.

## 2. Authority placement

```text
/opportunities + /contributions
        ↓
/workflows  ← sole lifecycle authority
        ↓
/evidence   ← provenance / Proof-of-Value authority
        ↓
/outcomes   ← normalized measurement authority
        ↓
/reputation ← sole reputation authority
        ↓
/settlement ← sole economic authority
        ↓
/benefits   ← benefit allocation authority; /settlement remains economic authority
```

Provider-specific integrations remain under `/adapters`; composition-root joins are allowed but must not become hidden second authorities. `/disputes` controls remain intact where contribution value is challenged or risk-gated.

## 3. Required semantics

### 3.1 Canonical scenario identity

The scenario must use deterministic fixture inputs and explicit evaluation anchors. Every material object created or referenced must have durable identifiers linking the lineage. The scenario must be reproducible without wall-clock-dependent verification.

### 3.2 Opportunity and contribution

Use an existing eligible opportunity and submit one contribution through the sanctioned contribution service/API. Authorization, participant eligibility, opportunity policy, and contribution invariants must be enforced by existing domains. W033 must not write contribution repositories directly.

### 3.3 Lifecycle

All legal contribution lifecycle transitions must pass through `/workflows`. Illegal transition attempts and direct repository/state mutations must fail closed. W033 must not add a second lifecycle state machine.

### 3.4 Evidence / Proof-of-Value

Create authoritative evidence through `/evidence` using the existing Proof-of-Value semantics. Any value, grade, confidence, or provenance required by downstream domains must be derived or verified through the owning authority. Caller-supplied economic value or evidence grade is never authoritative merely because the scenario supplies it.

### 3.5 Outcomes / measurement

Record or resolve a normalized outcome through `/outcomes` using an explicit evaluation anchor and existing measurement-provider boundary. Preserve uncertainty, attribution mode, provenance and evidence lineage. W033 must not recreate measurement semantics locally.

### 3.6 Reputation

Where the selected contribution path qualifies for reputation, the reputation result must be produced through `/reputation` from authoritative contribution/evidence/outcome inputs. W033 may observe and assert the resulting authoritative state but may not inject scores, grades, or purchased value directly into reputation.

### 3.7 Settlement

Verified contribution value must enter the existing `/settlement` pipeline only through its sanctioned economic primitives and required risk/dispute/evidence gates. Pending/mature transitions must remain settlement-owned. W033 must not create balances, value records, credits, rewards, reserves, or cash state itself.

### 3.8 Benefits

The settled/authoritative source value must feed the existing `/benefits` allocation semantics where the chosen fixture supports it. Funding references resolve to authoritative source records; allocation eligibility and shares are derived by `/benefits`; economic postings remain inside `/settlement` according to W028's existing model. W033 must not create a parallel benefit ledger.

### 3.9 Cross-boundary transaction and atomicity

Any coupled material operation already requiring one authoritative transaction must continue using its established composite/WithinTx boundary. The end-to-end scenario must include at least one injected failure at a critical join and prove that no partial success is recorded as final authoritative state.

### 3.10 Idempotency and concurrency

The composed scenario must prove deterministic same-key replay semantics at material mutation boundaries and at least one concurrency race for a material operation. A retry must not duplicate contribution value, reputation mutation, settlement posting, or benefit allocation.

### 3.11 Privacy and tenancy

Tenant scope must flow through every involved authority. Cross-tenant identifiers fail closed without existence leakage. Trace reconstruction must use durable IDs/aggregate facts rather than exposing private evidence payloads or raw personal histories.

## 4. Acceptance criteria

### AC-01 — Contribution/opportunity eligibility and submission

An eligible participant submits a contribution to an eligible opportunity through the sanctioned API/domain boundary; unauthorized/ineligible attempts fail closed.

### AC-02 — Lifecycle authority

All observed legal transitions use `/workflows`; illegal/bypass transition attempts fail closed; no local W033 lifecycle state machine exists.

### AC-03 — Evidence / Proof-of-Value authority

Authoritative evidence and Proof-of-Value are created/resolved through `/evidence`; provenance, confidence and evidence commitments remain authoritative there; caller-asserted grades/value cannot bypass the evidence authority.

### AC-04 — Outcome / measurement composition

A normalized outcome is produced through `/outcomes` with an explicit anchor; uncertainty, attribution and provenance are preserved and traceable to evidence.

### AC-05 — Reputation composition

The qualifying contribution changes reputation only through `/reputation`; the resulting authoritative state is evidence/outcome-derived; caller-supplied scores or value injection fail closed.

### AC-06 — Settlement composition

Verified contribution value reaches `/settlement` through sanctioned pending/mature paths, with existing risk/dispute controls honored; no second economic record is created by W033.

### AC-07 — Benefit composition

Authoritative settled/verified value feeds `/benefits` using existing W028 semantics; allocations remain traceable, deterministic and privacy-preserving; economic postings remain `/settlement`-owned.

### AC-08 — End-to-end lineage, audit, privacy and tenancy

The full contribution chain is reconstructable from durable identifiers and audit events; cross-tenant and unauthorized access fail closed; private source evidence is not exposed on portable/public surfaces.

### AC-09 — Idempotency, concurrency, atomicity and failure injection

Replay, race and injected-failure scenarios converge without double application or partial final state; existing transactional audit ordering remains intact.

### AC-10 — Architecture / authority / scope regression

Static architecture and authority checks pass; frozen architecture files remain byte-identical; no new domain, authority, ledger, crypto, consensus, AI authority or W034–W036 behavior is introduced.

## 5. Required evidence

- One-to-one AC suites covering AC-01..AC-10.
- At least one deterministic full-path scenario from contribution creation through benefit outcome.
- Authority containment tests demonstrating that each mutation occurs through its owning boundary, not direct repository writes.
- Durable lineage reconstruction with audit identifiers.
- Cross-tenant and authorization regression fixtures across the composed surfaces.
- Replay/concurrency/fault-injection coverage at the critical composite joins.
- Targeted mutation checks for lifecycle, evidence authority, outcome authority, reputation authority, settlement authority and benefits/economic containment.
- `bun run verify`, `arch:check`, `authority:check`, secret scan.
- Configured real PostgreSQL/Redis integration, including a real-provider end-to-end round-trip.
- CI verification on both push and `pull_request` events.
- Evidence ledger updated with exact counts, commands, commit/CI references and any approved/sanctioned shared-file amendments.

## 6. Out of scope

- No new domain or authority.
- No new economic primitive or ledger.
- No new cryptographic primitive or signing surface.
- No second workflow engine.
- No changes to W032 validation semantics.
- No new portable-proof semantics.
- No advertising lifecycle (W034).
- No creator lifecycle (W035).
- No new demand/procurement semantics beyond the existing W028 benefit composition needed to prove the contribution path.
- No silent architecture changes. Any genuinely missing primitive must be surfaced as a formal architecture/work-item gap, not invented inside W033.

## 7. Decision of record

W033 is the first Phase-9 end-to-end proof milestone. Its implementation should be predominantly integration/composition tests and sanctioned orchestration. The success condition is not that W033 adds functionality; it is that one contribution is demonstrably able to traverse the existing authoritative protocol without bypass, authority duplication, privacy leakage, economic inconsistency, or partial-success ambiguity.