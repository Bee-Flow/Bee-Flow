/**
 * The catalog prop spec, read by the generic inspector controls (SpecPanel and
 * the "More options" block), and the pure rules those controls follow when a
 * value is cleared.
 *
 * Clearing mirrors what the canonicalizer stores for a node that never had the
 * value (server/appStudio/canonicalize/props.js):
 *   - a base prop is filled from its spec default, so clearing writes that
 *     default back;
 *   - a prop marked `since` (added after the frozen base) is only kept while it
 *     holds a value, and null means "not set", so clearing writes null and the
 *     next save drops the key;
 *   - list items pass through unchanged, so clearing an optional item key
 *     removes it from the item instead of writing an empty value.
 */

import { deepEqual } from '@/utils/deepEqual';

/** One prop's entry in the catalog's prop spec (or an inferred one). */
export interface PropSpec {
    type: string;
    default?: unknown;
    values?: unknown[];
    min?: number;
    max?: number;
    maxItems?: number;
    itemShape?: Record<string, PropSpec> | null;
    required?: boolean;
    since?: number;
    description?: string;
}

/** One row of a list prop: its fields by key, as the form holds them. */
export type ListItem = Record<string, unknown>;

/** The schema version every app before the flexibility programme is on. */
const BASE_SCHEMA_VERSION = 2;

/** 'labelKey' / 'group_by' → 'Label key' / 'Group by'. */
export function humanize(key: string) {
    const words = String(key)
        .replace(/_/g, ' ')
        .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
        .toLowerCase();
    return words.charAt(0).toUpperCase() + words.slice(1);
}

/** A prop or item key added after the frozen base vocabulary. */
export function isLateEntry(fs: PropSpec | null | undefined) {
    const since = fs?.since;
    return typeof since === 'number' && Number.isInteger(since) && since > BASE_SCHEMA_VERSION;
}

/** JSON copy of a spec default (definitions are plain data). */
function copyDefault(value: unknown): unknown {
    return value === undefined ? null : JSON.parse(JSON.stringify(value));
}

/** What a top-level prop holds once it is cleared: its default, or null for a late prop. */
export function clearedPropValue(fs: PropSpec): unknown {
    return isLateEntry(fs) ? null : copyDefault(fs.default);
}

/** True when a top-level prop already holds what clearing would write. */
export function isClearedProp(fs: PropSpec, value: unknown) {
    if (isLateEntry(fs)) return value === undefined || value === null;
    const cleared = clearedPropValue(fs);
    if (value === undefined) return true;
    return deepEqual(value, cleared);
}

/** True when an item field value means "nothing set" for that key. */
function isEmptyItemValue(fs: PropSpec, value: unknown) {
    if (value === undefined || value === null || value === '') return true;
    if (fs.type === 'list' && Array.isArray(value) && value.length === 0) return true;
    // An unticked box is the absent value unless the key defaults to true.
    return fs.type === 'boolean' && value === false && fs.default !== true;
}

/**
 * One item key written, or removed when the new value is empty and the key is
 * optional. A required key keeps an empty string so the row stays editable
 * (the validator then names the missing value, as it does today).
 */
export function setItemKey(item: ListItem, key: string, fs: PropSpec, value: unknown): ListItem {
    const next: ListItem = { ...item };
    if (isEmptyItemValue(fs, value) && !fs.required) {
        delete next[key];
        return next;
    }
    next[key] = value === undefined || value === null ? '' : value;
    return next;
}

/**
 * A fresh row for a list. Base keys get what they always got (an empty string,
 * the enum default, false), so lists that existed before keep their shape. A
 * nested list and a late key start absent: an item passes through the
 * canonicalizer as it is, so a written default would be stored for good.
 */
export function newListItem(itemShape: Record<string, PropSpec> | null | undefined): ListItem {
    const item: ListItem = {};
    for (const [k, fs] of Object.entries(itemShape || {})) {
        const start = startValue(fs);
        if (start !== undefined) item[k] = start;
    }
    return item;
}

/** The value a new row starts with for one key (undefined = leave the key out). */
function startValue(fs: PropSpec): unknown {
    if (isLateEntry(fs)) return undefined;
    switch (fs.type) {
        case 'enum': return fs.default ?? fs.values?.[0] ?? '';
        case 'boolean': return fs.default ?? false;
        case 'int':
        case 'number': return fs.default ?? null;
        // A required binding (a progress segment's value) starts as an empty
        // literal, the shape BindingField opens its chooser on.
        case 'binding': return fs.required ? { kind: 'static', value: null } : undefined;
        case 'list':
        case 'icon': return undefined;
        default: return '';
    }
}

/** The first sentence of a catalog description: the one-line gloss. */
export function firstSentence(description: string | undefined) {
    if (!description) return undefined;
    const text = description.trim();
    const end = text.indexOf('. ');
    return end === -1 ? text : text.slice(0, end + 1);
}

/** The text a row header shows for an item: its label, else its first filled key. */
export function itemTitle(item: ListItem, itemShape: Record<string, PropSpec> | null | undefined) {
    for (const key of ['label', 'name', 'title', ...Object.keys(itemShape || {})]) {
        const v = item?.[key];
        if (typeof v === 'string' && v.trim()) return v;
    }
    return '';
}
