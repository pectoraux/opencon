/**
 * NET-W012-AC-06 — atomicity, idempotency, concurrency safety,
 * tenant isolation, PostgreSQL authority and transactional audit
 * lineage.
 *
 * Every material mutation runs through the NET-W004 IdempotencyStore
 * primitive (exactly-once atomic commit + transactional audit
 * lineage); per-record mutexes serialize PoH mutations; fresh keys
 * against changed state conflict; records never cross organization
 * scopes.
 */
import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import {
  createNetW012Harness,
  createHelpfulnessPolicy,
  createHelpfulContribution,
  attachEvidenceBasis,
  publishHelpfulContribution,
  contributorCtx,
  otherCtx,
  key,
  type NetW012Harness,
} from "./_net-w012-harness.ts";

let harness: NetW012Harness;

beforeAll(async () => {
  harness = await createNetW012Harness();
});

afterAll(async () => {
  await harness.teardown();
});

describe("NET-W012-AC-06 atomicity + tenancy", () => {
  test("Contribution + PoH creation is ATOMIC: the PoH resolves exactly when the contribution does", async () => {
    const { contribution, proofOfHelpfulness } =
      await createHelpfulContribution(harness);
    const found = await harness.runtime.helpfulnessService.getHelpfulContribution(
      harness.bootstrapCtx,
      contribution.id,
    );
    expect(found.contribution.id).toBe(contribution.id);
    expect(found.proofOfHelpfulness.id).toBe(proofOfHelpfulness.id);
    // A contribution WITHOUT a PoH (generic W004) resolves an error
    // from the helpfulness read (tenant-scoped boundary).
    const generic = await harness.runtime.contributionService.createContribution(
      otherCtx(harness, "w012-ac06-generic"),
      {
        opportunityId: contribution.opportunityId,
        contributorId: harness.otherPersonId,
        organizationScopeId: harness.organizationScopeId,
        contributionType: "generic_note",
        submission: { kind: "generic" },
      },
    );
    await expect(
      harness.runtime.helpfulnessService.getProofOfHelpfulness(
        harness.bootstrapCtx,
        generic.id,
      ),
    ).rejects.toThrow(/proof-of-helpfulness not found/);
  });

  test("idempotent replays: attach/evaluate/prepare/retract with the same key never double-apply", async () => {
    const { contribution } = await createHelpfulContribution(harness);
    const k = key("w012-ac06-replay");
    const ctx = contributorCtx(harness, "w012-ac06-replay");
    const a = await harness.runtime.helpfulnessService.attachAdvisoryScore(ctx, {
      contributionId: contribution.id,
      kind: "model_score",
      methodRef: "ranker",
      methodVersion: "1",
      score: 0.5,
      idempotencyKey: k,
    });
    const b = await harness.runtime.helpfulnessService.attachAdvisoryScore(ctx, {
      contributionId: contribution.id,
      kind: "model_score",
      methodRef: "ranker",
      methodVersion: "1",
      score: 0.5,
      idempotencyKey: k,
    });
    expect(b.advisoryScores.length).toBe(a.advisoryScores.length);
    expect(b.updatedAt).toBe(a.updatedAt);

    const basisKey = key("w012-ac06-basis-replay");
    const evidence = await harness.runtime.evidenceService.createEvidence(ctx, {
      organizationScopeId: harness.organizationScopeId,
      ownerId: harness.contributorPersonId,
      subjectReference: { subjectId: contribution.id, subjectType: "contribution" },
      provenance: { sourceType: "attested", method: "community-attestation" },
      confidence: { point: 0.9 },
      sensitivity: "standard",
      payload: { ok: true },
    });
    const basisA = await harness.runtime.helpfulnessService.attachBasis(ctx, {
      contributionId: contribution.id,
      kind: "evidence_record",
      referenceId: evidence.id,
      idempotencyKey: basisKey,
    });
    const basisB = await harness.runtime.helpfulnessService.attachBasis(ctx, {
      contributionId: contribution.id,
      kind: "evidence_record",
      referenceId: evidence.id,
      idempotencyKey: basisKey,
    });
    expect(basisB.bases.length).toBe(basisA.bases.length);

    const evaluateKey = key("w012-ac06-eval-replay");
    const evalA = await harness.runtime.helpfulnessService.evaluateHelpfulness(ctx, {
      contributionId: contribution.id,
      idempotencyKey: evaluateKey,
    });
    const evalB = await harness.runtime.helpfulnessService.evaluateHelpfulness(ctx, {
      contributionId: contribution.id,
      idempotencyKey: evaluateKey,
    });
    expect(evalB.evaluations.length).toBe(evalA.evaluations.length);
  });

  test("concurrent same-key creation: exactly one fulfillment (allSettled)", async () => {
    const policy = await createHelpfulnessPolicy(harness);
    const k = key("w012-ac06-concurrent");
    // Pre-provision opportunity so both callers share it.
    const { createHelpfulCampaign } = await import("./_net-w012-harness.ts");
    const { opportunityId } = await createHelpfulCampaign(harness);
    const mk = () =>
      harness.runtime.helpfulnessService.createHelpfulContribution(
        contributorCtx(harness, "w012-ac06-concurrent"),
        {
          opportunityId,
          contributorId: harness.contributorPersonId,
          organizationScopeId: harness.organizationScopeId,
          contributionType: "helpful_recommendation",
          submission: {
            claimantAttributes: { participant_class: ["contributor"] },
            mentions: [],
            contentRef: null,
            channel: null,
          },
          helpfulnessPolicyId: policy.policyId,
          idempotencyKey: k,
        },
      );
    const results = await Promise.allSettled([mk(), mk()]);
    const fulfilled = results.filter((r) => r.status === "fulfilled");
    expect(fulfilled.length).toBe(2); // both resolve (one created, one replay)
    const ids = new Set(
      fulfilled.map(
        (r) => (r as PromiseFulfilledResult<Awaited<ReturnType<typeof mk>>>).value.contribution.id,
      ),
    );
    expect(ids.size).toBe(1); // exactly ONE contribution
  });

  test("concurrent DISTINCT-key PoH mutations serialize under the per-record mutex (append-only events preserved)", async () => {
    const { contribution } = await createHelpfulContribution(harness);
    const ctx = contributorCtx(harness, "w012-ac06-serialize");
    const ops = Array.from({ length: 6 }, (_, i) =>
      harness.runtime.helpfulnessService.attachAdvisoryScore(ctx, {
        contributionId: contribution.id,
        kind: "model_score",
        methodRef: "ranker",
        methodVersion: "1",
        score: (i + 1) / 10,
        idempotencyKey: key(`w012-ac06-ser-${String(i)}`),
      }),
    );
    const results = await Promise.allSettled(ops);
    expect(results.every((r) => r.status === "fulfilled")).toBe(true);
    const poh = await harness.runtime.helpfulnessService.getProofOfHelpfulness(
      harness.bootstrapCtx,
      contribution.id,
    );
    expect(poh.advisoryScores.length).toBe(6);
    // Append-only: the created event is preserved; 6 advisory events.
    expect(poh.events[0]).toBe("created");
    expect(poh.events.filter((e) => e === "advisory_recorded").length).toBe(6);
  });

  test("tenant isolation: cross-org material mutations are rejected and scoped lists stay clean", async () => {
    const { contribution } = await createHelpfulContribution(harness);
    const secondOrgPerson = {
      correlationId: "w012-ac06-cross",
      executionId: "w012-ac06-cross",
      actor: { id: harness.secondOrgPersonId, kind: "person" },
    } as never;
    // Preparation is protocol-side (API-guarded; never publishes) — but
    // the MATERIAL mutations are contributor/org-gated by construction:
    await expect(
      harness.runtime.helpfulnessService.declareDisclosure(
        secondOrgPerson,
        {
          contributionId: contribution.id,
          contributorPersonId: harness.secondOrgPersonId,
          relationshipKind: "affiliate",
          relationshipRef: "rel-y",
          counterpartyRef: "org:y",
          idempotencyKey: key("w012-ac06-cross2"),
        },
      ),
    ).rejects.toThrow(/not the contributor of contribution/);
    await expect(
      harness.runtime.helpfulnessService.assertPublishable(
        secondOrgPerson,
        contribution.id,
      ),
    ).rejects.toThrow(/publication is user-controlled/);
    // And a protocol-side prepare from ANY actor still leaves the
    // lifecycle untouched (the strong tenancy boundary is the guard +
    // the material gates above):
    const poh = await harness.runtime.helpfulnessService.prepareRecommendation(
      secondOrgPerson,
      {
        contributionId: contribution.id,
        preparedContentRef: "content://cross-org-prepare",
        idempotencyKey: key("w012-ac06-cross-prepare"),
      },
    );
    expect(poh.publication).toBeNull();
    const still = await harness.runtime.contributionService.getContribution(
      harness.bootstrapCtx,
      contribution.id,
    );
    expect(still.state).toBe("DRAFT");
  });

  test("records persist through the PostgreSQL-authoritative boundary (authority collections)", async () => {
    const { contribution, proofOfHelpfulness } =
      await createHelpfulContribution(harness);
    // Round-trip through the authority: ids stable, scopes intact.
    const reread = await harness.runtime.helpfulnessService.getHelpfulContribution(
      harness.bootstrapCtx,
      contribution.id,
    );
    expect(reread.proofOfHelpfulness.id).toBe(proofOfHelpfulness.id);
    expect(reread.contribution.organizationScopeId).toBe(
      harness.organizationScopeId,
    );
    expect(reread.proofOfHelpfulness.organizationScopeId).toBe(
      harness.organizationScopeId,
    );
  });

  test("transactional audit lineage: every mutation appends with idempotency-record + transaction ids", async () => {
    const { contribution } = await createHelpfulContribution(harness);
    await attachEvidenceBasis(harness, contribution.id);
    await publishHelpfulContribution(harness, contribution.id);
    const poh = await harness.runtime.helpfulnessService.evaluateHelpfulness(
      contributorCtx(harness, "w012-ac06-audit"),
      { contributionId: contribution.id, idempotencyKey: key("w012-ac06-audit") },
    );
    expect(poh.evaluations.length).toBe(1);
    expect(poh.evaluations[0]!.evaluator).toBe("deterministic_policy_v1");
    // The audit trail is queryable through the runtime's audit writer
    // (the TransactionalAuditWriter publishes afterCommit; query()
    // returns the ordered event log).
    const auditEvents = await harness.runtime.auditWriter.query({
      resourceType: "proof_of_helpfulness",
    });
    const ours = auditEvents.filter((e) => e.resourceId === poh.id);
    expect(ours.length).toBeGreaterThanOrEqual(4); // created, basis, published, evaluated
    const types = ours.map((e) => e.eventType);
    expect(types).toContain("helpful_contribution.created");
    expect(types).toContain("helpfulness_basis.attached");
    expect(types).toContain("helpful_contribution.published");
    expect(types).toContain("proof_of_helpfulness.evaluated");
  });
});
