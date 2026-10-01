/**
 * The sample → field vocabulary every describer in this folder shares, in
 * the shape the builder's pickers have always read (`{key, path, sample,
 * children}`), now as SourceNodes (../fields.mjs).
 *
 * Paths are written by source.mjs formatSegment, THE one quoting rule: the
 * describers used to concatenate `.${key}` in some places and quote with
 * JSON.stringify in others, so `Order date`, `line-items` or `a"b` gave a
 * path the preview resolved and the run rejected.
 */
import { walkPath } from '../legacy.mjs';
import { formatSegment } from '../source.mjs';
import { baseOf, childBase, fieldsFromSample, nodeTree } from '../fields.mjs';

/**
 * One object key appended to a legacy path, in canonical spelling: `.key`
 * for an identifier, `["a key"]` (or `['a"key']`) otherwise. Null when the
 * grammar cannot write the key at all.
 */
export const seg = (k) => formatSegment(String(k));

/** The base a step's fields hang from: `steps.<id>.output`. */
export function stepBase(id) {
    return { source: { root: 'steps', id: String(id), path: [] }, text: `steps.${id}.output`, rel: [] };
}

/** The base of the trigger payload: `trigger.output`. */
export const TRIGGER_BASE = Object.freeze({ source: Object.freeze({ root: 'trigger', path: Object.freeze([]) }), text: 'trigger.output', rel: Object.freeze([]) });

/** The base of a loop item variable: `loop.<itemVar>`. */
export function loopBase(itemVar) {
    return { source: { root: 'loop', id: String(itemVar), path: [] }, text: `loop.${itemVar}`, rel: [] };
}

/**
 * The base `segs` further down from `base`, or null when a key in it cannot
 * be written.
 */
export function baseAt(base, segs) {
    let at = baseOf(base);
    for (const s of segs) {
        at = childBase(at, s);
        if (!at) return null;
    }
    return at;
}

/**
 * One curated field: a node at `segs` under `base`, with its own children
 * when its sample has any. Null when a key cannot be written.
 */
export function fieldAt(base, segs, sample, extra = {}) {
    const at = baseAt(base, segs);
    if (!at) return null;
    const last = segs[segs.length - 1];
    return nodeTree(at, typeof last === 'string' ? last : String(last ?? ''), sample, extra);
}

/**
 * Translate a sample object into fields under a legacy base path. Kept for
 * the editors that build a field list from a sample of their own (route and
 * Set editors, the output view); the describers use fieldsFromSample with a
 * structured base.
 */
export function sampleToFields(sample, basePath) {
    return fieldsFromSample(sample, String(basePath ?? ''));
}

/** A step group's fields: everything its sample holds, under `steps.<id>.output`. */
export function stepFields(node, sample) {
    return fieldsFromSample(sample, stepBase(node.id));
}

/** A describer's group for a step whose output lives at `steps.<id>.output`. */
export function stepGroup(node, label, kind, sample, fields) {
    return {
        id: node.id,
        label,
        kind,
        basePath: `steps.${node.id}.output`,
        sample,
        fields: fields ?? stepFields(node, sample),
    };
}

/**
 * Resolve an arrayRef path to the sample of ONE element of that array.
 * `sampleRoot` is either the accumulated design-time root (see
 * computeUpstreamGroups) or the editor's preview sample (which overlays real
 * last-run / pinned outputs). Null when the path doesn't resolve to a
 * non-empty array.
 */
export function resolveElementSample(arrayRef, sampleRoot) {
    if (typeof arrayRef !== 'string' || !arrayRef.trim() || !sampleRoot) return null;
    const v = walkPath(arrayRef.trim(), sampleRoot);
    if (!Array.isArray(v) || v.length === 0) return null;
    return v[0] ?? null;
}

/**
 * Top-level field options of an array element: the ONLY level the server's
 * collection ops can address (engine.js reads `item?.[step.field]`, so dotted
 * paths silently fail there). Feeds FieldKeyCombobox.
 */
export function elementFieldOptions(elementSample) {
    if (!elementSample || typeof elementSample !== 'object' || Array.isArray(elementSample)) return [];
    return Object.entries(elementSample).map(([key, sample]) => ({ key, sample }));
}

/**
 * Every ARRAY-valued path reachable from the upstream groups: top-level
 * fields, one nesting level (children), plus arrays that only exist in the
 * real-run/pinned overlay (previewSample) and not in the schema sample.
 * Returns [{ key, path, sample }].
 */
export function collectArrayPaths(groups, previewSample = null) {
    const out = [];
    const seen = new Set();
    const push = (key, path, sample) => {
        if (!path || seen.has(path)) return;
        seen.add(path);
        out.push({ key, path, sample });
    };
    for (const g of (groups || [])) {
        for (const f of (g.fields || [])) {
            if (Array.isArray(f.sample)) push(f.key, f.path, f.sample);
            for (const c of (f.children || [])) {
                if (Array.isArray(c.sample)) push(c.key, c.path, c.sample);
            }
        }
        if (previewSample && g.basePath) {
            const actual = walkPath(g.basePath, previewSample);
            if (actual && typeof actual === 'object' && !Array.isArray(actual)) {
                for (const [k, v] of Object.entries(actual)) {
                    const s = seg(k);
                    if (Array.isArray(v) && s !== null) push(k, `${g.basePath}${s}`, v);
                }
            }
        }
    }
    return out;
}

export { samplePlaceholderFor } from '../fields.mjs';
