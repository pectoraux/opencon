import { describe, expect, test } from "bun:test";
import { readdir, readFile } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";
import {
  ADMINISTRATIVE_STATUS_DOMAINS,
  scanAuthorityBoundaries,
} from "../../scripts/check-authority-boundaries.ts";

/**
 * Architectural regression guardrails for the intentional authority
 * watchpoints:
 *
 * - /disputes stays the single fraud/risk control authority.
 * - /contributions may own quality/moderation semantics but cannot mutate
 *   risk, economic, reputation, or workflow authority directly.
 * - operational lifecycle stays in /workflows; domain-local administrative
 *   status is an explicit, reviewed precedent rather than a default.
 * - /settlement and /reputation stay the only economic and reputation
 *   mutation authorities.
 *
 * The guard detects BEHAVIOR (mutation call sites, machinery definitions,
 * local status machines in domain implementation files) — not generic
 * identifiers. The fixture corpora pin both directions:
 *
 * - approved/ — already-approved machinery (campaign administrative
 *   status, creator administrative status, the TransitionRequest shared
 *   contract, the requestTransition neutral delegation callback, api
 *   transport over the composed command surface, the composition root,
 *   and each owning authority itself) must NEVER be flagged.
 * - rejected/ — a newly introduced local workflow/risk/economic/
 *   reputation authority, an un-allowlisted local status machine, and
 *   direct authority imports MUST be flagged.
 */

const HERE = dirname(new URL(import.meta.url).pathname);
const REPO = resolve(HERE, "../..");
const FIXTURES = join(HERE, "fixtures/authority-guard");
const APPROVED = join(FIXTURES, "approved");
const REJECTED = join(FIXTURES, "rejected");

async function listTsFiles(root: string, prefix = ""): Promise<string[]> {
  const out: string[] = [];
  for (const entry of await readdir(root, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      out.push(...(await listTsFiles(join(root, entry.name), `${prefix}${entry.name}/`)));
    } else if (entry.isFile() && entry.name.endsWith(".ts")) {
      out.push(`${prefix}${entry.name}`);
    }
  }
  return out.sort();
}

describe("authority-boundary guardrails", () => {
  test("current source satisfies all authority-boundary rules", async () => {
    const result = await scanAuthorityBoundaries(join(REPO, "src"));
    expect(result.violations).toEqual([]);
    expect(result.filesScanned).toBeGreaterThan(0);
  });

  test("only explicitly approved administrative-status precedents are allowlisted", () => {
    // Approved precedents (each requires an architectural decision of
    // record — see docs/architecture-authority-guardrails.md):
    // - "campaigns": architect-approved campaign administrative status
    //   (owner-only campaign administration; campaign clearing work orders).
    // - "creators": creator-profile administration (NET-W015).
    expect([...ADMINISTRATIVE_STATUS_DOMAINS].sort()).toEqual(["campaigns", "creators"]);
  });

  test("positive fixtures: approved machinery is never flagged", async () => {
    const files = await listTsFiles(APPROVED);
    expect(files).toEqual([
      "api/transport.ts",
      "bootstrap/composition.ts",
      "campaigns/administrative-status.ts",
      "contributions/port.ts",
      "core/workflow-contract.ts",
      "creators/administrative-status.ts",
      "disputes/risk-authority.ts",
      "evidence/workflow-delegation.ts",
      "outcomes/workflow-delegation.ts",
      "reputation/reputation-authority.ts",
      "settlement/economic-authority.ts",
      "workflows/workflow-service.ts",
    ]);

    const result = await scanAuthorityBoundaries(APPROVED);
    expect(result.filesScanned).toBe(files.length);
    expect(result.violations).toEqual([]);
  });

  test("positive fixtures genuinely exercise the originally false-positive patterns", async () => {
    // Guards the corpus against silent degradation: the approved fixtures
    // must actually contain the vocabulary/delegation/administrative
    // machinery that the original identifier-matching guard falsely
    // flagged (TransitionRequest references, requestTransition delegation,
    // campaigns administrative status, composition-root orchestration).
    const read = async (rel: string) =>
      readFile(join(APPROVED, rel), "utf8");

    const outcomes = await read("outcomes/workflow-delegation.ts");
    expect(outcomes).toContain("TransitionRequest");
    expect(outcomes).toContain("requestTransition");

    const evidence = await read("evidence/workflow-delegation.ts");
    expect(evidence).toContain("TransitionRequest");
    expect(evidence).toContain("requestTransition");

    const contract = await read("core/workflow-contract.ts");
    expect(contract).toContain("export interface TransitionRequest");

    const campaignsStatus = await read("campaigns/administrative-status.ts");
    expect(campaignsStatus).toContain("statusTransition");

    const creatorsStatus = await read("creators/administrative-status.ts");
    expect(creatorsStatus).toContain("statusTransition");

    const transport = await read("api/transport.ts");
    expect(transport).toContain("commands.requestTransition");
    expect(transport).toContain("commands.createRiskSignal");
    expect(transport).toContain("commands.issueCredits");

    const composition = await read("bootstrap/composition.ts");
    expect(composition).toContain("createRiskSignal");
    expect(composition).toContain("issueCredits");
    expect(composition).toContain("requestTransition");
  });

  test("negative fixtures: local workflow/risk/economic/reputation authority is rejected", async () => {
    const files = await listTsFiles(REJECTED);
    expect(files).toEqual([
      "campaigns/local-risk-authority.ts",
      "contributions/risk-mutation.ts",
      "contributions/settlement-import.ts",
      "disputes/economic-authority.ts",
      "disputes/workflow-import.ts",
      "inventory/local-workflow-authority.ts",
      "opportunities/local-status-machine.ts",
    ]);

    const result = await scanAuthorityBoundaries(REJECTED);
    expect(result.filesScanned).toBe(files.length);

    // Every rejected fixture must be flagged — no silent passes.
    const flaggedFiles = new Set(result.violations.map((v) => v.file));
    expect([...flaggedFiles].sort()).toEqual(files);

    // The exact violation multiset is pinned: file + rule for every hit
    // (definitions AND call sites are both mutation behavior — the
    // inventory workflow machinery fixture produces five hits).
    const summary = result.violations
      .map((v) => `${v.file}|${v.rule}`)
      .sort();
    expect(summary).toEqual([
      // local risk authority, including from an admin-allowlisted domain
      "campaigns/local-risk-authority.ts|risk-authority-mutation",
      "campaigns/local-risk-authority.ts|risk-authority-mutation",
      // risk mutation inside /contributions (the W013 boundary)
      "contributions/risk-mutation.ts|risk-authority-mutation",
      // /contributions directly importing the settlement authority
      "contributions/settlement-import.ts|single-authority-domain-import",
      // /disputes becoming a second economic + reputation authority
      "disputes/economic-authority.ts|economic-authority-mutation",
      "disputes/economic-authority.ts|economic-authority-mutation",
      "disputes/economic-authority.ts|reputation-authority-mutation",
      // /disputes directly importing the workflow authority
      "disputes/workflow-import.ts|single-authority-domain-import",
      // a domain re-implementing operational lifecycle machinery
      "inventory/local-workflow-authority.ts|workflow-authority-mutation",
      "inventory/local-workflow-authority.ts|workflow-authority-mutation",
      "inventory/local-workflow-authority.ts|workflow-authority-mutation",
      "inventory/local-workflow-authority.ts|workflow-authority-mutation",
      "inventory/local-workflow-authority.ts|workflow-authority-mutation",
      // an un-allowlisted domain-local administrative status machine
      "opportunities/local-status-machine.ts|administrative-status-requires-allowlist",
    ]);
  });
});
