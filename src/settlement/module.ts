import { defineBoundaryModule } from "../core/domain-module.ts";

/**
 * Settlement boundary module.
 * Authority: credits, pending/mature value, cash/credit settlement.
 * Concrete behaviour: NET-W008 (the double-entry economic ledger —
 * pending/mature value with explicit maturation, PoV-gated
 * Participation Credit issuance, deterministic reward accounting,
 * cash obligations with internal settlement state, and explicit
 * cash↔credits conversion). NET-W010 adds the stake escrow commands
 * (commit/release/forfeit) — the economic authority for challenge
 * participation stakes consumed by the /disputes boundary through
 * composition-root orchestration. NET-W020 adds the cross-promotion
 * clearing EXECUTION records (pure lineage — references + the
 * re-derived eligibility snapshot; the economic mutation itself flows
 * exclusively through the existing reward/credit/cash primitives
 * composed at the bootstrap boundary — no second ledger).
 */
export const settlementModule = defineBoundaryModule({
  name: "settlement",
  tier: "domain",
  summary:
    "credits, pending/mature value, cash/credit settlement (NET-W008: double-entry economic ledger, explicit maturation gate, PoV-gated Participation Credits, deterministic reward allocation, cash obligations, explicit conversions; NET-W010: stake escrow commands; NET-W020: cross-promotion clearing records)",
});
