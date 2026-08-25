/**
 * INTENTIONAL ARCHITECTURE VIOLATION FIXTURE — DO NOT FIX.
 *
 * AC-07 evidence: a domain module must depend on the provider-neutral
 * adapter interface, NOT a concrete provider. This file deliberately
 * imports a concrete adapter → the scanner must flag it.
 */

import { echoLlmProvider } from "../llm/providers/echo-llm-provider.ts";

export interface OutcomesPort {
  readonly boundary: "outcomes";
  readonly llm?: unknown;
}

export const outcomesFixture: OutcomesPort = {
  boundary: "outcomes",
  llm: echoLlmProvider,
};
