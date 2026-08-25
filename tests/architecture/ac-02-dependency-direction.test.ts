/**
 * NET-W001-AC-02 — Dependency direction.
 *
 * Evidence: intentionally failing fixture + passing normal suite.
 *
 * Architecture tests fail when a domain module imports a concrete
 * provider/infrastructure implementation outside its allowed boundary.
 * This test runs the deterministic import scanner (scripts/lib)
 * against:
 *   (a) the real `src/` tree — MUST report zero violations (passing
 *       normal suite);
 *   (b) the intentional fixture under
 *       tests/architecture/fixtures/violation/src — MUST report ≥1
 *       violation (intentionally failing fixture).
 */

import { describe, test, expect } from "bun:test";
import { join } from "node:path";
import {
  scanArchitecture,
  formatViolations,
  type Violation,
} from "../../scripts/lib/architecture.ts";

const REPO = join(import.meta.dir, "../..");
const SRC = join(REPO, "src");
const FIXTURE = join(REPO, "tests/architecture/fixtures/violation/src");

describe("NET-W001-AC-02 dependency direction", () => {
  test("real src/ tree is clean (passing normal suite)", async () => {
    const result = await scanArchitecture({ root: SRC, repoSrc: SRC });
    if (result.violations.length > 0) {
      // Print so the assertion message is actionable in CI logs.
      console.error(formatViolations(result));
    }
    expect(result.filesScanned).toBeGreaterThan(0);
    expect(result.violations).toEqual([] as readonly Violation[]);
  });

  test("intentional fixture is flagged (intentionally failing fixture)", async () => {
    const result = await scanArchitecture({ root: FIXTURE, repoSrc: SRC });
    expect(result.filesScanned).toBeGreaterThan(0);
    expect(result.violations.length).toBeGreaterThanOrEqual(1);

    // Specifically assert the three representative violations exist.
    const rules = result.violations.map((v) => v.rule);
    expect(rules).toContain("domain-must-not-import-infrastructure");
    expect(rules).toContain("domain-must-not-import-adapter");
    expect(rules).toContain("domain-must-not-import-other-domain");
  });

  test("scanner classifies the fixture's domain importer correctly", async () => {
    // The fixture file identity/port.ts must be classified as domain
    // (importerTier) — proving the scanner respects the scan-root
    // relative path, not the absolute tests/ location.
    const result = await scanArchitecture({ root: FIXTURE, repoSrc: SRC });
    const identityViolation = result.violations.find(
      (v) => v.file === "identity/port.ts",
    );
    expect(identityViolation).toBeDefined();
    expect(identityViolation!.importerTier).toBe("domain");
    expect(identityViolation!.importerDir).toBe("identity");
  });
});
