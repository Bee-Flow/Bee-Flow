---
title: Tiers
---

# Tiers

:::warning[Subject to change]

Tier limits, pricing and feature gates on this page are still being tuned.
Treat the details below as indicative; we update this page whenever
`server/license/tiers.js` changes.

:::

Bee Flow ships in three tiers of the same code.

**Community** is the default state of a fresh install: no licence key, no
caps. It is the free self-hosted core:

- chat and assistants;
- knowledge bases from files, pasted text and web pages, refreshed by hand;
- the no-code [automation builder](../features/automations.md) and scheduled
  agent routines, for your own use;
- data tables and [webpages](../studio/webpages.md) for your own use;
- **all built-in integrations** (Google, Microsoft, AI image, music and video
  generation, third-party connectors and the Nextcloud module family);
- multiple users and groups;
- the Nextcloud connector, including **signing in to Bee Flow from the
  Nextcloud App Store app** via Nextcloud OAuth;
- the Learning Center;
- Privacy Shield detection that blocks personal data.

Building is free; what **Enterprise** adds is collaboration, compliance and the
specialist modules on top:

- the advanced [Privacy Shield](../features/privacy-shield.md) modes:
  placeholders (tokenise and restore), the web search guard, your own data
  types and the privacy steps in automations;
- the Compliance Center (GDPR, AI Act, ISO 27001, DORA, NIS2 and more),
  including the compliance checks on automations;
- approval steps and sharing in automations, sharing webpages, and sharing and
  retention on data tables;
- Studio Apps, [Documents](../studio/documents.md), Playbooks and Solutions
  (Projects and blueprint packaging);
- data tables as a knowledge source and scheduled refresh of knowledge
  sources;
- [Skills](../studio/skills.md), meeting notes, voice chat, notebooks and the
  support inbox;
- the MCP Server Marketplace *(an Enterprise beta; see
  [Integrations → MCP](../integrations/index.md))*;
- advanced usage monitoring and analytics, encryption at rest, Google and
  Microsoft single sign-on, audit log export, custom themes and the paid
  [admin-dashboard tabs](#admin-dashboard-by-tier);
- the remaining beta features, such as swarm agents and the Component
  Designer.

**Full** layers white-label branding and sub-licence issuance on top for
resellers.

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
| Chat with models and assistants | ✅ | ✅ | ✅ |
| Per-assistant instructions and starter prompts | ✅ | ✅ | ✅ |
| Voice (push-to-talk and voice call) | — | ✅ | ✅ |
| Skills | — | ✅ | ✅ |
| Notebooks | — | ✅ | ✅ |
| **Knowledge** |
| Knowledge bases (files, pasted text, web pages), refreshed by hand | ✅ | ✅ | ✅ |
| Datatables as knowledge sources | — | ✅ | ✅ |
| Scheduled knowledge refresh | — | ✅ | ✅ |
| **Studio** |
| Webpages you build and keep for yourself | ✅ | ✅ | ✅ |
| Webpage sharing (publish to the organisation or groups, grants, public links) | — | ✅ | ✅ |
| Datatables you build and keep for yourself | ✅ | ✅ | ✅ |
| Datatable sharing | — | ✅ | ✅ |
| Datatable retention windows | — | ✅ | ✅ |
| Studio Documents (invoices, quotes, letters, presentations) | — | ✅ | ✅ |
| [App Studio](../studio/apps.md) and Playbooks | — | ✅ | ✅ |
| Projects (team workspaces) and Solutions (blueprint packaging) | — | ✅ | ✅ |
| **Automations** |
| Automation builder (no-code, personal) | ✅ | ✅ | ✅ |
| Agent routines (scheduled, personal) | ✅ | ✅ | ✅ |
| Approval steps | — | ✅ | ✅ |
| Share automations and routines with colleagues | — | ✅ | ✅ |
| Privacy steps in automations (Guard, Tokenize; Untokenize is not gated) | — | ✅ | ✅ |
| **Integrations and sign-in** |
| Built-in integrations: connect and use in chat (Google, Microsoft, AI generation, third-party, Nextcloud) | ✅ | ✅ | ✅ |
| Nextcloud connector and sign-in to Bee Flow from the NC App Store app (Nextcloud OAuth) | ✅ | ✅ | ✅ |
| Single sign-on with Google or Microsoft | — | ✅ | ✅ |
| MCP Server Marketplace *(Enterprise beta)* | — | ✅ | ✅ |
| **Productivity** |
| Meeting notes | — | ✅ | ✅ |
| Support inbox | — | ✅ | ✅ |
| Learning Center | ✅ | ✅ | ✅ |
| **Privacy and compliance** |
| Privacy Shield: detect and block personal data | ✅ | ✅ | ✅ |
| Privacy Shield: tokenise and restore personal data | — | ✅ | ✅ |
| Privacy Shield: your own data types | — | ✅ | ✅ |
| Web Search Guard (block personal data in outbound search) | — | ✅ | ✅ |
| Compliance Center (GDPR, AI Act, ISO 27001, DORA and more) | — | ✅ | ✅ |
| Encryption at rest | — | ✅ | ✅ |
| **Admin dashboard** (full breakdown in [Admin dashboard by tier](#admin-dashboard-by-tier)) |
| AI Config, Security, Integrations, Access, Server licence, Modules and Languages tabs | ✅ | ✅ | ✅ |
| User and group management (Security tab) | ✅ | ✅ | ✅ |
| Agents, Monitoring, Compliance, Support and Appearance tabs | — | ✅ | ✅ |
| Beta features | — | ✅ | ✅ |
| **Branding** |
| White-label (logo, colours, domain) | — | — | ✅ |

Legend: ✅ available · — not available

## When a licence lapses

When a licence lapses or an organisation moves to a lower plan, the gates
above only refuse **new** creation or widening. Existing data and shares keep
working, and removing access is always possible:

- Skills already attached to an assistant or an AI step keep working, and
  `DELETE /api/skills/:id` needs no licence, so you can still remove a skill.
- The retention sweeper keeps honouring every retention window that already
  exists.
- Approvals that are already pending can still be read, decided and
  withdrawn, so the paused runs behind them finish.
- Pages and tables that are already shared stay shared; unsharing and revoking
  a grant are never gated.

## Admin dashboard by tier

Admin dashboard tabs are gated by the install's **resolved tier**. The gate
reads the real tier (there is no super-admin elevation in
`LicenseContext.hasTier`), so a Community install shows the limited set even to
its own operator. Tabs above the tier are **hidden** from the tab bar, not
shown locked.

| Admin tab | Community | Enterprise+ |
|-----------|:---------:|:-----------:|
| AI Config | ✅ | ✅ |
| Security (incl. user and group management) | ✅ | ✅ |
| Integrations (Global Defaults, OAuth services) | ✅ | ✅ |
| Access | ✅ | ✅ |
| Server licence | ✅ | ✅ |
| Modules | ✅ | ✅ |
| Languages | ✅ | ✅ |
| Agents | — | ✅ |
| Monitoring (Usage & Monitoring) | — | ✅ |
| Compliance | — | ✅ |
| Support (Bee Flow inbox) | — | ✅ |
| Appearance (branding studio) | — | ✅ |

**Subscriptions**, **Product Website**, **Website Analytics** and **Release
Notes** are Bee Flow Cloud operator surfaces. They are cloud-only and never
appear on a self-hosted install.

Community keeps the **Integrations** tab on purpose: an operator needs it to
wire up OAuth credentials, without which the free built-in integrations could
not be configured. The gate lives in
[`agent-hub/src/pages/AdminDashboard.jsx`](https://github.com/Bee-Flow/beeflow/blob/main/agent-hub/src/pages/AdminDashboard.jsx)
(`minTier` per tab, enforced in `checkTabAccess`).

## Feature-flag names

The server enforces paid features with `requireCapability(name)` or
`requireLicenseFeature(name)` at a mount, or with an in-handler check where
only part of a surface is paid. Names you'll see in 403 responses:

| Flag | Min tier | Routes / surfaces |
|------|:--------:|--------------------|
| `voice_chat` | Enterprise | Realtime voice chat (Voxtral STT/TTS), `/ai/voice` |
| `webpages` | Community | Webpages you build and keep for yourself, `/api/webpages`. A GA beta whose licence feature is Community |
| `webpage_sharing` | Enterprise | Sharing a webpage beyond its author: publishing to the organisation or groups, grants, public share links |
| `skills` | Enterprise | Skills, `/api/skills` (except `DELETE /api/skills/:id`, which is never gated). Also checked where a skill is created outside that mount: the agent wizard, importing a chat's session skill, and the model's publish-to-library tool |
| `studio_documents` | Enterprise | Studio Documents, `/api/studio-documents` |
| `automation_privacy_steps` | Enterprise | The Guard and Tokenize steps in automations, checked when a routine is switched on, published or test-run (`server/automation/licensedSteps.js`). Untokenize only puts values back and is not gated; a step that is already live keeps running after a lapse |
| `datatable_retention` | Enterprise | Retention windows on datatables (rows deleted after N days) |
| `kb_datatable_sources` | Enterprise | A datatable as a knowledge-base source |
| `kb_scheduled_refresh` | Enterprise | Refreshing knowledge-base sources on a schedule |
| `automations` | Community | No-code automation builder, `/api/automation*`, and datatables, `/api/datatables`. A GA beta that is Community-exempt from the beta tier floor |
| `agent_routines` | Community | Scheduled agent runs (Studio → Routines), `/api/ai-tasks`. A GA beta, Community |
| `automation_sharing` | Enterprise | Sharing automations and routines with people or groups (`PUT /api/automation/:id/shares`) and sharing datatables. Reading the share list and removing a share stay ungated |
| `approvals` | Enterprise | Approvals, the human decision surface for paused automations and App Studio apps. Switching on, publishing or test-running a routine that contains an approval step needs it (`server/automation/licensedSteps.js`), and so does a run that reaches one. Gates BROWSING: `GET /api/automation/approvals`, `/approvals/facets`, `/approvals/directory`. **Deliberately does not gate** `GET /approvals/:id`, `POST /approvals/:id/decide`, `POST /approvals/:id/withdraw`, the approval's attachment download, or the legacy `POST /api/automation/runs/:runId/approve-step`: a lapsed or downgraded licence must still be able to finish approvals already pending, or the paused runs behind them would be stuck for good |
| `app_studio` | Enterprise | App Studio and Playbooks, `/api/studio-apps`, `/api/playbooks` |
| `projects` | Enterprise | Projects (team workspaces), `/api/projects` |
| `blueprint_packaging` | Enterprise | Exporting a project as a Solution blueprint, `/api/projects/:id/package` |
| `meeting_notes` | Enterprise | Transcription and summarisation, `/api/transcriptions` |
| `component_designer` | Enterprise | Custom UI components, `/components` |
| `notebooks` | Enterprise | Research notebooks, `/api/notebooks` |
| `support_inbox` | Enterprise | Studio support inbox, `/api/support-inbox` |
| `pii_tokenize` | Enterprise | Privacy Shield "Tokenize & round-trip" action; a Community PUT clamps `piiDetectionAction` to `block` server-side |
| `web_search_guard` | Enterprise | Privacy Shield Web Search Guard toggle and category filter; a Community PUT force-disables it server-side |
| `custom_data_types` | Enterprise | Privacy Shield "Your own data" types, the assistant and the test bench |
| `advanced_usage_monitoring` | Enterprise | Usage & Monitoring tabs other than Overview: Safety, Integrations, Feedback, Terminations. Gates `/api/usage/{guardrails,integrations,azure-services}/*`, `/api/feedback`, `/api/terminations` |
| `compliance_hub_gdpr` | Enterprise | The whole Compliance Center, `/api/compliance` (GDPR, AI Act and ISO 27001 checks alike), and the compliance checks on automations |
| `compliance_hub_dora`, `compliance_hub_nis2`, … | Enterprise | Per-framework switches inside the Compliance Center, enforced when a framework is enabled |
| `encryption` | Enterprise | Content encryption at rest (managed or zero-knowledge keys per organisation) |
| `sso_saml` | Enterprise | Single sign-on configuration for Google and Microsoft (Nextcloud sign-in stays Community). The name is historical: there is no SAML identity-provider integration yet |
| `mcp_marketplace` | Enterprise | Adding and managing MCP servers, `/ai/mcp-servers*`. Once installed, an MCP server is an ordinary integration and using it is not tier-gated |
| `audit_log_export`, `guardrails_dlp`, `custom_themes`, `advanced_analytics` | Enterprise | Declared in the enterprise tier; no route checks them yet |
| `integrations` | Community | All built-in integrations (Google, Microsoft, AI generation, third-party, Nextcloud). **Capability marker, not a route gate**: integration tool usage in chat is ungated by design (`server/core/integrationTools.js` gates only on OAuth/credentials and org/user toggles) |
| `nextcloud_oauth` | Community | Sign-in to Bee Flow from the Nextcloud App Store app and Nextcloud OAuth |
| `learning_center` | Community | The Learning Center |
| `white_label` | Full | Branding overrides (logo, colours, domain) |
| `license_issuance` | Full | Sub-licence minting |

Community-tier features (`chat_basic`, `kb_local_small`, `kb_unlimited`,
`nextcloud_basic`, `nextcloud_oauth`, `multi_user`, `webpages`, `automations`,
`agent_routines`, `learning_center`) are still passed through the licence gate
at their mount sites; the gate is a no-op because the feature lives in
`TIER_FEATURES.community`. The `integrations` flag is a **capability marker**
rather than a mounted gate: built-in integrations are deliberately ungated at
runtime, and the flag exists so the UI and docs can reference it and so the
community feature tests (`server/license/tiers.test.js`,
`communityEnforcement.test.js`) fail loudly if a future change ever tries to
move them behind Enterprise.

Beta features (the `BETA_FEATURES` registry) generally require Enterprise or
higher: on a Community install every beta check answers 403 with
`{ error: 'feature_locked', reason: 'beta_requires_enterprise', required:
'enterprise', upgrade_url: … }` so the UI can route the user to the right
call to action. **The exception is the free core:** `automations`,
`agent_routines`, `webpages` and `learning_center` are GA betas whose licence
feature lives in Community, so they are *exempt* from the beta tier floor and
work on a Community install (`server/core/entitlements/betaFeatures.js`). The
Enterprise features `webpage_sharing`, `studio_documents`,
`automation_privacy_steps`, `datatable_retention`, `kb_datatable_sources`,
`kb_scheduled_refresh` and `compliance_hub_gdpr` are GA betas too, but their
licence feature is Enterprise-only, so a Community install does not get them.
On Bee Flow Cloud each of them can be included or left out per subscription
plan. Super-admins bypass the tier check, the same exemption that already
exists for licensed-feature gates.

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
| The free self-hosted core: chat and assistants, knowledge bases refreshed by hand, **all built-in integrations**, the **no-code automation builder and scheduled agent routines**, datatables and webpages for your own use, the Learning Center, Privacy Shield blocking, and the Nextcloud connector (including signing in from the NC App Store app) | Community |
| A team that wants **collaboration** on top of the free builder (approval steps, sharing automations, webpages and datatables, **Projects**), the Studio modules (Apps, Documents, Playbooks, Solutions), Skills, meeting notes, voice chat, notebooks, the support inbox, the MCP Server Marketplace, privacy steps and retention, datatable-fed and scheduled knowledge sources, the advanced Privacy Shield modes, the paid admin tabs, or compliance, single sign-on and encryption at rest | Enterprise |
| Reseller or private-label deployment | Full |

Custom plans (for example capped seats or a specific feature set) are
available. Contact [tomkooy@beeflow.nl](mailto:tomkooy@beeflow.nl).

## Legacy Pro tier

Earlier versions of Bee Flow exposed a paid **Pro** tier. That tier has been
retired and its features now ship in **Enterprise**.

For backward compatibility, existing licences carrying `tier: "pro"` (whether
JWT-signed, admin-issued blobs, or Stripe subscription rows) are still
accepted and silently resolved to `enterprise`. Paying Pro customers therefore
keep everything they had and pick up the additional Enterprise capabilities at
no extra step. The mapping lives in
[`server/license/tiers.js`](https://github.com/Bee-Flow/beeflow/blob/main/license/tiers.js)
as `LEGACY_TIER_ALIAS`.
