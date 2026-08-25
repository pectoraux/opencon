/**
 * Adapters boundary — external platform/provider integration port.
 *
 * Architecture ref: spec/architecture.md §15 (Interoperability),
 * §18 (`/adapters` — external platform/provider integrations),
 * architecture-lock.md §14 (provider-specific SDK/types do not cross
 * into core domain modules).
 *
 * Concrete adapters live under `src/adapters/<provider>/` and implement
 * `ProviderAdapter`. Domain code never imports a concrete adapter; it
 * consumes provider-neutral ports declared here or in the relevant
 * integration boundary (`/llm`, `/measurement`, `/payments`, etc.).
 */

import type { ProviderAdapter } from "../core/adapter.ts";

/**
 * External platform adapter port (e.g. OpenRTB, creator platforms,
 * attribution, affiliate). Each concrete adapter implements
 * `ProviderAdapter`; domain-facing contracts are provider-neutral.
 */
export interface AdaptersPort {
  readonly boundary: "adapters";
  readonly readiness: "skeleton";
  /** Look up a registered concrete adapter by provider id (for wiring only). */
  resolve(providerId: string): ProviderAdapter | null;
}
