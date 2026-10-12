/**
 * The ONE builder that turns a value into the fields a person picks from.
 *
 * The variable tree, the {} picker, the Comes-in column, a step's own output
 * fields, the Loop / list source lists and auto-map all read what this
 * builds, so a field that shows in one shows in all of them. It replaces two
 * hand-written builders that stopped one level down: a Graph sender address,
 * a Gmail attachment id or a Jira status name was simply not offered, and the
 * author had to type the path.
 *
 *   - It recurses. An object opens into its keys and a list into the columns
 *     of its elements (`value[*].from.emailAddress.address`), down to
 *     FIELD_LIMITS.depth key levels.
 *   - A list's element shape is the UNION of its elements' keys (the first
 *     FIELD_LIMITS.elements of them; nulls and scalars skipped), not element
 *     0's: a key only the second row has, or a list that starts with null,
 *     still offers its columns. A field's sample is a real value found for it,
 *     so a preview shows data instead of a placeholder.
 *   - Text that IS JSON (an HTTP body, an AI answer in a ```json fence) opens
 *     like the object it encodes. The runtime reads through JSON text
 *     (shared/expr/path.mjs stepInto), so `body.data.id` works as written.
 *   - A list of name/value pairs (mail headers, order attributes, tags) also
 *     offers each entry under its name, `headers[name="Subject"].value`:
 *     "the Subject header" is what a person is looking for, not header 4.
 *
 * Every path is written by appendKey / appendWildcard / appendMatch, the
 * runtime grammar's own writer, so whatever is offered resolves at run time
 * to the value it previews (discovery.roundtrip.test.ts holds it to that).
 * The caps keep a 256 KB pinned output cheap to describe; the tree renders a
 * row's children only when it is opened.
 */
import { appendKey, appendMatch, appendWildcard, parseJsonText, parsePath } from '@shared/expr/path.mjs';
import { routeFieldLabel } from './routeFieldLabel';

export interface Field {
    key: string;
    path: string;
    sample: unknown;
    children?: Field[];
    perIteration?: boolean;
    /** The name a person gave this field when its key is the runner's (routeFieldLabel.ts). */
    label?: string;
    /** `label`'s i18n key; the label is its English. */
    labelKey?: string;
}

type Obj = Record<string, unknown>;

export const FIELD_LIMITS = Object.freeze({
    /**
     * Key levels below where a build starts. `[*]` is not a level, and nor is
     * reading JSON text: `body.data` is two levels whether `body` is a record
     * or text encoding one. Ten reaches a fenced AI answer inside a list item
     * inside an HTTP body; the `fields` budget keeps wide data cheap.
     */
    depth: 10,
    /** Keys offered per object position. */
    keys: 200,
    /** Elements of one list read for its element shape. */
    elements: 50,
    /** Values read per position across every list above it. */
    values: 200,
    /** Lists inside lists (`cube[*][*][*]`) before the walk stops. */
    nestedLists: 6,
    /** Rows one build may produce in total. */
    fields: 4000,
    /** Longest text sniffed for JSON. */
    jsonText: 256 * 1024,
    /** Named entries offered per list of name/value pairs. */
    entries: 50,
});

const hasOwn = (o: object, k: string): boolean => Object.prototype.hasOwnProperty.call(o, k);

export function isRecord(v: unknown): v is Obj {
    return v !== null && typeof v === 'object' && !Array.isArray(v);
}

// Cheap gate before a parse: JSON text starts with a brace, a bracket, a
// fence or (encoded twice) a quote. Most strings in a payload are prose.
const JSON_START_RE = /^\s*[[{`"]/;

/** The object or list a string encodes as JSON text; undefined for anything else. */
export function jsonTextValue(v: unknown): unknown {
    if (typeof v !== 'string' || v.length > FIELD_LIMITS.jsonText || !JSON_START_RE.test(v)) return undefined;
    return parseJsonText(v);
}

/** What one build may still spend: rows left. */
interface Budget { left: number }

/**
 * A POSITION in the value: its path, the key level its children sit at, and
 * how many lists deep it is (`cube[*][*]`).
 */
interface At { path: string; level: number; lists: number }

/** A record found at a position, and whether it was read out of JSON text. */
interface Rec { obj: Obj; text: boolean }

/** Says something: not null, not empty text, not an empty list or record. */
function telling(v: unknown): boolean {
    return v != null && v !== '' && !(Array.isArray(v) && v.length === 0) && !(isRecord(v) && Object.keys(v).length === 0);
}

/**
 * The sample a field shows: THE value when there is one, otherwise the first
 * that says something, otherwise the first that is not null.
 */
function sampleOf(values: unknown[]): unknown {
    if (values.length === 1) return values[0];
    const said = values.find(telling);
    if (said !== undefined) return said;
    const some = values.find(v => v != null);
    if (some !== undefined) return some;
    return values.length ? values[0] : undefined;
}

/** A field at `at` (whose children sit one level further down). */
function fieldAt(key: string, values: unknown[], at: At, budget: Budget): Field {
    budget.left--;
    const field: Field = { key, path: at.path, sample: sampleOf(values), ...routeFieldLabel(at.path) };
    const children = childrenAt(values, { ...at, level: at.level + 1 }, budget);
    if (children.length) field.children = children;
    return field;
}

/** One record per value that is (or encodes) an object, and the lists the same way. */
function split(values: unknown[]): { records: Rec[]; lists: unknown[][] } {
    const records: Rec[] = [];
    const lists: unknown[][] = [];
    for (const raw of values) {
        const parsed = jsonTextValue(raw);
        const v = parsed === undefined ? raw : parsed;
        if (isRecord(v)) records.push({ obj: v, text: parsed !== undefined });
        else if (Array.isArray(v)) lists.push(v);
    }
    return { records, lists };
}

/** The elements a position's lists hold, as many as the caps read. */
function elementsOf(lists: unknown[][]): unknown[] {
    const elements: unknown[] = [];
    for (const list of lists) {
        for (const el of list.slice(0, FIELD_LIMITS.elements)) {
            if (el !== undefined) elements.push(el);
            if (elements.length >= FIELD_LIMITS.values) return elements;
        }
    }
    return elements;
}

/**
 * The fields under one POSITION of the value: `values` are every value found
 * there (one, or one per element of each list above it).
 */
function childrenAt(values: unknown[], at: At, budget: Budget): Field[] {
    if (at.level > FIELD_LIMITS.depth || budget.left <= 0 || !values.length) return [];
    const { records, lists } = split(values);
    const out: Field[] = [];
    if (records.length) out.push(...keyFields(records, at, budget));
    if (lists.length && at.lists < FIELD_LIMITS.nestedLists) {
        const elements = elementsOf(lists);
        out.push(...childrenAt(elements, { ...at, path: appendWildcard(at.path), lists: at.lists + 1 }, budget));
        out.push(...namedEntries(elements, at, budget));
    }
    return out;
}

/**
 * Is `key` out of reach because its record came as JSON text? `.length` of a
 * string is the string's length (path.mjs stepInto), never a key of the JSON
 * it encodes, so such a key is never offered: not as a field, not by
 * auto-map, not in the output view. The one copy of that rule.
 */
export function textHidesKey(fromText: boolean, key: string): boolean {
    return fromText && key === 'length';
}

const reachable = (r: Rec, k: string): boolean => hasOwn(r.obj, k) && !textHidesKey(r.text, k);

function keyFields(records: Rec[], at: At, budget: Budget): Field[] {
    const keys: string[] = [];
    const seen = new Set<string>();
    for (const r of records) {
        for (const k of Object.keys(r.obj)) {
            if (seen.has(k) || !reachable(r, k)) continue;
            seen.add(k);
            keys.push(k);
            if (keys.length >= FIELD_LIMITS.keys) break;
        }
        if (keys.length >= FIELD_LIMITS.keys) break;
    }
    const out: Field[] = [];
    for (const k of keys) {
        if (budget.left <= 0) break;
        const vals = records.filter(r => reachable(r, k)).map(r => r.obj[k]);
        out.push(fieldAt(k, vals, { ...at, path: appendKey(at.path, k) }, budget));
    }
    return out;
}

const NAME_KEYS = ['name', 'key', 'field', 'label'];
const VALUE_KEYS = ['value', 'val', 'content', 'text'];
/** A pair may carry one or two keys beside its name and value (a type, an id). */
const PAIR_MAX_KEYS = 4;

function pairKeys(obj: Obj): { name: string; value: string } | null {
    const keys = Object.keys(obj);
    if (keys.length > PAIR_MAX_KEYS) return null;
    const find = (wanted: string[]) => {
        for (const w of wanted) {
            const k = keys.find(x => x.toLowerCase() === w);
            if (k !== undefined) return k;
        }
        return null;
    };
    const name = find(NAME_KEYS);
    const value = find(VALUE_KEYS);
    if (!name || !value || typeof obj[name] !== 'string') return null;
    return { name, value };
}

/** Do two entry names select the same element? The runtime's match rule (path.mjs stepMatch): text compares without case. */
export const sameName = (a: string, b: string): boolean => a === b || a.localeCompare(b, undefined, { sensitivity: 'accent' }) === 0;

/**
 * The name and value keys of a list of name/value pairs (`[{ name, value }]`,
 * `[{ Key, Value }]`): every record in it is one, with the same two keys.
 * Null for anything else.
 */
export function pairKeysOf(elements: readonly unknown[]): { name: string; value: string } | null {
    const records = split(elements as unknown[]).records.map(r => r.obj);
    const first = records[0];
    if (!first) return null;
    const keys = pairKeys(first);
    if (!keys) return null;
    for (const r of records) {
        const k = pairKeys(r);
        if (!k || k.name !== keys.name || k.value !== keys.value) return null;
    }
    return keys;
}

/**
 * `headers[name="Subject"].value` for a list whose every element is a
 * name/value pair (`at` is the LIST's position). The runtime returns the
 * FIRST element with that name, so only the first of equal names is offered,
 * with that element's value.
 */
function namedEntries(elements: unknown[], at: At, budget: Budget): Field[] {
    const keys = pairKeysOf(elements);
    if (!keys) return [];
    const records = split(elements).records.map(r => r.obj);
    const out: Field[] = [];
    const names: string[] = [];
    for (const r of records) {
        if (out.length >= FIELD_LIMITS.entries || budget.left <= 0) break;
        const name = r[keys.name] as string;
        if (!name.trim() || names.some(n => sameName(n, name))) continue;
        names.push(name);
        const path = appendKey(appendMatch(at.path, keys.name, name), keys.value);
        out.push(fieldAt(name, [r[keys.value]], { ...at, path }, budget));
    }
    return out;
}

/** The fields under a value at `path` (its keys, its list's columns, its JSON). */
export function valueChildren(value: unknown, path: string): Field[] {
    return childrenAt([value], { path, level: 1, lists: 0 }, { left: FIELD_LIMITS.fields });
}

/**
 * The fields under a position several values share: the outputs of every
 * iteration of a step that runs once per item (`results[*].output`).
 */
export function positionChildren(values: unknown[], path: string): Field[] {
    return childrenAt(values, { path, level: 1, lists: 0 }, { left: FIELD_LIMITS.fields });
}

/** One field for a value at `path`, with whatever opens under it. */
export function fieldFor(key: string, path: string, value: unknown): Field {
    const field: Field = { key, path, sample: value, ...routeFieldLabel(path) };
    const children = valueChildren(value, path);
    if (children.length) field.children = children;
    return field;
}

/**
 * A record's fields, every level of it. Anything but a plain object (or JSON
 * text encoding one) has no named fields: [].
 */
export function recordFields(sample: unknown, basePath: string): Field[] {
    const parsed = jsonTextValue(sample);
    if (!isRecord(sample) && !isRecord(parsed)) return [];
    return valueChildren(sample, basePath);
}

/**
 * The fields of a step's WHOLE output: a record lists its own fields; a list,
 * text or a number is one field at the base path (named `key`), with the
 * list's columns or the text's JSON under it.
 */
export function outputFields(value: unknown, basePath: string, key = 'output'): Field[] {
    if (isRecord(value)) return valueChildren(value, basePath);
    if (value === undefined) return [];
    return [fieldFor(key, basePath, value)];
}

/** Every field, depth first, parents before their children. */
export function eachField(fields: readonly Field[] | null | undefined, fn: (f: Field) => void): void {
    for (const f of fields || []) {
        fn(f);
        if (f.children) eachField(f.children, fn);
    }
}

/**
 * A value as discovery reads it: JSON text is what it encodes, minus the keys
 * a path cannot reach through text (textHidesKey). Copied only when a key goes.
 */
export function readableValue(v: unknown): unknown {
    const parsed = jsonTextValue(v);
    if (parsed === undefined) return v;
    if (!isRecord(parsed) || !Object.keys(parsed).some(k => textHidesKey(true, k))) return parsed;
    return Object.fromEntries(Object.entries(parsed).filter(([k]) => !textHidesKey(true, k)));
}

function mergeValues(values: unknown[], depth: number): unknown {
    const records = values.map(readableValue).filter(isRecord);
    if (records.length) {
        if (records.length === 1 || depth >= FIELD_LIMITS.depth) return records[0];
        const out: Obj = {};
        for (const r of records) {
            for (const k of Object.keys(r)) {
                if (hasOwn(out, k) || Object.keys(out).length >= FIELD_LIMITS.keys) continue;
                out[k] = mergeValues(records.filter(x => hasOwn(x, k)).map(x => x[k]), depth + 1);
            }
        }
        return out;
    }
    const lists = values.filter(Array.isArray) as unknown[][];
    if (lists.length) {
        if (lists.length === 1) return lists[0];
        const all: unknown[] = [];
        for (const l of lists) all.push(...l.slice(0, FIELD_LIMITS.elements));
        return all.slice(0, FIELD_LIMITS.values);
    }
    return sampleOf(values);
}

/**
 * ONE element that stands for a whole list: every key the first
 * FIELD_LIMITS.elements elements carry (records merged key by key, the first
 * value that says something winning), nulls skipped, records (or JSON text
 * encoding one) preferred over scalars. For the steps that keep their
 * source's element shape (Filter, Limit, Set in list mode) and the condition
 * editors' `item.*`. Null for an empty list.
 */
export function mergeElements(list: unknown): unknown {
    if (!Array.isArray(list)) return null;
    const els = list.slice(0, FIELD_LIMITS.elements).filter(v => v != null);
    if (!els.length) return null;
    return mergeValues(els, 0);
}

const VALUE_KEY_RE = /^(value|val|content|text)$/i;

/**
 * The key a path ENDS in, as the data spells it, for a label: `verdict["reason
 * code"]` gives `reason code` (not `verdict`), a name/value entry
 * `headers[name="Subject"].value` gives `Subject`. Takes a whole path or a
 * tail (`.a.b`, `[*].x`); '' when there is no key.
 */
export function lastPathKey(path: string): string {
    const s = String(path || '').trim();
    const tokens = parsePath(s) || parsePath(s.startsWith('[') ? `$${s}` : `$.${s.replace(/^\./, '')}`);
    if (!tokens) return s.replace(/\[[^\]]*\]/g, '').split('.').filter(Boolean).pop() || '';
    for (let i = tokens.length - 1; i >= 0; i--) {
        const t = tokens[i];
        if (!t || t.type !== 'prop' || typeof t.key !== 'string') continue;
        const before = tokens[i - 1];
        if (before && before.type === 'match' && VALUE_KEY_RE.test(t.key)) return String(before.value);
        return t.key;
    }
    return '';
}
