/**
 * Observation correction-chain helpers (NET-W006 §3.1).
 *
 * Outcome observations are IMMUTABLE; corrections are new records
 * pointing at the record they correct (append-corrected). These pure
 * helpers walk correction chains over an OutcomeObservationRepository:
 *
 *  - corrections must target the CHAIN HEAD (branching is rejected at
 *    write time; the walkers fail closed if drift ever produces a
 *    branch);
 *  - `resolveChain` returns the full root → head lineage;
 *  - `resolveHead` returns the effective (most recent) record for a
 *    chain — the value the deterministic rollup consumes.
 *
 * Tier compliance: outcomes domain → self + core contracts only.
 */

import { NotFoundError, OpenConError } from "../core/errors.ts";
import type {
  ObservationChain,
  OutcomeObservation,
  OutcomeObservationRepository,
} from "./port.ts";

/**
 * Walk from an observation UPSTREAM to the root of its correction
 * chain. Returns the records in root → requested order (the requested
 * record is the LAST element). Throws NotFoundError when the chain is
 * broken (a correctsObservationId references a missing record).
 */
export async function walkChainToRoot(
  repo: OutcomeObservationRepository,
  id: string,
): Promise<readonly OutcomeObservation[]> {
  const requested = await repo.findById(id);
  if (!requested) {
    throw new NotFoundError(`outcome observation not found: ${id}`, {
      observationId: id,
    });
  }
  const chain: OutcomeObservation[] = [requested];
  let current = requested;
  while (current.correctsObservationId !== null) {
    const previous = await repo.findById(current.correctsObservationId);
    if (!previous) {
      throw new NotFoundError(
        `correction chain broken: observation ${current.correctsObservationId} not found`,
        { observationId: current.correctsObservationId },
      );
    }
    chain.unshift(previous);
    current = previous;
  }
  return chain;
}

/**
 * Walk DOWNSTREAM from an observation to the HEAD of its correction
 * chain (the most recent correction — the effective measurement). At
 * most one correction may exist per record (branching is rejected at
 * write time); a branch (data drift) fails closed here.
 */
export async function walkToHead(
  repo: OutcomeObservationRepository,
  record: OutcomeObservation,
): Promise<OutcomeObservation> {
  let node = record;
  for (;;) {
    const correctionsOf = await repo.findByCorrectionOf(node.id);
    if (correctionsOf.length === 0) return node;
    if (correctionsOf.length > 1) {
      throw new OpenConError({
        code: "MEASUREMENT_VALIDATION",
        classification: "validation",
        message: `correction chain branch detected for observation ${node.id} (${correctionsOf.length} corrections) — the chain is ambiguous`,
        context: { observationId: node.id, correctionIds: correctionsOf.map((c) => c.id) },
      });
    }
    node = correctionsOf[0]!;
  }
}

/**
 * Resolve the full correction chain of an observation: the root, the
 * corrections in root → head order (empty when uncorrected), and the
 * head (the effective current measurement).
 */
export async function resolveChain(
  repo: OutcomeObservationRepository,
  id: string,
): Promise<ObservationChain> {
  const upstream = await walkChainToRoot(repo, id);
  const requested = upstream[upstream.length - 1]!;
  const downstream: OutcomeObservation[] = [];
  let node = requested;
  for (;;) {
    const correctionsOf = await repo.findByCorrectionOf(node.id);
    if (correctionsOf.length === 0) break;
    if (correctionsOf.length > 1) {
      throw new OpenConError({
        code: "MEASUREMENT_VALIDATION",
        classification: "validation",
        message: `correction chain branch detected for observation ${node.id} (${correctionsOf.length} corrections) — the chain is ambiguous`,
        context: { observationId: node.id, correctionIds: correctionsOf.map((c) => c.id) },
      });
    }
    node = correctionsOf[0]!;
    downstream.push(node);
  }
  const chain = [...upstream, ...downstream];
  const root = chain[0]!;
  const head = chain[chain.length - 1]!;
  return Object.freeze({
    root,
    corrections: chain.slice(1),
    head,
  });
}

/**
 * Resolve the HEAD (effective current measurement) of an observation's
 * correction chain. This is what the deterministic rollup consumes
 * (work order §3.6: only chain-head observations count).
 */
export async function resolveHead(
  repo: OutcomeObservationRepository,
  id: string,
): Promise<OutcomeObservation> {
  const upstream = await walkChainToRoot(repo, id);
  const requested = upstream[upstream.length - 1]!;
  return walkToHead(repo, requested);
}
