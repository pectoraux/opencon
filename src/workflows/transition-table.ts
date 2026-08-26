/**
 * Transition table — the canonical, exhaustive legal-transition matrix
 * for the Opportunity/Contribution lifecycle (NET-W004 §3.3, §8).
 *
 * Work order ref: §3.3 Workflow authority:
 *   DRAFT → READY → ASSIGNED → IN_PROGRESS → SUBMITTED → MEASURING
 *   → EVALUATING → CHALLENGE_WINDOW → SETTLING → SETTLED → VERIFIED
 *   Exceptional: BLOCKED, FRAUD_REVIEW, DISPUTED, REJECTED, CANCELLED.
 * §4 Required invariants:
 *   1. Only `/workflows` may authoritatively transition lifecycle state.
 *   3. Illegal transitions fail deterministically with stable error codes.
 *   8. Workflow state changes are versioned + optimistic concurrency.
 * §8 Workflow state machine requirements: explicit transition table with
 *   source/target/required policy action/audit event name/version
 *   requirement.
 *
 * This file is the SOLE lifecycle authority. Domain services that own
 * Opportunity/Contribution entities may validate business preconditions
 * but may NOT mutate lifecycle state directly — they must route every
 * transition through the workflow service (which evaluates this table).
 *
 * The table is data, not behaviour. The state machine in
 * `state-machine.ts` is a pure evaluator over this table.
 *
 * Out of scope (work order §5): no economic value, reputation, settlement,
 * fraud decision, evidence evaluation or Proof-of-Value. Transitions
 * that require later domains are represented as states + preconditions
 * only. For example, `EVALUATING` is a state whose preconditions
 * (evidence presence) are checked by later work items; NET-W004 just
 * routes the transition legally. `SETTLING` / `SETTLED` similarly are
 * routing states; the actual settlement lives in NET-W008.
 */

import type {
  CanonicalLifecycleState,
  ExceptionalLifecycleState,
  LifecycleState,
  LifecycleSubjectKind,
} from "../core/workflow.ts";

/**
 * A single legal transition rule. Every entry in the transition table
 * is one of these (work order §8: source/target/required policy action/
 * audit event name/version requirement).
 *
 * - `from`: the source state.
 * - `to`: the target state.
 * - `policyAction`: the authorization action the workflow service
 *   evaluates against the AuthorizationService (e.g.
 *   "opportunity.transition.draft_to_ready"). Server-side; client-asserted
 *   claims are never trusted (work order §4.5).
 * - `auditEventName`: the audit event emitted atomically with the
 *   mutation. Namespaced by subject kind so audit consumers can filter.
 * - `requiresEvidenceReference`: when true, the transition MAY be
 *   blocked by a later work item that checks evidence presence. NET-W004
 *   only declares the requirement; it does not evaluate evidence.
 */
export interface TransitionRule {
  readonly from: LifecycleState;
  readonly to: LifecycleState;
  readonly policyAction: string;
  readonly auditEventName: string;
  readonly requiresEvidenceReference?: boolean;
}

/**
 * Build the policy-action string for a (subjectKind, from, to) triple.
 * Centralized so the table and the authorization policies stay aligned.
 */
export function policyActionFor(
  subjectKind: LifecycleSubjectKind,
  from: LifecycleState,
  to: LifecycleState,
): string {
  const fromKebab = from.toLowerCase();
  const toKebab = to.toLowerCase();
  return `${subjectKind}.transition.${fromKebab}_to_${toKebab}`;
}

/**
 * Build the audit event name for a (subjectKind, from, to) triple.
 */
export function auditEventFor(
  subjectKind: LifecycleSubjectKind,
  from: LifecycleState,
  to: LifecycleState,
): string {
  const fromKebab = from.toLowerCase();
  const toKebab = to.toLowerCase();
  return `${subjectKind}.transition.${fromKebab}_to_${toKebab}`;
}

/**
 * The canonical forward path (work order §3.3): DRAFT → READY → ASSIGNED
 * → IN_PROGRESS → SUBMITTED → MEASURING → EVALUATING → CHALLENGE_WINDOW
 * → SETTLING → SETTLED → VERIFIED. Two rules per pair: one for
 * opportunities, one for contributions.
 */
function canonicalForwardRules(
  subjectKind: LifecycleSubjectKind,
): readonly TransitionRule[] {
  const canonical: readonly CanonicalLifecycleState[] = [
    "DRAFT",
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
  const rules: TransitionRule[] = [];
  for (let i = 0; i < canonical.length - 1; i++) {
    const from = canonical[i]!;
    const to = canonical[i + 1]!;
    rules.push({
      from,
      to,
      policyAction: policyActionFor(subjectKind, from, to),
      auditEventName: auditEventFor(subjectKind, from, to),
      // EVALUATING → CHALLENGE_WINDOW requires evidence evaluation — but
      // NET-W004 only declares the precondition; later work items enforce
      // it (work order §5: no evidence evaluation in this work item).
      requiresEvidenceReference:
        from === "MEASURING" && to === "EVALUATING",
    });
  }
  return rules;
}

/**
 * Exceptional-state entry rules. A subject MAY transition from a
 * canonical state into an exceptional state under the conditions
 * enumerated here. The exceptional states themselves fall into two
 * groups:
 *  - recoverable (BLOCKED, FRAUD_REVIEW, DISPUTED): the subject may
 *    return to a canonical state via a `*_resolved` transition.
 *  - terminal (REJECTED, CANCELLED): no further legal transition.
 *
 * Exceptional rules apply to BOTH subject kinds.
 */
function exceptionalRules(
  subjectKind: LifecycleSubjectKind,
): readonly TransitionRule[] {
  const rules: TransitionRule[] = [];
  // BLOCKED: any non-terminal canonical state can be blocked.
  const blockable: readonly LifecycleState[] = [
    "DRAFT",
    "READY",
    "ASSIGNED",
    "IN_PROGRESS",
    "SUBMITTED",
    "MEASURING",
    "EVALUATING",
    "CHALLENGE_WINDOW",
    "SETTLING",
  ];
  for (const from of blockable) {
    rules.push({
      from,
      to: "BLOCKED",
      policyAction: policyActionFor(subjectKind, from, "BLOCKED"),
      auditEventName: auditEventFor(subjectKind, from, "BLOCKED"),
    });
  }
  // BLOCKED → original state (recovery). For simplicity, BLOCKED can
  // return to DRAFT, READY, or IN_PROGRESS (the most common recovery
  // targets). Returning to the EXACT prior state is the caller's
  // responsibility; the table enumerates the legal recoveries.
  for (const to of ["DRAFT", "READY", "IN_PROGRESS"] as const) {
    rules.push({
      from: "BLOCKED",
      to,
      policyAction: policyActionFor(subjectKind, "BLOCKED", to),
      auditEventName: auditEventFor(subjectKind, "BLOCKED", to),
    });
  }
  // FRAUD_REVIEW: any pre-settlement canonical state can be flagged.
  const fraudEligible: readonly LifecycleState[] = [
    "SUBMITTED",
    "MEASURING",
    "EVALUATING",
    "CHALLENGE_WINDOW",
    "SETTLING",
  ];
  for (const from of fraudEligible) {
    rules.push({
      from,
      to: "FRAUD_REVIEW",
      policyAction: policyActionFor(subjectKind, from, "FRAUD_REVIEW"),
      auditEventName: auditEventFor(subjectKind, from, "FRAUD_REVIEW"),
    });
  }
  // FRAUD_REVIEW → DISPUTED or back to SUBMITTED (cleared).
  rules.push({
    from: "FRAUD_REVIEW",
    to: "DISPUTED",
    policyAction: policyActionFor(subjectKind, "FRAUD_REVIEW", "DISPUTED"),
    auditEventName: auditEventFor(subjectKind, "FRAUD_REVIEW", "DISPUTED"),
  });
  rules.push({
    from: "FRAUD_REVIEW",
    to: "SUBMITTED",
    policyAction: policyActionFor(subjectKind, "FRAUD_REVIEW", "SUBMITTED"),
    auditEventName: auditEventFor(subjectKind, "FRAUD_REVIEW", "SUBMITTED"),
  });
  // DISPUTED → REJECTED (terminal) or back to CHALLENGE_WINDOW (resolved).
  rules.push({
    from: "DISPUTED",
    to: "REJECTED",
    policyAction: policyActionFor(subjectKind, "DISPUTED", "REJECTED"),
    auditEventName: auditEventFor(subjectKind, "DISPUTED", "REJECTED"),
  });
  rules.push({
    from: "DISPUTED",
    to: "CHALLENGE_WINDOW",
    policyAction: policyActionFor(subjectKind, "DISPUTED", "CHALLENGE_WINDOW"),
    auditEventName: auditEventFor(subjectKind, "DISPUTED", "CHALLENGE_WINDOW"),
  });
  // REJECTED (terminal): no further transition. The table intentionally
  // contains no rule with from = "REJECTED".
  // CANCELLED: any non-terminal canonical state can be cancelled.
  // Applies before SETTLED (after SETTLED the value is locked — work
  // order §5: no settlement behaviour in this work item).
  const cancellable: readonly LifecycleState[] = [
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
    rules.push({
      from,
      to: "CANCELLED",
      policyAction: policyActionFor(subjectKind, from, "CANCELLED"),
      auditEventName: auditEventFor(subjectKind, from, "CANCELLED"),
    });
  }
  // CANCELLED (terminal): no further transition.
  // REJECTED direct (without dispute): DISPUTED → REJECTED is the only
  // path to REJECTED in this table — direct REJECTED from a canonical
  // state is intentionally not allowed (work order §3.3: REJECTED is an
  // exceptional state reached via dispute resolution).
  return rules;
}

/**
 * The exhaustive transition table for opportunities. Combines the
 * canonical forward path with the exceptional-state entries.
 */
export const OPPORTUNITY_TRANSITION_TABLE: readonly TransitionRule[] = [
  ...canonicalForwardRules("opportunity"),
  ...exceptionalRules("opportunity"),
];

/**
 * The exhaustive transition table for contributions. Combines the
 * canonical forward path with the exceptional-state entries.
 */
export const CONTRIBUTION_TRANSITION_TABLE: readonly TransitionRule[] = [
  ...canonicalForwardRules("contribution"),
  ...exceptionalRules("contribution"),
];

/**
 * Look up the transition table for a subject kind.
 */
export function transitionTableFor(
  subjectKind: LifecycleSubjectKind,
): readonly TransitionRule[] {
  return subjectKind === "opportunity"
    ? OPPORTUNITY_TRANSITION_TABLE
    : CONTRIBUTION_TRANSITION_TABLE;
}

/**
 * Find the legal rule for a (subjectKind, from, to) triple. Returns null
 * when no rule exists — the state machine rejects as IllegalTransitionError.
 */
export function findRule(
  subjectKind: LifecycleSubjectKind,
  from: LifecycleState,
  to: LifecycleState,
): TransitionRule | null {
  const table = transitionTableFor(subjectKind);
  for (const rule of table) {
    if (rule.from === from && rule.to === to) return rule;
  }
  return null;
}

/**
 * Return all legal target states from a given source state for a
 * subject kind. Used by tests to exhaustively assert "every legal
 * transition succeeds" (AC-03) and "every illegal transition is
 * rejected" (AC-03).
 */
export function legalTargets(
  subjectKind: LifecycleSubjectKind,
  from: LifecycleState,
): readonly LifecycleState[] {
  const table = transitionTableFor(subjectKind);
  const targets = new Set<LifecycleState>();
  for (const rule of table) {
    if (rule.from === from) targets.add(rule.to);
  }
  return Array.from(targets);
}

/**
 * Return the full list of all lifecycle states (canonical + exceptional).
 */
export function ALL_LIFECYCLE_STATES(): readonly LifecycleState[] {
  return [
    ...[
      "DRAFT",
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
    ] as readonly CanonicalLifecycleState[],
    ...[
      "BLOCKED",
      "FRAUD_REVIEW",
      "DISPUTED",
      "REJECTED",
      "CANCELLED",
    ] as readonly ExceptionalLifecycleState[],
  ];
}
