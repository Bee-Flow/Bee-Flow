/**
 * App Studio v2 — DATA API (record CRUD + aggregation query).
 *
 * This is the sole, unbypassable path that turns a client request into SQL
 * against a per-app SQLite database. It is session-authenticated (App Studio
 * runs inside the SPA — there is NO preview token here), rate-limited per
 * viewer, and RLS-scoped: every read/write is compiled by ../appStudio/
 * queryCompiler.js with an access filter from ../appStudio/rlsGateway.js. A
 * client never sends SQL.
 *
 * Mounted at /api/studio-apps ALONGSIDE studioApps.js + studioAppsRun.js behind
 * requireCapability('app_studio').
 *
 * Endpoints:
 *   GET    /:id/data/tables                           — tables the viewer may READ (fields only)
 *   GET    /:id/data/tables/:tableId/records          — list (filter/sort/keyset), access-filtered
 *   POST   /:id/data/tables/:tableId/records          — create (create-gated; created_by = session)
 *   GET    /:id/data/tables/:tableId/records/:recordId — read one (hidden → 404)
 *   PATCH  /:id/data/tables/:tableId/records/:recordId — update (0 rows = 404)
 *   DELETE /:id/data/tables/:tableId/records/:recordId — delete (0 rows = 404)
 *   POST   /:id/data/query                            — saved dataset OR inline aggregate descriptor
 *   POST   /:id/data/batch                            — many reads, one request (per-read statuses)
 *   GET/PUT /:id/schema                               — owner-only data model (with rowFilter validation)
 *   GET/POST/DELETE /:id/members                      — owner-only role assignment
 *
 * ── SECURITY MODEL (mirrors studioAppsRun.js) ───────────────────────
 *   • App visibility: owner always; else is_published + canReadStudioApp.
 *     Every not-visible answer is a uniform 404 — existence never leaks.
 *   • The per-app SQLite DB is owned by the app OWNER; data access runs
 *     acts-as-owner for the DB HANDLE (studioAppDbStore is keyed by ownerId =
 *     app.userId) while the RLS access filter scopes ROWS to the VIEWER.
 *   • Schema + membership are owner-only (canWriteStudioApp); a readable
 *     non-owner gets 403, an invisible one 404.
 *   • Generic 500s only — err.message never leaves the process except for the
 *     safe validation messages carried by Compile/AccessError (status 422/403/400)
 *     and quota errors (status 409, { error, code:'quota_exceeded', limit, used }).
 *   • Record writes funnel through actionExecutor.writeRecord — the single
 *     choke point that asserts storage quotas (create: row + byte caps;
 *     update: byte cap only; deletes stay quota-free so a full app can shrink).
 */

const express = require('express');
const log = require('../telemetry/log');
const router = express.Router();
const { validate } = require('../core/http/validate');
const { z, worded, bodyOf, queryOf, choice, wholeNumber } = require('../core/http/schemaParts');
// The runtime's own request shapes, shared with the public app routes.
const R = require('./studio/appRuntimeSchemas');

// ── What the data routes accept ──────────────────────────────────────
// Closed, except two bodies whose keys are the app's own: a record write
// (its keys are the table's columns; the insert/update compiler refuses a
// column the table does not have, by name) and POST /data/query (the body is
// a read descriptor, checked field by field by the query compiler). What is
// closed here: `?refresh=yes` served the cache; a misspelled batch key, a
// dataset with `cacheTtlSeconds: "60"` (kept the default), a member with a
// misspelled `role` (became `member`) — all answered 200.
const idText = (name) => worded(`${name} is an id.`).max(200, `${name} is an id.`);
const RefreshQuery = queryOf({ refresh: choice(['0', '1', 'true', 'false'], 'refresh is 1 to bypass the cache.').optional() }, 'A data query');
const BatchBody = bodyOf({
    // The handler answers a missing or non-list `reads` itself, with its cap.
    reads: z.unknown(),
}, 'A batch of reads');
const datasetShape = {
    name: worded('name is text.').max(200, 'name is at most 200 characters.').optional(),
    tableId: idText('tableId').nullish(),
    source: z.record(z.unknown(), { invalid_type_error: 'source is an object.' }).optional(),
    descriptor: z.record(z.unknown(), { invalid_type_error: 'descriptor is an object.' }).optional(),
    cacheTtlSeconds: wholeNumber('cacheTtlSeconds is a whole number of seconds.').optional(),
};
const DatasetBody = bodyOf(datasetShape, 'A dataset');
const SchemaBody = bodyOf({
    model: z.record(z.unknown(), { required_error: 'model (object) is required', invalid_type_error: 'model (object) is required' }),
    expectedVersion: wholeNumber('expectedVersion is the version you loaded.').nullish(),
}, 'A data model');
const MemberBody = bodyOf({
    userId: worded('userId is required').max(200, 'userId is an id.'),
    roleKey: worded('roleKey is the key of a role.').max(100, 'roleKey is the key of a role.').optional(),
}, 'Adding a member');

const studioAppStore = require('../stores/studioAppStore');
const userStore = require('../stores/userStore');
const studioAppDataStore = require('../stores/studioAppDataStore');
const queryCompiler = require('../appStudio/queryCompiler');
const rlsGateway = require('../appStudio/rlsGateway');
const actionExecutor = require('../appStudio/actionExecutor');
const dataReadRunner = require('../appStudio/dataReadRunner');
const datatableSource = require('../appStudio/datatableSource');
const { validateDataModel } = require('../appStudio/dataModel');
const { resolveAudienceContext } = require('../auth/audience');
const { perUserRateLimit } = require('../utils/perUserRateLimit');

// ── Auth ────────────────────────────────────────────────────────────
// requireAuth is the canonical gate from auth/permissions (verifies the
// user still exists in the DB, cached 5s, and destroys deleted-user sessions).
const { requireAuth } = require('../auth/permissions');

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
function handleErr(res, err, where) {
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
    log.error(`[StudioAppData/${where}] ${err && err.message}`);
    return res.status(500).json({ error: 'Data request failed' });
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
// `source` gaat er evenmin in: de id van een Studio-datatabel hoort bij de
// organisatie waar hij staat, niet bij deze app. Wat de client wél moet weten
// staat in `linkedTableFlags` hieronder — DAT een tabel gekoppeld is en of hij
// alleen-lezen is, zonder te zeggen waaraan.
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
    if (typeof q.filter === 'string' && q.filter) { try { filters = JSON.parse(q.filter); } catch { /* ignore */ } }
    if (typeof q.sort === 'string' && q.sort) { try { sort = JSON.parse(q.sort); } catch { /* ignore */ } }
    if (filters !== undefined && !Array.isArray(filters)) filters = [filters];
    return { filters, sort };
}

// De cache-invalidatie + rijtelling na een schrijving stond hier als
// `afterWrite`, met de DELETE-route als enige aanroeper. Die gaat nu door
// actionExecutor.eraseRecord, dat zijn eigen boekhouding doet — precies zoals
// writeRecord dat voor create/update al deed. Eén plek die bumpt, niet twee.

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
            const connectorSync = require('../appStudio/connectorSync');
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
 * Mag deze kijker deze GEKOPPELDE tabel lezen, en wat mag de client erover
 * weten? → null voor een gewone tabel, `REFUSED` als de koppeling hem weigert.
 *
 * `rlsGateway.canRead` kent alleen het `access`-blok van de APP. Een tabel die
 * haar rijen uit een Studio-datatabel haalt heeft een tweede slot — de
 * rechtenladder van die datatabel — en zonder deze vraag stond in de
 * tabellenlijst de NAAM en de KOLOMNAMEN van een tabel waarvan de rijen
 * vervolgens met 403 worden geweigerd.
 *
 * Elke weigering, ook een storing (503) of een kapotte koppeling (422), laat de
 * tabel uit de lijst. Dat is dezelfde betekenis die `canRead` al had: wat er
 * niet in staat, is niet voor jou. Het onderscheid tussen "leeg" en "onleesbaar"
 * hoort bij het LEZEN van de rijen, en daar wordt het ook gemaakt — met de
 * status en de reden erbij (appStudio/readError.js).
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
    // DAT hij gekoppeld is en of hij alleen-lezen is — nooit de datatableId.
    return { linked: true, readOnly: mode !== 'readwrite' };
}

// GET /:id/data/tables — tables the viewer may READ (fields only).
router.get('/:id/data/tables', requireAuth, readLimiter, async (req, res) => {
    try {
        const ctx = await resolveDataContext(req, res);
        if (!ctx) return;
        const tables = [];
        for (const t of ctx.model.tables) {
            if (!rlsGateway.canRead(t, ctx.role)) continue;
            const flags = await linkedTableFlags(ctx, t);
            if (flags === LINK_REFUSED) continue;
            tables.push({ ...publicTable(t), ...flags });
        }
        res.json({ tables });
    } catch (err) { handleErr(res, err, 'tables'); }
});

// GET /:id/data/tables/:tableId/records — list.
router.get('/:id/data/tables/:tableId/records', requireAuth, readLimiter, validate({ query: R.RecordsQuery }), async (req, res) => {
    try {
        const ctx = await resolveDataContext(req, res, { tableId: req.params.tableId });
        if (!ctx) return;
        if (!rlsGateway.canRead(ctx.table, ctx.role)) return res.status(403).json({ error: 'Forbidden' });

        const { filters, sort } = parseListQuery(req);
        const { records, nextCursor } = await dataReadRunner.runRecordList(ctx, ctx.table, {
            filters, sort, cursor: req.query.cursor, limit: req.query.limit,
        });
        // appVersion rides along on the read every screen already makes: a
        // viewer whose session predates a republish learns about it without a
        // single extra request.
        res.json({ records, nextCursor, appVersion: ctx.app.publishedVersion ?? null });
        // AFTER the response: a connector-filled table refreshes itself when
        // someone looks at stale data, so an app nobody opens costs no API quota.
        kickStaleSync(ctx);
    } catch (err) { handleErr(res, err, 'records.list'); }
});

// POST /:id/data/tables/:tableId/records — create.
router.post('/:id/data/tables/:tableId/records', requireAuth, writeLimiter, requireJson, jsonBody, bodySizeGuard, async (req, res) => {
    try {
        const ctx = await resolveDataContext(req, res, { tableId: req.params.tableId });
        if (!ctx) return;

        const body = (req.body && typeof req.body === 'object' && !Array.isArray(req.body)) ? req.body : {};
        const values = (body.values && typeof body.values === 'object' && !Array.isArray(body.values)) ? body.values : body;

        // writeRecord is the single record-write choke point: RLS (403), row +
        // byte quotas (409), compileInsert, exec acts-as-owner, version/row-count
        // bumps. created_by is the SESSION user; org_id is the app's org — any
        // such keys in `values` are dropped by the compiler.
        const { id } = await actionExecutor.writeRecord(ctx.app, ctx.model, ctx.table, values, { viewer: ctx.viewer });

        const record = await readOne(ctx, id).catch(() => null);
        res.json({ success: true, id, record });
    } catch (err) { handleErr(res, err, 'records.create'); }
});

// GET /:id/data/tables/:tableId/records/:recordId — read one.
router.get('/:id/data/tables/:tableId/records/:recordId', requireAuth, readLimiter, async (req, res) => {
    try {
        const ctx = await resolveDataContext(req, res, { tableId: req.params.tableId });
        if (!ctx) return;
        if (!rlsGateway.canRead(ctx.table, ctx.role)) return res.status(403).json({ error: 'Forbidden' });
        const record = await readOne(ctx, req.params.recordId);
        if (!record) return res.status(404).json({ error: 'Record not found' });
        res.json({ record });
    } catch (err) { handleErr(res, err, 'records.get'); }
});

// PATCH /:id/data/tables/:tableId/records/:recordId — update.
router.patch('/:id/data/tables/:tableId/records/:recordId', requireAuth, writeLimiter, requireJson, jsonBody, bodySizeGuard, async (req, res) => {
    try {
        const ctx = await resolveDataContext(req, res, { tableId: req.params.tableId });
        if (!ctx) return;

        const body = (req.body && typeof req.body === 'object' && !Array.isArray(req.body)) ? req.body : {};
        // `expectedUpdatedAt` is an ENVELOPE field, never a column: strip it
        // from the bare-body form too, or the compiler would reject it as an
        // unknown field the moment a caller omits `values`.
        const expectedUpdatedAt = typeof body.expectedUpdatedAt === 'string' && body.expectedUpdatedAt
            ? body.expectedUpdatedAt
            : null;
        let values;
        if (body.values && typeof body.values === 'object' && !Array.isArray(body.values)) {
            values = body.values;
        } else {
            const { expectedUpdatedAt: _envelope, ...rest } = body;
            values = rest;
        }

        // Same choke point, update path: RLS (403), byte quota only (409), the
        // viewer's access filter ANDed into the WHERE — 0 rows = missing OR
        // out-of-scope, answered as a uniform 404.
        const { changes } = await actionExecutor.writeRecord(ctx.app, ctx.model, ctx.table, values, {
            viewer: ctx.viewer,
            recordId: req.params.recordId,
            expectedUpdatedAt,
        });
        if (!changes) {
            // With a CAS token, 0 rows has two very different meanings. Re-read
            // under the viewer's own access filter: still visible ⇒ somebody
            // else wrote it first (409 + the CURRENT row so the UI can show or
            // merge it); invisible ⇒ gone or out of scope, the uniform 404 that
            // never reveals which.
            if (expectedUpdatedAt) {
                const current = await readOne(ctx, req.params.recordId).catch(() => null);
                if (current) {
                    return res.status(409).json({
                        error: 'This record was changed by someone else — reload and try again.',
                        code: 'record_conflict',
                        record: current,
                    });
                }
            }
            return res.status(404).json({ error: 'Record not found' });
        }

        const record = await readOne(ctx, req.params.recordId).catch(() => null);
        res.json({ success: true, record });
    } catch (err) { handleErr(res, err, 'records.update'); }
});

// DELETE /:id/data/tables/:tableId/records/:recordId — delete.
router.delete('/:id/data/tables/:tableId/records/:recordId', requireAuth, writeLimiter, async (req, res) => {
    try {
        const ctx = await resolveDataContext(req, res, { tableId: req.params.tableId });
        if (!ctx) return;
        // eraseRecord is het DELETE-knooppunt: RLS (403), de tweede tabelsoort,
        // de access-filter in de WHERE en de boekhouding erna. Deletes blijven
        // quotavrij — dat is de uitweg waarlangs een volle app kan krimpen.
        // Deze route compileerde dat zelf en kende de gekoppelde tabel daardoor
        // niet: `DELETE FROM \"klanten\"` op de app-opslag, 404 op een rij die
        // in de datatabel gewoon staat, en op een tabel die ooit eigen opslag
        // WAS de stille wis van de oude schaduwrijen.
        const { changes } = await actionExecutor.eraseRecord(
            ctx.app, ctx.model, ctx.table, req.params.recordId, { viewer: ctx.viewer });
        if (!changes) return res.status(404).json({ error: 'Record not found' });
        res.json({ success: true });
    } catch (err) { handleErr(res, err, 'records.delete'); }
});

/**
 * Read a single record through the READ access filter (hidden rows → null).
 *
 * Via `dataReadRunner.readPlan`, net als de lijst — en dat is de hele wijziging.
 * Deze functie compileerde tegen `ctx.table` en las `studioAppDbStore`
 * rechtstreeks, dus voor een tabel die haar rijen uit een Studio-datatabel haalt
 * raakte hij de LEGE schaduwtabel: een detailscherm zei structureel "Record not
 * found", en de her-lezing na POST/PATCH toonde de rij die net in de verkeerde
 * opslag belandde als bewijs dat het gelukt was. `readPlan` is precies gebouwd
 * om die splitsing op één plek te houden; er was geen reden om er
 * omheen te gaan.
 *
 * Een weigering van de koppeling (403/422/503, `safe`) komt hier NAAR BUITEN als
 * throw en wordt door handleErr letterlijk doorgegeven. Alleen de aanroepers die
 * de rij als bijvangst lezen (`.catch(() => null)` na een schrijving) slikken
 * hem — daar is de schrijving al gelukt en is de her-lezing een extraatje.
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

// ═══════════════════════════════════════════════════════════════════
// Export — the owner's copy of their own data
// ═══════════════════════════════════════════════════════════════════

// How many rows one keyset page pulls while streaming an export. Well under
// the engine's 10k result cap, small enough that a 500k-row app never holds a
// big array in memory: each page is written out and dropped.
const EXPORT_PAGE_ROWS = 500;

/**
 * GET /:id/data/export — the whole app database as one streamed JSON bundle.
 *
 * There was no export at all before: the per-app SQLite blob WAS the only
 * artifact, and nothing surfaced it. That made "get my data out" an operator
 * task and left GDPR portability resting on a file nobody could reach.
 *
 * Owner-only (the data belongs to the app, not to whoever can open it), read
 * limiter, and rows go through the OWNER's access filter — which resolveScope
 * short-circuits to full — so the bundle is complete rather than a viewer's
 * slice. Written as a stream: table by table, page by page, so the response
 * starts immediately and memory stays flat.
 */
router.get('/:id/data/export', requireAuth, readLimiter, async (req, res) => {
    let started = false;
    try {
        const app = await loadOwnedApp(req, res);
        if (!app) return;

        const meta = await studioAppDataStore.getDataModel(app.id, app.userId);
        const model = meta && meta.model && typeof meta.model === 'object' ? meta.model : null;
        if (!model || !Array.isArray(model.tables)) return res.status(404).json({ error: 'App has no data model' });

        const ownerViewer = { id: app.userId, role: 'owner' };
        const stamp = new Date().toISOString();
        const safeName = String(app.name || 'app').replace(/[^A-Za-z0-9_-]+/g, '-').slice(0, 60) || 'app';

        // ── Elk leesplan VÓÓR de eerste byte ────────────────────────
        // Een gekoppelde tabel las hier de LEGE schaduwtabel in de app-database
        // en kwam als `[]` uit de export — een bestand dat beweert dat een tabel
        // leeg is terwijl de rijen bestaan. In een privacyproduct is dat het
        // bestand waarmee iemand een inzageverzoek of een migratie beantwoordt,
        // en "leeg" en "staat ergens anders" zijn verschillende antwoorden.
        //
        // Ze worden nu meegeëxporteerd, uit de datatabel, met de graad van de
        // EIGENAAR (dat is wie de export vraagt — `loadOwnedApp`). Kan er één
        // niet gelezen worden, dan faalt de hele export met de reden ervan, en
        // wel HIER: eenmaal onderweg is de status al 200 en zou de weigering als
        // geldige, volledige JSON aankomen.
        const exportCtx = {
            app, ownerScope: app.userId, viewerId: app.userId, model,
            role: 'owner', viewer: ownerViewer,
        };
        const plans = new Map();
        const linkedTables = {};
        for (const table of model.tables) {
            if (!table || !table.key) continue;
            plans.set(table.key, await dataReadRunner.readPlan(exportCtx, table));
            if (datatableSource.isDatatableBacked(table)) {
                const src = (table.source && typeof table.source === 'object') ? table.source : {};
                // De herkomst hoort in het bestand: zonder deze regel staat er
                // een tabel met rijen die de app niet bezit, zonder dat iets
                // zegt waar ze vandaan komen of waar ze blijven staan.
                linkedTables[table.key] = {
                    datatableId: typeof src.datatableId === 'string' ? src.datatableId : null,
                    mode: typeof src.mode === 'string' ? src.mode : null,
                };
            }
        }

        res.setHeader('Content-Type', 'application/json; charset=utf-8');
        res.setHeader('Content-Disposition', `attachment; filename="${safeName}-export.json"`);
        started = true;

        res.write(`{"app":${JSON.stringify({ id: app.id, name: app.name })},`
            + `"exportedAt":${JSON.stringify(stamp)},`
            + `"modelVersion":${JSON.stringify(meta.modelVersion ?? null)},`
            + `"model":${JSON.stringify(model)},`
            + `"linkedTables":${JSON.stringify(linkedTables)},"tables":{`);

        let firstTable = true;
        for (const table of model.tables) {
            if (!table || !table.key) continue;
            res.write(`${firstTable ? '' : ','}${JSON.stringify(table.key)}:[`);
            firstTable = false;

            const plan = plans.get(table.key);
            const accessFilter = rlsGateway.compileAccessFilter(
                plan.tableMeta, plan.role, plan.viewer, 'read', { dialect: plan.dialect });
            let cursor;
            let firstRow = true;
            // Keyset pages, not OFFSET: the compiler's own pagination, so a
            // concurrent insert can't make the export skip or repeat a row.
            for (;;) {
                const { sql, params, primaryField, limit } = queryCompiler.compileRecordList(
                    plan.tableMeta, { cursor, limit: EXPORT_PAGE_ROWS, dialect: plan.dialect }, accessFilter,
                );
                const { rows } = await plan.query(sql, params);
                const page = rows.length > limit ? rows.slice(0, limit) : rows;
                for (const row of page) {
                    res.write(`${firstRow ? '' : ','}${JSON.stringify(row)}`);
                    firstRow = false;
                }
                if (rows.length <= limit) break;
                const last = page[page.length - 1];
                cursor = queryCompiler.encodeCursor(last[primaryField], last.id);
            }
            res.write(']');
        }
        res.end('}}');
    } catch (err) {
        // Once bytes are on the wire the status is already 200 — abort the
        // stream rather than appending an error object that would look like
        // valid, complete JSON to a naive reader.
        if (started) {
            log.error(`[StudioAppData/export] ${err && err.message}`);
            return res.destroy(err);
        }
        handleErr(res, err, 'export');
    }
});

// ═══════════════════════════════════════════════════════════════════
// Aggregation query (saved dataset OR inline descriptor)
// ═══════════════════════════════════════════════════════════════════

router.post('/:id/data/query', requireAuth, readLimiter, requireJson, jsonBody, bodySizeGuard, validate({ query: RefreshQuery }), async (req, res) => {
    try {
        const ctx = await resolveDataContext(req, res);
        if (!ctx) return;
        const body = (req.body && typeof req.body === 'object' && !Array.isArray(req.body)) ? req.body : {};

        // ── Saved dataset → scope-partitioned, cache-aware runDataset ──────
        // The dataset is owner-scoped (getDataset gates ownership); the viewer
        // runs acts-as-owner for the DB handle while the access filter (built
        // inside runDataset from the VIEWER's role) still scopes rows. Results
        // are memoised per viewer_scope_key + params_hash + data_version.
        // ── Reserved platform dataset → the organisation's member list ─────
        // Intercepted BEFORE getDataset, because this id belongs to the
        // platform and the app's own dataset table has never heard of it.
        // Three gates, all of which must pass: the app is visible to this
        // viewer (resolveDataContext → loadVisibleApp), the app declared that
        // it reads the directory, and the org is the APP's org rather than the
        // viewer's — canReadStudioApp already requires the viewer to be in it,
        // so taking it from the app makes cross-org leakage structurally
        // impossible instead of merely unlikely.
        if (body.datasetId === 'sys_org_members') {
            if (!ctx.model?.directory?.orgMembers) {
                return res.status(403).json({ error: 'This app does not read the organisation directory' });
            }
            const orgId = ctx.app.organizationId || null;
            const members = orgId ? await userStore.getOrgMembersForDirectory(orgId) : [];
            const rows = members.map((m) => ({
                id: m.id,
                name: m.displayName || m.username || m.id,
                username: m.username || null,
                avatarType: m.avatarType || null,
            }));
            // `result` mirrors the runtime dataset contract; `rows` the builder.
            return res.json({ rows, result: rows });
        }

        if (typeof body.datasetId === 'string' && body.datasetId) {
            const refresh = req.query.refresh === '1' || req.query.refresh === 'true';
            const out = await dataReadRunner.runSavedDataset(ctx, body.datasetId, { refresh });
            // `result` mirrors the runtime dataset-binding contract (useAppDataSource
            // reads body.result); `rows`/`columns`/`cached` power the query builder.
            return res.json({ ...out, result: out.rows });
        }

        // ── Inline aggregate descriptor → live (unchanged live path) ───────
        const descriptor = (body.aggregate && typeof body.aggregate === 'object') ? body.aggregate : body;
        const table = dataReadRunner.requireReadableTable(ctx, body.tableId);
        res.json(await dataReadRunner.runInlineAggregate(ctx, table, descriptor));
    } catch (err) { handleErr(res, err, 'query'); }
});

// ═══════════════════════════════════════════════════════════════════
// POST /:id/data/batch — many reads, one request
// ═══════════════════════════════════════════════════════════════════
//
// A screen binds one component to one query, and the runtime used to spend one
// HTTP request per binding: a 19-tile dashboard opened for a third of the
// viewer's whole per-minute budget, and a few clicks on top of it produced the
// 429 that reads as "this could not be loaded". Batching collapses a screen
// load into one or two requests.
//
// The contract is what makes it safe to adopt:
//   • ALWAYS 200 with `{ results: [...] }` once the app resolves. A descriptor
//     that fails answers for itself ({ ok:false, status }) with the status the
//     dedicated endpoint would have used, so the client's existing fail-soft
//     rules apply unchanged.
//   • A NON-200, or a 200 whose body is not `{ results: [...] }`, means this
//     route is not there — an older server, a proxy, a fail-closed public or
//     demo transport that answers 404 for a suffix it does not know. The client
//     treats that as "cannot batch" and replays every read individually. It is
//     never, under any circumstance, read as "no data": a silently empty page is
//     the one failure mode this endpoint could otherwise introduce.
//   • Access control is not re-implemented here. Every read goes through
//     dataReadRunner, which is the same code path the single-read endpoints use.
router.post('/:id/data/batch', requireAuth, readLimiter, requireJson, jsonBody, bodySizeGuard, validate({ body: BatchBody }), readDescriptorLimiter, async (req, res) => {
    try {
        const body = (req.body && typeof req.body === 'object' && !Array.isArray(req.body)) ? req.body : {};
        const reads = Array.isArray(body.reads) ? body.reads : null;
        if (!reads) return res.status(400).json({ error: '`reads` must be an array' });
        if (reads.length > MAX_BATCH_READS) {
            return res.status(400).json({ error: `At most ${MAX_BATCH_READS} reads per batch` });
        }
        if (reads.length === 0) return res.json({ results: [] });

        const ctx = await resolveDataContext(req, res);
        if (!ctx) return; // 404/403 already sent — the client downgrades, it never renders empty

        // Kicking a connector refresh per DISTINCT table: a batch that reads the
        // same table three times must not start three syncs.
        const touched = new Map();
        const results = await dataReadRunner.runBatch(ctx, reads, {
            onTable: (t) => { if (!touched.has(t.id)) touched.set(t.id, t); },
        });

        res.json({ results, appVersion: ctx.app.publishedVersion ?? null });
        for (const table of touched.values()) kickStaleSync({ ...ctx, table });
    } catch (err) { handleErr(res, err, 'batch'); }
});

// ═══════════════════════════════════════════════════════════════════
// Datasets (owner-only) — named, reusable aggregate queries
// ═══════════════════════════════════════════════════════════════════
// A dataset is a saved descriptor over one table (source + descriptor + cache
// TTL). Only the app owner may list/create/update/delete them; the RUN path
// (POST /:id/data/query) then serves them cache-aware and RLS-scoped to each
// viewer. Mirrors the members/schema owner gate.

router.get('/:id/datasets', requireAuth, readLimiter, async (req, res) => {
    try {
        const app = await loadOwnedApp(req, res);
        if (!app) return;
        const datasets = await studioAppDataStore.listDatasets(app.id, app.userId);
        res.json({ datasets });
    } catch (err) { handleErr(res, err, 'datasets.list'); }
});

router.post('/:id/datasets', requireAuth, writeLimiter, requireJson, jsonBody, bodySizeGuard, validate({ body: DatasetBody }), async (req, res) => {
    try {
        const app = await loadOwnedApp(req, res);
        if (!app) return;
        const body = (req.body && typeof req.body === 'object' && !Array.isArray(req.body)) ? req.body : {};
        const dataset = await studioAppDataStore.createDataset(app.id, app.userId, {
            name: typeof body.name === 'string' ? body.name : undefined,
            tableId: typeof body.tableId === 'string' ? body.tableId : null,
            source: (body.source && typeof body.source === 'object') ? body.source : {},
            descriptor: (body.descriptor && typeof body.descriptor === 'object') ? body.descriptor : {},
            cacheTtlSeconds: Number.isFinite(body.cacheTtlSeconds) ? body.cacheTtlSeconds : undefined,
        });
        res.json({ success: true, dataset });
    } catch (err) { handleErr(res, err, 'datasets.create'); }
});

router.put('/:id/datasets/:datasetId', requireAuth, writeLimiter, requireJson, jsonBody, bodySizeGuard, validate({ body: DatasetBody }), async (req, res) => {
    try {
        const app = await loadOwnedApp(req, res);
        if (!app) return;
        const body = (req.body && typeof req.body === 'object' && !Array.isArray(req.body)) ? req.body : {};
        const updates = {};
        if (body.name !== undefined) updates.name = body.name;
        if (body.tableId !== undefined) updates.tableId = body.tableId;
        if (body.source !== undefined) updates.source = body.source;
        if (body.descriptor !== undefined) updates.descriptor = body.descriptor;
        if (body.cacheTtlSeconds !== undefined) updates.cacheTtlSeconds = body.cacheTtlSeconds;
        const dataset = await studioAppDataStore.updateDataset(req.params.datasetId, app.id, app.userId, updates);
        if (!dataset) return res.status(404).json({ error: 'Dataset not found' });
        // Descriptor/source edits change the query — drop stale cached results.
        try { await studioAppDataStore.invalidateCache(req.params.datasetId); } catch { /* advisory */ }
        res.json({ success: true, dataset });
    } catch (err) { handleErr(res, err, 'datasets.update'); }
});

router.delete('/:id/datasets/:datasetId', requireAuth, writeLimiter, async (req, res) => {
    try {
        const app = await loadOwnedApp(req, res);
        if (!app) return;
        const ok = await studioAppDataStore.deleteDataset(req.params.datasetId, app.id, app.userId);
        if (!ok) return res.status(404).json({ error: 'Dataset not found' });
        res.json({ success: true });
    } catch (err) { handleErr(res, err, 'datasets.delete'); }
});

// ═══════════════════════════════════════════════════════════════════
// Schema (owner-only) — the data model incl. access rules + rowFilters
// ═══════════════════════════════════════════════════════════════════

router.get('/:id/schema', requireAuth, async (req, res) => {
    try {
        const app = await loadOwnedApp(req, res);
        if (!app) return;
        // reconcile: lazily heals a SQLite-ahead-of-Postgres drift window on
        // editor open (best-effort inside the store — never fails the read).
        const meta = await studioAppDataStore.getDataModel(app.id, app.userId, { reconcile: true });
        res.json({
            model: meta ? meta.model : null,
            modelVersion: meta ? meta.modelVersion : 0,
        });
    } catch (err) { handleErr(res, err, 'schema.get'); }
});

router.put('/:id/schema', requireAuth, jsonBody, bodySizeGuard, validate({ body: SchemaBody }), async (req, res) => {
    try {
        const app = await loadOwnedApp(req, res);
        if (!app) return;
        const body = (req.body && typeof req.body === 'object' && !Array.isArray(req.body)) ? req.body : {};
        const model = body.model;
        if (!model || typeof model !== 'object' || Array.isArray(model)) {
            return res.status(400).json({ error: 'model (object) is required' });
        }

        // Shape validation first, then every declared rowFilter must translate to
        // the bounded SQL subset (the ONLY free-form input a data model carries).
        const { errors } = validateDataModel(model);
        const rowFilterErrors = [];
        for (const t of (Array.isArray(model.tables) ? model.tables : [])) {
            const rf = t && t.access && typeof t.access.rowFilters === 'object' ? t.access.rowFilters : null;
            if (!rf) continue;
            for (const roleKey of Object.keys(rf)) {
                const { ok, errors: rfErr } = rlsGateway.validateRowFilter(rf[roleKey], t);
                if (!ok) rowFilterErrors.push(`table "${t.key}" role "${roleKey}": ${rfErr.join('; ')}`);
            }
        }
        const allErrors = [...errors, ...rowFilterErrors];
        if (allErrors.length) return res.status(422).json({ error: 'Data model failed validation', errors: allErrors });

        const expectedVersion = Number.isInteger(body.expectedVersion) ? body.expectedVersion : null;
        const result = await studioAppDataStore.saveDataModel(app.id, app.userId, model, { expectedVersion });
        if (result.invalid) return res.status(422).json({ error: 'Data model failed validation', errors: result.errors });
        if (result.notFound) return res.status(404).json({ error: 'App not found' });
        if (result.conflict) {
            return res.status(409).json({
                error: 'The data model changed since you loaded it',
                conflict: true,
                currentVersion: result.currentVersion,
                model: result.model,
            });
        }
        // Saving the model is what SCHEDULES a connector's table fill. Without
        // this a newly configured sync had no state row, so the background job —
        // which selects on next_run_at — could never see it, and the table stayed
        // empty until someone opened the app or pressed "Refresh now".
        // Best-effort: the model is already committed, and a missed seed is
        // recovered by the next save or by opening the app.
        try {
            const synced = (Array.isArray(model.connectors) ? model.connectors : [])
                .filter((c) => c && c.sync && c.sync.tableId)
                .map((c) => c.id);
            await studioAppDataStore.reconcileSyncStates(app.id, app.userId, synced);
        } catch (e) {
            log.warn(`[StudioAppData] sync scheduling failed for app ${app.id}: ${e.message}`);
        }

        res.json({ success: true, version: result.version });
    } catch (err) { handleErr(res, err, 'schema.put'); }
});

// ═══════════════════════════════════════════════════════════════════
// Members (owner-only) — RLS role assignment
// ═══════════════════════════════════════════════════════════════════

router.get('/:id/members', requireAuth, async (req, res) => {
    try {
        const app = await loadOwnedApp(req, res);
        if (!app) return;
        const members = await studioAppDataStore.listMembers(app.id, app.userId);
        res.json({ members });
    } catch (err) { handleErr(res, err, 'members.list'); }
});

router.post('/:id/members', requireAuth, jsonBody, bodySizeGuard, validate({ body: MemberBody }), async (req, res) => {
    try {
        const app = await loadOwnedApp(req, res);
        if (!app) return;
        const body = (req.body && typeof req.body === 'object' && !Array.isArray(req.body)) ? req.body : {};
        const memberUserId = typeof body.userId === 'string' ? body.userId.trim() : '';
        const roleKey = typeof body.roleKey === 'string' && body.roleKey ? body.roleKey : 'member';
        if (!memberUserId) return res.status(400).json({ error: 'userId is required' });

        // A member's role must exist in the data model (plus the built-in
        // 'member' fallback) — a typo'd/deleted role would otherwise sit in the
        // membership table and silently resolve to the tables' default access.
        const meta = await studioAppDataStore.getDataModel(app.id, app.userId);
        const modelRoles = (meta && meta.model && Array.isArray(meta.model.roles)) ? meta.model.roles : [];
        const validRoles = [...new Set([
            ...modelRoles.map((r) => r && r.key).filter((k) => typeof k === 'string' && k),
            'member',
        ])];
        if (!validRoles.includes(roleKey)) {
            return res.status(422).json({ error: 'invalid_role', roleKey, validRoles });
        }

        const member = await studioAppDataStore.addMember(app.id, app.userId, memberUserId, roleKey);
        if (!member) return res.status(404).json({ error: 'App not found' });
        res.json({ success: true, member });
    } catch (err) { handleErr(res, err, 'members.add'); }
});

router.delete('/:id/members/:userId', requireAuth, async (req, res) => {
    try {
        const app = await loadOwnedApp(req, res);
        if (!app) return;
        const ok = await studioAppDataStore.removeMember(app.id, app.userId, req.params.userId);
        if (!ok) return res.status(404).json({ error: 'App not found' });
        res.json({ success: true });
    } catch (err) { handleErr(res, err, 'members.remove'); }
});

// Map body-parser failures to JSON (default handler answers HTML).
router.use((err, req, res, next) => {
    if (err?.type === 'entity.too.large' || err?.status === 413 || err?.statusCode === 413) {
        return res.status(413).json({ error: 'Request body too large (max 64KB)' });
    }
    if (err?.type === 'entity.parse.failed') {
        return res.status(400).json({ error: 'Invalid JSON body' });
    }
    if (err?.type === 'charset.unsupported' || err?.type === 'encoding.unsupported') {
        return res.status(415).json({ error: 'Unsupported content encoding' });
    }
    next(err);
});

module.exports = router;
