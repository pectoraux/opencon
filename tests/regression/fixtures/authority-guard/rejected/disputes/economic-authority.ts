/**
 * NEGATIVE fixture — must be REJECTED: /disputes becoming a second
 * economic and reputation authority.
 *
 * Watchpoint 1: /disputes is the single fraud/risk control authority.
 * It must not mutate money, Participation Credits, or trust state —
 * those belong to /settlement and /reputation, composed at the
 * bootstrap boundary.
 *
 * Expected violations: economic-authority-mutation (issueCredits,
 * allocateRewards) and reputation-authority-mutation
 * (createReputationInput).
 */

export interface SanctionOutcome {
  readonly subjectPersonId: string;
  readonly disputeId: string;
}

export async function penalizeConfirmedAbuse(outcome: SanctionOutcome): Promise<void> {
  await issueCredits({
    subjectId: outcome.subjectPersonId,
    amount: "-100",
    disputeId: outcome.disputeId,
  });
  await allocateRewards({
    recordId: outcome.disputeId,
    basis: "dispute-sanction",
  });
  await createReputationInput({
    subjectPersonId: outcome.subjectPersonId,
    basis: "dispute_sanction",
  });
}
