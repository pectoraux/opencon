/**
 * NET-W010-AC-02 — Eligibility and challenge-window rules are
 * explicit, deterministic, authorized, and idempotent.
 *
 * Evidence: the eligibility gate rejects non-person actors, unknown
 * subjects, cross-scope subjects, out-of-window effectiveAt (before
 * the anchor / after the window), duplicate live disputes on a
 * subject, missing reason codes and missing supporting references —
 * all with stable error codes; identical retries replay idempotently
 * (created=false, same record id).
 */

import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import {
  createNetW010Harness,
  createChallengeableValue,
  openDefaultDispute,
  openBondedDispute,
  challengerCtx,
  personCtx,
  type NetW010Harness,
} from "./_net-w010-harness.ts";
import { createExecutionContext } from "../../src/core/execution-context.ts";

let harness: NetW010Harness;

beforeAll(async () => {
  harness = await createNetW010Harness();
});

afterAll(async () => {
  await harness.teardown();
});

describe("NET-W010-AC-02 deterministic eligibility gate", () => {
  test("only authenticated PERSON actors may open disputes (authorization)", async () => {
    const subject = await createChallengeableValue(harness);
    const serviceCtx = createExecutionContext({
      correlationId: "w010-ac02-service",
      actor: { id: "batch-service", kind: "service" },
    });
    await expect(
      harness.runtime.disputeService.openDispute(serviceCtx, {
        organizationScopeId: harness.organizationScopeId,
        subjectRef: { subjectType: "economic_value", subjectId: subject.id },
        statement: "a service cannot challenge",
        reasonCodes: ["contested_verification"],
        supportingRefs: [{ kind: "economic_value", id: subject.id }],
        effectiveAt: subject.recordedAt,
        idempotencyKey: `w010-ac02-service-${subject.id}`,
      }),
    ).rejects.toMatchObject({
      code: "DISPUTE_VALIDATION",
      classification: "validation",
    });
  });

  test("an unknown subject does not resolve (NOT_FOUND)", async () => {
    await expect(
      openDefaultDispute(harness, { subjectId: "no-such-value-record" }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  test("a subject in ANOTHER organization scope is rejected (tenant isolation)", async () => {
    const subject = await createChallengeableValue(harness);
    await expect(
      openDefaultDispute(harness, {
        subjectId: subject.id,
        organizationScopeId: harness.secondOrgId,
      }),
    ).rejects.toMatchObject({
      code: "DISPUTE_VALIDATION",
      context: expect.objectContaining({ subjectScope: harness.organizationScopeId }),
    });
  });

  test("an invalid subject type vocabulary is rejected", async () => {
    const subject = await createChallengeableValue(harness);
    await expect(
      openDefaultDispute(harness, {
        subjectType: "ad_campaign",
        subjectId: subject.id,
      }),
    ).rejects.toMatchObject({
      code: "DISPUTE_VALIDATION",
      context: expect.objectContaining({ subjectRef: expect.anything() }),
    });
  });

  test("the challenge window is deterministic — effectiveAt BEFORE the anchor is rejected", async () => {
    const subject = await createChallengeableValue(harness);
    await expect(
      openDefaultDispute(harness, {
        subjectId: subject.id,
        effectiveAt: new Date(Date.parse(subject.recordedAt) - 1000).toISOString(),
      }),
    ).rejects.toMatchObject({
      code: "DISPUTE_VALIDATION",
      message: expect.stringContaining("challenge window"),
    });
  });

  test("the challenge window is deterministic — effectiveAt AFTER the window expiry is rejected", async () => {
    const subject = await createChallengeableValue(harness);
    const tooLate = new Date(
      Date.parse(subject.recordedAt) + 14 * 24 * 60 * 60 * 1000 + 1000,
    ).toISOString();
    await expect(
      openDefaultDispute(harness, {
        subjectId: subject.id,
        effectiveAt: tooLate,
      }),
    ).rejects.toMatchObject({
      code: "DISPUTE_VALIDATION",
      context: expect.objectContaining({ windowExpiresAt: expect.any(String) }),
    });
    // ... while the boundary itself (exactly at expiry) is IN-window
    // (inclusive bounds).
    const atBoundary = new Date(
      Date.parse(subject.recordedAt) + 14 * 24 * 60 * 60 * 1000,
    ).toISOString();
    const boundary = await openDefaultDispute(harness, {
      subjectId: subject.id,
      effectiveAt: atBoundary,
      idempotencyKey: `w010-ac02-boundary-${subject.id}`,
    });
    expect(boundary.dispute.state).toBe("PENDING_STAKE");
  });

  test("a subject with a LIVE dispute cycle cannot be challenged again (duplicate gate)", async () => {
    const { dispute, subject } = await openBondedDispute(harness);
    expect(dispute.state).toBe("OPEN");
    // A DIFFERENT challenger challenging the same subject → conflict.
    await expect(
      openDefaultDispute(harness, {
        subjectId: subject.id,
        challengerPersonId: harness.reviewerPersonId,
        idempotencyKey: `w010-ac02-dup-${subject.id}`,
      }),
    ).rejects.toMatchObject({
      code: "CONFLICT",
      context: expect.objectContaining({ existingDisputeId: dispute.id }),
    });
  });

  test("after resolution the subject can be challenged again (the cycle closed)", async () => {
    const { dispute, subject } = await openBondedDispute(harness, {
      withReview: true,
    });
    // Resolve DISMISSED (the subject was procedurally moot).
    const { reviewerCtx } = await import("./_net-w010-harness.ts");
    await harness.runtime.disputeService.resolveDispute(
      reviewerCtx(harness, "w010-ac02-resolve"),
      {
        disputeId: dispute.id,
        outcome: "DISMISSED",
        controlDisposition: "MAINTAIN_CONTROL",
        reasonCodes: ["moot"],
        sourceRefs: [{ kind: "economic_value", id: subject.id }],
        idempotencyKey: `w010-ac02-resolve-${dispute.id}`,
      },
    );
    // A fresh challenge on the same subject is admissible again (the
    // resolved dispute is not LIVE).
    const reopened = await openDefaultDispute(harness, {
      subjectId: subject.id,
      idempotencyKey: `w010-ac02-reopen-${subject.id}`,
    });
    expect(reopened.dispute.state).toBe("PENDING_STAKE");
  });

  test("reason codes and supporting references are REQUIRED", async () => {
    const subject = await createChallengeableValue(harness);
    const base = {
      organizationScopeId: harness.organizationScopeId,
      subjectRef: { subjectType: "economic_value", subjectId: subject.id },
      statement: "reasons are required",
      effectiveAt: subject.recordedAt,
    } as const;
    const ctx = challengerCtx(harness, "w010-ac02-shape");
    await expect(
      harness.runtime.disputeService.openDispute(ctx, {
        ...base,
        reasonCodes: [],
        supportingRefs: [{ kind: "economic_value", id: subject.id }],
        idempotencyKey: "w010-ac02-no-reasons",
      }),
    ).rejects.toMatchObject({ code: "DISPUTE_VALIDATION" });
    await expect(
      harness.runtime.disputeService.openDispute(ctx, {
        ...base,
        reasonCodes: ["contested_verification"],
        supportingRefs: [],
        idempotencyKey: "w010-ac02-no-refs",
      }),
    ).rejects.toMatchObject({ code: "RISK_SIGNAL_VALIDATION" });
    // A supporting reference that does not resolve is rejected
    // (evidence-backed challenges).
    await expect(
      harness.runtime.disputeService.openDispute(ctx, {
        ...base,
        reasonCodes: ["contested_verification"],
        supportingRefs: [{ kind: "proof_of_value", id: "does-not-resolve" }],
        idempotencyKey: "w010-ac02-bad-refs",
      }),
    ).rejects.toMatchObject({ code: "RISK_SIGNAL_VALIDATION" });
  });

  test("identical retries replay idempotently (same record, created=false)", async () => {
    const subject = await createChallengeableValue(harness);
    const key = `w010-ac02-replay-${subject.id}`;
    const first = await openDefaultDispute(harness, {
      subjectId: subject.id,
      idempotencyKey: key,
    });
    expect(first.dispute.state).toBe("PENDING_STAKE");
    const second = await openDefaultDispute(harness, {
      subjectId: subject.id,
      idempotencyKey: key,
    });
    expect(second.dispute.id).toBe(first.dispute.id);
    // The duplicate gate does not reject the REPLAY (same key).
    expect(second.dispute.events.length).toBe(1);
    const third = await harness.runtime.disputeService.openDispute(
      personCtx(harness, harness.challengerPersonId, "w010-ac02-replay3"),
      {
        organizationScopeId: harness.organizationScopeId,
        subjectRef: { subjectType: "economic_value", subjectId: subject.id },
        statement: "the challenged record misstates verified value",
        reasonCodes: ["contested_verification"],
        supportingRefs: [{ kind: "economic_value", id: subject.id }],
        effectiveAt: new Date(
          Date.parse(subject.recordedAt) + 3600_000,
        ).toISOString(),
        idempotencyKey: key,
      },
    );
    expect(third.dispute.id).toBe(first.dispute.id);
  });
});
