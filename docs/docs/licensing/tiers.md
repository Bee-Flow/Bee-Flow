---
title: Tiers
---

# Tiers

:::warning[Subject to change]

Tier limits, pricing and feature gates on this page are still being tuned
over the coming weeks. Treat the numbers below as indicative — we'll update
this page as the structure settles.

:::

Bee Flow ships in three tiers. **Community** is the default state of a fresh
install — no licence key, no caps. Community covers the free self-hosted
core: chat with agents, knowledge bases, the Nextcloud connector (including
**signing in to Bee Flow from the Nextcloud App Store app** via Nextcloud
OAuth), multi-user with groups, themes, **personal webpages** (building and
previewing your own pages; sharing them is Enterprise), and **all built-in
integrations** (Google, Microsoft, AI image/music/video generation,
third-party connectors and the Nextcloud module family).

Community also ships the **no-code [automation builder](../features/automations.md)
and scheduled agent routines** — for free. Building automations is free; what
stays paid is **collaboration**: sharing an automation or routine across your
team (`automation_sharing`), routing a step past a colleague for **Approvals**
(`approvals`) and **Projects** (team workspaces). On Community,
automations and routines are private to the person who creates them — the
Community tier doesn't include sharing them across a team, so only the creator
can access them.

**Enterprise** does **not** add the built-in integrations or the automation
builder themselves — those are free in Community. What Enterprise adds is the
**collaboration** layer on top (sharing automations/routines across a team,
**Projects** team workspaces), the **MCP Server Marketplace** *(an Enterprise
beta — a later implementation; see [Integrations → MCP](../integrations/index.md))*,
**SSO beyond Nextcloud** (Google / Microsoft / SAML — Nextcloud OAuth login stays
Community) together with the rest of the Studio-class capabilities (voice chat,
Skills, sharing webpages, Studio Documents, meeting notes, notebooks, component
designer), the automation privacy steps, datatable retention, datatables as
knowledge sources and scheduled knowledge refresh, the
advanced Privacy Shield modes, guardrail DLP, the compliance hub (GDPR + AI
Act) — **the remaining beta features also require Enterprise** (the automation
builder + agent routines are the exception: they are GA features free in
Community). Enterprise also unlocks the paid **admin-dashboard surfaces** (Agents,
Monitoring, Compliance, Support, Appearance/branding, Product Website) — see
[Admin dashboard by tier](#admin-dashboard-by-tier) below. **Full** layers
white-label branding and sub-licence issuance on top for resellers.

Source of truth: [`server/license/tiers.js`](https://github.com/Bee-Flow/beeflow/blob/main/license/tiers.js).

## Limits

The Community tier is uncapped. Paid tiers do not introduce smaller limits;
they add capability rather than headroom.

| Limit (`tiers.js` key) | Community | Enterprise | Full |
|-------|:---------:|:----------:|:----:|
| Users (`max_users`) | unl. | unl. | unl. |
| Agents (`max_agents`) | unl. | unl. | unl. |
| Messages / month (`max_messages_per_month`) | unl. | unl. | unl. |
| Knowledge-base sources (`max_kb_sources`) | unl. | unl. | unl. |

Conventions used elsewhere in the product (cron intervals, KB document size
cap, audit retention) are policy defaults rather than hard-coded limits and
may move at any time.

## Feature × tier matrix

| Feature | Community | Enterprise | Full |
|---------|:---------:|:----------:|:----:|
| **Core chat** |
| Basic chat with agents | ✅ | ✅ | ✅ |
| Per-agent system prompts + starter prompts | ✅ | ✅ | ✅ |
| Voice (push-to-talk + voice call) | — | ✅ | ✅ |
| **Knowledge** |
| Knowledge Bases | ✅ | ✅ | ✅ |
| Datatables as knowledge sources | — | ✅ | ✅ |
| Scheduled knowledge refresh | — | ✅ | ✅ |
| Webpage creation (personal) | ✅ | ✅ | ✅ |
| Webpage sharing (publish to the organisation or groups, grants, public links) | — | ✅ | ✅ |
| Studio Documents (invoices, quotes, letters, presentations) | — | ✅ | ✅ |
| **Integrations** |
| Built-in integrations — connect & use in chat (Google, Microsoft, AI generation, third-party, Nextcloud) | ✅ | ✅ | ✅ |
| Nextcloud connector + sign-in to Bee Flow from the NC App Store app (Nextcloud OAuth) | ✅ | ✅ | ✅ |
| SSO — Google / Microsoft / SAML | — | ✅ | ✅ |
| MCP Server Marketplace *(Enterprise beta — later implementation)* | — | ✅ | ✅ |
| **Workflow** |
| Automation builder (no-code, personal) | ✅ | ✅ | ✅ |
| Agent routines (scheduled, personal) | ✅ | ✅ | ✅ |
| Privacy steps in automations (guard, tokenize, untokenize) | — | ✅ | ✅ |
| Datatable retention windows | — | ✅ | ✅ |
| [App Studio](../studio/apps.md) — full-stack AI app builder (GA) | — | ✅ | ✅ |
| Share automations / routines across a team | — | ✅ | ✅ |
| Skills | — | ✅ | ✅ |
| Projects (team workspaces) | — | ✅ | ✅ |
| Notebooks (per-user research) | — | ✅ | ✅ |
| **Productivity** |
| Meeting notes | — | ✅ | ✅ |
| **Privacy** |
| Privacy Shield — block PII | ✅ | ✅ | ✅ |
| Privacy Shield — Tokenize & round-trip PII | — | ✅ | ✅ |
| Web Search Guard (block PII in outbound search) | — | ✅ | ✅ |
| **Admin dashboard** (full breakdown in [Admin dashboard by tier](#admin-dashboard-by-tier)) |
| AI Config / Security / Integrations / Server licence / Languages tabs | ✅ | ✅ | ✅ |
| User & group management (Security tab) | ✅ | ✅ | ✅ |
| Agents / Monitoring / Compliance / Support / Appearance / Product Website tabs | — | ✅ | ✅ |
| Beta features | — | ✅ | ✅ |
| Theme picker (per user/org) | ✅ | ✅ | ✅ |

Legend: ✅ available · — not available

The **MCP Server Marketplace** is a Community feature but a *later
implementation* — treat it as on the roadmap rather than fully stabilised. It
lives in the (Community-visible) **Admin → Integrations** tab.

## Admin dashboard by tier

Admin dashboard tabs are gated by the install's **resolved tier**. The gate
reads the real tier (there is no super-admin elevation in
`LicenseContext.hasTier`), so a Community install shows the limited set even to
its own operator. Tabs above the tier are **hidden** from the tab bar — not
shown locked.

| Admin tab | Community | Enterprise+ |
|-----------|:---------:|:-----------:|
| AI Config | ✅ | ✅ |
| Security (incl. user & group management) | ✅ | ✅ |
| Integrations (Global Defaults · OAuth services) | ✅ | ✅ |
| Server licence | ✅ | ✅ |
| Languages | ✅ | ✅ |
| Agents | — | ✅ |
| Monitoring (Usage & Monitoring) | — | ✅ |
| Compliance | — | ✅ |
| Support (Bee Flow inbox) | — | ✅ |
| Appearance (branding studio) | — | ✅ |
| Product Website | — | ✅ |

**Subscriptions** is a Bee Flow Cloud operator surface — it's cloud-only and
never appears on a self-hosted install, so it carries no tier flag.

Community keeps the **Integrations** tab on purpose: an operator needs it to
wire up OAuth credentials and (later) install MCP servers — without it the free
built-in integrations couldn't be configured. The gate lives in
[`agent-hub/src/pages/AdminDashboard.jsx`](https://github.com/Bee-Flow/beeflow/blob/main/agent-hub/src/pages/AdminDashboard.jsx)
(`minTier` per tab, enforced in `checkTabAccess`).

## Feature-flag names

The server enforces premium features via `requireLicenseFeature(name)`. Names
you'll see in 403 responses:

| Flag | Min tier | Routes / surfaces |
|------|:--------:|--------------------|
| `voice_chat` | Enterprise | Realtime voice chat (Voxtral STT/TTS), `/ai/voice` |
| `webpages` | Community | AI-built webpages you build and keep for yourself, `/api/webpages`. A GA beta whose licence feature is Community |
| `webpage_sharing` | Enterprise | Sharing a webpage beyond its author: publishing to the organisation or groups, grants, public share links |
| `skills` | Enterprise | Skills, `/api/skills` |
| `studio_documents` | Enterprise | Studio Documents, `/api/studio-documents` |
| `automation_privacy_steps` | Enterprise | The guard, tokenize and untokenize steps in automations |
| `datatable_retention` | Enterprise | Retention windows on datatables (rows deleted after N days) |
| `kb_datatable_sources` | Enterprise | A datatable as a knowledge-base source |
| `kb_scheduled_refresh` | Enterprise | Refreshing knowledge-base sources on a schedule |
| `automations` | Community | No-code automation builder, `/api/automation*`. Personal use is free; a GA beta that's Community-exempt from the beta tier floor |
| `agent_routines` | Community | Scheduled agent runs (Studio → Routines), `/api/ai-tasks`. Free personal use; GA beta, Community |
| `automation_sharing` | Enterprise | Sharing automations/routines across a team. **Reserve gate** — pins the paid collaboration boundary for the free builder; no route consumes it yet |
| `approvals` | Enterprise | Approvals — the human decision surface for paused automations and App Studio apps. Gates BROWSING: `GET /api/automation/approvals`, `/approvals/facets`, `/approvals/directory`. **Deliberately does not gate** `GET /approvals/:id`, `POST /approvals/:id/decide`, `POST /approvals/:id/withdraw`, the approval's attachment download, or the legacy `POST /api/automation/runs/:runId/approve-step` — a lapsed or downgraded licence must still be able to finish approvals already pending, or the paused runs behind them would be stuck for good |
| `meeting_notes` | Enterprise | Transcription + summarisation, `/api/transcriptions`, `/api/meet-bot` |
| `component_designer` | Enterprise | Custom UI components, `/components` |
| `notebooks` | Enterprise | Per-user research notebooks, `/api/notebooks` |
| `projects` | Enterprise | Projects / team workspaces (sidebar accordion + `/api/projects`) |
| `pii_tokenize` | Enterprise | Privacy Shield "Tokenize & round-trip" PII action; community PUT clamps `piiDetectionAction` to `block` server-side |
| `web_search_guard` | Enterprise | Privacy Shield Web Search Guard toggle + category filter; community PUT force-disables it server-side |
| `advanced_usage_monitoring` | Enterprise | Usage & Monitoring tabs other than Overview — Safety, Integrations, Feedback, Terminations. Gates `/api/usage/{guardrails,integrations,azure-services}/*`, `/api/feedback`, `/api/terminations` |
| `compliance_hub_gdpr` | Enterprise | `/api/compliance`, guardrail audit log export, DSR flows |
| `compliance_hub_aia` | Enterprise | AI Act compliance hub |
| `sso_saml` | Enterprise | SAML 2.0 IdP config |
| `guardrails_dlp` | Enterprise | DLP rule editor + enforcement |
| `integrations` | Community | All built-in integrations (Google, Microsoft, AI generation, third-party, Nextcloud). **Capability marker, not a route gate** — integration tool usage in chat is ungated by design (`server/core/integrationTools.js` gates only on OAuth/credentials + org/user toggles) |
| `mcp_marketplace` | Community | MCP Server Marketplace (later implementation). Marker — no tier check on MCP install or tool usage |
| `nextcloud_oauth` | Community | Sign-in to Bee Flow from the Nextcloud App Store app + Nextcloud OAuth |
| `custom_themes` | Community | Theme overrides beyond branding basics |
| `white_label` | Full | Branding overrides (logo, colours, domain) |
| `license_issuance` | Full | Sub-licence minting |

Community-tier features (`chat_basic`, `kb_local_small`, `kb_unlimited`,
`nextcloud_basic`, `nextcloud_oauth`, `multi_user`, `webpages`, `automations`,
`agent_routines`) are still passed through `requireLicenseFeature` at their mount
sites — the gate is a no-op because the feature lives in `TIER_FEATURES.community`.
The `integrations` flag is a **capability marker** rather than a mounted gate:
built-in integrations are deliberately ungated at runtime, and the flag exists so
the UI/docs can reference it and so the community feature tests
(`server/license/tiers.test.js`, `communityEnforcement.test.js`) fail loudly if
a future change ever tries to move them behind Enterprise. Beta
features (the `BETA_FEATURES` registry) generally require Enterprise or
higher: on a Community install every `requireBetaFeature(...)` call
short-circuits to a 403 with
`{ error: 'feature_locked', reason: 'beta_requires_enterprise', required:
'enterprise', upgrade_url: … }` so the UI can route the user to the right
CTA. **The exception is the free core:** `automations`, `agent_routines`,
`webpages` and `learning_center` are GA betas whose licence feature lives in
Community, so they are *exempt* from the beta tier floor and work on a Community
install (`server/core/betaFeatures.js` returns them below the floor). The
Enterprise features `webpage_sharing`, `studio_documents`,
`automation_privacy_steps`, `datatable_retention`, `kb_datatable_sources` and
`kb_scheduled_refresh` are GA betas too, but their licence feature is
Enterprise-only, so a Community install does not get them. When a licence
lapses or an organisation moves to a lower plan, these gates only refuse new
creation or widening: existing data and shares keep working, and removing
access is always possible. Super-admins bypass
the tier check (same exemption that already exists for licensed-feature gates).

## Limit enforcement

With Community uncapped, no limit currently fires for unlicensed installs.
The enforcement plumbing is still in place so paid tiers (or future custom
plans) can impose caps:

| Limit | Where it fires | What you see |
|-------|----------------|---------------|
| Users | `POST /auth/users` and the NC sync job | UI shows "Tier limit reached"; sync skips new users (only fires when a custom plan sets `max_users` > 0) |
| Agents | `POST /api/agents` | UI shows "Tier limit reached" |
| Messages / mo | `POST /api/chat` | 402 Payment Required, `error: "tier_limit"` |
| KB count | `POST /api/knowledge` | 402 |

Counters reset on the first day of each calendar month at 00:00 UTC.

## Picking a tier

| Need | Suggested tier |
|------|----------------|
| Free self-hosted core — chat, KB, agents, personal webpages, **all built-in integrations**, the **no-code automation builder + scheduled agent routines** (personal use), and the Nextcloud connector (incl. signing in from the NC App Store app) | Community |
| Team that wants **collaboration** on top of the free builder (sharing automations/routines across a team, sharing webpages, **Projects** team workspaces), the MCP Server Marketplace, the rest of Studio (voice, Skills, Studio Documents, notebooks, meeting notes, component designer), privacy steps and retention in automations, datatable-fed and scheduled knowledge sources, the advanced Privacy Shield modes (tokenize PII, web-search guard), the paid admin tabs (Agents, Monitoring, Compliance, Support, Appearance, Product Website), the remaining beta features, or compliance (SSO, GDPR/AI-Act) | Enterprise |
| Reseller / private-label deployment | Full |

Custom plans (e.g. capped seats, specific feature sets) are available —
contact [tomkooy@beeflow.nl](mailto:tomkooy@beeflow.nl).

## Legacy Pro tier

Earlier versions of Bee Flow exposed a paid **Pro** tier that gated
automations, voice, meeting notes, knowledge-base expansion and similar
features. That tier has been retired and those features now ship in
**Enterprise**.

For backward compatibility, existing licences carrying `tier: "pro"` —
whether JWT-signed, admin-issued blobs, or Stripe subscription rows — are
still accepted and silently resolved to `enterprise`. Paying Pro
customers therefore retain everything they had and pick up the additional
Enterprise capabilities (compliance hub, SSO, etc.) at no extra step. The
mapping lives in
[`server/license/tiers.js`](https://github.com/Bee-Flow/beeflow/blob/main/license/tiers.js)
as `LEGACY_TIER_ALIAS`.
