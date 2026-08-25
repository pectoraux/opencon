import { defineBoundaryModule } from "../core/domain-module.ts";

/**
 * Workers boundary module (skeletal).
 * Authority: asynchronous execution only; not authoritative state. Concrete behaviour: NET-W001.
 */
export const workersModule = defineBoundaryModule({
  name: "workers",
  tier: "infrastructure",
  summary: "asynchronous execution only; not authoritative state (skeleton; NET-W001)",
});
