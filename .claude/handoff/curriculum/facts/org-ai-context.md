# Fact sheet — `org-ai-context` (Conversation Memory + Answer Reuse)

**Audience:** organisation admins.
**Status:** EXISTS and is fully built (backend + UI + tests). Two separate org-level switches that
live next to each other in the Organisation settings menu.
**Date of survey:** 2026-09-14, branch `claude/builder-redesign-fase-1-6sun0h`.

Source of truth read for this sheet:

| What | File |
|---|---|
| Compaction policy (storage, defaults, clamps, context windows) | `server/core/llm/contextPolicy.js` |
| The lossy compaction algorithm itself | `server/core/llm/compaction.js` |
| Conversation Memory API | `server/routes/orgAiContext.js` |
| Conversation Memory screen | `agent-hub/src/components/admin/org/OrgAiContextEditor.jsx` |
| Answer Reuse policy | `server/core/automationRunner/integrationCachePolicy.js` |
| Answer Reuse API | `server/routes/orgIntegrationCache.js` |
| Answer Reuse storage (HMAC key, encryption, quotas) | `server/stores/integrationCacheStore.js` |
| Answer Reuse screen | `agent-hub/src/components/admin/org/OrgIntegrationCacheEditor.jsx` |
| Menu entries | `agent-hub/src/components/admin/org/orgInfo/orgInfoShared.jsx` (`SECTIONS`) |
| Panel mounting | `agent-hub/src/components/admin/org/OrgInfoPanel.jsx` (lines 620–640) |
| All UI strings | `agent-hub/src/i18n/en-defaults.js` lines 1685–1725 |
| Step-level tick | `agent-hub/src/components/automation/Builder/flow/settings/actionEditors.jsx` (`AskOnceRow`, line 1070) |
| Lossless provider-side context editing | `server/core/providers/claude.js` lines 745–830 |

---

## 1. What the feature is for

Both switches answer the same shape of question — *how much may Bee Flow keep, and for how long?* —
but in two different places.

**Conversation Memory** decides how much of a long chat the model still sees. Historically Bee Flow
folded everything older than the 16th message into a ~200-word summary, unconditionally. On a model
with a 1M-token context window that is pure loss, and it is exactly what people report as "the
assistant forgot what we discussed". So local compaction is now **opt-in per organisation, default
OFF**, and the lossless provider-side mechanism (Anthropic `context_management`) carries the load
instead. A **Safety limit** slider defends the hard ceiling in both modes.

**Answer Reuse** decides whether the answers automations get back from connected apps and web services
may be **stored in the database between runs**. That is a data-processing decision, not a performance
tweak — a Gmail search result is somebody's mail — so it belongs to an org admin, is **off by
default**, and leaves a config row recording that a human said yes.

Neither is a premium feature. Neither route calls `requireLicenseFeature` or `hasFeature`.

---

## 2. Screens, with real labels

### 2.1 Getting there

Settings → left nav item **Organisation** (an accordion with a chevron; clicking it expands and
auto-selects the first sub-item, **License & Usage**, or **Sign-in Method** on self-host) → the
sub-item list. The two entries of this area are, in menu order:

- **Conversation Memory** (`settings.ai_context`, Brain icon, amber `#f59e0b`)
- **Answer Reuse** (`settings.integration_cache`, DatabaseZap icon, cyan `#06b6d4`)

They sit between **Encryption** and **Organisation Info** in the sidebar
(`SECTIONS`: License & Usage, Sign-in Method, Privacy Shield, Encryption, **Conversation Memory**,
**Answer Reuse**, Organisation Info).

**Both sub-items are visible only to org admins.** `orgSubItems` in `AdvancedSettings.jsx` drops
every org entry except Compliance when `canSeeOrg` is false.

> **Known wart — no deep link.** `ai_context` and `integration_cache` are missing from
> `SETTINGS_ORG_ID_TO_URL` (`agent-hub/src/authedApp/settingsRoutes.js` line 86). Clicking either
> pushes the bare address `/app/settings`, so the panel opens but **a reload or a shared link lands
> back on Preferences**. There is a test that pins this as intentional-for-now:
> `AdvancedSettings.test.jsx` — *"gives the two sub-items with no address no address (wart)"*.
> Never write a lesson step that says "go to `/app/settings/organisation/ai-context`" — that URL
> does not exist.

### 2.2 Screen: Conversation Memory

| Element | Exact text |
|---|---|
| Sidebar entry | `Conversation Memory` |
| Heading (H2, Brain icon) | `Conversation memory` |
| Intro | `How much of a long conversation the assistant keeps in view. Applies to chats and agents across the whole organisation and takes effect on the next message.` |
| Choice card 1 (Brain) | `Keep the full conversation (recommended)` |
| … its description | `The assistant sees every earlier message, tool result and attachment for as long as they fit in the model context window. Best answers; higher token use on very long chats.` |
| Choice card 2 (AlertTriangle) | `Summarise older messages` |
| … its description | `Once a chat passes about 16 messages, everything older is replaced by a short summary and long tool results are shortened. Cheaper, but detail from earlier in the conversation is permanently lost to the assistant.` |
| Slider label | `Safety limit` |
| Slider note | `A conversation can never overflow the model: once it reaches this share of the context window, the oldest part is summarised automatically.` |
| Slider readout | `75%` (right-aligned, tabular) |
| Worked examples line | `Claude Sonnet 5 → ~750,000 tokens   ·   Claude Haiku 4.5 → ~150,000 tokens` (recomputed live as the slider moves) |
| Buttons | `Save` (disabled until dirty; reads `Saving...` while in flight) and `Cancel` (appears only when dirty) |
| Loading state | `Loading...` with a spinner |
| Load-failure banner (red) | `Could not load conversation memory settings.` + the raw error |
| Success toast | `Conversation memory settings saved` |
| Failure toast | `Could not save conversation memory settings` |

There is **no empty state** — an unconfigured org simply renders the defaults (card 1 selected,
slider at 75%). The API returns `configured: false` so a lesson check can tell "never touched" from
"explicitly left off".

The screen deliberately exposes only **two** controls. `compactionThreshold` (16) and `recentWindow`
(8) are read from the server and sent straight back unchanged — an admin cannot edit them in the UI.

### 2.3 Screen: Answer Reuse

| Element | Exact text |
|---|---|
| Sidebar entry | `Answer Reuse` |
| Heading (H2, DatabaseZap icon) | `Reusing answers between runs` |
| Intro | `Automations often ask an app the same question over and over. This decides whether the answer may be stored so a later run can use it — which means storing what the app sent back.` |
| Kill-switch banner (amber, only when the env flag is set) | `This is switched off for the whole server by its operator, so nothing is stored whatever you choose here.` |
| Choice card 1 (DatabaseZap) | `Ask every run (recommended)` |
| … its description | `Nothing an app answers is stored. An automation can still avoid asking the same thing twice inside one run — that reuse never leaves the run.` |
| Choice card 2 (Timer) | `Keep answers for a short while` |
| … its description | `Answers to look-ups are stored, encrypted, so a later run can use them instead of asking again. Only look-ups, never anything that changes something, and only for steps whose author asked for it. Faster and cheaper — but a run can then work from data that is a few minutes old.` |
| Scope block heading (only when ON) | `What may be kept` |
| Scope note | `These are two different promises. The first is about apps this organisation connected and whose permissions it manages. The second is about any web address an automation author types in, so it is off until you say otherwise.` |
| Checkbox 1 | `Answers from connected apps` — `Look-ups an automation makes through an app action — a calendar, a mailbox, a ticket system.` |
| Checkbox 2 | `Answers from web service calls` — `Replies to a "Call a web service" step, which can point at any address the automation author chooses. Only ever GET and HEAD, and never when that step is allowed to reach private addresses.` |
| TTL label | `How long an answer may be reused` |
| TTL note | `After this, the answer is deleted and the next run asks the app again. This is also the longest a run can be working from stale data. Shortening it applies to answers already stored, not just new ones.` |
| TTL readout | `5 minutes` (`{{n}} minutes`) |
| Stored line | `Stored right now: 214 answer(s), 3.2 MB.` |
| Expired addendum | `41 of those have already expired and are never served — they are deleted by the hourly clean-up, or by the button below.` |
| Buttons | `Save`, and `Delete the 214 stored answer(s) now` (only when something is stored) |
| Load-failure banner | `Could not load this setting.` + the raw error |
| Toasts | `Saved` · `Saved. Stored answers were deleted.` · `Stored answers deleted` · `Could not save the setting` · `Could not clear the stored answers` |

The stored-count line and the delete button **only render when `entries + expiredEntries > 0`**, so
on a clean org the screen has no counter at all.

### 2.4 The step-level tick (Automation builder, not settings)

In an automation step's **Advanced** section (`AskOnceRow`):

- `Ask this app only once per run` — *"If this step asks the same thing more than once in a run —
  inside a loop, say — the first answer is used again instead of asking every time."*
- Once that is ticked, a nested tick appears: `…and keep the answer for later runs too` —
  *"The answer is stored, encrypted, so the next run can use it instead of asking again. Your
  administrator decides whether that is allowed, and for how long; until they turn it on, this step
  asks every run."*

Disabled reasons an author can meet:
- `This action changes something in <App>, so its answer cannot be reused.`
- `This look-up is checked fresh every time — either it changes by the minute, or its permissions are checked as it runs.`

Validator warning shown on the automation when the nested tick is on:
`Step <id>: answers are only kept between runs if your organisation allows it.` with hint
`An administrator turns this on under Organisation settings; until then this step asks every run.`

---

## 3. Concepts a learner must understand

- **Context window** — the maximum amount of text (measured in tokens) a model can read in one
  request. Different models have wildly different windows; Bee Flow knows a table of them.
- **Token** — roughly four characters of text. All the budget numbers are in tokens.
- **Compaction (local, lossy)** — Bee Flow itself replaces the older part of a chat with a short
  summary written by the fast-tier model, and shortens long tool results. Whatever the summary
  leaves out is gone for the rest of that conversation. This is the switch on the screen.
- **Context management (provider-side, lossless)** — Anthropic clears stale tool results and
  thinking blocks per request without rewriting Bee Flow's stored history. Always on for supported
  Claude models; not configurable from this screen.
- **Emergency fold / Safety limit** — a fold that fires on *estimated prompt size*, not message
  count, when the conversation approaches the chosen share of the context window. It runs **whether
  or not compaction is on**, because a summary beats a hard `400 prompt is too long`.
- **Watermark (`summaryUpTo`)** — how many messages are already inside the stored summary, so later
  turns rebuild the summary block locally instead of re-summarising the whole prefix every turn.
- **Run memo** — an automation reusing an answer *inside one run*. Lives in memory on the run, dies with
  it, stores nothing, needs no org permission. This is what `Ask this app only once per run` gives.
- **Durable answer cache** — a Postgres row that *outlives* the run. This is what Answer Reuse
  governs. Key is an HMAC under a server secret; the payload is AES-256-GCM encrypted.
- **Scope (`integration` vs `http`)** — two separate promises inside one consent row: answers from
  apps the org connected, versus replies to a hand-typed "Call a web service" step.
- **TTL** — how long a stored answer may be served. Also the ceiling on how stale a run's data can
  be.
- **Kill switch** — a server-wide env flag an operator can set; it beats any org setting.
- **Egress mode** — Privacy Shield's outbound mode. Under `tokenize` and `redact` two different
  people produce identical outgoing arguments, so a durable cache is **refused outright**.

---

## 4. End-to-end workflows

### W1 — Turn compaction ON for the whole organisation (cost control)
1. Open **Settings**.
2. Click **Organisation** in the left nav (it expands; License & Usage opens).
3. Click **Conversation Memory**.
4. Read the two cards. Click the second card, **Summarise older messages**.
5. Leave the **Safety limit** slider where it is (75%), or drag it.
6. Click **Save**.
7. Toast reads `Conversation memory settings saved`; the Cancel link disappears.
8. Open any chat and send a message — the new policy applies from the next message (the server
   memoises the policy for 30 seconds but the save invalidates that memo immediately).

### W2 — Give long chats more headroom (or less)
1. Settings → Organisation → **Conversation Memory**.
2. Leave **Keep the full conversation (recommended)** selected.
3. Drag **Safety limit** — the readout and the examples line update live
   (e.g. at 60%: `Claude Sonnet 5 → ~600,000 tokens · Claude Haiku 4.5 → ~120,000 tokens`).
4. **Save**.
5. If you change your mind before saving, click **Cancel** — it restores the last loaded values.

### W3 — Allow automations to reuse app answers between runs
1. Settings → Organisation → **Answer Reuse**.
2. Click **Keep answers for a short while**. The scope block and TTL slider appear.
3. Leave **Answers from connected apps** ticked. Leave **Answers from web service calls** unticked
   unless you mean it.
4. Drag **How long an answer may be reused** to the window you want (minimum 1 minute, maximum
   60 minutes, in 1-minute steps; the default is 5 minutes).
5. **Save** → toast `Saved`.
6. Go to the automation that should benefit: open the step, open **Advanced**, tick
   **Ask this app only once per run**, then tick **…and keep the answer for later runs too**.
7. Save the automation and run it twice. The second run skips the app call.

### W4 — Shorten the window after noticing stale data
1. Settings → Organisation → **Answer Reuse**.
2. Drag the TTL slider down (e.g. 60 minutes → 5 minutes).
3. **Save**.
4. The save rewrites `expires_at` on rows **already stored** (`shrinkTtlForOrg`), so the change bites
   immediately instead of in another 55 minutes. The reload shows a smaller `Stored right now:` line
   once the hourly prune catches up.

### W5 — Forget everything cached, right now, without changing the policy
1. Settings → Organisation → **Answer Reuse**.
2. Read the line `Stored right now: N answer(s), X MB.`
3. Click **Delete the N stored answer(s) now**.
4. Toast `Stored answers deleted`; the counter line and the button disappear.
5. The policy is untouched — the next run starts refilling the cache.

### W6 — Switch Answer Reuse off entirely (and erase)
1. Settings → Organisation → **Answer Reuse**.
2. Click **Ask every run (recommended)**.
3. **Save**.
4. Toast reads `Saved. Stored answers were deleted.` — switching off *also purges* every row the org
   had stored. (Switching it **on** never purges.)

---

## 5. Defaults, limits and the exact numbers

### Conversation Memory (`org_ai_context_<orgId>` in configStore)

| Field | Default | Range | In the UI? |
|---|---|---|---|
| `compactionEnabled` | `false` | boolean | yes (the two cards) |
| `compactionThreshold` | `16` messages | 4 – 400 | no |
| `recentWindow` | `8` messages | 2 – 200, additionally clamped to `threshold − 2`, floor 2 | no |
| `contextBudgetPercent` | `75` | 25 – 95, slider step 5 | yes (Safety limit) |

- Policy memoised for **30 000 ms**; `PUT` calls `invalidateContextPolicy` — but that is
  **in-process only**, so another replica can still serve a 30-second-old policy.
- `BEEFLOW_CHAT_COMPACTION_DEFAULT=1|true|on|yes` flips the default for orgs that never configured it
  (self-host escape hatch; it does not override a stored row).
- Context-window table (`contextWindowFor`): Claude Haiku → **200 000**; Claude Fable/Mythos →
  **1 000 000**; Opus 4.6/4.7/4.8/5 → **1 000 000**; Sonnet 4.6/5 → **1 000 000**; any other Claude →
  **200 000**; Gemini 1.5 Pro → **2 000 000**, other Gemini → **1 000 000**; GPT-5 / GPT-4.1 / o3 / o4 →
  **400 000**; GPT-4o / GPT-4-turbo → **128 000**; Mistral Large / Magistral / Pixtral → **128 000**;
  anything unknown → **128 000**.
- Compaction internals: tool results in the recent window truncated to **500 characters**; per-file
  extracted text carried into a summary capped at **40 000 characters**; an image is charged a flat
  **1 600** tokens and a document **4 000** tokens in the overflow estimate; the emergency fold keeps
  as many recent messages as fit in **50 %** (`OVERFLOW_RETAIN_RATIO`) of the budget and **always at
  least the last 2 messages**.
- The emergency fold never fires on a conversation shorter than `recentWindow + 1` unsummarised
  messages.
- Provider-side context editing (`claude.js`): beta header `context-management-2025-06-27`;
  `clear_thinking_20251015` with `keep: all` (override via `CLAUDE_KEEP_THINKING_TURNS=all|off|<n>`);
  `clear_tool_uses_20250919` triggering at **30 000 input tokens**, keeping **5 tool uses**, clearing
  at least **5 000 input tokens**. Disable with `CLAUDE_CONTEXT_EDITING_DISABLED=1`. Supported on
  `claude-opus-4/5*`, `claude-sonnet-4/5*`, `claude-haiku-4-5*`, `claude-fable/mythos*` — Claude 3.x
  rejects the parameter. Anthropic's native `compact_20260112` is deliberately **not** enabled.

### Answer Reuse (`org_integration_cache_<orgId>` in configStore)

| Field | Default | Range | In the UI? |
|---|---|---|---|
| `enabled` | `false` (only a literal `true` turns it on) | boolean | yes |
| `ttlSeconds` | `300` (5 min) | 60 – 3600, slider step 60 | yes |
| `scopes.integration` | `true` when absent | boolean | yes |
| `scopes.http` | `false` (only a literal `true`) | boolean | yes |

- Policy memoised **30 000 ms** on the read path; the **write** path re-reads the row fresh
  (`resolveCachePolicyFresh`) so a replica cannot refill the table after an admin purged it.
- Per-org quotas: **5 000 rows** and **64 MiB** of stored payload. Over either, a write is
  **refused, never evicted** — a refusal is just a miss.
- Per-entry ceiling **262 144 bytes (256 KiB)** for app look-ups; **1 MiB** for `http_request`
  responses (`HTTP_MAX_ENTRY_BYTES`).
- Step-level `askOnce.ttlSeconds` is validated to **1 – 900 seconds**; the effective window is
  `min(org ttlSeconds, step ttlSeconds)`.
- Expired rows are pruned **hourly** (first pass 120 seconds after boot). They are never *served*
  before then — the expiry is enforced in the `WHERE` clause on every read.
- Env kill switches, all using the grammar `1|true|on|yes` (case- and whitespace-tolerant):
  `INTEGRATION_CACHE_DISABLED` (the whole durable cache) and `AUTOMATION_ASK_ONCE_DISABLED`
  (both the run memo and the durable tier).
- The visible sibling feature, **Remember answers in a table** (`cacheInto`), defaults to a
  **30-day** window and writes to a datatable with `managedKind: 'http_cache'`. It is a *separate*
  tick, not governed by this org setting.

### The three levels that must all say yes
A durable answer is only ever stored when **all** of:
1. env `INTEGRATION_CACHE_DISABLED` is not on, **and**
2. the org policy `enabled === true` **and** the matching `scopes[<kind>] === true`, **and**
3. the step carries `askOnce.acrossRuns === true`.

Plus the runtime refusals: `egressMode` must be `real` (never under Privacy Shield `tokenize` or
`redact`); the run must not have slept (a Wait clears the memo on purpose, and the durable tier is
skipped too); `blockPrivateTargets` must not be `false`; only 2xx responses; a response carrying
`set-cookie` / `www-authenticate` / `proxy-authenticate` / `authentication-info` is refused whole.

---

## 6. What happens on failure

| Failure | Behaviour |
|---|---|
| Config store unreadable when resolving either policy | Falls back to the **default** (compaction off / cache off) and logs a warning. Never throws. |
| `GET /api/org-ai-context/:orgId` errors | `500 {"error":"Failed to load AI context settings"}` → red banner `Could not load conversation memory settings.` and **Save stays disabled** (the SPA nulls its loaded state rather than saving a guess). |
| `PUT /api/org-ai-context/:orgId` errors | `500 {"error":"Failed to save AI context settings"}` → toast `Could not save conversation memory settings`. |
| Hand-rolled / partial PUT body | `normalizePolicy` clamps every number; an out-of-range or non-numeric value falls back to the default. A broken row can never be written. Nothing is rejected with a 400. |
| Compaction throws mid-turn | Logged (`Compaction failed, using full history`) and the turn continues with the **full** history. |
| The fast-tier summariser fails | The watermark does **not** advance; the evicted messages stay verbatim and the fold is retried next turn. |
| Anthropic rejects `context_management` | Logged, the parameter is stripped and the request is retried **once** without it. |
| Answer Reuse cache unreachable / decrypt fails | Treated as a **miss** — the automation makes the real call. A blob that will not decrypt is reaped. |
| Quota exceeded | The write is refused and counted; the automation keeps working, just without reuse. |
| `GET /api/org-integration-cache/:orgId` errors | `500 {"error":"Failed to load the setting"}` → `Could not load this setting.` |
| Purge fails | `500 {"error":"Failed to clear the stored answers"}` → toast `Could not clear the stored answers`. |

User-visible signals in chat when a fold happens:
- streaming phase `Compacting conversation…` (`chat.phase.compacting`), only when a real summariser
  call is about to run;
- a divider in the transcript reading **`Eerdere berichten zijn samengevat`**
  (`chat.earlierMessagesSummarised` — the default string in `en-defaults.js` is Dutch);
- direct chat emits a `token_savings` event `{ type: 'compaction', messagesBefore, messagesAfter }`.

---

## 7. Permission and licence gates

| Action | Gate |
|---|---|
| See the two menu entries | `canSeeOrg` in `AdvancedSettings.jsx` — permissions include `all` or `org_admin`, or `user.orgRole` is `admin` / `org_admin`. |
| `GET /api/org-ai-context/:orgId` | `requireAuth` + membership via `resolveUserOrgIds(req)`. **Any member** of the org may read. Non-members get `403 Not a member of this organization`. |
| `PUT /api/org-ai-context/:orgId` | `requireAuth` + `isOrgAdminForOrg(req, orgId)` (super admin passes automatically). Otherwise `403 Only organization admins can change AI context settings`. |
| `GET /api/org-integration-cache/:orgId` | Same member check. |
| `PUT /api/org-integration-cache/:orgId` | Org admin. `403 Only organization admins can change this setting`. |
| `DELETE /api/org-integration-cache/:orgId/entries` | Org admin. `403 Only organization admins can clear this`. |
| Unauthenticated | `401` from `requireAuth`. |
| Licence | **None.** No `requireLicenseFeature`, `hasFeature`, `RequireTier` or `useCan` anywhere in these routes or components. Both switches are available on every plan, including self-host. |

`orgRoles.json`: the `org_admin` role carries `org_admin` and `page_settings`; `dpo` and
`isms_auditor` carry `page_settings` + `admin_compliance` but **not** `org_admin`, so a DPO sees the
Compliance entry and nothing else under Organisation. `member` carries neither.

---

## 8. How it connects to the rest of the product

- **Chat and agents** — `resolveContextPolicy` is read on both hot paths:
  `server/core/agentRuntime/chatStream.js` (agents) and
  `server/routes/ai/directChat/streamTurn.js` (direct chat). One switch covers both.
- **Model tiers** — the summary is always written by the `fast` tier (`summaryModelId: 'tier:fast'`),
  so the cost of compaction is a fast-tier call, not a frontier one.
- **Providers** — the lossless half lives in the Claude adapter. Non-Claude providers get no
  server-side context editing, so for them the Safety limit is the only protection.
- **Automations / App actions** — Answer Reuse is meaningless without the per-step tick, and vice versa.
  `execAi.js` gates app look-ups on `scopes.integration`; `httpCache.js` gates "Call a web service"
  on `scopes.http`.
- **Privacy Shield** — `egressMode` decides whether a durable entry is even legal. Under `tokenize`
  or `redact` the outgoing arguments are placeholders, so two different people would share one cache
  key; the durable tier is refused outright.
- **Encryption** — the cached payload goes through the same `secretBox` (AES-256-GCM, per-feature
  salt) as every other stored payload.
- **Account erasure / GDPR** — `purgeForUser(userId)` deletes a person's cached answers with their
  account; `purgeForOrg` backs the admin's delete button and the off-switch.
- **Compliance Center** — the fact that a named admin turned storage on, and when, is exactly the
  kind of evidence a ROPA entry wants; the config row carries `updatedAt` and `updatedBy`
  (see the caveat in §9).

---

## 9. Common mistakes

1. **Assuming the two switches are the same knob.** Conversation Memory is about a *chat*; Answer
   Reuse is about a *automation*. Neither affects the other.
2. **Turning compaction on to "make chats cheaper" and then reporting lost detail.** The second card
   says it plainly: detail is *permanently lost to the assistant*. On a 1M-token model there is
   usually nothing to gain.
3. **Expecting the org switch alone to speed up an automation.** Nothing is reused until the automation
   author also ticks `…and keep the answer for later runs too` on the step. Until then the automation
   validator shows the warning *"answers are only kept between runs if your organisation allows it"*
   — which reads backwards to most admins, because the missing half is often the *step*, not the org.
4. **Ticking `Answers from web service calls` without meaning to.** It is a second, wider promise:
   any address the automation author types in.
5. **Believing the copy "Only ever GET and HEAD".** That sentence in the **Answers from web service
   calls** checkbox description is **stale**. `CACHEABLE_METHODS` in `httpCache.js` (line 132) is
   `GET, HEAD, POST, PUT, PATCH, DELETE` — the method refusal was removed on 2026-09-02 and the
   validator only *warns* on a write method, it does not block. (App actions are different: a
   side-effect tool is an outright validation **error**.) Do not repeat the UI sentence as fact in a
   lesson; say "look-ups", and flag the discrepancy.
6. **Expecting a deep link to survive a reload.** See §2.1 — these two sub-tabs have no address.
7. **Reading `Stored right now: 0` as "nothing is cached".** The counter shows live + expired; only
   an org that has never cached shows no line at all. Conversely, a large number can be mostly
   expired rows awaiting the hourly prune.
8. **Thinking the Safety limit only matters when compaction is on.** It applies in both modes — it
   is the only thing standing between a huge conversation and a `400 prompt is too long`.
9. **Expecting a change to be instant on every server.** The policy memo is 30 seconds and the
   invalidation is in-process; on a multi-replica cluster another replica can lag by up to 30 s.
10. **Assuming turning Answer Reuse off leaves the data.** It purges. And turning it back on does
    not bring anything back.
11. **Setting a step TTL longer than the org TTL.** The effective window is the minimum of the two;
    the step tick can only ever *shorten*.

---

## 10. Three scenarios for Van Dijk Groep (Dutch SME)

### 10.1 Procurement — "the assistant forgets the tender halfway"
Nadia in inkoop runs long chats about a European tender: 60+ messages, several PDFs of terms, a
price comparison the assistant built in message 12. She complains that by message 40 the assistant
re-asks for the delivery window it already had.

The admin opens **Settings → Organisation → Conversation Memory** and finds the second card,
**Summarise older messages**, is selected — somebody turned it on last quarter to save tokens. He
switches to **Keep the full conversation (recommended)**, leaves **Safety limit** at 75%, and saves.
Nadia's next message already sees the whole thread; on Claude Sonnet 5 that is ~750 000 tokens of
headroom before the emergency fold does anything at all. If a tender chat ever does get that big,
the fold still protects it — she sees the divider *Eerdere berichten zijn samengevat* and knows what
happened.

### 10.2 HR — an automation that must never reuse a stale answer
Van Dijk's HR automation runs every morning: for each of 180 employees it looks up the leave balance in
the HR app and mails a reminder to anyone with untaken days. The automation author ticked
**Ask this app only once per run** to survive the loop, then also ticked **…and keep the answer for
later runs too** because it looked faster.

The admin's call: leave balances change during the day, and a reminder based on a stale balance is
an HR complaint. In **Answer Reuse** he leaves the org setting on **Ask every run (recommended)**.
The automation still deduplicates *inside* one run (that reuse never leaves the run and stores nothing),
and nothing about 180 employees' leave records is written to the database. If he ever does turn it
on, he keeps the TTL at **5 minutes**, which is also the longest the automation could be working from
stale data.

### 10.3 Sales — a paid reference API worth caching
The sales automation enriches inbound leads: for every new lead it calls a paid KvK/company-data web
service, one call per lead, billed per call. The same twenty companies come back week after week.

The admin opens **Answer Reuse**, picks **Keep answers for a short while**, and — because this is a
hand-typed "Call a web service" step, not a connected app — ticks **Answers from web service calls**
as well as leaving **Answers from connected apps** ticked. He drags **How long an answer may be
reused** to **60 minutes**, the maximum, and saves. The automation author then ticks both boxes on that
step. A week later the screen reads `Stored right now: 214 answer(s), 3.2 MB.`

When the data provider corrects a company's details, the admin does not wait out the hour: he clicks
**Delete the 214 stored answer(s) now** and the next run asks for real. If the org's DPO later
objects to storing third-party payloads at all, switching back to **Ask every run (recommended)**
both stops the storing and erases what is there — the toast confirms it: *Saved. Stored answers were
deleted.*

---

## 11. Endpoints a "did the learner do it?" check can call

All are mounted in `server/index.js` (lines 600–601) and confirmed in `server/routes/`.
All require an authenticated session cookie (`requireAuth`); all are org-scoped by `:orgId`.

| Method | Path | Auth | JSON returned |
|---|---|---|---|
| `GET` | `/api/org-ai-context/:orgId` | session; **any member** of that org | `{ compactionEnabled: bool, compactionThreshold: int, recentWindow: int, contextBudgetPercent: int, configured: bool, contextWindowExamples: [{ label, contextWindow }], contextBudgetRange: { min: 25, max: 95 } }` |
| `PUT` | `/api/org-ai-context/:orgId` | session; **org admin** or super admin | same shape with `configured: true` (write — use only to set up a lab, not to verify) |
| `GET` | `/api/org-integration-cache/:orgId` | session; **any member** | `{ enabled: bool, ttlSeconds: int, scopes: { integration: bool, http: bool }, killSwitch: bool, ttlRange: { min: 60, max: 3600 }, configured: bool, entries: int, expiredEntries: int, bytes: int }` |
| `PUT` | `/api/org-integration-cache/:orgId` | session; **org admin** | same, plus `purged: int` and `shrunk: int` |
| `DELETE` | `/api/org-integration-cache/:orgId/entries` | session; **org admin** | `{ purged: int }` |
| `GET` | `/auth/organizations` | session; needs `all`, `manage_users`, `admin_security` or `org_admin` | array of org rows, filtered to the caller's own orgs for non-super-admins — use it to discover the `:orgId` to check |

**Owner field — read this before designing a check.** The config rows *do* store `updatedAt` and
`updatedBy` (the saving user's id), written by both `PUT` handlers. But **neither GET returns them**:
the response is built from `normalizePolicy(stored)`, which keeps only the four (respectively three)
policy fields. The only "somebody touched this" signal available over the API is
**`configured: true`** (`!!stored`).

Practical verification recipes:
- *"The learner turned compaction on"* → `GET /api/org-ai-context/:orgId` and assert
  `compactionEnabled === true && configured === true`.
- *"The learner moved the Safety limit"* → assert `contextBudgetPercent !== 75` (and is within
  `contextBudgetRange`).
- *"The learner enabled Answer Reuse for connected apps only"* → `GET /api/org-integration-cache/:orgId`
  and assert `enabled === true && scopes.integration === true && scopes.http === false`.
- *"The learner shortened the window"* → assert `ttlSeconds < 300`.
- *"The learner cleared the cache"* → assert `entries === 0 && expiredEntries === 0` (note this is
  also true of an org that never cached anything, so pair it with a prior reading).
- A check that must distinguish *who* saved it needs the config row directly
  (`configStore.getConfig('org_ai_context_<orgId>')` / `org_integration_cache_<orgId>`), not the API.
