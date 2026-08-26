/**
 * NET-W007-AC-06 — Reputation mutations are authorized, idempotent,
 * concurrent-safe, PostgreSQL-authoritative and audit-linked
 * atomically.
 *
 *  - API mutations are guarded deny-by-default (a runtime without the
 *    reputation allow policies rejects every mutation endpoint);
 *  - deterministic replay on repeated idempotency keys (exactly one
 *    mutation + one audit record) for inputs AND snapshots;
 *  - concurrent same-key recordings produce exactly one mutation
 *    (idempotency-store per-key locking — the NET-W004 primitive);
 *  - concurrent DIFFERENT-key snapshots both persist (append-only
 *    history);
 *  - an audit append failure INSIDE the transaction rolls the mutation
 *    back entirely (no record without its audit lineage);
 *  - an audit PUBLICATION failure after the durable commit retains the
 *    pending audit record for the explicit recovery path (the durable
 *    commit is never undone — the NET-W004-AC-07 contract);
 *  - audit lineage carries the AUTHORITATIVE transaction id.
 *
 * Evidence: API security tests + fault-injection + concurrency
 * integration tests over the NET-W003 persistence/idempotency
 * boundaries.
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import type {
  AuditWriter,
  TransactionalAuditWriter,
  TransactionalAuditBuffer,
} from "../../src/core/audit.ts";
import type { AuthorityTransaction } from "../../src/core/postgres-authority.ts";
import { createRuntime } from "../../src/bootstrap/runtime.ts";
import { createTransactionalAuditWriter } from "../../src/audit/transactional-audit-writer.ts";
import { createPostgresIdempotencyStore } from "../../src/persistence/idempotency-store.ts";
import { createAuthorityReputationInputRepository } from "../../src/reputation/authority-input-repository.ts";
import { createReputationInputService } from "../../src/reputation/input-service.ts";
import {
  createNetW007Harness,
  actorCtx,
  createDefaultPolicy,
  createVerifiedContribution,
  REF_AT,
  type NetW007Harness,
} from "./_net-w007-harness.ts";

let harness: NetW007Harness;

beforeEach(async () => {
  harness = await createNetW007Harness();
});

afterEach(async () => {
  await harness.teardown();
});

const silentLogger = {
  debug() {},
  info() {},
  warn() {},
  error() {},
  child() {
    return this;
  },
  forModule() {
    return this;
  },
} as unknown as Parameters<typeof createReputationInputService>[0]["logger"];

const BASE = "http://127.0.0.1";

describe("NET-W007-AC-06 atomicity/idempotency/concurrency", () => {
  test("reputation mutation endpoints are guarded deny-by-default (no policy → 403, authenticated or not)", async () => {
    // A bare runtime WITHOUT the reputation allow policies.
    const bare = createRuntime({
      forceEnv: "test",
      env: { APP_ENV: "test", LOG_LEVEL: "error" },
      port: 0,
    });
    await bare.initialize();
    await bare.api.start();
    try {
      const endpoints: Array<[string, string, Record<string, unknown>]> = [
        ["/api/reputation/policies", "reputationPolicy.create", { policyId: "p", version: 1, organizationScopeId: "org", rules: [] }],
        ["/api/reputation/inputs", "reputationInput.create", { organizationScopeId: "org", subjectPersonId: "x", dimension: "helpfulness", sources: [], occurredAt: REF_AT, idempotencyKey: "k" }],
        ["/api/reputation/snapshots", "reputationSnapshot.create", { organizationScopeId: "org", subjectPersonId: "x", policyId: "p", referenceAt: REF_AT, idempotencyKey: "k" }],
      ];
      for (const [path, , body] of endpoints) {
        // Unauthenticated.
        const unauth = await fetch(`${BASE}:${bare.api.port}${path}`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
        });
        expect(unauth.status).toBe(403);
        // Authenticated but no allow policy → still denied.
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

    // With the harness policies + authenticated principal the guarded
    // mutation is ALLOWED (201).
    await createDefaultPolicy(harness);
    const contributionId = await createVerifiedContribution(harness);
    const res = await fetch(`${BASE}:${harness.runtime.api.port}/api/reputation/inputs`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-auth-subject-id": harness.subjectId,
        "x-auth-provider-kind": "internal",
      },
      body: JSON.stringify({
        organizationScopeId: harness.organizationScopeId,
        subjectPersonId: harness.personId,
        dimension: "helpfulness",
        sources: [{ kind: "contribution", id: contributionId }],
        occurredAt: REF_AT,
        idempotencyKey: "ac06-api-input",
      }),
    });
    expect(res.status).toBe(201);
    const created = (await res.json()) as { created: boolean; input: { id: string } };
    expect(created.created).toBe(true);
  });

  test("repeating an input recording with the SAME idempotency key is a deterministic replay (one record, one audit event)", async () => {
    await createDefaultPolicy(harness);
    const contributionId = await createVerifiedContribution(harness);
    const ctx = actorCtx(harness, "ac06-replay-input");
    const input = {
      organizationScopeId: harness.organizationScopeId,
      subjectPersonId: harness.personId,
      dimension: "helpfulness" as const,
      sources: [{ kind: "contribution", id: contributionId }],
      occurredAt: REF_AT,
      idempotencyKey: "ac06-replay-key",
    };
    const first = await harness.runtime.reputationInputService.recordInput(ctx, input);
    const second = await harness.runtime.reputationInputService.recordInput(ctx, {
      ...input,
      // Different description on the replay — IGNORED (deterministic
      // replay returns the committed record).
      description: "changed-on-replay",
    });
    expect(first.created).toBe(true);
    expect(second.created).toBe(false);
    expect(second.input.id).toBe(first.input.id);
    expect(second.input.description).toBe(first.input.description);
    const listed = await harness.runtime.reputationInputService.listInputs(
      ctx,
      harness.organizationScopeId,
      harness.personId,
    );
    expect(listed).toHaveLength(1);
    const events = await harness.runtime.auditWriter.query({
      eventType: "reputation_input.recorded",
      resourceId: first.input.id,
    });
    expect(events).toHaveLength(1);
  });

  test("repeating a snapshot recording with the SAME idempotency key is a deterministic replay (one snapshot, one audit event)", async () => {
    const policy = await createDefaultPolicy(harness);
    const contributionId = await createVerifiedContribution(harness);
    const ctx = actorCtx(harness, "ac06-replay-snapshot");
    await harness.runtime.reputationInputService.recordInput(ctx, {
      organizationScopeId: harness.organizationScopeId,
      subjectPersonId: harness.personId,
      dimension: "helpfulness",
      sources: [{ kind: "contribution", id: contributionId }],
      occurredAt: REF_AT,
      idempotencyKey: "ac06-replay-snapshot-input",
    });
    const request = {
      organizationScopeId: harness.organizationScopeId,
      subjectPersonId: harness.personId,
      policyId: policy.policyId,
      version: 1,
      referenceAt: REF_AT,
      idempotencyKey: "ac06-replay-snapshot-key",
    };
    const first = await harness.runtime.reputationSnapshotService.recordSnapshot(ctx, request);
    const second = await harness.runtime.reputationSnapshotService.recordSnapshot(ctx, request);
    expect(first.created).toBe(true);
    expect(second.created).toBe(false);
    expect(second.snapshot.id).toBe(first.snapshot.id);
    expect(second.snapshot.digest).toBe(first.snapshot.digest);
    const history = await harness.runtime.reputationSnapshotService.getSnapshotHistory(
      ctx,
      harness.organizationScopeId,
      harness.personId,
    );
    expect(history).toHaveLength(1);
    const events = await harness.runtime.auditWriter.query({
      eventType: "reputation_snapshot.recorded",
      resourceId: first.snapshot.id,
    });
    expect(events).toHaveLength(1);
  });

  test("two CONCURRENT same-key input recordings produce exactly one mutation", async () => {
    await createDefaultPolicy(harness);
    const contributionId = await createVerifiedContribution(harness);
    const ctx = actorCtx(harness, "ac06-concurrent-input");
    const input = {
      organizationScopeId: harness.organizationScopeId,
      subjectPersonId: harness.personId,
      dimension: "helpfulness" as const,
      sources: [{ kind: "contribution", id: contributionId }],
      occurredAt: REF_AT,
      idempotencyKey: "ac06-concurrent-key",
    };
    const [a, b] = await Promise.all([
      harness.runtime.reputationInputService.recordInput(ctx, input),
      harness.runtime.reputationInputService.recordInput(ctx, input),
    ]);
    expect(a.created !== b.created).toBe(true);
    expect(a.input.id).toBe(b.input.id);
    const listed = await harness.runtime.reputationInputService.listInputs(
      ctx,
      harness.organizationScopeId,
      harness.personId,
    );
    expect(listed).toHaveLength(1);
  });

  test("two CONCURRENT same-key snapshot recordings produce exactly one snapshot", async () => {
    const policy = await createDefaultPolicy(harness);
    const ctx = actorCtx(harness, "ac06-concurrent-snapshot");
    const request = {
      organizationScopeId: harness.organizationScopeId,
      subjectPersonId: harness.personId,
      policyId: policy.policyId,
      version: 1,
      referenceAt: REF_AT,
      idempotencyKey: "ac06-concurrent-snapshot-key",
    };
    const [a, b] = await Promise.all([
      harness.runtime.reputationSnapshotService.recordSnapshot(ctx, request),
      harness.runtime.reputationSnapshotService.recordSnapshot(ctx, request),
    ]);
    expect(a.created !== b.created).toBe(true);
    expect(a.snapshot.id).toBe(b.snapshot.id);
    const history = await harness.runtime.reputationSnapshotService.getSnapshotHistory(
      ctx,
      harness.organizationScopeId,
      harness.personId,
    );
    expect(history).toHaveLength(1);
  });

  test("concurrent DIFFERENT-key snapshots both persist (append-only history; no lost updates)", async () => {
    const policy = await createDefaultPolicy(harness);
    const ctx = actorCtx(harness, "ac06-concurrent-history");
    const base = {
      organizationScopeId: harness.organizationScopeId,
      subjectPersonId: harness.personId,
      policyId: policy.policyId,
      version: 1,
      referenceAt: REF_AT,
    };
    const [a, b] = await Promise.all([
      harness.runtime.reputationSnapshotService.recordSnapshot(ctx, {
        ...base,
        idempotencyKey: "ac06-history-a",
      }),
      harness.runtime.reputationSnapshotService.recordSnapshot(ctx, {
        ...base,
        idempotencyKey: "ac06-history-b",
      }),
    ]);
    expect(a.created).toBe(true);
    expect(b.created).toBe(true);
    expect(a.snapshot.id).not.toBe(b.snapshot.id);
    const history = await harness.runtime.reputationSnapshotService.getSnapshotHistory(
      ctx,
      harness.organizationScopeId,
      harness.personId,
    );
    expect(history).toHaveLength(2);
    expect(history.map((s) => s.id).sort()).toEqual([a.snapshot.id, b.snapshot.id].sort());
  });

  test("an audit APPEND failure inside the transaction rolls the input recording back ENTIRELY (no record without its audit lineage)", async () => {
    await createDefaultPolicy(harness);
    const contributionId = await createVerifiedContribution(harness);
    const ctx = actorCtx(harness, "ac06-audit-append-failure");
    const authority = harness.runtime.postgresAuthority;

    // A transactional audit writer whose BUFFER append fails — the
    // failure happens INSIDE the mutation transaction, so the whole
    // transaction (record + idempotency + audit) rolls back.
    const throwingBuffer: TransactionalAuditBuffer = {
      async append() {
        throw new Error("injected audit append failure");
      },
      async query() {
        return [];
      },
      async count() {
        return 0;
      },
      pendingCount() {
        return 0;
      },
    };
    const throwingWriter: TransactionalAuditWriter = {
      async append(input) {
        return harness.runtime.auditWriter.append(input);
      },
      async query(query) {
        return harness.runtime.auditWriter.query(query);
      },
      async count() {
        return harness.runtime.auditWriter.count();
      },
      forTransaction(_tx: AuthorityTransaction) {
        return throwingBuffer;
      },
      async retryPendingPublications() {
        return { published: 0, remaining: 0 };
      },
      pendingPublicationCount() {
        return 0;
      },
    };

    const repo = createAuthorityReputationInputRepository({ authority });
    const idempotency = createPostgresIdempotencyStore({ authority });
    const service = createReputationInputService({
      repository: repo,
      subjectLookup: { async exists() { return true; } },
      evidenceLookup: {
        async resolve() {
          return { organizationScopeId: harness.organizationScopeId, sourceType: "platform" };
        },
      },
      proofOfValueLookup: {
        async resolve() {
          return { organizationScopeId: harness.organizationScopeId, state: "VERIFIED" };
        },
      },
      measuredOutcomeLookup: {
        async resolve() {
          return { organizationScopeId: harness.organizationScopeId, state: "VERIFIED" };
        },
      },
      contributionLookup: {
        async resolve() {
          return { organizationScopeId: harness.organizationScopeId, state: "VERIFIED" };
        },
      },
      idempotency,
      auditWriter: throwingWriter,
      logger: silentLogger,
    });

    await expect(
      service.recordInput(ctx, {
        organizationScopeId: harness.organizationScopeId,
        subjectPersonId: harness.personId,
        dimension: "helpfulness",
        sources: [{ kind: "contribution", id: contributionId }],
        occurredAt: REF_AT,
        idempotencyKey: "ac06-append-failure-key",
      }),
    ).rejects.toThrow("injected audit append failure");

    // NOTHING survived: no input record, no idempotency record.
    const listed = await repo.listBySubject(harness.organizationScopeId, harness.personId);
    expect(listed).toHaveLength(0);
    expect(await idempotency.has("reputation_input:" + harness.organizationScopeId + ":" + harness.personId + ":ac06-append-failure-key")).toBe(false);

    // A RETRY after healing (the real writer) succeeds — no phantom
    // idempotency record blocks it.
    const healed = createReputationInputService({
      repository: repo,
      subjectLookup: { async exists() { return true; } },
      evidenceLookup: {
        async resolve() {
          return { organizationScopeId: harness.organizationScopeId, sourceType: "platform" };
        },
      },
      proofOfValueLookup: {
        async resolve() {
          return { organizationScopeId: harness.organizationScopeId, state: "VERIFIED" };
        },
      },
      measuredOutcomeLookup: {
        async resolve() {
          return { organizationScopeId: harness.organizationScopeId, state: "VERIFIED" };
        },
      },
      contributionLookup: {
        async resolve() {
          return { organizationScopeId: harness.organizationScopeId, state: "VERIFIED" };
        },
      },
      idempotency,
      auditWriter: harness.runtime.auditWriter,
      logger: silentLogger,
    });
    const retried = await healed.recordInput(ctx, {
      organizationScopeId: harness.organizationScopeId,
      subjectPersonId: harness.personId,
      dimension: "helpfulness",
      sources: [{ kind: "contribution", id: contributionId }],
      occurredAt: REF_AT,
      idempotencyKey: "ac06-append-failure-key",
    });
    expect(retried.created).toBe(true);
  });

  test("an audit PUBLICATION failure after the durable commit retains the pending audit record for recovery (commit never undone)", async () => {
    await createDefaultPolicy(harness);
    const contributionId = await createVerifiedContribution(harness);
    const ctx = actorCtx(harness, "ac06-publication-failure");
    const authority = harness.runtime.postgresAuthority;

    // The flaky writer: buffered appends succeed (the tx commits), but
    // the post-commit PUBLICATION fails twice then heals — the
    // NET-W005/W006-AC-07 fault-injection pattern.
    let failures = 2;
    const flakyWriter: AuditWriter = {
      async append(input) {
        if (failures > 0) {
          failures -= 1;
          throw new Error("flaky audit publication");
        }
        return harness.runtime.auditWriter.append(input);
      },
      async query(query) {
        return harness.runtime.auditWriter.query(query);
      },
      async count() {
        return harness.runtime.auditWriter.count();
      },
    };
    const flakyTxWriter: TransactionalAuditWriter = createTransactionalAuditWriter({
      underlying: flakyWriter,
      publicationAttempts: 2,
      publicationBackoffMs: 1,
      logger: silentLogger,
    });
    const repo = createAuthorityReputationInputRepository({ authority });
    const service = createReputationInputService({
      repository: repo,
      subjectLookup: { async exists() { return true; } },
      evidenceLookup: {
        async resolve() {
          return { organizationScopeId: harness.organizationScopeId, sourceType: "platform" };
        },
      },
      proofOfValueLookup: {
        async resolve() {
          return { organizationScopeId: harness.organizationScopeId, state: "VERIFIED" };
        },
      },
      measuredOutcomeLookup: {
        async resolve() {
          return { organizationScopeId: harness.organizationScopeId, state: "VERIFIED" };
        },
      },
      contributionLookup: {
        async resolve() {
          return { organizationScopeId: harness.organizationScopeId, state: "VERIFIED" };
        },
      },
      idempotency: createPostgresIdempotencyStore({ authority }),
      auditWriter: flakyTxWriter,
      logger: silentLogger,
    });

    const result = await service.recordInput(ctx, {
      organizationScopeId: harness.organizationScopeId,
      subjectPersonId: harness.personId,
      dimension: "helpfulness",
      sources: [{ kind: "contribution", id: contributionId }],
      occurredAt: REF_AT,
      idempotencyKey: "ac06-publication-failure-key",
    });
    // The durable record committed (the authority is the source of
    // truth) — the publication failure did NOT undo it.
    const stored = await repo.findById(result.input.id);
    expect(stored).not.toBeNull();
    // The audit record is retained pending recovery.
    expect(flakyTxWriter.pendingPublicationCount()).toBe(1);
    // Recovery publishes it.
    failures = 0;
    const recovery = await flakyTxWriter.retryPendingPublications();
    expect(recovery.published).toBe(1);
    expect(recovery.remaining).toBe(0);
    const events = await harness.runtime.auditWriter.query({
      eventType: "reputation_input.recorded",
      resourceId: result.input.id,
    });
    expect(events).toHaveLength(1);
  });

  test("the audit lineage carries the AUTHORITATIVE transaction id (not the execution id)", async () => {
    await createDefaultPolicy(harness);
    const contributionId = await createVerifiedContribution(harness);
    const ctx = actorCtx(harness, "ac06-tx-lineage");
    const result = await harness.runtime.reputationInputService.recordInput(ctx, {
      organizationScopeId: harness.organizationScopeId,
      subjectPersonId: harness.personId,
      dimension: "helpfulness",
      sources: [{ kind: "contribution", id: contributionId }],
      occurredAt: REF_AT,
      idempotencyKey: "ac06-tx-lineage-key",
    });
    const events = await harness.runtime.auditWriter.query({
      eventType: "reputation_input.recorded",
      resourceId: result.input.id,
    });
    expect(events).toHaveLength(1);
    const metadata = events[0]!.metadata as Record<string, unknown>;
    expect(metadata.transactionId).toBeTruthy();
    expect(metadata.transactionId).not.toBe(events[0]!.executionId);
    // PostgreSQL-authoritative persistence: the record round-trips
    // through the authority store with revision lineage.
    const authority = harness.runtime.postgresAuthority;
    const record = await authority.get("reputation_inputs", result.input.id);
    expect(record).not.toBeNull();
    expect(record!.executionId).toBe(ctx.executionId);
    expect(record!.revision).toBeGreaterThan(0);
  });
});
