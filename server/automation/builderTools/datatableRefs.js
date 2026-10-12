/**
 * Datatable vocabulary for the builder — what the model SAYS versus what the
 * step STORES.
 *
 * Measured on local builds (2026-09): a datatable step arrives with
 * `op:"append"`, its column map under `fields`/`row`, the table under `tableId`
 * (or wrapped as a `{kind:"literal"}` binding, or spelled by its NAME), and the
 * value keys spelled as the column TITLES the catalog showed ("Excl. btw")
 * instead of the keys (excl_btw). Each of those cost a whole rejected round,
 * and the model's repair was as often a fresh guess as the right name. These
 * helpers read the unambiguous forms — and SAY they did, in notes the caller
 * surfaces as _warnings — and reject only what cannot be resolved without
 * guessing: a name that fits two tables, a table chosen by a ref, a key that
 * fits two columns, a column the table does not have.
 *
 * Pure: no db, no state, and no integrations/ (automation/ must not require
 * it — the layering test), which is why normaliseKey is a copy of
 * integrations/nextcloudTablesTools.js normaliseColumnKey rather than an
 * import. The third mirror is agent-hub …/Builder/flow/settings/columnMatch.js.
 * Change one, change all three.
 *
 * Every error is { error, _fixHint } with the hint starting "Reject reason:"
 * — builderTools.js stamps a generic "invalid input binding" hint on an error
 * that lacks one and mentions binding/ref/path/kind, which would send the
 * model to fix a binding that was fine.
 */

const { DATATABLE_OPS, PENDING_DATATABLE_RE } = require('../validate/constants');
const { KEY_RE, SYSTEM_COLUMNS } = require('../../core/dataEngine/dataModel/vocabulary');

const isPlainObject = (v) => !!v && typeof v === 'object' && !Array.isArray(v);
const BINDING_KINDS = new Set(['ref', 'literal', 'template', 'expr']);
const isBinding = (v) => isPlainObject(v) && typeof v.kind === 'string' && BINDING_KINDS.has(v.kind);

/**
 * A title or key as a matching key: lower-case, diacritics stripped, every
 * character that is not a letter or digit dropped. "Excl. btw", "excl_btw",
 * "EXCL BTW" and "Excl.btw" all become "exclbtw"; "Facturen 2024" and
 * "facturen_2024" meet at "facturen2024". Only spelling differences fold —
 * "amount_total" does NOT become "Totaal". Mirrors
 * integrations/nextcloudTablesTools.js normaliseColumnKey and
 * agent-hub flow/settings/columnMatch.js exactly.
 */
function normaliseKey(s) {
    return String(s ?? '')
        .normalize('NFD')
        .replace(/[\u0300-\u036f]/g, '')
        .toLowerCase()
        .replace(/[^a-z0-9]/g, '');
}

/**
 * What the model calls an op → the op it meant. Read, never stored: the note
 * tells the model the exact name so the next call carries it. `set` is here
 * because a datatable step has no `set` field of its own, so as an op it can
 * only mean update.
 */
const DATATABLE_OP_ALIASES = Object.freeze({
    append: 'add_row', add: 'add_row', insert: 'add_row', create: 'add_row', create_row: 'add_row',
    add_rows: 'add_row', insert_row: 'add_row', insert_rows: 'add_row', append_row: 'add_row',
    append_rows: 'add_row', write: 'add_row', write_row: 'add_row',
    upsert: 'save_row', save: 'save_row', add_or_update: 'save_row', update_or_insert: 'save_row',
    merge: 'save_row', insert_or_update: 'save_row',
    list: 'find_rows', read: 'find_rows', query: 'find_rows', select: 'find_rows', get: 'find_rows',
    find: 'find_rows', search: 'find_rows', lookup: 'find_rows', read_rows: 'find_rows',
    get_rows: 'find_rows', list_rows: 'find_rows', find_row: 'find_rows', fetch: 'find_rows',
    count: 'count_rows',
    update: 'update_rows', edit: 'update_rows', modify: 'update_rows', set: 'update_rows',
    update_row: 'update_rows', patch: 'update_rows',
    delete: 'delete_rows', remove: 'delete_rows', delete_row: 'delete_rows', remove_row: 'delete_rows',
    remove_rows: 'delete_rows', erase: 'delete_rows',
});

const OP_LIST = Array.from(DATATABLE_OPS).join(', ');
const OP_ALIAS_SUMMARY = 'append/insert → add_row, upsert → save_row, list/query → find_rows, count → count_rows, edit → update_rows, remove → delete_rows';

/**
 * @param {*} raw  what the model sent as `op`
 * @param {{hasValues?: boolean}} opts  whether the step carries a column map —
 *   an absent op on a step WITH values is a write whose kind we cannot guess
 *   (insert vs upsert vs update differ in what they do to existing rows), an
 *   absent op WITHOUT values can only be the one op that changes nothing.
 * @returns {{op: string, note?: string} | {error: string, _fixHint: string}}
 */
function resolveDatatableOp(raw, { hasValues = false } = {}) {
    const text = raw == null ? '' : String(raw).trim();
    if (!text) {
        if (hasValues) {
            return {
                error: 'op is required — this step carries values, so it is a write: add_row (always insert), save_row (update the row matching matchColumn, else insert) or update_rows (needs where). Set op and resend the same step.',
                _fixHint: 'Reject reason: op missing on a datatable write. Add op and resend — nothing else was checked yet.',
            };
        }
        return { op: 'find_rows', note: 'op was not set — read as find_rows (the only op that changes nothing). Set op explicitly.' };
    }
    const norm = text.toLowerCase().replace(/[\s-]+/g, '_');
    if (DATATABLE_OPS.has(norm)) {
        // "Find Rows" / "find-rows" is the canonical op mis-spelled, not an
        // alias — still said, because nothing here is changed silently.
        return norm === text ? { op: norm } : { op: norm, note: `op "${text}" read as "${norm}" — use the exact name next time.` };
    }
    const alias = Object.hasOwn(DATATABLE_OP_ALIASES, norm) ? DATATABLE_OP_ALIASES[norm] : null;
    if (alias) return { op: alias, note: `op "${text}" read as "${alias}" — use the exact name next time.` };
    return {
        error: `op "${text}" is not a datatable operation. Use one of: ${OP_LIST} (${OP_ALIAS_SUMMARY}).`,
        _fixHint: 'Reject reason: unknown datatable op. Change op to one of the listed names and resend the same step — nothing else was checked yet.',
    };
}

// Where the model puts a column map when it does not say `values`, in the
// order they were seen. None of these is a field of the datatable step (its
// own keys are op, where, values, matchColumn, sort, limit, label, forEach,
// datatableId, datatableKey), so consuming them loses nothing.
const VALUES_ALIASES = ['fields', 'row', 'data', 'record', 'columns', 'cells', 'set'];
// Where the model puts the table when it does not say `datatableId`. `name`
// is safe here: a step's display name is `label`.
const TABLE_ALIASES = ['tableId', 'table', 'datatable', 'tableName', 'datatableName', 'name'];

/**
 * Rewrite a datatable step's foreign keys into the step's own vocabulary.
 * Returns a NEW args object — every consumed alias is deleted from it, so a
 * foreign key never reaches the stored definition.
 *
 * @returns {{args: object, notes: string[]} | {error: string, _fixHint: string}}
 */
function translateDatatableVocabulary(args) {
    if (!isPlainObject(args)) return { args, notes: [] };
    const out = { ...args };
    const notes = [];

    for (const alias of VALUES_ALIASES) {
        if (!Object.hasOwn(out, alias)) continue;
        if (out.values == null) {
            // Only a plain object can be a column map; anything else stays
            // where it is for the validator to name.
            if (!isPlainObject(out[alias])) continue;
            out.values = out[alias];
            delete out[alias];
            notes.push(`"${alias}" read as values — a datatable write puts its column→value map in values.`);
        } else {
            delete out[alias];
            notes.push(`"${alias}" was sent beside values — ignored; values is the column map.`);
        }
    }

    if (out.datatableId == null || out.datatableId === '') {
        for (const alias of TABLE_ALIASES) {
            if (!Object.hasOwn(out, alias)) continue;
            const v = out[alias];
            if (typeof v !== 'string' && !isBinding(v) && !(isPlainObject(v) && typeof v.id === 'string')) continue;
            out.datatableId = v;
            delete out[alias];
            notes.push(`"${alias}" read as datatableId.`);
            break;
        }
    }

    for (const field of ['datatableId', 'datatableKey']) {
        const v = out[field];
        if (!isPlainObject(v)) continue;
        if (isBinding(v)) {
            if (v.kind !== 'literal') {
                return {
                    error: field === 'datatableId'
                        ? 'datatableId must name ONE existing table (an id from the "Datatables you may use" block); it cannot be a ref or template — an automation cannot pick its table at run time.'
                        : 'datatableKey must be the table\'s key string (copied from the "Datatables you may use" block); it cannot be a ref or template — an automation cannot pick its table at run time.',
                    _fixHint: `Reject reason: ${field} is a binding. Replace it with the table ${field === 'datatableId' ? 'id' : 'key'} string and resend the same step.`,
                };
            }
            out[field] = String(v.value ?? '');
            notes.push(`${field} was sent as a binding object — the table is chosen when the automation is built, not at run time; read as "${out[field]}".`);
        } else if (typeof v.id === 'string') {
            // The catalog row echoed back whole ({id, key, name, …}).
            out[field] = v.id;
            notes.push(`${field} was sent as a catalog row — read as its id "${v.id}".`);
        } else {
            return {
                error: `${field} must be a string (the table's ${field === 'datatableId' ? 'id' : 'key'} from the "Datatables you may use" block), not an object.`,
                _fixHint: `Reject reason: ${field} is an object. Replace it with the table ${field === 'datatableId' ? 'id' : 'key'} string and resend the same step.`,
            };
        }
    }

    if (out.datatableKey != null && out.datatableKey !== '') {
        const k = out.datatableKey;
        if (typeof k !== 'string' || !KEY_RE.test(k)) {
            // Advisory field (see validate/stepRules.js datatable.key_invalid):
            // a wrong key can only mis-link an import, so a title sent here is
            // dropped rather than refused — the id still names the table.
            delete out.datatableKey;
            notes.push(`datatableKey "${String(k)}" is not a table key (lowercase letters, digits, underscores) — dropped; copy the key from the Datatables block.`);
        }
    }

    return { args: out, notes };
}

const TABLE_LIST_CAP = 20;
const describeTable = (t) => `${t.id} (${t.key}, "${t.name}")${t.pending ? ' — NEW, created on Apply' : ''}`;
function listTables(datatables) {
    const shown = datatables.slice(0, TABLE_LIST_CAP).map(describeTable);
    const rest = datatables.length - shown.length;
    return shown.join(', ') + (rest > 0 ? `, …and ${rest} more` : '');
}

/** exact id → exact key → normalised name/key. `how` says which rung hit. */
function lookupTable(term, datatables) {
    const s = String(term);
    let hits = datatables.filter(t => t && t.id === s);
    if (hits.length) return { hits, how: 'id' };
    hits = datatables.filter(t => t && t.key === s);
    if (hits.length) return { hits, how: 'key' };
    const norm = normaliseKey(s);
    if (!norm) return { hits: [], how: 'none' };
    hits = datatables.filter(t => t && (normaliseKey(t.name) === norm || normaliseKey(t.key) === norm));
    return { hits, how: 'name' };
}

/**
 * Which catalog table a step means. The catalog is the "Datatables you may
 * use" block: [{id, key, name, canWrite, managedKind, columns:[{key,name,type,unique}]}].
 * The caller writes `table.id` / `table.key` back onto the step — this only
 * decides, and the "replaced by" notes describe what the caller will do.
 *
 * @returns {{table: object, notes: string[]} | {table: null, notes: []} | {error: string, _fixHint: string}}
 *   `table: null` only when no catalog was given at all (nothing to check
 *   against — permissive, the validator still demands an id).
 */
function resolveDatatableRef({ id, key, datatables } = {}) {
    const asText = (v) => (v == null ? '' : String(v).trim());
    const idText = asText(id);
    const keyText = asText(key);
    // A "pending:<n>" id exists only inside the proposal that staged it (its
    // row is in the catalog then). Anywhere else it is a forged or stale id,
    // and "no catalog to check against" must not let it through: it would be
    // stored and fail at Apply or at run time.
    if (PENDING_DATATABLE_RE.test(idText) && !(Array.isArray(datatables) && datatables.some(t => t && t.id === idText))) {
        return {
            error: `"${idText}" is not a table: pending ids exist only inside the proposal that staged them. Use the id builder_create_datatable returned in THIS proposal.`,
            _fixHint: 'Reject reason: unknown pending table id. Call builder_create_datatable for the table (it returns the id to use), or ask the user which existing table to use. Never type a pending id yourself.',
            _rejectedPath: 'datatableId',
        };
    }
    if (!Array.isArray(datatables)) return { table: null, notes: [] };
    if (datatables.length === 0) {
        return {
            error: 'This user has no datatables, so a datatable step cannot be built. If the flow needs a table, create it with builder_create_datatable (in a preview it is staged and created when the user applies), or tell the user to create it first (Studio → Datatables). Never invent an id.',
            _fixHint: 'Reject reason: no datatable exists. Do not retry this step as it is: create the table with builder_create_datatable({name, fields}) and bind the step to the id it returns, or tell the user which table to create and stop. Never invent an id.',
        };
    }
    const notes = [];

    // `_rejectedPath` names the spec field whose VALUE caused the refusal, so
    // the resend suggestion drops it instead of handing the same invented id
    // back. Measured 2026-09-16: a step naming "tbl_fact01" was refused and
    // `resendAs` echoed the step verbatim — the same id, the same refusal.
    const ambiguous = (term, hits, field) => ({
        error: `"${term}" matches ${hits.length} datatables: ${hits.map(describeTable).join(', ')}. Use the exact id of the one you mean.`,
        _fixHint: 'Reject reason: ambiguous table name. Put the exact id in datatableId and resend the same step.',
        _rejectedPath: field,
    });
    const unknown = (term, field) => ({
        error: `There is no datatable "${term}" available to this user. Existing tables: ${listTables(datatables)}. Use one of these ids, or tell the user the table must be created first — never invent one.`,
        // Several tables with near-identical names is the normal case for an
        // owner who has built a few apps; picking one at random is worse than
        // asking, and picking a made-up id is worse than both.
        _fixHint: `Reject reason: unknown datatable. Use an id from the list and resend the same step. If the brief did not name WHICH table${datatables.length > 1 ? ` (there are ${datatables.length} to choose from)` : ''}, ask the user which one instead of guessing — or, if it does not exist yet, stop and tell the user to create it.`,
        _rejectedPath: field,
    });

    let table = null;
    if (idText) {
        const r = lookupTable(idText, datatables);
        if (r.hits.length > 1) return ambiguous(idText, r.hits, 'datatableId');
        if (r.hits.length === 1) {
            table = r.hits[0];
            if (r.how !== 'id') notes.push(`datatableId "${idText}" resolved to ${table.id} (key ${table.key}, "${table.name}") by its ${r.how} — use the id from the Datatables block next time.`);
        } else if (keyText) {
            // An exported automation carries the key and a blanked (or foreign)
            // id — the key is what re-links it.
            const rk = lookupTable(keyText, datatables);
            if (rk.hits.length > 1) return ambiguous(keyText, rk.hits, 'datatableKey');
            if (rk.hits.length === 0) return unknown(idText, 'datatableId');
            table = rk.hits[0];
            notes.push(`datatableId "${idText}" is not a table here; datatableKey "${keyText}" resolved it to ${table.id}.`);
            return { table, notes };
        } else {
            return unknown(idText, 'datatableId');
        }
    } else if (keyText) {
        const rk = lookupTable(keyText, datatables);
        if (rk.hits.length > 1) return ambiguous(keyText, rk.hits, 'datatableKey');
        if (rk.hits.length === 0) return unknown(keyText, 'datatableKey');
        table = rk.hits[0];
        notes.push(`datatableId was not set — datatableKey "${keyText}" resolved it to ${table.id}${rk.how === 'key' ? '' : ` (key ${table.key}, "${table.name}") by its ${rk.how}`}. Use the id from the Datatables block next time.`);
        return { table, notes };
    } else {
        return {
            error: `datatableId is required — name ONE existing table by its id. Existing tables: ${listTables(datatables)}. Use one of these ids, or tell the user the table must be created first — never invent one.`,
            _fixHint: 'Reject reason: datatableId missing. Put the id of the table you mean in datatableId and resend the same step.',
        };
    }

    // The id decided; a key that disagrees is corrected to the id's key rather
    // than trusted — the id is what runs, the key only re-links an import.
    if (keyText && keyText !== table.key) {
        const rk = lookupTable(keyText, datatables);
        notes.push(rk.hits.length && !rk.hits.includes(table)
            ? `datatableKey "${keyText}" names another table than datatableId — replaced by "${table.key}".`
            : `datatableKey "${keyText}" is not the key of ${table.id} — replaced by "${table.key}".`);
    }
    return { table, notes };
}

const COLUMN_LIST_CAP = 30;
const describeColumn = (c) => (c.system ? c.key : `${c.key} ("${c.name}")`);
function listColumns(cols) {
    if (!cols.length) return '(none)';
    const shown = cols.slice(0, COLUMN_LIST_CAP).map(describeColumn);
    const rest = cols.length - shown.length;
    return shown.join(', ') + (rest > 0 ? `, …and ${rest} more` : '');
}
const countWord = (n) => (n === 2 ? 'two' : n === 3 ? 'three' : String(n));

/**
 * Index a table's columns for matching. Normalised forms are usable only where
 * UNIQUE: two columns that collapse to one key ("Btw" and "BTW.") are
 * ambiguous, and a guess there would write the value into the wrong column
 * silently — the same guard integrations/nextcloudTablesTools.js resolveValues
 * keeps. A column's own key and name meeting at one form is not a collision.
 */
function indexColumns(columns, { allowSystem = false } = {}) {
    const cols = (Array.isArray(columns) ? columns : []).filter(c => c && typeof c.key === 'string');
    const all = allowSystem
        ? cols.concat(SYSTEM_COLUMNS.filter(k => !cols.some(c => c.key === k)).map(k => ({ key: k, name: k, system: true })))
        : cols;
    const byKey = new Map(all.map(c => [c.key, c]));
    const byNorm = new Map();
    const ambiguous = new Map();
    for (const c of all) {
        for (const n of new Set([normaliseKey(c.key), normaliseKey(c.name)])) {
            if (!n) continue;
            const prev = byNorm.get(n);
            if (prev && prev !== c) {
                const list = ambiguous.get(n) || [prev];
                if (!list.includes(c)) list.push(c);
                ambiguous.set(n, list);
                continue;
            }
            byNorm.set(n, c);
        }
    }
    return { all, byKey, byNorm, ambiguous };
}

function matchOne(term, idx) {
    const exact = idx.byKey.get(term);
    if (exact) return { col: exact, exact: true };
    const norm = normaliseKey(term);
    if (!norm) return null;
    if (idx.ambiguous.has(norm)) return { ambiguous: idx.ambiguous.get(norm) };
    const col = idx.byNorm.get(norm);
    return col ? { col, exact: false } : null;
}

const ambiguousColumnError = (what, term, cols, tableName) => ({
    error: `${what} key "${term}" matches ${countWord(cols.length)} columns of "${tableName}" (${cols.map(c => `"${c.name}"`).join(', ')}) — use the exact column key.`,
    _fixHint: 'Reject reason: ambiguous column key. Put the exact column key from the Datatables block in place of the name and resend the same step.',
});

/**
 * Re-key a column→value map (values) by the table's column keys.
 * Exact keys pass; a title or spelling variant is renamed (noted); anything
 * else is an error that names EVERY unknown key at once, so one round fixes
 * them all. Returns a new map in the original key order.
 *
 * @returns {{map: object, notes: string[]} | {error: string, _fixHint: string}}
 */
function mapColumnKeys(map, columns, { what = 'values', tableName = 'this table' } = {}) {
    if (!isPlainObject(map)) return { map, notes: [] };
    if (isBinding(map)) {
        // Without this the binding's own keys (kind, path) would be reported
        // as unknown columns — true, but pointing the model at the wrong fix.
        return {
            error: `${what} must be a plain column → value map; it cannot be one ${map.kind} binding for the whole row — bind each column's value instead (${what}: {email: "{{steps.x.output.email}}"}).`,
            _fixHint: `Reject reason: ${what} is a binding, not a column map. Send an object keyed by column key, one entry per column, and resend the same step.`,
        };
    }
    // No column catalog at all → nothing to check against; an empty one is a
    // table with no columns, and then every key is unknown.
    if (!Array.isArray(columns)) return { map, notes: [] };
    const idx = indexColumns(columns);
    const out = {};
    const notes = [];
    const unknown = [];
    const takenBy = new Map();
    for (const [k, v] of Object.entries(map)) {
        const m = matchOne(k, idx);
        if (!m) { unknown.push(k); continue; }
        if (m.ambiguous) return ambiguousColumnError(what, k, m.ambiguous, tableName);
        const col = m.col;
        if (takenBy.has(col.key)) {
            return {
                error: `keys "${takenBy.get(col.key)}" and "${k}" both map onto column "${col.key}" — send each column once.`,
                _fixHint: 'Reject reason: two keys for one column. Keep one entry per column and resend the same step.',
            };
        }
        takenBy.set(col.key, k);
        if (!m.exact) notes.push(`${what} key "${k}" mapped to column key "${col.key}"`);
        out[col.key] = v;
    }
    if (unknown.length) {
        const named = unknown.map(k => `"${k}"`).join(', ');
        return {
            error: `${what} names ${unknown.length === 1 ? 'a column' : 'columns'} ${named} that "${tableName}" does not have. Its columns are: ${listColumns(idx.all)}. Key ${what} by these column keys.`,
            _fixHint: 'Reject reason: unknown column key. Rename the key(s) named above to one of the listed column keys and resend the same step — the bindings were fine.',
        };
    }
    return { map: out, notes };
}

/**
 * One column named by a step field (matchColumn, where[i].field, sort[i].field).
 * `allowSystem` admits the system columns (id, created_at, …) — a where or
 * sort on created_at is ordinary, a write to it is not.
 *
 * @returns {{key: *, note?: string} | {error: string, _fixHint: string}}
 *   A non-string or blank name comes back untouched — presence and type are
 *   the validator's call, not this helper's.
 */
function mapColumnName(name, columns, { allowSystem = false, what = 'matchColumn', tableName = 'this table' } = {}) {
    if (typeof name !== 'string' || !name.trim()) return { key: name };
    if (!Array.isArray(columns)) return { key: name };
    const idx = indexColumns(columns, { allowSystem });
    const m = matchOne(name, idx);
    if (!m) {
        return {
            error: `${what} names a column "${name}" that "${tableName}" does not have. Its columns are: ${listColumns(idx.all)}. Use one of these column keys.`,
            _fixHint: `Reject reason: unknown column key in ${what}. Replace it with one of the listed column keys and resend the same step — the bindings were fine.`,
        };
    }
    if (m.ambiguous) return ambiguousColumnError(what, name, m.ambiguous, tableName);
    if (m.exact) return { key: m.col.key };
    return { key: m.col.key, note: `${what} "${name}" mapped to column key "${m.col.key}"` };
}

module.exports = {
    normaliseKey,
    lookupTable,
    DATATABLE_OP_ALIASES,
    resolveDatatableOp,
    translateDatatableVocabulary,
    resolveDatatableRef,
    mapColumnKeys,
    mapColumnName,
};
