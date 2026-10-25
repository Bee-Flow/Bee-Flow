// @typecheck noImplicitAny
/**
 * Public integrations directory (/integrations/directory) and one page per
 * integration (/integrations/<id>), rendered from the published site's chrome
 * (name) and the product's capability catalogue. See core/seo/integrationsDirectory.
 * Mounted by publicRender ahead of its catch-all.
 */

'use strict';

const express = require('express');
const cmsStore = require('../stores/cmsStore');
const dir = require('../core/seo/integrationsDirectory');
const { getShell } = require('../core/seo/shell');
const { sendNotFound } = require('../core/seo/notFound');
const log = require('../telemetry/log');

/**
 * @param {{ resolveOrigin: (req: import('express').Request) => string, getLiveSiteId: () => Promise<string|null>,
 *   getSnapshot?: (siteId: string) => Promise<any> }} deps getSnapshot defaults to the published snapshot (a seam for tests)
 */
function createIntegrationsRouter({ resolveOrigin, getLiveSiteId, getSnapshot = (id) => cmsStore.getPublishedSnapshot(id) }) {
    const router = express.Router();

    /** @param {import('express').Request} req */
    async function context(req) {
        const siteId = await getLiveSiteId();
        if (!siteId) return null;
        const snapshot = await getSnapshot(siteId);
        if (!snapshot) return null;
        const siteName = snapshot.site?.header?.logoText || snapshot.site?.name || 'Bee Flow';
        const nav = {
            integrations: (snapshot.site?.pages || []).some((/** @type {{slug?: string}} */ p) => p.slug === 'integrations'),
            blog: Object.keys(snapshot.posts || {}).length > 0,
        };
        return { origin: resolveOrigin(req), siteName: String(siteName), items: dir.listGalleryItems(), nav };
    }

    router.get('/integrations/directory', async (req, res, next) => {
        try {
            const ctx = await context(req);
            if (!ctx) return next();
            // nosemgrep: ajinabraham.njsscan.xss.xss_node.express_xss -- q is written only as esc(query) in the search input's value, category only when it is a known slug; neither reaches the JSON-LD
            const q = typeof req.query.q === 'string' ? req.query.q : '';
            // nosemgrep: ajinabraham.njsscan.xss.xss_node.express_xss -- category is only written when it equals a known category slug, and then through esc()
            const category = typeof req.query.category === 'string' ? req.query.category : '';
            res.type('html').set('Cache-Control', 'public, max-age=60, s-maxage=300, stale-while-revalidate=86400');
            // nosemgrep: javascript.express.security.audit.xss.direct-response-write.direct-response-write, ajinabraham.njsscan.xss.xss_node.express_xss -- every interpolated string goes through esc() in renderDirectoryPage
            return res.send(dir.renderDirectoryPage({ ...ctx, q, category }));
        } catch (err) {
            log.warn('[SEO] integrations directory failed:', err.message);
            return next();
        }
    });

    router.get('/integrations/:id', async (req, res, next) => {
        try {
            const ctx = await context(req);
            if (!ctx) return next();
            const item = ctx.items.find(i => i.id === String(req.params.id).toLowerCase());
            if (!item) {
                // A real 404 (same marker nginx keeps) rather than a soft-404 app shell.
                const shell = await getShell();
                return shell ? sendNotFound(res, shell, 'en', false) : next();
            }
            res.type('html').set('Cache-Control', 'public, max-age=60, s-maxage=300, stale-while-revalidate=86400');
            // nosemgrep: javascript.express.security.audit.xss.direct-response-write.direct-response-write, ajinabraham.njsscan.xss.xss_node.express_xss -- every interpolated string goes through esc() in renderDetailPage
            return res.send(dir.renderDetailPage({ ...ctx, item, related: ctx.items }));
        } catch (err) {
            log.warn('[SEO] integration page failed:', err.message);
            return next();
        }
    });

    return router;
}

module.exports = { createIntegrationsRouter };
