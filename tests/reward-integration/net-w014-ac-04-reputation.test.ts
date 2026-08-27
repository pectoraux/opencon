/**
 * NET-W014-AC-04 — material reward/outcome effects update /reputation
 * only through evidence-backed references (REP-004; issue #27
 * invariant 4).
 *
 * The reputation composite feeds ONE input per material settlement
 * outcome (MATURE/CONSUMED value records) through the EXISTING
 * reputation input service: sources are the value record's verified
 * references, the basis is DERIVED (never caller-asserted), no
 * economic field is copied, and reputation remains non-economic.
 */
import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import {
  createNetW014Harness,
  createRecognizedMatureValue,
  recognizeContributionValue,
  createVerifiedSettledContribution,
  createClearingCampaign,
  moderatorCtx,
  contributorCtx,
  key,
  type NetW014Harness,
} from "./_net-w014-harness.ts";
import type { ReputationInput } from "../../src/reputation/port.ts";

let harness: NetW014Harness;

beforeAll(async () => {
  harness = await createNetW014Harness();
});

afterAll(async () => {
  await harness.teardown();
});

/** The reputation composite exactly as the apiCommand runs it. */
async function applyReputationEffect(
  valueRecordId: string,
  opts: {
    readonly dimension?: string;
    readonly description?: string;
    readonly idempotencyKey?: string;
  } = {},
): Promise<{ input: ReputationInput; created: boolean; valueState: string }> {
  const result =
    await harness.runtime.apiCommands.applySettlementReputationEffect(
      moderatorCtx(harness, "w014-reputation"),
      harness.moderatorPersonId,
      {
        valueRecordId,
        ...(opts.dimension !== undefined ? { dimension: opts.dimension } : {}),
        ...(opts.description !== undefined
          ? { description: opts.description }
          : {}),
        idempotencyKey: opts.idempotencyKey ?? key("w014-reputation"),
      },
    );
  return {
    input: result.input as unknown as ReputationInput,
    created: result.created,
    valueState: result.valueState,
  };
}

describe("NET-W014-AC-04 evidence-backed reputation effects", () => {
  test("a MATURE outcome feeds ONE reputation input with DERIVED verified basis + reference-only sources", async () => {
    const { value } = await createRecognizedMatureValue(harness, {
      withMeasuredOutcomeBasis: true,
      amount: 777.777,
    });
    const effect = await applyReputationEffect(value.id);
    expect(effect.created).toBe(true);
    expect(effect.valueState).toBe("MATURE");
    const input = effect.input;
    // The subject is the value beneficiary (the contributor).
    expect(input.subjectPersonId).toBe(harness.contributorPersonId);
    expect(input.organizationScopeId).toBe(harness.organizationScopeId);
    // The dimension defaults to helpfulness (closed vocabulary).
    expect(input.dimension).toBe("helpfulness");
    // The basis is DERIVED from the resolved sources — every source
    // is verified-grade by the settlement input gate, so `verified`.
    expect(input.basis).toBe("verified");
    // The sources are the value record's REFERENCES (contribution +
    // bases) — no amounts, no economic fields.
    const kinds = input.sources.map((s) => s.kind).sort();
    expect(kinds).toEqual(["contribution", "evidence", "measured_outcome"]);
    const serialized = JSON.stringify(input);
    expect(serialized).not.toMatch(/"amount"/);
    expect(serialized).not.toContain("777.777");
    // The full AUTHORITATIVE record (via the domain service) carries
    // the execution lineage.
    const stored = await harness.runtime.reputationInputService.getInput(
      harness.bootstrapCtx,
      input.id,
    );
    expect(stored?.executionId).toBeTruthy();
    expect(stored?.idempotencyKey).toBe(input.idempotencyKey);
    // The decay anchor is the MATURATION time (when the outcome
    // happened), not the recording time.
    expect(value.maturedAt).toBeTruthy();
    expect(input.occurredAt).toBe(value.maturedAt!);
  });

  test("a CONSUMED outcome (post-clearing) also feeds reputation — the material effect of a settled reward", async () => {
    const { value } = await createRecognizedMatureValue(harness, {
      withMeasuredOutcomeBasis: true,
      amount: 40,
    });
    const campaign = await createClearingCampaign(harness);
    await harness.runtime.apiCommands.executeCampaignClearing(
      contributorCtx(harness, "w014-clear-for-rep"),
      harness.contributorPersonId,
      {
        campaignId: campaign.id,
        valueRecordId: value.id,
        idempotencyKey: key("w014-clear-for-rep"),
      },
    );
    const effect = await applyReputationEffect(value.id);
    expect(effect.valueState).toBe("CONSUMED");
    expect(effect.input.basis).toBe("verified");
    expect(effect.created).toBe(true);
  });

  test("a merely-PENDING (recognized but unmatured) outcome NEVER feeds reputation", async () => {
    const { contribution } = await createVerifiedSettledContribution(harness, {
      withMeasuredOutcomeBasis: true,
    });
    const recognized = await recognizeContributionValue(harness, contribution.id, {
      amount: 50,
    });
    await expect(
      applyReputationEffect(recognized.value.id),
    ).rejects.toMatchObject({
      code: "REPUTATION_VALIDATION",
      context: expect.objectContaining({ state: "PENDING" }),
    });
  });

  test("the effect replays idempotently (exactly one input per key)", async () => {
    const { value } = await createRecognizedMatureValue(harness, {
      withMeasuredOutcomeBasis: true,
      amount: 30,
    });
    const idem = key("w014-rep-idem");
    const first = await applyReputationEffect(value.id, { idempotencyKey: idem });
    const replay = await applyReputationEffect(value.id, { idempotencyKey: idem });
    expect(replay.created).toBe(false);
    expect(replay.input.id).toBe(first.input.id);
    const inputs = await harness.runtime.reputationInputService.listInputs(
      harness.bootstrapCtx,
      harness.organizationScopeId,
      harness.contributorPersonId,
    );
    expect(
      inputs.filter((i) => i.idempotencyKey === idem).length,
    ).toBe(1);
  });

  test("a custom LEGAL dimension is honoured; an illegal dimension is refused by the closed vocabulary", async () => {
    const { value } = await createRecognizedMatureValue(harness, {
      withMeasuredOutcomeBasis: true,
      amount: 30,
    });
    const effect = await applyReputationEffect(value.id, {
      dimension: "measurement_reliability",
    });
    expect(effect.input.dimension).toBe("measurement_reliability");
    await expect(
      applyReputationEffect(value.id, {
        dimension: "purchasing_power",
      }),
    ).rejects.toThrow(/dimension/i);
  });

  test("reputation inputs carry NO economic authority: no code path from the input to credits, cash or value records", async () => {
    const { value } = await createRecognizedMatureValue(harness, {
      withMeasuredOutcomeBasis: true,
      amount: 30,
    });
    const effect = await applyReputationEffect(value.id);
    // The reputation input record exposes no economic fields beyond
    // references (the source refs are the SAME kinds the reputation
    // domain already accepts — contribution/PoV/outcome/evidence).
    const record = effect.input as unknown as Record<string, unknown>;
    expect(Object.keys(record).sort()).toEqual([
      "basis",
      "description",
      "dimension",
      "id",
      "idempotencyKey",
      "occurredAt",
      "organizationScopeId",
      "recordedAt",
      "sources",
      "subjectPersonId",
    ]);
    // There is no settle/spend/credit mutation on the reputation
    // service surface at all (grep-level structural pin lives in the
    // AC-07 regression).
  });

  test("the description is non-economic prose (references only, no amounts)", async () => {
    const { value } = await createRecognizedMatureValue(harness, {
      withMeasuredOutcomeBasis: true,
      amount: 123.456,
    });
    const effect = await applyReputationEffect(value.id);
    expect(effect.input.description).not.toContain("123.456");
    expect(effect.input.description).toContain(value.id);
  });
});
