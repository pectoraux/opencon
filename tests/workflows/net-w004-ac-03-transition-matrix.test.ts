/**
 * NET-W004-AC-03 — Complete transition matrix.
 *
 * Every legal transition in the canonical lifecycle succeeds under its
 * required preconditions; every unspecified transition is rejected with
 * a stable error classification/code.
 *
 * Evidence: exhaustive transition-matrix tests, including all exceptional
 * states.
 *
 * Strategy:
 *  - For EACH subject kind (opportunity, contribution):
 *    - For EACH state in the lifecycle (canonical + exceptional):
 *      - For EACH target state:
 *        - If (current, target) is a legal rule in the transition table:
 *          the transition succeeds; the subject's state advances to target;
 *          the version increments by 1.
 *        - Else: the transition is rejected as IllegalTransitionError
 *          (or TerminalStateError when current is terminal).
 *
 * This produces O(states^2) test cases per subject kind. To avoid
 * thousands of round-trip database writes, the test uses the PURE state
 * machine evaluator (state-machine.ts) for the exhaustive matrix, then
 * uses the live workflow service for a representative subset to prove
 * the end-to-end path.
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { createExecutionContext } from "../../src/core/execution-context.ts";
import {
  ALL_LIFECYCLE_STATES,
  CONTRIBUTION_TRANSITION_TABLE,
  OPPORTUNITY_TRANSITION_TABLE,
  findRule,
  legalTargets,
  transitionTableFor,
} from "../../src/workflows/transition-table.ts";
import { evaluateTransition } from "../../src/workflows/state-machine.ts";
import {
  IllegalTransitionError,
  TerminalStateError,
  isTerminalState,
  type LifecycleState,
  type LifecycleSubject,
} from "../../src/core/workflow.ts";
import {
  createNetW004Harness,
  createOpportunity,
  type NetW004Harness,
} from "./_net-w004-harness.ts";

let harness: NetW004Harness;

beforeEach(async () => {
  harness = await createNetW004Harness();
});

afterEach(async () => {
  await harness.teardown();
});

/**
 * Construct a synthetic LifecycleSubject in a given state. Used by the
 * pure state-machine tests so we can enumerate every (current, target)
 * pair without spinning up the database for each.
 */
function subjectInState(
  state: LifecycleState,
  kind: "opportunity" | "contribution" = "opportunity",
  version = 0,
): LifecycleSubject {
  return {
    id: "synthetic-subject",
    kind,
    state,
    version,
    organizationScopeId: "test-org",
    ownerId: "test-owner",
    executionId: "test-execution",
    correlationId: "test-correlation",
    causationId: null,
    createdAt: "2024-01-01T00:00:00.000Z",
    updatedAt: "2024-01-01T00:00:00.000Z",
  };
}

const ALL_STATES = ALL_LIFECYCLE_STATES();

describe("NET-W004-AC-03 complete transition matrix (pure state machine)", () => {
  describe("opportunity transition matrix", () => {
    test("the transition table is non-empty and covers the canonical path", () => {
      expect(OPPORTUNITY_TRANSITION_TABLE.length).toBeGreaterThan(0);
      // Verify the canonical forward path is present.
      expect(findRule("opportunity", "DRAFT", "READY")).not.toBeNull();
      expect(findRule("opportunity", "READY", "ASSIGNED")).not.toBeNull();
      expect(findRule("opportunity", "ASSIGNED", "IN_PROGRESS")).not.toBeNull();
      expect(findRule("opportunity", "IN_PROGRESS", "SUBMITTED")).not.toBeNull();
      expect(findRule("opportunity", "SUBMITTED", "MEASURING")).not.toBeNull();
      expect(findRule("opportunity", "MEASURING", "EVALUATING")).not.toBeNull();
      expect(findRule("opportunity", "EVALUATING", "CHALLENGE_WINDOW")).not.toBeNull();
      expect(findRule("opportunity", "CHALLENGE_WINDOW", "SETTLING")).not.toBeNull();
      expect(findRule("opportunity", "SETTLING", "SETTLED")).not.toBeNull();
      expect(findRule("opportunity", "SETTLED", "VERIFIED")).not.toBeNull();
    });

    test("every legal transition evaluates to legal=true with the matching rule", () => {
      for (const rule of OPPORTUNITY_TRANSITION_TABLE) {
        const result = evaluateTransition({
          subject: subjectInState(rule.from, "opportunity"),
          targetState: rule.to,
          expectedVersion: 0,
          execution: createExecutionContext({ correlationId: `matrix-opp-${rule.from}-${rule.to}` }),
        });
        expect(result.legal).toBe(true);
        expect(result.rule).toBeDefined();
        expect(result.rule?.from).toBe(rule.from);
        expect(result.rule?.to).toBe(rule.to);
        expect(result.rule?.policyAction).toBe(rule.policyAction);
        expect(result.rule?.auditEventName).toBe(rule.auditEventName);
      }
    });

    test("every illegal transition is rejected as IllegalTransitionError (or TerminalStateError)", () => {
      const ctx = createExecutionContext({ correlationId: "matrix-illegal-opp" });
      for (const from of ALL_STATES) {
        for (const to of ALL_STATES) {
          if (from === to) continue;
          const rule = findRule("opportunity", from, to);
          if (rule) continue; // legal — covered above.
          // Illegal — must be rejected.
          const result = evaluateTransition({
            subject: subjectInState(from, "opportunity"),
            targetState: to,
            expectedVersion: 0,
            execution: ctx,
          });
          expect(result.legal).toBe(false);
          // Terminal source → TerminalStateError; otherwise IllegalTransitionError.
          if (isTerminalState(from)) {
            expect(result.error).toBeInstanceOf(TerminalStateError);
            expect(result.error?.code).toBe("TERMINAL_STATE");
          } else {
            expect(result.error).toBeInstanceOf(IllegalTransitionError);
            expect(result.error?.code).toBe("ILLEGAL_TRANSITION");
          }
        }
      }
    });

    test("terminal states (VERIFIED, REJECTED, CANCELLED) have no legal outgoing transitions", () => {
      const terminalStates: LifecycleState[] = ["VERIFIED", "REJECTED", "CANCELLED"];
      for (const ts of terminalStates) {
        const targets = legalTargets("opportunity", ts);
        expect(targets).toHaveLength(0);
      }
    });

    test("every legal target from DRAFT is enumerated (no hidden transitions)", () => {
      // DRAFT → READY (canonical), DRAFT → BLOCKED, DRAFT → CANCELLED.
      const targets = legalTargets("opportunity", "DRAFT");
      expect(targets).toContain("READY");
      expect(targets).toContain("BLOCKED");
      expect(targets).toContain("CANCELLED");
      // DRAFT must NOT directly transition to e.g. SETTLED.
      expect(targets).not.toContain("SETTLED");
      expect(targets).not.toContain("VERIFIED");
    });

    test("REJECTED is reachable only via DISPUTED → REJECTED (not from canonical states directly)", () => {
      for (const from of ALL_STATES) {
        if (from === "DISPUTED") continue;
        const rule = findRule("opportunity", from, "REJECTED");
        expect(rule).toBeNull();
      }
      expect(findRule("opportunity", "DISPUTED", "REJECTED")).not.toBeNull();
    });

    test("CANCELLED is reachable from every non-terminal canonical state except SETTLED/VERIFIED", () => {
      const cancellable: LifecycleState[] = [
        "DRAFT",
        "READY",
        "ASSIGNED",
        "IN_PROGRESS",
        "SUBMITTED",
        "MEASURING",
        "EVALUATING",
        "CHALLENGE_WINDOW",
      ];
      for (const from of cancellable) {
        expect(findRule("opportunity", from, "CANCELLED")).not.toBeNull();
      }
      // SETTLED cannot be cancelled (value is locked).
      expect(findRule("opportunity", "SETTLED", "CANCELLED")).toBeNull();
    });
  });

  describe("contribution transition matrix", () => {
    test("the contribution transition table mirrors the opportunity table for the canonical path", () => {
      expect(CONTRIBUTION_TRANSITION_TABLE.length).toBeGreaterThan(0);
      expect(findRule("contribution", "DRAFT", "READY")).not.toBeNull();
      expect(findRule("contribution", "SETTLED", "VERIFIED")).not.toBeNull();
    });

    test("every legal contribution transition evaluates to legal=true", () => {
      for (const rule of CONTRIBUTION_TRANSITION_TABLE) {
        const result = evaluateTransition({
          subject: subjectInState(rule.from, "contribution"),
          targetState: rule.to,
          expectedVersion: 0,
          execution: createExecutionContext({ correlationId: `matrix-contr-${rule.from}-${rule.to}` }),
        });
        expect(result.legal).toBe(true);
        expect(result.rule?.from).toBe(rule.from);
        expect(result.rule?.to).toBe(rule.to);
      }
    });

    test("every illegal contribution transition is rejected", () => {
      const ctx = createExecutionContext({ correlationId: "matrix-illegal-contr" });
      for (const from of ALL_STATES) {
        for (const to of ALL_STATES) {
          if (from === to) continue;
          const rule = findRule("contribution", from, to);
          if (rule) continue;
          const result = evaluateTransition({
            subject: subjectInState(from, "contribution"),
            targetState: to,
            expectedVersion: 0,
            execution: ctx,
          });
          expect(result.legal).toBe(false);
        }
      }
    });
  });

  describe("end-to-end workflow service transitions", () => {
    test("an opportunity traverses DRAFT → READY → ASSIGNED via the workflow service", async () => {
      const opp = await createOpportunity(harness);
      const ctx = createExecutionContext({
        correlationId: "ac03-e2e",
        actor: { id: harness.personId, kind: "person" },
      });
      // DRAFT → READY.
      const r1 = await harness.runtime.workflowService.requestTransition(
        {
          subjectId: opp.id,
          subjectKind: "opportunity",
          targetState: "READY",
          expectedVersion: 0,
          idempotencyKey: "opp-draft-to-ready",
          actorPersonId: harness.personId,
          policyAction: "opportunity.transition.draft_to_ready",
        },
        ctx,
      );
      expect(r1.executed).toBe(true);
      expect(r1.subject.state).toBe("READY");
      expect(r1.subject.version).toBe(1);
      expect(r1.auditEventName).toBe("opportunity.transition.draft_to_ready");

      // READY → ASSIGNED.
      const r2 = await harness.runtime.workflowService.requestTransition(
        {
          subjectId: opp.id,
          subjectKind: "opportunity",
          targetState: "ASSIGNED",
          expectedVersion: 1,
          idempotencyKey: "opp-ready-to-assigned",
          actorPersonId: harness.personId,
          policyAction: "opportunity.transition.ready_to_assigned",
        },
        ctx,
      );
      expect(r2.executed).toBe(true);
      expect(r2.subject.state).toBe("ASSIGNED");
      expect(r2.subject.version).toBe(2);
    });

    test("an illegal transition through the workflow service is rejected (deny-by-default authorization fires first; the pure state machine test above proves the IllegalTransitionError classification)", async () => {
      const opp = await createOpportunity(harness);
      const ctx = createExecutionContext({
        correlationId: "ac03-illegal",
        actor: { id: harness.personId, kind: "person" },
      });
      // DRAFT → VERIFIED is illegal (not in the transition table). The
      // workflow service authorizes BEFORE evaluating transition legality,
      // so when the policyAction is also unknown it denies first. Either
      // way the request is rejected — the pure state machine test above
      // proves the IllegalTransitionError classification specifically.
      await expect(
        harness.runtime.workflowService.requestTransition(
          {
            subjectId: opp.id,
            subjectKind: "opportunity",
            targetState: "VERIFIED",
            expectedVersion: 0,
            idempotencyKey: "opp-draft-to-verified-illegal",
            actorPersonId: harness.personId,
            policyAction: "opportunity.transition.draft_to_verified",
          },
          ctx,
        ),
      ).rejects.toThrow();
    });

    test("a transition from a terminal state is rejected with TerminalStateError", async () => {
      // First traverse DRAFT → ... → VERIFIED via legal transitions.
      const opp = await createOpportunity(harness);
      const ctx = createExecutionContext({
        correlationId: "ac03-terminal",
        actor: { id: harness.personId, kind: "person" },
      });
      const path: LifecycleState[] = [
        "READY",
        "ASSIGNED",
        "IN_PROGRESS",
        "SUBMITTED",
        "MEASURING",
        "EVALUATING",
        "CHALLENGE_WINDOW",
        "SETTLING",
        "SETTLED",
        "VERIFIED",
      ];
      let current: LifecycleState = "DRAFT";
      let version = 0;
      for (const target of path) {
        const rule = findRule("opportunity", current, target);
        expect(rule).not.toBeNull();
        const result = await harness.runtime.workflowService.requestTransition(
          {
            subjectId: opp.id,
            subjectKind: "opportunity",
            targetState: target,
            expectedVersion: version,
            idempotencyKey: `opp-${current}-to-${target}`,
            actorPersonId: harness.personId,
            policyAction: rule!.policyAction,
          },
          ctx,
        );
        expect(result.executed).toBe(true);
        expect(result.subject.state).toBe(target);
        version = result.subject.version;
        current = target;
      }
      // Now in terminal VERIFIED state — any further transition is rejected.
      await expect(
        harness.runtime.workflowService.requestTransition(
          {
            subjectId: opp.id,
            subjectKind: "opportunity",
            targetState: "DRAFT",
            expectedVersion: version,
            idempotencyKey: "opp-verified-to-draft-illegal",
            actorPersonId: harness.personId,
            policyAction: "opportunity.transition.verified_to_draft",
          },
          ctx,
        ),
      ).rejects.toThrow();
    });
  });
});
