/**
 * The NET-W018 disclosure derivation engine — PURE functions over
 * immutable records (the engagement-engine precedent).
 *
 * Work order ref: spec/work-orders/NET-W018.md §3.3.
 *
 * THE DERIVATION (invariant 2 — "Required disclosures are derived
 * from explicit campaign/engagement policy and cannot be bypassed by
 * caller claims"):
 *
 *   required = campaignPolicy.requiredKinds ∪ relationship.obligations
 *   satisfied(kind) = ∃ declaration(publication, kind)
 *
 * Every input is a DURABLE RECORD (the versioned campaign policy
 * resolved read-only through the neutral lookup; the commercial
 * relationship; the append-only declarations). No caller-asserted
 * fact participates in the derivation — there is structurally no
 * input by which a creator or caller can mark a disclosure
 * satisfied (AC-04). The functions here are deterministic: the
 * obligation set is ordered by the frozen
 * CAMPAIGN_DISCLOSURE_KINDS vocabulary order; satisfaction order is
 * the declarations' deterministic (createdAt, id) order.
 *
 * No AI path, no economic mutation, no lifecycle mutation — this
 * file contains ONLY pure data derivation.
 */

import { CAMPAIGN_DISCLOSURE_KINDS } from "../core/campaigns.ts";
import type { CampaignDisclosureKind } from "../core/campaigns.ts";
import type {
  CommercialRelationship,
  DisclosureDeclaration,
  DisclosureObligationStatus,
  DisclosureRequirementSource,
  PublicationDisclosureStatus,
} from "./port.ts";

/** The frozen vocabulary rank of a disclosure kind (deterministic order). */
function disclosureKindRank(kind: CampaignDisclosureKind): number {
  return (CAMPAIGN_DISCLOSURE_KINDS as readonly string[]).indexOf(kind);
}

/**
 * Derive the required disclosure kinds for a publication: the UNION of
 * the resolved campaign policy's declared requiredKinds and the
 * commercial relationship's declared obligations (the relationship can
 * only ADD obligations — never remove the campaign's). Deterministic
 * order: the frozen vocabulary order. Pure.
 */
export function deriveRequiredDisclosures(
  policyRequiredKinds: readonly CampaignDisclosureKind[],
  relationshipObligations: readonly CampaignDisclosureKind[] | null,
): readonly CampaignDisclosureKind[] {
  const required = new Set<CampaignDisclosureKind>([
    ...policyRequiredKinds,
    ...(relationshipObligations ?? []),
  ]);
  return Object.freeze(
    [...required].sort((a, b) => disclosureKindRank(a) - disclosureKindRank(b)),
  );
}

/**
 * Evaluate the disclosure obligations of one publication: for every
 * required kind (in frozen vocabulary order) the provenance sources
 * (campaign policy version and/or relationship id) and the satisfying
 * declarations (deterministic (createdAt, id) order). A kind with no
 * satisfying declaration is unsatisfied. Pure.
 */
export function evaluateDisclosureObligations(input: {
  readonly requiredKinds: readonly CampaignDisclosureKind[];
  readonly policyVersion: number | null;
  readonly relationship: CommercialRelationship | null;
  readonly declarations: readonly DisclosureDeclaration[];
}): readonly DisclosureObligationStatus[] {
  const byKind = new Map<string, DisclosureDeclaration[]>();
  for (const declaration of input.declarations) {
    const list = byKind.get(declaration.kind) ?? [];
    list.push(declaration);
    byKind.set(declaration.kind, list);
  }
  // Deterministic declaration order per kind.
  for (const list of byKind.values()) {
    list.sort((a, b) =>
      a.createdAt === b.createdAt ? (a.id < b.id ? -1 : 1) : a.createdAt < b.createdAt ? -1 : 1,
    );
  }

  const obligations: DisclosureObligationStatus[] = [];
  for (const kind of input.requiredKinds) {
    const sources: DisclosureRequirementSource[] = [];
    if (input.policyVersion !== null || input.relationship === null) {
      // The campaign policy source is always present when a policy
      // version resolved (even an EMPTY one — the declared stance);
      // when no relationship exists it is the sole source.
      sources.push({
        source: "campaign_policy",
        policyVersion: input.policyVersion,
        relationshipId: null,
      });
    }
    if (
      input.relationship !== null &&
      input.relationship.disclosureObligations.includes(kind)
    ) {
      sources.push({
        source: "commercial_relationship",
        policyVersion: null,
        relationshipId: input.relationship.id,
      });
    }
    const satisfying = byKind.get(kind) ?? [];
    obligations.push({
      kind,
      sources: Object.freeze(sources),
      satisfied: satisfying.length > 0,
      declarationIds: Object.freeze(satisfying.map((d) => d.id)),
    });
  }
  return Object.freeze(obligations);
}

/**
 * Build the derived publication disclosure status (the read-only
 * view; AC-02). Pure — `evaluatedAt` is supplied by the caller so the
 * function itself stays deterministic.
 */
export function buildPublicationDisclosureStatus(input: {
  readonly publicationId: string;
  readonly organizationScopeId: string;
  readonly state: string;
  readonly obligations: readonly DisclosureObligationStatus[];
  readonly evaluatedAt: string;
}): PublicationDisclosureStatus {
  const obligations = [...input.obligations];
  return Object.freeze({
    publicationId: input.publicationId,
    organizationScopeId: input.organizationScopeId,
    state: input.state as PublicationDisclosureStatus["state"],
    obligations: Object.freeze(obligations),
    satisfied: obligations.every((o) => o.satisfied),
    evaluatedAt: input.evaluatedAt,
  });
}
