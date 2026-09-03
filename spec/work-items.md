# Implementation Backlog — Work Items

**Version:** 1.0
**Architecture:** Open Contribution Protocol Architecture v1.0

## Phase 1 — Foundation

### NET-W001 — Platform and modular-monolith foundation
Objective: Establish TypeScript module boundaries, configuration, background workers, structured logging, execution IDs and interface conventions.
Dependencies: none.
Requirements: CORE-001..004, AUD-001, API-001..005.
Verification: unit, integration, static architecture checks.
Definition of done: Executable module skeleton, declared interfaces, async worker boundary, correlation IDs, configuration/secrets boundary and API conventions exist without domain logic leakage.

### NET-W002 — Identity, organizations and participant model
Objective: Implement user/organization identity, participant roles, server-side authorization and policy storage.
Dependencies: NET-W001.
Requirements: ID-001..004, PRIV-001, API-002.
Verification: API, integration and security tests.
Definition of done: One identity can hold multiple roles, authorization is server-enforced, and participant policy data is persisted through explicit boundaries.

### NET-W003 — Persistence, queues, objects, secrets and observability
Objective: Establish PostgreSQL authority, Redis-backed workers/locks, object storage, secrets abstraction and observability.
Dependencies: NET-W001.
Requirements: CORE-002, EVID-006, AUD-001, API-004.
Verification: database/recovery/security/integration tests.
Definition of done: PostgreSQL is authoritative, Redis is non-authoritative coordination, large artifacts have durable references, secrets are isolated and material operations are traceable.

## Phase 2 — Protocol core

### NET-W004 — Opportunity and contribution lifecycle
Objective: Implement Opportunity and Contribution domains and the authoritative lifecycle state machine.
Dependencies: NET-W002, NET-W003.
Requirements: OPP-001..004, API-003.
Verification: exhaustive domain/workflow tests.
Definition of done: All legal transitions are deterministic/idempotent, illegal transitions are rejected, and lifecycle authority resides in `/workflows`.

### NET-W005 — Evidence and Proof-of-Value
Objective: Implement evidence records, provenance, confidence, evidence grades, commitments and proof evaluation.
Dependencies: NET-W003, NET-W004.
Requirements: EVID-001..006, AUD-002.
Verification: domain, integration, integrity tests.
Definition of done: Every material claim has traceable evidence, confidence is preserved, multiple evidence sources can be combined, and sensitive evidence can be committed without publication of raw data.

### NET-W006 — Outcomes and measurement abstraction
Objective: Implement normalized outcome model and measurement provider boundary.
Dependencies: NET-W004, NET-W005.
Requirements: OUT-001..005, ADAPTER-003..004.
Verification: contract, integration and statistical test fixtures.
Definition of done: Outcome types are normalized, measurement providers are adapters, attribution modes are explicit, and uncertainty is preserved.

### NET-W007 — Reputation engine
Objective: Implement multidimensional reputation, provenance and time decay.
Dependencies: NET-W005, NET-W006.
Requirements: REP-001..004, AUD-004.
Verification: deterministic scoring and audit tests.
Definition of done: Reputation dimensions remain independent, scoring is reproducible, decay is deterministic, and major changes reference evidence.

### NET-W008 — Participation Credits and economic ledger
Objective: Implement cash, pending value, mature value, credits and reward accounting.
Dependencies: NET-W005, NET-W006, NET-W007.
Requirements: ECON-001..005, SETTLE-001..003, AUD-003.
Verification: accounting, concurrency, integration and invariant tests.
Definition of done: Credit issuance requires verified value, pending/mature states are distinct, cash/credit accounting is explicit, and settlement lineage is preserved.

## Phase 3 — Trust

### NET-W009 — Fraud and risk engine
Objective: Implement multi-signal fraud/risk analysis and eligibility holds.
Dependencies: NET-W002, NET-W005, NET-W007, NET-W008.
Requirements: FRAUD-001..003, AI-003.
Verification: security, adversarial and integration tests.
Definition of done: Risk decisions combine multiple signals, suspicious value can be held, and no single signal is authoritative.

### NET-W010 — Stake, challenges and disputes
Objective: Implement claim bonding, challenges, dispute lifecycle, penalties and reserves.
Dependencies: NET-W008, NET-W009.
Requirements: FRAUD-004..006, GOV-002..003.
Verification: workflow/economic adversarial tests.
Definition of done: High-value claims can be bonded, challenges are auditable, disputed value cannot mature prematurely, and reserve accounting is enforced.

## Phase 4 — Farmable contribution market

### NET-W011 — Campaign domain
Objective: Generalize campaigns from Farmable into the protocol contribution/campaign model.
Dependencies: NET-W004, NET-W005, NET-W008.
Requirements: CAMP-001..005.
Verification: API/domain/integration tests.
Definition of done: Campaign objectives, outcome/evidence policy, budgets, attribution rules and clearing rules are represented without creating a separate economic system.

### NET-W012 — Helpful contributions
Objective: Implement useful recommendation opportunities, contribution submission and Proof-of-Helpfulness.
Dependencies: NET-W005, NET-W006, NET-W011.
Requirements: HELP-001..005.
Verification: domain, policy, moderation and integration tests.
Definition of done: Product mention alone has no final reward, usefulness evidence is captured, publication remains user-controlled, and commercial disclosure policy is enforced.

### NET-W013 — Quality, moderation and anti-spam controls
Objective: Generalize Farmable's AI scoring/moderation architecture into provider-independent quality evaluation.
Dependencies: NET-W009, NET-W012.
Requirements: HELP-002, AI-004, FRAUD-001..003.
Verification: model-contract, adversarial and moderation tests.
Definition of done: Quality scoring is provider-independent, moderation is auditable, spam/abuse signals are integrated, and AI output remains non-authoritative evidence.

### NET-W014 — Reward and settlement integration
Objective: Connect contribution outcomes to pending/mature settlement and reputation.
Dependencies: NET-W008, NET-W012, NET-W013.
Requirements: ECON-003, SETTLE-001..003, REP-004.
Verification: end-to-end contribution settlement tests.
Definition of done: Verified contribution value flows into pending/mature settlement and evidence-backed reputation without bypassing fraud or dispute controls.

## Phase 5 — Creator network

### NET-W015 — Creator identity and preferences
Objective: Implement creator identity, connected platforms, audience metadata, commercial preferences, rights and restrictions.
Dependencies: NET-W002, NET-W007.
Requirements: CRE-001, CRE-005.
Verification: API, integration and authorization tests.
Definition of done: Creator profiles expose structured availability, commercial rules and distinct audience/production reputation.

### NET-W016 — Creator matching
Objective: Match creators to opportunities using relevance, audience quality, historical evidence, safety, price and availability.
Dependencies: NET-W006, NET-W007, NET-W015.
Requirements: CRE-002, AI-002.
Verification: matching contract, deterministic fixtures and integration tests.
Definition of done: Eligible creators are ranked by explicit signals and hard restrictions cannot be overridden by model ranking.

### NET-W017 — UGC workflow and rights
Objective: Implement creator auto-match/acceptance, UGC production workflow, usage rights and evidence capture.
Dependencies: NET-W016, NET-W011, NET-W014.
Requirements: CRE-003..005.
Verification: workflow, rights/policy and integration tests.
Definition of done: Creators can automate qualifying acceptance, produce UGC without owned-channel publication, and rights/usage terms are persisted and enforced.

### NET-W018 — Sponsorship and disclosure
Objective: Persist commercial relationships, disclosure requirements, creator campaign terms and publication evidence.
Dependencies: NET-W017, NET-W005.
Requirements: CRE-006, DISC-001..002.
Verification: policy, integration and disclosure contract tests.
Definition of done: Commercial relationships and required disclosures survive end-to-end from campaign through publication/evidence/settlement.

## Phase 6 — Advertising network

### NET-W019 — Inventory and placements
Objective: Implement publisher/app/creator inventory, placement context, authorization and supply provenance.
Dependencies: NET-W002, NET-W011.
Requirements: INV-001..004, CAMP-003..004.
Verification: API/domain/integration/static architecture tests.
Definition of done: Inventory is owned/identified, policy-scoped, provenance-aware and cannot settle without valid source context.

### NET-W020 — Cross-promotion and clearing
Objective: Implement non-reciprocal inventory exchange and multilateral advertising-value clearing.
Dependencies: NET-W008, NET-W019.
Requirements: CAMP-004..005, ECON-003.
Verification: economic, integration and settlement invariant tests.
Definition of done: Participants can contribute inventory and consume earned value without direct pairwise reciprocity.

### NET-W021 — Campaign matching and optimization
Objective: Optimize campaign-to-inventory/creator matching under hard policy constraints and measured performance.
Dependencies: NET-W006, NET-W007, NET-W009, NET-W019.
Requirements: CAMP-001..003, AI-002..003.
Verification: optimization fixtures, adversarial and integration tests.
Definition of done: Matching honors hard constraints first, then ranks eligible options using evidence-backed performance.

### NET-W022 — Attribution and privacy measurement adapters
Objective: Integrate browser/platform attribution systems without transferring platform-specific semantics into core outcome logic.
Dependencies: NET-W005, NET-W006.
Requirements: OUT-002..003, PRIV-002..003, ADAPTER-003..004.
Verification: adapter contract, privacy and integration tests.
Definition of done: Platform measurements arrive as normalized evidence and retain provenance/uncertainty.

### NET-W023 — OpenRTB and supply-chain adapters
Objective: Integrate OpenRTB and supply-chain authorization signals while keeping provider-specific behavior isolated.
Dependencies: NET-W019, NET-W022.
Requirements: ADAPTER-001..002.
Verification: protocol contract, adapter and static architecture tests.
Definition of done: Existing ad supply can connect without bypassing OpenCon inventory/evidence/settlement semantics.

## Phase 7 — Demand economy

### NET-W024 — Consumer Demand Pools
Objective: Aggregate privacy-preserving consumer demand commitments and expose qualified demand to competing suppliers.
Dependencies: NET-W002, NET-W008.
Requirements: DEM-001..003.
Verification: privacy, authorization and aggregation tests.
Definition of done: Demand can be aggregated without exposing unnecessary individual commitments and suppliers can receive qualified aggregate demand.

### NET-W025 — Business procurement pools
Objective: Aggregate business procurement demand while minimizing disclosure of competitively sensitive information.
Dependencies: NET-W024, NET-W008.
Requirements: DEM-001..003, PROC-001..003.
Verification: privacy, competition-policy and integration tests.
Definition of done: Business demand can be pooled through an independently operated boundary without exposing unnecessary competitor terms.

### NET-W026 — Supplier offers and competitive selection
Objective: Collect supplier offers and execute auditable selection without exposing unnecessary participant commercial data.
Dependencies: NET-W025.
Requirements: PROC-001, PROC-003.
Verification: domain, audit, privacy and integration tests.
Definition of done: Offers, selection criteria, selection result and audit evidence are persisted and reproducible.

### NET-W027 — Verified savings and counterfactuals
Objective: Establish evidence-backed baselines, realized savings and uncertainty for procurement outcomes.
Dependencies: NET-W006, NET-W026.
Requirements: PROC-002.
Verification: statistical fixtures, evidence and integration tests.
Definition of done: Savings cannot settle without a supported baseline/counterfactual and uncertainty is retained.

### NET-W028 — Benefit Pools
Objective: Create configurable pools funded by verified contributions and allocate benefits according to eligibility policies.
Dependencies: NET-W008, NET-W024, NET-W027, NET-W020.
Requirements: BEN-001..004.
Verification: accounting, eligibility, allocation and integration tests.
Definition of done: Pool funding is traceable, allocation follows explicit policy, and member value can be measured.

## Phase 8 — Decentralization

### NET-W029 — Cryptographic attestations and commitments
Objective: Add signed evidence attestations and commitments without changing centralized semantic authority.
Dependencies: NET-W005, NET-W007, NET-W008.
Requirements: EVID-006, PRIV-003.
Verification: cryptographic, integrity and interoperability tests.
Definition of done: Attestations/commitments can prove integrity while PostgreSQL remains authoritative.

### NET-W030 — External settlement adapters
Objective: Connect verified settlement state to external payment/settlement networks.
Dependencies: NET-W008, NET-W029.
Requirements: SETTLE-001..003, ADAPTER-008.
Verification: accounting, idempotency and adapter integration tests.
Definition of done: External settlement transactions are traceable and cannot bypass internal economic authority.

### NET-W031 — Portable reputation proofs
Objective: Make reputation evidence portable without exposing raw private history.
Dependencies: NET-W007, NET-W029.
Requirements: REP-003..004.
Verification: cryptographic, privacy and interoperability tests.
Definition of done: A participant can present verifiable reputation claims without transferring raw private records.

### NET-W032 — Decentralized validation/dispute layer
Objective: Add independent validation/challenge participants and decentralized dispute/validation mechanisms.
Dependencies: NET-W010, NET-W029, NET-W030.
Requirements: GOV-001..003.
Verification: adversarial, economic and consensus/integration tests.
Definition of done: Validation participants cannot unilaterally rewrite authoritative state and dispute outcomes remain auditable.

## Phase 9 — End-to-end proof

### NET-W033 — Complete contribution lifecycle
Dependencies: NET-W014, NET-W018, NET-W023, NET-W028.
Objective: Prove contribution → evidence → outcome → reputation → settlement → benefit flow.
Verification: full end-to-end scenario suite.
Definition of done: One contribution can traverse the canonical workflow and produce traceable final value/benefit outcomes.

### NET-W034 — Complete advertising lifecycle
Dependencies: NET-W020, NET-W021, NET-W022, NET-W023, NET-W033.
Objective: Prove advertiser → inventory/creator → measurement → Proof-of-Value → settlement.
Verification: end-to-end advertising scenario suite.
Definition of done: An external/native campaign can be measured and settled through protocol semantics without bypassing evidence/fraud controls.

### NET-W035 — Complete creator lifecycle
Dependencies: NET-W018, NET-W034.
Objective: Prove creator discovery → contract → UGC → disclosure → measurement → payment.
Verification: end-to-end creator scenario suite.
Definition of done: Creator opportunity matching, UGC, disclosure, evidence and settlement are traceable end-to-end.

### NET-W036 — Complete demand/procurement/benefit lifecycle
Dependencies: NET-W028, NET-W033.
Objective: Prove demand → supplier → fulfillment → verified savings → benefit allocation.
Verification: end-to-end procurement/benefit scenario suite.
Definition of done: Demand aggregation, supplier competition, savings verification and member benefit allocation are all evidence-linked.

## Phase 10 — Product client (post-backlog, architect-approved)

### UX-01 — Unified product client experience
Dependencies: none (consumes the versioned API contract; authoritative behavior across W001–W036).
Objective: Deliver the approved OpenCon unified product UX — one coherent adaptive client (Home / Discover / Work / Wallet / You) over the existing authorities, with the frontend strictly a consumer of the product API.
Verification: interaction-path tests; browser-verified journeys; architecture/out-of-scope regression; accessibility and responsive checks.
Definition of done: A new user can traverse the core journeys without seeing protocol machinery, pending and available value are distinguishable, trust is drillable, and no frontend path bypasses or invents authority.

## Definition of Done rules

Every NET-W work item is complete only when:

1. Its stated requirements and acceptance criteria are implemented.
2. Required verification evidence exists and is mapped to the criteria it proves.
3. Static architecture checks confirm module/adapter boundaries.
4. No secrets or provider-specific credentials are committed.
5. Audit/trace identifiers exist for material mutations.
6. The implementation is delivered through the canonical implementation PR and passes architect review.

## First implementation slice

### NET-W001 readiness

NET-W001 is the first eligible implementation work item. It must establish the executable module skeleton, configuration/secrets boundary, worker boundary, logging/correlation IDs, API conventions, and static architecture enforcement without implementing domain behavior.

Required evidence for NET-W001:

- module boundary test
- cross-module interface/static check
- worker async execution test
- configuration/secrets boundary check
- structured log/correlation-ID test
