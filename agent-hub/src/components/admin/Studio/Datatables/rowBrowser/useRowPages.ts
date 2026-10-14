/**
 * The read side of RowBrowser: one page of rows plus the schema, and the
 * descriptor that asks for it (sort, search, filters).
 *
 * "Load more" GROWS the window you are reading; the ‹ › pager MOVES it a
 * page at a time in both directions. Both ride the same keyset cursor: a
 * stack of the token each visited page started at, so going back re-asks
 * with a cursor rather than an offset. That matters on a table two
 * automations are writing to, where an offset both skips and repeats rows
 * between pages.
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import { PAGE, SEARCHABLE, messageOf, rowsApi } from './rowBrowserModel';
import type { DtColumn, DtRow, DtTable, RowFilter, RowSort } from './rowBrowserModel';
import { filterDescriptor } from './typedViews';
import type { TranslateFn } from '../../../../../hooks/useTranslation';

export function useRowPages(table: DtTable, t: TranslateFn, initialFilters: RowFilter[] | null, reloadKey: unknown) {
    const [rows, setRows] = useState<DtRow[] | null>(null);
    const [columns, setColumns] = useState<DtColumn[]>([]);
    const [hasMore, setHasMore] = useState(false);
    const [cursor, setCursor] = useState<string | null>(null);
    const [total, setTotal] = useState(table.rowCount ?? 0);
    const [error, setError] = useState<string | null>(null);
    const [busy, setBusy] = useState(false);
    const [selected, setSelected] = useState<Set<string>>(() => new Set());
    const [sort, setSort] = useState<RowSort>({ field: null, dir: 'desc' });
    const [query, setQuery] = useState('');
    const [applied, setApplied] = useState('');
    // The filter draft, and the descriptor actually in force. Two states,
    // because building a condition is not the same act as asking for it.
    const [filterOpen, setFilterOpen] = useState(false);
    const seeded = Array.isArray(initialFilters) ? initialFilters : [];
    const [filterRows, setFilterRows] = useState<RowFilter[]>(seeded);
    const [match, setMatch] = useState('all');
    const [activeFilters, setActiveFilters] = useState<RowFilter[]>(seeded);
    const [activeMatch, setActiveMatch] = useState('all');
    // The keyset token each visited page started at. [null] is page one.
    const [stack, setStack] = useState<Array<string | null>>([null]);
    const [page, setPage] = useState(0);

    const searchable = useMemo(() => columns.some(c => SEARCHABLE.has(c.type)), [columns]);
    const filterKey = JSON.stringify(activeFilters);
    const startCursor = stack[page] ?? null;

    const load = useCallback(async () => {
        setBusy(true);
        setError(null);
        try {
            const [schema, pageBody] = await Promise.all([
                rowsApi.getSchema(table.id),
                rowsApi.listRows(table.id, {
                    limit: PAGE,
                    cursor: startCursor,
                    sort: sort.field || null,
                    dir: sort.field ? sort.dir : null,
                    q: applied || null,
                    filters: JSON.parse(filterKey),
                    match: activeMatch,
                }),
            ]);
            setColumns(schema.fields || []);
            setRows(pageBody.rows || []);
            setHasMore(!!pageBody.hasMore);
            setCursor(pageBody.nextCursor || null);
            setSelected(new Set());
            if (typeof pageBody.total === 'number') setTotal(pageBody.total);
        } catch (e) {
            setError(messageOf(e, t('datatables.err_rows', 'Could not read the rows')));
            setRows([]);
        } finally {
            setBusy(false);
        }
    }, [table.id, sort.field, sort.dir, applied, filterKey, activeMatch, startCursor, t]);

    // `reloadKey` is the mirror's lastSyncAt: a refresh that finished while
    // this tab was open re-reads the page, so the rows shown are the rows.
    useEffect(() => { load(); }, [load, reloadKey]);

    /** Back to page one — what any change to WHAT is being asked for means. */
    const restart = useCallback(() => { setStack([null]); setPage(0); }, []);

    /** Another page, APPENDED — the cursor is keyset, so there is no overlap. */
    const loadMore = async () => {
        if (!cursor) return;
        setBusy(true);
        try {
            const body = await rowsApi.listRows(table.id, {
                limit: PAGE,
                cursor,
                sort: sort.field || null,
                dir: sort.field ? sort.dir : null,
                q: applied || null,
                filters: activeFilters,
                match: activeMatch,
            });
            setRows(cur => [...(cur || []), ...(body.rows || [])]);
            setHasMore(!!body.hasMore);
            setCursor(body.nextCursor || null);
        } catch (e) {
            setError(messageOf(e, t('datatables.err_next_page', 'Could not read the next page')));
        } finally {
            setBusy(false);
        }
    };

    /** The next page REPLACES the window; its start cursor joins the stack. */
    const goNext = () => {
        if (!cursor) return;
        setStack(s => [...s.slice(0, page + 1), cursor]);
        setPage(p => p + 1);
    };
    const goPrev = () => { if (page > 0) setPage(p => p - 1); };

    const toggleSort = (key: string) => {
        restart();
        setSort(cur => (cur.field === key
            ? { field: key, dir: cur.dir === 'asc' ? 'desc' : 'asc' }
            : { field: key, dir: 'asc' }));
    };
    const search = (text: string) => { restart(); setApplied(text); };
    const applyFilters = () => {
        restart();
        setActiveFilters(filterDescriptor(filterRows));
        setActiveMatch(match);
    };
    const clearFilters = () => {
        restart();
        setFilterRows([]);
        setActiveFilters([]);
        setActiveMatch('all');
    };

    return {
        rows, columns, hasMore, cursor, total, error, setError, busy, setBusy,
        selected, setSelected, sort, query, setQuery, applied, search, filterOpen, setFilterOpen,
        filterRows, setFilterRows, match, setMatch, activeFilters, page, searchable,
        load, loadMore, goNext, goPrev, toggleSort, applyFilters, clearFilters,
    };
}

export type RowPages = ReturnType<typeof useRowPages>;
