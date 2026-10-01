/**
 * The steps that hand a COLLECTION downstream: the n8n-style list nodes.
 *
 * Filter, Limit, Dedupe, Aggregate and Summarize are collections by nature;
 * Set and Date & Time become one in their list mode; Parse JSON does in its
 * grouped mode. All of them emit the same `{ items, count }` wrapper, and
 * because fieldsFromSample opens a list of rows to its columns, the source
 * element's fields stay visible through it as `…output.items[*].<key>`,
 * escaped like any other key.
 */
import { walkPath, walkRelativePath } from '../legacy.mjs';
import { groupLabel, resolveEnv } from './env.mjs';
import { resolveElementSample, stepGroup } from './sampleFields.mjs';

function isPlainObject(v) {
    return v !== null && typeof v === 'object' && !Array.isArray(v);
}

/**
 * Set step output = the assembled fields object. Each field name becomes a
 * top-level bindable path; a binding is resolved against the accumulated
 * sample tree, so a Set field bound to an upstream list previews as that
 * list (and is offered to the Loop picker).
 */
export function describeSet(node, sampleRoot = null, env) {
    const e = resolveEnv(env);
    const label = node.label || groupLabel(e, 'set', 'Set');
    const entries = isPlainObject(node.fields) ? Object.entries(node.fields) : [];
    const resolveOne = (v, root = sampleRoot) => {
        if (v == null) return '<set>';
        if (typeof v !== 'object') return v; // bare literal: bind.js supports it
        if (v.kind === 'literal') return v.value ?? '<set>';
        if (v.kind === 'ref' && root) {
            const resolved = walkPath(String(v.path || ''), root);
            if (resolved !== undefined) return resolved;
        }
        if (v.kind === 'template' || v.kind === 'expr') return '<text>';
        return '<set>';
    };

    // LIST MODE: the runtime contract is `{items, count}` where every row is
    // the source element + the computed fields, reshaped by the operations
    // (server engine.js execSet). Mirror that fold on ONE sample row so
    // downstream pickers offer `items[*].<col>` with the POST-operations
    // column set.
    if (typeof node.arrayRef === 'string') {
        const element = resolveElementSample(node.arrayRef, sampleRoot);
        // Per-row scope: refs/previews resolve `item.*` (and `_index`).
        const rowRoot = { ...(sampleRoot || {}), item: element, _index: 0 };
        const added = Object.fromEntries(entries.map(([k, v]) => [k, resolveOne(v, rowRoot)]));
        const baseRow = isPlainObject(element) ? { ...element } : (element != null ? { value: element } : {});
        const row = e.applyOpsToSampleRow({ ...baseRow, ...added }, node.operations);
        const hasRow = Object.keys(row).length > 0;
        return stepGroup(node, label, 'set', { items: hasRow ? [row] : [], count: 0 });
    }

    const sample = Object.fromEntries(entries.map(([k, v]) => [k, resolveOne(v)]));
    return stepGroup(node, label, 'set', sample);
}

/**
 * parse_json output = a FLAT object { <fieldName>: value } (the runtime
 * contract, see server execParseJson). Design-time execution: each field's
 * relative path is resolved against the real sample when available, so
 * downstream previews show actual values; otherwise '<extracted>'
 * placeholders or the declared fallbacks. In grouped mode ("one row per
 * entry") the output is { items, count }, and the declared field names are
 * the row's columns.
 */
export function describeParseJson(node, sampleRoot = null, env) {
    const label = node.label || groupLabel(env, 'node.parse_json', 'Parse JSON');
    const fields = Array.isArray(node.fields) ? node.fields.filter(f => f && f.name) : [];
    let src;
    if (sampleRoot && node.sourceRef) {
        src = walkPath(node.sourceRef, sampleRoot);
        if (typeof src === 'string') { try { src = JSON.parse(src); } catch { src = undefined; } }
    }
    const itemsRef = typeof node.itemsRef === 'string' ? node.itemsRef.trim() : '';
    const rowFrom = (root) => Object.fromEntries(fields.map(f => {
        const v = root !== undefined ? walkRelativePath(f.path, root) : undefined;
        return [f.name, v !== undefined ? v : (f.fallback !== undefined ? f.fallback : '<extracted>')];
    }));
    if (itemsRef) {
        const arr = src !== undefined ? walkRelativePath(itemsRef, src) : undefined;
        const rows = Array.isArray(arr) ? arr.slice(0, 5).map(rowFrom) : [rowFrom(undefined)];
        return stepGroup(node, label, 'parse_json', { items: rows, count: Array.isArray(arr) ? arr.length : rows.length });
    }
    return stepGroup(node, label, 'parse_json', rowFrom(src));
}

export function describeDateTime(savedNode, sampleRoot = null, env) {
    const e = resolveEnv(env);
    // A whole column saved in "Input date" without `arrayRef` runs as list
    // mode, so the picker offers the list-mode shape for it too.
    const node = { ...savedNode, ...(e.impliedListMode(savedNode) || {}) };
    const label = node.label || groupLabel(e, 'datetime', 'Date & Time');
    const op = node.op || 'now';
    const sample = op === 'diff' || op === 'extract'
        ? { value: 0, ...(op === 'diff' ? { unit: node.unit || 'days' } : { part: node.part || 'year' }) }
        : { iso: '2026-05-13T09:00:00.000Z', value: '2026-05-13T09:00:00.000Z' };

    // LIST MODE: every row is the source row plus one new column (server
    // engine.js execDateTimeList).
    if (e.isDateTimeListMode(node)) {
        const element = resolveElementSample(node.arrayRef, sampleRoot);
        const baseRow = isPlainObject(element) ? { ...element } : (element != null ? { value: element } : {});
        const row = { ...baseRow, [e.datetimeTargetColumn(node)]: sample.value };
        return stepGroup(node, label, 'datetime', { items: [row], count: 0 });
    }
    return stepGroup(node, label, 'datetime', sample);
}

export function describeCollectionItems(node, label, sampleRoot = null) {
    const element = resolveElementSample(node.arrayRef, sampleRoot);
    return stepGroup(node, node.label || label, 'collection', { items: element != null ? [element] : [], count: 0 });
}

export function describeDedupe(node, sampleRoot = null, env) {
    const element = resolveElementSample(node.arrayRef, sampleRoot);
    const label = node.label || groupLabel(env, 'node.dedupe', 'Remove duplicates');
    return stepGroup(node, label, 'collection', { items: element != null ? [element] : [], removed: 0 });
}

export function describeAggregate(node, sampleRoot = null, env) {
    const element = resolveElementSample(node.arrayRef, sampleRoot);
    const plucked = isPlainObject(element) && node.field ? element[node.field] : undefined;
    const label = node.label || groupLabel(env, 'aggregate', 'Aggregate');
    return stepGroup(node, label, 'collection', { values: plucked !== undefined ? [plucked] : [], count: 0 });
}

export function describeSummarize(node, env) {
    const label = node.label || groupLabel(env, 'summarize', 'Summarize');
    return stepGroup(node, label, 'collection', { result: 0, op: node.op || 'sum', count: 0 });
}
