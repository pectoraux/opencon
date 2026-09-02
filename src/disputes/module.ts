import { defineBoundaryModule } from "../core/domain-module.ts";

/**
 * Disputes boundary module — the Phase-3 Trust domain.
 *
 * Authority (architecture §18): challenges, disputes, appeals and
 * penalties. NET-W009 implements the fraud/risk FOUNDATION in this
 * boundary (see the work order §2 placement decision: the frozen
 * architecture names no dedicated /fraud or /risk domain; /workflows
 * explicitly renounces fraud decisions; /settlement and /reputation
 * are excluded by the risk invariants; /disputes is the Phase-3
 * Trust boundary and NET-W010 stacks challenges/disputes on this
 * foundation):
 *  - first-class risk signals (provenance-backed, append-only);
 *  - versioned deterministic risk policies (org-independent lineage
 *    mutex — the NET-W007 PR #14 remediation pattern);
 *  - multi-signal risk assessments preserving signal-level provenance
 *    (pure deterministic engine, digest-reproducible);
 *  - evidence-backed review cases (append-only decision history);
 *  - control decisions — the workflow/economic gate registry consumed
 *    at the composition root (lock invariant 21 enforcement point).
 *
 * NET-W010 extends the same boundary with the challenge/dispute/
 * appeal lifecycle: participant-initiated challenges over prior
 * decisions / risk cases / authoritative records, explicit
 * stake-bonded participation (the economic accounting lives in
 * /settlement's stake escrow — NEVER here), conflict-checked
 * reviewer workflows, deterministic resolution dispositions
 * (control outcome separated from the economic consequence), and
 * appeals as NEW linked records (append-only history).
 *
 * NET-W032 extends the same boundary with the decentralized
 * VALIDATION/DISPUTE COORDINATION layer: scoped validator
 * participants, deterministic assignment (conflict-of-interest
 * exclusions + frozen (registeredAt, id) tie-break + versioned
 * cardinality), bounded validation challenge rounds (immutable
 * facts + explicit outcome records — no second workflow engine),
 * independent validator observations with opaque W029/W031 evidence
 * references, deterministic quorum/outcome derivation (the PURE
 * quorum-engine over the versioned policy contract) and accepted
 * outcomes applied ONLY through the owning authority's sanctioned
 * mutation boundary (composition-root orchestration; validator
 * stakes escrow in /settlement — NEVER here).
 *
 * Decision-support and control authority ONLY: no economic mutation,
 * no reputation mutation, no lifecycle mutation (those belong to
 * /settlement, /reputation and /workflows).
 */
export const disputesModule = defineBoundaryModule({
  name: "disputes",
  tier: "domain",
  summary:
    "fraud/risk foundation: signals, deterministic policies, " +
    "assessments, review cases, control gates (NET-W009); challenges/" +
    "disputes/appeals with explicit settlement-authority staking " +
    "(NET-W010); decentralized validation coordination: validators, " +
    "deterministic assignments, quorum outcomes applied only through " +
    "the owning authorities (NET-W032)",
});
