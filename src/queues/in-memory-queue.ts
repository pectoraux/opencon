/**
 * In-memory JobQueue — durable-by-contract queue implementation.
 *
 * Work order ref: NET-W001 §4.5 (Worker boundary), §6 (JobQueue),
 * AC-03 (async execution with context preservation).
 *
 * Implementation notes:
 *  - Job identity is durable: a stable id is assigned at enqueue and
 *    preserved across retries.
 *  - Idempotency: if an `idempotencyKey` was already used for a pending
 *    or running job, the enqueue returns the existing id with
 *    `created: false` (no duplicate enqueue).
 *  - Retry policy: failed jobs are re-queued up to maxAttempts, then
 *    dead-lettered. Backoff is computed but in this in-memory variant
 *    the worker loop drives re-execution immediately after delay.
 *  - Dead-letter: exhausted jobs move to state `dead_letter` and are
 *    recoverable via `requeueFromDeadLetter`.
 *  - Context propagation: the enqueued ExecutionContext is stored on
 *    the record and replayed when the worker runs the job.
 *
 * A real Redis-backed queue is the subject of NET-W003.
 */

import { randomUUID } from "node:crypto";
import type {
  EnqueueOptions,
  JobEnqueueResult,
  JobQueue,
  JobRecord,
  RetryPolicy,
} from "../core/queue.ts";
import { DEFAULT_RETRY_POLICY } from "../core/queue.ts";
import type { ExecutionContext } from "../core/execution-context.ts";

interface InternalJob {
  readonly id: string;
  readonly type: string;
  readonly payload: unknown;
  readonly idempotencyKey: string | null;
  state: JobRecord["state"];
  attempts: number;
  readonly maxAttempts: number;
  readonly createdAt: string;
  lastError: string | null;
  readonly context: ExecutionContext;
  readonly priority: number;
  readonly retryPolicy: RetryPolicy;
  nextRunAt: string;
}

export function createInMemoryJobQueue(): JobQueue & {
  /** Test accessor: pending queue length. */
  _pendingLength(): number;
  /** Test accessor: all records by id. */
  _all(): readonly JobRecord[];
} {
  const jobs = new Map<string, InternalJob>();
  const pending = new Set<string>(); // job ids ready to run
  const idempotencyIndex = new Map<string, string>(); // key -> job id
  const deadLetters = new Set<string>();

  function computeBackoff(policy: RetryPolicy, attempt: number): number {
    const delay = Math.min(
      policy.maxDelayMs,
      policy.initialDelayMs * Math.pow(policy.backoffFactor, attempt - 1),
    );
    return delay;
  }

  const queue: JobQueue = {
    async enqueue(type, payload, context, options = {}) {
      const policy = options.retryPolicy ?? DEFAULT_RETRY_POLICY;
      const idempotencyKey = options.idempotencyKey ?? null;

      if (idempotencyKey) {
        const existingId = idempotencyIndex.get(idempotencyKey);
        if (existingId) {
          const existing = jobs.get(existingId);
          if (existing && existing.state !== "completed" && existing.state !== "dead_letter") {
            return { id: existingId, created: false };
          }
        }
      }

      const id = randomUUID();
      const record: InternalJob = {
        id,
        type,
        payload,
        idempotencyKey,
        state: "pending",
        attempts: 0,
        maxAttempts: policy.maxAttempts,
        createdAt: new Date().toISOString(),
        lastError: null,
        context,
        priority: options.priority ?? 0,
        retryPolicy: policy,
        nextRunAt: options.scheduledFor ?? new Date().toISOString(),
      };
      jobs.set(id, record);
      pending.add(id);
      if (idempotencyKey) {
        idempotencyIndex.set(idempotencyKey, id);
      }
      return { id, created: true };
    },

    async dequeue() {
      const now = Date.now();
      let best: InternalJob | null = null;
      let bestId: string | null = null;
      for (const id of pending) {
        const job = jobs.get(id);
        if (!job) continue;
        if (Date.parse(job.nextRunAt) > now) continue;
        if (!best || job.priority > best.priority) {
          best = job;
          bestId = id;
        }
      }
      if (!best || !bestId) return null;
      pending.delete(bestId);
      best.state = "running";
      best.attempts += 1;
      return toJobRecord(best);
    },

    async complete(id) {
      const job = jobs.get(id);
      if (!job) return;
      job.state = "completed";
    },

    async fail(id, error) {
      const job = jobs.get(id);
      if (!job) return;
      job.lastError = error.message;
      if (error.retryable && job.attempts < job.maxAttempts) {
        // retry after backoff
        const delay = computeBackoff(job.retryPolicy, job.attempts);
        job.nextRunAt = new Date(Date.now() + delay).toISOString();
        job.state = "pending";
        pending.add(id);
      } else {
        job.state = "dead_letter";
        deadLetters.add(id);
      }
    },

    async inspect(id) {
      const job = jobs.get(id);
      return job ? toJobRecord(job) : null;
    },

    async deadLetters() {
      return Array.from(deadLetters)
        .map((id) => jobs.get(id))
        .filter((j): j is InternalJob => Boolean(j))
        .map(toJobRecord);
    },

    async requeueFromDeadLetter(id) {
      const job = jobs.get(id);
      if (!job || job.state !== "dead_letter") return;
      job.state = "pending";
      job.attempts = 0;
      job.nextRunAt = new Date().toISOString();
      deadLetters.delete(id);
      pending.add(id);
    },
  };

  function toJobRecord(job: InternalJob): JobRecord {
    return {
      id: job.id,
      type: job.type,
      payload: job.payload,
      idempotencyKey: job.idempotencyKey,
      state: job.state,
      attempts: job.attempts,
      maxAttempts: job.maxAttempts,
      createdAt: job.createdAt,
      lastError: job.lastError,
      context: job.context,
      priority: job.priority,
    };
  }

  return Object.assign(queue, {
    _pendingLength: () => pending.size,
    _all: () => Array.from(jobs.values()).map(toJobRecord),
  });
}
