/**
 * Architecture check CLI.
 *
 * Reproducible command: `bun run arch:check`.
 * Exits 0 when clean, 1 on any violation. Prints human-readable output
 * (use --json for machine-readable).
 */

import { scanArchitecture, formatViolations } from "./lib/architecture.ts";

const args = process.argv.slice(2);
const wantJson = args.includes("--json");
const rootArg = args.find((a) => a.startsWith("--root="))?.slice("--root=".length);

const result = await scanArchitecture(
  rootArg ? { root: rootArg } : {},
);

if (wantJson) {
  process.stdout.write(JSON.stringify(result, null, 2) + "\n");
} else {
  process.stdout.write(formatViolations(result) + "\n");
}

if (result.violations.length > 0) {
  process.exit(1);
}
