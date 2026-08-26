/**
 * NET-W002-AC-01 — Unified identity.
 *
 * A single canonical person identity can be associated with multiple
 * organizations and multiple participant roles without creating duplicate
 * canonical identities.
 *
 * Evidence: integration test covering one identity → two memberships →
 * multiple roles.
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { createRuntime, type Runtime } from "../../src/bootstrap/runtime.ts";
import { createExecutionContext } from "../../src/core/execution-context.ts";
import { ConflictError } from "../../src/core/errors.ts";

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

describe("NET-W002-AC-01 unified identity", () => {
  test("one identity holds multiple memberships across two organizations and multiple roles", async () => {
    const ctx = createExecutionContext({ correlationId: "ac01-1", actor: { id: "bootstrap", kind: "service" } });

    // 1) Create ONE canonical person identity.
    const person = await runtime.identityService.createIdentity(ctx, {
      displayName: "Ada Lovelace",
      subjectReferences: [{ subjectId: "ada@example.com", providerKind: "internal" }],
    });
    expect(person.id).toBeTruthy();
    expect(person.subjectReferences).toHaveLength(1);

    // 2) Create two organizations.
    const orgA = await runtime.organizationService.createOrganization(ctx, {
      name: "Org A",
      creatorId: person.id,
    });
    const orgB = await runtime.organizationService.createOrganization(ctx, {
      name: "Org B",
      creatorId: person.id,
    });
    expect(orgA.id).not.toBe(orgB.id);

    // 3) Grant the SAME identity a membership in both organizations.
    const m1 = await runtime.membershipService.grantMembership(ctx, {
      personId: person.id,
      organizationId: orgA.id,
      grantedBy: person.id,
    });
    const m2 = await runtime.membershipService.grantMembership(ctx, {
      personId: person.id,
      organizationId: orgB.id,
      grantedBy: person.id,
    });
    expect(m1.created).toBe(true);
    expect(m2.created).toBe(true);
    expect(m1.membership.organizationId).toBe(orgA.id);
    expect(m2.membership.organizationId).toBe(orgB.id);

    // 4) The SAME identity is now a participant holding MULTIPLE roles.
    const participant = await runtime.participantService.createParticipant(ctx, {
      kind: "person",
      referenceId: person.id,
      roles: ["PERSON", "CREATOR"],
      createdBy: person.id,
    });
    expect(participant.roles).toEqual(["PERSON", "CREATOR"]);

    // 5) Add a third role to the same participant.
    const added = await runtime.participantService.addRole(ctx, {
      participantId: participant.id,
      role: "ADVERTISER",
      addedBy: person.id,
    });
    expect(added.added).toBe(true);
    expect(added.participant.roles).toEqual(["PERSON", "CREATOR", "ADVERTISER"]);

    // 6) Verify the identity is NOT duplicated: there is exactly ONE
    //    canonical identity linked to the subject reference.
    const resolved = await runtime.identityService.resolve({
      subject: { subjectId: "ada@example.com", providerKind: "internal" },
    });
    expect(resolved).not.toBeNull();
    expect(resolved!.id).toBe(person.id);

    // 7) The participant is linked to the SAME canonical identity.
    const byRef = await runtime.participantService.resolveByReference(ctx, person.id);
    expect(byRef).not.toBeNull();
    expect(byRef!.referenceId).toBe(person.id);
    expect(byRef!.id).toBe(participant.id);

    // 8) The membership list for the identity spans both organizations.
    const memberships = await runtime.membershipService.listForPerson(ctx, person.id);
    expect(memberships).toHaveLength(2);
    const orgIds = memberships.map((m) => m.organizationId).sort();
    expect(orgIds).toEqual([orgA.id, orgB.id].sort());
  });

  test("re-saving a subject reference linked to a different identity is rejected (no duplicate identity)", async () => {
    const ctx = createExecutionContext({ correlationId: "ac01-2", actor: { id: "bootstrap", kind: "service" } });

    // Identity 1 linked to subject "shared@example.com".
    const p1 = await runtime.identityService.createIdentity(ctx, {
      displayName: "First",
      subjectReferences: [{ subjectId: "shared@example.com", providerKind: "internal" }],
    });

    // Attempting to create a SECOND identity linked to the SAME subject
    // must fail with ConflictError — one subject → one canonical identity.
    await expect(
      runtime.identityService.createIdentity(ctx, {
        displayName: "Second",
        subjectReferences: [{ subjectId: "shared@example.com", providerKind: "internal" }],
      }),
    ).rejects.toThrow(ConflictError);

    // p1 is still the only identity for that subject.
    const resolved = await runtime.identityService.resolve({
      subject: { subjectId: "shared@example.com", providerKind: "internal" },
    });
    expect(resolved!.id).toBe(p1.id);
  });
});
