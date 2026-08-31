# `adapters` boundary

**Tier:** adapter
**Authority:** external platform/provider integrations (OpenRTB, creator platforms, attribution, affiliate)
**Architecture ref:** `spec/architecture.md` §18 (Module ownership), architecture-lock §14 (provider SDK/types never cross into core domain modules)

## Scope

- **Neutral tier (`port.ts`, `index.ts`, `module.ts`):** the
  provider-neutral OpenRTB + supply-chain contracts, the closed
  rejection-reason vocabularies, the `OpenRtbProviderAdapter` /
  `OpenRtbProviderRegistry` / `OpenRtbIngressService` interfaces and
  the neutral read-only `ExternalInventorySupplyLookup`
  (dependency-inverted: implemented at the bootstrap composition root
  over `/inventory` reads). The neutral port imports ONLY core
  contracts.
- **Adapter tier (`registry.ts`, `ingress.ts`, `openrtb/`):**
  provider-specific wire formats, parsers and validation — the
  reference OpenRTB bid-request shape (`openrtb/vendor-request.ts`),
  the ads.txt / app-ads.txt / sellers.json grammars
  (`openrtb/supply-chain-files.ts`), the reference provider adapter
  (`openrtb/reference-adapter.ts`) and the deterministic canonical
  serialization/digest helper (`openrtb/canonical-json.ts`). The
  adapter tier imports core contracts + the neutral port only; NEVER
  domain modules (tier matrix).

## NET-W023 — OpenRTB and supply-chain adapters

External ad supply connects through this boundary without becoming a
second authority:

1. Raw OpenRTB bid requests and seller-authorization files are
   normalized fail-closed (closed rejection vocabulary, bounded
   cardinalities, privacy redaction by field name only) into
   provider-neutral protocol facts.
2. The ingress service routes submissions by provider id (one adapter
   per provider identity; spoofed identities fail closed), enforces
   the neutral contract on adapter output, and derives the
   admission evaluation: exact-one inventory resolution through the
   NEUTRAL read-only lookup (zero/multiple/cross-tenant matches fail
   closed), availability + format checks, and supply-chain
   verification (ads.txt + sellers.json cross-checks with staleness,
   ambiguity and completeness rules). The evaluation is a PURE
   derivation — no mutation, no authority.
3. The bootstrap composition root is the only join to the domain
   authorities (`runtime.ts`: the lookup over `/inventory` reads; the
   `evaluateExternalAdRequest` api command; the ONE sanctioned
   material path — delivery-notice measurement facts through the
   W022 `/measurement` → `/outcomes` ingestion composite).
4. Provider vocabulary (device/user/regs vendor fields, OpenRTB
   grammar, schain structure) NEVER crosses this boundary: normalized
   output carries only the neutral contract fields + deterministic
   digests.

## Dependencies

Core contracts (vocabularies, errors) + the neutral measurement port
(the delivery-notice measurement adapter implements the W022
`MeasurementProviderAdapter` contract from the `/measurement`
provider tier). Cross-domain access happens ONLY through
composition-root wiring.
