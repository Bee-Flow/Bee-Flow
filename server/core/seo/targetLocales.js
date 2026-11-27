// @typecheck
'use strict';
/**
 * The locales a public address of the live site is published in, by its slug:
 * a CMS page (`''` = the homepage), a blog post (`blog/<post>`) or an
 * integration page (`integrations/<id>`, the directory included). A redirect
 * with `?locale=` (core/seo/siteRedirect.js) uses it to land on the right
 * language in one hop: a target without that translation goes straight to
 * the default language instead of via an address that moves it again.
 */

const { localesForPage } = require('../../i18n/pageLocales');
const { BLOG_BASE } = require('./publicPath');

const INTEGRATIONS_PREFIX = 'integrations/';

/**
 * @param {any} snapshot the published snapshot (site.pages, posts, page/post locale overrides)
 * @param {string} slug
 * @param {string} defaultLocale
 * @param {string[]} locales the site-wide list, default included
 * @returns {string[] | null} default first, then real translations; null when nothing is at that slug
 */
function localesForTarget(snapshot, slug, defaultLocale, locales) {
    if (slug.startsWith(INTEGRATIONS_PREFIX)) {
        const id = slug.slice(INTEGRATIONS_PREFIX.length);
        const { pageLocales } = require('./integrationContent/model.mts');
        return pageLocales(id === 'directory' ? null : id, locales, defaultLocale);
    }
    if (slug.startsWith(`${BLOG_BASE}/`)) {
        const postSlug = slug.slice(BLOG_BASE.length + 1);
        const found = Object.entries(snapshot?.posts || {}).find(([, p]) => !!p && typeof p === 'object' && p.slug === postSlug);
        if (!found) return null;
        const { localesForPost } = require('../../stores/cms/blogEffective');
        return localesForPost(snapshot.postLocaleOverrides || {}, found[0], defaultLocale, locales);
    }
    const entry = (snapshot?.site?.pages || []).find((/** @type {{ slug?: string, isHomepage?: boolean }} */ p) => (slug ? p.slug === slug : p.isHomepage));
    return entry ? localesForPage(snapshot, entry.id, defaultLocale, locales) : null;
}

module.exports = { localesForTarget };
