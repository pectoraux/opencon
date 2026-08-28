/**
 * NET-W018 — composite atomicity (fault-injection evidence, built in
 * from the start per the NET-W017 remediation decision of record:
 * cross-authority composites commit their material mutation AND the
 * workflow transition as ONE authoritative transaction).
 *
 * This suite PROVES the failure-path behavior the architect required
 * of NET-W017 applies to the NET-W018 publication verification
 * composite:
 *
 *   gate+bookkeeping staged → transition fails → NOTHING survives
 *   authorized transition denied    → NOTHING survives
 *   authoritative COMMIT fails     → NOTHING survives
 *   retry after every failure      → converges deterministically
 *
 * Work order ref: spec/work-orders/NET-W018.md §3.5.
 */

import { describe, expect, test } from "bun:test";
import type { ExecutionContext } from "../../src/core/execution-context.ts";
import type {
  AuthorityTransaction,
  PostgresAuthority,
} from "../../src/core/postgres-authority.ts";
import { createPostgresIdempotencyStore } from "../../src/persistence/idempotency-store.ts";
import { createTransactionalAuditWriter } from "../../src/audit/transactional-audit-writer.ts";
import {
  createAuthorityCommercialRelationshipRepository,
  createAuthorityDisclosureDeclarationRepository,
  createAuthorityPublicationRepository,
} from "../../src/creators/authority-sponsorship-repositories.ts";
import { createCreatorSponsorshipService } from "../../src/creators/sponsorship-service.ts";
import {
  createNetW018Harness,
  createPublication,
  createPublicationEvidence,
  declareKind,
  key,
  operatorCtx,
  type NetW018Harness,
} from "./_net-w018-harness.ts";

// ---------------------------------------------------------------------------
// Fault-injection helpers
// ---------------------------------------------------------------------------

/**
 * Patch the RUNTIME workflow service's in-tx twin to throw (the
 * architectural seam: "the workflow transition fails after the
 * material verification bookkeeping staged in the same
 * transaction"). Restores in the finally (the cp-backup
 * mutation-testing discipline).
 */
async function withFailingTransition<T>(
  harness: NetW018Harness,
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
  harness: NetW018Harness,
  eventType: string,
  resourceId?: string,
): Promise<number> {
  const events = await harness.runtime.auditWriter.query(
    resourceId ? { eventType, resourceId } : { eventType },
  );
  return events.length;
}

/** The full staging for a verifiable publication (all obligations satisfied). */
async function stageVerifiablePublication(harness: NetW018Harness): Promise<{
  publicationId: string;
  version: number;
  evidenceReferences: string[];
}> {
  const publication = await createPublication(harness, {
    requiredKinds: ["material_connection"],
  });
  await declareKind(harness, publication.id, "material_connection");
  const { evidenceId } = await createPublicationEvidence(
    harness,
    publication.id,
  );
  return {
    publicationId: publication.id,
    version: publication.version,
    evidenceReferences: [evidenceId],
  };
}

// ---------------------------------------------------------------------------
// The composite failure points
// ---------------------------------------------------------------------------

describe("NET-W018 composite atomicity (fault injection)", () => {
  test("verification: gate passed + bookkeeping staged → transition fails → NOTHING commits; retry converges", async () => {
    const harness = await createNetW018Harness();
    try {
      const staged = await stageVerifiablePublication(harness);
      let calls = 0;
      await withFailingTransition(
        harness,
        "injected transition failure",
        async (callsFn) => {
          const attempt = harness.runtime.creatorSponsorshipService.verifyPublication(
            operatorCtx(harness, "w018-atomic-fail"),
            {
              organizationScopeId: harness.organizationScopeId,
              publicationId: staged.publicationId,
              expectedVersion: staged.version,
              evidenceReferences: staged.evidenceReferences,
              idempotencyKey: key("w018-atomic-fail"),
            },
          );
          await expect(attempt).rejects.toThrow("injected transition failure");
          calls = callsFn();
        },
      );
      expect(calls).toBe(1);

      // NOTHING committed: the publication is still DRAFT with NO
      // verification bookkeeping and NO audit event.
      const after = await harness.runtime.creatorSponsorshipService.getPublication(
        operatorCtx(harness, "w018-atomic-fail-read"),
        harness.organizationScopeId,
        staged.publicationId,
      );
      expect(after.state).toBe("DRAFT");
      expect(after.version).toBe(staged.version);
      expect(after.verifiedAt).toBeNull();
      expect(after.publicationEvidenceReferences).toEqual([]);
      expect(
        await auditCount(harness, "publication.verified", staged.publicationId),
      ).toBe(0);
      expect(
        await auditCount(
          harness,
          "publication.transition.draft_to_verified",
          staged.publicationId,
        ),
      ).toBe(0);

      // RETRY with the healthy twin converges: same key (the failed
      // apply left NO idempotency record — full rollback) or fresh
      // key both work; use a FRESH key to prove the state itself is
      // clean.
      const retried = await harness.runtime.creatorSponsorshipService.verifyPublication(
        operatorCtx(harness, "w018-atomic-retry"),
        {
          organizationScopeId: harness.organizationScopeId,
          publicationId: staged.publicationId,
          expectedVersion: staged.version,
          evidenceReferences: staged.evidenceReferences,
          idempotencyKey: key("w018-atomic-retry"),
        },
      );
      expect(retried.publication.state).toBe("VERIFIED");
      expect(retried.publication.publicationEvidenceReferences).toEqual(
        staged.evidenceReferences,
      );
      expect(
        await auditCount(harness, "publication.verified", staged.publicationId),
      ).toBe(1);
    } finally {
      await harness.teardown();
    }
  });

  test("verification: the transition is AUTHORIZATION-DENIED → NOTHING commits (the twin's deny-by-default)", async () => {
    const harness = await createNetW018Harness();
    try {
      const staged = await stageVerifiablePublication(harness);
      // A person with NO publication-transition policy: the twin's
      // authorizer denies (deny-by-default) AFTER the gate passed
      // and the bookkeeping staged — everything rolls back.
      const strangerId = `stranger-${key("s")}`;
      const strangerCtx = {
        correlationId: "w018-atomic-denied",
        actor: { id: strangerId, kind: "person" },
        executionId: "w018-atomic-denied",
        causationId: null,
      } as unknown as ExecutionContext;
      await expect(
        harness.runtime.creatorSponsorshipService.verifyPublication(
          strangerCtx,
          {
            organizationScopeId: harness.organizationScopeId,
            publicationId: staged.publicationId,
            expectedVersion: staged.version,
            evidenceReferences: staged.evidenceReferences,
            idempotencyKey: key("w018-atomic-denied"),
          },
        ),
      ).rejects.toMatchObject({ code: "AUTHORIZATION" });

      const after = await harness.runtime.creatorSponsorshipService.getPublication(
        operatorCtx(harness, "w018-atomic-denied-read"),
        harness.organizationScopeId,
        staged.publicationId,
      );
      expect(after.state).toBe("DRAFT");
      expect(after.verifiedAt).toBeNull();
      expect(after.publicationEvidenceReferences).toEqual([]);
      expect(
        await auditCount(harness, "publication.verified", staged.publicationId),
      ).toBe(0);
    } finally {
      await harness.teardown();
    }
  });

  test("verification: the authoritative COMMIT itself fails → NOTHING commits; healthy retry converges", async () => {
    const harness = await createNetW018Harness();
    // The W017 remediation pattern: a transaction wrapper whose
    // commit() always fails after the composite staged everything.
    class CommitFailingTransaction implements AuthorityTransaction {
      public constructor(
        private readonly inner: AuthorityTransaction,
      ) {}
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
    try {
      const staged = await stageVerifiablePublication(harness);
      // Rebuild the sponsorship service over a COMMIT-FAILING
      // authority (the W006/W017 rebuild pattern): every repository
      // write and the workflow twin execute against the SAME
      // underlying authority, but the authoritative commit fails —
      // the buffered audit is discarded with the rollback and
      // NOTHING becomes durable.
      const failingAuthority: PostgresAuthority = {
        async begin(context: ExecutionContext) {
          return new CommitFailingTransaction(
            await harness.runtime.postgresAuthority.begin(context),
          );
        },
        async run<T>(
          context: ExecutionContext,
          work: (tx: AuthorityTransaction) => Promise<T>,
        ): Promise<T> {
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
      const failingService = createCreatorSponsorshipService({
        relationshipRepository:
          createAuthorityCommercialRelationshipRepository({
            authority: harness.runtime.postgresAuthority,
          }),
        declarationRepository: createAuthorityDisclosureDeclarationRepository(
          { authority: harness.runtime.postgresAuthority },
        ),
        publicationRepository: createAuthorityPublicationRepository({
          authority: harness.runtime.postgresAuthority,
        }),
        engagementRepository: (
          await import("../../src/creators/authority-engagement-repositories.ts")
        ).createAuthorityEngagementRepository({
          authority: harness.runtime.postgresAuthority,
        }),
        productionRepository: (
          await import("../../src/creators/authority-engagement-repositories.ts")
        ).createAuthorityUgcProductionRepository({
          authority: harness.runtime.postgresAuthority,
        }),
        lookups: {
          campaignDisclosurePolicy: {
            async resolve(campaignId, policyVersion) {
              const campaign = await harness.runtime.campaignService.getCampaign(
                operatorCtx(harness, "w018-atomic-commit"),
                campaignId,
              );
              if (
                policyVersion !== undefined &&
                campaign.currentPolicyVersion !== policyVersion
              ) {
                const versions =
                  await harness.runtime.campaignService.listPolicyVersions(
                    operatorCtx(harness, "w018-atomic-commit"),
                    campaignId,
                  );
                if (!versions.some((v) => v.version === policyVersion)) {
                  return null;
                }
              }
              return {
                campaignId: campaign.id,
                organizationScopeId: campaign.organizationScopeId,
                policyVersion: campaign.currentPolicyVersion,
                requiredKinds:
                  policyVersion !== undefined
                    ? ((
                        await harness.runtime.campaignService.getPolicyVersion(
                          operatorCtx(harness, "w018-atomic-commit"),
                          campaignId,
                          policyVersion,
                        )
                      ).disclosurePolicy.requiredKinds ?? [])
                    : [],
              };
            },
          },
          evidence: {
            async resolve(evidenceId) {
              const evidence = await harness.runtime.evidenceService.getEvidence(
                operatorCtx(harness, "w018-atomic-commit"),
                evidenceId,
              );
              return {
                id: evidence.id,
                organizationScopeId: evidence.organizationScopeId,
                subjectType: evidence.subjectReference.subjectType,
                subjectId: evidence.subjectReference.subjectId,
              };
            },
          },
        },
        workflow: {
          async requestTransitionWithinTx(
            request,
            execution,
            tx,
            idempotencyRecordId,
          ) {
            return harness.runtime.workflowService.requestTransitionWithinTx(
              request,
              execution,
              tx,
              idempotencyRecordId,
            );
          },
        },
        idempotency: failingIdempotency,
        auditWriter: createTransactionalAuditWriter({
          underlying: harness.runtime.auditWriter,
        }),
        logger: harness.runtime.logger.forModule("creators"),
      });
      await expect(
        failingService.verifyPublication(
          operatorCtx(harness, "w018-atomic-commit"),
          {
            organizationScopeId: harness.organizationScopeId,
            publicationId: staged.publicationId,
            expectedVersion: staged.version,
            evidenceReferences: staged.evidenceReferences,
            idempotencyKey: key("w018-atomic-commit"),
          },
        ),
      ).rejects.toThrow("injected authoritative COMMIT failure");

      // NOTHING committed.
      const after = await harness.runtime.creatorSponsorshipService.getPublication(
        operatorCtx(harness, "w018-atomic-commit-read"),
        harness.organizationScopeId,
        staged.publicationId,
      );
      expect(after.state).toBe("DRAFT");
      expect(after.verifiedAt).toBeNull();
      expect(after.publicationEvidenceReferences).toEqual([]);
      expect(
        await auditCount(harness, "publication.verified", staged.publicationId),
      ).toBe(0);

      // A healthy retry through the REAL service converges.
      const retried = await harness.runtime.creatorSponsorshipService.verifyPublication(
        operatorCtx(harness, "w018-atomic-commit-retry"),
        {
          organizationScopeId: harness.organizationScopeId,
          publicationId: staged.publicationId,
          expectedVersion: staged.version,
          evidenceReferences: staged.evidenceReferences,
          idempotencyKey: key("w018-atomic-commit-retry"),
        },
      );
      expect(retried.publication.state).toBe("VERIFIED");
      expect(
        await auditCount(harness, "publication.verified", staged.publicationId),
      ).toBe(1);
    } finally {
      await harness.teardown();
    }
  });
});
