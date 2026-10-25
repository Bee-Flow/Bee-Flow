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
const { buildLlmsTxt } = require('../core/seo/sitemap');
const log = require('../telemetry/log');

/**
 * @param {{ resolveOrigin: (req: import('express').Request) => string,
 *   getLiveSiteId: () => Promise<string|null>, isIndexableHost: (origin: string) => boolean }} deps
 */
function createLlmsRouter({ resolveOrigin, getLiveSiteId, isIndexableHost }) {
    const router = express.Router();
    router.get('/llms.txt', async (req, res, next) => {
        try {
            const origin = resolveOrigin(req);
            const siteId = await getLiveSiteId();
            if (!siteId || !isIndexableHost(origin)) return next();

            const snapshot = await cmsStore.getPublishedSnapshot(siteId);
            if (!snapshot) return next();

            const pages = (snapshot.site?.pages || []).map((/** @type {any} */ entry) => ({
                ...entry,
                seo: (snapshot.pages?.[entry.id] || {}).seo || {},
            }));
            const home = pages.find((/** @type {any} */ p) => p.isHomepage);

            res.type('text/plain').set('Cache-Control', 'public, max-age=3600');
            return res.send(buildLlmsTxt(pages, {
                origin,
                siteName: snapshot.site?.name || 'Bee Flow',
                summary: String(home?.seo?.metaDescription || '').trim(),
            }));
        } catch (err) {
            log.warn('[SEO] llms.txt failed:', /** @type {Error} */ (err).message);
            return next();
        }
    });
    return router;
}

module.exports = { createLlmsRouter };
