// @typecheck
// The one rule for CMS page slugs. The store (create, rename, import), the
// builder's validation and the public router (core/seo/publicPath.js) all read
// it from here, so a slug the CMS accepts is a slug the site can serve.
//
// What the router does with a request path: trailing slashes are dropped, the
// segment is lowercased, and it must match PUBLIC_SLUG_RE and not be reserved.
// So a slug is stored lowercase, without slashes, and from this charset only.

/** Longest slug the CMS keeps. */
const SLUG_MAX_LENGTH = 64;

/** The shape the public router matches (no underscore, no leading dash). */
const PUBLIC_SLUG_RE = /^[a-z0-9][a-z0-9-]*$/;

// Top-level paths claimed by the app shell. Mirrors RESERVED_TOP_LEVEL in
// agent-hub/src/utils/cmsPublicRouting.ts; seo.test.js pins the two together.
const RESERVED_TOP_LEVEL = new Set([
    'app', 'api', 'admin', 'auth', 'login', 'logout', 'register', 'signup',
    'dashboard', 'settings', 'embed', 'oauth', 'callback',
    'chat', 'd', 'a', 'agent',
    // `f` is the hosted form-trigger namespace (/f/<token>). Two segments, so
    // parsePublicPath already rejects it — but a bare `/f` would otherwise be
    // treated as a CMS slug here and refused by the client, which is exactly
    // the server/client split the drift test exists to prevent.
    'f',
    // `p` is the public Studio-app namespace (/p/<token>) — the anonymous
    // intake screens of an app whose back-office stays behind requireAuth.
    'p',
    'org-settings',
    // 'terms', 'legal' and 'privacy' belong to the CMS (the legal pages). The
    // DSR form is /privacy/requests (two segments, matched by App.jsx before
    // the CMS gate), so a /privacy page does not shadow it.
    '__cms_preview__',
]);

/**
 * Non-default locales the public site serves under a URL prefix. Mirrors
 * LOCALE_PREFIXES in the client router (seo.test.js pins the two). Deliberately
 * NOT every locale the product has interface translations for: advertising
 * /de/<slug> (hreflang) when the client does not claim that prefix points
 * search engines at the wrong language. A page with one of these as its slug
 * would be shadowed by that locale's homepage, hence reserved below.
 */
const LOCALE_PREFIXES = new Set(['nl']);

/** The blog's path segment: /blog is the index, /blog/<post-slug> a post (/blog/feed.xml is its own route). */
const BLOG_BASE = 'blog';

/** Slugs a PAGE may not take: app routes, locale prefixes and the blog. */
const RESERVED_PAGE_SLUGS = new Set([...RESERVED_TOP_LEVEL, ...LOCALE_PREFIXES, BLOG_BASE]);

/**
 * Turn user input into a slug the router can serve: lowercase, spaces and
 * underscores become dashes, anything else outside a-z, 0-9 and dash goes,
 * repeated and edge dashes are removed, capped at SLUG_MAX_LENGTH. May return
 * '' (callers pick a fallback) or a reserved slug (callers check isReserved).
 * @param {unknown} raw
 */
function normalizeSlug(raw) {
    return String(raw || '')
        .toLowerCase()
        .trim()
        .replace(/^\/+/, '')
        .replace(/[\s_]+/g, '-')
        .replace(/[^a-z0-9-]/g, '')
        .replace(/-{2,}/g, '-')
        .replace(/^-+/, '')
        .slice(0, SLUG_MAX_LENGTH)
        .replace(/-+$/, '');
}

/**
 * The slug as ALREADY STORED: the lenient pre-rule normalisation (it kept `_`
 * and leading dashes). Used where stored data is read back, so existing sites
 * are not silently renamed; slugProblem() reports them instead.
 * @param {unknown} raw
 */
function normalizeStoredSlug(raw) {
    return String(raw || '')
        .toLowerCase()
        .trim()
        .replace(/^\/+/, '')
        .replace(/\s+/g, '-')
        .replace(/[^a-z0-9_-]/g, '')
        .slice(0, SLUG_MAX_LENGTH);
}

/** @param {unknown} slug */
function isReservedSlug(slug) {
    return RESERVED_PAGE_SLUGS.has(String(slug || '').toLowerCase());
}

/**
 * Why a slug cannot be served on the public site, or null when it can.
 * @param {unknown} slug
 * @returns {null | { code: 'reserved' | 'unroutable', message: string }}
 */
function slugProblem(slug) {
    const s = String(slug || '');
    if (isReservedSlug(s)) {
        return { code: 'reserved', message: `Slug "${s}" is reserved (it collides with an app route, a language prefix or the blog).` };
    }
    if (s.length > SLUG_MAX_LENGTH || !PUBLIC_SLUG_RE.test(s)) {
        return {
            code: 'unroutable',
            message: `Slug "${s.slice(0, 80)}" cannot be reached on the public site (use lowercase letters, digits and "-", at most ${SLUG_MAX_LENGTH} characters, not starting with "-").`,
        };
    }
    return null;
}

module.exports = {
    SLUG_MAX_LENGTH, PUBLIC_SLUG_RE, RESERVED_TOP_LEVEL, LOCALE_PREFIXES, BLOG_BASE, RESERVED_PAGE_SLUGS,
    normalizeSlug, normalizeStoredSlug, isReservedSlug, slugProblem,
};
