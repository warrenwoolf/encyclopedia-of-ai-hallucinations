# House style — CSS and UI guide

## Motion and JS

- **No transitions, animations, hover-scale, or JS-driven visual effects.**
- **No client JS beyond `theme.js` and `browse.js`.** The account dropdown is pure CSS (`:hover`/`:focus-within`), not JS. Don't add frameworks.

## Typography

Body base is a flat `17px` (set in both the base `body` rule and the ≤600px breakpoint). Everything else is `em`-relative, so changing that one value rescales the whole site.

The site title (`.site-title-text`) and credit (`.site-credit`) use rem-based `clamp()`s so they scale fluidly and never overflow small phones. Don't reintroduce per-breakpoint `font-size` overrides for those elements, and don't reintroduce a fluid body `clamp()` without a reason.

## Layout variables

Two CSS variables control page width:
- `--content-width`: full-bleed bands (top bar, header, footer) — always `100%`.
- `--main-width`: the `<main>` column, default `760px` centered. Pages opt out to full-bleed by overriding it: `body.browse-page` → `100%`, `body.admin-wide` → `min(1400px, 96vw)`.

Don't collapse these two vars together — the bands must stay full-bleed even when `main` is centered.

`--page-pad` controls the outer gutter (`50px` desktop → `24px` ≤900px → `12px` ≤600px). The top bar, header, `main`, and `footer` all use it. Don't reintroduce hardcoded paddings on those elements.

## Browse layout

`.browse-layout` is `grid-template-columns: 240px 1fr` — a sticky filter sidebar plus an entry list. The old third track that centered the list was removed on purpose; don't re-add it.

## Entry-cards

`.entry-card` / `.entry-card-head` is a shared component used across browse, home, dashboard, and the entry page. `longField()` is exported from `src/routes/browse.ts` and reused by `my.ts`. A change to card markup or CSS ripples everywhere — grep `entry-card` before editing.

Convention: on browse/home cards, both the A-number (`.entry-card-eid`) and the title are `<a>`s to `/e/:id`; clicking elsewhere on the header toggles the `<details>`. On `/my/submissions` cards the title links to the overview page, not the public entry.

## Top bar

Primary nav links (Browse/Submit/Guide/About/Terms) are **plain black labels** (`.site-nav .nav-links a { color: var(--text) }`). Log in / Sign up / Log out are filled blue buttons (`.btn-prominent`, same `--entry-head-bg` as the card headers). The theme toggle stays small and unobtrusive (`.theme-toggle`) — don't promote it.

On ≤700px the account dropdown renders inline (always-open) since there's no hover on touch.

## CSS gotchas

**Specificity and source order.** `.entry-card-head` sets `cursor: pointer`. When an element also has `.entry-page-head` (the static title bar on the entry page), an earlier `.entry-page-head { cursor: default }` at equal specificity *loses* to the later rule. Fix: co-qualify both classes (`.entry-card-head.entry-page-head { … }`) to raise specificity rather than relying on order.

**Three theme blocks must stay in var-parity.** Colors are defined in three places: `:root` (light default), `@media (prefers-color-scheme: dark) :root:not([data-theme="light"])` (system auto-dark), and `:root[data-theme="dark"]` (explicit toggle). When you add or change a `--var` in one dark block, **update the other dark block too** — they are not generated from a shared source. A drift here is invisible under the explicit toggle and only appears for OS-dark users who haven't toggled. Grep all three blocks for the var name before shipping a theme color change.

## Copy conventions

- Dates: `YYYY-MM-DD` (UTC) on user-facing pages; `YYYY-MM-DD HH:MM:SS UTC` on admin pages.
- Staff copy: terse, lowercase headings ("queue", "pending", "review").
- User copy: sentence-case prose.
