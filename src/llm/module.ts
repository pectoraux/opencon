import { defineBoundaryModule } from "../core/domain-module.ts";

/**
 * Llm boundary module.
 * Authority: provider-neutral AI execution (matching, fraud,
 * helpfulness/content scoring, safety, etc.).
 *
 * NET-W013 made the boundary concrete: the neutral completion +
 * advisory-scoring contracts (src/llm/port.ts) and the deterministic
 * ECHO reference provider (src/llm/providers/echo-llm-provider.ts),
 * wired and consumed at the composition root (the advisory
 * quality-score path). AI output is structurally non-authoritative
 * (architecture-lock §4). Concrete external providers are adapter-tier
 * extensions of the same neutral port.
 */
export const llmModule = defineBoundaryModule({
  name: "llm",
  tier: "adapter",
  summary:
    "provider-neutral AI execution (matching, fraud, helpfulness/content " +
    "scoring, safety) (NET-W013: concrete completion + advisory scoring " +
    "contracts with the deterministic echo reference provider; outputs are " +
    "never authoritative)",
});
