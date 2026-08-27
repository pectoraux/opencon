/**
 * DisputeService — domain service for participant-initiated challenges,
 * formal disputes, reviewer workflows, appeals and deterministic
 * disposition (NET-W010 §3.3).
 *
 * Architecture ref: spec/architecture.md §12 (challenge mechanisms are
 * part of the fraud posture), §17 (FRAUD_REVIEW stays a workflow
 * exceptional state owned by /workflows), §18 (module ownership:
 * /disputes owns challenges, disputes, appeals and penalties), §19;
 * spec/architecture-lock.md §13 invariant 21 (a disputed claim cannot
 * mature until the applicable resolution policy permits it).
 *
 * THE DETERMINISTIC STATE MACHINE (validated here; state is derived
 * from the append-only event history — events are never rewritten):
 *
 * ```text
 * PENDING_STAKE ──bond_stake──→ OPEN ──start_review──→ UNDER_REVIEW ──resolve──→ RESOLVED ──appeal──→ APPEALED
 *       │                        │ │                                            (a NEW linked APPEAL record opens)
 *       └── withdraw ────────────┘ └── withdraw ──→ WITHDRAWN
 *                                └── reject (also from UNDER_REVIEW) ──→ REJECTED
 * ```
 *
 * AUTHORITY SEPARATION (the work item's strongest constraint):
 *  - this service owns challenge/review DECISIONS only;
 *  - /workflows remains the lifecycle authority (no transition calls
 *    here — workflow consequences flow through the composition root);
 *  - /settlement remains the economic authority: stakes are committed/
 *    released/forfeited ONLY through the settlement boundary's stake
 *    commands, orchestrated at the composition root with compound
 *    idempotency keys (the NET-W009 applyWorkflowHold precedent);
 *    `bondStake` only VERIFIES the settlement record through the
 *    read-only stake lookup, and `markStakeOutcome` only RECORDS what
 *    settlement executed;
 *  - /evidence remains the truth authority (disputes reference and
 *    request re-evaluation — never mutate);
 *  - /reputation remains the trust-signal authority (dispute outcomes
 *    may be consumed later by reputation policy — never rewritten
 *    here).
 *
 * DETERMINISM (invariant 4): eligibility windows take explicit
 * caller-supplied timestamps against authoritative anchors (never a
 * wall clock); the outcome→stake mapping is the pure core function
 * `stakeDispositionForOutcome`; every record carries the policy
 * version lineage. Server-side wall clock is used ONLY for
 * event/audit `recordedAt` bookkeeping (the NET-W009 convention).
 *
 * CONFLICT OF INTEREST: the reviewer (start/reject/resolve) may be
 * neither the challenger nor the subject's beneficiary — checked
 * server-side on every reviewer action (AUD-006).
 *
 * Atomicity: every mutation commits its dispute record + appended
 * events + idempotency record + audit event in ONE authoritative
 * transaction (IdempotencyStore.applyIdempotent; NET-W004-AC-07).
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
  DISPUTE_APPEAL_WINDOW_MS,
  DISPUTE_CHALLENGE_WINDOW_MS,
  DISPUTE_POLICY_VERSION,
  DISPUTE_STAKE_REQUIREMENT_CREDITS,
  appealWindowExpiry,
  challengeWindowExpiry,
  isDisputeControlDisposition,
  isDisputeOutcome,
  isDisputeStakeDisposition,
  isDisputeSubjectType,
  stakeDispositionForOutcome,
  validateDisputeTimestamp,
} from "../core/disputes.ts";
import type {
  AppealDisputeInput,
  AppealDisputeResult,
  BondStakeInput,
  DisputeEvent,
  DisputeEventKind,
  DisputeLookups,
  DisputeRecord,
  DisputeRepository,
  DisputeService,
  MarkStakeOutcomeInput,
  OpenDisputeInput,
  OpenDisputeResult,
  RejectDisputeInput,
  ResolveDisputeInput,
  StartDisputeReviewInput,
  WithdrawDisputeInput,
} from "./port.ts";
import { resolveSources } from "./source-validation.ts";

const DISPUTE_OPENED = "dispute.opened" as const;
const DISPUTE_STAKE_BONDED = "dispute.stake_bonded" as const;
const DISPUTE_REVIEW_STARTED = "dispute.review_started" as const;
const DISPUTE_REJECTED = "dispute.rejected" as const;
const DISPUTE_RESOLVED = "dispute.resolved" as const;
const DISPUTE_APPEALED = "dispute.appealed" as const;
const DISPUTE_WITHDRAWN = "dispute.withdrawn" as const;
const DISPUTE_STAKE_OUTCOME_RECORDED = "dispute.stake_outcome_recorded" as const;

export interface DisputeServiceDeps {
  readonly repository: DisputeRepository;
  readonly lookups: DisputeLookups;
  readonly idempotency: IdempotencyStore;
  readonly auditWriter: TransactionalAuditWriter;
  readonly logger: Logger;
}

function disputeValidationError(
  message: string,
  context: Readonly<Record<string, unknown>>,
): OpenConError {
  return new OpenConError({
    code: "DISPUTE_VALIDATION",
    classification: "validation",
    message,
    context,
  });
}

/** Reason-codes validation (≥1 non-empty code). */
function assertReasonCodes(
  reasonCodes: readonly string[],
  code: string,
): readonly string[] {
  if (
    !Array.isArray(reasonCodes) ||
    reasonCodes.length === 0 ||
    reasonCodes.some((c) => typeof c !== "string" || !c.trim())
  ) {
    throw disputeValidationError(
      `${code} requires reasonCodes (at least one non-empty code)`,
      { reasonCodes },
    );
  }
  return reasonCodes.map((c) => c.trim());
}

function assertIdempotencyKey(idempotencyKey: string): string {
  if (!idempotencyKey?.trim()) {
    throw disputeValidationError("idempotencyKey is required", {
      field: "idempotencyKey",
    });
  }
  return idempotencyKey;
}

/** The acting person's id (authorization: only persons act on disputes). */
function actingPersonId(execution: ExecutionContext): string {
  if (!execution.actor || execution.actor.kind !== "person") {
    throw disputeValidationError(
      "an authenticated person actor is required (service/system actors cannot open, review or resolve disputes)",
      { actorKind: execution.actor?.kind ?? null },
    );
  }
  return execution.actor.id;
}

/** The conflict-of-interest gate (bars the challenger + the beneficiary). */
function assertNotInterestedParty(
  dispute: DisputeRecord,
  reviewerPersonId: string,
): void {
  if (reviewerPersonId === dispute.challengerPersonId) {
    throw disputeValidationError(
      `person ${reviewerPersonId} is the challenger of dispute ${dispute.id} and cannot review it (conflict of interest)`,
      { disputeId: dispute.id, reviewerPersonId, conflict: "challenger" },
    );
  }
  if (
    dispute.subjectBeneficiaryPersonId !== null &&
    reviewerPersonId === dispute.subjectBeneficiaryPersonId
  ) {
    throw disputeValidationError(
      `person ${reviewerPersonId} is the beneficiary of dispute ${dispute.id}'s subject and cannot review it (conflict of interest)`,
      {
        disputeId: dispute.id,
        reviewerPersonId,
        conflict: "subject_beneficiary",
      },
    );
  }
}

/** Build one append-only history event. */
function buildEvent(
  event: DisputeEventKind,
  execution: ExecutionContext,
  actorPersonId: string,
  reasonCodes: readonly string[],
  note: string | null,
  sourceRefs: DisputeEvent["sourceRefs"],
): DisputeEvent {
  return Object.freeze({
    id: randomUUID(),
    event,
    actorPersonId,
    reasonCodes,
    note,
    sourceRefs,
    recordedAt: new Date().toISOString(),
    executionId: execution.executionId,
    correlationId: execution.correlationId,
  });
}

/** Per-subject serialization lock (duplicate-gate check-then-act). */
function disputeSubjectLockKey(
  organizationScopeId: string,
  subjectType: string,
  subjectId: string,
): string {
  return `dispute_subject:${organizationScopeId}:${subjectType}:${subjectId}`;
}

/** Per-record serialization lock (state-machine check-then-act). */
function disputeRecordLockKey(disputeId: string): string {
  return `dispute_record:${disputeId}`;
}

export function createDisputeService(deps: DisputeServiceDeps): DisputeService {
  const { repository, lookups, idempotency, auditWriter, logger } = deps;

  const service: DisputeService = {
    // ------------------------------------------------------------------
    // Challenge request → PENDING_STAKE (the deterministic eligibility
    // gate; the stake is NOT touched here — explicit bonding follows
    // through the settlement authority at the composition root).
    // ------------------------------------------------------------------
    async openDispute(execution, input) {
      if (!input.organizationScopeId?.trim()) {
        throw disputeValidationError("organizationScopeId is required", {
          field: "organizationScopeId",
        });
      }
      if (!input.statement?.trim()) {
        throw disputeValidationError("statement is required", {
          field: "statement",
        });
      }
      assertReasonCodes(input.reasonCodes, "opening a dispute");
      assertIdempotencyKey(input.idempotencyKey);
      validateDisputeTimestamp("effectiveAt", input.effectiveAt);
      if (
        !input.subjectRef ||
        typeof input.subjectRef !== "object" ||
        !isDisputeSubjectType(input.subjectRef.subjectType) ||
        typeof input.subjectRef.subjectId !== "string" ||
        !input.subjectRef.subjectId.trim()
      ) {
        throw disputeValidationError(
          "subjectRef.subjectType must be a standard dispute subject type with a non-empty subjectId",
          { subjectRef: input.subjectRef },
        );
      }

      // Authorization: a person actor (server-side identity).
      const challenger = actingPersonId(execution);
      if (!(await lookups.subject.exists(challenger))) {
        throw disputeValidationError(
          `challenger person does not exist: ${challenger}`,
          { challengerPersonId: challenger },
        );
      }

      // The subject must resolve to an authoritative record in the
      // same organization scope (tenant isolation, invariant 6).
      const resolvedSubject = await lookups.disputeSubject.resolveSubject(
        input.subjectRef.subjectType,
        input.subjectRef.subjectId,
      );
      if (!resolvedSubject) {
        throw new NotFoundError(
          `dispute subject ${input.subjectRef.subjectType}:${input.subjectRef.subjectId} does not resolve to an authoritative record`,
          {
            subjectType: input.subjectRef.subjectType,
            subjectId: input.subjectRef.subjectId,
          },
        );
      }
      if (
        resolvedSubject.organizationScopeId !== input.organizationScopeId
      ) {
        throw disputeValidationError(
          `dispute subject ${input.subjectRef.subjectType}:${input.subjectRef.subjectId} belongs to organization scope ${resolvedSubject.organizationScopeId}, not ${input.organizationScopeId}`,
          {
            subjectType: input.subjectRef.subjectType,
            subjectId: input.subjectRef.subjectId,
            subjectScope: resolvedSubject.organizationScopeId,
            requestedScope: input.organizationScopeId,
          },
        );
      }
      validateDisputeTimestamp("subjectAnchorAt", resolvedSubject.anchorAt);

      // The challenge window: the explicit effectiveAt must fall in
      // [anchorAt, anchorAt + window] (deterministic — no wall clock).
      const anchorMs = Date.parse(resolvedSubject.anchorAt);
      const effectiveMs = Date.parse(input.effectiveAt);
      if (
        effectiveMs < anchorMs ||
        effectiveMs > anchorMs + DISPUTE_CHALLENGE_WINDOW_MS
      ) {
        throw disputeValidationError(
          `challenge window expired (or not yet open) for subject ${input.subjectRef.subjectType}:${input.subjectRef.subjectId}: effectiveAt ${input.effectiveAt} is outside [${resolvedSubject.anchorAt}, ${challengeWindowExpiry(resolvedSubject.anchorAt)}]`,
          {
            subjectType: input.subjectRef.subjectType,
            subjectId: input.subjectRef.subjectId,
            effectiveAt: input.effectiveAt,
            anchorAt: resolvedSubject.anchorAt,
            windowExpiresAt: challengeWindowExpiry(resolvedSubject.anchorAt),
          },
        );
      }

      // ≥1 supporting reference (evidence-backed challenges).
      const supportingRefs = await resolveSources(
        lookups.sources,
        input.organizationScopeId,
        input.supportingRefs,
      );

      const subjectRef = {
        subjectType: input.subjectRef.subjectType,
        subjectId: input.subjectRef.subjectId,
      } as const;

      // Duplicate gate: a subject with a LIVE dispute cycle cannot be
      // challenged again (deterministic; the outcome must resolve or
      // be appealed first — then a fresh challenge targets the new
      // state). The caller's OWN replay (same idempotency key) is not
      // a duplicate — applyIdempotent returns the cached record.
      const live = await repository.findLiveBySubject(
        input.organizationScopeId,
        subjectRef.subjectType,
        subjectRef.subjectId,
      );
      const foreignLive = live.filter(
        (d) => d.idempotencyKey !== input.idempotencyKey,
      );
      if (foreignLive.length > 0) {
        throw new ConflictError(
          `subject ${subjectRef.subjectType}:${subjectRef.subjectId} already has a live dispute cycle (${foreignLive[0]!.id} in state ${foreignLive[0]!.state})`,
          {
            subjectType: subjectRef.subjectType,
            subjectId: subjectRef.subjectId,
            existingDisputeId: foreignLive[0]!.id,
            existingState: foreignLive[0]!.state,
          },
        );
      }

      const key = `dispute_open:${input.organizationScopeId}:${input.idempotencyKey}`;
      // The subject mutex serializes concurrent opens of the SAME
      // subject (the idempotency key alone is too narrow — the
      // duplicate gate guards the SUBJECT, not the key; the same
      // org-independent-lock reasoning as the NET-W007 policy
      // lineages). Held through the commit, so the in-tx duplicate
      // re-check always observes the prior opener's COMMITTED record.
      const applied = await idempotency.withLock(
        disputeSubjectLockKey(
          input.organizationScopeId,
          subjectRef.subjectType,
          subjectRef.subjectId,
        ),
        () =>
          idempotency.applyIdempotent(
            key,
            async (ctx) => {
              const tx = ctx.transaction;
              // In-tx duplicate re-check (tx-scoped scan — a
              // concurrent open of this subject serialized on the
              // subject mutex and its record is COMMITTED-visible).
              const liveInTx = await repository.findLiveBySubjectWithinTx(
                input.organizationScopeId,
                subjectRef.subjectType,
                subjectRef.subjectId,
                tx,
              );
          // The replayed record itself (same idempotency key) is not a
          // duplicate; a DIFFERENT live dispute is.
          const foreign = liveInTx.filter(
            (d) => d.idempotencyKey !== input.idempotencyKey,
          );
          if (foreign.length > 0) {
            throw new ConflictError(
              `subject ${subjectRef.subjectType}:${subjectRef.subjectId} already has a live dispute cycle (${foreign[0]!.id} in state ${foreign[0]!.state})`,
              {
                subjectType: subjectRef.subjectType,
                subjectId: subjectRef.subjectId,
                existingDisputeId: foreign[0]!.id,
              },
            );
          }
          const event = buildEvent(
            "requested",
            execution,
            challenger,
            input.reasonCodes.map((c) => c.trim()),
            input.statement.trim(),
            supportingRefs,
          );
          const dispute: DisputeRecord = Object.freeze({
            id: randomUUID(),
            organizationScopeId: input.organizationScopeId,
            kind: "CHALLENGE",
            appealOfDisputeId: null,
            challengerPersonId: challenger,
            subjectRef,
            subjectAnchorAt: resolvedSubject.anchorAt,
            subjectBeneficiaryPersonId: resolvedSubject.beneficiaryPersonId,
            statement: input.statement.trim(),
            reasonCodes: event.reasonCodes,
            supportingRefs,
            state: "PENDING_STAKE",
            stake: Object.freeze({
              requirement: Object.freeze({
                amount: DISPUTE_STAKE_REQUIREMENT_CREDITS,
                unit: "credits" as const,
              }),
              stakeId: null,
              bondedAt: null,
              disposition: null,
              dispositionAt: null,
            }),
            window: Object.freeze({
              challengeWindowExpiresAt: challengeWindowExpiry(
                resolvedSubject.anchorAt,
              ),
              appealWindowExpiresAt: null,
            }),
            reviewerPersonId: null,
            reviewStartedAt: null,
            resolution: null,
            appealDisputeId: null,
            events: Object.freeze([event]),
            policyVersion: DISPUTE_POLICY_VERSION,
            idempotencyKey: input.idempotencyKey,
            executionId: execution.executionId,
            correlationId: execution.correlationId,
            causationId: execution.causationId,
          });
          await repository.createWithinTx(dispute, tx);
          const buffer = auditWriter.forTransaction(tx);
          await buffer.append({
            eventType: DISPUTE_OPENED,
            context: execution,
            actor: challenger,
            subject: dispute.id,
            resourceType: "dispute",
            resourceId: dispute.id,
            metadata: {
              organizationScopeId: dispute.organizationScopeId,
              kind: dispute.kind,
              challengerPersonId: challenger,
              subjectRef: `${subjectRef.subjectType}:${subjectRef.subjectId}`,
              subjectAnchorAt: dispute.subjectAnchorAt,
              effectiveAt: input.effectiveAt,
              challengeWindowExpiresAt: dispute.window.challengeWindowExpiresAt,
              stakeRequirement: dispute.stake.requirement.amount,
              reasonCodes: dispute.reasonCodes,
              supportingRefs: supportingRefs.map((s) => `${s.kind}:${s.id}`),
              policyVersion: dispute.policyVersion,
              idempotencyRecordId: ctx.recordId,
              transactionId: tx.transactionId,
            },
          });
          return dispute;
            },
            execution,
          ),
      );
      logger.info("dispute.opened", {
        disputeId: applied.result.id,
        created: applied.executed,
      });
      return { dispute: applied.result, created: applied.executed };
    },

    // ------------------------------------------------------------------
    // Bond the settlement authority's committed stake → OPEN.
    // ------------------------------------------------------------------
    async bondStake(execution, input) {
      assertIdempotencyKey(input.idempotencyKey);
      if (!input.stakeId?.trim()) {
        throw disputeValidationError("stakeId is required", {
          field: "stakeId",
        });
      }
      const actor = actingPersonId(execution);
      const found = await repository.findById(input.disputeId);
      if (!found) {
        throw new NotFoundError(`dispute not found: ${input.disputeId}`, {
          disputeId: input.disputeId,
        });
      }
      if (found.state !== "PENDING_STAKE") {
        throw disputeValidationError(
          `dispute ${found.id} is ${found.state}, not PENDING_STAKE — only an unbonded dispute can have a stake bonded`,
          { disputeId: found.id, state: found.state },
        );
      }
      if (actor !== found.challengerPersonId) {
        throw disputeValidationError(
          `only the challenger (${found.challengerPersonId}) can bond the stake of dispute ${found.id}`,
          { disputeId: found.id, actorPersonId: actor },
        );
      }
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
        throw disputeValidationError(
          `stake ${stake.organizationScopeId !== found.organizationScopeId ? input.stakeId : input.stakeId} belongs to organization scope ${stake.organizationScopeId}, not ${found.organizationScopeId}`,
          { stakeId: input.stakeId },
        );
      }
      if (stake.ownerPersonId !== found.challengerPersonId) {
        throw disputeValidationError(
          `stake ${input.stakeId} is owned by ${stake.ownerPersonId}, not the challenger ${found.challengerPersonId}`,
          { stakeId: input.stakeId, ownerPersonId: stake.ownerPersonId },
        );
      }
      if (stake.state !== "COMMITTED") {
        throw disputeValidationError(
          `stake ${input.stakeId} is ${stake.state}, not COMMITTED`,
          { stakeId: input.stakeId, state: stake.state },
        );
      }
      if (stake.unit !== found.stake.requirement.unit) {
        throw disputeValidationError(
          `stake ${input.stakeId} is denominated in ${stake.unit}, not ${found.stake.requirement.unit}`,
          { stakeId: input.stakeId, unit: stake.unit },
        );
      }
      if (stake.amount !== found.stake.requirement.amount) {
        throw disputeValidationError(
          `stake ${input.stakeId} amount ${String(stake.amount)} does not match the dispute's frozen requirement ${String(found.stake.requirement.amount)}`,
          { stakeId: input.stakeId, amount: stake.amount },
        );
      }
      if (
        stake.purposeKind !== "dispute_challenge" ||
        stake.purposeId !== found.id
      ) {
        throw disputeValidationError(
          `stake ${input.stakeId} purpose ${stake.purposeKind}:${stake.purposeId} does not link dispute ${found.id}`,
          {
            stakeId: input.stakeId,
            purposeKind: stake.purposeKind,
            purposeId: stake.purposeId,
          },
        );
      }
      // The bonding deadline: the stake's authoritative committedAt
      // must fall within the challenge window (deterministic).
      if (Date.parse(stake.committedAt) > Date.parse(found.window.challengeWindowExpiresAt)) {
        throw disputeValidationError(
          `stake ${input.stakeId} was committed at ${stake.committedAt}, after the challenge window expired ${found.window.challengeWindowExpiresAt}`,
          {
            stakeId: input.stakeId,
            committedAt: stake.committedAt,
            windowExpiresAt: found.window.challengeWindowExpiresAt,
          },
        );
      }

      const key = `dispute_bond:${found.organizationScopeId}:${input.idempotencyKey}`;
      const applied = await idempotency.withLock(
        disputeRecordLockKey(found.id),
        () =>
          idempotency.applyIdempotent(
            key,
            async (ctx) => {
          const tx = ctx.transaction;
          const current = await repository.findByIdWithinTx(found.id, tx);
          if (!current) {
            throw new NotFoundError(`dispute not found: ${found.id}`, {
              disputeId: found.id,
            });
          }
          if (current.state !== "PENDING_STAKE") {
            throw new ConflictError(
              `dispute ${current.id} is already ${current.state}`,
              { disputeId: current.id, state: current.state },
            );
          }
          const event = buildEvent(
            "stake_bonded",
            execution,
            actor,
            [],
            `stake ${input.stakeId}`,
            [],
          );
          const updated: DisputeRecord = Object.freeze({
            ...current,
            state: "OPEN",
            stake: Object.freeze({
              ...current.stake,
              stakeId: input.stakeId,
              bondedAt: event.recordedAt,
            }),
            events: Object.freeze([...current.events, event]),
          });
          await repository.saveWithinTx(updated, tx);
          const buffer = auditWriter.forTransaction(tx);
          await buffer.append({
            eventType: DISPUTE_STAKE_BONDED,
            context: execution,
            actor,
            subject: updated.id,
            resourceType: "dispute",
            resourceId: updated.id,
            metadata: {
              organizationScopeId: updated.organizationScopeId,
              disputeId: updated.id,
              stakeId: input.stakeId,
              stakeAmount: updated.stake.requirement.amount,
              stakeUnit: updated.stake.requirement.unit,
              state: updated.state,
              idempotencyRecordId: ctx.recordId,
              transactionId: tx.transactionId,
            },
          });
          return updated;
            },
            execution,
          ),
      );
      logger.info("dispute.stake_bonded", {
        disputeId: applied.result.id,
      });
      return applied.result;
    },

    // ------------------------------------------------------------------
    // RECORD the stake outcome the settlement authority executed.
    // ------------------------------------------------------------------
    async markStakeOutcome(execution, input) {
      assertIdempotencyKey(input.idempotencyKey);
      if (!isDisputeStakeDisposition(input.disposition)) {
        throw disputeValidationError(
          `stake outcome disposition must be RELEASE or FORFEIT (got ${String(input.disposition)})`,
          { disposition: input.disposition },
        );
      }
      if (input.disposition === "NONE") {
        throw disputeValidationError(
          "NONE is not an executable stake outcome disposition",
          { disposition: input.disposition },
        );
      }
      const found = await repository.findById(input.disputeId);
      if (!found) {
        throw new NotFoundError(`dispute not found: ${input.disputeId}`, {
          disputeId: input.disputeId,
        });
      }
      if (found.stake.stakeId !== input.stakeId) {
        throw disputeValidationError(
          `stake ${input.stakeId} is not the stake bonded to dispute ${found.id} (${String(found.stake.stakeId)})`,
          { disputeId: found.id, stakeId: input.stakeId },
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
      const expected = input.disposition === "RELEASE" ? "RELEASED" : "FORFEITED";
      if (stake.state !== expected) {
        throw disputeValidationError(
          `stake ${input.stakeId} is ${stake.state} in the settlement authority — cannot record disposition ${input.disposition}`,
          { stakeId: input.stakeId, settlementState: stake.state },
        );
      }

      const key = `dispute_stake_outcome:${found.organizationScopeId}:${input.idempotencyKey}`;
      const applied = await idempotency.withLock(
        disputeRecordLockKey(found.id),
        () =>
          idempotency.applyIdempotent(
            key,
            async (ctx) => {
          const tx = ctx.transaction;
          const current = await repository.findByIdWithinTx(found.id, tx);
          if (!current) {
            throw new NotFoundError(`dispute not found: ${found.id}`, {
              disputeId: found.id,
            });
          }
          if (current.stake.disposition !== null) {
            throw new ConflictError(
              `dispute ${current.id} already records a stake disposition (${current.stake.disposition})`,
              { disputeId: current.id, disposition: current.stake.disposition },
            );
          }
          const event = buildEvent(
            "stake_outcome_recorded",
            execution,
            execution.actor?.id ?? "unknown",
            [input.disposition === "RELEASE" ? "stake_released" : "stake_forfeited"],
            input.transactionId
              ? `settlement transaction ${input.transactionId}`
              : null,
            [],
          );
          const updated: DisputeRecord = Object.freeze({
            ...current,
            stake: Object.freeze({
              ...current.stake,
              disposition: input.disposition as "RELEASE" | "FORFEIT",
              dispositionAt: event.recordedAt,
            }),
            events: Object.freeze([...current.events, event]),
          });
          await repository.saveWithinTx(updated, tx);
          const buffer = auditWriter.forTransaction(tx);
          await buffer.append({
            eventType: DISPUTE_STAKE_OUTCOME_RECORDED,
            context: execution,
            actor: execution.actor?.id ?? null,
            subject: updated.id,
            resourceType: "dispute",
            resourceId: updated.id,
            metadata: {
              organizationScopeId: updated.organizationScopeId,
              disputeId: updated.id,
              stakeId: input.stakeId,
              disposition: input.disposition,
              settlementTransactionId: input.transactionId,
              idempotencyRecordId: ctx.recordId,
              transactionId: tx.transactionId,
            },
          });
          return updated;
            },
            execution,
          ),
      );
      logger.info("dispute.stake_outcome_recorded", {
        disputeId: applied.result.id,
        disposition: input.disposition,
      });
      return applied.result;
    },

    // ------------------------------------------------------------------
    // Review start (OPEN → UNDER_REVIEW) with the COI gate.
    // ------------------------------------------------------------------
    async startReview(execution, input) {
      assertIdempotencyKey(input.idempotencyKey);
      const reviewer = actingPersonId(execution);
      const found = await repository.findById(input.disputeId);
      if (!found) {
        throw new NotFoundError(`dispute not found: ${input.disputeId}`, {
          disputeId: input.disputeId,
        });
      }
      if (found.state !== "OPEN") {
        throw disputeValidationError(
          `dispute ${found.id} is ${found.state}, not OPEN — review starts only from OPEN`,
          { disputeId: found.id, state: found.state },
        );
      }
      assertNotInterestedParty(found, reviewer);
      const reasonCodes =
        input.reasonCodes !== undefined
          ? assertReasonCodes(input.reasonCodes, "starting a review")
          : [];

      const key = `dispute_review:${found.organizationScopeId}:${input.idempotencyKey}`;
      const applied = await idempotency.withLock(
        disputeRecordLockKey(found.id),
        () =>
          idempotency.applyIdempotent(
            key,
            async (ctx) => {
          const tx = ctx.transaction;
          const current = await repository.findByIdWithinTx(found.id, tx);
          if (!current) {
            throw new NotFoundError(`dispute not found: ${found.id}`, {
              disputeId: found.id,
            });
          }
          if (current.state !== "OPEN") {
            throw new ConflictError(
              `dispute ${current.id} is already ${current.state}`,
              { disputeId: current.id, state: current.state },
            );
          }
          const event = buildEvent(
            "review_started",
            execution,
            reviewer,
            reasonCodes,
            input.note?.trim() || null,
            [],
          );
          const updated: DisputeRecord = Object.freeze({
            ...current,
            state: "UNDER_REVIEW",
            reviewerPersonId: reviewer,
            reviewStartedAt: event.recordedAt,
            events: Object.freeze([...current.events, event]),
          });
          await repository.saveWithinTx(updated, tx);
          const buffer = auditWriter.forTransaction(tx);
          await buffer.append({
            eventType: DISPUTE_REVIEW_STARTED,
            context: execution,
            actor: reviewer,
            subject: updated.id,
            resourceType: "dispute",
            resourceId: updated.id,
            metadata: {
              organizationScopeId: updated.organizationScopeId,
              disputeId: updated.id,
              reviewerPersonId: reviewer,
              state: updated.state,
              idempotencyRecordId: ctx.recordId,
              transactionId: tx.transactionId,
            },
          });
          return updated;
            },
            execution,
          ),
      );
      logger.info("dispute.review_started", { disputeId: applied.result.id });
      return applied.result;
    },

    // ------------------------------------------------------------------
    // Rejection (inadmissible; stake disposition deterministically
    // RELEASE — the composite releases through settlement afterwards).
    // ------------------------------------------------------------------
    async rejectDispute(execution, input) {
      assertIdempotencyKey(input.idempotencyKey);
      const reviewer = actingPersonId(execution);
      const reasonCodes = assertReasonCodes(
        input.reasonCodes,
        "rejecting a dispute",
      );
      const found = await repository.findById(input.disputeId);
      if (!found) {
        throw new NotFoundError(`dispute not found: ${input.disputeId}`, {
          disputeId: input.disputeId,
        });
      }
      if (found.state !== "OPEN" && found.state !== "UNDER_REVIEW") {
        throw disputeValidationError(
          `dispute ${found.id} is ${found.state} — a rejection is legal only from OPEN or UNDER_REVIEW`,
          { disputeId: found.id, state: found.state },
        );
      }
      assertNotInterestedParty(found, reviewer);
      const sourceRefs = await resolveSources(
        lookups.sources,
        found.organizationScopeId,
        input.sourceRefs,
      );

      const key = `dispute_reject:${found.organizationScopeId}:${input.idempotencyKey}`;
      const applied = await idempotency.withLock(
        disputeRecordLockKey(found.id),
        () =>
          idempotency.applyIdempotent(
            key,
            async (ctx) => {
          const tx = ctx.transaction;
          const current = await repository.findByIdWithinTx(found.id, tx);
          if (!current) {
            throw new NotFoundError(`dispute not found: ${found.id}`, {
              disputeId: found.id,
            });
          }
          if (current.state !== "OPEN" && current.state !== "UNDER_REVIEW") {
            throw new ConflictError(
              `dispute ${current.id} is already ${current.state}`,
              { disputeId: current.id, state: current.state },
            );
          }
          const event = buildEvent(
            "rejected",
            execution,
            reviewer,
            reasonCodes,
            input.note?.trim() || null,
            sourceRefs,
          );
          const updated: DisputeRecord = Object.freeze({
            ...current,
            state: "REJECTED",
            events: Object.freeze([...current.events, event]),
          });
          await repository.saveWithinTx(updated, tx);
          const buffer = auditWriter.forTransaction(tx);
          await buffer.append({
            eventType: DISPUTE_REJECTED,
            context: execution,
            actor: reviewer,
            subject: updated.id,
            resourceType: "dispute",
            resourceId: updated.id,
            metadata: {
              organizationScopeId: updated.organizationScopeId,
              disputeId: updated.id,
              reviewerPersonId: reviewer,
              reasonCodes,
              sourceRefs: sourceRefs.map((s) => `${s.kind}:${s.id}`),
              stakeDisposition: "RELEASE",
              state: updated.state,
              idempotencyRecordId: ctx.recordId,
              transactionId: tx.transactionId,
            },
          });
          return updated;
            },
            execution,
          ),
      );
      logger.info("dispute.rejected", { disputeId: applied.result.id });
      return applied.result;
    },

    // ------------------------------------------------------------------
    // Resolution on the merits (UNDER_REVIEW → RESOLVED).
    // ------------------------------------------------------------------
    async resolveDispute(execution, input) {
      assertIdempotencyKey(input.idempotencyKey);
      if (!isDisputeOutcome(input.outcome)) {
        throw disputeValidationError(
          `outcome must be one of UPHELD, DENIED, DISMISSED (got ${String(input.outcome)})`,
          { outcome: input.outcome },
        );
      }
      if (!isDisputeControlDisposition(input.controlDisposition)) {
        throw disputeValidationError(
          `controlDisposition must be one of MAINTAIN_CONTROL, RELEASE_CONTROL, REQUIRE_REEVALUATION (got ${String(input.controlDisposition)})`,
          { controlDisposition: input.controlDisposition },
        );
      }
      const reasonCodes = assertReasonCodes(
        input.reasonCodes,
        "resolving a dispute",
      );
      const reviewer = actingPersonId(execution);
      const found = await repository.findById(input.disputeId);
      if (!found) {
        throw new NotFoundError(`dispute not found: ${input.disputeId}`, {
          disputeId: input.disputeId,
        });
      }
      if (found.state !== "UNDER_REVIEW") {
        throw disputeValidationError(
          `dispute ${found.id} is ${found.state}, not UNDER_REVIEW — due process requires a started review before resolution`,
          { disputeId: found.id, state: found.state },
        );
      }
      assertNotInterestedParty(found, reviewer);
      const sourceRefs = await resolveSources(
        lookups.sources,
        found.organizationScopeId,
        input.sourceRefs,
      );
      // The DETERMINISTIC outcome→stake mapping (reviewers cannot
      // override — invariant 4). Captured as narrowed consts BEFORE
      // the idempotent closure (type-narrowing does not cross into
      // callbacks).
      const outcome = input.outcome;
      const controlDisposition = input.controlDisposition;
      const stakeDisposition = stakeDispositionForOutcome(outcome);

      const key = `dispute_resolve:${found.organizationScopeId}:${input.idempotencyKey}`;
      const applied = await idempotency.withLock(
        disputeRecordLockKey(found.id),
        () =>
          idempotency.applyIdempotent(
            key,
            async (ctx) => {
          const tx = ctx.transaction;
          const current = await repository.findByIdWithinTx(found.id, tx);
          if (!current) {
            throw new NotFoundError(`dispute not found: ${found.id}`, {
              disputeId: found.id,
            });
          }
          if (current.state !== "UNDER_REVIEW") {
            throw new ConflictError(
              `dispute ${current.id} is already ${current.state}`,
              { disputeId: current.id, state: current.state },
            );
          }
          const event = buildEvent(
            "resolved",
            execution,
            reviewer,
            reasonCodes,
            input.note?.trim() || null,
            sourceRefs,
          );
          const updated: DisputeRecord = Object.freeze({
            ...current,
            state: "RESOLVED",
            resolution: Object.freeze({
              outcome,
              controlDisposition,
              stakeDisposition,
              resolvedBy: reviewer,
              resolvedAt: event.recordedAt,
              appealWindowExpiresAt: appealWindowExpiry(event.recordedAt),
            }),
            window: Object.freeze({
              ...current.window,
              appealWindowExpiresAt: appealWindowExpiry(event.recordedAt),
            }),
            events: Object.freeze([...current.events, event]),
          });
          await repository.saveWithinTx(updated, tx);
          const buffer = auditWriter.forTransaction(tx);
          await buffer.append({
            eventType: DISPUTE_RESOLVED,
            context: execution,
            actor: reviewer,
            subject: updated.id,
            resourceType: "dispute",
            resourceId: updated.id,
            metadata: {
              organizationScopeId: updated.organizationScopeId,
              disputeId: updated.id,
              reviewerPersonId: reviewer,
              outcome,
              controlDisposition,
              stakeDisposition,
              reasonCodes,
              sourceRefs: sourceRefs.map((s) => `${s.kind}:${s.id}`),
              resolvedAt: updated.resolution?.resolvedAt,
              appealWindowExpiresAt: updated.resolution?.appealWindowExpiresAt,
              state: updated.state,
              idempotencyRecordId: ctx.recordId,
              transactionId: tx.transactionId,
            },
          });
          return updated;
            },
            execution,
          ),
      );
      logger.info("dispute.resolved", {
        disputeId: applied.result.id,
        outcome: input.outcome,
      });
      return applied.result;
    },

    // ------------------------------------------------------------------
    // Appeal: NEW linked record + original flips to terminal APPEALED
    // (append-only — the original's resolution stays byte-identical).
    // ------------------------------------------------------------------
    async appealDispute(execution, input) {
      assertIdempotencyKey(input.idempotencyKey);
      if (!input.statement?.trim()) {
        throw disputeValidationError("statement is required", {
          field: "statement",
        });
      }
      assertReasonCodes(input.reasonCodes, "appealing a dispute");
      validateDisputeTimestamp("effectiveAt", input.effectiveAt);
      const appellant = actingPersonId(execution);
      const found = await repository.findById(input.disputeId);
      if (!found) {
        throw new NotFoundError(`dispute not found: ${input.disputeId}`, {
          disputeId: input.disputeId,
        });
      }
      if (found.state !== "RESOLVED" || !found.resolution) {
        throw disputeValidationError(
          `dispute ${found.id} is ${found.state}, not RESOLVED — only a resolved dispute's outcome can be appealed`,
          { disputeId: found.id, state: found.state },
        );
      }
      // Standing: the appellant is an interested party (the original
      // challenger or the subject's beneficiary).
      if (
        appellant !== found.challengerPersonId &&
        appellant !== found.subjectBeneficiaryPersonId
      ) {
        throw disputeValidationError(
          `person ${appellant} has no standing to appeal dispute ${found.id} (neither the challenger ${found.challengerPersonId} nor the subject beneficiary ${String(found.subjectBeneficiaryPersonId)})`,
          {
            disputeId: found.id,
            appellantPersonId: appellant,
          },
        );
      }
      // The appeal window: explicit effectiveAt within
      // [resolvedAt, resolvedAt + window] (deterministic).
      const resolvedMs = Date.parse(found.resolution.resolvedAt);
      const effectiveMs = Date.parse(input.effectiveAt);
      if (
        effectiveMs < resolvedMs ||
        effectiveMs > resolvedMs + DISPUTE_APPEAL_WINDOW_MS
      ) {
        throw disputeValidationError(
          `appeal window expired (or not yet open) for dispute ${found.id}: effectiveAt ${input.effectiveAt} is outside [${found.resolution.resolvedAt}, ${appealWindowExpiry(found.resolution.resolvedAt)}]`,
          {
            disputeId: found.id,
            effectiveAt: input.effectiveAt,
            resolvedAt: found.resolution.resolvedAt,
            windowExpiresAt: appealWindowExpiry(found.resolution.resolvedAt),
          },
        );
      }
      const supportingRefs = await resolveSources(
        lookups.sources,
        found.organizationScopeId,
        input.supportingRefs,
      );

      const key = `dispute_appeal:${found.organizationScopeId}:${input.idempotencyKey}`;
      const applied = await idempotency.withLock(
        disputeRecordLockKey(found.id),
        () =>
          idempotency.applyIdempotent(
            key,
            async (ctx) => {
          const tx = ctx.transaction;
          const original = await repository.findByIdWithinTx(found.id, tx);
          if (!original) {
            throw new NotFoundError(`dispute not found: ${found.id}`, {
              disputeId: found.id,
            });
          }
          if (original.state !== "RESOLVED") {
            throw new ConflictError(
              `dispute ${original.id} is already ${original.state}`,
              { disputeId: original.id, state: original.state },
            );
          }
          if (original.appealDisputeId !== null) {
            throw new ConflictError(
              `dispute ${original.id} was already appealed (${original.appealDisputeId}) — appeal the linked record's outcome instead`,
              { disputeId: original.id, appealDisputeId: original.appealDisputeId },
            );
          }
          // 1. The NEW linked appeal record (its own stake cycle; the
          //    bonding deadline is the original's appeal window).
          const appealId = randomUUID();
          const appealEvent = buildEvent(
            "requested",
            execution,
            appellant,
            input.reasonCodes.map((c) => c.trim()),
            input.statement.trim(),
            supportingRefs,
          );
          const appealRecord: DisputeRecord = Object.freeze({
            id: appealId,
            organizationScopeId: original.organizationScopeId,
            kind: "APPEAL",
            appealOfDisputeId: original.id,
            challengerPersonId: appellant,
            subjectRef: original.subjectRef,
            subjectAnchorAt: original.subjectAnchorAt,
            subjectBeneficiaryPersonId: original.subjectBeneficiaryPersonId,
            statement: input.statement.trim(),
            reasonCodes: appealEvent.reasonCodes,
            supportingRefs,
            state: "PENDING_STAKE",
            stake: Object.freeze({
              requirement: Object.freeze({
                amount: DISPUTE_STAKE_REQUIREMENT_CREDITS,
                unit: "credits" as const,
              }),
              stakeId: null,
              bondedAt: null,
              disposition: null,
              dispositionAt: null,
            }),
            window: Object.freeze({
              challengeWindowExpiresAt:
                original.resolution!.appealWindowExpiresAt,
              appealWindowExpiresAt: null,
            }),
            reviewerPersonId: null,
            reviewStartedAt: null,
            resolution: null,
            appealDisputeId: null,
            events: Object.freeze([appealEvent]),
            policyVersion: DISPUTE_POLICY_VERSION,
            idempotencyKey: input.idempotencyKey,
            executionId: execution.executionId,
            correlationId: execution.correlationId,
            causationId: execution.executionId,
          });
          await repository.createWithinTx(appealRecord, tx);
          // 2. The original flips to terminal APPEALED (append-only
          //    event + forward pointer; the resolution block and all
          //    prior events stay byte-identical).
          const appealedEvent = buildEvent(
            "appealed",
            execution,
            appellant,
            input.reasonCodes.map((c) => c.trim()),
            `appealed by ${appellant}: ${input.statement.trim()}`,
            supportingRefs,
          );
          const updatedOriginal: DisputeRecord = Object.freeze({
            ...original,
            state: "APPEALED",
            appealDisputeId: appealId,
            events: Object.freeze([...original.events, appealedEvent]),
          });
          await repository.saveWithinTx(updatedOriginal, tx);
          const buffer = auditWriter.forTransaction(tx);
          await buffer.append({
            eventType: DISPUTE_APPEALED,
            context: execution,
            actor: appellant,
            subject: original.id,
            resourceType: "dispute",
            resourceId: original.id,
            metadata: {
              organizationScopeId: original.organizationScopeId,
              disputeId: original.id,
              appealDisputeId: appealId,
              appellantPersonId: appellant,
              originalOutcome: original.resolution?.outcome,
              appealWindowExpiresAt:
                original.resolution?.appealWindowExpiresAt,
              effectiveAt: input.effectiveAt,
              reasonCodes: appealEvent.reasonCodes,
              supportingRefs: supportingRefs.map((s) => `${s.kind}:${s.id}`),
              idempotencyRecordId: ctx.recordId,
              transactionId: tx.transactionId,
            },
          });
          return { original: updatedOriginal, appeal: appealRecord };
            },
            execution,
          ),
      );
      logger.info("dispute.appealed", {
        disputeId: applied.result.original.id,
        appealDisputeId: applied.result.appeal.id,
      });
      return { ...applied.result, created: applied.executed };
    },

    // ------------------------------------------------------------------
    // Withdrawal (the challenger, before resolution).
    // ------------------------------------------------------------------
    async withdrawDispute(execution, input) {
      assertIdempotencyKey(input.idempotencyKey);
      const actor = actingPersonId(execution);
      const found = await repository.findById(input.disputeId);
      if (!found) {
        throw new NotFoundError(`dispute not found: ${input.disputeId}`, {
          disputeId: input.disputeId,
        });
      }
      if (actor !== found.challengerPersonId) {
        throw disputeValidationError(
          `only the challenger (${found.challengerPersonId}) can withdraw dispute ${found.id}`,
          { disputeId: found.id, actorPersonId: actor },
        );
      }
      if (found.state !== "PENDING_STAKE" && found.state !== "OPEN") {
        throw disputeValidationError(
          `dispute ${found.id} is ${found.state} — withdrawal is legal only before the review resolves`,
          { disputeId: found.id, state: found.state },
        );
      }

      const key = `dispute_withdraw:${found.organizationScopeId}:${input.idempotencyKey}`;
      const applied = await idempotency.withLock(
        disputeRecordLockKey(found.id),
        () =>
          idempotency.applyIdempotent(
            key,
            async (ctx) => {
          const tx = ctx.transaction;
          const current = await repository.findByIdWithinTx(found.id, tx);
          if (!current) {
            throw new NotFoundError(`dispute not found: ${found.id}`, {
              disputeId: found.id,
            });
          }
          if (current.state !== "PENDING_STAKE" && current.state !== "OPEN") {
            throw new ConflictError(
              `dispute ${current.id} is already ${current.state}`,
              { disputeId: current.id, state: current.state },
            );
          }
          const event = buildEvent(
            "withdrawn",
            execution,
            actor,
            ["withdrawn_by_challenger"],
            input.reason?.trim() || null,
            [],
          );
          const updated: DisputeRecord = Object.freeze({
            ...current,
            state: "WITHDRAWN",
            events: Object.freeze([...current.events, event]),
          });
          await repository.saveWithinTx(updated, tx);
          const buffer = auditWriter.forTransaction(tx);
          await buffer.append({
            eventType: DISPUTE_WITHDRAWN,
            context: execution,
            actor,
            subject: updated.id,
            resourceType: "dispute",
            resourceId: updated.id,
            metadata: {
              organizationScopeId: updated.organizationScopeId,
              disputeId: updated.id,
              challengerPersonId: actor,
              stakeDisposition:
                current.stake.stakeId !== null ? "RELEASE" : "NONE",
              state: updated.state,
              idempotencyRecordId: ctx.recordId,
              transactionId: tx.transactionId,
            },
          });
          return updated;
            },
            execution,
          ),
      );
      logger.info("dispute.withdrawn", { disputeId: applied.result.id });
      return applied.result;
    },

    // ------------------------------------------------------------------
    // Reads.
    // ------------------------------------------------------------------
    async getDispute(_execution, id) {
      const found = await repository.findById(id);
      if (!found) {
        throw new NotFoundError(`dispute not found: ${id}`, { disputeId: id });
      }
      return found;
    },

    async listDisputes(_execution, organizationScopeId, states) {
      return repository.listByOrganization(organizationScopeId, states);
    },

    async listActiveBySubjectIds(
      _execution,
      organizationScopeId,
      subjectIds,
    ) {
      return repository.findActiveBySubjectIds(
        organizationScopeId,
        subjectIds,
      );
    },
  };

  return service;
}

export { NotFoundError, OpenConError, ConflictError };
export type { ExecutionContext };
