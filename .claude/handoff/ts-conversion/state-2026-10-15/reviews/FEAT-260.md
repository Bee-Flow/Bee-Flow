# Review FEAT #260 (Opus, read-only)

## Review of 40ee5f35a (Opus, read-only, security focus)

**Verdict: APPROVE** (no required changes; the notes below are non-blocking follow-ups)

### Findings (non-blocking)

1. `server/core/cms/linkProbe.js:31-37,48-50` (low). `requestable()` (scheme, port allow-list, no
   userinfo) only covers the first URL. The probe uses `redirect: 'follow'`, so later hops are held
   only to undici's http(s)-only redirect rule and the safeFetch address guard. Private targets are
   still refused on every hop, but a public host can send the probe on to a non-standard port of
   another public host. Fix: use `redirect: 'manual'` with a small hop limit (for example 5), and run
   `requestable()` plus `safeFetch` on each `Location`.
2. `agent-hub/src/components/admin/product-website/panel/publishLinkCheck.ts:24-36` (low). The
   comment promises that a slow check never blocks Publish, but the pre-check request has no
   timeout. If the server hangs, the Publish click hangs too. Fix: pass
   `signal: AbortSignal.timeout(~8000)` and treat an abort as "no problems", as the catch already does.
3. `server/routes/cmsLinkCheck.js:26-27` and `server/cms/mcp/linkHandlers.js:16-17` (low). The
   external budget is 5 runs per 10 minutes, kept separately for the REST route and the MCP tool, and
   per user and per replica (unnamed limiter, in memory). One admin can therefore start up to 10 runs
   of 50 URLs. Nothing caps how many external runs the instance has in flight at once. Acceptable for
   an admin-only action. Optional fix: one named limiter shared by both entry points.
4. Tests (low). No test covers the route itself: admin gate, choice between the internal and
   external limiter, and the audit fields. The probe tests use a fake fetch, which is fine because the
   guard has its own tests.

### Checked and fine

- SSRF: every probe request goes through `utils/ssrfGuard.safeFetch`, which screens the hostname
  literal before the request and then checks DNS answers (any private answer refuses) and the
  connected peer on every connection. Because each redirect opens a new connection, this also covers
  DNS rebinding and redirect hops. The canonical table covers loopback, RFC 1918, link-local, CGNAT,
  0/8, ULA, fe80::/10 and IPv4-mapped IPv6. Refusals are reported as `external_refused` and are never
  retried with GET.
- No body is read: `res.body?.cancel()` after each request, HEAD first, and a GET with
  `Range: bytes=0-0` only when HEAD fails. Only the status is used.
- Limits: at most 50 unique URLs per run (the rest are counted as `skipped`), concurrency 4, a 5 s
  `AbortSignal.timeout` per request that covers the whole redirect chain, and at most 5000 links
  collected per site.
- Access: the REST route is mounted under `/sites` after `requireAdmin` and `attachSiteIdFromParam`.
  The MCP tool goes through `callTool`, which checks the token scope and `deps.isAdmin` before any
  handler runs. `external` is accepted only as a strict `true`, unknown fields are rejected, and the
  site is resolved through `resolveSite`.
- Audit: counts only (external flag, number of URLs checked, errors, warnings), never a URL. Results
  go back to the caller only, with the query string and fragment removed (`bareUrl`).
- Nothing personal goes outbound: no cookies (undici has no cookie store), no Authorization header,
  no Referer, no instance URL. The headers are a generic `BeeFlow-LinkCheck/1.0` UA, `accept`, and
  `range` on the GET.
- Publish is never blocked: on MCP, `withLinkWarnings` runs after the publish has happened and only
  logs on failure. In the UI, `fetchLinkErrors` returns `[]` on any error or on a non-JSON or 429
  answer, so only real broken links lead to a confirmation, which the admin can accept.
- Tests run one at a time: `linkProbe` 5/5, `linkCheck` 3/3, `linkReport` 2/2, `linkHandlers` 4/4,
  `publishLinkCheck` (vitest) 4/4.
