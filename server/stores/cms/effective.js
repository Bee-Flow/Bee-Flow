// @typecheck
// Effective content: SiteDoc + PageDoc + locale overrides merged into the one
// payload the preview iframe and the public site render, with every stored
// Link resolved against the live page list. Reads either the draft
// (getEffective) or the last-published snapshot (getEffectivePublished).

const { SITE_DEFAULTS, DESIGN_DEFAULTS } = require('../../i18n/defaults/cmsDefaults');
const {
    isPlainObject, clone, deepMerge, mergeLocaleContent, normalizeStoredSlug, sanitizeDesign,
} = require('./shared');
const { getProject } = require('./projects');
const { getPage } = require('./pages');
const {
    getDefaultLocale, getSiteLocaleOverride, getPageLocaleOverride,
} = require('./localeOverrides');
const { getPublishedSnapshot } = require('./publishing');
const { cleanOverrideMedia, applyOverrideMedia } = require('./localeMedia');
const { LOCALE_PREFIXES } = require('./slugRules');

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
 *
 * `prefix` is the URL prefix of the page's language ('/nl', or '' for the
 * default language): a Dutch page links to the Dutch version of the target,
 * so a visitor who clicks on stays in Dutch and a shared link is Dutch too.
 * @param {StoredLink | null | undefined} link
 * @param {Array<{ id: string, slug: string, isHomepage?: boolean }>} pages
 * @param {string} [prefix]
 */
function resolveLink(link, pages, prefix = '') {
    if (!link || typeof link !== 'object') return { href: '#' };
    if (link.kind === 'external') {
        const out = { href: localizePath(link.url || '#', prefix, pages) };
        if (link.newTab) { out.target = '_blank'; out.rel = 'noopener noreferrer'; }
        return out;
    }
    if (link.kind === 'anchor') {
        return { href: `#${link.anchor || ''}` };
    }
    if (link.kind === 'app') {
        return { href: link.path || '/' };
    }
    if (link.kind === 'page') return pageHref(link, pages, prefix);
    return { href: '#' };
}

/**
 * A link to a page of the site. The public site uses path-based routing: `/`
 * for the homepage, `/<slug>` for everything else, each behind the language
 * prefix. AppRoot in App.jsx routes any non-reserved single-segment path into
 * the marketing renderer.
 * @param {StoredLink} link
 * @param {Array<{ id: string, slug: string, isHomepage?: boolean }>} pages
 * @param {string} prefix
 */
function pageHref(link, pages, prefix) {
    const page = pages.find(p => p.id === link.pageId);
    if (!page) return { href: '#', broken: true };
    const base = page.isHomepage ? (prefix || '/') : `${prefix}/${encodeURIComponent(page.slug)}`;
    return { href: link.anchor ? `${base}#${link.anchor}` : base };
}

/**
 * The URL prefix of a language on the public site: '/nl' for a language with
 * its own URL space, '' for the default language and for a language the
 * router does not prefix (a regional tag falls back to its base language).
 * @param {string} locale
 * @param {string} defaultLocale
 */
function localePathPrefix(locale, defaultLocale) {
    if (!locale || locale === defaultLocale) return '';
    if (LOCALE_PREFIXES.has(locale)) return `/${locale}`;
    const base = locale.split('-')[0];
    return base !== defaultLocale && LOCALE_PREFIXES.has(base) ? `/${base}` : '';
}

/**
 * Put a site path into the page's language: '/contact' becomes '/nl/contact'
 * and '/' becomes '/nl'. Only a path to the homepage or to a page of this site
 * moves; '/app', '/api', an asset, a path that already carries the prefix and
 * anything that is not a site path (https:, mailto:, '#...') stay as they are.
 * @param {string} href
 * @param {string} prefix
 * @param {Array<{ slug: string }>} pages
 */
function localizePath(href, prefix, pages) {
    if (!prefix || typeof href !== 'string' || !href.startsWith('/') || href.startsWith('//')) return href;
    const m = /^([^?#]*)(.*)$/.exec(href);
    const path = m ? m[1] : href;
    const tail = m ? m[2] : '';
    if (path === '/') return `${prefix}${tail}`;
    const first = path.split('/')[1];
    if (`/${first}` === prefix) return href;
    if (!pages.some(p => p.slug === first)) return href;
    return `${prefix}${path}${tail}`;
}

// Block fields that hold a bare internal path instead of a Link object
// (a features card's whole-card link).
const RAW_PATH_KEYS = new Set(['cardUrl']);

/**
 * @param {unknown} node
 * @param {Array<{ id: string, slug: string, isHomepage?: boolean }>} pages
 * @param {string} [prefix] see resolveLink
 * @returns {unknown}
 */
function resolveLinksInTree(node, pages, prefix = '') {
    if (Array.isArray(node)) return node.map(n => resolveLinksInTree(n, pages, prefix));
    if (!isPlainObject(node)) return node;
    const obj = /** @type {Record<string, unknown>} */ (node);
    if (typeof obj.kind === 'string' && ['page', 'external', 'anchor', 'app'].includes(obj.kind)) {
        return resolveLink(/** @type {StoredLink} */ (obj), pages, prefix);
    }
    /** @type {Record<string, unknown>} */
    const out = {};
    for (const [k, v] of Object.entries(obj)) {
        out[k] = RAW_PATH_KEYS.has(k) && typeof v === 'string'
            ? localizePath(v, prefix, pages)
            : resolveLinksInTree(v, pages, prefix);
    }
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
 * @param {string} siteId
 * @param {string} locale
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
 * @param {string} siteId
 * @param {string} locale
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

/**
 * @param {string} siteId
 * @param {string | undefined} locale
 */
async function resolveEffective(siteId, slug, locale, ctx) {
    const site = await ctx.getSite();
    if (!site) return { found: false, page: null, header: null, footer: null, cookieBanner: null, announcement: null, pages: [], design: clone(DESIGN_DEFAULTS), analytics: null };

    const defaultLocale = await getDefaultLocale();
    // The full tag ("pt-br") is the key overrides are stored under; a regional
    // request falls back to its base language ("pt") when no exact override exists.
    const reqLocale = (locale || defaultLocale || 'en').toLowerCase();
    const baseOf = (/** @type {string} */ loc) => loc.split('-')[0];
    const withBaseFallback = async (/** @type {(loc: string) => Promise<any>} */ read) =>
        (await read(reqLocale)) || (baseOf(reqLocale) !== reqLocale ? read(baseOf(reqLocale)) : null);

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
        const norm = normalizeStoredSlug(slug);
        entry = site.pages.find(p => p.slug === norm) || null;
    }

    const siteOverride = reqLocale && reqLocale !== defaultLocale
        ? await withBaseFallback((loc) => ctx.getSiteLocaleOverride(loc))
        : null;
    let header = deepMerge(clone(SITE_DEFAULTS.header), site.header);
    let footer = deepMerge(clone(SITE_DEFAULTS.footer), site.footer);
    if (siteOverride) {
        // Locale chrome overrides are sparse text-only patches: merge by index
        // so nav/footer link structure (kind/url/style) stays owned by base.
        if (siteOverride.header) header = mergeLocaleContent(header, cleanOverrideMedia(siteOverride.header));
        if (siteOverride.footer) footer = mergeLocaleContent(footer, cleanOverrideMedia(siteOverride.footer));
    }
    // Links point into the page's own language (see resolveLink).
    const prefix = localePathPrefix(reqLocale, defaultLocale);
    header = resolveLinksInTree(header, site.pages, prefix);
    footer = resolveLinksInTree(footer, site.pages, prefix);
    if (isPlainObject(header.logo) && typeof header.logo.url === 'string') {
        header.logo = { ...header.logo, url: localizePath(header.logo.url, prefix, site.pages) };
    }
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
        ? await withBaseFallback((loc) => ctx.getPageLocaleOverride(entry.id, loc))
        : null;
    if (pageOverride?.blocks) {
        blocks = blocks.map(b => {
            const ov = pageOverride.blocks[b.id];
            if (!ov) return b;
            // Text first, then the media addresses (re-validated here: a snapshot or an
            // import may hold an override that predates the write-time check).
            const ovContent = cleanOverrideMedia(ov.content || {});
            return { ...b, content: applyOverrideMedia(mergeLocaleContent(b.content, ovContent), ovContent) };
        });
    }

    let title = pageDoc.title;
    if (siteOverride?.pageTitles?.[entry.id]) title = siteOverride.pageTitles[entry.id];

    // SEO meta is translatable too — merge the page override's `seo` patch.
    let seo = pageDoc.seo;
    if (pageOverride?.seo) seo = mergeLocaleContent(pageDoc.seo, pageOverride.seo);

    blocks = blocks.map(b => ({ ...b, content: resolveLinksInTree(b.content, site.pages, prefix) }));

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
    resolveLink, resolveLinksInTree, localePathPrefix, localizePath, getEffective, getEffectivePublished, resolveEffective,
};

/** @typedef {{ kind?: string, url?: string, newTab?: boolean, anchor?: string, path?: string, pageId?: string }} StoredLink a Link as the CMS stores it */
/** @typedef {{ getSite: () => Promise<import('./shared').SiteDoc | null>, getPage: (pageId: string) => Promise<import('./shared').PageDoc | null>, getSiteLocaleOverride: (loc: string) => Promise<import('./shared').CmsDoc | null>, getPageLocaleOverride: (pageId: string, loc: string) => Promise<import('./shared').CmsDoc | null> }} ResolveCtx */
