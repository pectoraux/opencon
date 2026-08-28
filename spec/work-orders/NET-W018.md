# NET-W018 — Sponsorship and disclosure

**Status:** implemented
**Architecture:** v1.0 (FROZEN) — `spec/architecture.md`, `spec/architecture-lock.md`
**Requirements:** CRE-006, DISC-001..002
**Dependencies:** NET-W017 (merged, PR #34), NET-W005 (merged)
**Issue:** #35
**Backlog provenance:** `spec/work-items.md` — "Persist commercial relationships, disclosure requirements, creator campaign terms and publication evidence."

## §1 Objective

Persist commercial relationships, disclosure requirements, creator campaign terms and publication evidence without creating a second commercial, workflow, evidence, reputation or settlement authority.

## §2 Authority separation (the decision of record)

```text
/creators      → creator-side commercial/engagement data (the commercial
                 relationship, disclosure declaration and publication
                 RECORDS live here)
/campaigns     → campaign policy (the disclosure POLICY is a section of
                 the versioned campaign policy)
/workflows     → publication/engagement lifecycle (the publication is a
                 NEW canonical lifecycle subject kind; its DRAFT →
                 VERIFIED transition is THE DISCLOSURE GATE)
/evidence      → disclosure/publication evidence (canonical, subject-
                 bound references — never fabricated in /creators)
/settlement    → compensation/economic authority (relationship
                 compensation is REFERENCE DATA ONLY)
/disputes      → risk/dispute controls (a challenged disclosure is a
                 /disputes case referencing the publication — no local
                 lifecycle branch)
/adapters      → external platform execution (out of scope: the channel
                 descriptor is a provider-neutral reference)
```

NET-W018 must not create a second ledger, payment authority,
reputation authority, lifecycle engine, evidence authority, or
platform-ownership layer. Commercial disclosure policy is
declarative/decisioning state; economic mutation remains in
`/settlement` and lifecycle mutation remains in `/workflows`.

### The chain (issue #35)

```text
Campaign → Commercial relationship → Creator engagement →
Disclosure requirements → Creator declaration → Publication evidence →
Settlement reference
```

Every link is a durable, auditable record; the chain closes through
the publication's verification (the gate) with canonical evidence.

## §3 Scope — the implemented design

### §3.1 Commercial relationships (DISC-001; AC-01)

`CommercialRelationship` (in `/creators`): an explicit, durable,
tenant-scoped record with creator/campaign/engagement lineage, a
closed-vocabulary commercial kind (`sponsorship`, `paid_placement`,
`gifted_product`, `brand_ambassador`), relationship-declared
disclosure obligations (frozen campaign-disclosure vocabulary — the
relationship can only ADD obligations to the campaign's, never remove
them), reference-only compensation terms (the exact
`EngagementCompensationTerms` precedent — optionally pins a
settlement reward-policy reference; no balances, no postings), and a
one-way termination. ONE relationship per engagement (create-once;
stable `COMMERCIAL_RELATIONSHIP_CONFLICT` on a second). Termination
is conservative: obligations survive for content produced under the
relationship (never under-disclose).

### §3.2 The disclosure policy section (campaigns; AC-02)

`CampaignDisclosurePolicy` — a NEW section of the versioned campaign
policy (`requiredKinds: readonly CampaignDisclosureKind[]`):
closed vocabulary `CAMPAIGN_DISCLOSURE_KINDS` = `material_connection`,
`paid_partnership`, `gifted_product`, `genuine_experience`
(the DISC-002 attestation), `brand_affiliation`. OPTIONAL in the
INPUT (absent = no requirements declared), ALWAYS materialized on
the stored version (empty when absent) — format-compatible with
pre-W011..W017 policy versions (`CAMPAIGN_POLICY_FORMAT` stays
`"NET-W011:1"`; old versions read as empty through the same default).
Unknown kinds and duplicates are rejected at validation
(deterministic derivation downstream). The campaign domain never
evaluates declarations and never blocks publication — the creators
domain's gate consumes the section through the NEUTRAL
`CampaignDisclosurePolicyLookup` (the EngagementCampaignLookup
dependency-inversion precedent).

### §3.3 The derived disclosure requirements + declarations (AC-02/AC-03)

The PURE derivation engine (`src/creators/disclosure-engine.ts`):

```text
required = campaignPolicy.requiredKinds ∪ relationship.obligations
satisfied(kind) = ∃ declaration(publication, kind)
```

- deterministic order: the frozen `CAMPAIGN_DISCLOSURE_KINDS`
  vocabulary order; declarations order by (createdAt, id);
- every input is a DURABLE RECORD — no caller-asserted fact
  participates in the derivation;
- the derived status (`getPublicationDisclosureStatus`) exposes each
  obligation's provenance sources (campaign policy version and/or
  relationship id) and satisfaction state — never a stored field.

`DisclosureDeclaration` (in `/creators`): the auditable creator
declaration that a specific disclosure was made in a specific
publication — immutable, append-only, creator-only declarant (the
acting person must be the engagement's creator), attached to DRAFT
publications only, and bound to canonical evidence: EVERY evidence
reference must resolve in `/evidence` with the EXACT subject binding
(`subjectType "publication"`, `subjectId == publicationId`) —
disclosure proof cannot be fabricated in the creator domain
(invariant 6). The `genuine_experience` declaration IS the DISC-002
mechanism: the evidence-bound creator attestation that
personal-experience claims are genuine (a fabricated attestation is
disputable through `/disputes` with the declaration's evidence
lineage).

### §3.4 The publication lifecycle + THE DISCLOSURE GATE (AC-04)

The publication is a NEW canonical lifecycle subject kind
(`"publication"`) whose transition table lives in `/workflows` (the
SOLE lifecycle authority — the W017 engagement precedent; NO second
state machine anywhere). It REUSES the canonical state vocabulary
(the W005/W006 precedent — the state universe stays small and the
workflow machinery is untouched):

```text
DRAFT     — publication recorded (verified engagement + production +
             provider-neutral channel), obligations pending
VERIFIED  — terminal: the applicable disclosure obligations are
            satisfied AND canonical subject-bound publication
            evidence is recorded
CANCELLED — terminal: withdrawn before verification
```

- `DRAFT → VERIFIED` (requiresEvidenceReference: true) is a
  SANCTIONED transition — it is ABSENT from the generic table and
  executes ONLY through the verification composite — THE DISCLOSURE
  GATE (see §3.4a — the PR #36 remediation decision of record);
- `DRAFT → CANCELLED` is a pure generic workflow transition (the
  `requestTransition` API command with subjectKind "publication" —
  withdrawal is a plain lifecycle act with no derivation behind it);
- retraction AFTER verification is an explicit non-goal (a
  `/disputes` case + a later work item own post-publication
  semantics);
- no BLOCKED/FRAUD_REVIEW/DISPUTED states (risk escalation is a
  /disputes case referencing the publication).

`PublicationRecord` (in `/creators`): engagement + production +
creator + campaign lineage, a provider-neutral channel descriptor
(closed-vocabulary channel kind from the frozen usage-rights
channels + optional neutral external platform reference — provider
id/external id/url only), the one-time verification bookkeeping
(publication evidence references + verifiedAt) written by the
composite, and the LifecycleSubject surface for `/workflows`.
Creating a publication requires a VERIFIED engagement (terminal
success — producing/owning content does NOT itself imply publication
authority) and the referenced production to belong to the
engagement.

**THE DISCLOSURE GATE — the core invariant (issue #35):** a creator
or caller CANNOT simply assert that a disclosure is compliant and
bypass the policy. The gate DERIVES the applicable obligations from
durable records (campaign policy ∪ relationship obligations —
resolved at the engagement's PINNED policy version) and proves every
obligation satisfied by an evidence-bound declaration FOR THIS
PUBLICATION before requesting the transition. There is NO input on
any command that asserts compliance, waives an obligation or skips
the derivation (structurally pinned: the verify input carries only
organizationScopeId/publicationId/expectedVersion/
evidenceReferences/idempotencyKey; unknown extra fields are ignored).
Unsatisfied obligations raise the stable
`DISCLOSURE_OBLIGATIONS_UNSATISFIED` error with machine-readable
required/satisfied/missing sets — publication is BLOCKED while any
obligation is unsatisfied.

### §3.4a The sanction — generic-path unreachability (the PR #36 remediation decision of record)

Architect CHANGES REQUESTED on PR #36 (accepted): the verification
transition was resolvable through the GENERIC `/workflows`
transition machinery (the table edge + an authorized
`publication.transition.draft_to_verified` policy), so a caller able
to invoke the generic transition path could bypass the disclosure
derivation in `verifyPublication()` — violating the PR's own stated
invariant that DRAFT → VERIFIED is requested ONLY by the creators
domain's publication-verification composite.

The remediation (same branch/PR):

- the `DRAFT → VERIFIED` edge moved OUT of
  `PUBLICATION_TRANSITION_TABLE` into a separate
  `PUBLICATION_SANCTIONED_TRANSITION_TABLE`
  (`src/workflows/transition-table.ts`). `findRule` — the ONLY
  resolver behind `WorkflowService.requestTransition` and
  `/api/workflows/transitions` — reads ONLY the generic tables, so
  the edge is structurally UNRESOLVABLE on the generic path:
  `IllegalTransitionError` (code `ILLEGAL_TRANSITION`) with a
  machine-readable `requiredSanction` context, regardless of the
  caller's authorization, the evidence, or the disclosure state;
- a NEW frozen core sanction vocabulary
  (`src/core/workflow.ts`): `WORKFLOW_TRANSITION_SANCTIONS` =
  `["creators.publication-verification"]`;
- the in-tx composition twin
  (`requestTransitionWithinTx`) gains an optional `sanction`
  argument — the ONLY path that can resolve a sanctioned edge. The
  creators domain's `verifyPublication` presents
  `PUBLICATION_VERIFICATION_SANCTION` (core constant — no
  domain→domain import) AFTER the gate derivation proved every
  obligation satisfied; THAT call site IS the disclosure gate;
- `DRAFT → CANCELLED` remains a generic transition (the API
  transition parser admits subjectKind `"publication"` for it);
- regression evidence (the architect's exact scenario):
  `tests/creators/net-w018-ac-04-publication-gate.test.ts` —
  authorized direct generic transition + valid publication +
  UNSATISFIED obligations → REJECTED, publication remains DRAFT,
  NO `publication.verified` audit; plus the structural variant
  (obligations SATISFIED → generic path STILL rejected, the
  sanctioned composite then verifies the SAME publication) and the
  no-over-block proof (DRAFT → CANCELLED keeps working generically);
- the structural pin (a future contributor cannot accidentally
  re-expose the verification transition through the generic API):
  `tests/regression/net-w018-ac-07-architecture-out-of-scope.test.ts`
  pins the generic table to EXACTLY `[DRAFT→CANCELLED]` with NO
  `to: "VERIFIED"` rule, pins `findRule("publication","DRAFT",
  "VERIFIED") === null` + `legalTargets("publication","DRAFT") ===
  `["CANCELLED"]`, pins the sanctioned table to EXACTLY the one
  expected rule (frozen sanction + requiresEvidenceReference), and
  pins the pure evaluator split (no sanction → illegal;
  exact sanction → legal; wrong sanction → illegal).

### §3.5 Composite atomicity (built in from the start — the W017 remediation decision of record)

The verification composite (`verifyPublication`) commits as
ONE authoritative transaction (a single `applyIdempotent`, with the
workflow-subject advisory lock): in-tx fresh publication read (DRAFT)
→ in-tx engagement read (STILL VERIFIED) → the gate derivation
(in-tx relationship + declarations; the pinned policy version
resolved through the neutral lookup) → the material verification
bookkeeping (`applyVerificationWithinTx` + the `publication.verified`
audit event) → the DRAFT → VERIFIED transition through the sanctioned
in-tx `/workflows` twin. A failure at ANY point — gate rejection,
evidence validation, authorization denial, transition failure,
authoritative commit failure — rolls back EVERYTHING: no partially
verified publication, no bookkeeping without the state, no state
without the gate. Fault-injection evidence:
`tests/creators/net-w018-composite-atomicity.test.ts` (transition
failure / authorization denial / commit failure → NOTHING survives;
every retry converges).

### §3.6 Evidence integration (AC-03)

Canonical evidence records may bind to `"publication"` subjects (the
runtime's SubjectLookup resolves them — the W017 `ugc_production`
precedent). Both the declaration evidence (proof the disclosure was
made) and the publication evidence (proof the publication happened)
are canonical `/evidence` records subject-bound to the publication;
both validate through the same neutral
`ProductionEvidenceLookup`-shaped adapter (existence + tenant scope +
EXACT subject binding). ≥1 publication-evidence reference is
required for verification (the transition's declared
evidence-backed nature).

### §3.7 API + composition

Guarded commands (`POST /api/creators/...`): commercial-relationship
create/terminate (`creators.commercialRelationships.*`), publication
create (`creators.publications.create`), declaration append
(`creators.publications.declareDisclosure`), verification — the gate
(`creators.publications.verify`); plus tenant-scoped reads
(relationship/publication/declaration/status views with full
provenance). The composition root wires the sponsorship service with
thin read-only lookups over the OWNING domains' repositories (the
campaign disclosure policy over the campaigns policy repository; the
evidence lookup over the evidence repository) and delegates the
transition to the SAME workflow service instance through the in-tx
twin. NO economic/reputation/risk/outcome mutation, NO AI path.

## §4 Key invariants (issue #35) — enforcement map

| # | Invariant | Enforcement |
|---|-----------|-------------|
| 1 | Commercial relationships are explicit, durable, tenant-scoped records with creator/campaign/engagement lineage | `CommercialRelationship` record + in-tx lineage coherence checks + one-per-engagement create-once; AC-01 suite |
| 2 | Required disclosures are derived from explicit campaign/engagement policy and cannot be bypassed by caller claims | the pure union derivation over durable records (policy section + relationship obligations); the verify input has no compliance field; AC-02/AC-04 suites |
| 3 | A disclosure declaration is auditable and bound to the relevant publication/evidence context | the immutable `DisclosureDeclaration` + `disclosure_declaration.recorded` audit event + canonical subject-bound evidence references; AC-03 suite |
| 4 | Publication requires the applicable disclosure obligations to be satisfied; producing or owning content does not itself imply publication authority | THE DISCLOSURE GATE (§3.4): derived obligations all satisfied + ≥1 subject-bound publication evidence before DRAFT → VERIFIED; publication creation requires a VERIFIED engagement; `DISCLOSURE_OBLIGATIONS_UNSATISFIED` stable error; the transition is a SANCTIONED edge unreachable through the generic workflow path (§3.4a — PR #36 remediation); AC-04 suite |
| 5 | Settlement references compensation terms; no parallel payment or reward ledger | `CommercialCompensationTerms` REFERENCE DATA ONLY (structural + behavioral pins; no economic command); AC-05 suite |
| 6 | Evidence references resolve to canonical `/evidence` records; disclosure proof cannot be fabricated in the creator domain | neutral evidence lookup validation with EXACT subject binding (`publication:{id}`) on declarations AND verification; AC-03 suite |
| 7 | AI/model output cannot directly authorize sponsorship, disclosure compliance, publication, settlement or reputation mutation | NO AI path in the sponsorship surface (no LlmPort/advisory; the llm purpose union untouched); AC-07 pins |
| 8 | Provider-neutral adapter boundaries + secret isolation | provider-neutral channel descriptor (closed vocabulary + bounded neutral external reference); no provider names/flows/credentials in the domain; AC-06 suite |
| 9 | Tenant isolation, server-side authorization, idempotency, concurrency safety, PostgreSQL authority, transactional audit lineage | org-scoped reads (cross-scope = NotFoundError), guard actions + deny-by-default transition authorization, applyIdempotent on every mutation, optimistic concurrency, authority-backed repositories, buffered transactional audit with lineage; AC-08 + composite-atomicity suites |

## §5 Explicit non-goals (unchanged from the issue)

No ad inventory/exchange (NET-W019+), no external payment execution,
no new reputation scoring, no decentralized consensus, no direct
workflow bypass, no parallel evidence/settlement authority, no
provider-specific platform semantics inside `/creators` or
`/campaigns`, and no post-verification retraction semantics (a
`/disputes` case + a later work item own them).

## §6 Acceptance-criteria → test map

| AC | Test file |
|----|-----------|
| 1 — first-class commercial relationships with lineage | `tests/creators/net-w018-ac-01-commercial-relationships.test.ts` |
| 2 — explicit, deterministic, tenant-scoped, auditable disclosure requirements | `tests/creators/net-w018-ac-02-disclosure-requirements.test.ts` |
| 3 — declarations + publication evidence preserve provenance + canonical evidence references | `tests/creators/net-w018-ac-03-declarations-evidence.test.ts` |
| 4 — publication blocked while obligations unsatisfied; caller claims cannot override | `tests/creators/net-w018-ac-04-publication-gate.test.ts` (incl. the PR #36 remediation regression: generic-path unreachability + structural/no-over-block proofs) |
| 5 — compensation remains a `/settlement` reference; no parallel economic state | `tests/creators/net-w018-ac-05-settlement-reference.test.ts` |
| 6 — provider-neutral adapter boundaries + secret isolation | `tests/creators/net-w018-ac-06-provider-neutrality.test.ts` |
| 7 — architecture/out-of-scope regression with frozen Architecture v1.0 + unchanged lock | `tests/regression/net-w018-ac-07-architecture-out-of-scope.test.ts` (incl. THE STRUCTURAL PIN: the sanctioned verification edge resolves only through the sanctioned table + exact sanction) |
| 8 — idempotency, concurrency, tenancy, PostgreSQL authority, transactional audit lineage | `tests/creators/net-w018-ac-08-tenancy-idempotency.test.ts` |
| (composite atomicity — the W017 remediation standard applied from the start) | `tests/creators/net-w018-composite-atomicity.test.ts` |

## §7 Verification

`bun run verify`: typecheck + `arch:check` + `authority:check` + unit
tests + configured integration tests. The full suite result is
recorded in `docs/net-w018-sponsorship-disclosure.md` (evidence
document): every AC maps to automated tests and changed files.
