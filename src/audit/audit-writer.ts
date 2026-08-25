/**
 * Concrete AuditWriter — append-only audit trail.
 *
 * Work order ref: NET-W001 §4.7 (Audit foundation), AC-06.
 *
 * Implements the {@link AuditWriter} contract declared in core. Backed
 * by an append-only in-memory log (suitable for tests and the skeleton).
 * A file-backed implementation is provided in
 * {@link createFileAuditWriter} for persistence integrity tests
 * (entries survive process restart and are never mutated).
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
  /** Test-only accessor. Returns a defensive copy. */
  _events(): readonly AuditEvent[];
} {
  const events: AuditEvent[] = [];

  const writer: AuditWriter = {
    async append(input) {
      const ctx: ExecutionContext = input.context;
      const event: AuditEvent = {
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
      };
      // Append-only invariant: events are deeply frozen so retrieved
      // entries cannot be mutated by callers (AC-06).
      Object.freeze(event);
      Object.freeze((event as { metadata: Record<string, unknown> }).metadata);
      events.push(event);
      options.logger?.debug("audit.append", { eventType: event.eventType });
      return event;
    },
    async query(query) {
      const limit = query.limit ?? 1000;
      return events
        .filter((e) => matches(e, query))
        .slice(0, limit);
    },
    async count() {
      return events.length;
    },
  };

  return Object.assign(writer, {
    _events: () => events.slice(),
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
        const event = JSON.parse(line) as AuditEvent;
        Object.freeze(event);
        Object.freeze((event as { metadata: Record<string, unknown> }).metadata);
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

  // Defensive deep-freeze guard: any attempt to mutate a retrieved entry
  // throws, signalling a programming error against the append-only invariant.
  async function eventsView(): Promise<readonly AuditEvent[]> {
    return Object.freeze((await load()).map(Object.freeze)) as AuditEvent[];
  }

  return Object.assign(decorated, { _events: eventsView });
}

/** Guard exported so tests can assert the append-only invariant explicitly. */
export { AuditMutationError };
