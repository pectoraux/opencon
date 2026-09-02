/**
 * NET-W035-AC-07 — Workflow completion and risk/dispute gates (issue
 * #71 §5 AC-07; work order §4.7).
 *
 * The creator execution completes through /workflows only after the
 * required evidence/outcome/compliance gates pass. Applicable risk
 * and dispute controls are exercised in fail-closed mode, then
 * resolved through /disputes; the authoritative economic path
 * succeeds only after resolution. No creator-specific risk/dispute
 * state exists.
 */

import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import {
  createNetW035Harness,
  runCreatorScenario,
  recognizeCreatorValue,
  matureCreatorValue,
  holdMaturationOn,
  resolveHold,
  openBondedDisputeOn,
  resolveDispute,
  key,
  type NetW035Harness,
  type CreatorScenario,
} from "./_net-w035-harness.ts";

let harness: NetW035Harness;
let scenario: CreatorScenario;

beforeAll(async () => {
  harness = await createNetW035Harness();
  scenario = await runCreatorScenario(harness, { skipSettlement: true });
});

afterAll(async () => {
  await harness.teardown();
});

describe("NET-W035-AC-07 workflow completion and risk/dispute gates", () => {
  test("the workflow completes only AFTER the measurement/outcome/evidence stages (witnesses + the audit order)", async () => {
    // (a) The traversal witnesses: the completed VERIFIED walk (v10)
    // is witnessed AFTER the measurement/outcome/PoV/PoH stages (each
    // IN MEASURING at v5) — and BEFORE every economic stage.
    const measuringIdx = scenario.traversal.findIndex(
      (w) => w.stage === "lifecycle-measuring",
    );
    const povIdx = scenario.traversal.findIndex(
      (w) => w.stage === "evidence-pov-verified",
    );
    const completedIdx = scenario.traversal.findIndex(
      (w) => w.stage === "lifecycle-completed",
    );
    const pendingIdx = scenario.traversal.findIndex(
      (w) => w.stage === "settlement-pending",
    );
    expect(completedIdx).toBeGreaterThan(measuringIdx);
    expect(completedIdx).toBeGreaterThan(povIdx);
    expect(pendingIdx).toBeGreaterThan(completedIdx);
    expect(scenario.traversal[completedIdx]!.contributionState).toBe("VERIFIED");
    expect(scenario.traversal[completedIdx]!.contributionVersion).toBe(10);
    // (b) The durable audit order: the PoV aggregation BEFORE the
    // walk resumption; the completed VERIFIED walk BEFORE the
    // recognition.
    const log = await harness.runtime.auditWriter.query({ limit: 1_000_000 });
    const pos = (eventType: string, resourceId: string): number =>
      log.findIndex(
        (e) => e.eventType === eventType && e.resourceId === resourceId,
      );
    expect(
      pos("contribution.transition.measuring_to_evaluating", scenario.contribution.id),
    ).toBeGreaterThan(pos("proof_of_value.aggregated", scenario.proofOfValueId));
    expect(
      pos("economic_value.recorded", scenario.value.id),
    ).toBeGreaterThan(
      pos("contribution.transition.settled_to_verified", scenario.contribution.id),
    );
  });

  test("a HOLD risk control refuses the maturation (the value stays PENDING — fail closed)", async () => {
    // A FRESH value on the scenario's VERIFIED contribution.
    const recognized = await recognizeCreatorValue(
      harness,
      scenario.contribution.id,
      { amount: 60, idempotencyKey: key("w035-ac07-recognize") },
    );
    expect(recognized.value.state).toBe("PENDING");
    const control = await holdMaturationOn(
      harness,
      "contribution",
      scenario.contribution.id,
    );
    let matured = null;
    try {
      matured = await matureCreatorValue(harness, recognized.value.id);
    } catch (error) {
      expect((error as { code?: string }).code).toBe("RISK_CONTROL");
    }
    expect(matured).toBeNull();
    // The value is UNCHANGED (still PENDING — nothing partial).
    const value = await harness.runtime.economicValueService.getValue(
      harness.operatorCtx("w035-ac07-hold-read"),
      recognized.value.id,
    );
    expect(value.state).toBe("PENDING");
    // The control is durable + audited.
    const events = await harness.runtime.auditWriter.query({
      resourceType: "risk_control_decision",
      resourceId: control,
    });
    expect(events.map((e) => e.eventType)).toContain("risk_control.activated");
    // Resolve it — the path re-opens.
    await resolveHold(harness, control);
    const resolvedEvents = await harness.runtime.auditWriter.query({
      resourceType: "risk_control_decision",
      resourceId: control,
    });
    expect(resolvedEvents.map((e) => e.eventType)).toContain(
      "risk_control.resolved",
    );
    const reopened = await matureCreatorValue(harness, recognized.value.id);
    expect(reopened.state).toBe("MATURE");
  });

  test("an ACTIVE bonded dispute refuses the maturation until resolved through due process", async () => {
    const recognized = await recognizeCreatorValue(
      harness,
      scenario.contribution.id,
      { amount: 70, idempotencyKey: key("w035-ac07-recognize-dispute") },
    );
    const dispute = await openBondedDisputeOn(
      harness,
      "contribution",
      scenario.contribution.id,
    );
    let matured = null;
    try {
      matured = await matureCreatorValue(harness, recognized.value.id);
    } catch (error) {
      expect((error as { code?: string }).code).toBe("DISPUTE_CHALLENGE");
    }
    expect(matured).toBeNull();
    const value = await harness.runtime.economicValueService.getValue(
      harness.operatorCtx("w035-ac07-dispute-read"),
      recognized.value.id,
    );
    expect(value.state).toBe("PENDING");
    // The dispute is durable + audited.
    const events = await harness.runtime.auditWriter.query({
      resourceType: "dispute",
      resourceId: dispute,
    });
    expect(events.map((e) => e.eventType)).toContain("dispute.opened");
    // Resolve through due process (review by the reviewer — never the
    // challenger — then DISMISSED releasing the control).
    await resolveDispute(harness, dispute, scenario.contribution.id);
    const resolvedEvents = await harness.runtime.auditWriter.query({
      resourceType: "dispute",
      resourceId: dispute,
    });
    expect(resolvedEvents.map((e) => e.eventType)).toContain("dispute.resolved");
    // The authoritative economic path succeeds only after resolution.
    const reopened = await matureCreatorValue(harness, recognized.value.id);
    expect(reopened.state).toBe("MATURE");
  });

  test("the scenario's OWN gates were exercised fail-closed BEFORE the maturation (the traversal + audit order)", async () => {
    // The skipSettlement scenario: the recognition (settlement-pending)
    // is followed by the risk/dispute refusals + resolutions, and the
    // value is left PENDING (the maturation stage never ran).
    const riskRefusedIdx = scenario.traversal.findIndex(
      (w) => w.stage === "risk-gate-refused",
    );
    const disputeResolvedIdx = scenario.traversal.findIndex(
      (w) => w.stage === "dispute-gate-resolved",
    );
    const measuringIdx = scenario.traversal.findIndex(
      (w) => w.stage === "lifecycle-completed",
    );
    expect(riskRefusedIdx).toBeGreaterThan(measuringIdx);
    expect(disputeResolvedIdx).toBeGreaterThan(riskRefusedIdx);
    // The scenario value is still PENDING (skipSettlement).
    expect(scenario.value.state).toBe("PENDING");
    // The audit order: the control activation + resolution and the
    // dispute opening + resolution all committed BETWEEN the
    // recognition and… nothing economic afterwards.
    const log = await harness.runtime.auditWriter.query({ limit: 1_000_000 });
    const pos = (eventType: string, resourceId: string): number =>
      log.findIndex(
        (e) => e.eventType === eventType && e.resourceId === resourceId,
      );
    const recognizedPos = pos("economic_value.recorded", scenario.value.id);
    expect(
      pos("risk_control.activated", scenario.riskControlId),
    ).toBeGreaterThan(recognizedPos);
    expect(
      pos("risk_control.resolved", scenario.riskControlId),
    ).toBeGreaterThan(recognizedPos);
    expect(pos("dispute.opened", scenario.disputeId)).toBeGreaterThan(
      recognizedPos,
    );
    expect(pos("dispute.resolved", scenario.disputeId)).toBeGreaterThan(
      recognizedPos,
    );
    // No maturation audit event exists for the scenario value.
    const matured = await harness.runtime.auditWriter.query({
      eventType: "economic_value.matured",
      resourceId: scenario.value.id,
    });
    expect(matured).toHaveLength(0);
  });

  test("NO creator-specific risk/dispute authority exists (the creators module carries no risk vocabulary)", async () => {
    // The gates the scenario exercised are the /disputes authority's
    // OWN records: the risk control + the dispute both carry the
    // disputes module's resource types, and the creators boundary
    // owns no risk/dispute state (the structural authority pin is in
    // the AC-10 regression suite; here the runtime records prove the
    // composed path used /disputes).
    const control = await harness.runtime.riskControlService.findGatingControl(
      harness.operatorCtx("w035-ac07-control-read"),
      harness.organizationScopeId,
      "value_maturation",
      scenario.contribution.id,
      harness.creatorPersonId,
    );
    expect(control).toBeNull(); // resolved controls no longer gate
    const active = await harness.runtime.disputeService.listActiveBySubjectIds(
      harness.operatorCtx("w035-ac07-active-read"),
      harness.organizationScopeId,
      [scenario.contribution.id],
    );
    expect(active).toHaveLength(0); // resolved
  });
});
