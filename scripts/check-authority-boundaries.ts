/**
 * Authority-boundary guardrails.
 *
 * These rules make architectural watchpoints mechanically enforceable
 * without changing frozen Architecture v1.0.
 *
 * 1. /disputes is the single fraud/risk control authority.
 * 2. /contributions owns quality/moderation semantics, but risk mutation
 *    remains a composition-root concern.
 * 3. /workflows is the only operational lifecycle authority. Other domains
 *    may have explicitly approved administrative status, but operational
 *    transition primitives cannot appear in domain implementations.
 *
 * This checker deliberately distinguishes semantic implementation code from
 * shared vocabulary/type contracts and HTTP transport names. The existing
 * tier checker remains responsible for dependency direction.
 */

import { readdir, readFile } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";

/** Domain-local administrative state explicitly approved by architecture review. */
export const ADMINISTRATIVE_STATUS_DOMAINS = new Set(["campaigns", "creators"]);

const DOMAIN_DIRS = new Set([
  "identity", "organizations", "participants", "opportunities", "contributions",
  "campaigns", "inventory", "creators", "demand", "benefits", "reputation",
  "evidence", "outcomes", "settlement", "disputes", "workflows",
]);

const SINGLE_AUTHORITY_FORBIDDEN_IMPORTS: Record<string, readonly string[]> = {
  disputes: ["settlement", "reputation", "workflows", "campaigns"],
  contributions: ["disputes", "settlement", "reputation", "workflows"],
};

const CONTRIBUTION_RISK_MUTATION_IDENTIFIERS = [
  "createSignal",
  "supersedeSignal",
  "createRiskSignal",
  "createRiskAssessment",
  "createRiskCase",
];

const DISPUTES_ECONOMIC_OR_REPUTATION_IDENTIFIERS = [
  "issueCredits",
  "matureEconomicValue",
  "allocateRewards",
  "recordCashObligation",
  "createReputationInput",
  "createReputationSnapshot",
  "addReputationInput",
];

const WORKFLOW_CALL_PATTERNS = [
  /\brequestTransition\s*\(/g,
  /\bperformTransition\s*\(/g,
  /\btransitionWorkflow\s*\(/g,
];

const LOCAL_STATUS_HELPER_PATTERNS = [
  /\bstatusTransition\s*\(/g,
  /\bstatusMachine\s*\(/g,
  /\badministrativeStatusTransition\s*\(/g,
];

export interface AuthorityGuardViolation {
  readonly file: string;
  readonly line: number;
  readonly rule: string;
  readonly detail: string;
}

export interface AuthorityGuardResult {
  readonly filesScanned: number;
  readonly violations: readonly AuthorityGuardViolation[];
}

async function walk(root: string, files: string[] = []): Promise<string[]> {
  for (const entry of await readdir(root, { withFileTypes: true })) {
    if (entry.name === "node_modules" || entry.name === "dist" || entry.name === ".git") continue;
    const full = join(root, entry.name);
    if (entry.isDirectory()) await walk(full, files);
    else if (entry.isFile() && entry.name.endsWith(".ts")) files.push(full);
  }
  return files;
}

function stripComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:])\/\/.*$/gm, "$1");
}

function lineOf(source: string, offset: number): number {
  return source.slice(0, offset).split("\n").length;
}

function importTargets(source: string): readonly { specifier: string; offset: number }[] {
  const out: { specifier: string; offset: number }[] = [];
  const re = /(?:import|export)(?:[^'";]*?from)?\s*["']([^"']+)["']/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(source)) !== null) out.push({ specifier: match[1] ?? "", offset: match.index });
  return out;
}

function targetDomain(importerDir: string, specifier: string): string | null {
  if (!specifier.startsWith(".")) return null;
  const base = resolve(join("src", importerDir), specifier);
  const rel = relative(resolve("src"), base).replaceAll("\\", "/");
  const first = rel.split("/")[0] ?? "";
  return first && first !== "core" && DOMAIN_DIRS.has(first) ? first : null;
}

function regexHits(source: string, patterns: readonly RegExp[]) {
  const hits: { pattern: string; offset: number }[] = [];
  for (const pattern of patterns) {
    pattern.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(source)) !== null) hits.push({ pattern: pattern.source, offset: match.index });
  }
  return hits.sort((a, b) => a.offset - b.offset);
}

function isDomainImplementation(importerDir: string, rel: string): boolean {
  if (!DOMAIN_DIRS.has(importerDir)) return false;
  const basename = rel.split("/").at(-1) ?? "";
  return basename !== "port.ts" && basename !== "module.ts" && basename !== "index.ts";
}

export async function scanAuthorityBoundaries(root = resolve("src")): Promise<AuthorityGuardResult> {
  const files = await walk(root);
  const violations: AuthorityGuardViolation[] = [];

  for (const file of files) {
    const rel = relative(root, file).replaceAll("\\", "/");
    const importerDir = rel.split("/")[0] ?? "";
    const source = stripComments(await readFile(file, "utf8"));
    const implementation = isDomainImplementation(importerDir, rel);

    const forbiddenImports = SINGLE_AUTHORITY_FORBIDDEN_IMPORTS[importerDir];
    if (forbiddenImports && implementation) {
      for (const { specifier, offset } of importTargets(source)) {
        const domain = targetDomain(importerDir, specifier);
        if (domain && forbiddenImports.includes(domain)) {
          violations.push({
            file: rel,
            line: lineOf(source, offset),
            rule: "single-authority-domain-import",
            detail: `${importerDir} implementation must not directly import /${domain}; use a provider-neutral lookup and composition-root orchestration`,
          });
        }
      }
    }

    if (implementation && importerDir !== "workflows") {
      for (const hit of regexHits(source, WORKFLOW_CALL_PATTERNS)) {
        violations.push({
          file: rel,
          line: lineOf(source, hit.offset),
          rule: "workflow-authority-only",
          detail: "operational workflow transition calls are reserved for /workflows or composition-root orchestration",
        });
      }
    }

    if (importerDir === "contributions" && implementation) {
      for (const identifier of CONTRIBUTION_RISK_MUTATION_IDENTIFIERS) {
        const re = new RegExp(`\\b${identifier}\\s*\\(`, "g");
        for (const hit of regexHits(source, [re])) {
          violations.push({
            file: rel,
            line: lineOf(source, hit.offset),
            rule: "contributions-must-not-mutate-risk-authority",
            detail: `risk mutation ${identifier} is reserved for composition-root orchestration`,
          });
        }
      }
    }

    if (importerDir === "disputes" && implementation) {
      for (const identifier of DISPUTES_ECONOMIC_OR_REPUTATION_IDENTIFIERS) {
        const re = new RegExp(`\\b${identifier}\\s*\(`, "g");
        for (const hit of regexHits(source, [re])) {
          violations.push({
            file: rel,
            line: lineOf(source, hit.offset),
            rule: "disputes-must-not-own-economic-or-reputation-state",
            detail: `economic/reputation mutation ${identifier} is forbidden inside /disputes`,
          });
        }
      }
    }

    if (implementation && importerDir !== "workflows" && !ADMINISTRATIVE_STATUS_DOMAINS.has(importerDir)) {
      for (const hit of regexHits(source, LOCAL_STATUS_HELPER_PATTERNS)) {
        violations.push({
          file: rel,
          line: lineOf(source, hit.offset),
          rule: "administrative-status-requires-allowlist",
          detail: `local administrative status machine in /${importerDir} is not allowlisted`,
        });
      }
    }
  }

  return { filesScanned: files.length, violations };
}

function repoRoot(): string {
  return resolve(dirname(new URL(import.meta.url).pathname), "..");
}

if (import.meta.main) {
  const result = await scanAuthorityBoundaries(resolve(repoRoot(), "src"));
  if (result.violations.length === 0) {
    console.log(`✓ authority-boundary guard passed: ${result.filesScanned} files scanned, 0 violations.`);
    process.exit(0);
  }
  for (const violation of result.violations) {
    console.error(`✗ ${violation.file}:${violation.line} [${violation.rule}] ${violation.detail}`);
  }
  console.error(`authority-boundary guard failed: ${result.violations.length} violation(s).`);
  process.exit(1);
}
