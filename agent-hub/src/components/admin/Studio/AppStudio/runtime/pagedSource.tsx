import { useQuery } from '@tanstack/react-query';
import { useEffect, useMemo, useState } from 'react';
import type { ReactElement, ReactNode } from 'react';
import { NOT_BATCHED, queueRead, unwrapReadResult } from '@/api/dataBatchClient';
import { dataErrorFromResponse, type DataError } from '@/api/dataErrors';
import { studioAppFetch } from '@/api/queries/studioApps';
import { API_BASE } from '@/utils/helpers';
import { reportAppVersion } from './appVersionSignal';
import { useHasQueryClient } from './components/comboBox';
import PagerBar from './components/PagerBar';
import { useDataContext } from './DataContext';
import type { DataEntry } from './DataContext';
import { EMPTY_PAGE, FIRST_PAGE, isPageableSource, pageKeyOf, pageOf, paginationModeOf, stepBack, stepForward } from './pagination';
import type { PageBody, PageWalk, PaginationMode } from './pagination';
import { dataCacheKey, resolveBinding, resolveBindingFilters } from './resolveBinding';
import type { BindingInput, DataBinding, ResolveResult } from './resolveBinding.types';
import { useRuntime } from './RuntimeContext';
import { qs, RATE_LIMIT_RETRY, recordLimit } from './useAppDataSource';

/**
 * App Studio runtime — server paging of a record list (see ./pagination.ts).
 *
 * usePagedSource is called by every component that offers `pagination`, always,
 * and answers in the shape resolveBinding does. Without a paging mode, over a
 * source that is not a `records` read, or where nothing can fetch (the
 * screenshot render mounts no query client), it IS resolveBinding on the source:
 * same call, same entry, same rows, no pager.
 *
 * With paging, the component owns its reads. One hidden PageLoader per page it
 * shows mirrors a react-query read into the shared data store under
 * pageKeyOf(sourceKey, cursor). The query key starts like every data query of
 * the app (['studio-app-data', appId, mode, sourceKey, …]), so a `refresh` step
 * that names the table reloads these pages too. Each page asks for `total`, a
 * count the server makes with the read's own WHERE and row rules.
 *
 * Paged reads do not poll (a node's liveSeconds keeps applying to its other
 * bindings): a list the viewer is walking should not move under them.
 */

/** What the pager bar needs. */
export interface Paging {
    mode: PaginationMode;
    /** How many pages are joined (loadMore), or which page this is, counting from 1 (prevNext). */
    pages: number;
    /** Rows before the first row shown, and how many are shown. */
    from: number;
    shown: number;
    total: number | null;
    canNext: boolean;
    canPrev: boolean;
    /** A page is on its way (the next one, or the one stepped to). */
    loading: boolean;
    /** The page after the shown rows could not be read. */
    failed: boolean;
    next: () => void;
    prev: () => void;
}

/** What a component renders: the rows (resolveBinding's shape), the hidden loaders and the bar state. */
export interface PagedSource {
    result: ResolveResult;
    loaders: ReactNode;
    paging: Paging | null;
}

/**
 * The component with its page loaders and the pager bar beside it. Without
 * paging the element comes back as it is: the same tree, nothing around it.
 */
export function withPager(paged: PagedSource, element: ReactElement): ReactElement {
    if (!paged.loaders) return element;
    return <>{paged.loaders}{element}<PagerBar paging={paged.paging} /></>;
}

/** One page of a `records` read, through the batch where the server has it, else GET …/records. */
async function fetchRecordsPage(
    appId: string, binding: DataBinding, { cursor, sample, pageKey }: { cursor: string | null; sample: boolean; pageKey: string },
): Promise<PageBody> {
    const limit = recordLimit(binding, sample);
    const id = encodeURIComponent(appId);
    const answer = await queueRead(appId, {
        id: `${sample ? 'sample' : 'live'}:${pageKey}`,
        kind: 'records',
        tableId: binding.tableId,
        filters: binding.filter ?? undefined,
        sort: binding.sort ?? undefined,
        limit,
        total: true,
        ...(cursor ? { cursor } : {}),
    });
    if (answer !== NOT_BATCHED) {
        const body = unwrapReadResult(answer.result, undefined);
        if (body === undefined) return EMPTY_PAGE;
        reportAppVersion(id, answer.appVersion as string | number | null | undefined);
        return pageOf(body);
    }
    const table = encodeURIComponent(binding.tableId ?? '');
    const query = qs({ filter: binding.filter, sort: binding.sort, limit, sample: sample ? 1 : undefined, cursor: cursor ?? undefined, total: 1 });
    const res = await studioAppFetch(`${API_BASE}/api/studio-apps/${id}/data/tables/${table}/records${query}`);
    if (res.status === 404) return EMPTY_PAGE;
    let body = null;
    try { body = await res.json(); } catch { body = null; }
    if (!res.ok) throw dataErrorFromResponse(res, body, 'Could not load records');
    reportAppVersion(id, body?.appVersion);
    return pageOf(body);
}

interface PageLoaderProps {
    appId: string;
    binding: DataBinding;
    sourceKey: string;
    cursor: string | null;
    sample: boolean;
}

/** Fetch-only: one page into the shared data store, held while it is mounted. */
function PageLoader({ appId, binding, sourceKey, cursor, sample }: PageLoaderProps): null {
    const { setEntry, retainEntry, releaseEntry } = useDataContext();
    const pageKey = pageKeyOf(sourceKey, cursor);
    const query = useQuery<PageBody, DataError>({
        queryKey: ['studio-app-data', appId, sample ? 'sample' : 'live', sourceKey, 'page', cursor ?? ''],
        queryFn: () => fetchRecordsPage(appId, binding, { cursor, sample, pageKey }),
        staleTime: 30_000,
        refetchIntervalInBackground: false,
        ...RATE_LIMIT_RETRY,
    });
    const tableId = binding.tableId ?? null;
    useEffect(() => {
        setEntry(pageKey, {
            status: query.isError ? 'error' : query.isSuccess ? 'success' : 'loading',
            result: query.data,
            error: query.error ? (query.error.message || String(query.error)) : null,
            errorCode: query.error?.code ?? null,
            tableId,
        });
    }, [pageKey, query.data, query.isError, query.isSuccess, query.error, setEntry, tableId]);
    useEffect(() => {
        retainEntry(pageKey);
        return () => releaseEntry(pageKey);
    }, [pageKey, retainEntry, releaseEntry]);
    return null;
}

/** A page's entry as rows, in resolveBinding's shape. */
function pageResult(entry: DataEntry | undefined): ResolveResult<PageBody> {
    if (!entry || entry.status === 'loading') return { value: undefined, isLoading: true, error: null, errorCode: null };
    if (entry.status === 'error') return { value: undefined, isLoading: false, error: entry.error ?? null, errorCode: (entry.errorCode as string) ?? null };
    return { value: (entry.result as PageBody) ?? EMPTY_PAGE, isLoading: false, error: null, errorCode: null };
}

/** loadMore: every page up to the last one shown, joined; the bar offers the next. */
function joinPages(pages: ResolveResult<PageBody>[]) {
    const head = pages[0];
    if (!head.value) return { result: head as ResolveResult, last: null, loading: head.isLoading, failed: false, total: null };
    const rows: unknown[] = [];
    let last: PageBody | null = null;
    let pending: ResolveResult<PageBody> | null = null;
    for (const page of pages) {
        if (!page.value) { pending = page; break; }
        rows.push(...page.value.rows);
        last = page.value;
    }
    return {
        result: { value: rows, isLoading: false, error: null, errorCode: null },
        last: pending ? null : last,
        loading: !!pending?.isLoading,
        failed: !!pending && !pending.isLoading,
        total: head.value.total,
    };
}

/** Which pages a component walks, and for which source (a new source starts at page one). */
interface WalkState { sourceOf: string | null; walk: PageWalk }

type PageLookup = (cursor: string | null) => ResolveResult<PageBody>;
type Move = (next: PageWalk) => void;
type View = Pick<PagedSource, 'result' | 'paging'>;

/** loadMore: the pages up to the last one asked for, joined, and the step to the next. */
function loadMoreView(walk: PageWalk, lookup: PageLookup, move: Move): View {
    const cursors = walk.cursors.slice(0, walk.index + 1);
    const { result, last, loading, failed, total } = joinPages(cursors.map(lookup));
    if (result.value === undefined) return { result, paging: null };
    return {
        result,
        paging: {
            mode: 'loadMore', pages: cursors.length, from: 0, shown: (result.value as unknown[]).length, total,
            canPrev: false, loading, failed, canNext: !!last?.nextCursor,
            next: () => { if (last?.nextCursor) move(stepForward(walk, last.nextCursor, last.rows.length)); },
            prev: () => {},
        },
    };
}

/** prevNext: the one page the walk points at, and the steps both ways. */
function prevNextView(walk: PageWalk, lookup: PageLookup, move: Move): View {
    const page = lookup(walk.cursors[walk.index]);
    const body = page.value;
    if (!body) {
        // Past page one the bar stays while a page loads or fails, so the viewer
        // can always step back; the component keeps showing the rows it had.
        return {
            result: page as ResolveResult,
            paging: walk.index > 0 ? {
                mode: 'prevNext', pages: walk.index + 1, from: walk.offsets[walk.index], shown: 0, total: null,
                canPrev: true, canNext: false, loading: page.isLoading, failed: !page.isLoading,
                next: () => {}, prev: () => move(stepBack(walk)),
            } : null,
        };
    }
    return {
        result: { value: body.rows, isLoading: false, error: null, errorCode: null },
        paging: {
            mode: 'prevNext', pages: walk.index + 1, from: walk.offsets[walk.index], shown: body.rows.length, total: body.total,
            canPrev: walk.index > 0, canNext: !!body.nextCursor, loading: false, failed: false,
            next: () => { if (body.nextCursor) move(stepForward(walk, body.nextCursor, body.rows.length)); },
            prev: () => move(stepBack(walk)),
        },
    };
}

/**
 * The rows of `source` for a component of `type` whose paging prop is
 * `pagination`. Without paging: resolveBinding on the source, unchanged.
 */
export function usePagedSource(type: string, source: BindingInput, pagination: unknown): PagedSource {
    const { mode, actionState, dataState, scope } = useRuntime();
    const { appId, dataState: ownState } = useDataContext();
    const hasQueryClient = useHasQueryClient();
    const pageMode = paginationModeOf(type, pagination);
    const binding = useMemo(() => (pageMode && isPageableSource(source)
        ? resolveBindingFilters(source, scope) as DataBinding | null | undefined
        : null), [pageMode, source, scope]);
    const sourceKey = binding ? dataCacheKey(binding) : null;
    const [walkState, setWalkState] = useState<WalkState>({ sourceOf: null, walk: FIRST_PAGE });

    if (!pageMode || !binding || !sourceKey || !appId || !hasQueryClient) {
        return { result: resolveBinding(source, { actionState, dataState, scope }), loaders: null, paging: null };
    }
    const walk = walkState.sourceOf === sourceKey ? walkState.walk : FIRST_PAGE;
    const lookup: PageLookup = (cursor) => {
        const entryKey = pageKeyOf(sourceKey, cursor);
        return pageResult(ownState[entryKey] ?? dataState?.[entryKey]);
    };
    const move: Move = (next) => setWalkState({ sourceOf: sourceKey, walk: next });
    const shown = pageMode === 'loadMore' ? walk.cursors.slice(0, walk.index + 1) : [walk.cursors[walk.index]];
    const loaders = shown.map((cursor) => (
        <PageLoader key={cursor ?? ''} appId={appId} binding={binding} sourceKey={sourceKey} cursor={cursor} sample={mode !== 'run'} />
    ));
    const view = pageMode === 'loadMore' ? loadMoreView(walk, lookup, move) : prevNextView(walk, lookup, move);
    return { ...view, loaders };
}
