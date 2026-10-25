import type { AutomationRecord, RunIdSet, OverviewLane } from './overviewModel';
import type { AutomationRowProps } from './AutomationRow';
import type { ProjectContextPillProject } from '../../../chat/ProjectContextPill';
import type React from 'react';

/** Builds the props one row, card or tile is given. */
export type RowPropsFn = (a: AutomationRecord) => AutomationRowProps;

export interface AutomationsOverviewProps {
    automations?: AutomationRecord[];
    folders?: ProjectContextPillProject[];
    query?: string;
    loading?: boolean;
    activeRunIds?: RunIdSet | null;
    /** The same per-row callbacks the sidebar row gets. */
    rowProps?: RowPropsFn | null;
    onCreate?: (() => void) | null;
    onCreateBlock?: (() => void) | null;
    onCreateFolder?: ((name: string) => unknown) | null;
    canCreate?: boolean;
}

/**
 * "New folder" from the overview's New menu. The sidebar names a folder inline
 * (FolderedAutomationList); a toolbar menu cannot host an input, so the overview
 * gets the same name/commit/cancel as a small dialog instead.
 */
export interface NewFolderDialogProps {
    onCreate: (name: string) => void;
    onClose: () => void;
}

export interface SortHeadProps {
    col: string;
    sort: string;
    onSort: (key: string) => void;
    className?: string;
    children?: React.ReactNode;
}

export interface ListViewProps {
    rows: AutomationRecord[];
    rowProps?: RowPropsFn | null;
    activeRunIds?: RunIdSet | null;
    sort: string;
    onSort: (key: string) => void;
}

/** The first cell: the trigger tile, the name and one line about it. */
export interface NameCellProps {
    automation: AutomationRecord;
    liveRunning: boolean;
    onSelect?: () => void;
}

export interface ListRowProps {
    automation: AutomationRecord;
    props?: AutomationRowProps | null;
    liveRunning: boolean;
}

export interface CardProps {
    automation: AutomationRecord;
    props?: AutomationRowProps | null;
    liveRunning: boolean;
    compact?: boolean;
    hideLifecycle?: boolean;
}

export interface BoardViewProps {
    lanes: OverviewLane[] | null;
    groupBy: string;
    rowProps?: RowPropsFn | null;
    activeRunIds?: RunIdSet | null;
}
