// @typecheck strict
'use strict';
/**
 * The one public-render question about redirects: does this request path have
 * one in the published snapshot, and where does it go? Pure; the caller hands
 * in the snapshot, so routes/publicRender.js only needs a single call.
 */

const { findRedirect, pathOnly } = require('../../stores/cms/redirectRules');
const { BLOG_BASE, parsePublicPath, buildPublicPath } = require('./publicPath');

/**
 * @param {{ redirects?: unknown, posts?: Record<string, unknown>, site?: { pages?: { slug?: string }[] } } | null | undefined} snapshot
 * @param {string} reqPath
 * @param {string[]} locales   locales the site publishes (a prefix is only stripped for these)
 * @param {URLSearchParams} [query]  carried to a site target that has no query of its own
 * @param {SiteContext} [site]  with `defaultLocale`, a `?locale=` in the query is applied to the target here
 * @returns {{ status: 301 | 302, location: string, locale?: string } | null}  `locale`: the `?locale=` that was applied
 */
function resolveSiteRedirect(snapshot, reqPath, locales, query, site = {}) {
    const list = Array.isArray(snapshot?.redirects) ? snapshot.redirects : [];
    if (!list.length) return null;
    const hit = findRedirect(list, reqPath, locales);
    if (!hit) return null;

    // A page that exists at the address always wins: a redirect must never
    // take a live page offline (a page created after the entry was).
    const asked = pathOnly(reqPath);
    const bare = asked.replace(new RegExp(`^/(?:${locales.map((l) => l.replace(/[^a-z]/g, '')).filter(Boolean).join('|') || '(?!)'})(?=/)`), '');
    const slug = bare.slice(1);
    if ((snapshot?.site?.pages || []).some((p) => p.slug === slug)) return null;
    // Same for a published blog post (and the blog index, which a page may own).
    if (slug === BLOG_BASE) return null;
    if (slug.startsWith(`${BLOG_BASE}/`)) {
        const postSlug = slug.slice(BLOG_BASE.length + 1);
        if (Object.values(snapshot?.posts || {}).some((p) => !!p && typeof p === 'object' && /** @type {{ slug?: string }} */ (p).slug === postSlug)) return null;
    }

    const localized = hit.external ? null : withAskedLocale(hit.to, query, locales, site);
    let location = localized ? localized.location : hit.to;
    const qs = localized ? localized.query.toString() : (query ? query.toString() : '');
    if (!hit.external && qs && !location.includes('?')) {
        const hashAt = location.indexOf('#');
        location = hashAt === -1 ? `${location}?${qs}` : `${location.slice(0, hashAt)}?${qs}${location.slice(hashAt)}`;
    }
    return localized ? { status: hit.status, location, locale: localized.locale } : { status: hit.status, location };
}

/**
 * The `?locale=` the visitor asked for, applied to a site target right away.
 * Left in the query it made the redirect land on `/new?locale=nl`, which the
 * locale consolidation in routes/publicRender.js then moved to `/nl/new`: two
 * 301s for one hop. Null when the target is not a marketing page or the
 * locale is not one the site publishes; the query then goes along unchanged.
 * @param {string} to the redirect target (a site path, maybe with ?query and #hash)
 * @param {URLSearchParams | undefined} query
 * @param {string[]} locales
 * @param {SiteContext} site
 * @returns {{ location: string, query: URLSearchParams, locale: string } | null}
 */
function withAskedLocale(to, query, locales, { defaultLocale, pageLocales }) {
    const asked = String(query?.get('locale') || '').toLowerCase().split('-')[0];
    if (!asked || !defaultLocale || !locales.includes(asked)) return null;
    const cut = [to.indexOf('?'), to.indexOf('#')].filter((i) => i !== -1);
    const at = cut.length ? Math.min(...cut) : to.length;
    const parsed = parsePublicPath(to.slice(0, at), locales) || parseIntegrationPath(to.slice(0, at), locales);
    if (!parsed) return null;
    // A page that has no translation in that locale is served in the default one (the publicRender rule).
    const available = pageLocales ? pageLocales(parsed.slug) : null;
    const locale = available && !available.includes(asked) ? defaultLocale : asked;
    const rest = new URLSearchParams(query);
    rest.delete('locale');
    return { location: `${buildPublicPath(locale, parsed.slug, defaultLocale)}${to.slice(at)}`, query: rest, locale: asked };
}

const INTEGRATIONS_BASE = 'integrations';

/**
 * An integration page address (`/integrations/<id>`, `/<locale>/integrations/<id>`,
 * the directory included) as its slug `integrations/<id>`, else null. These
 * pages have their own router (routes/publicIntegrationsRender.js), so
 * parsePublicPath does not know them.
 * @param {string} path a site path without query or hash
 * @param {string[]} locales
 * @returns {{ slug: string } | null}
 */
function parseIntegrationPath(path, locales) {
    let end = path.length;
    while (end > 1 && path[end - 1] === '/') end--;
    const parts = path.slice(0, end).split('/').slice(1);
    if (parts.length === 3 && locales.includes(parts[0].toLowerCase())) parts.shift();
    if (parts.length !== 2 || parts[0].toLowerCase() !== INTEGRATIONS_BASE) return null;
    const id = parts[1].toLowerCase();
    const valid = id.length > 0 && [...id].every((c) => (c >= 'a' && c <= 'z') || (c >= '0' && c <= '9') || c === '-');
    return valid ? { slug: `${INTEGRATIONS_BASE}/${id}` } : null;
}

/**
 * @typedef {{ defaultLocale?: string, pageLocales?: (slug: string) => string[] | null }} SiteContext
 *   `pageLocales`: the locales a target is published in (a page slug, `blog/<post>` or
 *   `integrations/<id>`), or null when unknown (nothing at that slug)
 */

module.exports = { resolveSiteRedirect };
