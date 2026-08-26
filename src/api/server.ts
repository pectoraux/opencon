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
import { classifyError } from "../core/errors.ts";
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

    return false;
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
