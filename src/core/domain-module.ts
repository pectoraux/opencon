/**
 * Helpers to declare skeletal module boundaries consistently.
 *
 * Each domain/infrastructure/adapter boundary registers a `Module` whose
 * `init()` is a no-op (logging only) — NET-W001 establishes boundaries
 * and contracts, NOT domain behaviour (§5 explicit non-goals).
 */

import type {
  Module,
  ModuleInitContext,
  ModuleTier,
} from "./module.ts";

export interface BoundaryModuleOptions {
  readonly name: string;
  readonly tier: ModuleTier;
  readonly version?: string;
  readonly dependencies?: readonly string[];
  readonly summary: string;
  /** Optional public interface object exported to the registry. */
  readonly exports?: Record<string, unknown>;
}

/**
 * Define a skeletal boundary module. `init` logs that the boundary is
 * registered; it MUST NOT perform economically/material state changes.
 */
export function defineBoundaryModule(opts: BoundaryModuleOptions): Module {
  let initialized = false;
  return {
    name: opts.name,
    version: opts.version ?? "0.1.0",
    tier: opts.tier,
    dependencies: opts.dependencies ?? [],
    exports: opts.exports,
    async init(ctx: ModuleInitContext): Promise<void> {
      if (initialized) return;
      ctx.logger.info("module.initialized", {
        module: opts.name,
        tier: opts.tier,
        summary: opts.summary,
      });
      initialized = true;
    },
    async shutdown(): Promise<void> {
      initialized = false;
    },
    describe(): string {
      return `${opts.name} [${opts.tier}]: ${opts.summary}`;
    },
  };
}
