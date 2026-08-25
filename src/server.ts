/**
 * OpenCon server entry point (composition root invocation).
 *
 * Work order ref: NET-W001 §4.3 (fail-fast startup), §4.6 (health).
 *
 * Loads configuration (fail-fast on invalid required config), wires the
 * runtime, initializes all boundary modules, starts the worker loop and
 * the HTTP API, and handles graceful shutdown on SIGINT/SIGTERM.
 *
 * Run with: `bun run dev` (hot) or `bun run start`.
 */

import { createRuntime } from "./bootstrap/runtime.ts";
import { runWithExecutionContextAsync } from "./core/execution-context.ts";
import { createExecutionContext } from "./core/execution-context.ts";

async function main(): Promise<void> {
  const runtime = createRuntime();

  // Bootstrap the top-level execution context so startup logs/audit
  // carry a correlation id.
  const bootCtx = createExecutionContext({
    actor: { id: "system", kind: "system" },
  });

  await runWithExecutionContextAsync(bootCtx, async () => {
    const states = await runtime.initialize();
    runtime.logger.info("startup.modules_initialized", {
      count: states.length,
      initialized: states.filter((s) => s.initialized).length,
    });
    // Record a startup audit event (append-only boundary).
    await runtime.auditWriter.append({
      eventType: "system.startup",
      context: bootCtx,
      metadata: {
        modules: states.length,
        environment: runtime.config.snapshot.environment,
      },
    });
  });

  runtime.workerLoop.start();
  await runtime.api.start();

  const shutdown = async (signal: string): Promise<void> => {
    runtime.logger.info("shutdown.signal_received", { signal });
    await runWithExecutionContextAsync(bootCtx, async () => {
      await runtime.auditWriter.append({
        eventType: "system.shutdown",
        context: bootCtx,
        metadata: { signal },
      });
      await runtime.shutdown();
    });
    process.exit(0);
  };

  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
}

main().catch((err) => {
  // Fail-fast: invalid configuration surfaces here as a classified error.
  // eslint-disable-next-line no-console
  console.error("startup_failed", err);
  process.exit(1);
});
