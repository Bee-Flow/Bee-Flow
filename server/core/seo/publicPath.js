/**
 * Which public URLs are marketing pages, and what locale + slug they mean.
 *
 * This is the SERVER half of a rule the client already implements in
 * agent-hub/src/utils/cmsPublicRouting.js. The two must agree: if the server
 * renders a page the client then refuses to route, the visitor sees content
 * for an instant and is then bounced to /app. `publicPath.test.js` pins the
 * reserved list against the client's copy so they cannot drift silently.
 *
 * NEW HERE vs the client's original rule: an optional locale prefix.
 * `/nl/pricing` and `/nl` are marketing paths. Before this, Dutch lived at
 * `?locale=nl`, which gave every page three crawlable URLs
 * (`/pricing`, `/pricing?locale=en`, `/pricing?locale=nl`) serving two
 * content variants with no canonical and no hreflang — so search engines saw
 * duplicates rather than a translation.
 */

// Mirrors RESERVED_TOP_LEVEL in agent-hub/src/utils/cmsPublicRouting.js.
// Kept as a literal rather than imported: that file is browser ESM inside a
// different package. publicPath.test.js parses it and asserts equality.
const RESERVED_TOP_LEVEL = new Set([
    'app', 'api', 'admin', 'auth', 'login', 'logout', 'register', 'signup',
    'dashboard', 'settings', 'embed', 'oauth', 'callback',
    'chat', 'd', 'a', 'agent',
    // `f` is the hosted form-trigger namespace (/f/<token>). Two segments, so
    // parsePublicPath already rejects it — but a bare `/f` would otherwise be
    // treated as a CMS slug here and refused by the client, which is exactly
    // the server/client split the drift test below exists to prevent.
    'f',
    // `p` is the public Studio-app namespace (/p/<token>) — the anonymous
    // intake screens of an app whose back-office stays behind requireAuth.
    // Same two-segment reasoning as `f` above.
    'p',
    'org-settings',
    // 'terms' and 'legal' were released to the CMS when the static legal-docs
    // feature was retired; only 'privacy' stays reserved (the /privacy/requests
    // DSR form owns that namespace). Must match the client set exactly.
    'privacy',
    '__cms_preview__',
]);

// No underscore: cmsStore.normalizeSlug permits `_`, but such a slug is
// publicly unroutable. Same charset as the client's PUBLIC_SLUG_RE.
const PUBLIC_SLUG_RE = /^[a-z0-9][a-z0-9-]*$/;

/**
 * Non-default locales the PUBLIC SITE serves under a URL prefix.
 *
 * Deliberately NOT `languageStore.getAvailableLocales()`. That returns every
 * locale the product has interface translations for — de, fr and others — and
 * using it made every page advertise `hreflang="de"` pointing at /de/<slug>.
 * The client router does not claim those prefixes, so the URL resolves to the
 * English page: a search engine follows the alternate, finds the wrong
 * language, and reports the whole hreflang cluster as broken. Advertising a
 * translation that does not exist is worse than advertising none.
 *
 * Mirrors LOCALE_PREFIXES in agent-hub/src/utils/cmsPublicRouting.js; the
 * drift test in seo.test.js pins the two together.
 */
const LOCALE_PREFIXES = new Set(['nl']);

/**
 * Parse a pathname into `{ locale, slug }`, or null when it is not a
 * marketing path at all (an app route, an asset, a multi-segment URL).
 *
 * `locale` is null when the path carries no prefix — the caller then applies
 * the site default. `slug` is '' for a homepage.
 *
 * @param {string} pathname
 * @param {string[]} knownLocales locales the site actually publishes; a
 *   two-letter segment is only treated as a locale prefix if it is in here,
 *   so a future page at /it/ is a page and not a broken Italian homepage.
 */
function parsePublicPath(pathname, knownLocales = []) {
    if (typeof pathname !== 'string' || pathname === '') return null;

    const locales = new Set(knownLocales.map(l => String(l).toLowerCase()));
    const trimmed = pathname.replace(/\/+$/, '') || '/';
    if (trimmed === '/') return { locale: null, slug: '' };

    const segments = trimmed.slice(1).split('/');
    if (segments.length > 2) return null;

    let locale = null;
    let slugSeg = segments[0];

    if (locales.has(segments[0].toLowerCase())) {
        locale = segments[0].toLowerCase();
        slugSeg = segments.length === 2 ? segments[1] : '';
        if (slugSeg === '') return { locale, slug: '' };   // e.g. /nl
    } else if (segments.length === 2) {
        // Two segments and the first is not a locale — not ours.
        return null;
    }

    const seg = slugSeg.toLowerCase();
    if (RESERVED_TOP_LEVEL.has(seg)) return null;
    if (!PUBLIC_SLUG_RE.test(seg)) return null;
    return { locale, slug: seg };
}

/**
 * The one canonical path for a (locale, slug) pair.
 *
 * The default locale is served WITHOUT a prefix. Prefixing it too would mean
 * `/pricing` and `/en/pricing` both resolve, which is the duplicate problem
 * this module exists to end.
 */
function buildPublicPath(locale, slug, defaultLocale) {
    const prefix = (locale && locale !== defaultLocale) ? `/${locale}` : '';
    const tail = slug ? `/${slug}` : '';
    return `${prefix}${tail}` || '/';
}

module.exports = { parsePublicPath, buildPublicPath, RESERVED_TOP_LEVEL, PUBLIC_SLUG_RE, LOCALE_PREFIXES };
