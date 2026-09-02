# NET-W032 — Decentralized validation/dispute layer

**Status:** ACTIVE / READY_FOR_IMPLEMENTATION  
**Architecture:** v1.0 FROZEN  
**GitHub Issue:** #65  
**Dependencies:** NET-W010, NET-W029, NET-W030, NET-W031 — merged/verified  
**Requirements:** GOV-001..003  
**Authority:** `/disputes` remains the sole risk/control/dispute authority; W032 coordinates independent validation and challenge without creating a second lifecycle, reputation, evidence, or economic authority.

## 1. Objective

Introduce an auditable decentralized validation/dispute coordination layer in `/disputes`. Independent validator participants may be eligible for assignments, submit observations, challenge claims/proofs, and participate in deterministic quorum/outcome derivation. No validator, challenge, or vote may directly rewrite an authority-owned record. Accepted outcomes must be applied through the owning domain's sanctioned mutation boundary and transaction.

## 2. Authority placement

```text
/disputes authority (W009/W010)
  validator eligibility + challenge/dispute coordination
        ↓ neutral references / existing evidence commitments / W029 integrity
independent validator observations + challenges + quorum derivation
        ↓ accepted outcome
owning authority's explicit mutation API / transaction
        ├─ /workflows : lifecycle state
        ├─ /reputation : reputation state
        ├─ /evidence  : evidence/provenance state
        └─ /settlement: stakes/reserves/penalties/economic effects
```

W032 is a coordination/decision layer, not a replacement authority. `/disputes` owns validator eligibility, challenge/dispute records and outcome derivation; it does not absorb lifecycle, reputation, evidence, or settlement semantics.

## 3. Required semantics

### 3.1 Validator participant model

Represent validators as scoped participants with explicit eligibility state and server-enforced authorization. Eligibility inputs must be deterministic and must include, where applicable, role/authorization, tenant scope, conflict state, prior validator status, and stake requirements. Validator identity must be bound to the authenticated participant; caller-supplied identity claims are not trusted.

### 3.2 Assignment and selection

Validator assignment must be deterministic for an explicit evaluation anchor. Selection must exclude ineligible/conflicted/self-dealing candidates before deterministic ordering. The implementation must define and freeze tie-breaking and assignment cardinality in code/tests; wall clock is forbidden in verification/derivation paths.

### 3.3 Challenge and dispute semantics

Challenges are tenant-scoped records referencing the target claim/proof/resource opaquely. A challenge has an explicit creation/evaluation anchor, a bounded challenge window, terminal resolution semantics, and idempotent creation. Duplicate or concurrent challenges must not create inconsistent terminal outcomes. Challenge state must not be implemented through a second workflow engine; where lifecycle transition semantics are needed, compose the existing `/workflows` authority or represent W032 state as immutable facts + explicit outcome records.

### 3.4 Validator observations

Each validator submits an independently auditable observation/verdict. Observations must be tied to validator identity, assignment, target reference, evaluation anchor, and evidence/attestation references sufficient to explain the decision without exposing private evidence unnecessarily. Validators cannot submit on behalf of another validator and cannot create observations outside their assignment/scope.

### 3.5 Quorum and outcome derivation

Define a deterministic quorum/threshold contract with a closed outcome vocabulary and fail-closed behavior for insufficient participation, invalid observations, conflicting results, expired windows, and ineligible validators. Outcome derivation must be reproducible from recorded inputs at an explicit evaluation anchor and must not depend on mutable ambient state beyond the documented authority reads.

The implementation must make the following explicit before merge:
- minimum validator count / quorum rule;
- whether thresholds are count-, weight-, or stake-based;
- how abstentions and invalid observations are handled;
- tie/conflict resolution;
- duplicate-submission behavior;
- terminal outcome vocabulary;
- whether a revalidation/rechallenge creates a new round rather than mutating a closed round.

These rules must be represented by a versioned policy/contract in `/disputes`, not encoded as undocumented constants.

### 3.6 Conflict-of-interest

At minimum exclude the target subject, target owner/controller, challenge initiator, directly interested economic beneficiary, and any validator explicitly marked conflicted. Self-dealing and same-interest assignments must fail closed before assignment/observation acceptance. Cross-tenant candidates are not eligible unless an explicit, scoped protocol rule permits them; no default cross-tenant leakage is allowed.

### 3.7 Integrity and privacy

Reuse W029 cryptographic attestations/commitments where integrity proofs are required; do not add a new crypto primitive or key-material class. W031 portable proofs may be challenged/validated, but their private source history remains private. Validation records should reference evidence/commitments opaquely and disclose only the minimum aggregate facts necessary for the dispute.

### 3.8 Application of accepted outcomes

A validator quorum result is a recommendation/decision produced by `/disputes`; it is not itself the authoritative mutation. Applying an accepted outcome must call the owning authority's existing sanctioned mutation primitive inside the owning authority's transaction boundary. There must be explicit negative tests showing that a validator cannot directly write a workflow/reputation/evidence/settlement record.

Economic consequences (stake lock, reserve, penalty, refund, or slash) must be executed only through `/settlement` and remain subject to settlement's authority and atomicity rules. W032 must not maintain a second balance or reserve ledger.

### 3.9 Idempotency, concurrency and audit

Material W032 mutations require composite idempotency keys, stable lock ordering, authoritative transactions, transactional audit and rollback-safe fault injection. Concurrent assignment, challenge, observation and resolution must converge deterministically. Failed authority application must not leave a W032 outcome claiming success.

## 4. State and lifecycle boundaries

- `/workflows` remains the lifecycle authority.
- `/disputes` owns W032 validator/challenge/dispute coordination state and outcome records.
- `/reputation`, `/evidence`, and `/settlement` remain authoritative for their own mutations.
- No generic workflow bypass may be introduced.
- Closed dispute rounds are immutable; revalidation/rechallenge produces a new round/record rather than rewriting history.

## 5. AI boundary

AI may assist with non-authoritative triage or evidence summarization only. AI output may never establish validator eligibility, resolve a dispute, set quorum, determine stake effects, select an authority mutation, or override deterministic rules.

## 6. API and tenancy

All W032 routes are deny-by-default and tenant-scoped with explicit guard actions. Cross-tenant and nonexistent identifiers must be indistinguishable where ownership would otherwise be disclosed. Validator operations must bind authenticated identity to the persisted validator participant. Presentation/read surfaces must not become hidden state mutation paths.

## 7. Out of scope

- No new domain boundary; W032 lives in `/disputes`.
- No second workflow/lifecycle engine.
- No second reputation/evidence/economic authority.
- No new cryptographic primitive or key-material class.
- No token economics.
- No decentralized consensus/network protocol beyond deterministic multi-validator coordination inside `/disputes`.
- No W033+ end-to-end flows.
- No silent external authority assumptions.
- `spec/architecture.md` and `spec/architecture-lock.md` remain byte-identical.

## 8. Required acceptance evidence

One-to-one AC coverage for GOV-001..003, including at least:

- validator eligibility/identity/scope tests;
- deterministic assignment selection and tie-breaking tests;
- conflict-of-interest/self-dealing exclusions;
- challenge-window/terminal-round tests;
- independent observation authorization and duplicate/concurrency tests;
- deterministic quorum/outcome fixtures including insufficient/conflicting input;
- privacy/opaque-lineage tests;
- W029 integrity composition tests where used;
- proof that validators cannot directly mutate owning authority records;
- settlement-only economic consequences tests where stakes/penalties are used;
- authorization/tenant isolation tests;
- idempotency, transaction atomicity, audit ordering, rollback and fault injection;
- targeted mutation checks for each material guard;
- `bun run verify`, `arch:check`, `authority:check`, secret scan;
- configured real PostgreSQL/Redis integration;
- exact evidence ledger with test counts and CI runs.

## 9. Decision of record

W032 is decentralized **validation/dispute coordination inside `/disputes`**. Validators produce independent observations and challenges; deterministic quorum/outcome logic derives an accepted result; only the owning authority may apply the result. `/settlement` remains sole economic authority, `/workflows` sole lifecycle authority, `/reputation` sole reputation authority, `/evidence` sole provenance authority, and W029 remains the integrity primitive. A validator can influence a decision only through the explicit protocol rules; it cannot unilaterally mutate authoritative state.
