/**
 * NET-W033-AC-01 — Opportunity/contribution eligibility and sanctioned
 * submission (issue #67 §4 AC-01).
 *
 * An eligible participant submits a contribution to an eligible
 * opportunity through the sanctioned API/domain boundary (the
 * helpfulness composite — the same path the apiCommand takes);
 * unauthorized/ineligible attempts fail closed:
 *  - the NET-W011 eligibility policy is enforced fail-closed at
 *    contribution creation (claimant attributes vs the opportunity's
 *    ACTIVE campaign rule);
 *  - a cross-tenant submission (opportunity of another organization
 *    scope) fails closed;
 *  - a non-HELPFUL opportunity type is refused;
 *  - W033 never writes contribution repositories directly (the
 *    contribution service port exposes creation + reads only).
 */

import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import {
  createNetW033Harness,
  key,
  type NetW033Harness,
} from "./_net-w033-harness.ts";
import {
  createHelpfulnessPolicy,
  createHelpfulContribution,
} from "../contributions/_net-w012-harness.ts";

const REPO = join(import.meta.dir, "../..");

let harness: NetW033Harness;

beforeAll(async () => {
  harness = await createNetW033Harness();
});

afterAll(async () => {
  await harness.teardown();
});

describe("NET-W033-AC-01 opportunity/contribution eligibility + sanctioned submission", () => {
  test("an eligible participant submits through the sanctioned boundary (contribution created, DRAFT v0, org-scoped)", async () => {
    const ctx = harness.contributorCtx("w033-ac01-sanctioned");
    const { contribution, proofOfHelpfulness } = await createHelpfulContribution(
      harness.w014.w012,
      { idempotencyKey: key("w033-ac01-create") },
    );
    // The contribution exists through the CONTRIBUTION authority's
    // own read (created by the composite, never by this test writing
    // a repository).
    const read = await harness.runtime.contributionService.getContribution(
      ctx,
      contribution.id,
    );
    expect(read.state).toBe("DRAFT");
    expect(read.version).toBe(0);
    expect(read.organizationScopeId).toBe(harness.organizationScopeId);
    expect(read.contributorId).toBe(harness.contributorPersonId);
    // The PoH carries the eligibility evaluation (the rule passed).
    expect(proofOfHelpfulness.eligibility?.eligible).toBe(true);
    // The durable identifiers exist.
    expect(typeof read.id).toBe("string");
    expect(typeof contribution.opportunityId).toBe("string");
  });

  test("an INELIGIBLE claimant fails closed at submission (the eligibility rule is enforced fail-closed)", async () => {
    await expect(
      createHelpfulContribution(harness.w014.w012, {
        claimantAttributes: {
          // The opportunity's rule requires participant_class
          // "contributor" — a viewer is NOT eligible.
          participant_class: ["viewer"],
          region: ["test-region"],
        },
        idempotencyKey: key("w033-ac01-ineligible"),
      }),
    ).rejects.toMatchObject({
      code: "HELPFUL_CONTRIBUTION_VALIDATION",
      classification: "validation",
      retryable: false,
    });
  });

  test("a cross-tenant submission fails closed (opportunity scope mismatch)", async () => {
    await expect(
      createHelpfulContribution(harness.w014.w012, {
        organizationScopeId: harness.secondOrgId,
        idempotencyKey: key("w033-ac01-cross-tenant"),
      }),
    ).rejects.toMatchObject({
      code: "HELPFUL_CONTRIBUTION_VALIDATION",
      classification: "validation",
    });
  });

  test("a non-HELPFUL opportunity type is refused (the helpful-contribution contract)", async () => {
    // A plain W004 opportunity (not a helpful_* type).
    const ctx = harness.contributorCtx("w033-ac01-plain-opportunity");
    const opportunity =
      await harness.runtime.opportunityService.createOpportunity(ctx, {
        organizationScopeId: harness.organizationScopeId,
        ownerId: harness.contributorPersonId,
        opportunityType: "generic_task",
        title: "A plain non-helpful opportunity",
      });
    const policy = await createHelpfulnessPolicy(harness.w014.w012);
    await expect(
      createHelpfulContribution(harness.w014.w012, {
        opportunityId: opportunity.id,
        helpfulnessPolicyId: policy.policyId,
        idempotencyKey: key("w033-ac01-not-helpful"),
      }),
    ).rejects.toMatchObject({
      code: "HELPFUL_CONTRIBUTION_VALIDATION",
      classification: "validation",
    });
  });

  test("STRUCTURAL: the contribution service port exposes creation + reads only (no W033-reachable direct state mutation)", async () => {
    const port = await readFile(
      join(REPO, "src/contributions/port.ts"),
      "utf8",
    );
    // The sanctioned service surface (W004 form, unchanged by W033).
    expect(port).toContain("export interface ContributionService {");
    expect(port).toContain("createContribution(");
    expect(port).toContain("getContribution(");
    // No state-mutation/service surface beyond creation (the lifecycle
    // belongs to /workflows; eligibility/basis to the W012 composite).
    expect(port).not.toMatch(/export interface ContributionService[\s\S]*?updateState\(/);
    expect(port).not.toMatch(/export interface ContributionService[\s\S]*?setStatus\(/);
    expect(port).not.toMatch(/export interface ContributionService[\s\S]*?transition\(/);
    // The repository port is internal persistence, NOT part of the
    // sanctioned API surface the composed scenario can reach.
    expect(port).not.toMatch(/export interface ContributionService[\s\S]*?repository:/);
  });
});
