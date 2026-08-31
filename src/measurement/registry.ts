/**
 * Measurement provider registry — the NET-W022 adapter registration
 * boundary (issue #44 scope 1).
 *
 * The composition root registers every wired provider adapter; the
 * ingestion service routes raw report submissions by provider id.
 * Registration validates adapter identity (kind "measurement",
 * non-empty provider + version) and fails CLOSED on duplicates — one
 * adapter per provider identity, so a raw report can never be
 * normalized by an ambiguous registration.
 *
 * Adapter tier (src/measurement/registry.ts): imports core + the
 * neutral port only; no domain imports (tier matrix).
 */

import { OpenConError } from "../core/errors.ts";
import type {
  MeasurementProviderAdapter,
  MeasurementProviderRegistry,
} from "./port.ts";

export class MeasurementProviderValidationError extends OpenConError {
  public constructor(
    message: string,
    context?: Readonly<Record<string, unknown>>,
  ) {
    super({
      code: "MEASUREMENT_PROVIDER_VALIDATION",
      classification: "validation",
      message,
      retryable: false,
      context,
    });
  }
}

export class MeasurementProviderRegistryImpl
  implements MeasurementProviderRegistry
{
  private readonly adapters = new Map<string, MeasurementProviderAdapter>();

  public register(adapter: MeasurementProviderAdapter): void {
    if (!adapter || typeof adapter !== "object") {
      throw new MeasurementProviderValidationError(
        "a measurement provider adapter must be an object",
      );
    }
    const info = adapter.info;
    if (!info || typeof info !== "object") {
      throw new MeasurementProviderValidationError(
        "a measurement provider adapter must carry info",
      );
    }
    if (info.kind !== "measurement") {
      throw new MeasurementProviderValidationError(
        `adapter info.kind must be "measurement" (got ${String(info.kind)})`,
        { provider: info.provider, kind: info.kind },
      );
    }
    if (typeof info.provider !== "string" || !info.provider.trim()) {
      throw new MeasurementProviderValidationError(
        "adapter info.provider must be a non-empty string",
      );
    }
    if (typeof info.version !== "string" || !info.version.trim()) {
      throw new MeasurementProviderValidationError(
        `adapter info.version must be a non-empty string (provider ${info.provider})`,
        { provider: info.provider },
      );
    }
    if (this.adapters.has(info.provider)) {
      throw new MeasurementProviderValidationError(
        `a measurement provider adapter is already registered for provider id ${info.provider} (one adapter per provider identity)`,
        { provider: info.provider },
      );
    }
    this.adapters.set(info.provider, adapter);
  }

  public byProviderId(providerId: string): MeasurementProviderAdapter | undefined {
    return this.adapters.get(providerId);
  }

  public list(): readonly MeasurementProviderAdapter[] {
    return [...this.adapters.values()];
  }

  public async checkHealth(): Promise<
    readonly {
      readonly provider: string;
      readonly ok: boolean;
      readonly detail?: string;
    }[]
  > {
    const results: {
      provider: string;
      ok: boolean;
      detail?: string;
    }[] = [];
    for (const adapter of this.adapters.values()) {
      try {
        const health = await adapter.healthCheck();
        results.push({
          provider: adapter.info.provider,
          ok: health.ok,
          ...(health.detail !== undefined ? { detail: health.detail } : {}),
        });
      } catch (err) {
        results.push({
          provider: adapter.info.provider,
          ok: false,
          detail: `health check threw: ${(err as Error).message}`,
        });
      }
    }
    return results;
  }
}

/** Create an empty registry (composition root registers adapters). */
export function createMeasurementProviderRegistry(): MeasurementProviderRegistryImpl {
  return new MeasurementProviderRegistryImpl();
}
