/**
 * Builder tools — which fields a ref path yields, so a `loop.<var>.<field>`
 * binding can be checked (and repaired) at add time instead of at run time.
 *
 * WHY. Measured 2026-09-12: a step iterating `steps.a_2.output.results` (a
 * nextcloud_read_file with a forEach) bound `loop.r.content`. The builder
 * accepted it, the validator passed it, and at run time every cell was empty —
 * an entry of a fan-out's `results` is {index, item, output, status}, so the
 * text sat at `loop.r.output.content`. The model could not have known: nothing
 * told it what an entry looks like. This module is that knowledge, in one
 * place, with the provenance of each answer so a hint can say how sure it is.
 *
 * Three sources, in order of trust:
 *   runtime  — a shapeCache descriptor the route attached as
 *              draftWrap._runtimeShapes[tool] (what the tool ACTUALLY returned
 *              for this user; objects are key maps, arrays are
 *              { _array: itemDescriptor, _length })
 *   curated  — outputSchemas.js `shape` (hand-verified against the executors)
 *   sample   — outputSchemas.js `sample` (the dry-run placeholder)
 * Unknown is always `fields: null` — never an empty list. A caller that turns
 * "unknown" into "no fields" would reject every binding on a tool nobody has
 * described yet, which is worse than the bug this module exists to catch.
 * A list's entry is the UNION of its entries' keys (a field only entry 2
 * carries is a field), and checkLoopRef walks the whole path, token by token,
 * over the deep shape refCheck.js knows — not just the first dotted name.
 *
 * Pure and synchronous: the per-type step builders are sync, and this runs
 * inside them. Required from within automation/builderTools/.
 */

const { OUTPUT_SCHEMAS } = require('../outputSchemas');
const { findStepAnywhere } = require('./draftGraph');
const triggerCatalog = require('./triggerCatalog');
const { formatPath, flattenShape } = require('../expr');
const { normalizeAiPath } = require('./aiPaths');
const { shapeAtRef, checkAgainst, describeProblem } = require('./refCheck');
const { itemOf } = require('./shapeTree');

const MAX_FIELDS_LISTED = 20;
// A forEach over a fan-out over a fan-out is the deepest shape a build has
// produced; beyond that a self-referencing overRef would recurse forever.
const MAX_REF_DEPTH = 3;

function isPlainObject(v) {
    return !!v && typeof v === 'object' && !Array.isArray(v);
}

// The tokens of a ref path, read the way bindings.js stores it (aiPaths.js:
// leading $, `steps[x]`, whitespace, debris), so a check is computed against
// the spelling that reaches the step. Brackets stay brackets.
function refTokens(path) {
    if (typeof path !== 'string') return null;
    return normalizeAiPath(path).tokens;
}

/** The keys of every object in a list (a union: entry 2's extra field is a field). */
function unionKeys(list) {
    if (!Array.isArray(list)) return null;
    const out = [];
    for (const el of list) {
        if (!isPlainObject(el)) continue;
        for (const k of Object.keys(el)) if (!out.includes(k)) out.push(k);
    }
    return out.length ? out : null;
}

// A runtime descriptor of JSON text is { _json: <what it encodes> } (shapeCache).
const unwrapJson = d => (isPlainObject(d) && Object.keys(d).length === 1 && '_json' in d ? d._json : d);

/**
 * The field names inside the first `{ … }` after "array of" in a curated
 * shape string. Parenthesised annotations are dropped BEFORE splitting on
 * commas — `type ("file"|"folder")` carries a `|` and quotes, and the
 * annotation of one field must not swallow the next. Nested braces (a member
 * described as `values: { a, b }`) are dropped for the same reason: their
 * members belong to the member, not to the item.
 *
 *   'array of { name, path, type ("file"|"folder"), size }' → [name, path, type, size]
 *   'array of string (labels after the change)'             → null (no brace)
 *   'array (same as calendar_list_events.results)'          → null (no "array of")
 */
function parseArrayItemFields(desc) {
    if (typeof desc !== 'string') return null;
    const at = desc.search(/array\s+of/i);
    if (at < 0) return null;
    const open = desc.indexOf('{', at);
    if (open < 0) return null;
    let depth = 0;
    let close = -1;
    for (let i = open; i < desc.length; i++) {
        if (desc[i] === '{') depth++;
        else if (desc[i] === '}' && --depth === 0) { close = i; break; }
    }
    const inner = desc.slice(open + 1, close < 0 ? desc.length : close)
        .replace(/\{[^{}]*\}/g, '')
        .replace(/\([^()]*\)/g, '');
    const out = [];
    for (const tok of inner.split(',')) {
        const m = /^[A-Za-z_]\w*/.exec(tok.trim());
        if (m && !out.includes(m[0])) out.push(m[0]);
    }
    return out.length ? out : null;
}

/** Non-empty key list of a plain object, or null. */
function keysOrNull(obj, { skipUnderscore = false } = {}) {
    if (!isPlainObject(obj)) return null;
    const keys = Object.keys(obj).filter(k => !skipUnderscore || !k.startsWith('_'));
    return keys.length ? keys : null;
}

/**
 * The top-level fields of a tool's output: runtime → curated → sample → null.
 * A runtime descriptor that is itself an array ({ _array, _length }) has no
 * top-level fields to offer and falls through to the curated shape.
 */
function topLevelFieldsOf(tool, draftWrap) {
    const rt = draftWrap?._runtimeShapes?.[tool];
    if (isPlainObject(rt) && !('_array' in rt)) {
        const fields = keysOrNull(rt);
        if (fields) return { fields, source: 'runtime' };
    }
    const schema = OUTPUT_SCHEMAS[tool];
    if (isPlainObject(schema?.shape) && !schema.shape._string) {
        const fields = keysOrNull(schema.shape, { skipUnderscore: true });
        if (fields) return { fields, source: 'curated' };
    }
    const fields = keysOrNull(schema?.sample);
    if (fields) return { fields, source: 'sample' };
    return { fields: null, source: null };
}

/**
 * The fields of ONE ENTRY of `output.<arrayField>` of a tool: runtime →
 * curated → sample → null. A runtime `array<empty>` (the tool returned no
 * rows on the run that taught us) says nothing about an entry, so it falls
 * through rather than reporting "no fields"; so does an array of primitives.
 */
function itemFieldsOf(tool, arrayField, draftWrap) {
    const rt = draftWrap?._runtimeShapes?.[tool];
    const rtField = isPlainObject(rt) ? unwrapJson(rt[arrayField]) : undefined;
    if (isPlainObject(rtField)) {
        const fields = keysOrNull(rtField._array);
        if (fields) return { fields, source: 'runtime' };
    }
    const schema = OUTPUT_SCHEMAS[tool];
    const parsed = parseArrayItemFields(isPlainObject(schema?.shape) ? schema.shape[arrayField] : undefined);
    if (parsed) return { fields: parsed, source: 'curated' };
    const sampleArr = isPlainObject(schema?.sample) ? schema.sample[arrayField] : undefined;
    if (Array.isArray(sampleArr)) {
        const fields = unionKeys(sampleArr);
        if (fields) return { fields, source: 'sample' };
    }
    return { fields: null, source: null };
}

// core/automationRunner: a forEach step collects one of these per iteration.
const FANOUT_ENVELOPE = new Set(['index', 'item', 'output', 'status']);
const HTTP_REQUEST_OUTPUT = Object.freeze(['status', 'headers', 'body']);
// core/automationRunner execDatatable: a write returns the row it wrote, a
// read returns a page. Any other op is not described, so it stays unknown.
const DATATABLE_OUTPUT = Object.freeze({
    add_row: ['row', 'id', 'created', 'updated'],
    save_row: ['row', 'id', 'created', 'updated'],
    find_rows: ['rows', 'returned', 'found', 'hasMore', 'nextCursor'],
});

/**
 * The fields a step's OWN output has (what sits under `output` in a fan-out
 * entry), by step type. null when the type's output is per-run data we
 * cannot see from the definition — an ai_step without an outputSchema, a set
 * with no fields — because "unknown" must never read as "nothing".
 */
function ownOutputFieldsOf(step, draftWrap) {
    switch (step.type) {
        case 'integration_action':
            return topLevelFieldsOf(step.tool, draftWrap).fields;
        case 'data_extraction': {
            if (!Array.isArray(step.fields)) return null;
            const names = step.fields.map(f => (isPlainObject(f) ? f.name : f)).filter(n => typeof n === 'string' && n);
            return names.length ? names : null;
        }
        case 'ai_step':
            return keysOrNull(step.outputSchema?.properties || step.outputSchema);
        case 'set':
            return typeof step.arrayRef === 'string' ? null : keysOrNull(step.fields);
        case 'http_request':
            return [...HTTP_REQUEST_OUTPUT];
        case 'datatable':
            return DATATABLE_OUTPUT[step.op] ? [...DATATABLE_OUTPUT[step.op]] : null;
        default:
            return null;
    }
}

function emptyResult() {
    return { fields: null, source: null, upstream: null, arrayField: null, outputFields: null, itemFields: null };
}

/**
 * What ONE ENTRY of the list at `refPath` looks like — the thing `loop.<var>`
 * is when a forEach iterates that ref.
 *
 * Returns { fields, source, upstream, arrayField, outputFields, itemFields }:
 *   fields       — names bindable directly under loop.<var>, or null (unknown)
 *   source       — 'runtime' | 'curated' | 'sample' | 'fanout' | 'trigger' | null
 *   upstream     — { stepId, tool, type } of the step (or trigger) that emits
 *                  the list, filled whenever the step exists even if its shape
 *                  is unknown, so an error can still name it
 *   arrayField   — the output field the list sits under
 *   outputFields — fan-out only: the iterating step's own output fields
 *   itemFields   — fan-out only: the fields of the item that step iterated
 *
 * FAN-OUT. A step with a forEach emits `results`, one entry per iteration,
 * each {index, item, output, status}. Its `fields` list carries both the four
 * envelope names and the dotted `output.<f>` / `item.<f>` paths, so a caller
 * can tell "output is known and content is in it" from "output is opaque".
 * Filter/limit/dedupe pass their input list through unchanged; a set in list
 * mode passes it through plus the fields it adds. Everything else — loop.*,
 * vars.*, a step type with no described list — is unknown.
 */
function fieldsAtRef(graph, refPath, draftWrap, depth = 0) {
    const tokens = refTokens(refPath);
    if (!tokens || tokens.some(t => t.type !== 'prop')) return emptyResult();
    const segs = tokens.map(t => String(t.key));

    if (segs[0] === 'steps' && segs.length === 4 && segs[2] === 'output') {
        return fieldsAtStepOutput(graph, segs[1], segs[3], draftWrap, depth);
    }
    if (segs[0] === 'trigger' && segs[1] === 'output' && (segs.length === 2 || segs.length === 3)) {
        return fieldsAtTriggerOutput(graph, segs[2]);
    }
    return emptyResult();
}

function fieldsAtStepOutput(graph, stepId, field, draftWrap, depth) {
    const found = findStepAnywhere(graph, stepId);
    if (!found) return emptyResult();
    const step = found.step;
    const base = {
        ...emptyResult(),
        upstream: { stepId: step.id, tool: typeof step.tool === 'string' ? step.tool : null, type: step.type },
        arrayField: field,
    };

    // Fan-out: the step runs once per item and collects the runs in `results`.
    if (field === 'results' && isPlainObject(step.forEach) && typeof step.forEach.overRef === 'string') {
        const outputFields = ownOutputFieldsOf(step, draftWrap);
        const itemFields = depth < MAX_REF_DEPTH
            ? fieldsAtRef(graph, step.forEach.overRef, draftWrap, depth + 1).fields
            : null;
        return {
            ...base,
            source: 'fanout',
            fields: [
                ...FANOUT_ENVELOPE,
                ...(outputFields || []).map(f => `output.${f}`),
                ...(itemFields || []).map(f => `item.${f}`),
            ],
            outputFields,
            itemFields,
        };
    }

    if (step.type === 'integration_action') {
        const { fields, source } = itemFieldsOf(step.tool, field, draftWrap);
        return { ...base, fields, source };
    }

    if (step.type === 'flatten' && field === 'items' && typeof step.arrayRef === 'string') return flattenFieldsOf(graph, step, base, draftWrap, depth);

    const passesThrough = (step.type === 'filter' || step.type === 'limit' || step.type === 'dedupe' || step.type === 'set')
        && field === 'items' && typeof step.arrayRef === 'string';
    if (passesThrough) {
        if (depth >= MAX_REF_DEPTH) return base;
        const through = fieldsAtRef(graph, step.arrayRef, draftWrap, depth + 1);
        const upstream = through.upstream || base.upstream;
        if (step.type !== 'set' || through.fields === null) return { ...through, upstream };
        // A set in list mode hands every row on with its own fields added; a
        // row the upstream does not describe stays unknown (null above), or a
        // valid upstream field would be refused for not being in the set.
        const added = Object.keys(isPlainObject(step.fields) ? step.fields : {});
        return { ...through, upstream, fields: [...through.fields, ...added.filter(f => !through.fields.includes(f))] };
    }

    return base;
}

/** The row keys a flatten makes from its source's sample (never its source's own fields: a row is a new record). */
function flattenFieldsOf(graph, step, base, draftWrap, depth) {
    if (depth >= MAX_REF_DEPTH) return base;
    const { sampleRootFor } = require('./stepBuilders/flattenStep');
    const fields = Object.keys(flattenShape(sampleRootFor(graph, step.arrayRef, draftWrap, depth + 1), step));
    return fields.length ? { ...base, fields, source: 'flatten' } : base;
}

function fieldsAtTriggerOutput(graph, arrayField) {
    const triggers = [graph?.trigger, ...(Array.isArray(graph?.triggers) ? graph.triggers : [])].filter(Boolean);
    const upstream = graph?.trigger?.id ? { stepId: graph.trigger.id, tool: null, type: 'trigger' } : null;
    if (arrayField === undefined) {
        const fields = triggerFieldsForGraph(graph);
        return { ...emptyResult(), upstream, fields: fields.length ? fields : null, source: fields.length ? 'trigger' : null };
    }
    // The declared samples are the only description of what an entry of a
    // trigger's list field looks like. Read per access: the catalog is a
    // getter recomputed from the registry, so a source registered after boot
    // is seen too.
    const samples = triggerCatalog.TRIGGER_OUTPUT_SAMPLES || {};
    for (const t of triggers) {
        if (t.kind !== 'app_event') continue;
        const sample = samples[`${t.appEvent?.provider}.${t.appEvent?.event}`];
        const arr = isPlainObject(sample) ? sample[arrayField] : undefined;
        const fields = Array.isArray(arr) ? unionKeys(arr) : null;
        if (fields) return { ...emptyResult(), upstream, arrayField, fields, source: 'trigger' };
    }
    return { ...emptyResult(), upstream, arrayField };
}

function triggerFieldsForGraph(graph) {
    try { return triggerCatalog.triggerFieldsFor(graph) || []; }
    catch { return []; }
}

/**
 * Check one `loop.<v>.<rest>` binding of a step against the shape of what
 * its forEach iterates — deep and token-based: `loop.m.payload.headers[0]
 * .value`, `loop.r.output.items[*].sku` and `loop.f["Story Points"]` are
 * walked over the item's shape (refCheck.js) the way the run reads them.
 * Only the step's own var is checked (v === itemVar); a foreign var is
 * another check's business (bindings.unboundLoopVarError).
 *
 * Returns
 *   { ok: true }                         — fine, or shape unknown, or not ours
 *   { ok: true, path, note }             — REPAIRED with one obvious fix: a
 *                                          fan-out field bound without its
 *                                          envelope segment (exactly one of
 *                                          output./item. has it), a case-only
 *                                          misspelling, a key on a list
 *   { ok: false, ambiguous: true, … }    — both output.<rest> and item.<rest>
 *                                          exist; only the model knows which
 *   { ok: false, missing, at, itemFields, upstream, fanout, outputFields,
 *     suggestions, sure, message }      — `missing` is the part of <rest> up
 *                                          to where it broke; `message` one
 *                                          readable sentence with a "did you
 *                                          mean"
 */
function checkLoopRef(graph, refPath, forEach, draftWrap) {
    const tokens = refTokens(refPath);
    if (!tokens || !isPlainObject(forEach) || typeof forEach.overRef !== 'string') return { ok: true };
    if (tokens[0].key !== 'loop' || !tokens[1] || String(tokens[1].key) !== forEach.itemVar) return { ok: true };
    if (tokens.length === 2) return { ok: true };                 // loop.<v>: the whole item

    const item = itemOf(shapeAtRef(graph, forEach.overRef, draftWrap));
    if (item.t === 'any') return { ok: true };
    const path = formatPath(tokens);
    const res = checkAgainst(item, tokens, 2, {});
    if (!res.problem && !res.fixes.length) return { ok: true };

    const at = fieldsAtRef(graph, forEach.overRef, draftWrap);
    const fanout = at.source === 'fanout';
    if (!res.problem) {
        const fixed = formatPath(res.tokens);
        const origin = at.upstream && at.arrayField ? `steps.${at.upstream.stepId}.output.${at.arrayField}` : forEach.overRef;
        const reasons = res.fixes.map(f => (f.envelope
            ? `an entry of ${origin} is {index, item, output, status}; ${f.envelope === 'output' ? 'the step\'s result sits under output' : 'the iterated item sits under item'}`
            : f.why));
        return { ok: true, path: fixed, note: `binding "${path}" read as "${fixed}" — ${reasons.join('; ')}.` };
    }
    const p = res.problem;
    if (p.kind === 'ambiguous') {
        return {
            ok: false,
            ambiguous: true,
            at: path,
            candidates: p.candidates.map(t => formatPath(t)),
            itemFields: at.fields,
            upstream: at.upstream,
            fanout: true,
            outputFields: at.outputFields,
            message: describeProblem(p, path),
        };
    }
    const brokenAt = Number.isInteger(p.at) ? p.at : res.tokens.length - 1;
    return {
        ok: false,
        missing: formatPath(res.tokens.slice(2, brokenAt + 1)),
        at: path,
        itemFields: at.fields,
        upstream: at.upstream,
        fanout,
        outputFields: at.outputFields,
        suggestions: p.suggestions || [],
        sure: !!p.sure,
        message: describeProblem(p, path),
    };
}

function listNames(names) {
    if (!Array.isArray(names)) return '';
    return names.length > MAX_FIELDS_LISTED
        ? `${names.slice(0, MAX_FIELDS_LISTED).join(', ')}, …`
        : names.join(', ');
}

/**
 * The phrase an error uses for "what loop.<var> is". null when nothing is
 * known — the caller then says nothing rather than something false.
 *
 *   plain:   the forEach item (an entry of steps.a_1.output.items from
 *            nextcloud_list_files) has: name, path, type, size, …
 *   fan-out: the forEach item (an entry of steps.a_2.output.results from
 *            nextcloud_read_file) is {index, item, output, status}; output
 *            has: path, size, contentType, …
 */
function describeItem(res) {
    if (!res || res.fields === null) return null;
    const up = res.upstream;
    let origin = null;
    if (up && up.type === 'trigger') origin = `an entry of trigger.output${res.arrayField ? `.${res.arrayField}` : ''}`;
    else if (up && up.stepId) origin = `an entry of steps.${up.stepId}.output.${res.arrayField || 'items'}${up.tool ? ` from ${up.tool}` : ''}`;
    const subject = origin ? `the forEach item (${origin})` : 'the forEach item';
    if (res.source === 'fanout') {
        const outputs = res.outputFields ? `; output has: ${listNames(res.outputFields)}` : '; output has no described shape';
        return `${subject} is {index, item, output, status}${outputs}`;
    }
    return `${subject} has: ${listNames(res.fields)}`;
}

module.exports = {
    parseArrayItemFields,
    topLevelFieldsOf,
    itemFieldsOf,
    fieldsAtRef,
    checkLoopRef,
    describeItem,
};
