/**
 * NET-W036 AC-04 — Fulfillment lifecycle (work order §5 AC-04 + the
 * frozen ledger §4): execution enters fulfillment/execution through
 * the EXISTING sanctioned `/workflows` lifecycle authority wherever
 * lifecycle state applies — there is NO second procurement state
 * machine, and direct lifecycle/repository mutation plus bypass
 * attempts fail closed.
 *
 * The fulfillment subject is the CONTRIBUTION contributed by the
 * SELECTED supplier (created through runtime.opportunityService +
 * runtime.contributionService — the harness's canonical construction,
 * over a qualified pool + recorded competitive selection), and every
 * lifecycle mutation runs exclusively through
 * `runtime.workflowService.requestTransition` with the
 * `policyActionFor("contribution", from, to)` policy action.
 *
 * Mutation targets covered (ledger §4): direct state write; bypass
 * sanctioned lifecycle transition. The structural test additionally
 * pins that this suite contains NO repository write call and NO local
 * state-machine/status-transition vocabulary (the regression-suite
 * discipline, applied at the source level).
 *
 * DETERMINISM (§3.1): fixed idempotency keys only (`w036-ac04-…`),
 * fixed person/subject fixtures — NO `Date.now(`, NO `randomUUID`, NO
 * `new Date(` code tokens in this file. ONE harness per file (the
 * W025/W026 AC-suite precedent).
 */

import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import {
  createNetW036Harness,
  walkToVerified,
  type NetW036Harness,
} from "./_net-w036-harness.ts";
import { policyActionFor, type LifecycleState } from "../../src/core/workflow.ts";
import type { Contribution } from "../../src/contributions/port.ts";
import type {
  CompetitiveSelection,
  ProcurementCommitment,
  ProcurementPool,
  SupplierOffer,
} from "../../src/demand/port.ts";

const REPO = join(import.meta.dir, "../..");

let harness: NetW036Harness;

beforeAll(async () => {
  harness = await createNetW036Harness();
}, 180_000);

afterAll(async () => {
  await harness.teardown();
});

// ---------------------------------------------------------------------------
// Deterministic fixtures (fixed keys; every seed its OWN pool — the
// AC-01..03 suite discipline)
// ---------------------------------------------------------------------------

/** Seed one QUALIFIED pool (three buyer organizations, all NA_EAST). */
async function seedQualifiedPoolWithCommitments(
  name: string,
  poolKey: string,
): Promise<{
  readonly pool: ProcurementPool;
  readonly commitments: readonly ProcurementCommitment[];
}> {
  const scope = harness.organizationScopeId;
  const pool = (
    await harness.runtime.procurementService.createProcurementPool(
      harness.poolCreatorCtx("w036-ac04-pool"),
      {
        organizationScopeId: scope,
        name,
        categoryKey: "cloud_infrastructure",
        qualificationPolicy: {
          minimumCommitments: 2,
          minimumOrganizations: 2,
        },
        idempotencyKey: poolKey,
      },
    )
  ).pool;
  const commitmentSeeds: readonly {
    readonly ctx: ReturnType<typeof harness.poolCreatorCtx>;
    readonly buyerOrganizationId: string;
    readonly quantity: number;
    readonly key: string;
  }[] = [
    {
      ctx: harness.poolCreatorCtx("w036-ac04-commit-a"),
      buyerOrganizationId: harness.buyerOrgAId,
      quantity: 12,
      key: `${poolKey}-commit-a`,
    },
    {
      ctx: harness.buyerBCtx("w036-ac04-commit-b"),
      buyerOrganizationId: harness.buyerOrgBId,
      quantity: 40,
      key: `${poolKey}-commit-b`,
    },
    {
      ctx: harness.buyerCCtx("w036-ac04-commit-c"),
      buyerOrganizationId: harness.buyerOrgCId,
      quantity: 75,
      key: `${poolKey}-commit-c`,
    },
  ];
  const commitments: ProcurementCommitment[] = [];
  for (const seed of commitmentSeeds) {
    commitments.push(
      (
        await harness.runtime.procurementService.createProcurementCommitment(
          seed.ctx,
          {
            organizationScopeId: scope,
            poolId: pool.id,
            buyerOrganizationId: seed.buyerOrganizationId,
            attributes: {
              region: "NA_EAST",
              quantity: seed.quantity,
              budgetBand: "band_b_1k_9k",
              unitPriceBand: "price_b_10_49",
              timingWindow: "window_short_1_3mo",
            },
            consent: { scope: "aggregate_disclosure" },
            idempotencyKey: seed.key,
          },
        )
      ).commitment,
    );
  }
  return { pool, commitments };
}

/**
 * The canonical W036 fulfillment subject: qualified pool → supplier-A
 * offer → recorded competitive selection → opportunity
 * (procurement-fulfillment, brief bound to the pool + selection) →
 * contribution (procurement-fulfillment, submission bound to the pool
 * + selection) contributed by the SELECTED supplier. Mirrors the
 * harness's runW036Scenario stage-7 construction exactly.
 */
async function seedFulfillmentSubject(
  poolKey: string,
  offerKey: string,
  selectionKey: string,
  opportunityCorrelationId: string,
  contributionCorrelationId: string,
): Promise<{
  readonly pool: ProcurementPool;
  readonly commitments: readonly ProcurementCommitment[];
  readonly offer: SupplierOffer;
  readonly selection: CompetitiveSelection;
  readonly opportunityId: string;
  readonly contribution: Contribution;
}> {
  const runtime = harness.runtime;
  const scope = harness.organizationScopeId;
  const { pool, commitments } = await seedQualifiedPoolWithCommitments(
    "W036 AC-04 Fulfillment Pool",
    poolKey,
  );
  const offer = (
    await runtime.supplierOfferService.createSupplierOffer(
      harness.supplierACtx("w036-ac04-offer"),
      {
        organizationScopeId: scope,
        poolId: pool.id,
        attributes: {
          region: "NA_EAST",
          unitPriceBand: "price_a_under_10",
          timingWindow: "window_short_1_3mo",
          quantityBucket: "q_100_999",
        },
        validUntil: null,
        consent: { scope: "competitive_selection" },
        idempotencyKey: offerKey,
      },
    )
  ).offer;
  const selection = (
    await runtime.supplierOfferService.recordCompetitiveSelection(
      harness.poolCreatorCtx("w036-ac04-selection"),
      {
        organizationScopeId: scope,
        poolId: pool.id,
        idempotencyKey: selectionKey,
      },
    )
  ).selection;
  const opportunity = await runtime.opportunityService.createOpportunity(
    harness.poolCreatorCtx(opportunityCorrelationId),
    {
      organizationScopeId: scope,
      ownerId: harness.poolCreatorPersonId,
      opportunityType: "procurement-fulfillment",
      title: "W036 AC-04 Fulfillment Opportunity",
      brief: {
        kind: "procurement_fulfillment",
        poolId: pool.id,
        selectionId: selection.id,
      },
    },
  );
  const contribution = await runtime.contributionService.createContribution(
    harness.supplierACtx(contributionCorrelationId),
    {
      opportunityId: opportunity.id,
      contributorId: harness.supplierAPersonId,
      organizationScopeId: scope,
      contributionType: "procurement-fulfillment",
      submission: {
        kind: "fulfillment_execution",
        poolId: pool.id,
        selectionId: selection.id,
      },
    },
  );
  return {
    pool,
    commitments,
    offer,
    selection,
    opportunityId: opportunity.id,
    contribution,
  };
}

/**
 * ONE sanctioned `/workflows` transition for a fulfillment
 * contribution, driven EXPLICITLY through the workflow authority
 * (the only lifecycle mutator): fresh version read through the
 * owning boundary, `policyActionFor("contribution", from, to)`
 * policy action, the SUPPLIER A fulfillment actor.
 */
async function sanctionedTransition(
  contributionId: string,
  from: LifecycleState,
  to: LifecycleState,
  idempotencyKey: string,
): Promise<void> {
  const ctx = harness.supplierACtx("w036-ac04-transition");
  const current = await harness.runtime.contributionService.getContribution(
    ctx,
    contributionId,
  );
  await harness.runtime.workflowService.requestTransition(
    {
      subjectId: contributionId,
      subjectKind: "contribution",
      targetState: to,
      expectedVersion: current.version,
      idempotencyKey,
      actorPersonId: harness.supplierAPersonId,
      policyAction: policyActionFor("contribution", from, to),
      metadata: { demandProcurementLifecycle: "net-w036-ac04" },
    },
    ctx,
  );
}

/** The canonical ladder up to the measurement point. */
const LADDER: readonly (readonly [LifecycleState, LifecycleState])[] = [
  ["DRAFT", "READY"],
  ["READY", "ASSIGNED"],
  ["ASSIGNED", "IN_PROGRESS"],
  ["IN_PROGRESS", "SUBMITTED"],
  ["SUBMITTED", "MEASURING"],
];

describe("NET-W036-AC-04 fulfillment lifecycle (the existing /workflows authority)", () => {
  // The canonical AC-04 subject, shared by the sanctioned-path test
  // (which walks it to terminal VERIFIED) and the terminal-state
  // negative (which proves that terminal state refuses everything).
  let canonical: Awaited<ReturnType<typeof seedFulfillmentSubject>>;

  test("SANCTIONED PATH: the fulfillment contribution transitions ONLY through /workflows — the exact ladder, strictly incrementing versions, one audited event per edge, state read through the owning boundary", async () => {
    const runtime = harness.runtime;
    canonical = await seedFulfillmentSubject(
      "w036-ac04-pool-canonical",
      "w036-ac04-offer-canonical",
      "w036-ac04-selection-canonical",
      "w036-ac04-opportunity",
      "w036-ac04-contribution",
    );
    const contributionId = canonical.contribution.id;

    // The subject enters as a DRAFT v0 CONTRIBUTION (the canonical
    // construction — no lifecycle input exists on the creation
    // commands; the state is server-initialized).
    const created = await runtime.contributionService.getContribution(
      harness.supplierACtx("w036-ac04-read-created"),
      contributionId,
    );
    expect(created.state).toBe("DRAFT");
    expect(created.version).toBe(0);
    expect(created.contributorId).toBe(harness.supplierAPersonId);

    // The ladder DRAFT → READY → ASSIGNED → IN_PROGRESS → SUBMITTED
    // → MEASURING: EVERY edge driven explicitly through
    // runtime.workflowService.requestTransition with the
    // policyActionFor("contribution", from, to) action; the version
    // STRICTLY increments on every transition; the state + version
    // are read back through the OWNING boundary (getContribution).
    let expectedVersion = 0;
    for (const [index, [from, to]] of LADDER.entries()) {
      const result = await runtime.workflowService.requestTransition(
        {
          subjectId: contributionId,
          subjectKind: "contribution",
          targetState: to,
          expectedVersion,
          idempotencyKey: `w036-ac04-t${String(index + 1)}`,
          actorPersonId: harness.supplierAPersonId,
          policyAction: policyActionFor("contribution", from, to),
          metadata: { demandProcurementLifecycle: "net-w036-ac04" },
        },
        harness.supplierACtx("w036-ac04-transition"),
      );
      expect(result.executed).toBe(true);
      expect(result.subject.state).toBe(to);
      expect(result.subject.version).toBe(expectedVersion + 1);
      const after = await runtime.contributionService.getContribution(
        harness.supplierACtx("w036-ac04-read-after"),
        contributionId,
      );
      expect(after.state).toBe(to);
      expect(after.version).toBe(expectedVersion + 1);
      expectedVersion += 1;
    }
    // The measurement point reached at v5 (five sanctioned edges).
    expect(expectedVersion).toBe(5);

    // The sanctioned tail (MEASURING → … → VERIFIED) through the same
    // /workflows authority (the harness's walk helper).
    const verified = await walkToVerified(harness, contributionId);
    expect(verified.state).toBe("VERIFIED");
    expect(verified.version).toBe(10);

    // The authoritative audit trail: EXACTLY the 10 legal transition
    // events, in ladder order, each exactly once, each carrying the
    // authoritative subject id + the acting supplier-A actor + the
    // authoritative transaction id.
    const events = await runtime.auditWriter.query({
      resourceType: "contribution",
      resourceId: contributionId,
    });
    const transitions = events.filter((event) =>
      event.eventType.startsWith("contribution.transition."),
    );
    expect(transitions.map((event) => event.eventType)).toEqual([
      "contribution.transition.draft_to_ready",
      "contribution.transition.ready_to_assigned",
      "contribution.transition.assigned_to_in_progress",
      "contribution.transition.in_progress_to_submitted",
      "contribution.transition.submitted_to_measuring",
      "contribution.transition.measuring_to_evaluating",
      "contribution.transition.evaluating_to_challenge_window",
      "contribution.transition.challenge_window_to_settling",
      "contribution.transition.settling_to_settled",
      "contribution.transition.settled_to_verified",
    ]);
    for (const event of transitions) {
      expect(event.actor).toBe(harness.supplierAPersonId);
      expect(event.subject).toBe(contributionId);
      expect(typeof event.metadata?.transactionId).toBe("string");
      expect(event.metadata?.organizationScopeId).toBe(
        harness.organizationScopeId,
      );
    }
    // The version ladder corroborated by the audit metadata itself
    // (fromVersion → toVersion strictly increments per event).
    const versionPairs = transitions.map((event) => [
      event.metadata?.fromVersion,
      event.metadata?.toVersion,
    ]);
    expect(versionPairs).toEqual([
      [0, 1],
      [1, 2],
      [2, 3],
      [3, 4],
      [4, 5],
      [5, 6],
      [6, 7],
      [7, 8],
      [8, 9],
      [9, 10],
    ]);
  }, 120_000);

  test("a STALE expectedVersion fails closed with CONCURRENT_TRANSITION (optimistic concurrency — no mutation, no audit)", async () => {
    const runtime = harness.runtime;
    // A fresh fulfillment subject walked to the measurement point.
    const subject = await seedFulfillmentSubject(
      "w036-ac04-pool-stale",
      "w036-ac04-offer-stale",
      "w036-ac04-selection-stale",
      "w036-ac04-opportunity-stale",
      "w036-ac04-contribution-stale",
    );
    for (const [index, [from, to]] of LADDER.entries()) {
      await sanctionedTransition(
        subject.contribution.id,
        from,
        to,
        `w036-ac04-stale-t${String(index + 1)}`,
      );
    }
    const at = await runtime.contributionService.getContribution(
      harness.supplierACtx("w036-ac04-stale-read"),
      subject.contribution.id,
    );
    expect(at.state).toBe("MEASURING");
    expect(at.version).toBe(5);
    const eventsBefore = (await runtime.auditWriter.query({
      resourceType: "contribution",
      resourceId: subject.contribution.id,
    })).length;

    // A stale writer (expectedVersion 0 while the authoritative
    // version is 5) on an otherwise LEGAL edge: CONCURRENT_TRANSITION.
    await expect(
      runtime.workflowService.requestTransition(
        {
          subjectId: subject.contribution.id,
          subjectKind: "contribution",
          targetState: "EVALUATING",
          expectedVersion: 0,
          idempotencyKey: "w036-ac04-stale-attempt",
          actorPersonId: harness.supplierAPersonId,
          policyAction: policyActionFor("contribution", "MEASURING", "EVALUATING"),
        },
        harness.supplierACtx("w036-ac04-stale-attempt"),
      ),
    ).rejects.toMatchObject({ code: "CONCURRENT_TRANSITION" });

    // Fail closed: the state, the version AND the audit log are
    // unchanged (nothing was mutated by the refused writer).
    const after = await runtime.contributionService.getContribution(
      harness.supplierACtx("w036-ac04-stale-after"),
      subject.contribution.id,
    );
    expect(after.state).toBe("MEASURING");
    expect(after.version).toBe(5);
    const eventsAfter = (await runtime.auditWriter.query({
      resourceType: "contribution",
      resourceId: subject.contribution.id,
    })).length;
    expect(eventsAfter).toBe(eventsBefore);
  }, 120_000);

  test("ILLEGAL edges (state skips: IN_PROGRESS → SETTLING and DRAFT → MEASURING) fail closed with ILLEGAL_TRANSITION", async () => {
    const runtime = harness.runtime;

    // (a) A subject at IN_PROGRESS attempting to skip four states
    //     straight to SETTLING: not in the transition table.
    const subjectA = await seedFulfillmentSubject(
      "w036-ac04-pool-illegal-a",
      "w036-ac04-offer-illegal-a",
      "w036-ac04-selection-illegal-a",
      "w036-ac04-opportunity-illegal-a",
      "w036-ac04-contribution-illegal-a",
    );
    for (const [index, [from, to]] of LADDER.slice(0, 3).entries()) {
      await sanctionedTransition(
        subjectA.contribution.id,
        from,
        to,
        `w036-ac04-illegal-a-t${String(index + 1)}`,
      );
    }
    const atInProgress = await runtime.contributionService.getContribution(
      harness.supplierACtx("w036-ac04-illegal-a-read"),
      subjectA.contribution.id,
    );
    expect(atInProgress.state).toBe("IN_PROGRESS");
    await expect(
      runtime.workflowService.requestTransition(
        {
          subjectId: subjectA.contribution.id,
          subjectKind: "contribution",
          targetState: "SETTLING",
          expectedVersion: atInProgress.version,
          idempotencyKey: "w036-ac04-illegal-a-attempt",
          actorPersonId: harness.supplierAPersonId,
          // The policy action of the LEGAL next edge (authorized for
          // the actor) — the refusal is attributable to the ILLEGAL
          // TARGET alone (the state machine, not authorization).
          policyAction: policyActionFor(
            "contribution",
            "IN_PROGRESS",
            "SUBMITTED",
          ),
        },
        harness.supplierACtx("w036-ac04-illegal-a-attempt"),
      ),
    ).rejects.toMatchObject({ code: "ILLEGAL_TRANSITION" });
    const afterA = await runtime.contributionService.getContribution(
      harness.supplierACtx("w036-ac04-illegal-a-after"),
      subjectA.contribution.id,
    );
    expect(afterA.state).toBe("IN_PROGRESS");
    expect(afterA.version).toBe(atInProgress.version);
    // No transition event was emitted for the refused edge.
    const eventsA = await runtime.auditWriter.query({
      resourceType: "contribution",
      resourceId: subjectA.contribution.id,
    });
    expect(
      eventsA.filter((event) =>
        event.eventType.startsWith("contribution.transition."),
      ).map((event) => event.eventType),
    ).toEqual([
      "contribution.transition.draft_to_ready",
      "contribution.transition.ready_to_assigned",
      "contribution.transition.assigned_to_in_progress",
    ]);

    // (b) A DRAFT subject attempting to jump straight to the
    //     measurement point: also not in the table.
    const subjectB = await seedFulfillmentSubject(
      "w036-ac04-pool-illegal-b",
      "w036-ac04-offer-illegal-b",
      "w036-ac04-selection-illegal-b",
      "w036-ac04-opportunity-illegal-b",
      "w036-ac04-contribution-illegal-b",
    );
    const atDraft = await runtime.contributionService.getContribution(
      harness.supplierACtx("w036-ac04-illegal-b-read"),
      subjectB.contribution.id,
    );
    expect(atDraft.state).toBe("DRAFT");
    await expect(
      runtime.workflowService.requestTransition(
        {
          subjectId: subjectB.contribution.id,
          subjectKind: "contribution",
          targetState: "MEASURING",
          expectedVersion: atDraft.version,
          idempotencyKey: "w036-ac04-illegal-b-attempt",
          actorPersonId: harness.supplierAPersonId,
          // The policy action of the LEGAL first edge (authorized for
          // the actor) — the refusal is attributable to the ILLEGAL
          // TARGET alone.
          policyAction: policyActionFor("contribution", "DRAFT", "READY"),
        },
        harness.supplierACtx("w036-ac04-illegal-b-attempt"),
      ),
    ).rejects.toMatchObject({ code: "ILLEGAL_TRANSITION" });
    const afterB = await runtime.contributionService.getContribution(
      harness.supplierACtx("w036-ac04-illegal-b-after"),
      subjectB.contribution.id,
    );
    expect(afterB.state).toBe("DRAFT");
    expect(afterB.version).toBe(0);
    const eventsB = await runtime.auditWriter.query({
      resourceType: "contribution",
      resourceId: subjectB.contribution.id,
    });
    expect(
      eventsB.filter((event) =>
        event.eventType.startsWith("contribution.transition."),
      ),
    ).toEqual([]);
  }, 120_000);

  test("an UNKNOWN subject id fails closed with LIFECYCLE_SUBJECT_NOT_FOUND; a TERMINAL-state subject refuses every further transition", async () => {
    const runtime = harness.runtime;

    // (a) Unknown subject id (no existence oracle beyond the error).
    await expect(
      runtime.workflowService.requestTransition(
        {
          subjectId: "w036-ac04-nonexistent-contribution",
          subjectKind: "contribution",
          targetState: "READY",
          expectedVersion: 0,
          idempotencyKey: "w036-ac04-unknown-attempt",
          actorPersonId: harness.supplierAPersonId,
          policyAction: policyActionFor("contribution", "DRAFT", "READY"),
        },
        harness.supplierACtx("w036-ac04-unknown-attempt"),
      ),
    ).rejects.toMatchObject({ code: "LIFECYCLE_SUBJECT_NOT_FOUND" });

    // (b) The canonical subject is TERMINAL (VERIFIED at v10 after the
    //     sanctioned walk in the first test): every further transition
    //     is refused with TERMINAL_STATE — a local procurement state
    //     machine could not "re-open" it either.
    const terminal = await runtime.contributionService.getContribution(
      harness.supplierACtx("w036-ac04-terminal-read"),
      canonical.contribution.id,
    );
    expect(terminal.state).toBe("VERIFIED");
    expect(terminal.version).toBe(10);
    await expect(
      runtime.workflowService.requestTransition(
        {
          subjectId: canonical.contribution.id,
          subjectKind: "contribution",
          targetState: "SETTLED",
          expectedVersion: terminal.version,
          idempotencyKey: "w036-ac04-terminal-attempt",
          actorPersonId: harness.supplierAPersonId,
          // A LEGAL-table policy action the harness seeded for the
          // actor — the refusal is attributable to the TERMINAL state
          // alone (not authorization, not the table).
          policyAction: policyActionFor("contribution", "SETTLED", "VERIFIED"),
        },
        harness.supplierACtx("w036-ac04-terminal-attempt"),
      ),
    ).rejects.toMatchObject({ code: "TERMINAL_STATE" });
    const after = await runtime.contributionService.getContribution(
      harness.supplierACtx("w036-ac04-terminal-after"),
      canonical.contribution.id,
    );
    expect(after.state).toBe("VERIFIED");
    expect(after.version).toBe(10);
  }, 120_000);

  test("NO SECOND PROCUREMENT STATE MACHINE: the durable demand-side records carry NO lifecycle state/version/transition fields (exact record key sets); the workflow subject kinds are exactly the frozen vocabulary", async () => {
    const runtime = harness.runtime;
    const scope = harness.organizationScopeId;
    const ctx = harness.poolCreatorCtx("w036-ac04-records");

    // The canonical subject's durable demand-side records, read
    // through the OWNING services. Each record's key set is EXACTLY
    // the sanctioned domain fields — NO lifecycle state, NO version,
    // NO transition/status machinery exists on ANY /demand record.
    const pool = await runtime.procurementService.getProcurementPool(
      ctx,
      scope,
      canonical.pool.id,
    );
    expect(Object.keys(pool).sort()).toEqual([
      "categoryKey",
      "categoryVersion",
      "causationId",
      "closedAt",
      "closureReason",
      "correlationId",
      "createdAt",
      "createdBy",
      "executionId",
      "id",
      "idempotencyKey",
      "name",
      "organizationScopeId",
      "policy",
      "recordFormat",
      "updatedAt",
    ]);
    const commitments = await runtime.procurementService
      .listProcurementCommitments(ctx, scope, {
        poolId: canonical.pool.id,
      });
    expect(commitments).toHaveLength(3);
    expect(Object.keys(commitments[0]!).sort()).toEqual([
      "attributes",
      "buyerOrganizationId",
      "categoryKey",
      "categoryVersion",
      "causationId",
      "consent",
      "correlationId",
      "createdAt",
      "executionId",
      "id",
      "idempotencyKey",
      "organizationScopeId",
      "poolId",
      "recordFormat",
      "submittedBy",
      "updatedAt",
      "withdrawalReason",
      "withdrawnAt",
    ]);
    const offer = await runtime.supplierOfferService.getSupplierOffer(
      ctx,
      scope,
      canonical.offer.id,
    );
    expect(Object.keys(offer).sort()).toEqual([
      "attributes",
      "categoryKey",
      "categoryVersion",
      "causationId",
      "consent",
      "correlationId",
      "createdAt",
      "executionId",
      "id",
      "idempotencyKey",
      "organizationScopeId",
      "poolId",
      "recordFormat",
      "supplierPersonId",
      "updatedAt",
      "validFrom",
      "validUntil",
      "withdrawalReason",
      "withdrawnAt",
    ]);
    const selections = await runtime.supplierOfferService.listPoolSelections(
      ctx,
      { organizationScopeId: scope, poolId: canonical.pool.id },
    );
    expect(selections).toHaveLength(1);
    expect(Object.keys(selections[0]!).sort()).toEqual([
      "causationId",
      "checks",
      "consideredOfferIds",
      "correlationId",
      "createdAt",
      "digest",
      "eligibleOfferIds",
      "evaluationAnchor",
      "executionId",
      "id",
      "idempotencyKey",
      "offerEvaluations",
      "organizationScopeId",
      "poolDigest",
      "poolId",
      "qualified",
      "ranking",
      "recordFormat",
      "recordedBy",
      "selectedOfferId",
      "selectionPolicy",
      "updatedAt",
    ]);
    // No record JSON carries lifecycle machinery vocabulary anywhere
    // (not just at the top level — nowhere in the serialized record;
    // the domain's OWN policy.version/recordFormat fields are domain
    // lineage, not lifecycle state, and the exact key-set pins above
    // prove no top-level lifecycle field exists).
    for (const record of [pool, commitments[0]!, offer, selections[0]!]) {
      const json = JSON.stringify(record);
      for (const lifecycleTerm of [
        '"state"',
        '"lifecycle"',
        '"transition"',
        '"status"',
        '"lifecycleStage"',
        '"currentState"',
        '"workflowState"',
      ]) {
        expect(json).not.toContain(lifecycleTerm);
      }
    }

    // A caller CANNOT smuggle lifecycle state onto a demand record:
    // extra properties on the pool creation input are INERT (the
    // input surface is closed) — the record still carries exactly the
    // 16 sanctioned pool keys.
    const smuggled = (
      await runtime.procurementService.createProcurementPool(
        harness.poolCreatorCtx("w036-ac04-smuggle"),
        {
          organizationScopeId: scope,
          name: "W036 AC-04 Smuggled Lifecycle Pool",
          categoryKey: "cloud_infrastructure",
          qualificationPolicy: { minimumCommitments: 2, minimumOrganizations: 2 },
          idempotencyKey: "w036-ac04-pool-smuggled",
          // Caller-side smuggle attempt (ignored — there is NO
          // lifecycle input surface on any /demand command).
          ...({
            state: "VERIFIED",
            version: 99,
            lifecycleStage: "settled",
          } as Record<string, unknown>),
        } as Parameters<typeof runtime.procurementService.createProcurementPool>[1],
      )
    ).pool;
    const smuggledRecord = await runtime.procurementService.getProcurementPool(
      harness.poolCreatorCtx("w036-ac04-smuggle-read"),
      scope,
      smuggled.id,
    );
    expect(Object.keys(smuggledRecord).sort()).toEqual([
      "categoryKey",
      "categoryVersion",
      "causationId",
      "closedAt",
      "closureReason",
      "correlationId",
      "createdAt",
      "createdBy",
      "executionId",
      "id",
      "idempotencyKey",
      "name",
      "organizationScopeId",
      "policy",
      "recordFormat",
      "updatedAt",
    ]);
    expect(JSON.stringify(smuggledRecord)).not.toContain("lifecycleStage");
    expect(smuggledRecord.closedAt).toBeNull();

    // The workflow subject kinds are EXACTLY the frozen vocabulary
    // (extracted from the LifecycleSubjectKind union declaration in
    // src/core/workflow.ts — the source is truth): it contains NO
    // procurement/demand/fulfillment/sourcing kind. A second state
    // machine would need a second subject kind; none exists.
    const workflowCore = await readFile(
      join(REPO, "src/core/workflow.ts"),
      "utf8",
    );
    const unionMatch =
      /export type LifecycleSubjectKind =\s*((?:\s*\|?\s*"[a-z_]+")+)/.exec(
        workflowCore,
      );
    expect(unionMatch).not.toBeNull();
    const kinds = (unionMatch![1]!.match(/"[a-z_]+"/g) ?? []).map((k) =>
      k.replace(/"/g, ""),
    );
    expect([...kinds].sort()).toEqual([
      "contribution",
      "engagement",
      "opportunity",
      "outcome_measurement",
      "proof_of_value",
      "publication",
    ]);
    for (const forbiddenKind of [
      "procurement",
      "demand",
      "fulfillment",
      "sourcing",
      "supplier",
      "pool",
      "offer",
      "selection",
    ]) {
      expect(kinds).not.toContain(forbiddenKind);
    }
    // The workflow service's lifecycle repositories are EXACTLY the
    // six subject-kind repositories (no demand/procurement repository
    // is wired into the lifecycle authority).
    const workflowPort = await readFile(
      join(REPO, "src/workflows/port.ts"),
      "utf8",
    );
    const repositoryFields = [
      ...workflowPort.matchAll(/readonly (\w+Repository): LifecycleRepository/g),
    ].map((m) => m[1]!);
    expect([...repositoryFields].sort()).toEqual([
      "contributionRepository",
      "engagementRepository",
      "opportunityRepository",
      "outcomeMeasurementRepository",
      "proofOfValueRepository",
      "publicationRepository",
    ]);
  }, 120_000);

  test("STRUCTURAL: the W036 suite contains NO repository write call and NO local state-machine/status-transition vocabulary (code-level, comments stripped)", async () => {
    // Strip comments so the pins scan CODE only (the doc comments
    // legitimately NAME the forbidden tokens while explaining why
    // they are absent — the W035 regression discipline). The token
    // literals below are ASSEMBLED from pieces so this file's own
    // assertion code never contains the forbidden token itself
    // (self-covering pin).
    const stripComments = (source: string): string =>
      source
        .replace(/\/\*[\s\S]*?\*\//g, "")
        .replace(/^[ \t]*\/\/.*$/gm, "")
        .replace(/[ \t]\/\/.*$/gm, "");

    const suiteDir = import.meta.dir;
    const files = (await readdir(suiteDir)).filter((name) =>
      name.endsWith(".ts"),
    );
    // The whole W036 suite: the harness + the scenario + AC-01..AC-10
    // (this file included — the pin is self-covering; the inventory
    // was extended in stage 4 when the AC-06/AC-07 suites joined the
    // directory, in stage 5 when the AC-08/AC-09 suites joined, and in
    // stage 6 when the AC-10 suite joined — PURE filename-list
    // extensions, no semantic change to the write-token/determinism
    // pins, which now cover the new files).
    expect(files.sort()).toEqual([
      "_net-w036-harness.ts",
      "net-w036-ac-01-demand-pool-authority.test.ts",
      "net-w036-ac-02-aggregate-disclosure-privacy.test.ts",
      "net-w036-ac-03-supplier-offers-selection.test.ts",
      "net-w036-ac-04-fulfillment-lifecycle.test.ts",
      "net-w036-ac-05-measurement-outcomes.test.ts",
      "net-w036-ac-06-baseline-savings.test.ts",
      "net-w036-ac-07-evidence-pov.test.ts",
      "net-w036-ac-08-settlement-authority.test.ts",
      "net-w036-ac-09-benefit-funding-allocation.test.ts",
      "net-w036-ac-10-replay-concurrency-atomicity.test.ts",
      "net-w036-full-path-scenario.test.ts",
    ]);
    // Repository write calls + local state-machine vocabulary — the
    // assembled literals (never written as one token in this file).
    const writeTokens = [
      "." + "put" + "(",
      "saveWith" + "inTx",
      "deleteWith" + "inTx",
      "statusTrans" + "ition(",
      "statusMac" + "hine(",
    ];
    for (const name of files) {
      const code = stripComments(
        await readFile(join(suiteDir, name), "utf8"),
      );
      for (const token of writeTokens) {
        expect(
          code.split(token).length - 1,
          `${name}: ${token}`,
        ).toBe(0);
      }
    }
    // Determinism self-pins for THIS file (the harness-wide pins are
    // the W035 regression suite's job; these keep this file honest).
    // Assembled literals — never the whole token in code.
    const ownCode = stripComments(
      await readFile(
        join(suiteDir, "net-w036-ac-04-fulfillment-lifecycle.test.ts"),
        "utf8",
      ),
    );
    for (const token of [
      "new " + "Date" + "(",
      "Date." + "now" + "(",
      "random" + "UUID",
    ]) {
      expect(ownCode.split(token).length - 1).toBe(0);
    }
  }, 120_000);
});
