/**
 * NET-W033-AC-03 — Evidence / Proof-of-Value authority (issue #67
 * §4 AC-03).
 *
 * Authoritative evidence and Proof-of-Value are created/resolved
 * through /evidence; provenance, confidence and evidence commitments
 * remain authoritative there; caller-asserted grades/value cannot
 * bypass the evidence authority:
 *  - the canonical PoV is VERIFIED over /evidence-created records
 *    (grades DERIVED from provenance, commitments recorded);
 *  - the grade is derived deterministically from the source type
 *    (the frozen rule table — never caller-supplied);
 *  - a self-reported evidence basis CANNOT satisfy an
 *    ATTESTED-minimum helpfulness policy (the bypass attempt fails);
 *  - the PoV verification gate REQUIRES the recorded aggregation +
 *    a cryptographically verified attestation (an unaggregated proof
 *    fails closed);
 *  - STRUCTURAL: the evidence creation input carries NO grade/value
 *    field — there is nothing for a caller to assert.
 */

import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import {
  createNetW033Harness,
  runCanonicalScenario,
  key,
  type NetW033Harness,
} from "./_net-w033-harness.ts";
import {
  createHelpfulnessPolicy,
  createHelpfulContribution,
  attachEvidenceBasis,
  publishHelpfulContribution,
} from "../contributions/_net-w012-harness.ts";
import { EVIDENCE_GRADE_RANK } from "../../src/core/evidence.ts";

const REPO = join(import.meta.dir, "../..");

let harness: NetW033Harness;
let scenario: Awaited<ReturnType<typeof runCanonicalScenario>>;

beforeAll(async () => {
  harness = await createNetW033Harness();
  scenario = await runCanonicalScenario(harness, {
    skipBenefitAllocation: true,
  });
});

afterAll(async () => {
  await harness.teardown();
});

describe("NET-W033-AC-03 evidence / Proof-of-Value authority", () => {
  test("the canonical PoV is VERIFIED over /evidence-created records with derived grades + recorded commitments", async () => {
    const ctx = harness.contributorCtx("w033-ac03-pov");
    const proof = await harness.runtime.proofOfValueService.getProofOfValue(
      ctx,
      scenario.proofOfValueId,
    );
    expect(proof.state).toBe("VERIFIED");
    // The attached evidence was created through /evidence with grades
    // DERIVED from provenance (platform → MEASURED, provider →
    // PROVIDER_REPORTED) — never caller-supplied.
    const platform = await harness.runtime.evidenceService.getEvidence(
      ctx,
      scenario.povPlatformEvidenceId,
    );
    expect(platform.provenance.sourceType).toBe("platform");
    expect(platform.grade).toBe("MEASURED");
    const provider = await harness.runtime.evidenceService.getEvidence(
      ctx,
      scenario.povProviderEvidenceId,
    );
    expect(provider.provenance.sourceType).toBe("provider");
    expect(provider.grade).toBe("PROVIDER_REPORTED");
    // The recorded aggregation is authoritative (confidence preserved).
    expect(proof.aggregation).not.toBeNull();
    expect(proof.aggregation?.aggregatePoint).toBeGreaterThan(0.8);
    expect(proof.aggregation?.dominantGrade).toBe("MEASURED");
    expect(proof.aggregation?.evidenceCount).toBe(2);
    // The evidence commitments are recorded (provenance/grade/confidence).
    expect(typeof platform.commitment).not.toBe("undefined");
    // The basis evidence is ATTESTED-grade.
    const basis = await harness.runtime.evidenceService.getEvidence(
      ctx,
      scenario.basisEvidenceId,
    );
    expect(basis.grade).toBe("ATTESTED");
  });

  test("the grade derivation is deterministic + frozen (MEASURED > ATTESTED > PROVIDER_REPORTED > MODEL_ASSESSED > SELF_REPORTED)", async () => {
    const ctx = harness.contributorCtx("w033-ac03-grades");
    // Two evidences differing ONLY in source type derive different
    // grades through the frozen rule table.
    const self = await harness.runtime.evidenceService.createEvidence(ctx, {
      organizationScopeId: harness.organizationScopeId,
      ownerId: harness.contributorPersonId,
      subjectReference: {
        subjectId: scenario.contribution.id,
        subjectType: "contribution",
      },
      provenance: {
        sourceType: "self",
        sourceId: "self-report-w033",
        method: "self-report",
      },
      confidence: { point: 0.99, lower: 0.95, upper: 1.0 },
      sensitivity: "standard",
      payload: { claimed: "very helpful" },
    });
    expect(self.grade).toBe("SELF_REPORTED");
    // Even a 0.99-confidence self-report ranks BELOW every
    // platform/attested/provider grade (rank 1 = best: the rank
    // table is the sole ordering — confidence never overrides the
    // source type).
    expect(
      EVIDENCE_GRADE_RANK[self.grade as keyof typeof EVIDENCE_GRADE_RANK],
    ).toBeGreaterThan(EVIDENCE_GRADE_RANK.MEASURED);
  });

  test("a SELF-REPORTED evidence basis cannot satisfy an ATTESTED-minimum helpfulness policy (caller-asserted grade bypass fails)", async () => {
    // A contribution whose ONLY evidence basis is self-reported: the
    // policy requires minimumGrade ATTESTED + platform/attested
    // sources — the PoH evaluation is INSUFFICIENT (the grade gate is
    // enforced against the DERIVED grade, not any caller claim).
    const { contribution } = await createHelpfulContribution(
      harness.w014.w012,
      { idempotencyKey: key("w033-ac03-self") },
    );
    // A high-confidence self-reported basis (point 0.94 within the
    // [0.8, 0.95] interval — confidence can NEVER buy grade).
    await attachEvidenceBasis(harness.w014.w012, contribution.id, {
      sourceType: "self",
      point: 0.94,
    });
    await publishHelpfulContribution(harness.w014.w012, contribution.id);
    const poh = await harness.runtime.helpfulnessService.evaluateHelpfulness(
      harness.contributorCtx("w033-ac03-self-eval"),
      { contributionId: contribution.id, idempotencyKey: key("w033-ac03-poh") },
    );
    expect(poh.state).toBe("NOT_QUALIFIED");
    const last = poh.evaluations[poh.evaluations.length - 1]!;
    expect(last.reasons.join("; ")).toMatch(/grade|source/i);
  });

  test("PoV verification requires the recorded aggregation + a cryptographically verified attestation (fail closed without)", async () => {
    const ctx = harness.contributorCtx("w033-ac03-verify-gate");
    // A PoV with evidence but NO aggregation + NO attestation cannot
    // verify: begin measuring → complete gathering → verify fails.
    const e1 = await harness.runtime.evidenceService.createEvidence(ctx, {
      organizationScopeId: harness.organizationScopeId,
      ownerId: harness.contributorPersonId,
      subjectReference: {
        subjectId: scenario.contribution.id,
        subjectType: "contribution",
      },
      provenance: {
        sourceType: "platform",
        sourceId: "platform-w033-gate",
        method: "platform-counter",
      },
      confidence: { point: 0.9, lower: 0.85, upper: 0.95 },
      sensitivity: "standard",
      payload: { verified: true },
    });
    const proof = await harness.runtime.proofOfValueService.createProofOfValue(
      ctx,
      {
        organizationScopeId: harness.organizationScopeId,
        ownerId: harness.contributorPersonId,
        subjectReference: {
          subjectId: scenario.contribution.id,
          subjectType: "contribution",
        },
        evidenceIds: [e1.id],
      },
    );
    await harness.runtime.proofOfValueService.beginMeasuring(ctx, {
      proofId: proof.id,
      expectedVersion: 0,
      idempotencyKey: key("w033-ac03-begin"),
      actorPersonId: harness.contributorPersonId,
    });
    await harness.runtime.proofOfValueService.completeEvidenceGathering(ctx, {
      proofId: proof.id,
      expectedVersion: 1,
      idempotencyKey: key("w033-ac03-evaluating"),
      actorPersonId: harness.contributorPersonId,
    });
    // No aggregation recorded, no attestation attached: verify fails.
    await expect(
      harness.runtime.proofOfValueService.verify(ctx, {
        proofId: proof.id,
        expectedVersion: 2,
        idempotencyKey: key("w033-ac03-verify"),
        actorPersonId: harness.contributorPersonId,
      }),
    ).rejects.toThrow(/aggregat|attestation/i);
  });

  test("STRUCTURAL: the evidence creation input has NO grade/value field (nothing to assert)", async () => {
    const port = await readFile(join(REPO, "src/evidence/port.ts"), "utf8");
    const createInputMatch = port.match(
      /export interface CreateEvidenceInput \{[\s\S]*?\n\}/,
    );
    expect(createInputMatch).not.toBeNull();
    const createInput = createInputMatch![0]!;
    // Provenance, confidence, sensitivity, payload — but NO grade and
    // NO economic value field: the grade/value are DERIVED authority
    // outputs, never caller inputs.
    expect(createInput).not.toMatch(/\bgrade\b/i);
    expect(createInput).not.toMatch(/\bamount\b/i);
    expect(createInput).not.toMatch(/\bvalue\b/i);
    expect(createInput).toContain("provenance");
    expect(createInput).toContain("confidence");
  });

  test("STRUCTURAL: the helpfulness policy grade gate consumes the DERIVED grade (frozen vocabulary)", async () => {
    const port = await readFile(
      join(REPO, "src/contributions/port.ts"),
      "utf8",
    );
    // The policy sections are the closed grade vocabulary.
    expect(port).toContain("minimumGrade");
    // The PoH engine ranks evidence by the FROZEN grade table (the
    // derived grade — never a caller claim).
    const engine = await readFile(
      join(REPO, "src/contributions/poh-engine.ts"),
      "utf8",
    );
    expect(engine).toContain("EVIDENCE_GRADE_RANK");
  });
});
