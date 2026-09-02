# NET-W035 — Complete creator lifecycle

**Status:** ACTIVE / READY_FOR_IMPLEMENTATION  
**Architecture:** v1.0 FROZEN  
**GitHub Issue:** #71  
**Dependencies:** NET-W018, NET-W034 — merged/verified  
**Authority:** Existing domain authorities only; W035 is an end-to-end creator composition/proof milestone, not a new authority.

## 1. Objective

Prove one canonical creator execution can traverse the existing OpenCon creator-partnership stack end-to-end without introducing a creator-specific economic or lifecycle authority:

```text
creator discovery / matching
  → campaign contract / terms
  → UGC production / rights
  → sanctioned publication / disclosure compliance
  → measurement
  → evidence / Proof-of-Value
  → applicable risk / dispute controls
  → settlement / payment
```

The scenario must use the existing creator, campaign, opportunity/contribution, UGC/rights, disclosure, workflow, measurement/outcome, evidence, dispute/risk, settlement and external-payment authorities. The proof must establish executable order with authoritative state/version and durable audit witnesses; a terminal payment/settlement state alone is insufficient.

## 2. Authority placement

```text
/ creators         ← creator identity, creator records, matching inputs
      ↓
/ campaigns        ← campaign policy, terms, objectives, evidence/measurement/clearing policy
      ↓
/ contributions    ← contribution subject data where already owned
      ↓
/ workflows        ← sole opportunity/contribution lifecycle authority
      ↓
/ evidence         ← UGC/rights/disclosure evidence provenance + Proof-of-Value semantics
/ outcomes         ← normalized measurement semantics
/ measurement      ← provider integration facts only
      ↓
/ disputes         ← applicable risk/dispute controls
      ↓
/ settlement       ← sole economic/payment authority
/ payments         ← external payment provider integration only
/ adapters         ← provider-specific interoperability
```

The composition root may connect these authorities through existing neutral ports and sanctioned composites. It may not recreate creator policy, rights truth, disclosure truth, measurement semantics, workflow state, risk authority, economic state or payment authority.

## 3. Canonical executable scenario

The implementation MUST declare and prove one deterministic stage sequence. Existing W017/W018/W033/W034 harness machinery may be reused where valid, but the creator-specific stages must be visible in the traversal witness.

The required order is:

1. **Creator discovery and eligibility** — resolve one tenant-scoped creator through the existing W015 identity/record authority and W016 matching path. Hard creator restrictions, campaign policy and availability/eligibility rules execute before deterministic ranking. Any AI advisory remains bounded and non-authoritative.
2. **Campaign and contract/terms resolution** — resolve one ACTIVE campaign and one pinned campaign policy/terms set containing the creator engagement requirements, compensation/clearing rule, measurement requirements, evidence requirements and disclosure/compliance requirements needed by the scenario. Contract/terms truth must remain in existing `/campaigns` / `/creators` authorities; W035 must not invent a second contract ledger.
3. **Creator acceptance / engagement entry** — enter the existing sanctioned opportunity/contribution path. Creator acceptance must be represented through the existing lifecycle/composition contracts and must not introduce a parallel creator state machine.
4. **UGC production and rights** — exercise the existing W017 UGC/rights authority to create a deterministic UGC artifact/reference and explicit usage-rights terms. The proof must establish that rights are authoritative, scoped and linked to the engagement subject; produced UGC does not imply publication authorization.
5. **Disclosure / compliance gate** — satisfy the existing W018 commercial relationship and disclosure requirements through its sanctioned path. The proof must show that required disclosure/compliance is authoritative and cannot be replaced by a caller-supplied assertion. Publication, where exercised, remains under the existing sanctioned publication authority.
6. **Lifecycle measurement point** — advance the canonical execution subject to the existing MEASURING point before accepting measurement. The authoritative workflow state/version must be witnessed before measurement/evidence stages.
7. **Measurement ingestion** — route one deterministic creator-campaign attribution/delivery observation through the existing `/measurement` provider boundary into `/outcomes`. Provider-specific payloads remain adapter-owned; normalized observations preserve provenance, attribution mode and uncertainty; raw payloads are not persisted or surfaced through audit/log/error paths.
8. **Evidence / Proof-of-Value** — create/resolve authoritative evidence and PoV for the creator execution using existing `/evidence` contracts. Evidence must include the relevant UGC/rights/disclosure/measurement lineage required by campaign policy. Caller-supplied grades, confidence or economic value cannot authorize settlement.
9. **Workflow completion / evaluation** — satisfy all existing outcome, evidence, rights and disclosure requirements and complete the subject through `/workflows`. No W035 lifecycle machine or creator-specific terminal state may substitute for the existing workflow authority.
10. **Risk / dispute controls** — exercise the existing applicable `/disputes` hold/challenge controls in a fail-closed fixture before economic maturation/consumption, then resolve them through the sanctioned authority and demonstrate that the same authoritative economic path re-opens. No creator-specific risk/dispute authority may be added.
11. **Settlement / payment** — recognize verified creator value through existing `/settlement` semantics, mature only after all applicable evidence/workflow/risk/dispute gates, and execute the declared payment/settlement path. If W030 external payment integration is exercised, it must remain behind `/payments` and existing adapter/provider contracts; external payment state cannot become OpenCon economic authority.
12. **Lineage reconstruction** — reconstruct the finished creator engagement backward across durable identifiers, authoritative state/version, audit order, organization scope, idempotency and payment/settlement transaction lineage.

### 3.1 Deterministic fixture requirements

- Use fixed evaluation/reference anchors or authoritative subject timestamps. Do not introduce repeated `Date.now()` dependencies into proof paths.
- Use one creator, one advertiser/campaign organization and explicit actor identities with deterministic identifiers.
- Pin the campaign policy/terms version explicitly.
- The creator record, match result, engagement/opportunity/contribution, UGC reference, rights record, disclosure/compliance record, measurement observation, evidence/PoV, value record, settlement and payment transaction each need durable lineage identifiers where those records already exist.
- Same-key replays must use deterministic request identities and return the original authoritative records.
- Fixtures must avoid hard-coding transient database identifiers when the authoritative APIs already supply stable ids.

### 3.2 Creator rights and publication boundary

W035 may create/verify UGC and usage-rights records through W017 and exercise W018 disclosure/compliance. It must not move provider-specific publication semantics into `/creators` or `/campaigns`, and it must not treat publication as proof of rights. Rights must be authoritative before any stage that consumes them.

### 3.3 Measurement/payment provider requirements

At least one end-to-end path must cross the repository's actual provider-selection boundary used by creator measurement and, where available through existing W030 composition, external payment. Test doubles may be used for adversarial unit coverage, but the required real round-trip must use configured PostgreSQL/Redis infrastructure and the repository's real adapter/authority selection path. Provider credentials must resolve through the existing secret boundary and no production credential may be committed.

## 4. Required invariants

1. **Creator authority:** creator identity, creator record, preferences/restrictions and matching inputs remain `/creators` owned.
2. **Campaign/terms authority:** campaign policy, engagement requirements and pinned terms remain in the existing campaign/creator authorities; W035 adds no second contract source of truth.
3. **Matching integrity:** W016 hard gates precede ranking; AI advisory output remains bounded and non-authoritative.
4. **UGC/rights authority:** W017 owns UGC workflow and usage-rights truth; an artifact or publication event cannot self-authorize rights.
5. **Disclosure authority:** W018 owns sanctioned publication/disclosure/commercial relationship requirements; caller assertions cannot bypass the gate.
6. **Measurement authority:** provider integration facts remain in `/measurement`/`/adapters`; normalized measurement semantics remain `/outcomes`.
7. **Evidence authority:** `/evidence` owns provenance, verification, confidence and PoV semantics; raw creator claims cannot mint economic value.
8. **Lifecycle authority:** all opportunity/contribution transitions remain under `/workflows`; no creator-specific lifecycle engine exists.
9. **Risk/dispute authority:** existing `/disputes` controls gate economic maturation/consumption; creator code cannot waive them.
10. **Economic authority:** all pending/mature/consumed creator value, reward allocation, settlement and cash obligations remain `/settlement` owned; no creator ledger exists.
11. **External payment containment:** `/payments` and `/adapters` provide provider transaction facts; OpenCon economic truth remains `/settlement` owned.
12. **Idempotency/concurrency:** every material composed mutation is replay-safe and at least one concurrent race proves exactly-once behavior at the economic boundary.
13. **Atomicity:** at least one fault injection at a material creator-to-settlement join proves no partial economic/bookkeeping/audit/idempotency state survives a failed composite commit.
14. **Privacy:** raw audience, platform, device, payment-provider or other unnecessary personal/vendor data does not escape approved boundaries; secrets do not appear in persisted or diagnostic surfaces.
15. **Tenancy:** scope is checked at authoritative boundaries; cross-tenant creator, campaign, rights, evidence and settlement references fail closed without an existence oracle.
16. **Audit lineage:** material mutations carry execution/correlation/idempotency/transaction lineage; audit publication is post-commit and never fabricates uncommitted state.
17. **Traversal proof:** authoritative state/version witnesses and durable audit order prove creator discovery → terms → UGC/rights → disclosure/compliance → MEASURING → measurement → evidence/PoV → workflow completion → risk/dispute resolution → settlement/payment.
18. **Frozen architecture:** `spec/architecture.md` and `spec/architecture-lock.md` remain byte-identical; no new domain, authority, ledger, workflow engine, payment primitive, crypto primitive, provider-neutral creator truth store or AI authority is introduced.

## 5. Acceptance criteria

### AC-01 — Creator authority and discovery

A deterministic tenant-scoped creator fixture is resolved through `/creators` and W016. Hard creator restrictions and campaign eligibility are enforced before ranking; unauthorized and cross-tenant access fails closed; matching does not create placement, settlement or rights mutations.

**Required evidence:** creator id/scope, match id and candidate exclusion, deterministic ranking witness/digest, authorization/tenant negatives, structural authority pins.

### AC-02 — Campaign contract and terms

One ACTIVE campaign and explicit pinned terms/policy are resolved. Required compensation/clearing, evidence, measurement and disclosure requirements are read from authoritative policy. Caller-supplied terms cannot authorize settlement or overwrite the authoritative policy.

**Required evidence:** campaign id/policy-version id, terms lineage, owner authorization, stale/version mismatch negative, cross-tenant negative, audit lineage.

### AC-03 — Creator acceptance and UGC production

The creator engagement enters the existing sanctioned opportunity/contribution lifecycle. W017 creates a durable UGC reference and explicit usage-rights terms. Rights are scoped to the intended campaign/engagement and are not implied by creator acceptance or artifact existence.

**Required evidence:** authoritative lifecycle transition, UGC id/reference, rights id/version/scope, invalid/expired/insufficient-rights negative, no direct workflow/repository mutation.

### AC-04 — Disclosure and compliance

The commercial relationship and required disclosure/compliance state are established through W018's sanctioned contracts. Any required publication/disclosure evidence is generated through existing authority; caller-supplied disclosure assertions fail closed. Publication cannot bypass rights, policy or lifecycle gates.

**Required evidence:** relationship/disclosure ids, applicable policy version, compliant and non-compliant fixtures, ordered disclosure/publication witnesses, privacy-safe evidence lineage.

### AC-05 — Measurement and normalized outcomes

The execution reaches authoritative MEASURING before measurement acceptance. A deterministic creator measurement report traverses the real `/measurement` provider-selection path into `/outcomes`, preserving provider provenance, attribution semantics and uncertainty. Raw provider payloads/secrets/unnecessary personal identifiers do not escape approved boundaries.

**Required evidence:** workflow state/version witness, provider/adapter identity, normalized observation, uncertainty/provenance, deterministic provider fixture, privacy/leak regression.

### AC-06 — Evidence / Proof-of-Value

The engagement becomes settlement-eligible only through authoritative `/evidence` verification/PoV semantics. Evidence must link the creator engagement to the required UGC/rights/disclosure/measurement records. Caller-provided grade, confidence or value cannot bypass evidence authority.

**Required evidence:** evidence ids, PoV state/grade/confidence, source lineage, required-policy satisfaction, caller-assertion negative, tampered-lineage negative.

### AC-07 — Workflow completion and risk/dispute gates

The creator execution completes through `/workflows` only after the required evidence/outcome/compliance gates pass. Applicable risk and dispute controls are exercised in fail-closed mode, then resolved through `/disputes`; the authoritative economic path succeeds only after resolution. No creator-specific risk/dispute state exists.

**Required evidence:** ordered lifecycle witnesses, risk HOLD refusal, ACTIVE dispute refusal, resolution witnesses, final workflow state/version.

### AC-08 — Settlement and payment

Verified creator value enters `/settlement` only after the required workflow/evidence/risk/dispute gates, moves through pending/mature semantics, and reaches the declared settlement rule. Where external payment is exercised, the payment transaction is linked to settlement but does not become economic authority; provider failures do not fabricate settled value.

**Required evidence:** value lineage, pending→mature→payment transaction, ledger conservation, settlement/payment transaction ids, idempotent provider handling, failure/retry proof, structural no-bypass pin.

### AC-09 — Replay, concurrency, atomicity, tenancy and lineage

Same-key replays return identical committed records without duplicates; at least one concurrent race proves exactly-once economic behavior; a commit-failing material join leaves no partial creator economic/bookkeeping/audit/idempotency state; foreign identifiers fail closed; final lineage reconstructs the full chain.

**Required evidence:** replay outcomes, concurrency winner count, real PostgreSQL fault-injection proof, tenant matrix, ordered durable audit reconstruction, transaction/idempotency lineage.

### AC-10 — Full traversal, architecture and regression safety

The complete creator scenario is reconstructable in the declared order from authoritative witnesses and durable audit commit order. `bun run verify`, `arch:check`, `authority:check`, secret scanning, configured real PostgreSQL/Redis integration and the required real-provider creator round-trip are green. Frozen architecture files are unchanged and W036 behavior is absent.

**Required evidence:** exact traversal witness list, audit-order witness, complete verification counts, mutation results with byte-identical source restoration, CI push + pull_request green, frozen-file hash/byte check, changed-file inventory and out-of-scope scan.

## 6. Required test/evidence shape

The implementation PR must contain composition/proof tests, not a new creator subsystem. Use one-to-one suites for AC-01..AC-10 plus a shared creator harness and a deterministic full-path traversal test.

At minimum the tests must cover:

- creator identity/authorization, W016 hard-gated discovery and deterministic selection;
- campaign policy/terms version pinning and unauthorized/cross-tenant rejection;
- creator acceptance through the existing lifecycle authority;
- W017 UGC/rights creation, scope, expiry and enforcement;
- W018 sanctioned disclosure/compliance and publication evidence where applicable;
- workflow ordering with authoritative state/version witnesses;
- real measurement provider-selection path through `/measurement` to `/outcomes`;
- evidence/PoV verification and caller-assertion rejection;
- risk/dispute maturation gates and sanctioned resolution;
- settlement pending/mature/payment conservation and external-payment containment;
- same-key replay and concurrent exactly-once behavior;
- critical-join fault injection with no partial economic/bookkeeping/audit/idempotency persistence;
- backward lineage reconstruction and post-commit audit ordering;
- cross-tenant/unauthorized fail-closed behavior;
- targeted mutation checks that remove each material guard and prove the corresponding suite fails;
- structural no-new-authority/no-second-ledger/no-provider-leak/no-W036 behavior pins.

## 7. Required verification gate

```text
AC-01..AC-10 satisfied
+ architecture + authority checks clean
+ targeted mutations caught and sources restored byte-identically
+ bun run verify green
+ configured real PostgreSQL/Redis integration green
+ real-provider creator end-to-end round-trip green
+ CI push green
+ CI pull_request green
+ exactly one implementation PR for W035
+ architect approval recorded
→ merge
```

Green CI alone is never sufficient for merge.

## 8. Explicit non-goals

- no new creator domain or creator-specific authority;
- no new workflow state machine or lifecycle vocabulary;
- no second campaign/terms authority;
- no second UGC/rights store;
- no disclosure authority outside W018;
- no measurement semantics outside `/outcomes`;
- no evidence/PoV semantics outside `/evidence`;
- no settlement/economic semantics outside `/settlement`;
- no provider SDK vocabulary crossing into core/domain boundaries;
- no payment authority outside existing `/payments` integration and `/settlement` semantic ownership;
- no direct external payment execution outside W030-sanctioned adapter composition;
- no new reputation authority or advertising-spend-to-reputation behavior;
- no demand/procurement/benefit lifecycle changes (NET-W036);
- no new decentralized consensus or portable-proof behavior;
- no raw provider/audience/payment payload store;
- no production provider credentials committed;
- no architecture-file amendment.

## 9. Decision of record

W035 is a proof milestone. The implementation should be predominantly integration/composition tests plus only strictly necessary composition-root test harness wiring. The success condition is one reproducible creator engagement whose authoritative path is visible from discovery and terms through UGC/rights, disclosure/compliance, measurement, evidence/PoV, risk controls and settlement/payment, with no bypass, duplicated authority, privacy leakage, non-atomic economic mutation or traversal ambiguity.
