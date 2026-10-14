import { createContext, useContext, useMemo, type ReactNode } from 'react';
import { dataCacheKey } from './resolveBinding';
import type { DataEntry, DataState } from './DataContext';

/**
 * App Studio runtime — the context every rendered component reads.
 *
 * One renderer serves both the editor canvas and the end-user run view; this
 * context is how components know which world they are in:
 *
 *   mode             — 'edit' | 'run'. In edit mode components render inert
 *                      (buttons don't fire, forms don't submit) and hidden
 *                      nodes stay findable; in run mode everything is live.
 *   selectedNodeId   — node highlighted on the editor canvas (null in run)
 *   onSelectNode     — editor selection callback (id | null)
 *   recentlyAddedIds — Set of node ids to flash as "just added"
 *   actionState      — { [actionId]: { status, result, error } } (see
 *                      useActionRunner.ts — the editor passes a stub)
 *   dataState        — { [cacheKey]: { status, result, error } } for
 *                      record/records/dataset bindings (see DataContext.jsx)
 *   runAction        — (actionId, opts) → void|Promise; the editor stubs it
 *   setVar           — (name, value) → void; writes the shared `vars` map
 *                      (useActionRunner.setVar). Interactive components
 *                      (filter_bar) use it to publish state like vars.filters;
 *                      surfaces that don't wire it fall back to the no-op
 *                      default and the component degrades to local state.
 *   registerFormValue— optional editor hook observing form field values
 *   currentUser      — { id, name, email, … } | null, exposed to formulas
 *   scope            — the memoized shared expression-scope root (buildScope);
 *                      AppRenderer extends it per-row for repeater item scope
 *                      and publishes the extension through ScopeProvider, so
 *                      useRuntime().scope is ALWAYS the scope of the subtree
 *                      the component actually sits in (see ScopeProvider).
 *
 * useRuntime() never throws: components rendered outside a provider (tests,
 * Storybook-style previews) get an inert run-mode default.
 */

const noop = () => {};
const EMPTY_SET = new Set<string>();

/** The inputs buildScope folds into the expression-scope root. */
export interface BuildScopeInput {
    actionState?: Record<string, unknown> | null;
    dataState?: DataState | null;
    form?: Record<string, unknown> | null;
    forms?: Record<string, unknown> | null;
    screen?: Record<string, unknown> | null;
    vars?: Record<string, unknown> | null;
    currentUser?: unknown;
    item?: unknown;
    index?: unknown;
    value?: unknown;
    now?: unknown;
    today?: unknown;
}

/** First claim wins the short scope name; a strictly better rank takes it over. */
function claimShortName(claimed: Record<string, number>, name: string, rank: number): boolean {
    if (Object.prototype.hasOwnProperty.call(claimed, name) && claimed[name] >= rank) return false;
    claimed[name] = rank;
    return true;
}

/** How strong a dataState entry's claim on its short scope name is (see buildScope). */
function shortNameRank(cacheKey: string, entry: DataEntry): number {
    if (entry.connectorId != null) {
        return cacheKey === dataCacheKey({ kind: 'connector', connectorId: entry.connectorId }) ? 1 : 0;
    }
    // An aggregate is tagged with the same tableId as a real row list, but its
    // rows are counts/totals — never records. Left at the default rank it could
    // win `records.<tableId>` and hand a formula [{count: 3}] where the author
    // meant the rows. Rank 0 keeps it addressable by full cache key only.
    if (String(cacheKey).startsWith('aggregate:')) return 0;
    const kind = String(cacheKey).startsWith('record:') ? 'record' : 'records';
    return (kind === 'records' ? 2 : 0)
        + (cacheKey === dataCacheKey({ kind, tableId: entry.tableId }) ? 1 : 0);
}

/**
 * buildScope(input) → the shared expression-scope ROOT object, IDENTICAL in
 * shape everywhere a formula evaluates (client runtime, inspector live-eval,
 * server). Keep this list in lockstep with the engine's scope-adapter root:
 *   { actions, form, forms, screen, vars, item, index, value, currentUser,
 *     records, datasets, connectors, now, today }
 *
 *   actions   — the actionState map ({ [id]: { status, result, error } }); a
 *               formula reads `actions.<id>.result`.
 *   records   — { [tableId]: rows }  derived from dataState entries
 *   datasets  — { [datasetId]: value } derived from dataState entries
 *   connectors— { [connectorId]: rows } derived from dataState entries
 *   now/today — ISO timestamp / YYYY-MM-DD date string. Pass them in to stamp
 *               ONCE per render pass; omitted → stamped fresh here.
 *
 * One screen can read the SAME table (or connector) through several queries,
 * but a formula can only name the table — so every entry is additionally
 * exposed under its exact cache key (collision-free) and the short name is
 * awarded by rank instead of by whoever was written last: a plain `records`
 * list beats a `record` lookup, an unfiltered query beats a filtered one, and
 * ties go to the first entry seen.
 */
export function buildScope(input: BuildScopeInput = {}) {
    const {
        actionState = {},
        dataState = {},
        form = {},
        forms = {},
        screen = {},
        vars = {},
        currentUser = null,
        item,
        index,
        value,
        now,
        today,
    } = input;

    const records: Record<string, unknown> = {};
    const datasets: Record<string, unknown> = {};
    const connectors: Record<string, unknown> = {};
    const claimed: Record<string, number> = {};
    for (const [cacheKey, rawEntry] of Object.entries((dataState || {}) as DataState)) {
        if (!rawEntry || typeof rawEntry !== 'object') continue;
        const entry = rawEntry as DataEntry;
        if (entry.connectorId != null) {
            connectors[cacheKey] = entry.result;
            if (claimShortName(claimed, `connector:${entry.connectorId}`, shortNameRank(cacheKey, entry))) {
                connectors[entry.connectorId] = entry.result;
            }
        } else if (entry.datasetId != null) {
            datasets[entry.datasetId] = entry.result;
        } else if (entry.tableId != null) {
            records[cacheKey] = entry.result;
            if (claimShortName(claimed, `table:${entry.tableId}`, shortNameRank(cacheKey, entry))) {
                records[entry.tableId] = entry.result;
            }
        }
    }

    const stampNow = typeof now === 'string' ? now : new Date().toISOString();
    const stampToday = typeof today === 'string' ? today : stampNow.slice(0, 10);

    return {
        actions: actionState || {},
        form: form || {},
        forms: forms || {},
        screen: screen || {},
        vars: vars || {},
        item,
        index,
        value,
        currentUser: currentUser || null,
        records,
        datasets,
        connectors,
        now: stampNow,
        today: stampToday,
    };
}

/** The expression-scope root buildScope returns. */
export type ExpressionScope = ReturnType<typeof buildScope>;

/** What every rendered component reads through useRuntime(). */
export interface RuntimeValue {
    mode: 'edit' | 'run';
    selectedNodeId: string | null;
    /** Multi-select (editor only); null when the caller passes a single selection. */
    selectedNodeIds?: ReadonlySet<string> | null;
    onSelectNode: (id: string | null) => void;
    recentlyAddedIds: ReadonlySet<string>;
    /** The role the editor previews the app as (editor only); null for the owner's full view. */
    previewRole?: string | null;
    actionState: Record<string, unknown>;
    dataState: DataState;
    runAction: (actionId: string, opts?: unknown) => unknown;
    /** Absent when the surface does not wire action variables (see AppRenderer). */
    setVar?: (name: string, value: unknown) => void;
    registerFormValue: ((key: string, value: unknown) => void) | null;
    currentUser: unknown;
    // App Design v2, resolved once by AppRenderer: { ...definition.design,
    // primary } or null. Components read it for looks only — never for data.
    // null means "no design authored", which is identity rendering.
    appDesign: unknown;
    scope: ExpressionScope;
}

export const DEFAULT_RUNTIME: RuntimeValue = Object.freeze({
    mode: 'run',
    selectedNodeId: null,
    onSelectNode: noop,
    recentlyAddedIds: EMPTY_SET,
    actionState: {},
    dataState: {},
    runAction: noop,
    setVar: noop,
    registerFormValue: null,
    currentUser: null,
    // App Design v2, resolved once by AppRenderer: { ...definition.design,
    // primary } or null. Components read it for looks only — never for data.
    // null means "no design authored", which is identity rendering.
    appDesign: null,
    scope: Object.freeze(buildScope({ now: '1970-01-01T00:00:00.000Z' })),
});

const RuntimeContext = createContext<RuntimeValue>(DEFAULT_RUNTIME);

/**
 * A scope OVERRIDE for one subtree — the repeater's per-row scope and a form
 * container's `form` overlay. It must travel through context, not props:
 * every component resolves its OWN bindings against useRuntime().scope at
 * whatever depth it sits, so a scope handed down as a prop would never reach
 * them and `item.*` would read undefined inside a repeated row.
 */
const ScopeContext = createContext<ExpressionScope | null>(null);

export function RuntimeProvider({ value, children }: { value: RuntimeValue; children?: ReactNode }) {
    return <RuntimeContext.Provider value={value}>{children}</RuntimeContext.Provider>;
}

export function ScopeProvider({ scope, children }: { scope?: ExpressionScope | null; children?: ReactNode }) {
    return <ScopeContext.Provider value={scope || null}>{children}</ScopeContext.Provider>;
}

export function useRuntime(): RuntimeValue {
    const runtime = useContext(RuntimeContext) || DEFAULT_RUNTIME;
    const scope = useContext(ScopeContext);
    return useMemo(
        () => (scope && scope !== runtime.scope ? { ...runtime, scope } : runtime),
        [runtime, scope],
    );
}

/**
 * The identity of one repeated row — its record id when it has one, else its
 * position. React keys must follow the RECORD, not the index: keying by index
 * makes a reordered list reuse the previous row's component state (a half-typed
 * input jumps rows). AppRenderer and AppRepeater key their rows identically.
 */
export function rowKey(item: unknown, index: number): string {
    if (item && typeof item === 'object') {
        const rec = item as { id?: unknown; _id?: unknown; recordId?: unknown };
        const id = rec.id ?? rec._id ?? rec.recordId;
        if (typeof id === 'string' || typeof id === 'number') return `id:${id}`;
    }
    return `#${index}`;
}

/** Convenience: the current shared expression-scope root. */
export function useScope(): ExpressionScope {
    return useRuntime().scope || DEFAULT_RUNTIME.scope;
}

export default RuntimeContext;
