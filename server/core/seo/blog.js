// @typecheck strict
/**
 * The server-rendered side of the blog: <head> (title, description, canonical,
 * Open Graph article tags, BlogPosting JSON-LD, the RSS alternate), the body
 * markup a crawler and a first paint get, the RSS feed and the sitemap entries.
 *
 * Everything here works from the `eff.blog` payload of stores/cms/blogEffective
 * — the same object the browser renders — so the server markup and the
 * hydrated page say the same thing. Every string is escaped on the way out;
 * a post body only ever reaches HTML through core/cms/blogMarkdown.
 */

'use strict';

const { esc, clamp, clampTitle } = require('./html');
const { buildHead, absolute, TITLE_MAX, DESC_MAX } = require('./head');
const { buildPublicPath, BLOG_BASE } = require('./publicPath');
const { renderPostMarkdown } = require('../cms/blogMarkdown');

const FEED_FILE = 'feed.xml';
const FEED_MAX_ITEMS = 30;

/** @typedef {import('../../stores/cms/shared').CmsDoc} CmsDoc */
/** @typedef {{ slug: string, label: string }} BlogTag */

/**
 * @param {string} template
 * @param {Record<string, string>} params
 */
function fmt(template, params) {
    return String(template || '').replace(/\{(\w+)\}/g, (_, k) => (params[k] ?? ''));
}

/**
 * @param {string} iso
 * @param {string | Intl.Locale | readonly (string | Intl.Locale)[]} locale
 */
function dateLabel(iso, locale) {
    const t = Date.parse(iso || '');
    if (!Number.isFinite(t)) return '';
    try {
        return new Intl.DateTimeFormat(locale || 'en', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' }).format(new Date(t));
    } catch (_) {
        return new Date(t).toISOString().slice(0, 10);
    }
}

/**
 * Path of the feed for a locale: /blog/feed.xml, /nl/blog/feed.xml.
 * @param {string | null} locale
 * @param {string} defaultLocale
 */
function feedPath(locale, defaultLocale) {
    return `${buildPublicPath(locale, BLOG_BASE, defaultLocale)}/${FEED_FILE}`;
}

/**
 * @param {string | null} locale
 * @param {string} slug
 * @param {string} defaultLocale
 */
function postPath(locale, slug, defaultLocale) {
    return buildPublicPath(locale, `${BLOG_BASE}/${slug}`, defaultLocale);
}

/**
 * @typedef {Object} IndexQueryArgs
 * @property {string} [tag]
 * @property {number | undefined} [page]
 */
/**
 * The blog's index page query string for paging / a tag filter.
 * @param {IndexQueryArgs} param0
 */
function indexQuery({ tag, page = undefined }) {
    const qs = new URLSearchParams();
    if (tag) qs.set('tag', tag);
    if (page && page > 1) qs.set('page', String(page));
    const s = qs.toString();
    return s ? `?${s}` : '';
}

/**
 * <head> for a blog URL.
 * @param {any} ctx  { origin, eff, locale, defaultLocale, locales, siteName }
 */
function buildBlogHead({ origin, eff, locale, defaultLocale, locales, siteName }) {
    const blog = eff.blog;
    const rss = `<link rel="alternate" type="application/rss+xml" title="${esc(`${siteName} — ${blog.title}`)}" href="${esc(`${origin}${feedPath(locale, defaultLocale)}`)}">`;
    const blogPath = buildPublicPath(locale, BLOG_BASE, defaultLocale);
    const atom = `<link rel="alternate" type="application/atom+xml" title="${esc(`${siteName} — ${blog.title}`)}" href="${esc(`${origin}${blogPath}/atom.xml`)}">`;
    const homePath = buildPublicPath(locale, '', defaultLocale);
    const home = blog.labels?.home || 'Home';

    if (blog.view === 'post' && blog.post) {
        const p = blog.post;
        const url = `${origin}${postPath(locale, p.slug, defaultLocale)}`;
        const title = clampTitle(eff.page.seo.metaTitle || p.title, TITLE_MAX, siteName);
        const description = clamp(eff.page.seo.metaDescription || p.excerpt || '', DESC_MAX);
        const image = absolute(origin, eff.page.seo.ogImage || p.coverImage || '');
        const posting = {
            '@type': 'BlogPosting',
            '@id': `${url}#article`,
            mainEntityOfPage: { '@id': `${url}#webpage` },
            headline: clamp(p.title, 110),
            ...(description ? { description } : {}),
            ...(image ? { image } : {}),
            ...(p.publishedAt ? { datePublished: p.publishedAt } : {}),
            ...((p.updatedAt || p.publishedAt) ? { dateModified: p.updatedAt || p.publishedAt } : {}),
            inLanguage: locale,
            // Free-text display name only — never an account, e-mail or profile link.
            ...(p.authorName ? { author: { '@type': 'Person', name: p.authorName } } : { author: { '@id': `${origin}/#organization` } }),
            publisher: { '@id': `${origin}/#organization` },
            ...(p.tags?.length ? { keywords: p.tags.map((/** @type {BlogTag} */ t) => t.label).join(', ') } : {}),
            isPartOf: { '@type': 'Blog', '@id': `${origin}${blogPath}#blog`, name: blog.title },
        };
        return buildHead({
            origin, slug: eff.page.slug, locale, defaultLocale, locales,
            page: { ...eff.page, seo: { ...eff.page.seo, metaTitle: title, metaDescription: description } },
            design: eff.design || {}, siteName,
            ogType: 'article',
            article: {
                publishedTime: p.publishedAt || '',
                modifiedTime: p.updatedAt || '',
                author: p.authorName || '',
                tags: (p.tags || []).map((/** @type {BlogTag} */ t) => t.label),
            },
            extraJsonLd: [posting],
            breadcrumbTrail: [
                { name: home, path: homePath },
                { name: blog.title, path: blogPath },
                { name: clamp(p.title, 80), path: postPath(locale, p.slug, defaultLocale) },
            ],
            extraLinks: [rss, atom],
        });
    }

    const blogNode = {
        '@type': 'Blog',
        '@id': `${origin}${blogPath}#blog`,
        name: blog.title,
        url: `${origin}${blogPath}`,
        inLanguage: locale,
        ...(blog.description ? { description: clamp(blog.description, DESC_MAX) } : {}),
        publisher: { '@id': `${origin}/#organization` },
        blogPost: (blog.posts || []).slice(0, 10).map((/** @type {CmsDoc} */ p) => ({
            '@type': 'BlogPosting',
            headline: clamp(p.title, 110),
            url: `${origin}${postPath(locale, p.slug, defaultLocale)}`,
            ...(p.publishedAt ? { datePublished: p.publishedAt } : {}),
        })),
    };
    return buildHead({
        origin, slug: BLOG_BASE, locale, defaultLocale, locales,
        page: eff.page, design: eff.design || {}, siteName,
        extraJsonLd: [blogNode],
        breadcrumbTrail: [{ name: home, path: homePath }, { name: blog.title, path: blogPath }],
        extraLinks: [rss, atom],
    });
}

/**
 * @param {CmsDoc} p
 * @param {CmsDoc} blog
 */
function postMetaLine(p, blog) {
    /** @type {string[]} */
    const bits = [];
    const date = dateLabel(p.publishedAt, blog.locale);
    if (date) bits.push(`<time datetime="${esc(p.publishedAt)}">${esc(date)}</time>`);
    if (p.authorName) bits.push(esc(fmt(blog.labels?.by || 'By {name}', { name: p.authorName })));
    if (p.readingMinutes) bits.push(esc(fmt(blog.labels?.min_read || '{n} min read', { n: p.readingMinutes })));
    return bits.length ? `<p class="label">${bits.join(' · ')}</p>` : '';
}

/**
 * The tag filter of the index: plain links, so a filtered list is a crawlable URL.
 * @param {CmsDoc} blog
 */
function tagNav(blog) {
    /**
     * @param {string} href
     * @param {boolean} active
     * @param {string} text
     */
    const link = (href, text, active) => `<a href="${esc(href)}"${active ? ' aria-current="page"' : ''}>${esc(text)}</a>`;
    const items = [
        link(blog.basePath, blog.labels?.all_posts || 'All posts', !blog.tag),
        ...blog.tags.map((/** @type {BlogTag} */ t) => link(`${blog.basePath}${indexQuery({ tag: t.slug })}`, t.label, blog.tag?.slug === t.slug)),
    ];
    return `<nav aria-label="${esc(blog.labels?.tags || 'Tags')}">${items.join(' · ')}</nav>`;
}

/**
 * The markup inside #root for a blog URL: real headings, links and the full
 * article text, in the prehydrate wrapper renderBlocks uses.
 * @param {CmsDoc} eff
 */
function renderBlogBody(eff) {
    const blog = eff.blog;
    if (!blog) return '';
    /** @type {string[]} */
    const out = [];
    if (blog.view === 'post' && blog.post) {
        const p = blog.post;
        out.push('<article>');
        out.push(`<p class="label"><a href="${esc(blog.basePath)}">${esc(blog.labels?.back_to_blog || blog.title)}</a></p>`);
        out.push(`<h1>${esc(p.title)}</h1>`);
        out.push(postMetaLine(p, blog));
        if (p.excerpt) out.push(`<p>${esc(p.excerpt)}</p>`);
        const cover = absolute('', p.coverImage || '');
        if (cover) out.push(`<p><img src="${esc(cover)}" alt="${esc(p.coverAlt || '')}"></p>`);
        out.push(renderPostMarkdown(p.body, {}));
        if (p.tags?.length) {
            out.push(`<p>${p.tags.map((/** @type {BlogTag} */ t) => `<a href="${esc(`${blog.basePath}${indexQuery({ tag: t.slug })}`)}">#${esc(t.label)}</a>`).join(' ')}</p>`);
        }
        out.push('</article>');
    } else {
        out.push(`<h1>${esc(blog.tag ? fmt(blog.labels?.tagged || 'Posts tagged “{tag}”', { tag: blog.tag.label }) : blog.title)}</h1>`);
        if (blog.description && !blog.tag) out.push(`<p>${esc(blog.description)}</p>`);
        if (blog.tags?.length) out.push(tagNav(blog));
        if (!blog.posts?.length) out.push(`<p>${esc(blog.labels?.no_posts || 'No posts yet.')}</p>`);
        for (const p of blog.posts || []) {
            const href = `${blog.basePath}/${encodeURIComponent(p.slug)}`;
            out.push(`<section data-block="blog-post">`);
            out.push(`<h2><a href="${esc(href)}">${esc(p.title)}</a></h2>`);
            out.push(postMetaLine(p, blog));
            if (p.excerpt) out.push(`<p>${esc(p.excerpt)}</p>`);
            out.push('</section>');
        }
        /** @type {string[]} */
        const nav = [];
        if (blog.page > 1) nav.push(`<a href="${esc(`${blog.basePath}${indexQuery({ tag: blog.tag?.slug, page: blog.page - 1 })}`)}">${esc(blog.labels?.newer || 'Newer posts')}</a>`);
        if (blog.page < blog.pageCount) nav.push(`<a href="${esc(`${blog.basePath}${indexQuery({ tag: blog.tag?.slug, page: blog.page + 1 })}`)}">${esc(blog.labels?.older || 'Older posts')}</a>`);
        if (nav.length) out.push(`<p>${nav.join(' · ')}</p>`);
    }
    return `<div class="marketing-root cms-prehydrate">\n<div class="container">\n${out.filter(Boolean).join('\n')}\n</div>\n</div>`;
}

/**
 * @param {string} iso
 */
function rfc822(iso) {
    const t = Date.parse(iso || '');
    return Number.isFinite(t) ? new Date(t).toUTCString() : '';
}

/**
 * XML 1.0 forbids most control characters even when escaped.
 * @param {string} v
 */
function xmlText(v) {
    return esc(String(v ?? '').replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F￾￿]/g, ''));
}

/**
 * RSS 2.0 for the newest posts of one locale.
 * @param {any[]} posts summaries WITH body (getLatestPublishedPosts withBody)
 * @param {any} opts { origin, siteName, title, description, locale, defaultLocale, lastBuildDate }
 */
function buildFeed(posts, { origin, siteName, title, description, locale, defaultLocale, lastBuildDate }) {
    const self = `${origin}${feedPath(locale, defaultLocale)}`;
    const link = `${origin}${buildPublicPath(locale, BLOG_BASE, defaultLocale)}`;
    const items = (posts || []).slice(0, FEED_MAX_ITEMS).map((p) => {
        const url = `${origin}${postPath(locale, p.slug, defaultLocale)}`;
        const html = renderPostMarkdown(p.body, { origin });
        const cover = p.coverImage ? absolute(origin, p.coverImage) : '';
        const content = `${cover ? `<p><img src="${esc(cover)}" alt="${esc(p.coverAlt || '')}"></p>` : ''}${html}`;
        return [
            '    <item>',
            `      <title>${xmlText(p.title)}</title>`,
            `      <link>${xmlText(url)}</link>`,
            `      <guid isPermaLink="true">${xmlText(url)}</guid>`,
            p.publishedAt ? `      <pubDate>${xmlText(rfc822(p.publishedAt))}</pubDate>` : '',
            p.authorName ? `      <dc:creator>${xmlText(p.authorName)}</dc:creator>` : '',
            ...(p.tags || []).map((/** @type {BlogTag} */ t) => `      <category>${xmlText(t.label)}</category>`),
            p.excerpt ? `      <description>${xmlText(p.excerpt)}</description>` : '',
            `      <content:encoded>${xmlText(content)}</content:encoded>`,
            '    </item>',
        ].filter(Boolean).join('\n');
    });
    return [
        '<?xml version="1.0" encoding="UTF-8"?>',
        '<rss version="2.0" xmlns:atom="http://www.w3.org/2005/Atom" xmlns:content="http://purl.org/rss/1.0/modules/content/" xmlns:dc="http://purl.org/dc/elements/1.1/">',
        '  <channel>',
        `    <title>${xmlText(`${siteName} — ${title}`)}</title>`,
        `    <link>${xmlText(link)}</link>`,
        `    <atom:link href="${xmlText(self)}" rel="self" type="application/rss+xml"/>`,
        `    <description>${xmlText(description || title)}</description>`,
        `    <language>${xmlText(locale)}</language>`,
        lastBuildDate ? `    <lastBuildDate>${xmlText(rfc822(lastBuildDate))}</lastBuildDate>` : '',
        ...items,
        '  </channel>',
        '</rss>',
        '',
    ].filter(Boolean).join('\n');
}

/**
 * Sitemap entries for the blog, in the shape buildSitemap takes:
 * the index (when there are posts) and every visible, indexable post, each
 * advertised only in the locales it is translated into.
 *
 * @param {{ posts: CmsDoc[], overridesLocales: { index: string[], byPost: Record<string, string[]> },
 *   lastmod?: string }} params
 */
function blogSitemapEntries({ posts, overridesLocales, lastmod }) {
    if (!posts.length) return [];
    const newest = posts.reduce((/** @type {string} */ m, p) => (p.updatedAt && p.updatedAt > m ? p.updatedAt : m), lastmod || '');
    return [
        { slug: BLOG_BASE, seo: {}, updatedAt: newest || lastmod, locales: overridesLocales.index },
        ...posts
            .filter(p => !p.seo?.noIndex)
            .map(p => ({
                slug: `${BLOG_BASE}/${p.slug}`,
                seo: p.seo || {},
                updatedAt: p.updatedAt || p.publishedAt || lastmod,
                locales: overridesLocales.byPost[p.id],
            })),
    ];
}

module.exports = {
    FEED_FILE, FEED_MAX_ITEMS, xmlText, buildBlogHead, renderBlogBody, buildFeed, blogSitemapEntries, feedPath, postPath, indexQuery, dateLabel,
};
