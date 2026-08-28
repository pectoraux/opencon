/**
 * The NET-W017 engagement engine — PURE deterministic functions ONLY.
 *
 * Work order ref: spec/work-orders/NET-W017.md §3.2 (auto-accept
 * evaluation with a closed gate vocabulary) and §3.3 (usage-rights
 * envelope + DERIVED effective status).
 *
 * This module performs NO I/O and NO mutation. It consumes validated
 * inputs (records + read-only lookup results assembled by the
 * service) and produces deterministic verdicts:
 *
 *  - {@link evaluateAutoAccept} — the CRE-003 auto-accept
 *    qualification: the conjunction of nine gates with a CLOSED
 *    reason vocabulary and a complete per-gate trace. Identical
 *    inputs produce identical verdicts. A non-qualifying evaluation
 *    instructs the service to mutate NOTHING.
 *  - {@link usageRightsEffectiveStatus} — the DERIVED grant status
 *    (ACTIVE/REVOKED/EXPIRED): a pure function over the immutable
 *    grant + the optional revocation record + the evaluation
 *    instant. There is NO stored status and NO local status machine
 *    anywhere in the creators boundary.
 *  - {@link assertGrantedWithinEnvelope} — the acceptance envelope
 *    check: a grant may only carry what the offer requested (uses,
 *    channels, territories, formats, duration window). Exclusions
 *    are the grantor's prerogative (they shrink the grant, never
 *    expand it) and carry no subset constraint.
 *  - {@link deriveAutoGrant} — the deterministic auto-grant: exactly
 *    the requested envelope (the gates already guarantee the
 *    requested uses are auto-grantable and the duration is within
 *    the policy bound).
 */

import {
  InvalidEngagementError,
  isCreatorRightsKind,
  validateUsageRightsChannels,
  validateUsageRightsExclusions,
  validateUsageRightsFormats,
  validateUsageRightsTerritories,
  validateUsageRightsUses,
  validateUsageRightsWindow,
  type CreatorContentFormat,
  type CreatorRightsKind,
  type UsageRightsEffectiveStatus,
} from "../core/creators.ts";
import type {
  AutoAcceptEvaluation,
  AutoAcceptGateOutcome,
  EngagementCompensationTerms,
  EngagementRequestedRights,
  CreatorAcceptancePolicyRecord,
} from "./port.ts";
import type { CreatorProfileStatus } from "../core/creators.ts";

// ---------------------------------------------------------------------------
// The requested-rights envelope (validated builder)
// ---------------------------------------------------------------------------

/**
 * Validate + normalize the RAW requested-rights input into the
 * canonical {@link EngagementRequestedRights} (closed vocabularies,
 * bounded lists, explicit window). Throws
 * {@link InvalidEngagementError} on any violation.
 */
export function buildRequestedRights(raw: {
  readonly uses: readonly { kind: string; terms?: string | null }[];
  readonly channels: readonly string[];
  readonly territories: readonly string[];
  readonly formats: readonly string[];
  readonly startsAt: string;
  readonly endsAt: string;
  readonly exclusions?: readonly string[];
}): EngagementRequestedRights {
  if (!raw || typeof raw !== "object") {
    throw new InvalidEngagementError("requestedRights is required");
  }
  const uses = validateUsageRightsUses(raw.uses);
  const channels = validateUsageRightsChannels(raw.channels);
  const territories = validateUsageRightsTerritories(raw.territories);
  const formats = validateUsageRightsFormats(raw.formats);
  const window = validateUsageRightsWindow(raw.startsAt, raw.endsAt);
  const exclusions = validateUsageRightsExclusions(raw.exclusions ?? []);
  return Object.freeze({
    uses,
    channels,
    territories,
    formats,
    startsAt: window.startsAt,
    endsAt: window.endsAt,
    exclusions,
  });
}

/** The validated grant-terms shape (the acceptance input). */
export interface GrantedRightsTerms {
  readonly uses: readonly { kind: CreatorRightsKind; terms: string | null }[];
  readonly channels: ReturnType<typeof validateUsageRightsChannels>;
  readonly territories: readonly string[];
  readonly formats: readonly CreatorContentFormat[];
  readonly startsAt: string;
  readonly endsAt: string;
  readonly exclusions: readonly string[];
}

/**
 * Validate + normalize the RAW granted-rights input (same rules as
 * the requested envelope).
 */
export function buildGrantedRights(raw: {
  readonly uses: readonly { kind: string; terms?: string | null }[];
  readonly channels: readonly string[];
  readonly territories: readonly string[];
  readonly formats: readonly string[];
  readonly startsAt: string;
  readonly endsAt: string;
  readonly exclusions?: readonly string[];
}): GrantedRightsTerms {
  const requested = buildRequestedRights(raw);
  return requested;
}

// ---------------------------------------------------------------------------
// The acceptance envelope check (work order §3.3)
// ---------------------------------------------------------------------------

function subsetViolation(
  dimension: string,
  extra: readonly string[],
): InvalidEngagementError {
  return new InvalidEngagementError(
    `granted rights exceed the requested envelope on ${dimension}: ${extra.join(", ")}`,
    { dimension, extra },
  );
}

/**
 * Assert the granted rights sit WITHIN the requested envelope:
 *  - every granted use kind was requested;
 *  - every granted channel was requested;
 *  - every granted territory was requested;
 *  - every granted format was requested;
 *  - the granted window sits within the requested window.
 * Exclusions carry NO subset constraint (the grantor's own
 * exclusions only shrink the grant).
 */
export function assertGrantedWithinEnvelope(
  requested: EngagementRequestedRights,
  granted: GrantedRightsTerms,
): void {
  const requestedKinds = new Set(requested.uses.map((u) => u.kind));
  for (const use of granted.uses) {
    if (!requestedKinds.has(use.kind)) {
      throw subsetViolation("uses", [use.kind]);
    }
  }
  const requestedChannels = new Set(requested.channels);
  for (const channel of granted.channels) {
    if (!requestedChannels.has(channel)) {
      throw subsetViolation("channels", [channel]);
    }
  }
  const requestedTerritories = new Set(requested.territories);
  for (const territory of granted.territories) {
    if (!requestedTerritories.has(territory)) {
      throw subsetViolation("territories", [territory]);
    }
  }
  const requestedFormats = new Set(requested.formats);
  for (const format of granted.formats) {
    if (!requestedFormats.has(format)) {
      throw subsetViolation("formats", [format]);
    }
  }
  const rStart = Date.parse(requested.startsAt);
  const rEnd = Date.parse(requested.endsAt);
  const gStart = Date.parse(granted.startsAt);
  const gEnd = Date.parse(granted.endsAt);
  if (gStart < rStart || gEnd > rEnd) {
    throw subsetViolation("duration", [
      `${granted.startsAt}..${granted.endsAt}`,
    ]);
  }
}

/**
 * The deterministic auto-grant: EXACTLY the requested envelope. The
 * auto-accept gates guarantee the requested uses are auto-grantable
 * and the requested duration is within the policy bound — so the
 * grant equals the request (no narrowing, no expansion).
 */
export function deriveAutoGrant(
  requested: EngagementRequestedRights,
): GrantedRightsTerms {
  return {
    uses: requested.uses.map((u) => ({ kind: u.kind, terms: u.terms })),
    channels: requested.channels,
    territories: requested.territories,
    formats: requested.formats,
    startsAt: requested.startsAt,
    endsAt: requested.endsAt,
    exclusions: requested.exclusions,
  };
}

// ---------------------------------------------------------------------------
// The derived usage-rights effective status (work order §3.3)
// ---------------------------------------------------------------------------

/**
 * The DERIVED effective status of a usage-rights grant at `asOf`:
 *  - REVOKED when a revocation exists and asOf ≥ its effectiveAt;
 *  - EXPIRED when asOf > the grant's endsAt;
 *  - ACTIVE otherwise.
 * Pure over immutable records — there is no stored status field and
 * no local status machine.
 */
export function usageRightsEffectiveStatus(
  grant: { readonly endsAt: string },
  revocation: { readonly effectiveAt: string } | null,
  asOf: string,
): UsageRightsEffectiveStatus {
  const at = Date.parse(asOf);
  if (Number.isNaN(at)) {
    throw new InvalidEngagementError(
      `asOf must be an ISO-8601 instant (got ${String(asOf)})`,
      { asOf },
    );
  }
  if (revocation && at >= Date.parse(revocation.effectiveAt)) {
    return "REVOKED";
  }
  if (at > Date.parse(grant.endsAt)) {
    return "EXPIRED";
  }
  return "ACTIVE";
}

// ---------------------------------------------------------------------------
// The deterministic auto-accept evaluation (work order §3.2)
// ---------------------------------------------------------------------------

/** The validated inputs the evaluation consumes (assembled by the service). */
export interface AutoAcceptEvaluationInput {
  /** The effective acceptance policy (null = none recorded). */
  readonly policy: CreatorAcceptancePolicyRecord | null;
  /** The creator profile's administrative status (null = no profile). */
  readonly profileStatus: CreatorProfileStatus | null;
  /**
   * The pinned profile version's availability.acceptingWork
   * (null = no versioned sections — cannot confirm, fail-closed).
   */
  readonly acceptingWork: boolean | null;
  /** The creator's current NON-TERMINAL engagement count in the org. */
  readonly openEngagementCount: number;
  /** The offer's requested usage kinds. */
  readonly requestedUses: readonly CreatorRightsKind[];
  /** The offer's requested grant duration in days (ceil). */
  readonly requestedGrantDurationDays: number;
  /** The offer's declared compensation (null = uncompensated). */
  readonly compensation: EngagementCompensationTerms | null;
  /** The safety read: an active participant_eligibility control. */
  readonly safetyHeld: boolean;
}

function gate(
  reason: AutoAcceptGateOutcome["reason"],
  passed: boolean,
  detail: Readonly<Record<string, unknown>> | null,
): AutoAcceptGateOutcome {
  return { reason, passed, detail };
}

/**
 * The CRE-003 auto-accept qualification: the conjunction of nine
 * gates, evaluated WITHOUT short-circuit so the trace is complete.
 * Identical inputs produce identical verdicts + traces.
 */
export function evaluateAutoAccept(
  input: AutoAcceptEvaluationInput,
): AutoAcceptEvaluation {
  const gates: AutoAcceptGateOutcome[] = [];

  // Gate 1: an acceptance policy exists.
  gates.push(
    gate("policy_not_found", input.policy !== null, {
      hasPolicy: input.policy !== null,
    }),
  );

  // Gate 2: the effective policy is auto_accept mode.
  const mode = input.policy?.mode ?? null;
  gates.push(
    gate("policy_not_auto_accept", mode === "auto_accept", { mode }),
  );

  // Gate 3: the creator profile is ACTIVE.
  gates.push(
    gate("profile_not_active", input.profileStatus === "ACTIVE", {
      profileStatus: input.profileStatus,
    }),
  );

  // Gate 4: the profile declares accepting work (fail-closed when
  // unknown — no versioned availability to confirm).
  gates.push(
    gate("not_accepting_work", input.acceptingWork === true, {
      acceptingWork: input.acceptingWork,
    }),
  );

  // Gate 5: the open-engagement count is below the policy cap.
  const maxActive = input.policy?.maxActiveEngagements ?? 0;
  gates.push(
    gate(
      "too_many_active_engagements",
      input.openEngagementCount < maxActive,
      { openEngagementCount: input.openEngagementCount, maxActive },
    ),
  );

  // Gate 6: the offer compensation meets the declared rate floor.
  //  - no floor declared → pass;
  //  - floor declared + uncompensated offer → FAIL;
  //  - floor declared + compensating a DIFFERENT format/unit/
  //    currency → the floor does not apply → pass;
  //  - matched floor → pass iff amount ≥ floor.
  const floor = input.policy?.rateFloor ?? null;
  let ratePassed = true;
  if (floor !== null) {
    if (input.compensation === null) {
      ratePassed = false;
    } else if (
      input.compensation.format === floor.format &&
      input.compensation.unit === floor.unit &&
      input.compensation.currency === floor.currency
    ) {
      ratePassed = input.compensation.amount >= floor.amount;
    }
  }
  gates.push(
    gate("rate_below_floor", ratePassed, {
      floor,
      compensation: input.compensation,
    }),
  );

  // Gate 7: every requested usage kind is auto-grantable.
  const autoGrantable = new Set(input.policy?.autoGrantableRights ?? []);
  const notGrantable = input.requestedUses.filter(
    (kind) => !autoGrantable.has(kind),
  );
  gates.push(
    gate("rights_not_auto_grantable", notGrantable.length === 0, {
      requestedUses: input.requestedUses,
      autoGrantableRights: input.policy?.autoGrantableRights ?? [],
      notGrantable,
    }),
  );

  // Gate 8: the requested grant duration is within the policy bound.
  const maxDuration = input.policy?.maxGrantDurationDays ?? null;
  gates.push(
    gate(
      "grant_duration_exceeds_policy",
      maxDuration === null || input.requestedGrantDurationDays <= maxDuration,
      { requestedGrantDurationDays: input.requestedGrantDurationDays, maxDuration },
    ),
  );

  // Gate 9: no active risk control on the creator person.
  gates.push(
    gate("active_risk_control", !input.safetyHeld, {
      safetyHeld: input.safetyHeld,
    }),
  );

  const qualifies = gates.every((g) => g.passed);
  return {
    qualifies,
    mode: input.policy?.mode ?? "manual",
    policyVersion: input.policy?.version ?? null,
    gates,
  };
}

/** The requested grant duration in days (ceil of the window span). */
export function grantDurationDays(
  startsAt: string,
  endsAt: string,
): number {
  const span = Date.parse(endsAt) - Date.parse(startsAt);
  if (span <= 0) {
    throw new InvalidEngagementError(
      "grant duration requires endsAt > startsAt",
      { startsAt, endsAt },
    );
  }
  return Math.ceil(span / 86_400_000);
}

/** Filter the requested uses to the valid rights kinds (defensive). */
export function requestedUseKinds(
  requested: EngagementRequestedRights,
): readonly CreatorRightsKind[] {
  return requested.uses
    .map((u) => u.kind)
    .filter((kind): kind is CreatorRightsKind => isCreatorRightsKind(kind));
}
