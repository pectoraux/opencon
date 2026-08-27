/**
 * NET-W013 remediation — deterministic moderation decision ordering.
 *
 * Root cause (found via a NET-W016 CI run): the moderation status
 * derives "latest" from `decidedAt`, whose same-millisecond
 * tie-break compared RANDOM record ids — two decisions recorded in
 * the same millisecond could derive the WRONG latest status
 * (flaky, order-dependent). The fix makes `decidedAt` STRICTLY
 * monotonic per contribution (serialized under the contribution
 * moderation mutex; the new decision's timestamp is always greater
 * than the prior latest's).
 *
 * This test FREEZES the wall clock so both decisions are recorded
 * in the SAME millisecond — the exact flake condition — and proves
 * the derivation stays correct.
 */

import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import {
  createNetW013Harness,
  createQualifiedContribution,
  recordModerationDecision,
  type NetW013Harness,
} from "./_net-w013-harness.ts";

let harness: NetW013Harness;

beforeAll(async () => {
  harness = await createNetW013Harness();
});

afterAll(async () => {
  await harness.teardown();
});

/** Freeze the wall clock at one millisecond (the flake condition). */
function freezeClock(): () => void {
  const RealDate = Date;
  const frozen = new RealDate("2026-03-01T00:00:00.000Z").getTime();
  const ShimDate = class extends RealDate {
    constructor(...args: unknown[]) {
      if (args.length === 0) {
        super(frozen);
      } else {
        super(args[0] as string | number | Date);
      }
    }
    public static override now(): number {
      return frozen;
    }
  };
  globalThis.Date = ShimDate as unknown as DateConstructor;
  return () => {
    globalThis.Date = RealDate;
  };
}

describe("NET-W013 remediation: same-millisecond decisions derive the correct latest status", () => {
  test("two decisions recorded in the SAME millisecond are strictly ordered (decidedAt monotonic; latest = second)", async () => {
    const { contribution } = await createQualifiedContribution(harness);
    const unfreeze = freezeClock();
    try {
      const first = await recordModerationDecision(harness, contribution.id, {
        decision: "REJECT",
        reasonKinds: ["spam"],
      });
      const second = await recordModerationDecision(
        harness,
        contribution.id,
        {
          decision: "FLAG_FOR_REVIEW",
          reasonKinds: ["low_evidence_quality"],
        },
      );
      // Both decisions were recorded under the SAME frozen clock
      // instant — yet the second's decidedAt is STRICTLY greater
      // (the monotonic bump), so the random-id tie-break can never
      // decide the ordering.
      expect(second.decision.decidedAt).toBe(
        new Date(Date.parse(first.decision.decidedAt) + 1).toISOString(),
      );
      // The derived status follows the SECOND decision.
      const summary = await harness.runtime.moderationService.getModerationSummary(
        harness.bootstrapCtx,
        contribution.id,
      );
      expect(summary.status).toBe("FLAGGED_FOR_REVIEW");
      expect(summary.decisionCount).toBe(2);
      expect(summary.latestDecision!.id).toBe(second.decision.id);

      // And the reverse order derives the reverse status (REJECT
      // last → REJECTED) under the same frozen clock.
      const { contribution: another } = await createQualifiedContribution(
        harness,
      );
      await recordModerationDecision(harness, another.id, {
        decision: "FLAG_FOR_REVIEW",
        reasonKinds: ["low_evidence_quality"],
      });
      const reject = await recordModerationDecision(harness, another.id, {
        decision: "REJECT",
        reasonKinds: ["spam"],
      });
      const rejectSummary =
        await harness.runtime.moderationService.getModerationSummary(
          harness.bootstrapCtx,
          another.id,
        );
      expect(rejectSummary.status).toBe("REJECTED");
      expect(rejectSummary.latestDecision!.id).toBe(reject.decision.id);
      expect(rejectSummary.decisionCount).toBe(2);
    } finally {
      unfreeze();
    }
  });

  test("normal (unfrozen) recording still works and derives from the latest", async () => {
    const { contribution } = await createQualifiedContribution(harness);
    await recordModerationDecision(harness, contribution.id, {
      decision: "FLAG_FOR_REVIEW",
      reasonKinds: ["low_evidence_quality"],
    });
    await recordModerationDecision(harness, contribution.id, {
      decision: "APPROVE",
      reasonKinds: ["no_violation"],
    });
    const summary = await harness.runtime.moderationService.getModerationSummary(
      harness.bootstrapCtx,
      contribution.id,
    );
    expect(summary.status).toBe("APPROVED");
    expect(summary.decisionCount).toBe(2);
  });
});
