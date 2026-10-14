/**
 * App Studio runtime — dynamic binding parts: filters, the aggregate shape and
 * connector params, each resolved against the live scope before the fetch
 * (resolveBinding.ts keys the cache on the result).
 */

import { tryEvaluate } from '@shared/expr/engine.mjs';
import type { Binding, BindingFilter } from './resolveBinding.types';

/** Filter ops that carry no value — their entries pass through untouched. */
const NO_VALUE_FILTER_OPS: ReadonlySet<unknown> = new Set(['isNull', 'isNotNull']);

/**
 * Resolve a record/records binding's dynamic filter values against the live
 * scope: entries whose value is { kind:'formula', expr } are evaluated with
 * the shared engine (e.g. `currentUser.id`, `vars.filters.q`); everything
 * else is left alone. Rules (contract shared with the server-side validator):
 *
 *   • isNull / isNotNull entries have no value → pass through untouched;
 *   • an entry whose (resolved) value is undefined or null is OMITTED from
 *     the outgoing filter — '' / 0 / false are legit values and stay;
 *   • a filter left empty by omission is dropped entirely, so its cache key
 *     equals the no-filter key.
 *
 * Fast path: a binding needing no change is returned AS-IS (identity-stable,
 * memo-friendly). Non-record kinds and non-array (legacy object) filters pass
 * through unchanged. Never throws — a bad formula resolves to undefined and
 * the entry is omitted, because a half-configured filter is a normal state.
 *
 * NOTE: formula filters should stick to the stable scope roots (currentUser,
 * vars, forms, screen, today). `now` differs by milliseconds between the
 * fetch layer's scope and the renderer's, which would split their cache keys.
 */
/**
 * The descriptor fields of an AGGREGATE binding that may be authored as a
 * formula and resolved, client-side, before the fetch.
 *
 * This is what makes a report the VIEWER composed renderable. An aggregate
 * binding is a query descriptor — table, group-by, measures, sort, limit — and
 * with every part of it frozen into the app definition, a chart can only ever
 * ask the one question its author wrote. Letting those parts resolve from
 * `vars` means a saved report row can BE the question: pick a dimension and a
 * measure in the running app and the same chart answers it.
 *
 * This widens no trust boundary. POST /:id/data/query has always accepted an
 * inline descriptor straight from the client, and it re-derives everything that
 * matters server-side: the table must exist in the model, rlsGateway.canRead
 * must pass for the VIEWER's role, the viewer's access filter is ANDed into the
 * WHERE, and compileAggregate rejects a field that is not a real column, an
 * alias that is not an identifier, and any aggregate function outside its own
 * list. A descriptor assembled from a row in the app's own database is strictly
 * less exotic than what that endpoint already handles.
 *
 * Resolution happens BEFORE dataCacheKey is computed (see AppDataScope), so two
 * tiles asking different questions get different cache keys and refetch when
 * the viewer changes the question — the same way a dynamic filter value does.
 */
// `tableId` stays LITERAL on purpose: it is what anchors the validator's
// field-reference checks and the server's table-access gate to something an
// author declared. The QUESTION is dynamic; the table it is asked of is not.
const AGGREGATE_SHAPE_FIELDS = ['groupBy', 'aggregates', 'sort', 'limit'];

/**
 * Resolve an aggregate binding's descriptor fields against the live scope.
 * A field authored as { kind:'formula', expr } is evaluated; anything else is
 * left exactly as it is. A formula that resolves to undefined/null leaves the
 * field ABSENT rather than sending a null the compiler would reject — a
 * half-configured report is a normal state, not an error.
 */
export function resolveBindingShape(binding: Binding | null | undefined, scope: unknown): Binding | null | undefined {
    if (!binding || typeof binding !== 'object' || binding.kind !== 'aggregate') return binding;
    let changed = false;
    const out: Binding = { ...binding };
    for (const field of AGGREGATE_SHAPE_FIELDS) {
        const raw = binding[field] as { kind?: string } | null | undefined;
        if (!raw || typeof raw !== 'object' || raw.kind !== 'formula') continue;
        changed = true;
        const value = resolveFilterValue(raw, scope);
        if (value === undefined || value === null) delete out[field];
        else out[field] = value;
    }
    return changed ? out : binding;
}

export function resolveBindingFilters(binding: Binding | null | undefined, scope: unknown): Binding | null | undefined {
    if (!binding || typeof binding !== 'object') return binding;
    if (binding.kind !== 'record' && binding.kind !== 'records' && binding.kind !== 'aggregate') return binding;
    if (!Array.isArray(binding.filter) || binding.filter.length === 0) return binding;

    let changed = false;
    const entries: unknown[] = binding.filter;
    const filter: unknown[] = [];
    for (const item of entries) {
        if (!item || typeof item !== 'object' || Array.isArray(item)) { filter.push(item); continue; }
        const entry = item as BindingFilter;
        if (NO_VALUE_FILTER_OPS.has(entry.op)) { filter.push(entry); continue; }
        const { required, ...rest } = entry;
        const value = resolveFilterValue(entry.value, scope);
        if (value === undefined || value === null) {
            // An unresolved filter is normally OMITTED, which is right for an
            // optional one (a filter_bar field nobody filled in). It is exactly
            // wrong for a filter that SCOPES a component to a selection: drop
            // "belongs to the open ticket" and the component cheerfully lists
            // every row in the table. `required` says so out loud — no value,
            // no query, no rows.
            if (required) return null;
            changed = true;
            continue;
        }
        if (required) { changed = true; filter.push({ ...rest, value }); continue; }
        if (value === entry.value) { filter.push(entry); continue; }
        changed = true;
        filter.push({ ...rest, value });
    }
    if (!changed) return binding;
    if (filter.length === 0) {
        const { filter: _dropped, ...rest } = binding;
        return rest;
    }
    return { ...binding, filter };
}

/** One filter value: {kind:'formula'} → evaluated against the scope; literal → itself. */
function resolveFilterValue(value: unknown, scope: unknown): unknown {
    if (!value || typeof value !== 'object' || (value as { kind?: unknown }).kind !== 'formula') return value;
    const expr = (value as { expr?: unknown }).expr;
    if (typeof expr !== 'string' || !expr.trim()) return undefined;
    return tryEvaluate(expr, scope || {}).value;
}

/**
 * Resolve a connector binding's dynamic `params` against the live scope: a
 * value that is { kind:'formula', expr } is evaluated (e.g. `vars.filters.q`,
 * `currentUser.id`); literals pass through. A param resolving to `undefined`
 * (unset formula / failed eval) is OMITTED — `null`/''/0/false are legit values
 * and stay. The same stable-scope-roots caveat as filters applies (avoid `now`).
 *
 * Fast path: an unchanged binding is returned AS-IS (memo-friendly). Non-
 * connector kinds and non-object params pass through. Never throws.
 */
export function resolveBindingParams(binding: Binding | null | undefined, scope: unknown): Binding | null | undefined {
    if (!binding || typeof binding !== 'object' || binding.kind !== 'connector') return binding;
    const params = binding.params;
    if (!params || typeof params !== 'object' || Array.isArray(params)) return binding;

    let changed = false;
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(params)) {
        const value = resolveFilterValue(v, scope);
        if (value === undefined) { changed = true; continue; } // omit unresolved
        if (value !== v) changed = true;
        out[k] = value;
    }
    if (!changed) return binding;
    return { ...binding, params: out };
}
