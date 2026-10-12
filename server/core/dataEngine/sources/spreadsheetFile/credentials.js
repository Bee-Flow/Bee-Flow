/**
 * "As whom does this mirror talk to Google or Microsoft?"
 *
 * A spreadsheet mirror refreshes every minute and on every pulse, long after
 * the linker's browser session is gone, so its tokens must come from the
 * long-lived automation_credentials vault (auth/automationAuth) — the same source
 * a scheduled automation uses. Two things the vault alone does not cover:
 *
 *   1. A user who signed in with Google/Microsoft SSO and has no
 *      organisation has NO vault row (auth/oauth/shared.js only writes one
 *      when an orgId is known). Their tokens live on the live session. The
 *      first spreadsheet call copies them INTO the vault (per-user scope,
 *      automationAuth.vaultOrgIdFor) so the ticker keeps working after logout.
 *   2. The shim automationAuth.buildUserAuth hands out has no save(): a
 *      Microsoft refresh (which rotates the refresh token) or a Google
 *      refresh inside the SDK would be lost, and the next tick would fail
 *      with a dead token. The shim built here persists rotated tokens — it
 *      is passed as `onSaved` to createGoogleApiClient and read as
 *      `session.save` by msGraphClient.refreshAccessToken.
 *
 * Provider-exact, never mixed: a session's primary tokens are used ONLY when
 * its oauthProvider is the provider asked for; anything else comes from
 * automationProviders[provider]. A Microsoft token is never handed to Google.
 *
 * Memoised for a minute per (user, provider), refusals included — a burst of
 * pulses on one table must not re-read and re-decrypt the vault each time.
 */

'use strict';

const { SpreadsheetSourceError } = require('./errors');
const log = require('../../../../telemetry/log');

const MEMO_TTL_MS = 60_000;
const _memo = new Map();   // `${userId}|${provider}` → { at, value, error }

/** Google and Microsoft both issue one-hour access tokens; a rotated token
 *  whose expiry the SDK did not tell us is recorded as slightly shorter so
 *  the vault refreshes it a little early rather than a little late. */
const ASSUMED_TOKEN_LIFETIME_MS = 55 * 60_000;

const PROVIDERS = new Set(['google', 'microsoft']);
const STORAGE_NAME = { google: 'Google Drive', microsoft: 'OneDrive' };

function deps() {
    // Lazily required: the pure modules beside this one must stay loadable in
    // suites that stub the database, and these pull in stores at load time.
    return {
        automationAuth: require('../../../../auth/automationAuth'),
        resolveUserSession: require('../../../automationRunner/sessionResolution').resolveUserSession,
        credentialStore: require('../../../../stores/automationCredentialStore'),
        userStore: require('../../../../stores/userStore'),
    };
}

function notConnected(provider, detail = null) {
    const name = STORAGE_NAME[provider] || provider;
    const why = detail === 'needs_reauth'
        ? `${name} needs to be reconnected by the account that linked this table`
        : `The account that linked this table is not connected to ${name}`;
    return new SpreadsheetSourceError(403, 'provider_not_connected',
        `${why} — reconnect it under Settings → Connections, or ask an owner to re-link the table.`,
        { detail });
}

/**
 * Tokens from a session-shaped object, for exactly this provider or nothing.
 * @returns {{ accessToken, refreshToken, expiresAt, scope }|null}
 */
function tokensFromSession(s, provider) {
    if (!s) return null;
    if (s.oauthProvider === provider && s.accessToken) {
        return { accessToken: s.accessToken, refreshToken: s.refreshToken || null, expiresAt: s.expiresAt || null, scope: s.oauthScope || null };
    }
    const rp = s.automationProviders && s.automationProviders[provider];
    if (rp && rp.accessToken) {
        return { accessToken: rp.accessToken, refreshToken: rp.refreshToken || null, expiresAt: rp.expiresAt || null, scope: rp.scope || rp.oauthScope || null };
    }
    return null;
}

/**
 * The session-shaped shim the SDK clients read, plus save().
 * `save()` is what the Google OAuth2 'tokens' event (via onSaved) and the
 * Graph refresh (via session.save) call after rotating tokens; it upserts
 * whatever the shim holds NOW. It never throws into the SDK's event handler.
 */
function makeShim(d, { userId, provider, vaultOrgId, accessToken, refreshToken, expiresAt, scope }) {
    let persisted = { accessToken, refreshToken, expiresAt };
    const shim = {
        userId,
        oauthProvider: provider,
        accessToken,
        refreshToken,
        expiresAt,
        oauthScope: scope,
        automationProviders: {},
        async save() {
            try {
                const rotated = shim.accessToken !== persisted.accessToken || shim.refreshToken !== persisted.refreshToken;
                if (!rotated) return;
                // Neither SDK writes the new expiry onto the session; assume
                // the provider's standard lifetime rather than leaving it
                // null (null = "refresh on every read").
                const knownExpiry = Number(shim.expiresAt) > Date.now() + 60_000 && shim.expiresAt !== persisted.expiresAt
                    ? Number(shim.expiresAt) : null;
                shim.expiresAt = knownExpiry || Date.now() + ASSUMED_TOKEN_LIFETIME_MS;
                await d.credentialStore.upsertCredential({
                    userId,
                    orgId: vaultOrgId,
                    provider,
                    accessToken: shim.accessToken,
                    refreshToken: shim.refreshToken || null,
                    expiresAt: shim.expiresAt,
                    scope: shim.oauthScope || null,
                });
                persisted = { accessToken: shim.accessToken, refreshToken: shim.refreshToken, expiresAt: shim.expiresAt };
            } catch (e) {
                log.warn(`[spreadsheetFile] could not persist rotated ${provider} tokens for user ${userId}: ${e.message}`);
            }
        },
    };
    return shim;
}

async function vaultOrgIdOf(d, userId, session) {
    const userRow = await d.userStore.getUser(userId).catch(() => null);
    const organizationId = (userRow && userRow.organizationId) || (session && session.user && session.user.organizationId) || null;
    return d.automationAuth.vaultOrgIdFor({ id: userId, organizationId });
}

async function resolveUncached(d, userId, provider, { session }) {
    // 1. The vault, refreshed when close to expiry (automationAuth persists the
    //    refresh itself and flips a revoked grant to needs_reauth → null).
    const cred = await d.automationAuth.getProviderAuth(userId, provider);
    if (cred && cred.accessToken) {
        return makeShim(d, {
            userId, provider,
            vaultOrgId: cred.orgId || await vaultOrgIdOf(d, userId, session),
            accessToken: cred.accessToken, refreshToken: cred.refreshToken || null,
            expiresAt: cred.expiresAt || null, scope: cred.scope || null,
        });
    }

    // 2. A session-shaped source: the caller's live session (wizard) or the
    //    runner's rebuilt one. Provider-exact.
    const s = session || await d.resolveUserSession(userId).catch(() => null);
    const tokens = tokensFromSession(s, provider);
    if (tokens) {
        const vaultOrgId = await vaultOrgIdOf(d, userId, s);
        // Into the vault, so the ticker survives logout. A failure here is
        // logged, not fatal: the request path still works on the session.
        try {
            await d.credentialStore.upsertCredential({ userId, orgId: vaultOrgId, provider, ...tokens });
        } catch (e) {
            log.warn(`[spreadsheetFile] could not copy ${provider} tokens into the vault for user ${userId}: ${e.message}`);
        }
        return makeShim(d, { userId, provider, vaultOrgId, ...tokens });
    }

    // 3. Nothing. Say WHY when the vault knows (needs_reauth reads differently
    //    to a person than "never connected").
    const row = await d.credentialStore.getCredential(userId, provider).catch(() => null);
    throw notConnected(provider, row && row.status === 'needs_reauth' ? 'needs_reauth' : null);
}

/**
 * @param {string} userId
 * @param {'google'|'microsoft'} provider
 * @param {object} [opts]
 * @param {object|null} [opts.session]  the caller's live session, when on a request path
 * @param {string|null} [opts.orgId]    accepted for symmetry with resolveLinker; the vault scope comes from the user row
 * @param {boolean} [opts.fresh]        skip the memo (a re-link, a "try again")
 * @returns {Promise<object>} the session-shaped shim with save()
 * @throws {SpreadsheetSourceError} 403 provider_not_connected
 */
async function resolveProviderCredential(userId, provider, { session = null, orgId = null, fresh = false } = {}) {
    void orgId;
    if (!PROVIDERS.has(provider)) {
        throw new SpreadsheetSourceError(422, 'spreadsheet_rejected', `Unknown credential provider: ${String(provider).slice(0, 40)}`);
    }
    if (!userId) throw notConnected(provider);
    const memoKey = `${userId}|${provider}`;
    const hit = _memo.get(memoKey);
    if (!fresh && hit && Date.now() - hit.at < MEMO_TTL_MS) {
        if (hit.error) throw hit.error;
        return hit.value;
    }
    const d = deps();
    let value = null;
    let error = null;
    try {
        value = await resolveUncached(d, userId, provider, { session });
    } catch (e) {
        error = e;
    }
    _memo.set(memoKey, { at: Date.now(), value, error });
    if (error) throw error;
    return value;
}

/**
 * The cheap answer for the providers list: is there a credential at all?
 * Reads one vault row and looks at the session — no provider call, no
 * refresh. `reason` is one of the wire contract's words.
 * @returns {Promise<{ connected: boolean, reason: null|'not_connected'|'needs_reauth' }>}
 */
async function cheapStatus(userId, provider, { session = null } = {}) {
    if (!PROVIDERS.has(provider) || !userId) return { connected: false, reason: 'not_connected' };
    if (tokensFromSession(session, provider)) return { connected: true, reason: null };
    const d = deps();
    const row = await d.credentialStore.getCredential(userId, provider).catch(() => null);
    if (row && row.status === 'active' && (row.accessToken || row.refreshToken)) return { connected: true, reason: null };
    if (row && row.status === 'needs_reauth') return { connected: false, reason: 'needs_reauth' };
    return { connected: false, reason: 'not_connected' };
}

/** Test/relink hook: forget a user's memo (both providers). */
function forget(userId) {
    for (const k of _memo.keys()) if (k.startsWith(`${userId}|`)) _memo.delete(k);
}

module.exports = { resolveProviderCredential, cheapStatus, forget, tokensFromSession, _memo, MEMO_TTL_MS, ASSUMED_TOKEN_LIFETIME_MS };
