/**
 * ValidatorRegistryService — domain service for the scoped validator
 * participants (NET-W032 §3.1).
 *
 * Architecture ref: spec/architecture.md §12, §18 (module ownership:
 * /disputes owns the validator eligibility + challenge/dispute
 * coordination); spec/architecture-lock.md §2, §12 (execution
 * lineage).
 *
 * IDENTITY BINDING (work order §3.1: "validator identity must be bound
 * to the authenticated participant; caller-supplied identity claims
 * are not trusted"): the registered person is derived SERVER-SIDE —
 * the execution actor MUST BE the person being registered (one cannot
 * register someone else), and the person must exist through the
 * neutral identity lookup. The participant record IS the persisted
 * eligibility state.
 *
 * ONE-WAY STATUS (the "immutable facts + explicit outcome records"
 * discipline — NO status machine): ACTIVE from registration;
 * SUSPENDED is terminal (eligibility for every future assignment
 * derivation is the projection of the recorded status; the record is
 * never re-activated — a suspended person may only be registered
 * again as a NEW participant record).
 *
 * Determinism: `registeredAt` (the registration bookkeeping timestamp)
 * is the deterministic ordering key for assignment selection
 * (registeredAt, id) — a recorded fact, never a wall clock read in a
 * derivation path.
 *
 * Atomicity: every mutation commits the participant record + the
 * idempotency record + the audit event in ONE authoritative
 * transaction (IdempotencyStore.applyIdempotent).
 *
 * REPLAY-ORDERING (NET-W032 architect re-review on PR #66): the
 * person-existence resolution and the duplicate ACTIVE-participant
 * gate (mutable state reads) run INSIDE the applyIdempotent callback;
 * only pure, request-deterministic input-shape validation runs
 * before the store. A completed same-key replay short-circuits at
 * the store's committed record BEFORE any state is read — even when
 * the participant has since been suspended and a new ACTIVE
 * registration exists — per the repository-wide exactly-once /
 * same-key replay contract. A fresh key still fails closed
 * in-transaction.
 *
 * Lock ordering: per-person registration mutex (the duplicate gate
 * invariant) → the org-scoped idempotency key; per-record mutex → the
 * idempotency key for suspensions (never reversed).
 *
 * Tier compliance: disputes domain → self + core contracts only.
 */

import { randomUUID } from "node:crypto";
import type { TransactionalAuditWriter } from "../core/audit.ts";
import type { ExecutionContext } from "../core/execution-context.ts";
import type { IdempotencyStore } from "../core/idempotency.ts";
import { ConflictError, NotFoundError, OpenConError } from "../core/errors.ts";
import type { Logger } from "../core/logger.ts";
import { VALIDATION_PROTOCOL_VERSION } from "../core/validation.ts";
import type {
  RegisterValidatorInput,
  RegisterValidatorResult,
  RiskSubjectLookup,
  SuspendValidatorInput,
  ValidatorParticipant,
  ValidatorParticipantRepository,
  ValidatorRegistryService,
} from "./port.ts";

const VALIDATOR_REGISTERED = "validator.registered" as const;
const VALIDATOR_SUSPENDED = "validator.suspended" as const;

export interface ValidatorRegistryServiceDeps {
  readonly repository: ValidatorParticipantRepository;
  /** Person existence resolution (identity; read-only). */
  readonly subjectLookup: RiskSubjectLookup;
  readonly idempotency: IdempotencyStore;
  readonly auditWriter: TransactionalAuditWriter;
  readonly logger: Logger;
}

function validatorValidationError(
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

/** The acting person's id (authorization: only persons act as validators). */
function actingPersonId(execution: ExecutionContext): string {
  if (!execution.actor || execution.actor.kind !== "person") {
    throw validatorValidationError(
      "an authenticated person actor is required (service/system actors cannot register, suspend or act as validators)",
      { actorKind: execution.actor?.kind ?? null },
    );
  }
  return execution.actor.id;
}

/** Per-person registration serialization lock (duplicate-gate check-then-act). */
function validatorPersonLockKey(
  organizationScopeId: string,
  personId: string,
): string {
  return `validator_person:${organizationScopeId}:${personId}`;
}

/** Per-record serialization lock (one-way suspension check-then-act). */
function validatorRecordLockKey(validatorId: string): string {
  return `validator_record:${validatorId}`;
}

/** Tenant-scoped load (cross-tenant and nonexistent are indistinguishable). */
async function loadScoped(
  repository: ValidatorParticipantRepository,
  organizationScopeId: string,
  validatorId: string,
): Promise<ValidatorParticipant> {
  const found = await repository.findById(validatorId);
  if (!found || found.organizationScopeId !== organizationScopeId) {
    throw new NotFoundError(`validator not found: ${validatorId}`, {
      validatorId,
    });
  }
  return found;
}

export function createValidatorRegistryService(
  deps: ValidatorRegistryServiceDeps,
): ValidatorRegistryService {
  const { repository, subjectLookup, idempotency, auditWriter, logger } = deps;

  const service: ValidatorRegistryService = {
    // ------------------------------------------------------------------
    // Register a validator participant (the scoped eligibility record).
    // ------------------------------------------------------------------
    async registerValidator(execution, input) {
      if (!input.organizationScopeId?.trim()) {
        throw validatorValidationError("organizationScopeId is required", {
          field: "organizationScopeId",
        });
      }
      if (!input.personId?.trim()) {
        throw validatorValidationError("personId is required", {
          field: "personId",
        });
      }
      if (!input.idempotencyKey?.trim()) {
        throw validatorValidationError("idempotencyKey is required", {
          field: "idempotencyKey",
        });
      }

      // IDENTITY BINDING: the acting person must be the person being
      // registered (server-side; caller-supplied identity claims are
      // never trusted — one cannot register someone else) — a
      // request-deterministic authorization comparison.
      const actor = actingPersonId(execution);
      if (actor !== input.personId) {
        throw validatorValidationError(
          `person ${input.personId} cannot be registered by actor ${actor} (a validator participant binds the acting person — self-registration only)`,
          { personId: input.personId, actorPersonId: actor },
        );
      }

      // REPLAY-ORDERING (architect re-review on PR #66): the person's
      // existence resolution AND the duplicate ACTIVE-participant gate
      // (mutable state reads) run INSIDE the applyIdempotent callback.
      // A completed same-key replay short-circuits at the idempotency
      // store's committed record BEFORE those reads (the exactly-once
      // / same-key replay contract): replaying a registration whose
      // participant has since been SUSPENDED (and a NEW active
      // registration created) still returns the cached original
      // participant instead of tripping the duplicate gate. A
      // genuinely fresh key executes every gate in-transaction and
      // fails closed.
      const key = `validator_register:${input.organizationScopeId}:${input.personId}:${input.idempotencyKey}`;
      // The per-person mutex serializes concurrent registrations of the
      // SAME person (the idempotency key alone is too narrow — the
      // duplicate gate guards the PERSON-slot, not the key). Held
      // through the commit so the in-tx re-check observes the prior
      // registration's COMMITTED record.
      const applied = await idempotency.withLock(
        validatorPersonLockKey(input.organizationScopeId, input.personId),
        () =>
          idempotency.applyIdempotent(
            key,
            async (ctx) => {
              const tx = ctx.transaction;
              // The person must exist through the neutral identity
              // lookup (in-callback so replays short-circuit first).
              if (!(await subjectLookup.exists(input.personId))) {
                throw new NotFoundError(
                  `validator person does not exist: ${input.personId}`,
                  { personId: input.personId },
                );
              }
              // In-tx duplicate re-check (tx-scoped scan): at most ONE
              // ACTIVE participant binds a person in an organization
              // scope. The caller's OWN replay (same idempotency key)
              // is not a duplicate; a foreign one fails closed.
              const activeInTx = await repository.findActiveByPersonWithinTx(
                input.organizationScopeId,
                input.personId,
                tx,
              );
              if (
                activeInTx !== null &&
                activeInTx.idempotencyKey !== input.idempotencyKey
              ) {
                throw new ConflictError(
                  `person ${input.personId} already has an ACTIVE validator participant in organization scope ${input.organizationScopeId} (${activeInTx.id})`,
                  {
                    personId: input.personId,
                    organizationScopeId: input.organizationScopeId,
                    existingValidatorId: activeInTx.id,
                  },
                );
              }
              const validator: ValidatorParticipant = Object.freeze({
                id: randomUUID(),
                organizationScopeId: input.organizationScopeId,
                personId: input.personId,
                status: "ACTIVE",
                registeredAt: new Date().toISOString(),
                suspendedAt: null,
                suspensionReason: null,
                protocolVersion: VALIDATION_PROTOCOL_VERSION,
                idempotencyKey: input.idempotencyKey,
                executionId: execution.executionId,
                correlationId: execution.correlationId,
                causationId: execution.causationId,
              });
              await repository.createWithinTx(validator, tx);
              const buffer = auditWriter.forTransaction(tx);
              await buffer.append({
                eventType: VALIDATOR_REGISTERED,
                context: execution,
                actor: actor,
                subject: validator.id,
                resourceType: "validator_participant",
                resourceId: validator.id,
                metadata: {
                  organizationScopeId: validator.organizationScopeId,
                  validatorId: validator.id,
                  personId: validator.personId,
                  status: validator.status,
                  protocolVersion: validator.protocolVersion,
                  idempotencyRecordId: ctx.recordId,
                  transactionId: tx.transactionId,
                },
              });
              return validator;
            },
            execution,
          ),
      );
      logger.info("validator.registered", {
        validatorId: applied.result.id,
        created: applied.executed,
      });
      return { validator: applied.result, created: applied.executed };
    },

    // ------------------------------------------------------------------
    // Suspend a validator participant (ONE-WAY — terminal).
    // ------------------------------------------------------------------
    async suspendValidator(execution, input) {
      if (!input.organizationScopeId?.trim()) {
        throw validatorValidationError("organizationScopeId is required", {
          field: "organizationScopeId",
        });
      }
      if (!input.validatorId?.trim()) {
        throw validatorValidationError("validatorId is required", {
          field: "validatorId",
        });
      }
      if (!input.reason?.trim()) {
        throw validatorValidationError("reason is required", {
          field: "reason",
        });
      }
      if (!input.idempotencyKey?.trim()) {
        throw validatorValidationError("idempotencyKey is required", {
          field: "idempotencyKey",
        });
      }
      actingPersonId(execution);
      const found = await loadScoped(
        repository,
        input.organizationScopeId,
        input.validatorId,
      );
      // NOTE: the one-way status gate lives ONLY in the in-tx re-check
      // below: a same-key REPLAY must reach the idempotency store
      // (which short-circuits the callback and returns the cached
      // record) — an outer status throw would break replay
      // idempotency. A genuinely fresh key still fails closed
      // in-transaction.

      const key = `validator_suspend:${input.organizationScopeId}:${input.validatorId}:${input.idempotencyKey}`;
      const applied = await idempotency.withLock(
        validatorRecordLockKey(found.id),
        () =>
          idempotency.applyIdempotent(
            key,
            async (ctx) => {
              const tx = ctx.transaction;
              const current = await repository.findByIdWithinTx(found.id, tx);
              if (!current || current.organizationScopeId !== input.organizationScopeId) {
                throw new NotFoundError(`validator not found: ${found.id}`, {
                  validatorId: found.id,
                });
              }
              if (current.status !== "ACTIVE") {
                throw new ConflictError(
                  `validator ${current.id} is already ${current.status} (suspension is one-way)`,
                  { validatorId: current.id, status: current.status },
                );
              }
              const suspendedAt = new Date().toISOString();
              const updated: ValidatorParticipant = Object.freeze({
                ...current,
                status: "SUSPENDED",
                suspendedAt,
                suspensionReason: input.reason.trim(),
              });
              await repository.saveWithinTx(updated, tx);
              const buffer = auditWriter.forTransaction(tx);
              await buffer.append({
                eventType: VALIDATOR_SUSPENDED,
                context: execution,
                actor: execution.actor?.id ?? null,
                subject: updated.id,
                resourceType: "validator_participant",
                resourceId: updated.id,
                metadata: {
                  organizationScopeId: updated.organizationScopeId,
                  validatorId: updated.id,
                  personId: updated.personId,
                  status: updated.status,
                  suspensionReason: updated.suspensionReason,
                  idempotencyRecordId: ctx.recordId,
                  transactionId: tx.transactionId,
                },
              });
              return updated;
            },
            execution,
          ),
      );
      logger.info("validator.suspended", {
        validatorId: applied.result.id,
      });
      return applied.result;
    },

    async getValidator(execution, organizationScopeId, validatorId) {
      void execution;
      return loadScoped(repository, organizationScopeId, validatorId);
    },

    async listValidators(execution, organizationScopeId, status) {
      void execution;
      return repository.listByOrganization(organizationScopeId, status);
    },
  };

  return service;
}
