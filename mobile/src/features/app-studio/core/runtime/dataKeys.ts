/**
 * Data-binding cache keys and the client-side resolution of a binding's
 * dynamic parts (filters, aggregate shape, connector params) against the live
 * scope. Part of the port of agent-hub AppStudio/runtime/resolveBinding.ts.
 *
 * The request only ever carries literals: formulas resolve here, before the
 * key is computed, so a vars/currentUser change refetches. Row-level security
 * on the server stays the security boundary.
 */

import { resolveFilterList, tryEvaluate } from '@/shared/expr';

import { stableStringify } from './paths';

type Binding = Record<string, unknown> & { kind?: unknown };
type Scope = Record<string, unknown> | null | undefined;

// `orderBy` (a record read's `expand` and `fields`, an aggregate's `groupFilter`) join the key
// only when the binding has one: a binding without them keeps its key. `match` and `search` the
// same (readExtras).
const shapeOf = (b: Binding, keys: readonly string[], optional: readonly string[] = ['orderBy']) =>
    stableStringify({
        ...Object.fromEntries([
            ...keys.map((k) => [k, b[k] ?? null]),
            ...optional.filter((k) => b[k] !== undefined && b[k] !== null).map((k) => [k, b[k]]),
        ]),
        ...readExtras(b),
    });

/** `match` and `search` belong to the key only when the binding sets them (a search only on record/records). */
const readExtras = (b: Binding): Record<string, unknown> => ({
    ...(b.match ? { match: b.match } : {}),
    ...(b.search && b.kind !== 'aggregate' ? { search: b.search } : {}),
});

/** The key of a dataset binding. Parameter values join it only when there are any. */
function datasetKey(b: Binding): string {
    const p = b.params;
    const hasParams = !!p && typeof p === 'object' && !Array.isArray(p) && Object.keys(p).length > 0;
    return hasParams ? `dataset:${b.datasetId ?? ''}:${stableStringify(p)}` : `dataset:${b.datasetId ?? ''}`;
}

/**
 * The cache key a record/records/aggregate/dataset/connector binding's result
 * is stored under (the same one the fetch layer writes). Null otherwise.
 */
export function dataCacheKey(binding: unknown): string | null {
    if (!binding || typeof binding !== 'object') return null;
    const b = binding as Binding;
    switch (b.kind) {
        case 'dataset':
            return datasetKey(b);
        case 'record':
        case 'records':
            return `${b.kind}:${b.tableId ?? ''}:${shapeOf(b, ['filter', 'sort', 'limit'], ['orderBy', 'expand', 'fields'])}`;
        case 'aggregate':
            return `aggregate:${b.tableId ?? ''}:${shapeOf(b, ['filter', 'groupBy', 'aggregates', 'sort', 'limit'], ['orderBy', 'groupFilter'])}`;
        case 'connector':
            return `connector:${b.connectorId ?? ''}:${stableStringify(b.params ?? null)}`;
        default:
            return null;
    }
}

/** One value: { kind:'formula', expr } is evaluated against the scope; a literal is itself. */
function resolveFilterValue(value: unknown, scope: Scope): unknown {
    if (!value || typeof value !== 'object' || (value as Binding).kind !== 'formula') return value;
    const expr = (value as Binding).expr;
    if (typeof expr !== 'string' || !expr.trim()) return undefined;
    return tryEvaluate(expr, scope || {}).value;
}

/** Aggregate descriptor fields that may be a formula. `tableId` stays literal on purpose. */
const AGGREGATE_SHAPE_FIELDS = ['groupBy', 'aggregates', 'sort', 'limit'];

/**
 * Resolve an aggregate binding's formula fields. One that resolves to
 * undefined/null leaves the field ABSENT. Unchanged bindings come back as-is.
 */
export function resolveBindingShape<B>(binding: B, scope: Scope): B {
    if (!binding || typeof binding !== 'object' || (binding as Binding).kind !== 'aggregate') return binding;
    const b = binding as Binding;
    let changed = false;
    const out: Binding = { ...b };
    for (const field of AGGREGATE_SHAPE_FIELDS) {
        const raw = b[field];
        if (!raw || typeof raw !== 'object' || (raw as Binding).kind !== 'formula') continue;
        changed = true;
        const value = resolveFilterValue(raw, scope);
        if (value === undefined || value === null) delete out[field];
        else out[field] = value;
    }
    return (changed ? out : binding) as B;
}

const FILTERED_KINDS = new Set(['record', 'records', 'aggregate']);

/**
 * Resolve a record/records/aggregate binding's dynamic filter values. An
 * unresolved optional entry is omitted, an unresolved `required` one makes the
 * whole binding null (no query), and a filter left empty is dropped. An
 * `{ any: [...] }` group drops its unresolved clauses and is dropped itself
 * when none is left (null when it is required). Same loop as the web.
 */
export function resolveBindingFilters<B>(binding: B, scope: Scope): B | null {
    const filtered = resolveFilterClauses(binding, scope);
    return filtered === null ? null : resolveBindingSearch(filtered, scope);
}

/** A search value as the compiler takes it: a non-blank text (a finite number spelled out), or undefined. */
function searchText(value: unknown): string | undefined {
    const text = typeof value === 'number' && Number.isFinite(value) ? String(value) : value;
    return typeof text === 'string' && text.trim() !== '' ? text : undefined;
}

/**
 * A record/records binding's `search.value` made literal; a value that is no text leaves the
 * search out (an empty search box shows every row). Same rule as the web's binding planner.
 */
function resolveBindingSearch<B>(binding: B, scope: Scope): B {
    if (!binding || typeof binding !== 'object') return binding;
    const b = binding as Binding;
    const search = b.search as Record<string, unknown> | undefined;
    if ((b.kind !== 'record' && b.kind !== 'records') || !search || typeof search !== 'object' || Array.isArray(search)) return binding;
    const text = searchText(resolveFilterValue(search.value, scope));
    if (text === search.value) return binding;
    const { search: _old, ...rest } = b;
    return (text === undefined ? rest : { ...rest, search: { ...search, value: text } }) as B;
}

function resolveFilterClauses<B>(binding: B, scope: Scope): B | null {
    if (!binding || typeof binding !== 'object') return binding;
    const b = binding as Binding;
    if (!FILTERED_KINDS.has(b.kind as string)) return binding;
    if (!Array.isArray(b.filter) || b.filter.length === 0) return binding;

    const res = resolveFilterList(b.filter, (value) => resolveFilterValue(value, scope));
    if (res.status !== 'ok') return null;
    if (!res.changed) return binding;
    if (res.filters.length === 0) {
        const { filter: _dropped, ...rest } = b;
        return rest as B;
    }
    return { ...b, filter: res.filters } as B;
}

/**
 * Resolve a connector or dataset binding's dynamic `params`. A param resolving
 * to undefined is omitted (null/''/0/false stay). Unchanged bindings come back as-is.
 */
export function resolveBindingParams<B>(binding: B, scope: Scope): B {
    const kind = binding && typeof binding === 'object' ? (binding as Binding).kind : undefined;
    if (kind !== 'connector' && kind !== 'dataset') return binding;
    const params = (binding as Binding).params;
    if (!params || typeof params !== 'object' || Array.isArray(params)) return binding;
    let changed = false;
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(params)) {
        const value = resolveFilterValue(v, scope);
        if (value === undefined) {
            changed = true;
            continue;
        }
        if (value !== v) changed = true;
        out[k] = value;
    }
    return (changed ? { ...(binding as Binding), params: out } : binding) as B;
}
