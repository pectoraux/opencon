import { defineBoundaryModule } from "../core/domain-module.ts";

/**
 * Ledger boundary module (skeletal).
 * Authority: external settlement network integrations. Concrete behaviour: NET-W030.
 */
export const ledgerModule = defineBoundaryModule({
  name: "ledger",
  tier: "adapter",
  summary: "external settlement network integrations (skeleton; NET-W030)",
});
