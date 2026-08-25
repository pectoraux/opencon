/**
 * Concrete structured Logger.
 *
 * Emits one JSON object per event (or pretty text in development), always
 * stamped with the active execution/correlation IDs from AsyncLocalStorage,
 * the module/component, the level, the timestamp, and classified errors.
 *
 * Work order ref: NET-W001 §4.6 (Logging and observability), AC-05.
 */

import { getExecutionContext } from "../core/execution-context.ts";
import { classifyError } from "../core/errors.ts";
import type { Logger, LogLevel, LogFields, LogEntry } from "../core/logger.ts";

const LEVEL_ORDER: Record<LogLevel, number> = {
  trace: 10,
  debug: 20,
  info: 30,
  warn: 40,
  error: 50,
  fatal: 60,
};

export interface LoggerOptions {
  readonly module: string;
  readonly component?: string;
  readonly minLevel: LogLevel;
  readonly pretty: boolean;
  /** Sink. Defaults to console.log/stderr for error/fatal. */
  readonly sink?: (line: string, level: LogLevel) => void;
  /** Collected entries (for tests). */
  readonly collector?: LogEntrySink;
}

export interface LogEntrySink {
  entries: import("../core/logger.ts").LogEntry[];
}

function emit(line: string, level: LogLevel, opts: LoggerOptions): void {
  if (opts.collector) {
    // parsed back into a structured entry for assertions
    try {
      opts.collector.entries.push(JSON.parse(line));
    } catch {
      /* pretty mode — not collected */
    }
  }
  const sink = opts.sink ?? ((l: string, lvl: LogLevel) => {
    if (lvl === "error" || lvl === "fatal") {
      process.stderr.write(l + "\n");
    } else {
      process.stdout.write(l + "\n");
    }
  });
  sink(line, level);
}

export function createLogger(opts: LoggerOptions): Logger {
  const minLevel = LEVEL_ORDER[opts.minLevel];

  function shouldLog(level: LogLevel): boolean {
    return LEVEL_ORDER[level] >= minLevel;
  }

  function buildEntry(
    level: LogLevel,
    message: string,
    fields: LogFields,
    errorInfo?: import("../core/logger.ts").LogEntry["error"],
  ): import("../core/logger.ts").LogEntry {
    const ctx = getExecutionContext();
    return {
      timestamp: new Date().toISOString(),
      level,
      message,
      module: opts.module,
      component: opts.component,
      executionId: ctx?.executionId,
      correlationId: ctx?.correlationId,
      actorId: ctx?.actor?.id,
      fields,
      error: errorInfo,
    };
  }

  function log(level: LogLevel, message: string, fields: LogFields): void {
    if (!shouldLog(level)) return;
    const entry = buildEntry(level, message, fields);
    const line = opts.pretty ? pretty(entry) : JSON.stringify(entry);
    emit(line, level, opts);
  }

  function logError(
    level: LogLevel,
    message: string,
    errorOrFields: unknown,
    fields: LogFields,
  ): void {
    if (!shouldLog(level)) return;
    let errorInfo: import("../core/logger.ts").LogEntry["error"] | undefined;
    let mergedFields = fields;
    if (errorOrFields instanceof Error) {
      const c = classifyError(errorOrFields);
      mergedFields = { ...c.context, ...fields };
      errorInfo = {
        message: c.message,
        code: c.code,
        classification: c.classification,
        retryable: c.retryable,
        stack: errorOrFields.stack,
      };
    } else if (errorOrFields && typeof errorOrFields === "object") {
      mergedFields = { ...(errorOrFields as LogFields), ...fields };
    } else if (typeof errorOrFields === "string" && errorOrFields) {
      mergedFields = { note: errorOrFields, ...fields };
    }
    const entry = buildEntry(level, message, mergedFields, errorInfo);
    const line = opts.pretty ? pretty(entry) : JSON.stringify(entry);
    emit(line, level, opts);
  }

  const logger: Logger = {
    module: opts.module,
    trace: (m, f = {}) => log("trace", m, f),
    debug: (m, f = {}) => log("debug", m, f),
    info: (m, f = {}) => log("info", m, f),
    warn: (m, e?, f = {}) => logError("warn", m, e, f),
    error: (m, e?, f = {}) => logError("error", m, e, f),
    fatal: (m, e?, f = {}) => logError("fatal", m, e, f),
    child: (component: string) =>
      createLogger({
        ...opts,
        component,
        collector: opts.collector,
      }),
    forModule: (module: string) =>
      createLogger({
        ...opts,
        module,
        collector: opts.collector,
      }),
  };
  return logger;
}

function pretty(entry: import("../core/logger.ts").LogEntry): string {
  const ctx = entry.correlationId
    ? ` [corr=${shortId(entry.correlationId)} exec=${shortId(entry.executionId ?? "")}]`
    : "";
  const comp = entry.component ? ` (${entry.component})` : "";
  const err = entry.error
    ? ` :: ${entry.error.classification}/${entry.error.code}: ${entry.error.message}`
    : "";
  const extra =
    Object.keys(entry.fields).length > 0
      ? ` ${JSON.stringify(entry.fields)}`
      : "";
  return `${entry.timestamp} ${entry.level.toUpperCase().padEnd(5)} [${entry.module}${comp}]${ctx} ${entry.message}${err}${extra}`;
}

function shortId(id: string): string {
  return id.length > 8 ? id.slice(0, 8) : id;
}

export const SILENT_LOGGER: Logger = createLogger({
  module: "silent",
  minLevel: "fatal",
  pretty: false,
  sink: () => {},
});
