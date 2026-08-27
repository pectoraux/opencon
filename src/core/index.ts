/**
 * OpenCon core contracts barrel.
 *
 * This is the canonical, documented public interface surface (NET-W001 §6).
 * All modules — domain, infrastructure and adapter — import contracts from
 * `@opencon/core` (i.e. this file). Importing a concrete implementation
 * from another tier is an architecture violation enforced by
 * scripts/check-architecture.ts (AC-02, AC-07).
 *
 * See docs/module-conventions.md for the full convention document.
 */

export * from "./errors.ts";
export * from "./execution-context.ts";
export * from "./logger.ts";
export * from "./config.ts";
export * from "./module.ts";
export * from "./queue.ts";
export * from "./audit.ts";
export * from "./object-store.ts";
export * from "./secrets.ts";
export * from "./adapter.ts";
export * from "./domain-module.ts";
// NET-W003 provider-neutral contracts (persistence/coordination/
// idempotency/observability). Infrastructure tier implements these;
// domain tier consumes via infrastructure, never a concrete driver.
export * from "./postgres-authority.ts";
export * from "./coordination.ts";
export * from "./idempotency.ts";
export * from "./trace.ts";
// NET-W004 shared lifecycle vocabulary (canonical + exceptional states,
// LifecycleSubject, TransitionRequest/Result, IllegalTransitionError,
// ConcurrentTransitionError). Domain tiers import this to declare their
// lifecycle subject shape; the transition table + state machine live in
// the workflows boundary (the SOLE lifecycle authority).
export * from "./workflow.ts";
// NET-W005 shared evidence vocabulary (standard outcome types OUT-001,
// evidence source types + grades, confidence estimates with uncertainty
// EVID-005, provenance records EVID-002, cryptographic commitments
// EVID-006). The /evidence domain implements the behaviour; later work
// items (/outcomes, /reputation, /settlement) consume the vocabulary.
export * from "./evidence.ts";
// NET-W006 shared measurement vocabulary (attribution modes OUT-002,
// measurement provenance with REQUIRED method/version, maturation
// strategies OUT-005, rollup strategies, experiment statuses OUT-003,
// baseline kinds OUT-004, causal statuses). The /outcomes domain
// implements the behaviour; the neutral /measurement port and later
// work items (/reputation, /settlement, NET-W022 providers) consume
// the vocabulary.
export * from "./measurement.ts";
// NET-W007 shared reputation vocabulary (the frozen dimension set
// REP-001, input source kinds, derived verified/indicated bases, and
// the deterministic per-dimension scoring-rule parameters REP-003).
// The /reputation domain implements the behaviour; later work items
// (fraud signals NET-W009, creator reputation NET-W015, portable
// proofs NET-W031) consume the vocabulary.
export * from "./reputation.ts";
// NET-W008 shared economic vocabulary (the frozen unit types ECON-004,
// qualifying verified value source kinds, value states with explicit
// maturation strategies SETTLE-002, ledger account kinds with normal
// balance sides, transaction kinds, and deterministic scaled-integer
// amount arithmetic ECON-001..003). The /settlement domain implements
// the behaviour; later work items (fraud holds NET-W009/010, campaigns
// NET-W011+, benefit pools NET-W028, external settlement NET-W030)
// consume the vocabulary.
export * from "./economics.ts";
// NET-W009 shared fraud/risk vocabulary (the frozen signal categories
// FRAUD-001/002/003, provenance kinds with the structural model-output
// advisory rule AI-003, severities, the explicit risk states with the
// normative ordering, control operation classes + actions for the
// workflow/economic gates, and deterministic policy validation with
// the fail-closed missing-data and advisory-cap invariants). The
// /disputes domain (the Phase-3 Trust boundary — see the NET-W009 work
// order §2 placement decision) implements the behaviour; later work
// items (NET-W010 challenges/disputes, NET-W013 moderation, NET-W021
// advertising fraud) consume the vocabulary.
export * from "./risk.ts";
// NET-W010 shared challenge/dispute vocabulary (kinds, states, outcomes,
// control/stake dispositions, subject types, deterministic window math
// with explicit timestamps). The /disputes domain implements the
// behaviour; /settlement consumes the stake purpose kinds.
export * from "./disputes.ts";
// NET-W011 shared campaign vocabulary (the administrative status
// machine owned by /campaigns, the closed objective-kind eligibility-
// attribute/operator/evidence-requirement/clearing vocabularies
// CAMP-001..005, pure validation against the frozen evidence/outcome/
// attribution vocabularies, and the deterministic versioned
// eligibility-policy reference). The /campaigns domain implements the
// behaviour; /settlement consumes the additive campaign_budget stake
// purpose kind; later work items (helpful contributions NET-W012,
// reward integration NET-W014, inventory NET-W019+) consume the
// references.
export * from "./campaigns.ts";

// NET-W012 (helpful contributions): the helpful-contribution
// vocabulary (helpful opportunity/contribution kinds, the
// Proof-of-Helpfulness administrative statuses, qualifying basis
// kinds and source types, advisory-score kinds with REQUIRED method
// identity, commercial-disclosure vocabularies, the
// NET-W012:1 policy format, and the PURE fail-closed
// campaign-eligibility evaluator — the first consumer of the NET-W011
// eligibility-policy reference). The /contributions domain implements
// the behaviour; NET-W013 (moderation) and NET-W014 (reward
// integration) consume the verified-usefulness claim.
export * from "./contributions.ts";

// NET-W015 (creators): the creator vocabulary (the profile status
// machine, the closed provider-neutral platform-kind/content-format/
// audience-band/rate-unit/rights-kind vocabularies, the CRE-005
// reputation reference roles, and the PURE privacy/secret guards —
// the credential-shaped and raw-audience-shaped key scans that make
// secret and raw-audience material structurally unable to enter
// creator records). The /creators domain implements the behaviour;
// later work items (creator matching NET-W016, UGC/rights NET-W017,
// sponsorship/disclosure NET-W018) consume the declared sections.
export * from "./creators.ts";
