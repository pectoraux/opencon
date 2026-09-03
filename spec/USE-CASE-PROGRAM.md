# OpenCon Post-Backlog Use-Case Validation Program

**Status:** GOVERNANCE TEMPLATE — NO USE CASE AUTHORIZED BY THIS DOCUMENT ALONE  
**Architecture:** v1.0 FROZEN  
**Protocol backlog:** NET-W001 through NET-W036 COMPLETE  
**First post-backlog product work:** UX-01 COMPLETE

## 1. Purpose

OpenCon's core protocol implementation is complete through NET-W036. Future work should preferentially be driven by realistic, specific business use cases that exercise the capabilities already present across the protocol rather than by speculative feature accumulation.

This document defines the method for selecting, authorizing, implementing and verifying those use cases.

It is a governance framework, not a work item. No implementation may begin solely because a scenario appears in this document.

## 2. Governing principle

A use case is a **validation and capability-composition instrument**.

The objective is to prove that a realistic user/business journey can use multiple existing capabilities together while preserving the frozen architectural authorities. A use case may expose a real defect or product/API gap, but it may not silently create a missing subsystem merely to complete the scenario.

When a scenario encounters a capability gap, the gap must be classified before implementation:

- existing behavior defect → repair the existing owning authority;
- API/product exposure gap → authorize API/product work under the existing boundary;
- external provider gap → separately authorize the relevant adapter/integration;
- frozen-architecture conflict → Architecture Change Request + new architecture version;
- future-scope behavior → leave it out and record the limitation.

## 3. Authorization lifecycle

Every new use-case program follows:

```text
candidate scenarios
  ↓
coverage analysis / ranking
  ↓
architect governance decision
  ↓
frozen use-case brief + acceptance/evidence contract
  ↓
implementation branch
  ↓
verification + evidence
  ↓
exactly one implementation PR
  ↓
architect review
  ├─ CHANGES REQUESTED → same PR/branch → remediate → re-verify
  └─ APPROVED + CI green → merge
  ↓
project-state / roadmap update
  ↓
next authorized scenario
```

The governance decision must explicitly bind the use case to a GitHub issue and freeze its scope before an implementation branch or PR is created.

## 4. Use-case scoring

Rank candidate scenarios before authorization using these dimensions:

| Dimension | Question |
|---|---|
| Authority coverage | How many distinct existing authorities participate meaningfully? |
| Business realism | Does this represent a real customer/participant workflow? |
| Economic depth | Does the path reach verified value, settlement, payment or benefits? |
| Trust depth | Does it exercise authorization, tenancy, replay, concurrency, atomicity, risk or dispute controls? |
| Evidence depth | Can the complete value claim be reconstructed from source facts through outcomes/evidence to economic effect? |
| Interoperability | Does it cross relevant provider/adapter boundaries? |
| Failure richness | Are there meaningful fail-closed paths worth proving? |
| Product relevance | Does the scenario expose a meaningful client/API journey? |

Favor scenarios that cover many high-value capabilities through one coherent business journey. Do not create separate scenarios merely to repeat identical paths.

## 5. Required use-case brief

Before implementation, the architect freezes:

### 5.1 Actors and scope

- participating person/creator/company/advertiser/publisher/app/supplier/community roles;
- tenant ownership for every durable object;
- actor/organization authorization at each material boundary;
- explicit foreign-tenant negative cases.

### 5.2 Business objective

State what the actor is trying to accomplish, what inputs they control, what the platform verifies independently, and what constitutes a successful outcome.

### 5.3 Canonical executable traversal

Declare the exact ordered path through the authorities involved.

The proof must use authoritative state/version witnesses and durable audit commit ordering wherever committed mutations establish sequence. A local list of labels or a terminal success record is not sufficient.

### 5.4 Capability coverage matrix

For every meaningful step, record:

| Step | Existing capability | Owning authority | Evidence of use | Negative guard |
|---|---|---|---|---|
| example | creator matching | `/creators` | match id + candidate set | restricted creator excluded |

The table must identify whether the scenario exercises a capability, observes it, or requires a new capability.

### 5.5 Economic contract

Declare the exact value path and existing primitive(s):

```text
activity/fact
→ evidence/outcome
→ verified value
→ pending
→ mature/finality
→ settlement/payment/benefit effect
```

No activity counter, model output, provider acknowledgement or caller claim may become economic truth by assertion.

### 5.6 Trust and failure contract

Specify required proofs for:

- authorization;
- tenancy and existence-oracle resistance;
- idempotent replay;
- concurrency / exactly-once behavior;
- transaction-level atomicity and rollback;
- risk/dispute blocking and resolution where applicable;
- audit lineage;
- privacy and secret containment;
- deterministic fixtures.

### 5.7 Provider/interoperability contract

Where an applicable external integration exists, define the required real provider-selection path. Provider-specific vocabulary stays behind `/adapters`, `/measurement`, `/payments` or the relevant integration boundary.

Test doubles are acceptable for targeted adversarial tests but do not replace a required real end-to-end provider round-trip.

## 6. Canonical test shape

A high-value use-case implementation should normally contain:

```text
canonical happy-path scenario
    + authoritative traversal witnesses
    + durable audit-order proof
    + one-to-one material acceptance tests
    + authorization + tenant negatives
    + replay proof
    + real concurrent race where economically relevant
    + real transaction-level fault injection for coupled mutations
    + healthy same-key retry after rollback
    + provider-selection round-trip(s)
    + privacy/secret regression
    + targeted mutation coverage
    + repository architecture/authority regression
```

For mutation testing, every mutated guard must produce an actual behavioral difference and every source must be restored byte-identically.

For canonical fixtures, use fixed anchors or authoritative subject timestamps. Fresh wall-clock or random values are permitted only where the behavior being tested explicitly requires provider freshness or another real-time property.

## 7. Capability-gap decision matrix

| Finding | Architect action |
|---|---|
| Bug in an existing authority | Fix in that authority and add regression evidence. |
| Missing product/API read model | Author an explicit API/product work item; never recreate authority in the client. |
| Missing external provider integration | Author the smallest provider-specific adapter/integration work item. |
| Existing primitive cannot legally support required behavior | Treat as a work-item/requirements gap; do not smuggle a new primitive into the scenario. |
| Frozen authority model is insufficient | Stop and issue an Architecture Change Request. |
| Scenario needs W036/procurement/benefit behavior not actually in the selected scope | Exclude it or authorize a separate scenario; do not quietly expand scope. |

## 8. Candidate scenario portfolio

These are candidate families for architect ranking. They are not authorized implementations.

### Creator campaign

Discover/match creator → resolve campaign terms → creator acceptance → UGC/rights → disclosure/compliance → measurement → evidence/PoV → risk/dispute → settlement/payment.

### Advertising campaign

Campaign → eligible supply → placement → delivery/measurement → outcome/evidence → risk/dispute → settlement/clearing.

### Helpfulness contribution

Real need → opportunity discovery → relevant contribution → moderation/helpfulness evidence → outcome → reputation/settlement where qualified.

### Consumer demand and member benefit

Demand commitments → privacy-preserving pool → qualified supplier competition → fulfillment → savings evidence → benefit allocation → member claim.

### Business procurement

Business demand → privacy-preserving qualification → supplier offers → deterministic selection → fulfillment → supported savings/counterfactual → verified value → benefits.

### External settlement reconciliation

Verified internal value → authenticated external provider fact → idempotent ingestion → reconciliation → retry/failure/mismatch handling without changing internal authority.

### Portable reputation

Verified performance history → privacy-preserving portable proof → external presentation → deterministic fail-closed verification without raw private-history transfer.

## 9. Product/client testing relationship

The product client is a consumer of the versioned product API, not a protocol authority.

Use-case work may drive API/product-client requirements, but a client-only workaround is never allowed to replace a missing protocol/API capability. Backend gaps discovered by use-case testing must be recorded and separately authorized under the owning boundary.

The UX-01 evidence record (`docs/ux-01-unified-product-client.md`) is the baseline for browser-level interaction verification and server-side guard presentation.

## 10. Frozen architectural boundaries

The existing authority model remains unchanged:

- `/identity`, `/organizations`, `/participants` — identity and authorization;
- `/opportunities`, `/contributions` — opportunity/contribution subject data;
- `/workflows` — sole lifecycle authority;
- `/evidence` — evidence/provenance/Proof-of-Value;
- `/outcomes` — normalized outcome semantics;
- `/measurement` — measurement integrations;
- `/reputation` — reputation authority;
- `/settlement` — sole economic/ledger/payment-state authority;
- `/disputes` — risk, controls and disputes;
- `/campaigns` — campaign policy;
- `/creators` — creator semantics and records;
- `/inventory` — inventory and placement;
- `/demand` — demand/procurement/supplier-selection/savings;
- `/benefits` — Benefit Pool semantics;
- `/adapters` — provider-specific integrations;
- `/payments` — payment-provider integration facts;
- `/llm` — provider-neutral AI, advisory/evidence input only;
- `/agents` — orchestration mechanisms, never authoritative state.

PostgreSQL remains authoritative application state for v1.0. Redis, queues, caches and worker memory remain non-authoritative.

## 11. Definition of done for a use-case work item

A use-case work item is complete only when:

1. its frozen business scope and acceptance criteria are satisfied;
2. every claimed capability is tied to an authoritative owner;
3. the canonical traversal is proven in executable order;
4. material trust/economic invariants are tested;
5. the required provider round-trip is proven where applicable;
6. architecture/authority/secret checks remain clean;
7. mutations are caught and sources restored byte-identically;
8. full verification and exact-head CI are green;
9. the architect has recorded APPROVED at the reviewed head;
10. project state and roadmap are updated with the merge SHA and any newly learned guardrails.

## 12. Current status

No use case is authorized by this document. The next architect must select and freeze the first post-backlog use case through the governance process before implementation begins.
