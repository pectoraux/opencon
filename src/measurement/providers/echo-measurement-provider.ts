import type { MeasurementInput, MeasurementPort, MeasurementResult } from "../port.ts";
import type { ProviderAdapter } from "../../core/adapter.ts";

export class EchoMeasurementProvider implements MeasurementPort, ProviderAdapter {
  public readonly boundary = "measurement" as const;
  public readonly readiness = "skeleton" as const;
  public readonly info = {
    kind: "measurement" as const,
    provider: "echo",
    version: "0.1.0",
  };

  public async initialize(): Promise<void> {}
  public async healthCheck(): Promise<{ ok: boolean; detail?: string }> {
    return { ok: true };
  }
  public async measure(input: MeasurementInput): Promise<MeasurementResult> {
    return {
      subject: input.subject,
      value: 0,
      confidence: 0,
      provenance: "echo",
    };
  }
}

export const echoMeasurementProvider = new EchoMeasurementProvider();
