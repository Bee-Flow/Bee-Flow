/**
 * Iteration: what a Loop, an expanded loop's "Each item" pill and a
 * `step.forEach` offer, and the one inference all three rest on: resolving an
 * `overRef` to the shape of ONE element of the array it points at.
 *
 * The describers must agree, because the same step is authorable from the
 * canvas and from the inspector, and a path that works on one surface and
 * not the other is indistinguishable from a broken binding.
 */
import { walkPath } from '../legacy.mjs';
import { WILD, formatPath, isPrefix, isWild, parseLegacyPath } from '../source.mjs';
import { fieldsFromSample, makeNode, shapeOfSample } from '../fields.mjs';
import { humanizeKey, itemNoun } from '../label.mjs';
import { manyItems, walkSource } from '../walk.mjs';
import { sourceProblems } from '../validate.mjs';
import { groupLabel } from './env.mjs';
import { fieldAt, loopBase, stepBase } from './sampleFields.mjs';

/**
 * Does this step run once per item, the older way (`step.forEach`) or the
 * new one (`step.repeat`)? Either way its output is the fan-out envelope
 * `{ iterations, succeeded, failed, results: [{ index, item, output, status }] }`
 * (server execRepeat.js), never its flat tool output.
 */
export function runsPerItem(node) {
    return !!(node && ((node.forEach && node.forEach.overRef) || (node.repeat && node.repeat.over)));
}

function isPlainObject(v) {
    return v !== null && typeof v === 'object' && !Array.isArray(v);
}

/**
 * A field for a value seen once per element of an outer `[*]`: its path
 * flattens over every element, so its sample is the list it resolves to
 * (`[v]`), while its children are the element value's own keys, reached
 * through the same flatten (`results[*].output.organizer.email`).
 * `perIteration` marks a value that is one scalar per element, which
 * auto-map must not bind into a scalar input.
 */
export function flatField(base, segs, v, { perIteration = false } = {}) {
    const f = fieldAt(base, segs, v);
    if (!f) return null;
    const sample = Array.isArray(v) ? v : [v];
    const out = { ...f, sample, shape: shapeOfSample(sample), count: sample.length };
    if (perIteration && !Array.isArray(v)) out.perIteration = true;
    return out;
}

/**
 * A Loop seen from DOWNSTREAM. After the loop finishes the `loop.<itemVar>`
 * scope no longer exists: the runtime output is execLoop's envelope
 * `{ iterations, results: [{ index, item, output }] }`, where `output` is
 * what the body's LAST step produced (execFlow.js) and `item` is one element,
 * or a slice of `batchSize` elements.
 *
 * So the element's fields are offered as `results[*].item.<key>`, or
 * `results[*].item[*].<key>` for a batched loop (`.name` on a slice resolves
 * to nothing), and what the body produced as `results[*].output.<key>`.
 * `bodySample` is the sample of the runner's `lastOutput`: the last body
 * step that is not a Wait, in its forEach envelope when it iterates
 * (describeNode works it out; undefined when unknown).
 */
export function describeLoop(node, toolToOutput, definition, sampleRoot = null, env, bodySample = undefined) {
    const itemVar = node.itemVar || 'item';
    const batched = Math.max(1, Number(node.batchSize) || 1) > 1;
    const elementSample = inferLoopItemSample(node.overRef, definition, toolToOutput, sampleRoot);
    const base = stepBase(node.id);
    const item = elementSample || {};
    const output = bodySample === undefined ? {} : bodySample;
    const sample = {
        iterations: 0,
        results: [{ index: 0, item: batched ? [item] : item, output }],
    };
    const itemSegs = batched ? ['results', WILD, 'item', WILD] : ['results', WILD, 'item'];
    const itemFields = isPlainObject(elementSample)
        ? Object.entries(elementSample).map(([k, v]) => flatField(base, [...itemSegs, k], v))
        : [];
    const outputFields = isPlainObject(output)
        ? Object.entries(output).map(([k, v]) => flatField(base, ['results', WILD, 'output', k], v))
        : [];
    const results = fieldAt(base, ['results'], sample.results);
    // The envelope's rows are offered flattened above; `results` itself
    // stays one value (the whole list), not a second copy of the same tree.
    delete results.children;
    return {
        id: node.id,
        label: node.label || groupLabel(env, 'loop_named', 'Loop ({name})', { name: itemVar }),
        kind: 'loop',
        basePath: base.text,
        sample,
        fields: [
            fieldAt(base, ['iterations'], 0),
            results,
            ...itemFields,
            ...outputFields,
        ].filter(Boolean),
    };
}

/**
 * Re-shape an upstream group whose node iterates (`step.forEach` or
 * `step.repeat`). The runtime output is the `{ iterations, succeeded, failed,
 * results }` envelope (execRepeat.js), so every per-iteration field becomes a
 * flattened `…output.results[*].output.<key>`, with its nested keys kept
 * (`results[*].output.organizer.email`), and the run counters are surfaced.
 *
 * A scalar's sample is wrapped to `[value]`, which is what the path actually
 * yields (one entry per iteration), and `perIteration` keeps auto-map and the
 * loop-source guess off it.
 */
export function wrapGroupForEach(group, node) {
    if (!group || !runsPerItem(node)) return group;
    const base = stepBase(node.id);
    const flat = group.sample || {};
    const isObject = flat !== null && typeof flat === 'object' && !Array.isArray(flat);
    // A step whose output is one value (a raw AI answer) offers that value,
    // per iteration, as a whole.
    const flattened = (isObject
        ? Object.entries(flat).map(([k, v]) => flatField(base, ['results', WILD, 'output', k], v, { perIteration: true }))
        : [flatField(base, ['results', WILD, 'output'], flat, { perIteration: true })]
    ).filter(Boolean);
    const counters = ['iterations', 'succeeded', 'failed'].map(k => fieldAt(base, [k], 0));
    return {
        ...group,
        forEach: true,
        sample: { iterations: 0, succeeded: 0, failed: 0, results: [{ index: 0, item: {}, output: flat, status: 'success' }] },
        fields: [...counters, ...flattened],
    };
}

/** A name inside a sentence: "Orderregel" → "orderregel", but "IBAN" stays. */
function lowerFirst(text) {
    if (/^[A-Z]{2}/.test(text)) return text;
    return text.charAt(0).toLowerCase() + text.slice(1);
}

/** "Current order line": the current item, named after its list. */
function currentItemLabel(env, noun) {
    return noun
        ? groupLabel(env, 'current_item_named', 'Current {item}', { item: lowerFirst(noun) })
        : groupLabel(env, 'current_item_plain', 'Current item');
}

/**
 * Per-item loop variable for a step that iterates over an upstream array
 * (`step.forEach`), surfaced for the iterating step itself: its values are
 * `loop.<itemVar>.*` refs. Named after the list ("Current order line"),
 * else after the item variable. `currentItem` says what the group is
 * (`take: 'loop'`: picks of it are plain refs of the loop variable).
 */
export function describeForEachItem(step, definition, toolToOutput, sampleRoot = null, env) {
    const fe = step.forEach || {};
    const itemVar = fe.itemVar || 'item';
    const sample = inferLoopItemSample(fe.overRef, definition, toolToOutput, sampleRoot) || {};
    const over = typeof fe.overRef === 'string' ? parseLegacyPath(fe.overRef.trim()) : null;
    const noun = itemNoun(over) || humanizeKey(itemVar) || null;
    return {
        id: `${step.id}__foreach`,
        label: currentItemLabel(env, noun),
        kind: 'loop',
        basePath: `loop.${itemVar}`,
        sample,
        currentItem: { take: 'loop', itemVar, noun },
        fields: fieldsFromSample(sample, loopBase(itemVar)),
    };
}

/**
 * The current item of a step that runs once per item the v2 way
 * (`step.repeat = { over }`), for that step itself: every value of ONE item
 * of the list, each a pick with `take: 'each'` of the list's Source plus the
 * path inside the item (what repeat.mjs toggleRepeat writes, and what
 * execRepeat reads per item). A list of plain values offers the item itself.
 *
 * Not part of computeUpstreamGroups: its legacy paths (`<list>[*].email`)
 * read the WHOLE list as a ref, so only a surface that stores the pick (the
 * source panel, with the value slots) may offer it.
 *
 * The item's shape comes from `sampleRoot` (real or pinned data first),
 * else from the list's catalog sample. Null when the step does not repeat
 * over a valid Source.
 */
export function describeRepeatItem(step, definition, toolToOutput, sampleRoot = null, env) {
    const over = step && step.repeat ? step.repeat.over : null;
    if (!over || sourceProblems(over).length) return null;
    const listPath = formatPath(over);
    if (!listPath) return null;
    const source = { root: over.root, ...(over.id !== undefined ? { id: over.id } : {}), path: [...over.path] };
    const element = repeatElement(source, sampleRoot) ?? inferLoopItemSample(listPath, definition, toolToOutput, sampleRoot);
    const noun = itemNoun(source);
    const base = { source, text: `${listPath}[*]`, rel: [] };
    const each = { take: 'each' };
    let fields = [];
    if (isPlainObject(element)) fields = fieldsFromSample(element, base, each);
    else if (element !== undefined && element !== null && !Array.isArray(element)) fields = [makeNode(base, noun || 'item', element, each)];
    return {
        id: `${step.id}__repeat`,
        label: currentItemLabel(env, noun),
        kind: 'loop',
        basePath: base.text,
        sample: element ?? {},
        currentItem: { take: 'each', over: source, noun },
        fields,
    };
}

/** The first item of the list `over` in the sample root, read the way execRepeat reads it. */
function repeatElement(over, sampleRoot) {
    if (!sampleRoot || typeof sampleRoot !== 'object') return undefined;
    const { items } = manyItems(walkSource(over, sampleRoot));
    return items.find(isPlainObject) ?? items.find(v => v !== undefined && v !== null && typeof v !== 'object');
}

/**
 * The name of the item a value is read from, when it is the current item of
 * the step (a group's `currentItem`): "Orderregel" for an `each` pick under
 * the list, or a `loop.<itemVar>` ref of a forEach. Null otherwise.
 * @param {object|null|undefined} source — a v2 Source
 * @param {{ take?: string, over?: object|null, itemVar?: string, noun?: string|null } | null | undefined} currentItem
 */
export function currentItemNoun(source, currentItem) {
    if (!source || !currentItem || !currentItem.noun) return null;
    if (currentItem.take === 'loop') return source.root === 'loop' && source.id === currentItem.itemVar ? currentItem.noun : null;
    if (currentItem.take === 'each') return currentItem.over && isPrefix(currentItem.over, source) ? currentItem.noun : null;
    return null;
}

/** The group a loop's body sees as its current item: `loop.<itemVar>`. */
export function loopItemGroup(id, itemVar, batchSize, elementSample, env) {
    // execLoop binds a SLICE when batchSize > 1, not a single element, so
    // there is no single-item field list to offer: `loop.<var>.name` would
    // resolve to nothing.
    const batched = Math.max(1, Number(batchSize) || 1) > 1;
    const element = elementSample || {};
    return {
        id,
        label: batched
            ? groupLabel(env, 'current_batch', 'Current batch (loop.{name})', { name: itemVar })
            : groupLabel(env, 'current_item', 'Current item (loop.{name})', { name: itemVar }),
        kind: 'loop',
        basePath: `loop.${itemVar}`,
        sample: batched ? [element] : element,
        fields: (batched || !isPlainObject(element)) ? [] : fieldsFromSample(element, loopBase(itemVar)),
    };
}

/**
 * The "Each item" pill at the head of an EXPANDED loop (canvas only). It is
 * what the body's steps read from, so it describes the same thing
 * computeLoopBodyGroups offers the inspector's list editor.
 */
export function describeLoopItem(node, definition, toolToOutput, sampleRoot = null, env) {
    const itemVar = node.itemVar || 'item';
    const element = inferLoopItemSample(node.overRef, definition, toolToOutput, sampleRoot);
    return loopItemGroup(node.id, itemVar, node.batchSize, element, env);
}

/**
 * Resolve an `overRef` like `steps.s1.output.results` to the element
 * shape: the first item of that array, from the accumulated sample root when
 * it resolves there, else from the source step's catalog sample. Null when
 * the path cannot be resolved.
 */
export function inferLoopItemSample(overRef, definition, toolToOutput, sampleRoot = null) {
    if (typeof overRef !== 'string' || !overRef) return null;
    // The accumulated design-time sample root covers EVERY upstream node
    // type (collection ops, set, ai_step…), not just integration actions.
    if (sampleRoot) {
        const arr = walkPath(overRef.trim(), sampleRoot);
        if (Array.isArray(arr) && arr.length > 0) {
            const el = arr[0];
            if (isPlainObject(el)) return el;
        }
    }
    const source = parseLegacyPath(overRef.trim());
    if (!source || source.root !== 'steps') return null;
    const node = (definition?.steps || []).find(s => s.id === source.id);
    if (!node) return null;
    const meta = toolToOutput?.get?.(node.tool);
    if (meta?.sample == null) return null;
    // When the source step iterates, its real output is the forEach envelope:
    // resolve the path (incl. `[*]`) against that wrapped shape so
    // `…results[*].output.<arr>` lands on the element, not undefined.
    let cur = runsPerItem(node)
        ? { iterations: 0, succeeded: 0, failed: 0, results: [{ index: 0, item: {}, output: meta.sample, status: 'success' }] }
        : meta.sample;
    for (const seg of source.path) {
        if (cur == null) return null;
        if (isWild(seg)) cur = Array.isArray(cur) ? cur[0] : null;
        else if (typeof seg === 'number') cur = Array.isArray(cur) ? cur[seg] : null;
        else cur = (cur && typeof cur === 'object') ? cur[seg] : undefined;
    }
    if (cur == null) return null;
    if (Array.isArray(cur)) return cur.length > 0 ? cur[0] : null;
    return isPlainObject(cur) ? cur : null;
}

/**
 * Loosely singularise an array key into a loop/item variable name
 * (`results` → `result`, `categories` → `category`).
 */
export function suggestItemVar(key) {
    const s = String(key || '').trim();
    if (!s) return 'item';
    if (/ies$/.test(s)) return s.slice(0, -3) + 'y';
    if (/(s|es)$/.test(s) && s.length > 2) return s.replace(/(es|s)$/, '');
    return s;
}
