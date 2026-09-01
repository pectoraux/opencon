# OpenCon LLM Architect Handoff

## Start here

For a new LLM architect with no conversation context, read in this order:

1. `AGENTS.md`
2. `spec/PROJECT-STATE.md`
3. `spec/ROADMAP.md`
4. `spec/architecture.md`
5. `spec/architecture-lock.md`
6. `spec/requirements.md`
7. `spec/work-items.md`
8. `spec/dependency-graph.md`
9. the active GitHub issue, work order, evidence package, and implementation PR

The repository, not prior conversation, is the source of truth.

## Current checkpoint

NET-W001 through **NET-W029 are complete** (every frozen v1.0 domain is implemented and the Phase-8 integrity layer is in place).

Latest merge:
- NET-W029 issue #58
- PR #60
- merge SHA `cf53378e1c432dfd735e1b408010eece55d7612f`

The current implementation target is **NET-W030 — External settlement adapters**.

- GitHub issue: #61 — READY_FOR_IMPLEMENTATION
- Status: CURRENT IMPLEMENTATION TARGET
- Prepared branch: `feat/net-w030-external-settlement-adapters`
- Requirements: SETTLE-001..003, ADAPTER-008
- Dependencies: NET-W008, NET-W029 — merged/verified
- Decision record: `spec/work-orders/NET-W030.md`
- Evidence artifact: `docs/net-w030-external-settlement-adapters.md`

## Frozen authority map

- `/workflows` — lifecycle authority
- `/evidence` — evidence/proof authority
- `/outcomes` — normalized measurement authority
- `/reputation` — reputation authority
- `/settlement` — economic/ledger authority
- `/disputes` — risk/dispute authority
- `/campaigns` — campaign policy authority
- `/creators` — creator semantics and creator-facing records
- `/inventory` — inventory and placement authority
- `/demand` — demand/procurement/supplier-selection/savings semantics
- `/benefits` — Benefit Pool semantics (W028; existing frozen boundary)
- `/measurement` — measurement integration/neutral measurement boundary
- `/adapters` — provider-specific external integrations
- `/llm` — provider-neutral LLM boundary
- `/agents` — agent/orchestration mechanisms

The v1.0 architecture freezes sixteen domain boundaries. A new domain requires an explicit Architecture Change Request and a new architecture version.

## W028 completed shape

W028 activated the LAST skeletal frozen domain: `/benefits` now carries Benefit Pools — funding references resolved server-side to authoritative upstream value only (MATURE unconsumed `/settlement` value records execute the settlement reward draw `WithinTx`; W027 verified savings fund entitlement-only allocations that post nothing), versioned immutable allocation policies, deterministic scaled-integer conservation-preserving allocation, privacy-preserving member views, one authoritative transaction per allocation.

Key safeguards retained for W029+:
- funding is references-only — amounts re-derive in-tx at every anchor;
- the drawable/entitlement dichotomy keeps every posting inside `/settlement`;
- the settlement reward policy must mirror the member declarations exactly (the locked accounts are always the posted accounts);
- conservation arithmetic uses scaled integers with explicit remainders;
- the W027 savings re-derivation is the current-verdict surface W028 consumed.

## W029 completed shape

W029 extended the W005 `/evidence` foundation with the Phase-8 integrity layer: production signed attestations (real Ed25519/ECDSA P-256 via node:crypto behind injected versioned interfaces; closed versioned algorithm + key-reference vocabularies with a frozen pairing map; SecretProvider-only keys with fail-closed selection and construction-time key validation), salted-sha256 coverage commitments over the three authoritative record families (evidence, reputation inputs, settlement value records) through neutral in-tx lookups, the deterministic `attestation/v2` canonical input rebuilt from STORED digests, fail-closed verification with a closed machine-readable reason vocabulary, and one-way revocation.

Key safeguards retained for W030+:
- the lifecycle/substantive-content dichotomy: covered commitments bind substantive content; lifecycle invalidation (REVERSED) fails closed through the explicit current-state gate;
- the W005 (v1) and W029 (v2) signing surfaces are independent — existing deployment boot contracts are preserved;
- key material is validated at construction, never at first use.

## W030 acceptance shape

```text
/settlement internal economic authority (W008/W014/W020)
        ↓ neutral internal lineage references
/adapters provider-specific external settlement integrations
(authenticated + fail-closed; the W023 discipline)
        ↓
external settlement transaction FACTS (append-only, idempotent,
provider-authenticated, tenant-scoped)
        ↓
/settlement records the facts + DERIVES the deterministic reconciliation
(matched / pending / mismatched — never an economic mutation)
        ↓
PostgreSQL remains THE authoritative state
(an external fact can never mint, consume or mutate internal value)
```

## W030 non-negotiables

1. External transaction facts attach to the existing internal settlement lineage by canonical id; they never mint, consume or mutate internal economic state.
2. `/settlement` remains the SOLE economic authority: adapters provide transaction FACTS (architecture-lock §14 invariant 25); no external execution of internal mutations; no second ledger.
3. `/adapters` owns ALL provider-specific code; `/settlement` consumes ONLY the neutral `ExternalSettlementAdapter` contract wired at the composition root; no 17th domain.
4. Adapter-delivered facts are AUTHENTICATED with SecretProvider-resolved material; unauthenticated, stale or malformed submissions fail closed — never silently recorded.
5. Fact recording is idempotent per (organization scope, provider, external id): exactly-once, replay-safe, concurrency-safe.
6. Reconciliation (matched/pending/mismatched) is DERIVED, deterministic and server-side with machine-readable reasons; mismatches are recorded + audited, never auto-corrected.
7. Tenant and authorization failures remain fail-closed without existence oracles.
8. Material mutations use the established composite idempotency, one-authoritative-transaction, transactional-audit and post-commit publication patterns.
9. AI/model output, if used, is advisory only and cannot authorize ingestion or reconciliation outcomes.
10. W031+ portable reputation proofs, W032+ decentralized validation and W033+ end-to-end flows remain excluded.
11. Frozen `spec/architecture.md` and `spec/architecture-lock.md` remain unchanged.

## Required acceptance coverage

The implementation must include tests for:

- external transaction fact records (append-only, immutable, idempotent per (scope, provider, external id), tenant-scoped);
- authenticated adapter ingestion over the neutral contract (unauthenticated/stale/malformed fail closed);
- deterministic reconciliation: matched/pending/mismatched with machine-readable reasons; mismatches recorded + audited, never auto-corrected;
- no-economic-bypass containment: an external fact can never create/consume/reverse/mutate internal value, credits, cash or reward state;
- traceability in both directions (internal lineage ⇄ external facts);
- tenancy and authorization fail-closed semantics;
- idempotency, concurrency and composite atomicity with commit-failure injection;
- targeted mutation checks for authentication, determinism, idempotency and authority containment;
- `bun run verify`, architecture/authority checks, secret scan and configured PostgreSQL/Redis integration;
- frozen architecture and architecture-lock unchanged.

## Merge protocol

```text
implementation
→ verification + evidence
→ exactly one PR
→ architect review
→ changes requested: remediate same PR
→ approved + CI green: merge
```

Never merge solely because CI is green.

## Required persistence after every work item

After merge, update `spec/PROJECT-STATE.md` with the merged PR/SHA, next work item, architectural lessons, verification baseline, and active issue/work-order/evidence links. Update `spec/ROADMAP.md` when roadmap interpretation or sequencing changes. Keep `spec/work-items.md` as the original backlog unless the project explicitly versions it.
