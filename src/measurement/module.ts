import { defineBoundaryModule } from "../core/domain-module.ts";

/**
 * Measurement boundary module (skeletal).
 * Authority: measurement provider integrations; semantics remain in /outcomes. Concrete behaviour: NET-W006/W022.
 */
export const measurementModule = defineBoundaryModule({
  name: "measurement",
  tier: "adapter",
  summary: "measurement provider integrations; semantics remain in /outcomes (skeleton; NET-W006/W022)",
});
