import { defineBoundaryModule } from "../core/domain-module.ts";

/**
 * Queues boundary module.
 * Authority: non-authoritative coordination queues, distributed/worker
 * locks, ephemeral coordination state. Concrete behaviour: NET-W003
 * (RedisCoordinationShim — locks + ephemeral state; in-memory JobQueue
 * from NET-W001 retained as a test double behind the same port).
 */
export const queuesModule = defineBoundaryModule({
  name: "queues",
  tier: "infrastructure",
  summary:
    "non-authoritative coordination queues, locks, ephemeral state (NET-W003)",
});
