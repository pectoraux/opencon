/**
 * Authority-backed RiskControlRepository — persists the control-decision
 * records (the workflow/economic gate registry) through the PostgreSQL
 * authority boundary (NET-W003).
 *
 * Work order ref: NET-W009 §3.7 (control decisions + the
 * composition-root gates; lock invariant 21 enforcement point).
 *
 * Storage model: controls live in the `risk_control_decisions`
 * collection, keyed by record id. Controls are append-only state
 * carriers: activation persists one record; resolution flips
 * `state` to RESOLVED through the audited, idempotent control-service
 * command (the resolution lineage is carried on the record; activation
 * history is never rewritten).
 */

import type {
  AuthorityTransaction,
  PostgresAuthority,
} from "../core/postgres-authority.ts";
import type { ExecutionContext } from "../core/execution-context.ts";
import type {
  RiskControlDecision,
  RiskControlRepository,
} from "./port.ts";
import type { RiskOperationClass } from "../core/risk.ts";

const COLLECTION = "risk_control_decisions";

export interface AuthorityRiskControlRepositoryOptions {
  readonly authority: PostgresAuthority;
  readonly logger?: {
    debug(message: string, fields?: Record<string, unknown>): void;
  };
}

function subjectIdOf(control: RiskControlDecision): string[] {
  const ids: string[] = [];
  if (control.subjectPersonId) ids.push(control.subjectPersonId);
  if (control.subjectRef) ids.push(control.subjectRef.subjectId);
  return ids;
}

export function createAuthorityRiskControlRepository(
  opts: AuthorityRiskControlRepositoryOptions,
): RiskControlRepository {
  const authority = opts.authority;
  const logger = opts.logger;

  return {
    async save(control, execution) {
      return authority.run(execution, async (tx) => {
        await tx.put(COLLECTION, control.id, control);
        logger?.debug("risk_control.saved", {
          controlDecisionId: control.id,
          operationClass: control.operationClass,
          state: control.state,
          executionId: execution.executionId,
        });
        return control;
      });
    },

    async findById(id) {
      const rec = await authority.get<RiskControlDecision>(COLLECTION, id);
      return rec ? rec.value : null;
    },

    async listByOrganization(organizationScopeId, states) {
      const records = await authority.scan<RiskControlDecision>(COLLECTION);
      return records
        .map((r) => r.value)
        .filter((c) => c.organizationScopeId === organizationScopeId)
        .filter((c) => states === undefined || states.includes(c.state))
        .sort((a, b) =>
          a.activatedAt === b.activatedAt
            ? a.id < b.id
              ? -1
              : 1
            : a.activatedAt < b.activatedAt
              ? -1
              : 1,
        );
    },

    async findActiveControls(organizationScopeId, operationClass, subjectId) {
      const records = await authority.scan<RiskControlDecision>(COLLECTION);
      return records
        .map((r) => r.value)
        .filter((c) => c.organizationScopeId === organizationScopeId)
        .filter((c) => c.state === "ACTIVE")
        .filter(
          (c) =>
            operationClass === undefined || c.operationClass === operationClass,
        )
        .filter(
          (c) => subjectId === undefined || subjectIdOf(c).includes(subjectId),
        )
        .sort((a, b) =>
          a.activatedAt === b.activatedAt
            ? a.id < b.id
              ? -1
              : 1
            : a.activatedAt < b.activatedAt
              ? -1
              : 1,
        );
    },

    async findByIdWithinTx(id, tx) {
      const rec = await tx.get<RiskControlDecision>(COLLECTION, id);
      return rec ? rec.value : null;
    },

    async createWithinTx(control, tx) {
      await tx.put(COLLECTION, control.id, control);
      logger?.debug("risk_control.created_within_tx", {
        controlDecisionId: control.id,
        operationClass: control.operationClass,
        transactionId: tx.transactionId,
      });
      return control;
    },

    async saveWithinTx(control, tx) {
      await tx.put(COLLECTION, control.id, control);
      logger?.debug("risk_control.saved_within_tx", {
        controlDecisionId: control.id,
        state: control.state,
        transactionId: tx.transactionId,
      });
      return control;
    },
  };
}

export { COLLECTION as RISK_CONTROL_DECISIONS_COLLECTION };
export type { ExecutionContext, AuthorityTransaction, RiskOperationClass };
