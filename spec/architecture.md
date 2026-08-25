# Open Contribution Protocol Architecture

**Version:** 1.0  
**Status:** FROZEN  
**Approved:** 2026-08-25

## 1. Purpose

Open Contribution Protocol coordinates attention, influence, useful contributions, purchasing demand and economic relationships. It measures verified value created by these interactions and distributes that value through rewards, reputation, credits, cash settlement and member benefits.

Advertising is the initial wedge, not the complete system.

## 2. Core model

```text
Opportunity
    ↓
Contribution
    ↓
Evidence
    ↓
Outcome / Helpfulness / Savings
    ↓
Verified Value
    ↓
Reputation + Reward + Credit + Settlement
```

## 3. Actors

- Person
- Creator
- Company
- Advertiser
- Publisher
- App
- Supplier
- Community
- Measurement Provider

Actors may hold multiple roles under one identity.

## 4. Core primitives

### Participant
Identity, roles, eligibility, policies, reputation references and economic accounts.

### Opportunity
A request for a measurable contribution. Opportunities may originate from campaigns, consumers, communities, creators, publishers, companies or demand pools.

### Contribution
A participant action intended to create value.

### Evidence
A verifiable record describing how a claim about a contribution or outcome is supported.

### Outcome
Measured effect such as attention, engagement, conversion, helpfulness, fulfillment or savings.

### Proof-of-Value
An evidence-backed settlement claim containing value, provenance, confidence and supporting attestations.

### Participation Credit
An earned utility/accounting unit representing verified participation value. It may determine eligibility or access but is distinct from cash.

### Reputation
A multi-dimensional record derived from verified historical performance.

### Demand Pool
An aggregate demand commitment from consumers, businesses, creators or communities.

### Benefit Pool
A pool of money, services, discounts, inventory, credits or other resources allocated according to defined member rules.

## 5. Economic model

The network creates economic value from:

- advertising contribution
- creator work
- useful discovery/helpfulness
- referrals
- procurement coordination
- collective demand
- supplier contributions
- sponsorships

The protocol earns primarily from value it creates, verifies or coordinates rather than merely taxing activity.

## 6. Advertising architecture

```text
Advertiser
   ↓
Campaign
   ↓
Matching Engine
   ↓
Inventory / Creator / Cross-Promotion
   ↓
External or Native Delivery
   ↓
Measurement
   ↓
Evidence
   ↓
Proof-of-Value
   ↓
Settlement
```

Existing ad platforms remain usable through adapters.

## 7. Creator architecture

```text
Creator Identity
   ↓
Platform connections + audience metadata
   ↓
Availability / rate / policy
   ↓
Campaign matching
   ↓
UGC or sponsored content
   ↓
Disclosure / compliance
   ↓
Outcome measurement
   ↓
Settlement + reputation
```

UGC production does not require the creator to publish to their own audience.

## 8. Helpfulness architecture

The Farmable model evolves from campaign submissions into opportunities to solve actual problems.

```text
Question / unmet need
        ↓
Opportunity discovery
        ↓
Suggested relevant solutions
        ↓
User-authored contribution
        ↓
Community + outcome evidence
        ↓
Proof-of-Helpfulness
```

Automated discovery/drafting may assist the participant, but public posting remains a user-controlled action where platform rules require it.

## 9. Demand architecture

```text
Demand Signals
      ↓
Demand Pool
      ↓
Qualified Aggregate Demand
      ↓
Supplier Competition
      ↓
Offer / Contract
      ↓
Fulfillment
      ↓
Savings / Outcome Evidence
      ↓
Verified Network Value
```

Individual commercial terms remain private where appropriate.

## 10. Benefit architecture

```text
Advertising / Procurement / Sponsorship Contributions
                       ↓
                  Benefit Pool
                       ↓
            Eligibility / Allocation
                       ↓
             Member Resource Access
```

Benefits may be discounts, services, credits, cash, inventory, education or other resources.

## 11. Reputation architecture

Reputation is multi-dimensional and must not be purchasable.

Dimensions include:

- helpfulness
- content quality
- creator performance
- inventory quality
- measurement reliability
- commerce reliability
- fraud resistance
- fulfillment/reliability

Each major reputation change is traceable to evidence.

## 12. Fraud architecture

Fraud detection combines:

- identity signals
- behavioral signals
- device/platform integrity where available
- graph analysis
- economic anomaly detection
- historical reputation
- model ensembles
- staking/bonding
- delayed settlement
- challenge mechanisms

No single signal is authoritative.

## 13. Measurement architecture

Measurement supports:

- deterministic attribution
- probabilistic attribution
- experimental incrementality
- privacy-preserving platform attribution
- counterfactual savings measurement

All economically material values retain confidence/uncertainty information.

## 14. AI architecture

AI services are provider-independent.

Use cases include:

- matching
- fraud detection
- brand safety
- content/helpfulness scoring
- creator campaign automation
- procurement optimization

AI outputs remain recommendations/evidence inputs rather than unilateral economic truth.

## 15. Interoperability

Adapters target existing standards and ecosystems where practical:

- OpenRTB
- ads.txt / app-ads.txt
- sellers.json / SupplyChain
- browser/platform attribution systems
- creator platforms
- affiliate/referral systems
- payment providers
- external settlement networks

## 16. Decentralization strategy

Initial system:

- centralized authoritative PostgreSQL state
- off-chain evidence
- adapters for external platforms
- conventional payment rails

Later layers may add:

- signed attestations
- evidence commitments
- portable reputation proofs
- staking
- decentralized dispute/validation
- decentralized settlement

Blockchain is a settlement/trust mechanism, not the real-time ad-serving database.

## 17. Authoritative workflow

All economically and operationally material protocol operations use a deterministic workflow owned by the `/workflows` boundary.

Canonical opportunity/contribution lifecycle:

```text
DRAFT
→ READY
→ ASSIGNED
→ IN_PROGRESS
→ SUBMITTED
→ MEASURING
→ EVALUATING
→ CHALLENGE_WINDOW
→ SETTLING
→ SETTLED
→ VERIFIED
```

Exceptional states:

```text
BLOCKED
FRAUD_REVIEW
DISPUTED
REJECTED
CANCELLED
```

External agents, AI services and user interfaces may propose actions but may not directly mutate authoritative state. All transitions are authorized, deterministic and idempotent.

## 18. Module ownership

Each domain owns its entities and business rules. Cross-domain access occurs through declared application/domain interfaces.

| Boundary | Authority |
|---|---|
| `/identity`, `/organizations`, `/participants` | identity, roles, organization membership and eligibility |
| `/opportunities`, `/contributions` | opportunities, contribution lifecycle and submission state |
| `/campaigns`, `/inventory`, `/creators` | campaign/inventory/creator domain rules |
| `/demand`, `/benefits` | demand aggregation and benefit allocation |
| `/evidence`, `/outcomes` | evidence, measurement semantics, outcome evaluation |
| `/reputation` | reputation computation and provenance |
| `/settlement` | credits, pending/mature value, cash/credit settlement |
| `/disputes` | challenges, disputes, appeals and penalties |
| `/workflows` | authoritative lifecycle transitions and orchestration |
| `/api` | external application/API contract |
| `/workers` | asynchronous execution only; not authoritative state |
| `/llm`, `/agents` | provider-neutral AI and agent execution |
| `/adapters` | external platform/provider integrations |
| `/measurement` | measurement provider integrations; semantics remain in `/outcomes` |
| `/payments` | payment provider integrations; settlement semantics remain in `/settlement` |

## 19. Architectural authority rules

- PostgreSQL is the authoritative application state in v1.0.
- Redis, queues and caches are coordination infrastructure and are never authoritative.
- Object storage holds large/immutable artifacts referenced from PostgreSQL.
- External platforms are authoritative for their own platform state.
- AI/model output is never sufficient by itself to authorize settlement, reputation, or governance state.
- Frontend clients never own workflow or authorization authority.

## 20. Initial-vs-future boundary

The initial implementation proves the economic semantics with conventional centralized infrastructure before introducing decentralized settlement or public proofs.

Decentralization features are extensions of stable semantics, not prerequisites for defining those semantics.
