/**
 * NET-W036 AC-01 — Demand pool authority (work order §5 AC-01 + the
 * frozen ledger §4): a deterministic tenant-scoped qualified demand
 * pool resolved through `/demand`; unauthorized/cross-tenant access
 * fails closed; demand commitments remain private and selection/
 * funding is never asserted by callers.
 *
 * Mutation targets covered (ledger §4): bypass tenant gate; trust
 * caller aggregate; select unqualified demand.
 *
 * DETERMINISM (§3.1): fixed idempotency keys only (`w036-ac01-…`),
 * fixed nonexistent/actor ids, anchors imported from the shared
 * harness — NO `Date.now(`, NO `randomUUID`, NO `new Date(` code
 * tokens in this file. ONE harness per file (the W025/W026 AC-suite
 * precedent); every test seeds its OWN pool with a distinct fixed key.
 */

import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import {
  createNetW036Harness,
  personCtx,
  type NetW036Harness,
} from "./_net-w036-harness.ts";
import { createExecutionContext } from "../../src/core/execution-context.ts";
import { NotFoundError } from "../../src/core/errors.ts";
import { AuthorizationError } from "../../src/core/errors.ts";
import type { CreateProcurementPoolInput } from "../../src/demand/port.ts";
import type { ProcurementPool } from "../../src/demand/port.ts";

let harness: NetW036Harness;

beforeAll(async () => {
  harness = await createNetW036Harness();
}, 180_000);

afterAll(async () => {
  await harness.teardown();
});

/** Seed one canonical three-buyer-organization pool (fixed keys). */
async function seedCanonicalPool(
  name: string,
  poolKey: string,
): Promise<ProcurementPool> {
  const scope = harness.organizationScopeId;
  const pool = (
    await harness.runtime.procurementService.createProcurementPool(
      harness.poolCreatorCtx("w036-ac01-pool"),
      {
        organizationScopeId: scope,
        name,
        categoryKey: "cloud_infrastructure",
        qualificationPolicy: {
          minimumCommitments: 2,
          minimumOrganizations: 2,
        },
        idempotencyKey: poolKey,
      },
    )
  ).pool;
  const commitmentSeeds: readonly {
    readonly ctx: ReturnType<typeof harness.poolCreatorCtx>;
    readonly buyerOrganizationId: string;
    readonly quantity: number;
    readonly key: string;
  }[] = [
    {
      ctx: harness.poolCreatorCtx("w036-ac01-commit-a"),
      buyerOrganizationId: harness.buyerOrgAId,
      quantity: 12,
      key: `${poolKey}-commit-a`,
    },
    {
      ctx: harness.buyerBCtx("w036-ac01-commit-b"),
      buyerOrganizationId: harness.buyerOrgBId,
      quantity: 40,
      key: `${poolKey}-commit-b`,
    },
    {
      ctx: harness.buyerCCtx("w036-ac01-commit-c"),
      buyerOrganizationId: harness.buyerOrgCId,
      quantity: 75,
      key: `${poolKey}-commit-c`,
    },
  ];
  const commitments = [];
  for (const seed of commitmentSeeds) {
    commitments.push(
      (
        await harness.runtime.procurementService.createProcurementCommitment(
          seed.ctx,
          {
            organizationScopeId: scope,
            poolId: pool.id,
            buyerOrganizationId: seed.buyerOrganizationId,
            attributes: {
              region: "NA_EAST",
              quantity: seed.quantity,
              budgetBand: "band_b_1k_9k",
              unitPriceBand: "price_b_10_49",
              timingWindow: "window_short_1_3mo",
            },
            consent: { scope: "aggregate_disclosure" },
            idempotencyKey: seed.key,
          },
        )
      ).commitment,
    );
  }
  return pool;
}

describe("NET-W036-AC-01 demand pool authority", () => {
  test("the canonical tenant-scoped pool resolves through /demand with policy version, record format and the qualification witness", async () => {
    const runtime = harness.runtime;
    const scope = harness.organizationScopeId;
    const ctx = harness.poolCreatorCtx("w036-ac01-canonical");
    const pool = await seedCanonicalPool(
      "W036 AC-01 Canonical Pool",
      "w036-ac01-pool-canonical",
    );

    // (a) The pool resolves through the OWNING boundary within scope:
    //     the acting creator is server-resolved; the policy version +
    //     the record-format lineage are durable.
    const resolved = await runtime.procurementService.getProcurementPool(
      ctx,
      scope,
      pool.id,
    );
    expect(resolved.id).toBe(pool.id);
    expect(resolved.organizationScopeId).toBe(scope);
    expect(resolved.createdBy).toBe(harness.poolCreatorPersonId);
    expect(resolved.name).toBe("W036 AC-01 Canonical Pool");
    expect(resolved.categoryKey).toBe("cloud_infrastructure");
    expect(resolved.policy.version).toBe(1);
    expect(resolved.policy.minimumCommitments).toBe(2);
    expect(resolved.policy.minimumOrganizations).toBe(2);
    expect(resolved.recordFormat).toBe("NET-W025:1");
    expect(resolved.closedAt).toBeNull();

    // (b) The qualification witness: the DERIVED aggregate re-derives
    //     every governing fact — qualified true, all six checks
    //     satisfied, the separate commitment/organization dimensions
    //     3/3, the reproducible digest (anchor excluded).
    const witness = await runtime.procurementService
      .evaluateQualifiedProcurementDemand(ctx, {
        organizationScopeId: scope,
        poolId: pool.id,
      });
    expect(witness.qualified).toBe(true);
    expect(witness.aggregate).not.toBeNull();
    expect(witness.aggregate!.commitmentCount).toBe(3);
    expect(witness.aggregate!.organizationCount).toBe(3);
    const checkMap = new Map(
      witness.checks.map((c) => [c.check, c.satisfied]),
    );
    expect(checkMap.get("pool_open")).toBe(true);
    expect(checkMap.get("requestor_membership")).toBe(true);
    expect(checkMap.get("commitments_present")).toBe(true);
    expect(checkMap.get("privacy_floor_met")).toBe(true);
    expect(checkMap.get("organization_floor_met")).toBe(true);
    expect(checkMap.get("qualification_thresholds_met")).toBe(true);
    expect(witness.digest).not.toBe("");
    const replay = await runtime.procurementService
      .evaluateQualifiedProcurementDemand(ctx, {
        organizationScopeId: scope,
        poolId: pool.id,
      });
    expect(replay.qualified).toBe(true);
    expect(replay.digest).toBe(witness.digest);

    // (c) Audit lineage: exactly one pool.created + one
    //     commitment.recorded per durable commitment id, in the
    //     canonical creation order (positions strictly ascending).
    //     The creation order is identified by the FIXED SEED KEYS
    //     (…-commit-a/-b/-c), NOT the repository list order: the list
    //     breaks createdAt ties by record id (server-generated), which
    //     is NOT the creation order when two sequential commitments
    //     commit within the same millisecond under load — the audit
    //     order (creation order) is the proof, so the expected order
    //     must come from the deterministic seed keys (stage-6
    //     full-gate fix; the assertion semantics are unchanged).
    const poolEvents = await runtime.auditWriter.query({
      eventType: "procurement_pool.created",
      resourceId: pool.id,
    });
    expect(poolEvents).toHaveLength(1);
    const commitments = await runtime.procurementService
      .listProcurementCommitments(ctx, scope, { poolId: pool.id });
    expect(commitments).toHaveLength(3);
    const commitmentsByKey = new Map(
      commitments.map((c) => [c.idempotencyKey, c.id] as const),
    );
    const orderedCommitmentIds = [
      "w036-ac01-pool-canonical-commit-a",
      "w036-ac01-pool-canonical-commit-b",
      "w036-ac01-pool-canonical-commit-c",
    ].map((key) => {
      const id = commitmentsByKey.get(key);
      expect(id, `commitment for seed key ${key} should exist`).toBeDefined();
      return id!;
    });
    const log = await runtime.auditWriter.query({ limit: 1_000_000 });
    const positions = [pool.id, ...orderedCommitmentIds].map(
      (resourceId) => {
        const index = log.findIndex(
          (event) =>
            (event.eventType === "procurement_pool.created" ||
              event.eventType === "procurement_commitment.recorded") &&
            event.resourceId === resourceId,
        );
        expect(index, `missing audit event for ${resourceId}`).toBeGreaterThanOrEqual(0);
        return index;
      },
    );
    for (let i = 1; i < positions.length; i += 1) {
      expect(positions[i]!).toBeGreaterThan(positions[i - 1]!);
    }
  }, 120_000);

  test("cross-tenant pool reads fail closed with NO existence oracle (identical to a nonexistent pool)", async () => {
    const runtime = harness.runtime;
    const pool = await seedCanonicalPool(
      "W036 AC-01 Cross Tenant Pool",
      "w036-ac01-pool-cross",
    );
    const foreignOrg = await runtime.organizationService.createOrganization(
      harness.bootstrapCtx,
      {
        name: "W036 AC-01 Foreign Org",
        creatorId: harness.supplierAPersonId,
      },
    );
    const ctx = harness.poolCreatorCtx("w036-ac01-cross");
    // A REAL pool id under a FOREIGN tenant scope: NotFoundError.
    const crossError = await runtime.procurementService
      .getProcurementPool(ctx, foreignOrg.id, pool.id)
      .catch((e: unknown) => e);
    expect(crossError).toBeInstanceOf(NotFoundError);
    // A NONEXISTENT pool id under the same foreign scope: the SAME
    // error shape — the message differs ONLY by the caller-supplied id
    // (no existence oracle).
    const nonexistentId = "w036-ac01-no-such-pool";
    const nonexistentError = await runtime.procurementService
      .getProcurementPool(ctx, foreignOrg.id, nonexistentId)
      .catch((e: unknown) => e);
    expect(nonexistentError).toBeInstanceOf(NotFoundError);
    expect((crossError as NotFoundError).code).toBe("NOT_FOUND");
    expect((crossError as NotFoundError).code).toBe(
      (nonexistentError as NotFoundError).code,
    );
    expect((crossError as NotFoundError).message).toBe(
      (nonexistentError as NotFoundError).message.replace(
        nonexistentId,
        pool.id,
      ),
    );
    // The aggregate derivation is tenant-anchored too: a foreign scope
    // with a REAL pool id fails closed exactly the same way.
    const crossEvalError = await runtime.procurementService
      .evaluateQualifiedProcurementDemand(ctx, {
        organizationScopeId: foreignOrg.id,
        poolId: pool.id,
      })
      .catch((e: unknown) => e);
    expect(crossEvalError).toBeInstanceOf(NotFoundError);
  }, 120_000);

  test("unauthorized actors fail closed: no active membership, and non-person actors are rejected", async () => {
    const runtime = harness.runtime;
    const scope = harness.organizationScopeId;
    const pool = await seedCanonicalPool(
      "W036 AC-01 Authorization Pool",
      "w036-ac01-pool-auth",
    );

    // (a) A person with NO membership anywhere (created through the
    //     /identity authority) cannot commit demand: the server-side
    //     membership gate fails closed.
    const outsider = await runtime.identityService.createIdentity(
      harness.bootstrapCtx,
      {
        displayName: "W036 AC-01 Outsider",
        subjectReferences: [
          { subjectId: "w036-ac01-outsider@example.com", providerKind: "internal" },
        ],
      },
    );
    const outsiderError = await runtime.procurementService
      .createProcurementCommitment(
        personCtx(harness, outsider.id, "w036-ac01-outsider"),
        {
          organizationScopeId: scope,
          poolId: pool.id,
          buyerOrganizationId: harness.buyerOrgAId,
          attributes: { region: "NA_EAST", quantity: 12 },
          consent: { scope: "aggregate_disclosure" },
          idempotencyKey: "w036-ac01-outsider-commit",
        },
      )
      .catch((e: unknown) => e);
    expect(outsiderError).toBeInstanceOf(AuthorizationError);
    expect((outsiderError as AuthorizationError).code).toBe("AUTHORIZATION");
    expect(
      ((outsiderError as AuthorizationError).context as Record<string, unknown>)["reason"],
    ).toBe("not_a_member");
    // The outsider cannot create pools either.
    const outsiderPoolError = await runtime.procurementService
      .createProcurementPool(
        personCtx(harness, outsider.id, "w036-ac01-outsider-pool"),
        {
          organizationScopeId: scope,
          name: "W036 AC-01 Outsider Pool",
          categoryKey: "cloud_infrastructure",
          qualificationPolicy: { minimumCommitments: 2, minimumOrganizations: 2 },
          idempotencyKey: "w036-ac01-outsider-pool",
        },
      )
      .catch((e: unknown) => e);
    expect(outsiderPoolError).toBeInstanceOf(AuthorizationError);

    // (b) A NON-PERSON actor (a service principal) is rejected before
    //     any domain logic: the acting-person resolution fails closed.
    const serviceCtx = createExecutionContext({
      correlationId: "w036-ac01-service-actor",
      actor: { id: "w036-ac01-service-actor", kind: "service" },
    });
    const serviceError = await runtime.procurementService
      .createProcurementCommitment(serviceCtx, {
        organizationScopeId: scope,
        poolId: pool.id,
        buyerOrganizationId: harness.buyerOrgAId,
        attributes: { region: "NA_EAST", quantity: 12 },
        consent: { scope: "aggregate_disclosure" },
        idempotencyKey: "w036-ac01-service-commit",
      })
      .catch((e: unknown) => e);
    expect(serviceError).toBeInstanceOf(AuthorizationError);
    expect(
      ((serviceError as AuthorizationError).context as Record<string, unknown>)["actorKind"],
    ).toBe("service");

    // (c) No commitment was minted by either rejected attempt.
    const commitments = await runtime.procurementService
      .listProcurementCommitments(
        harness.poolCreatorCtx("w036-ac01-auth-list"),
        scope,
        { poolId: pool.id },
      );
    expect(commitments).toHaveLength(3);
  }, 120_000);

  test("demand commitments stay private and selection/funding is never caller-assertable (the durable records carry no selection or economic surface)", async () => {
    const runtime = harness.runtime;
    const scope = harness.organizationScopeId;
    const pool = await seedCanonicalPool(
      "W036 AC-01 Privacy Pool",
      "w036-ac01-pool-privacy",
    );
    const commitments = await runtime.procurementService
      .listProcurementCommitments(
        harness.poolCreatorCtx("w036-ac01-privacy-list"),
        scope,
        { poolId: pool.id },
      );

    // (a) A NON-MEMBER requestor's aggregate view: the
    //     requestor_membership check fails → aggregate null — a 200
    //     DECISION (never an exception), and NO commitment facts cross.
    const outsider = await runtime.identityService.createIdentity(
      harness.bootstrapCtx,
      {
        displayName: "W036 AC-01 View Outsider",
        subjectReferences: [
          {
            subjectId: "w036-ac01-view-outsider@example.com",
            providerKind: "internal",
          },
        ],
      },
    );
    const view = await runtime.procurementService
      .evaluateQualifiedProcurementDemand(
        personCtx(harness, outsider.id, "w036-ac01-nm-view"),
        { organizationScopeId: scope, poolId: pool.id },
      );
    expect(view.qualified).toBe(false);
    expect(view.aggregate).toBeNull();
    const membership = view.checks.find(
      (c) => c.check === "requestor_membership",
    );
    expect(membership?.satisfied).toBe(false);
    const viewJson = JSON.stringify(view);
    for (const commitment of commitments) {
      expect(viewJson).not.toContain(commitment.id);
      expect(viewJson).not.toContain(commitment.submittedBy);
    }
    for (const orgId of [
      harness.buyerOrgAId,
      harness.buyerOrgBId,
      harness.buyerOrgCId,
    ]) {
      expect(viewJson).not.toContain(orgId);
    }

    // (b) The CreateProcurementPool input carries NO selection/funding
    //     fields — smuggled extra properties are INERT (ignored; the
    //     input surface is closed), and the durable record carries
    //     exactly the sanctioned pool fields.
    const smuggled = (
      await runtime.procurementService.createProcurementPool(
        harness.poolCreatorCtx("w036-ac01-smuggle"),
        {
          organizationScopeId: scope,
          name: "W036 AC-01 Smuggled Fields Pool",
          categoryKey: "cloud_infrastructure",
          qualificationPolicy: { minimumCommitments: 2, minimumOrganizations: 2 },
          idempotencyKey: "w036-ac01-pool-smuggled",
          // Caller-side smuggle attempt (ignored — there is no
          // selection/funding input surface on any /demand command).
          ...({
            selectedOfferId: "w036-ac01-smuggled-selection",
            fundingAmount: 999,
            allocationTotal: 999,
          } as Record<string, unknown>),
        } as CreateProcurementPoolInput,
      )
    ).pool;
    const smuggledRecord = await runtime.procurementService
      .getProcurementPool(
        harness.poolCreatorCtx("w036-ac01-smuggle-read"),
        scope,
        smuggled.id,
      );
    // The durable record key set is EXACTLY the sanctioned pool fields.
    expect(Object.keys(smuggledRecord).sort()).toEqual([
      "categoryKey",
      "categoryVersion",
      "causationId",
      "closedAt",
      "closureReason",
      "correlationId",
      "createdAt",
      "createdBy",
      "executionId",
      "id",
      "idempotencyKey",
      "name",
      "organizationScopeId",
      "policy",
      "recordFormat",
      "updatedAt",
    ]);
    const recordJson = JSON.stringify(smuggledRecord);
    for (const forbidden of [
      "selectedOfferId",
      "fundingAmount",
      "allocationTotal",
      "selection",
      "funding",
    ]) {
      expect(recordJson).not.toContain(forbidden);
    }
    // No selection record exists for the pool (nothing was selected or
    // funded by the creation), and no selection audit event exists.
    const selections = await runtime.supplierOfferService.listPoolSelections(
      harness.poolCreatorCtx("w036-ac01-smuggle-selections"),
      { organizationScopeId: scope, poolId: smuggled.id },
    );
    expect(selections).toEqual([]);
    const selectionEvents = await runtime.auditWriter.query({
      eventType: "procurement_selection.recorded",
    });
    expect(
      selectionEvents.filter(
        (event) =>
          (event.metadata as Record<string, unknown>)["poolId"] ===
          smuggled.id,
      ),
    ).toEqual([]);
    // The pool + commitment records carry no economic vocabulary (a
    // demand pool is never a ledger — /settlement stays the economic
    // authority).
    const commitmentsJson = JSON.stringify(commitments).toLowerCase();
    for (const economicTerm of [
      "credit",
      "ledger",
      "posting",
      "obligation",
      "payout",
      "reward",
      "stake",
      "balance",
      '"amount"',
    ]) {
      expect(recordJson.toLowerCase()).not.toContain(economicTerm);
      expect(commitmentsJson).not.toContain(economicTerm);
    }
  }, 120_000);

  test("same-key replay of pool creation is exactly-once (created:false, identical record, one audit event)", async () => {
    const runtime = harness.runtime;
    const scope = harness.organizationScopeId;
    const ctx = harness.poolCreatorCtx("w036-ac01-replay");
    const input: CreateProcurementPoolInput = {
      organizationScopeId: scope,
      name: "W036 AC-01 Replay Pool",
      categoryKey: "cloud_infrastructure",
      qualificationPolicy: { minimumCommitments: 2, minimumOrganizations: 2 },
      idempotencyKey: "w036-ac01-pool-replay",
    };
    const first = await runtime.procurementService.createProcurementPool(
      ctx,
      input,
    );
    expect(first.created).toBe(true);
    const replay = await runtime.procurementService.createProcurementPool(
      ctx,
      input,
    );
    expect(replay.created).toBe(false);
    // The replay returns the IDENTICAL committed record (same id, same
    // creation instant, same policy — byte-identical record).
    expect(replay.pool).toEqual(first.pool);
    expect(replay.pool.id).toBe(first.pool.id);
    expect(replay.pool.createdAt).toBe(first.pool.createdAt);
    // Exactly ONE durable record + exactly ONE audit event.
    const events = await runtime.auditWriter.query({
      eventType: "procurement_pool.created",
      resourceId: first.pool.id,
    });
    expect(events).toHaveLength(1);
    const resolved = await runtime.procurementService.getProcurementPool(
      ctx,
      scope,
      first.pool.id,
    );
    expect(resolved.updatedAt).toBe(first.pool.createdAt);
  }, 120_000);
});
