# Review FEAT #238 (Opus, read-only)

Commit 557887a57 "feat(cms): tabs block for several audiences in one section" (branch ts-bugs/feat-F1).
Tests: `node --test` cmsBuilder/tabsBlock.test.js 5/5, migrations/add-nl-cms-tabs-stories-translations.test.js 3/3,
migrations/nlCatalogues.test.js 460/460; vitest Tabs.test.tsx 7/7, tabsKeys.test.ts 3/3, TabsEditor.test.tsx 5/5,
editors.test.js 4/4. Server `npm run typecheck`: no errors.

## Verdict: APPROVE (one small a11y fix requested)

Checked and fine:
- Matches the issue: 2-6 tabs (TABS_MIN/TABS_MAX, validator warnings `tabs_count`, `tabs_empty_label`,
  `tabs_duplicate_id`), heading/text/media/CTA per tab, `?tab=` deep link (id or 1-based position),
  every tab's text in the pre-hydration HTML (the generic walker in renderBlocks emits label, title and
  body of every item; `tabId` and `media` are not emitted), translations per tab through the existing
  overrides (`tabId` ends in "Id" so it is never translated), `cms_add_blocks` picks it up from
  BLOCK_DEFAULTS/BLOCK_TYPES.
- WAI-ARIA tablist: `role="tab"`, `aria-selected`, `aria-controls` pointing at panels that always exist
  (hidden, not unmounted), `aria-labelledby` back, roving tabindex, Arrow/Home/End with wrap-around,
  focus moves with the selection. Inline editing in the preview is not swallowed by the key handler.
- `replaceState` keeps other query parameters (preview mode keeps working). The deep link is applied
  after mount, so the first client render matches the server markup.
- Dutch catalogue: every new `cms_site.blocks.tabs.*` key has Dutch; `DATA_SHA256` matches the data
  file (re-pinned correctly when #239 added to the same file); registered in bootMigrations and in
  SOLE_OWNER.
- Validator change is warnings only; nothing saved is rewritten.

## REQUIRED

1. `agent-hub/src/marketing/sections/Tabs.tsx:135` (Low, a11y): a text-only tab panel contains nothing
   focusable, so a keyboard user pressing Tab from the tablist skips the panel content and lands on the
   next control on the page. The WAI-ARIA tabs pattern asks for `tabIndex={0}` on the `tabpanel` in that
   case. Fix: add `tabIndex={0}` to the panel `div` (or only when the panel has no CTA), and a test
   assertion.

## Optional

1. `server/migrations/add-nl-cms-tabs-stories-translations.test.js:17`: `OWNED` matches
   `cms_site.blocks.tabs.*` and `cms_stories.*`, but the stories keys landed as
   `cms_site.blocks.customer_stories.*` and `cms_site.blocks.story_header.*` (#239). The completeness test
   therefore does not guard the stories keys (they are complete today, checked by hand). Widen the regex
   to `^cms_site\.blocks\.(tabs|customer_stories|story_header)\.`. Same stale `cms_stories.*` mention in
   the migration header comment (line 4).
2. Two tabs blocks on one page both react to the same `?tab=` value; documented in the code and
   harmless, but a per-block prefix would make the link unambiguous.
