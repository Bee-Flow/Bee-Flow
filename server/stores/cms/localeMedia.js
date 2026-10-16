// @typecheck
// Per-language media in the CMS translation layer. A locale override is a
// sparse patch over a block's content; until now only text got through. The
// media addresses of a block (image / clip src, its dark twin, the poster and
// the captions file) can differ per language too: a Dutch homepage should play
// the Dutch intro clip, not the English one.
//
// Leaf module: it requires no other cms/ file. An override value is accepted
// only when it is an address the public renderer would also accept for the
// default language (an uploaded asset key, a same-site path, or http(s)), so
// a translator can not smuggle a javascript:/data: URL or markup into an
// `<img src>` / `<video poster>`.

'use strict';

/** The content keys that carry a media address. */
const MEDIA_KEYS = ['src', 'srcDark', 'poster', 'captionsSrc'];
const MEDIA_REF_MAX = 2048;
const MEDIA_WARNING = 'Some media addresses were not accepted and were dropped (the default language shows there). A media src/srcDark/poster/captionsSrc must be an uploaded asset key (cms/…), a /api/cms/asset/… path or an http(s) URL.';

function isObject(v) {
    return v !== null && typeof v === 'object' && !Array.isArray(v);
}

/**
 * The clean address when `v` is a legal media reference, else ''.
 * Legal: an uploaded asset key ("cms/…"), the asset route ("/api/cms/asset/…"
 * or any other single-slash site path) or an http(s) URL; no whitespace,
 * quotes, angle brackets, backslashes or ".." segments.
 * @param {unknown} v
 * @returns {string}
 */
function safeMediaRef(v) {
    if (typeof v !== 'string') return '';
    const s = v.trim();
    if (!s || s.length > MEDIA_REF_MAX) return '';
    if (/[\s"'`<>\\\u0000-\u001F\u007F]/.test(s)) return '';
    if (s.split('/').includes('..')) return '';
    if (s.startsWith('cms/')) return /^cms\/[A-Za-z0-9._~%/-]+$/.test(s) ? s : '';
    if (s.startsWith('/')) return s.startsWith('//') ? '' : s;
    if (/^https?:\/\//i.test(s)) {
        try {
            const u = new URL(s);
            return (u.protocol === 'http:' || u.protocol === 'https:') && u.hostname ? s : '';
        } catch { return ''; }
    }
    return '';
}

/**
 * The clean address when `v` is an uploaded-asset address usable as an icon
 * ("cms/…" or "/api/cms/asset/…"), else ''. Stricter than safeMediaRef: an icon
 * never points at another origin or an arbitrary site path.
 * @param {unknown} v
 * @returns {string}
 */
function safeIconAsset(v) {
    const ref = safeMediaRef(v);
    return ref.startsWith('cms/') || ref.startsWith('/api/cms/asset/') ? ref : '';
}

/**
 * Copy of an override's `content` in which every media key holds a legal
 * address or is gone. Text keys pass through untouched.
 * @param {unknown} node
 * @returns {unknown}
 */
function cleanOverrideMedia(node) {
    if (Array.isArray(node)) return node.map(cleanOverrideMedia);
    if (!isObject(node)) return node;
    /** @type {Record<string, unknown>} */
    const out = {};
    for (const [k, v] of Object.entries(/** @type {Record<string, unknown>} */ (node))) {
        if (MEDIA_KEYS.includes(k)) {
            const ref = safeMediaRef(v);
            if (ref) out[k] = ref;
        } else {
            out[k] = cleanOverrideMedia(v);
        }
    }
    return out;
}

/**
 * How many non-empty media addresses a content tree carries. A save that
 * returns fewer than were sent had some of them dropped by the cleaner.
 * @param {unknown} node
 * @returns {number}
 */
function countMediaRefs(node) {
    if (Array.isArray(node)) return node.reduce((n, el) => n + countMediaRefs(el), 0);
    if (!isObject(node)) return 0;
    let n = 0;
    for (const [k, v] of Object.entries(/** @type {Record<string, unknown>} */ (node))) {
        n += MEDIA_KEYS.includes(k) ? (typeof v === 'string' && v.trim() ? 1 : 0) : countMediaRefs(v);
    }
    return n;
}

/**
 * The warning of a locale-override save when the cleaner dropped media
 * addresses (shared by the MCP tool and the admin routes), else undefined.
 * @param {unknown} sent
 * @param {unknown} saved
 * @returns {string | undefined}
 */
function mediaWarningFor(sent, saved) {
    return saved && countMediaRefs(sent) > countMediaRefs(saved) ? MEDIA_WARNING : undefined;
}

/**
 * Lay the media addresses of a (cleaned) override over the base content.
 * Walks both trees in step (arrays by index). A media key is applied to every
 * object that already has a `src` of its own (a media slot): that way a clip
 * translated with only a `poster` still shows it when the default has none.
 * @param {unknown} base
 * @param {unknown} override
 * @returns {unknown}
 */
function applyOverrideMedia(base, override) {
    if (Array.isArray(base)) {
        if (!Array.isArray(override)) return base;
        return base.map((el, i) => (i < override.length ? applyOverrideMedia(el, override[i]) : el));
    }
    if (!isObject(base) || !isObject(override)) return base;
    const baseObj = /** @type {Record<string, unknown>} */ (base);
    /** @type {Record<string, unknown>} */
    const out = { ...baseObj };
    const isSlot = typeof baseObj.src === 'string';
    for (const [k, ov] of Object.entries(override)) {
        if (MEDIA_KEYS.includes(k)) {
            const ref = safeMediaRef(ov);
            if (ref && (k in baseObj || isSlot)) out[k] = ref;
        } else if (k in baseObj) {
            out[k] = applyOverrideMedia(baseObj[k], ov);
        }
    }
    return out;
}

module.exports = { MEDIA_KEYS, MEDIA_WARNING, countMediaRefs, mediaWarningFor, safeMediaRef, safeIconAsset, cleanOverrideMedia, applyOverrideMedia };
