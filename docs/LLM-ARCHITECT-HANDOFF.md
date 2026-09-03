# OpenCon LLM Architect Handoff

## Start here

For a new architect with no conversation context, read in this order:

1. `AGENTS.md`
2. `spec/PROJECT-STATE.md`
3. `spec/ROADMAP.md`
4. `spec/architecture.md`
5. `spec/architecture-lock.md`
6. `spec/requirements.md`
7. `spec/work-items.md`
8. `spec/dependency-graph.md`
9. `docs/LLM-ARCHITECT-HANDOFF.md`
10. the relevant completed evidence records and GitHub PR discussions when auditing prior decisions

The repository is the source of truth. Do not rely on prior chat context.

## Current checkpoint

The canonical protocol implementation program is complete through **NET-W036**. The first authorized post-backlog product-client work, **UX-01**, is also complete.

### Canonical protocol completion

- W001–W036: COMPLETE / MERGED.
- W036 merge: PR #81, merge SHA `e7e858e6f5734cf4be0a95b287e6b736f50f3287`.
- The canonical protocol backlog terminates at W036. Do not invent W037 or extend `spec/work-items.md` without governance authorization.

### Post-backlog product-client completion

- UX-01 — Unified product client experience: COMPLETE.
- Governance PR #82: merge SHA `2efe8dbd4d9146d3dea750d1f3ee87647f9dcc59`.
- Implementation PR #84: reviewed head `acc44c90789f0705d7b3866dc893accc9333c50a`, merge SHA `d87977c7ed14bb67f51925a3d3d09c67e76c79a1`.
- UX-01 implementation is represented in this protocol repository by its frozen work order/evidence; the actual client lives in the product-client environment.
- Final UX evidence included 23 interaction-path tests / 125 assertions, fresh browser verification across the five product destinations and key journeys, zero new protocol architecture violations, and exact-head CI with real PostgreSQL/Redis integration.

## Program status

**POST-BACKLOG GOVERNANCE CHECKPOINT. There is currently no authorized successor work item.**

Do not create or implement `W037`, `UX-02`, a new dependency edge, or a new architecture version merely because a desirable capability is missing. The next body of work must first be authorized by an architect-authored governance artifact with a frozen scope, acceptance criteria, authority placement, evidence contract, verification gate and explicit GitHub issue binding.

## Strategic direction: use-case-driven validation

The next program should validate OpenCon primarily through **specific, realistic end-to-end use cases** rather than adding speculative features one subsystem at a time.

The purpose of a use-case work item is to exercise as much of the already-built platform as one coherent business journey can legitimately touch, while proving that the journey still obeys the frozen authorities. A use case is not permission to add missing functionality implicitly: a genuine capability gap must be classified as an existing implementation defect, an API/product capability gap, a separately scoped integration, or an Architecture Change Request.

Each use case should be selected for **capability coverage**, not marketing breadth. Prefer journeys that cross many authorities and stress their boundaries in a realistic sequence.

### Required use-case design

Every proposed use case should specify:

- **Actor and tenant model:** who participates, which organizations own which resources, and which identities/roles act at each step.
- **Business objective:** what the participant is trying to accomplish and what a successful outcome means.
- **Canonical executable path:** the exact authoritative order through creators, campaigns, opportunities/contributions, workflows, UGC/rights, disclosure, measurement/outcomes, evidence/PoV, reputation where applicable, disputes/risk, settlement/payment, demand/procurement, benefits, and adapters where applicable.
- **Capability coverage matrix:** each step maps to existing protocol capabilities and identifies which authority owns the resulting truth.
- **Positive and negative gates:** each material gate has a success path and a fail-closed path.
- **Economic path:** verified value, pending/mature states, conservation, settlement/payment lineage and any external-provider boundary used.
- **Trust path:** authorization, tenancy, replay, concurrency, atomicity, audit and privacy expectations appropriate to the journey.
- **Provider path:** at least one realistic provider-selection boundary when the relevant capability exists; provider-specific semantics remain behind adapters.
- **Determinism:** fixed anchors or authoritative subject timestamps in proof fixtures; no fresh wall-clock dependencies that make a canonical proof non-reproducible.
- **Durable witnesses:** authoritative state/version plus durable audit order wherever committed mutations establish sequence.
- **Out-of-scope boundary:** explicitly list features the use case must not silently invent.

### Use-case scoring model

Before authorization, rank candidate journeys by:

1. **Authority coverage** — number and importance of authoritative boundaries exercised.
2. **Economic coverage** — whether the path reaches verified value, settlement, payment, or benefit effects.
3. **Trust coverage** — tenancy, authorization, fraud/risk, dispute, replay, concurrency and atomicity.
4. **Interoperability coverage** — measurement, creator platforms, ad/supply integrations, payment or settlement adapters.
5. **Evidence depth** — ability to reconstruct provenance from raw/provider input through normalized outcomes and evidence to economic effect.
6. **Product realism** — whether the journey corresponds to a real user/business workflow rather than a synthetic test sequence.
7. **Failure-path richness** — whether meaningful negative scenarios can be exercised without inventing behavior.

Use cases that cover the same capabilities through nearly identical paths should be consolidated rather than multiplied.

## Candidate use-case families for the next architect to evaluate

These are **candidate shapes, not authorized work items**. The architect must verify actual repository capabilities before freezing any of them.

### Creator campaign execution

A brand discovers and selects a creator, agrees terms, creator accepts, produces UGC under explicit rights, completes disclosure/compliance, campaign results are measured, evidence/PoV is verified, risk/dispute controls are exercised, and verified creator value is settled/paid.

Core coverage: `/creators`, `/campaigns`, `/opportunities`, `/contributions`, `/workflows`, W017/W018 rights/disclosure, `/measurement`, `/outcomes`, `/evidence`, `/disputes`, `/settlement`, `/payments`, `/adapters`, audit/idempotency.

### Native advertising execution

An advertiser activates a campaign, selects eligible inventory/creator supply, places an execution, measures delivery/outcome through a provider boundary, verifies value, survives risk/dispute controls, and clears the resulting economic value.

Core coverage: `/campaigns`, `/inventory`, W021/W022/W023, `/workflows`, `/outcomes`, `/evidence`, `/disputes`, `/settlement`.

### Helpfulness/recommendation journey

A person presents a real need; eligible contribution opportunities are discovered; a participant provides a useful recommendation without being rewarded for raw activity or fabricated positive sentiment; evidence verifies helpfulness; the lifecycle completes and the resulting value is settled/reputationally accounted for where permitted.

Core coverage: `/opportunities`, `/contributions`, `/campaigns`, `/evidence`, `/outcomes`, `/reputation`, `/workflows`, `/settlement`, disclosure/moderation and AI-advisory boundaries.

### Consumer demand to benefit journey

Consumers form privacy-preserving demand, qualified demand reaches supplier competition, an offer is selected, fulfillment occurs, savings are verified against a supported baseline, verified value funds an eligible benefit allocation, and the member claims the benefit.

Core coverage: `/demand`, `/settlement`, supplier selection, savings/counterfactual evidence, `/benefits`, privacy/competition controls and economic conservation.

### Business procurement journey

Multiple business participants contribute demand without disclosing competitor-sensitive terms; suppliers submit offers; the system deterministically selects among eligible offers; fulfillment produces measured savings; savings evidence is verified and allocated through the benefit/economic authorities.

Core coverage: demand pools, procurement privacy, selection, evidence/counterfactuals, settlement and benefits.

### Cross-network settlement journey

A verified internal economic result is reconciled against an external settlement/payment provider fact, including authentication, freshness, idempotency, retry/failure and reconciliation mismatch behavior, while internal settlement remains authoritative.

Core coverage: `/settlement`, `/payments`, `/adapters`, W030 external settlement fact ingestion, audit and reconciliation invariants.

### Portable trust/reputation journey

A participant earns evidence-backed performance history, derives a privacy-preserving portable reputation proof, presents it to another context, and the receiving path verifies it without receiving raw private history or letting reputation become purchasable.

Core coverage: `/reputation`, W029 attestations/commitments, W031 proofs, privacy/disclosure and deterministic fail-closed verification.

## Testing doctrine for use-case work

The next architect should treat each use case as a **coverage instrument** over already-built protocol capabilities.

A strong implementation PR should normally contain:

- one canonical deterministic happy-path scenario;
- explicit authoritative traversal witnesses;
- durable audit ordering where sequence depends on committed mutations;
- one-to-one acceptance tests for the use-case's material gates;
- adversarial negatives for authorization and tenancy;
- replay and a real concurrent race at the material economic boundary;
- a genuine transaction-level fault injection after material work is staged, followed by a healthy same-key retry;
- provider-selection round-trip(s) for relevant external integrations;
- privacy/secret leakage regression;
- targeted mutation checks over each material guard, with byte-identical source restoration;
- repository-wide architecture and authority checks;
- complete local/integration verification and exact-head CI.

A terminal record is not proof of traversal. Local witness arrays without authoritative state/version or durable commit evidence are not proof of order. A stale-state rejection is not a composite atomicity proof. A green CI run is not architect approval.

## Capability-gap handling

When a use case reaches a missing capability, stop and classify the gap instead of filling it opportunistically:

| Gap | Correct treatment |
|---|---|
| Existing behavior is incorrect | Fix at the existing owning authority; add regression/mutation evidence. |
| Capability exists but product/API cannot expose it | Create an explicitly scoped API/product-client work item under the existing boundary. |
| External provider is required but integration boundary is skeletal | Scope provider integration separately; keep semantics in the existing owning authority. |
| Requirement conflicts with frozen architecture | Open an Architecture Change Request and create a new architecture version before implementation. |
| Requirement is W036/procurement/benefit behavior absent from a use-case scope | Do not invent a new behavior merely to complete the scenario. |
| UX needs a read model not served by the API | Document it as a backend capability gap; never recreate authority in the client. |

## Frozen authority map

- `/workflows` — sole lifecycle authority.
- `/settlement` — sole economic/ledger authority.
- `/evidence` — evidence/provenance/Proof-of-Value authority.
- `/outcomes` — normalized outcome/measurement semantics authority.
- `/measurement` — measurement provider integration boundary.
- `/reputation` — reputation authority.
- `/disputes` — risk, challenge and dispute authority.
- `/campaigns` — campaign policy authority.
- `/creators` — creator records, identity-facing creator semantics and matching inputs.
- `/inventory` — inventory, supply and placement authority.
- `/demand` — demand/procurement/supplier-selection/savings semantics.
- `/benefits` — Benefit Pool semantics.
- `/adapters` — provider-specific integration.
- `/payments` — payment-provider integration only; settlement remains authoritative.
- `/llm` — provider-neutral AI; advisory/evidence input only.
- `/agents` — orchestration mechanisms; never authoritative state.

PostgreSQL is authoritative application state in v1.0. Redis, queues and worker memory are never authoritative. External platforms remain authoritative for their own platform state.

## Historical review lessons that still govern new use cases

- Positive tests are insufficient; pair them with behavioral negative guards.
- Cross-tenant references fail closed without existence oracles.
- Completed same-key replay reaches idempotency storage before mutable reads; fresh keys re-check current-state gates.
- Coupled economic mutations use one authoritative transaction and `...WithinTx` primitives.
- Composite atomicity must fail after material work is staged in the real transaction; then prove a healthy same-key retry.
- Audit publication is post-commit and failed commits discard the audit buffer.
- AI is never authorization or economic truth.
- Provider credentials resolve through `SecretProvider` and fail closed.
- Aggregate disclosure gates cover all aggregate facts, including machine-readable fields.
- Procurement commitment counts and distinct buyer-organization counts are separate dimensions.
- Supplier hard eligibility precedes deterministic selection; competition remains in `/demand`.
- Savings/counterfactuals require supported baselines and preserved uncertainty.
- Benefit funding is references-only and economic posting remains `/settlement` owned.
- Mutation helpers must actually change behavior and restore source bytes exactly.
- Phase-9 traversal proofs require executable order plus authoritative state/version and durable audit witnesses.
- Canonical proof fixtures use fixed/authoritative anchors; do not introduce fresh `Date.now()`/randomness unless isolated to an explicitly required provider-freshness behavior.
- Product clients consume the versioned API and cannot become protocol authority.

## Canonical development/merge loop

```text
governance authorization
  ↓
frozen use-case/work order + evidence contract
  ↓
implementation branch
  ↓
verification + evidence
  ↓
exactly one implementation PR
  ↓
architect review
  ├─ CHANGES REQUESTED → remediate same branch/PR → re-verify
  └─ APPROVED + CI green → merge
  ↓
update project state + roadmap
  ↓
select next authorized use case
```

Do not bypass governance by treating a useful test scenario as an automatically authorized feature.
