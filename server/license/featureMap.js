/**
 * Route → feature gating registry.
 *
 * Single source of truth for which Express mount paths are gated by which
 * license feature (and any companion beta-feature flag). Entries here are
 * documentation + a future regression target — they don't drive runtime
 * routing; the actual gates are applied at the `app.use(...)` site in
 * server/index.js so that mount order stays explicit.
 *
 * When you mount a new `/api/*` route, add an entry here. If the route
 * is intentionally NOT gated (e.g. /api/notifications, /api/usage), use
 * `gate: null` so reviewers can see the decision was deliberate.
 *
 * Format:
 *   '<mount path>': {
 *       gate: 'feature_name' | null,    // matches a key in TIER_FEATURES
 *       beta: 'beta_feature_key' | null,
 *       notes: '...'                    // brief rationale
 *   }
 *
 * To audit drift, compare `Object.keys(featureMap)` against the mount
 * paths registered in server/index.js (this is what the regression test
 * planned for Wave 3 will do once the harness exists).
 */

module.exports = {
    // ── Gated routes (require a license feature) ─────────────────────
    // The gate is a no-op only for features that live in
    // TIER_FEATURES.community (chat_basic / webpages / kb_* / etc.). The
    // Studio-class features below were promoted to enterprise in the tier
    // tightening — see docs/docs/licensing/tiers.md — and now enforce on
    // every community install.
    '/components': { gate: 'component_designer', beta: null, notes: 'Enterprise tier; AI custom-UI component builder. Top-level (non-/api) path.' },
    // n8n-style free builder: the builder + CRUD are Community (building is
    // free). `automations` is a Community licence feature AND a GA beta that's
    // Community-exempt from BETA_TIER_FLOOR (server/core/betaFeatures.js). The
    // paid line is collaboration: `automation_sharing` (org-wide sharing) +
    // `projects` (team workspaces) stay Enterprise.
    '/api/automation/builder': { gate: 'automations', beta: 'automations', notes: 'Community (n8n-style free builder) — automation builder. Licence feature + GA beta, both Community.' },
    '/api/automation/approvals': { gate: 'approvals', beta: null, notes: 'Enterprise (collaboration) — the human decision surface for paused automations/apps. PER-ROUTE gate inside routes/automation/approvals.js, not a router.use: it shares the Community /api/automation mount, and that router is first-match ordered (the /approvals literals must stay above crud\'s GET /:id — pinned by routes/automation.routetable.test.js). Gated (browsing): GET /approvals, /approvals/facets, /approvals/directory. DELIBERATELY UNGATED (the drain exemption): GET /approvals/:id, POST /approvals/:id/{decide,withdraw}, GET /approvals/:id/files/:fileId and POST /runs/:runId/approve-step — a licence lapse must be able to finish work already in flight, never strand a pending approval and its paused run.' },
    '/api/automation': { gate: 'automations', beta: 'automations', notes: 'Community (n8n-style free builder) — automation CRUD/execution. Licence feature + GA beta, both Community.' },
    '/api/compliance': { gate: 'compliance_hub_gdpr', beta: null, notes: 'Enterprise tier self-hosted; on cloud the id is a GA compound feature flag (betaFeatures.js) so subscription plans include/exclude the hub per org via allowed_beta_features. One gate covers the whole Compliance Hub incl. AI Act and ISO 27001 checks; compliance_hub_aia and compliance_hub_iso27001 are declared in tiers.js but reserved for a future per-regulation route split (e.g. ISO as paid add-on)' },
    '/api/dsr': { gate: null, beta: null, notes: 'Public DSR channel must stay reachable per GDPR Art. 12; admin endpoints inside the router enforce admin_compliance' },
    '/api/notebooks': { gate: 'notebooks', beta: null, notes: 'Enterprise tier; configStore.feature_notebooks_enabled remains as a per-deployment kill switch (runs AFTER the licence gate so the frontend sees the actionable feature_locked body first)' },
    '/api/webpages': { gate: 'webpages', beta: 'webpages', notes: 'Community tier since the enterprise split (2026-10): personal webpages are free, and webpages is a GA beta, so a Community install gets it without opting in. Sharing a page beyond its author (publishing to the organisation or groups, grants, public share links) is the separate Enterprise feature webpage_sharing, a GA beta with the same id. webpage_sharing is enforced per request in routes/webpages/sharingGate.js: publish when it widens, a new public share, extending an expiry, public on or wider; unpublish, narrowing, republish, refresh, revoke and public off stay open.' },
    '/api/transcriptions': { gate: 'meeting_notes', beta: 'meeting_notes', notes: 'Enterprise tier + beta opt-in' },
    '/api/gmeet-notes-settings': { gate: 'meeting_notes', beta: null, notes: 'License-only (no beta gate) — Google Meet → Meeting Notes org/user settings; kept on requireLicenseFeature like /api/talk-notes-settings so it is not over-gated.' },
    '/api/skills': { gate: 'skills', beta: 'skills', notes: 'Enterprise tier + beta opt-in. skills moved from the community list to enterprise in the enterprise split (2026-10); no runtime change on self-hosted, because a non-GA beta was never inside the Community ceiling. DELIBERATELY UNGATED: DELETE /api/skills/:id (core/skills/creationGate.js exceptRemoval wraps the mount gate), so an organisation whose plan lost Skills can still remove what it made. Already-attached skills keep working at runtime (core/tools/skillInjection.js, core/agentRuntime/contextBuilder.js, core/automationRunner/aiStepSkills.js): only new creation is refused.' },
    // Skill creation outside the /api/skills mount. Each door asks
    // core/skills/creationGate.canCreateSkills (hasCapability('skills')) in the
    // handler; the surrounding mount stays Community.
    '/agents/wizard/*': { gate: 'skills', beta: null, notes: 'IN-HANDLER, skills part only (routes/agents/wizard.js). The wizard itself is Community. Without Skills, /wizard/draft and /wizard/refine neither show the model the skill library nor return proposed skills, and /wizard/commit still creates the agent but creates and attaches no skill; the 200 names what was left out in `skillsSkipped` (code feature_locked).' },
    '/ai/direct/conversations/*/session-skills/*/import': { gate: 'skills', beta: null, notes: 'IN-HANDLER (routes/ai/directChat/conversationRoutes.js): importing a chat-local session skill into the library is new creation, 403 feature_locked with a readable `error`. Deleting a session skill is never gated. The model-side twin, the publish_session_skill_to_library tool (core/tools/sessionSkillRuntime.js), refuses with the same sentence as a tool error.' },
    // '/api/security' is intentionally absent: Security Scan moved out of core to
    // a downloadable .bfmod (Hub marketplace); the module owns + gates that mount.
    '/api/support-inbox': { gate: 'support_inbox', beta: 'support_inbox', notes: 'Enterprise tier + beta opt-in — Studio Support tab (tenant customer-support inbox: connect Gmail/Outlook mailbox, inbound→ticket, AI reply, KB-ingest routine). Org-level support_inbox permission additionally gates per-user access.' },
    '/api/studio-apps/:id/large-datasets': { gate: 'large_datasets', beta: null, notes: 'Enterprise tier — LARGE dataset uploads/queries (multi-GB genome VCFs: multipart upload, ingest-time bgzf indexing, bounded slice queries). Shares the /api/studio-apps mount, so the gate is applied PER-ROUTE: the first handler of EACH route in routes/studioAppDatasets.js (on top of the app_studio capability at the mount), never a path-less router.use that would also gate the routers mounted after it. Not /:id/datasets: that path is the BI saved datasets of routes/studioAppData.js, which stay ungated by this feature.' },
    '/api/studio-apps': { gate: 'app_studio', beta: 'app_studio', notes: 'Enterprise tier, GA (auto-on; org admin may disable) — Studio Apps tab (App Studio full-stack app builder: AI designs data tables + seeds data + wires components + roles/RLS, plan-first for big builds; visual editor with the component ribbon, formulas/validation, dataset/BI, external data connectors; actions run the owner\'s Routines acts-as-owner + create/update records; org/group publish; end-users consume at /app/apps/:id). One gate covers CRUD, the data + connector APIs, the action-run bridge and the AI builder stream (/api/studio-apps/builder); viewers need the same capability (no separate viewer tier).' },
    '/api/playbooks': { gate: 'app_studio', beta: 'app_studio', notes: 'Studio Playbooks — phased AI builds (table → routine → fill → app → approvals). Mounted on app_studio AND requireLicenseFeature(\'automations\') because a playbook owns a routine and an app; writes need manage_apps; the approvals phase is locked without the approvals capability (checked in the handler, not at the mount).' },

    // ── Intentionally ungated (community-tier core functionality) ────
    '/api/usage': { gate: 'advanced_usage_monitoring', beta: null, notes: 'Base /api/usage paths (summary/timeline/users/sources/agents/models/...) are ungated for the Overview tab. The /api/usage/{guardrails,integrations,azure-services}/* sub-paths are gated to advanced_usage_monitoring (enterprise+) via a path-aware middleware in server/index.js — Safety, Integrations, Azure-services tabs. Same gate applies to /api/terminations and /api/feedback (Terminations + Feedback tabs).' },
    '/api/terminations': { gate: 'advanced_usage_monitoring', beta: null, notes: 'Enterprise tier — Terminations tab in Usage & Monitoring' },
    '/api/feedback': { gate: 'advanced_usage_monitoring', beta: null, notes: 'Enterprise tier — Feedback tab in Usage & Monitoring' },
    '/api/documents': { gate: null, beta: null, notes: 'Core community feature' },
    '/api/notifications': { gate: null, beta: null, notes: 'Core community feature' },
    '/api/projects/:id/package': { gate: 'blueprint_packaging', beta: null, notes: 'Enterprise tier — export a Studio Project as a Blueprint (a versioned, installable bundle of its automations, apps and webpages). Shares the /api/projects mount, so the gate is applied PER-ROUTE inside routes/projects/packaging.js (on top of the projects gate at the mount) — NOT router-level: a path-less router.use() there once ran for every request reaching that router, including ones for routes/projects.js routes mounted after it that have nothing to do with packaging (e.g. PUT /:id/conversations), so it is the first handler on each packaging route instead, same shape as large_datasets in routes/studioAppDatasets.js. Export is additionally owner-only at the route: it reads every member\'s entities, not just the caller\'s.' },
    '/api/projects': { gate: 'projects', beta: null, notes: 'Enterprise tier (promoted in second-wave tightening). configStore.feature_projects_enabled remains as a per-deployment kill switch (runs AFTER the licence gate so the frontend sees feature_locked first).' },
    '/api/org-privacy-shield': { gate: null, beta: null, notes: 'Soft tier clamps applied in-handler: on community tier the PUT handler clamps piiDetectionAction → "block" (pii_tokenize gate) and forces webSearchGuardEnabled → false (web_search_guard gate). Stored row is preserved across upgrades. See server/routes/orgPrivacyShield.js.' },
    '/api/reminders': { gate: null, beta: null, notes: 'Core community feature' },
    '/api/ai-tasks': { gate: 'agent_routines', beta: 'agent_routines', notes: 'Community (n8n-style free builder) — Agent Routines (Studio → Routines), scheduled recurring agent runs. `agentId` mode checks the agent_routines beta inside the handler; both licence + beta are Community.' },
    // Reserve boundary — no route consumes this yet. Org-wide sharing of
    // automations/routines is the paid collaboration line (Enterprise).
    '/api/automation/*/share': { gate: 'automation_sharing', beta: null, notes: 'Enterprise (collaboration): sharing a routine with people or groups (roles run / view / edit), routes/automation/sharing.js. A PER-ROUTE gate on PUT /:id/shares (requireCapability, 403 feature_locked), not a router.use: reading the list (GET /:id/shares, /:id/principals) and transferring ownership stay owner-level and ungated, so a lapsed licence can still see and remove who has access.' },
    '/api/automation/*/activate': { gate: null, beta: null, notes: 'IN-HANDLER (routes/automation/activate.js checkBeforeLive via automation/licensedSteps.js), shared by POST /:id/activate and /:id/publish. A guard or tokenize step not in the live version needs automation_privacy_steps; every approval step needs approvals and every fill_document step needs studio_documents (the runner refuses those anyway). Asked of the routine OWNER. 403 with a readable `error`, `code` feature_locked or feature_disabled, `feature`, `details` per step; 503 code entitlement_unavailable when the plan cannot be read. NOT gated: re-activating or publishing privacy steps already live, untokenize, deactivate.' },
    '/api/automation/*/run': { gate: null, beta: null, notes: 'IN-HANDLER (routes/automation/runs.js, webhooksAndRunOps.js retry, automation/licensedSteps.refusalForRun): runs of the WORKING copy (test runs, never-live routines, /dry-run, /steps/:stepId/run, retries of such runs, the AI tool builder_request_dry_run) need automation_privacy_steps for guard or tokenize steps not in the live version. Runs of the live copy are never refused; no runtime gate on guard, tokenize or untokenize.' },
    '/api/datatables': { gate: 'automations', beta: 'automations', notes: 'Community (n8n-style free builder) — organisation-scoped tables routines read and write: CRUD plus rows.' },
    '/api/datatables/*/sharing': { gate: 'automation_sharing', beta: null, notes: 'Enterprise (collaboration) — publishing or granting a datatable. A PER-ROUTE gate, not a router.use: the /api/datatables mount itself is Community. DELIBERATELY UNGATED (drain exemption, same shape as the approvals note above): GET /:id, /:id/rows and every row write on a table the caller already holds a grade on — a licence lapse must never turn a nightly routine into a silent hole in the org data. What a lapse refuses is NEW sharing. Removing a grant is ungated too: taking access away must always be possible. Also ungated: PUT /:id/sharing with audience private and/or writeMode grants (sharing.js onlyNarrows).' },
    '/api/datatables/*': { gate: 'datatable_retention', beta: null, notes: 'IN-HANDLER, retention only: PATCH /:id (routes/datatables/metadata.js widensRetention) and POST /managed above the kind default refuse setting, lengthening or moving a retention window (403 feature_locked); shortening or switching it off is always free; jobs/datatableRetention.js is never gated.' },
    '/api/kb': { gate: null, beta: null, notes: 'Knowledge base is community-tier; max_kb_sources limit enforces caps' },
    '/api/kb/*/sources': { gate: 'kb_datatable_sources', beta: null, notes: 'IN-HANDLER (routes/knowledgeBases/sources.js): kind datatable needs kb_datatable_sources; refresh mode schedule (create or PATCH) needs kb_scheduled_refresh. Rename, refresh now, manual and delete are never gated; existing datatable sources keep syncing (deletions included); jobs/kbSourceRefresh.js runs a due scheduled pass once without kb_scheduled_refresh and does not re-arm it.' },
    '/api/kb/*/duplicate': { gate: 'kb_datatable_sources', beta: null, notes: 'IN-HANDLER (routes/knowledgeBases/create.js, ?withSources=1): without the licences datatable sources are skipped and schedules are copied as manual; the response names them in sourcesNotCopied, sourcesMadeManual and notes.' },
    '/api/studio-documents': { gate: null, beta: null, notes: 'Mount ungated; per-route requireCapability(studio_documents) on create, edit, AI, draft preview, restore, folder create, duplicate and sections (routes/studioDocuments.js documentsGate). Reading, preview, validate, PDF and .pptx downloads, the versions list, DELETE, folder list and delete, and /house-style stay open; GET /:id answers editable:false without it. The same capability gates the chat document tools, the fill_document runner step (license_required) and the builders\' document catalogue.' },

    // ── License / billing admin routes (auth + per-handler RBAC) ─────
    '/api/license': { gate: null, beta: null, notes: 'Activate/refresh/deactivate; per-handler isOrgAdmin checks. POST /activate splits org vs consumer vs server scope (server scope = install-wide override, super-admin + self-hosted only) and CANNOT be hoisted to router-level requireAdmin without breaking consumer self-activation. DELETE /deactivate?scope=server removes the server-wide override.' },
    '/api/admin/licenses': { gate: null, beta: null, notes: 'Admin-only license issuance; super-admin gate inside the router' },
    '/api/subscriptions': { gate: null, beta: null, notes: 'Mixed admin + org-member endpoints; per-handler requireAuthOrOrgMember' },
    '/api/stripe': { gate: null, beta: null, notes: 'Checkout/portal + webhook; webhook uses signature verification' },
    '/api/billing': { gate: null, beta: null, notes: 'Public plan listing' },
};
