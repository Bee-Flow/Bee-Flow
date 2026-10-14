import { useTable, type ColumnFiltersState, type RowSelectionState, type SortingState } from '@tanstack/react-table';
import { useVirtualizer } from '@tanstack/react-virtual';
import { useEffect, useEffectEvent, useMemo, useRef, useState, type Dispatch, type SetStateAction } from 'react';
import useTranslation from '../../../../../../hooks/useTranslation';
import { resolveBinding } from '../resolveBinding';
import { useRuntime } from '../RuntimeContext';
import { isFill } from '../styleResolver';
import { ErrorText, SkeletonLines, useStickyBinding } from '../uiBits';
import type { AppNode } from '../../inspector/appDefinition';
import type { GridRow } from './grid/gridTypes';
import type { GridProps } from './AppDataGrid.types';
import { GridBodyRow, GridGroupHeaderRow, groupPageRows } from './grid/GridBody';
import { CellPeek } from './grid/gridCells';
import { GridChromeRow, GridFooter, GridSelectionBar } from './grid/GridChrome';
import {
    DENSITY, DENSITY_AIRY, PAGE_SIZE_OPTIONS, rowToneFor, TABLE_FEATURES,
    VIRTUALIZE_FALLBACK_PX, VIRTUALIZE_THRESHOLD,
} from './grid/gridConstants';
import { GridFilterRow, GridHeaderRow } from './grid/GridHeader';
import { GridAddRow, GridColGroup, GridEmptyState, GridNoMatchRow } from './grid/GridStates';
import { useCellPeek } from './grid/useCellPeek';
import { useGridColumns } from './grid/useGridColumns';
import { useGridViewPrefs, useGroupCollapse } from './grid/useGridDisplay';
import { rowKey, useGridEditQueue } from './grid/useGridEditQueue';
import { isActiveFilter } from './gridColumnFilters';

/**
 * App Studio runtime — 'data_grid'. Spec: server/appStudio/componentSpecs.js.
 *
 * The cell switch moved to the shared `cellValue` module, which AppTable also
 * imports — the two used to keep private copies that had already drifted apart.
 *
 * The pieces (cells, edit queue, columns, rows, chrome) live under ./grid/;
 * this file keeps the table instance, the virtualizer and the composition.
 */

export default function AppDataGrid({ node: rawNode }: { node: AppNode }) {
    const node = rawNode as AppNode & { onRowSelect?: string; onRowClick?: string };
    const { t } = useTranslation();
    const { mode, runAction, actionState, dataState, scope } = useRuntime();
    const props = (node.props || {}) as GridProps;
    const {
        columns: colDefs = [], pageSize: pageSizeProp = 25, selectable = 'none', searchable = false,
        rowActions = [], bulkActions = [], toolbarActions = [], addRowLabel = '', addRowActionId = '',
        density: densityProp = 'comfortable', emptyText = t('studio_apps_runtime.ui.nothing_to_show', 'Nothing to show yet.'),
        zebra = false, look: lookProp = 'default', clamp: clampProp = 'off', rowTone = [],
        groupBy = null, groupOrder = [], activeWhen = null,
    } = props;
    const isRun = mode === 'run';

    const { view, hasViewOverrides, setViewKey, resetView } = useGridViewPrefs(
        node.id, { density: densityProp, look: lookProp, clamp: clampProp },
    );
    const density = view.density;
    const clampLines = view.clamp === 'off' ? 0 : Number(view.clamp);

    const { peek, showPeek, hidePeek } = useCellPeek();

    // Grouping (spec: groupBy / groupOrder); the collapse state lives in
    // useGroupCollapse.
    const grouping = typeof groupBy === 'string' && groupBy !== '';
    const { isGroupCollapsed, toggleGroup } = useGroupCollapse(groupOrder);

    // Look pass (spec: data_grid.look). IDENTITY FIRST: 'default' — and any
    // value this build does not know yet — takes the exact original code path:
    // no new class, no new style. The legacy `zebra` boolean keeps striping
    // stored grids, but only on the default look — `look` wins when both are
    // set (spec comment in componentSpecs.js).
    const look = view.look === 'striped' || view.look === 'minimal' || view.look === 'cards' ? view.look : 'default';
    const minimal = look === 'minimal';
    const cards = look === 'cards';
    const striped = look === 'striped' || (look === 'default' && zebra);

    const { value: source, isLoading, error, errorCode } = useStickyBinding(resolveBinding(props.source, { actionState, dataState, scope }));

    const [sorting, setSorting] = useState<SortingState>([]);
    const [globalFilter, setGlobalFilter] = useState('');
    const [columnFilters, setColumnFilters] = useState<ColumnFiltersState>([]);
    const [rowSelection, setRowSelection] = useState<RowSelectionState>({});
    const [pageIndex, setPageIndex] = useState(0);
    // The author's pageSize is the starting point, not a cage: a viewer can
    // resize the page from the footer (and lands back on page 1, because
    // "page 7 of 12" means nothing once the pages change size).
    const [pageSize, setPageSize] = useState(pageSizeProp);
    useEffect(() => { setPageSize(pageSizeProp); setPageIndex(0); }, [pageSizeProp]);
    // The spec lets an author pick any pageSize from 5 to 100, but the footer
    // only offered four. A grid authored at 20 rendered a <select> with no
    // matching <option> — blank, until the viewer picked something else and
    // lost the author's setting. Whatever is actually in force is always on
    // the list.
    const pageSizeChoices = useMemo(
        () => (PAGE_SIZE_OPTIONS.includes(pageSize) ? PAGE_SIZE_OPTIONS : [...PAGE_SIZE_OPTIONS, pageSize].sort((a, b) => a - b)),
        [pageSize],
    );

    const baseRows = useMemo(
        () => (Array.isArray(source) ? source : []).filter((r) => r && typeof r === 'object'),
        [source],
    );

    const { data, commitEdit } = useGridEditQueue({ baseRows, onRowSelect: node.onRowSelect, actionState: actionState as Record<string, { status?: string } | undefined>, runAction });
    // One clock for every relative cell on the screen — see cellValue.
    const now = Date.parse(scope?.now) || null;
    const dens = DENSITY[density] || DENSITY.comfortable;
    // For the default look both of these resolve to today's exact strings.
    const cellPad = minimal ? (DENSITY_AIRY[density] || DENSITY_AIRY.comfortable) : dens.cell;
    const divider = minimal || cards ? '' : ' border-b';

    const { cols, columns } = useGridColumns({
        colDefs, baseRows, isRun, onRowSelect: node.onRowSelect, runAction, now, clampLines, commitEdit,
    });

    const table = useTable({
        features: TABLE_FEATURES,
        data,
        columns,
        state: { sorting, globalFilter, columnFilters, rowSelection, pagination: { pageIndex, pageSize } },
        getRowId: rowKey,
        enableRowSelection: selectable !== 'none',
        enableMultiRowSelection: selectable === 'multi',
        onSortingChange: setSorting,
        onGlobalFilterChange: setGlobalFilter,
        onColumnFiltersChange: setColumnFilters,
        onRowSelectionChange: setRowSelection,
        onPaginationChange: (updater) => {
            const next = typeof updater === 'function' ? updater({ pageIndex, pageSize }) : updater;
            setPageIndex(next.pageIndex);
        },
    });

    // Notify onRowSelect when the selection changes (skip the initial empty state).
    const selectSig = JSON.stringify(rowSelection);
    const prevSelSig = useRef(selectSig);
    const notifyRowSelect = useEffectEvent(() => {
        if (!isRun || !node.onRowSelect) return;
        const rows = table.getSelectedRowModel().rows.map((r) => r.original);
        runAction(node.onRowSelect, { formValues: { selected: rows } });
    });
    useEffect(() => {
        if (prevSelSig.current === selectSig) return;
        prevSelSig.current = selectSig;
        notifyRowSelect();
    }, [selectSig]);

    const pageRows = table.getRowModel().rows;
    // Grouping turns virtualization OFF rather than teaching the virtualizer
    // about header rows: the page is capped at 100 rows anyway, and keeping
    // the virtual index and the header-interleaved row list in sync would buy
    // little for what it costs in bookkeeping.
    const virtualize = !grouping && pageRows.length > VIRTUALIZE_THRESHOLD;
    const scrollRef = useRef<HTMLDivElement | null>(null);
    const virtualizer = useVirtualizer({
        count: pageRows.length,
        getScrollElement: () => scrollRef.current,
        // minimal pads rows out; cards adds the inter-card spacing. Estimates
        // only — but close ones keep the virtual scrollbar honest.
        estimateSize: () => dens.rowH + (minimal || cards ? 8 : 0),
        overscan: 8,
        enabled: virtualize,
    });

    if (error) return <ErrorText error={error} errorCode={errorCode} />;

    if (isLoading) return <SkeletonLines lines={5} />;
    if (baseRows.length === 0 || cols.length === 0) {
        return (
            <GridEmptyState
                emptyText={emptyText}
                isRun={isRun}
                addRowActionId={addRowActionId}
                addRowLabel={addRowLabel}
                runAction={runAction}
            />
        );
    }

    const hasFilters = cols.some((c) => c.filterable);
    // Both filter surfaces count: the per-column row and the search box. A grid
    // filtered to nothing by a forgotten search box looks exactly like a grid
    // filtered to nothing by a column, and the way out is the same.
    const activeColumnFilters = columnFilters.filter((f) => isActiveFilter(f.value));
    const activeFilterCount = activeColumnFilters.length + (globalFilter ? 1 : 0);
    const clearFilters = () => { setColumnFilters([]); setGlobalFilter(''); };
    const pageCount = table.getPageCount();
    const colSpan = columns.length + (selectable !== 'none' ? 1 : 0) + (rowActions.length ? 1 : 0);
    // Counts AFTER search/column filters — "1–25 of 340" must describe what the
    // viewer is actually looking through, not the unfiltered table.
    const filteredCount = table.getFilteredRowModel().rows.length;
    const rangeFrom = filteredCount === 0 ? 0 : pageIndex * pageSize + 1;
    const rangeTo = Math.min(filteredCount, (pageIndex + 1) * pageSize);
    const selectedCount = table.getSelectedRowModel().rows.length;

    const fireRowClick = (row: GridRow) => {
        if (isRun && node.onRowClick) runAction(node.onRowClick, { formValues: row.original, item: row.original });
    };

    const headerProps = { table, selectable, cellPad, divider, hasRowActions: rowActions.length > 0 };
    const headerRow = () => <GridHeaderRow {...headerProps} minimal={minimal} />;
    const filterRow = () => <GridFilterRow {...headerProps} />;

    const renderRow = (row: GridRow) => (
        <GridBodyRow
            key={row.id}
            row={row}
            tone={rowToneFor(rowTone, row.original)}
            activeWhen={activeWhen}
            scope={scope}
            cards={cards}
            isRun={isRun}
            clickable={!!node.onRowClick}
            fireRowClick={fireRowClick}
            selectable={selectable}
            cellPad={cellPad}
            divider={divider}
            clampLines={clampLines}
            showPeek={showPeek}
            hidePeek={hidePeek}
            runAction={runAction}
            rowActions={rowActions}
        />
    );

    // Grouping buckets the CURRENT page's rows (spec: groupBy). Deliberately
    // page-local: sorting and pagination keep exactly their meaning, and a
    // header counts what is on screen. Bucketing is stable, so the tanstack
    // sort order is preserved WITHIN each group untouched.
    const groupedPage = grouping ? groupPageRows(pageRows, groupBy, groupOrder) : [];

    const groupHeaderRow = (g: (typeof groupedPage)[number]) => (
        <GridGroupHeaderRow
            key={`__group__${g.value}`}
            g={g}
            open={!isGroupCollapsed(g.value)}
            onToggle={toggleGroup}
            colSpan={colSpan}
        />
    );

    const virtualItems = virtualize ? virtualizer.getVirtualItems() : [];
    const paddingTop = virtualItems && virtualItems.length ? virtualItems[0].start : 0;
    const paddingBottom = virtualItems && virtualItems.length
        ? virtualizer.getTotalSize() - virtualItems[virtualItems.length - 1].end : 0;

    // Column widths, at last. `width` has been in the spec since the grid
    // shipped, but it only ever reached the <th> — and under tableLayout:'auto'
    // a browser treats a th width as a hint it may ignore, so a template that
    // carefully sized eight columns got whatever the content felt like. A
    // <colgroup> is the element table layout actually honours. Layout stays
    // 'auto' so unwidthed columns keep sizing to their content.
    const hasWidths = columns.some((c) => Number.isFinite(c.size));
    const colGroup = hasWidths ? <GridColGroup selectable={selectable} columns={columns} hasRowActions={rowActions.length > 0} /> : null;

    const tableEl = (
        <table
            className={`w-full app-grid-base ${dens.text}${striped ? ' app-grid-zebra' : ''}${cards ? ' app-grid-cards' : ''}`}
            style={{ tableLayout: 'auto' }}
        >
            {colGroup}
            {/*
              * Sticky header: scrolling a virtualized grid used to carry the
              * column names away, leaving a wall of values with no labels.
              * The background is opaque so rows can't show through.
              */}
            <thead
                className="sticky top-0 z-[1]"
                style={{ background: 'var(--bg-card)' }}
            >
                {headerRow()}
                {hasFilters ? filterRow() : null}
            </thead>
            <tbody>
                {grouping ? (
                    // Header row per group; a collapsed group keeps its header
                    // and drops its rows. (`virtualize` is always false here.)
                    groupedPage.flatMap((g) => [
                        groupHeaderRow(g),
                        ...(isGroupCollapsed(g.value) ? [] : g.rows.map((row) => renderRow(row))),
                    ])
                ) : virtualize ? (
                    <>
                        {paddingTop > 0 ? <tr style={{ height: paddingTop }} aria-hidden="true"><td colSpan={colSpan} /></tr> : null}
                        {virtualItems.map((vi) => renderRow(pageRows[vi.index]))}
                        {paddingBottom > 0 ? <tr style={{ height: paddingBottom }} aria-hidden="true"><td colSpan={colSpan} /></tr> : null}
                    </>
                ) : (
                    pageRows.map((row) => renderRow(row))
                )}
                {/*
                  * The last line of the table is an invitation to add one. It
                  * lives INSIDE the tbody on purpose: the moment you notice a
                  * row is missing you are looking at the bottom of the list,
                  * not at the page header.
                  */}
                {isRun && addRowActionId ? (
                    <GridAddRow colSpan={colSpan} cellPad={cellPad} addRowLabel={addRowLabel} onAdd={() => runAction(addRowActionId, {})} />
                ) : null}
                {pageRows.length === 0 ? (
                    <GridNoMatchRow colSpan={colSpan} activeFilterCount={activeFilterCount} clearFilters={clearFilters} />
                ) : null}
            </tbody>
        </table>
    );

    // Any explicit height — 'fill' or one of the sm/md/lg/xl tokens — means the
    // outer cell already owns a definite box, so the grid lays itself out
    // inside it: scroller flexes, chrome and footer hold their ground. Only
    // 'auto'/absent leaves the grid free-standing, and then the sole reason to
    // box it is the virtualization safety net.
    const heightToken = (node?.style as { height?: string } | undefined)?.height;
    // `fill` stays a distinct thing from `boxed`: app-fill is the marker class
    // the fill contract is asserted on (AppRenderer.fill.test.jsx), and it
    // means "ask the parent for room". A boxed grid already has its room.
    const fill = isFill(node);
    const boxed = fill || (Boolean(heightToken) && heightToken !== 'auto');
    const gridHeight = boxed ? null : (virtualize ? VIRTUALIZE_FALLBACK_PX : null);

    return (
        <div
            className={`w-full min-w-0 flex flex-col gap-2${boxed ? ' h-full min-h-0' : ''}${fill ? ' app-fill' : ''}`}
            data-app-datagrid="true"
        >
            {/*
              * Selection needs a place to SAY something. Without this, ticking
              * rows changed nothing visible above the fold — no count, no way
              * back out — so a multi-select grid felt broken even though the
              * selection was live.
              */}
            {selectable !== 'none' && selectedCount > 0 ? (
                <GridSelectionBar
                    boxed={boxed}
                    selectedCount={selectedCount}
                    isRun={isRun}
                    bulkActions={bulkActions}
                    table={table}
                    runAction={runAction}
                    setRowSelection={setRowSelection as Dispatch<SetStateAction<Record<string, boolean>>>}
                />
            ) : null}

            {/*
              * The chrome row now also carries the View menu, so it renders in
              * run mode even for a grid with no search box — a table nobody can
              * search is exactly the one whose rows are hardest to tell apart,
              * and the reader had no way to change anything about it.
              *
              * It WRAPS: search plus a couple of author buttons plus the view
              * menu is more than fits across a half-width cell, and the thing
              * that got pushed off the end was always the last button — the
              * one an author put there on purpose.
              */}
            {searchable || activeFilterCount > 0 || isRun ? (
                <GridChromeRow
                    boxed={boxed}
                    searchable={searchable}
                    isRun={isRun}
                    globalFilter={globalFilter}
                    setGlobalFilter={setGlobalFilter}
                    activeColumnFilters={activeColumnFilters}
                    activeFilterCount={activeFilterCount}
                    clearFilters={clearFilters}
                    table={table}
                    toolbarActions={toolbarActions}
                    runAction={runAction}
                    view={view}
                    setViewKey={setViewKey}
                    resetView={resetView}
                    hasViewOverrides={hasViewOverrides}
                />
            ) : null}

            {boxed || gridHeight ? (
                <div
                    ref={scrollRef}
                    className={`w-full overflow-auto app-scroll-edges${boxed ? ' flex-1 min-h-0' : ''}`}
                    style={boxed ? undefined : { maxHeight: gridHeight ?? undefined }}
                >
                    {tableEl}
                </div>
            ) : (
                <div className="w-full overflow-x-auto app-scroll-edges">{tableEl}</div>
            )}

            {pageCount > 1 ? (
                <GridFooter
                    boxed={boxed}
                    rangeFrom={rangeFrom}
                    rangeTo={rangeTo}
                    filteredCount={filteredCount}
                    pageSize={pageSize}
                    setPageSize={setPageSize}
                    setPageIndex={setPageIndex}
                    pageSizeChoices={pageSizeChoices}
                    table={table}
                />
            ) : null}

            <CellPeek peek={peek} />
        </div>
    );
}
