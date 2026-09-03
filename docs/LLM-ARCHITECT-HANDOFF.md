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
10. the relevant use-case work order, evidence contract and GitHub PR discussion when auditing the active decision

The repository is the source of truth. Do not rely on prior chat context.

## Current checkpoint

The canonical protocol implementation program is complete through **NET-W036**. The first authorized post-backlog product-client work, **UX-01**, is also complete. The first post-backlog capability-validation use case, **UC-01**, is now governed and authorized.

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

### First post-backlog validation use case

- **UC-01 — Consumer demand to member benefit validation: AUTHORIZED.**
- Governance issue: #85.
- Governance PR: #86.
- Frozen work order: `spec/work-orders/UC-01.md`.
- Evidence contract: `docs/uc-01-consumer-demand-benefit.md`.

## Program status

**UC-01 IS AUTHORIZED; IMPLEMENTATION IS NOT YET STARTED.**

UC-01 is a validation and capability-composition instrument, not a new protocol subsystem. Its frozen path is:

```text
consumer demand
→ privacy-preserving qualification
→ supplier competition
→ sanctioned fulfillment
→ provider measurement
→ normalized outcome
→ evidence-backed savings
→ savings-funded benefit entitlement
→ privacy-preserving member view
```

It composes the existing authorities under Architecture v1.0. It does not create W037, a new domain, a new dependency edge, a second ledger, a new lifecycle authority, or a payment authority.

## UC-01 implementation rule

Before coding, read:

1. `spec/work-orders/UC-01.md`
2. `docs/uc-01-consumer-demand-benefit.md`
3. W024–W028 evidence and relevant W033–W036 composition evidence.

Then create exactly one implementation branch and exactly one implementation PR bound to issue #85. Implementation must remain inside the frozen scope.

When a missing capability appears, stop and classify it:

| Gap | Correct treatment |
|---|---|
| Existing behavior is incorrect | Fix at the owning authority; add regression/mutation evidence. |
| API/product capability missing | Separately authorize the `/api` or product work; never recreate protocol authority in the client. |
| External provider integration missing | Separately authorize the existing integration boundary. |
| Requirement conflicts with frozen architecture | Architecture Change Request + new architecture version. |
| Cash/credit redemption or other unsupported future behavior | Exclude from UC-01; do not invent it. |

## Candidate-selection decision

UC-01 was selected because it adds consumer-side business realism and product/API pressure without simply repeating the already-proven W033 contribution, W034 advertising, W035 creator and W036 business-procurement compositions. The candidate ranking and scope-freeze record are in issue #85 and the UC-01 work order.

## Required use-case design

Every active use-case implementation must specify:

- actor and tenant model;
- business objective;
- canonical executable authority traversal;
- capability coverage matrix;
- positive and negative gates;
- economic path and conservation rules;
- trust path covering authorization, tenancy, replay, concurrency and atomicity where applicable;
- provider path through existing adapters;
- deterministic proof anchors;
- durable state/version and audit witnesses;
- explicit out-of-scope boundary.

A terminal record or local witness array is not proof of traversal. A stale-state rejection is not a composite atomicity proof. A green CI run is not architect approval.

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

## Historical review lessons that still govern UC-01

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
- Canonical proof fixtures use fixed/authoritative anchors; fresh wall-clock or random identifiers are forbidden except explicitly isolated provider-freshness semantics.
- Product clients consume the versioned API and cannot become protocol authority.
- UC-01 must not turn a missing API/provider/redemption capability into an opportunistic subsystem.

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
