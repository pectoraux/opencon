/**
 * NET-W032-AC-06 — CONFLICT-OF-INTEREST + TENANCY / AUTHORIZATION
 * (issue #65; work order §3.6: exclude the target subject, the target
 * owner/controller, the challenge initiator, the directly interested
 * economic beneficiary and any validator explicitly marked
 * conflicted; cross-tenant candidates are not eligible; §6: all
 * routes deny-by-default and tenant-scoped; cross-tenant and
 * nonexistent identifiers are indistinguishable).
 *
 *  - the self-dealing flow (the subject registers as a validator and
 *    can never be selected);
 *  - the outcome-application conflict gate (an assigned validator can
 *    never apply the round's outcome);
 *  - the full guarded HTTP round-trip (deny-by-default + the
 *    authenticated flow + indistinguishable 404s);
 *  - cross-tenant observations fail closed.
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { createRuntime } from "../../src/bootstrap/runtime.ts";
import {
  createNetW032Harness,
  deriveAssignments,
  deriveOutcome,
  key,
  observe,
  openDefaultChallenge,
  personCtx,
  runFullRound,
  shiftIso,
  type NetW032Harness,
} from "./_net-w032-harness.ts";

const BASE = "http://127.0.0.1";

let harness: NetW032Harness;

beforeEach(async () => {
  harness = await createNetW032Harness();
});

afterEach(async () => {
  await harness.teardown();
});

describe("NET-W032-AC-06 conflict-of-interest + tenancy/authorization", () => {
  test("the SELF-DEALING flow: the proof subject registers as a validator but is never selected", async () => {
    // The subject (the proof's own person) attempts to gain influence
    // by registering — the assignment derivation excludes them and
    // their observation attempt fails the assignment binding.
    const subjectCtx = personCtx(harness, harness.personId, "ac06-selfdeal");
    await harness.runtime.validatorRegistryService.registerValidator(subjectCtx, {
      organizationScopeId: harness.organizationScopeId,
      personId: harness.personId,
      idempotencyKey: key("ac06-selfdeal"),
    });
    const opened = await openDefaultChallenge(harness);
    const assigned = await deriveAssignments(harness, opened.challenge);
    expect(assigned.assignment!.entries.map((e) => e.validatorPersonId)).not.toContain(
      harness.personId,
    );
    expect(assigned.assignment!.excluded).toContainEqual({
      personId: harness.personId,
      reason: "target_subject",
    });
    await expect(
      observe(harness, assigned, 0).then(() =>
        harness.runtime.validationService.submitObservation(subjectCtx, {
          organizationScopeId: harness.organizationScopeId,
          challengeId: assigned.id,
          verdict: "UPHOLD",
          statement: "self-dealing observation",
          evidenceRefs: [{ kind: "reputation_proof", id: assigned.target.id }],
          observedAt: shiftIso(assigned.effectiveAt, 7200_000),
          idempotencyKey: key("ac06-selfdeal-observe"),
        }),
      ),
    ).rejects.toMatchObject({
      code: "VALIDATION_VALIDATION",
      message: expect.stringContaining("not an assigned validator"),
    });
  });

  test("an ASSIGNED validator can never apply the round's outcome (conflict gate)", async () => {
    const round = await runFullRound(harness);
    expect(round.outcome.decision).toBe("UPHELD");
    // Validator 0 (an assigned validator) attempts to apply.
    const validatorCtx = personCtx(
      harness,
      round.challenge.assignment!.entries[0]!.validatorPersonId,
      "ac06-apply-validator",
    );
    await expect(
      harness.runtime.validationService.markOutcomeApplied(validatorCtx, {
        organizationScopeId: harness.organizationScopeId,
        outcomeId: round.outcome.id,
        application: "reputation_proof_revocation",
        idempotencyKey: key("ac06-apply-validator"),
      }),
    ).rejects.toMatchObject({
      code: "VALIDATION_VALIDATION",
      message: expect.stringContaining("cannot apply its outcome (conflict of interest)"),
      context: expect.objectContaining({ conflict: "assigned_validator" }),
    });
    // The outcome stays unapplied (no false success).
    const unchanged = await harness.runtime.validationService.getOutcome(
      personCtx(harness, harness.reviewerPersonId, "ac06-unapplied"),
      harness.organizationScopeId,
      round.outcome.id,
    );
    expect(unchanged.applied).toBeNull();
  });

  test("cross-tenant reads and observations fail closed (no oracle, no leakage)", async () => {
    const opened = await openDefaultChallenge(harness);
    const assigned = await deriveAssignments(harness, opened.challenge);
    // A second-org person attempts to read the main-org round: the
    // same indistinguishable NotFound as a nonexistent id.
    const otherCtx = personCtx(harness, harness.secondOrgPersonId, "ac06-cross");
    const crossRead = harness.runtime.validationService.getChallenge(
      otherCtx,
      harness.secondOrgId,
      assigned.id,
    );
    const missingRead = harness.runtime.validationService.getChallenge(
      otherCtx,
      harness.secondOrgId,
      "no-such-round",
    );
    const [crossErr, missingErr] = await Promise.allSettled([crossRead, missingRead]).then(
      (rs) => [rs[0].status === "rejected" ? rs[0].reason : null, rs[1].status === "rejected" ? rs[1].reason : null],
    );
    expect(crossErr!.code).toBe(missingErr!.code);
    expect(crossErr!.message).toContain("validation challenge not found");
    // A second-org person cannot observe on the main-org round.
    await expect(
      harness.runtime.validationService.submitObservation(otherCtx, {
        organizationScopeId: harness.organizationScopeId,
        challengeId: assigned.id,
        verdict: "UPHOLD",
        statement: "cross-tenant observation",
        evidenceRefs: [{ kind: "reputation_proof", id: assigned.target.id }],
        observedAt: shiftIso(assigned.effectiveAt, 7200_000),
        idempotencyKey: key("ac06-cross-observe"),
      }),
    ).rejects.toMatchObject({
      code: "VALIDATION_VALIDATION",
      message: expect.stringContaining("not an assigned validator"),
    });
  });

  test("the validation routes are guarded DENY-BY-DEFAULT (no policy → 403, authenticated or not)", async () => {
    // A bare runtime WITHOUT the validation allow policies.
    const bare = createRuntime({
      forceEnv: "test",
      env: { APP_ENV: "test", LOG_LEVEL: "error" },
      port: 0,
    });
    await bare.initialize();
    await bare.api.start();
    try {
      const cases: Array<[string, Record<string, unknown>]> = [
        ["/api/validation/policies", { organizationScopeId: "org", policyId: "p", version: 1, assignmentCardinality: 3, minimumSubmitted: 2, upholdThreshold: 2, rejectThreshold: 2, challengeWindowMs: 1000, validatorStakeRequirementCredits: 0 }],
        ["/api/validation/validators", { organizationScopeId: "org", personId: "x", idempotencyKey: "k" }],
        ["/api/validation/validators/some-id/read", { organizationScopeId: "org" }],
        ["/api/validation/validators/some-id/suspension", { organizationScopeId: "org", reason: "r", idempotencyKey: "k" }],
        ["/api/validation/challenges", { organizationScopeId: "org", target: { kind: "reputation_proof", id: "x" }, statement: "s", reasonCodes: ["c"], effectiveAt: "2026-01-01T00:00:00.000Z", policyId: "p", idempotencyKey: "k" }],
        ["/api/validation/challenges/some-id/read", { organizationScopeId: "org" }],
        ["/api/validation/challenges/some-id/conflicts", { organizationScopeId: "org", validatorPersonId: "v", reason: "r", idempotencyKey: "k" }],
        ["/api/validation/challenges/some-id/assignments", { organizationScopeId: "org", derivedAt: "2026-01-01T00:00:00.000Z", idempotencyKey: "k" }],
        ["/api/validation/challenges/some-id/validator-stake", { organizationScopeId: "org", validatorPersonId: "v", idempotencyKey: "k" }],
        ["/api/validation/challenges/some-id/observations", { organizationScopeId: "org", verdict: "UPHOLD", statement: "s", evidenceRefs: [], observedAt: "2026-01-01T00:00:00.000Z", idempotencyKey: "k" }],
        ["/api/validation/challenges/some-id/resolution", { organizationScopeId: "org", evaluatedAt: "2026-01-01T00:00:00.000Z", idempotencyKey: "k" }],
        ["/api/validation/outcomes/some-id/application", { organizationScopeId: "org", idempotencyKey: "k" }],
        ["/api/validation/outcomes/some-id/read", { organizationScopeId: "org" }],
      ];
      for (const [path, body] of cases) {
        const unauth = await fetch(`${BASE}:${bare.api.port}${path}`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
        });
        expect(unauth.status).toBe(403);
        const authed = await fetch(`${BASE}:${bare.api.port}${path}`, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "x-auth-subject-id": "someone@example.com",
            "x-auth-provider-kind": "internal",
          },
          body: JSON.stringify(body),
        });
        expect(authed.status).toBe(403);
      }
    } finally {
      await bare.shutdown();
    }
  });

  test("the full guarded HTTP round-trip works (open → assign → observe → resolve → apply) with cross-tenant 404s", async () => {
    const org = harness.organizationScopeId;
    // 1. Open a challenge over a fresh proof target (the initiator's
    //    email authenticates the guard).
    const seeded = await import("./_net-w032-harness.ts").then((m) =>
      m.seedProofTarget(harness),
    );
    const challengerSubjectId = "econ-beneficiary@example.com";
    const openResponse = await fetch(
      `${BASE}:${harness.runtime.api.port}/api/validation/challenges`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-auth-subject-id": challengerSubjectId,
          "x-auth-provider-kind": "internal",
        },
        body: JSON.stringify({
          organizationScopeId: org,
          target: { kind: "reputation_proof", id: seeded.proof.id },
          statement: "the proof misstates the subject's standing",
          reasonCodes: ["contested_claim"],
          effectiveAt: shiftIso(seeded.proof.issuedAt, 3600_000),
          policyId: harness.defaultPolicyId,
          idempotencyKey: key("ac06-http-open"),
        }),
      },
    );
    expect(openResponse.status).toBe(201);
    const opened = (await openResponse.json()) as {
      created: boolean;
      challenge: { id: string; target: { id: string } };
    };
    expect(opened.created).toBe(true);

    // 2. Derive the assignments (any authenticated principal).
    const assignResponse = await fetch(
      `${BASE}:${harness.runtime.api.port}/api/validation/challenges/${opened.challenge.id}/assignments`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-auth-subject-id": challengerSubjectId,
          "x-auth-provider-kind": "internal",
        },
        body: JSON.stringify({
          organizationScopeId: org,
          derivedAt: shiftIso(seeded.proof.issuedAt, 7200_000),
          idempotencyKey: key("ac06-http-assign"),
        }),
      },
    );
    expect(assignResponse.status).toBe(200);
    const assigned = (await assignResponse.json()) as {
      created: boolean;
      challenge: {
        id: string;
        assignment: { entries: { validatorPersonId: string }[] } | null;
      };
    };
    expect(assigned.challenge.assignment).not.toBeNull();

    // 3. Two assigned validators observe (each authenticated as
    //    THEMSELVES — their harness emails).
    const assignmentIndex = (
      personId: string,
    ) =>
      assigned.challenge.assignment!.entries.findIndex(
        (e) => e.validatorPersonId === personId,
      );
    const emailFor = (personId: string): string => {
      const idx = harness.validatorPersonIds.indexOf(personId);
      return harness.validatorSubjectIds[idx]!;
    };
    const firstEntry = assigned.challenge.assignment!.entries[0]!;
    const secondEntry = assigned.challenge.assignment!.entries[1]!;
    for (const [entry, verdict] of [
      [firstEntry, "UPHOLD"],
      [secondEntry, "UPHOLD"],
    ] as const) {
      const observeResponse = await fetch(
        `${BASE}:${harness.runtime.api.port}/api/validation/challenges/${assigned.challenge.id}/observations`,
        {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "x-auth-subject-id": emailFor(entry.validatorPersonId),
            "x-auth-provider-kind": "internal",
          },
          body: JSON.stringify({
            organizationScopeId: org,
            verdict,
            statement: "the referenced evidence supports the challenge",
            evidenceRefs: [{ kind: "reputation_proof", id: seeded.proof.id }],
            observedAt: shiftIso(seeded.proof.issuedAt, 10800_000),
            idempotencyKey: key("ac06-http-observe"),
          }),
        },
      );
      expect(observeResponse.status).toBe(201);
    }
    void assignmentIndex;

    // 4. Resolve the round (the deterministic quorum).
    const resolveResponse = await fetch(
      `${BASE}:${harness.runtime.api.port}/api/validation/challenges/${assigned.challenge.id}/resolution`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-auth-subject-id": challengerSubjectId,
          "x-auth-provider-kind": "internal",
        },
        body: JSON.stringify({
          organizationScopeId: org,
          evaluatedAt: shiftIso(seeded.proof.issuedAt, 14400_000),
          idempotencyKey: key("ac06-http-resolve"),
        }),
      },
    );
    expect(resolveResponse.status).toBe(200);
    const resolved = (await resolveResponse.json()) as {
      outcome: { id: string; decision: string };
      stakes: unknown[];
    };
    expect(resolved.outcome.decision).toBe("UPHELD");
    expect(resolved.stakes).toHaveLength(0);

    // 5. Apply the accepted outcome through the owning authority (the
    //    challenger applies — NOT an assigned validator; the composite
    //    revokes the proof through the /reputation authority and
    //    records the application fact).
    const applyResponse = await fetch(
      `${BASE}:${harness.runtime.api.port}/api/validation/outcomes/${resolved.outcome.id}/application`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-auth-subject-id": challengerSubjectId,
          "x-auth-provider-kind": "internal",
        },
        body: JSON.stringify({
          organizationScopeId: org,
          idempotencyKey: key("ac06-http-apply"),
        }),
      },
    );
    expect(applyResponse.status).toBe(200);
    const applied = (await applyResponse.json()) as {
      outcome: {
        decision: string;
        applied: {
          appliedAt: string;
          appliedByPersonId: string;
          application: string;
        } | null;
      };
      proof: { id: string; revokedAt: string | null };
    };
    expect(applied.outcome.decision).toBe("UPHELD");
    expect(applied.outcome.applied).toEqual({
      appliedAt: expect.any(String),
      appliedByPersonId: expect.any(String),
      application: "reputation_proof_revocation",
    });
    // The owning authority's mutation is observable: the proof is
    // revoked (its signed one-way revocation state).
    expect(applied.proof.revokedAt).not.toBeNull();

    // 6. Cross-tenant HTTP reads are indistinguishable 404s.
    const crossRead = await fetch(
      `${BASE}:${harness.runtime.api.port}/api/validation/challenges/${assigned.challenge.id}/read`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-auth-subject-id": "risk-second-org@example.com",
          "x-auth-provider-kind": "internal",
        },
        body: JSON.stringify({ organizationScopeId: harness.secondOrgId }),
      },
    );
    expect(crossRead.status).toBe(404);
    const missingRead = await fetch(
      `${BASE}:${harness.runtime.api.port}/api/validation/challenges/no-such-id/read`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-auth-subject-id": "risk-second-org@example.com",
          "x-auth-provider-kind": "internal",
        },
        body: JSON.stringify({ organizationScopeId: harness.secondOrgId }),
      },
    );
    expect(missingRead.status).toBe(404);
  });
});
