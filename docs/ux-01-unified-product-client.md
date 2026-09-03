# UX-01 Evidence Ledger — Unified product client experience

**Status:** COMPLETE — implementation PR **#84** squash-merged `d87977c7ed14bb67f51925a3d3d09c67e76c79a1` from reviewed head `acc44c90789f0705d7b3866dc893accc9333c50a`.  
**Issue:** #83 — completed 2026-09-03 04:17Z  
**Governance PR:** #82 — squash-merged `2efe8dbd4d9146d3dea750d1f3ee87647f9dcc59`  
**Implementation PR:** #84 — architect-approved, exact-head CI green  
**Work order:** `spec/work-orders/UX-01.md` (frozen)  
**Direction of record:** the architect-approved OpenCon Unified Product UX implementation brief  

## 1. Where the implementation lives

The user-visible client runs in the product client environment (the Next.js app
served on the product port), not in this repository — this repository contains
the protocol implementation and has no production frontend surface. Per the
brief's governance section, the repository records the work item, the frozen
work order and the evidence; the implementation artifacts are:

| Artifact | Location (product client environment) |
|---|---|
| Client app (route `/`) | `src/app/page.tsx` |
| Design system | `src/components/opencon/*` (primitives, cards, lifecycle rail, evidence, detail grammar, sheets/wizard, overlays, nav, five views) |
| Client core library | `src/lib/opencon/{types,lifecycle,money,semantics}.ts` + `client.tsx` (the single fetch layer) |
| Preview product API | `mini-services/opencon-preview-api/` (port 3050; preview stand-in for the future versioned product API) |
| Interaction-path tests | `mini-services/opencon-preview-api/interaction-paths.test.ts` |
| Information architecture | `docs/opencon-ux-information-architecture.md` |
| Implementation evidence | `docs/opencon-ux-implementation-evidence.md` |

## 2. Final verification record

```text
Interaction-path tests: 23 pass / 0 fail / 125 expect() — lifecycle translation,
  money phase semantics (pending never spendable; settled campaign spend is its
  own dimension, never completed earnings), server-side guards
  (rights-before-submit, payout gating, benefit eligibility, matched
  acceptance), the creator journey end-to-end with a fake clock
  (accept → rights → disclosure → start → submit → MEASURING → EVALUATING →
  CHALLENGE_WINDOW → SETTLING → SETTLED → payout → paid, with a
  rejected double-payout), dispute respond → auto-resolve → release,
  campaign create → end → measured → settled spend, benefit claim +
  re-claim rejection, notification grouping and deep links, home
  role-scoping, cross-org search.
Architecture regression: `arch:check` + `authority:check`: 322 files / 0
  violations in the protocol repository. The product environment's `arch:check`
  reports exactly the same 7 pre-existing scaffold violations as its baseline;
  zero new. Frozen architecture files untouched; no `src/{core,domain,infra,adapter}`
  changes; no W036/W037 protocol behavior.
Browser verification: fresh session, rerun after all pre-PR remediations. All
  five destinations render with live data and navigate correctly from sidebar,
  bottom bar, cards and deep links; creator journey completed through SETTLED/
  paid; dispute response auto-resolved with value released; campaign wizard
  completed through measured/settled with spend separated in Wallet; eligible
  benefit claim succeeded ($300); ineligible benefit rejected with the server's
  human reason verbatim; global search and notification deep-links work; role
  switching adapts Home/Discover; 390px has zero horizontal overflow on every
  destination with 52px bottom-nav targets; short/long footer behavior verified;
  1280px sidebar verified; zero console/page errors in a fresh session.
```

## 3. Defects found and remediated before implementation PR

1. **Shell navigation did not re-render** — fragment destinations used `next/link`,
   whose history navigation changed the URL without firing `hashchange`. Replaced
   with same-document fragment anchors and scroll reset; all shell destinations
   now re-render correctly.
2. **Settled campaign spend polluted `Completed` earnings** — server-side preview
   semantics now keep paid earnings in `completedUsd` and expose settled campaign
   spend separately as `spendSettledUsd`; a regression test pins the invariant.
3. **3px horizontal overflow at 390px** — grid-item cards now use `min-w-0` so
   automatic minimum content width cannot inflate the grid track.
4. **Page title** — replaced the scaffold title with `OpenCon — One network, one product`.

All four were re-verified before PR #84 was opened.

## 4. Authority-separation proof points

- Action availability, transitions, value phases, eligibility and payout gates are decided by the server boundary; UI rejections surface the server's human reason verbatim.
- Pending value is never spendable; payout is offered only for matured value and duplicate payout is rejected server-side.
- Unknown and foreign-tenant object ids return identical fail-closed 404s; no existence oracle.
- The client imports no domain module; all data flows through one fetch layer using gateway-compatible URLs.

## 5. Backend capability gaps documented for follow-on product/API work

1. **Versioned product API for browser clients** — the read models required by the UX
   (home/discovery aggregation, work ladders, wallet phases, notifications, search,
   profile) are not yet served by the protocol `/api` boundary. The preview API
   supplies the contract shape with representative data and server-side guards.
2. **Browser session/auth wiring** — the preview uses one demo identity with three role
   contexts; production needs the browser session connected to the existing
   PrincipalResolver / AuthorizationService path.
3. **Provider wiring** — measurement/payment surfaces are record labels in the preview;
   production flows remain through `/measurement`, `/payments`, `/adapters`.
4. **Advisory AI copy** — recommendations are static advisory strings in the preview;
   live generation belongs behind `/llm` and remains non-authoritative.

These gaps are explicitly not implemented as client-side authority and require separately authorized API/integration work.

## 6. Governance / implementation boundary

The governance contract was established by PR #82. Issue #83 authorized exactly one
UX-01 implementation PR, #84. The product implementation itself remains external to
this protocol repository; this repository gains no frontend surface and no client
authority. Any backend capability gap must be implemented through the owning `/api` or
integration boundary. Any UX-01 remediation was required to remain on the same
implementation PR/branch.

## 7. Final decision of record

UX-01 is COMPLETE. Architect review approved PR #84 at exact head
`acc44c90789f0705d7b3866dc893accc9333c50a`; CI run `33712986041` was green for
verification and real PostgreSQL/Redis integration. PR #84 squash-merged as
`d87977c7ed14bb67f51925a3d3d09c67e76c79a1`. Issue #83 is closed as completed.

No new protocol authority, lifecycle engine, ledger, payment authority, W037 behavior
or frozen-architecture amendment was introduced.