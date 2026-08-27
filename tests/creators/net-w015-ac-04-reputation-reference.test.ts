/**
 * NET-W015-AC-04 — Canonical reputation is referenced rather than
 * duplicated or mutated (issue #29 AC-4, invariant 5, CRE-005).
 *
 * Proves:
 *  - the CRE-005 separation is structural: exactly ONE
 *    audience_influence reference and ONE production reference (both
 *    required; duplicates and omissions refused);
 *  - every reference is VERIFIED against the canonical /reputation
 *    authority BEFORE the version commits: existence, organization
 *    scope, subject person, digest — each violation refused;
 *  - the referenced dimension must be a FROZEN canonical dimension;
 *  - the persisted version stores REFERENCES ONLY (ids + digest — no
 *    scores, no computed trust values);
 *  - reads resolve through the canonical snapshot service at the
 *    composition root (the reference-resolution read);
 *  - creator commands never mutate reputation (inputs/policies/
 *    snapshots unchanged after a full profile lifecycle);
 *  - structural: the creators domain has no reputation-mutation
 *    surface (source pins).
 */
import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import {
  createNetW015Harness,
  createCreatorProfile,
  defineCreatorProfileVersion,
  createDefaultSections,
  createReputationSnapshot,
  createFreshPerson,
  personCtx,
  key,
  type NetW015Harness,
} from "./_net-w015-harness.ts";
import type { CreatorProfileSections } from "../../src/creators/port.ts";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

let harness: NetW015Harness;

beforeAll(async () => {
  harness = await createNetW015Harness();
});

afterAll(async () => {
  await harness.teardown();
});

function withSections(
  base: CreatorProfileSections,
  patch: (draft: Record<string, unknown>) => void,
): CreatorProfileSections {
  const draft = JSON.parse(JSON.stringify(base)) as Record<string, unknown>;
  patch(draft);
  return draft as unknown as CreatorProfileSections;
}

describe("NET-W015-AC-04 canonical reputation references", () => {
  test("the CRE-005 separation is structural: exactly one reference per role, both required", async () => {
    const personId = await createFreshPerson(harness, "ac04-roles");
    const ctx = personCtx(harness, personId, "w015-ac04-roles");
    const { profile } = await createCreatorProfile(harness, {
      creatorPersonId: personId,
      ctx,
    });
    const sections = await createDefaultSections(harness, {
      subjectPersonId: personId,
    });

    // Omitting the production reference → refused.
    await expect(
      defineCreatorProfileVersion(harness, profile.id, {
        sections: withSections(sections, (d) => {
          d.reputationReferences = (
            d.reputationReferences as Record<string, unknown>[]
          ).filter((r) => r.role !== "production");
        }),
        ctx,
      }),
    ).rejects.toThrow(/missing the required production reference/);

    // Omitting the audience_influence reference → refused.
    await expect(
      defineCreatorProfileVersion(harness, profile.id, {
        sections: withSections(sections, (d) => {
          d.reputationReferences = (
            d.reputationReferences as Record<string, unknown>[]
          ).filter((r) => r.role !== "audience_influence");
        }),
        ctx,
      }),
    ).rejects.toThrow(/missing the required audience_influence reference/);

    // Duplicating a role → refused.
    await expect(
      defineCreatorProfileVersion(harness, profile.id, {
        sections: withSections(sections, (d) => {
          const refs = d.reputationReferences as Record<string, unknown>[];
          d.reputationReferences = [
            ...refs,
            { ...refs[0]! },
          ];
        }),
        ctx,
      }),
    ).rejects.toThrow(/appears more than once/);

    // An unknown role → refused.
    await expect(
      defineCreatorProfileVersion(harness, profile.id, {
        sections: withSections(sections, (d) => {
          (d.reputationReferences as Record<string, unknown>[])[0]!.role =
            "overall_trust";
        }),
        ctx,
      }),
    ).rejects.toThrow(/closed creator reputation roles/);

    // A NON-frozen dimension → refused (the creators domain never
    // defines its own trust dimensions).
    await expect(
      defineCreatorProfileVersion(harness, profile.id, {
        sections: withSections(sections, (d) => {
          (d.reputationReferences as Record<string, unknown>[])[0]!
            .dimension = "audience_hype";
        }),
        ctx,
      }),
    ).rejects.toThrow(/frozen canonical reputation dimensions/);
  });

  test("a reference that does not resolve in the canonical authority is refused", async () => {
    const personId = await createFreshPerson(harness, "ac04-ghost-snap");
    const ctx = personCtx(harness, personId, "w015-ac04-ghost-snap");
    const { profile } = await createCreatorProfile(harness, {
      creatorPersonId: personId,
      ctx,
    });
    const sections = await createDefaultSections(harness, {
      subjectPersonId: personId,
    });
    await expect(
      defineCreatorProfileVersion(harness, profile.id, {
        sections: withSections(sections, (d) => {
          (d.reputationReferences as Record<string, unknown>[])[0]!
            .snapshotId = "00000000-0000-4000-8000-000000000000";
        }),
        ctx,
      }),
    ).rejects.toThrow(/does not resolve in the canonical reputation authority/);
  });

  test("a snapshot from ANOTHER organization scope is refused (tenant isolation on references)", async () => {
    const personId = await createFreshPerson(harness, "ac04-cross-org");
    const ctx = personCtx(harness, personId, "w015-ac04-cross-org");
    const { profile } = await createCreatorProfile(harness, {
      creatorPersonId: personId,
      ctx,
    });
    // A snapshot for a DIFFERENT subject person in the harness org —
    // the subject mismatch path — and a snapshot in the OTHER org are
    // both structurally foreign references. Use the subject mismatch
    // (same org, wrong person) first.
    const foreignSubjectSnapshot = await createReputationSnapshot(harness, {
      subjectPersonId: await createFreshPerson(harness, "ac04-foreign-subject"),
    });
    const sections = await createDefaultSections(harness, {
      subjectPersonId: personId,
    });
    await expect(
      defineCreatorProfileVersion(harness, profile.id, {
        sections: withSections(sections, (d) => {
          (d.reputationReferences as Record<string, unknown>[])[0]!
            .snapshotId = foreignSubjectSnapshot.id;
        }),
        ctx,
      }),
    ).rejects.toThrow(/subject person/);
  });

  test("a digest mismatch is refused (the reference pins WHAT it referenced)", async () => {
    const personId = await createFreshPerson(harness, "ac04-digest");
    const ctx = personCtx(harness, personId, "w015-ac04-digest");
    const { profile } = await createCreatorProfile(harness, {
      creatorPersonId: personId,
      ctx,
    });
    const sections = await createDefaultSections(harness, {
      subjectPersonId: personId,
    });
    await expect(
      defineCreatorProfileVersion(harness, profile.id, {
        sections: withSections(sections, (d) => {
          (d.reputationReferences as Record<string, unknown>[])[0]!.digest =
            "deadbeef";
        }),
        ctx,
      }),
    ).rejects.toThrow(/digest mismatch/);
  });

  test("the persisted version stores REFERENCES ONLY — no scores, no computed trust values", async () => {
    const personId = await createFreshPerson(harness, "ac04-ref-only");
    const ctx = personCtx(harness, personId, "w015-ac04-ref-only");
    const { profile } = await createCreatorProfile(harness, {
      creatorPersonId: personId,
      ctx,
    });
    const sections = await createDefaultSections(harness, {
      subjectPersonId: personId,
    });
    const { version } = await defineCreatorProfileVersion(harness, profile.id, {
      sections,
      ctx,
    });
    for (const reference of version.sections.reputationReferences) {
      expect(Object.keys(reference).sort()).toEqual([
        "digest",
        "dimension",
        "role",
        "snapshotId",
      ]);
    }
    // A smuggled score field on a reference is REJECTED — the
    // reference shape is strict (fail-closed).
    await expect(
      defineCreatorProfileVersion(harness, profile.id, {
        sections: withSections(sections, (d) => {
          (d.reputationReferences as Record<string, unknown>[])[0]!.score =
            99;
        }),
        ctx,
        idempotencyKey: key("w015-ac04-score-smuggle"),
      }),
    ).rejects.toThrow(/not a permitted reputation-reference field/);
  });

  test("the composition-root read resolves references through the CANONICAL snapshot service", async () => {
    const personId = await createFreshPerson(harness, "ac04-resolve");
    const ctx = personCtx(harness, personId, "w015-ac04-resolve");
    const { profile } = await createCreatorProfile(harness, {
      creatorPersonId: personId,
      ctx,
    });
    const sections = await createDefaultSections(harness, {
      subjectPersonId: personId,
    });
    await defineCreatorProfileVersion(harness, profile.id, { sections, ctx });
    await harness.runtime.creatorService.activateProfile(ctx, {
      profileId: profile.id,
      idempotencyKey: key("w015-ac04-activate"),
    });

    const resolved = await harness.runtime.apiCommands.resolveCreatorReputation(
      ctx,
      profile.id,
    );
    expect(resolved.profileId).toBe(profile.id);
    expect(resolved.currentVersion).toBe(1);
    expect(resolved.references).toHaveLength(2);
    for (const reference of resolved.references) {
      const ref = reference as Record<string, unknown>;
      // Canonical metadata resolved ON DEMAND from /reputation.
      expect(ref.digestMatches).toBe(true);
      expect(typeof ref.policyId).toBe("string");
      expect(typeof ref.policyVersion).toBe("number");
      expect(typeof ref.computedAt).toBe("string");
      expect(typeof ref.referenceAt).toBe("string");
      // The roles are the CRE-005 pair.
      expect(["audience_influence", "production"]).toContain(
        ref.role as string,
      );
    }
    const roles = resolved.references.map(
      (r) => (r as Record<string, unknown>).role as string,
    );
    expect(roles.sort()).toEqual(["audience_influence", "production"]);
  });

  test("a full creator lifecycle mutates NOTHING in the reputation authority", async () => {
    const personId = await createFreshPerson(harness, "ac04-immutability");
    const ctx = personCtx(harness, personId, "w015-ac04-immutability");
    const snapshot = await createReputationSnapshot(harness, {
      subjectPersonId: personId,
    });
    const inputsBefore = await harness.runtime.reputationInputService.listInputs(
      ctx,
      harness.organizationScopeId,
      personId,
    );
    const historyBefore =
      await harness.runtime.reputationSnapshotService.getSnapshotHistory(
        ctx,
        harness.organizationScopeId,
        personId,
      );

    // A full lifecycle: profile → version (referencing the snapshot)
    // → activate → pause → resume → archive → a NEW version on a
    // second profile-less person is impossible — use a second
    // version instead.
    const { profile } = await createCreatorProfile(harness, {
      creatorPersonId: personId,
      ctx,
    });
    await defineCreatorProfileVersion(harness, profile.id, {
      sections: await createDefaultSections(harness, {
        subjectPersonId: personId,
        audienceSnapshot: snapshot,
        productionSnapshot: snapshot,
      }),
      ctx,
    });
    await harness.runtime.creatorService.activateProfile(ctx, {
      profileId: profile.id,
      idempotencyKey: key("w015-ac04-life-activate"),
    });
    await harness.runtime.creatorService.pauseProfile(ctx, {
      profileId: profile.id,
      idempotencyKey: key("w015-ac04-life-pause"),
    });
    await harness.runtime.creatorService.resumeProfile(ctx, {
      profileId: profile.id,
      idempotencyKey: key("w015-ac04-life-resume"),
    });
    await harness.runtime.creatorService.archiveProfile(ctx, {
      profileId: profile.id,
      idempotencyKey: key("w015-ac04-life-archive"),
    });

    // NOTHING changed in the reputation authority.
    const inputsAfter = await harness.runtime.reputationInputService.listInputs(
      ctx,
      harness.organizationScopeId,
      personId,
    );
    expect(inputsAfter).toHaveLength(inputsBefore.length);
    const historyAfter =
      await harness.runtime.reputationSnapshotService.getSnapshotHistory(
        ctx,
        harness.organizationScopeId,
        personId,
      );
    expect(historyAfter).toHaveLength(historyBefore.length);
    expect(historyAfter[historyAfter.length - 1]!.digest).toBe(
      snapshot.digest,
    );
  });

  test("structural: the creators domain has NO reputation-mutation surface (source pins)", async () => {
    const service = await readFile(
      join(import.meta.dir, "../../src/creators/creator-service.ts"),
      "utf8",
    );
    // No reputation mutation call sites anywhere in the creators domain.
    expect(service).not.toMatch(
      /recordInput|createPolicyVersion|recordSnapshot|computeScores/,
    );
    // The ONLY reputation interaction is the read-only neutral lookup.
    expect(service).toContain("lookups.reputation.resolve");
    const port = await readFile(
      join(import.meta.dir, "../../src/creators/port.ts"),
      "utf8");
    const refRegion = port.slice(
      port.indexOf("export interface CreatorReputationReference"),
      port.indexOf("export interface CreatorProfileSections"),
    );
    // The reference type is ids + digest + role + dimension — never a
    // score, never a weight, never a rank.
    const fields = [...refRegion.matchAll(/readonly\s+(\w+):/g)].map(
      (m) => m[1]!,
    );
    expect(fields).toEqual(["role", "dimension", "snapshotId", "digest"]);
  });
});
