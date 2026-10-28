/**
 * Running ONE integration tool for a connector: who it runs as (owner, viewer,
 * or a lent connection), the missing-connection answer, and the dispatch
 * itself. Shared by the integration_tool runner and its chain steps.
 */

'use strict';

const log = require('../../telemetry/log');
const {
    connectorError, isPlainObject, integrationIdsFor,
} = require('./shared');
const { fallback } = require('../../utils/bestEffort');

/**
 * The OAuth provider behind an integration id, used as buildUserAuth's
 * providerHint. Without it, a user who has connected BOTH Google and Microsoft
 * gets whichever `Object.entries` happened to yield first as the session's
 * primary accessToken — so a Gmail connector could be handed a Microsoft token.
 */
function providerFor(integrationId, deps) {
    if (!integrationId) return null;
    try {
        // Through deps (session.js wires auth/automationAuth), so this module
        // and its importers stay out of the server's import cycle.
        return deps.providersForIntegrations([integrationId])[0] || null;
    } catch { return null; }
}

/**
 * Resolve WHO a runAs:'viewer' integration_tool connector executes as.
 *
 *   1. The viewer's own resolved tool set (core/integrationTools — the same
 *      strict org ∩ group ∩ toggle ∩ credentials gate the catalog and runtime
 *      use) contains the tool → run as the viewer.
 *   2. Else an applicable LEND grant for the connector's integration
 *      (integrationConnectionStore.resolveConnectionForRun, scoped to this
 *      studio app) → run as the grantor with THEIR session.
 *   3. Else → 409 connection_required (err.provider names the integration so
 *      the client can render "connect <app> first").
 */
async function resolveViewerExecution(connector, { app, viewerId, deps }) {
    if (!viewerId || typeof viewerId !== 'string') {
        throw connectorError(401, 'sign in to use this data source', 'connection_required');
    }
    const provider = (typeof connector.integrationId === 'string' && connector.integrationId) ? connector.integrationId : null;
    // Same `include` the owner path uses — a viewer-mode connector must not fail
    // for the config reason the owner path would hit.
    const sessionOpts = { include: integrationIdsFor(connector), providerHint: providerFor(provider, deps) };

    const session = await deps.buildUserSession(viewerId, app.organizationId || null, sessionOpts);
    try {
        // enabledAppsOverride: the viewer's enabled-apps list is a CHAT
        // preference, not an authorization layer — a configured connector must
        // not fail because the viewer never toggled the app on in the
        // composer. Entitlement + credential gates stay authoritative (same
        // rule as mailboxIdentity.viewerHasIntegration).
        const resolved = await deps.getIntegrationTools({
            userId: viewerId, session, isAdmin: !!session?.isAdmin, automationStep: true,
            enabledAppsOverride: integrationIdsFor(connector),
        });
        const names = new Set((resolved?.tools || []).map((t) => t?.function?.name).filter(Boolean));
        if (names.has(connector.tool)) return { userId: viewerId, session };
    } catch (err) { fallback('appStudio/connectors/dispatch:viewerTools', err); /* the grant check below decides */ }

    if (provider) {
        const grant = await deps.resolveConnectionForRun({
            runningUserId: viewerId,
            runningUserOrgId: session?.user?.organizationId || app.organizationId || null,
            runningUserGroups: session?.user?.groups || [],
            provider,
            resourceType: 'studio_app',
            resourceId: app.id,
        }).catch((e) => fallback('appStudio/connectors/dispatch:resolveViewerExecution', e, null));
        if (grant?.available && grant.mode === 'delegated' && grant.effectiveUserId) {
            const grantorSession = await deps.buildUserSession(grant.effectiveUserId, app.organizationId || null, sessionOpts);
            return { userId: grant.effectiveUserId, session: grantorSession };
        }
    }

    const err = connectorError(409, 'this data source needs a connected account', 'connection_required');
    if (provider) err.provider = provider;
    throw err;
}

/**
 * Read a field off a row for a chain binding. Supports the `a.b` and `a[].b`
 * paths the model allows; `[]` on a leaf yields the array itself (the caller
 * decides whether to fan out over it). Own-props only, no proto walk.
 */
function readRowPath(row, path) {
    if (!isPlainObject(row) || typeof path !== 'string' || !path) return undefined;
    let cur = row;
    for (const rawSeg of path.split('.')) {
        const seg = rawSeg.endsWith('[]') ? rawSeg.slice(0, -2) : rawSeg;
        if (!seg) continue;
        if (cur == null || typeof cur !== 'object' || !Object.hasOwn(cur, seg)) return undefined;
        cur = cur[seg];
    }
    return cur;
}

/**
 * "You never connected this app" — the one upstream failure that is a SETUP
 * problem rather than a fault, and the only one the UI can offer a fix for.
 *
 * Integration executors disagree about how they report it: most return a soft
 * `{ error }`, but the Google and Microsoft clients THROW a plain Error
 * (integrations/googleClient.js), and the key-based ones say "not configured".
 * Left unclassified, a throw carries no status and the route collapses it to a
 * generic 500 — the author sees "Connector failed to run" and has nothing to act
 * on. Recognising it here turns all of those into the 409 `connection_required`
 * the client already renders as "Connect <app> first".
 */
const MISSING_CONNECTION_RE = /not connected|must log in|not configured|no (?:valid )?(?:credentials|token|api key)|connect (?:it |your account )?(?:via|in) settings|authenticat|unauthoriz|invalid_grant/i;

/**
 * Build the 409 — but first check whether the account IS connected.
 *
 * "Not connected to Gmail" from the upstream client means only that the SESSION
 * carried no token. That has two very different causes, and telling a user to
 * connect an app they already connected sends them in a circle:
 *
 *   • no active credential in the vault → they really do need to connect it;
 *   • an active credential exists but the session didn't carry it → OUR fault,
 *     and no amount of clicking "Connect" will fix it, so say something else and
 *     log it as the server-side defect it is.
 *
 * `code` stays `connection_required` either way so existing clients keep working;
 * `reason` distinguishes them for a caller that wants to.
 * @param {string} message
 */
async function connectionError(connector, message, { userId, deps } = {}) {
    const provider = (typeof connector?.integrationId === 'string' && connector.integrationId) ? connector.integrationId : null;
    let hasCredential = false;
    if (userId && provider) {
        try {
            const oauthProvider = providerFor(provider, deps);
            if (oauthProvider) {
                hasCredential = !!(await deps.getProviderAuth(userId, oauthProvider))?.accessToken;
            }
        } catch (err) { fallback('appStudio/connectors/dispatch:connectionError', err); /* fall back to the plain "connect it" message */ }
    }

    if (hasCredential) {
        log.warn(`[Connectors] ${provider} is connected for user ${userId} but the connector session carried no token — upstream said: ${String(message).slice(0, 200)}`);
        const err = connectorError(409, `Your ${provider} connection could not be loaded. Try disconnecting and reconnecting it in Settings → Connections.`, 'connection_required');
        err.reason = 'token_unavailable';
        if (provider) err.provider = provider;
        return err;
    }

    const err = connectorError(409, String(message).slice(0, 300), 'connection_required');
    err.reason = 'not_connected';
    if (provider) err.provider = provider;
    return err;
}

/**
 * Run one tool call for a resolved identity. Soft `{error}` results and thrown
 * executor errors both surface as structured connector errors — a missing
 * connection as 409, anything else as 502.
 */
async function dispatchTool(tool, args, exec, deps, app, connector) {
    let result;
    try {
        result = await deps.executeTool(tool, args, {
            userId: exec.userId,
            session: exec.session,
            orgId: exec.orgId ?? (app.organizationId || null),
            autoSend: true,                   // headless / unattended dispatch
            // A data source of a Studio app: the dispatcher's chokepoint
            // writes the egress row under the identity it ran as.
            egress: {
                source: 'studio_app',
                ids: {
                    organization_id: exec.orgId ?? (app.organizationId || null),
                    user_id: exec.userId || null,
                    agent_name: `App: ${app.name || 'Untitled app'}`,
                },
            },
        });
    } catch (err) {
        if (Number.isInteger(err?.status)) throw err;          // already classified
        const message = String(/** @type {Error} */ (err)?.message || err);
        if (MISSING_CONNECTION_RE.test(message)) throw await connectionError(connector, message, { userId: exec.userId, deps });
        throw connectorError(502, message.slice(0, 300), 'connector_failed');
    }
    if (result && typeof result === 'object' && result.error) {
        const message = String(result.error);
        if (MISSING_CONNECTION_RE.test(message)) throw await connectionError(connector, message, { userId: exec.userId, deps });
        throw connectorError(502, message.slice(0, 300), 'connector_failed');
    }
    return result;
}

module.exports = { providerFor, resolveViewerExecution, readRowPath, connectionError, dispatchTool };

/**
 * @typedef {{ userId: string, session: Awaited<ReturnType<typeof import('./session').defaultBuildUserSession>>, orgId?: string | null }} ConnectorExec  The identity one tool call runs as.
 */
