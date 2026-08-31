/**
 * OpenRTB provider registry — the NET-W023 adapter registration
 * boundary (issue #46 scope 2; ADAPTER-001..002).
 *
 * The composition root registers every wired OpenRTB / supply-chain
 * provider adapter; the ingress service routes raw submissions by
 * provider id. Registration validates adapter identity (kind
 * "openrtb", non-empty provider + version) and fails CLOSED on
 * duplicates — one adapter per provider identity, so a raw submission
 * can never be normalized by an ambiguous registration (the W022
 * measurement-registry precedent).
 *
 * Adapter tier (src/adapters/registry.ts): imports core + the neutral
 * port only; no domain imports (tier matrix).
 */

import { OpenConError } from "../core/errors.ts";
import type {
  OpenRtbProviderAdapter,
  OpenRtbProviderRegistry,
} from "./port.ts";

export class OpenRtbProviderValidationError extends OpenConError {
  public constructor(
    message: string,
    context?: Readonly<Record<string, unknown>>,
  ) {
    super({
      code: "OPENRTB_PROVIDER_VALIDATION",
      classification: "validation",
      message,
      retryable: false,
      context,
    });
  }
}

export class OpenRtbProviderRegistryImpl implements OpenRtbProviderRegistry {
  private readonly adapters = new Map<string, OpenRtbProviderAdapter>();

  public register(adapter: OpenRtbProviderAdapter): void {
    if (!adapter || typeof adapter !== "object") {
      throw new OpenRtbProviderValidationError(
        "an OpenRTB provider adapter must be an object",
      );
    }
    const info = adapter.info;
    if (!info || typeof info !== "object") {
      throw new OpenRtbProviderValidationError(
        "an OpenRTB provider adapter must carry info",
      );
    }
    if (info.kind !== "openrtb") {
      throw new OpenRtbProviderValidationError(
        `adapter info.kind must be "openrtb" (got ${String(info.kind)})`,
        { provider: info.provider, kind: info.kind },
      );
    }
    if (typeof info.provider !== "string" || !info.provider.trim()) {
      throw new OpenRtbProviderValidationError(
        "adapter info.provider must be a non-empty string",
      );
    }
    if (typeof info.version !== "string" || !info.version.trim()) {
      throw new OpenRtbProviderValidationError(
        `adapter info.version must be a non-empty string (provider ${info.provider})`,
        { provider: info.provider },
      );
    }
    if (typeof adapter.normalizeRequest !== "function") {
      throw new OpenRtbProviderValidationError(
        `adapter ${info.provider} must implement normalizeRequest`,
        { provider: info.provider },
      );
    }
    if (typeof adapter.normalizeSellerAuthorization !== "function") {
      throw new OpenRtbProviderValidationError(
        `adapter ${info.provider} must implement normalizeSellerAuthorization`,
        { provider: info.provider },
      );
    }
    if (this.adapters.has(info.provider)) {
      throw new OpenRtbProviderValidationError(
        `an OpenRTB provider adapter is already registered for provider id ${info.provider} (one adapter per provider identity)`,
        { provider: info.provider },
      );
    }
    this.adapters.set(info.provider, adapter);
  }

  public byProviderId(providerId: string): OpenRtbProviderAdapter | undefined {
    return this.adapters.get(providerId);
  }

  public list(): readonly OpenRtbProviderAdapter[] {
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

/** Create an empty registry (the composition root registers adapters). */
export function createOpenRtbProviderRegistry(): OpenRtbProviderRegistryImpl {
  return new OpenRtbProviderRegistryImpl();
}
