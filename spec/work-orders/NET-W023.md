# NET-W023 — OpenRTB and supply-chain adapters

**Status:** READY_FOR_IMPLEMENTATION
**Architecture:** v1.0 (FROZEN — `spec/architecture.md`, `spec/architecture-lock.md` MUST remain unchanged)
**Requirements:** ADAPTER-001..002
**Dependencies:** NET-W019, NET-W022 — VERIFIED/MERGED
**Tracking:** GitHub issue #46
**Implementation branch:** `feat/net-w023-openrtb-supply-chain-adapters`

## §1 Objective

Connect existing external advertising supply to OpenCon through the existing `/adapters` boundary. OpenRTB and supply-chain protocols are external interoperability mechanisms; they must not become a second inventory, campaign, measurement, evidence, risk or economic authority.

Definition of done: an external ad request/response can be validated and normalized into provider-neutral protocol facts, with supply-chain authorization/provenance attached, while OpenCon's existing authoritative domains retain ownership of all semantics and material mutations.

## §2 Architecture decision of record

```text
external provider protocol
(OpenRTB / ads.txt / app-ads.txt / sellers.json / schain)
                         ↓
               /adapters provider tier
                         ↓
             neutral protocol contracts
                         ↓
               bootstrap composition root
                         ↓
 /inventory /campaigns /measurement /evidence /disputes /settlement
            existing authorities only
```

### Authority rules

- `/adapters` owns provider-specific wire formats, SDK types, parsers, serializers, credentials and external transport details.
- `/inventory` remains authoritative for registered supply, owner/source identity, placements, eligibility and derived settlement-readiness.
- `/campaigns` remains authoritative for campaign policy and targeting. An external request may describe supply/context but cannot override campaign policy.
- `/measurement` and `/outcomes` remain authoritative for measurement semantics. External attribution/traffic information is an input/fact, not a final measurement verdict.
- `/evidence` remains authoritative for material provenance/commitments. A valid signature or authorized publisher record is evidence, not ownership authorization by itself.
- `/disputes` remains authoritative for fraud/risk controls. External seller-chain data cannot self-clear risk or disputes.
- `/settlement` remains the sole economic authority. No OpenRTB bid, impression, click, response, clearing result or external identifier may directly post ledger value.
- `/workflows` remains the lifecycle authority and is untouched by W023.
- No new domain boundary is permitted.

## §3 Scope

### §3.1 Provider-neutral OpenRTB contract

Create a neutral contract sufficient for the current advertising surface, with explicit versioning and bounded protocol vocabulary. The contract must be independent of any vendor SDK.

Required normalized concepts should be limited to protocol-relevant facts such as request id/trace reference, protocol version, timestamp/expiration where required, bounded impression slots and placement requirements, explicitly permitted context signals, floor/currency inputs as economic facts rather than ledger mutations, normalized response/ad-selection facts needed by the existing campaign/inventory flow, and supply-chain/provenance references.

Do not copy a complete provider object graph into the domain contract.

### §3.2 OpenRTB adapter boundary

Implement provider-specific parsing and validation in `/adapters` only.

Fail closed for unsupported protocol versions, malformed structures, missing required identifiers, invalid object cardinality, contradictory or unsafe critical values, over-broad arrays/payload sizes, provider identity spoofing, and invalid/ambiguous supply-chain references.

Raw payloads remain opaque outside the owning adapter and are not retained by default.

### §3.3 Supply-chain normalization

Support normalized, provider-neutral facts derived from ads.txt, app-ads.txt, sellers.json and SupplyChain (`schain`)-style inputs.

The normalized representation should capture only protocol-required facts such as source/provider identity, publisher/seller/app reference, a closed relationship/type vocabulary, provenance source, observed/effective time/version where available, verification status, rejection/ambiguity reason where needed, and deterministic digest material where reproducibility matters.

Provider-specific field names and SDK types remain inside `/adapters`.

### §3.4 Exact-one inventory resolution

External seller/publisher/app identifiers resolve through a neutral read-only inventory lookup.

- zero matches → fail closed;
- multiple matches → fail closed;
- cross-tenant match → fail closed / not-found semantics;
- external assertions never create `InventoryItem` ownership;
- external authorization facts never assert placement settlement-readiness;
- stale/unverified supply-chain facts may remain facts where appropriate but cannot be promoted to authorization.

### §3.5 Composition root

The bootstrap composition root is the only place where normalized adapter output may connect to existing domain authorities. It may resolve supply identifiers against inventory, provide normalized request facts to campaign/inventory logic, route measurement facts through `/measurement` → `/outcomes`, and invoke existing authoritative material operations when explicitly required.

The composition root may not duplicate domain semantics.

### §3.6 Privacy and secrets

- No full raw OpenRTB payload persistence by default.
- Do not copy device identifiers, user identifiers, IP addresses or other sensitive vendor fields unless explicitly required by an approved neutral contract.
- Credentials/signing keys/transport secrets resolve only through `SecretProvider`.
- Secrets and raw sensitive vendor values never appear in audit events, logs, error context or normalized records.
- Redaction summaries, when needed, contain names only and are bounded.

### §3.7 Material mutations

Any durable/material adapter-to-domain operation must preserve server-side authorization, organization scope, idempotency, PostgreSQL authority, concurrency safety and transactional audit lineage. Redis is coordination only. Coupled material state uses one authoritative transaction or an explicitly approved recoverable saga.

No economic mutation may be implemented in `/adapters`.

## §4 Acceptance criteria

### AC-01 — Provider-neutral OpenRTB contract

The neutral contract is versioned, bounded and contains only protocol facts needed by OpenCon. Provider SDK types and vendor-specific semantics do not cross into domain authorities.

### AC-02 — Fail-closed OpenRTB validation

Supported versions, required fields, cardinality limits and critical values are validated deterministically with a closed machine-readable rejection vocabulary. Malformed/unsupported/oversized/contradictory input is rejected without mutation.

### AC-03 — Supply-chain normalization

ads.txt, app-ads.txt, sellers.json and schain-style inputs normalize to one provider-neutral representation with provenance, verification status and bounded vocabulary; invalid/ambiguous input fails closed.

### AC-04 — Exact-one inventory resolution

An external seller/publisher/app identifier resolves to exactly one registered inventory source or fails closed. The adapter cannot fabricate ownership, placement or settlement readiness.

### AC-05 — No authority bypass

External protocol facts cannot authorize campaigns, make supply settlement-ready, clear risk, manufacture evidence truth, create finalized measurements or create economic value.

### AC-06 — Determinism and privacy

Normalization is reproducible for identical inputs/reference context; raw payloads are not persisted by default; sensitive vendor values and secrets never appear in normalized records, audit, logs or errors.

### AC-07 — Tenancy/idempotency/transaction lineage

Any material adapter-to-domain operation is tenant-scoped, authorized, idempotent, concurrency-safe and auditable. Coupled material state shares one authoritative transaction.

### AC-08 — Architecture regression

`spec/architecture.md` and `spec/architecture-lock.md` remain unchanged; architecture/authority checks remain green; provider-specific vocabulary stays inside `/adapters`; no new domain boundary is introduced.

## §5 Required implementation evidence

Create acceptance suites under `tests/adapters/` and architecture regressions under `tests/regression/`.

Required test classes include contract/version pinning, malformed/version/cardinality/critical-value rejection, deterministic normalization and digest recomputation, provider-field containment, ads.txt/app-ads.txt/sellers.json/schain fixtures, exact-one inventory resolution and ambiguity/cross-tenant rejection, stale/unverified chain data unable to authorize inventory or settlement readiness, no raw-payload retention by default, privacy/secret scans, and material-operation authorization/idempotency/concurrency/atomicity lineage.

Mutation checks must intentionally reintroduce the major failure modes: fail-open version/cardinality validation, provider-field leakage, ambiguous ownership acceptance, supply-chain promotion to settlement-readiness, raw-payload persistence or secret leakage, and idempotency/transaction bypass.

Required completion artifacts:

- `spec/work-orders/NET-W023.md`
- `docs/net-w023-openrtb-supply-chain.md`

## §6 Verification gate

```text
implementation complete
+ AC-01..AC-08 satisfied
+ architecture + authority checks clean
+ mutation checks catch bypasses
+ bun run verify green
+ configured real PostgreSQL/Redis integration green
+ exactly one implementation PR
+ architect approval recorded
→ merge
```

Do not merge on green CI alone.

## §7 Explicit non-goals

- campaign matching redesign;
- attribution/privacy redesign;
- direct settlement/payment execution;
- new inventory or placement authority;
- direct risk/dispute authority;
- raw vendor data lake;
- provider SDK leakage into domains;
- production ad-network credentials in tests;
- new domain boundary.
