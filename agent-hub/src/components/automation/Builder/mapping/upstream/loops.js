/**
 * Iteration: what a Loop, an expanded loop's "Each item" pill and a
 * `step.forEach` offer, and the one inference all three rest on — resolving an
 * `overRef` to the shape of ONE element of the array it points at.
 *
 * The three describers must agree, because the same step is authorable from
 * the canvas and from the inspector, and a path that works on one surface and
 * not the other is indistinguishable from a broken binding.
 *
 * Every path is written with the runtime grammar's own writer (appendKey), so
 * an item key such as `Story Points`, `@odata.etag` or `line-items` is offered
 * as `["Story Points"]` — the spelling the run resolves — not as a dotted
 * segment the runtime rejects.
 */
import { appendKey, appendWildcard, getPath, parsePath, walkTokens } from '@shared/expr/path.mjs';
import { describeNode } from './describeNode';
import { forEachOutputPath, perIterationField, rebaseFields } from './forEachShape';
import { sampleToFieldsReal } from './realOverlay';
import { sampleToFields } from './sampleFields';
import { asValue, firstItemOver, isRecord, mergeElementSamples } from '../deepFields';

export function describeLoop(node, toolToOutput, definition, sampleRoot = null) {
    const itemVar = node.itemVar || 'item';
    // DOWNSTREAM view (C23 + user report): after the loop finishes, the
    // `loop.<itemVar>` scope NO LONGER EXISTS — the runtime output is the
    // envelope { iterations, results: [{ index, item, output }] }. This
    // group used to offer `loop.<itemVar>.*` here, so a step wired AFTER the
    // loop could pick paths that always resolved undefined at run time (the
    // exact trap in the user's contains(loop.item.subject, …) screenshot).
    // The per-item `loop.<itemVar>` group still exists INSIDE the body
    // (computeLoopBodyGroups) and for forEach steps (describeForEachItem).
    //
    // Element fields are offered as `results[*].item.<key>` — the `[*]`
    // flatten resolves in bindings (bind.walkPath) and, since the wildcard
    // grammar fix, in expressions too.
    const elementSample = inferLoopItemSample(node.overRef, definition, toolToOutput, sampleRoot);
    const base = `steps.${node.id}.output`;
    const resultsPath = appendKey(base, 'results');
    const itemBase = appendKey(appendWildcard(resultsPath), 'item');
    // What each iteration PRODUCED: execLoop records the body's last output
    // as `results[i].output`, so a step after the loop can collect "the
    // subject each read returned" — the body is described like any step.
    const body = describeBodyOutput(node, definition, toolToOutput, sampleRoot);
    const outBase = forEachOutputPath(base);
    const sample = {
        iterations: 0,
        results: [{ index: 0, item: elementSample || {}, output: body ? body.sample : {} }],
    };
    const itemFields = isRecord(elementSample)
        ? Object.entries(elementSample).map(([k, v]) => ({
            key: k,
            path: appendKey(itemBase, k),
            sample: Array.isArray(v) ? v : [v],
        }))
        : [];
    const outputFields = body ? rebaseFields(body.fields || [], body.basePath, outBase).map(perIterationField) : [];
    return {
        id: node.id,
        label: node.label || `Loop (${itemVar})`,
        kind: 'loop',
        basePath: base,
        sample,
        fields: [
            { key: 'iterations', path: appendKey(base, 'iterations'), sample: 0 },
            { key: 'results', path: resultsPath, sample: sample.results },
            ...itemFields,
            ...outputFields,
        ],
    };
}

/**
 * The group of the body step whose output each iteration records (the last
 * one that runs: not a note, not a wait — runDag's lastOutput), shaped the way
 * the runner hands it on (a per-item body step is its forEach envelope).
 * Null for an empty body or a step nothing describes.
 */
function describeBodyOutput(loopNode, definition, toolToOutput, sampleRoot) {
    const body = Array.isArray(loopNode.body) ? loopNode.body : [];
    const last = [...body].reverse().find(s => s && s.type !== 'note' && s.type !== 'wait');
    if (!last) return null;
    const g = describeNode(last, definition, toolToOutput, {}, sampleRoot, null);
    if (!g || !g.basePath) return null;
    if (!last.forEach || !last.forEach.overRef) return g;
    const outBase = forEachOutputPath(g.basePath);
    return {
        ...g,
        sample: { iterations: 0, succeeded: 0, failed: 0, results: [{ index: 0, item: {}, output: g.sample || {}, status: 'success' }] },
        fields: [
            { key: 'iterations', path: appendKey(g.basePath, 'iterations'), sample: 0 },
            { key: 'succeeded', path: appendKey(g.basePath, 'succeeded'), sample: 0 },
            { key: 'failed', path: appendKey(g.basePath, 'failed'), sample: 0 },
            ...rebaseFields(g.fields || [], g.basePath, outBase).map(perIterationField),
        ],
    };
}

/**
 * Per-item loop variable for a step that iterates over an upstream array
 * (`step.forEach`). Mirrors describeLoop but reads the step's own forEach
 * config — surfaced for the iterating step itself, not a downstream node.
 * `ownItem` marks it as the step's own: it is never a list source for that
 * same step (LoopOverPicker), because it does not exist yet when the list is
 * read.
 */
export function describeForEachItem(step, definition, toolToOutput, sampleRoot = null) {
    const fe = step.forEach || {};
    const itemVar = fe.itemVar || 'item';
    const item = inferLoopItem(fe.overRef, definition, toolToOutput, sampleRoot);
    const sample = item?.value || {};
    return {
        id: `${step.id}__foreach`,
        label: `Current item (${itemVar})`,
        kind: 'loop',
        basePath: `loop.${itemVar}`,
        ownItem: true,
        sample,
        // A list of records inside the item (a mail's attachments) offers its
        // columns (`attachments[*].attachmentId`): dragging one moves the step
        // to that list (deepenForEach.ts). Without them there was nothing to drag.
        fields: itemFields(item, `loop.${itemVar}`, sampleToFieldsReal),
    };
}

/**
 * The outer items a step over a list INSIDE a list keeps (`forEach.parents`,
 * outermost first — see deepenForEach.ts and the runner's forEachScope.js):
 * the email each attachment came from stays `loop.result`. One group per
 * parent, to be listed before the step's own item.
 */
export function describeForEachParents(step, definition, toolToOutput, sampleRoot = null) {
    const fe = step.forEach || {};
    const parents = Array.isArray(fe.parents) ? fe.parents : [];
    const out = [];
    for (const p of parents) {
        if (!p || typeof p.itemVar !== 'string' || !p.itemVar || p.itemVar === fe.itemVar || typeof p.overRef !== 'string') continue;
        const item = inferLoopItem(p.overRef, definition, toolToOutput, sampleRoot);
        const sample = item?.value || {};
        out.push({
            id: `${step.id}__parent_${p.itemVar}`,
            label: `Outer item (${p.itemVar})`,
            kind: 'loop',
            basePath: `loop.${p.itemVar}`,
            ownItem: true,
            sample,
            fields: itemFields(item, `loop.${p.itemVar}`, sampleToFieldsReal),
        });
    }
    return out;
}

/**
 * The "Each item" pill at the head of an EXPANDED loop (canvas only — see
 * flow/inlineFlowlets.js). It is what the body's steps read from, so it has to
 * describe the same thing computeLoopBodyGroups offers the inspector's list
 * editor: `loop.<itemVar>`, resolved against the loop's own source.
 *
 * The two must agree — the same step is authorable from both surfaces, and a
 * path that works in one and not the other would be indistinguishable from a
 * broken binding. Hence the shared `inferLoopItemSample` / `sampleToFields`
 * pair, and hence the batch rule below.
 */
export function describeLoopItem(node, definition, toolToOutput, sampleRoot = null) {
    const itemVar = node.itemVar || 'item';
    const batchSize = Math.max(1, Number(node.batchSize) || 1);
    const item = inferLoopItem(node.overRef, definition, toolToOutput, sampleRoot);
    const elementSample = item?.value || {};
    const isPlainObject = isRecord(elementSample);
    // execLoop binds a SLICE when batchSize > 1, not a single element, so there
    // is no single-item field list to offer — `loop.<var>.name` would resolve to
    // nothing. Same rule as computeLoopBodyGroups.
    const batched = batchSize > 1;
    return {
        id: node.id,
        label: batched ? `Current batch (loop.${itemVar})` : `Current item (loop.${itemVar})`,
        kind: 'loop',
        basePath: `loop.${itemVar}`,
        sample: batched ? [elementSample] : elementSample,
        fields: (batched || !isPlainObject) ? [] : itemFields(item, `loop.${itemVar}`, sampleToFields),
    };
}

/**
 * ONE item of a list, in its two roles: `value` is the item a preview shows
 * (the first, as the run's first iteration binds it; deepFields
 * firstItemOver), `shape` the union of the rows' keys the fields are built
 * from, so a field only row 2 has is still offered. A record that is not in
 * a list is both. Null when there is no record to stand for the list.
 */
function itemOf(v) {
    if (Array.isArray(v)) {
        const shape = mergeElementSamples(v);
        return isRecord(shape) ? { value: firstItemOver(v, shape), shape } : null;
    }
    return isRecord(v) ? { value: v, shape: v } : null;
}

/**
 * The item's fields: built from its SHAPE, each field that names one place in
 * the item showing the item's OWN value there, so the field rows, the binding
 * preview and the "1 of N" pill all describe the same item. A column
 * (`attachments[*].id`) keeps the shape's sample: one value standing for its rows.
 */
function itemFields(item, basePath, build) {
    if (!item) return [];
    const fields = build(item.shape, basePath);
    return item.value === item.shape ? fields : resampled(fields, item.value, basePath);
}

/**
 * The fields of a list's current item (see itemOf and itemFields), for the
 * Loop body editor's "Current item" group. [] when the list holds no records.
 */
export function listItemFields(list, basePath) {
    const arr = asValue(list);
    return Array.isArray(arr) ? itemFields(itemOf(arr), basePath, sampleToFields) : [];
}

function resampled(fields, value, basePath) {
    const depth = (parsePath(basePath) || []).length;
    return fields.map((f) => {
        const rest = (parsePath(f.path) || []).slice(depth);
        const own = rest.length && !rest.some(t => t.type === 'wild') ? walkTokens(rest, value) : undefined;
        const out = own === undefined ? { ...f } : { ...f, sample: own };
        if (f.children) out.children = resampled(f.children, value, basePath);
        return out;
    });
}

/**
 * Resolve an `overRef` like `steps.s1.output.results` to ONE item of the
 * list (see itemOf), from the accumulated sample root first, then from the
 * source step's catalog sample. Null when the path can't be resolved (the
 * item then has no usable sample). Paths are read with the runtime grammar
 * (`["line-items"]`, `[*]` flatten, JSON text), so what this resolves is what
 * the run iterates.
 */
function inferLoopItem(overRef, definition, toolToOutput, sampleRoot = null) {
    if (typeof overRef !== 'string' || !overRef.trim()) return null;
    // Prefer the accumulated design-time sample root — it covers EVERY
    // upstream node type (collection ops, set, ai_step…), not just
    // integration actions. e.g. Loop over `steps.filter1.output.items`
    // finally shows the item fields.
    const arr = sampleRoot ? getPath(sampleRoot, overRef.trim()) : undefined;
    const fromRoot = Array.isArray(arr) && arr.length > 0 ? itemOf(arr) : null;
    return fromRoot || itemFromCatalog(overRef.trim(), definition, toolToOutput);
}

/**
 * The item a list is previewed by: its first element as the run's first
 * iteration binds it, with the keys only later rows have filled in (a field
 * only row 2 has, a list that starts with null, still shows). Null when the
 * path can't be resolved.
 * @param {unknown} overRef
 * @param {any} definition
 * @param {any} toolToOutput
 * @param {unknown} [sampleRoot]
 * @returns {Record<string, unknown>|null}
 */
export function inferLoopItemSample(overRef, definition, toolToOutput, sampleRoot = null) {
    return inferLoopItem(overRef, definition, toolToOutput, sampleRoot)?.value ?? null;
}

/** The item of a list in an integration step's catalog sample (no run, no pin). */
function itemFromCatalog(overRef, definition, toolToOutput) {
    const tokens = parsePath(overRef);
    if (!tokens || tokens.length < 3 || tokens[0].key !== 'steps' || tokens[2].key !== 'output') return null;
    const node = (definition?.steps || []).find(s => s.id === tokens[1].key);
    const meta = node ? toolToOutput?.get?.(node.tool) : null;
    if (meta?.sample == null) return null;
    // When the source step iterates, its real output is the forEach envelope
    // — resolve the path (incl. `[*]` flatten) against that wrapped shape so
    // `…results[*].output.<arr>` lands on the element, not undefined.
    const root = node.forEach?.overRef
        ? { iterations: 0, succeeded: 0, failed: 0, results: [{ index: 0, item: {}, output: meta.sample, status: 'success' }] }
        : meta.sample;
    return itemOf(walkTokens(tokens.slice(3), root));
}

const RESERVED_VARS = new Set(['true', 'false', 'null', '_index']);

/**
 * Name ONE item of a list after the list (`results` → `result`, `categories`
 * → `category`). Shared by the Loop picker, the forEach inspector section,
 * auto-map's iteration detection and the deepen move.
 *
 * Always an identifier: the name becomes `loop.<name>`, and a key such as
 * `line-items`, `Line Items` or `@odata.items` would give `loop.line-item`,
 * which the runtime reads as nothing. Such a key becomes `line_item`.
 * @param {unknown} key
 * @returns {string}
 */
export function suggestItemVar(key) {
    const s = String(key ?? '').trim();
    if (!s) return 'item';
    const words = s.split(/[^A-Za-z0-9_]+/).filter(Boolean);
    if (!words.length) return 'item';
    const plain = words.length === 1 && words[0] === s;
    const last = singular(words[words.length - 1]);
    let name = plain ? last : [...words.slice(0, -1), last].join('_').toLowerCase();
    name = name.replace(/^_+|_+$/g, '') || 'item';
    if (/^[0-9]/.test(name)) name = `item_${name}`;
    return RESERVED_VARS.has(name) ? 'item' : name;
}

function singular(s) {
    if (/ies$/.test(s)) return s.slice(0, -3) + 'y'; // "categories" → "category"
    // "-es" is a plural ending only after s/x/z/ch/sh ("addresses", "boxes",
    // "matches"); elsewhere the "e" belongs to the word: "lines" → "line",
    // not "lin". Words that merely end in s ("status", "address") stay.
    if (/(ss|x|z|ch|sh)es$/.test(s)) return s.slice(0, -2);
    if (/(ss|us|is)$/.test(s)) return s;
    if (/s$/.test(s) && s.length > 2) return s.slice(0, -1);
    return s;
}

/**
 * `name`, or `name_item`, `name_2`, … — the first that `taken` does not hold.
 * @param {string} name
 * @param {Array<string|null|undefined>} [taken]
 * @returns {string}
 */
export function uniqueItemVar(name, taken = []) {
    const used = new Set(taken.filter(Boolean));
    if (!used.has(name)) return name;
    if (!used.has(`${name}_item`)) return `${name}_item`;
    for (let i = 2; ; i++) if (!used.has(`${name}_${i}`)) return `${name}_${i}`;
}

/** The last key of a path (`steps.o.output["line-items"]` → `line-items`): fieldTree's, one copy. */
export { lastPathKey } from './fieldTree';
