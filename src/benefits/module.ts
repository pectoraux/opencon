import { defineBoundaryModule } from "../core/domain-module.ts";

/**
 * Benefits boundary module.
 * Authority: benefit allocation. NET-W028 ships the concrete Benefit
 * Pool domain inside this boundary: tenant-scoped pools funded ONLY
 * by already-authoritative upstream value (settlement economic value
 * records + demand verified savings — resolved server-side through
 * neutral lookups, never caller-asserted), immutable versioned
 * allocation policies with organization-independent lineage safety,
 * deterministic conservation-preserving allocation plans with
 * explicit remainder handling, privacy-preserving member views, and
 * THE economic mutation routed exclusively through the /settlement
 * reward-allocation draw on ONE authoritative transaction (no second
 * ledger, no new balances/accounts/credits/cash/reward primitives).
 * /workflows stays the lifecycle authority (closure is a one-way
 * field mutation); AI has no authority surface here.
 */
export const benefitsModule = defineBoundaryModule({
  name: "benefits",
  tier: "domain",
  summary:
    "benefit allocation (NET-W028: benefit pools funded from authoritative upstream value, deterministic conservation-preserving allocation, settlement-routed economic execution)",
});
