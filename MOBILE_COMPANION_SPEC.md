# Mobile PWA Draft-Day Companion — Spec (Board + Team Card)

> Status: **spec only — not yet implemented.** Written 2026-07-03; reviewed against `faa0dd3` (Our Clients list + player dossier redesign) same day. Coordinate before building; work should go on a fresh branch off `main` → PR (main is protected).

## Context

Draft day means agents on iPhones, not laptops. The hub (`public/index.html`, single vanilla-JS monolith) is desktop/TV-first: the Board is a wall of fixed 104px tiles with a sticky side feed, and the team card is a 4-column full-viewport overlay. Neither is usable one-handed on a phone. The goal is a **PWA mobile companion** — same site, same data, installable to the home screen — where:

- The **Board** becomes screen-width tiles that serve as both board *and* list (one full-width tile per pick).
- Tapping a tile opens the **team card** mobile-optimized: modules stacked instead of side-by-side, collapsible, compact.
- **Our Clients** gets a quick pass so cards display and navigate cleanly on mobile.
- On The Clock / Bonus Pools are low priority (the board covers that info). Desktop and TV mode must be **pixel-unchanged**.

## Working defaults (easy to flip — flag disagreements)

1. **Card modules on mobile**: Q1 (Intel/Matrix) open on card open, other three collapsed; open/closed state remembered per device (`dd:mPanels` localStorage) and survives re-renders/pick navigation.
2. **Mobile nav**: fixed bottom tab bar (thumb-friendly); compact top header. Desktop top tabs untouched.
3. **Mobile default tab**: Board (desktop keeps Our Clients).
4. **PWA depth**: installable (manifest + icons) + minimal service worker — cache-first for fonts/brand/logos only, network-only for HTML/data/API. Live data can never be stale.

## Architecture: one responsive codebase, no fork

Single mobile mode gate, used two ways:

- **CSS**: one new `@media (max-width:640px)` block appended near the end of the `<style>` block (desktop rules never touched; guard with `body:not(.tv)` where TV overlap is conceivable).
- **JS**: `const MOBILE = matchMedia("(max-width:640px)")` + `document.body.classList.toggle("mob", MOBILE.matches)` on boot + `change` listener. Renderers stay shared; the `mob` body class and a handful of `MOBILE.matches` checks drive the structural differences.

All existing renderers (`renderBoardGrid`, `renderTeamCard`, panel builders `renderTcIntel`/`renderTcMatrix`/`renderTcDraft`/`renderTcHabits`/`renderTcRangeHistory`, `renderClients`) are reused as-is or with tiny additive edits. Locked design principles hold: teamintel-only color, neutral fit grades, no new projection/alert layers — this is purely a re-layout.

## 1. Board → full-width tiles (mostly CSS)

`.bcard` markup has stable child classes (`.bc-no`, `.bc-team`, `.bc-slot`, `.bc-player`, `.bc-meta`, `.bc-bonus`, `.bc-dots`, `.bc-heatlab`), so the row re-layout is CSS-only via grid areas:

```css
@media (max-width:640px){
  body:not(.tv) .bcard {
    width:100%; min-height:0;
    display:grid; column-gap:10px; align-items:center; padding:9px 12px;
    grid-template-columns:auto 1fr auto;
    grid-template-areas:"no body slot" "team body slot" "dots dots dots";
  }
  /* .bc-no→no, .bc-team→team, .bc-slot→slot, .bc-player/.bc-meta/.bc-bonus→body, .bc-dots/.bc-heatlab→dots */
  .bc-dots { display:flex; flex-wrap:wrap; gap:4px 12px; padding-top:6px; }
}
```

Layout left→right: **pick# over team abbr+logo | player name (drafted: name + pos·school·agent + bonus) or ⏱ OTC | slot $** — in-play dots+initials wrap below as a horizontal row. Heat mode (`.bc-heat` single-player focus) and drafted/SV/on-clock tints all inherit — they're background/border styles on `.bcard`.

Also in the mobile block:
- `.bc-rnd` round headers → `position:sticky; top:0` with `background:var(--bg)`.
- `#boardFeed` → `display:none` (the full-width list IS the feed on mobile; kills the 980px stack duplication).
- `.ba-filters` toolbar → horizontally scrollable single row (`overflow-x:auto; flex-wrap:nowrap`); hide `#tvCtl` on mobile.
- "Jump to current pick" also gets a small floating pill button (bottom-right, above the tab bar) — reuses `jumpCurrent()`; the `#ocRow` scroll target works unchanged.
- In-play dot rows: bump read size (`.bc-pd` ≥12px font, `.idot` 11px) — dots are informational; the whole tile is the tap target (`expandPick`).

The `CAP=6` in-play cap in `renderBoardGrid` stays — rows fit 6 fine.

## 2. Team card → stacked collapsible modules

The card is rebuilt as one innerHTML string on **every** state change and 3s poll, so collapse state must live outside the DOM:

- New global `mPanelOpen` (e.g. `{intel:true, draft:false, habits:false, range:false}`), initialized from `localStorage["dd:mPanels"]`, default `{intel:true}`; matrix (team-overview mode) shares the `intel` slot.
- Each of the 5 panel builders adds a `data-q="intel|draft|habits|range"` attribute to its root `.tc-panel` div (5 one-word edits).
- In `renderTeamCard`, when `MOBILE.matches`, append ` collapsed` class to panels whose key is off. Delegated click handler on `#teamCard` for `.tc-panel > h4` (active only under `body.mob`): toggle key in `mPanelOpen`, persist, re-render. Chevron indicator on `h4` via CSS `::after`.
- CSS: `body.mob .tc-panel.collapsed > *:not(h4){ display:none }`, `body.mob .tc-panel.collapsed { padding:10px 14px }`, h4 gets `cursor:pointer` + tap padding.

Card chrome on mobile (CSS in the same block):
- `.tc-backdrop` → full-bleed sheet: padding 0; `.tc-card` → `width:100%; height:100dvh; border-radius:0; overflow-y:auto` (extends the existing 1100px fallback that already makes it a scrolling column; 820px already gives 1-col panels).
- `.tc-top` header → `position:sticky; top:0; background:#fff; z-index:2`, wraps to two lines: line 1 logo + abbr + `Pick #N` + ✕; line 2 the round·pick navigator `.tc-nav` full-width with **larger caret buttons** (≥40px tap targets) — prev/next pick is the core one-thumb draft-following gesture. Nav dropdown menus get `max-height:50dvh; overflow-y:auto`.
- `.tc-band` → player-select dropdown full-width; the 6 `.tc-stat` tiles become a **horizontally scrollable strip** (`overflow-x:auto; flex-wrap:nowrap`, scroll-snap) instead of wrapping to 3 rows. Apply the strip rule to `.tc-stats` generically — the player dossier's `.pp-stats` band reuses that class and gets fixed for free.
- `.tc-foot` quick actions → `position:sticky; bottom:0; background:#fafafa; z-index:2` with `padding-bottom:calc(14px + env(safe-area-inset-bottom))`; "View Player Profile ↗" shrinks to an icon-sized button so Log Intel / $ Offer / $ Bonus / ⊘ Rule Out stay one row. `#tcArmed` form renders above the sticky foot. **Scoping (post-`faa0dd3`)**: the player dossier reuses `.tc-foot` (as `.pp-foot`, the player-settings bar) and `.tc-panel` — so the sticky rule and the collapse chevron/handler must be scoped to the card overlay (`#teamCard .tc-foot`, `#teamCard .tc-panel h4`), never bare `.tc-foot`/`.tc-panel`.
- Auto-advance flash on made pick (`.tc-made`) works unchanged.

**Per-module efficacy on mobile** (content-preserving, CSS-scale only for v1): Q1 sparkline is fluid-width already — fine. Q2 `.tc-upc` and Q4 comp tables → horizontal scroll containers (`overflow-x:auto`). Q3 key-values are already narrow. Deeper per-module trimming (dropping columns etc.) is a follow-up review on a real phone once the stacked layout ships.

## 3. Our Clients (roster list) + player dossier quick pass

*(Rewritten after `faa0dd3`: Our Clients is now a roster **table** (`table.cl-table`, `#clientRows`), row click → `openPlayer` → the full player **dossier** page. Best Available rows also open the dossier now.)*

**Roster table on mobile**: `hide-sm` already drops School/Age/Range at ≤680px, but the surviving 7 columns don't fit 390px. In the mobile CSS block, additionally hide the Pos, Lvl, and Money columns (extend `hide-sm` on those `th`/`td` or add a `hide-xs` class at ≤640px), leaving **# / Player / Interest / Status** — rank, name, colored interest chips with next-pick #, drafted/on-board. That *is* the mobile client list; everything else lives one tap away in the dossier. Interest chips (`.cl-int`) already truncate to top-3 + `+N`. `#clientSummary` tiles → 2×2 grid instead of a squeezed row.

**Player dossier (`renderPlayerDetail`) on mobile**: mostly free — `.pp-cols` already collapses to 1 column at ≤820px, and the `.tc-stats` strip treatment (§2) fixes the `.pp-stats` band automatically. Remaining touch-ups:
- `.pp-foot` player-settings bar (medical seg + range inputs): let it wrap to two rows; ≥40px tap targets on the seg buttons and Set/Clear; it must **not** inherit the card overlay's sticky-foot rule (see scoping note in §2).
- Numbered dossier panels stack fine as-is; *optionally* reuse the `mPanelOpen` collapse pattern here later — not part of v1.
- `#viewDetail`: enlarge the ← Back tap target (`closeDetail()` — critical since installed iOS PWAs have no browser back UI); sticky header.

## 4. PWA scaffolding

New files:
- **`public/manifest.webmanifest`** — `name: "SV Draft Day"`, `short_name: "Draft Day"`, `display: "standalone"`, `start_url: "/?pwa=1"`, `background_color: "#ffffff"`, `theme_color: "#ff2a22"` (matches `--red`), icons list.
- **`public/icons/`** — PNGs rendered from `public/brand/sv-logo.svg`: 180 (apple-touch), 192, 512, 512-maskable (generated once, checked in).
- **`public/sw.js`** — minimal: version-stamped cache name; `install` → precache `/fonts/*`, `/brand/*`, `/icons/*`; `fetch` → cache-first **only** for fonts/brand/icons/mlbstatic team logos, everything else falls through to network untouched (no HTML, no `/data/*`, no `/api/*`, no external feeds). `activate` → delete old cache versions + `clients.claim()`. Because HTML is never cached, users always get the fresh shell — no stuck-on-old-app risk mid-draft.

`index.html` head additions:
```html
<link rel="manifest" href="/manifest.webmanifest" crossorigin="use-credentials">
<meta name="theme-color" content="#ff2a22">
<link rel="apple-touch-icon" href="/icons/icon-180.png">
<meta name="apple-mobile-web-app-capable" content="yes">
<meta name="apple-mobile-web-app-status-bar-style" content="default">
```
Viewport becomes `width=device-width, initial-scale=1, viewport-fit=cover` (needed for `env(safe-area-inset-*)`). SW registration guarded in the boot IIFE. Boot default-tab: `if (MOBILE.matches) setView("board")` before first render.

**`middleware.js`**: the SITE_PASSWORD gate intercepts every path and would 401 manifest/SW/icon fetches for a not-yet-authed context — whitelist exactly `/manifest.webmanifest`, `/sw.js`, `/icons/*`, `/favicon.svg` (public-safe assets; the app itself stays gated). Keep `crossorigin="use-credentials"` on the manifest link so authed fetches carry the cookie.

**iOS note**: standalone PWAs use a separate cookie store — first launch of the installed app shows the login page once; the `sv_auth` cookie lasts 7 days, so a morning-of login holds through the draft. (Optional: bump `Max-Age` to 30d.)

No `vercel.json` changes required (optional nice-to-have: `Cache-Control: no-cache` header on `/sw.js`).

## 5. Mobile bottom tab bar

- New fixed bar after `<main>`: `<nav id="mtabs">` with Board · Clients · Best · Clock · Pools (icons+labels), each calling the existing `setView()`; hidden on desktop, shown only under the mobile media query + `body:not(.tv)`, with `padding-bottom:env(safe-area-inset-bottom)`.
- `applyViewVis()` additionally syncs `.on` state onto `#mtabs` buttons (2-line addition).
- Mobile CSS hides the desktop `.tabs` nav and compacts `<header>` (logo + live dot + Live/Mock seg + year badge, one row); `<main>` gets `padding-bottom:~70px` so the bar never covers content. Team-card overlay (z-90) intentionally covers the bar.

## Files touched

| File | Change |
|---|---|
| `public/index.html` | head tags; `MOBILE` flag + `mob` class; mobile CSS block (~150 lines, appended); `data-q` on 5 panel builders; `mPanelOpen` + h4 toggle handler; `#mtabs` markup + `applyViewVis` sync; mobile default tab; SW registration; jump pill |
| `public/manifest.webmanifest` | new |
| `public/sw.js` | new |
| `public/icons/*.png` | new (generated from `brand/sv-logo.svg`) |
| `middleware.js` | matcher whitelist for manifest/sw/icons/favicon |

## Ordered steps

1. Branch off latest `main`.
2. PWA base: manifest, icons, head tags, SW + registration, middleware whitelist. Verify installability before any UI work.
3. `MOBILE` flag + `body.mob` + bottom tab bar + header compaction + mobile default tab.
4. Board full-width tile CSS block (+ feed hide, sticky rounds, toolbar scroll, jump pill).
5. Team card mobile: sheet chrome, sticky top/foot, stats strip, collapsible panels.
6. Our Clients + `#viewDetail` touch-ups.
7. Desktop/TV regression sweep, then PR (rebase on `main` first).

## Verification

- **Local**: `set -a; . ./.env.local; set +a && vercel dev --listen 3399 --scope stadium-ventures`. Headless-Chrome screenshots at iPhone viewport (390×844) for: board list, open team card (collapsed + expanded panels), clients, detail+back, bottom bar. Desktop regression screenshots at 1280×900 and TV mode — diff against pre-change captures to confirm pixel-unchanged.
- **PWA checks**: `curl -I` the manifest/sw/icons through the middleware (with and without `sv_auth` cookie — must be 200 both ways); Lighthouse installability audit against a `vercel deploy` **preview** URL; real-iPhone add-to-home-screen from the preview (standalone launch, one-time login, safe-area insets, sticky foot above home indicator).
- **Live-data safety**: with SW active, confirm `/api/draft`, `/api/intel`, teamintel feed, `/data/*.json` all hit network (SW bypass); confirm the 3s poll still updates the mobile board.
- Deploy remains manual: `vercel --prod --scope stadium-ventures --yes`.

## Risks

- **Merge conflicts with in-flight work** — changes are additive-by-design; rebase immediately before PR.
- iOS `100vh`/keyboard quirks in the card sheet → `100dvh` + safe-area insets; body scroll-lock already in place; add `overscroll-behavior:contain` on `.tc-card` against rubber-banding.
- Board re-render cadence (3s) vs open dropdowns on mobile — existing desktop behavior, unchanged; panel collapse state is render-proof by design.
- `.bcard` grid-areas depend on child-class stability — renderer restructuring would need the areas map updated (one CSS block, easy fix).
- iOS standalone cookie store = one extra login on first installed launch (documented above; acceptable).

## Deferred

- Per-module content trimming for mobile ("efficacy within each box") — review on a real phone once the stacked layout ships.
- On The Clock / Bonus Pools mobile polish — explicitly deprioritized.
