import { tryEvaluate } from '@shared/expr/engine.mjs';
import { parsePath } from '@shared/expr/path.mjs';
import type { ActionMap, Bag, BagArg, DataEntry, FilterValue, PickSpec, ResolveResult, Scope } from './resolveBinding.types';
import { EMPTY } from './resolveBinding.constants';

/**
 * Does `path` read as a path RELATIVE to a value under the shared grammar?
 * The same normalisation getRelativePath applies (`$.a`, `[0].x`, `a.b`).
 */
export function isRelativePath(path: string): boolean {
    let p = path.trim();
    if (p === '' || p === '$') return true;
    if (p.startsWith('$.')) p = p.slice(2);
    else if (p.startsWith('$[')) p = p.slice(1);
    return parsePath(p.startsWith('[') ? `$${p}` : `$.${p}`) !== null;
}

/** Deterministic JSON with sorted keys — the hash half of a data cache key. */
export function stableStringify(value: unknown): string {
    if (value == null) return 'null';
    if (typeof value !== 'object') return JSON.stringify(value);
    if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
    const keys = Object.keys(value).sort();
    return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify((value as Record<string, unknown>)[k])}`).join(',')}}`;
}

/** One filter value: {kind:'formula'} → evaluated against the scope; literal → itself. */
export function resolveFilterValue(value: FilterValue, scope: Scope): FilterValue {
    if (!value || typeof value !== 'object' || value.kind !== 'formula') return value;
    const expr = value.expr;
    if (typeof expr !== 'string' || !expr.trim()) return undefined;
    return tryEvaluate(expr, scope || {}).value;
}

/** Normalize the second argument into a bag, honouring the v1 bare-actionState form. */
export function normalizeBag(arg: unknown): Bag {
    if (arg == null || typeof arg !== 'object') return EMPTY;
    if ('actionState' in arg || 'dataState' in arg || 'scope' in arg) {
        return {
            actionState: (arg as BagArg).actionState || {},
            dataState: (arg as BagArg).dataState || {},
            scope: (arg as BagArg).scope,
        };
    }
    // A bare actionState map (v1 call sites) — never carries a dataState/scope.
    return { actionState: arg as ActionMap, dataState: {}, scope: undefined };
}

/**
 * Turn a dataState entry into the standard resolve result. A key with NO entry
 * is "not started", not "loaded empty": the fetch layer registers every data
 * binding on the screen but only writes its first entry in an effect, so the
 * frame before that must render the skeleton — reporting isLoading:false there
 * flashes "No results" on every list, grid and board.
 */
export function fromDataEntry(entry: DataEntry | undefined): ResolveResult {
    if (!entry) return { value: undefined, isLoading: true, error: null, errorCode: null };
    const status = entry.status;
    const isLoading = status === 'loading' || status === 'running';
    const value = status === 'success' ? entry.result : undefined;
    // errorCode is the TYPED failure (currently only 'connection_required'),
    // written by useAppDataSource. It rode in the cache entry and stopped here,
    // so nothing downstream could tell "reconnect Gmail" apart from "the
    // server broke" — and ErrorText's whole connection branch was unreachable.
    return { value, isLoading, error: entry.error ?? null, errorCode: entry.errorCode ?? null };
}

/**
 * Narrow a row-shaped result to the ONE value `pick` names. An out-of-range or
 * absent row/column resolves to undefined (the component then shows its own
 * empty state) — never throws, because a half-configured pick is a normal
 * editor state. No `pick` returns the value untouched.
 */
export function applyPick(value: unknown, pick: PickSpec | null | undefined): unknown {
    if (!pick || typeof pick !== 'object' || Array.isArray(pick)) return value;
    let row = value;
    if (Array.isArray(row)) {
        if (row.length === 0) return undefined;
        row = pick.row === 'last' ? row[row.length - 1] : row[0];
    }
    const column = pick.column;
    if (column == null || column === '') return row;
    if (row == null || typeof row !== 'object') return undefined;
    return Object.prototype.hasOwnProperty.call(row, column) ? (row as Record<string, unknown>)[column] : undefined;
}
