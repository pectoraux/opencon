/**
 * NET-W027 AC-06 — Cross-tenant and unauthorized access fail closed
 * without existence leakage: cross-tenant references are
 * indistinguishable from nonexistent ones (no existence oracles);
 * every savings/baseline surface is pool-creator-only and
 * server-resolved (issue #54 acceptance criterion 6).
 *
 * Work order: spec/work-orders/NET-W027.md §3 / §7 AC-06.
 */

import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import {
  createNetW027Harness,
  createBaseline,
  createPoolEvidence,
  createSavingsObservation,
  seedSavingsScenario,
  evaluateSavings,
  recordSavings,
  poolCreatorCtx,
  key,
  daysAgoIso,
  type NetW027Harness,
} from "./_net-w027-harness.ts";
import { personCtx, createSupplierMember } from "./_net-w026-harness.ts";
import { NotFoundError } from "../../src/core/errors.ts";

let harness: NetW027Harness;

beforeAll(async () => {
  harness = await createNetW027Harness();
});

afterAll(async () => {
  await harness.teardown();
});

describe("NET-W027-AC-06 tenancy / authorization fail-closed", () => {
  test("cross-tenant pool/baseline references are indistinguishable from nonexistent (no existence oracle)", async () => {
    const scenario = await seedSavingsScenario(harness, {
      name: "AC-06 Tenancy Pool",
    });
    const ctx = poolCreatorCtx(harness, "w027-ac06-tenancy");
    const otherScope = "w027-other-tenant-scope";

    const errorOf = async (promise: Promise<unknown>): Promise<Error> => {
      try {
        await promise;
        return new Error("expected a rejection");
      } catch (error) {
        return error as Error;
      }
    };

    // Cross-tenant POOL anchor vs a nonexistent pool: the same
    // NotFoundError with the same message shape (the cross-tenant id
    // is never named — indistinguishable).
    const crossPool = await errorOf(
      harness.runtime.procurementSavingsService.evaluateProcurementSavings(
        ctx,
        {
          organizationScopeId: otherScope,
          poolId: scenario.poolId,
          baselineId: scenario.baseline.id,
          outcomeObservationIds: [],
        },
      ),
    );
    const missingPool = await errorOf(
      harness.runtime.procurementSavingsService.evaluateProcurementSavings(
        ctx,
        {
          organizationScopeId: otherScope,
          poolId: key("w027-nonexistent-pool"),
          baselineId: scenario.baseline.id,
          outcomeObservationIds: [],
        },
      ),
    );
    expect(crossPool).toBeInstanceOf(NotFoundError);
    expect(missingPool).toBeInstanceOf(NotFoundError);
    // Indistinguishability = the IDENTICAL error template (the id in
    // the message is the caller's own input — it discloses nothing
    // about the cross-tenant record's existence, scope or content).
    const template = (message: string) => message.replace(/: .*$/, ": <id>");
    expect(template(crossPool.message)).toBe(template(missingPool.message));

    // Cross-tenant BASELINE: equally indistinguishable — and the
    // baseline POOL anchor is equally cross-tenant-safe (a baseline
    // in scope is unreachable through another tenant).
    const crossBaseline = await errorOf(
      harness.runtime.procurementSavingsService.evaluateProcurementSavings(
        ctx,
        {
          organizationScopeId: otherScope,
          poolId: scenario.poolId,
          baselineId: scenario.baseline.id,
          outcomeObservationIds: [],
        },
      ),
    );
    const missingBaseline = await errorOf(
      harness.runtime.procurementSavingsService.invalidateProcurementBaseline(
        ctx,
        {
          organizationScopeId: otherScope,
          baselineId: key("w027-nonexistent-baseline"),
          reason: "quality_review",
          idempotencyKey: key("w027-ac06-missing-baseline"),
        },
      ),
    );
    expect(crossBaseline).toBeInstanceOf(NotFoundError);
    expect(missingBaseline).toBeInstanceOf(NotFoundError);
    await expect(
      harness.runtime.procurementSavingsService.invalidateProcurementBaseline(
        ctx,
        {
          organizationScopeId: otherScope,
          baselineId: scenario.baseline.id,
          reason: "quality_review",
          idempotencyKey: key("w027-ac06-cross-baseline"),
        },
      ),
    ).rejects.toThrow(NotFoundError);
  });

  test("cross-tenant observation references are indistinguishable from nonexistent", async () => {
    const scenario = await seedSavingsScenario(harness, {
      name: "AC-06 Observation Tenancy Pool",
    });
    const ctx = poolCreatorCtx(harness, "w027-ac06-obs-tenancy");
    const otherScopeObservation = await createSavingsObservation(harness, {
      poolId: scenario.poolId,
      organizationScopeId: "w027-other-tenant-scope",
    });

    await expect(
      harness.runtime.procurementSavingsService.evaluateProcurementSavings(
        ctx,
        {
          organizationScopeId: harness.organizationScopeId,
          poolId: scenario.poolId,
          baselineId: scenario.baseline.id,
          outcomeObservationIds: [otherScopeObservation.id],
        },
      ),
    ).rejects.toThrow(NotFoundError);
    await expect(
      harness.runtime.procurementSavingsService.evaluateProcurementSavings(
        ctx,
        {
          organizationScopeId: harness.organizationScopeId,
          poolId: scenario.poolId,
          baselineId: scenario.baseline.id,
          outcomeObservationIds: [key("w027-nonexistent-observation")],
        },
      ),
    ).rejects.toThrow(NotFoundError);
  });

  test("every W027 surface is pool-creator-only (a member who is not the creator fails closed on every command)", async () => {
    const scenario = await seedSavingsScenario(harness, {
      name: "AC-06 Creator Gate Pool",
    });
    const buyerBCtx = personCtx(
      harness.w026.w025.buyerBPersonId,
      "w027-ac06-buyer-b",
    );
    const evidence = await createPoolEvidence(harness, {
      poolId: scenario.poolId,
    });

    // Baseline creation.
    await expect(
      createBaseline(harness, {
        poolId: scenario.poolId,
        evidenceIds: [evidence.id],
        ctx: buyerBCtx,
      }),
    ).rejects.toThrow("only the procurement pool's creator");

    // Baseline invalidation.
    await expect(
      harness.runtime.procurementSavingsService.invalidateProcurementBaseline(
        buyerBCtx,
        {
          organizationScopeId: harness.organizationScopeId,
          baselineId: scenario.baseline.id,
          reason: "quality_review",
          idempotencyKey: key("w027-ac06-buyer-b-invalidate"),
        },
      ),
    ).rejects.toThrow("only the procurement pool's creator");

    // Baseline listing.
    await expect(
      harness.runtime.procurementSavingsService.listPoolBaselines(buyerBCtx, {
        organizationScopeId: harness.organizationScopeId,
        poolId: scenario.poolId,
      }),
    ).rejects.toThrow("only the procurement pool's creator");

    // Derived evaluation.
    await expect(
      evaluateSavings(harness, {
        poolId: scenario.poolId,
        baselineId: scenario.baseline.id,
        outcomeObservationIds: [scenario.observation.id],
        ctx: buyerBCtx,
      }),
    ).rejects.toThrow("only the procurement pool's creator");

    // The authoritative record.
    await expect(
      recordSavings(harness, {
        poolId: scenario.poolId,
        baselineId: scenario.baseline.id,
        outcomeObservationIds: [scenario.observation.id],
        ctx: buyerBCtx,
      }),
    ).rejects.toThrow("only the procurement pool's creator");

    // The savings lineage listing.
    await expect(
      harness.runtime.procurementSavingsService.listPoolSavings(buyerBCtx, {
        organizationScopeId: harness.organizationScopeId,
        poolId: scenario.poolId,
      }),
    ).rejects.toThrow("only the procurement pool's creator");
  });

  test("the TENANT membership gate is server-resolved (a non-member fails closed before any surface)", async () => {
    const scenario = await seedSavingsScenario(harness, {
      name: "AC-06 Membership Pool",
    });
    // A fresh person whose membership is granted then REVOKED: the
    // person exists but holds no ACTIVE membership (the membership
    // gate fails closed before any surface).
    const outsider = await createSupplierMember(
      harness.runtime,
      harness.bootstrapCtx,
      harness.organizationScopeId,
      {
        displayName: "W027 Outsider (membership revoked)",
        subjectId: `w027-outsider-${key("member")}@example.com`,
      },
    );
    await harness.runtime.membershipService.revokeMembership(
      harness.bootstrapCtx,
      outsider.tenantMembershipId,
      "bootstrap",
    );
    const outsiderCtx = personCtx(outsider.personId, "w027-ac06-outsider");

    await expect(
      harness.runtime.procurementSavingsService.listPoolBaselines(
        outsiderCtx,
        {
          organizationScopeId: harness.organizationScopeId,
          poolId: scenario.poolId,
        },
      ),
    ).rejects.toThrow(
      "require an active organization membership",
    );
    const evidence = await createPoolEvidence(harness, {
      poolId: scenario.poolId,
    });
    await expect(
      createBaseline(harness, {
        poolId: scenario.poolId,
        evidenceIds: [evidence.id],
        ctx: outsiderCtx,
      }),
    ).rejects.toThrow("require an active organization membership");
  });
});
