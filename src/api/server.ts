/**
 * HTTP API boundary — /health, /ready, /live, /api/*.
 *
 * Work order ref: NET-W001 §4.1 (`/api`), §4.4 (context propagation
 * across HTTP/API boundaries), §4.6 (health/readiness/liveness),
 * AC-05 (structured logs from a representative HTTP request).
 *
 * Built on Node's built-in http module (zero framework coupling).
 * Each request is wrapped in an ExecutionContext propagated via
 * AsyncLocalStorage so downstream logging/audit carry execution and
 * correlation identifiers. Inbound `X-Correlation-Id` /
 * `X-Causation-Id` headers are honoured so context propagates across
 * HTTP boundaries.
 */

import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";
import { randomUUID } from "node:crypto";
import { createExecutionContext, deriveExecutionContext, runWithExecutionContextAsync } from "../core/execution-context.ts";
import { classifyError, OpenConError } from "../core/errors.ts";
import type { Logger } from "../core/logger.ts";
import type { ConfigSnapshot } from "../core/config.ts";
import type { HealthAggregator } from "../observability/health.ts";
import type { ModuleRegistry } from "../core/module.ts";
import type {
  ApiAuth,
  ApiAuthSubject,
  ApiCommands,
} from "./port.ts";
import type { ExecutionContext } from "../core/execution-context.ts";

export interface ApiServerOptions {
  readonly port?: number;
  readonly host?: string;
  readonly logger: Logger;
  readonly config: ConfigSnapshot;
  readonly health: HealthAggregator;
  readonly registry: ModuleRegistry;
  /** Accessor for a representative non-domain job queue (AC-03 demo). */
  readonly enqueueEchoJob?: (message: string) => Promise<string>;
  /**
   * Auth guard + protected-mutation commands. NET-W002 §4.6: minimum API
   * middleware/guarding so protected operations reject unauthenticated /
   * unauthorized principals. When absent, protected endpoints return 501.
   */
  readonly auth?: ApiAuth;
  readonly commands?: ApiCommands;
}

export interface ApiServer {
  start(): Promise<void>;
  stop(): Promise<void>;
  /** The actual bound port (resolves 0 to OS-assigned). */
  readonly port: number;
  readonly host: string;
}

const JSON_HEADERS = { "content-type": "application/json" } as const;

export function createApiServer(opts: ApiServerOptions): ApiServer {
  let server: Server | null = null;
  let boundPort = opts.port ?? 0;

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const startedAt = Date.now();
    const correlationId =
      (req.headers["x-correlation-id"] as string | undefined) ?? randomUUID();
    const causationId =
      (req.headers["x-causation-id"] as string | undefined) ?? null;

    // NET-W002 remediation (PR #4 architect review): the request-scope
    // ExecutionContext actor MUST NOT be derived from a caller-controlled
    // header. The `X-Actor-Id` header is untrusted input and could spoof
    // the actor recorded in audit lineage. The authoritative actor for a
    // protected mutation is the server-resolved authenticated principal
    // (`personId` produced by ApiAuth.resolvePrincipal), set on a derived
    // child context inside guardMutation() AFTER authentication succeeds.
    // For the unauthenticated request scope the actor is null.
    const ctx = createExecutionContext({
      correlationId,
      causationId,
      actor: null,
    });

    await runWithExecutionContextAsync(ctx, async () => {
      const url = new URL(req.url ?? "/", "http://localhost");
      const path = url.pathname;
      const method = req.method ?? "GET";

      // Propagate correlation id back to the caller for traceability.
      res.setHeader("x-correlation-id", ctx.correlationId);
      res.setHeader("x-execution-id", ctx.executionId);

      try {
        const handled = await route(method, path, req, res, ctx);
        if (!handled) {
          await send(res, 404, { error: "not_found", path });
        }
      } catch (err) {
        const c = classifyError(err);
        const status = mapClassificationToStatus(c.classification);
        opts.logger.error("api.request_failed", err, { method, path, status });
        await send(res, status, {
          error: c.code,
          classification: c.classification,
          message: c.message,
        });
      } finally {
        opts.logger.info("api.request_completed", {
          method,
          path,
          status: res.statusCode,
          durationMs: Date.now() - startedAt,
        });
      }
    });
  }

  // Extract the opaque auth subject from request headers. NET-W002 §4.4:
  // the auth boundary is provider-neutral; we accept an opaque subject id
  // + provider kind via headers (deterministic in-memory resolver for tests;
  // production would use a real auth adapter). Client-asserted claims are
  // carried in the X-Client-Claims header and are NEVER trusted for
  // authorization (§4.5, API-AC-02). They are carried forward ONLY so the
  // AuthorizationService can record a safe fingerprint when a forged claim
  // is rejected — raw claim values are NEVER emitted into logs/audit
  // (PR #4 remediation: see AuthorizationService.safeClaimsFingerprint).
  function extractClientClaims(req: IncomingMessage): Record<string, unknown> | undefined {
    const claimsHeader = req.headers["x-client-claims"] as string | undefined;
    if (!claimsHeader) return undefined;
    try {
      const parsed = JSON.parse(claimsHeader);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        return parsed as Record<string, unknown>;
      }
    } catch {
      // Malformed client-claims header — ignore (claims are never trusted).
    }
    return undefined;
  }

  function extractAuthSubject(req: IncomingMessage): ApiAuthSubject | null {
    const subjectId = req.headers["x-auth-subject-id"] as string | undefined;
    if (!subjectId) return null;
    const providerKind =
      (req.headers["x-auth-provider-kind"] as string | undefined) ?? "internal";
    const clientClaims = extractClientClaims(req);
    return { subjectId, providerKind, clientClaims };
  }

  // Resolve the canonical person id for the request, using the auth guard.
  // Returns null personId when the subject is unauthenticated OR no auth
  // guard is configured. Client claims are ALWAYS carried forward
  // (independently of authentication) so the authorizer can record a safe
  // fingerprint of forged claims when it rejects them — even on the
  // unauthenticated deny path (PR #4 remediation: do not silently drop
  // inbound claims before they reach the safe-fingerprint boundary).
  async function resolveActorPersonId(
    req: IncomingMessage,
  ): Promise<{ personId: string | null; clientClaims?: Record<string, unknown> } | null> {
    if (!opts.auth) return null;
    // Claims are extracted independently so they survive even when the
    // subject is unauthenticated.
    const clientClaims = extractClientClaims(req);
    const subject = extractAuthSubject(req);
    if (!subject) return { personId: null, clientClaims };
    const resolved = await opts.auth.resolvePrincipal(subject);
    return { personId: resolved.personId, clientClaims };
  }

  // Guard a protected mutation: resolve actor + authorize, return 403 on
  // deny. On allow, returns the resolved personId AND a derived child
  // ExecutionContext whose `actor` is the server-resolved authenticated
  // principal (`personId`, kind "person") — NOT a caller-controlled header.
  // The derived context is the authoritative execution scope passed to
  // domain commands; audit records written by domain services therefore
  // record the resolved principal as the actor, never a spoofed inbound
  // value (PR #4 remediation: do not trust X-Actor-Id for audit actor).
  async function guardMutation(
    ctx: ExecutionContext,
    req: IncomingMessage,
    action: string,
    resource: string,
    res: ServerResponse,
  ): Promise<{ personId: string; execution: ExecutionContext } | null> {
    if (!opts.auth || !opts.commands) {
      await send(res, 501, {
        error: "not_implemented",
        message: "auth/commands not configured on this server",
      });
      return null;
    }
    const resolved = await resolveActorPersonId(req);
    const personId = resolved?.personId ?? null;
    const clientClaims = resolved?.clientClaims;
    const decision = await opts.auth.authorize({
      execution: ctx,
      personId,
      action,
      resource,
      clientClaims,
    });
    if (decision.decision !== "allow" || personId === null) {
      await send(res, 403, {
        error: "authorization",
        classification: "authorization",
        message: decision.reason,
        action,
        resource,
        matchedPolicyId: decision.matchedPolicyId,
      });
      return null;
    }
    // Authoritative actor: derive a child context whose actor is the
    // server-resolved authenticated principal. This is the only place the
    // request-scope actor is promoted from null to a real principal, and
    // it is derived exclusively from ApiAuth.resolvePrincipal() — never
    // from an inbound header.
    const execution = deriveExecutionContext(ctx, {
      actor: { id: personId, kind: "person" },
    });
    return { personId, execution };
  }

  async function route(
    method: string,
    path: string,
    req: IncomingMessage,
    res: ServerResponse,
    ctx: ExecutionContext,
  ): Promise<boolean> {
    if (path === "/health" && method === "GET") {
      const report = await opts.health.report();
      await send(res, report.status === "fail" ? 503 : 200, report);
      return true;
    }
    if (path === "/ready" && method === "GET") {
      const report = await opts.health.report();
      const ready = report.status !== "fail" && report.checks.length > 0;
      await send(res, ready ? 200 : 503, { ready, status: report.status });
      return true;
    }
    if (path === "/live" && method === "GET") {
      await send(res, 200, { alive: true });
      return true;
    }
    if (path === "/api/modules" && method === "GET") {
      await send(res, 200, { modules: opts.registry.snapshot() });
      return true;
    }
    if (path === "/api/config" && method === "GET") {
      // Redacted diagnostics only — never secret values.
      await send(res, 200, {
        environment: opts.config.environment,
        appName: opts.config.appName,
        descriptors: opts.config.descriptors,
      });
      return true;
    }
    if (path === "/api/echo" && method === "POST" && opts.enqueueEchoJob) {
      const body = await readBody(req);
      const message =
        typeof body === "object" && body !== null && "message" in body
          ? String((body as { message?: unknown }).message)
          : "echo";
      const jobId = await opts.enqueueEchoJob(message);
      await send(res, 202, { jobId, accepted: true });
      return true;
    }

    // -- NET-W002 protected endpoints (§4.6) ---------------------------
    // Every protected mutation is guarded by guardMutation(): unauthenticated
    // → 403; unauthorized → 403 (deny-by-default); client-asserted role/
    // scope claims are NEVER trusted (§4.5, API-AC-02).

    // POST /api/identities — create a canonical identity (protected: only
    // an authorized principal may provision identities). The actor recorded
    // in the audit lineage is the server-resolved authenticated principal
    // (carried by `guarded.execution`), NEVER a caller-controlled header.
    if (path === "/api/identities" && method === "POST" && opts.commands) {
      const commands = opts.commands;
      const guarded = await guardMutation(ctx, req, "identity.create", "*", res);
      if (!guarded) return true;
      const body = await readBody(req);
      const displayName =
        typeof body === "object" && body !== null && "displayName" in body
          ? String((body as { displayName?: unknown }).displayName)
          : "";
      const subjectId =
        typeof body === "object" && body !== null && "subjectId" in body
          ? String((body as { subjectId?: unknown }).subjectId)
          : randomUUID();
      const providerKind =
        typeof body === "object" && body !== null && "providerKind" in body
          ? String((body as { providerKind?: unknown }).providerKind)
          : "internal";
      const view = await runWithExecutionContextAsync(guarded.execution, () =>
        commands.createIdentity(guarded.execution, { displayName, subjectId, providerKind }),
      );
      await send(res, 201, view);
      return true;
    }

    // GET /api/identities/:id — public privacy-safe view (PRIV-001, AC-07).
    // Public read; no auth required. Returns only the stable id + display name.
    if (path.startsWith("/api/identities/") && method === "GET" && opts.commands) {
      const id = path.slice("/api/identities/".length);
      const view = await opts.commands.getPublicIdentity(ctx, id);
      if (!view) {
        await send(res, 404, { error: "not_found", message: `identity not found: ${id}` });
        return true;
      }
      await send(res, 200, view);
      return true;
    }

    // POST /api/organizations — create an organization (protected). The
    // audit actor is the resolved principal (carried by guarded.execution);
    // the `actorPersonId` is also passed as the organization's creatorId
    // for explicit provenance.
    if (path === "/api/organizations" && method === "POST" && opts.commands) {
      const commands = opts.commands;
      const guarded = await guardMutation(ctx, req, "organization.create", "*", res);
      if (!guarded) return true;
      const body = await readBody(req);
      const name =
        typeof body === "object" && body !== null && "name" in body
          ? String((body as { name?: unknown }).name)
          : "";
      const view = await runWithExecutionContextAsync(guarded.execution, () =>
        commands.createOrganization(guarded.execution, guarded.personId, { name }),
      );
      await send(res, 201, view);
      return true;
    }

    // POST /api/organizations/:id/memberships — grant a membership (protected:
    // the actor must be authorized for the target organization). The audit
    // actor is the resolved principal (carried by guarded.execution); the
    // `actorPersonId` is also passed as the membership's grantedBy for
    // explicit provenance.
    const grantMatch = path.match(/^\/api\/organizations\/([^/]+)\/memberships$/);
    if (grantMatch && method === "POST" && opts.commands) {
      const commands = opts.commands;
      const organizationId = grantMatch[1]!;
      const guarded = await guardMutation(
        ctx,
        req,
        "organization.membership.grant",
        organizationId,
        res,
      );
      if (!guarded) return true;
      const body = await readBody(req);
      const personId =
        typeof body === "object" && body !== null && "personId" in body
          ? String((body as { personId?: unknown }).personId)
          : "";
      const result = await runWithExecutionContextAsync(guarded.execution, () =>
        commands.grantMembership(guarded.execution, guarded.personId, organizationId, { personId }),
      );
      await send(res, result.created ? 201 : 200, result.membership);
      return true;
    }

    // DELETE /api/organizations/:id/memberships/:membershipId — revoke
    // (protected). The audit actor is the resolved principal (carried by
    // guarded.execution); the `actorPersonId` is also passed as the
    // membership's revokedBy for explicit provenance.
    const revokeMatch = path.match(/^\/api\/organizations\/([^/]+)\/memberships\/([^/]+)$/);
    if (revokeMatch && method === "DELETE" && opts.commands) {
      const commands = opts.commands;
      const organizationId = revokeMatch[1]!;
      const membershipId = revokeMatch[2]!;
      const guarded = await guardMutation(
        ctx,
        req,
        "organization.membership.revoke",
        organizationId,
        res,
      );
      if (!guarded) return true;
      const result = await runWithExecutionContextAsync(guarded.execution, () =>
        commands.revokeMembership(guarded.execution, guarded.personId, membershipId),
      );
      await send(res, 200, result.membership);
      return true;
    }

    // -- NET-W004 protected endpoints (§3.4, §4.5, §4.6) -------------
    // Every protected mutation is guarded by guardMutation(): unauthenticated
    // → 403; unauthorized → 403 (deny-by-default). The actor recorded in
    // audit lineage is the server-resolved principal.

    // POST /api/opportunities — create an opportunity (protected: the
    // actor must be authorized for the target organization scope).
    if (path === "/api/opportunities" && method === "POST" && opts.commands) {
      const commands = opts.commands;
      const guarded = await guardMutation(ctx, req, "opportunity.create", "*", res);
      if (!guarded) return true;
      const body = await readBody(req);
      const input = parseOpportunityInput(body);
      const view = await runWithExecutionContextAsync(guarded.execution, () =>
        commands.createOpportunity(guarded.execution, guarded.personId, input),
      );
      await send(res, 201, view);
      return true;
    }

    // GET /api/opportunities/:id — fetch an opportunity (public read; no
    // auth required). Returns the detailed view.
    if (path.startsWith("/api/opportunities/") && method === "GET" && opts.commands) {
      const id = path.slice("/api/opportunities/".length);
      const view = await opts.commands.getOpportunity(ctx, id);
      if (!view) {
        await send(res, 404, { error: "not_found", message: `opportunity not found: ${id}` });
        return true;
      }
      await send(res, 200, view);
      return true;
    }

    // POST /api/contributions — create a contribution (protected). The
    // actor must be authorized for the target organization scope (which
    // must match the opportunity's scope — enforced by ContributionService).
    if (path === "/api/contributions" && method === "POST" && opts.commands) {
      const commands = opts.commands;
      const guarded = await guardMutation(ctx, req, "contribution.create", "*", res);
      if (!guarded) return true;
      const body = await readBody(req);
      const input = parseContributionInput(body);
      const view = await runWithExecutionContextAsync(guarded.execution, () =>
        commands.createContribution(guarded.execution, guarded.personId, input),
      );
      await send(res, 201, view);
      return true;
    }

    // GET /api/contributions/:id — fetch a contribution (public read).
    if (path.startsWith("/api/contributions/") && method === "GET" && opts.commands) {
      const id = path.slice("/api/contributions/".length);
      const view = await opts.commands.getContribution(ctx, id);
      if (!view) {
        await send(res, 404, { error: "not_found", message: `contribution not found: ${id}` });
        return true;
      }
      await send(res, 200, view);
      return true;
    }

    // POST /api/workflows/transitions — request an authorized lifecycle
    // transition (the SOLE entry point for authoritative lifecycle
    // mutation, NET-W004 §4.1). The actor must be authorized for the
    // subject's organization scope. NET-W005 extends the endpoint to
    // subjectKind "proof_of_value".
    if (path === "/api/workflows/transitions" && method === "POST" && opts.commands) {
      const commands = opts.commands;
      const guarded = await guardMutation(ctx, req, "workflow.transition", "*", res);
      if (!guarded) return true;
      const body = await readBody(req);
      const input = parseTransitionInput(body);
      const result = await runWithExecutionContextAsync(guarded.execution, () =>
        commands.requestTransition(guarded.execution, guarded.personId, input),
      );
      await send(res, result.executed ? 201 : 200, result);
      return true;
    }

    // -- NET-W005 evidence/proof-of-value endpoints --------------------
    // Every protected mutation is guarded by guardMutation() exactly like
    // the NET-W004 endpoints (unauthenticated → 403; unauthorized → 403,
    // deny-by-default). Verification endpoints are non-mutating reads and
    // therefore public (they present no authority risk: they only compare
    // presented material against stored commitments).

    // POST /api/evidence — create an evidence record (protected).
    if (path === "/api/evidence" && method === "POST" && opts.commands) {
      const commands = opts.commands;
      const guarded = await guardMutation(ctx, req, "evidence.create", "*", res);
      if (!guarded) return true;
      const body = await readBody(req);
      const input = parseEvidenceInput(body);
      const view = await runWithExecutionContextAsync(guarded.execution, () =>
        commands.createEvidence(guarded.execution, guarded.personId, input),
      );
      await send(res, 201, view);
      return true;
    }

    // GET /api/evidence/:id — fetch an evidence record (public read).
    // Sensitive evidence returns commitment + reference only — the raw
    // material is never stored, so it can never leak through this view.
    if (path.startsWith("/api/evidence/") && method === "GET" && opts.commands) {
      const id = path.slice("/api/evidence/".length);
      const view = await opts.commands.getEvidence(ctx, id);
      if (!view) {
        await send(res, 404, { error: "not_found", message: `evidence not found: ${id}` });
        return true;
      }
      await send(res, 200, view);
      return true;
    }

    // POST /api/evidence/:id/commitment:verify — verify presented
    // plaintext against the stored commitment (public, non-mutating).
    if (
      path.startsWith("/api/evidence/") &&
      path.endsWith("/commitment:verify") &&
      method === "POST" &&
      opts.commands
    ) {
      const id = path.slice("/api/evidence/".length, -"/commitment:verify".length);
      const body = await readBody(req);
      const obj = body as Record<string, unknown>;
      const payload = obj.payload;
      if (typeof payload !== "string") {
        throw apiValidationError('field "payload" must be a string');
      }
      const view = await runWithExecutionContextAsync(ctx, () =>
        opts.commands!.verifyEvidenceCommitment(ctx, id, payload),
      );
      await send(res, 200, view);
      return true;
    }

    // POST /api/outcome-claims — create an outcome claim (protected).
    if (path === "/api/outcome-claims" && method === "POST" && opts.commands) {
      const commands = opts.commands;
      const guarded = await guardMutation(ctx, req, "outcomeClaim.create", "*", res);
      if (!guarded) return true;
      const body = await readBody(req);
      const input = parseOutcomeClaimInput(body);
      const view = await runWithExecutionContextAsync(guarded.execution, () =>
        commands.createOutcomeClaim(guarded.execution, guarded.personId, input),
      );
      await send(res, 201, view);
      return true;
    }

    // GET /api/outcome-claims/:id — fetch an outcome claim (public read).
    if (path.startsWith("/api/outcome-claims/") && method === "GET" && opts.commands) {
      const id = path.slice("/api/outcome-claims/".length);
      const view = await opts.commands.getOutcomeClaim(ctx, id);
      if (!view) {
        await send(res, 404, { error: "not_found", message: `outcome claim not found: ${id}` });
        return true;
      }
      await send(res, 200, view);
      return true;
    }

    // POST /api/outcome-claims/:id/evidence — attach evidence (protected).
    if (
      path.startsWith("/api/outcome-claims/") &&
      path.endsWith("/evidence") &&
      method === "POST" &&
      opts.commands
    ) {
      const commands = opts.commands;
      const claimId = path.slice("/api/outcome-claims/".length, -"/evidence".length);
      const guarded = await guardMutation(ctx, req, "outcomeClaim.attachEvidence", "*", res);
      if (!guarded) return true;
      const body = await readBody(req);
      const obj = body as Record<string, unknown>;
      const evidenceId = obj.evidenceId;
      if (typeof evidenceId !== "string" || !evidenceId.trim()) {
        throw apiValidationError('field "evidenceId" must be a non-empty string');
      }
      const view = await runWithExecutionContextAsync(guarded.execution, () =>
        commands.attachEvidenceToClaim(
          guarded.execution,
          guarded.personId,
          claimId,
          evidenceId,
        ),
      );
      await send(res, 200, view);
      return true;
    }

    // POST /api/attestations — create an attestation (protected).
    if (path === "/api/attestations" && method === "POST" && opts.commands) {
      const commands = opts.commands;
      const guarded = await guardMutation(ctx, req, "attestation.create", "*", res);
      if (!guarded) return true;
      const body = await readBody(req);
      const input = parseAttestationInput(body);
      const view = await runWithExecutionContextAsync(guarded.execution, () =>
        commands.createAttestation(guarded.execution, guarded.personId, input),
      );
      await send(res, 201, view);
      return true;
    }

    // POST /api/attestations/:id/verify — verify an attestation WITHOUT
    // plaintext disclosure (public, non-mutating).
    if (
      path.startsWith("/api/attestations/") &&
      path.endsWith("/verify") &&
      method === "POST" &&
      opts.commands
    ) {
      const id = path.slice("/api/attestations/".length, -"/verify".length);
      const view = await runWithExecutionContextAsync(ctx, () =>
        opts.commands!.verifyAttestation(ctx, id),
      );
      await send(res, 200, view);
      return true;
    }

    // POST /api/proofs-of-value — create a proof of value (protected).
    if (path === "/api/proofs-of-value" && method === "POST" && opts.commands) {
      const commands = opts.commands;
      const guarded = await guardMutation(ctx, req, "proofOfValue.create", "*", res);
      if (!guarded) return true;
      const body = await readBody(req);
      const input = parseProofOfValueInput(body);
      const view = await runWithExecutionContextAsync(guarded.execution, () =>
        commands.createProofOfValue(guarded.execution, guarded.personId, input),
      );
      await send(res, 201, view);
      return true;
    }

    // GET /api/proofs-of-value/:id — fetch a proof of value (public read).
    if (path.startsWith("/api/proofs-of-value/") && method === "GET" && opts.commands) {
      const id = path.slice("/api/proofs-of-value/".length);
      const view = await opts.commands.getProofOfValue(ctx, id);
      if (!view) {
        await send(res, 404, { error: "not_found", message: `proof of value not found: ${id}` });
        return true;
      }
      await send(res, 200, view);
      return true;
    }

    // POST /api/proofs-of-value/:id/evidence — attach evidence (protected).
    if (
      path.startsWith("/api/proofs-of-value/") &&
      path.endsWith("/evidence") &&
      method === "POST" &&
      opts.commands
    ) {
      const commands = opts.commands;
      const proofId = path.slice("/api/proofs-of-value/".length, -"/evidence".length);
      const guarded = await guardMutation(ctx, req, "proofOfValue.attachEvidence", "*", res);
      if (!guarded) return true;
      const body = await readBody(req);
      const obj = body as Record<string, unknown>;
      const evidenceId = obj.evidenceId;
      if (typeof evidenceId !== "string" || !evidenceId.trim()) {
        throw apiValidationError('field "evidenceId" must be a non-empty string');
      }
      const view = await runWithExecutionContextAsync(guarded.execution, () =>
        commands.attachEvidenceToProof(
          guarded.execution,
          guarded.personId,
          proofId,
          evidenceId,
        ),
      );
      await send(res, 200, view);
      return true;
    }

    // POST /api/proofs-of-value/:id/aggregate — aggregate the attached
    // evidence deterministically (protected).
    if (
      path.startsWith("/api/proofs-of-value/") &&
      path.endsWith("/aggregate") &&
      method === "POST" &&
      opts.commands
    ) {
      const commands = opts.commands;
      const proofId = path.slice("/api/proofs-of-value/".length, -"/aggregate".length);
      const guarded = await guardMutation(ctx, req, "proofOfValue.aggregate", "*", res);
      if (!guarded) return true;
      const view = await runWithExecutionContextAsync(guarded.execution, () =>
        commands.aggregateProofEvidence(guarded.execution, guarded.personId, proofId),
      );
      await send(res, 200, view);
      return true;
    }

    // POST /api/proofs-of-value/:id/attestations — attach an attestation
    // (protected).
    if (
      path.startsWith("/api/proofs-of-value/") &&
      path.endsWith("/attestations") &&
      method === "POST" &&
      opts.commands
    ) {
      const commands = opts.commands;
      const proofId = path.slice("/api/proofs-of-value/".length, -"/attestations".length);
      const guarded = await guardMutation(ctx, req, "proofOfValue.attest", "*", res);
      if (!guarded) return true;
      const body = await readBody(req);
      const obj = body as Record<string, unknown>;
      const attestationId = obj.attestationId;
      if (typeof attestationId !== "string" || !attestationId.trim()) {
        throw apiValidationError('field "attestationId" must be a non-empty string');
      }
      const view = await runWithExecutionContextAsync(guarded.execution, () =>
        commands.attachAttestationToProof(
          guarded.execution,
          guarded.personId,
          proofId,
          attestationId,
        ),
      );
      await send(res, 200, view);
      return true;
    }

    return false;
  }

  // Parse opportunity input from a request body. Throws a validation
  // OpenConError when fields are missing or have the wrong shape.
  function parseOpportunityInput(body: unknown): import("./port.ts").ApiCreateOpportunityInput {
    if (!body || typeof body !== "object") {
      throw apiValidationError("request body must be a JSON object");
    }
    const obj = body as Record<string, unknown>;
    const organizationScopeId = strField(obj, "organizationScopeId");
    const opportunityType = strField(obj, "opportunityType");
    const title = strField(obj, "title");
    return {
      organizationScopeId,
      opportunityType,
      title,
      brief: obj.brief && typeof obj.brief === "object" ? obj.brief as Readonly<Record<string, unknown>> : undefined,
      eligibilityPolicyReference: typeof obj.eligibilityPolicyReference === "string" ? obj.eligibilityPolicyReference : (obj.eligibilityPolicyReference ?? null) as string | null,
      contributionRequirements: obj.contributionRequirements && typeof obj.contributionRequirements === "object" ? obj.contributionRequirements as Readonly<Record<string, unknown>> : undefined,
      evidenceReferencePlaceholders: Array.isArray(obj.evidenceReferencePlaceholders) ? (obj.evidenceReferencePlaceholders as string[]) : undefined,
    };
  }

  function parseContributionInput(body: unknown): import("./port.ts").ApiCreateContributionInput {
    if (!body || typeof body !== "object") {
      throw apiValidationError("request body must be a JSON object");
    }
    const obj = body as Record<string, unknown>;
    return {
      opportunityId: strField(obj, "opportunityId"),
      organizationScopeId: strField(obj, "organizationScopeId"),
      contributionType: strField(obj, "contributionType"),
      submission: obj.submission && typeof obj.submission === "object" ? obj.submission as Readonly<Record<string, unknown>> : undefined,
      evidenceReferencePlaceholders: Array.isArray(obj.evidenceReferencePlaceholders) ? (obj.evidenceReferencePlaceholders as string[]) : undefined,
    };
  }

  function parseTransitionInput(body: unknown): import("./port.ts").ApiRequestTransitionInput {
    if (!body || typeof body !== "object") {
      throw apiValidationError("request body must be a JSON object");
    }
    const obj = body as Record<string, unknown>;
    const subjectKind = obj.subjectKind;
    if (
      subjectKind !== "opportunity" &&
      subjectKind !== "contribution" &&
      subjectKind !== "proof_of_value"
    ) {
      throw apiValidationError(`subjectKind must be "opportunity", "contribution" or "proof_of_value" (got ${String(subjectKind)})`);
    }
    const targetState = strField(obj, "targetState");
    const expectedVersion = numField(obj, "expectedVersion");
    const idempotencyKey = strField(obj, "idempotencyKey");
    const policyAction = strField(obj, "policyAction");
    return {
      subjectId: strField(obj, "subjectId"),
      subjectKind,
      targetState,
      expectedVersion,
      idempotencyKey,
      policyAction,
      metadata: obj.metadata && typeof obj.metadata === "object" ? obj.metadata as Readonly<Record<string, unknown>> : undefined,
    };
  }

  // Parse a subject reference ({ subjectId, subjectType }) from a body.
  function parseSubjectReference(obj: Record<string, unknown>): {
    subjectId: string;
    subjectType: string;
  } {
    const ref = obj.subjectReference;
    if (!ref || typeof ref !== "object") {
      throw apiValidationError('field "subjectReference" must be an object with subjectId and subjectType');
    }
    const r = ref as Record<string, unknown>;
    return {
      subjectId: strField(r, "subjectId"),
      subjectType: strField(r, "subjectType"),
    };
  }

  // Parse a confidence estimate ({ point, lower?, upper?, method? }).
  function parseConfidence(obj: Record<string, unknown>): Record<string, unknown> {
    const conf = obj.confidence;
    if (!conf || typeof conf !== "object") {
      throw apiValidationError('field "confidence" must be an object with a point estimate in [0, 1]');
    }
    return conf as Record<string, unknown>;
  }

  function parseEvidenceInput(body: unknown): import("./port.ts").ApiCreateEvidenceInput {
    if (!body || typeof body !== "object") {
      throw apiValidationError("request body must be a JSON object");
    }
    const obj = body as Record<string, unknown>;
    const provenance = obj.provenance;
    if (!provenance || typeof provenance !== "object") {
      throw apiValidationError('field "provenance" must be an object with sourceType and method');
    }
    return {
      organizationScopeId: strField(obj, "organizationScopeId"),
      subjectReference: parseSubjectReference(obj),
      provenance: provenance as Record<string, unknown> as import("./port.ts").ApiCreateEvidenceInput["provenance"],
      confidence: parseConfidence(obj),
      sensitivity: typeof obj.sensitivity === "string" ? obj.sensitivity : undefined,
      payload: obj.payload && typeof obj.payload === "object" ? obj.payload as Readonly<Record<string, unknown>> : undefined,
      sensitivePayload: typeof obj.sensitivePayload === "string" ? obj.sensitivePayload : undefined,
      commitment: obj.commitment && typeof obj.commitment === "object" ? obj.commitment as Readonly<Record<string, unknown>> : undefined,
      payloadReference: typeof obj.payloadReference === "string" ? obj.payloadReference : undefined,
    };
  }

  function parseOutcomeClaimInput(body: unknown): import("./port.ts").ApiCreateOutcomeClaimInput {
    if (!body || typeof body !== "object") {
      throw apiValidationError("request body must be a JSON object");
    }
    const obj = body as Record<string, unknown>;
    const claimedValue = obj.claimedValue;
    if (!claimedValue || typeof claimedValue !== "object") {
      throw apiValidationError('field "claimedValue" must be an object with value and unit');
    }
    const cv = claimedValue as Record<string, unknown>;
    return {
      organizationScopeId: strField(obj, "organizationScopeId"),
      subjectReference: parseSubjectReference(obj),
      outcomeType: strField(obj, "outcomeType"),
      claimedValue: {
        value: numField(cv, "value"),
        unit: strField(cv, "unit"),
      },
      confidence: parseConfidence(obj),
      evidenceIds: Array.isArray(obj.evidenceIds) ? (obj.evidenceIds as string[]) : undefined,
      statement: typeof obj.statement === "string" ? obj.statement : undefined,
    };
  }

  function parseAttestationInput(body: unknown): import("./port.ts").ApiCreateAttestationInput {
    if (!body || typeof body !== "object") {
      throw apiValidationError("request body must be a JSON object");
    }
    const obj = body as Record<string, unknown>;
    if (!Array.isArray(obj.evidenceIds) || obj.evidenceIds.length === 0) {
      throw apiValidationError('field "evidenceIds" must be a non-empty array of evidence ids');
    }
    return {
      organizationScopeId: strField(obj, "organizationScopeId"),
      verifierId: strField(obj, "verifierId"),
      statement: strField(obj, "statement"),
      evidenceIds: obj.evidenceIds as string[],
    };
  }

  function parseProofOfValueInput(body: unknown): import("./port.ts").ApiCreateProofOfValueInput {
    if (!body || typeof body !== "object") {
      throw apiValidationError("request body must be a JSON object");
    }
    const obj = body as Record<string, unknown>;
    return {
      organizationScopeId: strField(obj, "organizationScopeId"),
      subjectReference: parseSubjectReference(obj),
      outcomeClaimIds: Array.isArray(obj.outcomeClaimIds) ? (obj.outcomeClaimIds as string[]) : undefined,
      evidenceIds: Array.isArray(obj.evidenceIds) ? (obj.evidenceIds as string[]) : undefined,
    };
  }

  function strField(obj: Record<string, unknown>, key: string): string {
    const v = obj[key];
    if (typeof v !== "string" || !v.trim()) {
      throw apiValidationError(`field "${key}" must be a non-empty string`);
    }
    return v;
  }

  function numField(obj: Record<string, unknown>, key: string): number {
    const v = obj[key];
    if (typeof v !== "number" || !Number.isFinite(v)) {
      throw apiValidationError(`field "${key}" must be a finite number`);
    }
    return v;
  }

  // A validation error for the request-body parsers. Uses the OpenConError
  // base class so the API error handler's `classifyError` recognizes the
  // `validation` classification and surfaces it as HTTP 400.
  function apiValidationError(message: string, context?: Readonly<Record<string, unknown>>): OpenConError {
    return new OpenConError({
      code: "API_VALIDATION",
      classification: "validation",
      message,
      retryable: false,
      context,
    });
  }

  function mapClassificationToStatus(classification: string): number {
    switch (classification) {
      case "validation":
        return 400;
      case "authorization":
        return 403;
      case "not_found":
        return 404;
      case "conflict":
        return 409;
      case "precondition":
        return 412;
      case "transient":
        return 503;
      default:
        return 500;
    }
  }

  async function send(res: ServerResponse, status: number, body: unknown): Promise<void> {
    res.statusCode = status;
    for (const [k, v] of Object.entries(JSON_HEADERS)) {
      res.setHeader(k, v);
    }
    res.end(JSON.stringify(body));
  }

  async function readBody(req: IncomingMessage): Promise<unknown> {
    const chunks: Buffer[] = [];
    for await (const chunk of req) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    }
    const text = Buffer.concat(chunks).toString("utf8");
    if (!text) return null;
    try {
      return JSON.parse(text);
    } catch {
      return text;
    }
  }

  const api: ApiServer = {
    port: boundPort,
    host: opts.host ?? "127.0.0.1",
    async start() {
      server = createServer((req, res) => {
        void handle(req, res);
      });
      await new Promise<void>((resolve) => {
        server!.listen(opts.port ?? 0, opts.host ?? "127.0.0.1", () => {
          const address = server!.address();
          boundPort =
            typeof address === "object" && address && "port" in address
              ? address.port
              : (opts.port ?? 0);
          resolve();
        });
      });
      opts.logger.info("api.server_started", { port: boundPort, host: opts.host });
    },
    async stop() {
      if (server) {
        await new Promise<void>((resolve) => server!.close(() => resolve()));
        server = null;
      }
    },
  };

  // Allow port to be updated after bind. Use a getter so `api.port` reads
  // the live value rather than the snapshot captured at construction.
  Object.defineProperty(api, "port", {
    get: () => boundPort,
    configurable: true,
  });

  return api;
}
