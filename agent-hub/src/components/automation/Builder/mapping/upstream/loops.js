/**
 * Iteration: what a Loop, an expanded loop's "Each item" pill and a
 * `step.forEach` offer, and the one inference all three rest on — resolving an
 * `overRef` to the shape of ONE element of the array it points at.
 *
 * The three describers must agree, because the same step is authorable from
 * the canvas and from the inspector, and a path that works on one surface and
 * not the other is indistinguishable from a broken binding.
 */
import { walkPath } from '../../../../../utils/bindingHelpers';
import { sampleToFields } from './sampleFields';

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
    const sample = {
        iterations: 0,
        results: [{ index: 0, item: elementSample || {}, output: {} }],
    };
    const itemFields = elementSample && typeof elementSample === 'object' && !Array.isArray(elementSample)
        ? Object.entries(elementSample).map(([k, v]) => ({
            key: k,
            path: `${base}.results[*].item.${k}`,
            sample: Array.isArray(v) ? v : [v],
        }))
        : [];
    return {
        id: node.id,
        label: node.label || `Loop (${itemVar})`,
        kind: 'loop',
        basePath: base,
        sample,
        fields: [
            { key: 'iterations', path: `${base}.iterations`, sample: 0 },
            { key: 'results', path: `${base}.results`, sample: sample.results },
            ...itemFields,
        ],
    };
}

/**
 * Per-item loop variable for a step that iterates over an upstream array
 * (`step.forEach`). Mirrors describeLoop but reads the step's own forEach
 * config — surfaced for the iterating step itself, not a downstream node.
 */
export function describeForEachItem(step, definition, toolToOutput, sampleRoot = null) {
    const fe = step.forEach || {};
    const itemVar = fe.itemVar || 'item';
    const elementSample = inferLoopItemSample(fe.overRef, definition, toolToOutput, sampleRoot);
    const sample = elementSample || {};
    return {
        id: `${step.id}__foreach`,
        label: `Current item (${itemVar})`,
        kind: 'loop',
        basePath: `loop.${itemVar}`,
        sample,
        fields: sampleToFields(sample, `loop.${itemVar}`),
    };
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
    const elementSample = inferLoopItemSample(node.overRef, definition, toolToOutput, sampleRoot) || {};
    const isPlainObject = elementSample && typeof elementSample === 'object' && !Array.isArray(elementSample);
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
        fields: (batched || !isPlainObject) ? [] : sampleToFields(elementSample, `loop.${itemVar}`),
    };
}

/**
 * Resolve an `overRef` like `steps.s1.output.results` to the element
 * shape — first item of that array in the source step's outputSample.
 * Returns null when the path can't be resolved (loop's item then has
 * no usable sample).
 */
export function inferLoopItemSample(overRef, definition, toolToOutput, sampleRoot = null) {
    if (typeof overRef !== 'string' || !overRef) return null;
    // Prefer the accumulated design-time sample root — it covers EVERY
    // upstream node type (collection ops, set, ai_step…), not just
    // integration actions. e.g. Loop over `steps.filter1.output.items`
    // finally shows the item fields.
    if (sampleRoot) {
        const arr = walkPath(overRef.trim(), sampleRoot);
        if (Array.isArray(arr) && arr.length > 0) {
            const el = arr[0];
            if (el && typeof el === 'object' && !Array.isArray(el)) return el;
        }
    }
    const m = /^steps\.([^.]+)\.output(?:\.(.+))?$/.exec(overRef);
    if (!m) return null;
    const stepId = m[1];
    const rest = m[2] || '';
    const node = (definition.steps || []).find(s => s.id === stepId);
    if (!node) return null;
    const meta = toolToOutput.get(node.tool);
    if (meta?.sample == null) return null;
    // When the source step iterates, its real output is the forEach envelope
    // — resolve the path (incl. `[*]` flatten) against that wrapped shape so
    // `…results[*].output.<arr>` lands on the element, not undefined.
    const root = node?.forEach?.overRef
        ? { iterations: 0, succeeded: 0, failed: 0, results: [{ index: 0, item: {}, output: meta.sample, status: 'success' }] }
        : meta.sample;
    let cur = root;
    for (const seg of (rest ? rest.split('.') : [])) {
        if (cur == null) return null;
        const isWild = /\[\*\]$/.test(seg);
        const idxMatch = /\[(\d+)\]$/.exec(seg);
        const key = seg.replace(/\[(?:\*|\d+)\]$/, '');
        if (key) cur = (cur && typeof cur === 'object') ? cur[key] : undefined;
        if (cur == null) return null;
        if (isWild) cur = Array.isArray(cur) ? cur[0] : null;
        else if (idxMatch) cur = Array.isArray(cur) ? cur[Number(idxMatch[1])] : null;
    }
    if (Array.isArray(cur)) return cur.length > 0 ? cur[0] : null;
    return (cur && typeof cur === 'object') ? cur : null;
}

/**
 * Loosely singularise an array key into a loop/item variable name
 * (`results` → `result`, `categories` → `category`). Shared by the Loop
 * picker, the forEach inspector section, and auto-map iteration detection.
 */
export function suggestItemVar(key) {
    const s = String(key || '').trim();
    if (!s) return 'item';
    if (/ies$/.test(s)) return s.slice(0, -3) + 'y'; // "categories" → "category"
    // "-es" is a plural ending only after s/x/z/ch/sh ("addresses", "boxes",
    // "matches"); elsewhere the "e" belongs to the word: "lines" → "line",
    // not "lin". Words that merely end in s ("status", "address") stay.
    if (/(ss|x|z|ch|sh)es$/.test(s)) return s.slice(0, -2);
    if (/(ss|us|is)$/.test(s)) return s;
    if (/s$/.test(s) && s.length > 2) return s.slice(0, -1);
    return s;
}
