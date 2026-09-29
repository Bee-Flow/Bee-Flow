// @typecheck
/**
 * OAuth shared helpers — routine-vault upsert, return-URL resolution, the
 * constant-time CSRF-state comparison and the popup redirect page.
 *
 * Each lives here exactly once so the legacy Nextcloud flow and the
 * multi-provider flow cannot drift apart.
 */

const crypto = require('crypto');
const routineCredentialStore = require('../../stores/routineCredentialStore');
const log = require('../../telemetry/log');

/**
 * Persist long-lived OAuth tokens into the routine credential vault. Called
 * after every successful OAuth callback so unattended routines have an
 * encrypted, refresh-capable copy of the user's credentials even after their
 * web session expires. Failures are logged and swallowed — the user's login
 * must not break because the vault write hiccupped.
 */
async function _vaultUpsertSafe({ userId, orgId, provider, tokenData }) {
    if (!userId || !orgId || !provider || !tokenData) return;
    try {
        const expiresAt = tokenData.expires_in
            ? Date.now() + Number(tokenData.expires_in) * 1000
            : null;
        await routineCredentialStore.upsertCredential({
            userId,
            orgId,
            provider,
            accessToken: tokenData.access_token || null,
            refreshToken: tokenData.refresh_token || null,
            expiresAt,
            scope: tokenData.scope || null,
        });
        // Re-activate anything this user previously had paused for
        // needs_reauth, in both tables. The runners pick them up on the next
        // 60s tick.
        try {
            const aiTaskStore = require('../../stores/aiTaskStore');
            const coworkStore = require('../../stores/coworkStore');
            const resumed = await aiTaskStore.resumeNeedsReauthForUser(userId)
                + await coworkStore.resumeNeedsReauthForUser(userId);
            if (resumed > 0) {
                log.info(`[OAuth/${provider}] resumed ${resumed} routine(s) for user ${userId} after reconnect`);
            }
        } catch (resumeErr) {
            log.warn(`[OAuth/${provider}] resume-routines failed for ${userId}: ${resumeErr.message}`);
        }
    } catch (err) {
        log.warn(`[OAuth/${provider}] routine vault upsert failed for user ${userId}: ${err.message}`);
    }
}

// Helper to get return URL from referer or environment
function getReturnUrl(req) {
    const referer = req.get('Referer');

    if (process.env.CLIENT_PUBLIC_HOST) {
        const clientProtocol = process.env.CLIENT_PROTOCOL || process.env.SERVER_PROTOCOL || 'https';
        return `${clientProtocol}://${process.env.CLIENT_PUBLIC_HOST}`;
    }

    if (referer) {
        try {
            const url = new URL(referer);
            return `${url.protocol}//${url.host}`;
        } catch (e) {
            log.warn('Invalid Referer header:', referer);
        }
    }

    return 'http://localhost:5173';
}

/**
 * Constant-time OAuth CSRF-state comparison.
 *
 * Both halves must be present, non-empty strings. That guard is the whole
 * point: a plain `received !== expected` treats "no state in the query AND no
 * state in the session" as a match (undefined === undefined), which lets an
 * attacker replay an authorization code they minted themselves into a victim's
 * browser via a top-level GET to the callback — login CSRF. Length is compared
 * before timingSafeEqual because that throws on a length mismatch.
 */
function oauthStatesMatch(received, expected) {
    if (typeof received !== 'string' || typeof expected !== 'string') return false;
    if (!received || !expected) return false;
    const a = Buffer.from(received, 'utf8');
    const b = Buffer.from(expected, 'utf8');
    if (a.length !== b.length) return false;
    return crypto.timingSafeEqual(a, b);
}

/**
 * Native-app handoff targets, by KEY.
 *
 * A native client cannot be sent to a web page: Android's Custom Tab has its
 * own cookie jar, so the session the callback establishes never reaches the
 * app, and — more visibly — nothing in JavaScript can close a Custom Tab. The
 * ONLY thing that closes it is the OS delivering an ACTION_VIEW intent to the
 * app's main activity, at which point expo-web-browser's lifecycle listener
 * finishes the tab's task. So the callback has to 302 to the app's own scheme.
 *
 * The client sends a KEY, never a URL, and this map is the only place a value
 * exists. That is the whole security argument: an allowlist that string-matches
 * a client-supplied URI is a URI parser you have to get right against
 * `beeflow://oauth@evil.example`, `beeflow:/\/oauth`, case folding, a trailing
 * `#`, percent-encoding and IDNA. An exact Map.get has no parser to fool, and
 * an unrecognised key degrades to the existing close page.
 *
 * `Object.create(null)` semantics matter here too — a Map, not an object
 * literal, so `?app=constructor` cannot resolve to anything.
 */
const NATIVE_APP_REDIRECTS = new Map([
    ['beeflow', 'beeflow://oauth'],
]);

/**
 * Resolve a native handoff key to its fixed redirect target, or null.
 * Never returns anything the caller supplied.
 */
function resolveNativeAppRedirect(key) {
    if (typeof key !== 'string' || !key) return null;
    return NATIVE_APP_REDIRECTS.get(key) || null;
}

// When popup=1 (embedded iframe mode), we serve an intermediate HTML page
// instead of a 302 redirect. This cleans the Referer header and severs the
// iframe->popup->provider relationship so Google/Microsoft don't block it.
function popupRedirect(res, url) {
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.send(`<!DOCTYPE html><html><head>
<meta http-equiv="refresh" content="0;url=${url}">
<meta name="referrer" content="no-referrer">
</head><body>
<script>window.location.replace(${JSON.stringify(url)});</script>
<p style="font-family:sans-serif;text-align:center;margin-top:40px">Redirecting...</p>
</body></html>`);
}

module.exports = { _vaultUpsertSafe, getReturnUrl, oauthStatesMatch, popupRedirect, resolveNativeAppRedirect };
