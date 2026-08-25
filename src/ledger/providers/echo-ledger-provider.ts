import type { LedgerCommitResult, LedgerEntry, LedgerPort } from "../port.ts";
import type { ProviderAdapter } from "../../core/adapter.ts";

export class EchoLedgerProvider implements LedgerPort, ProviderAdapter {
  public readonly boundary = "ledger" as const;
  public readonly readiness = "skeleton" as const;
  public readonly info = {
    kind: "ledger" as const,
    provider: "echo",
    version: "0.1.0",
  };

  public async initialize(): Promise<void> {}
  public async healthCheck(): Promise<{ ok: boolean; detail?: string }> {
    return { ok: true };
  }
  public async commit(input: LedgerEntry): Promise<LedgerCommitResult> {
    return { hash: `echo-${input.entry}`, finalized: true };
  }
}

export const echoLedgerProvider = new EchoLedgerProvider();
