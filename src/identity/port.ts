/**
 * Identity boundary — declared public interface (port).
 *
 * Architecture ref: spec/architecture.md §18 (Module ownership):
 *   `/identity`, `/organizations`, `/participants` → identity, roles,
 *   organization membership and eligibility.
 * Architecture ref: spec/architecture-lock.md §2 (core domain `/identity`).
 *
 * Work order ref: spec/work-orders/NET-W002.md
 *   §4.1 Identity model (provider-neutral, stable identifiers; one person
 *      identity holds multiple roles across multiple organizations without
 *      duplicating the underlying identity).
 *   §4.4 Authentication boundary (provider-neutral interface; no production
 *      external auth provider; credentials MUST NOT be stored in domain
 *      modules).
 *   §4.6 API integration (carry actor/subject identity via NET-W001
 *      execution/correlation context).
 *   §4.7 Persistence (explicit persistence ports; reuse NET-W001 boundary).
 *   §4.8 Privacy (no credentials or raw private activity in public
 *      responses; stable identifiers + minimum metadata only).
 *
 * This port declares the identity-domain contracts ONLY. Concrete behaviour
 * is implemented in this same boundary (IdentityService + in-memory
 * repositories) and wired by the bootstrap composition root. No economically
 * material domain behaviour (campaigns, settlement, reputation mutation,
 * credit issuance) is introduced (work order §5).
 *
 * PRIVACY BOUNDARY (PRIV-001, NET-W002-AC-07): the identity model carries
 * NO credentials. {@link PersonIdentity} has no password-hash, OAuth-token
 * or access-token field. External auth provider accounts are modelled
 * separately as {@link SubjectReference} (a stable, opaque handle resolved
 * by the {@link PrincipalResolver} into the canonical identity). Public
 * endpoints return {@link PublicIdentityView} (stable id + minimum
 * metadata), never the underlying identity record.
 */

import type { ExecutionContext } from "../core/execution-context.ts";

/**
 * The canonical, provider-neutral person identity. One identity is usable
 * across all network products (ID-001). Stable identifiers only — NO
 * credentials, NO raw personal activity, NO OAuth tokens (PRIV-001).
 */
export interface PersonIdentity {
  /** Stable, opaque canonical identifier. Never reused across persons. */
  readonly id: string;
  /** Human-readable display name (minimum metadata for public view). */
  readonly displayName: string;
  /**
   * Optional opaque handle(s) linking this identity to external auth
   * subjects. NEVER carries credentials — only a stable reference so the
   * {@link PrincipalResolver} can resolve the canonical identity from an
   * authenticated subject. Provider accounts are integration details,
   * not the canonical identity model (§4.1).
   */
  readonly subjectReferences: readonly SubjectReference[];
  /** ISO-8601 creation timestamp. */
  readonly createdAt: string;
  /**
   * Optional opaque reputation anchors (ID-003 portable network-level
   * reputation identity anchor; ID-004 separate reputation dimensions).
   * NET-W002 establishes the anchor shape only; reputation algorithms are
   * explicitly out of scope (§5) and deferred to a later work item.
   */
  readonly reputationAnchors: readonly ReputationAnchor[];
}

/**
 * An opaque reference linking a canonical identity to an external auth
 * subject. Carries NO credentials — only a stable, provider-neutral handle
 * (`subjectId` + `providerKind`). The {@link PrincipalResolver} resolves
 * the canonical identity from this reference at request time.
 */
export interface SubjectReference {
  /** Opaque subject identifier issued by the auth provider. */
  readonly subjectId: string;
  /** Provider-neutral kind (e.g. "oidc", "saml", "internal"). NEVER a secret. */
  readonly providerKind: string;
}

/**
 * Portable reputation anchor (ID-003, ID-004). NET-W002 establishes the
 * anchor shape (a stable handle that future reputation work items populate);
 * it carries NO reputation score or algorithm (§5 non-goals).
 */
export interface ReputationAnchor {
  /** Dimension the anchor refers to (e.g. "helpfulness", "creator"). */
  readonly dimension: string;
  /** Stable opaque handle resolved by the reputation boundary later. */
  readonly anchorId: string;
}

/**
 * Privacy-safe public representation of an identity (PRIV-001,
 * NET-W002-AC-07). Returned by public identity endpoints. Contains ONLY
 * the stable identifier and the minimum metadata required by the endpoint
 * — NEVER credentials, NEVER raw private activity, NEVER subject references.
 */
export interface PublicIdentityView {
  readonly id: string;
  readonly displayName: string;
}

/**
 * Inputs used to create a canonical person identity. The caller supplies
 * display metadata and the auth subject reference(s) that resolve to this
 * identity. NO credential material is accepted here (§4.4).
 */
export interface CreatePersonIdentityInput {
  readonly displayName: string;
  readonly subjectReferences: readonly SubjectReference[];
  readonly reputationAnchors?: readonly ReputationAnchor[];
}

/**
 * IdentityRepository — persistence port for canonical person identities.
 *
 * Work order ref: §4.7 (explicit persistence ports; reuse NET-W001
 * boundary; NET-W003 establishes production PostgreSQL authority; NET-W002
 * MAY use the in-memory/test boundary provided the interface is preserved).
 *
 * The interface is provider-neutral and carries no driver coupling. The
 * concrete in-memory implementation lives in this boundary; a PostgreSQL
 * implementation will live behind the same interface in NET-W003.
 */
export interface IdentityRepository {
  /** Persist a new canonical identity. Throws ConflictError on duplicate. */
  save(identity: PersonIdentity): Promise<void>;
  /** Fetch by canonical id. Returns null when absent. */
  findById(id: string): Promise<PersonIdentity | null>;
  /**
   * Resolve a canonical identity from an auth subject reference. Returns
   * null when no identity is linked to that subject. This is the canonical
   * identity lookup the {@link PrincipalResolver} uses.
   */
  findBySubjectReference(subject: SubjectReference): Promise<PersonIdentity | null>;
  /** Confirm whether a canonical id exists (for authorization checks). */
  exists(id: string): Promise<boolean>;
}

/**
 * PrincipalResolver — the authentication-boundary interface (§4.4, §6).
 *
 * Provider-neutral: resolves an authenticated principal (an opaque auth
 * subject) into the canonical network identity. NET-W002 MUST NOT implement
 * a production external authentication provider. A deterministic in-memory
 * authenticator is permitted solely for integration/security tests; it
 * lives in this boundary and is clearly marked as a test/dev implementation.
 *
 * The resolver NEVER receives or returns credential material. It accepts an
 * opaque authenticated-subject descriptor (carrying the resolved subject id
 * + provider kind, NOT a raw token) and returns the canonical identity.
 */
export interface PrincipalResolver {
  /**
   * Resolve the canonical identity for an authenticated subject. The input
   * is an opaque {@link AuthenticatedSubject} — it MUST NOT carry raw
   * credentials. Returns null when the subject is not linked to any
   * canonical identity.
   */
  resolve(subject: AuthenticatedSubject): Promise<PersonIdentity | null>;
}

/**
 * An opaque descriptor for an authenticated subject, produced by an auth
 * adapter (provider-neutral). Carries the resolved subject id + provider
 * kind — NEVER credential material (no token, no password).
 */
export interface AuthenticatedSubject {
  readonly subject: SubjectReference;
  /**
   * Optional client-asserted role/scope claims. The server MUST NOT trust
   * these without validation (§4.5). The {@link AuthorizationService}
   * re-resolves effective roles from authoritative server state.
   */
  readonly clientClaims?: Readonly<Record<string, unknown>>;
}

/**
 * The IdentityPort describes the boundary's readiness. After NET-W002 it
 * is `"ready"`; before NET-W002 (NET-W001) it was `"skeleton"`.
 */
export interface IdentityPort {
  readonly boundary: "identity";
  readonly readiness: "ready";
  /** Audit event types emitted by material identity mutations (AC-08). */
  readonly auditEventTypes: {
    readonly personCreated: "identity.person_created";
  };
}
