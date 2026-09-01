/**
 * NET-W030 shared test harness — external settlement adapters.
 *
 * Extends the NET-W008 harness pattern (the W028 wrap discipline):
 * wraps `createNetW008Harness` (runtime + authenticated principal +
 * organization + allow policies + the verified upstream factories)
 * with the NET-W030 surfaces:
 *  - the external settlement trust channel (default: the TEST trust
 *    key below, clearly marked TEST-ONLY; `unconfigured: true` boots
 *    the runtime with NO provider trust material — ingestion must
 *    fail closed);
 *  - the W030 API guard actions (record / read / reconcile);
 *  - a SECOND organization for cross-tenant (no-oracle) tests;
 *  - the trusted-provider signing helper (the composition root's
 *    `buildExternalSettlementIntegrity` — the TEST-side provider
 *    channel);
 *  - factories: internal ledger lineage (a mature value record), a
 *    signed provider notification payload, and the golden-path
 *    fact-recording flow exactly as the apiCommands execute it.
 */

import { randomUUID } from "node:crypto";
import { createExecutionContext } from "../../src/core/execution-context.ts";
import type { ExecutionContext } from "../../src/core/execution-context.ts";
import type { ExternalSettlementFactRecord } from "../../src/settlement/port.ts";
import {
  buildExternalSettlementIntegrity,
} from "../../src/bootstrap/external-settlement-authentication.ts";
import {
  createNetW008Harness,
  createMatureValue,
  type NetW008Harness,
  type NetW008HarnessOptions,
} from "./_net-w008-harness.ts";

/** TEST-ONLY trust material (clearly marked; never a production secret). */
export const EXTERNAL_SETTLEMENT_TEST_TRUST_KEY = "test-external-settlement-trust-key";

/** A TEST-ONLY WRONG trust key (fail-closed authentication tests). */
export const EXTERNAL_SETTLEMENT_WRONG_TRUST_KEY = "wrong-external-settlement-trust-key";

export interface NetW030HarnessOptions {
  /**
   * Boot the runtime with NO provider trust material — ingestion must
   * fail closed (`unauthenticated`). Default: the test trust key is
   * configured.
   */
  readonly unconfigured?: boolean;
  /** Override the per-provider trust keys entirely. */
  readonly trustKeys?: Readonly<Record<string, string>>;
  /** Forwarded W008 harness options. */
  readonly w008?: NetW008HarnessOptions;
}

export interface NetW030Harness {
  readonly w008: NetW008Harness;
  readonly runtime: NetW008Harness["runtime"];
  readonly bootstrapCtx: ExecutionContext;
  /** The canonical person identity id of the authorized actor. */
  readonly personId: string;
  readonly subjectId: string;
  readonly organizationScopeId: string;
  /** A second organization (cross-tenant, no-oracle tests). */
  readonly secondOrganizationScopeId: string;
  teardown(): Promise<void>;
}

export async function createNetW030Harness(
  opts: NetW030HarnessOptions = {},
): Promise<NetW030Harness> {
  const trustKeys: Record<string, string> | undefined = opts.trustKeys
    ? { ...opts.trustKeys }
    : opts.unconfigured
      ? undefined
      : { reference: EXTERNAL_SETTLEMENT_TEST_TRUST_KEY };
  const w008 = await createNetW008Harness({
    ...(opts.w008 ?? {}),
    adapters: {
      ...(opts.w008?.adapters ?? {}),
      ...(trustKeys !== undefined ? { externalSettlementTrustKeys: trustKeys } : {}),
    },
  });

  // Seed the NET-W030 API guard actions (resource "*").
  const bootstrapCtx = createExecutionContext({
    correlationId: "net-w030-bootstrap",
    actor: { id: "bootstrap", kind: "service" },
  });
  for (const action of [
    "externalSettlementFact.record",
    "externalSettlementFact.read",
    "externalSettlementFact.reconcile",
  ]) {
    await w008.runtime.policyService.createPolicy(bootstrapCtx, {
      subject: "*",
      action,
      resource: "*",
      effect: "allow",
      createdBy: "bootstrap",
    });
  }

  // A second organization in the SAME runtime (cross-tenant tests).
  const secondOrg = await w008.runtime.organizationService.createOrganization(
    bootstrapCtx,
    {
      name: "External Settlement Second Org",
      creatorId: w008.personId,
    },
  );

  return {
    w008,
    runtime: w008.runtime,
    bootstrapCtx,
    personId: w008.personId,
    subjectId: w008.subjectId,
    organizationScopeId: w008.organizationScopeId,
    secondOrganizationScopeId: secondOrg.id,
    async teardown() {
      await w008.teardown();
    },
  };
}

/** Create an execution context for the harness person. */
export function actorCtx(harness: NetW030Harness, correlationId: string): ExecutionContext {
  return createExecutionContext({
    correlationId,
    actor: { id: harness.personId, kind: "person" },
  });
}

// ---------------------------------------------------------------------------
// The trusted provider side (TEST channel) + factories.
// ---------------------------------------------------------------------------

/** The facts a provider notification attests (the signing payload). */
export interface ProviderNotificationFacts {
  readonly externalId: string;
  readonly internalTransactionId: string;
  readonly reportedAmount: number;
  readonly reportedUnit: string;
  readonly observedAt: string;
  readonly correctionOf: string | null;
}

export interface BuildNotificationOptions {
  readonly externalId?: string;
  readonly internalTransactionId: string;
  readonly reportedAmount?: number;
  readonly reportedUnit?: string;
  /** Defaults to now (fresh). */
  readonly observedAt?: string;
  readonly correctionOf?: string | null;
  /** Sign with the WRONG key (fail-closed tests). */
  readonly wrongKey?: boolean;
  /** Omit the integrity envelope entirely. */
  readonly unsigned?: boolean;
  /** Tamper the signature after signing (flip one hex nibble). */
  readonly tampered?: boolean;
}

/**
 * Build a SIGNED raw provider notification payload (the reference
 * provider's `reference/v1` grammar) exactly as a trusted provider
 * channel would emit it. Default trust key: the TEST key; `wrongKey`
 * signs with the wrong key; `unsigned`/`tampered` exercise the
 * fail-closed paths.
 */
export function buildProviderNotification(
  harness: NetW030Harness,
  opts: BuildNotificationOptions,
): Record<string, unknown> {
  const facts: ProviderNotificationFacts = {
    externalId: opts.externalId ?? `ext-txn-${randomUUID()}`,
    internalTransactionId: opts.internalTransactionId,
    reportedAmount: opts.reportedAmount ?? 100,
    reportedUnit: opts.reportedUnit ?? "value",
    observedAt: opts.observedAt ?? new Date().toISOString(),
    correctionOf: opts.correctionOf ?? null,
  };
  let integrity: Record<string, unknown> | undefined;
  if (!opts.unsigned) {
    const key = opts.wrongKey
      ? EXTERNAL_SETTLEMENT_WRONG_TRUST_KEY
      : EXTERNAL_SETTLEMENT_TEST_TRUST_KEY;
    const envelope = buildExternalSettlementIntegrity(
      { provider: "reference", ...facts },
      key,
      new Date().toISOString(),
    );
    let signature = envelope.signature;
    if (opts.tampered) {
      // Flip one hex nibble (a minimal, deterministic tamper).
      const nibble = signature[0] === "0" ? "1" : "0";
      signature = nibble + signature.slice(1);
    }
    integrity = {
      algorithm: envelope.algorithm,
      signature,
      signedAt: envelope.signedAt,
    };
  }
  return {
    externalId: facts.externalId,
    internalTransactionId: facts.internalTransactionId,
    reportedAmount: facts.reportedAmount,
    reportedUnit: facts.reportedUnit,
    observedAt: facts.observedAt,
    correctionOf: facts.correctionOf,
    ...(integrity !== undefined ? { integrity } : {}),
  };
}

/**
 * Create internal ledger lineage: a MATURE value record (verified PoV
 * source) and its recognition transaction. The recognition
 * transaction's per-unit debit total equals the value amount in the
 * `value` unit — the deterministic reconciliation target.
 */
export async function createInternalLineage(
  harness: NetW030Harness,
  amount = 100,
): Promise<{
  readonly valueRecordId: string;
  readonly transactionId: string;
  readonly amount: number;
  readonly unit: "value";
}> {
  const value = await createMatureValue(harness.w008, { amount });
  return {
    valueRecordId: value.id,
    transactionId: value.recognitionTransactionId,
    amount: value.amount,
    unit: "value",
  };
}

export interface RecordFactOptions extends BuildNotificationOptions {
  readonly organizationScopeId?: string;
  readonly idempotencyKey?: string;
}

/** The golden-path fact recording exactly as the apiCommands execute it. */
export async function recordExternalFact(
  harness: NetW030Harness,
  opts: RecordFactOptions,
): Promise<ExternalSettlementFactRecord> {
  const ctx = actorCtx(harness, "net-w030-record");
  const result = await harness.runtime.externalSettlementService.recordExternalSettlementFact(
    ctx,
    {
      organizationScopeId: opts.organizationScopeId ?? harness.organizationScopeId,
      provider: "reference",
      payload: buildProviderNotification(harness, opts),
      idempotencyKey: opts.idempotencyKey ?? `w030-fact-${randomUUID()}`,
    },
  );
  return result.fact;
}

/** Count audit events of one type (atomicity/lineage assertions). */
export async function auditCount(
  harness: NetW030Harness,
  eventType: string,
): Promise<number> {
  const events = await harness.runtime.auditWriter.query({ eventType });
  return events.length;
}
