import { defineBoundaryModule } from "../core/domain-module.ts";

/**
 * Secrets boundary module.
 * Authority: secrets isolation boundary. Concrete behaviour: NET-W001
 * (env-backed SecretProvider) + NET-W003 (SecretMaterialRedactor —
 * redacts credential-shaped values from logs/traces so secret material
 * is never emitted to observability/audit sinks).
 */
export const secretsModule = defineBoundaryModule({
  name: "secrets",
  tier: "infrastructure",
  summary:
    "secrets isolation boundary + credential-material redactor (NET-W001 + NET-W003)",
});
