import type { PaymentPort, PayoutInput, PayoutResult } from "../port.ts";
import type { ProviderAdapter } from "../../core/adapter.ts";

export class EchoPaymentProvider implements PaymentPort, ProviderAdapter {
  public readonly boundary = "payments" as const;
  public readonly readiness = "skeleton" as const;
  public readonly info = {
    kind: "payment" as const,
    provider: "echo",
    version: "0.1.0",
  };

  public async initialize(): Promise<void> {}
  public async healthCheck(): Promise<{ ok: boolean; detail?: string }> {
    return { ok: true };
  }
  public async payout(input: PayoutInput): Promise<PayoutResult> {
    return {
      reference: input.reference,
      externalReference: `echo-${input.amount}-${input.currency}`,
      status: "paid",
    };
  }
}

export const echoPaymentProvider = new EchoPaymentProvider();
