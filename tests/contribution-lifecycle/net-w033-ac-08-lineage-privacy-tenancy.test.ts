/**
 * NET-W033-AC-08 — End-to-end lineage, audit, privacy and tenancy
 * (issue #67 §4 AC-08).
 *
 * The full contribution chain is reconstructable from durable
 * identifiers and audit events; cross-tenant and unauthorized access
 * fail closed; private source evidence is not exposed on
 * portable/public surfaces:
 *  - the chain reconstructs BACKWARD from the benefit allocation to
 *    the contribution + evidence through durable ids alone (every
 *    hop read through its OWNING authority);
 *  - every material stage left exactly one auditable event
 *    (contribution lifecycle, evidence, attestation, observation,
 *    outcome maturation, economic recognition/maturation, reputation
 *    inputs, the benefit allocation, the settlement draw);
 *  - cross-tenant reads of every composed surface are
 *    indistinguishable from nonexistent (fail closed);
 *  - unauthorized reads fail closed (the pool creator gate);
 *  - the W031 portable reputation proof discloses ONLY aggregate
 *    dimension facts — no source ids, no descriptions, no payloads;
 *  - the audit trail reconstructs from durable ids + aggregate facts
 *    (never private evidence payloads).
 */

import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import {
  createNetW033Harness,
  runCanonicalScenario,
  key,
  personCtx,
  type NetW033Harness,
} from "./_net-w033-harness.ts";

let harness: NetW033Harness;
let scenario: Awaited<ReturnType<typeof runCanonicalScenario>>;

beforeAll(async () => {
  harness = await createNetW033Harness();
  scenario = await runCanonicalScenario(harness);
});

afterAll(async () => {
  await harness.teardown();
});

describe("NET-W033-AC-08 end-to-end lineage, audit, privacy and tenancy", () => {
  test("the full chain reconstructs BACKWARD from the benefit allocation through durable ids alone", async () => {
    const creatorCtx = harness.moderatorCtx("w033-ac08-backward");
    const runtime = harness.runtime;

    // benefit allocation → the pool.
    const allocations = await runtime.benefitPoolService.listPoolAllocations(
      creatorCtx,
      {
        organizationScopeId: harness.organizationScopeId,
        poolId: scenario.poolId,
      },
    );
    expect(allocations).toHaveLength(1);
    const allocation = allocations[0]!;

    // pool → the funding value record (REFERENCES only).
    const pool = await runtime.benefitPoolService.getBenefitPool(creatorCtx, {
      organizationScopeId: harness.organizationScopeId,
      poolId: scenario.poolId,
    });
    const fundingId = pool.fundingRefs[0]!.id;
    expect(fundingId).toBe(scenario.matureValue.id);

    // value record → its upstream sources (the contribution + PoH
    // bases — all durable ids).
    const value = await runtime.economicValueService.getValue(
      harness.contributorCtx("w033-ac08-value"),
      fundingId,
    );
    expect(value.state).toBe("CONSUMED");
    const sourceIds = value.sources.map((s) => s.id);

    // sources → the VERIFIED contribution + the PoV + the measured
    // outcome (each resolved through its owning authority read).
    const contributionId = scenario.contribution.id;
    expect(sourceIds).toContain(contributionId);
    const contribution = await runtime.contributionService.getContribution(
      harness.contributorCtx("w033-ac08-contribution"),
      contributionId,
    );
    expect(contribution.state).toBe("VERIFIED");

    const pov = await runtime.proofOfValueService.getProofOfValue(
      harness.contributorCtx("w033-ac08-pov"),
      scenario.proofOfValueId,
    );
    expect(pov.state).toBe("VERIFIED");
    // PoV → the evidence records.
    expect(pov.evidenceIds).toContain(scenario.povPlatformEvidenceId);

    const evidence = await runtime.evidenceService.getEvidence(
      harness.contributorCtx("w033-ac08-evidence"),
      scenario.povPlatformEvidenceId,
    );
    // evidence → the contribution (the subject closes the loop).
    expect(evidence.subjectReference.subjectId).toBe(contributionId);

    // The measured outcome leg (source → observation → evidence).
    const measurement = await runtime.measuredOutcomeService.getMeasuredOutcome(
      harness.contributorCtx("w033-ac08-mo"),
      scenario.measuredOutcomeId,
    );
    expect(measurement.state).toBe("VERIFIED");
    expect(sourceIds).toContain(scenario.measuredOutcomeId);
    const observation = await runtime.outcomeObservationService.getOutcomeObservation(
      harness.contributorCtx("w033-ac08-obs"),
      scenario.observationId,
    );
    expect(observation.evidenceId).toBe(scenario.povPlatformEvidenceId);

    // The draw lineage closes: the allocation references the
    // settlement reward result + ledger transaction.
    expect(allocation.draw).not.toBeNull();
  });

  test("every material stage left exactly ONE auditable event (durable + ordered)", async () => {
    const audit = harness.runtime.auditWriter;
    // Contribution lifecycle: 10 ordered transition events.
    const transitions = (
      await audit.query({
        resourceType: "contribution",
        resourceId: scenario.contribution.id,
      })
    ).filter((e) => e.eventType.startsWith("contribution.transition."));
    expect(transitions).toHaveLength(10);
    // The evidence + attestation + observation + outcome stages.
    expect(
      await audit.query({
        eventType: "evidence.created",
        resourceId: scenario.povPlatformEvidenceId,
      }),
    ).toHaveLength(1);
    expect(
      await audit.query({
        eventType: "attestation.created",
        resourceId: scenario.attestationId,
      }),
    ).toHaveLength(1);
    expect(
      await audit.query({
        eventType: "outcome_observation.created",
        resourceId: scenario.observationId,
      }),
    ).toHaveLength(1);
    // The economic stages: recognition + maturation + the draw.
    expect(
      await audit.query({
        eventType: "economic_value.recorded",
        resourceId: scenario.value.id,
      }),
    ).toHaveLength(1);
    expect(
      await audit.query({
        eventType: "economic_value.matured",
        resourceId: scenario.value.id,
      }),
    ).toHaveLength(1);
    // The reputation stages: both inputs recorded.
    const inputEvents = await audit.query({
      eventType: "reputation_input.recorded",
    });
    expect(
      inputEvents.filter(
        (e) =>
          e.resourceId === scenario.directInputId ||
          e.resourceId === scenario.settlementEffectInputId,
      ),
    ).toHaveLength(2);
    // The benefit allocation + the settlement draw.
    expect(
      await audit.query({
        eventType: "benefits_pool.allocation_recorded",
        resourceId: scenario.allocationId,
      }),
    ).toHaveLength(1);
    const draw = scenario.allocation.draw as { resultId: string } | null;
    expect(
      await audit.query({
        eventType: "reward_allocation.recorded",
        resourceId: draw!.resultId,
      }),
    ).toHaveLength(1);
    // Every event carries the durable execution lineage.
    for (const event of transitions) {
      expect(typeof event.executionId).toBe("string");
      expect(typeof event.correlationId).toBe("string");
    }
  });

  test("cross-tenant access fails closed at every composed surface (org-scoped reads + material mutations)", async () => {
    const otherTenantCtx = personCtx(
      harness,
      harness.secondOrgPersonId,
      "w033-ac08-cross-tenant",
    );
    const runtime = harness.runtime;
    // The org-scoped read surfaces stay CLEAN cross-tenant: the
    // second organization scope resolves NOTHING for the canonical
    // chain (no existence oracle, no records leaked).
    const values = await runtime.economicValueService.listValues(
      otherTenantCtx,
      harness.secondOrgId,
      harness.contributorPersonId,
    );
    expect(
      values.filter((v) =>
        v.sources.some((s) => s.id === scenario.contribution.id),
      ),
    ).toHaveLength(0);
    const outcomes =
      await runtime.measuredOutcomeService.listVerifiedMeasuredOutcomesBySubject(
        otherTenantCtx,
        harness.secondOrgId,
        scenario.contribution.id,
      );
    expect(outcomes).toHaveLength(0);
    // The benefit pool read is org-scoped: a foreign scope resolves
    // the pool as NONEXISTENT (indistinguishable — no oracle).
    await expect(
      runtime.benefitPoolService.getBenefitPool(otherTenantCtx, {
        organizationScopeId: harness.secondOrgId,
        poolId: scenario.poolId,
      }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
    // The allocation listing likewise.
    await expect(
      runtime.benefitPoolService.listPoolAllocations(otherTenantCtx, {
        organizationScopeId: harness.secondOrgId,
        poolId: scenario.poolId,
      }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
    // Material MUTATIONS fail closed cross-tenant (the W012 pattern:
    // the domain gates the actor): a second-org person cannot mutate
    // the first org's contribution chain.
    await expect(
      runtime.helpfulnessService.declareDisclosure(otherTenantCtx, {
        contributionId: scenario.contribution.id,
        contributorPersonId: harness.secondOrgPersonId,
        relationshipKind: "affiliate",
        relationshipRef: "rel-cross",
        counterpartyRef: "org:foreign",
        description: "cross-tenant mutation attempt",
        idempotencyKey: key("w033-ac08-cross"),
      }),
    ).rejects.toThrow(/not the contributor/i);
    // The portable proof read surface is the API-guarded tenant route
    // (the W031 discipline: indistinguishable 404s — pinned by the
    // W031 suites; the proof ISSUANCE here stays first-org scoped).
  });

  test("unauthorized reads fail closed (the pool creator gate)", async () => {
    // The contributor is a MEMBER but NOT the pool creator: the
    // admin read is refused (the member view is their surface).
    await expect(
      harness.runtime.benefitPoolService.getBenefitPool(
        harness.contributorCtx("w033-ac08-unauth"),
        {
          organizationScopeId: harness.organizationScopeId,
          poolId: scenario.poolId,
        },
      ),
    ).rejects.toMatchObject({ code: "AUTHORIZATION" });
  });

  test("the W031 portable proof discloses ONLY aggregate dimension facts (no source ids, no payloads)", async () => {
    // Issue the portable proof from the canonical snapshot.
    const proof = await harness.runtime.reputationProofService.issueProof(
      harness.contributorCtx("w033-ac08-proof"),
      {
        organizationScopeId: harness.organizationScopeId,
        subjectPersonId: harness.contributorPersonId,
        snapshotId: scenario.snapshot.id,
        idempotencyKey: key("w033-ac08-proof"),
      },
    );
    const serialized = JSON.stringify(proof.proof);
    // The dimension facts are aggregates (score + counts).
    expect(proof.proof.dimensions).toHaveLength(8);
    for (const fact of proof.proof.dimensions) {
      expect(typeof fact.score).toBe("number");
      expect(fact.inputCount).toBeGreaterThanOrEqual(0);
    }
    // NO private source evidence: no input ids, no source ids, no
    // descriptions, no payloads, no evidence references.
    expect(serialized).not.toContain(scenario.directInputId);
    expect(serialized).not.toContain(scenario.settlementEffectInputId);
    expect(serialized).not.toContain(scenario.contribution.id);
    expect(serialized).not.toContain(scenario.proofOfValueId);
    expect(serialized).not.toContain(scenario.measuredOutcomeId);
    expect(serialized).not.toContain(scenario.povPlatformEvidenceId);
    expect(serialized).not.toContain("verified contribution");
    expect(serialized).not.toContain("payload");
    expect(serialized).not.toContain("sensitivePayload");
    expect(serialized).not.toContain("description");
    // The snapshot digest binds the lineage WITHOUT disclosing it.
    expect(proof.proof.digest).toBe(scenario.snapshot.digest);
  });

  test("the audit trail reconstructs from ids + aggregate facts (never private evidence payloads)", async () => {
    const audit = harness.runtime.auditWriter;
    // The full contribution chain's audit events: none of them carry
    // the private evidence payloads (only the durable ids + the
    // aggregate facts).
    const evidenceEvents = await audit.query({
      eventType: "evidence.created",
    });
    for (const event of evidenceEvents) {
      const serialized = JSON.stringify(event);
      expect(serialized).not.toContain("payload");
      expect(serialized).not.toContain("sensitivePayload");
      expect(serialized).not.toContain("signals");
    }
    // The member benefit view (the public composed surface) exposes
    // no raw personal histories either (AC-07 pins its shape; here
    // the reconstruction path itself is payload-free).
    const transitions = await audit.query({
      resourceType: "contribution",
      resourceId: scenario.contribution.id,
    });
    for (const event of transitions) {
      expect(JSON.stringify(event)).not.toContain("claimantAttributes");
      expect(JSON.stringify(event)).not.toContain("mentions");
    }
  });
});
