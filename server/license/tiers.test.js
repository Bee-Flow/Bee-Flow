/**
 * Unit tests for license/tiers.js
 *
 * Run: node license/tiers.test.js
 */

const assert = require('assert');
const t = require('./tiers');

// ── Hierarchy & validity ────────────────────────────────────────────────
assert.deepStrictEqual(t.TIER_HIERARCHY, ['community', 'enterprise', 'full']);
assert.strictEqual(t.isValidTier('community'), true);
assert.strictEqual(t.isValidTier('enterprise'), true);
assert.strictEqual(t.isValidTier('full'), true);
assert.strictEqual(t.isValidTier('pro'), true, 'legacy pro tier must still be accepted as input');
assert.strictEqual(t.isValidTier('starter'), false);
assert.strictEqual(t.isValidTier(undefined), false);
assert.strictEqual(t.isValidTier(null), false);

// ── Legacy tier normalisation ───────────────────────────────────────────
assert.strictEqual(t.normalizeTier('pro'), 'enterprise', 'legacy pro must map to enterprise');
assert.strictEqual(t.normalizeTier('community'), 'community');
assert.strictEqual(t.normalizeTier('enterprise'), 'enterprise');
assert.strictEqual(t.normalizeTier('full'), 'full');
assert.strictEqual(t.normalizeTier('bogus'), 'bogus', 'unknown tiers pass through unchanged');

// ── Rank ────────────────────────────────────────────────────────────────
assert.strictEqual(t.tierRank('community'), 0);
assert.strictEqual(t.tierRank('enterprise'), 1);
assert.strictEqual(t.tierRank('full'), 2);
assert.strictEqual(t.tierRank('pro'), 1, 'legacy pro ranks as enterprise');
assert.strictEqual(t.tierRank('bogus'), -1);

// ── tierAtLeast ─────────────────────────────────────────────────────────
assert.strictEqual(t.tierAtLeast('enterprise', 'community'), true);
assert.strictEqual(t.tierAtLeast('enterprise', 'enterprise'), true);
assert.strictEqual(t.tierAtLeast('community', 'enterprise'), false);
assert.strictEqual(t.tierAtLeast('full', 'enterprise'), true);
assert.strictEqual(t.tierAtLeast('pro', 'enterprise'), true, 'legacy pro satisfies enterprise');
assert.strictEqual(t.tierAtLeast('pro', 'community'), true);
assert.strictEqual(t.tierAtLeast('bogus', 'community'), false, 'unknown actual tier should not satisfy any requirement');
assert.strictEqual(t.tierAtLeast('community', 'bogus'), false, 'unknown required tier should be rejected');

// ── Feature inheritance ─────────────────────────────────────────────────
const community = t.getFeaturesForTier('community');
const enterprise = t.getFeaturesForTier('enterprise');
const full = t.getFeaturesForTier('full');

// Community is the free self-hosted core: chat + KB + Nextcloud + multi-user
// + the free builder + personal webpages. Studio-class capabilities (voice,
// meeting notes, ticket assistant, notebooks, component designer, projects,
// skills), the advanced Privacy Shield modes (tokenize PII, web-search guard),
// and the non-overview Usage tabs are Enterprise — see
// docs/docs/licensing/tiers.md.
assert.ok(community.includes('chat_basic'));
assert.ok(community.includes('kb_local_small'));
assert.ok(community.includes('kb_unlimited'), 'community must include kb_unlimited');
assert.ok(community.includes('nextcloud_basic'));
assert.ok(community.includes('nextcloud_oauth'));
assert.ok(community.includes('single_user_login'));
assert.ok(community.includes('multi_user'), 'community must include multi_user');
// Enterprise split (2026-10): skills is Enterprise. It is a non-GA beta, so a
// Community install never had it at runtime; the tier list now says so too.
assert.ok(!community.includes('skills'), 'community must NOT include skills (Enterprise since the enterprise split)');
assert.ok(enterprise.includes('skills'), 'enterprise must include skills');
// Personal webpages are free: building your own pages is Community, sharing
// them (webpage_sharing, below) is the paid act.
assert.ok(community.includes('webpages'), 'community must include personal webpages');
// All built-in integrations + the MCP marketplace are part of the free
// Community core (declarative markers — integration usage is ungated at
// runtime). Guard against a future edit silently gating them behind Enterprise.
assert.ok(community.includes('integrations'), 'community must include all built-in integrations');
// n8n-style free builder: the Automation builder + Agent Routines are part of
// the free Community core (n8n Community Edition ships the workflow builder
// gratis; only collaboration is paid). What stays Enterprise is org-wide
// automation SHARING (`automation_sharing`) and team workspaces (`projects`).
assert.ok(community.includes('automations'), 'community must include the automation builder (n8n-style free builder)');
assert.ok(community.includes('agent_routines'), 'community must include agent routines (n8n-style free builder)');
// MCP server marketplace is an ENTERPRISE feature (an enterprise beta) — it must
// NOT be in community. See server/core/betaFeatures.js + the /ai/mcp-servers
// route gates + the directChatToolStack runtime guard.
assert.ok(!community.includes('mcp_marketplace'), 'community must NOT include the MCP marketplace (enterprise)');
assert.ok(enterprise.includes('mcp_marketplace'), 'enterprise must include the MCP marketplace');

// Promoted to Enterprise — must NOT be in community. (automations +
// agent_routines were demoted BACK to community above — n8n-style free builder.)
for (const f of [
    'voice_chat',
    'meeting_notes',
    'component_designer',
    'notebooks',
    'projects',
    'pii_tokenize',
    'web_search_guard',
    'custom_data_types',
    'advanced_usage_monitoring',
]) {
    assert.ok(!community.includes(f), `community must NOT include promoted feature ${f}`);
}

// The enterprise split (2026-10): six paid capabilities, each ALSO a GA beta
// whose id equals the licence feature (core/entitlements/betaFeatures.js).
// Listed in the enterprise tier ONLY — a community entry would make the
// self-hosted GA-community filter hand them to every Community install.
const ENTERPRISE_SPLIT = [
    'automation_privacy_steps',
    'studio_documents',
    'webpage_sharing',
    'datatable_retention',
    'kb_datatable_sources',
    'kb_scheduled_refresh',
];
for (const f of ENTERPRISE_SPLIT) {
    assert.ok(enterprise.includes(f), `enterprise must include ${f}`);
    assert.ok(!community.includes(f), `community must NOT include ${f}`);
    assert.ok(t.TIER_FEATURES.enterprise.includes(f), `${f} is declared in TIER_FEATURES.enterprise itself`);
}

// The paid collaboration boundary for the free builder: org-wide sharing of
// automations/routines stays Enterprise (reserve flag — no route consumes it
// yet, but the boundary is pinned so a future sharing feature lands gated).
assert.ok(!community.includes('automation_sharing'), 'community must NOT include automation sharing (collaboration is paid)');
assert.ok(enterprise.includes('automation_sharing'), 'enterprise must include automation sharing');

// Compliance / admin / resale flags stay out of community.
assert.ok(!community.includes('guardrails_dlp'), 'community must NOT include enterprise features');
assert.ok(!community.includes('sso_saml'));
assert.ok(!community.includes('white_label'));

// Enterprise inherits community + adds the promoted Studio features + the
// compliance/admin block.
for (const f of community) assert.ok(enterprise.includes(f), `enterprise should inherit community feature ${f}`);
// automations + agent_routines are asserted on enterprise via the community
// inheritance loop above (they're community features now). Enterprise's own
// adds below include the paid collaboration boundary `automation_sharing`.
for (const f of [
    'automation_sharing',
    'voice_chat',
    'webpages',
    'meeting_notes',
    'component_designer',
    'notebooks',
    'projects',
    'pii_tokenize',
    'web_search_guard',
    'custom_data_types',
    'advanced_usage_monitoring',
    'guardrails_dlp',
    'compliance_hub_gdpr',
    'compliance_hub_aia',
    'compliance_hub_iso27001',
    'sso_saml',
    'audit_log_export',
    'custom_themes',
    'swarm',
    'advanced_analytics',
]) {
    assert.ok(enterprise.includes(f), `enterprise must include ${f}`);
}
assert.ok(!enterprise.includes('white_label'), 'enterprise must NOT include resale features');

// Compliance Center: all eleven per-framework capabilities are enterprise;
// none of the eight new ones leaks into community (they would otherwise be
// free on self-hosted and never `ceiling`-locked on cloud).
const COMPLIANCE_CAPS = [
    'compliance_hub_gdpr', 'compliance_hub_aia', 'compliance_hub_iso27001',
    'compliance_hub_nis2', 'compliance_hub_cra', 'compliance_hub_data_act', 'compliance_hub_pld',
    'compliance_hub_eaa', 'compliance_hub_dora', 'compliance_hub_machinery', 'compliance_hub_custom',
];
assert.strictEqual(COMPLIANCE_CAPS.length, 11);
for (const f of COMPLIANCE_CAPS) assert.ok(enterprise.includes(f), `enterprise must include ${f}`);
for (const f of COMPLIANCE_CAPS.slice(3)) assert.ok(!community.includes(f), `community must NOT include ${f}`);
assert.strictEqual(new Set(enterprise).size, enterprise.length, 'no duplicate feature ids in the enterprise tier');

// Full inherits enterprise + adds resale/branding.
for (const f of enterprise) assert.ok(full.includes(f), `full should inherit enterprise feature ${f}`);
assert.ok(full.includes('white_label'));
assert.ok(full.includes('beeflow_internal_features'));
assert.ok(full.includes('license_issuance'));

// Legacy pro resolves to enterprise's feature set.
const legacyPro = t.getFeaturesForTier('pro');
assert.deepStrictEqual(legacyPro.sort(), enterprise.slice().sort(), 'legacy pro must expose the enterprise feature set');

// Invalid tier → community fallback
assert.deepStrictEqual(t.getFeaturesForTier('bogus'), community);

// ── Limits ──────────────────────────────────────────────────────────────
// Community is uncapped — same shape as enterprise / full.
const cl = t.getLimitsForTier('community');
assert.strictEqual(cl.max_users, -1, 'community is uncapped on users');
assert.strictEqual(cl.max_agents, -1);
assert.strictEqual(cl.max_messages_per_month, -1);
assert.strictEqual(cl.max_kb_sources, -1);

const el = t.getLimitsForTier('enterprise');
assert.strictEqual(el.max_users, -1, 'enterprise unlimited');
assert.strictEqual(el.max_agents, -1);

const fl = t.getLimitsForTier('full');
assert.strictEqual(fl.max_users, -1);

// Legacy pro returns enterprise limits.
const pl = t.getLimitsForTier('pro');
assert.strictEqual(pl.max_users, -1, 'legacy pro limits resolve to enterprise');

// Returns a copy, not the live reference.
const l1 = t.getLimitsForTier('community');
l1.max_agents = 999;
assert.strictEqual(t.getLimitsForTier('community').max_agents, -1, 'getLimitsForTier should return a fresh object');

// ── tierHasFeature ──────────────────────────────────────────────────────
assert.strictEqual(t.tierHasFeature('community', 'chat_basic'), true);
assert.strictEqual(t.tierHasFeature('community', 'skills'), false, 'skills is enterprise');
assert.strictEqual(t.tierHasFeature('enterprise', 'skills'), true, 'enterprise gets skills');
assert.strictEqual(t.tierHasFeature('community', 'integrations'), true, 'built-in integrations are community');
assert.strictEqual(t.tierHasFeature('community', 'mcp_marketplace'), false, 'MCP marketplace is enterprise');
assert.strictEqual(t.tierHasFeature('enterprise', 'mcp_marketplace'), true, 'MCP marketplace is enterprise');
// n8n-style free builder: automations + agent routines are Community.
assert.strictEqual(t.tierHasFeature('community', 'agent_routines'), true, 'agent_routines is a Community free-builder feature');
assert.strictEqual(t.tierHasFeature('community', 'automations'), true, 'automations is a Community free-builder feature');
// Paid collaboration boundary: org-wide automation sharing stays Enterprise.
assert.strictEqual(t.tierHasFeature('community', 'automation_sharing'), false, 'automation sharing is enterprise (collaboration is paid)');
assert.strictEqual(t.tierHasFeature('enterprise', 'automation_sharing'), true, 'enterprise gets automation sharing');
assert.strictEqual(t.tierHasFeature('community', 'voice_chat'), false, 'voice_chat is enterprise');
assert.strictEqual(t.tierHasFeature('community', 'webpages'), true, 'personal webpages are community');
assert.strictEqual(t.tierHasFeature('community', 'webpage_sharing'), false, 'sharing a webpage is enterprise');
assert.strictEqual(t.tierHasFeature('enterprise', 'webpage_sharing'), true, 'enterprise gets webpage sharing');
assert.strictEqual(t.tierHasFeature('community', 'meeting_notes'), false);
assert.strictEqual(t.tierHasFeature('community', 'component_designer'), false);
assert.strictEqual(t.tierHasFeature('community', 'notebooks'), false);
assert.strictEqual(t.tierHasFeature('community', 'projects'), false, 'projects is now enterprise');
assert.strictEqual(t.tierHasFeature('community', 'pii_tokenize'), false);
assert.strictEqual(t.tierHasFeature('community', 'web_search_guard'), false);
assert.strictEqual(t.tierHasFeature('community', 'advanced_usage_monitoring'), false);
assert.strictEqual(t.tierHasFeature('community', 'sso_saml'), false);
assert.strictEqual(t.tierHasFeature('enterprise', 'automations'), true, 'enterprise gets promoted features');
assert.strictEqual(t.tierHasFeature('enterprise', 'agent_routines'), true);
assert.strictEqual(t.tierHasFeature('enterprise', 'voice_chat'), true);
assert.strictEqual(t.tierHasFeature('enterprise', 'component_designer'), true);
assert.strictEqual(t.tierHasFeature('enterprise', 'notebooks'), true);
assert.strictEqual(t.tierHasFeature('enterprise', 'projects'), true);
assert.strictEqual(t.tierHasFeature('enterprise', 'pii_tokenize'), true);
assert.strictEqual(t.tierHasFeature('enterprise', 'web_search_guard'), true);
assert.strictEqual(t.tierHasFeature('enterprise', 'advanced_usage_monitoring'), true);
assert.strictEqual(t.tierHasFeature('enterprise', 'sso_saml'), true);
assert.strictEqual(t.tierHasFeature('full', 'white_label'), true);
assert.strictEqual(t.tierHasFeature('enterprise', 'white_label'), false);
assert.strictEqual(t.tierHasFeature('pro', 'sso_saml'), true, 'legacy pro inherits enterprise features');
assert.strictEqual(t.tierHasFeature('pro', 'automations'), true, 'legacy pro must keep automations via enterprise');
assert.strictEqual(t.tierHasFeature('pro', 'notebooks'), true, 'legacy pro must keep notebooks via enterprise');
assert.strictEqual(t.tierHasFeature('pro', 'agent_routines'), true, 'legacy pro must keep agent_routines via enterprise');
assert.strictEqual(t.tierHasFeature('pro', 'projects'), true, 'legacy pro must keep projects via enterprise');
assert.strictEqual(t.tierHasFeature('bogus', 'chat_basic'), true, 'invalid tier falls back to community');
assert.strictEqual(t.tierHasFeature('bogus', 'automations'), true, 'invalid tier falls back to community (automations is now a community feature)');
assert.strictEqual(t.tierHasFeature('bogus', 'voice_chat'), false, 'invalid tier falls back to community (no enterprise features)');

console.log('✓ license/tiers.test.js — all assertions passed');
