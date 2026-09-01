/**
 * NET-W025 AC-06 — Cross-tenant reads/mutations and unauthorized
 * membership fail closed without existence leakage (issue #50
 * acceptance criterion 6). Includes the HTTP status-semantics
 * contract and the dual (tenant + buyer-organization) membership
 * gates.
 *
 * Work order: spec/work-orders/NET-W025.md §4 AC-06.
 */

import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { randomUUID } from "node:crypto";
import { createRuntime } from "../../src/bootstrap/runtime.ts";
import {
  createNetW025Harness,
  createProcurementPool,
  createProcurementCommitment,
  buyerCtx,
  supplierCtx,
  personCtx,
  key,
  type NetW025Harness,
} from "./_net-w025-harness.ts";
import { NotFoundError } from "../../src/core/errors.ts";
import { AuthorizationError } from "../../src/core/errors.ts";

let harness: NetW025Harness;

beforeAll(async () => {
  harness = await createNetW025Harness();
});

afterAll(async () => {
  await harness.teardown();
});

describe("NET-W025-AC-06 tenancy + dual-membership authorization fail closed", () => {
  test("cross-tenant pool reads resolve as not-found with NO existence oracle", async () => {
    const pool = await createProcurementPool(harness, {
      name: "AC-06 Victim Pool",
    });
    // A second, fully separate tenant.
    const otherOrg = await harness.runtime.organizationService
      .createOrganization(harness.bootstrapCtx, {
        name: "AC-06 Other Org",
        creatorId: harness.supplierPersonId,
      });
    const crossCtx = supplierCtx(harness, "w025-ac06-cross");
    // Cross-tenant get: NotFoundError — indistinguishable from a
    // nonexistent pool (no existence oracle).
    const crossError = await harness.runtime.procurementService
      .getProcurementPool(crossCtx, otherOrg.id, pool.id)
      .catch((e: unknown) => e);
    expect(crossError).toBeInstanceOf(NotFoundError);
    const nonexistentId = randomUUID();
    const nonexistentError = await harness.runtime.procurementService
      .getProcurementPool(crossCtx, otherOrg.id, nonexistentId)
      .catch((e: unknown) => e);
    // Existence-oracle parity: same error shape, same code, and the
    // message differs ONLY by the caller-supplied id.
    expect(nonexistentError).toBeInstanceOf(NotFoundError);
    expect((crossError as NotFoundError).code).toBe(
      (nonexistentError as NotFoundError).code,
    );
    expect((crossError as NotFoundError).message).toBe(
      (nonexistentError as NotFoundError).message.replace(
        nonexistentId,
        pool.id,
      ),
    );
  });

  test("cross-tenant commitment creation and evaluation fail closed (tenant anchor first)", async () => {
    const pool = await createProcurementPool(harness, {
      name: "AC-06 Anchor Pool",
    });
    const foreignOrg = await harness.runtime.organizationService
      .createOrganization(harness.bootstrapCtx, {
        name: "AC-06 Foreign Org",
        creatorId: harness.supplierPersonId,
      });
    // The commitment references a REAL pool id but a FOREIGN tenant
    // scope: NotFoundError (the tenant anchor fires first).
    await expect(
      harness.runtime.procurementService.createProcurementCommitment(
        buyerCtx(harness, "A", "w025-ac06-anchor"),
        {
          organizationScopeId: foreignOrg.id,
          poolId: pool.id,
          buyerOrganizationId: harness.buyerOrgAId,
          attributes: { region: "NA_EAST", quantity: 12 },
          consent: { scope: "aggregate_disclosure" },
          idempotencyKey: key("w025-ac06-anchor"),
        },
      ),
    ).rejects.toBeInstanceOf(NotFoundError);
    // Cross-tenant evaluation: NotFoundError.
    await expect(
      harness.runtime.procurementService.evaluateQualifiedProcurementDemand(
        supplierCtx(harness, "w025-ac06-anchor-eval"),
        { organizationScopeId: foreignOrg.id, poolId: pool.id },
      ),
    ).rejects.toBeInstanceOf(NotFoundError);
  });

  test("non-tenant-members cannot create pools or commitments", async () => {
    const pool = await createProcurementPool(harness, {
      name: "AC-06 Member Pool",
    });
    // A person with NO membership anywhere.
    const outsider = await harness.w024.w008.runtime.identityService
      .createIdentity(harness.bootstrapCtx, {
        displayName: "AC-06 Outsider",
        subjectReferences: [
          { subjectId: "w025-ac06-outsider@example.com", providerKind: "internal" },
        ],
      });
    const outsiderCtx = personCtx(outsider.id, "w025-ac06-outsider");
    await expect(
      harness.runtime.procurementService.createProcurementPool(outsiderCtx, {
        organizationScopeId: harness.organizationScopeId,
        name: "AC-06 Outsider Pool",
        categoryKey: "cloud_infrastructure",
        qualificationPolicy: { minimumCommitments: 2, minimumOrganizations: 2 },
        idempotencyKey: key("w025-ac06-outsider-pool"),
      }),
    ).rejects.toBeInstanceOf(AuthorizationError);
    await expect(
      harness.runtime.procurementService.createProcurementCommitment(
        outsiderCtx,
        {
          organizationScopeId: harness.organizationScopeId,
          poolId: pool.id,
          buyerOrganizationId: harness.buyerOrgAId,
          attributes: { region: "NA_EAST", quantity: 12 },
          consent: { scope: "aggregate_disclosure" },
          idempotencyKey: key("w025-ac06-outsider-commit"),
        },
      ),
    ).rejects.toBeInstanceOf(AuthorizationError);
  });

  test("buyer-organization authorization fails closed, indistinguishable from a nonexistent organization", async () => {
    const pool = await createProcurementPool(harness, {
      name: "AC-06 Buyer Auth Pool",
    });
    // Buyer A's representative names buyer organization B (NOT a
    // member): AuthorizationError.
    const notMember = await harness.runtime.procurementService
      .createProcurementCommitment(
        buyerCtx(harness, "A", "w025-ac06-buyer-auth"),
        {
          organizationScopeId: harness.organizationScopeId,
          poolId: pool.id,
          buyerOrganizationId: harness.buyerOrgBId,
          attributes: { region: "NA_EAST", quantity: 12 },
          consent: { scope: "aggregate_disclosure" },
          idempotencyKey: key("w025-ac06-buyer-auth"),
        },
      )
      .catch((e: unknown) => e);
    expect(notMember).toBeInstanceOf(AuthorizationError);
    // A NONEXISTENT buyer organization: the SAME error shape (no
    // existence oracle — the membership lookup returns null for both).
    const nonexistent = await harness.runtime.procurementService
      .createProcurementCommitment(
        buyerCtx(harness, "A", "w025-ac06-buyer-nonexistent"),
        {
          organizationScopeId: harness.organizationScopeId,
          poolId: pool.id,
          buyerOrganizationId: randomUUID(),
          attributes: { region: "NA_EAST", quantity: 12 },
          consent: { scope: "aggregate_disclosure" },
          idempotencyKey: key("w025-ac06-buyer-nonexistent"),
        },
      )
      .catch((e: unknown) => e);
    expect(nonexistent).toBeInstanceOf(AuthorizationError);
    expect((notMember as AuthorizationError).code).toBe(
      (nonexistent as AuthorizationError).code,
    );
    expect(
      ((notMember as AuthorizationError).context as Record<string, unknown>)["reason"],
    ).toBe("not_a_member");
    expect(
      ((nonexistent as AuthorizationError).context as Record<string, unknown>)["reason"],
    ).toBe("not_a_member");
  });

  test("non-members receive suppressed (non-member) aggregate views — a 200 decision", async () => {
    const pool = await createProcurementPool(harness, {
      name: "AC-06 Non Member View Pool",
    });
    await createProcurementCommitment(harness, { poolId: pool.id });
    await createProcurementCommitment(harness, {
      poolId: pool.id,
      ctx: buyerCtx(harness, "B", "w025-ac06-nm-b"),
      buyerOrganizationId: harness.buyerOrgBId,
    });
    await createProcurementCommitment(harness, {
      poolId: pool.id,
      ctx: buyerCtx(harness, "C", "w025-ac06-nm-c"),
      buyerOrganizationId: harness.buyerOrgCId,
    });
    // A tenant NON-member requestor: the evaluation is still a 200
    // DECISION (never an exception) but the requestor_membership
    // check fails and everything suppresses.
    const outsider = await harness.w024.w008.runtime.identityService
      .createIdentity(harness.bootstrapCtx, {
        displayName: "AC-06 View Outsider",
        subjectReferences: [
          { subjectId: "w025-ac06-view-outsider@example.com", providerKind: "internal" },
        ],
      });
    const view = await harness.runtime.procurementService
      .evaluateQualifiedProcurementDemand(
        personCtx(outsider.id, "w025-ac06-nm-view"),
        { organizationScopeId: harness.organizationScopeId, poolId: pool.id },
      );
    expect(view.qualified).toBe(false);
    expect(view.aggregate).toBeNull();
    const membership = view.checks.find(
      (c) => c.check === "requestor_membership",
    );
    expect(membership?.satisfied).toBe(false);
    // Counts are NOT disclosed to a non-member requestor.
    const thresholds = view.checks.find(
      (c) => c.check === "qualification_thresholds_met",
    );
    const detail = thresholds?.detail as Record<string, unknown>;
    expect(detail["commitmentCount"]).toBeUndefined();
    expect(detail["reason"]).toBe("counts_suppressed_below_disclosure_floors");
  });

  test("submitter-only withdrawal and creator-only closure", async () => {
    const pool = await createProcurementPool(harness, {
      name: "AC-06 Owner Pool",
    });
    const commitment = await createProcurementCommitment(harness, {
      poolId: pool.id,
    });
    // A DIFFERENT active tenant member (the supplier person) cannot
    // withdraw the buyer's commitment.
    await expect(
      harness.runtime.procurementService.withdrawProcurementCommitment(
        supplierCtx(harness, "w025-ac06-not-submitter"),
        {
          organizationScopeId: harness.organizationScopeId,
          commitmentId: commitment.id,
          idempotencyKey: key("w025-ac06-not-submitter"),
        },
      ),
    ).rejects.toBeInstanceOf(AuthorizationError);
    // A different active tenant member cannot close the pool.
    await expect(
      harness.runtime.procurementService.closeProcurementPool(
        buyerCtx(harness, "B", "w025-ac06-not-creator"),
        {
          organizationScopeId: harness.organizationScopeId,
          poolId: pool.id,
          idempotencyKey: key("w025-ac06-not-creator"),
        },
      ),
    ).rejects.toBeInstanceOf(AuthorizationError);
  });

  test("full HTTP status semantics (403/201/400/200/404/409/403)", async () => {
    const base = `http://127.0.0.1:${harness.runtime.api.port}`;
    const buyerAHeaders = {
      "content-type": "application/json",
      "x-auth-subject-id": harness.buyerASubjectId,
    };
    const supplierHeaders = {
      "content-type": "application/json",
      "x-auth-subject-id": harness.supplierSubjectId,
    };

    // 403: no auth subject at all (guard deny).
    const unauth = await fetch(`${base}/api/demand/procurement/pools`, {
      method: "POST",
      body: JSON.stringify({
        organizationScopeId: harness.organizationScopeId,
        name: "AC-06 HTTP Unauth",
        categoryKey: "cloud_infrastructure",
        qualificationPolicy: { minimumCommitments: 2, minimumOrganizations: 2 },
        idempotencyKey: key("w025-ac06-http-unauth"),
      }),
    });
    expect(unauth.status).toBe(403);

    // 201: pool creation.
    const poolRes = await fetch(`${base}/api/demand/procurement/pools`, {
      method: "POST",
      headers: buyerAHeaders,
      body: JSON.stringify({
        organizationScopeId: harness.organizationScopeId,
        name: "AC-06 HTTP Pool",
        categoryKey: "cloud_infrastructure",
        qualificationPolicy: { minimumCommitments: 1, minimumOrganizations: 1 },
        idempotencyKey: key("w025-ac06-http-pool"),
      }),
    });
    expect(poolRes.status).toBe(201);
    const poolBody = (await poolRes.json()) as {
      pool: { id: string };
      created: boolean;
    };
    expect(poolBody.created).toBe(true);
    const poolId = poolBody.pool.id;

    // 201: commitment creation (buyer A for organization A).
    const commitRes = await fetch(
      `${base}/api/demand/procurement/commitments`,
      {
        method: "POST",
        headers: buyerAHeaders,
        body: JSON.stringify({
          organizationScopeId: harness.organizationScopeId,
          poolId,
          buyerOrganizationId: harness.buyerOrgAId,
          attributes: { region: "NA_EAST", quantity: 12 },
          consent: { scope: "aggregate_disclosure" },
          idempotencyKey: key("w025-ac06-http-commit"),
        }),
      },
    );
    expect(commitRes.status).toBe(201);

    // 400: malformed input (missing idempotencyKey).
    const malformed = await fetch(`${base}/api/demand/procurement/pools`, {
      method: "POST",
      headers: buyerAHeaders,
      body: JSON.stringify({
        organizationScopeId: harness.organizationScopeId,
        name: "AC-06 Malformed",
        categoryKey: "cloud_infrastructure",
        qualificationPolicy: { minimumCommitments: 2, minimumOrganizations: 2 },
      }),
    });
    expect(malformed.status).toBe(400);

    // 200: the derived qualified-aggregate decision (supplier side);
    // caller-asserted smuggle fields are ignored; one commitment /
    // one organization is below BOTH floors → suppressed (still 200).
    const evalRes = await fetch(
      `${base}/api/demand/procurement/pools/${poolId}/qualified-aggregate`,
      {
        method: "POST",
        headers: supplierHeaders,
        body: JSON.stringify({
          organizationScopeId: harness.organizationScopeId,
          commitmentCount: 9999,
          organizationCount: 9999,
          qualified: true,
        }),
      },
    );
    expect(evalRes.status).toBe(200);
    const evalBody = (await evalRes.json()) as {
      qualified: boolean;
      aggregate: unknown;
    };
    expect(evalBody.qualified).toBe(false);
    expect(evalBody.aggregate).toBeNull();

    // 404: cross-tenant GET (a foreign org scope).
    const foreignOrg = await harness.runtime.organizationService
      .createOrganization(harness.bootstrapCtx, {
        name: "AC-06 HTTP Foreign",
        creatorId: harness.buyerAPersonId,
      });
    const cross = await fetch(
      `${base}/api/demand/procurement/pools/${poolId}?organizationScopeId=${foreignOrg.id}`,
      { method: "GET" },
    );
    expect(cross.status).toBe(404);

    // 200: the actor-scoped commitment listing (the ONLY commitment
    // read surface) returns the buyer's OWN submissions.
    const mineRes = await fetch(
      `${base}/api/demand/procurement/commitments/mine`,
      {
        method: "POST",
        headers: buyerAHeaders,
        body: JSON.stringify({
          organizationScopeId: harness.organizationScopeId,
          poolId,
        }),
      },
    );
    expect(mineRes.status).toBe(200);
    const mine = (await mineRes.json()) as { submittedBy: string }[];
    expect(mine.length).toBe(1);
    expect(mine[0]?.submittedBy).toBe(harness.buyerAPersonId);

    // 409: the one-active-per-(pool, submitter) conflict over HTTP.
    const conflictRes = await fetch(
      `${base}/api/demand/procurement/commitments`,
      {
        method: "POST",
        headers: buyerAHeaders,
        body: JSON.stringify({
          organizationScopeId: harness.organizationScopeId,
          poolId,
          buyerOrganizationId: harness.buyerOrgAId,
          attributes: { region: "EU_NORTH", quantity: 20 },
          consent: { scope: "aggregate_disclosure" },
          idempotencyKey: key("w025-ac06-http-conflict"),
        }),
      },
    );
    expect(conflictRes.status).toBe(409);

    // 403: the buyer-organization membership gate over HTTP (buyer A
    // naming buyer organization B).
    const buyerAuthRes = await fetch(
      `${base}/api/demand/procurement/commitments`,
      {
        method: "POST",
        headers: buyerAHeaders,
        body: JSON.stringify({
          organizationScopeId: harness.organizationScopeId,
          poolId,
          buyerOrganizationId: harness.buyerOrgBId,
          attributes: { region: "NA_EAST", quantity: 12 },
          consent: { scope: "aggregate_disclosure" },
          idempotencyKey: key("w025-ac06-http-buyer-auth"),
        }),
      },
    );
    expect(buyerAuthRes.status).toBe(403);
  });

  test("the default runtime (no seeded policies) guards procurement mutations closed", async () => {
    const bare = createRuntime({
      forceEnv: "test",
      env: { APP_ENV: "test", LOG_LEVEL: "fatal" },
      port: 0,
    });
    await bare.initialize();
    await bare.api.start();
    try {
      // Even WITH an auth subject, no ALLOW policy exists on the bare
      // runtime → deny-by-default → 403 (issue #50: no caller
      // assertion may fabricate buyer eligibility or membership).
      const res = await fetch(
        `http://127.0.0.1:${bare.api.port}/api/demand/procurement/pools`,
        {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "x-auth-subject-id": "anyone",
          },
          body: JSON.stringify({
            organizationScopeId: "any-org",
            name: "Bare Pool",
            categoryKey: "cloud_infrastructure",
            qualificationPolicy: { minimumCommitments: 2, minimumOrganizations: 2 },
            idempotencyKey: key("w025-ac06-bare"),
          }),
        },
      );
      expect(res.status).toBe(403);
      const body = (await res.json()) as Record<string, unknown>;
      expect(body["error"]).toBe("authorization");
    } finally {
      await bare.shutdown();
    }
  });
});
