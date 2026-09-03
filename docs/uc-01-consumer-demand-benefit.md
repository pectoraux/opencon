# UC-01 Evidence Contract — Consumer demand to member benefit validation

**Status:** GOVERNANCE / FROZEN — implementation not yet started
**Issue:** #85
**Work order:** `spec/work-orders/UC-01.md`
**Architecture:** v1.0 FROZEN

## 1. Decision record

UC-01 is the first post-backlog validation use case selected after review of the completed W001–W036 protocol evidence and UX-01 product evidence.

The selection prioritizes consumer-side product realism and failure-path richness while avoiding unnecessary duplication of W033–W036. UC-01 exercises the existing `/demand`, `/workflows`, `/measurement`, `/outcomes`, `/evidence` and `/benefits` authorities. It does not authorize a new protocol authority, W037 behavior, dependency edge, architecture version, payment authority or second ledger.

## 2. Selection rationale

The canonical W036 evidence already demonstrates a 17-stage demand/procurement/benefit traversal with 44 durable audit markers, real PostgreSQL/Redis, a real provider round-trip and 17/17 targeted mutations caught. UC-01 therefore focuses on a different business-side perspective: consumers form the demand, the supplier side sees only the privacy-safe qualified aggregate, fulfillment produces measured savings, and the resulting benefit is consumed as an entitlement by an individual member.

UX-01 additionally established the browser/client truth boundary and documented that production product/API read models remain a separate capability surface. UC-01 therefore tests the protocol journey first and treats any missing API/product exposure as an explicit gap rather than a client-side workaround.

## 3. Evidence matrix

| Criterion | Primary evidence expected |
|---|---|
| UC-01-AC-01 | pool/commitment records, server actor resolution, frozen vocabularies, qualification derivation, tenancy negatives |
| UC-01-AC-02 | aggregate decision checks/digest, privacy floor threshold cases, suppressed-group proofs, leak scan |
| UC-01-AC-03 | supplier offers, hard eligibility result set, deterministic selection record/digest, ineligible candidate negative |
| UC-01-AC-04 | lifecycle record/state/version sequence from `/workflows`, direct-write/bypass negative |
| UC-01-AC-05 | provider round-trip, normalized `/outcomes` observation, provenance/uncertainty, W027 savings checks and supporting evidence |
| UC-01-AC-06 | W028 `verified_savings` funding reference, current funding/eligibility derivation, deterministic allocation, conservation proof |
| UC-01-AC-07 | member-view privacy proof showing only caller's own allocation facts |
| UC-01-AC-08 | canonical ordered witnesses plus durable audit ordering and final lineage reconstruction |
| UC-01-AC-09 | authorization/tenancy/replay/concurrency/atomicity/privacy/secret tests; mutation results; rollback + healthy same-key retry |
| UC-01-AC-10 | architecture/authority checks, frozen-file byte comparison, changed-file inventory, capability-gap record |

## 4. Required negative evidence

At minimum, the implementation must attempt and fail closed on:

- below-floor consumer demand;
- non-member/foreign-tenant aggregate access;
- forged consumer actor or nominated consumer id;
- ineligible/revoked supplier before ranking;
- stale/invalid provider measurement or ambiguous provider mapping where applicable;
- unsupported, stale, invalid or insufficient savings evidence;
- benefit allocation using a caller-supplied amount as authoritative funding;
- member viewing another member's allocation;
- replay and concurrent duplicate mutation;
- transaction commit failure after material work has been staged;
- direct lifecycle mutation outside `/workflows`;
- provider-specific payload leakage into core/domain records;
- client/product attempts to manufacture authoritative state.

## 5. Durable traversal proof

The final implementation evidence must prove this exact sequence without relying on a local array as the sole ordering witness:

```text
DemandPool
→ active commitments
→ qualified aggregate
→ supplier offers
→ hard eligibility
→ selection
→ fulfillment subject
→ workflow state/version traversal
→ provider measurement
→ normalized outcome
→ supported baseline/counterfactual
→ savings decision / evidence
→ savings-funded benefit pool
→ entitlement allocation
→ member own-share view
```

Every material persisted stage must carry its authoritative record identity and, where applicable, the owning authority's state/version. Durable audit ordering must corroborate committed mutation sequence.

## 6. Atomicity contract

The critical composite allocation path must include a real transaction-level fault after material work has been staged. The evidence must show:

```text
COMMIT failure
→ allocation absent
→ audit absent
→ idempotency state absent/incomplete as appropriate
→ no partial economic mutation
→ healthy same-key retry
→ exactly one committed allocation
```

A stale-state rejection or a pre-transaction validation failure is not an atomicity proof.

## 7. Determinism contract

Canonical proof fixtures must use fixed anchors or authoritative subject timestamps. No unconstrained `Date.now()`, fresh random UUIDs or equivalent nondeterminism may enter the canonical proof path unless the exact behavior being validated is provider freshness or another explicitly real-time property.

## 8. Provider contract

The implementation must exercise one real provider-backed measurement path where the existing repository capability supports it. Test doubles may be used for adversarial or fault-injection tests but do not substitute for the required real provider round-trip.

Raw provider payloads, SDK types and provider-specific vocabulary must remain behind the existing integration boundary.

## 9. Mutation contract

High-risk guards are to be mutation-tested so that every targeted mutation produces a behavioral difference, is caught by the corresponding regression, and is restored byte-identically. The final evidence should include the source hashes before/after restoration and the clean-suite result after restoration.

## 10. Capability-gap register

The implementation must maintain an explicit register with this disposition model:

| Gap class | Required disposition |
|---|---|
| Existing behavior defect | repair at the owning authority; regression + mutation evidence |
| API/product exposure gap | stop at `/api`; create separate governed work item |
| Provider integration gap | stop at the integration boundary; create separate governed work item |
| Frozen architecture conflict | Architecture Change Request + new architecture version |
| Unsupported redemption/cash/credit behavior | exclude from UC-01 unless already supported by frozen authority |

No gap may be silently converted into a new subsystem inside UC-01.

## 11. Exit gate

UC-01 is complete only when the frozen work order is satisfied, required provider and real-infrastructure proofs are green, architecture/authority/secret checks are clean, mutation sources are byte-identical after restoration, exact-head CI is green, and the architect records APPROVED on the single implementation PR.

Until then, this record is a frozen evidence contract, not evidence of implementation completion.
