/**
 * State machine — pure evaluator over the transition table.
 *
 * Work order ref: NET-W004 §4.3: "The work item must define the legal
 * transition matrix explicitly and reject every unspecified transition."
 * §4.8: "Workflow state changes are versioned and use optimistic
 * concurrency or equivalent conflict detection so stale writers cannot
 * overwrite newer state."
 *
 * The state machine is PURE — it has no side effects. It takes a
 * (currentSubject, targetState) pair and returns either:
 *  - the matching {@link TransitionRule} (legal transition); or
 *  - an {@link IllegalTransitionError} / {@link TerminalStateError}.
 *
 * The actual mutation (writing the new state, incrementing the version,
 * writing the audit record) is performed by the {@link WorkflowService}
 * within an authoritative transaction (see `workflow-service.ts`). The
 * state machine's purity makes it trivially testable: every legal
 * transition and every illegal transition can be enumerated by tests
 * without spinning up a transaction (AC-03).
 */

import {
  IllegalTransitionError,
  TerminalStateError,
  isTerminalState,
  type LifecycleState,
  type LifecycleSubject,
  type LifecycleSubjectKind,
} from "../core/workflow.ts";
import type { ExecutionContext } from "../core/execution-context.ts";
import { findRule, type TransitionRule } from "./transition-table.ts";

/**
 * Inputs to evaluateTransition.
 *
 * - `subject`: the current authoritative subject (state, version, etc.).
 * - `targetState`: the requested target state.
 * - `expectedVersion`: the caller's view of the subject's current
 *   version. Used for optimistic concurrency — when it does not match
 *   `subject.version`, the state machine rejects as
 *   {@link ConcurrentTransitionError}. Note: concurrency check is
 *   performed by the workflow service (which owns the transaction),
 *   not by the pure state machine — the state machine only checks
 *   legality (is the transition enumerated?).
 * - `execution`: the request's execution context (carried for lineage).
 */
export interface EvaluateTransitionInput {
  readonly subject: LifecycleSubject;
  readonly targetState: LifecycleState;
  readonly expectedVersion: number;
  readonly execution: ExecutionContext;
}

/**
 * The outcome of evaluating a transition.
 *
 *  - `legal`: true when the transition is enumerated in the table.
 *  - `rule`: the matching rule (present when `legal` is true).
 *  - `error`: the rejection reason (present when `legal` is false).
 */
export interface EvaluateTransitionResult {
  readonly legal: boolean;
  readonly rule?: TransitionRule;
  readonly error?: IllegalTransitionError | TerminalStateError;
}

/**
 * Evaluate a transition request against the transition table. PURE —
 * performs no side effects, mutates no state, writes no audit record.
 *
 * Returns `{ legal: true, rule }` when the (from, to) pair is enumerated.
 * Returns `{ legal: false, error }` otherwise:
 *  - {@link TerminalStateError} when the subject is already in a
 *    terminal state (work order §3.3).
 *  - {@link IllegalTransitionError} when the (from, to) pair is not in
 *    the table.
 *
 * The `subjectKind` is derived from the subject itself (it carries
 * its own kind discriminator so the state machine picks the correct
 * transition table).
 */
export function evaluateTransition(input: EvaluateTransitionInput): EvaluateTransitionResult {
  const { subject, targetState, execution } = input;
  const kind: LifecycleSubjectKind = subject.kind;

  // 1) Terminal state — no further transitions are legal.
  if (isTerminalState(subject.state)) {
    return {
      legal: false,
      error: new TerminalStateError(
        `subject ${subject.id} is in terminal state ${subject.state}; no further transitions are legal`,
        {
          subjectId: subject.id,
          subjectKind: kind,
          fromState: subject.state,
          toState: targetState,
          executionId: execution.executionId,
          correlationId: execution.correlationId,
        },
      ),
    };
  }

  // 2) Look up the rule for this (from, to) pair.
  const rule = findRule(kind, subject.state, targetState);
  if (!rule) {
    return {
      legal: false,
      error: new IllegalTransitionError(
        `illegal transition for ${kind} ${subject.id}: ${subject.state} → ${targetState} is not in the transition table`,
        {
          subjectId: subject.id,
          subjectKind: kind,
          fromState: subject.state,
          toState: targetState,
          executionId: execution.executionId,
          correlationId: execution.correlationId,
        },
      ),
    };
  }

  // 3) Legal transition.
  return { legal: true, rule };
}

/**
 * Convenience: throw the rejection error when a transition is illegal.
 * Used by the workflow service after evaluating.
 */
export function assertLegal(
  result: EvaluateTransitionResult,
): asserts result is { legal: true; rule: TransitionRule } {
  if (!result.legal) {
    throw result.error ?? new IllegalTransitionError("transition is not legal");
  }
}
