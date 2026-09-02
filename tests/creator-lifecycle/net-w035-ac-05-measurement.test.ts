/**
 * NET-W035-AC-05 — Measurement and normalized outcomes (issue #71 §5
 * AC-05; work order §4.5).
 *
 * The execution reaches authoritative MEASURING before measurement
 * acceptance. A deterministic creator measurement report traverses
 * the real /measurement provider-selection path into /outcomes,
 * preserving provider provenance, attribution semantics and
 * uncertainty. Raw provider payloads/secrets/unnecessary personal
 * identifiers do not escape approved boundaries.
 */

import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import {
  createNetW035Harness,
  runCreatorScenario,
  submitCreatorMeasurement,
  key,
  type NetW035Harness,
  type CreatorScenario,
} from "./_net-w035-harness.ts";
import { rawDeliveryNotice, OPENRTB_DELIVERY_TEST_SECRET } from "../adapters/_net-w023-harness.ts";
import { signRawReport } from "../measurement/_net-w022-harness.ts";
import { OPENRTB_DELIVERY_PROVIDER_ID } from "../../src/measurement/providers/openrtb-delivery-adapter.ts";

let harness: NetW035Harness;
let scenario: CreatorScenario;

beforeAll(async () => {
  harness = await createNetW035Harness();
  scenario = await runCreatorScenario(harness, { skipSettlement: true });
});

afterAll(async () => {
  await harness.teardown();
});

describe("NET-W035-AC-05 measurement and normalized outcomes", () => {
  test("the contribution reaches MEASURING (v5) BEFORE the measurement observation (witnesses + audit order)", async () => {
    // (a) The scenario's own traversal witnesses: the measurement +
    // outcome + PoV stages were each witnessed IN MEASURING at v5.
    const measuringIdx = scenario.traversal.findIndex(
      (w) => w.stage === "lifecycle-measuring",
    );
    const measurementIdx = scenario.traversal.findIndex(
      (w) => w.stage === "measurement-normalized",
    );
    const outcomeIdx = scenario.traversal.findIndex(
      (w) => w.stage === "outcome-verified",
    );
    expect(measuringIdx).toBeGreaterThanOrEqual(0);
    expect(measurementIdx).toBeGreaterThan(measuringIdx);
    expect(outcomeIdx).toBeGreaterThan(measuringIdx);
    for (const idx of [measurementIdx, outcomeIdx]) {
      expect(scenario.traversal[idx]!.contributionState).toBe("MEASURING");
      expect(scenario.traversal[idx]!.contributionVersion).toBe(5);
    }
    // (b) The durable audit order: the MEASURING transition committed
    // BEFORE the observation.
    const log = await harness.runtime.auditWriter.query({ limit: 1_000_000 });
    const measuringPos = log.findIndex(
      (e) =>
        e.eventType === "contribution.transition.submitted_to_measuring" &&
        e.resourceId === scenario.contribution.id,
    );
    const observationPos = log.findIndex(
      (e) =>
        e.eventType === "outcome_observation.created" &&
        e.resourceId === scenario.observation.id,
    );
    expect(measuringPos).toBeGreaterThanOrEqual(0);
    expect(observationPos).toBeGreaterThan(measuringPos);
  });

  test("the observation preserves provider provenance, attribution semantics and uncertainty", async () => {
    const observation =
      await harness.runtime.outcomeObservationService.getOutcomeObservation(
        harness.creatorCtx("w035-ac05-observation"),
        scenario.observation.id,
      );
    expect(observation.provenance.sourceType).toBe("provider");
    expect(observation.provenance.sourceId).toBe(OPENRTB_DELIVERY_PROVIDER_ID);
    expect(observation.outcomeType).toBe("view");
    expect(observation.subjectReference.subjectId).toBe(
      scenario.contribution.id,
    );
    expect(observation.subjectReference.subjectType).toBe("contribution");
    // The normalized value + confidence (uncertainty) cross the
    // boundary; the raw payload does not.
    expect(observation.observedValue.unit).toBe("impressions");
    expect(observation.confidence).toBeTruthy();
  });

  test("the provider-selection path is REAL (the wired adapter + the composed command)", async () => {
    // The registry carries the OpenRTB delivery-notice adapter (the
    // same object production would resolve by provider id).
    const providers = harness.runtime.measurementProviders ?? [];
    const provider = providers.find(
      (p) => p.info.provider === OPENRTB_DELIVERY_PROVIDER_ID,
    );
    expect(provider).toBeDefined();
    expect(provider!.info.kind).toBe("measurement");
    // A FRESH submission through the composed command resolves the
    // same provider and returns its version + the redacted names.
    const fresh = await submitCreatorMeasurement(
      harness,
      scenario.contribution.id,
      { idempotencyKey: key("w035-ac05-fresh") },
    );
    expect(fresh.providerId).toBe(OPENRTB_DELIVERY_PROVIDER_ID);
    expect(fresh.created).toBe(true);
    expect(fresh.redactedFieldNames).toContain("device");
    expect(fresh.redactedFieldNames).toContain("user");
    expect(fresh.redactedFieldNames).toContain("vendorExtensions");
    expect(fresh.redactedFieldNames).toContain("integrity");
  });

  test("PRIVACY: raw vendor payload values appear in NEITHER the observation, the audit events, nor any persisted surface", async () => {
    // The sensitive values carried by the RAW delivery notice fixture.
    const rawSecrets = [
      "opaque-device-id-123",
      "opaque-user-id-456",
    ];
    // (a) The normalized observation carries none of them.
    const observation =
      await harness.runtime.outcomeObservationService.getOutcomeObservation(
        harness.creatorCtx("w035-ac05-privacy"),
        scenario.observation.id,
      );
    const serialized = JSON.stringify(observation);
    for (const secret of rawSecrets) {
      expect(serialized).not.toContain(secret);
    }
    // (b) The audit log carries none of them.
    const log = await harness.runtime.auditWriter.query({ limit: 1_000_000 });
    const auditSerialized = JSON.stringify(
      log.filter((e) => e.resourceId === scenario.observation.id),
    );
    for (const secret of rawSecrets) {
      expect(auditSerialized).not.toContain(secret);
    }
    // (c) No persisted collection in the authority carries them.
    for (const collection of ["outcome_observations", "idempotency"]) {
      const scan = await harness.runtime.postgresAuthority.scan(collection);
      const scanSerialized = JSON.stringify(scan);
      for (const secret of rawSecrets) {
        expect(scanSerialized).not.toContain(secret);
      }
    }
    // (d) Only the redacted field NAMES crossed the boundary.
    expect(scenario.measurementRedactedFieldNames).toContain("device");
    expect(scenario.measurementRedactedFieldNames).toContain("user");
  });

  test("a TAMPERED delivery notice fails closed (unverifiable integrity — nothing persisted)", async () => {
    const notice = rawDeliveryNotice();
    const integrity = (notice["integrity"] ?? {}) as {
      readonly signature: string;
    };
    const flipped = integrity.signature.startsWith("0")
      ? integrity.signature.replace(/^0/, "1")
      : integrity.signature.replace(/^./, "0");
    const tampered = {
      ...notice,
      integrity: { ...integrity, signature: flipped },
    };
    await expect(
      submitCreatorMeasurement(harness, scenario.contribution.id, {
        notice: tampered,
        idempotencyKey: key("w035-ac05-tampered"),
      }),
    ).rejects.toMatchObject({
      code: "MEASUREMENT_REPORT_REJECTED",
      context: expect.objectContaining({
        reason: "unverifiable_integrity",
      }),
    });
    // Nothing was persisted: the rejected report has no observation.
    const audit = harness.runtime.auditWriter;
    const events = await audit.query({
      eventType: "outcome_observation.created",
    });
    expect(
      events.filter(
        (e) =>
          (e.metadata?.idempotencyRecordId as string | undefined) ===
          key("w035-ac05-tampered"),
      ),
    ).toHaveLength(0);
  });

  test("a notice signed with the WRONG key fails closed (the integrity envelope gate)", async () => {
    // Build a notice and re-sign it with a DIFFERENT secret than the
    // adapter's verification secret.
    const notice = rawDeliveryNotice();
    const { integrity: _drop, ...body } = notice;
    void _drop;
    const wrongKeyNotice = {
      ...body,
      integrity: signRawReport(
        body as Record<string, unknown>,
        `test-openrtb-delivery-WRONG-${OPENRTB_DELIVERY_TEST_SECRET}`,
      ),
    };
    await expect(
      submitCreatorMeasurement(harness, scenario.contribution.id, {
        notice: wrongKeyNotice,
        idempotencyKey: key("w035-ac05-wrong-key"),
      }),
    ).rejects.toMatchObject({
      code: "MEASUREMENT_REPORT_REJECTED",
      context: expect.objectContaining({
        reason: "unverifiable_integrity",
      }),
    });
  });

  test("an UNKNOWN provider fails closed (no adapter bypass into /outcomes)", async () => {
    await expect(
      harness.runtime.apiCommands.submitMeasurementReport(
        harness.operatorCtx("w035-ac05-unknown"),
        harness.operatorPersonId,
        {
          organizationScopeId: harness.organizationScopeId,
          subjectReference: {
            subjectId: scenario.contribution.id,
            subjectType: "contribution",
          },
          idempotencyKey: key("w035-ac05-unknown"),
          providerId: "no-such-provider",
          report: rawDeliveryNotice(),
        },
      ),
    ).rejects.toMatchObject({
      code: "UNKNOWN_MEASUREMENT_PROVIDER",
    });
  });
});
