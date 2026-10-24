const columns = require('./columns');
const identity = require('./identity');
const reading = require('./reading');
const formats = require('./formats');
const sync = require('./sync');
const { rejected } = require('./linkBrowse');
const { wireRef } = require('./linkRef');

const KEY_TYPES = ['text', 'number'];

/**
 * PUT /:id/source — the settings a spreadsheet mirror has: `refreshOnView`,
 * `headerRow`, `keyColumn` (a 0-based col, or null for row numbers) and
 * `columns: { [fieldId]: { type } }` (a retype). Anything that changes what
 * the copy holds marks it stale ('columns'); the pass then re-reads the
 * file and reconciles — a retype is DROP+ADD under the same key, a new key
 * column replaces every row id.
 *
 * A NEW key column is checked unique over a fresh read before it is
 * accepted — the same check the link runs (planTable), for the same reason:
 * the pass assigns ids first-occurrence-wins and drops the rest from the
 * copy with nothing but a warning, so a repeated or blank key would lose
 * rows silently. The read runs as the LINKER (what the pass will read;
 * an owner changing a setting need not hold a credential for the storage
 * at all), through the download cache. `ctx.api` lets a caller that
 * already holds a client hand it in; `ctx.orgId` is the table's org.
 * @returns {Promise<{ next:object, stale:false|string }>}
 */
async function applySettings(source, body, ctx = {}) {
    const b = body || {};
    for (const k of Object.keys(b)) {
        if (!['refreshOnView', 'headerRow', 'keyColumn', 'columns'].includes(k)) {
            throw rejected(400, 'unknown_field', `"${k}" is not a setting of a spreadsheet table`);
        }
    }
    const next = { ...source, columnMap: { ...((source && source.columnMap) || {}) } };
    let stale = false;
    if (b.refreshOnView !== undefined) next.refreshOnView = b.refreshOnView !== false;
    if (b.headerRow !== undefined) {
        const h = Number(b.headerRow);
        if (!Number.isInteger(h) || h < 1 || h > formats.MAX_HEADER_ROW) {
            throw rejected(400, 'spreadsheet_rejected', `The header row must be between 1 and ${formats.MAX_HEADER_ROW}.`);
        }
        if (h !== (Number(source.headerRow) || 1)) { next.headerRow = h; stale = 'columns'; }
    }
    if (b.columns !== undefined) {
        if (!b.columns || typeof b.columns !== 'object' || Array.isArray(b.columns)) {
            throw rejected(400, 'spreadsheet_rejected', '"columns" maps a field id to { type }.');
        }
        for (const [fieldId, v] of Object.entries(b.columns)) {
            const type = v && typeof v === 'object' ? v.type : v;
            if (!columns.DECLARABLE_TYPES.includes(type)) {
                throw rejected(400, 'spreadsheet_rejected', `A column can be one of ${columns.DECLARABLE_TYPES.join(', ')}.`);
            }
            const entry = next.columnMap[fieldId];
            if (!entry || entry.derived) throw rejected(400, 'unknown_field', `"${fieldId}" is not a column of this table`);
            if (entry.formula) throw rejected(400, 'derived_column', `"${entry.header || fieldId}" holds formulas and keeps the file's type.`);
            if (entry.type === type) continue;
            if (entry.key && !KEY_TYPES.includes(type)) {
                throw rejected(400, 'spreadsheet_rejected', 'The key column must stay a text or number column — pick another key first.');
            }
            const retyped = { ...entry, type };
            if (type !== 'select') delete retyped.options;
            next.columnMap[fieldId] = retyped;
            stale = 'columns';
        }
    }
    if (b.keyColumn !== undefined) {
        const current = identity.identityOf(next);
        const clearKeyFlags = () => {
            for (const [id, e] of Object.entries(next.columnMap)) {
                if (e && e.key) { const { key, ...rest } = e; void key; next.columnMap[id] = rest; }
            }
        };
        if (b.keyColumn === null) {
            if (current.mode !== 'row') {
                clearKeyFlags();
                next.identity = { mode: 'row' };
                stale = 'columns';
            }
        } else {
            const col = Number(b.keyColumn);
            const found = Object.entries(next.columnMap).find(([, e]) => e && !e.derived && e.col === col);
            if (!Number.isInteger(col) || !found) throw rejected(400, 'unknown_field', 'The key column must be one of the sheet\'s columns.');
            const [fieldId, entry] = found;
            if (entry.formula) throw rejected(400, 'derived_column', `"${entry.header || fieldId}" holds formulas and cannot be the key.`);
            if (!KEY_TYPES.includes(entry.type)) throw rejected(400, 'spreadsheet_rejected', 'Only a text or number column can be the key.');
            if (current.mode !== 'key' || current.keyFieldId !== fieldId) {
                await assertKeyUnique(source, next, fieldId, entry, ctx);
                clearKeyFlags();
                next.columnMap[fieldId] = { ...next.columnMap[fieldId], key: true };
                next.identity = { mode: 'key', keyFieldId: fieldId };
                stale = 'columns';
            }
        }
    }
    return { next, stale };
}

/**
 * The key-column check of planTable, over a fresh read of the linked sheet.
 * The column is found in the fresh header by its header hash — a column
 * that moved since the last pass keeps its id, so `col` may be stale, and
 * a renamed header at the old position is another column. Throws 422
 * key_missing when it is gone, 422 key_not_unique (+header, +detail) when
 * it repeats or has blanks.
 */
async function assertKeyUnique(source, next, fieldId, entry, ctx) {
    const api = ctx && ctx.api ? ctx.api : (await require('./linkerAuth').resolveLinker(source, { orgId: (ctx && ctx.orgId) || null })).api;
    const file = source.file || {};
    // `owned` rides along so a refusal names an own OneDrive file bare, as the browser does.
    const ref = { provider: source.provider, fileId: file.id || null, driveId: file.driveId || null, path: file.path || null, name: file.name || null, owned: source.owned === true };
    const probe = await api.probe(ref);
    // The refusal names the sheet the way the link did (a csv has none).
    const sheetName = probe.format === 'csv' ? null : ((source.sheet && source.sheet.name) || null);
    const wire = () => wireRef(source.provider, ref, sheetName);
    if (!probe.format) {
        throw rejected(415, 'format_unsupported', `"${probe.name}" is not a spreadsheet Bee Flow can read.`, { ref: wire() });
    }
    // The road the pass takes: by cells only where the link recorded that
    // the workbook API answers (never asked of Graph again here).
    const viaCells = probe.format === 'gsheet' || (!!api.cells && !!(source.write && source.write.mode === 'graph_workbook'));
    const read = await reading.readSheetOf(api, probe, {
        sheet: sheetName,
        headerRow: next.headerRow || Number(source.headerRow) || 1,
        rowCap: source.rowCap || sync.DEFAULT_ROW_CAP,
        viaCells,
    });
    const described = columns.describeHeader(read.header);
    // By header hash — never by position: a renamed header at the old
    // position is another column (strict column identity, columns.js).
    const kd = (entry.headerHash ? described.find(d => d.headerHash === entry.headerHash) : described.find(d => d.col === entry.col)) || null;
    const name = entry.header || fieldId;
    if (!kd) {
        throw rejected(422, 'key_missing', `"${name}" is no longer a column of the sheet, so it cannot be the key.`, { ref: wire(), header: name });
    }
    // Typed like the pass mints the ids: a number key's spellings are one key.
    const check = identity.checkKeyColumn(read.rows, kd.col, entry.type || 'text');
    if (!check.unique) {
        const why = [];
        if (check.missing) why.push(`${check.missing} rows have no value in it`);
        if (check.duplicate) why.push(`${check.duplicate} rows repeat a value${check.firstDuplicate ? ` ("${String(check.firstDuplicate).slice(0, 40)}")` : ''}`);
        throw rejected(422, 'key_not_unique', `"${kd.name}" cannot be the key: ${why.join(' and ')}.`, {
            ref: wire(), detail: why.join('; '), header: kd.name,
        });
    }
}

module.exports = { KEY_TYPES, wireRef, applySettings };
