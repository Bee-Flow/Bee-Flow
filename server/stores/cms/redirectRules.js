// @typecheck
'use strict';
/**
 * Redirects of the public marketing site: pure rules, no I/O.
 *
 * A redirect is `from` (a path on this site) -> `to` (another path on this
 * site, or an explicitly allowed external https URL) with a 301 or 302. They
 * keep the inbound links and ranking of a page that was renamed or merged.
 *
 * The invariants live HERE so the admin route, the MCP tool, the automatic
 * slug-change entry, import and the public renderer cannot disagree:
 *   - never a loop: adding A -> B is refused when B (followed through the
 *     existing entries) ends up at A;
 *   - never a chain at serve time: the target is resolved to its final
 *     destination on write, and entries that pointed at A are re-pointed, so
 *     the renderer answers with ONE hop;
 *   - never an open redirect: an internal target is a single-slash path made
 *     of URL-safe characters (no `//host`, no backslash, no scheme); an
 *     external target needs `external: true` AND its host on the site's
 *     allow-list, and is https only;
 *   - `from` is a lower-case path that is not the homepage and not an app,
 *     API or other reserved namespace (those are never marketing URLs).
 */

const crypto = require('crypto');
const { RESERVED_TOP_LEVEL, LOCALE_PREFIXES, BLOG_BASE } = require('./slugRules');

const MAX_REDIRECTS = 1000;
const MAX_HOSTS = 50;
const MAX_PATH = 300;
const MAX_TARGET = 500;
const STATUSES = Object.freeze([301, 302]);
/** Hops followed while resolving a target; far above anything legitimate. */
const MAX_HOPS = 10;

const FROM_RE = /^\/[a-z0-9][a-z0-9._~-]*(?:\/[a-z0-9][a-z0-9._~-]*)*$/;
const INTERNAL_RE = /^\/[A-Za-z0-9._~/%-]*(?:\?[A-Za-z0-9._~/%=&+:@,;-]*)?(?:#[A-Za-z0-9._~/%=&+:@,;-]*)?$/;
const HOST_RE = /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;

/**
 * @typedef {object} Redirect
 * @property {string} id
 * @property {string} from      lower-case path, no trailing slash
 * @property {string} to        a site path ("/new", optionally ?query/#hash) or an https URL
 * @property {301 | 302} status
 * @property {boolean} external true when `to` is an absolute https URL
 * @property {boolean} auto     created by a slug change, not by hand
 * @property {string} createdAt ISO date
 */

class RedirectError extends Error {
    /** @param {string} code @param {string} message */
    constructor(code, message) {
        super(message);
        this.name = 'RedirectError';
        this.code = code;
    }
}

/** @param {unknown} v @returns {v is Record<string, unknown>} */
const isObject = (v) => !!v && typeof v === 'object' && !Array.isArray(v);

/**
 * The path part of a site path ("/a/b?x#y" -> "/a/b"), lower-cased, without a
 * trailing slash. "/" stays "/".
 * @param {string} p
 */
function pathOnly(p) {
    const cut = String(p).split(/[?#]/)[0].toLowerCase();
    return cut.length > 1 ? cut.replace(/\/+$/, '') || '/' : cut;
}

/**
 * @param {unknown} raw what an editor typed ("Old-Page", "/old-page/")
 * @param {string[]} [locales] site locales besides the built-in prefixes
 * @returns {string} the normalized `from`
 */
function normalizeFrom(raw, locales = []) {
    let s = String(raw ?? '').trim();
    if (!s) throw new RedirectError('from_required', 'The old address is required.');
    if (/^[a-z][a-z0-9+.-]*:/i.test(s) || s.startsWith('//')) {
        throw new RedirectError('from_not_a_path', 'The old address is a path on this site such as /old-page, not a full URL.');
    }
    if (/[?#]/.test(s)) throw new RedirectError('from_has_query', 'The old address cannot contain ? or #.');
    if (!s.startsWith('/')) s = `/${s}`;
    s = pathOnly(s);
    if (s.length > MAX_PATH || !FROM_RE.test(s)) {
        throw new RedirectError('from_invalid', 'The old address may only use letters, digits, dashes, dots and slashes.');
    }
    const first = s.slice(1).split('/')[0];
    if (RESERVED_TOP_LEVEL.has(first)) {
        throw new RedirectError('from_reserved', `"/${first}" belongs to the application and cannot be redirected.`);
    }
    // A locale prefix is never part of `from`: a request for /nl/x already
    // reaches the entry for /x, so a prefixed entry could only form a loop with
    // it (or hide the localised homepage, for /nl itself).
    if (LOCALE_PREFIXES.has(first) || locales.includes(first)) {
        throw new RedirectError('from_locale_prefix', `"/${first}" is a language prefix. Redirect the address without it (for example /old-page); it applies to every language.`);
    }
    // The blog index is a live page of its own; its posts are guarded when serving (siteRedirect.js).
    if (s === `/${BLOG_BASE}`) {
        throw new RedirectError('from_blog', 'The blog index cannot be redirected.');
    }
    return s;
}

/**
 * Allowed external hosts: lower-case hostnames, no scheme, no port, no path.
 * @param {unknown} raw
 * @returns {string[]}
 */
function sanitizeHosts(raw) {
    if (!Array.isArray(raw)) return [];
    const out = [];
    for (const h of raw) {
        const host = String(h ?? '').trim().toLowerCase();
        if (HOST_RE.test(host) && !out.includes(host)) out.push(host);
        if (out.length >= MAX_HOSTS) break;
    }
    return out;
}

/**
 * @param {unknown} raw
 * @param {{ external?: boolean, allowedHosts?: string[] }} [opts]
 * @returns {{ to: string, external: boolean }}
 */
function normalizeTarget(raw, { external = false, allowedHosts = [] } = {}) {
    const to = String(raw ?? '').trim();
    if (!to) throw new RedirectError('to_required', 'The new address is required.');
    if (to.length > MAX_TARGET) throw new RedirectError('to_too_long', 'The new address is too long.');
    if (/[\u0000- \u007F\\]/.test(to)) {
        throw new RedirectError('to_invalid', 'The new address cannot contain spaces, control characters or backslashes.');
    }
    if (to.startsWith('/')) {
        if (to.startsWith('//')) throw new RedirectError('to_invalid', 'The new address cannot start with //.');
        if (!INTERNAL_RE.test(to) || /(?:^|\/)\.\.?(?:\/|$|\?|#)|\/\/[^?#]*(?:[?#]|$)|\/\/./.test(to.split(/[?#]/)[0])) throw new RedirectError('to_invalid', 'The new address contains characters that are not allowed.');
        return { to, external: false };
    }
    if (!/^https:\/\//i.test(to)) {
        throw new RedirectError('to_invalid', 'The new address is a path on this site such as /new-page, or an https:// URL on an allowed host.');
    }
    if (!external) {
        throw new RedirectError('to_external_not_confirmed', 'A redirect to another website must be marked external.');
    }
    let url;
    try { url = new URL(to); } catch { throw new RedirectError('to_invalid', 'The new address is not a valid URL.'); }
    if (url.username || url.password || url.port) {
        throw new RedirectError('to_invalid', 'An external address cannot contain credentials or a port.');
    }
    if (!sanitizeHosts(allowedHosts).includes(url.hostname.toLowerCase())) {
        throw new RedirectError('to_host_not_allowed', `"${url.hostname}" is not on this site's list of allowed redirect hosts.`);
    }
    return { to: url.href, external: true };
}

/**
 * Follow `list` from a site path to where it ends. Internal hops only.
 * @param {Redirect[]} list
 * @param {string} start
 * @returns {{ to: string, external: boolean, hops: number, looped: boolean }}
 */
function resolveTarget(list, start) {
    let current = start;
    for (let hops = 0; hops < MAX_HOPS; hops++) {
        if (!current.startsWith('/')) return { to: current, external: true, hops, looped: false };
        const hit = list.find((r) => r.from === pathOnly(current));
        if (!hit) return { to: current, external: false, hops, looped: false };
        current = hit.to;
    }
    return { to: current, external: !current.startsWith('/'), hops: MAX_HOPS, looped: true };
}

/** @param {unknown} v @returns {301 | 302} */
function normalizeStatus(v) {
    const n = Number(v ?? 301);
    if (n === 301 || n === 302) return n;
    throw new RedirectError('status_invalid', 'The status must be 301 (permanent) or 302 (temporary).');
}

/**
 * Add or replace (same `from`) one redirect and return the new list. Throws a
 * RedirectError when the entry would break an invariant.
 * @param {Redirect[]} list
 * @param {{ from: unknown, to: unknown, status?: unknown, external?: unknown, auto?: boolean, id?: string, createdAt?: string }} input
 * @param {{ allowedHosts?: string[], locales?: string[] }} [opts]
 * @returns {Redirect[]}
 */
function addRedirect(list, input, { allowedHosts = [], locales = [] } = {}) {
    const from = normalizeFrom(input.from, locales);
    const status = normalizeStatus(input.status);
    const target = normalizeTarget(input.to, { external: input.external === true, allowedHosts });
    const rest = list.filter((r) => r.from !== from);
    if (!target.external && pathOnly(target.to) === from) {
        throw new RedirectError('loop', 'A redirect cannot point at itself.');
    }
    // Where does the target end up? Reaching `from` again is a loop.
    const end = target.external ? { ...target, looped: false } : resolveTarget(rest, target.to);
    if (end.looped || (!end.external && pathOnly(end.to) === from)) {
        throw new RedirectError('loop', 'That would create a redirect loop.');
    }
    // Flatten: store the final destination, so serving is one hop.
    if (end.to !== target.to) {
        target.to = end.to;
        target.external = end.external;
    }
    const entry = /** @type {Redirect} */ ({
        id: typeof input.id === 'string' && /^rd_[a-f0-9]{16}$/.test(input.id) ? input.id : `rd_${crypto.randomBytes(8).toString('hex')}`,
        from,
        to: target.to,
        status,
        external: target.external,
        auto: input.auto === true,
        createdAt: typeof input.createdAt === 'string' && !Number.isNaN(Date.parse(input.createdAt)) ? input.createdAt : new Date().toISOString(),
    });
    if (rest.length >= MAX_REDIRECTS) {
        throw new RedirectError('too_many', `A site can have at most ${MAX_REDIRECTS} redirects.`);
    }
    // Entries that pointed at `from` now skip it (no chains).
    const repointed = rest.map((r) => (!r.external && pathOnly(r.to) === from ? { ...r, to: entry.to, external: entry.external } : r));
    return [...repointed, entry];
}

/**
 * Rebuild a stored or imported list: invalid and conflicting entries are
 * dropped (a bad row must not poison the site), the rest are re-added in order
 * so the loop and chain rules hold for the whole list.
 * @param {unknown} raw
 * @param {string[]} [allowedHosts]
 * @returns {Redirect[]}
 */
function sanitizeRedirects(raw, allowedHosts = []) {
    if (!Array.isArray(raw)) return [];
    let list = /** @type {Redirect[]} */ ([]);
    for (const r of raw.slice(0, MAX_REDIRECTS)) {
        if (!isObject(r)) continue;
        try {
            list = addRedirect(list, {
                from: r.from, to: r.to, status: r.status, external: r.external === true,
                auto: r.auto === true,
                id: typeof r.id === 'string' ? r.id : undefined,
                createdAt: typeof r.createdAt === 'string' ? r.createdAt : undefined,
            }, { allowedHosts });
        } catch (e) {
            if (!(e instanceof RedirectError)) throw e;
        }
    }
    return list;
}

/**
 * The entry for a page whose slug changed, as an `addRedirect` input; null
 * when the URL did not move.
 * @param {string} oldSlug
 * @param {string} newSlug
 */
function renameRedirect(oldSlug, newSlug) {
    if (!oldSlug || !newSlug || oldSlug === newSlug) return null;
    return { from: `/${oldSlug}`, to: `/${newSlug}`, status: 301, auto: true };
}

/**
 * The redirect that answers a request path, or null. Only the exact path
 * matches (case-insensitive, trailing slash ignored). A locale prefix is
 * accepted and carried over to a site target ("/nl/old" -> "/nl/new").
 * @param {Redirect[] | undefined} list
 * @param {string} reqPath
 * @param {string[]} [locales]
 * @returns {{ status: 301 | 302, to: string, external: boolean } | null}
 */
function findRedirect(list, reqPath, locales = []) {
    if (!Array.isArray(list) || !list.length) return null;
    const path = pathOnly(reqPath);
    let prefix = '';
    let hit = list.find((r) => r.from === path);
    if (!hit) {
        const [, first, tail] = /^\/([a-z]{2,3})(\/.+)$/.exec(path) || [];
        if (first && locales.includes(first)) {
            hit = list.find((r) => r.from === tail);
            prefix = `/${first}`;
        }
    }
    if (!hit) return null;
    if (hit.external || !prefix) return { status: hit.status, to: hit.to, external: !!hit.external };
    const first = hit.to.slice(1).split(/[/?#]/)[0];
    if (RESERVED_TOP_LEVEL.has(first)) return { status: hit.status, to: hit.to, external: false };
    return { status: hit.status, to: hit.to === '/' ? prefix : `${prefix}${hit.to}`, external: false };
}

module.exports = {
    MAX_REDIRECTS, STATUSES, RedirectError,
    normalizeFrom, normalizeTarget, sanitizeHosts, pathOnly,
    addRedirect, sanitizeRedirects, renameRedirect, findRedirect, resolveTarget,
};

/** @typedef {import('url').URL} URL */
