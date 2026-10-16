# Review FEAT #244 (Opus, read-only)

Branch `ts-bugs/feat-G2`, commits a2f9ebe37, 2f2069877, 268caa1f2, a0a9b35ab, 73962f1a6, 62cf84fde.
Checked against the issue body (no comments on the issue).

## Verdicts

| Commit | Subject | Verdict |
|--------|---------|---------|
| a2f9ebe37 | Hero.jsx to Hero.tsx | APPROVE (`ts-equivalence --diff`: 1 identical, 0 different) |
| 2f2069877 | background video, tour modal, scroll-linked media | CHANGES REQUIRED (findings 2, 5) |
| 268caa1f2 | product mockup and card carousel | CHANGES REQUIRED (finding 4) |
| a0a9b35ab | header GitHub button | CHANGES REQUIRED (findings 3, 6) |
| 73962f1a6 | editors, defaults, Dutch, translation denylist | APPROVE |
| 62cf84fde | file budgets | CHANGES REQUIRED (finding 1) |

## Required findings

1. **Entry budget most likely exceeded** (medium, CI red). `agent-hub/src/App.jsx:25` imports
   `ProductWebsite` statically, so everything `extraSections.ts`, `Hero.tsx`, `CtaBanner.tsx`,
   `MediaText.tsx`, `FramedMedia.tsx` and `HeaderView.tsx` import is in the public entry,
   including six new stylesheets (`backgroundVideo.css`, `mediaMotion.css`, `tour.css`,
   `cardCarousel.css`, `productMockup.css`, `githubStarButton.css`). Estimate for those after
   whitespace and comment stripping: about 11.1 KB raw, about 2.6 KB gzipped on their own.
   `agent-hub/.entry-budget.json` has about 5.4 KB raw and about 1.0 KB gzip headroom for
   render-blocking CSS (budget = measurement + 3%), and 62cf84fde does not touch it. The
   `entry-budget.mjs` step in the frontend build job will very probably fail. Fix: load
   `ProductMockup` and `CardCarousel` with `React.lazy` from `extraSections.ts` so their CSS
   moves to their own chunk (they are never the LCP block), and ideally lazy-load `TourPill`'s
   modal. If a raise is still needed, make it a deliberate budget edit with the reason in the
   commit message, as the budget file asks. Confirm with one build in CI, not locally.

2. **Tour modal: no initial focus and no focus trap** (medium, a11y).
   `agent-hub/src/marketing/components/PopupModal.tsx:55-84` marks the dialog `aria-modal`
   but leaves focus on the pill behind the overlay, and Tab walks into the page under it.
   Escape and focus return work (`TourPill.tsx:41-44`, tested). Fix in `PopupModal` (it helps
   Features/Security too): on mount focus the close button (or the dialog with `tabIndex={-1}`),
   keep Tab and Shift+Tab inside the dialog, and add a test that Tab after the last control
   comes back to the first.

3. **The star count can belong to a different repository than the link** (medium,
   correctness). `GithubStarButton.tsx:39` always shows the count of the server's
   `GITHUB_STATS_REPO` (`server/routes/publicGithubStats.js:41`), while the editor accepts any
   https `repoUrl` (`HeaderGithubFields.tsx`). A site that links its own repository then shows
   Bee Flow's stars next to it. The route's header comment already names this gap for the
   `GitHubStats` section. Fix: show the live number only when the normalised `repoUrl`
   (lower-cased, no trailing slash or `.git`) equals the `url` in the answer, or when `repoUrl` is
   empty; otherwise show only `starsFallback`. Say this in the editor hint. Add a test for it.

4. **Product mockup: layout shift, and the steps are not in the markup until the animation
   runs** (medium; the issue requires "no layout shift").
   `agent-hub/src/marketing/sections/ProductMockup.tsx:115` renders only
   `steps.slice(0, visibleSteps)`, so the window grows step by step once its content is taller
   than the `min-height: 340px` in `productMockup.css`. Before the animation, the server render
   and screen readers get no step text. Fix: always render every step, and hide the ones not yet
   shown visually (for example `data-shown="false"` with `visibility: hidden` / `opacity: 0`,
   with no `aria-hidden` on content the screen reader copy needs). That reserves the final size
   and keeps the text in the DOM. Do the same for the typed prompt (the screen-reader copy is
   already there).

5. **The GitHub button can be a link without an accessible name** (low-medium, a11y).
   `GithubStarButton.tsx:62-76`: the label is optional, the mark is `aria-hidden`, and with no
   label and no count the link has no name. With only a count its name is just "1,234". It
   also opens a new tab without saying so. Fix: `aria-label` built from the label or "GitHub",
   plus the count and a "(opens in a new tab)" suffix, all through translated renderer strings.

6. **Two fetches per page view** (low). `HeaderView` (desktop) and `MobileNav` both mount
   `GithubStarButton`, and each calls `/api/public/github-stats` on mount. The server cache and
   `Cache-Control` limit the cost. Still, share one module-level promise in `useStars` so a page
   makes one request.

## Not required (notes)

- Style values: `fit`, `position`, `overlay`, `tilt`, `gradient` and `motion` reach the DOM
  only as class names picked from allow-lists (`backgroundVideo.ts`, `ProductMockup.tsx`,
  `CardCarousel.tsx`, `FramedMedia.tsx`). The custom overlay colour goes through a strict
  colour regex (hex, rgb/hsl numbers, `var(--x)`; `url(` cannot pass) and is set through React's
  style object. `overlayOpacity` is clamped to 0..100. Tested. The server stores these values
  without checking them (`sanitizeBlocks` only checks block types), the same as existing media
  and style content, so the MCP path can store junk that the renderer then ignores. Server-side
  allow-listing would be defence in depth, not a fix.
- Media URLs go through `resolveAssetUrl`, like existing media: cms keys, root-relative
  paths, and http(s). Nothing stricter than today's media, nothing looser.
- `/api/public/github-stats` takes no parameters (strict zod, `?repo=` refused), has a fixed
  upstream URL, a 24 h cache, failure backoff and stampede dedupe. The browser sends no request
  to GitHub (`credentials: 'omit'`, same origin). Link `https://` only, `noopener noreferrer`.
- Video: the background and teaser loops are `muted`, without controls, with `preload="none"`.
  They mount after hydration and only when `useAutoplayAllowed` says yes (no reduced motion,
  no `saveData`, not phone width for backgrounds). They pause off-screen. The tour player
  never autoplays and unmounts on close. The poster is the eager, high-priority LCP image.
  Scroll motion is CSS `animation-timeline` inside `prefers-reduced-motion: no-preference`.
  The carousel drift and the mockup animations are off with reduced motion.
- Carousel: arrow buttons with labels, focusable region with arrow keys, `scroll-snap`, and
  smooth scrolling only without reduced motion. Card links are not suppressed in the editor
  preview (other sections use `Button` for that). Cosmetic.
- Translation denylist (`cmsTranslate.js`, `translatable.ts`, kept in sync): `poster`,
  `captionsLang`, `fit`, `position`, `overlay`, `tilt`, `numeral`. No existing block uses
  any of these keys for prose (grep of the defaults, the site seed and the renderers).
  `label`, `duration`, `prompt`, `windowTitle` and `alt` still translate (tested).
- NL migration: data file with a pinned sha256, idempotent fill-missing-only, listed in
  `bootMigrations.js` and in `SOLE_OWNER`, every new English motion key covered (tested).
- TS honesty: no `any`, `as unknown`, `@ts-*` or eslint-disable in the new files. The one cast
  (`badgeAlign as CSSProperties['textAlign']`) keeps the old behaviour.
- Tests run (one file at a time): vitest `TourPill`, `backgroundVideo`, `CardCarousel`,
  `ProductMockup`, `GithubStarButton`, `editors.test.js`: all pass (26 tests).
  `node --test` `cmsTranslate.motion`, `add-nl-cms-motion-translations`, `cmsBlockSchema`,
  `nlCatalogues`: all pass.
