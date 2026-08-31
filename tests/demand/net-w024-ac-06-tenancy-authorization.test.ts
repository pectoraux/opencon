/**
 * NET-W024 AC-06 — Cross-tenant access and unauthorized membership
 * fail closed without existence leakage (issue #48 acceptance
 * criterion 6). Includes the HTTP status-semantics contract.
 *
 * Work order: spec/work-orders/NET-W024.md §4 AC-06.
 */

import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { createRuntime } from "../../src/bootstrap/runtime.ts";
import {
  createNetW024Harness,
  createPool,
  createCommitment,
  createPerson,
  consumerCtx,
  supplierCtx,
  personCtx,
  key,
  type NetW024Harness,
} from "./_net-w024-harness.ts";
import { NotFoundError } from "../../src/core/errors.ts";
import { AuthorizationError } from "../../src/core/errors.ts";

let harness: NetW024Harness;

beforeAll(async () => {
  harness = await createNetW024Harness();
});

afterAll(async () => {
  await harness.teardown();
});

describe("NET-W024-AC-06 tenancy + authorization fail closed", () => {
  test("cross-tenant pool reads resolve as not-found with NO existence oracle", async () => {
    const pool = await createPool(harness, { name: "AC-06 Victim Pool" });

    // A second, fully separate tenant.
    const otherCtx = harness.bootstrapCtx;
    const otherOrg = await harness.runtime.organizationService.createOrganization(
      otherCtx,
      { name: "AC-06 Other Org", creatorId: harness.supplierPersonId },
    );
    const otherMember = await createPerson(harness, {
      displayName: "AC-06 Other Member",
      subjectId: "w024-ac06-other@example.com",
      member: false,
    });
    // (Not a member of the HARNESS org — the cross-tenant actor.)
    const crossCtx = personCtx(otherMember.personId, "w024-ac06-cross");

    // Cross-tenant get: NotFoundError — indistinguishable from a
    // nonexistent pool (no existence oracle).
    const crossError = await harness.runtime.demandService
      .getDemandPool(crossCtx, otherOrg.id, pool.id)
      .catch((e: unknown) => e);
    expect(crossError).toBeInstanceOf(NotFoundError);

    const nonexistentError = await harness.runtime.demandService
      .getDemandPool(crossCtx, otherOrg.id, "no-such-pool-id")
      .catch((e: unknown) => e);
    expect(nonexistentError).toBeInstanceOf(NotFoundError);
    // IDENTICAL error shape for "exists in another tenant" vs
    // "does not exist" (code + classification parity).
    expect((crossError as NotFoundError).code).toBe(
      (nonexistentError as NotFoundError).code,
    );
    expect((crossError as NotFoundError).classification).toBe(
      (nonexistentError as NotFoundError).classification,
    );
  });

  test("cross-tenant commitment creation and evaluation fail closed", async () => {
    const pool = await createPool(harness, { name: "AC-06 Target Pool" });
    const outsider = await createPerson(harness, {
      displayName: "AC-06 Outsider",
      subjectId: "w024-ac06-outsider@example.com",
      member: true, // a member of the HARNESS org…
    });
    // …but the call targets a FOREIGN org scope.
    const foreignOrg = await harness.runtime.organizationService.createOrganization(
      harness.bootstrapCtx,
      { name: "AC-06 Foreign Org", creatorId: harness.consumerPersonId },
    );
    const outsiderCtx = personCtx(outsider.personId, "w024-ac06-foreign");

    // Commitment creation against a foreign scope: the pool does not
    // resolve in that scope → NotFoundError (fail closed).
    await expect(
      harness.runtime.demandService.createDemandCommitment(outsiderCtx, {
        organizationScopeId: foreignOrg.id,
        poolId: pool.id,
        attributes: { region: "NA_EAST", quantity: 12 },
        consent: { scope: "aggregate_disclosure" },
        idempotencyKey: key("w024-ac06-foreign"),
      }),
    ).rejects.toBeInstanceOf(NotFoundError);

    // Evaluation against a foreign scope: same fail-closed shape.
    await expect(
      harness.runtime.demandService.evaluateQualifiedDemand(outsiderCtx, {
        organizationScopeId: foreignOrg.id,
        poolId: pool.id,
      }),
    ).rejects.toBeInstanceOf(NotFoundError);
  });

  test("non-members cannot create pools or commitments (server-enforced membership gate)", async () => {
    const nonMember = await createPerson(harness, {
      displayName: "AC-06 Non Member",
      subjectId: "w024-ac06-nonmember@example.com",
      member: false,
    });
    const nmCtx = personCtx(nonMember.personId, "w024-ac06-nonmember");

    await expect(
      harness.runtime.demandService.createDemandPool(nmCtx, {
        organizationScopeId: harness.organizationScopeId,
        name: "AC-06 Non Member Pool",
        categoryKey: "utilities_energy",
        qualificationPolicy: { minimumCommitments: 2 },
        idempotencyKey: key("w024-ac06-nm-pool"),
      }),
    ).rejects.toBeInstanceOf(AuthorizationError);

    const pool = await createPool(harness, { name: "AC-06 Member Pool" });
    await expect(
      harness.runtime.demandService.createDemandCommitment(nmCtx, {
        organizationScopeId: harness.organizationScopeId,
        poolId: pool.id,
        attributes: { region: "NA_EAST", quantity: 12 },
        consent: { scope: "aggregate_disclosure" },
        idempotencyKey: key("w024-ac06-nm-commit"),
      }),
    ).rejects.toBeInstanceOf(AuthorizationError);
  });

  test("non-member requestors get a SUPPRESSED aggregate view (derived check, no facts)", async () => {
    const pool = await createPool(harness, { minimumCommitments: 2 });
    await createCommitment(harness, { poolId: pool.id });
    await createCommitment(harness, {
      poolId: pool.id,
      ctx: supplierCtx(harness, "w024-ac06-nmview-s"),
    });
    await createCommitment(harness, {
      poolId: pool.id,
      ctx: personCtx(
        (await createPerson(harness, {
          displayName: "AC-06 Third Member",
          subjectId: "w024-ac06-third@example.com",
          member: true,
        })).personId,
        "w024-ac06-nmview-3",
      ),
    });

    // A NON-member evaluates: the requestor_membership check fails
    // and NO aggregate facts are emitted (the view stays a 200
    // decision, but a suppressed one).
    const nonMember = await createPerson(harness, {
      displayName: "AC-06 View Non Member",
      subjectId: "w024-ac06-viewnm@example.com",
      member: false,
    });
    const view = await harness.runtime.demandService.evaluateQualifiedDemand(
      personCtx(nonMember.personId, "w024-ac06-nmview"),
      { organizationScopeId: harness.organizationScopeId, poolId: pool.id },
    );
    const membershipCheck = view.checks.find(
      (c) => c.check === "requestor_membership",
    );
    expect(membershipCheck?.satisfied).toBe(false);
    expect(view.aggregate).toBeNull();
    expect(view.qualified).toBe(false);
    expect(JSON.stringify(view)).not.toContain("commitmentCount");
  });

  test("only the commitment's consumer may withdraw; only the pool's creator may close", async () => {
    const pool = await createPool(harness, { name: "AC-06 Owner Pool" });
    const commitment = await createCommitment(harness, {
      poolId: pool.id,
      ctx: supplierCtx(harness, "w024-ac06-owner-commit"),
    });

    // The consumer-person (supplier here) may withdraw their own.
    await harness.runtime.demandService.withdrawDemandCommitment(
      supplierCtx(harness, "w024-ac06-owner-withdraw"),
      {
        organizationScopeId: harness.organizationScopeId,
        commitmentId: commitment.id,
        idempotencyKey: key("w024-ac06-owner-w"),
      },
    );

    // A DIFFERENT member may NOT withdraw the consumer's commitment.
    const other = await createPerson(harness, {
      displayName: "AC-06 Other Member",
      subjectId: "w024-ac06-other-member@example.com",
      member: true,
    });
    const otherCommitment = await createCommitment(harness, {
      poolId: pool.id,
      ctx: supplierCtx(harness, "w024-ac06-owner-commit-2"),
    });
    await expect(
      harness.runtime.demandService.withdrawDemandCommitment(
        personCtx(other.personId, "w024-ac06-notowner"),
        {
          organizationScopeId: harness.organizationScopeId,
          commitmentId: otherCommitment.id,
          idempotencyKey: key("w024-ac06-notowner"),
        },
      ),
    ).rejects.toBeInstanceOf(AuthorizationError);

    // Only the pool CREATOR may close (the supplier is a member but
    // not the creator of this pool).
    await expect(
      harness.runtime.demandService.closeDemandPool(
        supplierCtx(harness, "w024-ac06-notcreator"),
        {
          organizationScopeId: harness.organizationScopeId,
          poolId: pool.id,
          idempotencyKey: key("w024-ac06-notcreator"),
        },
      ),
    ).rejects.toBeInstanceOf(AuthorizationError);
  });

  test("HTTP semantics: 403 unauthenticated, 400 malformed, 201 create, 200 derived decision, 404 cross-tenant, 409 conflict", async () => {
    const base = `http://127.0.0.1:${harness.runtime.api.port}`;
    const consumerHeaders = {
      "content-type": "application/json",
      "x-auth-subject-id": harness.consumerSubjectId,
    };
    const supplierHeaders = {
      "content-type": "application/json",
      "x-auth-subject-id": harness.supplierSubjectId,
    };

    // 403: no auth subject (the guard denies unauthenticated calls).
    const unauth = await fetch(`${base}/api/demand/pools`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        organizationScopeId: harness.organizationScopeId,
        name: "AC-06 Unauth Pool",
        categoryKey: "utilities_energy",
        qualificationPolicy: { minimumCommitments: 2 },
        idempotencyKey: key("w024-ac06-http-unauth"),
      }),
    });
    expect(unauth.status).toBe(403);

    // 201: authenticated pool creation.
    const poolRes = await fetch(`${base}/api/demand/pools`, {
      method: "POST",
      headers: consumerHeaders,
      body: JSON.stringify({
        organizationScopeId: harness.organizationScopeId,
        name: "AC-06 HTTP Pool",
        categoryKey: "utilities_energy",
        qualificationPolicy: { minimumCommitments: 1 },
        idempotencyKey: key("w024-ac06-http-pool"),
      }),
    });
    expect(poolRes.status).toBe(201);
    const poolBody = (await poolRes.json()) as {
      pool: { id: string };
      created: boolean;
    };
    expect(poolBody.created).toBe(true);
    const poolId = poolBody.pool.id;

    // 201: commitment creation.
    const commitRes = await fetch(`${base}/api/demand/commitments`, {
      method: "POST",
      headers: consumerHeaders,
      body: JSON.stringify({
        organizationScopeId: harness.organizationScopeId,
        poolId,
        attributes: { region: "NA_EAST", quantity: 12 },
        consent: { scope: "aggregate_disclosure" },
        idempotencyKey: key("w024-ac06-http-commit"),
      }),
    });
    expect(commitRes.status).toBe(201);

    // 400: malformed input (missing idempotencyKey).
    const malformed = await fetch(`${base}/api/demand/pools`, {
      method: "POST",
      headers: consumerHeaders,
      body: JSON.stringify({
        organizationScopeId: harness.organizationScopeId,
        name: "AC-06 Malformed",
        categoryKey: "utilities_energy",
        qualificationPolicy: { minimumCommitments: 2 },
      }),
    });
    expect(malformed.status).toBe(400);

    // 200: the derived qualified-aggregate decision (supplier side).
    const evalRes = await fetch(
      `${base}/api/demand/pools/${poolId}/qualified-aggregate`,
      {
        method: "POST",
        headers: supplierHeaders,
        body: JSON.stringify({
          organizationScopeId: harness.organizationScopeId,
          // Caller-asserted smuggle fields are ignored:
          commitmentCount: 9999,
          qualified: true,
        }),
      },
    );
    expect(evalRes.status).toBe(200);
    const evalBody = (await evalRes.json()) as {
      qualified: boolean;
      aggregate: unknown;
    };
    // One commitment < floor 3 → suppressed decision (still 200).
    expect(evalBody.qualified).toBe(false);
    expect(evalBody.aggregate).toBeNull();

    // 404: cross-tenant GET (a foreign org scope).
    const foreignOrg = await harness.runtime.organizationService.createOrganization(
      harness.bootstrapCtx,
      { name: "AC-06 HTTP Foreign", creatorId: harness.consumerPersonId },
    );
    const cross = await fetch(
      `${base}/api/demand/pools/${poolId}?organizationScopeId=${foreignOrg.id}`,
      { method: "GET" },
    );
    expect(cross.status).toBe(404);

    // 200: the actor-scoped commitment listing (the ONLY commitment
    // read surface) returns the consumer's OWN commitments (scoped to
    // THIS test's pool — the harness is shared across the file).
    const mineRes = await fetch(`${base}/api/demand/commitments/mine`, {
      method: "POST",
      headers: consumerHeaders,
      body: JSON.stringify({
        organizationScopeId: harness.organizationScopeId,
        poolId,
      }),
    });
    expect(mineRes.status).toBe(200);
    const mine = (await mineRes.json()) as { consumerPersonId: string }[];
    expect(mine.length).toBe(1);
    expect(mine[0]?.consumerPersonId).toBe(harness.consumerPersonId);

    // 409: the one-active-per-(pool, consumer) conflict over HTTP.
    const conflictRes = await fetch(`${base}/api/demand/commitments`, {
      method: "POST",
      headers: consumerHeaders,
      body: JSON.stringify({
        organizationScopeId: harness.organizationScopeId,
        poolId,
        attributes: { region: "EU_NORTH", quantity: 20 },
        consent: { scope: "aggregate_disclosure" },
        idempotencyKey: key("w024-ac06-http-conflict"),
      }),
    });
    expect(conflictRes.status).toBe(409);

    // 403: a non-member mutation over HTTP (membership gate is
    // in-domain: AuthorizationError → 403).
    const nonMember = await createPerson(harness, {
      displayName: "AC-06 HTTP Non Member",
      subjectId: "w024-ac06-httpnm@example.com",
      member: false,
    });
    const nonMemberRes = await fetch(`${base}/api/demand/commitments`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-auth-subject-id": nonMember.subjectId,
      },
      body: JSON.stringify({
        organizationScopeId: harness.organizationScopeId,
        poolId,
        attributes: { region: "NA_EAST", quantity: 12 },
        consent: { scope: "aggregate_disclosure" },
        idempotencyKey: key("w024-ac06-http-nm"),
      }),
    });
    expect(nonMemberRes.status).toBe(403);
  });

  test("the default runtime (no seeded policies) guards demand mutations closed", async () => {
    const bare = createRuntime({
      forceEnv: "test",
      env: { APP_ENV: "test", LOG_LEVEL: "fatal" },
      port: 0,
    });
    await bare.initialize();
    await bare.api.start();
    try {
      // Even WITH an auth subject, no ALLOW policy exists on the bare
      // runtime → deny-by-default → 403 (issue #48: no caller
      // assertion may fabricate demand membership).
      const res = await fetch(
        `http://127.0.0.1:${bare.api.port}/api/demand/pools`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            organizationScopeId: "any-org",
            name: "Bare Pool",
            categoryKey: "utilities_energy",
            qualificationPolicy: { minimumCommitments: 2 },
            idempotencyKey: key("w024-ac06-bare"),
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
