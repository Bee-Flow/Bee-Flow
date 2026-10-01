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
 *
 * Pure and synchronous: the per-type step builders are sync, and this runs
 * inside them. Required from within automation/builderTools/.
 */

const { OUTPUT_SCHEMAS } = require('../outputSchemas');
const { findStepAnywhere } = require('./draftGraph');
const triggerCatalog = require('./triggerCatalog');
const { repairRefPath } = require('./bindings');
const { REF_RE, tokenizePath, formatPath } = require('../../shared/mapping/index.mjs');

const MAX_FIELDS_LISTED = 20;
// A forEach over a fan-out over a fan-out is the deepest shape a build has
// produced; beyond that a self-referencing overRef would recurse forever.
const MAX_REF_DEPTH = 3;

function isPlainObject(v) {
    return !!v && typeof v === 'object' && !Array.isArray(v);
}

/**
 * Does `step` run once per item of a list? A legacy forEach, or a repeat
 * (the same envelope, `{ iterations, succeeded, failed, results }`, from
 * execRepeat.js): "Koppelingen bijwerken" turns the one into the other, and
 * the builder must read the step the same before and after.
 */
function isFanOutStep(step) {
    if (!isPlainObject(step)) return false;
    if (isPlainObject(step.forEach) && typeof step.forEach.overRef === 'string') return true;
    return isPlainObject(step.repeat) && isPlainObject(step.repeat.over);
}

/**
 * The list a fan-out step runs over, as a legacy ref path: the forEach's
 * overRef, or the repeat's Source written as one (formatPath). null when the
 * step does not fan out, or its Source has no legacy spelling.
 */
function fanOutOverRef(step) {
    if (!isFanOutStep(step)) return null;
    if (isPlainObject(step.forEach) && typeof step.forEach.overRef === 'string') return step.forEach.overRef;
    return formatPath(step.repeat.over);
}

// The path the binding canonicaliser STORES (bindings.js repairRefPath), in
// the dotted form the lookups below split on: `items[0].x` → `items.0.x`,
// `results[*].a` → `results.*.a`, `row["Due date"]` → `row.Due date`. The
// check must see the same path the canonicaliser stores, or a repair would be
// computed against a spelling that never reaches the step. Dotted is for
// matching names only; a path handed BACK to the step is built from the
// stored spelling (see checkLoopRef), never from this.
function normalizeRefPath(path) {
    if (typeof path !== 'string') return null;
    const stored = repairRefPath(path).path;
    const tokens = REF_RE.test(stored) ? tokenizePath(stored) : null;
    if (!tokens) return stored.replace(/\s*\.\s*/g, '.').replace(/\.{2,}/g, '.');
    return tokens.map(t => (t.type === 'wild' ? '*' : String(t.key))).join('.');
}

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
    const rtField = isPlainObject(rt) ? rt[arrayField] : undefined;
    if (isPlainObject(rtField)) {
        const fields = keysOrNull(rtField._array);
        if (fields) return { fields, source: 'runtime' };
    }
    const schema = OUTPUT_SCHEMAS[tool];
    const parsed = parseArrayItemFields(isPlainObject(schema?.shape) ? schema.shape[arrayField] : undefined);
    if (parsed) return { fields: parsed, source: 'curated' };
    const sampleArr = isPlainObject(schema?.sample) ? schema.sample[arrayField] : undefined;
    if (Array.isArray(sampleArr)) {
        const fields = keysOrNull(sampleArr[0]);
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
 * FAN-OUT. A step with a forEach (or a repeat) emits `results`, one entry per iteration,
 * each {index, item, output, status}. Its `fields` list carries both the four
 * envelope names and the dotted `output.<f>` / `item.<f>` paths, so a caller
 * can tell "output is known and content is in it" from "output is opaque".
 * Filter/limit/dedupe pass their input list through unchanged; a set in list
 * mode passes it through plus the fields it adds. Everything else — loop.*,
 * vars.*, a step type with no described list — is unknown.
 */
function fieldsAtRef(graph, refPath, draftWrap, depth = 0) {
    const path = normalizeRefPath(refPath);
    if (!path) return emptyResult();
    const segs = path.split('.');

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
    if (field === 'results' && isFanOutStep(step)) {
        const outputFields = ownOutputFieldsOf(step, draftWrap);
        const overRef = fanOutOverRef(step);
        const itemFields = depth < MAX_REF_DEPTH && overRef
            ? fieldsAtRef(graph, overRef, draftWrap, depth + 1).fields
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
        const fields = Array.isArray(arr) ? keysOrNull(arr[0]) : null;
        if (fields) return { ...emptyResult(), upstream, arrayField, fields, source: 'trigger' };
    }
    return { ...emptyResult(), upstream, arrayField };
}

function triggerFieldsForGraph(graph) {
    try { return triggerCatalog.triggerFieldsFor(graph) || []; }
    catch { return []; }
}

/**
 * Is `rest` (the part of a loop ref after `loop.<var>.`) reachable in `fields`?
 * A dotted prefix counts — 'name.first' is fine when 'name' is known, we do
 * not see deeper — EXCEPT for a fan-out envelope key whose contents ARE known:
 * 'output' being in the list must not make 'output.anything' pass when the
 * step's output fields are listed and 'anything' is not one of them. The
 * containers whose contents are unknown (null) stay permissive.
 */
function presentIn(rest, fields, containersWithKnownContents) {
    const segs = rest.split('.');
    const known = new Set(fields);
    for (let i = 1; i <= segs.length; i++) {
        const prefix = segs.slice(0, i).join('.');
        if (!known.has(prefix)) continue;
        if (i < segs.length && containersWithKnownContents.has(prefix)) continue;
        return true;
    }
    return false;
}

/**
 * Check one `loop.<v>.<rest>` binding of a step against the shape of what
 * its forEach iterates. Only the step's own var is checked (v === itemVar);
 * a foreign var is another check's business (bindings.unboundLoopVarError).
 *
 * Returns
 *   { ok: true }                         — fine, or shape unknown, or not ours
 *   { ok: true, path, note }             — REPAIRED: the model bound a fan-out
 *                                          field without its envelope segment;
 *                                          exactly one of output./item. has it
 *   { ok: false, ambiguous: true, … }    — both output.<rest> and item.<rest>
 *                                          exist; only the model knows which
 *   { ok: false, missing, at, itemFields, upstream, fanout, outputFields }
 */
function checkLoopRef(graph, refPath, forEach, draftWrap) {
    const path = normalizeRefPath(refPath);
    if (!path || !isPlainObject(forEach) || typeof forEach.overRef !== 'string') return { ok: true };
    const segs = path.split('.');
    if (segs[0] !== 'loop' || segs[1] !== forEach.itemVar) return { ok: true };
    const rest = segs.slice(2).join('.');
    if (!rest) return { ok: true };                       // loop.<v>: the whole item

    const res = fieldsAtRef(graph, forEach.overRef, draftWrap);
    if (res.fields === null) return { ok: true };
    const fanout = res.source === 'fanout';
    const containers = new Set();
    if (fanout && res.outputFields !== null) containers.add('output');
    if (fanout && res.itemFields !== null) containers.add('item');

    if (presentIn(rest, res.fields, containers)) return { ok: true };

    // Repair only when the model skipped the envelope altogether. A ref that
    // already starts with output./item./index/status named the envelope and
    // missed a field under it; wrapping it again would turn `item.nope` into
    // `output.item.nope` whenever the output half is opaque, hiding the miss.
    if (fanout && !FANOUT_ENVELOPE.has(segs[2])) {
        const under = ['output', 'item'].filter(env => presentIn(`${env}.${rest}`, res.fields, containers));
        if (under.length === 1) {
            const env = under[0];
            // Spliced into the STORED spelling, so a bracketed key or index
            // after the envelope keeps its brackets.
            const stored = repairRefPath(refPath).path;
            const head = `loop.${segs[1]}`;
            const fixed = stored.startsWith(head) ? `${head}.${env}${stored.slice(head.length)}` : `loop.${segs[1]}.${env}.${rest}`;
            const origin = res.upstream ? `steps.${res.upstream.stepId}.output.${res.arrayField}` : forEach.overRef;
            const where = env === 'output' ? 'the step\'s result sits under output' : 'the iterated item sits under item';
            return {
                ok: true,
                path: fixed,
                note: `binding "${path}" read as "${fixed}" — an entry of ${origin} is {index, item, output, status}; ${where}.`,
            };
        }
        if (under.length === 2) {
            return {
                ok: false,
                ambiguous: true,
                at: path,
                candidates: under.map(env => `loop.${segs[1]}.${env}.${rest}`),
                itemFields: res.fields,
                upstream: res.upstream,
                fanout: true,
                outputFields: res.outputFields,
            };
        }
    }

    // The shortest prefix that is not known, skipping an envelope key whose
    // contents are listed: for 'output.nope' that is 'output.nope', not
    // 'output' (which exists) and not 'nope' (which has no home).
    const known = new Set(res.fields);
    let missing = rest;
    for (let i = 1; i <= segs.length - 2; i++) {
        const prefix = segs.slice(2, 2 + i).join('.');
        if (known.has(prefix) && containers.has(prefix)) continue;
        missing = prefix;
        break;
    }
    return {
        ok: false,
        missing,
        at: path,
        itemFields: res.fields,
        upstream: res.upstream,
        fanout,
        outputFields: res.outputFields,
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
    isFanOutStep,
    fanOutOverRef,
};
