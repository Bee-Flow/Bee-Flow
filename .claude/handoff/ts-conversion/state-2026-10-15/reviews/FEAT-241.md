# Review FEAT #241, redirects manager (Opus, read-only)

Commit 3adbdca9e in the feat-F3 worktree.

Verdict: CHANGES REQUIRED. There is no open redirect. Two of the required items are correctness problems on the locale path, and two are about governance of the allow-list.

## Checked OK

- **Internal targets** (`core/seo/redirects.js:117-128`): the target has to start with one `/`. A leading `//`, a backslash anywhere, control characters, spaces and every non-ASCII character are refused, so unicode slash lookalikes are rejected too. Percent-encoded slashes (`%2F`, `%5C`) are accepted, but they stay encoded in `Location`, and browsers do not decode them when they resolve the target. The result stays same-origin.
- **External targets** (`:129-143`): the URL must be https and carry `external: true`. Credentials and an explicit port are refused. The host is compared with the allow-list after WHATWG parsing, so a suffix host, a trailing dot, an ideographic full stop and a Cyrillic lookalike all fail. The stored value is `url.href`.
- **Request query**: it is carried to site targets only (`siteRedirect.js:314-319`), through `URLSearchParams`, so CR/LF stay encoded. An external target keeps only its own query. A request fragment is carried by the browser itself, never by us. That is expected and not a leak.
- **`from`** is lower-case, has no query and no scheme, is not the homepage, and its first segment is not in `RESERVED_TOP_LEVEL`. Loops and chains are checked on write, and the list is flattened to one hop.
- **Allow-list**: no MCP tool can set it. `cms_set_redirect` passes only from/to/status/external, and it rejects unknown fields. Only `PUT …/redirects/hosts` changes the list, behind `requireAdmin`. When a host is removed from the list, its external entries are dropped because the list is re-sanitised.
- **Scoping**: the redirect routes sit under `/sites/:siteId` behind `requireAdmin` plus `attachSiteIdFromParam`. That is the same gate as every other CMS route. CMS sites belong to the instance, not to an org, so there is no org dimension to check here. The MCP side goes through `resolveSite` plus the dispatch scope and CMS-admin check.
- **Storage**: there is a separate config key, and `deleteProject` removes it with its `_%` sweep. Publish takes a snapshot of the sanitised list. Duplicate copies the list. Export carries no ids.
- **Tests**: each file passes when run alone: redirects 12/12, siteRedirect 4/4, store 12/12, MCP 4/4, cmsPageHandlers 7/7, publicRender.validation 7/7, nl migration 3/3. `RedirectsInspector.test.tsx` passes under vitest.

## REQUIRED

1. **Medium: a redirect loop is possible through the locale prefix.** Location: `core/seo/redirects.js:77-94` (`normalizeFrom`), `:152-161` (`resolveTarget`), `:260-277` (`findRedirect`).
   - At serve time, `findRedirect` strips a site locale and then matches the bare `from`.
   - The write-time loop check (`resolveTarget`) only does exact matches, and `normalizeFrom` accepts a `from` that starts with a locale (`/nl/...`, or `/nl` itself).
   - So an unprefixed entry and a locale-prefixed entry can be accepted one after the other and still form a cycle when they are served. I reproduced this with the module itself: the browser ends in "too many redirects".
   - A `from` of `/nl` also hides the Dutch homepage. The live-page guard does not catch that, because the bare slug it compares is `nl`, not `''`.
   - Fix: refuse a `from` whose first segment is a published locale prefix (`LOCALE_PREFIXES` or the site's locales). Every `/nl/x` request already reaches the `/x` entry. Add a test that forms the cycle and is refused.

2. **Low-medium: a redirect shadows live blog content.** Location: `core/seo/siteRedirect.js:307-312`, `routes/publicRender.js:348`.
   - The guard "a live page always wins" looks only at `snapshot.site.pages`. The redirect is answered before `parsed.blog` is handled.
   - A `from` of `/blog` or `/blog/<published-post>` therefore takes the blog index or a published post offline. The commit message promises that a redirect never does that to a page.
   - Fix (either one):
     - refuse a `from` under `BLOG_BASE` when it names the index or an existing post, or
     - extend the guard to the blog index and published post slugs.

3. **Medium: import widens the allow-list without an administrator choosing to.** Location: `stores/cms/exportImport.js:281`.
   - The import writes `redirectHosts` from the uploaded bundle into the new site's allow-list, together with the external entries that depend on it.
   - The feature's invariant is that only an administrator, in the admin UI, widens that list. An imported file (for example a template from someone else) now does this silently. After a publish, the redirects to those hosts go live.
   - Fix: on import, do not restore `redirectHosts`. Drop the external entries, or keep them only for hosts that the target site already allows. Report what was dropped in `warnings`, so the admin can add the hosts deliberately.
   - Duplicating a site on the same instance (`projects.js:414`) can keep copying the list.

4. **Low-medium: redirect writes are not audited.** Location: `cms/mcp/redirects.js:78-111`, `routes/cmsRedirects.js:52-68`.
   - Blog writes over MCP are audited (`cms.post.create.mcp`, ids and slugs only). `cms_set_redirect` and `cms_delete_redirect` are not.
   - The allow-list change (`PUT …/redirects/hosts`) is not audited either, and it is the one setting that decides whether an external redirect is possible at all.
   - Fix:
     - pass `deps.audit` into `createRedirectHandlers` and audit set and delete (siteId, redirect id, from, external flag, target host only);
     - audit the hosts PUT from the admin route (siteId, before and after host list).

## Optional

5. **`INTERNAL_RE` (`redirects.js:37`)** accepts dot segments and empty segments after the first character (`/./x`, `/.//x`). The browser keeps the result same-origin, but such a target is never legitimate. Rejecting `(^|/)\.\.?(/|$)` and `//` anywhere in the path removes the case where a later hop reflects a path that starts with `//`.
6. **Internal targets may point at application paths** (`/api/...`, `/logout`). This is admin-only and harmless today. Refusing reserved first segments for targets would match the rule for `from`.
7. **The `cmsStore.js` header** lists the config keys but not `cms_project_{siteId}_redirects`.
8. **`deletePageHandler`** keeps the old `res.status(400).json({ error: err.message })` pattern. This was already there before the commit, and it is not made worse.
