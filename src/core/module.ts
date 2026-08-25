/**
 * Module & ModuleRegistry contracts — composition boundary for the
 * modular monolith.
 *
 * Work order ref: NET-W001 §4.1, §4.2 (module contract conventions),
 * §6 (required interfaces: Module, ModuleRegistry).
 *
 * The registry assembles the runtime from explicitly-declared modules at
 * startup, in a deterministic dependency-respecting order. Modules expose
 * a documented public interface and declare their dependencies. No
 * module silently imports another's internals.
 */

export interface ModuleInitContext {
  /** Access to already-initialized peer module interfaces, by name. */
  readonly registry: ModuleRegistry;
  /** The process configuration snapshot (redacted). */
  readonly config: import("./config.ts").ConfigSnapshot;
  /** The structured logger scoped to this module name. */
  readonly logger: import("./logger.ts").Logger;
}

export interface ModuleState {
  readonly name: string;
  readonly version: string;
  readonly tier: ModuleTier;
  readonly dependencies: readonly string[];
  /** True once init() completed without throwing. */
  readonly initialized: boolean;
}

export type ModuleTier =
  | "domain"
  | "infrastructure"
  | "adapter"
  | "core";

export interface Module {
  readonly name: string;
  readonly version: string;
  readonly tier: ModuleTier;
  /** Module names that must initialize before this one. */
  readonly dependencies: readonly string[];
  /** Documented public interface object (ports/outbound contracts). */
  readonly exports?: Record<string, unknown>;
  /**
   * Initialize the module. MUST be idempotent. MUST throw an OpenConError
   * on failure (fail-fast startup). Domain modules MUST NOT perform
   * economically/material state changes here.
   */
  init(ctx: ModuleInitContext): Promise<void>;
  /** Release resources on graceful shutdown. */
  shutdown?(): Promise<void>;
  /** Human-readable boundary summary, for the /health report. */
  describe?(): string;
}

export interface ModuleRegistry {
  /** Register a module. Throws on duplicate name or unmet dependency. */
  register(module: Module): void;
  /** Initialize all registered modules in dependency order. */
  initializeAll(): Promise<readonly ModuleState[]>;
  /** Look up a peer module's declared public interface by name. */
  resolve<T = unknown>(name: string): T;
  /** Snapshot of registered module states. */
  snapshot(): readonly ModuleState[];
  /** Graceful shutdown in reverse init order. */
  shutdownAll(): Promise<void>;
}

export class ModuleRegistryError extends Error {
  public constructor(
    message: string,
    public readonly code:
      | "duplicate"
      | "unmet_dependency"
      | "circular_dependency"
      | "not_found"
      | "init_failure" = "not_found",
  ) {
    super(message);
    this.name = "ModuleRegistryError";
  }
}
