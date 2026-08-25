/**
 * ProviderAdapter contract — provider-neutral integration boundary.
 *
 * Work order ref: NET-W001 §4.1 (`/adapters`), §6 (ProviderAdapter),
 * CORE-004 (provider-specific behavior behind adapters),
 * architecture-lock.md §14 (provider-specific SDK/types do not cross
 * into core domain modules).
 *
 * Each concrete adapter (in src/adapters/, src/llm/, src/payments/, etc.)
 * implements this contract. Domain modules depend ONLY on the contract
 * declared here — never on a concrete adapter or its provider SDK. The
 * architecture check enforces this (AC-02, AC-07).
 */

export type AdapterKind =
  | "ad"
  | "creator-platform"
  | "affiliate"
  | "payment"
  | "measurement"
  | "attribution"
  | "ledger"
  | "llm"
  | "agent";

export interface ProviderAdapterInfo {
  readonly kind: AdapterKind | string;
  readonly provider: string;
  readonly version: string;
}

export interface ProviderAdapter {
  readonly info: ProviderAdapterInfo;
  /** Initialize the adapter (e.g. establish a client). Idempotent. */
  initialize(): Promise<void>;
  /** Self-check used by the health boundary. Must not throw on failure. */
  healthCheck(): Promise<{ readonly ok: boolean; readonly detail?: string }>;
  /** Release resources on shutdown. */
  shutdown?(): Promise<void>;
}
