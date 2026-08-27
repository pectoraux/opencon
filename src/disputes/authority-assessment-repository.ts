/**
 * Authority-backed RiskAssessmentRepository — persists the immutable
 * risk-assessment records through the PostgreSQL authority boundary
 * (NET-W003).
 *
 * Work order ref: NET-W009 §3.5 (multi-signal provenance-preserving
 * assessments).
 *
 * Storage model: assessments live in the `risk_assessments`
 * collection, keyed by record id. Re-evaluation is append-only: the
 * new assessment carries `supersedesAssessmentId` → the previous
 * latest; the previous latest's `supersededByAssessmentId`
 * back-pointer flips in the same authoritative transaction (a state
 * flip, never a content rewrite — history stays byte-identical).
 */

import type {
  AuthorityTransaction,
  PostgresAuthority,
} from "../core/postgres-authority.ts";
import type { ExecutionContext } from "../core/execution-context.ts";
import type { RiskAssessment, RiskAssessmentRepository } from "./port.ts";

const COLLECTION = "risk_assessments";

export interface AuthorityRiskAssessmentRepositoryOptions {
  readonly authority: PostgresAuthority;
  readonly logger?: {
    debug(message: string, fields?: Record<string, unknown>): void;
  };
}

function forSubject(
  assessments: readonly RiskAssessment[],
  organizationScopeId: string,
  subjectPersonId: string,
): RiskAssessment[] {
  return assessments
    .filter(
      (a) =>
        a.organizationScopeId === organizationScopeId &&
        a.subjectPersonId === subjectPersonId,
    )
    .sort((a, b) =>
      a.recordedAt === b.recordedAt
        ? a.id < b.id
          ? -1
          : 1
        : a.recordedAt < b.recordedAt
          ? -1
          : 1,
    );
}

export function createAuthorityRiskAssessmentRepository(
  opts: AuthorityRiskAssessmentRepositoryOptions,
): RiskAssessmentRepository {
  const authority = opts.authority;
  const logger = opts.logger;

  return {
    async save(assessment, execution) {
      return authority.run(execution, async (tx) => {
        await tx.put(COLLECTION, assessment.id, assessment);
        logger?.debug("risk_assessment.saved", {
          assessmentId: assessment.id,
          state: assessment.state,
          executionId: execution.executionId,
        });
        return assessment;
      });
    },

    async findById(id) {
      const rec = await authority.get<RiskAssessment>(COLLECTION, id);
      return rec ? rec.value : null;
    },

    async listBySubject(organizationScopeId, subjectPersonId) {
      const records = await authority.scan<RiskAssessment>(COLLECTION);
      return forSubject(
        records.map((r) => r.value),
        organizationScopeId,
        subjectPersonId,
      );
    },

    async findLatestBySubject(organizationScopeId, subjectPersonId) {
      const records = await authority.scan<RiskAssessment>(COLLECTION);
      const history = forSubject(
        records.map((r) => r.value),
        organizationScopeId,
        subjectPersonId,
      );
      // The latest = the newest assessment NOT superseded by a later
      // one. With the back-pointer flip the non-superseded tail is the
      // latest; fall back to the last by order for robustness.
      const notSuperseded = history.filter(
        (a) => a.supersededByAssessmentId === null,
      );
      return notSuperseded.length > 0
        ? notSuperseded[notSuperseded.length - 1]!
        : history.length > 0
          ? history[history.length - 1]!
          : null;
    },

    async findByIdWithinTx(id, tx) {
      const rec = await tx.get<RiskAssessment>(COLLECTION, id);
      return rec ? rec.value : null;
    },

    async listBySubjectWithinTx(organizationScopeId, subjectPersonId, tx) {
      const records = await tx.scan<RiskAssessment>(COLLECTION);
      return forSubject(
        records.map((r) => r.value),
        organizationScopeId,
        subjectPersonId,
      );
    },

    async putSupersessionWithinTx(previous, next, tx) {
      // The previous assessment keeps its content byte-identical; ONLY
      // the supersession back-pointer flips. The new assessment is a
      // new record referencing the previous one.
      await tx.put(COLLECTION, previous.id, previous);
      await tx.put(COLLECTION, next.id, next);
      logger?.debug("risk_assessment.supersession_persisted", {
        previousId: previous.id,
        nextId: next.id,
        transactionId: tx.transactionId,
      });
    },

    async createWithinTx(assessment, tx) {
      await tx.put(COLLECTION, assessment.id, assessment);
      logger?.debug("risk_assessment.created_within_tx", {
        assessmentId: assessment.id,
        state: assessment.state,
        transactionId: tx.transactionId,
      });
      return assessment;
    },
  };
}

export { COLLECTION as RISK_ASSESSMENTS_COLLECTION };
export type { ExecutionContext, AuthorityTransaction };
