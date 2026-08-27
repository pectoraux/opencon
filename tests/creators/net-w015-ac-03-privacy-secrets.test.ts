/**
 * NET-W015-AC-03 — Privacy and secret boundaries are enforced; raw
 * credentials and unnecessary raw audience data cannot enter creator
 * records (issue #29 AC-3, invariants 3 and 6).
 *
 * Proves:
 *  - credential-shaped keys are rejected at ANY nesting depth of ANY
 *    section (token/secret/api-key/password/credential/…);
 *  - raw-audience-shaped keys are rejected at ANY nesting depth
 *    (members/emails/individuals/contacts/device-ids/…);
 *  - the audience section is structurally aggregate-only (bands +
 *    bounded shares — no field can carry individual data);
 *  - a persisted profile version contains NO credential-shaped or
 *    raw-audience-shaped keys anywhere (deep scan of the stored
 *    record);
 *  - the pure guards are exported from the core contracts (the
 *    fail-closed validator is the shared boundary).
 */
import { describe, test, expect, beforeAll, afterAll } from "bun:test";
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
  CREDENTIAL_KEY_FRAGMENTS,
  RAW_AUDIENCE_KEY_FRAGMENTS,
} from "../../src/core/creators.ts";

let harness: NetW015Harness;

beforeAll(async () => {
  harness = await createNetW015Harness();
});

afterAll(async () => {
  await harness.teardown();
});

async function profileForValidation(label: string): Promise<{
  profileId: string;
  ctx: ReturnType<typeof personCtx>;
  sections: CreatorProfileSections;
  personId: string;
}> {
  const personId = await createFreshPerson(harness, label);
  const ctx = personCtx(harness, personId, `w015-${label}`);
  const { profile } = await createCreatorProfile(harness, {
    creatorPersonId: personId,
    ctx,
  });
  const sections = await createDefaultSections(harness, {
    subjectPersonId: personId,
  });
  return { profileId: profile.id, ctx, sections, personId };
}

/** Attempt to define a version with a smuggled extra field. */
function attempt(
  profileId: string,
  ctx: ReturnType<typeof personCtx>,
  sections: CreatorProfileSections,
): Promise<unknown> {
  return defineCreatorProfileVersion(harness, profileId, {
    sections,
    ctx,
  });
}

function withExtra(
  base: CreatorProfileSections,
  mutate: (draft: Record<string, unknown>) => void,
): CreatorProfileSections {
  const draft = JSON.parse(JSON.stringify(base)) as Record<string, unknown>;
  mutate(draft);
  return draft as unknown as CreatorProfileSections;
}

describe("NET-W015-AC-03 privacy and secret boundaries", () => {
  // -----------------------------------------------------------------
  // Credential-shaped material: rejected everywhere, at any depth
  // -----------------------------------------------------------------

  test("a platform accessToken is rejected (the classic provider-credential smuggle)", async () => {
    const { profileId, ctx, sections } = await profileForValidation("ac03-token");
    await expect(
      attempt(
        profileId,
        ctx,
        withExtra(sections, (d) => {
          (d.platforms as Record<string, unknown>[])[0]!.accessToken =
            "ya29.a0AfH6SMBx...";
        }),
      ),
    ).rejects.toThrow(/credential-shaped field "accessToken"/);
  });

  test("an apiSecret nested DEEP inside a section object is rejected", async () => {
    const { profileId, ctx, sections } = await profileForValidation("ac03-deep");
    await expect(
      attempt(
        profileId,
        ctx,
        withExtra(sections, (d) => {
          (d.commercial as Record<string, unknown>).pricing = {
            tiers: [
              {
                name: "premium",
                rules: { apiSecret: "sk-live-abcdef123456" },
              },
            ],
          };
        }),
      ),
    ).rejects.toThrow(/credential-shaped field "apiSecret"/);
  });

  test("a password field on the availability section is rejected", async () => {
    const { profileId, ctx, sections } = await profileForValidation("ac03-password");
    await expect(
      attempt(
        profileId,
        ctx,
        withExtra(sections, (d) => {
          (d.availability as Record<string, unknown>).calendarPassword =
            "hunter2";
        }),
      ),
    ).rejects.toThrow(/credential-shaped field "calendarPassword"/);
  });

  test("a refreshToken inside an ARRAY element of the restrictions is rejected", async () => {
    const { profileId, ctx, sections } = await profileForValidation("ac03-refresh");
    await expect(
      attempt(
        profileId,
        ctx,
        withExtra(sections, (d) => {
          d.rights = [
            ...(d.rights as Record<string, unknown>[]),
            {
              kind: "reuse_license",
              terms: "ok",
              connection: { refreshToken: "rt_123" },
            },
          ];
        }),
      ),
    ).rejects.toThrow(/credential-shaped field "refreshToken"/);
  });

  test("a private-key-shaped field on the audience section is rejected", async () => {
    const { profileId, ctx, sections } = await profileForValidation("ac03-pkey");
    await expect(
      attempt(
        profileId,
        ctx,
        withExtra(sections, (d) => {
          (d.audience as Record<string, unknown>).sourcePrivateKey =
            "PK-PLACEHOLDER-NOT-A-REAL-KEY";
        }),
      ),
    ).rejects.toThrow(/credential-shaped field "sourcePrivateKey"/);
  });

  // -----------------------------------------------------------------
  // Raw-audience material: rejected everywhere, at any depth
  // -----------------------------------------------------------------

  test("an audience members array is rejected (raw individual records)", async () => {
    const { profileId, ctx, sections } = await profileForValidation("ac03-members");
    await expect(
      attempt(
        profileId,
        ctx,
        withExtra(sections, (d) => {
          (d.audience as Record<string, unknown>).members = [
            { id: "u1", email: "a@example.com" },
            { id: "u2", email: "b@example.com" },
          ];
        }),
      ),
    ).rejects.toThrow(/raw-audience-shaped field "members"/);
  });

  test("a followerEmails list nested inside a platform connection is rejected", async () => {
    const { profileId, ctx, sections } = await profileForValidation("ac03-emails");
    await expect(
      attempt(
        profileId,
        ctx,
        withExtra(sections, (d) => {
          (d.platforms as Record<string, unknown>[])[0]!.followerEmails = [
            "fan1@example.com",
          ];
        }),
      ),
    ).rejects.toThrow(/raw-audience-shaped field "followerEmails"/);
  });

  test("a contact list on the commercial section is rejected", async () => {
    const { profileId, ctx, sections } = await profileForValidation("ac03-contacts");
    await expect(
      attempt(
        profileId,
        ctx,
        withExtra(sections, (d) => {
          (d.commercial as Record<string, unknown>).contacts = [
            { name: "Fan", phone: "+233..." },
          ];
        }),
      ),
    ).rejects.toThrow(/raw-audience-shaped field "contacts"/);
  });

  test("a deviceIds array on the audience section is rejected", async () => {
    const { profileId, ctx, sections } = await profileForValidation("ac03-devices");
    await expect(
      attempt(
        profileId,
        ctx,
        withExtra(sections, (d) => {
          (d.audience as Record<string, unknown>).deviceIds = ["d1", "d2"];
        }),
      ),
    ).rejects.toThrow(/raw-audience-shaped field "deviceIds"/);
  });

  test("an audienceIndividuals map nested DEEP is rejected", async () => {
    const { profileId, ctx, sections } = await profileForValidation("ac03-individuals");
    await expect(
      attempt(
        profileId,
        ctx,
        withExtra(sections, (d) => {
          d.restrictions = {
            ...(d.restrictions as Record<string, unknown>),
            compliance: {
              audit: { audienceIndividuals: { "u-1": { clicks: 3 } } },
            },
          };
        }),
      ),
    ).rejects.toThrow(/raw-audience-shaped field "audienceIndividuals"/);
  });

  // -----------------------------------------------------------------
  // The persisted record is structurally clean
  // -----------------------------------------------------------------

  test("a PERSISTED profile version contains no credential-shaped or raw-audience-shaped keys (deep scan)", async () => {
    const { profileId, ctx, sections } =
      await profileForValidation("ac03-persisted");
    await defineCreatorProfileVersion(harness, profileId, {
      sections,
      ctx,
    });
    // Re-fetch through the committed path.
    const persisted = await harness.runtime.creatorService.getProfileVersion(
      ctx,
      profileId,
      1,
    );
    const credentialRe = new RegExp(
      CREDENTIAL_KEY_FRAGMENTS.map((f) => f.replace(/[-]/g, "[-_]?")).join("|"),
      "i",
    );
    const rawAudienceRe = new RegExp(
      RAW_AUDIENCE_KEY_FRAGMENTS.map((f) => f.replace(/[-]/g, "[-_]?")).join(
        "|",
      ),
      "i",
    );
    const offenders: string[] = [];
    const scan = (value: unknown, path: string): void => {
      if (Array.isArray(value)) {
        value.forEach((entry, i) => scan(entry, `${path}[${String(i)}]`));
        return;
      }
      if (value !== null && typeof value === "object") {
        for (const [k, child] of Object.entries(value)) {
          if (credentialRe.test(k) || rawAudienceRe.test(k)) {
            offenders.push(`${path}.${k}`);
          }
          scan(child, `${path}.${k}`);
        }
      }
    };
    scan(persisted.sections, "sections");
    expect(offenders).toEqual([]);
    // The audience section is aggregates ONLY.
    expect(Object.keys(persisted.sections.audience).sort()).toEqual([
      "ageDistribution",
      "engagementBand",
      "sizeBand",
      "topGeographies",
    ]);
  });

  test("the pure guards are exported from the core contracts and fail closed on unknown shapes", async () => {
    const { assertNoCredentialShapedKeys, assertNoRawAudienceKeys } =
      await import("../../src/core/creators.ts");
    // Benign shapes pass.
    expect(() =>
      assertNoCredentialShapedKeys({ a: { b: [{ c: 1 }] } }),
    ).not.toThrow();
    expect(() =>
      assertNoRawAudienceKeys({ audience: { sizeBand: "1k_10k" } }),
    ).not.toThrow();
    // Credential shapes fail (several fragments).
    for (const field of [
      "token",
      "secret",
      "apiKey",
      "password",
      "privateKey",
      "credential",
    ]) {
      expect(() =>
        assertNoCredentialShapedKeys({ nested: { [field]: "x" } }),
      ).toThrow(/credential-shaped/);
    }
    // Raw-audience shapes fail.
    for (const field of ["members", "emails", "individuals", "deviceIds"]) {
      expect(() =>
        assertNoRawAudienceKeys({ audience: { [field]: [] } }),
      ).toThrow(/raw-audience-shaped/);
    }
  });

  test("the platform connection type exposes only reference fields (structural source pin)", async () => {
    const fs = await import("node:fs/promises");
    const content = await fs.readFile(
      new URL("../../src/creators/port.ts", import.meta.url),
      "utf8",
    );
    const region = content.slice(
      content.indexOf("export interface CreatorPlatformConnection"),
      content.indexOf("export interface CreatorAudienceAggregate"),
    );
    // The FIELD NAMES are the contract (comments may legitimately
    // say "never a secret" — the fields may not BE one).
    const fields = [...region.matchAll(/readonly\s+(\w+):/g)].map(
      (m) => m[1]!,
    );
    expect(fields).toEqual([
      "platformKind",
      "handle",
      "displayName",
      "profileUrl",
      "capabilities",
      "languages",
    ]);
    for (const field of fields) {
      expect(field).not.toMatch(
        /token|secret|credential|oauth|password|apikey|auth|refresh|key/i,
      );
      expect(field).not.toMatch(
        /member|email|individual|person|user|contact|address|device|record/i,
      );
    }
  });
});
