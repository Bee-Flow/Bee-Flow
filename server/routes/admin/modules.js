/**
 * Admin Platform Modules — instance-level import/remove of modular features,
 * plus the Hub marketplace / connect / purchase / install surface for
 * DOWNLOADABLE remote modules.
 *
 * Built-in (local catalog) modules:
 *   GET  /api/admin/modules            → { modules: [row] }
 *   POST /api/admin/modules/:id/import → { ok, module } | 404 | 409
 *   POST /api/admin/modules/:id/remove → { ok, module } | 404
 *
 * Remote (Hub) modules:
 *   GET  /marketplace                  → { connected, hubUrl, stale?, modules, nextCursor } | 502
 *   POST /connect { hubUrl? }          → { ok, connection } | 409 | 502
 *   POST /disconnect                   → { ok }
 *   POST /:id/purchase                 → { ok, status|checkoutUrl, purchaseId? } | 402 | 409 | 502
 *   POST /entitlements/refresh         → { ok, entitledModuleIds }
 *   POST /:id/install                  → 202 { ok } | 402 | 409 | 502
 *   GET  /:id/install-progress         → { phase, pct?, error? } | 404
 *   POST /:id/update                   → { ok, requiresRestart? } | 402 | 502
 *
 * Runtime operations (M1 — fixed paths registered BEFORE /:id/* params):
 *   GET  /health                       → hub/refresher/reconciler + per-module topology
 *   GET  /audit?moduleId=&limit=       → lifecycle audit rows
 *   GET  /:id/health                   → one module's health row
 *   GET  /:id/logs?limit=&level=       → { logs, replica } from the ring buffer
 *   POST /:id/reactivate               → re-enable a quarantined module
 *
 * Remove is a POST, not DELETE, because it is NON-destructive: it flips the
 * platform_modules state row only — the module's own tables/data are kept so
 * a re-import restores everything. Mounted at /api/admin/modules.
 */

const express = require('express');
const log = require('../../telemetry/log');
const router = express.Router();

const modules = require('../../modules');
const hubClient = require('../../modules/hubClient');
const remoteCatalog = require('../../modules/remoteCatalog');
const packageLoader = require('../../modules/packageLoader');
const entitlementRefresh = require('../../modules/entitlementRefresh');
const platformModuleStore = require('../../stores/platformModuleStore');
const { requireSuperAdmin } = require('../../auth/permissions');
const { validate } = require('../../core/http/validate');
const { z } = require('zod');

// -- What a caller may send ------------------------------------------
//
// Two fall-backs on this router changed what the instance DOES, under a 200:
//
//   - `PATCH /:id/update-policy` read `channel === 'beta' ? 'beta' : 'stable'`
//     and `['major','minor'].includes(pin) ? pin : 'none'`. So `channel:'Beta'`
//     kept the module on stable, and `pin:'patch'` stored NO pin at all -- an
//     operator who asked to hold a module on its major line got one that
//     follows every release, and the row came back "saved" either way.
//   - `GET /:id/logs?level=warning` filtered the ring buffer on a level that
//     does not exist, so the dialog showed an empty list -- read as "this
//     module has logged nothing", which is a claim, not a filter result.
//
// Two bodies stay OPEN on purpose and say so where they are registered:
// `/sideload` carries raw package bytes, and `/:id/offline-grant` carries a
// .bfgrant document that packageLoader verifies by signature.

/** A string whose every refusal -- including "you left it out" -- is a sentence. */
const worded = (message) => z.string({ required_error: message, invalid_type_error: message });

/** A body that also accepts no body at all: Express 5 leaves `req.body` undefined then. */
const bodyOf = (shape) => z.preprocess((v) => (v === undefined || v === null ? {} : v), z.object(shape).strict());

const one = (name, what) => worded(`${name} is ${what}.`).trim().optional();
const whole = (name) => z.coerce.number({ invalid_type_error: `${name} must be a number.` })
    .int(`${name} must be a whole number.`).optional();
const idList = (name) => z.array(
    worded(`${name} is a list of permission ids.`).trim().min(1, `${name} is a list of permission ids.`),
    { invalid_type_error: `${name} is a list of permission ids.` },
).optional();

const LEVELS = ['debug', 'info', 'warn', 'error', 'system'];
const LEVEL_TEXT = `level is one of: ${LEVELS.join(', ')}.`;
const CHANNEL_TEXT = 'channel is "stable" or "beta".';
const PIN_TEXT = 'pin is "none", "major" or "minor".';

const AuditQuery = z.object({ moduleId: one('moduleId', 'a module id'), limit: whole('limit') }).strict();
const LogsQuery = z.object({
    limit: whole('limit'),
    level: z.enum(LEVELS, { errorMap: () => ({ message: LEVEL_TEXT }) }).optional(),
}).strict();
const MarketplaceQuery = z.object({
    q: one('q', 'a search term'),
    category: one('category', 'a category'),
    cursor: one('cursor', 'the value a previous page returned as nextCursor'),
    limit: whole('limit'),
}).strict();
/** The one query that travels beside a raw body, so it is named here. */
const SideloadQuery = z.object({ acceptedPermissions: one('acceptedPermissions', 'a comma-separated list of permission ids') }).strict();

const ConnectBody = bodyOf({ hubUrl: one('hubUrl', 'the address of a module hub') });
const PurchaseBody = bodyOf({
    priceId: one('priceId', 'a price id'),
    // The hub's own spelling; both have always been accepted here.
    price_id: one('price_id', 'a price id'),
    successUrl: one('successUrl', 'the address to return to after paying'),
    cancelUrl: one('cancelUrl', 'the address to return to after cancelling'),
});
const InstallBody = bodyOf({ version: one('version', 'a version'), acceptedPermissions: idList('acceptedPermissions') });
const UpdateBody = bodyOf({ acceptedPermissions: idList('acceptedPermissions') });
const VersionBody = bodyOf({ version: one('version', 'a version') });
const RollbackBody = bodyOf({
    version: one('version', 'a version'),
    force: z.boolean({ invalid_type_error: 'force is true or false.' }).optional(),
});
const UpdatePolicyBody = bodyOf({
    channel: z.enum(['stable', 'beta'], { errorMap: () => ({ message: CHANNEL_TEXT }) }).default('stable'),
    pin: z.enum(['none', 'major', 'minor'], { errorMap: () => ({ message: PIN_TEXT }) }).default('none'),
});

// Map a HubError onto the PRODUCT ADMIN API's HTTP vocabulary. Everything the
// caller can't act on collapses to 502 { error: hub_unavailable, detail }.
function mapHubError(e, res) {
    switch (e && e.code) {
        case 'not_connected': return res.status(409).json({ error: 'not_connected' });
        case 'already_connected': return res.status(409).json({ error: 'already_connected' });
        case 'not_entitled': return res.status(402).json({ error: 'not_entitled' });
        case 'already_entitled': return res.status(409).json({ error: 'already_entitled' });
        case 'checksum_mismatch': return res.status(502).json({ error: 'hub_unavailable', detail: 'checksum_mismatch' });
        case 'hub_denied':
        case 'hub_unavailable': return res.status(502).json({ error: 'hub_unavailable', detail: e.detail || e.message });
        default:
            log.error('[Modules] hub error:', e && e.message);
            return res.status(502).json({ error: 'hub_unavailable', detail: e && e.message });
    }
}

// Platform operator ONLY. Deliberately NOT auth/permissions.requireAdmin or the
// legalRoutes-style requireAdmin — those admit org admins who merely hold the
// 'all' permission via a group or custom role, and module import/remove
// reshapes the whole instance.
//
// This was a local copy until the canonical gate landed in auth/permissions.js;
// the shared one is byte-identical in behaviour and additionally carries a
// gateMeta tag, so auth/routeWalk.cli.js can see what it enforces.

router.get('/', requireSuperAdmin, async (req, res) => {
    res.json({ modules: await modules.listModulesWithStatus() });
});

// ── Runtime operations (M1) — fixed paths first ─────────────────────────────
async function moduleHealthRow(moduleId, runtimeHealth, ledgerRows, stateRow) {
    const ledger = (ledgerRows || []).find(r => r.status === 'active')
        || (ledgerRows || [])[0] || null;
    const staged = (ledgerRows || []).find(r => r.status === 'staged') || null;
    const h = (runtimeHealth.modules && runtimeHealth.modules[moduleId]) || {};
    const ent = remoteCatalog.entitlementState(stateRow || null);
    return {
        moduleId,
        ledgerStatus: ledger ? ledger.status : null,
        version: (h.version) || (ledger ? ledger.version : null),
        running: !!h.running,
        pendingRestart: !!staged,
        source: ledger ? ledger.source : null,
        entitlement: stateRow ? { state: ent.state, kind: (stateRow.settings?.entitlement?.kind) || null, exp: ent.exp } : null,
        lastActivationError: h.lastActivationError || null,
        crashesInWindow: h.crashesInWindow || 0,
        disposeTimeouts: h.disposeTimeouts || 0,
        restartAdvised: !!h.restartAdvised,
        capabilityConflicts: h.capabilityConflicts || [],
        healTerminal: h.healTerminal || null,
    };
}

router.get('/health', requireSuperAdmin, async (req, res) => {
    const runtimeHealth = packageLoader.getRuntimeHealth();
    const conn = await hubClient.getConnection();
    let rows = [];
    try { rows = await platformModuleStore.getAllStates(); } catch (_) { rows = []; }
    const remoteRows = rows.filter(r => remoteCatalog.isRemoteRow(r));
    const pkgStore = require('../../stores/platformModulePackageStore');
    const perModule = [];
    for (const r of remoteRows) {
        let ledgerRows = [];
        try { ledgerRows = await pkgStore.listForModule(r.moduleId); } catch (_) {}
        perModule.push(await moduleHealthRow(r.moduleId, runtimeHealth, ledgerRows, r));
    }
    res.json({
        hub: conn,
        refresher: entitlementRefresh.getHealth(),
        runtime: { replica: runtimeHealth.replica, dispatchedCount: runtimeHealth.dispatchedCount, reconciler: runtimeHealth.reconciler, limits: runtimeHealth.limits, boot: runtimeHealth.reconciler.boot },
        modules: perModule,
    });
});

router.get('/audit', requireSuperAdmin, validate({ query: AuditQuery }), async (req, res) => {
    const userStore = require('../../stores/userStore');
    const limit = Math.max(1, Math.min(500, req.query.limit || 100));
    const rows = await userStore.getAccessAuditLog({
        targetType: 'platform_module',
        targetId: req.query.moduleId || undefined,
        limit,
    });
    res.json({ audit: rows });
});

router.get('/:id/health', requireSuperAdmin, async (req, res) => {
    const id = req.params.id;
    const runtimeHealth = packageLoader.getRuntimeHealth();
    const pkgStore = require('../../stores/platformModulePackageStore');
    let ledgerRows = [];
    try { ledgerRows = await pkgStore.listForModule(id); } catch (_) {}
    let stateRow = null;
    try { stateRow = await platformModuleStore.getState(id); } catch (_) {}
    if (!ledgerRows.length && !stateRow && !(runtimeHealth.modules && runtimeHealth.modules[id])) {
        return res.status(404).json({ error: 'not_found' });
    }
    res.json(await moduleHealthRow(id, runtimeHealth, ledgerRows, stateRow));
});

router.get('/:id/logs', requireSuperAdmin, validate({ query: LogsQuery }), (req, res) => {
    const logBuffer = require('../../modules/moduleLogBuffer');
    const logs = logBuffer.get(req.params.id, {
        limit: req.query.limit || 200,
        level: req.query.level || null,
    });
    res.json({ logs, replica: packageLoader.getRuntimeHealth().replica });
});

router.post('/:id/reactivate', requireSuperAdmin, async (req, res, next) => {
    try {
        const r = await packageLoader.reactivateModule(req.params.id, { actorId: req.session.user?.id || null });
        res.json({ ok: true, version: r.version });
    } catch (e) {
        if (e && e.code === 'not_quarantined') return res.status(409).json({ error: 'not_quarantined' });
        if (e && e.code) return mapHubError(e, res);
        log.error('[Modules] reactivate error:', e.message);
        next(e);
    }
});

// ── Hub marketplace / connection ───────────────────────────────────────────
router.get('/marketplace', requireSuperAdmin, validate({ query: MarketplaceQuery }), async (req, res, next) => {
    try {
        const conn = await hubClient.getConnection();
        const q = req.query.q || '';
        const category = req.query.category || '';
        const cursor = req.query.cursor || '';
        const limit = Math.max(0, Math.min(200, req.query.limit || 0));
        const { modules: rows, nextCursor, stale } = await remoteCatalog.listMarketplace({ q, category, cursor, limit });
        res.json({ connected: conn.connected, hubUrl: conn.hubUrl, stale, modules: rows, nextCursor });
    } catch (e) {
        if (e && e.code) return mapHubError(e, res);
        log.error('[Modules] marketplace error:', e.message);
        next(e);
    }
});

// Module detail — hub detail joined with local install state (drawer payload).
// Built defensively: a v1 hub omits readme/media/permissions/versions and the
// drawer must still render.
router.get('/marketplace/:id', requireSuperAdmin, async (req, res, next) => {
    try {
        const id = req.params.id;
        const detail = await hubClient.fetchCatalogEntry(id);
        const hm = (detail && detail.module) || null;
        if (!hm || !hm.module_id) return res.status(404).json({ error: 'not_found' });

        let row = null;
        try { row = await platformModuleStore.getState(id); } catch (_) {}
        const base = remoteCatalog.marketplaceRow({ ...hm, versions: detail.versions || hm.versions }, row);

        let ledgerVersions = [];
        try { ledgerVersions = await packageLoader.listVersions(id); } catch (_) {}

        res.json({
            ...base,
            readme: hm.readme || detail.readme || null,
            media: Array.isArray(hm.media || detail.media) ? (hm.media || detail.media) : [],
            permissions: Array.isArray(hm.permissions) ? hm.permissions : [],
            capabilities: Array.isArray(hm.capabilities) ? hm.capabilities : [],
            versions: Array.isArray(detail.versions || hm.versions) ? (detail.versions || hm.versions) : [],
            ledgerVersions,
            grantedPermissions: (row && row.settings && row.settings.grantedPermissions) || null,
        });
    } catch (e) {
        if (e && e.code) return mapHubError(e, res);
        log.error('[Modules] marketplace detail error:', e.message);
        next(e);
    }
});

// Media proxy — the SPA never talks to the hub directly.
router.get('/marketplace/:id/media/:mediaId', requireSuperAdmin, async (req, res) => {
    try {
        const base = await hubClient.resolveHubUrl();
        const url = `${base}/hub/v1/catalog/${encodeURIComponent(req.params.id)}/media/${encodeURIComponent(req.params.mediaId)}`;
        const upstream = await fetch(url, { signal: AbortSignal.timeout(10_000) });
        if (!upstream.ok) return res.status(upstream.status === 404 ? 404 : 502).json({ error: 'not_found' });
        const type = upstream.headers.get('content-type') || 'application/octet-stream';
        if (!/^image\//i.test(type)) return res.status(415).json({ error: 'unsupported_media_type' });
        res.setHeader('Content-Type', type);
        res.setHeader('Cache-Control', 'public, max-age=86400, immutable');
        res.send(Buffer.from(await upstream.arrayBuffer()));
    } catch (e) {
        res.status(502).json({ error: 'hub_unavailable' });
    }
});

router.post('/connect', requireSuperAdmin, validate({ body: ConnectBody }), async (req, res, next) => {
    try {
        const connection = await hubClient.connect({ hubUrl: req.body?.hubUrl });
        res.json({ ok: true, connection });
    } catch (e) {
        if (e && e.code) return mapHubError(e, res);
        log.error('[Modules] connect error:', e.message);
        next(e);
    }
});

router.post('/disconnect', requireSuperAdmin, async (req, res) => {
    await hubClient.disconnect();
    res.json({ ok: true });
});

router.post('/entitlements/refresh', requireSuperAdmin, async (req, res, next) => {
    try {
        await entitlementRefresh.tick();
        let rows = [];
        try { rows = await platformModuleStore.getAllStates(); } catch (_) { rows = []; }
        const entitledModuleIds = rows
            .filter(r => remoteCatalog.isRemoteRow(r) && remoteCatalog.isEntitled(r, { now: Date.now() }))
            .map(r => r.moduleId);
        res.json({ ok: true, entitledModuleIds });
    } catch (e) {
        if (e && e.code) return mapHubError(e, res);
        log.error('[Modules] entitlements refresh error:', e.message);
        next(e);
    }
});

router.post('/:id/import', requireSuperAdmin, async (req, res) => {
    const result = await modules.importModule(req.params.id, { actorId: req.session.user?.id || null });
    if (!result.ok) {
        if (result.error === 'not_found') return res.status(404).json({ error: 'not_found' });
        if (result.error === 'module_unavailable') return res.status(409).json({ error: 'module_unavailable' });
        if (result.error === 'not_entitled') return res.status(402).json({ error: 'not_entitled' });
        return res.status(500).json({ error: result.error });
    }
    res.json({ ok: true, module: result.module });
});

router.post('/:id/remove', requireSuperAdmin, async (req, res) => {
    const result = await modules.removeModule(req.params.id, { actorId: req.session.user?.id || null });
    if (!result.ok) {
        if (result.error === 'not_found') return res.status(404).json({ error: 'not_found' });
        return res.status(500).json({ error: result.error });
    }
    res.json({ ok: true, module: result.module });
});

// ── Remote-module purchase / install / update ──────────────────────────────
router.post('/:id/purchase', requireSuperAdmin, validate({ body: PurchaseBody }), async (req, res, next) => {
    try {
        let priceId = req.body?.priceId || req.body?.price_id || null;
        if (!priceId) {
            // Default to the module's first advertised price.
            const { modules: rows } = await remoteCatalog.listMarketplace({});
            const row = rows.find(m => m.id === req.params.id);
            priceId = row && row.prices && row.prices[0] && row.prices[0].price_id;
            if (!priceId) return res.status(404).json({ error: 'not_found' });
        }
        const result = await hubClient.createPurchase({
            moduleId: req.params.id,
            priceId,
            successUrl: req.body?.successUrl || null,
            cancelUrl: req.body?.cancelUrl || null,
        });
        if (result && result.status === 'active') {
            // Free price — entitled immediately (no checkout).
            return res.json({ ok: true, status: 'active', entitlement: result.entitlement || null });
        }
        return res.json({ ok: true, checkoutUrl: result.checkout_url || null, purchaseId: result.purchase_id || null });
    } catch (e) {
        if (e && e.code) return mapHubError(e, res);
        log.error('[Modules] purchase error:', e.message);
        next(e);
    }
});

router.post('/:id/install', requireSuperAdmin, validate({ body: InstallBody }), async (req, res) => {
    const id = req.params.id;
    if (packageLoader.isInstalling(id)) return res.status(409).json({ error: 'install_in_progress' });
    // Fire-and-forget: the client polls GET /:id/install-progress. Errors
    // (not_entitled / checksum / incompatible / hub outage) surface as the
    // progress `error` phase.
    packageLoader.installFromHub(id, {
        version: req.body?.version || null,
        actorId: req.session.user?.id || null,
        // mv2 consent: ids the operator accepted in the permission dialog. A
        // signed package needing more than granted ∪ accepted lands in the
        // progress `error` phase as consent_required + detail.missingPermissions.
        acceptedPermissions: req.body.acceptedPermissions || null,
    })
        .catch(err => log.warn(`[Modules] install ${id} failed:`, err.message));
    res.status(202).json({ ok: true });
});

router.get('/:id/install-progress', requireSuperAdmin, async (req, res) => {
    // Memory first, then the durable install store (another replica may own
    // the install).
    const progress = await packageLoader.getInstallProgress(req.params.id);
    if (!progress) return res.status(404).json({ error: 'not_found' });
    res.json(progress);
});

router.post('/:id/update', requireSuperAdmin, validate({ body: UpdateBody }), async (req, res, next) => {
    try {
        const r = await packageLoader.updateModule(req.params.id, {
            actorId: req.session.user?.id || null,
            acceptedPermissions: req.body.acceptedPermissions || null,
        });
        res.json({ ok: true, version: r.version, requiresRestart: !!r.requiresRestart });
    } catch (e) {
        if (e && e.code === 'consent_required') {
            return res.status(409).json({ error: 'consent_required', missingPermissions: e.missingPermissions || [] });
        }
        if (e && e.code) return mapHubError(e, res);
        log.error('[Modules] update error:', e.message);
        next(e);
    }
});

// Per-module update policy: which release channel to follow and how tightly
// to pin (none | major | minor). Consumed by updateModule + marketplaceRow.
router.patch('/:id/update-policy', requireSuperAdmin, validate({ body: UpdatePolicyBody }), async (req, res) => {
    const { channel, pin } = req.body;
    const row = await platformModuleStore.getState(req.params.id);
    if (!row || !remoteCatalog.isRemoteRow(row)) return res.status(404).json({ error: 'not_found' });
    await platformModuleStore.mergeSettings(req.params.id, { updatePolicy: { channel, pin } });
    modules.invalidateCache();
    res.json({ ok: true, updatePolicy: { channel, pin } });
});

// ── Enterprise: sideload / offline grants / versions / rollback (M3) ────────
const SIDELOAD_MAX_BYTES = 200 * 1024 * 1024;

// The BODY here is the package itself -- raw .bfmod bytes, not a document a
// schema can describe. Only the query beside it is named.
router.post('/sideload', requireSuperAdmin,
    express.raw({ type: ['application/octet-stream', 'application/zip'], limit: SIDELOAD_MAX_BYTES }),
    validate({ query: SideloadQuery }),
    async (req, res, next) => {
        try {
            if (!Buffer.isBuffer(req.body) || req.body.length === 0) {
                return res.status(400).json({ error: 'empty_package' });
            }
            const r = await packageLoader.sideloadFromBuffer(req.body, {
                actorId: req.session.user?.id || null,
                acceptedPermissions: req.query.acceptedPermissions
                    ? req.query.acceptedPermissions.split(',').map((x) => x.trim()).filter(Boolean)
                    : null,
            });
            res.json({ ok: true, version: r.version, requiresRestart: !!r.requiresRestart });
        } catch (e) {
            if (e && e.code === 'offline_grant_required') return res.status(402).json({ error: 'offline_grant_required' });
            if (e && e.code === 'consent_required') return res.status(409).json({ error: 'consent_required', missingPermissions: e.missingPermissions || [] });
            if (e && e.code === 'module_id_conflict') return res.status(409).json({ error: 'module_id_conflict' });
            if (e && e.code === 'install_in_progress') return res.status(409).json({ error: 'install_in_progress' });
            if (e && e.code === 'package_verify_failed') return res.status(400).json({ error: 'package_verify_failed', detail: e.detail || null });
            if (e && e.compat) return res.status(409).json({ error: 'incompatible', detail: e.message });
            if (e && e.code) return mapHubError(e, res);
            log.error('[Modules] sideload error:', e.message);
            next(e);
        }
    });

// LEFT OPEN on purpose: the body IS the .bfgrant document, posted verbatim.
// Its shape is the grant format's, and packageLoader verifies it against the
// signing key -- a schema here would only be a second, weaker copy of that.
router.post('/:id/offline-grant', requireSuperAdmin, async (req, res, next) => {
    try {
        const r = await packageLoader.applyOfflineGrant(req.params.id, req.body || {});
        res.json({ ok: true, entitlement: { kind: r.entitlement.kind, exp: r.entitlement.exp } });
    } catch (e) {
        const slug = e && e.code;
        if (slug && slug.startsWith('bad_grant')) return res.status(400).json({ error: slug });
        if (slug === 'grant_module_mismatch') return res.status(400).json({ error: slug });
        if (slug === 'grant_invalid') return res.status(422).json({ error: slug, detail: e.detail || null });
        log.error('[Modules] offline-grant error:', e.message);
        next(e);
    }
});

router.post('/:id/activate-staged', requireSuperAdmin, validate({ body: VersionBody }), async (req, res, next) => {
    try {
        const r = await packageLoader.activateStaged(req.params.id, {
            version: req.body.version || null, actorId: req.session.user?.id || null,
        });
        res.json({ ok: true, version: r.version });
    } catch (e) {
        if (e && e.code === 'no_staged_version') return res.status(404).json({ error: 'no_staged_version' });
        if (e && e.code === 'offline_grant_required') return res.status(402).json({ error: 'offline_grant_required' });
        if (e && e.code === 'permissions_not_granted') return res.status(409).json({ error: 'permissions_not_granted', missingPermissions: e.missingPermissions || [] });
        if (e && e.code) return mapHubError(e, res);
        log.error('[Modules] activate-staged error:', e.message);
        next(e);
    }
});

router.get('/:id/versions', requireSuperAdmin, async (req, res) => {
    res.json({ versions: await packageLoader.listVersions(req.params.id) });
});

router.post('/:id/rollback', requireSuperAdmin, validate({ body: RollbackBody }), async (req, res, next) => {
    try {
        const r = await packageLoader.rollbackTo(req.params.id, {
            version: req.body.version || null,
            force: req.body.force === true,
            actorId: req.session.user?.id || null,
        });
        res.json({ ok: true, version: r.version });
    } catch (e) {
        if (e && e.code === 'no_rollback_candidate') return res.status(404).json({ error: 'no_rollback_candidate' });
        if (e && e.code === 'schema_downgrade') return res.status(409).json({ error: 'schema_downgrade', detail: e.detail || null });
        if (e && e.code === 'not_entitled') return res.status(402).json({ error: 'not_entitled' });
        if (e && e.code === 'install_in_progress') return res.status(409).json({ error: 'install_in_progress' });
        if (e && e.code === 'permissions_not_granted') return res.status(409).json({ error: 'permissions_not_granted', missingPermissions: e.missingPermissions || [] });
        if (e && e.code) return mapHubError(e, res);
        log.error('[Modules] rollback error:', e.message);
        next(e);
    }
});

module.exports = router;
