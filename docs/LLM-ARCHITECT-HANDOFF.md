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

NET-W001 through **NET-W022 are complete**.

Latest merge:
- NET-W022 issue #44
- PR #45
- merge SHA `45f1884656e470666e764266735ea59ec728c0ea`

The current implementation target is **NET-W023 — OpenRTB and supply-chain adapters**.

- GitHub issue: #46
- Status: READY_FOR_IMPLEMENTATION
- Prepared branch: `feat/net-w023-openrtb-supply-chain-adapters`
- Requirements: ADAPTER-001..002
- Dependencies: NET-W019 and NET-W022 — merged
- Decision record: `spec/work-orders/NET-W023.md`
- Evidence artifact: `docs/net-w023-openrtb-supply-chain.md`

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
- `/measurement` — measurement integration/neutral measurement boundary
- `/adapters` — provider-specific external integrations
- `/llm` — provider-neutral LLM boundary
- `/agents` — agent/orchestration mechanisms

The v1.0 architecture freezes sixteen domain boundaries. A new domain requires an explicit Architecture Change Request and a new architecture version.

## W023 acceptance shape

W023 must connect external advertising infrastructure without becoming an advertising authority:

```text
OpenRTB / ads.txt / app-ads.txt / sellers.json / schain input
                         ↓
              provider-specific adapter
                         ↓
             normalized neutral facts
                         ↓
               composition root only
                         ↓
 existing inventory/campaign/measurement/evidence/risk/settlement authorities
```

Provider-specific protocol vocabulary and SDK types remain inside `/adapters`. External syntax or signatures do not equal OpenCon ownership, eligibility, risk clearance or settlement authorization.

## W023 non-negotiables

1. `/inventory` owns supply ownership, placement context, eligibility and settlement-readiness.
2. `/campaigns` owns campaign policy/targeting; external bid-request fields cannot override campaign policy.
3. `/outcomes` owns normalized measurement semantics; W022 attribution remains a provider fact, not protocol authority.
4. `/evidence` owns material provenance/truth; adapter integrity checks are evidence inputs, not authorization.
5. `/disputes` owns risk/control decisions; adapter assertions cannot self-clear risk.
6. `/settlement` owns all economic mutation; bids, impressions, clicks and external responses cannot create ledger state directly.
7. External seller/publisher/app identifiers must resolve to exactly one registered inventory source or fail closed.
8. Raw vendor/bid payloads are opaque outside the owning adapter and are not persisted by default.
9. Normalization is deterministic, versioned, bounded and privacy-minimized.
10. Any material mutation uses established authorization, tenancy, idempotency, concurrency, transaction and audit patterns.
11. Coupled material mutations use one authoritative transaction or an explicitly approved recoverable saga.
12. No provider SDK/type leakage into domains.
13. No new domain boundary.

## Required acceptance coverage

The implementation must include tests for:

- provider-neutral OpenRTB request/response contract and version validation;
- fail-closed malformed/unsupported/cardinality/critical-value validation;
- provider-field containment and no SDK vocabulary crossing into domains;
- normalized ads.txt/app-ads.txt/sellers.json/schain-style authorization facts with provenance and verification state;
- exact-one inventory identity resolution, with unknown/ambiguous mappings rejected;
- stale/unverified supply-chain facts unable to create ownership, placement eligibility, risk clearance or settlement readiness;
- deterministic normalization and bounded privacy retention;
- absence of raw payload persistence by default;
- secret isolation from records/logs/audit/errors;
- tenant/auth/idempotency/concurrency/audit/transaction lineage for any material composite;
- mutation checks proving the major architectural invariants;
- frozen architecture and architecture-lock remain unchanged.

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
