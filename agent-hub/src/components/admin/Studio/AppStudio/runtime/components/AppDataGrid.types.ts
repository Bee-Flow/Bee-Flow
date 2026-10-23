import type { BindingInput } from '../resolveBinding.types';
import type { GridColumn } from './grid/useGridColumns';
import type { GridAction } from './grid/gridTypes';

/**
 * App Studio runtime — 'data_grid'. Spec: server/appStudio/componentSpecs.js.
 *
 * The cell switch moved to the shared `cellValue` module, which AppTable also
 * imports — the two used to keep private copies that had already drifted apart.
 *
 * The pieces (cells, edit queue, columns, rows, chrome) live under ./grid/;
 * this file keeps the table instance, the virtualizer and the composition.
 */

export interface DataGridProps {
    source?: BindingInput;
    columns?: GridColumn[];
    pageSize?: number;
    selectable?: string;
    searchable?: boolean;
    rowActions?: GridAction[];
    bulkActions?: GridAction[];
    toolbarActions?: GridAction[];
    addRowLabel?: string;
    addRowActionId?: string;
    density?: string;
    emptyText?: string;
    zebra?: boolean;
    look?: string;
    clamp?: string;
    rowTone?: unknown;
    groupBy?: string | null;
    groupOrder?: unknown;
    activeWhen?: unknown;
}
