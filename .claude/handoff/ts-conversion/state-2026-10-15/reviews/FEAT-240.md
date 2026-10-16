# FEAT-240 security and privacy review: CMS form block that starts an automation

Commit `efe1c9a53` (worktree `Bee-Flow-wt/feat-F2`), issue #240. Review done read-only.

**Verdict: CHANGES REQUIRED** (findings 1 to 4; the rest can follow up).

Tests: `node --test server/routes/cmsForms.test.js server/core/cms/websiteForms.test.js`: 21 pass, 0 fail.

## What holds up

- **Scope chain (IDOR).** `resolveTarget` (`routes/cmsForms.js:149-164`) starts from the live site id and that site's PUBLISHED snapshot. The automation id comes from the block, never from the request. It then requires an allow-list entry, an automation that is not trashed (`getAutomation` filters `deleted_at`), active and not a draft, an organisation that matches the entry, and a webhook trigger in the LIVE definition. Every miss gives the same 404. A visitor cannot reach a draft block, another site, a non-allow-listed or inactive automation, or one that moved organisation. The allow-list sits in its own config key, which no block or MCP tool can write.
- **Input shape.** Only fields the block declares are read. Names must match `PARAM_NAME_RE` (they start with a letter, so no `__proto__` or `constructor`). `coerceSubmission` builds `values` on `Object.create(null)` and reads only own properties. Values are coerced and length-capped, and the field types are limited to a subset. The envelope is closed (zod). Spreading `answers` with a `__proto__` key gives an own property, not prototype pollution.
- **Trusted fields.** The server builds `trigger.headers` itself (`source`, ids, timestamp, consent). The visitor's request headers are never copied, so a form run cannot fake `x-*` headers, and a signed webhook caller cannot fake `source: cms_form`.
- **Privacy.** No IP or user agent goes into the payload, the headers or the logs. The analytics event names the form and block, never the contents. Nothing goes to third parties.
- **Crawler output.** `renderBlocks` escapes everything. `fields` and `automationId` are not emitted (there is a test for this).
- **Admin list.** It only returns automations of the caller's organisation. Enabled ids of other organisations are never shown.

## Findings

### 1. Real submissions are silently dropped after a server-side validation error or a 429 (Medium)
`server/routes/cmsForms.js:191-201`, `agent-hub/src/marketing/sections/useFormSubmission.ts:38,52-62`.
The replay nonce is stored BEFORE `validateSubmission` and before the in-flight cap. The client keeps the same nonce after a 400 (`invalid`), a 429 or a `failed` outcome, and only renews it on 403. When the visitor fixes the answer and sends again, the server sees a known nonce and answers 200 `duplicate`. The client shows the thank-you state and nothing runs. The client checks only required and email, so server-only rules (select options, lengths, types) reach this path.
**Fix:** store the nonce only after validation and the capacity check pass, just before scheduling the run. Also have the client generate a new nonce after every outcome other than `done`.

### 2. The silent 200 for the minimum form age swallows quick retries, and drops are not counted (Medium)
`server/routes/cmsForms.js:186-189`, `useFormSubmission.ts:56-60`, `FormBody.tsx:36-39`.
After a 403 (`expired`) the client fetches a fresh token (`issuedAt` = now) and shows an error. A visitor who clicks Send again within 2 s gets the silent 200 and a thank-you, and nothing runs. The honeypot is named `website_url`, a name that browser autofill and form-filler extensions may fill despite `autocomplete="off"`. That drop is just as silent. Neither drop is logged or counted, so an admin cannot see that leads are going missing (review point 9).
**Fix:** before sending, the client waits until `issuedAt + MIN_FORM_AGE_MS`. It knows `issuedAt`, so the server's answer does not change and probes learn nothing new. Give the honeypot a non-semantic name. Count both kinds of silent drop per block in a metric that carries no personal data, and show the number in the Destination card or the CMS analytics.

### 3. The per-form rate limit is spent by page views: the form switches off under normal traffic and is easy to deny (Medium)
`server/routes/cmsForms.js:128-137,166`, `useFormSubmission.ts:45-50`.
GET (the token fetch, made on every render of the form) and POST share the same per-form budget (60/min) and per-IP budget (10/min). A landing page with more than 60 views a minute makes the GET return 429. The client then shows the form as `unavailable` to everyone. Six addresses are enough to keep any form offline on purpose. Both limiters are unnamed, so they are in memory per replica: the real ceiling is the limit times the number of replicas.
**Fix:** use separate limiters for GET and POST. Keep the per-form limit on POST only, and give GET a per-IP budget. Name the limiters so Redis makes them fleet-wide. On a GET 429, the client could retry with a delay instead of showing the form as unavailable.

### 4. The admin enable route checks less than the automation routes do (Medium)
`server/routes/cmsForms.js:244,255-266`.
- It reads the organisation from `req.session.user.organizationId`. `automation/access.js` explicitly reads it fresh from `users`, because a moved user still carries the old one in the session.
- Any CMS admin (`canAdminCms`: role `admin` or permission `all`) can enable ANY automation of the organisation, including another member's private one, without a role on that automation. The run then executes as the owner, with the owner's connections, on anonymous input. The automation routes require owner or edit access, or `manage_automations` (`makeAutomationAccess`).
- The comparison uses the stored `organizationId` only. A null-org automation matches any admin without an organisation, while `access.js` falls back to the owner's organisation.
- `kind` is not checked on PUT (the list filters it).
- Enable and disable are not audited.
**Fix:** decide with `makeAutomationAccess(...)` (owner, edit, or org admin with `manage_automations`), take the organisation from the users row, refuse `kind !== 'automation'`, and write an audit event that records who enabled what.

### 5. The allow-list covers an automation, not a form (Low/Medium)
`server/stores/cms/formAutomations.js`, `routes/cmsForms.js:154-160`.
Once an automation is enabled, ANY published form block can point at it with any field list it likes. That includes blocks written through the CMS MCP tools by a token that holds `cms.publish`. The webhook trigger was designed for HMAC-signed callers, so an automation may treat `trigger.output.<x>` as trusted. The author of a site block chooses the keys that reach it.
**Fix:** bind the entry to the block ids, or to a field contract that the admin approves. In the Destination card, list which published blocks target each automation. Document in the automation guide that form runs have `trigger.headers.source = 'cms_form'` and that their payload is untrusted.

### 6. The consent audit trail can record wording the visitor did not see (Low, privacy)
`server/routes/cmsForms.js:203-211`, `server/core/cms/websiteForms.js:356-360`.
`consent_text` is taken from the base snapshot. The consent text is a string field that the locale overrides translate (`core/cms/cmsTranslate.js` collects every text leaf), so a visitor on `/nl` sees Dutch while the record stores English.
**Fix:** the client sends the locale. The server resolves the override text for that locale and records the locale together with the text.

### 7. The "replay nonce" is deduplication, not replay protection (Low)
`server/routes/cmsForms.js:58-60,191-194`.
The visitor chooses the nonce, and it is optional. One token can be sent again and again for its whole 30-minute TTL, up to the rate limits. The token also uses the generic `csrf` purpose of `publicShareToken`, shared with the share-unlock CSRF. Only the `cmsform:` scope prefix keeps them apart.
**Fix:** either describe it as double-submit protection in the header comment and the PR, or put a server-issued nonce inside the signed token, make it required and single-use. Give the token its own purpose (`cmsform`).

### 8. Lost updates on the allow-list (Low)
`server/stores/cms/formAutomations.js:472-484`.
The whole map is read, modified and written back to one config row. Two concurrent PUTs can lose one change, and a disable can be undone by a parallel enable.
**Fix:** an atomic jsonb update (`jsonb_set` or `-`) or one row per automation.

### 9. The Origin check compares against Host (Low, availability)
`server/routes/cmsForms.js:77-85`.
The global middleware (`boot/httpMiddleware.js`) already refuses every Origin outside `CORS_ORIGIN`. The extra Host comparison breaks split-origin setups (site and API on different hosts) and proxies that rewrite Host, without adding anything against an anonymous attacker. No cookies are involved, so CSRF in the classic sense does not apply.
**Fix:** reuse `isAllowedOrigin`, or compare against the configured public origin.

### 10. The 32 KB cap is only a check on the header (Low)
`server/routes/cmsForms.js:138-142`.
The global `express.json({ limit: '20mb' })` has already parsed the body when `sizeGuard` runs, and a chunked request without `Content-Length` passes.
**Fix:** after parsing, check `Buffer.byteLength(req.rawBody)`, or exclude `/api/cms/forms` from the global parser and mount a 32 KB parser on this router.

### 11. Info
- **Per-IP limit and proxies.** `trust proxy` is `TRUST_PROXY_HOPS`, default 1. A deployment with no proxy in front lets a client pick its own `req.ip` through `X-Forwarded-For`. With two proxies, every visitor shares one bucket (10/min, see finding 3). Document this for the new public endpoint.
- **Logs.** `routes/cmsForms.js:217` logs `e.message` of a failed run. A step error can repeat visitor input. Log the automation id and an error code only.
- **In-flight cap.** `MAX_PENDING_PER_AUTOMATION` applies per replica, and only for as long as `executeAutomation` keeps its promise open. If the runner ever queues and returns early, the cap stops working. Worth a line in the comment.
- **Public automation id.** The published snapshot that the public site API returns contains the `automationId`. It is not exploitable (the allow-list decides), but the public renderer does not need it, and stripping it from the public read would be tidier.

## Round 2: re-review of `4a960a027` (amended)

Read-only. Tests: `node --test server/routes/cmsForms.test.js server/core/cms/websiteForms.test.js`: 30 pass, 0 fail. CORS regression checks: `boot/bootChain.characterisation.test.js` 16 pass and `index.errorHandler.test.js` 33 pass. `stores/cms/formAutomations.js` and `stores/cms/formDrops.js` have no tests of their own (see R2-4).

**Verdict: APPROVE.** Findings 1 to 4 are fixed. Findings 5 to 11 are fixed or acceptably addressed. The new findings below are Low or Info and can follow up.

### Status of the round-1 findings

| # | Status | Evidence |
|---|--------|----------|
| 1 | Fixed | The nonce is checked and stored last, after token, bot signals, format, `validateSubmission` and the in-flight cap, right before `setImmediate` (`routes/cmsForms.js` POST). The client makes a new nonce after every outcome except `done` (`useFormSubmission.ts` `react`). |
| 2 | Fixed | GET returns `serverNow`. `fetchFormToken` computes `readyAt` from `issuedAt + MIN_FORM_AGE_MS + 250 ms - serverNow`, on the local clock from the moment the response arrives, and `submit` waits until then. The honeypot is now `ref_code_2` (server and client constant). Both silent drops call `countDrop(blockId, kind)`, which stores counts only (`stores/cms/formDrops.js`). The admin GET shows them per block. |
| 3 | Fixed | Three named limiters: `cms-form-token` (GET, per IP, 120/min), `cms-form-submit-ip` (POST, 10/min) and `cms-form-submit-form` (POST, 60/min per block). The names put them in Redis. The client retries a GET 429 twice, 3 s apart, before it shows the form as unavailable. |
| 4 | Fixed | `editableAutomation` (`routes/cmsFormsAdmin.js`) needs `kind === 'automation'`. It reads the caller's organisation fresh (`userStore.getUser`), compares it with `access.organisationOf` (its own org, else the owner's), refuses a null organisation (`!mine`) and requires `canAccessAutomation(..., 'edit')` (owner, edit share, or `manage_automations` in the same org). Every miss is a 404. Enable, disable and block approval are each audited via `logAccessAudit` with actor, target, before and after. The router sits behind `router.use('/admin', requireAdmin)`, so CMS admin AND automation edit rights are both needed. |
| 5 | Partly fixed | The entry carries `blockIds`, and `resolveTarget` requires the PUBLISHED block's id in it. Approval requires automation edit rights and a draft block that really targets this automation. A CMS editor without automation rights cannot approve. Residual: see R2-1. |
| 6 | Fixed | The client sends `locale`. `consentFor` reads `pageLocaleOverrides[pageId][loc].blocks[blockId].content.consent.text`, the same shape `stores/cms/effective.js` merges, and records `consent_locale`. A small gap remains: R2-3. |
| 7 | Fixed (option a) | Described as double-submit protection in the header. The token has its own purpose `cmsform` (`issueCmsFormToken` / `verifyCmsFormToken`), so a share CSRF token no longer verifies. |
| 8 | Fixed | One row per automation (`cms_form_automation:<id>`). Enable and approve go through `mutateConfig` (advisory lock per key). A small race remains: R2-2. |
| 9 | Fixed, no regression | `server/utils/allowedOrigins.js` is a byte-for-byte extraction of the old parse and test. `applyCors` keeps the same `ALLOWED_ORIGINS`, the same single-argument `isAllowedOrigin` in its return value, the same early 403 and the same `cors()` options. The route check is now the same test the global gate already applies before routing, so it adds nothing and breaks no split-origin setup. |
| 10 | Fixed | `sizeGuard` measures `Buffer.byteLength(req.rawBody)`, which the global parser's `verify` sets, so a chunked body is caught too. The 20 MB parse itself still happens first. That is accepted: the limits and the global cap bound it. |
| 11 | Fixed | A failed run logs `run failed for automation <id>` only. There is a test with an e-mail address in the error. The header documents the proxy-hop caveat and the per-replica in-flight cap. |

### Regression hunt

- **Shared origin helper vs global CORS:** no behaviour change (see 9).
- **Drop counter as a write vector:** a drop needs a valid token (GET, 120/min per IP) and sits behind both submit limiters. The key space is bounded by the published form blocks (`findFormBlock` must succeed first). The cost is one locked transaction per drop, at most 60/min per form. Not a DoS vector. See R2-5 for a cheap improvement.
- **Draft approval list:** approving a draft block grants nothing by itself. At run time the PUBLISHED block must carry the same id AND name the same automation, and the automation must still be active, webhook-triggered and in the entry's organisation. Pre-approving before publishing is safe.
- **Admin router mount:** it is mounted after `requireAdmin` and before `attachSiteId`, defines only `/form-automations...` paths, and lets other `/admin` paths through. The public `/forms` router is outside `/admin`.

### New findings

#### R2-1. The approval binds a block id the editor chooses, not the block's contract (Low)
`stores/cms/pages.js:104` keeps a client-supplied `block.id`, and `findFormBlock` takes the first page that holds that id. After an approval, anyone who can edit the site (CMS admin, or an MCP token with CMS write and publish) can rewrite the approved block's field list, or place a block with the same id on another page, and publish without a new approval. The header of `formAutomations.js` ("the author of a site block cannot point a new block at an enabled automation by themselves") holds for NEW ids only.
**Follow-up:** store a fingerprint with the approval (sorted field id, type and required, plus whether consent is required). Have `resolveTarget` compare it against the published block, and treat a mismatch as unapproved. Show "changed since approval" in the Destination card. At minimum, soften the header comment.

#### R2-2. `setBlockApproved` can delete a concurrent enable (Low, fails closed)
When the entry is missing, the mutator returns `null`, `mutateConfig` writes the string `null`, and then `deleteConfig` runs outside the lock. An enable that lands between the two is deleted, while its audit row says "enabled". The route checks `has()` first, so this only happens in a race with a disable. **Follow-up:** delete inside the same locked transaction, or have the mutator return the current value unchanged and leave the row alone.

#### R2-3. The consent locale rules differ slightly from the renderer's (Info, privacy)
`consentFor` accepts `^[a-z]{2,3}$` only. The renderer (`effective.js`) also falls back from `pt-br` to `pt` and applies no override for the default locale. Today `LOCALE_PREFIXES` is `{'nl'}`, so this has no effect. Once regional locales exist, the recorded text could differ from what the visitor saw. **Follow-up:** resolve it through the same helper as the renderer.

#### R2-4. The new stores have no tests (Info)
`formAutomations.js` (asEntry hardening, the enable that keeps approvals, approve and withdraw) and `formDrops.js` (count clamping, the error that is swallowed) are covered only through route-level fakes.

#### R2-5. Drop counter and the per-form budget (Info)
`mutateConfig` broadcasts a cache invalidation to every replica on each drop, although `getFormDrops` reads through `getConfigsByKeys` (uncached). A plain `INSERT ... ON CONFLICT DO UPDATE` with a jsonb increment, without the NOTIFY, would be lighter. Bot drops also spend the 60/min per-form submit budget. Six IPs can still keep a form at 429 for real visitors: this is the trade-off of finding 3's design, and it is now bounded to the submit path. Consider counting only the submissions that pass the bot checks against the per-form limiter.

#### R2-6. Approved blocks that left the draft are not visible (Info)
The admin list comes from the DRAFT pages. A block that is still published and approved but was removed from the draft no longer shows in the card, so its approval can only be withdrawn by disabling the whole automation. **Follow-up:** list the entry's `blockIds` that the draft no longer contains as "published only".
