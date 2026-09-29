// @typecheck
// Effective content: SiteDoc + PageDoc + locale overrides merged into the one
// payload the preview iframe and the public site render, with every stored
// Link resolved against the live page list. Reads either the draft
// (getEffective) or the last-published snapshot (getEffectivePublished).

const { SITE_DEFAULTS, DESIGN_DEFAULTS } = require('../../i18n/defaults/cmsDefaults');
const {
    isPlainObject, clone, deepMerge, mergeLocaleContent, normalizeSlug, sanitizeDesign,
} = require('./shared');
const { getProject } = require('./projects');
const { getPage } = require('./pages');
const {
    getDefaultLocale, getSiteLocaleOverride, getPageLocaleOverride,
} = require('./localeOverrides');
const { getPublishedSnapshot } = require('./publishing');

// ── Effective content (preview-time render) ──────────────────────────

/**
 * Resolve a stored Link object against the live page list. Returns
 *   { href, target?: '_blank', rel?, broken? }
 *
 * Note: `kind: 'app'` and `kind: 'page'` resolve relative to the website
 * being previewed — the renderer must interpret these inside the iframe's
 * own URL space, not Bee Flow's. (For a live site published at a custom
 * domain, these become real navigation; in the admin iframe, they stay
 * inside the preview route.)
 */
function resolveLink(link, pages) {
    if (!link || typeof link !== 'object') return { href: '#' };
    if (link.kind === 'external') {
        const out = { href: link.url || '#' };
        if (link.newTab) { out.target = '_blank'; out.rel = 'noopener noreferrer'; }
        return out;
    }
    if (link.kind === 'anchor') {
        return { href: `#${link.anchor || ''}` };
    }
    if (link.kind === 'app') {
        return { href: link.path || '/' };
    }
    if (link.kind === 'page') {
        const page = pages.find(p => p.id === link.pageId);
        if (!page) return { href: '#', broken: true };
        // The public site uses path-based routing: `/` for the homepage,
        // `/<slug>` for everything else. AppRoot in App.jsx routes any
        // non-reserved single-segment path into the marketing renderer.
        const base = page.isHomepage ? '/' : `/${encodeURIComponent(page.slug)}`;
        return { href: link.anchor ? `${base}#${link.anchor}` : base };
    }
    return { href: '#' };
}

function resolveLinksInTree(node, pages) {
    if (Array.isArray(node)) return node.map(n => resolveLinksInTree(n, pages));
    if (!isPlainObject(node)) return node;
    if (typeof node.kind === 'string' && ['page', 'external', 'anchor', 'app'].includes(node.kind)) {
        return resolveLink(node, pages);
    }
    const out = {};
    for (const [k, v] of Object.entries(node)) out[k] = resolveLinksInTree(v, pages);
    return out;
}

/**
 * Resolve the effective response for a preview request.
 *   siteId — the project being previewed
 *   slug   — the page slug, or null/'' for the homepage
 *   locale — requested locale
 *
 * Returns { found, page, header, footer, pages } where `page` is the
 * fully-merged page (block content already locale-merged, links resolved)
 * or null when no match. `pages` is the public sitemap (id+slug+title).
 */
async function getEffective(siteId, slug, locale) {
    return resolveEffective(siteId, slug, locale, {
        getSite:                () => getProject(siteId),
        getPage:                (pageId) => getPage(siteId, pageId),
        getSiteLocaleOverride:  (loc) => getSiteLocaleOverride(siteId, loc),
        getPageLocaleOverride:  (pageId, loc) => getPageLocaleOverride(siteId, pageId, loc),
    });
}

/**
 * Same as getEffective, but reads from the last-published snapshot
 * (cms_published_{siteId}). Returns null when no snapshot exists yet so
 * the caller can fall back to draft content (preserves the pre-publish
 * behavior for sites that have never been published).
 */
async function getEffectivePublished(siteId, slug, locale) {
    const snap = await getPublishedSnapshot(siteId);
    if (!snap || !isPlainObject(snap.site)) return null;
    const pages = isPlainObject(snap.pages) ? snap.pages : {};
    const siteOv = isPlainObject(snap.siteLocaleOverrides) ? snap.siteLocaleOverrides : {};
    const pageOv = isPlainObject(snap.pageLocaleOverrides) ? snap.pageLocaleOverrides : {};
    return resolveEffective(siteId, slug, locale, {
        getSite:                async () => snap.site,
        getPage:                async (pageId) => pages[pageId] || null,
        getSiteLocaleOverride:  async (loc) => siteOv[loc] || null,
        getPageLocaleOverride:  async (pageId, loc) => pageOv[pageId]?.[loc] || null,
    });
}

async function resolveEffective(siteId, slug, locale, ctx) {
    const site = await ctx.getSite();
    if (!site) return { found: false, page: null, header: null, footer: null, cookieBanner: null, announcement: null, pages: [], design: clone(DESIGN_DEFAULTS), analytics: null };

    const defaultLocale = await getDefaultLocale();
    const reqLocale = (locale || defaultLocale || 'en').toLowerCase().split('-')[0];

    // Design is global per site (no locale layer per call F).
    // sanitizeDesign also fills missing fields for sites that pre-date the
    // design system, so the renderer can rely on a complete shape.
    const design = sanitizeDesign(site.design);

    // Site-level analytics config (GA measurement id) — sanitized at write
    // time by setProject. Sites/snapshots that pre-date the field yield
    // null, which the public route treats as "no GA configured".
    const analytics = isPlainObject(site.analytics) ? site.analytics : null;

    const publicPages = site.pages.map(p => ({
        id: p.id, slug: p.slug, title: p.title, isHomepage: !!p.isHomepage,
    }));

    let entry = null;
    if (!slug) {
        // Three-layer fallback so the live site lands on the homepage even
        // if `homepageId` got nulled by an old migration or external edit:
        //   1. id-based lookup via site.homepageId (canonical)
        //   2. flag-based lookup via isHomepage (derived from homepageId on
        //      every save, but a safety net for stale data)
        //   3. first page in the array (last resort — same as before)
        entry = site.pages.find(p => p.id === site.homepageId)
             || site.pages.find(p => p.isHomepage)
             || site.pages[0]
             || null;
    } else {
        const norm = normalizeSlug(slug);
        entry = site.pages.find(p => p.slug === norm) || null;
    }

    const siteOverride = reqLocale && reqLocale !== defaultLocale
        ? await ctx.getSiteLocaleOverride(reqLocale)
        : null;
    let header = deepMerge(clone(SITE_DEFAULTS.header), site.header);
    let footer = deepMerge(clone(SITE_DEFAULTS.footer), site.footer);
    if (siteOverride) {
        // Locale chrome overrides are sparse text-only patches: merge by index
        // so nav/footer link structure (kind/url/style) stays owned by base.
        if (siteOverride.header) header = mergeLocaleContent(header, siteOverride.header);
        if (siteOverride.footer) footer = mergeLocaleContent(footer, siteOverride.footer);
    }
    header = resolveLinksInTree(header, site.pages);
    footer = resolveLinksInTree(footer, site.pages);
    // Cookie banner is global per site (no locale layer — text carries all
    // locales) and has no internal page-links, so no resolveLinksInTree.
    const cookieBanner = deepMerge(clone(SITE_DEFAULTS.cookieBanner), site.cookieBanner);
    const announcement = deepMerge(clone(SITE_DEFAULTS.announcement), site.announcement);

    if (!entry) {
        return { found: false, page: null, header, footer, cookieBanner, announcement, pages: publicPages, design, analytics };
    }

    const pageDoc = await ctx.getPage(entry.id);
    if (!pageDoc) {
        return { found: false, page: null, header, footer, cookieBanner, announcement, pages: publicPages, design, analytics };
    }

    let blocks = pageDoc.blocks.map(b => clone(b));
    // Fetched once and reused for block content + SEO translation below.
    const pageOverride = reqLocale !== defaultLocale
        ? await ctx.getPageLocaleOverride(entry.id, reqLocale)
        : null;
    if (pageOverride?.blocks) {
        blocks = blocks.map(b => {
            const ov = pageOverride.blocks[b.id];
            if (!ov) return b;
            return { ...b, content: mergeLocaleContent(b.content, ov.content || {}) };
        });
    }

    let title = pageDoc.title;
    if (siteOverride?.pageTitles?.[entry.id]) title = siteOverride.pageTitles[entry.id];

    // SEO meta is translatable too — merge the page override's `seo` patch.
    let seo = pageDoc.seo;
    if (pageOverride?.seo) seo = mergeLocaleContent(pageDoc.seo, pageOverride.seo);

    blocks = blocks.map(b => ({ ...b, content: resolveLinksInTree(b.content, site.pages) }));

    const page = {
        id: entry.id,
        slug: entry.slug,
        title,
        isHomepage: !!entry.isHomepage,
        hideHeader: !!entry.hideHeader,
        hideFooter: !!entry.hideFooter,
        noAnalytics: !!entry.noAnalytics,
        isNotFound: !!entry.isNotFound,
        seo,
        blocks,
    };
    return { found: true, page, header, footer, cookieBanner, announcement, pages: publicPages, design, analytics };
}

module.exports = {
    resolveLink, resolveLinksInTree, getEffective, getEffectivePublished, resolveEffective,
};
