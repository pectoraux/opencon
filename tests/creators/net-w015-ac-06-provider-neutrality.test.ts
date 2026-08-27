/**
 * NET-W015-AC-06 — Provider-specific platform behaviour remains
 * outside the creator domain behind adapter boundaries (issue #29
 * AC-6, invariant 2).
 *
 * Proves:
 *  - the domain source contains NO concrete provider names, SDK
 *    references, OAuth flows or credential fields;
 *  - the platform-kind and content-format vocabularies are CLOSED and
 *    provider-neutral (a provider-specific kind is refused at
 *    validation);
 *  - no adapter/infrastructure imports exist in the creators domain
 *    (the tier allow matrix holds — verified independently by
 *    arch:check, re-pinned here at the provider axis);
 *  - the composition points for later platform adapters are DECLARED
 *    (the port's neutral lookups + the adapter integration notes in
 *    the work order/evidence doc), NOT implemented — no external
 *    platform execution path exists.
 */
import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { join } from "node:path";
import { readFile, readdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import {
  createNetW015Harness,
  createCreatorProfile,
  defineCreatorProfileVersion,
  createDefaultSections,
  createFreshPerson,
  personCtx,
  key,
  type NetW015Harness,
} from "./_net-w015-harness.ts";
import type { CreatorProfileSections } from "../../src/creators/port.ts";
import {
  CREATOR_PLATFORM_KINDS,
  CREATOR_CONTENT_FORMATS,
  CREATOR_RATE_UNITS,
  CREATOR_RIGHTS_KINDS,
  CREATOR_AUDIENCE_SIZE_BANDS,
  CREATOR_ENGAGEMENT_BANDS,
  CREATOR_AUDIENCE_AGE_BANDS,
  CREATOR_REPUTATION_ROLES,
} from "../../src/core/creators.ts";

let harness: NetW015Harness;

beforeAll(async () => {
  harness = await createNetW015Harness();
});

afterAll(async () => {
  await harness.teardown();
});

const REPO = join(import.meta.dir, "../..");
const SRC = join(REPO, "src");

async function listTsFiles(dir: string, out: string[] = []): Promise<string[]> {
  if (!existsSync(dir)) return out;
  const entries = await readdir(dir, { withFileTypes: true });
  for (const e of entries) {
    const full = join(dir, e.name);
    if (e.isDirectory()) await listTsFiles(full, out);
    else if (e.isFile() && e.name.endsWith(".ts")) out.push(full);
  }
  return out;
}

describe("NET-W015-AC-06 provider neutrality", () => {
  test("the creator vocabularies are CLOSED and provider-neutral", () => {
    expect([...CREATOR_PLATFORM_KINDS]).toEqual([
      "social",
      "video",
      "audio",
      "written",
      "community",
    ]);
    expect([...CREATOR_CONTENT_FORMATS]).toEqual([
      "post",
      "short_video",
      "long_video",
      "audio_episode",
      "article",
      "newsletter",
      "live_stream",
      "image_set",
    ]);
    expect([...CREATOR_RATE_UNITS]).toEqual([
      "per_deliverable",
      "per_hour",
      "per_campaign",
    ]);
    expect([...CREATOR_RIGHTS_KINDS]).toEqual([
      "channel_publication",
      "paid_amplification",
      "reuse_license",
      "exclusivity_window",
      "derivative_works",
    ]);
    expect([...CREATOR_AUDIENCE_SIZE_BANDS]).toEqual([
      "lt_1k",
      "1k_10k",
      "10k_100k",
      "100k_1m",
      "1m_10m",
      "gt_10m",
    ]);
    expect([...CREATOR_ENGAGEMENT_BANDS]).toEqual([
      "low",
      "medium",
      "high",
      "very_high",
    ]);
    expect([...CREATOR_AUDIENCE_AGE_BANDS]).toEqual([
      "13_17",
      "18_24",
      "25_34",
      "35_44",
      "45_54",
      "55_64",
      "65_plus",
    ]);
    expect([...CREATOR_REPUTATION_ROLES]).toEqual([
      "audience_influence",
      "production",
    ]);
  });

  test("a provider-specific platform kind is refused at validation", async () => {
    const personId = await createFreshPerson(harness, "ac06-provider");
    const ctx = personCtx(harness, personId, "w015-ac06-provider");
    const { profile } = await createCreatorProfile(harness, {
      creatorPersonId: personId,
      ctx,
    });
    const sections = await createDefaultSections(harness, {
      subjectPersonId: personId,
    });
    const draft = JSON.parse(JSON.stringify(sections)) as Record<
      string,
      unknown
    >;
    (draft.platforms as Record<string, unknown>[])[0]!.platformKind =
      "instagram";
    await expect(
      defineCreatorProfileVersion(harness, profile.id, {
        sections: draft as unknown as CreatorProfileSections,
        ctx,
      }),
    ).rejects.toThrow(/platformKind/);
  });

  test("the creators domain source contains NO concrete provider names, SDK references or OAuth flows", async () => {
    const files = await listTsFiles(join(SRC, "creators"));
    // Provider-shaped identifiers that must NEVER appear in the
    // domain (provider semantics live behind adapter boundaries).
    const providerPatterns: RegExp[] = [
      /\binstagram\b/i,
      /\btiktok\b/i,
      /\byoutube\b/i,
      /\btwitch\b/i,
      /\bx\.?com\b/i,
      /\bfacebook\b/i,
      /\bmeta[-_ ]?platforms\b/i,
      /\bsubstack\b/i,
      /\bpatreon\b/i,
      /\boauth\b/i,
      /\bsdk\b/i,
      /client[-_ ]?secret/i,
      /webhook/i,
    ];
    for (const file of files) {
      const content = await readFile(file, "utf8");
      for (const pattern of providerPatterns) {
        expect(
          pattern.test(content),
          `provider pattern ${pattern} found in ${file.replace(REPO, ".")}`,
        ).toBe(false);
      }
    }
  });

  test("the creators domain imports ONLY core contracts (no adapter/infrastructure/other-domain imports)", async () => {
    const files = await listTsFiles(join(SRC, "creators"));
    const forbidden =
      /from\s+["']\.\.\/(identity|organizations|participants|opportunities|contributions|campaigns|inventory|demand|benefits|reputation|evidence|outcomes|settlement|workflows|disputes|payments|llm|agents|adapters|measurement|persistence|queues|object-storage|secrets|observability|audit|api|workers|bootstrap|config)\//;
    for (const file of files) {
      const content = await readFile(file, "utf8");
      expect(
        forbidden.test(content),
        `domain-boundary violation in ${file.replace(REPO, ".")}`,
      ).toBe(false);
    }
  });

  test("the adapter composition points are DECLARED, not implemented (no external platform execution path)", async () => {
    // The port declares the neutral lookup interfaces the composition
    // root wires adapters over — and NO platform-verification or
    // external-ingestion method exists on the domain service.
    const port = await readFile(join(SRC, "creators/port.ts"), "utf8");
    expect(port).toContain("CreatorPersonLookup");
    expect(port).toContain("CreatorReputationSnapshotLookup");
    // The service surface: profile/version/status + reads ONLY.
    const service = await readFile(
      join(SRC, "creators/creator-service.ts"),
      "utf8",
    );
    const methods = [...service.matchAll(/async\s+(\w+)\s*\(/g)].map(
      (m) => m[1]!,
    );
    expect(methods.sort()).toEqual(
      [
        "activateProfile",
        "archiveProfile",
        "createProfile",
        "defineProfileVersion",
        "getProfile",
        "getProfileByPerson",
        "getProfileVersion",
        "listProfiles",
        "listProfileVersions",
        "pauseProfile",
        "resumeProfile",
      ].sort(),
    );
    // No external platform execution verb anywhere.
    for (const verb of [
      "verifyPlatform",
      "connectPlatform",
      "fetchAudience",
      "syncPlatform",
      "importFollowers",
      "publish",
    ]) {
      expect(service).not.toContain(verb);
    }
  });

  test("a platform connection persists as a provider-neutral REFERENCE (no provider state survives)", async () => {
    const personId = await createFreshPerson(harness, "ac06-reference");
    const ctx = personCtx(harness, personId, "w015-ac06-reference");
    const { profile } = await createCreatorProfile(harness, {
      creatorPersonId: personId,
      ctx,
    });
    const sections = await createDefaultSections(harness, {
      subjectPersonId: personId,
    });
    await defineCreatorProfileVersion(harness, profile.id, {
      sections,
      ctx,
      idempotencyKey: key("w015-ac06-reference"),
    });
    const persisted = await harness.runtime.creatorService.getProfileVersion(
      ctx,
      profile.id,
      1,
    );
    const connection = persisted.sections.platforms[0]!;
    expect(Object.keys(connection).sort()).toEqual([
      "capabilities",
      "displayName",
      "handle",
      "languages",
      "platformKind",
      "profileUrl",
    ]);
    // The provider is identified ONLY through the handle + public URL
    // on a neutral platform-kind record.
    expect(connection.platformKind).toBe("video");
    expect(connection.handle).toBe("@fixture-creator");
  });
});
