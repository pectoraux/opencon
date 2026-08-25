import { defineBoundaryModule } from "../core/domain-module.ts";

/**
 * Llm boundary module (skeletal).
 * Authority: provider-neutral AI execution (matching, fraud, helpfulness scoring, etc.). Concrete behaviour: NET-W013.
 */
export const llmModule = defineBoundaryModule({
  name: "llm",
  tier: "adapter",
  summary: "provider-neutral AI execution (matching, fraud, helpfulness scoring, etc.) (skeleton; NET-W013)",
});
