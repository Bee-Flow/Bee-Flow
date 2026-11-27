require('./moduleRoots.cjs'); // first: the roots of the tree (server/, modules/<id>/server/) resolve as one
require('dotenv').config({ path: require('path').resolve(__dirname, '../.env') });
// OpenTelemetry MUST load before express/pg/http so auto-instrumentation can patch them (a no-op unless enabled).
const otel = require('./telemetry/otel');
require('./boot/moduleTree').assertSoundModuleTree(); // refuse to start when two roots hold one tree path
const express = require('express');
// @typecheck
// Core modules
const componentManager = require('./core/cms/componentManager');
require('./core/executionEngine');
// Fills core's registries with what the features provide (tools, runner ports).
require('./boot/featureRegistrations');

// Route modules
const authRouter = require('./auth/router');
const aiRouter = require('./routes/ai');
const executeRouter = require('./routes/execute');
const { router: agentsRouter } = require('./routes/agents');
const memoryRouter = require('./routes/memory');
const reportsRouter = require('./routes/reports');

// The gate factories (requireModule, requireCapability, requireTraining, ...) of the core's
// mounts below and of every first-party module's mount rows (boot/gates.js), and the loader
// that mounts those rows, slot by slot (modules/firstParty/loader.js; order:
// modules/firstParty/order.json).
const gates = require('./boot/gates').getGates();
const firstParty = require('./modules/firstParty/loader');
const log = require('./telemetry/log');

const app = express();
// Trust proxy: how many reverse-proxy hops sit in front of us. Default `1`
// matches the standard nginx-in-front production deploy; `TRUST_PROXY_HOPS`
// (a whole number, `0` = no proxy; anything else refuses to boot, see
// boot/trustProxyHops.js) overrides it for CDN → load balancer → app setups.
// `true` would work for IP detection but makes express-rate-limit refuse to
// start (ERR_ERL_PERMISSIVE_TRUST_PROXY): anyone could spoof X-Forwarded-For.
const TRUST_PROXY_HOPS = require('./boot/trustProxyHops').parseTrustProxyHops(process.env.TRUST_PROXY_HOPS);
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
    sessionTokenGrant,
} = require('./utils/sessionToken');

// The bridge itself (an X-Session-Token rebuilds the session per request), then
// the Microsoft login-identity recheck — see boot/session.js. The route below
// MINTS the tokens.
sessionLayers.applySessionBridge(app);

app.get('/api/session-token', async (req, res) => {
    if (!req.session?.user?.id) return res.status(401).json({ error: 'Not authenticated' });
    // A cookie session gets the bridge hour; a bridged request may only roll a
    // native-app token (utils/sessionToken.js sessionTokenGrant).
    const grant = sessionTokenGrant(req);
    if (!grant) return res.status(403).json({ error: 'This session cannot mint a session token', code: 'SESSION_TOKEN_REMINT_REFUSED' });

    const userStore = require('./stores/userStore');
    const token = generateToken();
    const userId = req.session.user.id;
    const appPasswordData = await userStore.getAppPassword(userId);

    // A native-app token keeps the cookie's thirty days; everything else keeps
    // the hour the iframe bridge was designed around. The client header plays
    // no part: the native marker comes from the sign-in that deposited it.
    const ttlSeconds = grant.ttlSeconds;

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
            // re-mint would drop on the floor. Dropping them would tell a bridged
            // client that a user awaiting approval was approved — a real
            // bypass, and one that a native TTL would hold open for a month
            // instead of an hour. Both are set once at login and never cleared
            // mid-session, so a frozen copy can never disagree with the
            // session it came from.
            pendingApproval: req.session.pendingApproval || false,
            noOrganization: req.session.noOrganization || false,
            authenticatedAt: req.session.authenticatedAt, // the sign-in time: a bridged session's only proof for a step-up (auth/recentAuth.js)
            nativeClient: grant.nativeClient,

            // ── The other two gates are deliberately NOT here. ──────────────
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
            // second time would mint a fresh DEK over the live one — the
            // guard in auth/encryption.js:setupSSOUserDEK refuses that,
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

// Schema health (always 200, degrades; routes/healthSchema.js) and readiness (503 until this process can serve
// and while it shuts down; routes/ready.js). Unauthenticated, like /api/health above, which matches exactly.
app.use('/api/health/schema', require('./routes/healthSchema'));
app.use('/api/ready', require('./routes/ready'));

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
// cache the synchronous consent registry reads from. The store belongs to module
// compliance: without it there is no override to load.
const legalStore = require('./core/featureModules').optionalFeatureModule('legal/legalStore');
if (legalStore) {
    legalStore.refresh()
        .then(() => log.info('[Server] Consent overrides loaded'))
        .catch(err => log.warn('[Server] Consent overrides init error:', err.message));
}

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
// cannot answer confidently. Module learning owns it: without learning,
// gates.requireTraining lets every request through (boot/gates.js).
const { requireTraining } = gates;

app.use('/agents/memory', memoryRouter);   // Must be before /agents
app.use('/agents', requireTraining('agents'), agentsRouter);
app.use('/reports', reportsRouter);

app.use('/versions', require('./routes/versions'));
// The non-Overview Usage & Monitoring tabs (Safety / Integrations / Azure
// services) sit on `/api/usage/{guardrails,integrations,azure-services}/*`
// and require `advanced_usage_monitoring` (enterprise+). The Overview tab
// hits other paths (/summary, /timeline, /users, etc.) which stay free.
// We inject a path-aware gate that runs only for the gated sub-prefixes
// — the same /api/usage router serves both. `requireFeature` is
// destructured further down, so we lazy-require it here.
// (`/adoption` has its own router below; listed so this is every gated prefix.)
const _ADV_USAGE_PREFIXES = ['/guardrails', '/integrations', '/integrations-health', '/azure-services', '/adoption'];
const _advUsagePrefixGate = (req, res, next) => {
    const path = req.path || '';
    const hit = _ADV_USAGE_PREFIXES.some(p => path === p || path.startsWith(p + '/'));
    if (!hit) return next();
    return require('./core/entitlements/entitlements').requireCapability('advanced_usage_monitoring')(req, res, next);
};
// /api/usage/adoption, /api/terminations and /api/feedback back the Adoption,
// Terminations and Feedback usage tabs — the same gate, applied at the mount.
const _advUsageGate = (req, res, next) => require('./core/entitlements/entitlements').requireCapability('advanced_usage_monitoring')(req, res, next);
app.use('/api/usage/adoption', _advUsageGate, require('./routes/usageAdoption')); // before /api/usage
app.use('/api/usage', _advUsagePrefixGate, require('./routes/usage'));
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
app.use('/api/org-privacy-shield', require('./routes/orgPrivacyShield'));
app.use('/api/org-ai-context', require('./routes/orgAiContext'));
app.use('/api/org-memory', require('./routes/orgMemory'));
app.use('/api/org-integration-cache', require('./routes/orgIntegrationCache'));
app.use('/api/org-azure-config', require('./routes/orgAzureConfig'));
app.use('/api/house-styles', require('./routes/houseStyles'));
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
// Platform-admin-gated — operational data of the whole instance, not public and
// not one organisation's. `?format=prometheus` is the text exposition format.
const { requirePlatformAdmin: _requirePlatformAdminForMetrics } = require('./auth/permissions');
app.get('/api/admin/metrics', _requirePlatformAdminForMetrics('manage_users'), (req, res) => {
    const { getPoolStats } = require('./db');
    if (req.query.format === 'prometheus') {
        res.setHeader('Content-Type', 'text/plain; version=0.0.4');
        return res.send(httpMetrics.renderTextFormat());
    }
    res.json({ ...httpMetrics.snapshot(), pool: getPoolStats(), bestEffort: require('./utils/bestEffort').bestEffortCounts() });
});
app.use('/api/admin/guard', require('./routes/guardInstall'));
app.use('/api/subscriptions', require('./routes/subscriptions'));
app.use('/api/license', require('./routes/license'));
app.use('/api/admin/licenses', require('./routes/adminLicense'));
// Platform modules (instance-level import/remove of modular features): super-admin only, the router enforces it.
app.use('/api/admin/modules', require('./routes/admin/modules'));
app.use('/api/documents', require('./routes/documents'));
app.use('/api/notifications', require('./routes/notifications'));
app.use('/api/me/notification-prefs', require('./routes/notificationPrefs'));
// Deployment/maintenance banner: the deploy pipeline announces a window before
// it rolls the Deployments, so open sessions get warning + an ETA instead of a
// stream that just dies. Write paths are token-gated (CI calls them, not a user).
app.use('/api/maintenance', require('./routes/maintenance'));
// `requireAuth` of auth/index.js, the identity gate of the core mounts below.
const { requireAuthedUser, requireCapability } = gates;
app.use('/api/reminders', require('./routes/reminders'));
// The org-wide policy the named MCP access tokens (module mcp_server) answer to is
// org-admin only, on the caller's own org.
app.use('/api/org/mcp-access', requireAuthedUser, require('./routes/orgMcpAccess'));
app.use('/api/storage', require('./routes/storageProxy'));
app.use('/api/integrations/connections', require('./routes/integrations/connections'));
// Studio Documents — printable documents (invoices, quotes, letters) authored
// by the chat and hand-edited by the user. Deliberately NOT behind a licence or
// beta gate: it replaces the ```quote``` block that every chat could render, so
// gating it would withdraw a capability rather than add one. requireAuth on each
// route is the whole gate, and every store read is owner-scoped in SQL.
// (The prefix is /api/studio-documents, not /api/documents — that one is the
// legacy mobile "Generated" PDF lister above, whose /list this router's /:id
// would otherwise swallow.)
app.use('/api/studio-documents', require('./routes/studioDocuments'));
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
// Dictation (speak into any composer). Auth only — deliberately NOT behind the
// meetingNotes module/capability the transcriptions router sits behind:
// talking instead of typing is not a Meeting Notes feature, and gating it there
// would switch the microphone off for most installs.
app.use('/api/dictate', require('./routes/dictate'));
// Per-user Nextcloud access scope ("What Bee Flow may access"). Deliberately
// NO license gate: narrowing what an assistant may touch is a privacy
// control, never a premium feature.
app.use('/api/nc-scope', require('./routes/ncScope'));
app.use('/api/skills', requireCapability('skills'), requireTraining('skills'), require('./routes/skills'));

// Security Scan was a built-in module here; it now ships as a downloadable
// .bfmod from the Hub marketplace (Modules → Marketplace) and mounts its own
// /api/security routes at install time via the module runtime.

// The per-agent knowledge router (/agents/:id/knowledge) has been WITHDRAWN — Track Z, Z5.
// It wrote to the table knowledge_metadata, which nothing in the product read. The Studio knowledge bases
// live at /api/kb (below).
app.use('/api/kb', requireTraining('knowledge'), require('./routes/knowledgeBases'));
if (process.env.SEARCH_ROUTER_ENABLED !== '0') app.use('/api/search', require('./routes/search')); // see routes/search.js header
app.use('/api/languages', require('./routes/admin/languageRoutes'));
app.use('/api/icons', require('./routes/icons'));
app.use('/api/branding', require('./routes/branding'));

// ── First-party module routes ─────────────────────────────────────────────────
// Every router a first-party module owns (App Studio, automations, webpages,
// notebooks, meeting notes, the integrations, ...) is a row of that module's
// composition (firstParty/<id>.mounts.js), with its gates, in the order of
// modules/firstParty/order.json. Here, after the core's routes: no core mount
// above shares a path with a module mount, so this keeps every overlapping pair
// in its order (boot/composition.mounts.characterisation.test.js).
firstParty.mount(app, gates, 'main');

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
// browser. It also means every probe of a non-existent /auth/* path would run
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
// The 'fallback' slot: after the JSON 404 above, before the SPA fallback. Module
// cms mounts its marketing renderer here (firstParty/cms.mounts.js); it claims
// no path of its own and only answers what every route above declined.
firstParty.mount(app, gates, 'fallback');

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
const { server } = lifecycle.startServer({ app, port: PORT, terminalErrorHandler, runStartupChecks, runStartupTasks });

// ── Graceful shutdown ─────────────────────────────────────────────────────────
// SIGTERM / SIGINT: stop accepting connections, drain the automation runner, stop the
// pushers, flush, close Redis, the blob engines and OTEL, then exit — see boot/lifecycle.js.
const { disconnectRedis } = require('./db');
lifecycle.installGracefulShutdown({ otel, disconnectRedis, server });
