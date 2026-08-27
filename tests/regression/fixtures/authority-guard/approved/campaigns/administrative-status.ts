/**
 * POSITIVE fixture — approved precedent: /campaigns administrative status.
 *
 * The campaign administrative status machine is architect-approved
 * administrative state (owner-only campaign administration under the
 * campaign record mutex; campaign clearing/reward work orders). It is
 * administrative state intrinsic to the domain — never an operational
 * lifecycle, and never workflow/risk/economic/reputation mutation.
 *
 * The authority guard must report ZERO violations for this file:
 * "campaigns" is an explicitly approved ADMINISTRATIVE_STATUS_DOMAINS entry.
 */

export interface AdministrativeStatusInput {
  readonly campaignId: string;
  readonly to: "active" | "paused" | "archived";
}

export async function statusTransition(input: AdministrativeStatusInput): Promise<void> {
  void input;
}

export async function activateCampaign(input: AdministrativeStatusInput): Promise<void> {
  await statusTransition({ ...input, to: "active" });
}

export async function pauseCampaign(input: AdministrativeStatusInput): Promise<void> {
  await statusTransition({ ...input, to: "paused" });
}
