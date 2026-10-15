// Types for the JavaScript table, so TypeScript callers see its real props
// (the .jsx infers every destructured prop without a default as required).
import type { CSSProperties, ReactElement, ReactNode } from 'react';

export interface TableColumn {
    id: string;
    label: string;
    width: string;
    foldBelow?: number;
    [key: string]: unknown;
}

/** What `renderRow` and `renderCard` receive next to the row. */
export interface TableRenderContext {
    columns: TableColumn[];
    isMobile: boolean;
    gridTemplateColumns: string;
    index: number;
}

export const TABLE_CONTAINER: string;
export const TABLE_FOLD: string;
export const TABLE_FOLD_NARROW: string;
export const TABLE_FOLDED_ONLY: Readonly<Record<number, string>>;
export const TABLE_GRID: string;

export function gridTemplate(columns?: TableColumn[], tier?: unknown): string;
export function accentColor(accent: string | null | undefined): string;

export function TableCell(props: {
    column?: TableColumn | null;
    children?: ReactNode;
    className?: string;
    align?: 'left' | 'right' | 'center';
    testId?: string;
}): ReactElement;

export function TableHeader(props: {
    columns?: TableColumn[];
    className?: string;
    testId?: string;
}): ReactElement;

export function TableRow(props: {
    accent?: string | null;
    selected?: boolean;
    expanded?: boolean;
    onClick?: (() => void) | null;
    ariaExpanded?: boolean;
    columns?: TableColumn[];
    children?: ReactNode;
    className?: string;
    testId?: string;
    style?: CSSProperties;
}): ReactElement;

export interface DataTableProps<R> {
    columns?: TableColumn[];
    rows?: R[];
    rowKey?: (row: R, index: number) => string | number;
    renderRow: (row: R, ctx: TableRenderContext) => ReactNode;
    renderCard?: ((row: R, ctx: TableRenderContext) => ReactNode) | null;
    isMobile?: boolean;
    cardsBelow?: number;
    loading?: boolean;
    skeletonRows?: number;
    empty?: ReactNode;
    footer?: ReactNode;
    containerName?: string;
    className?: string;
    ariaLabel?: string;
    testId?: string;
}

export default function DataTable<R>(props: DataTableProps<R>): ReactElement;
