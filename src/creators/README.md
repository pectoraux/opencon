# `creators` boundary

**Tier:** domain
**Authority:** creator domain rules — creator identity anchors, platform references, audience metadata, commercial preferences, rights, restrictions, availability, reputation references
**Architecture ref:** `spec/architecture.md` §18 (Module ownership), §13 (Provider neutrality)
**Work order:** `spec/work-orders/NET-W015.md`

## Scope

NET-W015 makes this boundary concrete. It owns:

- **First-class creator profile records** — durable,
  organization-scoped, ANCHORED to a canonical person identity
  (self-anchored; one profile per person per organization scope —
  creation serialized under the
  `creator_profile_anchor:{organizationScopeId}:{creatorPersonId}`
  mutex so the invariant holds even for concurrent callers with
  different idempotency keys), with an append-only event history and
  an administrative status machine
  (`DRAFT → ACTIVE ⇄ PAUSED → ARCHIVED`).
- **Versioned profile sections** — immutable, append-only
  `CreatorProfileVersion` records (lineage mutex; version =
  latest+1) carrying ALL declared creator data: connected platforms,
  audience aggregates, commercial preferences, rights, restrictions,
  availability, participation rules, reputation references.
- **The privacy/secret boundary** — credential-shaped and
  raw-audience-shaped keys are structurally rejected at any nesting
  depth of any section input; audience metadata is
  aggregate/qualified attributes only.
- **Canonical reputation references** — one `audience_influence` and
  one `production` reference per profile version (CRE-005), each
  verified against the canonical `/reputation` snapshot authority
  and stored as a reference (id + digest) only.

Every read is tenant-scoped, including the ID-based reads (profile
by id, version lineage, reputation resolution): a cross-scope id is
indistinguishable from a nonexistent one (NotFoundError, no
existence oracle). Mutations are owner-only — the acting person
must BE the anchor person.

## Authority separation (the boundary's strongest constraint)

- `/identity` stays the person identity authority — profiles anchor
  to existing canonical persons through the neutral
  `CreatorPersonLookup` (composition-root wired).
- `/reputation` stays the trust-signal authority — references are
  verified through the neutral `CreatorReputationSnapshotLookup`;
  no score is ever computed, stored or accepted here.
- `/settlement` stays the economic authority — declared rates create
  no economic state whatsoever.
- `/workflows` stays the lifecycle authority — the profile status is
  the record's own administrative status, not a lifecycle.
- Provider-specific platform semantics stay OUTSIDE the domain
  (adapter composition points for NET-W016+).

## Dependencies

Core contracts only (`core/creators.ts`, `core/reputation.ts`,
`core/audit.ts`, `core/idempotency.ts`, …). Cross-domain access
happens exclusively through the declared neutral lookup interfaces
wired by the bootstrap composition root.
