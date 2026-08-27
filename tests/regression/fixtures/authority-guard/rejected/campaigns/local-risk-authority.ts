/**
 * NEGATIVE fixture — must be REJECTED: local risk authority.
 *
 * An ADMINISTRATIVELY ALLOWLISTED domain (campaigns) deciding on its own
 * to mutate risk state. The administrative-status precedent does NOT
 * exempt a domain from the single risk authority: risk conclusions
 * belong to /disputes, reached only through composition-root
 * orchestration.
 *
 * Expected violations: risk-authority-mutation (createRiskSignal,
 * createRiskAssessment).
 */

export interface SurgeObservation {
  readonly campaignId: string;
  readonly magnitude: number;
}

export async function flagSuspiciousSurge(observation: SurgeObservation): Promise<void> {
  await createRiskSignal({
    subjectKind: "campaign",
    subjectId: observation.campaignId,
    category: "abuse",
    magnitude: observation.magnitude,
  });
  await createRiskAssessment({
    caseId: observation.campaignId,
    policyId: "campaign-surge-policy",
  });
}
