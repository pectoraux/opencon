/**
 * EconomicLedgerService — the read-only projection over the immutable
 * ledger entry set (NET-W008 §3.2/§3.7): transaction lookups, per-
 * subject settlement lineage (AUD-003), account balances and the
 * per-participant economic summary.
 *
 * Balances are NEVER stored as mutable counters — they are DERIVED
 * from the immutable entries, so the ledger is reconstructable by
 * construction (AC-01): replaying the entry set always reproduces
 * every balance.
 *
 * Tier compliance: settlement domain → self + core contracts only.
 */

import type { ExecutionContext } from "../core/execution-context.ts";
import { NotFoundError } from "../core/errors.ts";
import type {
  EconomicAccountBalance,
  EconomicLedgerRepository,
  EconomicLedgerService,
  EconomicLedgerSubjectRef,
  EconomicLedgerTransaction,
  ParticipantEconomicSummary,
} from "./port.ts";
import { economicAccountId, normalSideBalance } from "./ledger.ts";
import { deriveAccountBalances } from "./authority-ledger-repository.ts";

export interface EconomicLedgerServiceDeps {
  readonly repository: EconomicLedgerRepository;
}

export function createEconomicLedgerService(
  deps: EconomicLedgerServiceDeps,
): EconomicLedgerService {
  const { repository } = deps;

  const service: EconomicLedgerService = {
    async getTransaction(_execution, id) {
      const found = await repository.findTransaction(id);
      if (!found) {
        throw new NotFoundError(`ledger transaction not found: ${id}`, {
          transactionId: id,
        });
      }
      return found;
    },

    async listTransactionsBySubject(_execution, subject) {
      return repository.listTransactionsBySubject(subject);
    },

    async listAccountBalances(_execution, organizationScopeId) {
      const [accounts, entries] = await Promise.all([
        repository.listAccounts(organizationScopeId),
        repository.scanEntries(organizationScopeId),
      ]);
      return deriveAccountBalances(accounts, entries);
    },

    async getParticipantSummary(
      _execution,
      organizationScopeId,
      personId,
    ): Promise<ParticipantEconomicSummary> {
      const entries = await repository.scanEntries(organizationScopeId);
      const balanceFor = (
        kind: Parameters<typeof economicAccountId>[2],
        unit: "value" | "credits" | "cash",
      ): number => {
        const accountId = economicAccountId(organizationScopeId, personId, kind, unit);
        return normalSideBalance(
          kind,
          entries.filter((e) => e.accountId === accountId),
        );
      };
      return {
        organizationScopeId,
        personId,
        pendingValue: balanceFor("pending_value", "value"),
        matureValue: balanceFor("mature_value", "value"),
        credits: balanceFor("credits", "credits"),
        rewards: balanceFor("rewards", "value"),
        cashPayable: balanceFor("cash_payable", "cash"),
        cashReceivable: balanceFor("cash_receivable", "cash"),
      };
    },
  };

  return service;
}

export { NotFoundError };
export type {
  EconomicAccountBalance,
  EconomicLedgerSubjectRef,
  EconomicLedgerTransaction,
  ExecutionContext,
  ParticipantEconomicSummary,
};
