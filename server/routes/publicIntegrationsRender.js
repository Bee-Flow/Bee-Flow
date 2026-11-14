// @typecheck strict
/**
 * Public integrations directory (/integrations/directory) and one page per
 * integration (/integrations/<id>), rendered from the published site's chrome
 * (name, which pages exist in which language) and the product's capability
 * catalogue. See core/seo/integrationsDirectory.
 *
 * A translation lives under its locale prefix (/nl/integrations/<id>), like
 * every other public page (core/seo/publicPath): a locale the site does not
 * publish, or the default locale with a prefix, falls through; a page without
 * text in the asked language answers 301 to the default-language address, the
 * same rule routes/publicRender.js applies to an untranslated CMS page.
 * Mounted by publicRender ahead of its catch-all.
 */

'use strict';

const express = require('express');
const cmsStore = require('../stores/cmsStore');
const dir = require('../core/seo/integrationsDirectory');
const { hasPageIn } = require('../core/seo/integrationContent/model.mts');
const { localesForPage } = require('../core/seo/locales');
const { getShell } = require('../core/seo/shell');
const { sendNotFound } = require('../core/seo/notFound');
const log = require('../telemetry/log');

// /<locale>/integrations/<id or "directory">. A route regex rather than
// `/:locale/...`: a named parameter here would read as a tenant resource id.
const LOCALISED = /^\/([a-z]{2,3})\/integrations\/([a-z0-9][a-z0-9-]*)\/?$/;
const NAV_SLUGS = ['integrations', 'deployment', 'plans'];

/**
 * The parts of the published snapshot these pages read.
 * @typedef {NonNullable<Parameters<typeof localesForPage>[0]> & { posts?: Record<string, unknown>,
 *   site?: { name?: string, header?: { logoText?: string }, pages?: Array<{ id: string, slug?: string }> } }} PublishedSnapshot
 */

/** @type {import('../core/seo/integrationContent/model.mts').Catalog | null} */
let cachedCatalog = null;

/**
 * The shipped catalogues an integration page is checked against: every toolset
 * the tool groups offer, the trigger-source registry (global sources only, never
 * an organisation's) and the side-effect map. Loaded on first use.
 * @returns {import('../core/seo/integrationContent/model.mts').Catalog}
 */
function integrationCatalog() {
    if (!cachedCatalog) {
        const { TOOLSETS } = require('../integrations/coreToolsets');
        const { IMAGE_GEN_TOOLS } = require('../core/tools/imageGenTool');
        const { VIDEO_GEN_TOOLS } = require('../core/tools/videoGenTool');
        const { ELEVENLABS_TOOLS } = require('../core/tools/elevenLabsTools');
        cachedCatalog = {
            toolsets: { ...TOOLSETS, IMAGE_GEN_TOOLS, VIDEO_GEN_TOOLS, ELEVENLABS_TOOLS },
            triggerSources: require('../automation/triggerSources').listTriggerSources(),
            effectOf: require('../core/automationModel/sideEffectMap').effectOf,
        };
    }
    return cachedCatalog;
}

/**
 * Which site pages the integration pages link to, and in which locales each is published.
 * @param {PublishedSnapshot} snapshot @param {string} defaultLocale @param {string[]} locales
 * @returns {import('../core/seo/integrationsShell').Nav}
 */
function navFor(snapshot, defaultLocale, locales) {
    /** @type {import('../core/seo/integrationsShell').Nav} */
    const nav = { blog: Object.keys(snapshot.posts || {}).length > 0 };
    for (const p of snapshot.site?.pages || []) {
        const slug = p?.slug;
        if (slug && NAV_SLUGS.includes(slug)) nav[slug] = localesForPage(snapshot, p.id, defaultLocale, locales);
    }
    return nav;
}

/** The query string as sent, for a redirect that keeps it. @param {import('express').Request} req */
function rawQueryString(req) {
    const url = String(req.originalUrl || '');
    const at = url.indexOf('?');
    return at === -1 ? '' : url.slice(at);
}

/**
 * @param {{ resolveOrigin: (req: import('express').Request) => string, getLiveSiteId: () => Promise<string|null>,
 *   getSnapshot?: (siteId: string) => Promise<any>,
 *   siteLocales?: () => Promise<{ defaultLocale: string, locales: string[] }>,
 *   catalog?: () => import('../core/seo/integrationContent/model.mts').Catalog }} deps
 *   getSnapshot defaults to the published snapshot, siteLocales to English only, catalog to
 *   integrationCatalog (seams for tests)
 */
function createIntegrationsRouter({
    resolveOrigin, getLiveSiteId, getSnapshot = (id) => cmsStore.getPublishedSnapshot(id),
    siteLocales = async () => ({ defaultLocale: 'en', locales: ['en'] }), catalog = integrationCatalog,
}) {
    const router = express.Router();

    /** @param {import('express').Request} req @param {string | null} asked a locale prefix, or null */
    async function context(req, asked) {
        const siteId = await getLiveSiteId();
        if (!siteId) return null;
        const snapshot = await getSnapshot(siteId);
        if (!snapshot) return null;
        const { defaultLocale, locales } = await siteLocales();
        if (asked !== null && (asked === defaultLocale || !locales.includes(asked))) return null;
        const siteName = snapshot.site?.header?.logoText || snapshot.site?.name || 'Bee Flow';
        return {
            origin: resolveOrigin(req), siteName: String(siteName), items: dir.listGalleryItems(),
            nav: navFor(snapshot, defaultLocale, locales), defaultLocale, locales, locale: asked || defaultLocale,
        };
    }

    /** @param {import('express').Request} req @param {import('express').Response} res @param {import('express').NextFunction} next @param {string | null} asked */
    async function directory(req, res, next, asked) {
        const ctx = await context(req, asked);
        if (!ctx) return next();
        // nosemgrep: ajinabraham.njsscan.redirect.open_redirect.express_open_redirect -- the target is directoryPath(<the site default locale>), a same-site path; the visitor's query string follows the '?' and cannot change the host
        if (asked && !hasPageIn(null, asked)) return res.redirect(301, `${dir.directoryPath(ctx.defaultLocale, ctx.defaultLocale)}${rawQueryString(req)}`);
        // nosemgrep: ajinabraham.njsscan.xss.xss_node.express_xss -- q is written only as esc(query) in the search input's value, category only when it is a known slug; neither reaches the JSON-LD
        const q = typeof req.query.q === 'string' ? req.query.q : '';
        // nosemgrep: ajinabraham.njsscan.xss.xss_node.express_xss -- category is only written when it equals a known category slug, and then through esc()
        const category = typeof req.query.category === 'string' ? req.query.category : '';
        res.type('html').set('Cache-Control', 'public, max-age=60, s-maxage=300, stale-while-revalidate=86400');
        // nosemgrep: javascript.express.security.audit.xss.direct-response-write.direct-response-write, ajinabraham.njsscan.xss.xss_node.express_xss -- every interpolated string goes through esc() in renderDirectoryPage
        return res.send(dir.renderDirectoryPage({ ...ctx, q, category }));
    }

    /** @param {import('express').Request} req @param {import('express').Response} res @param {import('express').NextFunction} next @param {string | null} asked @param {string} rawId */
    async function detail(req, res, next, asked, rawId) {
        const ctx = await context(req, asked);
        if (!ctx) return next();
        const item = ctx.items.find(i => i.id === rawId.toLowerCase());
        if (!item) {
            // A real 404 (same marker nginx keeps) rather than a soft-404 app shell.
            const shell = await getShell();
            return shell ? sendNotFound(res, shell, ctx.locale, false) : next();
        }
        // nosemgrep: ajinabraham.njsscan.redirect.open_redirect.express_open_redirect -- the target is detailPath(<a catalogue id>), a same-site path; the visitor's query string follows the '?' and cannot change the host
        if (asked && !hasPageIn(item.id, asked)) return res.redirect(301, `${dir.detailPath(item.id, ctx.defaultLocale, ctx.defaultLocale)}${rawQueryString(req)}`);
        res.type('html').set('Cache-Control', 'public, max-age=60, s-maxage=300, stale-while-revalidate=86400');
        // nosemgrep: javascript.express.security.audit.xss.direct-response-write.direct-response-write, ajinabraham.njsscan.xss.xss_node.express_xss -- every interpolated string goes through esc() in renderDetailPage
        return res.send(dir.renderDetailPage({ ...ctx, item, related: ctx.items, catalog: catalog() }));
    }

    /** @param {string} what @param {(req: import('express').Request, res: import('express').Response, next: import('express').NextFunction) => Promise<unknown>} handler */
    const guarded = (what, handler) => async (/** @type {import('express').Request} */ req, /** @type {import('express').Response} */ res, /** @type {import('express').NextFunction} */ next) => {
        try {
            return await handler(req, res, next);
        } catch (err) {
            log.warn(`[SEO] ${what} failed:`, /** @type {Error} */ (err).message);
            return next();
        }
    };

    router.get('/integrations/directory', guarded('integrations directory', (req, res, next) => directory(req, res, next, null)));
    router.get('/integrations/:id', guarded('integration page', (req, res, next) => detail(req, res, next, null, String(req.params.id))));
    router.get(LOCALISED, guarded('localised integration page', (req, res, next) => {
        // nosemgrep: ajinabraham.njsscan.xss.xss_node.express_xss -- both segments are matched by the route's [a-z0-9-] pattern; the locale must be a site locale and the id a catalogue id before anything is written
        const asked = String(req.params[0]);
        const rest = String(req.params[1]);
        return rest === 'directory' ? directory(req, res, next, asked) : detail(req, res, next, asked, rest);
    }));

    return router;
}

module.exports = { createIntegrationsRouter, integrationCatalog };
