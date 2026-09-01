/**
 * NET-W027 AC-04 — Deterministic derivation is reproducible and
 * anchor-aware: identical authoritative state + evaluation anchor
 * produce identical derivations/digests; the digest EXCLUDES the
 * anchor; any governing-fact change changes the digest; the
 * observation order never leaks into the decision (issue #54
 * acceptance criterion 4).
 *
 * Work order: spec/work-orders/NET-W027.md §4.4 / §7 AC-04.
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
  type NetW027Harness,
} from "./_net-w027-harness.ts";
import { PROCUREMENT_SAVINGS_DERIVATION_POLICY_VERSION, PROCUREMENT_SAVINGS_DERIVATION_METHOD } from "../../src/core/procurement-savings.ts";

let harness: NetW027Harness;

beforeAll(async () => {
  harness = await createNetW027Harness();
});

afterAll(async () => {
  await harness.teardown();
});

describe("NET-W027-AC-04 deterministic, anchor-aware derivation", () => {
  test("identical authoritative state ⇒ identical digest; the anchor is recorded but NEVER digested", async () => {
    const scenario = await seedSavingsScenario(harness, {
      name: "AC-04 Digest Pool",
    });
    const first = await evaluateSavings(harness, {
      poolId: scenario.poolId,
      baselineId: scenario.baseline.id,
      outcomeObservationIds: [scenario.observation.id],
    });
    // Force a DISTINCT anchor (the same-millisecond pitfall of the
    // ms-precision nowIso() — the recorded W025/W026 flake).
    await new Promise((resolve) => setTimeout(resolve, 10));
    const second = await evaluateSavings(harness, {
      poolId: scenario.poolId,
      baselineId: scenario.baseline.id,
      outcomeObservationIds: [scenario.observation.id],
    });

    expect(second.digest).toBe(first.digest);
    expect(second.evaluatedAt).not.toBe(first.evaluatedAt);
    expect(second.savings).toEqual(first.savings);
    expect(second.checks).toEqual(first.checks);
    expect(second.supported).toBe(true);
  });

  test("the observation input ORDER never leaks into the decision (canonical id order)", async () => {
    const scenario = await seedSavingsScenario(harness, {
      name: "AC-04 Order Pool",
    });
    const second = await createSavingsObservation(harness, {
      poolId: scenario.poolId,
      value: 50,
    });
    const forward = await evaluateSavings(harness, {
      poolId: scenario.poolId,
      baselineId: scenario.baseline.id,
      outcomeObservationIds: [scenario.observation.id, second.id],
    });
    const reversed = await evaluateSavings(harness, {
      poolId: scenario.poolId,
      baselineId: scenario.baseline.id,
      outcomeObservationIds: [second.id, scenario.observation.id],
    });
    expect(reversed.digest).toBe(forward.digest);
    // The canonical id order is the recorded observation order.
    expect(forward.observationIds).toEqual(
      [...forward.observationIds].sort(),
    );
    expect(reversed.observationIds).toEqual(forward.observationIds);
    expect(reversed.observedValue).toEqual(forward.observedValue);
  });

  test("any governing-fact change changes the digest (observations, baseline, evidence, checks)", async () => {
    const scenario = await seedSavingsScenario(harness, {
      name: "AC-04 Governing Pool",
    });
    const base = await evaluateSavings(harness, {
      poolId: scenario.poolId,
      baselineId: scenario.baseline.id,
      outcomeObservationIds: [scenario.observation.id],
    });

    // A DIFFERENT observation set ⇒ different digest.
    const other = await createSavingsObservation(harness, {
      poolId: scenario.poolId,
      value: 700,
    });
    const withOther = await evaluateSavings(harness, {
      poolId: scenario.poolId,
      baselineId: scenario.baseline.id,
      outcomeObservationIds: [other.id],
    });
    expect(withOther.digest).not.toBe(base.digest);

    // A DIFFERENT baseline ⇒ different digest.
    const otherBaseline = await createBaseline(harness, {
      poolId: scenario.poolId,
      evidenceIds: [scenario.evidence.id],
      baselineKind: "counterfactual",
      baselineValue: { value: 1100, unit: "usd" },
    });
    const withBaseline = await evaluateSavings(harness, {
      poolId: scenario.poolId,
      baselineId: otherBaseline.id,
      outcomeObservationIds: [scenario.observation.id],
    });
    expect(withBaseline.digest).not.toBe(base.digest);

    // A changed CHECK VERDICT ⇒ different digest (invalidate the
    // baseline: same identities, different governing state).
    const ctx = poolCreatorCtx(harness, "w027-ac04-invalidate");
    await harness.runtime.procurementSavingsService
      .invalidateProcurementBaseline(ctx, {
        organizationScopeId: harness.organizationScopeId,
        baselineId: scenario.baseline.id,
        reason: "quality_review",
        idempotencyKey: `w027-ac04-invalidate-${scenario.baseline.id}`,
      });
    const invalidatedView = await evaluateSavings(harness, {
      poolId: scenario.poolId,
      baselineId: scenario.baseline.id,
      outcomeObservationIds: [scenario.observation.id],
    });
    expect(invalidatedView.digest).not.toBe(base.digest);
    expect(invalidatedView.supported).toBe(false);
  });

  test("a persisted record's derivation is REPRODUCIBLE from authoritative state alone", async () => {
    const scenario = await seedSavingsScenario(harness, {
      name: "AC-04 Reproduce Pool",
    });
    const record = await recordSavings(harness, {
      poolId: scenario.poolId,
      baselineId: scenario.baseline.id,
      outcomeObservationIds: [scenario.observation.id],
    });
    // A fresh derivation (10ms later, same state) reproduces the
    // record's digest exactly — the snapshot is derivable, never
    // caller-asserted.
    await new Promise((resolve) => setTimeout(resolve, 10));
    const rederived = await evaluateSavings(harness, {
      poolId: scenario.poolId,
      baselineId: scenario.baseline.id,
      outcomeObservationIds: [scenario.observation.id],
    });
    expect(rederived.digest).toBe(record.digest);
    expect(rederived.savings).toEqual(record.savings);
    expect(rederived.checks).toEqual(record.checks);
    expect(rederived.evaluatedAt).not.toBe(record.evaluationAnchor);
  });

  test("the derivation policy is explicit, versioned and recorded on every view/record", async () => {
    const scenario = await seedSavingsScenario(harness, {
      name: "AC-04 Policy Pool",
    });
    const view = await evaluateSavings(harness, {
      poolId: scenario.poolId,
      baselineId: scenario.baseline.id,
      outcomeObservationIds: [scenario.observation.id],
    });
    expect(view.derivationPolicy.version).toBe(
      PROCUREMENT_SAVINGS_DERIVATION_POLICY_VERSION,
    );
    expect(view.derivationPolicy.method).toBe(
      PROCUREMENT_SAVINGS_DERIVATION_METHOD,
    );
    expect(view.derivationPolicy.criteria.length).toBe(12);
    // The record snapshots the same policy.
    const record = await recordSavings(harness, {
      poolId: scenario.poolId,
      baselineId: scenario.baseline.id,
      outcomeObservationIds: [scenario.observation.id],
    });
    expect(record.derivationPolicy).toEqual(view.derivationPolicy);
  });
});
