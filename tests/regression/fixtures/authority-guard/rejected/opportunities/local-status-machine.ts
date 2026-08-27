/**
 * NEGATIVE fixture — must be REJECTED: un-allowlisted local status machine.
 *
 * A NEW domain-local administrative status machine (here: /opportunities,
 * which has no approved precedent) is exactly the pattern the
 * administrative-status allowlist exists to police: domain-local status
 * is an architectural decision requiring explicit review, not a default.
 *
 * Expected violation: administrative-status-requires-allowlist.
 */

export interface LocalStatusInput {
  readonly opportunityId: string;
  readonly to: "ready" | "closed";
}

export async function statusTransition(input: LocalStatusInput): Promise<void> {
  void input;
}
