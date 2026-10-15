/** Types of the App Studio binding resolver (resolveBinding.ts). */

/** A filter / aggregate-shape value: a literal, or `{ kind: 'formula', expr }` resolved against the scope. */
export type FilterValue = FormulaValue | string | number | boolean | null | undefined | (unknown[] & { kind?: undefined; expr?: undefined });

export interface FormulaValue {
    kind?: string;
    expr?: unknown;
}

/**
 * The binding shapes the runtime reads (see the list in resolveBinding.ts). Authored data:
 * members are optional and loosely typed, and the resolvers below check each
 * one before use. A binding whose `kind` is none of these resolves to undefined.
 */
export interface StaticBinding {
    kind: 'static';
    value?: unknown;
}

export interface ActionResultBinding {
    kind: 'actionResult';
    actionId: string;
    path?: unknown;
}

export interface FormulaBinding {
    kind: 'formula';
    expr?: unknown;
    value?: unknown;
}

export interface DataBinding {
    kind: 'record' | 'records' | 'aggregate' | 'dataset';
    tableId?: string;
    datasetId?: string;
    filter?: unknown;
    sort?: FilterValue;
    limit?: FilterValue;
    groupBy?: FilterValue;
    aggregates?: FilterValue;
    pick?: PickSpec | null;
    path?: unknown;
}

export interface ConnectorBinding {
    kind: 'connector';
    connectorId?: string;
    params?: unknown;
}

export type Binding = StaticBinding | ActionResultBinding | FormulaBinding | DataBinding | ConnectorBinding;

/** What `resolveBinding` accepts: a binding object, or a bare primitive that is its own value. */
export type BindingInput = Binding | string | number | boolean | null | undefined;

export interface ResolveResult<V = unknown> {
    value: V | undefined;
    isLoading: boolean;
    error: unknown;
    errorCode: string | null;
}

/** `pick`: which row ('last' or the first) and which column of a row-shaped result. */
export interface PickSpec {
    row?: string;
    column?: string | null;
}

/** The expression-scope root the formulas read. */
export type Scope = Record<string, unknown> | null | undefined;

export type ActionMap = Record<string, ActionEntry | undefined>;
export type DataMap = Record<string, DataEntry | undefined>;

export interface Bag {
    actionState: ActionMap;
    dataState: DataMap;
    scope: Scope;
}

/** The second argument as received: a bag, or (v1) a bare actionState. */
export interface BagArg {
    actionState?: ActionMap;
    dataState?: DataMap;
    scope?: Scope;
}

export interface ActionEntry {
    status?: string;
    result?: unknown;
    error?: unknown;
}

export interface DataEntry extends ActionEntry {
    errorCode?: string | null;
}
