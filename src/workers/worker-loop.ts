/**
 * Worker loop — dequeues jobs, propagates execution context, dispatches
 * to registered JobHandlers, applies retry policy, and dead-letters
 * exhausted jobs.
 *
 * Work order ref: NET-W001 §4.5 (Worker boundary), AC-03 (async execution
 * with context preservation), AC-05 (structured logs from worker).
 */

import { deriveExecutionContext, runWithExecutionContextAsync } from "../core/execution-context.ts";
import { classifyError } from "../core/errors.ts";
import type { Logger } from "../core/logger.ts";
import type {
  JobHandler,
  JobQueue,
  WorkerStats,
} from "../core/queue.ts";
import type { AuditWriter } from "../core/audit.ts";

export interface WorkerLoopOptions {
  readonly queue: JobQueue;
  readonly logger: Logger;
  readonly auditWriter?: AuditWriter;
  /** Poll interval when the queue is empty. */
  readonly pollIntervalMs?: number;
  /** Soft shutdown deadline. */
  readonly shutdownTimeoutMs?: number;
}

export interface WorkerLoop {
  registerHandler(handler: JobHandler): void;
  start(): void;
  stop(): Promise<void>;
  /** Process a single job if one is available. Returns null if queue empty. */
  processOne(): Promise<boolean>;
  /** Run until the queue drains (test helper). */
  drain(): Promise<WorkerStats>;
  stats(): WorkerStats;
}

export function createWorkerLoop(opts: WorkerLoopOptions): WorkerLoop {
  const handlers = new Map<string, JobHandler>();
  let running = false;
  let drainRequested = false;
  let timer: ReturnType<typeof setTimeout> | null = null;

  const stats: WorkerStats = {
    processed: 0,
    succeeded: 0,
    failed: 0,
    deadLettered: 0,
    retried: 0,
  };

  function bump(key: keyof WorkerStats): void {
    (stats[key] as number) += 1;
  }

  const loop: WorkerLoop = {
    registerHandler(handler) {
      if (handlers.has(handler.type)) {
        throw new Error(`handler already registered for type: ${handler.type}`);
      }
      handlers.set(handler.type, handler);
    },

    start() {
      if (running) return;
      running = true;
      drainRequested = false;
      poll();
    },

    async stop() {
      running = false;
      drainRequested = true;
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
    },

    async processOne() {
      const job = await opts.queue.dequeue();
      if (!job) return false;
      await runOne(job);
      return true;
    },

    drain() {
      return drainUntilEmpty();
    },

    stats: () => ({ ...stats }),
  };

  function poll(): void {
    if (!running) return;
    void loop
      .processOne()
      .catch((err) => {
        opts.logger.error("worker.poll_failed", err);
      })
      .finally(() => {
        if (!running) return;
        timer = setTimeout(poll, opts.pollIntervalMs ?? 50);
      });
  }

  async function runOne(job: import("../core/queue.ts").JobRecord): Promise<void> {
    const handler = handlers.get(job.type);
    // Derive a child context so the job's own executionId differs from
    // the enqueue caller's, while preserving correlation/causation.
    const childCtx = deriveExecutionContext(job.context, {
      executionId: job.id,
    });
    const jobLogger = opts.logger
      .child("worker")
      .forModule(job.type);
    const start = Date.now();
    bump("processed");
    jobLogger.info("worker.job_started", { jobId: job.id, attempt: job.attempts });

    if (!handler) {
      const err = {
        message: `no handler registered for job type: ${job.type}`,
        code: "NO_HANDLER",
        classification: "invariant",
        retryable: false,
      };
      await opts.queue.fail(job.id, err);
      bump("deadLettered");
      await maybeAudit("worker.job_dead_lettered", childCtx, job, err);
      jobLogger.error("worker.job_no_handler", err, { jobId: job.id });
      return;
    }

    try {
      await runWithExecutionContextAsync(childCtx, () =>
        handler.handle(
          {
            job,
            context: childCtx,
            logger: jobLogger,
          },
          job.payload,
        ),
      );
      await opts.queue.complete(job.id);
      bump("succeeded");
      jobLogger.info("worker.job_completed", {
        jobId: job.id,
        attempt: job.attempts,
        durationMs: Date.now() - start,
      });
      await maybeAudit("worker.job_completed", childCtx, job, null);
    } catch (err) {
      const c = classifyError(err);
      bump("failed");
      if (c.retryable && job.attempts < job.maxAttempts) bump("retried");
      await opts.queue.fail(job.id, {
        message: c.message,
        code: c.code,
        classification: c.classification,
        retryable: c.retryable,
      });
      const deadLettered = !c.retryable || job.attempts >= job.maxAttempts;
      if (deadLettered) {
        bump("deadLettered");
        await maybeAudit("worker.job_dead_lettered", childCtx, job, {
          message: c.message,
          code: c.code,
          classification: c.classification,
        });
        jobLogger.error("worker.job_dead_lettered", err, { jobId: job.id });
      } else {
        jobLogger.warn("worker.job_failed_retrying", err, {
          jobId: job.id,
          attempt: job.attempts,
        });
      }
    }
  }

  async function maybeAudit(
    eventType: string,
    context: import("../core/execution-context.ts").ExecutionContext,
    job: import("../core/queue.ts").JobRecord,
    error: { message: string; code: string; classification: string } | null,
  ): Promise<void> {
    if (!opts.auditWriter) return;
    try {
      await opts.auditWriter.append({
        eventType,
        context,
        resourceType: "job",
        resourceId: job.id,
        metadata: {
          jobType: job.type,
          attempt: job.attempts,
          ...(error ? { error } : {}),
        },
      });
    } catch (auditErr) {
      opts.logger.error("worker.audit_failed", auditErr, { jobId: job.id });
    }
  }

  async function drainUntilEmpty(): Promise<WorkerStats> {
    drainRequested = true;
    // Process synchronously until queue empty.
    // eslint-disable-next-line no-constant-condition
    while (true) {
      const job = await opts.queue.dequeue();
      if (!job) break;
      await runOne(job);
    }
    return { ...stats };
  }

  return loop;
}
