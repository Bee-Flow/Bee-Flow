/**
 * Builder tools — checking a path the AI binds against the shape of what it
 * reads, all the way down, and repairing it when there is exactly one
 * obvious fix.
 *
 * WHY. The builder checked one thing about a path: its root. `steps.a.output.
 * reslts[0].subject`, `steps.a.output.results.subject` (a key on a list),
 * `steps.a.subject` (no `.output.`) and `steps.a.output.Subject` (case) were
 * all saved, validated clean and resolved to nothing at run time, with no
 * error anywhere. The model could not have known: it saw two levels of the
 * output at most. This module knows the shape (shapeTree.js) of every step
 * output the draft can describe and walks the path over it with the run's
 * own rules.
 *
 * Where it breaks, in order:
 *   - one obvious fix that keeps the MEANING → applied and NAMED (a note the
 *     model reads back):
 *       steps.a.subject                → steps.a.output.subject
 *       ….Subject                      → ….subject            (case only)
 *       ….results.subject              → ….results[0].subject  ([*] where a
 *                                        list is wanted, e.g. forEach.overRef)
 *       ….output.subject (only inside the one list, on a COMPLETE shape)
 *                                      → ….output.results[0].subject
 *       ….headers.subject              → ….headers[name="Subject"].value
 *       loop.r.content (fan-out entry) → loop.r.output.content
 * *   - several → refused/warned with the candidates;
 *   - none    → refused when the shape is COMPLETE (`sure` in shapeTree.js),
 *               warned otherwise, with a short "did you mean" list: the
 *               closest keys where it broke and the places the named key
 *               really lives.
 * A path that resolves is never rewritten into another one: an index into a
 * name/value list stays the index (picking by name is advice), and a guess
 * by spelling (`cc` → `id`) is only ever said. An unknown shape is never a
 * reason to refuse: no shape, no complaint.
 *
 * Shape sources, best first and merged: what this step returned in a dry run
 * this turn (draftWrap._stepShapes), a runtime descriptor of its tool
 * (draftWrap._runtimeShapes), the curated outputSchemas.js shape and sample,
 * and what the step's own config declares (extraction fields, a set's
 * fields, a forEach's {index, item, output, status} envelope).
 *
 * Pure and synchronous; required by bindings.js and outputFields.js.
 */

'use strict';

const { OUTPUT_SCHEMAS } = require('../outputSchemas');
const { findStepAnywhere } = require('./draftGraph');
const { formatPath, appendKey, appendMatch, flattenShape } = require('../expr');
const S = require('./shapeTree');
const { normalizeAiPath } = require('./aiPaths');

const { ANY } = S;
const MAX_REF_DEPTH = 3;
// What runState.steps[<id>] holds besides output (core/automationRunner/runDag.js).
const STEP_RESULT_KEYS = new Set(['output', 'status', 'error', 'synthesised']);
// What runState.trigger holds besides output (core/automationRunner/triggerState.js).
const TRIGGER_TOP_KEYS = new Set(['output', 'headers', 'id', 'kind', 'source', 'label', 'provider', 'event', 'firedAt', 'schedule']);
// One entry of a forEach step's `results` (core/automationRunner/execFlow.js).
const ENVELOPE_KEYS = ['index', 'item', 'output', 'status', 'error', 'errorClass', 'attempts'];
const MAX_SUGGESTIONS = 3;
const MAX_LISTED = 15;

const isPlainObject = v => !!v && typeof v === 'object' && !Array.isArray(v);
const num = () => ({ t: 'num' });
const str = () => ({ t: 'str' });
const bool = () => ({ t: 'bool' });
function obj(entries, { open = false, sure = true, envelope = false } = {}) {
    return { t: 'obj', keys: new Map(entries), open, sure, ...(envelope ? { envelope: true } : {}) };
}

// ── What a step outputs ──────────────────────────────────────────────────

const _staticToolShapes = new Map();

/** Curated shape ∪ declared sample of a tool, or null when neither exists. */
function staticToolShape(tool) {
    if (_staticToolShapes.has(tool)) return _staticToolShapes.get(tool);
    const schema = Object.prototype.hasOwnProperty.call(OUTPUT_SCHEMAS, tool) ? OUTPUT_SCHEMAS[tool] : null;
    let s = null;
    if (schema && schema.shape) s = S.merge(s, S.fromCurated(schema.shape));
    if (schema && schema.sample !== undefined) s = S.merge(s, S.fromValue(schema.sample, { sure: false }));
    _staticToolShapes.set(tool, s);
    return s;
}

/** What a tool returns: runtime descriptor ∪ curated ∪ sample; ANY when nothing is known. */
function toolOutputShape(tool, draftWrap) {
    if (typeof tool !== 'string' || !tool) return ANY;
    const rt = draftWrap && draftWrap._runtimeShapes ? draftWrap._runtimeShapes[tool] : undefined;
    const s = S.merge(staticToolShape(tool), rt ? S.fromDescriptor(rt) : null);
    return s || ANY;
}

/** An ai_step outputSchema (JSON-schema-ish or a plain {field: 'type'} map) as a shape. */
function schemaShape(schema, depth = 0) {
    if (depth > 8) return ANY;
    if (typeof schema === 'string') return S.fromDescription(schema);
    if (!isPlainObject(schema)) return ANY;
    const type = typeof schema.type === 'string' ? schema.type : null;
    if (type === 'array') return { t: 'arr', item: schema.items ? schemaShape(schema.items, depth + 1) : ANY, sure: false };
    if (type === 'string') return str();
    if (type === 'number' || type === 'integer') return num();
    if (type === 'boolean') return bool();
    const props = isPlainObject(schema.properties) ? schema.properties : (type ? null : schema);
    if (!props) return ANY;
    const entries = Object.entries(props).map(([k, v]) => [k, schemaShape(v, depth + 1)]);
    // The model is asked for these keys, not held to them: a miss is a warning.
    return entries.length ? { t: 'obj', keys: new Map(entries), open: false, sure: false } : ANY;
}

/** What a step's OWN run returns (before any forEach wraps it), by type. */
function ownOutputShape(step, graph, draftWrap, depth) {
    switch (step.type) {
        case 'integration_action':
            return toolOutputShape(step.tool, draftWrap);
        case 'data_extraction': {
            if (!Array.isArray(step.fields) || !step.fields.length) return ANY;
            const entries = [];
            for (const f of step.fields) {
                const name = isPlainObject(f) ? f.name : f;
                if (typeof name !== 'string' || !name) continue;
                const type = isPlainObject(f) ? f.type : 'string';
                entries.push([name, type === 'number' ? num() : type === 'boolean' ? bool() : str()]);
            }
            return entries.length ? obj(entries) : ANY;
        }
        case 'ai_step':
            return step.outputSchema ? schemaShape(step.outputSchema) : ANY;
        case 'set': {
            const fieldKeys = isPlainObject(step.fields) ? Object.keys(step.fields) : [];
            if (typeof step.arrayRef !== 'string') return fieldKeys.length ? obj(fieldKeys.map(k => [k, ANY])) : ANY;
            const rows = depth < MAX_REF_DEPTH ? S.itemOf(shapeAtRef(graph, step.arrayRef, draftWrap, depth + 1)) : ANY;
            const item = setRowShape(rows, fieldKeys, step.operations);
            return obj([['items', { t: 'arr', item, sure: true }], ['count', num()], ['warning', str()], ['_evalError', str()], ['skipped', str()]]);
        }
        case 'http_request':
            return obj([['status', num()], ['ok', bool()], ['headers', obj([], { open: true })], ['body', ANY], ['data', ANY]], { open: true });
        // execDatatable.js; `skipped` is what an unresolved filter or an
        // unknown column leaves beside the empty output.
        case 'datatable':
            if (step.op === 'add_row' || step.op === 'save_row') {
                return obj([['row', obj([], { open: true })], ['id', ANY], ['created', bool()], ['updated', num()], ['skipped', str()]]);
            }
            if (step.op === 'find_rows' || !step.op) {
                return obj([['rows', { t: 'arr', item: obj([], { open: true }), sure: true }], ['returned', num()], ['found', bool()], ['hasMore', bool()], ['nextCursor', str()], ['count', num()], ['skipped', str()]]);
            }
            return ANY;
        case 'filter':
        case 'limit':
        case 'dedupe': {
            if (typeof step.arrayRef !== 'string' || depth >= MAX_REF_DEPTH) return ANY;
            const item = S.itemOf(shapeAtRef(graph, step.arrayRef, draftWrap, depth + 1));
            return obj([['items', { t: 'arr', item, sure: true }], ['count', num()]], { open: true });
        }
        case 'flatten':
            return depth >= MAX_REF_DEPTH ? ANY : flattenOutputShape(step, graph, draftWrap, depth);
        default:
            return ANY;
    }
}

/**
 * A flatten's {items, count, inputCount, emptyCount}: its rows have the keys
 * the shared engine makes from the source's sample, and are not sure (with no
 * stored plan the run picks the parent fields from its own data).
 */
function flattenOutputShape(step, graph, draftWrap, depth) {
    // Lazy: flattenStep reads shapes through this module.
    const { sampleRootFor } = require('./stepBuilders/flattenStep');
    const keys = Object.keys(flattenShape(sampleRootFor(graph, step.arrayRef, draftWrap, depth + 1), step));
    const item = keys.length ? obj(keys.map(k => [k, ANY]), { sure: false }) : ANY;
    return obj([['items', { t: 'arr', item, sure: true }], ['count', num()], ['inputCount', num()], ['emptyCount', num()], ['warning', str()], ['skipped', str()]]);
}

/**
 * One row a set step in list mode outputs (execData.execSet): the source row
 * — a row that is not an object (a scalar, a list, JSON text) wrapped as
 * {value} — with the step's fields added, as complete as the source row is.
 * A set row is a COPY, never a forEach entry: the envelope flag is dropped,
 * or a miss on it would be "repaired" to `.output.<key>`. The whole-table
 * operations (rowId, groupId, rename, keep, remove) add, move and drop
 * columns; with any of them the row is left open rather than modelled, so a
 * column they make is never refused.
 */
function setRowShape(rows, fieldKeys, operations) {
    if (!rows || rows.t === 'any') return ANY;
    const base = rows.t === 'obj' && !rows.json ? rows : obj([['value', rows]]);
    const { envelope: _envelope, ...row } = S.merge(base, obj(fieldKeys.map(k => [k, ANY]), { sure: !!base.sure }));
    return Array.isArray(operations) && operations.length ? { ...row, open: true, sure: false } : row;
}

/** The output of a step with a forEach: the {iterations, …, results} envelope. */
function fanoutShape(step, graph, draftWrap, depth) {
    const own = ownOutputShape(step, graph, draftWrap, depth);
    const item = depth < MAX_REF_DEPTH ? S.itemOf(shapeAtRef(graph, step.forEach.overRef, draftWrap, depth + 1)) : ANY;
    const entry = obj([
        ['index', num()], ['item', item], ['output', own], ['status', str()],
        ['error', str()], ['errorClass', str()], ['attempts', num()],
    ], { envelope: true });
    return obj([
        ['iterations', num()], ['succeeded', num()], ['failed', num()],
        ['results', { t: 'arr', item: entry, sure: true }],
        ['truncated', bool()], ['totalItems', num()], ['skipped', str()],
    ]);
}

// A dry-run shape belongs to the step as it was when it ran; a step whose
// type, tool, op or forEach changed since then returns something else.
function stepSignature(step) {
    return `${step.type}|${step.tool || ''}|${step.op || ''}|${step.forEach && step.forEach.overRef ? 'forEach' : ''}`;
}

// Stamps runDag puts on a recorded dry-run output; the run's own state does
// not carry them, so they are not fields a binding can read.
const DRY_RUN_STAMPS = ['_dryRunSynthesised', '_dryRunFallback'];

/**
 * Remember what a step returned in a dry run, for the checks that follow
 * this turn. One run shows the STRUCTURE for sure (a list is a list), not
 * every key a run may carry (an optional field, a cursor only some pages
 * have): its key sets warn, never refuse. A SYNTHESISED output (a
 * side-effect tool, a tool without a connection: the curated sample stands
 * in) is only a sample, and a `partial` one (the shortened preview of an
 * output over 256 KB: lists cut, wide records cut) may lack anything — both
 * are `sure: false` throughout, the preview open as well.
 */
function rememberStepShape(draftWrap, step, value, { partial = false } = {}) {
    if (!draftWrap || typeof draftWrap !== 'object' || !step || !step.id) return null;
    if (!draftWrap._stepShapes || typeof draftWrap._stepShapes !== 'object') draftWrap._stepShapes = Object.create(null);
    const synthesised = isPlainObject(value) && value._dryRunSynthesised === true;
    let v = value;
    if (isPlainObject(value) && DRY_RUN_STAMPS.some(k => k in value)) {
        v = { ...value };
        for (const k of DRY_RUN_STAMPS) delete v[k];
    }
    const shape = S.fromValue(v, synthesised || partial ? { sure: false, open: partial } : { keysSure: false });
    draftWrap._stepShapes[step.id] = { sig: stepSignature(step), shape };
    return shape;
}

/** Everything known about what `steps.<step.id>.output` holds. */
function stepOutputShape(graph, step, draftWrap, depth = 0) {
    let shape = isPlainObject(step.forEach) && typeof step.forEach.overRef === 'string'
        ? fanoutShape(step, graph, draftWrap, depth)
        : ownOutputShape(step, graph, draftWrap, depth);
    const seen = draftWrap && draftWrap._stepShapes ? draftWrap._stepShapes[step.id] : null;
    if (seen && seen.sig === stepSignature(step) && seen.shape) {
        shape = shape.t === 'any' ? seen.shape : S.merge(shape, seen.shape);
    }
    return shape;
}

/**
 * trigger.output: the declared samples of the app_event triggers. Left OPEN
 * at every level — a declared sample names what a payload usually carries
 * (Gmail's lists no `attachments`, which the poller adds), so it may confirm
 * a field or fix its spelling, never refuse one. Any other trigger kind
 * (webhook body, form, manual, a flowlet's params) is unknown.
 */
function triggerOutputShape(graph) {
    const triggers = [graph && graph.trigger, ...(Array.isArray(graph && graph.triggers) ? graph.triggers : [])].filter(Boolean);
    if (!triggers.length) return ANY;
    let shape = null;
    for (const t of triggers) {
        if (t.kind !== 'app_event') return ANY;
        let ev = null;
        try { ev = require('../triggerSources').getEventDef(t.appEvent && t.appEvent.provider, t.appEvent && t.appEvent.event); }
        catch { ev = null; }
        if (!ev) return ANY;
        const s = S.fromValue(isPlainObject(ev.sample) ? ev.sample : {}, { sure: false, open: true });
        for (const f of (Array.isArray(ev.fields) ? ev.fields : [])) if (!s.keys.has(f)) s.keys.set(f, ANY);
        shape = S.merge(shape, s);
    }
    return shape || ANY;
}

/**
 * The root a path reads from: { node, from, label } with `from` the index of
 * the first token under it, or null when the root is not one we describe.
 */
function rootFor(graph, tokens, draftWrap, depth = 0) {
    const head = tokens[0] && tokens[0].key;
    if (head === 'steps' && tokens.length >= 3 && tokens[1].type === 'prop' && tokens[2].key === 'output') {
        const found = findStepAnywhere(graph, String(tokens[1].key));
        if (!found) return null;
        return { node: stepOutputShape(graph, found.step, draftWrap, depth), from: 3, step: found.step };
    }
    if (head === 'trigger' && tokens[1] && tokens[1].key === 'output') {
        return { node: triggerOutputShape(graph), from: 2 };
    }
    return null;
}

/** The shape a ref path yields (ANY when it is not known). */
function shapeAtRef(graph, path, draftWrap, depth = 0) {
    if (depth > MAX_REF_DEPTH) return ANY;
    const tokens = Array.isArray(path) ? path : normalizeAiPath(path).tokens;
    if (!tokens) return ANY;
    const root = rootFor(graph, tokens, draftWrap, depth);
    return root ? S.nodeAt(root.node, tokens.slice(root.from)) : ANY;
}

// ── Checking ─────────────────────────────────────────────────────────────

const lower = s => String(s).toLowerCase();
function keyCi(node, key) {
    if (!node || node.t !== 'obj') return null;
    const hits = [...node.keys.keys()].filter(k => lower(k) === lower(key));
    return hits.length === 1 ? hits[0] : null;
}

function editDistance(a, b) {
    a = lower(a); b = lower(b);
    if (a === b) return 0;
    const prev = Array.from({ length: b.length + 1 }, (_, i) => i);
    for (let i = 1; i <= a.length; i++) {
        let diag = prev[0];
        prev[0] = i;
        for (let j = 1; j <= b.length; j++) {
            const tmp = prev[j];
            prev[j] = Math.min(prev[j] + 1, prev[j - 1] + 1, diag + (a[i - 1] === b[j - 1] ? 0 : 1));
            diag = tmp;
        }
    }
    return prev[b.length];
}

const tokenKey = tok => (tok.type === 'wild' ? '*' : String(tok.key));
const splice = (tokens, at, del, ...ins) => [...tokens.slice(0, at), ...ins, ...tokens.slice(at + del)];

/** The fixes worth trying where a walk broke, each with the reason the model reads. */
function candidateFixes(tokens, r, opts) {
    const tok = tokens[r.at];
    const node = r.node;
    const out = [];
    const listPath = formatPath(tokens.slice(0, r.at));
    const idx = opts.wantList ? { type: 'wild' } : { type: 'prop', key: 0 };
    const idxWord = opts.wantList ? '[*] takes it from every entry' : '[0] is the first entry, [*] every entry';
    if (r.reason === 'missing') {
        const key = String(tok.key);
        const ci = keyCi(node, key);
        if (ci) out.push({ tokens: splice(tokens, r.at, 1, { type: 'prop', key: ci }), why: `the field is spelled "${ci}"` });
        // Moving the key into a list entry is a repair only where the shape
        // is complete: on one observed run (or a description) the key may
        // sit where the AI put it on another run — then it is a did-you-mean.
        if (node.envelope && !ENVELOPE_KEYS.includes(key) && !ci) {
            for (const env of ['output', 'item']) {
                out.push({
                    tokens: splice(tokens, r.at, 0, { type: 'prop', key: env }),
                    why: `an entry of a forEach step's results is {index, item, output, status}; ${env === 'output' ? 'the step\'s result sits under output' : 'the item it ran on sits under item'}`,
                    envelope: env,
                });
            }
        }
        if (!ci && r.sure) {
            const lists = [...node.keys].filter(([, v]) => v && v.t === 'arr' && v.item && v.item.t === 'obj' && (v.item.keys.has(key) || keyCi(v.item, key)));
            if (lists.length === 1) {
                const at = appendKey(listPath, lists[0][0]);
                out.push({ tokens: splice(tokens, r.at, 0, { type: 'prop', key: lists[0][0] }, idx), why: `"${key}" sits on the entries of the list ${at} — ${idxWord}` });
            }
        }
    } else if (r.reason === 'key-on-list') {
        const key = String(tok.key);
        const name = S.pairNameFor(node, key);
        if (name) {
            const m = { type: 'match', key: node.pairs.nameKey, value: name };
            const last = r.at === tokens.length - 1;
            const vk = node.pairs.valueKey;
            const ins = last && node.item && node.item.t === 'obj' && node.item.keys.has(vk) ? [m, { type: 'prop', key: vk }] : [m];
            out.push({ tokens: splice(tokens, r.at, 1, ...ins), why: `${listPath} is a list of ${node.pairs.nameKey}/${vk} pairs — ${formatPath([m])} picks the entry by its ${node.pairs.nameKey}` });
        } else {
            out.push({ tokens: splice(tokens, r.at, 0, idx), why: `${listPath} is a list — ${idxWord}` });
        }
    } else if (r.reason === 'not-list') {
        const lists = [...node.keys].filter(([, v]) => v && v.t === 'arr');
        if (lists.length === 1) {
            out.push({ tokens: splice(tokens, r.at, 0, { type: 'prop', key: lists[0][0] }), why: `${listPath} is an object; its list is ${appendKey(listPath, lists[0][0])}` });
        }
    }
    return out;
}

/**
 * Advice for a numeric index into a name/value list. The index is KEPT: it
 * is a path the run reads (`ranking[0]` is whoever ranks first, `headers[1]`
 * the second header even when two share a name), and a match would read
 * another entry — or freeze a sample value into the definition. Picking by
 * name is only SAID: when the lists seen disagree on their order, and when
 * the entry at the index had a name no other entry shares.
 */
function pairIndexAdvice(tokens, hits) {
    for (const h of hits || []) {
        const { nameKey, valueKey, names, byIndex } = h.list.pairs;
        const listPath = formatPath(tokens.slice(0, h.at));
        if (!byIndex) {
            return `${listPath} is a list of ${nameKey}/${valueKey} pairs whose order differs per record — [${h.index}] picks a different entry each time; select one by name, e.g. ${appendMatch(listPath, nameKey, names[0])}`;
        }
        const name = byIndex[h.index < 0 ? byIndex.length + h.index : h.index];
        if (name === undefined || byIndex.indexOf(name) !== byIndex.lastIndexOf(name)) return null;
        const byName = formatPath(splice(tokens, h.at, 1, { type: 'match', key: nameKey, value: name }));
        return `${listPath}[${h.index}] reads whichever entry sits there (in the sample: "${name}"); if you mean the entry named "${name}" on every record, bind ${byName}`;
    }
    return null;
}

// How far a key may be from one the shape has to be named as "did you
// mean": every two-letter key is two edits from every other (`to`/`id`), so
// short keys get no room or one edit, longer ones a third of their length.
function nearLimit(len) {
    if (len <= 2) return 0;
    return len <= 4 ? 1 : Math.max(2, Math.floor(len / 3));
}

/** Up to three paths the AI may have meant, plus what the broken level holds. */
function suggestionsFor(root, tokens, from, r, opts) {
    const prefix = formatPath(tokens.slice(0, r.at));
    const tok = tokens[r.at];
    const key = tok.type === 'match' ? tok.key : tokenKey(tok);
    const node = r.node;
    const near = [];
    let here = [];
    if (node.t === 'obj') {
        here = [...node.keys.keys()];
        const limit = nearLimit(key.length);
        const scored = here.map(k => [k, editDistance(k, key)]).filter(([, d]) => d <= limit);
        // Only the closest tier: `iban` (one edit from `ibn`) is not diluted by `id`.
        const best = Math.min(...scored.map(([, d]) => d));
        near.push(...scored.filter(([, d]) => d === best).slice(0, MAX_SUGGESTIONS).map(([k]) => appendKey(prefix, k)));
    } else if (node.t === 'arr' && node.item && node.item.t === 'obj') {
        here = [...node.item.keys.keys()];
    }
    const base = formatPath(tokens.slice(0, from));
    const deep = tok.type === 'prop' || tok.type === 'match'
        ? S.findKey(root, key, base, { wild: !!opts.wantList, max: MAX_SUGGESTIONS })
        : [];
    const suggestions = [...new Set([...near, ...deep])].slice(0, MAX_SUGGESTIONS + 1);
    // The one suggestion a resend may apply (bindings.js → suggestedPatch.js):
    // the key the AI named, as named, found in exactly one other place. A
    // near spelling is another word as often as a typo (cc → id, total →
    // totals): it is said, never applied.
    const patch = deep.length === 1 && !near.length ? deep[0] : null;
    return { prefix, key, suggestions, ...(patch ? { patch } : {}), here: here.slice(0, MAX_LISTED), more: Math.max(0, here.length - MAX_LISTED) };
}

/**
 * Walk `tokens` (from index `from`) over `root`, repairing what has exactly
 * one obvious fix. Returns { tokens, fixes, advice?, problem? } where fixes
 * are [{ why, envelope? }] in the order applied and problem is
 *   { kind: 'ambiguous', candidates: [tokens…] }
 *   { kind: 'broken', reason, sure, prefix, key, suggestions, patch?, here, more, nodeType }
 *   { kind: 'not-a-list', sure, nodeType }            (opts.wantList)
 * `patch` is the one suggestion that keeps the meaning (see suggestionsFor).
 */
function checkAgainst(root, tokens, from, opts = {}) {
    let cur = tokens;
    const fixes = [];
    const advice = [];
    let pairsDone = false;
    const done = (extra = {}) => ({ tokens: cur, fixes, ...(advice.length ? { advice } : {}), ...extra });
    for (let round = 0; round < 5; round++) {
        const r = S.walk(root, cur, from, []);
        if (r.status === 'ok' || r.status === 'unknown') {
            if (!pairsDone) {
                pairsDone = true;
                const a = pairIndexAdvice(cur, r.indexHits);
                if (a) advice.push(a);
            }
            if (r.status === 'unknown' && r.node && r.node.t === 'obj' && r.at !== undefined && cur[r.at].type === 'prop') {
                const ci = keyCi(r.node, cur[r.at].key);
                if (ci && ci !== String(cur[r.at].key)) {
                    cur = splice(cur, r.at, 1, { type: 'prop', key: ci });
                    fixes.push({ why: `the field is spelled "${ci}"` });
                    continue;
                }
            }
            // JSON text of a list IS a list where one is wanted: a forEach, a
            // Loop and a list step read their source through bind.walkList,
            // which parses it. Only text known to hold no list is not one.
            if (opts.wantList && r.status === 'ok' && r.node) {
                if (r.node.t === 'obj') {
                    const lists = [...r.node.keys].filter(([, v]) => v && v.t === 'arr');
                    if (lists.length === 1) {
                        const p = formatPath(cur);
                        cur = [...cur, { type: 'prop', key: lists[0][0] }];
                        fixes.push({ why: `${p} is an object; the list in it is ${formatPath(cur)}` });
                        continue;
                    }
                    if (!r.node.open) return done({ problem: { kind: 'not-a-list', sure: !!r.node.sure, nodeType: 'object', here: [...r.node.keys.keys()].slice(0, MAX_LISTED) } });
                }
                if (r.node.t === 'num' || r.node.t === 'bool') {
                    return done({ problem: { kind: 'not-a-list', sure: !!root.sure, nodeType: r.node.t === 'num' ? 'number' : 'boolean' } });
                }
            }
            return done();
        }
        // A fix is valid when the walk gets past the point it repairs. A
        // structural one that then stops only at a key an INCOMPLETE shape
        // does not list (`items.email` → `items[0].email`, entries seen
        // without `email`) still repairs the structure when it is the only
        // fix; that miss is then a warning of its own on the next round.
        // Choosing between a fan-out entry's output and item is not structural.
        const tried = candidateFixes(cur, r, opts).map((f) => {
            const w = S.walk(root, f.tokens, from, []);
            const past = w.status !== 'broken' || w.at > r.at + (f.tokens.length - cur.length);
            return { ...f, past, possible: !past && !w.sure && !f.envelope };
        });
        const passing = tried.filter(f => f.past);
        const possible = tried.filter(f => f.possible);
        const valid = passing.length ? passing : (possible.length === 1 ? possible : []);
        if (valid.length === 1) {
            cur = valid[0].tokens;
            fixes.push({ why: valid[0].why, envelope: valid[0].envelope });
            continue;
        }
        if (valid.length > 1) return done({ problem: { kind: 'ambiguous', sure: !!r.sure, candidates: valid.map(v => v.tokens), envelope: valid.every(v => v.envelope) } });
        const nodeType = r.node.t === 'num' ? 'number' : r.node.t === 'bool' ? 'boolean' : r.node.t === 'arr' ? 'list' : 'object';
        return done({ problem: { kind: 'broken', reason: r.reason, sure: !!r.sure, at: r.at, nodeType, ...suggestionsFor(root, cur, from, r, opts) } });
    }
    return done();
}

/** One readable sentence for a problem checkAgainst found. */
function describeProblem(problem, path) {
    if (problem.kind === 'ambiguous') {
        return `"${path}" could mean ${problem.candidates.map(t => formatPath(t)).join(' or ')} — bind the one you mean.`;
    }
    if (problem.kind === 'not-a-list') {
        return `"${path}" is ${problem.nodeType === 'object' ? 'an object' : `a ${problem.nodeType}`}, not a list${problem.here && problem.here.length ? ` (it has: ${problem.here.join(', ')})` : ''} — point it at a list.`;
    }
    const { reason, prefix, key, suggestions, here, more, nodeType } = problem;
    let what;
    if (reason === 'scalar') what = `${prefix} is a ${nodeType}, so it has no "${key}"`;
    else if (reason === 'not-list') what = `${prefix} is an object, not a list, so [${key === '*' ? '*' : '…'}] reads nothing`;
    else if (reason === 'match-key') what = `the entries of ${prefix} have no "${key}" to match on`;
    else if (reason === 'key-on-list') what = `${prefix} is a list — read an entry first ([0], [*] or [name="…"])`;
    else what = `${prefix} has no "${key}"`;
    const dym = suggestions && suggestions.length ? ` Did you mean ${suggestions.join(' or ')}?` : '';
    const has = here && here.length ? ` ${reason === 'key-on-list' ? 'Its entries have' : `${prefix} has`}: ${here.join(', ')}${more ? `, …+${more}` : ''}.` : '';
    return `"${path}" does not resolve: ${what}.${dym}${has}`;
}

/**
 * Check one ref path (tokens, already normalised) the AI bound.
 *
 * Returns { tokens, fixes: [why…], advice?, problem? }. `fixes` name every
 * rewrite; `advice` is said without rewriting anything (an index into a
 * name/value list); a problem with `sure` refuses the binding, one without
 * is a warning.
 * Roots other than steps.<id> and trigger are not this module's business
 * (loop.<var> is checked against its forEach by outputFields.checkLoopRef).
 *
 * opts: { draftWrap, wantList }
 */
function checkRefTokens(graph, tokens, opts = {}) {
    if (!Array.isArray(tokens) || !tokens.length) return { tokens, fixes: [] };
    const head = tokens[0].key;
    const fixes = [];
    let cur = tokens;
    if (head === 'steps' && cur.length >= 3 && cur[1].type === 'prop' && cur[2].type === 'prop' && !STEP_RESULT_KEYS.has(String(cur[2].key))) {
        cur = splice(cur, 2, 0, { type: 'prop', key: 'output' });
        fixes.push('a step\'s data sits under .output');
    } else if (head === 'trigger' && cur.length >= 2 && cur[1].type === 'prop' && !TRIGGER_TOP_KEYS.has(String(cur[1].key))) {
        cur = splice(cur, 1, 0, { type: 'prop', key: 'output' });
        fixes.push('the trigger\'s data sits under trigger.output');
    }
    const root = rootFor(graph, cur, opts.draftWrap);
    if (!root || root.node.t === 'any') return { tokens: cur, fixes };
    const res = checkAgainst(root.node, cur, root.from, opts);
    return {
        tokens: res.tokens,
        fixes: [...fixes, ...res.fixes.map(f => f.why).filter(Boolean)],
        ...(res.advice ? { advice: res.advice } : {}),
        ...(res.problem ? { problem: res.problem } : {}),
    };
}

module.exports = {
    STEP_RESULT_KEYS,
    TRIGGER_TOP_KEYS,
    ENVELOPE_KEYS,
    toolOutputShape,
    stepOutputShape,
    triggerOutputShape,
    shapeAtRef,
    rememberStepShape,
    checkAgainst,
    checkRefTokens,
    describeProblem,
    schemaShape,
};
