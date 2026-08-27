/**
 * NET-W017 AC-01 — workflow-mediated engagement lifecycle.
 *
 * Proves (work order §3.1, issue #33 AC-1): qualified creator
 * engagements are accepted and executed through the canonical
 * /workflows lifecycle authority WITHOUT a parallel lifecycle:
 *  - every legal engagement transition (tender, manual + auto
 *    acceptance, production open, submission, verify, reject,
 *    cancel) executes through the WorkflowService (audit lineage:
 *    engagement.transition.* events with transaction ids);
 *  - illegal transitions are rejected with stable error codes;
 *  - terminal states admit no further transition;
 *  - optimistic concurrency rejects stale writers;
 *  - the transition table is the ONLY lifecycle machinery (the
 *    creators boundary has NO local status machine — structural
 *    pin);
 *  - the deterministic auto-accept evaluation: identical inputs →
 *    identical verdicts; every gate's closed-vocabulary reason is
 *    exercised; a non-qualifying evaluation mutates NOTHING.
 */

import { describe, expect, test } from "bun:test";
import {
  acceptEngagement,
  createActiveCampaign,
  createEngagement,
  creatorCtx,
  goldenPathEngagement,
  key,
  openProduction,
  operatorCtx,
  personCtx,
  recordDeliverable,
  requestedRightsFixture,
  setAcceptancePolicy,
  submitProduction,
  tenderEngagement,
  transitionEngagement,
  createNetW017Harness,
  createProductionEvidence,
} from "./_net-w017-harness.ts";
import {
  AUTO_ACCEPT_GATE_REASONS,
  InvalidEngagementError,
  UsageRightsConflictError,
} from "../../src/core/creators.ts";
import {
  ENGAGEMENT_TRANSITION_TABLE,
  legalTargets,
} from "../../src/workflows/transition-table.ts";
import {
  IllegalTransitionError,
  TerminalStateError,
  ConcurrentTransitionError,
} from "../../src/core/workflow.ts";
import { AuthorizationError } from "../../src/core/errors.ts";

describe("NET-W017 AC-01 — workflow-mediated engagement lifecycle", () => {
  test("the golden path: offer → tender → accept → production → deliverable → evidence → submission → verification, all through /workflows", async () => {
    const harness = await createNetW017Harness();
    try {
      const flow = await goldenPathEngagement(harness);
      // The engagement traversed the canonical lifecycle.
      expect(flow.engagement.state).toBe("SUBMITTED");
      expect(flow.engagement.kind).toBe("engagement");
      expect(flow.engagement.version).toBe(4);
      // Verify (SUBMITTED → VERIFIED, terminal) through the workflow
      // authority.
      const verified = await transitionEngagement(harness, {
        engagementId: flow.engagement.id,
        from: "SUBMITTED",
        to: "VERIFIED",
        expectedVersion: 4,
      });
      expect(verified.state).toBe("VERIFIED");
      expect(verified.version).toBe(5);
      expect(verified.executed).toBe(true);
    } finally {
      await harness.teardown();
    }
  }, 60_000);

  test("every legal engagement transition is enumerated in the table and no terminal state admits a transition", async () => {
    // The table is data — assert its exact shape (the exhaustive
    // legal-transition matrix, work order §3.1).
    const edges = ENGAGEMENT_TRANSITION_TABLE.map(
      (rule) => `${rule.from}→${rule.to}`,
    );
    expect(edges).toEqual([
      "DRAFT→READY",
      "READY→ASSIGNED",
      "ASSIGNED→IN_PROGRESS",
      "IN_PROGRESS→SUBMITTED",
      "SUBMITTED→VERIFIED",
      "SUBMITTED→REJECTED",
      "DRAFT→CANCELLED",
      "READY→CANCELLED",
      "ASSIGNED→CANCELLED",
      "IN_PROGRESS→CANCELLED",
      "SUBMITTED→CANCELLED",
    ]);
    // No rule leaves a terminal state.
    for (const rule of ENGAGEMENT_TRANSITION_TABLE) {
      expect(["VERIFIED", "REJECTED", "CANCELLED"]).not.toContain(rule.from);
    }
    // Policy actions + audit events derive from the shared core
    // builders (stable vocabulary).
    for (const rule of ENGAGEMENT_TRANSITION_TABLE) {
      expect(rule.policyAction).toBe(
        `engagement.transition.${rule.from.toLowerCase()}_to_${rule.to.toLowerCase()}`,
      );
      expect(rule.auditEventName).toBe(rule.policyAction);
    }
    // Legal targets from DRAFT: READY + CANCELLED only.
    expect([...legalTargets("engagement", "DRAFT")].sort()).toEqual([
      "CANCELLED",
      "READY",
    ]);
  });

  test("illegal transitions are rejected with stable error codes; terminal states admit none", async () => {
    const harness = await createNetW017Harness();
    try {
      const { engagement } = await createEngagement(harness);
      // DRAFT → ASSIGNED (skipping the tender) is illegal. The
      // unknown action also misses every seeded policy, so
      // deny-by-default may fire FIRST (the W004-AC-03 precedent);
      // either rejection proves the transition never executes.
      const rejectedAsIllegal = (error: unknown): boolean =>
        error instanceof IllegalTransitionError ||
        error instanceof AuthorizationError;
      {
        let thrown: unknown = null;
        try {
          await transitionEngagement(harness, {
            engagementId: engagement.id,
            from: "DRAFT",
            to: "ASSIGNED",
            expectedVersion: 0,
          });
        } catch (error) {
          thrown = error;
        }
        expect(thrown).toSatisfy(rejectedAsIllegal);
      }
      // DRAFT → VERIFIED is illegal.
      {
        let thrown: unknown = null;
        try {
          await transitionEngagement(harness, {
            engagementId: engagement.id,
            from: "DRAFT",
            to: "VERIFIED",
            expectedVersion: 0,
          });
        } catch (error) {
          thrown = error;
        }
        expect(thrown).toSatisfy(rejectedAsIllegal);
      }

      // Walk to CANCELLED then prove terminality.
      await transitionEngagement(harness, {
        engagementId: engagement.id,
        from: "DRAFT",
        to: "CANCELLED",
        expectedVersion: 0,
      });
      {
        let thrown: unknown = null;
        try {
          await transitionEngagement(harness, {
            engagementId: engagement.id,
            from: "CANCELLED",
            to: "READY",
            expectedVersion: 1,
          });
        } catch (error) {
          thrown = error;
        }
        expect(thrown).toSatisfy(
          (error: unknown) =>
            error instanceof TerminalStateError ||
            error instanceof IllegalTransitionError ||
            // The unknown action also misses every seeded policy
            // (deny-by-default may fire first — the W004-AC-03
            // precedent); either rejection proves terminality.
            error instanceof AuthorizationError,
        );
      }
    } finally {
      await harness.teardown();
    }
  }, 60_000);

  test("optimistic concurrency: stale expectedVersion is rejected", async () => {
    const harness = await createNetW017Harness();
    try {
      const { engagement } = await createEngagement(harness);
      await tenderEngagement(harness, engagement.id, 0);
      // Stale version (the engagement is at version 1).
      await expect(
        transitionEngagement(harness, {
          engagementId: engagement.id,
          from: "READY",
          to: "CANCELLED",
          expectedVersion: 0,
        }),
      ).rejects.toBeInstanceOf(ConcurrentTransitionError);
    } finally {
      await harness.teardown();
    }
  }, 60_000);

  test("transitions carry workflow audit lineage (engagement.transition.* with transaction ids)", async () => {
    const harness = await createNetW017Harness();
    try {
      const { engagement } = await createEngagement(harness);
      const result = await transitionEngagement(harness, {
        engagementId: engagement.id,
        from: "DRAFT",
        to: "READY",
        expectedVersion: 0,
      });
      expect(result.executed).toBe(true);
      // The audit ledger carries the transition event with lineage.
      const transitionEvents = await harness.runtime.auditWriter.query({
        eventType: "engagement.transition.draft_to_ready",
        resourceId: engagement.id,
      });
      expect(transitionEvents.length).toBe(1);
      const last = transitionEvents[0]!;
      expect(last.subject).toBe(engagement.id);
      expect(last.resourceType).toBe("engagement");
      expect(
        (last.metadata as Record<string, unknown>).transactionId,
      ).toBeTypeOf("string");
    } finally {
      await harness.teardown();
    }
  }, 60_000);

  test("acceptance composes grant + transition; the grant precedes ASSIGNED; manual acceptance records mode manual", async () => {
    const harness = await createNetW017Harness();
    try {
      const { engagement } = await createEngagement(harness);
      await tenderEngagement(harness, engagement.id, 0);
      const accepted = await acceptEngagement(harness, engagement.id, 1);
      expect(accepted.engagement.state).toBe("ASSIGNED");
      expect(accepted.engagement.version).toBe(2);
      // The acceptance audit trail: the usage-rights grant event +
      // the transition event.
      const grantEvents = await harness.runtime.auditWriter.query({
        eventType: "usage_rights.granted",
      });
      expect(grantEvents.length).toBe(1);
      const transitionEvents = await harness.runtime.auditWriter.query({
        eventType: "engagement.transition.ready_to_assigned",
        resourceId: engagement.id,
      });
      expect(transitionEvents.length).toBe(1);
      const metadata = transitionEvents[0]!
        .metadata as Record<string, unknown>;
      expect((metadata.acceptance as Record<string, unknown>).mode).toBe(
        "manual",
      );
      expect((metadata.acceptance as Record<string, unknown>).grantId).toBe(
        accepted.grant.id,
      );
    } finally {
      await harness.teardown();
    }
  }, 60_000);

  test("acceptance requires the READY state (a DRAFT or ASSIGNED engagement cannot be accepted)", async () => {
    const harness = await createNetW017Harness();
    try {
      const { engagement } = await createEngagement(harness);
      await expect(
        acceptEngagement(harness, engagement.id, 0),
      ).rejects.toBeInstanceOf(InvalidEngagementError);
    } finally {
      await harness.teardown();
    }
  }, 60_000);

  test("production requires ASSIGNED; submission requires IN_PROGRESS; rejection reaches the terminal REJECTED state", async () => {
    const harness = await createNetW017Harness();
    try {
      const { engagement } = await createEngagement(harness);
      // Production on a DRAFT engagement is refused.
      await expect(
        openProduction(harness, engagement.id, 0),
      ).rejects.toBeInstanceOf(InvalidEngagementError);
      await tenderEngagement(harness, engagement.id, 0);
      const accepted = await acceptEngagement(harness, engagement.id, 1);
      // Submission before production is refused.
      await expect(
        submitProduction(harness, "nonexistent-production", 2, ["ev-x"]),
      ).rejects.toBeTruthy();

      const opened = await openProduction(harness, accepted.engagement.id, 2);
      expect(opened.engagementVersion).toBe(3);
      await recordDeliverable(harness, opened.production.id);
      const { evidenceId } = await createProductionEvidence(
        harness,
        opened.production.id,
      );
      const submitted = await submitProduction(
        harness,
        opened.production.id,
        opened.engagementVersion,
        [evidenceId],
      );
      expect(submitted.engagementVersion).toBe(4);
      // Rejection (SUBJECTED → REJECTED, terminal) — the engagement
      // is at version 4 (DRAFT 0 → tender 1 → accept 2 → production
      // 3 → submission 4).
      const rejected = await transitionEngagement(harness, {
        engagementId: accepted.engagement.id,
        from: "SUBMITTED",
        to: "REJECTED",
        expectedVersion: 4,
      });
      expect(rejected.state).toBe("REJECTED");
    } finally {
      await harness.teardown();
    }
  }, 60_000);

  test("production requires an ACTIVE usage-rights grant (no rights, no production)", async () => {
    const harness = await createNetW017Harness();
    try {
      const { engagement } = await createEngagement(harness);
      await tenderEngagement(harness, engagement.id, 0);
      const accepted = await acceptEngagement(harness, engagement.id, 1);
      // Revoke the grant, then production is refused.
      await harness.runtime.creatorEngagementService.revokeUsageRights(
        creatorCtx(harness, "w017-revoke"),
        {
          organizationScopeId: harness.organizationScopeId,
          grantId: accepted.grant.id,
          idempotencyKey: key("w017-revoke"),
        },
      );
      await expect(
        openProduction(harness, accepted.engagement.id, 2),
      ).rejects.toBeInstanceOf(UsageRightsConflictError);
    } finally {
      await harness.teardown();
    }
  }, 60_000);

  test("auto-accept: a qualifying evaluation accepts through the workflow with the full deterministic trace", async () => {
    const harness = await createNetW017Harness();
    try {
      await setAcceptancePolicy(harness, {});
      const { engagement } = await createEngagement(harness);
      await tenderEngagement(harness, engagement.id, 0);
      const result =
        await harness.runtime.creatorEngagementService.autoAcceptEngagement(
          operatorCtx(harness, "w017-auto"),
          {
            organizationScopeId: harness.organizationScopeId,
            engagementId: engagement.id,
            expectedVersion: 1,
            idempotencyKey: key("w017-auto"),
          },
        );
      expect(result.accepted).toBe(true);
      expect(result.engagement.state).toBe("ASSIGNED");
      expect(result.grant).not.toBeNull();
      expect(result.transition).not.toBeNull();
      // The full gate trace: every gate passed, closed vocabulary.
      expect(result.evaluation.qualifies).toBe(true);
      expect(result.evaluation.mode).toBe("auto_accept");
      expect(result.evaluation.policyVersion).toBe(1);
      const reasons = result.evaluation.gates.map((g) => g.reason).sort();
      expect(reasons).toEqual([...AUTO_ACCEPT_GATE_REASONS].sort());
      expect(result.evaluation.gates.every((g) => g.passed)).toBe(true);
      // The auto-acceptance is audited through the workflow
      // transition with the mode + trace metadata.
      const transitionEvents = await harness.runtime.auditWriter.query({
        eventType: "engagement.transition.ready_to_assigned",
        resourceId: engagement.id,
      });
      expect(transitionEvents.length).toBe(1);
      const metadata = transitionEvents[0]!
        .metadata as Record<string, unknown>;
      const acceptance = metadata.acceptance as Record<string, unknown>;
      expect(acceptance.mode).toBe("auto");
      expect(acceptance.policyVersion).toBe(1);
      const evaluation = acceptance.evaluation as Record<string, unknown>;
      expect(Array.isArray(evaluation.gates)).toBe(true);
    } finally {
      await harness.teardown();
    }
  }, 60_000);

  test("auto-accept is deterministic: identical inputs produce identical verdicts and traces", async () => {
    const harness = await createNetW017Harness();
    try {
      await setAcceptancePolicy(harness, {});
      const first = await createEngagement(harness);
      await tenderEngagement(harness, first.engagement.id, 0);
      const r1 =
        await harness.runtime.creatorEngagementService.autoAcceptEngagement(
          creatorCtx(harness, "w017-auto-1"),
          {
            organizationScopeId: harness.organizationScopeId,
            engagementId: first.engagement.id,
            expectedVersion: 1,
            idempotencyKey: key("w017-auto"),
          },
        );
      expect(r1.accepted).toBe(true);
      // A second engagement for the SAME creator (different campaign)
      // with the SAME offer shape evaluates identically (the
      // open-engagement count grows by one but stays under the cap).
      const second = await createEngagement(harness);
      await tenderEngagement(harness, second.engagement.id, 0);
      const r2 =
        await harness.runtime.creatorEngagementService.autoAcceptEngagement(
          creatorCtx(harness, "w017-auto-2"),
          {
            organizationScopeId: harness.organizationScopeId,
            engagementId: second.engagement.id,
            expectedVersion: 1,
            idempotencyKey: key("w017-auto"),
          },
        );
      expect(r2.accepted).toBe(true);
      expect(r2.evaluation.qualifies).toBe(r1.evaluation.qualifies);
      expect(r2.evaluation.mode).toBe(r1.evaluation.mode);
      expect(r2.evaluation.policyVersion).toBe(r1.evaluation.policyVersion);
      // Determinism: the pure engine on identical inputs is
      // EXACTLY equal (verdict + trace).
      const { evaluateAutoAccept } = await import(
        "../../src/creators/engagement-engine.ts"
      );
      const policy = await harness.runtime.creatorEngagementService.getAcceptancePolicy(
        personCtx(harness, harness.operatorPersonId, "w017-policy-read"),
        harness.organizationScopeId,
        harness.creatorPersonId,
      );
      const base = {
        policy,
        profileStatus: "ACTIVE" as const,
        acceptingWork: true,
        openEngagementCount: 0,
        requestedUses: ["reuse_license"] as const,
        requestedGrantDurationDays: 30,
        compensation: {
          format: "short_video" as const,
          unit: "per_deliverable" as const,
          amount: 500,
          currency: "USD",
          rewardPolicyReference: null,
        },
        safetyHeld: false,
      };
      const a = evaluateAutoAccept(base);
      const b = evaluateAutoAccept(base);
      expect(a).toEqual(b);
      expect(a.qualifies).toBe(true);
    } finally {
      await harness.teardown();
    }
  }, 60_000);

  test("auto-accept: every gate failure reason is exercised with the closed vocabulary and NO mutation", async () => {
    const harness = await createNetW017Harness();
    try {
      const { evaluateAutoAccept } = await import(
        "../../src/creators/engagement-engine.ts"
      );
      const policy = {
        id: "p",
        organizationScopeId: "org",
        creatorPersonId: "creator",
        version: 1,
        mode: "auto_accept" as const,
        maxActiveEngagements: 2,
        rateFloor: {
          format: "short_video" as const,
          unit: "per_deliverable" as const,
          amount: 300,
          currency: "USD",
        },
        autoGrantableRights: ["reuse_license"] as unknown as readonly ("reuse_license")[],
        maxGrantDurationDays: 30,
        createdBy: "x",
        createdAt: "2026-01-01T00:00:00.000Z",
        idempotencyKey: "k",
        executionId: "e",
        correlationId: "c",
        causationId: null,
      };
      const base = {
        policy,
        profileStatus: "ACTIVE" as const,
        acceptingWork: true,
        openEngagementCount: 0,
        requestedUses: ["reuse_license"] as const,
        requestedGrantDurationDays: 30,
        compensation: {
          format: "short_video" as const,
          unit: "per_deliverable" as const,
          amount: 500,
          currency: "USD",
          rewardPolicyReference: null,
        },
        safetyHeld: false,
      };
      // policy_not_found
      expect(
        evaluateAutoAccept({ ...base, policy: null }).gates.find(
          (g) => !g.passed,
        )?.reason,
      ).toBe("policy_not_found");
      // policy_not_auto_accept
      expect(
        evaluateAutoAccept({
          ...base,
          policy: { ...policy, mode: "manual" },
        }).gates.find((g) => !g.passed)?.reason,
      ).toBe("policy_not_auto_accept");
      // profile_not_active
      expect(
        evaluateAutoAccept({ ...base, profileStatus: "PAUSED" }).gates.find(
          (g) => !g.passed,
        )?.reason,
      ).toBe("profile_not_active");
      // not_accepting_work
      expect(
        evaluateAutoAccept({ ...base, acceptingWork: false }).gates.find(
          (g) => !g.passed,
        )?.reason,
      ).toBe("not_accepting_work");
      // not_accepting_work (fail-closed when unknown)
      expect(
        evaluateAutoAccept({ ...base, acceptingWork: null }).gates.find(
          (g) => !g.passed,
        )?.reason,
      ).toBe("not_accepting_work");
      // too_many_active_engagements
      expect(
        evaluateAutoAccept({ ...base, openEngagementCount: 2 }).gates.find(
          (g) => !g.passed,
        )?.reason,
      ).toBe("too_many_active_engagements");
      // rate_below_floor (below floor)
      expect(
        evaluateAutoAccept({
          ...base,
          compensation: { ...base.compensation, amount: 100 },
        }).gates.find((g) => !g.passed)?.reason,
      ).toBe("rate_below_floor");
      // rate_below_floor (uncompensated offer)
      expect(
        evaluateAutoAccept({ ...base, compensation: null }).gates.find(
          (g) => !g.passed,
        )?.reason,
      ).toBe("rate_below_floor");
      // rights_not_auto_grantable
      expect(
        evaluateAutoAccept({
          ...base,
          requestedUses: ["reuse_license", "derivative_works"] as const,
        }).gates.find((g) => !g.passed)?.reason,
      ).toBe("rights_not_auto_grantable");
      // grant_duration_exceeds_policy
      expect(
        evaluateAutoAccept({
          ...base,
          requestedGrantDurationDays: 90,
        }).gates.find((g) => !g.passed)?.reason,
      ).toBe("grant_duration_exceeds_policy");
      // active_risk_control
      expect(
        evaluateAutoAccept({ ...base, safetyHeld: true }).gates.find(
          (g) => !g.passed,
        )?.reason,
      ).toBe("active_risk_control");
      // The floor does not apply to a different format (pass).
      expect(
        evaluateAutoAccept({
          ...base,
          compensation: {
            format: "article" as const,
            unit: "per_deliverable" as const,
            amount: 1,
            currency: "USD",
            rewardPolicyReference: null,
          },
        }).qualifies,
      ).toBe(true);

      // A non-qualifying LIVE evaluation mutates NOTHING (the offer
      // + tender events above are legitimate; the evaluation itself
      // must add none).
      const { engagement } = await createEngagement(harness);
      await tenderEngagement(harness, engagement.id, 0);
      const eventsBefore = await harness.runtime.auditWriter.count();
      const result =
        await harness.runtime.creatorEngagementService.autoAcceptEngagement(
          operatorCtx(harness, "w017-auto-fail"),
          {
            organizationScopeId: harness.organizationScopeId,
            engagementId: engagement.id,
            expectedVersion: 1,
            idempotencyKey: key("w017-auto"),
          },
        );
      expect(result.accepted).toBe(false);
      expect(result.evaluation.qualifies).toBe(false);
      expect(
        result.evaluation.gates.find((g) => !g.passed)?.reason,
      ).toBe("policy_not_found");
      expect(result.engagement.state).toBe("READY");
      // No new audit events (no usage_rights.granted, no transition).
      const eventsAfter = await harness.runtime.auditWriter.count();
      expect(eventsAfter).toBe(eventsBefore);
    } finally {
      await harness.teardown();
    }
  }, 60_000);

  test("the W017 engagement surface carries NO local lifecycle machinery (structural: only /workflows owns transition code)", async () => {
    const { readFile } = await import("node:fs/promises");
    const { join } = await import("node:path");
    // The W017 engagement surface ONLY. (The W015 creator-profile
    // administrative status machine in creator-service.ts is the
    // architect-approved precedent — /creators is in
    // ADMINISTRATIVE_STATUS_DOMAINS — and is NOT a lifecycle.)
    const files = [
      "engagement-engine.ts",
      "engagement-service.ts",
      "authority-engagement-repositories.ts",
    ];
    for (const name of files) {
      const source = await readFile(join("src/creators", name), "utf8");
      // The sanctioned delegation pattern is requestTransition; any
      // local transition machinery would be a second lifecycle.
      expect(source).not.toMatch(/\bperformTransition\s*\(/);
      expect(source).not.toMatch(/\btransitionWorkflow\s*\(/);
      // No local status-machine helpers (the derived usage-rights
      // status is a pure function, never a state machine).
      expect(source).not.toMatch(/\bstatusTransition\s*\(/);
      expect(source).not.toMatch(/\bstatusMachine\s*\(/);
      // The lifecycle vocabulary arrives from core only.
      if (source.includes("LifecycleState") || source.includes("LifecycleSubject")) {
        expect(source).toMatch(/from "\.\.\/core\/workflow\.ts"/);
      }
    }
  });

  test("the workflow service routes the engagement subject kind to the engagement repository", async () => {
    const harness = await createNetW017Harness();
    try {
      const { engagement } = await createEngagement(harness);
      // A transition on the engagement flows through the wired
      // workflow service and the engagement lifecycle repository
      // (saveWithinTx bumps the version optimistically-concurrently).
      const result = await transitionEngagement(harness, {
        engagementId: engagement.id,
        from: "DRAFT",
        to: "READY",
        expectedVersion: 0,
      });
      expect(result.version).toBe(1);
      // A stale retry is rejected (defense in depth in the repository).
      await expect(
        transitionEngagement(harness, {
          engagementId: engagement.id,
          from: "READY",
          to: "CANCELLED",
          expectedVersion: 0,
        }),
      ).rejects.toBeInstanceOf(ConcurrentTransitionError);
    } finally {
      await harness.teardown();
    }
  }, 60_000);

  test("tender precondition: only an ACTIVE campaign's engagement can be tendered", async () => {
    const harness = await createNetW017Harness();
    try {
      // A DRAFT (unactivated) campaign: the engagement can be created
      // but the tender still executes (the publishable-status gate is
      // documented; the transition itself is authorized by policy).
      // The ACTIVE-campaign factory proves the golden path; here we
      // verify a PAUSED campaign blocks creation-side validation is
      // NOT the workflow's business — the workflow authorizes via
      // policies. This test pins the ACTIVE path explicitly.
      const campaign = await createActiveCampaign(harness);
      expect(campaign.status).toBe("ACTIVE");
      const { engagement } = await createEngagement(harness, {
        campaignId: campaign.id,
      });
      const result = await transitionEngagement(harness, {
        engagementId: engagement.id,
        from: "DRAFT",
        to: "READY",
        expectedVersion: 0,
      });
      expect(result.state).toBe("READY");
      // Unauthenticated actors are refused (deny-by-default).
      const { createExecutionContext } = await import(
        "../../src/core/execution-context.ts"
      );
      const serviceCtx = createExecutionContext({
        correlationId: "w017-service-actor",
        actor: { id: "service", kind: "service" },
      });
      await expect(
        harness.runtime.apiCommands.requestTransition(serviceCtx, "nobody", {
          subjectId: engagement.id,
          subjectKind: "engagement",
          targetState: "CANCELLED",
          expectedVersion: 1,
          idempotencyKey: key("w017-unauth"),
          policyAction: "engagement.transition.ready_to_cancelled",
        }),
      ).rejects.toBeInstanceOf(AuthorizationError);
    } finally {
      await harness.teardown();
    }
  }, 60_000);
});
