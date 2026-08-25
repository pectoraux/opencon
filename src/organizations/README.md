# `organizations` boundary

**Tier:** domain
**Authority:** organization membership and eligibility
**Architecture ref:** `spec/architecture.md` §18, `spec/architecture-lock.md` §2
**Implemented in:** NET-W002 (organization records, explicit membership records, membership lifecycle, audit lineage)

## Scope in NET-W002

The organizations boundary owns organization records and the explicit
person↔organization membership relationship.

It implements:

- **`Organization`** — organization record (stable id, name, `createdBy`
  actor provenance, `createdAt`).
- **`Membership`** — explicit membership record (`personId`,
  `organizationId`, lifecycle `status` active/revoked, `grantedBy`/`grantedAt`
  + `revokedBy`/`revokedAt` provenance).
- **`OrganizationRepository`** + **`MembershipRepository`** — persistence
  ports. In-memory implementations live here for executable tests; the
  authoritative PostgreSQL backend is NET-W003 behind the same interface
  (§4.7).
- **`OrganizationService`** — creates organizations (emits
  `organization.created` audit).
- **`MembershipService`** — grants / revokes memberships. Lifecycle is
  deterministic and idempotent (NET-W002-AC-05): re-granting an active
  membership returns the existing record (no duplicate audit); revoking
  an already-revoked membership is a no-op. Material mutations emit
  `organization.membership_granted` / `organization.membership_revoked`
  audit records with actor/subject/resource/execution+correlation IDs
  (NET-W002-AC-08).

Network-level participant roles (PERSON, CREATOR, COMPANY, …) are owned
by `/participants` (a separate domain). The structural surface the
participants `AuthorizationService` consumes for org-membership checks
is the `MembershipLookup` interface mirrored in participants/port.ts;
the bootstrap wires a single concrete `MembershipRepository` to satisfy
both.

## Dependencies

The organizations boundary imports only:
- `src/core/*` (contracts: `ExecutionContext`, `AuditWriter`, `Logger`,
  `OpenConError` subclasses, `randomUUID`) — allowed;
- its own `port.ts` — allowed (self, same dir).

It does NOT import infrastructure, adapters, or any other domain. The
concrete `AuditWriter` + repositories are injected by the bootstrap
composition root.
