# `audit` boundary

**Tier:** infrastructure  
**Authority:** append-oriented auditability boundary; material-mutation
tracing (durable-state transaction + object-store reference lineage)  
**Architecture ref:** `spec/architecture.md` §18, §19;
`spec/architecture-lock.md` §12, §16; requirement AUD-001  
**Concrete behaviour:** NET-W001 (append-only writer + deep immutability)
+ NET-W002 (identity/org/participant/authorization lineage) +
NET-W003 (transactional audit writer + material-mutation tracing)

## Scope in NET-W003

NET-W003 extends the audit boundary so material mutations are traceable
to durable state and audit writes participate transactionally in the
mutations they describe:

- **`TransactionalAuditWriter`** (`src/audit/transactional-audit-writer.ts`) —
  wraps an underlying append-only `AuditWriter` so that audit events
  for a material mutation are buffered inside the mutation's
  authoritative transaction and flushed on commit (or discarded on
  rollback). Atomicity: audit + mutation commit together, or both
  roll back. The append-only log is not polluted with descriptions of
  mutations that never happened.
- **Material-mutation tracing**: each flushed audit record carries the
  authoritative `transactionId` (in metadata) and any object-store
  `objectReferenceIds` so a material mutation can be traced back to its
  durable transaction and to the durable references of large artifacts
  it produced.

The NET-W001 append-only / deep-immutability invariant is preserved: a
flushed audit event is still deeply-frozen and never mutated by later
writes. The NET-W002 identity-boundary remediations (no caller-controlled
actor; no raw client-claims in logs) carry forward unchanged.

## Non-goals

No audit event types for future business domains (campaigns, evidence
evaluation, reputation mutation, credit issuance, settlement, fraud,
demand pools, procurement, benefits, advertising, creators, blockchain
consensus). Only structural + identity/organization/participant/
authorization events (NET-W001/NET-W002) + the transactional wrapper.
