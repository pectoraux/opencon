import { defineBoundaryModule } from "../core/domain-module.ts";

/**
 * Payments boundary module (skeletal).
 * Authority: payment provider integrations; settlement semantics remain in /settlement. Concrete behaviour: NET-W008/W030.
 */
export const paymentsModule = defineBoundaryModule({
  name: "payments",
  tier: "adapter",
  summary: "payment provider integrations; settlement semantics remain in /settlement (skeleton; NET-W008/W030)",
});
