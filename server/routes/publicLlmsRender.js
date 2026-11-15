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
const { buildLlmsTxt, llmsGuides, publicSiteName, LLMS_GUIDES } = require('../core/seo/sitemap');
const { localesForPage } = require('../i18n/pageLocales');
const log = require('../telemetry/log');

/**
 * The newest published posts in the default language, as Guides. Asks for more
 * than it lists, so a noIndex post does not shorten the list.
 * @param {string} siteId
 * @param {{ posts?: Record<string, { seo?: { noIndex?: boolean } }> }} snapshot
 * @param {string} origin
 * @param {string} defaultLocale
 * @returns {Promise<Array<{ title: string, url: string }>>}
 */
async function latestGuides(siteId, snapshot, origin, defaultLocale) {
    const latest = await cmsStore.getLatestPublishedPosts(siteId, { locale: defaultLocale, limit: LLMS_GUIDES * 2 });
    return llmsGuides(latest.posts || [], { origin, defaultLocale, storedPosts: snapshot.posts || {} });
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
            const guides = await latestGuides(siteId, snapshot, origin, defaultLocale);

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
