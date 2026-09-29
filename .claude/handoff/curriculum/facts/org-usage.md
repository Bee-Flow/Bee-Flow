# Fact sheet — Usage & Monitoring (org admin)

Area id: `org-usage` · Audience: organisation admin · Status: **exists, fully built** (not a stub)

Source of truth read for this sheet (all paths relative to the repo root):

| What | File |
|---|---|
| Page container, tabs, filters, fetch | `agent-hub/src/pages/settings/UsageSection.jsx` |
| Overview tab (both render paths) | `agent-hub/src/pages/settings/usage/OverviewTab.jsx` |
| Date-range control | `agent-hub/src/pages/settings/usage/RangeControl.jsx` |
| Formatters | `agent-hub/src/pages/settings/usage/format.js` |
| Source labels / avatars | `agent-hub/src/pages/settings/usage/widgets.jsx` |
| Shared cards/hero/empty states | `agent-hub/src/pages/settings/usage/kit.jsx` |
| Feedback tab | `agent-hub/src/pages/settings/OrgFeedbackPanel.jsx` |
| Terminations tab | `agent-hub/src/pages/settings/OrgTerminationsPanel.jsx` |
| Range → query params, tier map, CSV helpers | `agent-hub/src/utils/usageHelpers.js` |
| Thresholds / palette | `agent-hub/src/config/analyticsConfig.ts` |
| Settings nav + gating | `agent-hub/src/pages/AdvancedSettings.jsx`, `agent-hub/src/authedApp/settingsRoutes.js` |
| Pooled-budget toggle | `agent-hub/src/components/admin/org/orgInfo/OrgLicenseSection.jsx` |
| API | `server/routes/usage.js`, `server/routes/usageMonitoringAuth.js`, `server/routes/terminations.js`, `server/routes/feedback.js`, `server/routes/subscriptions/orgSubscriptions.js`, `server/routes/subscriptions/orgUsage.js` |
| Data + pricing | `server/stores/usageStore.js`, `server/stores/azureServiceUsageStore.js`, `server/core/llm/modelCosts.js`, `server/core/entitlements/limits.js` |
| Licence / roles | `server/license/tiers.js`, `server/license/featureMap.js`, `server/config/orgRoles.json`, `server/auth/permissions.js`, `server/index.js` (mounts) |

---

## 1. What the feature is for

Usage & Monitoring is the org admin's money-and-activity report for everything AI in the
workspace. Every model call the product makes — chat, agents, routines, Studio apps, forms,
web pages, transcription drafts, embeddings — writes one row into `ai_usage_log`. This page
reads those rows back, aggregated, so an admin can answer four questions:

1. **How much did AI cost us this period, and is that going up or down?**
2. **Who and what is spending it** — which people, which agents, which models, which part of
   the product (the "app area").
3. **Are we close to the plan's ceiling** (cloud), and will people be blocked?
4. **Is the AI actually working** — were answers rated thumbs-down (Feedback), did tasks stop
   early because of token limits, loops, errors or aborts (Terminations)?

It is a **read-only reporting screen**. Nothing on it changes a setting. The two things that
*do* change behaviour live one nav row away, on **License & Usage**: the plan/cost cap and the
"AI usage sharing" (pooled vs per-user budget) toggle.

Deliberately **not** on this page: Safety & Guardrails and Integrations. They were moved to
**Privacy Shield → What happened** (`/app/settings/organisation/privacy?tab=activity`). Old
deep links `…/organisation/usage/safety` and `…/usage/integrations` silently fall back to
Overview (the id list in `REPORT_TABS` no longer contains them).

---

## 2. Where it lives (navigation)

- URL: **`/app/settings/organisation/usage`** (tab id `org_usage`; table in
  `authedApp/settingsRoutes.js`).
- Path in the UI: **Settings → Organisation → Usage & Monitoring**
  (sidebar label key `settings.usage_monitoring` = **"Usage & Monitoring"**, icon `BarChart2`,
  amber `#f59e0b`). The Organisation group parent is labelled **"Organisation"**.
- Deep link to a tab: `/app/settings/organisation/usage/<report>` — only `feedback` and
  `terminations` resolve; anything else opens Overview.
- The Organisation accordion (and therefore this page) is **hidden on phones**.
- A separate, different screen exists for the platform operator: **Admin → Monitoring**
  (`agent-hub/src/components/admin/monitoring/`, tabs *Overview / Usage Explorer / Feedback /
  Activity / Terminations*). Do not confuse the two in lesson copy — the org page is the one
  described here.

---

## 3. Screens and real UI strings

### 3.1 Page chrome (always visible)

| Element | Real string | Key |
|---|---|---|
| Page title | **Usage & Monitoring** | `usage.title` |
| Subtitle | **Track AI consumption across your organisation** | `usage.subtitle` |
| Range label | **RANGE** (uppercased in CSS) | `usage.range` |
| Range presets | **Today · 24h · 7d · 30d · 90d · All · Custom** | `usage.range_today` … `usage.range_custom` |
| Custom range | two `datetime-local` inputs separated by **→** | — |
| Filter bar label | **FILTERS** | `usage.filters` |
| Filter pills | **All Users**, **All Agents**, **All Models**, **All Sources** | `usage.all_users` / `_agents` / `_models` / `_sources` |
| Clear button | **Clear** (only shown when a filter is set) | `usage.clear` |

Tabs (`ReportTabBar`):

| Tab | Label | Icon / colour | Gate |
|---|---|---|---|
| `overview` | **Overview** | BarChart3, `#0ea5e9` | none |
| `feedback` | **Feedback** | ThumbsUp, `#10b981` | licence `advanced_usage_monitoring` |
| `terminations` | **Terminations** | AlertTriangle, `#f43f5e` | licence `advanced_usage_monitoring` |

Without the licence only **Overview** renders, and an active non-Overview tab is forced back
to Overview by an effect. The filter bar is hidden while Feedback or Terminations is open.
While loading, the Overview area shows four pulsing 80px skeleton tiles plus one 90px bar.

### 3.2 Overview tab — FULL view (self-hosted, or the platform-operator account)

Header: `TabHeader` "Overview" + the subtitle line.

- **Alert banner** (only when spend is over threshold): eyebrow **SPEND OVER BUDGET**,
  message `"$<cost> spent this period — threshold $200.00."`, button **Review by model**
  (scrolls to the Model Usage by User table). Amber above `$200`, red above `$400`
  (`OVERVIEW_COST_ALERT = 200`, red at 2×).
- **Hero**: eyebrow **Estimated cost**, big value e.g. `$41.27`, a trend chip vs. the previous
  half-period, subline `In: $x · Out: $y · Azure: $z` (Azure part only when > 0).
- **Hero tiles** (2×2): **AI calls**, **Tokens**, **Active users**, **Cost / day avg** — each
  with a sparkline from the timeline.
- **Token Consumption Trend** card (`usage.token_trend`), right-hand caption
  **Avg {value} / day** (`usage.avg_per_day`); empty state **No usage data for this period**
  (`usage.no_data`).
- **Top Users** (max 8 rows; click a row to set the user filter). Legend **Input / Output**.
  Empty: **No active users**.
- **By Model** (max 8; click sets the model filter). Row shows total tokens, cost, `N calls`,
  and `In: $… Out: $…`. Empty: **No model data**.
- **By app area** (`usage.by_app_area`; all source rows; click sets the source filter).
  Empty: **No usage recorded yet**.
- **Models per Agent** — expandable per agent (chevron), sub-rows per model with
  `↘ input ($) ↗ output ($)`. Empty: **No data**.
- **Model Usage by User** — collapsible table, open by default, badge with the row count.
  Columns: **User · Model · In Tokens · Out Tokens · Total · In Cost · Out Cost · Total Cost**.
  Shows 20 rows, then a **Show more events (N remaining)** button that adds 20 at a time.
- **Azure Services** — only rendered when there is at least one row. Cards for
  **Document Intelligence** (`N pages`), **Content Safety** (`N chars`), **PII Detection**
  (`N chars`), **Embeddings** (`N tokens`), then a footer row **TOTAL** with the summed cost.

Note: the hero eyebrow, the four tile labels, the alert banner text and the `In:`/`Out:`/`Azure:`
subline are **hardcoded English** in `OverviewTab.jsx` — they are not translated.

### 3.3 Overview tab — CUSTOMER view (Bee Flow Cloud, every admin except the platform operator)

Triggered automatically when the `/summary` payload has no `total_calls` and does have
`billed_cost`. No token counts, no call counts, no raw model names anywhere.

- **Hero**: eyebrow **AI usage this period**, value = the percentage of the cost cap used
  (`—` when there is no cap), a status pill with the subscription status
  (`active` green / `trialing` amber / anything else rose), subline
  `"<N> active users · 5 Jun – 5 Jul 2026"`.
- Hero aside tiles: **Plan** (plan name) and **Billed per cycle** (`€12.00`, subtitle
  `3 × €4.00 / seat` for per-seat plans, otherwise `/ month` or `/ year`).
- Under the hero: bar **AI usage vs. cap** with the percentage — green < 80 %, amber ≥ 80 %,
  red ≥ 95 %.
- **Cost trend** chart (`usage.cost_trend`), values expressed as % of cap.
- Three % -share lists (top 8 each): **Top users by cost**, **By tier**, **By app area**.
  "By tier" buckets models into the tier the user actually picked — **Auto, Fast, Flow, Swarm,
  Think, Write, Deep Thinking**, plus **Other** (`usage.tier_other`) for models with no tier
  mapping. The **All Models** filter pill is hidden in this view.

### 3.4 Feedback tab (Enterprise)

Title **User Feedback**, subtitle **Feedback your users gave on AI responses**. KPI cards
**Positive / Negative / With Comments / With Conversation** plus an `approval` percentage.
Filter chips: **All · 👍 Positive · 👎 Negative · 💬 Comments · 🗨️ With Conversation**, search
box placeholder **Search feedback...**. Empty: **No feedback entries**; loading:
**Loading feedback...**; unknown author: **Anonymous**. An amber banner appears when the
positive share drops below **60 %** on a sample of at least **5** items. Page size **10**.

### 3.5 Terminations tab (Enterprise)

Title **Terminations**, subtitle **Tasks that ended early — token limits, errors, or aborts**.
KPI cards **Total · Max tokens · Max iterations · Errors · Aborted** (sub-caption
*Client disconnects*) · **Large input** (*Likely caused by big prompt / attachment*).
Charts **Terminations over time** and **By agent**. Table columns **Time · Agent · Model ·
Type · Error code · Iter. · Duration · Tokens**. Type badges: **Max tokens · Max iterations ·
Error · Aborted**. Search placeholder **Search agent / model / error...**, dropdowns
**All types / All agents**. Empty: **No terminations match the filters** / **No data to
display**. Privacy line rendered on the page: **"Privacy: messages are not logged. Only
sanitised metadata is shown here."** An alert fires when the error share exceeds **5 %** on a
sample of at least **10** events.

### 3.6 The budget controls (a different screen, one nav row up)

**Settings → Organisation → License & Usage** contains:
- the plan card with the limit rows (users / agents / knowledge sources / cost cap),
- section **AI usage sharing** — *"Choose whether your team shares one AI-usage budget, or
  whether each user gets their own slice."* with the toggle **Share AI usage across the
  organisation** and the state caption **Pooled across the organisation** /
  **Each user has their own budget**. It only renders when the org has a subscription with a
  real cost budget (`max_cost_per_month` present and not `-1`) and no server licence override.

---

## 4. Concepts a learner must understand

- **AI call / usage row** — one model request. Stored in `ai_usage_log` with user, agent,
  model, source, token counts, duration, org, cost and conversation id. It is the only thing
  this page counts.
- **Token** — the unit models bill in. Split into **input/prompt** (what was sent) and
  **output/completion** (what came back). The dashboard colours input blue `#3b82f6` and
  output amber `#f59e0b` everywhere.
- **Cached tokens / cache creation tokens** — input that was served from the provider's prompt
  cache (much cheaper) versus input written *into* the cache (a premium: 1.25× for a 5-minute
  TTL, 2× for an hour on Anthropic). Stored separately so cost is accurate.
- **Reasoning tokens** — thinking tokens (o-series, GPT-5, Gemini). Already inside
  `completion_tokens` for billing; tracked apart for analysis.
- **Estimated cost** — what the *provider* charges, computed at log time by
  `core/llm/modelCosts.js` from a community pricing database (USD per 1M tokens), converted
  into the plan currency with an FX rate.
- **Billed cost** — estimated cost × (1 + the plan's `markup_percent`/100). This is the number
  a cloud customer sees; the raw provider cost is never shown to them.
- **Source / "app area"** — which part of the product made the call (`direct`, `agent`,
  `agent_stream`, `notebook`, `routine`, `studio_app_ai`, `form_ai_draft`, …).
- **Model tier** — the user-facing choice (Auto, Fast, Think, Deep Thinking, Write, Flow,
  Swarm). Cloud customers see tiers instead of model ids.
- **Cost cap (`max_cost_per_month`)** — the monthly AI ceiling. Explicit subscription override
  wins; otherwise plan price × active seats (per-seat plans) or the flat plan price; otherwise
  unlimited.
- **Billing period** — the window everything on the cap gauge is measured over. It follows
  `billing_cycle_start`, *not* the calendar month.
- **Pooled vs per-user budget** — pooled (default): the whole org shares the cap. Per-user:
  each active seat gets `cap ÷ active seats`.
- **Termination** — a task that stopped before finishing: `max_tokens`, `max_iterations`,
  `error`, `aborted`.
- **Feedback** — a thumbs-up/down (and optional comment) a user left on an AI answer.
- **Redaction / customer view** — the server strips token and call counts from every response
  for non-operator callers on cloud. This is why two admins on two deployments see two
  different Overview tabs.

---

## 5. End-to-end workflows (click by click)

### W1 — "What did we spend last month, and on what?"
1. Open **Settings** (avatar menu or `/app/settings`).
2. In the left sidebar open the **Organisation** group, click **Usage & Monitoring**.
3. In the top-right range control click **30d** (or **Custom** and pick the two dates).
4. Read the hero: **Estimated cost** (self-hosted) or **AI usage this period** % (cloud).
5. Scroll to **By Model** (self-hosted) or **By tier** (cloud) to see what the money went on.
6. Scroll to **By app area** to see which part of the product generated it.
7. Click a row in **By Model** / **Top Users** / **By app area** — that sets the matching
   filter pill and every panel re-queries against it.
8. Click **Clear** in the filter bar to go back to the whole org.

### W2 — "Who is the heaviest user, and on which model?"
1. Same page, set the range to **7d**.
2. Read **Top Users** (top 8 by tokens; cloud shows top 8 by % of cost).
3. Click that user's row → the **All Users** pill turns into their name.
4. Scroll to **Model Usage by User** and read the per-model split for them
   (In Tokens / Out Tokens / Total / In Cost / Out Cost / Total Cost).
5. If the table is longer than 20 rows, press **Show more events** to load 20 more.
6. Click **Clear** to reset.

### W3 — "We got the 80 %-of-cap email. Are we about to be blocked?"
1. Open **Settings → Organisation → Usage & Monitoring** (cloud org).
2. The hero gauge **AI usage vs. cap** shows the percentage for the *billing period* — amber
   from 80 %, red from 95 %.
3. Use **Top users by cost** and **By app area** to find the driver.
4. Go one row up in the sidebar to **License & Usage** to see the plan, the cap and the
   billing period; upgrade the plan there, or
5. In **AI usage sharing**, switch **Share AI usage across the organisation** off so each
   active seat gets `cap ÷ seats` instead of one person being able to drain the pool.

### W4 — "People say the assistant gives bad answers."
1. Usage & Monitoring → tab **Feedback** (Enterprise only).
2. Set the range (**30d**).
3. Read the **approval** percentage and the **Positive / Negative** cards; a banner appears
   below 60 % positive on 5+ items.
4. Click chip **👎 Negative**, then expand an entry to read the comment and — when the user
   shared it — the conversation snapshot with model and response time per turn.
5. Note the model/tier badge on the bad answers; if one model dominates, change the tier
   mapping in Admin → AI Config, or fix the agent's instructions.

### W5 — "A routine keeps dying halfway."
1. Usage & Monitoring → tab **Terminations**.
2. Range **7d**; read the KPI row (**Max tokens / Max iterations / Errors / Aborted /
   Large input**).
3. Use **By agent** to find the offender, or type its name in
   **Search agent / model / error...**.
4. Filter **All types → Max tokens**; open a row to see error class, iterations, duration and
   attachment size. A **Large input** badge means the prompt or attachment was unusually big.
5. Act on it: smaller context, split the upload, or a higher-capacity tier.

### W6 — "Prove the local model is actually free."
1. Range **30d**, full view (self-hosted).
2. In **By Model**, find the local model row (e.g. `qwen3-8b (local)`); its cost column reads
   `$0.00` while tokens are non-zero — `modelCosts.js` prices every self-hosted runtime at 0
   *before* the community pricing lookup.
3. Compare with a cloud model row to show the difference in **By Model** and in the hero.

---

## 6. Defaults, limits, numbers

| Thing | Value |
|---|---|
| Default range on open | **30d** (`defaultRange('30d')`) |
| Range presets | Today, 24h, 7d, 30d, 90d, All, Custom |
| "All" sent to days-only routes | **3650 days** (`USAGE_ALL_DAYS`, ~10 years) |
| Timeline bucket | `hour` for Today/24h/short custom windows, else `day` |
| Server default window when `?days` missing/invalid | **30 days** |
| Top Users / By Model / Models per Agent rows | **8** |
| Customer-view lists (users / tiers / sources) | **8** |
| Model×User table initial rows / step | **20 / +20** |
| Spend alert threshold (Overview banner) | **$200** amber, **$400** red (`OVERVIEW_COST_ALERT`) |
| Feedback alert | positive share **< 60 %** on **≥ 5** items; page size **10**; API default limit **200** |
| Terminations alert | error share **> 5 %** on **≥ 10** events; API limit default **100**, max **500** |
| `/api/usage/recent` default limit | **100**; the store also forces a 30-day floor when no dates are given |
| Cost-cap warning email | once per (org, billing period) at **≥ 80 %**, to at most **5** admin addresses |
| Hard block | at **100 %** of `max_cost_per_month` (also `max_messages_per_month`, `max_tokens_per_month`, per-agent-type message limits) |
| Per-user slice when pooling is off | `cap ÷ max(active seats, 1)` |
| Cap gauge colours | green < 80 %, amber ≥ 80 %, red ≥ 95 % |
| Prompt-cache alert (operator API only) | warning at a **15 %** relative week-over-week drop, critical at **30 %** |
| Number formatting | `1.2M` / `3.4K` / `999`; money always two decimals |
| Rows excluded from every aggregate | rows with a `tool_name` (tool-call rows) |

---

## 7. Permission and licence gates

**Nav / page visibility (frontend, `AdvancedSettings.jsx`)**

```js
const canSeeOrg = perms.includes('all') || perms.includes('org_admin')
    || user?.orgRole === 'admin' || user?.orgRole === 'org_admin';
```
The whole Organisation group — Usage & Monitoring included — renders only for `canSeeOrg`.
A DPO or ISMS auditor holds `admin_monitoring` but **not** `org_admin`, so they do **not** get
this page from the settings sidebar (they get Compliance instead).

**Licence capability `advanced_usage_monitoring`** (declared in `server/license/tiers.js` under
the **enterprise** tier; community does not have it):
- frontend: `useLicenseContext().hasFeature('advanced_usage_monitoring')` hides the
  **Feedback** and **Terminations** tabs;
- server: `server/index.js` mounts a path-aware gate over `/api/usage` that applies the
  capability to `/guardrails/*`, `/integrations/*`, `/integrations-health`,
  `/azure-services/*`; the same gate is applied at the mount for `/api/terminations`, and
  inside `routes/feedback.js` for the admin READ routes only (POSTing your own thumbs-up is
  never gated). The Overview endpoints (`/summary`, `/timeline`, `/users`, `/sources`,
  `/agents`, `/models`, `/models-by-*`) are **ungated**.

**Route-level authorisation**
- `attachOrgFilter` (all `/api/usage/*`): 401 when not authenticated; scopes to the caller's
  first org; a consumer (no org) is forced to `userId = own id` so `?user=` cannot widen it.
- `requireMonitoringScope` (`routes/usageMonitoringAuth.js`, on `/guardrails` and
  `/integrations`): org member with an org-admin role → 200 scoped to their own org; plain
  member → **403 "Organization admin access required"**; super admin without an org → **403
  "No organisation context"**; consumer → own rows only. It also stamps `excludeDryRun` so
  rehearsal traffic is left out.
- `/api/terminations/org*` and `/api/feedback/org*`: `requireOwnOrgAdminScope` /
  `requireOwnOrgAdmin` — org-admin role (or super admin) **and** the enterprise capability.
- `/api/usage/prompt-cache`: **403 "Admin only"** unless `session.user.id === 'admin'`.

**The redaction gate (`maybeRedact` in `routes/usage.js`)** — the single most surprising rule:
- self-hosted (`serverLicenseGovernsOrgs()`) → **no redaction**, the operator sees raw tokens
  and provider cost;
- cloud, `session.user.id === 'admin'` (the hardcoded platform-operator credential) → raw;
- **everyone else, org admins included** → every token/call field is deleted
  (`total_calls, total_tokens, prompt_tokens, completion_tokens, cached_tokens,
  cache_creation_tokens, reasoning_tokens, input_cost, output_cost, billed_calls,
  avg_duration_ms, unique_models, unique_agents`, …) and `estimated_cost` is replaced by
  `billed_cost = estimated_cost × (1 + markup_percent/100)`.
  The comment in the code is explicit that this is a *privacy/billing* gate, not an
  operational permission — delegating it to `hasPermission` leaked, because org admins
  routinely carry `all`.

**Roles (`server/config/orgRoles.json`)**

| Role | Label | Carries `admin_monitoring`? | Sees this page? |
|---|---|---|---|
| `org_admin` | Organisation Admin | yes | yes |
| `dpo` | Data Protection Officer | yes | no (no `org_admin`) |
| `isms_auditor` | ISMS Internal Auditor | yes | no |
| `agent_admin` / `agent_editor` | Agent Admin / Editor | no | no |
| `member` | Member | no | no |

`admin_monitoring` is enforced on `GET /reports/:type` and on the **Admin → Monitoring** tab
(`AdminDashboard.jsx`, also `minTier: 'enterprise'`), not on this settings page.

---

## 8. What happens on failure

- **Every Overview fetch is swallowed.** `UsageSection` wraps each response in a helper that
  returns `{}`/`[]` on a non-OK status, a JSON error body, or a parse error. A 403 from a
  licence gate therefore looks exactly like *"no usage in this period"* — empty lists and
  zeros, no error message. There is no error toast on this page.
- **Self-hosted**: `/api/subscriptions/*` answers **404 `not_available_in_self_hosted`** for
  the whole router. The subscription fetch fails quietly, so the Plan / Billed-per-cycle cards
  and the cap gauge simply never appear — expected, not a bug.
- **No subscription bound to the org**: `GET /api/subscriptions/orgs/:orgId` → 404; same silent
  result. `GET /orgs/:orgId/usage` → `404 {"error":"No subscription"}`.
- **Cap reached**: the *chat* is blocked, not the dashboard. `core/entitlements/limits.js`
  returns, verbatim: `"Your organization has reached its monthly cost limit (€X.XX). Please
  contact your administrator."`, or in per-user mode `"You have reached your personal AI usage
  budget for this period (€X.XX). Pooled usage is disabled — contact your administrator."`
  Message and token caps have their own strings. Each block also emits an org-health problem
  (`chat.budget_exhausted`).
- **80 % warning email**: subject `Bee Flow: NN% of your monthly cost limit reached`, sent once
  per billing period via `claimNotification`; failures are swallowed.
- **Unknown model**: `computeCost` falls back to the most expensive known rates rather than 0,
  logs a warning, and slightly over-states cost until the pricing data catches up.
- **FX lookup failure**: for a PAYG (metered) customer the usage write is *refused* (the caller
  surfaces a 503 "billing service degraded") rather than logging a wrong number; for everyone
  else the rate falls back to 1.0 and the column is treated as informational.
- **Pricing feed down entirely**: cost logs `0` with `[ModelCosts] No pricing data available`.
- **Partial data**: a panel whose endpoint 500s renders its own empty state
  (**No active users / No model data / No data / No usage recorded yet**) while the rest of the
  page fills in.

---

## 9. How it connects to the rest of the product

- **Every AI surface feeds it.** `usageStore.logUsage` is called from direct chat, agent chat
  and streaming, the swarm runtime, the automation/routine runner (`execAi`,
  `execData`, `execDataExtraction`), App Studio (`studio_app_ai`, `studio_app_chat`,
  `studio_app_action`, `studio_app_browse`, `studio_app_public`, `studio_app_builder`),
  web pages (`webpage_bridge_ai`), forms (`form_ai_draft`), datatables
  (`datatable_ai_draft`), Cowork (`cowork_compose`), image/video/music generation, knowledge
  embeddings and agent test chats (`agent_test_chat`).
- **License & Usage** (same Organisation group) owns the plan, the cap and the pooled toggle
  the gauge is drawn against.
- **Privacy Shield → What happened** now owns guardrail events and the egress ledger that used
  to be the Safety and Integrations tabs here — same `/api/usage/*` router, different screen.
- **Admin → Monitoring** is the platform-operator version of the same data, cross-org.
- **Users & Groups** shows a per-user `cost · 30d` chip built from the same table
  (`admin.org_usage_cost_30d`).
- **OpenObserve / OTel**: `jobs/usageOpenObservePush.js` pushes an hourly rollup, and
  `logUsage` records an OTel metric per call. Production currently ships with those pushes
  off.
- **Stripe (PAYG)**: metered plans write a `payg_meter_outbox` row per call, drained by
  `workers/paygDrain.js`; `billed_cost` in `ai_usage_log` is the same figure reported to
  Stripe.
- **Azure**: `azureServiceUsageStore` adds Document Intelligence / Content Safety /
  PII Detection / Embedding costs, which appear both in their own block and inside
  `combined_total_cost` in the hero.

---

## 10. Common mistakes

1. **"My tokens disappeared."** On Bee Flow Cloud an *org admin is not the platform operator*
   — the API strips every token and call count and shows marked-up cost only. Nothing is
   broken and no setting restores it. Only self-hosted shows tokens to its own admin.
2. **Currency symbol lies in the full view.** `fCur` hardcodes `$`, but `estimated_cost` is
   stored in the *plan's* currency after FX conversion, and the limit messages say `€`.
   Read the full-view figures as "plan currency", not dollars.
3. **The cap gauge and the list percentages measure different windows.** The gauge is the
   *billing period* (so it matches the License page); the % shares underneath follow the
   range control. Changing the range does not move the gauge.
4. **Calendar month ≠ billing period.** Limits reset on `billing_cycle_start`.
5. **Tool rows are excluded.** Every aggregate adds `tool_name IS NULL`, so `/tools` counts and
   the Overview counts never add up to the same total.
6. **Empty page ≠ no usage.** A missing licence, a 403 or a 500 produces the same blank
   panels; check the tab gating and the browser network tab before concluding there was no
   traffic.
7. **Unrecognised sources look ugly.** `SOURCE_MAP` only labels `agent`, `chat`, `direct`,
   `notebook`, `research`, `template`, `designer`, `agent_stream`. Everything else
   (`studio_app_ai`, `form_ai_draft`, `routine`, …) renders as its raw string with a generic
   grey bot icon. That is cosmetic, not missing data.
8. **There is no export button.** `usageHelpers.js` exports `rowsToCsv`/`downloadCsv`, but no
   panel on this page wires them up. Do not teach a "Download CSV" step.
9. **Old bookmarks to `…/usage/safety` or `…/usage/integrations` land on Overview.** The
   content moved to Privacy Shield → What happened.
10. **Turning pooling off does not lower the bill.** It only splits the same cap into per-seat
    slices; the org-wide 80 % email still fires off the pooled total.
11. **Local/self-hosted models show €0 on purpose.** `isLocalModel` is checked before the
    pricing database; marking a paid endpoint as "local" would silently zero its cost.
12. **Do not build a check on `/api/usage/recent`.** `getRecentCalls` ignores the `userId`
    filter (it only applies org, source, model, search and dates), so it is not a reliable
    per-person read.

---

## 11. Three scenarios for Van Dijk Groep (Dutch SME, ~40 people)

**S1 — Procurement / inkoop.** The inkoop team has a routine that reads supplier PDFs, pulls
out article numbers and prices, and writes them into a datatable. In week one of the quarter
the spend hero jumps from €40 to €180. The admin sets the range to **7d**, sees **By app area**
dominated by the routine source, opens **Models per Agent**, and finds the extraction agent
running on a Deep Thinking tier. Switching the routine's AI step to **Fast** and re-checking
the next week shows the same page count at a fraction of the cost. *(Teaches: range control,
By app area, Models per Agent, tier vs. cost.)*

**S2 — HR.** HR uses an agent to draft vacancy texts and answer questions about the CAO.
Employees complain the answers are wrong. The admin opens the **Feedback** tab over **30d**,
sees approval at 48 % with the amber banner, filters **👎 Negative**, and reads eight comments
that all point at the same outdated leave policy in the knowledge base. Fixing the KB source
and re-checking the tab a week later shows approval back above 60 %. Nothing personal leaves
the workspace — the feedback rows hold only the rating, the optional comment and, where the
user chose to share it, the conversation snapshot. *(Teaches: Feedback tab, chips, the 60 %/5
alert, closing the loop.)*

**S3 — Sales.** Sales runs a proposal generator on long RFP attachments. Half the proposals
come back truncated. The admin opens **Terminations**, range **7d**, and sees **Max tokens**
dominating with a **Large input** badge on most rows; **By agent** points at the proposal
agent. Meanwhile the cap gauge shows 86 % — amber — because the sales rep with the biggest
deals is burning the shared pool. Two actions: split the RFP upload / raise the model's output
budget, and on **License & Usage** turn **Share AI usage across the organisation** off so each
of the 40 seats gets its own slice for the rest of the period. *(Teaches: Terminations, the
cap gauge, pooled vs. per-user budget, and that budget controls live on License & Usage.)*

---

## 12. List / read API endpoints a "did the learner do it?" check can call

All are `GET`, session-cookie authenticated (`authFetch` sends credentials); the org is always
resolved from the session, never from a query parameter. Common query params on the
`/api/usage` family: `days`, `startDate`, `endDate`, `user`, `agent`, `model`, `source`,
`interval=hour|day`.

| Endpoint | Auth needed | JSON returned |
|---|---|---|
| `GET /api/usage/summary` | authenticated; org from session | one object: `total_calls, total_prompt_tokens, total_completion_tokens, total_tokens, total_cached_tokens, total_cache_creation_tokens, total_reasoning_tokens, avg_duration_ms, unique_models, unique_agents, unique_users, total_estimated_cost, total_billed_cost, billed_calls, total_input_cost, total_output_cost, azure_services_total_cost, combined_total_cost`. **Cloud non-operator:** only `unique_users` + `billed_cost`. |
| `GET /api/usage/timeline` | authenticated | array of `{ period ('YYYY-MM-DD' or 'YYYY-MM-DD HH:00'), calls, prompt_tokens, completion_tokens, total_tokens, cached_tokens, estimated_cost }` (redacted → `period` + `billed_cost`). |
| `GET /api/usage/cost-timeline` | authenticated | same bucketing, cost-focused rows. |
| `GET /api/usage/users` (alias `/by-user`) | authenticated | array of `{ user_id ← owner field, display_name, avatarType, avatar, calls, prompt_tokens, completion_tokens, total_tokens, avg_duration_ms, estimated_cost }`. |
| `GET /api/usage/sources` | authenticated | `{ source, calls, prompt_tokens, completion_tokens, total_tokens, estimated_cost }`. |
| `GET /api/usage/agents` (alias `/by-agent`) | authenticated | `{ agent_id, agent_name, agent_type, calls, prompt_tokens, completion_tokens, total_tokens, avg_duration_ms, estimated_cost, input_cost, output_cost }`. |
| `GET /api/usage/models` (alias `/by-model`) | authenticated | `{ model, calls, prompt_tokens, completion_tokens, total_tokens, cached_tokens, cache_creation_tokens, reasoning_tokens, avg_duration_ms, estimated_cost, input_cost, output_cost }`. |
| `GET /api/usage/models-by-agent` | authenticated | model × agent rows, cost split included. |
| `GET /api/usage/models-by-user` | authenticated | model × user rows + `user_id`/`display_name` — the source of the Model Usage by User table. |
| `GET /api/usage/by-conversation` | authenticated | per-`conversation_id` roll-up. |
| `GET /api/usage/by-swarm-run` | authenticated | per-`swarm_run_id` roll-up with orchestrator/worker split. |
| `GET /api/usage/tools` | authenticated | `{ tool_name, calls, avg_duration_ms }`. |
| `GET /api/usage/recent?limit=` | authenticated | raw `ai_usage_log` rows, newest first (30-day floor when no dates). **Ignores the user filter — not safe as a per-person check.** |
| `GET /api/usage/filters/sources` / `/filters/models` | authenticated | distinct source / model strings (not org-scoped). |
| `GET /api/usage/organizations` | authenticated | **always `[]`** (deliberate stub). |
| `GET /api/usage/azure-services/summary` · `/by-type` · `/by-user` · `/timeline` · `/recent` · `/rates` | authenticated **+ licence `advanced_usage_monitoring`** | Azure service cost rows: `{ service_type, calls, total_pages, total_chars, total_tokens, total_cost }`; `/by-user` adds `user_id` + `display_name`. |
| `GET /api/usage/guardrails/overview` · `/integrations/overview` · `/integrations-health` · `/integrations/egress` | licence + **org-admin** (`requireMonitoringScope`) | shield/egress dashboards; `top_users[]` carries `user_id` + `display_name`. Rendered on Privacy Shield → What happened, not here. |
| `GET /api/usage/prompt-cache` | **platform operator only** (`user.id === 'admin'`) | `{ current_week, previous_week, relative_change, alert, by_model_and_source[] }`. |
| `GET /api/terminations/org?days=&limit=` | org-admin + licence | `{ rows: [ { id, timestamp, termination_type, error_code, error_class, error_first_line, stack_first_line, user_id ← owner, organization_id, agent_id, agent_name, model, source, conversation_id, swarm_run_id, iteration_count, duration_ms, prompt_tokens, completion_tokens, total_tokens, attachment_count, attachment_bytes } ] }` |
| `GET /api/terminations/org/summary` | org-admin + licence | `{ termination_type, count }` totals. |
| `GET /api/terminations/org/timeline` | org-admin + licence | `{ rows: [{ period, termination_type, count }], interval }`. |
| `GET /api/terminations/org/by-agent` | org-admin + licence | per-agent termination counts. |
| `GET /api/feedback/org?startDate=&endDate=&rating=&limit=` | org-admin + licence | `message_feedback` rows: `{ id, conversation_id, message_id, agent_id, agent_name, model, model_tier, user_id ← owner, organization_id, rating ('up'\|'down'), comment, source, conversation_snapshot, created_at }`. |
| `GET /api/feedback/org/summary` | org-admin + licence | `{ total, thumbs_up, thumbs_down, with_comments }`. |
| `GET /api/subscriptions/orgs/:orgId` | cloud only; org member or super admin | `{ …subscription, plan_name, status, effective_limits{max_cost_per_month,…}, billing_period{startDate,endDate}, billing{plan_price, plan_currency, billing_interval, per_seat, seat_quantity, subscription_total, usage_pooled, per_user_cap}, current_usage{cost[, messages, tokens for the operator]}, upgradeable_plans[] }`. 404 on self-hosted. |
| `GET /api/subscriptions/orgs/:orgId/usage` | cloud only; org member or super admin | `{ limits, billing_period, billing_model, usage{messages,tokens,cost}, percentages{messages,tokens,cost} }`. |
| `GET /auth/my-permissions` | authenticated | the caller's permissions + `organizations[]` — how the page finds its own org id. |
| `GET /ai/config/tiers-for-user?taskType=direct_chat` | authenticated | `{ tierKey: { modelId … } }` — used to map models to tier names in the customer view. |

**Suggested verification recipe for a lesson step** ("the learner opened Usage & Monitoring and
found the heaviest user"): call `GET /api/usage/users?days=30` and check that it returns at
least one row whose `user_id` matches the expected person (or simply that the array is
non-empty and `GET /api/usage/summary` reports non-zero cost). Both are ungated, org-scoped,
and work on every plan and deployment — unlike anything under `/api/terminations`,
`/api/feedback` or `/api/usage/azure-services`, which 403 on community plans.
