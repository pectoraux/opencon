/**
 * NET-W027 AC-07 — Savings mutations are idempotent, concurrency-safe
 * and atomically audited: same-key replay is exactly-once; concurrent
 * recordings over one pool are serialized by the per-pool lock and
 * remain deterministic at their own anchors; a repository failure
 * inside the authoritative transaction leaves NO record and NO audit
 * event (issue #54 acceptance criterion 7).
 *
 * Work order: spec/work-orders/NET-W027.md §5 / §7 AC-07.
 */

import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import {
  createNetW027Harness,
  createPoolEvidence,
  createSavingsObservation,
  seedSavingsScenario,
  recordSavings,
  poolCreatorCtx,
  key,
  daysAgoIso,
  type NetW027Harness,
} from "./_net-w027-harness.ts";
import {
  createAuthorityProcurementBaselineRepository,
  createAuthorityProcurementSavingsRepository,
} from "../../src/demand/authority-savings-repositories.ts";
import { createAuthorityCompetitiveSelectionRepository } from "../../src/demand/authority-supplier-offer-repositories.ts";
import { createAuthorityProcurementPoolRepository } from "../../src/demand/authority-procurement-repositories.ts";
import { createAuthorityEvidenceRepository } from "../../src/evidence/authority-evidence-repository.ts";
import { createAuthorityOutcomeObservationRepository } from "../../src/outcomes/authority-outcome-observation-repository.ts";
import { createProcurementSavingsService } from "../../src/demand/savings-service.ts";
import type {
  ProcurementBaseline,
  ProcurementBaselineRepository,
  ProcurementSavings,
  ProcurementSavingsRepository,
  ProcurementSavingsService,
} from "../../src/demand/port.ts";

let harness: NetW027Harness;

beforeAll(async () => {
  harness = await createNetW027Harness();
});

afterAll(async () => {
  await harness.teardown();
});

describe("NET-W027-AC-07 idempotency / concurrency / atomicity", () => {
  test("same-key replay on recordProcurementSavings is exactly-once (one durable record, one audit event)", async () => {
    const scenario = await seedSavingsScenario(harness, {
      name: "AC-07 Replay Pool",
    });
    const ctx = poolCreatorCtx(harness, "w027-ac07-replay");
    const idempotencyKey = key("w027-ac07-replay");

    const input = {
      organizationScopeId: harness.organizationScopeId,
      poolId: scenario.poolId,
      baselineId: scenario.baseline.id,
      outcomeObservationIds: [scenario.observation.id],
      idempotencyKey,
    };
    const first = await harness.runtime.procurementSavingsService
      .recordProcurementSavings(ctx, input);
    expect(first.created).toBe(true);

    // A FRESH execution context with the SAME key replays the
    // committed record exactly once.
    const replayCtx = poolCreatorCtx(harness, "w027-ac07-replay-2");
    const replay = await harness.runtime.procurementSavingsService
      .recordProcurementSavings(replayCtx, input);
    expect(replay.created).toBe(false);
    expect(replay.savings).toEqual(first.savings);

    const records = await harness.runtime.procurementSavingsService
      .listPoolSavings(ctx, {
        organizationScopeId: harness.organizationScopeId,
        poolId: scenario.poolId,
      });
    expect(
      records.filter((record) => record.id === first.savings.id).length,
    ).toBe(1);
    const events = await harness.runtime.auditWriter.query({
      eventType: "procurement_savings.recorded",
      resourceId: first.savings.id,
    });
    expect(events.length).toBe(1);
  });

  test("concurrent recordings with DISTINCT keys both persist, serialized by the per-pool lock, deterministic at their own anchors", async () => {
    const scenario = await seedSavingsScenario(harness, {
      name: "AC-07 Concurrency Pool",
    });
    const ctxA = poolCreatorCtx(harness, "w027-ac07-concurrent-a");
    const ctxB = poolCreatorCtx(harness, "w027-ac07-concurrent-b");
    const input = {
      organizationScopeId: harness.organizationScopeId,
      poolId: scenario.poolId,
      baselineId: scenario.baseline.id,
      outcomeObservationIds: [scenario.observation.id],
    };

    const results = await Promise.allSettled([
      harness.runtime.procurementSavingsService.recordProcurementSavings(
        ctxA,
        { ...input, idempotencyKey: key("w027-ac07-concurrent-a") },
      ),
      harness.runtime.procurementSavingsService.recordProcurementSavings(
        ctxB,
        { ...input, idempotencyKey: key("w027-ac07-concurrent-b") },
      ),
    ]);
    expect(results.every((result) => result.status === "fulfilled")).toBe(
      true,
    );

    const [a, b] = results as readonly [
      PromiseFulfilledResult<{ readonly savings: ProcurementSavings; readonly created: boolean }>,
      PromiseFulfilledResult<{ readonly savings: ProcurementSavings; readonly created: boolean }>,
    ];
    expect(a.value.created).toBe(true);
    expect(b.value.created).toBe(true);
    expect(a.value.savings.id).not.toBe(b.value.savings.id);
    // The SAME authoritative state at (their own) anchors: the two
    // lineage records share the identical digest — the lock
    // serialized the writes and no nondeterministic savings state
    // interleaved.
    expect(a.value.savings.digest).toBe(b.value.savings.digest);
    expect(a.value.savings.savings).toEqual(b.value.savings.savings);

    const records = await harness.runtime.procurementSavingsService
      .listPoolSavings(poolCreatorCtx(harness, "w027-ac07-concurrent-list"), {
        organizationScopeId: harness.organizationScopeId,
        poolId: scenario.poolId,
      });
    expect(records.length).toBe(2);
  });

  test("FAILURE INJECTION: a savings-repository failure inside the transaction leaves NO record and NO audit event", async () => {
    const scenario = await seedSavingsScenario(harness, {
      name: "AC-07 Failure Pool",
    });
    const ctx = poolCreatorCtx(harness, "w027-ac07-failure");

    // Rebuild the REAL repositories + neutral lookups over the same
    // authority (the W026 injection precedent), with ONE injected
    // failure: the savings-repository write.
    const authority = harness.runtime.postgresAuthority;
    const realBaselineRepo: ProcurementBaselineRepository =
      createAuthorityProcurementBaselineRepository({ authority });
    const realSavingsRepo: ProcurementSavingsRepository =
      createAuthorityProcurementSavingsRepository({ authority });
    const realPoolRepo =
      createAuthorityProcurementPoolRepository({ authority });
    const realSelectionRepo =
      createAuthorityCompetitiveSelectionRepository({ authority });
    const realEvidenceRepo = createAuthorityEvidenceRepository({ authority });
    const realObservationRepo =
      createAuthorityOutcomeObservationRepository({ authority });
    const failingSavingsRepo: ProcurementSavingsRepository = {
      ...realSavingsRepo,
      async createWithinTx(savings, tx) {
        void savings;
        void tx;
        throw new Error("injected savings write failure");
      },
    };
    const failingService: ProcurementSavingsService =
      createProcurementSavingsService({
        baselineRepository: realBaselineRepo,
        savingsRepository: failingSavingsRepo,
        poolRepository: realPoolRepo,
        selectionRepository: realSelectionRepo,
        membershipLookup: {
          async resolveMembership() {
            return "active";
          },
        },
        evidenceLookup: {
          async resolve(evidenceId) {
            const record = await realEvidenceRepo.findById(evidenceId);
            if (!record) return null;
            return {
              id: record.id,
              organizationScopeId: record.organizationScopeId,
              subjectId: record.subjectReference.subjectId,
              subjectType: record.subjectReference.subjectType,
              sourceType: record.provenance.sourceType,
            };
          },
        },
        outcomeLookup: {
          async resolve(observationId) {
            const record = await realObservationRepo.findById(observationId);
            if (!record) return null;
            const corrections =
              await realObservationRepo.findByCorrectionOf(observationId);
            return {
              id: record.id,
              organizationScopeId: record.organizationScopeId,
              subjectId: record.subjectReference.subjectId,
              subjectType: record.subjectReference.subjectType,
              outcomeType: record.outcomeType,
              observedValue: {
                value: record.observedValue.value,
                unit: record.observedValue.unit,
              },
              confidence: record.confidence,
              provenance: {
                sourceType: record.provenance.sourceType,
                collectedAt: record.provenance.collectedAt,
              },
              correctsObservationId: record.correctsObservationId,
              supersededByObservationId:
                corrections.map((correction) => correction.id).sort()[0] ??
                null,
            };
          },
        },
        idempotency: harness.runtime.idempotency,
        auditWriter: harness.runtime.auditWriter,
        logger: harness.runtime.logger.forModule("demand"),
      });

    await expect(
      failingService.recordProcurementSavings(ctx, {
        organizationScopeId: harness.organizationScopeId,
        poolId: scenario.poolId,
        baselineId: scenario.baseline.id,
        outcomeObservationIds: [scenario.observation.id],
        idempotencyKey: key("w027-ac07-failure"),
      }),
    ).rejects.toThrow("injected savings write failure");

    // No record, no audit event — the mutation and the audit buffer
    // rolled back together.
    const records = await harness.runtime.procurementSavingsService
      .listPoolSavings(ctx, {
        organizationScopeId: harness.organizationScopeId,
        poolId: scenario.poolId,
      });
    expect(records.length).toBe(0);
    const events = await harness.runtime.auditWriter.query({
      eventType: "procurement_savings.recorded",
    });
    const forThisPool = events.filter((event) => {
      const metadata = event.metadata as Record<string, unknown>;
      return metadata["poolId"] === scenario.poolId;
    });
    expect(forThisPool.length).toBe(0);
  });
});
