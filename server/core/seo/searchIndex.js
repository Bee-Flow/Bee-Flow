// @typecheck
/**
 * The site's client-side search index: one small JSON document of the pages,
 * blog posts and integrations visitors can already reach, built ONLY from the
 * published snapshot (never a draft, never a hidden or noindex page, never a
 * scheduled post before its date). The browser downloads it once and filters
 * locally, so a query never leaves the visitor's device.
 *
 * Entry: { k: 'page'|'post'|'integration', t: title, d: description, u: path, g: [tag labels] }.
 */

'use strict';

const { clamp } = require('./html');
const { buildPublicPath, BLOG_BASE } = require('./publicPath');
const { hasTranslation } = require('./locales');
const { detailPath } = require('./integrationsDirectory');
const { localesForPost } = require('../../stores/cms/blogEffective');

const MAX_ENTRIES = 300;
const TITLE_MAX = 120;
const DESC_MAX = 200;

/** @param {unknown} v */
function text(v) {
    return typeof v === 'string' ? v.trim() : '';
}

/**
 * @param {object} p
 * @param {any} p.snapshot  the published snapshot
 * @param {Array<{id: string, slug: string, title: string, excerpt?: string, tags?: Array<{label: string}>}>} p.posts visible posts, already localized
 * @param {Array<{id: string, title: string, description: string}>} p.integrations
 * @param {string} p.locale
 * @param {string} p.defaultLocale
 * @param {string[]} [p.locales] every locale the site publishes (default first)
 * @returns {{ locale: string, entries: Array<{k: string, t: string, d: string, u: string, g: string[]}> }}
 */
function buildSearchIndex({ snapshot, posts, integrations, locale, defaultLocale, locales = [defaultLocale] }) {
    /** @type {Array<{k: string, t: string, d: string, u: string, g: string[]}>} */
    const entries = [];
    const site = snapshot?.site || {};
    const pageTitles = snapshot?.siteLocaleOverrides?.[locale]?.pageTitles || {};
    for (const entry of site.pages || []) {
        const doc = snapshot?.pages?.[entry.id];
        if (!doc || entry.isNotFound || doc.seo?.noIndex) continue;
        const override = locale !== defaultLocale ? snapshot?.pageLocaleOverrides?.[entry.id]?.[locale] : null;
        // A page with no real translation is not offered in that language.
        if (locale !== defaultLocale && !hasTranslation(override)) continue;
        const seo = { ...(doc.seo || {}), ...Object.fromEntries(Object.entries(override?.seo || {}).filter(([, v]) => text(v))) };
        const title = text(pageTitles[entry.id]) || text(doc.title) || text(entry.title);
        if (!title) continue;
        entries.push({
            k: 'page',
            t: clamp(title, TITLE_MAX),
            d: clamp(text(seo.metaDescription), DESC_MAX),
            u: buildPublicPath(locale, entry.isHomepage ? '' : entry.slug, defaultLocale),
            g: [],
        });
    }
    const overrides = snapshot?.postLocaleOverrides || {};
    for (const p of posts) {
        // Same gates as the sitemap: the stored post's seo decides noIndex, and a
        // post is only offered in a language it is really translated into.
        if (snapshot?.posts?.[p.id]?.seo?.noIndex) continue;
        if (!localesForPost(overrides, p.id, defaultLocale, locales).includes(locale)) continue;
        entries.push({
            k: 'post',
            t: clamp(p.title, TITLE_MAX),
            d: clamp(p.excerpt || '', DESC_MAX),
            u: buildPublicPath(locale, `${BLOG_BASE}/${p.slug}`, defaultLocale),
            g: (p.tags || []).map(t => clamp(t.label, 40)),
        });
    }
    if (locale === defaultLocale) {
        for (const i of integrations) {
            entries.push({ k: 'integration', t: clamp(i.title, TITLE_MAX), d: clamp(i.description, DESC_MAX), u: detailPath(i.id), g: [] });
        }
    }
    return { locale, entries: entries.slice(0, MAX_ENTRIES) };
}

module.exports = { buildSearchIndex, MAX_ENTRIES };
