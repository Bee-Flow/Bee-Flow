/**
 * App Studio runtime: binding resolution (v2). Port of agent-hub
 * AppStudio/runtime/resolveBinding.js, pinned by resolveBinding.lockstep.test.ts.
 *
 * resolveBinding(binding, bag) -> { value, isLoading, error, errorCode }.
 * The bag is { actionState, dataState, scope }; a bare actionState map (the
 * v1 call form) is accepted too. Everything is defensive: malformed bindings,
 * missing actions, dead paths and bad formulas resolve to { value: undefined }
 * and never throw, because a half-configured binding is a normal editor state.
 *
 * A data binding (record/records/aggregate/dataset/connector) reads the entry
 * the fetch layer stored under dataCacheKey of its RESOLVED form; a key with
 * no entry yet is "loading", not "loaded empty". `pick` narrows a row-shaped
 * result to one value and a record binding's `path` projects into the row;
 * both are read-side lenses that stay out of the cache key.
 */

import { tryEvaluate } from '@/shared/expr';

import { dataCacheKey, resolveBindingFilters, resolveBindingParams, resolveBindingShape } from './dataKeys';
import { walkPath } from './paths';

export { dataCacheKey, resolveBindingFilters, resolveBindingParams, resolveBindingShape } from './dataKeys';
export { walkPath } from './paths';

export interface ActionEntry {
    status?: string;
    result?: unknown;
    error?: unknown;
}
export interface DataEntry extends ActionEntry {
    errorCode?: string | null;
    tableId?: string;
    datasetId?: string;
    connectorId?: string;
}
export type ActionState = Record<string, ActionEntry | undefined>;
export type DataState = Record<string, DataEntry | undefined>;

export interface BindingBag {
    actionState?: ActionState;
    dataState?: DataState;
    scope?: Record<string, unknown>;
}

export interface Resolved {
    value: unknown;
    isLoading: boolean;
    error: unknown;
    errorCode: string | null;
}

const settled = (value: unknown, error: unknown = null): Resolved => ({ value, isLoading: false, error, errorCode: null });

/** Normalize the second argument into a bag, honouring the v1 bare-actionState form. */
function normalizeBag(arg: unknown): Required<Pick<BindingBag, 'actionState' | 'dataState'>> & { scope?: Record<string, unknown> } {
    if (arg == null || typeof arg !== 'object') return { actionState: {}, dataState: {}, scope: undefined };
    const bag = arg as BindingBag;
    if ('actionState' in bag || 'dataState' in bag || 'scope' in bag) {
        return { actionState: bag.actionState || {}, dataState: bag.dataState || {}, scope: bag.scope };
    }
    return { actionState: arg as ActionState, dataState: {}, scope: undefined };
}

/** A dataState entry as a result. No entry yet means the fetch has not started: loading. */
function fromDataEntry(entry: DataEntry | undefined): Resolved {
    if (!entry) return { value: undefined, isLoading: true, error: null, errorCode: null };
    const status = entry.status;
    return {
        value: status === 'success' ? entry.result : undefined,
        isLoading: status === 'loading' || status === 'running',
        error: entry.error ?? null,
        errorCode: entry.errorCode ?? null,
    };
}

/** Narrow a row-shaped result to the ONE value `pick` names; undefined when absent. */
function applyPick(value: unknown, pick: unknown): unknown {
    if (!pick || typeof pick !== 'object' || Array.isArray(pick)) return value;
    const p = pick as { row?: unknown; column?: unknown };
    let row = value;
    if (Array.isArray(row)) {
        if (row.length === 0) return undefined;
        row = p.row === 'last' ? row[row.length - 1] : row[0];
    }
    const column = p.column;
    if (column == null || column === '') return row;
    if (row == null || typeof row !== 'object') return undefined;
    return Object.prototype.hasOwnProperty.call(row, column as string) ? (row as Record<string, unknown>)[column as string] : undefined;
}

type B = Record<string, unknown>;

function resolveActionResult(binding: B, actionState: ActionState): Resolved {
    const entry = (actionState || {})[binding.actionId as string];
    const value = entry?.status === 'success' ? walkPath(entry.result, binding.path) : undefined;
    const error = entry?.status === 'error' ? (entry.error ?? null) : null;
    return { value, isLoading: entry?.status === 'running', error, errorCode: null };
}

function resolveFormula(binding: B, scope: Record<string, unknown> | undefined): Resolved {
    const expr = binding.expr ?? binding.value;
    if (typeof expr !== 'string' || !expr.trim()) return settled(undefined);
    const { value, error } = tryEvaluate(expr, scope || {});
    return settled(value, error);
}

function resolveData(binding: B, dataState: DataState, scope: Record<string, unknown> | undefined): Resolved {
    // Shape then filters, in the order the fetcher applies them, so the read
    // lands on the key the entry was stored under.
    const key = dataCacheKey(resolveBindingFilters(resolveBindingShape(binding, scope), scope));
    if (!key) return settled(undefined);
    const entry = fromDataEntry((dataState || {})[key]);
    if (binding.pick) return { ...entry, value: applyPick(entry.value, binding.pick) };
    if (binding.kind === 'record' && binding.path) return { ...entry, value: walkPath(entry.value, binding.path) };
    return entry;
}

/** Resolve a binding against the action/data state and the formula scope. */
export function resolveBinding(binding: unknown, arg?: unknown): Resolved {
    if (binding == null) return settled(undefined);
    // A bare primitive (a computed prop's plain value) is its own value.
    if (typeof binding !== 'object') return settled(binding);
    const { actionState, dataState, scope } = normalizeBag(arg);
    const b = binding as B;
    switch (b.kind) {
        case 'static':
            return settled(b.value);
        case 'actionResult':
            return resolveActionResult(b, actionState);
        case 'formula':
            return resolveFormula(b, scope);
        case 'record':
        case 'records':
        case 'aggregate':
        case 'dataset':
            return resolveData(b, dataState, scope);
        case 'connector': {
            const key = dataCacheKey(resolveBindingParams(b, scope));
            if (!key) return settled(undefined);
            return fromDataEntry((dataState || {})[key]);
        }
        default:
            return settled(undefined);
    }
}
