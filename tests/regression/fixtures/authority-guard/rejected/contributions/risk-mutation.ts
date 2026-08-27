/**
 * NEGATIVE fixture — must be REJECTED: risk mutation inside /contributions.
 *
 * Watchpoint 2: /contributions owns quality/moderation semantics, but
 * risk mutation remains a composition-root concern (the NET-W013
 * boundary — moderation outcomes are TRANSLATED into risk signals at
 * the bootstrap boundary, never emitted from the contribution domain
 * itself).
 *
 * Expected violation: risk-authority-mutation (createRiskSignal).
 */

export interface ModerationOutcome {
  readonly contributionId: string;
  readonly decision: "flagged" | "rejected";
}

export async function escalateToRisk(outcome: ModerationOutcome): Promise<void> {
  await createRiskSignal({
    subjectKind: "contribution",
    subjectId: outcome.contributionId,
    category: "spam",
    decision: outcome.decision,
  });
}
