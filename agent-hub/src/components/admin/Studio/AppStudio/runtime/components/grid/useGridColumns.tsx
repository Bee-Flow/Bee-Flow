import { useMemo } from 'react';
import { alignFor } from '../cellValue';
import { canFacet, facetValues, filterKindFor, makeFilterFn } from '../gridColumnFilters';
import { CellValue, EditableCell } from './gridCells';

/**
 * Column derivation for the App Studio data grid: the visible column list
 * (configured, or derived from the first row), the filter control each
 * filterable column gets, and the tanstack column definitions with their
 * cell renderers. Moved out of AppDataGrid.jsx verbatim.
 */

export interface GridColumn {
    key: string;
    label?: string;
    format?: string;
    hidden?: boolean;
    sortable?: boolean;
    filterable?: boolean;
    editable?: boolean;
    truncate?: boolean;
    width?: number;
    help?: unknown;
    actionId?: unknown;
    toneMap?: Array<{ value: unknown; label?: unknown }>;
    [extra: string]: unknown;
}

interface GridCellContext {
    getValue: () => unknown;
    row: { original: Record<string, any>; index: number };
}

interface GridColumnsArgs {
    colDefs: GridColumn[];
    baseRows: Array<Record<string, any>>;
    isRun: boolean;
    onRowSelect: string | undefined;
    runAction: (actionId: string, payload: Record<string, unknown>) => unknown;
    now: number | null;
    clampLines: number;
    commitEdit: (original: Record<string, any>, index: number, colKey: string, next: unknown) => void;
}

export function useGridColumns({ colDefs, baseRows, isRun, onRowSelect, runAction, now, clampLines, commitEdit }: GridColumnsArgs) {
    // Columns: use the configured list, else derive from the first row (max 12).
    // `hidden` keeps a column in the definition — so a toneFrom or labelFrom can
    // still point at it — without giving it a place on screen.
    const cols = useMemo<GridColumn[]>(() => {
        if (colDefs.length) return colDefs.filter((c) => c && !c.hidden);
        return Object.keys(baseRows[0] || {}).slice(0, 12).map((key) => ({ key, label: key, format: 'text' }));
    }, [colDefs, baseRows]);

    // Which control each filterable column gets, from its format (see
    // gridColumnFilters.js). A column that names its values — through a
    // toneMap, or simply by holding few enough distinct ones — offers them
    // as a pick list: a substring box over four known states is a worse
    // control than the four states.
    const filterMeta = useMemo(() => {
        const out: Record<string, { kind: string; options: unknown[] | null }> = {};
        for (const col of cols) {
            if (!col.filterable) continue;
            const format = col.format || 'text';
            const options = Array.isArray(col.toneMap) && col.toneMap.length
                ? col.toneMap.map((m) => ({ value: m.value, label: m.label ?? m.value }))
                : canFacet(format) ? facetValues(baseRows, col.key) : null;
            out[col.key] = { kind: filterKindFor(format, { hasOptions: !!options }), options };
        }
        return out;
    }, [cols, baseRows]);

    const columns = useMemo(() => {
        const list = cols.map((col) => ({
            id: col.key,
            accessorKey: col.key,
            header: col.label || col.key,
            enableSorting: col.sortable !== false,
            enableColumnFilter: !!col.filterable,
            filterFn: makeFilterFn(filterMeta[col.key]?.kind),
            size: Number.isFinite(col.width) ? col.width : undefined,
            meta: {
                format: col.format || 'text', editable: !!col.editable,
                align: alignFor(col), truncate: !!col.truncate,
                filterKind: filterMeta[col.key]?.kind || null,
                filterOptions: filterMeta[col.key]?.options || null,
                toneMap: Array.isArray(col.toneMap) && col.toneMap.length ? col.toneMap : null,
                help: typeof col.help === 'string' && col.help ? col.help : null,
                // Set when the whole column is a button (spec: columns[].actionId).
                actionId: typeof col.actionId === 'string' && col.actionId ? col.actionId : null,
            },
            cell: (ctx: GridCellContext) => {
                const value = ctx.getValue();
                if (col.editable && isRun) {
                    return (
                        <EditableCell
                            value={value}
                            format={col.format || 'text'}
                            col={col}
                            row={ctx.row.original}
                            now={now}
                            clamp={clampLines}
                            // UNCHANGED: the overlay, the queue and the
                            // rollback live in useGridEditQueue.
                            onCommit={(next) => commitEdit(ctx.row.original, ctx.row.index, col.key, next)}
                        />
                    );
                }
                return (
                    <CellValue
                        value={value}
                        format={col.format || 'text'}
                        col={col}
                        row={ctx.row.original}
                        now={now}
                    />
                );
            },
        }));
        return list;
    // Same dependency list as before the move: clampLines and commitEdit are
    // deliberately NOT in it (commitEdit only reads refs, setters and the two
    // values listed here; the clamp omission is the pre-split behaviour).
    }, [cols, filterMeta, isRun, onRowSelect, runAction, now]);

    return { cols, columns };
}
