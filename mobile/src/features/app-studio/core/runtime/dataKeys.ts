/**
 * Data-binding cache keys and the client-side resolution of a binding's
 * dynamic parts (filters, aggregate shape, connector params) against the live
 * scope. Part of the port of agent-hub AppStudio/runtime/resolveBinding.js.
 *
 * The request only ever carries literals: formulas resolve here, before the
 * key is computed, so a vars/currentUser change refetches. Row-level security
 * on the server stays the security boundary.
 */

import { tryEvaluate } from '@/shared/expr';

import { stableStringify } from './paths';

type Binding = Record<string, unknown> & { kind?: unknown };
type Scope = Record<string, unknown> | null | undefined;

const shapeOf = (b: Binding, keys: readonly string[]) =>
    stableStringify(Object.fromEntries(keys.map((k) => [k, b[k] ?? null])));

/**
 * The cache key a record/records/aggregate/dataset/connector binding's result
 * is stored under (the same one the fetch layer writes). Null otherwise.
 */
export function dataCacheKey(binding: unknown): string | null {
    if (!binding || typeof binding !== 'object') return null;
    const b = binding as Binding;
    switch (b.kind) {
        case 'dataset':
            return `dataset:${b.datasetId ?? ''}`;
        case 'record':
        case 'records':
            return `${b.kind}:${b.tableId ?? ''}:${shapeOf(b, ['filter', 'sort', 'limit'])}`;
        case 'aggregate':
            return `aggregate:${b.tableId ?? ''}:${shapeOf(b, ['filter', 'groupBy', 'aggregates', 'sort', 'limit'])}`;
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

const NO_VALUE_FILTER_OPS = new Set(['isNull', 'isNotNull']);
const FILTERED_KINDS = new Set(['record', 'records', 'aggregate']);
const REQUIRED_UNRESOLVED = Symbol('required-unresolved');

/** One filter entry resolved: kept, rewritten, omitted (undefined) or fatal. */
function resolveEntry(entry: unknown, scope: Scope): { entry?: unknown; changed: boolean } | typeof REQUIRED_UNRESOLVED {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return { entry, changed: false };
    const e = entry as Binding;
    if (NO_VALUE_FILTER_OPS.has(e.op as string)) return { entry, changed: false };
    const { required, ...rest } = e;
    const value = resolveFilterValue(e.value, scope);
    if (value === undefined || value === null) {
        // A `required` filter scopes a component to a selection: no value, no query.
        return required ? REQUIRED_UNRESOLVED : { changed: true };
    }
    if (required) return { entry: { ...rest, value }, changed: true };
    if (value === e.value) return { entry, changed: false };
    return { entry: { ...rest, value }, changed: true };
}

/**
 * Resolve a record/records/aggregate binding's dynamic filter values. An
 * unresolved optional entry is omitted, an unresolved `required` one makes the
 * whole binding null (no query), and a filter left empty is dropped.
 */
export function resolveBindingFilters<B>(binding: B, scope: Scope): B | null {
    if (!binding || typeof binding !== 'object') return binding;
    const b = binding as Binding;
    if (!FILTERED_KINDS.has(b.kind as string)) return binding;
    if (!Array.isArray(b.filter) || b.filter.length === 0) return binding;

    let changed = false;
    const filter: unknown[] = [];
    for (const entry of b.filter) {
        const res = resolveEntry(entry, scope);
        if (res === REQUIRED_UNRESOLVED) return null;
        if (res.changed) changed = true;
        if ('entry' in res) filter.push(res.entry);
    }
    if (!changed) return binding;
    if (filter.length === 0) {
        const { filter: _dropped, ...rest } = b;
        return rest as B;
    }
    return { ...b, filter } as B;
}

/**
 * Resolve a connector binding's dynamic `params`. A param resolving to
 * undefined is omitted (null/''/0/false stay). Unchanged bindings come back as-is.
 */
export function resolveBindingParams<B>(binding: B, scope: Scope): B {
    if (!binding || typeof binding !== 'object' || (binding as Binding).kind !== 'connector') return binding;
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
