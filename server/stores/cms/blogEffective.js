// @typecheck
// The blog as visitors see it: the index (paginated, optional tag filter) and
// a single post, merged with the site chrome into the same `eff` payload
// shape pages use (so synthesizeLegacyContent, the server render and the
// screenshot tool treat a blog URL like any other page), plus a `blog` key.
//
// Two sources, like effective.js:
//   published → the published snapshot; only posts whose publishedAt has
//               passed (posts.isPostVisible), so scheduling needs no job
//   draft     → the live store, for the admin preview and draft screenshots;
//               a single post is shown whatever its status, the index lists
//               what visitors would see after the next publish

const { clone, isPlainObject, mergeLocaleContent, sanitizeBlogSettings } = require('./shared');
const { resolveEffective } = require('./effective');
const { getProject } = require('./projects');
const { getPage } = require('./pages');
const { getDefaultLocale, getSiteLocaleOverride, getPageLocaleOverride } = require('./localeOverrides');
const { getPublishedSnapshot } = require('./publishing');
const {
    listPosts, collectPostLocaleOverrides, isPostVisible, sortPosts,
    normalizePostSlug, tagSlug, hasPostTranslation,
} = require('./posts');
const { deriveExcerpt, readingMinutes } = require('./postText');

const BLOG_BASE = 'blog';
const LABEL_PREFIX = 'cms_blog.public.';

/**
 * Visitor-facing labels for one locale, from the GUI dictionary (en defaults + Dutch catalogue).
 * @param {string} locale
 */
async function blogLabels(locale) {
    /** @type {Record<string, string>} */
    let strings;
    try {
        strings = await require('../languageStore').getEffectiveGUIStrings(locale);
    } catch (_) {
        strings = require('../../i18n/defaults/en').GUI_DEFAULTS;
    }
    /** @type {Record<string, string>} */
    const out = {};
    for (const [k, v] of Object.entries(strings || {})) {
        if (k.startsWith(LABEL_PREFIX) && typeof v === 'string') out[k.substring(LABEL_PREFIX.length)] = v;
    }
    return out;
}

function pickLocaleText(map, locale, defaultLocale) {
    if (!isPlainObject(map)) return '';
    return (typeof map[locale] === 'string' && map[locale].trim()) ? map[locale]
        : (typeof map[defaultLocale] === 'string' ? map[defaultLocale] : '');
}

/** A post with one locale's text merged in (empty strings fall back to the source). */
function localizePost(post, override) {
    if (!override) return post;
    const merged = mergeLocaleContent(
        { title: post.title, excerpt: post.excerpt, body: post.body, coverAlt: post.coverAlt, seo: post.seo },
        override,
    );
    return { ...post, ...merged };
}

/**
 * @param {string[]} tags
 */
function tagObjects(tags) {
    return (Array.isArray(tags) ? tags : []).map(label => ({ slug: tagSlug(label), label })).filter(t => t.slug);
}

function summarize(post) {
    return {
        id: post.id,
        slug: post.slug,
        title: post.title,
        excerpt: post.excerpt || deriveExcerpt(post.body),
        coverImage: post.coverImage || '',
        coverAlt: post.coverAlt || '',
        authorName: post.authorName || '',
        tags: tagObjects(post.tags),
        publishedAt: post.publishedAt || null,
        updatedAt: post.updatedAt || null,
        readingMinutes: readingMinutes(post.body),
    };
}

/** Locales a post may be advertised in: the default plus real translations. */
function localesForPost(overrides, postId, defaultLocale, siteLocales) {
    const byLocale = overrides?.[postId] || {};
    return [defaultLocale, ...siteLocales.filter(l => l !== defaultLocale && hasPostTranslation(byLocale[l]))];
}

/**
 * @param {string} siteId
 * @param {{ state?: 'published'|'draft', view?: 'index'|'post', postSlug?: string, tag?: string,
 *           page?: number | string, locale?: string, siteLocales?: string[], now?: number,
 *           draftPost?: any }} opts
 *   draftPost — an unsaved post to preview instead of the stored one (admin preview)
 * @returns {Promise<any|null>} null when there is no published snapshot (state published)
 */
async function getEffectiveBlog(siteId, opts = {}) {
    const state = opts.state === 'draft' ? 'draft' : 'published';
    const view = opts.view === 'post' ? 'post' : 'index';
    const now = Number.isFinite(opts.now) ? opts.now : Date.now();

    let ctx;
    let allPosts;
    let overrides;
    if (state === 'published') {
        const snap = await getPublishedSnapshot(siteId);
        if (!snap || !isPlainObject(snap.site)) return null;
        const pages = isPlainObject(snap.pages) ? snap.pages : {};
        const siteOv = isPlainObject(snap.siteLocaleOverrides) ? snap.siteLocaleOverrides : {};
        const pageOv = isPlainObject(snap.pageLocaleOverrides) ? snap.pageLocaleOverrides : {};
        ctx = {
            getSite: async () => snap.site,
            getPage: async (pageId) => pages[pageId] || null,
            getSiteLocaleOverride: async (loc) => siteOv[loc] || null,
            getPageLocaleOverride: async (pageId, loc) => pageOv[pageId]?.[loc] || null,
        };
        allPosts = sortPosts(Object.values(isPlainObject(snap.posts) ? snap.posts : {}));
        overrides = isPlainObject(snap.postLocaleOverrides) ? snap.postLocaleOverrides : {};
    } else {
        ctx = {
            getSite: () => getProject(siteId),
            getPage: (pageId) => getPage(siteId, pageId),
            getSiteLocaleOverride: (loc) => getSiteLocaleOverride(siteId, loc),
            getPageLocaleOverride: (pageId, loc) => getPageLocaleOverride(siteId, pageId, loc),
        };
        allPosts = await listPosts(siteId);
        overrides = await collectPostLocaleOverrides(siteId);
    }

    // Chrome (header, footer, banners, design) exactly as the homepage gets it.
    const base = await resolveEffective(siteId, null, opts.locale, ctx);
    const site = await ctx.getSite();
    if (!site) return { ...base, found: false, page: null, blog: null };

    const defaultLocale = await getDefaultLocale();
    const locale = String(opts.locale || defaultLocale || 'en').toLowerCase().split('-')[0];
    const siteLocales = Array.isArray(opts.siteLocales) && opts.siteLocales.length ? opts.siteLocales : [defaultLocale];
    const settings = sanitizeBlogSettings(site.blog);
    const labels = await blogLabels(locale);
    const translate = (post) => (locale !== defaultLocale ? localizePost(post, overrides[post.id]?.[locale] || null) : post);
    const visible = allPosts.filter(p => isPostVisible(p, now));
    const localePrefix = locale !== defaultLocale ? `/${locale}` : '';

    const blogTitle = pickLocaleText(settings.title, locale, defaultLocale) || labels.title || 'Blog';
    const blogDescription = pickLocaleText(settings.description, locale, defaultLocale);
    const common = {
        locale,
        defaultLocale,
        basePath: `${localePrefix}/${BLOG_BASE}`,
        title: blogTitle,
        description: blogDescription,
        labels,
    };

    if (view === 'post') {
        const wanted = normalizePostSlug(opts.postSlug);
        let post = null;
        if (opts.draftPost && isPlainObject(opts.draftPost)) post = opts.draftPost;
        else if (state === 'draft') post = allPosts.find(p => p.slug === wanted) || null;
        else post = visible.find(p => p.slug === wanted) || null;
        if (!post) {
            return { ...base, found: false, page: null, blog: { ...common, view: 'post', post: null } };
        }
        const localized = translate(post);
        const ordered = state === 'draft' && !visible.some(p => p.id === post.id) ? [] : visible;
        const at = ordered.findIndex(p => p.id === post.id);
        const newer = at > 0 ? summarize(translate(ordered[at - 1])) : null;
        const older = at >= 0 && at < ordered.length - 1 ? summarize(translate(ordered[at + 1])) : null;
        const full = {
            ...summarize(localized),
            body: localized.body || '',
            status: post.status,
            seo: clone(localized.seo || {}),
        };
        return {
            ...base,
            found: true,
            page: {
                id: null,
                slug: `${BLOG_BASE}/${post.slug}`,
                title: full.title,
                isHomepage: false,
                hideHeader: false,
                hideFooter: false,
                noAnalytics: false,
                isNotFound: false,
                seo: {
                    metaTitle: full.seo.metaTitle || '',
                    metaDescription: full.seo.metaDescription || full.excerpt || '',
                    ogImage: full.seo.ogImage || full.coverImage || '',
                    noIndex: !!full.seo.noIndex,
                },
                blocks: [],
            },
            blog: {
                ...common,
                view: 'post',
                post: full,
                newer,
                older,
                locales: localesForPost(overrides, post.id, defaultLocale, siteLocales),
            },
        };
    }

    // Index.
    const wantedTag = tagSlug(opts.tag || '');
    const tagCounts = new Map();
    for (const p of visible) {
        for (const t of tagObjects(p.tags)) {
            const cur = tagCounts.get(t.slug);
            tagCounts.set(t.slug, { slug: t.slug, label: cur?.label || t.label, count: (cur?.count || 0) + 1 });
        }
    }
    const filtered = wantedTag ? visible.filter(p => tagObjects(p.tags).some(t => t.slug === wantedTag)) : visible;
    const perPage = settings.postsPerPage;
    const pageCount = Math.max(1, Math.ceil(filtered.length / perPage));
    const pageNo = Math.min(pageCount, Math.max(1, Number.parseInt(String(opts.page || 1), 10) || 1));
    const slice = filtered.slice((pageNo - 1) * perPage, pageNo * perPage);
    const tag = wantedTag ? (tagCounts.get(wantedTag) || null) : null;
    return {
        ...base,
        // An unknown tag is still an answer (an empty list), not a 404 — but it
        // must not be indexed, which the head builder reads from noIndex.
        found: true,
        page: {
            id: null,
            slug: BLOG_BASE,
            title: tag ? `${blogTitle} · ${tag.label}` : blogTitle,
            isHomepage: false,
            hideHeader: false,
            hideFooter: false,
            noAnalytics: false,
            isNotFound: false,
            seo: {
                metaTitle: '',
                metaDescription: blogDescription,
                ogImage: '',
                // Filtered and paged views are navigation, not content: keep the
                // canonical first page in the index only (and an empty blog out).
                noIndex: !!wantedTag || pageNo > 1 || visible.length === 0,
            },
            blocks: [],
        },
        blog: {
            ...common,
            view: 'index',
            posts: slice.map(p => summarize(translate(p))),
            page: pageNo,
            pageCount,
            total: filtered.length,
            tag: wantedTag ? (tag || { slug: wantedTag, label: wantedTag, count: 0 }) : null,
            tags: [...tagCounts.values()].sort((a, b) => b.count - a.count || a.label.localeCompare(b.label)).slice(0, 30),
            // The index is advertised in a language once at least one visible
            // post is translated into it (same rule as hreflang for pages).
            locales: [defaultLocale, ...siteLocales.filter(l => l !== defaultLocale
                && visible.some(p => hasPostTranslation(overrides[p.id]?.[l])))],
        },
    };
}

/**
 * The newest visible posts of the live published site, for the "latest posts"
 * block and the feed. Summaries only (no body unless `withBody`).
 *
 * @param {string} siteId
 * @param {{ locale?: string, limit?: number, tag?: string, now?: number, withBody?: boolean }} [opts]
 */
async function getLatestPublishedPosts(siteId, { locale, limit = 3, tag = '', now = Date.now(), withBody = false } = {}) {
    const snap = await getPublishedSnapshot(siteId);
    if (!snap) return { posts: [], locale: locale || null };
    const defaultLocale = await getDefaultLocale();
    const loc = String(locale || defaultLocale).toLowerCase().split('-')[0];
    const overrides = isPlainObject(snap.postLocaleOverrides) ? snap.postLocaleOverrides : {};
    const wantedTag = tagSlug(tag || '');
    const cap = Math.min(50, Math.max(1, Number.parseInt(String(limit), 10) || 3));
    const posts = sortPosts(Object.values(isPlainObject(snap.posts) ? snap.posts : {}))
        .filter(p => isPostVisible(p, now))
        .filter(p => !wantedTag || tagObjects(p.tags).some(t => t.slug === wantedTag))
        .slice(0, cap)
        .map(p => (loc !== defaultLocale ? localizePost(p, overrides[p.id]?.[loc] || null) : p))
        .map(p => (withBody ? { ...summarize(p), body: p.body || '', seo: p.seo || {} } : summarize(p)));
    return { posts, locale: loc, defaultLocale, site: snap.site, publishedAt: snap.publishedAt || null, overrides };
}

module.exports = {
    BLOG_BASE, getEffectiveBlog, getLatestPublishedPosts, blogLabels, localizePost, summarize,
    localesForPost, tagObjects,
};
