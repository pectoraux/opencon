/**
 * Concrete AuditWriter — append-only audit trail.
 *
 * Work order ref: NET-W001 §4.7 (Audit foundation), AC-06.
 *
 * Implements the {@link AuditWriter} contract declared in core. Backed
 * by an append-only in-memory log (suitable for tests and the skeleton).
 * A file-backed implementation is provided in {@link createFileAuditWriter}
 * for persistence integrity tests (entries survive process restart and
 * are never mutated).
 *
 * IMmutability invariant (AC-06, deep): every event returned from
 * {@link append} or {@link query} is DEEPLY frozen — the event object,
 * its metadata, and every nested object/array reachable through it.
 * Any attempt to mutate a retrieved entry (including nested metadata)
 * throws in strict mode, so prior entries cannot be tampered with.
 * To avoid surprising callers, the event stored is a deep clone of
 * the input (the caller's metadata object is never frozen in place).
 */

import { randomUUID } from "node:crypto";
import type {
  AuditEvent,
  AuditQuery,
  AuditWriter,
} from "../core/audit.ts";
import type { ExecutionContext } from "../core/execution-context.ts";
import { AuditMutationError } from "../core/audit.ts";

export interface AuditWriterOptions {
  readonly logger?: {
    debug(message: string, fields?: Record<string, unknown>): void;
  };
}

/**
 * Recursively freeze a value and every plain object/array reachable
 * through it. Non-cloneable / non-plain values (class instances, Dates,
 * RegExps, functions, primitives) are returned untouched so that
 * freezing them cannot break runtime semantics. Already-frozen values
 * are skipped. This guarantees deep immutability for JSON-serializable
 * audit metadata (the only kind that can round-trip through the
 * file-backed writer's JSONL persistence).
 */
export function deepFreeze<T>(value: T): T {
  if (value === null || typeof value !== "object") return value;
  const tag = Object.prototype.toString.call(value);
  // Only deeply freeze plain objects and arrays. This covers all
  // JSON-serializable audit metadata; other object kinds (Date, RegExp,
  // Map, Set, class instances, …) are left to their own semantics.
  if (tag !== "[object Object]" && !Array.isArray(value)) return value;
  if (Object.isFrozen(value)) return value;
  Object.freeze(value);
  for (const key of Object.keys(value as Record<string, unknown>)) {
    deepFreeze((value as Record<string, unknown>)[key]);
  }
  return value;
}

/**
 * Produce a deeply-immutable, independent copy of an event. The input
 * is structured-cloned first (so the caller's metadata object is never
 * mutated in place), then the clone is recursively frozen.
 */
function toImmutableEvent(input: Omit<AuditEvent, "eventId"> & { eventId: string }): AuditEvent {
  return deepFreeze(structuredClone(input)) as AuditEvent;
}

function matches(event: AuditEvent, q: AuditQuery): boolean {
  if (q.correlationId && event.correlationId !== q.correlationId) return false;
  if (q.executionId && event.executionId !== q.executionId) return false;
  if (q.eventType && event.eventType !== q.eventType) return false;
  if (q.resourceType && event.resourceType !== q.resourceType) return false;
  if (q.resourceId && event.resourceId !== q.resourceId) return false;
  if (q.since && event.timestamp < q.since) return false;
  if (q.until && event.timestamp > q.until) return false;
  return true;
}

export function createInMemoryAuditWriter(
  options: AuditWriterOptions = {},
): AuditWriter & {
  /** Test-only accessor. Returns a defensive (frozen) snapshot. */
  _events(): readonly AuditEvent[];
} {
  const events: AuditEvent[] = [];

  const writer: AuditWriter = {
    async append(input) {
      const ctx: ExecutionContext = input.context;
      const event = toImmutableEvent({
        eventId: randomUUID(),
        eventType: input.eventType,
        actor: input.actor ?? ctx.actor?.id ?? null,
        subject: input.subject ?? ctx.subject?.id ?? null,
        correlationId: ctx.correlationId,
        executionId: ctx.executionId,
        timestamp: new Date().toISOString(),
        resourceType: input.resourceType ?? null,
        resourceId: input.resourceId ?? null,
        metadata: input.metadata ?? {},
      });
      // Append-only invariant: the stored event is deeply frozen so
      // retrieved entries cannot be mutated by callers (AC-06, deep).
      events.push(event);
      options.logger?.debug("audit.append", { eventType: event.eventType });
      return event;
    },
    async query(query) {
      const limit = query.limit ?? 1000;
      // Elements are already deeply-frozen references; the slice()
      // produces a fresh array of those frozen references, so callers
      // cannot mutate prior entries through the returned array.
      return events
        .filter((e) => matches(e, query))
        .slice(0, limit);
    },
    async count() {
      return events.length;
    },
  };

  return Object.assign(writer, {
    _events: () => Object.freeze(events.slice()) as readonly AuditEvent[],
  });
}

/**
 * File-backed audit writer for persistence integrity tests (AC-06).
 * Each event is appended as one JSON line. The file is opened in
 * append mode; existing entries are never rewritten.
 */
import { promises as fs } from "node:fs";
import { existsSync } from "node:fs";

export function createFileAuditWriter(
  filePath: string,
  options: AuditWriterOptions = {},
): AuditWriter & { _events(): Promise<readonly AuditEvent[]> } {
  const writer = createInMemoryAuditWriter(options);

  async function persist(event: AuditEvent): Promise<void> {
    const line = JSON.stringify(event) + "\n";
    await fs.appendFile(filePath, line, "utf8");
  }

  async function load(): Promise<AuditEvent[]> {
    if (!existsSync(filePath)) return [];
    const content = await fs.readFile(filePath, "utf8");
    const out: AuditEvent[] = [];
    for (const line of content.split("\n")) {
      if (!line.trim()) continue;
      try {
        // JSON.parse yields fresh objects; deep-freeze each so the
        // append-only / immutable invariant holds for file-loaded
        // entries too (AC-06, deep — including nested metadata).
        const event = deepFreeze(JSON.parse(line) as AuditEvent) as AuditEvent;
        out.push(event);
      } catch {
        // skip malformed line — never mutate
      }
    }
    return out;
  }

  const decorated: AuditWriter = {
    async append(input) {
      const event = await writer.append(input);
      await persist(event);
      return event;
    },
    async query(query) {
      const loaded = await load();
      const limit = query.limit ?? 1000;
      return loaded.filter((e) => matches(e, query)).slice(0, limit);
    },
    async count() {
      return (await load()).length;
    },
  };

  // Defensive deep-freeze guard: retrieved entries are deeply frozen so
  // any attempt to mutate a prior entry (including nested metadata)
  // throws, signalling a programming error against the append-only /
  // immutable invariant (AC-06).
  async function eventsView(): Promise<readonly AuditEvent[]> {
    return Object.freeze((await load()).map((e) => deepFreeze(e))) as AuditEvent[];
  }

  return Object.assign(decorated, { _events: eventsView });
}

/** Guard exported so tests can assert the append-only invariant explicitly. */
export { AuditMutationError };
