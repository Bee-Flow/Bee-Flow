/**
 * The spreadsheet-file ADAPTER — the same interface as
 * ../nextcloudTable/adapter.js, answered in terms of files, sheets and the
 * three storages (index.js explains what differs from a Nextcloud table).
 *
 * The registry (../index.js) hands this object to routes, jobs and runners;
 * sync.js is `makeSync(adapter)` over it. Every member that reaches a module
 * with side effects is a LAZY getter or a call-time require: requiring the
 * registry, or this file, must never load a provider client, and the unit
 * tests stub the stores, `./linkerAuth` and `./providers` by request string.
 *
 * ── open(): THE CHEAP LOOK, THEN THE EXPENSIVE ONE ──────────────────
 * A file has a version marker (an etag, a Drive version, a Graph cTag) that
 * one metadata call answers. `open()` asks for it first and, unless the pass
 * must read anyway (forced, never succeeded, marked stale, no columns yet),
 * answers `unchanged` when it did not move — that is what makes a 5 s pulse
 * affordable. When it moved, the sheet is read (reading.js, through the
 * download cache) and hashed: a marker that moved without the content
 * moving (a rename, a share, another tab) is `unchanged` too, and the copy's
 * data_version stays where it was.
 *
 * ── WHAT A ROW IS ───────────────────────────────────────────────────
 * The sheet has no ids; identity.js derives one per row from the key column
 * the linker chose (found again each pass by its header hash, so a moved
 * column keeps working) or from the row number. A row without an id (blank,
 * key missing, duplicate key) is handed to the pipeline as `id: null` and
 * counted; the counts ride into `sync_state.identity`.
 *
 * ── TYPES ARE DECLARED ──────────────────────────────────────────────
 * Every column the map already knows keeps its declared type; only a column
 * that is NEW to the map is inferred (infer.js) and reported. Cells that do
 * not fit their column's type land NULL and are counted per column
 * (`sync_state.coercion`).
 */

'use strict';

const datatableStore = require('../../../../stores/datatableStore');
const { KIND, isMirror, PROVIDERS } = require('./index');
const { isSourceError, registerErrorClasses } = require('../mirror/errors');
const { ERROR_CLASS, SpreadsheetSourceError } = require('./errors');
const columns = require('./columns');
const identity = require('./identity');
const { rowFromSheet } = require('./rows');
const { DATA_LIMITS } = require('../../dataModel/vocabulary');

registerErrorClasses(ERROR_CLASS);

const TAG = '[SpreadsheetFile]';
const MAX_COERCION_KEYS = 10;

/** The columnMap entry of the key column, by the identity block (tolerant of a retype in flight). */
function keyEntryOf(source) {
    const id = identity.identityOf(source);
    if (id.mode !== 'key') return null;
    const map = (source && source.columnMap) || {};
    const entry = map[id.keyFieldId];
    if (entry && !entry.derived) return { fieldId: id.keyFieldId, headerHash: entry.headerHash || (columns.parseFieldId(id.keyFieldId) || {}).headerHash || null };
    const parsed = columns.parseFieldId(id.keyFieldId);
    return parsed ? { fieldId: id.keyFieldId, headerHash: parsed.headerHash } : null;
}

/**
 * The coercion bag the rows hand their misfits to. Serialised as the ten
 * worst columns so a sheet with a hundred sloppy columns does not swell the
 * sync state.
 */
function coercionBag() {
    const bag = {};
    Object.defineProperty(bag, 'toJSON', {
        enumerable: false,
        value() {
            const top = Object.entries(bag).sort((a, b) => b[1] - a[1]).slice(0, MAX_COERCION_KEYS);
            return Object.fromEntries(top);
        },
    });
    return bag;
}

/** Everything the columns derivation needs to know about the other mirrors in this scope. */
async function siblingsOf(scope) {
    // Every mirror in the scope, whatever its kind: a match relation may
    // point at a Nextcloud mirror. `byRef` indexes this kind's by file + sheet
    // so a link can tell "already linked" and a relation can name a sibling.
    const { fileKeyOf } = require('./reading');
    const mirrors = await datatableStore.listSourceMirrorsInScope(scope);
    const byId = new Map();
    const byRef = new Map();
    for (const m of mirrors) {
        byId.set(m.id, m);
        if (m.managedKind !== KIND) continue;
        const src = m.source || {};
        byRef.set(`${fileKeyOf(src.provider, src.file)}|${(src.sheet && src.sheet.name) || ''}`, m);
    }
    return { byId, byRef, linkedTargets: new Map(), linkedViews: new Map() };
}

const adapter = {
    KIND,
    TAG,
    label: 'the spreadsheet',
    builderKind: 'spreadsheet',
    isMirror,
    PAGE: 500,
    PROVIDERS,
    get errors() {
        const own = require('./errors');
        return { ...own, isSourceError, Err: own.SpreadsheetSourceError };
    },

    /** The linker's storage client, after the gates (linkerAuth.js). `auth` IS the linker: apiFor reads its api. */
    async resolveLinker(source, opts) {
        const linker = await require('./linkerAuth').resolveLinker(source, opts);
        return { auth: linker, api: linker.api, userId: linker.userId, session: linker.session };
    },
    apiFor(auth) {
        return auth && auth.api ? auth.api : auth;
    },
    siblingsOf,

    /**
     * Probe → maybe unchanged → read → hash → maybe unchanged → the columns,
     * the rows with their ids, and what the finish should record.
     */
    async open(api, table, { prev = {}, mustFetch = false, rowCap } = {}) {
        const reading = require('./reading');
        const source = table.source;
        const file = source.file || {};
        const ref = { provider: source.provider, fileId: file.id || null, driveId: file.driveId || null, path: file.path || null, name: file.name || null };
        const probe = await api.probe(ref);
        const now = new Date().toISOString();
        const sourceModifiedAt = probe.marker && (probe.marker.modified || probe.marker.modifiedTime || probe.marker.lastModifiedDateTime) || null;
        const base = { marker: probe.marker, lastProbeAt: now, sourceModifiedAt };
        if (!mustFetch && prev && prev.marker && api.markerEquals(probe.marker, prev.marker)) {
            return { unchanged: true, statePatch: base };
        }
        if (!probe.format) {
            throw new SpreadsheetSourceError(415, 'format_unsupported', `"${probe.name}" is not a spreadsheet Bee Flow can read.`, { ref: { provider: source.provider, fileId: file.id, path: file.path } });
        }
        const viaCells = probe.format === 'gsheet' || (!!api.cells && source.write && source.write.mode === 'graph_workbook');
        const headerRow = Number(source.headerRow) || 1;
        const sheetName = (source.sheet && source.sheet.name) || null;
        const read = await reading.readSheetOf(api, probe, { sheet: sheetName, headerRow, rowCap, viaCells });
        // The identity mode this read will use is decided BEFORE the hash:
        // in row mode the row numbers are part of the content (a blank row
        // deleted above the data moves every `r<n>` without moving a cell).
        const described = columns.describeHeader(read.header);
        const keyEntry = keyEntryOf(source);
        const keyCol = keyEntry ? (described.find(d => d.headerHash === keyEntry.headerHash) || { col: null }).col : null;
        const mode = keyCol !== null ? 'key' : 'row';
        const contentHash = reading.contentHashOf(read.header, read.rows, mode === 'row' ? read.rowNumbers : null);
        if (!mustFetch && prev && prev.contentHash && contentHash === prev.contentHash) {
            return { unchanged: true, statePatch: { ...base, contentHash } };
        }
        const warnings = [...(read.warnings || [])];

        // The columns as the pass will declare them: known ones keep their
        // type, new ones are inferred once and said so.
        const knownByHash = new Map();
        for (const [id, entry] of Object.entries(source.columnMap || {})) {
            if (!entry || entry.derived) continue;
            const hash = entry.headerHash || (columns.parseFieldId(id) || {}).headerHash;
            if (hash) knownByHash.set(hash, entry);
        }
        const unknown = described.filter(d => !knownByHash.has(d.headerHash));
        let inferred = new Map();
        if (unknown.length) {
            const { inferColumns } = require('./infer');
            const inf = inferColumns(read.header, read.rows, { dateCols: read.dateCols, formulaCols: read.formulaCols, numFmts: read.numFmts });
            inferred = new Map(inf.columns.map(c => [c.col, c]));
            for (const d of unknown) {
                const c = inferred.get(d.col);
                if (c) warnings.push(`New column "${d.name}" arrived as ${c.type}.`);
            }
        }
        // The key column's declared type: a number key mints one id for
        // every spelling of one number (identity.js), so the type travels
        // with the column.
        let keyType = 'text';
        const cols = described.map((d) => {
            const known = knownByHash.get(d.headerHash);
            const inf = inferred.get(d.col);
            const type = (known && known.type) || (inf && inf.type) || 'text';
            const c = { col: d.col, header: read.header[d.col], type, formula: read.formulaCols.has(d.col) };
            const numFmt = read.numFmts.get(d.col) || (known && known.numFmt) || null;
            if (numFmt) c.numFmt = numFmt;
            if (known && known.format) c.format = known.format;
            if (known && known.dateFormat) c.dateFormat = known.dateFormat;
            else if (inf && inf.dateFormat) c.dateFormat = inf.dateFormat;
            if (type === 'select') c.options = grownOptions(known && known.options, read.rows, d.col);
            if (d.col === keyCol) { c.key = true; keyType = type; }
            return c;
        });
        if (keyEntry && keyCol === null) {
            warnings.push('The key column is not in the header any more; rows are identified by row number until the owner picks another.');
        }

        // Ids, then the rows the pipeline pages through.
        const ids = identity.assignRowIds(read.rows, read.rowNumbers, { mode, keyCol, keyType });
        const coercion = coercionBag();
        const rows = read.rows.map((cells, i) => ({ id: ids.ids[i], rowNumber: read.rowNumbers[i], cells, coercion }));
        if (ids.duplicate) warnings.push(`${ids.duplicate} rows share a key with an earlier row and were skipped.`);
        if (ids.missing) warnings.push(`${ids.missing} rows have no value in the key column and were skipped.`);

        const statePatch = {
            ...base,
            contentHash,
            lastFetchAt: now,
            identity: { mode, missing: ids.missing, duplicate: ids.duplicate },
            coercion,
            file: { name: probe.name || file.name || null },
        };
        if (read.csv) statePatch.csv = read.csv;
        return {
            columns: cols,
            page: (limit, offset) => Promise.resolve(rows.slice(offset, offset + limit)),
            statePatch,
            warnings,
            // The reader stops at the cap and says so; at the engine's own
            // cap (10 000) there is no 10 001st row to hand the pipeline.
            truncated: !!read.truncated,
        };
    },

    /**
     * Header cells → fields (columns.js), plus what only this adapter knows:
     * an identity block that must follow the key column's field id (a
     * retype gives it a new id), and a select column whose options grew
     * (a model-only change the planner would not see).
     */
    deriveFields(cols, { existingFields = [], declaredRelations = [], source = {} } = {}) {
        const keyCol = (cols.find(c => c && c.key) || {}).col;
        const derived = columns.fieldsFromSheet(cols, {
            existingFields,
            existingColumnMap: source.columnMap || {},
            declaredRelations,
            keyCol: Number.isInteger(keyCol) ? keyCol : null,
        });
        const priorById = new Map((existingFields || []).filter(f => f && f.id).map(f => [f.id, f]));
        for (const f of derived.fields) {
            if (f.type !== 'select') continue;
            const before = priorById.get(f.id);
            if (before && JSON.stringify(before.options || []) !== JSON.stringify(f.options || [])) derived.changes.push(`options:${f.key}`);
        }
        const current = identity.identityOf(source);
        const sourcePatch = {};
        if (derived.keyFieldId && (current.mode !== 'key' || current.keyFieldId !== derived.keyFieldId)) {
            sourcePatch.identity = { mode: 'key', keyFieldId: derived.keyFieldId };
        }
        return { ...derived, sourcePatch };
    },

    /** A row without an id was skipped by identity.js (null = skipped). */
    rowFromSource(raw, ctx) {
        if (!raw || typeof raw.id !== 'string' || !raw.id) return null;
        return rowFromSheet(raw, { ...ctx, coercion: raw.coercion || null });
    },

    get sync() { return require('./sync'); },

    /**
     * The file first, then the copy (writeThrough.js): a read-only file is
     * refused before anything is probed, never written locally and swept by
     * the next pass.
     */
    get writeThrough() { return require('./writeThrough'); },
    get link() { return require('./link'); },
    /**
     * A storage push (events.js): a Nextcloud `file.*` event or a OneDrive
     * drive hint marks the mirror stale and kicks a pass — never a row patch,
     * a file event carries no row.
     */
    get events() { return require('./events'); },

    /**
     * The kind-specific half of the public projection (routes keep the
     * envelope). Never the column map, a header hash, a marker or a token.
     */
    publicSource(source) {
        const { wireIdOf } = require('./reading');
        const file = source.file || {};
        const write = source.write || {};
        const map = source.columnMap || {};
        const cols = [];
        let keyColumn = null;
        for (const [fieldId, entry] of Object.entries(map)) {
            if (!entry || entry.derived) continue;
            cols.push({ fieldId, col: entry.col, header: entry.header ?? null, type: entry.type || 'text', formula: !!entry.formula });
            if (entry.key) keyColumn = { col: entry.col, header: entry.header ?? null, fieldId };
        }
        cols.sort((a, b) => a.col - b.col);
        return {
            provider: source.provider || null,
            format: source.format || null,
            fileId: wireIdOf({ provider: source.provider, fileId: file.id, driveId: file.driveId, path: file.path, owned: source.owned !== false }),
            fileName: file.name || null,
            path: file.path || null,
            webUrl: file.webUrl || null,
            sheet: (source.sheet && source.sheet.name) || null,
            headerRow: Number(source.headerRow) || 1,
            keyColumn,
            owned: source.owned !== false,
            writable: !!write.mode && write.mode !== 'none',
            writeMode: write.mode || 'none',
            writeReason: write.reason || null,
            writeCaveats: Array.isArray(write.caveats) ? [...write.caveats] : [],
            sharedOptIn: write.sharedOptIn === true,
            columns: cols,
        };
    },
};

/** A select column's options: what it had, plus what this read shows, never fewer, capped. */
function grownOptions(prior, rows, col) {
    const out = [];
    const seen = new Set();
    for (const o of Array.isArray(prior) ? prior : []) {
        const label = String(o && typeof o === 'object' ? (o.label ?? '') : (o ?? '')).trim();
        if (label && !seen.has(label)) { seen.add(label); out.push(label); }
    }
    for (const r of rows) {
        if (out.length >= DATA_LIMITS.MAX_SELECT_OPTIONS) break;
        const v = r[col];
        if (v === null || v === undefined || v === '') continue;
        const label = String(v).trim().slice(0, DATA_LIMITS.MAX_NAME_LEN);
        if (label && !seen.has(label)) { seen.add(label); out.push(label); }
    }
    return out;
}

module.exports = adapter;
