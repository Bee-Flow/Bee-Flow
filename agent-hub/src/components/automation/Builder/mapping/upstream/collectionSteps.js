/**
 * The steps that hand a COLLECTION downstream — the n8n-style list nodes.
 *
 * Filter, Limit, Dedupe, Aggregate and Summarize are collections by nature;
 * Set and Date & Time become one in their list mode; Parse JSON does in its
 * grouped mode. All of them emit the same `{ items, count }` wrapper, and
 * `collectionItemsFields` is the one builder that keeps the source element's
 * fields visible through it as `…output.items[*].<key>` children.
 */
import { appendKey, extractJsonText, getRelativePath } from '@shared/expr/path.mjs';
import { fieldFor, isRecord } from './fieldTree';
import { resolveElementSample, sampleToFields } from './sampleFields';
import { walkPath } from '../../../../../utils/bindingHelpers';
import { datetimeTargetColumn, impliedListMode, isDateTimeListMode } from '../../flow/datetimeTarget';
import { applyOpsToSampleRow } from '../../flow/setOperations';
import { SET_STEP_NAME } from '../../flow/stepDisplayName';

// ── n8n-style utility node describers ──────────────────

/**
 * Filter / Limit / Dedupe preserve the source array's ELEMENT shape inside
 * their `items` wrapper. Resolve the node's arrayRef against the accumulated
 * design-time sampleRoot so downstream pickers see the element fields as
 * `steps.<id>.output.items[*].<key>` children, every level of them (the `[*]`
 * flatten is resolved by the runtime). Falls back to the bare `{ items: [] }`
 * wrapper when the ref can't be resolved.
 */
function collectionItemsFields(node, elementSample, wrapperSample) {
    const base = `steps.${node.id}.output`;
    return Object.entries(wrapperSample).map(([k, v]) => {
        const path = appendKey(base, k);
        if (k === 'items' && isRecord(elementSample)) return fieldFor(k, path, v);
        return { key: k, path, sample: v };
    });
}

/**
 * Set step output = the assembled fields object. Each field name becomes
 * a top-level bindable path. We don't know the values at design time, so
 * placeholders are typed as <string> — runtime fills them in.
 */
export function describeSet(node, sampleRoot = null) {
    // Resolve each binding against the accumulated sample tree (C25): a Set
    // field bound to an upstream ARRAY used to preview as the opaque '<set>'
    // string, which made Set-assembled lists invisible to the Loop picker
    // (collectArrayPaths filters on Array.isArray) and every preview useless.
    const entries = node.fields && typeof node.fields === 'object' ? Object.entries(node.fields) : [];
    const resolveOne = (v, root = sampleRoot) => {
        if (v == null) return '<set>';
        if (typeof v !== 'object') return v; // bare literal — bind.js supports it
        if (v.kind === 'literal') return v.value ?? '<set>';
        if (v.kind === 'ref' && root) {
            const resolved = walkPath(String(v.path || ''), root);
            if (resolved !== undefined) return resolved;
        }
        if (v.kind === 'template' || v.kind === 'expr') return '<text>';
        return '<set>';
    };

    // LIST MODE — the runtime contract is `{items, count}` where every row is
    // the source element + the computed fields, reshaped by the operations
    // (server engine.js execSet). Mirror that fold on ONE sample row so
    // downstream pickers offer `items[*].<col>` with the POST-operations
    // column set — renamed/removed columns must disappear here, or a
    // downstream binding picker would offer paths the run never produces.
    if (typeof node.arrayRef === 'string') {
        const element = resolveElementSample(node.arrayRef, sampleRoot);
        const isObj = element != null && typeof element === 'object' && !Array.isArray(element);
        // Per-row scope: refs/previews resolve `item.*` (and `_index`).
        const rowRoot = { ...(sampleRoot || {}), item: element, _index: 0 };
        const added = Object.fromEntries(entries.map(([k, v]) => [k, resolveOne(v, rowRoot)]));
        const baseRow = isObj ? { ...element } : (element != null ? { value: element } : {});
        const row = applyOpsToSampleRow({ ...baseRow, ...added }, node.operations);
        const hasRow = Object.keys(row).length > 0;
        const sample = { items: hasRow ? [row] : [], count: 0 };
        return {
            id: node.id,
            label: node.label || SET_STEP_NAME,
            kind: 'set',
            basePath: `steps.${node.id}.output`,
            sample,
            fields: collectionItemsFields(node, hasRow ? row : null, sample),
        };
    }

    const sample = Object.fromEntries(entries.map(([k, v]) => [k, resolveOne(v)]));
    return {
        id: node.id,
        label: node.label || SET_STEP_NAME,
        kind: 'set',
        basePath: `steps.${node.id}.output`,
        sample,
        fields: sampleToFields(sample, `steps.${node.id}.output`),
    };
}

/**
 * parse_json output = a FLAT object { <fieldName>: value } (the runtime
 * contract — see server execParseJson). Design-time execution: resolve each
 * field's relative path against the real sample when available (like
 * describeCollectionItems), so downstream previews show actual values;
 * otherwise fall back to '<extracted>' placeholders / declared fallbacks.
 */
export function describeParseJson(node, sampleRoot = null) {
    const fields = Array.isArray(node.fields) ? node.fields.filter(f => f && f.name) : [];
    let src;
    if (sampleRoot && node.sourceRef) {
        src = walkPath(node.sourceRef, sampleRoot);
        // The step reads text the way a person would (a fenced or wrapped
        // answer too), so the preview does.
        if (typeof src === 'string') src = extractJsonText(src);
    }
    // Grouped mode ("one row per entry") outputs { items, count } instead —
    // field paths then resolve inside a single entry.
    const itemsRef = typeof node.itemsRef === 'string' ? node.itemsRef.trim() : '';
    const rowFrom = (root) => Object.fromEntries(fields.map(f => {
        const v = root !== undefined ? getRelativePath(root, f.path) : undefined;
        return [f.name, v !== undefined ? v : (f.fallback !== undefined ? f.fallback : '<extracted>')];
    }));
    if (itemsRef) {
        const arr = src !== undefined ? getRelativePath(src, itemsRef) : undefined;
        const rows = Array.isArray(arr) ? arr.slice(0, 5).map(rowFrom) : [rowFrom(undefined)];
        const sample = { items: rows, count: Array.isArray(arr) ? arr.length : rows.length };
        return {
            id: node.id,
            label: node.label || 'Parse JSON',
            kind: 'parse_json',
            basePath: `steps.${node.id}.output`,
            sample,
            fields: sampleToFields(sample, `steps.${node.id}.output`),
        };
    }
    const sample = rowFrom(src);
    return {
        id: node.id,
        label: node.label || 'Parse JSON',
        kind: 'parse_json',
        basePath: `steps.${node.id}.output`,
        sample,
        fields: sampleToFields(sample, `steps.${node.id}.output`),
    };
}

export function describeDateTime(savedNode, sampleRoot = null) {
    // A whole column saved in "Input date" without `arrayRef` runs as list
    // mode (BFSF-375), so the picker offers the list-mode shape for it too.
    const node = { ...savedNode, ...impliedListMode(savedNode) };
    const op = node.op || 'now';
    const sample = op === 'diff' || op === 'extract'
        ? { value: 0, ...(op === 'diff' ? { unit: node.unit || 'days' } : { part: node.part || 'year' }) }
        : { iso: '2026-05-13T09:00:00.000Z', value: '2026-05-13T09:00:00.000Z' };

    // LIST MODE — the runtime contract is `{items, count}` where every row is
    // the source row plus one new column (server engine.js execDateTimeList).
    // Mirror that on one sample row so downstream pickers offer
    // `items[*].<column>` instead of the single-date shape the run never emits.
    if (isDateTimeListMode(node)) {
        const element = resolveElementSample(node.arrayRef, sampleRoot);
        const isObj = element != null && typeof element === 'object' && !Array.isArray(element);
        const baseRow = isObj ? { ...element } : (element != null ? { value: element } : {});
        const row = { ...baseRow, [datetimeTargetColumn(node)]: sample.value };
        const listSample = { items: [row], count: 0 };
        return {
            id: node.id,
            label: node.label || 'Date & Time',
            kind: 'datetime',
            basePath: `steps.${node.id}.output`,
            sample: listSample,
            fields: collectionItemsFields(node, row, listSample),
        };
    }

    return {
        id: node.id,
        label: node.label || 'Date & Time',
        kind: 'datetime',
        basePath: `steps.${node.id}.output`,
        sample,
        fields: sampleToFields(sample, `steps.${node.id}.output`),
    };
}

export function describeCollectionItems(node, label, sampleRoot = null) {
    const element = resolveElementSample(node.arrayRef, sampleRoot);
    const sample = { items: element != null ? [element] : [], count: 0 };
    return {
        id: node.id,
        label: node.label || label,
        kind: 'collection',
        basePath: `steps.${node.id}.output`,
        sample,
        fields: collectionItemsFields(node, element, sample),
    };
}

export function describeDedupe(node, sampleRoot = null) {
    const element = resolveElementSample(node.arrayRef, sampleRoot);
    const sample = { items: element != null ? [element] : [], removed: 0 };
    return {
        id: node.id,
        label: node.label || 'Remove duplicates',
        kind: 'collection',
        basePath: `steps.${node.id}.output`,
        sample,
        fields: collectionItemsFields(node, element, sample),
    };
}

export function describeAggregate(node, sampleRoot = null) {
    const element = resolveElementSample(node.arrayRef, sampleRoot);
    const plucked = element && typeof element === 'object' && node.field ? element[node.field] : undefined;
    const sample = { values: plucked !== undefined ? [plucked] : [], count: 0 };
    return {
        id: node.id,
        label: node.label || 'Aggregate',
        kind: 'collection',
        basePath: `steps.${node.id}.output`,
        sample,
        fields: sampleToFields(sample, `steps.${node.id}.output`),
    };
}

export function describeSummarize(node) {
    const sample = { result: 0, op: node.op || 'sum', count: 0 };
    return {
        id: node.id,
        label: node.label || 'Summarize',
        kind: 'collection',
        basePath: `steps.${node.id}.output`,
        sample,
        fields: sampleToFields(sample, `steps.${node.id}.output`),
    };
}
