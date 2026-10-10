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
| Media | `cms_list_assets`, `cms_request_upload`, `cms_upload_status` |
| Check | `cms_screenshot` |
| Publish | `cms_publish`, `cms_set_live_site` (need the publishing scope) |

The page, block, navigation and design tools are the very tools the in-product
CMS builder uses, with the same validation, and every other write goes through the
same stores and validators as the admin panel. After an edit the result carries
`validation` warnings (an empty page, a link to a page that does not exist, a
low-contrast colour pair), and a rejected call carries a `_fixHint`.

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
size. At most 24 per ten minutes per user.

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

## Access control

All of these must pass:

1. `CMS_MCP_ENABLED=1` on the server.
2. A valid token that carries the `cms` server, from an address both its own IP list
   and the organisation's [MCP access policy](automations-mcp.md#organisation-policy)
   allow.
3. The token's user is a CMS administrator.
4. Per tool: the token's level and tool list, and for publishing the publishing scope.
