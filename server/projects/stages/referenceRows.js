/**
 * Reference rows: the rows of a Dev `is_reference` table that a pipeline
 * release carries into every stage (design section 2, D20, 3.2).
 *
 * A reference table holds configuration (a price list, a lookup), never people,
 * so three things happen here and nowhere else:
 *
 *   captureReferenceRows  reads each reference table through queryCompiler,
 *                         applies the caps and the personal-data gate, and
 *                         hands back the payload rows the release cut stores in
 *                         `solution_release_payloads` (never in the manifest).
 *   planReferenceRows     the insert / update / delete a stage needs.
 *   applyReferenceRows    writes them inside the deploy's commit transaction,
 *                         on the caller's client, with `allowLockedRows`.
 *
 * ── THE PAYLOAD ROW ────────────────────────────────────────────────
 * `{ id, values: { <fieldId>: value } }`, sorted by id, nulls left out. Keyed by
 * the FIELD ID, not the key: pipeline mode keeps field ids stable from Dev to
 * every stage, while a key can be renamed by the same release that carries
 * the rows. `canonicalRows` is exported so a stage's current rows hash the same
 * way (stagePayload), and `hashReferenceRows` is the one content hash.
 *
 * ── PERSONAL DATA IS BLOCKING, WITHOUT ACKNOWLEDGEMENT (D20) ──────
 * A reference table has no subject column, so a data subject request can never
 * find its rows, and a release copy would outlive retention. Every column is
 * therefore judged with core/privacy/personalColumns (values where the guard
 * can read them, names everywhere else) over EVERY row, not a sample: one
 * address in one cell is enough to stop the release. Findings name columns and
 * kinds, never a value. A text column the guard could NOT read (no guard
 * installed, degraded, failing) is blocking too (`reference.unscanned`): D20
 * allows no personal data at all, and an unread column is not a clean one, so
 * unlike the KB side's `pii_status = 'unscanned'` no acknowledgement clears
 * it: the cut is retried once the guard can read the column.
 *
 * ── WHAT THE STAGE TABLE ENFORCES ──────────────────────────────────
 * The rows land in a stage table whose constraints can be stricter than Dev's:
 * a relation column carries an inline FK to the target's STAGE table, and a
 * required column created by CREATE TABLE is NOT NULL even where Dev added it
 * nullable. So the cut refuses a relation whose target is not carried too
 * (`reference.relation_not_carried`) and a NULL in a required column
 * (`reference.required_null`); the deploy applies tables in
 * `referenceApplyOrder` (upserts parent first, deletes child first), and a
 * violation that still happens surfaces as a typed 409.
 */

'use strict';

const crypto = require('crypto');
const queryCompiler = require('../../core/dataEngine/queryCompiler');
const personal = require('../../core/privacy/personalColumns');
const { toDollarParams } = require('../../stores/lib/pgAppEngine');
const { HttpError } = require('../../core/http/errors');

/** Caps from design section 2. Over any of them the release is blocked. */
const LIMITS = Object.freeze({
    maxRowsPerTable: 5000,
    maxBytesPerTable: 2 * 1024 * 1024,
    maxBytesPerRelease: 8 * 1024 * 1024,
});

/** Page size for the capture read; the compiler's own ceiling. */
const PAGE = 1000;

/** The release cut and the deploy read and write the whole table. */
const ALL_ROWS = Object.freeze({ where: 'TRUE', params: [] });

const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

function stableStringify(value) {
    if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
    if (isObj(value)) {
        return `{${Object.keys(value).sort().map(k => `${JSON.stringify(k)}:${stableStringify(value[k])}`).join(',')}}`;
    }
    return JSON.stringify(value === undefined ? null : value);
}

/** Fields that hold a stored value a row writer may set. */
function writableFields(descriptor) {
    return (Array.isArray(descriptor && descriptor.fields) ? descriptor.fields : [])
        .filter(f => isObj(f) && typeof f.id === 'string' && typeof f.key === 'string' && f.type !== 'computed');
}

function pad2(n) { return String(n).padStart(2, '0'); }

/**
 * A DATE as 'YYYY-MM-DD', whichever driver parsed it: node-pg makes LOCAL
 * midnight, pglite UTC midnight, and reading the wrong half moves the day on
 * any server not on UTC. Same rule as pgAppEngine's dateOnlyString.
 */
function dateOnly(v) {
    const utcMidnight = v.getUTCHours() === 0 && v.getUTCMinutes() === 0 && v.getUTCSeconds() === 0 && v.getUTCMilliseconds() === 0;
    return utcMidnight
        ? `${v.getUTCFullYear()}-${pad2(v.getUTCMonth() + 1)}-${pad2(v.getUTCDate())}`
        : `${v.getFullYear()}-${pad2(v.getMonth() + 1)}-${pad2(v.getDate())}`;
}

/** One cell, in the form the compiler writes back unchanged. */
function canonicalValue(v, field) {
    if (v === null || v === undefined) return undefined;
    if (v instanceof Date) return field.type === 'date' ? dateOnly(v) : v.toISOString();
    if (field.type === 'date' && typeof v === 'string') return v.slice(0, 10);
    // Stored as JSON text; the compiler stringifies on write, so a string
    // read back must be parsed or the next write double-encodes it.
    if ((field.type === 'multiselect' || field.type === 'file') && typeof v === 'string') {
        try { return JSON.parse(v); } catch { return v; }
    }
    if (field.type === 'number' && typeof v === 'string' && v.trim() !== '' && Number.isFinite(Number(v))) {
        return Number(v);
    }
    return v;
}

/**
 * Database rows (keyed by column key) → payload rows (keyed by field id),
 * sorted by id. System columns other than `id` never travel: created_by and
 * org_id are Dev's, and the stage stamps its own.
 */
function canonicalRows(descriptor, dbRows) {
    const fields = writableFields(descriptor);
    const out = [];
    for (const r of Array.isArray(dbRows) ? dbRows : []) {
        if (!isObj(r) || r.id === null || r.id === undefined) continue;
        const values = {};
        for (const f of fields) {
            const v = canonicalValue(r[f.key], f);
            if (v !== undefined) values[f.id] = v;
        }
        out.push({ id: String(r.id), values });
    }
    return out.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

/** The content hash of a payload's rows (order-independent per row). */
function hashReferenceRows(rows) {
    return crypto.createHash('sha256').update(stableStringify(rows || []), 'utf8').digest('hex');
}

// ── Capture ─────────────────────────────────────────────────────────

/**
 * Why a table may not carry reference rows, or null. The same five rules the
 * datatable store applies when the flag is set (datatables.referenceRefusal);
 * checked again at the cut because the flag is old by then.
 */
function referenceRefusal(meta) {
    const pick = (camel, snake) => (meta[camel] !== undefined ? meta[camel] : meta[snake]);
    if (pick('subjectColumn', 'subject_column')) return 'subject_column';
    if (pick('rowScope', 'row_scope') === 'own') return 'row_scope_own';
    if (pick('managedKind', 'managed_kind')) return 'managed';
    const source = meta.source;
    if (source !== null && source !== undefined) return 'source_mirror';
    const retention = pick('retentionDays', 'retention_days');
    if (retention !== null && retention !== undefined) return 'retention';
    return null;
}

/** The relation fields of a descriptor, with their target table id. */
function relationFields(descriptor) {
    return writableFields(descriptor)
        .filter(f => f.type === 'relation' && isObj(f.relation) && typeof f.relation.table === 'string');
}

/**
 * Would the stage column refuse a NULL? ddl.js columnDef makes a required
 * column NOT NULL, and a relation only when it has a default; an explicit NULL
 * beats a DEFAULT, and the apply names every column.
 */
function stageNotNull(f) {
    const hasDefault = f.default !== undefined && f.default !== null;
    return !!f.required && (f.type !== 'relation' || hasDefault);
}

/**
 * Rows the stage table would refuse: a relation value pointing into a table
 * the release does not carry (its stage table holds other ids, or none), and a
 * NULL in a column the stage table creates NOT NULL. Column keys only.
 */
function stageConstraintFindings(descriptor, rows, carriedIds, base) {
    const out = [];
    const fields = writableFields(descriptor);
    const keyOf = new Map(fields.map(f => [f.id, f.key]));
    const relations = relationFields(descriptor)
        .filter(f => f.relation.table !== descriptor.id && !carriedIds.has(f.relation.table))
        .filter(f => rows.some(r => r.values[f.id] !== undefined));
    if (relations.length) {
        out.push({
            code: 'reference.relation_not_carried', ...base, acknowledgeable: false,
            columns: relations.map(f => ({ key: f.key, targetTableId: f.relation.table })),
        });
    }
    const required = fields.filter(stageNotNull)
        .map(f => ({ key: keyOf.get(f.id), rows: rows.filter(r => r.values[f.id] === undefined).length }))
        .filter(c => c.rows > 0);
    if (required.length) out.push({ code: 'reference.required_null', ...base, acknowledgeable: false, columns: required });
    return out;
}

function optionFor(options, ref) {
    if (!options || !ref) return null;
    const o = options instanceof Map ? options.get(ref) : options[ref];
    return isObj(o) ? o : null;
}

/**
 * Is this table carried? The part option set in Dev decides when present;
 * otherwise the table's own `is_reference` flag.
 */
function isCarried(meta, opt) {
    if (opt && typeof opt.reference === 'boolean') return opt.reference;
    return !!(meta.isReference !== undefined ? meta.isReference : meta.is_reference);
}

async function readAllRows(descriptor, scope, deps, cap) {
    const rows = [];
    let cursor = null;
    for (;;) {
        const compiled = queryCompiler.compileRecordList(descriptor, {
            sort: { field: 'id', dir: 'asc' }, limit: PAGE, cursor, dialect: 'pg',
        }, ALL_ROWS);
        const res = await deps.query(scope, { sql: compiled.sql, params: compiled.params });
        const page = Array.isArray(res) ? res : (res && res.rows) || [];
        const hasMore = page.length > compiled.limit;
        const kept = hasMore ? page.slice(0, compiled.limit) : page;
        rows.push(...kept);
        // One row over the cap is all it takes to know the table is too big.
        if (rows.length > cap || !hasMore || !kept.length) break;
        cursor = queryCompiler.encodeCursor(kept[kept.length - 1].id, kept[kept.length - 1].id);
    }
    return rows;
}

/**
 * Every cell of one text column through the guard, in requests of at most
 * SAMPLE_CHARS, stopping at the first hit. Cells longer than one request's
 * cell budget are cut into pieces, so no part of a cell goes unread.
 * → { personal: entry|null, scanned: boolean }
 */
async function scanColumn(field, values, scan) {
    const pieces = [];
    for (const v of values) {
        for (let i = 0; i < v.length; i += personal.MAX_CELL_CHARS) pieces.push({ v: v.slice(i, i + personal.MAX_CELL_CHARS) });
    }
    const nameKind = personal.kindFromName(field);
    for (let at = 0; at < pieces.length;) {
        const { blob, cells } = personal.sampleCells(pieces.slice(at), 'v', { sampleRows: pieces.length });
        if (!cells.length) break;
        at += cells.length;
        let result = null;
        try { result = await scan(blob); } catch { result = null; }
        if (!result || result.degraded) return { personal: null, scanned: false };
        const weighed = personal.weighColumn(cells, result.entities, nameKind);
        if (weighed.kinds.length) {
            return {
                scanned: true,
                personal: { key: field.key, name: field.name || field.key, kind: weighed.kinds[0], by: 'values', nameKind, ...weighed },
            };
        }
    }
    return { personal: null, scanned: true };
}

/**
 * Which columns of these rows hold personal data. Values answer for every
 * text column the guard read; names answer for the rest (a date column called
 * `dob`, or every column when no guard is installed).
 * → { columns, unscanned: string[] }
 */
async function personalColumnsOf(descriptor, dbRows, scan) {
    const fields = writableFields(descriptor);
    const found = [];
    const scanned = [];
    const unscanned = [];
    for (const f of fields) {
        if (!personal.SCANNABLE_TYPES.includes(f.type)) continue;
        const values = dbRows.map(r => (r && typeof r[f.key] === 'string' ? r[f.key].trim() : '')).filter(Boolean);
        if (!values.length) continue;
        if (typeof scan !== 'function') { unscanned.push(f.key); continue; }
        const res = await scanColumn(f, values, scan);
        if (!res.scanned) { unscanned.push(f.key); continue; }
        scanned.push(f.key);
        if (res.personal) found.push(res.personal);
    }
    const merged = personal.mergeDetections({ fields, byValue: scanned.length ? found : null, scanned });
    return { columns: merged.columns, unscanned };
}

function defaultCaptureDeps() {
    return {
        query: async (scope, { sql, params }) => {
            const datatableDbStore = require('../../stores/datatableDbStore');
            const key = datatableDbStore.scopeKey(scope);
            return datatableDbStore.query(key, key, sql, params);
        },
        // 'bulk' keeps a release scan behind interactive chat traffic.
        scan: (text) => require('../../core/privacy/piiDetection').detectPii(text, null, undefined, { priority: 'bulk' }),
    };
}

/**
 * Read every carried reference table and judge it.
 *
 * @param {object} input
 * @param {Array<{ref: string, meta?: object, descriptor?: object, table?: object, scope?: object}>} input.tables
 *   one entry per Dev datatable part: `meta` is the datatables row (camel or
 *   snake case), `descriptor` its model entry `{id, key, fields}`. A single
 *   `table` object carrying both is accepted too.
 * @param {Map|object} [input.options]  ref → part option `{reference: boolean}`
 * @param {object} [deps] `{ query(scope, {sql, params}) → rows|{rows}, scan(text), limits }`
 * @returns {Promise<{payloads: object[], findings: object[]}>}
 */
async function captureReferenceRows({ tables = [], options = null } = {}, deps = {}) {
    const d = { ...defaultCaptureDeps(), ...deps };
    const limits = { ...LIMITS, ...(d.limits || {}) };
    const payloads = [];
    const findings = [];
    let releaseBytes = 0;
    const entries = (Array.isArray(tables) ? tables : []).filter(isObj).map((entry) => ({
        entry,
        meta: entry.meta || entry.table || entry,
        descriptor: entry.descriptor || entry.table || entry,
        ref: entry.ref || null,
    })).filter(x => isCarried(x.meta, optionFor(options, x.ref)));
    // A relation may point at another table only when that one travels too.
    const carriedIds = new Set(entries.filter(x => !referenceRefusal(x.meta)).map(x => x.descriptor.id || x.meta.id));
    for (const { entry, meta, descriptor, ref } of entries) {
        const tableId = descriptor.id || meta.id;
        const base = { severity: 'blocking', ref, tableId };

        const refusal = referenceRefusal(meta);
        if (refusal) { findings.push({ code: 'reference.not_allowed', ...base, reason: refusal }); continue; }

        const scope = entry.scope || meta.scope || { kind: meta.scopeKind || meta.scope_kind || 'org', id: meta.scope_id || meta.organizationId || meta.organization_id };
        const dbRows = await readAllRows(descriptor, scope, d, limits.maxRowsPerTable);
        if (dbRows.length > limits.maxRowsPerTable) {
            findings.push({ code: 'reference.too_large', ...base, limit: 'rows', max: limits.maxRowsPerTable });
            continue;
        }
        const rows = canonicalRows(descriptor, dbRows);
        const bytes = Buffer.byteLength(JSON.stringify(rows), 'utf8');
        if (bytes > limits.maxBytesPerTable) {
            findings.push({ code: 'reference.too_large', ...base, limit: 'table_bytes', bytes, max: limits.maxBytesPerTable });
            continue;
        }

        const judged = await personalColumnsOf(descriptor, dbRows, d.scan);
        if (judged.columns.length) {
            findings.push({
                code: 'reference.personal_data',
                ...base,
                acknowledgeable: false,
                columns: judged.columns.map(c => ({ key: c.key, kind: c.kind, by: c.by })),
            });
            continue;
        }
        if (judged.unscanned.length) {
            // No acknowledgement (D20): retry the cut once the guard reads.
            findings.push({ code: 'reference.unscanned', ...base, acknowledgeable: false, columns: judged.unscanned });
            continue;
        }
        const contentHash = hashReferenceRows(rows);
        const stageFindings = stageConstraintFindings(descriptor, rows, carriedIds, base);
        if (stageFindings.length) { findings.push(...stageFindings); continue; }

        releaseBytes += bytes;
        if (releaseBytes > limits.maxBytesPerRelease) {
            findings.push({ code: 'reference.too_large', ...base, limit: 'release_bytes', bytes: releaseBytes, max: limits.maxBytesPerRelease });
            continue;
        }
        payloads.push({ ref, kind: 'reference_rows', sourceEntityId: tableId, payload: { rows }, contentHash });
    }
    return { payloads, findings };
}

// ── Plan ────────────────────────────────────────────────────────────

/**
 * What a stage table needs to equal the release.
 *
 * @param {Array<{id, values}>} stageTableRows  the stage's rows, canonical
 *   (`canonicalRows(descriptor, dbRows)`).
 * @param {{rows: Array<{id, values}>}|Array} payload  the release payload.
 * @returns {{insert: object[], update: object[], delete: string[]}}
 */
function planReferenceRows(stageTableRows, payload) {
    const wanted = Array.isArray(payload) ? payload : (payload && payload.rows) || [];
    const current = new Map((stageTableRows || []).map(r => [String(r.id), stableStringify(r.values || {})]));
    const insert = [];
    const update = [];
    const keep = new Set();
    for (const row of wanted) {
        const id = String(row.id);
        keep.add(id);
        if (!current.has(id)) insert.push(row);
        else if (current.get(id) !== stableStringify(row.values || {})) update.push(row);
    }
    const del = [...current.keys()].filter(id => !keep.has(id)).sort();
    return { insert, update, delete: del };
}

// ── Apply ───────────────────────────────────────────────────────────

const quoted = (name) => `"${String(name).replace(/"/g, '""')}"`;

/**
 * The scope's row schema, resolved on the caller's client: the hashed name,
 * or the pre-hash `dtorg_<id>` while a tenant still lives there (the same
 * rule as datatableDbStore.assertScopeUsable).
 */
async function resolveScopeSchema(client, scope) {
    const { schemaNameFor, LEGACY_ORG_PREFIX } = require('../../stores/datatableDbStore');
    const hashed = schemaNameFor(scope.kind, scope.id);
    const legacy = scope.kind === 'org' ? LEGACY_ORG_PREFIX + scope.id : null;
    const r = await client.query(
        'SELECT to_regnamespace($1::text) IS NOT NULL AS has_hashed, to_regnamespace($2::text) IS NOT NULL AS has_legacy',
        [quoted(hashed), legacy === null ? null : quoted(legacy)],
    );
    const row = (r.rows && r.rows[0]) || {};
    if (row.has_hashed) return hashed;
    if (row.has_legacy && legacy) return legacy;
    const e = new HttpError(409, 'reference_table_missing', 'The stage table for these reference rows does not exist');
    e.errorClass = 'reference_table_missing';
    throw e;
}

/** Constraint violations a stage table can raise on these writes. */
const VIOLATIONS = Object.freeze({ 23502: 'not_null', 23503: 'foreign_key', 23505: 'unique' });

async function run(client, compiled, tableMeta) {
    try {
        return await client.query(toDollarParams(compiled.sql, compiled.params.length), compiled.params);
    } catch (e) {
        const kind = e && VIOLATIONS[e.code];
        if (!kind) throw e;
        // Names only: Postgres's DETAIL carries the offending value.
        throw new HttpError(409, 'reference_rows_violate',
            `The reference rows break a ${kind.replace('_', ' ')} constraint of the stage table`,
            { tableId: tableMeta.id || null, violation: kind, column: e.column || null, constraint: e.constraint || null });
    }
}

/** Topological order over `edges` (id → ids it depends on); a cycle keeps input order. */
function dependencyOrder(ids, edges) {
    const out = [];
    const state = new Map();
    const visit = (id) => {
        if (state.get(id) === 'done' || state.get(id) === 'busy') return;
        state.set(id, 'busy');
        for (const dep of edges.get(id) || []) if (ids.includes(dep) && dep !== id) visit(dep);
        state.set(id, 'done');
        out.push(id);
    };
    for (const id of ids) visit(id);
    return out;
}

/**
 * The order a deploy applies reference tables in: a relation's target before
 * the table pointing at it, so every FK finds its row. Upserts run in this
 * order, deletes in the reverse (`phase` of applyReferenceRows), so a parent
 * row goes only after the children that pointed at it.
 *
 * @param {Array<{id: string, fields: object[]}>} descriptors
 * @returns {string[]} table ids, parents first
 */
function referenceApplyOrder(descriptors) {
    const list = (Array.isArray(descriptors) ? descriptors : []).filter(d => isObj(d) && typeof d.id === 'string');
    const edges = new Map(list.map(d => [d.id, relationFields(d).map(f => f.relation.table)]));
    return dependencyOrder(list.map(d => d.id), edges);
}

/** Rows of one table with every self-relation parent before its child. */
function parentsFirst(tableMeta, rows) {
    const self = relationFields(tableMeta).filter(f => f.relation.table === tableMeta.id).map(f => f.id);
    if (!self.length) return rows;
    const byId = new Map(rows.map(r => [String(r.id), r]));
    const edges = new Map(rows.map(r => [String(r.id), self.map(fid => r.values && r.values[fid]).filter(v => v !== undefined).map(String)]));
    return dependencyOrder([...byId.keys()], edges).map(id => byId.get(id));
}

/**
 * Make a stage table hold exactly the release's reference rows: upsert by id,
 * then delete every id the release does not carry. Runs on `client` (the
 * deploy's commit transaction); every statement comes from queryCompiler with
 * `allowLockedRows`, because the stage table is row-locked for everyone else.
 * The search path is narrowed to the scope's schema for these statements only
 * and handed back afterwards, so the rest of the commit sees public tables.
 *
 * A payload value for a field the stage table does not (yet) have is not
 * written; its field id is reported in `skippedFieldIds`. Rows of a table that
 * points at itself are written parent first. Several tables: call once per
 * table with `phase: 'upsert'` in referenceApplyOrder, then with
 * `phase: 'delete'` in the reverse order. A constraint violation is an
 * HttpError 409 `reference_rows_violate` naming the column, never the value.
 *
 * @param {object} client  `{ query(sql, params) }` inside a transaction
 * @param {{scope: {kind, id}, tableMeta: object, rows: Array<{id, values}>, runAsUserId: string,
 *          phase?: 'upsert'|'delete'|'all'}} args
 * @param {{resolveSchema?: Function}} [deps]
 * @returns {Promise<{written: number, deleted: number, skippedFieldIds: string[]}>}
 */
async function applyReferenceRows(client, { scope, tableMeta, rows, runAsUserId, phase = 'all' }, deps = {}) {
    if (!client || typeof client.query !== 'function') throw new Error('applyReferenceRows needs the transaction client');
    const resolveSchema = deps.resolveSchema || resolveScopeSchema;
    const schema = await resolveSchema(client, scope);
    const fields = writableFields(tableMeta);
    const byId = new Map(fields.map(f => [f.id, f]));
    const orgId = scope && scope.kind === 'org' ? scope.id : null;
    const opts = { dialect: 'pg', allowLockedRows: true };
    const skipped = new Set();

    const before = await client.query(`SELECT current_setting('search_path') AS p`);
    const previousPath = (before.rows && before.rows[0] && before.rows[0].p) || 'public';
    await client.query(`SET LOCAL search_path = ${quoted(schema)}, pg_temp`);
    let written = 0;
    let deleted = 0;
    try {
        const list = Array.isArray(rows) ? rows : [];
        const keep = new Set(list.map(r => String(r.id)));
        for (const row of phase === 'delete' ? [] : parentsFirst(tableMeta, list)) {
            const id = String(row.id);
            const values = {};
            // Every writable column is named, so a value cleared in Dev is
            // cleared here too instead of keeping the stage's old value.
            for (const f of fields) values[f.key] = null;
            for (const [fid, v] of Object.entries(row.values || {})) {
                const f = byId.get(fid);
                if (!f) { skipped.add(fid); continue; }
                values[f.key] = v;
            }
            const compiled = queryCompiler.compileUpsertById(tableMeta, id, values, ALL_ROWS, {
                ...opts, createdBy: runAsUserId || null, orgId,
            });
            const r = await run(client, compiled, tableMeta);
            written += Number(r && r.rowCount) || 0;
        }
        const listed = phase === 'upsert' ? { rows: [] }
            : await run(client, queryCompiler.compileIdList(tableMeta, ALL_ROWS, { dialect: 'pg' }), tableMeta);
        for (const r of listed.rows || []) {
            const id = String(r.id);
            if (keep.has(id)) continue;
            const res = await run(client, queryCompiler.compileDelete(tableMeta, id, ALL_ROWS, opts), tableMeta);
            deleted += Number(res && res.rowCount) || 0;
        }
    } finally {
        try {
            await client.query(`SELECT set_config('search_path', $1, true)`, [previousPath]);
        } catch { /* an aborted transaction: the caller's error is the one that matters */ }
    }
    return { written, deleted, skippedFieldIds: [...skipped].sort() };
}

module.exports = {
    captureReferenceRows,
    planReferenceRows,
    applyReferenceRows,
    referenceApplyOrder,
    canonicalRows,
    hashReferenceRows,
    referenceRefusal,
    LIMITS,
    _resolveScopeSchema: resolveScopeSchema,
};
