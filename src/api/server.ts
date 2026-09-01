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

    // -- NET-W006 outcomes/measurement endpoints ----------------------
    // Every protected mutation is guarded by guardMutation() exactly
    // like the NET-W004/W005 endpoints. Lifecycle transitions for
    // measured outcomes go through the EXISTING /api/workflows/
    // transitions endpoint (subjectKind "outcome_measurement") — the
    // SOLE lifecycle entry point.

    // POST /api/outcome-observations — create an observation (protected).
    if (path === "/api/outcome-observations" && method === "POST" && opts.commands) {
      const commands = opts.commands;
      const guarded = await guardMutation(ctx, req, "outcomeObservation.create", "*", res);
      if (!guarded) return true;
      const body = await readBody(req);
      const input = parseOutcomeObservationInput(body);
      const view = await runWithExecutionContextAsync(guarded.execution, () =>
        commands.createOutcomeObservation(guarded.execution, guarded.personId, input),
      );
      await send(res, 201, view);
      return true;
    }

    // GET /api/outcome-observations/:id — fetch an observation (public).
    if (path.startsWith("/api/outcome-observations/") && method === "GET" && opts.commands) {
      const id = path.slice("/api/outcome-observations/".length);
      const view = await opts.commands.getOutcomeObservation(ctx, id);
      if (!view) {
        await send(res, 404, { error: "not_found", message: `outcome observation not found: ${id}` });
        return true;
      }
      await send(res, 200, view);
      return true;
    }

    // POST /api/outcome-observations/:id/corrections — correct an
    // observation (append-corrected; protected).
    if (
      path.startsWith("/api/outcome-observations/") &&
      path.endsWith("/corrections") &&
      method === "POST" &&
      opts.commands
    ) {
      const commands = opts.commands;
      const observationId = path.slice("/api/outcome-observations/".length, -"/corrections".length);
      const guarded = await guardMutation(ctx, req, "outcomeObservation.correct", "*", res);
      if (!guarded) return true;
      const body = await readBody(req);
      const input = parseOutcomeObservationInput(body);
      const view = await runWithExecutionContextAsync(guarded.execution, () =>
        commands.correctOutcomeObservation(guarded.execution, guarded.personId, observationId, input),
      );
      await send(res, 201, view);
      return true;
    }

    // POST /api/outcome-observations:ingest — ingest provider
    // observations through the neutral adapter (protected).
    if (path === "/api/outcome-observations:ingest" && method === "POST" && opts.commands) {
      const commands = opts.commands;
      const guarded = await guardMutation(ctx, req, "outcomeObservation.ingest", "*", res);
      if (!guarded) return true;
      const body = await readBody(req);
      const obj = body as Record<string, unknown>;
      const view = await runWithExecutionContextAsync(guarded.execution, () =>
        commands.ingestProviderObservations(guarded.execution, guarded.personId, {
          organizationScopeId: strField(obj, "organizationScopeId"),
          subjectReference: parseSubjectReference(obj),
          since: typeof obj.since === "string" ? obj.since : undefined,
        }),
      );
      await send(res, 201, view);
      return true;
    }

    // POST /api/measurement-reports — submit ONE raw provider
    // attribution report (NET-W022 ADAPTER-003..004; protected). The
    // raw vendor payload is an opaque passthrough to the provider's
    // adapter in /measurement; the resulting provider-sourced
    // observation persists through /outcomes semantics.
    if (path === "/api/measurement-reports" && method === "POST" && opts.commands) {
      const commands = opts.commands;
      const guarded = await guardMutation(ctx, req, "measurementReport.submit", "*", res);
      if (!guarded) return true;
      const body = await readBody(req);
      const obj = body as Record<string, unknown>;
      if (obj.report === undefined) {
        await send(res, 400, {
          error: "validation",
          classification: "validation",
          message: "report (the raw provider report payload) is required",
        });
        return true;
      }
      const view = await runWithExecutionContextAsync(guarded.execution, () =>
        commands.submitMeasurementReport(guarded.execution, guarded.personId, {
          organizationScopeId: strField(obj, "organizationScopeId"),
          subjectReference: parseSubjectReference(obj),
          idempotencyKey: strField(obj, "idempotencyKey"),
          providerId: strField(obj, "providerId"),
          report: obj.report,
        }),
      );
      await send(res, 201, view);
      return true;
    }

    // POST /api/external-ad-requests — evaluate ONE external ad
    // request through the adapters boundary against registered supply
    // (NET-W023, ADAPTER-001..002; protected). The raw vendor payload
    // is an opaque passthrough to the provider's adapter; the
    // evaluation is a READ-ONLY derivation (a non-admitted decision is
    // a 200 result like the placement settlement-readiness view —
    // malformed input is a validation error).
    if (path === "/api/external-ad-requests" && method === "POST" && opts.commands) {
      const commands = opts.commands;
      const guarded = await guardMutation(ctx, req, "adRequest.evaluate", "*", res);
      if (!guarded) return true;
      const body = await readBody(req);
      const obj = body as Record<string, unknown>;
      if (obj.request === undefined) {
        await send(res, 400, {
          error: "validation",
          classification: "validation",
          message: "request (the raw vendor bid-request payload) is required",
        });
        return true;
      }
      const sellerAuthorizations = parseSellerAuthorizationSubmissions(obj);
      const view = await runWithExecutionContextAsync(guarded.execution, () =>
        commands.evaluateExternalAdRequest(guarded.execution, guarded.personId, {
          organizationScopeId: strField(obj, "organizationScopeId"),
          providerId: strField(obj, "providerId"),
          request: obj.request,
          ...(sellerAuthorizations !== undefined ? { sellerAuthorizations } : {}),
          ...(typeof obj.evaluatedAt === "string" ? { evaluatedAt: obj.evaluatedAt } : {}),
        }),
      );
      await send(res, 200, view);
      return true;
    }

    // POST /api/measurement-experiments — create an experiment (protected).
    if (path === "/api/measurement-experiments" && method === "POST" && opts.commands) {
      const commands = opts.commands;
      const guarded = await guardMutation(ctx, req, "measurementExperiment.create", "*", res);
      if (!guarded) return true;
      const body = await readBody(req);
      const input = parseMeasurementExperimentInput(body);
      const view = await runWithExecutionContextAsync(guarded.execution, () =>
        commands.createMeasurementExperiment(guarded.execution, guarded.personId, input),
      );
      await send(res, 201, view);
      return true;
    }

    // GET /api/measurement-experiments/:id — fetch an experiment (public).
    if (path.startsWith("/api/measurement-experiments/") && method === "GET" && opts.commands) {
      const id = path.slice("/api/measurement-experiments/".length);
      const view = await opts.commands.getMeasurementExperiment(ctx, id);
      if (!view) {
        await send(res, 404, { error: "not_found", message: `measurement experiment not found: ${id}` });
        return true;
      }
      await send(res, 200, view);
      return true;
    }

    // POST /api/measurement-experiments/:id/start|complete|invalidate —
    // experiment status changes (protected, optimistic concurrency).
    for (const [suffix, action, command] of [
      ["start", "measurementExperiment.start", "startMeasurementExperiment"],
      ["complete", "measurementExperiment.complete", "completeMeasurementExperiment"],
      ["invalidate", "measurementExperiment.invalidate", "invalidateMeasurementExperiment"],
    ] as const) {
      if (
        path.startsWith("/api/measurement-experiments/") &&
        path.endsWith(`/${suffix}`) &&
        method === "POST" &&
        opts.commands
      ) {
        const commands = opts.commands;
        const experimentId = path.slice("/api/measurement-experiments/".length, -(`/${suffix}`.length));
        const guarded = await guardMutation(ctx, req, action, "*", res);
        if (!guarded) return true;
        const body = await readBody(req);
        const obj = (body ?? {}) as Record<string, unknown>;
        const input = {
          expectedVersion: numField(obj, "expectedVersion"),
          reason: typeof obj.reason === "string" ? obj.reason : undefined,
        };
        const view = await runWithExecutionContextAsync(guarded.execution, () =>
          command === "startMeasurementExperiment"
            ? commands.startMeasurementExperiment(guarded.execution, guarded.personId, experimentId, input)
            : command === "completeMeasurementExperiment"
              ? commands.completeMeasurementExperiment(guarded.execution, guarded.personId, experimentId, input)
              : commands.invalidateMeasurementExperiment(guarded.execution, guarded.personId, experimentId, input),
        );
        await send(res, 200, view);
        return true;
      }
    }

    // POST /api/attributions — create an attribution (protected).
    if (path === "/api/attributions" && method === "POST" && opts.commands) {
      const commands = opts.commands;
      const guarded = await guardMutation(ctx, req, "attribution.create", "*", res);
      if (!guarded) return true;
      const body = await readBody(req);
      const input = parseAttributionInput(body);
      const view = await runWithExecutionContextAsync(guarded.execution, () =>
        commands.createAttribution(guarded.execution, guarded.personId, input),
      );
      await send(res, 201, view);
      return true;
    }

    // GET /api/attributions/:id — fetch an attribution (public).
    if (path.startsWith("/api/attributions/") && method === "GET" && opts.commands) {
      const id = path.slice("/api/attributions/".length);
      const view = await opts.commands.getAttribution(ctx, id);
      if (!view) {
        await send(res, 404, { error: "not_found", message: `attribution not found: ${id}` });
        return true;
      }
      await send(res, 200, view);
      return true;
    }

    // POST /api/incrementality-observations — create an incrementality
    // observation (protected).
    if (path === "/api/incrementality-observations" && method === "POST" && opts.commands) {
      const commands = opts.commands;
      const guarded = await guardMutation(ctx, req, "incrementality.create", "*", res);
      if (!guarded) return true;
      const body = await readBody(req);
      const input = parseIncrementalityInput(body);
      const view = await runWithExecutionContextAsync(guarded.execution, () =>
        commands.createIncrementalityObservation(guarded.execution, guarded.personId, input),
      );
      await send(res, 201, view);
      return true;
    }

    // GET /api/incrementality-observations/:id — fetch (public).
    if (path.startsWith("/api/incrementality-observations/") && method === "GET" && opts.commands) {
      const id = path.slice("/api/incrementality-observations/".length);
      const view = await opts.commands.getIncrementalityObservation(ctx, id);
      if (!view) {
        await send(res, 404, { error: "not_found", message: `incrementality observation not found: ${id}` });
        return true;
      }
      await send(res, 200, view);
      return true;
    }

    // POST /api/counterfactual-baselines — create a counterfactual/
    // baseline (protected).
    if (path === "/api/counterfactual-baselines" && method === "POST" && opts.commands) {
      const commands = opts.commands;
      const guarded = await guardMutation(ctx, req, "baseline.create", "*", res);
      if (!guarded) return true;
      const body = await readBody(req);
      const input = parseCounterfactualBaselineInput(body);
      const view = await runWithExecutionContextAsync(guarded.execution, () =>
        commands.createCounterfactualBaseline(guarded.execution, guarded.personId, input),
      );
      await send(res, 201, view);
      return true;
    }

    // GET /api/counterfactual-baselines/:id — fetch (public).
    if (path.startsWith("/api/counterfactual-baselines/") && method === "GET" && opts.commands) {
      const id = path.slice("/api/counterfactual-baselines/".length);
      const view = await opts.commands.getCounterfactualBaseline(ctx, id);
      if (!view) {
        await send(res, 404, { error: "not_found", message: `counterfactual baseline not found: ${id}` });
        return true;
      }
      await send(res, 200, view);
      return true;
    }

    // POST /api/measured-outcomes — create a measured outcome (protected).
    if (path === "/api/measured-outcomes" && method === "POST" && opts.commands) {
      const commands = opts.commands;
      const guarded = await guardMutation(ctx, req, "measuredOutcome.create", "*", res);
      if (!guarded) return true;
      const body = await readBody(req);
      const input = parseMeasuredOutcomeInput(body);
      const view = await runWithExecutionContextAsync(guarded.execution, () =>
        commands.createMeasuredOutcome(guarded.execution, guarded.personId, input),
      );
      await send(res, 201, view);
      return true;
    }

    // GET /api/measured-outcomes/:id — fetch the detailed view (public).
    if (path.startsWith("/api/measured-outcomes/") && method === "GET" && opts.commands) {
      const id = path.slice("/api/measured-outcomes/".length);
      const view = await opts.commands.getMeasuredOutcome(ctx, id);
      if (!view) {
        await send(res, 404, { error: "not_found", message: `measured outcome not found: ${id}` });
        return true;
      }
      await send(res, 200, view);
      return true;
    }

    // POST /api/measured-outcomes/:id/observations|attributions|
    // baselines|incrementality — attach records (append-only, protected).
    for (const [suffix, action, kind] of [
      ["observations", "measuredOutcome.attachObservation", "observation"],
      ["attributions", "measuredOutcome.attachAttribution", "attribution"],
      ["baselines", "measuredOutcome.attachBaseline", "baseline"],
      ["incrementality", "measuredOutcome.attachIncrementality", "incrementality"],
    ] as const) {
      if (
        path.startsWith("/api/measured-outcomes/") &&
        path.endsWith(`/${suffix}`) &&
        method === "POST" &&
        opts.commands
      ) {
        const commands = opts.commands;
        const measurementId = path.slice("/api/measured-outcomes/".length, -(`/${suffix}`.length));
        const guarded = await guardMutation(ctx, req, action, "*", res);
        if (!guarded) return true;
        const body = await readBody(req);
        const obj = body as Record<string, unknown>;
        const attachKey =
          kind === "observation"
            ? "observationId"
            : kind === "attribution"
              ? "attributionId"
              : kind === "baseline"
                ? "baselineId"
                : "incrementalityId";
        const attachId = obj[attachKey];
        if (typeof attachId !== "string" || !attachId.trim()) {
          throw apiValidationError(`field "${attachKey}" must be a non-empty string`);
        }
        const view = await runWithExecutionContextAsync(guarded.execution, () =>
          kind === "observation"
            ? commands.attachObservationToMeasurement(guarded.execution, guarded.personId, measurementId, attachId)
            : kind === "attribution"
              ? commands.attachAttributionToMeasurement(guarded.execution, guarded.personId, measurementId, attachId)
              : kind === "baseline"
                ? commands.attachBaselineToMeasurement(guarded.execution, guarded.personId, measurementId, attachId)
                : commands.attachIncrementalityToMeasurement(guarded.execution, guarded.personId, measurementId, attachId),
        );
        await send(res, 200, view);
        return true;
      }
    }

    // POST /api/measured-outcomes/:id/rollup — record the deterministic
    // rollup (protected).
    if (
      path.startsWith("/api/measured-outcomes/") &&
      path.endsWith("/rollup") &&
      method === "POST" &&
      opts.commands
    ) {
      const commands = opts.commands;
      const measurementId = path.slice("/api/measured-outcomes/".length, -"/rollup".length);
      const guarded = await guardMutation(ctx, req, "measuredOutcome.recordRollup", "*", res);
      if (!guarded) return true;
      const view = await runWithExecutionContextAsync(guarded.execution, () =>
        commands.recordMeasurementRollup(guarded.execution, guarded.personId, measurementId),
      );
      await send(res, 200, view);
      return true;
    }

    // -- NET-W007 reputation routes ---------------------------------------

    // POST /api/reputation/policies — create a scoring-policy version
    // (protected).
    if (path === "/api/reputation/policies" && method === "POST" && opts.commands) {
      const commands = opts.commands;
      const guarded = await guardMutation(ctx, req, "reputationPolicy.create", "*", res);
      if (!guarded) return true;
      const body = await readBody(req);
      const input = parseReputationPolicyInput(body);
      const view = await runWithExecutionContextAsync(guarded.execution, () =>
        commands.createReputationPolicy(guarded.execution, guarded.personId, input),
      );
      await send(res, 201, view);
      return true;
    }

    // GET /api/reputation/policies/:policyId/versions — list a lineage's
    // versions (public).
    if (
      path.startsWith("/api/reputation/policies/") &&
      path.endsWith("/versions") &&
      method === "GET" &&
      opts.commands
    ) {
      const policyId = path.slice("/api/reputation/policies/".length, -"/versions".length);
      const url = new URL(req.url ?? "/", "http://localhost");
      const organizationScopeId = url.searchParams.get("organizationScopeId") ?? undefined;
      const views = await opts.commands.listReputationPolicyVersions(ctx, policyId, organizationScopeId);
      await send(res, 200, { policyId, versions: views });
      return true;
    }

    // GET /api/reputation/policies/:id — fetch a policy version by
    // record id (public).
    if (path.startsWith("/api/reputation/policies/") && method === "GET" && opts.commands) {
      const id = path.slice("/api/reputation/policies/".length);
      const view = await opts.commands.getReputationPolicy(ctx, id);
      if (!view) {
        await send(res, 404, { error: "not_found", message: `reputation scoring policy not found: ${id}` });
        return true;
      }
      await send(res, 200, view);
      return true;
    }

    // POST /api/reputation/inputs — record a reputation input
    // (protected; every input carries ≥1 upstream source reference).
    if (path === "/api/reputation/inputs" && method === "POST" && opts.commands) {
      const commands = opts.commands;
      const guarded = await guardMutation(ctx, req, "reputationInput.create", "*", res);
      if (!guarded) return true;
      const body = await readBody(req);
      const input = parseReputationInputInput(body);
      const result = await runWithExecutionContextAsync(guarded.execution, () =>
        commands.recordReputationInput(guarded.execution, guarded.personId, input),
      );
      await send(res, 201, result);
      return true;
    }

    // GET /api/reputation/inputs/:id — fetch a reputation input (public).
    if (path.startsWith("/api/reputation/inputs/") && method === "GET" && opts.commands) {
      const id = path.slice("/api/reputation/inputs/".length);
      const view = await opts.commands.getReputationInput(ctx, id);
      if (!view) {
        await send(res, 404, { error: "not_found", message: `reputation input not found: ${id}` });
        return true;
      }
      await send(res, 200, view);
      return true;
    }

    // GET /api/reputation/subjects/:personId/scores — deterministic
    // compute preview (public, read-only, explicit referenceAt).
    if (
      path.startsWith("/api/reputation/subjects/") &&
      path.endsWith("/scores") &&
      method === "GET" &&
      opts.commands
    ) {
      const personId = path.slice("/api/reputation/subjects/".length, -"/scores".length);
      const url = new URL(req.url ?? "/", "http://localhost");
      const organizationScopeId = url.searchParams.get("organizationScopeId");
      const policyId = url.searchParams.get("policyId");
      const referenceAt = url.searchParams.get("referenceAt");
      const versionParam = url.searchParams.get("version");
      if (!organizationScopeId || !policyId || !referenceAt) {
        throw apiValidationError(
          "query parameters organizationScopeId, policyId and referenceAt are required",
        );
      }
      const version = versionParam !== null ? Number(versionParam) : undefined;
      if (version !== undefined && (!Number.isInteger(version) || version < 1)) {
        throw apiValidationError('query parameter "version" must be a positive integer');
      }
      const view = await opts.commands.computeReputationScores(ctx, {
        organizationScopeId,
        subjectPersonId: personId,
        policyId,
        ...(version !== undefined ? { version } : {}),
        referenceAt,
      });
      await send(res, 200, view);
      return true;
    }

    // POST /api/reputation/snapshots — record a reputation snapshot
    // (protected; computes deterministically inside the authoritative
    // transaction).
    if (path === "/api/reputation/snapshots" && method === "POST" && opts.commands) {
      const commands = opts.commands;
      const guarded = await guardMutation(ctx, req, "reputationSnapshot.create", "*", res);
      if (!guarded) return true;
      const body = await readBody(req);
      const input = parseReputationComputationInput(body);
      const result = await runWithExecutionContextAsync(guarded.execution, () =>
        commands.recordReputationSnapshot(guarded.execution, guarded.personId, input),
      );
      await send(res, 201, result);
      return true;
    }

    // GET /api/reputation/snapshots/:id — fetch a snapshot (public).
    if (path.startsWith("/api/reputation/snapshots/") && method === "GET" && opts.commands) {
      const id = path.slice("/api/reputation/snapshots/".length);
      const view = await opts.commands.getReputationSnapshot(ctx, id);
      if (!view) {
        await send(res, 404, { error: "not_found", message: `reputation snapshot not found: ${id}` });
        return true;
      }
      await send(res, 200, view);
      return true;
    }

    // GET /api/reputation/subjects/:personId/snapshots/latest — the
    // subject's latest snapshot (public).
    if (
      path.startsWith("/api/reputation/subjects/") &&
      path.endsWith("/snapshots/latest") &&
      method === "GET" &&
      opts.commands
    ) {
      const personId = path.slice("/api/reputation/subjects/".length, -"/snapshots/latest".length);
      const url = new URL(req.url ?? "/", "http://localhost");
      const organizationScopeId = url.searchParams.get("organizationScopeId");
      if (!organizationScopeId) {
        throw apiValidationError('query parameter "organizationScopeId" is required');
      }
      const view = await opts.commands.getLatestReputationSnapshot(ctx, organizationScopeId, personId);
      if (!view) {
        await send(res, 404, { error: "not_found", message: `no reputation snapshot recorded for subject ${personId}` });
        return true;
      }
      await send(res, 200, view);
      return true;
    }

    // GET /api/reputation/subjects/:personId/snapshots — the subject's
    // snapshot history, oldest → newest (public).
    if (
      path.startsWith("/api/reputation/subjects/") &&
      path.endsWith("/snapshots") &&
      method === "GET" &&
      opts.commands
    ) {
      const personId = path.slice("/api/reputation/subjects/".length, -"/snapshots".length);
      const url = new URL(req.url ?? "/", "http://localhost");
      const organizationScopeId = url.searchParams.get("organizationScopeId");
      if (!organizationScopeId) {
        throw apiValidationError('query parameter "organizationScopeId" is required');
      }
      const views = await opts.commands.getReputationSnapshotHistory(ctx, organizationScopeId, personId);
      await send(res, 200, { subjectPersonId: personId, snapshots: views });
      return true;
    }

    // GET /api/reputation/subjects/:personId/inputs — the subject's
    // reputation inputs (public).
    if (
      path.startsWith("/api/reputation/subjects/") &&
      path.endsWith("/inputs") &&
      method === "GET" &&
      opts.commands
    ) {
      const personId = path.slice("/api/reputation/subjects/".length, -"/inputs".length);
      const url = new URL(req.url ?? "/", "http://localhost");
      const organizationScopeId = url.searchParams.get("organizationScopeId");
      if (!organizationScopeId) {
        throw apiValidationError('query parameter "organizationScopeId" is required');
      }
      const views = await opts.commands.listReputationInputs(ctx, organizationScopeId, personId);
      await send(res, 200, { subjectPersonId: personId, inputs: views });
      return true;
    }

    // -- NET-W008 settlement routes ----------------------------------------

    // POST /api/settlement/values — record pending economic value
    // (protected; the verified-source input gate).
    if (path === "/api/settlement/values" && method === "POST" && opts.commands) {
      const commands = opts.commands;
      const guarded = await guardMutation(ctx, req, "economicValue.create", "*", res);
      if (!guarded) return true;
      const body = await readBody(req);
      const input = parseEconomicValueInput(body);
      const result = await runWithExecutionContextAsync(guarded.execution, () =>
        commands.createEconomicValue(guarded.execution, input),
      );
      await send(res, 201, result);
      return true;
    }

    // GET /api/settlement/values — a beneficiary's value records
    // (public; optional state filter).
    if (path === "/api/settlement/values" && method === "GET" && opts.commands) {
      const url = new URL(req.url ?? "/", "http://localhost");
      const organizationScopeId = url.searchParams.get("organizationScopeId");
      const beneficiaryPersonId = url.searchParams.get("beneficiaryPersonId");
      if (!organizationScopeId || !beneficiaryPersonId) {
        throw apiValidationError(
          'query parameters "organizationScopeId" and "beneficiaryPersonId" are required',
        );
      }
      const stateParam = url.searchParams.get("state");
      const states = stateParam !== null ? stateParam.split(",").map((s) => s.trim()) : undefined;
      const views = await opts.commands.listEconomicValues(
        ctx,
        organizationScopeId,
        beneficiaryPersonId,
        states,
      );
      await send(res, 200, { beneficiaryPersonId, values: views });
      return true;
    }

    // POST /api/settlement/values/:id/mature — the explicit maturation
    // gate (protected).
    if (
      path.startsWith("/api/settlement/values/") &&
      path.endsWith("/mature") &&
      method === "POST" &&
      opts.commands
    ) {
      const commands = opts.commands;
      const guarded = await guardMutation(ctx, req, "economicValue.mature", "*", res);
      if (!guarded) return true;
      const valueRecordId = path.slice("/api/settlement/values/".length, -"/mature".length);
      const body = await readBody(req);
      const input = parseMatureValueInput(body, valueRecordId);
      const view = await runWithExecutionContextAsync(guarded.execution, () =>
        commands.matureEconomicValue(guarded.execution, input),
      );
      await send(res, 200, view);
      return true;
    }

    // POST /api/settlement/values/:id/reverse — append-only correction
    // (protected).
    if (
      path.startsWith("/api/settlement/values/") &&
      path.endsWith("/reverse") &&
      method === "POST" &&
      opts.commands
    ) {
      const commands = opts.commands;
      const guarded = await guardMutation(ctx, req, "economicValue.reverse", "*", res);
      if (!guarded) return true;
      const valueRecordId = path.slice("/api/settlement/values/".length, -"/reverse".length);
      const body = await readBody(req);
      const input = parseReversalInput(body, valueRecordId);
      const view = await runWithExecutionContextAsync(guarded.execution, () =>
        commands.reverseEconomicValue(guarded.execution, {
          valueRecordId: input.id,
          reason: input.reason,
          idempotencyKey: input.idempotencyKey,
        }),
      );
      await send(res, 200, view);
      return true;
    }

    // GET /api/settlement/values/:id — fetch a value record (public).
    if (path.startsWith("/api/settlement/values/") && method === "GET" && opts.commands) {
      const id = path.slice("/api/settlement/values/".length);
      const view = await opts.commands.getEconomicValue(ctx, id);
      if (!view) {
        await send(res, 404, { error: "not_found", message: `economic value record not found: ${id}` });
        return true;
      }
      await send(res, 200, view);
      return true;
    }

    // POST /api/settlement/credit-issuances — issue Participation
    // Credits (protected; PoV-gated — architecture-lock invariant 20).
    if (path === "/api/settlement/credit-issuances" && method === "POST" && opts.commands) {
      const commands = opts.commands;
      const guarded = await guardMutation(ctx, req, "creditIssuance.create", "*", res);
      if (!guarded) return true;
      const body = await readBody(req);
      const input = parseIssueCreditsInput(body);
      const result = await runWithExecutionContextAsync(guarded.execution, () =>
        commands.issueCredits(guarded.execution, input),
      );
      await send(res, 201, result);
      return true;
    }

    // GET /api/settlement/credit-issuances — a beneficiary's issuances
    // (public).
    if (path === "/api/settlement/credit-issuances" && method === "GET" && opts.commands) {
      const url = new URL(req.url ?? "/", "http://localhost");
      const organizationScopeId = url.searchParams.get("organizationScopeId");
      const beneficiaryPersonId = url.searchParams.get("beneficiaryPersonId");
      if (!organizationScopeId || !beneficiaryPersonId) {
        throw apiValidationError(
          'query parameters "organizationScopeId" and "beneficiaryPersonId" are required',
        );
      }
      const views = await opts.commands.listCreditIssuances(
        ctx,
        organizationScopeId,
        beneficiaryPersonId,
      );
      await send(res, 200, { beneficiaryPersonId, issuances: views });
      return true;
    }

    // POST /api/settlement/credit-issuances/:id/reverse — append-only
    // correction (protected).
    if (
      path.startsWith("/api/settlement/credit-issuances/") &&
      path.endsWith("/reverse") &&
      method === "POST" &&
      opts.commands
    ) {
      const commands = opts.commands;
      const guarded = await guardMutation(ctx, req, "creditIssuance.reverse", "*", res);
      if (!guarded) return true;
      const issuanceId = path.slice("/api/settlement/credit-issuances/".length, -"/reverse".length);
      const body = await readBody(req);
      const input = parseReversalInput(body, issuanceId);
      const view = await runWithExecutionContextAsync(guarded.execution, () =>
        commands.reverseCreditIssuance(guarded.execution, {
          issuanceId: input.id,
          reason: input.reason,
          idempotencyKey: input.idempotencyKey,
        }),
      );
      await send(res, 200, view);
      return true;
    }

    // GET /api/settlement/credit-issuances/:id — fetch an issuance
    // (public).
    if (path.startsWith("/api/settlement/credit-issuances/") && method === "GET" && opts.commands) {
      const id = path.slice("/api/settlement/credit-issuances/".length);
      const view = await opts.commands.getCreditIssuance(ctx, id);
      if (!view) {
        await send(res, 404, { error: "not_found", message: `credit issuance not found: ${id}` });
        return true;
      }
      await send(res, 200, view);
      return true;
    }

    // POST /api/settlement/reward-policies — create a reward-policy
    // version (protected).
    if (path === "/api/settlement/reward-policies" && method === "POST" && opts.commands) {
      const commands = opts.commands;
      const guarded = await guardMutation(ctx, req, "rewardPolicy.create", "*", res);
      if (!guarded) return true;
      const body = await readBody(req);
      const input = parseRewardPolicyInput(body);
      const view = await runWithExecutionContextAsync(guarded.execution, () =>
        commands.createRewardPolicy(guarded.execution, input),
      );
      await send(res, 201, view);
      return true;
    }

    // GET /api/settlement/reward-policies/:policyId/versions — list a
    // lineage's versions (public).
    if (
      path.startsWith("/api/settlement/reward-policies/") &&
      path.endsWith("/versions") &&
      method === "GET" &&
      opts.commands
    ) {
      const policyId = path.slice("/api/settlement/reward-policies/".length, -"/versions".length);
      const url = new URL(req.url ?? "/", "http://localhost");
      const organizationScopeId = url.searchParams.get("organizationScopeId") ?? undefined;
      const views = await opts.commands.listRewardPolicyVersions(ctx, policyId, organizationScopeId);
      await send(res, 200, { policyId, versions: views });
      return true;
    }

    // GET /api/settlement/reward-policies/:id — fetch a policy version
    // by record id (public).
    if (path.startsWith("/api/settlement/reward-policies/") && method === "GET" && opts.commands) {
      const id = path.slice("/api/settlement/reward-policies/".length);
      const view = await opts.commands.getRewardPolicy(ctx, id);
      if (!view) {
        await send(res, 404, { error: "not_found", message: `reward policy not found: ${id}` });
        return true;
      }
      await send(res, 200, view);
      return true;
    }

    // POST /api/settlement/reward-allocations — allocate rewards from a
    // mature value record (protected; deterministic split).
    if (path === "/api/settlement/reward-allocations" && method === "POST" && opts.commands) {
      const commands = opts.commands;
      const guarded = await guardMutation(ctx, req, "rewardAllocation.create", "*", res);
      if (!guarded) return true;
      const body = await readBody(req);
      const input = parseAllocateRewardsInput(body);
      const result = await runWithExecutionContextAsync(guarded.execution, () =>
        commands.allocateRewards(guarded.execution, input),
      );
      await send(res, 201, result);
      return true;
    }

    // GET /api/settlement/reward-allocations — an organization's
    // allocations (public).
    if (path === "/api/settlement/reward-allocations" && method === "GET" && opts.commands) {
      const url = new URL(req.url ?? "/", "http://localhost");
      const organizationScopeId = url.searchParams.get("organizationScopeId");
      if (!organizationScopeId) {
        throw apiValidationError('query parameter "organizationScopeId" is required');
      }
      const views = await opts.commands.listRewardAllocations(ctx, organizationScopeId);
      await send(res, 200, { organizationScopeId, allocations: views });
      return true;
    }

    // POST /api/settlement/reward-allocations/:id/reverse — append-only
    // correction (protected).
    if (
      path.startsWith("/api/settlement/reward-allocations/") &&
      path.endsWith("/reverse") &&
      method === "POST" &&
      opts.commands
    ) {
      const commands = opts.commands;
      const guarded = await guardMutation(ctx, req, "rewardAllocation.reverse", "*", res);
      if (!guarded) return true;
      const allocationId = path.slice("/api/settlement/reward-allocations/".length, -"/reverse".length);
      const body = await readBody(req);
      const input = parseReversalInput(body, allocationId);
      const view = await runWithExecutionContextAsync(guarded.execution, () =>
        commands.reverseRewardAllocation(guarded.execution, {
          allocationId: input.id,
          reason: input.reason,
          idempotencyKey: input.idempotencyKey,
        }),
      );
      await send(res, 200, view);
      return true;
    }

    // GET /api/settlement/reward-allocations/:id — fetch an allocation
    // (public).
    if (path.startsWith("/api/settlement/reward-allocations/") && method === "GET" && opts.commands) {
      const id = path.slice("/api/settlement/reward-allocations/".length);
      const view = await opts.commands.getRewardAllocation(ctx, id);
      if (!view) {
        await send(res, 404, { error: "not_found", message: `reward allocation not found: ${id}` });
        return true;
      }
      await send(res, 200, view);
      return true;
    }

    // POST /api/settlement/cash-obligations — record a cash obligation
    // (protected).
    if (path === "/api/settlement/cash-obligations" && method === "POST" && opts.commands) {
      const commands = opts.commands;
      const guarded = await guardMutation(ctx, req, "cashObligation.create", "*", res);
      if (!guarded) return true;
      const body = await readBody(req);
      const input = parseCashObligationInput(body);
      const result = await runWithExecutionContextAsync(guarded.execution, () =>
        commands.recordCashObligation(guarded.execution, input),
      );
      await send(res, 201, result);
      return true;
    }

    // GET /api/settlement/cash-obligations — an organization's
    // obligations (public).
    if (path === "/api/settlement/cash-obligations" && method === "GET" && opts.commands) {
      const url = new URL(req.url ?? "/", "http://localhost");
      const organizationScopeId = url.searchParams.get("organizationScopeId");
      if (!organizationScopeId) {
        throw apiValidationError('query parameter "organizationScopeId" is required');
      }
      const views = await opts.commands.listCashObligations(ctx, organizationScopeId);
      await send(res, 200, { organizationScopeId, obligations: views });
      return true;
    }

    // POST /api/settlement/cash-obligations/:id/settle — internal
    // settlement (protected; external rails are NET-W030).
    if (
      path.startsWith("/api/settlement/cash-obligations/") &&
      path.endsWith("/settle") &&
      method === "POST" &&
      opts.commands
    ) {
      const commands = opts.commands;
      const guarded = await guardMutation(ctx, req, "cashObligation.settle", "*", res);
      if (!guarded) return true;
      const obligationId = path.slice("/api/settlement/cash-obligations/".length, -"/settle".length);
      const body = await readBody(req);
      const idempotencyKey = bodyIdempotencyKey(body);
      const reference =
        body && typeof body === "object" && typeof (body as Record<string, unknown>).reference === "string"
          ? (body as Record<string, unknown>).reference as string
          : undefined;
      const view = await runWithExecutionContextAsync(guarded.execution, () =>
        commands.settleCashObligation(guarded.execution, {
          obligationId,
          ...(reference !== undefined ? { reference } : {}),
          idempotencyKey,
        }),
      );
      await send(res, 200, view);
      return true;
    }

    // POST /api/settlement/cash-obligations/:id/reverse — append-only
    // correction (protected).
    if (
      path.startsWith("/api/settlement/cash-obligations/") &&
      path.endsWith("/reverse") &&
      method === "POST" &&
      opts.commands
    ) {
      const commands = opts.commands;
      const guarded = await guardMutation(ctx, req, "cashObligation.reverse", "*", res);
      if (!guarded) return true;
      const obligationId = path.slice("/api/settlement/cash-obligations/".length, -"/reverse".length);
      const body = await readBody(req);
      const input = parseReversalInput(body, obligationId);
      const view = await runWithExecutionContextAsync(guarded.execution, () =>
        commands.reverseCashObligation(guarded.execution, {
          obligationId: input.id,
          reason: input.reason,
          idempotencyKey: input.idempotencyKey,
        }),
      );
      await send(res, 200, view);
      return true;
    }

    // GET /api/settlement/cash-obligations/:id — fetch an obligation
    // (public).
    if (path.startsWith("/api/settlement/cash-obligations/") && method === "GET" && opts.commands) {
      const id = path.slice("/api/settlement/cash-obligations/".length);
      const view = await opts.commands.getCashObligation(ctx, id);
      if (!view) {
        await send(res, 404, { error: "not_found", message: `cash obligation not found: ${id}` });
        return true;
      }
      await send(res, 200, view);
      return true;
    }

    // POST /api/settlement/conversions — record an explicit cash↔credits
    // conversion (protected; the ONLY path between the two concepts).
    if (path === "/api/settlement/conversions" && method === "POST" && opts.commands) {
      const commands = opts.commands;
      const guarded = await guardMutation(ctx, req, "conversion.create", "*", res);
      if (!guarded) return true;
      const body = await readBody(req);
      const input = parseConversionInput(body);
      const result = await runWithExecutionContextAsync(guarded.execution, () =>
        commands.recordConversion(guarded.execution, input),
      );
      await send(res, 201, result);
      return true;
    }

    // GET /api/settlement/conversions — an organization's conversions
    // (public).
    if (path === "/api/settlement/conversions" && method === "GET" && opts.commands) {
      const url = new URL(req.url ?? "/", "http://localhost");
      const organizationScopeId = url.searchParams.get("organizationScopeId");
      if (!organizationScopeId) {
        throw apiValidationError('query parameter "organizationScopeId" is required');
      }
      const views = await opts.commands.listConversions(ctx, organizationScopeId);
      await send(res, 200, { organizationScopeId, conversions: views });
      return true;
    }

    // POST /api/settlement/conversions/:id/reverse — append-only
    // correction (protected).
    if (
      path.startsWith("/api/settlement/conversions/") &&
      path.endsWith("/reverse") &&
      method === "POST" &&
      opts.commands
    ) {
      const commands = opts.commands;
      const guarded = await guardMutation(ctx, req, "conversion.reverse", "*", res);
      if (!guarded) return true;
      const conversionId = path.slice("/api/settlement/conversions/".length, -"/reverse".length);
      const body = await readBody(req);
      const input = parseReversalInput(body, conversionId);
      const view = await runWithExecutionContextAsync(guarded.execution, () =>
        commands.reverseConversion(guarded.execution, {
          conversionId: input.id,
          reason: input.reason,
          idempotencyKey: input.idempotencyKey,
        }),
      );
      await send(res, 200, view);
      return true;
    }

    // GET /api/settlement/conversions/:id — fetch a conversion (public).
    if (path.startsWith("/api/settlement/conversions/") && method === "GET" && opts.commands) {
      const id = path.slice("/api/settlement/conversions/".length);
      const view = await opts.commands.getConversion(ctx, id);
      if (!view) {
        await send(res, 404, { error: "not_found", message: `conversion not found: ${id}` });
        return true;
      }
      await send(res, 200, view);
      return true;
    }

    // GET /api/settlement/ledger/transactions — every ledger transaction
    // for an economic record (public; AUD-003 settlement lineage).
    if (path === "/api/settlement/ledger/transactions" && method === "GET" && opts.commands) {
      const url = new URL(req.url ?? "/", "http://localhost");
      const subjectKind = url.searchParams.get("subjectKind");
      const subjectId = url.searchParams.get("subjectId");
      if (!subjectKind || !subjectId) {
        throw apiValidationError(
          'query parameters "subjectKind" and "subjectId" are required',
        );
      }
      const views = await opts.commands.listLedgerTransactionsBySubject(ctx, subjectKind, subjectId);
      await send(res, 200, { subjectKind, subjectId, transactions: views });
      return true;
    }

    // GET /api/settlement/ledger/transactions/:id — fetch a ledger
    // transaction (public).
    if (
      path.startsWith("/api/settlement/ledger/transactions/") &&
      method === "GET" &&
      opts.commands
    ) {
      const id = path.slice("/api/settlement/ledger/transactions/".length);
      const view = await opts.commands.getLedgerTransaction(ctx, id);
      if (!view) {
        await send(res, 404, { error: "not_found", message: `ledger transaction not found: ${id}` });
        return true;
      }
      await send(res, 200, view);
      return true;
    }

    // GET /api/settlement/ledger/accounts — account balances for an
    // organization (public; balances derived from the immutable entry
    // set).
    if (path === "/api/settlement/ledger/accounts" && method === "GET" && opts.commands) {
      const url = new URL(req.url ?? "/", "http://localhost");
      const organizationScopeId = url.searchParams.get("organizationScopeId");
      if (!organizationScopeId) {
        throw apiValidationError('query parameter "organizationScopeId" is required');
      }
      const views = await opts.commands.listLedgerAccountBalances(ctx, organizationScopeId);
      await send(res, 200, { organizationScopeId, accounts: views });
      return true;
    }

    // GET /api/settlement/participants/:personId/summary — a
    // participant's economic summary (public).
    if (
      path.startsWith("/api/settlement/participants/") &&
      path.endsWith("/summary") &&
      method === "GET" &&
      opts.commands
    ) {
      const personId = path.slice("/api/settlement/participants/".length, -"/summary".length);
      const url = new URL(req.url ?? "/", "http://localhost");
      const organizationScopeId = url.searchParams.get("organizationScopeId");
      if (!organizationScopeId) {
        throw apiValidationError('query parameter "organizationScopeId" is required');
      }
      const view = await opts.commands.getParticipantEconomicSummary(ctx, organizationScopeId, personId);
      await send(res, 200, view);
      return true;
    }

    // ------------------------------------------------------------------
    // NET-W009 fraud/risk foundation (/disputes boundary).
    // ------------------------------------------------------------------

    // POST /api/risk/signals — record a risk signal (protected;
    // provenance + authoritative source-ref gate).
    if (path === "/api/risk/signals" && method === "POST" && opts.commands) {
      const commands = opts.commands;
      const guarded = await guardMutation(ctx, req, "riskSignal.create", "*", res);
      if (!guarded) return true;
      const body = await readBody(req);
      const input = parseRiskSignalInput(body);
      const result = await runWithExecutionContextAsync(guarded.execution, () =>
        commands.createRiskSignal(guarded.execution, guarded.personId, input),
      );
      await send(res, 201, result);
      return true;
    }

    // POST /api/risk/signals/:id/supersede — append a correction
    // (protected; append-only history).
    if (
      path.startsWith("/api/risk/signals/") &&
      path.endsWith("/supersede") &&
      method === "POST" &&
      opts.commands
    ) {
      const commands = opts.commands;
      const guarded = await guardMutation(ctx, req, "riskSignal.supersede", "*", res);
      if (!guarded) return true;
      const signalId = path.slice("/api/risk/signals/".length, -"/supersede".length);
      const body = await readBody(req);
      const input = parseRiskSignalInput(body);
      const view = await runWithExecutionContextAsync(guarded.execution, () =>
        commands.supersedeRiskSignal(guarded.execution, guarded.personId, {
          signalId,
          category: input.category,
          severity: input.severity,
          confidence: input.confidence,
          provenance: input.provenance,
          ...(input.description !== undefined ? { description: input.description } : {}),
          detectedAt: input.detectedAt,
          idempotencyKey: input.idempotencyKey,
        }),
      );
      await send(res, 200, view);
      return true;
    }

    // GET /api/risk/signals — list signals (public; org, optional
    // subject filter).
    if (path === "/api/risk/signals" && method === "GET" && opts.commands) {
      const url = new URL(req.url ?? "/", "http://localhost");
      const organizationScopeId = url.searchParams.get("organizationScopeId");
      if (!organizationScopeId) {
        throw apiValidationError('query parameter "organizationScopeId" is required');
      }
      const subjectPersonId = url.searchParams.get("subjectPersonId") ?? undefined;
      const views = await opts.commands.listRiskSignals(
        ctx,
        organizationScopeId,
        subjectPersonId,
      );
      await send(res, 200, { organizationScopeId, signals: views });
      return true;
    }

    // GET /api/risk/signals/:id — fetch a signal (public).
    if (path.startsWith("/api/risk/signals/") && method === "GET" && opts.commands) {
      const id = path.slice("/api/risk/signals/".length);
      const view = await opts.commands.getRiskSignal(ctx, id);
      if (!view) {
        await send(res, 404, { error: "not_found", message: `risk signal not found: ${id}` });
        return true;
      }
      await send(res, 200, view);
      return true;
    }

    // POST /api/risk/policies — create a policy version (protected;
    // org-independent lineage mutex).
    if (path === "/api/risk/policies" && method === "POST" && opts.commands) {
      const commands = opts.commands;
      const guarded = await guardMutation(ctx, req, "riskPolicy.create", "*", res);
      if (!guarded) return true;
      const body = await readBody(req);
      const obj = requireBodyObject(body);
      const view = await runWithExecutionContextAsync(guarded.execution, () =>
        commands.createRiskPolicy(guarded.execution, guarded.personId, {
          organizationScopeId: strField(obj, "organizationScopeId"),
          policyId: strField(obj, "policyId"),
          version: numField(obj, "version"),
          ...(obj.description !== undefined ? { description: String(obj.description) } : {}),
          rules: objField(obj, "rules"),
          thresholds: objField(obj, "thresholds"),
          criticalFloorState: strField(obj, "criticalFloorState"),
          advisoryOnlyCapState: strField(obj, "advisoryOnlyCapState"),
          requiredCategories: strArrayField(obj, "requiredCategories"),
          missingDataState: strField(obj, "missingDataState"),
        }),
      );
      await send(res, 201, view);
      return true;
    }

    // GET /api/risk/policies/:policyId/versions — a lineage's versions
    // (public; optional org filter).
    if (
      path.startsWith("/api/risk/policies/") &&
      path.endsWith("/versions") &&
      method === "GET" &&
      opts.commands
    ) {
      const policyId = path.slice("/api/risk/policies/".length, -"/versions".length);
      const url = new URL(req.url ?? "/", "http://localhost");
      const organizationScopeId = url.searchParams.get("organizationScopeId") ?? undefined;
      const versions = await opts.commands.listRiskPolicyVersions(
        ctx,
        policyId,
        organizationScopeId,
      );
      await send(res, 200, { policyId, versions });
      return true;
    }

    // POST /api/risk/assessments — record an assessment (protected;
    // the deterministic engine + append-only supersession).
    if (path === "/api/risk/assessments" && method === "POST" && opts.commands) {
      const commands = opts.commands;
      const guarded = await guardMutation(ctx, req, "riskAssessment.create", "*", res);
      if (!guarded) return true;
      const body = await readBody(req);
      const obj = requireBodyObject(body);
      const result = await runWithExecutionContextAsync(guarded.execution, () =>
        commands.recordRiskAssessment(guarded.execution, guarded.personId, {
          organizationScopeId: strField(obj, "organizationScopeId"),
          subjectPersonId: strField(obj, "subjectPersonId"),
          ...(obj.subjectRef !== undefined ? { subjectRef: obj.subjectRef } : {}),
          policyId: strField(obj, "policyId"),
          ...(obj.version !== undefined ? { version: numField(obj, "version") } : {}),
          evaluatedAt: strField(obj, "evaluatedAt"),
          idempotencyKey: strField(obj, "idempotencyKey"),
        }),
      );
      await send(res, 201, result);
      return true;
    }

    // POST /api/risk/assessments/preview — deterministic preview
    // (public read; pure computation, no persist).
    if (path === "/api/risk/assessments/preview" && method === "POST" && opts.commands) {
      const body = await readBody(req);
      const obj = requireBodyObject(body);
      const view = await opts.commands.previewRiskAssessment(ctx, {
        organizationScopeId: strField(obj, "organizationScopeId"),
        subjectPersonId: strField(obj, "subjectPersonId"),
        ...(obj.subjectRef !== undefined ? { subjectRef: obj.subjectRef } : {}),
        policyId: strField(obj, "policyId"),
        ...(obj.version !== undefined ? { version: numField(obj, "version") } : {}),
        evaluatedAt: strField(obj, "evaluatedAt"),
      });
      await send(res, 200, view);
      return true;
    }

    // GET /api/risk/assessments — a subject's assessment history
    // (public).
    if (path === "/api/risk/assessments" && method === "GET" && opts.commands) {
      const url = new URL(req.url ?? "/", "http://localhost");
      const organizationScopeId = url.searchParams.get("organizationScopeId");
      const subjectPersonId = url.searchParams.get("subjectPersonId");
      if (!organizationScopeId || !subjectPersonId) {
        throw apiValidationError(
          'query parameters "organizationScopeId" and "subjectPersonId" are required',
        );
      }
      const views = await opts.commands.listRiskAssessments(
        ctx,
        organizationScopeId,
        subjectPersonId,
      );
      await send(res, 200, { subjectPersonId, assessments: views });
      return true;
    }

    // GET /api/risk/assessments/:id — fetch an assessment (public).
    if (path.startsWith("/api/risk/assessments/") && method === "GET" && opts.commands) {
      const id = path.slice("/api/risk/assessments/".length);
      const view = await opts.commands.getRiskAssessment(ctx, id);
      if (!view) {
        await send(res, 404, { error: "not_found", message: `risk assessment not found: ${id}` });
        return true;
      }
      await send(res, 200, view);
      return true;
    }

    // POST /api/risk/cases — open a review case (protected; ≥1
    // supporting reference).
    if (path === "/api/risk/cases" && method === "POST" && opts.commands) {
      const commands = opts.commands;
      const guarded = await guardMutation(ctx, req, "riskCase.open", "*", res);
      if (!guarded) return true;
      const body = await readBody(req);
      const obj = requireBodyObject(body);
      const result = await runWithExecutionContextAsync(guarded.execution, () =>
        commands.openRiskCase(guarded.execution, guarded.personId, {
          organizationScopeId: strField(obj, "organizationScopeId"),
          ...(obj.subjectPersonId !== undefined
            ? { subjectPersonId: strField(obj, "subjectPersonId") }
            : {}),
          ...(obj.subjectRef !== undefined ? { subjectRef: obj.subjectRef } : {}),
          title: strField(obj, "title"),
          ...(obj.description !== undefined ? { description: String(obj.description) } : {}),
          reasonCodes: strArrayField(obj, "reasonCodes"),
          sourceRefs: objField(obj, "sourceRefs"),
          idempotencyKey: strField(obj, "idempotencyKey"),
        }),
      );
      await send(res, 201, result);
      return true;
    }

    // POST /api/risk/cases/:id/decisions — append a decision
    // (protected; deterministic state machine).
    if (
      path.startsWith("/api/risk/cases/") &&
      path.endsWith("/decisions") &&
      method === "POST" &&
      opts.commands
    ) {
      const commands = opts.commands;
      const guarded = await guardMutation(ctx, req, "riskCase.decide", "*", res);
      if (!guarded) return true;
      const caseId = path.slice("/api/risk/cases/".length, -"/decisions".length);
      const body = await readBody(req);
      const obj = requireBodyObject(body);
      const view = await runWithExecutionContextAsync(guarded.execution, () =>
        commands.recordRiskCaseDecision(guarded.execution, guarded.personId, {
          caseId,
          decision: strField(obj, "decision"),
          reasonCodes: strArrayField(obj, "reasonCodes"),
          ...(obj.note !== undefined ? { note: String(obj.note) } : {}),
          sourceRefs: objField(obj, "sourceRefs"),
          idempotencyKey: strField(obj, "idempotencyKey"),
        }),
      );
      await send(res, 200, view);
      return true;
    }

    // GET /api/risk/cases — an org's cases (public; optional state
    // filter).
    if (path === "/api/risk/cases" && method === "GET" && opts.commands) {
      const url = new URL(req.url ?? "/", "http://localhost");
      const organizationScopeId = url.searchParams.get("organizationScopeId");
      if (!organizationScopeId) {
        throw apiValidationError('query parameter "organizationScopeId" is required');
      }
      const stateParam = url.searchParams.get("state");
      const states = stateParam !== null ? stateParam.split(",").map((x) => x.trim()) : undefined;
      const views = await opts.commands.listRiskCases(ctx, organizationScopeId, states);
      await send(res, 200, { organizationScopeId, cases: views });
      return true;
    }

    // GET /api/risk/cases/:id — fetch a case with its decision history
    // (public).
    if (path.startsWith("/api/risk/cases/") && method === "GET" && opts.commands) {
      const id = path.slice("/api/risk/cases/".length);
      const view = await opts.commands.getRiskCase(ctx, id);
      if (!view) {
        await send(res, 404, { error: "not_found", message: `risk case not found: ${id}` });
        return true;
      }
      await send(res, 200, view);
      return true;
    }

    // POST /api/risk/controls — activate a control (protected;
    // evidence-backed origin gate).
    if (path === "/api/risk/controls" && method === "POST" && opts.commands) {
      const commands = opts.commands;
      const guarded = await guardMutation(ctx, req, "riskControl.activate", "*", res);
      if (!guarded) return true;
      const body = await readBody(req);
      const obj = requireBodyObject(body);
      const result = await runWithExecutionContextAsync(guarded.execution, () =>
        commands.activateRiskControl(guarded.execution, guarded.personId, {
          organizationScopeId: strField(obj, "organizationScopeId"),
          operationClass: strField(obj, "operationClass"),
          action: strField(obj, "action"),
          ...(obj.subjectPersonId !== undefined
            ? { subjectPersonId: strField(obj, "subjectPersonId") }
            : {}),
          ...(obj.subjectRef !== undefined ? { subjectRef: obj.subjectRef } : {}),
          ...(obj.originAssessmentId !== undefined
            ? { originAssessmentId: strField(obj, "originAssessmentId") }
            : {}),
          ...(obj.originCaseId !== undefined
            ? { originCaseId: strField(obj, "originCaseId") }
            : {}),
          reasonCodes: strArrayField(obj, "reasonCodes"),
          ...(obj.description !== undefined ? { description: String(obj.description) } : {}),
          idempotencyKey: strField(obj, "idempotencyKey"),
        }),
      );
      await send(res, 201, result);
      return true;
    }

    // POST /api/risk/controls/:id/resolve — resolve a control
    // (protected).
    if (
      path.startsWith("/api/risk/controls/") &&
      path.endsWith("/resolve") &&
      method === "POST" &&
      opts.commands
    ) {
      const commands = opts.commands;
      const guarded = await guardMutation(ctx, req, "riskControl.resolve", "*", res);
      if (!guarded) return true;
      const controlDecisionId = path.slice("/api/risk/controls/".length, -"/resolve".length);
      const body = await readBody(req);
      const obj = requireBodyObject(body);
      const view = await runWithExecutionContextAsync(guarded.execution, () =>
        commands.resolveRiskControl(guarded.execution, guarded.personId, {
          controlDecisionId,
          ...(obj.caseDecisionId !== undefined
            ? { caseDecisionId: strField(obj, "caseDecisionId") }
            : {}),
          ...(obj.note !== undefined ? { note: String(obj.note) } : {}),
          idempotencyKey: strField(obj, "idempotencyKey"),
        }),
      );
      await send(res, 200, view);
      return true;
    }

    // GET /api/risk/controls — an org's controls (public; optional
    // state filter).
    if (path === "/api/risk/controls" && method === "GET" && opts.commands) {
      const url = new URL(req.url ?? "/", "http://localhost");
      const organizationScopeId = url.searchParams.get("organizationScopeId");
      if (!organizationScopeId) {
        throw apiValidationError('query parameter "organizationScopeId" is required');
      }
      const stateParam = url.searchParams.get("state");
      const states = stateParam !== null ? stateParam.split(",").map((x) => x.trim()) : undefined;
      const views = await opts.commands.listRiskControls(ctx, organizationScopeId, states);
      await send(res, 200, { organizationScopeId, controls: views });
      return true;
    }

    // GET /api/risk/controls/:id — fetch a control (public).
    if (path.startsWith("/api/risk/controls/") && method === "GET" && opts.commands) {
      const id = path.slice("/api/risk/controls/".length);
      const view = await opts.commands.getRiskControl(ctx, id);
      if (!view) {
        await send(res, 404, { error: "not_found", message: `risk control decision not found: ${id}` });
        return true;
      }
      await send(res, 200, view);
      return true;
    }

    // GET /api/risk/subjects/:personId/summary — a subject's risk
    // summary (public).
    if (
      path.startsWith("/api/risk/subjects/") &&
      path.endsWith("/summary") &&
      method === "GET" &&
      opts.commands
    ) {
      const personId = path.slice("/api/risk/subjects/".length, -"/summary".length);
      const url = new URL(req.url ?? "/", "http://localhost");
      const organizationScopeId = url.searchParams.get("organizationScopeId");
      if (!organizationScopeId) {
        throw apiValidationError('query parameter "organizationScopeId" is required');
      }
      const view = await opts.commands.getRiskSubjectSummary(ctx, organizationScopeId, personId);
      await send(res, 200, view);
      return true;
    }

    // POST /api/risk/workflow-holds — apply a workflow hold
    // (protected; records the control + requests the FRAUD_REVIEW
    // transition through the workflow service — the sole lifecycle
    // authority).
    if (path === "/api/risk/workflow-holds" && method === "POST" && opts.commands) {
      const commands = opts.commands;
      const guarded = await guardMutation(ctx, req, "riskWorkflowHold.apply", "*", res);
      if (!guarded) return true;
      const body = await readBody(req);
      const obj = requireBodyObject(body);
      const result = await runWithExecutionContextAsync(guarded.execution, () =>
        commands.applyWorkflowHold(guarded.execution, guarded.personId, {
          contributionId: strField(obj, "contributionId"),
          ...(obj.originCaseId !== undefined
            ? { originCaseId: strField(obj, "originCaseId") }
            : {}),
          ...(obj.originAssessmentId !== undefined
            ? { originAssessmentId: strField(obj, "originAssessmentId") }
            : {}),
          ...(obj.reasonCodes !== undefined
            ? { reasonCodes: strArrayField(obj, "reasonCodes") }
            : {}),
          ...(obj.description !== undefined ? { description: String(obj.description) } : {}),
          idempotencyKey: strField(obj, "idempotencyKey"),
        }),
      );
      await send(res, 201, result);
      return true;
    }

    // POST /api/risk/workflow-holds/:contributionId/clear — clear a
    // workflow hold (protected; resolves the control + requests the
    // cleared return transition through the workflow service).
    if (
      path.startsWith("/api/risk/workflow-holds/") &&
      path.endsWith("/clear") &&
      method === "POST" &&
      opts.commands
    ) {
      const commands = opts.commands;
      const guarded = await guardMutation(ctx, req, "riskWorkflowHold.clear", "*", res);
      if (!guarded) return true;
      const contributionId = path.slice(
        "/api/risk/workflow-holds/".length,
        -"/clear".length,
      );
      const body = await readBody(req);
      const obj = requireBodyObject(body);
      const result = await runWithExecutionContextAsync(guarded.execution, () =>
        commands.clearWorkflowHold(guarded.execution, guarded.personId, {
          contributionId,
          controlDecisionId: strField(obj, "controlDecisionId"),
          ...(obj.note !== undefined ? { note: String(obj.note) } : {}),
          idempotencyKey: strField(obj, "idempotencyKey"),
        }),
      );
      await send(res, 200, result);
      return true;
    }

    // ------------------------------------------------------------------
    // NET-W010 challenges/disputes/appeals (/disputes boundary).
    // ------------------------------------------------------------------

    // POST /api/disputes — open a dispute (the challenge request;
    // protected; deterministic eligibility gate; PENDING_STAKE).
    if (path === "/api/disputes" && method === "POST" && opts.commands) {
      const commands = opts.commands;
      const guarded = await guardMutation(ctx, req, "dispute.open", "*", res);
      if (!guarded) return true;
      const body = await readBody(req);
      const obj = requireBodyObject(body);
      const result = await runWithExecutionContextAsync(guarded.execution, () =>
        commands.openDispute(guarded.execution, guarded.personId, {
          organizationScopeId: strField(obj, "organizationScopeId"),
          subjectRef: objField(obj, "subjectRef"),
          statement: strField(obj, "statement"),
          reasonCodes: strArrayField(obj, "reasonCodes"),
          supportingRefs: objField(obj, "supportingRefs"),
          effectiveAt: strField(obj, "effectiveAt"),
          idempotencyKey: strField(obj, "idempotencyKey"),
        }),
      );
      await send(res, 201, result);
      return true;
    }

    // POST /api/disputes/:id/bond — bond the challenge stake
    // (protected; commits the stake through the settlement authority
    // and makes the dispute formal/OPEN).
    if (
      path.startsWith("/api/disputes/") &&
      path.endsWith("/bond") &&
      method === "POST" &&
      opts.commands
    ) {
      const commands = opts.commands;
      const guarded = await guardMutation(ctx, req, "dispute.bond", "*", res);
      if (!guarded) return true;
      const disputeId = path.slice("/api/disputes/".length, -"/bond".length);
      const body = await readBody(req);
      const obj = requireBodyObject(body);
      const result = await runWithExecutionContextAsync(guarded.execution, () =>
        commands.bondDisputeStake(guarded.execution, guarded.personId, {
          disputeId,
          idempotencyKey: strField(obj, "idempotencyKey"),
        }),
      );
      await send(res, 200, result);
      return true;
    }

    // POST /api/disputes/:id/review — start the review (protected;
    // conflict-of-interest gate bars the challenger + the subject
    // beneficiary).
    if (
      path.startsWith("/api/disputes/") &&
      path.endsWith("/review") &&
      method === "POST" &&
      opts.commands
    ) {
      const commands = opts.commands;
      const guarded = await guardMutation(ctx, req, "dispute.review", "*", res);
      if (!guarded) return true;
      const disputeId = path.slice("/api/disputes/".length, -"/review".length);
      const body = await readBody(req);
      const obj = requireBodyObject(body);
      const view = await runWithExecutionContextAsync(guarded.execution, () =>
        commands.startDisputeReview(guarded.execution, guarded.personId, {
          disputeId,
          ...(obj.reasonCodes !== undefined
            ? { reasonCodes: strArrayField(obj, "reasonCodes") }
            : {}),
          ...(obj.note !== undefined ? { note: String(obj.note) } : {}),
          idempotencyKey: strField(obj, "idempotencyKey"),
        }),
      );
      await send(res, 200, view);
      return true;
    }

    // POST /api/disputes/:id/reject — reject as inadmissible
    // (protected; releases the stake through the settlement authority).
    if (
      path.startsWith("/api/disputes/") &&
      path.endsWith("/reject") &&
      method === "POST" &&
      opts.commands
    ) {
      const commands = opts.commands;
      const guarded = await guardMutation(ctx, req, "dispute.reject", "*", res);
      if (!guarded) return true;
      const disputeId = path.slice("/api/disputes/".length, -"/reject".length);
      const body = await readBody(req);
      const obj = requireBodyObject(body);
      const result = await runWithExecutionContextAsync(guarded.execution, () =>
        commands.rejectDispute(guarded.execution, guarded.personId, {
          disputeId,
          reasonCodes: strArrayField(obj, "reasonCodes"),
          ...(obj.note !== undefined ? { note: String(obj.note) } : {}),
          sourceRefs: objField(obj, "sourceRefs"),
          idempotencyKey: strField(obj, "idempotencyKey"),
        }),
      );
      await send(res, 200, result);
      return true;
    }

    // POST /api/disputes/:id/resolve — resolve on the merits
    // (protected; records outcome + control disposition + the
    // deterministic stake mapping, then executes the stake consequence
    // through the settlement authority).
    if (
      path.startsWith("/api/disputes/") &&
      path.endsWith("/resolve") &&
      method === "POST" &&
      opts.commands
    ) {
      const commands = opts.commands;
      const guarded = await guardMutation(ctx, req, "dispute.resolve", "*", res);
      if (!guarded) return true;
      const disputeId = path.slice("/api/disputes/".length, -"/resolve".length);
      const body = await readBody(req);
      const obj = requireBodyObject(body);
      const result = await runWithExecutionContextAsync(guarded.execution, () =>
        commands.resolveDispute(guarded.execution, guarded.personId, {
          disputeId,
          outcome: strField(obj, "outcome"),
          controlDisposition: strField(obj, "controlDisposition"),
          reasonCodes: strArrayField(obj, "reasonCodes"),
          ...(obj.note !== undefined ? { note: String(obj.note) } : {}),
          sourceRefs: objField(obj, "sourceRefs"),
          idempotencyKey: strField(obj, "idempotencyKey"),
        }),
      );
      await send(res, 200, result);
      return true;
    }

    // POST /api/disputes/:id/appeal — appeal the resolved outcome
    // (protected; NEW linked record; the original flips to APPEALED).
    if (
      path.startsWith("/api/disputes/") &&
      path.endsWith("/appeal") &&
      method === "POST" &&
      opts.commands
    ) {
      const commands = opts.commands;
      const guarded = await guardMutation(ctx, req, "dispute.appeal", "*", res);
      if (!guarded) return true;
      const disputeId = path.slice("/api/disputes/".length, -"/appeal".length);
      const body = await readBody(req);
      const obj = requireBodyObject(body);
      const result = await runWithExecutionContextAsync(guarded.execution, () =>
        commands.appealDispute(guarded.execution, guarded.personId, {
          disputeId,
          statement: strField(obj, "statement"),
          reasonCodes: strArrayField(obj, "reasonCodes"),
          supportingRefs: objField(obj, "supportingRefs"),
          effectiveAt: strField(obj, "effectiveAt"),
          idempotencyKey: strField(obj, "idempotencyKey"),
        }),
      );
      await send(res, 201, result);
      return true;
    }

    // POST /api/disputes/:id/withdraw — the challenger withdraws
    // (protected; releases the bonded stake through the settlement
    // authority).
    if (
      path.startsWith("/api/disputes/") &&
      path.endsWith("/withdraw") &&
      method === "POST" &&
      opts.commands
    ) {
      const commands = opts.commands;
      const guarded = await guardMutation(ctx, req, "dispute.withdraw", "*", res);
      if (!guarded) return true;
      const disputeId = path.slice("/api/disputes/".length, -"/withdraw".length);
      const body = await readBody(req);
      const obj = requireBodyObject(body);
      const result = await runWithExecutionContextAsync(guarded.execution, () =>
        commands.withdrawDispute(guarded.execution, guarded.personId, {
          disputeId,
          ...(obj.reason !== undefined ? { reason: String(obj.reason) } : {}),
          idempotencyKey: strField(obj, "idempotencyKey"),
        }),
      );
      await send(res, 200, result);
      return true;
    }

    // GET /api/disputes — an org's disputes (public; optional state
    // filter).
    if (path === "/api/disputes" && method === "GET" && opts.commands) {
      const url = new URL(req.url ?? "/", "http://localhost");
      const organizationScopeId = url.searchParams.get("organizationScopeId");
      if (!organizationScopeId) {
        throw apiValidationError('query parameter "organizationScopeId" is required');
      }
      const stateParam = url.searchParams.get("state");
      const states = stateParam !== null ? stateParam.split(",").map((x) => x.trim()) : undefined;
      const views = await opts.commands.listDisputes(ctx, organizationScopeId, states);
      await send(res, 200, { organizationScopeId, disputes: views });
      return true;
    }

    // GET /api/disputes/:id — fetch a dispute with its immutable
    // event history (public).
    if (path.startsWith("/api/disputes/") && method === "GET" && opts.commands) {
      const id = path.slice("/api/disputes/".length);
      const view = await opts.commands.getDispute(ctx, id);
      if (!view) {
        await send(res, 404, { error: "not_found", message: `dispute not found: ${id}` });
        return true;
      }
      await send(res, 200, view);
      return true;
    }

    // GET /api/stakes/:id — fetch a stake record from the settlement
    // authority (public read; the escrow's authoritative state).
    if (path.startsWith("/api/stakes/") && method === "GET" && opts.commands) {
      const id = path.slice("/api/stakes/".length);
      const view = await opts.commands.getStake(ctx, id);
      if (!view) {
        await send(res, 404, { error: "not_found", message: `stake not found: ${id}` });
        return true;
      }
      await send(res, 200, view);
      return true;
    }

    // -- NET-W011 campaign routes --------------------------------------

    // POST /api/campaigns — create a campaign (protected; the person
    // actor becomes the owner; DRAFT).
    if (path === "/api/campaigns" && method === "POST" && opts.commands) {
      const commands = opts.commands;
      const guarded = await guardMutation(ctx, req, "campaign.create", "*", res);
      if (!guarded) return true;
      const body = await readBody(req);
      const obj = requireBodyObject(body);
      const result = await runWithExecutionContextAsync(guarded.execution, () =>
        commands.createCampaign(guarded.execution, guarded.personId, {
          organizationScopeId: strField(obj, "organizationScopeId"),
          name: strField(obj, "name"),
          ...(obj.description !== undefined ? { description: String(obj.description) } : {}),
          idempotencyKey: strField(obj, "idempotencyKey"),
        }),
      );
      await send(res, 201, result);
      return true;
    }

    // POST /api/campaigns/:id/policy — define the next immutable
    // policy version (protected; owner-only).
    if (
      path.startsWith("/api/campaigns/") &&
      path.endsWith("/policy") &&
      method === "POST" &&
      opts.commands
    ) {
      const commands = opts.commands;
      const guarded = await guardMutation(ctx, req, "campaign.policy", "*", res);
      if (!guarded) return true;
      const campaignId = path.slice("/api/campaigns/".length, -"/policy".length);
      const body = await readBody(req);
      const obj = requireBodyObject(body);
      const result = await runWithExecutionContextAsync(guarded.execution, () =>
        commands.defineCampaignPolicy(guarded.execution, guarded.personId, {
          campaignId,
          policy: objField(obj, "policy"),
          idempotencyKey: strField(obj, "idempotencyKey"),
        }),
      );
      await send(res, 201, result);
      return true;
    }

    // POST /api/campaigns/:id/activate|pause|resume|complete|cancel —
    // the administrative status machine (protected; owner-only).
    for (const [suffix, action] of [
      ["activate", "campaign.activate"],
      ["pause", "campaign.pause"],
      ["resume", "campaign.resume"],
      ["complete", "campaign.complete"],
      ["cancel", "campaign.cancel"],
    ] as const) {
      if (
        path.startsWith("/api/campaigns/") &&
        path.endsWith(`/${suffix}`) &&
        method === "POST" &&
        opts.commands
      ) {
        const commands = opts.commands;
        const guarded = await guardMutation(ctx, req, action, "*", res);
        if (!guarded) return true;
        const campaignId = path.slice(
          "/api/campaigns/".length,
          -`/${suffix}`.length,
        );
        const body = await readBody(req);
        const obj = requireBodyObject(body);
        const view = await runWithExecutionContextAsync(guarded.execution, () =>
          suffix === "activate"
            ? commands.activateCampaign(guarded.execution, guarded.personId, {
                campaignId,
                ...(obj.reason !== undefined ? { reason: String(obj.reason) } : {}),
                idempotencyKey: strField(obj, "idempotencyKey"),
              })
            : suffix === "pause"
              ? commands.pauseCampaign(guarded.execution, guarded.personId, {
                  campaignId,
                  ...(obj.reason !== undefined ? { reason: String(obj.reason) } : {}),
                  idempotencyKey: strField(obj, "idempotencyKey"),
                })
              : suffix === "resume"
                ? commands.resumeCampaign(guarded.execution, guarded.personId, {
                    campaignId,
                    ...(obj.reason !== undefined ? { reason: String(obj.reason) } : {}),
                    idempotencyKey: strField(obj, "idempotencyKey"),
                  })
                : suffix === "complete"
                  ? commands.completeCampaign(guarded.execution, guarded.personId, {
                      campaignId,
                      ...(obj.reason !== undefined ? { reason: String(obj.reason) } : {}),
                      idempotencyKey: strField(obj, "idempotencyKey"),
                    })
                  : commands.cancelCampaign(guarded.execution, guarded.personId, {
                      campaignId,
                      ...(obj.reason !== undefined ? { reason: String(obj.reason) } : {}),
                      idempotencyKey: strField(obj, "idempotencyKey"),
                    }),
        );
        await send(res, 200, view);
        return true;
      }
    }

    // POST /api/campaigns/:id/budget — commit the declared budget
    // through the settlement authority's escrow (protected;
    // owner-only).
    if (
      path.startsWith("/api/campaigns/") &&
      path.endsWith("/budget") &&
      !path.endsWith("/budget/release") &&
      method === "POST" &&
      opts.commands
    ) {
      const commands = opts.commands;
      const guarded = await guardMutation(ctx, req, "campaign.budget.commit", "*", res);
      if (!guarded) return true;
      const campaignId = path.slice("/api/campaigns/".length, -"/budget".length);
      const body = await readBody(req);
      const obj = requireBodyObject(body);
      const result = await runWithExecutionContextAsync(guarded.execution, () =>
        commands.commitCampaignBudget(guarded.execution, guarded.personId, {
          campaignId,
          idempotencyKey: strField(obj, "idempotencyKey"),
        }),
      );
      await send(res, 200, result);
      return true;
    }

    // POST /api/campaigns/:id/budget/release — release the escrow
    // after a terminal status (protected; owner-only).
    if (
      path.startsWith("/api/campaigns/") &&
      path.endsWith("/budget/release") &&
      method === "POST" &&
      opts.commands
    ) {
      const commands = opts.commands;
      const guarded = await guardMutation(ctx, req, "campaign.budget.release", "*", res);
      if (!guarded) return true;
      const campaignId = path.slice(
        "/api/campaigns/".length,
        -"/budget/release".length,
      );
      const body = await readBody(req);
      const obj = requireBodyObject(body);
      const result = await runWithExecutionContextAsync(guarded.execution, () =>
        commands.releaseCampaignBudget(guarded.execution, guarded.personId, {
          campaignId,
          idempotencyKey: strField(obj, "idempotencyKey"),
        }),
      );
      await send(res, 200, result);
      return true;
    }

    // POST /api/campaigns/:id/opportunities — publish a contribution
    // opportunity from a policy spec (protected; owner-only; ACTIVE;
    // composed through the opportunities boundary — lifecycle stays
    // with /workflows).
    if (
      path.startsWith("/api/campaigns/") &&
      path.endsWith("/opportunities") &&
      method === "POST" &&
      opts.commands
    ) {
      const commands = opts.commands;
      const guarded = await guardMutation(ctx, req, "campaign.opportunity.publish", "*", res);
      if (!guarded) return true;
      const campaignId = path.slice(
        "/api/campaigns/".length,
        -"/opportunities".length,
      );
      const body = await readBody(req);
      const obj = requireBodyObject(body);
      const result = await runWithExecutionContextAsync(guarded.execution, () =>
        commands.publishCampaignOpportunity(guarded.execution, guarded.personId, {
          campaignId,
          specId: strField(obj, "specId"),
          idempotencyKey: strField(obj, "idempotencyKey"),
        }),
      );
      await send(res, 201, result);
      return true;
    }

    // GET /api/campaigns — an org's campaigns (public; optional status
    // filter).
    if (path === "/api/campaigns" && method === "GET" && opts.commands) {
      const url = new URL(req.url ?? "/", "http://localhost");
      const organizationScopeId = url.searchParams.get("organizationScopeId");
      if (!organizationScopeId) {
        throw apiValidationError('query parameter "organizationScopeId" is required');
      }
      const statusParam = url.searchParams.get("status");
      const statuses =
        statusParam !== null ? statusParam.split(",").map((x) => x.trim()) : undefined;
      const views = await opts.commands.listCampaigns(ctx, organizationScopeId, statuses);
      await send(res, 200, { organizationScopeId, campaigns: views });
      return true;
    }

    // ------------------------------------------------------------------
    // NET-W021 — Campaign matching and optimization routes (the
    // creators/matching precedent). Selection, not authority: the
    // guarded run command writes ONLY the append-only run record +
    // its audit event.
    // ------------------------------------------------------------------

    // POST /api/campaigns/matching — run a campaign match (protected;
    // guard action campaigns.matching.run).
    if (path === "/api/campaigns/matching" && method === "POST" && opts.commands) {
      const commands = opts.commands;
      const guarded = await guardMutation(ctx, req, "campaigns.matching.run", "*", res);
      if (!guarded) return true;
      const body = await readBody(req);
      const obj = requireBodyObject(body);
      const targeting = obj.targeting as Record<string, unknown> | undefined | null;
      const advisory = obj.advisory as Record<string, unknown> | undefined | null;
      const advisoryMatching = advisory?.matching as Record<string, unknown> | undefined | null;
      const advisoryRisk = advisory?.risk as Record<string, unknown> | undefined | null;
      const result = await runWithExecutionContextAsync(guarded.execution, () =>
        commands.runCampaignMatch(guarded.execution, guarded.personId, {
          organizationScopeId: strField(obj, "organizationScopeId"),
          campaignId: strField(obj, "campaignId"),
          ...(obj.policyVersion !== undefined && obj.policyVersion !== null
            ? { policyVersion: obj.policyVersion }
            : {}),
          ...(targeting !== null && targeting !== undefined
            ? {
                targeting: {
                  ...(targeting.requiredFormats !== undefined
                    ? { requiredFormats: targeting.requiredFormats }
                    : {}),
                  ...(targeting.requiredSurfaceKinds !== undefined
                    ? { requiredSurfaceKinds: targeting.requiredSurfaceKinds }
                    : {}),
                  ...(targeting.targetTerritories !== undefined
                    ? { targetTerritories: targeting.targetTerritories }
                    : {}),
                  ...(targeting.requiredLanguages !== undefined
                    ? { requiredLanguages: targeting.requiredLanguages }
                    : {}),
                },
              }
            : {}),
          ...(obj.candidateInventoryItemIds !== undefined
            ? { candidateInventoryItemIds: obj.candidateInventoryItemIds }
            : {}),
          ...(obj.weights !== undefined && obj.weights !== null
            ? { weights: obj.weights }
            : {}),
          ...(advisory !== null && advisory !== undefined
            ? {
                advisory: {
                  ...(advisoryMatching !== null && advisoryMatching !== undefined
                    ? {
                        matching: {
                          ...(advisoryMatching.enabled !== undefined
                            ? { enabled: advisoryMatching.enabled }
                            : {}),
                          ...(advisoryMatching.maxWeight !== undefined
                            ? { maxWeight: advisoryMatching.maxWeight }
                            : {}),
                        },
                      }
                    : {}),
                  ...(advisoryRisk !== null && advisoryRisk !== undefined
                    ? {
                        risk: {
                          ...(advisoryRisk.enabled !== undefined
                            ? { enabled: advisoryRisk.enabled }
                            : {}),
                          ...(advisoryRisk.maxWeight !== undefined
                            ? { maxWeight: advisoryRisk.maxWeight }
                            : {}),
                        },
                      }
                    : {}),
                },
              }
            : {}),
          idempotencyKey: strField(obj, "idempotencyKey"),
        }),
      );
      await send(res, 201, result);
      return true;
    }

    // GET /api/campaigns/matching — an org's campaign match runs,
    // optionally narrowed by campaign (public; tenant-scoped).
    if (path === "/api/campaigns/matching" && method === "GET" && opts.commands) {
      const url = new URL(req.url ?? "/", "http://localhost");
      const organizationScopeId = url.searchParams.get("organizationScopeId");
      if (!organizationScopeId) {
        throw apiValidationError('query parameter "organizationScopeId" is required');
      }
      const campaignId = url.searchParams.get("campaignId") ?? undefined;
      const views = await opts.commands.listCampaignMatchRuns(
        ctx,
        organizationScopeId,
        campaignId,
      );
      await send(res, 200, { organizationScopeId, runs: views });
      return true;
    }

    // GET /api/campaigns/matching/:id — one campaign match run
    // (public; tenant-scoped; a cross-scope run id is not found).
    if (
      path.startsWith("/api/campaigns/matching/") &&
      method === "GET" &&
      opts.commands
    ) {
      const id = path.slice("/api/campaigns/matching/".length);
      const url = new URL(req.url ?? "/", "http://localhost");
      const organizationScopeId = url.searchParams.get("organizationScopeId");
      if (!organizationScopeId) {
        throw apiValidationError('query parameter "organizationScopeId" is required');
      }
      // A cross-scope or nonexistent run id throws NotFoundError —
      // the global handler maps the not_found classification to 404.
      const view = await opts.commands.getCampaignMatchRun(
        ctx,
        organizationScopeId,
        id,
      );
      await send(res, 200, view);
      return true;
    }

    // GET /api/campaigns/:id/policies — the immutable policy versions
    // (public).
    if (
      path.startsWith("/api/campaigns/") &&
      path.endsWith("/policies") &&
      method === "GET" &&
      opts.commands
    ) {
      const campaignId = path.slice("/api/campaigns/".length, -"/policies".length);
      const views = await opts.commands.listCampaignPolicies(ctx, campaignId);
      await send(res, 200, { campaignId, policies: views });
      return true;
    }

    // GET /api/campaigns/:id/opportunities — the published
    // opportunities derived from the append-only history (public).
    if (
      path.startsWith("/api/campaigns/") &&
      path.endsWith("/opportunities") &&
      method === "GET" &&
      opts.commands
    ) {
      const campaignId = path.slice(
        "/api/campaigns/".length,
        -"/opportunities".length,
      );
      const views = await opts.commands.listCampaignOpportunities(ctx, campaignId);
      await send(res, 200, { campaignId, opportunities: views });
      return true;
    }

    // GET /api/campaigns/:id — fetch a campaign with its immutable
    // event history (public).
    if (path.startsWith("/api/campaigns/") && method === "GET" && opts.commands) {
      const id = path.slice("/api/campaigns/".length);
      const view = await opts.commands.getCampaign(ctx, id);
      if (!view) {
        await send(res, 404, { error: "not_found", message: `campaign not found: ${id}` });
        return true;
      }
      await send(res, 200, view);
      return true;
    }

    // ------------------------------------------------------------------
    // NET-W015 — creator identity and preferences.
    // ------------------------------------------------------------------

    // POST /api/creators — create a creator profile anchored to the
    // acting person's canonical identity (protected; self-anchored;
    // unique per person per organization scope).
    if (path === "/api/creators" && method === "POST" && opts.commands) {
      const commands = opts.commands;
      const guarded = await guardMutation(ctx, req, "creators.profile.create", "*", res);
      if (!guarded) return true;
      const body = await readBody(req);
      const obj = requireBodyObject(body);
      const result = await runWithExecutionContextAsync(guarded.execution, () =>
        commands.createCreatorProfile(guarded.execution, guarded.personId, {
          organizationScopeId: strField(obj, "organizationScopeId"),
          creatorPersonId: strField(obj, "creatorPersonId"),
          displayName: strField(obj, "displayName"),
          idempotencyKey: strField(obj, "idempotencyKey"),
        }),
      );
      await send(res, 201, result);
      return true;
    }

    // POST /api/creators/:id/versions — define the next immutable
    // profile version (protected; owner-only).
    if (
      path.startsWith("/api/creators/") &&
      path.endsWith("/versions") &&
      method === "POST" &&
      opts.commands
    ) {
      const commands = opts.commands;
      const guarded = await guardMutation(ctx, req, "creators.version.define", "*", res);
      if (!guarded) return true;
      const profileId = path.slice("/api/creators/".length, -"/versions".length);
      const body = await readBody(req);
      const obj = requireBodyObject(body);
      const result = await runWithExecutionContextAsync(guarded.execution, () =>
        commands.defineCreatorProfileVersion(guarded.execution, guarded.personId, {
          profileId,
          sections: objField(obj, "sections"),
          idempotencyKey: strField(obj, "idempotencyKey"),
        }),
      );
      await send(res, 201, result);
      return true;
    }

    // POST /api/creators/:id/activate|pause|resume|archive — the
    // administrative status machine (protected; owner-only).
    for (const [suffix, action] of [
      ["activate", "creators.status.activate"],
      ["pause", "creators.status.pause"],
      ["resume", "creators.status.resume"],
      ["archive", "creators.status.archive"],
    ] as const) {
      if (
        path.startsWith("/api/creators/") &&
        path.endsWith(`/${suffix}`) &&
        method === "POST" &&
        opts.commands
      ) {
        const commands = opts.commands;
        const guarded = await guardMutation(ctx, req, action, "*", res);
        if (!guarded) return true;
        const profileId = path.slice(
          "/api/creators/".length,
          -`/${suffix}`.length,
        );
        const body = await readBody(req);
        const obj = requireBodyObject(body);
        const view = await runWithExecutionContextAsync(guarded.execution, () =>
          suffix === "activate"
            ? commands.activateCreatorProfile(guarded.execution, guarded.personId, {
                profileId,
                ...(obj.reason !== undefined ? { reason: String(obj.reason) } : {}),
                idempotencyKey: strField(obj, "idempotencyKey"),
              })
            : suffix === "pause"
              ? commands.pauseCreatorProfile(guarded.execution, guarded.personId, {
                  profileId,
                  ...(obj.reason !== undefined ? { reason: String(obj.reason) } : {}),
                  idempotencyKey: strField(obj, "idempotencyKey"),
                })
              : suffix === "resume"
                ? commands.resumeCreatorProfile(guarded.execution, guarded.personId, {
                    profileId,
                    ...(obj.reason !== undefined ? { reason: String(obj.reason) } : {}),
                    idempotencyKey: strField(obj, "idempotencyKey"),
                  })
                : commands.archiveCreatorProfile(guarded.execution, guarded.personId, {
                    profileId,
                    ...(obj.reason !== undefined ? { reason: String(obj.reason) } : {}),
                    idempotencyKey: strField(obj, "idempotencyKey"),
                  }),
        );
        await send(res, 200, view);
        return true;
      }
    }

    // GET /api/creators — an org's creator profiles (public; optional
    // status filter).
    if (path === "/api/creators" && method === "GET" && opts.commands) {
      const url = new URL(req.url ?? "/", "http://localhost");
      const organizationScopeId = url.searchParams.get("organizationScopeId");
      if (!organizationScopeId) {
        throw apiValidationError('query parameter "organizationScopeId" is required');
      }
      const statusParam = url.searchParams.get("status");
      const statuses =
        statusParam !== null ? statusParam.split(",").map((x) => x.trim()) : undefined;
      const views = await opts.commands.listCreatorProfiles(ctx, organizationScopeId, statuses);
      await send(res, 200, { organizationScopeId, creators: views });
      return true;
    }

    // ------------------------------------------------------------------
    // NET-W016 — creator matching (deterministic eligibility +
    // explicit-signal ranking; matching is SELECTION, not authority).
    // ------------------------------------------------------------------

    // POST /api/creators/matching — run a creator match (protected;
    // guard action creators.matching.run; idempotent).
    if (path === "/api/creators/matching" && method === "POST" && opts.commands) {
      const commands = opts.commands;
      const guarded = await guardMutation(ctx, req, "creators.matching.run", "*", res);
      if (!guarded) return true;
      const body = await readBody(req);
      const obj = requireBodyObject(body);
      const campaign = obj.campaign as
        | { campaignId?: unknown; policyVersion?: unknown }
        | undefined
        | null;
      const advisory = obj.advisory as
        | { enabled?: unknown; maxWeight?: unknown }
        | undefined
        | null;
      const result = await runWithExecutionContextAsync(guarded.execution, () =>
        commands.runCreatorMatch(guarded.execution, guarded.personId, {
          organizationScopeId: strField(obj, "organizationScopeId"),
          ...(campaign !== null && campaign !== undefined
            ? {
                campaign: {
                  campaignId: campaign.campaignId,
                  ...(campaign.policyVersion !== undefined
                    ? { policyVersion: campaign.policyVersion }
                    : {}),
                },
              }
            : {}),
          requirements: objField(obj, "requirements"),
          ...(obj.candidateProfileIds !== undefined
            ? { candidateProfileIds: obj.candidateProfileIds }
            : {}),
          ...(obj.weights !== undefined && obj.weights !== null
            ? { weights: obj.weights }
            : {}),
          ...(advisory !== null && advisory !== undefined
            ? {
                advisory: {
                  enabled: advisory.enabled === true,
                  ...(advisory.maxWeight !== undefined
                    ? { maxWeight: advisory.maxWeight }
                    : {}),
                },
              }
            : {}),
          idempotencyKey: strField(obj, "idempotencyKey"),
        }),
      );
      await send(res, 201, result);
      return true;
    }

    // GET /api/creators/matching — an org's match runs, optionally
    // narrowed by campaign (public; tenant-scoped).
    if (path === "/api/creators/matching" && method === "GET" && opts.commands) {
      const url = new URL(req.url ?? "/", "http://localhost");
      const organizationScopeId = url.searchParams.get("organizationScopeId");
      if (!organizationScopeId) {
        throw apiValidationError('query parameter "organizationScopeId" is required');
      }
      const campaignId = url.searchParams.get("campaignId") ?? undefined;
      const views = await opts.commands.listCreatorMatchRuns(
        ctx,
        organizationScopeId,
        campaignId,
      );
      await send(res, 200, { organizationScopeId, runs: views });
      return true;
    }

    // GET /api/creators/matching/:id — one match run (public;
    // tenant-scoped; a cross-scope run id is not found).
    if (
      path.startsWith("/api/creators/matching/") &&
      method === "GET" &&
      opts.commands
    ) {
      const id = path.slice("/api/creators/matching/".length);
      const url = new URL(req.url ?? "/", "http://localhost");
      const organizationScopeId = url.searchParams.get("organizationScopeId");
      if (!organizationScopeId) {
        throw apiValidationError('query parameter "organizationScopeId" is required');
      }
      // A cross-scope or nonexistent run id throws NotFoundError —
      // the global handler maps the not_found classification to 404.
      const view = await opts.commands.getCreatorMatchRun(
        ctx,
        organizationScopeId,
        id,
      );
      await send(res, 200, view);
      return true;
    }


    // ------------------------------------------------------------------
    // NET-W017 — UGC workflow and rights (creator engagements). The
    // engagement is a canonical /workflows lifecycle subject; the
    // composed commands are guarded below, pure lifecycle transitions
    // (tender/verify/reject/cancel) go through the EXISTING
    // POST /api/workflows/transitions endpoint with subjectKind
    // "engagement" (the Proof-of-Value precedent).
    // ------------------------------------------------------------------

    // POST /api/creators/engagements — create an engagement offer
    // (protected; guard action creators.engagements.create).
    if (path === "/api/creators/engagements" && method === "POST" && opts.commands) {
      const commands = opts.commands;
      const guarded = await guardMutation(ctx, req, "creators.engagements.create", "*", res);
      if (!guarded) return true;
      const body = await readBody(req);
      const obj = requireBodyObject(body);
      const result = await runWithExecutionContextAsync(guarded.execution, () =>
        commands.createEngagement(guarded.execution, guarded.personId, {
          organizationScopeId: strField(obj, "organizationScopeId"),
          creatorPersonId: strField(obj, "creatorPersonId"),
          campaignId: strField(obj, "campaignId"),
          ...(obj.campaignPolicyVersion !== undefined && obj.campaignPolicyVersion !== null
            ? { campaignPolicyVersion: obj.campaignPolicyVersion as number }
            : {}),
          ...(obj.matchRunId !== undefined && obj.matchRunId !== null
            ? { matchRunId: obj.matchRunId as string }
            : {}),
          ...(obj.opportunityId !== undefined && obj.opportunityId !== null
            ? { opportunityId: obj.opportunityId as string }
            : {}),
          requestedRights: objField(obj, "requestedRights"),
          ...(obj.compensation !== undefined && obj.compensation !== null
            ? { compensation: obj.compensation }
            : {}),
          ...(obj.brief !== undefined && obj.brief !== null
            ? { brief: obj.brief }
            : {}),
          idempotencyKey: strField(obj, "idempotencyKey"),
        }),
      );
      await send(res, 201, result);
      return true;
    }

    // POST /api/creators/engagements/from-match — the auto-match
    // batch (protected; guard action
    // creators.engagements.createFromMatch).
    if (path === "/api/creators/engagements/from-match" && method === "POST" && opts.commands) {
      const commands = opts.commands;
      const guarded = await guardMutation(
        ctx,
        req,
        "creators.engagements.createFromMatch",
        "*",
        res,
      );
      if (!guarded) return true;
      const body = await readBody(req);
      const obj = requireBodyObject(body);
      const result = await runWithExecutionContextAsync(guarded.execution, () =>
        commands.createEngagementsFromMatch(guarded.execution, guarded.personId, {
          organizationScopeId: strField(obj, "organizationScopeId"),
          matchRunId: strField(obj, "matchRunId"),
          ...(obj.limit !== undefined && obj.limit !== null
            ? { limit: obj.limit as number }
            : {}),
          offer: objField(obj, "offer"),
          idempotencyKey: strField(obj, "idempotencyKey"),
        }),
      );
      await send(res, 201, result);
      return true;
    }

    // POST /api/creators/engagements/:id/accept — manual acceptance
    // with the granted usage rights (protected; guard action
    // creators.engagements.accept).
    if (
      path.startsWith("/api/creators/engagements/") &&
      path.endsWith("/accept") &&
      method === "POST" &&
      opts.commands
    ) {
      const commands = opts.commands;
      const id = path.slice("/api/creators/engagements/".length, -"/accept".length);
      const guarded = await guardMutation(ctx, req, "creators.engagements.accept", "*", res);
      if (!guarded) return true;
      const body = await readBody(req);
      const obj = requireBodyObject(body);
      const result = await runWithExecutionContextAsync(guarded.execution, () =>
        commands.acceptEngagement(guarded.execution, guarded.personId, {
          organizationScopeId: strField(obj, "organizationScopeId"),
          engagementId: id,
          expectedVersion: numField(obj, "expectedVersion"),
          grantedRights: objField(obj, "grantedRights"),
          idempotencyKey: strField(obj, "idempotencyKey"),
        }),
      );
      await send(res, 200, result);
      return true;
    }

    // POST /api/creators/engagements/:id/auto-accept — the
    // deterministic auto-accept evaluation + execution (protected;
    // guard action creators.engagements.autoAccept).
    if (
      path.startsWith("/api/creators/engagements/") &&
      path.endsWith("/auto-accept") &&
      method === "POST" &&
      opts.commands
    ) {
      const commands = opts.commands;
      const id = path.slice("/api/creators/engagements/".length, -"/auto-accept".length);
      const guarded = await guardMutation(
        ctx,
        req,
        "creators.engagements.autoAccept",
        "*",
        res,
      );
      if (!guarded) return true;
      const body = await readBody(req);
      const obj = requireBodyObject(body);
      const result = await runWithExecutionContextAsync(guarded.execution, () =>
        commands.autoAcceptEngagement(guarded.execution, guarded.personId, {
          organizationScopeId: strField(obj, "organizationScopeId"),
          engagementId: id,
          expectedVersion: numField(obj, "expectedVersion"),
          idempotencyKey: strField(obj, "idempotencyKey"),
        }),
      );
      await send(res, 200, result);
      return true;
    }

    // POST /api/creators/engagements/:id/productions — open UGC
    // production (protected; guard action creators.productions.open).
    if (
      path.startsWith("/api/creators/engagements/") &&
      path.endsWith("/productions") &&
      method === "POST" &&
      opts.commands
    ) {
      const commands = opts.commands;
      const id = path.slice("/api/creators/engagements/".length, -"/productions".length);
      const guarded = await guardMutation(ctx, req, "creators.productions.open", "*", res);
      if (!guarded) return true;
      const body = await readBody(req);
      const obj = requireBodyObject(body);
      const result = await runWithExecutionContextAsync(guarded.execution, () =>
        commands.openUgcProduction(guarded.execution, guarded.personId, {
          organizationScopeId: strField(obj, "organizationScopeId"),
          engagementId: id,
          expectedVersion: numField(obj, "expectedVersion"),
          ...(obj.contributionId !== undefined && obj.contributionId !== null
            ? { contributionId: obj.contributionId as string }
            : {}),
          idempotencyKey: strField(obj, "idempotencyKey"),
        }),
      );
      await send(res, 201, result);
      return true;
    }

    // POST /api/creators/productions/:id/deliverables — record an
    // immutable deliverable version (protected; guard action
    // creators.productions.deliverable).
    if (
      path.startsWith("/api/creators/productions/") &&
      path.endsWith("/deliverables") &&
      method === "POST" &&
      opts.commands
    ) {
      const commands = opts.commands;
      const id = path.slice("/api/creators/productions/".length, -"/deliverables".length);
      const guarded = await guardMutation(
        ctx,
        req,
        "creators.productions.deliverable",
        "*",
        res,
      );
      if (!guarded) return true;
      const body = await readBody(req);
      const obj = requireBodyObject(body);
      const result = await runWithExecutionContextAsync(guarded.execution, () =>
        commands.recordUgcDeliverable(guarded.execution, guarded.personId, {
          organizationScopeId: strField(obj, "organizationScopeId"),
          productionId: id,
          deliverableKey: strField(obj, "deliverableKey"),
          format: strField(obj, "format"),
          ...(obj.title !== undefined && obj.title !== null
            ? { title: obj.title as string }
            : {}),
          ...(obj.contentReference !== undefined && obj.contentReference !== null
            ? { contentReference: obj.contentReference as string }
            : {}),
          ...(obj.externalPlatform !== undefined && obj.externalPlatform !== null
            ? { externalPlatform: obj.externalPlatform }
            : {}),
          ...(obj.notes !== undefined && obj.notes !== null
            ? { notes: obj.notes as string }
            : {}),
          idempotencyKey: strField(obj, "idempotencyKey"),
        }),
      );
      await send(res, 201, result);
      return true;
    }

    // POST /api/creators/productions/:id/submission — submit the
    // production with canonical evidence references (protected;
    // guard action creators.productions.submit).
    if (
      path.startsWith("/api/creators/productions/") &&
      path.endsWith("/submission") &&
      method === "POST" &&
      opts.commands
    ) {
      const commands = opts.commands;
      const id = path.slice("/api/creators/productions/".length, -"/submission".length);
      const guarded = await guardMutation(ctx, req, "creators.productions.submit", "*", res);
      if (!guarded) return true;
      const body = await readBody(req);
      const obj = requireBodyObject(body);
      const evidenceReferences = obj.evidenceReferences;
      if (
        !Array.isArray(evidenceReferences) ||
        evidenceReferences.length === 0 ||
        evidenceReferences.some((x) => typeof x !== "string" || !x.trim())
      ) {
        throw apiValidationError(
          'field "evidenceReferences" must be a non-empty list of evidence ids',
        );
      }
      const result = await runWithExecutionContextAsync(guarded.execution, () =>
        commands.submitUgcProduction(guarded.execution, guarded.personId, {
          organizationScopeId: strField(obj, "organizationScopeId"),
          productionId: id,
          expectedVersion: numField(obj, "expectedVersion"),
          evidenceReferences: evidenceReferences as string[],
          idempotencyKey: strField(obj, "idempotencyKey"),
        }),
      );
      await send(res, 200, result);
      return true;
    }

    // POST /api/creators/usage-rights/:id/revocation — revoke a
    // usage-rights grant (protected; guard action
    // creators.usageRights.revoke; grantor-only).
    if (
      path.startsWith("/api/creators/usage-rights/") &&
      path.endsWith("/revocation") &&
      method === "POST" &&
      opts.commands
    ) {
      const commands = opts.commands;
      const id = path.slice("/api/creators/usage-rights/".length, -"/revocation".length);
      const guarded = await guardMutation(ctx, req, "creators.usageRights.revoke", "*", res);
      if (!guarded) return true;
      const body = await readBody(req);
      const obj = requireBodyObject(body);
      const result = await runWithExecutionContextAsync(guarded.execution, () =>
        commands.revokeUsageRights(guarded.execution, guarded.personId, {
          organizationScopeId: strField(obj, "organizationScopeId"),
          grantId: id,
          ...(obj.effectiveAt !== undefined && obj.effectiveAt !== null
            ? { effectiveAt: obj.effectiveAt as string }
            : {}),
          ...(obj.reason !== undefined && obj.reason !== null
            ? { reason: obj.reason as string }
            : {}),
          idempotencyKey: strField(obj, "idempotencyKey"),
        }),
      );
      await send(res, 200, result);
      return true;
    }

    // POST /api/creators/acceptance-policy — set the next acceptance
    // policy version (protected; guard action
    // creators.acceptancePolicy.set).
    if (path === "/api/creators/acceptance-policy" && method === "POST" && opts.commands) {
      const commands = opts.commands;
      const guarded = await guardMutation(
        ctx,
        req,
        "creators.acceptancePolicy.set",
        "*",
        res,
      );
      if (!guarded) return true;
      const body = await readBody(req);
      const obj = requireBodyObject(body);
      const result = await runWithExecutionContextAsync(guarded.execution, () =>
        commands.setCreatorAcceptancePolicy(guarded.execution, guarded.personId, {
          organizationScopeId: strField(obj, "organizationScopeId"),
          creatorPersonId: strField(obj, "creatorPersonId"),
          mode: strField(obj, "mode"),
          ...(obj.maxActiveEngagements !== undefined && obj.maxActiveEngagements !== null
            ? { maxActiveEngagements: obj.maxActiveEngagements as number }
            : {}),
          ...(obj.rateFloor !== undefined && obj.rateFloor !== null
            ? { rateFloor: obj.rateFloor }
            : {}),
          ...(obj.autoGrantableRights !== undefined && obj.autoGrantableRights !== null
            ? { autoGrantableRights: obj.autoGrantableRights }
            : {}),
          ...(obj.maxGrantDurationDays !== undefined && obj.maxGrantDurationDays !== null
            ? { maxGrantDurationDays: obj.maxGrantDurationDays as number }
            : {}),
          idempotencyKey: strField(obj, "idempotencyKey"),
        }),
      );
      await send(res, 201, result);
      return true;
    }

    // POST /api/creators/commercial-relationships — record the
    // commercial relationship for an engagement (protected; guard
    // action creators.commercialRelationships.create).
    if (
      path === "/api/creators/commercial-relationships" &&
      method === "POST" &&
      opts.commands
    ) {
      const commands = opts.commands;
      const guarded = await guardMutation(
        ctx,
        req,
        "creators.commercialRelationships.create",
        "*",
        res,
      );
      if (!guarded) return true;
      const body = await readBody(req);
      const obj = requireBodyObject(body);
      const result = await runWithExecutionContextAsync(guarded.execution, () =>
        commands.createCommercialRelationship(guarded.execution, guarded.personId, {
          organizationScopeId: strField(obj, "organizationScopeId"),
          engagementId: strField(obj, "engagementId"),
          campaignId: strField(obj, "campaignId"),
          sponsorPersonId: strField(obj, "sponsorPersonId"),
          kind: strField(obj, "kind"),
          ...(obj.disclosureObligations !== undefined &&
          obj.disclosureObligations !== null
            ? { disclosureObligations: obj.disclosureObligations }
            : {}),
          ...(obj.compensation !== undefined && obj.compensation !== null
            ? { compensation: obj.compensation }
            : {}),
          idempotencyKey: strField(obj, "idempotencyKey"),
        }),
      );
      await send(res, 201, result);
      return true;
    }

    // POST /api/creators/commercial-relationships/:id/termination —
    // terminate the relationship (one-way; protected; guard action
    // creators.commercialRelationships.terminate).
    if (
      path.startsWith("/api/creators/commercial-relationships/") &&
      path.endsWith("/termination") &&
      method === "POST" &&
      opts.commands
    ) {
      const commands = opts.commands;
      const id = path.slice(
        "/api/creators/commercial-relationships/".length,
        -"/termination".length,
      );
      const guarded = await guardMutation(
        ctx,
        req,
        "creators.commercialRelationships.terminate",
        "*",
        res,
      );
      if (!guarded) return true;
      const body = await readBody(req);
      const obj = requireBodyObject(body);
      const result = await runWithExecutionContextAsync(guarded.execution, () =>
        commands.terminateCommercialRelationship(guarded.execution, guarded.personId, {
          organizationScopeId: strField(obj, "organizationScopeId"),
          relationshipId: id,
          ...(obj.reason !== undefined && obj.reason !== null
            ? { reason: obj.reason as string }
            : {}),
          idempotencyKey: strField(obj, "idempotencyKey"),
        }),
      );
      await send(res, 200, result);
      return true;
    }

    // POST /api/creators/publications — record a publication (DRAFT)
    // for a verified engagement's production (protected; guard action
    // creators.publications.create).
    if (path === "/api/creators/publications" && method === "POST" && opts.commands) {
      const commands = opts.commands;
      const guarded = await guardMutation(
        ctx,
        req,
        "creators.publications.create",
        "*",
        res,
      );
      if (!guarded) return true;
      const body = await readBody(req);
      const obj = requireBodyObject(body);
      const result = await runWithExecutionContextAsync(guarded.execution, () =>
        commands.createPublication(guarded.execution, guarded.personId, {
          organizationScopeId: strField(obj, "organizationScopeId"),
          engagementId: strField(obj, "engagementId"),
          ...(obj.productionId !== undefined && obj.productionId !== null
            ? { productionId: obj.productionId as string }
            : {}),
          channel: obj.channel,
          idempotencyKey: strField(obj, "idempotencyKey"),
        }),
      );
      await send(res, 201, result);
      return true;
    }

    // POST /api/creators/publications/:id/declarations — append a
    // disclosure declaration (protected; guard action
    // creators.publications.declareDisclosure; creator-only declarant).
    if (
      path.startsWith("/api/creators/publications/") &&
      path.endsWith("/declarations") &&
      method === "POST" &&
      opts.commands
    ) {
      const commands = opts.commands;
      const id = path.slice(
        "/api/creators/publications/".length,
        -"/declarations".length,
      );
      const guarded = await guardMutation(
        ctx,
        req,
        "creators.publications.declareDisclosure",
        "*",
        res,
      );
      if (!guarded) return true;
      const body = await readBody(req);
      const obj = requireBodyObject(body);
      const evidenceReferences = obj.evidenceReferences;
      if (
        !Array.isArray(evidenceReferences) ||
        evidenceReferences.length === 0 ||
        evidenceReferences.some((x) => typeof x !== "string" || !x.trim())
      ) {
        throw apiValidationError(
          'field "evidenceReferences" must be a non-empty list of evidence ids',
        );
      }
      const result = await runWithExecutionContextAsync(guarded.execution, () =>
        commands.recordDisclosureDeclaration(guarded.execution, guarded.personId, {
          organizationScopeId: strField(obj, "organizationScopeId"),
          publicationId: id,
          kind: strField(obj, "kind"),
          statement: strField(obj, "statement"),
          evidenceReferences: evidenceReferences as string[],
          idempotencyKey: strField(obj, "idempotencyKey"),
        }),
      );
      await send(res, 201, result);
      return true;
    }

    // POST /api/creators/publications/:id/verification — THE
    // DISCLOSURE GATE: verify the publication (protected; guard
    // action creators.publications.verify; the derived obligations
    // must ALL be satisfied — no caller input bypasses the gate).
    if (
      path.startsWith("/api/creators/publications/") &&
      path.endsWith("/verification") &&
      method === "POST" &&
      opts.commands
    ) {
      const commands = opts.commands;
      const id = path.slice(
        "/api/creators/publications/".length,
        -"/verification".length,
      );
      const guarded = await guardMutation(
        ctx,
        req,
        "creators.publications.verify",
        "*",
        res,
      );
      if (!guarded) return true;
      const body = await readBody(req);
      const obj = requireBodyObject(body);
      const evidenceReferences = obj.evidenceReferences;
      if (
        !Array.isArray(evidenceReferences) ||
        evidenceReferences.length === 0 ||
        evidenceReferences.some((x) => typeof x !== "string" || !x.trim())
      ) {
        throw apiValidationError(
          'field "evidenceReferences" must be a non-empty list of evidence ids',
        );
      }
      const result = await runWithExecutionContextAsync(guarded.execution, () =>
        commands.verifyPublication(guarded.execution, guarded.personId, {
          organizationScopeId: strField(obj, "organizationScopeId"),
          publicationId: id,
          expectedVersion: numField(obj, "expectedVersion"),
          evidenceReferences: evidenceReferences as string[],
          idempotencyKey: strField(obj, "idempotencyKey"),
        }),
      );
      await send(res, 200, result);
      return true;
    }

    // GET /api/creators/commercial-relationships/:id — one commercial
    // relationship (public; tenant-scoped; a cross-scope id is not found).
    if (
      path.startsWith("/api/creators/commercial-relationships/") &&
      method === "GET" &&
      opts.commands
    ) {
      const id = path.slice("/api/creators/commercial-relationships/".length);
      const url = new URL(req.url ?? "/", "http://localhost");
      const organizationScopeId = url.searchParams.get("organizationScopeId");
      if (!organizationScopeId) {
        throw apiValidationError('query parameter "organizationScopeId" is required');
      }
      const view = await opts.commands.getCommercialRelationship(
        ctx,
        organizationScopeId,
        id,
      );
      await send(res, 200, view);
      return true;
    }

    // GET /api/creators/commercial-relationships — an org's commercial
    // relationships (public; tenant-scoped).
    if (
      path === "/api/creators/commercial-relationships" &&
      method === "GET" &&
      opts.commands
    ) {
      const url = new URL(req.url ?? "/", "http://localhost");
      const organizationScopeId = url.searchParams.get("organizationScopeId");
      if (!organizationScopeId) {
        throw apiValidationError('query parameter "organizationScopeId" is required');
      }
      const views = await opts.commands.listCommercialRelationships(
        ctx,
        organizationScopeId,
        url.searchParams.get("campaignId") ?? undefined,
        url.searchParams.get("engagementId") ?? undefined,
        url.searchParams.get("creatorPersonId") ?? undefined,
      );
      await send(res, 200, { organizationScopeId, relationships: views });
      return true;
    }

    // GET /api/creators/publications/:id/disclosure-status — the
    // DERIVED disclosure status of one publication (public;
    // tenant-scoped).
    if (
      path.startsWith("/api/creators/publications/") &&
      path.endsWith("/disclosure-status") &&
      method === "GET" &&
      opts.commands
    ) {
      const id = path.slice(
        "/api/creators/publications/".length,
        -"/disclosure-status".length,
      );
      const url = new URL(req.url ?? "/", "http://localhost");
      const organizationScopeId = url.searchParams.get("organizationScopeId");
      if (!organizationScopeId) {
        throw apiValidationError('query parameter "organizationScopeId" is required');
      }
      const view = await opts.commands.getPublicationDisclosureStatus(
        ctx,
        organizationScopeId,
        id,
      );
      await send(res, 200, view);
      return true;
    }

    // GET /api/creators/publications/:id/declarations — a publication's
    // disclosure declarations (public; tenant-scoped).
    if (
      path.startsWith("/api/creators/publications/") &&
      path.endsWith("/declarations") &&
      method === "GET" &&
      opts.commands
    ) {
      const id = path.slice(
        "/api/creators/publications/".length,
        -"/declarations".length,
      );
      const url = new URL(req.url ?? "/", "http://localhost");
      const organizationScopeId = url.searchParams.get("organizationScopeId");
      if (!organizationScopeId) {
        throw apiValidationError('query parameter "organizationScopeId" is required');
      }
      const views = await opts.commands.listDisclosureDeclarations(
        ctx,
        organizationScopeId,
        id,
      );
      await send(res, 200, { organizationScopeId, publicationId: id, declarations: views });
      return true;
    }

    // GET /api/creators/publications/:id — one publication (public;
    // tenant-scoped; a cross-scope id is not found).
    if (
      path.startsWith("/api/creators/publications/") &&
      method === "GET" &&
      opts.commands
    ) {
      const id = path.slice("/api/creators/publications/".length);
      const url = new URL(req.url ?? "/", "http://localhost");
      const organizationScopeId = url.searchParams.get("organizationScopeId");
      if (!organizationScopeId) {
        throw apiValidationError('query parameter "organizationScopeId" is required');
      }
      const view = await opts.commands.getPublication(
        ctx,
        organizationScopeId,
        id,
      );
      await send(res, 200, view);
      return true;
    }

    // GET /api/creators/publications — an org's publications (public;
    // tenant-scoped).
    if (
      path === "/api/creators/publications" &&
      method === "GET" &&
      opts.commands
    ) {
      const url = new URL(req.url ?? "/", "http://localhost");
      const organizationScopeId = url.searchParams.get("organizationScopeId");
      if (!organizationScopeId) {
        throw apiValidationError('query parameter "organizationScopeId" is required');
      }
      const views = await opts.commands.listPublications(
        ctx,
        organizationScopeId,
        url.searchParams.get("engagementId") ?? undefined,
        url.searchParams.get("campaignId") ?? undefined,
        url.searchParams.get("creatorPersonId") ?? undefined,
      );
      await send(res, 200, { organizationScopeId, publications: views });
      return true;
    }

    // ------------------------------------------------------------------
    // NET-W019 — Inventory and placements (supply registration,
    // placement context, supply authorization, source provenance).
    // ------------------------------------------------------------------

    // POST /api/inventory/items — register supply (protected; guard
    // action inventory.items.register; the acting person BECOMES the
    // registered owner — there is no ownerPersonId input).
    if (path === "/api/inventory/items" && method === "POST" && opts.commands) {
      const commands = opts.commands;
      const guarded = await guardMutation(
        ctx,
        req,
        "inventory.items.register",
        "*",
        res,
      );
      if (!guarded) return true;
      const body = await readBody(req);
      const obj = requireBodyObject(body);
      const result = await runWithExecutionContextAsync(guarded.execution, () =>
        commands.registerInventoryItem(guarded.execution, guarded.personId, {
          organizationScopeId: strField(obj, "organizationScopeId"),
          surfaceKind: strField(obj, "surfaceKind"),
          format: strField(obj, "format"),
          ...(obj.externalReference !== undefined &&
          obj.externalReference !== null
            ? { externalReference: obj.externalReference }
            : {}),
          attributes: obj.attributes,
          ...(obj.description !== undefined && obj.description !== null
            ? { description: obj.description as string }
            : {}),
          idempotencyKey: strField(obj, "idempotencyKey"),
        }),
      );
      await send(res, 201, result);
      return true;
    }

    // POST /api/inventory/items/:id/retirement — withdraw supply
    // (one-way, owner-only; protected; guard action
    // inventory.items.retire).
    if (
      path.startsWith("/api/inventory/items/") &&
      path.endsWith("/retirement") &&
      method === "POST" &&
      opts.commands
    ) {
      const commands = opts.commands;
      const id = path.slice(
        "/api/inventory/items/".length,
        -"/retirement".length,
      );
      const guarded = await guardMutation(
        ctx,
        req,
        "inventory.items.retire",
        "*",
        res,
      );
      if (!guarded) return true;
      const body = await readBody(req);
      const obj = requireBodyObject(body);
      const result = await runWithExecutionContextAsync(guarded.execution, () =>
        commands.retireInventoryItem(guarded.execution, guarded.personId, {
          organizationScopeId: strField(obj, "organizationScopeId"),
          itemId: id,
          ...(obj.reason !== undefined && obj.reason !== null
            ? { reason: obj.reason as string }
            : {}),
          idempotencyKey: strField(obj, "idempotencyKey"),
        }),
      );
      await send(res, 200, result);
      return true;
    }

    // POST /api/inventory/items/:id/supply-verification — attach the
    // supply-verification evidence reference (owner-only, one-time;
    // protected; guard action inventory.items.attachSupplyVerification;
    // the reference must be subject-bound to THIS item).
    if (
      path.startsWith("/api/inventory/items/") &&
      path.endsWith("/supply-verification") &&
      method === "POST" &&
      opts.commands
    ) {
      const commands = opts.commands;
      const id = path.slice(
        "/api/inventory/items/".length,
        -"/supply-verification".length,
      );
      const guarded = await guardMutation(
        ctx,
        req,
        "inventory.items.attachSupplyVerification",
        "*",
        res,
      );
      if (!guarded) return true;
      const body = await readBody(req);
      const obj = requireBodyObject(body);
      const result = await runWithExecutionContextAsync(guarded.execution, () =>
        commands.attachSupplyVerification(guarded.execution, guarded.personId, {
          organizationScopeId: strField(obj, "organizationScopeId"),
          itemId: id,
          evidenceReference: strField(obj, "evidenceReference"),
          idempotencyKey: strField(obj, "idempotencyKey"),
        }),
      );
      await send(res, 200, result);
      return true;
    }

    // POST /api/inventory/placements — record the placement context
    // (protected; guard action inventory.placements.create; the
    // acting person must be the item's registered owner —
    // server-enforced; the eligibility evaluation is DERIVED).
    if (path === "/api/inventory/placements" && method === "POST" && opts.commands) {
      const commands = opts.commands;
      const guarded = await guardMutation(
        ctx,
        req,
        "inventory.placements.create",
        "*",
        res,
      );
      if (!guarded) return true;
      const body = await readBody(req);
      const obj = requireBodyObject(body);
      const result = await runWithExecutionContextAsync(guarded.execution, () =>
        commands.createPlacement(guarded.execution, guarded.personId, {
          organizationScopeId: strField(obj, "organizationScopeId"),
          inventoryItemId: strField(obj, "inventoryItemId"),
          campaignId: strField(obj, "campaignId"),
          ...(obj.campaignPolicyVersion !== undefined &&
          obj.campaignPolicyVersion !== null
            ? { campaignPolicyVersion: obj.campaignPolicyVersion as number }
            : {}),
          context: obj.context,
          idempotencyKey: strField(obj, "idempotencyKey"),
        }),
      );
      await send(res, 201, result);
      return true;
    }

    // POST /api/inventory/placements/:id/retirement — retire the
    // placement (one-way, owner-only; protected; guard action
    // inventory.placements.retire).
    if (
      path.startsWith("/api/inventory/placements/") &&
      path.endsWith("/retirement") &&
      method === "POST" &&
      opts.commands
    ) {
      const commands = opts.commands;
      const id = path.slice(
        "/api/inventory/placements/".length,
        -"/retirement".length,
      );
      const guarded = await guardMutation(
        ctx,
        req,
        "inventory.placements.retire",
        "*",
        res,
      );
      if (!guarded) return true;
      const body = await readBody(req);
      const obj = requireBodyObject(body);
      const result = await runWithExecutionContextAsync(guarded.execution, () =>
        commands.retirePlacement(guarded.execution, guarded.personId, {
          organizationScopeId: strField(obj, "organizationScopeId"),
          placementId: id,
          ...(obj.reason !== undefined && obj.reason !== null
            ? { reason: obj.reason as string }
            : {}),
          idempotencyKey: strField(obj, "idempotencyKey"),
        }),
      );
      await send(res, 200, result);
      return true;
    }

    // GET /api/inventory/placements/:id/settlement-readiness — THE
    // SETTLEMENT GATE: the DERIVED settlement readiness of one
    // placement (public; tenant-scoped; re-derived from CURRENT
    // durable records on every read — never stored, never asserted).
    if (
      path.startsWith("/api/inventory/placements/") &&
      path.endsWith("/settlement-readiness") &&
      method === "GET" &&
      opts.commands
    ) {
      const id = path.slice(
        "/api/inventory/placements/".length,
        -"/settlement-readiness".length,
      );
      const url = new URL(req.url ?? "/", "http://localhost");
      const organizationScopeId = url.searchParams.get("organizationScopeId");
      if (!organizationScopeId) {
        throw apiValidationError('query parameter "organizationScopeId" is required');
      }
      const view = await opts.commands.getPlacementSettlementReadiness(
        ctx,
        organizationScopeId,
        id,
      );
      await send(res, 200, view);
      return true;
    }

    // ------------------------------------------------------------------
    // NET-W024 — Consumer Demand Pools routes. Pools are public
    // tenant-scoped reads; every commitment read surface is
    // ACTOR-SCOPED (listMyDemandCommitments) — individual commitments
    // are never exposed on any other route; the qualified aggregate
    // is a protected DERIVED 200 decision (like the W023 admission
    // evaluation and the W019 readiness view).
    // ------------------------------------------------------------------

    // POST /api/demand/pools — create a demand pool (protected; guard
    // action demand.pools.create; the acting person BECOMES the pool
    // creator — there is no creatorPersonId input).
    if (path === "/api/demand/pools" && method === "POST" && opts.commands) {
      const commands = opts.commands;
      const guarded = await guardMutation(
        ctx,
        req,
        "demand.pools.create",
        "*",
        res,
      );
      if (!guarded) return true;
      const body = await readBody(req);
      const obj = requireBodyObject(body);
      const result = await runWithExecutionContextAsync(guarded.execution, () =>
        commands.createDemandPool(guarded.execution, guarded.personId, {
          organizationScopeId: strField(obj, "organizationScopeId"),
          name: strField(obj, "name"),
          categoryKey: strField(obj, "categoryKey"),
          qualificationPolicy: obj.qualificationPolicy,
          idempotencyKey: strField(obj, "idempotencyKey"),
        }),
      );
      await send(res, 201, result);
      return true;
    }

    // POST /api/demand/pools/:id/closure — close the pool (one-way,
    // creator-only; protected; guard action demand.pools.close).
    if (
      path.startsWith("/api/demand/pools/") &&
      path.endsWith("/closure") &&
      method === "POST" &&
      opts.commands
    ) {
      const commands = opts.commands;
      const id = path.slice("/api/demand/pools/".length, -"/closure".length);
      const guarded = await guardMutation(
        ctx,
        req,
        "demand.pools.close",
        "*",
        res,
      );
      if (!guarded) return true;
      const body = await readBody(req);
      const obj = requireBodyObject(body);
      const result = await runWithExecutionContextAsync(guarded.execution, () =>
        commands.closeDemandPool(guarded.execution, guarded.personId, {
          organizationScopeId: strField(obj, "organizationScopeId"),
          poolId: id,
          ...(obj.reason !== undefined && obj.reason !== null
            ? { reason: obj.reason as string }
            : {}),
          idempotencyKey: strField(obj, "idempotencyKey"),
        }),
      );
      await send(res, 200, result);
      return true;
    }

    // POST /api/demand/pools/:id/qualified-aggregate — THE
    // SUPPLIER-FACING DERIVATION (protected; guard action
    // demand.aggregates.evaluate): the privacy-preserving qualified
    // aggregate demand, re-derived from CURRENT durable records at
    // one explicit evaluation anchor. A 200 DECISION for every
    // outcome (qualified or not, disclosed or suppressed — the
    // decision is the product). There is NO aggregate/threshold
    // input: every caller field beyond scope/pool identity is
    // ignored.
    if (
      path.startsWith("/api/demand/pools/") &&
      path.endsWith("/qualified-aggregate") &&
      method === "POST" &&
      opts.commands
    ) {
      const commands = opts.commands;
      const id = path.slice(
        "/api/demand/pools/".length,
        -"/qualified-aggregate".length,
      );
      const guarded = await guardMutation(
        ctx,
        req,
        "demand.aggregates.evaluate",
        "*",
        res,
      );
      if (!guarded) return true;
      const body = await readBody(req);
      const obj = requireBodyObject(body);
      const view = await runWithExecutionContextAsync(guarded.execution, () =>
        commands.evaluateQualifiedDemand(guarded.execution, guarded.personId, {
          organizationScopeId: strField(obj, "organizationScopeId"),
          poolId: id,
        }),
      );
      await send(res, 200, view);
      return true;
    }

    // POST /api/demand/commitments — record a consumer demand
    // commitment (protected; guard action demand.commitments.create;
    // the acting person BECOMES the consumer — there is no
    // consumerPersonId input; the consent grant is server-written).
    if (
      path === "/api/demand/commitments" &&
      method === "POST" &&
      opts.commands
    ) {
      const commands = opts.commands;
      const guarded = await guardMutation(
        ctx,
        req,
        "demand.commitments.create",
        "*",
        res,
      );
      if (!guarded) return true;
      const body = await readBody(req);
      const obj = requireBodyObject(body);
      const result = await runWithExecutionContextAsync(guarded.execution, () =>
        commands.createDemandCommitment(guarded.execution, guarded.personId, {
          organizationScopeId: strField(obj, "organizationScopeId"),
          poolId: strField(obj, "poolId"),
          attributes: obj.attributes,
          consent: obj.consent,
          idempotencyKey: strField(obj, "idempotencyKey"),
        }),
      );
      await send(res, 201, result);
      return true;
    }

    // POST /api/demand/commitments/:id/withdrawal — withdraw the
    // commitment (one-way, consumer-only; protected; guard action
    // demand.commitments.withdraw — the consent revocation).
    if (
      path.startsWith("/api/demand/commitments/") &&
      path.endsWith("/withdrawal") &&
      method === "POST" &&
      opts.commands
    ) {
      const commands = opts.commands;
      const id = path.slice(
        "/api/demand/commitments/".length,
        -"/withdrawal".length,
      );
      const guarded = await guardMutation(
        ctx,
        req,
        "demand.commitments.withdraw",
        "*",
        res,
      );
      if (!guarded) return true;
      const body = await readBody(req);
      const obj = requireBodyObject(body);
      const result = await runWithExecutionContextAsync(guarded.execution, () =>
        commands.withdrawDemandCommitment(guarded.execution, guarded.personId, {
          organizationScopeId: strField(obj, "organizationScopeId"),
          commitmentId: id,
          ...(obj.reason !== undefined && obj.reason !== null
            ? { reason: obj.reason as string }
            : {}),
          idempotencyKey: strField(obj, "idempotencyKey"),
        }),
      );
      await send(res, 200, result);
      return true;
    }

    // POST /api/demand/commitments/mine — list the AUTHENTICATED
    // ACTOR'S OWN commitments (protected; guard action
    // demand.commitments.read). The ONLY commitment read surface: the
    // consumer is the server-resolved actor (there is no
    // consumerPersonId input); individual commitments are never
    // exposed through any other route.
    if (
      path === "/api/demand/commitments/mine" &&
      method === "POST" &&
      opts.commands
    ) {
      const commands = opts.commands;
      const guarded = await guardMutation(
        ctx,
        req,
        "demand.commitments.read",
        "*",
        res,
      );
      if (!guarded) return true;
      const body = await readBody(req);
      const obj = requireBodyObject(body);
      const result = await runWithExecutionContextAsync(guarded.execution, () =>
        commands.listMyDemandCommitments(guarded.execution, guarded.personId, {
          organizationScopeId: strField(obj, "organizationScopeId"),
          ...(obj.poolId !== undefined && obj.poolId !== null
            ? { poolId: obj.poolId as string }
            : {}),
        }),
      );
      await send(res, 200, result);
      return true;
    }

    // GET /api/demand/pools/:id — one demand pool (public;
    // tenant-scoped; pool metadata only — no commitment data; a
    // cross-scope id is not found).
    if (
      path.startsWith("/api/demand/pools/") &&
      !path.includes("/closure") &&
      !path.includes("/qualified-aggregate") &&
      method === "GET" &&
      opts.commands
    ) {
      const id = path.slice("/api/demand/pools/".length);
      const url = new URL(req.url ?? "/", "http://localhost");
      const organizationScopeId = url.searchParams.get("organizationScopeId");
      if (!organizationScopeId) {
        throw apiValidationError('query parameter "organizationScopeId" is required');
      }
      const view = await opts.commands.getDemandPool(
        ctx,
        organizationScopeId,
        id,
      );
      await send(res, 200, view);
      return true;
    }

    // GET /api/demand/pools — an org's demand pools (public;
    // tenant-scoped; pool metadata only; optional categoryKey/closed
    // filters).
    if (path === "/api/demand/pools" && method === "GET" && opts.commands) {
      const url = new URL(req.url ?? "/", "http://localhost");
      const organizationScopeId = url.searchParams.get("organizationScopeId");
      if (!organizationScopeId) {
        throw apiValidationError('query parameter "organizationScopeId" is required');
      }
      const categoryKey = url.searchParams.get("categoryKey") ?? undefined;
      const closedParam = url.searchParams.get("closed");
      const closed =
        closedParam === null
          ? undefined
          : closedParam === "true"
            ? true
            : closedParam === "false"
              ? false
              : undefined;
      const view = await opts.commands.listDemandPools(
        ctx,
        organizationScopeId,
        categoryKey,
        closed,
      );
      await send(res, 200, view);
      return true;
    }

    // ------------------------------------------------------------------
    // NET-W025 — Business procurement pools routes (the SAME /demand
    // boundary). Pools are public tenant-scoped reads; every
    // commitment read surface is ACTOR-SCOPED
    // (listMyProcurementCommitments) — individual business
    // commitments are never exposed on any other route; the
    // qualified aggregate is a protected DERIVED 200 decision.
    // ------------------------------------------------------------------

    // POST /api/demand/procurement/pools — create a procurement pool
    // (protected; guard action demand.procurement.pools.create; the
    // acting person BECOMES the pool creator — there is no
    // creatorPersonId input).
    if (
      path === "/api/demand/procurement/pools" &&
      method === "POST" &&
      opts.commands
    ) {
      const commands = opts.commands;
      const guarded = await guardMutation(
        ctx,
        req,
        "demand.procurement.pools.create",
        "*",
        res,
      );
      if (!guarded) return true;
      const body = await readBody(req);
      const obj = requireBodyObject(body);
      const result = await runWithExecutionContextAsync(guarded.execution, () =>
        commands.createProcurementPool(guarded.execution, guarded.personId, {
          organizationScopeId: strField(obj, "organizationScopeId"),
          name: strField(obj, "name"),
          categoryKey: strField(obj, "categoryKey"),
          qualificationPolicy: obj.qualificationPolicy,
          idempotencyKey: strField(obj, "idempotencyKey"),
        }),
      );
      await send(res, 201, result);
      return true;
    }

    // POST /api/demand/procurement/pools/:id/closure — close the
    // procurement pool (one-way, creator-only; protected; guard
    // action demand.procurement.pools.close).
    if (
      path.startsWith("/api/demand/procurement/pools/") &&
      path.endsWith("/closure") &&
      method === "POST" &&
      opts.commands
    ) {
      const commands = opts.commands;
      const id = path.slice(
        "/api/demand/procurement/pools/".length,
        -"/closure".length,
      );
      const guarded = await guardMutation(
        ctx,
        req,
        "demand.procurement.pools.close",
        "*",
        res,
      );
      if (!guarded) return true;
      const body = await readBody(req);
      const obj = requireBodyObject(body);
      const result = await runWithExecutionContextAsync(guarded.execution, () =>
        commands.closeProcurementPool(guarded.execution, guarded.personId, {
          organizationScopeId: strField(obj, "organizationScopeId"),
          poolId: id,
          ...(obj.reason !== undefined && obj.reason !== null
            ? { reason: obj.reason as string }
            : {}),
          idempotencyKey: strField(obj, "idempotencyKey"),
        }),
      );
      await send(res, 200, result);
      return true;
    }

    // POST /api/demand/procurement/pools/:id/qualified-aggregate —
    // THE SUPPLIER-FACING DERIVATION (protected; guard action
    // demand.procurement.aggregates.evaluate): the
    // privacy/competition-preserving qualified aggregate, re-derived
    // from CURRENT durable records at one explicit evaluation
    // anchor. A 200 DECISION for every outcome (qualified or not,
    // disclosed or suppressed — the decision is the product). There
    // is NO aggregate/threshold input: every caller field beyond
    // scope/pool identity is ignored.
    if (
      path.startsWith("/api/demand/procurement/pools/") &&
      path.endsWith("/qualified-aggregate") &&
      method === "POST" &&
      opts.commands
    ) {
      const commands = opts.commands;
      const id = path.slice(
        "/api/demand/procurement/pools/".length,
        -"/qualified-aggregate".length,
      );
      const guarded = await guardMutation(
        ctx,
        req,
        "demand.procurement.aggregates.evaluate",
        "*",
        res,
      );
      if (!guarded) return true;
      const body = await readBody(req);
      const obj = requireBodyObject(body);
      const view = await runWithExecutionContextAsync(guarded.execution, () =>
        commands.evaluateQualifiedProcurementDemand(
          guarded.execution,
          guarded.personId,
          {
            organizationScopeId: strField(obj, "organizationScopeId"),
            poolId: id,
          },
        ),
      );
      await send(res, 200, view);
      return true;
    }

    // POST /api/demand/procurement/commitments — record a business
    // demand commitment (protected; guard action
    // demand.procurement.commitments.create; the acting person
    // BECOMES the submitter — there is no submittedBy input; the
    // buyer-organization authorization + the consent grant are
    // server-written/server-enforced).
    if (
      path === "/api/demand/procurement/commitments" &&
      method === "POST" &&
      opts.commands
    ) {
      const commands = opts.commands;
      const guarded = await guardMutation(
        ctx,
        req,
        "demand.procurement.commitments.create",
        "*",
        res,
      );
      if (!guarded) return true;
      const body = await readBody(req);
      const obj = requireBodyObject(body);
      const result = await runWithExecutionContextAsync(guarded.execution, () =>
        commands.createProcurementCommitment(
          guarded.execution,
          guarded.personId,
          {
            organizationScopeId: strField(obj, "organizationScopeId"),
            poolId: strField(obj, "poolId"),
            buyerOrganizationId: strField(obj, "buyerOrganizationId"),
            attributes: obj.attributes,
            consent: obj.consent,
            idempotencyKey: strField(obj, "idempotencyKey"),
          },
        ),
      );
      await send(res, 201, result);
      return true;
    }

    // POST /api/demand/procurement/commitments/:id/withdrawal —
    // withdraw the procurement commitment (one-way, submitter-only;
    // protected; guard action demand.procurement.commitments.withdraw
    // — the consent revocation).
    if (
      path.startsWith("/api/demand/procurement/commitments/") &&
      path.endsWith("/withdrawal") &&
      method === "POST" &&
      opts.commands
    ) {
      const commands = opts.commands;
      const id = path.slice(
        "/api/demand/procurement/commitments/".length,
        -"/withdrawal".length,
      );
      const guarded = await guardMutation(
        ctx,
        req,
        "demand.procurement.commitments.withdraw",
        "*",
        res,
      );
      if (!guarded) return true;
      const body = await readBody(req);
      const obj = requireBodyObject(body);
      const result = await runWithExecutionContextAsync(guarded.execution, () =>
        commands.withdrawProcurementCommitment(
          guarded.execution,
          guarded.personId,
          {
            organizationScopeId: strField(obj, "organizationScopeId"),
            commitmentId: id,
            ...(obj.reason !== undefined && obj.reason !== null
              ? { reason: obj.reason as string }
              : {}),
            idempotencyKey: strField(obj, "idempotencyKey"),
          },
        ),
      );
      await send(res, 200, result);
      return true;
    }

    // POST /api/demand/procurement/commitments/mine — list the
    // AUTHENTICATED ACTOR'S OWN commitments (protected; guard action
    // demand.procurement.commitments.read). The ONLY commitment read
    // surface: the submitter is the server-resolved actor (there is
    // no submittedBy input); individual business commitments are
    // never exposed through any other route.
    if (
      path === "/api/demand/procurement/commitments/mine" &&
      method === "POST" &&
      opts.commands
    ) {
      const commands = opts.commands;
      const guarded = await guardMutation(
        ctx,
        req,
        "demand.procurement.commitments.read",
        "*",
        res,
      );
      if (!guarded) return true;
      const body = await readBody(req);
      const obj = requireBodyObject(body);
      const result = await runWithExecutionContextAsync(guarded.execution, () =>
        commands.listMyProcurementCommitments(
          guarded.execution,
          guarded.personId,
          {
            organizationScopeId: strField(obj, "organizationScopeId"),
            ...(obj.poolId !== undefined && obj.poolId !== null
              ? { poolId: obj.poolId as string }
              : {}),
          },
        ),
      );
      await send(res, 200, result);
      return true;
    }

    // ------------------------------------------------------------------
    // NET-W026 — Supplier offers and competitive selection (inside the
    // SAME /demand boundary). Offers are private to their supplier
    // (offers/mine is the ONLY offer read surface); selection surfaces
    // are pool-creator-only (supplier commercial terms never cross to
    // other pool participants); the derived selection view is a
    // protected 200 decision; the selection record is authoritative
    // lineage derived INSIDE the transaction.
    // ------------------------------------------------------------------

    // POST /api/demand/procurement/pools/:id/offers — record a
    // supplier offer (protected; guard action
    // demand.procurement.offers.create; the acting person BECOMES the
    // supplier — there is no supplierPersonId input; the
    // qualified-demand gate and the consent grant are
    // server-derived/server-written).
    if (
      path.startsWith("/api/demand/procurement/pools/") &&
      path.endsWith("/offers") &&
      method === "POST" &&
      opts.commands
    ) {
      const commands = opts.commands;
      const id = path.slice(
        "/api/demand/procurement/pools/".length,
        -"/offers".length,
      );
      const guarded = await guardMutation(
        ctx,
        req,
        "demand.procurement.offers.create",
        "*",
        res,
      );
      if (!guarded) return true;
      const body = await readBody(req);
      const obj = requireBodyObject(body);
      const result = await runWithExecutionContextAsync(guarded.execution, () =>
        commands.createSupplierOffer(guarded.execution, guarded.personId, {
          organizationScopeId: strField(obj, "organizationScopeId"),
          poolId: id,
          attributes: obj.attributes,
          ...(obj.validUntil !== undefined && obj.validUntil !== null
            ? { validUntil: obj.validUntil as string }
            : {}),
          consent: obj.consent,
          idempotencyKey: strField(obj, "idempotencyKey"),
        }),
      );
      await send(res, 201, result);
      return true;
    }

    // POST /api/demand/procurement/offers/:id/withdrawal — withdraw
    // the supplier offer (one-way, supplier-only; protected; guard
    // action demand.procurement.offers.withdraw — the consent
    // revocation).
    if (
      path.startsWith("/api/demand/procurement/offers/") &&
      path.endsWith("/withdrawal") &&
      method === "POST" &&
      opts.commands
    ) {
      const commands = opts.commands;
      const id = path.slice(
        "/api/demand/procurement/offers/".length,
        -"/withdrawal".length,
      );
      const guarded = await guardMutation(
        ctx,
        req,
        "demand.procurement.offers.withdraw",
        "*",
        res,
      );
      if (!guarded) return true;
      const body = await readBody(req);
      const obj = requireBodyObject(body);
      const result = await runWithExecutionContextAsync(guarded.execution, () =>
        commands.withdrawSupplierOffer(guarded.execution, guarded.personId, {
          organizationScopeId: strField(obj, "organizationScopeId"),
          offerId: id,
          ...(obj.reason !== undefined && obj.reason !== null
            ? { reason: obj.reason as string }
            : {}),
          idempotencyKey: strField(obj, "idempotencyKey"),
        }),
      );
      await send(res, 200, result);
      return true;
    }

    // POST /api/demand/procurement/offers/mine — list the
    // AUTHENTICATED ACTOR'S OWN offers (protected; guard action
    // demand.procurement.offers.read). The ONLY offer read surface:
    // the supplier is the server-resolved actor (there is no
    // supplierPersonId input); individual supplier offers are never
    // exposed through any other route.
    if (
      path === "/api/demand/procurement/offers/mine" &&
      method === "POST" &&
      opts.commands
    ) {
      const commands = opts.commands;
      const guarded = await guardMutation(
        ctx,
        req,
        "demand.procurement.offers.read",
        "*",
        res,
      );
      if (!guarded) return true;
      const body = await readBody(req);
      const obj = requireBodyObject(body);
      const result = await runWithExecutionContextAsync(guarded.execution, () =>
        commands.listMySupplierOffers(guarded.execution, guarded.personId, {
          organizationScopeId: strField(obj, "organizationScopeId"),
          ...(obj.poolId !== undefined && obj.poolId !== null
            ? { poolId: obj.poolId as string }
            : {}),
        }),
      );
      await send(res, 200, result);
      return true;
    }

    // POST /api/demand/procurement/pools/:id/competitive-selection —
    // THE DERIVED SELECTION VIEW (protected; guard action
    // demand.procurement.selections.evaluate; pool-creator-only): the
    // deterministic hard-eligibility + ranking derivation at ONE
    // explicit evaluation anchor. A 200 DECISION for every outcome
    // (qualified or not, eligible offers or none — the decision is
    // the product). There is NO offer-set/eligibility/ranking/
    // selection input: every caller field beyond scope/pool identity
    // is ignored.
    if (
      path.startsWith("/api/demand/procurement/pools/") &&
      path.endsWith("/competitive-selection") &&
      method === "POST" &&
      opts.commands
    ) {
      const commands = opts.commands;
      const id = path.slice(
        "/api/demand/procurement/pools/".length,
        -"/competitive-selection".length,
      );
      const guarded = await guardMutation(
        ctx,
        req,
        "demand.procurement.selections.evaluate",
        "*",
        res,
      );
      if (!guarded) return true;
      const body = await readBody(req);
      const obj = requireBodyObject(body);
      const view = await runWithExecutionContextAsync(guarded.execution, () =>
        commands.evaluateCompetitiveSelection(
          guarded.execution,
          guarded.personId,
          {
            organizationScopeId: strField(obj, "organizationScopeId"),
            poolId: id,
          },
        ),
      );
      await send(res, 200, view);
      return true;
    }

    // POST /api/demand/procurement/pools/:id/selection-records —
    // record the AUTHORITATIVE competitive selection lineage record
    // (protected; guard action demand.procurement.selections.record;
    // pool-creator-only): the selection is re-derived INSIDE the
    // authoritative transaction from CURRENT records — nothing
    // caller-asserted qualifies, ranks or selects. Fails closed when
    // the pool is not currently qualified.
    if (
      path.startsWith("/api/demand/procurement/pools/") &&
      path.endsWith("/selection-records") &&
      method === "POST" &&
      opts.commands
    ) {
      const commands = opts.commands;
      const id = path.slice(
        "/api/demand/procurement/pools/".length,
        -"/selection-records".length,
      );
      const guarded = await guardMutation(
        ctx,
        req,
        "demand.procurement.selections.record",
        "*",
        res,
      );
      if (!guarded) return true;
      const body = await readBody(req);
      const obj = requireBodyObject(body);
      const result = await runWithExecutionContextAsync(guarded.execution, () =>
        commands.recordCompetitiveSelection(
          guarded.execution,
          guarded.personId,
          {
            organizationScopeId: strField(obj, "organizationScopeId"),
            poolId: id,
            idempotencyKey: strField(obj, "idempotencyKey"),
          },
        ),
      );
      await send(res, 201, result);
      return true;
    }

    // POST /api/demand/procurement/pools/:id/selections — list the
    // pool's selection lineage records (protected; guard action
    // demand.procurement.selections.read; pool-creator-only — the
    // service re-derives the creator gate server-side).
    if (
      path.startsWith("/api/demand/procurement/pools/") &&
      path.endsWith("/selections") &&
      method === "POST" &&
      opts.commands
    ) {
      const commands = opts.commands;
      const id = path.slice(
        "/api/demand/procurement/pools/".length,
        -"/selections".length,
      );
      const guarded = await guardMutation(
        ctx,
        req,
        "demand.procurement.selections.read",
        "*",
        res,
      );
      if (!guarded) return true;
      const body = await readBody(req);
      const obj = requireBodyObject(body);
      const result = await runWithExecutionContextAsync(guarded.execution, () =>
        commands.listPoolSelections(guarded.execution, guarded.personId, {
          organizationScopeId: strField(obj, "organizationScopeId"),
          poolId: id,
        }),
      );
      await send(res, 200, result);
      return true;
    }

    // POST /api/demand/procurement/pools/:id/baselines — establish
    // the explicit baseline/counterfactual record (protected; guard
    // action demand.procurement.baselines.create; pool-creator-only;
    // the kind/method/version/window/population/value/confidence/
    // provenance/evidence contract is validated fail-closed and the
    // evidence references resolve through the NEUTRAL /evidence
    // lookup — scope + subject binding enforced).
    if (
      path.startsWith("/api/demand/procurement/pools/") &&
      path.endsWith("/baselines") &&
      method === "POST" &&
      opts.commands
    ) {
      const commands = opts.commands;
      const id = path.slice(
        "/api/demand/procurement/pools/".length,
        -"/baselines".length,
      );
      const guarded = await guardMutation(
        ctx,
        req,
        "demand.procurement.baselines.create",
        "*",
        res,
      );
      if (!guarded) return true;
      const body = await readBody(req);
      const obj = requireBodyObject(body);
      const result = await runWithExecutionContextAsync(guarded.execution, () =>
        commands.createProcurementBaseline(guarded.execution, guarded.personId, {
          organizationScopeId: strField(obj, "organizationScopeId"),
          poolId: id,
          baselineKind: strField(obj, "baselineKind"),
          method: strField(obj, "method"),
          methodVersion: strField(obj, "methodVersion"),
          comparisonWindow: obj.comparisonWindow,
          population: strField(obj, "population"),
          baselineValue: obj.baselineValue,
          confidence: obj.confidence,
          provenance: obj.provenance,
          evidenceIds: obj.evidenceIds,
          idempotencyKey: strField(obj, "idempotencyKey"),
        }),
      );
      await send(res, 201, result);
      return true;
    }

    // POST /api/demand/procurement/pools/:id/baselines/list — list
    // the pool's baselines (protected; guard action
    // demand.procurement.baselines.read; pool-creator-only — the
    // service re-derives the creator gate server-side).
    if (
      path.startsWith("/api/demand/procurement/pools/") &&
      path.endsWith("/baselines/list") &&
      method === "POST" &&
      opts.commands
    ) {
      const commands = opts.commands;
      const id = path.slice(
        "/api/demand/procurement/pools/".length,
        -"/baselines/list".length,
      );
      const guarded = await guardMutation(
        ctx,
        req,
        "demand.procurement.baselines.read",
        "*",
        res,
      );
      if (!guarded) return true;
      const body = await readBody(req);
      const obj = requireBodyObject(body);
      const result = await runWithExecutionContextAsync(guarded.execution, () =>
        commands.listPoolBaselines(guarded.execution, guarded.personId, {
          organizationScopeId: strField(obj, "organizationScopeId"),
          poolId: id,
        }),
      );
      await send(res, 200, result);
      return true;
    }

    // POST /api/demand/procurement/baselines/:id/invalidation —
    // invalidate the baseline (ONE-WAY, pool-creator-only; protected;
    // guard action demand.procurement.baselines.invalidate; a closed
    // invalidation-reason vocabulary — an invalidated baseline can
    // never again support a savings derivation).
    if (
      path.startsWith("/api/demand/procurement/baselines/") &&
      path.endsWith("/invalidation") &&
      method === "POST" &&
      opts.commands
    ) {
      const commands = opts.commands;
      const id = path.slice(
        "/api/demand/procurement/baselines/".length,
        -"/invalidation".length,
      );
      const guarded = await guardMutation(
        ctx,
        req,
        "demand.procurement.baselines.invalidate",
        "*",
        res,
      );
      if (!guarded) return true;
      const body = await readBody(req);
      const obj = requireBodyObject(body);
      const result = await runWithExecutionContextAsync(guarded.execution, () =>
        commands.invalidateProcurementBaseline(guarded.execution, guarded.personId, {
          organizationScopeId: strField(obj, "organizationScopeId"),
          baselineId: id,
          reason: strField(obj, "reason"),
          idempotencyKey: strField(obj, "idempotencyKey"),
        }),
      );
      await send(res, 200, result);
      return true;
    }

    // POST /api/demand/procurement/pools/:id/savings-evaluation —
    // THE DERIVED SAVINGS VIEW (protected; guard action
    // demand.procurement.savings.evaluate; pool-creator-only): the
    // deterministic, uncertainty-preserving derivation at ONE
    // explicit evaluation anchor — a DERIVED 200 decision for every
    // outcome (supported or not, the decision is the product; there
    // is NO savings value/confidence/supported input).
    if (
      path.startsWith("/api/demand/procurement/pools/") &&
      path.endsWith("/savings-evaluation") &&
      method === "POST" &&
      opts.commands
    ) {
      const commands = opts.commands;
      const id = path.slice(
        "/api/demand/procurement/pools/".length,
        -"/savings-evaluation".length,
      );
      const guarded = await guardMutation(
        ctx,
        req,
        "demand.procurement.savings.evaluate",
        "*",
        res,
      );
      if (!guarded) return true;
      const body = await readBody(req);
      const obj = requireBodyObject(body);
      const result = await runWithExecutionContextAsync(guarded.execution, () =>
        commands.evaluateProcurementSavings(guarded.execution, guarded.personId, {
          organizationScopeId: strField(obj, "organizationScopeId"),
          poolId: id,
          baselineId: strField(obj, "baselineId"),
          outcomeObservationIds: obj.outcomeObservationIds,
          ...(obj.selectionId !== undefined && obj.selectionId !== null
            ? { selectionId: obj.selectionId as string }
            : {}),
        }),
      );
      await send(res, 200, result);
      return true;
    }

    // POST /api/demand/procurement/pools/:id/savings-records —
    // record the AUTHORITATIVE savings lineage (protected; guard
    // action demand.procurement.savings.record; pool-creator-only):
    // the derivation is re-executed INSIDE the authoritative
    // transaction from CURRENT records and FAILS CLOSED when the
    // evidence is invalid, stale or insufficient (a verified savings
    // claim is a measurement decision, never an economic mutation).
    if (
      path.startsWith("/api/demand/procurement/pools/") &&
      path.endsWith("/savings-records") &&
      method === "POST" &&
      opts.commands
    ) {
      const commands = opts.commands;
      const id = path.slice(
        "/api/demand/procurement/pools/".length,
        -"/savings-records".length,
      );
      const guarded = await guardMutation(
        ctx,
        req,
        "demand.procurement.savings.record",
        "*",
        res,
      );
      if (!guarded) return true;
      const body = await readBody(req);
      const obj = requireBodyObject(body);
      const result = await runWithExecutionContextAsync(guarded.execution, () =>
        commands.recordProcurementSavings(guarded.execution, guarded.personId, {
          organizationScopeId: strField(obj, "organizationScopeId"),
          poolId: id,
          baselineId: strField(obj, "baselineId"),
          outcomeObservationIds: obj.outcomeObservationIds,
          ...(obj.selectionId !== undefined && obj.selectionId !== null
            ? { selectionId: obj.selectionId as string }
            : {}),
          idempotencyKey: strField(obj, "idempotencyKey"),
        }),
      );
      await send(res, 201, result);
      return true;
    }

    // POST /api/demand/procurement/pools/:id/savings — list the
    // pool's savings lineage records (protected; guard action
    // demand.procurement.savings.read; pool-creator-only — the
    // service re-derives the creator gate server-side).
    if (
      path.startsWith("/api/demand/procurement/pools/") &&
      path.endsWith("/savings") &&
      method === "POST" &&
      opts.commands
    ) {
      const commands = opts.commands;
      const id = path.slice(
        "/api/demand/procurement/pools/".length,
        -"/savings".length,
      );
      const guarded = await guardMutation(
        ctx,
        req,
        "demand.procurement.savings.read",
        "*",
        res,
      );
      if (!guarded) return true;
      const body = await readBody(req);
      const obj = requireBodyObject(body);
      const result = await runWithExecutionContextAsync(guarded.execution, () =>
        commands.listPoolSavings(guarded.execution, guarded.personId, {
          organizationScopeId: strField(obj, "organizationScopeId"),
          poolId: id,
        }),
      );
      await send(res, 200, result);
      return true;
    }

    // -----------------------------------------------------------------
    // NET-W028 — Benefit Pools (/api/benefits/*).
    // -----------------------------------------------------------------

    // POST /api/benefits/policies — create a benefit allocation
    // policy version (protected; guard action benefits.policy.create;
    // append-only versioned lineage under the organization-
    // independent mutex — a lineage can never fork).
    if (
      path === "/api/benefits/policies" &&
      method === "POST" &&
      opts.commands
    ) {
      const commands = opts.commands;
      const guarded = await guardMutation(
        ctx,
        req,
        "benefits.policy.create",
        "*",
        res,
      );
      if (!guarded) return true;
      const body = await readBody(req);
      const obj = requireBodyObject(body);
      const result = await runWithExecutionContextAsync(guarded.execution, () =>
        commands.createBenefitPoolPolicy(guarded.execution, guarded.personId, {
          organizationScopeId: strField(obj, "organizationScopeId"),
          policyId: strField(obj, "policyId"),
          version: obj.version,
          benefitType: strField(obj, "benefitType"),
          eligibilityCriteria: obj.eligibilityCriteria,
          memberDeclarations: obj.memberDeclarations,
          remainderDisposition: strField(obj, "remainderDisposition"),
          ...(obj.rewardPolicyId !== undefined && obj.rewardPolicyId !== null
            ? { rewardPolicyId: obj.rewardPolicyId }
            : {}),
          ...(obj.description !== undefined ? { description: obj.description } : {}),
          idempotencyKey: strField(obj, "idempotencyKey"),
        }),
      );
      await send(res, 201, result);
      return true;
    }

    // POST /api/benefits/policies/:id/list — list the policy lineage
    // versions (protected; guard action benefits.policy.read).
    if (
      path.startsWith("/api/benefits/policies/") &&
      path.endsWith("/list") &&
      method === "POST" &&
      opts.commands
    ) {
      const commands = opts.commands;
      const id = path.slice(
        "/api/benefits/policies/".length,
        -"/list".length,
      );
      const guarded = await guardMutation(
        ctx,
        req,
        "benefits.policy.read",
        "*",
        res,
      );
      if (!guarded) return true;
      const body = await readBody(req);
      const obj = requireBodyObject(body);
      const result = await runWithExecutionContextAsync(guarded.execution, () =>
        commands.listBenefitPolicyVersions(guarded.execution, guarded.personId, {
          organizationScopeId: strField(obj, "organizationScopeId"),
          policyId: id,
        }),
      );
      await send(res, 200, result);
      return true;
    }

    // POST /api/benefits/pools — create the Benefit Pool (protected;
    // guard action benefits.pool.create; funding REFERENCES only —
    // there is deliberately NO funded-amount input anywhere).
    if (
      path === "/api/benefits/pools" &&
      method === "POST" &&
      opts.commands
    ) {
      const commands = opts.commands;
      const guarded = await guardMutation(
        ctx,
        req,
        "benefits.pool.create",
        "*",
        res,
      );
      if (!guarded) return true;
      const body = await readBody(req);
      const obj = requireBodyObject(body);
      const result = await runWithExecutionContextAsync(guarded.execution, () =>
        commands.createBenefitPool(guarded.execution, guarded.personId, {
          organizationScopeId: strField(obj, "organizationScopeId"),
          policyId: strField(obj, "policyId"),
          ...(obj.policyVersion !== undefined && obj.policyVersion !== null
            ? { policyVersion: obj.policyVersion }
            : {}),
          fundingRefs: obj.fundingRefs,
          idempotencyKey: strField(obj, "idempotencyKey"),
        }),
      );
      await send(res, 201, result);
      return true;
    }

    // POST /api/benefits/pools/:id/closure — close the pool (ONE-WAY;
    // protected; guard action benefits.pool.close; pool-creator-only
    // — a closed pool can never re-open or allocate again).
    if (
      path.startsWith("/api/benefits/pools/") &&
      path.endsWith("/closure") &&
      method === "POST" &&
      opts.commands
    ) {
      const commands = opts.commands;
      const id = path.slice(
        "/api/benefits/pools/".length,
        -"/closure".length,
      );
      const guarded = await guardMutation(
        ctx,
        req,
        "benefits.pool.close",
        "*",
        res,
      );
      if (!guarded) return true;
      const body = await readBody(req);
      const obj = requireBodyObject(body);
      const result = await runWithExecutionContextAsync(guarded.execution, () =>
        commands.closeBenefitPool(guarded.execution, guarded.personId, {
          organizationScopeId: strField(obj, "organizationScopeId"),
          poolId: id,
          idempotencyKey: strField(obj, "idempotencyKey"),
        }),
      );
      await send(res, 200, result);
      return true;
    }

    // POST /api/benefits/pools/list — list the acting member's
    // benefit pools (protected; guard action benefits.pool.read;
    // creator-scoped).
    if (
      path === "/api/benefits/pools/list" &&
      method === "POST" &&
      opts.commands
    ) {
      const commands = opts.commands;
      const guarded = await guardMutation(
        ctx,
        req,
        "benefits.pool.read",
        "*",
        res,
      );
      if (!guarded) return true;
      const body = await readBody(req);
      const obj = requireBodyObject(body);
      const result = await runWithExecutionContextAsync(guarded.execution, () =>
        commands.listBenefitPools(guarded.execution, guarded.personId, {
          organizationScopeId: strField(obj, "organizationScopeId"),
        }),
      );
      await send(res, 200, result);
      return true;
    }

    // POST /api/benefits/pools/:id/allocation/evaluate — THE DERIVED
    // ALLOCATION VIEW (protected; guard action
    // benefits.allocation.evaluate; pool-creator-only — a derived 200
    // decision: the current funding + eligibility + plan derivation).
    if (
      path.startsWith("/api/benefits/pools/") &&
      path.endsWith("/allocation/evaluate") &&
      method === "POST" &&
      opts.commands
    ) {
      const commands = opts.commands;
      const id = path.slice(
        "/api/benefits/pools/".length,
        -"/allocation/evaluate".length,
      );
      const guarded = await guardMutation(
        ctx,
        req,
        "benefits.allocation.evaluate",
        "*",
        res,
      );
      if (!guarded) return true;
      const body = await readBody(req);
      const obj = requireBodyObject(body);
      const result = await runWithExecutionContextAsync(guarded.execution, () =>
        commands.evaluatePoolAllocation(guarded.execution, guarded.personId, {
          organizationScopeId: strField(obj, "organizationScopeId"),
          poolId: id,
        }),
      );
      await send(res, 200, result);
      return true;
    }

    // POST /api/benefits/pools/:id/allocations — THE ATOMIC
    // ALLOCATION OPERATION (protected; guard action
    // benefits.allocation.execute; pool-creator-only — ONE
    // exactly-once economic unit: funding + eligibility re-derived
    // in-tx, the deterministic plan, conservation, and the
    // /settlement reward-allocation draw WithinTx).
    if (
      path.startsWith("/api/benefits/pools/") &&
      path.endsWith("/allocations") &&
      method === "POST" &&
      opts.commands
    ) {
      const commands = opts.commands;
      const id = path.slice(
        "/api/benefits/pools/".length,
        -"/allocations".length,
      );
      const guarded = await guardMutation(
        ctx,
        req,
        "benefits.allocation.execute",
        "*",
        res,
      );
      if (!guarded) return true;
      const body = await readBody(req);
      const obj = requireBodyObject(body);
      const result = await runWithExecutionContextAsync(guarded.execution, () =>
        commands.allocatePoolBenefits(guarded.execution, guarded.personId, {
          organizationScopeId: strField(obj, "organizationScopeId"),
          poolId: id,
          ...(obj.valueRecordId !== undefined && obj.valueRecordId !== null
            ? { valueRecordId: obj.valueRecordId }
            : {}),
          ...(obj.amount !== undefined && obj.amount !== null
            ? { amount: obj.amount }
            : {}),
          idempotencyKey: strField(obj, "idempotencyKey"),
        }),
      );
      await send(res, 201, result);
      return true;
    }

    // POST /api/benefits/pools/:id/allocations/list — the pool's
    // allocation lineage (protected; guard action
    // benefits.allocation.read; pool-creator-only).
    if (
      path.startsWith("/api/benefits/pools/") &&
      path.endsWith("/allocations/list") &&
      method === "POST" &&
      opts.commands
    ) {
      const commands = opts.commands;
      const id = path.slice(
        "/api/benefits/pools/".length,
        -"/allocations/list".length,
      );
      const guarded = await guardMutation(
        ctx,
        req,
        "benefits.allocation.read",
        "*",
        res,
      );
      if (!guarded) return true;
      const body = await readBody(req);
      const obj = requireBodyObject(body);
      const result = await runWithExecutionContextAsync(guarded.execution, () =>
        commands.listPoolAllocations(guarded.execution, guarded.personId, {
          organizationScopeId: strField(obj, "organizationScopeId"),
          poolId: id,
        }),
      );
      await send(res, 200, result);
      return true;
    }

    // POST /api/benefits/pools/:id/member-view — THE PRIVACY-
    // PRESERVING MEMBER VIEW (protected; guard action
    // benefits.member.read; the acting member sees THEIR OWN shares
    // and totals ONLY).
    if (
      path.startsWith("/api/benefits/pools/") &&
      path.endsWith("/member-view") &&
      method === "POST" &&
      opts.commands
    ) {
      const commands = opts.commands;
      const id = path.slice(
        "/api/benefits/pools/".length,
        -"/member-view".length,
      );
      const guarded = await guardMutation(
        ctx,
        req,
        "benefits.member.read",
        "*",
        res,
      );
      if (!guarded) return true;
      const body = await readBody(req);
      const obj = requireBodyObject(body);
      const result = await runWithExecutionContextAsync(guarded.execution, () =>
        commands.getMemberBenefitView(guarded.execution, guarded.personId, {
          organizationScopeId: strField(obj, "organizationScopeId"),
          poolId: id,
        }),
      );
      await send(res, 200, result);
      return true;
    }

    // GET /api/demand/procurement/pools/:id — one procurement pool
    // (public; tenant-scoped; pool metadata only — no commitment
    // data; a cross-scope id is not found).
    if (
      path.startsWith("/api/demand/procurement/pools/") &&
      !path.includes("/closure") &&
      !path.includes("/qualified-aggregate") &&
      method === "GET" &&
      opts.commands
    ) {
      const id = path.slice("/api/demand/procurement/pools/".length);
      const url = new URL(req.url ?? "/", "http://localhost");
      const organizationScopeId = url.searchParams.get("organizationScopeId");
      if (!organizationScopeId) {
        throw apiValidationError('query parameter "organizationScopeId" is required');
      }
      const view = await opts.commands.getProcurementPool(
        ctx,
        organizationScopeId,
        id,
      );
      await send(res, 200, view);
      return true;
    }

    // GET /api/demand/procurement/pools — an org's procurement pools
    // (public; tenant-scoped; pool metadata only; optional
    // categoryKey/closed filters).
    if (
      path === "/api/demand/procurement/pools" &&
      method === "GET" &&
      opts.commands
    ) {
      const url = new URL(req.url ?? "/", "http://localhost");
      const organizationScopeId = url.searchParams.get("organizationScopeId");
      if (!organizationScopeId) {
        throw apiValidationError('query parameter "organizationScopeId" is required');
      }
      const categoryKey = url.searchParams.get("categoryKey") ?? undefined;
      const closedParam = url.searchParams.get("closed");
      const closed =
        closedParam === null
          ? undefined
          : closedParam === "true"
            ? true
            : closedParam === "false"
              ? false
              : undefined;
      const view = await opts.commands.listProcurementPools(
        ctx,
        organizationScopeId,
        categoryKey,
        closed,
      );
      await send(res, 200, view);
      return true;
    }

    // GET /api/inventory/items/:id — one inventory item (public;
    // tenant-scoped; a cross-scope id is not found).
    if (
      path.startsWith("/api/inventory/items/") &&
      method === "GET" &&
      opts.commands
    ) {
      const id = path.slice("/api/inventory/items/".length);
      const url = new URL(req.url ?? "/", "http://localhost");
      const organizationScopeId = url.searchParams.get("organizationScopeId");
      if (!organizationScopeId) {
        throw apiValidationError('query parameter "organizationScopeId" is required');
      }
      const view = await opts.commands.getInventoryItem(
        ctx,
        organizationScopeId,
        id,
      );
      await send(res, 200, view);
      return true;
    }

    // GET /api/inventory/items — an org's inventory items (public;
    // tenant-scoped; optional surfaceKind/format/ownerPersonId/retired
    // filters).
    if (
      path === "/api/inventory/items" &&
      method === "GET" &&
      opts.commands
    ) {
      const url = new URL(req.url ?? "/", "http://localhost");
      const organizationScopeId = url.searchParams.get("organizationScopeId");
      if (!organizationScopeId) {
        throw apiValidationError('query parameter "organizationScopeId" is required');
      }
      const retiredParam = url.searchParams.get("retired");
      const views = await opts.commands.listInventoryItems(
        ctx,
        organizationScopeId,
        url.searchParams.get("surfaceKind") ?? undefined,
        url.searchParams.get("format") ?? undefined,
        url.searchParams.get("ownerPersonId") ?? undefined,
        retiredParam === null ? undefined : retiredParam === "true",
      );
      await send(res, 200, { organizationScopeId, items: views });
      return true;
    }

    // GET /api/inventory/placements/:id — one placement (public;
    // tenant-scoped; a cross-scope id is not found).
    if (
      path.startsWith("/api/inventory/placements/") &&
      method === "GET" &&
      opts.commands
    ) {
      const id = path.slice("/api/inventory/placements/".length);
      const url = new URL(req.url ?? "/", "http://localhost");
      const organizationScopeId = url.searchParams.get("organizationScopeId");
      if (!organizationScopeId) {
        throw apiValidationError('query parameter "organizationScopeId" is required');
      }
      const view = await opts.commands.getPlacement(
        ctx,
        organizationScopeId,
        id,
      );
      await send(res, 200, view);
      return true;
    }

    // GET /api/inventory/placements — an org's placements (public;
    // tenant-scoped; optional inventoryItemId/campaignId/
    // ownerPersonId/retired filters).
    if (
      path === "/api/inventory/placements" &&
      method === "GET" &&
      opts.commands
    ) {
      const url = new URL(req.url ?? "/", "http://localhost");
      const organizationScopeId = url.searchParams.get("organizationScopeId");
      if (!organizationScopeId) {
        throw apiValidationError('query parameter "organizationScopeId" is required');
      }
      const retiredParam = url.searchParams.get("retired");
      const views = await opts.commands.listPlacements(
        ctx,
        organizationScopeId,
        url.searchParams.get("inventoryItemId") ?? undefined,
        url.searchParams.get("campaignId") ?? undefined,
        url.searchParams.get("ownerPersonId") ?? undefined,
        retiredParam === null ? undefined : retiredParam === "true",
      );
      await send(res, 200, { organizationScopeId, placements: views });
      return true;
    }

    // GET /api/creators/engagements/:id — one engagement (public;
    // tenant-scoped; a cross-scope id is not found).
    if (
      path.startsWith("/api/creators/engagements/") &&
      method === "GET" &&
      opts.commands
    ) {
      const id = path.slice("/api/creators/engagements/".length);
      const url = new URL(req.url ?? "/", "http://localhost");
      const organizationScopeId = url.searchParams.get("organizationScopeId");
      if (!organizationScopeId) {
        throw apiValidationError('query parameter "organizationScopeId" is required');
      }
      const view = await opts.commands.getEngagement(ctx, organizationScopeId, id);
      await send(res, 200, view);
      return true;
    }

    // GET /api/creators/engagements — an org's engagements,
    // optionally filtered by campaign/creator (public; tenant-scoped).
    if (path === "/api/creators/engagements" && method === "GET" && opts.commands) {
      const url = new URL(req.url ?? "/", "http://localhost");
      const organizationScopeId = url.searchParams.get("organizationScopeId");
      if (!organizationScopeId) {
        throw apiValidationError('query parameter "organizationScopeId" is required');
      }
      const campaignId = url.searchParams.get("campaignId") ?? undefined;
      const creatorPersonId = url.searchParams.get("creatorPersonId") ?? undefined;
      const views = await opts.commands.listEngagements(
        ctx,
        organizationScopeId,
        campaignId,
        creatorPersonId,
      );
      await send(res, 200, { organizationScopeId, engagements: views });
      return true;
    }

    // GET /api/creators/acceptance-policy?organizationScopeId&creatorPersonId
    // — the creator's effective acceptance policy (public read).
    if (path === "/api/creators/acceptance-policy" && method === "GET" && opts.commands) {
      const url = new URL(req.url ?? "/", "http://localhost");
      const organizationScopeId = url.searchParams.get("organizationScopeId");
      const creatorPersonId = url.searchParams.get("creatorPersonId");
      if (!organizationScopeId || !creatorPersonId) {
        throw apiValidationError(
          'query parameters "organizationScopeId" and "creatorPersonId" are required',
        );
      }
      const view = await opts.commands.getCreatorAcceptancePolicy(
        ctx,
        organizationScopeId,
        creatorPersonId,
      );
      if (!view) {
        await send(res, 404, {
          error: "not_found",
          message: `acceptance policy not found for person ${creatorPersonId} in organization scope ${organizationScopeId}`,
        });
        return true;
      }
      await send(res, 200, view);
      return true;
    }

    // GET /api/creators/usage-rights/:id — one usage-rights grant
    // view (public; tenant-scoped; optional asOf for deterministic
    // derived-status evaluation).
    if (
      path.startsWith("/api/creators/usage-rights/") &&
      method === "GET" &&
      opts.commands
    ) {
      const id = path.slice("/api/creators/usage-rights/".length);
      const url = new URL(req.url ?? "/", "http://localhost");
      const organizationScopeId = url.searchParams.get("organizationScopeId");
      if (!organizationScopeId) {
        throw apiValidationError('query parameter "organizationScopeId" is required');
      }
      const asOf = url.searchParams.get("asOf");
      const view = await opts.commands.getUsageRights(
        ctx,
        organizationScopeId,
        id,
        asOf,
      );
      await send(res, 200, view);
      return true;
    }

    // GET /api/creators/usage-rights — an org's usage-rights grants,
    // optionally narrowed by engagement (public; tenant-scoped).
    if (path === "/api/creators/usage-rights" && method === "GET" && opts.commands) {
      const url = new URL(req.url ?? "/", "http://localhost");
      const organizationScopeId = url.searchParams.get("organizationScopeId");
      if (!organizationScopeId) {
        throw apiValidationError('query parameter "organizationScopeId" is required');
      }
      const engagementId = url.searchParams.get("engagementId") ?? undefined;
      const views = await opts.commands.listUsageRights(
        ctx,
        organizationScopeId,
        engagementId,
      );
      await send(res, 200, { organizationScopeId, grants: views });
      return true;
    }

    // GET /api/creators/productions — an org's UGC productions,
    // optionally narrowed by engagement (public; tenant-scoped).
    if (path === "/api/creators/productions" && method === "GET" && opts.commands) {
      const url = new URL(req.url ?? "/", "http://localhost");
      const organizationScopeId = url.searchParams.get("organizationScopeId");
      if (!organizationScopeId) {
        throw apiValidationError('query parameter "organizationScopeId" is required');
      }
      const engagementId = url.searchParams.get("engagementId") ?? undefined;
      const views = await opts.commands.listUgcProductions(
        ctx,
        organizationScopeId,
        engagementId,
      );
      await send(res, 200, { organizationScopeId, productions: views });
      return true;
    }

    // GET /api/creators/productions/:id/deliverables — a production's
    // deliverable versions (public; tenant-scoped).
    if (
      path.startsWith("/api/creators/productions/") &&
      path.endsWith("/deliverables") &&
      method === "GET" &&
      opts.commands
    ) {
      const id = path.slice("/api/creators/productions/".length, -"/deliverables".length);
      const url = new URL(req.url ?? "/", "http://localhost");
      const organizationScopeId = url.searchParams.get("organizationScopeId");
      if (!organizationScopeId) {
        throw apiValidationError('query parameter "organizationScopeId" is required');
      }
      const views = await opts.commands.listUgcDeliverables(
        ctx,
        organizationScopeId,
        id,
      );
      await send(res, 200, { organizationScopeId, productionId: id, deliverables: views });
      return true;
    }

    // GET /api/creators/productions/:id/submissions — a production's
    // submissions (public; tenant-scoped).
    if (
      path.startsWith("/api/creators/productions/") &&
      path.endsWith("/submissions") &&
      method === "GET" &&
      opts.commands
    ) {
      const id = path.slice("/api/creators/productions/".length, -"/submissions".length);
      const url = new URL(req.url ?? "/", "http://localhost");
      const organizationScopeId = url.searchParams.get("organizationScopeId");
      if (!organizationScopeId) {
        throw apiValidationError('query parameter "organizationScopeId" is required');
      }
      const views = await opts.commands.listUgcSubmissions(
        ctx,
        organizationScopeId,
        id,
      );
      await send(res, 200, { organizationScopeId, productionId: id, submissions: views });
      return true;
    }

    // GET /api/creators/productions/:id — one UGC production (public;
    // tenant-scoped; a cross-scope id is not found).
    if (
      path.startsWith("/api/creators/productions/") &&
      method === "GET" &&
      opts.commands
    ) {
      const id = path.slice("/api/creators/productions/".length);
      const url = new URL(req.url ?? "/", "http://localhost");
      const organizationScopeId = url.searchParams.get("organizationScopeId");
      if (!organizationScopeId) {
        throw apiValidationError('query parameter "organizationScopeId" is required');
      }
      const view = await opts.commands.getUgcProduction(ctx, organizationScopeId, id);
      await send(res, 200, view);
      return true;
    }

    // GET /api/creators/by-person?organizationScopeId&creatorPersonId —
    // the profile anchored to a person in an org (public).
    if (path === "/api/creators/by-person" && method === "GET" && opts.commands) {
      const url = new URL(req.url ?? "/", "http://localhost");
      const organizationScopeId = url.searchParams.get("organizationScopeId");
      const creatorPersonId = url.searchParams.get("creatorPersonId");
      if (!organizationScopeId || !creatorPersonId) {
        throw apiValidationError(
          'query parameters "organizationScopeId" and "creatorPersonId" are required',
        );
      }
      const view = await opts.commands.getCreatorProfileByPerson(
        ctx,
        organizationScopeId,
        creatorPersonId,
      );
      if (!view) {
        await send(res, 404, {
          error: "not_found",
          message: `creator profile not found for person ${creatorPersonId} in organization scope ${organizationScopeId}`,
        });
        return true;
      }
      await send(res, 200, view);
      return true;
    }

    // GET /api/creators/:id/reputation — resolve the CURRENT profile
    // version's reputation references through the canonical
    // /reputation snapshot service (public read; TENANT-SCOPED —
    // organizationScopeId required; a cross-scope profile id is not
    // found; PR #30 review remediation).
    if (
      path.startsWith("/api/creators/") &&
      path.endsWith("/reputation") &&
      method === "GET" &&
      opts.commands
    ) {
      const profileId = path.slice("/api/creators/".length, -"/reputation".length);
      const url = new URL(req.url ?? "/", "http://localhost");
      const organizationScopeId = url.searchParams.get("organizationScopeId");
      if (!organizationScopeId) {
        throw apiValidationError('query parameter "organizationScopeId" is required');
      }
      try {
        const view = await opts.commands.resolveCreatorReputation(
          ctx,
          organizationScopeId,
          profileId,
        );
        await send(res, 200, view);
      } catch (error) {
        if (error instanceof Error && error.message.includes("not found")) {
          await send(res, 404, {
            error: "not_found",
            message: `creator profile not found: ${profileId}`,
          });
          return true;
        }
        throw error;
      }
      return true;
    }

    // GET /api/creators/:id/versions — the immutable profile versions
    // (public; TENANT-SCOPED — organizationScopeId required; a
    // cross-scope profile id is not found; PR #30 review
    // remediation).
    if (
      path.startsWith("/api/creators/") &&
      path.endsWith("/versions") &&
      method === "GET" &&
      opts.commands
    ) {
      const profileId = path.slice("/api/creators/".length, -"/versions".length);
      const url = new URL(req.url ?? "/", "http://localhost");
      const organizationScopeId = url.searchParams.get("organizationScopeId");
      if (!organizationScopeId) {
        throw apiValidationError('query parameter "organizationScopeId" is required');
      }
      try {
        const views = await opts.commands.listCreatorProfileVersions(
          ctx,
          organizationScopeId,
          profileId,
        );
        await send(res, 200, { profileId, versions: views });
      } catch (error) {
        if (error instanceof Error && error.message.includes("not found")) {
          await send(res, 404, {
            error: "not_found",
            message: `creator profile not found: ${profileId}`,
          });
          return true;
        }
        throw error;
      }
      return true;
    }

    // GET /api/creators/:id — fetch a creator profile with its
    // immutable event history (public; TENANT-SCOPED —
    // organizationScopeId required; a cross-scope profile id is not
    // found; PR #30 review remediation).
    if (path.startsWith("/api/creators/") && method === "GET" && opts.commands) {
      const id = path.slice("/api/creators/".length);
      const url = new URL(req.url ?? "/", "http://localhost");
      const organizationScopeId = url.searchParams.get("organizationScopeId");
      if (!organizationScopeId) {
        throw apiValidationError('query parameter "organizationScopeId" is required');
      }
      const view = await opts.commands.getCreatorProfile(
        ctx,
        organizationScopeId,
        id,
      );
      if (!view) {
        await send(res, 404, { error: "not_found", message: `creator profile not found: ${id}` });
        return true;
      }
      await send(res, 200, view);
      return true;
    }

    // ------------------------------------------------------------------
    // NET-W012 — helpful contributions (Proof-of-Helpfulness).
    // ------------------------------------------------------------------

    // POST /api/helpfulness-policies — define the next immutable
    // helpfulness policy version (protected; person actor).
    if (path === "/api/helpfulness-policies" && method === "POST" && opts.commands) {
      const commands = opts.commands;
      const guarded = await guardMutation(ctx, req, "helpfulness.policy", "*", res);
      if (!guarded) return true;
      const body = await readBody(req);
      const obj = requireBodyObject(body);
      const result = await runWithExecutionContextAsync(guarded.execution, () =>
        commands.defineHelpfulnessPolicy(guarded.execution, guarded.personId, {
          organizationScopeId: strField(obj, "organizationScopeId"),
          policyId: strField(obj, "policyId"),
          sections: objField(obj, "sections"),
          idempotencyKey: strField(obj, "idempotencyKey"),
        }),
      );
      await send(res, 201, result);
      return true;
    }

    // GET /api/helpfulness-policies/:policyId — list the lineage's
    // immutable versions (public).
    if (
      path.startsWith("/api/helpfulness-policies/") &&
      method === "GET" &&
      opts.commands
    ) {
      const policyId = path.slice("/api/helpfulness-policies/".length);
      const versions = await opts.commands.listHelpfulnessPolicies(ctx, policyId);
      await send(res, 200, { policies: versions });
      return true;
    }

    // POST /api/helpful-contributions — create a helpful contribution
    // + its Proof-of-Helpfulness record atomically (protected; the
    // person actor IS the contributor; fail-closed eligibility).
    if (path === "/api/helpful-contributions" && method === "POST" && opts.commands) {
      const commands = opts.commands;
      const guarded = await guardMutation(ctx, req, "helpful_contribution.create", "*", res);
      if (!guarded) return true;
      const body = await readBody(req);
      const obj = requireBodyObject(body);
      const result = await runWithExecutionContextAsync(guarded.execution, () =>
        commands.createHelpfulContribution(guarded.execution, guarded.personId, {
          opportunityId: strField(obj, "opportunityId"),
          organizationScopeId: strField(obj, "organizationScopeId"),
          contributionType: strField(obj, "contributionType"),
          submission: objField(obj, "submission"),
          helpfulnessPolicyId: strField(obj, "helpfulnessPolicyId"),
          idempotencyKey: strField(obj, "idempotencyKey"),
        }),
      );
      await send(res, 201, result);
      return true;
    }

    // POST /api/helpful-contributions/:id/recommendation — record a
    // protocol-prepared recommendation (protected; NEVER publishes).
    if (
      path.startsWith("/api/helpful-contributions/") &&
      path.endsWith("/recommendation") &&
      method === "POST" &&
      opts.commands
    ) {
      const commands = opts.commands;
      const guarded = await guardMutation(ctx, req, "helpful_recommendation.prepare", "*", res);
      if (!guarded) return true;
      const contributionId = path.slice(
        "/api/helpful-contributions/".length,
        -"/recommendation".length,
      );
      const body = await readBody(req);
      const obj = requireBodyObject(body);
      const result = await runWithExecutionContextAsync(guarded.execution, () =>
        commands.prepareHelpfulRecommendation(guarded.execution, guarded.personId, {
          contributionId,
          preparedContentRef: strField(obj, "preparedContentRef"),
          ...(obj.rationale !== undefined ? { rationale: String(obj.rationale) } : {}),
          idempotencyKey: strField(obj, "idempotencyKey"),
        }),
      );
      await send(res, 201, result);
      return true;
    }

    // POST /api/helpful-contributions/:id/publish — the USER-CONTROLLED
    // publication composite (protected; person actor MUST be the
    // contributor; walks /workflows to SUBMITTED; records publication).
    if (
      path.startsWith("/api/helpful-contributions/") &&
      path.endsWith("/publish") &&
      method === "POST" &&
      opts.commands
    ) {
      const commands = opts.commands;
      const guarded = await guardMutation(ctx, req, "helpful_contribution.publish", "*", res);
      if (!guarded) return true;
      const contributionId = path.slice(
        "/api/helpful-contributions/".length,
        -"/publish".length,
      );
      const body = await readBody(req);
      const obj = requireBodyObject(body);
      const result = await runWithExecutionContextAsync(guarded.execution, () =>
        commands.publishHelpfulContribution(guarded.execution, guarded.personId, {
          contributionId,
          idempotencyKey: strField(obj, "idempotencyKey"),
        }),
      );
      await send(res, 200, result);
      return true;
    }

    // POST /api/helpful-contributions/:id/disclosures — declare a
    // commercial disclosure (protected; contributor-only).
    if (
      path.startsWith("/api/helpful-contributions/") &&
      path.endsWith("/disclosures") &&
      method === "POST" &&
      opts.commands
    ) {
      const commands = opts.commands;
      const guarded = await guardMutation(ctx, req, "helpful_disclosure.declare", "*", res);
      if (!guarded) return true;
      const contributionId = path.slice(
        "/api/helpful-contributions/".length,
        -"/disclosures".length,
      );
      const body = await readBody(req);
      const obj = requireBodyObject(body);
      const result = await runWithExecutionContextAsync(guarded.execution, () =>
        commands.declareCommercialDisclosure(guarded.execution, guarded.personId, {
          contributionId,
          relationshipKind: strField(obj, "relationshipKind"),
          relationshipRef: strField(obj, "relationshipRef"),
          ...(obj.productRef !== undefined ? { productRef: String(obj.productRef) } : {}),
          counterpartyRef: strField(obj, "counterpartyRef"),
          ...(obj.description !== undefined ? { description: String(obj.description) } : {}),
          idempotencyKey: strField(obj, "idempotencyKey"),
        }),
      );
      await send(res, 201, result);
      return true;
    }

    // POST /api/helpful-contributions/:id/disclosures/:disclosureId/retract
    // — retract a disclosure (protected; contributor-only; terminal).
    if (
      path.startsWith("/api/helpful-contributions/") &&
      path.includes("/disclosures/") &&
      path.endsWith("/retract") &&
      method === "POST" &&
      opts.commands
    ) {
      const commands = opts.commands;
      const guarded = await guardMutation(ctx, req, "helpful_disclosure.retract", "*", res);
      if (!guarded) return true;
      const middle = path.slice(
        "/api/helpful-contributions/".length,
        -"/retract".length,
      );
      const sep = middle.indexOf("/disclosures/");
      if (sep === -1) {
        await send(res, 404, { error: "not_found", message: "invalid retract path" });
        return true;
      }
      const contributionId = middle.slice(0, sep);
      const disclosureId = middle.slice(sep + "/disclosures/".length);
      const body = await readBody(req);
      const obj = requireBodyObject(body);
      const result = await runWithExecutionContextAsync(guarded.execution, () =>
        commands.retractCommercialDisclosure(guarded.execution, guarded.personId, {
          disclosureId,
          idempotencyKey: strField(obj, "idempotencyKey"),
        }),
      );
      void contributionId;
      await send(res, 200, result);
      return true;
    }

    // POST /api/helpful-contributions/:id/advisory-scores — attach an
    // advisory model/heuristic score (protected; advisory ONLY).
    if (
      path.startsWith("/api/helpful-contributions/") &&
      path.endsWith("/advisory-scores") &&
      method === "POST" &&
      opts.commands
    ) {
      const commands = opts.commands;
      const guarded = await guardMutation(ctx, req, "helpful_advisory.record", "*", res);
      if (!guarded) return true;
      const contributionId = path.slice(
        "/api/helpful-contributions/".length,
        -"/advisory-scores".length,
      );
      const body = await readBody(req);
      const obj = requireBodyObject(body);
      const result = await runWithExecutionContextAsync(guarded.execution, () =>
        commands.attachHelpfulAdvisoryScore(guarded.execution, guarded.personId, {
          contributionId,
          kind: strField(obj, "kind"),
          methodRef: strField(obj, "methodRef"),
          methodVersion: strField(obj, "methodVersion"),
          score: numField(obj, "score"),
          idempotencyKey: strField(obj, "idempotencyKey"),
        }),
      );
      await send(res, 201, result);
      return true;
    }

    // POST /api/helpful-contributions/:id/bases — attach a
    // qualifying-basis reference (protected; lookup-verified).
    if (
      path.startsWith("/api/helpful-contributions/") &&
      path.endsWith("/bases") &&
      method === "POST" &&
      opts.commands
    ) {
      const commands = opts.commands;
      const guarded = await guardMutation(ctx, req, "helpful_poh.basis", "*", res);
      if (!guarded) return true;
      const contributionId = path.slice(
        "/api/helpful-contributions/".length,
        -"/bases".length,
      );
      const body = await readBody(req);
      const obj = requireBodyObject(body);
      const result = await runWithExecutionContextAsync(guarded.execution, () =>
        commands.attachHelpfulnessBasis(guarded.execution, guarded.personId, {
          contributionId,
          kind: strField(obj, "kind"),
          referenceId: strField(obj, "referenceId"),
          idempotencyKey: strField(obj, "idempotencyKey"),
        }),
      );
      await send(res, 201, result);
      return true;
    }

    // POST /api/helpful-contributions/:id/evaluate — evaluate the
    // Proof-of-Helpfulness deterministically (protected).
    if (
      path.startsWith("/api/helpful-contributions/") &&
      path.endsWith("/evaluate") &&
      method === "POST" &&
      opts.commands
    ) {
      const commands = opts.commands;
      const guarded = await guardMutation(ctx, req, "helpful_poh.evaluate", "*", res);
      if (!guarded) return true;
      const contributionId = path.slice(
        "/api/helpful-contributions/".length,
        -"/evaluate".length,
      );
      const body = await readBody(req);
      const obj = requireBodyObject(body);
      const result = await runWithExecutionContextAsync(guarded.execution, () =>
        commands.evaluateHelpfulness(guarded.execution, guarded.personId, {
          contributionId,
          idempotencyKey: strField(obj, "idempotencyKey"),
        }),
      );
      await send(res, 200, result);
      return true;
    }

    // GET /api/helpful-contributions/:id/disclosures — list a
    // contribution's commercial disclosures (public).
    if (
      path.startsWith("/api/helpful-contributions/") &&
      path.endsWith("/disclosures") &&
      method === "GET" &&
      opts.commands
    ) {
      const contributionId = path.slice(
        "/api/helpful-contributions/".length,
        -"/disclosures".length,
      );
      const disclosures = await opts.commands.listCommercialDisclosures(
        ctx,
        contributionId,
      );
      await send(res, 200, { disclosures });
      return true;
    }

    // GET /api/helpful-contributions/:id — fetch a helpful
    // contribution + its Proof-of-Helpfulness (public).
    if (
      path.startsWith("/api/helpful-contributions/") &&
      method === "GET" &&
      opts.commands
    ) {
      const id = path.slice("/api/helpful-contributions/".length);
      if (id.includes("/")) {
        await send(res, 404, { error: "not_found", message: `unknown helpful-contribution route: ${path}` });
        return true;
      }
      const view = await opts.commands.getHelpfulContribution(ctx, id);
      if (!view) {
        await send(res, 404, { error: "not_found", message: `helpful contribution not found: ${id}` });
        return true;
      }
      await send(res, 200, view);
      return true;
    }

    // ------------------------------------------------------------------
    // NET-W013 — quality, moderation and anti-spam controls.
    // ------------------------------------------------------------------

    // POST /api/quality-policies — define the next immutable quality
    // policy version (protected; person actor).
    if (path === "/api/quality-policies" && method === "POST" && opts.commands) {
      const commands = opts.commands;
      const guarded = await guardMutation(ctx, req, "quality.policy", "*", res);
      if (!guarded) return true;
      const body = await readBody(req);
      const obj = requireBodyObject(body);
      const result = await runWithExecutionContextAsync(guarded.execution, () =>
        commands.defineQualityPolicy(guarded.execution, guarded.personId, {
          organizationScopeId: strField(obj, "organizationScopeId"),
          policyId: strField(obj, "policyId"),
          shape: objField(obj, "shape"),
          idempotencyKey: strField(obj, "idempotencyKey"),
        }),
      );
      await send(res, 201, result);
      return true;
    }

    // GET /api/quality-policies/:policyId — list the lineage's
    // immutable versions (public).
    if (
      path.startsWith("/api/quality-policies/") &&
      method === "GET" &&
      opts.commands
    ) {
      const policyId = path.slice("/api/quality-policies/".length);
      const versions = await opts.commands.listQualityPolicies(ctx, policyId);
      await send(res, 200, { policies: versions });
      return true;
    }

    // POST /api/contributions/:id/advisory-quality-scores/generate —
    // generate an advisory score through the provider-neutral LLM port
    // (protected; the FIRST LlmPort consumer; non-authoritative).
    if (
      path.startsWith("/api/contributions/") &&
      path.endsWith("/advisory-quality-scores/generate") &&
      method === "POST" &&
      opts.commands
    ) {
      const commands = opts.commands;
      const guarded = await guardMutation(ctx, req, "quality.advisory.generate", "*", res);
      if (!guarded) return true;
      const contributionId = path.slice(
        "/api/contributions/".length,
        -"/advisory-quality-scores/generate".length,
      );
      const body = await readBody(req);
      const obj = requireBodyObject(body);
      const result = await runWithExecutionContextAsync(guarded.execution, () =>
        commands.generateAdvisoryQualityScore(guarded.execution, guarded.personId, {
          contributionId,
          ...(obj.qualityPolicyId !== undefined
            ? { qualityPolicyId: String(obj.qualityPolicyId) }
            : {}),
          idempotencyKey: strField(obj, "idempotencyKey"),
        }),
      );
      await send(res, 201, result);
      return true;
    }

    // POST /api/contributions/:id/advisory-quality-scores — attach an
    // advisory quality score manually (protected; advisory only).
    if (
      path.startsWith("/api/contributions/") &&
      path.endsWith("/advisory-quality-scores") &&
      method === "POST" &&
      opts.commands
    ) {
      const commands = opts.commands;
      const guarded = await guardMutation(ctx, req, "quality.advisory.attach", "*", res);
      if (!guarded) return true;
      const contributionId = path.slice(
        "/api/contributions/".length,
        -"/advisory-quality-scores".length,
      );
      const body = await readBody(req);
      const obj = requireBodyObject(body);
      const result = await runWithExecutionContextAsync(guarded.execution, () =>
        commands.attachAdvisoryQualityScore(guarded.execution, guarded.personId, {
          contributionId,
          organizationScopeId: strField(obj, "organizationScopeId"),
          kind: strField(obj, "kind"),
          methodRef: strField(obj, "methodRef"),
          methodVersion: strField(obj, "methodVersion"),
          ...(obj.provider !== undefined ? { provider: obj.provider as string | null } : {}),
          ...(obj.modelRef !== undefined ? { modelRef: obj.modelRef as string | null } : {}),
          score: numField(obj, "score"),
          idempotencyKey: strField(obj, "idempotencyKey"),
        }),
      );
      await send(res, 201, result);
      return true;
    }

    // GET /api/contributions/:id/advisory-quality-scores — list a
    // contribution's advisory quality scores (public).
    if (
      path.startsWith("/api/contributions/") &&
      path.endsWith("/advisory-quality-scores") &&
      method === "GET" &&
      opts.commands
    ) {
      const contributionId = path.slice(
        "/api/contributions/".length,
        -"/advisory-quality-scores".length,
      );
      const scores = await opts.commands.listAdvisoryQualityScores(
        ctx,
        contributionId,
      );
      await send(res, 200, { advisoryScores: scores });
      return true;
    }

    // POST /api/contributions/:id/quality-evaluation/preview — preview
    // the deterministic evaluation (protected; pure engine; no
    // persistence).
    if (
      path.startsWith("/api/contributions/") &&
      path.endsWith("/quality-evaluation/preview") &&
      method === "POST" &&
      opts.commands
    ) {
      const commands = opts.commands;
      const guarded = await guardMutation(ctx, req, "quality.evaluation.preview", "*", res);
      if (!guarded) return true;
      const contributionId = path.slice(
        "/api/contributions/".length,
        -"/quality-evaluation/preview".length,
      );
      const body = await readBody(req);
      const obj = requireBodyObject(body);
      const result = await runWithExecutionContextAsync(guarded.execution, () =>
        commands.previewQualityEvaluation(guarded.execution, guarded.personId, {
          contributionId,
          organizationScopeId: strField(obj, "organizationScopeId"),
          qualityPolicyId: strField(obj, "qualityPolicyId"),
          ...(obj.qualityPolicyVersion !== undefined
            ? { qualityPolicyVersion: Number(obj.qualityPolicyVersion) }
            : {}),
          evaluatedAt: strField(obj, "evaluatedAt"),
        }),
      );
      await send(res, 200, result);
      return true;
    }

    // POST /api/contributions/:id/quality-evaluation — record the
    // authoritative quality evaluation (protected; in-tx same-scope
    // policy pinning; append-only supersession).
    if (
      path.startsWith("/api/contributions/") &&
      path.endsWith("/quality-evaluation") &&
      method === "POST" &&
      opts.commands
    ) {
      const commands = opts.commands;
      const guarded = await guardMutation(ctx, req, "quality.evaluation.record", "*", res);
      if (!guarded) return true;
      const contributionId = path.slice(
        "/api/contributions/".length,
        -"/quality-evaluation".length,
      );
      const body = await readBody(req);
      const obj = requireBodyObject(body);
      const result = await runWithExecutionContextAsync(guarded.execution, () =>
        commands.recordQualityEvaluation(guarded.execution, guarded.personId, {
          contributionId,
          organizationScopeId: strField(obj, "organizationScopeId"),
          qualityPolicyId: strField(obj, "qualityPolicyId"),
          ...(obj.qualityPolicyVersion !== undefined
            ? { qualityPolicyVersion: Number(obj.qualityPolicyVersion) }
            : {}),
          evaluatedAt: strField(obj, "evaluatedAt"),
          idempotencyKey: strField(obj, "idempotencyKey"),
        }),
      );
      await send(res, 201, result);
      return true;
    }

    // GET /api/contributions/:id/quality-evaluations — the
    // contribution's evaluation history + latest (public).
    if (
      path.startsWith("/api/contributions/") &&
      path.endsWith("/quality-evaluations") &&
      method === "GET" &&
      opts.commands
    ) {
      const contributionId = path.slice(
        "/api/contributions/".length,
        -"/quality-evaluations".length,
      );
      const result = await opts.commands.getQualityEvaluationHistory(
        ctx,
        contributionId,
      );
      await send(res, 200, result);
      return true;
    }

    // POST /api/contributions/:id/moderation-decisions — record a
    // moderation decision (protected; person actor —
    // moderator-controlled; append-only; emits the spam/abuse risk
    // signal into /disputes when the reasons carry spam/abuse).
    if (
      path.startsWith("/api/contributions/") &&
      path.endsWith("/moderation-decisions") &&
      method === "POST" &&
      opts.commands
    ) {
      const commands = opts.commands;
      const guarded = await guardMutation(ctx, req, "moderation.decide", "*", res);
      if (!guarded) return true;
      const contributionId = path.slice(
        "/api/contributions/".length,
        -"/moderation-decisions".length,
      );
      const body = await readBody(req);
      const obj = requireBodyObject(body);
      const result = await runWithExecutionContextAsync(guarded.execution, () =>
        commands.recordModerationDecision(guarded.execution, guarded.personId, {
          contributionId,
          decision: strField(obj, "decision"),
          reasonKinds: strArrayField(obj, "reasonKinds"),
          ...(obj.notes !== undefined ? { notes: obj.notes as string | null } : {}),
          ...(obj.qualityEvaluationIds !== undefined
            ? { qualityEvaluationIds: obj.qualityEvaluationIds as readonly string[] }
            : {}),
          ...(obj.signalSeverity !== undefined
            ? { signalSeverity: String(obj.signalSeverity) }
            : {}),
          ...(obj.signalConfidence !== undefined
            ? { signalConfidence: Number(obj.signalConfidence) }
            : {}),
          idempotencyKey: strField(obj, "idempotencyKey"),
        }),
      );
      await send(res, 201, result);
      return true;
    }

    // GET /api/contributions/:id/moderation-decisions — the
    // contribution's append-only moderation history (public).
    if (
      path.startsWith("/api/contributions/") &&
      path.endsWith("/moderation-decisions") &&
      method === "GET" &&
      opts.commands
    ) {
      const contributionId = path.slice(
        "/api/contributions/".length,
        -"/moderation-decisions".length,
      );
      const decisions = await opts.commands.listModerationDecisions(
        ctx,
        contributionId,
      );
      await send(res, 200, { decisions });
      return true;
    }

    // GET /api/contributions/:id/moderation — the contribution's
    // DERIVED moderation status (public).
    if (
      path.startsWith("/api/contributions/") &&
      path.endsWith("/moderation") &&
      method === "GET" &&
      opts.commands
    ) {
      const contributionId = path.slice(
        "/api/contributions/".length,
        -"/moderation".length,
      );
      const summary = await opts.commands.getModerationSummary(
        ctx,
        contributionId,
      );
      await send(res, 200, summary);
      return true;
    }

    // -- NET-W014 reward and settlement integration routes ----------

    // POST /api/settlement/contribution-value — recognize qualifying
    // verified contribution value as canonical PENDING economic value
    // (protected; the deterministic qualification gate + the
    // /settlement input gate).
    if (
      path === "/api/settlement/contribution-value" &&
      method === "POST" &&
      opts.commands
    ) {
      const commands = opts.commands;
      const guarded = await guardMutation(ctx, req, "reward.recognize", "*", res);
      if (!guarded) return true;
      const body = await readBody(req);
      const obj = requireBodyObject(body);
      const result = await runWithExecutionContextAsync(guarded.execution, () =>
        commands.recognizeContributionValue(guarded.execution, guarded.personId, {
          contributionId: strField(obj, "contributionId"),
          amount: numField(obj, "amount"),
          ...(obj.maturation !== undefined
            ? { maturation: obj.maturation as Record<string, unknown> }
            : {}),
          ...(obj.description !== undefined
            ? { description: String(obj.description) }
            : {}),
          idempotencyKey: strField(obj, "idempotencyKey"),
        }),
      );
      await send(res, 201, result);
      return true;
    }

    // POST /api/settlement/clearing-executions — execute a declared
    // campaign clearing rule (protected; the deterministic draw
    // through the canonical /settlement primitive).
    if (
      path === "/api/settlement/clearing-executions" &&
      method === "POST" &&
      opts.commands
    ) {
      const commands = opts.commands;
      const guarded = await guardMutation(ctx, req, "reward.clear", "*", res);
      if (!guarded) return true;
      const body = await readBody(req);
      const obj = requireBodyObject(body);
      const result = await runWithExecutionContextAsync(guarded.execution, () =>
        commands.executeCampaignClearing(guarded.execution, guarded.personId, {
          campaignId: strField(obj, "campaignId"),
          valueRecordId: strField(obj, "valueRecordId"),
          ...(obj.clearingRuleId !== undefined
            ? { clearingRuleId: String(obj.clearingRuleId) }
            : {}),
          ...(obj.creditsPerValueUnit !== undefined
            ? { creditsPerValueUnit: Number(obj.creditsPerValueUnit) }
            : {}),
          ...(obj.cashKind !== undefined
            ? { cashKind: String(obj.cashKind) }
            : {}),
          ...(obj.counterpartyPersonId !== undefined
            ? { counterpartyPersonId: String(obj.counterpartyPersonId) }
            : {}),
          ...(obj.cashAmount !== undefined
            ? { cashAmount: Number(obj.cashAmount) }
            : {}),
          ...(obj.description !== undefined
            ? { description: String(obj.description) }
            : {}),
          idempotencyKey: strField(obj, "idempotencyKey"),
        }),
      );
      await send(res, 201, result);
      return true;
    }

    // POST /api/settlement/reputation-effects — feed ONE
    // evidence-backed reputation input from a MATERIAL settlement
    // outcome (protected; MATURE/CONSUMED value records only).
    if (
      path === "/api/settlement/reputation-effects" &&
      method === "POST" &&
      opts.commands
    ) {
      const commands = opts.commands;
      const guarded = await guardMutation(ctx, req, "reward.reputation", "*", res);
      if (!guarded) return true;
      const body = await readBody(req);
      const obj = requireBodyObject(body);
      const result = await runWithExecutionContextAsync(guarded.execution, () =>
        commands.applySettlementReputationEffect(guarded.execution, guarded.personId, {
          valueRecordId: strField(obj, "valueRecordId"),
          ...(obj.dimension !== undefined
            ? { dimension: String(obj.dimension) }
            : {}),
          ...(obj.description !== undefined
            ? { description: String(obj.description) }
            : {}),
          idempotencyKey: strField(obj, "idempotencyKey"),
        }),
      );
      await send(res, 201, result);
      return true;
    }

    // POST /api/settlement/cross-promotion-clearings — execute ONE
    // cross-promotion clearing (protected; guard action reward.clear;
    // the deterministic draw through the canonical /settlement
    // primitive, against a settlement-ready target placement, with
    // exactly-once semantics per idempotency key AND per
    // contribution-placement pair).
    if (
      path === "/api/settlement/cross-promotion-clearings" &&
      method === "POST" &&
      opts.commands
    ) {
      const commands = opts.commands;
      const guarded = await guardMutation(ctx, req, "reward.clear", "*", res);
      if (!guarded) return true;
      const body = await readBody(req);
      const obj = requireBodyObject(body);
      const result = await runWithExecutionContextAsync(guarded.execution, () =>
        commands.executeCrossPromotionClearing(guarded.execution, guarded.personId, {
          sourceContributionId: strField(obj, "sourceContributionId"),
          targetPlacementId: strField(obj, "targetPlacementId"),
          valueRecordId: strField(obj, "valueRecordId"),
          ...(obj.clearingRuleId !== undefined
            ? { clearingRuleId: String(obj.clearingRuleId) }
            : {}),
          ...(obj.creditsPerValueUnit !== undefined
            ? { creditsPerValueUnit: Number(obj.creditsPerValueUnit) }
            : {}),
          ...(obj.cashKind !== undefined
            ? { cashKind: String(obj.cashKind) }
            : {}),
          ...(obj.counterpartyPersonId !== undefined
            ? { counterpartyPersonId: String(obj.counterpartyPersonId) }
            : {}),
          ...(obj.cashAmount !== undefined
            ? { cashAmount: Number(obj.cashAmount) }
            : {}),
          ...(obj.description !== undefined
            ? { description: String(obj.description) }
            : {}),
          idempotencyKey: strField(obj, "idempotencyKey"),
        }),
      );
      await send(res, 201, result);
      return true;
    }

    // GET /api/settlement/cross-promotion-clearings/eligibility — THE
    // DERIVED eligibility view (public; re-derived from CURRENT
    // durable records on every read — never stored, never asserted).
    if (
      path === "/api/settlement/cross-promotion-clearings/eligibility" &&
      method === "GET" &&
      opts.commands
    ) {
      const commands = opts.commands;
      const url = new URL(req.url ?? "/", "http://localhost");
      const view = await runWithExecutionContextAsync(ctx, () =>
        commands.evaluateCrossPromotionClearing(ctx, {
          organizationScopeId: url.searchParams.get("organizationScopeId") ?? "",
          sourceContributionId: url.searchParams.get("sourceContributionId") ?? "",
          targetPlacementId: url.searchParams.get("targetPlacementId") ?? "",
          valueRecordId: url.searchParams.get("valueRecordId") ?? "",
          ...(url.searchParams.get("clearingRuleId") !== null
            ? { clearingRuleId: url.searchParams.get("clearingRuleId") ?? "" }
            : {}),
        }),
      );
      await send(res, 200, view);
      return true;
    }

    // GET /api/settlement/cross-promotion-clearings — the tenant's
    // clearing records (public; tenant-scoped).
    if (
      path === "/api/settlement/cross-promotion-clearings" &&
      method === "GET" &&
      opts.commands
    ) {
      const commands = opts.commands;
      const url = new URL(req.url ?? "/", "http://localhost");
      const organizationScopeId = url.searchParams.get("organizationScopeId");
      if (!organizationScopeId) {
        throw apiValidationError('query parameter "organizationScopeId" is required');
      }
      const clearings = await runWithExecutionContextAsync(ctx, () =>
        commands.listCrossPromotionClearings(ctx, organizationScopeId),
      );
      await send(res, 200, { clearings });
      return true;
    }

    // GET /api/settlement/cross-promotion-clearings/:id — one clearing
    // record (public; tenant-scoped; a cross-scope id is not found).
    if (
      path.startsWith("/api/settlement/cross-promotion-clearings/") &&
      method === "GET" &&
      opts.commands
    ) {
      const commands = opts.commands;
      const id = path.slice("/api/settlement/cross-promotion-clearings/".length);
      const url = new URL(req.url ?? "/", "http://localhost");
      const organizationScopeId = url.searchParams.get("organizationScopeId");
      if (!organizationScopeId) {
        throw apiValidationError('query parameter "organizationScopeId" is required');
      }
      const view = await runWithExecutionContextAsync(ctx, () =>
        commands.getCrossPromotionClearing(ctx, organizationScopeId, id),
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
      subjectKind !== "proof_of_value" &&
      subjectKind !== "outcome_measurement" &&
      subjectKind !== "engagement" &&
      // NET-W018: publications join the generic transition surface for
      // their GENERIC edge only (DRAFT → CANCELLED). The verification
      // edge (DRAFT → VERIFIED) is a SANCTIONED transition — it is
      // structurally absent from the generic table, so even an
      // authorized caller sending subjectKind "publication" +
      // targetState "VERIFIED" is rejected here as ILLEGAL_TRANSITION
      // (the PR #36 remediation): the edge resolves exclusively
      // through the creators domain's verification composite via the
      // in-tx twin + PUBLICATION_VERIFICATION_SANCTION.
      subjectKind !== "publication"
    ) {
      throw apiValidationError(`subjectKind must be "opportunity", "contribution", "proof_of_value", "outcome_measurement", "engagement" or "publication" (got ${String(subjectKind)})`);
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

  // Parse the seller-authorization file submissions attached to an
  // external ad-request evaluation body (NET-W023). Absent →
  // undefined; malformed → a validation error.
  function parseSellerAuthorizationSubmissions(
    obj: Record<string, unknown>,
  ):
    | {
        providerId: string;
        sourceKind: "ads.txt" | "app-ads.txt" | "sellers.json";
        content: string;
        sourceIdentity: string;
        observedAt?: string;
        integrity?: {
          algorithm: string;
          signature: string;
          signedAt: string;
        };
      }[]
    | undefined {
    const raw = obj.sellerAuthorizations;
    if (raw === undefined || raw === null) return undefined;
    if (!Array.isArray(raw)) {
      throw apiValidationError('field "sellerAuthorizations" must be an array of file submissions');
    }
    return raw.map((entry) => {
      if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
        throw apiValidationError("each sellerAuthorization must be an object");
      }
      const e = entry as Record<string, unknown>;
      const sourceKind = strField(e, "sourceKind");
      if (
        sourceKind !== "ads.txt" &&
        sourceKind !== "app-ads.txt" &&
        sourceKind !== "sellers.json"
      ) {
        throw apiValidationError(
          'sellerAuthorization sourceKind must be "ads.txt", "app-ads.txt" or "sellers.json"',
        );
      }
      // PR #47 remediation: the OPTIONAL trust envelope. Structural
      // validation only at the transport (three non-empty string
      // fields; malformed → 400 fail closed) — the cryptographic
      // verification happens at the adapters-boundary ingress, and an
      // envelope that does not verify is a DERIVED decision fact
      // (`supply_chain_unauthenticated`), never a transport error.
      // The signature value is never echoed into error payloads.
      let integrity:
        | { algorithm: string; signature: string; signedAt: string }
        | undefined;
      if (e.integrity !== undefined && e.integrity !== null) {
        if (typeof e.integrity !== "object" || Array.isArray(e.integrity)) {
          throw apiValidationError(
            'sellerAuthorization integrity must be an object with algorithm, signature and signedAt',
          );
        }
        const i = e.integrity as Record<string, unknown>;
        integrity = {
          algorithm: strField(i, "algorithm"),
          signature: strField(i, "signature"),
          signedAt: strField(i, "signedAt"),
        };
      }
      return {
        providerId: strField(e, "providerId"),
        sourceKind,
        content: strField(e, "content"),
        sourceIdentity: strField(e, "sourceIdentity"),
        ...(typeof e.observedAt === "string" ? { observedAt: e.observedAt } : {}),
        ...(integrity !== undefined ? { integrity } : {}),
      };
    });
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

  // -- NET-W006 request-body parsers ----------------------------------

  /** Parse the shared measurement-provenance shape. */
  function parseProvenanceField(obj: Record<string, unknown>): Readonly<Record<string, unknown>> {
    const provenance = obj.provenance;
    if (!provenance || typeof provenance !== "object") {
      throw apiValidationError('field "provenance" must be an object with sourceType, method and methodVersion');
    }
    const p = provenance as Record<string, unknown>;
    if (typeof p.sourceType !== "string" || !p.sourceType.trim()) {
      throw apiValidationError('field "provenance.sourceType" must be a non-empty string');
    }
    if (typeof p.method !== "string" || !p.method.trim()) {
      throw apiValidationError('field "provenance.method" must be a non-empty string');
    }
    if (typeof p.methodVersion !== "string" || !p.methodVersion.trim()) {
      throw apiValidationError('field "provenance.methodVersion" must be a non-empty string');
    }
    return p;
  }

  function parseOutcomeObservationInput(body: unknown): import("./port.ts").ApiCreateOutcomeObservationInput {
    if (!body || typeof body !== "object") {
      throw apiValidationError("request body must be a JSON object");
    }
    const obj = body as Record<string, unknown>;
    const observedValue = obj.observedValue;
    if (!observedValue || typeof observedValue !== "object") {
      throw apiValidationError('field "observedValue" must be an object with value and unit');
    }
    const ov = observedValue as Record<string, unknown>;
    return {
      organizationScopeId: strField(obj, "organizationScopeId"),
      subjectReference: parseSubjectReference(obj),
      outcomeType: strField(obj, "outcomeType"),
      outcomeClaimId: typeof obj.outcomeClaimId === "string" ? obj.outcomeClaimId : undefined,
      evidenceId: typeof obj.evidenceId === "string" ? obj.evidenceId : undefined,
      observedValue: {
        value: numField(ov, "value"),
        unit: strField(ov, "unit"),
      },
      confidence: parseConfidence(obj),
      provenance: parseProvenanceField(obj),
    };
  }

  function parseMeasurementExperimentInput(body: unknown): import("./port.ts").ApiCreateMeasurementExperimentInput {
    if (!body || typeof body !== "object") {
      throw apiValidationError("request body must be a JSON object");
    }
    const obj = body as Record<string, unknown>;
    return {
      organizationScopeId: strField(obj, "organizationScopeId"),
      experimentType: strField(obj, "experimentType"),
      hypothesis: typeof obj.hypothesis === "string" ? obj.hypothesis : undefined,
    };
  }

  function parseAttributionInput(body: unknown): import("./port.ts").ApiCreateAttributionInput {
    if (!body || typeof body !== "object") {
      throw apiValidationError("request body must be a JSON object");
    }
    const obj = body as Record<string, unknown>;
    const attributionValue = obj.attributionValue;
    if (!attributionValue || typeof attributionValue !== "object") {
      throw apiValidationError('field "attributionValue" must be an object with value and unit');
    }
    const av = attributionValue as Record<string, unknown>;
    const deterministicLink = obj.deterministicLink;
    return {
      organizationScopeId: strField(obj, "organizationScopeId"),
      observationId: strField(obj, "observationId"),
      attributedSubject: parseSubjectReference(obj),
      mode: strField(obj, "mode"),
      attributionValue: {
        value: numField(av, "value"),
        unit: strField(av, "unit"),
      },
      confidence: parseConfidence(obj),
      provenance: parseProvenanceField(obj),
      deterministicLink:
        deterministicLink && typeof deterministicLink === "object"
          ? deterministicLink as { linkType: string; linkIdentifier: string }
          : undefined,
      experimentId: typeof obj.experimentId === "string" ? obj.experimentId : undefined,
      evidenceIds: Array.isArray(obj.evidenceIds) ? (obj.evidenceIds as string[]) : undefined,
    };
  }

  function parseIncrementalityInput(body: unknown): import("./port.ts").ApiCreateIncrementalityObservationInput {
    if (!body || typeof body !== "object") {
      throw apiValidationError("request body must be a JSON object");
    }
    const obj = body as Record<string, unknown>;
    const lift = obj.lift;
    if (!lift || typeof lift !== "object") {
      throw apiValidationError('field "lift" must be an object with value and unit');
    }
    const baselineValue = obj.baselineValue;
    if (!baselineValue || typeof baselineValue !== "object") {
      throw apiValidationError('field "baselineValue" must be an object with value and unit');
    }
    return {
      organizationScopeId: strField(obj, "organizationScopeId"),
      subjectReference: parseSubjectReference(obj),
      outcomeType: strField(obj, "outcomeType"),
      lift: {
        value: numField(lift as Record<string, unknown>, "value"),
        unit: strField(lift as Record<string, unknown>, "unit"),
      },
      baselineValue: {
        value: numField(baselineValue as Record<string, unknown>, "value"),
        unit: strField(baselineValue as Record<string, unknown>, "unit"),
      },
      confidence: parseConfidence(obj),
      provenance: parseProvenanceField(obj),
      experimentId: typeof obj.experimentId === "string" ? obj.experimentId : undefined,
      evidenceIds: Array.isArray(obj.evidenceIds) ? (obj.evidenceIds as string[]) : undefined,
    };
  }

  function parseCounterfactualBaselineInput(body: unknown): import("./port.ts").ApiCreateCounterfactualBaselineInput {
    if (!body || typeof body !== "object") {
      throw apiValidationError("request body must be a JSON object");
    }
    const obj = body as Record<string, unknown>;
    const baselineValue = obj.baselineValue;
    if (!baselineValue || typeof baselineValue !== "object") {
      throw apiValidationError('field "baselineValue" must be an object with value and unit');
    }
    const comparisonValue = obj.comparisonValue;
    return {
      organizationScopeId: strField(obj, "organizationScopeId"),
      subjectReference: parseSubjectReference(obj),
      outcomeType: strField(obj, "outcomeType"),
      baselineKind: strField(obj, "baselineKind"),
      baselineValue: {
        value: numField(baselineValue as Record<string, unknown>, "value"),
        unit: strField(baselineValue as Record<string, unknown>, "unit"),
      },
      comparisonValue:
        comparisonValue && typeof comparisonValue === "object"
          ? {
              value: numField(comparisonValue as Record<string, unknown>, "value"),
              unit: strField(comparisonValue as Record<string, unknown>, "unit"),
            }
          : undefined,
      confidence: parseConfidence(obj),
      provenance: parseProvenanceField(obj),
      evidenceIds: Array.isArray(obj.evidenceIds) ? (obj.evidenceIds as string[]) : undefined,
    };
  }

  function parseMeasuredOutcomeInput(body: unknown): import("./port.ts").ApiCreateMeasuredOutcomeInput {
    if (!body || typeof body !== "object") {
      throw apiValidationError("request body must be a JSON object");
    }
    const obj = body as Record<string, unknown>;
    const maturation = obj.maturation;
    if (!maturation || typeof maturation !== "object") {
      throw apiValidationError('field "maturation" must be an object with strategy');
    }
    const m = maturation as Record<string, unknown>;
    if (typeof m.strategy !== "string" || !m.strategy.trim()) {
      throw apiValidationError('field "maturation.strategy" must be a non-empty string');
    }
    return {
      organizationScopeId: strField(obj, "organizationScopeId"),
      subjectReference: parseSubjectReference(obj),
      outcomeType: strField(obj, "outcomeType"),
      outcomeClaimId: typeof obj.outcomeClaimId === "string" ? obj.outcomeClaimId : undefined,
      maturation: m,
      rollupStrategy: typeof obj.rollupStrategy === "string" ? obj.rollupStrategy : undefined,
      observationIds: Array.isArray(obj.observationIds) ? (obj.observationIds as string[]) : undefined,
    };
  }

  // NET-W007: parse a scoring-policy create input. The rules array is
  // passed through to the domain service, which validates it fully
  // (one rule per dimension, deterministic parameters).
  function parseReputationPolicyInput(body: unknown): import("./port.ts").ApiCreateReputationPolicyInput {
    if (!body || typeof body !== "object") {
      throw apiValidationError("request body must be a JSON object");
    }
    const obj = body as Record<string, unknown>;
    const rules = obj.rules;
    if (!Array.isArray(rules) || rules.length === 0) {
      throw apiValidationError('field "rules" must be a non-empty array of scoring rules');
    }
    const version = obj.version;
    if (typeof version !== "number" || !Number.isInteger(version) || version < 1) {
      throw apiValidationError('field "version" must be a positive integer');
    }
    return {
      organizationScopeId: strField(obj, "organizationScopeId"),
      policyId: strField(obj, "policyId"),
      version,
      description: typeof obj.description === "string" ? obj.description : undefined,
      rules: rules as Record<string, unknown>[],
    };
  }

  // NET-W007: parse a reputation-input record input. sources is REQUIRED
  // (≥1 upstream reference — a bare activity/spend assertion cannot enter
  // the reputation system).
  function parseReputationInputInput(body: unknown): import("./port.ts").ApiRecordReputationInputInput {
    if (!body || typeof body !== "object") {
      throw apiValidationError("request body must be a JSON object");
    }
    const obj = body as Record<string, unknown>;
    const sources = obj.sources;
    if (!Array.isArray(sources) || sources.length === 0) {
      throw apiValidationError(
        'field "sources" must be a non-empty array of { kind, id } upstream references (evidence, proof of value, measured outcome or contribution)',
      );
    }
    for (const source of sources) {
      if (!source || typeof source !== "object") {
        throw apiValidationError('each entry of "sources" must be an object with kind and id');
      }
      const s = source as Record<string, unknown>;
      if (typeof s.kind !== "string" || !s.kind.trim()) {
        throw apiValidationError('each entry of "sources" requires a non-empty "kind"');
      }
      if (typeof s.id !== "string" || !s.id.trim()) {
        throw apiValidationError('each entry of "sources" requires a non-empty "id"');
      }
    }
    return {
      organizationScopeId: strField(obj, "organizationScopeId"),
      subjectPersonId: strField(obj, "subjectPersonId"),
      dimension: strField(obj, "dimension"),
      sources: sources as Record<string, unknown>[],
      description: typeof obj.description === "string" ? obj.description : undefined,
      occurredAt: strField(obj, "occurredAt"),
      idempotencyKey: strField(obj, "idempotencyKey"),
    };
  }

  // NET-W007: parse the shared computation/snapshot input. referenceAt is
  // REQUIRED (the deterministic decay reference — no wall clock).
  function parseReputationComputationInput(body: unknown): import("./port.ts").ApiRecordReputationSnapshotInput {
    if (!body || typeof body !== "object") {
      throw apiValidationError("request body must be a JSON object");
    }
    const obj = body as Record<string, unknown>;
    const version = obj.version;
    if (version !== undefined && (typeof version !== "number" || !Number.isInteger(version) || version < 1)) {
      throw apiValidationError('field "version" must be a positive integer when provided');
    }
    return {
      organizationScopeId: strField(obj, "organizationScopeId"),
      subjectPersonId: strField(obj, "subjectPersonId"),
      policyId: strField(obj, "policyId"),
      ...(version !== undefined ? { version } : {}),
      referenceAt: strField(obj, "referenceAt"),
      idempotencyKey: strField(obj, "idempotencyKey"),
    };
  }

  // NET-W008: parse a pending-value record input. sources is REQUIRED
  // (≥1 verified upstream reference — spend/wealth/activity/reputation
  // cannot enter the economic ledger).
  function parseEconomicValueInput(body: unknown): import("./port.ts").ApiRecordEconomicValueInput {
    if (!body || typeof body !== "object") {
      throw apiValidationError("request body must be a JSON object");
    }
    const obj = body as Record<string, unknown>;
    const sources = obj.sources;
    if (!Array.isArray(sources) || sources.length === 0) {
      throw apiValidationError(
        'field "sources" must be a non-empty array of { kind, id } upstream references (proof of value, measured outcome or evidence)',
      );
    }
    for (const source of sources) {
      if (!source || typeof source !== "object") {
        throw apiValidationError('each entry of "sources" must be an object with kind and id');
      }
      const s = source as Record<string, unknown>;
      if (typeof s.kind !== "string" || !s.kind.trim()) {
        throw apiValidationError('each entry of "sources" requires a non-empty "kind"');
      }
      if (typeof s.id !== "string" || !s.id.trim()) {
        throw apiValidationError('each entry of "sources" requires a non-empty "id"');
      }
    }
    const amount = numField(obj, "amount");
    let maturation: Record<string, unknown> | undefined;
    if (obj.maturation !== undefined) {
      if (!obj.maturation || typeof obj.maturation !== "object") {
        throw apiValidationError('field "maturation" must be an object with strategy and optional windowEndAt');
      }
      maturation = obj.maturation as Record<string, unknown>;
    }
    return {
      organizationScopeId: strField(obj, "organizationScopeId"),
      beneficiaryPersonId: strField(obj, "beneficiaryPersonId"),
      amount,
      sources: sources as Record<string, unknown>[],
      ...(maturation !== undefined ? { maturation } : {}),
      description: typeof obj.description === "string" ? obj.description : undefined,
      idempotencyKey: strField(obj, "idempotencyKey"),
    };
  }

  // NET-W008: parse the maturation input (effectiveAt is the explicit
  // deterministic reference for fixed_window policies).
  function parseMatureValueInput(
    body: unknown,
    valueRecordId: string,
  ): import("./port.ts").ApiMatureEconomicValueInput {
    if (!body || typeof body !== "object") {
      throw apiValidationError("request body must be a JSON object");
    }
    const obj = body as Record<string, unknown>;
    const effectiveAt =
      typeof obj.effectiveAt === "string" ? obj.effectiveAt : undefined;
    return {
      valueRecordId,
      ...(effectiveAt !== undefined ? { effectiveAt } : {}),
      idempotencyKey: strField(obj, "idempotencyKey"),
    };
  }

  // NET-W008: parse the shared reversal input shape (reason REQUIRED).
  function parseReversalInput(body: unknown, id: string): { id: string; reason: string; idempotencyKey: string } {
    if (!body || typeof body !== "object") {
      throw apiValidationError("request body must be a JSON object");
    }
    const obj = body as Record<string, unknown>;
    return {
      id,
      reason: strField(obj, "reason"),
      idempotencyKey: strField(obj, "idempotencyKey"),
    };
  }

  function bodyIdempotencyKey(body: unknown): string {
    if (!body || typeof body !== "object") {
      throw apiValidationError("request body must be a JSON object");
    }
    return strField(body as Record<string, unknown>, "idempotencyKey");
  }

  // NET-W008: parse the credit-issuance input (creditsPerValueUnit is
  // the explicit recorded rate).
  function parseIssueCreditsInput(body: unknown): import("./port.ts").ApiIssueCreditsInput {
    if (!body || typeof body !== "object") {
      throw apiValidationError("request body must be a JSON object");
    }
    const obj = body as Record<string, unknown>;
    return {
      organizationScopeId: strField(obj, "organizationScopeId"),
      beneficiaryPersonId: strField(obj, "beneficiaryPersonId"),
      sourceValueRecordId: strField(obj, "sourceValueRecordId"),
      creditsPerValueUnit: numField(obj, "creditsPerValueUnit"),
      description: typeof obj.description === "string" ? obj.description : undefined,
      idempotencyKey: strField(obj, "idempotencyKey"),
    };
  }

  // NET-W008: parse the reward-policy input (allocations REQUIRED).
  function parseRewardPolicyInput(body: unknown): import("./port.ts").ApiCreateRewardPolicyInput {
    if (!body || typeof body !== "object") {
      throw apiValidationError("request body must be a JSON object");
    }
    const obj = body as Record<string, unknown>;
    const allocations = obj.allocations;
    if (!Array.isArray(allocations) || allocations.length === 0) {
      throw apiValidationError(
        'field "allocations" must be a non-empty array of { beneficiaryPersonId, weight } entries',
      );
    }
    for (const allocation of allocations) {
      if (!allocation || typeof allocation !== "object") {
        throw apiValidationError('each entry of "allocations" must be an object with beneficiaryPersonId and weight');
      }
      const a = allocation as Record<string, unknown>;
      if (typeof a.beneficiaryPersonId !== "string" || !a.beneficiaryPersonId.trim()) {
        throw apiValidationError('each entry of "allocations" requires a non-empty "beneficiaryPersonId"');
      }
      if (typeof a.weight !== "number" || !Number.isFinite(a.weight)) {
        throw apiValidationError('each entry of "allocations" requires a finite numeric "weight"');
      }
    }
    const version = obj.version;
    if (typeof version !== "number" || !Number.isInteger(version) || version < 1) {
      throw apiValidationError('field "version" must be a positive integer');
    }
    return {
      organizationScopeId: strField(obj, "organizationScopeId"),
      policyId: strField(obj, "policyId"),
      version,
      description: typeof obj.description === "string" ? obj.description : undefined,
      allocations: allocations as Record<string, unknown>[],
    };
  }

  // NET-W008: parse the reward-allocation input.
  function parseAllocateRewardsInput(body: unknown): import("./port.ts").ApiAllocateRewardsInput {
    if (!body || typeof body !== "object") {
      throw apiValidationError("request body must be a JSON object");
    }
    const obj = body as Record<string, unknown>;
    const version = obj.version;
    if (version !== undefined && (typeof version !== "number" || !Number.isInteger(version) || version < 1)) {
      throw apiValidationError('field "version" must be a positive integer when provided');
    }
    return {
      organizationScopeId: strField(obj, "organizationScopeId"),
      sourceValueRecordId: strField(obj, "sourceValueRecordId"),
      policyId: strField(obj, "policyId"),
      ...(version !== undefined ? { version } : {}),
      idempotencyKey: strField(obj, "idempotencyKey"),
    };
  }

  // NET-W008: parse the cash-obligation input.
  function parseCashObligationInput(body: unknown): import("./port.ts").ApiRecordCashObligationInput {
    if (!body || typeof body !== "object") {
      throw apiValidationError("request body must be a JSON object");
    }
    const obj = body as Record<string, unknown>;
    return {
      organizationScopeId: strField(obj, "organizationScopeId"),
      kind: strField(obj, "kind"),
      counterpartyPersonId: strField(obj, "counterpartyPersonId"),
      amount: numField(obj, "amount"),
      description: typeof obj.description === "string" ? obj.description : undefined,
      idempotencyKey: strField(obj, "idempotencyKey"),
    };
  }

  // NET-W008: parse the conversion input (BOTH amounts explicit — the
  // rate is recorded, never assumed 1:1).
  function parseConversionInput(body: unknown): import("./port.ts").ApiRecordConversionInput {
    if (!body || typeof body !== "object") {
      throw apiValidationError("request body must be a JSON object");
    }
    const obj = body as Record<string, unknown>;
    return {
      organizationScopeId: strField(obj, "organizationScopeId"),
      personId: strField(obj, "personId"),
      direction: strField(obj, "direction"),
      cashAmount: numField(obj, "cashAmount"),
      creditsAmount: numField(obj, "creditsAmount"),
      description: typeof obj.description === "string" ? obj.description : undefined,
      idempotencyKey: strField(obj, "idempotencyKey"),
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

  function requireBodyObject(body: unknown): Record<string, unknown> {
    if (!body || typeof body !== "object" || Array.isArray(body)) {
      throw apiValidationError("request body must be a JSON object");
    }
    return body as Record<string, unknown>;
  }

  function objField(obj: Record<string, unknown>, key: string): Record<string, unknown> {
    const v = obj[key];
    if (!v || typeof v !== "object" || Array.isArray(v)) {
      throw apiValidationError(`field "${key}" must be a JSON object`);
    }
    return v as Record<string, unknown>;
  }

  function strArrayField(obj: Record<string, unknown>, key: string): readonly string[] {
    const v = obj[key];
    if (
      !Array.isArray(v) ||
      v.length === 0 ||
      v.some((x) => typeof x !== "string" || !x.trim())
    ) {
      throw apiValidationError(`field "${key}" must be a non-empty array of non-empty strings`);
    }
    return v as readonly string[];
  }

  // NET-W009 risk-signal body parser (create + supersede shapes).
  function parseRiskSignalInput(body: unknown): {
    organizationScopeId?: string;
    subjectPersonId?: string;
    subjectRef?: unknown;
    category: string;
    severity: string;
    confidence: number;
    provenance: Record<string, unknown>;
    description?: string;
    detectedAt: string;
    idempotencyKey: string;
  } {
    const obj = requireBodyObject(body);
    const provenance = objField(obj, "provenance");
    const sources = obj.provenance;
    if (!Array.isArray(sources) || sources.length === 0) {
      throw apiValidationError('field "provenance.sources" must be a non-empty array');
    }
    void provenance;
    const confidenceV = obj.confidence;
    if (typeof confidenceV !== "number" || !Number.isFinite(confidenceV)) {
      throw apiValidationError('field "confidence" must be a finite number in [0, 1]');
    }
    return {
      ...(obj.organizationScopeId !== undefined
        ? { organizationScopeId: strField(obj, "organizationScopeId") }
        : {}),
      ...(obj.subjectPersonId !== undefined
        ? { subjectPersonId: strField(obj, "subjectPersonId") }
        : {}),
      ...(obj.subjectRef !== undefined ? { subjectRef: obj.subjectRef } : {}),
      category: strField(obj, "category"),
      severity: strField(obj, "severity"),
      confidence: confidenceV,
      provenance: provenance as Record<string, unknown>,
      ...(obj.description !== undefined ? { description: String(obj.description) } : {}),
      detectedAt: strField(obj, "detectedAt"),
      idempotencyKey: strField(obj, "idempotencyKey"),
    };
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
