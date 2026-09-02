# NET-W033 Evidence Ledger — Complete contribution lifecycle

**Status:** ACTIVE / READY_FOR_IMPLEMENTATION  
**Issue:** #67  
**Architecture:** v1.0 frozen  
**Dependencies:** NET-W014 + NET-W018 + NET-W023 + NET-W028 — merged/verified  
**Implementation branch:** `feat/net-w033-complete-contribution-lifecycle`

## Scope

W033 is a Phase-9 end-to-end composition proof. It must demonstrate one canonical contribution traversing the existing authoritative chain without adding a new authority:

```text
opportunity/contribution
  → workflows lifecycle
  → evidence / Proof-of-Value
  → normalized outcome / measurement
  → reputation
  → settlement
  → benefit allocation
```

## Acceptance map

| AC | Required proof | Delivered |
|---|---|---|
| AC-01 | Opportunity/contribution eligibility + sanctioned submission | TBD |
| AC-02 | `/workflows` sole lifecycle authority; bypasses fail closed | TBD |
| AC-03 | `/evidence` Proof-of-Value/provenance authority | TBD |
| AC-04 | `/outcomes` normalized measurement, anchor, uncertainty/provenance | TBD |
| AC-05 | `/reputation` authoritative contribution-derived reputation | TBD |
| AC-06 | `/settlement` verified contribution value through pending/mature path | TBD |
| AC-07 | `/benefits` composition with `/settlement` remaining economic authority | TBD |
| AC-08 | End-to-end lineage, audit, privacy, tenancy | TBD |
| AC-09 | Idempotency, concurrency, atomicity, rollback/fault injection | TBD |
| AC-10 | Architecture/authority/scope regression | TBD |

## Required design decisions to close before merge

1. Canonical fixture contribution/opportunity and deterministic anchors.
2. Exact sanctioned lifecycle path and legal transition sequence.
3. Exact evidence/Proof-of-Value path and authoritative inputs required by downstream outcome/reputation/settlement logic.
4. Exact normalized outcome measurement provider/fixture and uncertainty representation.
5. Exact reputation mutation trigger and non-purchasability guard used by the scenario.
6. Exact verified-value → settlement pending/mature path and risk/dispute gates exercised.
7. Exact W028 benefit funding/allocation path and how the source lineage is reconstructed without duplicating economics.
8. The cross-boundary transaction boundaries that must remain atomic, including the selected injected-failure point.
9. The concurrency/replay probes and expected no-double-application invariants.
10. The durable lineage/audit reconstruction contract and privacy/tenant assertions.

All decisions must reuse existing contracts. Missing semantics discovered during implementation are architectural/work-item gaps, not implicit W033 inventions.

## Verification record

| Gate | Result |
|---|---|
| `bun run typecheck` | TBD |
| `bun run arch:check` | TBD |
| `bun run authority:check` | TBD |
| `bun run verify` | TBD |
| Targeted mutation driver | TBD |
| Secret scan | TBD |
| Real PostgreSQL + Redis integration | TBD |
| Real W033 end-to-end round-trip | TBD |
| CI push event | TBD |
| CI pull_request event | TBD |

## Implementation evidence

Implementation PR: TBD  
Reviewed head: TBD  
Architect review: TBD  
Merge SHA: TBD

## Scope guard

W033 must not introduce W034 advertising lifecycle, W035 creator lifecycle, W036 demand/procurement lifecycle, a new domain, a second ledger, new crypto, a second workflow engine, or new authority semantics.
