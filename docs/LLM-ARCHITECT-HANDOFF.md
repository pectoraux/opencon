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

NET-W001 through **NET-W028 are complete** (every frozen v1.0 domain is now implemented).

Latest merge:
- NET-W028 issue #56
- PR #57
- merge SHA `6e309e2af05a962e3417999ad8079da16d9ebc37`

The current implementation target is **NET-W029 — Cryptographic attestations and commitments**.

- GitHub issue: #58 — READY_FOR_IMPLEMENTATION
- Status: CURRENT IMPLEMENTATION TARGET
- Prepared branch: `feat/net-w029-cryptographic-attestations`
- Requirements: EVID-006, PRIV-003
- Dependencies: NET-W005, NET-W007, NET-W008 — merged/verified
- Decision record: `spec/work-orders/NET-W029.md`
- Evidence artifact: `docs/net-w029-cryptographic-attestations.md`

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

## W029 acceptance shape

```text
existing authoritative records
(evidence records; reputation inputs; settlement value records)
        ↓ neutral reference (canonical ids, committed digests)
/evidence attestation + commitment semantics (the W005 boundary, extended)
        ↓
signed attestations (versioned algorithms + SecretProvider key references)
+ hash commitments (payload-hiding, binding)
        ↓
deterministic server-side verification (fail closed)
        ↓
PostgreSQL remains THE authoritative state
```

## W029 non-negotiables

1. Attestations/commitments attach to existing authoritative records; they never mint new semantic authority or mutate authoritative state.
2. Cryptography is an integrity/provenance layer, never a consensus layer: no blockchain, no network validation, no token economics.
3. `/evidence` remains the home of attestation/commitment semantics (the W005 contracts are the foundation — extend, never rewrite); `/reputation` and `/settlement` ports stay untouched.
4. Signature verification is deterministic, server-side, version-pinned; failures fail closed; algorithm/key vocabularies are closed and frozen.
5. Commitments hide sensitive payloads while binding to them; disclosure reveals only what the frozen privacy rules permit (PRIV-003).
6. Keys resolve only through `SecretProvider`; no key material is ever committed; secret scan stays clean.
7. PostgreSQL remains authoritative: an attestation can never resurrect revoked/invalidated/superseded authoritative state.
8. Material mutations use the established composite idempotency, concurrency, one-authoritative-transaction, transactional-audit and post-commit publication patterns.
9. Cross-tenant and unauthorized access fails closed without existence oracles.
10. AI/model output, if used, is advisory only and cannot authorize attestations, commitments or verification outcomes.
11. W030+ external settlement adapters, W031+ portable reputation proofs, W032+ decentralized validation and W033+ end-to-end flows remain excluded.
12. Frozen `spec/architecture.md` and `spec/architecture-lock.md` remain unchanged.

## Required acceptance coverage

The implementation must include tests for:

- attestation/commitment records over the three authoritative record families (evidence, reputation inputs, settlement value records);
- signed attestations with versioned algorithm/key vocabularies and SecretProvider-resolved keys;
- signing/verification round-trips and deterministic reproducibility;
- tamper detection: mutated payload/statement/covered-set/signature/algorithm/key fails closed with machine-readable reason;
- commitment binding + privacy preservation (no plaintext on the record; PRIV-003);
- tenancy and authorization fail-closed semantics;
- idempotency, concurrency and composite atomicity with commit-failure injection;
- authority containment: an attestation never resurrects invalidated state; PostgreSQL stays authoritative; no consensus/external execution;
- targeted mutation checks for tamper detection, determinism, privacy and authority containment;
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
