import { defineBoundaryModule } from "../core/domain-module.ts";

/**
 * Measurement boundary module.
 * Authority: measurement provider integrations; semantics remain in
 * /outcomes (architecture §18). NET-W006 delivered the provider-neutral
 * MeasurementProviderAdapter contract (the integration surface the
 * /outcomes domain consumes); NET-W022 added the push-ingestion
 * contract (optional normalizeReport), the provider registration
 * boundary, and the reference browser/platform + iOS attribution
 * adapters (ADAPTER-003..004) under src/measurement/providers/.
 */
export const measurementModule = defineBoundaryModule({
  name: "measurement",
  tier: "adapter",
  summary:
    "measurement provider integrations behind the NET-W006 provider-neutral adapter contract + the NET-W022 attribution/privacy push adapters and registration boundary; measurement semantics remain in /outcomes",
});
