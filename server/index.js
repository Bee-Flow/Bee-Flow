require('dotenv').config({ path: require('path').resolve(__dirname, '../.env') });
// OpenTelemetry MUST load before express/pg/http so auto-instrumentation can
// patch them. Self-gated: a no-op unless OTEL is enabled (see telemetry/otel).
const otel = require('./telemetry/otel');
const express = require('express');

// Core modules
const componentManager = require('./core/cms/componentManager');
require('./core/executionEngine');
// Registers every integration's tools with core's tool dispatcher.
require('./integrations/toolFamilies');

// Route modules
const authRouter = require('./auth/router');
const aiRouter = require('./routes/ai');
const executeRouter = require('./routes/execute');
const { router: agentsRouter } = require('./routes/agents');
const memoryRouter = require('./routes/memory');
const reportsRouter = require('./routes/reports');
const appsRouter = require('./routes/apps');

// Platform-module gate — 404-conceals a modular route when its module is not
// imported (defense in depth in FRONT of the capability gate, which already
// omits inactive-module capabilities from the ceiling). Required up here
// because the first gated mounts (/apps, /api/compliance, /api/dsr) run
// before the route section further down.
const { requireModule } = require('./modules');
const log = require('./telemetry/log');


const app = express();
// Trust proxy: how many reverse-proxy hops sit in front of us. Default `1`
// matches the standard nginx-in-front production deploy. Override via
// `TRUST_PROXY_HOPS` (positive integer) if you have multiple proxies (e.g.
// CDN → load balancer → app). Setting this to `true` works for IP detection
// but causes express-rate-limit to refuse to start with ERR_ERL_PERMISSIVE_TRUST_PROXY
// because anyone could spoof X-Forwarded-For; the numeric value pins down
// exactly how many forwarded IPs to peel off.
const TRUST_PROXY_HOPS = Math.max(0, parseInt(process.env.TRUST_PROXY_HOPS || '1', 10) || 1);
app.set('trust proxy', TRUST_PROXY_HOPS);
const PORT = process.env.SERVER_PORT || process.env.PORT || 3001;

// ── HTTP front ────────────────────────────────────────────────────────────────
// One id per request (X-Request-Id), then the security headers, Permissions-
// Policy and API cache-control — see boot/httpMiddleware.js.
const httpMiddleware = require('./boot/httpMiddleware');
httpMiddleware.applyRequestIdAndSecurityHeaders(app);

// ── Error handlers ────────────────────────────────────────────────────────────
// unhandledRejection is logged, uncaughtException is logged and exits 1 — see
// boot/lifecycle.js.
const lifecycle = require('./boot/lifecycle');
lifecycle.installProcessErrorHandlers();

// No directory is created here. A `../workflows` mkdir outlived the removed
// Workflow AI: nothing read or wrote that directory, and in the image it is
// /workflows, outside anything `node` may write — the first image that ran as
// `node` died on it at boot. What the server may write is listed in
// server/Dockerfile.

// ── Middleware ─────────────────────────────────────────────────────────────────
// The CORS allow-list dispatcher: a request carrying a disallowed Origin is
// refused with a 403 here, for every method, before the session, DB and
// rate-limit middleware run. Then the Stripe webhook's raw body and the global
// JSON parser that keeps req.rawBody for the HMAC verifiers — see
// boot/httpMiddleware.js.
httpMiddleware.applyCors(app);
httpMiddleware.applyBodyParsers(app);

// ── Request-timing instrumentation ─────────────────────────────────────────────
// Per-route latency recording — see boot/requestTiming.js. The same counters are
// read back by /api/admin/metrics further down, which is why httpMetrics is also
// required here.
const httpMetrics = require('./telemetry/httpMetrics');
require('./boot/requestTiming').mountRequestTiming(app);

// ── Sessions ──────────────────────────────────────────────────────────────────────
// PostgreSQL session store with the Redis read-through cache, the refuse-to-boot
// MASTER_ENCRYPTION_KEY / SESSION_SECRET checks, the cookie session (lifetime
// from auth/sessionLifetime.js), then the per-request client tag and the
// document-crypto session — see boot/session.js.
const sessionLayers = require('./boot/session');
sessionLayers.applyCookieSession(app);

// Nextcloud Connector JWT auth — handles requests from the Bee Flow ExApp
// connector. Tagged with `X-Beeflow-Source: nextcloud-connector`. Populates
// req.session so downstream handlers see no difference from a cookie session.
app.use(require('./auth/connectorJwt'));

// ── Session-token bridge (popup→iframe handoff for embedded mode) ──
// Helpers live in utils/sessionToken so OAuth callback can mint pickup tokens.
const {
    setSessionToken,
    generateToken,
    SESSION_TOKEN_TTL_SECONDS,
    NATIVE_SESSION_TOKEN_TTL_SECONDS,
} = require('./utils/sessionToken');

// The bridge itself (an X-Session-Token rebuilds the session per request), then
// the Microsoft login-identity recheck — see boot/session.js. The route below
// MINTS the tokens.
sessionLayers.applySessionBridge(app);

// Which client is asking — the native app gets a longer token.
const { currentClient } = require('./telemetry/requestClient');

app.get('/api/session-token', async (req, res) => {
    if (!req.session?.user?.id) return res.status(401).json({ error: 'Not authenticated' });

    const userStore = require('./stores/userStore');
    const token = generateToken();
    const userId = req.session.user.id;
    const appPasswordData = await userStore.getAppPassword(userId);

    // A native client gets the cookie's thirty days; everything else keeps the
    // hour the iframe bridge was designed around. Keyed off the client header,
    // which any caller can spell — and that is deliberately harmless, because
    // minting one requires an already-authenticated session and that same
    // session already carries a 30-day cookie in a browser. Nothing becomes
    // reachable with the long token that was not reachable without it.
    const ttlSeconds =
        currentClient() === 'android'
            ? NATIVE_SESSION_TOKEN_TTL_SECONDS
            : SESSION_TOKEN_TTL_SECONDS;

    await setSessionToken(
        token,
        {
            user: req.session.user,
            accessToken: req.session.accessToken,
            refreshToken: req.session.refreshToken,
            oauthProvider: req.session.oauthProvider,
            microsoftIdentityVersion: req.session.microsoftIdentityVersion,
            microsoftLoginIdentity: req.session.microsoftLoginIdentity,
            oauthTokenSource: req.session.oauthTokenSource,
            nextcloudUid: req.session.nextcloudUid,
            appPassword: appPasswordData,
            isAuthenticated: req.session.isAuthenticated || false,
            isAdmin: req.session.isAdmin || false,
            // Connector instance binding — without these the bridged iframe
            // session loses connector-mode NC access (nextcloudClient falls back
            // to the DB row, but the fast path should survive the bridge).
            connectorOrgId: req.session.connectorOrgId,
            connectorNcUid: req.session.connectorNcUid,
            // Two of the four gates the OAuth callback deposits, which this
            // re-mint used to drop on the floor. Dropping them told a bridged
            // client that a user awaiting approval was approved — a real
            // bypass, and one that a native TTL would hold open for a month
            // instead of an hour. Both are set once at login and never cleared
            // mid-session, so a frozen copy can never disagree with the
            // session it came from.
            pendingApproval: req.session.pendingApproval || false,
            noOrganization: req.session.noOrganization || false,

            // ── The other two gates are deliberately NOT here. ──────────────
            //
            // `needsEncryptionSetup` and `needsEncryptionPin` are the opposite
            // kind of flag: they are meant to be CLEARED, by
            // auth/login/ssoEncryptionRoutes.js, once the user sets up or
            // unlocks. That clear writes to req.session and calls save() — and
            // for a bridged request save() is a no-op (suppressSessionPersistence,
            // just above), while the next request rebuilds the session from
            // this payload. So a flag frozen in here can never be turned off.
            //
            // Carrying them would put a bridged client in a gate loop it
            // cannot leave, for the full life of the token. Worse, the loop
            // lands on the encryption-SETUP screen, and completing setup a
            // second time used to mint a fresh DEK over the live one — the
            // guard in auth/encryption.js:setupSSOUserDEK now refuses that,
            // but a loop that repeatedly asks the user to re-key their account
            // is not something to ship either.
            //
            // The honest position: a bridge session cannot hold a DEK by
            // design, so the encryption gate is not satisfiable over the
            // bridge at all. Leaving these out keeps the token silent about a
            // question it has no way to answer, rather than answering it
            // wrongly and permanently. Fixing the gate ITSELF for bridged
            // clients is a separate piece of work — it needs somewhere durable
            // for a bridged session to write, which this bridge does not have.
            //
            // Still deliberately NOT `encryptionKey` either: key material does
            // not go into the bridge store. That exclusion is the design.
        },
        ttlSeconds,
    );
    // The client cannot guess how long it has. Saying so lets the app hold a
    // token for exactly as long as the server will honour it, instead of
    // hard-coding a TTL that goes stale the moment this line changes.
    res.json({ token, expiresIn: ttlSeconds });
});

// ── Init components ───────────────────────────────────────────────────────────
componentManager.initialize()
    .then(() => log.info('Component Manager Initialized'))
    .catch(err => log.error('Failed to initialize components:', err));

// ── API info & health ─────────────────────────────────────────────────────────
app.get('/api/health', (req, res) => {
    res.json({
        status: 'ok',
        timestamp: new Date().toISOString(),
        appVersion: process.env.APP_BUILD_SHA || '',
        otel: otel.isEnabled(),
    });
});

// Schema-gezondheidsprobe: altijd 200, degradeert bij een onbereikbare of
// ongemigreerde database. Ongeauthenticeerd, net als /api/health hierboven
// (dat matcht exact en swallowt dit pad dus niet). Zie routes/healthSchema.js.
app.use('/api/health/schema', require('./routes/healthSchema'));

app.get('/api', (req, res) => {
    res.json({ name: 'Bee Flow API', status: 'ok' });
});

// ── Well-known discovery docs ─────────────────────────────────────────────────
// Microsoft Azure AD publisher-domain verification (cloud-only). Mounted before
// the static/SPA layers so the catch-all doesn't swallow the .well-known path.
app.use('/.well-known', require('./routes/wellKnown'));

// ── Static files ──────────────────────────────────────────────────────────────
// The built SPA's assets (production only), the allow-listed /uploads and the
// Learning Center video pack — see boot/staticAssets.js.
const staticAssets = require('./boot/staticAssets');
staticAssets.mountStaticAssets(app);

// ── RustFS Storage Init ───────────────────────────────────────────────────────
const storageStore = require('./stores/storageStore');
storageStore.init().then(ok => {
    if (ok) log.info('[Server] RustFS storage initialized');
    else log.warn('[Server] RustFS unavailable — using local disk fallback');
}).catch(err => log.warn('[Server] RustFS init error:', err.message));

// ── Optional-consent overrides cache ─────────────────────────────────────────
// Load the admin override for the optional-consent catalog into the in-memory
// cache the synchronous consent registry reads from.
require('./legal/legalStore').refresh()
    .then(() => log.info('[Server] Consent overrides loaded'))
    .catch(err => log.warn('[Server] Consent overrides init error:', err.message));


// ── Mount routes ──────────────────────────────────────────────────────────────
app.use('/auth', authRouter);
// MFA (TOTP) management — mounted after authRouter so /auth/mfa/* paths the
// auth router doesn't define (setup/enable/disable/regenerate/status) fall
// through to here. Login-time verification (/auth/mfa/verify-login) lives in
// the auth router itself.
app.use('/auth/mfa', require('./auth/mfaRoutes'));
// Security keys (YubiKey / FIDO2) as an additional second factor; the
// sign-in half is in the auth router beside /auth/mfa/verify-login.
app.use('/auth/mfa', require('./auth/securityKeys').managementRouter);
app.use('/ai', aiRouter);
app.use('/workflow-ai', (req, res) => res.status(404).json({ error: 'Workflow AI removed' }));
app.use('/', executeRouter);
// Required training — an org may insist a course is finished before a feature
// can be AUTHORED (server/learning/trainingGates.js). Mounted beside each
// area's capability gate so it covers every sub-route; it locks the authoring
// paths only, never reading and never running, and fails open whenever it
// cannot answer confidently.
const { requireTraining } = require('./learning/requireTraining');

app.use('/agents/memory', memoryRouter);   // Must be before /agents
app.use('/agents', requireTraining('agents'), agentsRouter);
app.use('/reports', reportsRouter);
app.use('/apps', requireModule('apps'), appsRouter);

app.use('/versions', require('./routes/versions'));
// The non-Overview Usage & Monitoring tabs (Safety / Integrations / Azure
// services) sit on `/api/usage/{guardrails,integrations,azure-services}/*`
// and require `advanced_usage_monitoring` (enterprise+). The Overview tab
// hits other paths (/summary, /timeline, /users, etc.) which stay free.
// We inject a path-aware gate that runs only for the gated sub-prefixes
// — the same /api/usage router serves both. `requireFeature` is
// destructured further down, so we lazy-require it here.
const _ADV_USAGE_PREFIXES = ['/guardrails', '/integrations', '/integrations-health', '/azure-services'];
const _advUsagePrefixGate = (req, res, next) => {
    const path = req.path || '';
    const hit = _ADV_USAGE_PREFIXES.some(p => path === p || path.startsWith(p + '/'));
    if (!hit) return next();
    return require('./core/entitlements/entitlements').requireCapability('advanced_usage_monitoring')(req, res, next);
};
app.use('/api/usage', _advUsagePrefixGate, require('./routes/usage'));
// /api/terminations and /api/feedback back the Terminations + Feedback
// usage tabs — same advanced-monitoring gate, applied at the mount.
const _advUsageGate = (req, res, next) => require('./core/entitlements/entitlements').requireCapability('advanced_usage_monitoring')(req, res, next);
app.use('/api/terminations', _advUsageGate, require('./routes/terminations'));
// NOT gated at the mount. Reading other people's feedback is an
// advanced-monitoring feature; leaving a thumbs-up on your own answer is not.
// Gating the whole router meant the POST 403'd for every community and
// self-hosted user, so the one channel by which a person could tell this
// product an answer was wrong existed only on enterprise plans. The gate now
// sits on the admin READ routes inside the router.
app.use('/api/feedback', require('./routes/feedback'));
app.use('/api/client-errors', require('./routes/clientErrors'));
app.use('/api/web-vitals', require('./routes/webVitals'));
app.use('/api/csp-report', require('./routes/cspReport'));
// Anonymous marketing endpoint (github-stats block on the public site).
app.use('/api/public', require('./routes/publicGithubStats'));
app.use('/api/org-privacy-shield', require('./routes/orgPrivacyShield'));
app.use('/api/org-ai-context', require('./routes/orgAiContext'));
app.use('/api/org-memory', require('./routes/orgMemory'));
// The AI that decides by itself when to join a team chat or comment thread:
// the org policy (members read, admins write) and each person's own opt-out.
// requireAuth sits on every route of the router.
app.use('/api/ai-participation', require('./routes/aiParticipation'));
// The org switch for real-time co-editing of project notebooks and pages
// (members read, admins write; requireAuth on every route).
app.use('/api/org-collab', require('./routes/orgCollab'));
app.use('/api/org-integration-cache', require('./routes/orgIntegrationCache'));
app.use('/api/org-azure-config', require('./routes/orgAzureConfig'));
app.use('/api/house-styles', require('./routes/houseStyles'));
// Compliance Hub — Enterprise-tier feature.
app.use('/api/compliance', requireModule('compliance'), (req, res, next) => require('./core/entitlements/entitlements').requireCapability('compliance_hub_gdpr')(req, res, next), require('./routes/compliance'));
// DSR — public submission must remain reachable (GDPR Art. 12). Admin endpoints
// inside the router enforce admin_compliance permission; the router is mounted
// without the license gate so unauthenticated subjects can submit requests.
app.use('/api/dsr', requireModule('compliance'), require('./routes/dsr'));
app.use('/api/chat/dlp-decision', require('./routes/dlpDecision'));
// The user's own tokenization vault. Self-scoped only — see the header in the
// router for why there is deliberately no admin equivalent.
app.use('/api/privacy/token-vault', require('./routes/piiVault'));
// The caller's own effective Privacy Shield status — the one source behind the
// chat and Cowork privacy claims (F4). Self-scoped; requireAuth on the route.
app.use('/api/privacy/shield-status', require('./routes/privacyShieldStatus'));
// The caller's own "Don't count my chat turns" preference for chat signals.
// Self-scoped; requireAuth on each route; no admin equivalent by design.
app.use('/api/privacy/chat-signals', require('./routes/privacyChatSignals'));
// CMS AI builder — mounted BEFORE /api/cms so the more-specific prefix wins.
app.use('/api/cms/builder', require('./routes/ai/cmsBuilder'));
app.use('/api/cms', require('./routes/cms'));
// Nextcloud webhook + admin sync — mounted under /auth so they share the
// auth router's session middleware (admin endpoints require requireAuth).
// The webhook itself uses HMAC over the body, so it sits BEFORE auth gates.
app.use('/auth', require('./routes/webhooks/ncEvents'));
app.use('/auth', require('./routes/admin/ncSync'));
app.use('/auth', require('./routes/admin/ncIntegrations'));
// Connector-health read API (org_health_* capture layer): super-admin fleet
// view, org-admin problems/events, customer-safe /mine banner subset.
app.use('/auth', require('./routes/admin/connectorHealth'));
app.get('/api/guard/health', async (req, res) => {
    // PII Guard service health probe. The guard is the only PII detector;
    // when it's not installed this returns `not-configured` and the chat
    // path fails open (PII detection is OFF). Endpoint resolution prefers
    // configStore (admin install action), then env.
    const { getGuardEndpoint } = require('./core/privacy/piiDetection');
    const { probeGuardHealth } = require('./services/guardInstaller');
    const endpoint = await getGuardEndpoint();
    if (!endpoint.url) return res.json({ status: 'not-configured' });
    const health = await probeGuardHealth(endpoint.url, endpoint.apiKey);
    if (health) return res.json(health);
    res.json({ status: 'unavailable' });
});
// Operational metrics (route latency, slow-query / cache hit-miss counters).
// Admin-gated — this is operational data, not public. `?format=prometheus`
// returns the text exposition format; default is JSON.
const { requireAdmin: _requireAdminForMetrics } = require('./auth/permissions');
app.get('/api/admin/metrics', _requireAdminForMetrics, (req, res) => {
    const { getPoolStats } = require('./db');
    if (req.query.format === 'prometheus') {
        res.setHeader('Content-Type', 'text/plain; version=0.0.4');
        return res.send(httpMetrics.renderTextFormat());
    }
    res.json({ ...httpMetrics.snapshot(), pool: getPoolStats() });
});
app.use('/api/admin/guard', require('./routes/guardInstall'));
app.use('/api/subscriptions', require('./routes/subscriptions'));
app.use('/api/stripe', require('./routes/stripe'));
app.use('/api/billing', require('./routes/billing'));
app.use('/api/license', require('./routes/license'));
app.use('/api/admin/licenses', require('./routes/adminLicense'));
// Platform modules — instance-level import/remove of modular features
// (super-admin only; the router enforces it).
app.use('/api/admin/modules', require('./routes/admin/modules'));
const { requireFeature: requireLicenseFeature } = require('./license/middleware');
// Unified entitlement gate — folds tier + plan-grant + beta opt-in + org/group
// grant into one decision (compound betas enforce license AND beta). Replaces
// the requireLicenseFeature(+requireBetaFeature) pairs below where the route is a
// compound beta or a user-facing core capability. Routes whose gate is a
// community-licensed GA feature (automations/ai-tasks) keep
// requireLicenseFeature to avoid over-gating.
const { requireCapability } = require('./core/entitlements/entitlements');
app.use('/api/documents', require('./routes/documents'));
app.use('/api/notifications', require('./routes/notifications'));
app.use('/api/me/notification-prefs', require('./routes/notificationPrefs'));
// Deployment/maintenance banner: the deploy pipeline announces a window before
// it rolls the Deployments, so open sessions get warning + an ETA instead of a
// stream that just dies. Write paths are token-gated (CI calls them, not a user).
app.use('/api/maintenance', require('./routes/maintenance'));
// Release notes. /ingest is token-gated (CI drafts on every build), /public is
// anonymous but serves PUBLISHED entries only — machine-written copy always
// passes a human via /admin/:id/publish before a customer sees it.
app.use('/api/release-notes', require('./routes/releaseNotes'));
const { featureGate } = require('./boot/featureGate');
const projectFeatureGate = featureGate('projects', 'Projects');
// Licence gate fires BEFORE the configStore feature gate so a community
// user sees the actionable `feature_locked` upgrade body rather than the
// less informative "Projects feature is disabled" string. The configStore
// gate remains as an operator override for enterprise installs that want
// to disable Projects per deployment.
// `requireAuth` fronts the chain so the capability and feature gates never run
// for an unauthenticated caller, and so the "user still exists in the DB"
// revalidation applies here as it does on sibling routers. The handlers also
// self-check `req.session.user.id`, but that was the ONLY thing standing between
// an anonymous request and the gates — an invariant nothing pinned.
const { requireAuth: requireAuthedUser } = require('./auth');
app.use('/api/projects', requireModule('projects'), requireAuthedUser, requireCapability('projects'), projectFeatureGate, require('./routes/projects'));
// The drain-exempt half of the stage API (design D13): reading a stage, on/off,
// pause / resume, non-steering values and detach. Deliberately NO module,
// capability or licence gate: the /api/projects mount above needs `projects`,
// which sits in the same tier list as `blueprint_packaging`, so a lapse there
// would strand production. Roles are resolved per route on the stage project
// itself (projects/stages/stageAuth.js).
app.use('/api/solution-stages', requireAuthedUser, require('./routes/solutionStages').makeSolutionStagesDrainRouter());
app.use('/api/reminders', require('./routes/reminders'));
// Cowork — scheduled work from the Chat ⇄ Work switch, with per-run history.
// Ungated: running an item as an agent is beta-gated (agent_routines) per route.
// The old /api/ai-tasks is gone; its rows moved here (agent-tasks-to-cowork-2026-10).
app.use('/api/cowork', requireTraining('cowork'), require('./routes/cowork'));
app.use('/api/automation/builder', requireModule('automation'), requireLicenseFeature('automations'), require('./routes/ai/automationBuilder'));
app.use('/api/automation', requireModule('automation'), requireLicenseFeature('automations'), requireTraining('automations'), require('./routes/automation'));
app.use('/api/step', requireModule('automation'), requireLicenseFeature('automations'), require('./routes/step'));
// Datatables: organisation-scoped tables automations read and write. Same module
// and licence key as automations — the Community line. SHARING inside the
// router is separately gated on 'automation_sharing' (Enterprise), while
// reads and row writes stay ungated so a licence lapse never strands a
// running automation. Mounted on its own path, not under /api/automation, whose
// route table is frozen by automation.routetable.test.js.
app.use('/api/datatables', requireModule('automation'), requireAuthedUser, requireLicenseFeature('automations'), requireTraining('datatables'), require('./routes/datatables'));
// App Studio over MCP — the builder toolset for an external coding agent, so a
// customer app can be authored against a live instance instead of shipped as a
// template module in a new image. FULLY GATED: without STUDIO_MCP_ENABLED=1 the
// path does not exist and the module is never loaded. Mounted BEFORE /mcp so
// the more specific path wins regardless of Express match order.
const studioMcp = require('./appStudio/mcpBuilder');
if (studioMcp.isEnabled()) {
    app.use('/mcp/studio', require('./routes/mcpStudio'));
    log.info('[Server] App Studio MCP endpoint mounted at /mcp/studio (STUDIO_MCP_ENABLED=1).');
}
// Automations over MCP — the same story for the automation builder, so an automation
// can be authored against a live instance instead of driven turn by turn
// through the chat builder. Same gating shape as the Studio endpoint above:
// without AUTOMATION_MCP_ENABLED=1 the path does not exist and the module is
// never loaded. Also mounted BEFORE /mcp so the more specific path wins.
const automationMcp = require('./automation/mcpBuilder');
if (automationMcp.isEnabled()) {
    app.use('/mcp/automations', require('./routes/mcpAutomations'));
    log.info('[Server] Automations MCP endpoint mounted at /mcp/automations (AUTOMATION_MCP_ENABLED=1).');
}
// The product website (CMS) over MCP — edit pages, header/footer, translations,
// upload local media, screenshot and (with the cms.publish scope) publish from an
// external coding agent. Same gating shape: without CMS_MCP_ENABLED=1 the path
// does not exist and the module is never loaded. Also mounted BEFORE /mcp.
const cmsMcp = require('./cms/mcp');
if (cmsMcp.isEnabled()) {
    app.use('/mcp/cms', require('./routes/mcpCms'));
    log.info('[Server] CMS MCP endpoint mounted at /mcp/cms (CMS_MCP_ENABLED=1).');
}
// Bee Flow AS an MCP server. Deliberately NOT under /api: MCP clients are
// configured with a bare URL, and the endpoint authenticates with its own
// Bearer token rather than a session cookie (see routes/mcpServer.js).
app.use('/mcp', require('./routes/mcpServer'));
// Nextcloud Task Processing execution. Machine-to-machine: authenticated by
// the connector's tenant-key HMAC, not a session (see the route's header).
app.use('/api/nextcloud/task-processing', require('./routes/nextcloudTaskProcessing'));
// Studio apps the connector should expose in the Nextcloud app menu. Same
// machine-to-machine tenant-key HMAC as task-processing (no session).
app.use('/api/nextcloud/studio-apps', requireModule('apps'), require('./routes/nextcloudStudioApps'));
// Self-service token management for the above — session-authenticated.
app.use('/api/mcp-server', requireAuthedUser, require('./routes/mcpServerTokens'));
// Named MCP access tokens (scopes, expiry, IP allow-list), per user, session-authenticated.
// The org-wide policy those tokens answer to is org-admin only, on the caller's own org.
app.use('/api/mcp-tokens', requireAuthedUser, require('./routes/mcpTokens'));
app.use('/api/org/mcp-access', requireAuthedUser, require('./routes/orgMcpAccess'));
// BFSF-255: hydrate password-account sessions from the encrypted vault so the
// session-based Google surfaces (pickers, /status) work after connecting via
// Settings → Connections, not only after Google-SSO login.
const { googleSessionHydration } = require('./auth/googleSessionHydration');
app.use('/api/integrations/google', require('./routes/integrations/googleWorkspace'));
// The Microsoft counterpart. Without it, Outlook only ever worked for users who
// logged in via Microsoft SSO, and nobody could grant the shared-mailbox scopes.
app.use('/api/integrations/microsoft', require('./routes/integrations/microsoft365'));
app.use('/api/integrations/gdrive', googleSessionHydration, require('./routes/integrations/googleDrive'));
app.use('/api/integrations/gmail', googleSessionHydration, require('./routes/integrations/gmail'));
app.use('/api/integrations/calendar', googleSessionHydration, require('./routes/integrations/calendar'));
app.use('/api/integrations/contacts', googleSessionHydration, require('./routes/integrations/contacts'));
app.use('/api/integrations/keep', googleSessionHydration, require('./routes/integrations/keep'));
app.use('/api/storage', require('./routes/storageProxy'));
app.use('/api/integrations/linkedin', require('./routes/integrations/linkedin'));
app.use('/api/integrations/withings', require('./routes/integrations/withings'));
app.use('/api/integrations/github', require('./routes/integrations/github'));
app.use('/api/integrations/github-sync', require('./routes/integrations/githubSync'));
app.use('/api/integrations/gamma', require('./routes/integrations/gamma'));
// These routers read tokens straight off the session, so hydrate it from the
// vault first — otherwise a connector-acquired Microsoft grant reports "not
// connected" until the user re-logs in via Microsoft SSO.
const { microsoftSessionHydration } = require('./auth/microsoftSessionHydration');
app.use('/api/integrations/outlook', microsoftSessionHydration, require('./routes/integrations/outlook'));
app.use('/api/integrations/onedrive', microsoftSessionHydration, require('./routes/integrations/oneDrive'));
app.use('/api/integrations/connections', require('./routes/integrations/connections'));
// AI Integration Builder — org-admin API for org-scoped custom integrations.
// Double gate at mount: the 'ai_integration_builder' beta capability AND the
// dark-ship kill switch (feature_custom_integrations_enabled, fail-closed 404).
const { customIntegrationsFeatureGate } = require('./core/customIntegrations/featureFlag');
app.use('/api/organizations/:orgId/custom-integrations',
    requireCapability('ai_integration_builder'),
    customIntegrationsFeatureGate,
    require('./routes/orgIntegrations/builder'));
// MCP library — organisation admins install remote MCP servers for their own
// organisation; members add their own keys; the server admin sets the policy.
// Gates live in the router (requirePrimaryOrgAdmin + mcp_marketplace licence,
// requireSuperAdmin for the policy). Remote-only: nothing here spawns a process.
app.use('/api/mcp-library', require('./routes/mcpLibrary'));
app.use('/api/templates', require('./routes/templates'));
const notebookFeatureGate = featureGate('notebooks', 'Notebooks');
// Licence gate fires before notebookFeatureGate so the frontend gets the
// actionable `feature_locked` body it already knows how to render; the
// configStore.feature_notebooks_enabled flag remains as an operator
// kill-switch for enterprise installs that want to disable the feature
// per deployment.
app.use('/api/notebooks', requireModule('notebooks'), requireCapability('notebooks'), notebookFeatureGate, require('./routes/notebooks'));
app.use('/api/notebooks', requireModule('notebooks'), requireCapability('notebooks'), notebookFeatureGate, require('./routes/notebookExport'));
// Studio Documents — printable documents (invoices, quotes, letters) authored
// by the chat and hand-edited by the user. Deliberately NOT behind a licence or
// beta gate: it replaces the ```quote``` block that every chat could render, so
// gating it would withdraw a capability rather than add one. requireAuth on each
// route is the whole gate, and every store read is owner-scoped in SQL.
// (The prefix is /api/studio-documents, not /api/documents — that one is the
// legacy mobile "Generated" PDF lister above, whose /list this router's /:id
// would otherwise swallow.)
app.use('/api/studio-documents', require('./routes/studioDocuments'));
// Webpages — compound beta (license 'webpages' AND the webpages beta). The
// unified gate enforces both via the resolver's effective.beta set and honours
// per-group grants.
app.use('/api/webpages', requireModule('webpages'), requireCapability('webpages'), requireTraining('webpages'), require('./routes/webpages'));
app.use('/api/webpages', requireModule('webpages'), requireCapability('webpages'), require('./routes/webpageExport'));
// App Studio — compound beta (license 'app_studio' AND the app_studio beta).
// The AI-builder router mounts BEFORE the CRUD router so its /builder/* paths
// are never captured by the CRUD router's /:id params (mirrors the
// /api/automation/builder ordering above). The run router shares the CRUD
// mount path (webpages-style multi-router mount).
app.use('/api/studio-apps/builder', requireModule('apps'), requireCapability('app_studio'), requireTraining('apps'), require('./routes/ai/appStudioBuilder'));
// Usage aggregate (APPS-08): GET /usage-counts, read-only and org-scoped.
// Mounted BEFORE the CRUD router for the same reason the builder router is —
// otherwise studioApps.js's GET /:id captures /usage-counts.
app.use('/api/studio-apps', requireModule('apps'), requireCapability('app_studio'), require('./routes/studioAppUsage'));
app.use('/api/studio-apps', requireModule('apps'), requireCapability('app_studio'), requireTraining('apps'), require('./routes/studioApps'));
app.use('/api/studio-apps', requireModule('apps'), requireCapability('app_studio'), require('./routes/studioAppsRun'));
app.use('/api/studio-apps', requireModule('apps'), requireCapability('app_studio'), require('./routes/studioAppData'));
app.use('/api/studio-apps', requireModule('apps'), requireCapability('app_studio'), require('./routes/studioAppConnectors'));
app.use('/api/studio-apps', requireModule('apps'), requireCapability('app_studio'), require('./routes/studioAppFiles'));
// LARGE datasets (multi-GB genome files): multipart upload + status, on
// /:id/large-datasets. Not /:id/datasets: that is studioAppData's BI datasets
// above, and the first match wins (the choice is in the router's header). The
// large_datasets licence gate is the first handler of each of its routes, never
// path-less on the router, so requests for the routers after it pass untouched.
app.use('/api/studio-apps', requireModule('apps'), requireCapability('app_studio'), require('./routes/studioAppDatasets'));
// AI browsing: the ONE streaming ai_browse step endpoint (SSE screenshots).
app.use('/api/studio-apps', requireModule('apps'), requireCapability('app_studio'), require('./routes/studioAppBrowse'));
// Studio Playbooks — phased AI builds (table → automation → fill → app →
// approvals). A playbook owns an automation AND an app, so both modules and both
// gates apply; writes need manage_apps (router-level); the approvals phase is
// locked without the approvals capability (checked in the handler).
app.use('/api/playbooks', requireModule('apps'), requireModule('automation'), requireCapability('app_studio'), requireLicenseFeature('automations'), requireTraining('playbooks'), require('./routes/playbooks'));
// Studio rail counts — ONE gate-aware aggregate for the sidebar's per-section
// numbers. Auth only at the mount: the router applies each kind's own
// module/licence/capability/permission gate per key and OMITS what the caller
// may not see, so the response never 403s as a whole (routes/studio/counts.js).
app.use('/api/studio', requireAuthedUser, require('./routes/studio/counts'));
// Studio rail search — the same nine kinds, the same mount gate and the same
// per-kind gating/omission rules as counts above, plus one of its own: a kind
// whose store FAILS is named in `errors` instead of quietly disappearing, so a
// store outage can never read as "no matches" (routes/studio/search.js).
app.use('/api/studio', requireAuthedUser, require('./routes/studio/search'));
// Studio Home "Needs attention" — six existing producers aggregated into one
// list. Auth only at the mount for the same reason as its two siblings; the
// router gates per SOURCE. Its own rule on top of theirs: a source that could
// not be read is reported as unchecked (`unavailable`, and `complete: false`)
// rather than contributing nothing, so an empty list can only be read as "all
// clear" when everything really was checked (routes/studio/attention.js).
app.use('/api/studio', requireAuthedUser, require('./routes/studio/attention'));
// Studio "Describe it, AI picks the building blocks" — one fast-tier forced-tool
// call that CLASSIFIES a sentence into one existing builder. Auth only at the
// mount, per-kind gating in the router like its three siblings, with one twist
// of its own: the gated set IS the `kind` enum the model is given, so a kind the
// caller may not build is never even a word the answer could contain
// (routes/studio/aiRoute.js).
app.use('/api/studio', requireAuthedUser, require('./routes/studio/aiRoute'));
// Cross-origin endpoints called from the sandboxed preview iframe — guarded
// by HMAC bearer tokens (issued by the session-authenticated route above),
// not by the session itself, since the iframe has no cookies.
app.use('/api/webpages-preview', requireModule('webpages'), require('./routes/webpagesPreview'));
// Anonymous AI bridge for externally-shared webpages — guarded by a
// share-scoped HMAC bridge token (minted at content-serve time only when the
// author opted the share into public AI). Sibling of /share so the strict
// /share CSP stays untouched. Chat/stream only; acts-as-author with rate
// limits + spend cap.
app.use('/api/public-share', requireModule('webpages'), require('./routes/publicShareBridge'));
// The public surface of a Studio app — an anonymous visitor filling in the
// intake screens of an app whose back-office stays behind requireAuth. The URL
// token is the credential; what it exposes is a whitelist of SCREENS in the
// app's own definition (appStudio/publicAccess.js). No capability gate: once an
// owner (whose org IS gated) opens a public page, its visitors are anonymous
// third parties — the same reasoning as /share below.
app.use('/api/public-app', requireModule('apps'), require('./routes/studioAppPublic'));
// Public webpage viewer — unauthenticated `/share/:token` route for external
// recipients of a published webpage. Has its own rate limiter, strict CSP,
// HMAC-signed magic links and unlock cookies. License/beta gates do NOT
// apply: once a publisher (whose org is gated) creates a share, recipients
// are anonymous third parties.
app.use('/share', requireModule('webpages'), require('./routes/publicViewer'));
// Hetzelfde viewerbestand, tweede adres: /w/<slug> — het adres van de PAGINA
// in plaats van dat van de share (W3 stap 4). De pagina wijst met
// `public_share_id` één canonieke share aan; die wordt hier bediend, met
// exact dezelfde poort, rate-limits, CSP en sandbox. Eén router op twee
// mounts, met opzet: een tweede viewer zou een tweede toegangscontrole zijn.
app.use('/w', requireModule('webpages'), require('./routes/publicViewer'));
// Public certificate verification — unauthenticated `/verify/:token` for a
// LinkedIn-shareable Bee Flow AI certificate. Token-gated (only certs the owner
// opted public are resolvable), per-IP rate limited, strict CSP, og:image. Mounted
// before the SPA catch-all so the SPA doesn't swallow it.
app.use('/verify', requireModule('learning'), require('./routes/verifyCertificate'));
// Dictation (speak into any composer). Auth only — deliberately NOT behind the
// meetingNotes module/capability the transcriptions router below sits behind:
// talking instead of typing is not a Meeting Notes feature, and gating it there
// would switch the microphone off for most installs.
app.use('/api/dictate', require('./routes/dictate'));
// Meeting Notes — compound beta (license 'meeting_notes' AND the beta).
app.use('/api/transcriptions', requireModule('meetingNotes'), requireCapability('meeting_notes'), requireTraining('meeting_notes'), require('./routes/transcriptions'));
// Nextcloud Talk → Meeting Notes settings (org + user toggles). Licence AND
// the meeting_notes capability: Meeting Notes can be rolled out per group
// (groupScoped), and a person outside that rollout must not reach its
// settings, templates or connectors either. The org-level endpoints are
// administration: an org admin outside the rollout still configures it for the
// people inside it (auth/capabilityOrOrgAdmin.js), the personal ones are not.
const { requireCapabilityOrOrgAdmin, settingsOrgIdFor, summaryTemplateOrgIdFor } = require('./auth/capabilityOrOrgAdmin');
const _meetingNotesGate = (orgIdFor) => requireCapabilityOrOrgAdmin(requireCapability('meeting_notes'), {
    orgIdFor, isOrgAdminForOrg: require('./auth/permissions').isOrgAdminForOrg, log,
});
app.use('/api/talk-notes-settings', requireModule('meetingNotes'), requireLicenseFeature('meeting_notes'), _meetingNotesGate(settingsOrgIdFor), require('./routes/talkNotesSettings'));
// Per-user Nextcloud access scope ("What Bee Flow may access"). Deliberately
// NO license gate: narrowing what an assistant may touch is a privacy
// control, never a premium feature.
app.use('/api/nc-scope', require('./routes/ncScope'));
// Google Meet → Meeting Notes settings (org + user toggles). Same gates as
// talk-notes-settings above.
app.use('/api/gmeet-notes-settings', requireModule('meetingNotes'), requireLicenseFeature('meeting_notes'), _meetingNotesGate(settingsOrgIdFor), require('./routes/gmeetNotesSettings'));
// Microsoft Teams → Meeting Notes settings. Same gates.
app.use('/api/teams-notes-settings', requireModule('meetingNotes'), requireLicenseFeature('meeting_notes'), _meetingNotesGate(settingsOrgIdFor), require('./routes/teamsNotesSettings'));
// Custom summary-regeneration templates (user / org / group scopes).
app.use('/api/summary-templates', requireModule('meetingNotes'), requireLicenseFeature('meeting_notes'), _meetingNotesGate(summaryTemplateOrgIdFor), require('./routes/summaryTemplates'));
// Per-person voiceprints for pyannoteAI speaker identification. Same compound
// gate as /api/transcriptions — the templates only have value there, and the
// router additionally refuses everything unless pyannoteAI is the active
// transcription provider.
app.use('/api/voiceprints', requireModule('meetingNotes'), requireCapability('meeting_notes'), require('./routes/voiceprints'));
app.use('/api/skills', requireCapability('skills'), requireTraining('skills'), require('./routes/skills'));
// Customer Support — Bee Flow's own AI-first support inbox. Mounted publicly
// (no license/beta gate) because the POST /threads endpoint accepts anonymous
// submissions from the marketing site; staff-only endpoints enforce
// admin_support inside the router.
app.use('/api/support', requireModule('support'), require('./routes/support'));

// Security Scan was a built-in module here; it now ships as a downloadable
// .bfmod from the Hub marketplace (Modules → Marketplace) and mounts its own
// /api/security routes at install time via the module runtime.
// Support Studio — tenant customer-support inbox (Studio → Support). Compound
// beta; the org-level support_inbox permission is additionally enforced inside.
app.use('/api/support-inbox', requireModule('support'), requireCapability('support_inbox'), require('./routes/supportInbox'));

// De per-agent kennis-router (/agents/:id/knowledge) is INGETROKKEN — Track Z, Z5.
// Hij schreef naar de tabel knowledge_metadata, die door niets in het product werd
// gelezen. De Studio-kennisbanken leven op /api/kb (hieronder).
app.use('/api/kb', requireTraining('knowledge'), require('./routes/knowledgeBases'));
app.use('/api/search', require('./routes/search'));
app.use('/api/languages', require('./routes/admin/languageRoutes'));
app.use('/api/icons', require('./routes/icons'));
app.use('/api/branding', require('./routes/branding'));

// ── Downloadable remote modules ───────────────────────────────────────────────
// One dispatcher for every active remote module's API (/api/mod/<id>/…), the
// version-scoped static frontend assets, and the SPA's FE-runtime manifest. All
// mounted BEFORE the SPA catch-all so they aren't swallowed by index.html.
app.use('/api/mod', require('./modules/packageLoader').dispatchRouter);
app.use('/api/module-assets', require('./routes/moduleAssets'));
app.use('/api/modules', require('./routes/modulesFrontend'));

// ── Unmatched API paths → JSON 404 ────────────────────────────────────────────
// Sits ABOVE the marketing renderer and the SPA shell on purpose. In production
// the SPA catch-all further down answers EVERY remaining path with index.html,
// so a removed, mistyped or gated-away endpoint replied `200 text/html` to a
// JSON client and the real failure surfaced as an unrelated parse error in the
// browser. It also means every probe of a non-existent /auth/* path used to run
// a CMS page lookup (a DB round-trip) before falling through. Scoped to the two
// API prefixes so the CMS render, /share, /verify and static asset serving keep
// their existing fallbacks untouched.
app.use((req, res, next) => {
    const p = req.path || '';
    if (!p.startsWith('/api/') && !p.startsWith('/auth/')) return next();
    // The webpage full-tier proxy mounts itself under /api/webpages-preview/:id/full
    // only once the HTTP server is listening — i.e. AFTER this layer. Let its
    // prefix fall through while that runtime is switched on, or we would 404 a
    // route that is about to exist.
    if (process.env.WEBPAGE_FULL_RUNTIME_ENABLED === '1' && p.startsWith('/api/webpages-preview/')) return next();
    return res.status(404).json({ error: 'Not found' });
});

// ── Server-rendered marketing pages, robots.txt and sitemap.xml ──────────────
// Mounted LAST and deliberately: it claims no path of its own, it only answers
// what every route above declined. A request that is not a published CMS page
// falls straight through via next().
//
// This is what crawlers and social scrapers receive. Until it existed the
// marketing site served `<div id="root"></div>` plus the app's own default
// title, so every link shared to LinkedIn or Slack — which do not run
// JavaScript — rendered as "Bee Flow - AI / Chat with AI agents powered by Bee
// Flow" no matter which page it pointed at.
app.use(require('./routes/publicRender'));

// ── SPA fallback (production) ─────────────────────────────────────────────────
// index.html for whatever path is left — see boot/staticAssets.js.
staticAssets.mountSpaFallback(app);

// ── Terminal error handler ────────────────────────────────────────────────────
// The LAST app.use in this file, and it has to stay last: Express only offers an
// error to handlers registered AFTER the layer that raised it, so anything
// mounted below this line would fall back to the built-in handler again.
// See core/http/terminalErrorHandler.js for what the client gets to see.
const { terminalErrorHandler } = require('./core/http/terminalErrorHandler');
app.use(terminalErrorHandler);

const { runStartupChecks, runStartupTasks } = require('./boot/startupTasks');

// ── Start server ──────────────────────────────────────────────────────────────
// Auth-schema migrations, then listen, then the startup checks, the webpage
// runtime reaper and the startup tasks — see boot/lifecycle.js. A failed
// migration refuses startup (exit 1).
lifecycle.startServer({ app, port: PORT, terminalErrorHandler, runStartupChecks, runStartupTasks });

// ── Graceful shutdown ─────────────────────────────────────────────────────────
// SIGTERM / SIGINT: drain the automation runner first, stop the pushers, flush,
// close Redis, the blob engines and OTEL, then exit — see boot/lifecycle.js.
const { disconnectRedis } = require('./db');
lifecycle.installGracefulShutdown({ otel, disconnectRedis });
