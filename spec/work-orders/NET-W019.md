# NET-W019 — Inventory and placements

**Status:** implemented
**Architecture:** v1.0 (FROZEN) — `spec/architecture.md`, `spec/architecture-lock.md`
**Requirements:** INV-001..004, CAMP-003..004
**Dependencies:** NET-W002 (merged), NET-W011 (merged)
**Issue:** #37
**Backlog provenance:** `spec/work-items.md` — "Implement publisher/app/creator inventory, placement context, authorization and supply provenance."

## §1 Objective

Implement publisher/app/creator inventory, placement context, authorization and supply provenance without introducing a second campaign, economic, workflow, evidence, reputation, risk, or external-platform authority.

## §2 Authority separation (the decision of record)

```text
/inventory    → inventory domain rules: supply REGISTRATION (the
                InventoryItem — explicit registered ownership +
                provider-neutral external reference + declared supply
                attributes) and placement CONTEXT (the
                PlacementRecord — policy-scoped campaign binding +
                the provenance source-context snapshot + the DERIVED
                placement-eligibility evaluation)
/campaigns    → campaign policy authority: the placement references
                a campaign + PINNED policy version resolved READ-ONLY
                through the neutral InventoryCampaignLookup (the
                NET-W018 CampaignDisclosurePolicyLookup precedent);
                the eligibility RULES are the campaign policy's own
                section — this boundary only EVALUATES them
/workflows    → lifecycle authority — COMPLETELY UNTOUCHED by
                NET-W019: NO new lifecycle subject kind, NO
                transition-table change, NO sanction, NO delegated
                transition. Supply withdrawal and placement
                retirement are ONE-WAY field mutations (the NET-W018
                commercial-relationship termination precedent), never
                status machines
/evidence     → truth authority: the OPTIONAL supply-verification
                signal (INV-003) is a canonical evidence reference
                subject-bound to the inventory item
                (subjectType "inventory_item"), validated through the
                neutral evidence lookup — never fabricated here
/settlement   → economic authority: NO economic command exists in
                the inventory boundary (no balances, no postings, no
                reward/credit/cash surface). The settlement gate is
                the DERIVED PlacementSettlementReadiness view (INV-004)
/adapters     → external platform execution (out of scope: the
                external reference descriptor is provider-neutral —
                provider id + external id + url only; credentials
                stay behind /secrets + /adapters)
```

### The NO-17TH-DOMAIN resolution (issue #37's architecture guard)

The frozen architecture ALREADY names `/inventory` as one of the
sixteen frozen core domains — `spec/architecture.md` §18 (the
module-ownership row "`/campaigns`, `/inventory`, `/creators`") and
`spec/architecture-lock.md` §2 (the sixteen frozen core domains). The
NET-W001 boundary skeleton was explicitly deferred to "NET-W019"
(`src/inventory/README.md`, pre-W019). The compliant home for
inventory semantics is therefore the EXISTING `/inventory` boundary:
NET-W019 implements INSIDE it and creates NO 17th domain — no Change
Request is needed. The regression suite pins this exactly (the lock
still lists `- `/inventory``; NO `/placements`, `/supply` or
`/advertising` boundary appears).

NET-W019 must not create a second ledger, payment authority,
reputation authority, lifecycle engine, evidence authority, risk
authority or platform-ownership layer.

## §3 Scope — the implemented design

### §3.1 Inventory items — registered supply (INV-001; AC-01)

`InventoryItem` (in `/inventory`): the first-class, durable,
tenant-scoped record of registered supply with EXPLICIT OWNERSHIP —
`ownerPersonId` is the ACTING PERSON at registration. There is
structurally NO `ownerPersonId` input on any command (the
no-fabrication pin — invariant 3): a caller cannot register supply on
behalf of someone else. The record carries:

- the closed-vocabulary surface kind (`publisher`, `app`, `creator` —
  INV-001 "publisher/app/creator inventory"; the kinds describe WHO
  operates the surface, never a specific platform);
- the closed-vocabulary format (`display`, `video`, `audio`,
  `native`, `sponsored_content` — INV-002 "record inventory format");
- a provider-neutral external reference (provider id + external id +
  url — CAMP-003 ad-ecosystem interop; optional/null is legitimate);
- declared supply attributes (non-empty canonical sets of ISO-3166-1
  alpha-2 territory codes + language tags — the eligibility
  derivation's input);
- the OPTIONAL supply-verification evidence reference (INV-003 — see
  §3.4);
- a one-way withdrawal (`retiredAt` — the conservative direction: a
  retired item's placements are never settlement-ready, derived).

The record is STATIC after registration except the one-way withdrawal
and the one-time verification attachment — both owner-only, both
audited.

### §3.2 Placements — the policy-scoped placement context (INV-002; AC-02)

`PlacementRecord` (in `/inventory`): the explicit, durable,
policy-scoped placement context binding a registered inventory item
to a campaign at a PINNED policy version (explicit pin or
latest-at-creation — the pinned-or-latest precedent; the resolved
version is recorded). It carries:

- the placement's DECLARED context attributes (a NARROWING of the
  item's supply — validated in-tx against the durable item; a
  placement cannot widen the declared reach);
- the PROVENANCE SOURCE CONTEXT (§3.2.1) — server-written, never
  caller-input;
- the DERIVED placement-eligibility evaluation (§3.3) — recorded as
  the deterministic snapshot;
- a one-way retirement (`retiredAt`).

ONE ACTIVE (non-retired) placement per (item, campaign) — a second is
a stable `PLACEMENT_CONFLICT`; a RETIRED placement never blocks
re-placement (supply may re-enter a campaign under a later policy
version). Concurrent placements racing the same pair serialize
through the advisory pair lock + the in-tx conflict check (the W018
subject-lock precedent).

#### §3.2.1 The source context — the provenance snapshot

`PlacementSourceContext`: the durable supply identity (registered
owner, surface kind, format, external reference) frozen at placement
creation + the policy-scope pin (campaign id + policy version).
Written ONLY by the service from durable records — there is NO caller
input for any source-context field (a caller cannot fabricate
provenance — invariant 3).

### §3.3 The derived placement eligibility (INV-002; AC-02/AC-03)

The PURE derivation engine (`src/inventory/eligibility-engine.ts` —
the disclosure-engine precedent: deterministic, machine-readable,
caller-input-free; every input is a DURABLE RECORD):

```text
eligible(rules, context) = ∀ rule: satisfied(rule, context)
```

- SET semantics: a rule is satisfied iff EVERY value the placement
  context offers satisfies the rule (no partial placement sneaks a
  disallowed value through);
- `region` rules evaluate against the context territories; `language`
  rules against the context languages; operators `equals`,
  `not_equals`, `in`, `not_in` are evaluated; `gte`/`lte` are NOT
  applicable to unordered supply attributes → conservatively not
  satisfied;
- a rule over ANY OTHER campaign-eligibility attribute
  (`participant_class`, `contribution_type`, `evidence_grade`,
  `measurement_kind`) is NOT satisfiable by inventory supply — the
  supply carries no such attribute, so the honest evaluation is
  `attribute_not_carried_by_supply` → the placement is recorded as
  INELIGIBLE under that policy version (provenance, never
  fabrication — a caller cannot fabricate placement eligibility);
- an EMPTY rule set qualifies (an open campaign).

The result is snapshotted at placement creation (all inputs are
immutable after creation — items are static, policy versions are
append-only — so the snapshot can never drift; the AC-02 suite pins
snapshot == live re-derivation) and RE-DERIVED live by the settlement
readiness view (never trusted from storage).

### §3.4 The supply-verification signal (INV-003; AC-03)

`attachSupplyVerification` (owner-only, ONE-TIME — stable provenance):
attaches a canonical `/evidence` reference proving the supply
verification, validated through the neutral evidence lookup
(existence + tenant scope + EXACT subject binding: `subjectType
"inventory_item"`, `subjectId == itemId`) — supply proof cannot be
fabricated in the inventory domain. Canonical evidence records may
bind to `"inventory_item"` subjects (the runtime's SubjectLookup
resolves them — the W017 `ugc_production` / W018 `publication`
precedent). The signal is OPTIONAL ("where available"): the readiness
view REPORTS it but the INV-004 checks are the registered owner +
available supply + active placement + policy scope + eligibility.

### §3.5 THE SETTLEMENT GATE — the derived readiness (INV-004; AC-04)

`getPlacementSettlementReadiness`: the DERIVED
`PlacementSettlementReadiness` — the validated source context a
settlement-affecting consumer must require before inventory may
settle. A PURE derivation over CURRENT durable records on every read:

```text
eligible = registered_owner ∧ supply_available ∧ placement_active
           ∧ policy_scope ∧ eligibility_satisfied
```

- `registered_owner` — the durable item resolves in the tenant scope
  with its registered owner (INV-004 "registered owner/source");
- `supply_available` — the item is not withdrawn;
- `placement_active` — the placement is not retired;
- `policy_scope` — the pinned campaign policy version resolves in the
  tenant scope AND the campaign is in a PUBLISHABLE administrative
  status (ACTIVE — the live W011 status machine; a paused/completed/
  cancelled/draft campaign scope blocks settlement; a resumed
  campaign re-opens it — "corresponding downstream authority
  checks");
- `eligibility_satisfied` — the §3.3 engine RE-DERIVED against the
  pinned version's rules (never the stored snapshot).

There is NO command that asserts, stores or waives readiness (the
verify-input pattern of W018 generalized: readiness exists only as a
derivation), and the inventory boundary carries NO economic surface
at all (no balances, no postings, no reward/credit/cash commands —
structural + behavioral pins; /settlement stays the economic
authority). The no-bypass proofs: an invalid source context (item
withdrawn, placement retired, campaign paused, ineligible supply,
unresolvable scope) deterministically yields `eligible: false` with
machine-readable per-check detail, and the view is a PURE read (no
mutation, no audit).

### §3.6 Composite atomicity (the W017/W018 standard, simplified)

NET-W019 has NO cross-authority transition (no workflow twin is
needed — /workflows is untouched), so every material mutation commits
as ONE authoritative transaction (a single `applyIdempotent`: the
record + the idempotency record + the transactional audit event
commit together or not at all). Fault-injection evidence:
`tests/inventory/net-w019-inventory-atomicity.test.ts` (the
authoritative COMMIT fails → NOTHING survives — no record, no audit;
the healthy retry converges deterministically).

### §3.7 API + composition

Guarded commands (`POST /api/inventory/...`): item registration
(`inventory.items.register`), item retirement
(`inventory.items.retire`), supply-verification attachment
(`inventory.items.attachSupplyVerification`), placement creation
(`inventory.placements.create`), placement retirement
(`inventory.placements.retire`); plus tenant-scoped reads (item/
placement/list views + `GET .../placements/:id/settlement-readiness`
— the derived gate). The composition root wires the inventory service
with thin READ-ONLY lookups over the OWNING domains' repositories
(the campaign policy scope over the campaigns repos; the evidence
lookup over the evidence repository) and the inventory_item subject
binding in the evidence SubjectLookup. NO economic/reputation/risk/
outcome mutation, NO AI path.

## §4 Key invariants (issue #37) — enforcement map

| # | Invariant | Enforcement |
|---|-----------|-------------|
| 1 | Inventory ownership/identity is explicit and tenant-scoped | `InventoryItem` with `ownerPersonId` = the acting person (NO owner input exists) + org-scoped reads (cross-scope = NotFoundError); AC-01 suite |
| 2 | Placement context is durable, policy-scoped and provenance-aware | `PlacementRecord` with the pinned policy version + the server-written `PlacementSourceContext` snapshot + the recorded deterministic eligibility evaluation; AC-02 suite |
| 3 | Authorization is server-enforced; caller claims cannot fabricate supply ownership, placement eligibility or campaign scope | owner-only mutations checked against the DURABLE item; eligibility DERIVED by the pure engine (no input exists); campaign scope resolved through the neutral lookup (cross-scope = NotFoundError); AC-03 suite |
| 4 | Inventory cannot settle without a valid source context and corresponding downstream authority checks | THE SETTLEMENT GATE (§3.5): the derived readiness view (registered owner + available supply + active placement + publishable policy scope + satisfied eligibility, re-derived from CURRENT durable records); NO economic command exists (structural + behavioral pins); AC-04 suite |
| 5 | No second campaign/economic/workflow/evidence/reputation/risk authority is introduced | /workflows COMPLETELY untouched (subject-kind union + tables + sanctions pinned UNCHANGED); no economic/reputation/risk/outcome mutation surface (pattern pins); the pure engine is the disclosure-engine precedent; AC-07 suite |
| 6 | Provider-neutral platform semantics stay behind neutral adapters; credentials remain behind secrets/adapters | the provider-neutral external reference descriptor (provider/externalId/url only); no credential/secret access in the domain; no bid-protocol/platform-API vocabulary; AC-05 suite |
| 7 | Idempotency, concurrency, PostgreSQL authority and transactional audit lineage hold | applyIdempotent on every mutation (same-key replays are deterministic no-ops); the (item, campaign) advisory pair lock + the in-tx conflict check serialize racing placements; authority-backed repositories (inventory_items/placements collections); buffered transactional audit with lineage; AC-06 + atomicity suites |
| 8 | Frozen architecture and architecture lock remain unchanged | NO 17th domain (the §2 resolution — /inventory was already frozen); the lock's domain list unchanged; the architecture + authority guards pass with every W019 file; AC-07 suite |

## §5 Explicit non-goals (unchanged from the issue)

No cross-promotion clearing (NET-W020), no campaign
matching/optimization (NET-W021), no attribution/privacy measurement
adapters (NET-W022), no OpenRTB/external-supply integration
(NET-W023), no external payment execution, no decentralized
consensus, and no demand/procurement/benefit pools (NET-W024+). The
placement record's CAMP-004 relevance is REPRESENTATION ONLY — the
non-reciprocal exchange semantics arrive with NET-W020 consuming
these records.

## §6 Acceptance-criteria → test map

| AC | Test file |
|----|-----------|
| 1 — first-class, durable, tenant-scoped, ownership-aware inventory | `tests/inventory/net-w019-ac-01-inventory-records.test.ts` |
| 2 — explicit, provenance-aware, policy-scoped placement context | `tests/inventory/net-w019-ac-02-placement-context.test.ts` |
| 3 — server-enforced supply authorization (ownership, eligibility, campaign scope, evidence binding) | `tests/inventory/net-w019-ac-03-supply-authorization.test.ts` |
| 4 — settlement-affecting consumers require valid inventory source context; no bypass to /settlement | `tests/inventory/net-w019-ac-04-settlement-gate.test.ts` |
| 5 — provider-neutral boundaries and secret isolation remain intact | `tests/inventory/net-w019-ac-05-provider-neutrality.test.ts` |
| 6 — idempotency/concurrency/transactional audit guarantees | `tests/inventory/net-w019-ac-06-tenancy-idempotency.test.ts` |
| 7 — architecture/out-of-scope regression with frozen Architecture v1.0 unchanged | `tests/regression/net-w019-ac-07-architecture-out-of-scope.test.ts` (incl. THE NO-17TH-DOMAIN PIN + the /workflows-untouched pins) |
| (mutation atomicity — the W017/W018 standard) | `tests/inventory/net-w019-inventory-atomicity.test.ts` |

## §7 Verification

`bun run verify`: typecheck + `arch:check` + `authority:check` + unit
tests + configured integration tests. The full suite result is
recorded in `docs/net-w019-inventory-placements.md` (evidence
document): every AC maps to automated tests and changed files.
