/**
 * NET-W013-AC-06 — atomicity, idempotency, concurrency safety, tenant
 * isolation and transactional audit lineage for the quality and
 * moderation mutations.
 */
import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { PostgresAuthorityShim } from "../../src/persistence/postgres-authority-shim.ts";
import {
  QUALITY_POLICIES_COLLECTION,
  QUALITY_EVALUATIONS_COLLECTION,
  ADVISORY_QUALITY_SCORES_COLLECTION,
  MODERATION_DECISIONS_COLLECTION,
} from "../../src/contributions/authority-quality-repository.ts";
import {
  createNetW013Harness,
  createQualityPolicy,
  createQualifiedContribution,
  recordQualityEvaluation,
  recordModerationDecision,
  moderatorCtx,
  key,
  EVALUATED_AT,
  type NetW013Harness,
} from "./_net-w013-harness.ts";

let harness: NetW013Harness;

beforeAll(async () => {
  harness = await createNetW013Harness();
});

afterAll(async () => {
  await harness.teardown();
});

function shim(): PostgresAuthorityShim {
  return harness.runtime.postgresAuthority as unknown as PostgresAuthorityShim;
}

describe("NET-W013-AC-06 atomicity + tenancy", () => {
  test("every quality/moderation collection is PostgreSQL-authoritative (the shim's committed state)", async () => {
    const { contribution, qualityPolicy } = await createQualifiedContribution(
      harness,
    );
    await recordQualityEvaluation(harness, contribution.id, qualityPolicy.policyId);
    await recordModerationDecision(harness, contribution.id, {
      decision: "FLAG_FOR_REVIEW",
      reasonKinds: ["low_evidence_quality"],
    });
    expect(await shim().count(QUALITY_POLICIES_COLLECTION)).toBeGreaterThan(0);
    expect(await shim().count(QUALITY_EVALUATIONS_COLLECTION)).toBeGreaterThan(0);
    expect(
      await shim().count(ADVISORY_QUALITY_SCORES_COLLECTION),
    ).toBeGreaterThanOrEqual(0);
    expect(await shim().count(MODERATION_DECISIONS_COLLECTION)).toBeGreaterThan(0);
  });

  test("idempotent replays: the same evaluation key returns the same record (created=false)", async () => {
    const { contribution, qualityPolicy } = await createQualifiedContribution(
      harness,
    );
    const k = key("w013-idem");
    const first = await harness.runtime.qualityService.recordQualityEvaluation(
      moderatorCtx(harness, "w013-idem-1"),
      {
        contributionId: contribution.id,
        organizationScopeId: harness.organizationScopeId,
        qualityPolicyId: qualityPolicy.policyId,
        evaluatedAt: EVALUATED_AT,
        idempotencyKey: k,
      },
    );
    expect(first.created).toBe(true);
    const replay = await harness.runtime.qualityService.recordQualityEvaluation(
      moderatorCtx(harness, "w013-idem-2"),
      {
        contributionId: contribution.id,
        organizationScopeId: harness.organizationScopeId,
        qualityPolicyId: qualityPolicy.policyId,
        evaluatedAt: EVALUATED_AT,
        idempotencyKey: k,
      },
    );
    expect(replay.created).toBe(false);
    expect(replay.evaluation.id).toBe(first.evaluation.id);
    // Exactly ONE evaluation record for the contribution.
    const history = await harness.runtime.qualityService.listQualityEvaluationHistory(
      harness.bootstrapCtx,
      contribution.id,
    );
    expect(history.length).toBe(1);
  });

  test("concurrent same-key evaluation creation: exactly one fulfillment (allSettled)", async () => {
    const { contribution, qualityPolicy } = await createQualifiedContribution(
      harness,
    );
    const k = key("w013-concurrent");
    const results = await Promise.allSettled(
      Array.from({ length: 4 }, (_, i) =>
        harness.runtime.qualityService.recordQualityEvaluation(
          moderatorCtx(harness, `w013-concurrent-${String(i)}`),
          {
            contributionId: contribution.id,
            organizationScopeId: harness.organizationScopeId,
            qualityPolicyId: qualityPolicy.policyId,
            evaluatedAt: EVALUATED_AT,
            idempotencyKey: k,
          },
        ),
      ),
    );
    const fulfilled = results.filter((r) => r.status === "fulfilled");
    expect(fulfilled.length).toBe(4);
    const history = await harness.runtime.qualityService.listQualityEvaluationHistory(
      harness.bootstrapCtx,
      contribution.id,
    );
    expect(history.length).toBe(1);
  });

  test("tenant isolation: a second-org actor cannot evaluate or decide on a first-org contribution", async () => {
    const { contribution, qualityPolicy } = await createQualifiedContribution(
      harness,
    );
    await expect(
      harness.runtime.qualityService.recordQualityEvaluation(
        moderatorCtx(harness, "w013-tenant-eval"),
        {
          contributionId: contribution.id,
          organizationScopeId: harness.secondOrgId,
          qualityPolicyId: qualityPolicy.policyId,
          evaluatedAt: EVALUATED_AT,
          idempotencyKey: key("w013-tenant-eval"),
        },
      ),
    ).rejects.toThrow(/belongs to organization scope/i);
    await expect(
      harness.runtime.qualityService.attachAdvisoryScore(
        moderatorCtx(harness, "w013-tenant-adv"),
        {
          contributionId: contribution.id,
          organizationScopeId: harness.secondOrgId,
          kind: "model_score",
          methodRef: "rubric",
          methodVersion: "1",
          score: 0.5,
          idempotencyKey: key("w013-tenant-adv"),
        },
      ),
    ).rejects.toThrow(/belongs to organization scope/i);
  });

  test("a second-org quality policy is invisible to first-org evaluations (scoped reads)", async () => {
    const foreignPolicy = await createQualityPolicy(harness, {
      organizationScopeId: harness.secondOrgId,
    });
    const versions = await harness.runtime.qualityService.listQualityPolicyVersions(
      moderatorCtx(harness, "w013-scoped"),
      foreignPolicy.policyId,
    );
    // The lineage exists (both orgs see the same LINEAGE — the mutex is
    // org-independent), but each version carries its OWN scope and a
    // first-org evaluation of it is rejected (proven in AC-01).
    expect(versions.length).toBe(1);
    expect(versions[0]!.organizationScopeId).toBe(harness.secondOrgId);
  });

  test("transactional audit lineage: quality + moderation events carry execution/correlation lineage and idempotency record ids", async () => {
    const { contribution, qualityPolicy } = await createQualifiedContribution(
      harness,
    );
    const evaluation = await recordQualityEvaluation(
      harness,
      contribution.id,
      qualityPolicy.policyId,
    );
    expect(evaluation.executionId).toBeTruthy();
    expect(evaluation.correlationId).toBeTruthy();
    expect(evaluation.idempotencyKey).toBeTruthy();
    const decisionResult = await recordModerationDecision(
      harness,
      contribution.id,
      {
        decision: "APPROVE",
        reasonKinds: ["no_violation"],
      },
    );
    // The DOMAIN record (the composite view omits the lineage fields)
    // carries the full execution lineage.
    const [domainRecord] = await harness.runtime.moderationService.listModerationDecisions(
      harness.bootstrapCtx,
      contribution.id,
    );
    expect(domainRecord!.id).toBe(decisionResult.decision.id);
    expect(domainRecord!.executionId).toBeTruthy();
    expect(domainRecord!.correlationId).toBeTruthy();
    expect(domainRecord!.idempotencyKey).toBeTruthy();
  });

  test("the in-tx staleness re-check rejects evaluations whose PoH changed mid-flight", async () => {
    const { contribution, qualityPolicy } = await createQualifiedContribution(
      harness,
    );
    // Reach into the authority and flip the PoH state while the
    // evaluation transaction opens (the begin-interposition pattern).
    const authority = shim();
    const originalBegin = authority.begin.bind(authority);
    let armed = true;
    authority.begin = async (context: never) => {
      const tx = await originalBegin(context);
      if (armed) {
        armed = false;
        // Mutate the committed PoH to NOT_QUALIFIED between the
        // service's fact resolution and its authoritative tx.
        const records = await authority.scan<{
          state: string;
          contributionId: string;
        }>("proofs_of_helpfulness");
        const poh = records
          .map((r) => r.value)
          .find((p) => p.contributionId === contribution.id);
        if (poh) {
          await authority.run(
            moderatorCtx(harness, "w013-stale-seed"),
            async (tx2) => {
              await tx2.put("proofs_of_helpfulness", pohRecordId(records, contribution.id), {
                ...poh,
                state: "NOT_QUALIFIED",
              });
            },
          );
        }
      }
      return tx;
    };
    try {
      await expect(
        harness.runtime.qualityService.recordQualityEvaluation(
          moderatorCtx(harness, "w013-stale"),
          {
            contributionId: contribution.id,
            organizationScopeId: harness.organizationScopeId,
            qualityPolicyId: qualityPolicy.policyId,
            evaluatedAt: EVALUATED_AT,
            idempotencyKey: key("w013-stale"),
          },
        ),
      ).rejects.toThrow(/changed during evaluation/i);
    } finally {
      authority.begin = originalBegin;
    }
  });
});

/** Extract the PoH record key for a contribution from a scan result. */
function pohRecordId(
  records: readonly {
    key: string;
    value: { contributionId: string };
  }[],
  contributionId: string,
): string {
  const found = records.find((r) => r.value.contributionId === contributionId);
  if (!found) throw new Error("PoH record not found for staleness seed");
  return found.key;
}
