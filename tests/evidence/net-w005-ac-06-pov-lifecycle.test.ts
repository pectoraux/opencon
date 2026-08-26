/**
 * NET-W005-AC-06 — Deterministic, idempotent, authorized, auditable
 * Proof-of-Value lifecycle.
 *
 * The PoV transition matrix is exhaustive (legal transitions
 * enumerated; every unspecified transition rejected with a stable
 * error code); transitions are authorized + tenant-scoped; terminal
 * states admit no further transitions; VERIFIED requires high-grade
 * evidence + an attestation (never model/self-assessed alone —
 * architecture-lock §4); every transition emits audit lineage carrying
 * the AUTHORITATIVE transaction id.
 *
 * Evidence: exhaustive matrix tests + authorization + audit lineage tests.
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import {
  PROOF_OF_VALUE_TRANSITION_TABLE,
  transitionTableFor,
  legalTargets,
  findRule,
  ALL_LIFECYCLE_STATES,
} from "../../src/workflows/transition-table.ts";
import { evaluateTransition } from "../../src/workflows/state-machine.ts";
import { createExecutionContext } from "../../src/core/execution-context.ts";
import {
  createNetW005Harness,
  actorCtx,
  createOpportunitySubject,
  createContributionSubject,
  createEvidence,
  createProofOfValue,
  povTransitionInput,
  type NetW005Harness,
} from "./_net-w005-harness.ts";

let harness: NetW005Harness;

beforeEach(async () => {
  harness = await createNetW005Harness();
});

afterEach(async () => {
  await harness.teardown();
});

describe("NET-W005-AC-06 PoV transition matrix (exhaustive)", () => {
  test("the PoV table enumerates EXACTLY the 8 legal transitions (work order §3.8)", () => {
    expect(PROOF_OF_VALUE_TRANSITION_TABLE.length).toBe(8);
    const pairs = PROOF_OF_VALUE_TRANSITION_TABLE.map((r) => `${r.from}→${r.to}`).sort();
    expect(pairs).toEqual([
      "DRAFT→CANCELLED",
      "DRAFT→MEASURING",
      "EVALUATING→CANCELLED",
      "EVALUATING→REJECTED",
      "EVALUATING→VERIFIED",
      "MEASURING→CANCELLED",
      "MEASURING→EVALUATING",
      "MEASURING→REJECTED",
    ]);
    // Every rule carries a policy action + audit event name.
    for (const rule of PROOF_OF_VALUE_TRANSITION_TABLE) {
      expect(rule.policyAction).toMatch(/^proof_of_value\.transition\./);
      expect(rule.auditEventName).toMatch(/^proof_of_value\.transition\./);
    }
  });

  test("every legal PoV transition evaluates legal; every OTHER state pair is rejected (exhaustive matrix)", () => {
    const execution = createExecutionContext({
      correlationId: "matrix",
      actor: { id: "p", kind: "person" },
    });
    const terminal = ["VERIFIED", "REJECTED", "CANCELLED"];
    let legalCount = 0;
    for (const from of ALL_LIFECYCLE_STATES()) {
      for (const to of ALL_LIFECYCLE_STATES()) {
        const rule = findRule("proof_of_value", from, to);
        const subject = {
          id: "pov",
          kind: "proof_of_value" as const,
          state: from,
          version: 0,
          organizationScopeId: "org",
          ownerId: "p",
          executionId: "e",
          correlationId: "c",
          causationId: null,
          createdAt: "t",
          updatedAt: "t",
        };
        const evaluation = evaluateTransition({
          subject,
          targetState: to,
          expectedVersion: 0,
          execution,
        });
        if (rule) {
          legalCount += 1;
          expect(evaluation.legal).toBe(true);
          expect(evaluation.rule?.auditEventName).toBe(rule.auditEventName);
        } else {
          expect(evaluation.legal).toBe(false);
          // Terminal sources produce TerminalStateError; every other
          // illegal pair produces IllegalTransitionError (stable codes).
          if (terminal.includes(from)) {
            expect(evaluation.error?.code).toBe("TERMINAL_STATE");
          } else {
            expect(evaluation.error?.code).toBe("ILLEGAL_TRANSITION");
          }
        }
      }
    }
    expect(legalCount).toBe(8);
    // Terminal states have no legal outgoing transitions.
    for (const t of terminal) {
      expect(legalTargets("proof_of_value", t as never)).toEqual([]);
    }
    // DRAFT's legal targets are exactly MEASURING + CANCELLED.
    expect([...legalTargets("proof_of_value", "DRAFT")].sort()).toEqual([
      "CANCELLED",
      "MEASURING",
    ]);
    // The opportunity/contribution tables are UNAFFECTED (no PoV rules
    // leaked into them): DRAFT→MEASURING is illegal for opportunities.
    expect(findRule("opportunity", "DRAFT", "MEASURING")).toBeNull();
    expect(findRule("contribution", "SETTLED", "VERIFIED")).not.toBeNull();
    expect(transitionTableFor("proof_of_value")).toBe(PROOF_OF_VALUE_TRANSITION_TABLE);
  });

  test("DRAFT → REJECTED is intentionally ILLEGAL (rejection is an evaluation outcome)", () => {
    const rule = findRule("proof_of_value", "DRAFT", "REJECTED");
    expect(rule).toBeNull();
  });
});

describe("NET-W005-AC-06 PoV lifecycle end-to-end (authorized, idempotent, auditable)", () => {
  test("the full happy path: DRAFT → MEASURING → EVALUATING → aggregate → attest → VERIFIED", async () => {
    const opp = await createOpportunitySubject(harness);
    const subject = await createContributionSubject(harness, opp.id);
    const eMeasured = await createEvidence(harness, subject.id, {
      sourceType: "platform",
      sourceId: "inst-a",
      point: 0.95,
      lower: 0.9,
      upper: 0.99,
    });
    const eProvider = await createEvidence(harness, subject.id, {
      sourceType: "provider",
      sourceId: "provider-x",
      point: 0.7,
    });
    const proof = await createProofOfValue(harness, subject.id, {
      evidenceIds: [eMeasured.id, eProvider.id],
    });
    expect(proof.state).toBe("DRAFT");
    expect(proof.version).toBe(0);
    expect(proof.kind).toBe("proof_of_value");
    const ctx = actorCtx(harness, "ac06-happy");

    // DRAFT → MEASURING.
    const measuring = await harness.runtime.proofOfValueService.beginMeasuring(
      ctx,
      povTransitionInput(harness, proof.id, 0, "ac06-step1"),
    );
    expect(measuring.executed).toBe(true);
    expect(measuring.proof.state).toBe("MEASURING");
    expect(measuring.proof.version).toBe(1);
    expect(measuring.auditEventName).toBe("proof_of_value.transition.draft_to_measuring");
    // The authoritative transaction id is carried (correct lineage).
    expect(measuring.transactionId).toBeTruthy();
    expect(measuring.transactionId).not.toBe(measuring.executionId);

    // Attach an attestation during MEASURING over the attached evidence.
    const attestation = await harness.runtime.attestationService.createAttestation(ctx, {
      organizationScopeId: harness.organizationScopeId,
      verifierId: harness.personId,
      statement: "Independently reviewed the attached evidence.",
      evidenceIds: [eMeasured.id, eProvider.id],
    });
    const withAttestation = await harness.runtime.proofOfValueService.attachAttestation(
      ctx,
      proof.id,
      attestation.id,
    );
    expect(withAttestation.attestationIds).toEqual([attestation.id]);

    // MEASURING → EVALUATING (≥1 evidence precondition satisfied).
    const evaluating = await harness.runtime.proofOfValueService.completeEvidenceGathering(
      ctx,
      povTransitionInput(harness, proof.id, 1, "ac06-step2"),
    );
    expect(evaluating.proof.state).toBe("EVALUATING");
    expect(evaluating.proof.version).toBe(2);

    // Aggregate (deterministic).
    const aggregated = await harness.runtime.proofOfValueService.aggregateEvidence(
      ctx,
      proof.id,
    );
    expect(aggregated.aggregation).not.toBeNull();
    expect(aggregated.aggregation!.evidenceCount).toBe(2);

    // EVALUATING → VERIFIED (aggregation + high-grade evidence + attestation).
    const verified = await harness.runtime.proofOfValueService.verify(
      ctx,
      povTransitionInput(harness, proof.id, 2, "ac06-step3"),
    );
    expect(verified.proof.state).toBe("VERIFIED");
    expect(verified.proof.version).toBe(3);
    expect(verified.auditEventName).toBe("proof_of_value.transition.evaluating_to_verified");

    // VERIFIED is terminal: no further transition is legal.
    await expect(
      harness.runtime.proofOfValueService.cancel(
        ctx,
        povTransitionInput(harness, proof.id, 3, "ac06-after-terminal"),
      ),
    ).rejects.toThrow();
  });

  test("VERIFIED is BLOCKED on model-assessed + self-reported evidence alone (architecture-lock §4)", async () => {
    const opp = await createOpportunitySubject(harness);
    const subject = await createContributionSubject(harness, opp.id);
    // ONLY model-assessed + self-reported evidence — no MEASURED/ATTESTED.
    const eModel = await createEvidence(harness, subject.id, {
      sourceType: "model",
      sourceId: "llm-a",
      point: 0.99,
    });
    const eSelf = await createEvidence(harness, subject.id, {
      sourceType: "self",
      sourceId: "participant-b",
      point: 0.99,
    });
    const proof = await createProofOfValue(harness, subject.id, {
      evidenceIds: [eModel.id, eSelf.id],
    });
    const ctx = actorCtx(harness, "ac06-model-only");
    await harness.runtime.proofOfValueService.beginMeasuring(
      ctx,
      povTransitionInput(harness, proof.id, 0, "ac06-model-begin"),
    );
    const attestation = await harness.runtime.attestationService.createAttestation(ctx, {
      organizationScopeId: harness.organizationScopeId,
      verifierId: harness.personId,
      statement: "Even with an attestation, model/self evidence alone is not enough.",
      evidenceIds: [eModel.id, eSelf.id],
    });
    await harness.runtime.proofOfValueService.attachAttestation(ctx, proof.id, attestation.id);
    await harness.runtime.proofOfValueService.completeEvidenceGathering(
      ctx,
      povTransitionInput(harness, proof.id, 1, "ac06-model-complete"),
    );
    await harness.runtime.proofOfValueService.aggregateEvidence(ctx, proof.id);

    // The deterministic VERIFIED precondition REJECTS: no MEASURED or
    // ATTESTED evidence — AI output and self-reports are input evidence
    // only, never authoritative.
    await expect(
      harness.runtime.proofOfValueService.verify(
        ctx,
        povTransitionInput(harness, proof.id, 2, "ac06-model-verify"),
      ),
    ).rejects.toThrow(/MEASURED or ATTESTED/);

    // The PoV can still be REJECTED (the honest evaluation outcome).
    const rejected = await harness.runtime.proofOfValueService.reject(
      ctx,
      povTransitionInput(harness, proof.id, 2, "ac06-model-reject"),
    );
    expect(rejected.proof.state).toBe("REJECTED");
  });

  test("VERIFIED requires aggregation BEFORE verification (deterministic ordering)", async () => {
    const opp = await createOpportunitySubject(harness);
    const subject = await createContributionSubject(harness, opp.id);
    const eMeasured = await createEvidence(harness, subject.id, { sourceId: "inst-a" });
    const proof = await createProofOfValue(harness, subject.id, {
      evidenceIds: [eMeasured.id],
    });
    const ctx = actorCtx(harness, "ac06-no-aggregation");
    await harness.runtime.proofOfValueService.beginMeasuring(
      ctx,
      povTransitionInput(harness, proof.id, 0, "ac06-na-begin"),
    );
    const attestation = await harness.runtime.attestationService.createAttestation(ctx, {
      organizationScopeId: harness.organizationScopeId,
      verifierId: harness.personId,
      statement: "Reviewed.",
      evidenceIds: [eMeasured.id],
    });
    await harness.runtime.proofOfValueService.attachAttestation(ctx, proof.id, attestation.id);
    await harness.runtime.proofOfValueService.completeEvidenceGathering(
      ctx,
      povTransitionInput(harness, proof.id, 1, "ac06-na-complete"),
    );
    await expect(
      harness.runtime.proofOfValueService.verify(
        ctx,
        povTransitionInput(harness, proof.id, 2, "ac06-na-verify"),
      ),
    ).rejects.toThrow(/aggregated/);
  });

  test("VERIFIED requires at least one ATTACHED attestation", async () => {
    const opp = await createOpportunitySubject(harness);
    const subject = await createContributionSubject(harness, opp.id);
    const eMeasured = await createEvidence(harness, subject.id, { sourceId: "inst-a" });
    const proof = await createProofOfValue(harness, subject.id, {
      evidenceIds: [eMeasured.id],
    });
    const ctx = actorCtx(harness, "ac06-no-attestation");
    await harness.runtime.proofOfValueService.beginMeasuring(
      ctx,
      povTransitionInput(harness, proof.id, 0, "ac06-natt-begin"),
    );
    await harness.runtime.proofOfValueService.completeEvidenceGathering(
      ctx,
      povTransitionInput(harness, proof.id, 1, "ac06-natt-complete"),
    );
    await harness.runtime.proofOfValueService.aggregateEvidence(ctx, proof.id);
    await expect(
      harness.runtime.proofOfValueService.verify(
        ctx,
        povTransitionInput(harness, proof.id, 2, "ac06-natt-verify"),
      ),
    ).rejects.toThrow(/attestation/);
  });

  test("MEASURING → EVALUATING requires ≥1 attached evidence (deterministic precondition)", async () => {
    const opp = await createOpportunitySubject(harness);
    const subject = await createContributionSubject(harness, opp.id);
    const proof = await createProofOfValue(harness, subject.id);
    const ctx = actorCtx(harness, "ac06-empty-gathering");
    await harness.runtime.proofOfValueService.beginMeasuring(
      ctx,
      povTransitionInput(harness, proof.id, 0, "ac06-eg-begin"),
    );
    await expect(
      harness.runtime.proofOfValueService.completeEvidenceGathering(
        ctx,
        povTransitionInput(harness, proof.id, 1, "ac06-eg-complete"),
      ),
    ).rejects.toThrow(/at least one attached evidence record/);
  });

  test("the evidence set FREEZES at EVALUATING (attach rejected afterwards)", async () => {
    const opp = await createOpportunitySubject(harness);
    const subject = await createContributionSubject(harness, opp.id);
    const e1 = await createEvidence(harness, subject.id, { sourceId: "s1" });
    const e2 = await createEvidence(harness, subject.id, { sourceId: "s2" });
    const proof = await createProofOfValue(harness, subject.id, { evidenceIds: [e1.id] });
    const ctx = actorCtx(harness, "ac06-freeze");
    await harness.runtime.proofOfValueService.beginMeasuring(
      ctx,
      povTransitionInput(harness, proof.id, 0, "ac06-fz-begin"),
    );
    // Attaching during MEASURING is fine.
    await harness.runtime.proofOfValueService.attachEvidence(ctx, proof.id, e2.id);
    await harness.runtime.proofOfValueService.completeEvidenceGathering(
      ctx,
      povTransitionInput(harness, proof.id, 1, "ac06-fz-complete"),
    );
    const e3 = await createEvidence(harness, subject.id, { sourceId: "s3" });
    // Attaching during EVALUATING is rejected (the set is frozen).
    await expect(
      harness.runtime.proofOfValueService.attachEvidence(ctx, proof.id, e3.id),
    ).rejects.toThrow(/frozen|allowed: DRAFT, MEASURING/i);
  });

  test("the PoV service NEVER mutates lifecycle state directly (workflow authority)", async () => {
    // The port declares no setState/transition mutation method.
    const service = harness.runtime.proofOfValueService as unknown as Record<string, unknown>;
    for (const forbidden of ["setState", "setVersion", "transition", "saveWithinTx"]) {
      expect(service[forbidden]).toBeUndefined();
    }
    // Runtime proof: only the WORKFLOW service performs transitions —
    // attaching evidence (a domain mutation) does NOT change state/version.
    const opp = await createOpportunitySubject(harness);
    const subject = await createContributionSubject(harness, opp.id);
    const e1 = await createEvidence(harness, subject.id, { sourceId: "s1" });
    const proof = await createProofOfValue(harness, subject.id);
    const ctx = actorCtx(harness, "ac06-authority");
    const afterAttach = await harness.runtime.proofOfValueService.attachEvidence(
      ctx,
      proof.id,
      e1.id,
    );
    expect(afterAttach.state).toBe("DRAFT");
    expect(afterAttach.version).toBe(0);
    expect(afterAttach.evidenceIds).toEqual([e1.id]);
    // The transition DOES change state/version (through /workflows).
    const afterTransition = await harness.runtime.proofOfValueService.beginMeasuring(
      ctx,
      povTransitionInput(harness, proof.id, 0, "ac06-auth-begin"),
    );
    expect(afterTransition.proof.state).toBe("MEASURING");
    expect(afterTransition.proof.version).toBe(1);
  });

  test("a transition on a PoV in ANOTHER organization is DENIED (tenant scoping)", async () => {
    const opp = await createOpportunitySubject(harness);
    const subject = await createContributionSubject(harness, opp.id);
    const proof = await createProofOfValue(harness, subject.id);
    const ctx = actorCtx(harness, "ac06-cross-org");

    // A person with NO policies in the harness org (deny-by-default):
    // the workflow authorizer checks the PoV's organizationScopeId
    // against the actor's policies.
    const outsider = await harness.runtime.identityService.createIdentity(
      harness.bootstrapCtx,
      {
        displayName: "Outsider",
        subjectReferences: [{ subjectId: "outsider@example.com", providerKind: "internal" }],
      },
    );
    const outsiderCtx = createExecutionContext({
      correlationId: "ac06-cross-org",
      actor: { id: outsider.id, kind: "person" },
    });
    await expect(
      harness.runtime.proofOfValueService.beginMeasuring(outsiderCtx, {
        proofId: proof.id,
        expectedVersion: 0,
        idempotencyKey: "ac06-cross-org",
        actorPersonId: outsider.id,
      }),
    ).rejects.toThrow(/denied/i);
    // The harness person (with policies on the harness org) succeeds.
    const ok = await harness.runtime.proofOfValueService.beginMeasuring(
      ctx,
      povTransitionInput(harness, proof.id, 0, "ac06-cross-org-ok"),
    );
    expect(ok.proof.state).toBe("MEASURING");
  });

  test("every transition emits an audit record carrying the AUTHORITATIVE transaction id (not the execution id)", async () => {
    const opp = await createOpportunitySubject(harness);
    const subject = await createContributionSubject(harness, opp.id);
    const e1 = await createEvidence(harness, subject.id, { sourceId: "s1" });
    const proof = await createProofOfValue(harness, subject.id, { evidenceIds: [e1.id] });
    const ctx = actorCtx(harness, "ac06-audit-lineage");
    const result = await harness.runtime.proofOfValueService.beginMeasuring(
      ctx,
      povTransitionInput(harness, proof.id, 0, "ac06-al"),
    );
    const events = await harness.runtime.auditWriter.query({
      eventType: "proof_of_value.transition.draft_to_measuring",
      resourceId: proof.id,
    });
    expect(events.length).toBe(1);
    const ev = events[0]!;
    expect(ev.metadata?.transactionId).toBe(result.transactionId);
    expect(ev.metadata?.transactionId).not.toBe(ctx.executionId);
    expect(ev.metadata?.fromState).toBe("DRAFT");
    expect(ev.metadata?.toState).toBe("MEASURING");
    expect(ev.metadata?.idempotencyKey).toBe("ac06-al");
  });
});
