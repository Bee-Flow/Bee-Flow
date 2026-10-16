---
title: Editing the website from your editor (MCP)
---

# Editing the website from your editor (MCP)

Bee Flow can expose the **website CMS over MCP**, so a coding agent in your editor —
Claude Code, Cursor or any other MCP client — edits the whole product website in a
running Bee Flow instance: pages and blocks, header, footer, cookie banner,
announcement bar, translations and design. It can upload photos and videos from
your own disk, take screenshots of its work, and — only when you allow it —
publish.

It is the sibling of [Building apps from your editor](apps-mcp.md) and
[Building automations from your editor](automations-mcp.md), and it is off by
default.

## Turning it on

Set the flag on the API server:

```bash
CMS_MCP_ENABLED=1
```

While the variable is unset the route is never mounted and the module is never
loaded, so `/mcp/cms` simply does not exist. Only the exact value `1` switches it
on.

## Creating a token

Open **Settings → MCP tokens**, give the token a name and tick the `cms` server:

| Level | What the token can do |
| --- | --- |
| *read* | Look: list sites, read pages and settings, list assets, take screenshots. |
| *write* | Everything above plus edit the **draft**: pages, blocks, settings, translations, uploads, duplicate a site. |
| *write* + **Allow publishing** | Additionally `cms_publish` and `cms_set_live_site`: change what visitors see. |

Publishing is a separate switch and is off unless you tick it. A legacy
`bfmcp.…` token can edit but never publish, and gets no upload URLs: create a
named token in Settings → Security for that. The token can also be limited to a
list of tools, a list of IP ranges and an expiry; the token is shown once.

The user the token belongs to must be a CMS administrator — the same test the
admin panel uses. A token never does more to the website than its user could in
the admin panel.

## Wiring up Claude Code

```bash
claude mcp add --transport http beeflow-cms \
  https://your-bee-flow-host/mcp/cms \
  --header "Authorization: Bearer bfmcp_…"
```

## How editing works

A **site** in the CMS is a draft you edit. Only the **live** site is served to
visitors, and only its **published snapshot**: edits stay private until
`cms_publish`. Every tool takes an optional `siteId` and defaults to the live
site; `cms_duplicate_site` makes a new draft version to try a redesign without
touching the current draft.

| Area | Tools |
| --- | --- |
| Sites | `cms_list_sites`, `cms_duplicate_site`, `cms_list_templates` |
| Pages and blocks | `cms_list_site`, `cms_get_page`, `cms_create_page`, `cms_update_page_meta`, `cms_update_page_seo`, `cms_add_blocks`, `cms_update_block`, `cms_remove_block`, `cms_reorder_blocks`, `cms_set_homepage`, `cms_reorder_pages`, `cms_delete_page` |
| Site chrome | `cms_update_header_nav`, `cms_get_site_settings`, `cms_update_site_settings` (header, footer, cookie banner, announcement bar, Google Analytics id, site name), `cms_update_design` (colours, fonts, layout) |
| Translations | `cms_get_locale_overrides`, `cms_set_locale_override` |
| Blog | `cms_list_posts`, `cms_get_post`, `cms_create_post`, `cms_update_post`, `cms_delete_post`, `cms_set_post_translation`, `cms_update_blog_settings` (see [Blog posts](#blog-posts)) |
| Media | `cms_list_assets`, `cms_request_upload`, `cms_upload_status` |
| Check | `cms_screenshot` |
| Publish | `cms_publish`, `cms_set_live_site` (need the publishing scope) |

The page, block, navigation and design tools are the very tools the in-product
CMS builder uses, with the same validation, and every other write goes through the
same stores and validators as the admin panel. After an edit the result carries
`validation` warnings (an empty page, a link to a page that does not exist, a
low-contrast colour pair), and a rejected call carries a `_fixHint`.

## Tabs and customer stories

Two blocks you add with `cms_add_blocks` like any other (the block catalogue lists
them, with their default content):

- **`tabs`**: one section for several audiences ("for IT / Legal / DPO"). Two to six
  tabs in `items`, each `{ tabId, label, title, body, media, cta }` (`cta` is `null`
  or `{ label, link }`). All tab text is in the page HTML; `?tab=<tabId>` opens a
  tab. Send the complete `items` array: arrays replace wholesale.
- **Customer stories**: a story is an ordinary page that starts with a
  **`story-header`** block (`customer`, `sector`, `title`, `lead`, `logo`, `quote`,
  `quoteBy`, and two to four `metrics` of `{ stat, label }`; use the customer's real
  figures). `cms_create_page` with the built-in template `tpl_builtin_customer_story`
  (see `cms_list_templates`) seeds one. A **`customer-stories`** block shows every
  published story as a card with a sector filter, in page order, and lists them in
  the page HTML; the stories also sit in the sitemap and have translations like any
  page. A draft story never appears: cards come from the last `cms_publish`.

## Blog posts

Every site has a blog: the index at `/blog` (newest first, a tag filter at
`/blog?tag=…`, paging at `?page=2`), each post at `/blog/<slug>`, translations at
`/<locale>/blog/<slug>`, and an RSS feed at `/blog/feed.xml`. Posts appear in the
sitemap and carry their own search and social tags (`BlogPosting` structured data,
`og:type` article). A **Latest posts** block shows the newest posts on any page.

A post is a draft edit like everything else: it goes live with the next
`cms_publish`, and only when its status is `published` (or `scheduled` and its
`publishedAt` has passed — a scheduled post appears by itself on time, no second
publish needed). A `draft` post is never part of the published site.

| Tool | What it does |
| --- | --- |
| `cms_list_posts` | Posts newest first (no bodies), filterable by status, tag or a search word; also returns the blog page settings. |
| `cms_get_post` | One post in full by `postId` or `slug`, with its translations (or one language with `locale`). |
| `cms_create_post` | A new post; only `title` is required. Slug is derived and made unique. |
| `cms_update_post` | Change any field; `seo` is merged. The body is replaced whole with `body`, edited in place with `bodyEdits` (`[{find, replace}]`, each `find` must occur exactly once, up to 20 per call, all-or-nothing) or extended with `appendBody`. |
| `cms_delete_post` | Delete a post and its translations from the draft. |
| `cms_set_post_translation` | Replace one language's translation (`title`, `excerpt`, `body`, `coverAlt`, `seo.metaTitle`, `seo.metaDescription`); `remove: true` deletes it. Empty fields fall back to the original. |
| `cms_update_blog_settings` | The blog page heading and intro per language, and posts per page. |

**Body format.** The body is Markdown: `##` sections (the title is already the
page heading), bold, italic, lists, quotes, code, tables, links and images. Use the
asset URL from `cms_request_upload` / `cms_list_assets` for images. Raw HTML is shown
as text, never rendered, and only `https://`, `http://`, `mailto:` (links), site
paths, `#anchors` and asset URLs survive as links — a `javascript:` or `data:` URL
is dropped. Results carry `warnings` when that happens, or when a post lacks an
excerpt or an alt text. Limits: title 200 characters, excerpt 500, body 100,000,
10 tags, 1,000 posts per site.

**Author.** `authorName` is free text shown publicly ("By …"); it is not linked to an
account, and posts store no user id. Do not put an e-mail address in it.

Look at a post with `cms_screenshot {postSlug: "…"}` (in `draft` state any status is
shown, with a "Draft" badge) or at the index with `cms_screenshot {blog: true}`.

Creating and deleting a post are written to the access audit log
(`cms.post.create.mcp`, `cms.post.delete.mcp`) with the post id and slug only. Blog
writes have their own budget of 120 per ten minutes per user on top of the endpoint's
rate limit.

## Uploading photos and videos

The model never sees file contents. The flow is:

1. The agent calls `cms_request_upload` with the file name, the content type and the
   size in bytes.
2. The answer holds a one-time URL and a ready command, for example:

   ```bash
   curl -fS -T './hero.jpg' -H 'Content-Type: image/jpeg' \
     -H 'X-Upload-Ticket: …' 'https://your-bee-flow-host/mcp/cms/upload/…'
   ```

   The URL holds only a public ticket id; the secret half travels in the
   `X-Upload-Ticket` header, so it never ends up in a proxy access log. A user can
   hold at most 20 unused upload URLs at once.

3. The agent runs it in a shell. The server answers with the asset URL
   (`/api/cms/asset/cms/…`) which goes into a block. `cms_upload_status` reports
   the same afterwards, and `cms_list_assets` shows everything uploaded.

What is accepted: JPEG, PNG, GIF, WebP, APNG, SVG (sanitised on the server), MP4 and
WebM, and WebVTT captions. Images up to 25 MB, MP4/WebM up to 500 MB, captions up
to 1 MB. The URL works **once**, for 15 minutes, for exactly that content type and
at most that size; it is bound to the user, organisation and site that asked. The
file is streamed to disk, never held whole in memory, and the organisation's IP
allow-list is checked again when it arrives.

The standard frontend image already proxies `/mcp` and lets `PUT /mcp/cms/upload/`
through with a body of up to 512 MB, unbuffered. If you run your own reverse proxy or
ingress in front of Bee Flow instead, configure it the same way, as is done for
`/api/cms/admin/upload-clip`.

:::warning IP allow-lists need the proxy in front
The client address comes from the reverse proxy's `X-Forwarded-For`, peeled off
`TRUST_PROXY_HOPS` (default 1) hops deep. Point MCP clients at the public URL that goes
through the proxy, and make sure the server port itself (3101 / 3001) is not reachable
from outside: a client that talks to the server port directly can claim any address.
:::

## Screenshots

`cms_screenshot` renders a page the way a visitor sees it and returns it as an image
(longest side at most 1280 px), so the agent can look at what it built. Choose
`state` `draft` (your unpublished edits) or `published`, a `viewport` (`desktop`
1280 px, `tablet` 834 px, `mobile` 390 px), a `locale`, and `fullPage` for a
scaled-down overview of a long page or `offsetY` to look further down at full
size. At most 24 per ten minutes per user. For the blog, pass `postSlug` (one post)
or `blog: true` (the `/blog` index) instead of a page.

The page is rendered by the shared, network-isolated browser from the same
server-side pipeline that serves visitors, with the real site bundle, so React
hydrates exactly as it does for a visitor (with the cookie banner already
declined, so it does not cover the page). When the web front end cannot be
reached, the picture falls back to the server-rendered markup only (plain
styling), and the tool result says so. When no browser is available the tool
answers in one plain sentence instead of an image.

## Publishing

`cms_publish` freezes the draft of a site as its published snapshot; for the live
site visitors see it from then on (cached copies can lag a few minutes).
`cms_set_live_site` chooses which site is live, or takes the website offline with
`live: false`. Both need the **publishing** scope on the token, are hidden from
tokens without it, are refused if called anyway, and are written to the access
audit log (`cms.publish.mcp`, `cms.live.mcp`) with the token's name.

## Website analytics

Six read-only tools let the agent read how the website performs, so it can answer
"which pages are read" or "where do visitors come from" and then change the site
with that in mind:

| Tool | What you get |
|---|---|
| `cms_analytics_status` | Whether analytics is on, set up and tracking the site. |
| `cms_analytics_overview` | Visitors, pageviews, visits, bounce rate and average visit duration, each next to the previous period. |
| `cms_analytics_pageviews` | Pageviews and sessions over time (hourly or daily). |
| `cms_analytics_metrics` | A top list (up to 50) by page, landing page, referrer domain, channel, country, region, device, browser, OS, language, event name or UTM source, medium and campaign. |
| `cms_analytics_realtime` | Active visitors right now and the pages they are on, as counts. |
| `cms_analytics_vitals` | Core Web Vitals (LCP, INP, CLS, FCP, TTFB) and the slowest pages. |

Every tool takes an optional `siteId` (default: the live site) and a period:
`range` of `today`, `24h`, `7d` (default), `30d` or `90d`, or an explicit
`startAt` and `endAt` of at most 366 days. If analytics is switched off or not
configured, the tools say so in a sentence instead of failing.

**What is never exposed.** The numbers go to an external AI model, so only
aggregates leave: counts, rates, durations, page paths without the part after `?`
or `#`, referrer domains and event names. Individual sessions, session and visitor
ids, session replays, heatmap clicks, IP addresses, user-agent strings, full URLs,
event properties and cities are not in any result. Results are built from a fixed
list of fields, so a field the analytics service adds later is not passed along.
Anything that looks like an e-mail address inside a path or name is replaced.

**Who can use them.** Super administrators only, the same test as the analytics
dashboard. A CMS administrator who is not a super administrator does not see the
tools and is refused if one is called. They are read-only, so a token at the read
level has them; the token's tool list can narrow them like any other tool. Each
user may make 60 analytics calls per 10 minutes.

## Access control

All of these must pass:

1. `CMS_MCP_ENABLED=1` on the server.
2. A valid token that carries the `cms` server, from an address both its own IP list
   and the organisation's [MCP access policy](automations-mcp.md#organisation-policy)
   allow.
3. The token's user is a CMS administrator.
4. Per tool: the token's level and tool list, and for publishing the publishing scope.
5. For the analytics tools: the token's user is a super administrator.
