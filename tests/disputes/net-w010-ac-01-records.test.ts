/**
 * NET-W010-AC-01 — Challenges/disputes are first-class durable scoped
 * records with immutable history.
 *
 * Evidence: opening a dispute creates a durable, organization-scoped
 * DisputeRecord (kind CHALLENGE, state PENDING_STAKE) with the frozen
 * stake requirement, deterministic window, supporting references,
 * policy lineage and the append-only event history; every lifecycle
 * step APPENDS events (prior events stay byte-identical); the record
 * is durable in the authority collection; listings are org-scoped and
 * tenant-isolated.
 */

import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import {
  createNetW010Harness,
  openBondedDispute,
  challengerCtx,
  type NetW010Harness,
} from "./_net-w010-harness.ts";
import {
  DISPUTE_POLICY_VERSION,
  DISPUTE_STAKE_REQUIREMENT_CREDITS,
} from "../../src/core/disputes.ts";

let harness: NetW010Harness;

beforeAll(async () => {
  harness = await createNetW010Harness();
});

afterAll(async () => {
  await harness.teardown();
});

describe("NET-W010-AC-01 first-class durable scoped dispute records", () => {
  test("opening a dispute creates the full first-class record (frozen requirement, window, lineage)", async () => {
    const { dispute, subject } = await openBondedDispute(harness);

    expect(dispute.id).toBeTruthy();
    expect(dispute.organizationScopeId).toBe(harness.organizationScopeId);
    expect(dispute.kind).toBe("CHALLENGE");
    expect(dispute.appealOfDisputeId).toBeNull();
    expect(dispute.challengerPersonId).toBe(harness.challengerPersonId);
    expect(dispute.subjectRef).toEqual({
      subjectType: "economic_value",
      subjectId: subject.id,
    });
    // The subject snapshot the eligibility gate used.
    expect(dispute.subjectAnchorAt).toBe(subject.recordedAt);
    expect(dispute.subjectBeneficiaryPersonId).toBe(harness.personId);
    expect(dispute.statement).toBeTruthy();
    expect(dispute.reasonCodes.length).toBeGreaterThan(0);
    expect(dispute.supportingRefs.length).toBeGreaterThan(0);
    // The frozen stake requirement + the deterministic window.
    expect(dispute.stake.requirement).toEqual({
      amount: DISPUTE_STAKE_REQUIREMENT_CREDITS,
      unit: "credits",
    });
    expect(dispute.stake.stakeId).toBeTruthy();
    expect(dispute.stake.bondedAt).toBeTruthy();
    expect(Date.parse(dispute.window.challengeWindowExpiresAt)).toBe(
      Date.parse(subject.recordedAt) + 14 * 24 * 60 * 60 * 1000,
    );
    // Policy lineage + execution lineage.
    expect(dispute.policyVersion).toBe(DISPUTE_POLICY_VERSION);
    expect(dispute.executionId).toBeTruthy();
    expect(dispute.correlationId).toBeTruthy();
    // The open dispute is formal (staked) — state OPEN.
    expect(dispute.state).toBe("OPEN");
    // Event history: requested + stake_bonded, in order.
    expect(dispute.events.map((e) => e.event)).toEqual([
      "requested",
      "stake_bonded",
    ]);
  });

  test("the event history is append-only — prior events stay byte-identical across lifecycle steps", async () => {
    const { dispute } = await openBondedDispute(harness, { withReview: true });
    const requested = dispute.events[0]!;
    const bonded = dispute.events[1]!;
    const reviewed = dispute.events[2]!;

    // The appended events carry actor identity + lineage.
    expect(requested.actorPersonId).toBe(harness.challengerPersonId);
    expect(bonded.event).toBe("stake_bonded");
    expect(reviewed.event).toBe("review_started");
    expect(reviewed.actorPersonId).toBe(harness.reviewerPersonId);
    expect(reviewed.executionId).toBeTruthy();
    expect(reviewed.correlationId).toBeTruthy();

    // Re-fetch: the first two events are byte-identical.
    const refetched = await harness.runtime.disputeService.getDispute(
      harness.bootstrapCtx,
      dispute.id,
    );
    expect(refetched.events[0]).toEqual(requested);
    expect(refetched.events[1]).toEqual(bonded);
    expect(refetched.events.length).toBe(3);
  });

  test("dispute records are durable in the authority collection", async () => {
    const { dispute } = await openBondedDispute(harness);
    const records = await harness.runtime.postgresAuthority.scan<{
      id: string;
      state: string;
    }>("disputes");
    const found = records.find((r) => r.value.id === dispute.id);
    expect(found).toBeTruthy();
    expect(found!.value.state).toBe("OPEN");
  });

  test("listings are organization-scoped (tenant isolation)", async () => {
    const { dispute } = await openBondedDispute(harness);
    const own = await harness.runtime.disputeService.listDisputes(
      harness.bootstrapCtx,
      harness.organizationScopeId,
    );
    expect(own.some((d) => d.id === dispute.id)).toBe(true);
    expect(
      own.every(
        (d) => d.organizationScopeId === harness.organizationScopeId,
      ),
    ).toBe(true);
    // A dispute about a record in ANOTHER org cannot even be opened
    // (subject scope mismatch — the eligibility gate).
    const other = await harness.runtime.disputeService.listDisputes(
      harness.bootstrapCtx,
      harness.secondOrgId,
    );
    expect(other.some((d) => d.id === dispute.id)).toBe(false);
  });

  test("state-filtered listings work", async () => {
    const { dispute } = await openBondedDispute(harness);
    const openOnes = await harness.runtime.disputeService.listDisputes(
      harness.bootstrapCtx,
      harness.organizationScopeId,
      ["OPEN"],
    );
    expect(openOnes.some((d) => d.id === dispute.id)).toBe(true);
    const resolvedOnes = await harness.runtime.disputeService.listDisputes(
      harness.bootstrapCtx,
      harness.organizationScopeId,
      ["RESOLVED"],
    );
    expect(resolvedOnes.some((d) => d.id === dispute.id)).toBe(false);
  });

  test("an unbonded dispute stays PENDING_STAKE and never gates (griefing resistance)", async () => {
    // Open WITHOUT bonding (the challenger's credits are not touched).
    const { createChallengeableValue } = await import("./_net-w010-harness.ts");
    const subject = await createChallengeableValue(harness);
    const opened = await harness.runtime.disputeService.openDispute(
      challengerCtx(harness, "w010-ac01-unbonded"),
      {
        organizationScopeId: harness.organizationScopeId,
        subjectRef: { subjectType: "economic_value", subjectId: subject.id },
        statement: "challenge without a stake yet",
        reasonCodes: ["contested_verification"],
        supportingRefs: [{ kind: "economic_value", id: subject.id }],
        effectiveAt: new Date(
          Date.parse(subject.recordedAt) + 3600_000,
        ).toISOString(),
        idempotencyKey: `w010-ac01-unbonded-${subject.id}`,
      },
    );
    expect(opened.dispute.state).toBe("PENDING_STAKE");
    expect(opened.dispute.stake.stakeId).toBeNull();
    // It is NOT in the active (gating) registry.
    const active =
      await harness.runtime.disputeService.listActiveBySubjectIds(
        harness.bootstrapCtx,
        harness.organizationScopeId,
        [subject.id],
      );
    expect(active.length).toBe(0);
  });
});
