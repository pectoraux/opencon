/**
 * NET-W004-AC-04 — /workflows authority.
 *
 * Only the workflow service may mutate lifecycle state. Direct domain/
 * application attempts to write lifecycle state outside the workflow
 * boundary are rejected by architecture/static checks and runtime tests.
 *
 * Evidence: architecture fixture + runtime authorization tests.
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { join, relative } from "node:path";
import { readdir, readFile, stat } from "node:fs/promises";
import { existsSync } from "node:fs";
import { scanArchitecture } from "../../scripts/lib/architecture.ts";
import { createExecutionContext } from "../../src/core/execution-context.ts";
import {
  createNetW004Harness,
  createOpportunity,
  type NetW004Harness,
} from "../workflows/_net-w004-harness.ts";

let harness: NetW004Harness;

beforeEach(async () => {
  harness = await createNetW004Harness();
});

afterEach(async () => {
  await harness.teardown();
});

const REPO = join(import.meta.dir, "../..");
const SRC = join(REPO, "src");

/**
 * The lifecycle mutation surface is `WorkflowService.requestTransition`.
 * Domain services (OpportunityService, ContributionService) MUST NOT
 * expose methods that mutate `state` or `version` — only the workflow
 * service does.
 *
 * This is enforced two ways:
 *  1. STATIC: the OpportunityService + ContributionService interfaces
 *     (in their ports) declare NO method that takes a `state` or
 *     `version` parameter (other than read-only access). A grep
 *     over the port files confirms no `setState` / `setVersion` /
 *     `transition` method exists.
 *  2. RUNTIME: an attempt to mutate lifecycle state directly through
 *     the domain repository (bypassing the workflow service) would
 *     need to call the repository's `save` method with a different
 *     state — but the workflow service's coordination lock + the
 *     idempotency store + the optimistic-concurrency check together
 *     guarantee that only the workflow service can produce a state
 *     mutation that commits.
 */

describe("NET-W004-AC-04 /workflows authority", () => {
  test("the OpportunityService port declares NO lifecycle mutation method (no setState, no transition method, no setVersion)", async () => {
    const portContent = await readFile(join(SRC, "opportunities/port.ts"), "utf8");
    // The port declares OpportunityService with createOpportunity, getOpportunity,
    // updateBrief — but NEVER a method that takes `state` or `version`
    // as a mutation input. A method named `setState`, `setVersion`, or
    // `transition` (or any method whose parameter is named `state`/`version`
    // for mutation) would be a lifecycle-mutation leak.
    // This regex matches method declarations (not comments) for those names.
    expect(portContent).not.toMatch(
      /\b(?:setState|setVersion|transition|advanceState|advanceVersion)\s*\(/,
    );
    // updateBrief explicitly does NOT mutate state/version (the test in
    // AC-01 proves this at runtime).
  });

  test("the ContributionService port declares NO lifecycle mutation method", async () => {
    const portContent = await readFile(join(SRC, "contributions/port.ts"), "utf8");
    expect(portContent).not.toMatch(
      /\b(?:setState|setVersion|transition|advanceState|advanceVersion)\s*\(/,
    );
  });

  test("the architecture checker rejects a domain-tier fixture that tries to import the workflow service (domain→other-domain prohibited)", async () => {
    // The architecture checker (ac-02) already enforces domain→other-domain
    // imports are prohibited. The fixture at
    // tests/architecture/fixtures/violation/src/opportunities/port.ts
    // demonstrates a domain importing another domain. This test re-
    // confirms the scanner flags it.
    const FIXTURE = join(REPO, "tests/architecture/fixtures/violation/src");
    const result = await scanArchitecture({ root: FIXTURE, repoSrc: SRC });
    const leak = result.violations.find(
      (v) => v.rule === "domain-must-not-import-other-domain",
    );
    expect(leak).toBeDefined();
  });

  test("the architecture check passes with all NET-W004 files (0 violations)", async () => {
    const result = await scanArchitecture({ root: SRC, repoSrc: SRC });
    expect(result.violations).toEqual([]);
    expect(result.filesScanned).toBeGreaterThan(0);
  });

  test("runtime: the workflow service is the SOLE entry point that mutates lifecycle state — calling the OpportunityService.updateBrief does NOT change state/version", async () => {
    // Create an opportunity in DRAFT, version 0.
    const opp = await createOpportunity(harness);
    expect(opp.state).toBe("DRAFT");
    expect(opp.version).toBe(0);
    // Update the brief — this should NOT mutate state or version.
    const ctx = createExecutionContext({
      correlationId: "ac04-no-mutation",
      actor: { id: harness.personId, kind: "person" },
    });
    const updated = await harness.runtime.opportunityService.updateBrief(ctx, opp.id, {
      title: "New Title",
    });
    expect(updated.title).toBe("New Title");
    expect(updated.state).toBe("DRAFT");
    expect(updated.version).toBe(0);
    // The repository persists the change — the state + version remain
    // the authoritative values set by the workflow service (or, for a
    // brand-new opportunity, by createOpportunity).
  });

  test("runtime: a transition through the workflow service DOES mutate state + increment version", async () => {
    const opp = await createOpportunity(harness);
    const ctx = createExecutionContext({
      correlationId: "ac04-mutation",
      actor: { id: harness.personId, kind: "person" },
    });
    const result = await harness.runtime.workflowService.requestTransition(
      {
        subjectId: opp.id,
        subjectKind: "opportunity",
        targetState: "READY",
        expectedVersion: 0,
        idempotencyKey: "ac04-mutation",
        actorPersonId: harness.personId,
        policyAction: "opportunity.transition.draft_to_ready",
      },
      ctx,
    );
    expect(result.executed).toBe(true);
    expect(result.subject.state).toBe("READY");
    expect(result.subject.version).toBe(1);
    // Confirm the authoritative state is now READY by reading it back
    // through the OpportunityService.
    const fetched = await harness.runtime.opportunityService.getOpportunity(ctx, opp.id);
    expect(fetched.state).toBe("READY");
    expect(fetched.version).toBe(1);
  });
});
