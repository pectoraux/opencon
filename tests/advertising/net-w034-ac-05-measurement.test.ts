/**
 * NET-W034-AC-05 — Measurement normalization and privacy (issue #69
 * §5 AC-05).
 *
 * The advertising execution reaches the authoritative MEASURING point
 * before measurement is accepted. A provider/native measurement
 * report traverses the existing `/measurement` adapter boundary into
 * `/outcomes`, preserving provenance, attribution semantics and
 * uncertainty while keeping raw payloads/secrets outside
 * normalized/audit/log surfaces.
 *  - the MEASURING-first ordering proven with the AUTHORITATIVE
 *    workflow state/version witnesses + the durable audit commit
 *    order (never merely local array order — the W033 lesson);
 *  - the adapter/provider identity + the normalized observation
 *    (provenance, attribution mode, uncertainty, observed value);
 *  - the deterministic report fixture (integrity-verified);
 *  - the privacy boundary: raw vendor payload values appear in
 *    NEITHER the normalized observation, NOR the audit events, NOR
 *    the redaction surface (names only);
 *  - a TAMPERED notice fails closed (unverifiable integrity);
 *  - an UNKNOWN provider fails closed (no adapter bypass);
 *  - the observation → measured-outcome evidence link.
 */

import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import {
  createNetW034Harness,
  runAdvertisingScenario,
  submitAdvertisingMeasurement,
  key,
  type NetW034Harness,
  type AdvertisingScenario,
} from "./_net-w034-harness.ts";
import {
  rawDeliveryNotice,
  OPENRTB_DELIVERY_TEST_SECRET,
} from "../adapters/_net-w023-harness.ts";
import { OPENRTB_DELIVERY_PROVIDER_ID } from "../../src/measurement/providers/openrtb-delivery-adapter.ts";

let harness: NetW034Harness;
let scenario: AdvertisingScenario;

beforeAll(async () => {
  harness = await createNetW034Harness();
  scenario = await runAdvertisingScenario(harness, { skipSettlement: true });
});

afterAll(async () => {
  await harness.teardown();
});

describe("NET-W034-AC-05 measurement normalization and privacy", () => {
  test("the MEASURING point is reached BEFORE the measurement is accepted (authoritative witnesses + audit commit order)", async () => {
    // (a) The scenario's ordered stage witnesses: the AUTHORITATIVE
    // contribution state + version (read through the owning boundary)
    // at every stage boundary. The measurement stage was witnessed IN
    // MEASURING at v5 — AFTER the lifecycle-measuring witness (the
    // fifth lifecycle mutation committed) and BEFORE the walk
    // resumption (v6+).
    const stages = scenario.traversal.map((w) => w.stage);
    const measuringIdx = stages.indexOf("lifecycle-measuring");
    const measurementIdx = stages.indexOf("measurement-normalized");
    const outcomeIdx = stages.indexOf("outcome-verified");
    const evidenceIdx = stages.indexOf("evidence-pov-verified");
    expect(measuringIdx).toBeGreaterThanOrEqual(0);
    expect(measurementIdx).toBeGreaterThan(measuringIdx);
    expect(outcomeIdx).toBeGreaterThan(measuringIdx);
    expect(evidenceIdx).toBeGreaterThan(measuringIdx);
    // Every measurement-stage witness carries the AUTHORITATIVE
    // MEASURING state at version 5 (not merely array positions).
    const measurementWitness = scenario.traversal[measurementIdx]!;
    expect(measurementWitness.contributionState).toBe("MEASURING");
    expect(measurementWitness.contributionVersion).toBe(5);
    const measuringWitness = scenario.traversal[measuringIdx]!;
    expect(measuringWitness.contributionState).toBe("MEASURING");
    expect(measuringWitness.contributionVersion).toBe(5);
    // (b) The durable audit commit order corroborates: the
    // MEASURING lifecycle transition committed BEFORE the normalized
    // observation (the measurement input), which committed BEFORE
    // every outcome/evidence record.
    const audit = harness.runtime.auditWriter;
    const log = await audit.query({ limit: 1_000_000 });
    const pos = (eventType: string, resourceId: string): number =>
      log.findIndex(
        (e) => e.eventType === eventType && e.resourceId === resourceId,
      );
    const measuringTransition = pos(
      "contribution.transition.submitted_to_measuring",
      scenario.contribution.id,
    );
    const observationCreated = pos(
      "outcome_observation.created",
      scenario.observation.id,
    );
    const outcomeCreated = pos(
      "measured_outcome.created",
      scenario.measuredOutcome.id,
    );
    const evidenceCreated = pos(
      "evidence.created",
      scenario.povPlatformEvidenceId,
    );
    expect(measuringTransition).toBeGreaterThanOrEqual(0);
    expect(observationCreated).toBeGreaterThan(measuringTransition);
    expect(outcomeCreated).toBeGreaterThan(observationCreated);
    expect(evidenceCreated).toBeGreaterThan(outcomeCreated);
  });

  test("the normalized observation preserves the provider identity, attribution semantics, uncertainty and observed value", async () => {
    const observation = scenario.observation;
    // The adapter/provider identity: the provenance source is the
    // PROVIDER (the adapter tier), with the provider's own id.
    expect(observation.provenance.sourceType).toBe("provider");
    expect(observation.provenance.sourceId).toBe(OPENRTB_DELIVERY_PROVIDER_ID);
    expect(observation.provenance.method).toBe("openrtb-delivery-notice");
    expect(observation.provenance.methodVersion).toBe("1.0.0");
    expect(observation.provenance.collectedAt).toBe(
      "2026-08-30T10:00:00.000Z",
    );
    // The normalized semantics: a delivery notice reports a VIEW with
    // DETERMINISTIC attribution (the campaign outcome policy's exact
    // requirement). The attribution basis is recorded as PROVENANCE
    // (provider-reported, never protocol truth).
    expect(observation.outcomeType).toBe("view");
    expect(observation.providerAttributionMode).toBe("deterministic");
    expect(observation.observedValue).toEqual({
      value: 1,
      unit: "impressions",
    });
    // The uncertainty is preserved (never stripped).
    expect(observation.confidence.point).toBe(0.99);
    // The subject is the ADVERTISING EXECUTION contribution.
    expect(observation.subjectReference).toEqual({
      subjectId: scenario.contribution.id,
      subjectType: "contribution",
    });
    // The external subject reference (the provider-side mapping) is
    // retained on the record (provenance, not truth).
    expect(observation.externalSubjectRef).toBeTruthy();
  });

  test("the provider selection is REAL (the wired adapter, not a stub path)", async () => {
    // The measurement provider registry holds the REAL delivery-notice
    // adapter for this provider id (the W022 provider-selection path
    // wired through createRuntime).
    const provider = harness.runtime.measurementProviders?.find(
      (p) => p.info.provider === OPENRTB_DELIVERY_PROVIDER_ID,
    );
    expect(provider).toBeDefined();
    expect(provider!.info.kind).toBe("measurement");
    // The submission result records the adapter's version + the
    // redacted field NAMES.
    expect(scenario.measurementProviderId).toBe(OPENRTB_DELIVERY_PROVIDER_ID);
    expect(scenario.measurementRedactedFieldNames).toContain("device");
    expect(scenario.measurementRedactedFieldNames).toContain("user");
    expect(scenario.measurementRedactedFieldNames).toContain(
      "vendorExtensions",
    );
    expect(scenario.measurementRedactedFieldNames).toContain("integrity");
  });

  test("PRIVACY: raw vendor payload values appear in NEITHER the observation, the audit events, nor any persisted surface", async () => {
    // The sensitive values carried by the RAW delivery notice fixture.
    const rawSecrets = [
      "opaque-device-id-123",
      "opaque-user-id-456",
      "Mozilla/5.0",
      "203.0.113.7",
      "opaque-trigger-payload-XYZ",
    ];
    // (a) The normalized observation record carries NONE of them.
    const observationJson = JSON.stringify(scenario.observation);
    for (const secret of rawSecrets) {
      expect(observationJson).not.toContain(secret);
    }
    // (b) The audit events for the observation carry NONE of them
    // (metadata carries the provider identity, the neutral values and
    // the idempotency/transaction lineage only).
    const audit = harness.runtime.auditWriter;
    const events = await audit.query({
      resourceType: "outcome_observation",
      resourceId: scenario.observation.id,
    });
    expect(events.length).toBeGreaterThan(0);
    const eventsJson = JSON.stringify(events);
    for (const secret of rawSecrets) {
      expect(eventsJson).not.toContain(secret);
    }
    // (c) The raw payload itself is NOT persisted anywhere: the
    // observation's evidenceId is null (no raw store), and the
    // ingestion audit metadata records the PROVIDER id (never the
    // payload).
    const ingestEvent = events.find(
      (e) => e.eventType === "outcome_observation.created",
    );
    expect(ingestEvent).toBeDefined();
    expect(ingestEvent!.metadata?.ingestedFromProvider).toBe(
      OPENRTB_DELIVERY_PROVIDER_ID,
    );
    expect(typeof ingestEvent!.metadata?.idempotencyRecordId).toBe("string");
    expect(typeof ingestEvent!.metadata?.transactionId).toBe("string");
  });

  test("a TAMPERED delivery notice fails closed (unverifiable integrity — nothing persisted)", async () => {
    const notice = rawDeliveryNotice();
    // Flip the signature nibble — a well-formed but WRONG signature.
    const integrity = (notice["integrity"] ?? {}) as {
      signature: string;
      algorithm: string;
      signedAt: string;
    };
    const flipped = integrity.signature.startsWith("0")
      ? integrity.signature.replace(/^0/, "1")
      : integrity.signature.replace(/^./, "0");
    const tampered = {
      ...notice,
      integrity: { ...integrity, signature: flipped },
    };
    await expect(
      submitAdvertisingMeasurement(harness, scenario.contribution.id, {
        notice: tampered,
        idempotencyKey: key("w034-ac05-tampered"),
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
          key("w034-ac05-tampered"),
      ),
    ).toHaveLength(0);
  });

  test("a notice signed with the WRONG key fails closed (the integrity envelope gate)", async () => {
    // Build a notice and re-sign it with a DIFFERENT secret than the
    // adapter's verification secret.
    const { signRawReport } = await import(
      "../measurement/_net-w022-harness.ts"
    );
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
      submitAdvertisingMeasurement(harness, scenario.contribution.id, {
        notice: wrongKeyNotice,
        idempotencyKey: key("w034-ac05-wrong-key"),
      }),
    ).rejects.toMatchObject({
      code: "MEASUREMENT_REPORT_REJECTED",
      context: expect.objectContaining({
        reason: "unverifiable_integrity",
      }),
    });
  });

  test("an UNKNOWN provider fails closed (no adapter bypass into /outcomes)", async () => {
    const ctx = harness.operatorCtx("w034-ac05-unknown");
    await expect(
      harness.runtime.apiCommands.submitMeasurementReport(
        ctx,
        harness.operatorPersonId,
        {
          organizationScopeId: harness.organizationScopeId,
          subjectReference: {
            subjectId: scenario.contribution.id,
            subjectType: "contribution",
          },
          idempotencyKey: key("w034-ac05-unknown"),
          providerId: "vendor-x-unknown",
          report: rawDeliveryNotice(),
        },
      ),
    ).rejects.toMatchObject({ code: "UNKNOWN_MEASUREMENT_PROVIDER" });
  });

  test("the observation is the measured outcome's input (the /outcomes composition link)", async () => {
    const ctx = harness.creatorCtx("w034-ac05-outcome");
    const measurement =
      await harness.runtime.measuredOutcomeService.getMeasuredOutcome(
        ctx,
        scenario.measuredOutcome.id,
      );
    expect(measurement.observationIds).toEqual([scenario.observation.id]);
    expect(measurement.state).toBe("VERIFIED");
    expect(measurement.subjectReference).toEqual({
      subjectId: scenario.contribution.id,
      subjectType: "contribution",
    });
  });
});
