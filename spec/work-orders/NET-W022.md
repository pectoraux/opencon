# NET-W022 — Attribution and privacy measurement adapters

**Status:** in progress (implementation work order)
**Architecture:** v1.0 (FROZEN — `spec/architecture.md`, `spec/architecture-lock.md` untouched)
**Requirements:** OUT-002..003, PRIV-002..003, ADAPTER-003..004 (spec/requirements.md)
**Dependencies:** NET-W005 (evidence), NET-W006 (outcomes/measurement) — both merged
**Tracking:** issue #44 (READY_FOR_IMPLEMENTATION)

## §1 Objective

Implement the provider/platform measurement-adapter layer deferred by
NET-W006 and explicitly kept out of NET-W021. Concrete
attribution/privacy integrations belong in the neutral `/measurement`
boundary and adapter tier, while `/outcomes` remains the semantic
authority for observations, attribution representations, maturation
and finalized measurements (issue #44; architecture §18;
architecture-lock §14 invariants 24/25).

The push-ingestion pipeline (the decision of record):

```text
raw vendor report                 (browser/platform ADAPTER-003 or
        ↓                          iOS ADAPTER-004 postback; opaque
/measurement adapter              outside its owning adapter)
        ↓  validate vendor shape — fail closed (§3.2)
        ↓  resolve subject mapping — fail closed on ambiguity
        ↓  enforce attribution-mode consistency — fail closed
        ↓  verify report integrity (HMAC-SHA256) — fail closed
        ↓  REDACT to the neutral contract (privacy minimization)
neutral ProviderObservationReport
        ↓                          (deterministic + provenance)
bootstrap composition root        (§3.4 — the ONLY join; the adapter
        ↓                          tier may not import /outcomes)
/outcomes ingestProviderReport    (§3.5 — the SAME W006 validation
        ↓                          rules; exactly-once-per-key;
provider-sourced observation      atomic audit; no lifecycle change)
```

Definition of done: **provider reports enter the canonical
measurement layer through `/measurement` adapters, are normalized
deterministically and fail closed, retain provenance without leaking
secrets, and cannot bypass `/outcomes` semantics or create economic,
trust or lifecycle authority outside the frozen architecture.**

## §2 Authority separation (the decision of record)

NET-W022 lives INSIDE the existing `/measurement` boundary (NO 17th
domain; architecture.md §18 already names `/measurement` — "measurement
provider integrations; semantics remain in `/outcomes`") and its
adapter tier (`src/measurement/providers/`). The tier matrix drives the
composition:

- **`/measurement` owns provider integration contracts/adapters ONLY.**
  Provider SDK/API vocabulary never crosses into domain authorities
  (architecture-lock §14.24). The raw vendor payload is OPAQUE at every
  tier except the adapter that owns its provider id.
- **`/outcomes` remains the sole semantic authority for measurement.**
  The single `/outcomes` change is the ADDITIVE push-ingestion
  interface `ingestProviderReport` (issue #44 scope 6: "unless an
  additive neutral interface is strictly necessary; no new lifecycle
  authority") — it applies the SAME W006 validation rules and persists
  through the SAME authoritative transaction + audit machinery. The
  measured-outcome lifecycle and transition table are UNCHANGED.
- **Attribution supplied by providers is provenance/fact input.** A
  provider-reported attribution mode is recorded as a provenance fact on
  the observation (the W006 rule); it never becomes a protocol
  AttributionRecord, never validates experimental attribution (that is
  protocol-owned through `/outcomes` experiments — provider reports may
  claim deterministic/probabilistic only), and never manufactures a
  finalized measurement (the deterministic rollup gate still applies).
- **The adapter tier performs NO mutation.** Normalization is pure:
  validation, integrity verification, redaction. Persistence,
  idempotency, audit and tenant scoping live in `/outcomes`, composed
  by the bootstrap root — the ONE place measurement and `/outcomes`
  join (adapter → domain imports are forbidden by the tier matrix).
- **W021 and later campaign matching consume only canonical
  `/outcomes` reads.** This work item introduces NO direct campaign,
  inventory, settlement or reputation mutation of any kind.

## §3 Scope

### §3.1 The neutral contract + registration boundary (AC-01)

`src/measurement/port.ts` (neutral tier) gains, additively:

- `RawProviderReportSubmission` — `{ providerId, payload: unknown }`
  (the vendor payload, opaque outside the owning adapter);
- `AdapterReportNormalization` / `MeasurementReportNormalizationResult`
  — the normalized neutral report + `redactedFieldNames` (privacy
  transparency: NAMES of dropped fields, never values) + the adapter
  version;
- `MeasurementProviderAdapter.normalizeReport?` — OPTIONAL on purpose:
  adapters that serve only the W006 pull surface (e.g. echo, pull stubs)
  omit it and pushed reports fail closed with
  `unsupported_push_ingestion`;
- the CLOSED rejection-reason vocabulary
  `MEASUREMENT_REPORT_REJECTION_REASONS` = `malformed_report` |
  `unsupported_attribution_mode` | `invalid_attribution_mode` |
  `missing_provenance` | `ambiguous_subject_mapping` |
  `unverifiable_integrity` | `unsupported_push_ingestion` (stable
  code `MEASUREMENT_REPORT_REJECTED`, the W019 gate-reason pattern);
- `MeasurementProviderRegistry` (register / byProviderId / list /
  checkHealth) — one adapter per provider identity; registration
  validates identity and fails closed on duplicates;
- `MeasurementIngestionService` (normalizeSubmission / checkHealth) —
  the routing + normalization boundary;
- `UnknownMeasurementProviderError` (code
  `UNKNOWN_MEASUREMENT_PROVIDER`).

The registry implementation (`registry.ts`) and ingestion service
(`ingestion.ts`) are adapter tier. The ingestion service also ENFORCES
the neutral contract on adapter output (provider-identity integrity +
shape) — a mis-implemented adapter can never inject invalid facts or
claim another provider's identity.

### §3.2 The reference attribution adapters (AC-02/AC-03/AC-04)

Two provider-neutral reference adapters under
`src/measurement/providers/` — vendor-shaped raw reports, one neutral
contract:

- **`browser-attribution-adapter.ts` (ADAPTER-003)** — the
  browser/platform attribution report surface: `reportId`,
  `sourceEventId`, `destination`, `subjectRefs`, OUT-001 outcome type,
  observed value + confidence, provider-reported attribution mode,
  optional `deterministicLink`, method/version/collectedAt provenance,
  and a REQUIRED `integrity` block. Vendor fields (`triggerData`,
  `userAgent`, `ipHint`, `scheduledReportTime`, `vendorExtensions`)
  are REDACTED.
- **`ios-attribution-adapter.ts` (ADAPTER-004)** — the mobile-OS
  attribution postback surface: `postbackId`, `adCampaignRef`/
  `adGroupRef` (vendor ad references — REDACTED), `subjectRefs`,
  outcome/value/confidence/mode/provenance/integrity. Vendor fields
  (`deviceHints`, `vendorPayload`) are REDACTED.

Shared fail-closed rules (`report-normalization.ts`) and the reference
integrity envelope (`report-integrity.ts`):

- **Malformed reports** (non-object payloads, missing ids, bad field
  shapes, non-OUT-001 outcome types, invalid confidence) →
  `malformed_report`.
- **Subject mapping**: the raw report carries `subjectRefs`; exactly
  ONE non-empty string maps to the neutral `externalSubjectRef`. Zero,
  multiple, or non-string candidates → `ambiguous_subject_mapping`
  (issue #44 scope 5). The protocol subject binding remains the
  caller-declared `subjectReference` (the W006 pull-path semantics).
- **Attribution modes**: provider reports may claim
  `deterministic` (mechanical link REQUIRED) or `probabilistic`
  (mechanical link FORBIDDEN + quantified interval REQUIRED —
  mirroring the `/outcomes` mode rules on the RAW report).
  `experimental` and anything else → `unsupported_attribution_mode`
  (experimental attribution is protocol-owned via `/outcomes`
  experiments).
- **Provenance**: method + methodVersion + collectedAt are REQUIRED —
  `missing_provenance` otherwise (model/method identity is never
  collapsed).
- **Integrity**: the reference envelope is HMAC-SHA256 over the
  canonical sorted-key JSON of the report minus its integrity block.
  Missing block, unsupported algorithm, unconfigured secret, or
  signature mismatch → `unverifiable_integrity`. The verification
  secret is injected at composition time and NEVER appears in
  normalized reports, logs, audit payloads or error contexts.
- **Privacy minimization (PRIV-002/003)**: only the neutral contract
  fields cross the boundary. `redactedFieldNames` records the NAMES of
  every input field not present in the normalized output (bounded at
  24), never values. The adapter never retains or mutates the
  caller's raw payload object.
- **Determinism**: normalization is a pure function of the payload +
  verification secret — the same input always produces the identical
  neutral report.

### §3.3 The ingestion service + health (AC-01)

`createMeasurementIngestionService({ registry, logger })` routes ONE
submission at a time: provider id validation (empty →
`UNKNOWN_MEASUREMENT_PROVIDER`), registry lookup (unknown →
`UnknownMeasurementProviderError`), push-less adapter →
`unsupported_push_ingestion`, adapter normalization, neutral-contract
enforcement (identity + shape → `malformed_report`). Health
aggregation iterates the registry (a secret-less reference adapter
reports `ok: false` with the fail-closed detail).

### §3.4 The composition root + secrets (AC-01)

The bootstrap root (the ONLY join between measurement and `/outcomes`):

- explicit `opts.measurement.providers` override; otherwise ECHO + the
  reference adapters auto-wired IFF their secrets are configured:
  `MEASUREMENT_BROWSER_ATTRIBUTION_KEY`, `MEASUREMENT_IOS_ATTRIBUTION_KEY`
  (new OPTIONAL classified secrets in `src/config/schema.ts`, resolved
  ONLY through the SecretProvider; without a secret the provider's
  reports fail closed and its health check is degraded). The default
  runtime stays echo-only — the W006 default behavior is unchanged.
- every wired adapter is registered in the registry exactly once;
- `Runtime.measurementIngestion` exposes the boundary;
- `apiCommands.submitMeasurementReport` composes: normalize (fail
  closed) → `/outcomes` `ingestProviderReport` (persist, idempotent,
  audited). The observer is the server-resolved authenticated actor.

### §3.5 The `/outcomes` additive interface + API surface (AC-05/AC-06)

`ingestProviderReport(execution, { organizationScopeId, observerId,
subjectReference, report, providerAdapterVersion, idempotencyKey })`:

- validates org/observer/subject/idempotency-key/report presence
  (stable `MEASUREMENT_VALIDATION` validation errors);
- normalizes + validates the neutral report with the SAME W006
  `normalizeProviderReport` rules (outcome type, observed value,
  confidence, provider provenance — fail closed);
- `applyIdempotent("measurement_report:{org}:{key}")` wraps
  `repository.saveWithinTx` + the transactional audit buffer in ONE
  authoritative transaction (the observation + audit record +
  idempotency record commit atomically; replays return the cached
  observation with `created: false`);
- the audit event is the SAME `outcome_observation.created` type with
  provider metadata (`ingestedFromProvider`, `providerVersion`,
  `externalSubjectRef`, `pushedReportIngestion`,
  `idempotencyRecordId`, `transactionId`) — lineage identical in kind
  to the W006 pull path.

API: `POST /api/measurement-reports` (guard action
`measurementReport.submit`) — the raw vendor payload is an opaque JSON
passthrough at the API tier; the response view carries the persisted
observation, provider id/version, `redactedFieldNames`, and `created`.
Unauthenticated ⇒ 403; missing report field ⇒ 400; fail-closed
rejections surface as classified validation errors (4xx) with nothing
persisted.

## §4 Key invariants (issue #44)

1. `/measurement` owns provider integration contracts/adapters only;
   provider SDK/API vocabulary never crosses into domain authorities.
2. `/outcomes` remains the sole authority for measurement semantics
   and lifecycle — the additive push interface introduces NO new
   lifecycle authority; the transition table is untouched.
3. Attribution supplied by providers is provenance/fact input — never
   protocol truth, never a bypass of outcome semantics, never a
   finalized measurement.
4. Adapters normalize deterministically, fail closed on ambiguous or
   invalid reports, preserve provenance/version/source identity, and
   never manufacture finalized measurements.
5. Privacy minimization: adapters expose only the minimum fields
   required by the neutral contract; secrets/credentials remain
   outside domain records and are never persisted or emitted into
   logs/audit payloads.
6. Tenant, actor, authorization, idempotency, concurrency, audit and
   authoritative-transaction rules remain mandatory (the push path is
   exactly-once-per-key with atomic audit, tenant-scoped records).
7. W021 and later campaign matching consume only canonical
   `/outcomes` reads — no direct campaign/inventory/settlement/
   reputation mutations introduced by this work item.

## §5 Explicit non-goals (issue #44)

- No OpenRTB / ads.txt / app-ads.txt / sellers.json / SupplyChain
  integration (NET-W023).
- No campaign optimization changes (NET-W021 is merged).
- No external payment execution; no direct settlement/reputation
  mutation.
- No new domain boundary, no blockchain/consensus, no vendor lock-in
  (the reference adapters define vendor-NEUTRAL shapes).
- No real vendor SDK imports (the reference adapters are the contract
  surface; concrete production transports arrive later behind the same
  neutral port).

## §6 Acceptance-criteria → test map

| AC | Suite | Proves |
|----|-------|--------|
| AC-01 contract + registration | `tests/measurement/net-w022-ac-01-contract-registration.test.ts` | closed reason vocabulary; registry identity + duplicates fail closed; unknown-provider routing; push-less adapters fail closed; echo + default runtime unchanged; secret-driven auto-wire; composed wiring + health |
| AC-02 deterministic normalization + provenance | `tests/measurement/net-w022-ac-02-normalization-provenance.test.ts` | neutral-contract field pin; full method/version/collectedAt provenance; determinism (repeated + fresh adapter + key-order independence); provider-identity spoofing rejected; adapter-output contract enforcement; persisted provenance |
| AC-03 fail-closed validation | `tests/measurement/net-w022-ac-03-fail-closed-validation.test.ts` | every rejection reason exercised through the composed boundary; error contexts carry no payload values/secrets; nothing persisted on rejection |
| AC-04 privacy + redaction + secret isolation | `tests/measurement/net-w022-ac-04-privacy-redaction.test.ts` | exact neutral fields cross; names-only redaction summaries (browser + iOS + composed); secrets absent from views/observations/audit/logs/errors; no payload retention/mutation; bounded reflection |
| AC-05 /outcomes integration | `tests/measurement/net-w022-ac-05-outcomes-integration.test.ts` | atomic audit with idempotency lineage; exactly-once-per-key + deterministic replay; per-org key namespace; the rollup gate consumes provider facts; lifecycle/transition-table unchanged pins |
| AC-06 HTTP integration | `tests/measurement/net-w022-ac-06-http-integration.test.ts` | guard 403; authenticated 201 + view; missing-report 400; fail-closed rejection 4xx with nothing persisted |
| AC-07 architecture/out-of-scope | `tests/regression/net-w022-ac-07-architecture-out-of-scope.test.ts` | authority guard 0 violations; frozen specs; work-order binding; vocabulary pins; no mutation surface in the measurement tier; /outcomes additive-only; composition-root-only join; no OpenRTB leakage; file list; secret scan |

## §7 Verification

- `bun run verify` (typecheck + arch:check + authority:check + the
  full bun test suite) — green.
- Mutation checks (cp-backup + assert-applied, each fails loudly then
  restored) on: the integrity verification (signature comparison
  disabled), the redaction (vendor field crossing), the fail-closed
  experimental mode (accepted), the /outcomes idempotency (replay
  creating a second observation), and the neutral-contract identity
  check (spoofed provider accepted).
- Full PR verification: CI (unit + real PostgreSQL/Redis integration).
