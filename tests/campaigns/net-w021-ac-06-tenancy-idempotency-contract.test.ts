/**
 * NET-W021 AC-06 — Tenant isolation, authorization, idempotency,
 * byte-identical replay, deterministic digests, the run-record
 * contract and the HTTP surface (the integration tests).
 */

import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { createHash } from "node:crypto";
import { createExecutionContext } from "../../src/core/execution-context.ts";
import { NotFoundError } from "../../src/core/errors.ts";
import { InvalidCampaignMatchError } from "../../src/core/campaigns.ts";
import {
  createNetW021Harness,
  createMatchCampaign,
  registerSupplyItem,
  createVerifiedItemOutcome,
  runCampaignMatch,
  key,
  operatorCtx,
  personCtx,
  type NetW021Harness,
} from "./_net-w021-harness.ts";

let harness: NetW021Harness;

beforeAll(async () => {
  harness = await createNetW021Harness();
});

afterAll(async () => {
  await harness.teardown();
});

describe("NET-W021 AC-06: tenancy + idempotency + contract + HTTP", () => {
  test("tenant isolation: a cross-scope campaign is indistinguishable from a nonexistent one", async () => {
    // A campaign in the SECOND org.
    const foreign = await createMatchCampaign(harness, {
      ownerPersonId: harness.secondOrgPersonId,
      organizationScopeId: harness.secondOrgId,
    });
    await expect(
      runCampaignMatch(harness, {
        campaignId: foreign.id,
        idempotencyKey: key("w021-ac06-foreign"),
      }),
    ).rejects.toBeInstanceOf(NotFoundError);
    // And a run id from another org reads as not found.
    const foreignRun = await harness.runtime.campaignMatchingService
      .runCampaignMatch(
        personCtx(harness, harness.secondOrgPersonId, "w021-ac06-foreign-run"),
        {
          organizationScopeId: harness.secondOrgId,
          campaignId: foreign.id,
          idempotencyKey: key("w021-ac06-foreign-run"),
        },
      );
    await expect(
      harness.runtime.campaignMatchingService.getMatchRun(
        operatorCtx(harness, "w021-ac06-foreign-read"),
        harness.organizationScopeId,
        foreignRun.run.id,
      ),
    ).rejects.toBeInstanceOf(NotFoundError);
    // The first org's list does not leak the foreign run.
    const runs = await harness.runtime.campaignMatchingService.listMatchRuns(
      operatorCtx(harness, "w021-ac06-foreign-list"),
      harness.organizationScopeId,
    );
    expect(runs.find((r) => r.id === foreignRun.run.id)).toBeUndefined();
  });

  test("tenant isolation: a cross-scope candidate item is NotFound (no existence oracle)", async () => {
    const campaign = await createMatchCampaign(harness);
    // Supply in the second org.
    const foreignItem = await harness.runtime.inventoryService
      .registerInventoryItem(
        personCtx(harness, harness.secondOrgPersonId, "w021-ac06-foreign-item"),
        {
          organizationScopeId: harness.secondOrgId,
          surfaceKind: "publisher",
          format: "display",
          externalReference: {
            provider: "example-ad-network",
            externalId: "foreign-supply-1",
            url: null,
          },
          attributes: { territories: ["US"], languages: ["en"] },
          description: "foreign fixture supply",
          idempotencyKey: key("w021-ac06-foreign-item"),
        },
      );
    await expect(
      runCampaignMatch(harness, {
        campaignId: campaign.id,
        candidateInventoryItemIds: [foreignItem.item.id],
        idempotencyKey: key("w021-ac06-foreign-candidate"),
      }),
    ).rejects.toBeInstanceOf(NotFoundError);
  });

  test("a service actor cannot run a match (person actor required)", async () => {
    const campaign = await createMatchCampaign(harness);
    await expect(
      harness.runtime.campaignMatchingService.runCampaignMatch(
        createExecutionContext({
          correlationId: "w021-ac06-service-actor",
          actor: { id: "some-service", kind: "service" },
        }),
        {
          organizationScopeId: harness.organizationScopeId,
          campaignId: campaign.id,
          idempotencyKey: key("w021-ac06-service-actor"),
        },
      ),
    ).rejects.toBeInstanceOf(InvalidCampaignMatchError);
  });

  test("the run pins the campaign + policy version (explicit pin honored)", async () => {
    const campaign = await createMatchCampaign(harness);
    const item = await registerSupplyItem(harness, {});
    // Define a SECOND policy version (the campaign stays ACTIVE).
    await harness.runtime.campaignService.defineCampaignPolicy(
      operatorCtx(harness, "w021-ac06-policy-v2"),
      {
        campaignId: campaign.id,
        policy: {
          objectives: [
            {
              id: "obj-1",
              kind: "engagement",
              description: null,
              successCriteria: null,
            },
          ],
          eligibility: { rules: [] },
          outcomePolicy: {
            requirements: [
              {
                objectiveId: "obj-1",
                outcomeType: "engagement",
                attributionMode: "deterministic",
                windowDays: 30,
                requiresExperiment: false,
              },
            ],
          },
          evidencePolicy: {
            requirements: [
              {
                objectiveId: "obj-1",
                requirementKind: "proof_of_value",
                minimumGrade: "ATTESTED",
                qualifyingSourceTypes: ["platform"],
              },
            ],
          },
          budget: { unit: "credits", totalAmount: 0, perObjective: [] },
          attributionRules: [
            {
              id: "attr-1",
              objectiveId: "obj-1",
              model: "deterministic",
              confidenceThreshold: 0.9,
              windowDays: 30,
              requiresExperiment: false,
            },
          ],
          clearingRules: [],
          opportunitySpecs: [
            {
              id: "spec-1",
              title: "v2 opportunity",
              opportunityType: "campaign_contribution",
              brief: { neutral: true },
              contributionRequirements: { deliverables: 1 },
              evidenceReferencePlaceholders: ["evidence-ugc-production"],
            },
          ],
        },
        idempotencyKey: key("w021-ac06-policy-v2"),
      },
    );
    // Pin v1 explicitly.
    const { run } = await runCampaignMatch(harness, {
      campaignId: campaign.id,
      policyVersion: 1,
      candidateInventoryItemIds: [item.id],
      idempotencyKey: key("w021-ac06-pin"),
    });
    expect(run.campaign).toEqual({
      campaignId: campaign.id,
      policyVersion: 1,
    });
    expect(run.requiredOutcomeTypes).toEqual(["view"]);
    // Without a pin: the CURRENT version (2) applies.
    const { run: latest } = await runCampaignMatch(harness, {
      campaignId: campaign.id,
      candidateInventoryItemIds: [item.id],
      idempotencyKey: key("w021-ac06-latest"),
    });
    expect(latest.campaign.policyVersion).toBe(2);
    expect(latest.requiredOutcomeTypes).toEqual(["engagement"]);
  });

  test("identical inputs produce identical digests; replay is byte-identical; the record contract is pinned", async () => {
    const campaign = await createMatchCampaign(harness);
    const item = await registerSupplyItem(harness, {});
    await createVerifiedItemOutcome(harness, item.id, { value: 5_000 });

    const first = await runCampaignMatch(harness, {
      campaignId: campaign.id,
      candidateInventoryItemIds: [item.id],
      idempotencyKey: key("w021-ac06-digest-1"),
    });
    const second = await runCampaignMatch(harness, {
      campaignId: campaign.id,
      candidateInventoryItemIds: [item.id],
      idempotencyKey: key("w021-ac06-digest-2"),
    });
    // Two runs, same inputs → identical digest (determinism).
    expect(first.run.digest).toBe(second.run.digest);
    expect(first.run.id).not.toBe(second.run.id);

    // Replay of the first key → byte-identical record.
    const replay = await runCampaignMatch(harness, {
      campaignId: campaign.id,
      candidateInventoryItemIds: [item.id],
      idempotencyKey: first.run.idempotencyKey,
    });
    expect(replay.created).toBe(false);
    expect(JSON.stringify(replay.run)).toBe(JSON.stringify(first.run));

    // The record contract (pinned shape — sorted keys).
    const run = first.run;
    expect(Object.keys(run).sort()).toEqual([
      "advisory",
      "campaign",
      "candidateCount",
      "causationId",
      "correlationId",
      "createdAt",
      "createdBy",
      "digest",
      "eligibleCount",
      "evaluatedAt",
      "excluded",
      "executionId",
      "formatVersion",
      "id",
      "idempotencyKey",
      "organizationScopeId",
      "requiredOutcomeTypes",
      "results",
      "targeting",
      "weights",
    ]);
    // The deterministic evaluation anchor is recorded on the
    // decision (the PR #43 review fix: an ISO instant, one per run).
    expect(run.evaluatedAt).toMatch(
      /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/,
    );
    expect(run.formatVersion).toBe("NET-W021:1");
    expect(run.createdBy).toBe(harness.operatorPersonId);
    expect(run.organizationScopeId).toBe(harness.organizationScopeId);
    // The effective targeting is the campaign-derived merge (v1 has
    // no region/language rules → empty targeting).
    expect(run.targeting).toEqual({
      requiredFormats: [],
      requiredSurfaceKinds: [],
      targetTerritories: [],
      requiredLanguages: [],
    });
    // Campaign-derived targeting: a positive region/language rule
    // merges into the effective targeting.
    const merged = await createMatchCampaign(harness, {
      rules: [
        { attribute: "region", operator: "in", values: ["US", "GH"] },
        { attribute: "language", operator: "equals", values: ["en"] },
      ],
    });
    const mergedRun = await runCampaignMatch(harness, {
      campaignId: merged.id,
      candidateInventoryItemIds: [item.id],
      idempotencyKey: key("w021-ac06-merged"),
    });
    expect(mergedRun.run.targeting.targetTerritories).toEqual(["US", "GH"]);
    expect(mergedRun.run.targeting.requiredLanguages).toEqual(["en"]);
  });

  test("HTTP: POST /api/campaigns/matching is guarded (403) and runs (201; replay created=false); the GETs are tenant-scoped", async () => {
    const base = `http://127.0.0.1:${harness.runtime.api.port}`;
    const campaign = await createMatchCampaign(harness);
    const item = await registerSupplyItem(harness, {});
    const idempotencyKey = key("w021-ac06-http");
    const body = {
      organizationScopeId: harness.organizationScopeId,
      campaignId: campaign.id,
      candidateInventoryItemIds: [item.id],
      idempotencyKey,
    };
    // Unauthenticated: the guard refuses (403).
    const unauthenticated = await fetch(`${base}/api/campaigns/matching`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    expect(unauthenticated.status).toBe(403);

    // Authenticated operator: 201 + the run view.
    const operatorSubject = "w021-http-operator@example.com";
    await harness.runtime.identityService.createIdentity(
      harness.bootstrapCtx,
      {
        displayName: "W021 HTTP Operator",
        subjectReferences: [
          { subjectId: operatorSubject, providerKind: "internal" },
        ],
      },
    );
    const created = await fetch(`${base}/api/campaigns/matching`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-auth-subject-id": operatorSubject,
      },
      body: JSON.stringify(body),
    });
    expect(created.status).toBe(201);
    const createdBody = (await created.json()) as {
      created: boolean;
      run: {
        id: string;
        eligibleCount: number;
        digest: string;
        targeting: Record<string, unknown>;
        requiredOutcomeTypes: string[];
      };
    };
    expect(createdBody.created).toBe(true);
    expect(createdBody.run.eligibleCount).toBe(1);
    expect(createdBody.run.requiredOutcomeTypes).toEqual(["view"]);
    expect(createdBody.run.digest).toHaveLength(64);

    // Idempotent replay over HTTP: 201 + created=false.
    const replay = await fetch(`${base}/api/campaigns/matching`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-auth-subject-id": operatorSubject,
      },
      body: JSON.stringify(body),
    });
    expect(replay.status).toBe(201);
    const replayBody = (await replay.json()) as { created: boolean };
    expect(replayBody.created).toBe(false);

    // GET list: 400 without scope; 200 with scope (no cross-scope).
    const missingScope = await fetch(`${base}/api/campaigns/matching`);
    expect(missingScope.status).toBe(400);
    const list = await fetch(
      `${base}/api/campaigns/matching?organizationScopeId=${harness.organizationScopeId}&campaignId=${campaign.id}`,
    );
    expect(list.status).toBe(200);
    const listBody = (await list.json()) as {
      runs: { id: string; digest: string }[];
    };
    expect(listBody.runs.map((r) => r.id)).toContain(createdBody.run.id);

    // GET one: 404 cross-scope; 200 same-scope.
    const wrongScope = await fetch(
      `${base}/api/campaigns/matching/${createdBody.run.id}?organizationScopeId=${harness.secondOrgId}`,
    );
    expect(wrongScope.status).toBe(404);
    const ok = await fetch(
      `${base}/api/campaigns/matching/${createdBody.run.id}?organizationScopeId=${harness.organizationScopeId}`,
    );
    expect(ok.status).toBe(200);
    const okBody = (await ok.json()) as { id: string; digest: string };
    expect(okBody.id).toBe(createdBody.run.id);
    expect(okBody.digest).toBe(createdBody.run.digest);
  });

  test("the run record + digest are recomputable (the engine digest over the stored decision)", async () => {
    const campaign = await createMatchCampaign(harness);
    const item = await registerSupplyItem(harness, {});
    const { run } = await runCampaignMatch(harness, {
      campaignId: campaign.id,
      candidateInventoryItemIds: [item.id],
      idempotencyKey: key("w021-ac06-recompute"),
    });
    const { computeMatchDigest } = await import(
      "../../src/campaigns/matching-engine.ts"
    );
    const recomputed = computeMatchDigest(run);
    expect(recomputed).toBe(run.digest);
  });

  test("REGRESSION (PR #43 review): the digest covers the PER-CANDIDATE advisory metadata (a top-candidate collapse cannot reproduce it)", async () => {
    // Two eligible candidates whose echo advisory scores are
    // intentionally DISTINCT (different formats → different privacy-
    // minimized neutral facts → different deterministic echo hashes
    // for BOTH purposes).
    const campaign = await createMatchCampaign(harness);
    const display = await registerSupplyItem(harness, {
      actorPersonId: harness.operatorPersonId,
    });
    const video = await registerSupplyItem(harness, {
      actorPersonId: harness.operatorPersonId,
      format: "video",
    });
    const { run } = await runCampaignMatch(harness, {
      campaignId: campaign.id,
      candidateInventoryItemIds: [display.id, video.id],
      advisory: {
        matching: { enabled: true, maxWeight: 25 },
        risk: { enabled: true, maxWeight: 25 },
      },
      idempotencyKey: key("w021-ac06-per-candidate-digest"),
    });
    expect(run.eligibleCount).toBe(2);
    const displayResult = run.results.find(
      (r) => r.inventoryItemId === display.id,
    )!;
    const videoResult = run.results.find(
      (r) => r.inventoryItemId === video.id,
    )!;

    // The per-candidate echo score for EACH candidate's OWN fact set
    // (the provider-input proof, per candidate — the fact order is
    // the service's fixed construction order).
    const echoScore = (purpose: "matching" | "safety", format: string) => {
      const neutralFacts =
        purpose === "matching"
          ? [
              { label: "campaign_required_outcome_type", value: "view" },
              { label: "supply_surface_kind", value: "publisher" },
              { label: "supply_format", value: format },
              { label: "supply_territory_count", value: "2" },
              { label: "supply_language_count", value: "1" },
              { label: "evidence_present", value: "view:no" },
            ]
          : [
              { label: "supply_surface_kind", value: "publisher" },
              { label: "supply_format", value: format },
              { label: "supply_territory_count", value: "2" },
              { label: "supply_language_count", value: "1" },
              { label: "evidence_present", value: "view:no" },
              { label: "owner_has_standing_snapshot", value: "no" },
              { label: "owner_has_reliability_snapshot", value: "no" },
              { label: "owner_has_fraud_resistance_snapshot", value: "no" },
            ];
      const canonical = JSON.stringify({
        purpose,
        rubricRef:
          purpose === "matching"
            ? "campaign-matching:NET-W021:1"
            : "campaign-matching-risk:NET-W021:1",
        neutralFacts,
      });
      const digest = createHash("sha256")
        .update(canonical, "utf8")
        .digest("hex");
      return (
        Math.round(
          (Number.parseInt(digest.slice(0, 8), 16) / 0x1_0000_0000) * 1000,
        ) / 10
      );
    };
    // Candidate A → advisory A; candidate B → advisory B — for BOTH
    // purposes, through the real adapter chain (LlmPort purposes
    // "matching" and "safety").
    expect(displayResult.advisory.matching).toEqual({
      score: echoScore("matching", "display"),
      provider: "echo",
      modelRef: "echo-scoring-v1",
    });
    expect(videoResult.advisory.matching).toEqual({
      score: echoScore("matching", "video"),
      provider: "echo",
      modelRef: "echo-scoring-v1",
    });
    expect(displayResult.advisory.risk).toEqual({
      score: echoScore("safety", "display"),
      provider: "echo",
      modelRef: "echo-scoring-v1",
    });
    expect(videoResult.advisory.risk).toEqual({
      score: echoScore("safety", "video"),
      provider: "echo",
      modelRef: "echo-scoring-v1",
    });
    // The two candidates' advisory scores are distinct (both
    // purposes) — the guard for the sensitivity assertions below.
    expect(displayResult.advisory.matching!.score).not.toBe(
      videoResult.advisory.matching!.score,
    );
    expect(displayResult.advisory.risk!.score).not.toBe(
      videoResult.advisory.risk!.score,
    );

    // Recomputation over the stored decision reproduces the digest.
    const { computeMatchDigest } = await import(
      "../../src/campaigns/matching-engine.ts"
    );
    expect(computeMatchDigest(run)).toBe(run.digest);

    // DIGEST SENSITIVITY: swapping ONLY the two candidates' advisory
    // blocks on the stored record changes the recomputed digest —
    // the per-candidate advisory metadata is digest-covered, so a
    // future refactor that collapses it back to a single run-level
    // value can no longer reproduce the stored digest (the swap
    // would be a no-op for a run-level-only digest).
    const swapped = {
      ...run,
      results: run.results.map((r) =>
        r.inventoryItemId === display.id
          ? { ...r, advisory: videoResult.advisory }
          : r.inventoryItemId === video.id
            ? { ...r, advisory: displayResult.advisory }
            : r,
      ),
    };
    expect(computeMatchDigest(swapped)).not.toBe(run.digest);
    // Mutating ONE candidate's matching advisory score alone changes
    // it too (the guard picks a value guaranteed different from the
    // recorded one).
    const mutatedScore =
      displayResult.advisory.matching!.score === 12.5 ? 88.8 : 12.5;
    const oneMutated = {
      ...run,
      results: run.results.map((r) =>
        r.inventoryItemId === display.id
          ? {
              ...r,
              advisory: {
                ...r.advisory,
                matching: { ...r.advisory.matching!, score: mutatedScore },
              },
            }
          : r,
      ),
    };
    expect(computeMatchDigest(oneMutated)).not.toBe(run.digest);
  });
});
