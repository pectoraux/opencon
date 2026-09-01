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

NET-W001 through **NET-W030 are complete** (every frozen v1.0 domain is implemented; the Phase-8 integrity layer and the fact-ingestion/reconciliation layer are in place).

Latest merge:
- NET-W030 issue #61
- PR #62
- merge SHA `1d902e2148920ddd04e2b170509184d7b585cb3e`

The current implementation target is **NET-W031 — Portable reputation proofs**.

- GitHub issue: #63 — READY_FOR_IMPLEMENTATION
- Status: CURRENT IMPLEMENTATION TARGET
- Prepared branch: `feat/net-w031-portable-reputation-proofs`
- Requirements: REP-003..004, PRIV-001..003
- Dependencies: NET-W007, NET-W029 — merged/verified
- Decision record: `spec/work-orders/NET-W031.md`
- Evidence artifact: `docs/net-w031-portable-reputation-proofs.md`

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

## W030 completed shape

W030 added the Phase-8 fact-ingestion/reconciliation layer INSIDE `/settlement`: external settlement transactions arrive as AUTHENTICATED, IDEMPOTENT, append-only FACTS (HMAC-SHA256 trust envelope per provider; SecretProvider-only material; fail-closed with NO dev fallback; 15-minute freshness window), recorded exactly-once per (organization scope, provider, external id) with composite idempotency + an in-tx identity backstop, and deterministically RECONCILED against the internal ledger lineage (matched/pending/mismatched; machine-readable closed-vocabulary reasons; DERIVED on read; mismatches recorded + audited, never auto-corrected). The neutral `ExternalSettlementProviderAdapter`/`ExternalSettlementAuthenticator` contracts live in the `/settlement` port; the reference adapter implements them STRUCTURALLY under `/adapters` with ZERO domain imports (the W029 composition-root discipline applied to the adapter tier).

Key safeguards retained for W031+:
- an external fact can never mint, consume, reverse or mutate internal economic state (AC-04 pins identical ledger entries/balances/value records across all recording paths);
- `/payments` stays skeletal (architecture-lock §14 invariant 25 — external execution remains out of scope);
- the neutral contract is declared in the CONSUMING domain's port and implemented structurally in the provider tier — the composition root is the only join, enforced by `tsc` at the wiring site.

## W031 acceptance shape

```text
/reputation internal reputation authority (W007 — UNCHANGED)
(dimension state, authoritative inputs, snapshots, time decay)
        ↓ neutral lookups (aggregate, opaque-reference facts only)
/evidence W029 signed-attestation machinery (COMPOSED — no new crypto)
        ↓
portable reputation PROOFS (derived, tenant-scoped at issuance,
 self-contained at presentation, aggregate disclosure only)
        ↓
verification: deterministic + fail-closed (machine-readable reasons)
no raw private record, no cross-tenant data, no reputation transfer
```

## W031 non-negotiables

1. Proofs are DERIVED views over the authoritative `/reputation` state — never a second reputation authority, never raw record transfer (PRIV-001..002).
2. Proof issuance composes the W029 machinery: REP-004 evidence lineage via opaque references; no new signing surface, no new key-material class.
3. Disclosure is AGGREGATE and scoped under the aggregate disclosure gate — no raw personal activity, payloads, or cross-tenant data (PRIV-003).
4. Verification is deterministic, non-mutating, fail-closed with machine-readable reasons from a closed vocabulary; it never queries tenant-scoped state (self-contained presentation).
5. Reputation remains non-purchasable (REP-002): no proof path accepts spend/wealth as reputation substance.
6. Time decay applies at derivation (REP-003): disclosed scores are the authority's own deterministic decayed values, never presentation-side recomputations.
7. Proofs are tenant-scoped at issuance with guard-action authorization, composite idempotency, one authoritative transaction, transactional audit; presentation/verification mutates and audits nothing.
8. Proofs are immutable after issuance; revocation is a one-way field mutation (the W029 discipline); staleness is verification-time derivation, never stored lifecycle.
9. AI/model output, if used, is advisory only and cannot authorize proof issuance or verification outcomes.
10. W032+ decentralized validation and W033+ end-to-end flows remain excluded.
11. Frozen `spec/architecture.md` and `spec/architecture-lock.md` remain unchanged.

## Required acceptance coverage

The implementation must include tests for:

- proof issuance round-trips composing the W029 signed-attestation machinery (neutral lookups; the composition root is the only join);
- aggregate-disclosure containment: no raw personal activity, no evidence payloads, no cross-tenant data on any proof surface;
- deterministic verification with fail-closed paths (tampered signature/facts, stale, revoked, malformed) and machine-readable reasons from the closed vocabulary;
- non-purchasability containment (REP-002): spend/wealth never alters disclosed dimension state through any proof path;
- time-decay consistency (REP-003): disclosed scores equal the authority's own decayed values at issuance;
- evidence lineage traceability (REP-004): proofs reference authoritative input/evidence lineage ids opaquely;
- tenancy and authorization fail-closed semantics (no existence oracles);
- idempotency, concurrency and composite atomicity with commit-failure injection at issuance;
- targeted mutation checks for disclosure containment, determinism, idempotency and verification soundness;
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
