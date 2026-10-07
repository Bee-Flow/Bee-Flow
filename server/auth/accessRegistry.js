// @typecheck
/**
 * Route → requirement registry.
 *
 * THIS IS AN OVERLAY, NOT A ROUTE LIST. The route list is machine-enumerated by
 * auth/routeWalk.cli.js (1176 routes, free and complete on day one). What a
 * machine cannot see is what the ~298 handlers that gate *inside their body*
 * actually require — so that, and only that, is declared here by hand.
 *
 * Modelled on license/featureMap.js, whose own header (:6-8) says it is
 * "documentation + a future regression target — they don't drive runtime
 * routing", and whose :21-23 asks for exactly the drift test that now exists in
 * accessRegistry.drift.test.js. Nothing here is consulted at request time.
 *
 * KEYED BY `METHOD /full/path` — never by mount path. /auth is mounted 5 times;
 * a mount-path key could not tell those apart.
 *
 * APP-WIDE COMPANION: auth/accessRegistry.sweep.test.js statically sweeps every
 * route OUTSIDE triagedPrefixes (via auth/routeSurfaceSweep.js) and demands that
 * each one is gated, declared here, or explicitly exempted there with a
 * checkable reason. Growing triagedPrefixes hands a prefix over from that broad
 * net to this registry's deep, walker-backed drift test.
 *
 * `enforcement` is five-valued because a boolean would be a category error:
 *
 *   middleware  the gate is in the chain and tagged → MACHINE-VERIFIED by the
 *               drift test. This is the only value that is checked rather than
 *               believed. P4 exists to move routes into this column.
 *   handler     the gate is decided in the handler body. The drift test verifies
 *               that a gate-shaped call EXISTS; the permission list itself is
 *               declared, not verified. `verifiedBy` names the authz test that
 *               does verify it.
 *   scoped      no gate — the route is reachable and filters ROWS instead.
 *               Modelling this as "requires permission X" would make the UI lie.
 *   public      deliberately ungated. Exists so "open by design" is
 *               distinguishable from "someone forgot the gate".
 *   untriaged   nobody has looked yet. Renders as "Not determined" — never as
 *               allowed.
 */

module.exports = {
    version: 1,

    /**
     * Prefixes whose in-handler checks have been triaged. A route outside these
     * is still enumerated and still shown — as `unknown` with reason
     * `not_yet_triaged`. Coverage is computed per route, not promised per router.
     */
    triagedPrefixes: ['/auth'],

    /**
     * Chain slots that are plumbing, not gates. The drift test allows these to
     * carry no gate tag; anything else untagged in a chain is a finding.
     * (App-level app.use(fn) middleware is excluded by the walker already.)
     *
     * THE TEST FOR THIS LIST: does the middleware consider WHO the caller is?
     * If yes it is a gate and must be tagged, however innocuous it looks — that
     * is how the four local org-admin re-implementations were found. If it only
     * checks the state of a resource (missing → 404, not configured → 400) or
     * the readiness of the process, it belongs here: it changes reachability but
     * never depends on identity, so it has no place in a per-user access answer.
     */
    plumbingNames: [
        'jsonParser', 'urlencodedParser', 'rawParser', 'textParser',
        'rateLimitMiddleware', 'perUserRateLimitMiddleware',
        'multerMiddleware', 'makeMiddleware', 'expressInit', 'query',
        'serveStatic', 'session', 'helmetMiddleware', 'corsMiddleware',
        'connectorJwtMiddleware',
        // Shapes the response (adds an org filter to the query); does not decide
        // whether the request is allowed. Registry entries model this as
        // scope.kind = 'orgFiltered' on the route itself.
        'attachOrgFilter',
        // OPAQUE readiness probe — 503s until the crypto module has loaded.
        // A liveness concern, not an authorization one.
        'ensureReady',
        // Resolves req.org and 404s/400s if the org is missing or not bound to a
        // Nextcloud instance. Never reads the session — the real gate on those
        // routes is the (tagged) requireOrgAdmin('orgId') sitting beside it.
        'requireNcOrg',
        // The zod request schema (core/http/validate.js). It reads body, query
        // and params and answers 400 on a shape it does not recognise; it never
        // touches req.session, so it decides whether the REQUEST is well formed
        // and never who the caller is.
        'validateRequest',
    ],

    routes: {
        // ── The endpoint that backs the People directory ──────────────
        'GET /auth/users': {
            enforcement: 'handler',
            rbac: { anyOf: ['all', 'manage_users', 'admin_security', 'org_admin'] },
            scope: { kind: 'orgFiltered' },
            note: 'Gate is in the body (adminRoutes.js:119-129); the response is additionally org-filtered by resolveUserOrgIds, and the caller always sees their own row.',
            verifiedBy: 'auth/adminRoutes.users.authz.test.js',
        },
        'GET /auth/organizations': {
            enforcement: 'handler',
            rbac: { anyOf: ['all', 'manage_users', 'admin_security', 'org_admin'] },
            scope: { kind: 'orgFiltered' },
            note: 'Same shape as GET /auth/users (adminRoutes.js:577-597) — body gate plus org filtering.',
            verifiedBy: 'auth/adminRoutes.users.authz.test.js',
        },

        // ── Org-admin-of-parameter: gated in the body, scoped by :id ──
        'GET /auth/organizations/:id/encryption': {
            enforcement: 'handler',
            scope: { kind: 'orgAdminOfParam', param: 'id' },
            note: 'adminRoutes.js:667 — requireStrictOrgAdmin(req, res) at the top of the body delegates to isOrgAdminForOrg(req, req.params.id), so a caller can only read the encryption policy of an org they administer (super admins pass via the short-circuit inside isOrgAdminForOrg). The isSuperAdminReq(req) call further down is NOT a gate: it only fills the canEditScope response flag, which tells the UI whether to render the per-surface controls.',
        },
        'PUT /auth/organizations/:id/encryption': {
            enforcement: 'handler',
            scope: { kind: 'orgAdminOfParam', param: 'id' },
            note: 'adminRoutes.js:707 — same body gate as the GET. Changing the per-surface `scope` additionally requires a super admin; the tier change itself is open to the org admin.',
        },

        // ── Org-admin over the caller's OWN org (no path parameter) ───
        'GET /auth/admin/connector-health/mine': {
            enforcement: 'handler',
            scope: { kind: 'ownOrgAdmin' },
            note: 'routes/admin/connectorHealth.js:181 — behind requireAuth, then the body 403s unless the caller is an org admin (or a platform admin). The org is always resolved from the session (sessUser.organizationId), never from input, which is what distinguishes it from the /fleet sibling next to it — that one is requireSuperAdmin and sees every org.',
        },

        // ── Deliberately open ─────────────────────────────────────────
        'POST /auth/admin-login': {
            enforcement: 'public',
            note: 'The login endpoint itself — necessarily reachable by anyone, since authenticating is what it is for. loginThrottle.checkLoginAllowed(req, username) at the top of the body is ABUSE RESISTANCE, not authorization: it answers "has this identifier failed too often lately?" and never grants or withholds access to a resource. It was added after a pentest sent 120 failed logins in two seconds and received 120 × 401. A probe hit here is expected and is not a gate.',
        },
        'POST /auth/opaque/login/start': {
            enforcement: 'public',
            note: 'The OPAQUE half of the login endpoint — anonymous by necessity, same as POST /auth/admin-login. loginThrottle.checkLoginAllowed(req, username) in the body is ABUSE RESISTANCE, not authorization. It was added when this route turned out to have been left out of the login hardening entirely: it answered 401 for an unknown name, 400 {useLegacy} for a legacy one and 200 for an OPAQUE one, which made it an account-existence oracle needing no timing measurement. Absent accounts now get a fake credential (see opaqueRoutes.js) and the handshake fails at login/finish. Verified by auth/opaqueRoutes.enumeration.test.js.',
        },
        'POST /auth/signup': {
            enforcement: 'public',
            note: 'Public signup. checkWebSignupAllowed() is org policy (is signup open?), NOT authorization — a probe hit here is expected and is not a gate.',
        },
        'POST /auth/pending-signup': {
            enforcement: 'public',
            note: 'As POST /auth/signup.',
        },
        'GET /auth/callback': {
            enforcement: 'public',
            note: 'SSO callback — the identity provider is the authenticator. The session.isAdmin touch is post-login session shaping, not a gate.',
        },
        'GET /auth/callback/:provider': {
            enforcement: 'public',
            note: 'As GET /auth/callback.',
        },

        // ── Self-scoped: reachable by anyone signed in, answers only about them ──
        'GET /auth/my-permissions': {
            enforcement: 'scoped',
            scope: { kind: 'selfOnly' },
            note: 'loginRoutes.js:47 — returns the CALLER\'s own permissions. getUserPermissions() appears in the body but is the answer, not a gate. There is deliberately no target-user parameter.',
        },
        'GET /auth/user': {
            enforcement: 'scoped',
            scope: { kind: 'selfOnly' },
            note: 'The caller\'s own profile. isEncryptionEnabledForUser() is a capability read, not a gate.',
        },
        'GET /auth/my-entitlements': {
            enforcement: 'scoped',
            scope: { kind: 'selfOnly' },
        },
        'GET /auth/me/group-access': {
            enforcement: 'scoped',
            scope: { kind: 'selfOnly' },
        },

        // ── Nextcloud app password: self-scoped, behind requireAuth ──
        // Both carry an isNextcloudOAuthSession(req) call that reads the
        // session, so the drift test sees a gate shape. It is not an identity
        // gate: it asks WHICH OAuth provider the caller signed in with, never
        // who they are. Neither route takes a target-user parameter — they
        // answer about, and write to, req.session.user.id only.
        'GET /auth/app-password-status': {
            enforcement: 'scoped',
            scope: { kind: 'selfOnly' },
            note: 'adminRoutes.js — the caller\'s own app-password status. isNextcloudOAuthSession() only decides the isNextcloudUser response field; deriving it from token presence alone previously mislabelled Google-connector sessions as Nextcloud ones.',
        },
        'POST /auth/create-app-password': {
            enforcement: 'scoped',
            scope: { kind: 'selfOnly' },
            note: 'adminRoutes.js — mints an app password for the caller from their own Nextcloud OAuth token. isNextcloudOAuthSession() is a provider check, not an authorization one: session.accessToken is a slot shared with Google/Microsoft, and without it a Google token would be forwarded as a Bearer to the Nextcloud host. Verified by auth/appPasswordSession.test.js.',
        },

        // ── Agent version history: requireAuth on the router, then the ────
        // per-agent editor gate in each handler body (U4b closed a pinned
        // GEPIND_ONGEGATE hole here — before 2026-09-05 these four routes
        // never read req.session at all). Snapshots are raw agent rows, i.e.
        // DRAFT content (concept system_prompt + config), which the A1
        // concept/live split reserves for editors — hence canModifyAgent on
        // the reads too, not canReadAgent.
        'GET /versions/:agentId': {
            enforcement: 'handler',
            note: 'routes/versions.js — requireEditableAgent(req, res): loads the agent, then canModifyAgent (owner / super-admin / manage_agents within the agent\'s org — routes/agents/crud.js), the same one-helper gate routes/agents/publishVersion.js uses. Anonymous is already 401\'d by the router-level requireAuth.',
            verifiedBy: 'routes/versions.authz.test.js',
        },
        'POST /versions/:agentId/pre-refine': {
            enforcement: 'handler',
            note: 'As the restore route — this WRITES a version row (the undo point the A2 refine rail takes before it applies an AI rewrite), so it is gated by the same requireEditableAgent call and not by the read gate. Takes no body: the snapshot is the server\'s own read of the agent row.',
            verifiedBy: 'routes/versions.authz.test.js',
        },
        'GET /versions/:agentId/:versionId': {
            enforcement: 'handler',
            note: 'As GET /versions/:agentId, plus the version↔agent binding check (a version of another agent 404s).',
            verifiedBy: 'routes/versions.authz.test.js',
        },
        'POST /versions/:agentId/:versionId/restore': {
            enforcement: 'handler',
            note: 'As GET /versions/:agentId/:versionId — a restore is a concept write, gated exactly like the sibling publish-version write.',
            verifiedBy: 'routes/versions.authz.test.js',
        },
        'DELETE /versions/:agentId/:versionId': {
            enforcement: 'handler',
            note: 'As the restore route. The version↔agent binding check here is load-bearing: deleteVersion() takes only the version id, so without it any editor of any agent could delete versions of every other agent.',
            verifiedBy: 'routes/versions.authz.test.js',
        },

        // ── Rendered documents: requireAuth on the router, nothing in the ─
        // handler bodies (U4b closed a pinned GEPIND_ONGEGATE hole here —
        // before 2026-09-05 these three routes never read req.session, so the
        // shared document-renderer temp directory was anonymously listable,
        // download URLs included). The only live client is the mobile
        // Documents → "Generated" tab, which sends the session cookie.
        // Declared so the KNOWN LIMIT is on record where access is modelled:
        // the directory carries no ownership metadata, so the rows are shared
        // across signed-in users rather than per-user scoped — the follow-up
        // lives in the routes/documents.js header.
        'GET /api/documents/list': {
            enforcement: 'middleware',
            note: 'routes/documents.js — router-level requireAuth; anonymous → 401. NOT per-user scoped: a filename is <random>_<name>.pdf and fs stat is all the metadata there is, so every signed-in user sees the same listing. Narrowing it needs an ownership ledger at the writer (follow-up in the file header).',
            verifiedBy: 'routes/documents.authz.test.js',
        },
        'GET /api/documents/download/:filename': {
            enforcement: 'middleware',
            note: 'As GET /api/documents/list — behind the same router-level requireAuth; the unguessable filename is defence in depth once /list is signed-in-only, not the credential it accidentally used to be.',
            verifiedBy: 'routes/documents.authz.test.js',
        },
        'GET /api/documents/view/:filename': {
            enforcement: 'middleware',
            note: 'As GET /api/documents/download/:filename, inline variant (the mobile tab fetches this one through the session cookie).',
            verifiedBy: 'routes/documents.authz.test.js',
        },

        // ── Privacy Shield status: requireAuth on the route, nothing gate- ─
        // shaped in the body. Answers only about the caller — the org comes
        // from the session via resolveEffectiveOrgId (tier/config resolution,
        // never an authz decision) and the response is booleans and enums.
        'GET /api/privacy/shield-status': {
            enforcement: 'middleware',
            scope: { kind: 'selfOnly' },
            note: 'routes/privacyShieldStatus.js — route-level requireAuth; anonymous → 401 before any resolution. Self-scoped summary of what the runtime would do with the CALLER\'s next message (enabled / source / action / failMode / guardReachable / euMode / coworkEnabled / chatMonitoring), read from the same resolution layer the message path runs. chatMonitoring is the chat-signals notice for the caller\'s effective org (state, start date, version, chat types, signals, the org\'s own https notice URL) from core/entitlements/chatMonitoringFlag, the resolver the recorder reads too. Never 500s and carries no ids, names or error text (BFSF-441): an unreadable configuration reads as "off", the safe direction for a status pill — no shield claim pre-auth, no green lock while the detector is unreachable.',
            verifiedBy: 'routes/privacyShieldStatus.test.js',
        },
        // ── Chat signals: the caller's own "Don't count my chat turns" ──
        // preference (GDPR Art. 21). requireAuth on each route; the user is
        // the session's, never an input, and nothing returns an id. There is
        // deliberately no admin equivalent, list or count.
        'GET /api/privacy/chat-signals/preference': {
            enforcement: 'middleware',
            scope: { kind: 'selfOnly' },
            note: 'routes/privacyChatSignals.js — route-level requireAuth; anonymous → 401. Answers { counted } for the CALLER only (stores/chatSignalObjectionStore.isObjecting on req.session.user.id); takes no query. No admin path exists: an objection is never visible to anyone else.',
            verifiedBy: 'routes/privacyChatSignals.test.js',
        },
        'PUT /api/privacy/chat-signals/preference': {
            enforcement: 'middleware',
            scope: { kind: 'selfOnly' },
            note: 'routes/privacyChatSignals.js — route-level requireAuth; anonymous → 401. Body { counted: boolean } (strict); writes the CALLER\'s own objection only (setObjecting on req.session.user.id) and answers { counted }.',
            verifiedBy: 'routes/privacyChatSignals.test.js',
        },
    },

    /**
     * Routes inside a triaged prefix that gate inside their handler but have no
     * declaration yet. These render as "Not determined" — never as allowed.
     *
     * MUST NOT GROW: assertion 6 of the drift test freezes the count, so the
     * number only ever goes down. Every line here is a real authorization rule
     * that currently exists only in a handler body and nowhere a machine can
     * read it. That is precisely the debt this whole registry exists to make
     * visible instead of invisible.
     *
     * Burning these down is P4/P7 work: read the handler, then either declare it
     * (move it to `routes` with a `verifiedBy` authz test) or, better, convert the
     * body check to a tagged middleware so the drift test verifies it for free.
     */
    untriaged: [
        // Group CRUD + membership — session.isAdmin / assertCanManageGroupMembers in the body
        'GET /auth/groups',
        'POST /auth/groups',
        'PUT /auth/groups/:id',
        'DELETE /auth/groups/:id',
        'POST /auth/groups/:id/members',
        'DELETE /auth/groups/:id/members/:userId',
        'PUT /auth/groups/:id/access',
        // Org mutation + availability
        'PUT /auth/organizations/:id',
        'GET /auth/organizations/:orgId/org-availability',
        'PUT /auth/organizations/:orgId/org-availability',
        // Self-service org surfaces gated by requireOrgAdminLike(req) in the body
        'GET /auth/me/active-features',
        'PUT /auth/me/active-features',
        'PUT /auth/me/org-access',
        'POST /auth/users/me/leave-org',
        // Super-admin only, enforced by requireSuperAdmin(req) in the body
        'PUT /auth/admin/selected-org',
        // Invitations — isOrgAdminForOrg(req) in the body
        'POST /auth/invitations',
        'GET /auth/invitations',
        'DELETE /auth/invitations/:id',
        // Nextcloud connector key management
        'POST /auth/admin/connector/tenants/:orgId/key',
        'GET /auth/admin/connector/tenants/:orgId/key',
        'DELETE /auth/admin/connector/tenants/:orgId/key',
        'POST /auth/admin/nc-bindings/generate-pairing-code',
        'DELETE /auth/admin/nc-bindings/org/:orgId',
        // MFA assist
        'POST /auth/mfa/assist',
    ],
};
