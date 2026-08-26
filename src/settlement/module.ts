import { defineBoundaryModule } from "../core/domain-module.ts";

/**
 * Settlement boundary module.
 * Authority: credits, pending/mature value, cash/credit settlement.
 * Concrete behaviour: NET-W008 (the double-entry economic ledger —
 * pending/mature value with explicit maturation, PoV-gated
 * Participation Credit issuance, deterministic reward accounting,
 * cash obligations with internal settlement state, and explicit
 * cash↔credits conversion).
 */
export const settlementModule = defineBoundaryModule({
  name: "settlement",
  tier: "domain",
  summary:
    "credits, pending/mature value, cash/credit settlement (NET-W008: double-entry economic ledger, explicit maturation gate, PoV-gated Participation Credits, deterministic reward allocation, cash obligations, explicit conversions)",
});
