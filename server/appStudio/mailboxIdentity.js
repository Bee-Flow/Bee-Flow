/**
 * WHO a mailbox connector reads and sends as.
 *
 * Extracted so the read path (mailboxConnector.js) and the write path
 * (actionExecutor's send_email step) can never disagree about identity — a
 * support desk where the inbox is read as one user and replies leave as another
 * is a data-leak shape, not a cosmetic bug.
 *
 * The ladder mirrors connectors.js resolveViewerExecution, with one deliberate
 * difference: a mailbox connector has no `tool` name, so the viewer gate asks
 * "does this viewer have ANY tool of this integration?" — the same
 * org ∩ group ∩ toggle ∩ credentials gate, widened from one tool to the app.
 *
 *   runAs: 'owner'  → the app owner. Right for a team mailbox everyone answers from.
 *   runAs: 'viewer' → the calling user, so an agent replies as themselves.
 *                     Falls back to a lend grant, then 409 connection_required.
 *
 * Unlike connectors, this returns a TOKEN BLOB rather than a session shim,
 * because services/email/* is session-less by design.
 */
const log = require('../telemetry/log');

const PROVIDER_BY_INTEGRATION = Object.freeze({ gmail: 'google', outlook: 'microsoft' });
const INTEGRATION_BY_MAILBOX_PROVIDER = Object.freeze({ gmail: 'gmail', outlook: 'outlook' });

/**
 * How a "shared" mailbox is actually reached, per provider. Server-derived and
 * never authored: Gmail simply cannot delegate, so promising otherwise in the
 * model would be a lie the runtime then has to break.
 */
function sharedModeFor(provider) {
    return provider === 'outlook' ? 'delegated_mailbox' : 'delivered_alias';
}

function identityError(status, message, code) {
    const err = new Error(message);
    err.status = status;
    if (code) err.code = code;
    return err;
}

function defaultDeps() {
    return {
        getProviderAuth: (...a) => require('../auth/routineAuth').getProviderAuth(...a),
        upsertCredential: (...a) => require('../stores/routineCredentialStore').upsertCredential(...a),
        getIntegrationTools: (...a) => require('../core/integrations/integrationTools').getIntegrationTools(...a),
        resolveConnectionForRun: (...a) => require('../stores/integrationConnectionStore').resolveConnectionForRun(...a),
        resolveIntegration: (...a) => require('../core/integrations/integrationToolMap').resolveIntegration(...a),
        getUser: (...a) => require('../stores/userStore').getUser(...a),
        buildUserSession: (...a) => require('./connectors')._defaultBuildUserSession(...a),
        resolveMailboxAddress: (...a) => require('../services/email/fetch').resolveMailboxAddress(...a),
    };
}

/**
 * Vault key derivation is org-scoped and rejects an empty orgId, so an org-less
 * consumer account needs the same per-user fallback the Google/Microsoft
 * connect routes use. Getting this wrong silently drops the refresh write-back
 * and the connection dies at the next token expiry.
 */
function vaultOrgId(user, fallbackOrgId) {
    return user?.organizationId || fallbackOrgId || `user:${user?.id}`;
}

/**
 * Does this user have the integration available to them right now?
 *
 * Also consulted by the integrations /required pre-flight: the connections
 * registry is the NEW credential store, while most Google/Microsoft users hold
 * their credential in THIS legacy layer — a pre-flight that only reads the new
 * store told those users to "Connect gmail" over an app that was loading fine.
 * `deps` is optional for that caller; the mailbox ladder keeps injecting its own.
 */
async function viewerHasIntegration(integrationId, { userId, orgId, deps: injected }) {
    const deps = injected || defaultDeps();
    try {
        const session = await deps.buildUserSession(userId, orgId, {
            include: [integrationId],
            providerHint: PROVIDER_BY_INTEGRATION[integrationId] || null,
        });
        // enabledAppsOverride: the per-user enabled-apps list is a CHAT
        // preference — which apps the assistant may reach for in a
        // conversation. A mailbox connector is explicit app configuration, and
        // being vetoed by that preference produced "Your organisation has not
        // enabled gmail" for a user whose org plainly had (gmail is not in
        // AUTO_ENABLED_APPS, so a saved list without it hid the tools). The
        // override bypasses ONLY the preference layer; the entitlement and
        // credential gates in getIntegrationTools stay authoritative — the
        // same rule skill-scoped extraEnabledApps follows.
        const resolved = await deps.getIntegrationTools({
            userId, session, isAdmin: !!session?.isAdmin, routineStep: true,
            enabledAppsOverride: [integrationId],
        });
        for (const t of resolved?.tools || []) {
            const name = t?.function?.name;
            if (!name) continue;
            // resolveIntegration answers with an OBJECT ({ integration, label, … }),
            // never a string. Comparing it directly to the id was silently false
            // for every user and every integration, which is what made a mailbox
            // insist the org had not enabled Gmail while it plainly had.
            // connectors.js:281 does it correctly; this now matches.
            const resolvedTool = deps.resolveIntegration(name);
            if (resolvedTool?.integration === integrationId) return true;
        }
    } catch { /* fall through to the grant check */ }
    return false;
}

/** Does this user hold a usable token for the provider at all? (Message only.) */
async function hasAnyCredential(userId, oauthProvider, { integrationId, orgId, deps }) {
    try {
        const vault = await deps.getProviderAuth(userId, oauthProvider).catch(() => null);
        if (vault?.accessToken) return true;
        const session = await deps.buildUserSession(userId, orgId, {
            include: [integrationId], providerHint: oauthProvider,
        }).catch(() => null);
        return !!(session?.oauthProvider === oauthProvider && session?.accessToken)
            || !!session?.routineProviders?.[oauthProvider]?.accessToken;
    } catch {
        return false;
    }
}

/**
 * Find a usable credential for this user, in the order the rest of the platform
 * already uses.
 *
 *   1. The encrypted vault (routine_credentials) — refreshes and persists, and
 *      is the ONLY source a background sync can use, since it has no session.
 *   2. The user's live Bee Flow session.
 *
 * Step 2 exists because signing in to Bee Flow with Google or Microsoft ALREADY
 * grants the mail scopes (auth/permissions.js OAUTH_PROVIDERS) — asking that
 * user to "connect Gmail" separately is asking them to redo something they just
 * did. The vault write at login is also skipped for accounts without an
 * organisation, so for those users the session is the only place the token ever
 * lands.
 *
 * When the session is what saved us, the token is copied INTO the vault so the
 * scheduled sync keeps working after the session ends. Without that write the
 * mailbox would only ever refresh while its owner happened to be online.
 */
async function resolveCredential(userId, { oauthProvider, integrationId, orgId, deps }) {
    const vaultCred = await deps.getProviderAuth(userId, oauthProvider).catch(() => null);
    if (vaultCred?.accessToken) return vaultCred;

    const session = await deps.buildUserSession(userId, orgId, {
        include: [integrationId],
        providerHint: oauthProvider,
    }).catch(() => null);

    // Never mix providers: a Microsoft session's token must not be handed to a
    // Gmail client just because it happened to be there.
    const fromSession = session?.oauthProvider === oauthProvider && session?.accessToken
        ? { accessToken: session.accessToken, refreshToken: session.refreshToken || null, expiresAt: session.expiresAt || null, scope: session.scope || null }
        : (session?.routineProviders?.[oauthProvider] || null);

    if (!fromSession?.accessToken) return null;

    const user = await deps.getUser(userId).catch(() => null);
    try {
        await deps.upsertCredential({
            userId,
            orgId: vaultOrgId({ ...(user || {}), id: userId }, orgId),
            provider: oauthProvider,
            accessToken: fromSession.accessToken,
            refreshToken: fromSession.refreshToken || null,
            expiresAt: fromSession.expiresAt || null,
            scope: fromSession.scope || null,
        });
    } catch (e) {
        // Non-fatal: the sync still works for this run, it just will not survive
        // the session without a durable copy.
        log.warn(`[MailboxIdentity] could not persist ${oauthProvider} token for ${userId}: ${e.message}`);
    }
    return fromSession;
}

/**
 * Resolve the identity a mailbox connector runs as, plus its credentials.
 *
 * @returns {Promise<{
 *   userId: string, orgId: string|null,
 *   provider: 'gmail'|'outlook', integrationId: string, oauthProvider: 'google'|'microsoft',
 *   tokens: {accessToken, refreshToken, expiryDate, scope},
 *   onRefresh: Function,
 *   mailbox: { address, displayName, mode, sharedMode },
 *   viaGrantFrom: string|null,
 * }>}
 */
async function resolveMailboxIdentity(connector, { app, viewerId = null, deps: injected } = {}) {
    const deps = { ...defaultDeps(), ...(injected || {}) };

    const provider = connector?.provider;
    const integrationId = INTEGRATION_BY_MAILBOX_PROVIDER[provider];
    const oauthProvider = PROVIDER_BY_INTEGRATION[integrationId];
    if (!integrationId || !oauthProvider) {
        throw identityError(400, `Unsupported mailbox provider: ${provider}`, 'unsupported_provider');
    }

    const runAsViewer = connector.runAs === 'viewer';
    const orgId = app.organizationId || null;
    let effectiveUserId = app.userId;
    let viaGrantFrom = null;

    if (runAsViewer) {
        if (!viewerId || typeof viewerId !== 'string') {
            throw identityError(401, 'Sign in to use this mailbox.', 'connection_required');
        }
        if (await viewerHasIntegration(integrationId, { userId: viewerId, orgId, deps })) {
            effectiveUserId = viewerId;
        } else {
            const grant = await deps.resolveConnectionForRun({
                runningUserId: viewerId,
                runningUserOrgId: orgId,
                runningUserGroups: [],
                provider: integrationId,
                resourceType: 'studio_app',
                resourceId: app.id,
            }).catch(() => null);
            // 'own' comes back FIRST for a user who has their own connection, so
            // rejecting everything but 'delegated' meant a perfectly connected
            // user still fell through to the error below. Only a delegated grant
            // switches identity; 'own' just confirms the viewer may proceed.
            if (grant?.available && grant.effectiveUserId
                && (grant.mode === 'delegated' || grant.mode === 'own')) {
                effectiveUserId = grant.effectiveUserId;
                viaGrantFrom = grant.mode === 'delegated' ? grant.effectiveUserId : null;
            } else {
                // Tell the truth about WHICH thing is missing. A user who signed
                // in with Google and is told to "connect Gmail" has nothing to
                // click — their account is connected; their organisation has
                // simply not enabled the integration.
                const connected = await hasAnyCredential(viewerId, oauthProvider, { integrationId, orgId, deps });
                const err = connected
                    ? identityError(403, `Your organisation has not enabled ${integrationId}. An admin can turn it on under Organisation → Integrations.`, 'integration_disabled')
                    : identityError(409, `Connect ${integrationId} in Settings → Integrations to use this mailbox.`, 'connection_required');
                err.provider = integrationId;
                throw err;
            }
        }
    }

    const cred = await resolveCredential(effectiveUserId, { oauthProvider, integrationId, orgId, deps });
    if (!cred?.accessToken) {
        const err = identityError(409, `Connect ${integrationId} in Settings → Integrations to use this mailbox.`, 'connection_required');
        err.provider = integrationId;
        throw err;
    }

    const user = await deps.getUser(effectiveUserId).catch(() => null);
    const credOrgId = vaultOrgId({ ...(user || {}), id: effectiveUserId }, orgId);

    const tokens = {
        accessToken: cred.accessToken,
        refreshToken: cred.refreshToken || null,
        expiryDate: cred.expiresAt || null,
        scope: cred.scope || null,
    };
    // graphFetchFromTokens mutates `tokens` in place and calls this with a copy;
    // persisting is what keeps the connection alive past the access-token TTL.
    const onRefresh = async (updated) => {
        try {
            await deps.upsertCredential({
                userId: effectiveUserId,
                orgId: credOrgId,
                provider: oauthProvider,
                accessToken: updated.accessToken || null,
                refreshToken: updated.refreshToken || null,
                expiresAt: updated.expiryDate || null,
                scope: updated.scope || tokens.scope || null,
            });
        } catch (e) {
            log.warn(`[MailboxIdentity] token write-back failed for ${effectiveUserId}/${oauthProvider}: ${e.message}`);
        }
    };

    const mode = connector.mode === 'shared' ? 'shared' : 'personal';
    let address = mode === 'shared' ? String(connector.address || '').toLowerCase() : '';
    if (!address) {
        // A personal mailbox is whatever the token belongs to — never authored,
        // so it cannot drift from the credential.
        address = await deps.resolveMailboxAddress({ provider, tokens, onRefresh }).catch(() => '');
    }

    return {
        userId: effectiveUserId,
        orgId: credOrgId,
        provider,
        integrationId,
        oauthProvider,
        tokens,
        onRefresh,
        mailbox: {
            address,
            displayName: connector.displayName || user?.displayName || '',
            mode,
            sharedMode: sharedModeFor(provider),
        },
        viaGrantFrom,
    };
}

module.exports = {
    resolveMailboxIdentity,
    sharedModeFor,
    PROVIDER_BY_INTEGRATION,
    INTEGRATION_BY_MAILBOX_PROVIDER,
    viewerHasIntegration,
    _viewerHasIntegration: viewerHasIntegration,
    _vaultOrgId: vaultOrgId,
};
