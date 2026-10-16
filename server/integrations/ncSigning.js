/**
 * The one HMAC implementation for SaaS → connector `/nc/*` callbacks.
 *
 * Wire format (v2), verified by nextcloud-connector/src/ncProxy.js:
 *
 *   message = `${ts}\n${METHOD}\n${decodedPath}\n${ncUid}\n${sha256(body)}`
 *   or, only for requests whose canonical form differs (see signedPathFor):
 *   message = `${ts}\n${METHOD}\n${canonicalPath}\n${ncUid}\n${sha256(body)}\nc1`
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
 *     containing reserved characters (calendar UIDs end in `@host`). The
 *     query is signed in canonicalQuery() form, because the hop re-encodes it.
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

/** Version marker inside the signed message: canonical signatures verify only with it. */
const CANONICAL_MARKER = 'c1';

const escChars = (/** @type {string} */ s, /** @type {RegExp} */ re) => s.replace(re,
    (c) => '%' + c.charCodeAt(0).toString(16).toUpperCase().padStart(2, '0'));

/** Strict form decode (`+` is a space); throws on an escape that is not valid UTF-8. */
function formDecode(/** @type {string} */ s) {
    return decodeURIComponent(s.replace(/\+/g, ' '));
}

/**
 * Canonical query for signing, identical on both sides (the connector has its
 * own copy in nextcloud-connector/src/ncProxy.js; test vectors pin both).
 *
 * The AppAPI/HaRP hop re-encodes the query (`%20` becomes `+`, `%26` stays),
 * so the raw string cannot be signed. Split into pairs, decode each key and
 * value as form data (`+` and `%20` alike), then re-emit with the delimiters
 * escaped (`% & = + #`, space, CR, LF): injective, so two different parameter
 * lists never share a canonical form, and a newline can never forge a field of
 * the signed message. Characters like `/ : @ ,` stay literal. An escape that
 * is not valid UTF-8 throws (URLSearchParams would map %FF and %FE to the
 * same U+FFFD and make distinct queries collide).
 * @throws {URIError}
 */
function canonicalQuery(query) {
    const out = [];
    for (const part of String(query).split('&')) {
        if (!part) continue;
        const eq = part.indexOf('=');
        const k = formDecode(eq < 0 ? part : part.slice(0, eq));
        const v = eq < 0 ? '' : formDecode(part.slice(eq + 1));
        out.push(`${escChars(k, /[%&=+# \r\n]/g)}=${escChars(v, /[%&=+# \r\n]/g)}`);
    }
    return out.join('&');
}

/**
 * The path part of the canonical form: decoded, then `% ? CR LF` escaped so
 * the path/query boundary and the message fields stay unambiguous.
 * @throws {URIError}
 */
function canonicalSignedPath(pathOnly) {
    const s = String(pathOnly);
    const q = s.indexOf('?');
    const path = escChars(decodeURIComponent(q < 0 ? s : s.slice(0, q)), /[%?\r\n]/g);
    return q < 0 ? path : `${path}?${canonicalQuery(s.slice(q + 1))}`;
}

/**
 * The pre-canonical signed path, byte-identical to what releases before the
 * canonical scheme signed: the whole path+query decoded, raw on a bad escape.
 * Connectors that predate `c1` verify exactly this.
 */
function legacySignablePath(pathOnly) {
    try { return decodeURIComponent(pathOnly); } catch (_) { return pathOnly; }
}

/**
 * Message path and marker suffix. The marked canonical form is used ONLY when
 * it differs from the legacy one (the request has a space, +, &, = or %-escape
 * in its query, or a % ? CR LF in the decoded path): those are the requests
 * the legacy form cannot get through the hop, and an old connector fails them
 * either way. Every other request signs the legacy message unchanged, so a
 * not-yet-updated connector keeps working for it.
 * @returns {{ path: string, suffix: string }}
 */
function signedPathFor(pathOnly) {
    const legacy = legacySignablePath(String(pathOnly));
    let canonical;
    try { canonical = canonicalSignedPath(pathOnly); } catch (_) { return { path: legacy, suffix: '' }; }
    return canonical === legacy ? { path: legacy, suffix: '' } : { path: canonical, suffix: `\n${CANONICAL_MARKER}` };
}

/**
 * @returns {{ 'X-Beeflow-Sig': string, 'X-Beeflow-NC-Uid': string }}
 *   Sign per attempt, not once per request: a throttle retry can sleep past
 *   the connector's skew window with a stale timestamp.
 */
function signedConnectorHeaders({ tenantKey, method, path, ncUid, body = null, ts = null }) {
    if (!tenantKey) throw new Error('tenantKey required to sign a connector request');
    const stamp = ts ?? Math.floor(Date.now() / 1000);
    const { path: signedPath, suffix } = signedPathFor(path);
    const message = `${stamp}\n${String(method).toUpperCase()}\n${signedPath}\n${ncUid || ''}\n${bodyHash(body)}${suffix}`;
    const sig = crypto.createHmac('sha256', tenantKey).update(message).digest('hex');
    return {
        'X-Beeflow-Sig': `${stamp}.${sig}`,
        'X-Beeflow-NC-Uid': ncUid || '',
    };
}

module.exports = { signedConnectorHeaders, bodyHash, hashableBody, canonicalSignedPath, canonicalQuery, CANONICAL_MARKER };
