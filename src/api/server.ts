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
import { createExecutionContext, runWithExecutionContextAsync } from "../core/execution-context.ts";
import { classifyError } from "../core/errors.ts";
import type { Logger } from "../core/logger.ts";
import type { ConfigSnapshot } from "../core/config.ts";
import type { HealthAggregator } from "../observability/health.ts";
import type { ModuleRegistry } from "../core/module.ts";

export interface ApiServerOptions {
  readonly port?: number;
  readonly host?: string;
  readonly logger: Logger;
  readonly config: ConfigSnapshot;
  readonly health: HealthAggregator;
  readonly registry: ModuleRegistry;
  /** Accessor for a representative non-domain job queue (AC-03 demo). */
  readonly enqueueEchoJob?: (message: string) => Promise<string>;
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
    const actorId =
      (req.headers["x-actor-id"] as string | undefined) ?? null;

    const ctx = createExecutionContext({
      correlationId,
      causationId,
      actor: actorId ? { id: actorId, kind: "service" } : null,
    });

    await runWithExecutionContextAsync(ctx, async () => {
      const url = new URL(req.url ?? "/", "http://localhost");
      const path = url.pathname;
      const method = req.method ?? "GET";

      // Propagate correlation id back to the caller for traceability.
      res.setHeader("x-correlation-id", ctx.correlationId);
      res.setHeader("x-execution-id", ctx.executionId);

      try {
        const handled = await route(method, path, req, res);
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

  async function route(
    method: string,
    path: string,
    req: IncomingMessage,
    res: ServerResponse,
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
