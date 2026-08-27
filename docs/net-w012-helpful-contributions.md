# NET-W012 — Helpful contributions (evidence document)

**Work order:** `spec/work-orders/NET-W012.md`
**Architecture:** v1.0 (FROZEN — `spec/architecture.md` + `spec/architecture-lock.md` untouched)
**Canonical issue:** GitHub Issue #23 (closed by this work item's PR)
**Verification:** `bun run verify` — typecheck PASS, `arch:check` PASS (0 violations), unit + regression suites green; CI adds the real PostgreSQL/Redis integration suites.

## What shipped

1. **Core vocabulary** (`src/core/contributions.ts`): the closed
   provider-neutral helpful vocabularies (4 helpful opportunity/
   contribution kinds; `PENDING → QUALIFIED | NOT_QUALIFIED` PoH
   statuses; the three qualifying basis kinds `proof_of_value` /
   `measured_outcome` / `evidence_record`; qualifying source types
   `platform|attested|provider` — model/self NEVER qualify; advisory
   kinds with REQUIRED `methodRef`+`methodVersion`; 7 disclosure
   relationship kinds; `DECLARED → RETRACTED` disclosure states;
   `HELPFULNESS_POLICY_FORMAT = "NET-W012:1"`) + the PURE fail-closed
   `evaluateCampaignEligibility` evaluator — the FIRST consumer of
   the NET-W011 `campaign_policy:{id}:{version}:{specId}` reference.
2. **The `/contributions` helpful aggregate**: `HelpfulnessPolicy`
   (immutable versioned lineage under the org-independent
   `helpfulness_policy_lineage:{policyId}` mutex, cross-scope fork
   rejection including v1), `ProofOfHelpfulness` (created 1:1 with
   the helpful Contribution in ONE atomic transaction; pinned policy
   version; eligibility resolution; mentions; disclosure refs;
   advisory scores; bases; append-only evaluations; publication
   block) and `CommercialDisclosureRecord` (append-only, retract
   terminal).
3. **The PURE engine** (`src/contributions/poh-engine.ts`):
   deterministic qualification from resolved authority facts only —
   grade floor, confidence/uncertainty, VERIFIED-state gates for PoV
   and measured outcomes (with quantified rollup confidence and
   policy-qualifying outcome types), subject binding, tenant scope,
   independent-provenance counting, disclosure compliance and the
   publication gate.
4. **`HelpfulnessService`**: 17 methods, every material mutation
   through the NET-W004 IdempotencyStore primitive with per-record
   mutexes, in-tx state re-checks, replay tolerance and transactional
   audit lineage (10 `helpful_*`/`helpfulness_*`/`proof_of_helpfulness`
   audit types).
5. **Composition-root wiring**: five neutral read-only lookups over
   the owning domains' repositories (campaigns eligibility, evidence,
   measured outcomes, PoVs, opportunities); three authority
   collections (`helpfulness_policies`, `proofs_of_helpfulness`,
   `commercial_disclosures`); view mappers; 12 apiCommands including
   the `publishHelpfulContribution` composite (assertPublishable →
   the `/workflows` transition walk with compound `:t{n}` keys →
   recordPublication with `:record`).
6. **API surface**: 12 routes under `/api/helpfulness-policies` and
   `/api/helpful-contributions` guarded by 9 server actions.
7. **Tests**: the W012 harness (wraps the W011 harness; auto-
   provisions an ACTIVE helpful campaign with an eligibility rule)
   + 6 AC suites + the AC-07 architecture regression.

## Authority separation (decision of record)

```text
/campaigns   → campaign/objective configuration authority (READ via lookup)
/workflows   → contribution lifecycle authority (publication transitions at the composition root)
/evidence    → evidence truth authority (READ via lookup; never mutated)
/outcomes    → normalized measurement authority (READ via lookup; never mutated)
/settlement  → economic authority (UNTOUCHED — NET-W012 adds NO economic vocabulary)
/reputation  → trust-signal authority (UNTOUCHED)
```

The helpful layer does NOT become a hidden replacement for any
authority: it emits provider-neutral references and control decisions
through the composition root only.

## Key design decisions

1. **Domain placement**: helpful semantics live IN the frozen
   `/contributions` boundary on the W004 OPAQUE extension points
   (`ContributionType`/`ContributionSubmission` were explicitly
   reserved for "helpful contributions" in NET-W004). No 17th domain,
   no architecture amendment.
2. **NOT a `LifecycleSubjectKind`**: the Contribution remains the
   workflow subject; the PoH is DOMAIN-OWNED bookkeeping with its own
   administrative states (the NET-W010 dispute-record / NET-W011
   campaign-record precedent). No new transition-table rows.
3. **QUALIFIED is terminal**: a final evidenced claim is never
   silently rewritten — contradicting evidence is challenged through
   `/disputes` (NET-W010). NOT_QUALIFIED re-evaluates when new bases
   attach (append-only evaluation history).
4. **Mentions are structurally non-qualifying**: the engine receives
   mentions ONLY through the disclosure-compliance boolean; mentions
   have no weight, score, count or bonus path (lock §1 invariant 9 —
   including no sentiment field anywhere).
5. **AI is advisory, mechanically**: model/self source types and
   MODEL_ASSESSED/SELF_REPORTED grades never qualify; advisory scores
   never count toward any minimum and never flip outcomes; the
   policy minimum grade itself must be an actually-qualifying grade;
   advisory method identity (`methodRef`+`methodVersion`) is
   REQUIRED (the frozen measurement rule).
6. **Truth re-resolved at evaluation**: bases are cheap-verified at
   attach but the AUTHORITATIVE resolution happens inside
   `evaluateHelpfulness` through the neutral lookups — evaluation
   consumes fresh authority facts, never stale caller assertions.
7. **Publication is user-controlled, mechanically**: `assertPublishable`
   requires a PERSON actor == the contributor (system/service actors
   are rejected in the domain); preparation NEVER transitions state
   and is pre-publication only; the only publication path is the
   composition-root composite through `/workflows`.
8. **Zero economic footprint**: NET-W012 adds NO economic vocabulary
   and NO settlement touchpoint — the verified-usefulness claim
   (QUALIFIED PoH) is what NET-W014's clearing will consume later.

## Invariant → enforcement map

| Invariant (work order §4) | Enforcement |
|---|---|
| 1. Mention ≠ helpfulness | Engine input shape (mentions → disclosure boolean ONLY); `net-w012-ac-03` |
| 2. Helpfulness is evidenced | `minimumQualifyingBases`+`minimumIndependentSources` over re-resolved authority facts; `net-w012-ac-02`/`ac-03` |
| 3. AI is advisory | Qualifying-source-type rule; grade floor; advisory never counted; `net-w012-ac-04` |
| 4. Publication user-controlled | Person-actor==contributor gate; prepare never transitions; composite-only path; `net-w012-ac-05` |
| 5. Disclosure explicit/auditable | First-class records, append-only, publication+evaluation gates; `net-w012-ac-05` |
| 6. Authority separation | Denylist + domain-import regressions; composition-root pins; `net-w012-ac-07` |
| 7. Atomicity/tenancy | IdempotencyStore exactly-once; mutexes; org scope everywhere; `net-w012-ac-06` |

## API surface

| Route | Guard action | Command |
|---|---|---|
| POST `/api/helpfulness-policies` | `helpfulness.policy` | defineHelpfulnessPolicy |
| GET `/api/helpfulness-policies/:policyId` | — (public) | listHelpfulnessPolicies |
| POST `/api/helpful-contributions` | `helpful_contribution.create` | createHelpfulContribution |
| GET `/api/helpful-contributions/:id` | — (public) | getHelpfulContribution |
| POST `/api/helpful-contributions/:id/recommendation` | `helpful_recommendation.prepare` | prepareHelpfulRecommendation |
| POST `/api/helpful-contributions/:id/publish` | `helpful_contribution.publish` | publishHelpfulContribution (composite) |
| POST `/api/helpful-contributions/:id/disclosures` | `helpful_disclosure.declare` | declareCommercialDisclosure |
| POST `/api/helpful-contributions/:id/disclosures/:disclosureId/retract` | `helpful_disclosure.retract` | retractCommercialDisclosure |
| GET `/api/helpful-contributions/:id/disclosures` | — (public) | listCommercialDisclosures |
| POST `/api/helpful-contributions/:id/advisory-scores` | `helpful_advisory.record` | attachHelpfulAdvisoryScore |
| POST `/api/helpful-contributions/:id/bases` | `helpful_poh.basis` | attachHelpfulnessBasis |
| POST `/api/helpful-contributions/:id/evaluate` | `helpful_poh.evaluate` | evaluateHelpfulness |

## AC → test mapping

| AC | Criterion | Suite |
|---|---|---|
| NET-W012-AC-01 | first-class durable scoped records | `tests/contributions/net-w012-ac-01-records.test.ts` (10) |
| NET-W012-AC-02 | explicit deterministic evidence-backed criteria | `tests/contributions/net-w012-ac-02-policy-and-engine.test.ts` (14) |
| NET-W012-AC-03 | mention alone has no reward authority | `tests/contributions/net-w012-ac-03-mention-not-helpfulness.test.ts` (5) |
| NET-W012-AC-04 | advisory scoring cannot bypass | `tests/contributions/net-w012-ac-04-advisory.test.ts` (7) |
| NET-W012-AC-05 | user-controlled publication + explicit disclosure | `tests/contributions/net-w012-ac-05-publication-disclosure.test.ts` (10) |
| NET-W012-AC-06 | atomicity/idempotency/concurrency/tenancy/audit | `tests/contributions/net-w012-ac-06-atomicity-tenancy.test.ts` (7) |
| NET-W012-AC-07 | architecture/out-of-scope regression | `tests/regression/net-w012-ac-07-architecture-out-of-scope.test.ts` (12) |

No shared regression baselines required amendment: `contributions`
was already non-skeletal (NET-W004) and remains in
`NET_W004_DOMAINS`; the module summary keeps BOTH `NET-W004` and
`NET-W012`; the frozen economic vocabulary and the lifecycle subject
kinds are UNCHANGED (pinned by this regression).
