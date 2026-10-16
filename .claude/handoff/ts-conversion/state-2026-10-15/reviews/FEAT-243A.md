# Review FEAT #243 part A (Opus, read-only)

Branch ts-bugs/feat-G3, commits 947670686 (integrations directory), 18436d8a1 (search index + blog
search), 465fb994f (Atom feed). #243 stays open (Refs, not Closes): scroll story / tour and A/B variants
are not part of this round.
Tests: `node --test` core/seo/integrationsDirectory.test.js 8/8, core/seo/searchIndex.test.js 4/4,
core/seo/blog.test.js 6/6, core/seo/blogAtom.test.js 3/3, migrations/add-nl-cms-blog-translations.test.js
4/4, migrations/nlCatalogues.test.js 454/454, routes/publicRender.validation.test.js 9/9; vitest
BlogSearch.test.tsx 5/5, BlogView.test.tsx 6/6. Server `npm run typecheck`: no errors.

## 947670686 integrations directory: APPROVE

- Source is only the static product catalogue (`INTEGRATION_CATALOG` plus the Nextcloud family, four
  fields each: id, name, description, category). No custom integrations, installed MCP servers, org
  settings or ids reach the page. Rendered only when the live site has a published snapshot; the site
  name comes from that snapshot.
- Every interpolated value goes through `esc()`, JSON-LD through `jsonForScript` (`<` escaped), the
  category in the breadcrumb link is URL-encoded and then escaped; the search query is capped at 80
  characters and only echoed escaped. Inline `<style>` is allowed by the site CSP; no script.
- Routing: CMS page slugs are single-segment, so `/integrations/<x>` can not collide with a CMS page
  slugged `integrations` (that page stays served by the catch-all), nor with the legal and legacy
  redirects, which match single-segment paths in the catch-all. An unknown id calls `next()`. The app
  routes integrations under `admin/...`, so no SPA route is shadowed.
- A filtered directory view is `noindex, follow`; the full list and every detail page are in the
  sitemap.

REQUIRED: none.

Optional:
1. `server/core/seo/integrationsDirectory.js:166`: the header nav always links `/integrations` and
   `/blog`. On a site without those pages they answer 410. Build the nav from the snapshot (link only
   slugs that exist, and `/blog` only when there are visible posts).
2. An unknown `/integrations/<id>` ends in the SPA shell with 200 (a soft 404). A 410 like the catch-all
   uses for unknown single-segment paths would tell crawlers to stop.

## 18436d8a1 search index + blog search: CHANGES REQUIRED

Checked and fine: pages come from the published snapshot only; the 404 page and `seo.noIndex` pages are
left out; in a translated locale only pages with a real translation (`hasTranslation`) are listed;
posts come from `getLatestPublishedPosts`, which honours draft and scheduled status; integrations only
in the default locale; locales that are not site locales answer 404; a store failure answers 503
through the error handler without the message. The client keeps only same-site paths from the index,
renders through React (no HTML injection), and the query never leaves the browser. The server-rendered
tag nav escapes labels and hrefs. New NL keys `cms_blog.search` and `search_none` have Dutch, hash
re-pinned.

REQUIRED:
1. `server/core/seo/searchIndex.js:59` with `server/routes/publicSearchIndexRender.js:41` (Medium):
   posts are not filtered the way pages are, which contradicts the module's own contract ("never a
   hidden or noindex page"):
   - a post with `seo.noIndex` is listed (the summary from `getLatestPublishedPosts` does not carry
     `seo`, so the check is not even possible today; the sitemap reads `snapshot.posts[id].seo` for it);
   - in a translated locale every visible post is listed with a `/nl/blog/<slug>` link, also when the
     post has no translation; that URL answers 301 to the default locale.
   Fix: in the route, read each post's `seo` from the snapshot (as `blogSitemap` does) and drop noindex
   posts; for a non-default locale keep only posts where `localesForPost(...)` includes the locale.
   Add both cases to searchIndex.test.js (today the test feeds pre-filtered posts through the seam, so
   neither is covered).

Optional:
1. The index holds pages and integrations, but the only UI (BlogSearch) searches `post` entries. Either
   wire a site search or say in the commit/docs that site search is index-only for now.
2. `limit: 50` makes older posts unsearchable on a larger blog; consider the full visible list (the
   index is capped at 300 entries anyway).
3. The 404 answers pass through nginx's `error_page 404 = @shell` mapping and reach the browser as the
   HTML shell with 200, so the comment "never falls through to the SPA" is not true in production. The
   client copes (JSON parse fails, search shows "no results"); same as the existing feed route.

## 465fb994f Atom feed: APPROVE

- Same posts and source as the RSS feed (published snapshot, visible posts only, the same locale
  checks: an unknown or default-prefixed locale answers 404).
- Valid Atom 1.0 shape: feed `id`/`title`/`updated`/`link rel=self`, per entry `id`, `title`,
  `updated`, `author`, `link rel=alternate`; categories, summary and `content type="html"`.
- Escaping: every value goes through `xmlText` (escapes and strips characters XML forbids); the post
  body is the escaped HTML from `renderPostMarkdown`, then XML-escaped as a whole; the cover alt is
  escaped inside it. `<link rel="alternate" type="application/atom+xml">` in the blog head is escaped.

REQUIRED: none.

Optional: `buildBlogHead` builds the Atom URL by hand (`${blogPath}/atom.xml`) while `blogAtom.atomPath`
exists; use the helper so the two can not drift.
