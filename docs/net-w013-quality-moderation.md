# NET-W013 — Quality, moderation and anti-spam controls (evidence document)

**Work order:** `spec/work-orders/NET-W013.md` · **Issue:** #25 ·
**Requirements:** HELP-002, AI-004, FRAUD-001..003 ·
**Dependencies:** NET-W009, NET-W012 (both merged)

## What shipped

| File | Role |
|---|---|
| `src/core/moderation.ts` | The closed, provider-neutral quality/moderation vocabulary + the PURE `validateQualityPolicyShape` fail-safe validator |
| `src/contributions/quality-engine.ts` | The PURE deterministic quality engine (per-input attainment; bounded advisory blend; threshold bands; structural advisory-only cap + missing-required-input floor; NO mention input) |
| `src/contributions/quality-service.ts` | The quality policy lineage (org-independent mutex, cross-scope fork rejection), append-only advisory scores (method + provider identity), deterministic evaluation snapshots (in-tx same-scope policy pinning, staleness re-checks, SHA-256 digest, append-only supersession) |
| `src/contributions/moderation-service.ts` | The append-only moderation decision history with DERIVED current status (moderator-controlled person actors; cited-evaluation verification; in-tx contribution re-check) |
| `src/contributions/authority-quality-repository.ts` | Four PostgreSQL-authoritative collections (`quality_policies`, `quality_evaluations` + latest-index, `advisory_quality_scores`, `moderation_decisions`) with WithinTx twins |
| `src/llm/port.ts` + `providers/echo-llm-provider.ts` | The provider-neutral advisory SCORING contract (the boundary's designated NET-W013 concrete behaviour) + the deterministic SHA-256 echo reference provider |
| `src/core/risk.ts` (additive) | `RISK_SIGNAL_CATEGORIES` += `spam`, `abuse`; `RISK_SIGNAL_SOURCE_KINDS` += `moderation_decision` |
| `src/disputes/port.ts` + `source-validation.ts` (additive) | The `RiskModerationDecisionLookup` neutral interface + the `moderation_decision` source-resolution case |
| `src/bootstrap/runtime.ts` | LLM provider wiring (opts override, echo default, runtime lifecycle), the 4 repositories, both services, 11 apiCommands incl. the `generateAdvisoryQualityScore` (first LlmPort consumer) and `recordModerationDecision` (the spam/abuse emission composite) |
| `src/api/port.ts` + `server.ts` | 6 views + 11 command signatures + 12 routes under `/api/quality-policies` and `/api/contributions/:id/{advisory-quality-scores,quality-evaluation,moderation-decisions,moderation}` with 6 guard actions |

## Domain placement (decision of record)

The frozen 16-domain list reserves NO `/moderation` boundary — the
NET-W012 regression pins its absence from the architecture-lock, and
this work item keeps that pin green. Following the NET-W012 §2
precedent (the W004 opaque extension points whose documented intent is
that downstream work items attach concrete semantics), the
quality/moderation semantics live IN `/contributions`:

- `QualityPolicy` lineages, `AdvisoryQualityScore` records,
  `QualityEvaluation` snapshots and `ModerationDecisionRecord`
  histories are CONTRIBUTION-domain aggregates — domain bookkeeping
  that never owns lifecycle (the W010 dispute-record / W011
  campaign-record / W012 PoH precedent);
- the Contribution remains the ONLY lifecycle subject (quality and
  moderation records never transition it);
- spam/abuse signal EMISSION into `/disputes` happens ONLY at the
  composition root — the domain never calls a risk command, so no
  second fraud authority can form;
- the `/llm` ADAPTER boundary becomes concrete (its designated
  NET-W013 purpose) and is consumed ONLY at the composition root (the
  `domain-must-not-import-adapter` rule is scanner-enforced).

## Key design decisions

1. **The quality engine consumes the PoH foundation** (the W012
   dependency): the `proof_of_helpfulness` input kind resolves the PoH
   aggregate state, and the `evidence_record`/`measured_outcome`/
   `proof_of_value` kinds RE-RESOLVE the PoH's recorded bases through
   the SAME neutral lookups the helpfulness service uses — truth is
   re-resolved at evaluation time, never taken from a snapshot.
2. **Mentions are structurally absent from quality** (HELP-002): the
   engine's fact interface has NO mention field; two contributions
   differing only in mentions evaluate bit-for-bit identically
   (identical digests — regression-proven).
3. **AI assists, never dominates** (AI-004): advisory scores blend at
   the policy's bounded `advisoryWeightFactor ≤ 1`; the structural
   `advisoryOnlyCapBand` (validated ≤ ADEQUATE) means an
   advisory-only fact set can never certify HIGH_QUALITY —
   regression-proven adversarially (a perfect model score at weight
   0.8 against a 0.75 threshold is held at ADEQUATE).
4. **Provider independence is identity-preserving**: the echo
   reference provider scores DETERMINISTICALLY (SHA-256 over the
   canonical input — reproducible without network); any provider's
   output enters the engine identically with provider/model identity
   recorded on the advisory record (regression-proven with a second
   stub provider: identical scores/bands for identical advisory
   values).
5. **The first LlmPort consumer is a composition-root composite**:
   `generateAdvisoryQualityScore` builds the NEUTRAL record-level fact
   set (contribution type/state, mention count, PoH state/counts —
   never user content), calls the provider-neutral port, and attaches
   the result through the domain's advisory API. Concrete external
   providers are adapter-tier extensions of the same contract.
6. **Moderation history is append-only with derived status**: decisions
   are immutable; the current status is computed from the latest
   decision (`UNMODERATED` when none); a later APPROVE after REJECT
   appends (never rewrites). Decisions never transition workflow
   state — the RISK authority controls gates.
7. **Spam/abuse feeds the EXISTING risk authority** (FRAUD-001..003):
   the `recordModerationDecision` composite emits ONE evidence-backed
   `RiskSignal` per abuse-carrying decision — subject: the CONTRIBUTOR;
   subjectRef: the contribution; sources: the moderation decision +
   the contribution (the additive `moderation_decision` source kind,
   resolved through a new neutral lookup); provenance:
   `manual_review`/`net-w013-moderation`; compound idempotency key
   `…:signal`. The signal then participates in ORDINARY multi-signal
   risk assessments (regression-proven: an explicit spam rule consumes
   it; no ambient authority).
8. **In-transaction discipline from day one** (the PR #24 remediation
   lessons): the pinned quality policy is same-scope-validated INSIDE
   the evaluation transaction; the PoH state and the advisory set are
   re-checked in-tx for staleness (a mid-flight PoH change rejects the
   evaluation); moderation decisions re-check the contribution scope
   in-tx.

## Invariant → enforcement map

| Invariant (work order §4) | Enforcement |
|---|---|
| 1. Deterministic, versioned, auditable quality policy | PURE engine + pinned version + explicit `evaluatedAt` anchor + SHA-256 digest + append-only supersession; `net-w013-ac-01` |
| 2. Moderation history append-only | Immutable decision records + DERIVED status; no update/delete path exists; `net-w013-ac-04` |
| 3. Abuse/spam feeds the existing `/disputes` authority | Composition-root-only emission; additive categories/source kinds; evidence-backed signals; `net-w013-ac-05` + the domain denylist |
| 4. AI advisory + provider-neutral | Bounded blend factor; structural advisory-only cap; provider identity recorded; neutral port; `net-w013-ac-02` |
| 5. Quality mints no economic value / mutates no reputation | Zero economic + reputation footprint (ECONOMIC_* pinned UNCHANGED); denylist-enforced; `net-w013-ac-07` |
| 6. `/workflows` `/evidence` `/outcomes` `/settlement` boundaries | Neutral lookups only; no lifecycle mutation; neighbor domains untouched; `net-w013-ac-07` |
| 7. Atomicity/tenancy | IdempotencyStore exactly-once; per-record mutexes; in-tx re-checks incl. same-scope policy pinning; tenant isolation; `net-w013-ac-06` |

## API surface

| Route | Guard action | Command |
|---|---|---|
| POST `/api/quality-policies` | `quality.policy` | defineQualityPolicy |
| GET `/api/quality-policies/:policyId` | — (public) | listQualityPolicies |
| POST `/api/contributions/:id/advisory-quality-scores/generate` | `quality.advisory.generate` | generateAdvisoryQualityScore (the LLM composite) |
| POST `/api/contributions/:id/advisory-quality-scores` | `quality.advisory.attach` | attachAdvisoryQualityScore |
| GET `/api/contributions/:id/advisory-quality-scores` | — (public) | listAdvisoryQualityScores |
| POST `/api/contributions/:id/quality-evaluation/preview` | `quality.evaluation.preview` | previewQualityEvaluation |
| POST `/api/contributions/:id/quality-evaluation` | `quality.evaluation.record` | recordQualityEvaluation |
| GET `/api/contributions/:id/quality-evaluations` | — (public) | getQualityEvaluationHistory |
| POST `/api/contributions/:id/moderation-decisions` | `moderation.decide` | recordModerationDecision (the spam/abuse emission composite) |
| GET `/api/contributions/:id/moderation-decisions` | — (public) | listModerationDecisions |
| GET `/api/contributions/:id/moderation` | — (public) | getModerationSummary |

## AC → test mapping

| AC | Criterion | Suite |
|---|---|---|
| NET-W013-AC-01 | first-class durable scoped quality/moderation records | `tests/contributions/net-w013-ac-01-quality-records.test.ts` (7) |
| NET-W013-AC-02 | provider-independent scoring; AI advisory + non-authoritative (model-contract) | `tests/contributions/net-w013-ac-02-provider-independent.test.ts` (5) |
| NET-W013-AC-03 | mention alone has no quality authority (HELP-002) | `tests/contributions/net-w013-ac-03-mention-not-quality.test.ts` (4) |
| NET-W013-AC-04 | moderation auditable + append-only | `tests/contributions/net-w013-ac-04-moderation-append-only.test.ts` (6) |
| NET-W013-AC-05 | spam/abuse integrates into /disputes (no second authority) | `tests/contributions/net-w013-ac-05-abuse-signal-integration.test.ts` (6) |
| NET-W013-AC-06 | atomicity/idempotency/concurrency/tenancy/audit | `tests/contributions/net-w013-ac-06-atomicity-tenancy.test.ts` (7) |
| NET-W013-AC-07 | architecture/out-of-scope regression | `tests/regression/net-w013-ac-07-architecture-out-of-scope.test.ts` (16) |

Deliberate amendments (the additive pattern): the NET-W009
`RISK_SIGNAL_CATEGORIES` pin gained `spam` + `abuse` with a
"NET-W013 AMENDMENT" comment (the net-w009-ac-08 precedent). No other
shared baselines required amendment: `contributions` was already
non-skeletal (NET-W004); the NET-W012 module pin gains NET-W013 as a
triple pin without amending the W012 test; the W012 denylist needed NO
relaxation (the W013 naming avoids every banned pattern — sentiment
stays banned forever).
