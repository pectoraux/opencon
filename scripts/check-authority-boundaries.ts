/**
 * Authority-boundary guardrails — BEHAVIORAL detection.
 *
 * These rules make the architectural authority watchpoints mechanically
 * enforceable without changing frozen Architecture v1.0:
 *
 * 1. /disputes is the single fraud/risk control authority.
 * 2. /contributions owns quality/moderation semantics, but risk mutation
 *    remains a composition-root concern.
 * 3. /workflows is the only operational lifecycle authority. Other domains
 *    may carry explicitly approved administrative status, but operational
 *    transition machinery cannot be re-implemented locally.
 * 4. /settlement is the only economic mutation authority and /reputation
 *    the only reputation mutation authority.
 *
 * DETECTION SEMANTICS (architect-required correction, PR #30 review):
 * the guard detects ACTUAL unauthorized authority/mutation behavior —
 * call sites of reserved mutation primitives, construction or definition
 * of another authority's machinery, and local administrative status
 * machines — and only inside DOMAIN IMPLEMENTATION files. It
 * deliberately does NOT match generic identifiers:
 *
 *   - Shared vocabulary/type contracts (e.g. the `TransitionRequest`
 *     contract in /core) may be referenced anywhere. A type name is not
 *     a mutation.
 *   - The provider-neutral delegation callback `requestTransition`
 *     (declared on domain ports, invoked by domain services, exposed on
 *     the API command surface) is the SANCTIONED way every domain asks
 *     /workflows to move lifecycle state. Delegating is not authority.
 *   - /api transport calls the composition-root command surface
 *     (`commands.createRiskSignal(...)`, `commands.issueCredits(...)`)
 *     and is not a domain implementation.
 *   - /bootstrap is the composition root: it is the place where
 *     cross-authority orchestration is ALLOWED.
 *   - port.ts / module.ts / index.ts files are contracts and wiring,
 *     not semantic implementation.
 *   - Comments are stripped before scanning.
 *
 * Already-approved precedents are explicitly preserved (see
 * ADMINISTRATIVE_STATUS_DOMAINS below and the positive/negative fixture
 * corpora under tests/regression/fixtures/authority-guard/ which pin
 * both directions).
 *
 * The existing tier checker (scripts/check-architecture.ts) remains
 * authoritative for dependency direction; this guard prevents semantic
 * authority drift inside otherwise legal boundaries.
 */

import { readdir, readFile } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";

/**
 * Domain-local administrative state explicitly approved by architecture
 * review. Every entry is a reviewed precedent, not a default:
 *
 * - "campaigns": the campaign administrative status machine —
 *   architect-approved administrative campaign state (owner-only
 *   campaign administration under the campaign record mutex; the
 *   campaign clearing/reward work orders). Administrative state
 *   intrinsic to the domain; never an operational lifecycle.
 * - "creators": creator-profile administration (NET-W015:
 *   DRAFT → ACTIVE ⇄ PAUSED → ARCHIVED, owner-only, activation-gated).
 *
 * New domain-local status machines require an explicit addition here
 * plus regression evidence (see docs/architecture-authority-guardrails.md).
 */
export const ADMINISTRATIVE_STATUS_DOMAINS = new Set(["campaigns", "creators"]);

const DOMAIN_DIRS = new Set([
  "identity", "organizations", "participants", "opportunities", "contributions",
  "campaigns", "inventory", "creators", "demand", "benefits", "reputation",
  "evidence", "outcomes", "settlement", "disputes", "workflows",
]);

/**
 * Single-authority watchpoints: these domains must not directly import the
 * authorities they could otherwise shadow. Cross-domain facts arrive through
 * provider-neutral lookup contracts; cross-domain commands are composed at
 * the bootstrap boundary.
 */
const SINGLE_AUTHORITY_FORBIDDEN_IMPORTS: Record<string, readonly string[]> = {
  disputes: ["settlement", "reputation", "workflows", "campaigns"],
  contributions: ["disputes", "settlement", "reputation", "workflows"],
};

/**
 * Reserved mutation primitives per owning authority. A hit is BEHAVIOR:
 * a call site or a function definition (both match `identifier(`), or —
 * for the workflow machinery — a construction/definition of the service
 * type itself. The owning authority is exempt; every other domain
 * implementation is policed. /core, /api, /bootstrap, adapters and
 * infrastructure are not domain implementations and are never scanned
 * for these rules.
 */
const AUTHORITY_MUTATION_RULES: readonly {
  readonly owner: string;
  readonly rule: string;
  readonly detail: string;
  readonly callIdentifiers: readonly string[];
  readonly machineryPatterns?: readonly RegExp[];
}[] = [
  {
    owner: "workflows",
    rule: "workflow-authority-mutation",
    detail:
      "operational lifecycle mutation is reserved for /workflows; delegate through the provider-neutral requestTransition callback (composition-root orchestration)",
    callIdentifiers: ["performTransition", "transitionWorkflow"],
    machineryPatterns: [/\bclass\s+WorkflowService\b/g, /\bnew\s+WorkflowService\s*\(/g],
  },
  {
    owner: "disputes",
    rule: "risk-authority-mutation",
    detail:
      "risk mutation is reserved for /disputes; emit risk decisions only through composition-root orchestration",
    callIdentifiers: [
      "createSignal",
      "supersedeSignal",
      "createRiskSignal",
      "createRiskAssessment",
      "createRiskCase",
    ],
  },
  {
    owner: "settlement",
    rule: "economic-authority-mutation",
    detail:
      "economic mutation is reserved for /settlement; compose economic effects at the bootstrap boundary",
    callIdentifiers: [
      "issueCredits",
      "matureEconomicValue",
      "allocateRewards",
      "recordCashObligation",
    ],
  },
  {
    owner: "reputation",
    rule: "reputation-authority-mutation",
    detail:
      "reputation mutation is reserved for /reputation; reference snapshots and compose effects at the bootstrap boundary",
    callIdentifiers: [
      "createReputationInput",
      "createReputationSnapshot",
      "addReputationInput",
    ],
  },
];

/**
 * Domain-local administrative status machinery (definition or call sites).
 * Allowed only in /workflows (the operational authority itself) and the
 * explicitly approved administrative-status precedents above.
 */
const LOCAL_STATUS_HELPER_PATTERNS: readonly RegExp[] = [
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
  const re = /(?:import|export)(?:[^'\";]*?from)?\s*[\"']([^\"']+)[\"']/g;
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

function callPattern(identifier: string): RegExp {
  return new RegExp(String.raw`\b${identifier}\s*\(`, "g");
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

    // All rules below police SEMANTIC IMPLEMENTATION only. Shared
    // contracts (port/module/index), the /core vocabulary layer, /api
    // transport, /bootstrap composition root, adapters and
    // infrastructure are out of scope by design.
    if (!isDomainImplementation(importerDir, rel)) continue;

    const forbiddenImports = SINGLE_AUTHORITY_FORBIDDEN_IMPORTS[importerDir];
    if (forbiddenImports) {
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

    // Reserved authority-mutation behavior. The owner is exempt; a
    // provider-neutral `requestTransition` callback injected into a
    // domain is the sanctioned delegation path and is never matched.
    for (const spec of AUTHORITY_MUTATION_RULES) {
      if (importerDir === spec.owner) continue;
      const patterns = [
        ...spec.callIdentifiers.map(callPattern),
        ...(spec.machineryPatterns ?? []),
      ];
      for (const hit of regexHits(source, patterns)) {
        violations.push({
          file: rel,
          line: lineOf(source, hit.offset),
          rule: spec.rule,
          detail: spec.detail,
        });
      }
    }

    // Domain-local administrative status machinery is an architectural
    // decision, not an accident. Only approved precedents may use it.
    if (importerDir !== "workflows" && !ADMINISTRATIVE_STATUS_DOMAINS.has(importerDir)) {
      for (const hit of regexHits(source, LOCAL_STATUS_HELPER_PATTERNS)) {
        violations.push({
          file: rel,
          line: lineOf(source, hit.offset),
          rule: "administrative-status-requires-allowlist",
          detail: `local administrative status machine in /${importerDir} is not allowlisted; add an explicit architectural decision before introducing domain-local state transitions`,
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
