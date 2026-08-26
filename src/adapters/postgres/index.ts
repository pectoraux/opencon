/**
 * PostgreSQL provider adapter boundary.
 *
 * Architecture ref: spec/architecture.md §18 (`/adapters` = external
 * platform/provider integrations), §19 (PostgreSQL is the
 * authoritative application state in v1.0), architecture-lock §3,
 * §14 (provider-specific SDK/types do not cross into core domain
 * modules).
 *
 * This is the ONLY place `pg` is imported. The adapter implements the
 * provider-neutral {@link PostgresAuthority} contract from
 * `src/core/postgres-authority.ts`; domain/infrastructure modules
 * consume that contract, never this concrete driver. The
 * `PostgresAuthorityShim` in `src/persistence/` remains a clearly
 * marked TEST DOUBLE for unit tests that don't need a real database.
 *
 * The real integration path is exercised by
 * `tests/integration/postgres-authority-integration.test.ts`.
 */

export * from "./postgres-authority-adapter.ts";
