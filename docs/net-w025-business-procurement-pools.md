# NET-W025 — Business procurement pools

**Status:** IN IMPLEMENTATION on `feat/net-w025-business-procurement-pools`
**GitHub issue:** #50
**Work order:** `spec/work-orders/NET-W025.md`
**Architecture:** v1.0 FROZEN
**Dependencies:** NET-W024 + NET-W008 merged

## Purpose

This document is the durable evidence ledger for NET-W025. It allows an architect or reviewer with no conversation history to verify — from the repository alone — that business procurement pools are implemented INSIDE the frozen `/demand` boundary (no second demand/procurement authority) on the W024 privacy foundations, with explicit buyer-organization/actor authorization, competition-policy-governed deterministic aggregation behind the frozen commitment floor AND the frozen distinct-organization floor, minimized supplier-facing disclosure (bands/buckets/windows only — never exact quantities, unit prices, budgets or timing), tenant isolation, idempotency/concurrency/atomicity conventions, and zero economic-authority surface.

## Architectural decision record

NET-W025 introduces NO second authority. The authority split of record:

- **`/demand` owns** the procurement POOL records (tenant-scoped, versioned procurement category + qualification/competition policy, one-way closure), the private business COMMITMENT records (buyer-organization references + bounded provider-neutral attributes + server-written `aggregate_disclosure` consent grants + one-way withdrawal), the closed versioned procurement vocabularies (`src/core/procurement.ts`), the pure privacy/competition-policy aggregation engine, and the derived supplier-facing minimized demand contract. `/demand` remains the single demand/aggregate semantic authority established by NET-W024 — W025 EXTENDS the boundary, it does not duplicate it.
- **`/settlement` stays the sole economic authority**: there is NO economic mutation surface in `/demand` (no ledger, credits, cash, stakes, rewards, value records). Business commitments mint nothing; supplier offers/selection are NET-W026 and savings are NET-W027.
- **`/identity`, `/organizations`, `/participants` stay the membership/authorization authorities**: commitment authorization resolves server-side through the NEUTRAL membership lookup (the same thin read-only adapter over the /organizations membership repository, wired at the bootstrap root): the acting person must hold ACTIVE membership in BOTH the tenant organization AND the named buyer organization. Client claims never fabricate buyer eligibility, membership or qualification.
- **`/workflows` is untouched**: procurement pools and commitments carry NO lifecycle subject kind; closure and withdrawal are ONE-WAY field mutations (the W019/W024 retirement precedent).
- **No coupling** to `/evidence`, `/outcomes`, `/reputation`, `/disputes`, `/campaigns`, `/inventory`, `/adapters`: qualification cannot be influenced by activity, spend, wealth or reputation — no such input exists.

## Implementation shape (the decision of record, as shipped)

(to be completed as the implementation lands)

## Evidence matrix

| AC | Required evidence | Status |
|---|---|---|
| AC-01 first-class records with provenance + buyer-organization authorization + consent | `tests/demand/net-w025-ac-01-procurement-records.test.ts` | PENDING |
| AC-02 deterministic qualification (dual thresholds) | `tests/demand/net-w025-ac-02-deterministic-qualification.test.ts` | PENDING |
| AC-03 privacy/competition-preserving aggregation | `tests/demand/net-w025-ac-03-privacy-competition.test.ts` | PENDING |
| AC-04 explicit, unassertable thresholds and floors | `tests/demand/net-w025-ac-04-threshold-policy.test.ts` | PENDING |
| AC-05 idempotency, concurrency, conservation | `tests/demand/net-w025-ac-05-idempotency-concurrency.test.ts` | PENDING |
| AC-06 tenancy + dual-membership authorization fail closed | `tests/demand/net-w025-ac-06-tenancy-authorization.test.ts` | PENDING |
| AC-07 atomicity + audit lineage | `tests/demand/net-w025-ac-07-atomicity-audit.test.ts` | PENDING |
| AC-08 architecture / out-of-scope | `tests/regression/net-w025-ac-08-architecture-out-of-scope.test.ts` | PENDING |

## Mutation evidence

(to be completed — six targeted mutations: organization-floor removal, commitment-floor removal, group-suppression removal, buyer-organization membership-gate removal, tenant-scope removal, idempotency randomization)

## Privacy / competition evidence

(to be completed)

## Final verification record

(to be completed)

## Completion rule

Merge only after implementation, acceptance coverage, mutation checks, full verification, green CI, and recorded architect approval. After merge, update `spec/PROJECT-STATE.md` and the roadmap pointers with the merge SHA before advancing to NET-W026.
