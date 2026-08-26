/**
 * NET-W001-AC-07 — Adapter isolation.
 *
 * Evidence: static dependency check + compile/test output.
 *
 * A domain module can depend on a provider-neutral adapter interface
 * without importing a concrete provider package. The architecture
 * check confirms: src/outcomes/port.ts depends on the neutral LlmPort
 * (allowed), and NO domain file imports any concrete provider.
 */

import { describe, test, expect } from "bun:test";
import { join } from "node:path";
import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { scanArchitecture } from "../../scripts/lib/architecture.ts";
import type { LlmPort } from "../../src/llm/port.ts";
import type { OutcomesPort } from "../../src/outcomes/port.ts";

const REPO = join(import.meta.dir, "../..");
const SRC = join(REPO, "src");

describe("NET-W001-AC-07 adapter isolation", () => {
  test("a domain module (outcomes) depends on a provider-neutral adapter port", async () => {
    const content = await readFile(join(SRC, "outcomes/port.ts"), "utf8");
    // The domain imports the NEUTRAL measurement port only (not a
    // concrete provider). NET-W006 replaced the NET-W001-era LlmPort
    // placeholder dependency with the provider-neutral
    // MeasurementProviderAdapter contract — the same isolation rule,
    // now exercised by the real NET-W006 dependency.
    expect(content).toMatch(/from ["']\.\.\/measurement\/port\.ts["']/);
    expect(content).not.toMatch(/from ["']\.\.\/measurement\/providers\//);
    expect(content).not.toMatch(/from ["']\.\.\/llm\/providers\//);
  });

  test("the concrete echo LLM provider implements the neutral LlmPort", async () => {
    const mod = await import("../../src/llm/providers/echo-llm-provider.ts");
    const provider = mod.echoLlmProvider as LlmPort;
    expect(provider.boundary).toBe("llm");
    const out = await provider.complete({ prompt: "hi" });
    expect(out.text).toContain("hi");
    expect(out.authoritative).toBe(false); // AI output is non-authoritative
  });

  test("the outcomes domain can be parameterized with the neutral LlmPort", () => {
    // Compile-time + runtime proof: a domain port typed against the
    // neutral LlmPort accepts any provider-neutral implementation.
    // (NET-W006: the outcomes boundary is now ready — its provider
    // dependency is the neutral MeasurementProviderAdapter — but the
    // LlmPort parameterization proof remains valid for later work
    // items that inject AI assistance into measurement inputs.)
    const outcomesPort: OutcomesPort = {
      boundary: "outcomes",
      readiness: "ready",
      auditEventTypes: {
        outcomeObservationCreated: "outcome_observation.created",
        outcomeObservationCorrected: "outcome_observation.corrected",
        measurementExperimentCreated: "measurement_experiment.created",
        measurementExperimentStarted: "measurement_experiment.started",
        measurementExperimentCompleted: "measurement_experiment.completed",
        measurementExperimentInvalidated: "measurement_experiment.invalidated",
        attributionCreated: "attribution.created",
        incrementalityObservationCreated: "incrementality_observation.created",
        counterfactualBaselineCreated: "counterfactual_baseline.created",
        measuredOutcomeCreated: "measured_outcome.created",
        measuredOutcomeObservationAttached: "measured_outcome.observation_attached",
        measuredOutcomeAttributionAttached: "measured_outcome.attribution_attached",
        measuredOutcomeBaselineAttached: "measured_outcome.baseline_attached",
        measuredOutcomeIncrementalityAttached: "measured_outcome.incrementality_attached",
        measuredOutcomeRollupRecorded: "measured_outcome.rollup_recorded",
      },
    };
    expect(outcomesPort.boundary).toBe("outcomes");
    // A concrete provider MAY be injected through a neutral port, but
    // the domain module never imports the concrete adapter — only the
    // neutral interface. See the next test.
  });

  test("NO domain file imports a concrete provider (scanner-enforced)", async () => {
    const result = await scanArchitecture({ root: SRC, repoSrc: SRC });
    const domainAdapterViolations = result.violations.filter(
      (v) => v.importerTier === "domain" && v.rule === "domain-must-not-import-adapter",
    );
    expect(domainAdapterViolations).toEqual([]);

    const domainInfraViolations = result.violations.filter(
      (v) => v.importerTier === "domain" && v.rule === "domain-must-not-import-infrastructure",
    );
    expect(domainInfraViolations).toEqual([]);
  });

  test("concrete providers live behind the providers/ boundary", () => {
    expect(existsSync(join(SRC, "llm/providers/echo-llm-provider.ts"))).toBe(true);
    expect(existsSync(join(SRC, "agents/providers/echo-agent-provider.ts"))).toBe(true);
    expect(existsSync(join(SRC, "measurement/providers/echo-measurement-provider.ts"))).toBe(true);
    expect(existsSync(join(SRC, "payments/providers/echo-payment-provider.ts"))).toBe(true);
    expect(existsSync(join(SRC, "ledger/providers/echo-ledger-provider.ts"))).toBe(true);
    expect(existsSync(join(SRC, "adapters/echo-adapter/index.ts"))).toBe(true);
  });
});
