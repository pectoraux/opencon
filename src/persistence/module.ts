import { defineBoundaryModule } from "../core/domain-module.ts";

/**
 * Persistence boundary module.
 * Authority: authoritative state (PostgreSQL in v1.0); transaction
 * boundaries; recovery; idempotency. Concrete behaviour: NET-W003
 * (PostgresAuthority shim + durable transactions + idempotency store).
 */
export const persistenceModule = defineBoundaryModule({
  name: "persistence",
  tier: "infrastructure",
  summary:
    "authoritative state (PostgreSQL in v1.0); transaction boundaries, recovery, idempotency (NET-W003)",
});
