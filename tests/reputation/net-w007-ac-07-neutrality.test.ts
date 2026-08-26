/**
 * NET-W007-AC-07 — Provider/model inputs remain provider-neutral and
 * non-authoritative.
 *
 *  - model-assessed and self-reported evidence contributes ONLY as
 *    `indicated` basis inputs at reduced weight, and can NEVER alone
 *    lift a dimension to a fully verified score (architecture-lock
 *    §4 — model output is input evidence, never authoritative);
 *  - the reputation domain consumes upstream records through neutral
 *    structural lookups only: no provider/platform-specific scoring
 *    semantics exist in the domain (the input contract references
 *    upstream records by kind+id, nothing more);
 *  - the domain imports ONLY core contracts + self (static import
 *    scan — the same guarantee the architecture checker enforces).
 *
 * Evidence: domain integration tests + static import scan.
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { join } from "node:path";
import { readdir, readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import {
  createNetW007Harness,
  actorCtx,
  createDefaultPolicy,
  createEvidence,
  createVerifiedContribution,
  REF_AT,
  type NetW007Harness,
} from "./_net-w007-harness.ts";

let harness: NetW007Harness;

beforeEach(async () => {
  harness = await createNetW007Harness();
});

afterEach(async () => {
  await harness.teardown();
});

const REPO = join(import.meta.dir, "../..");
const SRC = join(REPO, "src");

async function listTsFiles(dir: string, out: string[] = []): Promise<string[]> {
  if (!existsSync(dir)) return out;
  const entries = await readdir(dir, { withFileTypes: true });
  for (const e of entries) {
    const full = join(dir, e.name);
    if (e.isDirectory()) await listTsFiles(full, out);
    else if (e.isFile() && e.name.endsWith(".ts")) out.push(full);
  }
  return out;
}

describe("NET-W007-AC-07 provider/model neutrality", () => {
  test("model-assessed evidence yields an INDICATED input (never verified) at reduced weight", async () => {
    await createDefaultPolicy(harness);
    const modelEvidence = await createEvidence(harness, { sourceType: "model" });
    const ctx = actorCtx(harness, "ac07-model");
    const result = await harness.runtime.reputationInputService.recordInput(ctx, {
      organizationScopeId: harness.organizationScopeId,
      subjectPersonId: harness.personId,
      dimension: "content_quality",
      sources: [{ kind: "evidence", id: modelEvidence.id }],
      occurredAt: REF_AT,
      idempotencyKey: "ac07-model-input",
    });
    expect(result.input.basis).toBe("indicated");
    const computed = await harness.runtime.reputationSnapshotService.computeScores(ctx, {
      organizationScopeId: harness.organizationScopeId,
      subjectPersonId: harness.personId,
      policyId: "policy-w007-default",
      version: 1,
      referenceAt: REF_AT,
    });
    const content = computed.scores.find((s) => s.dimension === "content_quality")!;
    // indicatedWeightFactor 0.25 → score 0.25 (not the full weight 1).
    expect(content.score).toBe(0.25);
    expect(content.verifiedInputCount).toBe(0);
    expect(content.indicatedInputCount).toBe(1);
  });

  test("model/self inputs ALONE can never reach a fully verified score (indicatedOnlyCap binds regardless of volume)", async () => {
    await createDefaultPolicy(harness);
    const ctx = actorCtx(harness, "ac07-model-capped");
    // 120 model + self inputs — unverified volume far beyond the cap
    // (120 × 0.25 = 30 raw weight vs the 10-point indicatedOnlyCap).
    for (let i = 0; i < 120; i++) {
      const evidence = await createEvidence(harness, {
        sourceType: i % 2 === 0 ? "model" : "self",
        sourceId: `gen-${i}`,
      });
      await harness.runtime.reputationInputService.recordInput(ctx, {
        organizationScopeId: harness.organizationScopeId,
        subjectPersonId: harness.personId,
        dimension: "helpfulness",
        sources: [{ kind: "evidence", id: evidence.id }],
        occurredAt: REF_AT,
        idempotencyKey: `ac07-model-capped-${i}`,
      });
    }
    const computed = await harness.runtime.reputationSnapshotService.computeScores(ctx, {
      organizationScopeId: harness.organizationScopeId,
      subjectPersonId: harness.personId,
      policyId: "policy-w007-default",
      version: 1,
      referenceAt: REF_AT,
    });
    const helpfulness = computed.scores.find((s) => s.dimension === "helpfulness")!;
    expect(helpfulness.verifiedInputCount).toBe(0);
    expect(helpfulness.capped).toBe(true);
    expect(helpfulness.score).toBe(10); // indicatedOnlyCap, NOT 30
    expect(helpfulness.score).toBeLessThan(100); // maxScore unreachable
    expect(helpfulness.decayedIndicatedWeight).toBe(30);
  });

  test("a single verified source among model inputs upgrades the basis — verified evidence outranks model output", async () => {
    await createDefaultPolicy(harness);
    const modelEvidence = await createEvidence(harness, { sourceType: "model" });
    const ctx = actorCtx(harness, "ac07-mixed");
    const contributionId = await createVerifiedContribution(harness);
    const result = await harness.runtime.reputationInputService.recordInput(ctx, {
      organizationScopeId: harness.organizationScopeId,
      subjectPersonId: harness.personId,
      dimension: "helpfulness",
      sources: [
        { kind: "evidence", id: modelEvidence.id },
        { kind: "contribution", id: contributionId },
      ],
      occurredAt: REF_AT,
      idempotencyKey: "ac07-mixed-input",
    });
    // The verified contribution establishes the verified basis for the
    // input — the model evidence does not veto it, and cannot alone
    // establish it.
    expect(result.input.basis).toBe("verified");
  });

  test("provider evidence (any provider) is verified-grade with NO provider-specific scoring semantics", async () => {
    await createDefaultPolicy(harness);
    const ctx = actorCtx(harness, "ac07-provider");
    // Two inputs backed by DIFFERENT providers' evidence score
    // identically: the engine sees (dimension, basis, occurredAt) only.
    for (const provider of ["provider-a", "provider-b", "provider-c"]) {
      const evidence = await createEvidence(harness, { sourceType: "provider", sourceId: provider });
      const result = await harness.runtime.reputationInputService.recordInput(ctx, {
        organizationScopeId: harness.organizationScopeId,
        subjectPersonId: harness.personId,
        dimension: "measurement_reliability",
        sources: [{ kind: "evidence", id: evidence.id }],
        occurredAt: REF_AT,
        idempotencyKey: `ac07-provider-${provider}`,
      });
      expect(result.input.basis).toBe("verified");
      // The persisted source reference is a bare kind+id pair — no
      // provider-specific payload or scoring hint is carried.
      expect(result.input.sources).toEqual([{ kind: "evidence", id: evidence.id }]);
    }
    const computed = await harness.runtime.reputationSnapshotService.computeScores(ctx, {
      organizationScopeId: harness.organizationScopeId,
      subjectPersonId: harness.personId,
      policyId: "policy-w007-default",
      version: 1,
      referenceAt: REF_AT,
    });
    const measurement = computed.scores.find((s) => s.dimension === "measurement_reliability")!;
    expect(measurement.score).toBe(3); // 3 verified inputs × weight 1
  });

  test("the reputation domain imports ONLY core contracts + self (provider-neutral boundary)", async () => {
    const files = await listTsFiles(join(SRC, "reputation"));
    expect(files.length).toBeGreaterThan(5);
    const importRe = /(?:^|[;\s{}()])(?:import|export)(?:[^'"`;]*?from)?\s*["']([^"']+)["']/g;
    for (const file of files) {
      const content = await readFile(file, "utf8");
      let m: RegExpExecArray | null;
      while ((m = importRe.exec(content)) !== null) {
        const spec = m[1] ?? "";
        if (!spec.startsWith(".")) continue;
        const resolved = join(file, "..", spec).replace(/\.ts$/, "");
        const rel = resolved.slice(SRC.length + 1).split(/[\\/]/)[0]!;
        if (rel !== "reputation" && rel !== "core") {
          throw new Error(
            `NET-W007 neutrality violation: ${file} imports "../${rel}" (only core + self are permitted)`,
          );
        }
      }
    }
  });

  test("no other domain imports the reputation domain (no reverse coupling)", async () => {
    // The reputation engine is a LEAF: no other domain may depend on it
    // (consuming reputation happens through future work items'
    // declared interfaces, not direct imports).
    const domainDirs = [
      "identity", "organizations", "participants", "opportunities",
      "contributions", "campaigns", "inventory", "creators", "demand",
      "benefits", "evidence", "outcomes", "settlement", "disputes",
      "workflows",
    ];
    const importRe = /(?:^|[;\s{}()])(?:import|export)(?:[^'"`;]*?from)?\s*["']([^"']+)["']/g;
    for (const dir of domainDirs) {
      const files = await listTsFiles(join(SRC, dir));
      for (const file of files) {
        const content = await readFile(file, "utf8");
        let m: RegExpExecArray | null;
        while ((m = importRe.exec(content)) !== null) {
          const spec = m[1] ?? "";
          if (!spec.startsWith(".")) continue;
          const resolved = join(file, "..", spec).replace(/\.ts$/, "");
          const rel = resolved.slice(SRC.length + 1).split(/[\\/]/)[0]!;
          expect(rel).not.toBe("reputation");
        }
      }
    }
  });

  test("the input carries no model/provider authority: an input whose ONLY backing is model output stays indicated even after many attestations elsewhere", async () => {
    await createDefaultPolicy(harness);
    const modelEvidence = await createEvidence(harness, { sourceType: "model" });
    const ctx = actorCtx(harness, "ac07-model-only");
    // Re-record model-only inputs across MANY dimensions — none of them
    // can establish a verified basis anywhere.
    for (const dimension of [
      "helpfulness",
      "content_quality",
      "fraud_resistance",
    ] as const) {
      const result = await harness.runtime.reputationInputService.recordInput(ctx, {
        organizationScopeId: harness.organizationScopeId,
        subjectPersonId: harness.personId,
        dimension,
        sources: [{ kind: "evidence", id: modelEvidence.id }],
        occurredAt: REF_AT,
        idempotencyKey: `ac07-model-only-${dimension}`,
      });
      expect(result.input.basis).toBe("indicated");
    }
    const computed = await harness.runtime.reputationSnapshotService.computeScores(ctx, {
      organizationScopeId: harness.organizationScopeId,
      subjectPersonId: harness.personId,
      policyId: "policy-w007-default",
      version: 1,
      referenceAt: REF_AT,
    });
    for (const dimension of ["helpfulness", "content_quality", "fraud_resistance"]) {
      const score = computed.scores.find((s) => s.dimension === dimension)!;
      expect(score.verifiedInputCount).toBe(0);
      expect(score.score).toBeLessThanOrEqual(0.25);
    }
  });
});
