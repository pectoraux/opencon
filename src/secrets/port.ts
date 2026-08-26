/**
 * Secrets boundary — declared public interface (port).
 *
 * Architecture ref: spec/architecture.md §18 (Module ownership).
 * Authority: secrets isolation boundary.
 *
 * NET-W001 shipped the boundary and the env-backed SecretProvider.
 * NET-W003 hardens the boundary: `SecretMaterialRedactor` redacts
 * credential-shaped values from arbitrary log/trace fields so secret
 * material is never accidentally emitted to logs/audit/persisted state.
 * No domain/economic behavior is created here (NET-W003 §5 non-goals).
 */

export interface SecretsPort {
  /** Stable boundary identifier for diagnostics and registry. */
  readonly boundary: "secrets";
  /**
   * Boundary readiness. NET-W003 hardens the secrets boundary with
   * the SecretMaterialRedactor; the env-backed SecretProvider from
   * NET-W001 is unchanged.
   */
  readonly readiness: "concrete";
}
