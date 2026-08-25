# Architecture Lock

**Version:** 1.0  
**Status:** FROZEN  
**Approved:** 2026-08-25

This document is authoritative for the frozen architectural rules of Open Contribution Protocol v1.0.

## 1. Core invariants

1. The protocol is contribution/value infrastructure, not merely an advertising exchange.
2. Architecture is frozen for an implementation attempt; changes require an Architecture Change Request and a new architecture version.
3. No economically material reward may be created from raw activity alone.
4. Evidence, not participant or agent claims, is authoritative for settlement and reputation.
5. Provider-specific behavior remains behind adapters.
6. Raw personal activity data is not placed on a public ledger.
7. Participation Credits are distinct from cash settlement and are not inherently speculative assets.
8. Reputation cannot be purchased with advertising spend or wealth.
9. Commercial recommendations must preserve required disclosure and must not condition reward on positive sentiment.
10. Purchasing coordination must use privacy-preserving, independently operated mechanisms and must not facilitate unlawful competitor coordination.

## 2. Architectural scope

The v1.0 protocol contains these core domains:

- `/identity`
- `/organizations`
- `/participants`
- `/opportunities`
- `/contributions`
- `/campaigns`
- `/inventory`
- `/creators`
- `/demand`
- `/benefits`
- `/reputation`
- `/evidence`
- `/outcomes`
- `/settlement`
- `/disputes`

Infrastructure boundaries:

- `/api`
- `/workers`
- persistence
- queues
- object storage
- secrets
- observability

External integrations:

- `/llm`
- `/agents`
- `/adapters`
- `/measurement`
- `/payments`
- ledger/settlement networks

## 3. System of record

PostgreSQL is authoritative application state for the initial implementation.

External platforms remain authoritative for their own platform state where appropriate.

Conversation history and LLM memory are never system-of-record data.

## 4. Evidence authority

The evidence subsystem owns evidence, evidence provenance, confidence and verification semantics.

Agent/model output is input evidence or a recommendation; it does not directly authorize settlement.

## 5. Economic authority

The economic engine owns Participation Credits, pending value, matured value, reward calculations and settlement records.

Credit issuance must reference verified value.

## 6. Privacy authority

Sensitive evidence may remain off-chain/off-platform. Cryptographic commitments, aggregate evidence, and attestations may be used to prove integrity without publishing raw personal data.

## 7. Workflow authority

Workflow orchestration owns lifecycle transitions. External agents, providers and UI clients cannot directly mutate authoritative workflow state outside authorized APIs.

## 8. Change control

Approved architectural changes create a new immutable architecture version. Work Items must reference exactly one architecture version.

## 9. Initial implementation posture

The system is a modular monolith with background workers. Service extraction is permitted later, but no microservice decomposition is required for v1.0.

## 10. Product expression

The protocol may be surfaced through separate products/clients:

- Farmable — contribution/helpfulness marketplace
- Creator Partnerships — creator/UGC market
- Ad Network — advertising/cross-promotion market
- Demand — consumer/business demand aggregation and procurement
- Benefits — member benefit pools

These are clients over common protocol primitives, not separate economic systems.
