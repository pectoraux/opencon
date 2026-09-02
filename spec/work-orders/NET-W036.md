# NET-W036 — Complete demand/procurement/benefit lifecycle

**Status:** ACTIVE / READY_FOR_IMPLEMENTATION  
**Architecture:** v1.0 FROZEN  
**GitHub Issue:** #75  
**Dependencies:** NET-W028, NET-W033 — merged/verified  
**Authority:** Existing domain authorities only; W036 is a Phase-9 end-to-end composition/proof milestone, not a new authority.

## 1. Objective

Prove one deterministic demand/procurement execution traverses the existing OpenCon authorities end-to-end:

```text
demand aggregation
  → supplier offers / competitive selection
  → fulfillment / execution
  → measured outcome
  → supported baseline / counterfactual
  → verified savings / Proof-of-Value
  → settlement
  → benefit funding / allocation
```

The implementation is composition/proof work. It must not create a second demand ledger, procurement lifecycle, savings authority, settlement path or benefit-accounting system.

## 2. Authority placement

```text
/ demand       ← demand pools, offers, supplier eligibility/selection
/ workflows    ← sole lifecycle authority where execution has lifecycle state
/ measurement  ← provider integration facts
/ outcomes     ← normalized outcomes/uncertainty
/ evidence     ← evidence, provenance, baselines/counterfactuals, PoV
/ settlement   ← sole economic authority
/ benefits     ← pool/entitlement/allocation semantics
/ adapters     ← provider-specific integration
```

Composition-root orchestration may connect these authorities only through existing ports and sanctioned composites. Supplier competition stays inside `/demand`; verified savings do not become protocol truth until supported and evidenced; benefit pools consume authoritative funded value rather than recreating economics.

## 3. Canonical executable scenario

1. Resolve one authorized, tenant-scoped demand pool from authoritative commitments.
2. Obtain a privacy-safe qualified demand view. Prove commitment count and distinct buyer-organization count remain separate disclosure dimensions and are gated independently.
3. Collect at least two supplier offers through `/demand`, with one hard-ineligible candidate excluded before ranking/selection.
4. Execute deterministic competitive selection after eligibility. Record the selected supplier and policy/version lineage; matching/selection creates no economic mutation.
5. Enter fulfillment/execution through the existing sanctioned `/workflows` path when lifecycle state applies. No second procurement state machine.
6. Record one deterministic realized outcome through the existing measurement/provider boundary into `/outcomes`, preserving provenance, attribution/measurement semantics and uncertainty.
7. Resolve an existing W027-supported baseline/counterfactual. Exercise at least one unsupported/stale/invalid negative case that fails closed without minting value.
8. Create/verify evidence and Proof-of-Value through `/evidence`, linking demand, supplier, fulfillment, outcome and baseline/counterfactual lineage. Caller/provider/model claims cannot authorize savings.
9. Recognize verified savings/value through existing `/settlement` primitives, then mature only under applicable risk/dispute controls. Economic state remains settlement-owned.
10. Feed the authoritative funded value into existing `/benefits` semantics. Allocation eligibility/weights are deterministic and tenant-scoped; conservation and remainder arithmetic are explicit; benefits never create a parallel ledger.
11. Reconstruct the complete chain from durable identifiers and ordered audit markers, including tenant scope, idempotency, transaction lineage and policy versions.
12. Prove same-key replay, concurrency, and a real commit-failure rollback at a material join leave no partial authoritative state; prove a healthy retry succeeds exactly once.

### 3.1 Determinism

- Use fixed fixture anchors or authoritative subject timestamps; do not depend on repeated `Date.now()` calls in canonical proof paths.
- Use deterministic request/idempotency identities and supplier ordering inputs.
- Pin demand, procurement, measurement, baseline/counterfactual, evidence, settlement and benefit policy versions where the owning authorities expose versioning.
- Use authoritative ids rather than transient database ordering.

### 3.2 Privacy and procurement competition

- Aggregate disclosure must protect buyer-level commitments and commercial terms.
- Commitment count and distinct buyer-organization count are distinct facts and must never be collapsed.
- Supplier hard eligibility precedes deterministic competitive selection.
- Provider/model output is advisory evidence only and cannot override eligibility, disclosure or selection policy.

### 3.3 Savings/counterfactual boundary

- W027 remains the authority for baseline/counterfactual support and verified savings semantics.
- The scenario must use an explicitly supported baseline and observed/counterfactual evidence.
- Invalid, stale or insufficient support fails closed.
- Preserve uncertainty; do not coerce unsupported savings into a deterministic amount.

### 3.4 Benefit boundary

- W028 remains the authority for benefit pools, entitlement and allocation semantics.
- Pool funding is by reference to authoritative value; the benefit layer must not recreate settlement value.
- Allocation must be deterministic, policy/versioned, tenant-scoped and conservative; allocated value cannot exceed authoritative funded value.
- Stale economic snapshots cannot authorize new economic effects.

## 4. Required invariants

1. `/demand` owns demand pools, supplier offers and competitive selection.
2. Aggregate demand disclosure is authorized under the same applicable disclosure gate for all emitted machine-readable aggregates.
3. Hard supplier eligibility executes before deterministic selection.
4. `/workflows` is the only lifecycle authority where lifecycle state exists.
5. Measurement provider facts stay behind `/measurement` and `/adapters`; normalized semantics stay in `/outcomes`.
6. W027 remains authoritative for baseline/counterfactual and verified-savings semantics.
7. `/evidence` owns provenance, verification, confidence and PoV semantics.
8. `/settlement` owns all economic state and postings; no procurement ledger exists.
9. `/benefits` consumes authoritative funded value and does not become a second ledger.
10. Idempotency, concurrency and authoritative transaction boundaries protect every material mutation.
11. Commit failure after material work is staged leaves no value, ledger, audit or idempotency residue; healthy same-key retry succeeds exactly once.
12. Cross-tenant and unauthorized references fail closed without existence oracles.
13. Raw commercial/provider/personal data is not persisted or surfaced outside its approved boundary.
14. AI/model output remains advisory only.
15. Canonical traversal is proven with authoritative state/version witnesses and durable audit order; local array order or a terminal allocation is insufficient.
16. `spec/architecture.md` and `spec/architecture-lock.md` remain byte-identical. No W037 behavior is introduced.

## 5. Acceptance criteria

### AC-01 — Demand pool authority

Resolve a deterministic tenant-scoped qualified demand pool through `/demand`. Unauthorized/cross-tenant access fails closed. Demand commitments remain private and selection/funding is not asserted by callers.

**Evidence:** pool id/policy version, scope checks, qualification witness, negative fixtures, audit lineage.

### AC-02 — Aggregate disclosure privacy

Prove commitment count and distinct buyer-organization count are separate dimensions and are disclosed only under their correct aggregate gate.

**Evidence:** positive gated views, unauthorized/gate-negative fixtures, no competitor-sensitive detail leakage.

### AC-03 — Supplier offers and selection

Collect supplier offers through `/demand`; hard-exclude an ineligible supplier before deterministic competitive selection. Selection is reproducible and creates no settlement mutation.

**Evidence:** offer ids, eligibility witnesses, excluded candidate, deterministic ordering/digest, no-economic-side-effect proof.

### AC-04 — Fulfillment lifecycle

Use existing `/workflows` lifecycle authority for fulfillment/execution where applicable; direct lifecycle/repository mutation and local procurement state machine attempts fail closed.

**Evidence:** authoritative state/version transitions, sanctioned command path, structural regression pin.

### AC-05 — Measurement/outcomes

Record a deterministic realized outcome through `/measurement` → `/outcomes`, preserving provenance and uncertainty and containing provider-specific payloads.

**Evidence:** workflow measurement point, provider/adapter identity, normalized observation, privacy regression, deterministic anchor witness.

### AC-06 — Baseline/counterfactual and savings

Use supported W027 baseline/counterfactual semantics to establish verified savings. Unsupported, stale and invalid support cases fail closed; uncertainty is preserved.

**Evidence:** baseline id/version, observed/counterfactual inputs, verification state, negative fixtures, lineage to outcome.

### AC-07 — Evidence / Proof-of-Value

Create/verify PoV through `/evidence`; caller/provider/model grade, confidence or savings assertions cannot authorize economics.

**Evidence:** evidence/PoV ids, verification/confidence/provenance, policy satisfaction, caller-assertion negative, source lineage.

### AC-08 — Settlement authority

Verified value enters `/settlement` through existing economic primitives only; pending/mature semantics and applicable risk/dispute controls hold; no procurement ledger exists.

**Evidence:** value lineage, transaction/audit ids, conservation, maturation gates, no-bypass regression.

### AC-09 — Benefit funding and allocation

Authoritative funded value is consumed by `/benefits` using deterministic eligibility/allocation policy, conservation and privacy controls. Allocation cannot exceed funded source value and does not recreate savings/economic state.

**Evidence:** pool/funding/allocation lineage, allocation policy version, conservation arithmetic, eligibility/privacy negatives, settlement authority containment.

### AC-10 — Replay, concurrency, atomicity, tenancy and full traversal

Same-key replays return identical records; a concurrent race yields exactly one economic application; a real commit-failing material join leaves no partial value/ledger/audit/idempotency state and a healthy retry succeeds once; cross-tenant references fail closed; authoritative stage/version witnesses and durable audit order prove the declared traversal.

**Evidence:** replay records, concurrency winner counts, real PostgreSQL fault injection, tenant matrix, ordered audit reconstruction, architecture/authority/out-of-scope and mutation regressions, complete local/CI gates.

## 6. Required test/evidence shape

The single W036 implementation PR must be composition/proof tests plus only strictly necessary test-harness wiring. Use one-to-one suites for AC-01..AC-10, a shared deterministic full-path harness and an architecture/out-of-scope regression.

Tests must cover demand privacy, supplier eligibility/selection, sanctioned fulfillment lifecycle, real measurement/provider selection where available, W027 baseline/counterfactual fail-closed behavior, evidence/PoV authority, settlement conservation, benefit allocation conservation/privacy, replay/concurrency, commit-failure rollback, tenancy and durable audit order.

Targeted mutations must remove each material authority/guard and prove the corresponding suite fails, then restore source byte-identically.

## 7. Verification gate

```text
AC-01..AC-10 satisfied
+ typecheck / architecture / authority checks clean
+ mutation suite caught with byte-identical restoration
+ bun run verify green
+ real PostgreSQL/Redis integration green
+ applicable real-provider round-trip green
+ CI push green
+ CI pull_request green
+ exactly one implementation PR
+ architect approval recorded
→ merge
```

Green CI alone is never sufficient.

## 8. Explicit non-goals

- no new domain or authority;
- no second demand/procurement/savings/benefit ledger;
- no new lifecycle machine;
- no new settlement/economic primitive;
- no new W027 savings semantics or W028 benefit semantics;
- no new external payment/settlement behavior;
- no W037 behavior;
- no new decentralized/portable-proof behavior;
- no provider SDK vocabulary crossing into core domains;
- no architecture-file amendment;
- no production provider credentials or raw provider/commercial payload store.

## 9. Decision of record

W036 is the final Phase-9 demand/procurement/benefit composition proof. Implementation must prove the existing stack in executable order rather than add missing semantics. Any missing primitive is a formal architecture/work-item gap, not an implicit W036 invention.
