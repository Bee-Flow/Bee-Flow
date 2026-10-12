/**
 * App Studio — CONNECTOR → TABLE SYNC.
 *
 * Runs a connector and writes its rows into one of the app's own tables, so the
 * app reads from local storage instead of hitting the upstream API on every
 * screen paint. Three things trigger it, all landing here:
 *
 *   • a schedule                 (jobs/studioAppConnectorSync.js)
 *   • someone opening the app    (routes/studioAppData.js, stale-while-serve)
 *   • "Refresh now"              (routes/studioAppConnectors.js)
 *
 * ── WHY THIS IS THE CHEAP PATH ──────────────────────────────────────
 * A connector binding used to mean one upstream call per viewer per paint. A
 * synced table means one call per REFRESH INTERVAL for the whole audience, and
 * the incremental tier narrows that further:
 *
 *   'request' — the stored watermark goes UP to the provider as a since-param,
 *               so only changed records come back at all.
 *   'client'  — no such param exists, so we fetch everything but only WRITE what
 *               changed. Saves database churn and version bumps, not API calls.
 *   'none'    — no watermark anywhere; every run replaces the table.
 *
 * The tier is DETECTED (appStudio/connectorSchema.js), never typed in.
 *
 * ── WRITES ──────────────────────────────────────────────────────────
 * Every row goes through actionExecutor.writeRecord / writeRecordBatch as the
 * OWNER — the single record-write choke point, so RLS and the storage quotas
 * apply to synced rows exactly as they do to typed-in ones. There is no second
 * write path, by design: a sync that bypassed the choke point could fill an app
 * past its quota from a background tick nobody is watching.
 *
 * ── IDEMPOTENCE ─────────────────────────────────────────────────────
 * 'upsert' mode matches incoming rows to existing ones on the connector's key
 * column (unique-indexed by the table proposal), so re-running a sync updates
 * rather than duplicates. 'replace' is for sources with no stable identity: the
 * table is emptied and refilled in one pass. A run that fails part-way leaves
 * the batch unwritten (writeRecordBatch is one transaction) and records the
 * error on the sync state.
 */

'use strict';

const connectors = require('./connectors');
const connectorSchema = require('./connectorSchema');
const dataModel = require('./dataModel');
const log = require('../telemetry/log');

// One sync never writes more than a connector run can return. The connector
// runtime already caps at MAX_CONNECTOR_ROWS; this is the second half of the
// promise that a background tick has a bounded cost.
const MAX_SYNC_ROWS = connectors._MAX_CONNECTOR_ROWS;
// Rows are updated one statement at a time (compileUpdate is keyed by record
// id), so a pathological "everything changed" run is bounded separately from
// the insert batch.
const MAX_SYNC_UPDATES = 500;
// Fallback cadence when a sync block carries no schedule: often enough to feel
// live, rare enough that an idle app costs nothing.
const DEFAULT_SYNC_MINUTES = 60;
// Key values per existing-record lookup. Matches the query compiler's bound-
// variable cap; a 500-row sync therefore costs three small indexed queries.
const KEY_LOOKUP_CHUNK = 200;

function isPlainObject(v) {
    return v !== null && typeof v === 'object' && !Array.isArray(v);
}

/**
 * The COLUMN on `table` that holds the incremental stamp.
 *
 * The sync's `incremental.field` names a path in the UPSTREAM row, which is not
 * necessarily what the column ended up being called. Matching sourcePath first
 * (then key, for tables whose columns simply share the name) is what lets the
 * retention purge find the right column on both the parent and its children.
 */
function retentionColumn(table, sourceField) {
    const fields = (table && table.fields) || [];
    const bySource = fields.find((f) => f && f.sourcePath === sourceField);
    if (bySource) return bySource.key;
    const byKey = fields.find((f) => f && f.key === sourceField);
    return byKey ? byKey.key : null;
}

// A retention cutoff is a string comparison against a stored stamp. Only these
// hold one; deleting rows by comparing a number or a bool to an ISO timestamp
// would be arbitrary, so a table whose candidate column is anything else counts
// as unreachable rather than as covered.
const RETENTION_COLUMN_TYPES = ['datetime', 'date', 'text'];

function datedColumn(table, declared, sourceField) {
    const fields = (table && table.fields) || [];
    // A DECLARED retentionField must exist on this table; falling back to the
    // sync's stamp when it doesn't would hide the author's typo behind a column
    // they never chose.
    const key = (typeof declared === 'string' && declared)
        ? (fields.some((f) => f && f.key === declared) ? declared : null)
        : (sourceField ? retentionColumn(table, sourceField) : null);
    if (!key) return null;
    const field = fields.find((f) => f && f.key === key);
    return field && RETENTION_COLUMN_TYPES.includes(field.type) ? key : null;
}

// A DEPENDENT's date column. Stricter than a child's: the connector never
// writes these rows, so there is no sync stamp to fall back to and no control
// over what a text column holds — the declared column must exist and be a real
// date. Comparing an ISO cutoff to arbitrary app-typed text would purge on
// string luck.
const DEPENDENT_RETENTION_COLUMN_TYPES = ['datetime', 'date'];

function dependentDatedColumn(table, declared) {
    if (typeof declared !== 'string' || !declared) return null;
    const field = ((table && table.fields) || []).find((f) => f && f.key === declared);
    return field && DEPENDENT_RETENTION_COLUMN_TYPES.includes(field.type) ? field.key : null;
}

/**
 * How a retention purge reaches every table this connector writes.
 *
 * PURE — no database, no clock. That is the point: the connector-save gate and
 * the purge itself must decide from the same rule. The purge used to skip, with
 * a console.warn, any table it could not find a date column on. A mailbox in
 * thread mode keeps the conversation stamp on the PARENT and the actual personal
 * data — every body, every sender, every attachment — in children that carry no
 * date at all, so a support desk could report a 90-day policy while deleting
 * nothing that mattered.
 *
 * Two ways a table ages out:
 *   'column'  — it has a date column of its own: a declared `retentionField`, or
 *               the column the sync's incremental stamp maps to
 *   'cascade' — it has none, and inherits its parent's age through the relation
 *               ("when the message goes, its attachments go") — the only honest
 *               semantics for a row whose age is not its own fact
 *
 * Besides `sync.children` (tables the connector WRITES), the plan also walks
 * `sync.dependents`: tables the connector never writes but whose lifetime it
 * governs — an app-written line-items or activity table hanging off the synced
 * conversation. Without them those rows sit in neither `steps` nor
 * `unreachable`, so they outlive the purge as orphans and the save-gate never
 * notices. Same two modes:
 *   { tableId, retentionField }                    — 'column': purged on its own date
 *   { tableId, relationField, parentTableId,
 *     retentionCascade: true }                     — 'cascade': goes when the parent row goes
 * Dependents run AFTER the primary and the children (their parent's purge must
 * have happened for a cascade to see the orphans), in declared order.
 *
 * Anything else lands in `unreachable`, and a connector that promises
 * `retentionDays` with a non-empty `unreachable` must not be saved.
 *
 * @returns {{ days:number, steps:Array<object>, unreachable:string[] }}
 */
function planRetention(model, connector) {
    const sync = isPlainObject(connector?.sync) ? connector.sync : null;
    const days = Number.isInteger(sync?.retentionDays) && sync.retentionDays > 0 ? sync.retentionDays : 0;
    const steps = [];
    const unreachable = [];
    if (!days) return { days: 0, steps, unreachable };

    const byId = new Map((model?.tables || []).filter(isPlainObject).map((t) => [t.id, t]));
    const stamp = isPlainObject(sync.incremental) ? sync.incremental.field : null;

    const primary = byId.get(sync.tableId) || null;
    if (!primary) return { days, steps, unreachable: [String(sync.tableId ?? 'unknown table')] };

    const primaryColumn = datedColumn(primary, sync.retentionField, stamp);
    if (primaryColumn) steps.push({ level: 0, table: primary, mode: 'column', column: primaryColumn });
    else unreachable.push(primary.key);

    const tableByLevel = new Map([[0, primary]]);
    // Tables this plan governs, by id — what a dependent's cascade may name as
    // its parent. A cascade to a table the plan never purges would delete
    // nothing forever, which is exactly the silence `unreachable` exists to end.
    const governedById = new Map([[primary.id, primary]]);
    const children = (Array.isArray(sync.children) ? sync.children : [])
        .filter(isPlainObject)
        .slice()
        .sort((a, b) => (a.level || 0) - (b.level || 0));

    for (const child of children) {
        const table = byId.get(child.tableId);
        if (!table) { unreachable.push(String(child.tableId ?? 'unknown table')); continue; }
        tableByLevel.set(child.level, table);
        governedById.set(table.id, table);

        const column = datedColumn(table, child.retentionField, stamp);
        if (column) { steps.push({ level: child.level, table, mode: 'column', column }); continue; }

        const parent = tableByLevel.get(child.parentLevel ?? 0) || null;
        if (child.retentionCascade && parent && typeof child.relationField === 'string') {
            steps.push({ level: child.level, table, mode: 'cascade', relationField: child.relationField, parentTable: parent });
            continue;
        }
        unreachable.push(table.key);
    }

    // Dependents: tables the connector does NOT write but whose lifetime it
    // governs. They get levels past every child so their steps sort after the
    // rows they hang off — a cascade dependent looks for orphans, and there are
    // none until its parent's own purge has run.
    const dependents = (Array.isArray(sync.dependents) ? sync.dependents : []).filter(isPlainObject);
    let dependentLevel = Math.max(0, ...children.map((c) => c.level || 0)) + 1;
    for (const dep of dependents) {
        const table = byId.get(dep.tableId);
        if (!table) { unreachable.push(String(dep.tableId ?? 'unknown table')); continue; }
        const level = dependentLevel++;

        const column = dependentDatedColumn(table, dep.retentionField);
        if (column) {
            steps.push({ level, table, mode: 'column', column });
            governedById.set(table.id, table);
            continue;
        }

        const parent = dep.parentTableId ? governedById.get(dep.parentTableId) || null : null;
        if (dep.retentionCascade && parent && typeof dep.relationField === 'string') {
            // sweepNull:false — dependents are app-authored, so a row whose
            // relation was left empty is live user data, not an orphan the
            // sync forgot to stamp. Only rows pointing at a purged parent go.
            steps.push({ level, table, mode: 'cascade', relationField: dep.relationField, parentTable: parent, sweepNull: false });
            governedById.set(table.id, table);
            continue;
        }
        unreachable.push(table.key);
    }

    // Parent-first. A cascade step asks "does my parent still exist?", so the
    // parent's own purge has to have run already — otherwise the first pass
    // deletes nothing and the child only catches up a sync later.
    steps.sort((a, b) => a.level - b.level);
    return { days, steps, unreachable };
}

function syncError(status, message, code) {
    const err = new Error(message);
    err.status = status;
    if (code) err.code = code;
    return err;
}

// ── scheduling ──────────────────────────────────────────────────────

/**
 * When should this connector run again? A cron schedule is resolved with the
 * SAME parser the automation scheduler uses, so a schedule the editor accepted is
 * one this can actually compute.
 */
/**
 * The scheduling rules now live in `core/scheduling/nextRun.js`, because a
 * second scheduler needs them: knowledge-base source refresh
 * (`core/kb/sources`), and `core/` may not require a product feature.
 *
 * `nextRunFor` below stays as an adapter — it holds the two things only this
 * feature knows, the connector's `sync.schedule` shape and the per-kind
 * cadence floor from the app data model — so every caller and every pinned
 * test here is untouched, and there is ONE definition of what a backoff is
 * rather than two that drift.
 */
const { nextRunFor: coreNextRunFor } = require('../core/scheduling/nextRun');

/**
 * The cadence floor for a connector kind. A mailbox may poll every 2 minutes;
 * everything else keeps the 15-minute floor.
 */
function floorFor(kind) {
    return typeof dataModel.minSyncMinutes === 'function'
        ? dataModel.minSyncMinutes(kind)
        : dataModel.MIN_SYNC_MINUTES;
}

function intervalMinutes(sync, kind) {
    const schedule = isPlainObject(sync?.schedule) ? sync.schedule : null;
    return Number.isInteger(schedule?.everyMinutes)
        ? Math.max(floorFor(kind), schedule.everyMinutes)
        : DEFAULT_SYNC_MINUTES;
}

function nextRunFor(sync, fromTs = Date.now(), kind = null, { consecutiveErrors = 0, retryAfterMs = 0 } = {}) {
    // The connector's own shape (`sync.schedule` + a per-kind cadence floor
    // that only the app data model knows) adapted onto the shared rules.
    const schedule = isPlainObject(sync?.schedule) ? sync.schedule : null;
    return coreNextRunFor(schedule, fromTs, {
        consecutiveErrors,
        retryAfterMs,
        defaultMinutes: DEFAULT_SYNC_MINUTES,
        floorMinutes: floorFor(kind),
    });
}

/** How old may the data be before a view should kick a refresh? */
function stalenessMs(sync, kind = null) {
    const schedule = isPlainObject(sync?.schedule) ? sync.schedule : null;
    if (schedule && typeof schedule.cron === 'string' && schedule.cron) {
        // A cron schedule has no single interval; treat the minimum cadence as
        // the staleness bound so an on-view refresh can't outpace it.
        return floorFor(kind) * 60_000;
    }
    return intervalMinutes(sync, kind) * 60_000;
}

/** Is this table's data old enough that opening the app should refresh it? */
function isStale(state, sync, now = Date.now(), kind = null) {
    if (!sync || sync.refreshOnView === false) return false;
    if (!state || !state.lastRunAt) return true;              // never synced
    if (state.status === 'running') return false;             // already in flight
    return (now - new Date(state.lastRunAt).getTime()) >= stalenessMs(sync, kind);
}

// ── watermark rendering ─────────────────────────────────────────────

/** Render the stored watermark into the shape the action's since-param wants. */
function renderWatermark(iso, format) {
    if (!iso) return null;
    const t = Date.parse(iso);
    if (Number.isNaN(t)) return null;
    if (format === 'unix') return Math.floor(t / 1000);
    if (format === 'date') return new Date(t).toISOString().slice(0, 10);
    return new Date(t).toISOString();
}

/** The highest watermark value across a set of rows, as a comparable ISO string. */
function highWatermark(rows, field, current = null) {
    if (!field) return current;
    let best = current;
    for (const row of rows) {
        const iso = connectorSchema.toIsoStamp(connectorSchema.readPath(row, field));
        if (iso && (!best || iso > best)) best = iso;
    }
    return best;
}

// ── row → column mapping ────────────────────────────────────────────

/**
 * Map one upstream row onto the table's columns.
 *
 * A field's `sourcePath` (stamped by the table proposal) is authoritative;
 * without one we fall back to matching the column key against the row's own
 * keys, so a column the author added by hand still fills if it is named after
 * the upstream field. Values are shaped for the column's type — objects and
 * arrays become JSON text, timestamps become ISO strings — because the query
 * compiler coerces per type and would otherwise reject or mangle them.
 */
function mapRowToColumns(row, table) {
    const out = {};
    if (!isPlainObject(row)) return out;
    const rowKeys = Object.keys(row);
    const lowered = new Map(rowKeys.map((k) => [connectorSchema.slugifyKey(k), k]));

    for (const field of table.fields || []) {
        if (field.type === 'computed') continue;      // derived, never written
        const path = typeof field.sourcePath === 'string' && field.sourcePath
            ? field.sourcePath
            : (lowered.get(field.key) || field.key);
        const raw = connectorSchema.readPath(row, path);
        if (raw === undefined) continue;
        out[field.key] = coerceForField(raw, field);
    }
    return out;
}

function coerceForField(value, field) {
    if (value === null) return null;
    switch (field.type) {
        case 'bool':
            return value === true || value === 1 || value === 'true' || value === '1';
        case 'number': {
            const n = typeof value === 'number' ? value : Number(value);
            return Number.isFinite(n) ? n : null;
        }
        case 'date': {
            const iso = connectorSchema.toIsoStamp(value);
            return iso ? iso.slice(0, 10) : (typeof value === 'string' ? value : null);
        }
        case 'datetime': {
            const iso = connectorSchema.toIsoStamp(value);
            return iso || (typeof value === 'string' ? value : null);
        }
        case 'multiselect':
        case 'file': {
            // Hand the VALUE through, not JSON text. Every synced row still goes
            // through the query compiler, whose coerceValue serialises these
            // column types — so stringifying here meant every file/multiselect
            // a connector wrote was serialised TWICE. One JSON.parse then gave
            // back a string, `.kind` was undefined, and the whole attachment
            // chain (preview, materialize, AI read) found "no descriptor" on a
            // row that plainly had one.
            if (Array.isArray(value) || isPlainObject(value)) return value;
            // A source that hands us pre-serialised JSON text (some APIs do) is
            // unwrapped for the same reason — otherwise the compiler re-wraps it.
            if (typeof value === 'string') {
                try {
                    const parsed = JSON.parse(value);
                    if (Array.isArray(parsed) || isPlainObject(parsed)) return parsed;
                } catch { /* not JSON — fall through */ }
            }
            return String(value);
        }
        default:
            if (Array.isArray(value) || isPlainObject(value)) return JSON.stringify(value);
            return typeof value === 'string' ? value : String(value);
    }
}

// ── the sync ────────────────────────────────────────────────────────

function defaultDeps() {
    return {
        runConnector: (...a) => require('./connectors').runConnector(...a),
        writeRecord: (...a) => require('./actionExecutor').writeRecord(...a),
        writeRecordBatch: (...a) => require('./actionExecutor').writeRecordBatch(...a),
        compileKeyIndex: (...a) => require('./queryCompiler').compileKeyIndex(...a),
        compileDeleteAll: (...a) => require('./queryCompiler').compileDeleteAll(...a),
        compileDeleteOlderThan: (...a) => require('./queryCompiler').compileDeleteOlderThan(...a),
        compileDeleteOrphans: (...a) => require('./queryCompiler').compileDeleteOrphans(...a),
        exec: (...a) => require('../stores/studioAppDbStore').exec(...a),
        query: (...a) => require('../stores/studioAppDbStore').query(...a),
        claimSync: (...a) => require('../stores/studioAppDataStore').claimSync(...a),
        finishSync: (...a) => require('../stores/studioAppDataStore').finishSync(...a),
        getSyncState: (...a) => require('../stores/studioAppDataStore').getSyncState(...a),
        bumpDataVersion: (...a) => require('../stores/studioAppDataStore').bumpDataVersion(...a),
        setRowCount: (...a) => require('../stores/studioAppDataStore').setRowCount(...a),
        listAttachments: (...a) => require('../stores/studioAppDataStore').listAttachments(...a),
        deleteAttachment: (...a) => require('../stores/studioAppDataStore').deleteAttachment(...a),
        deleteFile: (...a) => require('../stores/storageStore').deleteFile(...a),
        buildAttachmentKey: (...a) => require('../stores/storageStore').buildStudioAppAttachmentKey(...a),
    };
}

/**
 * The attachment ids referenced by the rows a retention purge is about to
 * delete. Read BEFORE the delete: afterwards the only pointer to the blob is
 * gone and it becomes unreachable garbage holding personal data.
 *
 * Returns [] whenever the table has no file columns, which is the common case
 * and costs one cheap check rather than a query.
 */
async function collectExpiredFiles(app, table, where, whereParams, deps) {
    const fileFields = (table.fields || []).filter((f) => f && f.type === 'file');
    if (!fileFields.length) return [];

    const cols = fileFields.map((f) => `"${f.key}"`).join(', ');
    // The WHERE comes straight off the compiled DELETE, so this selects exactly
    // the rows that are about to go — never an approximation of them.
    const sql = `SELECT ${cols} FROM "${table.key}" WHERE ${where} LIMIT 5000`;
    const { rows } = await deps.query(app.userId, app.id, sql, whereParams);

    const ids = [];
    for (const row of rows || []) {
        for (const f of fileFields) {
            const raw = row[f.key];
            if (!raw) continue;
            // Bounded unwrap: rows written while descriptors were double-encoded
            // parse to a STRING first. Skipping them here would delete the row
            // at retention but keep the blob and its ledger entry — the actual
            // document living on forever behind a 90-day policy.
            let parsed = raw;
            for (let i = 0; i < 3 && typeof parsed === 'string'; i++) {
                try { parsed = JSON.parse(parsed); } catch { parsed = null; break; }
            }
            if (!parsed || typeof parsed !== 'object') continue;
            for (const d of (Array.isArray(parsed) ? parsed : [parsed])) {
                // Only redeemed files own a blob; a pending mailbox descriptor
                // points at the provider and leaves nothing of ours behind.
                if (d && d.kind === 'studio_attachment' && d.fileId) ids.push(d.fileId);
            }
        }
    }
    return ids;
}

/**
 * Delete the ledger rows, and the blobs that no longer have a ledger row.
 *
 * Keys are content-addressed by sha256, so two records attaching the identical
 * file share one blob. Deleting it because ONE of them expired would silently
 * break the other — hence the refcount over the remaining ledger.
 */
async function purgeAttachments(app, fileIds, deps) {
    const before = await deps.listAttachments(app.id, app.userId).catch(() => []);
    const byId = new Map((before || []).map((a) => [a.id, a]));

    const shas = new Set();
    for (const id of fileIds) {
        const row = byId.get(id);
        if (!row) continue;
        shas.add(row.sha256);
        await deps.deleteAttachment(id, app.id, app.userId).catch(() => {});
    }
    if (!shas.size) return;

    const after = await deps.listAttachments(app.id, app.userId).catch(() => null);
    if (!after) return; // could not confirm — leave the blob rather than orphan a live row
    const stillUsed = new Set(after.map((a) => a.sha256));
    for (const sha of shas) {
        if (stillUsed.has(sha)) continue;
        await deps.deleteFile(deps.buildAttachmentKey(app.userId, app.id, sha)).catch(() => {});
    }
}

// The owner sees the whole table — a sync is the owner's own refresh of their
// own feed. Passed explicitly so the compilers stay un-callable unscoped.
const OWNER_FILTER = Object.freeze({ where: '1=1', params: [] });

// The identity the sync writes as. A connector is owner-scoped by construction
// (its rows come from the OWNER's upstream account), so its rows are written as
// the owner — which is also the only role with unconditional write access.
function ownerViewer(app) {
    return { id: app.userId, role: 'owner' };
}

/**
 * Which of THESE key values already have a record, as (key → record id).
 *
 * Scoped to the incoming batch rather than the whole table: a full-table read is
 * capped by the storage engine at 10k rows, so a bigger table would hand back a
 * partial map and every unmatched row would be re-inserted as a duplicate on
 * every single sync. Chunked because a bound `IN (…)` list has a hard limit.
 */
async function existingKeyMap(app, table, keyColumn, keys, deps) {
    const map = new Map();
    const wanted = [...new Set(keys.filter((k) => k !== null && k !== undefined && k !== '').map(String))];
    for (let i = 0; i < wanted.length; i += KEY_LOOKUP_CHUNK) {
        const chunk = wanted.slice(i, i + KEY_LOOKUP_CHUNK);
        const { sql, params } = deps.compileKeyIndex(table, keyColumn, chunk, OWNER_FILTER);
        const result = await deps.query(app.userId, app.id, sql, params);
        // The storage engine answers { rows, columns, truncated }; a stub in a
        // test may hand back the bare array.
        const rows = Array.isArray(result) ? result : (result?.rows || []);
        for (const r of rows) {
            const k = r?.k;
            if (k === null || k === undefined || k === '') continue;
            if (!map.has(String(k))) map.set(String(k), r.id);
        }
    }
    return map;
}

/**
 * Write one grain's rows into one table, and report where each row landed.
 *
 * `recordIdByRowIndex` is what makes related tables work: a child grain's rows
 * carry `_parentIndex` (the position of the parent row they came from), so after
 * writing the parent we can hand each child its parent's REAL record id. Joining
 * on a value instead would mean guessing which column is the parent's key and
 * hoping the expanded element didn't shadow it.
 *
 * @returns {Promise<{ inserted, updated, recordIdByRowIndex: (string|null)[] }>}
 */
async function writeGrain(app, model, table, rows, { mode, keyField: keyPath, viewer, deps, relation = null } = {}) {
    const effectiveMode = mode === 'replace' ? 'replace' : (keyPath ? 'upsert' : 'replace');
    const recordIdByRowIndex = new Array(rows.length).fill(null);
    let inserted = 0;
    let updated = 0;

    // Map a source row onto columns, adding the parent link when this is a child.
    const toValues = (row) => {
        const values = mapRowToColumns(row, table);
        if (relation?.field) {
            const parentIndex = row?._parentIndex;
            const parentId = Number.isInteger(parentIndex) ? relation.parentIds?.[parentIndex] : null;
            // A row whose parent could not be written gets no dangling reference.
            if (parentId) values[relation.field] = parentId;
        }
        return values;
    };

    if (effectiveMode === 'replace') {
        // Only wipe when there is something to put back: a transient upstream
        // hiccup returning zero rows must not empty a working table.
        if (rows.length) {
            const del = deps.compileDeleteAll(table, OWNER_FILTER);
            await deps.exec(app.userId, app.id, del.sql, del.params);
            const ids = await deps.writeRecordBatch(app, model, table, rows.map(toValues), { viewer });
            inserted = ids.length;
            ids.forEach((id, i) => { recordIdByRowIndex[i] = id; });
            await deps.setRowCount(app.id, table.key, inserted, app.userId).catch(() => {});
        }
        return { inserted, updated, recordIdByRowIndex };
    }

    const keyField = table.fields.find((f) => f.sourcePath === keyPath)
        || table.fields.find((f) => f.key === connectorSchema.slugifyKey(keyPath));
    if (!keyField) throw syncError(409, 'the column this connector matches rows on is gone', 'key_missing');

    // Dedupe WITHIN the batch first. A chained connector can legitimately emit
    // the same key twice (two attachments of one message folded back onto the
    // message), and inserting both would breach the key column's unique index.
    // First occurrence wins — upstream lists are newest-first far more often
    // than not. `rowIndex` is kept so the child link survives the dedupe.
    const mapped = [];
    const seenInBatch = new Map();
    for (const [rowIndex, row] of rows.entries()) {
        const values = toValues(row);
        const k = values[keyField.key];
        const key = (k === null || k === undefined) ? null : String(k);
        if (key !== null) {
            if (seenInBatch.has(key)) { recordIdByRowIndex[rowIndex] = seenInBatch.get(key); continue; }
            seenInBatch.set(key, null);
        }
        mapped.push({ values, key, rowIndex });
    }

    const existing = await existingKeyMap(app, table, keyField.key, [...seenInBatch.keys()], deps);
    const toInsert = [];
    const toUpdate = [];
    for (const entry of mapped) {
        const recordId = entry.key === null ? null : existing.get(entry.key);
        if (recordId) toUpdate.push({ ...entry, recordId });
        else toInsert.push(entry);
    }
    for (const u of toUpdate.slice(0, MAX_SYNC_UPDATES)) {
        const res = await deps.writeRecord(app, model, table, u.values, { viewer, recordId: u.recordId });
        if (res?.changes) updated += 1;
        recordIdByRowIndex[u.rowIndex] = u.recordId;
    }
    if (toInsert.length) {
        const ids = await deps.writeRecordBatch(app, model, table, toInsert.map((e) => e.values), { viewer });
        inserted = ids.length;
        toInsert.forEach((e, i) => { if (ids[i]) recordIdByRowIndex[e.rowIndex] = ids[i]; });
    }
    // A duplicate key inside the batch points at the row that actually got written.
    for (const [rowIndex, id] of recordIdByRowIndex.entries()) {
        if (id) continue;
        const row = rows[rowIndex];
        if (!row) continue;
        const k = mapRowToColumns(row, table)[keyField.key];
        if (k !== null && k !== undefined) {
            const winner = mapped.find((m) => m.key === String(k));
            if (winner) recordIdByRowIndex[rowIndex] = recordIdByRowIndex[winner.rowIndex];
        }
    }

    return { inserted, updated, recordIdByRowIndex };
}

/**
 * Run one connector and write its rows into its table.
 *
 * @param {object} app        { id, userId, organizationId }
 * @param {object} model      the app's data model (source of tables + connectors)
 * @param {object} connector  the connector, from model.connectors
 * @param {object} [opts]     { reason, force, _deps }
 * @returns {Promise<{ inserted, updated, skipped, rows, watermark, nextRunAt, partial }>}
 */
async function syncConnector(app, model, connector, { reason = 'manual', force = false, _deps } = {}) {
    const deps = { ...defaultDeps(), ...(_deps || {}) };
    const sync = isPlainObject(connector?.sync) ? connector.sync : null;
    if (!sync) throw syncError(400, 'this connector does not fill a table', 'not_synced');

    const table = (model?.tables || []).find((t) => t && t.id === sync.tableId) || null;
    if (!table) throw syncError(409, 'the table this connector fills no longer exists', 'table_missing');

    // Claim first: two replicas ticking the same second must not both run this.
    const claim = await deps.claimSync(app.id, connector.id, app.userId, { tableKey: table.key });
    if (!claim && !force) {
        return { skipped: 0, inserted: 0, updated: 0, rows: 0, alreadyRunning: true, reason };
    }

    const started = Date.now();
    try {
        const incremental = isPlainObject(sync.incremental) ? sync.incremental : null;
        const priorWatermark = claim?.watermark || null;

        // 'request' tier: the watermark rides UP to the provider, so only what
        // changed is ever fetched.
        const params = {};
        if (incremental?.param && priorWatermark) {
            const rendered = renderWatermark(priorWatermark, incremental.format);
            if (rendered !== null) params[incremental.param] = rendered;
        }

        // The since-param is OURS, not the audience's: it is never a declared
        // viewer param, so it rides the systemArgs channel (merged like pinned
        // args, but still below them so an author's pin always wins).
        // `trace` when child tables are configured: a chain that expands ends with
        // one row per attachment, so the message-level rows only exist in the
        // per-grain view. Without it we could not fill the parent table at all.
        const children = Array.isArray(sync.children) ? sync.children : [];
        const result = await deps.runConnector(connector, {
            app,
            viewerId: app.userId,          // a sync is the owner's own read
            params: {},
            // A mailbox filters server-side by date rather than through a
            // declared since-param, so it reads the watermark straight off
            // systemArgs. Scoped to that kind so every other connector's
            // systemArgs stays exactly what its author declared.
            systemArgs: connector.kind === 'mailbox' && priorWatermark
                ? { ...params, since: priorWatermark }
                : params,
            trace: children.length > 0,
        });
        const grains = Array.isArray(result?.grains) ? result.grains : null;
        // The primary table stores grain 0 (the source list), not the flattened
        // output — those differ the moment a step expands.
        const primaryRows = grains ? (grains[0]?.rows || []) : (result?.rows || []);
        let rows = Array.isArray(primaryRows) ? primaryRows.slice(0, MAX_SYNC_ROWS) : [];

        // 'client' tier: everything came back, but only newer rows are written.
        let skipped = 0;
        if (incremental?.field && !incremental.param && priorWatermark) {
            const before = rows.length;
            rows = rows.filter((row) => {
                const iso = connectorSchema.toIsoStamp(connectorSchema.readPath(row, incremental.field));
                return !iso || iso > priorWatermark;
            });
            skipped = before - rows.length;
        }

        const viewer = ownerViewer(app);
        const primary = await writeGrain(app, model, table, rows, {
            mode: sync.mode, keyField: sync.keyField, viewer, deps,
        });
        let inserted = primary.inserted;
        let updated = primary.updated;

        // Child tables: one per chain step that expanded. Written AFTER the
        // parent so each child row can carry the parent's real record id — the
        // link is resolved from the positional `_parentIndex` the runner stamped,
        // never by matching a column name.
        //
        // Ids are kept PER LEVEL because a child is not necessarily a child of
        // grain 0. A mailbox in thread mode produces conversations (0) →
        // messages (1) → attachments (2), and an attachment belongs to its
        // message. Passing grain 0's ids unconditionally, as this did, would
        // have related every attachment to a ticket instead — quietly, since
        // both are valid record ids.
        //
        // `?? 0` and not `?? level - 1`: every connector written before this
        // declares no parentLevel and must keep relating to grain 0 exactly as
        // it did. Deeper nesting is opt-in.
        const recordIdsByLevel = { 0: primary.recordIdByRowIndex };
        const childResults = [];
        const ordered = [...children].sort((a, b) => (a.level || 0) - (b.level || 0));
        for (const child of ordered) {
            const childTable = (model?.tables || []).find((t) => t && t.id === child.tableId);
            const grain = grains?.[child.level];
            if (!childTable || !grain) continue;
            const parentIds = recordIdsByLevel[child.parentLevel ?? 0];
            if (!parentIds) {
                log.warn(`[ConnectorSync] child ${child.tableId} wants level ${child.parentLevel} which was not written`);
                continue;
            }
            const res = await writeGrain(app, model, childTable, (grain.rows || []).slice(0, MAX_SYNC_ROWS), {
                mode: child.mode, keyField: child.keyField, viewer, deps,
                relation: { field: child.relationField, parentIds },
            });
            recordIdsByLevel[child.level] = res.recordIdByRowIndex;
            inserted += res.inserted;
            updated += res.updated;
            childResults.push({ tableId: child.tableId, table: childTable.key, inserted: res.inserted, updated: res.updated });
        }

        // Retention purge. Runs AFTER a successful write so a failed pull can
        // never be the thing that deletes history. `retentionDays` is required
        // on a mailbox connector precisely because this exists — a retention
        // setting that deleted nothing would be a compliance claim we don't keep.
        let purged = 0;
        const plan = planRetention(model, connector);
        if (plan.days) {
            const cutoff = new Date(Date.now() - plan.days * 24 * 60 * 60 * 1000).toISOString();
            // A table the plan cannot reach is a compliance gap, not a detail.
            // Saving the connector is supposed to refuse this outright — if one
            // slips through (a table edited after the connector was saved) it
            // gets said out loud rather than warned about once per run.
            if (plan.unreachable.length) {
                log.error(`[ConnectorSync] RETENTION GAP on ${app.id}/${connector.id}: ${plan.unreachable.join(', ')} keep data past ${plan.days} days`);
            }

            // Parent-first: `steps` is ordered by grain, so a cascade child runs
            // after the parent rows it inherits its age from are already gone.
            for (const step of plan.steps) {
                try {
                    const del = step.mode === 'cascade'
                        ? deps.compileDeleteOrphans(step.table, OWNER_FILTER, {
                            relationField: step.relationField,
                            parentTableMeta: step.parentTable,
                            sweepNull: step.sweepNull,
                        })
                        : deps.compileDeleteOlderThan(step.table, OWNER_FILTER, { field: step.column, cutoffIso: cutoff });

                    // Collect the FILES those rows point at before the rows go —
                    // afterwards there is nothing left to find them by. Deleting
                    // the row but keeping the blob and the ledger entry would
                    // leave the actual document (an invoice, an ID scan) in
                    // storage forever while the app reports a 90-day policy.
                    const doomedFiles = await collectExpiredFiles(app, step.table, del.where, del.whereParams, deps);

                    const res = await deps.exec(app.userId, app.id, del.sql, del.params);
                    purged += res?.changes || 0;

                    if (doomedFiles.length) await purgeAttachments(app, doomedFiles, deps);
                } catch (e) {
                    // Retention is a background hygiene pass; failing it must not
                    // fail the sync that just succeeded.
                    log.warn(`[ConnectorSync] retention purge failed on ${app.id}/${connector.id} (${step.table.key}): ${e.message}`);
                }
            }
            if (purged) log.info(`[ConnectorSync] purged ${purged} row(s) past retention on ${app.id}/${connector.id}`);
        }

        const watermark = incremental?.field ? highWatermark(rows, incremental.field, priorWatermark) : null;
        // A successful run clears the error streak, so the cadence returns to
        // normal immediately rather than staying backed off.
        const nextRunAt = nextRunFor(sync, Date.now(), connector.kind);
        await deps.finishSync(app.id, connector.id, {
            status: 'ok', watermark, rowsWritten: inserted + updated, nextRunAt, error: null, consecutiveErrors: 0,
        });

        return {
            inserted, updated, skipped, rows: rows.length,
            ...(purged ? { purged } : {}),
            watermark, nextRunAt, reason,
            durationMs: Date.now() - started,
            ...(childResults.length ? { children: childResults } : {}),
            ...(result?.partial ? { partial: true } : {}),
        };
    } catch (err) {
        // A failure still schedules the next attempt — a connector that is down
        // for an hour must recover on its own, not stay dead until someone
        // notices. The message is kept so the editor can show WHY.
        // …but back off as the streak grows, and honour a provider's Retry-After.
        // Rescheduling a throttled mailbox at its normal 2-minute cadence is how
        // a soft 429 becomes a hard block.
        const priorErrors = Number.isInteger(claim?.consecutiveErrors) ? claim.consecutiveErrors : 0;
        const consecutiveErrors = priorErrors + 1;
        await deps.finishSync(app.id, connector.id, {
            status: 'error',
            rowsWritten: 0,
            nextRunAt: nextRunFor(sync, Date.now(), connector.kind, {
                consecutiveErrors,
                retryAfterMs: err?.retryAfterMs || 0,
            }),
            error: err?.message || String(err),
            consecutiveErrors,
        }).catch(() => {});
        throw err;
    }
}

module.exports = {
    syncConnector,
    nextRunFor,
    stalenessMs,
    isStale,
    mapRowToColumns,
    renderWatermark,
    highWatermark,
    // Pure, and shared with the save-time gate in dataModel — one rule for
    // "can this connector keep the retention promise it makes?"
    planRetention,
    DEFAULT_SYNC_MINUTES,
    MAX_SYNC_ROWS,
    // Every test stubs these, which is what let an UNEXPORTED
    // actionExecutor.writeRecordBatch ship and fail only at refresh time. Exposed
    // so one test can assert the real wiring resolves.
    _defaultDeps: defaultDeps,
};
