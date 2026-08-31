# NET-W024 — Consumer Demand Pools

**Status:** SCAFFOLD — implementation in progress on `feat/net-w024-consumer-demand-pools` (completed before PR)
**GitHub issue:** #48
**Work order:** `spec/work-orders/NET-W024.md`
**Architecture:** v1.0 FROZEN
**Dependencies:** NET-W002 + NET-W008 merged

## Purpose

This document is the durable evidence ledger for NET-W024. It must allow an architect or reviewer with no conversation history to verify — from the repository alone — that consumer demand pools are implemented inside the frozen `/demand` boundary with privacy-preserving aggregation, server-enforced consent/authorization, deterministic qualification, tenant isolation, idempotency/concurrency/atomicity conventions, and zero economic-authority surface. It will record the implementation shape, the acceptance evidence matrix, mutation evidence, privacy evidence, the final verification record, and the PR state.

## Architectural decision record

(To be completed by the implementation: which boundary owns what, and why W024 introduces NO second authority — `/demand` owns pools/commitments/vocabularies/aggregation; `/settlement` untouched; `/organizations` read only through the neutral membership lookup; one-way closure/withdrawal fields, no status machinery.)

## Implementation shape (the decision of record, as shipped)

(To be completed: numbered list, one item per file group — `src/core/demand.ts` neutral vocabulary; `src/demand/port.ts` contracts; `src/demand/authority-demand-repositories.ts`; `src/demand/aggregation-engine.ts` (pure derivation + digest); `src/demand/demand-service.ts`; module/README updates; bootstrap wiring; API port + routes; tests; docs.)

## Evidence matrix

(To be completed: | AC | Required evidence | Status | — one row per AC-01..08 with the test file + test count.)

## Mutation evidence

(To be completed: numbered mutation — CAUGHT list, six directions per the work order §5.)

## Privacy evidence

(To be completed: what individual-commitment material never crosses into supplier-facing views/logs/audit/errors; floor + group suppression proof; reconstruction resistance.)

## Final verification record

(To be completed: `bun run verify` numbers; `arch:check`/`authority:check` file counts; integration job status; mutation counts; secret scan; PR number; review state; merge SHA: PENDING.)

## Completion rule

Merge only after implementation, acceptance coverage, mutation checks, full verification, green CI, and recorded architect approval. After merge, update `spec/PROJECT-STATE.md` and the roadmap pointers before advancing to NET-W025.
