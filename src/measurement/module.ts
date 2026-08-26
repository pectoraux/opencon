import { defineBoundaryModule } from "../core/domain-module.ts";

/**
 * Measurement boundary module.
 * Authority: measurement provider integrations; semantics remain in
 * /outcomes (architecture §18). NET-W006 delivers the provider-neutral
 * MeasurementProviderAdapter contract (the integration surface the
 * /outcomes domain consumes); concrete platform adapters (browser/
 * platform attribution, iOS attribution — ADAPTER-003..004) arrive in
 * NET-W022 as adapters under src/measurement/providers/.
 */
export const measurementModule = defineBoundaryModule({
  name: "measurement",
  tier: "adapter",
  summary:
    "measurement provider integrations behind the NET-W006 provider-neutral adapter contract; measurement semantics remain in /outcomes; concrete platform adapters NET-W022",
});
