/**
 * Authority-boundary guardrails.
 *
 * These rules do NOT change frozen Architecture v1.0. They make three
 * architectural watchpoints mechanically enforceable for future work:
 *
 * 1. /disputes is the single fraud/risk control authority. It may consume
 *    provider-neutral references, but it must not become a second economic,
 *    reputation, workflow, or campaign authority.
 * 2. /contributions owns contribution quality/moderation semantics, but must
 *    not directly mutate /disputes, /settlement, /reputation, or /workflows.
 *    W013 risk-signal emission remains a composition-root concern.
 * 3. /workflows is the only operational lifecycle authority. Other domains
 *    may have narrowly-scoped administrative status, but any such status
 *    machine must be explicitly allowlisted here and must not use workflow
 *    transition primitives.
 *
 * This is intentionally dependency-free and deterministic so it can run in
 * CI alongside scripts/check-architecture.ts.
 */

import { readdir, readFile } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";

export const ADMINISTRATIVE_STATUS_DOMAINS = new Set(["creators"]);

const SINGLE_AUTHORITY_FORBIDDEN_IMPORTS: Record<string, readonly string[]> = {
  disputes: ["settlement", "reputation", "workflows", "campaigns"],
  contributions: ["disputes", "settlement", "reputation", "workflows"],
};

const WORKFLOW_PRIMITIVE_IDENTIFIERS = [
  "requestTransition",
  "performTransition",
  "WorkflowService",
  "TransitionRequest",
  "transitionWorkflow",
];

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
  while ((match = re.exec(source)) !== null) {
    out.push({ specifier: match[1] ?? "", offset: match.index });
  }
  return out;
}

function targetDomain(importerDir: string, specifier: string): string | null {
  if (!specifier.startsWith(".")) return null;
  const base = resolve(join("src", importerDir), specifier);
  const rel = relative(resolve("src"), base).replaceAll("\\", "/");
  const first = rel.split("/")[0] ?? "";
  return first && first !== "core" ? first : null;
}

function identifierHits(source: string, identifiers: readonly string[]): readonly { identifier: string; offset: number }[] {
  const hits: { identifier: string; offset: number }[] = [];
  for (const identifier of identifiers) {
    const re = new RegExp(`\\b${identifier}\\b`, "g");
    let match: RegExpExecArray | null;
    while ((match = re.exec(source)) !== null) hits.push({ identifier, offset: match.index });
  }
  return hits.sort((a, b) => a.offset - b.offset);
}

export async function scanAuthorityBoundaries(root = resolve("src")): Promise<AuthorityGuardResult> {
  const files = await walk(root);
  const violations: AuthorityGuardViolation[] = [];

  for (const file of files) {
    const rel = relative(root, file).replaceAll("\\", "/");
    const importerDir = rel.split("/")[0] ?? "";
    const source = stripComments(await readFile(file, "utf8"));

    const forbiddenImports = SINGLE_AUTHORITY_FORBIDDEN_IMPORTS[importerDir];
    if (forbiddenImports) {
      for (const { specifier, offset } of importTargets(source)) {
        const domain = targetDomain(importerDir, specifier);
        if (domain && forbiddenImports.includes(domain)) {
          violations.push({
            file: rel,
            line: lineOf(source, offset),
            rule: "single-authority-domain-import",
            detail: `${importerDir} must not directly import /${domain}; use a provider-neutral lookup and composition-root orchestration`,
          });
        }
      }
    }

    // Operational lifecycle primitives may only exist in the workflow authority.
    if (importerDir !== "workflows" && importerDir !== "bootstrap") {
      for (const hit of identifierHits(source, WORKFLOW_PRIMITIVE_IDENTIFIERS)) {
        violations.push({
          file: rel,
          line: lineOf(source, hit.offset),
          rule: "workflow-authority-only",
          detail: `identifier ${hit.identifier} is reserved for /workflows; domain administrative status must not become an operational lifecycle`,
        });
      }
    }

    // Contributions may evaluate/record moderation, but risk-signal mutation is
    // deliberately a composition-root operation feeding the existing /disputes authority.
    if (importerDir === "contributions") {
      for (const hit of identifierHits(source, CONTRIBUTION_RISK_MUTATION_IDENTIFIERS)) {
        violations.push({
          file: rel,
          line: lineOf(source, hit.offset),
          rule: "contributions-must-not-mutate-risk-authority",
          detail: `identifier ${hit.identifier} must not be called from /contributions; emit risk decisions only through composition-root orchestration`,
        });
      }
    }

    // The fraud/risk authority must not become an economic or trust-score authority.
    if (importerDir === "disputes") {
      for (const hit of identifierHits(source, DISPUTES_ECONOMIC_OR_REPUTATION_IDENTIFIERS)) {
        violations.push({
          file: rel,
          line: lineOf(source, hit.offset),
          rule: "disputes-must-not-own-economic-or-reputation-state",
          detail: `identifier ${hit.identifier} would make /disputes a second economic/reputation authority`,
        });
      }
    }

    // Any explicit local status-transition helper is an architectural choice,
    // not an accident. Only documented administrative-state domains may use it.
    if (importerDir !== "workflows" && importerDir !== "bootstrap" && !ADMINISTRATIVE_STATUS_DOMAINS.has(importerDir)) {
      for (const hit of identifierHits(source, ["statusTransition", "statusMachine", "administrativeStatusTransition"])) {
        violations.push({
          file: rel,
          line: lineOf(source, hit.offset),
          rule: "administrative-status-requires-allowlist",
          detail: `local status machine in /${importerDir} is not allowlisted; add an explicit architectural decision before introducing domain-local state transitions`,
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
