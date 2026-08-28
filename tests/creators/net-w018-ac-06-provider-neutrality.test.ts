/**
 * NET-W018-AC-06 — provider-neutral adapter boundaries and secret
 * isolation remain intact (issue #35 AC-06; invariant 8).
 */

import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import {
  createNetW018Harness,
  createPublication,
  type NetW018Harness,
} from "./_net-w018-harness.ts";

const REPO = join(import.meta.dir, "../..");
const SRC = join(REPO, "src");

let harness: NetW018Harness;

beforeAll(async () => {
  harness = await createNetW018Harness();
});

afterAll(async () => {
  await harness.teardown();
});

async function listTsFiles(dir: string): Promise<string[]> {
  const out: string[] = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...(await listTsFiles(full)));
    } else if (entry.name.endsWith(".ts")) {
      out.push(full);
    }
  }
  return out;
}

describe("NET-W018-AC-06 provider neutrality", () => {
  test("the publication channel descriptor is provider-neutral: a closed channel kind + a neutral external reference", async () => {
    const publication = await createPublication(harness, {
      channel: {
        kind: "creator_owned_channel",
        externalPlatform: {
          provider: "example-platform",
          externalId: "ext-42",
          url: "https://example.com/ext-42",
        },
      },
    });
    expect(publication.channel.kind).toBe("creator_owned_channel");
    expect(publication.channel.externalPlatform).toEqual({
      provider: "example-platform",
      externalId: "ext-42",
      url: "https://example.com/ext-42",
    });
    // A channel WITHOUT any external reference is equally valid
    // (nothing forces platform coupling).
    const bare = await createPublication(harness, {
      channel: { kind: "network_channel", externalPlatform: null },
    });
    expect(bare.channel.externalPlatform).toBeNull();
  });

  test("the channel kind obeys the frozen closed vocabulary; the external reference shape is bounded", async () => {
    // Unknown channel kind → rejected.
    await expect(
      createPublication(harness, {
        channel: { kind: "the_creator_feed_of_a_specific_platform" },
      }),
    ).rejects.toMatchObject({ code: "SPONSORSHIP_VALIDATION" });
    // Malformed external references → rejected.
    await expect(
      createPublication(harness, {
        channel: {
          kind: "creator_owned_channel",
          externalPlatform: { provider: "", externalId: "x" },
        },
      }),
    ).rejects.toMatchObject({ code: "SPONSORSHIP_VALIDATION" });
    await expect(
      createPublication(harness, {
        channel: {
          kind: "creator_owned_channel",
          externalPlatform: {
            provider: "p".repeat(65),
            externalId: "x",
          },
        },
      }),
    ).rejects.toMatchObject({ code: "SPONSORSHIP_VALIDATION" });
    await expect(
      createPublication(harness, {
        channel: {
          kind: "creator_owned_channel",
          externalPlatform: {
            provider: "p",
            externalId: "x".repeat(201),
          },
        },
      }),
    ).rejects.toMatchObject({ code: "SPONSORSHIP_VALIDATION" });
    await expect(
      createPublication(harness, {
        channel: {
          kind: "creator_owned_channel",
          externalPlatform: {
            provider: "p",
            externalId: "x",
            url: "u".repeat(1001),
          },
        },
      }),
    ).rejects.toMatchObject({ code: "SPONSORSHIP_VALIDATION" });
  });

  test("the NET-W018 creator-domain files contain NO concrete provider names, flows or credentials", async () => {
    const files = [
      "src/creators/sponsorship-service.ts",
      "src/creators/disclosure-engine.ts",
      "src/creators/authority-sponsorship-repositories.ts",
    ];
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
      /api[-_ ]?key/i,
      /access[-_ ]?token/i,
    ];
    for (const rel of files) {
      const content = await readFile(join(REPO, rel), "utf8");
      for (const pattern of providerPatterns) {
        expect(
          pattern.test(content),
          `provider pattern ${pattern} found in ${rel}`,
        ).toBe(false);
      }
    }
  });

  test("no adapter/infrastructure import exists in the NET-W018 creator-domain files (the tier rule holds)", async () => {
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

  test("no secrets or credentials were introduced by NET-W018", async () => {
    const secretPatterns: RegExp[] = [
      /github_pat_[A-Za-z0-9_]+/,
      /ghp_[A-Za-z0-9]+/,
      /sk-[A-Za-z0-9]{20,}/,
      /AKIA[0-9A-Z]{16}/,
      /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
    ];
    const files = [
      "src/creators/sponsorship-service.ts",
      "src/creators/disclosure-engine.ts",
      "src/creators/authority-sponsorship-repositories.ts",
      "src/creators/port.ts",
      "src/core/creators.ts",
      "src/core/campaigns.ts",
      "src/core/workflow.ts",
      "src/workflows/transition-table.ts",
      "src/bootstrap/runtime.ts",
      "src/api/server.ts",
      "src/api/port.ts",
      "tests/creators/_net-w018-harness.ts",
    ];
    for (const rel of files) {
      const content = await readFile(join(REPO, rel), "utf8");
      for (const pattern of secretPatterns) {
        expect(
          pattern.test(content),
          `secret pattern ${pattern} found in ${rel}`,
        ).toBe(false);
      }
    }
  });

  test("external platform EXECUTION stays out of scope: no adapter execution path exists in the sponsorship surface", async () => {
    const service = await readFile(
      join(REPO, "src/creators/sponsorship-service.ts"),
      "utf8",
    );
    // The publication record is a RECORD of a publication (with
    // neutral external reference) — the boundary never EXECUTES an
    // external publication.
    expect(service).not.toMatch(/\bpublishTo\b/i);
    expect(service).not.toMatch(/\bpostToPlatform\b/i);
    expect(service).not.toMatch(/\bexecuteAdapter\b/i);
    expect(service).not.toMatch(/\bfetchExternal\b/i);
  });
});
