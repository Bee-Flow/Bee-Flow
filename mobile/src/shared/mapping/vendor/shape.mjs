/**
 * The shape of a value, or of what a JSON schema promises: the one fact the
 * defaults of a pick (intent.mjs) and the text rendering (render.mjs) are
 * decided on.
 *
 *   missing  nothing there (undefined)
 *   single   a text, number, yes/no, or empty (null)
 *   object   one record
 *   list     a list of values, or a list whose items are not known yet
 *   table    a non-empty list whose items are all records (nulls aside)
 *   unknown  a schema that does not say
 *
 * An empty list is a `list`, never a `table`: before the first run a list
 * has no rows to look at. That is why the text rendering never trusts the
 * design-time shape and renders by what the run holds (render.mjs).
 */

import { isMany, manyItems } from './walk.mjs';

export const SHAPES = Object.freeze(['missing', 'single', 'object', 'list', 'table', 'unknown']);

function isRecord(v) {
    return v !== null && typeof v === 'object' && !Array.isArray(v);
}

function listShape(items) {
    const present = items.filter(v => v !== null && v !== undefined);
    return present.length > 0 && present.every(isRecord) ? 'table' : 'list';
}

/**
 * The shape of a value from a run or a sample, or of a walk result (a walk
 * that crossed a list is a list of what it found).
 * @param {unknown} value
 */
export function shapeOf(value) {
    if (isMany(value)) return listShape(manyItems(value).items);
    if (value === undefined) return 'missing';
    if (Array.isArray(value)) return listShape(value);
    if (isRecord(value)) return 'object';
    return 'single';
}

function typesOf(schema) {
    const t = schema.type;
    if (typeof t === 'string') return [t];
    return Array.isArray(t) ? t.filter(x => typeof x === 'string') : [];
}

/**
 * The shape a JSON schema promises. `unknown` when it does not say (no
 * schema, no type): the caller then falls back to the value it has, or to
 * passing the value through unchanged.
 * @param {unknown} schema
 */
export function shapeOfSchema(schema) {
    if (!isRecord(schema)) return 'unknown';
    const types = typesOf(schema).filter(t => t !== 'null');
    if (!types.length) {
        if (isRecord(schema.properties)) return 'object';
        if (isRecord(schema.items)) return shapeOfSchema({ type: 'array', items: schema.items });
        return 'unknown';
    }
    if (types.includes('array')) {
        const items = isRecord(schema.items) ? schema.items : null;
        if (!items) return 'list';
        const itemTypes = typesOf(items);
        return itemTypes.includes('object') || (!itemTypes.length && isRecord(items.properties)) ? 'table' : 'list';
    }
    if (types.includes('object')) return 'object';
    return 'single';
}
