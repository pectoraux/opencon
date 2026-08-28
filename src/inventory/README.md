# `inventory` boundary

**Tier:** domain
**Authority:** inventory domain rules
**Architecture ref:** `spec/architecture.md` §18 (Module ownership), §7 (the sixteen frozen core domains)
**Work order:** `spec/work-orders/NET-W019.md` (concrete behaviour since NET-W019)

## Scope

The inventory boundary owns supply REGISTRATION and placement CONTEXT
(NET-W019 — one of the sixteen FROZEN core domains since NET-W001):

- **`InventoryItem`** — the first-class, durable, tenant-scoped record
  of registered publisher/app/creator supply with EXPLICIT registered
  ownership (the acting person at registration; there is no
  ownerPersonId input anywhere), a provider-neutral external
  reference, declared supply attributes, and an OPTIONAL canonical
  supply-verification evidence reference (INV-003).
- **`PlacementRecord`** — the explicit, durable, policy-scoped
  placement context binding an item to a campaign at a PINNED policy
  version, with the provenance source-context snapshot (server-written
  from durable records) and the DERIVED placement-eligibility
  evaluation (the pure engine over the pinned policy version's
  eligibility rules).
- **The derived settlement readiness** — the validated source context
  a settlement-affecting consumer must require (INV-004): re-derived
  from CURRENT durable records on every read; there is no command
  that asserts, stores or waives it.

## Authority separation (the decision of record)

- `/campaigns` stays the campaign policy authority (policy scope +
  eligibility rules resolve READ-ONLY through the neutral
  `InventoryCampaignLookup`).
- `/workflows` stays the SOLE lifecycle authority and is UNTOUCHED
  (items and placements carry NO lifecycle subject kind; withdrawal
  and retirement are one-way field mutations).
- `/evidence` stays the truth authority (the supply-verification
  reference validates through the neutral evidence lookup).
- `/settlement` stays the economic authority (NO economic surface
  here at all).
- Provider-specific platform semantics stay behind `/adapters` +
  `/secrets` (the external reference descriptor is provider-neutral).

## Dependencies

`core` contracts only. Cross-domain facts arrive through the
composition-root-wired neutral lookups; cross-domain commands would be
composed at the bootstrap boundary (none exist in NET-W019).
