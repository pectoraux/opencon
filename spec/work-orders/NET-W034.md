# NET-W034 — Complete advertising lifecycle

**Status:** ACTIVE / READY_FOR_IMPLEMENTATION  
**Architecture:** v1.0 FROZEN  
**GitHub Issue:** #69  
**Dependencies:** NET-W020, NET-W021, NET-W022, NET-W023, NET-W033 — merged/verified  
**Authority:** Existing domain authorities only; W034 is an end-to-end advertising composition/proof milestone, not a new authority.

## 1. Objective

Prove one canonical advertising execution can traverse the existing OpenCon advertising stack end-to-end without introducing a new advertising authority:

```text
advertiser / campaign
  → inventory / creator supply
  → measurement
  → evidence / Proof-of-Value
  → applicable risk / privacy / disclosure gates
  → settlement
```

The scenario must use the existing campaign, inventory, matching, measurement, evidence, outcome, workflow, dispute/risk and settlement authorities. The end-to-end proof must establish the executable order explicitly; a terminal settlement state alone is insufficient.

## 2. Authority placement

```text
/ campaigns        ← campaign policy/configuration + matching selection
      ↓
/ inventory        ← supply ownership, placement, source context, readiness
      ↓
/ adapters         ← provider-specific advertising/supply interoperability
/ measurement      ← provider integration facts only
      ↓
/ outcomes         ← normalized measurement semantics
      ↓
/ evidence         ← provenance / commitments / Proof-of-Value
      ↓
/ workflows        ← sole opportunity/contribution lifecycle authority
      ↓
/ disputes         ← applicable risk/dispute controls
      ↓
/ settlement       ← sole economic authority
```

The composition root may connect these authorities through declared neutral ports and existing sanctioned composites. It may not recreate campaign policy, supply authorization, measurement semantics, evidence verification, workflow state, risk authority or economics.

`/reputation` may be observed or updated only through an existing sanctioned path when the selected settlement flow requires it; reputation is not an advertising authority.

## 3. Canonical executable scenario

The implementation MUST declare and prove one deterministic stage sequence. The exact fixture may reuse existing W033 harness machinery, but the advertising-specific stages must be visible in the traversal witness.

The preferred executable order is:

1. **Advertiser/campaign setup** — resolve one organization-scoped advertiser owner, an ACTIVE campaign and one pinned policy version whose objective, outcome policy, evidence policy and clearing rule are sufficient for the scenario.
2. **Supply authorization/provenance** — resolve one eligible W019 inventory item (publisher/app/creator surface) and prove its W019 source context / settlement-readiness prerequisites. When exercising W023, normalize a provider request/supply-chain fact through `/adapters` and resolve the external source to exactly one existing inventory item; external facts must never create ownership or readiness.
3. **Campaign matching** — execute the existing W021 matching path against the eligible supply. Hard policy/supply/risk gates must execute before ranking/advisory logic. AI remains advisory only and may not authorize the path.
4. **Placement composition** — create the placement through the W019 authority for the selected supply/campaign pair. No direct repository mutation is permitted. A retired/withdrawn/ineligible source must fail closed.
5. **Advertising opportunity/contribution lifecycle entry** — materialize the campaign opportunity through the existing W011 composition path, then create/submit the canonical contribution/execution subject through the sanctioned `/workflows` path. No W034 lifecycle machine may be introduced.
6. **Measurement point** — advance the lifecycle to the existing MEASURING point before measurement/evidence stages. The scenario MUST prove this ordering with authoritative workflow state/version witnesses and not merely by local array order.
7. **Measurement ingestion** — route one deterministic native/provider attribution or delivery report through the W022 `/measurement` adapter path into `/outcomes`. Raw provider payload remains opaque and is not persisted by default. The normalized observation retains provenance, attribution mode and uncertainty.
8. **Evidence / Proof-of-Value** — create or resolve the authoritative evidence and Proof-of-Value using existing `/evidence` contracts over the measured advertising result. Any grade, confidence or value used downstream must be derived/verified by `/evidence`; caller assertions cannot authorize settlement.
9. **Workflow completion/evaluation** — satisfy the existing outcome/evidence requirements and complete the contribution/execution lifecycle through `/workflows`. If the frozen path requires an evidence reference on a transition, that transition must occur only after the required evidence/measurement state exists.
10. **Risk/dispute controls** — before economic maturation/consumption, exercise the existing applicable `/disputes` risk/dispute gates at least once in a fail-closed fixture, then resolve the hold/challenge and demonstrate the authoritative path re-opens. Do not add advertising-specific risk state.
11. **Settlement** — recognize verified value using the existing W014 settlement composition, mature only after all existing evidence/workflow/risk/dispute gates pass, and execute the declared campaign clearing rule through `/settlement`. The economic ledger, value records and postings remain settlement-owned.
12. **Lineage** — reconstruct the final result backward across durable identifiers and verify transactional audit lineage, organization scope, idempotency, and the declared traversal order.

### 3.1 Deterministic fixture requirements

- Use fixed evaluation/reference anchors wherever the existing authorities accept them. Do not make verification depend on repeated `Date.now()` calls.
- Use one advertiser organization and explicit actor identities. Cross-tenant references must resolve fail closed.
- The campaign policy version must be pinned explicitly in the scenario.
- The supply item, placement, measurement subject, evidence, Proof-of-Value, opportunity/contribution, value record and settlement result each need durable identifiers.
- Replays must operate against the same deterministic request identities and return the original authoritative records.

### 3.2 Provider path requirements

At least one scenario path must cross the existing real provider-selection stack used by the repository for advertising measurement/supply integration. Provider-specific vocabulary may appear only inside `/adapters` and the neutral measurement/inventory contracts.

A test-only fake may be used for adversarial unit coverage, but the required end-to-end round-trip must exercise the repository's real adapter/authority selection path with configured PostgreSQL/Redis infrastructure. No production advertising credentials may be committed.

### 3.3 Creator-supply boundary

Creator inventory may be used as the supply surface (`surfaceKind = "creator"`) because W019/W021 unify publisher/app/creator supply. W034 MUST NOT implement creator contracts, UGC production, disclosure workflows or creator payment semantics belonging to W035. Existing W018 disclosure/evidence behavior may be observed only where the selected advertising fixture already depends on it.

## 4. Required invariants

1. **Campaign authority:** campaign status, policy version, objective, outcome/evidence policy and clearing policy remain `/campaigns` owned.
2. **Supply authority:** inventory ownership, placement context and settlement-readiness remain `/inventory` owned; W023 facts cannot self-authorize supply.
3. **Matching is selection, not authority:** W021 hard gates precede ranking; AI advisory output remains bounded/non-authoritative.
4. **Measurement authority:** provider reports are normalized in `/measurement`; semantic outcome state is owned by `/outcomes`; provider attribution is provenance, not protocol truth.
5. **Evidence authority:** PoV and evidence grades/confidence/provenance are derived/verified by `/evidence`; raw measurement claims cannot mint economic value.
6. **Lifecycle authority:** all opportunity/contribution transitions use `/workflows`; no second advertising lifecycle state machine exists.
7. **Risk/dispute authority:** existing `/disputes` controls gate applicable economic maturation/consumption; advertising code cannot waive them.
8. **Economic authority:** all pending/mature/consumed value, reward allocation, credits and cash obligations remain `/settlement` owned; no advertising ledger exists.
9. **Idempotency and concurrency:** every material composed mutation is replay-safe; at least one concurrent race proves exactly-once behavior at the economic boundary.
10. **Atomicity:** at least one fault injection at a critical material join proves no partial authoritative final state survives a failed commit/path.
11. **Privacy:** raw vendor payloads, secrets and unnecessary personal/device identifiers do not escape their approved boundary; audit/log/error surfaces contain no secret or raw sensitive vendor values.
12. **Tenancy:** scope is re-checked at authoritative boundaries; foreign identifiers resolve fail closed without existence oracles.
13. **Audit lineage:** material mutations carry execution/correlation/idempotency/transaction lineage; audit records publish post-commit and never fabricate uncommitted state.
14. **Traversal proof:** the test records authoritative stage witnesses and proves the declared order, including MEASURING before measurement/evidence and workflow completion before settlement.
15. **Frozen architecture:** `spec/architecture.md` and `spec/architecture-lock.md` remain byte-identical; no new domain, authority, economic primitive, workflow engine, crypto primitive, provider-neutral advertising truth store or AI authority is introduced.

## 5. Acceptance criteria

### AC-01 — Advertiser/campaign authority

A deterministic advertiser fixture resolves one ACTIVE campaign and one explicit policy version containing the objective, measurement/evidence requirements and clearing rule used by the scenario. Cross-tenant/unauthorized access fails closed. Campaign state is mutated only through `/campaigns`.

**Required evidence:** campaign/policy durable ids, scope checks, policy-version pin, owner authorization, audit lineage, negative authorization/tenant fixtures.

### AC-02 — Supply provenance and inventory authority

A W019 inventory item is resolved as the sole eligible supply source for the scenario. Where W023 is exercised, normalized external supply-chain facts resolve to exactly one inventory record and ambiguous/cross-tenant/stale/unchecked facts cannot self-authorize ownership or settlement readiness.

**Required evidence:** W019 settlement-readiness result, W023 normalized provenance fact, exact-one resolution witness, withdrawn/retired/invalid negative fixture, no direct inventory repository writes.

### AC-03 — Matching/selection integrity

The existing W021 matching path selects only candidates that pass hard campaign, policy, supply and risk gates. Ranking remains deterministic after hard gates, and any AI advisory is bounded, recorded and demonstrably non-authoritative.

**Required evidence:** at least one excluded candidate, eligible-candidate result, deterministic ranking witness/digest, advisory boundary proof, no placement/economic mutation performed by matching.

### AC-04 — Placement and executable lifecycle entry

The selected supply produces a durable placement through `/inventory`, and the advertising opportunity/execution enters the canonical opportunity/contribution lifecycle through existing sanctioned W011/W004/W033 composition paths. Direct workflow or repository mutation attempts fail closed.

**Required evidence:** placement id/source context, lifecycle transition audit, authority structural pins, no second lifecycle implementation.

### AC-05 — Measurement normalization and privacy

The advertising execution reaches the authoritative MEASURING point before measurement is accepted. A provider/native measurement report traverses the existing `/measurement` adapter boundary into `/outcomes`, preserving provenance, attribution semantics and uncertainty while keeping raw payloads/secrets outside normalized/audit/log surfaces.

**Required evidence:** workflow state/version witness showing MEASURING first, adapter/provider identity, normalized observation, provenance/evidence link, deterministic report fixture, privacy/leak regression.

### AC-06 — Evidence / Proof-of-Value authority

The measurement result becomes settlement-eligible only through authoritative `/evidence` Proof-of-Value/evidence verification semantics. Caller-supplied grade, confidence or economic value cannot bypass the evidence authority. The declared evidence requirements of the campaign policy are satisfied before the lifecycle's evidence-gated transition.

**Required evidence:** evidence ids, PoV id/state/grade lineage, verification/attestation witnesses, caller-assertion negative fixture, evidence-to-measurement reconstruction.

### AC-07 — Workflow completion, risk and dispute controls

After measurement/evidence exist, the canonical lifecycle completes through `/workflows`. At least one applicable risk/dispute control blocks maturation or consumption, then after sanctioned resolution the same authoritative path succeeds. No advertising-specific risk/dispute authority exists.

**Required evidence:** ordered lifecycle transition witnesses, risk HOLD refusal, ACTIVE dispute refusal, resolution/re-open proof, final lifecycle state/version.

### AC-08 — Verified value and settlement

Only after the workflow/evidence/evaluation gates pass does verified advertising value enter `/settlement` pending state, mature after applicable controls, and execute the campaign's declared clearing rule through the existing settlement primitives. No second advertising ledger or direct adapter/domain economic write exists.

**Required evidence:** value-record lineage, pending→mature→consumed or sanctioned clearing result, settlement ledger conservation, clearing-policy reference, audit/transaction lineage, structural no-economic-bypass pin.

### AC-09 — Replay, concurrency, atomicity and tenancy

Same-key replays return identical committed records without duplicates; at least one concurrent race proves exactly-once economic behavior; a fault-injected critical join leaves no partial final state; cross-tenant references fail closed across composed boundaries.

**Required evidence:** replay ids/created flags, concurrent winner count, fault-injection database/audit assertions, tenant matrix, authoritative PostgreSQL evidence.

### AC-10 — End-to-end traversal, architecture and regression safety

The full advertising chain is reconstructable from durable ids and audit events in the declared executable order. `bun run verify`, `arch:check`, `authority:check`, secret scanning, configured real PostgreSQL/Redis integration and the real-provider end-to-end round-trip are green. Frozen architecture files remain unchanged and W035/W036 behavior is absent.

**Required evidence:** exact traversal witness list, ordered audit witness, full verification counts, mutation results with byte-identical source restoration, CI push + pull_request green, frozen-file hash/byte check, changed-file inventory and out-of-scope scan.

## 6. Required test/evidence shape

The implementation PR must contain composition/proof tests, not a new advertising subsystem. Use one-to-one suites for AC-01..AC-10 plus a shared advertising harness and a deterministic full-path traversal test.

At minimum the tests must cover:

- campaign policy/version and advertiser authorization;
- inventory settlement-readiness, exact-one supply resolution and placement provenance;
- W021 hard-gate exclusion and bounded AI advisory non-authority;
- W023 adapter normalization and supply-chain containment where exercised;
- W022 provider report normalization, privacy and deterministic integrity;
- workflow ordering with authoritative state/version witnesses;
- evidence/PoV verification and caller-assertion rejection;
- risk/dispute maturation gates;
- settlement pending/mature/clearing conservation;
- same-key replay and concurrent exactly-once race;
- critical-join fault injection with no partial persistence/audit;
- backward lineage reconstruction and post-commit audit order;
- cross-tenant/unauthorized fail-closed behavior;
- targeted mutation checks that remove each material guard and prove the corresponding suite fails;
- structural no-new-authority/no-second-ledger/no-provider-leak/no-W035-W036 behavior pins.

## 7. Required verification gate

```text
AC-01..AC-10 satisfied
+ architecture + authority checks clean
+ targeted mutations caught and sources restored byte-identically
+ bun run verify green
+ configured real PostgreSQL/Redis integration green
+ real-provider end-to-end advertising round-trip green
+ CI push green
+ CI pull_request green
+ exactly one implementation PR
+ architect approval recorded
→ merge
```

Green CI alone is never sufficient for merge.

## 8. Explicit non-goals

- no new advertising domain or authority;
- no new workflow state machine or lifecycle vocabulary;
- no second inventory/supply authority;
- no measurement semantics outside `/outcomes`;
- no evidence/PoV semantics outside `/evidence`;
- no settlement/economic semantics outside `/settlement`;
- no direct external payment execution;
- no campaign-policy redesign beyond the fixture needed for proof;
- no creator contract/UGC/disclosure/payment lifecycle (NET-W035);
- no demand/procurement/benefit lifecycle changes (NET-W036);
- no new decentralized consensus or portable-proof behavior;
- no raw advertising payload store;
- no provider SDK vocabulary crossing into core/domain boundaries;
- no production provider credentials committed;
- no architecture-file amendment.

## 9. Decision of record

W034 is a proof milestone. The implementation should be predominantly integration/composition tests plus any strictly necessary composition-root test harness wiring. The success condition is a single reproducible advertising execution whose authoritative path is visible from advertiser/campaign through supply, measurement, evidence/PoV, risk controls and settlement, with no bypass, duplicated authority, privacy leakage, non-atomic economic mutation or traversal ambiguity.
