/**
 * CMS Routes — public read endpoints + admin CRUD for the multi-site CMS.
 *
 * The store (cmsStore.js) is multi-project. The route layer exposes TWO
 * parallel admin APIs that share the same handler bodies:
 *
 *   /admin/*               — single-site bridge. attachSiteId middleware
 *                            resolves the org's "default" project (auto-
 *                            created on first call). Used by the current
 *                            admin panel until the project switcher lands.
 *
 *   /sites/:siteId/*       — explicit multi-site. attachSiteIdFromParam
 *                            validates the siteId from the URL and 404s
 *                            if the project doesn't exist. Plus site-CRUD
 *                            routes for managing the project list itself.
 *
 *   PUBLIC (no auth):
 *     GET  /api/cms/site                       legacy keyed-content shape
 *     GET  /api/cms/site?v=2[&slug=…&locale=…] new shape
 *     GET  /api/cms/asset/:key(*)              streams a CMS asset
 *     GET  /api/cms/site?blog=index|post&post=… blog index / post (published)
 *     GET  /api/cms/blog/posts                 newest posts (latest-posts block)
 *
 *   ADMIN — site management (super-admin only):
 *     GET    /api/cms/sites                                    list sites + liveSiteId
 *     POST   /api/cms/sites                                    create site
 *     GET    /api/cms/sites/:siteId                            full editor payload
 *     PUT    /api/cms/sites/:siteId                            replace SiteDoc
 *     PATCH  /api/cms/sites/:siteId                            { name } — rename
 *     DELETE /api/cms/sites/:siteId                            delete site + cascade
 *     *      /api/cms/sites/:siteId/posts[/:postId[/locale/:l]] blog posts (routes/cmsBlog.js)
 *     *      /api/cms/sites/:siteId/redirects[/:id | /hosts]    redirects (routes/cmsRedirects.js)
 *     PUT    /api/cms/sites/:siteId/live                       { live } — set/clear live
 *     POST   /api/cms/sites/:siteId/duplicate                  deep-copy → new version
 *
 *   ADMIN — per-site content (mounted on both /admin and /sites/:siteId):
 *     GET    .../site                                          full editor payload (legacy)
 *     PUT    .../site                                          replace SiteDoc (legacy)
 *     GET    .../graph                                         page graph for sitemap
 *     PUT    .../site/locale/:locale                           replace site-locale override
 *     DELETE .../site/locale/:locale
 *     POST   .../pages                                         { slug?, title?, copyFromId? } → { id }
 *     PUT    .../pages/order                                   { orderedIds: [] }
 *     PUT    .../pages/:id/meta                                { slug?, title?, hideHeader?, hideFooter? }
 *     PUT    .../pages/:id/homepage                            promote to homepage
 *     DELETE .../pages/:id
 *     GET    .../pages/:id                                     full PageDoc
 *     PUT    .../pages/:id                                     replace PageDoc
 *     PUT    .../pages/:id/locale/:locale                      replace page-locale override
 *     DELETE .../pages/:id/locale/:locale
 *
 *   ADMIN — org-wide (only at /admin/*, not per-site):
 *     PUT    /api/cms/admin/enabled                            { enabled, siteId? } — legacy
 *     PUT    /api/cms/admin/default-locale                     { locale }
 *     POST   /api/cms/admin/upload                             multipart file → { key, url }
 *     POST   /api/cms/admin/upload-clip                        multipart mp4/webm clip (≤500 MB) → { key, url }
 *     GET    /api/cms/admin/assets                             list uploaded assets → { assets, unavailable? }
 *
 * Layout: this file owns the router, the request schemas, the rate limiters,
 * the single-site bridge (attachSiteId) and the mount order. The handler
 * bodies live beside it:
 *   ./cmsPublicSite.js    GET /site (the public read + analytics envelope)
 *   ./cmsAssets.js        uploads, the asset library, the public asset stream
 *   ./cmsSiteHandlers.js  SiteDoc, site locales + AI translate, publish, Live, org flags
 *   ./cmsPageHandlers.js  pages, page locales + AI translate, page templates
 *   ./cmsSitesAdmin.js    site list / create / rename / duplicate / delete, export / import
 *
 *   "Live" model: at most one project can be live at a time. The public
 *   /api/cms/site reads the live siteId from cms_live_site_id; admins
 *   toggle it per-site via /sites/:siteId/live. The legacy
 *   /admin/enabled route reinterprets boolean toggles as "clear / set
 *   live to first project" so older clients keep working.
 */

const express = require('express');
const { synthesizeLegacyContent } = require('../core/cms/legacyContent');
const router = express.Router();

const cmsStore = require('../stores/cmsStore');
require('../core/umamiClient');
const { perUserRateLimit } = require('../utils/perUserRateLimit');
// requireAdmin / attachSiteIdFromParam / SITE_ID_RE are shared with the CMS
// AI-builder route (routes/ai/cmsBuilder.js) — extracted verbatim to
// ./cmsShared.js, zero behavior change.
const { requireAdmin, attachSiteIdFromParam } = require('./cmsShared');
const cmsAnalytics = require('./cmsAnalytics');
const cmsMedia = require('./cmsMedia');
const cmsBlog = require('./cmsBlog');
const cmsStories = require('./cmsStories');
const { createRedirectsRouter } = require('./cmsRedirects');
const { validate } = require('../core/http/validate');
const { z, worded, bodyOf, typeError } = require('../core/http/schemaParts');

const { getPublicSite } = require('./cmsPublicSite');
const { uploadFile, handleUpload, listAssetsHandler, serveAsset } = require('./cmsAssets');
const {
    getSitePayload, getGraph, putSiteDoc, putSiteLocale, deleteSiteLocale,
    postSiteAiTranslate, postSitePublish, putSiteLive, putEnabled, putDefaultLocale,
} = require('./cmsSiteHandlers');
const {
    postPageAiTranslate, postPage, putPagesOrder, putPageMeta, putPageHomepage,
    deletePageHandler, listTemplates, postTemplate, deleteTemplateHandler,
    getPageById, putPage, putPageLocale, deletePageLocale,
} = require('./cmsPageHandlers');
const {
    importJsonParser, importSiteUpload, exportSiteHandler, importSiteHandler,
    listSitesHandler, createSiteHandler, renameSiteHandler, duplicateSiteHandler,
    deleteSiteHandler,
} = require('./cmsSitesAdmin');

// ── What an admin request may send ───────────────────────────────────
// The envelope of every admin JSON body is closed: a misspelled key is a 400
// naming it. The documents inside (`site`, `page`, `override`, `blocks`) keep
// their shape checks in cmsStore, which owns the SiteDoc/PageDoc format.
// What this closes: `hideHeader: "false"` and `noAnalytics: "true"` on the
// page meta were ignored under a 200 (the store only takes real booleans), so
// a page an admin had switched out of analytics was still tracked; a
// misspelled `noAnalyitcs` likewise.
const cmsText = (message, max = 500) => worded(message).max(max, message);
const doc = (message) => z.record(z.string(), z.unknown(), { error: typeError({ required: message, invalid: message }) });
const bool = (message) => z.boolean({ error: message });
const cmsIds = (message) => z.array(cmsText(message, 200), { error: message });
const cmsBody = (shape, subject) => validate({ body: bodyOf(shape, subject) });

const siteDocBody = cmsBody({ site: doc('site object required') }, 'Saving a site');
const overrideBody = cmsBody({ override: doc('override object required') }, 'Saving a translation');
const pageDocBody = cmsBody({ page: doc('page object required') }, 'Saving a page');
const translateBody = cmsBody({ modelTier: cmsText('modelTier is the name of a model tier.', 100).nullish() }, 'Translating');
const newPageBody = cmsBody({
    slug: cmsText('slug is text.').nullish(),
    title: cmsText('title is text.').nullish(),
    copyFromId: cmsText('copyFromId is the id of a page.', 200).nullish(),
    templateId: cmsText('templateId is the id of a template.', 200).nullish(),
}, 'Adding a page');
const orderBody = cmsBody({ orderedIds: cmsIds('orderedIds array required') }, 'Reordering pages');
const pageMetaBody = cmsBody({
    slug: cmsText('slug is text.').optional(),
    title: cmsText('title is text.').optional(),
    hideHeader: bool('hideHeader is true or false.').optional(),
    hideFooter: bool('hideFooter is true or false.').optional(),
    noAnalytics: bool('noAnalytics is true or false.').optional(),
    isNotFound: bool('isNotFound is true or false.').optional(),
}, 'Page settings');
const templateBody = cmsBody({
    name: cmsText('A template needs a name.', 200),
    description: cmsText('description is text.', 2000).nullish(),
    blocks: z.array(z.unknown(), { error: 'blocks is the list of blocks to keep.' }),
}, 'Saving a template');
const createSiteBody = cmsBody({ name: cmsText('name is text of at most 200 characters.', 200).nullish() }, 'Creating a site');
const renameSiteBody = cmsBody({ name: cmsText('name required', 200) }, 'Renaming a site');
const liveBody = cmsBody({ live: bool('live must be a boolean') }, 'Setting a site live');
const enabledBody = cmsBody({
    enabled: bool('enabled must be a boolean'),
    siteId: cmsText('siteId is the id of a site.', 200).nullish(),
}, 'Switching the site on or off');
const defaultLocaleBody = cmsBody({ locale: cmsText('locale required', 20) }, 'Setting the default language');

// The per-route JSON parser for /sites/import (2 MB cap) and the .zip
// uploader live in ./cmsSitesAdmin.js with the import handler.

// Rate limiters for write-heavy admin endpoints. The threat model is a
// compromised admin session, not anonymous abuse — but a stolen session
// shouldn't be able to exhaust storage / DB capacity in seconds. Per-
// user windows are intentionally generous so a legit power user editing
// a site is never rate-limited.
const uploadLimiter      = perUserRateLimit({ windowMs: 60_000, max: 60 });
const clipUploadLimiter  = perUserRateLimit({ windowMs: 60_000, max: 10 });
const importLimiter      = perUserRateLimit({ windowMs: 60_000, max: 10 });
const duplicateLimiter   = perUserRateLimit({ windowMs: 60_000, max: 20 });
const publishLimiter     = perUserRateLimit({ windowMs: 60_000, max: 30 });
// AI translation hits the LLM (one or more batched calls), so it's costlier
// than an ordinary save — keep its window tighter.
const aiTranslateLimiter = perUserRateLimit({ windowMs: 60_000, max: 20 });

// ── Live-site selection ──────────────────────────────────────────
//
// "Live" used to be a global on/off flag (cms_enabled). Now it's per-
// project and mutually exclusive: at most one project can be live at a
// time, and the live URL serves *that* project. Other projects stay
// editable in the admin without affecting the public site.
//
// Storage:
//   cms_live_site_id : string | null   the live project's siteId, or null
//                                      when nothing is live (public site
//                                      is dark and "/" redirects to /app).
//
// Migration: legacy cms_enabled === true with no live id set → adopt
// projects[0] as live (preserves prior behavior). Done lazily inside
// getLiveSiteId so we don't add a startup ordering surprise.

// getLiveSiteId/setLiveSiteId + these keys live in ./cmsShared.js so the
// analytics router can resolve the live site without importing this module
// back (which would be circular).

// ── Website analytics (Umami) ────────────────────────────────────────
//
// The whole surface — settings, site-map, provisioning, the read-only Umami
// proxy and the recorder opt-in — lives in ./cmsAnalytics.js. This module only
// consumes provisionAnalyticsForSite (on publish / delete) and the settings +
// maps when assembling the public /site envelope.

// ── Single-project bridge ────────────────────────────────────────
//
// Resolves the org's "default" CMS project. Pass { create: true } to
// auto-create it when none exists (used by /admin routes); reads return
// null when empty so public callers don't accidentally provision a
// project on cache-busting traffic.

async function getDefaultSiteId({ create = false } = {}) {
    const projects = await cmsStore.listProjects();
    if (projects.length > 0) return projects[0].id;
    if (!create) return null;
    const created = await cmsStore.createProject({ name: 'Default site' });
    return created.id;
}

// ── Middleware ───────────────────────────────────────────────────

// requireAdmin lives in ./cmsShared.js (shared with the CMS AI builder).

// The stricter operator-only gate (requireSuperAdmin) lives in ./cmsAnalytics.js
// alongside the routes that use it.

async function attachSiteId(req, res, next) {
    req.siteId = await getDefaultSiteId({ create: true });
    next();
}

// The uploader (multer, MIME whitelist, 400 on a rejected file) lives in
// ./cmsAssets.js with handleUpload; the site-import uploader in
// ./cmsSitesAdmin.js.

// ── Shared handler bodies ────────────────────────────────────────
//
// The handler bodies live in ./cmsSiteHandlers.js, ./cmsPageHandlers.js,
// ./cmsSitesAdmin.js and ./cmsAssets.js. Each reads req.siteId (set by
// attachSiteId or attachSiteIdFromParam) and req.params.{id,locale} (where
// applicable); the same function is wired to both /admin/* and
// /sites/:siteId/* routes below.

// ══════════════════════════════════════════════════════════════════
// PUBLIC
// ══════════════════════════════════════════════════════════════════

// GET /api/cms/site — the public read of the live site (./cmsPublicSite.js).
router.get('/site', getPublicSite);

// Public reads: GET /api/cms/blog/posts ("latest posts" block), GET /api/cms/stories (customer stories).
router.use('/blog', cmsBlog.createPublicRouter());
router.use('/stories', cmsStories.createPublicRouter());

// Website forms, anonymous by design (./cmsForms.js lists what bounds them).
router.use('/forms', require('./cmsForms').createDefaultPublicRouter());

// Public asset stream (./cmsAssets.js): byte ranges, scriptable types forced
// to download, sanitized SVG inline under a strict CSP.
router.get(/^\/asset\/(.+)$/, serveAsset);

// ══════════════════════════════════════════════════════════════════
// ADMIN — /admin/* (single-site bridge, back-compat)
// ══════════════════════════════════════════════════════════════════

router.use('/admin', requireAdmin);

// Website analytics — platform-operator only (requireSuperAdmin, stricter than
// the /admin requireAdmin above which also admits the 'all' permission).
// Registered BEFORE attachSiteId so opening the analytics dashboard never
// auto-provisions a default CMS project. Settings + a read-only proxy to Umami;
// the browser never sees Umami credentials.
router.use('/admin/analytics', cmsAnalytics.router);

// Asset library (read-only, org-wide bucket prefix — same gate as
// /admin/upload). Registered BEFORE attachSiteId: listing assets never
// needs a site and must not auto-provision a default CMS project.
router.get('/admin/assets', listAssetsHandler);
// Which automations a website form may start (./cmsFormsAdmin.js); touches no project either.
router.use('/admin', require('./cmsFormsAdmin').createDefaultAdminRouter());
// Clip upload sits here too (before attachSiteId): it touches no project, so
// it must not auto-provision one.
// Clips (video with sound, up to 500 MB): disk-backed, streamed into storage.
router.post('/admin/upload-clip', clipUploadLimiter, cmsMedia.clipUploadMiddleware, cmsMedia.handleClipUpload);

router.use('/admin', attachSiteId);

// Per-site content (default-bridge target).
router.get('/admin/site', getSitePayload);
router.put('/admin/site', siteDocBody, putSiteDoc);
router.get('/admin/graph', getGraph);
router.put('/admin/site/locale/:locale', overrideBody, putSiteLocale);
router.delete('/admin/site/locale/:locale', deleteSiteLocale);
router.post('/admin/site/ai-translate/:locale', aiTranslateLimiter, translateBody, postSiteAiTranslate);

// Pages — order matters: literal '/order' before ':id' wildcard.
router.post('/admin/pages', newPageBody, postPage);
router.put('/admin/pages/order', orderBody, putPagesOrder);
router.put('/admin/pages/:id/locale/:locale', overrideBody, putPageLocale);
router.delete('/admin/pages/:id/locale/:locale', deletePageLocale);
router.post('/admin/pages/:id/ai-translate/:locale', aiTranslateLimiter, translateBody, postPageAiTranslate);
router.put('/admin/pages/:id/meta', pageMetaBody, putPageMeta);
router.put('/admin/pages/:id/homepage', putPageHomepage);
router.delete('/admin/pages/:id', deletePageHandler);
router.get('/admin/pages/:id', getPageById);
router.put('/admin/pages/:id', pageDocBody, putPage);

// Publish — same handler as the multi-site route, scoped to the bridge's
// default site.
router.post('/admin/publish', publishLimiter, postSitePublish);

// Org-wide flags (not per-site — only available here).
router.put('/admin/enabled', enabledBody, putEnabled);
router.put('/admin/default-locale', defaultLocaleBody, putDefaultLocale);

// File uploads (org-wide bucket prefix).
router.post('/admin/upload', uploadLimiter, uploadFile, handleUpload);

// Page templates — global, shared across all sites. List/save/delete
// only; "apply" happens implicitly by passing `templateId` to POST page.
router.get('/admin/templates',        listTemplates);
router.post('/admin/templates',       templateBody, postTemplate);
router.delete('/admin/templates/:id', deleteTemplateHandler);

// ══════════════════════════════════════════════════════════════════
// ADMIN — /sites and /sites/:siteId/* (explicit multi-site)
// ══════════════════════════════════════════════════════════════════

router.use('/sites', requireAdmin);

// Site-CRUD (no siteId yet, no attachSiteIdFromParam needed).
router.get('/sites', listSitesHandler);
router.post('/sites', createSiteBody, createSiteHandler);
// IMPORTANT: `/sites/import` must register BEFORE the siteId param
// middleware below — otherwise `import` gets matched as a siteId and
// rejected by the `pj_[a-f0-9]+` format check.
// importSiteUpload runs first and no-ops on a JSON content-type, so the two
// body shapes (.zip multipart / raw JSON) share one route and one limiter.
// The import body is an exported site bundle (or a zip); cmsExportBundle
// checks its shape, so no envelope schema here.
router.post('/sites/import', importLimiter, importSiteUpload, importJsonParser, importSiteHandler);

// Validate :siteId for everything below before running handlers.
router.use('/sites/:siteId', attachSiteIdFromParam);

// Blog posts (routes/cmsBlog.js): list / create / read / patch / delete and
// per-language translations. req.siteId is set by the middleware above.
router.use('/sites/:siteId/posts', cmsBlog.createAdminRouter());

router.use('/sites/:siteId/redirects', createRedirectsRouter()); // redirect manager (routes/cmsRedirects.js)

// Pages — literal '/order' before ':id' wildcard.
router.post('/sites/:siteId/pages', newPageBody, postPage);
router.put('/sites/:siteId/pages/order', orderBody, putPagesOrder);
router.put('/sites/:siteId/pages/:id/locale/:locale', overrideBody, putPageLocale);
router.delete('/sites/:siteId/pages/:id/locale/:locale', deletePageLocale);
router.post('/sites/:siteId/pages/:id/ai-translate/:locale', aiTranslateLimiter, translateBody, postPageAiTranslate);
router.put('/sites/:siteId/pages/:id/meta', pageMetaBody, putPageMeta);
router.put('/sites/:siteId/pages/:id/homepage', putPageHomepage);
router.delete('/sites/:siteId/pages/:id', deletePageHandler);
router.get('/sites/:siteId/pages/:id', getPageById);
router.put('/sites/:siteId/pages/:id', pageDocBody, putPage);

// Site chrome (header/footer) and locale overrides.
router.put('/sites/:siteId/site/locale/:locale', overrideBody, putSiteLocale);
router.delete('/sites/:siteId/site/locale/:locale', deleteSiteLocale);
router.post('/sites/:siteId/site/ai-translate/:locale', aiTranslateLimiter, translateBody, postSiteAiTranslate);

// Page graph for the sitemap diagram.
router.get('/sites/:siteId/graph', getGraph);

// Site export (Content-Disposition: attachment). `?format=zip` (default)
// returns site.json + every referenced asset's bytes; `?format=json` returns
// the bundle alone. Both carry the full SiteDoc + every PageDoc + blocks +
// every locale override. The counterpart `POST /sites/import` (registered
// earlier, before the siteId middleware) restores either into a fresh siteId.
router.get('/sites/:siteId/export', require('../compliance/dataPortability/stampExport')('cms_sites'), exportSiteHandler);

// Per-site Live toggle — mutually exclusive across projects (only one
// can be live at a time; setting one live takes the previous one offline).
router.put('/sites/:siteId/live', liveBody, putSiteLive);

// Duplicate a site into a new version (same versionGroupId, next "v{n}"
// name). Returns the new site's { id, name, versionGroupId, versionName }.
router.post('/sites/:siteId/duplicate', duplicateLimiter, duplicateSiteHandler);

// Publish — snapshot the current draft into cms_published_{siteId}. The
// public /api/cms/site route reads from this snapshot, so visitors only
// see content the user has explicitly published.
router.post('/sites/:siteId/publish', publishLimiter, postSitePublish);

// Site-level operations on the SiteDoc itself.
router.get('/sites/:siteId', getSitePayload);
router.put('/sites/:siteId', siteDocBody, putSiteDoc);
router.patch('/sites/:siteId', renameSiteBody, renameSiteHandler);
router.delete('/sites/:siteId', deleteSiteHandler);

// Test seam — lets routes/cmsPublicSite.test.js exercise the legacy content
// synthesis (nav/dropdown display mapping) directly, without HTTP. Same
// pattern as routes/ai/cmsBuilder.js. Not part of the route surface.
router._test = { synthesizeLegacyContent };

module.exports = router;
