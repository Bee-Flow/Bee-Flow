import { useTable } from '@tanstack/react-table';
import { useVirtualizer } from '@tanstack/react-virtual';
import { useEffect, useMemo, useRef, useState } from 'react';
import useTranslation from '@/hooks/useTranslation';
import { resolveBinding } from '../resolveBinding';
import { useRuntime } from '../RuntimeContext';
import { ErrorText, SkeletonLines, useStickyBinding } from '../uiBits';
import { groupPageRows } from './grid/GridBody';
import { DENSITY, DENSITY_AIRY, TABLE_FEATURES, VIRTUALIZE_THRESHOLD } from './grid/gridConstants';
import { GridFrame } from './grid/GridFrame';
import { activeFiltersOf, gridBoxOf, gridLookFor, pageRangeOf, pageSizeChoicesFor, virtualWindowOf } from './grid/gridLayout';
import { GridFilterRow, GridHeaderRow } from './grid/GridHeader';
import { GridAddRow, GridColGroup, GridEmptyState, GridNoMatchRow } from './grid/GridStates';
import { GridRows, GridTable, type GridSharedRowProps } from './grid/GridTable';
import { useCellPeek } from './grid/useCellPeek';
import { useGridColumns } from './grid/useGridColumns';
import { useGridViewPrefs, useGroupCollapse } from './grid/useGridDisplay';
import { rowKey, useGridEditQueue } from './grid/useGridEditQueue';
import { useGridTableState } from './grid/useGridTableState';
import { useRowSelectNotify } from './grid/useRowSelectNotify';
import type { GridRow } from './grid/gridTypes';
import type { NodeProps } from './appNode.types';
import type { DataGridProps } from './AppDataGrid.types';

export default function AppDataGrid({ node }: NodeProps<DataGridProps>) {
    const { t } = useTranslation();
    const { mode, runAction, actionState, dataState, scope } = useRuntime();
    const props = node.props || {};
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

    // Look pass (spec: data_grid.look): see gridLookFor.
    const { minimal, cards, striped } = gridLookFor(view.look, zebra);

    const { value: source, isLoading, error, errorCode } = useStickyBinding(
        resolveBinding(props.source, { actionState, dataState, scope }),
    );

    const {
        sorting, setSorting, globalFilter, setGlobalFilter, columnFilters, setColumnFilters, rowSelection, setRowSelection,
    } = useGridTableState();
    const [pageIndex, setPageIndex] = useState(0);
    // The author's pageSize is the starting point, not a cage: a viewer can
    // resize the page from the footer (and lands back on page 1, because
    // "page 7 of 12" means nothing once the pages change size).
    const [pageSize, setPageSize] = useState(pageSizeProp);
    useEffect(() => { setPageSize(pageSizeProp); setPageIndex(0); }, [pageSizeProp]);
    const pageSizeChoices = useMemo(() => pageSizeChoicesFor(pageSize), [pageSize]);

    const baseRows = useMemo(
        () => (Array.isArray(source) ? source : []).filter((r) => r && typeof r === 'object'),
        [source],
    );

    const { data, commitEdit } = useGridEditQueue({ baseRows, onRowSelect: node.onRowSelect, actionState, runAction });

    // One clock for every relative cell on the screen — see cellValue.
    const now = Date.parse(scope?.now ?? '') || null;
    const dens = DENSITY[density ?? ''] || DENSITY.comfortable;
    // For the default look both of these resolve to today's exact strings.
    const cellPad = minimal ? (DENSITY_AIRY[density ?? ''] || DENSITY_AIRY.comfortable) : dens.cell;
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

    useRowSelectNotify({ rowSelection, isRun, onRowSelect: node.onRowSelect, table, runAction });

    const pageRows = table.getRowModel().rows;
    // Grouping turns virtualization OFF rather than teaching the virtualizer
    // about header rows: the page is capped at 100 rows anyway, and keeping
    // the virtual index and the header-interleaved row list in sync would buy
    // little for what it costs in bookkeeping.
    const virtualize = !grouping && pageRows.length > VIRTUALIZE_THRESHOLD;
    const scrollRef = useRef<HTMLDivElement>(null);
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
    const { activeColumnFilters, activeFilterCount } = activeFiltersOf(columnFilters, globalFilter);
    const clearFilters = () => { setColumnFilters([]); setGlobalFilter(''); };
    const pageCount = table.getPageCount();
    const colSpan = columns.length + (selectable !== 'none' ? 1 : 0) + (rowActions.length ? 1 : 0);
    const filteredCount = table.getFilteredRowModel().rows.length;
    const { rangeFrom, rangeTo } = pageRangeOf(filteredCount, pageIndex, pageSize);
    const selectedCount = table.getSelectedRowModel().rows.length;

    const fireRowClick = (row: GridRow) => {
        if (isRun && node.onRowClick) runAction(node.onRowClick, { formValues: row.original, item: row.original });
    };

    const headerProps = { table, selectable, cellPad, divider, hasRowActions: rowActions.length > 0 };
    const rowProps: GridSharedRowProps = {
        activeWhen, scope, cards, isRun, clickable: !!node.onRowClick, fireRowClick, selectable,
        cellPad, divider, clampLines, showPeek, hidePeek, runAction, rowActions,
    };

    // Grouping buckets the CURRENT page's rows (spec: groupBy). Deliberately
    // page-local: sorting and pagination keep exactly their meaning, and a
    // header counts what is on screen. Bucketing is stable, so the tanstack
    // sort order is preserved WITHIN each group untouched.
    const groupedPage = grouping ? groupPageRows(pageRows, groupBy, groupOrder) : null;

    // Column widths, at last. `width` has been in the spec since the grid
    // shipped, but it only ever reached the <th> — and under tableLayout:'auto'
    // a browser treats a th width as a hint it may ignore, so a template that
    // carefully sized eight columns got whatever the content felt like. A
    // <colgroup> is the element table layout actually honours. Layout stays
    // 'auto' so unwidthed columns keep sizing to their content.
    const hasWidths = columns.some((c) => Number.isFinite(c.size));
    const colGroup = hasWidths ? <GridColGroup selectable={selectable} columns={columns} hasRowActions={rowActions.length > 0} /> : null;

    const tableEl = (
        <GridTable
            className={`w-full app-grid-base ${dens.text}${striped ? ' app-grid-zebra' : ''}${cards ? ' app-grid-cards' : ''}`}
            colGroup={colGroup}
            headerRow={<GridHeaderRow {...headerProps} minimal={minimal} />}
            filterRow={hasFilters ? <GridFilterRow {...headerProps} /> : null}
            rows={(
                <GridRows
                    pageRows={pageRows}
                    groups={groupedPage}
                    isGroupCollapsed={isGroupCollapsed}
                    toggleGroup={toggleGroup}
                    colSpan={colSpan}
                    rowTone={rowTone}
                    rowProps={rowProps}
                    {...virtualWindowOf(virtualize, virtualizer)}
                />
            )}
            addRow={isRun && addRowActionId ? (
                <GridAddRow colSpan={colSpan} cellPad={cellPad} addRowLabel={addRowLabel} onAdd={() => runAction(addRowActionId, {})} />
            ) : null}
            noMatch={pageRows.length === 0 ? (
                <GridNoMatchRow colSpan={colSpan} activeFilterCount={activeFilterCount} clearFilters={clearFilters} />
            ) : null}
        />
    );

    return (
        <GridFrame
            {...gridBoxOf(node, virtualize)}
            scrollRef={scrollRef}
            tableEl={tableEl}
            peek={peek}
            selectionBar={selectable !== 'none' && selectedCount > 0
                ? { selectedCount, isRun, bulkActions, table, runAction, setRowSelection } : null}
            chromeRow={searchable || activeFilterCount > 0 || isRun ? {
                searchable, isRun, globalFilter, setGlobalFilter, activeColumnFilters, activeFilterCount, clearFilters,
                table, toolbarActions, runAction, view, setViewKey, resetView, hasViewOverrides,
            } : null}
            footer={pageCount > 1
                ? { rangeFrom, rangeTo, filteredCount, pageSize, setPageSize, setPageIndex, pageSizeChoices, table } : null}
        />
    );
}
