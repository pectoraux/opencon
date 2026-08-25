import { defineBoundaryModule } from "../core/domain-module.ts";

/**
 * Adapters boundary module (skeletal).
 * Authority: external platform/provider integrations (OpenRTB, creator platforms, attribution, affiliate). Concrete behaviour: NET-W019/W022/W023.
 */
export const adaptersModule = defineBoundaryModule({
  name: "adapters",
  tier: "adapter",
  summary: "external platform/provider integrations (OpenRTB, creator platforms, attribution, affiliate) (skeleton; NET-W019/W022/W023)",
});
