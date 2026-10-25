/**
 * App Studio runtime — binding resolution (v2).
 *
 * Binding shapes (owned by server/appStudio/componentSpecs.js, authoritative):
 *   { kind: 'static', value }
 *   { kind: 'actionResult', actionId, path }
 *   { kind: 'formula', expr }                         — restricted-JS expression
 *   { kind: 'record',  tableId, filter?, sort?, limit? } — one/first row
 *   { kind: 'records', tableId, filter?, sort?, limit? } — a list of rows
 *   { kind: 'dataset', datasetId, pick? }             — a named dataset
 *   { kind: 'connector', connectorId, params? }       — rows from an external
 *                                                       source (run acts-as-owner)
 *
 * PICK narrows a row-shaped result to ONE value: `pick: { row, column }` takes
 * the first (or last) row and reads one column out of it — what a stat tile
 * means by "the number", where the source itself resolves to a row array. It is
 * a READ-SIDE lens only: dataCacheKey ignores it, so two tiles picking different
 * columns of the same query still share one fetch. A binding without `pick`
 * resolves exactly as it always has.
 *
 * CONNECTOR PARAMS mirror dynamic filters: a `params` value may be a JSON
 * literal OR { kind:'formula', expr } resolved CLIENT-SIDE against the live
 * scope before the run (resolveBindingParams below). The server re-sanitises
 * the resolved literals; the cache key hashes them so a vars change refetches.
 *
 * DYNAMIC FILTERS: a record/records `filter` entry is { field, op, value }
 * where value is a JSON literal OR { kind:'formula', expr } resolved
 * CLIENT-SIDE against the live scope before the fetch (resolveBindingFilters
 * below). The request only ever carries literals — RLS stays the security
 * boundary. Both the fetch layer (AppDataScope) and the read path here key
 * the cache on the RESOLVED filter, so a vars/currentUser change refetches.
 *
 * The second argument is a BAG: `{ actionState, dataState, scope }`.
 *   actionState — { [actionId]: { status, result, error } } (useActionRunner.ts)
 *   dataState   — { [cacheKey]: { status, result, error, tableId?, datasetId? } }
 *                 (DataContext.jsx — mirrors actionState's status vocabulary)
 *   scope       — the shared expression-scope root (buildScope) used by formulas
 *
 * Back-compat: v1 call sites pass a BARE actionState as the second argument
 * (`resolveBinding(binding, actionState)`). A second arg that is NOT a bag
 * (no own `actionState`/`dataState`/`scope` key) is treated as
 * `{ actionState: arg, dataState: {} }`, so old callers keep working verbatim.
 *
 * Everything here is defensive by contract: malformed bindings, missing
 * actions, dead paths and bad formulas resolve to `{ value: undefined }` —
 * they never throw, because a half-configured binding is a normal editor state.
 */
import { tryEvaluate } from '@shared/expr/engine.mjs';
import { getRelativePath } from '@shared/expr/path.mjs';
import type { Binding, BindingInput, DataBinding, DataMap, ResolveResult, Scope } from './resolveBinding.types';
import { NO_VALUE_FILTER_OPS, AGGREGATE_SHAPE_FIELDS } from './resolveBinding.constants';
import { isRelativePath, stableStringify, resolveFilterValue, normalizeBag, fromDataEntry, applyPick } from './resolveBinding.helpers';

/**
 * Safe path walk with the ONE path grammar the automation runtime and the
 * server validator use (shared/expr/path.mjs): 'rows.0.title' ·
 * 'rows[0].title' · 'data["a-b"]' · 'body["@odata.nextLink"]' ·
 * 'rows[*].title' · 'headers[name="Subject"].value' · JSON text read as the
 * object it encodes. A string that is not a path at all is read as ONE key, so
 * a column called "Full name" (a component's labelKey/sideField) still reads.
 * Missing segments → undefined; never throws; never the prototype chain.
 * Signature is (value, path) — kept stable because AppList/AppKeyValue import
 * and call it that way.
 */
export function walkPath(value: unknown, path?: unknown): unknown {
    if (path == null || path === '') return value;
    if (typeof path !== 'string') return undefined;
    if (isRelativePath(path)) return getRelativePath(value, path);
    return value != null && typeof value === 'object' && Object.prototype.hasOwnProperty.call(value, path)
        ? (value as Record<string, unknown>)[path]
        : undefined;
}

/**
 * Stable cache key for a record/records/dataset binding — the SAME key the
 * DataContext fetch hook stores results under. record/records key on the
 * table + a hash of {filter,sort,limit}; dataset keys on its id.
 * Returns null for non-data bindings.
 */
export function dataCacheKey(binding: Binding | null | undefined): string | null {
    if (!binding || typeof binding !== 'object') return null;
    if (binding.kind === 'dataset') {
        return `dataset:${binding.datasetId ?? ''}`;
    }
    if (binding.kind === 'record' || binding.kind === 'records') {
        const shape = stableStringify({
            filter: binding.filter ?? null,
            sort: binding.sort ?? null,
            limit: binding.limit ?? null,
        });
        return `${binding.kind}:${binding.tableId ?? ''}:${shape}`;
    }
    if (binding.kind === 'aggregate') {
        const shape = stableStringify({
            filter: binding.filter ?? null,
            groupBy: binding.groupBy ?? null,
            aggregates: binding.aggregates ?? null,
            sort: binding.sort ?? null,
            limit: binding.limit ?? null,
        });
        return `aggregate:${binding.tableId ?? ''}:${shape}`;
    }
    if (binding.kind === 'connector') {
        // Params are resolved to literals (resolveBindingParams) BEFORE this key
        // is computed, so a vars/currentUser change splits the cache correctly.
        return `connector:${binding.connectorId ?? ''}:${stableStringify(binding.params ?? null)}`;
    }
    return null;
}

/**
 * Resolve an aggregate binding's descriptor fields against the live scope.
 * A field authored as { kind:'formula', expr } is evaluated; anything else is
 * left exactly as it is. A formula that resolves to undefined/null leaves the
 * field ABSENT rather than sending a null the compiler would reject — a
 * half-configured report is a normal state, not an error.
 */
export function resolveBindingShape(binding: Binding | null | undefined, scope: Scope): Binding | null | undefined {
    if (!binding || typeof binding !== 'object' || binding.kind !== 'aggregate') return binding;
    let changed = false;
    const out: DataBinding = { ...binding };
    for (const field of AGGREGATE_SHAPE_FIELDS) {
        const raw = binding[field];
        if (!raw || typeof raw !== 'object' || raw.kind !== 'formula') continue;
        changed = true;
        const value = resolveFilterValue(raw, scope);
        if (value === undefined || value === null) delete out[field];
        else out[field] = value;
    }
    return changed ? out : binding;
}

export function resolveBindingFilters(binding: Binding | null | undefined, scope: Scope): Binding | null | undefined {
    if (!binding || typeof binding !== 'object') return binding;
    if (binding.kind !== 'record' && binding.kind !== 'records' && binding.kind !== 'aggregate') return binding;
    if (!Array.isArray(binding.filter) || binding.filter.length === 0) return binding;

    let changed = false;
    const filter: unknown[] = [];
    for (const entry of binding.filter) {
        if (!entry || typeof entry !== 'object' || Array.isArray(entry)) { filter.push(entry); continue; }
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
export function resolveBindingParams(binding: Binding | null | undefined, scope: Scope): Binding | null | undefined {
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

/**
 * resolveBinding(binding, bagOrActionState) → { value, isLoading, error, errorCode }.
 *
 * isLoading is true while the underlying source (action / data query) is in
 * flight AND for a data binding whose cache key has no entry yet (its fetch has
 * not started — see fromDataEntry). Formula/static resolution is synchronous
 * (isLoading:false).
 *
 * `errorCode` is the TYPED failure and is null everywhere except a data query
 * that reported one ('connection_required'). Every branch spells it out rather
 * than leaving it off: a caller destructuring one result shape and not another
 * is how the connection message got lost the first time.
 */
export function resolveBinding(binding: BindingInput, arg?: unknown): ResolveResult {
    if (binding == null) {
        return { value: undefined, isLoading: false, error: null, errorCode: null };
    }
    // A BARE primitive is its own value.
    //
    // `computed` is documented to work on every prop of every component, and it
    // evaluates to a plain value — so a computed number landing on a
    // binding-typed prop (progress.value, stat.value) arrived here as `7` and
    // was dropped, leaving a progress bar reading 0/7 with seven files
    // attached. Nothing said why: the binding simply resolved to undefined.
    // Objects without a recognised `kind` still resolve to undefined below —
    // this rescues literals, not malformed bindings.
    if (typeof binding !== 'object') {
        return { value: binding, isLoading: false, error: null, errorCode: null };
    }
    const { actionState, dataState, scope } = normalizeBag(arg);

    switch (binding.kind) {
        case 'static':
            return { value: binding.value, isLoading: false, error: null, errorCode: null };

        case 'actionResult': {
            const entry = (actionState || {})[binding.actionId];
            const isLoading = entry?.status === 'running';
            const value = entry?.status === 'success' ? walkPath(entry.result, binding.path) : undefined;
            return { value, isLoading, error: entry?.status === 'error' ? (entry.error ?? null) : null, errorCode: null };
        }

        case 'formula': {
            const expr = binding.expr ?? binding.value;
            if (typeof expr !== 'string' || !expr.trim()) {
                return { value: undefined, isLoading: false, error: null, errorCode: null };
            }
            const { value, error } = tryEvaluate(expr, scope || {});
            return { value, isLoading: false, error, errorCode: null };
        }

        case 'record':
        case 'records':
        case 'aggregate':
        case 'dataset': {
            // Dynamic filters AND a dynamic aggregate shape resolve against the
            // scope BEFORE the key lookup, so the read side lands on the same
            // cache key the fetch layer (AppDataScope → useAppDataSource)
            // stored the entry under. Both halves, in the same order the
            // fetcher applies them — resolve the shape here and skip it there
            // and a chart whose groupBy comes from a variable keys itself on
            // the unresolved `{kind:'formula'}` object and waits forever on an
            // entry nobody ever fetched.
            const key = dataCacheKey(resolveBindingFilters(resolveBindingShape(binding, scope), scope));
            if (!key) return { value: undefined, isLoading: false, error: null, errorCode: null };
            const entry = fromDataEntry((dataState || {})[key]);
            if (binding.pick) return { ...entry, value: applyPick(entry.value, binding.pick) };
            // A `record` binding may name a `path` into the row it resolved.
            // The documented shape (server/appStudio/componentSpecs.js) has
            // always allowed it, but this branch only ever applied `pick`, so
            // the path was silently dropped and the value stayed the whole row
            // OBJECT. Every scalar consumer then fell back to its authored
            // literal — a page_header bound to the open record kept showing
            // "Page title" instead of that record's name. The path is a
            // read-side projection, so it deliberately stays out of
            // dataCacheKey: two headers reading different fields of the same
            // row still share one fetch.
            if (binding.kind === 'record' && binding.path) {
                return { ...entry, value: walkPath(entry.value, binding.path) };
            }
            return entry;
        }

        case 'connector': {
            // Same read discipline as record/records/dataset, but params (not
            // filters) are the dynamic part — resolved to literals so the key
            // matches the one the fetch layer stored the run result under.
            const key = dataCacheKey(resolveBindingParams(binding, scope));
            if (!key) return { value: undefined, isLoading: false, error: null, errorCode: null };
            return fromDataEntry((dataState || {})[key]);
        }

        default:
            return { value: undefined, isLoading: false, error: null, errorCode: null };
    }
}

