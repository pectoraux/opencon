# NET-W023 — OpenRTB and supply-chain adapters

**Status:** READY_FOR_IMPLEMENTATION
**GitHub issue:** #46
**Work order:** `spec/work-orders/NET-W023.md`
**Architecture:** v1.0 FROZEN
**Dependencies:** NET-W019 + NET-W022 merged

## Purpose

This document is the durable evidence ledger for NET-W023. It must be completed from the actual implementation branch and PR. It exists so a new LLM architect can review the work without conversation history.

## Architectural decision record

External OpenRTB and supply-chain protocols are adapter concerns only. Provider-specific syntax, SDK types, credentials and wire objects remain inside `/adapters`. Normalized facts cross the bootstrap composition root only and are consumed through existing authoritative contracts.

`/inventory` owns supply ownership/placement semantics; `/campaigns` owns campaign policy; `/measurement` + `/outcomes` own measurement semantics; `/evidence` owns provenance/truth; `/disputes` owns risk/control; `/settlement` owns economic mutation; `/workflows` owns lifecycle. W023 must not create a second authority in any of these areas.

## Evidence matrix

| AC | Required evidence | Status |
|---|---|---|
| AC-01 provider-neutral OpenRTB contract | contract/interface tests + field/type containment pin | PENDING |
| AC-02 fail-closed OpenRTB validation | exhaustive malformed/version/cardinality/critical-value tests | PENDING |
| AC-03 supply-chain normalization | ads.txt/app-ads.txt/sellers.json/schain fixtures + provenance/verification tests | PENDING |
| AC-04 exact-one inventory resolution | neutral inventory lookup + unknown/ambiguous/cross-tenant tests | PENDING |
| AC-05 no authority bypass | inventory/campaign/risk/evidence/settlement regression tests | PENDING |
| AC-06 determinism/privacy | digest/recomputation + raw-payload and secret-isolation scans | PENDING |
| AC-07 tenancy/idempotency/atomicity | material-operation authorization/concurrency/fault-injection tests | PENDING |
| AC-08 architecture regression | frozen file pins + `arch:check` + `authority:check` + dependency scans | PENDING |

## Mutation evidence required

The final evidence must show that each of these deliberate mutations causes a test failure, then is restored:

1. unsupported OpenRTB version becomes accepted;
2. cardinality or critical-value validation is removed;
3. provider-specific fields escape into a neutral/domain contract;
4. ambiguous external identity is treated as authoritative ownership;
5. unverified/stale supply-chain data makes inventory settlement-ready or clears risk;
6. raw bid payload is persisted or a secret is emitted;
7. an idempotency or transaction boundary is bypassed.

## Privacy evidence

Prove that raw request payloads are not persisted by default and that sensitive identifiers, credentials and signing material do not appear in normalized records, logs, audit metadata or error context. Any redaction summary contains field names only and is bounded.

## Final verification record

Complete this section only from the implementation branch/PR:

- `bun run verify`: PENDING
- `arch:check`: PENDING
- `authority:check`: PENDING
- real PostgreSQL/Redis integration: PENDING
- mutation checks: PENDING
- secret scan: PENDING
- implementation PR: PENDING
- architect review: PENDING
- merge SHA: PENDING

## Completion rule

Do not mark W023 complete until the issue acceptance criteria, implementation evidence, mutation evidence, architecture checks, full verification, CI and architect approval all agree. Update `spec/PROJECT-STATE.md` immediately after merge with the final SHA and next work item.
