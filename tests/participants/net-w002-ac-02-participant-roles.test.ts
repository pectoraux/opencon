/**
 * NET-W002-AC-02 — Participant roles.
 *
 * All v1.0 participant roles are representable, persistable and
 * independently assignable to a participant.
 *
 * Evidence: domain/persistence test covering the complete role set.
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { createRuntime, type Runtime } from "../../src/bootstrap/runtime.ts";
import { createExecutionContext } from "../../src/core/execution-context.ts";
import { PARTICIPANT_ROLES, type ParticipantRole } from "../../src/participants/port.ts";
import { OpenConError } from "../../src/core/errors.ts";

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

describe("NET-W002-AC-02 participant roles", () => {
  test("the complete v1.0 role set is the frozen 9 roles", () => {
    expect(PARTICIPANT_ROLES).toEqual([
      "PERSON",
      "CREATOR",
      "COMPANY",
      "ADVERTISER",
      "PUBLISHER",
      "APP",
      "SUPPLIER",
      "COMMUNITY",
      "MEASUREMENT_PROVIDER",
    ]);
    expect(PARTICIPANT_ROLES.length).toBe(9);
  });

  test("every v1.0 role is independently assignable to a participant", async () => {
    const ctx = createExecutionContext({ correlationId: "ac02-1", actor: { id: "bootstrap", kind: "service" } });

    // Create one identity + one participant with NO roles.
    const person = await runtime.identityService.createIdentity(ctx, {
      displayName: "Role Tester",
      subjectReferences: [{ subjectId: "roles@example.com", providerKind: "internal" }],
    });
    const participant = await runtime.participantService.createParticipant(ctx, {
      kind: "person",
      referenceId: person.id,
      roles: [],
      createdBy: person.id,
    });
    expect(participant.roles).toEqual([]);

    // Independently assign each of the 9 roles one at a time.
    for (const role of PARTICIPANT_ROLES) {
      const result = await runtime.participantService.addRole(ctx, {
        participantId: participant.id,
        role,
        addedBy: person.id,
      });
      expect(result.added).toBe(true);
      expect(result.participant.roles).toContain(role);
    }

    // The participant now holds all 9 roles.
    const final = await runtime.participantService.getParticipant(ctx, participant.id);
    expect(final.roles.length).toBe(9);
    expect([...final.roles].sort()).toEqual([...PARTICIPANT_ROLES].sort());
  });

  test("a participant may hold multiple roles simultaneously (no overwrite)", async () => {
    const ctx = createExecutionContext({ correlationId: "ac02-2", actor: { id: "bootstrap", kind: "service" } });

    const person = await runtime.identityService.createIdentity(ctx, {
      displayName: "Multi Role",
      subjectReferences: [{ subjectId: "multi@example.com", providerKind: "internal" }],
    });
    const participant = await runtime.participantService.createParticipant(ctx, {
      kind: "person",
      referenceId: person.id,
      roles: ["PERSON", "CREATOR"],
      createdBy: person.id,
    });

    // Adding a third role does not remove the first two.
    const r1 = await runtime.participantService.addRole(ctx, {
      participantId: participant.id,
      role: "ADVERTISER",
      addedBy: person.id,
    });
    expect(r1.participant.roles).toEqual(["PERSON", "CREATOR", "ADVERTISER"]);

    // Adding a fourth role.
    const r2 = await runtime.participantService.addRole(ctx, {
      participantId: participant.id,
      role: "PUBLISHER",
      addedBy: person.id,
    });
    expect(r2.participant.roles).toEqual(["PERSON", "CREATOR", "ADVERTISER", "PUBLISHER"]);
  });

  test("role removal is independent (removes one role, leaves others)", async () => {
    const ctx = createExecutionContext({ correlationId: "ac02-3", actor: { id: "bootstrap", kind: "service" } });

    const person = await runtime.identityService.createIdentity(ctx, {
      displayName: "Remover",
      subjectReferences: [{ subjectId: "rem@example.com", providerKind: "internal" }],
    });
    const participant = await runtime.participantService.createParticipant(ctx, {
      kind: "person",
      referenceId: person.id,
      roles: ["PERSON", "CREATOR", "ADVERTISER"],
      createdBy: person.id,
    });

    // Remove CREATOR only.
    const removed = await runtime.participantService.removeRole(ctx, {
      participantId: participant.id,
      role: "CREATOR",
      removedBy: person.id,
    });
    expect(removed.removed).toBe(true);
    expect(removed.participant.roles).toEqual(["PERSON", "ADVERTISER"]);
  });

  test("an invalid role is rejected (not part of the v1.0 set)", async () => {
    const ctx = createExecutionContext({ correlationId: "ac02-4", actor: { id: "bootstrap", kind: "service" } });

    const person = await runtime.identityService.createIdentity(ctx, {
      displayName: "Invalid Role",
      subjectReferences: [{ subjectId: "inv@example.com", providerKind: "internal" }],
    });
    const participant = await runtime.participantService.createParticipant(ctx, {
      kind: "person",
      referenceId: person.id,
      roles: ["PERSON"],
      createdBy: person.id,
    });

    // A role outside the v1.0 set must be rejected.
    await expect(
      runtime.participantService.addRole(ctx, {
        participantId: participant.id,
        role: "SUPERADMIN" as ParticipantRole,
        addedBy: person.id,
      }),
    ).rejects.toThrow(OpenConError);
  });

  test("organizations can hold roles too (not just persons)", async () => {
    const ctx = createExecutionContext({ correlationId: "ac02-5", actor: { id: "bootstrap", kind: "service" } });

    // An organization can be a COMPANY participant.
    const person = await runtime.identityService.createIdentity(ctx, {
      displayName: "Org Admin",
      subjectReferences: [{ subjectId: "orgadmin@example.com", providerKind: "internal" }],
    });
    const org = await runtime.organizationService.createOrganization(ctx, {
      name: "Acme Corp",
      creatorId: person.id,
    });
    const orgParticipant = await runtime.participantService.createParticipant(ctx, {
      kind: "organization",
      referenceId: org.id,
      roles: ["COMPANY", "ADVERTISER"],
      createdBy: person.id,
    });
    expect(orgParticipant.kind).toBe("organization");
    expect(orgParticipant.roles).toEqual(["COMPANY", "ADVERTISER"]);
  });
});
