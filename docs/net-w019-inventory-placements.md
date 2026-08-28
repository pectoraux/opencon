# NET-W019 — Inventory and placements: implementation evidence

**Work order:** `spec/work-orders/NET-W019.md`
**Issue:** #37 (READY_FOR_IMPLEMENTATION)
**Architecture:** v1.0 (FROZEN) — unchanged; `/inventory` is one of
the SIXTEEN frozen core domains (the NO-17TH-DOMAIN resolution — see
work order §2)
**Requirements:** INV-001..004, CAMP-003..004

## §1 What was implemented

- **`src/core/inventory.ts`** (NEW) — the shared inventory
  vocabulary: surface kinds (`publisher`/`app`/`creator`), formats
  (`display`/`video`/`audio`/`native`/`sponsored_content`), bounds
  (territories/languages/external-reference/prose), the
  `NET-W019:1` format lineage, the stable errors
  (`INVENTORY_VALIDATION`, `PLACEMENT_CONFLICT`) and the pure
  validators (territories/languages/subset check).
- **`src/inventory/port.ts`** (REWRITTEN from the W001 skeleton) —
  the full boundary contract: `InventoryItem`, `PlacementRecord`
  (+ `PlacementSourceContext` + `PlacementEligibilityEvaluation`),
  the inputs/results, the neutral lookups
  (`InventoryCampaignLookup`, `InventoryEvidenceLookup`), the
  repositories, `InventoryService`, and the `InventoryPort`
  (readiness `"ready"` + the audit event types).
- **`src/inventory/eligibility-engine.ts`** (NEW) — the PURE
  placement-eligibility derivation (set semantics; conservative on
  non-supply attributes and inapplicable operators; machine-readable
  rule results).
- **`src/inventory/inventory-service.ts`** (NEW) — the domain
  service: register/withdraw supply, attach supply verification,
  record/retire placements (owner-enforced, in-tx preconditions, the
  (item, campaign) advisory pair lock + create-once conflict), and
  the DERIVED settlement readiness (§3.5 of the work order —
  THE SETTLEMENT GATE).
- **`src/inventory/authority-inventory-repositories.ts`** (NEW) —
  the PostgreSQL-authority-backed repositories (collections
  `inventory_items` + `placements`; one-way withdrawal/retirement +
  one-time verification attachment).
- **`src/inventory/module.ts` / `index.ts` / `README.md`** — the
  boundary graduates from the W001 skeleton to readiness (the
  W004-ac-08/W001-ac-08 regression lists updated per the
  every-shipping-work-order precedent).
- **`src/bootstrap/runtime.ts`** — the composition root wiring: the
  authority repos, the thin READ-ONLY campaign-policy-scope +
  evidence lookups over the OWNING domains' repositories, the
  service, the view builders, the API commands, and the
  `inventory_item` evidence subject binding (the INV-003 signal).
- **`src/api/port.ts` + `src/api/server.ts`** — 5 guarded commands
  (`inventory.items.register` / `inventory.items.retire` /
  `inventory.items.attachSupplyVerification` /
  `inventory.placements.create` / `inventory.placements.retire`) +
  5 tenant-scoped reads (item/placement/list views + the derived
  `settlement-readiness` gate view).
- **Tests** — the W019 harness + 6 AC suites + the atomicity suite +
  the AC-07 regression suite (see §3).
- **Docs** — this evidence document + the work order
  (`spec/work-orders/NET-W019.md`).

## §2 The authority decisions of record (work order §2)

1. **NO 17th domain** — `/inventory` was ALREADY frozen (architecture
   §18/§7 + lock §2); NET-W019 implements INSIDE it. Pinned by
   AC-07 (the lock still lists `- `/inventory``; no `/placements`,
   `/supply` or `/advertising` boundary appears).
2. **/workflows COMPLETELY untouched** — NO new lifecycle subject
   kind, NO transition-table change, NO sanction, NO delegated
   transition. Items and placements carry NO lifecycle state;
   withdrawal/retirement are one-way field mutations (the W018
   commercial-relationship termination precedent). Pinned by AC-07
   (the subject-kind union, every transition table and the sanction
   vocabulary are pinned UNCHANGED; no transition machinery in the
   inventory domain).
3. **/campaigns stays the campaign policy authority** — the placement
   references a pinned policy version resolved READ-ONLY through the
   neutral `InventoryCampaignLookup`; the eligibility rules are the
   campaign policy's own section — the inventory boundary only
   EVALUATES them (the pure engine; no policy duplication).
4. **/evidence stays the truth authority** — the supply-verification
   signal is a canonical, subject-bound evidence reference
   (INV-003), validated through the neutral lookup; never fabricated.
5. **/settlement stays the economic authority** — NO economic command
   exists in the inventory boundary; THE SETTLEMENT GATE is the
   DERIVED readiness view (INV-004), re-derived from CURRENT durable
   records on every read.

## §3 Acceptance criteria → automated tests → changed files

| AC | Test file | Primary changed files |
|----|-----------|----------------------|
| 1 — first-class, durable, tenant-scoped, ownership-aware inventory | `tests/inventory/net-w019-ac-01-inventory-records.test.ts` (8 tests: durability/re-read, owner = acting person, vocabularies, attributes, external-reference bounds, one-way owner-only withdrawal, tenant isolation, audit lineage) | `src/core/inventory.ts`, `src/inventory/port.ts`, `src/inventory/inventory-service.ts`, `src/inventory/authority-inventory-repositories.ts` |
| 2 — explicit, provenance-aware, policy-scoped placement context | `tests/inventory/net-w019-ac-02-placement-context.test.ts` (8 tests: explicit record + pin, pinned-or-latest, source-context snapshot, context-narrowing, create-once conflict + retirement re-open, recorded deterministic eligibility, snapshot==re-derivation, audit provenance) | `src/inventory/port.ts`, `src/inventory/inventory-service.ts`, `src/inventory/eligibility-engine.ts` |
| 3 — server-enforced supply authorization | `tests/inventory/net-w019-ac-03-supply-authorization.test.ts` (5 tests: owner-only placement/withdrawal/attachment/retirement, cross-scope campaign = NotFound, derived eligibility (non-supply attributes, inapplicable operators, set semantics), evidence subject-binding matrix) | `src/inventory/inventory-service.ts`, `src/bootstrap/runtime.ts` (the lookups + the subject binding) |
| 4 — settlement-affecting consumers require valid source context; no bypass | `tests/inventory/net-w019-ac-04-settlement-gate.test.ts` (8 tests: golden path, withdrawn supply, retired placement, DRAFT/PAUSED/COMPLETED policy scope (+ resume re-opens), ineligible re-derivation, the pure-read proof, the no-economic-command surface pin) | `src/inventory/inventory-service.ts`, `src/inventory/port.ts` |
| 5 — provider-neutral boundaries + secret isolation | `tests/inventory/net-w019-ac-05-provider-neutrality.test.ts` (6 tests: descriptor shape, uniform provider handling, no bid-protocol/platform-API vocabulary, no secret access, record-shape proof, canonical-evidence reference) | `src/core/inventory.ts`, `src/inventory/*` |
| 6 — idempotency/concurrency/audit | `tests/inventory/net-w019-ac-06-tenancy-idempotency.test.ts` (5 tests: tenant isolation matrix, same-key replays for every command, concurrent same-pair race → exactly one winner, audit lineage, PostgreSQL authority persistence) | `src/inventory/inventory-service.ts`, `src/inventory/authority-inventory-repositories.ts` |
| 7 — architecture/out-of-scope regression | `tests/regression/net-w019-ac-07-architecture-out-of-scope.test.ts` (10 tests: authority guard 0 violations, THE NO-17TH-DOMAIN PIN, the work-order binding, vocabulary pins + every frozen vocabulary UNCHANGED, no lifecycle machinery, the pure engine, no AI path, no settlement bypass, wiring pins, non-goal fences, the file list) | `tests/regression/net-w019-ac-07-architecture-out-of-scope.test.ts` |
| (atomicity — the W017/W018 standard) | `tests/inventory/net-w019-inventory-atomicity.test.ts` (2 fault-injection tests: authoritative COMMIT fails → NOTHING commits; healthy retry converges) | `src/inventory/inventory-service.ts` |
| (W001/W004 graduation regressions — the every-work-order precedent) | `tests/regression/ac-08-no-premature-domain-logic.test.ts` (inventory joins NET_W019_DOMAINS; non-skeletal + NET-W019 summary pins), `tests/regression/net-w004-ac-08-architecture-out-of-scope.test.ts` (inventory leaves DEFERRED_DOMAINS) | `src/inventory/module.ts`, `src/inventory/README.md` |

## §4 The settlement gate — how INV-004 is enforced

`getPlacementSettlementReadiness` (service + API) derives, from
CURRENT durable records on every read:

```text
eligible = registered_owner ∧ supply_available ∧ placement_active
           ∧ policy_scope ∧ eligibility_satisfied
```

with machine-readable per-check detail, the validated source context
(the consumer contract) and the INV-003 verification signal. There is
NO command that asserts, stores or waives readiness (the W018
verify-input no-bypass pattern generalized), and the inventory
boundary carries NO economic surface at all (AC-04 + AC-07 structural
+ behavioral pins). The NET-W020 cross-promotion clearing work item
will consume this contract.

## §5 Verification results

`bun run verify` (the reproducible command):

- `bun run typecheck` — PASS (`tsc --noEmit`, 0 errors)
- `bun run arch:check` — PASS (261 files scanned, 0 violations)
- `bun run authority:check` — PASS (261 files scanned, 0 violations)
- `bun test` — **1289 pass / 15 skip / 0 fail** (12,968 `expect()`
  calls; 1304 tests / 160 files; ~32s). Baseline before NET-W019
  (main @ 4025130): 1235 pass / 15 skip / 0 fail — NET-W019 adds 54
  passing tests and breaks nothing.

## §6 Out-of-scope confirmation

No cross-promotion clearing, campaign optimization, attribution/
privacy adapters, OpenRTB integration, external payment execution,
decentralized consensus, or demand/procurement/benefit pools — all
pinned by the AC-07 non-goal fences. No spec/architecture*.md
modification (the lock is byte-identical; AC-07 pins it). No secrets
committed. The frozen architecture and the sixteen-domain list are
UNCHANGED.
