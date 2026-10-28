// @typecheck
const { KEY_RE } = require('../../dataModel/vocabulary');
const columns = require('./columns');
const identity = require('./identity');
const reading = require('./reading');
const formats = require('./formats');
const { inferColumns } = require('./infer');
const { isoDate, isoDateTime, hasTime } = require('./cells');
const sync = require('./sync');
const { KIND } = require('./index');
const { rejected, assertProvider } = require('./linkBrowse');
const { KEY_TYPES } = require('./linkSettings');
const { wireRef } = require('./linkRef');
const { pickTab } = require('./linkRelink');

function clampHeaderRow(headerRow) {
    if (headerRow === undefined || headerRow === null || headerRow === '') return 1;
    const h = Number(headerRow);
    if (!Number.isInteger(h) || h < 1 || h > formats.MAX_HEADER_ROW) {
        throw rejected(422, 'spreadsheet_rejected', `The header row must be between 1 and ${formats.MAX_HEADER_ROW}.`);
    }
    return h;
}

function cellText(v) {
    if (v === null || v === undefined) return '';
    if (v instanceof Date) return Number.isNaN(v.getTime()) ? '' : (hasTime(v) ? isoDateTime(v) : isoDate(v));
    return String(v);
}

/** Probe a file, list its tabs, read one — the same three steps describe and link take. */
async function openForCaller(ctx, ref, { sheet, headerRow, rowCap }) {
    const probe = await ctx.api.probe(ref);
    if (!probe.format) {
        throw rejected(415, 'format_unsupported', `"${probe.name}" is not a spreadsheet Bee Flow can read.`, { ref: wireRef(ref.provider, ref) });
    }
    const viaCells = await reading.cellsAvailable(ctx.api, probe);
    const tabs = await reading.listSheetsOf(ctx.api, probe, { viaCells });
    const chosen = pickTab(tabs, sheet, probe.format, ref);
    const read = await reading.readSheetOf(ctx.api, probe, {
        sheet: probe.format === 'csv' ? null : chosen.name, headerRow, rowCap, viaCells,
    });
    return { probe, viaCells, tabs, chosen, read, workbook: viaCells && probe.format !== 'gsheet' };
}

/** Select options for a column at link time: the distinct values of the read, in order, capped. */
function optionsOf(rows, col) {
    const seen = new Set();
    const out = [];
    for (const r of rows) {
        const v = r[col];
        if (v === null || v === undefined || v === '') continue;
        const label = cellText(v).trim();
        if (!label || seen.has(label)) continue;
        seen.add(label);
        out.push(label);
        if (out.length >= 100) break;
    }
    return out;
}

function defaultNameFor(probe, chosen, tabs) {
    const base = String(probe.name || 'Sheet').replace(/\.[a-z0-9]+$/i, '').trim() || 'Sheet';
    return tabs.length > 1 && chosen.name ? `${base} – ${chosen.name}` : base;
}

/** The `source` block of a planned mirror. */
function sourceBlock(p, principal, ncInstanceId) {
    return {
        kind: KIND,
        provider: p.provider,
        format: p.probe.format,
        file: {
            id: p.probe.file.fileId || null,
            driveId: p.probe.file.driveId || null,
            path: p.probe.path || p.probe.file.path || null,
            name: p.probe.name || null,
            webUrl: p.probe.webUrl || null,
        },
        sheet: p.sheet,
        headerRow: p.headerRow,
        identity: p.keyFieldId ? { mode: 'key', keyFieldId: p.keyFieldId } : { mode: 'row' },
        csv: p.csv,
        owned: !!p.probe.owned,
        write: p.write,
        ncInstanceId: p.provider === 'nextcloud_files' ? ncInstanceId : null,
        linkedByUserId: principal.userId,
        linkedAt: new Date().toISOString(),
        schedule: sync.scheduleOf(),
        refreshOnView: true,
        rowCap: sync.DEFAULT_ROW_CAP,
        columnMap: {},
        relations: [],
    };
}

/**
 * Validate ONE requested sheet as the caller: probe, read, resolve the
 * columns' types, check the key column. Returns the plan or throws.
 */
async function planTable(t, { apiFor, siblings, seenRefs, warnings, spec }) {
    if (!t || typeof t !== 'object') throw rejected(400, 'spreadsheet_rejected', 'Each entry names a file and a sheet.');
    assertProvider(t.provider);
    const provider = t.provider;
    const ref = reading.fileRefOf(provider, { fileId: t.fileId, driveId: t.driveId, path: t.path });
    const wanted = t.sheet === undefined || t.sheet === null || t.sheet === '' ? null : String(t.sheet);
    const h = clampHeaderRow(t.headerRow);
    const ctx = await apiFor(provider);
    const opened = await openForCaller(ctx, ref, { sheet: wanted, headerRow: h, rowCap: sync.DEFAULT_ROW_CAP });
    const { probe, tabs, chosen, read, workbook } = opened;
    const sheetName = chosen.name || null;
    const refKey = `${reading.fileKeyOf(provider, { id: probe.file.fileId, path: probe.file.path })}|${sheetName || ''}`;
    if (seenRefs.has(refKey)) throw rejected(400, 'spreadsheet_rejected', 'The same sheet is listed twice.', { ref: wireRef(provider, probe.file, sheetName) });
    seenRefs.add(refKey);
    const already = siblings.byRef.get(refKey);
    if (already) {
        throw rejected(409, 'already_linked', `"${already.name}" already mirrors that sheet.`, { ref: wireRef(provider, probe.file, sheetName), datatableId: already.id });
    }

    const described = columns.describeHeader(read.header);
    const declared = new Map();
    for (const c of Array.isArray(t.columns) ? t.columns : []) {
        if (!c || !Number.isInteger(c.col)) continue;
        if (c.type !== undefined && c.type !== null && !columns.DECLARABLE_TYPES.includes(c.type)) {
            throw rejected(422, 'spreadsheet_rejected', `"${c.header || columns.columnLetter(c.col)}" cannot be a ${String(c.type).slice(0, 20)} column here.`, { ref: wireRef(provider, probe.file, sheetName) });
        }
        declared.set(c.col, c);
    }
    let inferred = null;
    if (described.some(d => !declared.has(d.col) || !declared.get(d.col).type)) {
        inferred = new Map(inferColumns(read.header, read.rows, { dateCols: read.dateCols, formulaCols: read.formulaCols, numFmts: read.numFmts }).columns.map(c => [c.col, c]));
    }
    const cols = described.map((d) => {
        const w = declared.get(d.col);
        const inf = inferred && inferred.get(d.col);
        if (w && w.header !== undefined && w.header !== null && columns.headerText(w.header) !== d.header) {
            warnings.push(`Column ${d.letter} is now "${d.header}" (the wizard saw "${columns.headerText(w.header)}").`);
        }
        const type = (w && w.type) || (inf && inf.type) || 'text';
        const c = { col: d.col, header: read.header[d.col], type, formula: read.formulaCols.has(d.col) };
        const numFmt = read.numFmts.get(d.col);
        if (numFmt) c.numFmt = numFmt;
        if (inf && inf.dateFormat) c.dateFormat = inf.dateFormat;
        if (type === 'select') c.options = optionsOf(read.rows, d.col);
        return c;
    });

    let keyCol = null;
    let keyFieldId = null;
    if (t.keyColumn !== undefined && t.keyColumn !== null) {
        const col = Number(t.keyColumn);
        const kd = described.find(d => d.col === col);
        if (!Number.isInteger(col) || !kd) {
            throw rejected(422, 'key_missing', 'The key column is not one of the header columns.', { ref: wireRef(provider, probe.file, sheetName) });
        }
        const kc = cols.find(c => c.col === col);
        if (kc.formula) throw rejected(422, 'spreadsheet_rejected', `"${kd.name}" holds formulas and cannot be the key.`, { ref: wireRef(provider, probe.file, sheetName) });
        if (!KEY_TYPES.includes(kc.type)) throw rejected(422, 'spreadsheet_rejected', `Only a text or number column can be the key — "${kd.name}" is ${kc.type}.`, { ref: wireRef(provider, probe.file, sheetName) });
        // Checked as the pass will mint the ids (identity.js): in a number
        // column '7,5' and '7.50' are one key, so they are reported here as
        // a duplicate rather than becoming one skipped row at the first pass.
        const check = identity.checkKeyColumn(read.rows, col, kc.type);
        if (!check.unique) {
            const why = [];
            if (check.missing) why.push(`${check.missing} rows have no value in it`);
            if (check.duplicate) why.push(`${check.duplicate} rows repeat a value${check.firstDuplicate ? ` ("${String(check.firstDuplicate).slice(0, 40)}")` : ''}`);
            throw rejected(422, 'key_not_unique', `"${kd.name}" cannot be the key: ${why.join(' and ')}.`, { ref: wireRef(provider, probe.file, sheetName), detail: why.join('; '), header: kd.name });
        }
        kc.key = true;
        keyCol = col;
        keyFieldId = columns.fieldIdFor(kd.headerHash, kc.type);
    }

    const fallbackName = defaultNameFor(probe, chosen, tabs);
    const name = String(t.name || fallbackName).trim().slice(0, 120) || fallbackName;
    const key = String(t.key || columns.keyFromTitle(name, 0, new Set())).trim();
    if (!KEY_RE.test(key)) {
        throw rejected(400, 'spreadsheet_rejected', `"${key}" is not a valid technical name — lowercase letters, numbers and underscores, starting with a letter.`, { ref: wireRef(provider, probe.file, sheetName) });
    }
    const description = String(t.description ?? spec.defaultDescription).trim() || spec.defaultDescription;
    const write = reading.writeModeFor({
        provider, format: probe.format, owned: probe.owned, writable: probe.writable, workbook, sharedOptIn: t.sharedWriteOptIn === true,
    });
    return {
        provider, ref, probe, refKey, described, cols, keyCol, keyFieldId,
        sheet: { id: chosen.id ?? null, name: sheetName, index: Number.isInteger(chosen.index) ? chosen.index : 0 },
        headerRow: h, csv: read.csv || null, write,
        name, key, description,
    };
}

module.exports = { clampHeaderRow, cellText, openForCaller, sourceBlock, planTable };
