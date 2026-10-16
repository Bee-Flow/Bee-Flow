# Review FEAT #243 part B (Opus, read-only)

Branch `ts-bugs/feat-G4`, range `origin/ts-bugs/fixes..HEAD` (5fe9df8fb, 4dcb5ae4b, 320f0a082, 15876db43).

## Verdicts

| Commit | Subject | Verdict |
|---|---|---|
| 5fe9df8fb | scrollStory and tour blocks | CHANGES REQUIRED (R4) |
| 4dcb5ae4b | cookieless A/B tests on a block | CHANGES REQUIRED (R1, R2, R3) |
| 320f0a082 | i18n / empty-catch ratchet follow-ups | APPROVE |
| 15876db43 | rebase follow-ups (NL into catalogue data, ExperimentSection, pin) | APPROVE |

## Required

1. **The experiment wrapper drops the block's width and stacking styles.**
   `agent-hub/src/marketing/experiments/ExperimentSection.tsx:106` inserts a `display: contents`
   div between `.cms-block-wrap` and the section. `marketing.css:2616-2627` styles
   `.cms-block-wrap > *` (position, z-index above the image overlay, the narrow/medium/wide
   max-width). Those properties do nothing on a `display: contents` box and are not inherited, so
   a block with an experiment loses its max-width preset and can sit under its overlay, in both
   variants, while the editor preview (no wrapper) still shows it correctly. Severity: medium
   (visible layout regression, preview not WYSIWYG).
   Fix: put `data-cms-experiment/-variant/-goal` on the existing block wrapper in
   ProductWebsite.tsx (pass them up from `resolveBlock`), or render `ExperimentMark` as a sibling
   without a wrapping element; `reportGoal`'s `closest()` keeps working. Add a test that a block
   with an experiment renders the same element tree under `.cms-block-wrap` as one without.

2. **The admin translation panel still offers `abKey` / `abGoal` for translation.**
   `agent-hub/src/components/admin/product-website/translatable.ts:24-38` says "KEEP IN SYNC with
   cmsTranslate.js" but was not updated; only the server's `DENY_KEYS` got `abKey`, `abGoal`.
   A manual per-locale value for either splits the Umami report per language, or (an invalid
   name) silently switches the experiment off in that locale. Severity: medium.
   Fix: add `'abKey', 'abGoal'` there too (and `abShare` is a number, no change needed), plus a
   case in `translatable.test.ts`; better, a parity test that both deny lists hold the same keys.

3. **An alternative may change a form's consent text and fields, which the server never sees.**
   The A/B card is added to every editor (`blockEditors/catalogue.ts:130`), including `form`
   and `customer-support`, and `applyAlternative` (`experiments/experiment.ts:60`) merges any
   field. The submit route validates and records against the published block's own content
   (`server/routes/cmsForms.js:247` `validateSubmission(found.block.content, ...)`,
   `websiteForms.consentFor` for `consent_text`). A variant-B visitor who saw a different
   consent wording gets the control's wording recorded as what they agreed to, and changed
   `fields` fail validation or are dropped. Severity: high for a privacy product (consent proof
   no longer matches what was shown).
   Fix: a per-type deny list for `abAlt` applied in `applyAlternative` / `diffAlternative`
   (at least `consent`, `fields`, `automationId` and the form/support submit config), or no
   A/B card for `form` and `customer-support` at all; mirror it as a warning in
   `server/cmsBuilder/experiments.js` so MCP/AI-builder writes are flagged too; test both.

4. **scrollStory hides focusable media.** `agent-hub/src/marketing/sections/ScrollStory.tsx:102`
   renders `FramedMedia` inside an `aria-hidden` panel, and on wide screens the inline copy
   (`:95`) is visually hidden but still in the tab order. The media slot accepts `video` and
   `clip` (documented in `cmsDefaults.js`, settable through MCP/AI builder even though the editor
   only writes images); a clip has native controls, so a keyboard user tabs into invisible
   controls and into controls inside `aria-hidden` (WCAG 4.1.2), and a silent video autoplays
   twice. Severity: medium.
   Fix: mark the panel `inert` as well as `aria-hidden`, and either restrict scrollStory media to
   `image` (validator warning + render guard) or render the panel copy as a poster image only.

## Recommended (not blocking)

- Goal semantics: `track.ts:46` counts the first click on any button, so in a `tour`, `tabs` or
  `faq` block the first Previous/Next/hotspot/tab click is "the goal". Count only `a[href]`,
  submit buttons and forms, or let the author mark the goal element.
- Consent withdrawal: `AnalyticsTracker.removeTracker` (`AnalyticsTracker.tsx:75`) removes the tag
  but `window.umami` stays defined for the rest of the page view, so goal events after a
  withdrawal still send. Same pre-existing behaviour as `analyticsEvents.js`; fix once in a shared
  `canTrack()` that `track.ts` and `analyticsEvents.js` both call (track.ts also duplicates
  `analyticsEvents.track`).
- Tour: Next/Previous become `disabled` at the ends (`Tour.tsx:108,112`), so focus falls to
  `<body>` after reaching the last step; use `aria-disabled` or move focus to the panel.
- scrollStory: inactive steps at `opacity: 0.45` (`scrollStory.css:23`) likely fail text
  contrast; every `<li>` is a tab stop even in the stacked layout.
- Duplicated blocks copy `abKey`, so two blocks share one draw and one report; a validator warning
  for a duplicate `abKey` within a site would help. `panelId` / section ids repeat with two tour
  blocks on one page.
- Hotspot x/y inputs turn an empty field into 0 (`TourEditor.tsx` `toPct`).

## Checked and fine

- Privacy of the split: variant drawn from `crypto.getRandomValues`, held in a module Map; no
  cookie, localStorage, sessionStorage, URL parameter or id (test asserts storage unchanged).
  Event payload is exactly `{ experiment, variant }`; event names are author-set but limited to
  `[a-z0-9_-]{1,40}`. Nothing goes to a third party; only `window.umami.track`, which exists only
  once the consent-gated tracker loaded (cookies mode waits for consent, preview never loads it,
  `disabledForPage` never mounts it; the site does full page loads, so no carry-over). Retries
  stop after about 5 s, so no event is queued for later consent. No event before consent.
- Crawler and preview: `renderBlocks` skips all four ab fields (tested), preview never draws.
  The SPA mounts with `createRoot`, so no hydration mismatch. JS-rendering crawlers get a random
  variant like any visitor, which is ordinary A/B testing, not cloaking.
- abAlt and the save path: block content is stored as given (`normalizeBlockRecord`), so abAlt is
  neither more nor less validated than the content it overlays; `block.style` cannot be reached
  from abAlt, and `stripExperiment` stops nested ab fields. Everything renders through React
  (escaped) or `esc()` in renderBlocks; hotspot coordinates are clamped to 0-100 and only set as a
  CSS custom property with a `%` suffix.
- Accessibility (apart from R4): hotspots are real buttons with labels, `aria-expanded`,
  `aria-controls`, Escape closes; panel is a polite live region; pulse and sticky layout are off
  under `prefers-reduced-motion`; steps focusable and focus moves the panel.
- Translation: server denies `abKey`/`abGoal`, translates `abAlt` (tested via `isDeniedKey`).
- NL: the 40 keys moved from the deleted migration into
  `migrations/data/hardcoded-website-admin-2026-10-nl.json`, hash pinned, boot entry removed;
  no English key removed from `cms_site.js` (only reordered, 40 added).
- `editors.test.js` pin 28 -> 31: the base already had 29 catalogue entries against a pin of 28
  (customer-stories landed without updating it); +2 here. Justified.
- TS: casts are limited to `withExperiment` and the `BLOCK_EDITORS` map; acceptable.
  `// @typecheck` on `cmsTranslate.js` not verified (no tsc run under the CPU rule).
- Entry budget: `App.jsx` imports `ProductWebsite` statically and `extraSections.ts` imports both
  sections, so all of it lands on the public entry: roughly 22 KB of new source (about 3 KB gzip
  JS) and about 3.7 KB raw of render-blocking CSS (under 1 KB gzip). That is a large part of the
  3% headroom on `blockingCssBytes`; not measured (no build). If `lint` entry-budget goes red,
  lazy-load `ScrollStory`/`Tour` (rarely used) rather than raise the budget.

Tests run, one at a time: `cmsBuilder/experiments.test.js` 4/4,
`core/seo/renderBlocksStory.test.js` 5/5,
`migrations/add-nl-hardcoded-website-admin-2026-10-translations.test.js` 5/5;
vitest (`--maxWorkers=2`): `experiment.test.ts` 11/11, `track.test.ts` 4/4,
`ScrollStory.test.tsx` 4/4, `Tour.test.tsx` 4/4, `ExperimentCard.test.tsx` 2/2,
`editors.test.js` 4/4.
