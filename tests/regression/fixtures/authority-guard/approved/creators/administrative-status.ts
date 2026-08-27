/**
 * POSITIVE fixture — approved precedent: /creators administrative status.
 *
 * Creator-profile administration (NET-W015: DRAFT → ACTIVE ⇄ PAUSED →
 * ARCHIVED, owner-only, activation-gated) is architect-approved
 * administrative state. It is profile administration, never an
 * operational lifecycle and never another authority's mutation.
 *
 * The authority guard must report ZERO violations for this file:
 * "creators" is an explicitly approved ADMINISTRATIVE_STATUS_DOMAINS entry.
 */

export interface CreatorStatusInput {
  readonly profileId: string;
  readonly to: "active" | "paused" | "archived";
}

export async function statusTransition(input: CreatorStatusInput): Promise<void> {
  void input;
}

export async function activateProfile(input: CreatorStatusInput): Promise<void> {
  await statusTransition({ ...input, to: "active" });
}

export async function archiveProfile(input: CreatorStatusInput): Promise<void> {
  await statusTransition({ ...input, to: "archived" });
}
