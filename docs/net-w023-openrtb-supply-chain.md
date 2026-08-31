# NET-W023 — OpenRTB and supply-chain adapters

**Status:** IMPLEMENTED + PR #47 REMEDIATED (architect review CHANGES REQUESTED — same branch/PR, same discipline as prior NET remediations)
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
| AC-01 provider-neutral OpenRTB contract | contract/version pinning + vendor-field containment (exact neutral key set; device/user/regs/ext redacted by name) + registry identity rules + default runtime echo-only + secret auto-wire + provider override + trust-channel wiring (secret/override/absent) + integrity-algorithm pin | SATISFIED — `tests/adapters/net-w023-ac-01-neutral-contract.test.ts` (7 tests) |
| AC-02 fail-closed OpenRTB validation | every closed rejection reason exercised (malformed/unsupported version/missing id/missing+invalid supply identity/cardinality/payload size/unsafe critical values/ambiguous chain) + error contexts clean + inventory unchanged on rejection + unknown provider + spoofed identity | SATISFIED — `tests/adapters/net-w023-ac-02-fail-closed-validation.test.ts` (12 tests) |
| AC-03 supply-chain normalization | ads.txt/app-ads.txt/sellers.json fixtures; unified representation with provenance + version; DIRECT/RESELLER + PUBLISHER/INTERMEDIARY/BOTH mappings; line-order independence (record-set semantics); digest recomputation; duplicate dedupe; embedded schain normalization | SATISFIED — `tests/adapters/net-w023-ac-03-supply-chain-normalization.test.ts` (7 tests) |
| AC-04 exact-one inventory resolution | golden path admitted (verified chain, signed evidence); zero matches → supply_not_found (nothing registered); multiple → ambiguous_supply; cross-tenant invisible (not-found, no existence oracle); retired → supply_retired; format mismatch; app bundle identity; no placement/verification fabrication | SATISFIED — `tests/adapters/net-w023-ac-04-exact-one-inventory.test.ts` (8 tests) |
| AC-05 no authority bypass | full status matrix (absent/incomplete/unauthenticated/mismatched/stale/ambiguous → NOT admitted; verified → admitted); admitted evaluation writes NOTHING (audit delta 0, inventory/placements/verification unchanged); settlement readiness re-derived unchanged; no evidence records; no ledger postings; deterministic precedence + the PR #47 remediation regressions (see below) | SATISFIED — `tests/adapters/net-w023-ac-05-no-authority-bypass.test.ts` (13 tests) |
| AC-06 determinism/privacy | identical-input determinism; field-order independence (canonical digest); evaluation determinism under the explicit anchor; raw payload markers absent from evaluation/logs/audit; redaction names-only bounded at 24; notice path: no raw content or secret in views/observations/logs/audit/errors; tampered notice fails closed; file content never crosses; the trust envelope CONSUMED at the boundary (signature + trust secret never in evaluation/logs/audit; unsigned facts byte-identical) | SATISFIED — `tests/adapters/net-w023-ac-06-determinism-privacy.test.ts` (9 tests) |
| AC-07 tenancy/idempotency/atomicity | the material path through the W022 composite: one atomic audit event with provider metadata + idempotency/transaction lineage; exactly-once + replay; per-org key namespace; 4-way concurrency (exactly one created); HTTP guard 403/200/400 + classified rejection + the remediation transport semantics (unverified envelope = 200 decision; malformed envelope = 400) | SATISFIED — `tests/adapters/net-w023-ac-07-tenancy-idempotency.test.ts` (6 tests) |
| AC-08 architecture regression | frozen specs pinned (no 17th domain); architecture + authority scans 281 files / 0 violations; new vocabularies pinned (incl. `unauthenticated` + `supply_chain_unauthenticated` + the integrity algorithm) + frozen vocabularies unchanged; no mutation vocabulary or domain imports in the adapter tier; provider-vocabulary containment across ALL domain dirs + api transport; domain files untouched; composition-root wiring pins (incl. the trust-channel secret); file list; secret scan | SATISFIED — `tests/regression/net-w023-ac-08-architecture-out-of-scope.test.ts` (10 tests) |

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

## PR #47 remediation record (architect review: CHANGES REQUESTED)

The architect review of PR #47 returned **CHANGES REQUESTED** with two
blocking findings (GitHub rejected the formal REQUEST_CHANGES submission
only because reviewer and author share the account; the decision is
recorded in the review thread and here):

1. **Blocking — authenticity:** supply-chain “verification” was only
   consistency checking of CALLER-SUPPLIED authorization files; nothing
   established that the files were authoritative/authenticated, so
   fabricated ads.txt/app-ads.txt/sellers.json content could produce
   `verified`.
2. **Blocking — freshness:** `observedAt` was optional, yet missing
   freshness data could still lead to `verified`.
3. Regressions AND mutation checks were required for both cases.

### Remediation design (the W022 decision-of-record pattern)

`verified` now means **AUTHENTICATED + FRESH + CONSISTENT**:

- **Authenticated (finding 1):** every seller-authorization submission
  may carry a trust envelope (`integrity: { algorithm: "hmac-sha256",
  signature, signedAt }` — `SellerAuthorizationIntegrityBlock`, neutral
  port contract). The signature is HMAC-SHA256 over the canonical
  serialization of the EXACT attested submission facts (sourceKind,
  sourceIdentity, raw file content, observedAt — absence attested as
  null), computed/verified by the new adapter-tier module
  `src/adapters/openrtb/authorization-integrity.ts` (the W022
  report-integrity precedent: same primitive, same secret-driven
  wiring rule, timing-safe comparison). The trust key
  (`SELLER_AUTHORIZATION_TRUST_KEY`, classified secret) resolves ONLY
  through the SecretProvider at composition time (or the explicit
  `opts.adapters.sellerAuthorizationTrustKey` override) and injects
  into the ingress boundary. Unauthenticated submissions still
  normalize — their facts remain facts (§3.4) — but can never govern a
  required authorization source: the new closed status
  `unauthenticated` (admission reason `supply_chain_unauthenticated`)
  caps the chain, with deterministic precedence incomplete >
  unauthenticated > ambiguous > stale > mismatched. Grammar-valid
  FABRICATED content therefore produces `unauthenticated`, never
  `verified`. No secret configured → nothing can authenticate → no
  chain can ever be `verified` (fail-closed default, the W022
  no-secret rule).
- **Fresh (finding 2):** the governing (authenticated) facts must
  carry a non-null `observedAt` within the 48h staleness bound.
  MISSING freshness data is treated as NOT fresh → `stale` → never
  `verified`. (The envelope can honestly attest content WITHOUT
  freshness — it signs observedAt-as-null — and the freshness gate
  still rejects it, so the two gates are independently observable and
  independently mutable.)
- **Consistent:** the existing chain-vs-authorization checks operate
  on the governing authenticated facts only; conflicting AUTHENTICATED
  observations (distinct digests) remain `ambiguous`; an unauthorized
  seller remains `mismatched`.
- **Privacy preserved:** the envelope is consumed at the ingress
  boundary and never retained — the signature, the trust secret and
  the raw file content never appear in normalized facts, evaluation
  views, logs, audit events or error contexts (PRIV-002; pinned by
  AC-06). The API transport validates envelope STRUCTURE only (400 on
  malformed shape); an envelope that fails CRYPTOGRAPHIC verification
  is a derived decision (200 + `supply_chain_unauthenticated`), never
  a transport error.

### Remediation regressions (AC-05, 6 new tests; + AC-01/06/07/08 pins)

1. fabricated (grammar-valid, NO envelope) → `unauthenticated`, NOT
   admitted, facts still recorded;
2. tampered signature → `unauthenticated`;
3. wrong-key signature → `unauthenticated`;
4. signed-but-missing `observedAt` → `stale`, NOT admitted (finding 2);
5. authenticated publisher file + unauthenticated hop file →
   `unauthenticated` (never verified, never incomplete);
6. default runtime WITHOUT the trust secret → even correctly signed
   facts → `unauthenticated` (fail closed; still zero mutations).

AC-01 pins the trust-channel wiring (secret present / absent /
explicit override + the closed algorithm vocabulary); AC-06 pins the
envelope-consumed privacy guarantees (signatures + trust secret
absent from evaluation/logs/audit; unsigned facts byte-identical to
signed facts); AC-07 pins the HTTP transport semantics (unverified
envelope = 200 decision; malformed envelope = 400); AC-08 pins the
new vocabulary members + the wiring + the new file + the secret name.

### Remediation mutation checks (3/3 caught + restored green)

- **M1 — authentication gate removed** (every submission trusted):
  AC-05 failed (5 failures, incl. the fabricated-content regression).
  CAUGHT.
- **M2 — mandatory-freshness gate removed** (null `observedAt` can
  verify): AC-05 failed (the missing-freshness regression). CAUGHT.
- **M3 — signature comparison disabled** (any well-formed envelope
  verifies): AC-05 failed (the tampered-signature + wrong-key
  regressions). CAUGHT.

Each mutation was applied with cp-backup + assert-applied, verified
 to fail the targeted regressions, then restored and re-verified
green (the restored suite: 13 pass / 0 fail).

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

- `bun run verify` (post-remediation): **1509 pass / 15 skip / 0 fail,
  16083 expect(), 1524 tests / 190 files** (pre-remediation baseline:
  1501 pass / 16022 expect() / 1516 tests — +8 tests / +61 expect();
  post-W022 baseline: 1437 pass / 1452 tests / 182 files)
- `arch:check`: **281 files scanned, 0 violations**
- `authority:check`: **281 files scanned, 0 violations**
- real PostgreSQL/Redis integration: the configured integration
  suites remain in their harness-scoped skip state identical to the
  W022 baseline (CI runs them against real services; the material
  path reuses the W022 transactional composite already covered there)
- mutation checks: **8/8 original + 3/3 remediation directions caught
  and restored green** (see above)
- secret scan: clean (test-only literals confined to test files;
  `.env.example` documents the secret NAMES only)
- implementation PR: #47 — the single canonical PR closing #46
  (remediation delivered on the SAME branch/PR per the remediation
  discipline; PR #47 remains UNMERGED pending re-review)
- architect review: CHANGES REQUESTED (round 1) → remediated →
  re-review PENDING (do not merge on green CI alone)
- merge SHA: PENDING

## Completion rule

W023 is complete only when the issue acceptance criteria,
implementation evidence, mutation evidence, architecture checks, full
verification, CI and architect approval all agree. `spec/PROJECT-STATE.md`
is updated immediately after merge with the final SHA and next work
item.
