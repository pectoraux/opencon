import { defineBoundaryModule } from "../core/domain-module.ts";

/**
 * Adapters boundary module.
 * Authority: external platform/provider integrations (OpenRTB, creator
 * platforms, attribution, affiliate). NET-W023 carries the OpenRTB +
 * supply-chain adapter surface: neutral protocol contracts (port),
 * the provider registry/ingress + the reference OpenRTB adapter
 * (adapter tier), fail-closed normalization with privacy redaction,
 * the seller-authorization trust envelope (PR #47 remediation:
 * verification = authenticated + fresh + consistent — fabricated
 * caller content never produces `verified`), and the neutral
 * read-only inventory lookup implemented at the composition root.
 */
export const adaptersModule = defineBoundaryModule({
  name: "adapters",
  tier: "adapter",
  summary:
    "external platform/provider integrations (OpenRTB + supply-chain adapters, creator platforms, attribution, affiliate)",
});
