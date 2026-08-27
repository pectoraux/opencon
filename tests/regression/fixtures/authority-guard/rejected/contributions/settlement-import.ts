/**
 * NEGATIVE fixture — must be REJECTED: direct authority import.
 *
 * Watchpoint 2: /contributions must not directly import the settlement
 * authority. Cross-domain facts arrive through provider-neutral lookup
 * contracts; cross-domain commands are composed at the bootstrap
 * boundary.
 *
 * Expected violation: single-authority-domain-import.
 */

import type { CreditCommandSurface } from "../settlement/port.ts";

export async function grantCompletionCredits(contributionId: string): Promise<void> {
  void contributionId;
}
