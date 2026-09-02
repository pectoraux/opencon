/**
 * ValidationService — domain service for the decentralized
 * validation/dispute coordination aggregate (NET-W032 §3.3–§3.8):
 * validation challenges (rounds), conflict marks, deterministic
 * validator assignment, validator-stake bonding bookkeeping,
 * independent observations and the deterministic quorum outcome
 * derivation + application records.
 *
 * Architecture ref: spec/architecture.md §12, §18 (module ownership:
 * /disputes owns the validation coordination — it is a
 * decision/coordination layer, never a second lifecycle, reputation,
 * evidence or economic authority); §19 (AI output never establishes
 * eligibility, resolves a dispute, sets quorum, determines stake
 * effects or overrides deterministic rules); spec/architecture-
 * lock.md §2, §5, §13 invariant 21.
 *
 * AUTHORITY SEPARATION (the work item's strongest constraint):
 *  - this service owns the coordination DECISIONS only (round facts,
 *    assignment sets, observations, quorum outcomes);
 *  - /settlement remains the economic authority: validator stakes are
 *    committed/released/forfeited ONLY through the settlement
 *    boundary's stake commands, orchestrated at the composition root
 *    with compound idempotency keys (the NET-W009/W010 precedent);
 *    `bondValidatorStake` only VERIFIES the settlement record through
 *    the read-only stake lookup, and `recordValidatorStakeOutcome`
 *    only RECORDS what settlement executed;
 *  - /reputation remains the reputation authority: an accepted outcome
 *    against a W031 portable proof is APPLIED through the reputation
 *    authority's own revocation command at the composition root;
 *    `markOutcomeApplied` verifies the proof's one-way revocation
 *    state through the read-only proof lookup BEFORE recording the
 *    application fact (failed authority application can never be
 *    recorded as success);
 *  - /workflows remains the lifecycle authority and /evidence + W029
 *    remain the integrity primitive (referenced opaquely through the
 *    neutral lookups — never re-implemented, never mutated).
 *
 * DETERMINISM (invariant 4): eligibility windows, assignment ordering
 * and quorum derivation take EXPLICIT caller-supplied anchors against
 * RECORDED inputs (never a wall clock); the outcome derivation is the
 * PURE core quorum-engine over the frozen policy shape; the
 * closure→stake mapping is the pure core function
 * `validatorStakeDispositionForClosure`. Server-side wall clock is
 * used ONLY for event/audit `recordedAt` bookkeeping (the NET-W009
 * convention).
 *
 * ROUND STATE IS IMMUTABLE FACTS (no status machine — the authority
 * guardrail): `assignment === null` / `outcome === null` projections
 * plus the append-only event history; closed rounds are immutable
 * (rechallenge creates a NEW linked record).
 *
 * CONFLICT OF INTEREST (§3.6): the assignment derivation excludes the
 * target subject/owner, the target beneficiary, the challenge
 * initiator and every explicitly conflicted candidate BEFORE the
 * deterministic ordering; the outcome application bars the round's
 * own assigned validators (validators influence decisions only
 * through the protocol).
 *
 * Atomicity: every mutation commits its record + the idempotency
 * record + the audit event in ONE authoritative transaction
 * (IdempotencyStore.applyIdempotent; NET-W004-AC-07).
 *
 * Lock ordering (documented, never reversed): per-target round mutex
 * (duplicate gate) → idempotency key; per-round record mutex →
 * idempotency key; per-(round, validator) observation-slot mutex →
 * idempotency key; per-outcome record mutex → idempotency key.
 *
 * Tier compliance: disputes domain → self + core contracts only.
 */

import { randomUUID } from "node:crypto";
import type { TransactionalAuditWriter } from "../core/audit.ts";
import type { ExecutionContext } from "../core/execution-context.ts";
import type { IdempotencyStore } from "../core/idempotency.ts";
import { ConflictError, NotFoundError, OpenConError } from "../core/errors.ts";
import type { Logger } from "../core/logger.ts";
import {
  VALIDATION_PROTOCOL_VERSION,
  isAcceptedValidationDecision,
  isValidationOutcomeApplication,
  isValidationTargetKind,
  isValidationVerdict,
  isValidatorStakeDisposition,
  validateValidationTimestamp,
  validationWindowExpiry,
} from "../core/validation.ts";
import type {
  ValidationOutcomeApplication,
  ValidationVerdict,
  ValidatorStakeDisposition,
} from "../core/validation.ts";
import type {
  BondValidatorStakeInput,
  DeriveValidationOutcomeInput,
  DeriveValidationOutcomeResult,
  DeriveValidatorAssignmentsInput,
  DeriveValidatorAssignmentsResult,
  MarkValidationOutcomeAppliedInput,
  MarkValidatorConflictInput,
  OpenValidationChallengeInput,
  OpenValidationChallengeResult,
  RecordValidatorStakeOutcomeInput,
  SubmitValidatorObservationInput,
  SubmitValidatorObservationResult,
  ValidationChallenge,
  ValidationChallengeEvent,
  ValidationChallengeEventKind,
  ValidationChallengeRepository,
  ValidationLookups,
  ValidationObservation,
  ValidationObservationRepository,
  ValidationOutcome,
  ValidationOutcomeRepository,
  ValidationPolicyRepository,
  ValidationService,
  ValidationServiceDeps,
  ValidatorAssignmentBlock,
  ValidatorAssignmentEntry,
  ValidatorExcludedCandidate,
  ValidatorParticipantRepository,
} from "./port.ts";
import { deriveQuorumOutcome } from "./quorum-engine.ts";

const CHALLENGE_OPENED = "validation_challenge.opened" as const;
const CHALLENGE_CONFLICT_MARKED = "validation_challenge.conflict_marked" as const;
const CHALLENGE_ASSIGNMENTS_DERIVED = "validation_challenge.assignments_derived" as const;
const CHALLENGE_STAKE_BONDED = "validation_challenge.stake_bonded" as const;
const OBSERVATION_RECORDED = "validation_observation.recorded" as const;
const OUTCOME_DERIVED = "validation_outcome.derived" as const;
const OUTCOME_STAKE_OUTCOME_RECORDED = "validation_outcome.stake_outcome_recorded" as const;
const OUTCOME_APPLIED = "validation_outcome.applied" as const;

function validationError(
  message: string,
  context: Readonly<Record<string, unknown>>,
): OpenConError {
  return new OpenConError({
    code: "VALIDATION_VALIDATION",
    classification: "validation",
    message,
    context,
  });
}

/** Reason-codes validation (≥1 non-empty code). */
function assertReasonCodes(reasonCodes: readonly string[]): readonly string[] {
  if (
    !Array.isArray(reasonCodes) ||
    reasonCodes.length === 0 ||
    reasonCodes.some((c) => typeof c !== "string" || !c.trim())
  ) {
    throw validationError(
      "opening a validation challenge requires reasonCodes (at least one non-empty code)",
      { reasonCodes },
    );
  }
  return reasonCodes.map((c) => c.trim());
}

function assertIdempotencyKey(idempotencyKey: string): string {
  if (!idempotencyKey?.trim()) {
    throw validationError("idempotencyKey is required", {
      field: "idempotencyKey",
    });
  }
  return idempotencyKey;
}

/** The acting person's id (authorization: only persons act on validation). */
function actingPersonId(execution: ExecutionContext): string {
  if (!execution.actor || execution.actor.kind !== "person") {
    throw validationError(
      "an authenticated person actor is required (service/system actors cannot open, coordinate or resolve validation rounds)",
      { actorKind: execution.actor?.kind ?? null },
    );
  }
  return execution.actor.id;
}

/** Build one append-only round-history event. */
function buildEvent(
  event: ValidationChallengeEventKind,
  execution: ExecutionContext,
  actorPersonId: string,
  reason: string | null,
): ValidationChallengeEvent {
  return Object.freeze({
    id: randomUUID(),
    event,
    actorPersonId,
    reason,
    recordedAt: new Date().toISOString(),
    executionId: execution.executionId,
    correlationId: execution.correlationId,
  });
}

/** Per-target serialization lock (duplicate-round gate check-then-act). */
function challengeTargetLockKey(
  organizationScopeId: string,
  targetKind: string,
  targetId: string,
): string {
  return `validation_challenge_target:${organizationScopeId}:${targetKind}:${targetId}`;
}

/** Per-round record serialization lock (state-fact check-then-act). */
function challengeRecordLockKey(challengeId: string): string {
  return `validation_challenge_record:${challengeId}`;
}

/** Per-(round, validator) observation-slot serialization lock. */
function observationSlotLockKey(
  organizationScopeId: string,
  challengeId: string,
  validatorPersonId: string,
): string {
  return `validation_observation_slot:${organizationScopeId}:${challengeId}:${validatorPersonId}`;
}

/** Per-outcome record serialization lock (append bookkeeping check-then-act). */
function outcomeRecordLockKey(outcomeId: string): string {
  return `validation_outcome_record:${outcomeId}`;
}

export function createValidationService(
  deps: ValidationServiceDeps,
): ValidationService {
  const {
    challengeRepository,
    observationRepository,
    outcomeRepository,
    policyRepository,
    participantRepository,
    lookups,
    idempotency,
    auditWriter,
    logger,
  } = deps;

  /** Tenant-scoped challenge load (no existence oracle). */
  async function loadChallengeScoped(
    organizationScopeId: string,
    challengeId: string,
  ): Promise<ValidationChallenge> {
    const found = await challengeRepository.findById(challengeId);
    if (!found || found.organizationScopeId !== organizationScopeId) {
      throw new NotFoundError(`validation challenge not found: ${challengeId}`, {
        challengeId,
      });
    }
    return found;
  }

  /** Tenant-scoped outcome load (no existence oracle). */
  async function loadOutcomeScoped(
    organizationScopeId: string,
    outcomeId: string,
  ): Promise<ValidationOutcome> {
    const found = await outcomeRepository.findById(outcomeId);
    if (!found || found.organizationScopeId !== organizationScopeId) {
      throw new NotFoundError(`validation outcome not found: ${outcomeId}`, {
        outcomeId,
      });
    }
    return found;
  }

  /** Resolve + scope-check the observation evidence references (opaque). */
  async function resolveEvidenceRefs(
    organizationScopeId: string,
    rawRefs: readonly { readonly kind: string; readonly id: string }[],
  ): Promise<readonly { readonly kind: string; readonly id: string }[]> {
    if (
      !Array.isArray(rawRefs) ||
      rawRefs.some(
        (r) =>
          !r ||
          typeof r !== "object" ||
          typeof r.kind !== "string" ||
          typeof r.id !== "string" ||
          !r.id.trim(),
      )
    ) {
      throw validationError(
        "evidenceRefs must be an array of { kind, id } references",
        { evidenceRefs: rawRefs },
      );
    }
    const resolved: { kind: string; id: string }[] = [];
    for (const ref of rawRefs) {
      if (ref.kind === "signed_attestation") {
        const attestation = await lookups.attestations.resolve(ref.id);
        if (!attestation) {
          throw new NotFoundError(
            `evidence reference does not resolve to a signed attestation: ${ref.id}`,
            { kind: ref.kind, id: ref.id },
          );
        }
        if (attestation.organizationScopeId !== organizationScopeId) {
          throw validationError(
            `evidence reference ${ref.kind}:${ref.id} belongs to organization scope ${attestation.organizationScopeId}, not ${organizationScopeId}`,
            {
              kind: ref.kind,
              id: ref.id,
              sourceScope: attestation.organizationScopeId,
              requestedScope: organizationScopeId,
            },
          );
        }
        if (attestation.revokedAt !== null) {
          throw validationError(
            `evidence reference ${ref.kind}:${ref.id} is a REVOKED signed attestation (revoked at ${attestation.revokedAt}) — integrity evidence must be current`,
            { kind: ref.kind, id: ref.id, revokedAt: attestation.revokedAt },
          );
        }
        resolved.push({ kind: ref.kind, id: ref.id });
      } else if (ref.kind === "reputation_proof") {
        const proof = await lookups.proofs.resolve(ref.id);
        if (!proof) {
          throw new NotFoundError(
            `evidence reference does not resolve to a reputation proof: ${ref.id}`,
            { kind: ref.kind, id: ref.id },
          );
        }
        if (proof.organizationScopeId !== organizationScopeId) {
          throw validationError(
            `evidence reference ${ref.kind}:${ref.id} belongs to organization scope ${proof.organizationScopeId}, not ${organizationScopeId}`,
            {
              kind: ref.kind,
              id: ref.id,
              sourceScope: proof.organizationScopeId,
              requestedScope: organizationScopeId,
            },
          );
        }
        if (proof.revokedAt !== null) {
          throw validationError(
            `evidence reference ${ref.kind}:${ref.id} is a REVOKED reputation proof (revoked at ${proof.revokedAt}) — integrity evidence must be current`,
            { kind: ref.kind, id: ref.id, revokedAt: proof.revokedAt },
          );
        }
        resolved.push({ kind: ref.kind, id: ref.id });
      } else {
        throw validationError(
          `evidence reference kind must be signed_attestation or reputation_proof (got ${String(ref.kind)})`,
          { kind: ref.kind, id: ref.id },
        );
      }
    }
    return Object.freeze(resolved);
  }

  const service: ValidationService = {
    // ------------------------------------------------------------------
    // Open a validation challenge (the round record).
    // ------------------------------------------------------------------
    async openChallenge(execution, input) {
      if (!input.organizationScopeId?.trim()) {
        throw validationError("organizationScopeId is required", {
          field: "organizationScopeId",
        });
      }
      if (!input.statement?.trim()) {
        throw validationError("statement is required", {
          field: "statement",
        });
      }
      assertReasonCodes(input.reasonCodes);
      assertIdempotencyKey(input.idempotencyKey);
      validateValidationTimestamp("effectiveAt", input.effectiveAt);
      if (!input.policyId?.trim()) {
        throw validationError("policyId is required", {
          field: "policyId",
        });
      }
      if (
        !input.target ||
        typeof input.target !== "object" ||
        !isValidationTargetKind(input.target.kind) ||
        typeof input.target.id !== "string" ||
        !input.target.id.trim()
      ) {
        throw validationError(
          "target.kind must be a validation target kind with a non-empty id",
          { target: input.target },
        );
      }

      // Authorization: a person actor (server-side identity).
      const initiator = actingPersonId(execution);
      if (!(await lookups.subject.exists(initiator))) {
        throw validationError(
          `challenge initiator person does not exist: ${initiator}`,
          { initiatedByPersonId: initiator },
        );
      }

      // The target must resolve to an authoritative record in the same
      // organization scope (tenant isolation).
      const resolvedTarget = await lookups.target.resolve(
        input.target.kind,
        input.target.id,
      );
      if (!resolvedTarget) {
        throw new NotFoundError(
          `validation target ${input.target.kind}:${input.target.id} does not resolve to an authoritative record`,
          {
            targetKind: input.target.kind,
            targetId: input.target.id,
          },
        );
      }
      if (resolvedTarget.organizationScopeId !== input.organizationScopeId) {
        throw validationError(
          `validation target ${input.target.kind}:${input.target.id} belongs to organization scope ${resolvedTarget.organizationScopeId}, not ${input.organizationScopeId}`,
          {
            targetKind: input.target.kind,
            targetId: input.target.id,
            targetScope: resolvedTarget.organizationScopeId,
            requestedScope: input.organizationScopeId,
          },
        );
      }
      validateValidationTimestamp("targetAnchorAt", resolvedTarget.anchorAt);

      // The round's creation anchor must not precede the target's own
      // authoritative anchor (a challenge cannot predate its target).
      if (Date.parse(input.effectiveAt) < Date.parse(resolvedTarget.anchorAt)) {
        throw validationError(
          `challenge effectiveAt ${input.effectiveAt} precedes the target's authoritative anchor ${resolvedTarget.anchorAt}`,
          {
            effectiveAt: input.effectiveAt,
            targetAnchorAt: resolvedTarget.anchorAt,
          },
        );
      }

      // The rechallenge target (when given) must be a CLOSED round in
      // the same scope — checked BEFORE the duplicate gate so the
      // precise one-way rule surfaces (rechallenging a LIVE round is
      // specifically "the round is not closed", not a generic
      // duplicate). Re-verified in-transaction below.
      if (input.rechallengeOfChallengeId !== undefined) {
        const rechallengeOf = await challengeRepository.findById(
          input.rechallengeOfChallengeId,
        );
        if (
          !rechallengeOf ||
          rechallengeOf.organizationScopeId !== input.organizationScopeId
        ) {
          throw new NotFoundError(
            `rechallenge target not found: ${input.rechallengeOfChallengeId}`,
            { rechallengeOfChallengeId: input.rechallengeOfChallengeId },
          );
        }
        if (rechallengeOf.outcome === null) {
          throw validationError(
            `rechallenge target ${rechallengeOf.id} is not a closed round (no outcome) — only a CLOSED round can be rechallenged`,
            { rechallengeOfChallengeId: rechallengeOf.id },
          );
        }
      }

      // Duplicate gate: a target with a LIVE (outcome-less) round
      // cannot be challenged again — the round must close first (then
      // a rechallenge opens a NEW linked round).
      const live = await challengeRepository.findLiveByTarget(
        input.organizationScopeId,
        input.target.kind,
        input.target.id,
      );
      const foreignLive = live.filter(
        (c) => c.idempotencyKey !== input.idempotencyKey,
      );
      if (foreignLive.length > 0) {
        throw new ConflictError(
          `target ${input.target.kind}:${input.target.id} already has a live validation round (${foreignLive[0]!.id})`,
          {
            targetKind: input.target.kind,
            targetId: input.target.id,
            existingChallengeId: foreignLive[0]!.id,
          },
        );
      }

      const key = `validation_challenge_open:${input.organizationScopeId}:${input.idempotencyKey}`;
      // The target mutex serializes concurrent opens of the SAME
      // target (the duplicate gate guards the TARGET, not the key).
      const applied = await idempotency.withLock(
        challengeTargetLockKey(
          input.organizationScopeId,
          input.target.kind,
          input.target.id,
        ),
        () =>
          idempotency.applyIdempotent(
            key,
            async (ctx) => {
              const tx = ctx.transaction;
              // In-tx duplicate re-check.
              const liveInTx = await challengeRepository.findLiveByTargetWithinTx(
                input.organizationScopeId,
                input.target.kind,
                input.target.id,
                tx,
              );
              const foreign = liveInTx.filter(
                (c) => c.idempotencyKey !== input.idempotencyKey,
              );
              if (foreign.length > 0) {
                throw new ConflictError(
                  `target ${input.target.kind}:${input.target.id} already has a live validation round (${foreign[0]!.id})`,
                  {
                    targetKind: input.target.kind,
                    targetId: input.target.id,
                    existingChallengeId: foreign[0]!.id,
                  },
                );
              }

              // The rechallenge target (when given) must be a CLOSED
              // round in the same scope (rechallenge = a NEW round).
              let rechallengeOf: ValidationChallenge | null = null;
              if (input.rechallengeOfChallengeId !== undefined) {
                rechallengeOf = await challengeRepository.findByIdWithinTx(
                  input.rechallengeOfChallengeId,
                  tx,
                );
                if (
                  !rechallengeOf ||
                  rechallengeOf.organizationScopeId !== input.organizationScopeId
                ) {
                  throw new NotFoundError(
                    `rechallenge target not found: ${input.rechallengeOfChallengeId}`,
                    { rechallengeOfChallengeId: input.rechallengeOfChallengeId },
                  );
                }
                if (rechallengeOf.outcome === null) {
                  throw validationError(
                    `rechallenge target ${rechallengeOf.id} is not a closed round (no outcome) — only a CLOSED round can be rechallenged`,
                    { rechallengeOfChallengeId: rechallengeOf.id },
                  );
                }
              }

              // Freeze the policy INSIDE the transaction (the latest
              // version of the lineage in this scope at open time).
              const policy = await policyRepository.findLatestVersionWithinTx(
                input.policyId,
                input.organizationScopeId,
                tx,
              );
              if (!policy) {
                throw new NotFoundError(
                  `validation policy not found in organization scope ${input.organizationScopeId}: ${input.policyId}`,
                  { policyId: input.policyId, organizationScopeId: input.organizationScopeId },
                );
              }

              const event = buildEvent(
                "opened",
                execution,
                initiator,
                input.statement.trim(),
              );
              const windowExpiresAt = validationWindowExpiry(
                input.effectiveAt,
                policy.challengeWindowMs,
              );
              const challenge: ValidationChallenge = Object.freeze({
                id: randomUUID(),
                organizationScopeId: input.organizationScopeId,
                target: Object.freeze({
                  kind: input.target.kind,
                  id: input.target.id,
                }),
                targetAnchorAt: resolvedTarget.anchorAt,
                targetSubjectPersonId: resolvedTarget.subjectPersonId,
                targetBeneficiaryPersonId: resolvedTarget.beneficiaryPersonId,
                targetState: resolvedTarget.state,
                statement: input.statement.trim(),
                reasonCodes: [...assertReasonCodes(input.reasonCodes)],
                initiatedByPersonId: initiator,
                rechallengeOfChallengeId:
                  input.rechallengeOfChallengeId ?? null,
                effectiveAt: input.effectiveAt,
                windowExpiresAt,
                policyId: policy.policyId,
                policyVersion: policy.version,
                assignmentCardinality: policy.assignmentCardinality,
                minimumSubmitted: policy.minimumSubmitted,
                upholdThreshold: policy.upholdThreshold,
                rejectThreshold: policy.rejectThreshold,
                validatorStakeRequirementCredits: policy.validatorStakeRequirementCredits,
                conflicts: Object.freeze([]),
                assignment: null,
                outcome: null,
                events: Object.freeze([event]),
                protocolVersion: VALIDATION_PROTOCOL_VERSION,
                idempotencyKey: input.idempotencyKey,
                executionId: execution.executionId,
                correlationId: execution.correlationId,
                causationId: execution.causationId,
                createdAt: event.recordedAt,
              });
              await challengeRepository.createWithinTx(challenge, tx);
              const buffer = auditWriter.forTransaction(tx);
              await buffer.append({
                eventType: CHALLENGE_OPENED,
                context: execution,
                actor: initiator,
                subject: challenge.id,
                resourceType: "validation_challenge",
                resourceId: challenge.id,
                metadata: {
                  organizationScopeId: challenge.organizationScopeId,
                  challengeId: challenge.id,
                  target: `${challenge.target.kind}:${challenge.target.id}`,
                  targetAnchorAt: challenge.targetAnchorAt,
                  initiatedByPersonId: initiator,
                  rechallengeOfChallengeId: challenge.rechallengeOfChallengeId,
                  effectiveAt: challenge.effectiveAt,
                  windowExpiresAt: challenge.windowExpiresAt,
                  policyId: challenge.policyId,
                  policyVersion: challenge.policyVersion,
                  reasonCodes: challenge.reasonCodes,
                  idempotencyRecordId: ctx.recordId,
                  transactionId: tx.transactionId,
                },
              });
              return challenge;
            },
            execution,
          ),
      );
      logger.info("validation_challenge.opened", {
        challengeId: applied.result.id,
        created: applied.executed,
      });
      return { challenge: applied.result, created: applied.executed };
    },

    async getChallenge(execution, organizationScopeId, challengeId) {
      void execution;
      return loadChallengeScoped(organizationScopeId, challengeId);
    },

    // ------------------------------------------------------------------
    // Mark a validator explicitly conflicted (ONE-WAY append).
    // ------------------------------------------------------------------
    async markConflict(execution, input) {
      assertIdempotencyKey(input.idempotencyKey);
      if (!input.challengeId?.trim()) {
        throw validationError("challengeId is required", {
          field: "challengeId",
        });
      }
      if (!input.validatorPersonId?.trim()) {
        throw validationError("validatorPersonId is required", {
          field: "validatorPersonId",
        });
      }
      if (!input.reason?.trim()) {
        throw validationError("reason is required", {
          field: "reason",
        });
      }
      const actor = actingPersonId(execution);
      const found = await loadChallengeScoped(
        input.organizationScopeId,
        input.challengeId,
      );
      // NOTE: the closed-round and already-conflicted state gates live
      // ONLY in the in-tx re-check below: a same-key REPLAY must reach
      // the idempotency store (which short-circuits the callback and
      // returns the cached record) — an outer state throw would break
      // replay idempotency. A genuinely fresh key still fails closed
      // in-transaction.

      const key = `validation_challenge_conflict:${input.organizationScopeId}:${found.id}:${input.idempotencyKey}`;
      const applied = await idempotency.withLock(
        challengeRecordLockKey(found.id),
        () =>
          idempotency.applyIdempotent(
            key,
            async (ctx) => {
              const tx = ctx.transaction;
              const current = await challengeRepository.findByIdWithinTx(
                found.id,
                tx,
              );
              if (
                !current ||
                current.organizationScopeId !== input.organizationScopeId
              ) {
                throw new NotFoundError(
                  `validation challenge not found: ${found.id}`,
                  { challengeId: found.id },
                );
              }
              if (current.outcome !== null) {
                throw new ConflictError(
                  `validation challenge ${current.id} is CLOSED — closed rounds are immutable`,
                  { challengeId: current.id },
                );
              }
              if (current.conflicts.includes(input.validatorPersonId)) {
                throw new ConflictError(
                  `person ${input.validatorPersonId} is already marked conflicted on validation challenge ${current.id}`,
                  {
                    challengeId: current.id,
                    validatorPersonId: input.validatorPersonId,
                  },
                );
              }
              const event = buildEvent(
                "conflict_marked",
                execution,
                actor,
                input.reason.trim(),
              );
              const updated: ValidationChallenge = Object.freeze({
                ...current,
                conflicts: Object.freeze([
                  ...current.conflicts,
                  input.validatorPersonId,
                ]),
                events: Object.freeze([...current.events, event]),
              });
              await challengeRepository.saveWithinTx(updated, tx);
              const buffer = auditWriter.forTransaction(tx);
              await buffer.append({
                eventType: CHALLENGE_CONFLICT_MARKED,
                context: execution,
                actor,
                subject: updated.id,
                resourceType: "validation_challenge",
                resourceId: updated.id,
                metadata: {
                  organizationScopeId: updated.organizationScopeId,
                  challengeId: updated.id,
                  validatorPersonId: input.validatorPersonId,
                  reason: input.reason.trim(),
                  idempotencyRecordId: ctx.recordId,
                  transactionId: tx.transactionId,
                },
              });
              return updated;
            },
            execution,
          ),
      );
      logger.info("validation_challenge.conflict_marked", {
        challengeId: applied.result.id,
        validatorPersonId: input.validatorPersonId,
      });
      return applied.result;
    },

    // ------------------------------------------------------------------
    // Derive the deterministic assignment set (exactly ONE per round).
    // ------------------------------------------------------------------
    async deriveAssignments(execution, input) {
      assertIdempotencyKey(input.idempotencyKey);
      validateValidationTimestamp("derivedAt", input.derivedAt);
      const found = await loadChallengeScoped(
        input.organizationScopeId,
        input.challengeId,
      );
      // NOTE: the closed-round and already-assigned state gates live
      // ONLY in the in-tx re-check below (same-key replays must reach
      // the idempotency store; fresh keys fail closed in-transaction).
      // The derivation anchor must fall within the round window.
      if (
        Date.parse(input.derivedAt) < Date.parse(found.effectiveAt) ||
        Date.parse(input.derivedAt) > Date.parse(found.windowExpiresAt)
      ) {
        throw validationError(
          `assignment derivation anchor ${input.derivedAt} is outside the round window [${found.effectiveAt}, ${found.windowExpiresAt}]`,
          {
            derivedAt: input.derivedAt,
            effectiveAt: found.effectiveAt,
            windowExpiresAt: found.windowExpiresAt,
          },
        );
      }

      const key = `validator_assignment:${input.organizationScopeId}:${found.id}:${input.idempotencyKey}`;
      const applied = await idempotency.withLock(
        challengeRecordLockKey(found.id),
        () =>
          idempotency.applyIdempotent(
            key,
            async (ctx) => {
              const tx = ctx.transaction;
              const current = await challengeRepository.findByIdWithinTx(
                found.id,
                tx,
              );
              if (
                !current ||
                current.organizationScopeId !== input.organizationScopeId
              ) {
                throw new NotFoundError(
                  `validation challenge not found: ${found.id}`,
                  { challengeId: found.id },
                );
              }
              if (current.outcome !== null) {
                throw new ConflictError(
                  `validation challenge ${current.id} is CLOSED — the assignment set is frozen`,
                  { challengeId: current.id },
                );
              }
              if (current.assignment !== null) {
                throw new ConflictError(
                  `validation challenge ${current.id} already has a derived assignment set (${current.assignment.setId})`,
                  {
                    challengeId: current.id,
                    assignmentSetId: current.assignment.setId,
                  },
                );
              }

              // ---- THE DETERMINISTIC SELECTION (work order §3.2/§3.6). --
              // The candidate pool: this org's participants (tenant
              // scope — NO default cross-tenant leakage; cross-tenant
              // candidates are never candidates at all). Eligibility
              // is derived, never caller-asserted.
              const pool = await participantRepository.listByOrganization(
                current.organizationScopeId,
              );
              const eligible: {
                personId: string;
                participantId: string;
                registeredAt: string;
                id: string;
              }[] = [];
              const excluded: ValidatorExcludedCandidate[] = [];
              for (const candidate of pool) {
                if (candidate.status !== "ACTIVE") {
                  excluded.push(
                    Object.freeze({
                      personId: candidate.personId,
                      reason: "suspended" as const,
                    }),
                  );
                  continue;
                }
                // The conflict-of-interest gates (§3.6: fail closed
                // BEFORE the deterministic ordering — an excluded
                // candidate can never be selected).
                if (
                  current.targetSubjectPersonId !== null &&
                  candidate.personId === current.targetSubjectPersonId
                ) {
                  excluded.push(
                    Object.freeze({
                      personId: candidate.personId,
                      reason: "target_subject" as const,
                    }),
                  );
                  continue;
                }
                if (
                  current.targetBeneficiaryPersonId !== null &&
                  candidate.personId === current.targetBeneficiaryPersonId
                ) {
                  excluded.push(
                    Object.freeze({
                      personId: candidate.personId,
                      reason: "target_beneficiary" as const,
                    }),
                  );
                  continue;
                }
                if (candidate.personId === current.initiatedByPersonId) {
                  excluded.push(
                    Object.freeze({
                      personId: candidate.personId,
                      reason: "challenge_initiator" as const,
                    }),
                  );
                  continue;
                }
                if (current.conflicts.includes(candidate.personId)) {
                  excluded.push(
                    Object.freeze({
                      personId: candidate.personId,
                      reason: "explicitly_conflicted" as const,
                    }),
                  );
                  continue;
                }
                eligible.push({
                  personId: candidate.personId,
                  participantId: candidate.id,
                  registeredAt: candidate.registeredAt,
                  id: candidate.id,
                });
              }

              // ---- The deterministic ordering: (registeredAt, id). ----
              eligible.sort((a, b) =>
                a.registeredAt === b.registeredAt
                  ? a.id < b.id
                    ? -1
                    : 1
                  : a.registeredAt < b.registeredAt
                    ? -1
                    : 1,
              );

              // ---- The cardinality: fail closed when the pool is too --
              // small (no set is recorded; the round stays open).
              if (eligible.length < current.assignmentCardinality) {
                throw validationError(
                  `insufficient eligible validators for validation challenge ${current.id}: ${String(eligible.length)} eligible, cardinality ${String(current.assignmentCardinality)} required`,
                  {
                    challengeId: current.id,
                    eligibleCount: eligible.length,
                    assignmentCardinality: current.assignmentCardinality,
                  },
                );
              }
              const selected = eligible.slice(0, current.assignmentCardinality);
              const entries: ValidatorAssignmentEntry[] = selected.map(
                (candidate, index) =>
                  Object.freeze({
                    validatorPersonId: candidate.personId,
                    participantId: candidate.participantId,
                    selectionOrder: index + 1,
                    stake: Object.freeze({
                      requirementCredits: current.validatorStakeRequirementCredits,
                      stakeId: null,
                      bondedAt: null,
                    }),
                  }),
              );

              const event = buildEvent(
                "assignments_derived",
                execution,
                execution.actor?.id ?? "unknown",
                `set of ${String(entries.length)} at ${input.derivedAt}`,
              );
              const assignment: ValidatorAssignmentBlock = Object.freeze({
                setId: randomUUID(),
                derivedAt: input.derivedAt,
                policyId: current.policyId,
                policyVersion: current.policyVersion,
                entries: Object.freeze(entries),
                excluded: Object.freeze(excluded),
              });
              const updated: ValidationChallenge = Object.freeze({
                ...current,
                assignment,
                events: Object.freeze([...current.events, event]),
              });
              await challengeRepository.saveWithinTx(updated, tx);
              const buffer = auditWriter.forTransaction(tx);
              await buffer.append({
                eventType: CHALLENGE_ASSIGNMENTS_DERIVED,
                context: execution,
                actor: execution.actor?.id ?? null,
                subject: updated.id,
                resourceType: "validation_challenge",
                resourceId: updated.id,
                metadata: {
                  organizationScopeId: updated.organizationScopeId,
                  challengeId: updated.id,
                  assignmentSetId: assignment.setId,
                  derivedAt: assignment.derivedAt,
                  policyId: assignment.policyId,
                  policyVersion: assignment.policyVersion,
                  assignedValidatorPersonIds: assignment.entries.map(
                    (e) => e.validatorPersonId,
                  ),
                  excludedCandidates: assignment.excluded.map(
                    (e) => `${e.personId}:${e.reason}`,
                  ),
                  stakeRequirementCredits:
                    updated.validatorStakeRequirementCredits,
                  idempotencyRecordId: ctx.recordId,
                  transactionId: tx.transactionId,
                },
              });
              return updated;
            },
            execution,
          ),
      );
      logger.info("validation_challenge.assignments_derived", {
        challengeId: applied.result.id,
        assignmentSetId: applied.result.assignment?.setId ?? null,
        created: applied.executed,
      });
      return { challenge: applied.result, created: applied.executed };
    },

    // ------------------------------------------------------------------
    // Bond a validator's committed stake to their assignment entry.
    // ------------------------------------------------------------------
    async bondValidatorStake(execution, input) {
      assertIdempotencyKey(input.idempotencyKey);
      const actor = actingPersonId(execution);
      const found = await loadChallengeScoped(
        input.organizationScopeId,
        input.challengeId,
      );
      const assignment = found.assignment;
      if (assignment === null) {
        throw validationError(
          `validation challenge ${found.id} has no derived assignment set — derive assignments before bonding validator stakes`,
          { challengeId: found.id },
        );
      }
      const entry = assignment.entries.find(
        (e) => e.validatorPersonId === input.validatorPersonId,
      );
      if (!entry) {
        throw validationError(
          `person ${input.validatorPersonId} is not an assigned validator of validation challenge ${found.id}`,
          { challengeId: found.id, validatorPersonId: input.validatorPersonId },
        );
      }
      // Self-bonding only (actor == the assigned validator).
      if (actor !== input.validatorPersonId) {
        throw validationError(
          `validator stakes are self-bonded: actor ${actor} cannot bond the assignment of validator ${input.validatorPersonId}`,
          { challengeId: found.id, actorPersonId: actor, validatorPersonId: input.validatorPersonId },
        );
      }
      if (entry.stake.requirementCredits === 0) {
        throw validationError(
          `the round's policy requires no validator stake (requirement 0) — nothing to bond for validation challenge ${found.id}`,
          { challengeId: found.id, validatorPersonId: input.validatorPersonId },
        );
      }
      // NOTE: the closed-round and already-bonded state gates live ONLY
      // in the in-tx re-check below (same-key replays must reach the
      // idempotency store; fresh keys fail closed in-transaction).

      // VERIFY the settlement authority's record (read-only lookup —
      // the escrow itself was posted by /settlement, never here).
      const stake = await lookups.stake.resolveStake(input.stakeId);
      if (!stake) {
        throw new NotFoundError(
          `stake not found in the settlement authority: ${input.stakeId}`,
          { stakeId: input.stakeId },
        );
      }
      if (stake.organizationScopeId !== found.organizationScopeId) {
        throw validationError(
          `stake ${input.stakeId} belongs to organization scope ${stake.organizationScopeId}, not ${found.organizationScopeId}`,
          {
            stakeId: input.stakeId,
            stakeScope: stake.organizationScopeId,
            requestedScope: found.organizationScopeId,
          },
        );
      }
      if (stake.ownerPersonId !== input.validatorPersonId) {
        throw validationError(
          `stake ${input.stakeId} is owned by ${stake.ownerPersonId}, not the assigned validator ${input.validatorPersonId}`,
          { stakeId: input.stakeId, ownerPersonId: stake.ownerPersonId },
        );
      }
      if (stake.state !== "COMMITTED") {
        throw validationError(
          `stake ${input.stakeId} is ${stake.state}, not COMMITTED`,
          { stakeId: input.stakeId, state: stake.state },
        );
      }
      if (stake.unit !== "credits") {
        throw validationError(
          `stake ${input.stakeId} is denominated in ${stake.unit}, not credits`,
          { stakeId: input.stakeId, unit: stake.unit },
        );
      }
      if (stake.amount !== entry.stake.requirementCredits) {
        throw validationError(
          `stake ${input.stakeId} amount ${String(stake.amount)} does not match the frozen requirement ${String(entry.stake.requirementCredits)}`,
          { stakeId: input.stakeId, amount: stake.amount },
        );
      }
      const expectedPurposeId = `${found.id}:${input.validatorPersonId}`;
      if (
        stake.purposeKind !== "validation_assignment" ||
        stake.purposeId !== expectedPurposeId
      ) {
        throw validationError(
          `stake ${input.stakeId} purpose ${stake.purposeKind}:${stake.purposeId} does not link validator assignment ${expectedPurposeId}`,
          {
            stakeId: input.stakeId,
            purposeKind: stake.purposeKind,
            purposeId: stake.purposeId,
            expectedPurposeId,
          },
        );
      }
      // The bonding deadline: within the round window.
      if (
        Date.parse(stake.committedAt) > Date.parse(found.windowExpiresAt)
      ) {
        throw validationError(
          `stake ${input.stakeId} was committed at ${stake.committedAt}, after the round window expired ${found.windowExpiresAt}`,
          {
            stakeId: input.stakeId,
            committedAt: stake.committedAt,
            windowExpiresAt: found.windowExpiresAt,
          },
        );
      }

      const key = `validator_stake_bond:${input.organizationScopeId}:${found.id}:${input.validatorPersonId}:${input.idempotencyKey}`;
      const applied = await idempotency.withLock(
        challengeRecordLockKey(found.id),
        () =>
          idempotency.applyIdempotent(
            key,
            async (ctx) => {
              const tx = ctx.transaction;
              const current = await challengeRepository.findByIdWithinTx(
                found.id,
                tx,
              );
              if (
                !current ||
                current.organizationScopeId !== input.organizationScopeId
              ) {
                throw new NotFoundError(
                  `validation challenge not found: ${found.id}`,
                  { challengeId: found.id },
                );
              }
              if (current.outcome !== null) {
                throw new ConflictError(
                  `validation challenge ${current.id} is CLOSED — the assignment set is frozen`,
                  { challengeId: current.id },
                );
              }
              const currentAssignment = current.assignment;
              if (currentAssignment === null) {
                throw validationError(
                  `validation challenge ${current.id} has no derived assignment set`,
                  { challengeId: current.id },
                );
              }
              const currentEntry = currentAssignment.entries.find(
                (e) => e.validatorPersonId === input.validatorPersonId,
              );
              if (!currentEntry) {
                throw validationError(
                  `person ${input.validatorPersonId} is not an assigned validator of validation challenge ${current.id}`,
                  { challengeId: current.id, validatorPersonId: input.validatorPersonId },
                );
              }
              if (currentEntry.stake.stakeId !== null) {
                throw new ConflictError(
                  `validator ${input.validatorPersonId} already bonded stake ${currentEntry.stake.stakeId} on validation challenge ${current.id}`,
                  {
                    challengeId: current.id,
                    validatorPersonId: input.validatorPersonId,
                    stakeId: currentEntry.stake.stakeId,
                  },
                );
              }
              const event = buildEvent(
                "validator_stake_bonded",
                execution,
                actor,
                `stake ${input.stakeId} for validator ${input.validatorPersonId}`,
              );
              const updated: ValidationChallenge = Object.freeze({
                ...current,
                assignment: Object.freeze({
                  ...currentAssignment,
                  entries: Object.freeze(
                    currentAssignment.entries.map((e) =>
                      e.validatorPersonId === input.validatorPersonId
                        ? Object.freeze({
                            ...e,
                            stake: Object.freeze({
                              ...e.stake,
                              stakeId: input.stakeId,
                              bondedAt: event.recordedAt,
                            }),
                          })
                        : e,
                    ),
                  ),
                }),
                events: Object.freeze([...current.events, event]),
              });
              await challengeRepository.saveWithinTx(updated, tx);
              const buffer = auditWriter.forTransaction(tx);
              await buffer.append({
                eventType: CHALLENGE_STAKE_BONDED,
                context: execution,
                actor,
                subject: updated.id,
                resourceType: "validation_challenge",
                resourceId: updated.id,
                metadata: {
                  organizationScopeId: updated.organizationScopeId,
                  challengeId: updated.id,
                  assignmentSetId: currentAssignment.setId,
                  validatorPersonId: input.validatorPersonId,
                  stakeId: input.stakeId,
                  stakeAmount: currentEntry.stake.requirementCredits,
                  idempotencyRecordId: ctx.recordId,
                  transactionId: tx.transactionId,
                },
              });
              return updated;
            },
            execution,
          ),
      );
      logger.info("validation_challenge.stake_bonded", {
        challengeId: applied.result.id,
        validatorPersonId: input.validatorPersonId,
        stakeId: input.stakeId,
      });
      return applied.result;
    },

    // ------------------------------------------------------------------
    // Submit one independent validator observation.
    // ------------------------------------------------------------------
    async submitObservation(execution, input) {
      assertIdempotencyKey(input.idempotencyKey);
      validateValidationTimestamp("observedAt", input.observedAt);
      if (!input.statement?.trim()) {
        throw validationError("statement is required", {
          field: "statement",
        });
      }
      if (!isValidationVerdict(input.verdict)) {
        throw validationError(
          `verdict must be UPHOLD, REJECT or ABSTAIN (got ${String(input.verdict)})`,
          { verdict: input.verdict },
        );
      }
      // Narrowed const BEFORE the idempotent closure (type-narrowing
      // does not cross into callbacks — the W010 discipline).
      const verdict: ValidationVerdict = input.verdict;
      const actor = actingPersonId(execution);
      const found = await loadChallengeScoped(
        input.organizationScopeId,
        input.challengeId,
      );
      const assignment = found.assignment;
      if (assignment === null) {
        throw validationError(
          `validation challenge ${found.id} has no derived assignment set — observations require an assignment`,
          { challengeId: found.id },
        );
      }
      // ACTOR BINDING (§3.4): the acting person must be an ASSIGNED
      // validator (never on behalf of another validator).
      const entry = assignment.entries.find(
        (e) => e.validatorPersonId === actor,
      );
      if (!entry) {
        throw validationError(
          `actor ${actor} is not an assigned validator of validation challenge ${found.id} (validators cannot observe outside their assignment)`,
          { challengeId: found.id, actorPersonId: actor },
        );
      }
      // The eligibility bond: when the policy requires a stake, it
      // must be bonded before the observation is accepted (fail
      // closed — §3.1 stake requirements are eligibility inputs).
      if (
        entry.stake.requirementCredits > 0 &&
        entry.stake.stakeId === null
      ) {
        throw validationError(
          `validator ${actor} has not bonded the required stake (${String(entry.stake.requirementCredits)} credits) on validation challenge ${found.id} — observations are accepted only from bonded assignments`,
          {
            challengeId: found.id,
            validatorPersonId: actor,
            requirementCredits: entry.stake.requirementCredits,
          },
        );
      }
      // The observation anchor must fall within the round window
      // (inclusive bounds).
      if (
        Date.parse(input.observedAt) < Date.parse(found.effectiveAt) ||
        Date.parse(input.observedAt) > Date.parse(found.windowExpiresAt)
      ) {
        throw validationError(
          `observation anchor ${input.observedAt} is outside the round window [${found.effectiveAt}, ${found.windowExpiresAt}]`,
          {
            observedAt: input.observedAt,
            effectiveAt: found.effectiveAt,
            windowExpiresAt: found.windowExpiresAt,
          },
        );
      }
      // Evidence references: opaque, resolving, same-scope, current
      // (W029/W031 integrity composition). UPHOLD/REJECT verdicts are
      // evidence-backed; ABSTAIN may carry none.
      const evidenceRefs = await resolveEvidenceRefs(
        input.organizationScopeId,
        input.evidenceRefs ?? [],
      );
      if (
        (input.verdict === "UPHOLD" || input.verdict === "REJECT") &&
        evidenceRefs.length === 0
      ) {
        throw validationError(
          `a ${input.verdict} verdict requires at least one evidence reference (evidence-backed verdicts only)`,
          { challengeId: found.id, verdict: input.verdict },
        );
      }

      // Duplicate gate: exactly ONE observation per (round, validator).
      const existing = await observationRepository.findByChallengeAndValidator(
        input.organizationScopeId,
        found.id,
        actor,
      );
      if (existing !== null && existing.idempotencyKey !== input.idempotencyKey) {
        throw new ConflictError(
          `validator ${actor} already submitted observation ${existing.id} on validation challenge ${found.id} (exactly one observation per validator per round)`,
          {
            challengeId: found.id,
            validatorPersonId: actor,
            existingObservationId: existing.id,
          },
        );
      }

      const key = `validation_observation:${input.organizationScopeId}:${found.id}:${actor}:${input.idempotencyKey}`;
      // The per-(round, validator) slot mutex serializes concurrent
      // submissions by the SAME validator (the one-observation
      // invariant is broader than the idempotency key).
      const applied = await idempotency.withLock(
        observationSlotLockKey(input.organizationScopeId, found.id, actor),
        () =>
          idempotency.applyIdempotent(
            key,
            async (ctx) => {
              const tx = ctx.transaction;
              const current = await challengeRepository.findByIdWithinTx(
                found.id,
                tx,
              );
              if (
                !current ||
                current.organizationScopeId !== input.organizationScopeId
              ) {
                throw new NotFoundError(
                  `validation challenge not found: ${found.id}`,
                  { challengeId: found.id },
                );
              }
              if (current.outcome !== null) {
                throw new ConflictError(
                  `validation challenge ${current.id} is CLOSED — closed rounds accept no observations`,
                  { challengeId: current.id },
                );
              }
              const currentAssignment = current.assignment;
              if (currentAssignment === null) {
                throw validationError(
                  `validation challenge ${current.id} has no derived assignment set`,
                  { challengeId: current.id },
                );
              }
              const currentEntry = currentAssignment.entries.find(
                (e) => e.validatorPersonId === actor,
              );
              if (!currentEntry) {
                throw validationError(
                  `actor ${actor} is not an assigned validator of validation challenge ${current.id}`,
                  { challengeId: current.id, actorPersonId: actor },
                );
              }
              // In-tx duplicate re-check (the slot mutex guarantees the
              // prior submitter's record is COMMITTED-visible).
              const existingInTx =
                await observationRepository.findByChallengeAndValidatorWithinTx(
                  input.organizationScopeId,
                  current.id,
                  actor,
                  tx,
                );
              if (
                existingInTx !== null &&
                existingInTx.idempotencyKey !== input.idempotencyKey
              ) {
                throw new ConflictError(
                  `validator ${actor} already submitted observation ${existingInTx.id} on validation challenge ${current.id}`,
                  {
                    challengeId: current.id,
                    validatorPersonId: actor,
                    existingObservationId: existingInTx.id,
                  },
                );
              }
              const observation: ValidationObservation = Object.freeze({
                id: randomUUID(),
                organizationScopeId: current.organizationScopeId,
                challengeId: current.id,
                assignmentSetId: currentAssignment.setId,
                validatorPersonId: actor,
                participantId: currentEntry.participantId,
                target: Object.freeze({
                  kind: current.target.kind,
                  id: current.target.id,
                }),
                verdict,
                statement: input.statement.trim(),
                evidenceRefs,
                observedAt: input.observedAt,
                protocolVersion: VALIDATION_PROTOCOL_VERSION,
                idempotencyKey: input.idempotencyKey,
                executionId: execution.executionId,
                correlationId: execution.correlationId,
                causationId: execution.causationId,
                createdAt: new Date().toISOString(),
              });
              await observationRepository.createWithinTx(observation, tx);
              const buffer = auditWriter.forTransaction(tx);
              await buffer.append({
                eventType: OBSERVATION_RECORDED,
                context: execution,
                actor,
                subject: observation.id,
                resourceType: "validation_observation",
                resourceId: observation.id,
                metadata: {
                  organizationScopeId: observation.organizationScopeId,
                  observationId: observation.id,
                  challengeId: observation.challengeId,
                  assignmentSetId: observation.assignmentSetId,
                  validatorPersonId: actor,
                  participantId: observation.participantId,
                  target: `${observation.target.kind}:${observation.target.id}`,
                  verdict: observation.verdict,
                  evidenceRefs: observation.evidenceRefs.map(
                    (r) => `${r.kind}:${r.id}`,
                  ),
                  observedAt: observation.observedAt,
                  idempotencyRecordId: ctx.recordId,
                  transactionId: tx.transactionId,
                },
              });
              return observation;
            },
            execution,
          ),
      );
      logger.info("validation_observation.recorded", {
        observationId: applied.result.id,
        challengeId: applied.result.challengeId,
        validatorPersonId: applied.result.validatorPersonId,
        verdict: applied.result.verdict,
        created: applied.executed,
      });
      return { observation: applied.result, created: applied.executed };
    },

    // ------------------------------------------------------------------
    // Derive the terminal quorum outcome (the round closes).
    // ------------------------------------------------------------------
    async deriveOutcome(execution, input) {
      assertIdempotencyKey(input.idempotencyKey);
      validateValidationTimestamp("evaluatedAt", input.evaluatedAt);
      const found = await loadChallengeScoped(
        input.organizationScopeId,
        input.challengeId,
      );
      // NOTE: the closed-round state gate lives ONLY in the in-tx
      // re-check below (same-key replays must reach the idempotency
      // store; fresh keys fail closed in-transaction). Deriving the
      // outcome requires a live assignment set (never a wall clock).
      const assignment = found.assignment;
      if (assignment === null) {
        throw validationError(
          `validation challenge ${found.id} has no derived assignment set — derive assignments before deriving the outcome`,
          { challengeId: found.id },
        );
      }
      if (Date.parse(input.evaluatedAt) < Date.parse(found.effectiveAt)) {
        throw validationError(
          `evaluation anchor ${input.evaluatedAt} precedes the round window start ${found.effectiveAt}`,
          { evaluatedAt: input.evaluatedAt, effectiveAt: found.effectiveAt },
        );
      }

      const key = `validation_outcome:${input.organizationScopeId}:${found.id}:${input.idempotencyKey}`;
      const applied = await idempotency.withLock(
        challengeRecordLockKey(found.id),
        () =>
          idempotency.applyIdempotent(
            key,
            async (ctx) => {
              const tx = ctx.transaction;
              const current = await challengeRepository.findByIdWithinTx(
                found.id,
                tx,
              );
              if (
                !current ||
                current.organizationScopeId !== input.organizationScopeId
              ) {
                throw new NotFoundError(
                  `validation challenge not found: ${found.id}`,
                  { challengeId: found.id },
                );
              }
              if (current.outcome !== null) {
                throw new ConflictError(
                  `validation challenge ${current.id} is CLOSED — closed rounds are immutable`,
                  {
                    challengeId: current.id,
                    outcomeId: current.outcome.outcomeId,
                  },
                );
              }
              const currentAssignment = current.assignment;
              if (currentAssignment === null) {
                throw validationError(
                  `validation challenge ${current.id} has no derived assignment set`,
                  { challengeId: current.id },
                );
              }
              // The RECORDED observations (the only derivation input —
              // reproducible from recorded state).
              const observations =
                await observationRepository.listByChallengeWithinTx(
                  input.organizationScopeId,
                  current.id,
                  tx,
                );

              // ---- THE PURE DETERMINISTIC DERIVATION ---------------------
              const derivation = deriveQuorumOutcome({
                policy: {
                  assignmentCardinality: current.assignmentCardinality,
                  minimumSubmitted: current.minimumSubmitted,
                  upholdThreshold: current.upholdThreshold,
                  rejectThreshold: current.rejectThreshold,
                  challengeWindowMs: 0, // unused by the engine (window bounds passed explicitly)
                  validatorStakeRequirementCredits:
                    current.validatorStakeRequirementCredits,
                },
                windowStartAt: current.effectiveAt,
                windowExpiresAt: current.windowExpiresAt,
                evaluatedAt: input.evaluatedAt,
                assignedValidatorPersonIds: currentAssignment.entries.map(
                  (e) => e.validatorPersonId,
                ),
                observations: observations.map((o) => ({
                  observationId: o.id,
                  validatorPersonId: o.validatorPersonId,
                  verdict: o.verdict,
                  observedAt: o.observedAt,
                })),
              });

              const event = buildEvent(
                "outcome_derived",
                execution,
                execution.actor?.id ?? "unknown",
                `decision ${derivation.decision} at ${input.evaluatedAt}`,
              );
              const outcome: ValidationOutcome = Object.freeze({
                id: randomUUID(),
                challengeId: current.id,
                organizationScopeId: current.organizationScopeId,
                target: Object.freeze({
                  kind: current.target.kind,
                  id: current.target.id,
                }),
                evaluatedAt: input.evaluatedAt,
                decision: derivation.decision,
                policyId: current.policyId,
                policyVersion: current.policyVersion,
                assignment: Object.freeze({
                  setId: currentAssignment.setId,
                  derivedAt: currentAssignment.derivedAt,
                  assignedValidatorPersonIds: Object.freeze(
                    currentAssignment.entries.map((e) => e.validatorPersonId),
                  ),
                }),
                participation: derivation.participation,
                observations: derivation.trace,
                checks: derivation.checks,
                stakeOutcomes: Object.freeze([]),
                applied: null,
                protocolVersion: VALIDATION_PROTOCOL_VERSION,
                idempotencyKey: input.idempotencyKey,
                executionId: execution.executionId,
                correlationId: execution.correlationId,
                causationId: execution.causationId,
                createdAt: event.recordedAt,
              });
              await outcomeRepository.createWithinTx(outcome, tx);
              const updated: ValidationChallenge = Object.freeze({
                ...current,
                outcome: Object.freeze({
                  outcomeId: outcome.id,
                  decidedAt: event.recordedAt,
                }),
                events: Object.freeze([...current.events, event]),
              });
              await challengeRepository.saveWithinTx(updated, tx);
              const buffer = auditWriter.forTransaction(tx);
              await buffer.append({
                eventType: OUTCOME_DERIVED,
                context: execution,
                actor: execution.actor?.id ?? null,
                subject: outcome.id,
                resourceType: "validation_outcome",
                resourceId: outcome.id,
                metadata: {
                  organizationScopeId: outcome.organizationScopeId,
                  outcomeId: outcome.id,
                  challengeId: outcome.challengeId,
                  decision: outcome.decision,
                  evaluatedAt: outcome.evaluatedAt,
                  policyId: outcome.policyId,
                  policyVersion: outcome.policyVersion,
                  participation: outcome.participation,
                  checks: outcome.checks.map(
                    (c) => `${c.check}:${c.passed ? "passed" : c.reason}`,
                  ),
                  excludedObservations: outcome.observations
                    .filter((o) => !o.included)
                    .map((o) => `${o.observationId}:${o.exclusionReason}`),
                  idempotencyRecordId: ctx.recordId,
                  transactionId: tx.transactionId,
                },
              });
              return outcome;
            },
            execution,
          ),
      );
      logger.info("validation_outcome.derived", {
        outcomeId: applied.result.id,
        challengeId: applied.result.challengeId,
        decision: applied.result.decision,
        created: applied.executed,
      });
      return { outcome: applied.result, created: applied.executed };
    },

    // ------------------------------------------------------------------
    // RECORD the stake disposition settlement executed (bookkeeping).
    // ------------------------------------------------------------------
    async recordValidatorStakeOutcome(execution, input) {
      assertIdempotencyKey(input.idempotencyKey);
      if (!isValidatorStakeDisposition(input.disposition)) {
        throw validationError(
          `stake outcome disposition must be RELEASE or FORFEIT (got ${String(input.disposition)})`,
          { disposition: input.disposition },
        );
      }
      // Narrowed const BEFORE the idempotent closure.
      const disposition: ValidatorStakeDisposition = input.disposition;
      if (!input.stakeId?.trim()) {
        throw validationError("stakeId is required", { field: "stakeId" });
      }
      const outcome = await loadOutcomeScoped(
        input.organizationScopeId,
        input.outcomeId,
      );
      // NOTE: the already-recorded state gate lives ONLY in the in-tx
      // re-check below (same-key replays must reach the idempotency
      // store; fresh keys fail closed in-transaction). The stake must
      // be the one bonded to the validator's assignment entry on the
      // challenge (server-side linkage verification).
      const challenge = await loadChallengeScoped(
        input.organizationScopeId,
        outcome.challengeId,
      );
      const entry = challenge.assignment?.entries.find(
        (e) => e.validatorPersonId === input.validatorPersonId,
      );
      if (!entry || entry.stake.stakeId !== input.stakeId) {
        throw validationError(
          `stake ${input.stakeId} is not the stake bonded to validator ${input.validatorPersonId}'s assignment on validation challenge ${challenge.id}`,
          {
            outcomeId: outcome.id,
            challengeId: challenge.id,
            validatorPersonId: input.validatorPersonId,
            stakeId: input.stakeId,
          },
        );
      }
      // VERIFY the settlement authority actually executed the outcome
      // (read-only): the stake must be in the matching terminal state.
      const stake = await lookups.stake.resolveStake(input.stakeId);
      if (!stake) {
        throw new NotFoundError(
          `stake not found in the settlement authority: ${input.stakeId}`,
          { stakeId: input.stakeId },
        );
      }
      const expected =
        input.disposition === "RELEASE" ? "RELEASED" : "FORFEITED";
      if (stake.state !== expected) {
        throw validationError(
          `stake ${input.stakeId} is ${stake.state} in the settlement authority — cannot record disposition ${input.disposition}`,
          { stakeId: input.stakeId, settlementState: stake.state },
        );
      }

      const key = `validation_stake_outcome:${input.outcomeId}:${input.stakeId}:${input.idempotencyKey}`;
      const applied = await idempotency.withLock(
        outcomeRecordLockKey(outcome.id),
        () =>
          idempotency.applyIdempotent(
            key,
            async (ctx) => {
              const tx = ctx.transaction;
              const current = await outcomeRepository.findByIdWithinTx(
                outcome.id,
                tx,
              );
              if (
                !current ||
                current.organizationScopeId !== input.organizationScopeId
              ) {
                throw new NotFoundError(
                  `validation outcome not found: ${outcome.id}`,
                  { outcomeId: outcome.id },
                );
              }
              if (
                current.stakeOutcomes.some((s) => s.stakeId === input.stakeId)
              ) {
                throw new ConflictError(
                  `validation outcome ${current.id} already records a stake outcome for stake ${input.stakeId}`,
                  { outcomeId: current.id, stakeId: input.stakeId },
                );
              }
              const updated: ValidationOutcome = Object.freeze({
                ...current,
                stakeOutcomes: Object.freeze([
                  ...current.stakeOutcomes,
                  Object.freeze({
                    validatorPersonId: input.validatorPersonId,
                    stakeId: input.stakeId,
                    disposition,
                    recordedAt: new Date().toISOString(),
                  }),
                ]),
              });
              await outcomeRepository.saveWithinTx(updated, tx);
              const buffer = auditWriter.forTransaction(tx);
              await buffer.append({
                eventType: OUTCOME_STAKE_OUTCOME_RECORDED,
                context: execution,
                actor: execution.actor?.id ?? null,
                subject: updated.id,
                resourceType: "validation_outcome",
                resourceId: updated.id,
                metadata: {
                  organizationScopeId: updated.organizationScopeId,
                  outcomeId: updated.id,
                  challengeId: updated.challengeId,
                  validatorPersonId: input.validatorPersonId,
                  stakeId: input.stakeId,
                  disposition,
                  settlementState: stake.state,
                  idempotencyRecordId: ctx.recordId,
                  transactionId: tx.transactionId,
                },
              });
              return updated;
            },
            execution,
          ),
      );
      logger.info("validation_outcome.stake_outcome_recorded", {
        outcomeId: applied.result.id,
        validatorPersonId: input.validatorPersonId,
        stakeId: input.stakeId,
        disposition,
      });
      return applied.result;
    },

    // ------------------------------------------------------------------
    // Mark an ACCEPTED outcome applied (ONE-WAY, exactly once).
    // ------------------------------------------------------------------
    async markOutcomeApplied(execution, input) {
      assertIdempotencyKey(input.idempotencyKey);
      if (!isValidationOutcomeApplication(input.application)) {
        throw validationError(
          `application must be one of the closed application vocabulary (got ${String(input.application)})`,
          { application: input.application },
        );
      }
      // Narrowed const BEFORE the idempotent closure.
      const application: ValidationOutcomeApplication = input.application;
      const applier = actingPersonId(execution);
      const outcome = await loadOutcomeScoped(
        input.organizationScopeId,
        input.outcomeId,
      );
      // NOTE: the already-applied state gate lives ONLY in the in-tx
      // re-check below (same-key replays must reach the idempotency
      // store; fresh keys fail closed in-transaction).
      if (!isAcceptedValidationDecision(outcome.decision)) {
        throw validationError(
          `validation outcome ${outcome.id} decided ${outcome.decision} — only ACCEPTED decisions (UPHELD/DENIED) can be applied`,
          { outcomeId: outcome.id, decision: outcome.decision },
        );
      }
      // THE CONFLICT GATE: the applier must NOT be an assigned
      // validator of the round (validators influence decisions only
      // through the protocol — never by applying them).
      const challenge = await loadChallengeScoped(
        input.organizationScopeId,
        outcome.challengeId,
      );
      const assignedIds = challenge.assignment?.entries.map(
        (e) => e.validatorPersonId,
      );
      if (assignedIds?.includes(applier)) {
        throw validationError(
          `person ${applier} is an assigned validator of validation challenge ${challenge.id} and cannot apply its outcome (conflict of interest)`,
          {
            outcomeId: outcome.id,
            challengeId: challenge.id,
            appliedByPersonId: applier,
            conflict: "assigned_validator",
          },
        );
      }

      // VERIFY the OWNING AUTHORITY's mutation is observable BEFORE the
      // application fact is recorded (failed authority application can
      // never be recorded as success). For
      // `reputation_proof_revocation`: the W031 proof's one-way
      // revocation state, read through the neutral proof lookup.
      if (application === "reputation_proof_revocation") {
        if (outcome.target.kind !== "reputation_proof") {
          throw validationError(
            `outcome ${outcome.id} target is ${outcome.target.kind}, not a reputation_proof — reputation_proof_revocation does not apply`,
            { outcomeId: outcome.id, targetKind: outcome.target.kind },
          );
        }
        const proof = await lookups.proofs.resolve(outcome.target.id);
        if (!proof) {
          throw new NotFoundError(
            `reputation proof not found: ${outcome.target.id}`,
            { proofId: outcome.target.id },
          );
        }
        if (proof.organizationScopeId !== input.organizationScopeId) {
          throw validationError(
            `reputation proof ${outcome.target.id} belongs to organization scope ${proof.organizationScopeId}, not ${input.organizationScopeId}`,
            {
              proofId: outcome.target.id,
              proofScope: proof.organizationScopeId,
              requestedScope: input.organizationScopeId,
            },
          );
        }
        if (proof.revokedAt === null) {
          throw validationError(
            `reputation proof ${outcome.target.id} is NOT revoked in the reputation authority — the owning authority's mutation must be observable before the application is recorded`,
            { proofId: outcome.target.id },
          );
        }
      }

      const key = `validation_outcome_application:${input.outcomeId}:${input.idempotencyKey}`;
      const applied = await idempotency.withLock(
        outcomeRecordLockKey(outcome.id),
        () =>
          idempotency.applyIdempotent(
            key,
            async (ctx) => {
              const tx = ctx.transaction;
              const current = await outcomeRepository.findByIdWithinTx(
                outcome.id,
                tx,
              );
              if (
                !current ||
                current.organizationScopeId !== input.organizationScopeId
              ) {
                throw new NotFoundError(
                  `validation outcome not found: ${outcome.id}`,
                  { outcomeId: outcome.id },
                );
              }
              if (current.applied !== null) {
                throw new ConflictError(
                  `validation outcome ${current.id} is already applied`,
                  { outcomeId: current.id },
                );
              }
              const updated: ValidationOutcome = Object.freeze({
                ...current,
                applied: Object.freeze({
                  appliedAt: new Date().toISOString(),
                  appliedByPersonId: applier,
                  application,
                }),
              });
              await outcomeRepository.saveWithinTx(updated, tx);
              const buffer = auditWriter.forTransaction(tx);
              await buffer.append({
                eventType: OUTCOME_APPLIED,
                context: execution,
                actor: applier,
                subject: updated.id,
                resourceType: "validation_outcome",
                resourceId: updated.id,
                metadata: {
                  organizationScopeId: updated.organizationScopeId,
                  outcomeId: updated.id,
                  challengeId: updated.challengeId,
                  decision: updated.decision,
                  application: updated.applied?.application,
                  appliedByPersonId: applier,
                  target: `${updated.target.kind}:${updated.target.id}`,
                  idempotencyRecordId: ctx.recordId,
                  transactionId: tx.transactionId,
                },
              });
              return updated;
            },
            execution,
          ),
      );
      logger.info("validation_outcome.applied", {
        outcomeId: applied.result.id,
        application,
      });
      return applied.result;
    },

    async getOutcome(execution, organizationScopeId, outcomeId) {
      void execution;
      return loadOutcomeScoped(organizationScopeId, outcomeId);
    },

    async listObservations(execution, organizationScopeId, challengeId) {
      void execution;
      return observationRepository.listByChallenge(
        organizationScopeId,
        challengeId,
      );
    },
  };

  return service;
}

export { NotFoundError, OpenConError, ConflictError };
