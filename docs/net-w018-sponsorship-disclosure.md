# NET-W018 — Sponsorship and disclosure: evidence document

**Work order:** `spec/work-orders/NET-W018.md`
**Issue:** #35 · **PR:** #36 (remediated after architect CHANGES
REQUESTED — see §4a)
**Architecture:** v1.0 (FROZEN) — `spec/architecture.md` and `spec/architecture-lock.md` UNCHANGED (pinned by `tests/regression/net-w018-ac-07-architecture-out-of-scope.test.ts`).

## §1 What shipped

The creator-network disclosure layer: explicit commercial
relationships (DISC-001), versioned campaign disclosure policy
(CRE-006), evidence-bound creator disclosure declarations (DISC-002
mechanism), and the publication lifecycle subject whose
DRAFT → VERIFIED transition is THE DISCLOSURE GATE — the derived,
caller-unoverridable enforcement that publication cannot proceed
while required disclosure obligations remain unsatisfied.

The authority placement (the work order §2 decision of record):

- `/creators` owns the RECORDS: `CommercialRelationship`,
  `DisclosureDeclaration`, `PublicationRecord` (the publication's
  LifecycleSubject surface feeds `/workflows`);
- `/campaigns` owns the POLICY: the `disclosurePolicy` section of
  the versioned campaign policy (additive, format-compatible);
- `/workflows` owns the LIFECYCLE: the new `publication` subject
  kind with a ONE-rule GENERIC transition table (DRAFT → CANCELLED)
  and a SEPARATE sanctioned table holding the disclosure-gate edge
  (DRAFT → VERIFIED with `requiresEvidenceReference` + the frozen
  `creators.publication-verification` sanction — §4a); the
  canonical state vocabulary is UNTOUCHED (publication reuses
  DRAFT/VERIFIED/CANCELLED — the W005/W006 precedent);
- `/evidence` stays the truth authority (canonical, subject-bound
  `"publication"` evidence — never fabricated in `/creators`);
- `/settlement` stays the economic authority (relationship
  compensation is REFERENCE DATA ONLY);
- `/disputes` stays the risk authority (a challenged disclosure is a
  case referencing the publication — no local lifecycle branch).

## §2 The disclosure gate (the core invariant)

```text
required   = campaignPolicy.requiredKinds ∪ relationship.obligations
satisfied(kind) = ∃ evidence-bound declaration for THIS publication
publication verified ⟺ required ⊆ satisfied ∧ ≥1 subject-bound
                            publication evidence
```

Every input is a durable record: the versioned campaign policy
(resolved at the engagement's PINNED policy version — a later
version dropping requirements does not weaken an engagement created
under a stricter one), the commercial relationship's obligations
(union — obligations can only be ADDED), and the append-only
declarations. There is NO caller input that asserts compliance or
waives an obligation (structurally pinned — the verify input is the
five neutral fields; extra fields are ignored). Unsatisfied
obligations raise the stable `DISCLOSURE_OBLIGATIONS_UNSATISFIED`
error with machine-readable required/satisfied/missing sets.

The gate is also STRUCTURALLY unreachable as a transition: the
DRAFT → VERIFIED edge is absent from the generic workflow table, so
no caller — however authorized — can request it through
`/api/workflows/transitions` or `WorkflowService.requestTransition`
(§4a).

## §3 Invariant → enforcement map

See `spec/work-orders/NET-W018.md` §4 (the nine issue invariants,
each mapped to its enforcement mechanism + AC test).

## §4 Composite atomicity (built in from the start)

Per the NET-W017 remediation decision of record (architect CHANGES
REQUESTED on PR #34 — cross-authority composites must commit as ONE
authoritative transaction), the verification composite is
single-transaction from day one: the material verification
bookkeeping AND the DRAFT → VERIFIED transition execute inside ONE
`applyIdempotent` through the sanctioned in-tx `/workflows` twin.
Fault-injection evidence
(`tests/creators/net-w018-composite-atomicity.test.ts`):

1. **transition failure** (runtime twin monkey-patched to throw,
   cp-backup discipline): gate passed + bookkeeping staged →
   transition fails → NOTHING survives (publication stays DRAFT, no
   evidence, no audit) → healthy retry converges;
2. **authorization denial** (deny-by-default on the twin): NOTHING
   survives;
3. **authoritative commit failure** (CommitFailingTransaction
   wrapper, the W006/W017 pattern): NOTHING survives → healthy retry
   converges.

## §4a The PR #36 remediation — generic-path unreachability (architect CHANGES REQUESTED)

**The blocker (accepted):** the original table exposed
`DRAFT → VERIFIED` as an ordinary generic edge, and the generic
`/workflows` transition machinery did not distinguish the creators
composite's disclosure-gated use from an ordinary caller-requested
transition — so an authorized caller invoking
`publication.transition.draft_to_verified` through the generic path
could bypass the disclosure derivation in `verifyPublication()`,
violating the PR's own stated invariant.

**The remediation (same branch/PR):**

- the verification edge moved to
  `PUBLICATION_SANCTIONED_TRANSITION_TABLE`
  (`src/workflows/transition-table.ts`); `findRule` — the sole
  resolver behind the generic path — reads ONLY the generic tables,
  so the edge is structurally unresolvable there: an authorized
  direct generic transition is rejected as `ILLEGAL_TRANSITION`
  (machine-readable `requiredSanction` context) whether obligations
  are unsatisfied OR satisfied; the publication remains DRAFT; no
  `publication.verified` audit is emitted;
- a frozen core sanction vocabulary (`src/core/workflow.ts`):
  `WORKFLOW_TRANSITION_SANCTIONS = ["creators.publication-verification"]`;
- the in-tx composition twin (`requestTransitionWithinTx`) gained
  an optional `sanction` argument — the ONLY route to a sanctioned
  edge. `verifyPublication` presents
  `PUBLICATION_VERIFICATION_SANCTION` (a core constant — no
  domain→domain import) after the gate derivation; the runtime
  wiring passes the sanction through verbatim;
- `DRAFT → CANCELLED` remains a generic transition — and the API
  transition parser now admits subjectKind `"publication"` for it
  (closing the pre-existing port-type/parser drift in the safe
  direction);
- the harness seeds the ALLOW policy for
  `publication.transition.draft_to_verified` DELIBERATELY, so the
  regression proves the block is structural, not
  authorization-based.

**Evidence:**

- `tests/creators/net-w018-ac-04-publication-gate.test.ts` — the
  architect's exact regression (authorized generic transition +
  valid publication + UNSATISFIED obligations → REJECTED, DRAFT
  preserved, no audit) + the structural variant (obligations
  SATISFIED → still rejected; the sanctioned composite then verifies
  the SAME publication) + the no-over-block proof (DRAFT → CANCELLED
  works generically);
- `tests/regression/net-w018-ac-07-architecture-out-of-scope.test.ts`
  — THE STRUCTURAL PIN: the generic table is EXACTLY
  `[DRAFT→CANCELLED]` with no `to: "VERIFIED"` rule;
  `findRule("publication","DRAFT","VERIFIED") === null`;
  `legalTargets("publication","DRAFT") === ["CANCELLED"]`; the
  sanctioned table is EXACTLY the one expected rule (frozen
  sanction + `requiresEvidenceReference`); the pure evaluator
  split (no sanction → illegal; wrong sanction → illegal; exact
  sanction → legal). A future contributor re-exposing the
  verification edge through the generic table breaks these pins.

## §5 AC → test → changed files

| AC | Tests | Primary changed files |
|----|-------|----------------------|
| 1 | `net-w018-ac-01-commercial-relationships.test.ts` (7 tests) | `src/creators/port.ts` (CommercialRelationship + service + repos), `src/creators/sponsorship-service.ts`, `src/creators/authority-sponsorship-repositories.ts`, `src/core/creators.ts` |
| 2 | `net-w018-ac-02-disclosure-requirements.test.ts` (6 tests: policy section, closed vocabulary, pure derivation, provenance, integrated derivation, tenancy) | `src/core/campaigns.ts` (vocabulary + validation), `src/campaigns/port.ts` + `src/campaigns/campaign-service.ts` (the section), `src/creators/disclosure-engine.ts` |
| 3 | `net-w018-ac-03-declarations-evidence.test.ts` (7 tests: provenance, exact subject binding, vocabulary, creator-only, DRAFT-only + replay, append bound, publication evidence) | `src/creators/sponsorship-service.ts` (validatePublicationEvidenceReferences + recordDisclosureDeclaration), `src/creators/port.ts` |
| 4 | `net-w018-ac-04-publication-gate.test.ts` (11 tests: block + context, partial block, cross-publication isolation, no-bypass structural pin, success path, no-publication-authority, terminated relationship, pinned policy version, + the §4a remediation regression trio: generic-path rejection with UNSATISFIED obligations, structural rejection with SATISFIED obligations + sanctioned success, generic DRAFT → CANCELLED retained) | `src/creators/sponsorship-service.ts` (verifyPublication + the sanction), `src/workflows/transition-table.ts` (generic + sanctioned tables), `src/core/workflow.ts` (sanction vocabulary) |
| 5 | `net-w018-ac-05-settlement-reference.test.ts` (5 tests: reference data, structural no-balance pins, no economic command, behavioral no-side-effects, shared bounds) | `src/creators/port.ts` (CommercialCompensationTerms), `src/creators/sponsorship-service.ts` |
| 6 | `net-w018-ac-06-provider-neutrality.test.ts` (6 tests: neutral channel, closed vocabulary + bounded references, no provider names, tier imports, no secrets, no execution path) | `src/creators/port.ts` (PublicationChannel), `src/creators/sponsorship-service.ts` |
| 7 | `tests/regression/net-w018-ac-07-architecture-out-of-scope.test.ts` (11 tests: authority guard, frozen lock, work-order binding, vocabulary pins + unchanged canonical states, generic publication table + THE STRUCTURAL PIN (§4a), no transition machinery + single twin call, pure engine + no evidence fabrication, no AI path, composition wiring, non-goals, file list) | `spec/work-orders/NET-W018.md` (§3.4a), this document |
| 8 | `net-w018-ac-08-tenancy-idempotency.test.ts` (6 tests: tenancy, idempotent replays, optimistic concurrency, no double verification, audit lineage, authority persistence) | `src/creators/authority-sponsorship-repositories.ts`, `src/creators/sponsorship-service.ts` |
| — | `net-w018-composite-atomicity.test.ts` (3 fault-injection tests) | `src/creators/sponsorship-service.ts` (the composite) |
| — | `tests/creators/_net-w018-harness.ts` (the shared harness: guard actions, publication transition policies, disclosure-declaring campaign + verified-engagement + relationship + publication + evidence + declaration factories, golden path) | `src/bootstrap/runtime.ts` (wiring) |

**Full changed-file list:** `src/core/workflow.ts` (subject kind +
the sanction vocabulary — the PR #36 remediation),
`src/core/campaigns.ts` (disclosure vocabulary +
validation + policy type), `src/core/creators.ts` (commercial
vocabulary, formats, errors), `src/campaigns/port.ts`,
`src/campaigns/campaign-service.ts` (the policy section),
`src/workflows/transition-table.ts` (PUBLICATION_TRANSITION_TABLE
+ PUBLICATION_SANCTIONED_TRANSITION_TABLE + findSanctionedRule/
sanctionRequiredFor — the remediation), `src/workflows/state-machine.ts`
(the sanction-aware pure evaluator — the remediation),
`src/workflows/port.ts` (publicationRepository dep + audit
namespace + the twin's sanction argument),
`src/workflows/workflow-service.ts` (routing + the sanction-aware
performTransition/twin), `src/creators/port.ts` (the W018 contract +
the twin's sanction argument), `src/creators/disclosure-engine.ts`
(new), `src/creators/sponsorship-service.ts` (new; presents
PUBLICATION_VERIFICATION_SANCTION),
`src/creators/authority-sponsorship-repositories.ts` (new),
`src/creators/module.ts`, `src/creators/index.ts`,
`src/bootstrap/runtime.ts` (repos, subject lookup, lookups, service,
API commands, views, sanction pass-through), `src/api/port.ts`
(commands), `src/api/server.ts` (routes + the publication subject
kind in the transition parser), the test files above, and the four
pre-existing mini-stack test files updated for the new
`publicationRepository` dependency slot
(`tests/workflows/net-w004-ac-07-audit-lineage.test.ts`,
`tests/evidence/net-w005-ac-07-atomicity-concurrency.test.ts`,
`tests/outcomes/net-w006-ac-06-atomicity-concurrency.test.ts`,
`tests/creators/net-w017-remediation-composite-atomicity.test.ts`).

## §6 Verification results

Recorded at the implementation commit `c1fb178` (run with
`bun run verify`):

- **typecheck**: PASS (`tsc --noEmit`)
- **arch:check**: PASS — 257 files scanned, 0 violations
- **authority:check**: PASS — 257 files scanned, 0 violations
- **tests**: 1231 pass / 15 skip / 0 fail (12,356 expect() calls;
  1246 tests across 152 files) — includes the 62 new NET-W018 tests
  (7 AC suites + fault injection + harness-backed) with the full
  pre-existing suite green.

Re-recorded after the PR #36 remediation (§4a — same branch):

- **typecheck**: PASS
- **arch:check**: PASS — 257 files scanned, 0 violations
- **authority:check**: PASS — 257 files scanned, 0 violations
- **tests**: 1235 pass / 15 skip / 0 fail (12,397 expect() calls;
  1250 tests across 152 files — 4 new remediation tests: the
  regression trio in AC-04 + the split structural pins in AC-07)

CI on the PR head runs the same `bun run verify` (verify +
integration jobs on push and pull_request events).

## §7 Reproducing

```sh
bun run verify          # typecheck + arch:check + authority:check + tests
bun test tests/creators/net-w018-*.test.ts
bun test tests/regression/net-w018-ac-07-architecture-out-of-scope.test.ts
```
