/**
 * Echo measurement provider — a REFERENCE adapter satisfying the
 * provider-neutral MeasurementProviderAdapter contract (NET-W006
 * §3.7).
 *
 * This adapter reports NO observations: it exists so the composition
 * root has a real adapter to wire and health-check, and so later work
 * items (NET-W022: browser/platform + iOS attribution adapters) have
 * a compile-checked reference implementation of the contract. Real
 * providers live beside this file and keep all platform-specific
 * behavior inside the adapter tier (architecture-lock §14.24/§14.25).
 */

import type {
  MeasurementProviderAdapter,
  ProviderObservationFetchResult,
  ProviderObservationFetchRequest,
} from "../port.ts";

export class EchoMeasurementProvider implements MeasurementProviderAdapter {
  public readonly info = {
    kind: "measurement" as const,
    provider: "echo",
    version: "0.2.0",
  };

  public async initialize(): Promise<void> {}

  public async healthCheck(): Promise<{ ok: boolean; detail?: string }> {
    return { ok: true };
  }

  public async fetchObservations(
    _request: ProviderObservationFetchRequest,
  ): Promise<ProviderObservationFetchResult> {
    return { observations: [], nextCursor: null };
  }
}

export const echoMeasurementProvider = new EchoMeasurementProvider();
