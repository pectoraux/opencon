import { describe, expect, test } from "bun:test";
import {
  ADMINISTRATIVE_STATUS_DOMAINS,
  scanAuthorityBoundaries,
} from "../../scripts/check-authority-boundaries.ts";

/**
 * Architectural regression guardrails for the three intentional yellow areas:
 *
 * - /disputes stays the single fraud/risk control authority.
 * - /contributions may own quality/moderation semantics but cannot mutate risk,
 *   economic, reputation, or workflow authority directly.
 * - operational lifecycle stays in /workflows; domain-local administrative
 *   status is an explicit, reviewed exception rather than a default pattern.
 */
describe("authority-boundary guardrails", () => {
  test("current source satisfies all authority-boundary rules", async () => {
    const result = await scanAuthorityBoundaries();
    expect(result.violations).toEqual([]);
    expect(result.filesScanned).toBeGreaterThan(0);
  });

  test("only explicitly approved administrative-status domains are allowlisted", () => {
    expect([...ADMINISTRATIVE_STATUS_DOMAINS].sort()).toEqual(["creators"]);
  });
});
