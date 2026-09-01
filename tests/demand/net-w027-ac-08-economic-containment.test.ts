/**
 * NET-W027 AC-08 — /settlement remains sole economic authority and W028
 * Benefit Pools remain out of scope: no /demand W027 code writes
 * economic state or bypasses /settlement; economic vocabulary,
 * ledger/credit/cash/reward surfaces and Benefit-Pool semantics
 * remain absent from the W027 paths; a verified savings claim is a
 * measurement decision, never an economic mutation (issue #54
 * acceptance criterion 8).
 *
 * Work order: spec/work-orders/NET-W027.md §4.6 / §7 AC-08.
 */

import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import {
  createNetW027Harness,
  seedSavingsScenario,
  recordSavings,
  type NetW027Harness,
} from "./_net-w027-harness.ts";
import { ECONOMIC_VALUE_SOURCES } from "../../src/core/economics.ts";

const REPO = join(import.meta.dir, "../..");
const SRC = join(REPO, "src");

const W027_FILES = [
  "src/core/procurement-savings.ts",
  "src/demand/port.ts",
  "src/demand/module.ts",
  "src/demand/authority-savings-repositories.ts",
  "src/demand/savings-engine.ts",
  "src/demand/savings-service.ts",
];

const DOMAIN_DIRS = [
  "identity", "organizations", "participants", "opportunities",
  "contributions", "campaigns", "inventory", "creators", "demand",
  "benefits", "reputation", "evidence", "outcomes", "settlement",
  "disputes", "workflows",
];

let harness: NetW027Harness;

beforeAll(async () => {
  harness = await createNetW027Harness();
});

afterAll(async () => {
  await harness.teardown();
});

describe("NET-W027-AC-08 economic-authority containment", () => {
  test("the W027 mutations emit ONLY procurement audit events — the audit vocabulary carries no economic surface", async () => {
    const scenario = await seedSavingsScenario(harness, {
      name: "AC-08 Audit Pool",
    });
    const savings = await recordSavings(harness, {
      poolId: scenario.poolId,
      baselineId: scenario.baseline.id,
      outcomeObservationIds: [scenario.observation.id],
    });

    const events = await harness.runtime.auditWriter.query({
      eventType: "procurement_savings.recorded",
      resourceId: savings.id,
    });
    expect(events.length).toBe(1);
    const metadata = events[0]!.metadata as Record<string, unknown>;
    // The savings audit metadata key surface: procurement +
    // measurement facts + provenance ONLY — no economic vocabulary.
    expect(Object.keys(metadata).sort()).toEqual([
      "baselineId",
      "baselineKind",
      "baselineValue",
      "checkCount",
      "confidence",
      "derivationPolicy",
      "digest",
      "evaluationAnchor",
      "idempotencyRecordId",
      "observationIds",
      "observedValue",
      "organizationScopeId",
      "poolId",
      "recordedBy",
      "savings",
      "selectionId",
      "supported",
      "transactionId",
    ]);
    const metadataJson = JSON.stringify(metadata);
    for (const economicTerm of [
      "credit",
      "ledger",
      "posting",
      "obligation",
      "payout",
      "reward",
      "stake",
      "balance",
      "benefitPool",
    ]) {
      expect(metadataJson.toLowerCase()).not.toContain(
        economicTerm.toLowerCase(),
      );
    }
  });

  test("the savings records/views carry measurement vocabulary ONLY — a verified savings claim is a MEASUREMENT DECISION, never an economic record", async () => {
    const scenario = await seedSavingsScenario(harness, {
      name: "AC-08 Surface Pool",
    });
    const record = await recordSavings(harness, {
      poolId: scenario.poolId,
      baselineId: scenario.baseline.id,
      outcomeObservationIds: [scenario.observation.id],
    });
    const recordJson = JSON.stringify(record).toLowerCase();
    for (const economicTerm of [
      '"credit',
      '"ledger',
      '"posting',
      '"obligation',
      '"payout',
      '"reward',
      '"stake',
      '"balance',
      '"benefitpool',
      '"allocatebenefit',
    ]) {
      expect(recordJson).not.toContain(economicTerm);
    }
  });

  test("the W027 commands create NO settlement-side audit events (zero economic side effects)", async () => {
    const scenario = await seedSavingsScenario(harness, {
      name: "AC-08 Settlement Pool",
    });
    await recordSavings(harness, {
      poolId: scenario.poolId,
      baselineId: scenario.baseline.id,
      outcomeObservationIds: [scenario.observation.id],
    });
    // The /settlement audit vocabulary (the economic authority's own
    // event types) carries NOTHING attributable to the W027
    // resources.
    const settlementEvents = await harness.runtime.auditWriter.query({
      eventType: "ledger.entry_posted",
    });
    const w027ResourceTypes = new Set([
      "procurement_baseline",
      "procurement_savings",
    ]);
    const contaminated = settlementEvents.filter((event) =>
      w027ResourceTypes.has(event.resourceType as string),
    );
    expect(contaminated).toEqual([]);
  });

  test("the frozen economic vocabulary is UNCHANGED: no savings/procurement economic source kind was minted (W028 stays the economic consumer)", async () => {
    // ECONOMIC_VALUE_SOURCES is exactly the pre-W027 frozen set — a
    // savings/procurement source kind would be an economic-authority
    // change (W028+ is the sanctioned consumer, never W027).
    expect([...ECONOMIC_VALUE_SOURCES]).toEqual([
      "proof_of_value",
      "measured_outcome",
      "evidence",
      "contribution",
    ]);
  });

  test("the W027 files carry NO economic-mutation vocabulary, NO lifecycle machinery and NO cross-domain imports (source-level containment)", async () => {
    for (const rel of W027_FILES) {
      const content = await readFile(join(REPO, rel), "utf8");
      // No economic mutation vocabulary (issue #54 architectural
      // constraints: /settlement stays the sole economic authority).
      expect(content).not.toMatch(/\bissueCredits\b/);
      expect(content).not.toMatch(/\bmatureEconomicValue\b/);
      expect(content).not.toMatch(/\ballocateRewards\b/);
      expect(content).not.toMatch(/\brecordCashObligation\b/);
      expect(content).not.toMatch(/\brecordPendingValue\b/);
      expect(content).not.toMatch(/\bcreateReputationInput\b/);
      expect(content).not.toMatch(/\bcreateRiskSignal\b/);
      // No lifecycle machinery (/workflows stays the sole lifecycle
      // authority: baseline invalidation is a one-way field mutation,
      // staleness/supersession are DERIVED at the anchor).
      expect(content).not.toMatch(/\bperformTransition\b/);
      expect(content).not.toMatch(/statusTransition\(/);
      expect(content).not.toMatch(/statusMachine\(/);
      // No domain imports outside itself/core (tier matrix).
      expect(content).not.toMatch(
        /from ["']\.\.\/(outcomes|campaigns|inventory|settlement|reputation|disputes|creators|workflows|evidence|benefits|opportunities|contributions|identity|organizations|participants|adapters|api|bootstrap|measurement|llm|agents|payments|ledger)\//,
      );
      // No W028 Benefit-Pool semantics.
      expect(content).not.toMatch(/\bbenefitPool\b/i);
      expect(content).not.toMatch(/\ballocateBenefit\b/);
    }
  });

  test("no OTHER domain carries the W027 savings command vocabulary (the /demand boundary owns it exclusively; /outcomes + /evidence keep their own measurement vocabulary)", async () => {
    for (const dir of DOMAIN_DIRS) {
      if (dir === "demand" || dir === "outcomes" || dir === "evidence") {
        // /outcomes owns the measurement vocabulary (observations,
        // baselines kinds); /evidence owns the outcome-type vocabulary
        // ("savings" is an OUT-001 value there) — those are NOT W027
        // command surfaces.
        continue;
      }
      const files = await readdir(join(SRC, dir));
      for (const file of files) {
        if (!file.endsWith(".ts")) continue;
        const content = await readFile(join(SRC, dir, file), "utf8");
        expect(
          content,
          `${dir}/${file} must not carry W027 savings command vocabulary`,
        ).not.toMatch(/\bcreateProcurementBaseline\b/);
        expect(content).not.toMatch(/\brecordProcurementSavings\b/);
        expect(content).not.toMatch(/\bevaluateProcurementSavings\b/);
        expect(content).not.toMatch(/\bProcurementSavingsService\b/);
        expect(content).not.toMatch(/\bProcurementBaselineRepository\b/);
      }
    }
    // The economic authority is untouched by W027 vocabulary.
    const settlementPort = await readFile(
      join(REPO, "src/settlement/port.ts"),
      "utf8",
    );
    expect(settlementPort).not.toMatch(/procurementSavings/);
    expect(settlementPort).not.toMatch(/procurementBaseline/);
    expect(settlementPort).not.toMatch(/verifiedSavings/);
    // The lifecycle authority is untouched by W027 vocabulary.
    const transitionTable = await readFile(
      join(REPO, "src/workflows/transition-table.ts"),
      "utf8",
    );
    expect(transitionTable).not.toMatch(/procurementSavings/i);
    expect(transitionTable).not.toMatch(/procurementBaseline/i);
  });
});
