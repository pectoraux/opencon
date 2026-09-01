/**
 * NET-W030 AC-07 — traceability + settlement-authority containment
 * (issue #61; work order §3.1, §3.5, §6).
 *
 * Traceability in BOTH directions: a recorded fact resolves its
 * internal ledger lineage (forward) and an internal transaction
 * resolves every fact referencing it (reverse), tenant-scoped in
 * both directions. Containment: the fact layer is provider-NEUTRAL
 * (provider-specific code lives ONLY in /adapters; the API transport
 * stays neutral), and the /payments boundary stays skeletal
 * (invariant 25 — external execution remains out of scope).
 */

import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import {
  createNetW030Harness,
  recordExternalFact,
  createInternalLineage,
  actorCtx,
  type NetW030Harness,
} from "./_net-w030-harness.ts";

const REPO = join(import.meta.dir, "../..");

describe("NET-W030-AC-07 traceability + settlement-authority containment", () => {
  let harness: NetW030Harness;

  beforeAll(async () => {
    harness = await createNetW030Harness();
  });

  afterAll(async () => {
    await harness.teardown();
  });

  test("FORWARD traceability: the fact → the internal ledger transaction (via the reconciliation view)", async () => {
    const lineage = await createInternalLineage(harness, 44);
    const fact = await recordExternalFact(harness, {
      internalTransactionId: lineage.transactionId,
      reportedAmount: 44,
    });
    const view = await harness.runtime.externalSettlementService.evaluateExternalSettlementReconciliation(
      actorCtx(harness, "ac07-forward"),
      { organizationScopeId: harness.organizationScopeId, factId: fact.id },
    );
    expect(view.verdict).toBe("matched");
    expect(view.internalTransaction?.id).toBe(lineage.transactionId);
    // The authoritative transaction resolves through the ledger
    // authority's own read surface too (single source of truth).
    const tx = await harness.runtime.economicLedgerService.getTransaction(
      actorCtx(harness, "ac07-forward-tx"),
      lineage.transactionId,
    );
    expect(tx.id).toBe(lineage.transactionId);
    expect(tx.id).toBe(view.internalTransaction!.id);
    expect(tx.organizationScopeId).toBe(harness.organizationScopeId);
  });

  test("REVERSE traceability: the internal transaction → every fact referencing it (tenant-scoped)", async () => {
    const lineage = await createInternalLineage(harness, 55);
    const a = await recordExternalFact(harness, {
      externalId: `ext-rev-a-${Date.now()}`,
      internalTransactionId: lineage.transactionId,
      reportedAmount: 55,
    });
    const b = await recordExternalFact(harness, {
      externalId: `ext-rev-b-${Date.now()}`,
      internalTransactionId: lineage.transactionId,
      reportedAmount: 55,
    });
    const facts = await harness.runtime.externalSettlementService.listExternalSettlementFactsByTransaction(
      actorCtx(harness, "ac07-reverse"),
      harness.organizationScopeId,
      lineage.transactionId,
    );
    const ids = facts.map((f) => f.id);
    expect(ids).toContain(a.id);
    expect(ids).toContain(b.id);
    // Facts referencing OTHER transactions do not appear.
    const other = await createInternalLineage(harness, 66);
    const c = await recordExternalFact(harness, {
      internalTransactionId: other.transactionId,
      reportedAmount: 66,
    });
    const stillScoped = await harness.runtime.externalSettlementService.listExternalSettlementFactsByTransaction(
      actorCtx(harness, "ac07-reverse-2"),
      harness.organizationScopeId,
      lineage.transactionId,
    );
    expect(stillScoped.map((f) => f.id)).not.toContain(c.id);
    // The second org sees nothing (strict tenant scoping).
    const foreign = await harness.runtime.externalSettlementService.listExternalSettlementFactsByTransaction(
      actorCtx(harness, "ac07-reverse-foreign"),
      harness.secondOrganizationScopeId,
      lineage.transactionId,
    );
    expect(foreign).toHaveLength(0);
  });

  test("the apiCommands composite exposes the traceability surfaces (the transport stays provider-neutral)", () => {
    // The API command surface exists for both directions.
    expect(typeof harness.runtime.apiCommands.recordExternalSettlementFact).toBe("function");
    expect(typeof harness.runtime.apiCommands.getExternalSettlementFact).toBe("function");
    expect(typeof harness.runtime.apiCommands.evaluateExternalSettlementReconciliation).toBe("function");
    expect(typeof harness.runtime.apiCommands.listExternalSettlementFactsByTransaction).toBe("function");
  });

  test("PROVIDER NEUTRALITY: the /settlement fact layer and the API transport carry NO provider-specific code", async () => {
    // The settlement fact layer declares the neutral contract only.
    const port = await readFile(join(REPO, "src/settlement/port.ts"), "utf8");
    const service = await readFile(
      join(REPO, "src/settlement/external-settlement-service.ts"),
      "utf8",
    );
    const input = await readFile(
      join(REPO, "src/settlement/external-settlement-input.ts"),
      "utf8",
    );
    for (const [label, content] of [
      ["port.ts", port],
      ["service", service],
      ["input", input],
    ] as const) {
      // No vendor SDK imports, no provider payload grammar in the
      // domain: the closed `reference` VOCABULARY entry is data, not
      // provider-specific CODE.
      expect(content, `${label} must not import vendor SDKs`).not.toMatch(
        /from ["'](stripe|paypal|adyen|braintree)/i,
      );
      expect(content, `${label} must not parse provider payloads`).not.toMatch(
        /payload\.externalId/,
      );
    }
    // The API transport stays provider-neutral: no provider-specific
    // vocabulary in the route layer.
    const server = await readFile(join(REPO, "src/api/server.ts"), "utf8");
    expect(server).toContain("/api/settlement/external-facts");
    for (const banned of [/["']reference["']/, /\bstripe\b/i, /\bpaypal\b/i]) {
      expect(server).not.toMatch(banned);
    }
  });

  test("the /payments boundary stays SKELETAL (invariant 25: no external execution of internal mutations)", async () => {
    const paymentsPort = await readFile(join(REPO, "src/payments/port.ts"), "utf8");
    expect(paymentsPort).toContain("skeleton");
    // The settlement fact layer never imports /payments or /ledger.
    for (const rel of [
      "src/settlement/external-settlement-service.ts",
      "src/settlement/external-settlement-input.ts",
      "src/settlement/authority-external-settlement-repository.ts",
    ]) {
      const content = await readFile(join(REPO, rel), "utf8");
      expect(content).not.toMatch(/from ["']\.\.\/payments\//);
      expect(content).not.toMatch(/from ["']\.\.\/ledger\//);
    }
  });

  test("the composition root is the ONLY join: the adapter implements the neutral contract STRUCTURALLY (no domain import)", async () => {
    const adapter = await readFile(
      join(REPO, "src/adapters/settlement/reference-adapter.ts"),
      "utf8",
    );
    // The adapter tier may not import the settlement domain.
    expect(adapter).not.toMatch(/from ["']\.\.\/\.\.\/settlement\//);
    expect(adapter).not.toMatch(/from ["']\.\.\/settlement\//);
    // ...and the wiring join lives in the composition root.
    const runtime = await readFile(join(REPO, "src/bootstrap/runtime.ts"), "utf8");
    expect(runtime).toContain("new ExternalSettlementReferenceAdapter()");
    expect(runtime).toContain("selectExternalSettlementAuthentication(");
    expect(runtime).toContain("createExternalSettlementService(");
  });
});
