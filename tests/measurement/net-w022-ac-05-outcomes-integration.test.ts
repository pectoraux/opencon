/**
 * NET-W022-AC-05 — /outcomes integration: idempotency, audit
 * atomicity, tenant scoping, replay (issue #44 scope 6 + the
 * architectural constraints).
 *
 * The pushed report persists through the SAME /outcomes semantics as
 * the W006 pull path: exactly-once-per-idempotency-key (the
 * observation + audit record + idempotency record commit in ONE
 * authoritative transaction), deterministic replays return the cached
 * observation with created=false, and the measurement lifecycle /
 * transition matrix are UNCHANGED (provider facts can never
 * manufacture a finalized measurement — the rollup gate still
 * applies).
 */

import { describe, test, expect, afterEach } from "bun:test";
import {
  createNetW022Harness,
  browserRawReport,
  submitReport,
  createSubject,
  actorCtx,
  type NetW022Harness,
} from "./_net-w022-harness.ts";

describe("NET-W022-AC-05 /outcomes integration: idempotency, audit, tenancy", () => {
  let harness: NetW022Harness;

  afterEach(async () => {
    if (harness) await harness.teardown();
  });

  test("the pushed observation persists durably with an ATOMIC audit record", async () => {
    harness = await createNetW022Harness();
    const subject = await createSubject(harness);
    const view = await submitReport(harness, {
      providerId: "browser-attribution",
      report: browserRawReport(),
      idempotencyKey: "ac05-atomic",
      subjectId: subject.id,
    });
    // Durable through the authoritative store.
    const ctx = actorCtx(harness.w006, "ac05-read");
    const stored = await harness.runtime.outcomeObservationService.getOutcomeObservation(
      ctx,
      view.observation.id,
    );
    expect(stored).toBeDefined();
    expect(stored.observedValue).toEqual({ value: 18, unit: "installs" });
    // Exactly ONE audit event, committed atomically with the mutation,
    // carrying the provider ingestion metadata + idempotency lineage.
    const events = await harness.runtime.auditWriter.query({
      eventType: "outcome_observation.created",
      resourceId: view.observation.id,
    });
    expect(events.length).toBe(1);
    expect(events[0]!.metadata).toMatchObject({
      ingestedFromProvider: "browser-attribution",
      providerVersion: "1.0.0",
      externalSubjectRef: "ext-browser-subject-42",
      pushedReportIngestion: true,
      organizationScopeId: harness.organizationScopeId,
      subjectId: subject.id,
      subjectType: "contribution",
      outcomeType: "install",
      sourceType: "provider",
      method: "browser-attribution-model",
      methodVersion: "3.1.0",
    });
    expect(
      typeof (events[0]!.metadata as Record<string, unknown>)["idempotencyRecordId"],
    ).toBe("string");
    expect(
      typeof (events[0]!.metadata as Record<string, unknown>)["transactionId"],
    ).toBe("string");
  });

  test("exactly-once-per-key: same idempotency key ⇒ deterministic replay (created: false, same observation, no duplicate)", async () => {
    harness = await createNetW022Harness();
    const subject = await createSubject(harness);
    const first = await submitReport(harness, {
      providerId: "browser-attribution",
      report: browserRawReport(),
      idempotencyKey: "ac05-replay",
      subjectId: subject.id,
    });
    expect(first.created).toBe(true);
    // A FULLY DIFFERENT payload under the SAME key still replays the
    // FIRST result (the key is the identity — exactly-once).
    const replay = await submitReport(harness, {
      providerId: "browser-attribution",
      report: browserRawReport({ set: { observedValue: { value: 99, unit: "installs" } } }),
      idempotencyKey: "ac05-replay",
      subjectId: subject.id,
      correlationId: "ac05-replay-2",
    });
    expect(replay.created).toBe(false);
    expect(replay.observation.id).toBe(first.observation.id);
    expect(replay.observation.observedValue.value).toBe(18);
    // Exactly ONE observation for the subject, ONE audit event.
    const ctx = actorCtx(harness.w006, "ac05-replay-read");
    const listed = await harness.runtime.outcomeObservationService.listObservationsBySubject(
      ctx,
      subject.id,
    );
    expect(listed.length).toBe(1);
    const events = await harness.runtime.auditWriter.query({
      eventType: "outcome_observation.created",
      resourceId: first.observation.id,
    });
    expect(events.length).toBe(1);
    // A DIFFERENT key ⇒ a NEW observation.
    const second = await submitReport(harness, {
      providerId: "browser-attribution",
      report: browserRawReport({ set: { observedValue: { value: 7, unit: "installs" } } }),
      idempotencyKey: "ac05-replay-3",
      subjectId: subject.id,
      correlationId: "ac05-replay-3",
    });
    expect(second.created).toBe(true);
    expect(second.observation.id).not.toBe(first.observation.id);
    const listed2 = await harness.runtime.outcomeObservationService.listObservationsBySubject(
      ctx,
      subject.id,
    );
    expect(listed2.length).toBe(2);
  });

  test("tenant scoping: the idempotency key namespace is per-organization (same key, different org ⇒ different observation)", async () => {
    harness = await createNetW022Harness();
    const subject = await createSubject(harness);
    const otherOrg = await harness.runtime.organizationService.createOrganization(
      harness.bootstrapCtx,
      { name: "Other Measurement Org", creatorId: harness.personId },
    );
    const first = await submitReport(harness, {
      providerId: "browser-attribution",
      report: browserRawReport(),
      idempotencyKey: "ac05-tenant",
      subjectId: subject.id,
    });
    const second = await submitReport(harness, {
      providerId: "browser-attribution",
      report: browserRawReport(),
      idempotencyKey: "ac05-tenant",
      subjectId: subject.id,
      organizationScopeId: otherOrg.id,
      correlationId: "ac05-tenant-2",
    });
    // The org scope is part of the key namespace: the second
    // submission creates its own observation in the other tenant.
    expect(second.created).toBe(true);
    expect(second.observation.id).not.toBe(first.observation.id);
    const ctx = actorCtx(harness.w006, "ac05-tenant-read");
    const otherOrgObservation = await harness.runtime.outcomeObservationService.getOutcomeObservation(
      ctx,
      second.observation.id,
    );
    expect(otherOrgObservation.organizationScopeId).toBe(otherOrg.id);
    expect(first.observation.organizationScopeId).toBe(harness.organizationScopeId);
  });

  test("the provider observation satisfies the W006 rollup supporting-source gate (it is a measurement INPUT, not a verdict)", async () => {
    harness = await createNetW022Harness();
    const subject = await createSubject(harness);
    const view = await submitReport(harness, {
      providerId: "browser-attribution",
      report: browserRawReport(),
      idempotencyKey: "ac05-rollup",
      subjectId: subject.id,
    });
    // The lifecycle path is EXACTLY the W006 one: create → begin
    // maturation → rollup. The pushed provider observation counts as
    // the supporting (provider) source for the rollup gate.
    const ctx = actorCtx(harness.w006, "ac05-rollup-lifecycle");
    const measurement = await harness.runtime.measuredOutcomeService.createMeasuredOutcome(
      ctx,
      {
        organizationScopeId: harness.organizationScopeId,
        ownerId: harness.personId,
        subjectReference: { subjectId: subject.id, subjectType: "contribution" },
        outcomeType: "install",
        maturation: { strategy: "immediate" },
        observationIds: [view.observation.id],
      },
    );
    await harness.runtime.measuredOutcomeService.beginMaturation(ctx, {
      measurementId: measurement.id,
      expectedVersion: 0,
      idempotencyKey: "ac05-begin",
      actorPersonId: harness.personId,
    });
    const rolled = await harness.runtime.measuredOutcomeService.recordMeasurementRollup(
      ctx,
      measurement.id,
    );
    // The provider-reported fact fed the deterministic rollup; the
    // finalized measurement only appears after the FULL authorized
    // lifecycle (never from the adapter itself).
    expect(rolled.rollup!.measuredValue).toEqual({ value: 18, unit: "installs" });
  });

  test("the /outcomes lifecycle + transition table are UNCHANGED (additive interface only)", async () => {
    const { readFile } = await import("node:fs/promises");
    const { join } = await import("node:path");
    const REPO = join(import.meta.dir, "../..");
    // The transition table is untouched.
    const transitionTable = await readFile(
      join(REPO, "src/workflows/transition-table.ts"),
      "utf8",
    );
    expect(transitionTable).not.toContain("measurement_report");
    expect(transitionTable).not.toContain("measurementReport");
    // The observation service gained ONLY the additive push method:
    // the W006 method set is intact.
    const service = await readFile(
      join(REPO, "src/outcomes/observation-service.ts"),
      "utf8",
    );
    for (const method of [
      "async createOutcomeObservation(",
      "async getOutcomeObservation(",
      "async listObservationsBySubject(",
      "async correctOutcomeObservation(",
      "async resolveObservationChain(",
      "async ingestProviderObservations(",
      "async ingestProviderReport(",
    ]) {
      expect(service).toContain(method);
    }
    // The measured-outcome lifecycle vocabulary has no new states.
    const coreMeasurement = await readFile(
      join(REPO, "src/core/measurement.ts"),
      "utf8",
    );
    expect(coreMeasurement).not.toContain("PUSHED");
    expect(coreMeasurement).not.toContain("SUBMITTED");
  });
});
