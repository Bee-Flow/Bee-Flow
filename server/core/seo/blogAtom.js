// @typecheck strict
/**
 * Atom 1.0 twin of the blog's RSS feed (core/seo/blog.buildFeed): same posts,
 * same escaping, for readers and tools that prefer Atom. Every string goes
 * through xmlText; a post body only reaches the feed as escaped HTML produced
 * by core/cms/blogMarkdown.
 */

'use strict';

const { buildPublicPath, BLOG_BASE } = require('./publicPath');
const { absolute } = require('./head');
const { esc } = require('./html');
const { renderPostMarkdown } = require('../cms/blogMarkdown');
const { xmlText, postPath, FEED_MAX_ITEMS } = require('./blog');

const ATOM_FILE = 'atom.xml';

/**
 * Path of the Atom feed for a locale: /blog/atom.xml, /nl/blog/atom.xml.
 * @param {string | null} locale
 * @param {string} defaultLocale
 */
function atomPath(locale, defaultLocale) {
    return `${buildPublicPath(locale, BLOG_BASE, defaultLocale)}/${ATOM_FILE}`;
}

/** @param {string|null|undefined} iso @param {string} fallback */
function isoOr(iso, fallback) {
    const t = Date.parse(iso || '');
    return Number.isFinite(t) ? new Date(t).toISOString() : fallback;
}

/**
 * @param {any[]} posts summaries WITH body (getLatestPublishedPosts withBody)
 * @param {{ origin: string, siteName: string, title: string, description?: string, locale: string, defaultLocale: string,
 *   lastBuildDate?: string | null }} opts
 */
function buildAtomFeed(posts, { origin, siteName, title, description, locale, defaultLocale, lastBuildDate }) {
    const self = `${origin}${atomPath(locale, defaultLocale)}`;
    const link = `${origin}${buildPublicPath(locale, BLOG_BASE, defaultLocale)}`;
    const list = (posts || []).slice(0, FEED_MAX_ITEMS);
    const newest = list.reduce((m, p) => (isoOr(p.updatedAt || p.publishedAt, '') > m ? isoOr(p.updatedAt || p.publishedAt, '') : m), '');
    const updated = isoOr(lastBuildDate, newest || new Date(0).toISOString());
    const entries = list.map((p) => {
        const url = `${origin}${postPath(locale, p.slug, defaultLocale)}`;
        const cover = p.coverImage ? absolute(origin, p.coverImage) : '';
        const content = `${cover ? `<p><img src="${esc(cover)}" alt="${esc(p.coverAlt || '')}"></p>` : ''}${renderPostMarkdown(p.body, { origin })}`;
        return [
            '  <entry>',
            `    <id>${xmlText(url)}</id>`,
            `    <title>${xmlText(p.title)}</title>`,
            `    <link rel="alternate" type="text/html" href="${xmlText(url)}"/>`,
            `    <updated>${xmlText(isoOr(p.updatedAt || p.publishedAt, updated))}</updated>`,
            p.publishedAt ? `    <published>${xmlText(isoOr(p.publishedAt, updated))}</published>` : '',
            `    <author><name>${xmlText(p.authorName || siteName)}</name></author>`,
            ...(p.tags || []).map((/** @type {import('./blog').BlogTag} */ t) => `    <category term="${xmlText(t.label)}"/>`),
            p.excerpt ? `    <summary type="text">${xmlText(p.excerpt)}</summary>` : '',
            `    <content type="html">${xmlText(content)}</content>`,
            '  </entry>',
        ].filter(Boolean).join('\n');
    });
    return [
        '<?xml version="1.0" encoding="UTF-8"?>',
        `<feed xmlns="http://www.w3.org/2005/Atom" xml:lang="${xmlText(locale)}">`,
        `  <id>${xmlText(self)}</id>`,
        `  <title>${xmlText(`${siteName} — ${title}`)}</title>`,
        description ? `  <subtitle>${xmlText(description)}</subtitle>` : '',
        `  <link rel="self" type="application/atom+xml" href="${xmlText(self)}"/>`,
        `  <link rel="alternate" type="text/html" href="${xmlText(link)}"/>`,
        `  <updated>${xmlText(updated)}</updated>`,
        ...entries,
        '</feed>',
        '',
    ].filter(Boolean).join('\n');
}

module.exports = { ATOM_FILE, atomPath, buildAtomFeed };
