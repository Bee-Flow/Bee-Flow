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
import { getRelativePath, parsePath } from '@shared/expr/path.mjs';

import { resolveBindingFilters, resolveBindingParams, resolveBindingShape } from './resolveBindingFilters';
import type { Binding, BindingFilter, BindingResult, DataEntry } from './resolveBinding.types';

export type { Binding, BindingFilter, BindingResult, DataEntry } from './resolveBinding.types';
export { resolveBindingFilters, resolveBindingParams, resolveBindingShape } from './resolveBindingFilters';


/**
 * Does `path` read as a path RELATIVE to a value under the shared grammar?
 * The same normalisation getRelativePath applies (`$.a`, `[0].x`, `a.b`).
 */
function isRelativePath(path: string): boolean {
    let p = path.trim();
    if (p === '' || p === '$') return true;
    if (p.startsWith('$.')) p = p.slice(2);
    else if (p.startsWith('$[')) p = p.slice(1);
    return parsePath(p.startsWith('[') ? `$${p}` : `$.${p}`) !== null;
}

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
export function walkPath(value: unknown, path: string | null | undefined): unknown {
    if (path == null || path === '') return value;
    if (typeof path !== 'string') return undefined;
    if (isRelativePath(path)) return getRelativePath(value, path);
    return value != null && typeof value === 'object' && Object.prototype.hasOwnProperty.call(value, path)
        ? (value as Record<string, unknown>)[path]
        : undefined;
}

/** Deterministic JSON with sorted keys — the hash half of a data cache key. */
function stableStringify(value: unknown): string {
    if (value == null) return 'null';
    if (typeof value !== 'object') return JSON.stringify(value);
    if (Array.isArray(value)) return `[${(value as unknown[]).map(stableStringify).join(',')}]`;
    const record = value as Record<string, unknown>;
    const keys = Object.keys(record).sort();
    return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(record[k])}`).join(',')}}`;
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


/** The second argument, normalised: the three roots a binding can read. */
interface ResolveBag {
    actionState: Record<string, unknown>;
    dataState: Record<string, DataEntry | undefined>;
    scope: unknown;
}

const EMPTY: ResolveBag = Object.freeze({ actionState: {}, dataState: {}, scope: undefined });

/** Normalize the second argument into a bag, honouring the v1 bare-actionState form. */
function normalizeBag(arg: unknown): ResolveBag {
    if (arg == null || typeof arg !== 'object') return EMPTY;
    if ('actionState' in arg || 'dataState' in arg || 'scope' in arg) {
        const bag = arg as Partial<ResolveBag>;
        return {
            actionState: bag.actionState || {},
            dataState: bag.dataState || {},
            scope: bag.scope,
        };
    }
    // A bare actionState map (v1 call sites) — never carries a dataState/scope.
    return { actionState: arg as Record<string, unknown>, dataState: {}, scope: undefined };
}

/**
 * Turn a dataState entry into the standard resolve result. A key with NO entry
 * is "not started", not "loaded empty": the fetch layer registers every data
 * binding on the screen but only writes its first entry in an effect, so the
 * frame before that must render the skeleton — reporting isLoading:false there
 * flashes "No results" on every list, grid and board.
 */
function fromDataEntry(entry: DataEntry | undefined): BindingResult {
    if (!entry) return { value: undefined, isLoading: true, error: null, errorCode: null };
    const status = entry.status;
    const isLoading = status === 'loading' || status === 'running';
    const value = status === 'success' ? entry.result : undefined;
    // errorCode is the TYPED failure (currently only 'connection_required'),
    // written by useAppDataSource. It rode in the cache entry and stopped here,
    // so nothing downstream could tell "reconnect Gmail" apart from "the
    // server broke" — and ErrorText's whole connection branch was unreachable.
    return { value, isLoading, error: entry.error ?? null, errorCode: (entry.errorCode ?? null) as string | null };
}

/**
 * Narrow a row-shaped result to the ONE value `pick` names. An out-of-range or
 * absent row/column resolves to undefined (the component then shows its own
 * empty state) — never throws, because a half-configured pick is a normal
 * editor state. No `pick` returns the value untouched.
 */
function applyPick(value: unknown, pick: unknown): unknown {
    if (!pick || typeof pick !== 'object' || Array.isArray(pick)) return value;
    const spec = pick as { row?: unknown; column?: unknown };
    let row: unknown = value;
    if (Array.isArray(row)) {
        const items: unknown[] = row;
        if (items.length === 0) return undefined;
        row = spec.row === 'last' ? items[items.length - 1] : items[0];
    }
    const column = spec.column;
    if (column == null || column === '') return row;
    if (row == null || typeof row !== 'object') return undefined;
    return Object.prototype.hasOwnProperty.call(row, column as string)
        ? (row as Record<string, unknown>)[column as string]
        : undefined;
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
export function resolveBinding(rawBinding: unknown, arg: unknown): BindingResult {
    if (rawBinding == null) {
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
    if (typeof rawBinding !== 'object') {
        return { value: rawBinding, isLoading: false, error: null, errorCode: null };
    }
    const binding = rawBinding as Binding;
    const { actionState, dataState, scope } = normalizeBag(arg);

    switch (binding.kind) {
        case 'static':
            return { value: binding.value, isLoading: false, error: null, errorCode: null };

        case 'actionResult': {
            const entry = (actionState || {})[binding.actionId as string] as
                { status?: string; result?: unknown; error?: unknown } | undefined;
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

export default resolveBinding;
