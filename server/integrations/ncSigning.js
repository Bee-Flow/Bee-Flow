/**
 * The one HMAC implementation for SaaS → connector `/nc/*` callbacks.
 *
 * Wire format (v2), verified by nextcloud-connector/src/ncProxy.js:
 *
 *   message = `${ts}\n${METHOD}\n${decodedPath}\n${ncUid}\n${sha256(body)}`
 *   header  = X-Beeflow-Sig: `${ts}.${hex(hmac_sha256(tenantKey, message))}`
 *
 * Three details the connector cares about, all easy to get wrong twice:
 *
 *   - METHOD is the REAL method, even when the request is tunnelled over
 *     POST + X-HTTP-Method-Override (NC's AppAPI proxy rejects raw
 *     PROPFIND/REPORT). Signing the real verb is also what stops the
 *     override being swapped in flight.
 *   - The path is signed DECODED: the NC/HaRP proxy percent-decodes before
 *     the connector sees it, so signing the encoded form breaks every path
 *     containing reserved characters (calendar UIDs end in `@host`).
 *   - A body-less request hashes the EMPTY STRING, not "no hash". The
 *     connector's pre-body-hash v1 form is accepted "for one release" and
 *     is on its way out; every signer here must emit v2 so removing v1
 *     upstream is a no-op rather than an outage in user/group sync.
 *
 * Callers: integrations/nextcloudClient.js (per-user tool traffic) and
 * services/ncUserGroupSync.js (service-level OCS reads). The cross-repo
 * test vector lives in integrations/nextcloudClient.test.js and
 * nextcloud-connector/test/ncProxy.test.js.
 */

const crypto = require('crypto');

/** Bytes the connector will hash: string/Buffer as-is, absent → empty. */
function hashableBody(body) {
    if (body == null) return '';
    if (typeof body === 'string') return body;
    if (Buffer.isBuffer(body)) return body;
    if (ArrayBuffer.isView(body)) return Buffer.from(body.buffer, body.byteOffset, body.byteLength);
    if (body instanceof ArrayBuffer) return Buffer.from(body);
    throw new Error(
        'Nextcloud connector requests must carry a string or Buffer body — '
        + `got ${body?.constructor?.name || typeof body}. Buffer the payload before calling.`
    );
}

function bodyHash(body) {
    return crypto.createHash('sha256').update(hashableBody(body)).digest('hex');
}

/** Decode for signing; malformed escapes fall back to the raw path. */
function signablePath(pathOnly) {
    try { return decodeURIComponent(pathOnly); } catch (_) { return pathOnly; }
}

/**
 * @returns {{ 'X-Beeflow-Sig': string, 'X-Beeflow-NC-Uid': string }}
 *   Sign per attempt, not once per request: a throttle retry can sleep past
 *   the connector's skew window with a stale timestamp.
 */
function signedConnectorHeaders({ tenantKey, method, path, ncUid, body = null, ts = null }) {
    if (!tenantKey) throw new Error('tenantKey required to sign a connector request');
    const stamp = ts ?? Math.floor(Date.now() / 1000);
    const message = `${stamp}\n${String(method).toUpperCase()}\n${signablePath(path)}\n${ncUid || ''}\n${bodyHash(body)}`;
    const sig = crypto.createHmac('sha256', tenantKey).update(message).digest('hex');
    return {
        'X-Beeflow-Sig': `${stamp}.${sig}`,
        'X-Beeflow-NC-Uid': ncUid || '',
    };
}

module.exports = { signedConnectorHeaders, bodyHash, hashableBody, signablePath };
