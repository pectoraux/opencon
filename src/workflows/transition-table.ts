/**
 * Transition table — the canonical, exhaustive legal-transition matrix
 * for the Opportunity/Contribution lifecycle (NET-W004 §3.3, §8), the
 * Proof-of-Value lifecycle (NET-W005 §3.8), and the measured-outcome
 * maturation lifecycle (NET-W006 §3.5).
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
 * NET-W005 §3.8 adds the Proof-of-Value lifecycle:
 *   DRAFT → MEASURING → EVALUATING → VERIFIED
 *   Exceptional: REJECTED (from MEASURING/EVALUATING), CANCELLED (from
 *   DRAFT/MEASURING/EVALUATING). The PoV reuses the canonical state
 * vocabulary (MEASURING = evidence gathering, EVALUATING = aggregation +
 * attestation, VERIFIED = terminal confirmation) so the state universe
 * stays small and the workflow machinery is untouched. The evidence
 * domain service validates PoV business preconditions (≥1 evidence for
 * MEASURING→EVALUATING; aggregation + ≥1 MEASURED/ATTESTED evidence +
 * ≥1 attestation for EVALUATING→VERIFIED) but NEVER mutates lifecycle
 * state itself — every transition routes through this table.
 *
 * This file is the SOLE lifecycle authority. Domain services that own
 * Opportunity/Contribution/Proof-of-Value entities may validate business
 * preconditions but may NOT mutate lifecycle state directly — they must
 * route every transition through the workflow service (which evaluates
 * this table).
 *
 * The table is data, not behaviour. The state machine in
 * `state-machine.ts` is a pure evaluator over this table.
 *
 * Out of scope (NET-W004 §5): no economic value, reputation, settlement,
 * fraud decision. NET-W005 attaches evidence/Proof-of-Value FOUNDATION
 * semantics (grades, confidence, aggregation, attestations) — still NO
 * economic value: the Proof-of-Value carries evidence lineage only;
 * credit issuance/settlement remain NET-W008.
 */

import type {
  CanonicalLifecycleState,
  ExceptionalLifecycleState,
  LifecycleState,
  LifecycleSubjectKind,
} from "../core/workflow.ts";
// NET-W005: the pure policy-action/audit-event string builders moved to
// CORE (src/core/workflow.ts) so domain services that REQUEST
// transitions (the evidence domain's PoV service) derive IDENTICAL
// actions without importing the workflows domain. Re-exported here for
// existing consumers.
import { policyActionFor, auditEventFor } from "../core/workflow.ts";

export { policyActionFor, auditEventFor };

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
 * The exhaustive transition table for Proof-of-Value objects
 * (NET-W005 §3.8). The PoV lifecycle reuses the canonical state
 * vocabulary with its intended semantics:
 *
 *   DRAFT      — created, referencing a subject + outcome claims
 *   MEASURING  — evidence gathering open (evidence being attached)
 *   EVALUATING — evidence complete; aggregation + attestations recorded
 *   VERIFIED   — terminal: the complete, verified Proof-of-Value
 *                (later work items — NET-W008 — reference it; credit
 *                issuance requires a VERIFIED PoV, architecture-lock §20)
 *
 * Exceptional states: REJECTED (deterministic evaluation rules failed —
 * from MEASURING or EVALUATING only; rejection is an evaluation outcome,
 * not a fraud decision — NET-W009/010 own fraud) and CANCELLED (owner
 * withdrew, from any non-terminal state).
 *
 * Domain preconditions validated by the evidence domain service BEFORE
 * requesting the transition (work order §3.8; the workflow remains the
 * sole lifecycle mutator):
 *  - MEASURING → EVALUATING requires ≥1 attached evidence record.
 *  - EVALUATING → VERIFIED requires a recorded aggregation + ≥1 MEASURED
 *    or ATTESTED evidence record (never model/self-assessed alone —
 *    architecture-lock §4: agent/model output is never authoritative)
 *    + ≥1 attached attestation.
 *
 * No BLOCKED/FRAUD_REVIEW/DISPUTED states for the PoV: fraud/dispute
 * semantics are NET-W009..010 non-goals (NET-W005 §5).
 */
export const PROOF_OF_VALUE_TRANSITION_TABLE: readonly TransitionRule[] = [
  {
    from: "DRAFT",
    to: "MEASURING",
    policyAction: policyActionFor("proof_of_value", "DRAFT", "MEASURING"),
    auditEventName: auditEventFor("proof_of_value", "DRAFT", "MEASURING"),
  },
  {
    from: "MEASURING",
    to: "EVALUATING",
    policyAction: policyActionFor("proof_of_value", "MEASURING", "EVALUATING"),
    auditEventName: auditEventFor("proof_of_value", "MEASURING", "EVALUATING"),
    // Requires at least one attached evidence record (validated by the
    // evidence domain service before the transition is requested).
    requiresEvidenceReference: true,
  },
  {
    from: "EVALUATING",
    to: "VERIFIED",
    policyAction: policyActionFor("proof_of_value", "EVALUATING", "VERIFIED"),
    auditEventName: auditEventFor("proof_of_value", "EVALUATING", "VERIFIED"),
    // Requires recorded aggregation + ≥1 MEASURED/ATTESTED evidence +
    // ≥1 attestation (validated by the evidence domain service).
    requiresEvidenceReference: true,
  },
  {
    from: "MEASURING",
    to: "REJECTED",
    policyAction: policyActionFor("proof_of_value", "MEASURING", "REJECTED"),
    auditEventName: auditEventFor("proof_of_value", "MEASURING", "REJECTED"),
  },
  {
    from: "EVALUATING",
    to: "REJECTED",
    policyAction: policyActionFor("proof_of_value", "EVALUATING", "REJECTED"),
    auditEventName: auditEventFor("proof_of_value", "EVALUATING", "REJECTED"),
  },
  {
    from: "DRAFT",
    to: "CANCELLED",
    policyAction: policyActionFor("proof_of_value", "DRAFT", "CANCELLED"),
    auditEventName: auditEventFor("proof_of_value", "DRAFT", "CANCELLED"),
  },
  {
    from: "MEASURING",
    to: "CANCELLED",
    policyAction: policyActionFor("proof_of_value", "MEASURING", "CANCELLED"),
    auditEventName: auditEventFor("proof_of_value", "MEASURING", "CANCELLED"),
  },
  {
    from: "EVALUATING",
    to: "CANCELLED",
    policyAction: policyActionFor("proof_of_value", "EVALUATING", "CANCELLED"),
    auditEventName: auditEventFor("proof_of_value", "EVALUATING", "CANCELLED"),
  },
  // VERIFIED / REJECTED / CANCELLED are terminal: the table
  // intentionally contains no rule whose source is a terminal state.
  // Note: DRAFT → REJECTED is intentionally NOT legal — rejection is
  // an evaluation outcome and therefore requires the PoV to have at
  // least entered MEASURING (evidence gathering).
];

/**
 * The exhaustive transition table for measured-outcome objects
 * (NET-W006 §3.5). The measured outcome reuses the canonical state
 * vocabulary with MATURATION semantics:
 *
 *   DRAFT      — measurement created (pending); observations /
 *                attributions / baselines / incrementality attachable
 *   MEASURING  — maturation window open; attachments still legal
 *                (delayed outcomes arrive during maturation)
 *   VERIFIED   — FINALIZED (terminal): the explicit, auditable
 *                terminal state of the measurement. Attachments are
 *                frozen. Later domains (Proof-of-Value, settlement)
 *                reference the finalized measurement.
 *   CANCELLED  — exceptional terminal (owner withdrew).
 *
 * Finalization can NEVER be silent: there is intentionally NO
 * DRAFT → VERIFIED edge — every measurement passes through the
 * maturation state, and MEASURING → VERIFIED is an explicit,
 * authorized, idempotent, audited workflow transition gated by the
 * outcomes domain service (recorded rollup + maturation strategy
 * gate: fixed_window requires the window to have elapsed;
 * event_driven requires an auditable maturationEvent reference).
 *
 * No BLOCKED/FRAUD_REVIEW/DISPUTED states for the measured outcome:
 * fraud/dispute semantics are NET-W009..010 non-goals (NET-W006 §5).
 * No REJECTED state: a measurement that cannot mature is CANCELLED;
 * rejection is an evaluation outcome owned by the Proof-of-Value
 * lifecycle (NET-W005 §3.8), not a measurement fact.
 */
export const OUTCOME_MEASUREMENT_TRANSITION_TABLE: readonly TransitionRule[] = [
  {
    from: "DRAFT",
    to: "MEASURING",
    policyAction: policyActionFor("outcome_measurement", "DRAFT", "MEASURING"),
    auditEventName: auditEventFor("outcome_measurement", "DRAFT", "MEASURING"),
  },
  {
    from: "MEASURING",
    to: "VERIFIED",
    policyAction: policyActionFor("outcome_measurement", "MEASURING", "VERIFIED"),
    auditEventName: auditEventFor("outcome_measurement", "MEASURING", "VERIFIED"),
    // Requires a recorded deterministic rollup + the maturation gate
    // (fixed_window elapsed / event_driven maturationEvent) —
    // validated by the outcomes domain service before the transition
    // is requested (work order §3.5/§3.6).
    requiresEvidenceReference: true,
  },
  {
    from: "DRAFT",
    to: "CANCELLED",
    policyAction: policyActionFor("outcome_measurement", "DRAFT", "CANCELLED"),
    auditEventName: auditEventFor("outcome_measurement", "DRAFT", "CANCELLED"),
  },
  {
    from: "MEASURING",
    to: "CANCELLED",
    policyAction: policyActionFor("outcome_measurement", "MEASURING", "CANCELLED"),
    auditEventName: auditEventFor("outcome_measurement", "MEASURING", "CANCELLED"),
  },
  // VERIFIED / CANCELLED are terminal: the table intentionally
  // contains no rule whose source is a terminal state. Note:
  // DRAFT → VERIFIED is intentionally NOT legal — finalization always
  // passes through the maturation state (cannot silently become
  // final; work order §3.5).
];

/**
 * The exhaustive transition table for creator ENGAGEMENTS
 * (NET-W017 §3.1). The engagement is the workflow-mediated
 * creator↔campaign work object; its lifecycle reuses the canonical
 * state vocabulary with production semantics:
 *
 *   DRAFT       — offer recorded (campaign + creator + requested
 *                 rights + optional match/opportunity lineage)
 *   READY       — offer tendered to the creator (campaign ACTIVE)
 *   ASSIGNED    — engagement accepted (creator manual acceptance OR
 *                 the deterministic auto-accept policy evaluation)
 *   IN_PROGRESS — production opened (the UGC production record)
 *   SUBMITTED   — deliverables + canonical evidence tendered
 *   VERIFIED    — terminal: submission verified
 *   REJECTED    — terminal: submission rejected (evaluation outcome)
 *   CANCELLED   — terminal: withdrawn before verification
 *
 * Domain preconditions validated by the creators domain service
 * BEFORE the transition is requested (the workflow remains the sole
 * lifecycle mutator):
 *  - DRAFT → READY requires the referenced campaign to be ACTIVE
 *    (the publishable-status precedent, resolved read-only through
 *    the neutral campaign lookup).
 *  - READY → ASSIGNED requires an explicit usage-rights grant
 *    (manual acceptance input or the auto-accept policy's
 *    auto-grantable envelope) — rights are explicit, never implicit.
 *  - ASSIGNED → IN_PROGRESS requires the UGC production record
 *    (openProduction composes record + transition).
 *  - IN_PROGRESS → SUBMITTED requires ≥1 recorded deliverable
 *    version + ≥1 canonical evidence reference, every reference
 *    subject-bound to the production (submitProduction composes
 *    submission record + transition).
 *
 * No BLOCKED/FRAUD_REVIEW/DISPUTED states for the engagement: risk
 * escalation is a /disputes case referencing the engagement, not a
 * local lifecycle branch (the PoV/measured-outcome precedent).
 */
export const ENGAGEMENT_TRANSITION_TABLE: readonly TransitionRule[] = [
  {
    from: "DRAFT",
    to: "READY",
    policyAction: policyActionFor("engagement", "DRAFT", "READY"),
    auditEventName: auditEventFor("engagement", "DRAFT", "READY"),
  },
  {
    from: "READY",
    to: "ASSIGNED",
    policyAction: policyActionFor("engagement", "READY", "ASSIGNED"),
    auditEventName: auditEventFor("engagement", "READY", "ASSIGNED"),
  },
  {
    from: "ASSIGNED",
    to: "IN_PROGRESS",
    policyAction: policyActionFor("engagement", "ASSIGNED", "IN_PROGRESS"),
    auditEventName: auditEventFor("engagement", "ASSIGNED", "IN_PROGRESS"),
  },
  {
    from: "IN_PROGRESS",
    to: "SUBMITTED",
    policyAction: policyActionFor("engagement", "IN_PROGRESS", "SUBMITTED"),
    auditEventName: auditEventFor("engagement", "IN_PROGRESS", "SUBMITTED"),
    // Requires ≥1 recorded deliverable + ≥1 subject-bound canonical
    // evidence reference (validated by the creators domain service
    // before the transition is requested — work order §3.4).
    requiresEvidenceReference: true,
  },
  {
    from: "SUBMITTED",
    to: "VERIFIED",
    policyAction: policyActionFor("engagement", "SUBMITTED", "VERIFIED"),
    auditEventName: auditEventFor("engagement", "SUBMITTED", "VERIFIED"),
    requiresEvidenceReference: true,
  },
  {
    from: "SUBMITTED",
    to: "REJECTED",
    policyAction: policyActionFor("engagement", "SUBMITTED", "REJECTED"),
    auditEventName: auditEventFor("engagement", "SUBMITTED", "REJECTED"),
  },
  {
    from: "DRAFT",
    to: "CANCELLED",
    policyAction: policyActionFor("engagement", "DRAFT", "CANCELLED"),
    auditEventName: auditEventFor("engagement", "DRAFT", "CANCELLED"),
  },
  {
    from: "READY",
    to: "CANCELLED",
    policyAction: policyActionFor("engagement", "READY", "CANCELLED"),
    auditEventName: auditEventFor("engagement", "READY", "CANCELLED"),
  },
  {
    from: "ASSIGNED",
    to: "CANCELLED",
    policyAction: policyActionFor("engagement", "ASSIGNED", "CANCELLED"),
    auditEventName: auditEventFor("engagement", "ASSIGNED", "CANCELLED"),
  },
  {
    from: "IN_PROGRESS",
    to: "CANCELLED",
    policyAction: policyActionFor("engagement", "IN_PROGRESS", "CANCELLED"),
    auditEventName: auditEventFor("engagement", "IN_PROGRESS", "CANCELLED"),
  },
  {
    from: "SUBMITTED",
    to: "CANCELLED",
    policyAction: policyActionFor("engagement", "SUBMITTED", "CANCELLED"),
    auditEventName: auditEventFor("engagement", "SUBMITTED", "CANCELLED"),
  },
  // VERIFIED / REJECTED / CANCELLED are terminal: the table
  // intentionally contains no rule whose source is a terminal state.
  // Note: SUBMITTED → REJECTED requires no evidence reference —
  // rejection is an evaluation outcome, not an evidence act; the
  // rejection REASON rides the transition metadata + audit event.
];

/**
 * The exhaustive transition table for creator PUBLICATIONS
 * (NET-W018 §3.4). The publication is the workflow-mediated record
 * of creator content going live on a channel; its lifecycle REUSES
 * the canonical state vocabulary (the W005/W006 precedent — the
 * state universe stays small, the workflow machinery is untouched):
 *
 *   DRAFT    — publication recorded (verified engagement + production
 *              + provider-neutral channel), disclosure obligations
 *              pending
 *   VERIFIED — terminal: publication VERIFIED — the applicable
 *              disclosure obligations are satisfied and canonical,
 *              subject-bound publication evidence is recorded
 *   CANCELLED — terminal: withdrawn before verification
 *
 * THE DISCLOSURE GATE (work order §2/§4 — the decision of record):
 * the DRAFT → VERIFIED transition is requested ONLY by the creators
 * domain's publication-verification composite AFTER it derives the
 * applicable disclosure obligations (campaign policy ∪ commercial-
 * relationship obligations — DURABLE RECORDS, never caller claims)
 * and proves every obligation satisfied by an evidence-bound
 * declaration for THIS publication. The workflow table itself stays
 * PURE routing (the W004 stance: `requiresEvidenceReference`
 * DECLARES the evidence-backed nature); the gate evaluation lives in
 * the creators domain service (src/creators/sponsorship-service.ts)
 * and composes the transition through the in-tx twin so the material
 * record + the gate + the transition commit as ONE authoritative
 * transaction (the NET-W017 remediation precedent).
 *
 * No BLOCKED/FRAUD_REVIEW/DISPUTED states for the publication: risk
 * escalation (e.g. a challenged disclosure) is a /disputes case
 * referencing the publication, not a local lifecycle branch (the
 * PoV/measured-outcome/engagement precedent).
 */
export const PUBLICATION_TRANSITION_TABLE: readonly TransitionRule[] = [
  {
    from: "DRAFT",
    to: "VERIFIED",
    policyAction: policyActionFor("publication", "DRAFT", "VERIFIED"),
    auditEventName: auditEventFor("publication", "DRAFT", "VERIFIED"),
    // Requires ≥1 subject-bound canonical publication-evidence
    // reference AND every applicable disclosure obligation satisfied
    // (validated by the creators domain's verification composite
    // BEFORE the transition is requested — the disclosure gate).
    requiresEvidenceReference: true,
  },
  {
    from: "DRAFT",
    to: "CANCELLED",
    policyAction: policyActionFor("publication", "DRAFT", "CANCELLED"),
    auditEventName: auditEventFor("publication", "DRAFT", "CANCELLED"),
  },
  // VERIFIED / CANCELLED are terminal: the table intentionally
  // contains no rule whose source is a terminal state. Retraction
  // AFTER verification is an explicit non-goal (a /disputes case + a
  // later work item own post-publication semantics).
];

/**
 * Look up the transition table for a subject kind.
 */
export function transitionTableFor(
  subjectKind: LifecycleSubjectKind,
): readonly TransitionRule[] {
  if (subjectKind === "opportunity") return OPPORTUNITY_TRANSITION_TABLE;
  if (subjectKind === "contribution") return CONTRIBUTION_TRANSITION_TABLE;
  if (subjectKind === "proof_of_value") return PROOF_OF_VALUE_TRANSITION_TABLE;
  if (subjectKind === "outcome_measurement") {
    return OUTCOME_MEASUREMENT_TRANSITION_TABLE;
  }
  if (subjectKind === "publication") return PUBLICATION_TRANSITION_TABLE;
  return ENGAGEMENT_TRANSITION_TABLE;
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
