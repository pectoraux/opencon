# `reputation` boundary

**Tier:** domain
**Authority:** reputation computation and provenance
**Architecture ref:** `spec/architecture.md` §4, §11, §18, §19; `spec/architecture-lock.md` §3, §4, §12, §14
**Work order:** `spec/work-orders/NET-W007.md`

## Scope (NET-W007)

Reputation is a **derived trust signal**, never an economic authority:

- **Multidimensional dimensions** — the frozen eight (helpfulness,
  content quality, creator performance, inventory quality,
  measurement reliability, commerce reliability, fraud resistance,
  fulfillment reliability). Dimensions are independent: a dimension
  score derives only from that dimension's inputs.
- **Evidence-backed inputs** — immutable, append-only records that
  each reference ≥1 upstream record (evidence, Proof-of-Value,
  measured outcome, contribution) resolved through neutral lookups.
  The `verified`/`indicated` basis is DERIVED, never caller-asserted.
- **Versioned deterministic scoring policies** — immutable policy
  records with exactly one rule per dimension; identical inputs +
  policy + referenceAt always reproduce identical scores.
- **Deterministic time decay** — explicit reference timestamps; no
  wall clock anywhere in the engine.
- **Snapshots + history** — immutable, append-only, reconstructable
  from `(inputIds, policyVersion, referenceAt)`; every score change
  is auditable (AUD-004).

## The key rule

Advertising spend, deposits, wealth, Participation Credits and raw
activity volume can never directly increase reputation: the input
contract has no field for any of them and every input requires
verified upstream references. Inputs backed only by model-assessed or
self-reported evidence are `indicated` basis — reduced weight and
strictly capped below a fully verified score.

Reputation issues no credits, settles no cash, prices no advertising,
allocates no benefits, and mutates no other domain. It cannot be
spent.

## Files

- `port.ts` — entities, repositories, neutral lookups, service contracts.
- `scoring.ts` — the PURE deterministic scoring + decay engine.
- `policy-service.ts` — versioned policy creation (monotonic, atomic, audited).
- `input-service.ts` — evidence-backed input recording (source gate,
  derived basis).
- `snapshot-service.ts` — deterministic computation + snapshot recording.
- `authority-policy-repository.ts` /
  `authority-input-repository.ts` /
  `authority-snapshot-repository.ts` — PostgreSQL-authoritative
  persistence through the NET-W003 authority boundary.

## Dependencies

Core contracts only. Upstream domains (identity, evidence, outcomes,
contributions) are consumed through the structural lookup interfaces
declared in `port.ts`; the bootstrap composition root wires the
adapters.
