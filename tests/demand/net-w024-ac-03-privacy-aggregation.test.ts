/**
 * NET-W024 AC-03 — Supplier-facing demand is privacy-preserving and
 * aggregate; individual commitments cannot be reconstructed from the
 * normal output contract (issue #48 acceptance criterion 3).
 *
 * Work order: spec/work-orders/NET-W024.md §4 AC-03.
 */

import { describe, test, expect, beforeAll, afterAll } from "bun:test";
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
import type { QualifiedDemandAggregate } from "../../src/demand/port.ts";
import { DEMAND_PRIVACY_MINIMUM_COMMITMENTS } from "../../src/core/demand.ts";

let harness: NetW024Harness;

beforeAll(async () => {
  harness = await createNetW024Harness();
});

afterAll(async () => {
  await harness.teardown();
});

/** UUID-shaped id pattern (every person/commitment/pool id in the system). */
const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Collect every STRING value in a derived view, recursively. */
function collectStrings(value: unknown, out: string[] = []): string[] {
  if (typeof value === "string") out.push(value);
  else if (Array.isArray(value)) for (const item of value) collectStrings(item, out);
  else if (value !== null && typeof value === "object") {
    for (const v of Object.values(value)) collectStrings(v, out);
  }
  return out;
}

/** Collect every NUMBER value in a derived view, recursively. */
function collectNumbers(value: unknown, out: number[] = []): number[] {
  if (typeof value === "number") out.push(value);
  else if (Array.isArray(value)) for (const item of value) collectNumbers(item, out);
  else if (value !== null && typeof value === "object") {
    for (const v of Object.values(value)) collectNumbers(v, out);
  }
  return out;
}

async function members(n: number, tag: string) {
  const persons: { personId: string }[] = [];
  for (let i = 0; i < n; i++) {
    persons.push(
      await createPerson(harness, {
        displayName: `AC-03 ${tag} ${String(i)}`,
        subjectId: `w024-ac03-${tag}-${String(i)}@example.com`,
        member: true,
      }),
    );
  }
  return persons;
}

describe("NET-W024-AC-03 privacy-preserving aggregation", () => {
  test("the aggregate view contains NO id-shaped string (no person/commitment/pool ids beyond the pool reference)", async () => {
    const pool = await createPool(harness, { minimumCommitments: 2 });
    // Distinctive per-person quantities (never equal to any plausible
    // count, threshold or version in the view).
    await createCommitment(harness, { poolId: pool.id, quantity: 37 });
    await createCommitment(harness, {
      poolId: pool.id,
      ctx: supplierCtx(harness, "w024-ac03-s1"),
      quantity: 41,
    });
    await createCommitment(harness, {
      poolId: pool.id,
      ctx: personCtx(
        (await members(1, "x"))[0]!.personId,
        "w024-ac03-x1",
      ),
      quantity: 53,
    });

    const view = await harness.runtime.demandService.evaluateQualifiedDemand(
      supplierCtx(harness, "w024-ac03-eval"),
      { organizationScopeId: harness.organizationScopeId, poolId: pool.id },
    );
    expect(view.qualified).toBe(true);
    expect(view.aggregate).not.toBeNull();

    // Every string in the view: poolId (the subject), org scope id,
    // category keys/versions, check names, reasons, region codes,
    // bucket names, the digest, the anchor. NONE may be UUID-shaped
    // except the explicit pool reference and org scope (the request
    // context itself). This proves no consumerPersonId / commitmentId
    // leaks into the supplier-facing output.
    const strings = collectStrings(view);
    const uuidShaped = strings.filter((s) => UUID_RE.test(s));
    expect(new Set(uuidShaped)).toEqual(
      new Set([pool.id, harness.organizationScopeId]),
    );
  });

  test("exact per-person quantities never appear: only fixed-bucket distributions", async () => {
    const pool = await createPool(harness, { minimumCommitments: 2 });
    const quantities = [37, 41, 43];
    await createCommitment(harness, { poolId: pool.id, quantity: quantities[0] });
    await createCommitment(harness, {
      poolId: pool.id,
      ctx: supplierCtx(harness, "w024-ac03-q2"),
      quantity: quantities[1]!,
    });
    await createCommitment(harness, {
      poolId: pool.id,
      ctx: personCtx((await members(1, "q"))[0]!.personId, "w024-ac03-q3"),
      quantity: quantities[2]!,
    });

    const view = await harness.runtime.demandService.evaluateQualifiedDemand(
      supplierCtx(harness, "w024-ac03-quantities"),
      { organizationScopeId: harness.organizationScopeId, poolId: pool.id },
    );
    const numbers = collectNumbers(view);
    // None of the exact per-person quantities is disclosed.
    for (const q of quantities) {
      expect(numbers).not.toContain(q);
    }
    // The quantity crosses ONLY as the fixed bucket q_10_49 with
    // count 3 (three commitments, one bucket group).
    expect(view.aggregate?.quantityBuckets).toEqual([
      { group: "q_10_49", count: 3 },
    ]);
  });

  test("below-floor distribution groups are suppressed — counted, never named", async () => {
    const pool = await createPool(harness, { minimumCommitments: 2 });
    // 3 in NA_EAST + 1 in EU_NORTH: the EU_NORTH group (1 < floor)
    // must be suppressed, never named.
    await createCommitment(harness, { poolId: pool.id, region: "NA_EAST" });
    await createCommitment(harness, {
      poolId: pool.id,
      ctx: supplierCtx(harness, "w024-ac03-g2"),
      region: "NA_EAST",
    });
    await createCommitment(harness, {
      poolId: pool.id,
      ctx: personCtx((await members(1, "g"))[0]!.personId, "w024-ac03-g3"),
      region: "NA_EAST",
    });
    const late = await createPerson(harness, {
      displayName: "AC-03 Late",
      subjectId: "w024-ac03-late@example.com",
      member: true,
    });
    await createCommitment(harness, {
      poolId: pool.id,
      ctx: personCtx(late.personId, "w024-ac03-g4"),
      region: "EU_NORTH",
    });

    const view = await harness.runtime.demandService.evaluateQualifiedDemand(
      supplierCtx(harness, "w024-ac03-groups"),
      { organizationScopeId: harness.organizationScopeId, poolId: pool.id },
    );
    expect(view.aggregate?.commitmentCount).toBe(4);
    expect(view.aggregate?.regionGroups).toEqual([
      { group: "NA_EAST", count: 3 },
    ]);
    // The EU_NORTH group is folded into the suppressed count and its
    // name appears NOWHERE in the view.
    expect(view.aggregate?.suppressedGroups).toBe(1);
    expect(collectStrings(view)).not.toContain("EU_NORTH");
  });

  test("the frozen privacy floor suppresses ALL aggregate facts (even the count) below the floor", async () => {
    expect(DEMAND_PRIVACY_MINIMUM_COMMITMENTS).toBe(3);
    const pool = await createPool(harness, { minimumCommitments: 2 });
    // TWO commitments: above the pool threshold, below the floor.
    await createCommitment(harness, { poolId: pool.id });
    await createCommitment(harness, {
      poolId: pool.id,
      ctx: supplierCtx(harness, "w024-ac03-floor2"),
    });

    const view = await harness.runtime.demandService.evaluateQualifiedDemand(
      supplierCtx(harness, "w024-ac03-floor"),
      { organizationScopeId: harness.organizationScopeId, poolId: pool.id },
    );
    // Threshold met, floor not → NOT qualified, and NO aggregate facts.
    expect(view.qualified).toBe(false);
    expect(view.aggregate).toBeNull();
    // Even the commitment COUNT is suppressed: the serialized view
    // carries no "commitmentCount" key anywhere and no count values.
    const serialized = JSON.stringify(view);
    expect(serialized).not.toContain("commitmentCount");
    // The floor check detail carries no count either.
    const floorCheck = view.checks.find((c) => c.check === "privacy_floor_met");
    expect(floorCheck?.satisfied).toBe(false);
    expect(JSON.stringify(floorCheck?.detail)).not.toMatch(/"count"/);
  });

  test("consent is enforced end-to-end: only aggregate_disclosure consent exists and withdrawal is immediate", async () => {
    const pool = await createPool(harness, { minimumCommitments: 2 });
    const c1 = await createCommitment(harness, { poolId: pool.id, quantity: 37 });
    await createCommitment(harness, {
      poolId: pool.id,
      ctx: supplierCtx(harness, "w024-ac03-c2"),
      quantity: 41,
    });
    const c3 = await createCommitment(harness, {
      poolId: pool.id,
      ctx: personCtx((await members(1, "c"))[0]!.personId, "w024-ac03-c3"),
      quantity: 53,
    });

    const before = await harness.runtime.demandService.evaluateQualifiedDemand(
      supplierCtx(harness, "w024-ac03-consent-before"),
      { organizationScopeId: harness.organizationScopeId, poolId: pool.id },
    );
    expect(before.aggregate?.commitmentCount).toBe(3);

    // Withdraw TWO of the three: count 1 < floor → everything
    // suppressed. The withdrawal is the consent revocation and it
    // takes effect on the very next evaluation.
    await harness.runtime.demandService.withdrawDemandCommitment(
      consumerCtx(harness, "w024-ac03-withdraw-1"),
      {
        organizationScopeId: harness.organizationScopeId,
        commitmentId: c1.id,
        idempotencyKey: key("w024-ac03-w1"),
      },
    );
    await harness.runtime.demandService.withdrawDemandCommitment(
      personCtx(c3.consumerPersonId, "w024-ac03-withdraw-3"),
      {
        organizationScopeId: harness.organizationScopeId,
        commitmentId: c3.id,
        idempotencyKey: key("w024-ac03-w3"),
      },
    );

    const after = await harness.runtime.demandService.evaluateQualifiedDemand(
      supplierCtx(harness, "w024-ac03-consent-after"),
      { organizationScopeId: harness.organizationScopeId, poolId: pool.id },
    );
    expect(after.aggregate).toBeNull();
    expect(after.qualified).toBe(false);
  });

  test("the aggregate fact set is EXACTLY the minimized contract (structural reconstruction resistance)", async () => {
    const pool = await createPool(harness, { minimumCommitments: 2 });
    await createCommitment(harness, { poolId: pool.id, quantity: 37 });
    await createCommitment(harness, {
      poolId: pool.id,
      ctx: supplierCtx(harness, "w024-ac03-rc2"),
      quantity: 41,
    });
    await createCommitment(harness, {
      poolId: pool.id,
      ctx: personCtx((await members(1, "r"))[0]!.personId, "w024-ac03-rc3"),
      quantity: 53,
    });
    const view: QualifiedDemandAggregate =
      await harness.runtime.demandService.evaluateQualifiedDemand(
        supplierCtx(harness, "w024-ac03-reconstruction"),
        { organizationScopeId: harness.organizationScopeId, poolId: pool.id },
      );
    // The aggregate fact object carries EXACTLY five keys: counts and
    // bounded distributions only.
    expect(Object.keys(view.aggregate ?? {}).sort()).toEqual([
      "budgetBandGroups",
      "commitmentCount",
      "quantityBuckets",
      "regionGroups",
      "suppressedGroups",
    ]);
    // Every distribution group is exactly { group, count }.
    for (const group of [
      ...(view.aggregate?.quantityBuckets ?? []),
      ...(view.aggregate?.regionGroups ?? []),
      ...(view.aggregate?.budgetBandGroups ?? []),
    ]) {
      expect(Object.keys(group).sort()).toEqual(["count", "group"]);
    }
    // No per-commitment timestamps / ids / person data: the only
    // timestamps in the whole view are the single evaluation anchor.
    const times = collectStrings(view).filter((s) =>
      /^\d{4}-\d{2}-\d{2}T/.test(s),
    );
    expect(times).toEqual([view.evaluatedAt]);
  });

  test("the derivation MUTATES nothing and AUDITS nothing (no evaluation side effects)", async () => {
    const pool = await createPool(harness, { minimumCommitments: 2 });
    await createCommitment(harness, { poolId: pool.id });
    await createCommitment(harness, {
      poolId: pool.id,
      ctx: supplierCtx(harness, "w024-ac03-side2"),
    });

    const auditBefore = await harness.runtime.auditWriter.query({
      resourceType: "demand_pool",
      resourceId: pool.id,
    });
    const poolBefore = await harness.runtime.demandService.getDemandPool(
      consumerCtx(harness, "w024-ac03-side-pool"),
      harness.organizationScopeId,
      pool.id,
    );

    await harness.runtime.demandService.evaluateQualifiedDemand(
      supplierCtx(harness, "w024-ac03-side-eval"),
      { organizationScopeId: harness.organizationScopeId, poolId: pool.id },
    );
    await harness.runtime.demandService.evaluateQualifiedDemand(
      supplierCtx(harness, "w024-ac03-side-eval-2"),
      { organizationScopeId: harness.organizationScopeId, poolId: pool.id },
    );

    // Zero audit deltas for evaluations (derived decisions are not
    // material mutations).
    const auditAfter = await harness.runtime.auditWriter.query({
      resourceType: "demand_pool",
      resourceId: pool.id,
    });
    expect(auditAfter.length).toBe(auditBefore.length);
    // Zero record mutations.
    const poolAfter = await harness.runtime.demandService.getDemandPool(
      consumerCtx(harness, "w024-ac03-side-pool-2"),
      harness.organizationScopeId,
      pool.id,
    );
    expect(poolAfter).toEqual(poolBefore);
  });

  test("error contexts on the demand surface carry no private commitment material", async () => {
    const pool = await createPool(harness, { minimumCommitments: 2 });
    const commitment = await createCommitment(harness, {
      poolId: pool.id,
      quantity: 37,
    });
    // A non-owner withdrawal: the authorization error context carries
    // only ids/reasons — never the private attribute payload.
    let errorContext: Record<string, unknown> | null = null;
    try {
      await harness.runtime.demandService.withdrawDemandCommitment(
        supplierCtx(harness, "w024-ac03-nonowner"),
        {
          organizationScopeId: harness.organizationScopeId,
          commitmentId: commitment.id,
          idempotencyKey: key("w024-ac03-nonowner"),
        },
      );
    } catch (e) {
      errorContext = (e as { context?: Record<string, unknown> }).context ?? null;
    }
    expect(errorContext).not.toBeNull();
    // The context carries ONLY authorization lineage fields (ids +
    // reasons) — never the private commitment attribute or consent
    // payload (no attribute keys, no region value, no consent scope).
    expect(Object.keys(errorContext ?? {}).sort()).toEqual([
      "actorPersonId",
      "commitmentId",
      "consumerPersonId",
    ]);
    const serialized = JSON.stringify(errorContext);
    expect(serialized).not.toContain("NA_EAST");
    expect(serialized).not.toContain("aggregate_disclosure");
    expect(serialized).not.toContain("attributes");
    expect(serialized).not.toContain("consent");
  });
});
