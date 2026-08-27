/**
 * POSITIVE fixture — approved pattern: the shared vocabulary layer.
 *
 * Mirrors src/core/workflow.ts: /core declares the shared workflow
 * CONTRACTS (`TransitionRequest`, `TransitionResult`,
 * `policyActionFor`) that every domain may reference. A type contract
 * is vocabulary, not mutation behavior.
 *
 * The authority guard never scans /core for authority rules (it is not
 * a domain implementation); referencing these names anywhere must
 * never be a violation. The authority guard must report ZERO
 * violations for this file.
 */

export interface TransitionRequest {
  readonly subjectKind: string;
  readonly subjectId: string;
  readonly from: string;
  readonly to: string;
}

export interface TransitionResult {
  readonly ok: boolean;
  readonly from: string;
  readonly to: string;
}

export function policyActionFor(subjectKind: string, from: string, to: string): string {
  return `${subjectKind}.transition.${from}_to_${to}`;
}
