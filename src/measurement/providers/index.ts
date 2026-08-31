/**
 * Measurement provider adapters — the ADAPTER tier of the /measurement
 * boundary (architecture §18; architecture-lock §14.24/§14.25).
 *
 * Everything under this directory is provider-side: vendor-shaped raw
 * reports, reference integrity envelopes, and the concrete platform
 * adapters (ADAPTER-003 browser/platform attribution + ADAPTER-004
 * iOS attribution — NET-W022). Provider SDK/API vocabulary never
 * crosses into domain authorities.
 */

export * from "./echo-measurement-provider.ts";
export * from "./browser-attribution-adapter.ts";
export * from "./ios-attribution-adapter.ts";
export * from "./report-integrity.ts";
export * from "./report-normalization.ts";
