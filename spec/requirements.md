# Requirements and Acceptance Criteria

**Version:** 1.0  
**Status:** APPROVED BASELINE  
**Approved:** 2026-08-25

## Requirement families

| ID | Requirement family |
|---|---|
| CORE | protocol/runtime foundation |
| ID | identity, organizations, participant roles |
| OPP | opportunities and contributions |
| CAMP | campaigns and advertising |
| INV | inventory, placements and supply authorization |
| CRE | creators and UGC |
| HELP | helpfulness/recommendation |
| DEM | demand pools |
| PROC | procurement and savings |
| BEN | benefit pools |
| REP | reputation |
| EVID | evidence and Proof-of-Value |
| OUT | outcomes and measurement |
| FRAUD | abuse resistance |
| ECON | credits and economic accounting |
| SETTLE | cash/credit settlement |
| DISC | disclosure/commercial transparency |
| PRIV | privacy |
| ADAPTER | ecosystem integration |
| AI | provider-independent intelligence |
| GOV | governance/disputes |
| AUD | auditability |
| API | protocol/API contracts |

## Core requirements

- CORE-001: Provide a provider-independent contribution/value protocol supporting advertising, creators, helpfulness, referrals, demand and procurement.
- CORE-002: Implement as a modular monolith with asynchronous workers first.
- CORE-003: Do not issue economically material rewards from raw activity alone.
- CORE-004: Keep external provider-specific behavior behind adapters.

## Identity

- ID-001: Provide one identity usable across all network products.
- ID-002: Support PERSON, CREATOR, COMPANY, ADVERTISER, PUBLISHER, APP, SUPPLIER, COMMUNITY and MEASUREMENT_PROVIDER roles.
- ID-003: Preserve portable reputation at network level.
- ID-004: Preserve separate reputation dimensions.

## Opportunities and contributions

- OPP-001: Represent contribution opportunities as first-class objects.
- OPP-002: Support discovered → eligible → accepted → in-progress → submitted → measured → evaluated → settled lifecycle.
- OPP-003: Reward quality/value rather than raw volume.
- OPP-004: Apply diminishing returns to contribution volume.

## Advertising

- CAMP-001: Support awareness, attention, engagement, intent, conversion, incremental conversion, creator-content, cross-promotion and referral objectives.
- CAMP-002: Campaigns define outcome, evidence, attribution, confidence and settlement policy before activation.
- CAMP-003: Interoperate with existing advertising ecosystem.
- CAMP-004: Support non-reciprocal cross-promotion.
- CAMP-005: Support multilateral advertising-value clearing.

## Inventory / placements

- INV-001: Represent publisher/app/creator inventory and placements as first-class objects.
- INV-002: Record inventory format, placement context, eligibility, policy and source identity.
- INV-003: Support inventory authorization/provenance using existing ecosystem signals where available.
- INV-004: Prevent inventory from being eligible for settlement without a registered owner/source and policy context.

## API / protocol contracts

- API-001: Expose provider-independent versioned API contracts for protocol clients.
- API-002: Enforce authentication, authorization and tenant/participant scoping server-side.
- API-003: Keep workflow transitions behind authorized workflow operations.
- API-004: Make material mutation endpoints idempotent where duplicate delivery/retry is possible.
- API-005: Return stable identifiers and traceable execution/evidence references for material operations.

## Creators

- CRE-001: Creators define platform, audience, topic, language, format, rates, rights and restrictions.
- CRE-002: Match creators and campaigns by relevance, audience quality, historic outcomes, safety, price and availability.
- CRE-003: Support creator auto-match/auto-accept policies.
- CRE-004: Support UGC without requiring publication on creator-owned channels.
- CRE-005: Separate audience influence from production reputation.
- CRE-006: Represent required commercial disclosures.

## Helpfulness

- HELP-001: Let participants respond to real questions/unmet needs with relevant solutions.
- HELP-002: Score contextual relevance and usefulness rather than mere product mention.
- HELP-003: Provide Proof-of-Helpfulness using multiple evidence sources.
- HELP-004: Prohibit incentives conditioned on positive sentiment or fabricated experience.
- HELP-005: Keep public posting user-controlled where required.

## Evidence / Proof-of-Value

- EVID-001: Every material settlement claim references evidence.
- EVID-002: Evidence records provenance, method, timestamp, scope and confidence.
- EVID-003: Support multiple evidence grades.
- EVID-004: Combine independent evidence sources.
- EVID-005: Preserve uncertainty/confidence intervals where meaningful.
- EVID-006: Support cryptographic commitments for sensitive evidence.

## Outcomes / measurement

- OUT-001: Support view, attention, engagement, intent, install, signup, purchase, subscription, retention, referral, savings, fulfillment and helpfulness outcomes.
- OUT-002: Support deterministic, probabilistic and experimental attribution.
- OUT-003: Support incrementality testing where feasible.
- OUT-004: Support counterfactual value measurement for procurement/savings.
- OUT-005: Support delayed settlement/finality windows.

## Fraud

- FRAUD-001: Use multiple fraud signals.
- FRAUD-002: Mitigate Sybil attacks using identity, reputation, stake, graph and behavior signals.
- FRAUD-003: Detect suspicious collusion/cycles.
- FRAUD-004: Allow economic accountability/staking for high-value claims.
- FRAUD-005: Provide claim challenge mechanisms.
- FRAUD-006: Maintain fraud/dispute reserves.

## Reputation

- REP-001: Maintain helpfulness, content, creator, traffic/inventory, measurement, commerce, reliability and fraud-resistance dimensions.
- REP-002: Advertising spend and wealth cannot directly purchase reputation.
- REP-003: Apply time decay.
- REP-004: Trace material reputation changes to evidence.

## Economy / settlement

- ECON-001: Provide Participation Credits as earned utility/accounting units.
- ECON-002: Prevent raw activity from directly minting credits.
- ECON-003: Tie credit issuance to verified value.
- ECON-004: Separate cash, pending value, mature value, credits and reputation.
- ECON-005: Credits may grant network utility but do not automatically represent investment value.
- SETTLE-001: Support cash and credit settlement.
- SETTLE-002: Support pending/mature states and settlement windows.
- SETTLE-003: Preserve settlement lineage.

## Demand / procurement

- DEM-001: Support consumer and business Demand Pools.
- DEM-002: Support privacy-preserving aggregation.
- DEM-003: Support competitive supplier offers.
- PROC-001: Support demand → qualification → supplier discovery → offer → selection → fulfillment → savings verification.
- PROC-002: Savings require evidence-supported counterfactual/baseline.
- PROC-003: Prevent unlawful exchange of commercially sensitive competitor information.

## Benefits

- BEN-001: Support cash, discounts, services, credits, rebates, inventory and other benefit types.
- BEN-002: Allow funding from advertising, procurement, sponsorship and approved network contributions.
- BEN-003: Allocate benefits by defined eligibility policies, not raw spending alone.
- BEN-004: Measure value delivered to members.

## Privacy / disclosure

- DISC-001: Explicitly represent commercial relationships.
- DISC-002: Prevent fabricated personal experience claims.
- PRIV-001: Do not publish raw personal activity on a public ledger.
- PRIV-002: Keep sensitive evidence with the appropriate party where possible.
- PRIV-003: Support privacy-preserving aggregation/proofs.

## Interoperability

- ADAPTER-001: OpenRTB adapter.
- ADAPTER-002: Ads.txt/app-ads.txt/sellers.json/SupplyChain integration boundary.
- ADAPTER-003: Browser/platform attribution adapters.
- ADAPTER-004: iOS attribution adapter boundary.
- ADAPTER-005: Creator platform adapters.
- ADAPTER-006: Affiliate/referral adapters.
- ADAPTER-007: Payment provider adapters.
- ADAPTER-008: External settlement adapters.

## AI

- AI-001: Provider-independent AI gateway.
- AI-002: AI-assisted matching.
- AI-003: AI-assisted fraud/risk analysis.
- AI-004: AI-assisted helpfulness/content scoring.
- AI-005: AI-assisted safety/compliance classification.
- AI-006: AI-assisted procurement optimization.
- AI-007: Record model/provider performance without making one provider authoritative.

## Governance / audit

- GOV-001: Version governance policies.
- GOV-002: Support disputes/challenges/appeals.
- GOV-003: Keep protocol governance separate from campaign verification.
- AUD-001: Append-oriented audit trail.
- AUD-002: Evidence lineage.
- AUD-003: Settlement lineage.
- AUD-004: Reputation lineage.
- AUD-005: Administrative action logging.

## Initial acceptance criteria

### CORE
- CORE-AC-01: Frozen modules exist as explicit boundaries — static architecture test.
- CORE-AC-02: Cross-module access uses declared interfaces — static architecture test.
- CORE-AC-03: Long-running operations execute asynchronously — integration test.
- CORE-AC-04: No reward path can settle solely from an unverified activity counter — integration test.

### Evidence
- EVID-AC-01: Every settled economic claim references persisted evidence — integration/database test.
- EVID-AC-02: Evidence records provenance and confidence — API/database test.
- EVID-AC-03: Evidence from multiple sources can be aggregated — unit/integration test.
- EVID-AC-04: Sensitive evidence can remain off-ledger while its commitment is persisted — integration test.

### Economics
- ECON-AC-01: Credit issuance without a valid verified-value reference is rejected — integration test.
- ECON-AC-02: Cash and credits cannot be silently interchanged — domain test.
- ECON-AC-03: Reputation does not change merely because advertising spend increases — integration test.

### Helpfulness
- HELP-AC-01: Mentioning a product without qualifying usefulness generates no final reward — domain test.
- HELP-AC-02: Positive sentiment cannot be a required campaign condition — validation test.
- HELP-AC-03: User-authored public contribution remains explicitly controlled — end-to-end/platform test.

### Creator
- CRE-AC-01: Creator auto-match respects configured category/rate/platform restrictions — integration test.
- CRE-AC-02: Sponsored relationship metadata is preserved from campaign through publication/evidence — integration test.
- CRE-AC-03: Creator UGC can settle without creator-owned audience publication — integration test.

### Fraud
- FRAUD-AC-01: A participant cannot create unlimited independent reward-eligible identities without satisfying identity/risk policy — security/integration test.
- FRAUD-AC-02: Suspicious high-value claims can enter challenge state — workflow test.
- FRAUD-AC-03: Fraud findings can reduce or freeze pending value before final settlement — integration test.

### Procurement
- PROC-AC-01: A savings claim cannot settle without an evidence-backed baseline — integration test.
- PROC-AC-02: Individual company commercial terms are not exposed to other pool participants by default — privacy test.
- PROC-AC-03: Supplier selection records the offer set and selection rationale — audit/integration test.

### Inventory / API
- INV-AC-01: Every inventory record has an owner/source identity and placement definition — database/integration test.
- INV-AC-02: Unauthorized or unregistered inventory cannot enter settlement — domain/integration test.
- INV-AC-03: Supply authorization/provenance fields can be captured and audited — contract/integration test.
- API-AC-01: Core API contracts are versioned and provider-independent — API contract/static architecture test.
- API-AC-02: Unauthorized domain mutations are rejected server-side — security/end-to-end test.
- API-AC-03: Duplicate material requests produce one logical mutation — idempotency integration test.
- API-AC-04: Material responses expose stable identifiers and evidence/execution references — API contract test.

### Workflow / settlement
- WF-AC-01: Legal opportunity/contribution transitions are deterministic and invalid transitions are rejected — exhaustive state-machine test.
- WF-AC-02: SETTLED cannot be reached before required evidence/evaluation/challenge conditions — workflow integration test.
- WF-AC-03: Disputed or fraud-held pending value cannot mature — economic workflow test.
- WF-AC-04: Replayed transitions are idempotent — workflow integration test.
