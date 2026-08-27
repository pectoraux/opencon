# NET-W015 — Creator identity and preferences (evidence document)

**Issue:** #29 · **Architecture:** v1.0 (FROZEN — `spec/architecture.md`,
`spec/architecture-lock.md` byte-unchanged) · **Work order:**
`spec/work-orders/NET-W015.md`

## What shipped

The creator foundation: first-class creator profile records anchored
to canonical person identity, provider-neutral connected-platform
references, privacy-minimized audience metadata, explicit versioned
commercial preferences, rights, restrictions, availability and
participation rules, and DISTINCT audience/production reputation
REFERENCES sourced from the canonical `/reputation` authority —
WITHOUT a second identity authority, WITHOUT a duplicate scoring
engine, WITHOUT credentials or raw audience data in creator records,
and WITHOUT matching (NET-W016), UGC/rights execution (NET-W017) or
sponsorship/disclosure execution (NET-W018):

```text
Canonical Person Identity        (/identity — the anchor; never duplicated)
        ↓  createCreatorProfile (self-anchored; unique per person per org)
Creator Profile Record           (/creators — org-scoped, owner-only, DRAFT)
        ↓  defineProfileVersion (the lineage-mutex versioned sections)
Creator Profile Version          (immutable, append-only, version = latest+1)
        ├── Connected Platforms      (provider-neutral REFERENCES)
        ├── Audience Metadata        (privacy-minimized AGGREGATES only)
        ├── Commercial Preferences   (rates — declared data, NOT commitments)
        ├── Rights / Restrictions    (declared willingness + exclusions)
        ├── Availability             (capacity/notice — explicit data)
        ├── Participation Rules      (explicit data; matching is NET-W016)
        └── Reputation References    (audience_influence + production roles,
                                      canonical /reputation snapshot ids)
        ↓  reads resolve through the canonical authority
Canonical Reputation             (/reputation — referenced, never duplicated,
                                   never mutated, never scored here)
```

## The decision of record: the frozen boundary becomes concrete

NET-W015 makes the `/creators` boundary real — the NET-W011
campaigns precedent (the W001 skeleton carried a documented port +
module registration whose `readiness` was `"skeleton"`; NO 17th
domain is added; the frozen architecture-lock domain list already
contains `/creators` and is regression-pinned unchanged). The domain
follows the established layering exactly:

- **`src/core/creators.ts`** — the NEW frozen creator vocabulary (a
  NEW core contract module, the `core/campaigns.ts` precedent):
  profile statuses, platform kinds, content formats, audience
  size/engagement/age bands, rate units, rights kinds, the CRE-005
  reputation reference roles, amount/share/tag validators reusing
  the shared economic bounds, and the two PURE privacy/secret
  guards (`assertNoCredentialShapedKeys` +
  `assertNoRawAudienceKeys`).
- **`src/creators/`** — the domain: `port.ts` (contracts + the
  neutral lookups), `creator-service.ts` (all validation, the
  unique-anchor rule, the lineage mutex, the status machine, the
  reference verification), `authority-creator-repository.ts`
  (PostgreSQL-authority-backed repositories over the frozen
  `creators` + `creator_profile_versions` collections).
- **`src/bootstrap/runtime.ts`** — composition-root wiring: the
  neutral lookups are thin READ-ONLY adapters over the OWNING
  domains' repositories (`identityRepo.exists` for the person
  anchor; `reputationSnapshotRepo.findById` for the reference
  verification) — the NET-W005/007/011 dependency-inversion
  pattern. The `resolveCreatorReputation` read resolves references
  through the canonical snapshot service on demand.
- **`src/api/`** — the guarded mutation routes
  (`creators.profile.create` / `creators.version.define` /
  `creators.status.*`) + public reads (profile, by-person anchor
  lookup, versions, reputation resolution).

## Key design decisions

1. **Self-anchored profiles with the unique-anchor rule** — a
   creator profile is always the acting person's OWN profile (a
   person cannot create another person's creator profile), the
   anchor person must EXIST through the neutral identity lookup,
   and ONE profile per (organization scope, person) is enforced
   IN-TRANSACTION at creation. A second identity authority is
   structurally impossible (issue invariant 1).
2. **All eight sections in ONE immutable version** — the
   campaign-policy precedent: `defineProfileVersion` appends an
   immutable full-section snapshot under the
   org-independent lineage mutex
   `creator_profile_lineage:{profileId}` (version = latest+1,
   never forks — regression-proven with 4 concurrent defines), and
   the current-version pointer flips in the SAME transaction. A
   profile cannot ACTIVATE without a version (the CAMP-002
   defined-before-activation precedent).
3. **The privacy/secret boundary is a PURE deep-scan guard** —
   credential-shaped keys (token/secret/api-key/password/
   credential/access-key/refresh/auth fragments) and
   raw-audience-shaped keys (members/emails/individuals/contacts/
   device-ids/…) are rejected at ANY nesting depth of ANY section
   input, fail-closed, BEFORE shape validation even runs. The
   audience section is structurally aggregate-only (closed bands +
   bounded shares; ≤ 5 geographies; totals ≤ 100).
4. **CRE-005 is enforced by the DATA SHAPE** — a profile version
   carries EXACTLY ONE `audience_influence` reference and EXACTLY
   ONE `production` reference (both required, duplicates and
   omissions refused). Each reference is `{role, dimension,
   snapshotId, digest}` — STRICT shape (a smuggled `score` field is
   rejected), the dimension must be a FROZEN canonical dimension,
   and the service VERIFIES existence + organization scope +
   subject person + digest through the neutral lookup BEFORE the
   version commits. The creator record never stores a score; reads
   resolve through the canonical snapshot service at the
   composition root.
5. **Declared rates are preferences, never economics** — rate
   amounts reuse the shared economic amount validator
   (0 < amount ≤ ECONOMIC_MAX_AMOUNT, ≤ 6 decimals) but create NO
   economic state: the creators domain carries no economic-unit
   mutation method at all (regression-pinned), mirroring the
   campaign-budget declaration precedent.
6. **Strict reference shapes; owner-only everything** — reputation
   references reject unknown keys; every mutation is owner-only
   (server-side actor), idempotent (`IdempotencyStore`
   .applyIdempotent), concurrency-safe (the lineage mutex + the
   in-tx unique-anchor check), PostgreSQL-authoritative (the frozen
   collection names) and transactionally audited
   (`creator_profile.*` events with actor/subject/resource +
   execution lineage).

## The additive vocabulary (the only shared-baseline addition)

`src/core/creators.ts` is a NEW core contract module (the
`core/campaigns.ts` / `core/contributions.ts` precedent). NO
existing frozen vocabulary changed — the AC-07 regression pins the
economic value sources/account kinds/stake purposes/ledger tx
kinds/cash kinds, campaign statuses/clearing vocabularies/events,
risk operation classes, dispute subject types, reputation input
sources AND reputation dimensions byte-for-byte unchanged, and pins
the new creator vocabularies (profile statuses, platform kinds,
content formats, audience bands, rate units, rights kinds,
reputation roles, profile events).

## Invariant → enforcement map (issue #29)

| # | Invariant | Enforcement |
|---|---|---|
| 1 | Anchored to canonical identity; no second identity authority | self-anchor rule + person-existence lookup + unique-anchor rule (AC-01) |
| 2 | Platforms are references, not provider state | closed kinds, reference-only fields (structural pin), no provider names/SDK/OAuth in domain source (AC-06) |
| 3 | Audience privacy-minimized; raw audience rejected | `assertNoRawAudienceKeys` deep scan + aggregate-only shapes + structural pins (AC-03) |
| 4 | Preferences/rights/restrictions/availability explicit, auditable, tenant-scoped | versioned sections + audit events + org-scoped repositories (AC-02, AC-05) |
| 5 | Reputation referenced, never duplicated/mutated | reference-only storage (strict shape), canonical verification, resolution read, no mutation surface (AC-04 + structural pins) |
| 6 | Credentials never enter creator records | `assertNoCredentialShapedKeys` deep scan at any depth (AC-03) |
| 7 | AI cannot establish eligibility | NO LLM/advisory path in the domain or the composites (structural regression) |
| 8 | Mutations idempotent, concurrency-safe, PG-authoritative, audited | applyIdempotent + lineage mutex + authority collections + transactional audit (AC-05) |

## API surface

- `POST /api/creators` — create (guarded `creators.profile.create`)
- `POST /api/creators/:id/versions` — define the next version
  (guarded `creators.version.define`)
- `POST /api/creators/:id/activate|pause|resume|archive` — the
  status machine (guarded `creators.status.*`)
- `GET /api/creators?organizationScopeId[&status]` — org listing
- `GET /api/creators/by-person?organizationScopeId&creatorPersonId`
  — the anchor lookup
- `GET /api/creators/:id` — the profile with its event history
- `GET /api/creators/:id/versions` — the immutable version lineage
- `GET /api/creators/:id/reputation` — resolve the current
  version's references through the canonical `/reputation` snapshot
  service (references only; the trust signal resolves on demand)

## Acceptance-criteria → test mapping

| AC | Suite | Result |
|---|---|---|
| 01 first-class durable scoped records | tests/creators/net-w015-ac-01-profile-records.test.ts (6 tests) | pass |
| 02 explicit provider-neutral representation | tests/creators/net-w015-ac-02-preferences.test.ts (7 tests) | pass |
| 03 privacy/secret boundaries | tests/creators/net-w015-ac-03-privacy-secrets.test.ts (13 tests) | pass |
| 04 reputation referenced not duplicated | tests/creators/net-w015-ac-04-reputation-reference.test.ts (8 tests) | pass |
| 05 authz/tenancy/idempotency/concurrency/PG/audit | tests/creators/net-w015-ac-05-authorization-tenancy.test.ts (7 tests) | pass |
| 06 provider neutrality | tests/creators/net-w015-ac-06-provider-neutrality.test.ts (6 tests) | pass |
| 07 architecture/out-of-scope regression | tests/regression/net-w015-ac-07-architecture-out-of-scope.test.ts (10 tests) | pass |

Baseline test amendments (all additive, the established precedent):
`tests/regression/ac-08-no-premature-domain-logic.test.ts` gains
`NET_W015_DOMAINS = ["creators"]` (the W011 campaigns precedent —
the skeleton pin moves to the non-skeletal list with a NET-W015
describe check).

## Verification

`bun run verify` — typecheck PASS · `arch:check` 0 violations ·
full unit suite green (the numbers recorded in the worklog at PR
time).
