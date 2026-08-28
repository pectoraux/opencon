/**
 * NET-W017 remediation — composite atomicity (fault-injection evidence).
 *
 * Architect review on PR #34: CHANGES REQUESTED. The blocking issue:
 * the engagement composites (acceptance / production-open / submission)
 * performed their material mutation and the workflow transition as
 * SEPARATE authoritative transactions — the second could fail after
 * the first committed (an orphaned ACTIVE usage-rights grant /
 * production / submission for a lifecycle state that never occurred).
 *
 * The remediation (the architect's PREFERRED option): the material
 * record AND the transition now commit in ONE authoritative
 * transaction (the sanctioned in-tx /workflows twin executing inside
 * the composite's `applyIdempotent`).
 *
 * This suite PROVES the failure-path behavior the architect required:
 *
 *   accept:      rights staged → transition fails → NOTHING survives
 *   open:        production staged → transition fails → NOTHING survives
 *   submit:      submission staged → transition fails → NOTHING survives
 *   commit:      the authoritative COMMIT itself fails → NOTHING survives
 *   retry:       every injected failure converges deterministically
 *   batch saga:  journal-first; unexpected failure ABORTS with an exact
 *                journal; same-key retry resumes and COMPLETES
 *
 * Work order ref: spec/work-orders/NET-W017.md §3.6 (remediation).
 */

import { describe, expect, test } from "bun:test";
import type { AuthorityTransaction, PostgresAuthority } from "../../src/core/postgres-authority.ts";
import type { ExecutionContext } from "../../src/core/execution-context.ts";
import { createWorkflowService } from "../../src/workflows/workflow-service.ts";
import { createLifecycleRepository } from "../../src/workflows/lifecycle-repository.ts";
import type { TransitionAuthorizer } from "../../src/workflows/port.ts";
import { createPostgresIdempotencyStore } from "../../src/persistence/idempotency-store.ts";
import {
  createAuthorityEngagementRepository,
  createAuthorityAcceptancePolicyRepository,
  createAuthorityUsageRightsRepository,
  createAuthorityUgcProductionRepository,
  createAuthorityUgcDeliverableRepository,
  createAuthorityUgcSubmissionRepository,
  createAuthorityEngagementBatchRepository,
} from "../../src/creators/authority-engagement-repositories.ts";
import { createCreatorEngagementService } from "../../src/creators/engagement-service.ts";
import type { CreatorEngagementServiceDeps } from "../../src/creators/port.ts";
import {
  createNetW017Harness,
  personCtx,
  creatorCtx,
  operatorCtx,
  key,
  createEngagement,
  tenderEngagement,
  acceptEngagement,
  openProduction,
  recordDeliverable,
  createProductionEvidence,
  type NetW017Harness,
} from "./_net-w017-harness.ts";

// ---------------------------------------------------------------------------
// Fault-injection helpers
// ---------------------------------------------------------------------------

/**
 * Patch the RUNTIME workflow service's in-tx twin to throw (the
 * architectural seam: "the workflow transition fails after the
 * material record staged in the same transaction"). The patch is
 * applied to the SAME object the runtime's engagement adapter closes
 * over, so the composite sees it. Asserts the mutation APPLIED, and
 * restores in the finally (the cp-backup mutation-testing discipline).
 */
async function withFailingTransition<T>(
  harness: NetW017Harness,
  message: string,
  fn: (calls: () => number) => Promise<T>,
): Promise<T> {
  const service = harness.runtime.workflowService as unknown as {
    requestTransitionWithinTx: (...args: unknown[]) => Promise<unknown>;
  };
  const original = service.requestTransitionWithinTx;
  let calls = 0;
  service.requestTransitionWithinTx = async (...args: unknown[]) => {
    calls += 1;
    void args;
    throw new Error(message);
  };
  if (service.requestTransitionWithinTx === original) {
    throw new Error("fault injection failed to apply (frozen service?)");
  }
  try {
    return await fn(() => calls);
  } finally {
    service.requestTransitionWithinTx = original;
    if (service.requestTransitionWithinTx !== original) {
      throw new Error("fault injection failed to restore");
    }
  }
}

/** Count audit events of one type for one resource. */
async function auditCount(
  harness: NetW017Harness,
  eventType: string,
  resourceId?: string,
): Promise<number> {
  const events = await harness.runtime.auditWriter.query(
    resourceId ? { eventType, resourceId } : { eventType },
  );
  return events.length;
}

// ---------------------------------------------------------------------------
// The three composite failure points
// ---------------------------------------------------------------------------

describe("NET-W017 remediation — composite atomicity (fault injection)", () => {
  test("accept: rights staged → transition fails → NOTHING commits; retry converges", async () => {
    const harness = await createNetW017Harness();
    try {
      const { engagement } = await createEngagement(harness);
      await tenderEngagement(harness, engagement.id, 0);
      const ctx = creatorCtx(harness, "w017-fault-accept");
      const idempotencyKey = key("w017-fault-accept");
      const { grantedRightsFixture } = await import("./_net-w017-harness.ts");

      let sawFailure = false;
      await withFailingTransition(
        harness,
        "injected workflow transition failure (accept)",
        async (calls) => {
          await expect(
            harness.runtime.creatorEngagementService.acceptEngagement(ctx, {
              organizationScopeId: harness.organizationScopeId,
              engagementId: engagement.id,
              expectedVersion: 1,
              grantedRights: grantedRightsFixture(),
              idempotencyKey,
            }),
          ).rejects.toThrow("injected workflow transition failure (accept)");
          expect(calls()).toBe(1);
          sawFailure = true;
        },
      );
      expect(sawFailure).toBe(true);

      // NOTHING survived the failed composite: the engagement is
      // still READY at version 1, there is NO grant, and NEITHER the
      // grant audit event NOR the transition audit event exists.
      const stored = await harness.runtime.creatorEngagementService.getEngagement(
        personCtx(harness, harness.operatorPersonId, "w017-fault-read"),
        harness.organizationScopeId,
        engagement.id,
      );
      expect(stored.state).toBe("READY");
      expect(stored.version).toBe(1);
      const grants =
        await harness.runtime.creatorEngagementService.listUsageRights(
          personCtx(harness, harness.operatorPersonId, "w017-fault-rights"),
          harness.organizationScopeId,
          engagement.id,
        );
      expect(grants).toHaveLength(0);
      expect(
        await auditCount(harness, "usage_rights.granted"),
      ).toBe(0);
      expect(
        await auditCount(
          harness,
          "engagement.transition.ready_to_assigned",
          engagement.id,
        ),
      ).toBe(0);

      // RETRY with the SAME key on the healthy service: the composite
      // executes fully (grant + transition, exactly one audit each).
      const retried = await harness.runtime.creatorEngagementService.acceptEngagement(
        ctx,
        {
          organizationScopeId: harness.organizationScopeId,
          engagementId: engagement.id,
          expectedVersion: 1,
          grantedRights: grantedRightsFixture(),
          idempotencyKey,
        },
      );
      expect(retried.engagement.state).toBe("ASSIGNED");
      expect(retried.transition.executed).toBe(true);
      expect(
        await auditCount(harness, "usage_rights.granted"),
      ).toBe(1);
      expect(
        await auditCount(
          harness,
          "engagement.transition.ready_to_assigned",
          engagement.id,
        ),
      ).toBe(1);

      // Replay: deterministic, NOTHING new.
      const replay = await harness.runtime.creatorEngagementService.acceptEngagement(
        ctx,
        {
          organizationScopeId: harness.organizationScopeId,
          engagementId: engagement.id,
          expectedVersion: 1,
          grantedRights: grantedRightsFixture(),
          idempotencyKey,
        },
      );
      expect(replay.transition.executed).toBe(false);
      expect(
        await auditCount(harness, "usage_rights.granted"),
      ).toBe(1);
    } finally {
      await harness.teardown();
    }
  }, 60_000);

  test("open production: production staged → transition fails → NOTHING commits; retry converges", async () => {
    const harness = await createNetW017Harness();
    try {
      const { engagement } = await createEngagement(harness);
      await tenderEngagement(harness, engagement.id, 0);
      const accepted = await acceptEngagement(harness, engagement.id, 1);
      const ctx = personCtx(harness, harness.creatorPersonId, "w017-fault-open");
      const idempotencyKey = key("w017-fault-open");

      await withFailingTransition(
        harness,
        "injected workflow transition failure (open)",
        async (calls) => {
          await expect(
            harness.runtime.creatorEngagementService.openProduction(ctx, {
              organizationScopeId: harness.organizationScopeId,
              engagementId: accepted.engagement.id,
              expectedVersion: 2,
              idempotencyKey,
            }),
          ).rejects.toThrow("injected workflow transition failure (open)");
          expect(calls()).toBe(1);
        },
      );

      // NOTHING survived: still ASSIGNED v2, NO production record, NO
      // audit events for the production or the transition.
      const stored = await harness.runtime.creatorEngagementService.getEngagement(
        personCtx(harness, harness.operatorPersonId, "w017-fault-read"),
        harness.organizationScopeId,
        engagement.id,
      );
      expect(stored.state).toBe("ASSIGNED");
      expect(stored.version).toBe(2);
      const productions =
        await harness.runtime.creatorEngagementService.listProductions(
          personCtx(harness, harness.operatorPersonId, "w017-fault-prods"),
          harness.organizationScopeId,
          engagement.id,
        );
      expect(productions).toHaveLength(0);
      expect(await auditCount(harness, "ugc_production.opened")).toBe(0);
      expect(
        await auditCount(
          harness,
          "engagement.transition.assigned_to_in_progress",
          engagement.id,
        ),
      ).toBe(0);

      // Retry: converges (production + IN_PROGRESS, exactly one audit each).
      const retried = await harness.runtime.creatorEngagementService.openProduction(
        ctx,
        {
          organizationScopeId: harness.organizationScopeId,
          engagementId: accepted.engagement.id,
          expectedVersion: 2,
          idempotencyKey,
        },
      );
      expect(retried.transition.subject.state).toBe("IN_PROGRESS");
      expect(await auditCount(harness, "ugc_production.opened")).toBe(1);
      expect(
        await auditCount(
          harness,
          "engagement.transition.assigned_to_in_progress",
          engagement.id,
        ),
      ).toBe(1);
    } finally {
      await harness.teardown();
    }
  }, 60_000);

  test("submit: submission staged → transition fails → NOTHING commits; retry converges", async () => {
    const harness = await createNetW017Harness();
    try {
      const { engagement } = await createEngagement(harness);
      await tenderEngagement(harness, engagement.id, 0);
      const accepted = await acceptEngagement(harness, engagement.id, 1);
      const opened = await openProduction(
        harness,
        accepted.engagement.id,
        2,
      );
      await recordDeliverable(harness, opened.production.id);
      const { evidenceId } = await createProductionEvidence(
        harness,
        opened.production.id,
      );
      const ctx = personCtx(harness, harness.creatorPersonId, "w017-fault-submit");
      const idempotencyKey = key("w017-fault-submit");

      await withFailingTransition(
        harness,
        "injected workflow transition failure (submit)",
        async (calls) => {
          await expect(
            harness.runtime.creatorEngagementService.submitProduction(ctx, {
              organizationScopeId: harness.organizationScopeId,
              productionId: opened.production.id,
              expectedVersion: opened.engagementVersion,
              evidenceReferences: [evidenceId],
              idempotencyKey,
            }),
          ).rejects.toThrow("injected workflow transition failure (submit)");
          expect(calls()).toBe(1);
        },
      );

      // NOTHING survived: still IN_PROGRESS, NO submission, NO audits.
      const stored = await harness.runtime.creatorEngagementService.getEngagement(
        personCtx(harness, harness.operatorPersonId, "w017-fault-read"),
        harness.organizationScopeId,
        engagement.id,
      );
      expect(stored.state).toBe("IN_PROGRESS");
      const submissions =
        await harness.runtime.creatorEngagementService.listSubmissions(
          personCtx(harness, harness.operatorPersonId, "w017-fault-subs"),
          harness.organizationScopeId,
          opened.production.id,
        );
      expect(submissions).toHaveLength(0);
      expect(await auditCount(harness, "ugc_production.submitted")).toBe(0);
      expect(
        await auditCount(
          harness,
          "engagement.transition.in_progress_to_submitted",
          engagement.id,
        ),
      ).toBe(0);

      // Retry: converges (submission + SUBMITTED, exactly one audit each).
      const retried = await harness.runtime.creatorEngagementService.submitProduction(
        ctx,
        {
          organizationScopeId: harness.organizationScopeId,
          productionId: opened.production.id,
          expectedVersion: opened.engagementVersion,
          evidenceReferences: [evidenceId],
          idempotencyKey,
        },
      );
      expect(retried.transition.subject.state).toBe("SUBMITTED");
      expect(await auditCount(harness, "ugc_production.submitted")).toBe(1);
      expect(
        await auditCount(
          harness,
          "engagement.transition.in_progress_to_submitted",
          engagement.id,
        ),
      ).toBe(1);
    } finally {
      await harness.teardown();
    }
  }, 60_000);

  // -------------------------------------------------------------------------
  // The deepest failure point: the authoritative COMMIT itself
  // -------------------------------------------------------------------------

  /** A transaction whose AUTHORITATIVE commit fails (the W006 pattern). */
  class CommitFailingTransaction implements AuthorityTransaction {
    public constructor(private readonly inner: AuthorityTransaction) {}
    get transactionId(): string {
      return this.inner.transactionId;
    }
    get settled(): boolean {
      return this.inner.settled;
    }
    get<T = unknown>(collection: string, key: string) {
      return this.inner.get<T>(collection, key);
    }
    scan<T = unknown>(collection: string) {
      return this.inner.scan<T>(collection);
    }
    put<T>(collection: string, key: string, value: T) {
      return this.inner.put<T>(collection, key, value);
    }
    delete(collection: string, key: string) {
      return this.inner.delete(collection, key);
    }
    afterCommit(hook: () => Promise<void>): void {
      this.inner.afterCommit(hook);
    }
    afterRollback(hook: () => Promise<void>): void {
      this.inner.afterRollback(hook);
    }
    async commit(): Promise<void> {
      throw new Error("injected authoritative COMMIT failure");
    }
    async rollback(): Promise<void> {
      return this.inner.rollback();
    }
  }

  test("the deepest point: a FAILED AUTHORITATIVE COMMIT on the acceptance composite commits NOTHING; retry on the healthy stack converges", async () => {
    const harness = await createNetW017Harness();
    try {
      const { engagement } = await createEngagement(harness);
      await tenderEngagement(harness, engagement.id, 0);
      const { grantedRightsFixture } = await import("./_net-w017-harness.ts");
      const idempotencyKey = key("w017-fault-commit");

      // Rebuild the engagement service over a COMMIT-FAILING authority
      // (the W006 rebuild pattern): every repository write and the
      // workflow twin execute against the SAME underlying authority,
      // but the authoritative commit fails — the buffered audit is
      // discarded with the rollback and NOTHING becomes durable.
      const failingAuthority: PostgresAuthority = {
        async begin(context: ExecutionContext) {
          return new CommitFailingTransaction(
            await harness.runtime.postgresAuthority.begin(context),
          );
        },
        async run<T>(
          context: ExecutionContext,
          work: (tx: AuthorityTransaction) => Promise<T>,
        ) {
          const tx = new CommitFailingTransaction(
            await harness.runtime.postgresAuthority.begin(context),
          );
          try {
            const result = await work(tx);
            await tx.commit();
            return result;
          } catch (err) {
            await tx.rollback();
            throw err;
          }
        },
        get<T = unknown>(collection: string, key: string) {
          return harness.runtime.postgresAuthority.get<T>(collection, key);
        },
        scan<T = unknown>(collection: string) {
          return harness.runtime.postgresAuthority.scan<T>(collection);
        },
        count(collection: string) {
          return harness.runtime.postgresAuthority.count(collection);
        },
        recover() {
          return harness.runtime.postgresAuthority.recover();
        },
        close() {
          return harness.runtime.postgresAuthority.close();
        },
      };
      const failingIdempotency = createPostgresIdempotencyStore({
        authority: failingAuthority,
      });
      const failingEngagementRepo = createAuthorityEngagementRepository({
        authority: failingAuthority,
      });
      const allowAllAuthorizer: TransitionAuthorizer = {
        async authorizeTransition() {
          return { decision: "allow", reason: "test" };
        },
      };
      const failingWorkflow = createWorkflowService({
        opportunityRepository: createLifecycleRepository(
          createAuthorityEngagementRepository({
            authority: failingAuthority,
          }),
        ),
        contributionRepository: createLifecycleRepository(
          createAuthorityEngagementRepository({
            authority: failingAuthority,
          }),
        ),
        proofOfValueRepository: createLifecycleRepository(
          createAuthorityEngagementRepository({
            authority: failingAuthority,
          }),
        ),
        outcomeMeasurementRepository: createLifecycleRepository(
          createAuthorityEngagementRepository({
            authority: failingAuthority,
          }),
        ),
        engagementRepository: createLifecycleRepository(failingEngagementRepo),
        authorizer: allowAllAuthorizer,
        auditWriter: harness.runtime.auditWriter,
        idempotency: failingIdempotency,
        coordination: {
          async acquireLock() {
            return {
              token: "test",
              key: "test",
              acquired: false,
              release: async () => false,
            };
          },
        } as unknown as Parameters<typeof createWorkflowService>[0]["coordination"],
      });
      const failingDeps = {
        engagementRepository: failingEngagementRepo,
        acceptancePolicyRepository: createAuthorityAcceptancePolicyRepository({
          authority: failingAuthority,
        }),
        usageRightsRepository: createAuthorityUsageRightsRepository({
          authority: failingAuthority,
        }),
        productionRepository: createAuthorityUgcProductionRepository({
          authority: failingAuthority,
        }),
        deliverableRepository: createAuthorityUgcDeliverableRepository({
          authority: failingAuthority,
        }),
        submissionRepository: createAuthorityUgcSubmissionRepository({
          authority: failingAuthority,
        }),
        batchRepository: createAuthorityEngagementBatchRepository({
          authority: failingAuthority,
        }),
        // Read-only deps the plain acceptance path never touches.
        profileRepository: {
          findById: async () => null,
        },
        versionRepository: {
          findVersion: async () => null,
          latest: async () => null,
        },
        runRepository: {
          findById: async () => null,
        },
        lookups: {
          campaign: { resolve: async () => null },
          opportunity: {
            getOrganizationScope: async () => null,
            exists: async () => false,
          },
          contribution: {
            getOrganizationScope: async () => null,
            exists: async () => false,
          },
          safety: { activeHold: async () => ({ held: false }) },
          evidence: { resolve: async () => null },
        },
        workflow: failingWorkflow,
        idempotency: failingIdempotency,
        auditWriter: harness.runtime.auditWriter,
        logger: {
          debug() {},
          info() {},
          warn() {},
          error() {},
          child() {
            return this;
          },
          forModule() {
            return this;
          },
        },
      } as unknown as CreatorEngagementServiceDeps;
      const failingService = createCreatorEngagementService(failingDeps);
      const ctx = creatorCtx(harness, "w017-fault-commit");

      // The composite fails at the AUTHORITATIVE COMMIT — after both
      // the grant write and the transition write were staged.
      await expect(
        failingService.acceptEngagement(ctx, {
          organizationScopeId: harness.organizationScopeId,
          engagementId: engagement.id,
          expectedVersion: 1,
          grantedRights: grantedRightsFixture(),
          idempotencyKey,
        }),
      ).rejects.toThrow("injected authoritative COMMIT failure");

      // NOTHING is durable: engagement READY v1, no grant, no audits.
      const stored = await harness.runtime.creatorEngagementService.getEngagement(
        personCtx(harness, harness.operatorPersonId, "w017-fault-read"),
        harness.organizationScopeId,
        engagement.id,
      );
      expect(stored.state).toBe("READY");
      expect(stored.version).toBe(1);
      expect(
        (
          await harness.runtime.creatorEngagementService.listUsageRights(
            personCtx(harness, harness.operatorPersonId, "w017-fault-rights"),
            harness.organizationScopeId,
            engagement.id,
          )
        ).length,
      ).toBe(0);
      expect(await auditCount(harness, "usage_rights.granted")).toBe(0);
      expect(
        await auditCount(
          harness,
          "engagement.transition.ready_to_assigned",
          engagement.id,
        ),
      ).toBe(0);

      // Retry with the SAME key on the HEALTHY runtime: full success.
      const retried = await harness.runtime.creatorEngagementService.acceptEngagement(
        ctx,
        {
          organizationScopeId: harness.organizationScopeId,
          engagementId: engagement.id,
          expectedVersion: 1,
          grantedRights: grantedRightsFixture(),
          idempotencyKey,
        },
      );
      expect(retried.engagement.state).toBe("ASSIGNED");
      expect(await auditCount(harness, "usage_rights.granted")).toBe(1);
    } finally {
      await harness.teardown();
    }
  }, 60_000);

  // -------------------------------------------------------------------------
  // The batch saga: journal-first, ABORTED on failure, deterministic recovery
  // -------------------------------------------------------------------------

  test("the batch saga: an unexpected mid-batch failure ABORTS with an exact journal; the same-key retry resumes and COMPLETES", async () => {
    const harness = await createNetW017Harness();
    try {
      const { createActiveCampaign, requestedRightsFixture } = await import(
        "./_net-w017-harness.ts"
      );
      const { createMatchCandidate, runMatch, baselineRequirements } =
        await import("./_net-w016-harness.ts");
      const w016 = harness.w016;
      const campaign = await createActiveCampaign(harness);
      // TWO eligible candidates, deterministic rank order.
      const first = await createMatchCandidate(w016, {});
      const second = await createMatchCandidate(w016, {});
      const { run } = await runMatch(w016, {
        campaign: { campaignId: campaign.id },
        requirements: baselineRequirements(),
        candidateProfileIds: [first.profile.id, second.profile.id],
        idempotencyKey: key("w017-saga-match"),
      });
      expect(run.results.length).toBe(2);
      // RANK ORDER governs processing — poison the candidate that
      // ranks SECOND (the deterministic rank may reorder creation).
      const rankedFirst = run.results[0]!;
      const rankedSecond = run.results[1]!;
      const poisonProfileId = rankedSecond.profileId;

      const ctx = operatorCtx(harness, "w017-saga");
      const idempotencyKey = key("w017-saga");

      // Inject an UNEXPECTED failure at the SECOND candidate's offer
      // (its per-candidate idempotency key ends with the profile id).
      const store = harness.runtime.idempotency as unknown as {
        applyIdempotent: <T>(
          key: string,
          fn: (ctx: unknown) => Promise<T>,
          execution: ExecutionContext,
        ) => Promise<{ executed: boolean; result: T; recordId: string }>;
      };
      const originalApply = store.applyIdempotent.bind(store);
      (store as { applyIdempotent: unknown }).applyIdempotent = async <
        T,
      >(
        k: string,
        fn: (ctx: unknown) => Promise<T>,
        ex: ExecutionContext,
      ) => {
        if (k.endsWith(`:${poisonProfileId}`)) {
          throw new Error("injected candidate failure (saga)");
        }
        return originalApply<T>(k, fn, ex);
      };

      let batchId: string | null = null;
      try {
        await harness.runtime.creatorEngagementService.createEngagementsFromMatch(
          ctx,
          {
            organizationScopeId: harness.organizationScopeId,
            matchRunId: run.id,
            offer: {
              requestedRights: requestedRightsFixture(),
              compensation: null,
              brief: null,
            },
            idempotencyKey,
          },
        );
        expect.unreachable("the injected candidate failure must propagate");
      } catch (error) {
        expect((error as Error).message).toBe("injected candidate failure (saga)");
      } finally {
        // Restore the store BEFORE any assertions (cp-backup restore).
        (store as { applyIdempotent: unknown }).applyIdempotent =
          originalApply as unknown;
      }

      // The ABORTED batch record is durable and accurate.
      const batches =
        await harness.runtime.creatorEngagementService.listEngagements(
          ctx,
          harness.organizationScopeId,
          { campaignId: campaign.id },
        );
      expect(batches.length).toBeGreaterThanOrEqual(1);
      // The FIRST candidate's offer exists (created before the failure).
      const firstEngagements = batches.filter(
        (e) => e.creatorPersonId === rankedFirst.creatorPersonId,
      );
      expect(firstEngagements).toHaveLength(1);
      // Locate the batch via its journal: the first candidate's
      // outcome row references the batch id.
      const abortedJournal =
        await harness.runtime.creatorEngagementService.listEngagementBatchOutcomes(
          ctx,
          harness.organizationScopeId,
          // The journal row id is deterministic per batch — discover
          // the batch id from the aborted audit event.
          (
            (
              await harness.runtime.auditWriter.query({
                eventType: "engagement.batch_aborted",
              })
            )[0] as { resourceId: string } | undefined
          )?.resourceId ?? "",
        );
      expect(abortedJournal).toHaveLength(1);
      expect(abortedJournal[0]!.outcome.created).toBe(true);
      expect(abortedJournal[0]!.outcome.engagementId).toBe(
        firstEngagements[0]!.id,
      );
      batchId = abortedJournal[0]!.batchId;
      const abortedBatch =
        await harness.runtime.creatorEngagementService.getEngagementBatch(
          ctx,
          harness.organizationScopeId,
          batchId!,
        );
      expect(abortedBatch.status).toBe("ABORTED");
      expect(abortedBatch.candidateCount).toBe(2);
      expect(abortedBatch.abortedReason).toContain(poisonProfileId);
      expect(abortedBatch.abortedReason).toContain(
        "injected candidate failure (saga)",
      );
      // The SECOND candidate has NO offer (the failure point).
      const secondEngagements = batches.filter(
        (e) => e.creatorPersonId === rankedSecond.creatorPersonId,
      );
      expect(secondEngagements).toHaveLength(0);

      // RECOVERY: the same-key retry resumes deterministically — the
      // journaled candidate stands, the failed one executes, the saga
      // COMPLETES with the full, accurate snapshot.
      const recovered =
        await harness.runtime.creatorEngagementService.createEngagementsFromMatch(
          ctx,
          {
            organizationScopeId: harness.organizationScopeId,
            matchRunId: run.id,
            offer: {
              requestedRights: requestedRightsFixture(),
              compensation: null,
              brief: null,
            },
            idempotencyKey,
          },
        );
      expect(recovered.batch.status).toBe("COMPLETED");
      expect(recovered.batch.id).toBe(batchId);
      expect(recovered.batch.candidateCount).toBe(2);
      expect(recovered.batch.outcomes).toHaveLength(2);
      const byProfile = new Map(
        recovered.batch.outcomes.map((o) => [o.creatorProfileId, o]),
      );
      expect(byProfile.get(rankedFirst.profileId)!.created).toBe(true);
      expect(byProfile.get(rankedFirst.profileId)!.engagementId).toBe(
        firstEngagements[0]!.id,
      );
      expect(byProfile.get(rankedSecond.profileId)!.created).toBe(true);
      expect(byProfile.get(rankedSecond.profileId)!.engagementId).toBeTypeOf(
        "string",
      );
      // Exactly ONE journal row per candidate (create-once keys).
      const finalJournal =
        await harness.runtime.creatorEngagementService.listEngagementBatchOutcomes(
          ctx,
          harness.organizationScopeId,
          batchId!,
        );
      expect(finalJournal).toHaveLength(2);
      // The audit lineage: recorded → aborted → completed (each once).
      expect(
        await auditCount(harness, "engagement.batch_recorded"),
      ).toBe(1);
      expect(
        await auditCount(harness, "engagement.batch_aborted"),
      ).toBe(1);
      expect(
        await auditCount(harness, "engagement.batch_completed"),
      ).toBe(1);
    } finally {
      await harness.teardown();
    }
  }, 60_000);
});
