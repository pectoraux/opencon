/**
 * Authority-backed EconomicLedgerRepository — persists the
 * double-entry ledger (accounts, transactions, entries) through the
 * PostgreSQL authority boundary (NET-W003).
 *
 * Work order ref: NET-W008 §3.2 (double-entry ledger).
 *
 * Storage model:
 *  - `economic_accounts` keyed by the DETERMINISTIC account id
 *    (org|owner|kind|unit) — provisioning is idempotent by
 *    construction; duplicate accounts for one role are impossible.
 *  - `economic_ledger_transactions` keyed by transaction id; each
 *    carries its full immutable entry set.
 *  - `economic_ledger_entries` keyed by entry id, denormalized with
 *    (organizationScopeId, ownerPersonId, accountKind) so balances
 *    and lineage reconstruct from the entry set alone. Entries are
 *    IMMUTABLE — there is no update or delete path.
 *
 * In-transaction reads (scan) see uncommitted writes in the same
 * transaction, so the posting layer's per-account balance checks run
 * against transaction-consistent state.
 */

import type {
  AuthorityTransaction,
  PostgresAuthority,
} from "../core/postgres-authority.ts";
import type {
  EconomicAccount,
  EconomicAccountKind,
  EconomicAccountBalance,
  EconomicLedgerEntry,
  EconomicLedgerRepository,
  EconomicLedgerSubjectRef,
  EconomicLedgerTransaction,
} from "./port.ts";
import { economicAccountId, normalSideBalance } from "./ledger.ts";
import type { EconomicUnitType } from "../core/economics.ts";

const ACCOUNTS_COLLECTION = "economic_accounts";
const TRANSACTIONS_COLLECTION = "economic_ledger_transactions";
const ENTRIES_COLLECTION = "economic_ledger_entries";

export interface AuthorityEconomicLedgerRepositoryOptions {
  readonly authority: PostgresAuthority;
  readonly logger?: {
    debug(message: string, fields?: Record<string, unknown>): void;
  };
}

export function createAuthorityEconomicLedgerRepository(
  opts: AuthorityEconomicLedgerRepositoryOptions,
): EconomicLedgerRepository {
  const authority = opts.authority;
  const logger = opts.logger;

  async function scanEntries(
    filterOrg: string | undefined,
    scan: () => Promise<readonly { value: EconomicLedgerEntry }[]>,
  ): Promise<readonly EconomicLedgerEntry[]> {
    const records = await scan();
    return records
      .map((r) => r.value)
      .filter((e) => filterOrg === undefined || e.organizationScopeId === filterOrg)
      .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  }

  return {
    // -- Accounts ---------------------------------------------------------

    async findAccount(organizationScopeId, ownerPersonId, kind, unit) {
      const id = economicAccountId(organizationScopeId, ownerPersonId, kind, unit);
      const rec = await authority.get<EconomicAccount>(ACCOUNTS_COLLECTION, id);
      return rec ? rec.value : null;
    },

    async findAccountWithinTx(organizationScopeId, ownerPersonId, kind, unit, tx) {
      const id = economicAccountId(organizationScopeId, ownerPersonId, kind, unit);
      const rec = await tx.get<EconomicAccount>(ACCOUNTS_COLLECTION, id);
      return rec ? rec.value : null;
    },

    async createAccountWithinTx(account, tx) {
      await tx.put(ACCOUNTS_COLLECTION, account.id, account);
      logger?.debug("economic_account.created_within_tx", {
        accountId: account.id,
        transactionId: tx.transactionId,
      });
      return account;
    },

    async listAccounts(organizationScopeId) {
      const records = await authority.scan<EconomicAccount>(ACCOUNTS_COLLECTION);
      return records
        .map((r) => r.value)
        .filter((a) => a.organizationScopeId === organizationScopeId)
        .sort((a, b) => (a.id < b.id ? -1 : 1));
    },

    // -- Entries ----------------------------------------------------------

    async listEntriesForAccountWithinTx(accountId, tx) {
      const records = await tx.scan<EconomicLedgerEntry>(ENTRIES_COLLECTION);
      return records
        .map((r) => r.value)
        .filter((e) => e.accountId === accountId)
        .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    },

    async listEntriesForAccount(accountId) {
      const records = await authority.scan<EconomicLedgerEntry>(ENTRIES_COLLECTION);
      return records
        .map((r) => r.value)
        .filter((e) => e.accountId === accountId)
        .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    },

    // -- Transactions -----------------------------------------------------

    async findTransaction(id) {
      const rec = await authority.get<EconomicLedgerTransaction>(
        TRANSACTIONS_COLLECTION,
        id,
      );
      return rec ? rec.value : null;
    },

    // NET-W030 (additive): the in-tx transaction read (immutable
    // records — the twin keeps the in-tx re-derivation discipline for
    // the external-settlement reconciliation derivation).
    async findTransactionWithinTx(id, tx) {
      const rec = await tx.get<EconomicLedgerTransaction>(
        TRANSACTIONS_COLLECTION,
        id,
      );
      return rec ? rec.value : null;
    },

    async listTransactionsBySubject(subject) {
      const records = await authority.scan<EconomicLedgerTransaction>(
        TRANSACTIONS_COLLECTION,
      );
      return records
        .map((r) => r.value)
        .filter(
          (t) =>
            t.subject !== null &&
            t.subject.kind === subject.kind &&
            t.subject.id === subject.id,
        )
        .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    },

    async createTransactionWithinTx(transaction, tx) {
      await tx.put(TRANSACTIONS_COLLECTION, transaction.id, transaction);
      for (const entry of transaction.entries) {
        await tx.put(ENTRIES_COLLECTION, entry.id, entry);
      }
      logger?.debug("economic_ledger.transaction_created", {
        transactionId: transaction.id,
        kind: transaction.kind,
        entries: transaction.entries.length,
      });
      return transaction;
    },

    async scanEntries(organizationScopeId) {
      return scanEntries(organizationScopeId, () =>
        authority.scan<EconomicLedgerEntry>(ENTRIES_COLLECTION),
      );
    },
  };
}

/** Derive account balances from the immutable entry set (pure read). */
export function deriveAccountBalances(
  accounts: readonly EconomicAccount[],
  entries: readonly EconomicLedgerEntry[],
): readonly EconomicAccountBalance[] {
  return accounts.map((account) => ({
    accountId: account.id,
    organizationScopeId: account.organizationScopeId,
    ownerPersonId: account.ownerPersonId,
    kind: account.kind,
    unit: account.unit,
    balance: normalSideBalance(
      account.kind,
      entries.filter((e) => e.accountId === account.id),
    ),
  }));
}

export type { EconomicAccountKind, EconomicUnitType, AuthorityTransaction };
