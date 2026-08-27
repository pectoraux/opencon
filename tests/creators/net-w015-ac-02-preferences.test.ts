/**
 * NET-W015-AC-02 — Connected platforms, audience metadata, commercial
 * preferences, rights, restrictions, and availability are represented
 * explicitly and provider-neutrally (issue #29 AC-2, CRE-001).
 *
 * Proves:
 *  - ALL eight sections round-trip exactly through the immutable
 *    versioned record (deep equality — nothing silently drops);
 *  - version monotonicity + the current-version pointer + immutable
 *    history (v1 unchanged after v2/v3);
 *  - idempotent replay of a version definition;
 *  - closed-vocabulary + shape validation (platforms, formats,
 *    languages, territories, currencies, rate bounds, aggregate
 *    shares, availability/participation bounds, duplicate rules).
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

let harness: NetW015Harness;

beforeAll(async () => {
  harness = await createNetW015Harness();
});

afterAll(async () => {
  await harness.teardown();
});

/** A profile + a first version, returning the persisted sections. */
async function profileWithVersion(
  label: string,
): Promise<{
  personId: string;
  profileId: string;
  ctx: ReturnType<typeof personCtx>;
  sections: CreatorProfileSections;
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
  await defineCreatorProfileVersion(harness, profile.id, {
    sections,
    subjectPersonId: personId,
    ctx,
  });
  return { personId, profileId: profile.id, ctx, sections };
}

/** Clone sections with a deep-ish mutation applied. */
function withSections(
  base: CreatorProfileSections,
  patch: (draft: Record<string, unknown>) => void,
): Record<string, unknown> {
  const draft = JSON.parse(JSON.stringify(base)) as Record<string, unknown>;
  patch(draft);
  return draft;
}

describe("NET-W015-AC-02 explicit provider-neutral sections", () => {
  test("ALL eight sections round-trip exactly through the persisted version", async () => {
    const { profileId, ctx, sections } = await profileWithVersion("ac02-roundtrip");
    const persisted = await harness.runtime.creatorService.getProfileVersion(
      ctx,
      profileId,
      1,
    );
    expect(persisted.sections).toEqual(sections);
    // Section-by-section pins (the shape is the contract):
    expect(Object.keys(persisted.sections).sort()).toEqual([
      "audience",
      "availability",
      "commercial",
      "participation",
      "platforms",
      "reputationReferences",
      "restrictions",
      "rights",
    ]);
    expect(persisted.sections.platforms).toHaveLength(2);
    expect(persisted.sections.platforms[0]!.platformKind).toBe("video");
    expect(persisted.sections.platforms[0]!.capabilities).toEqual([
      "short_video",
      "long_video",
    ]);
    expect(persisted.sections.audience.sizeBand).toBe("10k_100k");
    expect(persisted.sections.audience.topGeographies).toEqual([
      { territory: "GH", share: 40 },
      { territory: "NG", share: 25 },
    ]);
    expect(persisted.sections.commercial.rates).toHaveLength(3);
    expect(persisted.sections.rights.map((r) => r.kind)).toEqual([
      "channel_publication",
      "paid_amplification",
    ]);
    expect(persisted.sections.restrictions.restrictedTopics).toEqual([
      "gambling",
      "adult",
    ]);
    expect(persisted.sections.restrictions.requiresDisclosure).toBe(true);
    expect(persisted.sections.availability).toEqual({
      acceptingWork: true,
      weeklyCapacity: 3,
      minimumNoticeDays: 7,
    });
    expect(persisted.sections.participation).toEqual({
      acceptsDirectCampaigns: true,
      requiresInvitation: false,
    });
    expect(persisted.sections.reputationReferences.map((r) => r.role)).toEqual(
      ["audience_influence", "production"],
    );
  });

  test("versions are monotonic, immutable and the current-version pointer follows", async () => {
    const personId = await createFreshPerson(harness, "ac02-versions");
    const ctx = personCtx(harness, personId, "w015-ac02-versions");
    const { profile } = await createCreatorProfile(harness, {
      creatorPersonId: personId,
      ctx,
    });
    const v1Sections = await createDefaultSections(harness, {
      subjectPersonId: personId,
    });
    const { version: v1 } = await defineCreatorProfileVersion(
      harness,
      profile.id,
      { sections: v1Sections, subjectPersonId: personId, ctx },
    );
    expect(v1.version).toBe(1);

    // v2: a changed rate (everything else identical).
    const v2Sections = JSON.parse(
      JSON.stringify(v1Sections),
    ) as unknown as CreatorProfileSections;
    ((v2Sections.commercial.rates[0] as Record<string, unknown>).amount as number) = 999;
    const { version: v2, created: created2 } =
      await defineCreatorProfileVersion(harness, profile.id, {
        sections: v2Sections,
        subjectPersonId: personId,
        ctx,
      });
    expect(created2).toBe(true);
    expect(v2.version).toBe(2);

    // v3: availability change.
    const v3Sections = JSON.parse(
      JSON.stringify(v2Sections),
    ) as unknown as CreatorProfileSections;
    (
      (v3Sections.availability as unknown as Record<string, unknown>)
        .acceptingWork as boolean
    ) = false;
    const { version: v3 } = await defineCreatorProfileVersion(
      harness,
      profile.id,
      { sections: v3Sections, subjectPersonId: personId, ctx },
    );
    expect(v3.version).toBe(3);

    // The pointer follows; the lineage lists 1..3.
    const profileNow = await harness.runtime.creatorService.getProfile(
      ctx,
      profile.id,
    );
    expect(profileNow.currentVersion).toBe(3);
    const lineage = await harness.runtime.creatorService.listProfileVersions(
      ctx,
      profile.id,
    );
    expect(lineage.map((v) => v.version)).toEqual([1, 2, 3]);

    // v1 is IMMUTABLE: the persisted v1 still carries the original
    // rate; nothing from v2/v3 leaked backwards.
    const persistedV1 = await harness.runtime.creatorService.getProfileVersion(
      ctx,
      profile.id,
      1,
    );
    expect(persistedV1.sections.commercial.rates[0]!.amount).toBe(750.5);
    expect(persistedV1.sections.availability.acceptingWork).toBe(true);
    expect(persistedV1.id).toBe(v1.id);
  });

  test("an idempotent version-definition replay returns created: false and the SAME version", async () => {
    const personId = await createFreshPerson(harness, "ac02-replay");
    const ctx = personCtx(harness, personId, "w015-ac02-replay");
    const { profile } = await createCreatorProfile(harness, {
      creatorPersonId: personId,
      ctx,
    });
    const idem = key("w015-ac02-version");
    const sections = await createDefaultSections(harness, {
      subjectPersonId: personId,
    });
    const first = await defineCreatorProfileVersion(harness, profile.id, {
      sections,
      subjectPersonId: personId,
      ctx,
      idempotencyKey: idem,
    });
    const second = await defineCreatorProfileVersion(harness, profile.id, {
      sections,
      subjectPersonId: personId,
      ctx,
      idempotencyKey: idem,
    });
    expect(second.created).toBe(false);
    expect(second.version.id).toBe(first.version.id);
    expect(second.version.version).toBe(1);
    // Still exactly one version in the lineage.
    const lineage = await harness.runtime.creatorService.listProfileVersions(
      ctx,
      profile.id,
    );
    expect(lineage).toHaveLength(1);
  });

  // -----------------------------------------------------------------
  // Closed-vocabulary + shape validation
  // -----------------------------------------------------------------

  test("platform validation: closed kinds, https URLs, duplicate-kind refusal, closed formats, language tags", async () => {
    const { profileId, ctx, sections } = await profileWithVersion("ac02-platform");
    const bad = withSections(sections, (d) => {
      (d.platforms as Record<string, unknown>[])[0]!.platformKind = "tiktok";
    });
    await expect(
      defineCreatorProfileVersion(harness, profileId, {
        sections: bad as unknown as CreatorProfileSections,
        ctx,
      }),
    ).rejects.toThrow(/platformKind/);

    const badUrl = withSections(sections, (d) => {
      (d.platforms as Record<string, unknown>[])[0]!.profileUrl =
        "http://insecure.example.com/creator";
    });
    await expect(
      defineCreatorProfileVersion(harness, profileId, {
        sections: badUrl as unknown as CreatorProfileSections,
        ctx,
      }),
    ).rejects.toThrow(/https URL/);

    const dupKind = withSections(sections, (d) => {
      (d.platforms as Record<string, unknown>[])[1]!.platformKind = "video";
    });
    await expect(
      defineCreatorProfileVersion(harness, profileId, {
        sections: dupKind as unknown as CreatorProfileSections,
        ctx,
      }),
    ).rejects.toThrow(/appears more than once/);

    const badFormat = withSections(sections, (d) => {
      (d.platforms as Record<string, unknown>[])[0]!.capabilities = ["vlog"];
    });
    await expect(
      defineCreatorProfileVersion(harness, profileId, {
        sections: badFormat as unknown as CreatorProfileSections,
        ctx,
      }),
    ).rejects.toThrow(/closed vocabulary values/);

    const badLanguage = withSections(sections, (d) => {
      (d.platforms as Record<string, unknown>[])[0]!.languages = ["english"];
    });
    await expect(
      defineCreatorProfileVersion(harness, profileId, {
        sections: badLanguage as unknown as CreatorProfileSections,
        ctx,
      }),
    ).rejects.toThrow(/language tag/);

    // Empty platforms: a profile without a platform reference is not
    // matchable.
    const noPlatforms = withSections(sections, (d) => {
      d.platforms = [];
    });
    await expect(
      defineCreatorProfileVersion(harness, profileId, {
        sections: noPlatforms as unknown as CreatorProfileSections,
        ctx,
      }),
    ).rejects.toThrow(/at least one connected platform/);
  });

  test("audience validation: closed bands, share bounds, aggregate totals, geography limits", async () => {
    const { profileId, ctx, sections } = await profileWithVersion("ac02-audience");
    const badBand = withSections(sections, (d) => {
      (d.audience as Record<string, unknown>).sizeBand = "100k_200k";
    });
    await expect(
      defineCreatorProfileVersion(harness, profileId, {
        sections: badBand as unknown as CreatorProfileSections,
        ctx,
      }),
    ).rejects.toThrow(/sizeBand/);

    const badShare = withSections(sections, (d) => {
      (
        (d.audience as Record<string, unknown>).ageDistribution as Record<
          string,
          unknown
        >[]
      )[0]!.share = 140;
    });
    await expect(
      defineCreatorProfileVersion(harness, profileId, {
        sections: badShare as unknown as CreatorProfileSections,
        ctx,
      }),
    ).rejects.toThrow(/share between 0 and 100/);

    const overTotal = withSections(sections, (d) => {
      const dist = (
        (d.audience as Record<string, unknown>).ageDistribution as Record<
          string,
          unknown
        >[]
      ).slice();
      dist.push({ band: "45_54", share: 60 });
      (d.audience as Record<string, unknown>).ageDistribution = dist;
    });
    await expect(
      defineCreatorProfileVersion(harness, profileId, {
        sections: overTotal as unknown as CreatorProfileSections,
        ctx,
      }),
    ).rejects.toThrow(/must not exceed 100/);

    const tooManyGeo = withSections(sections, (d) => {
      (d.audience as Record<string, unknown>).topGeographies = [
        { territory: "GH", share: 10 },
        { territory: "NG", share: 10 },
        { territory: "KE", share: 10 },
        { territory: "ZA", share: 10 },
        { territory: "EG", share: 10 },
        { territory: "MA", share: 10 },
      ];
    });
    await expect(
      defineCreatorProfileVersion(harness, profileId, {
        sections: tooManyGeo as unknown as CreatorProfileSections,
        ctx,
      }),
    ).rejects.toThrow(/at most 5 entries/);

    const badTerritory = withSections(sections, (d) => {
      (d.audience as Record<string, unknown>).topGeographies = [
        { territory: "gh", share: 40 },
      ];
    });
    await expect(
      defineCreatorProfileVersion(harness, profileId, {
        sections: badTerritory as unknown as CreatorProfileSections,
        ctx,
      }),
    ).rejects.toThrow(/alpha-2 territory code/);

    const badAgeBand = withSections(sections, (d) => {
      (d.audience as Record<string, unknown>).ageDistribution = [
        { band: "20_29", share: 50 },
      ];
    });
    await expect(
      defineCreatorProfileVersion(harness, profileId, {
        sections: badAgeBand as unknown as CreatorProfileSections,
        ctx,
      }),
    ).rejects.toThrow(/age bands/);
  });

  test("commercial validation: closed formats/units, positive bounded amounts, currency codes, duplicate rates", async () => {
    const { profileId, ctx, sections } = await profileWithVersion("ac02-commercial");
    const zeroRate = withSections(sections, (d) => {
      (
        (d.commercial as Record<string, unknown>).rates as Record<
          string,
          unknown
        >[]
      )[0]!.amount = 0;
    });
    await expect(
      defineCreatorProfileVersion(harness, profileId, {
        sections: zeroRate as unknown as CreatorProfileSections,
        ctx,
      }),
    ).rejects.toThrow(/must be > 0/);

    const tooPrecise = withSections(sections, (d) => {
      (
        (d.commercial as Record<string, unknown>).rates as Record<
          string,
          unknown
        >[]
      )[0]!.amount = 10.1234567;
    });
    await expect(
      defineCreatorProfileVersion(harness, profileId, {
        sections: tooPrecise as unknown as CreatorProfileSections,
        ctx,
      }),
    ).rejects.toThrow(/at most 6 decimals/);

    const badUnit = withSections(sections, (d) => {
      (
        (d.commercial as Record<string, unknown>).rates as Record<
          string,
          unknown
        >[]
      )[0]!.unit = "per_impression";
    });
    await expect(
      defineCreatorProfileVersion(harness, profileId, {
        sections: badUnit as unknown as CreatorProfileSections,
        ctx,
      }),
    ).rejects.toThrow(/rate units/);

    const badCurrency = withSections(sections, (d) => {
      (
        (d.commercial as Record<string, unknown>).rates as Record<
          string,
          unknown
        >[]
      )[0]!.currency = "usd";
    });
    await expect(
      defineCreatorProfileVersion(harness, profileId, {
        sections: badCurrency as unknown as CreatorProfileSections,
        ctx,
      }),
    ).rejects.toThrow(/currency code/);

    const dupRate = withSections(sections, (d) => {
      (
        (d.commercial as Record<string, unknown>).rates as Record<
          string,
          unknown
        >[]
      )[1]!.format = "short_video";
    });
    await expect(
      defineCreatorProfileVersion(harness, profileId, {
        sections: dupRate as unknown as CreatorProfileSections,
        ctx,
      }),
    ).rejects.toThrow(/duplicates the declared rate/);

    const noRates = withSections(sections, (d) => {
      (d.commercial as Record<string, unknown>).rates = [];
    });
    await expect(
      defineCreatorProfileVersion(harness, profileId, {
        sections: noRates as unknown as CreatorProfileSections,
        ctx,
      }),
    ).rejects.toThrow(/at least one rate/);
  });

  test("rights/restrictions/availability/participation validation", async () => {
    const { profileId, ctx, sections } = await profileWithVersion("ac02-shapes");
    const badRight = withSections(sections, (d) => {
      (d.rights as Record<string, unknown>[])[0]!.kind = "eternal_ownership";
    });
    await expect(
      defineCreatorProfileVersion(harness, profileId, {
        sections: badRight as unknown as CreatorProfileSections,
        ctx,
      }),
    ).rejects.toThrow(/rights kinds/);

    const badRestrictedFormat = withSections(sections, (d) => {
      (d.restrictions as Record<string, unknown>).restrictedFormats = ["vlog"];
    });
    await expect(
      defineCreatorProfileVersion(harness, profileId, {
        sections: badRestrictedFormat as unknown as CreatorProfileSections,
        ctx,
      }),
    ).rejects.toThrow(/closed vocabulary values/);

    const badNotice = withSections(sections, (d) => {
      (d.availability as Record<string, unknown>).minimumNoticeDays = 400;
    });
    await expect(
      defineCreatorProfileVersion(harness, profileId, {
        sections: badNotice as unknown as CreatorProfileSections,
        ctx,
      }),
    ).rejects.toThrow(/minimumNoticeDays/);

    const badCapacity = withSections(sections, (d) => {
      (d.availability as Record<string, unknown>).weeklyCapacity = 2.5;
    });
    await expect(
      defineCreatorProfileVersion(harness, profileId, {
        sections: badCapacity as unknown as CreatorProfileSections,
        ctx,
      }),
    ).rejects.toThrow(/weeklyCapacity/);

    const badParticipation = withSections(sections, (d) => {
      (d.participation as Record<string, unknown>).acceptsDirectCampaigns =
        "yes";
    });
    await expect(
      defineCreatorProfileVersion(harness, profileId, {
        sections: badParticipation as unknown as CreatorProfileSections,
        ctx,
      }),
    ).rejects.toThrow(/acceptsDirectCampaigns/);
  });
});
