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

## 15. Verification record (delivered)

Implementation PR: #73
Implementation branch: feat/net-w035-complete-creator-lifecycle
Reviewed head: 749946474606e6ee534f5b1d621fd1c337f4b2e0
Merge SHA: (pending architect approval)

Changed files: 15 (12 new test files + 1 new regression suite + 1 modified TEST harness + this ledger)
Production src changes: 0
Frozen architecture file changes: 0

bun run typecheck: PASS
bun run arch:check: 322 files / 0 violations
bun run authority:check: 322 files / 0 violations
bun run verify: 2330 pass / 15 skip / 0 fail / 2345 tests / 300 files (the W034 baseline 2258/15/0 ⇒ +72 W035 composition tests across 12 new test files)
Targeted mutations: 12/12 caught; byte-identical restoration: PASS (driver `opencon-tmp-w035/mutation-driver.py`, never committed)
Real PostgreSQL + Redis: 17 pass / 0 fail (PG 17 on 127.0.0.1:55432 + Redis 7.2.5 on 127.0.0.1:56379)
Real creator provider round-trip: 23 checks / 23 passed (a DEDICATED round-trip database, dropped afterwards — see §15.2)
Secret scan: PASS (the AC-10 regression pin over the whole W035 artifact set)
CI push exact-head: run 33665390333 — verify + integration both SUCCESS (head 7499464)
CI pull_request exact-head: run 33665447181 — verify + integration both SUCCESS (head 7499464; 4/4 check-runs success, mergeable_state clean)

Traversal witnesses: the 30 ordered stage witnesses (§15.3) over BOTH authoritative lifecycle subjects (engagement v0 DRAFT → v5 VERIFIED; contribution v0 DRAFT → v4 SUBMITTED → v5 MEASURING → v10 VERIFIED)
Durable audit markers: 33 canonical markers in strictly ascending audit positions (the full-path scenario suite) + 31 in the real round-trip
AC-09 rollback proof: the composite-level COMMIT failure over the ACTUAL creator-to-settlement join (the recognition composite's authoritative mutation service, `createEconomicValueService`, rebuilt over a commit-failing authority with the REAL repositories/ledger/idempotency/audit-writer + neutral lookups over the public services): the value record + balanced recognition postings + idempotency record + buffered audit all staged then rolled back — NOTHING persists (no value record, no ledger entries/transactions, no idempotency, no audit event); the healthy same-key retry through the REAL apiCommand completes exactly once
Same-key retry: measurement submission + recognition + payment fact replays all return the committed records verbatim (created=false; one audit event each)
Concurrent exactly-once proof: concurrent same-key recognition converges to exactly ONE value record (the economic boundary race; conservation holds)
Tenant matrix: cross-tenant profile/match-run/engagement/grant/publication/measurement/value/payment-fact references all fail closed without existence oracles (AC-09); the foreign-scope payment fact's derived reconciliation stays `pending` (internal_lineage_not_found)

Architect decision: CHANGES REQUESTED (comment 5514394512, 2026-09-02 — the canonical-path determinism blockers) → remediation delivered on the SAME PR/branch (§15.5); re-review PENDING at the remediation head.

### 15.1 The delivered traversal witnesses (the exact 30-stage order)

```text
creator-resolved → creator-authorized → match-hard-gates-passed
→ match-committed → campaign-policy-resolved → opportunity-materialized
→ terms-pinned (DRAFT v0) → creator-accepted (ASSIGNED v2)
→ contribution-entered (DRAFT v0) → contribution-submitted (SUBMITTED v4)
→ ugc-recorded (IN_PROGRESS v3) → rights-authorized (ACTIVE grant)
→ ugc-submitted (SUBMITTED v4) → engagement-verified (VERIFIED v5)
→ relationship-recorded → publication-recorded
→ disclosure-compliance-satisfied (publication VERIFIED)
→ lifecycle-measuring (MEASURING v5) → measurement-normalized
→ outcome-verified → evidence-pov-verified → poh-evaluated
→ lifecycle-completed (VERIFIED v10) → settlement-pending
→ risk-gate-refused → risk-gate-resolved → dispute-gate-refused
→ dispute-gate-resolved → settlement-matured → payment-committed
```

Every witness from the engagement creation onward carries the
AUTHORITATIVE engagement state + version read through
`creatorEngagementService.getEngagement`; every witness from the
contribution entry onward ALSO carries the AUTHORITATIVE contribution
state + version read through `contributionService.getContribution` —
a strictly deterministic executable-order proof over BOTH authorities
(the W033 PR #68 remediation discipline carried forward).

**Ordering deviation of record (the W034 precedent):** the ledger's
template list places `settlement-pending` after the gate resolutions;
the delivered scenario recognizes the value (PENDING) BEFORE
exercising the gates — mechanically the ONLY real-refusal shape (the
gates refuse the MATURATION of a pending value: `RISK_CONTROL` /
`DISPUTE_CHALLENGE`; recognition itself is not risk-gated — the
`refuseWhenGated`/`refuseWhenDisputed` enforcement points are the
maturation/issuance/allocation composites). This is exactly the
W034-approved order ("economic witnesses cannot occur before the
required workflow/evidence/evaluation/risk gates" — the binding
constraint is that maturation/consumption follows gate resolution,
which the delivered order satisfies: settlement-matured and
payment-committed both follow dispute-gate-resolved), documented here
rather than hidden.

### 15.2 The real round-trip record

`opencon-tmp-w035/real-pg-roundtrip.ts` (never committed): a DEDICATED
`opencon_w035_roundtrip` database + a staging-classified runtime (the
REAL provider-selection path — PostgresAuthorityAdapter +
RedisCoordinationAdapter, no shims; the delivery-notice adapter
AUTO-WIRED from the staging SecretProvider's
MEASUREMENT_OPENRTB_DELIVERY_KEY; the W030 trust channel from
EXTERNAL_SETTLEMENT_REFERENCE_TRUST_KEY) + the seeded W008→W018
guard/policy surface + ONE creator execution through the complete
canonical chain — ALL 23 CHECKS PASSED (the REAL provider selection,
the REAL W022 registry, the W015 profile, the W016 hard-gated match,
the ACTIVE campaign with the escrowed budget, the W017 acceptance
composite, the W012 contribution entry, the UGC production bound to
the contribution + the rights view, the engagement VERIFIED walk, the
W018 disclosure/compliance gate, the W022 measurement, the outcomes,
the evidence/PoV + the PoH, the completed VERIFIED v10 walk, the
risk/dispute gates fail-closed-then-resolved, the settlement
pending/mature, the W030 external payment with the derived MATCHED
reconciliation, the 30-witness CANONICAL TRAVERSAL ORDER, the 31
ordered audit markers, the terminal states, the settlement
conservation over the REAL ledger, the privacy boundary, the payment
containment). The round-trip database dropped afterwards.

### 15.3 The changed-file inventory (the authority mapping)

| File | Kind | Authority exercised |
|---|---|---|
| tests/creator-lifecycle/_net-w035-harness.ts | NEW (shared harness) | pure test composition over the existing contracts |
| tests/creator-lifecycle/net-w035-full-path-scenario.test.ts | NEW | the canonical traversal + audit order + conservation |
| tests/creator-lifecycle/net-w035-ac-01-creator-discovery.test.ts | NEW | /creators + W016 matching |
| tests/creator-lifecycle/net-w035-ac-02-campaign-terms.test.ts | NEW | /campaigns terms + escrow |
| tests/creator-lifecycle/net-w035-ac-03-acceptance-ugc-rights.test.ts | NEW | W017 engagement/UGC/rights |
| tests/creator-lifecycle/net-w035-ac-04-disclosure.test.ts | NEW | W018 sponsorship/disclosure |
| tests/creator-lifecycle/net-w035-ac-05-measurement.test.ts | NEW | /measurement→/outcomes + privacy |
| tests/creator-lifecycle/net-w035-ac-06-evidence.test.ts | NEW | /evidence PoV + PoH |
| tests/creator-lifecycle/net-w035-ac-07-workflow-risk-dispute.test.ts | NEW | /workflows + /disputes gates |
| tests/creator-lifecycle/net-w035-ac-08-settlement-payment.test.ts | NEW | /settlement + /payments+/adapters |
| tests/creator-lifecycle/net-w035-ac-09-replay-concurrency-atomicity.test.ts | NEW | replay/race/atomicity/tenancy/lineage |
| tests/regression/net-w035-ac-10-architecture-out-of-scope.test.ts | NEW (regression) | the structural pins |
| tests/creators/_net-w018-harness.ts | MODIFIED (the ONE declared test-harness adjustment) | option forwarding of the PRE-EXISTING NetW008HarnessOptions (the W015/W016/W017 chain already threaded them): the NET-W006 measurement-provider registry + the NET-W030 trust keys — tests-only, never src/ (the W034 measurement-threading precedent) |
| docs/net-w035-complete-creator-lifecycle.md | MODIFIED (this record) | the evidence ledger |

No production source file changed. The frozen architecture files are
byte-identical (AC-10 regression pin). The mutation driver and the
round-trip script live OUTSIDE the repository (opencon-tmp-w035/) and
are never committed.

### 15.4 Decisions of record

1. **The canonical order follows the frozen ledger literally** (match
   before campaign; discovery → terms → acceptance → UGC → rights →
   disclosure → MEASURING → measurement → evidence → completion →
   gates → settlement → payment), with the W034-precedented
   recognition-before-gates deviation documented in §15.1.
2. **The contribution enters through the sanctioned W012 helpfulness
   composite** on the campaign's `helpful_recommendation` opportunity
   (the W034 decision of record — the ONLY contribution vehicle); the
   W017 production binds the contribution id, giving the
   engagement → production → contribution → measurement lineage.
3. **The declared payment/settlement path is the W030 external
   payment** (the /payments + /adapters leg the work order §3.3 and
   AC-08 explicitly provide for): the W020 cross-promotion clearing
   composite is placement-bound (an advertising-shaped join — /inventory
   is explicitly OUTSIDE the W035 authority placement), so the
   campaign's declared compensation/clearing rule (reward_allocation
   to the CREATOR, maxDrawAmount covered by the escrowed budget) is
   the declared compensation lineage and the external fact + derived
   reconciliation is the payment leg. The fact posts NO ledger
   entries; the provider acknowledgement never becomes internal
   settlement truth.
4. **The dispute fixture anchor is the subject's OWN authoritative
   timestamp** (contribution.createdAt / economic_value.recordedAt —
   the W034 PR #70 remediation discipline); the risk assessment uses
   the fixed `2026-09-01T12:00:00.000Z` anchor; the payment fact's
   `observedAt` is fresh at ingestion (the W030 freshness-window
   semantics — the W030 golden-path pattern; the determinism anchors
   never depend on it). AMENDED by the §15.5 remediation: the
   canonical rights windows and evidence-capture timestamps are
   FIXED anchors, the usage-rights view reads pass a FIXED
   evaluation `asOf`, the external payment identity is DERIVED from
   the matured value record, and the signing timestamp is the FIXED
   `W035_PAYMENT_SIGNED_AT` anchor — the ONE sanctioned wall-clock
   read is the provider freshness `observedAt` (the explicit
   architect-sanctioned exception).
5. **The AC-09 atomicity proof targets the creator-to-settlement
   join** (the recognition composite's authoritative mutation service)
   — a genuine composite-level COMMIT failure after full staging, NOT
   a stale-state refusal (the W034 PR #70 remediation lesson applied
   from the start).

### 15.5 Remediation record (PR #73 — architect comment 5514394512)

**The architect decision (2026-09-02): CHANGES REQUESTED** — two
blockers in the canonical proof path's deterministic-fixture contract
(work order §3.1):

1. **Blocker 1 — the canonical traversal was not deterministic**:
   `runCreatorScenario()` used wall-clock `Date.now()` windows for the
   engagement requested/granted rights and `new Date().toISOString()`
   for the production/disclosure evidence `collectedAt` timestamps.
2. **Blocker 2 — the canonical payment identity was nondeterministic**:
   `recordCreatorPayment()` generated the default external payment
   identity with `randomUUID()` and signed with a fresh timestamp.

**The remediation (same branch/PR; NO production source change):**

- **Fixed canonical anchors (Blocker 1)** — the harness now declares
  the exported fixed anchor block: `W035_RIGHTS_STARTS_AT`
  (2026-09-01), `W035_RIGHTS_REQUESTED_ENDS_AT` (2026-10-01, +30d),
  `W035_RIGHTS_GRANTED_ENDS_AT` (2026-09-30, +29d — strictly within
  the requested envelope), `W035_RIGHTS_EVALUATION_AS_OF`
  (2026-09-15 — inside the granted window),
  `W035_RIGHTS_EXPIRED_AS_OF` (2040-01-01 — after every fixed
  window), `W035_EVIDENCE_CAPTURED_AT` (2026-09-02T10:00) and
  `W035_PAYMENT_SIGNED_AT` (2026-09-02T10:05). The canonical
  requested/granted rights windows, ALL THREE platform evidence
  captures (production/declaration/publication) and every local
  AC-suite engagement fixture now compose these anchors (the W034
  PR #70 remediation discipline applied consistently — the W023
  fixed provider-fixture style).
- **Deterministic rights-view reads** — every usage-rights view read
  in the suite (the canonical scenario + full-path + AC-03 + AC-09)
  passes an explicit FIXED `asOf` (the evaluation anchor for ACTIVE,
  the expired anchor for the derived EXPIRED/REVOKED lifecycle
  proofs); the authority's `asOf ?? now` default is never exercised
  by a W035 proof path.
- **Deterministic payment identity (Blocker 2)** — the canonical
  default external id is `ext-pay-w035-{valueRecordId}` — DERIVED
  from the authoritative matured value record the fact reports on
  (never random UUID entropy), so the same canonical execution over
  the same authoritative state reproduces the same durable external
  lineage. The signing timestamp is the FIXED
  `W035_PAYMENT_SIGNED_AT` anchor (integrity.signedAt is
  shape-validated only — never freshness-gated).
- **The ONE explicit wall-clock exception** —
  `freshProviderObservationTimestamp()` (the single `new Date()` in
  the entire suite) provides the W030 provider freshness `observedAt`
  ONLY: the external-settlement authority itself wall-clock-enforces
  the freshness window, so a fixed instant fails closed by design
  (the architect-sanctioned exception; the determinism anchors never
  depend on it).
- **Test-specific payment fixtures carry EXPLICIT identities** — the
  AC-08 fresh-fact/mismatch/failure-mode fixtures (facts recorded
  OVER the canonical value record beyond the canonical payment) pass
  explicit distinct external ids + idempotency keys, so each
  fail-closed channel (wrong key / tampered / unsigned / stale)
  remains attributable to ITS OWN gate — never masked by an identity
  conflict with the canonical deterministic fact (proven by the
  M8/M9 mutation catches).
- **The strengthened AC-10 determinism pin** — a mechanical
  comment-stripping scanner over the whole W035 suite: ZERO
  `Date.now(`/`randomUUID` code tokens; exactly ONE `new Date(` —
  inside the sanctioned freshness helper; the exact fixed anchor
  values and their canonical usage counts are pinned (2 rights
  windows, 3 evidence captures, the evaluation asOf, the derived
  payment identity, the fixed signing anchor). This pin is the
  durable guard: ANY regression of either blocker fails the suite.

**Verification at the remediation head:**

- `bun run typecheck`: PASS; `arch:check` + `authority:check`: 322
  files / 0 violations.
- `bun run verify`: 2330 pass / 15 skip / 0 fail — 2345 tests /
  300 files / 31,415 expect() (the same pass/skip counts; the pin
  strengthening adds assertions).
- Targeted mutations: **16/16 CAUGHT** with byte-identical source
  restoration (the 12 original W035 guards + the 4 NEW remediation
  guards M13–M16: rights-window-wallclock, payment-random-identity,
  payment-fresh-signedAt, evidence-wallclock — each regression of
  the remediated fixture contract is caught by the strengthened
  pin; driver outside the repo, never committed).
- Real PostgreSQL 17 + Redis 7.2.5 integration: 17 pass / 0 fail (a
  dedicated database, dropped afterwards).
- Real-provider creator round-trip: **23/23 checks PASSED** on a
  dedicated database with the SAME deterministic fixture discipline
  (fixed rights windows + fixed evidence captures + the fixed
  evaluation asOf + the derived payment identity + the fixed signing
  anchor; the only wall-clock read is the sanctioned provider
  freshness `observedAt`); the database dropped afterwards.
- No production source change (the diff since 3f60333 is exactly: 8
  modified test files — the harness + 6 composition suites + the
  strengthened AC-10 regression pin — + this ledger). The frozen
  architecture files remain byte-identical.

### 15.6 CI verification record (the remediation heads)

(recorded after push — both event paths at the exact heads)

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
