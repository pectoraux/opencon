# NET-W022 — Attribution and privacy measurement adapters (evidence)

**Work order:** `spec/work-orders/NET-W022.md` (issue #44,
READY_FOR_IMPLEMENTATION)
**Architecture:** v1.0 FROZEN (`spec/architecture.md`, §18 `/measurement` —
"measurement provider integrations; semantics remain in `/outcomes`";
architecture-lock §14.24/§14.25)
**Baseline:** NET-W021 merged at `cf9d92a` (PR #43)

## What shipped

Provider attribution reports can now enter the canonical measurement
layer as normalized evidence, without vendor semantics, privacy leaks,
or any second measurement authority:

1. **The neutral push-ingestion contract** (`src/measurement/port.ts`,
   additive): `RawProviderReportSubmission` (opaque vendor payload),
   `MeasurementProviderAdapter.normalizeReport?` (optional — push-less
   adapters fail closed with `unsupported_push_ingestion`), the closed
   `MEASUREMENT_REPORT_REJECTION_REASONS` vocabulary, the
   `MeasurementProviderRegistry` / `MeasurementIngestionService`
   interfaces, and the `UNKNOWN_MEASUREMENT_PROVIDER` /
   `MEASUREMENT_REPORT_REJECTED` errors.
2. **The registration + routing boundary** (adapter tier):
   `src/measurement/registry.ts` (one adapter per provider identity;
   duplicates/invalid identity fail closed) and
   `src/measurement/ingestion.ts` (routing; neutral-contract
   enforcement incl. provider-identity integrity; NO mutation).
3. **The reference attribution adapters**:
   `browser-attribution-adapter.ts` (ADAPTER-003) and
   `ios-attribution-adapter.ts` (ADAPTER-004) over the shared
   `report-normalization.ts` fail-closed rules and the
   `report-integrity.ts` HMAC-SHA256 reference envelope.
4. **The `/outcomes` additive interface**: `ingestProviderReport` —
   the SAME W006 validation rules, exactly-once-per-key, atomic audit
   (observation + audit + idempotency record in ONE authoritative
   transaction). The lifecycle/transition matrix is UNCHANGED.
5. **The composition root + secrets**: registry wiring, secret-driven
   auto-wiring (`MEASUREMENT_BROWSER_ATTRIBUTION_KEY` /
   `MEASUREMENT_IOS_ATTRIBUTION_KEY` via the SecretProvider only),
   `Runtime.measurementIngestion`, and the
   `apiCommands.submitMeasurementReport` composite (the ONLY join
   between measurement and `/outcomes`).
6. **The API surface**: `POST /api/measurement-reports` (guard
   `measurementReport.submit`) with an opaque raw-payload passthrough
   and a submission view carrying provider id/version, the
   names-only redaction summary, `created`, and the observation.

## Design decisions (the decision of record)

1. **Push normalization lives in the adapter tier; persistence lives
   in `/outcomes`; the bootstrap root is the only join.** The tier
   matrix forbids adapter → domain imports, so the composition root
   composes normalize-then-persist. The measurement tier stays
   mutation-free — no second measurement authority is possible by
   construction.
2. **The neutral contract extension is OPTIONAL on the adapter.**
   `normalizeReport?` keeps echo and every W006 pull stub compiling
   and behaving unchanged; pushed reports to push-less adapters fail
   closed (`unsupported_push_ingestion`).
3. **Provider-reported attribution is a provenance fact.** Adapters
   accept deterministic (mechanical link REQUIRED) and probabilistic
   (link FORBIDDEN + quantified interval REQUIRED) claims only.
   Experimental attribution is protocol-owned via `/outcomes`
   experiments — a provider can never claim it.
4. **Integrity is REQUIRED and reference-defined.** The HMAC-SHA256
   envelope signs the canonical sorted-key JSON of the report minus
   its integrity block. Missing/unsupported/unverifiable integrity →
   fail closed; the secret is resolved only through the SecretProvider
   and never crosses into reports, logs, audit or error contexts.
5. **Privacy minimization with transparency.** Only the neutral
   contract fields cross; `redactedFieldNames` records the NAMES of
   every input field absent from the normalized output (bounded at
   24) — never values.
6. **Idempotency is provider-retry-shaped.** The push command is
   exactly-once-per-key (`measurement_report:{org}:{key}`) with
   deterministic replays returning the cached observation — provider
   postback retries never double-count.
7. **The protocol subject binding stays caller-declared.** The
   adapter resolves the provider-side subject reference
   (`subjectRefs` → exactly one `externalSubjectRef`); the protocol
   subject remains the authorized submitter's declared
   `subjectReference` — the W006 pull-path semantics, with ambiguity
   failing closed.
8. **Default runtime unchanged.** Without explicit providers and
   without the new secrets, the wiring stays ECHO-only (the W006
   default); reference adapters appear only when their secrets exist.

## Invariant → enforcement map (issue #44 architectural constraints)

| Constraint | Enforcement |
|---|---|
| `/measurement` owns integration contracts/adapters only; vendor vocabulary never crosses into domains | Raw payload `unknown` outside the adapter; neutral report field pin (AC-02/AC-04); `/outcomes` imports only `measurement/port.ts` (AC-07 static pin) |
| `/outcomes` remains the semantic authority | The single additive method applies the W006 rules; transition table + lifecycle unchanged (AC-05/AC-07 pins) |
| Provider attribution = provenance fact, never protocol truth | `providerAttributionMode` on the observation only; experimental claims rejected (AC-03); the rollup gate still applies (AC-05) |
| Deterministic, fail-closed normalization; provenance preserved | Determinism tests (AC-02); the closed rejection vocabulary (AC-01 pin, AC-03 exhaustive) |
| Privacy minimization; secrets never persisted/emitted | Names-only redaction + secret-absence scans across views/observations/audit/logs/errors (AC-04) |
| Tenant/actor/auth/idempotency/audit/transaction rules | Guard 403 (AC-06); exactly-once-per-key + atomic audit + per-org key namespace (AC-05) |
| No campaign/inventory/settlement/reputation mutation | Measurement tier mutation-surface scan (AC-07); /outcomes additive-only |
| No OpenRTB/ads.txt (NET-W023) | Vocabulary scan across the W022 files (AC-07) |

## API surface

- `POST /api/measurement-reports` — body:
  `{ organizationScopeId, subjectReference: { subjectId, subjectType },
  idempotencyKey, providerId, report: <raw vendor JSON> }`; guard
  action `measurementReport.submit`; 201 →
  `{ providerId, providerVersion, redactedFieldNames, created,
  observation }`; 400 on missing report field / fail-closed
  rejections; 403 unauthenticated.

## Verification

- `bun run verify`: typecheck PASS; arch:check 273 files / 0
  violations; authority:check 273 files / 0 violations; the full suite
  green with the 27 new NET-W022 tests (7 AC suites + the harness).
- Mutation checks (cp-backup + assert-applied; each fails loudly then
  restored): (1) disabling the HMAC signature comparison →
  integrity-rejection tests fail; (2) letting a vendor field cross
  the neutral report → AC-04 field-pin + leak tests fail; (3)
  accepting experimental attribution claims → AC-03 mode tests fail;
  (4) removing the /outcomes idempotent wrap → AC-05 replay test
  fails; (5) dropping the neutral-contract identity check → AC-02
  spoofing test fails.
- CI: unit + real PostgreSQL/Redis integration on both events
  (pull_request + push).
