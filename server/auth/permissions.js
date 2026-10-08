// @typecheck
/**
 * Permissions, Middleware & Config
 *
 * RBAC system with group/role resolution, middleware factories,
 * and auth config load/save via configStore.
 *
 * Studio authorization helpers:
 *   - assertUserCanUseOrg(req, orgId)   — validates that the requesting user
 *     belongs to `orgId` (or defaults to their primary org if omitted). Use
 *     on every create endpoint that accepts `organizationId` from the body.
 *   - validateSharedGroupsForOrg(orgId, ids, opts) — confirms every supplied
 *     group ID belongs to `orgId`. Use on every publish/share endpoint that
 *     mutates `shared_groups`. Pass `{requireNonEmpty: true}` when the caller
 *     asked for GROUP-scoped sharing specifically: an empty `shared_groups` on
 *     a published row means the WHOLE ORGANISATION, so handing [] back there
 *     would widen the audience while the person thought they narrowed it.
 *
 * Notes:
 *   - Automations (automations) are intentionally user-private and do not have
 *     `is_published` / `shared_groups` columns.
 *   - The legacy `knowledge_metadata` table (per-agent) is NOT the studio KB
 *     path. Studio KBs live in `knowledge_bases` and use the same
 *     org + is_published + shared_groups model as Agents and Webpages.
 *
 * No request schema lives here: this file declares gates, not routes. The one
 * body value it reads, `organizationId` in requireActiveOrg, can only ADD an
 * org to check (see there), and the route that mounts the gate owns the schema.
 */

const path = require('path');
const fs = require('fs');
const userStore = require('../stores/userStore');
const { tagGate } = require('./gateMeta');
const { orgScope } = require('./orgScope');
const log = require('../telemetry/log');

// ── Canonical role + permission identifiers ──────────────────────────────────
// String literals for these IDs are scattered across the codebase. New code
// should import from here; old call sites are migrated opportunistically.
// `LEGACY` aliases retain backwards-compat with rows that pre-date the
// 'admin' → 'org_admin' rename (matches the runtime normaliser at
// getUserPermissions ~ line 296).
const OrgRoles = Object.freeze({
    ORG_ADMIN: 'org_admin',
    DPO: 'dpo',
    AGENT_ADMIN: 'agent_admin',
    AGENT_EDITOR: 'agent_editor',
    MEMBER: 'member',
    // Legacy: pre-rename org admins. Always compare with ORG_ADMIN_VARIANTS,
    // never against this constant alone.
    LEGACY_ADMIN: 'admin',
});

const ORG_ADMIN_VARIANTS = Object.freeze([OrgRoles.ORG_ADMIN, OrgRoles.LEGACY_ADMIN]);

function isOrgAdminRole(orgRole) {
    return ORG_ADMIN_VARIANTS.includes(orgRole);
}

// System role values on users.role. 'admin' is the super-admin / platform
// root; 'user' is the default.
const SystemRoles = Object.freeze({
    SUPER_ADMIN: 'admin',
    USER: 'user',
});

// Canonical permission IDs. Keys match the entries declared in
// SYSTEM_PERMISSIONS below — adding a permission means appending it both
// to SYSTEM_PERMISSIONS (for the discovery API) and this constants map
// (for typesafe references from route code).
const Permissions = Object.freeze({
    ALL: 'all',
    PAGE_CHAT: 'page_chat',
    PAGE_SETTINGS: 'page_settings',
    ADMIN_AGENTS: 'admin_agents',
    ADMIN_AGENTS_CHAT: 'admin_agents_chat',
    ADMIN_AGENTS_SYSTEM: 'admin_agents_system',
    ADMIN_AGENTS_PIPELINE: 'admin_agents_pipeline',
    ADMIN_COMPONENTS: 'admin_components',
    ADMIN_AI_CONFIG: 'admin_ai_config',
    ADMIN_SECURITY: 'admin_security',
    ADMIN_MONITORING: 'admin_monitoring',
    ADMIN_COMPLIANCE: 'admin_compliance',
    ADMIN_SUBSCRIPTIONS: 'admin_subscriptions',
    ADMIN_SUPPORT: 'admin_support',
    MANAGE_USERS: 'manage_users',
    MANAGE_AGENTS: 'manage_agents',
    MANAGE_SKILLS: 'manage_skills',
    MANAGE_COMPONENTS: 'manage_components',
    MANAGE_KNOWLEDGE: 'manage_knowledge',
    MANAGE_APPS: 'manage_apps',
    // Org-level: read the WHOLE organisation's automation runs (Studio →
    // Runs & log, scope=org). Automations themselves stay user-private —
    // this grants a read of the run LOG, not access to anyone's automation.
    MANAGE_AUTOMATIONS: 'manage_automations',
    // Org-level: tenant customer-support inbox (Studio → Support). Distinct
    // from the super-admin ADMIN_SUPPORT (Bee Flow's own company inbox).
    SUPPORT_INBOX: 'support_inbox',
    USE_NOTEBOOKS: 'use_notebooks',
    USE_DATATABLES: 'use_datatables',
    MANAGE_DATATABLES: 'manage_datatables',
    USE_N8N_TOOLS: 'use_n8n_tools',
    MODIFY_N8N_WORKFLOWS: 'modify_n8n_workflows',
    // Org-role marker permissions (granted automatically by the matching
    // orgRole; useful when code wants to test "does this user behave as an
    // org_admin/agent_admin?" without coupling to the orgRole column).
    ORG_ADMIN: 'org_admin',
    AGENT_ADMIN: 'agent_admin',
    AGENT_EDITOR: 'agent_editor',
    DPO: 'dpo',
});

// System-wide permission definitions
const SYSTEM_PERMISSIONS = [
    // ── Super ──
    { id: 'all', name: 'Full Access', description: 'Grants all permissions', group: 'super' },

    // ── Pages (non-admin) ──
    { id: 'page_chat', name: 'Chat', description: 'Access the chat interface', group: 'pages' },
    { id: 'page_settings', name: 'Settings', description: 'Access user settings page', group: 'pages' },

    // ── Admin Pages ──
    { id: 'admin_agents', name: 'All Agents', description: 'Admin: Access to all agent types', group: 'admin' },
    { id: 'admin_agents_chat', name: 'Agent', description: 'Admin: Agent configuration', group: 'admin' },
    { id: 'admin_agents_system', name: 'System Agents', description: 'Admin: System agent configuration', group: 'admin' },
    { id: 'admin_agents_pipeline', name: 'Pipeline', description: 'Admin: Pipeline configuration', group: 'admin' },
    { id: 'admin_components', name: 'Components', description: 'Admin: Component builder', group: 'admin' },
    { id: 'admin_ai_config', name: 'AI Config', description: 'Admin: AI model configuration', group: 'admin' },
    { id: 'admin_security', name: 'Security', description: 'Admin: Users, SSO, guardrails', group: 'admin' },
    { id: 'admin_monitoring', name: 'Monitoring', description: 'Admin: Usage & cost monitoring', group: 'admin' },
    { id: 'admin_compliance', name: 'Compliance', description: 'Admin: GDPR & AI Act monitoring, DSR, ROPA, audit reports', group: 'admin' },
    { id: 'admin_subscriptions', name: 'Subscriptions', description: 'Admin: Subscription management', group: 'admin' },
    { id: 'admin_support', name: 'Customer Support', description: 'Admin: Bee Flow customer-support inbox (triage, reply, resolve)', group: 'admin' },

    // ── Actions ──
    { id: 'manage_users', name: 'Manage Users', description: 'Create, edit, and delete users', group: 'actions' },
    { id: 'manage_agents', name: 'Manage Agents', description: 'Create, edit, delete, and publish agents', group: 'actions' },
    { id: 'manage_skills', name: 'Manage Skills', description: 'Create, edit, delete, and share skills', group: 'actions' },
    { id: 'manage_components', name: 'Manage Components', description: 'Create and edit workflow components', group: 'actions' },
    { id: 'manage_knowledge', name: 'Manage Knowledge', description: 'Create, edit, delete, and ingest knowledge bases', group: 'actions' },
    { id: 'manage_apps', name: 'Manage Apps', description: 'Create and publish apps', group: 'actions' },
    { id: 'manage_automations', name: 'Manage Automations', description: "Org: see every automation's runs in the organisation's run log (Studio → Runs & log). Does not grant access to the automations themselves — those stay private to their owner.", group: 'actions' },
    { id: 'support_inbox', name: 'Support Inbox', description: 'Org: connect a support mailbox and triage, reply to, and resolve customer tickets in the Studio Support tab', group: 'actions' },
    { id: 'use_notebooks', name: 'Use Notebooks', description: 'Create, edit, and delete personal notebooks', group: 'actions' },
    { id: 'use_datatables', name: 'Use Datatables', description: 'Read and write rows in datatables shared with you, and run automation steps that use them', group: 'actions' },
    { id: 'manage_datatables', name: 'Manage Datatables', description: 'Create, change, share and delete datatables', group: 'actions' },

    // ── Studio ──
    // One permission per Studio section, so an organisation can decide from its
    // Roles screen who gets which part of the builder rather than the licence
    // alone deciding for everyone. They sit BESIDE the licence and capability
    // gates, never instead of them: an Enterprise licence says the feature
    // exists here, the role says who in the organisation may reach it.
    //
    // Agents, Skills, Knowledge and Datatables already had one (manage_agents /
    // manage_skills / manage_knowledge / use_datatables) and are not repeated.
    //
    // `use_webpages` is REVIVED rather than replaced. It was deprecated when
    // webpages moved to a per-org beta flag, but that flag answers "is this
    // organisation in the programme", which was never the same question as
    // "which of its people may publish a public page" — and the id has been in
    // the registry (and in existing role configs) the whole time.
    { id: 'use_webpages', name: 'Use Webpages', description: 'Design and publish public webpages in Studio', group: 'studio' },
    { id: 'use_automations', name: 'Use Automations', description: 'Build and run multi-step automations in the Automations builder', group: 'studio' },
    { id: 'use_approvals', name: 'Use Approvals', description: 'See the approvals waiting on you and the decisions you were part of', group: 'studio' },
    { id: 'use_apps', name: 'Use Apps', description: 'Open the internal apps published to you', group: 'studio' },
    { id: 'use_forms', name: 'Use Forms', description: 'See the forms published in the organisation and their public links', group: 'studio' },
    { id: 'use_solutions', name: 'Use Solutions', description: 'Bundle automations, apps and webpages into installable Solutions', group: 'studio' },
    { id: 'use_meeting_notes', name: 'Use Meeting Notes', description: 'Record and read meeting transcripts, speakers and actions', group: 'studio' },

    // ── n8n Integration ──
    { id: 'use_n8n_tools', name: 'Use n8n Tools', description: 'Run n8n webhook workflows and inspect workflow definitions via AI', group: 'actions' },
    { id: 'modify_n8n_workflows', name: 'Modify n8n Workflows', description: 'Allow AI to create, edit, delete, activate, and execute n8n workflows on behalf of the user', group: 'actions' },
];

/**
 * Capability grants that carry a UI permission with them.
 *
 * A group-scoped beta (betaFeatures.js `groupScoped`) is meant to be rolled
 * out per group from the Access matrix. Its Studio section is ALSO gated on a
 * role permission (studioApps.jsx, mobile studio registry), and the default
 * `member` role does not carry that permission — so a group grant alone left
 * the members it was meant for staring at a hidden section. Granting the
 * capability to a group therefore grants the matching permission to that
 * group's members. Everyone else keeps resolving it from their role exactly as
 * before, so the org's Roles screen still decides for org-wide access.
 */
const GROUP_GRANT_IMPLIED_PERMISSIONS = Object.freeze({
    meeting_notes: Object.freeze(['use_meeting_notes']),
});

// ── Load org role → permissions mapping from config file ──
let _orgRolePermissions = null;
function getOrgRolePermissions() {
    if (_orgRolePermissions) return _orgRolePermissions;
    try {
        const configPath = path.join(__dirname, '..', 'config', 'orgRoles.json');
        const raw = fs.readFileSync(configPath, 'utf-8');
        const config = JSON.parse(raw);
        // Transform { role: { permissions: [...] } } → { role: [...] }
        _orgRolePermissions = {};
        for (const [role, def] of Object.entries(config)) {
            _orgRolePermissions[role] = def.permissions || [];
        }
        return _orgRolePermissions;
    } catch (err) {
        log.error('[Auth] Failed to load orgRoles.json, using empty fallback:', err.message);
        return {};
    }
}

/**
 * The Microsoft scope set, in ONE place.
 *
 * It used to be a string literal copied into three files (this one, the vault
 * refresh in auth/automationAuth.js and the session refresh in
 * integrations/msGraphClient.js). A refresh that re-requests fewer scopes than
 * were granted silently downgrades the token, so every copy that fell out of
 * date was a grant quietly losing capabilities on its next refresh.
 */
const MICROSOFT_SCOPES = Object.freeze([
    'openid', 'email', 'profile', 'User.Read',
    'Mail.Read', 'Mail.Send',
    'Calendars.ReadWrite', 'Files.ReadWrite', 'Contacts.ReadWrite',
    // Teams meeting notes: ReadWrite to switch on recordAutomatically for a
    // meeting the user organizes, Recording to download the MP4 we transcribe.
    'OnlineMeetings.ReadWrite', 'OnlineMeetingTranscript.Read.All', 'OnlineMeetingArtifact.Read.All',
    'OnlineMeetingRecording.Read.All',
    'offline_access',
]);

/**
 * Scope string to send on a Microsoft refresh_token grant.
 *
 * Prefers whatever was ACTUALLY granted (stored on the credential) over our
 * default list: a user who consented to a wider set through an integration
 * connect flow — shared-mailbox scopes, say — must not have those stripped by a
 * refresh that only knows about the login scopes.
 */
function microsoftRefreshScope(grantedScope) {
    const granted = typeof grantedScope === 'string' ? grantedScope.trim() : '';
    return granted || MICROSOFT_SCOPES.join(' ');
}

// OAuth Provider Configurations
const OAUTH_PROVIDERS = {
    google: {
        name: 'Google',
        authUrl: 'https://accounts.google.com/o/oauth2/v2/auth',
        tokenUrl: 'https://oauth2.googleapis.com/token',
        userInfoUrl: 'https://openidconnect.googleapis.com/v1/userinfo',
        scopes: ['openid', 'email', 'profile', 'https://www.googleapis.com/auth/drive', 'https://www.googleapis.com/auth/gmail.readonly', 'https://www.googleapis.com/auth/gmail.send', 'https://www.googleapis.com/auth/gmail.compose', 'https://www.googleapis.com/auth/gmail.modify', 'https://www.googleapis.com/auth/calendar', 'https://www.googleapis.com/auth/presentations', 'https://www.googleapis.com/auth/spreadsheets', 'https://www.googleapis.com/auth/documents', 'https://www.googleapis.com/auth/contacts', 'https://www.googleapis.com/auth/contacts.readonly', 'https://www.googleapis.com/auth/meetings.space.readonly', 'https://www.googleapis.com/auth/meetings.space.settings']
    },
    microsoft: {
        name: 'Microsoft',
        authUrl: (tenantId) => `https://login.microsoftonline.com/${tenantId || 'common'}/oauth2/v2.0/authorize`,
        tokenUrl: (tenantId) => `https://login.microsoftonline.com/${tenantId || 'common'}/oauth2/v2.0/token`,
        userInfoUrl: 'https://graph.microsoft.com/v1.0/me',
        scopes: MICROSOFT_SCOPES
    },
    nextcloud: {
        name: 'Nextcloud',
        // Dynamic URLs based on config
        scopes: []
    },
    // Withings is an INTEGRATION provider, not an SSO identity provider: there
    // is no /auth/login/withings branch and no user is ever created from it.
    // The entry lives here so the connector route
    // (routes/integrations/withings.js) and the vault refresher
    // (auth/automationAuth.js refreshWithings) read one set of endpoints. The
    // client id/secret are admin-global secrets in configStore
    // (`withings_client_id` / `withings_client_secret`, the LinkedIn pattern),
    // NOT config.providers — that object drives the SSO login screen.
    //
    // Two Withings deviations from plain OAuth2, handled by both callers:
    //   • the token endpoint needs `action=requesttoken` in the form body;
    //   • a 200 response can still be a failure — `status` must be 0, and the
    //     tokens live one level down under `body`.
    withings: {
        name: 'Withings',
        authUrl: 'https://account.withings.com/oauth2_user/authorize2',
        tokenUrl: 'https://wbsapi.withings.net/v2/oauth2',
        apiBase: 'https://wbsapi.withings.net',
        scopes: ['user.info', 'user.metrics', 'user.activity'],
        ssoLogin: false,
    }
};

// Load config from persistent storage
async function loadConfig() {
    return require('../stores/authConfigStore').load();
}

async function saveConfig(config) {
    return require('../stores/authConfigStore').save(config);
}

// Middleware to check authentication
const { getRedis } = require('../db');
const { buildKey } = require('../utils/buildInfo');
const _metrics = require('../telemetry/httpMetrics');
const USER_CHECK_TTL = 5; // seconds
const PERM_CACHE_TTL = 30; // seconds — permission cache TTL

// Cross-process cache keys (bf:perms:/bf:uex:) are stamped with the build
// version via buildKey(): during a rolling deploy, old and new pods share the
// same Redis but may disagree on what a cached permission snapshot means, so
// each build reads and writes only its own keys. The other build's keys simply
// age out on their short TTLs — TTL and invalidation behaviour are unchanged.
// The in-memory fallback Maps below are per-process and need no stamp.

// Bounded in-memory caches. Both are pure fallbacks for when Redis is
// unavailable; Redis remains the canonical store in cloud deployments. The
// LRU bound protects multi-day single-node uptime against unbounded growth
// when user counts run into the high thousands.
const PERM_CACHE_MAX = parseInt(process.env.PERM_CACHE_MAX || '5000', 10);
const USER_EXISTS_CACHE_MAX = parseInt(process.env.USER_EXISTS_CACHE_MAX || '5000', 10);
function _makeBoundedMap(max) {
    const m = new Map();
    m.set = function(k, v) {
        if (this.has(k)) Map.prototype.delete.call(this, k);
        Map.prototype.set.call(this, k, v);
        if (this.size > max) {
            // Map preserves insertion order — oldest key is first.
            const oldest = this.keys().next().value;
            Map.prototype.delete.call(this, oldest);
        }
        return this;
    };
    return m;
}
const _userExistsCache = _makeBoundedMap(USER_EXISTS_CACHE_MAX);
const _permCache = _makeBoundedMap(PERM_CACHE_MAX);

// ─── "Last seen" throttle (B15) ──────────────────────────────────────────────
// users.last_seen_at is the single source for "when did we last see this
// account" — the session/device list references it rather than keeping a second
// clock. Writing it on every authenticated request would add a write to every
// request in the product for a field nobody reads more precisely than "today",
// so one write per user per window is the whole design.
//
// Two gates, in this order:
//   1. a per-process memo — synchronous, so the overwhelming majority of
//      requests decide "already done" without touching Redis at all;
//   2. `SET key 1 EX <window> NX` on Redis, which makes the window hold across
//      pods: exactly one of them wins the key and performs the UPDATE.
// Without Redis only gate 1 applies, so N pods write at most N times per
// window. For an activity clock that is close enough.
//
// The key is NOT build-stamped, unlike bf:perms:/bf:uex:. Those cache a
// SNAPSHOT that two builds can disagree about; this one is a rate marker with
// no contents, so surviving a rolling deploy is the wanted behaviour — a
// stamped key would reset every window on every deploy and buy nothing.
const LAST_SEEN_WINDOW = parseInt(process.env.LAST_SEEN_WINDOW || '900', 10); // seconds
const LAST_SEEN_CACHE_MAX = parseInt(process.env.LAST_SEEN_CACHE_MAX || '5000', 10);
const _lastSeenCache = _makeBoundedMap(LAST_SEEN_CACHE_MAX);

/**
 * Note activity for an authenticated user. Returns immediately — the write is
 * fire-and-forget, and every failure along the way is swallowed.
 *
 * This is bookkeeping, not a gate: a request must never be slower, and must
 * certainly never fail, because an activity timestamp could not be stored. The
 * memo is claimed BEFORE the async work so that a burst of parallel requests
 * from one browser produces one write and not a dozen.
 */
function noteUserSeen(userId) {
    if (!userId) return;
    const now = Date.now();
    const last = _lastSeenCache.get(userId);
    if (last && (now - last) < LAST_SEEN_WINDOW * 1000) return;
    _lastSeenCache.set(userId, now);

    Promise.resolve().then(async () => {
        const r = getRedis();
        if (r) {
            const won = await r.set(`bf:lseen:${userId}`, '1', 'EX', LAST_SEEN_WINDOW, 'NX');
            if (won !== 'OK') return;   // another pod already stamped this window
        }
        await require('../stores/userStore').touchLastSeen(userId);
    }).catch(() => { /* never let an activity clock break a request */ });
}

// Degraded-state signal — flipped whenever getUserPermissions hits an
// exception path. Stays true for 60s after the last failure so dashboards
// can poll without seeing it bounce. See isPermissionLookupDegraded() below.
let _lastPermLookupFailedAt = 0;

// ─── Cross-node cache invalidation ───────────────────────────────────────────
// Even with Redis as the cache backend, multi-node deploys can end up with
// stale state in two ways:
//   1. Without Redis: each node has its own `_permCache` Map and a delete on
//      node A doesn't fan out.
//   2. With Redis: a read on node B can complete between node A's mutation
//      and node A's `r.del(...)`, so node B briefly held a stale value.
// Publishing the user-id (or '*' for the bulk-clear case) onto a Redis pub/sub
// channel makes every node drop its in-memory copy immediately. Best-effort:
// pub/sub failures are logged and ignored — the existing Redis-key delete
// remains the source of truth.
const PERM_INVALIDATE_CHANNEL = 'bf:perms:invalidate';
const UEX_INVALIDATE_CHANNEL = 'bf:uex:invalidate';
let _subscriberStarted = false;

function _ensureSubscriber() {
    if (_subscriberStarted) return;
    const r = getRedis();
    if (!r || typeof r.duplicate !== 'function') return;
    try {
        const sub = r.duplicate();
        sub.on('error', (e) => log.warn('[Auth] perm invalidate subscriber error:', e.message));
        sub.subscribe(PERM_INVALIDATE_CHANNEL, UEX_INVALIDATE_CHANNEL, (err) => {
            if (err) {
                log.warn('[Auth] perm invalidate subscribe failed:', err.message);
                return;
            }
            _subscriberStarted = true;
        });
        sub.on('message', (channel, message) => {
            try {
                if (channel === PERM_INVALIDATE_CHANNEL) {
                    if (message === '*') _permCache.clear();
                    else _permCache.delete(message);
                } else if (channel === UEX_INVALIDATE_CHANNEL) {
                    if (message === '*') _userExistsCache.clear();
                    else _userExistsCache.delete(message);
                }
            } catch (e) {
                log.warn('[Auth] perm invalidate handler error:', e.message);
            }
        });
    } catch (e) {
        log.warn('[Auth] perm invalidate subscriber setup failed:', e.message);
    }
}

async function _publish(channel, message) {
    const r = getRedis();
    if (!r) return;
    _ensureSubscriber();
    try { await r.publish(channel, message); } catch (_) { /* non-fatal */ }
}

// Eagerly subscribe at module load if Redis is already up. If Redis comes up
// later, the next mutation will trigger _ensureSubscriber() via _publish.
setImmediate(() => { try { _ensureSubscriber(); } catch (_) { /* non-fatal */ } });

// NOTE: tagged AFTER definition, not as `tagGate(async () => {...})`. Passing the
// arrow as an argument defeats JS's name inference from the const, which silently
// renamed this to '' — breaking routes/automation.routetable.test.js's frozen
// baseline ('USE:requireAuth' → 'USE:anonymous'), every stack trace through it,
// and the walker's own fn.name fallback for untagged middleware.
const requireAuth = async (req, res, next) => {
    if (!req.session || !req.session.isAuthenticated || !req.session.user) {
        return res.status(401).json({ error: 'Not authenticated' });
    }

    let microsoftSessionAccepted = false;
    await require('./microsoftSession').validateMicrosoftSession(req, res, () => { microsoftSessionAccepted = true; });
    if (!microsoftSessionAccepted) return;

    // Verify user still exists in DB (cached for 5s to avoid DB spam)
    const userId = req.session.user?.id;
    if (userId) {
        let exists = null;
        const r = getRedis();
        const cacheKey = buildKey(`bf:uex:${userId}`);

        if (r) {
            try {
                const val = await r.get(cacheKey);
                if (val !== null) exists = val === '1';
            } catch (_) { /* Redis error — fall through to DB */ }
        } else {
            const cached = _userExistsCache.get(userId);
            const now = Date.now();
            if (cached && (now - cached.ts) <= USER_CHECK_TTL * 1000) {
                exists = cached.exists;
            }
        }

        if (exists === null) {
            // Cache miss — check DB
            try {
                const userStore = require('../stores/userStore');
                const user = await userStore.getUser(userId);
                exists = !!user;
                if (r) {
                    try { await r.set(cacheKey, exists ? '1' : '0', 'EX', USER_CHECK_TTL); } catch (_) { }
                } else {
                    _userExistsCache.set(userId, { exists, ts: Date.now() });
                }
            } catch (e) {
                // Without the database nobody can say whether this account still
                // exists; letting it through would keep a deleted user signed in
                // for the length of the outage.
                log.error('[Auth] user existence check failed:', e.message);
                return res.status(503).json({ error: 'auth_unavailable' });
            }
        }

        if (!exists) {
            if (r) { try { await r.del(cacheKey); } catch (_) { } }
            else { _userExistsCache.delete(userId); }
            req.session.destroy(() => { });
            return res.status(401).json({ error: 'User no longer exists' });
        }

        // ── Revalidate isAdmin flag (prevent stale elevation after demotion) ──
        // Piggyback on the user-exists check — we already fetched the user above
        // Re-check every USER_CHECK_TTL seconds alongside the existence check
        try {
            const user = await userStore.getUser(userId);
            if (user) {
                const shouldBeAdmin = user.role === 'admin';
                if (req.session.isAdmin !== shouldBeAdmin) {
                    req.session.isAdmin = shouldBeAdmin;
                    req.session.user.role = user.role;
                    req.session.user.isAdmin = shouldBeAdmin;
                }
            }
        } catch (_) { /* DB error — don't block the request */ }

        // Only here, at the bottom of the authenticated path: an anonymous
        // request has already been turned away with a 401 above, and a session
        // pointing at a deleted account has been destroyed, so neither can move
        // an activity clock. Every authenticated caller passes this line —
        // cookie sessions, the x-session-token bridge and the connector JWT all
        // arrive as a populated req.session — which is why the throttle needs
        // one home and not three.
        noteUserSeen(userId);
    }

    next();
};
tagGate(requireAuth, { axis: 'auth' });

/**
 * A THIRD PARTY's true permissions — the only safe way to ask "what can THAT
 * user do".
 *
 * getUserPermissions(userId, session) returns ['all'] whenever session.isAdmin,
 * regardless of userId (see its first line). Every existing call site passes the
 * CALLER's session, which is right for "may I?" and catastrophically wrong for
 * "may they?": an admin auditing a low-privilege user would be told that user
 * has every permission, and the screen would look entirely plausible.
 *
 * This signature has NO session parameter, so that elevation is unreachable —
 * by construction, not by remembering to pass null. Anything reporting on
 * another user (the Access Map, audits, support tooling) must come through here.
 *
 * Safe to reuse the 30s bf:perms:<id> cache: the ['all'] arm returns BEFORE both
 * the cache read and the cache write, so the cache is never poisoned by it.
 * Do not "defensively" bypass the cache — it pays latency for nothing.
 *
 * @param {string} userId — the user being asked about, never the caller
 */
async function resolveUserPermissionsForAudit(userId) {
    return getUserPermissions(userId);
}

// Helper function to get user's current permissions dynamically
// Results are cached in Redis (or in-memory fallback) for PERM_CACHE_TTL seconds.
//
// NOTE: `session` here is the CALLER's. If you are asking about someone else,
// you want resolveUserPermissionsForAudit(userId) above — passing a caller
// session makes this return ['all'] for any target.
async function getUserPermissions(userId, session = null) {
    // Admin-flagged sessions get full access
    if (session?.isAdmin) return ['all'];

    // ── Check permission cache ──
    const r = getRedis();
    const permCacheKey = buildKey(`bf:perms:${userId}`);
    try {
        if (r) {
            const cached = await r.get(permCacheKey);
            if (cached) { _metrics.recordCache('permissions', true); return JSON.parse(cached); }
        } else {
            const cached = _permCache.get(userId);
            if (cached && (Date.now() - cached.ts) <= PERM_CACHE_TTL * 1000) {
                _metrics.recordCache('permissions', true);
                return cached.perms;
            }
        }
    } catch (_) { /* cache miss — resolve from DB */ }
    _metrics.recordCache('permissions', false);

    try {
        const user = await userStore.getUser(userId);
        if (!user) return ['page_chat']; // minimal fallback

        // Legacy: if user.role === 'admin', grant all
        if (user.role === 'admin') return ['all'];

        const permSet = new Set();

        // Resolve groups — user.groups may already be parsed to an array by getUser()
        let groupIds = [];
        if (Array.isArray(user.groups)) {
            groupIds = user.groups;
        } else {
            try { groupIds = JSON.parse(user.groups || '[]'); } catch (_) { }
        }

        const allGroups = await userStore.getAllGroups();
        const allRoles = await userStore.getAllRoles();
        const roleMap = Object.fromEntries(allRoles.map(r => [r.id, r]));

        for (const gid of groupIds) {
            const group = allGroups.find(g => g.id === gid);
            if (!group) continue;

            // Add group-level permissions
            for (const p of (group.permissions || [])) permSet.add(p);

            // …and the permissions a capability grant to this group implies.
            const granted = Array.isArray(group.granted_capabilities) ? group.granted_capabilities : [];
            for (const capId of granted) {
                for (const p of (GROUP_GRANT_IMPLIED_PERMISSIONS[capId] || [])) permSet.add(p);
            }

            // Resolve roles attached to the group
            for (const rid of (group.roles || [])) {
                const role = roleMap[rid];
                if (role) {
                    for (const p of (role.permissions || [])) permSet.add(p);
                }
            }
        }

        // Resolve the user's direct role field (e.g. 'admin-light')
        if (user.role && user.role !== 'admin') {
            const directRole = roleMap[user.role];
            if (directRole) {
                for (const p of (directRole.permissions || [])) permSet.add(p);
            }
        }

        // ── Organisation role → permissions mapping ──
        // Shipped defaults from config/orgRoles.json, with the organisation's
        // own choices layered on top (auth/orgRolePolicy.js). An org that has
        // never touched its Roles screen resolves byte-identically to before.
        const { resolveOrgRolePermissions } = require('./orgRolePolicy');
        const ORG_ROLE_DEFAULTS = getOrgRolePermissions();
        // Cached per org for a few seconds inside orgRolePolicy, and this whole
        // function is itself behind the per-user permission cache, so a group
        // in a second org costs one extra config read at most.
        const _permsForOrg = new Map();
        const permsForRoleInOrg = async (role, orgId) => {
            const key = String(orgId || '');
            if (!_permsForOrg.has(key)) {
                _permsForOrg.set(key, await resolveOrgRolePermissions(orgId, ORG_ROLE_DEFAULTS));
            }
            return _permsForOrg.get(key)[role] || null;
        };

        // Legacy compatibility: accounts created before the role rename carry
        // orgRole === 'admin' instead of 'org_admin'. Many code paths already
        // accept both (see server/routes/ai/config.js requireOrgAdminForN8n),
        // but the permissions map only has 'org_admin' — resulting in zero
        // permissions for legacy admins. Normalise here.
        const normaliseOrgRole = (r) => (r === OrgRoles.LEGACY_ADMIN ? OrgRoles.ORG_ADMIN : r);

        // Apply user's direct orgRole
        const userOrgRole = normaliseOrgRole(user.orgRole);
        if (userOrgRole) {
            const granted = await permsForRoleInOrg(userOrgRole, user.organizationId);
            if (granted) for (const p of granted) permSet.add(p);
        }

        // Apply group-level orgRoles (a group can grant a role to all its members).
        //
        // Why this exists: the canonical place to assign an orgRole is the
        // `users.orgRole` column. The `groups.orgRole` column is a fan-out
        // shortcut for "everyone in this group should also act as <role>"
        // (e.g. an "ops" group that grants `dpo` to its members without
        // editing each user). It is additive — a user's own orgRole and
        // every group orgRole they're in all union into the permission set.
        //
        // Operational notes:
        //   • Group orgRoles do NOT promote a user across org boundaries —
        //     a group's organizationId scopes its members; cross-org
        //     resolution still relies on the per-user orgRole + user.organizationId.
        //   • Removing a member from a group invalidates their cached perms
        //     via invalidateAllPermissionCaches (group mutations) or the
        //     per-user invalidation when adminRoutes updates `users.groups`.
        //   • The mechanism is rarely used today; left in place for orgs
        //     that want to manage "all members of group X get DPO" without
        //     editing per-user rows.
        for (const gid of groupIds) {
            const group = allGroups.find(g => g.id === gid);
            const groupOrgRole = normaliseOrgRole(group?.orgRole);
            if (!groupOrgRole) continue;
            // The GROUP's org decides, not the user's: a group fans its role
            // out to its own members, and it is that organisation's Roles
            // screen that says what the role means.
            const granted = await permsForRoleInOrg(groupOrgRole, group?.organizationId || user.organizationId);
            if (granted) for (const p of granted) permSet.add(p);
        }

        // Short-circuit: 'all' overrides everything
        if (permSet.has('all')) return ['all'];

        // Ensure at least chat access for any authenticated user
        permSet.add('page_chat');

        const result = [...permSet];

        // ── Write to cache ──
        try {
            if (r) {
                await r.set(permCacheKey, JSON.stringify(result), 'EX', PERM_CACHE_TTL);
            } else {
                _permCache.set(userId, { perms: result, ts: Date.now() });
            }
        } catch (_) { /* cache write failure is non-fatal */ }

        return result;
    } catch (err) {
        // Genuine DB error → log loudly and bump the degraded-state metric
        // so ops sees the silent "everyone is suddenly restricted" pattern.
        // We still return the minimal fallback rather than 503 here, because
        // many call sites use this for cosmetic UI gating; returning [] would
        // hide the chat window. Routes that need a hard answer should call
        // `hasPermission(userId, perm)` and on `false` decide whether to 403
        // or 503 based on `_lastPermLookupFailedAt`.
        _lastPermLookupFailedAt = Date.now();
        log.error('[Auth] getUserPermissions degraded:', err);
        return ['page_chat'];
    }
}

function isPermissionLookupDegraded() {
    return Date.now() - _lastPermLookupFailedAt < 60_000; // 1-min sticky
}

/**
 * Invalidate the cached permission set for a specific user.
 * Call this after user/group/role mutations (create, update, delete).
 */
async function invalidatePermissionCache(userId) {
    if (!userId) return;
    // Always clear locally — covers the in-memory fallback and any micro-
    // cache window before pub/sub fans out.
    _permCache.delete(userId);
    const r = getRedis();
    if (r) {
        try { await r.del(buildKey(`bf:perms:${userId}`)); } catch (_) { }
    }
    await _publish(PERM_INVALIDATE_CHANNEL, String(userId));
}

/**
 * Invalidate the user-existence cache used by requireAuth. Until this fires,
 * the cached isAdmin / existence value can outlive the user's actual role
 * by USER_CHECK_TTL (5s). Called from admin endpoints that promote/demote.
 */
async function invalidateUserExistenceCache(userId) {
    if (!userId) return;
    _userExistsCache.delete(userId);
    const r = getRedis();
    if (r) {
        try { await r.del(buildKey(`bf:uex:${userId}`)); } catch (_) { }
    }
    await _publish(UEX_INVALIDATE_CHANNEL, String(userId));
}

/**
 * Invalidate every user's cached permission set. Used on group/role mutations
 * where the affected-user set isn't easily enumerable.
 */
async function invalidateAllPermissionCaches() {
    _permCache.clear();
    const r = getRedis();
    if (r) {
        try {
            let cursor = '0';
            do {
                // Deliberately unstamped pattern: the bulk clear may sweep every
                // build's keys — extra invalidation is always safe.
                const [next, keys] = await r.scan(cursor, 'MATCH', 'bf:perms:*', 'COUNT', 200);
                cursor = next;
                if (keys.length) {
                    try { await r.unlink(...keys); } catch (_) { try { await r.del(...keys); } catch (_) { } }
                }
            } while (cursor !== '0');
        } catch (err) {
            log.warn('[Auth] invalidateAllPermissionCaches scan failed:', err.message);
        }
    }
    await _publish(PERM_INVALIDATE_CHANNEL, '*');
}

// Helper to check if user has a specific permission
async function hasPermission(userId, permission, session = null) {
    const perms = await getUserPermissions(userId, session);
    return perms.includes('all') || perms.includes(permission);
}

// Middleware to check admin or manage_users permission (dynamic)
const requireAdmin = async (req, res, next) => {
    if (!req.session || !req.session.isAuthenticated || !req.session.user) {
        return res.status(401).json({ error: 'Not authenticated' });
    }

    const userId = req.session.user?.id;

    // Check dynamically if user has admin/manage_users permission
    // Pass session for backwards compatibility with isAdmin flag
    if (await hasPermission(userId, 'manage_users', req.session) || await hasPermission(userId, 'all', req.session)) {
        next();
    } else {
        res.status(403).json({ error: 'Admin access required' });
    }
};
// Tagged after definition — see the note on requireAuth about name inference.
tagGate(requireAdmin, { axis: 'rbac', anyOf: ['manage_users', 'all'] });

// Middleware factory to require a specific permission.
//
// The returned closure is tagged (auth/gateMeta.js) so a router-stack walk can
// recover WHICH permission it enforces — without the tag it is just an anonymous
// arrow and the route table reads "USE:anonymous". The tag is a non-enumerable
// Symbol.for property: it changes nothing at request time.
const requirePermission = (permissionId) => {
    return tagGate(async (req, res, next) => {
        if (!req.session || !req.session.isAuthenticated || !req.session.user) {
            return res.status(401).json({ error: 'Not authenticated' });
        }

        const userId = req.session.user?.id;

        if (await hasPermission(userId, permissionId, req.session)) {
            next();
        } else {
            res.status(403).json({ error: `Permission '${permissionId}' required` });
        }
    }, { axis: 'rbac', anyOf: [permissionId, 'all'] });
};

const requirePluginAdmin = async (req, res, next) => {
    if (!req.session || !req.session.isAuthenticated || !req.session.user) {
        return res.status(401).json({ error: 'Not authenticated' });
    }
    const userId = req.session.user?.id;
    if (await hasPermission(userId, 'admin_components', req.session) || await hasPermission(userId, 'all', req.session)) {
        next();
    } else {
        res.status(403).json({ error: 'Plugin Admin access required' });
    }
};
tagGate(requirePluginAdmin, { axis: 'rbac', anyOf: ['admin_components', 'all'] });

/**
 * Helper to resolve the user's organization IDs from their session.
 * Super admins (role=admin) get null → no org filter (see everything).
 * Returns a Set of org IDs the user belongs to, or null.
 *
 * ── "GELEZEN NUL" EN "NIET TE LEZEN" (A2-tegenspraak) ───────────────
 * De catch onderaan slikte ELKE storefout en gaf `myOrgIds` terug — vrijwel
 * altijd een LEGE Set. Iedere aanroeper leest die als "deze gebruiker zit in
 * geen enkele org", en dat is precies de verkeerde kant op: het is de sleutel
 * waarop de EU-modus en de org-eigen tiermap worden opgezocht, dus één
 * haperende userStore-lezing stuurde een volledig systeemprompt naar het
 * globale, niet-EU model. Routes die daarop een 503 wilden geven (persona.js,
 * tests.js) hadden een `catch` om een functie die nooit gooide: een dode poort.
 *
 * Met `{ strict: true }` GOOIT hij op een onleesbare lezing. Dat is opt-in
 * zodat elke bestaande aanroeper zijn gedrag houdt; wie de uitkomst als
 * beslissleutel gebruikt hoort hem aan te zetten.
 *
 * De lezing zelf staat in `auth/orgScope.js` — één implementatie voor alle
 * vormen van deze vraag. Deze naam is nog maar de projectie erop.
 *
 * @param {import('express').Request} req
 * @param {{strict?: boolean}} [opts]
 */
const resolveUserOrgIds = async (req, opts) => {
    // De super-admin kort hier af en niet in orgScope: zijn antwoord (`null`,
    // geen filter) kost geen lezing, dus een haperende store mag het niet in
    // een strict-fout veranderen. Wie hém om een órg vraagt leest orgScope.
    if (req?.session?.user?.id && (req.session.isAdmin || req.session.user.role === 'admin')) return null;
    return (await orgScope(req, opts)).orgIds;
};

/**
 * Block writes/operations when an organization is suspended. Returns 402 with
 * a stable error code so the frontend can surface a "Subscription paused"
 * banner. Archived orgs trip a 410. Super-admins are exempt (they need to be
 * able to admin a suspended org). Active orgs (or no-org consumer accounts)
 * pass through.
 *
 * WHICH org is checked is never *selected* by the caller. The gate used to read
 * `req.body.organizationId` as an override "for super-admin routes" — but
 * super-admins have already returned above, so in practice the only callers who
 * could reach that override were ordinary members, i.e. exactly the people the
 * gate exists to stop. Adding one field to the JSON body (even a nonexistent
 * org id, since an unknown org falls through to next()) turned the whole
 * suspension/archive gate off.
 *
 * The rule is therefore: a named org can only ADD a check, never replace one.
 *   - the caller's own (primary) org is ALWAYS evaluated;
 *   - a route param (`/orgs/:orgId/...`, the resource being acted on) is
 *     evaluated in addition when present;
 *   - `req.body.organizationId` is evaluated in addition too, but ONLY when the
 *     caller genuinely belongs to that org. Dropping the body entirely was the
 *     wrong correction: routes/agents/crud.js and routes/knowledgeBases.js do
 *     take the target org from the body, and assertUserCanUseOrg admits any org
 *     in the resolveUserOrgIds union — so a multi-org member whose PRIMARY org
 *     is active could write into a SUSPENDED secondary org unchecked. An org the
 *     caller is not a member of is ignored here (their own org still decides),
 *     which is what keeps the body from being a kill switch.
 */
function requireActiveOrg(opts = {}) {
    const paramName = opts.paramName || 'orgId';
    // failsOpen: on a DB error this returns next() rather than denying (see the
    // catch below). The Access Map must therefore render this axis as `unknown`,
    // never as a truthful deny, when the permission lookup is degraded.
    return tagGate(async (req, res, next) => {
        try {
            if (req.session?.isAdmin || req.session?.user?.role === SystemRoles.SUPER_ADMIN) return next();

            // One membership lookup serves all three sources below (this is the
            // same single lookup resolvePrimaryOrgId performs internally).
            // `null` means super-admin — unreachable here, they returned above.
            const memberOrgIds = await resolveUserOrgIds(req);

            const orgIds = [];
            const paramOrgId = (req.params && req.params[paramName]) || null;
            if (paramOrgId) orgIds.push(paramOrgId);

            // Target org from the body: only honoured as an ADDITIONAL check,
            // and only for an org the caller actually belongs to. A stranger's
            // org id changes nothing — the caller's own org is still evaluated.
            const rawBodyOrgId = req.body && req.body.organizationId;
            const bodyOrgId = typeof rawBodyOrgId === 'string' && rawBodyOrgId ? rawBodyOrgId : null;
            if (bodyOrgId && memberOrgIds && memberOrgIds.has(bodyOrgId) && !orgIds.includes(bodyOrgId)) {
                orgIds.push(bodyOrgId);
            }

            const callerOrgId = (memberOrgIds && memberOrgIds.size > 0) ? Array.from(memberOrgIds)[0] : null;
            if (callerOrgId && !orgIds.includes(callerOrgId)) orgIds.push(callerOrgId);

            if (orgIds.length === 0) return next(); // consumer / no-org → not blocked

            for (const orgId of orgIds) {
                const org = await userStore.getOrganization(orgId);
                if (!org) continue;
                const status = org.status || 'active';
                if (status === 'suspended') {
                    return res.status(402).json({
                        error: 'org_suspended',
                        message: 'Your organization is currently suspended. Please contact your administrator.',
                    });
                }
                if (status === 'archived') {
                    return res.status(410).json({
                        error: 'org_archived',
                        message: 'Your organization is archived and read-only.',
                    });
                }
            }
            return next();
        } catch (e) {
            log.warn('[Auth] requireActiveOrg error:', e.message);
            return next(); // fail-open: don't lock customers out on transient errors
        }
    }, { axis: 'orgStatus', paramName, mutationsOnly: false, failsOpen: true });
}

/**
 * Variant of `requireActiveOrg` that only enforces on non-GET/non-HEAD
 * requests. Use as a top-level `router.use(...)` middleware so a suspended
 * org can still read/export data but cannot mutate. The status check
 * runs server-side; the suspension banner is rendered client-side from
 * the 402 response.
 */
function requireActiveOrgForMutations(opts = {}) {
    const inner = requireActiveOrg(opts);
    return tagGate((req, res, next) => {
        const m = req.method;
        if (m === 'GET' || m === 'HEAD' || m === 'OPTIONS') return next();
        return inner(req, res, next);
    }, { axis: 'orgStatus', paramName: opts.paramName || 'orgId', mutationsOnly: true, failsOpen: true });
}

/**
 * Pure org-admin decision (DB-free — unit testable): given an already-fetched
 * user row and the full group list, is the user an admin *of orgId*?
 *
 *   - direct: the user's own org is orgId AND their orgRole is an admin role
 *     (strictOrgRole → only the exact ORG_ADMIN; default → any admin variant,
 *     including the legacy 'admin' orgRole via isOrgAdminRole);
 *   - group: the user belongs to a group in orgId that itself carries an
 *     admin permission ('all'/'admin') or admin role ('admin'/'org_admin').
 *
 * This is the group-permission-aware semantics shared by the org-scoped config
 * routes (orgAzureConfig, orgPrivacyShield, houseStyles, talkNotesSettings).
 * It is deliberately DISTINCT from requireOrgAdmin below, which gates on the
 * orgRole then plain group *membership*; reconciling the two is a separate,
 * test-guarded decision — do not silently merge them.
 */
function _evalOrgAdmin(user, allGroups, orgId, { strictOrgRole = false } = {}) {
    if (!user) return false;
    const directAdmin = strictOrgRole
        ? user.orgRole === OrgRoles.ORG_ADMIN
        : isOrgAdminRole(user.orgRole);
    if (user.organizationId === orgId && directAdmin) return true;

    let groupIds = [];
    if (Array.isArray(user.groups)) groupIds = user.groups;
    else { try { groupIds = JSON.parse(user.groups || '[]'); } catch (_) { /* leave [] */ } }

    for (const gid of groupIds) {
        const group = (allGroups || []).find(g => g.id === gid);
        if (group?.organizationId === orgId) {
            const perms = Array.isArray(group.permissions) ? group.permissions : [];
            const roles = Array.isArray(group.roles) ? group.roles : [];
            if (perms.includes(Permissions.ALL) || perms.includes(SystemRoles.SUPER_ADMIN) ||
                roles.includes(SystemRoles.SUPER_ADMIN) || roles.includes(OrgRoles.ORG_ADMIN)) {
                return true;
            }
        }
    }
    return false;
}

/**
 * Is the requesting user an admin of `orgId`? Super admins always pass.
 * Replaces the five hand-rolled `isOrgAdmin(req, orgId)` copies in the
 * org-scoped config routes with one audited copy. Pass `{ strictOrgRole: true }`
 * to require the exact ORG_ADMIN orgRole (orgAzureConfig's stricter variant);
 * default accepts any admin orgRole variant.
 * @param {import('express').Request} req
 * @param {string} orgId
 * @param {{ strictOrgRole?: boolean }} [opts]
 * @returns {Promise<boolean>}
 */
async function isOrgAdminForOrg(req, orgId, opts = {}) {
    if (isSuperAdmin(req)) return true;
    const userId = req.session?.user?.id;
    if (!userId) return false;
    const user = await userStore.getUser(userId);
    if (!user) return false;
    const allGroups = await userStore.getAllGroups();
    return _evalOrgAdmin(user, allGroups, orgId, opts);
}

/**
 * Shared middleware factory: require org admin access for the org
 * specified by req.params[paramName].
 * Use this across all route files instead of local copies.
 */
function requireOrgAdmin(paramName = 'id') {
    // paramDependent: the verdict depends on WHICH org the request names, so a
    // static answer does not exist — the Access Map renders these as
    // "Depends on what is opened" rather than allow/deny.
    return tagGate(async (req, res, next) => {
        if (!req.session?.user) return res.status(401).json({ error: 'Unauthorized' });
        const orgId = req.params[paramName];
        if (!orgId) return res.status(400).json({ error: 'Organization ID required' });

        // Super admin — always allowed
        if (req.session.isAdmin || req.session.user?.role === 'admin') return next();

        const userId = req.session.user.id;
        if (!userId) return res.status(403).json({ error: 'Organization admin access required' });

        const user = await userStore.getUser(userId);
        if (!user || !isOrgAdminRole(user.orgRole)) {
            return res.status(403).json({ error: 'Organization admin access required' });
        }

        // Must belong to the target org
        if (user.organizationId === orgId) return next();

        // Check group-based membership as fallback
        let groupIds = [];
        if (Array.isArray(user.groups)) groupIds = user.groups;
        else { try { groupIds = JSON.parse(user.groups || '[]'); } catch (_) { } }

        const allGroups = await userStore.getAllGroups();
        const isMember = groupIds.some(gid => {
            const g = allGroups.find(gr => gr.id === gid);
            return g?.organizationId === orgId;
        });

        if (!isMember) {
            return res.status(403).json({ error: 'Organization admin access required' });
        }
        next();
    }, { axis: 'scope', kind: 'orgAdminOfParam', param: paramName, paramDependent: true });
}

/**
 * Canonical super-admin predicate. A super (system) admin is a session flagged
 * `isAdmin` or whose user role is 'admin'. This exact expression was spelled
 * inline in ~20 route handlers with ?./non-?. variants — one definition keeps
 * the privilege check from drifting.
 *
 * NOTE: this is distinct from the `orgIds === null` idiom some routes use — that
 * one is *derived* from resolveUserOrgIds() (which returns null for super
 * admins) and stays where it is; do not replace those with this.
 * @param {import('express').Request} req
 * @returns {boolean}
 */
function isSuperAdmin(req) {
    return !!(req.session?.isAdmin || req.session?.user?.role === 'admin');
}

/**
 * Platform-operator gate — the middleware form of isSuperAdmin().
 *
 * WHY THIS EXISTS SEPARATELY FROM requireAdmin: requireAdmin (:657) passes on
 * the `manage_users` PERMISSION, and config/orgRoles.json grants that to every
 * org_admin. It answers "may manage users", not "runs this installation". Four
 * routers had already noticed and hand-rolled a private copy of this function
 * rather than use it (routes/admin/modules.js, routes/admin/connectorHealth.js,
 * routes/cmsAnalytics.js, routes/cms.js) — each with a comment explaining the
 * trap. This is that copy, promoted to the one place they can all import.
 *
 * Deliberately synchronous and DB-free: unlike requireAdmin it never consults
 * getUserPermissions(), so it cannot be softened by the degraded-lookup
 * fallback (:591) and has no fail-open path. Holding the `all` permission does
 * NOT satisfy it — only users.role === 'admin' does. That asymmetry is what
 * stops the POST /auth/roles → group → 'all' escalation ladder from reaching
 * platform scope.
 *
 * Responses are byte-identical to the four local copies it replaces, so
 * swapping them out is a provable no-op.
 */
const requireSuperAdmin = (req, res, next) => {
    if (!req.session?.user) return res.status(401).json({ error: 'Unauthorized' });
    if (isSuperAdmin(req)) return next();
    return res.status(403).json({ error: 'Operator access required' });
};
// Tagged after definition — see the note on requireAuth about name inference.
// Axis is 'platform', not 'rbac': 'admin' is a users.role value, not a
// SYSTEM_PERMISSIONS id, and tagging it rbac would force a fictional permission
// id into accessRegistry via drift assertion 3.
tagGate(requireSuperAdmin, { axis: 'platform', kind: 'superAdmin' });

/**
 * Resolve the requesting user's primary org ID from the session.
 * Returns the first org they belong to, or null. Super admins return null.
 *
 * Same read as `orgScope`: `orgId` is the account's own org, else the first
 * one a group grants — which is exactly the first member of the union this
 * used to take.
 */
async function resolvePrimaryOrgId(req) {
    const scope = await orgScope(req);
    return scope.isSuperAdmin ? null : scope.orgId;
}

/**
 * Param-less variant of requireOrgAdmin for routes that always operate on the
 * CALLER's own org (no :id in the path): the caller must be an org admin (or
 * super admin) and belong to an organization. Resolves that org and attaches
 * it as `req.primaryOrgId` for the handler. Super admins act on their own
 * primary org too — there is deliberately no cross-org override here.
 */
function requirePrimaryOrgAdmin() {
    return tagGate(async (req, res, next) => {
        if (!req.session?.user) return res.status(401).json({ error: 'Unauthorized' });
        const userId = req.session.user.id;
        const isSuperAdmin = req.session.isAdmin || req.session.user?.role === 'admin';
        if (!isSuperAdmin) {
            const user = await userStore.getUser(userId);
            if (!user || !isOrgAdminRole(user.orgRole)) {
                return res.status(403).json({ error: 'Organization admin access required' });
            }
        }
        const orgId = await resolvePrimaryOrgId(req)
            || req.session.user.organizationId
            || null;
        if (!orgId) return res.status(400).json({ error: 'No organization for this account' });
        req.primaryOrgId = orgId;
        next();
    }, { axis: 'scope', kind: 'orgAdminOfOwnOrg' });
}

/**
 * Studio authorization helper: throws a 403-shaped Error if the requesting
 * user does not belong to `orgId`. If `orgId` is falsy, falls back to the
 * user's primary org. Returns the validated orgId.
 *
 * Super admins (resolveUserOrgIds === null) bypass the membership check but
 * still get back the orgId they supplied (or null if none).
 *
 * Usage:
 *   try {
 *     const orgId = await assertUserCanUseOrg(req, req.body.organizationId);
 *     // proceed with orgId
 *   } catch (err) {
 *     return res.status(err.status || 500).json({ error: err.message });
 *   }
 */
async function assertUserCanUseOrg(req, orgId) {
    const userOrgIds = await resolveUserOrgIds(req);
    // Super admin: trust the supplied orgId, or null
    if (userOrgIds === null) return orgId || null;

    if (!orgId) {
        // No explicit orgId — fall back to primary
        if (userOrgIds.size === 0) {
            const err = new Error('User does not belong to any organisation');
            err.status = 403;
            throw err;
        }
        return Array.from(userOrgIds)[0];
    }

    if (!userOrgIds.has(orgId)) {
        const err = new Error('Organisation not accessible');
        err.status = 403;
        throw err;
    }
    return orgId;
}

/**
 * Studio authorization helper: throws a 400-shaped Error if any of
 * `sharedGroupIds` does not belong to `orgId`. An empty/undefined list is a
 * no-op. Returns the validated array (deduped, falsy entries dropped).
 *
 * `{requireNonEmpty: true}` turns "no usable groups" into a 400
 * `groups_required` instead. Only pass it where the caller has said it wants
 * GROUP-scoped sharing: everywhere `shared_groups` is read (auth/audience.js),
 * an empty list on a published row means the ENTIRE ORGANISATION, so returning
 * [] there answers "share with these groups" with "share with everyone".
 *
 * Usage:
 *   try {
 *     const groups = await validateSharedGroupsForOrg(orgId, sharedGroups);
 *     await store.setPublished(id, true, groups);
 *   } catch (err) {
 *     return res.status(err.status || 500).json({ error: err.message });
 *   }
 */
async function validateSharedGroupsForOrg(orgId, sharedGroupIds, { requireNonEmpty = false } = {}) {
    const groupsRequired = () => {
        const err = new Error('Pick at least one group to share this with');
        err.status = 400;
        err.code = 'groups_required';
        return err;
    };
    if (sharedGroupIds === undefined || sharedGroupIds === null) {
        if (requireNonEmpty) throw groupsRequired();
        return undefined;
    }
    if (!Array.isArray(sharedGroupIds)) {
        const err = new Error('sharedGroups must be an array');
        err.status = 400;
        throw err;
    }
    const ids = Array.from(new Set(sharedGroupIds.filter(Boolean)));
    if (ids.length === 0) {
        if (requireNonEmpty) throw groupsRequired();
        return [];
    }
    if (!orgId) {
        const err = new Error('Cannot assign shared groups: resource has no organisation');
        err.status = 400;
        throw err;
    }

    const allGroups = await userStore.getAllGroups();
    const orgGroupIds = new Set(allGroups.filter(g => g.organizationId === orgId).map(g => g.id));
    const invalid = ids.filter(id => !orgGroupIds.has(id));
    if (invalid.length > 0) {
        const err = new Error(`Invalid groups for this organisation: ${invalid.join(', ')}`);
        err.status = 400;
        throw err;
    }
    return ids;
}

module.exports = {
    SYSTEM_PERMISSIONS,
    getOrgRolePermissions,
    OAUTH_PROVIDERS,
    MICROSOFT_SCOPES,
    microsoftRefreshScope,
    loadConfig,
    saveConfig,
    requireAuth,
    getUserPermissions,
    resolveUserPermissionsForAudit,
    hasPermission,
    requireAdmin,
    requireSuperAdmin,
    requirePermission,
    requirePluginAdmin,
    resolveUserOrgIds,
    resolvePrimaryOrgId,
    isSuperAdmin,
    isOrgAdminForOrg,
    _evalOrgAdmin,
    requireOrgAdmin,
    requirePrimaryOrgAdmin,
    assertUserCanUseOrg,
    validateSharedGroupsForOrg,
    invalidatePermissionCache,
    invalidateAllPermissionCaches,
    invalidateUserExistenceCache,
    GROUP_GRANT_IMPLIED_PERMISSIONS,
    OrgRoles,
    SystemRoles,
    Permissions,
    ORG_ADMIN_VARIANTS,
    isOrgAdminRole,
    requireActiveOrg,
    requireActiveOrgForMutations,
    isPermissionLookupDegraded,
};
