/**
 * Unattended-run session resolution (extracted verbatim from engine.js):
 * vault-backed OAuth session building for scheduled/offline runs, connector
 * identity stamping, and the shared enabled-integrations merge re-export.
 */

const { pool } = require('../../db');
const log = require('../../telemetry/log');

// ── Session resolution ──────────────────────────────────
//
// The automation runs unattended — the user may not have an active browser
// session at run-time. We must therefore source OAuth tokens from the
// long-lived per-user credential vault (automationAuth), not from the
// `user_sessions` table. Falling back to `user_sessions` masks broken
// integrations: as soon as the user logs out, every Gmail/Calendar/Drive
// step would fail, but a search-only step would still run, producing the
// "no data" emails the user reported.
//
// Resolution order:
//   1. automationAuth.buildUserAuth — vault-backed; works without active login.
//      We ask for ALL OAuth providers the user has connected so the catalog
//      registers every integration the user has rights to use, exactly
//      matching the build-time catalog.
//   2. user_sessions row — last-resort backstop for installs that haven't
//      backfilled the vault yet, or for cases where the vault returns null.
//      This fallback is ON BY DEFAULT and disabled by setting
//      AUTOMATION_AUTH_LEGACY=0 (see the `!== '0'` gate below). It sources OAuth
//      tokens from live browser sessions, so disable it once every user's
//      credentials live in the automation-credentials vault.

// Connector-bound users authenticate to Nextcloud through the ExApp reverse
// proxy, not OAuth — so their automation session must carry the instance binding
// (connectorOrgId + connectorNcUid) and the provider marker that resolveAuth /
// resolveConnectorAuth (nextcloudClient.js) and isConnectorUser gate on.
// Without it, NC tools throw on scheduled/offline runs (no warm web session).
// getUser() returns raw columns, so the uid is `nc_uid` (snake_case).
function withConnectorIdentity(session, userRow) {
    if (!session || !userRow || userRow.provider !== 'nextcloud_connector') return session;
    session.connectorOrgId = session.connectorOrgId || userRow.organizationId || null;
    session.connectorNcUid = session.connectorNcUid || userRow.nc_uid || null;
    session.user = session.user || {};
    if (!session.user.provider) session.user.provider = 'nextcloud_connector';
    if (!session.user.ncUid) session.user.ncUid = userRow.nc_uid || null;
    return session;
}

async function resolveUserSession(userId) {
    let userRow = null;
    try {
        const userStore = require('../../stores/userStore');
        userRow = await userStore.getUser(userId).catch(() => null);
        const user = userRow;

        // Which providers (google / microsoft / nextcloud) to fetch tokens for.
        // Shared with the webpage bridge and App Studio connectors — see
        // core/enabledIntegrations.js for why reading only the legacy org column
        // silently produced token-less sessions.
        const { resolveEnabledIntegrations } = require('../integrations/enabledIntegrations');
        const allEnabled = await resolveEnabledIntegrations(userId, user?.organizationId || null);

        const automationAuth = require('../../auth/automationAuth');
        const built = await automationAuth.buildUserAuth(userId, { enabledIntegrations: allEnabled });
        if (built) {
            return withConnectorIdentity({
                // Direct-chat-shaped session so getIntegrationTools and tool
                // dispatchers see the same shape they expect from req.session.
                user: {
                    id: userId,
                    email: user?.email || null,
                    organizationId: user?.organizationId || null,
                    role: user?.role || null,
                },
                isAdmin: !!user?.isAdmin,
                accessToken: built.accessToken,
                refreshToken: built.refreshToken,
                expiresAt: built.expiresAt,
                oauthProvider: built.oauthProvider,
                automationProviders: built.automationProviders || {},
            }, userRow);
        }
    } catch (err) {
        log.warn(`[AutomationRunner] vault session lookup failed for user ${userId}: ${err.message}`);
    }

    // Connector-bound users have no OAuth vault entry (buildUserAuth → null),
    // but still need a session carrying their connector identity so NC tools
    // authenticate via the ExApp proxy on scheduled/offline runs. Must come
    // before the warm-session backstop below — that backstop is the only thing
    // that currently rescues these users, and it's absent on headless runs.
    if (userRow && userRow.provider === 'nextcloud_connector') {
        return withConnectorIdentity({
            user: {
                id: userId,
                email: userRow.email || null,
                organizationId: userRow.organizationId || null,
                role: userRow.role || null,
            },
            isAdmin: !!userRow.isAdmin,
            automationProviders: {},
        }, userRow);
    }

    // Last-resort: legacy user_sessions row. Kept behind a flag so we can
    // ditch it once every install has been migrated to the vault.
    if (require('../../utils/automationAuthLegacy').automationAuthLegacy() !== '0') {
        try {
            const { rows } = await pool.query(
                `SELECT sess FROM user_sessions
                 WHERE sess::jsonb -> 'user' ->> 'id' = $1
                   AND expire > NOW()
                 ORDER BY expire DESC LIMIT 1`,
                [userId],
            );
            if (rows.length > 0) {
                const sess = typeof rows[0].sess === 'string' ? JSON.parse(rows[0].sess) : rows[0].sess;
                return sess;
            }
        } catch (err) {
            log.error(`[AutomationRunner] legacy session lookup error for user ${userId}:`, err.message);
        }
    }
    return null;
}

// Re-exported for the existing callers/tests; the implementation now lives in
// core/enabledIntegrations.js so the runner, the webpage bridge and App Studio
// connectors cannot drift apart again.
const { mergeEnabled } = require('../integrations/enabledIntegrations');

module.exports = { withConnectorIdentity, resolveUserSession, mergeEnabled };
