/**
 * NET-W016-AC-04 — matching is SELECTION, not authority (work order
 * §3.4; issue #31 invariant 4).
 *
 * A match run mutates NO workflow, settlement, reputation or risk
 * state. The ONLY mutation is the append-only match-run record +
 * its single `creator_match.recorded` audit event — proven
 * behaviorally through the audit trail (every material mutation in
 * this codebase is transactionally audited, so the audit ledger is
 * the universal mutation witness) and through direct state
 * comparisons (reputation snapshots byte-identical; risk controls
 * unchanged). Idempotent re-runs are side-effect-free.
 */

import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import {
  activateEligibilityHold,
  baselineRequirements,
  createMatchCandidate,
  createNetW016Harness,
  key,
  runMatch,
  type NetW016Harness,
} from "./_net-w016-harness.ts";

let harness: NetW016Harness;

beforeAll(async () => {
  harness = await createNetW016Harness();
});

afterAll(async () => {
  await harness.teardown();
});

describe("NET-W016-AC-04 selection, not authority", () => {
  test("a match run's ONLY audit event is creator_match.recorded (no workflow/settlement/reputation/risk mutation)", async () => {
    const candidate = await createMatchCandidate(harness);
    const before = await harness.runtime.auditWriter.query({
      limit: 100000,
    });
    const { run } = await runMatch(harness, {
      requirements: baselineRequirements(),
      candidateProfileIds: [candidate.profile.id],
      idempotencyKey: key("w016-ac04-audit"),
    });
    const after = await harness.runtime.auditWriter.query({
      limit: 100000,
    });
    // The audit ledger is the universal mutation witness: the run
    // added EXACTLY ONE event — its own record-of-decision.
    expect(after.length).toBe(before.length + 1);
    const newEvent = after[after.length - 1]!;
    expect(newEvent.eventType).toBe("creator_match.recorded");
    expect(newEvent.resourceType).toBe("creator_match_run");
    expect(newEvent.resourceId).toBe(run.id);
    expect(newEvent.metadata.candidateCount).toBe(1);
    expect(newEvent.metadata.eligibleCount).toBe(1);
    expect(newEvent.metadata.digest).toBe(run.digest);
  });

  test("reputation snapshots are byte-identical before and after the run (referenced, never mutated)", async () => {
    const candidate = await createMatchCandidate(harness);
    const references =
      candidate.version!.sections.reputationReferences;
    const readAll = async () =>
      Promise.all(
        references.map(async (reference) => {
          const snapshot =
            await harness.runtime.reputationSnapshotService.getSnapshot(
              harness.bootstrapCtx,
              reference.snapshotId,
            );
          return JSON.stringify(snapshot);
        }),
      );
    const before = await readAll();
    await runMatch(harness, {
      requirements: baselineRequirements(),
      candidateProfileIds: [candidate.profile.id],
      idempotencyKey: key("w016-ac04-reputation"),
    });
    expect(await readAll()).toEqual(before);
  });

  test("risk controls are read, never mutated: an ACTIVE hold survives the run and still gates", async () => {
    const candidate = await createMatchCandidate(harness);
    const controlId = await activateEligibilityHold(
      harness,
      candidate.personId,
    );
    const before = await harness.runtime.riskControlService.getControl(
      harness.bootstrapCtx,
      controlId,
    );
    expect(before.state).toBe("ACTIVE");

    const { run } = await runMatch(harness, {
      requirements: baselineRequirements(),
      candidateProfileIds: [candidate.profile.id],
      idempotencyKey: key("w016-ac04-control"),
    });
    // The hold gated the candidate (the read worked)...
    expect(run.excluded[0]!.failedReasons).toContain("active_risk_control");
    // ...and the control itself is UNCHANGED (still ACTIVE, same
    // activation metadata — matching only READ the registry).
    const after = await harness.runtime.riskControlService.getControl(
      harness.bootstrapCtx,
      controlId,
    );
    expect(after.state).toBe("ACTIVE");
    expect(after.activatedAt).toBe(before.activatedAt);
    expect(after.resolvedAt).toBeNull();
    expect(JSON.stringify(after)).toBe(JSON.stringify(before));
  });

  test("creator profiles are read-only inputs: the run leaves the profile + version untouched", async () => {
    const candidate = await createMatchCandidate(harness);
    const profileBefore = JSON.stringify(
      await harness.runtime.creatorService.getProfile(
        harness.bootstrapCtx,
        harness.organizationScopeId,
        candidate.profile.id,
      ),
    );
    const versionBefore = JSON.stringify(
      await harness.runtime.creatorService.getProfileVersion(
        harness.bootstrapCtx,
        harness.organizationScopeId,
        candidate.profile.id,
        candidate.profile.currentVersion!,
      ),
    );
    await runMatch(harness, {
      requirements: baselineRequirements(),
      candidateProfileIds: [candidate.profile.id],
      idempotencyKey: key("w016-ac04-profiles"),
    });
    expect(
      JSON.stringify(
        await harness.runtime.creatorService.getProfile(
          harness.bootstrapCtx,
          harness.organizationScopeId,
          candidate.profile.id,
        ),
      ),
    ).toBe(profileBefore);
    expect(
      JSON.stringify(
        await harness.runtime.creatorService.getProfileVersion(
          harness.bootstrapCtx,
          harness.organizationScopeId,
          candidate.profile.id,
          candidate.profile.currentVersion!,
        ),
      ),
    ).toBe(versionBefore);
  });

  test("the idempotent replay commits NOTHING new (byte-identical record, no second audit event)", async () => {
    const candidate = await createMatchCandidate(harness);
    const idempotencyKey = key("w016-ac04-replay");
    const first = await runMatch(harness, {
      requirements: baselineRequirements(),
      candidateProfileIds: [candidate.profile.id],
      idempotencyKey,
    });
    expect(first.created).toBe(true);
    const auditAfterFirst = (
      await harness.runtime.auditWriter.query({ limit: 100000 })
    ).length;

    const replay = await runMatch(harness, {
      requirements: baselineRequirements(),
      candidateProfileIds: [candidate.profile.id],
      idempotencyKey,
    });
    expect(replay.created).toBe(false);
    expect(replay.run.id).toBe(first.run.id);
    expect(JSON.stringify(replay.run)).toBe(JSON.stringify(first.run));
    const auditAfterReplay = (
      await harness.runtime.auditWriter.query({ limit: 100000 })
    ).length;
    expect(auditAfterReplay).toBe(auditAfterFirst);

    // A DIFFERENT key creates a new run (append-only history).
    const second = await runMatch(harness, {
      requirements: baselineRequirements(),
      candidateProfileIds: [candidate.profile.id],
      idempotencyKey: key("w016-ac04-second"),
    });
    expect(second.created).toBe(true);
    expect(second.run.id).not.toBe(first.run.id);
  });

  test("runs with an advisory enabled still mutate nothing beyond the run record", async () => {
    const candidate = await createMatchCandidate(harness);
    const before = await harness.runtime.auditWriter.query({
      limit: 100000,
    });
    await runMatch(harness, {
      requirements: baselineRequirements(),
      candidateProfileIds: [candidate.profile.id],
      advisory: { enabled: true, maxWeight: 10 },
      idempotencyKey: key("w016-ac04-advisory"),
    });
    const after = await harness.runtime.auditWriter.query({
      limit: 100000,
    });
    expect(after.length).toBe(before.length + 1);
    expect(after[after.length - 1]!.eventType).toBe("creator_match.recorded");
  });
});
