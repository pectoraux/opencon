/**
 * Shared source-reference validation for the disputes domain
 * (NET-W009 §3.2/§3.6/§3.7).
 *
 * Every evidence-backed construct in this domain (risk signals, case
 * decisions, control activations) validates its authoritative source
 * references through the SAME neutral-lookup resolution: existence +
 * organization-scope match (tenant isolation, invariant 6). A bare
 * assertion cannot enter the system (invariant 3).
 *
 * Tier compliance: disputes domain → self + core contracts only.
 */

import { OpenConError } from "../core/errors.ts";
import { isRiskSignalSourceKind } from "../core/risk.ts";
import type {
  RiskLookups,
  RiskSignalSourceRef,
  RiskSubjectRef,
} from "./port.ts";

/** The subject-ref vocabulary (records a risk construct can be about). */
const SUBJECT_REF_TYPES = [
  "contribution",
  "proof_of_value",
  "measured_outcome",
  "economic_value",
  "credit_issuance",
  "cash_obligation",
] as const;

export function parseSubjectRef(
  raw: RiskSubjectRef | undefined,
): RiskSubjectRef | null {
  if (raw === undefined) return null;
  if (
    !raw ||
    typeof raw !== "object" ||
    !SUBJECT_REF_TYPES.includes(
      raw.subjectType as (typeof SUBJECT_REF_TYPES)[number],
    ) ||
    typeof raw.subjectId !== "string" ||
    !raw.subjectId.trim()
  ) {
    throw new OpenConError({
      code: "RISK_SIGNAL_VALIDATION",
      classification: "validation",
      message: `subjectRef.subjectType must be one of ${SUBJECT_REF_TYPES.join(", ")} with a non-empty subjectId`,
      context: { subjectRef: raw },
    });
  }
  return { subjectType: raw.subjectType, subjectId: raw.subjectId };
}

/**
 * Resolve + validate authoritative source refs through the NEUTRAL
 * lookups (existence + organization scope). Returns the normalized
 * refs. Sources that do not resolve — or resolve in ANOTHER
 * organization scope — are rejected.
 */
export async function resolveSources(
  lookups: RiskLookups,
  organizationScopeId: string,
  rawSources: readonly { kind: string; id: string }[],
  options: { readonly emptyAllowed?: boolean } = {},
): Promise<readonly RiskSignalSourceRef[]> {
  if (!Array.isArray(rawSources) || rawSources.length === 0) {
    if (options.emptyAllowed) return [];
    throw new OpenConError({
      code: "RISK_SIGNAL_VALIDATION",
      classification: "validation",
      message:
        "at least one authoritative source reference is required (evidence-backed material decisions)",
      context: { sourceCount: Array.isArray(rawSources) ? rawSources.length : 0 },
    });
  }
  const resolved: RiskSignalSourceRef[] = [];
  for (const src of rawSources) {
    if (!isRiskSignalSourceKind(src.kind)) {
      throw new OpenConError({
        code: "RISK_SIGNAL_VALIDATION",
        classification: "validation",
        message: `source kind must be one of the authoritative source kinds (got ${String(src.kind)})`,
        context: { kind: src.kind },
      });
    }
    if (typeof src.id !== "string" || !src.id.trim()) {
      throw new OpenConError({
        code: "RISK_SIGNAL_VALIDATION",
        classification: "validation",
        message: "source id must be a non-empty string",
        context: { kind: src.kind, id: src.id },
      });
    }
    const kind = src.kind;
    const scope = await (async () => {
      switch (kind) {
        case "evidence":
          return (
            (await lookups.evidence.resolve(src.id))?.organizationScopeId ?? null
          );
        case "proof_of_value":
          return (
            (await lookups.proofOfValue.resolve(src.id))?.organizationScopeId ??
            null
          );
        case "measured_outcome":
          return (
            (await lookups.measuredOutcome.resolve(src.id))
              ?.organizationScopeId ?? null
          );
        case "contribution":
          return (
            (await lookups.contribution.resolve(src.id))
              ?.organizationScopeId ?? null
          );
        case "economic_value":
          return (
            (await lookups.economic.resolveValue(src.id))
              ?.organizationScopeId ?? null
          );
        case "credit_issuance":
          return (
            (await lookups.economic.resolveCreditIssuance(src.id))
              ?.organizationScopeId ?? null
          );
        case "cash_obligation":
          return (
            (await lookups.economic.resolveCashObligation(src.id))
              ?.organizationScopeId ?? null
          );
        case "reputation_snapshot":
          return (
            (await lookups.reputation.resolveById(src.id))
              ?.organizationScopeId ?? null
          );
        case "risk_signal":
          return (
            (await lookups.risk.resolveSignal(src.id))?.organizationScopeId ??
            null
          );
        case "risk_assessment":
          return (
            (await lookups.risk.resolveAssessment(src.id))
              ?.organizationScopeId ?? null
          );
        // NET-W010: a risk CASE is an authoritative prior decision —
        // citable as a supporting reference by challenge/dispute
        // records (and by risk case/control decisions).
        case "risk_case":
          return (
            (await lookups.risk.resolveCase(src.id))?.organizationScopeId ??
            null
          );
        default:
          return null;
      }
    })();
    if (scope === null) {
      throw new OpenConError({
        code: "RISK_SIGNAL_VALIDATION",
        classification: "validation",
        message: `source ${kind}:${src.id} does not resolve to an authoritative record`,
        context: { kind, id: src.id },
      });
    }
    if (scope !== organizationScopeId) {
      throw new OpenConError({
        code: "RISK_SIGNAL_VALIDATION",
        classification: "validation",
        message: `source ${kind}:${src.id} belongs to organization scope ${scope}, not ${organizationScopeId}`,
        context: {
          kind,
          id: src.id,
          sourceScope: scope,
          requestedScope: organizationScopeId,
        },
      });
    }
    resolved.push({ kind, id: src.id });
  }
  return resolved;
}
