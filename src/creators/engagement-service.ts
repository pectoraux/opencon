/**
 * The NET-W017 engagement domain service — UGC workflow and rights.
 *
 * Work order ref: spec/work-orders/NET-W017.md.
 *
 * AUTHORITY MODEL (work order §2 — the decision of record):
 *  - /workflows is the SOLE lifecycle authority: every engagement
 *    state change is REQUESTED through the injected
 *    {@link EngagementWorkflowPort.requestTransition} delegation
 *    callback (the sanctioned pattern — the Proof-of-Value service
 *    precedent). This service validates business preconditions
 *    BEFORE requesting; it NEVER mutates lifecycle state itself and
 *    contains NO transition machinery.
 *  - /campaigns is the campaign policy authority: the engagement
 *    references a campaign resolved READ-ONLY through the neutral
 *    campaign lookup.
 *  - /evidence is the truth authority: submission evidence
 *    references are validated through the neutral evidence lookup
 *    (existence + tenant scope + subject binding). This boundary
 *    never fabricates evidence or measurement.
 *  - /outcomes + /settlement + /reputation + /disputes are UNTOUCHED
 *    mutators here: the only mutations are this boundary's own
 *    append-only records + the workflow-mediated lifecycle
 *    transitions + the matching audit events.
 *  - NO AI path exists anywhere in this service (work order §2 —
 *    NET-W017 adds no AI-provider consumption at all).
 *
 * Every material mutation flows through
 * IdempotencyStore.applyIdempotent (exactly-once-per-key; the
 * mutation + the idempotency record + the transactional audit event
 * commit in ONE authoritative transaction). Concurrency-sensitive
 * sequences (unique anchors, version sequences) are serialized with
 * withLock (the NET-W015 creator-anchor remediation precedent).
 *
 * TENANT ISOLATION: every ID-based read resolves records WITHIN an
 * organization scope — a cross-scope id is indistinguishable from a
 * nonexistent one (NotFoundError, no existence oracle).
 *
 * Tier compliance: creators domain → self + core contracts only.
 */

import { randomUUID } from "node:crypto";
import type { TransactionalAuditWriter } from "../core/audit.ts";
import type { ExecutionContext } from "../core/execution-context.ts";
import type { IdempotencyStore } from "../core/idempotency.ts";
import { AuthorizationError, NotFoundError, OpenConError } from "../core/errors.ts";
import type { Logger } from "../core/logger.ts";
import type { AuthorityTransaction } from "../core/postgres-authority.ts";
import { policyActionFor } from "../core/workflow.ts";
import {
  ACCEPTANCE_POLICY_MAX_ACTIVE_ENGAGEMENTS,
  ACCEPTANCE_POLICY_MAX_RATE_FLOOR,
  CREATOR_ENGAGEMENT_FORMAT,
  InvalidEngagementError,
  EngagementConflictError,
  UsageRightsConflictError,
  USAGE_RIGHTS_OWNERSHIP,
  isCreatorContentFormat,
  isCreatorRightsKind,
  isCreatorRateUnit,
  validateCreatorCurrencyCode,
  validateCreatorRateAmount,
  type CreatorContentFormat,
  type CreatorProfileStatus,
  type CreatorRightsKind,
  type CreatorRateUnit,
} from "../core/creators.ts";
import type {
  AcceptEngagementInput,
  AcceptEngagementResult,
  AutoAcceptEngagementInput,
  AutoAcceptEngagementResult,
  AutoAcceptEvaluation,
  CreateEngagementInput,
  CreateEngagementResult,
  CreateEngagementsFromMatchInput,
  CreateEngagementsFromMatchResult,
  CreatorAcceptanceMode,
  CreatorAcceptancePolicyRecord,
  CreatorEngagementService,
  CreatorEngagementServiceDeps,
  CreatorProfileRecord,
  CreatorProfileRepository,
  CreatorProfileVersion,
  CreatorProfileVersionRepository,
  Engagement,
  EngagementBatchOutcome,
  EngagementBatchOutcomeRecord,
  EngagementBatchRecord,
  EngagementCompensationTerms,
  EngagementRequestedRights,
  CreatorMatchRunRecord,
  CreatorMatchRunRepository,
  OpenProductionInput,
  OpenProductionResult,
  RecordDeliverableInput,
  RecordDeliverableResult,
  RevokeUsageRightsInput,
  RevokeUsageRightsResult,
  SetAcceptancePolicyInput,
  SetAcceptancePolicyResult,
  SubmitProductionInput,
  SubmitProductionResult,
  TransitionResult,
  UgcDeliverableVersion,
  UgcProduction,
  UgcSubmission,
  UsageRightsGrant,
  UsageRightsRepository,
  UsageRightsRevocation,
  UsageRightsView,
} from "./port.ts";
import {
  assertGrantedWithinEnvelope,
  buildGrantedRights,
  buildRequestedRights,
  deriveAutoGrant,
  evaluateAutoAccept,
  grantDurationDays,
  requestedUseKinds,
  usageRightsEffectiveStatus,
  type GrantedRightsTerms,
} from "./engagement-engine.ts";

const ENGAGEMENT_OFFER_RECORDED = "engagement.offer_recorded" as const;
const ENGAGEMENT_BATCH_RECORDED = "engagement.batch_recorded" as const;
const ENGAGEMENT_BATCH_COMPLETED = "engagement.batch_completed" as const;
const ENGAGEMENT_BATCH_ABORTED = "engagement.batch_aborted" as const;
const USAGE_RIGHTS_GRANTED = "usage_rights.granted" as const;
const USAGE_RIGHTS_REVOKED = "usage_rights.revoked" as const;
const ACCEPTANCE_POLICY_SET = "creator_acceptance_policy.set" as const;
const UGC_PRODUCTION_OPENED = "ugc_production.opened" as const;
const UGC_DELIVERABLE_RECORDED = "ugc_production.deliverable_recorded" as const;
const UGC_PRODUCTION_SUBMITTED = "ugc_production.submitted" as const;

/** The canonical subject type evidence records bind UGC evidence to. */
export const UGC_PRODUCTION_SUBJECT_TYPE = "ugc_production" as const;

const NON_TERMINAL_ENGAGEMENT_STATES: readonly string[] = [
  "DRAFT",
  "READY",
  "ASSIGNED",
  "IN_PROGRESS",
  "SUBMITTED",
];

function engagementError(
  message: string,
  context: Readonly<Record<string, unknown>>,
): OpenConError {
  return new InvalidEngagementError(message, context);
}

function assertIdempotencyKey(idempotencyKey: string): string {
  if (typeof idempotencyKey !== "string" || !idempotencyKey.trim()) {
    throw engagementError("idempotencyKey is required", {
      field: "idempotencyKey",
    });
  }
  return idempotencyKey;
}

function assertOrganizationScopeId(organizationScopeId: string): string {
  if (typeof organizationScopeId !== "string" || !organizationScopeId.trim()) {
    throw engagementError("organizationScopeId is required", {
      field: "organizationScopeId",
    });
  }
  return organizationScopeId;
}

/** The acting person's id (recorded as createdBy on every record). */
function actingPersonId(execution: ExecutionContext): string {
  if (!execution.actor || execution.actor.kind !== "person") {
    throw new AuthorizationError(
      "engagement commands require an authenticated person actor",
      { actorKind: execution.actor?.kind ?? null },
    );
  }
  return execution.actor.id;
}

function nowIso(): string {
  return new Date().toISOString();
}

/** Canonical JSON of the granted terms (identical-terms detection). */
function canonicalGrantTerms(terms: GrantedRightsTerms): string {
  return JSON.stringify({
    uses: [...terms.uses]
      .map((u) => ({ kind: u.kind, terms: u.terms }))
      .sort((a, b) => (a.kind < b.kind ? -1 : 1)),
    channels: [...terms.channels].sort(),
    territories: [...terms.territories].sort(),
    formats: [...terms.formats].sort(),
    startsAt: terms.startsAt,
    endsAt: terms.endsAt,
    exclusions: [...terms.exclusions].sort(),
  });
}

/** Validate + normalize the compensation terms (declared data only). */
function buildCompensation(raw: {
  readonly format: string;
  readonly unit: string;
  readonly amount: number;
  readonly currency: string;
  readonly rewardPolicyReference?: string | null;
} | null | undefined): EngagementCompensationTerms | null {
  if (raw === null || raw === undefined) return null;
  if (!isCreatorContentFormat(raw.format)) {
    throw engagementError("compensation.format is not a known format", {
      format: raw.format,
    });
  }
  if (!isCreatorRateUnit(raw.unit)) {
    throw engagementError("compensation.unit is not a known rate unit", {
      unit: raw.unit,
    });
  }
  validateCreatorRateAmount("compensation.amount", raw.amount);
  validateCreatorCurrencyCode("compensation.currency", raw.currency);
  const rewardPolicyReference =
    raw.rewardPolicyReference === undefined ||
    raw.rewardPolicyReference === null
      ? null
      : String(raw.rewardPolicyReference);
  if (rewardPolicyReference !== null && rewardPolicyReference.length > 200) {
    throw engagementError(
      "compensation.rewardPolicyReference must be at most 200 characters",
      {},
    );
  }
  return {
    format: raw.format,
    unit: raw.unit,
    amount: raw.amount,
    currency: raw.currency,
    rewardPolicyReference,
  };
}

function engagementNotFound(id: string, organizationScopeId: string): OpenConError {
  return new NotFoundError(`engagement not found: ${id}`, {
    id,
    organizationScopeId,
  });
}

export function createCreatorEngagementService(
  deps: CreatorEngagementServiceDeps,
): CreatorEngagementService {
  const {
    engagementRepository,
    acceptancePolicyRepository,
    usageRightsRepository,
    productionRepository,
    deliverableRepository,
    submissionRepository,
    batchRepository,
    profileRepository,
    versionRepository,
    runRepository,
    lookups,
    workflow,
    idempotency,
    auditWriter,
    logger,
  } = deps;

  async function requireEngagement(
    organizationScopeId: string,
    id: string,
  ): Promise<Engagement> {
    const engagement = await engagementRepository.findById(id);
    if (!engagement || engagement.organizationScopeId !== organizationScopeId) {
      throw engagementNotFound(id, organizationScopeId);
    }
    return engagement;
  }

  async function requireProduction(
    organizationScopeId: string,
    id: string,
  ): Promise<UgcProduction> {
    const production = await productionRepository.findById(id);
    if (!production || production.organizationScopeId !== organizationScopeId) {
      throw new NotFoundError(`ugc production not found: ${id}`, {
        id,
        organizationScopeId,
      });
    }
    return production;
  }

  async function appendAudit(
    tx: AuthorityTransaction,
    event: {
      eventType: string;
      context: ExecutionContext;
      actor: string;
      subject: string;
      resourceType: string;
      resourceId: string;
      metadata: Record<string, unknown>;
    },
  ): Promise<void> {
    const buffer = auditWriter.forTransaction(tx);
    await buffer.append({
      eventType: event.eventType,
      context: event.context,
      actor: event.actor,
      subject: event.subject,
      resourceType: event.resourceType,
      resourceId: event.resourceId,
      metadata: event.metadata,
    });
  }

  /** The latest profile version's sections (null when none). */
  async function latestProfileVersion(
    profileId: string,
  ): Promise<CreatorProfileVersion | null> {
    const versions = await versionRepository.listByProfile(profileId);
    if (versions.length === 0) return null;
    let latest = versions[0]!;
    for (const v of versions) {
      if (v.version > latest.version) latest = v;
    }
    return latest;
  }

  /** Resolve the creator profile for (org, person) — ACTIVE required. */
  async function requireActiveProfile(
    organizationScopeId: string,
    creatorPersonId: string,
    expectedProfileId?: string | null,
  ): Promise<CreatorProfileRecord> {
    const profile = await profileRepository.findByPerson(
      organizationScopeId,
      creatorPersonId,
    );
    if (!profile) {
      throw new NotFoundError(
        `creator profile not found for person ${creatorPersonId} in organization scope`,
        { creatorPersonId, organizationScopeId },
      );
    }
    if (expectedProfileId && expectedProfileId !== profile.id) {
      throw engagementError(
        "creatorProfileId does not match the profile anchored to the creator person",
        { expectedProfileId, actualProfileId: profile.id },
      );
    }
    return profile;
  }

  /**
   * Verify the match-run lineage: the run exists in the org scope and
   * the creator's profile was an ELIGIBLE candidate of that run
   * (present in the ranked results, not among the excluded).
   */
  async function verifyMatchRunLineage(
    organizationScopeId: string,
    matchRunId: string,
    profileId: string,
  ): Promise<CreatorMatchRunRecord> {
    const run = await runRepository.findById(matchRunId);
    if (!run || run.organizationScopeId !== organizationScopeId) {
      throw new NotFoundError(`creator match run not found: ${matchRunId}`, {
        matchRunId,
        organizationScopeId,
      });
    }
    const eligible = run.results.some(
      (candidate) => candidate.profileId === profileId,
    );
    if (!eligible) {
      throw engagementError(
        "the creator was not an eligible candidate of the referenced match run",
        { matchRunId, profileId },
      );
    }
    return run;
  }

  /** The core offer-creation step shared by single + batch commands. */
  async function createOffer(
    execution: ExecutionContext,
    input: {
      organizationScopeId: string;
      creatorPersonId: string;
      profile: CreatorProfileRecord;
      profileVersion: number | null;
      campaignId: string;
      campaignPolicyVersion: number | null;
      matchRunId: string | null;
      opportunityId: string | null;
      requestedRights: EngagementRequestedRights;
      compensation: EngagementCompensationTerms | null;
      brief: Readonly<Record<string, unknown>> | null;
      idempotencyKey: string;
    },
  ): Promise<{ engagement: Engagement; created: boolean }> {
    const actor = actingPersonId(execution);
    const anchor = `engagement_anchor:${input.organizationScopeId}:${input.campaignId}:${input.creatorPersonId}`;
    const key = `engagement:${input.organizationScopeId}:${input.idempotencyKey}`;
    const applied = await idempotency.withLock(
      anchor,
      () =>
        idempotency.applyIdempotent(key, async (ctx) => {
          const tx = ctx.transaction;
          const existing = await engagementRepository.findNonTerminalWithinTx(
            input.organizationScopeId,
            input.campaignId,
            input.creatorPersonId,
            tx,
          );
          if (existing) {
            throw new EngagementConflictError(
              `a non-terminal engagement already exists for campaign ${input.campaignId} and creator ${input.creatorPersonId}`,
              {
                organizationScopeId: input.organizationScopeId,
                campaignId: input.campaignId,
                creatorPersonId: input.creatorPersonId,
                existingEngagementId: existing.id,
              },
            );
          }
          const createdAt = nowIso();
          const engagement: Engagement = Object.freeze({
            id: randomUUID(),
            kind: "engagement",
            state: "DRAFT",
            version: 0,
            organizationScopeId: input.organizationScopeId,
            ownerId: actor,
            creatorPersonId: input.creatorPersonId,
            creatorProfileId: input.profile.id,
            creatorProfileVersion: input.profileVersion,
            campaignId: input.campaignId,
            campaignPolicyVersion: input.campaignPolicyVersion,
            matchRunId: input.matchRunId,
            opportunityId: input.opportunityId,
            requestedRights: input.requestedRights,
            compensation: input.compensation,
            brief: input.brief,
            formatVersion: CREATOR_ENGAGEMENT_FORMAT,
            executionId: execution.executionId,
            correlationId: execution.correlationId,
            causationId: execution.causationId,
            createdAt,
            updatedAt: createdAt,
          });
          await engagementRepository.createWithinTx(engagement, tx);
          await appendAudit(tx, {
            eventType: ENGAGEMENT_OFFER_RECORDED,
            context: execution,
            actor,
            subject: engagement.id,
            resourceType: "engagement",
            resourceId: engagement.id,
            metadata: {
              organizationScopeId: engagement.organizationScopeId,
              creatorPersonId: engagement.creatorPersonId,
              creatorProfileId: engagement.creatorProfileId,
              campaignId: engagement.campaignId,
              campaignPolicyVersion: engagement.campaignPolicyVersion,
              matchRunId: engagement.matchRunId,
              opportunityId: engagement.opportunityId,
              idempotencyRecordId: ctx.recordId,
              transactionId: tx.transactionId,
            },
          });
          return engagement;
        }, execution),
    );
    logger.info("engagement.offer_recorded", {
      engagementId: applied.result.id,
      organizationScopeId: input.organizationScopeId,
      created: applied.executed,
    });
    return { engagement: applied.result, created: applied.executed };
  }

  /**
   * The acceptance composition (shared by manual + auto) — NET-W017
   * remediation decision of record (architect CHANGES REQUESTED on PR
   * #34): the usage-rights grant AND the READY → ASSIGNED lifecycle
   * transition commit in ONE authoritative transaction. The composite
   * runs inside a single `applyIdempotent`; the transition executes
   * through the sanctioned in-tx /workflows twin against the SAME
   * transaction — a failure at ANY point (grant write, audit append,
   * transition rejection, commit) rolls back EVERYTHING. An orphaned
   * ACTIVE grant for an unaccepted engagement is structurally
   * impossible: there is no second transaction to fail.
   */
  async function recordGrantAndAccept(
    execution: ExecutionContext,
    input: {
      organizationScopeId: string;
      engagement: Engagement;
      expectedVersion: number;
      grantedRights: GrantedRightsTerms;
      idempotencyKey: string;
      mode: "manual" | "auto";
      extraMetadata: Record<string, unknown>;
    },
  ): Promise<{ grant: UsageRightsGrant; transition: TransitionResult }> {
    const actor = actingPersonId(execution);
    const engagement = input.engagement;
    // Replay tolerance (the creator-service precedent): when the
    // record ALREADY sits in the target state the call may be a
    // same-key idempotent REPLAY — the apply short-circuits and
    // returns the committed composite. A FRESH key re-running against
    // an already-accepted engagement fails IN-TX on the authoritative
    // state check below, so no duplicate acceptance can slip through.
    if (engagement.state !== "READY" && engagement.state !== "ASSIGNED") {
      throw engagementError(
        `engagement ${engagement.id} is not READY (state: ${engagement.state}); only tendered offers can be accepted`,
        { engagementId: engagement.id, state: engagement.state },
      );
    }
    assertGrantedWithinEnvelope(
      engagement.requestedRights,
      input.grantedRights,
    );

    // ONE composite idempotency record covers the WHOLE semantic
    // action (grant + transition). The per-key mutex + the in-tx
    // optimistic-concurrency check are the authoritative serializers;
    // the workflow-subject lock below additionally serializes
    // composites racing a direct generic transition on the same
    // subject (advisory only — the same stance the workflow service
    // itself takes when its coordination lock is busy).
    const compositeKey = `engagement_accept:${input.organizationScopeId}:${input.idempotencyKey}`;
    const subjectLock = `workflow:engagement:${engagement.id}`;
    const applied = await idempotency.withLock(
      subjectLock,
      () =>
        idempotency.applyIdempotent(compositeKey, async (ctx) => {
          const tx = ctx.transaction;

          // Step 1 (in-tx) — the usage-rights grant (append-only,
          // audited). An existing grant with IDENTICAL terms is reused
          // (immutable grants; the safe re-entry path); any other
          // existing grant is a stable conflict.
          const existing = await usageRightsRepository.findByEngagementWithinTx(
            input.organizationScopeId,
            engagement.id,
            tx,
          );
          let grant: UsageRightsGrant;
          if (existing) {
            if (
              canonicalGrantTerms({
                uses: existing.uses,
                channels: existing.channels,
                territories: existing.territories,
                formats: existing.formats,
                startsAt: existing.startsAt,
                endsAt: existing.endsAt,
                exclusions: existing.exclusions,
              }) === canonicalGrantTerms(input.grantedRights)
            ) {
              grant = existing;
            } else {
              throw new UsageRightsConflictError(
                `usage rights already granted for engagement ${engagement.id} with different terms (grants are immutable)`,
                { engagementId: engagement.id, grantId: existing.id },
              );
            }
          } else {
            grant = Object.freeze({
              id: randomUUID(),
              organizationScopeId: input.organizationScopeId,
              engagementId: engagement.id,
              grantorPersonId: engagement.creatorPersonId,
              uses: input.grantedRights.uses,
              channels: input.grantedRights.channels,
              territories: input.grantedRights.territories,
              formats: input.grantedRights.formats,
              exclusions: input.grantedRights.exclusions,
              startsAt: input.grantedRights.startsAt,
              endsAt: input.grantedRights.endsAt,
              // The frozen ownership boundary (CRE-004): creator-retained,
              // ALWAYS — there is no input path to any other value.
              contentOwnership: USAGE_RIGHTS_OWNERSHIP[0],
              formatVersion: CREATOR_ENGAGEMENT_FORMAT,
              createdBy: actor,
              createdAt: nowIso(),
              idempotencyKey: input.idempotencyKey,
              executionId: execution.executionId,
              correlationId: execution.correlationId,
              causationId: execution.causationId,
            });
            await usageRightsRepository.createWithinTx(grant, tx);
            await appendAudit(tx, {
              eventType: USAGE_RIGHTS_GRANTED,
              context: execution,
              actor,
              subject: grant.id,
              resourceType: "usage_rights_grant",
              resourceId: grant.id,
              metadata: {
                organizationScopeId: grant.organizationScopeId,
                engagementId: engagement.id,
                grantorPersonId: grant.grantorPersonId,
                uses: grant.uses.map((u) => u.kind),
                channels: grant.channels,
                territories: grant.territories,
                formats: grant.formats,
                startsAt: grant.startsAt,
                endsAt: grant.endsAt,
                contentOwnership: grant.contentOwnership,
                mode: input.mode,
                idempotencyRecordId: ctx.recordId,
                transactionId: tx.transactionId,
              },
            });
          }

          // Step 2 (in-tx) — the AUTHORITATIVE precondition: re-read
          // the engagement inside the SAME transaction (a concurrent
          // acceptor loses on this check or on the transition's
          // version check below — TOCTOU closure).
          const fresh = await engagementRepository.getByIdWithinTx(
            engagement.id,
            tx,
          );
          if (!fresh) {
            throw engagementNotFound(engagement.id, input.organizationScopeId);
          }
          if (fresh.state !== "READY") {
            throw engagementError(
              `engagement ${engagement.id} is not READY (state: ${fresh.state}); only tendered offers can be accepted`,
              { engagementId: engagement.id, state: fresh.state },
            );
          }
          // The envelope is re-validated against the FRESH requested
          // terms (never the outer stale read).
          assertGrantedWithinEnvelope(fresh.requestedRights, input.grantedRights);

          // Step 3 (in-tx, SAME transaction) — the READY → ASSIGNED
          // transition through the canonical /workflows authority:
          // version check, authorization, state machine, save and
          // buffered audit ALL execute inside THIS transaction. A
          // rejection here rolls the grant back with everything else.
          const transition = await workflow.requestTransitionWithinTx(
            {
              subjectId: engagement.id,
              subjectKind: "engagement",
              targetState: "ASSIGNED",
              expectedVersion: input.expectedVersion,
              idempotencyKey: input.idempotencyKey,
              actorPersonId: actor,
              policyAction: policyActionFor("engagement", "READY", "ASSIGNED"),
              metadata: {
                acceptance: {
                  mode: input.mode,
                  grantId: grant.id,
                  ...input.extraMetadata,
                },
              },
            },
            execution,
            tx,
            ctx.recordId,
          );
          return { grant, transition };
        }, execution),
    );
    // Replay contract (the W004 precedent): on a same-key replay the
    // stored composite is returned verbatim; `executed` reflects
    // whether THIS call executed the composite (the transition
    // executed iff the composite did).
    return {
      grant: applied.result.grant,
      transition: { ...applied.result.transition, executed: applied.executed },
    };
  }

  /** The derived usage-rights view (grant + revocation + status). */
  async function buildUsageRightsView(
    organizationScopeId: string,
    grant: UsageRightsGrant,
    asOf: string | null,
  ): Promise<UsageRightsView> {
    if (grant.organizationScopeId !== organizationScopeId) {
      throw new NotFoundError(`usage rights grant not found: ${grant.id}`, {
        id: grant.id,
        organizationScopeId,
      });
    }
    const revocation = await usageRightsRepository.findRevocation(grant.id);
    const viewedAsOf = asOf ?? nowIso();
    const effectiveStatus = usageRightsEffectiveStatus(
      grant,
      revocation,
      viewedAsOf,
    );
    return {
      grant,
      revocation,
      effectiveStatus,
      viewedAsOf,
    };
  }

  return {
    async createEngagement(execution, input) {
      assertOrganizationScopeId(input.organizationScopeId);
      assertIdempotencyKey(input.idempotencyKey);
      if (!input.creatorPersonId?.trim()) {
        throw engagementError("creatorPersonId is required", {
          field: "creatorPersonId",
        });
      }
      if (!input.campaignId?.trim()) {
        throw engagementError("campaignId is required", {
          field: "campaignId",
        });
      }
      const requestedRights = buildRequestedRights(input.requestedRights);
      const compensation = buildCompensation(input.compensation ?? null);

      // Campaign: existence + tenant scope through the neutral lookup
      // (cross-scope = indistinguishable from nonexistent).
      const campaign = await lookups.campaign.resolve(
        input.campaignId,
        input.campaignPolicyVersion ?? undefined,
      );
      if (!campaign || campaign.organizationScopeId !== input.organizationScopeId) {
        throw new NotFoundError(`campaign not found: ${input.campaignId}`, {
          campaignId: input.campaignId,
          organizationScopeId: input.organizationScopeId,
        });
      }

      // Creator profile: the offer targets a REAL, ACTIVE creator.
      const profile = await requireActiveProfile(
        input.organizationScopeId,
        input.creatorPersonId,
        input.creatorProfileId ?? null,
      );
      const latestVersion = await latestProfileVersion(profile.id);

      // Match-run lineage: the creator was an eligible candidate.
      if (input.matchRunId) {
        await verifyMatchRunLineage(
          input.organizationScopeId,
          input.matchRunId,
          profile.id,
        );
      }

      // Opportunity lineage: existence + tenant scope.
      if (input.opportunityId) {
        const scope = await lookups.opportunity.getOrganizationScope(
          input.opportunityId,
        );
        if (scope !== input.organizationScopeId) {
          throw new NotFoundError(
            `opportunity not found: ${input.opportunityId}`,
            {
              opportunityId: input.opportunityId,
              organizationScopeId: input.organizationScopeId,
            },
          );
        }
      }

      return createOffer(execution, {
        organizationScopeId: input.organizationScopeId,
        creatorPersonId: input.creatorPersonId,
        profile,
        profileVersion: latestVersion?.version ?? null,
        campaignId: campaign.campaignId,
        campaignPolicyVersion: campaign.policyVersion,
        matchRunId: input.matchRunId ?? null,
        opportunityId: input.opportunityId ?? null,
        requestedRights,
        compensation,
        brief: input.brief ?? null,
        idempotencyKey: input.idempotencyKey,
      });
    },

    async createEngagementsFromMatch(execution, input) {
      assertOrganizationScopeId(input.organizationScopeId);
      assertIdempotencyKey(input.idempotencyKey);
      if (!input.matchRunId?.trim()) {
        throw engagementError("matchRunId is required", {
          field: "matchRunId",
        });
      }
      const requestedRights = buildRequestedRights(input.offer.requestedRights);
      const compensation = buildCompensation(input.offer.compensation ?? null);
      const actor = actingPersonId(execution);

      // The run must exist within the caller's organization scope.
      const run = await runRepository.findById(input.matchRunId);
      if (!run || run.organizationScopeId !== input.organizationScopeId) {
        throw new NotFoundError(
          `creator match run not found: ${input.matchRunId}`,
          { matchRunId: input.matchRunId, organizationScopeId: input.organizationScopeId },
        );
      }
      const campaignId = run.campaign?.campaignId;
      if (!campaignId) {
        throw engagementError(
          "the referenced match run carries no campaign linkage; engagements require a campaign",
          { matchRunId: run.id },
        );
      }
      const campaign = await lookups.campaign.resolve(
        campaignId,
        run.campaign?.policyVersion,
      );
      if (!campaign || campaign.organizationScopeId !== input.organizationScopeId) {
        throw new NotFoundError(`campaign not found: ${campaignId}`, {
          campaignId,
          organizationScopeId: input.organizationScopeId,
        });
      }

      // Auto-match orchestration: every eligible candidate (rank
      // order, optional limit) becomes a DRAFT offer with the
      // template terms. Per-candidate outcomes are recorded — never
      // silently dropped.
      const limit =
        typeof input.limit === "number" && input.limit > 0
          ? input.limit
          : run.results.length;
      const candidates = run.results.slice(0, limit);

      // ------------------------------------------------------------------
      // NET-W017 remediation (architect CHANGES REQUESTED on PR #34):
      // the JOURNAL-FIRST recoverable batch saga. The batch decision
      // record is created BEFORE any candidate offer (status RUNNING,
      // empty snapshot); each candidate outcome APPENDS to the
      // per-candidate journal; the run finalizes to COMPLETED (the
      // outcome snapshot derived from the journal) or ABORTED (the
      // unexpected failure is recorded and rethrown). Consequences:
      //  - no durable offer can exist without its batch journal
      //    accurately describing it (crash mid-batch leaves the
      //    journal exact for every processed candidate);
      //  - a retry with the same idempotency key resumes
      //    deterministically: journal rows exist for processed
      //    candidates (skipped), the remaining ones execute, the
      //    finalize derives the complete snapshot.
      // ------------------------------------------------------------------
      const batchKey = `engagement_batch:${input.organizationScopeId}:${input.idempotencyKey}`;
      const batchApplied = await idempotency.applyIdempotent(
        batchKey,
        async (ctx) => {
          const tx = ctx.transaction;
          const batch: EngagementBatchRecord = Object.freeze({
            id: randomUUID(),
            organizationScopeId: input.organizationScopeId,
            matchRunId: run.id,
            campaignId: campaign.campaignId,
            campaignPolicyVersion: campaign.policyVersion,
            candidateCount: candidates.length,
            status: "RUNNING",
            outcomes: [],
            createdBy: actor,
            createdAt: nowIso(),
            completedAt: null,
            abortedAt: null,
            abortedReason: null,
            idempotencyKey: input.idempotencyKey,
            executionId: execution.executionId,
            correlationId: execution.correlationId,
            causationId: execution.causationId,
          });
          await batchRepository.createWithinTx(batch, tx);
          await appendAudit(tx, {
            eventType: ENGAGEMENT_BATCH_RECORDED,
            context: execution,
            actor,
            subject: batch.id,
            resourceType: "engagement_batch",
            resourceId: batch.id,
            metadata: {
              organizationScopeId: batch.organizationScopeId,
              matchRunId: batch.matchRunId,
              campaignId: batch.campaignId,
              candidateCount: batch.candidateCount,
              status: batch.status,
              idempotencyRecordId: ctx.recordId,
              transactionId: tx.transactionId,
            },
          });
          return batch;
        },
        execution,
      );
      const batch = batchApplied.result;

      /** Append ONE candidate outcome to the journal (idempotent). */
      const appendBatchOutcome = async (
        outcome: EngagementBatchOutcome,
      ): Promise<void> => {
        await idempotency.applyIdempotent(
          `${batchKey}:outcome:${outcome.creatorProfileId}`,
          async (ctx) => {
            const row: EngagementBatchOutcomeRecord = Object.freeze({
              id: `outcome:${batch.id}:${outcome.creatorProfileId}`,
              batchId: batch.id,
              organizationScopeId: batch.organizationScopeId,
              outcome,
              recordedAt: nowIso(),
              executionId: execution.executionId,
              correlationId: execution.correlationId,
              causationId: execution.causationId,
            });
            await batchRepository.appendOutcomeWithinTx(row, ctx.transaction);
          },
          execution,
        );
      };

      /** Durable ABORT (the journal stays exact for every processed candidate). */
      const abortBatch = async (reason: Record<string, unknown>, error: unknown) => {
        await idempotency.applyIdempotent(
          `${batchKey}:abort`,
          async (ctx) => {
            const abortedReason = JSON.stringify({
              ...reason,
              errorName: (error as Error)?.name ?? "Error",
              errorMessage: String((error as Error)?.message ?? "").slice(0, 300),
            });
            const aborted = await batchRepository.abortWithinTx(
              batch.id,
              abortedReason,
              nowIso(),
              ctx.transaction,
            );
            await appendAudit(ctx.transaction, {
              eventType: ENGAGEMENT_BATCH_ABORTED,
              context: execution,
              actor,
              subject: batch.id,
              resourceType: "engagement_batch",
              resourceId: batch.id,
              metadata: {
                organizationScopeId: batch.organizationScopeId,
                matchRunId: batch.matchRunId,
                campaignId: batch.campaignId,
                candidateCount: batch.candidateCount,
                abortedReason,
                idempotencyRecordId: ctx.recordId,
                transactionId: ctx.transaction.transactionId,
              },
            });
            return aborted;
          },
          execution,
        );
      };

      let currentCandidate: { profileId: string } | null = null;
      try {
        for (const candidate of candidates) {
          currentCandidate = { profileId: candidate.profileId };
          // Recovery: a journal row means a previous (aborted or
          // interrupted) run already processed this candidate — the
          // outcome stands; never re-decide it.
          const journaled = await batchRepository.findOutcome(
            batch.id,
            candidate.profileId,
          );
          if (journaled) continue;

          const profile = await profileRepository.findById(candidate.profileId);
          if (!profile || profile.status !== "ACTIVE") {
            await appendBatchOutcome({
              creatorPersonId: candidate.creatorPersonId,
              creatorProfileId: candidate.profileId,
              engagementId: null,
              created: false,
              skipped: "profile_not_active",
            });
            continue;
          }
          try {
            const created = await createOffer(execution, {
              organizationScopeId: input.organizationScopeId,
              creatorPersonId: candidate.creatorPersonId,
              profile,
              profileVersion: null,
              campaignId: campaign.campaignId,
              campaignPolicyVersion: campaign.policyVersion,
              matchRunId: run.id,
              opportunityId: null,
              requestedRights,
              compensation,
              brief: input.offer.brief ?? null,
              idempotencyKey: `${input.idempotencyKey}:${candidate.profileId}`,
            });
            await appendBatchOutcome({
              creatorPersonId: candidate.creatorPersonId,
              creatorProfileId: candidate.profileId,
              engagementId: created.engagement.id,
              created: created.created,
              skipped: null,
            });
          } catch (error) {
            if (error instanceof EngagementConflictError) {
              await appendBatchOutcome({
                creatorPersonId: candidate.creatorPersonId,
                creatorProfileId: candidate.profileId,
                engagementId: null,
                created: false,
                skipped: "open_engagement_exists",
              });
              continue;
            }
            throw error;
          }
        }
      } catch (error) {
        // The journal accurately describes every candidate processed
        // so far; the abort reason names the failure point. The error
        // propagates — the caller sees the failure, the record sees
        // the truth.
        await abortBatch(
          { failedCandidateProfileId: currentCandidate?.profileId ?? null },
          error,
        );
        throw error;
      }

      // Finalize: COMPLETED with the journal-derived snapshot (every
      // candidate carries exactly one journal row at this point).
      const journal = await batchRepository.listOutcomes(batch.id);
      const outcomes: EngagementBatchOutcome[] = journal.map(
        (row) => row.outcome,
      );
      const finalized = await idempotency.applyIdempotent(
        `${batchKey}:finalize`,
        async (ctx) => {
          const completed = await batchRepository.completeWithinTx(
            batch.id,
            outcomes,
            nowIso(),
            ctx.transaction,
          );
          await appendAudit(ctx.transaction, {
            eventType: ENGAGEMENT_BATCH_COMPLETED,
            context: execution,
            actor,
            subject: batch.id,
            resourceType: "engagement_batch",
            resourceId: batch.id,
            metadata: {
              organizationScopeId: completed.organizationScopeId,
              matchRunId: completed.matchRunId,
              campaignId: completed.campaignId,
              candidateCount: completed.candidateCount,
              createdCount: outcomes.filter((o) => o.created).length,
              skippedCount: outcomes.filter((o) => o.skipped !== null).length,
              idempotencyRecordId: ctx.recordId,
              transactionId: ctx.transaction.transactionId,
            },
          });
          return completed;
        },
        execution,
      );
      logger.info("engagement.batch_recorded", {
        batchId: finalized.result.id,
        organizationScopeId: input.organizationScopeId,
        created: batchApplied.executed,
        status: finalized.result.status,
      });
      return { batch: finalized.result, created: batchApplied.executed };
    },

    async acceptEngagement(execution, input) {
      assertOrganizationScopeId(input.organizationScopeId);
      assertIdempotencyKey(input.idempotencyKey);
      if (typeof input.expectedVersion !== "number" || input.expectedVersion < 0) {
        throw engagementError("expectedVersion must be a non-negative integer", {
          field: "expectedVersion",
        });
      }
      const engagement = await requireEngagement(
        input.organizationScopeId,
        input.engagementId,
      );
      const grantedRights = buildGrantedRights(input.grantedRights);
      const { grant, transition } = await recordGrantAndAccept(execution, {
        organizationScopeId: input.organizationScopeId,
        engagement,
        expectedVersion: input.expectedVersion,
        grantedRights,
        idempotencyKey: input.idempotencyKey,
        mode: "manual",
        extraMetadata: {},
      });
      const updated = await requireEngagement(
        input.organizationScopeId,
        input.engagementId,
      );
      return { engagement: updated, grant, transition };
    },

    async autoAcceptEngagement(execution, input) {
      assertOrganizationScopeId(input.organizationScopeId);
      assertIdempotencyKey(input.idempotencyKey);
      if (typeof input.expectedVersion !== "number" || input.expectedVersion < 0) {
        throw engagementError("expectedVersion must be a non-negative integer", {
          field: "expectedVersion",
        });
      }
      const engagement = await requireEngagement(
        input.organizationScopeId,
        input.engagementId,
      );

      // Assemble the deterministic evaluation inputs.
      const policy = await acceptancePolicyRepository.findLatest(
        input.organizationScopeId,
        engagement.creatorPersonId,
      );
      const profile = await profileRepository.findById(
        engagement.creatorProfileId,
      );
      const profileVersion = engagement.creatorProfileVersion
        ? await versionRepository.findVersion(
            engagement.creatorProfileId,
            engagement.creatorProfileVersion,
          )
        : await latestProfileVersion(engagement.creatorProfileId);
      const openEngagements = await engagementRepository.listNonTerminalByCreator(
        input.organizationScopeId,
        engagement.creatorPersonId,
      );
      const safety = await lookups.safety.activeHold(
        input.organizationScopeId,
        engagement.creatorPersonId,
      );
      const evaluation: AutoAcceptEvaluation = evaluateAutoAccept({
        policy,
        profileStatus: (profile?.status ?? null) as CreatorProfileStatus | null,
        acceptingWork: profileVersion?.sections.availability.acceptingWork ?? null,
        openEngagementCount: openEngagements.length,
        requestedUses: requestedUseKinds(engagement.requestedRights),
        requestedGrantDurationDays: grantDurationDays(
          engagement.requestedRights.startsAt,
          engagement.requestedRights.endsAt,
        ),
        compensation: engagement.compensation,
        safetyHeld: safety.held,
      });

      if (!evaluation.qualifies) {
        // A non-qualifying evaluation mutates NOTHING (work order
        // §3.2) — the trace is returned for inspection.
        logger.info("engagement.auto_accept_not_qualified", {
          engagementId: engagement.id,
          failedGates: evaluation.gates
            .filter((g) => !g.passed)
            .map((g) => g.reason),
        });
        return {
          accepted: false,
          evaluation,
          engagement,
          grant: null,
          transition: null,
        };
      }

      const grantedRights = deriveAutoGrant(engagement.requestedRights);
      const { grant, transition } = await recordGrantAndAccept(execution, {
        organizationScopeId: input.organizationScopeId,
        engagement,
        expectedVersion: input.expectedVersion,
        grantedRights,
        idempotencyKey: input.idempotencyKey,
        mode: "auto",
        extraMetadata: {
          policyVersion: evaluation.policyVersion,
          evaluation: {
            qualifies: evaluation.qualifies,
            gates: evaluation.gates.map((g) => ({
              reason: g.reason,
              passed: g.passed,
            })),
          },
        },
      });
      const updated = await requireEngagement(
        input.organizationScopeId,
        input.engagementId,
      );
      return {
        accepted: true,
        evaluation,
        engagement: updated,
        grant,
        transition,
      };
    },

    async revokeUsageRights(execution, input) {
      assertOrganizationScopeId(input.organizationScopeId);
      assertIdempotencyKey(input.idempotencyKey);
      const actor = actingPersonId(execution);
      const grant = await usageRightsRepository.findById(input.grantId);
      if (!grant || grant.organizationScopeId !== input.organizationScopeId) {
        throw new NotFoundError(
          `usage rights grant not found: ${input.grantId}`,
          { grantId: input.grantId, organizationScopeId: input.organizationScopeId },
        );
      }
      // Grantor-only: only the granting creator may revoke their grant.
      if (grant.grantorPersonId !== actor) {
        throw new AuthorizationError(
          "only the granting creator may revoke usage rights",
          { grantId: grant.id, actor, grantorPersonId: grant.grantorPersonId },
        );
      }
      const effectiveAt =
        input.effectiveAt?.trim() || nowIso();
      if (Number.isNaN(Date.parse(effectiveAt))) {
        throw engagementError("effectiveAt must be an ISO-8601 instant", {
          field: "effectiveAt",
        });
      }
      const reason =
        input.reason === undefined || input.reason === null
          ? null
          : String(input.reason);
      if (reason !== null && reason.length > 500) {
        throw engagementError("reason must be at most 500 characters", {
          field: "reason",
        });
      }

      const anchor = `usage_rights_revocation_anchor:${input.organizationScopeId}:${grant.id}`;
      const key = `usage_rights_revocation:${input.organizationScopeId}:${input.idempotencyKey}`;
      const applied = await idempotency.withLock(
        anchor,
        () =>
          idempotency.applyIdempotent(key, async (ctx) => {
            const tx = ctx.transaction;
            const existing = await usageRightsRepository.findRevocationWithinTx(
              grant.id,
              tx,
            );
            if (existing) {
              if (existing.idempotencyKey === input.idempotencyKey) {
                // Same-key replay path (the cached idempotency record
                // normally short-circuits this before fn runs).
                return await buildUsageRightsView(
                  input.organizationScopeId,
                  grant,
                  null,
                );
              }
              throw new UsageRightsConflictError(
                `usage rights grant ${grant.id} is already revoked (one revocation per grant)`,
                { grantId: grant.id, existingRevocationId: existing.id },
              );
            }
            const revocation: UsageRightsRevocation = Object.freeze({
              id: randomUUID(),
              organizationScopeId: input.organizationScopeId,
              grantId: grant.id,
              revokedBy: actor,
              reason,
              revokedAt: nowIso(),
              effectiveAt,
              idempotencyKey: input.idempotencyKey,
              executionId: execution.executionId,
              correlationId: execution.correlationId,
              causationId: execution.causationId,
            });
            await usageRightsRepository.createRevocationWithinTx(revocation, tx);
            await appendAudit(tx, {
              eventType: USAGE_RIGHTS_REVOKED,
              context: execution,
              actor,
              subject: grant.id,
              resourceType: "usage_rights_grant",
              resourceId: grant.id,
              metadata: {
                organizationScopeId: grant.organizationScopeId,
                engagementId: grant.engagementId,
                grantorPersonId: grant.grantorPersonId,
                revocationId: revocation.id,
                effectiveAt: revocation.effectiveAt,
                reason: revocation.reason,
                idempotencyRecordId: ctx.recordId,
                transactionId: tx.transactionId,
              },
            });
            const view: UsageRightsView = {
              grant,
              revocation,
              effectiveStatus: usageRightsEffectiveStatus(
                grant,
                revocation,
                revocation.revokedAt,
              ),
              viewedAsOf: revocation.revokedAt,
            };
            return view;
          }, execution),
      );
      logger.info("usage_rights.revoked", {
        grantId: grant.id,
        organizationScopeId: input.organizationScopeId,
        created: applied.executed,
      });
      return { view: applied.result, created: applied.executed };
    },

    async setAcceptancePolicy(execution, input) {
      assertOrganizationScopeId(input.organizationScopeId);
      assertIdempotencyKey(input.idempotencyKey);
      const actor = actingPersonId(execution);
      if (!input.creatorPersonId?.trim()) {
        throw engagementError("creatorPersonId is required", {
          field: "creatorPersonId",
        });
      }
      const mode: CreatorAcceptanceMode =
        input.mode === "manual" || input.mode === "auto_accept"
          ? input.mode
          : (() => {
              throw engagementError(
                'mode must be "manual" or "auto_accept"',
                { mode: input.mode },
              );
            })();
      const maxActiveEngagements =
        input.maxActiveEngagements ?? ACCEPTANCE_POLICY_MAX_ACTIVE_ENGAGEMENTS;
      if (
        typeof maxActiveEngagements !== "number" ||
        !Number.isInteger(maxActiveEngagements) ||
        maxActiveEngagements < 0 ||
        maxActiveEngagements > ACCEPTANCE_POLICY_MAX_ACTIVE_ENGAGEMENTS
      ) {
        throw engagementError(
          `maxActiveEngagements must be an integer between 0 and ${String(ACCEPTANCE_POLICY_MAX_ACTIVE_ENGAGEMENTS)}`,
          { maxActiveEngagements },
        );
      }
      let rateFloor = null as {
        format: CreatorContentFormat;
        unit: CreatorRateUnit;
        amount: number;
        currency: string;
      } | null;
      if (input.rateFloor !== null && input.rateFloor !== undefined) {
        if (!isCreatorContentFormat(input.rateFloor.format)) {
          throw engagementError("rateFloor.format is not a known format", {
            format: input.rateFloor.format,
          });
        }
        if (!isCreatorRateUnit(input.rateFloor.unit)) {
          throw engagementError("rateFloor.unit is not a known rate unit", {
            unit: input.rateFloor.unit,
          });
        }
        validateCreatorRateAmount("rateFloor.amount", input.rateFloor.amount);
        if (input.rateFloor.amount > ACCEPTANCE_POLICY_MAX_RATE_FLOOR) {
          throw engagementError(
            `rateFloor.amount must not exceed ${String(ACCEPTANCE_POLICY_MAX_RATE_FLOOR)}`,
            { amount: input.rateFloor.amount },
          );
        }
        validateCreatorCurrencyCode("rateFloor.currency", input.rateFloor.currency);
        rateFloor = {
          format: input.rateFloor.format,
          unit: input.rateFloor.unit,
          amount: input.rateFloor.amount,
          currency: input.rateFloor.currency,
        };
      }
      const autoGrantableRaw = input.autoGrantableRights ?? [];
      if (!Array.isArray(autoGrantableRaw) || autoGrantableRaw.length > 8) {
        throw engagementError(
          "autoGrantableRights must be a list of at most 8 rights kinds",
          { count: autoGrantableRaw?.length },
        );
      }
      const autoGrantableSet = new Set<string>();
      for (const kind of autoGrantableRaw) {
        if (!isCreatorRightsKind(kind)) {
          throw engagementError(
            `autoGrantableRights contains an unknown rights kind: ${String(kind)}`,
            { kind },
          );
        }
        autoGrantableSet.add(kind);
      }
      const autoGrantableRights = Array.from(autoGrantableSet) as readonly CreatorRightsKind[];
      const maxGrantDurationDays = input.maxGrantDurationDays ?? null;
      if (maxGrantDurationDays !== null) {
        if (
          typeof maxGrantDurationDays !== "number" ||
          !Number.isInteger(maxGrantDurationDays) ||
          maxGrantDurationDays < 1
        ) {
          throw engagementError(
            "maxGrantDurationDays must be a positive integer (or null)",
            { maxGrantDurationDays },
          );
        }
      }

      // The creator must have a profile in the org (the policy is
      // anchored to a real creator).
      await requireActiveProfile(
        input.organizationScopeId,
        input.creatorPersonId,
      );

      const anchor = `acceptance_policy_anchor:${input.organizationScopeId}:${input.creatorPersonId}`;
      const key = `acceptance_policy:${input.organizationScopeId}:${input.idempotencyKey}`;
      const applied = await idempotency.withLock(
        anchor,
        () =>
          idempotency.applyIdempotent(key, async (ctx) => {
            const tx = ctx.transaction;
            const latest = await acceptancePolicyRepository.findLatestWithinTx(
              input.organizationScopeId,
              input.creatorPersonId,
              tx,
            );
            const policy: CreatorAcceptancePolicyRecord = Object.freeze({
              id: randomUUID(),
              organizationScopeId: input.organizationScopeId,
              creatorPersonId: input.creatorPersonId,
              version: (latest?.version ?? 0) + 1,
              mode,
              maxActiveEngagements,
              rateFloor,
              autoGrantableRights,
              maxGrantDurationDays,
              createdBy: actor,
              createdAt: nowIso(),
              idempotencyKey: input.idempotencyKey,
              executionId: execution.executionId,
              correlationId: execution.correlationId,
              causationId: execution.causationId,
            });
            await acceptancePolicyRepository.createWithinTx(policy, tx);
            await appendAudit(tx, {
              eventType: ACCEPTANCE_POLICY_SET,
              context: execution,
              actor,
              subject: policy.id,
              resourceType: "creator_acceptance_policy",
              resourceId: policy.id,
              metadata: {
                organizationScopeId: policy.organizationScopeId,
                creatorPersonId: policy.creatorPersonId,
                version: policy.version,
                mode: policy.mode,
                maxActiveEngagements: policy.maxActiveEngagements,
                rateFloor: policy.rateFloor,
                autoGrantableRights: policy.autoGrantableRights,
                maxGrantDurationDays: policy.maxGrantDurationDays,
                idempotencyRecordId: ctx.recordId,
                transactionId: tx.transactionId,
              },
            });
            return policy;
          }, execution),
      );
      logger.info("creator_acceptance_policy.set", {
        policyId: applied.result.id,
        version: applied.result.version,
        organizationScopeId: input.organizationScopeId,
      });
      return { policy: applied.result, created: applied.executed };
    },

    async openProduction(execution, input) {
      assertOrganizationScopeId(input.organizationScopeId);
      assertIdempotencyKey(input.idempotencyKey);
      const actor = actingPersonId(execution);
      const engagement = await requireEngagement(
        input.organizationScopeId,
        input.engagementId,
      );
      // Replay tolerance: ASSIGNED is the live precondition; the
      // already-IN_PROGRESS case may be a same-key replay (a fresh
      // key fails on the stale expectedVersion).
      if (
        engagement.state !== "ASSIGNED" &&
        engagement.state !== "IN_PROGRESS"
      ) {
        throw engagementError(
          `engagement ${engagement.id} is not ASSIGNED (state: ${engagement.state}); production requires an accepted engagement`,
          { engagementId: engagement.id, state: engagement.state },
        );
      }
      // Production requires an EFFECTIVE usage-rights grant (rights
      // are explicit — an accepted engagement always carries one).
      const grant = await usageRightsRepository.findByEngagement(
        input.organizationScopeId,
        engagement.id,
      );
      if (!grant) {
        throw new UsageRightsConflictError(
          `no usage-rights grant exists for engagement ${engagement.id}; production requires explicit rights`,
          { engagementId: engagement.id },
        );
      }
      const status = usageRightsEffectiveStatus(
        grant,
        await usageRightsRepository.findRevocation(grant.id),
        nowIso(),
      );
      if (status !== "ACTIVE") {
        throw new UsageRightsConflictError(
          `the usage-rights grant for engagement ${engagement.id} is ${status}; production requires ACTIVE rights`,
          { engagementId: engagement.id, grantId: grant.id, status },
        );
      }
      // Contribution lineage: existence + tenant scope (when declared).
      if (input.contributionId) {
        const scope = await lookups.contribution.getOrganizationScope(
          input.contributionId,
        );
        if (scope !== input.organizationScopeId) {
          throw new NotFoundError(
            `contribution not found: ${input.contributionId}`,
            {
              contributionId: input.contributionId,
              organizationScopeId: input.organizationScopeId,
            },
          );
        }
      }

      const key = `ugc_production:${input.organizationScopeId}:${input.idempotencyKey}`;
      // NET-W017 remediation (single authoritative transaction): the
      // production record AND the ASSIGNED → IN_PROGRESS transition
      // commit as ONE unit — the transition executes through the
      // in-tx /workflows twin against the SAME transaction, so a
      // failure at ANY point rolls back BOTH (no orphaned production
      // for an engagement that never entered production).
      const subjectLock = `workflow:engagement:${engagement.id}`;
      const applied = await idempotency.withLock(
        subjectLock,
        () =>
          idempotency.applyIdempotent(key, async (ctx) => {
        const tx = ctx.transaction;
        // In-tx existence check (sees this tx's writes; a same-key
        // replay never reaches here — the idempotency store
        // short-circuits it with the committed composite result).
        const existing = await productionRepository.findByEngagementWithinTx(
          input.organizationScopeId,
          engagement.id,
          tx,
        );
        if (existing) {
          throw new EngagementConflictError(
            `a production record already exists for engagement ${engagement.id} (one production per engagement)`,
            { engagementId: engagement.id, productionId: existing.id },
          );
        }
        const production: UgcProduction = Object.freeze({
          id: randomUUID(),
          organizationScopeId: input.organizationScopeId,
          engagementId: engagement.id,
          creatorPersonId: engagement.creatorPersonId,
          creatorProfileId: engagement.creatorProfileId,
          campaignId: engagement.campaignId,
          campaignPolicyVersion: engagement.campaignPolicyVersion,
          matchRunId: engagement.matchRunId,
          opportunityId: engagement.opportunityId,
          contributionId: input.contributionId ?? null,
          formatVersion: CREATOR_ENGAGEMENT_FORMAT,
          createdBy: actor,
          openedAt: nowIso(),
          idempotencyKey: input.idempotencyKey,
          executionId: execution.executionId,
          correlationId: execution.correlationId,
          causationId: execution.causationId,
        });
        await productionRepository.createWithinTx(production, tx);
        await appendAudit(tx, {
          eventType: UGC_PRODUCTION_OPENED,
          context: execution,
          actor,
          subject: production.id,
          resourceType: "ugc_production",
          resourceId: production.id,
          metadata: {
            organizationScopeId: production.organizationScopeId,
            engagementId: engagement.id,
            creatorPersonId: production.creatorPersonId,
            campaignId: production.campaignId,
            opportunityId: production.opportunityId,
            contributionId: production.contributionId,
            idempotencyRecordId: ctx.recordId,
            transactionId: tx.transactionId,
          },
        });

        // The AUTHORITATIVE in-tx precondition: the engagement must be
        // ASSIGNED in THIS transaction (a concurrent composite or a
        // direct transition loses on this check or on the twin's
        // version check; either way everything rolls back).
        const fresh = await engagementRepository.getByIdWithinTx(
          engagement.id,
          tx,
        );
        if (!fresh) {
          throw engagementNotFound(engagement.id, input.organizationScopeId);
        }
        if (fresh.state !== "ASSIGNED") {
          throw engagementError(
            `engagement ${engagement.id} is not ASSIGNED (state: ${fresh.state}); production requires an accepted engagement`,
            { engagementId: engagement.id, state: fresh.state },
          );
        }

        // The ASSIGNED → IN_PROGRESS transition through the canonical
        // /workflows authority — INSIDE the SAME transaction.
        const transition = await workflow.requestTransitionWithinTx(
          {
            subjectId: engagement.id,
            subjectKind: "engagement",
            targetState: "IN_PROGRESS",
            expectedVersion: input.expectedVersion,
            idempotencyKey: input.idempotencyKey,
            actorPersonId: actor,
            policyAction: policyActionFor("engagement", "ASSIGNED", "IN_PROGRESS"),
            metadata: {
              production: { productionId: production.id },
            },
          },
          execution,
          tx,
          ctx.recordId,
        );
        return { production, transition };
        }, execution),
      );
      // Replay contract: `executed` reflects THIS call (W004 precedent).
      return {
        production: applied.result.production,
        transition: { ...applied.result.transition, executed: applied.executed },
      };
    },

    async recordDeliverable(execution, input) {
      assertOrganizationScopeId(input.organizationScopeId);
      assertIdempotencyKey(input.idempotencyKey);
      const actor = actingPersonId(execution);
      const production = await requireProduction(
        input.organizationScopeId,
        input.productionId,
      );
      const engagement = await requireEngagement(
        input.organizationScopeId,
        production.engagementId,
      );
      if (engagement.state !== "IN_PROGRESS") {
        throw engagementError(
          `engagement ${engagement.id} is not IN_PROGRESS (state: ${engagement.state}); deliverables are recorded during production`,
          { engagementId: engagement.id, state: engagement.state },
        );
      }
      const deliverableKey = input.deliverableKey?.trim() ?? "";
      if (!/^[a-z0-9][a-z0-9_-]{0,63}$/.test(deliverableKey)) {
        throw engagementError(
          'deliverableKey must be a lowercase slug (a-z, 0-9, "-", "_"; max 64 chars)',
          { deliverableKey },
        );
      }
      if (!isCreatorContentFormat(input.format)) {
        throw engagementError("format is not a known content format", {
          format: input.format,
        });
      }
      const title = input.title?.trim() || null;
      if (title !== null && title.length > 200) {
        throw engagementError("title must be at most 200 characters", {
          field: "title",
        });
      }
      const contentReference = input.contentReference?.trim() || null;
      if (contentReference !== null && contentReference.length > 500) {
        throw engagementError(
          "contentReference must be at most 500 characters",
          { field: "contentReference" },
        );
      }
      let externalPlatform = null as {
        provider: string;
        externalId: string;
        url: string | null;
      } | null;
      if (input.externalPlatform !== null && input.externalPlatform !== undefined) {
        const provider = input.externalPlatform.provider?.trim() ?? "";
        const externalId = input.externalPlatform.externalId?.trim() ?? "";
        const url = input.externalPlatform.url?.trim() || null;
        if (!provider || provider.length > 64) {
          throw engagementError(
            "externalPlatform.provider must be a non-empty string of at most 64 characters",
            { provider },
          );
        }
        if (!externalId || externalId.length > 200) {
          throw engagementError(
            "externalPlatform.externalId must be a non-empty string of at most 200 characters",
            { externalId },
          );
        }
        if (url !== null && url.length > 1000) {
          throw engagementError(
            "externalPlatform.url must be at most 1000 characters",
            { url },
          );
        }
        externalPlatform = { provider, externalId, url };
      }
      const notes = input.notes?.trim() || null;
      if (notes !== null && notes.length > 2000) {
        throw engagementError("notes must be at most 2000 characters", {
          field: "notes",
        });
      }

      // Deterministic versioning: the version number is the monotonic
      // count per (production, deliverableKey), serialized under the
      // production-key anchor so concurrent recordings cannot fork.
      const anchor = `deliverable_anchor:${input.organizationScopeId}:${production.id}:${deliverableKey}`;
      const key = `ugc_deliverable:${input.organizationScopeId}:${input.idempotencyKey}`;
      const applied = await idempotency.withLock(
        anchor,
        () =>
          idempotency.applyIdempotent(key, async (ctx) => {
            const tx = ctx.transaction;
            const version =
              (await deliverableRepository.countByKeyWithinTx(
                production.id,
                deliverableKey,
                tx,
              )) + 1;
            const deliverable: UgcDeliverableVersion = Object.freeze({
              id: randomUUID(),
              organizationScopeId: input.organizationScopeId,
              productionId: production.id,
              deliverableKey,
              version,
              format: input.format as CreatorContentFormat,
              title,
              contentReference,
              externalPlatform,
              notes,
              createdBy: actor,
              createdAt: nowIso(),
              idempotencyKey: input.idempotencyKey,
              executionId: execution.executionId,
              correlationId: execution.correlationId,
              causationId: execution.causationId,
            });
            await deliverableRepository.createWithinTx(deliverable, tx);
            await appendAudit(tx, {
              eventType: UGC_DELIVERABLE_RECORDED,
              context: execution,
              actor,
              subject: deliverable.id,
              resourceType: "ugc_deliverable",
              resourceId: deliverable.id,
              metadata: {
                organizationScopeId: deliverable.organizationScopeId,
                productionId: production.id,
                engagementId: production.engagementId,
                deliverableKey,
                version,
                format: deliverable.format,
                hasExternalPlatform: externalPlatform !== null,
                externalProvider: externalPlatform?.provider ?? null,
                idempotencyRecordId: ctx.recordId,
                transactionId: tx.transactionId,
              },
            });
            return deliverable;
          }, execution),
      );
      logger.info("ugc_production.deliverable_recorded", {
        deliverableId: applied.result.id,
        productionId: production.id,
        deliverableKey,
        version: applied.result.version,
      });
      return { deliverable: applied.result, created: applied.executed };
    },

    async submitProduction(execution, input) {
      assertOrganizationScopeId(input.organizationScopeId);
      assertIdempotencyKey(input.idempotencyKey);
      const actor = actingPersonId(execution);
      const production = await requireProduction(
        input.organizationScopeId,
        input.productionId,
      );
      const engagement = await requireEngagement(
        input.organizationScopeId,
        production.engagementId,
      );
      // Replay tolerance: IN_PROGRESS is the live precondition; the
      // already-SUBMITTED case may be a same-key replay (a fresh key
      // fails on the stale expectedVersion).
      if (
        engagement.state !== "IN_PROGRESS" &&
        engagement.state !== "SUBMITTED"
      ) {
        throw engagementError(
          `engagement ${engagement.id} is not IN_PROGRESS (state: ${engagement.state}); submission requires an in-progress production`,
          { engagementId: engagement.id, state: engagement.state },
        );
      }
      const evidenceReferences = input.evidenceReferences ?? [];
      if (!Array.isArray(evidenceReferences) || evidenceReferences.length === 0) {
        throw engagementError(
          "evidenceReferences must be a non-empty list of canonical evidence ids",
          { count: evidenceReferences?.length },
        );
      }
      const uniqueEvidence = new Set<string>();
      for (const evidenceId of evidenceReferences) {
        if (typeof evidenceId !== "string" || !evidenceId.trim()) {
          throw engagementError(
            "every evidenceReference must be a non-empty string",
            { evidenceId },
          );
        }
        if (uniqueEvidence.has(evidenceId)) {
          throw engagementError(
            `duplicate evidence reference: ${evidenceId}`,
            { evidenceId },
          );
        }
        uniqueEvidence.add(evidenceId);
      }
      // ≥1 recorded deliverable version.
      const deliverables = await deliverableRepository.listByProduction(
        input.organizationScopeId,
        production.id,
      );
      if (deliverables.length === 0) {
        throw engagementError(
          `production ${production.id} has no recorded deliverable versions; submission requires at least one`,
          { productionId: production.id },
        );
      }
      // EVERY evidence reference must resolve through the canonical
      // /evidence authority to THIS production (existence + tenant
      // scope + subject binding — the UGC boundary never fabricates
      // evidence).
      for (const evidenceId of uniqueEvidence) {
        const view = await lookups.evidence.resolve(evidenceId);
        if (!view || view.organizationScopeId !== input.organizationScopeId) {
          throw engagementError(
            `evidence reference not found in organization scope: ${evidenceId}`,
            { evidenceId, organizationScopeId: input.organizationScopeId },
          );
        }
        if (
          view.subjectType !== UGC_PRODUCTION_SUBJECT_TYPE ||
          view.subjectId !== production.id
        ) {
          throw engagementError(
            `evidence reference ${evidenceId} is not bound to this production (subject: ${view.subjectType}:${view.subjectId})`,
            { evidenceId, subjectType: view.subjectType, subjectId: view.subjectId },
          );
        }
      }

      const key = `ugc_submission:${input.organizationScopeId}:${input.idempotencyKey}`;
      // NET-W017 remediation (single authoritative transaction): the
      // submission record AND the IN_PROGRESS → SUBMITTED transition
      // commit as ONE unit — no orphaned submission can survive a
      // transition rejection (the twin executes in THIS transaction).
      const subjectLock = `workflow:engagement:${engagement.id}`;
      const applied = await idempotency.withLock(
        subjectLock,
        () =>
          idempotency.applyIdempotent(key, async (ctx) => {
        const tx = ctx.transaction;
        // In-tx existence check (a same-key replay never reaches
        // here — the store returns the committed composite).
        const existing = await submissionRepository.listByProductionWithinTx(
          input.organizationScopeId,
          production.id,
          tx,
        );
        if (existing.length > 0) {
          throw new EngagementConflictError(
            `production ${production.id} already has a recorded submission (one submission per production)`,
            { productionId: production.id },
          );
        }
        const submission: UgcSubmission = Object.freeze({
          id: randomUUID(),
          organizationScopeId: input.organizationScopeId,
          productionId: production.id,
          engagementId: engagement.id,
          deliverableCount: deliverables.length,
          evidenceReferences: Array.from(uniqueEvidence),
          createdBy: actor,
          submittedAt: nowIso(),
          idempotencyKey: input.idempotencyKey,
          executionId: execution.executionId,
          correlationId: execution.correlationId,
          causationId: execution.causationId,
        });
        await submissionRepository.createWithinTx(submission, tx);
        await appendAudit(tx, {
          eventType: UGC_PRODUCTION_SUBMITTED,
          context: execution,
          actor,
          subject: submission.id,
          resourceType: "ugc_submission",
          resourceId: submission.id,
          metadata: {
            organizationScopeId: submission.organizationScopeId,
            productionId: production.id,
            engagementId: engagement.id,
            creatorPersonId: production.creatorPersonId,
            deliverableCount: submission.deliverableCount,
            evidenceReferences: submission.evidenceReferences,
            idempotencyRecordId: ctx.recordId,
            transactionId: tx.transactionId,
          },
        });

        // The AUTHORITATIVE in-tx precondition: the engagement must be
        // IN_PROGRESS in THIS transaction (replay tolerance is handled
        // by the idempotent apply short-circuit; a fresh key against an
        // already-submitted engagement conflicts HERE, atomically).
        const fresh = await engagementRepository.getByIdWithinTx(
          engagement.id,
          tx,
        );
        if (!fresh) {
          throw engagementNotFound(engagement.id, input.organizationScopeId);
        }
        if (fresh.state !== "IN_PROGRESS") {
          throw engagementError(
            `engagement ${engagement.id} is not IN_PROGRESS (state: ${fresh.state}); submission requires an in-progress production`,
            { engagementId: engagement.id, state: fresh.state },
          );
        }

        // The IN_PROGRESS → SUBMITTED transition through the canonical
        // /workflows authority — INSIDE the SAME transaction.
        const transition = await workflow.requestTransitionWithinTx(
          {
            subjectId: engagement.id,
            subjectKind: "engagement",
            targetState: "SUBMITTED",
            expectedVersion: input.expectedVersion,
            idempotencyKey: input.idempotencyKey,
            actorPersonId: actor,
            policyAction: policyActionFor("engagement", "IN_PROGRESS", "SUBMITTED"),
            metadata: {
              submission: {
                submissionId: submission.id,
                productionId: production.id,
                evidenceReferences: submission.evidenceReferences,
              },
            },
          },
          execution,
          tx,
          ctx.recordId,
        );
        return { submission, transition };
        }, execution),
      );
      // Replay contract: `executed` reflects THIS call (W004 precedent).
      return {
        submission: applied.result.submission,
        transition: { ...applied.result.transition, executed: applied.executed },
      };
    },

    async getEngagement(execution, organizationScopeId, id) {
      void execution;
      assertOrganizationScopeId(organizationScopeId);
      return requireEngagement(organizationScopeId, id);
    },

    async listEngagements(execution, organizationScopeId, filters) {
      void execution;
      assertOrganizationScopeId(organizationScopeId);
      return engagementRepository.listByOrganization(
        organizationScopeId,
        filters,
      );
    },

    async getAcceptancePolicy(execution, organizationScopeId, creatorPersonId) {
      void execution;
      assertOrganizationScopeId(organizationScopeId);
      return acceptancePolicyRepository.findLatest(
        organizationScopeId,
        creatorPersonId,
      );
    },

    async getUsageRights(execution, organizationScopeId, grantId, asOf) {
      void execution;
      assertOrganizationScopeId(organizationScopeId);
      const grant = await usageRightsRepository.findById(grantId);
      if (!grant) {
        throw new NotFoundError(`usage rights grant not found: ${grantId}`, {
          grantId,
          organizationScopeId,
        });
      }
      return buildUsageRightsView(organizationScopeId, grant, asOf ?? null);
    },

    async listUsageRights(execution, organizationScopeId, engagementId) {
      void execution;
      assertOrganizationScopeId(organizationScopeId);
      const grants = await usageRightsRepository.listByOrganization(
        organizationScopeId,
        engagementId,
      );
      const views: UsageRightsView[] = [];
      for (const grant of grants) {
        views.push(
          await buildUsageRightsView(organizationScopeId, grant, null),
        );
      }
      return views;
    },

    async getProduction(execution, organizationScopeId, id) {
      void execution;
      assertOrganizationScopeId(organizationScopeId);
      return requireProduction(organizationScopeId, id);
    },

    async listProductions(execution, organizationScopeId, engagementId) {
      void execution;
      assertOrganizationScopeId(organizationScopeId);
      return productionRepository.listByOrganization(
        organizationScopeId,
        engagementId,
      );
    },

    async listDeliverables(execution, organizationScopeId, productionId) {
      void execution;
      assertOrganizationScopeId(organizationScopeId);
      await requireProduction(organizationScopeId, productionId);
      return deliverableRepository.listByProduction(
        organizationScopeId,
        productionId,
      );
    },

    async listSubmissions(execution, organizationScopeId, productionId) {
      void execution;
      assertOrganizationScopeId(organizationScopeId);
      await requireProduction(organizationScopeId, productionId);
      return submissionRepository.listByProduction(
        organizationScopeId,
        productionId,
      );
    },

    async getEngagementBatch(execution, organizationScopeId, batchId) {
      void execution;
      assertOrganizationScopeId(organizationScopeId);
      const batch = await batchRepository.findById(batchId);
      if (!batch || batch.organizationScopeId !== organizationScopeId) {
        throw new NotFoundError(`engagement batch not found: ${batchId}`, {
          id: batchId,
          organizationScopeId,
        });
      }
      return batch;
    },

    async listEngagementBatchOutcomes(execution, organizationScopeId, batchId) {
      void execution;
      assertOrganizationScopeId(organizationScopeId);
      // Tenant-scope via the batch itself (cross-scope = NotFound).
      const batch = await batchRepository.findById(batchId);
      if (!batch || batch.organizationScopeId !== organizationScopeId) {
        throw new NotFoundError(`engagement batch not found: ${batchId}`, {
          id: batchId,
          organizationScopeId,
        });
      }
      return batchRepository.listOutcomes(batchId);
    },
  };
}

// Re-exported for the composition root + tests (pure helpers).
export {
  buildRequestedRights,
  buildGrantedRights,
  evaluateAutoAccept,
  usageRightsEffectiveStatus,
  grantDurationDays,
  deriveAutoGrant,
  assertGrantedWithinEnvelope,
  requestedUseKinds,
};
