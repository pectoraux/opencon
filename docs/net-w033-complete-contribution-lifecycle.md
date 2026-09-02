# NET-W033 Evidence Ledger — Complete contribution lifecycle

**Status:** IMPLEMENTED — full local verification gate GREEN  
**Issue:** #67  
**Dependencies:** NET-W014 + NET-W018 + NET-W023 + NET-W028 — merged/verified  
**Architecture:** v1.0 frozen (byte-identical — no shared-file amendment)  
**Implementation branch:** `feat/net-w033-complete-contribution-lifecycle`

## Scope

W033 is the Phase-9 end-to-end composition proof. ONE canonical contribution traverses the existing authoritative chain with no new authority, no new domain, no new source file:

```text
opportunity/contribution
  → /workflows lifecycle
  → /evidence Proof-of-Value
  → /outcomes measurement
  → /reputation
  → /settlement pending/mature
  → /benefits allocation
```

The entire W033 artifact set is composition tests (`tests/contribution-lifecycle/` — the shared harness + the full-path scenario + AC-01..AC-09 suites), the AC-10 regression suite (`tests/regression/`), and this ledger. Every mutation runs through an existing owning boundary; every cross-domain join is an existing sanctioned composition-root composite.

## Acceptance map

| AC | Required proof | Delivered |
|---|---|---|
| AC-01 | Opportunity/contribution eligibility + sanctioned submission | ✅ AC-01 (5 tests): the sanctioned submission (DRAFT v0, org-scoped, PoH eligibility evaluated), the ineligible claimant fail-closed (HELPFUL_CONTRIBUTION_VALIDATION), the cross-tenant scope mismatch fail-closed, the non-HELPFUL opportunity refusal, the structural port pin (creation + reads only — no W033-reachable state mutation) |
| AC-02 | `/workflows` sole lifecycle authority; bypasses fail closed | ✅ AC-02 (6 tests): the 10 legal transitions audited in order (tx-bound, version 10), the state-skip ILLEGAL_TRANSITION, the stale-writer CONCURRENT_TRANSITION, the non-authorized actor AUTHORIZATION (deny-by-default), the TERMINAL_STATE refusal, the structural no-second-state-machine pin |
| AC-03 | `/evidence` Proof-of-Value/provenance authority | ✅ AC-03 (6 tests): the VERIFIED PoV over /evidence-created records (derived grades, recorded commitments, authoritative aggregation), the deterministic frozen grade table, the SELF_REPORTED basis failing the ATTESTED-minimum policy (the caller-asserted grade bypass fails), the verify gate (aggregation + cryptographic attestation required), the structural no-grade/no-value-field input pin |
| AC-04 | `/outcomes` normalized measurement, anchor, uncertainty/provenance | ✅ AC-04 (6 tests): the VERIFIED measured outcome with the explicit IMMEDIATE anchor, uncertainty + provenance preserved on the observation, the full evidence lineage (outcome → observation → evidenceId → evidence → contribution), the server-derived rollup (exact chain-head ids), the finalize-without-rollup fail-closed gate, the verified-outcome subject read |
| AC-05 | `/reputation` authoritative contribution-derived reputation | ✅ AC-05 (6 tests): BOTH canonical inputs carry the server-derived "verified" basis, the fact-anchored snapshot covers both inputs with deterministic reproducible scores + digest, the non-verified-source input derives "indicated" (non-purchasable), the settlement→reputation join on a PENDING record fails closed (REPUTATION_VALIDATION), the nonexistent-source NOT_FOUND, the structural no-score/no-basis/no-weight input pin |
| AC-06 | `/settlement` verified contribution value through pending/mature path | ✅ AC-06 (7 tests): exactly ONE PENDING→MATURE record with reference sources resolved by /settlement's own gate, the maturation anchor + audit event, the HOLD risk control refusing the maturation (RISK_CONTROL, value stays PENDING, resolved → re-opens), the ACTIVE dispute refusing it (DISPUTE_CHALLENGE, review + resolution → re-opens), the NON-VERIFIED contribution recognition fail-closed (every other gate passed — the lifecycle gate is the sole blocker), the same-key recognition replay exactly-once, global conservation |
| AC-07 | `/benefits` composition with `/settlement` remaining economic authority | ✅ AC-07 (6 tests): the funding REFERENCES-only pool, the draw through the settlement reward primitive (MATURE→CONSUMED, balanced ledger postings, post-commit audit with the draw transaction lineage), the deterministic 3/2/1 plan (minor-unit conservation), the no-second-ledger containment (one reward allocation referenced by the benefit record), the privacy-preserving member view (own shares + aggregates only), the same-key allocation replay exactly-once |
| AC-08 | End-to-end lineage, audit, privacy, tenancy | ✅ AC-08 (6 tests): the full BACKWARD reconstruction from the benefit allocation through durable ids alone (every hop via its owning authority), exactly one auditable event per material stage (10 transitions, evidence, attestation, observation, recognition, maturation, 2 reputation inputs, allocation, draw), cross-tenant fail-closed (org-scoped reads clean, foreign pools indistinguishable NOT_FOUND, material mutations gated), the unauthorized pool-read AUTHORIZATION, the W031 portable proof disclosing ONLY aggregate dimension facts (no source ids/payloads), the payload-free audit reconstruction |
| AC-09 | Idempotency, concurrency, atomicity, rollback/fault injection | ✅ AC-09 (6 tests): same-key recognition + settlement-effect replay verbatim, the concurrent same-key allocation race (exactly one committed composite), the concurrent same-key recognition race (exactly one value record), the draw-failure fault injection at the critical join (NO partial mutation — no allocation, no draw, no consumption, NO audit event), the mid-path dispute-gate fault injection (value frozen PENDING, no partial final state; resolution completes the path), the post-commit audit ordering (transactionId + drawTransactionId + idempotencyRecordId) + conservation after every scenario |
| AC-10 | Architecture/authority/scope regression | ✅ AC-10 (10 tests): 0 violations across both guards (322 files), the frozen specs + the exact 33-directory src/ set, the work-order binding pins, the composed vocabularies pinned unchanged, NO source file added (the exact artifact list + directory), the composition-only structural pins (no repository writes), the no-W034/W035/W036 vocabulary bans, the composition-root wiring pins, the secret boundary, the no-W033-amendment frozen-file check |

**66 tests** across the 12 W033 files (the full-path scenario suite + the ten one-to-one AC suites + the shared harness).

## Verification record (executed on the implementation head)

- `bun run typecheck` — **PASS**
- `bun run arch:check` — **PASS: 322 files scanned, 0 violations**
- `bun run authority:check` — **PASS: 322 files scanned, 0 violations**
- `bun run verify` — **PASS: 2169 pass / 15 skip / 0 fail — 2184 tests / 277 files / 29,426 expect()** (the W032 baseline 2103/15/0 — 2118 tests ⇒ +66 W033 composition tests; every pre-existing suite preserved)
- Targeted mutation driver (`opencon-tmp-w033/mutation-driver.py`, never committed): **9/9 behavioral mutations CAUGHT** — M1 the recognition VERIFIED-lifecycle gate (runtime.ts), M2 the refuseWhenGated risk-control gate, M3 the refuseWhenDisputed dispute gate, M4 the settlement→reputation MATURE/CONSUMED gate, M5 the benefit-pool in-tx funding qualification gate (consumed + MATURE-state), M6 the /workflows optimistic-concurrency stale-writer gate, M7 the /evidence deterministic grade derivation, M8 the /outcomes finalize-requires-rollup gate, M9 the /reputation server-derived basis — each removed exactly one material guard of the composed chain, each targeted AC suite FAILED, each source restored byte-identically (cmp-verified) — plus the AC-10 structural pins PRESENT (the composition-root wiring pins for every composite the canonical path runs through)
- Secret scan — **CLEAN** (no key material in the W033 surface; `REQUIRED_IN_PRODUCTION` unchanged: `DATABASE_URL`, `REDIS_URL`, `OBJECT_STORAGE_BUCKET`; no new secret/config surface)
- Real PostgreSQL 17 + Redis integration (locally provisioned, the CI service-container equivalents): `PG_TEST_DATABASE_URL=postgres://…:55432/opencon_test REDIS_TEST_URL=redis://…:56379 bun test tests/integration/` — **17 pass / 0 fail**
- W033 real-PG end-to-end round-trip (`opencon-tmp-w033/real-pg-roundtrip.ts`, never committed): a DEDICATED round-trip database + a staging-classified runtime (the REAL provider-selection path — PostgresAuthorityAdapter + RedisCoordinationAdapter, no shims) + the same seeded guard/policy surface the W008→W028 harness chain builds + ONE contribution through the complete canonical chain — the terminal state verified (contribution VERIFIED v10, PoV VERIFIED, measured outcome VERIFIED, both reputation inputs verified-basis, value CONSUMED 100, the benefit allocation 100 across 3 members in minor units), 10 ordered transition audit events + the maturation/allocation events, global conservation over the 8 real ledger entries, the exhausted-pool fresh-key allocation failing closed — **ALL CHECKS PASSED**; the round-trip database dropped afterwards
- CI push event — **PASS** (run 33599585281: verify + integration, both jobs success, head `b4ccca1`)
- CI pull_request event — **PASS** (run 33599621567: verify + integration, both jobs success, head `b4ccca1`) — the PR #68 checks: 4/4 check-runs `success`

## Required design decisions to close before merge — CLOSED

1. **Canonical fixture.** ONE helpful contribution: an ACTIVE zero-budget W011 campaign publishing a HELPFUL_RECOMMENDATION opportunity (eligibility rule `participant_class equals contributor`), submitted through the sanctioned W012 helpfulness composite (the same path the apiCommand takes) by an eligible claimant. Deterministic anchors: `OCCURRED_AT = 2024-03-01` (the reputation decay anchor), `REFERENCE_AT = 2024-07-01` (the snapshot anchor) — never a wall clock.
2. **Sanctioned lifecycle path.** The publication composite (DRAFT→READY→ASSIGNED→IN_PROGRESS→SUBMITTED — user-controlled, contributor-only), then the six forward transitions MEASURING→EVALUATING→CHALLENGE_WINDOW→SETTLING→SETTLED→VERIFIED through `workflowService.requestTransition` with `policyActionFor` — the frozen table, never re-declared.
3. **Evidence/Proof-of-Value path.** The ATTESTED evidence basis (W012) + a VERIFIED PoV (W014 chain: platform + provider /evidence records, an independent moderator attestation, recorded aggregation, cryptographic verification) + the PoH bases attached through the helpfulness service.
4. **Normalized outcome.** A platform observation (confidence 0.95 [0.9, 0.98], explicit `evidenceId` link to the PoV's platform evidence) → measured outcome with the IMMEDIATE maturation strategy → recorded rollup → finalize → VERIFIED.
5. **Reputation mutation trigger.** The direct verified input (sources: the VERIFIED contribution + PoV + measured outcome, occurredAt OCCURRED_AT) + the sanctioned `applySettlementReputationEffect` join after maturation + the snapshot at the fixed reference anchor. Non-purchasability: the server-derived basis (an input over non-verified sources derives "indicated", capped + weight-discounted by the policy).
6. **Verified-value → settlement path.** The recognition composite (VERIFIED lifecycle + QUALIFIED PoH + moderation + quality floor gates → PENDING) then the maturation composite (risk/dispute-gated → MATURE), both through the runtime apiCommands; the risk (HOLD on value_maturation) and dispute (OPEN on the value record) gates exercised then resolved.
7. **W028 benefit path.** A /settlement reward policy mirroring the three members (3/2/1) + the benefits policy (credits, last_member_absorbs, funding REFERENCES only) + the pool funded by the MATURE value record + the atomic `allocatePoolBenefits` (the economic draw executes INSIDE /settlement: MATURE→CONSUMED with balanced postings); the lineage reconstructed backward from the allocation through durable ids without duplicating any economics (the benefit record carries the draw reference only).
8. **Atomic boundaries + the injected failure point.** The W028 allocation composite is ONE exactly-once economic unit (allocation + draw + consumption + audit commit together or not at all). Injected failures: (a) the draw failure at the critical join (a pre-consumed value record — the in-tx re-derivation fails closed, NO partial mutation survives); (b) the mid-path dispute gate (the maturation frozen at PENDING — no partial final state — then resolved).
9. **Concurrency/replay probes.** Same-key recognition, settlement-effect and benefit-allocation replays (created=false, identical record ids, single records everywhere); two concurrent same-key races (the benefit allocation — the economic unit; the recognition — the value record). No double application of contribution value, reputation mutation, settlement posting or benefit allocation.
10. **Lineage/audit contract + privacy/tenancy.** Every material object carries a durable id; every material stage leaves exactly one transactional audit event (published post-commit, tx-bound); the chain reconstructs backward from the benefit allocation through the owning authorities' reads alone; the portable surface (the W031 proof) discloses only aggregate dimension facts; the member view exposes own shares + pool aggregates; cross-tenant org-scoped reads resolve nothing and foreign pools read as nonexistent; material mutations are actor-gated.

All decisions reuse existing contracts — no missing primitive was discovered (nothing surfaced as an architectural/work-item gap).

## Design decisions of record

1. **Placement.** W033 ships ZERO source files: the harness + suites live in `tests/contribution-lifecycle/`, the regression suite in `tests/regression/`. The composition joins are the EXISTING composites (`publishHelpfulContribution`, `recognizeContributionValue`, `matureEconomicValue`, `applySettlementReputationEffect`, the W028 benefit economic draw) — no new join was written.
2. **The harness wraps the W014 chain** (the full helpful-contribution machinery) and adds exactly the missing composition surface: ACTIVE /organizations memberships for the three benefit-pool members (the sanctioned membership authority — the W024/W028 precedent), the W028 benefit transport guard actions, and the canonical scenario factory returning every durable identifier.
3. **The benefit-pool members** are the contributor (3), the moderator (2) and the W010 dedicated reviewer (1) — three DISTINCT persons of the same org (the moderator IS the W008 second person in this harness chain).
4. **The mutation discipline.** The mutation driver's M1 was initially masked by the composite's next gate (the PoH QUALIFIED check) — the AC-06 negative fixture was strengthened to a contribution passing EVERY OTHER gate (bases attached, PoH QUALIFIED, published) stopped at SUBMITTED, so the VERIFIED lifecycle gate is provably the sole blocker. M5 required removing the funding-qualification pair (the consumed + MATURE-state branches — defense in depth) because each alone is masked by the other; the settlement primitive's own gate still fails the draw closed behind them.
5. **The real-PG round-trip** uses the REAL provider-selection path (staging classification: `DATABASE_URL`/`REDIS_URL`/`OBJECT_STORAGE_BUCKET`/`ATTESTATION_SIGNING_KEY` resolved through the env-backed SecretProvider — the fail-closed production discipline), a dedicated per-run database, and the scenario factory over a duck-typed minimal harness surface (the same factory the suites use — no duplicated composition logic).
6. **The PG/Redis services** in this environment are the locally provisioned equivalents of the CI service containers; the `opencon` role + `opencon_test` database were (re)provisioned to match `docker-compose.yml` exactly.

## Implementation evidence

Implementation PR: #68 (the single W033 PR — head `b4ccca1`)  
Reviewed head: TBD  
Architect review: TBD  
Merge SHA: TBD

## Scope guard

W033 introduced NO W034 advertising lifecycle, NO W035 creator lifecycle, NO W036 demand/procurement lifecycle, NO new domain, NO second ledger, NO new crypto, NO second workflow engine, and NO new authority semantics — pinned by the AC-10 regression suite.
