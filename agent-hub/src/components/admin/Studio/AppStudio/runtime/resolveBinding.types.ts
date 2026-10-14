/**
 * App Studio runtime — the shapes resolveBinding reads and returns. The binding
 * vocabulary is owned by server/appStudio/componentSpecs.js; these are the
 * members the runtime names, split out of resolveBinding.ts for its size budget.
 */

/** A binding as the server validator describes it. Only the members read here are named. */
export interface Binding {
    kind?: string;
    value?: unknown;
    expr?: unknown;
    actionId?: string;
    path?: string;
    tableId?: string;
    datasetId?: string;
    connectorId?: string;
    filter?: unknown;
    sort?: unknown;
    limit?: unknown;
    groupBy?: unknown;
    aggregates?: unknown;
    params?: unknown;
    pick?: unknown;
    [key: string]: unknown;
}

/** One dynamic filter entry: { field, op, value, required? }. */
export interface BindingFilter {
    field?: string;
    op?: string;
    value?: unknown;
    required?: boolean;
    [key: string]: unknown;
}

/** The `dataState` entry a fetch layer writes under a cache key. */
export interface DataEntry {
    status?: string;
    result?: unknown;
    error?: unknown;
    errorCode?: unknown;
}

/** What resolveBinding returns. */
export interface BindingResult {
    value: unknown;
    isLoading: boolean;
    error: unknown;
    errorCode: string | null;
}
