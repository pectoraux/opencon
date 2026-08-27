# Architecture Authority Guardrails

These guardrails operationalize the architectural authority watchpoints identified during architect review. They are enforcement of frozen Architecture v1.0, not a new architecture version or exception.

## 1. `/disputes` is the single fraud/risk control authority

`/disputes` may own risk signals, assessments, cases, controls, challenges and related safety decisions. It must not become a second authority for money, Participation Credits, reputation, workflow lifecycle, or campaign policy.

Therefore `/disputes` domain code must not directly import the owning domains for settlement, reputation, workflows or campaigns, and must not call their mutation commands. Cross-domain facts arrive through provider-neutral lookup contracts; cross-domain commands are composed at the bootstrap boundary.

## 2. `/contributions` may own quality/moderation semantics, not risk mutation

Quality and moderation are contribution semantics because the frozen architecture has no separate `/moderation` domain. The contribution boundary may create immutable quality/moderation records and evaluate deterministic policies.

Risk conclusions belong to `/disputes`. `/contributions` must not directly call risk-signal, risk-assessment, risk-case or settlement/reputation/workflow mutation commands. The composition root translates moderation outcomes into risk signals through the existing `/disputes` authority.

## 3. Operational lifecycle belongs to `/workflows`

The canonical opportunity/contribution lifecycle remains exclusively owned by `/workflows`. Domain-local status is permitted only when it is clearly administrative state intrinsic to that domain and cannot mutate or bypass the operational workflow.

The explicitly approved administrative-status precedents are:

- **`campaigns`** — the campaign administrative status machine (architect-approved administrative campaign state: owner-only campaign administration under the campaign record mutex, established with the campaign clearing/reward work orders). Administrative state intrinsic to the campaign domain; never an operational lifecycle.
- **`creators`** — creator-profile administration (NET-W015: `DRAFT` → `ACTIVE` ⇄ `PAUSED` → `ARCHIVED`, owner-only, activation-gated).

New domain-local status machines require an explicit addition to the allowlist in `scripts/check-authority-boundaries.ts`, a documented architectural decision, and corresponding regression evidence.

## 4. `/settlement` and `/reputation` are the only economic and reputation mutation authorities

Economic mutation commands (credits, maturing, reward allocation, cash obligations) are reserved for `/settlement`; reputation input/snapshot mutation commands are reserved for `/reputation`. Every other domain composes economic/reputation effects at the bootstrap boundary (the NET-W014 composites are the reference pattern).

## Detection semantics

The guard detects **actual unauthorized authority/mutation behavior**, not generic identifiers. Concretely:

- **What is scanned:** domain *implementation* files only (files under a domain directory whose basename is not `port.ts`, `module.ts` or `index.ts`), with comments stripped.
- **What is a violation:**
  - a call site or definition of a reserved mutation primitive of an authority the file's domain does not own (`performTransition`, `transitionWorkflow`, `createRiskSignal`, `issueCredits`, `createReputationInput`, …);
  - construction or definition of another authority's machinery (`new WorkflowService`, `class WorkflowService`);
  - a domain-local administrative status machine (`statusTransition`, `statusMachine`, `administrativeStatusTransition`) in a domain without an approved precedent;
  - a direct import of a forbidden authority from `/disputes` or `/contributions`.
- **What is deliberately NOT a violation:**
  - referencing shared vocabulary/type contracts such as the `TransitionRequest` contract in `/core` — a type name is not a mutation;
  - the provider-neutral `requestTransition` delegation callback — declared on domain ports, invoked by domain services, exposed on the API command surface. Delegating to an authority is the sanctioned pattern, not seizing it;
  - `/api` transport calling the composition-root command surface (`commands.createRiskSignal(...)`, `commands.issueCredits(...)`);
  - `/bootstrap` composition-root orchestration — the one place cross-authority composition is allowed;
  - the owning authority itself (e.g. `/workflows` defining `performTransition`; `/disputes` defining `createRiskSignal`).

## CI enforcement

`scripts/check-authority-boundaries.ts` is executed by `bun run verify` and CI. It checks:

- single-authority import restrictions for `/disputes` and `/contributions`;
- workflow operational-lifecycle mutation reserved for `/workflows`;
- risk mutation reserved for `/disputes`;
- economic mutation reserved for `/settlement`;
- reputation mutation reserved for `/reputation`;
- explicit allowlisting of domain-local administrative status helpers.

The existing `scripts/check-architecture.ts` remains authoritative for the frozen tier/import matrix. The two checks are complementary: tier safety prevents illegal dependency directions, while these guardrails prevent semantic authority drift inside otherwise legal composition-root/domain boundaries.

## Regression fixtures

Both directions of the guard are pinned by fixture corpora under `tests/regression/fixtures/authority-guard/` (excluded from typecheck — they are inert text corpora for the scanner, not compiled code):

- `approved/` — the already-approved machinery that must NEVER be flagged: campaign and creator administrative status, the `/core` `TransitionRequest` contract, the `requestTransition` neutral delegation pattern in `/evidence` and `/outcomes`, `/api` transport over the composed command surface, the `/bootstrap` composition root, and each owning authority's own primitives.
- `rejected/` — local authority grabs that MUST be flagged: a domain re-implementing workflow machinery, risk mutation inside `/contributions` and from an administratively-allowlisted domain, `/disputes` mutating economic/reputation state, an un-allowlisted local status machine, and direct authority imports.

`tests/regression/architecture-authority-guardrails.test.ts` pins the exact approved file list, the exact rejected violation multiset, the administrative-status allowlist, and that the real source tree scans clean.
