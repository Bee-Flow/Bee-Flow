/**
 * Reading a step's output all the way down, for auto-map and the list
 * pickers: every scalar a parameter could take, and every list a step could
 * run once per item over.
 *
 * Real payloads are rarely flat. A Stripe event keeps its invoice lines at
 * `data.object.lines.data`, Microsoft Graph over HTTP answers
 * `{ "@odata.context", value: [...] }` — often as JSON TEXT in `body` — and a
 * mail's headers are a list of `{ name, value }` pairs. Auto-map used to look
 * one level down and give up; the author then mapped by hand what a person
 * would call obvious. This walk:
 *
 *   - follows objects and JSON text (the runtime reads through JSON text:
 *     shared/expr/path.mjs stepInto), to DEEP_LIMITS.depth key levels;
 *   - sees a list's element as the UNION of its first elements' keys, so a
 *     key only row 2 has (or a list that starts with null) still counts;
 *   - offers a list of name/value pairs entry by entry
 *     (`headers[name="Subject"].value`), the runtime's match segment;
 *   - counts how deep a field sits WITHOUT the wrapper keys that mean nothing
 *     (`data`, `attributes`, `body`…), so `data.attributes.email` is as near
 *     as a top-level `email`.
 *
 * Every path is written with the runtime grammar's own writers (appendKey,
 * appendWildcard, appendMatch), so what auto-map binds resolves at run time.
 * Pure. Port of agent-hub `Builder/mapping/deepFields.ts`, line for line;
 * deepen.lockstep.test.ts holds the two to the same answers.
 */
import { appendKey, appendMatch, appendWildcard, formatPath, getPath, parsePath } from '@/shared/expr';

import { keyOf, sameTok } from './pathTokens';
import type { Tok } from './pathTokens';
// One copy of the element-shape and JSON-text primitives: the field tree the
// pickers draw from (upstream/fieldTree.ts) and this walk read data the same way.
import { isRecord, jsonTextValue, mergeElements, pairKeysOf, sameName, textHidesKey } from './upstream/fieldTree';
import { forEachOutputPath } from './upstream/forEachShape';
import { isDiagnosticOutputKey } from './upstream/stepPayload';

export { isRecord };

export const DEEP_LIMITS = Object.freeze({
    /** Key levels below the base (JSON text inside JSON text counts each level it opens). */
    depth: 12,
    /** Keys read per object. */
    keys: 100,
    /** Named entries offered per list of name/value pairs. */
    entries: 50,
    /** Positions one walk visits in total. */
    nodes: 3000,
    /** Lists inside lists before the walk stops going down. */
    lists: 4,
});

/** Keys that only wrap the payload; a field under them is as near as one beside them. */
export const WRAPPER_KEYS = new Set([
    'data', 'result', 'results', 'value', 'values', 'items', 'payload', 'body', 'response',
    'record', 'records', 'attributes', 'fields', 'properties', 'output', 'object', 'content',
]);

/**
 * A key reduced to what a person means by it: case, separators (snake, camel,
 * kebab, spaces) and accents do not count. `First-Name`, `first_name`,
 * `firstName` and `Prénom`/`prenom` each compare equal to their own kind.
 */
export function foldKey(name: unknown): string {
    return String(name ?? '')
        .normalize('NFD')
        .replace(/[\u0300-\u036f]/g, '')
        .toLowerCase()
        .replace(/[^a-z0-9]/g, '');
}

/** The value a position holds as far as the runtime is concerned: JSON text is the object it encodes. */
export function asValue(v: unknown): unknown {
    const parsed = jsonTextValue(v);
    return parsed === undefined ? v : parsed;
}

/**
 * ONE element standing for a whole list (fieldTree.mergeElements: the keys of
 * its first rows merged, nulls skipped, records preferred), also for a list
 * that arrives as JSON text. Null for an empty list.
 */
export function mergeElementSamples(list: unknown): unknown {
    return mergeElements(asValue(list));
}

const hasOwn = (o: object, k: string): boolean => Object.prototype.hasOwnProperty.call(o, k);

/** `first` over `shape`: what `first` holds wins (also '' or null, also its own list); a key it lacks comes from `shape`. */
function overFirst(first: unknown, shape: unknown, depth: number): unknown {
    const own = asValue(first);
    if (!isRecord(own) || !isRecord(shape) || depth >= DEEP_LIMITS.depth) return first;
    const fromText = typeof first === 'string';
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(own)) {
        if (!textHidesKey(fromText, k)) out[k] = hasOwn(shape, k) ? overFirst(own[k], shape[k], depth + 1) : own[k];
    }
    for (const k of Object.keys(shape)) if (!hasOwn(out, k) && !textHidesKey(fromText, k)) out[k] = shape[k];
    return out;
}

/**
 * The item a list is PREVIEWED by: its first element as the run's first
 * iteration binds it, with only the keys it lacks filled in from `shape` (the
 * union of the rows, mergeElementSamples) so a field only a later row has
 * still shows. The union itself is no preview: it takes each value from
 * whichever row says something and strings the rows' lists together, an item
 * that never exists. A first element that is not a record (null, a scalar)
 * gives `shape`.
 */
export function firstItemOver(list: unknown, shape: unknown): unknown {
    const arr = asValue(list);
    if (!Array.isArray(arr) || !isRecord(asValue(arr[0])) || !isRecord(shape)) return shape;
    return overFirst(arr[0], shape, 0);
}

/** firstItemOver with the union of the rows: the item to preview a list by; null for an empty list. */
export function firstItemPreview(list: unknown): unknown {
    return firstItemOver(list, mergeElementSamples(list));
}

/** One list on the way down: its path and the element that stands for it. */
export interface ListLevel { path: string; element: unknown }

export interface DeepNode {
    /** The key as the data spells it (for a name/value entry: the entry's name). */
    key: string;
    path: string;
    value: unknown;
    /** Key levels below the base. */
    depth: number;
    /** Key levels that are not wrappers: how far away it FEELS. */
    weight: number;
    /** The lists above it, outermost first (`[*]` in its path). */
    chain: ListLevel[];
    /** An entry of a name/value list (`headers[name="Subject"].value`). */
    pair?: boolean;
}

/** `[{name:'Subject', value:'Hi'}, …]` → its entries, first of equal names only (the runtime's match takes the first). */
export interface PairEntry { name: string; nameKey: string; valueKey: string; value: unknown }

export function pairEntries(list: unknown): PairEntry[] {
    const arr = asValue(list);
    const keys = Array.isArray(arr) ? pairKeysOf(arr) : null;
    if (!keys || !Array.isArray(arr)) return [];
    const out: PairEntry[] = [];
    for (const raw of arr) {
        const r = asValue(raw);
        if (out.length >= DEEP_LIMITS.entries) break;
        if (!isRecord(r) || typeof r[keys.name] !== 'string') continue;
        const name = r[keys.name] as string;
        // The runtime's match rule (path.mjs stepMatch): case does not count, accents do.
        if (!name.trim() || out.some(e => sameName(e.name, name))) continue;
        out.push({ name, nameKey: keys.name, valueKey: keys.value, value: r[keys.value] });
    }
    return out;
}

/**
 * Visit every position under `value` (not the base itself). Objects open into
 * their keys, JSON text into what it encodes, a list into its merged element
 * at `[*]` and, when it is a list of name/value pairs, into its entries.
 */
export function walkDeep(value: unknown, basePath: string, visit: (node: DeepNode) => void): void {
    let budget = DEEP_LIMITS.nodes;
    type At = { path: string; depth: number; weight: number; chain: ListLevel[] };
    const rec = (raw: unknown, at: At) => {
        const { path, depth, weight, chain } = at;
        if (budget <= 0 || depth >= DEEP_LIMITS.depth) return;
        const v = asValue(raw);
        if (isRecord(v)) {
            // A record read out of JSON text: the keys a path cannot reach
            // through text are not offered (fieldTree textHidesKey).
            const fromText = typeof raw === 'string';
            for (const k of Object.keys(v).slice(0, DEEP_LIMITS.keys)) {
                if (textHidesKey(fromText, k)) continue;
                if (budget-- <= 0) return;
                const child = v[k];
                const p = appendKey(path, k);
                const w = weight + (WRAPPER_KEYS.has(k.toLowerCase()) ? 0 : 1);
                visit({ key: k, path: p, value: child, depth: depth + 1, weight: w, chain });
                rec(child, { path: p, depth: depth + 1, weight: w, chain });
            }
            return;
        }
        if (Array.isArray(v) && chain.length < DEEP_LIMITS.lists) {
            const element = mergeElementSamples(v);
            if (element != null) rec(element, { path: appendWildcard(path), depth, weight, chain: [...chain, { path, element }] });
            for (const e of pairEntries(v)) {
                if (budget-- <= 0) return;
                const p = appendKey(appendMatch(path, e.nameKey, e.name), e.valueKey);
                visit({ key: e.name, path: p, value: e.value, depth: depth + 1, weight: weight + 1, chain, pair: true });
            }
        }
    };
    rec(value, { path: basePath, depth: 0, weight: 0, chain: [] });
}

/**
 * Every ONE-VALUE position under `value`: scalars and whole lists, never a
 * column of a list (that is one value per row) and never a record. Nearest
 * first: fewer meaningful levels, then fewer levels, then data order.
 */
export function deepValueFields(value: unknown, basePath: string): DeepNode[] {
    const out: DeepNode[] = [];
    walkDeep(value, basePath, (n) => {
        if (n.chain.length) return;
        if (isRecord(asValue(n.value))) return;
        out.push(n);
    });
    return out.map((n, i) => ({ n, i }))
        .sort((a, b) => (a.n.weight - b.n.weight) || (a.n.depth - b.n.depth) || (a.i - b.i))
        .map(x => x.n);
}

export interface ListSource {
    /** The list's path (`steps.s.output.data.object.lines.data`, `…results[*].output.attachments`). */
    path: string;
    /** Its last key (`data`, `attachments`); '' for a list at the base itself. */
    key: string;
    /** One element standing for all (mergeElementSamples). */
    element: unknown;
    depth: number;
    weight: number;
    /** The lists it sits inside, outermost first; empty for a plain list. */
    chain: ListLevel[];
}

/**
 * Every list under (and at) `basePath` a step could run once per item over,
 * in data order. A list inside a list's elements is flattened across them at
 * run time (`results[*].output.attachments`), and carries its outer lists in
 * `chain` so a per-item step over it can keep the element it came from.
 */
export function listSources(value: unknown, basePath: string): ListSource[] {
    const out: ListSource[] = [];
    const top = asValue(value);
    if (Array.isArray(top)) out.push({ path: basePath, key: '', element: mergeElementSamples(top), depth: 0, weight: 0, chain: [] });
    walkDeep(value, basePath, (n) => {
        if (n.pair) return;
        const v = asValue(n.value);
        if (!Array.isArray(v)) return;
        out.push({ path: n.path, key: n.key, element: mergeElementSamples(v), depth: n.depth, weight: n.weight, chain: n.chain });
    });
    return out;
}

// ── groups ──────────────────────────────────────────────────────────────────

/** A field of an upstream group, as the describers build it. */
export interface GroupField { key: string; path: string; sample?: unknown; children?: GroupField[]; perIteration?: boolean }
/** An upstream group (computeUpstreamGroups). */
export interface UpstreamGroup { id?: string; label?: string; kind?: string; basePath?: string; sample?: unknown; fields?: GroupField[]; ownItem?: boolean; forEach?: boolean }

/** Every field of a tree, parents before their children. */
export function eachGroupField(fields: readonly GroupField[] | null | undefined, fn: (f: GroupField) => void): void {
    for (const f of fields || []) {
        fn(f);
        if (f.children) eachGroupField(f.children, fn);
    }
}

/** How far a path sits below its base, counting only keys that mean something (see WRAPPER_KEYS). */
export function weightBelow(path: string, basePath: string): { depth: number; weight: number } {
    const t = (parsePath(path) || []) as Tok[];
    const b = (parsePath(basePath || '') || []) as Tok[];
    const rest = t.slice(b.length).filter(x => x.type !== 'wild');
    const weight = rest.filter(x => !(x.type === 'prop' && typeof x.key === 'string' && WRAPPER_KEYS.has(x.key.toLowerCase()))).length;
    return { depth: rest.length, weight };
}

/** The group's sample filed under its base path, so any of its paths resolves against it. */
function rootFor(group: UpstreamGroup): unknown {
    const t = (parsePath(group.basePath || '') || []) as Tok[];
    if (!t.length || group.sample === undefined) return null;
    let root: unknown = group.sample;
    for (let i = t.length - 1; i >= 0; i--) root = { [String(keyOf(t[i]))]: root };
    return root;
}

/**
 * Is `path` one of its step's diagnostics (a Code step's `logs`), where the
 * step's output sits: at the base, or at each iteration's output for a step
 * that runs once per item? A run report, never a list to run over.
 */
function isDiagnosticPath(group: UpstreamGroup, path: string): boolean {
    const base = group.basePath || '';
    const at = (parsePath(group.forEach ? forEachOutputPath(base) : base) || []) as Tok[];
    const t = (parsePath(path) || []) as Tok[];
    const next = t[at.length];
    return next?.type === 'prop' && typeof next.key === 'string' && isDiagnosticOutputKey(group.kind, next.key)
        && at.every((tok, i) => sameTok(tok, t[i]));
}

/**
 * Every list of a group a step could run per item over: the fields the
 * describers offer (any depth), then the lists only the sample shows. A list
 * inside a list (`results[*].output.attachments`) carries its outer lists.
 * A step's diagnostics (a Code step's `logs`) are never one of them.
 */
export function groupListSources(group: UpstreamGroup): ListSource[] {
    const base = group.basePath || '';
    const root = rootFor(group);
    const out: ListSource[] = [];
    const seen = new Set<string>();
    const chainOf = (path: string): ListLevel[] => {
        const t = (parsePath(path) || []) as Tok[];
        const chain: ListLevel[] = [];
        t.forEach((tok, i) => {
            if (tok.type !== 'wild') return;
            const p = formatPath(t.slice(0, i)) as string;
            chain.push({ path: p, element: root ? mergeElementSamples(getPath(root, p)) : null });
        });
        return chain;
    };
    eachGroupField(group.fields, (f) => {
        if (f.perIteration || seen.has(f.path) || !Array.isArray(asValue(f.sample)) || isDiagnosticPath(group, f.path)) return;
        seen.add(f.path);
        out.push({ path: f.path, key: f.key, element: mergeElementSamples(f.sample), ...weightBelow(f.path, base), chain: chainOf(f.path) });
    });
    for (const s of listSources(group.sample, base)) {
        if (seen.has(s.path) || isDiagnosticPath(group, s.path)) continue;
        seen.add(s.path);
        out.push(s);
    }
    return out;
}

/**
 * Every ONE-VALUE field of a group (never a list column, never per
 * iteration): the describers' fields, then what only the sample shows —
 * deeper keys, keys inside JSON text, name/value entries.
 */
export type ValueField = GroupField & { depth: number; weight: number };

export function groupValueFields(group: UpstreamGroup): ValueField[] {
    const base = group.basePath || '';
    const out: ValueField[] = [];
    const seen = new Set<string>();
    eachGroupField(group.fields, (f) => {
        if (f.perIteration || seen.has(f.path) || f.path.includes('[*]')) return;
        seen.add(f.path);
        out.push({ key: f.key, path: f.path, sample: f.sample, ...weightBelow(f.path, base) });
    });
    for (const n of deepValueFields(group.sample, base)) {
        if (seen.has(n.path)) continue;
        seen.add(n.path);
        out.push({ key: n.key, path: n.path, sample: n.value, depth: n.depth, weight: n.weight });
    }
    return out;
}
