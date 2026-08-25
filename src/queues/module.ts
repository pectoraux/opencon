import { defineBoundaryModule } from "../core/domain-module.ts";

/**
 * Queues boundary module (skeletal).
 * Authority: non-authoritative coordination queues. Concrete behaviour: NET-W003.
 */
export const queuesModule = defineBoundaryModule({
  name: "queues",
  tier: "infrastructure",
  summary: "non-authoritative coordination queues (skeleton; NET-W003)",
});
