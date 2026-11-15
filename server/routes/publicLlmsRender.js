// @typecheck strict
/**
 * /llms.txt: the same source as the sitemap, addressed to language models
 * rather than crawlers. Split out of routes/publicRender.js.
 *
 * Falls through when nothing is published or the host is not the indexable
 * one: an empty Markdown file would still claim to be a real one, and a
 * preview host has no business advertising itself to assistants.
 */

'use strict';

const express = require('express');
const cmsStore = require('../stores/cmsStore');
const { buildLlmsTxt, publicSiteName, LLMS_GUIDES } = require('../core/seo/sitemap');
const { postPath } = require('../core/seo/blog');
const { localesForPage } = require('../i18n/pageLocales');
const log = require('../telemetry/log');

/**
 * The newest published posts in the default language, as Guides.
 * @param {string} siteId
 * @param {string} origin
 * @param {string} defaultLocale
 * @returns {Promise<Array<{ title: string, url: string }>>}
 */
async function latestGuides(siteId, origin, defaultLocale) {
    const latest = await cmsStore.getLatestPublishedPosts(siteId, { locale: defaultLocale, limit: LLMS_GUIDES });
    return (latest.posts || []).map((/** @type {{ title?: string, slug?: string }} */ p) => ({
        title: String(p.title || p.slug || ''),
        url: `${origin}${postPath(defaultLocale, String(p.slug || ''), defaultLocale)}`,
    })).filter((/** @type {{ title: string }} */ g) => g.title);
}

/**
 * @param {{ resolveOrigin: (req: import('express').Request) => string,
 *   getLiveSiteId: () => Promise<string|null>, isIndexableHost: (origin: string) => boolean,
 *   siteLocales: () => Promise<{ defaultLocale: string, locales: string[] }> }} deps
 */
function createLlmsRouter({ resolveOrigin, getLiveSiteId, isIndexableHost, siteLocales }) {
    const router = express.Router();
    router.get('/llms.txt', async (req, res, next) => {
        try {
            const origin = resolveOrigin(req);
            const siteId = await getLiveSiteId();
            if (!siteId || !isIndexableHost(origin)) return next();

            const snapshot = await cmsStore.getPublishedSnapshot(siteId);
            if (!snapshot) return next();

            const { defaultLocale, locales } = await siteLocales();
            const pages = (snapshot.site?.pages || []).map((/** @type {import('../stores/cms/shared').PageIndexEntry} */ entry) => ({
                ...entry,
                seo: (snapshot.pages?.[entry.id] || {}).seo || {},
                locales: localesForPage(snapshot, entry.id, defaultLocale, locales),
            }));
            const home = pages.find((/** @type {{ isHomepage?: boolean }} */ p) => p.isHomepage);
            const guides = await latestGuides(siteId, origin, defaultLocale);

            res.type('text/plain').set('Cache-Control', 'public, max-age=3600');
            return res.send(buildLlmsTxt(pages, {
                origin,
                siteName: publicSiteName(snapshot.site),
                summary: String(home?.seo?.metaDescription || '').trim(),
                defaultLocale,
                guides,
            }));
        } catch (err) {
            log.warn('[SEO] llms.txt failed:', /** @type {Error} */ (err).message);
            return next();
        }
    });
    return router;
}

module.exports = { createLlmsRouter };
