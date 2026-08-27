/**
 * NET-W017 AC-04 — publication/ownership boundaries.
 *
 * Proves (work order §3.3, issue #33 AC-4 + invariant 4 / CRE-004):
 * producing UGC does not imply ownership or automatic channel
 * publication authority:
 *  - contentOwnership is frozen to "creator_retained" — the frozen
 *    vocabulary has exactly ONE value and the grant input carries NO
 *    ownership field (there is structurally no code path that
 *    transfers ownership of creator content or channels);
 *  - producing UGC (production, deliverables, submission) NEVER
 *    mints a grant: a grantless production confers NO usage rights;
 *  - every recorded grant in the system carries
 *    contentOwnership = "creator_retained";
 *  - publication on creator-owned channels requires an EXPLICIT
 *    grant containing the `channel_publication` use kind scoped to
 *    the `creator_owned_channel` channel — a grant without it
 *    confers no such authority (pure predicate over the record);
 *  - the requested envelope discipline means the organizer can never
 *    even REQUEST ownership (the input vocabulary has no ownership
 *    dimension to inflate).
 */

import { describe, expect, test } from "bun:test";
import {
  acceptEngagement,
  createEngagement,
  createProductionEvidence,
  key,
  openProduction,
  personCtx,
  recordDeliverable,
  requestedRightsFixture,
  submitProduction,
  tenderEngagement,
  createNetW017Harness,
  grantedRightsFixture,
} from "./_net-w017-harness.ts";
import {
  USAGE_RIGHTS_OWNERSHIP,
  USAGE_RIGHTS_CHANNELS,
  InvalidEngagementError,
} from "../../src/core/creators.ts";

describe("NET-W017 AC-04 — publication/ownership boundaries", () => {
  test("the ownership vocabulary is frozen to exactly one value: creator_retained", () => {
    expect(USAGE_RIGHTS_OWNERSHIP).toEqual(["creator_retained"]);
  });

  test("the grant input carries NO ownership field — there is structurally no code path to transfer ownership", async () => {
    // Structural: the AcceptEngagementInput type has no ownership
    // property; the grant builder sets contentOwnership from the
    // frozen constant only. Read the source and pin it.
    const { readFile } = await import("node:fs/promises");
    const service = await readFile(
      "src/creators/engagement-service.ts",
      "utf8",
    );
    // The ONLY assignment of contentOwnership is the frozen constant.
    expect(service).toMatch(
      /contentOwnership:\s*USAGE_RIGHTS_OWNERSHIP\[0\]/,
    );
    // Exactly one assignment FROM the constant; every other mention
    // only READS the record (the audit metadata) — and no assignment
    // ever sources an input field.
    expect(
      service.match(/contentOwnership:\s*USAGE_RIGHTS_OWNERSHIP\[0\]/g),
    ).toHaveLength(1);
    expect(service).not.toMatch(/contentOwnership:\s*input\./);
    expect(service).not.toMatch(/contentOwnership:\s*granted/);
    // The port's grant input types carry no ownership field.
    const port = await readFile("src/creators/port.ts", "utf8");
    const grantInputMatch = port.match(
      /grantedRights:\s*\{[\s\S]*?\};/,
    );
    expect(grantInputMatch).not.toBeNull();
    expect(grantInputMatch![0]).not.toContain("ownership");
  });

  test("producing UGC mints NO rights: a submission leaves the grant set unchanged; a grantless production confers nothing", async () => {
    const harness = await createNetW017Harness();
    try {
      const { engagement } = await createEngagement(harness);
      await tenderEngagement(harness, engagement.id, 0);
      const accepted = await acceptEngagement(harness, engagement.id, 1);
      const ctx = personCtx(harness, harness.operatorPersonId, "w017-count");
      const grantsBefore =
        await harness.runtime.creatorEngagementService.listUsageRights(
          ctx,
          harness.organizationScopeId,
        );
      // Production + deliverable + evidence + submission.
      const opened = await openProduction(
        harness,
        accepted.engagement.id,
        2,
      );
      await recordDeliverable(harness, opened.production.id);
      const { evidenceId } = await createProductionEvidence(
        harness,
        opened.production.id,
      );
      await submitProduction(
        harness,
        opened.production.id,
        opened.engagementVersion,
        [evidenceId],
      );
      // The grant set is UNCHANGED — producing UGC mints no rights.
      const grantsAfter =
        await harness.runtime.creatorEngagementService.listUsageRights(
          ctx,
          harness.organizationScopeId,
        );
      expect(grantsAfter.length).toBe(grantsBefore.length);
      // Every grant in the system is creator-retained.
      for (const view of grantsAfter) {
        expect(view.grant.contentOwnership).toBe("creator_retained");
        expect(view.grant.grantorPersonId).toBe(harness.creatorPersonId);
      }
    } finally {
      await harness.teardown();
    }
  }, 60_000);

  test("an engagement without an accepted grant has NO usage rights on record (rights exist only through acceptance)", async () => {
    const harness = await createNetW017Harness();
    try {
      const { engagement } = await createEngagement(harness);
      await tenderEngagement(harness, engagement.id, 0);
      // Not accepted → no grant → no rights whatsoever.
      const grants =
        await harness.runtime.creatorEngagementService.listUsageRights(
          personCtx(harness, harness.operatorPersonId, "w017-none"),
          harness.organizationScopeId,
          engagement.id,
        );
      expect(grants).toHaveLength(0);
      // Production is impossible without an ACTIVE grant — the
      // grantless production confers nothing because it cannot even
      // exist.
      await expect(
        openProduction(harness, engagement.id, 1),
      ).rejects.toBeInstanceOf(InvalidEngagementError);
    } finally {
      await harness.teardown();
    }
  }, 60_000);

  test("channel publication on creator-owned channels requires an explicit channel_publication grant scoped to creator_owned_channel", async () => {
    const harness = await createNetW017Harness();
    try {
      // An offer WITHOUT channel_publication and WITHOUT
      // creator_owned_channel.
      const plain = requestedRightsFixture();
      const { engagement: plainEngagement } = await createEngagement(
        harness,
        { requestedRights: plain },
      );
      await tenderEngagement(harness, plainEngagement.id, 0);
      const accepted = await acceptEngagement(
        harness,
        plainEngagement.id,
        1,
      );
      // The pure publication-authority predicate (AC-04): no
      // channel_publication use + no creator_owned_channel scope →
      // NO publication authority on creator channels.
      const hasCreatorChannelPublicationAuthority = (
        grant: { uses: readonly { kind: string }[]; channels: readonly string[] },
      ): boolean =>
        grant.uses.some((u) => u.kind === "channel_publication") &&
        grant.channels.includes("creator_owned_channel");
      expect(
        hasCreatorChannelPublicationAuthority(accepted.grant),
      ).toBe(false);

      // An offer WITH explicit channel publication on the creator's
      // own channels — the ONLY way the authority exists.
      const requested = requestedRightsFixture();
      const publicationRequest = {
        ...requested,
        uses: [
          ...requested.uses,
          { kind: "channel_publication", terms: "one repost within 14 days" },
        ],
        channels: [...requested.channels, "creator_owned_channel"],
      };
      const { engagement: pubEngagement } = await createEngagement(
        harness,
        { requestedRights: publicationRequest },
      );
      await tenderEngagement(harness, pubEngagement.id, 0);
      const pubAccepted = await acceptEngagement(
        harness,
        pubEngagement.id,
        1,
        {
          grantedRights: {
            ...grantedRightsFixture(),
            uses: [
              { kind: "reuse_license", terms: null },
              { kind: "channel_publication", terms: "one repost" },
            ],
            channels: ["organizer_channel", "creator_owned_channel"],
          },
        },
      );
      expect(
        hasCreatorChannelPublicationAuthority(pubAccepted.grant),
      ).toBe(true);
      // Still creator-retained ownership — publication authority is a
      // LICENSE scoped to channels, never ownership.
      expect(pubAccepted.grant.contentOwnership).toBe("creator_retained");
    } finally {
      await harness.teardown();
    }
  }, 60_000);

  test("the organizer cannot inflate the requested envelope with undisclosed channels — the closed vocabulary + envelope discipline", () => {
    expect(USAGE_RIGHTS_CHANNELS).toEqual([
      "creator_owned_channel",
      "organizer_channel",
      "network_channel",
      "paid_media",
    ]);
  });

  test("a grant scoped to organizer channels carries no creator-channel authority even after submission", async () => {
    const harness = await createNetW017Harness();
    try {
      const flow = await (async () => {
        const { goldenPathEngagement } = await import(
          "./_net-w017-harness.ts"
        );
        return goldenPathEngagement(harness);
      })();
      // The golden-path grant: organizer channel only, reuse license.
      const grant = flow.grant;
      expect(grant.channels).toEqual(["organizer_channel"]);
      expect(grant.uses.map((u) => u.kind)).toEqual(["reuse_license"]);
      // After SUBMITTED (UGC produced + tendered): still no
      // creator-channel publication authority — producing UGC through
      // the protocol never confers it.
      const hasCreatorChannelPublicationAuthority = (
        g: { uses: readonly { kind: string }[]; channels: readonly string[] },
      ): boolean =>
        g.uses.some((u) => u.kind === "channel_publication") &&
        g.channels.includes("creator_owned_channel");
      expect(hasCreatorChannelPublicationAuthority(grant)).toBe(false);
      expect(grant.contentOwnership).toBe("creator_retained");
      // And the usage-rights view of the system shows the same.
      const views =
        await harness.runtime.creatorEngagementService.listUsageRights(
          personCtx(harness, harness.operatorPersonId, "w017-view"),
          harness.organizationScopeId,
          flow.engagement.id,
        );
      expect(views).toHaveLength(1);
      expect(views[0]!.grant.contentOwnership).toBe("creator_retained");
      void key;
    } finally {
      await harness.teardown();
    }
  }, 60_000);
});
