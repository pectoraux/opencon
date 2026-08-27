# NET-W015 — Creator identity and preferences

**Status:** in progress (implementation work order)
**Architecture:** v1.0 (FROZEN — `spec/architecture.md`, `spec/architecture-lock.md` untouched)
**Requirements:** CRE-001, CRE-005 (spec/requirements.md)
**Dependencies:** NET-W002 (identity), NET-W007 (reputation) — both merged
**Tracking:** issue #29 (READY_FOR_IMPLEMENTATION)

## §1 Objective

Implement creator identity and preference semantics for the protocol
creator network. A creator must be able to represent connected
platforms, audience metadata, commercial preferences, rights,
restrictions, and availability WITHOUT transferring platform
ownership, WITHOUT creating a second reputation/identity authority,
and WITHOUT admitting credentials or raw audience data into creator
records:

```text
Canonical Person Identity      (/identity — the anchor; never duplicated)
        ↓  createCreatorProfile (the profile anchor record)
Creator Profile Record         (/creators — org-scoped, owner-only)
        ↓  defineProfileVersion (the lineage-mutex versioned sections)
Creator Profile Version        (immutable, append-only)
        ├── Connected Platforms      (provider-neutral REFERENCES)
        ├── Audience Metadata        (privacy-minimized AGGREGATES only)
        ├── Commercial Preferences   (rates — declared data, NOT commitments)
        ├── Rights / Restrictions    (declared willingness + exclusions)
        ├── Availability             (capacity/notice — explicit data)
        ├── Participation Rules      (explicit data; matching is NET-W016)
        └── Reputation References    (audience_influence + production roles,
                                      canonical /reputation snapshot ids)
        ↓  reads resolve through the canonical authority
Canonical Reputation           (/reputation — referenced, never duplicated,
                                 never mutated, never scored here)
```

## §2 Authority separation (the decision of record)

NET-W015 makes the `/creators` boundary concrete (the NET-W001
skeleton becomes a real domain — the NET-W011 campaigns precedent; NO
17th domain is added; the frozen architecture-lock domain list is
unchanged and regression-pinned). Every authority boundary stays
exactly where the architecture puts it:

- `/identity` — person identity authority: the creator profile
  ANCHORS to an existing canonical person id (validated through the
  neutral `CreatorPersonLookup` — a thin composition-root adapter
  over the identity repository). The creators domain never creates,
  mutates or resolves identities itself, and carries NO identity
  material beyond the person id reference.
- `/participants` — roles/authorization: creator mutations are
  OWNER-ONLY (the profile owner is the creating person; checked
  server-side on every mutation — API-002), enforced inside the
  creator service; the API guard actions are
  `creators.profile.create` / `creators.version.define` /
  `creators.status.*`.
- `/reputation` — trust-signal authority: audience/production
  reputation is REFERENCED through the neutral
  `CreatorReputationSnapshotLookup` (a thin composition-root adapter
  over the reputation snapshot repository). The profile version
  stores REFERENCES ONLY (role + dimension + snapshot id + digest);
  the service VERIFIES each reference resolves, matches the profile's
  organization scope AND subject person, and carries the canonical
  digest. The creators domain never computes, stores, mints or
  mutates a score, and never duplicates the scoring engine.
- `a/adapters` — external platform/provider integration: connected
  platforms are provider-neutral records (closed platform-kind and
  content-format vocabularies + a free-form handle). NO
  provider-specific SDK semantics, tokens, credentials or connection
  state enter the domain; provider adapters remain a composition-root
  concern (NET-W016+ integration point).
- `/settlement` + `/campaigns` + `/workflows` — economic/lifecycle
  authority: UNTOUCHED. Commercial preferences (rates) are DECLARED
  data only — they create no economic state, no commitments, no
  ledger entries (the campaign-budget declaration precedent); the
  creators domain carries NO economic-unit mutation methods at all.
- AI/model output — CANNOT establish creator eligibility or
  reputation: the creators domain consults no LLM/advisory path
  anywhere (structural regression); eligibility decisions are
  NET-W016 concerns that must read only deterministic creator data.

## §3 Scope

### §3.1 The creator profile anchor record (AC-01)

First-class durable `CreatorProfileRecord` scoped to an organization
scope and ANCHORED to a canonical person id:

- `createCreatorProfile` — validates the anchor person EXISTS
  (neutral lookup) and enforces ONE profile per (organizationScope,
  person) — the unique-anchor rule: a second person identity is never
  created and a person cannot hold two creator profiles in one org
  (the identity-duplication guard). Idempotent
  (`creator_profile:{org}:{key}`), transactionally audited
  (`creator_profile.created`), starts in `DRAFT` with an append-only
  event history.
- The administrative status machine (the campaign-record precedent —
  this is the profile's own record status, NOT a workflow
  lifecycle):
  `DRAFT → ACTIVE ⇄ PAUSED → ARCHIVED (terminal)` via
  activate/pause/resume/archive commands (owner-only, idempotent,
  audited, events append-only).

### §3.2 The versioned profile sections (AC-02)

`defineProfileVersion` — an immutable, append-only
`CreatorProfileVersion` per profile (lineage mutex
`creator_profile_lineage:{profileId}`, version = latest+1 — the
NET-W007/008/010/011 pattern; the current-version pointer flips in
the SAME transaction). Sections, all provider-neutral:

1. **platforms** — connected-platform references: closed
   `CREATOR_PLATFORM_KINDS` × free-form handle + display name +
   profile URL + content-format capabilities + languages. REFERENCE
   records only: no tokens, no connection state, no provider SDK
   fields (validated — §3.3).
2. **audience** — privacy-minimized AGGREGATES ONLY: closed audience
   size band, closed engagement band, age-distribution shares (closed
   bands, each 0–100, total ≤ 100), top-geography shares (ISO
   3166-1 alpha-2, ≤ 5 entries, each 0–100, total ≤ 100). NO raw
   audience records, NO individual-level data (validated — §3.3).
3. **commercial** — declared rate cards (format × closed rate unit ×
   amount × currency) + negotiability + preferred currencies.
   Amounts bounded by the shared economic amount validator
   (0 < amount ≤ ECONOMIC_MAX_AMOUNT, ECONOMIC_DECIMALS) — but a rate
   is DECLARED PREFERENCE, never economic state: no posting, no
   commitment, no balance.
4. **rights** — declared willingness: closed
   `CREATOR_RIGHTS_KINDS` (channel_publication, paid_amplification,
   reuse_license, exclusivity_window, derivative_works) + optional
   terms. Declared data only — rights EXECUTION is NET-W017.
5. **restrictions** — explicit exclusions: restricted topics
   (free-form), restricted formats (closed vocabulary),
   restricted territories (ISO 3166-1 alpha-2), and a mandatory
   disclosure flag (disclosure EXECUTION is NET-W018).
6. **availability** — `acceptingWork` + `weeklyCapacity` (0–100) +
   `minimumNoticeDays` (0–365). Explicit data; scheduling is
   NET-W016.
7. **participation** — `acceptsDirectCampaigns` +
   `requiresInvitation`. Explicit versioned data consumed by NET-W016
   matching; auto-match/auto-accept BEHAVIOUR itself is CRE-003 and
   stays out of scope.
8. **reputationReferences** — EXACTLY ONE per
   `CREATOR_REPUTATION_ROLES` role (`audience_influence`,
   `production`) — CRE-005's structural enforcement: the two signals
   are carried as SEPARATE references. Each references a canonical
   `/reputation` snapshot (id + digest) whose dimension is a frozen
   `ReputationDimension`; the service verifies existence, org scope,
   subject person and digest through the neutral lookup BEFORE the
   version commits.

### §3.3 The privacy/secret boundary (AC-03)

Two PURE deep-scan guards in `core/creators.ts`, applied to EVERY
section input (fail-closed validation):

- **credential-shaped keys** — any key matching the credential
  fragment set (password, token, secret, api-key, apikey, private-key,
  credential, access-key, refresh) at ANY nesting depth is rejected.
  Credentials never enter creator records; platform auth material
  stays behind the secret/adapter boundaries (invariant 6).
- **raw-audience-shaped keys** — any key matching the raw-audience
  fragment set (members, individuals, persons, users, audiences' raw
  containers, emails, addresses, contacts, device-ids, ip addresses,
  raw records) at ANY depth is rejected. Audience metadata is
  aggregate/qualified attributes ONLY (invariant 3).

Plus value-shape validation: bands closed, shares 0–100 with bounded
totals, territories/languages validated, amounts bounded, and a
structural source pin that the persisted section types expose no
credential/raw-audience fields.

### §3.4 Reputation references, never duplication (AC-04)

The profile version stores `{ role, dimension, snapshotId, digest }`
REFERENCES only. Reads that need the actual trust signal resolve
through the canonical snapshot service at the composition root
(`GET /api/creators/:id/reputation`) — the creator record NEVER
stores scores, and creator commands NEVER mutate reputation inputs,
policies or snapshots. The digest pins the referenced snapshot's
content so a later mismatch is detectable (the reference records WHAT
it referenced).

### §3.5 Authorization, tenancy, idempotency, concurrency, audit (AC-05)

- Owner-only mutations (server-side actor from the execution
  context; non-owner → AuthorizationError).
- Tenant isolation: every repository lookup is organization-scoped;
  cross-org reads/mutations are refused (scope checked BEFORE
  ownership so absence leaks nothing).
- Idempotency: every mutation through `IdempotencyStore`
  .applyIdempotent with the `creator_*` key family; replays return
  `created: false` and the same record.
- Concurrency: version monotonicity under the org-independent
  lineage mutex (parallel defines serialize — never fork);
  unique-anchor creation is race-safe in-tx (`findByPersonWithinTx`
  under the profile-anchor mutex).
- PostgreSQL authority: profiles + versions persist through the
  authority boundary (`creators`, `creator_profile_versions`
  collections — authority-backed repositories; the file-backed shim
  satisfies the same interface in dev/test).
- Audit lineage: every mutation commits atomically with its audit
  event (`creator_profile.created`, `creator_profile.version_defined`,
  `creator_profile.activated|paused|resumed|archived`) carrying
  actor/subject/resource + lineage ids.

### §3.6 Provider neutrality (AC-06)

The domain source contains NO provider names, SDK references, OAuth
flows or credential fields — provider-specific platform behaviour
stays behind adapter boundaries (regression: import scan + vocabulary
pins + provider-name scan). The port declares the composition points
later work items wire adapters into (platform verification,
audience-source ingestion) WITHOUT implementing them.

## §4 Key invariants (issue #29)

1. Creator identity anchored to canonical person identity; no second
   identity authority (unique anchor + person-existence validation).
2. Connected platforms are references, not provider state.
3. Audience metadata privacy-minimized; raw audience data rejected.
4. Commercial preferences/rights/restrictions/availability explicit,
   auditable, tenant-scoped versioned data.
5. Reputation referenced, never minted/mutated/duplicated.
6. Credentials never enter creator records.
7. AI/model output cannot establish creator eligibility (no AI path
   exists in the domain — structural pin).
8. Mutations idempotent, concurrency-safe, PostgreSQL-authoritative,
   transactionally audited.

## §5 Explicit non-goals

No creator matching/ranking (NET-W016), no UGC production workflow
or rights EXECUTION (NET-W017), no sponsorship/disclosure EXECUTION
(NET-W018), no ad inventory/optimization (NET-W019+), no external
platform EXECUTION (adapters are references-only composition
points), no direct reputation scoring, no payment execution, no
blockchain consensus, no economic mutation of any kind.

## §6 Acceptance-criteria → test map

| AC | Suite | Proves |
|---|---|---|
| 01 | tests/creators/net-w015-ac-01-profile-records.test.ts | first-class durable org-scoped records anchored to canonical identity; unique anchor; status machine; append-only events; durability |
| 02 | tests/creators/net-w015-ac-02-preferences.test.ts | all eight sections represented provider-neutrally; versioned sections; monotonic versions; current-version pointer; immutable history |
| 03 | tests/creators/net-w015-ac-03-privacy-secrets.test.ts | credential-shaped + raw-audience-shaped keys rejected at any depth; aggregate-only audience shapes; structural source pins |
| 04 | tests/creators/net-w015-ac-04-reputation-reference.test.ts | references verified against canonical snapshots (scope/person/digest/dimension); both roles required distinct; no score storage; reads resolve through the canonical authority |
| 05 | tests/creators/net-w015-ac-05-authorization-tenancy.test.ts | owner-only mutations; tenant isolation; idempotent replays; lineage-mutex concurrency; PostgreSQL authority collections; atomic audit lineage |
| 06 | tests/creators/net-w015-ac-06-provider-neutrality.test.ts | no provider imports/names/SDK patterns in the domain; closed vocabularies; adapter composition points declared, not implemented |
| 07 | tests/regression/net-w015-ac-07-architecture-out-of-scope.test.ts | arch check 0 violations; frozen specs unchanged; frozen vocabularies pinned UNCHANGED + new creator vocab pinned; no economic/reputation/AI/matching paths; file list; secret scan |

## §7 Verification

`bun run verify` — typecheck + arch:check + full unit suite (the
net-w015 suites included). The dev/test PostgresAuthorityShim provides
the authority boundary without a real PostgreSQL (the NET-W003
established pattern; real-PostgreSQL integration runs in CI).
