/**
 * NET-W036 AC-05 — Measurement/outcomes (work order §5 AC-05 + the
 * frozen ledger §4): ONE deterministic realized outcome recorded
 * through the REAL provider boundary (`/measurement` → `/outcomes`)
 * while the fulfillment subject is at its MEASUREMENT POINT
 * (MEASURING), with provenance and uncertainty preserved and the raw
 * provider payload CONTAINED.
 *
 * The provider path is the REAL W022 composed command
 * (`runtime.apiCommands.submitMeasurementReport` → the
 * OpenRtbDeliveryNoticeAdapter — integrity verification, privacy
 * redaction, provider attribution — → `/outcomes` exactly-once
 * persistence + atomic audit), addressed to the FIXED provider id
 * with the harness's signed fixed-anchor notice.
 *
 * Mutation targets covered (ledger §4): accept before required
 * measurement point; strip uncertainty; leak raw provider data;
 * bypass adapter boundary.
 *
 * DETERMINISM (§3.1): fixed idempotency keys only (`w036-ac05-…`),
 * the harness's FIXED anchors — NO `Date.now(`, NO `randomUUID`, NO
 * `new Date(` code tokens in this file. ONE harness per file (the
 * W025/W026 AC-suite precedent); the deterministic re-run witness
 * builds its OWN fresh harness inside its test.
 */

import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import {
  createNetW036Harness,
  requestContributionTransition,
  w036DeliveryNotice,
  W036_NOTICE_COLLECTED_AT,
  type NetW036Harness,
} from "./_net-w036-harness.ts";
import { OPENRTB_DELIVERY_TEST_SECRET } from "../adapters/_net-w023-harness.ts";
import { signRawReport } from "../measurement/_net-w022-harness.ts";
import { OPENRTB_DELIVERY_PROVIDER_ID } from "../../src/measurement/providers/openrtb-delivery-adapter.ts";
import type {
  Contribution,
} from "../../src/contributions/port.ts";
import type {
  MeasuredOutcome,
  OutcomeObservation,
} from "../../src/outcomes/port.ts";
import type {
  ApiMeasurementReportSubmissionView,
} from "../../src/api/port.ts";

const REPO = join(import.meta.dir, "../..");

let harness: NetW036Harness;

/** The canonical AC-05 fulfillment subject (walked to MEASURING). */
let contribution: Contribution;
/** The canonical observation facts (the fixed-anchor provider path). */
let canonicalView: ApiMeasurementReportSubmissionView;
let canonicalObservation: OutcomeObservation;

beforeAll(async () => {
  harness = await createNetW036Harness();
}, 180_000);

afterAll(async () => {
  await harness.teardown();
});

// ---------------------------------------------------------------------------
// Deterministic fixtures (fixed keys; every seed its OWN pool — the
// AC-01..04 suite discipline)
// ---------------------------------------------------------------------------

/**
 * The canonical W036 fulfillment subject: qualified pool → supplier-A
 * offer → recorded competitive selection → opportunity → contribution
 * (the harness's runW036Scenario stage-7 construction), walked to the
 * MEASUREMENT POINT (MEASURING) through the sanctioned /workflows
 * transitions. Returns the fulfillment contribution.
 */
async function seedMeasuringFulfillmentSubject(
  poolKey: string,
  offerKey: string,
  selectionKey: string,
  observationPrefix: string,
): Promise<Contribution> {
  return seedMeasuringFulfillmentSubjectOn(
    harness,
    poolKey,
    offerKey,
    selectionKey,
    observationPrefix,
  );
}

/**
 * Submit ONE raw delivery notice through the REAL composed W022
 * measurement command (the provider-selection path production uses)
 * as the SUPPLIER A observer.
 */
async function submitNotice(
  report: unknown,
  idempotencyKey: string,
  subjectId: string,
): Promise<ApiMeasurementReportSubmissionView> {
  return harness.runtime.apiCommands.submitMeasurementReport(
    harness.supplierACtx("w036-ac05-measure"),
    harness.supplierAPersonId,
    {
      organizationScopeId: harness.organizationScopeId,
      subjectReference: { subjectId, subjectType: "contribution" },
      idempotencyKey,
      providerId: OPENRTB_DELIVERY_PROVIDER_ID,
      report,
    },
  );
}

/**
 * A SECOND deterministic signed notice carrying a QUANTIFIED
 * CONFIDENCE INTERVAL (constructed IN THIS FILE through the same real
 * signing primitive the provider side uses — a test-only literal
 * secret, never a real credential): proves the interval survives the
 * adapter normalization verbatim into /outcomes.
 */
function w036IntervalNotice(): Record<string, unknown> {
  const body: Record<string, unknown> = {
    noticeId: "w036-delivery-notice-002",
    requestRef: "w036-fulfillment-request-2",
    impressionRef: "1",
    subjectRefs: ["ext-w036-fulfillment-subject-2"],
    outcomeType: "view",
    observedValue: { value: 2, unit: "impressions" },
    confidence: { point: 0.9, lower: 0.85, upper: 0.95 },
    attributionMode: "deterministic",
    deterministicLink: "w036-fulfillment-request-2",
    method: "openrtb-delivery-notice",
    methodVersion: "1.0.0",
    collectedAt: W036_NOTICE_COLLECTED_AT,
    device: { ifa: "opaque-device-id-w036-b" },
    user: { id: "opaque-user-id-w036-b" },
    vendorExtensions: { experimentBucket: 8 },
  };
  return { ...body, integrity: signRawReport(body, OPENRTB_DELIVERY_TEST_SECRET) };
}

/** The opaque vendor identifiers the raw notices embed. */
const OPAQUE_VENDOR_VALUES = [
  "opaque-device-id-w036",
  "opaque-user-id-w036",
  "opaque-device-id-w036-b",
  "opaque-user-id-w036-b",
];

describe("NET-W036-AC-05 measurement/outcomes (provider boundary → /outcomes)", () => {
  test("PROVIDER IDENTITY + MEASUREMENT POINT: the fixed-anchor signed notice submitted at MEASURING through the composed provider boundary yields the provider-attributed, subject-bound, redacted observation in /outcomes", async () => {
    const runtime = harness.runtime;
    contribution = await seedMeasuringFulfillmentSubject(
      "w036-ac05-pool-canonical",
      "w036-ac05-offer-canonical",
      "w036-ac05-selection-canonical",
      "w036-ac05-canonical",
    );

    // The measurement point: the fulfillment subject is MEASURING v5
    // (read through the owning boundary) when the report is submitted.
    const atPoint = await runtime.contributionService.getContribution(
      harness.supplierACtx("w036-ac05-read-point"),
      contribution.id,
    );
    expect(atPoint.state).toBe("MEASURING");
    expect(atPoint.version).toBe(5);

    // The REAL composed provider path: provider id + fixed signed
    // notice, exactly-once under the fixed key.
    canonicalView = await submitNotice(
      w036DeliveryNotice(),
      "w036-ac05-observation",
      contribution.id,
    );
    expect(canonicalView.providerId).toBe(OPENRTB_DELIVERY_PROVIDER_ID);
    expect(canonicalView.providerVersion).toBe("1.0.0");
    expect(canonicalView.created).toBe(true);
    // The raw vendor fields were REDACTED at the adapter boundary —
    // the privacy-transparency summary is non-empty and reports the
    // sensitive vendor field NAMES (device/user/vendorExtensions) plus
    // the consumed-for-validation fields, never values.
    expect([...canonicalView.redactedFieldNames].sort()).toEqual([
      "deterministicLink",
      "device",
      "impressionRef",
      "integrity",
      "noticeId",
      "requestRef",
      "subjectRefs",
      "user",
      "vendorExtensions",
    ]);

    // The observation read back through the /outcomes owning boundary.
    canonicalObservation = await runtime.outcomeObservationService
      .getOutcomeObservation(
        harness.supplierACtx("w036-ac05-read-observation"),
        canonicalView.observation.id,
      );
    // Provider attribution + provenance: the provider identity is the
    // source; the provenance shape carries the notice-derived method,
    // methodVersion, collectedAt (the FIXED anchor) + the acting
    // collector.
    expect(canonicalObservation.provenance.sourceType).toBe("provider");
    expect(canonicalObservation.provenance.sourceId).toBe(
      OPENRTB_DELIVERY_PROVIDER_ID,
    );
    expect(canonicalObservation.provenance.method).toBe(
      "openrtb-delivery-notice",
    );
    expect(canonicalObservation.provenance.methodVersion).toBe("1.0.0");
    expect(canonicalObservation.provenance.collectedAt).toBe(
      W036_NOTICE_COLLECTED_AT,
    );
    expect(canonicalObservation.provenance.collectorId).toBe(
      harness.supplierAPersonId,
    );
    // Subject binding + attribution mode + provider-side reference.
    expect(canonicalObservation.subjectReference.subjectId).toBe(
      contribution.id,
    );
    expect(canonicalObservation.subjectReference.subjectType).toBe(
      "contribution",
    );
    expect(canonicalObservation.observerId).toBe(harness.supplierAPersonId);
    expect(canonicalObservation.providerAttributionMode).toBe("deterministic");
    expect(canonicalObservation.externalSubjectRef).toBe(
      "ext-w036-fulfillment-subject-1",
    );
    expect(canonicalObservation.outcomeType).toBe("view");
    expect(canonicalObservation.correctsObservationId).toBeNull();

    // THE MEASUREMENT POINT ORDERING (durable audit proof): the
    // subject's submitted_to_measuring transition PRECEDES the
    // observation's creation event in the global append-only log —
    // the report was accepted AT the sanctioned measurement point,
    // never before it.
    const log = await runtime.auditWriter.query({ limit: 1_000_000 });
    const measuringIndex = log.findIndex(
      (event) =>
        event.eventType === "contribution.transition.submitted_to_measuring" &&
        event.resourceId === contribution.id,
    );
    const observationIndex = log.findIndex(
      (event) =>
        event.eventType === "outcome_observation.created" &&
        event.resourceId === canonicalObservation.id,
    );
    expect(measuringIndex).toBeGreaterThanOrEqual(0);
    expect(observationIndex).toBeGreaterThanOrEqual(0);
    expect(observationIndex).toBeGreaterThan(measuringIndex);
    // The observation's own audit metadata attributes the provider.
    const observationEvents = await runtime.auditWriter.query({
      eventType: "outcome_observation.created",
      resourceId: canonicalObservation.id,
    });
    expect(observationEvents).toHaveLength(1);
    expect(observationEvents[0]!.metadata?.ingestedFromProvider).toBe(
      OPENRTB_DELIVERY_PROVIDER_ID,
    );
    expect(observationEvents[0]!.metadata?.pushedReportIngestion).toBe(true);
  }, 180_000);

  test("UNCERTAINTY PRESERVED: the notice-derived confidence estimate survives the normalization verbatim into /outcomes (point-only AND quantified-interval notices)", async () => {
    const runtime = harness.runtime;

    // (a) The canonical fixture notice carries a POINT estimate only
    //     ({point: 0.99}): the point survives VERBATIM and NO interval
    //     is fabricated (absence preserved — the adapter never coerces
    //     uncertainty into a made-up interval).
    expect(canonicalObservation.observedValue).toEqual({
      value: 1,
      unit: "impressions",
    });
    expect(canonicalObservation.confidence.point).toBe(0.99);
    expect(canonicalObservation.confidence.lower).toBeUndefined();
    expect(canonicalObservation.confidence.upper).toBeUndefined();

    // (b) A second deterministic notice carrying a QUANTIFIED
    //     interval: the interval survives VERBATIM (all three fields
    //     bit-identical into /outcomes).
    const intervalView = await submitNotice(
      w036IntervalNotice(),
      "w036-ac05-observation-interval",
      contribution.id,
    );
    const intervalObservation = await runtime.outcomeObservationService
      .getOutcomeObservation(
        harness.supplierACtx("w036-ac05-read-interval"),
        intervalView.observation.id,
      );
    expect(intervalObservation.observedValue).toEqual({
      value: 2,
      unit: "impressions",
    });
    expect(intervalObservation.confidence).toEqual({
      point: 0.9,
      lower: 0.85,
      upper: 0.95,
    });
    // Same provider attribution + fixed provenance anchor.
    expect(intervalObservation.provenance.sourceType).toBe("provider");
    expect(intervalObservation.provenance.sourceId).toBe(
      OPENRTB_DELIVERY_PROVIDER_ID,
    );
    expect(intervalObservation.provenance.method).toBe(
      "openrtb-delivery-notice",
    );
    expect(intervalObservation.provenance.collectedAt).toBe(
      W036_NOTICE_COLLECTED_AT,
    );
    // Two observations are now attached to the same subject (the
    // append-only observation set at the measurement point).
    const bySubject = await runtime.outcomeObservationService
      .listObservationsBySubject(
        harness.supplierACtx("w036-ac05-list"),
        contribution.id,
      );
    expect(
      new Set(bySubject.map((observation) => observation.id)).size,
    ).toBe(2);
  }, 120_000);

  test("RAW PAYLOAD CONTAINMENT (privacy regression): the raw notice's opaque device/user/vendor identifiers appear NOWHERE in any persisted authority collection, the audit log, the log sink or the observation record", async () => {
    const runtime = harness.runtime;

    // The persisted authority collections, derived from the SOURCE
    // (the collection constants every repository in src/ declares —
    // the scan list can never drift behind a new collection).
    const srcRoot = join(REPO, "src");
    const dirs = [srcRoot];
    const collections = new Set<string>();
    while (dirs.length > 0) {
      const dir = dirs.pop()!;
      for (const entry of await readdir(dir, { withFileTypes: true })) {
        const path = join(dir, entry.name);
        if (entry.isDirectory()) {
          dirs.push(path);
        } else if (entry.name.endsWith(".ts")) {
          const source = await readFile(path, "utf8");
          for (const match of source.matchAll(
            /COLLECTION\w*\s*=\s*"([a-z_]+)"/g,
          )) {
            collections.add(match[1]!);
          }
        }
      }
    }
    // The derivation is real: the measurement/outcome collections are
    // covered, and the scan will see populated state.
    expect(collections.size).toBeGreaterThanOrEqual(70);
    expect(collections.has("outcome_observations")).toBe(true);
    expect(collections.has("contributions")).toBe(true);
    expect(collections.has("idempotency")).toBe(true);

    let nonEmptyCollections = 0;
    let scannedRecords = 0;
    for (const collection of [...collections].sort()) {
      const records = await runtime.postgresAuthority.scan(collection);
      if (records.length > 0) {
        nonEmptyCollections += 1;
      }
      scannedRecords += records.length;
      const serialized = JSON.stringify(records);
      for (const opaque of OPAQUE_VENDOR_VALUES) {
        expect(
          serialized.includes(opaque),
          `opaque vendor id "${opaque}" leaked into collection "${collection}"`,
        ).toBe(false);
      }
    }
    // The scan covered genuinely populated authoritative state (the
    // pool/commitment/offer/selection/opportunity/contribution/
    // observation/idempotency records — the privacy scan is real,
    // not an empty-set tautology).
    expect(nonEmptyCollections).toBeGreaterThanOrEqual(8);
    expect(scannedRecords).toBeGreaterThanOrEqual(20);

    // The observation record itself is clean.
    const observationJson = JSON.stringify(canonicalObservation);
    for (const opaque of OPAQUE_VENDOR_VALUES) {
      expect(observationJson.includes(opaque)).toBe(false);
    }
    // The vendor-experiment payload (bucket 7/8) never appears either.
    expect(observationJson).not.toContain("experimentBucket");
    // The audit log is clean.
    const log = await runtime.auditWriter.query({ limit: 1_000_000 });
    expect(log.length).toBeGreaterThan(0);
    const logJson = JSON.stringify(log);
    for (const opaque of OPAQUE_VENDOR_VALUES) {
      expect(logJson.includes(opaque)).toBe(false);
    }
    // The runtime log sink is clean.
    const sinkJson = JSON.stringify(
      (runtime.logSink as { entries: unknown[] }).entries ?? [],
    );
    for (const opaque of OPAQUE_VENDOR_VALUES) {
      expect(sinkJson.includes(opaque)).toBe(false);
    }
    // The composed view carries the redaction NAMES only — never the
    // values.
    const viewJson = JSON.stringify(canonicalView);
    for (const opaque of OPAQUE_VENDOR_VALUES) {
      expect(viewJson.includes(opaque)).toBe(false);
    }
  }, 120_000);

  test("DETERMINISTIC ANCHOR WITNESS: a fresh harness re-running the same fixed submission yields the IDENTICAL normalized observation facts (server ids/timestamps excepted)", async () => {
    // A SECOND, fresh harness (a fresh authority): the same fixed
    // fixtures, the same fixed idempotency keys, the same fixed
    // signed notice.
    const second = await createNetW036Harness();
    try {
      const runtime = second.runtime;
      const subject = await seedMeasuringFulfillmentSubjectOn(
        second,
        "w036-ac05-pool-canonical",
        "w036-ac05-offer-canonical",
        "w036-ac05-selection-canonical",
        "w036-ac05-canonical",
      );
      const atPoint = await runtime.contributionService.getContribution(
        second.supplierACtx("w036-ac05-rerun-point"),
        subject.id,
      );
      expect(atPoint.state).toBe("MEASURING");
      expect(atPoint.version).toBe(5);

      // The SAME fixed submission (the same fixed idempotency key —
      // a fresh authority, so no replay).
      const view = await runtime.apiCommands.submitMeasurementReport(
        second.supplierACtx("w036-ac05-measure"),
        second.supplierAPersonId,
        {
          organizationScopeId: second.organizationScopeId,
          subjectReference: { subjectId: subject.id, subjectType: "contribution" },
          idempotencyKey: "w036-ac05-observation",
          providerId: OPENRTB_DELIVERY_PROVIDER_ID,
          report: w036DeliveryNotice(),
        },
      );
      expect(view.created).toBe(true);
      const observation = await runtime.outcomeObservationService
        .getOutcomeObservation(
          second.supplierACtx("w036-ac05-rerun-read"),
          view.observation.id,
        );

      // The IDENTICAL deterministic facts: value, unit, confidence,
      // provenance (source/method/version/collectedAt — the provider
      // + fixed anchors), attribution mode, provider-side subject
      // reference, null links. These are functions of the FIXED
      // payload alone.
      expect(observation.outcomeType).toBe(canonicalObservation.outcomeType);
      expect(observation.observedValue).toEqual(
        canonicalObservation.observedValue,
      );
      expect(observation.confidence).toEqual(canonicalObservation.confidence);
      expect(observation.provenance.sourceType).toBe(
        canonicalObservation.provenance.sourceType,
      );
      expect(observation.provenance.sourceId).toBe(
        canonicalObservation.provenance.sourceId,
      );
      expect(observation.provenance.method).toBe(
        canonicalObservation.provenance.method,
      );
      expect(observation.provenance.methodVersion).toBe(
        canonicalObservation.provenance.methodVersion,
      );
      expect(observation.provenance.collectedAt).toBe(
        canonicalObservation.provenance.collectedAt,
      );
      expect(observation.providerAttributionMode).toBe(
        canonicalObservation.providerAttributionMode,
      );
      expect(observation.externalSubjectRef).toBe(
        canonicalObservation.externalSubjectRef,
      );
      expect(observation.correctsObservationId).toBeNull();
      expect(observation.outcomeClaimId).toBeNull();
      expect(observation.evidenceId).toBeNull();
      expect(observation.subjectReference.subjectType).toBe("contribution");
      // The observer/collector is the server-resolved acting person
      // of THIS harness (deterministic BEHAVIOR: always the acting
      // supplier observer, never a caller-asserted id).
      expect(observation.observerId).toBe(second.supplierAPersonId);
      expect(observation.provenance.collectorId).toBe(
        second.supplierAPersonId,
      );
      // The redaction summary is identical (deterministic
      // normalization).
      expect([...view.redactedFieldNames]).toEqual([
        ...canonicalView.redactedFieldNames,
      ]);
      // The subject binding: the observation is bound to THIS
      // harness's own subject id (server-generated ids differ by
      // design; the binding is what matters).
      expect(observation.subjectReference.subjectId).toBe(subject.id);
      // The server-generated identity fields exist but are NOT
      // asserted equal across harnesses (ids/timestamps are
      // authority-generated).
      expect(typeof observation.id).toBe("string");
      expect(typeof observation.createdAt).toBe("string");
      expect(observation.id).not.toBe(canonicalObservation.id);
      // Exactly one observation for the subject (exactly-once under
      // the fixed key).
      const bySubject = await runtime.outcomeObservationService
        .listObservationsBySubject(
          second.supplierACtx("w036-ac05-rerun-list"),
          subject.id,
        );
      expect(bySubject).toHaveLength(1);
    } finally {
      await second.teardown();
    }
  }, 240_000);

  test("MEASURED OUTCOME LIFECYCLE: createMeasuredOutcome → beginMaturation → recordMeasurementRollup → finalize → VERIFIED with the rollup over the chain-head observation (uncertainty derived from the observation chain); out-of-order maturation fails closed", async () => {
    const runtime = harness.runtime;
    const ctx = harness.supplierACtx("w036-ac05-measured-outcome");
    const supplierA = harness.supplierAPersonId;

    // The sanctioned lifecycle over the canonical provider
    // observation: DRAFT (v0) → MEASURING (v1) → rollup → VERIFIED
    // (v2) — every lifecycle transition through /workflows.
    const draft = await runtime.measuredOutcomeService.createMeasuredOutcome(
      ctx,
      {
        organizationScopeId: harness.organizationScopeId,
        ownerId: supplierA,
        subjectReference: {
          subjectId: contribution.id,
          subjectType: "contribution",
        },
        outcomeType: "view",
        maturation: { strategy: "immediate" },
        observationIds: [canonicalObservation.id],
      },
    );
    expect(draft.state).toBe("DRAFT");
    expect(draft.version).toBe(0);
    expect(draft.rollup).toBeNull();
    expect(draft.observationIds).toEqual([canonicalObservation.id]);
    expect(draft.maturation.strategy).toBe("immediate");
    expect(draft.rollupStrategy).toBe("sum");

    const begun = await runtime.measuredOutcomeService.beginMaturation(ctx, {
      measurementId: draft.id,
      expectedVersion: 0,
      idempotencyKey: "w036-ac05-mo-begin",
      actorPersonId: supplierA,
    });
    expect(begun.measurement.state).toBe("MEASURING");
    expect(begun.measurement.version).toBe(1);
    expect(begun.auditEventName).toBe(
      "outcome_measurement.transition.draft_to_measuring",
    );

    const rolled = await runtime.measuredOutcomeService.recordMeasurementRollup(
      ctx,
      draft.id,
    );
    // The rollup: server-DERIVED over the CHAIN-HEAD observation
    // (the exact ids), the sum strategy, and the CONSERVATIVE
    // uncertainty derivation from the observation chain (the point
    // is the minimum contributing point; the interval — when ANY
    // contributor quantifies one — the conservative envelope).
    expect(rolled.rollup).not.toBeNull();
    expect(rolled.rollup?.strategy).toBe("sum");
    expect(rolled.rollup?.measuredValue).toEqual({
      value: 1,
      unit: "impressions",
    });
    expect(rolled.rollup?.observationIds).toEqual([canonicalObservation.id]);
    expect(rolled.rollup?.supersededObservationCount).toBe(0);
    expect(rolled.rollup?.confidence.point).toBe(
      canonicalObservation.confidence.point,
    );
    expect(rolled.rollup?.confidence.method).toBe(
      "conservative-observation-rollup",
    );
    // The supporting-source gate held: the provider-sourced
    // observation supports the finalized value.
    expect(rolled.state).toBe("MEASURING");

    const finalized = await runtime.measuredOutcomeService.finalize(ctx, {
      measurementId: draft.id,
      expectedVersion: 1,
      idempotencyKey: "w036-ac05-mo-finalize",
      actorPersonId: supplierA,
    });
    const measurement: MeasuredOutcome = finalized.measurement;
    expect(measurement.state).toBe("VERIFIED");
    expect(measurement.version).toBe(2);
    expect(finalized.auditEventName).toBe(
      "outcome_measurement.transition.measuring_to_verified",
    );
    // The rollup is linked to the chain-head observation on the
    // VERIFIED record (the finalized value is DERIVED, never
    // caller-asserted).
    expect(measurement.rollup?.observationIds).toEqual([
      canonicalObservation.id,
    ]);
    expect(measurement.subjectReference.subjectId).toBe(contribution.id);

    // The durable audit trail for the whole maturation (the
    // domain-emitted created/rollup events carry the
    // "measured_outcome" resource type; the workflow-emitted
    // transitions carry the "outcome_measurement" subject kind —
    // one query by resourceId binds them in commit order).
    const events = await runtime.auditWriter.query({
      resourceId: draft.id,
    });
    expect(events.map((event) => event.eventType)).toEqual([
      "measured_outcome.created",
      "outcome_measurement.transition.draft_to_measuring",
      "measured_outcome.rollup_recorded",
      "outcome_measurement.transition.measuring_to_verified",
    ]);

    // (a) OUT OF ORDER: recording the rollup BEFORE the maturation
    //     opens (still DRAFT) fails closed with the exact validation
    //     error from src/outcomes (MEASUREMENT_VALIDATION).
    const outOfOrder = await runtime.measuredOutcomeService
      .createMeasuredOutcome(ctx, {
        organizationScopeId: harness.organizationScopeId,
        ownerId: supplierA,
        subjectReference: {
          subjectId: contribution.id,
          subjectType: "contribution",
        },
        outcomeType: "view",
        maturation: { strategy: "immediate" },
        observationIds: [canonicalObservation.id],
      });
    let rollupError: unknown;
    try {
      await runtime.measuredOutcomeService.recordMeasurementRollup(
        ctx,
        outOfOrder.id,
      );
      throw new Error("expected the out-of-order rollup to fail closed");
    } catch (error) {
      rollupError = error;
    }
    expect(rollupError).toMatchObject({ code: "MEASUREMENT_VALIDATION" });
    expect((rollupError as Error).message).toContain(
      "only in state MEASURING",
    );

    // (b) OUT OF ORDER: finalizing WITHOUT a recorded rollup fails
    //     closed (the finalized value is always derived, never
    //     caller-asserted).
    const begunNoRollup = await runtime.measuredOutcomeService.beginMaturation(
      ctx,
      {
        measurementId: outOfOrder.id,
        expectedVersion: 0,
        idempotencyKey: "w036-ac05-mo-begin-negative",
        actorPersonId: supplierA,
      },
    );
    expect(begunNoRollup.measurement.state).toBe("MEASURING");
    let finalizeError: unknown;
    try {
      await runtime.measuredOutcomeService.finalize(ctx, {
        measurementId: outOfOrder.id,
        expectedVersion: 1,
        idempotencyKey: "w036-ac05-mo-finalize-negative",
        actorPersonId: supplierA,
      });
      throw new Error("expected the rollup-less finalize to fail closed");
    } catch (error) {
      finalizeError = error;
    }
    expect(finalizeError).toMatchObject({ code: "MEASUREMENT_VALIDATION" });
    expect((finalizeError as Error).message).toContain("rollup");
    // Nothing moved: the out-of-order subject stays MEASURING v1.
    const refused = await runtime.measuredOutcomeService.getMeasuredOutcome(
      ctx,
      outOfOrder.id,
    );
    expect(refused.state).toBe("MEASURING");
    expect(refused.version).toBe(1);
    expect(refused.rollup).toBeNull();
  }, 120_000);

  test("PROVIDER-BOUNDARY NEGATIVES: an unknown provider id fails closed with UNKNOWN_MEASUREMENT_PROVIDER; a tampered or wrong-secret notice fails closed with MEASUREMENT_REPORT_REJECTED (unverifiable_integrity) — nothing persisted, no secret material surfaced", async () => {
    const runtime = harness.runtime;
    const observationsBefore = (
      await runtime.outcomeObservationService.listObservationsBySubject(
        harness.supplierACtx("w036-ac05-negative-before"),
        contribution.id,
      )
    ).length;

    // (a) UNKNOWN PROVIDER: the composed command routes by provider
    //     id; no adapter owns this identity → fail closed before any
    //     normalization or persistence.
    await expect(
      runtime.apiCommands.submitMeasurementReport(
        harness.supplierACtx("w036-ac05-unknown-provider"),
        harness.supplierAPersonId,
        {
          organizationScopeId: harness.organizationScopeId,
          subjectReference: {
            subjectId: contribution.id,
            subjectType: "contribution",
          },
          idempotencyKey: "w036-ac05-unknown-provider",
          providerId: "w036-ac05-no-such-provider",
          report: w036DeliveryNotice(),
        },
      ),
    ).rejects.toMatchObject({ code: "UNKNOWN_MEASUREMENT_PROVIDER" });

    // (b) TAMPERED PAYLOAD: the notice was signed, then the observed
    //     value changed — the signature no longer matches the
    //     payload. Deterministic negative (fixed mutation of the
    //     fixed fixture).
    const tampered = w036DeliveryNotice();
    (tampered["observedValue"] as Record<string, unknown>)["value"] = 999;
    await expect(
      submitNotice(tampered, "w036-ac05-tampered", contribution.id),
    ).rejects.toMatchObject({
      code: "MEASUREMENT_REPORT_REJECTED",
      reason: "unverifiable_integrity",
    });

    // (c) WRONG SECRET: a syntactically valid envelope computed with
    //     a DIFFERENT key (an untrusted signer — a test-only literal,
    //     never a real credential) — the signature does not verify.
    const WRONG_SECRET_LITERAL = "w036-ac05-wrong-delivery-secret";
    const wrongSecret = w036DeliveryNotice();
    const { integrity: _existing, ...body } = wrongSecret;
    void _existing;
    wrongSecret["integrity"] = signRawReport(body, WRONG_SECRET_LITERAL);
    await expect(
      submitNotice(wrongSecret, "w036-ac05-wrong-secret", contribution.id),
    ).rejects.toMatchObject({
      code: "MEASUREMENT_REPORT_REJECTED",
      reason: "unverifiable_integrity",
    });

    // NOTHING WAS PERSISTED by any refused submission (fail closed
    // end-to-end): the subject's observation set is unchanged.
    const observationsAfter = (
      await runtime.outcomeObservationService.listObservationsBySubject(
        harness.supplierACtx("w036-ac05-negative-after"),
        contribution.id,
      )
    ).length;
    expect(observationsAfter).toBe(observationsBefore);

    // No idempotency residue either: the refused keys recorded
    // nothing (a later SAME-KEY valid submission is not a replay —
    // exactly-once is only ever bound to a COMMITTED mutation).
    const replay = await submitNotice(
      w036DeliveryNotice(),
      "w036-ac05-tampered",
      contribution.id,
    );
    expect(replay.created).toBe(true);
    // The error surfaces carry NO secret material (the W022
    // discipline): neither the test verification secret nor the
    // wrong-key literal ever appears in the rejection — and the
    // closed reason + provider id are the only context.
    let rejectedError: unknown;
    try {
      await submitNotice(
        tampered,
        "w036-ac05-secret-check-2",
        contribution.id,
      );
    } catch (error) {
      rejectedError = error;
    }
    expect(rejectedError).toBeDefined();
    const rejectedJson = JSON.stringify(rejectedError);
    expect(rejectedJson).not.toContain(OPENRTB_DELIVERY_TEST_SECRET);
    expect(rejectedJson).not.toContain(WRONG_SECRET_LITERAL);
    // The error context carries the closed reason + provider id only
    // (never payload values).
    expect(rejectedJson).not.toContain("opaque-device-id-w036");
  }, 120_000);
});

// ---------------------------------------------------------------------------
// The fresh-harness seeding twin (the same fixtures, a second harness)
// ---------------------------------------------------------------------------

/** The AC-05 fulfillment seeding over an arbitrary W036 harness. */
async function seedMeasuringFulfillmentSubjectOn(
  target: NetW036Harness,
  poolKey: string,
  offerKey: string,
  selectionKey: string,
  observationPrefix: string,
): Promise<Contribution> {
  const runtime = target.runtime;
  const scope = target.organizationScopeId;
  const pool = (
    await runtime.procurementService.createProcurementPool(
      target.poolCreatorCtx(`${observationPrefix}-pool`),
      {
        organizationScopeId: scope,
        name: "W036 AC-05 Measurement Pool",
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
    readonly ctx: ReturnType<typeof target.poolCreatorCtx>;
    readonly buyerOrganizationId: string;
    readonly quantity: number;
    readonly key: string;
  }[] = [
    {
      ctx: target.poolCreatorCtx(`${observationPrefix}-commit-a`),
      buyerOrganizationId: target.buyerOrgAId,
      quantity: 12,
      key: `${poolKey}-commit-a`,
    },
    {
      ctx: target.buyerBCtx(`${observationPrefix}-commit-b`),
      buyerOrganizationId: target.buyerOrgBId,
      quantity: 40,
      key: `${poolKey}-commit-b`,
    },
    {
      ctx: target.buyerCCtx(`${observationPrefix}-commit-c`),
      buyerOrganizationId: target.buyerOrgCId,
      quantity: 75,
      key: `${poolKey}-commit-c`,
    },
  ];
  for (const seed of commitmentSeeds) {
    await runtime.procurementService.createProcurementCommitment(
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
    );
  }
  const offer = (
    await runtime.supplierOfferService.createSupplierOffer(
      target.supplierACtx(`${observationPrefix}-offer`),
      {
        organizationScopeId: scope,
        poolId: pool.id,
        attributes: {
          region: "NA_EAST",
          unitPriceBand: "price_a_under_10",
          timingWindow: "window_short_1_3mo",
          quantityBucket: "q_100_999",
        },
        validUntil: null,
        consent: { scope: "competitive_selection" },
        idempotencyKey: offerKey,
      },
    )
  ).offer;
  const selection = (
    await runtime.supplierOfferService.recordCompetitiveSelection(
      target.poolCreatorCtx(`${observationPrefix}-selection`),
      {
        organizationScopeId: scope,
        poolId: pool.id,
        idempotencyKey: selectionKey,
      },
    )
  ).selection;
  const opportunity = await runtime.opportunityService.createOpportunity(
    target.poolCreatorCtx(`${observationPrefix}-opportunity`),
    {
      organizationScopeId: scope,
      ownerId: target.poolCreatorPersonId,
      opportunityType: "procurement-fulfillment",
      title: "W036 AC-05 Fulfillment Opportunity",
      brief: {
        kind: "procurement_fulfillment",
        poolId: pool.id,
        selectionId: selection.id,
      },
    },
  );
  const created = await runtime.contributionService.createContribution(
    target.supplierACtx(`${observationPrefix}-contribution`),
    {
      opportunityId: opportunity.id,
      contributorId: target.supplierAPersonId,
      organizationScopeId: scope,
      contributionType: "procurement-fulfillment",
      submission: {
        kind: "fulfillment_execution",
        poolId: pool.id,
        selectionId: selection.id,
      },
    },
  );
  void offer;
  const ladder: readonly ("READY" | "ASSIGNED" | "IN_PROGRESS" | "SUBMITTED" | "MEASURING")[] = [
    "READY",
    "ASSIGNED",
    "IN_PROGRESS",
    "SUBMITTED",
    "MEASURING",
  ];
  for (const [index, state] of ladder.entries()) {
    await requestContributionTransition(
      target,
      created.id,
      state,
      `${observationPrefix}-t${String(index + 1)}`,
    );
  }
  return created;
}
