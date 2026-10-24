/**
 * App Studio data routes (routes/studioAppData.js): what every handler
 * shares. The rate limits and the batch and body budgets, the app
 * visibility gates, error handling, the data context a read or write runs
 * in (viewer, role, table), the table projection, the list query, the
 * stale-sync kick, linked-table flags and the single-record read. Split
 * out of routes/studioAppData.js; behaviour unchanged.
 */

const express = require('express');
const log = require('../../telemetry/log');
const { HttpError } = require('../../core/http/errors');
const studioAppStore = require('../../stores/studioAppStore');
const studioAppDataStore = require('../../stores/studioAppDataStore');
const queryCompiler = require('../../appStudio/queryCompiler');
const rlsGateway = require('../../appStudio/rlsGateway');
const dataReadRunner = require('../../appStudio/dataReadRunner');
const datatableSource = require('../../appStudio/datatableSource');
const { resolveAudienceContext } = require('../../auth/audience');
const { perUserRateLimit } = require('../../utils/perUserRateLimit');

// ── Rate limits (per viewer + app) ──────────────────────────────────
// Reads are cheaper than writes; both keyed userId:appId so one noisy viewer
// can't drain another's budget for the same app (mirrors studioAppRateLimits).
const DATA_READ_RPM = parseInt(process.env.STUDIO_APP_DATA_READ_RPM, 10) || 60;
const DATA_WRITE_RPM = parseInt(process.env.STUDIO_APP_DATA_WRITE_RPM, 10) || 20;
function dataKey(req) {
    return `${req.session?.user?.id || 'anon'}:${req.params?.id || 'unknown'}`;
}
// Named → Redis-backed when available: the ceiling holds fleet-wide instead
// of multiplying per replica (falls back to per-replica memory without Redis).
const readLimiter = perUserRateLimit({ windowMs: 60_000, max: DATA_READ_RPM, keyFn: dataKey, name: 'studio-data-read' });
const writeLimiter = perUserRateLimit({ windowMs: 60_000, max: DATA_WRITE_RPM, keyFn: dataKey, name: 'studio-data-write' });

// ── Batch budget (see POST /:id/data/batch) ─────────────────────────
// A request budget stops counting work the moment one request may carry many
// reads: 60 batches of 25 is 1500 queries a minute against the 60 a viewer
// could previously reach. So a batch is charged TWICE — once as a request
// (readLimiter) and once per descriptor. The descriptor ceiling is deliberately
// well above the request one: a screen with 19 bindings opened repeatedly is
// normal use, while 300 reads a minute is not a UI any more.
const MAX_BATCH_READS = 25;
const DATA_READ_DESCRIPTOR_RPM = parseInt(process.env.STUDIO_APP_DATA_READ_DESCRIPTOR_RPM, 10) || 300;
const readDescriptorLimiter = perUserRateLimit({
    windowMs: 60_000,
    max: DATA_READ_DESCRIPTOR_RPM,
    keyFn: dataKey,
    name: 'studio-data-read-descriptors',
    // Runs AFTER the body parser, so `reads` is already an array here. An
    // unparseable body costs 1 and is refused by the handler a moment later.
    costFn: (req) => (Array.isArray(req.body && req.body.reads) ? req.body.reads.length : 1),
});

// ── Body budget ─────────────────────────────────────────────────────
const MAX_BODY_BYTES = 64 * 1024;
const jsonBody = express.json({ limit: MAX_BODY_BYTES });

function requireJson(req, res, next) {
    const ct = req.headers['content-type'];
    if (ct && !/application\/json/i.test(ct)) {
        return res.status(415).json({ error: 'Content-Type must be application/json' });
    }
    next();
}

function bodySizeGuard(req, res, next) {
    if (req.body && typeof req.body === 'object') {
        let bytes = 0;
        try { bytes = Buffer.byteLength(JSON.stringify(req.body), 'utf8'); } catch { bytes = MAX_BODY_BYTES + 1; }
        if (bytes > MAX_BODY_BYTES) {
            return res.status(413).json({ error: 'Request body too large (max 64KB)' });
        }
    }
    next();
}

// ── Audience helper (collapse Sets/null to a plain array) ───────────
async function audienceFor(req) {
    const { orgIds, userGroups } = await resolveAudienceContext(req);
    const orgIdArr = orgIds instanceof Set ? [...orgIds] : (Array.isArray(orgIds) ? orgIds : []);
    return { orgIdArr, userGroups: Array.isArray(userGroups) ? userGroups : [] };
}

// ── App visibility gates (mirror studioAppsRun / studioApps) ────────
// Owner always; else published + one audience that carries the viewer — org,
// shared group, or a Studio Project the app is filed into
// (canReadStudioAppAsync). Failure answers 404 and returns null so the caller
// just `if (!app) return`.
async function loadVisibleApp(req, res) {
    const userId = req.session.user.id;
    const app = await studioAppStore.getStudioApp(req.params.id);
    if (!app) { res.status(404).json({ error: 'App not found' }); return null; }
    if (app.userId !== userId) {
        const { orgIdArr, userGroups } = await audienceFor(req);
        if (!await studioAppStore.canReadStudioAppAsync(app, userId, userGroups, orgIdArr)) {
            res.status(404).json({ error: 'App not found' });
            return null;
        }
    }
    return app;
}

// Owner-only: readable non-owner → 403; invisible → 404.
async function loadOwnedApp(req, res) {
    const userId = req.session.user.id;
    const app = await studioAppStore.getStudioApp(req.params.id);
    if (!app) { res.status(404).json({ error: 'App not found' }); return null; }
    if (!studioAppStore.canWriteStudioApp(app, userId)) {
        const { orgIdArr, userGroups } = await audienceFor(req);
        if (studioAppStore.canReadStudioApp(app, userId, userGroups, orgIdArr)) {
            res.status(403).json({ error: 'Only the app owner can do that' });
            return null;
        }
        res.status(404).json({ error: 'App not found' });
        return null;
    }
    return app;
}

// ── Error handling ──────────────────────────────────────────────────
// Compile/AccessError carry safe, client-facing validation text with a status;
// everything else is an internal error → generic 500 (no err.message leak).
function handleErr(res, err, _where) {
    const status = err && typeof err.status === 'number' ? err.status : null;
    // dataReadRunner marks its own refusals `safe` — the same 'Table not found'
    // / 'Forbidden' text these handlers used to return inline. Nothing else in
    // the process sets that flag, so an internal message cannot ride out on it.
    if (err && err.safe === true && status) {
        return res.status(status).json({ error: err.message });
    }
    // FROZEN quota contract: a 409 always answers { error, code, limit, used }
    // (studioAppQuota errors carry all four; the FE keys off code).
    if (status === 409) {
        return res.status(409).json({
            error: err.message,
            code: err.code || 'quota_exceeded',
            limit: err.limit,
            used: err.used,
        });
    }
    if (status === 422 || status === 400 || status === 403) {
        return res.status(status).json({ error: err.message });
    }
    // Only an HttpError may carry its own message and status; anything else is
    // a generic 500 (the terminal handler logs the cause), as before the move.
    if (err instanceof HttpError) throw err;
    throw Object.assign(new Error('Data request failed'), { cause: err });
}

// ── Shared data context ─────────────────────────────────────────────
// Resolves app → data model → viewer role → (optional) table. Responds + null
// on any failure. The per-app DB is owned by app.userId (ownerScope).
async function resolveDataContext(req, res, { tableId } = {}) {
    const app = await loadVisibleApp(req, res);
    if (!app) return null;
    const viewerId = req.session.user.id;

    const meta = await studioAppDataStore.getDataModel(app.id, app.userId);
    const model = meta && meta.model && typeof meta.model === 'object' ? meta.model : null;
    if (!model || !Array.isArray(model.tables)) {
        res.status(404).json({ error: 'App has no data model' });
        return null;
    }

    const { userGroups } = await audienceFor(req);
    const role = await rlsGateway.resolveViewerRole(app, viewerId, model, { userGroups });
    const viewer = buildViewer(req.session.user, role);

    const ctx = { app, ownerScope: app.userId, viewerId, model, role, viewer };
    if (tableId) {
        const table = model.tables.find((t) => t && (t.id === tableId || t.key === tableId));
        if (!table) { res.status(404).json({ error: 'Table not found' }); return null; }
        ctx.table = table;
    }
    return ctx;
}

// The viewer object exposed to row filters (viewer.<attr>). Deliberately small
// and server-derived — never client-supplied.
function buildViewer(user, role) {
    return {
        id: user.id,
        role: role || null,
        organizationId: user.organizationId || null,
    };
}

// Public projection of a table — fields ONLY. NEVER the access rules,
// rowFilters or roleMapping (those are the owner's secret enforcement config).
//
// `source` stays out too: the id of a Studio datatable belongs to the
// organisation it lives in, not to this app. What the client does need to know
// is in `linkedTableFlags` below — THAT a table is linked and whether it is
// read-only, without saying to what.
function publicTable(t) {
    return {
        id: t.id,
        key: t.key,
        name: t.name,
        icon: t.icon ?? null,
        fields: (Array.isArray(t.fields) ? t.fields : []).map((f) => ({
            id: f.id,
            key: f.key,
            name: f.name,
            type: f.type,
            subtype: f.subtype ?? null,
            required: !!f.required,
            unique: !!f.unique,
            ...(Array.isArray(f.options) ? { options: f.options } : {}),
            ...(f.relation && typeof f.relation === 'object' ? { relation: { table: f.relation.table } } : {}),
        })),
    };
}

// Parse list filters/sort from the query string (JSON-encoded). Bad JSON is
// ignored rather than 400 — the compiler validates the resulting shapes.
function parseListQuery(req) {
    const q = req.query || {};
    let filters;
    let sort;
    if (typeof q.filter === 'string' && q.filter) { try { filters = JSON.parse(q.filter); } catch (err) { log.debug('ignore', err); } }
    if (typeof q.sort === 'string' && q.sort) { try { sort = JSON.parse(q.sort); } catch (err) { log.debug('ignore', err); } }
    if (filters !== undefined && !Array.isArray(filters)) filters = [filters];
    return { filters, sort };
}

// The cache invalidation + row count after a write used to live here as
// `afterWrite`, with the DELETE route as its only caller. That route now goes
// through actionExecutor.eraseRecord, which does its own bookkeeping — exactly
// as writeRecord already did for create/update. One place that bumps, not two.

/**
 * Stale-while-serve for connector-filled tables.
 *
 * A table that a connector fills is only as fresh as its last refresh. Rather
 * than polling every app on a schedule whether anyone uses it or not, opening a
 * screen that READS such a table kicks a refresh when the data is older than the
 * connector's interval. The viewer is never made to wait: the rows already in
 * the table are what the response returns, and the refresh happens after.
 *
 * Fire-and-forget and fully guarded — syncConnector claims the sync row, so
 * concurrent viewers produce exactly one refresh, and a failure here can never
 * affect the response that already went out.
 */
function kickStaleSync(ctx) {
    const model = ctx.model;
    const connectors = Array.isArray(model?.connectors) ? model.connectors : [];
    const feeding = connectors.filter((c) => c && c.sync && c.sync.tableId === ctx.table.id && c.sync.refreshOnView !== false);
    if (!feeding.length) return;

    setImmediate(async () => {
        try {
            const connectorSync = require('../../appStudio/connectorSync');
            const appRef = { id: ctx.app.id, userId: ctx.app.userId, organizationId: ctx.app.organizationId || null };
            for (const connector of feeding) {
                const state = await studioAppDataStore.getSyncState(ctx.app.id, connector.id);
                if (!connectorSync.isStale(state, connector.sync, Date.now(), connector.kind)) continue;
                await connectorSync.syncConnector(appRef, model, connector, { reason: 'view' });
            }
        } catch (err) {
            // The response is long gone; a failed background refresh is recorded
            // on the sync row (status/last_error) for the owner to see.
            log.warn(`[StudioAppData] on-view refresh failed for app ${ctx.app.id}: ${err.message}`);
        }
    });
}

// ═══════════════════════════════════════════════════════════════════
// Records
// ═══════════════════════════════════════════════════════════════════

/**
 * May this viewer read this LINKED table, and what may the client know about
 * it? → null for an ordinary table, `REFUSED` when the link refuses it.
 *
 * `rlsGateway.canRead` only knows the APP's `access` block. A table that
 * takes its rows from a Studio datatable has a second lock — that datatable's
 * permission ladder — and without this question the table list showed the
 * NAME and the COLUMN NAMES of a table whose rows were then refused with 403.
 *
 * Every refusal, an outage (503) or a broken link (422) included, leaves the
 * table out of the list. That is the meaning `canRead` already had: what is
 * not in it is not for you. The distinction between "empty" and "unreadable"
 * belongs to READING the rows, and that is where it is made — with the
 * status and the reason attached (appStudio/readError.js).
 */
const LINK_REFUSED = Symbol('link_refused');
async function linkedTableFlags(ctx, table) {
    if (!datatableSource.isDatatableBacked(table)) return null;
    try {
        await dataReadRunner.readPlan(ctx, table);
    } catch (e) {
        if (e && e.safe === true) return LINK_REFUSED;
        throw e;
    }
    const mode = table.source && typeof table.source === 'object' ? table.source.mode : null;
    // THAT it is linked and whether it is read-only — never the datatableId.
    return { linked: true, readOnly: mode !== 'readwrite' };
}

/**
 * Read a single record through the READ access filter (hidden rows → null).
 *
 * Through `dataReadRunner.readPlan`, like the list, and that is the whole
 * change. This function used to compile against `ctx.table` and read
 * `studioAppDbStore` directly, so for a table that takes its rows from a
 * Studio datatable it hit the EMPTY shadow table: a detail screen said
 * "Record not found" every time, and the re-read after POST/PATCH showed the
 * row that had just landed in the wrong store as proof that it worked.
 * `readPlan` is built precisely to keep that split in one place; there was no
 * reason to go around it.
 *
 * A refusal of the link (403/422/503, `safe`) comes OUT of here as a throw and
 * is passed on verbatim by handleErr. Only the callers that read the row as a
 * by-product (`.catch(() => null)` after a write) swallow it: there the write
 * already succeeded and the re-read is an extra.
 */
async function readOne(ctx, recordId) {
    const plan = await dataReadRunner.readPlan(ctx, ctx.table);
    const accessFilter = rlsGateway.compileAccessFilter(
        plan.tableMeta, plan.role, plan.viewer, 'read', { dialect: plan.dialect });
    const { sql, params } = queryCompiler.compileGetById(
        plan.tableMeta, recordId, accessFilter, { dialect: plan.dialect });
    const { rows } = await plan.query(sql, params);
    return rows && rows.length ? rows[0] : null;
}
module.exports = { readLimiter, writeLimiter, readDescriptorLimiter, MAX_BATCH_READS, jsonBody, requireJson, bodySizeGuard, audienceFor, loadVisibleApp, loadOwnedApp, handleErr, resolveDataContext, buildViewer, publicTable, parseListQuery, kickStaleSync, LINK_REFUSED, linkedTableFlags, readOne };
