// @typecheck
/**
 * CMS site management (the /sites routes with no /admin equivalent): list,
 * create, rename, duplicate and delete sites, and export / import a site as a
 * .zip archive or a JSON bundle, with the upload middleware the import needs.
 *
 * Extracted verbatim from routes/cms.js, which still owns the router, the
 * rate limiters and the mount order (/sites/import before the :siteId gate).
 */

const multer = require('multer');
const bodyParser = require('body-parser');
const log = require('../telemetry/log');
const cmsStore = require('../stores/cmsStore');
const cmsExportBundle = require('../core/cms/cmsExportBundle');
const configStore = require('../stores/configStore');
const { getLiveSiteId, KEY_CMS_LIVE_SITE_ID } = require('./cmsShared');
const cmsAnalytics = require('./cmsAnalytics');
const { HttpError } = require('../core/http/errors');

// Per-route body parser for /sites/import — caps the JSON payload at
// 2 MB. The global parser is 20 MB which is fine for chat/agent runs
// but too permissive for site imports (a real export is well under
// 500 KB). Caps memory pressure when a compromised admin session sends
// a deeply-nested or zip-bombed JSON.
const importJsonParser = bodyParser.json({ limit: '2mb' });

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
        throw new HttpError(400, 'bad_request', err.message);
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
    } catch (err) { throw new HttpError(400, 'bad_request', err.message); }
}

async function renameSiteHandler(req, res) {
    try {
        const { name } = req.body || {};
        if (typeof name !== 'string' || !name.trim()) {
            return res.status(400).json({ error: 'name required' });
        }
        const updated = await cmsStore.renameProject(req.siteId, name.trim());
        res.json({ success: true, site: updated });
    } catch (err) { throw new HttpError(400, 'bad_request', err.message); }
}

// Duplicate a site into a new version of the same version group. Deep-
// copies the SiteDoc + every PageDoc + every block with fresh ids. The
// copy is never live — live stays on whatever cms_live_site_id points at.
async function duplicateSiteHandler(req, res) {
    try {
        const created = await cmsStore.duplicateProject(req.siteId);
        res.status(201).json(created);
    } catch (err) { throw new HttpError(400, 'bad_request', err.message); }
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
    } catch (err) { throw new HttpError(400, 'bad_request', err.message); }
}
module.exports = {
    importJsonParser,
    SITE_IMPORT_MAX_BYTES,
    importSiteUpload,
    exportSiteHandler,
    importSiteHandler,
    listSitesHandler,
    createSiteHandler,
    renameSiteHandler,
    duplicateSiteHandler,
    deleteSiteHandler,
};
