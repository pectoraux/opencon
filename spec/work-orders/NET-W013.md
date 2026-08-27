# Work Order — NET-W013: Quality, moderation and anti-spam controls

**Status:** READY_FOR_IMPLEMENTATION
**Architecture:** v1.0 (FROZEN) — `spec/architecture.md` + `spec/architecture-lock.md` untouched
**Requirements:** HELP-002, AI-004, FRAUD-001..003
**Acceptance criteria:** NET-W013-AC-01..07
**Dependencies:** NET-W009, NET-W012 (both merged)
**Canonical issue:** #25

## 1. Objective

Generalize the AI scoring/moderation architecture into provider-independent
quality evaluation (the frozen backlog, `spec/work-items.md` §NET-W013):

```text
Contribution
   ↓
Quality evaluation        (deterministic, versioned, auditable policy)
   ↓
Moderation decision       (append-only history)
   ↓
Spam / abuse signals      (evidence-backed)
   ↓
NET-W009 risk controls    (/disputes — the SINGLE risk authority)
```

Definition of done: quality scoring is provider-independent, moderation is
auditable, spam/abuse signals are integrated into the existing risk
authority, and AI output remains non-authoritative evidence.

## 2. Domain placement (decision of record)

The frozen 16-domain list reserves NO `/moderation` boundary (and the
NET-W012 regression pins its absence from the architecture-lock). Following
the NET-W012 §2 precedent — the W004 opaque extension points whose
documented intent is that "downstream work items (helpful contributions,
UGC, etc.) attach concrete semantics" — NET-W013 attaches the
quality/moderation semantics IN `/contributions`:

- `QualityPolicy` lineages, `AdvisoryQualityScore` records,
  `QualityEvaluation` records (supersession chains) and
  `ModerationDecisionRecord` append-only histories are CONTRIBUTION-domain
  aggregates (the NET-W010 dispute-record / NET-W011 campaign-record /
  NET-W012 PoH precedent: domain bookkeeping that never owns lifecycle);
- the Contribution remains the ONLY lifecycle subject — quality and
  moderation records never transition it (`/workflows` keeps the authority);
- spam/abuse signal EMISSION into `/disputes` happens ONLY at the
  composition root (an apiCommand composite) — the domain never calls a
  risk command, so no second fraud authority can form;
- the `/llm` adapter boundary becomes concrete (its designated NET-W013
  purpose): a provider-neutral SCORING contract + runtime provider wiring
  (echo reference adapter), consumed ONLY at the composition root.

No 17th domain, no new `LifecycleSubjectKind`, no architecture amendment.

## 3. Scope

### §3.1 Core vocabulary — `src/core/moderation.ts` (new, additive)

- `QUALITY_POLICY_FORMAT = "NET-W013:1"`;
- `QUALITY_INPUT_KINDS = ["proof_of_helpfulness","evidence_record","measured_outcome","proof_of_value"]`
  (the NET-W012 basis kinds plus the PoH aggregate itself; mentions are
  structurally absent — HELP-002: product mention alone carries no quality
  authority);
- `QUALITY_ADVISORY_KINDS = ["model_score","heuristic_score"]` (the frozen
  measurement rule: method identity REQUIRED, advisory never qualifying);
- `QUALITY_BANDS = ["HIGH_QUALITY","ADEQUATE","LOW_QUALITY","UNSATISFACTORY"]`
  with normative rank ordering;
- `MODERATION_DECISIONS = ["APPROVE","REJECT","FLAG_FOR_REVIEW"]`;
- `MODERATION_REASON_KINDS` (closed set, includes `spam` and `abuse`);
- `ABUSE_REASON_KINDS = ["spam","abuse"]` — the reasons that trigger
  risk-signal emission at the composition root;
- `CONTRIBUTION_MODERATION_STATUSES = ["UNMODERATED","APPROVED","REJECTED","FLAGGED_FOR_REVIEW"]`
  (DERIVED from the append-only history — never stored);
- `QUALITY_SCORE_DECIMALS = 6`;
- the pure `validateQualityPolicyShape` (per-input weights, monotonic
  thresholds, `advisoryOnlyCapBand` at best ADEQUATE, `missingInputFloorBand`
  at best LOW_QUALITY — the fail-safe structural composition mirrors).

### §3.2 The quality/moderation aggregates (port + services + repository)

- `QualityPolicy` — immutable versioned lineage under the
  ORGANIZATION-INDEPENDENT mutex `quality_policy_lineage:{policyId}`;
  cross-scope fork rejection including version 1 (the W007/W011/W012
  pattern); input rules, advisory rules, evidence minimums, thresholds and
  structural fail-safes validated by the core validator.
- `AdvisoryQualityScore` — append-only advisory records carrying
  `kind` + REQUIRED `methodRef`/`methodVersion` AND (for model-generated
  scores) the provider/model identity from the neutral LLM port. Never
  qualifying; consumed by the engine at reduced weight.
- `QualityEvaluation` — the deterministic evaluation snapshot (the
  RiskAssessment pattern): pinned policy version, explicit `evaluatedAt`
  determinism anchor, per-input contribution breakdown (never an opaque
  score), advisory composition, scaled score, band, reasons, SHA-256
  digest, append-only supersession chain with atomic back-pointer flip.
  The service re-resolves the PoH + bases through the truth lookups at
  evaluation time and re-validates the pinned policy IN-TX (same-scope —
  the PR #24 remediation lesson applied from day one).
- `ModerationDecisionRecord` — append-only decision history
  (decision/reasons/notes/decidedBy/cited quality evaluations); the
  current moderation status is DERIVED (latest decision); decisions never
  rewrite history and never transition workflow state.

### §3.3 The PURE quality engine — `src/contributions/quality-engine.ts`

`evaluateQuality(policy, facts, advisoryScores)` — deterministic, no I/O:

- per configured input kind: `attainment ∈ [0,1]` over the re-resolved
  authoritative facts (PoH qualification; evidence grade/source/confidence
  minimums; VERIFIED measured outcomes of qualifying types; VERIFIED PoVs);
- `score = (1-f)·authoritative + f·advisoryAverage` where
  `f = advisoryWeightFactor ≤ 1` (AI assists at bounded weight);
- band from the monotonic thresholds, then STRUCTURAL composition:
  advisory-only cap (no authoritative facts ⇒ band at best
  `advisoryOnlyCapBand`, at best ADEQUATE) and missing-required-input
  floor (a required input kind with zero facts ⇒ band at best
  `missingInputFloorBand`, at best LOW_QUALITY);
- mentions have NO code path into the score (HELP-002).

### §3.4 The `/llm` boundary becomes concrete (adapter tier)

- `LlmPort.score(input)` — the provider-neutral scoring contract:
  `{purpose: "content_scoring"|"safety", rubricRef, neutralFacts}` →
  `{score ∈ [0,1], provider, modelRef, latencyMs, authoritative: false}`
  (the literal-false type is retained — AI output is NEVER authoritative);
- the echo reference provider implements `score` DETERMINISTICALLY
  (SHA-256 over the canonical input) so tests are reproducible;
- the composition root wires `llmProviders` (opts override, echo default),
  initializes them with the runtime, and the
  `generateAdvisoryQualityScore` composite is the FIRST consumer: neutral
  record-level facts (NO user content) → `llmProvider.score` → the domain's
  advisory attachment with provider identity. Concrete external providers
  remain adapter-tier extensions (no SDK in core/domain).

### §3.5 Spam/abuse integration (composition root ONLY)

`recordModerationDecision` (apiCommand composite):
1. `moderationService.recordDecision` (domain, append-only, auditable);
2. when the decision's reason kinds intersect `ABUSE_REASON_KINDS`, the
   composite emits ONE evidence-backed `RiskSignal` through
   `riskSignalService.createSignal` (the EXISTING `/disputes` authority):
   `subjectPersonId` = the contributor, `subjectRef` = the contribution,
   category `spam`/`abuse` (additive `RISK_SIGNAL_CATEGORIES` entries),
   provenance `manual_review` with `net-w013-moderation` detection
   identity, sources `[{moderation_decision, contribution}]` (additive
   `RISK_SIGNAL_SOURCE_KINDS` entry, resolved through a NEW neutral
   moderation lookup wired over the decision repository), compound
   idempotency key `…:signal`.

### §3.6 Persistence, idempotency, audit, tenancy

Collections `quality_policies`, `quality_evaluations`,
`advisory_quality_scores`, `moderation_decisions` on the PostgreSQL
authority (WithinTx twins for the authoritative mutations); every mutation
through the NET-W004 `IdempotencyStore` with per-record mutexes, in-tx
re-checks, replay tolerance and transactional audit lineage
(`quality_policy.version_created`, `quality_advisory.recorded`,
`quality_evaluation.recorded`, `moderation_decision.recorded`).

## 4. Required invariants (binding)

1. Deterministic, versioned, auditable quality policy (pure engine; pinned
   version; explicit determinism anchor; digest).
2. Moderation history is append-only (immutable decisions; derived status).
3. Abuse/spam feeds the EXISTING `/disputes` risk authority (no second
   fraud authority; evidence-backed signals; composition-root emission).
4. AI/model scoring remains advisory and provider-neutral (neutral port
   with provider identity; bounded weight; structural caps; never the sole
   basis).
5. Quality cannot mint economic value or mutate reputation (zero economic
   and reputation footprint — denylist-enforced).
6. `/workflows`, `/evidence`, `/outcomes` and `/settlement` retain their
   authority boundaries (domain reads through neutral lookups only).
7. Atomicity and tenancy (exactly-once, concurrency-safe, tenant-scoped,
   PostgreSQL-authoritative, transactionally audited — including in-tx
   same-scope validation at every policy-pinning boundary).

## 5. Explicit non-goals

No reward/settlement integration (NET-W014 consumes quality later), no
creator network or UGC workflow (NET-W015+), no new domain boundary, no
sentiment/positivity/tone scoring (incentives are never conditioned on
sentiment — the vocabulary and denylists exclude it), no autonomous
moderation agents (`/agents` remains deferred), no real external AI
provider integration (echo remains the reference adapter), no automated
takedown/publication retraction (moderation decisions are records; the
risk authority controls gates), no blockchain.

## 6. Acceptance-criteria mapping

| AC | Criterion | Tests | Changed files |
|---|---|---|---|
| NET-W013-AC-01 | first-class durable scoped quality/moderation records | `tests/contributions/net-w013-ac-01-quality-records.test.ts` | port.ts, quality-service.ts, moderation-service.ts, authority-quality-repository.ts |
| NET-W013-AC-02 | provider-independent scoring; AI advisory + non-authoritative (model-contract) | `tests/contributions/net-w013-ac-02-provider-independent.test.ts` | core/moderation.ts, quality-engine.ts, llm/port.ts, llm/providers/echo-llm-provider.ts, runtime.ts |
| NET-W013-AC-03 | mention alone has no quality authority (HELP-002, adversarial) | `tests/contributions/net-w013-ac-03-mention-not-quality.test.ts` | quality-engine.ts |
| NET-W013-AC-04 | moderation auditable + append-only | `tests/contributions/net-w013-ac-04-moderation-append-only.test.ts` | moderation-service.ts |
| NET-W013-AC-05 | spam/abuse integrates into /disputes (no second authority) | `tests/contributions/net-w013-ac-05-abuse-signal-integration.test.ts` | runtime.ts, core/risk.ts, disputes/source-validation.ts, disputes/port.ts |
| NET-W013-AC-06 | atomicity/idempotency/concurrency/tenancy/audit | `tests/contributions/net-w013-ac-06-atomicity-tenancy.test.ts` | quality-service.ts, moderation-service.ts |
| NET-W013-AC-07 | architecture/out-of-scope regression | `tests/regression/net-w013-ac-07-architecture-out-of-scope.test.ts` | (this work item's full file set) |

## 7. Verification

`bun run verify` (typecheck + `arch:check` + unit tests; integration in CI)
must pass. The test suite must include model-contract tests (the LLM port
contract), adversarial tests (AI-authority and mention-authority attempts)
and moderation tests (append-only history + risk integration), per the
frozen backlog's verification requirement.
