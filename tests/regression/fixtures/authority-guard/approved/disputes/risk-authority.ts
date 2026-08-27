/**
 * POSITIVE fixture — approved pattern: the risk authority itself.
 *
 * Mirrors src/disputes (NET-W007/W009/W010): /disputes is the single
 * fraud/risk control authority and therefore the only domain where
 * risk-signal / risk-assessment / risk-case mutation commands may be
 * implemented. The owner is exempt from its own reserved mutation
 * primitives.
 *
 * The authority guard must report ZERO violations for this file.
 */

export interface RiskSignalInput {
  readonly subjectKind: string;
  readonly subjectId: string;
  readonly category: string;
}

export async function createRiskSignal(input: RiskSignalInput): Promise<string> {
  void input;
  return "risk-signal-id";
}

export async function supersedeSignal(
  signalId: string,
  replacement: RiskSignalInput,
): Promise<string> {
  void signalId;
  return createRiskSignal(replacement);
}

export async function createRiskAssessment(input: {
  readonly caseId: string;
  readonly policyId: string;
}): Promise<string> {
  void input;
  return "risk-assessment-id";
}
