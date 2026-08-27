/**
 * NET-W017 AC-05 — canonical evidence integration + provenance.
 *
 * Proves (work order §3.4, issue #33 AC-5 + invariant 5):
 *  - submission evidence references resolve through the CANONICAL
 *    /evidence authority: nonexistent / cross-scope / wrong-subject /
 *    wrong-subject-type references are all rejected;
 *  - evidence records are created through the canonical evidence
 *    service with subject type "ugc_production" (the bootstrap
 *    subject lookup resolves UGC productions — the subject binding is
 *    validated at evidence creation too);
 *  - provenance (execution/correlation/causation lineage) is
 *    preserved end-to-end on engagement/grant/production/
 *    deliverable/submission records;
 *  - the UGC boundary fabricates NO outcome/measurement: it creates
 *    no observations, no measured outcomes, no experiments (audited
 *    state before/after the full flow).
 */

import { describe, expect, test } from "bun:test";
import {
  acceptEngagement,
  createEngagement,
  createProductionEvidence,
  key,
  openProduction,
  personCtx,
  recordDeliverable,
  submitProduction,
  tenderEngagement,
  createNetW017Harness,
} from "./_net-w017-harness.ts";
import { InvalidEngagementError } from "../../src/core/creators.ts";

describe("NET-W017 AC-05 — canonical evidence integration + provenance", () => {
  test("evidence creation binds to ugc_production subjects through the canonical subject lookup", async () => {
    const harness = await createNetW017Harness();
    try {
      const { engagement } = await createEngagement(harness);
      await tenderEngagement(harness, engagement.id, 0);
      const accepted = await acceptEngagement(harness, engagement.id, 1);
      const { production } = await openProduction(
        harness,
        accepted.engagement.id,
        2,
      );
      // The canonical evidence service accepts the ugc_production
      // subject (the bootstrap subject lookup resolves it).
      const { evidenceId } = await createProductionEvidence(
        harness,
        production.id,
      );
      expect(evidenceId).toBeTypeOf("string");
      // The canonical evidence authority does NOT interpret subject
      // semantics (the W005 design: subject binding is validated by
      // the SUBJECT-OWNING service). An evidence record referencing a
      // NONEXISTENT production can be created — but it can never back
      // a real production's submission (the binding check below).
      const ctx = personCtx(harness, harness.creatorPersonId, "w017-ev-bad");
      const orphan = await harness.runtime.evidenceService.createEvidence(
        ctx,
        {
          organizationScopeId: harness.organizationScopeId,
          ownerId: harness.creatorPersonId,
          subjectReference: {
            subjectType: "ugc_production",
            subjectId: "nonexistent-production",
          },
          provenance: {
            sourceType: "platform",
            method: "w017 bad subject",
          },
          confidence: { point: 0.9, lower: 0.8, upper: 0.95 },
          sensitivity: "standard",
          payload: {},
        },
      );
      expect(orphan.id).toBeTypeOf("string");
      // The orphan evidence cannot back the REAL production's
      // submission (subject binding mismatch).
      await recordDeliverable(harness, production.id);
      await expect(
        submitProduction(harness, production.id, 3, [orphan.id]),
      ).rejects.toBeInstanceOf(InvalidEngagementError);
    } finally {
      await harness.teardown();
    }
  }, 60_000);

  test("a nonexistent evidence reference is rejected at submission", async () => {
    const harness = await createNetW017Harness();
    try {
      const { engagement } = await createEngagement(harness);
      await tenderEngagement(harness, engagement.id, 0);
      const accepted = await acceptEngagement(harness, engagement.id, 1);
      const { production, engagementVersion } = await openProduction(
        harness,
        accepted.engagement.id,
        2,
      );
      await recordDeliverable(harness, production.id);
      await expect(
        submitProduction(harness, production.id, engagementVersion, [
          "ev-nonexistent",
        ]),
      ).rejects.toBeInstanceOf(InvalidEngagementError);
    } finally {
      await harness.teardown();
    }
  }, 60_000);

  test("a wrong-subject evidence reference is rejected (evidence bound to ANOTHER production)", async () => {
    const harness = await createNetW017Harness();
    try {
      // Two full engagements, each with a production.
      const first = await (async () => {
        const { engagement } = await createEngagement(harness);
        await tenderEngagement(harness, engagement.id, 0);
        const accepted = await acceptEngagement(harness, engagement.id, 1);
        return openProduction(harness, accepted.engagement.id, 2);
      })();
      const second = await (async () => {
        const { engagement } = await createEngagement(harness);
        await tenderEngagement(harness, engagement.id, 0);
        const accepted = await acceptEngagement(harness, engagement.id, 1);
        return openProduction(harness, accepted.engagement.id, 2);
      })();
      // Evidence bound to the SECOND production cannot back the
      // FIRST production's submission.
      const { evidenceId } = await createProductionEvidence(
        harness,
        second.production.id,
      );
      await recordDeliverable(harness, first.production.id);
      await expect(
        submitProduction(
          harness,
          first.production.id,
          first.engagementVersion,
          [evidenceId],
        ),
      ).rejects.toBeInstanceOf(InvalidEngagementError);
      // The SAME evidence backs the SECOND production fine.
      await recordDeliverable(harness, second.production.id);
      const ok = await submitProduction(
        harness,
        second.production.id,
        second.engagementVersion,
        [evidenceId],
      );
      expect(ok.submissionId).toBeTypeOf("string");
    } finally {
      await harness.teardown();
    }
  }, 90_000);

  test("a wrong-subject-TYPE evidence reference is rejected (e.g. contribution evidence)", async () => {
    const harness = await createNetW017Harness();
    try {
      // A contribution (a NON-ugc_production subject) + evidence
      // bound to it.
      const ctx = personCtx(harness, harness.operatorPersonId, "w017-opp");
      const opportunity =
        await harness.runtime.opportunityService.createOpportunity(ctx, {
          organizationScopeId: harness.organizationScopeId,
          ownerId: harness.operatorPersonId,
          opportunityType: "campaign_contribution",
          title: "W017 opportunity",
          brief: {},
        });
      const contribution =
        await harness.runtime.contributionService.createContribution(ctx, {
          opportunityId: opportunity.id,
          contributorId: harness.creatorPersonId,
          organizationScopeId: harness.organizationScopeId,
          contributionType: "ugc",
          submission: {},
        });
      const evidence = await harness.runtime.evidenceService.createEvidence(
        personCtx(harness, harness.creatorPersonId, "w017-ev-contrib"),
        {
          organizationScopeId: harness.organizationScopeId,
          ownerId: harness.creatorPersonId,
          subjectReference: {
            subjectType: "contribution",
            subjectId: contribution.id,
          },
          provenance: { sourceType: "platform", method: "contribution proof" },
          confidence: { point: 0.9, lower: 0.8, upper: 0.95 },
          sensitivity: "standard",
          payload: {},
        },
      );
      // A production whose submission references the CONTRIBUTION
      // evidence is rejected (subject-type binding mismatch).
      const { engagement } = await createEngagement(harness, {
        opportunityId: opportunity.id,
      });
      await tenderEngagement(harness, engagement.id, 0);
      const accepted = await acceptEngagement(harness, engagement.id, 1);
      const opened = await openProduction(harness, accepted.engagement.id, 2, {
        contributionId: contribution.id,
      });
      await recordDeliverable(harness, opened.production.id);
      await expect(
        submitProduction(
          harness,
          opened.production.id,
          opened.engagementVersion,
          [evidence.id],
        ),
      ).rejects.toBeInstanceOf(InvalidEngagementError);
    } finally {
      await harness.teardown();
    }
  }, 90_000);

  test("a cross-scope evidence reference is rejected (tenant isolation)", async () => {
    const harness = await createNetW017Harness();
    try {
      // Evidence in the SECOND org bound to a production there.
      const foreignCtx = personCtx(
        harness,
        harness.secondOrgPersonId,
        "w017-foreign-ev",
      );
      const foreignEvidence =
        await harness.runtime.evidenceService.createEvidence(foreignCtx, {
          organizationScopeId: harness.secondOrgId,
          ownerId: harness.secondOrgPersonId,
          subjectReference: {
            subjectType: "contribution",
            subjectId: "anything",
          },
          provenance: { sourceType: "platform", method: "foreign" },
          confidence: { point: 0.9, lower: 0.8, upper: 0.95 },
          sensitivity: "standard",
          payload: {},
        });
      const { engagement } = await createEngagement(harness);
      await tenderEngagement(harness, engagement.id, 0);
      const accepted = await acceptEngagement(harness, engagement.id, 1);
      const opened = await openProduction(harness, accepted.engagement.id, 2);
      await recordDeliverable(harness, opened.production.id);
      await expect(
        submitProduction(
          harness,
          opened.production.id,
          opened.engagementVersion,
          [foreignEvidence.id],
        ),
      ).rejects.toBeInstanceOf(InvalidEngagementError);
    } finally {
      await harness.teardown();
    }
  }, 60_000);

  test("duplicate evidence references in one submission are rejected; every reference must be unique", async () => {
    const harness = await createNetW017Harness();
    try {
      const { engagement } = await createEngagement(harness);
      await tenderEngagement(harness, engagement.id, 0);
      const accepted = await acceptEngagement(harness, engagement.id, 1);
      const opened = await openProduction(harness, accepted.engagement.id, 2);
      await recordDeliverable(harness, opened.production.id);
      const { evidenceId } = await createProductionEvidence(
        harness,
        opened.production.id,
      );
      const ctx = personCtx(harness, harness.creatorPersonId, "w017-dup");
      await expect(
        harness.runtime.creatorEngagementService.submitProduction(ctx, {
          organizationScopeId: harness.organizationScopeId,
          productionId: opened.production.id,
          expectedVersion: opened.engagementVersion,
          evidenceReferences: [evidenceId, evidenceId],
          idempotencyKey: key("w017-dup"),
        }),
      ).rejects.toBeInstanceOf(InvalidEngagementError);
    } finally {
      await harness.teardown();
    }
  }, 60_000);

  test("provenance: execution/correlation lineage is preserved end-to-end", async () => {
    const harness = await createNetW017Harness();
    try {
      const { goldenPathEngagement } = await import(
        "./_net-w017-harness.ts"
      );
      const flow = await goldenPathEngagement(harness);
      // Every record carries execution lineage.
      expect(flow.engagement.executionId).toBeTypeOf("string");
      expect(flow.grant.executionId).toBeTypeOf("string");
      expect(flow.production.executionId).toBeTypeOf("string");
      // The submission carries the lineage of ITS creating execution.
      const ctx = personCtx(harness, harness.operatorPersonId, "w017-lineage");
      const submissions =
        await harness.runtime.creatorEngagementService.listSubmissions(
          ctx,
          harness.organizationScopeId,
          flow.production.id,
        );
      expect(submissions).toHaveLength(1);
      const submission = submissions[0]!;
      expect(submission.executionId).toBeTypeOf("string");
      expect(submission.correlationId).toBeTypeOf("string");
      // The evidence reference resolves to the canonical record with
      // ITS OWN provenance (created through the canonical service).
      const evidence = await harness.runtime.evidenceService.getEvidence(
        ctx,
        flow.evidenceId,
      );
      expect(evidence.subjectReference.subjectType).toBe("ugc_production");
      expect(evidence.subjectReference.subjectId).toBe(flow.production.id);
      expect(evidence.executionId).toBeTypeOf("string");
      expect(evidence.provenance.method).toBe("w017 fixture capture");
      // The submission's evidence reference matches.
      expect(submission.evidenceReferences).toEqual([evidence.id]);
    } finally {
      await harness.teardown();
    }
  }, 60_000);

  test("the UGC boundary fabricates NO outcome/measurement: the full flow leaves outcome-authority state unchanged", async () => {
    const harness = await createNetW017Harness();
    try {
      const { goldenPathEngagement } = await import(
        "./_net-w017-harness.ts"
      );
      // Counts before the flow. The outcome authority collections are
      // scanned through the wired PostgresAuthority.
      const collections = [
        "outcome_observations",
        "measured_outcomes",
        "measurement_experiments",
        "counterfactual_baselines",
      ];
      const countBefore: Record<string, number> = {};
      for (const collection of collections) {
        countBefore[collection] =
          await harness.runtime.postgresAuthority.count(collection);
      }
      await goldenPathEngagement(harness);
      for (const collection of collections) {
        expect(
          await harness.runtime.postgresAuthority.count(collection),
        ).toBe(countBefore[collection]!);
      }
      // Structural: the creators boundary never imports the outcomes
      // domain (the tier checker enforces it; pinned here for the
      // UGC-specific claim).
      const { readFile } = await import("node:fs/promises");
      const { readdir } = await import("node:fs/promises");
      for (const name of await readdir("src/creators")) {
        if (!name.endsWith(".ts")) continue;
        const source = await readFile(`src/creators/${name}`, "utf8");
        expect(source).not.toContain('from "../outcomes/');
        expect(source).not.toContain('from "../settlement/');
        expect(source).not.toContain('from "../reputation/');
        expect(source).not.toContain('from "../disputes/');
        expect(source).not.toContain('from "../evidence/');
      }
    } finally {
      await harness.teardown();
    }
  }, 60_000);
});
