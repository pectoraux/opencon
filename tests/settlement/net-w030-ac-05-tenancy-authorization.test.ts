/**
 * NET-W030 AC-05 — privacy + tenancy + authorization (issue #61;
 * work order §3.5, §6).
 *
 * External transaction facts and reconciliation views are
 * tenant-scoped: cross-tenant and unauthorized access fails closed
 * WITHOUT existence oracles (cross-tenant and nonexistent are
 * indistinguishable). The ingestion/read/reconcile surfaces follow
 * the established guard-action pattern (server-side authorization
 * over the server-resolved principal — never client claims).
 */

import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { createRuntime, type Runtime } from "../../src/bootstrap/runtime.ts";
import { createExecutionContext } from "../../src/core/execution-context.ts";
import {
  createNetW030Harness,
  recordExternalFact,
  createInternalLineage,
  actorCtx,
  buildProviderNotification,
  type NetW030Harness,
} from "./_net-w030-harness.ts";
import { NotFoundError } from "../../src/core/errors.ts";

const BASE = "http://127.0.0.1";

describe("NET-W030-AC-05 privacy + tenancy + authorization", () => {
  let harness: NetW030Harness;

  beforeAll(async () => {
    harness = await createNetW030Harness();
  });

  afterAll(async () => {
    await harness.teardown();
  });

  test("a cross-tenant fact read is indistinguishable from a nonexistent one (null; no oracle)", async () => {
    const lineage = await createInternalLineage(harness);
    const fact = await recordExternalFact(harness, {
      internalTransactionId: lineage.transactionId,
    });
    const ctx = actorCtx(harness, "ac05-cross-read");
    // The second org cannot see the first org's fact.
    expect(
      await harness.runtime.externalSettlementService.getExternalSettlementFact(
        ctx,
        harness.secondOrganizationScopeId,
        fact.id,
      ),
    ).toBeNull();
    // ...which is EXACTLY what a nonexistent id returns.
    expect(
      await harness.runtime.externalSettlementService.getExternalSettlementFact(
        ctx,
        harness.secondOrganizationScopeId,
        "no-such-fact-id",
      ),
    ).toBeNull();
    expect(
      await harness.runtime.externalSettlementService.getExternalSettlementFact(
        ctx,
        harness.organizationScopeId,
        fact.id,
      ),
    ).not.toBeNull();
  });

  test("cross-tenant reconciliation and transaction listings fail closed identically", async () => {
    const lineage = await createInternalLineage(harness);
    const fact = await recordExternalFact(harness, {
      internalTransactionId: lineage.transactionId,
    });
    // Reconciliation: cross-tenant fact id → NotFoundError (the same
    // error a nonexistent id produces).
    let crossErr: unknown;
    let missingErr: unknown;
    try {
      await harness.runtime.externalSettlementService.evaluateExternalSettlementReconciliation(
        actorCtx(harness, "ac05-cross-recon"),
        { organizationScopeId: harness.secondOrganizationScopeId, factId: fact.id },
      );
    } catch (e) {
      crossErr = e;
    }
    try {
      await harness.runtime.externalSettlementService.evaluateExternalSettlementReconciliation(
        actorCtx(harness, "ac05-missing-recon"),
        { organizationScopeId: harness.secondOrganizationScopeId, factId: "no-such-fact" },
      );
    } catch (e) {
      missingErr = e;
    }
    expect(crossErr).toBeInstanceOf(NotFoundError);
    expect(missingErr).toBeInstanceOf(NotFoundError);
    expect((crossErr as NotFoundError).code).toBe((missingErr as NotFoundError).code);

    // Reverse traceability: the second org lists NOTHING for the
    // first org's internal transaction.
    expect(
      await harness.runtime.externalSettlementService.listExternalSettlementFactsByTransaction(
        actorCtx(harness, "ac05-cross-list"),
        harness.secondOrganizationScopeId,
        lineage.transactionId,
      ),
    ).toHaveLength(0);
  });

  test("a fact recorded in the second org is invisible to the first org's listing (strict scoping)", async () => {
    const lineage = await createInternalLineage(harness);
    const foreign = await recordExternalFact(harness, {
      internalTransactionId: lineage.transactionId,
      organizationScopeId: harness.secondOrganizationScopeId,
    });
    expect(foreign.organizationScopeId).toBe(harness.secondOrganizationScopeId);
    const firstOrgFacts = await harness.runtime.externalSettlementService.listExternalSettlementFacts(
      actorCtx(harness, "ac05-strict"),
      harness.organizationScopeId,
    );
    expect(firstOrgFacts.map((f) => f.id)).not.toContain(foreign.id);
  });

  test("the API ingestion path enforces the server-side guard (deny-by-default without the policy)", async () => {
    // A SEPARATE runtime with the W030 routes but NO allow policies
    // for the W030 guard actions: every authenticated principal is
    // denied (deny-by-default; guard actions are not trustable
    // client-side).
    const runtime: Runtime = createRuntime({
      forceEnv: "test",
      env: { APP_ENV: "test", LOG_LEVEL: "fatal" },
      port: 0,
      adapters: { externalSettlementTrustKeys: { reference: "ac05-guard-key" } },
    });
    await runtime.initialize();
    await runtime.api.start();
    try {
      const ctx = createExecutionContext({
        correlationId: "ac05-guard-bootstrap",
        actor: { id: "bootstrap", kind: "service" },
      });
      const person = await runtime.identityService.createIdentity(ctx, {
        displayName: "Guard Actor",
        subjectReferences: [
          { subjectId: "guard-actor@example.com", providerKind: "internal" },
        ],
      });
      const org = await runtime.organizationService.createOrganization(ctx, {
        name: "Guard Org",
        creatorId: person.id,
      });
      const res = await fetch(
        `${BASE}:${runtime.api.port}/api/settlement/external-facts`,
        {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "x-correlation-id": "ac05-guard",
            "x-auth-subject-id": "guard-actor@example.com",
            "x-auth-provider-kind": "internal",
            // Forged client claims must be IGNORED (server-side
            // authorization only).
            "x-client-claims": JSON.stringify({ role: "ADMIN", scope: "*" }),
          },
          body: JSON.stringify({
            organizationScopeId: org.id,
            provider: "reference",
            payload: { externalId: "ext-guard-1" },
            idempotencyKey: "ac05-guard",
          }),
        },
      );
      expect(res.status).toBe(403);
      const body = (await res.json()) as { error: string; matchedPolicyId: unknown };
      expect(body.error).toBe("authorization");
      expect(body.matchedPolicyId).toBeNull();
    } finally {
      await runtime.shutdown();
    }
  });

  test("the authorized HTTP golden path: guarded ingestion → scoped read → derived reconciliation → reverse traceability", async () => {
    const lineage = await createInternalLineage(harness);
    const payload = buildProviderNotification(harness, {
      externalId: `ext-http-${Date.now()}`,
      internalTransactionId: lineage.transactionId,
      reportedAmount: lineage.amount,
    });
    const headers = {
      "content-type": "application/json",
      "x-correlation-id": "ac05-http",
      "x-auth-subject-id": harness.subjectId,
      "x-auth-provider-kind": "internal",
    };
    // 1. Guarded ingestion (201).
    const recordRes = await fetch(
      `${BASE}:${harness.runtime.api.port}/api/settlement/external-facts`,
      {
        method: "POST",
        headers,
        body: JSON.stringify({
          organizationScopeId: harness.organizationScopeId,
          provider: "reference",
          payload,
          idempotencyKey: "ac05-http",
        }),
      },
    );
    expect(recordRes.status).toBe(201);
    const recorded = (await recordRes.json()) as {
      fact: { id: string; externalId: string; provider: string; reportedAmount: number };
      created: boolean;
      reconciliation: { verdict: string; reason: string };
    };
    expect(recorded.created).toBe(true);
    expect(recorded.fact.provider).toBe("reference");
    expect(recorded.reconciliation.verdict).toBe("matched");

    // 2. Scoped read (200) — and the second org gets the same 404 as
    //    a nonexistent id (no existence oracle).
    const readRes = await fetch(
      `${BASE}:${harness.runtime.api.port}/api/settlement/external-facts/${recorded.fact.id}/read`,
      {
        method: "POST",
        headers,
        body: JSON.stringify({ organizationScopeId: harness.organizationScopeId }),
      },
    );
    expect(readRes.status).toBe(200);
    const readView = (await readRes.json()) as { id: string; externalId: string };
    expect(readView.id).toBe(recorded.fact.id);

    const crossReadRes = await fetch(
      `${BASE}:${harness.runtime.api.port}/api/settlement/external-facts/${recorded.fact.id}/read`,
      {
        method: "POST",
        headers,
        body: JSON.stringify({ organizationScopeId: harness.secondOrganizationScopeId }),
      },
    );
    expect(crossReadRes.status).toBe(404);
    const missingReadRes = await fetch(
      `${BASE}:${harness.runtime.api.port}/api/settlement/external-facts/no-such-fact/read`,
      {
        method: "POST",
        headers,
        body: JSON.stringify({ organizationScopeId: harness.secondOrganizationScopeId }),
      },
    );
    expect(missingReadRes.status).toBe(404);
    // The two 404s are STRUCTURALLY identical (same error code; the
    // message echoes only the REQUESTED id — no existence oracle).
    const crossBody = (await crossReadRes.json()) as { error: string; message: string };
    const missingBody = (await missingReadRes.json()) as { error: string; message: string };
    expect(crossBody.error).toBe(missingBody.error);
    expect(crossBody.message).toBe("external settlement fact not found: " + recorded.fact.id);
    expect(missingBody.message).toBe("external settlement fact not found: no-such-fact");

    // 3. Derived reconciliation (200, machine-readable).
    const reconRes = await fetch(
      `${BASE}:${harness.runtime.api.port}/api/settlement/external-facts/${recorded.fact.id}/reconciliation`,
      {
        method: "POST",
        headers,
        body: JSON.stringify({ organizationScopeId: harness.organizationScopeId }),
      },
    );
    expect(reconRes.status).toBe(200);
    const recon = (await reconRes.json()) as {
      verdict: string;
      reason: string;
      checks: { check: string; satisfied: boolean; reason: string }[];
    };
    expect(recon.verdict).toBe("matched");
    expect(recon.reason).toBe("amount_matched");

    // 4. Reverse traceability (the facts referencing the internal tx).
    const listRes = await fetch(
      `${BASE}:${harness.runtime.api.port}/api/settlement/external-facts/by-transaction`,
      {
        method: "POST",
        headers,
        body: JSON.stringify({
          organizationScopeId: harness.organizationScopeId,
          internalTransactionId: lineage.transactionId,
        }),
      },
    );
    expect(listRes.status).toBe(200);
    const list = (await listRes.json()) as { facts: { id: string }[] };
    expect(list.facts.map((f) => f.id)).toContain(recorded.fact.id);
  });
});
