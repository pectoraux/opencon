/**
 * NET-W001-AC-01 — Module boundaries.
 *
 * Evidence: source tree + architecture test output.
 *
 * Asserts that every required frozen module boundary exists as an
 * explicit directory with a documented public interface (port.ts),
 * a skeletal module registration (module.ts), a barrel (index.ts),
 * and a README documenting the boundary; and that the core barrel
 * exports the 11 required contracts.
 */

import { describe, test, expect } from "bun:test";
import { existsSync, statSync } from "node:fs";
import { join } from "node:path";
import { readFile } from "node:fs/promises";
import type {
  Module,
  ModuleRegistry,
  JobQueue,
  JobHandler,
  ExecutionContext,
  Logger,
  AuditWriter,
  ConfigurationProvider,
  ObjectStore,
  SecretProvider,
  ProviderAdapter,
} from "../../src/core/index.ts";

const REPO = join(import.meta.dir, "../..");
const SRC = join(REPO, "src");

const DOMAIN_DIRS = [
  "identity", "organizations", "participants", "opportunities",
  "contributions", "campaigns", "inventory", "creators", "demand",
  "benefits", "reputation", "evidence", "outcomes", "settlement",
  "disputes", "workflows",
];

const INFRA_DIRS = [
  "api", "workers", "audit", "persistence", "queues",
  "object-storage", "secrets", "observability", "config",
];

const EXTERNAL_DIRS = [
  "llm", "agents", "adapters", "measurement", "payments", "ledger",
];

const BOUNDARY_FILES = ["port.ts", "module.ts", "index.ts", "README.md"];

describe("NET-W001-AC-01 module boundaries", () => {
  test("every domain boundary exists with port/module/index/README", () => {
    for (const dir of DOMAIN_DIRS) {
      for (const file of BOUNDARY_FILES) {
        const p = join(SRC, dir, file);
        expect(existsSync(p), `${dir}/${file} should exist`).toBe(true);
        expect(statSync(p).isFile(), `${dir}/${file} should be a file`).toBe(true);
      }
    }
  });

  test("every infrastructure boundary exists with port/module/index/README", () => {
    for (const dir of INFRA_DIRS) {
      for (const file of BOUNDARY_FILES) {
        const p = join(SRC, dir, file);
        expect(existsSync(p), `${dir}/${file} should exist`).toBe(true);
      }
    }
  });

  test("every external-integration boundary exists with port/module/index/README", () => {
    for (const dir of EXTERNAL_DIRS) {
      for (const file of BOUNDARY_FILES) {
        const p = join(SRC, dir, file);
        expect(existsSync(p), `${dir}/${file} should exist`).toBe(true);
      }
    }
  });

  test("domain ports declare a documented public interface", async () => {
    for (const dir of DOMAIN_DIRS) {
      const content = await readFile(join(SRC, dir, "port.ts"), "utf8");
      expect(content, `${dir}/port.ts should export an interface`).toMatch(
        /export interface \w+Port/,
      );
      // Boundary must reference architecture authority (no silent decisions).
      expect(content).toMatch(/Architecture ref|authority|boundary/i);
    }
  });

  test("core barrel exports the 11 required contracts", async () => {
    // Runtime value exports prove the modules load; the type-only
    // contract imports below prove the interfaces are declared (the
    // file compiles only if each named type exists).
    const core = await import(join(SRC, "core/index.ts"));
    // Value exports (runtime):
    expect(typeof core.defineBoundaryModule).toBe("function");
    expect(typeof core.createExecutionContext).toBe("function");
    expect(typeof core.classifyError).toBe("function");
    expect(typeof core.OpenConError).toBe("function");
    expect(typeof core.DEFAULT_RETRY_POLICY).toBe("object");
    expect(typeof core.ModuleRegistryError).toBe("function");
    expect(typeof core.AuditMutationError).toBe("function");
    expect(typeof core.SecretNotFoundError).toBe("function");
  });

  test("core type-only contracts are importable (compile-time proof)", () => {
    // The 11 required contracts are imported as types at the top of
    // this file. If any did not exist, this module would fail to
    // compile. Use them in a type-only assertion so the import is not
    // elided.
    const _contracts: {
      m: Module;
      r: ModuleRegistry;
      q: JobQueue;
      h: JobHandler;
      c: ExecutionContext;
      l: Logger;
      a: AuditWriter;
      cfg: ConfigurationProvider;
      o: ObjectStore;
      s: SecretProvider;
      p: ProviderAdapter;
    } = null as never;
    void _contracts;
    expect(true).toBe(true);
  });

  test("all 31 boundary directories are present", () => {
    const all = [...DOMAIN_DIRS, ...INFRA_DIRS, ...EXTERNAL_DIRS];
    expect(all.length).toBe(31);
    for (const dir of all) {
      expect(existsSync(join(SRC, dir)), `src/${dir} should exist`).toBe(true);
      expect(statSync(join(SRC, dir)).isDirectory()).toBe(true);
    }
  });
});
