// @typecheck strict
/**
 * The WebDAV uid of an app-password login (see resolveBasicUid). Split out of
 * ./nextcloudClient.js, which builds the Basic-auth context around it.
 */

const { nextcloudFetch } = require('./nextcloudTarget');
const { fallback } = require('../utils/bestEffort');

/**
 * The WebDAV uid behind a saved app password, per (user, host, login name).
 * A found uid is kept for the life of the process; a failed lookup is retried
 * after a few minutes.
 * @type {Map<string, { uid: string | null, expiresAt: number }>}
 */
const _basicUidCache = new Map();
const BASIC_UID_RETRY_MS = 5 * 60 * 1000;
const BASIC_UID_LOOKUP_TIMEOUT_MS = 5000;

/**
 * The uid for WebDAV paths (`/remote.php/dav/files/<uid>/`) of an app-password
 * login. The saved username is the LOGIN name: with Login Flow v2, or when the
 * person types what they sign in with, that can be an e-mail address or an
 * LDAP login, which is not the uid. Basic auth must keep the login name (an
 * app password is bound to it); only the paths need the uid, so Nextcloud is
 * asked once. When it cannot be asked the login name is used, as before.
 * @param {string} userId
 * @param {{ username: string }} creds
 * @param {string} baseUrl
 * @param {string} authorization  the Basic header value
 * @returns {Promise<string>}
 */
async function resolveBasicUid(userId, creds, baseUrl, authorization) {
    const key = `${userId}\n${baseUrl}\n${creds.username}`;
    const hit = _basicUidCache.get(key);
    if (hit && (hit.uid || hit.expiresAt > Date.now())) return hit.uid || creds.username;
    /** @type {string | null} */
    let uid = null;
    try {
        const res = await nextcloudFetch(`${baseUrl}/ocs/v2.php/cloud/user?format=json`, {
            method: 'GET',
            headers: { 'Authorization': authorization, 'OCS-APIRequest': 'true', 'Accept': 'application/json' },
            signal: AbortSignal.timeout(BASIC_UID_LOOKUP_TIMEOUT_MS),
        });
        if (res.ok) {
            const body = /** @type {{ ocs?: { data?: { id?: unknown } } }} */ (await res.json());
            const id = body?.ocs?.data?.id;
            if (typeof id === 'string' && id) uid = id;
        }
    } catch (err) { fallback('integrations/nextcloudBasicUid:resolveBasicUid', err); /* the login name is the fallback */ }
    if (_basicUidCache.size > 5000) _basicUidCache.clear();
    _basicUidCache.set(key, { uid, expiresAt: Date.now() + BASIC_UID_RETRY_MS });
    return uid || creds.username;
}

module.exports = { resolveBasicUid };
