# Open Contribution Protocol

Open Contribution Protocol (OpenCon) is an open protocol for coordinating advertising, creator partnerships, helpful contributions, collective demand, procurement, and member benefits.

## Development status

**Architecture:** v1.0 FROZEN  
**Requirements:** v1.0 APPROVED BASELINE  
**Implementation:** Not started  
**Next eligible work item:** `NET-W001`  
**Implementation agent:** Z.ai  
**Architect:** OpenCon architecture authority

## Development model

Architecture-first, evidence-driven implementation following the WorkflowOS development method:

```text
Architecture
→ Requirements
→ Acceptance Criteria
→ Work Items
→ Work Orders
→ Z.ai Implementation
→ Verification
→ Architect Review
→ Merge
→ Verified
```

Z.ai is an implementation participant, not the authority for architecture, workflow state, verification semantics, or settlement truth.

## Initial specification

- `spec/architecture.md` — approved v1.0 architectural design
- `spec/architecture-lock.md` — frozen architectural invariants
- `spec/requirements.md` — v1.0 requirements and acceptance criteria
- `spec/work-items.md` — implementation backlog and definitions of done
- `spec/dependency-graph.md` — implementation dependencies and eligibility rules

## Architectural principles

- Evidence over claims.
- Verified value over raw activity.
- Provider-independent core with explicit adapters.
- PostgreSQL is authoritative application state in v1.0.
- External platforms remain authoritative for their own platform state.
- AI recommendations never unilaterally authorize settlement or reputation.
- Participation Credits are distinct from cash settlement.
- Public ledger storage does not contain raw personal activity.
- Frozen architecture changes require an Architecture Change Request and a new architecture version.

## Product expressions

The common protocol may be surfaced through separate clients/products:

- Farmable — contribution/helpfulness marketplace
- Creator Partnerships — creator/UGC market
- Ad Network — advertising/cross-promotion market
- Demand — consumer/business demand aggregation and procurement
- Benefits — member benefit pools

These are clients over common protocol primitives, not separate economic systems.
