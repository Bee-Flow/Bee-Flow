// @typecheck
'use strict';
/**
 * Beta feature catalogue: the static registry (BETA_FEATURES, BetaLifecycle),
 * the remote-module additions and the pure lookups over them. No I/O and no
 * dependency on licence, stores or entitlements, so the licence module can read
 * it without closing an import loop. betaFeatures.js re-exports all of it.
 */
const log = require('../../telemetry/log');
const { bestEffort } = require('../../utils/bestEffort');

// ──────────────────────────────────────────────
// Beta Feature Registry
// Add new features here. This is the single source of truth.
// ──────────────────────────────────────────────
// `licenseFeature` (optional): if set, this beta is COMPOUND-gated — both
// the licence feature AND the beta flag must be true for the UI to show
// the feature. /auth/my-permissions derives `canUseFeature` from this so
// the frontend never has to reimplement the AND.
//
// `lifecycle` (optional, default 'beta'): drives admin UI labelling and
// auto-enable behaviour. Values:
//   - 'experimental' — internal-only / not advertised; super-admin only
//   - 'beta'         — opt-in per org; default state
//   - 'ga'           — generally available; auto-enabled for every org
//                      on a plan that allows it (org admin can still
//                      disable, but doesn't have to opt in)
//   - 'deprecated'   — slated for removal; UI shows sunset banner
//
// `groupScoped` (optional, default false): the org-access menu alone does NOT
// hand this beta to every member. It reaches "All members" only while its id
// is in the org's everyone-list (organizations.org_beta_everyone; NULL = every
// group-scoped beta, so orgs that never chose keep the old behaviour), and
// otherwise only the groups the org admin granted it to. See buildOrgGrant in
// entitlements.js and writeOrgAccessGrants in auth/admin/featureAccessRoutes.js.
const BetaLifecycle = Object.freeze({
    EXPERIMENTAL: 'experimental',
    BETA: 'beta',
    GA: 'ga',
    DEPRECATED: 'deprecated',
});

const BETA_FEATURES = [
    { id: 'meeting_notes', name: 'Meeting Notes', description: 'Audio transcription, meeting summaries, and action item extraction', licenseFeature: 'meeting_notes', lifecycle: BetaLifecycle.GA, groupScoped: true },
    { id: 'advanced_analytics', name: 'Advanced Analytics', description: 'Extended analytics dashboards and reporting', licenseFeature: 'advanced_analytics', lifecycle: BetaLifecycle.GA },
    { id: 'custom_themes', name: 'Custom Themes', description: 'Organization-level custom branding and theme support', licenseFeature: 'custom_themes', lifecycle: BetaLifecycle.BETA },
    { id: 'skills', name: 'Skills', description: 'Reusable instruction packs for consistent AI task execution', licenseFeature: 'skills', lifecycle: BetaLifecycle.GA },
    { id: 'flow', name: 'Flow Model Tier', description: 'Multi-stage orchestration chat tier ("Flow") that bootstraps chat-local session skills. Requires the Skills feature to function.', lifecycle: BetaLifecycle.BETA },
    { id: 'voice_chat', name: 'Voice Chat (Beta)', description: 'Realtime voice conversation with direct chat or agents, powered by Mistral Voxtral (STT + TTS). Requires a configured Mistral API key.', licenseFeature: 'voice_chat', lifecycle: BetaLifecycle.BETA },
    { id: 'swarm', name: 'Swarm Agents', description: 'Multi-agent swarms (Deep Research, etc.) that run specialised AI workers in parallel phases and synthesise a single answer. Workers share findings via a Hive Mind notebook.', licenseFeature: 'swarm', lifecycle: BetaLifecycle.BETA },
    { id: 'webpages', name: 'Webpages', description: 'AI-built full-stack web apps. Vanilla (HTML/CSS/JS) or React + Material UI projects with a real per-page database, a sandboxed acts-as-author backend (integrations + automations), live preview, auto-versioning, KB-grounded AI chat, publishing/sharing, and ZIP download.', licenseFeature: 'webpages', lifecycle: BetaLifecycle.GA },
    // n8n-style free builder: GA (auto-on, no opt-in panel) and Community-
    // licensed. The blanket BETA_TIER_FLOOR short-circuit in getUserBetaFeatures
    // is exempted for GA betas whose licenceFeature is in the Community tier, so
    // these light up on a Community install while every other beta stays
    // Enterprise. Building automations is free; sharing them across a team
    // (`automation_sharing`) and team workspaces (`projects`) stay Enterprise.
    { id: 'automations', name: 'Automations', description: 'Conversational no-code automation builder. Users describe an automation in chat; the AI assembles a typed DAG that mixes scheduled triggers, integration actions, AI reasoning steps, conditions, loops, and notifications. Includes dry-run preview, run history, and webhook + app-event triggers.', licenseFeature: 'automations', lifecycle: BetaLifecycle.GA },
    { id: 'agent_routines', name: 'Agent schedules', description: 'Schedule recurring tasks that run through a specific agent. The schedule fires the agent on a cron-like schedule with the full agent runtime (system prompt, attached skills, knowledge bases, integrations) and saves the result to a persistent chat thread.', licenseFeature: 'agent_routines', lifecycle: BetaLifecycle.GA },
    // Security Scan is no longer a built-in beta: it ships as a downloadable
    // .bfmod (Hub marketplace) that registers its own beta descriptor at install
    // time via setRemoteBetaFeatures(). Its license feature stays in tiers.js
    // (enterprise) so self-hosted tier-gating for the remote beta still resolves.
    { id: 'support_inbox', name: 'Customer Support Inbox (Beta)', description: 'Run your own customer-support desk in the Studio: connect support mailbox(es) (Gmail/Outlook), turn inbound email into tickets, and reply with an AI agent grounded in your knowledge base. Configurable per inbox (draft / auto-send / autonomous) with SLA, assignment, and an automation template that distils solved tickets into KB articles.', licenseFeature: 'support_inbox', lifecycle: BetaLifecycle.BETA },
    { id: 'mcp_marketplace', name: 'MCP Server Marketplace', description: 'Browse, install and manage Model Context Protocol (MCP) servers (GitHub, Slack, Postgres, Playwright, and dozens more) to extend AI agent capabilities. Installed servers expose their tools to agents in chat. Enterprise beta — a later implementation still stabilising.', licenseFeature: 'mcp_marketplace', lifecycle: BetaLifecycle.BETA },
    // App Studio — GA (auto-on, no opt-in panel; Enterprise-licensed). GA just
    // means no per-org beta opt-in gates viewers; the
    // app_studio licence feature (tiers.js, enterprise) still gates the whole
    // surface, so anyone who can be an app's audience already holds it.
    { id: 'app_studio', name: 'App Studio', description: 'Build internal apps in the Studio — like PowerApps, but easier. Describe the app and the AI builds the whole thing: it designs a data model (tables, fields, relations), seeds sample data, wires forms/grids/charts/kanban to that data, sets up roles and row-level access, and proposes an editable plan first for larger apps. Then tweak everything visually — a live component ribbon, sliders, colour pickers, drag-and-drop, formulas and validation. Actions run your Automations, create/update records, or call external data connectors. Publish finished apps to your organisation or specific groups.', licenseFeature: 'app_studio', lifecycle: BetaLifecycle.GA },
    // Learning Center (Bee Flow Academy) — courses, AI coach, badges and shareable
    // certificates. GA (stable, not a "beta") so it can be toggled per subscription
    // plan via "Included beta features" yet still ships on self-hosted: the licence
    // feature `learning_center` sits in the community tier (see tiers.js), so the
    // self-hosted GA-community filter includes it. On cloud the subscription's
    // allowed_beta_features is the sole authority (compound check removed).
    { id: 'learning_center', name: 'Learning Center', description: 'Bee Flow Academy — hands-on courses with an AI coach, badges, XP levels, and shareable completion certificates. Gates the Settings → Learning Center page, the lesson player, and the achievements/certificate APIs.', licenseFeature: 'learning_center', lifecycle: BetaLifecycle.GA },
    // Academy custom courses — org-authored content (slides/quizzes/exercises
    // only; no tour steps, those need code-bound DOM anchors). Quiz answer keys
    // and exercise rubrics live server-side in learningContentStore; published
    // courses overlay the built-in catalog via GET /ai/learning/catalog.
    { id: 'learning_custom_content', name: 'Academy Custom Courses (Beta)', description: 'Let org admins author their own Academy courses (slides, quizzes, AI-coached exercises) in Settings → Organisation → Academy. Published courses appear in members\' Learning Center alongside the built-in catalog; quiz answers and exercise rubrics stay server-side. Requires the Learning Center.', licenseFeature: 'learning_center', lifecycle: BetaLifecycle.BETA },
    // Compliance Hub — GA (stable, not a "beta") so it can be enabled/disabled
    // PER SUBSCRIPTION PLAN on cloud via "Included beta features", exactly like
    // the Learning Center above. The id deliberately EQUALS the licence feature
    // (`compliance_hub_gdpr`): this beta row claims the id in the capability
    // registry, so the server mount (requireCapability in server/index.js), the
    // modules catalog entry and every SPA useCan('compliance_hub_gdpr') call
    // site keep resolving unchanged — only the capability's KIND moves from
    // core to beta. Cloud: the plan's allowed_beta_features is the sole
    // authority (null ⇒ included; restricted list ⇒ only when listed — the
    // one-shot in migrations/compliance-plan-flag-2026-09.js grandfathers
    // existing pro/enterprise plans). Self-hosted: unchanged — the enterprise
    // tier gets all betas and the compound licence term is satisfied because
    // compliance_hub_gdpr stays in tiers.js enterprise.
    { id: 'compliance_hub_gdpr', name: 'Compliance Hub', description: 'GDPR, AI Act and ISO 27001 compliance center: automated readiness checks, ROPA generation, DPIA and DSR handling, incident registry with 72h clocks, score history and audit-ready PDF exports. Gates the whole /api/compliance surface and the Compliance section in org settings.', licenseFeature: 'compliance_hub_gdpr', lifecycle: BetaLifecycle.GA },
    // AI Integration Builder — deliberately NO licenseFeature: on cloud the
    // plan's allowed_beta_features is the sole authority; on self-hosted the
    // enterprise tier gets all betas. The built integrations themselves are
    // granted as ordinary 'custom:<uuid>' integration capabilities (see
    // capabilityRegistry.listCustomIntegrationCapabilities) — this beta gates
    // only the builder surface and the per-org ceiling injection.
    { id: 'ai_integration_builder', name: 'AI Integration Builder', description: 'Org admins build custom org-scoped integrations (REST or remote MCP) with an AI builder agent. Gates the builder UI and APIs; built integrations are granted like normal integrations.', lifecycle: BetaLifecycle.BETA },
];

function getFeatureLifecycle(featureOrId) {
    const f = typeof featureOrId === 'string'
        ? BETA_FEATURES.find(x => x.id === featureOrId)
        : featureOrId;
    return f?.lifecycle || BetaLifecycle.BETA;
}

// Log a startup warning for every feature with a sunsetDate in the past
// (or close to it). Operators see this once per boot — meant as a nudge,
// not a runtime gate. The matching `lifecycle: 'deprecated'` entries can
// be deleted from the registry after the sunsetDate has elapsed across
// all environments.
(function _logSunsetWarnings() {
    try {
        const now = Date.now();
        const WARN_AHEAD_MS = 30 * 24 * 60 * 60 * 1000; // 30 days
        for (const f of BETA_FEATURES) {
            if (!f.sunsetDate) continue;
            const sunset = Date.parse(f.sunsetDate);
            if (!Number.isFinite(sunset)) continue;
            if (sunset <= now) {
                log.warn(`[BetaFeatures] '${f.id}' is past its sunset date (${f.sunsetDate}). Safe to remove from registry.`);
            } else if (sunset - now < WARN_AHEAD_MS) {
                const days = Math.ceil((sunset - now) / (24 * 60 * 60 * 1000));
                log.warn(`[BetaFeatures] '${f.id}' sunsets in ${days} day(s) (${f.sunsetDate}). Schedule removal.`);
            }
        }
    } catch (err) { bestEffort('core/entitlements/betaCatalog:anon', err); /* never block boot for a banner */ }
})();

// ── Remote-module beta features ────────────────────────────────────────────
// Downloadable modules may ship 'beta'-kind capabilities. packageLoader pushes
// the union of every ACTIVE remote module's beta descriptors here. They are
// folded into listBetaFeatures() (so org enablement + enumeration see them) but
// are stamped `_remoteModule:true` so capabilityRegistry.build() SKIPS them —
// they project through the registry's dynamic remote-module path instead, which
// avoids double-listing the same id.
let _remoteBetaFeatures = [];

function setRemoteBetaFeatures(list) {
    _remoteBetaFeatures = Array.isArray(list)
        ? list.filter(f => f && f.id).map(f => ({
            id: f.id,
            name: f.name || f.id,
            description: f.description || '',
            lifecycle: f.lifecycle || BetaLifecycle.BETA,
            licenseFeature: f.licenseFeature || null,
            _remoteModule: true,
        }))
        : [];
}

function listRemoteBetaFeatures() {
    return _remoteBetaFeatures.slice();
}

function listBetaFeatures() {
    return _remoteBetaFeatures.length ? BETA_FEATURES.concat(_remoteBetaFeatures) : BETA_FEATURES.slice();
}

function listCompoundGatedFeatures() {
    return BETA_FEATURES.filter(f => !!f.licenseFeature && !f.deprecated);
}

module.exports = {
    BETA_FEATURES,
    BetaLifecycle,
    getFeatureLifecycle,
    setRemoteBetaFeatures,
    listRemoteBetaFeatures,
    listBetaFeatures,
    listCompoundGatedFeatures,
};
