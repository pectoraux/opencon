/**
 * QualityService — the NET-W013 quality authority implementation.
 *
 * Work order ref: spec/work-orders/NET-W013.md §3.2.
 *
 * Authority separation (work order §4 invariants 5–6 — mechanical):
 *  - this service never mutates lifecycle state (evaluations are
 *    decision-support snapshots; /workflows keeps the authority);
 *  - this service never posts ledger movements, never creates
 *    evidence/outcomes/reputation records — it READS the truth
 *    authorities through the neutral lookups and re-resolves the
 *    Proof-of-Helpfulness's recorded bases at evaluation time;
 *  - the PURE engine (src/contributions/quality-engine.ts) computes
 *    every evaluation deterministically;
 *  - every mutation runs through the NET-W004 IdempotencyStore with
 *    per-record mutexes, in-tx re-checks, replay tolerance and
 *    transactional audit lineage;
 *  - the pinned policy version is validated SAME-SCOPE INSIDE the
 *    authoritative transaction (the NET-W012 PR #24 remediation
 *    lesson applied from day one).
 */

import { createHash, randomUUID } from "node:crypto";
import type { AuditWriter } from "../core/audit.ts";
import type { ExecutionContext } from "../core/execution-context.ts";
import { ConflictError, NotFoundError, OpenConError } from "../core/errors.ts";
import type { IdempotencyStore } from "../core/idempotency.ts";
import type { TransactionalAuditWriter } from "../core/audit.ts";
import type { Logger } from "../core/logger.ts";
import {
  QUALITY_POLICY_FORMAT,
  isQualityAdvisoryKind,
  validateQualityPolicyShape,
  validateQualityScore,
} from "../core/moderation.ts";
import type { QualityPolicyShape } from "../core/moderation.ts";
import {
  evaluateQuality,
} from "./quality-engine.ts";
import type {
  QualityEngineFacts,
  QualityEnginePolicy,
  QualityEvidenceFact,
  QualityMeasuredOutcomeFact,
  QualityPovFact,
} from "./quality-engine.ts";
import type {
  AdvisoryQualityScore,
  AdvisoryQualityScoreRepository,
  AttachAdvisoryQualityScoreInput,
  Contribution,
  ContributionRepository,
  DefineQualityPolicyInput,
  DefineQualityPolicyResult,
  PreviewQualityEvaluationInput,
  PreviewQualityEvaluationResult,
  ProofOfHelpfulnessRepository,
  QualityEvaluation,
  QualityEvaluationRepository,
  QualityInputContribution,
  QualityLookups,
  QualityPolicy,
  QualityPolicyRepository,
  QualityService,
  RecordQualityEvaluationInput,
  RecordQualityEvaluationResult,
} from "./port.ts";
import type { ProofOfHelpfulness } from "./port.ts";

const QUALITY_POLICY_VERSION_CREATED = "quality_policy.version_created" as const;
const QUALITY_ADVISORY_RECORDED = "quality_advisory.recorded" as const;
const QUALITY_EVALUATION_RECORDED = "quality_evaluation.recorded" as const;

function qualityError(
  code: string,
  classification: "validation" | "authorization",
  message: string,
  context: Readonly<Record<string, unknown>>,
): OpenConError {
  return new OpenConError({ code, classification, message, context });
}

function validationError(
  message: string,
  context: Readonly<Record<string, unknown>>,
): OpenConError {
  return qualityError("QUALITY_VALIDATION", "validation", message, context);
}

function assertIdempotencyKey(idempotencyKey: string): string {
  if (!idempotencyKey?.trim()) {
    throw validationError("idempotencyKey is required", {
      field: "idempotencyKey",
    });
  }
  return idempotencyKey;
}

/** The acting person's id (mutations that require a person actor). */
function actingPersonId(execution: ExecutionContext, what: string): string {
  if (!execution.actor || execution.actor.kind !== "person") {
    throw qualityError(
      "QUALITY_FORBIDDEN",
      "authorization",
      `an authenticated person actor is required to ${what} (service/system actors cannot)`,
      { actorKind: execution.actor?.kind ?? null },
    );
  }
  return execution.actor.id;
}

/** The org-independent quality policy lineage mutex key. */
function qualityPolicyLineageLockKey(policyId: string): string {
  return `quality_policy_lineage:${policyId}`;
}

/** The per-contribution quality mutex key. */
function contributionQualityLockKey(contributionId: string): string {
  return `contribution_quality:${contributionId}`;
}

/** ISO-timestamp validation (the determinism anchor). */
function assertIsoTimestamp(value: string, field: string): string {
  if (
    typeof value !== "string" ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/.test(
      value,
    )
  ) {
    throw validationError(`${field} must be an ISO-8601 timestamp`, {
      field,
      value,
    });
  }
  return value;
}

/** The canonical SHA-256 digest over an evaluation payload. */
function computeEvaluationDigest(payload: {
  readonly qualityPolicyId: string;
  readonly qualityPolicyVersion: number;
  readonly evaluatedAt: string;
  readonly inputContributions: readonly QualityInputContribution[];
  readonly advisoryCount: number;
  readonly advisoryAverage: number | null;
  readonly score: number;
  readonly band: string;
  readonly reasons: readonly string[];
}): string {
  const canonical = JSON.stringify({
    qualityPolicyId: payload.qualityPolicyId,
    qualityPolicyVersion: payload.qualityPolicyVersion,
    evaluatedAt: payload.evaluatedAt,
    inputContributions: payload.inputContributions.map((c) => ({
      kind: c.kind,
      count: c.count,
      attainment: c.attainment,
      weight: c.weight,
    })),
    advisoryCount: payload.advisoryCount,
    advisoryAverage: payload.advisoryAverage,
    score: payload.score,
    band: payload.band,
    reasons: [...payload.reasons],
  });
  return createHash("sha256").update(canonical, "utf8").digest("hex");
}

export interface CreateQualityServiceOptions {
  readonly contributionRepository: ContributionRepository;
  readonly policyRepository: QualityPolicyRepository;
  readonly evaluationRepository: QualityEvaluationRepository;
  readonly advisoryRepository: AdvisoryQualityScoreRepository;
  readonly pohRepository: ProofOfHelpfulnessRepository;
  readonly lookups: QualityLookups;
  readonly idempotency: IdempotencyStore;
  readonly auditWriter: TransactionalAuditWriter;
  readonly logger?: Logger;
}

export function createQualityService(
  opts: CreateQualityServiceOptions,
): QualityService {
  const contributionRepository = opts.contributionRepository;
  const policyRepository = opts.policyRepository;
  const evaluationRepository = opts.evaluationRepository;
  const advisoryRepository = opts.advisoryRepository;
  const pohRepository = opts.pohRepository;
  const lookups = opts.lookups;
  const idempotency = opts.idempotency;
  const auditWriter = opts.auditWriter;
  const logger = opts.logger;

  async function loadContribution(contributionId: string): Promise<Contribution> {
    const contribution = await contributionRepository.findById(contributionId);
    if (!contribution) {
      throw new NotFoundError(`contribution not found: ${contributionId}`, {
        contributionId,
      });
    }
    return contribution;
  }

  /** Load a policy version (committed read). */
  async function loadPolicyVersion(
    policyId: string,
    version: number,
  ): Promise<QualityPolicy> {
    const policy = await policyRepository.findVersion(policyId, version);
    if (!policy) {
      throw new NotFoundError(
        `quality policy version not found: ${policyId}:v${String(version)}`,
        { policyId, version },
      );
    }
    return policy;
  }

  /** Resolve the policy (latest when version omitted — pre-flight only). */
  async function resolvePolicyForRead(
    policyId: string,
    version: number | undefined,
  ): Promise<QualityPolicy> {
    if (version !== undefined) {
      return loadPolicyVersion(policyId, version);
    }
    const versions = await policyRepository.listByPolicyId(policyId);
    if (versions.length === 0) {
      throw new NotFoundError(
        `quality policy not found: ${policyId}`,
        { policyId },
      );
    }
    return versions[versions.length - 1]!;
  }

  /**
   * Resolve the engine fact set for a contribution: the PoH aggregate
   * (same-domain) + its recorded bases re-resolved through the truth
   * lookups + the contribution's advisory scores. TRUTH IS
   * RE-RESOLVED — never taken from a cached snapshot.
   */
  async function resolveFacts(
    contributionId: string,
    organizationScopeId: string,
  ): Promise<{
    readonly poh: ProofOfHelpfulness | null;
    readonly facts: QualityEngineFacts;
  }> {
    const poh = await lookups.proofOfHelpfulness.resolveByContribution(
      contributionId,
    );
    const evidenceRecords: QualityEvidenceFact[] = [];
    const measuredOutcomes: QualityMeasuredOutcomeFact[] = [];
    const proofsOfValue: QualityPovFact[] = [];
    if (poh !== null) {
      for (const basis of poh.bases) {
        switch (basis.kind) {
          case "evidence_record": {
            const r = await lookups.evidence.resolveEvidence(basis.referenceId);
            if (r) {
              evidenceRecords.push({
                id: basis.referenceId,
                organizationScopeId: r.organizationScopeId,
                subjectId: r.subjectId,
                subjectType: r.subjectType,
                sourceType: r.sourceType,
                grade: r.grade,
                confidencePoint: r.confidence.point,
              });
            }
            break;
          }
          case "measured_outcome": {
            const r = await lookups.measurement.resolveMeasuredOutcome(
              basis.referenceId,
            );
            if (r) {
              measuredOutcomes.push({
                id: basis.referenceId,
                organizationScopeId: r.organizationScopeId,
                subjectId: r.subjectId,
                subjectType: r.subjectType,
                outcomeType: r.outcomeType,
                state: r.state,
                rollupConfidencePoint: r.rollupConfidence?.point ?? null,
              });
            }
            break;
          }
          case "proof_of_value": {
            const r = await lookups.proofOfValue.resolveProofOfValue(
              basis.referenceId,
            );
            if (r) {
              proofsOfValue.push({
                id: basis.referenceId,
                organizationScopeId: r.organizationScopeId,
                subjectId: r.subjectId,
                subjectType: r.subjectType,
                state: r.state,
              });
            }
            break;
          }
          default:
            break;
        }
      }
    }
    const advisory = await advisoryRepository.listByContribution(
      contributionId,
    );
    const advisoryScores = advisory
      .filter((a) => a.organizationScopeId === organizationScopeId)
      .map((a) => ({ id: a.id, kind: a.kind, score: a.score }));
    return {
      poh,
      facts: {
        proofOfHelpfulness:
          poh === null
            ? null
            : {
                state: poh.state,
                qualifyingBasisCount:
                  poh.evaluations.length > 0
                    ? poh.evaluations[poh.evaluations.length - 1]!
                        .qualifyingBasisCount
                    : 0,
                independentSourceCount:
                  poh.evaluations.length > 0
                    ? poh.evaluations[poh.evaluations.length - 1]!
                        .independentSourceCount
                    : 0,
              },
        evidenceRecords,
        measuredOutcomes,
        proofsOfValue,
        advisoryScores,
      },
    };
  }

  /** The engine policy view for a policy record. */
  function enginePolicyFor(policy: QualityPolicy): QualityEnginePolicy {
    return {
      inputs: policy.inputs,
      advisory: policy.advisory,
      minimumGrade: policy.minimumGrade,
      qualifyingSourceTypes: policy.qualifyingSourceTypes,
      qualifyingOutcomeTypes: policy.qualifyingOutcomeTypes,
      minimumConfidence: policy.minimumConfidence,
      thresholds: policy.thresholds,
      structural: policy.structural,
    };
  }

  const service: QualityService = {
    // ------------------------------------------------------------------
    // Quality policy lineage (deterministic, versioned, auditable).
    // ------------------------------------------------------------------
    async defineQualityPolicy(
      execution,
      input: DefineQualityPolicyInput,
    ): Promise<DefineQualityPolicyResult> {
      assertIdempotencyKey(input.idempotencyKey);
      if (!input.organizationScopeId?.trim()) {
        throw validationError("organizationScopeId is required", {
          field: "organizationScopeId",
        });
      }
      if (!input.policyId?.trim()) {
        throw validationError("policyId is required", { field: "policyId" });
      }
      const actor = actingPersonId(execution, "define quality policies");
      const shape: QualityPolicyShape = validateQualityPolicyShape(input.shape);

      const key = `quality_policy:${input.organizationScopeId}:${input.idempotencyKey}`;
      // The org-INDEPENDENT lineage mutex (the W007/W011/W012
      // pattern): serializes version creation so version = latest+1
      // can never fork — INCLUDING across organization scopes (the
      // cross-scope fork rejection below).
      const applied = await idempotency.withLock(
        qualityPolicyLineageLockKey(input.policyId),
        () =>
          idempotency.applyIdempotent(key, async (ctx) => {
            const tx = ctx.transaction;
            const latest = await policyRepository.findLatestWithinTx(
              input.policyId,
              tx,
            );
            if (
              latest !== null &&
              latest.organizationScopeId !== input.organizationScopeId
            ) {
              throw qualityError(
                "QUALITY_POLICY_SCOPE_MISMATCH",
                "validation",
                `quality policy lineage ${input.policyId} already belongs to organization scope ${latest.organizationScopeId} (cross-scope lineage fork rejected, including the first version)`,
                {
                  policyId: input.policyId,
                  existingScope: latest.organizationScopeId,
                  requestedScope: input.organizationScopeId,
                },
              );
            }
            const version = latest === null ? 1 : latest.version + 1;
            const policy: QualityPolicy = Object.freeze({
              id: randomUUID(),
              policyId: input.policyId,
              version,
              organizationScopeId: input.organizationScopeId,
              formatVersion: QUALITY_POLICY_FORMAT,
              inputs: Object.freeze(
                shape.inputs.map((r) => Object.freeze({ ...r })),
              ),
              advisory: Object.freeze({
                allowedKinds: Object.freeze([...shape.advisory.allowedKinds]),
                advisoryWeightFactor: shape.advisory.advisoryWeightFactor,
              }),
              minimumGrade: shape.minimumGrade,
              qualifyingSourceTypes: Object.freeze([
                ...shape.qualifyingSourceTypes,
              ]),
              qualifyingOutcomeTypes: Object.freeze([
                ...shape.qualifyingOutcomeTypes,
              ]),
              minimumConfidence: shape.minimumConfidence,
              thresholds: Object.freeze({ ...shape.thresholds }),
              structural: Object.freeze({
                advisoryOnlyCapBand: shape.structural.advisoryOnlyCapBand,
                requiredInputs: Object.freeze([
                  ...shape.structural.requiredInputs,
                ]),
                missingInputFloorBand: shape.structural.missingInputFloorBand,
              }),
              description: shape.description,
              createdBy: actor,
              createdAt: new Date().toISOString(),
              executionId: execution.executionId,
              correlationId: execution.correlationId,
              causationId: execution.causationId,
            });
            await policyRepository.createWithinTx(policy, tx);
            const buffer = auditWriter.forTransaction(tx);
            await buffer.append({
              eventType: QUALITY_POLICY_VERSION_CREATED,
              context: execution,
              actor,
              subject: policy.id,
              resourceType: "quality_policy",
              resourceId: policy.id,
              metadata: {
                policyId: policy.policyId,
                version: policy.version,
                organizationScopeId: policy.organizationScopeId,
                idempotencyRecordId: ctx.recordId,
                transactionId: tx.transactionId,
              },
            });
            return policy;
          }, execution),
      );
      logger?.info("quality_policy.version_created", {
        policyId: applied.result.policyId,
        version: applied.result.version,
        created: applied.executed,
      });
      return { policy: applied.result, created: applied.executed };
    },

    async getQualityPolicy(_execution, policyId, version) {
      return loadPolicyVersion(policyId, version);
    },

    async listQualityPolicyVersions(_execution, policyId) {
      return policyRepository.listByPolicyId(policyId);
    },

    // ------------------------------------------------------------------
    // Advisory quality scores (AI-004 — provider-neutral, advisory).
    // ------------------------------------------------------------------
    async attachAdvisoryScore(
      execution,
      input: AttachAdvisoryQualityScoreInput,
    ): Promise<AdvisoryQualityScore> {
      assertIdempotencyKey(input.idempotencyKey);
      if (!input.contributionId?.trim()) {
        throw validationError("contributionId is required", {
          field: "contributionId",
        });
      }
      if (!input.organizationScopeId?.trim()) {
        throw validationError("organizationScopeId is required", {
          field: "organizationScopeId",
        });
      }
      if (!isQualityAdvisoryKind(input.kind ?? "")) {
        throw validationError(
          `kind must be an advisory kind (model_score, heuristic_score — got ${String(input.kind)})`,
          { field: "kind", kind: input.kind },
        );
      }
      if (!input.methodRef?.trim() || !input.methodVersion?.trim()) {
        throw validationError(
          "methodRef AND methodVersion are required (method identity is never collapsed — the frozen measurement rule)",
          { field: "methodRef/methodVersion" },
        );
      }
      if (!validateQualityScore(input.score)) {
        throw validationError("score must be a number in [0, 1]", {
          field: "score",
          score: input.score,
        });
      }
      const actor = actingPersonId(execution, "record advisory quality scores");

      // PRE-FLIGHT: the contribution must exist in the same org.
      const contribution = await loadContribution(input.contributionId);
      if (contribution.organizationScopeId !== input.organizationScopeId) {
        throw validationError(
          `contribution ${input.contributionId} belongs to organization scope ${contribution.organizationScopeId}, not ${input.organizationScopeId}`,
          {
            contributionId: input.contributionId,
            contributionScope: contribution.organizationScopeId,
            requestedScope: input.organizationScopeId,
          },
        );
      }

      const key = `quality_advisory:${input.organizationScopeId}:${input.idempotencyKey}`;
      const applied = await idempotency.withLock(
        contributionQualityLockKey(input.contributionId),
        () =>
          idempotency.applyIdempotent(key, async (ctx) => {
            const tx = ctx.transaction;
            const now = new Date().toISOString();
            const record: AdvisoryQualityScore = Object.freeze({
              id: randomUUID(),
              organizationScopeId: input.organizationScopeId,
              contributionId: input.contributionId,
              kind: input.kind,
              methodRef: input.methodRef,
              methodVersion: input.methodVersion,
              provider: input.provider ?? null,
              modelRef: input.modelRef ?? null,
              score: input.score,
              recordedBy: actor,
              recordedAt: now,
              idempotencyKey: input.idempotencyKey,
              executionId: execution.executionId,
              correlationId: execution.correlationId,
              causationId: execution.causationId,
            });
            await advisoryRepository.createWithinTx(record, tx);
            const buffer = auditWriter.forTransaction(tx);
            await buffer.append({
              eventType: QUALITY_ADVISORY_RECORDED,
              context: execution,
              actor,
              subject: record.id,
              resourceType: "advisory_quality_score",
              resourceId: record.id,
              metadata: {
                contributionId: record.contributionId,
                kind: record.kind,
                provider: record.provider,
                modelRef: record.modelRef,
                score: record.score,
                idempotencyRecordId: ctx.recordId,
                transactionId: tx.transactionId,
              },
            });
            return record;
          }, execution),
      );
      logger?.info("quality_advisory.recorded", {
        advisoryScoreId: applied.result.id,
        contributionId: applied.result.contributionId,
        kind: applied.result.kind,
      });
      return applied.result;
    },

    async listAdvisoryScores(_execution, contributionId) {
      return advisoryRepository.listByContribution(contributionId);
    },

    // ------------------------------------------------------------------
    // Quality evaluations (deterministic snapshots + supersession).
    // ------------------------------------------------------------------
    async previewQualityEvaluation(
      execution,
      input: PreviewQualityEvaluationInput,
    ): Promise<PreviewQualityEvaluationResult> {
      if (!input.contributionId?.trim()) {
        throw validationError("contributionId is required", {
          field: "contributionId",
        });
      }
      if (!input.organizationScopeId?.trim()) {
        throw validationError("organizationScopeId is required", {
          field: "organizationScopeId",
        });
      }
      assertIsoTimestamp(input.evaluatedAt, "evaluatedAt");
      void execution;
      const contribution = await loadContribution(input.contributionId);
      if (contribution.organizationScopeId !== input.organizationScopeId) {
        throw validationError(
          `contribution ${input.contributionId} belongs to organization scope ${contribution.organizationScopeId}, not ${input.organizationScopeId}`,
          {
            contributionId: input.contributionId,
            contributionScope: contribution.organizationScopeId,
            requestedScope: input.organizationScopeId,
          },
        );
      }
      const policy = await resolvePolicyForRead(
        input.qualityPolicyId,
        input.qualityPolicyVersion,
      );
      if (policy.organizationScopeId !== input.organizationScopeId) {
        throw qualityError(
          "QUALITY_POLICY_SCOPE_MISMATCH",
          "validation",
          `quality policy ${policy.policyId}:v${String(policy.version)} belongs to organization scope ${policy.organizationScopeId}, not ${input.organizationScopeId}`,
          {
            policyId: policy.policyId,
            policyVersion: policy.version,
            policyOrganizationScopeId: policy.organizationScopeId,
            requestedScope: input.organizationScopeId,
          },
        );
      }
      const { facts } = await resolveFacts(
        input.contributionId,
        input.organizationScopeId,
      );
      const result = evaluateQuality({
        policy: enginePolicyFor(policy),
        facts,
        organizationScopeId: input.organizationScopeId,
        contributionId: input.contributionId,
      });
      return {
        policy,
        inputContributions: result.inputContributions,
        advisoryCount: result.advisoryCount,
        advisoryAverage: result.advisoryAverage,
        score: result.score,
        band: result.band,
        reasons: result.reasons,
        evaluator: result.evaluator,
      };
    },

    async recordQualityEvaluation(
      execution,
      input: RecordQualityEvaluationInput,
    ): Promise<RecordQualityEvaluationResult> {
      assertIdempotencyKey(input.idempotencyKey);
      if (!input.contributionId?.trim()) {
        throw validationError("contributionId is required", {
          field: "contributionId",
        });
      }
      if (!input.organizationScopeId?.trim()) {
        throw validationError("organizationScopeId is required", {
          field: "organizationScopeId",
        });
      }
      assertIsoTimestamp(input.evaluatedAt, "evaluatedAt");
      const actor = actingPersonId(execution, "record quality evaluations");

      // PRE-FLIGHT (fail fast only): contribution + policy scope.
      const contribution = await loadContribution(input.contributionId);
      if (contribution.organizationScopeId !== input.organizationScopeId) {
        throw validationError(
          `contribution ${input.contributionId} belongs to organization scope ${contribution.organizationScopeId}, not ${input.organizationScopeId}`,
          {
            contributionId: input.contributionId,
            contributionScope: contribution.organizationScopeId,
            requestedScope: input.organizationScopeId,
          },
        );
      }
      const prePolicy = await resolvePolicyForRead(
        input.qualityPolicyId,
        input.qualityPolicyVersion,
      );
      if (prePolicy.organizationScopeId !== input.organizationScopeId) {
        throw qualityError(
          "QUALITY_POLICY_SCOPE_MISMATCH",
          "validation",
          `quality policy ${prePolicy.policyId}:v${String(prePolicy.version)} belongs to organization scope ${prePolicy.organizationScopeId}, not ${input.organizationScopeId}`,
          {
            policyId: prePolicy.policyId,
            policyVersion: prePolicy.version,
            policyOrganizationScopeId: prePolicy.organizationScopeId,
            requestedScope: input.organizationScopeId,
          },
        );
      }

      // Resolve the fact set (the PoH + its re-resolved bases + the
      // advisory scores) immediately before the transaction; the
      // in-tx re-checks below verify the same-domain state has not
      // changed underneath the resolution.
      const { poh, facts } = await resolveFacts(
        input.contributionId,
        input.organizationScopeId,
      );
      const result = evaluateQuality({
        policy: enginePolicyFor(prePolicy),
        facts,
        organizationScopeId: input.organizationScopeId,
        contributionId: input.contributionId,
      });

      const key = `quality_evaluation:${input.organizationScopeId}:${input.idempotencyKey}`;
      const applied = await idempotency.withLock(
        contributionQualityLockKey(input.contributionId),
        () =>
          idempotency.applyIdempotent(key, async (ctx) => {
            const tx = ctx.transaction;
            const now = new Date().toISOString();

            // AUTHORITATIVE in-tx re-check ① — pin the policy version
            // IN-TX with SAME-SCOPE validation (the PR #24 lesson).
            const pinned = await policyRepository.findVersionWithinTx(
              prePolicy.policyId,
              prePolicy.version,
              tx,
            );
            if (pinned === null) {
              throw new NotFoundError(
                `quality policy ${prePolicy.policyId}:v${String(prePolicy.version)} not found at the evaluation transaction boundary`,
                {
                  policyId: prePolicy.policyId,
                  version: prePolicy.version,
                },
              );
            }
            if (pinned.organizationScopeId !== input.organizationScopeId) {
              throw qualityError(
                "QUALITY_POLICY_SCOPE_MISMATCH",
                "validation",
                `quality policy ${pinned.policyId}:v${String(pinned.version)} belongs to organization scope ${pinned.organizationScopeId}, not ${input.organizationScopeId} (cross-tenant policy pin rejected at the authoritative transaction boundary)`,
                {
                  policyId: pinned.policyId,
                  policyVersion: pinned.version,
                  policyOrganizationScopeId: pinned.organizationScopeId,
                  requestedScope: input.organizationScopeId,
                },
              );
            }

            // AUTHORITATIVE in-tx re-check ② — the PoH state must not
            // have changed underneath the resolved fact set.
            const pohInTx = await pohRepository.findByContributionIdWithinTx(
              input.contributionId,
              tx,
            );
            const resolvedPohState = poh === null ? null : poh.state;
            const inTxPohState = pohInTx === null ? null : pohInTx.state;
            if (resolvedPohState !== inTxPohState) {
              throw new ConflictError(
                `the proof-of-helpfulness state changed during evaluation (resolved '${String(resolvedPohState)}', now '${String(inTxPohState)}') — re-run the evaluation`,
                { contributionId: input.contributionId },
              );
            }

            // AUTHORITATIVE in-tx re-check ③ — the advisory set must
            // not have changed underneath the resolved fact set.
            const advisoryInTx = await advisoryRepository.listByContributionWithinTx(
              input.contributionId,
              tx,
            );
            const inTxAdvisoryIds = advisoryInTx
              .filter((a) => a.organizationScopeId === input.organizationScopeId)
              .map((a) => a.id)
              .sort();
            const resolvedAdvisoryIds = facts.advisoryScores
              .map((a) => a.id)
              .sort();
            if (
              JSON.stringify(inTxAdvisoryIds) !==
              JSON.stringify(resolvedAdvisoryIds)
            ) {
              throw new ConflictError(
                "the advisory quality score set changed during evaluation — re-run the evaluation",
                { contributionId: input.contributionId },
              );
            }

            // Append-only supersession (atomic back-pointer flip).
            const previous = await evaluationRepository
              .findLatestByContributionIdWithinTx(input.contributionId, tx);
            const evaluation: QualityEvaluation = Object.freeze({
              id: randomUUID(),
              organizationScopeId: input.organizationScopeId,
              contributionId: input.contributionId,
              qualityPolicyId: pinned.policyId,
              qualityPolicyVersion: pinned.version,
              formatVersion: QUALITY_POLICY_FORMAT,
              evaluatedAt: input.evaluatedAt,
              recordedAt: now,
              inputContributions: Object.freeze(
                result.inputContributions.map((c) => Object.freeze({ ...c })),
              ),
              advisoryCount: result.advisoryCount,
              advisoryAverage: result.advisoryAverage,
              score: Math.round(result.score * 1_000_000),
              band: result.band,
              reasons: Object.freeze([...result.reasons]),
              evaluator: result.evaluator,
              digest: computeEvaluationDigest({
                qualityPolicyId: pinned.policyId,
                qualityPolicyVersion: pinned.version,
                evaluatedAt: input.evaluatedAt,
                inputContributions: result.inputContributions,
                advisoryCount: result.advisoryCount,
                advisoryAverage: result.advisoryAverage,
                score: Math.round(result.score * 1_000_000),
                band: result.band,
                reasons: result.reasons,
              }),
              supersedesEvaluationId: previous ? previous.id : null,
              supersededByEvaluationId: null,
              idempotencyKey: input.idempotencyKey,
              executionId: execution.executionId,
              correlationId: execution.correlationId,
              causationId: execution.causationId,
            });
            await evaluationRepository.createWithinTx(evaluation, tx);
            if (previous) {
              await evaluationRepository.saveWithinTx(
                Object.freeze({
                  ...previous,
                  supersededByEvaluationId: evaluation.id,
                }),
                tx,
              );
            }
            const buffer = auditWriter.forTransaction(tx);
            await buffer.append({
              eventType: QUALITY_EVALUATION_RECORDED,
              context: execution,
              actor,
              subject: evaluation.id,
              resourceType: "quality_evaluation",
              resourceId: evaluation.id,
              metadata: {
                contributionId: evaluation.contributionId,
                qualityPolicyId: evaluation.qualityPolicyId,
                qualityPolicyVersion: evaluation.qualityPolicyVersion,
                evaluatedAt: evaluation.evaluatedAt,
                score: evaluation.score,
                band: evaluation.band,
                digest: evaluation.digest,
                supersedesEvaluationId: evaluation.supersedesEvaluationId,
                idempotencyRecordId: ctx.recordId,
                transactionId: tx.transactionId,
              },
            });
            return evaluation;
          }, execution),
      );
      logger?.info("quality_evaluation.recorded", {
        evaluationId: applied.result.id,
        contributionId: applied.result.contributionId,
        band: applied.result.band,
        created: applied.executed,
      });
      return { evaluation: applied.result, created: applied.executed };
    },

    async getQualityEvaluation(_execution, evaluationId) {
      const evaluation = await evaluationRepository.findById(evaluationId);
      if (!evaluation) {
        throw new NotFoundError(
          `quality evaluation not found: ${evaluationId}`,
          { evaluationId },
        );
      }
      return evaluation;
    },

    async listQualityEvaluationHistory(_execution, contributionId) {
      return evaluationRepository.listByContributionId(contributionId);
    },

    async getLatestQualityEvaluation(_execution, contributionId) {
      return evaluationRepository.findLatestByContributionId(contributionId);
    },
  };

  return service;
}

export {
  QUALITY_POLICY_VERSION_CREATED,
  QUALITY_ADVISORY_RECORDED,
  QUALITY_EVALUATION_RECORDED,
};

export type { AuditWriter };
