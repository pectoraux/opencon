/**
 * Architecture enforcement — deterministic import scanner.
 *
 * Work order ref: NET-W001 §4.8 (Architecture enforcement), AC-02
 * (dependency direction), AC-07 (adapter isolation).
 *
 * Deterministic, dependency-free static check (no AST). Scans `.ts`
 * files under a root, classifies each file into a tier by path, parses
 * import specifiers with a regex, resolves each to a target file,
 * classifies the target tier, and applies a fixed allow/deny matrix.
 * Exits non-zero on any violation. Reproducible from a clean checkout
 * (`bun run arch:check`).
 *
 * Tiers (by module path relative to the scan root):
 *   core            - src/core subtree
 *   bootstrap       - src/server.ts, src/bootstrap.ts (composition root)
 *   domain          - the 16 frozen domain dirs
 *   infrastructure  - api, workers, audit, persistence, queues,
 *                      object-storage, secrets, observability, config
 *   neutral         - provider-neutral ports + boundary composition
 *                      (port.ts, index.ts, module.ts at the root of
 *                      llm, agents, measurement, payments, ledger,
 *                      adapters)
 *   adapter         - concrete providers (providers/ subtrees and
 *                      adapters/<provider>/ subtrees)
 *
 * Allow matrix (importer to target):
 *   core           -> core, builtin, external-allowed
 *   bootstrap      -> anything
 *   domain         -> core, neutral, self(same dir), builtin, external-allowed
 *   infrastructure -> core, neutral, infrastructure, builtin, external-allowed
 *   neutral        -> core, neutral, builtin, external-allowed
 *   adapter        -> core, neutral, adapter, builtin, external-allowed
 *
 * Domain to infrastructure/adapter/other-domain is a violation (AC-02,
 * AC-07). The intentional failing fixture for AC-02 lives under
 * tests/architecture/fixtures/violation/ and is scanned separately.
 */

import { readdir, readFile } from "node:fs/promises";
import { existsSync, statSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import * as posix from "node:path/posix";

export type Tier =
  | "core"
  | "bootstrap"
  | "domain"
  | "infrastructure"
  | "neutral"
  | "adapter"
  | "other";

export const DOMAIN_DIRS = [
  "identity", "organizations", "participants", "opportunities",
  "contributions", "campaigns", "inventory", "creators", "demand",
  "benefits", "reputation", "evidence", "outcomes", "settlement",
  "disputes", "workflows",
] as const;

export const INFRA_DIRS = [
  "api", "workers", "audit", "persistence", "queues",
  "object-storage", "secrets", "observability", "config",
] as const;

export const NEUTRAL_BOUNDARY_DIRS = [
  "llm", "agents", "measurement", "payments", "ledger", "adapters",
] as const;

const ALLOWED_EXTERNAL_PACKAGES = new Set(["zod"]);

const BUILTIN_MODULES = new Set([
  "assert", "async_hooks", "buffer", "child_process", "cluster",
  "console", "constants", "crypto", "dgram", "diagnostics_channel",
  "dns", "domain", "events", "fs", "http", "http2", "https", "inspector",
  "module", "net", "os", "path", "perf_hooks", "process", "punycode",
  "querystring", "readline", "repl", "stream", "string_decoder",
  "sys", "timers", "tls", "trace_events", "tty", "url", "util", "v8",
  "vm", "wasi", "worker_threads", "zlib",
]);

export interface Violation {
  readonly file: string;
  readonly line: number;
  readonly specifier: string;
  readonly importerTier: Tier;
  readonly importerDir: string;
  readonly targetTier: string;
  readonly rule: string;
}

export interface ScanResult {
  readonly root: string;
  readonly filesScanned: number;
  readonly violations: readonly Violation[];
}

const IMPORT_RE =
  /(?:^|[;\s{}()])(?:import|export)(?:[^'"`;]*?from)?\s*["']([^"']+)["']|(?:import|require)\s*\(\s*["']([^"']+)["']\s*\)/g;

function toPosix(p: string): string {
  return p.split(sep).join(posix.sep);
}

export function tierFromModulePath(modulePath: string): Tier {
  const parts = modulePath.split("/");
  const first = parts[0] ?? "";
  if (first === "core") return "core";
  if (first === "bootstrap" || modulePath === "server.ts" || modulePath === "bootstrap.ts") return "bootstrap";
  if ((DOMAIN_DIRS as readonly string[]).includes(first)) return "domain";
  if ((INFRA_DIRS as readonly string[]).includes(first)) return "infrastructure";
  if ((NEUTRAL_BOUNDARY_DIRS as readonly string[]).includes(first)) {
    if (parts.length === 2 && (parts[1] === "port.ts" || parts[1] === "index.ts" || parts[1] === "module.ts")) {
      return "neutral";
    }
    return "adapter";
  }
  return "other";
}

export function boundaryDir(modulePath: string): string {
  return modulePath.split("/")[0] ?? "";
}

type SpecifierKind = "builtin" | "external-allowed" | "external-forbidden" | "relative" | "alias";

function classifySpecifier(specifier: string): SpecifierKind {
  if (specifier.startsWith("node:")) return "builtin";
  if (specifier.startsWith(".") || specifier.startsWith("/")) return "relative";
  if (specifier.startsWith("@/")) return "alias";
  const base = specifier.startsWith("@")
    ? specifier.split("/").slice(0, 2).join("/")
    : specifier.split("/")[0] ?? "";
  if (BUILTIN_MODULES.has(base)) return "builtin";
  if (ALLOWED_EXTERNAL_PACKAGES.has(base) || base === "bun") return "external-allowed";
  return "external-forbidden";
}

interface ResolvedTarget {
  readonly tier: Tier;
  readonly dir: string;
}
interface UnresolvedTarget {
  readonly kind: "builtin" | "external-allowed" | "external-forbidden" | "unresolved";
}
type Target = ResolvedTarget | UnresolvedTarget;

function resolveImport(
  importerAbs: string,
  specifier: string,
  scanRoot: string,
  repoSrc: string,
): ResolvedTarget | null {
  const base = specifier.startsWith("@/")
    ? join(repoSrc, specifier.slice(2))
    : resolve(dirname(importerAbs), specifier);
  const candidates = [
    base,
    base + ".ts",
    base + ".tsx",
    base + ".js",
    join(base, "index.ts"),
    join(base, "index.js"),
  ];
  for (const c of candidates) {
    if (existsSync(c) && statSync(c).isFile()) {
      // Classify the target by its module path relative to whichever
      // root it falls under: the scan root first (for self-contained
      // fixtures), then the authoritative repo src/.
      const relScan = relative(scanRoot, c);
      const inScan = relScan && !relScan.startsWith("..") && !relScan.startsWith("node_modules");
      const relSrc = relative(repoSrc, c);
      const inSrc = relSrc && !relSrc.startsWith("..") && !relSrc.startsWith("node_modules");
      const modulePath = toPosix(inScan ? relScan : inSrc ? relSrc : "");
      if (!modulePath) return null;
      return { tier: tierFromModulePath(modulePath), dir: boundaryDir(modulePath) };
    }
  }
  return null;
}

async function walk(root: string, files: string[] = []): Promise<string[]> {
  const entries = await readdir(root, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.name === "node_modules" || entry.name === "dist" || entry.name === ".git") continue;
    const full = join(root, entry.name);
    if (entry.isDirectory()) {
      await walk(full, files);
    } else if (entry.isFile() && entry.name.endsWith(".ts")) {
      files.push(full);
    }
  }
  return files;
}

function checkRule(
  importer: { tier: Tier; dir: string },
  target: Target,
): string | null {
  if (importer.tier === "bootstrap") return null;
  if ("kind" in target) {
    if (target.kind === "builtin" || target.kind === "external-allowed") return null;
    if (target.kind === "external-forbidden") return "external-package-not-allowed";
    return "unresolved-import";
  }
  const t = target.tier;
  switch (importer.tier) {
    case "core":
      if (t === "core") return null;
      return "core-must-not-import-other-tiers";
    case "domain":
      if (t === "core" || t === "neutral") return null;
      if (t === "domain" && target.dir === importer.dir) return null;
      if (t === "infrastructure") return "domain-must-not-import-infrastructure";
      if (t === "adapter") return "domain-must-not-import-adapter";
      if (t === "domain") return "domain-must-not-import-other-domain";
      if (t === "bootstrap") return "domain-must-not-import-bootstrap";
      return "domain-forbidden-target";
    case "infrastructure":
      if (t === "core" || t === "neutral" || t === "infrastructure") return null;
      if (t === "domain") return "infrastructure-must-not-import-domain";
      if (t === "adapter") return "infrastructure-must-not-import-adapter";
      if (t === "bootstrap") return "infrastructure-must-not-import-bootstrap";
      return "infrastructure-forbidden-target";
    case "neutral":
      if (t === "core" || t === "neutral") return null;
      return "neutral-must-not-import-other-tiers";
    case "adapter":
      if (t === "core" || t === "neutral" || t === "adapter") return null;
      if (t === "domain") return "adapter-must-not-import-domain";
      if (t === "infrastructure") return "adapter-must-not-import-infrastructure";
      if (t === "bootstrap") return "adapter-must-not-import-bootstrap";
      return "adapter-forbidden-target";
    case "other":
      return "unknown-tier-file";
    default:
      return null;
  }
}

export interface ScanOptions {
  readonly root?: string;
  readonly repoSrc?: string;
}

function repoRootFromCallSite(): string {
  // scripts/lib/architecture.ts → repo root is two levels up from scripts/lib? No:
  // this file is <repo>/scripts/lib/architecture.ts → repo = dirname x3? Let's compute:
  // import.meta.url dir = <repo>/scripts/lib ; repo = <repo>  => up 2 from scripts/lib? no, up 2 = <repo>/scripts, up 3 = <repo>. Actually: dirname(thisFile) = <repo>/scripts/lib. repo = <repo>. So up 3 levels? dirname(lib)=scripts, dirname(scripts)=repo. So two dirname calls: <repo>/scripts/lib -> scripts -> repo. Let me use resolve(dirname(thisFile), "..", "..").
  return resolve(dirname(new URL(import.meta.url).pathname), "..", "..");
}

export async function scanArchitecture(opts: ScanOptions = {}): Promise<ScanResult> {
  const repoRoot = repoRootFromCallSite();
  const repoSrc = opts.repoSrc ?? join(repoRoot, "src");
  const root = opts.root ?? repoSrc;
  const files = await walk(root);
  const violations: Violation[] = [];

  for (const file of files) {
    const relToRoot = toPosix(relative(root, file));
    const importerTier = tierFromModulePath(relToRoot);
    const importerDir = boundaryDir(relToRoot);
    const content = await readFile(file, "utf8");
    IMPORT_RE.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = IMPORT_RE.exec(content)) !== null) {
      const specifier = match[1] ?? match[2] ?? "";
      if (!specifier) continue;
      const offset = match.index;
      const lineNo = content.slice(0, offset).split("\n").length;
      const classified = classifySpecifier(specifier);
      let target: Target;
      if (classified === "relative" || classified === "alias") {
        const resolved = resolveImport(file, specifier, root, repoSrc);
        target = resolved ?? { kind: "unresolved" };
      } else {
        target = { kind: classified };
      }
      const rule = checkRule({ tier: importerTier, dir: importerDir }, target);
      if (rule) {
        violations.push({
          file: relToRoot,
          line: lineNo,
          specifier,
          importerTier,
          importerDir,
          targetTier: "kind" in target ? target.kind : target.tier,
          rule,
        });
      }
    }
  }

  return { root, filesScanned: files.length, violations };
}

export function formatViolations(result: ScanResult): string {
  if (result.violations.length === 0) {
    return `✓ architecture check passed: ${result.filesScanned} files scanned, 0 violations.`;
  }
  const lines = result.violations.map(
    (v) =>
      `✗ ${v.file}:${v.line}  [${v.importerTier}/${v.importerDir} → ${v.targetTier}]  ${v.rule}\n    import "${v.specifier}"`,
  );
  return [
    `✗ architecture check FAILED: ${result.violations.length} violation(s) across ${result.filesScanned} files.`,
    ...lines,
  ].join("\n");
}
