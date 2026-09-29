/**
 * Builder tools — builder_add_datatable: a read or a write against one of the
 * author's tables. Canonicalises the bindings a datatable carries outside
 * `inputs` (values, where[].value), reads `where` and `sort` in every shape
 * the model sends them, re-keys column titles against the catalog table, and
 * refuses a write to a table this user may only read.
 */

const { newId, appendAfter } = require('../draftGraph');
const { validateAndFixBindings, sanitizeForEach, unboundLoopVarError } = require('../bindings');
const { fieldsAtRef } = require('../outputFields');
const {
    normaliseKey, resolveDatatableOp, translateDatatableVocabulary, resolveDatatableRef,
    mapColumnKeys, mapColumnName,
} = require('../datatableRefs');
const { DATATABLE_MAX_FILTERS, DATATABLE_MAX_LIMIT } = require('../../validate/constants');

/**
 * Canonicalize a datatable step's bindings.
 *
 * A datatable carries them in `values` and `where[].value`, NOT in `inputs`, so
 * they missed the binding pass every other step gets and were stored verbatim:
 * the tool schema tells the model to write "{{steps.form.output.email}}" and
 * that string landed in the row as literal text, braces and all. Same
 * canonicaliser, same self-repair, same errors as an integration_action's
 * inputs — the error strings say `inputs.<key>` because that is the one label
 * validateAndFixBindings knows, so each half names itself first.
 *
 * `where` entries are REBUILT from field/op/value rather than passed through:
 * the runner reads exactly those three, and anything else the model invents
 * would persist looking configured while doing nothing.
 */
function sanitizeDatatableBindings(raw, draft) {
    const rawValues = (raw.values && typeof raw.values === 'object' && !Array.isArray(raw.values)) ? raw.values : {};
    const v = validateAndFixBindings(rawValues, draft);
    if (v.error) return { error: `datatable values — ${v.error}` };
    // The repair lines say `inputs.<key>` — the one label validateAndFixBindings
    // knows. They ride back to the model as _warnings, and a datatable step has
    // no inputs map: relabelled to the step's own field, or the model goes
    // looking for a map it never sent.
    const repairs = (v.repairs || []).map(r => r.replace(/^inputs\./, 'values.'));

    const where = [];
    const coercedWhere = coerceWhereList(raw.where);
    if (coercedWhere.note) repairs.push(coercedWhere.note);
    const rawWhere = coercedWhere.list.slice(0, DATATABLE_MAX_FILTERS);
    for (let i = 0; i < rawWhere.length; i++) {
        const w = rawWhere[i];
        if (!w || typeof w !== 'object' || Array.isArray(w)) continue;
        const entry = { field: typeof w.field === 'string' ? w.field : '', op: typeof w.op === 'string' ? w.op : '' };
        if (w.value !== undefined) {
            const b = validateAndFixBindings({ value: w.value }, draft);
            if (b.error) return { error: `datatable where[${i}] — ${b.error}` };
            entry.value = b.inputs.value;
            for (const r of (b.repairs || [])) repairs.push(r.replace(/^inputs\.value/, `where[${i}].value`));
        }
        where.push(entry);
    }
    return { values: v.inputs, where, repairs };
}

// The ops that change rows. The catalog row says whether THIS user may write
// the table (canWrite = editor grade or better, builderDatatableCatalog.js);
// a write on a table they can only read passes the builder and the validator
// and fails at run time, once, in a routine nobody is watching.
const DATATABLE_WRITE_OPS = new Set(['add_row', 'save_row', 'update_rows', 'delete_rows']);

function readOnlyTableError(table, op) {
    return {
        error: `"${table.name}" is read-only for this user, so ${op} would fail at run time. Use find_rows/count_rows, or tell the user they need editor access to the table.`,
        _fixHint: 'Reject reason: no write access to that table. Do not retry the write; use a read op or stop and tell the user.',
    };
}

/**
 * A datatable `where` as a LIST of {field, op, value}, from either shape the
 * model sends.
 *
 * The list is the stored form, but the column-keyed object — `{status: "open"}`
 * or `{status: {kind:"literal", value:"open"}}` — is what a model writes when
 * the brief says "where status equals open", and it is what the values map two
 * lines up actually takes. Anything not an array used to become `[]`: the
 * filter was dropped, no error was raised, and the step reported success with
 * no condition on it.
 *
 * Measured 2026-09-16 on a live "Facturen goedkeuren" build, twice: the model
 * sent the object form, saw `where: []` in the draft it got back, sent the
 * identical builder_replace_step to fix it — three rounds running, each
 * answered "replaced" — and separately looped four no-op builder_update_steps
 * for the same reason. A silently discarded field is unfixable from the other
 * side, because nothing it can do changes the outcome.
 *
 * So: translate it, and say so in the repairs the model reads back.
 * `{col: v}` means `{field: col, op: 'eq', value: v}`; an explicit
 * `{col: {op, value}}` keeps its operator.
 */
// The words a model reaches for instead of {field, op, value}. Measured
// 2026-09-16 on a live "AI Resume Screener" build: the filter arrived as
// `{column:"status", operator:"equals", value:"New"}` — one condition, not a
// column-keyed map — and the column-keyed reading turned its KEYS into column
// names, so the step was refused for a column called "column", three times in
// a row. Both spellings are unambiguous, so both are read.
const WHERE_FIELD_KEYS = ['field', 'column', 'columnkey', 'key', 'name'];
const WHERE_OP_KEYS = ['op', 'operator', 'comparator', 'comparison'];
const WHERE_VALUE_KEYS = ['value', 'values', 'val'];

/** "Greater_Than" / ">=" / "equals" → the stored operator, or null. */
const OP_SYNONYMS = Object.freeze({
    eq: 'eq', equals: 'eq', equal: 'eq', is: 'eq', '=': 'eq', '==': 'eq', '===': 'eq',
    neq: 'neq', notequals: 'neq', notequal: 'neq', isnot: 'neq', '!=': 'neq', '!==': 'neq', '<>': 'neq',
    gt: 'gt', greaterthan: 'gt', '>': 'gt',
    gte: 'gte', greaterthanorequal: 'gte', greaterthanorequalto: 'gte', atleast: 'gte', '>=': 'gte',
    lt: 'lt', lessthan: 'lt', '<': 'lt',
    lte: 'lte', lessthanorequal: 'lte', lessthanorequalto: 'lte', atmost: 'lte', '<=': 'lte',
    contains: 'contains', includes: 'contains', like: 'contains',
    notcontains: 'notContains', doesnotcontain: 'notContains',
    startswith: 'startsWith', beginswith: 'startsWith',
    endswith: 'endsWith',
    in: 'in', oneof: 'in', notin: 'notIn',
    between: 'between',
    isnull: 'isNull', isempty: 'isNull', isnotnull: 'isNotNull', isnotempty: 'isNotNull',
});

const squash = (k) => String(k || '').toLowerCase().replace(/[\s_-]+/g, '');
const pickKey = (obj, names) => Object.keys(obj).find(k => names.includes(squash(k)));

/** Read the stored operator out of whatever the model called it, or null. */
function canonicalOp(raw) {
    if (typeof raw !== 'string') return null;
    const t = raw.trim();
    return OP_SYNONYMS[squash(t)] || OP_SYNONYMS[t] || null;
}

/**
 * ONE condition out of an object that spells it differently, or null when the
 * object is not condition-shaped (then it is a column-keyed map, below).
 * A condition names its column: without that there is nothing to read.
 */
function conditionFrom(obj) {
    if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return null;
    const fieldKey = pickKey(obj, WHERE_FIELD_KEYS);
    if (!fieldKey || typeof obj[fieldKey] !== 'string' || !obj[fieldKey].trim()) return null;
    const opKey = pickKey(obj, WHERE_OP_KEYS);
    const valueKey = pickKey(obj, WHERE_VALUE_KEYS);
    const op = canonicalOp(opKey ? obj[opKey] : null);
    // No value is only legal for the two null tests; anything else with no
    // value and no operator is too thin to be a condition.
    const nullTest = op === 'isNull' || op === 'isNotNull';
    if (valueKey === undefined && !nullTest) return null;
    const out = { field: obj[fieldKey].trim(), op: op || 'eq' };
    if (valueKey !== undefined) out.value = obj[valueKey];
    const renamed = [];
    if (fieldKey !== 'field') renamed.push(`${fieldKey}→field`);
    if (opKey && opKey !== 'op') renamed.push(`${opKey}→op`);
    if (opKey && canonicalOp(obj[opKey]) && String(obj[opKey]) !== out.op) renamed.push(`"${obj[opKey]}"→"${out.op}"`);
    if (valueKey && valueKey !== 'value') renamed.push(`${valueKey}→value`);
    if (!opKey) renamed.push('no operator → eq');
    return { cond: out, renamed };
}

const SHAPE_NOTE = 'where is a LIST of {field, op, value} — send that shape next time.';

/**
 * `where` as the stored list. Three shapes are read:
 *   [{field, op, value}]                  — already right, untouched
 *   [{column, operator, value}]           — the same list, spelled otherwise
 *   {column, operator, value}             — ONE condition sent bare
 *   {status: "New", amount: {op, value}}  — a column-keyed map
 * Anything else is no filter at all.
 */
function coerceWhereList(rawWhere) {
    if (Array.isArray(rawWhere)) {
        const renamed = [];
        const list = rawWhere.map((el) => {
            if (!el || typeof el !== 'object' || Array.isArray(el)) return el;
            if (typeof el.field === 'string' && typeof el.op === 'string') return el;
            const c = conditionFrom(el);
            if (!c) return el;
            renamed.push(...c.renamed);
            return { ...el, ...c.cond };
        });
        return {
            list,
            note: renamed.length
                ? `where: read ${[...new Set(renamed)].join(', ')}. ${SHAPE_NOTE}`
                : null,
        };
    }
    if (!rawWhere || typeof rawWhere !== 'object') return { list: [], note: null };

    // One condition sent bare, before the column-keyed reading — otherwise its
    // own keys ("column", "operator", "value") are read as column names.
    const single = conditionFrom(rawWhere);
    if (single) {
        return {
            list: [single.cond],
            note: `where: read the object as ONE condition on "${single.cond.field}" `
                + `(${[...new Set(single.renamed)].join(', ') || 'as sent'}). ${SHAPE_NOTE}`,
        };
    }

    const list = [];
    for (const [field, v] of Object.entries(rawWhere)) {
        const isOpShape = v && typeof v === 'object' && !Array.isArray(v)
            && typeof v.op === 'string' && 'value' in v;
        list.push(isOpShape
            ? { field, op: v.op, value: v.value }
            : { field, op: 'eq', value: v });
    }
    if (!list.length) return { list, note: null };
    return {
        list,
        note: `where: read the column-keyed object as ${list.length} condition${list.length === 1 ? '' : 's'} `
            + `(${list.map(w => `${w.field} ${w.op}`).join(', ')}). ${SHAPE_NOTE}`,
    };
}

/**
 * `sort` as the stored list: `[{field, dir}]`. The same build wrote
 * `[{column:"ai_score", direction:"desc"}]` — which re-keyed to a column named
 * `undefined` and ordered nothing.
 */
const SORT_FIELD_KEYS = ['field', 'column', 'columnkey', 'key', 'name', 'by'];
const SORT_DIR_KEYS = ['dir', 'direction', 'order', 'sort', 'ordering'];
function coerceSortList(rawSort) {
    if (!Array.isArray(rawSort)) {
        // A lone object, or a bare column name, is what the one-entry list means.
        if (rawSort && typeof rawSort === 'object') return coerceSortList([rawSort]);
        if (typeof rawSort === 'string' && rawSort.trim()) {
            return { list: [{ field: rawSort.trim(), dir: 'asc' }], note: `sort: read "${rawSort.trim()}" as [{field, dir}]. sort is a LIST of {field, dir}.` };
        }
        return { list: rawSort, note: null };
    }
    const renamed = [];
    const list = rawSort.map((el) => {
        if (!el || typeof el !== 'object' || Array.isArray(el)) return el;
        if (typeof el.field === 'string' && (el.dir === undefined || typeof el.dir === 'string')) {
            if (typeof el.dir === 'string' && !/^(asc|desc)$/.test(el.dir)) {
                const d = /^desc/i.test(el.dir) ? 'desc' : 'asc';
                renamed.push(`"${el.dir}"→"${d}"`);
                return { ...el, dir: d };
            }
            return el;
        }
        const fieldKey = pickKey(el, SORT_FIELD_KEYS);
        if (!fieldKey || typeof el[fieldKey] !== 'string' || !el[fieldKey].trim()) return el;
        const dirKey = pickKey(el, SORT_DIR_KEYS);
        const rawDir = dirKey ? el[dirKey] : null;
        const dir = typeof rawDir === 'string' && /^desc/i.test(rawDir.trim()) ? 'desc' : 'asc';
        if (fieldKey !== 'field') renamed.push(`${fieldKey}→field`);
        if (dirKey && dirKey !== 'dir') renamed.push(`${dirKey}→dir`);
        if (typeof rawDir === 'string' && rawDir !== dir) renamed.push(`"${rawDir}"→"${dir}"`);
        const out = { ...el, field: el[fieldKey].trim(), dir };
        if (fieldKey !== 'field') delete out[fieldKey];
        if (dirKey && dirKey !== 'dir') delete out[dirKey];
        return out;
    });
    return {
        list,
        note: renamed.length ? `sort: read ${[...new Set(renamed)].join(', ')}. sort is a LIST of {field, dir}.` : null,
    };
}

/**
 * Re-key every column a datatable step names against ONE catalog table:
 * values keys, matchColumn (save_row's identity column — a write, so a system
 * column is refused), where[i].field and sort[i].field (reads — created_at is
 * ordinary there). Each piece is optional and comes back untouched when
 * undefined, so the patch path can hand over only what a patch touched.
 * Measured 2026-09: the model keyed values by the column TITLES the catalog
 * showed ("Excl. btw") and the row was written with six unknown columns;
 * a title that fits one column is renamed and said, one that fits two or
 * none is refused with the column list, by ./datatableRefs.
 *
 * @returns {{values, where, sort, matchColumn, notes: string[]} | {error, _fixHint}}
 */
function resolveDatatableColumns({ op, values, where, sort, matchColumn }, table) {
    const notes = [];
    const tableName = table.name;
    const cols = table.columns;
    const v = mapColumnKeys(values, cols, { tableName });
    if (v.error) return v;
    notes.push(...v.notes);
    let mc = matchColumn;
    if (op === 'save_row' && typeof matchColumn === 'string' && matchColumn) {
        const m = mapColumnName(matchColumn, cols, { allowSystem: false, what: 'matchColumn', tableName });
        if (m.error) return m;
        if (m.note) notes.push(m.note);
        mc = m.key;
    }
    let outWhere = where;
    if (Array.isArray(where)) {
        outWhere = [];
        for (let i = 0; i < where.length; i++) {
            const w = where[i];
            if (!w || typeof w !== 'object' || Array.isArray(w)) { outWhere.push(w); continue; }
            const m = mapColumnName(w.field, cols, { allowSystem: true, what: `where[${i}].field`, tableName });
            if (m.error) return m;
            if (m.note) notes.push(m.note);
            outWhere.push(m.key === w.field ? w : { ...w, field: m.key });
        }
    }
    let outSort = sort;
    if (Array.isArray(sort)) {
        outSort = [];
        for (let i = 0; i < sort.length; i++) {
            const s = sort[i];
            if (!s || typeof s !== 'object' || Array.isArray(s)) { outSort.push(s); continue; }
            const m = mapColumnName(s.field, cols, { allowSystem: true, what: `sort[${i}].field`, tableName });
            if (m.error) return m;
            if (m.note) notes.push(m.note);
            outSort.push(m.key === s.field ? s : { ...s, field: m.key });
        }
    }
    return { values: v.map, where: outWhere, sort: outSort, matchColumn: mc, notes };
}

const EXTRACTION_FIELDS_LISTED = 20;
function listDeclaredFields(names) {
    return names.length > EXTRACTION_FIELDS_LISTED
        ? `${names.slice(0, EXTRACTION_FIELDS_LISTED).join(', ')}, …`
        : names.join(', ');
}

/**
 * A values binding that reads `loop.<v>.output.<f>` over a data_extraction
 * fan-out must name a field the extraction DECLARES: the fields ARE its whole
 * output shape, so any other name is empty in every row at run time — and
 * nothing before this said so. The step's own itemVar only; a foreign var is
 * unboundLoopVarError's business. A spelling that fits exactly one declared
 * field (BTW → btw) is corrected and said; anything else is refused with the
 * declared list, so one round fixes it. Unknown shapes (no fan-out, an
 * extraction without fields, an opaque upstream) pass untouched — "unknown"
 * must never read as "nothing".
 *
 * @returns {{values: object, notes: string[]} | {error: string, _fixHint: string}}
 */
function checkExtractionFieldRefs(draft, values, forEach, draftWrap) {
    const notes = [];
    if (!values || typeof values !== 'object' || Array.isArray(values)) return { values, notes };
    if (!forEach || typeof forEach.overRef !== 'string' || typeof forEach.itemVar !== 'string') return { values, notes };
    const res = fieldsAtRef(draft, forEach.overRef, draftWrap);
    if (res.source !== 'fanout' || res.upstream?.type !== 'data_extraction' || !Array.isArray(res.outputFields)) {
        return { values, notes };
    }
    const declared = res.outputFields;
    const prefix = `loop.${forEach.itemVar}.output.`;
    const out = {};
    for (const [k, b] of Object.entries(values)) {
        const isRef = !!b && typeof b === 'object' && !Array.isArray(b) && b.kind === 'ref' && typeof b.path === 'string';
        if (!isRef || !b.path.startsWith(prefix)) { out[k] = b; continue; }
        const [f, ...deeper] = b.path.slice(prefix.length).split('.');
        if (!f || declared.includes(f)) { out[k] = b; continue; }
        const norm = normaliseKey(f);
        const hits = norm ? declared.filter(d => normaliseKey(d) === norm) : [];
        if (hits.length === 1) {
            out[k] = { ...b, path: `${prefix}${[hits[0], ...deeper].join('.')}` };
            notes.push(`values.${k} read ${b.path} — the extraction declares "${hits[0]}"; path corrected.`);
            continue;
        }
        return {
            error: `values.${k} reads ${b.path}, but the extraction step ${res.upstream.stepId} declares only: ${listDeclaredFields(declared)}. Bind to one of those, or add the field to the extraction.`,
            _fixHint: 'Reject reason: a values binding names a field the extraction does not produce. Fix the path (or the extraction fields) and resend the same step.',
        };
    }
    return { values: out, notes };
}

/**
 * A datatable read or write.
 *
 * `label` is written as `args.label || 'Datatable'` in ONE object literal
 * alongside `type: 'datatable'` — flow/nodeDefs.serverLabels.test.js scans this
 * file with a regex over exactly that shape and requires the literal to equal
 * NODE_DEFS.datatable.defaultLabel. Everything this builder does BEFORE that
 * literal is ordinary semicolon-terminated code for the same reason: the scan
 * pairs a `type:` with the first `label: args.label ||` it can reach without
 * crossing a semicolon.
 *
 * What the model sends and what the step stores differ in five measured ways
 * (see ./datatableRefs): the op spelled as an alias, the column map under
 * `fields`, the table under `tableId` / as a binding / by its NAME, the value
 * keys as column TITLES, and a loop field the extraction never declared. Each
 * cost a rejected round, and every tolerant read below is written into
 * `_warnings` — nothing is coerced silently. An absent op is find_rows ONLY on
 * a step without values: the one op that changes nothing. With values it is a
 * write whose kind cannot be guessed, and it is refused.
 *
 * TWO addressing fields, and they are not equals. `datatableId` is
 * AUTHORITATIVE: it is the only thing execDatatable resolves, inside the
 * routine's own scopes, so a wrong id fails closed. `datatableKey` is
 * ADVISORY — the table's own slug, carried so that an export (which must blank
 * the id: it names a table in one organisation) still says which table it
 * wanted, and portability.rebindDatatables can re-link it on import. Nothing at
 * run time reads it. With a catalog (draftWrap._datatables, the "Datatables you
 * may use" block) BOTH are written from the resolved table; without one
 * (null: the store could not tell) the strings are kept as sent, as before.
 */
function applyAddDatatable(draft, rawArgs, draftWrap) {
    const tr = translateDatatableVocabulary(rawArgs || {});
    if (tr.error) return tr;
    const { args, notes } = tr;
    // One binding for the WHOLE row canonicalises into nonsense (its `kind`
    // becomes a literal "ref") before any column check could name it — so it
    // is refused on the raw shape, catalog or not.
    const wholeRow = mapColumnKeys(args.values, null);
    if (wholeRow.error) return wholeRow;
    const hasValues = !!args.values && typeof args.values === 'object' && !Array.isArray(args.values) && Object.keys(args.values).length > 0;
    const opR = resolveDatatableOp(args.op, { hasValues });
    if (opR.error) return opR;
    if (opR.note) notes.push(opR.note);
    const op = opR.op;
    const bound = sanitizeDatatableBindings(args, draft);
    if (bound.error) return { error: bound.error };
    notes.push(...bound.repairs);
    // forEach was silently DROPPED here until 2026-09-04 — the schema
    // advertised it, the validator forbade it, and this builder never copied
    // it onto the step, so a "save one row per accepted item" write ran once
    // with loop.<item> undefined. Same sanitiser as every other step type.
    const { forEach, error: feErr } = sanitizeForEach(args.forEach, draft);
    if (feErr) return { error: feErr };
    const loopErr = unboundLoopVarError({ values: bound.values, where: bound.where }, forEach, { what: 'values' });
    if (loopErr) return loopErr;
    const ref = resolveDatatableRef({ id: args.datatableId, key: args.datatableKey, datatables: draftWrap?._datatables });
    if (ref.error) return ref;
    notes.push(...ref.notes);
    let values = bound.values;
    let where = bound.where;
    const coercedSort = coerceSortList(args.sort);
    if (coercedSort.note) notes.push(coercedSort.note);
    let sort = coercedSort.list;
    let matchColumn = args.matchColumn;
    let datatableId = typeof args.datatableId === 'string' ? args.datatableId : '';
    let datatableKey = typeof args.datatableKey === 'string' ? args.datatableKey.trim() : '';
    if (ref.table) {
        if (DATATABLE_WRITE_OPS.has(op) && !ref.table.canWrite) return readOnlyTableError(ref.table, op);
        const cols = resolveDatatableColumns({ op, values, where, sort, matchColumn }, ref.table);
        if (cols.error) return cols;
        ({ values, where, sort, matchColumn } = cols);
        notes.push(...cols.notes);
        datatableId = ref.table.id;
        datatableKey = ref.table.key;
    }
    if (forEach) {
        const ex = checkExtractionFieldRefs(draft, values, forEach, draftWrap);
        if (ex.error) return ex;
        values = ex.values;
        notes.push(...ex.notes);
    }
    const step = {
        id: newId('dt'),
        type: 'datatable',
        label: args.label || 'Datatable',
        ...(forEach ? { forEach } : {}),
        op,
        datatableId,
        datatableKey,
        where,
        values,
    };
    if (matchColumn) step.matchColumn = String(matchColumn);
    // 'all' is the default and stays IMPLICIT — writing it onto every step
    // would make an existing definition differ from a freshly-built one for no
    // behavioural reason.
    if (args.match === 'any') step.match = 'any';
    if (args.limit !== undefined) {
        const n = Number(args.limit);
        if (Number.isFinite(n)) step.limit = Math.max(1, Math.min(DATATABLE_MAX_LIMIT, Math.round(n)));
    }
    // Only sort[0] is honoured by compileRecordList, so a longer list is kept
    // as given and the validator warns rather than silently trimming it — the
    // author has to see which column actually orders the rows.
    if (Array.isArray(sort)) step.sort = sort;
    if (typeof args.cursor === 'string' && args.cursor) step.cursor = args.cursor;
    appendAfter(draft, args.afterStepId, step, { branch: args.branch, caseName: args.caseName, splice: args.splice === true });
    return { added: step, ...(notes.length ? { _warnings: notes } : {}) };
}

module.exports = {
    sanitizeDatatableBindings,
    DATATABLE_WRITE_OPS,
    readOnlyTableError,
    coerceSortList,
    resolveDatatableColumns,
    checkExtractionFieldRefs,
    applyAddDatatable,
};
