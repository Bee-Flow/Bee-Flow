// @typecheck noImplicitAny
'use strict';
/**
 * The one public-render question about redirects: does this request path have
 * one in the published snapshot, and where does it go? Pure; the caller hands
 * in the snapshot, so routes/publicRender.js only needs a single call.
 */

const { findRedirect, pathOnly } = require('../../stores/cms/redirectRules');
const { BLOG_BASE } = require('./publicPath');

/**
 * @param {{ redirects?: unknown, posts?: Record<string, unknown>, site?: { pages?: { slug?: string }[] } } | null | undefined} snapshot
 * @param {string} reqPath
 * @param {string[]} locales   locales the site publishes (a prefix is only stripped for these)
 * @param {URLSearchParams} [query]  carried to a site target that has no query of its own
 * @returns {{ status: 301 | 302, location: string } | null}
 */
function resolveSiteRedirect(snapshot, reqPath, locales, query) {
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

    let location = hit.to;
    const qs = query ? query.toString() : '';
    if (!hit.external && qs && !location.includes('?')) {
        const hashAt = location.indexOf('#');
        location = hashAt === -1 ? `${location}?${qs}` : `${location.slice(0, hashAt)}?${qs}${location.slice(hashAt)}`;
    }
    return { status: hit.status, location };
}

module.exports = { resolveSiteRedirect };
