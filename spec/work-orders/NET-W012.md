# Work Order — NET-W012: Helpful contributions

**Status:** READY_FOR_IMPLEMENTATION
**Architecture:** v1.0 (FROZEN) — `spec/architecture.md` + `spec/architecture-lock.md` are UNTOUCHED by this work item
**Requirements:** HELP-001..005 (`spec/requirements.md`)
**Acceptance criteria:** NET-W012-AC-01..07 (GitHub Issue #23)
**Dependencies:** NET-W005 (evidence truth), NET-W006 (outcomes measurement), NET-W011 (campaigns) — all merged
**Canonical issue:** GitHub Issue #23 ("NET-W012: Helpful contributions")

## 1. Objective

Implement useful recommendation opportunities and contribution submission
with an explicit **Proof-of-Helpfulness** path:

```text
Campaign / Opportunity
        ↓
Helpful contribution
        ↓
Proof-of-Helpfulness
        ↓
Evidence + measurement
        ↓
Verified usefulness
        ↓
later reward/settlement integration (NET-W014 — non-goal here)
```

A product mention alone must NEVER become a rewarded contribution:
usefulness must be evidenced, the contribution must remain
user-controlled, and commercial relationships must be disclosed.

## 2. Domain placement (decision of record)

The frozen 16-domain list (architecture-lock §2) already reserves
`/contributions` ("contribution lifecycle and submission state"). The
NET-W004 implementation made `ContributionType` and
`ContributionSubmission` deliberately OPAQUE with the documented intent
that "downstream work items (**helpful contributions**, UGC, etc.)
attach concrete semantics". NET-W012 attaches those semantics IN
`/contributions` — no 17th domain, no new `LifecycleSubjectKind`, no
architecture amendment.

Helpful contribution records remain ordinary W004 `Contribution`
lifecycle subjects (transitioned ONLY by `/workflows`); the
Proof-of-Helpfulness aggregate, the helpfulness policy lineage and the
commercial-disclosure records are DOMAIN-OWNED bookkeeping records with
their own administrative states — the NET-W010 dispute-record and
NET-W011 campaign-record precedent.

## 3. Scope

### §3.1 Core vocabulary — `src/core/contributions.ts` (new)

Provider-neutral, closed vocabularies + pure validation + the PURE
campaign-eligibility evaluator (the first consumer of the NET-W011
`campaign_policy:{campaignId}:{version}:{specId}` reference):

- `HELPFUL_OPPORTUNITY_TYPES` / `HELPFUL_CONTRIBUTION_KINDS` —
  `helpful_recommendation | helpful_guidance | helpful_answer |
  helpful_comparison`;
- `HELPFULNESS_POLICY_FORMAT = "NET-W012:1"`;
- `PROOF_OF_HELPFULNESS_STATUSES = ["PENDING","QUALIFIED","NOT_QUALIFIED"]`
  — QUALIFIED is terminal (the final evidenced claim); NOT_QUALIFIED is
  re-evaluable when new bases attach; a QUALIFIED claim can only be
  challenged through `/disputes` (NET-W010), never silently rewritten;
- `HELPFULNESS_BASIS_KINDS = ["proof_of_value","measured_outcome",
  "evidence_record"]` — the same three authority-record kinds the
  NET-W011 evidence policy references;
- `QUALIFYING_HELPFULNESS_SOURCE_TYPES = ["platform","attested",
  "provider"]` — `model` and `self` evidence NEVER qualify (mirrors the
  frozen `QUALIFYING_ECONOMIC_EVIDENCE_SOURCE_TYPES`);
- `HELPFUL_ADVISORY_KINDS = ["model_score","heuristic_score"]` —
  advisory scores REQUIRE `methodRef` + `methodVersion` (the frozen
  measurement rule: model/method identity is never collapsed);
- `DISCLOSURE_RELATIONSHIP_KINDS` and `DISCLOSURE_STATES =
  ["DECLARED","RETRACTED"]` (retraction terminal, append-only);
- `evaluateCampaignEligibility(rules, claimantAttributes)` — PURE,
  fail-closed (a rule referencing an attribute the claimant did not
  declare rejects), closed attribute/operator vocabularies re-exported
  from core/campaigns.

### §3.2 The `/contributions` aggregate (port + service + repository)

- **`HelpfulnessPolicy`** — immutable versioned lineage (org-scoped
  `policyId`, `version = latest+1`, `(policyId, version)` tuple
  idempotency, monotonic, cross-scope fork rejection including v1)
  under the ORGANIZATION-INDEPENDENT mutex
  `helpfulness_policy_lineage:{policyId}` — the NET-W007/008/009/010/011
  lineage pattern. Sections: qualifying basis kinds, minimum evidence
  grade, qualifying source types, qualifying outcome types, minimum
  confidence, minimum independent sources, minimum qualifying bases,
  advisory rules (allowed kinds + max weight), disclosure requirement.
- **`ProofOfHelpfulness`** — the domain aggregate created 1:1 with a
  helpful contribution (atomic single-tx creation): pinned helpfulness
  policy reference, eligibility resolution (the evaluated
  `campaign_policy` reference or null), recorded mentions
  (product references + disclosure flags — NEVER qualifying inputs),
  disclosure references, advisory scores (capped, advisory-only),
  qualifying-basis references, append-only evaluation history, the
  publication block, and the administrative state machine
  (`PENDING → QUALIFIED | NOT_QUALIFIED`).
- **`CommercialDisclosureRecord`** — first-class, auditable commercial
  relationship declarations (kind, counterparty, product reference);
  DECLARED → RETRACTED (terminal) via append-only events.
- **`HelpfulnessService`** — createHelpfulContribution (validates the
  structured submission + helpful opportunity type + evaluates campaign
  eligibility fail-closed + pins the helpfulness policy version),
  prepareRecommendation (protocol-prepared DRAFT content — NEVER
  publishes), declareDisclosure/retractDisclosure,
  attachAdvisoryScore, attachBasis (lookup-verified at attach),
  evaluateProofOfHelpfulness (re-resolves every basis through the
  truth-authority lookups at evaluation time and runs the PURE
  engine), assertPublishable/recordPublication (the user-controlled
  publication gate bookkeeping), reads.

### §3.3 The PURE deterministic engine — `src/contributions/poh-engine.ts`

`evaluateProofOfHelpfulness(...)` is PURE (no I/O, no clock):
QUALIFIED iff ≥ `minimumQualifyingBases` bases each resolve through the
injected lookups (same org, subject == the contribution, kind-specific
authority checks: VERIFIED PoV / VERIFIED measured outcome with a
recorded rollup and a policy-qualifying outcome type / evidence record
with a qualifying source type and grade ≥ minimum), ≥
`minimumIndependentSources` distinct provenance sources, disclosure
compliance when required, and the contribution is PUBLISHED (workflow
state ≥ SUBMITTED). Mentions and advisory scores are INPUTS TO NOTHING
— structurally incapable of producing QUALIFIED.

### §3.4 Composition-root orchestration (the W010/W011 precedent)

`publishHelpfulContribution` is the ONLY publication path:
`assertPublishable` (domain: person actor == contributor, disclosure
compliance) → `workflowService.requestTransition` step(s) DRAFT → … →
SUBMITTED (lifecycle authority untouched, compound idempotency keys)
→ `recordPublication` (domain bookkeeping + audit). The domain never
calls a workflow/evidence/outcome/settlement/campaign command; every
cross-boundary read goes through the five NEUTRAL read-only lookups
wired in the composition root (`HelpfulnessCampaignLookup`,
`HelpfulnessOpportunityLookup`, `HelpfulnessEvidenceLookup`,
`HelpfulnessMeasurementLookup`, `HelpfulnessProofOfValueLookup`).

### §3.5 Persistence, idempotency, audit, tenancy

Authority collections `helpfulness_policies`, `proofs_of_helpfulness`,
`commercial_disclosures` (+ the existing `contributions` collection).
Every material mutation runs through the NET-W004 `IdempotencyStore`
primitive (exactly-once atomic commit + transactional audit lineage),
per-record `proof_of_helpfulness:{id}` / `commercial_disclosure:{id}` /
policy-lineage mutexes, in-tx state re-checks, replay tolerance.
Tenant isolation: organization scope on every record, verified on every
read/write; person-actor gates on every mutation.

## 4. Required invariants (binding)

1. **Mention ≠ helpfulness** — mentions are recorded metadata; the
   evaluator has NO code path through which a mention contributes to
   qualification.
2. **Helpfulness is evidenced** — a QUALIFIED claim references ≥
   `minimumQualifyingBases` qualifying authority records with
   provenance and confidence/uncertainty, re-resolved at evaluation.
3. **AI is advisory** — advisory scores and MODEL_ASSESSED/SELF_REPORTED
   evidence never qualify; `model`/`self` source types never qualify.
4. **Publication is user-controlled** — publication requires a person
   actor == the contributor; protocol preparation never transitions
   lifecycle state.
5. **Commercial disclosure is explicit** — undisclosed commercial
   mentions block publication and qualification when policy requires
   disclosure; disclosure history is append-only and auditable.
6. **Authority separation** — no hidden mutation of workflow, evidence,
   outcomes, campaigns, reputation, settlement or disputes state from
   `/contributions`; composition happens only at the composition root.
7. **Atomicity and tenancy** — idempotent, concurrency-safe,
   PostgreSQL-authoritative, transactionally audited, tenant-scoped.

## 5. Explicit non-goals

No moderation/anti-spam engine (NET-W013), no campaign-clearing
execution or reward integration (NET-W014 — this work item DEFINES the
verified-usefulness claim later clearing consumes, it never moves
value), no creator marketplace (NET-W015+), no ad inventory/optimization
(NET-W019+), no demand/procurement pools, no external payments, no
blockchain consensus, no provider-specific campaign SDK semantics, and
NO changes to the frozen architecture, the frozen economic vocabulary,
or any other domain's internals.

## 6. Acceptance-criteria mapping

| AC | Criterion | Tests | Changed files |
|---|---|---|---|
| NET-W012-AC-01 | first-class durable scoped records | `tests/contributions/net-w012-ac-01-records.test.ts` | port.ts, helpfulness-service.ts, authority-helpfulness-repository.ts |
| NET-W012-AC-02 | explicit deterministic evidence-backed criteria | `tests/contributions/net-w012-ac-02-policy-and-engine.test.ts` | core/contributions.ts, poh-engine.ts, helpfulness-service.ts |
| NET-W012-AC-03 | mention alone has no reward authority | `tests/contributions/net-w012-ac-03-mention-not-helpfulness.test.ts` | poh-engine.ts |
| NET-W012-AC-04 | advisory scoring cannot bypass policy | `tests/contributions/net-w012-ac-04-advisory.test.ts` | core/contributions.ts, poh-engine.ts, helpfulness-service.ts |
| NET-W012-AC-05 | user-controlled publication + explicit disclosure | `tests/contributions/net-w012-ac-05-publication-disclosure.test.ts`, `tests/contributions/net-w012-transaction-boundary-races.test.ts` | helpfulness-service.ts, runtime.ts, server.ts |
| NET-W012-AC-06 | tenancy/idempotency/concurrency/audit | `tests/contributions/net-w012-ac-06-atomicity-tenancy.test.ts`, `tests/contributions/net-w012-transaction-boundary-races.test.ts` | helpfulness-service.ts, authority-helpfulness-repository.ts |
| NET-W012-AC-07 | architecture/out-of-scope regression | `tests/regression/net-w012-ac-07-architecture-out-of-scope.test.ts` | (this work item's full file set) |

## 7. Verification

`bun run verify` — typecheck, `arch:check` (0 violations), unit +
regression suites. CI runs the same gate plus the real
PostgreSQL/Redis integration suites.
