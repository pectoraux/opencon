/**
 * INTENTIONAL ARCHITECTURE VIOLATION FIXTURE — DO NOT FIX.
 *
 * This file is part of the AC-02 evidence: it deliberately violates
 * the dependency rule (a domain module importing a concrete
 * infrastructure implementation). The architecture scanner MUST flag
 * it when scanning this fixture root. The real `src/` tree must
 * remain clean by contrast.
 *
 * Fixture root: tests/architecture/fixtures/violation/src
 */

// VIOLATION: identity (domain) imports workers (infrastructure concrete).
import { createInMemoryJobQueue } from "../workers/worker-loop.ts";

export interface IdentityPort {
  readonly boundary: "identity";
  readonly queue?: unknown;
}

export const identityFixture: IdentityPort = {
  boundary: "identity",
  queue: createInMemoryJobQueue(),
};
