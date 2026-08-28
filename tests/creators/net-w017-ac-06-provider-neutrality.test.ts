/**
 * NET-W017 AC-06 — provider-neutral adapter boundaries + secret
 * isolation.
 *
 * Proves (work order §3.4, issue #33 AC-6 + invariant 6):
 *  - external platform references are OPAQUE provider-neutral
 *    strings ({provider, externalId, url?}) — no provider SDK
 *    semantics in the domain (no platform-specific parsing,
 *    no reserved provider names, no execution);
 *  - the domain never imports adapters/external integrations;
 *  - secrets never enter the creators boundary (no secret-shaped
 *    fields on any W017 record or input; the credential-shaped key
 *    guards from W015 still hold for the W017 surface);
 *  - channel/territory/format/use vocabularies are closed and
 *    validated (the W017 additions pinned).
 */

import { describe, expect, test } from "bun:test";
import {
  acceptEngagement,
  createEngagement,
  key,
  openProduction,
  personCtx,
  recordDeliverable,
  tenderEngagement,
  createNetW017Harness,
} from "./_net-w017-harness.ts";
import {
  InvalidEngagementError,
  USAGE_RIGHTS_CHANNELS,
  AUTO_ACCEPT_GATE_REASONS,
} from "../../src/core/creators.ts";
import { ENGAGEMENT_BATCH_SKIP_REASONS } from "../../src/creators/port.ts";

describe("NET-W017 AC-06 — provider neutrality + secret isolation", () => {
  test("external platform references are opaque provider-neutral strings on deliverables", async () => {
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
      // ANY provider string is accepted — provider-neutral, no
      // platform-specific semantics.
      const providers = ["example-platform", "another-one", "p123", "x"];
      for (const provider of providers) {
        const result = await recordDeliverable(harness, production.id, {
          deliverableKey: `deliverable-${provider}`,
          externalPlatform: {
            provider,
            externalId: `ext-${provider}`,
            url: null,
          },
        });
        expect(result.deliverable.externalPlatform?.provider).toBe(provider);
        expect(result.deliverable.externalPlatform?.externalId).toBe(
          `ext-${provider}`,
        );
        expect(result.deliverable.externalPlatform?.url).toBeNull();
      }
      // Missing externalId is rejected (a reference must be a real
      // reference — but as a SHAPE validation, not provider
      // semantics).
      const ctx = personCtx(harness, harness.creatorPersonId, "w017-ext");
      await expect(
        harness.runtime.creatorEngagementService.recordDeliverable(ctx, {
          organizationScopeId: harness.organizationScopeId,
          productionId: production.id,
          deliverableKey: "bad",
          format: "short_video",
          externalPlatform: { provider: "example-platform", externalId: "" },
          idempotencyKey: key("w017-ext-bad"),
        }),
      ).rejects.toBeInstanceOf(InvalidEngagementError);
    } finally {
      await harness.teardown();
    }
  }, 60_000);

  test("the creators domain never imports adapters or external integrations", async () => {
    const { readdir, readFile } = await import("node:fs/promises");
    for (const name of await readdir("src/creators")) {
      if (!name.endsWith(".ts")) continue;
      const source = await readFile(`src/creators/${name}`, "utf8");
      expect(source).not.toContain('from "../adapters/');
      expect(source).not.toContain('from "../llm/');
      expect(source).not.toContain('from "../measurement/');
      expect(source).not.toContain('from "../payments/');
      expect(source).not.toContain('from "../ledger/');
      expect(source).not.toContain('from "../agents/');
    }
  });

  test("no secret-shaped fields exist on the W017 record types (secret isolation)", async () => {
    const { readFile } = await import("node:fs/promises");
    // Strip comments first: documentation legitimately MENTIONS the
    // secret boundary ("credentials stay behind secrets/adapters") —
    // the pin is about FIELDS, not prose.
    const stripComments = (source: string): string =>
      source
        .replace(/\/\*[\s\S]*?\*\//g, "")
        .replace(/(^|[^:])\/\/.*$/gm, "$1");
    const port = await readFile("src/creators/port.ts", "utf8");
    // The W017 section of the port: extract from the NET-W017 marker.
    const marker = port.indexOf("NET-W017 — UGC workflow and rights");
    expect(marker).toBeGreaterThan(0);
    const w017Section = stripComments(port.slice(marker));
    const secretPatterns = [
      /\btoken\b/i,
      /\bpassword\b/i,
      /\bapiKey\b/i,
      /\bapi_key\b/i,
      /\bsecret\w*\s*[:?]/,
      /\bcredential\w*\s*[:?]/,
      /\bprivateKey\b/i,
    ];
    for (const pattern of secretPatterns) {
      expect(pattern.test(w017Section)).toBe(false);
    }
    // The core W017 vocabulary carries no secret-shaped fields.
    const core = await readFile("src/core/creators.ts", "utf8");
    const coreMarker = core.indexOf("NET-W017 — UGC workflow and rights");
    expect(coreMarker).toBeGreaterThan(0);
    const coreSection = stripComments(core.slice(coreMarker));
    for (const pattern of secretPatterns) {
      expect(pattern.test(coreSection)).toBe(false);
    }
  });

  test("the W017 service layer never touches the secret provider", async () => {
    const { readFile } = await import("node:fs/promises");
    for (const name of [
      "engagement-service.ts",
      "engagement-engine.ts",
      "authority-engagement-repositories.ts",
    ]) {
      const source = await readFile(`src/creators/${name}`, "utf8");
      expect(source).not.toMatch(/\bsecretProvider\b/i);
      expect(source).not.toMatch(/\bgetSecret\b/);
      expect(source).not.toMatch(/SecretProvider/);
    }
  });

  test("the W017 closed vocabularies are pinned", () => {
    expect(USAGE_RIGHTS_CHANNELS).toEqual([
      "creator_owned_channel",
      "organizer_channel",
      "network_channel",
      "paid_media",
    ]);
    expect(AUTO_ACCEPT_GATE_REASONS).toEqual([
      "policy_not_auto_accept",
      "policy_not_found",
      "profile_not_active",
      "not_accepting_work",
      "too_many_active_engagements",
      "rate_below_floor",
      "rights_not_auto_grantable",
      "grant_duration_exceeds_policy",
      "active_risk_control",
    ]);
    expect(ENGAGEMENT_BATCH_SKIP_REASONS).toEqual([
      "open_engagement_exists",
      "profile_not_active",
    ]);
  });

  test("deliverable external platform references carry NO execution semantics (data, never calls)", async () => {
    const { readFile } = await import("node:fs/promises");
    const service = await readFile(
      "src/creators/engagement-service.ts",
      "utf8",
    );
    // The external platform reference is stored verbatim — the
    // service never parses provider names, never dispatches to a
    // provider, never fetches URLs.
    expect(service).not.toMatch(/fetch\s*\(/);
    expect(service).not.toMatch(/httpClient|HttpClient/);
    expect(service).not.toMatch(/providerAdapter|ProviderAdapter/);
  });

  test("external references on engagements are briefs (opaque structured data) — no provider SDK semantics", async () => {
    const harness = await createNetW017Harness();
    try {
      const { engagement } = await createEngagement(harness, {
        compensation: null,
      });
      // The brief is opaque structured data, carried verbatim.
      expect(engagement.brief).toEqual({ note: "w017 fixture offer" });
      expect(engagement.compensation).toBeNull();
      // A compensation with an unknown format is rejected (closed
      // vocabulary — provider-neutral but still validated).
      await expect(
        createEngagement(harness, {
          compensation: {
            format: "vibes",
            unit: "per_deliverable",
            amount: 10,
            currency: "USD",
            rewardPolicyReference: null,
          },
        }),
      ).rejects.toBeInstanceOf(InvalidEngagementError);
    } finally {
      await harness.teardown();
    }
  }, 60_000);
});
