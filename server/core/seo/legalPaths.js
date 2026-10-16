// @typecheck
/**
 * The legal documents a site links to, and where they live.
 *
 * Footers and the cookie banner link to /legal/<doc>. A CMS slug is a single
 * path segment, so no page can sit at that address, and the SPA has no route
 * for it either: the address answered 200 with an empty app shell that
 * crawlers could not read. The documents are ordinary CMS pages instead
 * (/imprint, /dpa, ...), and the old address redirects to the page.
 */

const { parsePublicPath, buildPublicPath } = require('./publicPath');

/** The documents whose /legal/<doc> address is redirected. */
const LEGAL_DOCS = Object.freeze(['aup', 'cookies', 'dpa', 'imprint', 'subprocessors', 'terms', 'privacy']);

/**
 * @param {string} pathname
 * @param {string[]} locales locales the site publishes under a URL prefix
 * @param {string} defaultLocale
 * @returns {string | null} the CMS page path, or null when this is not a legal address
 */
function legalRedirectTarget(pathname, locales, defaultLocale) {
    const parts = String(pathname || '').replace(/\/+$/, '').split('/').slice(1);
    const known = locales.map(l => l.toLowerCase());
    const locale = parts.length && known.includes(parts[0].toLowerCase()) ? parts.shift()?.toLowerCase() || null : null;
    if (parts.length !== 2 || parts[0].toLowerCase() !== 'legal') return null;
    const doc = parts[1].toLowerCase();
    if (!LEGAL_DOCS.includes(doc)) return null;
    const target = buildPublicPath(locale, doc, defaultLocale);
    return parsePublicPath(target, locales) ? target : null;
}

module.exports = { legalRedirectTarget, LEGAL_DOCS };
