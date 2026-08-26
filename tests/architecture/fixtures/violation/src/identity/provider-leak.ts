/**
 * INTENTIONAL ARCHITECTURE-VIOLATION FIXTURE.
 *
 * This file is part of tests/architecture/fixtures/violation/ and is
 * scanned by tests/architecture/ac-02-dependency-direction.test.ts and
 * tests/regression/net-w003-ac-08-architecture-out-of-scope.test.ts.
 *
 * It deliberately imports a provider package (`pg`) from a DOMAIN-tier
 * file to prove the architecture checker rejects domain -> provider
 * dependencies (frozen Architecture v1.0 §14: provider-specific
 * SDK/types do not cross into core domain modules; §2/§18: external
 * providers are integrated through `/adapters`).
 *
 * The scanner must flag this with rule
 * `external-provider-package-not-allowed-outside-adapter`.
 *
 * DO NOT remove this fixture without updating the assertions in
 * tests/regression/net-w003-ac-08-architecture-out-of-scope.test.ts.
 */

import { Client } from "pg";

export const _providerLeakFixtureClient: unknown = Client;
