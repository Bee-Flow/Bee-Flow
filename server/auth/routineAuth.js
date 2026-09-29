// @typecheck
/**
 * Routine Auth — single entry-point for unattended OAuth credential resolution.
 *
 * Routines run server-side via `aiTaskRunner` and need to call user-scoped
 * Google/Microsoft/Nextcloud APIs even when the user is offline. Today the
 * runner borrows the most recent web session row, which expires fast and
 * stops working as soon as the user closes the browser for long enough.
 *
 * This module replaces that with the long-lived `routine_credentials` vault:
 *
 *   1. Read the encrypted vault entry for (userId, provider).
 *   2. If the access token is missing or about to expire, refresh it using
 *      the provider's refresh-token endpoint and write the fresh tokens back
 *      to the vault.
 *   3. On a definitive refresh rejection (`invalid_grant` / `invalid_client`
 *      — revoked grant, expired refresh token, rotated client secret) mark
 *      the credential `needs_reauth`, pause every routine on this user that
 *      depends on the provider, and emit a `routine_reauth` notification
 *      with a deep-link the frontend uses to start a fresh OAuth flow.
 *      Transient failures (network errors, provider 5xx, malformed bodies)
 *      leave the credential untouched and return null for the attempt so
 *      the next tick simply retries.
 *
 * The function returns a session-like shim so downstream code (notably
 * `getIntegrationTools`) can continue reading `session.accessToken` /
 * `session.refreshToken` exactly as it does today.
 */

const routineCredentialStore = require('../stores/routineCredentialStore');
const { loadConfig, OAUTH_PROVIDERS, microsoftRefreshScope } = require('./permissions');
const log = require('../telemetry/log');

const REFRESH_THRESHOLD_MS = 5 * 60_000; // refresh if <5 min left

/**
 * Encryption scope for a user's vault row. Org members use their org key;
 * org-less consumer accounts get a per-user scope so a connector still works
 * for them (upsertCredential requires a non-empty orgId for key derivation,
 * and silently skipping the vault write would make the connection last
 * exactly one session). Every writer of routine_credentials must derive the
 * scope the same way, or a row written under one scope cannot be decrypted
 * under the other — hence one helper here, shared by the connector routes
 * and the spreadsheet mirror's credential resolver.
 */
function vaultOrgIdFor(user) {
    return user?.organizationId || `user:${user?.id}`;
}

// ── Provider derivation from agent's enabled integrations ───────────────
// Maps an integration id (as stored on agent.config.enabledIntegrations) to
// the OAuth provider whose tokens are required to call it. Anything not
// mapped here is assumed to use a per-user config-store API key (Fireflies,
// YouTrack, Gamma, etc) which doesn't need session auth at all.
const INTEGRATION_PROVIDER = {
    gmail:              'google',
    'google-calendar':  'google',
    'google-drive':     'google',
    'google-docs':      'google',
    'google-sheets':    'google',
    'google-slides':    'google',
    'google-contacts':  'google',
    'google-keep':      'google',
    'google-groups':    'google',
    outlook:            'microsoft',
    'outlook-readonly': 'microsoft',
    'ms-calendar':      'microsoft',
    'ms-contacts':      'microsoft',
    onedrive:           'microsoft',
    nextcloud:          'nextcloud',
    'nextcloud-calendar':      'nextcloud',
    'nextcloud-contacts':      'nextcloud',
    'nextcloud-deck':          'nextcloud',
    'nextcloud-notifications': 'nextcloud',
    'nextcloud-talk':          'nextcloud',
    'nextcloud-tasks':         'nextcloud',
    'nextcloud-notes':         'nextcloud',
    'nextcloud-mail':          'nextcloud',
    'nextcloud-activity':      'nextcloud',
    'nextcloud-status':        'nextcloud',
    withings:                  'withings',
};

function providersForIntegrations(enabledIntegrations) {
    if (!Array.isArray(enabledIntegrations)) return [];
    const set = new Set();
    for (const id of enabledIntegrations) {
        const p = INTEGRATION_PROVIDER[id];
        if (p) set.add(p);
    }
    return Array.from(set);
}

// ── Refresh paths ───────────────────────────────────────────────────────

// OAuth error codes that mean the grant itself is dead (revoked by the user,
// expired refresh token, rotated client credentials). Only these flip a
// credential to `needs_reauth`; anything else — network blips, provider 5xx,
// malformed bodies — is transient and retried on a later attempt without
// touching credential status.
const FATAL_OAUTH_ERRORS = new Set(['invalid_grant', 'invalid_client']);

/** @typedef {{ access_token?: string, refresh_token?: string, expires_in?: number|string, scope?: string, error?: string, [key: string]: any }} TokenResponse */

function reauthError(message) {
    const err = /** @type {Error & {reauthRequired?: boolean}} */ (new Error(message));
    err.reauthRequired = true;
    return err;
}

async function throwRefreshFailed(label, res) {
    const txt = await res.text().catch(() => '');
    let oauthError = null;
    try { oauthError = JSON.parse(txt)?.error || null; } catch (_) { /* non-JSON body */ }
    const message = `${label} refresh failed (${res.status}): ${txt.slice(0, 200)}`;
    if (FATAL_OAUTH_ERRORS.has(oauthError)) throw reauthError(message);
    throw new Error(message);
}

async function refreshGoogle(cred) {
    if (!cred?.refreshToken) throw reauthError('No Google refresh token');
    const config = await loadConfig();
    const providerConfig = config.providers?.google || {};
    if (!providerConfig.clientId || !providerConfig.clientSecret) {
        throw new Error('Google OAuth not configured');
    }
    const res = await fetch(OAUTH_PROVIDERS.google.tokenUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
            grant_type: 'refresh_token',
            refresh_token: cred.refreshToken,
            client_id: providerConfig.clientId,
            client_secret: providerConfig.clientSecret,
        }).toString(),
    });
    if (!res.ok) await throwRefreshFailed('Google', res);
    const data = /** @type {TokenResponse} */ (await res.json());
    return {
        accessToken: data.access_token,
        // Google rarely rotates refresh tokens; reuse the existing one if missing.
        refreshToken: data.refresh_token || cred.refreshToken,
        expiresAt: data.expires_in ? Date.now() + Number(data.expires_in) * 1000 : null,
        scope: data.scope || cred.scope,
    };
}

async function refreshMicrosoft(cred) {
    if (!cred?.refreshToken) throw reauthError('No Microsoft refresh token');
    const config = await loadConfig();
    const providerConfig = config.providers?.microsoft || {};
    if (!providerConfig.clientId || !providerConfig.clientSecret) {
        throw new Error('Microsoft OAuth not configured');
    }
    const tenantId = providerConfig.tenantId || 'common';
    const tokenUrl = OAUTH_PROVIDERS.microsoft.tokenUrl(tenantId);
    const res = await fetch(tokenUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
            grant_type: 'refresh_token',
            refresh_token: cred.refreshToken,
            client_id: providerConfig.clientId,
            client_secret: providerConfig.clientSecret,
            // Re-request what was actually granted (falling back to the default
            // login set) — never a narrower list, or the refresh downgrades the
            // token and capabilities vanish silently.
            scope: microsoftRefreshScope(cred.scope),
        }).toString(),
    });
    if (!res.ok) await throwRefreshFailed('Microsoft', res);
    const data = /** @type {TokenResponse} */ (await res.json());
    return {
        accessToken: data.access_token,
        // Microsoft rotates refresh tokens on every refresh.
        refreshToken: data.refresh_token || cred.refreshToken,
        expiresAt: data.expires_in ? Date.now() + Number(data.expires_in) * 1000 : null,
        scope: data.scope || cred.scope,
    };
}

async function refreshNextcloud(cred) {
    if (!cred?.refreshToken) throw reauthError('No Nextcloud refresh token');
    const config = await loadConfig();
    const { nextcloudUrl, clientId, clientSecret } = config.oauth || {};
    if (!nextcloudUrl || !clientId || !clientSecret) {
        throw new Error('Nextcloud OAuth not configured');
    }
    const res = await fetch(`${nextcloudUrl}/apps/oauth2/api/v1/token`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
            grant_type: 'refresh_token',
            refresh_token: cred.refreshToken,
            client_id: clientId,
            client_secret: clientSecret,
        }).toString(),
    });
    if (!res.ok) await throwRefreshFailed('Nextcloud', res);
    const data = /** @type {TokenResponse} */ (await res.json());
    return {
        accessToken: data.access_token,
        refreshToken: data.refresh_token || cred.refreshToken,
        expiresAt: data.expires_in ? Date.now() + Number(data.expires_in) * 1000 : null,
        scope: cred.scope,
    };
}

/**
 * Withings deviates from plain OAuth2 in two ways that both matter here:
 *
 *   1. The token endpoint is action-dispatched — the form body carries
 *      `action=requesttoken` next to the grant.
 *   2. A refusal arrives as HTTP 200 with a non-zero `status` field; the tokens
 *      themselves live one level down under `body`. Reading `data.access_token`
 *      would silently store `undefined` and every later call would 401.
 *
 * Withings also ROTATES the refresh token on every refresh and invalidates the
 * old one, so the returned refresh token must be persisted — falling back to
 * the previous one (as Google's refresher does) would break the next refresh.
 */
async function refreshWithings(cred) {
    if (!cred?.refreshToken) throw reauthError('No Withings refresh token');
    const { clientId, clientSecret } = await withingsClientConfig();
    if (!clientId || !clientSecret) throw new Error('Withings OAuth not configured');

    const res = await fetch(OAUTH_PROVIDERS.withings.tokenUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
            action: 'requesttoken',
            grant_type: 'refresh_token',
            refresh_token: cred.refreshToken,
            client_id: clientId,
            client_secret: clientSecret,
        }).toString(),
    });
    if (!res.ok) await throwRefreshFailed('Withings', res);

    let data;
    try { data = await res.json(); } catch { throw new Error('Withings refresh returned a non-JSON body'); }
    const body = readWithingsBody(data, 'refresh');
    if (!body.access_token) throw reauthError('Withings refresh returned no access token');

    return {
        accessToken: body.access_token,
        // Single-use: never fall back to the old token.
        refreshToken: body.refresh_token || null,
        expiresAt: body.expires_in ? Date.now() + Number(body.expires_in) * 1000 : null,
        scope: body.scope || cred.scope,
    };
}

// Withings app credentials are admin-global secrets (the LinkedIn pattern), not
// entries in config.providers — that object drives the SSO login screen and
// Withings is not an identity provider.
async function withingsClientConfig() {
    const configStore = require('../stores/configStore');
    const clientId = (await configStore.getSecret('withings_client_id')) || process.env.WITHINGS_CLIENT_ID || '';
    const clientSecret = (await configStore.getSecret('withings_client_secret')) || process.env.WITHINGS_CLIENT_SECRET || '';
    return { clientId, clientSecret };
}

// Withings statuses that mean the grant is dead rather than the call being
// malformed: 401 (invalid/expired token) and 601 (too many requests is NOT
// fatal, so it is deliberately absent). 503 is "invalid params" — a bug on our
// side, transient from the credential's point of view.
const WITHINGS_FATAL_STATUS = new Set([401, 283, 293]);

/**
 * Unwrap a Withings envelope. Throws a reauth-tagged error for a dead grant and
 * a plain error for anything else, so the caller's transient/fatal split works
 * exactly as it does for the standards-compliant providers.
 * Exported so the connector route unwraps identically.
 */
function readWithingsBody(data, label) {
    const status = Number(data?.status);
    if (status === 0) {
        const body = data.body;
        if (body && typeof body === 'object') return body;
        throw new Error(`Withings ${label} succeeded with no body`);
    }
    const detail = String(data?.error || '').slice(0, 200);
    const message = `Withings ${label} refused (status ${Number.isFinite(status) ? status : '?'}): ${detail || 'no error text'}`;
    if (WITHINGS_FATAL_STATUS.has(status) || /invalid_grant|invalid_client|invalid_token/i.test(detail)) {
        throw reauthError(message);
    }
    throw new Error(message);
}

const REFRESHERS = {
    google:    refreshGoogle,
    microsoft: refreshMicrosoft,
    nextcloud: refreshNextcloud,
    withings:  refreshWithings,
};

// ── Pause + notify on refresh failure ───────────────────────────────────

async function _pauseRoutinesAndNotify(userId, provider, errorMessage) {
    try {
        await routineCredentialStore.markNeedsReauth(userId, provider, errorMessage);
    } catch (err) {
        log.warn(`[routineAuth] markNeedsReauth failed: ${err.message}`);
    }

    // Pause everything of this user's that depends on the broken provider,
    // across BOTH tables. Cowork was missing here: the schedules migrated out
    // of ai_tasks kept running into the same expired token every hour, each
    // failure costing a call and an "urgent" notification.
    let pausedCount = 0;
    const agentStore = require('../stores/agentStore');

    // Agent-less work carries its own app list (enabledApps); only pause the
    // items that can actually touch the broken provider. A missing list means
    // unrestricted, so the provider can't be ruled out — those are paused.
    const dependsOnProvider = async (item) => {
        if (!item.agentId) {
            if (Array.isArray(item.enabledApps)) {
                return providersForIntegrations(item.enabledApps).includes(provider);
            }
            return true;
        }
        try {
            const agent = await agentStore.getAgent(item.agentId);
            const enabled = Array.isArray(agent?.config?.enabledIntegrations)
                ? agent.config.enabledIntegrations
                : [];
            return providersForIntegrations(enabled).includes(provider);
        } catch (_) {
            return false; // if we can't tell, leave it alone
        }
    };

    const pauseAll = async (label, items, deactivate) => {
        for (const item of items) {
            if (!item.isActive) continue;
            if (!await dependsOnProvider(item)) continue;
            try {
                await deactivate(item.id);
                pausedCount += 1;
            } catch (err) {
                log.warn(`[routineAuth] pause ${label} ${item.id} failed: ${err.message}`);
            }
        }
    };

    try {
        const aiTaskStore = require('../stores/aiTaskStore');
        const coworkStore = require('../stores/coworkStore');
        // Stamp last_status alongside the deactivation: the OAuth-callback
        // resume (resumeNeedsReauthForUser) only matches rows whose
        // last_status is 'needs_reauth'. Without it, only the one item whose
        // own run failed would ever come back after a reconnect — everything
        // paused proactively here stayed off forever.
        await pauseAll(
            'task',
            await aiTaskStore.getTasks(userId).catch(() => []),
            id => aiTaskStore.updateTask(id, { isActive: false, lastStatus: 'needs_reauth' }),
        );
        await pauseAll(
            'cowork',
            await coworkStore.getSchedules(userId).catch(() => []),
            id => coworkStore.updateSchedule(id, { isActive: false, lastStatus: 'needs_reauth' }),
        );
    } catch (err) {
        log.warn(`[routineAuth] failed to enumerate routines for pause: ${err.message}`);
    }

    // Single user-facing notification with a deep-link the frontend reads to
    // start the OAuth flow for this provider.
    try {
        const notificationStore = require('../stores/notificationStore');
        const providerLabel = provider === 'google' ? 'Google'
            : provider === 'microsoft' ? 'Microsoft'
            : provider === 'nextcloud' ? 'Nextcloud'
            : provider;
        const tail = pausedCount > 0
            ? ` ${pausedCount} routine${pausedCount === 1 ? '' : 's'} paused — reconnect to resume.`
            : ' Reconnect to resume your routines.';
        await notificationStore.createNotification({
            userId,
            category: 'urgent',
            title: `Reconnect ${providerLabel}`,
            // Keep the deep-link in the message body — NotificationCenter reads
            // the `routine_reauth:<provider>` token to render a one-click button.
            message: `routine_reauth:${provider}\n\nYour ${providerLabel} access has expired or been revoked.${tail}`,
        });
    } catch (err) {
        log.warn(`[routineAuth] reauth notification failed: ${err.message}`);
    }
}

// ── Public API ──────────────────────────────────────────────────────────

/**
 * Fetch a fresh-enough credential for (userId, provider). Returns null if the
 * user has never granted that provider, or the credential is in
 * `needs_reauth`/`revoked`, or refresh failed. Definitive rejections
 * (`invalid_grant`/`invalid_client`) pause-and-notify the user before
 * returning null; transient refresh failures return null without touching
 * credential status so a later attempt can retry.
 */
async function getProviderAuth(userId, provider) {
    const cred = await routineCredentialStore.getCredential(userId, provider);
    if (!cred) return null;
    if (cred.status !== 'active') return null;

    const needsRefresh = !cred.accessToken
        || !cred.expiresAt
        || cred.expiresAt < Date.now() + REFRESH_THRESHOLD_MS;

    if (!needsRefresh) return cred;

    const refresher = REFRESHERS[provider];
    if (!refresher) return cred; // unknown provider, hand back what we have

    try {
        const refreshed = await refresher(cred);
        await routineCredentialStore.upsertCredential({
            userId: cred.userId,
            orgId: cred.orgId,
            provider,
            accessToken: refreshed.accessToken,
            refreshToken: refreshed.refreshToken,
            expiresAt: refreshed.expiresAt,
            scope: refreshed.scope,
        });
        return {
            ...cred,
            accessToken: refreshed.accessToken,
            refreshToken: refreshed.refreshToken,
            expiresAt: refreshed.expiresAt,
            scope: refreshed.scope,
        };
    } catch (err) {
        if (err.reauthRequired) {
            log.warn(`[routineAuth] ${provider} refresh rejected for user ${userId}: ${err.message}`);
            await _pauseRoutinesAndNotify(userId, provider, err.message);
            return null;
        }
        // Transient failure (network error, provider 5xx, malformed body):
        // leave the credential untouched so the next attempt retries.
        log.warn(`[routineAuth] ${provider} refresh failed (transient) for user ${userId}: ${err.message}`);
        return null;
    }
}

/**
 * Build a session-shaped object for the runner. Picks the dominant provider
 * (the agent's primary OAuth need) and exposes its tokens as
 * `session.accessToken` / `session.refreshToken` so existing tool clients
 * keep working unchanged. If the agent needs multiple providers the
 * additional credentials live under `session.routineProviders[provider]`.
 *
 * Returns null if NONE of the required providers can produce a working
 * credential. Returns an object even if the agent only needs API-key
 * integrations (Fireflies/YouTrack/etc) — those load via configStore and
 * don't depend on session tokens.
 */
async function buildUserAuth(userId, { enabledIntegrations = [], providerHint = null } = {}) {
    const required = providersForIntegrations(enabledIntegrations);
    // No OAuth-backed integrations — return a bare shim. `getIntegrationTools`
    // can still load configStore-backed tools (Fireflies/YouTrack/Gamma/etc).
    if (required.length === 0) {
        return { userId, accessToken: null, refreshToken: null, oauthProvider: null, routineProviders: {} };
    }

    const providers = {};
    for (const provider of required) {
        providers[provider] = await getProviderAuth(userId, provider);
    }
    const okEntries = Object.entries(providers).filter(([, v]) => v && v.accessToken);
    if (okEntries.length === 0) return null;

    // Pick a primary so the legacy `session.accessToken` field is meaningful.
    // Prefer the explicitly-hinted provider, otherwise the first that worked.
    const primary = providerHint && providers[providerHint]?.accessToken
        ? providerHint
        : okEntries[0][0];

    const p = providers[primary];
    return {
        userId,
        oauthProvider: primary,
        accessToken: p.accessToken,
        refreshToken: p.refreshToken,
        expiresAt: p.expiresAt,
        routineProviders: providers,
    };
}

module.exports = {
    buildUserAuth,
    getProviderAuth,
    providersForIntegrations,
    vaultOrgIdFor,
    refreshGoogle,
    refreshMicrosoft,
    refreshNextcloud,
    refreshWithings,
    readWithingsBody,
    withingsClientConfig,
};
