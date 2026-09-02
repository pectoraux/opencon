/**
 * NET-W032 shared test harness — decentralized validation/dispute
 * coordination (issue #65).
 *
 * Wraps the NET-W010 harness (runtime + persons + organizations + the
 * W008/W009/W010 guard actions + the credit/subject factories) and
 * adds:
 *  - the thirteen NET-W032 guard actions (validationPolicy.*,
 *    validator.*, validation.*; subject "*" resource "*");
 *  - FIVE registered validator persons (persons 1-5, distinct from
 *    the subject person, the challenger and the reviewer — the
 *    conflict-of-interest tests need an unbiased pool);
 *  - a default quorum policy v1 (cardinality 3, minimumSubmitted 2,
 *    upholdThreshold 2, rejectThreshold 2, window 14d, stake 0)
 *    created through the validation policy service;
 *  - a reputation-proof target factory (the W031 chain through the
 *    OWNERS' services: reputation policy → evidence → verified input
 *    → snapshot → proof issuance — never direct store writes);
 *  - a W029 signed-attestation evidence factory (covering a platform
 *    evidence record through the evidence authority's own service);
 *  - the service-level round factories (open + derive + observe +
 *    derive outcome) and deterministic timestamp helpers
 *    (anchor-relative shifts — never a wall clock);
 *  - an economic-variant policy factory (validator stake requirement
 *    10 credits — the AC-08 flows pre-issue credits for validators).
 *
 * The harness uses the file-backed PostgresAuthorityShim (test/dev
 * double from NET-W003) so it runs without a real PostgreSQL; the API
 * server is started (the W008 harness does it) for the HTTP
 * round-trip tests.
 */

import { randomUUID } from "node:crypto";
import type { ExecutionContext } from "../../src/core/execution-context.ts";
import { createExecutionContext } from "../../src/core/execution-context.ts";
import type { ReputationProof } from "../../src/reputation/port.ts";
import type { SignedAttestation } from "../../src/evidence/port.ts";
import type {
  ValidationChallenge,
  ValidationObservation,
  ValidationOutcome,
  ValidatorParticipant,
} from "../../src/disputes/port.ts";
import {
  createNetW010Harness,
  personCtx as w010PersonCtx,
  challengerCtx as w010ChallengerCtx,
  type NetW010Harness,
} from "./_net-w010-harness.ts";
import { DEFAULT_POLICY_RULES } from "../reputation/_net-w007-harness.ts";
import { ensureCreditsFor } from "./_net-w010-harness.ts";

/** The deterministic default quorum policy shape (the harness default). */
export const DEFAULT_QUORUM_SHAPE = {
  assignmentCardinality: 3,
  minimumSubmitted: 2,
  upholdThreshold: 2,
  rejectThreshold: 2,
  challengeWindowMs: 14 * 24 * 60 * 60 * 1000,
  validatorStakeRequirementCredits: 0,
} as const;

export interface NetW032Harness {
  /** The wrapped NET-W010 harness (all its factories work unchanged). */
  readonly w010: NetW010Harness;
  readonly runtime: NetW010Harness["runtime"];
  readonly bootstrapCtx: ExecutionContext;
  /** The proof SUBJECT person (the challenged person). */
  readonly personId: string;
  /** The default challenge INITIATOR (a different person). */
  readonly challengerPersonId: string;
  /** The W010 reviewer (never a validator here). */
  readonly reviewerPersonId: string;
  /** The five registered validator persons (registration order). */
  readonly validatorPersonIds: readonly string[];
  /** The validators' auth subject ids (emails; HTTP tests). */
  readonly validatorSubjectIds: readonly string[];
  /**
   * The validator pool in the FROZEN deterministic selection order
   * ((registeredAt, id) — the repository sort the assignment derivation
   * consumes; equals the registration order EXCEPT when registeredAt
   * timestamps tie and the id tie-break applies).
   */
  readonly orderedValidatorPersonIds: readonly string[];
  /** The default quorum policy lineage id (created in the main org). */
  readonly defaultPolicyId: string;
  readonly organizationScopeId: string;
  readonly secondOrgId: string;
  readonly secondOrgPersonId: string;
  teardown(): Promise<void>;
}

export async function createNetW032Harness(
  opts: { readonly validatorCount?: number; readonly withStakePolicy?: boolean } = {},
): Promise<NetW032Harness> {
  const w010 = await createNetW010Harness();
  const runtime = w010.runtime;
  const bootstrapCtx = w010.bootstrapCtx;

  // Seed ALLOW policies for the NET-W032 guard actions (subject "*":
  // any authenticated principal with an allow policy can call; tenant
  // scoping and conflict gates are enforced by the services — the same
  // convention as the W007/W010/W031 harnesses).
  const guardActions = [
    "validationPolicy.create",
    "validator.create",
    "validator.read",
    "validator.suspend",
    "validation.challenge.create",
    "validation.challenge.read",
    "validation.challenge.markConflict",
    "validation.assignment.derive",
    "validation.assignment.bond",
    "validation.observation.create",
    "validation.outcome.derive",
    "validation.outcome.apply",
    "validation.outcome.read",
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

  // Five fresh validator persons (distinct from the subject, the
  // challenger and the reviewer) registered through the registry
  // service (the server-bound identity: each registers THEMSELVES).
  const validatorCount = opts.validatorCount ?? 5;
  const validatorPersonIds: string[] = [];
  const validatorSubjectIds: string[] = [];
  for (let i = 0; i < validatorCount; i += 1) {
    const subjectId = `w032-validator-${i}-${randomUUID().slice(0, 8)}@example.com`;
    const person = await runtime.identityService.createIdentity(bootstrapCtx, {
      displayName: `W032 Validator ${i + 1}`,
      subjectReferences: [{ subjectId, providerKind: "internal" }],
    });
    const ctx = createExecutionContext({
      correlationId: "w032-register",
      actor: { id: person.id, kind: "person" },
    });
    await runtime.validatorRegistryService.registerValidator(ctx, {
      organizationScopeId: w010.organizationScopeId,
      personId: person.id,
      idempotencyKey: `w032-register-${person.id}`,
    });
    validatorPersonIds.push(person.id);
    validatorSubjectIds.push(subjectId);
  }
  // The frozen deterministic selection order (registeredAt, id) as
  // the assignment derivation will see it (the id tie-break applies
  // when registration timestamps tie — the same-millisecond case).
  const ordered = await runtime.validatorRegistryService.listValidators(
    bootstrapCtx,
    w010.organizationScopeId,
    "ACTIVE",
  );
  const orderedValidatorPersonIds = ordered.map((v) => v.personId);

  // The default quorum policy (v1) in the main org.
  const defaultPolicyId = `w032-policy-${randomUUID()}`;
  await runtime.validationPolicyService.createPolicyVersion(bootstrapCtx, {
    organizationScopeId: w010.organizationScopeId,
    policyId: defaultPolicyId,
    version: 1,
    description: "NET-W032 harness default quorum policy",
    ...DEFAULT_QUORUM_SHAPE,
  });

  return {
    w010,
    runtime,
    bootstrapCtx,
    personId: w010.personId,
    challengerPersonId: w010.challengerPersonId,
    reviewerPersonId: w010.reviewerPersonId,
    validatorPersonIds,
    validatorSubjectIds,
    orderedValidatorPersonIds,
    defaultPolicyId,
    organizationScopeId: w010.organizationScopeId,
    secondOrgId: w010.secondOrgId,
    secondOrgPersonId: w010.secondOrgPersonId,
    async teardown() {
      await w010.teardown();
    },
  };
}

/** An execution context for a specific person. */
export function personCtx(
  harness: NetW032Harness,
  personId: string,
  correlationId: string,
): ExecutionContext {
  return w010PersonCtx(harness.w010, personId, correlationId);
}

/** The default challenge initiator's context. */
export function initiatorCtx(
  harness: NetW032Harness,
  correlationId: string,
): ExecutionContext {
  return w010ChallengerCtx(harness.w010, correlationId);
}

/** Validator i's context (0-based). */
export function validatorCtx(
  harness: NetW032Harness,
  index: number,
  correlationId: string,
): ExecutionContext {
  return personCtx(harness, harness.validatorPersonIds[index]!, correlationId);
}

/** A random idempotency key (per-call uniqueness). */
export function key(prefix: string): string {
  return `${prefix}-${randomUUID()}`;
}

/** Deterministic ISO timestamp shift (ms from a base timestamp). */
export function shiftIso(iso: string, ms: number): string {
  return new Date(Date.parse(iso) + ms).toISOString();
}

// ---------------------------------------------------------------------------
// Target + evidence factories (through the OWNERS' services).
// ---------------------------------------------------------------------------

/**
 * Seed a fresh W031 portable reputation proof TARGET for the harness
 * person (a distinct policy lineage + one verified input + snapshot +
 * issued proof, all through the owners' services). Returns the proof
 * and the platform evidence record (the attestation coverage anchor).
 */
export async function seedProofTarget(
  harness: NetW032Harness,
  opts: { readonly subjectPersonId?: string } = {},
): Promise<{
  readonly proof: ReputationProof;
  readonly evidenceId: string;
}> {
  const ctx = personCtx(harness, harness.personId, "w032-seed");
  const organizationScopeId = harness.organizationScopeId;
  const subjectPersonId = opts.subjectPersonId ?? harness.personId;

  const policyId = `policy-w032-${randomUUID()}`;
  await harness.runtime.reputationPolicyService.createPolicyVersion(ctx, {
    organizationScopeId,
    policyId,
    version: 1,
    description: "NET-W032 test policy",
    rules: DEFAULT_POLICY_RULES,
  });

  const evidence = await harness.runtime.evidenceService.createEvidence(ctx, {
    organizationScopeId,
    ownerId: subjectPersonId,
    subjectReference: { subjectId: subjectPersonId, subjectType: "contribution" },
    provenance: { sourceType: "platform", method: "instrumentation" },
    confidence: { point: 0.9 },
  });
  await harness.runtime.reputationInputService.recordInput(ctx, {
    organizationScopeId,
    subjectPersonId,
    dimension: "helpfulness",
    sources: [{ kind: "evidence", id: evidence.id }],
    occurredAt: "2024-06-01T00:00:00.000Z",
    idempotencyKey: key("w032-input"),
  });
  const snapshot = await harness.runtime.reputationSnapshotService.recordSnapshot(ctx, {
    organizationScopeId,
    subjectPersonId,
    policyId,
    version: 1,
    referenceAt: "2024-07-01T00:00:00.000Z",
    idempotencyKey: key("w032-snapshot"),
  });
  const issued = await harness.runtime.reputationProofService.issueProof(ctx, {
    organizationScopeId,
    subjectPersonId,
    snapshotId: snapshot.snapshot.id,
    idempotencyKey: key("w032-proof"),
  });
  return { proof: issued.proof, evidenceId: evidence.id };
}

/**
 * Create a W029 signed attestation covering a platform evidence
 * record (through the evidence authority's own service) — an opaque
 * integrity reference for observations.
 */
export async function createAttestation(
  harness: NetW032Harness,
  evidenceId: string,
): Promise<SignedAttestation> {
  const ctx = personCtx(harness, harness.reviewerPersonId, "w032-attest");
  const result = await harness.runtime.signedAttestationService.createSignedAttestation(ctx, {
    organizationScopeId: harness.organizationScopeId,
    verifierId: harness.reviewerPersonId,
    statement: "independent integrity attestation for validation evidence",
    coverage: [{ family: "evidence", recordId: evidenceId }],
    idempotencyKey: key("w032-attestation"),
  });
  return result.attestation;
}

// ---------------------------------------------------------------------------
// Round factories (service level).
// ---------------------------------------------------------------------------

export interface OpenChallengeOptions {
  readonly targetKind?: string;
  readonly targetId?: string;
  readonly policyId?: string;
  readonly effectiveAt?: string;
  readonly statement?: string;
  readonly reasonCodes?: readonly string[];
  readonly initiatorPersonId?: string;
  readonly rechallengeOfChallengeId?: string;
  readonly organizationScopeId?: string;
  readonly idempotencyKey?: string;
  /** A pre-seeded proof to challenge (default: a fresh one). */
  readonly proof?: ReputationProof;
  /** The pre-seeded proof's platform evidence id (attestation anchor). */
  readonly evidenceId?: string;
}

/**
 * Open a validation challenge as the default initiator over a target
 * (default: a fresh W031 reputation proof). Returns the OPEN round
 * plus the seeded target context (proof + evidence id) for evidence
 * references.
 */
export async function openDefaultChallenge(
  harness: NetW032Harness,
  opts: OpenChallengeOptions = {},
): Promise<{
  readonly challenge: ValidationChallenge;
  readonly proof: ReputationProof;
  readonly evidenceId: string;
}> {
  const targetKind = opts.targetKind ?? "reputation_proof";
  // Seed a fresh proof target ONLY when the round challenges one.
  const seeded =
    targetKind === "reputation_proof" && opts.targetId === undefined
      ? await seedProofTarget(harness)
      : {
          proof: (opts.proof ?? null) as ReputationProof | null,
          evidenceId: opts.evidenceId ?? "",
        };
  const targetId =
    opts.targetId ??
    (targetKind === "reputation_proof" ? (seeded.proof as ReputationProof).id : "unknown");
  const effectiveAt =
    opts.effectiveAt ??
    (targetKind === "reputation_proof" && seeded.proof !== null
      ? shiftIso((seeded.proof as ReputationProof).issuedAt, 3600_000)
      : new Date().toISOString());
  const ctx =
    opts.initiatorPersonId !== undefined
      ? personCtx(harness, opts.initiatorPersonId, "w032-open")
      : initiatorCtx(harness, "w032-open");
  const result = await harness.runtime.validationService.openChallenge(ctx, {
    organizationScopeId: opts.organizationScopeId ?? harness.organizationScopeId,
    target: { kind: targetKind, id: targetId },
    statement: opts.statement ?? "the challenged proof misstates the subject's standing",
    reasonCodes: opts.reasonCodes ?? ["contested_claim"],
    effectiveAt,
    policyId: opts.policyId ?? harness.defaultPolicyId,
    ...(opts.rechallengeOfChallengeId !== undefined
      ? { rechallengeOfChallengeId: opts.rechallengeOfChallengeId }
      : {}),
    idempotencyKey: opts.idempotencyKey ?? key("w032-open"),
  });
  return {
    challenge: result.challenge,
    proof: seeded.proof as ReputationProof,
    evidenceId: seeded.evidenceId,
  };
}

/** Derive the assignment set (default anchor: effectiveAt + 1h). */
export async function deriveAssignments(
  harness: NetW032Harness,
  challenge: ValidationChallenge,
  opts: { readonly derivedAt?: string; readonly actorPersonId?: string; readonly idempotencyKey?: string } = {},
): Promise<ValidationChallenge> {
  const ctx =
    opts.actorPersonId !== undefined
      ? personCtx(harness, opts.actorPersonId, "w032-assign")
      : personCtx(harness, harness.reviewerPersonId, "w032-assign");
  const result = await harness.runtime.validationService.deriveAssignments(ctx, {
    organizationScopeId: challenge.organizationScopeId,
    challengeId: challenge.id,
    derivedAt: opts.derivedAt ?? shiftIso(challenge.effectiveAt, 3600_000),
    idempotencyKey: opts.idempotencyKey ?? key("w032-assign"),
  });
  return result.challenge;
}

export interface ObserveOptions {
  readonly verdict?: string;
  readonly observedAt?: string;
  readonly evidenceRefs?: readonly { kind: string; id: string }[];
  readonly statement?: string;
  readonly idempotencyKey?: string;
}

/**
 * Submit one validator's observation. `validatorIndex` is the index
 * into the challenge's ASSIGNMENT ENTRIES (selection order — immune
 * to the (registeredAt, id) tie-break); default verdict UPHOLD with
 * the challenged proof as the evidence reference; the default anchor
 * is effectiveAt + 2h.
 */
export async function observe(
  harness: NetW032Harness,
  challenge: ValidationChallenge,
  validatorIndex: number,
  opts: ObserveOptions = {},
): Promise<ValidationObservation> {
  const entry = challenge.assignment?.entries[validatorIndex];
  if (!entry) {
    throw new Error(
      `harness observe: validator index ${String(validatorIndex)} is outside the assignment (derive assignments first)`,
    );
  }
  const ctx = personCtx(harness, entry.validatorPersonId, "w032-observe");
  const result = await harness.runtime.validationService.submitObservation(ctx, {
    organizationScopeId: challenge.organizationScopeId,
    challengeId: challenge.id,
    verdict: opts.verdict ?? "UPHOLD",
    statement: opts.statement ?? "the challenge is well-founded on the referenced evidence",
    evidenceRefs:
      opts.evidenceRefs ?? [{ kind: "reputation_proof", id: challenge.target.id }],
    observedAt: opts.observedAt ?? shiftIso(challenge.effectiveAt, 7200_000),
    idempotencyKey: opts.idempotencyKey ?? key("w032-observe"),
  });
  return result.observation;
}

/** Derive the terminal outcome (default anchor: effectiveAt + 3h). */
export async function deriveOutcome(
  harness: NetW032Harness,
  challenge: ValidationChallenge,
  opts: { readonly evaluatedAt?: string; readonly actorPersonId?: string; readonly idempotencyKey?: string } = {},
): Promise<ValidationOutcome> {
  const ctx =
    opts.actorPersonId !== undefined
      ? personCtx(harness, opts.actorPersonId, "w032-derive")
      : personCtx(harness, harness.reviewerPersonId, "w032-derive");
  const result = await harness.runtime.validationService.deriveOutcome(ctx, {
    organizationScopeId: challenge.organizationScopeId,
    challengeId: challenge.id,
    evaluatedAt: opts.evaluatedAt ?? shiftIso(challenge.effectiveAt, 3600_000 * 3),
    idempotencyKey: opts.idempotencyKey ?? key("w032-derive"),
  });
  return result.outcome;
}

/**
 * The full service-level flow: open → derive assignments → submit
 * `verdicts` (one per assigned validator, in selection order; default
 * all UPHOLD) → derive the outcome. Returns the closed round pieces.
 */
export async function runFullRound(
  harness: NetW032Harness,
  opts: {
    readonly verdicts?: readonly string[];
    readonly submitCount?: number;
  } = {},
): Promise<{
  readonly challenge: ValidationChallenge;
  readonly outcome: ValidationOutcome;
  readonly proof: ReputationProof;
  readonly evidenceId: string;
}> {
  const opened = await openDefaultChallenge(harness);
  const assigned = await deriveAssignments(harness, opened.challenge);
  const verdicts = opts.verdicts ?? ["UPHOLD", "UPHOLD", "UPHOLD"];
  const submitCount = opts.submitCount ?? verdicts.length;
  for (let i = 0; i < submitCount; i += 1) {
    await observe(harness, assigned, i, {
      verdict: verdicts[i] ?? "UPHOLD",
    });
  }
  const outcome = await deriveOutcome(harness, assigned);
  return {
    challenge: (await harness.runtime.validationService.getChallenge(
      initiatorCtx(harness, "w032-flush"),
      harness.organizationScopeId,
      assigned.id,
    )),
    outcome,
    proof: opened.proof,
    evidenceId: opened.evidenceId,
  };
}

/**
 * Create a quorum policy with a validator STAKE requirement (10
 * credits) and pre-issue credits for the validator pool (the
 * AC-08 economic flows).
 */
export async function createStakedPolicy(
  harness: NetW032Harness,
  opts: { readonly shape?: Partial<typeof DEFAULT_QUORUM_SHAPE>; readonly fundValidators?: boolean } = {},
): Promise<string> {
  const policyId = `w032-staked-policy-${randomUUID()}`;
  await harness.runtime.validationPolicyService.createPolicyVersion(
    harness.bootstrapCtx,
    {
      organizationScopeId: harness.organizationScopeId,
      policyId,
      version: 1,
      description: "NET-W032 harness staked quorum policy",
      ...DEFAULT_QUORUM_SHAPE,
      validatorStakeRequirementCredits: 10,
      ...opts.shape,
    },
  );
  if (opts.fundValidators !== false) {
    for (const validatorPersonId of harness.validatorPersonIds) {
      await ensureCreditsFor(harness.w010, validatorPersonId, 50);
    }
  }
  return policyId;
}
