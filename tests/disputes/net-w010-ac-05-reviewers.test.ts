/**
 * NET-W010-AC-05 — Reviewer identity, reasons, supporting references,
 * and conflict controls are auditable.
 *
 * Evidence: reviewer identity is taken from the EXECUTION ACTOR
 * (server-side — never caller-asserted); the conflict-of-interest
 * gate bars the challenger AND the subject beneficiary from reviewing
 * (start, reject, resolve); every reviewer action commits an audit
 * event carrying actor, reasons, supporting references, idempotency
 * + transaction lineage (AUD-006); material decisions carry their
 * reason codes into both the event history and the audit metadata.
 */

import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import {
  createNetW010Harness,
  openBondedDispute,
  challengerCtx,
  reviewerCtx,
  beneficiaryCtx,
  type NetW010Harness,
} from "./_net-w010-harness.ts";

let harness: NetW010Harness;

beforeAll(async () => {
  harness = await createNetW010Harness();
});

afterAll(async () => {
  await harness.teardown();
});

describe("NET-W010-AC-05 reviewer identity, COI, and auditability", () => {
  test("the CHALLENGER cannot review their own dispute (conflict of interest)", async () => {
    const { dispute } = await openBondedDispute(harness);
    await expect(
      harness.runtime.disputeService.startReview(
        challengerCtx(harness, "w010-ac05-coi-challenger"),
        {
          disputeId: dispute.id,
          idempotencyKey: `w010-ac05-coi-c-${dispute.id}`,
        },
      ),
    ).rejects.toMatchObject({
      code: "DISPUTE_VALIDATION",
      message: expect.stringContaining("conflict of interest"),
      context: expect.objectContaining({ conflict: "challenger" }),
    });
  });

  test("the SUBJECT BENEFICIARY cannot review (conflict of interest)", async () => {
    const { dispute } = await openBondedDispute(harness);
    await expect(
      harness.runtime.disputeService.startReview(
        beneficiaryCtx(harness, "w010-ac05-coi-beneficiary"),
        {
          disputeId: dispute.id,
          idempotencyKey: `w010-ac05-coi-b-${dispute.id}`,
        },
      ),
    ).rejects.toMatchObject({
      code: "DISPUTE_VALIDATION",
      context: expect.objectContaining({ conflict: "subject_beneficiary" }),
    });
    // The COI gate equally bars them from resolving (after a proper
    // review started, so the state check passes and the COI check is
    // what refuses).
    const underReview = await harness.runtime.disputeService.startReview(
      reviewerCtx(harness, "w010-ac05-coi-prereview"),
      {
        disputeId: dispute.id,
        idempotencyKey: `w010-ac05-coi-pre-${dispute.id}`,
      },
    );
    expect(underReview.state).toBe("UNDER_REVIEW");
    await expect(
      harness.runtime.disputeService.resolveDispute(
        beneficiaryCtx(harness, "w010-ac05-coi-resolve"),
        {
          disputeId: dispute.id,
          outcome: "UPHELD",
          controlDisposition: "RELEASE_CONTROL",
          reasonCodes: ["x"],
          sourceRefs: [{ kind: "economic_value", id: dispute.subjectRef.subjectId }],
          idempotencyKey: `w010-ac05-coi-r-${dispute.id}`,
        },
      ),
    ).rejects.toMatchObject({
      code: "DISPUTE_VALIDATION",
      message: expect.stringContaining("conflict of interest"),
    });
  });

  test("an independent reviewer is recorded with identity + lineage on the dispute", async () => {
    const { dispute } = await openBondedDispute(harness);
    const underReview = await harness.runtime.disputeService.startReview(
      reviewerCtx(harness, "w010-ac05-review"),
      {
        disputeId: dispute.id,
        reasonCodes: ["taking_the_case"],
        note: "independent reviewer",
        idempotencyKey: `w010-ac05-review-${dispute.id}`,
      },
    );
    expect(underReview.reviewerPersonId).toBe(harness.reviewerPersonId);
    expect(underReview.reviewStartedAt).toBeTruthy();
    const event = underReview.events[underReview.events.length - 1]!;
    expect(event.event).toBe("review_started");
    expect(event.actorPersonId).toBe(harness.reviewerPersonId);
    expect(event.reasonCodes).toEqual(["taking_the_case"]);
    expect(event.note).toBe("independent reviewer");
    expect(event.executionId).toBeTruthy();
    expect(event.correlationId).toBeTruthy();
  });

  test("every reviewer action commits an AUDIT event with actor, reasons, refs and lineage", async () => {
    const { dispute, subject } = await openBondedDispute(harness, {
      withReview: true,
    });
    const resolved = await harness.runtime.disputeService.resolveDispute(
      reviewerCtx(harness, "w010-ac05-resolve"),
      {
        disputeId: dispute.id,
        outcome: "UPHELD",
        controlDisposition: "REQUIRE_REEVALUATION",
        reasonCodes: ["evidence_reassessment_needed"],
        sourceRefs: [{ kind: "economic_value", id: subject.id }],
        note: "re-evaluate the verification",
        idempotencyKey: `w010-ac05-resolve-${dispute.id}`,
      },
    );

    const events = await harness.runtime.auditWriter.query({
      eventType: "dispute.resolved",
      resourceId: resolved.id,
    });
    expect(events).toHaveLength(1);
    const audit = events[0]!;
    expect(audit.actor).toBe(harness.reviewerPersonId);
    expect(audit.resourceType).toBe("dispute");
    expect(audit.subject).toBe(resolved.id);
    expect(audit.metadata).toMatchObject({
      organizationScopeId: harness.organizationScopeId,
      disputeId: resolved.id,
      reviewerPersonId: harness.reviewerPersonId,
      outcome: "UPHELD",
      controlDisposition: "REQUIRE_REEVALUATION",
      stakeDisposition: "RELEASE",
      reasonCodes: ["evidence_reassessment_needed"],
      sourceRefs: [`economic_value:${subject.id}`],
      idempotencyRecordId: expect.any(String),
      transactionId: expect.any(String),
    });

    // The opened + review_started audit events exist too (one per
    // committed mutation).
    const opened = await harness.runtime.auditWriter.query({
      eventType: "dispute.opened",
      resourceId: resolved.id,
    });
    expect(opened).toHaveLength(1);
    expect(opened[0]!.metadata).toMatchObject({
      challengerPersonId: harness.challengerPersonId,
      stakeRequirement: 10,
      policyVersion: expect.any(String),
    });
    const reviewStarted = await harness.runtime.auditWriter.query({
      eventType: "dispute.review_started",
      resourceId: resolved.id,
    });
    expect(reviewStarted).toHaveLength(1);
    expect(reviewStarted[0]!.actor).toBe(harness.reviewerPersonId);
  });

  test("rejection audit carries the deterministic stake disposition (RELEASE)", async () => {
    const { dispute, subject } = await openBondedDispute(harness);
    const rejected = await harness.runtime.disputeService.rejectDispute(
      reviewerCtx(harness, "w010-ac05-reject"),
      {
        disputeId: dispute.id,
        reasonCodes: ["outside_challenge_window"],
        sourceRefs: [{ kind: "economic_value", id: subject.id }],
        idempotencyKey: `w010-ac05-reject-${dispute.id}`,
      },
    );
    const events = await harness.runtime.auditWriter.query({
      eventType: "dispute.rejected",
      resourceId: rejected.id,
    });
    expect(events).toHaveLength(1);
    expect(events[0]!.metadata).toMatchObject({
      reviewerPersonId: harness.reviewerPersonId,
      reasonCodes: ["outside_challenge_window"],
      stakeDisposition: "RELEASE",
    });
  });
});
