// @typecheck noImplicitAny
/**
 * /search-index.json and /<locale>/search-index.json: the client-side search
 * index (see core/seo/searchIndex). Like the sitemap and the feed it never
 * falls through to the SPA, and it only ever reads the published snapshot.
 */

'use strict';

const express = require('express');
const cmsStore = require('../stores/cmsStore');
const { buildSearchIndex } = require('../core/seo/searchIndex');
const { listGalleryItems } = require('../core/seo/integrationsDirectory');
const { HttpError } = require('../core/http/errors');
const log = require('../telemetry/log');

/**
 * @param {{ getLiveSiteId: () => Promise<string|null>, siteLocales: () => Promise<{defaultLocale: string, locales: string[]}>,
 *   getSnapshot?: (siteId: string) => Promise<any>,
 *   getPosts?: (siteId: string, opts: {locale: string, limit: number}) => Promise<{posts: any[]}> }} deps
 *   getSnapshot and getPosts default to the published store (seams for tests)
 */
function createSearchIndexRouter({
    getLiveSiteId, siteLocales,
    getSnapshot = (id) => cmsStore.getPublishedSnapshot(id),
    getPosts = (id, o) => cmsStore.getLatestPublishedPosts(id, o),
}) {
    const router = express.Router();

    router.get(/^\/(?:([a-z]{2,3})\/)?search-index\.json$/, async (req, res, next) => {
        try {
            const siteId = await getLiveSiteId();
            const { defaultLocale, locales } = await siteLocales();
            const asked = req.params[0] ? String(req.params[0]).toLowerCase() : null;
            if (!siteId || (asked && (asked === defaultLocale || !locales.includes(asked)))) {
                return res.status(404).type('text/plain').set('Cache-Control', 'public, max-age=300').send('Not found');
            }
            const locale = asked || defaultLocale;
            const snapshot = await getSnapshot(siteId);
            if (!snapshot) return res.status(404).type('text/plain').set('Cache-Control', 'public, max-age=300').send('Not found');
            const { posts } = await getPosts(siteId, { locale, limit: 50 });
            res.set('Cache-Control', 'public, max-age=300, s-maxage=600');
            return res.json(buildSearchIndex({ snapshot, posts, integrations: listGalleryItems(), locale, defaultLocale, locales }));
        } catch (err) {
            log.warn('[SEO] search index failed:', err.message);
            return next(new HttpError(503, 'search_index_unavailable', 'Search index unavailable'));
        }
    });

    return router;
}

module.exports = { createSearchIndexRouter };
