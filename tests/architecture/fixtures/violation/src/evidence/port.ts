/**
 * INTENTIONAL ARCHITECTURE VIOLATION FIXTURE — DO NOT FIX.
 *
 * Cross-domain dependency: evidence (domain) imports another domain's
 * internals. The scanner must flag domain→other-domain.
 */

import type { OpportunitiesPort } from "../opportunities/port.ts";

export interface EvidencePort {
  readonly boundary: "evidence";
  readonly opportunities?: OpportunitiesPort;
}
