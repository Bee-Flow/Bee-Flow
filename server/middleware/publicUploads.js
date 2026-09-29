// @typecheck
/**
 * Which paths under `data/uploads` may be served without authentication.
 *
 * That directory mixes two very different things:
 *   - genuinely public images — user avatars and org logos, written as FLAT
 *     files by `auth/adminRoutes.js` and referenced as `/uploads/<file>`, plus
 *     the `agents/` subtree used by `agent-hub/src/utils/agentAvatar.js`;
 *   - private user content — above all `saved-recordings/`, which holds every
 *     meeting's raw audio, and `audio/`, the upload staging area.
 *
 * The static mount sits ahead of every router and authenticates nothing, so
 * serving the whole tree meant any meeting recording could be fetched by
 * filename with no session at all — bypassing the ACL on
 * `GET /api/transcriptions/:id/audio` and the deletion path that exists to
 * honour erasure requests. The filename did not even have to be guessed: the
 * note payload used to carry the server-side path.
 *
 * ALLOWLIST, not denylist. A new subdirectory under `data/uploads` is private
 * by default; it has to be named here to become public. The failure mode of
 * getting this wrong is a broken image, not a leaked recording.
 */

'use strict';

/** Subtrees that are public. Everything else with a `/` in it is not. */
const PUBLIC_SUBTREES = ['agents/'];

/**
 * @param {string} urlPath  The path within the /uploads mount (e.g. '/a.png').
 * @returns {boolean} true when it may be served anonymously.
 */
function isPublicUploadPath(urlPath) {
    // Normalise away the leading slash(es) so 'agents/x.png' and '/agents/x.png'
    // behave the same. Percent-encoding is decoded first so `%2e%2e%2f` and
    // friends cannot smuggle a separator past the check.
    let rel = String(urlPath || '');
    try { rel = decodeURIComponent(rel); } catch (_) { return false; }
    rel = rel.replace(/^\/+/, '');
    // Backslashes are path separators on Windows; treat them as such here too.
    rel = rel.replace(/\\/g, '/');

    if (!rel) return false;
    if (rel.includes('..')) return false;          // never, at any depth
    if (!rel.includes('/')) return true;            // a flat file: avatar / org logo
    return PUBLIC_SUBTREES.some(prefix => rel.startsWith(prefix));
}

/** Express middleware: 404 anything the allowlist does not cover. */
function publicUploadsOnly(req, res, next) {
    if (!isPublicUploadPath(req.path)) return res.sendStatus(404);
    next();
}

module.exports = { isPublicUploadPath, publicUploadsOnly, PUBLIC_SUBTREES };
