/**
 * NET-W032-AC-01 — VALIDATOR PARTICIPANT MODEL (issue #65; work order
 * §3.1: scoped participants, explicit eligibility state, server-
 * enforced authorization, identity bound to the authenticated
 * participant — caller-supplied identity claims are not trusted).
 *
 *  - registration binds the ACTING person (self-registration only —
 *    one cannot register someone else);
 *  - the person must exist (identity lookup) and at most ONE ACTIVE
 *    participant binds a person per organization scope;
 *  - suspension is ONE-WAY (terminal; never re-activated);
 *  - cross-tenant and nonexistent reads are indistinguishable;
 *  - listing is deterministic (registeredAt, id) — the frozen
 *    assignment-selection order;
 *  - every mutation commits atomically with its audit event (the
 *    lineage metadata contract).
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import type { ExecutionContext } from "../../src/core/execution-context.ts";
import {
  createNetW032Harness,
  key,
  personCtx,
  type NetW032Harness,
} from "./_net-w032-harness.ts";

let harness: NetW032Harness;

beforeEach(async () => {
  harness = await createNetW032Harness();
});

afterEach(async () => {
  await harness.teardown();
});

describe("NET-W032-AC-01 validator participant model", () => {
  test("registration binds the ACTING person (self-registration; ACTIVE + protocol version)", async () => {
    const person = await harness.runtime.identityService.createIdentity(
      harness.bootstrapCtx,
      {
        displayName: "AC-01 Self Registrar",
        subjectReferences: [
          { subjectId: "ac01-self@example.com", providerKind: "internal" },
        ],
      },
    );
    const ctx = personCtx(harness, person.id, "ac01-register");
    const result = await harness.runtime.validatorRegistryService.registerValidator(ctx, {
      organizationScopeId: harness.organizationScopeId,
      personId: person.id,
      idempotencyKey: key("ac01-register"),
    });
    expect(result.created).toBe(true);
    expect(result.validator.personId).toBe(person.id);
    expect(result.validator.organizationScopeId).toBe(harness.organizationScopeId);
    expect(result.validator.status).toBe("ACTIVE");
    expect(result.validator.protocolVersion).toBe("NET-W032:1");
    expect(result.validator.suspendedAt).toBeNull();
  });

  test("one CANNOT register someone else (server-bound identity, not caller-asserted)", async () => {
    const actor = harness.reviewerPersonId;
    const target = harness.validatorPersonIds[0]!;
    const ctx = personCtx(harness, actor, "ac01-impersonate");
    await expect(
      harness.runtime.validatorRegistryService.registerValidator(ctx, {
        organizationScopeId: harness.organizationScopeId,
        personId: target,
        idempotencyKey: key("ac01-impersonate"),
      }),
    ).rejects.toMatchObject({
      code: "VALIDATION_VALIDATION",
      message: expect.stringContaining("self-registration only"),
    });
  });

  test("a service actor cannot register (persons only)", async () => {
    const { createExecutionContext } = await import("../../src/core/execution-context.ts");
    const systemCtx = createExecutionContext({
      correlationId: "ac01-system",
      actor: { id: "system", kind: "service" },
    });
    await expect(
      harness.runtime.validatorRegistryService.registerValidator(systemCtx as ExecutionContext, {
        organizationScopeId: harness.organizationScopeId,
        personId: harness.personId,
        idempotencyKey: key("ac01-system"),
      }),
    ).rejects.toMatchObject({
      code: "VALIDATION_VALIDATION",
      message: expect.stringContaining("person actor is required"),
    });
  });

  test("registering a nonexistent person fails NotFound", async () => {
    const ctx = personCtx(harness, "no-such-person", "ac01-nonexistent");
    await expect(
      harness.runtime.validatorRegistryService.registerValidator(ctx, {
        organizationScopeId: harness.organizationScopeId,
        personId: "no-such-person",
        idempotencyKey: key("ac01-nonexistent"),
      }),
    ).rejects.toMatchObject({
      code: "NOT_FOUND",
      message: expect.stringContaining("does not exist"),
    });
  });

  test("at most ONE ACTIVE participant per person per scope (CONFLICT); idempotent replay", async () => {
    // validator 0 is already registered by the harness.
    const ctx = personCtx(harness, harness.validatorPersonIds[0]!, "ac01-dup");
    await expect(
      harness.runtime.validatorRegistryService.registerValidator(ctx, {
        organizationScopeId: harness.organizationScopeId,
        personId: harness.validatorPersonIds[0]!,
        idempotencyKey: key("ac01-dup"),
      }),
    ).rejects.toMatchObject({
      code: "CONFLICT",
      message: expect.stringContaining("ACTIVE validator participant"),
    });
    // The SAME idempotency key replays (created: false, same record).
    const replay = await harness.runtime.validatorRegistryService.registerValidator(ctx, {
      organizationScopeId: harness.organizationScopeId,
      personId: harness.validatorPersonIds[0]!,
      idempotencyKey: `w032-register-${harness.validatorPersonIds[0]!}`,
    });
    expect(replay.created).toBe(false);
    expect(replay.validator.id).toBeDefined();
  });

  test("concurrent duplicate registrations converge to exactly one", async () => {
    const person = await harness.runtime.identityService.createIdentity(
      harness.bootstrapCtx,
      {
        displayName: "AC-01 Concurrent",
        subjectReferences: [
          { subjectId: "ac01-concurrent@example.com", providerKind: "internal" },
        ],
      },
    );
    const attempts = await Promise.allSettled(
      [1, 2, 3].map((i) =>
        harness.runtime.validatorRegistryService.registerValidator(
          personCtx(harness, person.id, `ac01-concurrent-${i}`),
          {
            organizationScopeId: harness.organizationScopeId,
            personId: person.id,
            idempotencyKey: key(`ac01-concurrent-${i}`),
          },
        ),
      ),
    );
    const created = attempts.filter(
      (a) => a.status === "fulfilled" && a.value.created === true,
    );
    const conflicts = attempts.filter((a) => a.status === "rejected");
    expect(created.length).toBe(1);
    expect(conflicts.length).toBe(2);
    for (const conflict of conflicts) {
      if (conflict.status === "rejected") {
        expect(conflict.reason.code).toBe("CONFLICT");
      }
    }
  });

  test("suspension is ONE-WAY (terminal; re-suspension is a CONFLICT)", async () => {
    const ctx = personCtx(harness, harness.reviewerPersonId, "ac01-suspend");
    const suspended = await harness.runtime.validatorRegistryService.suspendValidator(ctx, {
      organizationScopeId: harness.organizationScopeId,
      validatorId: (await harness.runtime.validatorRegistryService.listValidators(
        ctx,
        harness.organizationScopeId,
        "ACTIVE",
      ))[0]!.id,
      reason: "ac01 test suspension",
      idempotencyKey: key("ac01-suspend"),
    });
    expect(suspended.status).toBe("SUSPENDED");
    expect(suspended.suspendedAt).not.toBeNull();
    expect(suspended.suspensionReason).toBe("ac01 test suspension");
    // One-way: re-suspension is a CONFLICT, never a re-activation.
    await expect(
      harness.runtime.validatorRegistryService.suspendValidator(ctx, {
        organizationScopeId: harness.organizationScopeId,
        validatorId: suspended.id,
        reason: "again",
        idempotencyKey: key("ac01-suspend-again"),
      }),
    ).rejects.toMatchObject({
      code: "CONFLICT",
      message: expect.stringContaining("one-way"),
    });
  });

  test("cross-tenant and nonexistent validator reads are indistinguishable (no oracle)", async () => {
    const ctx = personCtx(harness, harness.reviewerPersonId, "ac01-read");
    const active = await harness.runtime.validatorRegistryService.listValidators(
      ctx,
      harness.organizationScopeId,
      "ACTIVE",
    );
    const existing = active[0]!;
    // In-scope read works.
    const found = await harness.runtime.validatorRegistryService.getValidator(
      ctx,
      harness.organizationScopeId,
      existing.id,
    );
    expect(found.id).toBe(existing.id);
    // Cross-scope and nonexistent produce the IDENTICAL NotFound.
    const crossScope = harness.runtime.validatorRegistryService.getValidator(
      ctx,
      harness.secondOrgId,
      existing.id,
    );
    const nonexistent = harness.runtime.validatorRegistryService.getValidator(
      ctx,
      harness.organizationScopeId,
      "no-such-validator",
    );
    const [crossError, missingError] = await Promise.allSettled([
      crossScope,
      nonexistent,
    ]).then((results) => [
      results[0].status === "rejected" ? results[0].reason : null,
      results[1].status === "rejected" ? results[1].reason : null,
    ]);
    expect(crossError).not.toBeNull();
    expect(missingError).not.toBeNull();
    // Identical error contract (code + message SHAPE — the message
    // echoes only the caller's own requested id; a cross-tenant read
    // reveals nothing about the other scope).
    expect(crossError!.code).toBe(missingError!.code);
    expect(crossError!.message).toContain("validator not found");
    expect(missingError!.message).toContain("validator not found");
    expect(crossError!.message).toContain(existing.id);
  });

  test("listing is deterministic (registeredAt, id) — the frozen selection order", async () => {
    const ctx = personCtx(harness, harness.reviewerPersonId, "ac01-list");
    const listed = await harness.runtime.validatorRegistryService.listValidators(
      ctx,
      harness.organizationScopeId,
      "ACTIVE",
    );
    expect(listed.map((v) => v.personId)).toEqual([...harness.orderedValidatorPersonIds]);
    const sorted = [...listed].sort((a, b) =>
      a.registeredAt === b.registeredAt ? (a.id < b.id ? -1 : 1) : a.registeredAt < b.registeredAt ? -1 : 1,
    );
    expect(listed.map((v) => v.id)).toEqual(sorted.map((v) => v.id));
  });

  test("registration + suspension commit their audit events with the lineage contract", async () => {
    const person = await harness.runtime.identityService.createIdentity(
      harness.bootstrapCtx,
      {
        displayName: "AC-01 Audit",
        subjectReferences: [
          { subjectId: "ac01-audit@example.com", providerKind: "internal" },
        ],
      },
    );
    const ctx = personCtx(harness, person.id, "ac01-audit");
    const registered = await harness.runtime.validatorRegistryService.registerValidator(ctx, {
      organizationScopeId: harness.organizationScopeId,
      personId: person.id,
      idempotencyKey: key("ac01-audit"),
    });
    const suspendCtx = personCtx(harness, harness.reviewerPersonId, "ac01-audit");
    await harness.runtime.validatorRegistryService.suspendValidator(suspendCtx, {
      organizationScopeId: harness.organizationScopeId,
      validatorId: registered.validator.id,
      reason: "ac01 audit suspension",
      idempotencyKey: key("ac01-audit-suspend"),
    });
    const registeredEvents = await harness.runtime.auditWriter.query({
      eventType: "validator.registered",
      resourceId: registered.validator.id,
    });
    expect(registeredEvents).toHaveLength(1);
    expect(registeredEvents[0]!.metadata).toMatchObject({
      organizationScopeId: harness.organizationScopeId,
      validatorId: registered.validator.id,
      personId: person.id,
      status: "ACTIVE",
      idempotencyRecordId: expect.any(String),
      transactionId: expect.any(String),
    });
    const suspendedEvents = await harness.runtime.auditWriter.query({
      eventType: "validator.suspended",
      resourceId: registered.validator.id,
    });
    expect(suspendedEvents).toHaveLength(1);
    expect(suspendedEvents[0]!.metadata).toMatchObject({
      validatorId: registered.validator.id,
      status: "SUSPENDED",
      idempotencyRecordId: expect.any(String),
      transactionId: expect.any(String),
    });
  });
});
