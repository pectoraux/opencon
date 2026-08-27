# Architecture Authority Guardrails

These guardrails operationalize three architectural watchpoints identified during architect review. They are enforcement of frozen Architecture v1.0, not a new architecture version or exception.

## 1. `/disputes` is the single fraud/risk control authority

`/disputes` may own risk signals, assessments, cases, controls, challenges and related safety decisions. It must not become a second authority for money, Participation Credits, reputation, workflow lifecycle, or campaign policy.

Therefore `/disputes` domain code must not directly import the owning domains for settlement, reputation, workflows or campaigns, and must not call their mutation commands. Cross-domain facts arrive through provider-neutral lookup contracts; cross-domain commands are composed at the bootstrap boundary.

## 2. `/contributions` may own quality/moderation semantics, not risk mutation

Quality and moderation are contribution semantics because the frozen architecture has no separate `/moderation` domain. The contribution boundary may create immutable quality/moderation records and evaluate deterministic policies.

Risk conclusions belong to `/disputes`. `/contributions` must not directly call risk-signal, risk-assessment, risk-case or settlement/reputation/workflow mutation commands. The composition root translates moderation outcomes into risk signals through the existing `/disputes` authority.

## 3. Operational lifecycle belongs to `/workflows`

The canonical opportunity/contribution lifecycle remains exclusively owned by `/workflows`. Domain-local status is permitted only when it is clearly administrative state intrinsic to that domain and cannot mutate or bypass the operational workflow.

The current explicit administrative-status exception is `/creators` for creator-profile administration (`DRAFT`, `ACTIVE`, `PAUSED`, `ARCHIVED`). New domain-local status machines require an explicit addition to the allowlist in `scripts/check-authority-boundaries.ts` and corresponding regression evidence.

## CI enforcement

`scripts/check-authority-boundaries.ts` is executed by `bun run verify` and CI. It checks:

- single-authority import restrictions for `/disputes` and `/contributions`;
- reserved `/workflows` mutation primitives outside the workflow boundary;
- risk mutation identifiers inside `/contributions`;
- economic/reputation mutation identifiers inside `/disputes`;
- explicit allowlisting of domain-local administrative status helpers.

The existing `scripts/check-architecture.ts` remains authoritative for the frozen tier/import matrix. The two checks are complementary: tier safety prevents illegal dependency directions, while these guardrails prevent semantic authority drift inside otherwise legal composition-root/domain boundaries.
