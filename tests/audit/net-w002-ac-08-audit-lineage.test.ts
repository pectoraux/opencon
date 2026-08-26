/**
 * NET-W002-AC-08 — Audit lineage.
 *
 * Material identity and authorization mutations emit append-oriented audit
 * records with actor, subject, resource and execution/correlation
 * identifiers.
 *
 * Evidence: integration test against the NET-W001 audit boundary.
 *
 * The NET-W001 AuditWriter (deeply-frozen, append-only) is reused. NET-W002
 * domain services call auditWriter.append() for every material mutation.
 * Records carry:
 *  - actor (canonical id of the acting principal, from ctx.actor);
 *  - subject (canonical id of the affected principal);
 *  - resourceType + resourceId (the entity mutated);
 *  - correlationId + executionId (from the ExecutionContext).
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { createRuntime, type Runtime } from "../../src/bootstrap/runtime.ts";
import { createExecutionContext } from "../../src/core/execution-context.ts";

let runtime: Runtime;

beforeEach(async () => {
  runtime = createRuntime({
    forceEnv: "test",
    env: { APP_ENV: "test", LOG_LEVEL: "warn" },
    port: 0,
  });
  await runtime.initialize();
});

afterEach(async () => {
  await runtime.shutdown();
});

describe("NET-W002-AC-08 audit lineage", () => {
  test("identity creation emits an audit record with actor/subject/resource + execution/correlation IDs", async () => {
    const ctx = createExecutionContext({
      correlationId: "ac08-identity",
      causationId: "ac08-cause",
      actor: { id: "bootstrap", kind: "service" },
    });

    const before = await runtime.auditWriter.count();
    const person = await runtime.identityService.createIdentity(ctx, {
      displayName: "Audited Identity",
      subjectReferences: [{ subjectId: "ai@example.com", providerKind: "internal" }],
    });
    const after = await runtime.auditWriter.count();
    expect(after - before).toBe(1);

    const events = await runtime.auditWriter.query({ correlationId: "ac08-identity" });
    const evt = events.find((e) => e.eventType === "identity.person_created");
    expect(evt).toBeDefined();
    expect(evt!.actor).toBe("bootstrap");
    expect(evt!.subject).toBe(person.id);
    expect(evt!.resourceType).toBe("identity");
    expect(evt!.resourceId).toBe(person.id);
    expect(evt!.correlationId).toBe("ac08-identity");
    expect(evt!.executionId).toBe(ctx.executionId);
    // Causation propagates through the context (NET-W001 §4.4).
    expect(evt!.timestamp).toBeTruthy();
  });

  test("organization creation + membership grant + revoke each emit audit records", async () => {
    const ctx = createExecutionContext({
      correlationId: "ac08-org",
      actor: { id: "bootstrap", kind: "service" },
    });
    const person = await runtime.identityService.createIdentity(ctx, {
      displayName: "Org Founder",
      subjectReferences: [{ subjectId: "of@example.com", providerKind: "internal" }],
    });
    const org = await runtime.organizationService.createOrganization(ctx, {
      name: "Audited Org",
      creatorId: person.id,
    });
    const g = await runtime.membershipService.grantMembership(ctx, {
      personId: person.id,
      organizationId: org.id,
      grantedBy: person.id,
    });
    await runtime.membershipService.revokeMembership(ctx, g.membership.id, person.id);

    const events = await runtime.auditWriter.query({ correlationId: "ac08-org" });
    const orgEvt = events.find((e) => e.eventType === "organization.created");
    const grantEvt = events.find((e) => e.eventType === "organization.membership_granted");
    const revokeEvt = events.find((e) => e.eventType === "organization.membership_revoked");

    expect(orgEvt).toBeDefined();
    expect(grantEvt).toBeDefined();
    expect(revokeEvt).toBeDefined();

    // Each carries the right resource + actor + subject + IDs.
    expect(orgEvt!.resourceType).toBe("organization");
    expect(orgEvt!.resourceId).toBe(org.id);
    expect(orgEvt!.actor).toBe("bootstrap");

    expect(grantEvt!.resourceType).toBe("membership");
    expect(grantEvt!.resourceId).toBe(g.membership.id);
    expect(grantEvt!.subject).toBe(person.id);

    expect(revokeEvt!.resourceType).toBe("membership");
    expect(revokeEvt!.resourceId).toBe(g.membership.id);
    expect(revokeEvt!.subject).toBe(person.id);

    // All share the same correlation + execution IDs (same request scope).
    for (const e of [orgEvt!, grantEvt!, revokeEvt!]) {
      expect(e.correlationId).toBe("ac08-org");
      expect(e.executionId).toBe(ctx.executionId);
    }
  });

  test("participant role add/remove + policy change each emit audit records", async () => {
    const ctx = createExecutionContext({
      correlationId: "ac08-roles",
      actor: { id: "bootstrap", kind: "service" },
    });
    const person = await runtime.identityService.createIdentity(ctx, {
      displayName: "Role Audit",
      subjectReferences: [{ subjectId: "ra@example.com", providerKind: "internal" }],
    });
    const participant = await runtime.participantService.createParticipant(ctx, {
      kind: "person",
      referenceId: person.id,
      roles: ["PERSON"],
      createdBy: person.id,
    });
    await runtime.participantService.addRole(ctx, {
      participantId: participant.id,
      role: "CREATOR",
      addedBy: person.id,
    });
    await runtime.participantService.removeRole(ctx, {
      participantId: participant.id,
      role: "CREATOR",
      removedBy: person.id,
    });
    await runtime.policyService.createPolicy(ctx, {
      subject: person.id,
      action: "organization.create",
      resource: "*",
      effect: "allow",
      createdBy: "bootstrap",
    });

    const events = await runtime.auditWriter.query({ correlationId: "ac08-roles" });
    const addEvt = events.find((e) => e.eventType === "participant.role_added");
    const remEvt = events.find((e) => e.eventType === "participant.role_removed");
    const polEvt = events.find((e) => e.eventType === "authorization.policy_changed");

    expect(addEvt).toBeDefined();
    expect(remEvt).toBeDefined();
    expect(polEvt).toBeDefined();

    expect(addEvt!.resourceType).toBe("participant");
    expect(addEvt!.resourceId).toBe(participant.id);
    expect((addEvt!.metadata as { role: string }).role).toBe("CREATOR");

    expect(remEvt!.resourceType).toBe("participant");
    expect(remEvt!.resourceId).toBe(participant.id);
    expect((remEvt!.metadata as { role: string }).role).toBe("CREATOR");

    expect(polEvt!.resourceType).toBe("policy");
    expect((polEvt!.metadata as { policyEffect: string }).policyEffect).toBe("allow");
    expect((polEvt!.metadata as { policyAction: string }).policyAction).toBe("organization.create");
  });

  test("audit records are deeply immutable (NET-W001 boundary preserved by NET-W002 lineage)", async () => {
    const ctx = createExecutionContext({
      correlationId: "ac08-immut",
      actor: { id: "bootstrap", kind: "service" },
    });
    await runtime.identityService.createIdentity(ctx, {
      displayName: "Immut",
      subjectReferences: [{ subjectId: "im@example.com", providerKind: "internal" }],
    });
    const events = await runtime.auditWriter.query({ correlationId: "ac08-immut" });
    expect(events.length).toBe(1);
    const evt = events[0]!;
    // Nested metadata is deeply frozen (NET-W001-AC-06 deep immutability).
    const meta = evt.metadata as { subjectCount?: number };
    expect(() => {
      (meta as { subjectCount: number }).subjectCount = 999;
    }).toThrow();
  });

  test("audit records carry a stable event id (unique per mutation)", async () => {
    const ctx = createExecutionContext({
      correlationId: "ac08-eid",
      actor: { id: "bootstrap", kind: "service" },
    });
    const p1 = await runtime.identityService.createIdentity(ctx, {
      displayName: "A",
      subjectReferences: [{ subjectId: "a@example.com", providerKind: "internal" }],
    });
    const p2 = await runtime.identityService.createIdentity(ctx, {
      displayName: "B",
      subjectReferences: [{ subjectId: "b@example.com", providerKind: "internal" }],
    });
    const events = await runtime.auditWriter.query({ correlationId: "ac08-eid" });
    const ids = events.map((e) => e.eventId);
    expect(new Set(ids).size).toBe(ids.length); // all unique
    // Both record the right subject (canonical id of the created identity).
    const subjects = events.map((e) => e.subject).sort();
    expect(subjects).toEqual([p1.id, p2.id].sort());
  });
});
