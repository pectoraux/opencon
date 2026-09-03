# UX-01 Evidence Ledger — Unified product client experience

**Status:** DELIVERED — implementation PR **#84** (open, awaiting architect review) from `feat/ux-01-unified-product-client`, created from main checkpoint `4a9ce3777ba8df2c92535c7998fc1190f9f59613`. Any remediation stays on that same PR.  
**Issue:** #83  
**Governance PR:** #82 — squash-merged `2efe8dbd4d9146d3dea750d1f3ee87647f9dcc59`  
**Work order:** `spec/work-orders/UX-01.md` (frozen)  
**Direction of record:** the architect-approved OpenCon Unified Product UX implementation brief  

## 1. Where the implementation lives

The user-visible client runs in the product client environment (the Next.js app
served on the product port), not in this repository — this repository contains
the protocol implementation and has no production frontend surface. Per the
brief's governance section, this PR records the work item, the frozen work
order and the evidence; the implementation artifacts are:

| Artifact | Location (product client environment) |
|---|---|
| Client app (route `/`) | `src/app/page.tsx` |
| Design system | `src/components/opencon/*` (primitives, cards, lifecycle rail, evidence, detail grammar, sheets/wizard, overlays, nav, five views) |
| Client core library | `src/lib/opencon/{types,lifecycle,money,semantics}.ts` + `client.tsx` (the single fetch layer) |
| Preview product API | `mini-services/opencon-preview-api/` (port 3050; preview stand-in for the future versioned product API) |
| Interaction-path tests | `mini-services/opencon-preview-api/interaction-paths.test.ts` |
| Information architecture | `docs/opencon-ux-information-architecture.md` |
| Implementation evidence | `docs/opencon-ux-implementation-evidence.md` |

## 2. Verification record

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
Architecture regression: arch:check violations identical to the pre-existing
  7 scaffold violations — zero new; frozen architecture files untouched;
  no src/{core,domain,infra,adapter} changes; no W036/W037 protocol behavior.
Browser verification (agent-browser, fresh session, re-run after the
  implementation-PR remediations): all five destinations render with live
  data and navigate correctly from every shell (sidebar, bottom bar, cards,
  deep links); the creator journey completed through the real UI (rights
  checklist → start → submit → live verification ladder → payout →
  SETTLED/paid); the dispute was responded and auto-resolved in the user's
  favor with value released; a campaign was created through the wizard,
  ended, measured and settled (spend shown in its own wallet dimension);
  an eligible benefit was claimed ($300 to the Wallet) and an ineligible
  benefit was rejected with the server's human reason verbatim; global
  search and notification deep-links work; role switching adapts Home and
  Discover; 390px shows zero horizontal overflow on every destination with
  the bottom nav and 52px targets, footer at viewport bottom on short pages
  and at document end on long pages; 1280px shows the sidebar shell; zero
  console errors and zero page errors in a fresh session.

Implementation-PR remediations (found by the fresh verification run, fixed
  before opening the PR, each re-verified):
  1. shell navigation now uses plain fragment anchors — next/link's
     history.pushState navigation changed the URL without firing hashchange,
     so the view never re-rendered;
  2. settled campaign spend moved to its own wallet dimension
     (spendSettledUsd) so completed earnings can never go net-negative;
     pinned by a regression test;
  3. min-w-0 on grid-item cards removed a 3px horizontal overflow at 390px;
  4. the page title now reads "OpenCon — One network, one product".
```

## 3. Authority-separation proof points

- Action availability, transitions, value phases, eligibility and payout gates
  are decided by the server boundary; every UI rejection surfaces the server's
  human reason verbatim.
- Pending value is never spendable anywhere in the UI; payout buttons appear
  only for matured value and the server rejects anything else.
- Unknown and foreign-tenant object ids return identical fail-closed 404s —
  no existence oracle (tested).
- The client imports no domain module; all data flows through one fetch layer
  with relative, gateway-compatible URLs.

## 4. Documented backend capability gaps (for the Architect)

1. **Versioned product API for browser clients** — the read models the UX
   requires (home/discovery aggregation, work ladders, wallet with phases,
   notifications, search, profile) are not yet served by the `/api` boundary.
   The preview product API implements the contract shape with representative
   data and server-side guards. Recommendation: a canonical product-API work
   item owned by the `/api` boundary (external contract) that serves these
   read models from the real authorities.
2. **Browser session/auth wiring** — the preview assumes one demo identity
   with three role contexts; the real client needs the API auth path
   (PrincipalResolver / AuthorizationService) connected to a browser session.
3. **Provider wiring** — measurement/payment surfaces are labels on records;
   real flows run through `/measurement`, `/payments`, `/adapters`.
4. **Advisory AI copy** — recommendations are static advisory strings
   ("Suggested match — needs your approval"); real generation belongs to
   `/llm` and must remain advisory-only.

## 5. Governance / implementation boundary

The governance record is merged as PR #82, and issue #83 (READY_FOR_IMPLEMENTATION)
authorizes exactly one UX-01 implementation PR — **#84**, opened from the implementation
branch `feat/ux-01-unified-product-client` (from main checkpoint `4a9ce37`). The
product implementation itself continues to live in the product client environment
and remains outside protocol authority boundaries: this repository records the work
item, the frozen work order and the evidence; it gains no frontend surface and no
client authority. Any backend capability gap must be implemented through the owning
`/api`/integration boundary rather than by creating client-side authority. Any UX-01
implementation remediation remains on its single implementation PR.

## 6. Remediation discipline

Any architect CHANGES REQUESTED finding is remediated on the same UX-01
implementation PR/branch with the corresponding client artifacts updated in
the product environment, re-verified, and re-reviewed. No second implementation
PR for UX-01.
