/**
 * Ledger boundary — external settlement network integration port.
 *
 * Architecture ref: spec/architecture.md §16 (Decentralization strategy),
 * §18 (ledger/settlement networks), architecture-lock.md §10 (external
 * settlement networks), §14.
 *
 * Deferred to NET-W030. Domain code (`/settlement`) depends on this
 * neutral port, never on a concrete provider.
 */

export interface LedgerEntry {
  readonly entry: string;
  readonly amount?: number;
  readonly currency?: string;
}

export interface LedgerCommitResult {
  readonly hash: string;
  readonly finalized: boolean;
}

export interface LedgerPort {
  readonly boundary: "ledger";
  readonly readiness: "skeleton";
  commit(input: LedgerEntry): Promise<LedgerCommitResult>;
}
