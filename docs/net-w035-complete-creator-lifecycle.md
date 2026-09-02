# NET-W035 Evidence Ledger — Complete creator lifecycle

**Status:** READY_FOR_IMPLEMENTATION — evidence contract frozen  
**Issue:** #71  
**Dependencies:** NET-W018 + NET-W034 — merged/verified  
**Architecture:** v1.0 frozen — no architecture amendment permitted  
**Preparation branch:** `docs/net-w035-creator-lifecycle`  
**Implementation branch:** must be created from W034 merge SHA `7c19a19addd44a07965fa25ee7cab021bab2016a`

## 1. Purpose

This ledger is the durable evidence contract for NET-W035. It defines the proof required for one creator lifecycle execution to traverse the existing OpenCon authorities in executable order:

```text
creator discovery/matching
→ campaign contract/terms
→ creator acceptance
→ UGC + rights
→ disclosure/compliance
→ /workflows MEASURING
→ measurement provider
→ /outcomes
→ /evidence Proof-of-Value
→ /workflows completion
→ /disputes controls
→ /settlement
→ optional W030 external payment
```

The implementation must update this ledger with exact commands, test counts, changed-file inventory, exact PR/head/merge SHAs, CI run references, provider round-trip results, mutation results, remediation history and final architect decision.

## 2. Evidence contract

| Acceptance | Primary authority | Evidence that must be durable | Main forbidden shortcut |
|---|---|---|---|
| AC-01 Creator discovery | `/creators` + W016 | creator scope, authorization, candidate exclusion, deterministic match | caller-selected/ineligible creator |
| AC-02 Contract/terms | `/campaigns` and existing creator terms authority | campaign/policy version, terms lineage, owner auth, version/scope checks | caller-supplied terms |
| AC-03 UGC/rights | W017 | UGC reference, rights id/version/scope/expiry, lifecycle witness | artifact/publication implies rights |
| AC-04 Disclosure/compliance | W018 | relationship/disclosure/policy witnesses and negative proof | caller assertion of disclosure |
| AC-05 Measurement | `/measurement` → `/outcomes` | MEASURING state/version, provider path, normalized observation, provenance, uncertainty | measurement before lifecycle gate / raw provider escape |
| AC-06 Evidence/PoV | `/evidence` | evidence/PoV ids, verification, confidence, lineage | caller grade/value |
| AC-07 Workflow/risk/dispute | `/workflows` + `/disputes` | ordered transition witnesses, HOLD/dispute refusals, resolutions | direct settlement while blocked |
| AC-08 Settlement/payment | `/settlement` + optional W030 `/payments` | value lineage, pending/mature/payment, conservation, provider transaction | external payment becomes economic truth |
| AC-09 Integrity | authoritative transactions + audit/idempotency | replay, race, commit-failure rollback, tenant matrix, lineage | stale-state-only atomicity proof |
| AC-10 Composition/regression | repository-wide gates | traversal + audit order, mutations, CI, architecture/authority scans | terminal-state-only composition proof |

## 3. Canonical traversal witness contract

The final scenario MUST emit an ordered collection of authoritative witnesses at least as strong as:

```text
creator-resolved
→ creator-authorized
→ match-hard-gates-passed
→ match-committed
→ campaign-policy-resolved
→ terms-pinned
→ creator-accepted
→ ugc-recorded
→ rights-authorized
→ disclosure-compliance-satisfied
→ lifecycle-measuring
→ measurement-normalized
→ outcome-verified
→ evidence-pov-verified
→ lifecycle-completed
→ risk-gate-refused
→ risk-gate-resolved
→ dispute-gate-refused
→ dispute-gate-resolved
→ settlement-pending
→ settlement-matured
→ payment-or-final-settlement-committed
```

The exact witness names may follow existing repository conventions. From the lifecycle entry onward, witnesses must carry the durable subject id and authoritative workflow state/version as applicable. Where durable mutations determine order, the implementation must additionally collect the committed audit markers and prove their order.

The proof MUST show:

1. rights are authoritative before any publication/compliance stage that depends on them;
2. disclosure/compliance is satisfied before any evidence-gated economic path;
3. the workflow is authoritatively `MEASURING` before measurement/outcome/evidence acceptance;
4. workflow completion/evaluation precedes economic maturation;
5. risk/dispute refusals occur before settlement consumption/maturation and their resolutions re-open the same sanctioned path;
6. settlement remains the only economic authority even when an external payment adapter is used.

An ordered in-memory witness array without authoritative state/version or durable commit evidence is insufficient.

## 4. AC-01 — Creator discovery and authority

### Required proof
- one deterministic creator record from `/creators`;
- explicit tenant scope and actor authorization;
- W016 matching path invoked through existing sanctioned interfaces;
- at least one ineligible/restricted candidate hard-excluded before ranking;
- deterministic selection after hard gates;
- AI/model suggestions, if present, remain advisory evidence only;
- unauthorized and cross-tenant references fail closed.

### Mutation targets
- remove creator authorization;
- rank before hard eligibility;
- let advisory output override restriction;
- accept caller-supplied creator id outside tenant;
- make matching create economic/rights state.

## 5. AC-02 — Campaign contract and terms

### Required proof
- one ACTIVE campaign;
- one explicitly pinned policy/terms version;
- terms contain the measurement, evidence, disclosure and compensation/clearing requirements used by the scenario;
- actor/organization scope is revalidated at authoritative boundaries;
- stale or foreign policy/terms references fail closed;
- terms do not create a second economic ledger.

### Mutation targets
- accept caller-supplied compensation/clearing rule;
- skip policy-version pin/recheck;
- bypass owner authorization;
- cross-tenant policy resolution.

## 6. AC-03 — Creator acceptance, UGC and rights

### Required proof
- engagement enters through the existing opportunity/contribution lifecycle;
- W017 UGC workflow is exercised;
- durable UGC reference and explicit rights record exist;
- rights scope binds to the intended creator/engagement/campaign and usage term;
- insufficient, expired, withdrawn or mismatched rights fail closed;
- publication is not treated as a substitute for rights authorization.

### Atomicity focus
Where W017 exposes a coupled creator-acceptance/UGC/rights composite, at least one failure fixture must prove no partial accepted/UGC/rights state survives the failed authoritative transaction.

### Mutation targets
- bypass W017 rights gate;
- infer rights from artifact existence;
- accept expired/foreign rights;
- mutate workflow directly.

## 7. AC-04 — Disclosure and compliance

### Required proof
- W018 commercial relationship/disclosure path is invoked through existing sanctioned contracts;
- required disclosure policy is linked to the campaign terms version;
- compliant fixture succeeds;
- non-compliant/missing disclosure fixture fails closed;
- publication evidence, when required by the existing path, is authoritative and provenance-linked;
- no local disclosure state machine exists.

### Mutation targets
- bypass disclosure gate;
- trust caller assertion of disclosure;
- detach disclosure from policy/engagement lineage;
- allow publication without required rights/compliance.

## 8. AC-05 — Measurement and normalized outcomes

### Required proof
- authoritative workflow reaches MEASURING before measurement acceptance;
- one deterministic creator-campaign measurement report crosses the real provider-selection stack;
- provider-specific semantics remain behind `/measurement`/`/adapters`;
- normalized `/outcomes` observation retains provenance, attribution mode and uncertainty;
- raw provider payload, secrets and unnecessary personal/device data do not enter normalized records, audit, logs or errors.

### Mutation targets
- accept measurement before MEASURING;
- bypass provider normalization;
- strip provenance/uncertainty;
- persist raw payload;
- leak secrets or sensitive identifiers.

## 9. AC-06 — Evidence / Proof-of-Value

### Required proof
- evidence is created/resolved by `/evidence` using the measured result and creator engagement lineage;
- required UGC/rights/disclosure/measurement evidence is satisfied according to campaign policy;
- verification/confidence/grade are authoritative;
- PoV is explicitly linked to source observation(s);
- caller-supplied grade, confidence, value or status cannot authorize settlement.

### Mutation targets
- trust caller evidence grade;
- skip verification;
- sever UGC/rights/measurement lineage;
- accept unverified PoV into economic flow.

## 10. AC-07 — Workflow completion and risk/dispute gates

### Required proof
- creator execution completes via `/workflows` only after evidence/outcome/compliance gates;
- at least one applicable risk HOLD refuses economic progress;
- at least one ACTIVE dispute/challenge state refuses maturation/consumption;
- both controls are resolved through `/disputes` and the authoritative settlement path then succeeds;
- no creator-specific risk/dispute machine exists.

### Mutation targets
- remove evidence/compliance transition gate;
- bypass risk HOLD;
- bypass dispute gate;
- direct settlement while blocked.

## 11. AC-08 — Settlement and payment

### Required proof
- verified creator value enters `/settlement` only after required gates;
- pending and mature value remain distinct;
- clearing/payment follows the declared campaign rule and existing settlement primitive;
- ledger conservation and transaction lineage hold;
- where W030 is exercised, external payment uses the existing adapter boundary and remains subordinate to internal settlement state;
- provider failure cannot fabricate a settled/payment-complete economic record;
- same payment/request key replays are exactly-once/idempotent at the provider boundary.

### Mutation targets
- recognize non-verified value;
- mature during active risk/dispute;
- mutate ledger outside `/settlement`;
- treat payment-provider acknowledgement as internal settlement truth;
- duplicate external payment on replay.

## 12. AC-09 — Replay, concurrency, atomicity, tenancy and lineage

### Required proof

**Replay:** a completed same-key replay reaches the idempotency store before mutable reads and returns the original committed result; a fresh key re-checks all current-state gates.

**Concurrency:** at least one real concurrent race exercises the economic boundary and yields exactly one successful economic mutation with no duplicate allocation/payment/ledger posting.

**Atomicity:** failure must be induced after material creator-to-settlement work is staged inside the authoritative composite transaction. The proof must show that none of the clearing/allocation/value/ledger/payment-bookkeeping/audit/idempotency mutations survives commit failure, then a healthy same-key retry must succeed exactly once. A stale-state rejection or pre-consumed value is not sufficient evidence of composite rollback.

**Tenancy:** foreign creator/campaign/rights/evidence/value/payment references fail closed and do not disclose resource existence.

**Lineage:** final reconstruction links creator → campaign/terms → engagement → UGC/rights → disclosure → measurement/outcome → evidence/PoV → workflow → risk/dispute → settlement/payment using durable ids and transaction/audit lineage.

### Mutation targets
- move mutable reads ahead of completed-key idempotency lookup;
- remove pair/aggregate concurrency gate;
- independently commit coupled economic mutation;
- remove audit/idempotency rollback participation;
- bypass tenant revalidation;
- return caller-controlled lineage ids.

## 13. AC-10 — Full traversal and repository regression

### Required proof
- all AC-01..AC-09 suites pass;
- deterministic traversal test proves executable order;
- durable audit commit order corroborates material stage ordering;
- `bun run verify` passes with zero failures;
- `bun run arch:check` passes;
- `bun run authority:check` passes;
- targeted mutation suite catches every material guard and restores sources byte-identically;
- real PostgreSQL + Redis integration passes;
- real-provider creator round-trip passes;
- secrets/provider scan is clean;
- CI push and pull_request checks are green for the exact reviewed head;
- frozen architecture files are byte-identical;
- no W036/procurement/benefit behavior appears in the implementation.

## 14. Expected artifact/test layout

The implementation should follow the established composition-proof shape, adapted to repository conventions. A valid implementation is expected to have:

```text
spec/work-orders/NET-W035.md

docs/net-w035-complete-creator-lifecycle.md

tests/creator/
  _net-w035-harness.ts
  net-w035-full-path-scenario.test.ts
  net-w035-ac-01-creator.test.ts
  net-w035-ac-02-terms.test.ts
  net-w035-ac-03-ugc-rights.test.ts
  net-w035-ac-04-disclosure.test.ts
  net-w035-ac-05-measurement.test.ts
  net-w035-ac-06-evidence.test.ts
  net-w035-ac-07-workflow-risk-dispute.test.ts
  net-w035-ac-08-settlement-payment.test.ts
  net-w035-ac-09-integrity.test.ts
  net-w035-ac-10-architecture-out-of-scope.test.ts
  ... targeted mutation driver(s)
```

Names may differ where existing conventions require it. The acceptance criteria remain one-to-one with AC-01..AC-10.

## 15. Required verification record template

The implementation PR must replace the placeholders below with exact evidence.

```text
Implementation PR: #___
Implementation branch: feat/net-w035-complete-creator-lifecycle
Reviewed head: __________
Merge SHA: __________

Changed files: ___
Production src changes: ___
Frozen architecture file changes: 0 required

bun run typecheck: PASS/FAIL
bun run arch:check: ___ files / ___ violations
bun run authority:check: ___ files / ___ violations
bun run verify: ___ pass / ___ skip / ___ fail / ___ tests / ___ files
Targeted mutations: ___/___ caught; byte-identical restoration: PASS/FAIL
Real PostgreSQL + Redis: ___ pass / ___ fail
Real creator provider round-trip: ___ checks / ___ passed
Secret scan: PASS/FAIL
CI push exact-head: run ___ / PASS/FAIL
CI pull_request exact-head: run ___ / PASS/FAIL

Traversal witnesses: __________
Durable audit markers: __________
AC-09 rollback proof: __________
Same-key retry: __________
Concurrent exactly-once proof: __________
Tenant matrix: __________

Architect decision: PENDING
```

## 16. Review discipline

The implementation must be delivered through exactly one W035 implementation PR. Any architect-requested remediation is made on that same PR/branch and re-reviewed at the resulting exact head. Do not create a second implementation PR for W035 after CHANGES REQUESTED.

Merge requires all acceptance evidence, exact-head CI, architect approval and durable state/roadmap update. Green CI alone is not sufficient.

## 17. Non-goals

- no new creator domain or authority;
- no new contract ledger or workflow engine;
- no duplicate UGC/rights store;
- no disclosure authority outside W018;
- no measurement semantics outside `/outcomes`;
- no evidence semantics outside `/evidence`;
- no economic authority outside `/settlement`;
- no payment semantic authority outside `/settlement`; `/payments` remains integration-only;
- no new payment primitive;
- no new risk/dispute authority;
- no advertising or procurement lifecycle changes;
- no W036 behavior;
- no new cryptographic or decentralized consensus primitive;
- no architecture-version change;
- no production credentials or raw provider payload store.

## 18. Decision of record

W035 is the creator-network Phase-9 composition proof. Its success condition is one reproducible creator engagement traversing the existing authorities from discovery and terms through UGC/rights, disclosure/compliance, measurement, evidence/PoV, workflow completion, risk/dispute controls and settlement/payment, with authoritative ordering, exact lineage, atomic economics, tenant isolation and no duplicated authority.
