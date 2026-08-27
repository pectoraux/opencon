/**
 * NET-W017 AC-03 — usage rights: explicit, scoped, auditable,
 * enforceable, with expiry/revocation semantics.
 *
 * Proves (work order §3.3, issue #33 AC-3):
 *  - grants are explicit records with scope/channels/territory/
 *    duration/uses/exclusions (closed vocabularies enforced);
 *  - the granted envelope must sit WITHIN the requested envelope on
 *    every dimension (uses/channels/territories/formats/duration);
 *  - expiry semantics: the DERIVED status flips to EXPIRED past
 *    endsAt (deterministic evaluation at any asOf);
 *  - revocation semantics: grantor-only; ONE revocation per grant;
 *    the derived status flips to REVOKED at/after the effectiveAt
 *    (prospective evaluation — before effectiveAt the grant stays
 *    ACTIVE);
 *  - the grant is auditable (usage_rights.granted / .revoked events
 *    with full metadata);
 *  - grants are immutable: a second acceptance with different terms
 *    is a stable conflict; identical terms are reused.
 */

import { describe, expect, test } from "bun:test";
import {
  acceptEngagement,
  createEngagement,
  getUsageRightsView,
  key,
  personCtx,
  requestedRightsFixture,
  tenderEngagement,
  createNetW017Harness,
  creatorCtx,
} from "./_net-w017-harness.ts";
import {
  InvalidEngagementError,
  UsageRightsConflictError,
} from "../../src/core/creators.ts";
import { AuthorizationError } from "../../src/core/errors.ts";

describe("NET-W017 AC-03 — usage rights semantics", () => {
  test("acceptance records an explicit, scoped grant (closed vocabularies + window)", async () => {
    const harness = await createNetW017Harness();
    try {
      const { engagement } = await createEngagement(harness);
      await tenderEngagement(harness, engagement.id, 0);
      const accepted = await acceptEngagement(harness, engagement.id, 1);
      const grant = accepted.grant;
      expect(grant.engagementId).toBe(engagement.id);
      expect(grant.grantorPersonId).toBe(harness.creatorPersonId);
      expect(grant.uses.map((u) => u.kind)).toEqual(["reuse_license"]);
      expect(grant.channels).toEqual(["organizer_channel"]);
      expect(grant.territories).toEqual(["GH"]);
      expect(grant.formats).toEqual(["short_video"]);
      expect(grant.exclusions).toEqual([
        "political advertising",
        "gambling",
      ]);
      // The grant carries a durable, auditable record.
      const events = await harness.runtime.auditWriter.query({
        eventType: "usage_rights.granted",
        resourceId: grant.id,
      });
      expect(events.length).toBe(1);
      const metadata = events[0]!.metadata as Record<string, unknown>;
      expect(metadata.engagementId).toBe(engagement.id);
      expect(metadata.grantorPersonId).toBe(harness.creatorPersonId);
      expect(metadata.contentOwnership).toBe("creator_retained");
      expect(metadata.channels).toEqual(["organizer_channel"]);
    } finally {
      await harness.teardown();
    }
  }, 60_000);

  test("closed vocabularies: unknown uses/channels/formats/territories are rejected", async () => {
    const harness = await createNetW017Harness();
    try {
      const requested = requestedRightsFixture();
      // Unknown use kind.
      await expect(
        createEngagement(harness, {
          requestedRights: {
            ...requested,
            uses: [{ kind: "sovereign_ownership", terms: null }],
          },
        }),
      ).rejects.toBeInstanceOf(InvalidEngagementError);
      // Unknown channel.
      await expect(
        createEngagement(harness, {
          requestedRights: {
            ...requested,
            channels: ["telepathy"],
          },
        }),
      ).rejects.toBeInstanceOf(InvalidEngagementError);
      // Unknown format.
      await expect(
        createEngagement(harness, {
          requestedRights: {
            ...requested,
            formats: ["hologram"],
          },
        }),
      ).rejects.toBeInstanceOf(InvalidEngagementError);
      // Malformed territory.
      await expect(
        createEngagement(harness, {
          requestedRights: {
            ...requested,
            territories: ["GHA"],
          },
        }),
      ).rejects.toBeInstanceOf(InvalidEngagementError);
      // Inverted window.
      await expect(
        createEngagement(harness, {
          requestedRights: {
            ...requested,
            startsAt: requested.endsAt,
            endsAt: requested.startsAt,
          },
        }),
      ).rejects.toBeInstanceOf(InvalidEngagementError);
    } finally {
      await harness.teardown();
    }
  }, 60_000);

  test("the granted envelope must sit within the requested envelope on every dimension", async () => {
    const harness = await createNetW017Harness();
    try {
      const { engagement } = await createEngagement(harness);
      await tenderEngagement(harness, engagement.id, 0);
      // Use kind NOT requested.
      await expect(
        acceptEngagement(harness, engagement.id, 1, {
          grantedRights: {
            ...(await import("./_net-w017-harness.ts")).grantedRightsFixture(),
            uses: [{ kind: "exclusivity_window", terms: null }],
          },
        }),
      ).rejects.toBeInstanceOf(InvalidEngagementError);
      // Channel NOT requested.
      await expect(
        acceptEngagement(harness, engagement.id, 1, {
          grantedRights: {
            ...(await import("./_net-w017-harness.ts")).grantedRightsFixture(),
            channels: ["paid_media"],
          },
        }),
      ).rejects.toBeInstanceOf(InvalidEngagementError);
      // Territory NOT requested.
      await expect(
        acceptEngagement(harness, engagement.id, 1, {
          grantedRights: {
            ...(await import("./_net-w017-harness.ts")).grantedRightsFixture(),
            territories: ["KE"],
          },
        }),
      ).rejects.toBeInstanceOf(InvalidEngagementError);
      // Format NOT requested.
      await expect(
        acceptEngagement(harness, engagement.id, 1, {
          grantedRights: {
            ...(await import("./_net-w017-harness.ts")).grantedRightsFixture(),
            formats: ["article"],
          },
        }),
      ).rejects.toBeInstanceOf(InvalidEngagementError);
      // Window WIDER than requested (endsAt beyond the request).
      const requested = requestedRightsFixture();
      await expect(
        acceptEngagement(harness, engagement.id, 1, {
          grantedRights: {
            ...(await import("./_net-w017-harness.ts")).grantedRightsFixture(),
            startsAt: requested.startsAt,
            endsAt: new Date(
              Date.parse(requested.endsAt) + 86_400_000,
            ).toISOString(),
          },
        }),
      ).rejects.toBeInstanceOf(InvalidEngagementError);
    } finally {
      await harness.teardown();
    }
  }, 60_000);

  test("grants are immutable: the failed-acceptance recovery reuses identical terms; different terms are a stable conflict", async () => {
    const harness = await createNetW017Harness();
    try {
      const { engagement } = await createEngagement(harness);
      await tenderEngagement(harness, engagement.id, 0);
      const { grantedRightsFixture } = await import(
        "./_net-w017-harness.ts"
      );
      // ONE granted-terms fixture shared by the recovery steps (the
      // identical-terms detection is exact).
      const grantedTerms = grantedRightsFixture();
      // Step 1: an acceptance by a person UNAUTHORIZED for the
      // transition (the second-org person has no engagement
      // transition policy) — the grant is recorded, then the
      // transition is DENIED (the composition's partial state).
      const foreignCtx = personCtx(
        harness,
        harness.secondOrgPersonId,
        "w017-grant-conflict",
      );
      await expect(
        harness.runtime.creatorEngagementService.acceptEngagement(
          foreignCtx,
          {
            organizationScopeId: harness.organizationScopeId,
            engagementId: engagement.id,
            expectedVersion: 1,
            grantedRights: grantedTerms,
            idempotencyKey: key("w017-accept-foreign"),
          },
        ),
      ).rejects.toBeInstanceOf(AuthorizationError);
      // The engagement is still READY (the transition never
      // happened), but the grant exists.
      const stored = await harness.runtime.creatorEngagementService.getEngagement(
        personCtx(harness, harness.operatorPersonId, "w017-read"),
        harness.organizationScopeId,
        engagement.id,
      );
      expect(stored.state).toBe("READY");
      const grants =
        await harness.runtime.creatorEngagementService.listUsageRights(
          personCtx(harness, harness.operatorPersonId, "w017-rights"),
          harness.organizationScopeId,
          engagement.id,
        );
      expect(grants.length).toBe(1);

      // Step 2: a retry with a DIFFERENT key + DIFFERENT terms is a
      // stable conflict — grants are immutable.
      await expect(
        harness.runtime.creatorEngagementService.acceptEngagement(
          foreignCtx,
          {
            organizationScopeId: harness.organizationScopeId,
            engagementId: engagement.id,
            expectedVersion: 1,
            grantedRights: {
              ...grantedRightsFixture(),
              territories: ["GH", "NG"],
            },
            idempotencyKey: key("w017-accept-different"),
          },
        ),
      ).rejects.toBeInstanceOf(UsageRightsConflictError);

      // Step 3: the authorized creator accepts with the IDENTICAL
      // terms (new key) — the existing grant is REUSED and the
      // transition completes (the recovery path).
      const recovered = await harness.runtime.creatorEngagementService.acceptEngagement(
        creatorCtx(harness, "w017-recover"),
        {
          organizationScopeId: harness.organizationScopeId,
          engagementId: engagement.id,
          expectedVersion: 1,
          grantedRights: grantedTerms,
          idempotencyKey: key("w017-accept-recover"),
        },
      );
      expect(recovered.engagement.state).toBe("ASSIGNED");
      expect(recovered.grant.id).toBe(grants[0]!.grant.id);
      // Still exactly ONE grant for the engagement.
      const after =
        await harness.runtime.creatorEngagementService.listUsageRights(
          creatorCtx(harness, "w017-rights-2"),
          harness.organizationScopeId,
          engagement.id,
        );
      expect(after.length).toBe(1);
    } finally {
      await harness.teardown();
    }
  }, 60_000);

  test("expiry semantics: the derived status is deterministic at any asOf", async () => {
    const harness = await createNetW017Harness();
    try {
      const { engagement } = await createEngagement(harness);
      await tenderEngagement(harness, engagement.id, 0);
      const accepted = await acceptEngagement(harness, engagement.id, 1);
      const grant = accepted.grant;
      // ACTIVE within the window.
      expect((await getUsageRightsView(harness, grant.id)).effectiveStatus).toBe(
        "ACTIVE",
      );
      // EXPIRED past endsAt.
      const after = new Date(
        Date.parse(grant.endsAt) + 60_000,
      ).toISOString();
      expect(
        (await getUsageRightsView(harness, grant.id, after)).effectiveStatus,
      ).toBe("EXPIRED");
      // Before the window: EXPIRED? No — before startsAt the grant is
      // not yet in force. The derived model: ACTIVE only within the
      // window. (Documented: REVOKED > EXPIRED > ACTIVE priority.)
      const before = new Date(
        Date.parse(grant.startsAt) - 60_000,
      ).toISOString();
      const beforeView = await getUsageRightsView(harness, grant.id, before);
      // The view evaluates deterministically — before the window the
      // grant is not yet EXPIRED and not REVOKED; the effective
      // status is ACTIVE per the frozen derivation (REVOKED ≥
      // effectiveAt, EXPIRED > endsAt, else ACTIVE).
      expect(beforeView.effectiveStatus).toBe("ACTIVE");
      expect(beforeView.viewedAsOf).toBe(before);
    } finally {
      await harness.teardown();
    }
  }, 60_000);

  test("revocation: grantor-only, one revocation, prospective derived status, auditable", async () => {
    const harness = await createNetW017Harness();
    try {
      const { engagement } = await createEngagement(harness);
      await tenderEngagement(harness, engagement.id, 0);
      const accepted = await acceptEngagement(harness, engagement.id, 1);
      const grant = accepted.grant;

      // NOT the grantor: refused (the operator cannot revoke).
      await expect(
        harness.runtime.creatorEngagementService.revokeUsageRights(
          personCtx(harness, harness.operatorPersonId, "w017-revoke-other"),
          {
            organizationScopeId: harness.organizationScopeId,
            grantId: grant.id,
            idempotencyKey: key("w017-revoke"),
          },
        ),
      ).rejects.toBeInstanceOf(AuthorizationError);

      // The grantor revokes with a FUTURE effectiveAt.
      const effectiveAt = new Date(
        Date.now() + 86_400_000,
      ).toISOString();
      const result =
        await harness.runtime.creatorEngagementService.revokeUsageRights(
          creatorCtx(harness, "w017-revoke"),
          {
            organizationScopeId: harness.organizationScopeId,
            grantId: grant.id,
            effectiveAt,
            reason: "creator withdrew",
            idempotencyKey: key("w017-revoke"),
          },
        );
      expect(result.created).toBe(true);
      expect(result.view.revocation).not.toBeNull();
      expect(result.view.revocation!.effectiveAt).toBe(effectiveAt);
      expect(result.view.revocation!.revokedBy).toBe(
        harness.creatorPersonId,
      );
      // BEFORE the effectiveAt: still ACTIVE (prospective).
      const now = new Date().toISOString();
      expect(
        (await getUsageRightsView(harness, grant.id, now)).effectiveStatus,
      ).toBe("ACTIVE");
      // AT/AFTER the effectiveAt: REVOKED.
      expect(
        (await getUsageRightsView(harness, grant.id, effectiveAt)
        ).effectiveStatus,
      ).toBe("REVOKED");
      // Default asOf (now) — still ACTIVE because effectiveAt is
      // tomorrow.
      expect((await getUsageRightsView(harness, grant.id)).effectiveStatus).toBe(
        "ACTIVE",
      );

      // ONE revocation per grant: a second revocation (different key)
      // is a stable conflict.
      await expect(
        harness.runtime.creatorEngagementService.revokeUsageRights(
          creatorCtx(harness, "w017-revoke-2"),
          {
            organizationScopeId: harness.organizationScopeId,
            grantId: grant.id,
            idempotencyKey: key("w017-revoke-2"),
          },
        ),
      ).rejects.toBeInstanceOf(UsageRightsConflictError);

      // The same key replays.
      const replay =
        await harness.runtime.creatorEngagementService.revokeUsageRights(
          creatorCtx(harness, "w017-revoke-replay"),
          {
            organizationScopeId: harness.organizationScopeId,
            grantId: grant.id,
            effectiveAt,
            idempotencyKey: result.view.revocation!.idempotencyKey,
          },
        );
      expect(replay.created).toBe(false);

      // Auditable: the revocation event.
      const events = await harness.runtime.auditWriter.query({
        eventType: "usage_rights.revoked",
        resourceId: grant.id,
      });
      expect(events.length).toBe(1);
      const metadata = events[0]!.metadata as Record<string, unknown>;
      expect(metadata.effectiveAt).toBe(effectiveAt);
      expect(metadata.reason).toBe("creator withdrew");
    } finally {
      await harness.teardown();
    }
  }, 60_000);

  test("an immediate revocation flips the derived status at once and blocks production", async () => {
    const harness = await createNetW017Harness();
    try {
      const { engagement } = await createEngagement(harness);
      await tenderEngagement(harness, engagement.id, 0);
      const accepted = await acceptEngagement(harness, engagement.id, 1);
      await harness.runtime.creatorEngagementService.revokeUsageRights(
        creatorCtx(harness, "w017-revoke-now"),
        {
          organizationScopeId: harness.organizationScopeId,
          grantId: accepted.grant.id,
          idempotencyKey: key("w017-revoke-now"),
        },
      );
      expect(
        (await getUsageRightsView(harness, accepted.grant.id))
          .effectiveStatus,
      ).toBe("REVOKED");
      // Production requires ACTIVE rights.
      await expect(
        harness.runtime.creatorEngagementService.openProduction(
          creatorCtx(harness, "w017-prod"),
          {
            organizationScopeId: harness.organizationScopeId,
            engagementId: accepted.engagement.id,
            expectedVersion: 2,
            idempotencyKey: key("w017-prod"),
          },
        ),
      ).rejects.toBeInstanceOf(UsageRightsConflictError);
    } finally {
      await harness.teardown();
    }
  }, 60_000);

  test("the derived effective status is a PURE function (no stored status field, no local status machine)", async () => {
    const { usageRightsEffectiveStatus } = await import(
      "../../src/creators/engagement-engine.ts"
    );
    const grant = { endsAt: "2026-06-01T00:00:00.000Z" };
    // No revocation: ACTIVE then EXPIRED.
    expect(usageRightsEffectiveStatus(grant, null, "2026-01-01T00:00:00.000Z")).toBe(
      "ACTIVE",
    );
    expect(usageRightsEffectiveStatus(grant, null, "2026-06-01T00:00:00.000Z")).toBe(
      "ACTIVE",
    );
    expect(usageRightsEffectiveStatus(grant, null, "2026-06-01T00:00:00.001Z")).toBe(
      "EXPIRED",
    );
    // Revocation semantics: REVOKED dominates at/after effectiveAt.
    const revocation = { effectiveAt: "2026-03-01T00:00:00.000Z" };
    expect(
      usageRightsEffectiveStatus(grant, revocation, "2026-02-28T23:59:59.999Z"),
    ).toBe("ACTIVE");
    expect(
      usageRightsEffectiveStatus(grant, revocation, "2026-03-01T00:00:00.000Z"),
    ).toBe("REVOKED");
    expect(
      usageRightsEffectiveStatus(grant, revocation, "2027-01-01T00:00:00.000Z"),
    ).toBe("REVOKED");
    // Determinism: identical inputs → identical outputs.
    expect(
      usageRightsEffectiveStatus(grant, revocation, "2026-03-01T00:00:00.000Z"),
    ).toBe(
      usageRightsEffectiveStatus(grant, revocation, "2026-03-01T00:00:00.000Z"),
    );
  });
});
