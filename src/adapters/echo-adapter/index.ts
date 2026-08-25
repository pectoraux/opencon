/**
 * Concrete external-platform adapter (ECHO) — demonstrates the
 * /adapters boundary. Domain code never imports this directly; it is
 * wired into the registry at the composition root (src/bootstrap.ts).
 */

import type { ProviderAdapter } from "../../core/adapter.ts";

export interface EchoPlatformSignal {
  readonly raw: string;
}

export interface EchoPlatformNormalized {
  readonly normalized: string;
  readonly provenance: string;
}

class EchoPlatformAdapter implements ProviderAdapter {
  public readonly info = {
    kind: "ad" as const,
    provider: "echo-platform",
    version: "0.1.0",
  };

  public async initialize(): Promise<void> {}
  public async healthCheck(): Promise<{ ok: boolean; detail?: string }> {
    return { ok: true, detail: "echo platform adapter" };
  }

  /** Adapter-specific surface (not part of ProviderAdapter contract). */
  public async receiveSignal(input: EchoPlatformSignal): Promise<EchoPlatformNormalized> {
    return { normalized: input.raw, provenance: "echo-platform" };
  }
}

export const echoPlatformAdapter = new EchoPlatformAdapter();
