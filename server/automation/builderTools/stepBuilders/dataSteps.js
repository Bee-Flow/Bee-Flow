/**
 * Builder tools — the steps that reshape data already in the run: set ("Edit
 * data") with its whole-table operations, the five list ops behind
 * builder_add_array_op, date arithmetic, a sandboxed code snippet, and the
 * parse_json row sanitizer the set step retired but still patches.
 */

const crypto = require('crypto');
const { newId, appendAfter } = require('../draftGraph');
const { validateAndFixBindings, sanitizeForEach, sanitizeArrayRef, checkLoopBindings } = require('../bindings');

// ── n8n-style utility step appliers ─────────────────────

// "Edit data" (set) whole-table operations. Mirrors validate.js/engine.js —
// the sanitizer keeps a patched step byte-identical to a freshly-added one
// and returns model-readable errors so the LLM self-corrects next turn.
const SET_OPS = new Set(['rowId', 'groupId', 'rename', 'keep', 'remove', 'sort']);
const SET_RESERVED_KEYS = new Set(['__proto__', 'constructor', 'prototype']);
const MAX_SET_OPERATIONS = 20;

function sanitizeSetOperations(raw) {
    if (!Array.isArray(raw)) return { error: 'operations must be an array of operation objects, e.g. [{ op: "rowId", target: "id" }].' };
    if (raw.length > MAX_SET_OPERATIONS) return { error: `operations: max ${MAX_SET_OPERATIONS} entries.` };
    const col = (v) => typeof v === 'string' && v.trim().length > 0;
    const colOk = (v, where, i) => {
        if (!col(v)) return `operations[${i}]: ${where} needs a non-empty column name.`;
        if (SET_RESERVED_KEYS.has(v)) return `operations[${i}]: column name "${v}" is reserved (__proto__/constructor/prototype).`;
        return null;
    };
    const keysOf = (v) => (Array.isArray(v) ? v.filter(col) : []);
    const operations = [];
    for (let i = 0; i < raw.length; i++) {
        const o = raw[i];
        if (!o || typeof o !== 'object' || Array.isArray(o)) return { error: `operations[${i}]: must be an object with an "op" field.` };
        if (!SET_OPS.has(o.op)) return { error: `operations[${i}]: unknown op "${o.op}". Use one of: ${Array.from(SET_OPS).join(', ')}.` };
        let err = null;
        if (o.op === 'rowId') {
            err = colOk(o.target, 'target', i);
            if (!err && o.start !== undefined && !Number.isInteger(o.start)) err = `operations[${i}]: rowId start must be a whole number.`;
            if (err) return { error: err };
            operations.push({ op: 'rowId', target: o.target, ...(Number.isInteger(o.start) && o.start !== 1 ? { start: o.start } : {}) });
        } else if (o.op === 'groupId') {
            err = colOk(o.target, 'target', i);
            const keys = keysOf(o.keys);
            if (!err && keys.length === 0) err = `operations[${i}]: groupId needs keys — the column name(s) rows must match on.`;
            if (!err) { const bad = keys.find(k => SET_RESERVED_KEYS.has(k)); if (bad) err = `operations[${i}]: column name "${bad}" is reserved.`; }
            if (err) return { error: err };
            operations.push({ op: 'groupId', target: o.target, keys });
        } else if (o.op === 'rename') {
            if (!col(o.from) || !col(o.to)) return { error: `operations[${i}]: rename needs both "from" and "to" column names.` };
            err = colOk(o.to, 'to', i);
            if (err) return { error: err };
            operations.push({ op: 'rename', from: o.from, to: o.to });
        } else if (o.op === 'keep' || o.op === 'remove') {
            const keys = keysOf(o.keys);
            if (keys.length === 0) return { error: `operations[${i}]: ${o.op} needs keys — the column name(s) to ${o.op}.` };
            operations.push({ op: o.op, keys });
        } else if (o.op === 'sort') {
            err = o.direction !== undefined && o.direction !== 'asc' && o.direction !== 'desc'
                ? `operations[${i}]: sort direction must be "asc" or "desc".`
                : (col(o.key) ? null : `operations[${i}]: sort needs "key" — the column to sort by.`);
            if (err) return { error: err };
            operations.push({ op: 'sort', key: o.key, ...(o.direction === 'desc' ? { direction: 'desc' } : {}) });
        }
    }
    return { operations };
}

function applyAddSet(draft, args, draftWrap) {
    const { inputs: fields, error, notes: bindNotes, _suggestedPatch: fieldPatch } = validateAndFixBindings(args.fields || {}, draft, { draftWrap });
    if (error) return { error, ...(fieldPatch ? { _suggestedPatch: { ops: fieldPatch.ops.map(o => ({ ...o, path: o.path.replace(/^inputs\./, 'fields.') })) } } : {}) };
    const { forEach, error: feErr, notes: feNotes } = sanitizeForEach(args.forEach, draft, draftWrap);
    if (feErr) return { error: feErr };
    const loopFields = checkLoopBindings(fields, draft, forEach, draftWrap, { label: 'fields' });
    if (loopFields.error) return { error: loopFields.error };
    const warnings = [...(bindNotes || []), ...(feNotes || [])].map(l => l.replace(/^inputs\./, 'fields.'));
    warnings.push(...loopFields.notes);
    // List mode: presence of arrayRef = "work through this list" (each row is
    // `item` in the field bindings; output becomes {items, count}).
    const listMode = typeof args.arrayRef === 'string';
    if (listMode && forEach) return { error: 'arrayRef (list mode) and forEach cannot be combined — list mode already applies the fields to every row. Drop forEach.' };
    let arrayRef = listMode ? args.arrayRef.trim() : undefined;
    if (listMode && arrayRef) {
        const ar = sanitizeArrayRef(arrayRef, draft, { draftWrap, strictRoot: true });
        if (ar.error) return { error: ar.error.replace(/^arrayRef: /, 'inputs.arrayRef: ') };
        arrayRef = ar.arrayRef;
        warnings.push(...ar.notes);
    }
    let operations;
    if (args.operations !== undefined) {
        if (!listMode) return { error: 'operations need arrayRef — table operations only apply when the step works through a list.' };
        const r = sanitizeSetOperations(args.operations);
        if (r.error) return { error: r.error };
        operations = r.operations;
    }
    const maxItems = (typeof args.maxItems === 'number' && Number.isInteger(args.maxItems) && args.maxItems > 0) ? args.maxItems : undefined;
    const step = {
        id: newId('set'), type: 'set', fields: loopFields.value, label: args.label || 'Edit data',
        ...(listMode ? { arrayRef } : {}),
        ...(operations && operations.length ? { operations } : {}),
        ...(listMode && maxItems ? { maxItems } : {}),
        ...(forEach ? { forEach } : {}),
    };
    appendAfter(draft, args.afterStepId, step, { branch: args.branch, caseName: args.caseName, splice: args.splice === true });
    return { added: step, ...(warnings.length ? { _warnings: warnings } : {}) };
}

// Lookahead bans prototype-plumbing names: `output[name] = v` on __proto__ etc.
// would hit the setter instead of creating a key (field silently vanishes).
const PARSE_JSON_FIELD_NAME_RE = /^(?!(?:__proto__|constructor|prototype)$)[A-Za-z_][A-Za-z0-9_]*$/;

/**
 * Sanitize a parse_json fields array to the exact row shape the runtime and
 * validator expect. parse_json is retired from AUTHORING, but
 * builder_update_step still patches fields on LEGACY steps through this.
 */
function sanitizeParseJsonFieldRows(raw) {
    if (!Array.isArray(raw) || raw.length === 0) {
        return { error: 'fields must be a non-empty array of { name, path?, description?, fallback? }.' };
    }
    if (raw.length > 50) return { error: 'fields: max 50 entries.' };
    const fields = [];
    const seen = new Set();
    for (let i = 0; i < raw.length; i++) {
        const f = raw[i];
        if (!f || typeof f !== 'object' || Array.isArray(f) || typeof f.name !== 'string' || !PARSE_JSON_FIELD_NAME_RE.test(f.name) || f.name.length > 64) {
            return { error: `fields[${i}]: each field needs an identifier-safe "name" (letters/digits/underscore, max 64 chars).` };
        }
        if (seen.has(f.name)) return { error: `fields[${i}]: duplicate field name "${f.name}".` };
        seen.add(f.name);
        fields.push({
            name: f.name,
            path: typeof f.path === 'string' ? f.path : '',
            ...(typeof f.description === 'string' && f.description.trim() ? { description: f.description.trim() } : {}),
            ...(f.fallback !== undefined ? { fallback: f.fallback } : {}),
        });
    }
    return { fields };
}

// parse_json is RETIRED from authoring (its ability moved into the set step:
// the parseJson() expression + list mode). The runtime, validator and
// update-path stay — existing automations keep opening and running — but no new
// parse_json step can be created, and the guidance error tells the model the
// replacement instead of a bare "unknown type".
const PARSE_JSON_RETIRED_MSG = 'parse_json can no longer be added — use a set (Edit data) step instead: read JSON text with an expr binding like {kind:"expr",value:"parseJson(steps.<id>.output.body, \\"order.total\\")"}, or point the set\'s arrayRef at the parsed list for one row per entry.';

function applyAddDateTime(draft, args) {
    const step = {
        id: newId('dt'),
        type: 'datetime',
        op: args.op,
        input: typeof args.input === 'string' ? args.input : undefined,
        input2: typeof args.input2 === 'string' ? args.input2 : undefined,
        amount: typeof args.amount === 'number' ? args.amount : undefined,
        format: typeof args.format === 'string' ? args.format : undefined,
        part: typeof args.part === 'string' ? args.part : undefined,
        unit: typeof args.unit === 'string' ? args.unit : undefined,
        // List mode (BFSF-375): with `arrayRef` set, the step works through a
        // table and writes its result into a new `target` column on every row.
        arrayRef: typeof args.arrayRef === 'string' ? args.arrayRef : undefined,
        target: typeof args.target === 'string' ? args.target : undefined,
        label: args.label || 'Date & time',
    };
    appendAfter(draft, args.afterStepId, step, { branch: args.branch, caseName: args.caseName, splice: args.splice === true });
    return { added: step };
}

/**
 * The `limits` block of a code step — the four numbers codeSandbox.clampLimits
 * honours, finally reachable by the author.
 *
 * They used to be hardcoded here (`{cpuMs: 1000, memoryMb: 64, wallMs: 5000}`,
 * no httpBudget at all) and everything the caller passed was dropped on the
 * floor, so the sandbox's careful clamp table was reachable by nobody: a step
 * that needed eight seconds of wall clock for a slow API could not ask for it,
 * and a step that only shuffles ten rows could not hand the rest back. A
 * ceiling nobody can move is not a permission model, it is a constant.
 *
 * THE CLAMP STAYS THE AUTHORITY. The bounds come from CODE_LIMIT_BOUNDS in
 * validate/stepRules/dataShapingRules.js — the same table the validator
 * refuses on, so a step built here and the same step arriving as JSON get the
 * same answer, and there is one place to change when the sandbox's table
 * changes. Out of range is an ERROR, not a silent clamp: a model that asks for
 * 512 MB and is quietly given 256 cannot learn that from a green run, and the
 * error text is the only teacher it gets (its code runs for the first time in
 * the user's dry run).
 *
 * The block is written out in FULL — all four keys, defaults included — even
 * when the caller names none. There is no UI for any of this (the whole
 * authoring surface for a code step is one textarea), so the stored step is
 * the only place a human can read what the step actually runs with; an absent
 * key would silently mean "whatever the sandbox happens to default to this
 * month". Writing them out is also what makes the patch path honest: the model
 * always SEES four keys, so re-stating all four is the obvious move.
 */
function sanitizeCodeLimits(raw) {
    // Required lazily so this module keeps loading without the validator being
    // pulled in first — the same inline-require idiom stepEditing.js uses for
    // slideVisualFields/deckLookFields. require() is cached, so this costs one
    // lookup per call.
    const { CODE_LIMIT_BOUNDS, describeCodeLimit, isCodeLimitKey } = require('../../validate/stepRules/dataShapingRules');
    const limits = {};
    for (const [key, b] of Object.entries(CODE_LIMIT_BOUNDS)) limits[key] = b.def;
    if (raw === undefined || raw === null) return { limits };
    if (typeof raw !== 'object' || Array.isArray(raw)) {
        return { error: `limits must be an object, e.g. { ${Object.keys(CODE_LIMIT_BOUNDS).map(k => `${k}: ${CODE_LIMIT_BOUNDS[k].def}`).join(', ')} }.` };
    }
    for (const [key, value] of Object.entries(raw)) {
        // isCodeLimitKey, not a truthy `CODE_LIMIT_BOUNDS[key]` — see its
        // comment: `{"constructor": 9999}` out of an imported definition finds
        // a bounds object on Object.prototype and is otherwise waved through
        // and written onto the step.
        const b = isCodeLimitKey(key) ? CODE_LIMIT_BOUNDS[key] : null;
        if (!b) return { error: `limits.${key} is not a limit the sandbox reads — it would be stored and ignored. Use one of: ${Object.keys(CODE_LIMIT_BOUNDS).join(', ')}.` };
        if (typeof value !== 'number' || !Number.isInteger(value)) return { error: `limits.${key} must be a whole number (got ${JSON.stringify(value)}). Allowed: ${describeCodeLimit(key)}.` };
        if (value < b.min || value > b.max) return { error: `limits.${key} is ${value} — the sandbox allows ${describeCodeLimit(key)} and clamps anything outside that, so a bigger number buys nothing and makes the step lie about what it runs with. Ask for ${value > b.max ? `${b.max} or less` : `${b.min} or more`}.` };
        limits[key] = value;
    }
    return { limits };
}

function applyAddCode(draft, args, draftWrap) {
    const { inputs, error, notes: bindNotes, _suggestedPatch } = validateAndFixBindings(args.inputs || {}, draft, { draftWrap });
    if (error) return { error, ...(_suggestedPatch ? { _suggestedPatch } : {}) };
    const { forEach, error: feErr, notes: feNotes } = sanitizeForEach(args.forEach, draft, draftWrap);
    if (feErr) return { error: feErr };
    const loopInputs = checkLoopBindings(inputs, draft, forEach, draftWrap);
    if (loopInputs.error) return { error: loopInputs.error };
    const warnings = [...(bindNotes || []), ...(feNotes || []), ...loopInputs.notes];
    const { limits, error: limErr } = sanitizeCodeLimits(args.limits);
    if (limErr) return { error: limErr };
    const step = {
        id: newId('code'),
        type: 'code',
        language: 'javascript',
        code: args.code,
        codeHash: crypto.createHash('sha256').update(args.code || '').digest('hex'),
        inputs: loopInputs.value,
        outputSchema: args.outputSchema || null,
        allowedTools: Array.isArray(args.allowedTools) ? args.allowedTools : [],
        limits,
        label: args.label || 'Code',
        ...(forEach ? { forEach } : {}),
    };
    appendAfter(draft, args.afterStepId, step, { branch: args.branch, caseName: args.caseName, splice: args.splice === true });
    return { added: step, ...(warnings.length ? { _warnings: warnings } : {}) };
}

/**
 * The list a filter/limit/dedupe/aggregate/summarize works through: its
 * arrayRef canonicalised and checked as a LIST (`steps.s.output` with one
 * list in it → that list; `results.subject` → `results[*].subject`). An
 * authoritative miss is refused; anything else rides back as a warning.
 */
function listStepArrayRef(draft, args, draftWrap) {
    return sanitizeArrayRef(args.arrayRef, draft, { draftWrap });
}
const withWarnings = (result, notes) => (notes && notes.length ? { ...result, _warnings: notes } : result);

function applyAddFilter(draft, args, draftWrap) {
    const ar = listStepArrayRef(draft, args, draftWrap);
    if (ar.error) return { error: ar.error };
    // The UI calls every deciding step (condition/switch/filter) "Condition";
    // an AI-added one must not be the odd node out on the canvas.
    const step = { id: newId('filt'), type: 'filter', arrayRef: ar.arrayRef, expr: args.expr, label: args.label || 'Condition' };
    appendAfter(draft, args.afterStepId, step, { branch: args.branch, caseName: args.caseName, splice: args.splice === true });
    return withWarnings({ added: step }, ar.notes);
}

function applyAddLimit(draft, args, draftWrap) {
    const ar = listStepArrayRef(draft, args, draftWrap);
    if (ar.error) return { error: ar.error };
    const step = {
        id: newId('lim'),
        type: 'limit',
        arrayRef: ar.arrayRef,
        count: Math.max(0, Math.floor(Number(args.count) || 0)),
        mode: args.mode === 'last' ? 'last' : 'first',
        label: args.label || 'Shorten list',
    };
    appendAfter(draft, args.afterStepId, step, { branch: args.branch, caseName: args.caseName, splice: args.splice === true });
    return withWarnings({ added: step }, ar.notes);
}

function applyAddDedupe(draft, args, draftWrap) {
    const ar = listStepArrayRef(draft, args, draftWrap);
    if (ar.error) return { error: ar.error };
    const step = { id: newId('ded'), type: 'dedupe', arrayRef: ar.arrayRef, keyField: typeof args.keyField === 'string' ? args.keyField : undefined, label: args.label || 'Remove duplicates' };
    appendAfter(draft, args.afterStepId, step, { branch: args.branch, caseName: args.caseName, splice: args.splice === true });
    return withWarnings({ added: step }, ar.notes);
}

function applyAddAggregate(draft, args, draftWrap) {
    const ar = listStepArrayRef(draft, args, draftWrap);
    if (ar.error) return { error: ar.error };
    const step = { id: newId('agg'), type: 'aggregate', arrayRef: ar.arrayRef, field: args.field, label: args.label || 'Collect one field' };
    appendAfter(draft, args.afterStepId, step, { branch: args.branch, caseName: args.caseName, splice: args.splice === true });
    return withWarnings({ added: step }, ar.notes);
}

function applyAddSummarize(draft, args, draftWrap) {
    const ar = listStepArrayRef(draft, args, draftWrap);
    if (ar.error) return { error: ar.error };
    const step = { id: newId('sum'), type: 'summarize', arrayRef: ar.arrayRef, field: args.field, op: args.op, label: args.label || 'Add up or count' };
    appendAfter(draft, args.afterStepId, step, { branch: args.branch, caseName: args.caseName, splice: args.splice === true });
    return withWarnings({ added: step }, ar.notes);
}

// Unified entry point for the five legacy array-op tools. Translates the
// flatter `builder_add_array_op` schema (op + a handful of optional fields)
// into the per-op apply* call. Lets the LLM use a single tool name across
// the array-handling cases — drops the tool-surface by 4 entries which
// matters on weaker models that get overwhelmed by big tool menus.
function applyAddArrayOp(draft, args, draftWrap) {
    const op = args && typeof args.op === 'string' ? args.op : null;
    if (!op) return { error: 'op is required (filter|limit|dedupe|aggregate|summarize)' };
    // `splice` travels too: the schema offers it, and a filter spliced
    // between a list and the step reading it is the W8 insert.
    const common = { afterStepId: args.afterStepId, arrayRef: args.arrayRef, label: args.label, branch: args.branch, caseName: args.caseName, splice: args.splice };
    switch (op) {
        case 'filter':
            if (typeof args.expr !== 'string') return { error: 'filter op requires expr (restricted JS, references item.<field>)' };
            return applyAddFilter(draft, { ...common, expr: args.expr }, draftWrap);
        case 'limit':
            if (args.count === undefined || args.count === null) return { error: 'limit op requires count (integer)' };
            return applyAddLimit(draft, { ...common, count: args.count, mode: args.mode }, draftWrap);
        case 'dedupe':
            return applyAddDedupe(draft, { ...common, keyField: args.keyField }, draftWrap);
        case 'aggregate':
            if (typeof args.field !== 'string') return { error: 'aggregate op requires field (the per-item field to pull)' };
            return applyAddAggregate(draft, { ...common, field: args.field }, draftWrap);
        case 'summarize':
            if (typeof args.field !== 'string') return { error: 'summarize op requires field (numeric per-item field)' };
            if (!args.fn) return { error: 'summarize op requires fn (sum|count|avg|min|max)' };
            return applyAddSummarize(draft, { ...common, field: args.field, op: args.fn }, draftWrap);
        default:
            return { error: `Unknown array op "${op}". Use one of: filter, limit, dedupe, aggregate, summarize.` };
    }
}

module.exports = {
    sanitizeSetOperations,
    applyAddSet,
    sanitizeParseJsonFieldRows,
    PARSE_JSON_RETIRED_MSG,
    applyAddDateTime,
    sanitizeCodeLimits,
    applyAddCode,
    applyAddFilter,
    applyAddLimit,
    applyAddDedupe,
    applyAddAggregate,
    applyAddSummarize,
    applyAddArrayOp,
};
