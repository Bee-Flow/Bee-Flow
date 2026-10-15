import { useQueryClient } from '@tanstack/react-query';
import React, { useCallback, useMemo, useSyncExternalStore } from 'react';
import type { ReactNode } from 'react';
import { requestsForBindings, subscribeBatchAvailability } from './dataBatchClient';
import { DataProvider, useDataState } from './DataContext';
import type { DataState } from './DataContext';
import { dataCacheKey, resolveBinding, resolveBindingFilters, resolveBindingParams, resolveBindingShape } from './resolveBinding';
import useAppDataSource from './useAppDataSource';

/**
 * App Studio runtime — the live-data scope.
 *
 * Wraps a subtree in a DataProvider, discovers every record/records/dataset
 * binding used on the current screen, fetches each one (via useAppDataSource —
 * react-query cached, 404/empty degrade), and hands the resolved `dataState`
 * to a render-prop child so the renderer can bind real records.
 *
 *   <AppDataScope appId={id} definition={def} screenId={sid} sample={editing}
 *                 scope={liveScope}>
 *     {(dataState, { refresh }) => <AppRenderer dataState={dataState} … />}
 *   </AppDataScope>
 *
 * `scope` (optional) is the live buildScope-shaped expression scope
 * ({ currentUser, vars, forms, screen, now, today }) that DYNAMIC filter
 * values ({ kind:'formula', expr } entries in a record/records binding's
 * filter) resolve against — client-side, before the fetch, so the request
 * only carries literals (resolveBindingFilters). The query key hashes the
 * RESOLVED filter, so a vars/currentUser change refetches automatically.
 * Without a scope, formulas resolve to undefined and their entries are
 * omitted (RLS remains the server-side boundary either way).
 *
 * The render prop's second argument carries `refresh()` — react-query
 * invalidation of every data query for this app (the ['studio-app-data',
 * appId, …] key family from useAppDataSource), so a `refresh` action step
 * refetches after a record write instead of being a no-op.
 *
 * `sample` fetches a small capped page (edit mode); false fetches live (the
 * published run view). With no data bindings on the screen NOTHING is fetched —
 * the component tree stays inert, so a definition without data (fixtures, the
 * kitchen-sink) never touches the network.
 */

const DATA_BINDING_KINDS = new Set(['record', 'records', 'aggregate', 'dataset', 'connector']);

/** Anything the deep scan walks: a node, a binding, a list of either, or a leaf value. */
type Visitable = ScreenNodeLike | Visitable[] | string | number | boolean | null | undefined;

/** A node or binding as the scan reads it. */
interface ScreenNodeLike {
    kind?: string;
    props: { liveSeconds?: unknown; liveWhile?: unknown };
    [key: string]: unknown;
}

/** One screen of the definition, as far as the data scope reads it. */
interface ScopeScreen {
    id?: string;
    name?: string;
    sections?: Visitable[];
}

/** The slice of the app definition the data scope reads. */
interface ScopeDefinition {
    screens?: ScopeScreen[];
    homeScreenId?: string;
    [key: string]: unknown;
}

/** The live expression scope the fetch layer resolves dynamic filters against. */
interface FetchScope {
    screen?: Record<string, unknown>;
    [key: string]: unknown;
}

/** A data binding: `{ kind: 'record' | 'records' | 'aggregate' | 'dataset' | 'connector', … }`. */
interface DataBinding {
    kind?: string;
    [key: string]: unknown;
}

/** How often, and while what, one binding is re-fetched. */
interface LiveSetting {
    seconds: number;
    when: unknown;
}

/** One data binding found on a screen, deduped by cache key. */
export interface BindingEntry {
    cacheKey: string;
    binding: DataBinding;
    live: LiveSetting | null;
}

/** What the render prop gets beside the data. */
export interface DataScopeControls {
    refresh: (scopeArg?: { tableId?: string; datasetId?: string } | null) => Promise<void>;
}

/** The screen the renderer would show — same fallback chain as AppRenderer. */
function resolveScreen(definition: ScopeDefinition | null | undefined, screenId: string | null | undefined) {
    const screens = definition?.screens || [];
    return screens.find((s) => s.id === screenId)
        || screens.find((s) => s.id === definition?.homeScreenId)
        || screens[0]
        || null;
}

/**
 * The fetch-layer scope must describe the SAME screen the renderer's scope
 * does, or a filter formula reading screen.name resolves one way here and
 * another way at read time — two cache keys, and the bound component waits
 * forever on an entry nobody fetched. The caller owns screen.params (its
 * navigation state); id/name come from the definition on both sides.
 */
function useFetchScope(scope: FetchScope | null | undefined, definition: ScopeDefinition | null | undefined, screenId: string | null | undefined) {
    return useMemo(() => {
        const screen = resolveScreen(definition, screenId);
        if (!screen) return scope;
        return { ...(scope || {}), screen: { ...(scope?.screen || {}), id: screen.id, name: screen.name } };
    }, [scope, definition, screenId]);
}

/**
 * Deep-scan a screen for the data bindings its components read (props.source,
 * a stat's value/trend, node.repeat/forEach, computed bindings — anywhere a
 * { kind:'record'|'records'|'dataset'|'connector' } object appears). Deduped by
 * cache key. Pure — safe to unit-test.
 *
 * Each binding carries the shortest `liveSeconds` any node asking for it
 * declared. Watching one long-running step used to mean turning on the SCREEN's
 * interval, which refetches everything on the page and reads as the app
 * twitching; a component that wants to watch itself should cost one query, not
 * the screen. The shortest wins because a shared cache key is ONE query — the
 * two components are not competing, they are sharing, and the faster one is the
 * only one that would notice being served late.
 */
export function collectDataBindings(definition: ScopeDefinition | null | undefined, screenId: string | null | undefined) {
    const screen = resolveScreen(definition, screenId);
    if (!screen) return [];

    const out: BindingEntry[] = [];
    const byKey = new Map<string, BindingEntry>();
    const visit = (value: Visitable, liveSeconds: LiveSetting | null) => {
        if (!value || typeof value !== 'object') return;
        if (Array.isArray(value)) {
            for (const v of value) visit(v, liveSeconds);
            return;
        }
        if (typeof value.kind === 'string' && DATA_BINDING_KINDS.has(value.kind)) {
            const key = dataCacheKey(value);
            if (!key) return;
            const found = byKey.get(key);
            if (!found) {
                const entry = { cacheKey: key, binding: value, live: liveSeconds };
                byKey.set(key, entry);
                out.push(entry);
            } else if (liveSeconds && (!found.live || liveSeconds.seconds < found.live.seconds)) {
                found.live = liveSeconds;
            }
            return; // a binding's own fields never hold nested data bindings we fetch
        }
        // A node's own liveSeconds applies to every binding underneath it, and
        // a child that asks for its own keeps it.
        const own = Number(value?.props?.liveSeconds) || 0;
        const inherited = own ? { seconds: own, when: value.props.liveWhile ?? null } : liveSeconds;
        for (const v of Object.values(value) as Visitable[]) visit(v, inherited);
    };
    for (const section of screen.sections || []) visit(section, null);
    return out;
}

/**
 * One hidden fetcher per binding — mirrors its react-query lifecycle into the
 * store. Dynamic filter values resolve against the live scope HERE (the
 * fetcher layer), so collectDataBindings stays static and useAppDataSource
 * stays scope-free: it only ever sees a literal-valued binding. A resolved
 * value change produces a new cache key → a fresh query (refetch).
 */
function BindingFetcher({ binding, sample, scope, refreshMs, live }: {
    binding: DataBinding;
    sample: boolean;
    scope: FetchScope | null | undefined;
    refreshMs: number;
    live: LiveSetting | null;
}) {
    const resolved = useMemo(
        () => (binding.kind === 'connector'
            ? resolveBindingParams(binding, scope)
            : resolveBindingFilters(resolveBindingShape(binding, scope), scope)),
        [binding, scope],
    );
    // A component's own interval beats the screen's, and `liveWhile` decides
    // whether it runs at all — re-evaluated on every render, so the polling
    // stops the moment the thing it was watching finishes.
    const ownMs = useMemo(() => {
        if (!live || !live.seconds) return 0;
        if (live.when == null) return live.seconds * 1000;
        return resolveBinding(live.when, { scope }).value ? live.seconds * 1000 : 0;
    }, [live, scope]);
    useAppDataSource(resolved, { sample, refreshMs: ownMs || refreshMs });
    return null;
}

/**
 * Spread the polling fleet out.
 *
 * A screen's interval applies to EVERY binding on it, so a 15s interval over 8
 * bindings is 32 requests a minute against a 60/min budget that the viewer's own
 * clicks also draw from. Scaling the interval with the REQUEST count keeps a
 * busy screen inside its budget instead of throttling the user's next click.
 *
 * Requests, not bindings, because a polling round is now one batch per dozen
 * bindings — but only where the server serves the batch route. On a page that
 * has downgraded (an older server, a transport without the route) the two
 * numbers are the same again, and the interval widens back on its own.
 */
const MIN_SPACING_MS = 2_500;

function BindingLoaders({ appId, definition, screenId, sample, scope, refreshMs }: {
    appId: string | null | undefined;
    definition: ScopeDefinition | null | undefined;
    screenId: string | null | undefined;
    sample: boolean;
    scope: FetchScope | null | undefined;
    refreshMs: number;
}) {
    const bindings = useMemo(
        () => collectDataBindings(definition, screenId),
        [definition, screenId],
    );
    const fetchScope = useFetchScope(scope, definition, screenId);
    const requestsPerRound = useSyncExternalStore(
        subscribeBatchAvailability,
        () => requestsForBindings(appId, bindings.length),
        () => bindings.length, // no batching on the server render
    );
    const effectiveMs = refreshMs ? Math.max(refreshMs, requestsPerRound * MIN_SPACING_MS) : 0;
    return bindings.map((b) => (
        <BindingFetcher
            key={b.cacheKey}
            binding={b.binding}
            sample={sample}
            scope={fetchScope}
            refreshMs={effectiveMs}
            live={b.live}
        />
    ));
}

// AppDataScope must render in provider-less environments too (unit tests,
// storybook-style previews) — refresh degrades to a no-op there. The hook call
// itself stays unconditional; only the missing-provider throw is absorbed.
function useOptionalQueryClient() {
    try {
        return useQueryClient();
    } catch {
        return null;
    }
}

function DataConsumer({ appId, children }: {
    appId: string | null | undefined;
    children?: ReactNode | ((dataState: DataState, controls: DataScopeControls) => ReactNode);
}) {
    const dataState = useDataState();
    const queryClient = useOptionalQueryClient();
    /**
     * refresh(scope?) — reload data.
     *
     * With a { tableId } or { datasetId } it invalidates only the queries that
     * read that source; with nothing it invalidates the whole app, which is the
     * pre-existing behaviour and what a v2.0 `refresh` step still gets. The
     * narrowing matters on a polling screen: reloading eight bindings because
     * one record changed is what makes an app feel like it flickers.
     */
    const refresh = useCallback((scopeArg?: { tableId?: string; datasetId?: string } | null) => {
        if (!queryClient) return Promise.resolve();
        const s = (scopeArg && typeof scopeArg === 'object') ? scopeArg : null;
        const tableId = s?.tableId || null;
        const datasetId = s?.datasetId || null;
        if (!tableId && !datasetId) {
            return queryClient.invalidateQueries({ queryKey: ['studio-app-data', appId] });
        }
        return queryClient.invalidateQueries({
            queryKey: ['studio-app-data', appId],
            // dataCacheKey puts the source id at the head of the key
            // ('records:<tableId>:<hash>', 'dataset:<id>', …) and neither a
            // table id nor a dataset id can contain ':', so a prefix match is
            // exact rather than merely likely.
            predicate: (q) => {
                const k = q.queryKey[3];
                if (typeof k !== 'string') return false;
                if (datasetId) return k === `dataset:${datasetId}`;
                return k.startsWith(`record:${tableId}:`)
                    || k.startsWith(`records:${tableId}:`)
                    || k.startsWith(`aggregate:${tableId}:`);
            },
        });
    }, [queryClient, appId]);
    const controls = useMemo(() => ({ refresh }), [refresh]);
    return typeof children === 'function' ? children(dataState, controls) : children;
}

export default function AppDataScope({ appId, definition, screenId, sample = false, draft = false, scope, refreshMs = 0, children }: {
    appId: string | null | undefined;
    definition: ScopeDefinition | null | undefined;
    screenId: string | null | undefined;
    sample?: boolean;
    draft?: boolean;
    scope?: FetchScope | null;
    refreshMs?: number;
    children?: ReactNode | ((dataState: DataState, controls: DataScopeControls) => ReactNode);
}) {
    return (
        <DataProvider appId={appId} draft={draft}>
            <BindingLoaders appId={appId} definition={definition} screenId={screenId} sample={sample} scope={scope} refreshMs={refreshMs} />
            <DataConsumer appId={appId}>{children}</DataConsumer>
        </DataProvider>
    );
}
