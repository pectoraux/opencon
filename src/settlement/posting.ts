/**
 * Ledger posting layer — the shared internal helper every economic
 * command uses to post immutable, balanced ledger transactions inside
 * the authoritative transaction opened by the IdempotencyStore
 * (NET-W008 work order §3.2).
 *
 * Concurrency model (why the account locks exist):
 *  - Every posting that REDUCES an account (a debit on a credit-normal
 *    obligation account, or a credit on a debit-normal protocol/
 *    receivable account) is balance-checked against the account's
 *    entry set. Two concurrent transactions posting against the SAME
 *    account both read the same committed base — without
 *    serialization each could pass its individual check while the
 *    combined postings overdraw the account (phantom value). The
 *    posting layer therefore serializes per ACCOUNT: every command
 *    acquires the account locks for every account it posts to (in a
 *    globally sorted order) BEFORE its idempotent apply, so a queued
 *    command's in-transaction balance read always observes the prior
 *    poster's COMMITTED entries. This is the same monolith
 *    serialization contract as IdempotencyStore.withLock — the
 *    documented stand-in for PostgreSQL `SELECT … FOR UPDATE` row
 *    locking on the account row (a real deployment would lock the
 *    account row / use serializable isolation; the mutex is the
 *    single-process modular monolith's equivalent, and every economic
 *    mutation flows through the ONE runtime-wired store instance).
 *  - LOCK ORDERING (deadlock freedom): every command acquires
 *      1. its domain-record lock (if any) — `economic_value_record:{id}`,
 *         `economic_cash_obligation:{id}` — then
 *      2. its account locks, acquired in ascending account-id order.
 *    The two key spaces are disjoint, every command touches at most
 *    ONE domain record, and account locks are always acquired after
 *    any record lock and always in the same global order — no wait
 *    cycle can form.
 *
 * Conservation is mechanical (work order §4 invariant 3):
 *  1. validatePostings — per-unit Σdebit === Σcredit (scaled
 *     integers) BEFORE anything is persisted;
 *  2. assertNonNegativeAfterPostings — every affected account's
 *     post-balance stays ≥ 0 (no value/credit creation or destruction
 *     outside authorized entries);
 *  3. entries are persisted ONCE and never updated — balances are
 *     always derived from the immutable entry set.
 */

import { randomUUID } from "node:crypto";
import type { TransactionalAuditWriter } from "../core/audit.ts";
import type { ExecutionContext } from "../core/execution-context.ts";
import type { IdempotencyStore } from "../core/idempotency.ts";
import type { AuthorityTransaction } from "../core/postgres-authority.ts";
import type {
  EconomicAccount,
  EconomicLedgerEntry,
  EconomicLedgerRepository,
  EconomicLedgerTransaction,
  EconomicPostingInput,
  PostLedgerTransactionInput,
} from "./port.ts";
import {
  assertNonNegativeAfterPostings,
  economicAccountId,
  validatePostings,
} from "./ledger.ts";

/** The account-scoped serialization lock key for an account id. */
export function accountLockKey(accountId: string): string {
  return `economic_ledger_account:${accountId}`;
}

/** The per-record serialization lock key for an economic value record. */
export function valueRecordLockKey(valueRecordId: string): string {
  return `economic_value_record:${valueRecordId}`;
}

/** The per-record serialization lock key for a cash obligation. */
export function cashObligationLockKey(obligationId: string): string {
  return `economic_cash_obligation:${obligationId}`;
}

/**
 * Acquire an optional domain-record lock, then every distinct account
 * lock in ascending account-id order, then run `fn`. All locks are
 * held until `fn` settles (including internal transaction commits).
 */
export async function withEconomicLocks<T>(
  idempotency: IdempotencyStore,
  accountIds: readonly string[],
  fn: () => Promise<T>,
  recordLockKey?: string,
): Promise<T> {
  const run = async (keys: readonly string[]): Promise<T> => {
    if (keys.length === 0) return fn();
    const [head, ...rest] = keys;
    return idempotency.withLock(head!, () => run(rest));
  };
  const accountKeys = [...new Set(accountIds)]
    .sort()
    .map((accountId) => accountLockKey(accountId));
  const allKeys = recordLockKey ? [recordLockKey, ...accountKeys] : accountKeys;
  return run(allKeys);
}

/**
 * Ensure an account exists (deterministic id — provisioning is
 * idempotent by construction; a tenant can never hold duplicate
 * accounts for one role) and return it.
 */
export async function ensureAccountWithinTx(
  tx: AuthorityTransaction,
  organizationScopeId: string,
  ownerPersonId: string | null,
  kind: EconomicAccount["kind"],
  unit: EconomicAccount["unit"],
  repository: EconomicLedgerRepository,
): Promise<EconomicAccount> {
  const id = economicAccountId(organizationScopeId, ownerPersonId, kind, unit);
  const existing = await repository.findAccountWithinTx(
    organizationScopeId,
    ownerPersonId,
    kind,
    unit,
    tx,
  );
  if (existing) return existing;
  const account: EconomicAccount = {
    id,
    organizationScopeId,
    ownerPersonId,
    kind,
    unit,
    createdAt: new Date().toISOString(),
  };
  return repository.createAccountWithinTx(account, tx);
}

/**
 * Post a ledger transaction inside the caller's authoritative
 * transaction:
 *  1. validate the postings balance per unit;
 *  2. ensure every referenced account exists;
 *  3. balance-check every affected account against its existing
 *     (transaction-visible) entry set + the new postings;
 *  4. persist the immutable transaction + entries.
 *
 * Returns the persisted transaction (entries included).
 */
export async function postLedgerTransactionWithinTx(
  tx: AuthorityTransaction,
  execution: ExecutionContext,
  input: PostLedgerTransactionInput,
  repository: EconomicLedgerRepository,
): Promise<EconomicLedgerTransaction> {
  // 1. Mechanical per-unit conservation (throws on imbalance).
  validatePostings(input.entries);

  // 2. Ensure the accounts exist (deterministic ids — idempotent).
  const accounts = new Map<string, EconomicAccount>();
  for (const posting of input.entries) {
    const accountId = economicAccountId(
      input.organizationScopeId,
      posting.ownerPersonId,
      posting.accountKind,
      posting.unit,
    );
    if (accountId !== posting.accountId) {
      throw new Error(
        `internal ledger error: posting account id ${posting.accountId} does not match the deterministic key ${accountId}`,
      );
    }
    if (!accounts.has(accountId)) {
      accounts.set(
        accountId,
        await ensureAccountWithinTx(
          tx,
          input.organizationScopeId,
          posting.ownerPersonId,
          posting.accountKind,
          posting.unit,
          repository,
        ),
      );
    }
  }

  // 3. Balance-check every affected account (post-balance ≥ 0 — the
  //    conservation guard that rejects overdrafts).
  const postingsByAccount = new Map<string, EconomicPostingInput[]>();
  for (const posting of input.entries) {
    const bucket = postingsByAccount.get(posting.accountId) ?? [];
    bucket.push(posting);
    postingsByAccount.set(posting.accountId, bucket);
  }
  for (const [accountId, postings] of postingsByAccount) {
    const existing = await repository.listEntriesForAccountWithinTx(accountId, tx);
    assertNonNegativeAfterPostings(
      postings[0]!.accountKind,
      accountId,
      existing,
      postings,
    );
  }

  // 4. Persist the immutable transaction + entries.
  const transactionId = randomUUID();
  const recordedAt = new Date().toISOString();
  const entries: EconomicLedgerEntry[] = input.entries.map((posting) => ({
    id: randomUUID(),
    transactionId,
    accountId: posting.accountId,
    accountKind: posting.accountKind,
    organizationScopeId: input.organizationScopeId,
    ownerPersonId: posting.ownerPersonId,
    direction: posting.direction,
    amount: posting.amount,
    unit: posting.unit,
    recordedAt,
  }));
  const transaction: EconomicLedgerTransaction = {
    id: transactionId,
    organizationScopeId: input.organizationScopeId,
    kind: input.kind,
    description: input.description?.trim() || null,
    subject: input.subject ?? null,
    entries,
    recordedAt,
    idempotencyKey: input.idempotencyKey,
    executionId: execution.executionId,
    correlationId: execution.correlationId,
    causationId: execution.causationId,
  };
  return repository.createTransactionWithinTx(transaction, tx);
}

/** Shared dependency bundle for the economic services. */
export interface EconomicServiceDeps {
  readonly ledgerRepository: EconomicLedgerRepository;
  readonly idempotency: IdempotencyStore;
  readonly auditWriter: TransactionalAuditWriter;
  readonly logger: {
    info(message: string, fields?: Record<string, unknown>): void;
    debug(message: string, fields?: Record<string, unknown>): void;
  };
}
