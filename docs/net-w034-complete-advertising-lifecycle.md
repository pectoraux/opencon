# NET-W034 Evidence Ledger — Complete advertising lifecycle

**Status:** ARCHITECTURE / WORK-ORDER FREEZE — implementation not yet verified  
**Issue:** #69  
**Dependencies:** NET-W020 + NET-W021 + NET-W022 + NET-W023 + NET-W033 — merged/verified  
**Architecture:** v1.0 frozen; no amendment authorized  
**Implementation branch:** `feat/net-w034-complete-advertising-lifecycle`

## 1. Purpose

This ledger is the durable evidence contract for NET-W034. It is created before implementation and must be updated by the implementation PR with exact commands, counts, commit/head SHAs, CI run references, test paths and any architect-reviewed remediation.

W034 proves one advertising execution through the existing OpenCon authorities:

```text
advertiser / campaign
  → inventory / creator supply
  → campaign matching
  → placement / execution lifecycle
  → MEASURING
  → provider/native measurement
  → /outcomes
  → /evidence Proof-of-Value
  → /workflows completion
  → risk / dispute controls
  → /settlement
```

The canonical traversal MUST be explicit and MUST be proven with authoritative state/version witnesses and durable audit ordering where committed mutations determine order.

## 2. Architectural evidence contract

| Area | Authority that must own the truth | Forbidden W034 behavior |
|---|---|---|
| Advertiser/campaign | `/campaigns` | local campaign policy/status/clearing authority |
| Supply/inventory | `/inventory` | fabricated ownership/readiness or second supply store |
| Provider ad/supply protocols | `/adapters` | provider SDK/wire vocabulary in core domains |
| Matching/selection | `/campaigns` / W021 | matching becomes placement/economic authority; AI becomes authorization |
| Measurement integration | `/measurement` | adapter becomes measurement semantic authority |
| Measurement semantics | `/outcomes` | local outcome scoring/finalization |
| Evidence/PoV | `/evidence` | caller-asserted grade/value or local verification truth |
| Lifecycle | `/workflows` | second workflow/state machine |
| Risk/dispute | `/disputes` | advertising-specific risk bypass |
| Economics | `/settlement` | ad ledger, balance, posting or payment authority |
| Reputation (where applicable) | `/reputation` | advertising spend buys reputation or local reputation mutation |

## 3. Canonical traversal witnesses to require

The final implementation must expose a deterministic ordered witness collection comparable to W033. The exact labels may follow repository conventions, but the evidence must establish at least:

1. campaign/policy resolved and authorized;
2. supply provenance resolved;
3. W021 matching run committed;
4. selected inventory item proven eligible;
5. placement committed;
6. campaign opportunity/execution subject materialized;
7. workflow publication/submission reached the required lifecycle point;
8. authoritative `MEASURING` state/version observed;
9. normalized measurement observation committed;
10. evidence/PoV verified;
11. lifecycle evaluation/completion reached the required terminal confirmation;
12. risk/dispute gates exercised and resolved;
13. settlement value recognized/pending;
14. settlement value matured;
15. campaign clearing/economic effect committed;
16. final lineage/audit reconstruction completed.

The implementation must demonstrate that witnesses 9–10 cannot occur before witness 8, and that economic witnesses cannot occur before the required workflow/evidence/evaluation/risk gates. Local array order alone is not evidence.

## 4. Acceptance map — evidence required before merge

### AC-01 — Advertiser/campaign authority

**Required proof**
- one deterministic ACTIVE campaign and pinned policy version;
- advertiser owner/actor authorization;
- campaign policy contains the measurement/evidence/clearing rules used;
- cross-tenant and unauthorized access fail closed;
- campaign mutations remain `/campaigns` owned.

**Expected suites**
`tests/advertising/net-w034-ac-01-campaign.test.ts` or repository-equivalent naming.

**Mutation targets**
- remove campaign ACTIVE gate;
- accept caller-supplied policy scope/version;
- bypass actor authorization;
- accept cross-tenant campaign reference.

### AC-02 — Supply provenance and inventory authority

**Required proof**
- exactly one W019 inventory source is resolved;
- source context and W019 settlement-readiness are derived from current durable records;
- where W023 is exercised, provider/supply-chain normalization remains in `/adapters` and exact-one inventory resolution is enforced;
- withdrawn/retired/ineligible/ambiguous/cross-tenant sources fail closed;
- no external assertion can manufacture ownership/readiness.

**Expected suites**
`tests/advertising/net-w034-ac-02-supply.test.ts`.

**Mutation targets**
- make ambiguous resolution choose first record;
- bypass current settlement-readiness;
- accept stale/unverified supply as authorization;
- remove tenant check.

### AC-03 — Matching / selection integrity

**Required proof**
- W021 is invoked through its existing sanctioned path;
- at least one candidate is hard-excluded;
- only eligible candidates are ranked;
- deterministic ordering/digest is preserved;
- any AI advisory is bounded and recorded, never authoritative;
- matching itself creates no placement or economic mutation.

**Expected suites**
`tests/advertising/net-w034-ac-03-matching.test.ts`.

**Mutation targets**
- rank before hard gates;
- permit advisory output to override eligibility;
- allow an ineligible candidate into selection;
- make matching write inventory or settlement state.

### AC-04 — Placement and lifecycle entry

**Required proof**
- selected supply creates a durable W019 placement;
- campaign opportunity/execution uses the existing W011/W004 composition path;
- contribution/execution lifecycle enters through `/workflows` only;
- direct repository/state mutation is structurally and behaviorally blocked.

**Expected suites**
`tests/advertising/net-w034-ac-04-placement-lifecycle.test.ts`.

**Mutation targets**
- bypass inventory service;
- mutate workflow state directly;
- introduce local lifecycle state.

### AC-05 — Measurement normalization and privacy

**Required proof**
- workflow is authoritatively at MEASURING before measurement is accepted;
- report travels through W022 `/measurement` adapter boundary and then `/outcomes`;
- normalized observation retains provider provenance/attribution semantics/uncertainty;
- raw provider payload is not persisted by default;
- secrets/device/user/IP or unrelated provider fields do not leak into normalized records, audit, logs or errors.

**Expected suites**
`tests/advertising/net-w034-ac-05-measurement.test.ts`.

**Mutation targets**
- accept measurement before MEASURING;
- let raw payload escape adapter boundary;
- strip uncertainty/provenance;
- bypass W022 normalization;
- persist or emit sensitive raw values.

### AC-06 — Evidence / Proof-of-Value authority

**Required proof**
- evidence and PoV are created/resolved through `/evidence`;
- required campaign evidence policy is satisfied;
- verification, confidence and provenance are authoritative;
- caller-supplied grade/value cannot authorize settlement;
- evidence lineage points back to the normalized outcome/observation.

**Expected suites**
`tests/advertising/net-w034-ac-06-evidence.test.ts`.

**Mutation targets**
- trust caller grade/value;
- bypass evidence verification;
- accept unverified evidence into settlement qualification;
- sever outcome→evidence lineage.

### AC-07 — Workflow completion and risk/dispute controls

**Required proof**
- workflow completion occurs only after evidence/outcome requirements are met;
- at least one applicable risk HOLD and one ACTIVE dispute gate are exercised;
- both refuse the economic path before mutation;
- resolving controls re-opens the same authoritative path without a bypass;
- no advertising-specific risk/dispute state machine exists.

**Expected suites**
`tests/advertising/net-w034-ac-07-workflow-risk-dispute.test.ts`.

**Mutation targets**
- remove evidence-gated transition precondition;
- disable risk gate;
- disable dispute gate;
- allow direct settlement while blocked.

### AC-08 — Verified value and settlement

**Required proof**
- verified advertising value enters `/settlement` only after authoritative workflow/evidence/evaluation gates;
- pending and mature states remain distinct;
- maturation respects risk/dispute controls;
- clearing uses the campaign's declared rule and existing settlement primitive;
- ledger conservation and economic lineage hold;
- no second advertising ledger exists.

**Expected suites**
`tests/advertising/net-w034-ac-08-settlement.test.ts`.

**Mutation targets**
- recognize non-verified value;
- mature while risk/dispute is active;
- draw outside settlement primitive;
- create an ad-specific ledger/posting path.

### AC-09 — Replay, concurrency, atomicity and tenancy

**Required proof**
- same-key replay returns original records/ids and creates no duplicates;
- at least one concurrent race produces exactly one economic winner;
- injected failure at a critical composite join leaves no partial durable mutation or audit event;
- cross-tenant references fail closed throughout the chain.

**Expected suites**
`tests/advertising/net-w034-ac-09-replay-concurrency-atomicity.test.ts`.

**Mutation targets**
- remove idempotency wrap;
- move mutable reads ahead of replay detection where applicable;
- replace shared transaction with independently committing commands;
- remove authoritative scope re-check;
- weaken concurrency serialization.

### AC-10 — Full traversal, lineage, architecture and scope

**Required proof**
- deterministic traversal witness is strictly ordered;
- durable audit order corroborates committed mutation order where relevant;
- backward lineage reconstruction reaches campaign, supply, measurement, evidence/PoV and settlement through owning authorities;
- `arch:check` + `authority:check` are clean;
- frozen architecture/lock remain unchanged;
- no W035/W036 behavior appears;
- all required verification/CI gates are green.

**Expected suites**
`tests/advertising/net-w034-ac-10-traversal-architecture.test.ts` plus repository regression suites.

**Mutation targets**
- reorder stage calls;
- remove authoritative traversal witness;
- weaken audit ordering assertion;
- add a second authority/domain or provider leak;
- introduce W035/W036 vocabulary/behavior.

## 5. Real integration evidence required

The final ledger MUST record a real PostgreSQL + Redis run for the complete round-trip using the repository's real provider-selection path, not a test-only PostgreSQL shim and not an in-memory economic substitute.

The real round-trip must prove at minimum:

- durable campaign/policy;
- durable inventory/placement;
- real W021 selection path;
- real W022 provider-selection / normalization path for the chosen measurement provider or approved native path;
- PostgreSQL-authoritative outcomes/evidence/workflow/settlement state;
- risk/dispute refusal and successful retry after resolution;
- complete traversal order;
- settlement conservation;
- audit/transaction/idempotency lineage;
- database cleanup after the test.

No production advertising credentials may be committed or embedded in fixtures.

## 6. Full verification record — to be completed by implementation

| Gate | Command / evidence | Result | Head / reference |
|---|---|---|---|
| Typecheck | `bun run typecheck` | PENDING | PENDING |
| Architecture | `bun run arch:check` | PENDING | PENDING |
| Authority | `bun run authority:check` | PENDING | PENDING |
| Full verify | `bun run verify` | PENDING | PENDING |
| Targeted mutation checks | W034 mutation driver | PENDING | PENDING |
| Source restoration | byte-identical restore checks | PENDING | PENDING |
| Secret scan | repository/W034 surface | PENDING | PENDING |
| PostgreSQL + Redis | configured integration suite | PENDING | PENDING |
| Real advertising round-trip | dedicated real-provider path | PENDING | PENDING |
| CI push | GitHub Actions | PENDING | PENDING |
| CI pull_request | GitHub Actions | PENDING | PENDING |

## 7. Changed-file policy

W034 should be composition/proof work. Any production-source file change must be justified against an existing missing composition hook and must preserve the frozen authority map. Any discovery of a genuinely missing domain primitive must STOP implementation of that feature and be reported as an explicit architecture/work-item gap rather than invented ad hoc.

Expected primary surfaces are:

- `spec/work-orders/NET-W034.md`
- `docs/net-w034-complete-advertising-lifecycle.md`
- W034 composition/integration tests and regression tests
- minimal composition-root test/harness adjustments only when required to invoke existing authorities

The implementation PR must explicitly list every changed source file and identify which existing authority it belongs to.

## 8. Merge gate

The architect will not approve until the repository demonstrates:

```text
AC-01..AC-10 green
+ exact traversal order proven
+ real PostgreSQL/Redis round-trip green
+ targeted mutations caught
+ source files restored byte-identically after mutation runs
+ arch:check clean
+ authority:check clean
+ privacy/secret boundaries clean
+ CI push green
+ CI pull_request green
+ no frozen architecture amendment
+ no W035/W036 scope leakage
+ exactly one implementation PR
```

A green test suite without the traversal proof, real-authority round-trip or architectural containment is insufficient.

## 9. Architect decision record

At activation, the architecture authority decision is:

> NET-W034 may proceed as a composition/proof milestone on Architecture v1.0 FROZEN. Existing W019–W023 authorities and W033 traversal-proof discipline are sufficient in principle. No new domain or authority is authorized. The implementation agent must first use existing contracts and `...WithinTx` primitives, and must surface any missing primitive instead of creating a local advertising authority.

This ledger becomes the implementation evidence of record after the implementation PR is reviewed and, if necessary, remediated on the same PR.
