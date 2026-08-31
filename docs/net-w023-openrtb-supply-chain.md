# NET-W023 — OpenRTB and supply-chain adapters

**Status:** IMPLEMENTED (implementation branch `feat/net-w023-openrtb-supply-chain-adapters`)
**GitHub issue:** #46
**Work order:** `spec/work-orders/NET-W023.md`
**Architecture:** v1.0 FROZEN
**Dependencies:** NET-W019 + NET-W022 merged

## Purpose

This document is the durable evidence ledger for NET-W023. It is
completed from the actual implementation branch and PR so a new LLM
architect can review the work without conversation history.

## Architectural decision record

External OpenRTB and supply-chain protocols are adapter concerns only.
Provider-specific syntax, SDK types, credentials and wire objects
remain inside `/adapters`. Normalized facts cross the bootstrap
composition root only and are consumed through existing authoritative
contracts.

`/inventory` owns supply ownership/placement semantics; `/campaigns`
owns campaign policy; `/measurement` + `/outcomes` own measurement
semantics; `/evidence` owns provenance/truth; `/disputes` owns
risk/control; `/settlement` owns economic mutation; `/workflows` owns
lifecycle. W023 introduces NO second authority in any of these areas.

## Implementation shape (the decision of record, as shipped)

1. **Neutral tier — `src/adapters/port.ts` (ADDITIVE only):** the
   versioned neutral contracts (`OPENRTB_ADAPTER_CONTRACT_VERSION`
   "NET-W023:1") — `NormalizedOpenRtbRequest` (request id, closed
   supported-version set 2.5/2.6, supply identity, bounded impression
   slots with the inventory-format vocabulary, the floor price as an
   ECONOMIC FACT, the normalized supply chain, the deterministic
   digest), `SellerAuthorizationFacts` (the unified ads.txt /
   app-ads.txt / sellers.json representation with the closed
   relationship vocabulary, canonical record sorting + digest), the
   closed vocabularies `OPENRTB_REQUEST_REJECTION_REASONS` (9
   normalization reasons, thrown) and
   `EXTERNAL_ADMISSION_REJECTION_REASONS` (9 evaluation reasons,
   returned as decision facts), the `OpenRtbProviderAdapter` /
   `OpenRtbProviderRegistry` / `OpenRtbIngressService` contracts, the
   neutral read-only `ExternalInventorySupplyLookup`
   (dependency-inverted), and the closed error types
   (`UnknownOpenRtbProviderError`, `OpenRtbRequestRejectedError` —
   contexts carry reason/provider/field only).
2. **Adapter tier:** `src/adapters/registry.ts` (one adapter per
   provider identity, kind "openrtb", duplicates fail closed — the
   W022 registry pattern), `src/adapters/openrtb/vendor-request.ts`
   (the reference vendor bid-request shape: app-XOR-site supply
   identity, exactly one media type per impression, bounded
   cardinalities 16/12/64 KiB, mixed-currency and
   contradictory-value detection, duplicate-(asi,sid) chain
   ambiguity, privacy redaction by top-level field NAME only, bounded
   at 24), `src/adapters/openrtb/supply-chain-files.ts` (the
   ads.txt/app-ads.txt line grammar with comment/variable/cert-field
   handling + the sellers.json grammar with the
   domain-required-for-PUBLISHER rule; contradictory duplicate
   relationships fail closed; record-set semantics with canonical
   sorting), `src/adapters/openrtb/reference-adapter.ts` (the
   reference provider, identity re-asserted per call),
   `src/adapters/openrtb/canonical-json.ts` (the deterministic
   sorted-key serialization + SHA-256 digest — the W021/W022
   canonical-JSON pattern), and `src/adapters/ingress.ts` (routing +
   neutral-contract enforcement incl. provider-identity spoofing +
   the admission evaluation: exact-one resolution, retired/format
   checks, supply-chain verification with the deterministic
   precedence incomplete > ambiguous > stale > mismatched, explicit
   evaluation anchor; NO mutation, NO domain imports).
3. **The ONE material path (work order §3.5, "route measurement facts
   through /measurement → /outcomes"):**
   `src/measurement/providers/openrtb-delivery-adapter.ts` implements
   the W022 OPTIONAL `MeasurementProviderAdapter.normalizeReport`
   contract for delivery notices (outcomeType pinned to "view";
   deterministic attribution with the bid-request reference as the
   mechanical link; the W022 HMAC-SHA256 reference integrity envelope
   and shared normalization helpers reused from the same provider
   tier). It is registered in the measurement registry by the
   bootstrap root, secret-driven
   (`MEASUREMENT_OPENRTB_DELIVERY_KEY`), so the default runtime stays
   echo-only and the material ingestion flows through the EXISTING
   `submitMeasurementReport` composite (tenant scope + guard +
   `measurement_report:{org}:{key}` idempotency + atomic audit) with
   ZERO /outcomes changes.
4. **Composition root (`src/bootstrap/runtime.ts`):** the OpenRTB
   provider registry (reference adapter default, explicit
   `opts.adapters.openRtbProviders` override), the neutral inventory
   lookup implemented at the root over
   `inventoryService.listInventoryItems` (org-scoped read;
   cross-tenant = zero matches = not-found semantics), the ingress
   service, the `evaluateExternalAdRequest` api command (no
   mutation), and the api route `POST /api/external-ad-requests`
   (guard action `adRequest.evaluate`; missing request → 400; a
   non-admitted evaluation is a 200 decision — the
   settlement-readiness derivation precedent; the API transport stays
   provider-neutral, no vendor vocabulary).
5. **ZERO domain-file changes:** `/inventory`, `/outcomes`,
   `/campaigns`, `/evidence`, `/disputes`, `/settlement` are
   untouched (the exact-one lookup is a composition-root read over
   the existing org-scoped service API; external facts cannot attach
   supply verification, create placements, alter the derived
   settlement readiness, post ledger value, or clear risk).

## Evidence matrix

| AC | Required evidence | Status |
|---|---|---|
| AC-01 provider-neutral OpenRTB contract | contract/version pinning + vendor-field containment (exact neutral key set; device/user/regs/ext redacted by name) + registry identity rules + default runtime echo-only + secret auto-wire + provider override | SATISFIED — `tests/adapters/net-w023-ac-01-neutral-contract.test.ts` (6 tests) |
| AC-02 fail-closed OpenRTB validation | every closed rejection reason exercised (malformed/unsupported version/missing id/missing+invalid supply identity/cardinality/payload size/unsafe critical values/ambiguous chain) + error contexts clean + inventory unchanged on rejection + unknown provider + spoofed identity | SATISFIED — `tests/adapters/net-w023-ac-02-fail-closed-validation.test.ts` (12 tests) |
| AC-03 supply-chain normalization | ads.txt/app-ads.txt/sellers.json fixtures; unified representation with provenance + version; DIRECT/RESELLER + PUBLISHER/INTERMEDIARY/BOTH mappings; line-order independence (record-set semantics); digest recomputation; duplicate dedupe; embedded schain normalization | SATISFIED — `tests/adapters/net-w023-ac-03-supply-chain-normalization.test.ts` (7 tests) |
| AC-04 exact-one inventory resolution | golden path admitted (verified chain); zero matches → supply_not_found (nothing registered); multiple → ambiguous_supply; cross-tenant invisible (not-found, no existence oracle); retired → supply_retired; format mismatch; app bundle identity; no placement/verification fabrication | SATISFIED — `tests/adapters/net-w023-ac-04-exact-one-inventory.test.ts` (8 tests) |
| AC-05 no authority bypass | full status matrix (absent/incomplete/mismatched/stale/ambiguous → NOT admitted; verified → admitted); admitted evaluation writes NOTHING (audit delta 0, inventory/placements/verification unchanged); settlement readiness re-derived unchanged; no evidence records; no ledger postings; deterministic precedence | SATISFIED — `tests/adapters/net-w023-ac-05-no-authority-bypass.test.ts` (7 tests) |
| AC-06 determinism/privacy | identical-input determinism; field-order independence (canonical digest); evaluation determinism under the explicit anchor; raw payload markers absent from evaluation/logs/audit; redaction names-only bounded at 24; notice path: no raw content or secret in views/observations/logs/audit/errors; tampered notice fails closed; file content never crosses | SATISFIED — `tests/adapters/net-w023-ac-06-determinism-privacy.test.ts` (8 tests) |
| AC-07 tenancy/idempotency/atomicity | the material path through the W022 composite: one atomic audit event with provider metadata + idempotency/transaction lineage; exactly-once + replay; per-org key namespace; 4-way concurrency (exactly one created); HTTP guard 403/200/400 + classified rejection; the evaluation command mutates nothing (audit delta 0) | SATISFIED — `tests/adapters/net-w023-ac-07-tenancy-idempotency.test.ts` (6 tests) |
| AC-08 architecture regression | frozen specs pinned (no 17th domain); architecture + authority scans 281 files / 0 violations; new vocabularies pinned + frozen vocabularies unchanged; no mutation vocabulary or domain imports in the adapter tier; provider-vocabulary containment across ALL domain dirs + api transport; domain files untouched; composition-root wiring pins; file list; secret scan | SATISFIED — `tests/regression/net-w023-ac-08-architecture-out-of-scope.test.ts` (10 tests) |

## Mutation evidence

Each deliberate mutation was applied (cp-backup + assert-applied),
verified to FAIL the targeted acceptance suite, then restored and
re-verified green:

1. **fail-open version validation** — the supported-version gate
   disabled → AC-02 failed. CAUGHT.
2. **cardinality validation removed** — the impression-count bound
   disabled → AC-02 failed. CAUGHT.
3. **provider-field leakage** — the raw `device` block added to the
   neutral request → AC-01 + AC-06 failed. CAUGHT.
4. **ambiguous ownership acceptance** — the multiple-match rejection
   disabled (first match wins) → AC-04 failed. CAUGHT.
5. **supply-chain promotion (verification bypass)** — verification
   unconditionally returns "verified" (unverified/stale/absent chains
   would admit) → AC-05 failed. CAUGHT.
6. **raw bid payload retention** — the raw payload added to the
   evaluation record → AC-06 failed. CAUGHT.
   **secret emission** — the verification secret appended to the
   notice redaction summary → AC-06 failed. CAUGHT.
7. **idempotency bypass** — the measurement composite's idempotency
   key randomized (each submission a new key) → AC-07 failed. CAUGHT.

## Privacy evidence

Raw request payloads are not persisted by default: the evaluation
record carries only the neutral facts + digests, and the raw payload
markers are asserted absent from the evaluation, the log sink and the
audit trail. Sensitive identifiers (device/user/regs), raw
seller-authorization file content, and the verification secret never
appear in normalized records, logs, audit metadata or error contexts.
Redaction summaries contain field names only, bounded at 24.

## Final verification record

From the implementation branch (all numbers from `bun run verify`):

- `bun run verify`: **1501 pass / 15 skip / 0 fail, 16022 expect(),
  1516 tests / 190 files** (post-W022 baseline: 1437 pass / 1452
  tests / 182 files — +64 tests / +8 files)
- `arch:check`: **281 files scanned, 0 violations**
- `authority:check`: **281 files scanned, 0 violations**
- real PostgreSQL/Redis integration: the configured integration
  suites remain in their harness-scoped skip state identical to the
  W022 baseline (CI runs them against real services; the material
  path reuses the W022 transactional composite already covered there)
- mutation checks: **8/8 caught and restored green** (see above)
- secret scan: clean (test-only literals confined to test files;
  `.env.example` documents the secret NAME only)
- implementation PR: the single canonical PR closing #46
- architect review: PENDING (do not merge on green CI alone)
- merge SHA: PENDING

## Completion rule

W023 is complete only when the issue acceptance criteria,
implementation evidence, mutation evidence, architecture checks, full
verification, CI and architect approval all agree. `spec/PROJECT-STATE.md`
is updated immediately after merge with the final SHA and next work
item.
