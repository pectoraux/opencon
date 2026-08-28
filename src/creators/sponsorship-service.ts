/**
 * The NET-W018 sponsorship domain service — commercial relationships,
 * disclosure declarations and the publication disclosure gate.
 *
 * Work order ref: spec/work-orders/NET-W018.md.
 *
 * AUTHORITY MODEL (work order §2 — the decision of record):
 *  - /workflows is the SOLE lifecycle authority: the publication is a
 *    canonical lifecycle subject ("publication") and its DRAFT →
 *    VERIFIED transition — THE DISCLOSURE GATE — executes exclusively
 *    through the injected {@link SponsorshipWorkflowPort.requestTransitionWithinTx}
 *    delegation twin inside the caller's authoritative transaction
 *    (the NET-W017 remediation decision of record, applied from the
 *    start: the material verification bookkeeping AND the transition
 *    commit as ONE all-or-nothing authoritative unit). This service
 *    validates business preconditions BEFORE requesting; it NEVER
 *    mutates lifecycle state itself and contains NO transition
 *    machinery.
 *  - /campaigns is the campaign policy authority: the disclosure
 *    policy is a section of the versioned campaign policy, resolved
 *    READ-ONLY through the neutral
 *    {@link CampaignDisclosurePolicyLookup} (existence + tenant scope
 *    + pinned-or-latest version + declared requiredKinds).
 *  - /evidence is the truth authority: every publication-evidence and
 *    declaration-evidence reference is validated through the neutral
 *    evidence lookup (existence + tenant scope + EXACT subject
 *    binding to this publication). This boundary never fabricates
 *    disclosure proof.
 *  - /settlement is the economic authority: relationship compensation
 *    is REFERENCE DATA ONLY (the EngagementCompensationTerms
 *    precedent) — no balances, no postings, no second ledger.
 *  - /outcomes + /reputation + /disputes are UNTOUCHED mutators here:
 *    the only mutations are this boundary's own append-only records +
 *    the workflow-mediated publication transition + the sponsorship
 *    audit events.
 *  - NO AI path exists anywhere in this service (work order §2).
 *
 * THE DISCLOSURE GATE (invariant 4 — the core of NET-W018): the
 * required disclosure obligations are DERIVED from durable records
 * (campaign policy ∪ commercial-relationship obligations) inside the
 * verification composite and proven satisfied by evidence-bound
 * declarations BEFORE the transition is requested. There is NO input
 * on any command that can assert compliance, waive an obligation or
 * bypass the derivation — a caller cannot mark a disclosure
 * satisfied; only a recorded, evidence-bound declaration can.
 *
 * Every material mutation flows through
 * IdempotencyStore.applyIdempotent (exactly-once-per-key; the
 * mutation + the idempotency record + the transactional audit event
 * commit in ONE authoritative transaction). Concurrency-sensitive
 * composites are serialized with withLock over the workflow-subject
 * advisory key (the NET-W017 remediation precedent).
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
import { isCampaignDisclosureKind } from "../core/campaigns.ts";
import type { CampaignDisclosureKind } from "../core/campaigns.ts";
import {
  COMMERCIAL_RELATIONSHIP_FORMAT,
  COMMERCIAL_RELATIONSHIP_KINDS,
  COMMERCIAL_RELATIONSHIP_MAX_OBLIGATIONS,
  COMMERCIAL_RELATIONSHIP_MAX_PROSE_CHARS,
  DISCLOSURE_DECLARATION_FORMAT,
  DISCLOSURE_DECLARATION_MAX_EVIDENCE_REFERENCES,
  DISCLOSURE_DECLARATION_MAX_PER_PUBLICATION,
  DISCLOSURE_DECLARATION_MAX_STATEMENT_CHARS,
  DisclosureObligationsUnsatisfiedError,
  InvalidSponsorshipError,
  CommercialRelationshipConflictError,
  PUBLICATION_MAX_EVIDENCE_REFERENCES,
  PUBLICATION_RECORD_FORMAT,
  isCommercialRelationshipKind,
  isCreatorContentFormat,
  isCreatorRateUnit,
  validateCreatorCurrencyCode,
  validateCreatorRateAmount,
} from "../core/creators.ts";
import type { UsageRightsChannel } from "../core/creators.ts";
import { isUsageRightsChannel } from "../core/creators.ts";
import type {
  CommercialRelationship,
  CreateCommercialRelationshipInput,
  CreateCommercialRelationshipResult,
  CreatePublicationInput,
  CreatePublicationResult,
  CreatorSponsorshipService,
  CreatorSponsorshipServiceDeps,
  DisclosureDeclaration,
  Engagement,
  PublicationDisclosureStatus,
  PublicationRecord,
  RecordDisclosureDeclarationInput,
  RecordDisclosureDeclarationResult,
  ResolvedCampaignDisclosurePolicy,
  TerminateCommercialRelationshipInput,
  UgcProduction,
  VerifyPublicationInput,
  VerifyPublicationResult,
} from "./port.ts";
import {
  buildPublicationDisclosureStatus,
  deriveRequiredDisclosures,
  evaluateDisclosureObligations,
} from "./disclosure-engine.ts";

const COMMERCIAL_RELATIONSHIP_RECORDED = "commercial_relationship.recorded" as const;
const COMMERCIAL_RELATIONSHIP_TERMINATED = "commercial_relationship.terminated" as const;
const DISCLOSURE_DECLARATION_RECORDED = "disclosure_declaration.recorded" as const;
const PUBLICATION_RECORDED = "publication.recorded" as const;
const PUBLICATION_VERIFIED = "publication.verified" as const;

/** The canonical subject type evidence records bind publication evidence to. */
export const PUBLICATION_SUBJECT_TYPE = "publication" as const;

function sponsorshipError(
  message: string,
  context: Readonly<Record<string, unknown>>,
): OpenConError {
  return new InvalidSponsorshipError(message, context);
}

function assertIdempotencyKey(idempotencyKey: string): string {
  if (typeof idempotencyKey !== "string" || !idempotencyKey.trim()) {
    throw sponsorshipError("idempotencyKey is required", {
      field: "idempotencyKey",
    });
  }
  return idempotencyKey;
}

function assertOrganizationScopeId(organizationScopeId: string): string {
  if (typeof organizationScopeId !== "string" || !organizationScopeId.trim()) {
    throw sponsorshipError("organizationScopeId is required", {
      field: "organizationScopeId",
    });
  }
  return organizationScopeId;
}

/** The acting person's id (recorded as createdBy on every record). */
function actingPersonId(execution: ExecutionContext): string {
  if (!execution.actor || execution.actor.kind !== "person") {
    throw new AuthorizationError(
      "sponsorship commands require an authenticated person actor",
      { actorKind: execution.actor?.kind ?? null },
    );
  }
  return execution.actor.id;
}

function nowIso(): string {
  return new Date().toISOString();
}

/** Validate + normalize the reference-only compensation terms (declared data). */
function buildCommercialCompensation(raw: {
  readonly format: string;
  readonly unit: string;
  readonly amount: number;
  readonly currency: string;
  readonly rewardPolicyReference?: string | null;
} | null | undefined): CommercialRelationship["compensation"] {
  if (raw === null || raw === undefined) return null;
  if (!isCreatorContentFormat(raw.format)) {
    throw sponsorshipError("compensation.format is not a known format", {
      format: raw.format,
    });
  }
  if (!isCreatorRateUnit(raw.unit)) {
    throw sponsorshipError("compensation.unit is not a known rate unit", {
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
    throw sponsorshipError(
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

/** Validate the disclosure-obligation list against the frozen vocabulary. */
function validateDisclosureObligations(
  field: string,
  obligations: readonly string[],
): readonly CampaignDisclosureKind[] {
  if (!Array.isArray(obligations)) {
    throw sponsorshipError(`${field} must be an array of disclosure kinds`, {
      field,
    });
  }
  if (obligations.length > COMMERCIAL_RELATIONSHIP_MAX_OBLIGATIONS) {
    throw sponsorshipError(
      `${field} must carry at most ${String(COMMERCIAL_RELATIONSHIP_MAX_OBLIGATIONS)} entries`,
      { field, count: obligations.length },
    );
  }
  const seen = new Set<string>();
  for (const kind of obligations) {
    if (typeof kind !== "string" || !isCampaignDisclosureKind(kind)) {
      throw sponsorshipError(
        `${field} contains an unknown disclosure kind (got ${String(kind)}; frozen vocabulary: material_connection, paid_partnership, gifted_product, genuine_experience, brand_affiliation)`,
        { field, kind },
      );
    }
    if (seen.has(kind)) {
      throw sponsorshipError(`${field} contains duplicate kind ${kind}`, {
        field,
        kind,
      });
    }
    seen.add(kind);
  }
  return Object.freeze([...obligations]) as readonly CampaignDisclosureKind[];
}

/** Validate the provider-neutral channel descriptor (AC-06). */
function buildChannel(raw: CreatePublicationInput["channel"]): {
  kind: UsageRightsChannel;
  externalPlatform: {
    provider: string;
    externalId: string;
    url: string | null;
  } | null;
} {
  if (!raw || typeof raw !== "object") {
    throw sponsorshipError("channel is required", { field: "channel" });
  }
  if (
    typeof raw.kind !== "string" ||
    !isUsageRightsChannel(raw.kind)
  ) {
    throw sponsorshipError(
      `channel.kind must be a closed-vocabulary channel kind (got ${String(raw.kind)})`,
      { field: "channel.kind", kind: raw.kind },
    );
  }
  let externalPlatform: {
    provider: string;
    externalId: string;
    url: string | null;
  } | null = null;
  if (raw.externalPlatform !== null && raw.externalPlatform !== undefined) {
    const provider = raw.externalPlatform.provider?.trim() ?? "";
    const externalId = raw.externalPlatform.externalId?.trim() ?? "";
    const url = raw.externalPlatform.url?.trim() || null;
    if (!provider || provider.length > 64) {
      throw sponsorshipError(
        "channel.externalPlatform.provider must be a non-empty string of at most 64 characters",
        { field: "channel.externalPlatform.provider" },
      );
    }
    if (!externalId || externalId.length > 200) {
      throw sponsorshipError(
        "channel.externalPlatform.externalId must be a non-empty string of at most 200 characters",
        { field: "channel.externalPlatform.externalId" },
      );
    }
    if (url !== null && url.length > 1000) {
      throw sponsorshipError(
        "channel.externalPlatform.url must be at most 1000 characters",
        { field: "channel.externalPlatform.url" },
      );
    }
    externalPlatform = { provider, externalId, url };
  }
  return { kind: raw.kind, externalPlatform };
}

export function createCreatorSponsorshipService(
  deps: CreatorSponsorshipServiceDeps,
): CreatorSponsorshipService {
  const {
    relationshipRepository,
    declarationRepository,
    publicationRepository,
    engagementRepository,
    productionRepository,
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
      throw new NotFoundError(`engagement not found: ${id}`, {
        id,
        organizationScopeId,
      });
    }
    return engagement;
  }

  async function requireEngagementWithinTx(
    organizationScopeId: string,
    id: string,
    tx: AuthorityTransaction,
  ): Promise<Engagement> {
    const engagement = await engagementRepository.getByIdWithinTx(id, tx);
    if (!engagement || engagement.organizationScopeId !== organizationScopeId) {
      throw new NotFoundError(`engagement not found: ${id}`, {
        id,
        organizationScopeId,
      });
    }
    return engagement;
  }

  async function requirePublication(
    organizationScopeId: string,
    id: string,
  ): Promise<PublicationRecord> {
    const publication = await publicationRepository.findById(id);
    if (!publication || publication.organizationScopeId !== organizationScopeId) {
      throw new NotFoundError(`publication not found: ${id}`, {
        id,
        organizationScopeId,
      });
    }
    return publication;
  }

  async function requireRelationship(
    organizationScopeId: string,
    id: string,
  ): Promise<CommercialRelationship> {
    const relationship = await relationshipRepository.findById(id);
    if (!relationship || relationship.organizationScopeId !== organizationScopeId) {
      throw new NotFoundError(`commercial relationship not found: ${id}`, {
        id,
        organizationScopeId,
      });
    }
    return relationship;
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

  /**
   * Validate every evidence reference against the canonical
   * /evidence authority: existence + tenant scope + EXACT subject
   * binding to THIS publication (subjectType "publication",
   * subjectId == publicationId). Deduplicated, bounded. This is the
   * invariant-6 enforcement: disclosure/publication proof cannot be
   * fabricated in the creator domain.
   */
  async function validatePublicationEvidenceReferences(
    organizationScopeId: string,
    publicationId: string,
    references: readonly string[],
    max: number,
  ): Promise<readonly string[]> {
    if (!Array.isArray(references) || references.length === 0) {
      throw sponsorshipError(
        "evidenceReferences must be a non-empty list of canonical evidence ids",
        { count: references?.length },
      );
    }
    if (references.length > max) {
      throw sponsorshipError(
        `evidenceReferences must carry at most ${String(max)} entries`,
        { count: references.length },
      );
    }
    const unique = new Set<string>();
    for (const evidenceId of references) {
      if (typeof evidenceId !== "string" || !evidenceId.trim()) {
        throw sponsorshipError(
          "every evidenceReference must be a non-empty string",
          { evidenceId },
        );
      }
      if (unique.has(evidenceId)) {
        throw sponsorshipError(
          `duplicate evidence reference: ${evidenceId}`,
          { evidenceId },
        );
      }
      unique.add(evidenceId);
    }
    for (const evidenceId of unique) {
      const view = await lookups.evidence.resolve(evidenceId);
      if (!view || view.organizationScopeId !== organizationScopeId) {
        throw sponsorshipError(
          `evidence reference not found in organization scope: ${evidenceId}`,
          { evidenceId, organizationScopeId },
        );
      }
      if (
        view.subjectType !== PUBLICATION_SUBJECT_TYPE ||
        view.subjectId !== publicationId
      ) {
        throw sponsorshipError(
          `evidence reference ${evidenceId} is not bound to this publication (subject: ${view.subjectType}:${view.subjectId})`,
          { evidenceId, subjectType: view.subjectType, subjectId: view.subjectId },
        );
      }
    }
    return Object.freeze([...unique]);
  }

  /**
   * Resolve the campaign's disclosure policy for the engagement's
   * PINNED policy version (or the latest when the engagement pinned
   * none). A campaign that resolves cross-scope or not at all is an
   * engagement-lineage error at this point (the engagement referenced
   * it at creation); an empty/absent policy section reads as NO
   * declared requirements (the relationship obligations still apply).
   */
  async function resolveDisclosurePolicy(
    organizationScopeId: string,
    engagement: Engagement,
  ): Promise<ResolvedCampaignDisclosurePolicy> {
    const resolved = await lookups.campaignDisclosurePolicy.resolve(
      engagement.campaignId,
      engagement.campaignPolicyVersion ?? undefined,
    );
    if (!resolved || resolved.organizationScopeId !== organizationScopeId) {
      throw new NotFoundError(
        `campaign disclosure policy not found for campaign ${engagement.campaignId}`,
        {
          campaignId: engagement.campaignId,
          organizationScopeId,
        },
      );
    }
    return resolved;
  }

  /** The shared derivation core (pure engine over fresh in-tx reads). */
  async function deriveDisclosureStatus(
    organizationScopeId: string,
    publication: PublicationRecord,
    engagement: Engagement,
    tx: AuthorityTransaction,
    evaluatedAt: string,
  ): Promise<PublicationDisclosureStatus> {
    const policy = await resolveDisclosurePolicy(organizationScopeId, engagement);
    const relationship = await relationshipRepository.findByEngagementWithinTx(
      organizationScopeId,
      engagement.id,
      tx,
    );
    const declarations = await declarationRepository.listByPublicationWithinTx(
      organizationScopeId,
      publication.id,
      tx,
    );
    const requiredKinds = deriveRequiredDisclosures(
      policy.requiredKinds,
      relationship?.disclosureObligations ?? null,
    );
    const obligations = evaluateDisclosureObligations({
      requiredKinds,
      policyVersion: policy.policyVersion,
      relationship,
      declarations,
    });
    return buildPublicationDisclosureStatus({
      publicationId: publication.id,
      organizationScopeId,
      state: publication.state,
      obligations,
      evaluatedAt,
    });
  }

  const service: CreatorSponsorshipService = {
    async createCommercialRelationship(
      execution,
      input: CreateCommercialRelationshipInput,
    ): Promise<CreateCommercialRelationshipResult> {
      assertOrganizationScopeId(input.organizationScopeId);
      assertIdempotencyKey(input.idempotencyKey);
      const actor = actingPersonId(execution);
      if (!input.engagementId?.trim()) {
        throw sponsorshipError("engagementId is required", {
          field: "engagementId",
        });
      }
      if (!input.sponsorPersonId?.trim()) {
        throw sponsorshipError("sponsorPersonId is required", {
          field: "sponsorPersonId",
        });
      }
      const kind = input.kind;
      if (typeof kind !== "string" || !isCommercialRelationshipKind(kind)) {
        throw sponsorshipError(
          `commercial relationship kind must be a closed-vocabulary kind (got ${String(kind)}; vocabulary: ${COMMERCIAL_RELATIONSHIP_KINDS.join(", ")})`,
          { kind },
        );
      }
      const obligations = validateDisclosureObligations(
        "disclosureObligations",
        input.disclosureObligations ?? [],
      );
      const compensation = buildCommercialCompensation(input.compensation);

      // Outer read: existence + tenant scope (lineage coherence is
      // re-proven in-tx below — TOCTOU closure).
      const engagement = await requireEngagement(
        input.organizationScopeId,
        input.engagementId,
      );
      if (input.campaignId !== engagement.campaignId) {
        throw sponsorshipError(
          `campaignId does not mirror the engagement's campaign (engagement campaign: ${engagement.campaignId})`,
          {
            campaignId: input.campaignId,
            engagementCampaignId: engagement.campaignId,
          },
        );
      }
      if (input.sponsorPersonId === engagement.creatorPersonId) {
        throw sponsorshipError(
          "sponsorPersonId cannot equal the engagement's creator (the commercial counterparty must be a different person)",
          { sponsorPersonId: input.sponsorPersonId },
        );
      }

      const key = `commercial_relationship:${input.organizationScopeId}:${input.idempotencyKey}`;
      const applied = await idempotency.applyIdempotent(
        key,
        async (ctx) => {
          const tx = ctx.transaction;
          // In-tx fresh read: lineage coherence + one-per-engagement
          // (a fresh key racing a concurrent creator loses HERE or on
          // the create-once constraint below — atomically).
          const fresh = await requireEngagementWithinTx(
            input.organizationScopeId,
            engagement.id,
            tx,
          );
          if (fresh.campaignId !== input.campaignId) {
            throw sponsorshipError(
              `campaignId does not mirror the engagement's campaign (engagement campaign: ${fresh.campaignId})`,
              {
                campaignId: input.campaignId,
                engagementCampaignId: fresh.campaignId,
              },
            );
          }
          const existing = await relationshipRepository.findByEngagementWithinTx(
            input.organizationScopeId,
            fresh.id,
            tx,
          );
          if (existing) {
            throw new CommercialRelationshipConflictError(
              `a commercial relationship already exists for engagement ${fresh.id} (one relationship per engagement; existing: ${existing.id})`,
              { engagementId: fresh.id, existingRelationshipId: existing.id },
            );
          }
          const relationship: CommercialRelationship = Object.freeze({
            id: randomUUID(),
            organizationScopeId: input.organizationScopeId,
            campaignId: fresh.campaignId,
            engagementId: fresh.id,
            creatorPersonId: fresh.creatorPersonId,
            sponsorPersonId: input.sponsorPersonId,
            kind,
            disclosureObligations: obligations,
            compensation,
            terminatedAt: null,
            terminationReason: null,
            formatVersion: COMMERCIAL_RELATIONSHIP_FORMAT,
            createdBy: actor,
            createdAt: nowIso(),
            idempotencyKey: input.idempotencyKey,
            executionId: execution.executionId,
            correlationId: execution.correlationId,
            causationId: execution.causationId,
          });
          await relationshipRepository.createWithinTx(relationship, tx);
          await appendAudit(tx, {
            eventType: COMMERCIAL_RELATIONSHIP_RECORDED,
            context: execution,
            actor,
            subject: relationship.id,
            resourceType: "commercial_relationship",
            resourceId: relationship.id,
            metadata: {
              organizationScopeId: relationship.organizationScopeId,
              campaignId: relationship.campaignId,
              engagementId: relationship.engagementId,
              creatorPersonId: relationship.creatorPersonId,
              sponsorPersonId: relationship.sponsorPersonId,
              kind: relationship.kind,
              disclosureObligations: [...relationship.disclosureObligations],
              // REFERENCE DATA ONLY — no balances, no postings (AC-05).
              compensation: relationship.compensation,
              idempotencyRecordId: ctx.recordId,
              transactionId: tx.transactionId,
            },
          });
          return relationship;
        },
        execution,
      );
      return {
        relationship: applied.result,
        created: applied.executed,
      };
    },

    async terminateCommercialRelationship(
      execution,
      input: TerminateCommercialRelationshipInput,
    ): Promise<CommercialRelationship> {
      assertOrganizationScopeId(input.organizationScopeId);
      assertIdempotencyKey(input.idempotencyKey);
      const actor = actingPersonId(execution);
      const relationship = await requireRelationship(
        input.organizationScopeId,
        input.relationshipId,
      );
      const reason =
        input.reason === undefined || input.reason === null
          ? null
          : String(input.reason);
      if (reason !== null && reason.length > COMMERCIAL_RELATIONSHIP_MAX_PROSE_CHARS) {
        throw sponsorshipError(
          `reason must be at most ${String(COMMERCIAL_RELATIONSHIP_MAX_PROSE_CHARS)} characters`,
          { field: "reason" },
        );
      }
      const key = `commercial_relationship_terminate:${input.organizationScopeId}:${input.idempotencyKey}`;
      const applied = await idempotency.applyIdempotent(
        key,
        async (ctx) => {
          const tx = ctx.transaction;
          const terminated = await relationshipRepository.terminateWithinTx(
            relationship.id,
            nowIso(),
            reason,
            tx,
          );
          await appendAudit(tx, {
            eventType: COMMERCIAL_RELATIONSHIP_TERMINATED,
            context: execution,
            actor,
            subject: terminated.id,
            resourceType: "commercial_relationship",
            resourceId: terminated.id,
            metadata: {
              organizationScopeId: terminated.organizationScopeId,
              engagementId: terminated.engagementId,
              terminatedAt: terminated.terminatedAt,
              terminationReason: terminated.terminationReason,
              // The conservative direction, made explicit: the
              // relationship KEEPS its disclosure obligations for
              // content produced under it.
              disclosureObligations: [...terminated.disclosureObligations],
              idempotencyRecordId: ctx.recordId,
              transactionId: tx.transactionId,
            },
          });
          return terminated;
        },
        execution,
      );
      return applied.result;
    },

    async getCommercialRelationship(execution, organizationScopeId, id) {
      void execution;
      assertOrganizationScopeId(organizationScopeId);
      return requireRelationship(organizationScopeId, id);
    },

    async listCommercialRelationships(
      execution,
      organizationScopeId,
      filters,
    ) {
      void execution;
      assertOrganizationScopeId(organizationScopeId);
      return relationshipRepository.listByOrganization(
        organizationScopeId,
        filters,
      );
    },

    async createPublication(
      execution,
      input: CreatePublicationInput,
    ): Promise<CreatePublicationResult> {
      assertOrganizationScopeId(input.organizationScopeId);
      assertIdempotencyKey(input.idempotencyKey);
      const actor = actingPersonId(execution);
      if (!input.engagementId?.trim()) {
        throw sponsorshipError("engagementId is required", {
          field: "engagementId",
        });
      }
      const channel = buildChannel(input.channel);

      // Outer read: the engagement must be VERIFIED (terminal
      // success — the content is produced and verified). Re-proven
      // in-tx below.
      const engagement = await requireEngagement(
        input.organizationScopeId,
        input.engagementId,
      );
      if (engagement.state !== "VERIFIED") {
        throw sponsorshipError(
          `engagement ${engagement.id} is not VERIFIED (state: ${engagement.state}); publication requires a verified engagement`,
          { engagementId: engagement.id, state: engagement.state },
        );
      }
      // Resolve the production (explicit or the engagement's single
      // production) and prove it belongs to the engagement.
      let production: UgcProduction;
      if (input.productionId === undefined || input.productionId === null) {
        const found = await productionRepository.findByEngagement(
          input.organizationScopeId,
          engagement.id,
        );
        if (!found) {
          throw sponsorshipError(
            `engagement ${engagement.id} has no UGC production to publish`,
            { engagementId: engagement.id },
          );
        }
        production = found;
      } else {
        const found = await productionRepository.findById(input.productionId);
        if (!found || found.organizationScopeId !== input.organizationScopeId) {
          throw new NotFoundError(`ugc production not found: ${input.productionId}`, {
            id: input.productionId,
            organizationScopeId: input.organizationScopeId,
          });
        }
        if (found.engagementId !== engagement.id) {
          throw sponsorshipError(
            `production ${found.id} does not belong to engagement ${engagement.id}`,
            { productionId: found.id, engagementId: engagement.id },
          );
        }
        production = found;
      }

      const key = `publication:${input.organizationScopeId}:${input.idempotencyKey}`;
      const applied = await idempotency.applyIdempotent(
        key,
        async (ctx) => {
          const tx = ctx.transaction;
          // In-tx fresh precondition: the engagement is STILL VERIFIED
          // in THIS transaction (a concurrent lifecycle change loses
          // here — TOCTOU closure).
          const fresh = await requireEngagementWithinTx(
            input.organizationScopeId,
            engagement.id,
            tx,
          );
          if (fresh.state !== "VERIFIED") {
            throw sponsorshipError(
              `engagement ${fresh.id} is not VERIFIED (state: ${fresh.state}); publication requires a verified engagement`,
              { engagementId: fresh.id, state: fresh.state },
            );
          }
          const publication: PublicationRecord = Object.freeze({
            id: randomUUID(),
            kind: "publication",
            organizationScopeId: input.organizationScopeId,
            state: "DRAFT",
            version: 0,
            engagementId: fresh.id,
            productionId: production.id,
            creatorPersonId: fresh.creatorPersonId,
            campaignId: fresh.campaignId,
            channel: Object.freeze({
              kind: channel.kind,
              externalPlatform: channel.externalPlatform
                ? Object.freeze({ ...channel.externalPlatform })
                : null,
            }),
            publicationEvidenceReferences: Object.freeze([]),
            verifiedAt: null,
            formatVersion: PUBLICATION_RECORD_FORMAT,
            ownerId: fresh.creatorPersonId,
            createdAt: nowIso(),
            updatedAt: nowIso(),
            executionId: execution.executionId,
            correlationId: execution.correlationId,
            causationId: execution.causationId,
          });
          await publicationRepository.createWithinTx(publication, tx);
          await appendAudit(tx, {
            eventType: PUBLICATION_RECORDED,
            context: execution,
            actor,
            subject: publication.id,
            resourceType: "publication",
            resourceId: publication.id,
            metadata: {
              organizationScopeId: publication.organizationScopeId,
              engagementId: publication.engagementId,
              productionId: publication.productionId,
              creatorPersonId: publication.creatorPersonId,
              campaignId: publication.campaignId,
              channel: {
                kind: publication.channel.kind,
                externalPlatform: publication.channel.externalPlatform,
              },
              state: publication.state,
              idempotencyRecordId: ctx.recordId,
              transactionId: tx.transactionId,
            },
          });
          return publication;
        },
        execution,
      );
      return { publication: applied.result, created: applied.executed };
    },

    async recordDisclosureDeclaration(
      execution,
      input: RecordDisclosureDeclarationInput,
    ): Promise<RecordDisclosureDeclarationResult> {
      assertOrganizationScopeId(input.organizationScopeId);
      assertIdempotencyKey(input.idempotencyKey);
      const actor = actingPersonId(execution);
      if (!input.publicationId?.trim()) {
        throw sponsorshipError("publicationId is required", {
          field: "publicationId",
        });
      }
      const kind = input.kind;
      if (typeof kind !== "string" || !isCampaignDisclosureKind(kind)) {
        throw sponsorshipError(
          `declaration kind must be a closed-vocabulary disclosure kind (got ${String(kind)})`,
          { kind },
        );
      }
      const statement = input.statement;
      if (
        typeof statement !== "string" ||
        !statement.trim() ||
        statement.length > DISCLOSURE_DECLARATION_MAX_STATEMENT_CHARS
      ) {
        throw sponsorshipError(
          `statement must be a non-empty string of at most ${String(DISCLOSURE_DECLARATION_MAX_STATEMENT_CHARS)} characters`,
          { field: "statement" },
        );
      }
      // EVERY evidence reference must resolve through the canonical
      // /evidence authority to THIS publication (invariant 6 —
      // disclosure proof cannot be fabricated here).
      const evidenceReferences = await validatePublicationEvidenceReferences(
        input.organizationScopeId,
        input.publicationId,
        input.evidenceReferences ?? [],
        DISCLOSURE_DECLARATION_MAX_EVIDENCE_REFERENCES,
      );

      const publication = await requirePublication(
        input.organizationScopeId,
        input.publicationId,
      );
      const engagement = await requireEngagement(
        input.organizationScopeId,
        publication.engagementId,
      );
      // The declaration is a CREATOR declaration: the acting person
      // must be the engagement's creator (server-side; never
      // caller-asserted).
      if (actor !== engagement.creatorPersonId) {
        throw new AuthorizationError(
          "disclosure declarations may only be recorded by the publication's creator",
          {
            actorPersonId: actor,
            creatorPersonId: engagement.creatorPersonId,
          },
        );
      }
      // Declarations attach to DRAFT publications (a VERIFIED/CANCELLED
      // publication is terminal — late declarations have no effect).
      if (publication.state !== "DRAFT") {
        throw sponsorshipError(
          `publication ${publication.id} is not DRAFT (state: ${publication.state}); declarations attach to draft publications`,
          { publicationId: publication.id, state: publication.state },
        );
      }

      const key = `disclosure_declaration:${input.organizationScopeId}:${input.idempotencyKey}`;
      const applied = await idempotency.applyIdempotent(
        key,
        async (ctx) => {
          const tx = ctx.transaction;
          // In-tx fresh state check (replay tolerance: the outer read
          // may be stale; the authoritative check is HERE).
          const fresh = await publicationRepository.getByIdWithinTx(
            publication.id,
            tx,
          );
          if (!fresh || fresh.organizationScopeId !== input.organizationScopeId) {
            throw new NotFoundError(
              `publication not found: ${publication.id}`,
              { id: publication.id, organizationScopeId: input.organizationScopeId },
            );
          }
          if (fresh.state !== "DRAFT") {
            throw sponsorshipError(
              `publication ${fresh.id} is not DRAFT (state: ${fresh.state}); declarations attach to draft publications`,
              { publicationId: fresh.id, state: fresh.state },
            );
          }
          const count = await declarationRepository.countByPublicationWithinTx(
            fresh.id,
            tx,
          );
          if (count >= DISCLOSURE_DECLARATION_MAX_PER_PUBLICATION) {
            throw sponsorshipError(
              `publication ${fresh.id} already carries the maximum of ${String(DISCLOSURE_DECLARATION_MAX_PER_PUBLICATION)} declarations`,
              { publicationId: fresh.id, count },
            );
          }
          const declaration: DisclosureDeclaration = Object.freeze({
            id: randomUUID(),
            organizationScopeId: input.organizationScopeId,
            publicationId: fresh.id,
            kind,
            declaredByPersonId: actor,
            statement,
            evidenceReferences,
            formatVersion: DISCLOSURE_DECLARATION_FORMAT,
            createdAt: nowIso(),
            idempotencyKey: input.idempotencyKey,
            executionId: execution.executionId,
            correlationId: execution.correlationId,
            causationId: execution.causationId,
          });
          await declarationRepository.createWithinTx(declaration, tx);
          await appendAudit(tx, {
            eventType: DISCLOSURE_DECLARATION_RECORDED,
            context: execution,
            actor,
            subject: declaration.id,
            resourceType: "disclosure_declaration",
            resourceId: declaration.id,
            metadata: {
              organizationScopeId: declaration.organizationScopeId,
              publicationId: declaration.publicationId,
              kind: declaration.kind,
              declaredByPersonId: declaration.declaredByPersonId,
              evidenceReferences: [...declaration.evidenceReferences],
              idempotencyRecordId: ctx.recordId,
              transactionId: tx.transactionId,
            },
          });
          return declaration;
        },
        execution,
      );
      return { declaration: applied.result, created: applied.executed };
    },

    async verifyPublication(
      execution,
      input: VerifyPublicationInput,
    ): Promise<VerifyPublicationResult> {
      assertOrganizationScopeId(input.organizationScopeId);
      assertIdempotencyKey(input.idempotencyKey);
      const actor = actingPersonId(execution);
      const publication = await requirePublication(
        input.organizationScopeId,
        input.publicationId,
      );
      // Replay tolerance (the W017 precedent): the record ALREADY in
      // the target state may be a same-key idempotent REPLAY — the
      // apply short-circuits with the committed composite. A FRESH
      // key re-running against an already-verified publication fails
      // IN-TX on the authoritative state check below.
      if (publication.state !== "DRAFT" && publication.state !== "VERIFIED") {
        throw sponsorshipError(
          `publication ${publication.id} is not DRAFT (state: ${publication.state}); only draft publications can be verified`,
          { publicationId: publication.id, state: publication.state },
        );
      }
      // Validate the publication-evidence references against the
      // canonical /evidence authority (existence + tenant scope +
      // EXACT subject binding to THIS publication) BEFORE opening the
      // composite: ≥1 required (the transition's declared evidence
      // requirement — invariant 3).
      const evidenceReferences = await validatePublicationEvidenceReferences(
        input.organizationScopeId,
        publication.id,
        input.evidenceReferences ?? [],
        PUBLICATION_MAX_EVIDENCE_REFERENCES,
      );

      // ONE composite idempotency record covers the WHOLE semantic
      // action (gate derivation + material bookkeeping + transition).
      // The per-key mutex + the in-tx optimistic-concurrency check
      // are the authoritative serializers; the workflow-subject lock
      // below additionally serializes composites racing a direct
      // generic transition on the same subject (advisory only).
      const compositeKey = `publication_verify:${input.organizationScopeId}:${input.idempotencyKey}`;
      const subjectLock = `workflow:publication:${publication.id}`;
      const applied = await idempotency.withLock(
        subjectLock,
        () =>
          idempotency.applyIdempotent(compositeKey, async (ctx) => {
            const tx = ctx.transaction;

            // Step 1 (in-tx) — the AUTHORITATIVE fresh state: the
            // publication is DRAFT in THIS transaction.
            const fresh = await publicationRepository.getByIdWithinTx(
              publication.id,
              tx,
            );
            if (
              !fresh ||
              fresh.organizationScopeId !== input.organizationScopeId
            ) {
              throw new NotFoundError(
                `publication not found: ${publication.id}`,
                {
                  id: publication.id,
                  organizationScopeId: input.organizationScopeId,
                },
              );
            }
            if (fresh.state !== "DRAFT") {
              throw sponsorshipError(
                `publication ${fresh.id} is not DRAFT (state: ${fresh.state}); only draft publications can be verified`,
                { publicationId: fresh.id, state: fresh.state },
              );
            }

            // Step 2 (in-tx) — the engagement is STILL VERIFIED (the
            // publication's lineage precondition).
            const engagement = await requireEngagementWithinTx(
              input.organizationScopeId,
              fresh.engagementId,
              tx,
            );
            if (engagement.state !== "VERIFIED") {
              throw sponsorshipError(
                `engagement ${engagement.id} is not VERIFIED (state: ${engagement.state}); publication verification requires a verified engagement`,
                { engagementId: engagement.id, state: engagement.state },
              );
            }

            // Step 3 (in-tx) — THE DISCLOSURE GATE: derive the
            // applicable obligations from DURABLE RECORDS (campaign
            // policy ∪ relationship obligations) and evaluate every
            // obligation against the publication's evidence-bound
            // declarations. No caller input participates in this
            // derivation — there is structurally no bypass.
            const status = await deriveDisclosureStatus(
              input.organizationScopeId,
              fresh,
              engagement,
              tx,
              nowIso(),
            );
            const missing = status.obligations
              .filter((o) => !o.satisfied)
              .map((o) => o.kind);
            if (missing.length > 0) {
              throw new DisclosureObligationsUnsatisfiedError(
                `publication ${fresh.id} cannot be verified: required disclosure obligations are unsatisfied (missing: ${missing.join(", ")})`,
                {
                  publicationId: fresh.id,
                  requiredKinds: status.obligations.map((o) => o.kind),
                  satisfiedKinds: status.obligations
                    .filter((o) => o.satisfied)
                    .map((o) => o.kind),
                  missingKinds: missing,
                },
              );
            }

            // Step 4 (in-tx) — the material verification bookkeeping
            // (evidence references + verifiedAt), audited.
            const verifiedAt = nowIso();
            const recorded = await publicationRepository.applyVerificationWithinTx(
              fresh.id,
              evidenceReferences,
              verifiedAt,
              tx,
            );
            await appendAudit(tx, {
              eventType: PUBLICATION_VERIFIED,
              context: execution,
              actor,
              subject: recorded.id,
              resourceType: "publication",
              resourceId: recorded.id,
              metadata: {
                organizationScopeId: recorded.organizationScopeId,
                engagementId: recorded.engagementId,
                productionId: recorded.productionId,
                creatorPersonId: recorded.creatorPersonId,
                campaignId: recorded.campaignId,
                publicationEvidenceReferences: [
                  ...recorded.publicationEvidenceReferences,
                ],
                verifiedAt: recorded.verifiedAt,
                disclosureGate: {
                  requiredKinds: status.obligations.map((o) => o.kind),
                  satisfiedKinds: status.obligations
                    .filter((o) => o.satisfied)
                    .map((o) => o.kind),
                  declarationIds: status.obligations.flatMap((o) => [
                    ...o.declarationIds,
                  ]),
                },
                idempotencyRecordId: ctx.recordId,
                transactionId: tx.transactionId,
              },
            });

            // Step 5 (in-tx, SAME transaction) — the DRAFT → VERIFIED
            // transition through the canonical /workflows authority:
            // version check, authorization, state machine, save and
            // buffered audit ALL execute inside THIS transaction. A
            // rejection here rolls the verification bookkeeping back
            // with everything else (composite atomicity — the W017
            // remediation precedent applied from the start).
            const transition = await workflow.requestTransitionWithinTx(
              {
                subjectId: recorded.id,
                subjectKind: "publication",
                targetState: "VERIFIED",
                expectedVersion: input.expectedVersion,
                idempotencyKey: input.idempotencyKey,
                actorPersonId: actor,
                policyAction: policyActionFor(
                  "publication",
                  "DRAFT",
                  "VERIFIED",
                ),
                metadata: {
                  verification: {
                    verifiedAt: recorded.verifiedAt,
                    evidenceReferences: [
                      ...recorded.publicationEvidenceReferences,
                    ],
                    disclosureGate: {
                      requiredKinds: status.obligations.map((o) => o.kind),
                      satisfiedKinds: status.obligations
                        .filter((o) => o.satisfied)
                        .map((o) => o.kind),
                    },
                  },
                },
              },
              execution,
              tx,
              ctx.recordId,
            );
            // The post-transition record (in-tx read sees the
            // transition's save: state VERIFIED, version+1, WITH the
            // verification bookkeeping preserved).
            const final = await publicationRepository.getByIdWithinTx(
              recorded.id,
              tx,
            );
            return {
              publication: final ?? recorded,
              transition,
              disclosureStatus: status,
            };
          }, execution),
      );
      // Replay contract (the W004 precedent): on a same-key replay
      // the stored composite is returned verbatim; `executed`
      // reflects whether THIS call executed the composite (the
      // transition executed iff the composite did).
      return {
        publication: applied.result.publication,
        transition: {
          ...applied.result.transition,
          executed: applied.executed,
        },
        disclosureStatus: applied.result.disclosureStatus,
      };
    },

    async getPublication(execution, organizationScopeId, id) {
      void execution;
      assertOrganizationScopeId(organizationScopeId);
      return requirePublication(organizationScopeId, id);
    },

    async listPublications(execution, organizationScopeId, filters) {
      void execution;
      assertOrganizationScopeId(organizationScopeId);
      return publicationRepository.listByOrganization(
        organizationScopeId,
        filters,
      );
    },

    async listDisclosureDeclarations(
      execution,
      organizationScopeId,
      publicationId,
    ) {
      void execution;
      assertOrganizationScopeId(organizationScopeId);
      const publication = await requirePublication(
        organizationScopeId,
        publicationId,
      );
      return declarationRepository.listByPublication(
        organizationScopeId,
        publication.id,
      );
    },

    async getPublicationDisclosureStatus(
      execution,
      organizationScopeId,
      publicationId,
    ) {
      void execution;
      assertOrganizationScopeId(organizationScopeId);
      const publication = await requirePublication(
        organizationScopeId,
        publicationId,
      );
      const engagement = await requireEngagement(
        organizationScopeId,
        publication.engagementId,
      );
      const policy = await resolveDisclosurePolicy(
        organizationScopeId,
        engagement,
      );
      const relationship = await relationshipRepository.findByEngagement(
        organizationScopeId,
        engagement.id,
      );
      const declarations = await declarationRepository.listByPublication(
        organizationScopeId,
        publication.id,
      );
      const requiredKinds = deriveRequiredDisclosures(
        policy.requiredKinds,
        relationship?.disclosureObligations ?? null,
      );
      const obligations = evaluateDisclosureObligations({
        requiredKinds,
        policyVersion: policy.policyVersion,
        relationship,
        declarations,
      });
      return buildPublicationDisclosureStatus({
        publicationId: publication.id,
        organizationScopeId,
        state: publication.state,
        obligations,
        evaluatedAt: nowIso(),
      });
    },
  };

  logger.debug("creators.sponsorship_service.created", {
    boundary: "creators",
    service: "sponsorship",
  });

  return service;
}
