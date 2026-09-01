/**
 * NET-W008 shared test harness.
 *
 * Extends the NET-W007 harness pattern: runtime + authenticated
 * principal + organization + allow policies for the settlement-layer
 * API guard actions (13 mutation actions) + the per-transition
 * policies seeded from the OPPORTUNITY/CONTRIBUTION/PROOF_OF_VALUE/
 * OUTCOME_MEASUREMENT transition tables (so the harness person can
 * drive contributions, Proofs-of-Value and measured outcomes to
 * VERIFIED — the upstream records economic value references).
 *
 * The harness uses the file-backed PostgresAuthorityShim (test/dev
 * double from NET-W003) so it runs without a real PostgreSQL.
 */

import { createRuntime, type Runtime } from "../../src/bootstrap/runtime.ts";
import { createExecutionContext } from "../../src/core/execution-context.ts";
import type { ExecutionContext } from "../../src/core/execution-context.ts";
import type { LlmPort } from "../../src/llm/port.ts";
import type { ProviderAdapter } from "../../src/core/adapter.ts";
import {
  CONTRIBUTION_TRANSITION_TABLE,
  OPPORTUNITY_TRANSITION_TABLE,
  OUTCOME_MEASUREMENT_TRANSITION_TABLE,
  PROOF_OF_VALUE_TRANSITION_TABLE,
} from "../../src/workflows/transition-table.ts";
import type {
  MeasuredOutcome,
  OutcomeObservation,
} from "../../src/outcomes/port.ts";
import type { Evidence, ProofOfValue } from "../../src/evidence/port.ts";
import type {
  CashObligation,
  CreditIssuance,
  EconomicConversion,
  EconomicValueRecord,
  ExternalSettlementProviderAdapter,
  RewardAllocationPolicy,
} from "../../src/settlement/port.ts";

export interface NetW008Harness {
  readonly runtime: Runtime;
  /** Bootstrap execution context (system actor). */
  readonly bootstrapCtx: ExecutionContext;
  /** The canonical person identity id of the authorized actor. */
  readonly personId: string;
  /** The subject id used by the API auth guard (X-Auth-Subject-Id). */
  readonly subjectId: string;
  /** The organization scope id (the tenant). */
  readonly organizationScopeId: string;
  /** A second person (reward beneficiary / cash counterparty). */
  readonly secondPersonId: string;
  readonly secondSubjectId: string;
  /** Tear down the harness (shutdown the runtime). */
  teardown(): Promise<void>;
}

/**
 * Harness construction options (PR #26 remediation): `llm.providers`
 * is threaded to `createRuntime` so NET-W013 regression tests can
 * inject a RECORDING LlmPort double and assert the exact scoring
 * input the composition root assembles (e.g. that it carries no
 * mention-derived feature — HELP-002). Omitted → the deterministic
 * ECHO reference provider.
 *
 * NET-W023 PR #47 remediation: `adapters.sellerAuthorizationTrustKey`
 * threads the seller-authorization trust channel key into
 * `createRuntime` (the supply-chain verification trust envelope).
 * Omitted → the trust channel is NOT configured (fail closed —
 * no chain can be `verified`).
 *
 * NET-W030: `adapters.externalSettlementProviders` /
 * `adapters.externalSettlementTrustKeys` thread the external
 * settlement adapter doubles + the per-provider trust keys into
 * `createRuntime` (the authenticated external-fact ingestion
 * channel). Omitted keys → the providers' ingestion fails closed
 * (`unauthenticated`).
 */
export interface NetW008HarnessOptions {
  readonly llm?: {
    readonly providers?: readonly (LlmPort & ProviderAdapter)[];
  };
  readonly adapters?: {
    readonly sellerAuthorizationTrustKey?: string;
    readonly externalSettlementProviders?: readonly ExternalSettlementProviderAdapter[];
    readonly externalSettlementTrustKeys?: Readonly<Record<string, string>>;
  };
}

export async function createNetW008Harness(
  opts: NetW008HarnessOptions = {},
): Promise<NetW008Harness> {
  // Compose the adapters options once (seller-authorization trust key
  // + NET-W030 external settlement threading) so no spread can
  // clobber another.
  const adaptersOptions: {
    sellerAuthorizationTrustKey?: string;
    externalSettlementProviders?: readonly ExternalSettlementProviderAdapter[];
    externalSettlementTrustKeys?: Readonly<Record<string, string>>;
  } = {};
  if (opts.adapters?.sellerAuthorizationTrustKey !== undefined) {
    adaptersOptions.sellerAuthorizationTrustKey = opts.adapters.sellerAuthorizationTrustKey;
  }
  if (opts.adapters?.externalSettlementProviders !== undefined) {
    adaptersOptions.externalSettlementProviders = opts.adapters.externalSettlementProviders;
  }
  if (opts.adapters?.externalSettlementTrustKeys !== undefined) {
    adaptersOptions.externalSettlementTrustKeys = opts.adapters.externalSettlementTrustKeys;
  }
  const hasAdapterOptions = Object.keys(adaptersOptions).length > 0;
  const runtime = createRuntime({
    forceEnv: "test",
    env: { APP_ENV: "test", LOG_LEVEL: "warn" },
    port: 0,
    ...(opts.llm?.providers
      ? { llm: { providers: opts.llm.providers } }
      : {}),
    ...(hasAdapterOptions ? { adapters: adaptersOptions } : {}),
  });
  await runtime.initialize();
  await runtime.api.start();
  const bootstrapCtx = createExecutionContext({
    correlationId: "net-w008-bootstrap",
    actor: { id: "bootstrap", kind: "service" },
  });
  // Create the canonical person identity for the authorized actor.
  const person = await runtime.identityService.createIdentity(bootstrapCtx, {
    displayName: "Economic Actor",
    subjectReferences: [{ subjectId: "econ-actor@example.com", providerKind: "internal" }],
  });
  const secondPerson = await runtime.identityService.createIdentity(bootstrapCtx, {
    displayName: "Economic Beneficiary",
    subjectReferences: [{ subjectId: "econ-beneficiary@example.com", providerKind: "internal" }],
  });
  // Create an organization the actor will act in.
  const org = await runtime.organizationService.createOrganization(bootstrapCtx, {
    name: "Economic Org",
    creatorId: person.id,
  });

  // Seed ALLOW policies:
  //  - API guard actions for the NET-W008 endpoints (resource "*").
  //  - Per-transition policies scoped to the HARNESS PERSON so
  //    upstream records (contributions, PoVs, measured outcomes) can
  //    be driven to VERIFIED.
  const guardActions = [
    "opportunity.create",
    "contribution.create",
    "workflow.transition",
    "evidence.create",
    "outcomeClaim.create",
    "attestation.create",
    "proofOfValue.create",
    "proofOfValue.attachEvidence",
    "proofOfValue.aggregate",
    "proofOfValue.attest",
    "outcomeObservation.create",
    "measuredOutcome.create",
    "measuredOutcome.recordRollup",
    "economicValue.create",
    "economicValue.mature",
    "economicValue.reverse",
    "creditIssuance.create",
    "creditIssuance.reverse",
    "rewardPolicy.create",
    "rewardAllocation.create",
    "rewardAllocation.reverse",
    "cashObligation.create",
    "cashObligation.settle",
    "cashObligation.reverse",
    "conversion.create",
    "conversion.reverse",
  ];
  for (const action of guardActions) {
    await runtime.policyService.createPolicy(bootstrapCtx, {
      subject: "*",
      action,
      resource: "*",
      effect: "allow",
      createdBy: "bootstrap",
    });
  }
  for (const rule of [
    ...OPPORTUNITY_TRANSITION_TABLE,
    ...CONTRIBUTION_TRANSITION_TABLE,
    ...PROOF_OF_VALUE_TRANSITION_TABLE,
    ...OUTCOME_MEASUREMENT_TRANSITION_TABLE,
  ]) {
    await runtime.policyService.createPolicy(bootstrapCtx, {
      subject: person.id,
      action: rule.policyAction,
      resource: org.id,
      effect: "allow",
      createdBy: "bootstrap",
    });
  }

  return {
    runtime,
    bootstrapCtx,
    personId: person.id,
    subjectId: "econ-actor@example.com",
    organizationScopeId: org.id,
    secondPersonId: secondPerson.id,
    secondSubjectId: "econ-beneficiary@example.com",
    async teardown() {
      await runtime.shutdown();
    },
  };
}

/** Create an execution context for the harness person. */
export function actorCtx(harness: NetW008Harness, correlationId: string): ExecutionContext {
  return createExecutionContext({
    correlationId,
    actor: { id: harness.personId, kind: "person" },
  });
}

// ---------------------------------------------------------------------------
// Upstream record factories (evidence / contribution / PoV / measured
// outcome) — the verified records economic value references.
// ---------------------------------------------------------------------------

export interface CreateEvidenceOptions {
  readonly sourceType?: "platform" | "attested" | "provider" | "model" | "self";
  readonly sourceId?: string;
  readonly point?: number;
}

export async function createEvidence(
  harness: NetW008Harness,
  opts: CreateEvidenceOptions = {},
): Promise<Evidence> {
  const ctx = actorCtx(harness, "w008-evidence");
  return harness.runtime.evidenceService.createEvidence(ctx, {
    organizationScopeId: harness.organizationScopeId,
    ownerId: harness.personId,
    subjectReference: { subjectId: harness.personId, subjectType: "contribution" },
    provenance: {
      sourceType: opts.sourceType ?? "platform",
      ...(opts.sourceId !== undefined ? { sourceId: opts.sourceId } : {}),
      method: "instrumentation",
    },
    confidence: { point: opts.point ?? 0.9 },
  });
}

/** Create an opportunity + contribution (DRAFT). */
export async function createContribution(harness: NetW008Harness): Promise<{
  id: string;
  organizationScopeId: string;
}> {
  const oppCtx = actorCtx(harness, "w008-contribution-opp");
  const opp = await harness.runtime.opportunityService.createOpportunity(oppCtx, {
    organizationScopeId: harness.organizationScopeId,
    ownerId: harness.personId,
    opportunityType: "test-opportunity",
    title: "Economic Opportunity",
    brief: { kind: "test" },
  });
  const cCtx = actorCtx(harness, "w008-contribution");
  const c = await harness.runtime.contributionService.createContribution(cCtx, {
    opportunityId: opp.id,
    contributorId: harness.personId,
    organizationScopeId: harness.organizationScopeId,
    contributionType: "test-contribution",
    submission: { kind: "test" },
  });
  return { id: c.id, organizationScopeId: c.organizationScopeId };
}

/**
 * Create a VERIFIED Proof-of-Value (evidence → PoV → transitions →
 * aggregation → attestation → verify). Returns the verified PoV.
 */
export async function createVerifiedPoV(harness: NetW008Harness): Promise<ProofOfValue> {
  const subject = await createContribution(harness);
  const eMeasured = await createEvidence(harness, { sourceType: "platform", sourceId: "inst-a" });
  const eProvider = await createEvidence(harness, { sourceType: "provider", sourceId: "provider-x" });
  const ctx = actorCtx(harness, "w008-pov");
  const proof = await harness.runtime.proofOfValueService.createProofOfValue(ctx, {
    organizationScopeId: harness.organizationScopeId,
    ownerId: harness.personId,
    subjectReference: { subjectId: subject.id, subjectType: "contribution" },
    evidenceIds: [eMeasured.id, eProvider.id],
  });
  const t = (version: number, key: string) => ({
    proofId: proof.id,
    expectedVersion: version,
    idempotencyKey: `w008-pov-${key}`,
    actorPersonId: harness.personId,
  });
  await harness.runtime.proofOfValueService.beginMeasuring(ctx, t(0, "begin"));
  const attestation = await harness.runtime.attestationService.createAttestation(ctx, {
    organizationScopeId: harness.organizationScopeId,
    verifierId: harness.personId,
    statement: "Independently reviewed the attached evidence.",
    evidenceIds: [eMeasured.id, eProvider.id],
  });
  await harness.runtime.proofOfValueService.attachAttestation(ctx, proof.id, attestation.id);
  await harness.runtime.proofOfValueService.completeEvidenceGathering(ctx, t(1, "evaluating"));
  await harness.runtime.proofOfValueService.aggregateEvidence(ctx, proof.id);
  const verified = await harness.runtime.proofOfValueService.verify(ctx, t(2, "verify"));
  return verified.proof;
}

/**
 * Create a VERIFIED measured outcome (immediate maturation). Returns
 * the verified measured outcome.
 */
export async function createVerifiedMeasuredOutcome(
  harness: NetW008Harness,
): Promise<MeasuredOutcome> {
  const subject = await createContribution(harness);
  const ctx = actorCtx(harness, "w008-measurement");
  const observation: OutcomeObservation =
    await harness.runtime.outcomeObservationService.createOutcomeObservation(ctx, {
      organizationScopeId: harness.organizationScopeId,
      observerId: harness.personId,
      subjectReference: { subjectId: subject.id, subjectType: "contribution" },
      outcomeType: "install",
      observedValue: { value: 12, unit: "installs" },
      confidence: { point: 0.95 },
      provenance: {
        sourceType: "platform",
        sourceId: "inst-a",
        method: "platform-counter",
        methodVersion: "1.0.0",
      },
    });
  const measurement = await harness.runtime.measuredOutcomeService.createMeasuredOutcome(ctx, {
    organizationScopeId: harness.organizationScopeId,
    ownerId: harness.personId,
    subjectReference: { subjectId: subject.id, subjectType: "contribution" },
    outcomeType: "install",
    maturation: { strategy: "immediate" },
    observationIds: [observation.id],
  });
  await harness.runtime.measuredOutcomeService.beginMaturation(ctx, {
    measurementId: measurement.id,
    expectedVersion: 0,
    idempotencyKey: `w008-mo-begin-${measurement.id}`,
    actorPersonId: harness.personId,
  });
  await harness.runtime.measuredOutcomeService.recordMeasurementRollup(ctx, measurement.id);
  const result = await harness.runtime.measuredOutcomeService.finalize(ctx, {
    measurementId: measurement.id,
    expectedVersion: 1,
    idempotencyKey: `w008-mo-finalize-${measurement.id}`,
    actorPersonId: harness.personId,
  });
  return result.measurement;
}

// ---------------------------------------------------------------------------
// Economic factories (value records / issuances / policies / cash).
// ---------------------------------------------------------------------------

export interface RecordValueOptions {
  readonly amount?: number;
  readonly sources?: readonly { kind: string; id: string }[];
  readonly maturation?: { strategy: string; windowEndAt?: string };
  readonly beneficiaryPersonId?: string;
  readonly idempotencyKey?: string;
  readonly description?: string;
}

/**
 * Record pending value for the harness person. By default the record
 * references a fresh VERIFIED PoV (immediate maturation).
 */
export async function createPendingValue(
  harness: NetW008Harness,
  opts: RecordValueOptions = {},
): Promise<EconomicValueRecord> {
  const pov = await createVerifiedPoV(harness);
  const ctx = actorCtx(harness, "w008-value");
  const result = await harness.runtime.economicValueService.recordPendingValue(ctx, {
    organizationScopeId: harness.organizationScopeId,
    beneficiaryPersonId: opts.beneficiaryPersonId ?? harness.personId,
    amount: opts.amount ?? 100,
    sources: opts.sources ?? [{ kind: "proof_of_value", id: pov.id }],
    ...(opts.maturation !== undefined ? { maturation: opts.maturation } : {}),
    ...(opts.description !== undefined ? { description: opts.description } : {}),
    idempotencyKey: opts.idempotencyKey ?? `w008-value-${pov.id}`,
  });
  return result.value;
}

/** Record + mature a value record (immediate strategy default). */
export async function createMatureValue(
  harness: NetW008Harness,
  opts: RecordValueOptions = {},
): Promise<EconomicValueRecord> {
  const pending = await createPendingValue(harness, opts);
  const ctx = actorCtx(harness, "w008-mature");
  return harness.runtime.economicValueService.matureValue(ctx, {
    valueRecordId: pending.id,
    idempotencyKey: `w008-mature-${pending.id}`,
  });
}

/** The default reward policy: 60/40 split between the two harness people. */
export async function createDefaultRewardPolicy(
  harness: NetW008Harness,
  policyId = "reward-policy-w008-default",
): Promise<RewardAllocationPolicy> {
  const ctx = actorCtx(harness, "w008-reward-policy");
  return harness.runtime.rewardPolicyService.createPolicyVersion(ctx, {
    organizationScopeId: harness.organizationScopeId,
    policyId,
    version: 1,
    description: "NET-W008 test reward policy",
    allocations: [
      { beneficiaryPersonId: harness.personId, weight: 3 },
      { beneficiaryPersonId: harness.secondPersonId, weight: 2 },
    ],
  });
}

/** Issue credits against a mature value record at rate 1 (default). */
export async function issueDefaultCredits(
  harness: NetW008Harness,
  sourceValueRecordId: string,
  creditsPerValueUnit = 1,
): Promise<CreditIssuance> {
  const ctx = actorCtx(harness, "w008-issue");
  const result = await harness.runtime.creditService.issueCredits(ctx, {
    organizationScopeId: harness.organizationScopeId,
    beneficiaryPersonId: harness.personId,
    sourceValueRecordId,
    creditsPerValueUnit,
    idempotencyKey: `w008-issue-${sourceValueRecordId}`,
  });
  return result.issuance;
}

/** Record a payable cash obligation to the harness person. */
export async function createPayable(
  harness: NetW008Harness,
  amount = 50,
): Promise<CashObligation> {
  const ctx = actorCtx(harness, "w008-payable");
  const result = await harness.runtime.cashService.recordCashObligation(ctx, {
    organizationScopeId: harness.organizationScopeId,
    kind: "payable",
    counterpartyPersonId: harness.personId,
    amount,
    idempotencyKey: `w008-payable-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
  });
  return result.obligation;
}

/** Record a cash_to_credits conversion for the harness person. */
export async function createConversion(
  harness: NetW008Harness,
  cashAmount: number,
  creditsAmount: number,
): Promise<EconomicConversion> {
  const ctx = actorCtx(harness, "w008-conversion");
  const result = await harness.runtime.conversionService.recordConversion(ctx, {
    organizationScopeId: harness.organizationScopeId,
    personId: harness.personId,
    direction: "cash_to_credits",
    cashAmount,
    creditsAmount,
    idempotencyKey: `w008-conversion-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
  });
  return result.conversion;
}

/**
 * Assert global conservation over the whole ledger: every unit's
 * Σdebit === Σcredit across ALL committed entries (the pure helper in
 * src/settlement/ledger.ts), plus every account balance ≥ 0. Used by
 * the AC suites to prove no value/credit was created or destroyed.
 */
export async function assertGlobalConservation(
  harness: NetW008Harness,
): Promise<void> {
  const { assertGlobalConservation: assert } = await import("../../src/settlement/ledger.ts");
  const records = await harness.runtime.postgresAuthority.scan<{
    id: string;
    transactionId: string;
    accountId: string;
    accountKind: string;
    organizationScopeId: string;
    ownerPersonId: string | null;
    direction: string;
    amount: number;
    unit: string;
    recordedAt: string;
  }>("economic_ledger_entries");
  assert(records.map((r) => r.value) as never);
  for (const balance of await harness.runtime.economicLedgerService.listAccountBalances(
    harness.bootstrapCtx,
    harness.organizationScopeId,
  )) {
    if (balance.balance < 0) {
      throw new Error(
        `account ${balance.accountId} (${balance.kind}) has a negative balance ${balance.balance}`,
      );
    }
  }
}

/** Fixed reference timestamps for deterministic assertions. */
export const BEFORE_WINDOW = "2024-01-01T00:00:00.000Z";
export const WINDOW_END = "2024-06-01T00:00:00.000Z";
export const AFTER_WINDOW = "2024-07-01T00:00:00.000Z";
