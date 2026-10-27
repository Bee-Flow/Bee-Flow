/**
 * The sessions a connector runs under (the owner's, or a viewer's, built
 * headless) and the default dependency graph runConnector overrides in tests.
 */

'use strict';

const log = require('../../telemetry/log');
const { fallback } = require('../../utils/bestEffort');

// ── Headless user session (mirrors core/webpageBridgeAuth.buildAuthorSession) ─
// Duplicated rather than imported so connectors keep working if that module
// changes shape — same rationale as the webpage bridge duplicating the runner's
// resolveUserSession. Builds a session shim for ANY user id: the app OWNER for
// the default acts-as-owner path, or the calling VIEWER (or a lending grantor)
// for runAs:'viewer' connectors. Test code overrides via _deps.buildOwnerSession
// / _deps.buildUserSession.
//
// `include` carries the integrations this session is ABOUT TO DISPATCH, so the
// provider list can never be empty for the one call that needs it. That is not
// a convenience: an empty list makes automationAuth.buildUserAuth take its
// `required.length === 0` shortcut, which returns a TRUTHY object with a null
// accessToken — and the Google client then reports a connected account as "not
// connected". See core/enabledIntegrations.js for the full trap.
/**
 * @param {string} userId
 */
async function defaultBuildUserSession(userId, fallbackOrgId = null, { include = [], providerHint = null } = {}) {
    const userStore = require('../../stores/userStore');
    const automationAuth = require('../../auth/automationAuth');
    const { resolveEnabledIntegrations } = require('../../core/integrations/enabledIntegrations');
    const user = await userStore.getUser(userId).catch((e) => fallback('appStudio/connectors/session:defaultBuildUserSession', e, null));
    const orgId = user?.organizationId || fallbackOrgId || null;

    let enabled = include;
    try {
        enabled = await resolveEnabledIntegrations(userId, orgId, { include });
    } catch (err) { fallback('appStudio/connectors/session:defaultBuildUserSession#2', err); /* best-effort — `include` alone still covers the dispatched tool */ }

    // `groups` rides along so viewer-mode grant resolution can honor
    // group-scoped lends (resolveConnectionForRun's runningUserGroups).
    const shimUser = {
        id: userId,
        email: user?.email || null,
        organizationId: orgId,
        role: user?.role || null,
        groups: Array.isArray(user?.groups) ? user.groups : [],
    };
    try {
        const built = await automationAuth.buildUserAuth(userId, { enabledIntegrations: enabled, providerHint });
        // `built.accessToken` — NOT just `built`. buildUserAuth answers with a
        // token-less shim when it was asked for no OAuth providers, and adopting
        // that as a session is what turns a working connection into "not
        // connected" three layers downstream.
        if (built?.accessToken) {
            return {
                user: shimUser,
                isAdmin: !!user?.isAdmin,
                accessToken: built.accessToken,
                refreshToken: built.refreshToken,
                expiresAt: built.expiresAt,
                oauthProvider: built.oauthProvider,
                automationProviders: built.automationProviders || {},
            };
        }
    } catch (err) {
        log.warn(`[Connectors] buildUserAuth failed for user ${userId}: ${/** @type {Error} */ (err).message}`);
    }

    // Legacy session fallback — the same backstop the runner
    // (automationRunner/engine.js) and the webpage bridge both keep. A user who
    // signed in with Google this session has usable tokens on their session row
    // even when the vault has nothing.
    if (require('../../utils/automationAuthLegacy').automationAuthLegacy() !== '0') {
        try {
            const { pool } = require('../../db');
            const { rows } = await pool.query(
                `SELECT sess FROM user_sessions
                 WHERE sess::jsonb -> 'user' ->> 'id' = $1
                   AND expire > NOW()
                 ORDER BY expire DESC LIMIT 1`,
                [userId],
            );
            if (rows.length > 0) {
                const sess = typeof rows[0].sess === 'string' ? JSON.parse(rows[0].sess) : rows[0].sess;
                if (sess?.accessToken) return sess;
            }
        } catch (err) {
            log.warn(`[Connectors] legacy session lookup failed for user ${userId}: ${/** @type {Error} */ (err).message}`);
        }
    }

    // Bare shim — non-OAuth tools still run; OAuth ones surface "not connected".
    return {
        user: shimUser,
        isAdmin: !!user?.isAdmin,
        automationProviders: {},
    };
}

async function defaultBuildOwnerSession(app, opts = {}) {
    return defaultBuildUserSession(app.userId, app.organizationId || null, opts);
}

// Default dependency graph — lazily required so this module can be loaded
// (and unit-tested) without pulling the whole runner/store graph. Every entry
// is overridable via `_deps` on the runConnector opts (test-only seam).
function defaultDeps() {
    return {
        executeTool: (/** @type {[string, unknown, object?]} */ ...a) => require('../../core/tools/toolDispatcher').executeTool(...a),
        executeAutomation: (/** @type {Parameters<typeof import('../../core/automationRunner').executeAutomation>} */ ...a) => require('../../core/automationRunner').executeAutomation(...a),
        getAutomation: (/** @type {Parameters<typeof import('../../stores/automationStore').getAutomation>} */ ...a) => require('../../stores/automationStore').getAutomation(...a),
        deriveFinalOutput: (/** @type {Parameters<typeof import('../actionExecutor/automationBridge').deriveFinalOutput>} */ ...a) => require('../actionExecutor/automationBridge').deriveFinalOutput(...a),
        // getProviderAuth, NOT the raw store read: it refreshes a token with
        // less than five minutes left and refuses a credential that is revoked
        // or needs re-auth. A raw getCredential handed back a stale access
        // token, so every REST connector on a short-lived provider (Withings
        // expires in 3 h) died silently once the first token aged out.
        getProviderAuth: (/** @type {Parameters<typeof import('../../auth/automationAuth').getProviderAuth>} */ ...a) => require('../../auth/automationAuth').getProviderAuth(...a),
        providersForIntegrations: (/** @type {Parameters<typeof import('../../auth/automationAuth').providersForIntegrations>} */ ...a) => require('../../auth/automationAuth').providersForIntegrations(...a),
        safeFetch: (/** @type {Parameters<typeof import('../../utils/ssrfGuard').safeFetch>} */ ...a) => require('../../utils/ssrfGuard').safeFetch(...a),
        isPrivateTarget: (/** @type {Parameters<typeof import('../../utils/isPrivateTarget').isPrivateTarget>} */ ...a) => require('../../utils/isPrivateTarget').isPrivateTarget(...a),
        buildOwnerSession: defaultBuildOwnerSession,
        buildUserSession: defaultBuildUserSession,
        getIntegrationTools: (/** @type {{ userId: string; session: Object; isAdmin?: boolean | undefined; enabledAppsOverride?: string[] | null | undefined; extraEnabledApps?: string[] | null | undefined; }} */ a) => require('../../core/integrations/integrationTools').getIntegrationTools(a),
        resolveConnectionForRun: (/** @type {Parameters<typeof import('../../stores/integrationConnectionStore').resolveConnectionForRun>} */ ...a) => require('../../stores/integrationConnectionStore').resolveConnectionForRun(...a),
    };
}

module.exports = { defaultBuildUserSession, defaultBuildOwnerSession, defaultDeps };

/**
 * @typedef {{ include?: string[], providerHint?: string | null }} SessionOpts
 */

/** @typedef {ReturnType<typeof defaultDeps>} ConnectorDeps */
