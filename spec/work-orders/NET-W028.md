# NET-W028 — Benefit Pools

**Status:** ACTIVE / READY_FOR_IMPLEMENTATION  
**Architecture:** v1.0 FROZEN  
**GitHub Issue:** #56  
**Dependencies:** NET-W027, NET-W008 — merged/verified  
**Authority:** existing `/benefits` boundary; `/settlement` remains sole economic authority

## 1. Objective

Establish Benefit Pools that can receive already-authoritative verified value and distribute benefits to eligible members through deterministic, privacy-preserving, auditable allocation semantics. W028 must not create a second economic ledger or redefine upstream truth.

## 2. Authority placement

```text
verified upstream value / realized savings
              ↓ neutral reference
        /benefits pool semantics
              ↓
 deterministic eligibility + allocation policy
              ↓
 allocation lineage / execution request
              ↓
 /settlement — sole economic posting authority
```

`/evidence` and `/outcomes` remain truth/measurement authorities. `/demand` remains procurement authority. `/reputation` and `/disputes` are consumed only through neutral lookups as authorized by the final implementation contract.

## 3. Required semantics

### 3.1 Pool records
Tenant-scoped durable Benefit Pool records contain an explicit funding reference set, policy lineage, eligibility criteria, privacy rules and audit lineage. The pool never accepts a caller-asserted authoritative funded balance.

### 3.2 Funding
Every funding reference resolves to an authoritative existing value/result. Unsupported, stale, revoked, disputed or otherwise unqualified value must fail closed. W027 savings are consumed as verified/derived facts, not recalculated by W028.

### 3.3 Allocation policy
Allocation policies are explicit, versioned and immutable once referenced by an allocation lineage. Policy identity must use the established organization-independent lineage serialization where cross-tenant forks are possible.

### 3.4 Eligibility
Member eligibility and weights are server-derived from authoritative participant inputs and the policy. Caller-supplied eligibility, weight, balance or allocation assertions are never authority.

### 3.5 Conservation
No allocation can exceed authoritative available funding. Allocation arithmetic must be deterministic using exact/scaled integer quantities where appropriate. Remainders must be explicitly represented and conserved rather than lost through floating-point rounding.

### 3.6 Privacy
Pool and member views expose only policy-authorized information. Protected procurement commitments, exact competitor terms and unnecessary member identity must not cross normal surfaces.

### 3.7 Current-state authorization
Before a material economic effect, current funding availability and current eligibility/capacity are re-derived inside the authoritative transaction. A stale pool snapshot cannot authorize new value movement.

### 3.8 Atomicity and audit
Material commands use composite idempotency, concurrency serialization, one authoritative transaction and transactional audit buffering with post-commit publication. Coupled settlement work uses existing `...WithinTx` primitives rather than independently committing commands.

## 4. Settlement boundary

W028 may orchestrate settlement but must not create new balances, account kinds, credits, cash obligations, rewards, payment instructions or a parallel ledger. Existing `/settlement` posting/value primitives remain authoritative.

## 5. Lifecycle

Do not introduce local workflow machinery. Pool state transitions, if the final implementation requires lifecycle state, must use the existing `/workflows` authority and any sanctioned transition path already authorized by the frozen architecture.

## 6. Acceptance/evidence requirements

Produce one-to-one acceptance coverage for BEN-001..004 plus architecture/out-of-scope regression coverage. Required evidence includes funding-authority proof, conservation and deterministic remainder cases, versioned-policy lineage, privacy/tenancy/authorization, idempotency/concurrency/atomicity, fault injection, settlement-authority containment, mutation checks, `bun run verify`, architecture/authority checks, secret scan and configured real PostgreSQL/Redis integration.

## 7. Explicit non-goals

No new economic primitives; no external payment execution; no decentralized validation or portable reputation proofs; no W029+ behavior; no W033–W036 end-to-end flows; no AI authority.

## 8. Decision of record

W028 extends the existing frozen `/benefits` boundary. It is an economic allocation orchestrator, not a second economic authority. The implementation must be judged primarily on conservation, source authority, privacy, deterministic allocation, and transaction atomicity.
