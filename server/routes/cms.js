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
 *
 *   ADMIN — site management (super-admin only):
 *     GET    /api/cms/sites                                    list sites + liveSiteId
 *     POST   /api/cms/sites                                    create site
 *     GET    /api/cms/sites/:siteId                            full editor payload
 *     PUT    /api/cms/sites/:siteId                            replace SiteDoc
 *     PATCH  /api/cms/sites/:siteId                            { name } — rename
 *     DELETE /api/cms/sites/:siteId                            delete site + cascade
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
 *     GET    /api/cms/admin/assets                             list uploaded assets → { assets, unavailable? }
 *
 *   "Live" model: at most one project can be live at a time. The public
 *   /api/cms/site reads the live siteId from cms_live_site_id; admins
 *   toggle it per-site via /sites/:siteId/live. The legacy
 *   /admin/enabled route reinterprets boolean toggles as "clear / set
 *   live to first project" so older clients keep working.
 */

const express = require('express');
const { synthesizeLegacyContent } = require('../core/cms/legacyContent');
const log = require('../telemetry/log');
const router = express.Router();
const multer = require('multer');
const path = require('path');
const bodyParser = require('body-parser');

const cmsStore = require('../stores/cmsStore');
const cmsExportBundle = require('../core/cms/cmsExportBundle');
const cmsTranslate = require('../core/cms/cmsTranslate');
const configStore = require('../stores/configStore');
const languageStore = require('../stores/languageStore');
const storageStore = require('../stores/storageStore');
require('../core/umamiClient');
const { perUserRateLimit } = require('../utils/perUserRateLimit');
// requireAdmin / attachSiteIdFromParam / SITE_ID_RE are shared with the CMS
// AI-builder route (routes/ai/cmsBuilder.js) — extracted verbatim to
// ./cmsShared.js, zero behavior change.
const {
    requireAdmin, attachSiteIdFromParam, getLiveSiteId, setLiveSiteId, KEY_CMS_LIVE_SITE_ID,
} = require('./cmsShared');
const cmsAnalytics = require('./cmsAnalytics');
const {
    getAnalyticsSettings, getAnalyticsSiteMap, getRecorderMap,
    provisionAnalyticsForSite,
} = cmsAnalytics;
const { sanitizeSvg } = require('../utils/svgSanitizer');
const { validate } = require('../core/http/validate');
const { z, worded, bodyOf } = require('../core/http/schemaParts');

// ── What an admin request may send ───────────────────────────────────
// The envelope of every admin JSON body is closed: a misspelled key is a 400
// naming it. The documents inside (`site`, `page`, `override`, `blocks`) keep
// their shape checks in cmsStore, which owns the SiteDoc/PageDoc format.
// What this closes: `hideHeader: "false"` and `noAnalytics: "true"` on the
// page meta were ignored under a 200 (the store only takes real booleans), so
// a page an admin had switched out of analytics was still tracked; a
// misspelled `noAnalyitcs` likewise.
const cmsText = (message, max = 500) => worded(message).max(max, message);
const doc = (message) => z.record(z.unknown(), { required_error: message, invalid_type_error: message });
const bool = (message) => z.boolean({ required_error: message, invalid_type_error: message });
const cmsIds = (message) => z.array(cmsText(message, 200), { required_error: message, invalid_type_error: message });
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
    blocks: z.array(z.unknown(), { required_error: 'blocks is the list of blocks to keep.', invalid_type_error: 'blocks is the list of blocks to keep.' }),
}, 'Saving a template');
const createSiteBody = cmsBody({ name: cmsText('name is text of at most 200 characters.', 200).nullish() }, 'Creating a site');
const renameSiteBody = cmsBody({ name: cmsText('name required', 200) }, 'Renaming a site');
const liveBody = cmsBody({ live: bool('live must be a boolean') }, 'Setting a site live');
const enabledBody = cmsBody({
    enabled: bool('enabled must be a boolean'),
    siteId: cmsText('siteId is the id of a site.', 200).nullish(),
}, 'Switching the site on or off');
const defaultLocaleBody = cmsBody({ locale: cmsText('locale required', 20) }, 'Setting the default language');

// Per-route body parser for /sites/import — caps the JSON payload at
// 2 MB. The global parser is 20 MB which is fine for chat/agent runs
// but too permissive for site imports (a real export is well under
// 500 KB). Caps memory pressure when a compromised admin session sends
// a deeply-nested or zip-bombed JSON.
const importJsonParser = bodyParser.json({ limit: '2mb' });

// Rate limiters for write-heavy admin endpoints. The threat model is a
// compromised admin session, not anonymous abuse — but a stolen session
// shouldn't be able to exhaust storage / DB capacity in seconds. Per-
// user windows are intentionally generous so a legit power user editing
// a site is never rate-limited.
const uploadLimiter      = perUserRateLimit({ windowMs: 60_000, max: 60 });
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
    try {
        req.siteId = await getDefaultSiteId({ create: true });
        next();
    } catch (err) {
        log.error('[CMS] siteId resolution failed:', err.message);
        res.status(500).json({ error: 'Failed to resolve CMS project' });
    }
}

// SITE_ID_RE + attachSiteIdFromParam live in ./cmsShared.js (shared with
// the CMS AI builder).

// Accepted MIME types for the CMS uploader. Images cover the regular
// hero/feature/logo case; image/gif + image/apng + image/webp cover
// animated graphics; video/mp4 + video/webm cover the "silent loop"
// video kind used by Media + Text. Anything outside this list is
// rejected as 400 by the wrapper middleware below (NOT 500 — fileFilter
// errors used to bubble up uncaught and surface as a generic Internal
// Server Error).
//
// SVG is accepted, but only after server-side sanitization (see
// handleUpload below). The asset endpoint serves the cleaned bytes
// inline with a strict CSP; unsanitized legacy SVGs are still
// force-downloaded by the isScriptableMime branch.
const UPLOAD_MIME_WHITELIST = new Set([
    'image/jpeg',
    'image/png',
    'image/gif',
    'image/webp',
    'image/apng',
    'image/svg+xml',
    'video/mp4',
    'video/webm',
]);

const upload = multer({
    storage: multer.memoryStorage(),
    // 25 MB ceiling — high enough for short demo-loop MP4s / animated GIFs
    // (the typical sim.ai-style screen recording is well under this), low
    // enough that we don't silently accept multi-hundred-MB uploads.
    limits: { fileSize: 25 * 1024 * 1024 },
    fileFilter: (req, file, cb) => {
        if (UPLOAD_MIME_WHITELIST.has(file.mimetype)) cb(null, true);
        else cb(new Error(`Unsupported file type: ${file.mimetype}`));
    },
});

// Wrap upload.single('file') so multer errors (LIMIT_FILE_SIZE, fileFilter
// rejections) come back as 400 with a useful message instead of the
// default 500 the upstream client sees today.
function uploadFile(req, res, next) {
    upload.single('file')(req, res, (err) => {
        if (!err) return next();
        const message = err.code === 'LIMIT_FILE_SIZE'
            ? 'File too large (max 25 MB)'
            : (err.message || 'Upload rejected');
        res.status(400).json({ error: message });
    });
}

// Site-import archives. A separate multer instance from `upload` because the
// constraints are different in both directions: no MIME whitelist (a .zip
// arrives as application/zip, application/x-zip-compressed or
// application/octet-stream depending on the browser, so filtering on it only
// produces false rejections — parseZip validates the actual bytes), and a
// far higher ceiling since one archive legitimately carries every image on
// the site.
const SITE_IMPORT_MAX_BYTES = 50 * 1024 * 1024;
const importUpload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: SITE_IMPORT_MAX_BYTES },
});

// Only engages for multipart requests; a JSON body falls through untouched
// so pre-zip .json exports keep importing exactly as before.
function importSiteUpload(req, res, next) {
    if (!String(req.headers['content-type'] || '').includes('multipart/form-data')) {
        return next();
    }
    importUpload.single('file')(req, res, (err) => {
        if (!err) return next();
        const message = err.code === 'LIMIT_FILE_SIZE'
            ? `Archive too large (max ${SITE_IMPORT_MAX_BYTES / 1024 / 1024} MB)`
            : (err.message || 'Upload rejected');
        res.status(400).json({ error: message });
    });
}

// ── Helpers ──────────────────────────────────────────────────────

// synthesizeLegacyContent now lives in core/cms/legacyContent.js so that
// routes/publicRender.js can build the SAME payload it inlines into the
// server-rendered shell. Two implementations would mean the page could
// render one way on first paint and another after hydration.

// ── Shared handler bodies ────────────────────────────────────────
//
// Each handler reads req.siteId (set by attachSiteId or attachSiteIdFromParam)
// and req.params.{id,locale} (where applicable). The same function is wired
// to both /admin/* and /sites/:siteId/* routes below.

async function getSitePayload(req, res) {
    const [payload, locales, liveSiteId] = await Promise.all([
        cmsStore.getAdminPayload(req.siteId),
        languageStore.getAvailableLocales(),
        getLiveSiteId(),
    ]);
    // `enabled` is derived (true iff some site is live). Kept for any
    // legacy panel code still reading it; new code should branch on
    // liveSiteId === activeSiteId to know if *this* site is live.
    res.json({
        ...payload,
        locales,
        enabled: liveSiteId !== null,
        liveSiteId,
    });
}

async function getGraph(req, res) {
    const graph = await cmsStore.getSiteGraph(req.siteId);
    res.json(graph);
}

async function putSiteDoc(req, res) {
    try {
        const { site } = req.body || {};
        if (!site) return res.status(400).json({ error: 'site object required' });
        const saved = await cmsStore.setProject(req.siteId, site);
        res.json({ success: true, site: saved });
    } catch (err) { res.status(400).json({ error: err.message }); }
}

async function putSiteLocale(req, res) {
    try {
        const { override } = req.body || {};
        if (!override) return res.status(400).json({ error: 'override object required' });
        await cmsStore.setSiteLocaleOverride(req.siteId, req.params.locale.toLowerCase(), override);
        res.json({ success: true });
    } catch (err) { res.status(400).json({ error: err.message }); }
}

async function deleteSiteLocale(req, res) {
    await cmsStore.deleteSiteLocaleOverride(req.siteId, req.params.locale.toLowerCase());
    res.json({ success: true });
}

// ── AI auto-translate ────────────────────────────────────────────────
// Pre-fills a page/site locale override by translating the default-locale
// text through the LLM. Existing manual translations are preserved. The
// resulting override is persisted and returned so the editor can fold it in.

// Resolve the human-readable language name for a locale code (for the prompt).
async function localeName(locale) {
    try {
        const locales = await languageStore.getAvailableLocales();
        return locales.find(l => l.code === locale)?.name || locale;
    } catch (_) { return locale; }
}

async function postPageAiTranslate(req, res) {
    const locale = String(req.params.locale || '').toLowerCase();
    const defaultLocale = await cmsStore.getDefaultLocale();
    if (!locale) return res.status(400).json({ error: 'locale required' });
    if (locale === defaultLocale) {
        return res.status(400).json({ error: 'Cannot translate the default locale' });
    }
    const pageDoc = await cmsStore.getPage(req.siteId, req.params.id);
    if (!pageDoc) return res.status(404).json({ error: 'Page not found' });

    const existingOverride = await cmsStore.getPageLocaleOverride(req.siteId, req.params.id, locale);
    const result = await cmsTranslate.aiTranslatePage({
        pageDoc,
        existingOverride,
        modelTier: (req.body || {}).modelTier,
        languageName: await localeName(locale),
        locale,
        // EU-mode / org custom tiers resolve against the requesting admin.
        userId: req.session?.user?.id || null,
        userOrgId: req.session?.user?.organizationId || null,
    });
    await cmsStore.setPageLocaleOverride(req.siteId, req.params.id, locale, result.override);
    res.json({
        success: true,
        override: result.override,
        translated: result.translated,
        total: result.total,
        errors: result.errors,
        message: result.errors > 0
            ? `Translated ${result.translated} fields with ${result.errors} batch error(s)`
            : `Translated ${result.translated} fields`,
    });
}

async function postSiteAiTranslate(req, res) {
    const locale = String(req.params.locale || '').toLowerCase();
    const defaultLocale = await cmsStore.getDefaultLocale();
    if (!locale) return res.status(400).json({ error: 'locale required' });
    if (locale === defaultLocale) {
        return res.status(400).json({ error: 'Cannot translate the default locale' });
    }
    const siteDoc = await cmsStore.getProject(req.siteId);
    if (!siteDoc) return res.status(404).json({ error: 'Site not found' });

    const existingOverride = await cmsStore.getSiteLocaleOverride(req.siteId, locale);
    const result = await cmsTranslate.aiTranslateSite({
        siteDoc,
        existingOverride,
        modelTier: (req.body || {}).modelTier,
        languageName: await localeName(locale),
        locale,
        // EU-mode / org custom tiers resolve against the requesting admin.
        userId: req.session?.user?.id || null,
        userOrgId: req.session?.user?.organizationId || null,
    });
    await cmsStore.setSiteLocaleOverride(req.siteId, locale, result.override);
    res.json({
        success: true,
        override: result.override,
        translated: result.translated,
        total: result.total,
        errors: result.errors,
        message: result.errors > 0
            ? `Translated ${result.translated} fields with ${result.errors} batch error(s)`
            : `Translated ${result.translated} fields`,
    });
}

async function postPage(req, res) {
    try {
        const { slug, title, copyFromId, templateId } = req.body || {};
        const result = await cmsStore.createPage(req.siteId, { slug, title, copyFromId, templateId });
        res.json({ success: true, ...result });
    } catch (err) { res.status(400).json({ error: err.message }); }
}

async function putPagesOrder(req, res) {
    try {
        const { orderedIds } = req.body || {};
        if (!Array.isArray(orderedIds)) return res.status(400).json({ error: 'orderedIds array required' });
        await cmsStore.reorderPages(req.siteId, orderedIds);
        res.json({ success: true });
    } catch (err) { res.status(400).json({ error: err.message }); }
}

async function putPageMeta(req, res) {
    try {
        const updated = await cmsStore.updatePageMeta(req.siteId, req.params.id, req.body || {});
        res.json({ success: true, page: updated });
    } catch (err) { res.status(400).json({ error: err.message }); }
}

async function putPageHomepage(req, res) {
    try {
        await cmsStore.setHomepage(req.siteId, req.params.id);
        res.json({ success: true });
    } catch (err) { res.status(400).json({ error: err.message }); }
}

async function deletePageHandler(req, res) {
    try {
        await cmsStore.removePage(req.siteId, req.params.id);
        res.json({ success: true });
    } catch (err) { res.status(400).json({ error: err.message }); }
}

// ── Page templates (global, org-wide) ────────────────────────────────
// The "apply" path doesn't need its own endpoint — callers pass
// templateId on POST /pages and the store walks the template's blocks
// into the new page with fresh block ids.
async function listTemplates(req, res) {
    const templates = await cmsStore.getTemplates();
    // Strip block payloads from the list response — they can be large
    // and the list view only needs name/description/blockCount/date.
    // The blocks land in the new page via templateId on POST /pages,
    // so the client never needs the blocks array on the list.
    const summary = templates.map(t => ({
        id:          t.id,
        name:        t.name,
        description: t.description || '',
        createdAt:   t.createdAt,
        blockCount:  Array.isArray(t.blocks) ? t.blocks.length : 0,
    }));
    res.json({ templates: summary });
}

async function postTemplate(req, res) {
    try {
        const { name, description, blocks } = req.body || {};
        const entry = await cmsStore.saveTemplate({ name, description, blocks });
        res.json({
            success: true,
            template: {
                id:          entry.id,
                name:        entry.name,
                description: entry.description || '',
                createdAt:   entry.createdAt,
                blockCount:  Array.isArray(entry.blocks) ? entry.blocks.length : 0,
            },
        });
    } catch (err) { res.status(400).json({ error: err.message }); }
}

async function deleteTemplateHandler(req, res) {
    try {
        await cmsStore.deleteTemplate(req.params.id);
        res.json({ success: true });
    } catch (err) { res.status(400).json({ error: err.message }); }
}

async function getPageById(req, res) {
    // Admin/editor read — bypass the per-replica config cache so it never
    // serves a stale page right after a save (see getAdminPayload).
    const page = await cmsStore.getPage(req.siteId, req.params.id, { fresh: true });
    if (!page) return res.status(404).json({ error: 'Page not found' });
    res.json(page);
}

async function putPage(req, res) {
    try {
        const incoming = req.body?.page;
        if (!incoming) return res.status(400).json({ error: 'page object required' });
        // Force the URL id onto the body so callers can't quietly write to a
        // different page than the one they targeted.
        const { page: saved, dropped } = await cmsStore.setPage(req.siteId, { ...incoming, id: req.params.id });
        // `dropped` lets the client warn when unknown-type blocks were stripped
        // on save (otherwise a silent data loss).
        res.json({ success: true, page: saved, dropped });
    } catch (err) { res.status(400).json({ error: err.message }); }
}

async function putPageLocale(req, res) {
    try {
        const { override } = req.body || {};
        if (!override) return res.status(400).json({ error: 'override object required' });
        await cmsStore.setPageLocaleOverride(req.siteId, req.params.id, req.params.locale.toLowerCase(), override);
        res.json({ success: true });
    } catch (err) { res.status(400).json({ error: err.message }); }
}

async function deletePageLocale(req, res) {
    await cmsStore.deletePageLocaleOverride(req.siteId, req.params.id, req.params.locale.toLowerCase());
    res.json({ success: true });
}

// Site-CRUD handlers (no /admin equivalent).

// Export the active site as a downloadable file.
//
// Two formats, both from the SAME v2 bundle (cmsStore.exportSite):
//   zip  (default) — site.json + every referenced asset's bytes. This is the
//                    only form that fully reconstitutes a site elsewhere; the
//                    JSON alone references assets by key and lands with
//                    broken images on any install that isn't sharing the
//                    bucket.
//   json           — the bundle on its own. Reviewable in a diff, and the
//                    right choice for scripting or same-install backups.
//
// Assets that can't be read are reported in the bundle rather than silently
// omitted — an archive that quietly lost three images looks complete.
async function exportSiteHandler(req, res) {
    const format = String(req.query.format || 'zip').toLowerCase();
    if (format !== 'zip' && format !== 'json') {
        return res.status(400).json({ error: "format must be 'zip' or 'json'" });
    }

    const payload = await cmsStore.exportSite(req.siteId);
    const safeName = (payload.site?.name || 'site')
        .toLowerCase()
        .replace(/[^a-z0-9-]+/g, '-')
        .replace(/^-+|-+$/g, '')
        .slice(0, 40) || 'site';
    const dateStr = new Date().toISOString().slice(0, 10);    // YYYY-MM-DD

    if (format === 'json') {
        res.setHeader('Content-Type', 'application/json; charset=utf-8');
        res.setHeader('Content-Disposition', `attachment; filename="site-${safeName}-${dateStr}.json"`);
        // Pretty-print so diffs against re-exports are reviewable. The
        // file is small enough (a few hundred KB max in practice) that
        // the size overhead doesn't matter.
        return res.send(JSON.stringify(payload, null, 2));
    }

    const keys = [...cmsStore.collectAssetKeys(payload)];
    const { assets, missing } = await cmsExportBundle.fetchAssets(keys);
    payload.site.assets = assets.map(a => ({
        key: a.key,
        file: `${cmsExportBundle.ASSET_PREFIX}${a.key}`,
        bytes: a.bytes,
        contentType: a.contentType,
    }));
    if (missing.length) payload.site.assetsMissing = missing;

    const zipBuffer = await cmsExportBundle.buildZip(payload, assets);
    res.setHeader('Content-Type', 'application/zip');
    res.setHeader('Content-Disposition', `attachment; filename="site-${safeName}-${dateStr}.zip"`);
    res.setHeader('Content-Length', String(zipBuffer.length));
    res.send(zipBuffer);
}

// Import a site from an export payload. Generates fresh ids for the
// site, every page, and every block — re-import is always safe and
// never collides with existing data.
//
// Accepts either a multipart .zip (bytes + JSON) or a raw JSON body (the
// pre-zip format, still produced by ?format=json and by every export
// downloaded before this shipped). `req.file` is set by importUpload only
// for the multipart branch.
async function importSiteHandler(req, res) {
    try {
        let exportData = null;
        let assets = [];
        let skippedEntries = [];

        if (req.file?.buffer) {
            const parsed = await cmsExportBundle.parseZip(req.file.buffer);
            exportData = parsed.bundle;
            assets = parsed.assets;
            skippedEntries = parsed.skipped;
        } else {
            exportData = req.body;
        }

        if (!exportData || typeof exportData !== 'object' || Array.isArray(exportData)) {
            return res.status(400).json({ error: 'Request body must be a JSON object' });
        }

        // Assets are restored BEFORE the site so the pages never exist in a
        // state where their media 404s. Restoring is best-effort by design:
        // a site that imports with two unreadable images beats an import
        // that refuses outright.
        const assetResult = assets.length
            ? await cmsExportBundle.restoreAssets(assets)
            : { written: 0, reused: 0, failed: [] };

        const result = await cmsStore.importSite(exportData);
        const warnings = [...(result.warnings || [])];
        if (skippedEntries.length) {
            warnings.push(`${skippedEntries.length} archive entr${skippedEntries.length === 1 ? 'y was' : 'ies were'} ignored (not a CMS asset)`);
        }
        for (const f of assetResult.failed) warnings.push(`Asset not restored: ${f}`);

        res.status(201).json({
            ...result,
            warnings,
            assetsWritten: assetResult.written,
            assetsReused: assetResult.reused,
        });
    } catch (err) {
        log.error('[CMS] import error:', err.message);
        res.status(400).json({ error: err.message });
    }
}

async function listSitesHandler(req, res) {
    const [sites, liveSiteId] = await Promise.all([
        cmsStore.listProjects(),
        getLiveSiteId(),
    ]);
    res.json({ sites, liveSiteId });
}

async function createSiteHandler(req, res) {
    try {
        const { name } = req.body || {};
        const created = await cmsStore.createProject({ name });
        res.status(201).json(created);
    } catch (err) { res.status(400).json({ error: err.message }); }
}

async function renameSiteHandler(req, res) {
    try {
        const { name } = req.body || {};
        if (typeof name !== 'string' || !name.trim()) {
            return res.status(400).json({ error: 'name required' });
        }
        const updated = await cmsStore.renameProject(req.siteId, name.trim());
        res.json({ success: true, site: updated });
    } catch (err) { res.status(400).json({ error: err.message }); }
}

// Duplicate a site into a new version of the same version group. Deep-
// copies the SiteDoc + every PageDoc + every block with fresh ids. The
// copy is never live — live stays on whatever cms_live_site_id points at.
async function duplicateSiteHandler(req, res) {
    try {
        const created = await cmsStore.duplicateProject(req.siteId);
        res.status(201).json(created);
    } catch (err) { res.status(400).json({ error: err.message }); }
}

async function deleteSiteHandler(req, res) {
    try {
        await cmsStore.deleteProject(req.siteId);
        // If the deleted project was the live one, take the public site
        // dark rather than letting getLiveSiteId silently lazy-clear later.
        const liveSiteId = await configStore.getConfig(KEY_CMS_LIVE_SITE_ID);
        if (liveSiteId === req.siteId) {
            await configStore.setConfig(KEY_CMS_LIVE_SITE_ID, null);
        }
        // Drop any analytics website + recorder mapping so resolveAnalyticsTarget
        // can't surface a deleted site's stale Umami data via its fallback path.
        await cmsAnalytics.forgetSite(req.siteId);
        res.json({ success: true });
    } catch (err) { res.status(400).json({ error: err.message }); }
}

async function postSitePublish(req, res) {
    try {
        const result = await cmsStore.publishSite(req.siteId);
        // Best-effort: ensure this site has a Umami website so its public pages
        // have an id to report against. Fire-and-forget so publish stays fast.
        const project = await cmsStore.getProject(req.siteId).catch(() => null);
        provisionAnalyticsForSite(req.siteId, {
            name: project?.name || 'CMS site',
            domain: req.get('host'),
        }).catch(() => {});
        res.json({ success: true, ...result });
    } catch (err) { res.status(400).json({ error: err.message }); }
}

// A site that is Live must always serve a PUBLISHED snapshot — never its
// in-progress draft. Publishing on the Live transition guarantees
// "public == published": once live, later edits stay private until the user
// clicks Publish again. Idempotent + best-effort (a publish hiccup must not
// block the Live toggle; the public route self-heals as a backstop).
async function ensurePublishedSnapshot(siteId) {
    try {
        const snap = await cmsStore.getPublishedSnapshot(siteId, { fresh: true });
        if (!snap) await cmsStore.publishSite(siteId);
    } catch (e) {
        log.warn(`[CMS] ensurePublishedSnapshot failed for ${siteId}: ${e.message}`);
    }
}

async function putSiteLive(req, res) {
    try {
        const { live } = req.body || {};
        if (typeof live !== 'boolean') {
            return res.status(400).json({ error: 'live must be a boolean' });
        }
        if (live) {
            // Setting this site live implicitly takes any other live site
            // offline — only one project can be live at a time.
            await setLiveSiteId(req.siteId);
            // Snapshot now so going Live can't publish a not-yet-published
            // draft to the world (the "toggle Live before first Publish leaks
            // the draft" bug).
            await ensurePublishedSnapshot(req.siteId);
            return res.json({ success: true, liveSiteId: req.siteId });
        }
        // Clearing only matters when *this* site is the currently-live
        // one; otherwise toggling it off is a no-op (avoids accidentally
        // dark-ing the public site from an inactive editor tab).
        const current = await getLiveSiteId();
        if (current === req.siteId) {
            await setLiveSiteId(null);
            return res.json({ success: true, liveSiteId: null });
        }
        res.json({ success: true, liveSiteId: current });
    } catch (err) { res.status(400).json({ error: err.message }); }
}

// Org-wide handlers (only mounted on /admin/*).

async function putEnabled(req, res) {
    const { enabled, siteId } = req.body || {};
    if (typeof enabled !== 'boolean') return res.status(400).json({ error: 'enabled must be a boolean' });
    if (!enabled) {
        // Org-wide off: clear the live id so the public site goes dark.
        await setLiveSiteId(null);
        return res.json({ success: true, enabled: false, liveSiteId: null });
    }
    // Org-wide on: callers may name a specific siteId to make live, or
    // omit it to keep the currently-live one (or fall back to the
    // first project if none has ever been live before).
    if (siteId) {
        const next = await setLiveSiteId(siteId);
        if (next) await ensurePublishedSnapshot(next);
        return res.json({ success: true, enabled: true, liveSiteId: next });
    }
    let next = await getLiveSiteId();
    if (!next) {
        const projects = await cmsStore.listProjects();
        next = projects[0]?.id || null;
        if (next) await setLiveSiteId(next);
    }
    if (next) await ensurePublishedSnapshot(next);
    res.json({ success: true, enabled: next !== null, liveSiteId: next });
}

async function putDefaultLocale(req, res) {
    const { locale } = req.body || {};
    if (!locale || typeof locale !== 'string') return res.status(400).json({ error: 'locale required' });
    const code = locale.trim().toLowerCase();
    // A 400 rather than the store's 500: the store validates too (this
    // value ends up in <html lang> on the public site), but a caller that
    // sends nonsense deserves to be told which field is wrong.
    if (!cmsStore.isValidLocale(code)) return res.status(400).json({ error: 'locale must be a language tag such as "en" or "pt-br"' });
    await cmsStore.setDefaultLocale(code);
    res.json({ success: true, defaultLocale: code });
}

async function handleUpload(req, res) {
    if (!req.file) return res.status(400).json({ error: 'No file provided' });
    if (!storageStore.isAvailable()) return res.status(503).json({ error: 'Storage unavailable' });

    const ext = path.extname(req.file.originalname || '').toLowerCase() || '';
    const safeBase = (req.file.originalname || 'upload')
        .replace(/[^a-zA-Z0-9._-]/g, '_')
        .replace(/\.[^.]+$/, '');
    const filename = `${Date.now()}-${Math.round(Math.random() * 1e9)}-${safeBase}${ext}`;
    const key = `cms/${filename}`;

    // SVGs are sanitized server-side (script / on*= / external href
    // stripped). Only the cleaned bytes ever reach storage, and we
    // tag the object as `sanitized` so the asset endpoint knows it
    // can serve it inline instead of force-downloading. A bad SVG
    // (parse fails, no <svg> root) returns 400 here.
    let body = req.file.buffer;
    let metadata = null;
    if (req.file.mimetype === 'image/svg+xml') {
        const clean = sanitizeSvg(req.file.buffer);
        if (!clean) return res.status(400).json({ error: 'Invalid or unsafe SVG' });
        body = clean;
        metadata = { sanitized: '1' };
    }

    await storageStore.uploadFile(key, body, req.file.mimetype, metadata);

    const url = `/api/cms/asset/${key.split('/').map(encodeURIComponent).join('/')}`;
    res.json({ success: true, key, url });
}

// ── Asset library (read-only) ────────────────────────────────────
//
// GET /api/cms/admin/assets — lists previously uploaded CMS assets for
// the admin asset-reuse picker. Same org-wide bucket prefix the upload
// handler writes to ('cms/<Date.now()>-…'). storageStore.listKeys()
// requires S3 (it throws in the local-fs fallback and during a storage
// outage) — degrade to { assets: [], unavailable: true } so the picker
// can hide its entry point instead of erroring.

const ASSET_LIST_EXT_RE = /\.(png|jpe?g|gif|webp|avif|svg|ico|mp4|webm)$/i;
const ASSET_LIST_MAX = 500;

async function listAssetsHandler(req, res) {
    try {
        const keys = await storageStore.listKeys('cms/');
        const assets = keys
            .filter((k) => ASSET_LIST_EXT_RE.test(k))
            // Keys embed their upload timestamp (cms/<Date.now()>-…), so a
            // numeric-aware descending sort is newest-first.
            .sort((a, b) => b.localeCompare(a, undefined, { numeric: true }))
            .slice(0, ASSET_LIST_MAX)
            .map((key) => ({
                key,
                url: `/api/cms/asset/${key.split('/').map(encodeURIComponent).join('/')}`,
            }));
        res.json({ assets });
    } catch (err) {
        // Local-fs mode or storage outage — not an error for the picker.
        res.json({ assets: [], unavailable: true });
    }
}

// Analytics handlers moved to ./cmsAnalytics.js (mounted below).

// ══════════════════════════════════════════════════════════════════
// PUBLIC
// ══════════════════════════════════════════════════════════════════

/**
 * GET /api/cms/site
 *   v=2 → { enabled, defaultLocale, locale, found, page, header, footer, pages }
 *   no v → legacy shape: { enabled, defaultLocale, locale, content }
 *
 * `?slug=…` selects a page. When omitted the homepage is returned.
 * `?locale=…` picks a locale; falls back to default.
 *
 * Reads from whichever project is currently marked Live (cms_live_site_id).
 * When nothing is live the response is `{ enabled: false }` and the front-end
 * redirects "/" to /app.
 */
// No schema on this query, on purpose: it is the PUBLIC site's own content
// read (App.jsx fetches it on every visit), and a refusal would blank the
// public site instead of serving the default page. Each of the three values
// is read defensively below: an unknown `locale` or `slug` falls back.
router.get('/site', async (req, res) => {
    try {
        // Public site serves whatever project is marked Live. If nothing is
        // live the public URL stays dark (RootPathGate redirects to /app).
        // Note: this is decoupled from the admin's active project — admins
        // can edit a different site without affecting what the public sees.
        const siteId = await getLiveSiteId();
        // Self-hosted installs have no public marketing site — the root domain
        // goes straight to /app. `appOnly` tells RootPathGate to redirect there
        // (it runs outside LicenseProvider so it can't read deployment mode on
        // its own). Emitted on every shape so the flag is present regardless of
        // whether a site is live. The license module is lazy-required (never at
        // module top-level) to preserve boot ordering — it pulls in heavy
        // userStore DB init that must load after this route, not during it.
        const { serverLicenseGovernsOrgs } = require('../license');
        const appOnly = serverLicenseGovernsOrgs();
        // Disable caching here — content updates from the admin should
        // appear immediately. Re-introduce a short TTL once edits push a
        // version bump or cache key.
        res.setHeader('Cache-Control', 'no-store');
        if (!siteId) {
            return res.json({ enabled: false, appOnly });
        }

        const defaultLocale = await cmsStore.getDefaultLocale();
        const locale = (req.query.locale || defaultLocale).toString().toLowerCase().split('-')[0];
        const v2 = req.query.v === '2';
        const slug = (req.query.slug || '').toString();

        // The public site serves the last-published snapshot only — never the
        // in-progress draft. A legacy live site with no snapshot yet (live
        // before publish-on-Live landed) self-heals: freeze its current draft
        // as the snapshot once, then serve that. This keeps such sites from
        // blanking while ensuring later draft edits stay private until Publish.
        let eff = await cmsStore.getEffectivePublished(siteId, slug || null, locale);
        if (!eff) {
            try { await cmsStore.publishSite(siteId); } catch (_) { /* keep serving below */ }
            eff = await cmsStore.getEffectivePublished(siteId, slug || null, locale)
                || await cmsStore.getEffective(siteId, slug || null, locale);
        }

        // Canonical URL for the served page: '' for the homepage, otherwise
        // its slug. The client uses this to redirect e.g. `/home` → `/` so
        // every page has exactly one URL.
        const canonicalSlug = eff.page?.isHomepage
            ? ''
            : (eff.page?.slug || '');

        // Analytics tracker config. Umami keys (websiteId / scriptUrl /
        // consentMode) are emitted top-level — only when tracking is on,
        // configured, and THIS live site has a provisioned Umami website.
        // The client injects a tiny async <script> (cookieless by default)
        // so page load stays fast. Best-effort: never let an analytics
        // hiccup break the public render.
        let analytics = null;
        try {
            const aSettings = await getAnalyticsSettings();
            if (aSettings.enabled && aSettings.url) {
                const websiteId = (await getAnalyticsSiteMap())[siteId];
                if (websiteId) {
                    const base = aSettings.url.replace(/\/+$/, '');
                    analytics = {
                        websiteId,
                        scriptUrl: `${base}/script.js`,
                        consentMode: aSettings.consentMode,
                        // Mirrored onto the <script> tag. /site is no-store, so
                        // changing an option applies on the visitor's next page
                        // load — no republish needed.
                        trackerOptions: await cmsAnalytics.getTrackerOptions(),
                    };
                    // Session recording (heatmaps + replays) is a separate,
                    // per-site opt-in. Emitting the url does NOT mean it loads:
                    // the client gates the recorder on cookie-banner consent in
                    // EVERY consent mode, because recording a visitor's mouse,
                    // scroll and DOM is not cookieless-innocent the way a
                    // pageview count is.
                    if ((await getRecorderMap())[siteId]) {
                        analytics.recorderUrl = `${base}/recorder.js`;
                    }
                }
            }
        } catch (e) { log.warn('[CMS] /site analytics config skipped:', e.message); }
        // Site-level Google Analytics + per-page opt-out ride in the same
        // envelope. `ga` is null unless the site carries a valid measurement
        // id (sanitized on save by cmsStore.sanitizeAnalytics; resolveEffective
        // threads it through the published snapshot as eff.analytics), and
        // `disabledForPage` reflects the served page's noAnalytics flag. The
        // envelope is non-null when Umami OR GA is configured — a GA-only org
        // gets `{ ga, disabledForPage }` without the Umami keys — and stays
        // null when neither is.
        const ga = eff.analytics?.gaMeasurementId
            ? { measurementId: eff.analytics.gaMeasurementId }
            : null;
        if (analytics || ga) {
            analytics = {
                ...(analytics || {}),
                ga,
                disabledForPage: !!eff.page?.noAnalytics,
            };
        }

        if (v2) {
            return res.json({
                enabled: true,
                appOnly,
                defaultLocale,
                locale,
                found: eff.found,
                canonicalSlug,
                page: eff.page,
                header: eff.header,
                footer: eff.footer,
                pages: eff.pages,
                design: eff.design,
                analytics,
            });
        }
        return res.json({
            enabled: true,
            appOnly,
            // `found` lets the front-end distinguish "slug exists but has no
            // blocks" (render anyway) from "slug doesn't match any page"
            // (fall through to the BeeFlow app router) when path-routing.
            found: eff.found,
            canonicalSlug,
            defaultLocale,
            locale,
            content: synthesizeLegacyContent(eff),
            design: eff.design,
            analytics,
        });
    } catch (err) {
        log.error('[CMS] /site error:', err.message);
        res.status(500).json({ error: 'Failed to load CMS content' });
    }
});

// MIME types that browsers would happily execute as script in the page
// origin if served inline. The upload whitelist already blocks new
// SVG/HTML uploads, but pre-existing assets and any future expansion of
// the whitelist must NOT be able to surprise us — so we force-download
// these by setting Content-Disposition: attachment regardless of what
// the storage layer reports.
const SCRIPTABLE_MIME_PREFIXES = ['image/svg', 'text/html', 'text/xml', 'application/xhtml', 'application/xml'];
function isScriptableMime(mime) {
    if (typeof mime !== 'string') return false;
    const lower = mime.toLowerCase();
    return SCRIPTABLE_MIME_PREFIXES.some(p => lower.startsWith(p));
}

router.get(/^\/asset\/(.+)$/, async (req, res) => {
    try {
        const key = req.params[0];
        if (!key.startsWith('cms/')) return res.status(404).json({ error: 'Not found' });
        if (!storageStore.isAvailable()) return res.status(503).json({ error: 'Storage unavailable' });

        const { stream, contentType, contentLength, metadata } = await storageStore.streamFile(key);
        const sanitized = metadata && (metadata.sanitized === '1' || metadata.Sanitized === '1');

        // Defense in depth: if the stored Content-Type would execute in
        // the browser when served inline (SVG, HTML, XML), force the
        // browser to download it — UNLESS it's a sanitized SVG, in which
        // case we serve it inline with a strict CSP that blocks scripts
        // and external network fetches even if the sanitizer ever
        // misses something. Legacy SVGs without the `sanitized` flag
        // still force-download.
        if (isScriptableMime(contentType)) {
            if (sanitized && /^image\/svg/i.test(contentType)) {
                res.setHeader('Content-Type', 'image/svg+xml');
                res.setHeader('Content-Security-Policy',
                    "default-src 'none'; style-src 'unsafe-inline'");
                res.setHeader('X-Content-Type-Options', 'nosniff');
            } else {
                res.setHeader('Content-Type', 'application/octet-stream');
                res.setHeader('Content-Disposition', 'attachment');
                res.setHeader('X-Content-Type-Options', 'nosniff');
            }
        } else {
            res.setHeader('Content-Type', contentType);
        }
        if (contentLength) res.setHeader('Content-Length', contentLength);
        res.setHeader('Cache-Control', 'public, max-age=3600');
        stream.pipe(res);
    } catch (err) {
        if (err.name === 'NoSuchKey' || err.$metadata?.httpStatusCode === 404) {
            return res.status(404).json({ error: 'Asset not found' });
        }
        log.error('[CMS] /asset error:', err.message);
        res.status(500).json({ error: 'Failed to load asset' });
    }
});

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

// Test seam — lets routes/cms.public.test.js exercise the legacy content
// synthesis (nav/dropdown display mapping) directly, without HTTP. Same
// pattern as routes/ai/cmsBuilder.js. Not part of the route surface.
router._test = { synthesizeLegacyContent };

module.exports = router;
