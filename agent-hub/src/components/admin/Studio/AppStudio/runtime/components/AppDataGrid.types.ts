import type { GridAction } from './grid/gridTypes';
import type { GridColumn } from './grid/useGridColumns';

/** The data_grid node's props, as the grid reads them (spec: componentSpecs.js). */
export interface GridProps {
    source?: unknown;
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
    rowTone?: unknown[];
    groupBy?: string | null;
    groupOrder?: string[];
    activeWhen?: unknown;
}
