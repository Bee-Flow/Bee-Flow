/**
 * The sample → field vocabulary every describer in this folder shares.
 *
 * One sample (what a node's output looks like) in, one tree of bindable
 * `{ key, path, sample, children? }` fields out, built by fieldTree.ts: every
 * level, list columns from the union of the rows, JSON text opened, each path
 * written in the RUNTIME's grammar. Plus the element-shape lookup collection
 * steps resolve their `arrayRef` with, the list-source scan, and the
 * declared-type → placeholder table the schema-driven describers use.
 */
import { formatKey } from '@shared/expr/path.mjs';
import { eachField, isRecord, mergeElements, recordFields } from './fieldTree';
import { overlayGroupWithReal } from './realOverlay';
import { walkPath } from '../../../../../utils/bindingHelpers';

/**
 * The path segment for ONE key: `.key`, `[3]` or `["line-items"]`.
 *
 * Kept as a name for callers that append a single key; it is the runtime
 * grammar's own writer (shared/expr/path.mjs formatKey). It used to quote
 * with JSON.stringify against a runtime that knew no escapes, so a key with a
 * quote or a backslash got a path nothing could resolve; the grammar now
 * reads JSON escapes, and every key has a path.
 */
export const seg = (k) => formatKey(k);

/**
 * A record's fields, every level of it: keys, the columns of its lists
 * (`results[*].subject`), and what its JSON text encodes. Anything that is
 * not a record has no named fields ([]). See fieldTree.ts for the caps.
 */
export function sampleToFields(sample, basePath) {
    return recordFields(sample, basePath);
}

/**
 * Resolve an arrayRef path to ONE element that stands for that array: the
 * keys of its first rows merged (nulls skipped, records preferred), see
 * fieldTree.mergeElements. `sampleRoot` is either the accumulated design-time
 * root (see computeUpstreamGroups) or the NDV's previewSample (which overlays
 * real last-run / pinned outputs). Null when the path doesn't resolve to a
 * non-empty array.
 */
export function resolveElementSample(arrayRef, sampleRoot) {
    if (typeof arrayRef !== 'string' || !arrayRef.trim() || !sampleRoot) return null;
    const v = walkPath(arrayRef.trim(), sampleRoot);
    if (!Array.isArray(v) || v.length === 0) return null;
    return mergeElements(v);
}

/**
 * Top-level field options of an array element — the ONLY level the server's
 * collection ops can address (engine.js reads `item?.[step.field]`, so
 * dotted paths silently fail there). Feeds FieldKeyCombobox.
 */
export function elementFieldOptions(elementSample) {
    if (!elementSample || typeof elementSample !== 'object' || Array.isArray(elementSample)) return [];
    return Object.entries(elementSample).map(([key, sample]) => ({ key, sample }));
}

/**
 * The fields of a group's REAL value: exactly what overlayGroupWithReal
 * offers, so the two cannot drift. A step that runs once per item reads as
 * its forEach envelope (`results[*].output.…`), a Code step as its own data
 * (never its `logs`), a root list as one field.
 */
export function realFieldsOf(group, actual) {
    return overlayGroupWithReal(group, actual).fields || [];
}

/**
 * Every LIST reachable from the upstream groups, at any depth — the fields
 * and their children, plus lists that only exist in the real-run/pinned
 * overlay (previewSample) and not in the schema sample. One list per path;
 * the first one found keeps its sample. Feeds the Loop picker and the
 * collection steps' "which list" field. Returns [{ key, path, sample }].
 */
export function collectArrayPaths(groups, previewSample = null) {
    const out = [];
    const seen = new Set();
    const visit = (fields) => eachField(fields, (f) => {
        if (!Array.isArray(f.sample) || !f.path || seen.has(f.path)) return;
        seen.add(f.path);
        out.push({ key: f.key, path: f.path, sample: f.sample });
    });
    for (const g of (groups || [])) {
        visit(g.fields);
        // Real-run overlay: lists present in the actual output but absent from
        // the design-time sample (e.g. a tool with no curated outputSample).
        if (previewSample && g.basePath) {
            const actual = walkPath(g.basePath, previewSample);
            if (actual !== undefined) visit(realFieldsOf(g, actual));
        }
    }
    return out;
}

export function samplePlaceholderFor(type) {
    switch (type) {
        case 'number': return 0;
        case 'boolean': return false;
        case 'object': return {};
        case 'array': return [];
        // App-trigger file inputs arrive expanded (appStudio/actionExecutor);
        // the nested keys make trigger.output.<name>.url bindable in the tree.
        case 'file': return { fileId: '<file-id>', name: 'document.pdf', mime: 'application/pdf', size: 12345, url: '<signed download url>' };
        default: return '<string>';
    }
}

/**
 * A declared schema as a sample with the same shape: an object's properties,
 * an array's items as one element, a type list's first non-null type, the
 * first non-null branch of an anyOf / oneOf. A bare type name (the flat
 * `{ field: 'type' }` dialect) is its placeholder.
 * Before the first run, that nested sample is what makes
 * `customer.address.city` and `items[*].sku` pickable.
 */
export function schemaToSample(schema, depth = 0) {
    if (typeof schema === 'string') return samplePlaceholderFor(schema);
    if (!isRecord(schema)) return samplePlaceholderFor('string');
    const branch = [schema.anyOf, schema.oneOf].find(Array.isArray);
    if (branch && !schema.type && !schema.properties) {
        return schemaToSample(branch.find(b => isRecord(b) && b.type !== 'null') || branch[0], depth);
    }
    const type = schemaType(schema);
    if (depth >= 8) return samplePlaceholderFor(type);
    if ((type === 'object' || !type) && isRecord(schema.properties)) {
        return Object.fromEntries(Object.entries(schema.properties).filter(([k]) => k).map(([k, v]) => [k, schemaToSample(v, depth + 1)]));
    }
    if (type === 'array') return isRecord(schema.items) ? [schemaToSample(schema.items, depth + 1)] : [];
    return samplePlaceholderFor(typeof type === 'string' ? type : 'string');
}

/** A schema's one type: the first non-null of a type list. */
function schemaType(schema) {
    return Array.isArray(schema.type) ? (schema.type.find(t => t !== 'null') || schema.type[0]) : schema.type;
}
