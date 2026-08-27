# `contributions` boundary

**Tier:** domain
**Authority:** contribution lifecycle and submission state; helpful-contribution semantics + Proof-of-Helpfulness (NET-W012); quality/moderation/anti-spam semantics (NET-W013)
**Architecture ref:** `spec/architecture.md` §8 (Helpfulness architecture), §11 (Reputation — content quality is a reputation DIMENSION computed by /reputation), §12 (Fraud — multiple signals, none authoritative), §14 (AI architecture), §18 (Module ownership: `/contributions` owns the Contribution entity); `spec/architecture-lock.md` §2, §1 invariant 9 (commercial recommendations must preserve required disclosure and must not condition reward on positive sentiment)
**Work orders:** `spec/work-orders/NET-W004.md`, `spec/work-orders/NET-W012.md`, `spec/work-orders/NET-W013.md`

## NET-W004 — Contribution first-class model

- `Contribution` — a first-class lifecycle subject (stable id,
  opportunity + contributor references, opaque contribution type,
  submission payload, evidence-reference placeholders); transitions
  are owned EXCLUSIVELY by `/workflows`.
- `ContributionService.createContribution/getContribution` — DRAFT v0
  creation enforcing the AC-02 invariant (exactly one opportunity +
  one contributor, same organization scope).
- Authority-backed repository (PostgreSQL authority boundary,
  WithinTx lifecycle twins for the WorkflowService).

## NET-W012 — Helpful contributions (Proof-of-Helpfulness)

Helpful semantics attach to the W004 OPAQUE extension points
(`ContributionType`, `ContributionSubmission`) IN this domain — no new
`LifecycleSubjectKind`, no 17th domain:

- **`src/core/contributions.ts`** — the closed provider-neutral
  vocabularies (helpful opportunity/contribution kinds, PoH statuses,
  qualifying basis kinds and source types, advisory kinds with
  REQUIRED method identity, disclosure vocabularies) + the PURE
  fail-closed `evaluateCampaignEligibility` (the FIRST consumer of
  the NET-W011 `campaign_policy:{campaignId}:{version}:{specId}`
  eligibility reference).
- **`HelpfulnessPolicy`** — the immutable versioned lineage of
  deterministic usefulness criteria (org-scoped `policyId`,
  `helpfulness_policy_lineage:{policyId}` org-independent mutex,
  cross-scope fork rejection including v1).
- **`ProofOfHelpfulness`** — the 1:1 domain aggregate created
  atomically with the helpful contribution: pinned policy version,
  eligibility resolution, recorded mentions (NEVER qualifying
  inputs), disclosure references, advisory scores (NEVER qualifying),
  qualifying-basis references (re-resolved through the truth
  authorities at evaluation), append-only evaluation history, the
  publication block; administrative states
  `PENDING → QUALIFIED (terminal) | NOT_QUALIFIED (re-evaluable)`.
- **`CommercialDisclosureRecord`** — first-class auditable commercial
  relationships (`DECLARED → RETRACTED` terminal, append-only).
- **`poh-engine.ts`** — the PURE deterministic evaluator (no I/O, no
  clock): QUALIFIED iff ≥ minimum qualifying evidenced bases (each
  same-org, subject-bound, grade/confidence/state/outcome-type
  checked) + ≥ minimum independent provenance sources + disclosure
  compliance + publication. Mentions and advisory scores are
  structurally incapable of producing QUALIFIED.
- **`HelpfulnessService`** — every mutation through the NET-W004
  `IdempotencyStore` primitive (exactly-once atomic commit +
  transactional audit lineage), per-record mutexes, in-tx re-checks,
  replay tolerance; person-actor gates (the contributor creates,
  declares, publishes); `assertPublishable`/`recordPublication` are
  the user-controlled publication gate's domain half.

## NET-W013 — Quality, moderation and anti-spam controls

Quality/moderation semantics attach IN this domain (the W012 §2
precedent — no 17th domain, no new `LifecycleSubjectKind`):

- **`src/core/moderation.ts`** — the closed provider-neutral
  vocabularies (quality input kinds — the PoH aggregate + the W012
  basis kinds, with MENTIONS structurally absent per HELP-002;
  advisory kinds with REQUIRED method identity; quality bands;
  moderation decisions/reasons; abuse reason kinds; DERIVED
  moderation statuses) + the PURE `validateQualityPolicyShape`
  fail-safe validator (monotonic thresholds, advisory-only cap ≤
  ADEQUATE, missing-input floor ≤ LOW_QUALITY).
- **`QualityPolicy`** — the immutable versioned lineage of
  deterministic quality criteria (`quality_policy_lineage:{policyId}`
  org-independent mutex, cross-scope fork rejection including v1).
- **`AdvisoryQualityScore`** — append-only advisory records with
  method identity + provider/model identity (model-generated scores
  carry the neutral LLM port's identity; AI-004 — advisory, never
  authoritative).
- **`QualityEvaluation`** — deterministic evaluation snapshots (the
  RiskAssessment pattern): pinned policy version same-scope-validated
  IN-TX, explicit `evaluatedAt` determinism anchor, per-input
  contribution breakdown, bounded advisory blend, scaled score +
  band, SHA-256 digest, append-only supersession with atomic
  back-pointer flip, in-tx PoH/advisory staleness re-checks.
- **`quality-engine.ts`** — the PURE deterministic evaluator: per-input
  attainment over RE-RESOLVED authoritative facts (the PoH + its
  bases re-resolved through the truth lookups); `score =
  (1-f)·authoritative + f·advisoryAverage`; threshold bands + the
  structural advisory-only cap and missing-required-input floor.
- **`ModerationDecisionRecord`** — the append-only decision history
  (moderator-controlled person actors; cited-evaluation
  verification; in-tx contribution re-check); the current status is
  DERIVED from the latest decision, never stored.
- **`ModerationService`/`QualityService`** — every mutation through
  the NET-W004 `IdempotencyStore` with per-record mutexes, replay
  tolerance and transactional audit lineage.

The spam/abuse RISK-SIGNAL emission into `/disputes` (additive
`spam`/`abuse` categories + the `moderation_decision` source kind)
and the provider-neutral `/llm` scoring consumption happen ONLY at
the bootstrap composition root.

## Authority separation (decision of record)

```text
/campaigns   → campaign/objective configuration (READ via lookup)
/workflows   → contribution lifecycle (publication transitions at the composition root)
/evidence    → evidence truth (READ via lookup; never mutated here)
/outcomes    → normalized measurement (READ via lookup; never mutated here)
/settlement  → economic authority (UNTOUCHED by NET-W012/W013 — reward integration is NET-W014)
/reputation  → trust-signal authority (UNTOUCHED — content quality is a reputation DIMENSION computed by /reputation)
/disputes    → the SINGLE risk authority (spam/abuse signals EMITTED via the composition root; never duplicated here)
/llm         → provider-neutral AI execution (consumed ONLY at the composition root; outputs structurally non-authoritative)
```

The domain never calls a workflow, evidence, outcome, settlement,
campaign, reputation or risk command. The NEUTRAL read-only lookups
(`HelpfulnessCampaignLookup`, `HelpfulnessOpportunityLookup`,
`HelpfulnessEvidenceLookup`, `HelpfulnessMeasurementLookup`,
`HelpfulnessProofOfValueLookup`, `QualityPohLookup`) are wired over
the owning domains' repositories at the bootstrap composition root.

## Dependencies

None beyond the shared `core` contracts. Cross-domain access occurs
only through the declared lookup interfaces wired by the composition
root.
