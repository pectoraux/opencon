/**
 * NET-W033-AC-02 — Lifecycle authority (issue #67 §4 AC-02).
 *
 * All observed legal contribution transitions use /workflows (the
 * sole lifecycle authority); illegal/bypass transition attempts fail
 * closed; no local W033 lifecycle state machine exists:
 *  - the 10 legal transitions of the canonical path each emit the
 *    authoritative transactional audit event (ordered, tx-bound);
 *  - an illegal transition (skipping states) fails closed with
 *    ILLEGAL_TRANSITION;
 *  - a stale expectedVersion fails closed with CONCURRENT_TRANSITION;
 *  - a transition by a NON-authorized actor (deny-by-default
 *    authorization) fails closed with AUTHORIZATION;
 *  - the terminal VERIFIED state refuses every further transition;
 *  - the W033 surface adds NO second state machine (structural pin).
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
import { policyActionFor } from "../../src/core/workflow.ts";

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

describe("NET-W033-AC-02 lifecycle authority (all transitions through /workflows)", () => {
  test("every legal transition of the canonical path is recorded + audited through /workflows (ordered, tx-bound)", async () => {
    const ctx = harness.contributorCtx("w033-ac02-verify");
    const contribution = await harness.runtime.contributionService.getContribution(
      ctx,
      scenario.contribution.id,
    );
    // The terminal state + the version count: 10 legal transitions
    // from DRAFT v0 → VERIFIED v10.
    expect(contribution.state).toBe("VERIFIED");
    expect(contribution.version).toBe(10);

    // The authoritative audit trail: exactly the 10 legal transitions
    // in order, each carrying the authoritative transaction id.
    const events = await harness.runtime.auditWriter.query({
      resourceType: "contribution",
      resourceId: contribution.id,
    });
    const transitions = events.filter((e) =>
      e.eventType.startsWith("contribution.transition."),
    );
    expect(transitions.map((e) => e.eventType)).toEqual([
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
      expect(typeof event.metadata?.transactionId).toBe("string");
    }
  });

  test("an ILLEGAL transition (state skip: SUBMITTED → VERIFIED) fails closed", async () => {
    // A fresh contribution in DRAFT, walked to SUBMITTED only.
    const { createHelpfulContribution } = await import(
      "../contributions/_net-w012-harness.ts"
    );
    const { publishHelpfulContribution } = await import(
      "../contributions/_net-w012-harness.ts"
    );
    const { contribution } = await createHelpfulContribution(
      harness.w014.w012,
      { idempotencyKey: key("w033-ac02-illegal") },
    );
    await publishHelpfulContribution(harness.w014.w012, contribution.id);
    const current = await harness.runtime.contributionService.getContribution(
      harness.contributorCtx("w033-ac02-illegal"),
      contribution.id,
    );
    expect(current.state).toBe("SUBMITTED");
    // SUBMITTED → VERIFIED skips five legal states: ILLEGAL.
    await expect(
      harness.runtime.workflowService.requestTransition(
        {
          subjectId: contribution.id,
          subjectKind: "contribution",
          targetState: "VERIFIED",
          expectedVersion: current.version,
          idempotencyKey: key("w033-ac02-skip"),
          actorPersonId: harness.contributorPersonId,
          policyAction: policyActionFor(
            "contribution",
            "SUBMITTED",
            "MEASURING",
          ),
        },
        harness.contributorCtx("w033-ac02-skip"),
      ),
    ).rejects.toMatchObject({ code: "ILLEGAL_TRANSITION" });
    // The state is unchanged.
    const after = await harness.runtime.contributionService.getContribution(
      harness.contributorCtx("w033-ac02-after"),
      contribution.id,
    );
    expect(after.state).toBe("SUBMITTED");
    expect(after.version).toBe(current.version);
  });

  test("a STALE expectedVersion fails closed with CONCURRENT_TRANSITION (optimistic concurrency)", async () => {
    const ctx = harness.contributorCtx("w033-ac02-stale");
    await expect(
      harness.runtime.workflowService.requestTransition(
        {
          subjectId: scenario.contribution.id,
          subjectKind: "contribution",
          targetState: "REJECTED",
          expectedVersion: 0, // authoritative version is 10 — stale.
          idempotencyKey: key("w033-ac02-stale"),
          actorPersonId: harness.contributorPersonId,
          policyAction: policyActionFor("contribution", "VERIFIED", "REJECTED"),
        },
        ctx,
      ),
    ).rejects.toMatchObject({ code: "CONCURRENT_TRANSITION" });
  });

  test("a NON-authorized actor is denied (deny-by-default /workflows authorization)", async () => {
    // The moderator has no per-person transition policies for the
    // maturation transitions — the request is denied before any
    // mutation (the contributor's policies seeded by W008 do NOT
    // transfer).
    const { createHelpfulContribution, publishHelpfulContribution } = await import(
      "../contributions/_net-w012-harness.ts"
    );
    const { contribution } = await createHelpfulContribution(
      harness.w014.w012,
      { idempotencyKey: key("w033-ac02-unauth") },
    );
    await publishHelpfulContribution(harness.w014.w012, contribution.id);
    const current = await harness.runtime.contributionService.getContribution(
      harness.contributorCtx("w033-ac02-unauth"),
      contribution.id,
    );
    await expect(
      harness.runtime.workflowService.requestTransition(
        {
          subjectId: contribution.id,
          subjectKind: "contribution",
          targetState: "MEASURING",
          expectedVersion: current.version,
          idempotencyKey: key("w033-ac02-unauth-t"),
          actorPersonId: harness.moderatorPersonId,
          policyAction: policyActionFor("contribution", "SUBMITTED", "MEASURING"),
        },
        harness.moderatorCtx("w033-ac02-unauth"),
      ),
    ).rejects.toMatchObject({ code: "AUTHORIZATION" });
    // No mutation happened.
    const after = await harness.runtime.contributionService.getContribution(
      harness.contributorCtx("w033-ac02-unauth-after"),
      contribution.id,
    );
    expect(after.version).toBe(current.version);
    expect(after.state).toBe("SUBMITTED");
  });

  test("the TERMINAL VERIFIED state refuses every further transition", async () => {
    const ctx = harness.contributorCtx("w033-ac02-terminal");
    const contribution = scenario.contribution;
    await expect(
      harness.runtime.workflowService.requestTransition(
        {
          subjectId: contribution.id,
          subjectKind: "contribution",
          targetState: "SETTLED",
          expectedVersion: contribution.version,
          idempotencyKey: key("w033-ac02-terminal"),
          actorPersonId: harness.contributorPersonId,
          policyAction: policyActionFor("contribution", "SETTLED", "VERIFIED"),
        },
        ctx,
      ),
    ).rejects.toMatchObject({ code: "TERMINAL_STATE" });
  });

  test("STRUCTURAL: the W033 surface adds NO second lifecycle state machine (pure composition over /workflows)", async () => {
    // W033 introduces NO source file at all (pure composition tests):
    // the entire W033 artifact set lives under tests/ + docs/. The
    // harness composes ONLY the existing /workflows API
    // (requestTransition + policyActionFor — the frozen vocabulary
    // re-imported, never re-declared). (AC-10 owns the directory-wide
    // no-second-state-machine pattern bans.)
    const w033Dir = await readFile(
      join(REPO, "tests/contribution-lifecycle/_net-w033-harness.ts"),
      "utf8",
    );
    expect(w033Dir).toContain("workflowService.requestTransition");
    expect(w033Dir).toContain('from "../../src/core/workflow.ts"');
    // The frozen transition table lives in ONE place (workflows).
    const transitionTables = await readFile(
      join(REPO, "src/workflows/transition-table.ts"),
      "utf8",
    );
    expect(transitionTables).toContain("CONTRIBUTION_TRANSITION_TABLE");
    expect(transitionTables).toContain("PROOF_OF_VALUE_TRANSITION_TABLE");
    expect(transitionTables).toContain("OUTCOME_MEASUREMENT_TRANSITION_TABLE");
  });
});
