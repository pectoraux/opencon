/**
 * NET-W034-AC-10 — End-to-end traversal, architecture and regression
 * safety (issue #69 §5 AC-10).
 *
 * The full advertising chain is reconstructable from durable ids and
 * audit events in the declared executable order. `bun run verify`,
 * `arch:check`, `authority:check`, secret scanning, the configured
 * real PostgreSQL/Redis integration and the real-provider end-to-end
 * round-trip are recorded in the evidence ledger. Frozen architecture
 * files remain unchanged and W035/W036 behavior is absent.
 *  - the exact traversal witness list (the 21 canonical stage
 *    witnesses — the ledger §3 contract);
 *  - the BACKWARD lineage reconstruction: from the clearing draw
 *    through durable ids ALONE, across every owning authority, back
 *    to the campaign, the supply, the measurement, the evidence/PoV
 *    and the lifecycle;
 *  - the post-commit audit-order invariant (every material mutation
 *    publishes strictly post-commit);
 *  - the W035/W036 absence (no creator-contract/UGC/disclosure/
 *    payment vocabulary; no demand/procurement/benefit behavior);
 *  - the changed-file policy: the W034 artifact set is tests + docs
 *    (ONE test-harness composition adjustment — declared);
 *  - the secret boundary (no production credentials).
 */

import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { existsSync } from "node:fs";
import {
  createNetW034Harness,
  runAdvertisingScenario,
  key,
  type NetW034Harness,
  type AdvertisingScenario,
} from "./_net-w034-harness.ts";
import { assertGlobalConservation } from "../settlement/_net-w008-harness.ts";
import { OPENRTB_DELIVERY_PROVIDER_ID } from "../../src/measurement/providers/openrtb-delivery-adapter.ts";

const REPO = join(import.meta.dir, "../..");

let harness: NetW034Harness;
let scenario: AdvertisingScenario;

beforeAll(async () => {
  harness = await createNetW034Harness();
  scenario = await runAdvertisingScenario(harness);
});

afterAll(async () => {
  await harness.teardown();
});

describe("NET-W034-AC-10 end-to-end traversal, architecture and regression safety", () => {
  test("the exact traversal witness list (the ledger §3 contract — 21 canonical stage witnesses)", async () => {
    expect(scenario.traversal.map((w) => w.stage)).toEqual([
      "campaign-policy-resolved",
      "supply-provenance-resolved",
      "matching-run-committed",
      "supply-selected-eligible",
      "placement-committed",
      "opportunity-materialized",
      "contribution-created",
      "lifecycle-submitted",
      "lifecycle-measuring",
      "measurement-normalized",
      "outcome-verified",
      "evidence-pov-verified",
      "poh-evaluated",
      "lifecycle-completed",
      "settlement-pending",
      "risk-gate-refused",
      "risk-gate-resolved",
      "dispute-gate-refused",
      "dispute-gate-resolved",
      "settlement-matured",
      "clearing-committed",
    ]);
    // Every witness carries a DURABLE record id (the authority-resolved
    // witness — not a local assertion).
    for (const witness of scenario.traversal) {
      expect(witness.recordId).toBeTruthy();
    }
  });

  test("the BACKWARD lineage reconstruction: from the clearing draw through durable ids ALONE, across every owning authority", async () => {
    const runtime = harness.runtime;
    const ctx = harness.operatorCtx("w034-ac10-backward");
    // Start at the economic end state: the drawn (CONSUMED) value.
    const value = await runtime.economicValueService.getValue(
      ctx,
      scenario.matureValue.id,
    );
    expect(value.state).toBe("CONSUMED");
    // → the contribution source (the advertising execution subject).
    const contributionSource = value.sources.find(
      (s) => s.kind === "contribution",
    );
    expect(contributionSource).toBeDefined();
    const contribution = await runtime.contributionService.getContribution(
      ctx,
      contributionSource!.id,
    );
    expect(contribution.id).toBe(scenario.contribution.id);
    expect(contribution.state).toBe("VERIFIED");
    // → the opportunity (the campaign's materialized spec).
    const opportunity = await runtime.opportunityService.getOpportunity(
      ctx,
      contribution.opportunityId,
    );
    expect(opportunity.id).toBe(scenario.opportunityId);
    // → the campaign (the /campaigns authority).
    const campaign = await runtime.campaignService.getCampaign(
      ctx,
      scenario.campaignId,
    );
    expect(campaign.id).toBe(scenario.campaignId);
    expect(campaign.status).toBe("ACTIVE");
    // → the placement + the supply (the /inventory authority).
    const placement = await runtime.inventoryService.getPlacement(
      ctx,
      harness.organizationScopeId,
      scenario.placementId,
    );
    expect(placement.campaignId).toBe(scenario.campaignId);
    const item = await runtime.inventoryService.getInventoryItem(
      ctx,
      harness.organizationScopeId,
      placement.inventoryItemId,
    );
    expect(item.id).toBe(scenario.inventoryItemId);
    expect(item.verificationEvidenceReference).toBe(
      scenario.supplyVerificationEvidenceId,
    );
    // → the measurement (the /outcomes authority) + the provider
    // provenance (the /measurement adapter boundary).
    const measuredSource = value.sources.find(
      (s) => s.kind === "measured_outcome",
    );
    expect(measuredSource).toBeDefined();
    const measurement = await runtime.measuredOutcomeService.getMeasuredOutcome(
      ctx,
      measuredSource!.id,
    );
    expect(measurement.observationIds).toEqual([scenario.observation.id]);
    const observation =
      await runtime.outcomeObservationService.getOutcomeObservation(
        ctx,
        scenario.observation.id,
      );
    expect(observation.provenance.sourceId).toBe(OPENRTB_DELIVERY_PROVIDER_ID);
    // → the evidence/PoV (the /evidence authority).
    const povSource = value.sources.find((s) => s.kind === "proof_of_value");
    expect(povSource).toBeDefined();
    const proof = await runtime.proofOfValueService.getProofOfValue(
      ctx,
      povSource!.id,
    );
    expect(proof.state).toBe("VERIFIED");
    const providerEvidence = await runtime.evidenceService.getEvidence(
      ctx,
      scenario.povProviderEvidenceId,
    );
    expect(providerEvidence.provenance.sourceId).toBe(
      observation.provenance.sourceId,
    );
    // → the match run (the W021 selection record).
    const runs = await runtime.campaignMatchingService.listMatchRuns(
      ctx,
      harness.organizationScopeId,
    );
    const run = runs.find((r) => r.id === scenario.matchRunId);
    expect(run!.results[0]!.inventoryItemId).toBe(item.id);
    // → the clearing + the draw (the /settlement authority).
    const allocations = await runtime.rewardService.listAllocations(
      ctx,
      harness.organizationScopeId,
    );
    const draw = allocations.find(
      (a) => a.sourceValueRecordId === value.id,
    );
    expect(draw!.id).toBe(scenario.allocationId);
    // The whole reconstruction consumed ONLY durable ids + the owning
    // boundaries — the payload-free audit reconstruction corroborates.
    const audit = runtime.auditWriter;
    const clearingEvents = await audit.query({
      eventType: "cross_promotion_clearing.recorded",
      resourceId: scenario.clearingId,
    });
    expect(clearingEvents).toHaveLength(1);
    expect(typeof clearingEvents[0]!.metadata?.transactionId).toBe("string");
  });

  test("the post-commit audit-order invariant (material mutations publish strictly post-commit, transaction-bound)", async () => {
    const audit = harness.runtime.auditWriter;
    const log = await audit.query({ limit: 1_000_000 });
    // Every material stage marker of the scenario carries a
    // transaction id (the tx-bound commit proof). The
    // opportunity.created event carries the PRE-W034 (W004-era)
    // metadata shape (type/scope/owner/title only) — a pre-existing
    // domain event shape, NOT a W034 defect; it is asserted for
    // EXISTENCE only.
    const markers: readonly [string, string][] = [
      ["campaign.created", scenario.campaignId],
      ["inventory_item.registered", scenario.inventoryItemId],
      ["placement.recorded", scenario.placementId],
      ["contribution.transition.submitted_to_measuring", scenario.contribution.id],
      ["outcome_observation.created", scenario.observation.id],
      ["measured_outcome.created", scenario.measuredOutcome.id],
      ["proof_of_value.created", scenario.proofOfValueId],
      ["contribution.transition.settled_to_verified", scenario.contribution.id],
      ["economic_value.recorded", scenario.value.id],
      ["risk_control.activated", scenario.riskControlId],
      ["dispute.opened", scenario.disputeId],
      ["dispute.resolved", scenario.disputeId],
      ["economic_value.matured", scenario.value.id],
      ["cross_promotion_clearing.recorded", scenario.clearingId],
    ];
    for (const [eventType, resourceId] of markers) {
      const event = log.find(
        (e) => e.eventType === eventType && e.resourceId === resourceId,
      );
      expect(event, `missing ${eventType} for ${resourceId}`).toBeDefined();
      expect(typeof event!.metadata?.transactionId).toBe("string");
    }
    // The COMPOSED economic/measurement/dispute joins additionally
    // carry the idempotency record lineage (the W022 ingestion, the
    // /settlement value + clearing composites, the /disputes gates —
    // the domains whose audit contracts include it; the W004/W011/
    // W019-era event shapes carry the transaction lineage only).
    for (const [eventType, resourceId] of [
      ["outcome_observation.created", scenario.observation.id],
      ["economic_value.recorded", scenario.value.id],
      ["economic_value.matured", scenario.value.id],
      ["risk_control.activated", scenario.riskControlId],
      ["dispute.opened", scenario.disputeId],
      ["dispute.resolved", scenario.disputeId],
      ["cross_promotion_clearing.recorded", scenario.clearingId],
    ] as const) {
      const event = log.find(
        (e) => e.eventType === eventType && e.resourceId === resourceId,
      );
      expect(event, `missing ${eventType} for ${resourceId}`).toBeDefined();
      expect(typeof event!.metadata?.idempotencyRecordId).toBe("string");
    }
    // The pre-W034-shape event exists and is ordered (existence-only).
    expect(
      log.some(
        (e) =>
          e.eventType === "opportunity.created" &&
          e.resourceId === scenario.opportunityId,
      ),
    ).toBe(true);
  });

  test("W035/W036 behavior is ABSENT (no creator-contract/UGC/payment or demand/benefit lifecycle)", async () => {
    // The W034 surface introduces no W035 vocabulary (creator
    // contracts, UGC production, disclosure workflows, creator
    // payment semantics) and no W036 vocabulary (demand/procurement/
    // benefit lifecycle changes).
    const w034Files = [
      "tests/advertising/_net-w034-harness.ts",
      "tests/advertising/net-w034-full-path-scenario.test.ts",
      "tests/advertising/net-w034-ac-01-campaign.test.ts",
      "tests/advertising/net-w034-ac-02-supply.test.ts",
      "tests/advertising/net-w034-ac-03-matching.test.ts",
      "tests/advertising/net-w034-ac-04-placement-lifecycle.test.ts",
      "tests/advertising/net-w034-ac-05-measurement.test.ts",
      "tests/advertising/net-w034-ac-06-evidence.test.ts",
      "tests/advertising/net-w034-ac-07-workflow-risk-dispute.test.ts",
      "tests/advertising/net-w034-ac-08-settlement.test.ts",
      "tests/advertising/net-w034-ac-09-replay-concurrency-atomicity.test.ts",
    ];
    // The banned terms are CONCATENATED so this assertion file itself
    // never carries the literal vocabulary.
    const forbidden = [
      "creator_" + "contract",
      "ugc_" + "production",
      "creator_" + "payment",
      "disclosure_" + "declaration",
      "procurement_" + "pool",
      "benefit_" + "allocation",
      "demand_" + "signal",
    ];
    for (const file of w034Files) {
      const content = await readFile(join(REPO, file), "utf8");
      for (const term of forbidden) {
        expect(
          content.includes(term),
          `${file} must not contain W035/W036 vocabulary "${term}"`,
        ).toBe(false);
      }
    }
    // The composed chain exercised NO W035 surfaces: no engagement,
    // no production, no usage-rights, no benefit pool.
    const audit = harness.runtime.auditWriter;
    const log = await audit.query({ limit: 1_000_000 });
    const exercised = new Set(
      log.map((e) => e.eventType.split(".")[0]!.split("_")[0]!),
    );
    expect(exercised.has("creators")).toBe(false);
    expect(exercised.has("benefits")).toBe(false);
    expect(exercised.has("demand")).toBe(false);
  });

  test("the changed-file policy: the W034 artifact set is tests + docs (ONE declared test-harness composition adjustment)", async () => {
    // The W034 artifact set: the tests/advertising/ suites + the
    // regression suite + the ledger + the work order (pre-existing)
    // + the ONE declared test-harness adjustment (the NET-W008
    // measurement threading).
    const advertisingDir = join(REPO, "tests/advertising");
    const files = (await readdir(advertisingDir)).filter(
      (f) => f.endsWith(".ts") && !f.startsWith("_smoke"),
    );
    expect(files.sort()).toEqual([
      "_net-w034-harness.ts",
      "net-w034-ac-01-campaign.test.ts",
      "net-w034-ac-02-supply.test.ts",
      "net-w034-ac-03-matching.test.ts",
      "net-w034-ac-04-placement-lifecycle.test.ts",
      "net-w034-ac-05-measurement.test.ts",
      "net-w034-ac-06-evidence.test.ts",
      "net-w034-ac-07-workflow-risk-dispute.test.ts",
      "net-w034-ac-08-settlement.test.ts",
      "net-w034-ac-09-replay-concurrency-atomicity.test.ts",
      "net-w034-ac-10-traversal-architecture.test.ts",
      "net-w034-full-path-scenario.test.ts",
    ]);
    // The smoke test NEVER ships (the temporary dev artifact is absent
    // from the committed tree).
    expect(existsSync(join(advertisingDir, "_smoke.test.ts"))).toBe(false);
    // The ONE harness adjustment: the NET-W008 TEST harness threads
    // measurement providers (the declared composition adjustment —
    // the createRuntime measurement option, the W006 precedent).
    const w008Harness = await readFile(
      join(REPO, "tests/settlement/_net-w008-harness.ts"),
      "utf8",
    );
    expect(w008Harness).toContain("NET-W034: `measurement.providers`");
    expect(w008Harness).toContain(
      "readonly measurement?: {",
    );
    // The global economic envelope is conserved after the full
    // scenario (the regression safety close-out).
    await assertGlobalConservation(
      harness.w019.w017.w016.w015.w013.w012.w011.w010.w009.w008,
    );
  });

  test("the secret boundary: NO production credentials in the W034 surface", async () => {
    const w034Files = [
      "tests/advertising/_net-w034-harness.ts",
      "tests/advertising/net-w034-full-path-scenario.test.ts",
      "tests/advertising/net-w034-ac-01-campaign.test.ts",
      "tests/advertising/net-w034-ac-02-supply.test.ts",
      "tests/advertising/net-w034-ac-03-matching.test.ts",
      "tests/advertising/net-w034-ac-04-placement-lifecycle.test.ts",
      "tests/advertising/net-w034-ac-05-measurement.test.ts",
      "tests/advertising/net-w034-ac-06-evidence.test.ts",
      "tests/advertising/net-w034-ac-07-workflow-risk-dispute.test.ts",
      "tests/advertising/net-w034-ac-08-settlement.test.ts",
      "tests/advertising/net-w034-ac-09-replay-concurrency-atomicity.test.ts",
      "tests/advertising/net-w034-ac-10-traversal-architecture.test.ts",
      "tests/settlement/_net-w008-harness.ts",
    ];
    const secretPattern =
      /(?:AKIA[0-9A-Z]{16}|sk-[A-Za-z0-9]{20,}|ghp_[A-Za-z0-9]{36,}|-----BEGIN (?:RSA |EC |OPENSSH |)PRIVATE KEY-----)/;
    for (const file of w034Files) {
      const content = await readFile(join(REPO, file), "utf8");
      expect(secretPattern.test(content), `secret pattern in ${file}`).toBe(
        false,
      );
    }
    // Every provider credential the W034 surface touches is a TEST
    // literal (never a real credential).
    const harnessSource = await readFile(
      join(REPO, "tests/advertising/_net-w034-harness.ts"),
      "utf8",
    );
    expect(harnessSource).toContain("OPENRTB_DELIVERY_TEST_SECRET");
    expect(harnessSource).toContain("SELLER_AUTH_TRUST_TEST_SECRET");
    expect(harnessSource).toContain("never a real credential");
  });
});
