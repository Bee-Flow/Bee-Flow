/**
 * A JSON value as the rows of a collapsible tree — what the node editor's
 * Output tab lists (the web's RunTabContainer / OutputView). Pure and flat, so
 * a FlatList can virtualise a large output; a container's children appear
 * only once it is opened, and never more than `limit` rows in all.
 *
 * Two readings of the same rows. The RAW tree is the exact JSON: `[3]`,
 * `{2}`, `"quoted"`, `null`, `true`, the keys as they are. The READABLE tree
 * (given `words`) is what a person reads for a value too nested for a table:
 * "3 items", "2 fields", the text itself, "—", "Yes", "From email", "#1".
 */

import type { Translate } from '@/features/flow-editor/model';
import { humanizeFieldKey } from '@/shared/lib/humanizeKey';

export type JsonKind = 'object' | 'array' | 'string' | 'number' | 'boolean' | 'null';

export interface TreeRow {
    /** The row's path from the root: `$.items[0].name`. */
    id: string;
    key: string;
    depth: number;
    kind: JsonKind;
    preview: string;
    childCount: number;
    expanded: boolean;
    value: unknown;
}

export const ROOT = '$';

/** How a readable tree says what a raw one prints as `[3]`, `{2}` and `true`. */
export interface TreeWords {
    items: (n: number) => string;
    fields: (n: number) => string;
    yes: string;
    no: string;
}

export function treeWords(t: Translate): TreeWords {
    return {
        // The web's words for the same counts: a step's result chip, and its fields in the mapping panel.
        items: (n) => (n === 1 ? t('mobile.flow.output.one_item', '1 item') : t('routines.canvas.result.items', '{n} items', { n })),
        fields: (n) => (n === 1 ? t('routines.mapping.one_field', '1 field') : t('routines.mapping.n_fields', '{n} fields', { n })),
        yes: t('common.yes', 'Yes'),
        no: t('common.no', 'No'),
    };
}

export function kindOf(v: unknown): JsonKind {
    if (v === null || v === undefined) return 'null';
    if (Array.isArray(v)) return 'array';
    if (typeof v === 'object') return 'object';
    if (typeof v === 'number') return 'number';
    if (typeof v === 'boolean') return 'boolean';
    return 'string';
}

function entriesOf(v: unknown): [string, unknown][] {
    if (Array.isArray(v)) return v.map((x, i) => [String(i), x]);
    if (v && typeof v === 'object') return Object.entries(v as Record<string, unknown>);
    return [];
}

function childId(parent: string, key: string, array: boolean): string {
    return array ? `${parent}[${key}]` : `${parent}.${key}`;
}

const clip = (text: string) => (text.length > 120 ? `${text.slice(0, 119)}…` : text);

/** A value's one-line form: a leaf as itself, a container by its size — as JSON, or in `words`. */
export function previewOf(v: unknown, words: TreeWords | null = null): string {
    const kind = kindOf(v);
    if (kind === 'array') return words ? words.items((v as unknown[]).length) : `[${(v as unknown[]).length}]`;
    if (kind === 'object') return words ? words.fields(Object.keys(v as object).length) : `{${Object.keys(v as object).length}}`;
    if (kind === 'null') return words ? '—' : 'null';
    if (kind === 'boolean' && words) return v ? words.yes : words.no;
    return clip(typeof v === 'string' && !words ? JSON.stringify(v) : String(v));
}

/** A row's key: as it is, or read — `from_email` → "From email", `[0]` → "#1". */
function keyText(key: string, array: boolean, words: TreeWords | null): string {
    if (!words) return array ? `[${key}]` : key;
    return array ? `#${Number(key) + 1}` : humanizeFieldKey(key) || key;
}

/** What copying a row puts on the clipboard: a string as itself, anything else as JSON. */
export function copyText(v: unknown): string {
    if (typeof v === 'string') return v;
    try {
        return JSON.stringify(v, null, 2) ?? '';
    } catch {
        return String(v);
    }
}

interface Walk {
    expanded: ReadonlySet<string>;
    limit: number;
    words: TreeWords | null;
    out: TreeRow[];
}

function walk(value: unknown, parent: string, depth: number, w: Walk): void {
    const array = Array.isArray(value);
    for (const [key, v] of entriesOf(value)) {
        if (w.out.length >= w.limit) return;
        const id = childId(parent, key, array);
        const kind = kindOf(v);
        const childCount = entriesOf(v).length;
        const expanded = childCount > 0 && w.expanded.has(id);
        w.out.push({ id, key: keyText(key, array, w.words), depth, kind, preview: previewOf(v, w.words), childCount, expanded, value: v });
        if (expanded) walk(v, id, depth + 1, w);
    }
}

/** The rows on screen for a value and the containers opened so far; readable when given `words`. */
export function treeRows(value: unknown, expanded: ReadonlySet<string> = new Set(), limit = 500, words: TreeWords | null = null): TreeRow[] {
    const kind = kindOf(value);
    if (kind !== 'object' && kind !== 'array') {
        return [{ id: ROOT, key: '', depth: 0, kind, preview: previewOf(value, words), childCount: 0, expanded: false, value }];
    }
    const out: TreeRow[] = [];
    walk(value, ROOT, 0, { expanded, limit, words, out });
    return out;
}
