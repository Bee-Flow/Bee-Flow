// Typed doors onto shared components that are still plain JavaScript.
//
// TypeScript infers a .jsx component's props from its default values, so
// `columns = []` reads as `never[]` and `children = null` as "no children":
// unusable from a .tsx file. These are the props the components actually
// take, declared once here instead of cast at every use.

import type React from 'react';
import MemoryPanelJs from '../../../knowledge/memory/MemoryPanel';
import DataTableJs, { TableCell as TableCellJs, TableRow as TableRowJs } from '../../../shared/DataTable';

export interface TableColumn {
    id: string;
    label: React.ReactNode;
    /** A grid track: '1fr', '120px'. */
    width?: string;
    align?: 'left' | 'right' | 'center';
    /** Hide the column (and its grid track) when the table is narrower than this. */
    foldBelow?: 1180 | 900;
}

export interface DataTableProps<T> {
    columns: TableColumn[];
    rows: T[];
    renderRow: (row: T) => React.ReactNode;
    renderCard?: (row: T) => React.ReactNode;
    isMobile?: boolean;
    /** Render the cards (renderCard) whenever the table is narrower than this many px. */
    cardsBelow?: number;
    rowKey?: (row: T, index: number) => string | number;
    loading?: boolean;
    skeletonRows?: number;
    /** Shown inside the table when `rows` is empty. */
    empty?: React.ReactNode;
    ariaLabel?: string;
    testId?: string;
    className?: string;
}

export interface TableRowProps {
    columns: TableColumn[];
    onClick?: (e: React.SyntheticEvent) => void;
    testId?: string;
    className?: string;
    children?: React.ReactNode;
}

export interface TableCellProps {
    column?: TableColumn;
    align?: 'left' | 'right' | 'center';
    className?: string;
    testId?: string;
    children?: React.ReactNode;
}

export const DataTable = DataTableJs as unknown as <T>(props: DataTableProps<T>) => React.ReactElement;
export const TableRow = TableRowJs as unknown as React.ComponentType<TableRowProps>;
export const TableCell = TableCellJs as unknown as React.ComponentType<TableCellProps>;

/** Project memory: a shared pool; `canEdit` false hides every write. */
export const MemoryPanel = MemoryPanelJs as unknown as React.ComponentType<{
    projectId: string;
    canEdit: boolean;
    embedded?: boolean;
    extractMemories?: boolean;
    onClose?: () => void;
}>;
