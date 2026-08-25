/**
 * JobQueue & JobHandler contracts — asynchronous worker boundary.
 *
 * Work order ref: NET-W001 §4.5 (Worker boundary), §6 (JobQueue, JobHandler).
 *
 * Domain code enqueues non-domain test jobs through {@link JobQueue}; the
 * worker loop dequeues durable jobs and dispatches them to registered
 * {@link JobHandler}s. The execution/correlation context is preserved
 * across the enqueue→execute boundary via {@link deriveExecutionContext}.
 *
 * This file defines interfaces ONLY. Concrete in-memory implementation
 * lives in src/queues/in-memory-queue.ts and src/workers/worker-loop.ts.
 * NET-W001 does NOT authorize domain-specific jobs (see §4.5, §5).
 */

import type { ExecutionContext } from "./execution-context.ts";

export type JobState =
  | "pending"
  | "running"
  | "completed"
  | "failed"
  | "dead_letter";

export interface RetryPolicy {
  /** Max attempts (including the first). */
  readonly maxAttempts: number;
  /** Base backoff in ms. */
  readonly initialDelayMs: number;
  /** Backoff multiplier between attempts. */
  readonly backoffFactor: number;
  /** Max delay cap in ms. */
  readonly maxDelayMs: number;
}

export const DEFAULT_RETRY_POLICY: RetryPolicy = {
  maxAttempts: 5,
  initialDelayMs: 100,
  backoffFactor: 2,
  maxDelayMs: 30_000,
};

export interface EnqueueOptions {
  readonly idempotencyKey?: string;
  readonly priority?: number;
  readonly scheduledFor?: string;
  readonly retryPolicy?: RetryPolicy;
}

export interface JobRecord<T = unknown> {
  /** Durable job identity. Stable across retries. */
  readonly id: string;
  readonly type: string;
  readonly payload: T;
  readonly idempotencyKey: string | null;
  readonly state: JobState;
  readonly attempts: number;
  readonly maxAttempts: number;
  readonly createdAt: string;
  readonly lastError: string | null;
  readonly context: ExecutionContext;
  readonly priority: number;
}

export interface JobResult<T = unknown> {
  readonly ok: boolean;
  readonly value?: T;
  readonly error?: {
    readonly message: string;
    readonly code: string;
    readonly classification: string;
    readonly retryable: boolean;
  };
  readonly attempts: number;
  readonly durationMs: number;
}

export interface JobEnqueueResult {
  /** The durable job id. */
  readonly id: string;
  /** True if a brand-new job was enqueued. False if deduped by idempotency key. */
  readonly created: boolean;
}

export interface JobQueue {
  enqueue<T>(
    type: string,
    payload: T,
    context: ExecutionContext,
    options?: EnqueueOptions,
  ): Promise<JobEnqueueResult>;
  /** Pull the next runnable job (for the worker loop). */
  dequeue(): Promise<JobRecord | null>;
  /** Mark a job complete. */
  complete(id: string): Promise<void>;
  /** Mark a job failed and apply retry policy (or dead-letter). */
  fail(id: string, error: {
    readonly message: string;
    readonly code: string;
    readonly classification: string;
    readonly retryable: boolean;
  }): Promise<void>;
  /** Inspect a job by id (for tests). */
  inspect(id: string): Promise<JobRecord | null>;
  /** Inspect the dead-letter queue (for tests). */
  deadLetters(): Promise<readonly JobRecord[]>;
  /** Move a dead-lettered job back to pending (operational recovery). */
  requeueFromDeadLetter(id: string): Promise<void>;
}

export interface JobContext {
  readonly job: JobRecord;
  readonly context: ExecutionContext;
  /** Logger scoped to the job's execution context. */
  readonly logger: import("./logger.ts").Logger;
}

export interface JobHandler<T = unknown> {
  readonly type: string;
  handle(ctx: JobContext, payload: T): Promise<unknown>;
}

export interface WorkerStats {
  readonly processed: number;
  readonly succeeded: number;
  readonly failed: number;
  readonly deadLettered: number;
  readonly retried: number;
}
