/**
 * CMS route shared middleware — mechanical extraction from routes/cms.js so
 * the CMS AI builder route (routes/ai/cmsBuilder.js) and the analytics router
 * (routes/cmsAnalytics.js) can reuse the exact same admin gate, siteId
 * validation and live-site resolution without importing the whole CMS router
 * (which would be circular). Zero behavior change: cms.js imports these back.
 */

'use strict';

const cmsStore = require('../stores/cmsStore');
const configStore = require('../stores/configStore');
const { hasPermission } = require('../auth/permissions');
const log = require('../telemetry/log');

const SITE_ID_RE = /^pj_[a-f0-9]{4,}$/;

const KEY_CMS_LIVE_SITE_ID = 'cms_live_site_id';
const KEY_CMS_ENABLED      = 'cms_enabled';   // legacy, read-only after migration

/**
 * The CMS admin test, as a function: an admin session/role, or the 'all'
 * permission. requireAdmin applies it to the session of a request; the CMS MCP
 * server applies it to the user its token belongs to, so a token can never do
 * more to the website than that user could in the admin panel.
 * @param {{ isAdmin?: boolean, user?: { id?: string, role?: string } }} session
 */
async function canAdminCms(session) {
    if (!session?.user) return false;
    if (session.isAdmin || session.user.role === 'admin') return true;
    const userId = session.user.id;
    return !!(userId && await hasPermission(userId, 'all', session));
}

async function requireAdmin(req, res, next) {
    if (!req.session?.user) return res.status(401).json({ error: 'Unauthorized' });
    if (await canAdminCms(req.session)) return next();
    return res.status(403).json({ error: 'Admin access required' });
}

async function attachSiteIdFromParam(req, res, next) {
    try {
        const { siteId } = req.params;
        if (!siteId || !SITE_ID_RE.test(siteId)) {
            return res.status(400).json({ error: 'Invalid siteId format' });
        }
        const project = await cmsStore.getProject(siteId);
        if (!project) return res.status(404).json({ error: 'Site not found' });
        req.siteId = siteId;
        next();
    } catch (err) {
        log.error('[CMS] siteId param resolution failed:', err.message);
        res.status(500).json({ error: 'Failed to resolve site' });
    }
}

async function getLiveSiteId() {
    const stored = await configStore.getConfig(KEY_CMS_LIVE_SITE_ID);
    if (typeof stored === 'string' && SITE_ID_RE.test(stored)) {
        // Validate the project still exists; clear stale ids defensively.
        const project = await cmsStore.getProject(stored).catch(() => null);
        if (project) return stored;
        await configStore.setConfig(KEY_CMS_LIVE_SITE_ID, null);
        return null;
    }
    if (stored !== undefined && stored !== null) return null;

    // Lazy migration: legacy cms_enabled flag → adopt projects[0] if true.
    const legacyEnabled = await configStore.getConfig(KEY_CMS_ENABLED);
    if (legacyEnabled === true) {
        const projects = await cmsStore.listProjects();
        const adopted = projects[0]?.id || null;
        await configStore.setConfig(KEY_CMS_LIVE_SITE_ID, adopted);
        return adopted;
    }
    return null;
}

async function setLiveSiteId(siteId) {
    if (siteId === null) {
        await configStore.setConfig(KEY_CMS_LIVE_SITE_ID, null);
        return null;
    }
    if (typeof siteId !== 'string' || !SITE_ID_RE.test(siteId)) {
        throw new Error('Invalid siteId');
    }
    const project = await cmsStore.getProject(siteId);
    if (!project) throw new Error('Site not found');
    await configStore.setConfig(KEY_CMS_LIVE_SITE_ID, siteId);
    return siteId;
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

module.exports = {
    requireAdmin,
    canAdminCms,
    ensurePublishedSnapshot,
    attachSiteIdFromParam,
    SITE_ID_RE,
    getLiveSiteId,
    setLiveSiteId,
    KEY_CMS_LIVE_SITE_ID,
    KEY_CMS_ENABLED,
};
