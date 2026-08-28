/**
 * The NET-W019 placement-eligibility derivation engine — PURE.
 *
 * Work order ref: spec/work-orders/NET-W019.md §3.3.
 *
 * The engine evaluates the campaign policy's ELIGIBILITY RULES (the
 * /campaigns-owned policy section — resolved READ-ONLY through the
 * neutral lookup) against a placement's DECLARED context attributes
 * (the territories/languages the placement offers — a narrowing of
 * the registered supply's attributes). It is the exact
 * disclosure-engine precedent: deterministic, machine-readable,
 * caller-input-free; every input is a DURABLE RECORD.
 *
 * EVALUATION SEMANTICS (deterministic + conservative — the safe
 * direction, mirroring "never under-disclose"):
 *  - set semantics: a rule is satisfied iff EVERY value the placement
 *    context offers satisfies the rule (no partial placement sneaks a
 *    disallowed value through);
 *  - `region` rules evaluate against the context territories;
 *    `language` rules against the context languages;
 *  - a rule over ANY OTHER campaign-eligibility attribute
 *    (participant_class, contribution_type, evidence_grade,
 *    measurement_kind) is NOT satisfiable by inventory supply — the
 *    supply carries no such attribute, so the honest evaluation is
 *    "not satisfied" (the placement is recorded as ineligible under
 *    that policy version — provenance, never fabrication);
 *  - `gte`/`lte` operators are NOT applicable to unordered supply
 *    attributes (region/language) — "not satisfied";
 *  - an EMPTY rule set qualifies (an open campaign).
 *
 * The result is snapshotted at placement creation (all inputs are
 * immutable after creation — the snapshot can never drift) and
 * RE-DERIVED live by the settlement-readiness view (never trusted
 * from storage).
 *
 * NO I/O, no wall clock, no persistence — pure functions only.
 */

import type {
  PlacementEligibilityEvaluation,
  PlacementEligibilityRuleResult,
} from "./port.ts";

/** The supply attributes the eligibility rules can address. */
export interface PlacementEligibilitySupply {
  readonly territories: readonly string[];
  readonly languages: readonly string[];
}

/** The rule shape the engine consumes (the neutral lookup's view). */
export interface PlacementEligibilityRuleInput {
  readonly attribute: string;
  readonly operator: string;
  readonly values: readonly string[];
}

/** The attributes inventory supply carries (region + language). */
const SUPPLY_ATTRIBUTES: ReadonlySet<string> = new Set([
  "region",
  "language",
]);

function valuesFor(
  attribute: string,
  supply: PlacementEligibilitySupply,
): readonly string[] | null {
  if (attribute === "region") return supply.territories;
  if (attribute === "language") return supply.languages;
  return null;
}

function evaluateRule(
  rule: PlacementEligibilityRuleInput,
  offered: readonly string[],
): PlacementEligibilityRuleResult {
  const base: Omit<PlacementEligibilityRuleResult, "satisfied" | "reason"> = {
    attribute: rule.attribute,
    operator: rule.operator,
    values: Object.freeze([...rule.values]),
  };
  // An empty context cannot satisfy any rule that constrains values
  // (validation normally rejects it; the engine is total anyway).
  if (offered.length === 0) {
    return { ...base, satisfied: false, reason: "empty_context" };
  }
  switch (rule.operator) {
    case "equals": {
      // The offered set IS exactly the single declared value.
      const expected = rule.values[0] ?? "";
      const satisfied =
        offered.length === 1 && offered[0] === expected;
      return {
        ...base,
        satisfied,
        reason: satisfied
          ? "satisfied"
          : "offered_value_outside_rule",
      };
    }
    case "not_equals": {
      // EVERY offered value differs from the single declared value.
      const excluded = rule.values[0] ?? "";
      const satisfied = offered.every((value) => value !== excluded);
      return {
        ...base,
        satisfied,
        reason: satisfied
          ? "satisfied"
          : "offered_value_outside_rule",
      };
    }
    case "in": {
      // EVERY offered value is in the declared value set.
      const allowed = new Set(rule.values);
      const satisfied = offered.every((value) => allowed.has(value));
      return {
        ...base,
        satisfied,
        reason: satisfied
          ? "satisfied"
          : "offered_value_outside_rule",
      };
    }
    case "not_in": {
      // NO offered value is in the declared value set.
      const excluded = new Set(rule.values);
      const satisfied = offered.every((value) => !excluded.has(value));
      return {
        ...base,
        satisfied,
        reason: satisfied
          ? "satisfied"
          : "offered_value_outside_rule",
      };
    }
    default: {
      // gte/lte (and any unknown operator): not applicable to
      // unordered supply attributes — conservatively not satisfied.
      return {
        ...base,
        satisfied: false,
        reason: "operator_not_applicable",
      };
    }
  }
}

/**
 * Evaluate the campaign policy's eligibility rules against the
 * placement's declared context attributes. Deterministic; the rule
 * order is preserved (the policy's own order) so results are
 * reproducible. A rule over an attribute the supply does not carry is
 * evaluated as NOT satisfied with the machine-readable reason
 * `attribute_not_carried_by_supply`.
 */
export function evaluatePlacementEligibility(
  rules: readonly PlacementEligibilityRuleInput[],
  supply: PlacementEligibilitySupply,
  evaluatedAt: string,
): PlacementEligibilityEvaluation {
  const ruleResults: PlacementEligibilityRuleResult[] = [];
  for (const rule of rules) {
    if (!SUPPLY_ATTRIBUTES.has(rule.attribute)) {
      ruleResults.push({
        attribute: rule.attribute,
        operator: rule.operator,
        values: Object.freeze([...rule.values]),
        satisfied: false,
        reason: "attribute_not_carried_by_supply",
      });
      continue;
    }
    const offered = valuesFor(rule.attribute, supply);
    if (offered === null) {
      // Unreachable (SUPPLY_ATTRIBUTES covers exactly these two);
      // total anyway: treat as not carried.
      ruleResults.push({
        attribute: rule.attribute,
        operator: rule.operator,
        values: Object.freeze([...rule.values]),
        satisfied: false,
        reason: "attribute_not_carried_by_supply",
      });
      continue;
    }
    ruleResults.push(evaluateRule(rule, offered));
  }
  return Object.freeze({
    eligible: ruleResults.every((result) => result.satisfied),
    ruleResults: Object.freeze(ruleResults),
    evaluatedAt,
  });
}
