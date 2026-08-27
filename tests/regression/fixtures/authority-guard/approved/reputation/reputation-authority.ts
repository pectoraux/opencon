/**
 * POSITIVE fixture — approved pattern: the reputation authority itself.
 *
 * Mirrors src/reputation (NET-W007): /reputation is the only reputation
 * mutation authority and therefore the only domain where reputation
 * input/snapshot mutation commands may be implemented. The owner is
 * exempt from its own reserved mutation primitives.
 *
 * The authority guard must report ZERO violations for this file.
 */

export interface ReputationInputDraft {
  readonly subjectPersonId: string;
  readonly basis: string;
}

export async function createReputationInput(input: ReputationInputDraft): Promise<string> {
  void input;
  return "reputation-input-id";
}

export async function addReputationInput(input: ReputationInputDraft): Promise<string> {
  return createReputationInput(input);
}

export async function createReputationSnapshot(input: {
  readonly policyId: string;
  readonly policyVersion: number;
}): Promise<string> {
  void input;
  return "reputation-snapshot-id";
}
