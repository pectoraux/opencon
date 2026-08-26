/**
 * IdentityService — domain service for canonical person identities.
 *
 * Work order ref: spec/work-orders/NET-W002.md
 *   §4.1 Identity model: provider-neutral, stable identifiers; one
 *      identity usable across all network products (ID-001); a single
 *      person identity holds multiple roles across multiple organizations
 *      without duplicating the underlying identity.
 *   §4.8 Privacy: NO credentials, NO raw private activity in public
 *      responses; public endpoints use {@link PublicIdentityView}.
 *   §4.9 Audit: material identity mutations emit append-oriented audit
 *      records with actor/subject/resource/execution+correlation IDs
 *      (NET-W002-AC-08).
 *
 * Tier compliance: this file is in the `identity` domain boundary. It
 * imports ONLY:
 *   - its own port (self, same dir — allowed),
 *   - core contracts (ExecutionContext, AuditWriter, Logger, OpenConError
 *     subclasses, randomUUID — all from `../core/*`, allowed).
 * It does NOT import infrastructure (config/audit-writer/persistence) or
 * any other domain. The AuditWriter is the CORE contract declared in
 * src/core/audit.ts; the concrete writer is injected by the bootstrap
 * composition root. Domain services never reach into infrastructure.
 *
 * No economically material behaviour (campaigns, settlement, reputation
 * mutation, credit issuance) is implemented here (work order §5).
 */

import { randomUUID } from "node:crypto";
import type {
  AuditWriter,
} from "../core/audit.ts";
import type { ExecutionContext } from "../core/execution-context.ts";
import {
  ConflictError,
  NotFoundError,
  OpenConError,
  SecretAccessError,
} from "../core/errors.ts";
import type { Logger } from "../core/logger.ts";
import type {
  AuthenticatedSubject,
  CreatePersonIdentityInput,
  IdentityRepository,
  PersonIdentity,
  PrincipalResolver,
  PublicIdentityView,
  SubjectReference,
} from "./port.ts";

export interface IdentityServiceDeps {
  readonly repository: IdentityRepository;
  readonly auditWriter: AuditWriter;
  readonly logger: Logger;
}

export interface IdentityService extends PrincipalResolver {
  /** Create a canonical person identity (AC-01, AC-08 audit lineage). */
  createIdentity(
    context: ExecutionContext,
    input: CreatePersonIdentityInput,
  ): Promise<PersonIdentity>;
  /** Fetch the full canonical identity by id (server-side use only). */
  getIdentity(context: ExecutionContext, id: string): Promise<PersonIdentity>;
  /** Privacy-safe public view for API responses (PRIV-001, AC-07). */
  getPublicView(context: ExecutionContext, id: string): Promise<PublicIdentityView>;
  /** PrincipalResolver contract (§4.4). */
  resolve(subject: AuthenticatedSubject): Promise<PersonIdentity | null>;
}

const PERSON_CREATED = "identity.person_created" as const;

export function createIdentityService(deps: IdentityServiceDeps): IdentityService {
  const { repository, auditWriter, logger } = deps;

  // Privacy guard: refuse any input that carries credential-shaped keys.
  // This is a defensive invariant (PRIV-001, §4.4) — the identity domain
  // model MUST NOT store credentials. Recurses into nested objects and
  // array elements so a credential field cannot sneak in via a subject
  // reference object or a nested claim.
  function assertNoCredentialMaterial(
    input: CreatePersonIdentityInput,
    subject: AuthenticatedSubject | null,
  ): void {
    const forbiddenKeys = [
      "password", "passwordHash", "secret", "accessToken",
      "refreshToken", "idToken", "oauthToken", "apiKey", "privateKey",
    ];
    const seen = new WeakSet();
    function inspect(label: string, obj: unknown): void {
      if (obj === null || typeof obj !== "object") return;
      if (typeof obj === "function") return;
      if (seen.has(obj)) return; // cycle guard
      seen.add(obj);
      if (Array.isArray(obj)) {
        obj.forEach((el, i) => inspect(`${label}[${i}]`, el));
        return;
      }
      const record = obj as Record<string, unknown>;
      for (const k of Object.keys(record)) {
        const lower = k.toLowerCase();
        if (forbiddenKeys.some((f) => lower.includes(f.toLowerCase()))) {
          throw new SecretAccessError(
            `Credential material (${label}.${k}) must not be stored in the identity domain`,
            { field: `${label}.${k}` },
          );
        }
      }
      for (const k of Object.keys(record)) {
        inspect(`${label}.${k}`, record[k]);
      }
    }
    inspect("input", input);
    if (subject) {
      inspect("subject", subject);
    }
  }

  const service: IdentityService = {
    async createIdentity(context, input) {
      assertNoCredentialMaterial(input, null);
      if (!input.displayName?.trim()) {
        throw new OpenConError({
          code: "IDENTITY_VALIDATION",
          classification: "validation",
          message: "displayName is required",
          context: { field: "displayName" },
        });
      }
      const id = randomUUID();
      const now = new Date().toISOString();
      const identity: PersonIdentity = {
        id,
        displayName: input.displayName.trim(),
        subjectReferences: [...input.subjectReferences],
        reputationAnchors: input.reputationAnchors ? [...input.reputationAnchors] : [],
        createdAt: now,
      };
      // Persistence. Throws ConflictError on duplicate subject link.
      await repository.save(identity);
      // Audit lineage (AC-08): actor, subject, resource, execution+correlation.
      try {
        await auditWriter.append({
          eventType: PERSON_CREATED,
          context,
          actor: context.actor?.id ?? null,
          subject: identity.id,
          resourceType: "identity",
          resourceId: identity.id,
          metadata: {
            displayName: identity.displayName,
            subjectCount: identity.subjectReferences.length,
            anchorCount: identity.reputationAnchors.length,
          },
        });
      } catch (auditErr) {
        // Audit failure is logged but never silently swallows the mutation
        // (the mutation already happened; audit is best-effort lineage).
        logger.error("identity.audit_failed", auditErr as Error, {
          eventType: PERSON_CREATED,
          identityId: identity.id,
        });
      }
      logger.info("identity.created", { identityId: identity.id });
      return identity;
    },

    async getIdentity(_context, id) {
      const found = await repository.findById(id);
      if (!found) {
        throw new NotFoundError(`identity not found: ${id}`, { identityId: id });
      }
      return found;
    },

    async getPublicView(_context, id) {
      const found = await repository.findById(id);
      if (!found) {
        throw new NotFoundError(`identity not found: ${id}`, { identityId: id });
      }
      // PRIVACY BOUNDARY (PRIV-001, AC-07): return ONLY the stable id +
      // display name. NEVER subjectReferences, NEVER reputationAnchors,
      // NEVER any credential field (the model has none).
      return { id: found.id, displayName: found.displayName };
    },

    async resolve(subject) {
      assertNoCredentialMaterial({ displayName: "", subjectReferences: [] }, subject);
      const identity = await repository.findBySubjectReference(subject.subject);
      return identity;
    },
  };

  return service;
}

export { ConflictError, NotFoundError, SecretAccessError };
export type { SubjectReference };
