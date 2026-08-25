/**
 * Concrete ModuleRegistry — assembles the modular monolith at startup.
 *
 * Work order ref: NET-W001 §4.2, §6 (ModuleRegistry). Initializes modules
 * in dependency-respecting (topological) order, exposes peer interfaces
 * by name, and shuts down in reverse order. Domain modules register but
 * perform NO domain logic (§5).
 */

import type {
  Module,
  ModuleInitContext,
  ModuleRegistry,
  ModuleState,
} from "../core/module.ts";
import { ModuleRegistryError } from "../core/module.ts";
import type { ConfigSnapshot } from "../core/config.ts";
import type { Logger } from "../core/logger.ts";

export function createModuleRegistry(
  config: ConfigSnapshot,
  logger: Logger,
): ModuleRegistry {
  const modules = new Map<string, Module>();
  const initialized = new Set<string>();
  const initOrder: string[] = [];

  const registry: ModuleRegistry = {
    register(module) {
      if (modules.has(module.name)) {
        throw new ModuleRegistryError(
          `module already registered: ${module.name}`,
          "duplicate",
        );
      }
      modules.set(module.name, module);
    },

    async initializeAll() {
      const ordered = topoSort(modules);
      const states: ModuleState[] = [];
      for (const module of ordered) {
        if (initialized.has(module.name)) continue;
        const ctx: ModuleInitContext = {
          registry,
          config,
          logger: logger.forModule(module.name),
        };
        try {
          await module.init(ctx);
          initialized.add(module.name);
          initOrder.push(module.name);
        } catch (err) {
          throw new ModuleRegistryError(
            `module init failed: ${module.name} — ${
              err instanceof Error ? err.message : String(err)
            }`,
            "init_failure",
          );
        }
      }
      for (const module of modules.values()) {
        states.push(toState(module, initialized.has(module.name)));
      }
      return states;
    },

    resolve<T = unknown>(name: string): T {
      const module = modules.get(name);
      if (!module) {
        throw new ModuleRegistryError(
          `module not registered: ${name}`,
          "not_found",
        );
      }
      return (module.exports ?? {}) as T;
    },

    snapshot() {
      return Array.from(modules.values()).map((m) =>
        toState(m, initialized.has(m.name)),
      );
    },

    async shutdownAll() {
      for (const name of initOrder.slice().reverse()) {
        const module = modules.get(name);
        if (!module) continue;
        try {
          await module.shutdown?.();
        } catch (err) {
          logger.error("module.shutdown_failed", err, { module: name });
        }
        initialized.delete(name);
      }
    },
  };

  return registry;
}

function toState(module: Module, initialized: boolean): ModuleState {
  return {
    name: module.name,
    version: module.version,
    tier: module.tier,
    dependencies: module.dependencies,
    initialized,
  };
}

function topoSort(modules: Map<string, Module>): Module[] {
  const result: Module[] = [];
  const visiting = new Set<string>();
  const visited = new Set<string>();

  function visit(name: string, path: string[]): void {
    if (visited.has(name)) return;
    if (visiting.has(name)) {
      throw new ModuleRegistryError(
        `circular dependency detected: ${[...path, name].join(" → ")}`,
        "circular_dependency",
      );
    }
    const module = modules.get(name);
    if (!module) {
      throw new ModuleRegistryError(
        `unmet dependency: ${name} (required by ${path[path.length - 1] ?? "?"})`,
        "unmet_dependency",
      );
    }
    visiting.add(name);
    for (const dep of module.dependencies) {
      visit(dep, [...path, name]);
    }
    visiting.delete(name);
    visited.add(name);
    result.push(module);
  }

  for (const name of modules.keys()) {
    visit(name, []);
  }
  return result;
}
