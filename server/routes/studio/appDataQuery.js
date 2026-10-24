// @typecheck
/**
 * App Studio data routes: reading in bulk. The owner's streamed export,
 * a read descriptor (POST /data/query) and a batch of them. The route
 * table stays in routes/studioAppData.js. Split out of it; behaviour
 * unchanged.
 */

const log = require('../../telemetry/log');
const studioAppDataStore = require('../../stores/studioAppDataStore');
const queryCompiler = require('../../appStudio/queryCompiler');
const rlsGateway = require('../../appStudio/rlsGateway');
const dataReadRunner = require('../../appStudio/dataReadRunner');
const datatableSource = require('../../appStudio/datatableSource');
const userStore = require('../../stores/userStore');
const { MAX_BATCH_READS, loadOwnedApp, handleErr, resolveDataContext, kickStaleSync } = require('./appDataContext');

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
async function exportData(req, res) {
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

        // ── Every read plan BEFORE the first byte ───────────────────
        // A linked table used to read the EMPTY shadow table in the app database
        // here and came out of the export as `[]` — a file claiming a table is
        // empty while its rows exist. In a privacy product that is the file
        // someone answers a subject access request or a migration with, and
        // "empty" and "lives somewhere else" are different answers.
        //
        // They are now exported along, from the datatable, with the OWNER's
        // grade (the owner is who asks for the export — `loadOwnedApp`). If one
        // cannot be read, the whole export fails with its reason, and it does
        // so HERE: once under way the status is already 200 and the refusal
        // would arrive as valid, complete JSON.
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
                // The origin belongs in the file: without this line it holds a
                // table with rows the app does not own, with nothing saying
                // where they come from or where they stay.
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
}

async function queryData(req, res) {
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
}

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
async function batchRead(req, res) {
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
}

module.exports = { exportData, queryData, batchRead };
