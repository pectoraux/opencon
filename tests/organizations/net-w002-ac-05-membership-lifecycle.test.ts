/**
 * NET-W002-AC-05 — Membership lifecycle.
 *
 * Membership grants, role changes and revocation are deterministic,
 * idempotent and auditable.
 *
 * Evidence: lifecycle tests + audit assertions.
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { createRuntime, type Runtime } from "../../src/bootstrap/runtime.ts";
import { createExecutionContext } from "../../src/core/execution-context.ts";
import { ConflictError, NotFoundError } from "../../src/core/errors.ts";

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

describe("NET-W002-AC-05 membership lifecycle", () => {
  test("grant is idempotent: re-granting an active membership returns the existing record (no duplicate)", async () => {
    const ctx = createExecutionContext({ correlationId: "ac05-grant", actor: { id: "bootstrap", kind: "service" } });
    const person = await runtime.identityService.createIdentity(ctx, {
      displayName: "Member",
      subjectReferences: [{ subjectId: "m@example.com", providerKind: "internal" }],
    });
    const org = await runtime.organizationService.createOrganization(ctx, { name: "Org", creatorId: person.id });

    const g1 = await runtime.membershipService.grantMembership(ctx, {
      personId: person.id,
      organizationId: org.id,
      grantedBy: person.id,
    });
    expect(g1.created).toBe(true);

    // Re-grant the same active membership → idempotent (no duplicate, no error).
    const g2 = await runtime.membershipService.grantMembership(ctx, {
      personId: person.id,
      organizationId: org.id,
      grantedBy: person.id,
    });
    expect(g2.created).toBe(false);
    expect(g2.membership.id).toBe(g1.membership.id);
    expect(g2.membership.status).toBe("active");

    // Exactly one membership record exists.
    const list = await runtime.membershipService.listForPerson(ctx, person.id);
    expect(list).toHaveLength(1);
  });

  test("revoke is idempotent: revoking an already-revoked membership is a no-op", async () => {
    const ctx = createExecutionContext({ correlationId: "ac05-revoke", actor: { id: "bootstrap", kind: "service" } });
    const person = await runtime.identityService.createIdentity(ctx, {
      displayName: "Member",
      subjectReferences: [{ subjectId: "m2@example.com", providerKind: "internal" }],
    });
    const org = await runtime.organizationService.createOrganization(ctx, { name: "Org", creatorId: person.id });
    const g = await runtime.membershipService.grantMembership(ctx, {
      personId: person.id,
      organizationId: org.id,
      grantedBy: person.id,
    });

    const r1 = await runtime.membershipService.revokeMembership(ctx, g.membership.id, person.id);
    expect(r1.already).toBe(false);
    expect(r1.membership.status).toBe("revoked");
    expect(r1.membership.revokedAt).not.toBeNull();
    expect(r1.membership.revokedBy).toBe(person.id);

    // Re-revoking → no-op (already revoked).
    const r2 = await runtime.membershipService.revokeMembership(ctx, g.membership.id, person.id);
    expect(r2.already).toBe(true);
    expect(r2.membership.revokedAt).toBe(r1.membership.revokedAt);
  });

  test("revoking a non-existent membership throws NotFoundError", async () => {
    const ctx = createExecutionContext({ correlationId: "ac05-notfound", actor: { id: "bootstrap", kind: "service" } });
    const person = await runtime.identityService.createIdentity(ctx, {
      displayName: "Revoker",
      subjectReferences: [{ subjectId: "r@example.com", providerKind: "internal" }],
    });
    await expect(
      runtime.membershipService.revokeMembership(ctx, "nonexistent-id", person.id),
    ).rejects.toThrow(NotFoundError);
  });

  test("grant after revoke requires a new membership record (revoked is terminal)", async () => {
    const ctx = createExecutionContext({ correlationId: "ac05-terminal", actor: { id: "bootstrap", kind: "service" } });
    const person = await runtime.identityService.createIdentity(ctx, {
      displayName: "Member",
      subjectReferences: [{ subjectId: "m3@example.com", providerKind: "internal" }],
    });
    const org = await runtime.organizationService.createOrganization(ctx, { name: "Org", creatorId: person.id });
    const g = await runtime.membershipService.grantMembership(ctx, {
      personId: person.id,
      organizationId: org.id,
      grantedBy: person.id,
    });
    await runtime.membershipService.revokeMembership(ctx, g.membership.id, person.id);

    // Attempting to re-grant the revoked membership → ConflictError.
    await expect(
      runtime.membershipService.grantMembership(ctx, {
        personId: person.id,
        organizationId: org.id,
        grantedBy: person.id,
      }),
    ).rejects.toThrow(ConflictError);
  });

  test("membership grant and revoke both emit audit records with actor/subject/resource IDs", async () => {
    const ctx = createExecutionContext({ correlationId: "ac05-audit", actor: { id: "bootstrap", kind: "service" } });
    const person = await runtime.identityService.createIdentity(ctx, {
      displayName: "Audited Member",
      subjectReferences: [{ subjectId: "am@example.com", providerKind: "internal" }],
    });
    const org = await runtime.organizationService.createOrganization(ctx, { name: "Org", creatorId: person.id });

    const beforeCount = await runtime.auditWriter.count();
    const g = await runtime.membershipService.grantMembership(ctx, {
      personId: person.id,
      organizationId: org.id,
      grantedBy: person.id,
    });
    await runtime.membershipService.revokeMembership(ctx, g.membership.id, person.id);
    const afterCount = await runtime.auditWriter.count();

    // Two new audit records (grant + revoke).
    expect(afterCount - beforeCount).toBe(2);

    const events = await runtime.auditWriter.query({ correlationId: "ac05-audit" });
    const grantEvt = events.find((e) => e.eventType === "organization.membership_granted");
    const revokeEvt = events.find((e) => e.eventType === "organization.membership_revoked");
    expect(grantEvt).toBeDefined();
    expect(revokeEvt).toBeDefined();

    // Audit lineage carries actor, subject, resource, execution+correlation IDs.
    expect(grantEvt!.actor).not.toBeNull();
    expect(grantEvt!.subject).toBe(person.id);
    expect(grantEvt!.resourceType).toBe("membership");
    expect(grantEvt!.resourceId).toBe(g.membership.id);
    expect(grantEvt!.correlationId).toBe("ac05-audit");
    expect(grantEvt!.executionId).toBe(ctx.executionId);

    expect(revokeEvt!.actor).not.toBeNull();
    expect(revokeEvt!.subject).toBe(person.id);
    expect(revokeEvt!.resourceType).toBe("membership");
    expect(revokeEvt!.resourceId).toBe(g.membership.id);
    expect(revokeEvt!.correlationId).toBe("ac05-audit");
    expect(revokeEvt!.executionId).toBe(ctx.executionId);
  });

  test("role changes (add/remove) are idempotent and auditable", async () => {
    const ctx = createExecutionContext({ correlationId: "ac05-roles", actor: { id: "bootstrap", kind: "service" } });
    const person = await runtime.identityService.createIdentity(ctx, {
      displayName: "Role Member",
      subjectReferences: [{ subjectId: "rm@example.com", providerKind: "internal" }],
    });
    const participant = await runtime.participantService.createParticipant(ctx, {
      kind: "person",
      referenceId: person.id,
      roles: ["PERSON"],
      createdBy: person.id,
    });

    const beforeCount = await runtime.auditWriter.count();

    // Add CREATOR role.
    const add1 = await runtime.participantService.addRole(ctx, {
      participantId: participant.id,
      role: "CREATOR",
      addedBy: person.id,
    });
    expect(add1.added).toBe(true);

    // Re-add CREATOR → idempotent (no duplicate audit).
    const add2 = await runtime.participantService.addRole(ctx, {
      participantId: participant.id,
      role: "CREATOR",
      addedBy: person.id,
    });
    expect(add2.added).toBe(false);

    // Remove CREATOR.
    const rem1 = await runtime.participantService.removeRole(ctx, {
      participantId: participant.id,
      role: "CREATOR",
      removedBy: person.id,
    });
    expect(rem1.removed).toBe(true);

    // Re-remove CREATOR → idempotent.
    const rem2 = await runtime.participantService.removeRole(ctx, {
      participantId: participant.id,
      role: "CREATOR",
      removedBy: person.id,
    });
    expect(rem2.removed).toBe(false);

    // Only ONE role_added and ONE role_removed audit record (the re-add
    // and re-remove were no-ops, no audit spam).
    const afterCount = await runtime.auditWriter.count();
    expect(afterCount - beforeCount).toBe(2);

    const events = await runtime.auditWriter.query({ correlationId: "ac05-roles" });
    const addEvt = events.find((e) => e.eventType === "participant.role_added");
    const remEvt = events.find((e) => e.eventType === "participant.role_removed");
    expect(addEvt).toBeDefined();
    expect(remEvt).toBeDefined();
    expect(addEvt!.resourceType).toBe("participant");
    expect(remEvt!.resourceType).toBe("participant");
    expect((addEvt!.metadata as { role: string }).role).toBe("CREATOR");
    expect((remEvt!.metadata as { role: string }).role).toBe("CREATOR");
  });
});
