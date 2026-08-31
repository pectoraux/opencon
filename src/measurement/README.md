# `measurement` boundary

**Tier:** adapter (the root `port.ts` / `index.ts` / `module.ts` are the
neutral integration surface)
**Authority:** measurement provider integrations; **measurement
semantics remain in `/outcomes`** (architecture §18; architecture-lock
§14 invariant 25)
**Architecture ref:** `spec/architecture.md` §13, §18;
`spec/architecture-lock.md` §14
**Work order:** `spec/work-orders/NET-W006.md` §3.7

## Scope after NET-W006

`port.ts` declares the provider-neutral `MeasurementProviderAdapter`
contract. Every external measurement platform integration implements
it; the `/outcomes` domain consumes ONLY this neutral port (domain →
neutral is allowed by the tier matrix; provider SDKs/types never cross
into the domain — architecture-lock §14 invariant 24).

Provider observations are NORMALIZED facts
(`ProviderObservationReport`): outcome type from the OUT-001
vocabulary, measured value + unit, confidence with uncertainty, and
method + methodVersion provenance. Raw provider payloads stay on the
provider side of the adapter boundary.

The reference adapter (`providers/echo-measurement-provider.ts`)
reports no observations; it exists so the composition root has a real
adapter to wire and health-check, and as a compile-checked reference
for later providers. Concrete platform adapters — browser/platform
attribution and iOS attribution (requirements ADAPTER-003..004) —
arrive in NET-W022 under `providers/`.

## Scope after NET-W022 (attribution + privacy measurement adapters)

`port.ts` (neutral tier) gains the push-ingestion contract
additively: `RawProviderReportSubmission` (vendor payload — OPAQUE
outside the owning adapter), `AdapterReportNormalization` /
`MeasurementReportNormalizationResult` (the neutral report + the
NAMES of privacy-redacted vendor fields, never values), the OPTIONAL
`MeasurementProviderAdapter.normalizeReport` (absent ⇒ pushed reports
fail closed with `unsupported_push_ingestion`), the closed
`MEASUREMENT_REPORT_REJECTION_REASONS` vocabulary
(malformed_report | unsupported_attribution_mode |
invalid_attribution_mode | missing_provenance |
ambiguous_subject_mapping | unverifiable_integrity |
unsupported_push_ingestion), the `MeasurementProviderRegistry` /
`MeasurementIngestionService` interfaces, and the
`UnknownMeasurementProviderError` / `MeasurementReportRejectedError`
errors.

Adapter tier (`registry.ts`, `ingestion.ts`, `providers/*`):
- `registry.ts` — the registration boundary (one adapter per provider
  identity; duplicates fail closed).
- `ingestion.ts` — the routing + normalization boundary (unknown
  providers, push-less adapters, and adapter output violating the
  neutral contract or claiming another provider's identity all fail
  closed). NO mutation: persistence, idempotency and audit live in
  `/outcomes`, composed by the bootstrap root (the adapter tier may
  not import domain modules — tier matrix).
- `providers/browser-attribution-adapter.ts` (ADAPTER-003) and
  `providers/ios-attribution-adapter.ts` (ADAPTER-004) — the
  provider-neutral reference adapters. Vendor-shaped raw reports
  (report/postback ids, source events / ad references, subject
  mappings, provider-reported attribution modes) are validated,
  integrity-verified (HMAC-SHA256 over the canonical sorted-key JSON
  of the report minus the integrity block, against the provider
  verification secret resolved through the SecretProvider), and
  REDACTED to the neutral contract fields. Normalization is PURE
  (same payload + key ⇒ identical neutral report). Provider-reported
  attribution is a provenance fact: deterministic/probabilistic only —
  experimental attribution is protocol-owned via `/outcomes`
  experiments and can never be claimed by a provider.
- `providers/report-integrity.ts` / `providers/report-normalization.ts`
  — the shared reference integrity envelope + fail-closed validation
  rules (subject ambiguity, mode consistency, provenance).

Composition (bootstrap): explicit `opts.measurement.providers`
override; otherwise ECHO + the reference adapters auto-wired iff
their secrets (`MEASUREMENT_BROWSER_ATTRIBUTION_KEY`,
`MEASUREMENT_IOS_ATTRIBUTION_KEY`) are configured. API surface:
`POST /api/measurement-reports` (guard `measurementReport.submit`) →
normalize (this boundary) → `/outcomes` `ingestProviderReport`
(exactly-once-per-key, atomically audited).

## Dependencies

Core contracts (`src/core/measurement.ts`, `src/core/evidence.ts`) —
vocabulary only. No domain imports (the semantics live in `/outcomes`;
this boundary only carries the integration surface).
