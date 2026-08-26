/**
 * NET-W004-AC-02 — Contribution first-class model.
 *
 * Contributions can be created and retrieved against an Opportunity and
 * contributor, persist durably, and enforce the invariant that a
 * Contribution belongs to exactly one Opportunity and contributor.
 *
 * Evidence: domain + persistence integration tests.
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { createExecutionContext } from "../../src/core/execution-context.ts";
import { NotFoundError } from "../../src/core/errors.ts";
import {
  createNetW004Harness,
  createOpportunity,
  createContribution,
  type NetW004Harness,
} from "../workflows/_net-w004-harness.ts";

let harness: NetW004Harness;

beforeEach(async () => {
  harness = await createNetW004Harness();
});

afterEach(async () => {
  await harness.teardown();
});

describe("NET-W004-AC-02 Contribution first-class model", () => {
  test("createContribution produces a stable id, version 0, DRAFT state, linked to opportunity+contributor", async () => {
    const opp = await createOpportunity(harness);
    const ctx = createExecutionContext({
      correlationId: "ac02-create",
      actor: { id: harness.personId, kind: "person" },
    });
    const c = await harness.runtime.contributionService.createContribution(ctx, {
      opportunityId: opp.id,
      contributorId: harness.personId,
      organizationScopeId: harness.organizationScopeId,
      contributionType: "helpful-content",
      submission: { contentRef: "obj-123" },
      evidenceReferencePlaceholders: ["evd-a", "evd-b"],
    });
    expect(c.id).toBeTruthy();
    expect(c.state).toBe("DRAFT");
    expect(c.version).toBe(0);
    expect(c.opportunityId).toBe(opp.id);
    expect(c.contributorId).toBe(harness.personId);
    expect(c.organizationScopeId).toBe(harness.organizationScopeId);
    expect(c.contributionType).toBe("helpful-content");
    expect(c.submission).toEqual({ contentRef: "obj-123" });
    expect(c.evidenceReferencePlaceholders).toEqual(["evd-a", "evd-b"]);
    expect(c.executionId).toBe(ctx.executionId);
    expect(c.correlationId).toBe(ctx.correlationId);
  });

  test("getContribution retrieves a persisted contribution by id", async () => {
    const opp = await createOpportunity(harness);
    const c = await createContribution(harness, opp.id);
    const ctx = createExecutionContext({
      correlationId: "ac02-get",
      actor: { id: harness.personId, kind: "person" },
    });
    const fetched = await harness.runtime.contributionService.getContribution(ctx, c.id);
    expect(fetched.id).toBe(c.id);
    expect(fetched.opportunityId).toBe(opp.id);
    expect(fetched.contributorId).toBe(harness.personId);
    expect(fetched.state).toBe("DRAFT");
  });

  test("getContribution throws NotFoundError for an unknown id", async () => {
    const ctx = createExecutionContext({
      correlationId: "ac02-notfound",
      actor: { id: harness.personId, kind: "person" },
    });
    await expect(
      harness.runtime.contributionService.getContribution(ctx, "unknown-id"),
    ).rejects.toBeInstanceOf(NotFoundError);
  });

  test("createContribution rejects an unknown opportunity id (AC-02 invariant: must link to exactly one opportunity)", async () => {
    const ctx = createExecutionContext({
      correlationId: "ac02-unknown-opp",
      actor: { id: harness.personId, kind: "person" },
    });
    await expect(
      harness.runtime.contributionService.createContribution(ctx, {
        opportunityId: "unknown-opp-id",
        contributorId: harness.personId,
        organizationScopeId: harness.organizationScopeId,
        contributionType: "helpful-content",
      }),
    ).rejects.toBeInstanceOf(NotFoundError);
  });

  test("createContribution rejects when the contributor's org scope does not match the opportunity's scope (AC-02 invariant + §4.5)", async () => {
    // Create an opportunity in a DIFFERENT org.
    const otherOrg = await harness.runtime.organizationService.createOrganization(
      harness.bootstrapCtx,
      { name: "Other Org", creatorId: harness.personId },
    );
    const ctx = createExecutionContext({
      correlationId: "ac02-scope-mismatch",
      actor: { id: harness.personId, kind: "person" },
    });
    const otherOpp = await harness.runtime.opportunityService.createOpportunity(ctx, {
      organizationScopeId: otherOrg.id,
      ownerId: harness.personId,
      opportunityType: "campaign",
      title: "Other Org Opp",
    });
    // Attempt to create a contribution in the HARNESS org scope
    // (mismatching the opportunity's scope).
    await expect(
      harness.runtime.contributionService.createContribution(ctx, {
        opportunityId: otherOpp.id,
        contributorId: harness.personId,
        organizationScopeId: harness.organizationScopeId, // mismatch
        contributionType: "helpful-content",
      }),
    ).rejects.toThrow(/scope/);
  });

  test("createContribution validates required fields", async () => {
    const opp = await createOpportunity(harness);
    const ctx = createExecutionContext({
      correlationId: "ac02-validation",
      actor: { id: harness.personId, kind: "person" },
    });
    await expect(
      harness.runtime.contributionService.createContribution(ctx, {
        opportunityId: "",
        contributorId: harness.personId,
        organizationScopeId: harness.organizationScopeId,
        contributionType: "helpful-content",
      }),
    ).rejects.toThrow(/opportunityId/);
    await expect(
      harness.runtime.contributionService.createContribution(ctx, {
        opportunityId: opp.id,
        contributorId: "",
        organizationScopeId: harness.organizationScopeId,
        contributionType: "helpful-content",
      }),
    ).rejects.toThrow(/contributorId/);
    await expect(
      harness.runtime.contributionService.createContribution(ctx, {
        opportunityId: opp.id,
        contributorId: harness.personId,
        organizationScopeId: "",
        contributionType: "helpful-content",
      }),
    ).rejects.toThrow(/organizationScopeId/);
    await expect(
      harness.runtime.contributionService.createContribution(ctx, {
        opportunityId: opp.id,
        contributorId: harness.personId,
        organizationScopeId: harness.organizationScopeId,
        contributionType: "",
      }),
    ).rejects.toThrow(/contributionType/);
  });

  test("a contribution carries execution/correlation lineage for traceability", async () => {
    const opp = await createOpportunity(harness);
    const ctx = createExecutionContext({
      correlationId: "ac02-lineage",
      causationId: "parent-execution-id",
      actor: { id: harness.personId, kind: "person" },
    });
    const c = await harness.runtime.contributionService.createContribution(ctx, {
      opportunityId: opp.id,
      contributorId: harness.personId,
      organizationScopeId: harness.organizationScopeId,
      contributionType: "helpful-content",
    });
    expect(c.executionId).toBe(ctx.executionId);
    expect(c.correlationId).toBe(ctx.correlationId);
    expect(c.causationId).toBe(ctx.causationId);
  });
});
