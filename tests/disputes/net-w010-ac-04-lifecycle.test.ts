/**
 * NET-W010-AC-04 — Review, appeal, and resolution lifecycle is
 * deterministic and append-only.
 *
 * Evidence: the state machine rejects every illegal transition with
 * stable errors (resolve before review, bond twice, decide on
 * terminal records, appeal a non-resolved record, appeal twice);
 * resolution requires review (due process); withdrawal closes
 * costlessly pre-resolution; appeals create NEW linked records while
 * the original flips to terminal APPEALED with its resolution block
 * byte-identical; the appeal record opens its own PENDING_STAKE
 * cycle.
 */

import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import {
  createNetW010Harness,
  openBondedDispute,
  openDefaultDispute,
  bondDefaultStake,
  challengerCtx,
  reviewerCtx,
  personCtx,
  type NetW010Harness,
} from "./_net-w010-harness.ts";

let harness: NetW010Harness;

beforeAll(async () => {
  harness = await createNetW010Harness();
});

afterAll(async () => {
  await harness.teardown();
});

describe("NET-W010-AC-04 deterministic append-only lifecycle", () => {
  test("resolution REQUIRES a started review (due process)", async () => {
    const { dispute, subject } = await openBondedDispute(harness); // OPEN, no review
    await expect(
      harness.runtime.disputeService.resolveDispute(
        reviewerCtx(harness, "w010-ac04-no-review"),
        {
          disputeId: dispute.id,
          outcome: "UPHELD",
          controlDisposition: "RELEASE_CONTROL",
          reasonCodes: ["merits"],
          sourceRefs: [{ kind: "economic_value", id: subject.id }],
          idempotencyKey: `w010-ac04-no-review-${dispute.id}`,
        },
      ),
    ).rejects.toMatchObject({
      code: "DISPUTE_VALIDATION",
      message: expect.stringContaining("UNDER_REVIEW"),
    });
  });

  test("the deterministic happy path: OPEN → UNDER_REVIEW → RESOLVED with the immutable resolution block", async () => {
    const { dispute, subject } = await openBondedDispute(harness, {
      withReview: true,
    });
    const resolved = await harness.runtime.disputeService.resolveDispute(
      reviewerCtx(harness, "w010-ac04-resolve"),
      {
        disputeId: dispute.id,
        outcome: "UPHELD",
        controlDisposition: "RELEASE_CONTROL",
        reasonCodes: ["verified_misstatement"],
        sourceRefs: [{ kind: "economic_value", id: subject.id }],
        idempotencyKey: `w010-ac04-resolve-${dispute.id}`,
      },
    );
    expect(resolved.state).toBe("RESOLVED");
    expect(resolved.resolution).toMatchObject({
      outcome: "UPHELD",
      controlDisposition: "RELEASE_CONTROL",
      stakeDisposition: "RELEASE",
      resolvedBy: harness.reviewerPersonId,
    });
    expect(resolved.resolution!.resolvedAt).toBeTruthy();
    expect(
      Date.parse(resolved.resolution!.appealWindowExpiresAt),
    ).toBe(
      Date.parse(resolved.resolution!.resolvedAt) + 7 * 24 * 60 * 60 * 1000,
    );
    // No decision on a RESOLVED dispute (except the appeal transition).
    await expect(
      harness.runtime.disputeService.startReview(
        reviewerCtx(harness, "w010-ac04-late-review"),
        {
          disputeId: dispute.id,
          idempotencyKey: `w010-ac04-late-review-${dispute.id}`,
        },
      ),
    ).rejects.toMatchObject({ code: "DISPUTE_VALIDATION" });
  });

  test("the deterministic outcome→stake mapping: DENIED ⇒ FORFEIT (reviewers cannot override)", async () => {
    const { dispute, subject } = await openBondedDispute(harness, {
      withReview: true,
    });
    const resolved = await harness.runtime.disputeService.resolveDispute(
      reviewerCtx(harness, "w010-ac04-denied"),
      {
        disputeId: dispute.id,
        outcome: "DENIED",
        controlDisposition: "MAINTAIN_CONTROL",
        reasonCodes: ["challenge_without_merit"],
        sourceRefs: [{ kind: "economic_value", id: subject.id }],
        idempotencyKey: `w010-ac04-denied-${dispute.id}`,
      },
    );
    expect(resolved.resolution!.stakeDisposition).toBe("FORFEIT");
  });

  test("an invalid outcome/control vocabulary is rejected", async () => {
    const { dispute, subject } = await openBondedDispute(harness, {
      withReview: true,
    });
    await expect(
      harness.runtime.disputeService.resolveDispute(
        reviewerCtx(harness, "w010-ac04-vocab"),
        {
          disputeId: dispute.id,
          outcome: "MAYBE",
          controlDisposition: "RELEASE_CONTROL",
          reasonCodes: ["x"],
          sourceRefs: [{ kind: "economic_value", id: subject.id }],
          idempotencyKey: `w010-ac04-vocab1-${dispute.id}`,
        },
      ),
    ).rejects.toMatchObject({ code: "DISPUTE_VALIDATION" });
    await expect(
      harness.runtime.disputeService.resolveDispute(
        reviewerCtx(harness, "w010-ac04-vocab2"),
        {
          disputeId: dispute.id,
          outcome: "UPHELD",
          controlDisposition: "BURN_EVERYTHING",
          reasonCodes: ["x"],
          sourceRefs: [{ kind: "economic_value", id: subject.id }],
          idempotencyKey: `w010-ac04-vocab2-${dispute.id}`,
        },
      ),
    ).rejects.toMatchObject({ code: "DISPUTE_VALIDATION" });
  });

  test("double bond / double withdraw are refused (terminal state machine)", async () => {
    const opened = await openDefaultDispute(harness);
    const bonded = await bondDefaultStake(harness, opened.dispute);
    await expect(
      bondDefaultStake(harness, bonded, {
        idempotencyKey: `w010-ac04-double-bond-${bonded.id}:x`,
      }),
    ).rejects.toMatchObject({ code: "CONFLICT" });

    const withdrawn = await harness.runtime.disputeService.withdrawDispute(
      challengerCtx(harness, "w010-ac04-withdraw"),
      {
        disputeId: bonded.id,
        reason: "changed my mind",
        idempotencyKey: `w010-ac04-withdraw-${bonded.id}`,
      },
    );
    expect(withdrawn.state).toBe("WITHDRAWN");
    await expect(
      harness.runtime.disputeService.withdrawDispute(
        challengerCtx(harness, "w010-ac04-withdraw2"),
        {
          disputeId: bonded.id,
          idempotencyKey: `w010-ac04-withdraw2-${bonded.id}`,
        },
      ),
    ).rejects.toMatchObject({
      code: "DISPUTE_VALIDATION",
      message: expect.stringContaining("withdrawal is legal only"),
    });
    // Only the challenger may withdraw.
    const other = await openBondedDispute(harness);
    await expect(
      harness.runtime.disputeService.withdrawDispute(
        reviewerCtx(harness, "w010-ac04-foreign-withdraw"),
        {
          disputeId: other.dispute.id,
          idempotencyKey: `w010-ac04-foreign-withdraw-${other.dispute.id}`,
        },
      ),
    ).rejects.toMatchObject({
      code: "DISPUTE_VALIDATION",
      message: expect.stringContaining("only the challenger"),
    });
  });

  test("appeals create a NEW linked record; the original flips to terminal APPEALED byte-identical", async () => {
    const { dispute, subject } = await openBondedDispute(harness, {
      withReview: true,
    });
    const resolved = await harness.runtime.disputeService.resolveDispute(
      reviewerCtx(harness, "w010-ac04-appeal-resolve"),
      {
        disputeId: dispute.id,
        outcome: "DENIED",
        controlDisposition: "MAINTAIN_CONTROL",
        reasonCodes: ["no_merit"],
        sourceRefs: [{ kind: "economic_value", id: subject.id }],
        idempotencyKey: `w010-ac04-appeal-resolve-${dispute.id}`,
      },
    );
    const resolutionBefore = resolved.resolution;
    const eventsBefore = resolved.events.length;

    // The beneficiary (the DENIED outcome's losing party is the
    // challenger — but the beneficiary has standing too) appeals
    // within the window.
    const effectiveAt = new Date(
      Date.parse(resolved.resolution!.resolvedAt) + 3600_000,
    ).toISOString();
    const appealed = await harness.runtime.disputeService.appealDispute(
      challengerCtx(harness, "w010-ac04-appeal"),
      {
        disputeId: resolved.id,
        statement: "the reviewer misread the evidence",
        reasonCodes: ["procedural_error"],
        supportingRefs: [{ kind: "economic_value", id: subject.id }],
        effectiveAt,
        idempotencyKey: `w010-ac04-appeal-${resolved.id}`,
      },
    );
    // The ORIGINAL: terminal APPEALED + forward pointer; the
    // resolution block and prior events stay byte-identical.
    expect(appealed.original.state).toBe("APPEALED");
    expect(appealed.original.appealDisputeId).toBe(appealed.appeal.id);
    expect(appealed.original.resolution).toEqual(resolutionBefore);
    expect(appealed.original.events.length).toBe(eventsBefore + 1);
    expect(
      appealed.original.events[appealed.original.events.length - 1]!.event,
    ).toBe("appealed");
    // The NEW appeal record: its own cycle.
    expect(appealed.appeal.kind).toBe("APPEAL");
    expect(appealed.appeal.appealOfDisputeId).toBe(resolved.id);
    expect(appealed.appeal.state).toBe("PENDING_STAKE");
    expect(appealed.appeal.challengerPersonId).toBe(harness.challengerPersonId);
    expect(appealed.appeal.subjectRef).toEqual(resolved.subjectRef);
    expect(appealed.appeal.window.challengeWindowExpiresAt).toBe(
      resolved.resolution!.appealWindowExpiresAt,
    );

    // A second appeal of the SAME original is refused (it is no
    // longer RESOLVED).
    await expect(
      harness.runtime.disputeService.appealDispute(
        challengerCtx(harness, "w010-ac04-appeal2"),
        {
          disputeId: resolved.id,
          statement: "again",
          reasonCodes: ["procedural_error"],
          supportingRefs: [{ kind: "economic_value", id: subject.id }],
          effectiveAt,
          idempotencyKey: `w010-ac04-appeal2-${resolved.id}`,
        },
      ),
    ).rejects.toMatchObject({ code: "DISPUTE_VALIDATION" });
  });

  test("appeals outside the window, and by parties without standing, are refused", async () => {
    const { dispute, subject } = await openBondedDispute(harness, {
      withReview: true,
    });
    const resolved = await harness.runtime.disputeService.resolveDispute(
      reviewerCtx(harness, "w010-ac04-appeal-window-resolve"),
      {
        disputeId: dispute.id,
        outcome: "UPHELD",
        controlDisposition: "RELEASE_CONTROL",
        reasonCodes: ["merits"],
        sourceRefs: [{ kind: "economic_value", id: subject.id }],
        idempotencyKey: `w010-ac04-awr-${dispute.id}`,
      },
    );
    const tooLate = new Date(
      Date.parse(resolved.resolution!.resolvedAt) + 7 * 24 * 60 * 60 * 1000 + 1000,
    ).toISOString();
    await expect(
      harness.runtime.disputeService.appealDispute(
        challengerCtx(harness, "w010-ac04-appeal-late"),
        {
          disputeId: resolved.id,
          statement: "too late",
          reasonCodes: ["x"],
          supportingRefs: [{ kind: "economic_value", id: subject.id }],
          effectiveAt: tooLate,
          idempotencyKey: `w010-ac04-appeal-late-${resolved.id}`,
        },
      ),
    ).rejects.toMatchObject({
      code: "DISPUTE_VALIDATION",
      message: expect.stringContaining("appeal window"),
    });
    // A third party has no standing.
    await expect(
      harness.runtime.disputeService.appealDispute(
        personCtx(harness, harness.reviewerPersonId, "w010-ac04-standing"),
        {
          disputeId: resolved.id,
          statement: "not my dispute",
          reasonCodes: ["x"],
          supportingRefs: [{ kind: "economic_value", id: subject.id }],
          effectiveAt: new Date(
            Date.parse(resolved.resolution!.resolvedAt) + 60_000,
          ).toISOString(),
          idempotencyKey: `w010-ac04-standing-${resolved.id}`,
        },
      ),
    ).rejects.toMatchObject({
      code: "DISPUTE_VALIDATION",
      message: expect.stringContaining("standing"),
    });
  });

  test("rejection (inadmissible) closes from OPEN and UNDER_REVIEW with refs required", async () => {
    const { dispute, subject } = await openBondedDispute(harness);
    // Missing supporting references → refused (material decisions
    // are evidence-backed).
    await expect(
      harness.runtime.disputeService.rejectDispute(
        reviewerCtx(harness, "w010-ac04-reject-norefs"),
        {
          disputeId: dispute.id,
          reasonCodes: ["inadmissible"],
          sourceRefs: [],
          idempotencyKey: `w010-ac04-reject-norefs-${dispute.id}`,
        },
      ),
    ).rejects.toMatchObject({ code: "RISK_SIGNAL_VALIDATION" });
    const rejected = await harness.runtime.disputeService.rejectDispute(
      reviewerCtx(harness, "w010-ac04-reject"),
      {
        disputeId: dispute.id,
        reasonCodes: ["inadmissible"],
        sourceRefs: [{ kind: "economic_value", id: subject.id }],
        idempotencyKey: `w010-ac04-reject-${dispute.id}`,
      },
    );
    expect(rejected.state).toBe("REJECTED");
    expect(rejected.events[rejected.events.length - 1]!.event).toBe("rejected");
  });
});
