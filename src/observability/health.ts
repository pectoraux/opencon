/**
 * Health boundary — minimal health/readiness/liveness surface.
 *
 * Work order ref: NET-W001 §4.6 ("minimal health/readiness/liveness
 * observability needed to operate the skeleton").
 *
 * Aggregates per-module health checks into a single report. The HTTP
 * boundary exposes /health, /ready and /live from this aggregator.
 */

import type { HealthCheckResult, HealthReport, HealthStatus } from "../core/logger.ts";

export interface HealthCheck {
  readonly name: string;
  check(): Promise<HealthCheckResult | HealthStatus>;
}

export class HealthAggregator {
  private readonly checks = new Map<string, HealthCheck>();

  public register(name: string, check: HealthCheck): void {
    if (this.checks.has(name)) {
      throw new Error(`health check already registered: ${name}`);
    }
    this.checks.set(name, check);
  }

  public async report(): Promise<HealthReport> {
    const results: HealthCheckResult[] = [];
    for (const [name, check] of this.checks) {
      let result: HealthCheckResult;
      try {
        const r = await check.check();
        if (typeof r === "string") {
          result = { name, status: r, observedAt: new Date().toISOString() };
        } else {
          result = r;
        }
      } catch (err) {
        result = {
          name,
          status: "fail",
          message: err instanceof Error ? err.message : String(err),
          observedAt: new Date().toISOString(),
        };
      }
      results.push(result);
    }
    const overall: HealthStatus = results.some((r) => r.status === "fail")
      ? "fail"
      : results.some((r) => r.status === "warn")
        ? "warn"
        : "pass";
    return {
      status: overall,
      checks: results,
      observedAt: new Date().toISOString(),
    };
  }
}
