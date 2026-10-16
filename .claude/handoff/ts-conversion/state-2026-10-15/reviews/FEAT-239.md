# Review FEAT #239 (Opus, read-only)

Commit 1bc59de2a "feat(cms): customer stories, case-study pages with a card grid" (branch ts-bugs/feat-F1).
Tests: `node --test` stores/cms/stories.test.js 8/8, routes/cmsStories.test.js 2/2,
cmsBuilder/storyBlocks.test.js 3/3, routes/cmsPageHandlers.test.js 6/6, cms/mcp/dispatch.test.js 45/45,
migrations/nlCatalogues.test.js 460/460; vitest CustomerStories 5/5, StoryHeader 4/4, storyCards 6/6,
StoryEditors 4/4. Server `npm run typecheck`: no errors.

## Verdict: CHANGES REQUIRED

Checked and fine:
- Published only: `getPublishedStories` reads the last published snapshot of the live site
  (`getLiveSiteId`), never a draft; the homepage and the 404 page are skipped; the test proves a draft
  story stays invisible until publish and that an edit needs a publish.
- Allow-list: each card is built field by field from the header (`storyCard`), text is cleaned and
  length-capped, logos are limited to own CMS assets or https URLs. Card ids are page ids, which the
  public `/api/cms/site` payload already carries, so nothing new is exposed.
- Escaping: the server-rendered cards go through `renderBlocks` (`esc`), the bootstrap state through
  `jsonForScript`; the test checks markup in a customer name is escaped. Card links are `/<slug>` paths,
  so the walker turns them into real `<a>` links for crawlers.
- `fillCustomerStories` mutates only the per-request copy (`resolveEffective` clones every block), never
  the cached snapshot; it is fail-soft.
- Built-in template: code, not data. `saveTemplate`/`deleteTemplate` only touch stored rows, so it can
  not be overwritten or deleted and is never written to the config table (tested). It is listed first
  in REST and MCP with `builtin: true` (an extra optional field, listing shape unchanged), apply
  regenerates block ids, and the editor hides its delete button.
- Dutch: all 48 new `cms_site.blocks.*` keys of both commits have Dutch, data hash re-pinned.

## REQUIRED

1. `server/stores/cms/stories.js:110` with `:162` and `:167` (Medium, wrong result): `sectorId` is
   computed from the LOCALE-MERGED header, but the grid block's `sectorId` is never translated (it ends
   in "Id"). As soon as a story's sector is translated ("Public sector" to its Dutch word), a grid pinned
   to `public-sector` shows that story in English and drops it on the Dutch page; the `?sector=` API
   filter has the same problem. Fix: derive `sectorId` from the default-language header (the
   un-localized `doc.blocks`), keep only the visible `sector` label localized, and add a test with a
   translated sector and a pinned grid.
2. `server/stores/cms/stories.js:161` and `:165` (Low-Medium, SEO): a page counts as translated as soon
   as ANY override object exists, while `publicRender` uses `hasTranslation` (core/seo/locales.js) and
   redirects `/nl/<slug>` to the default URL for an empty shell override (an editor who opened the
   language and typed nothing). Cards then advertise a `/nl/...` link that answers 301, and also for a
   locale that is not in the site's locale list. Fix: use `hasTranslation(override)` and the site locale
   list (`localesForPage`), the same source as hreflang, sitemap and the redirect, so the three cannot
   disagree; test with an empty override.
3. `server/stores/cms/stories.js:160` (Low-Medium): a published page with `seo.noIndex` is still listed
   as a story card (with a crawlable link), while the sitemap and the new search index leave such pages
   out. Fix: skip `doc.seo?.noIndex` pages in `getPublishedStories` (or document a deliberate choice in
   the block hint), with a test.

## Optional

1. `agent-hub/src/marketing/sections/CustomerStories.tsx:96` hard-codes the cap 24; the server has
   `STORY_GRID_MAX`. Fine today, but a shared constant (or trusting the server clamp) avoids drift.
2. `URL_LOCALES` in stories.js mirrors `LOCALE_PREFIXES` by hand; importing it from
   `core/seo/publicPath.js` keeps one source.
3. `deleteTemplate('tpl_builtin_customer_story')` over REST answers `success: true` and does nothing; a
   400 "built-in templates can not be deleted" would be clearer for API and MCP clients.
4. The built-in template's name and description are English only in a Dutch admin.
5. In the server-rendered card the story title appears twice (as heading and as link text); harmless
   for crawlers, but the heading could be dropped when the link carries it.
