# Implementation Backlog — Work Items

**Version:** 1.0

## Phase 1 — Foundation

### NET-W001 — Platform and modular-monolith foundation
Objective: Establish TypeScript module boundaries, configuration, background workers, structured logging, execution IDs and interface conventions.
Dependencies: none.
Requirements: CORE-001..004, AUD-001.
Verification: unit, integration, static architecture checks.

### NET-W002 — Identity, organizations and participant model
Objective: Implement user/organization identity, participant roles, server-side authorization and policy storage.
Dependencies: NET-W001.
Requirements: ID-001..004, PRIV-001.
Verification: API, integration and security tests.

### NET-W003 — Persistence, queues, objects, secrets and observability
Objective: Establish PostgreSQL authority, Redis-backed workers/locks, object storage, secrets abstraction and observability.
Dependencies: NET-W001.
Requirements: CORE-002, EVID-006, AUD-001.
Verification: database/recovery/security/integration tests.

## Phase 2 — Protocol core

### NET-W004 — Opportunity and contribution lifecycle
Objective: Implement Opportunity and Contribution domains and lifecycle state machine.
Dependencies: NET-W002, NET-W003.
Requirements: OPP-001..004.
Verification: exhaustive domain/workflow tests.

### NET-W005 — Evidence and Proof-of-Value
Objective: Implement evidence records, provenance, confidence, evidence grades, commitments and proof evaluation.
Dependencies: NET-W003, NET-W004.
Requirements: EVID-001..006.
Verification: domain, integration, integrity tests.

### NET-W006 — Outcomes and measurement abstraction
Objective: Implement normalized outcome model and measurement provider boundary.
Dependencies: NET-W004, NET-W005.
Requirements: OUT-001..005.
Verification: contract, integration and statistical test fixtures.

### NET-W007 — Reputation engine
Objective: Implement multidimensional reputation, provenance and time decay.
Dependencies: NET-W005, NET-W006.
Requirements: REP-001..004.
Verification: deterministic scoring and audit tests.

### NET-W008 — Participation Credits and economic ledger
Objective: Implement cash, pending value, mature value, credits and reward accounting.
Dependencies: NET-W005, NET-W006, NET-W007.
Requirements: ECON-001..005, SETTLE-001..003.
Verification: accounting, concurrency, integration and invariant tests.

## Phase 3 — Trust

### NET-W009 — Fraud and risk engine
Objective: Implement multi-signal fraud/risk analysis and eligibility holds.
Dependencies: NET-W002, NET-W005, NET-W007, NET-W008.
Requirements: FRAUD-001..003, AI-003.
Verification: security, adversarial and integration tests.

### NET-W010 — Stake, challenges and disputes
Objective: Implement claim bonding, challenges, dispute lifecycle, penalties and reserves.
Dependencies: NET-W008, NET-W009.
Requirements: FRAUD-004..006, GOV-002..003.
Verification: workflow/economic adversarial tests.

## Phase 4 — Farmable contribution market

### NET-W011 — Campaign domain
Objective: Generalize campaigns from Farmable into the protocol contribution/campaign model.
Dependencies: NET-W004, NET-W005, NET-W008.
Requirements: CAMP-001..005.
Verification: API/domain/integration tests.

### NET-W012 — Helpful contributions
Objective: Implement useful recommendation opportunities, contribution submission and Proof-of-Helpfulness.
Dependencies: NET-W005, NET-W006, NET-W011.
Requirements: HELP-001..005.
Verification: domain, policy, moderation and integration tests.

### NET-W013 — Quality, moderation and anti-spam controls
Objective: Generalize Farmable's AI scoring/moderation architecture into provider-independent quality evaluation.
Dependencies: NET-W009, NET-W012.
Requirements: HELP-002, AI-004, FRAUD-001..003.
Verification: model-contract, adversarial and moderation tests.

### NET-W014 — Reward and settlement integration
Objective: Connect contribution outcomes to pending/mature settlement and reputation.
Dependencies: NET-W008, NET-W012, NET-W013.
Requirements: ECON-003, SETTLE-001..003.
Verification: end-to-end contribution settlement tests.

## Phase 5 — Creator network

### NET-W015 — Creator identity and preferences
Dependencies: NET-W002, NET-W007.
Requirements: CRE-001, CRE-005.

### NET-W016 — Creator matching
Dependencies: NET-W006, NET-W007, NET-W015.
Requirements: CRE-002, AI-002.

### NET-W017 — UGC workflow and rights
Dependencies: NET-W016, NET-W011, NET-W014.
Requirements: CRE-003..005.

### NET-W018 — Sponsorship and disclosure
Dependencies: NET-W017, NET-W005.
Requirements: CRE-006, DISC-001..002.

## Phase 6 — Advertising network

### NET-W019 — Inventory and placements
Dependencies: NET-W002, NET-W011.
Requirements: INV-001.., CAMP-003..004.

### NET-W020 — Cross-promotion and clearing
Dependencies: NET-W008, NET-W019.
Requirements: CAMP-004..005.

### NET-W021 — Campaign matching and optimization
Dependencies: NET-W006, NET-W007, NET-W009, NET-W019.
Requirements: CAMP-001..003, AI-002..003.

### NET-W022 — Attribution and privacy measurement adapters
Dependencies: NET-W005, NET-W006.
Requirements: OUT-002..003, PRIV-002..003.

### NET-W023 — OpenRTB and supply-chain adapters
Dependencies: NET-W019, NET-W022.
Requirements: ADAPTER-001..002.

## Phase 7 — Demand economy

### NET-W024 — Consumer Demand Pools
Dependencies: NET-W002, NET-W008.
Requirements: DEM-001..003.

### NET-W025 — Business procurement pools
Dependencies: NET-W024, NET-W008.
Requirements: DEM-001..003, PROC-001..003.

### NET-W026 — Supplier offers and competitive selection
Dependencies: NET-W025.
Requirements: PROC-001, PROC-003.

### NET-W027 — Verified savings and counterfactuals
Dependencies: NET-W006, NET-W026.
Requirements: PROC-002.

### NET-W028 — Benefit Pools
Dependencies: NET-W008, NET-W024, NET-W027, NET-W020.
Requirements: BEN-001..004.

## Phase 8 — Decentralization

### NET-W029 — Cryptographic attestations and commitments
Dependencies: NET-W005, NET-W007, NET-W008.
Requirements: EVID-006, PRIV-003.

### NET-W030 — External settlement adapters
Dependencies: NET-W008, NET-W029.
Requirements: SETTLE-001..003, ADAPTER-008.

### NET-W031 — Portable reputation proofs
Dependencies: NET-W007, NET-W029.
Requirements: REP-003..004.

### NET-W032 — Decentralized validation/dispute layer
Dependencies: NET-W010, NET-W029, NET-W030.
Requirements: GOV-001..003.

## Phase 9 — End-to-end proof

### NET-W033 — Complete contribution lifecycle
Dependencies: NET-W014, NET-W018, NET-W023, NET-W028.
Objective: Prove contribution → evidence → outcome → reputation → settlement → benefit flow.

### NET-W034 — Complete advertising lifecycle
Dependencies: NET-W020..023, NET-W033.
Objective: Prove advertiser → inventory/creator → measurement → Proof-of-Value → settlement.

### NET-W035 — Complete creator lifecycle
Dependencies: NET-W018, NET-W034.
Objective: Prove creator discovery → contract → UGC → disclosure → measurement → payment.

### NET-W036 — Complete demand/procurement/benefit lifecycle
Dependencies: NET-W028, NET-W033.
Objective: Prove demand → supplier → fulfillment → verified savings → benefit allocation.
