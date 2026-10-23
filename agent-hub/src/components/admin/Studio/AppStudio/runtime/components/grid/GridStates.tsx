import { Plus } from 'lucide-react';
import useTranslation from '../../../../../../../hooks/useTranslation';
import { EmptyText } from '../../uiBits';
import type { ReactElement } from 'react';
import type { RunAction } from './gridTypes';

/**
 * The fixed states and edge rows of the App Studio data grid: the empty state
 * of a grid with no data, the column widths, the add-row line at the bottom
 * of the body and the "no rows match" row. Moved out of AppDataGrid.jsx
 * verbatim; the conditions that decide whether each one shows stay there.
 */

// uiBits.jsx is JS: its prop types are inferred from the `= null` defaults,
// which would reject the strings EmptyText renders. Same function, typed.
const EmptyTextTyped = EmptyText as unknown as (props: {
    text: string;
    title?: string | null;
    art?: string | null;
}) => ReactElement;

export interface GridEmptyStateProps {
    emptyText: string;
    isRun: boolean;
    addRowActionId: string;
    addRowLabel: string;
    runAction: RunAction;
}

export function GridEmptyState({ emptyText, isRun, addRowActionId, addRowLabel, runAction }: GridEmptyStateProps) {
    const { t } = useTranslation();
    return (
        <div className="w-full" data-app-datagrid="true">
            <EmptyTextTyped art="no-results" title={t('studio_apps_runtime.grid.nothing_here', 'Nothing here yet')} text={emptyText} />
            {isRun && addRowActionId ? (
                <div className="flex justify-center pb-3" data-app-grid-addrow="true">
                    <button
                        type="button"
                        onClick={() => runAction(addRowActionId, {})}
                        className="inline-flex items-center gap-1.5 px-2 py-1 text-sm font-medium"
                        style={{ color: 'var(--app-primary)' }}
                    >
                        <Plus className="h-3.5 w-3.5" aria-hidden="true" />
                        {addRowLabel || t('studio_apps_runtime.grid.add_row', 'Add row')}
                    </button>
                </div>
            ) : null}
        </div>
    );
}

export interface GridColGroupProps {
    selectable: string;
    columns: Array<{ id: string; size?: number }>;
    hasRowActions: boolean;
}

export function GridColGroup({ selectable, columns, hasRowActions }: GridColGroupProps) {
    return (
        <colgroup>
            {selectable !== 'none' ? <col style={{ width: 36 }} /> : null}
            {columns.map((c) => (
                <col key={c.id} style={Number.isFinite(c.size) ? { width: c.size } : undefined} />
            ))}
            {hasRowActions ? <col /> : null}
        </colgroup>
    );
}

export interface GridAddRowProps {
    colSpan: number;
    cellPad: string;
    addRowLabel: string;
    onAdd: () => void;
}

export function GridAddRow({ colSpan, cellPad, addRowLabel, onAdd }: GridAddRowProps) {
    const { t } = useTranslation();
    return (
        <tr data-app-grid-addrow="true">
            <td colSpan={colSpan} className="p-0">
                <button
                    type="button"
                    onClick={onAdd}
                    className={`flex w-full items-center gap-1.5 ${cellPad} text-left font-medium`}
                    style={{ color: 'var(--app-primary)' }}
                >
                    <Plus className="h-3.5 w-3.5" aria-hidden="true" />
                    {addRowLabel || t('studio_apps_runtime.grid.add_row', 'Add row')}
                </button>
            </td>
        </tr>
    );
}

// Filtered to nothing is a different state from having no
// data, and it has a way out — so it says which filters are
// holding the rows back and offers to drop them, instead of
// the four flat words it used to print.
export function GridNoMatchRow({ colSpan, activeFilterCount, clearFilters }: { colSpan: number; activeFilterCount: number; clearFilters: () => void }) {
    const { t } = useTranslation();
    return (
        <tr>
            <td colSpan={colSpan} className="px-3 py-8 text-center">
                <p className="text-sm font-medium text-[var(--text-primary)]">{t('studio_apps_runtime.grid.no_rows_match', 'No rows match')}</p>
                {activeFilterCount > 0 ? (
                    <>
                        <p className="mt-0.5 text-xs text-[var(--text-secondary)]">
                            {activeFilterCount === 1
                                ? t('studio_apps_runtime.grid.one_filter_hiding', 'One filter is hiding the rest.')
                                : t('studio_apps_runtime.grid.n_filters_hiding', '{n} filters are hiding the rest.', { n: activeFilterCount })}
                        </p>
                        <button
                            type="button"
                            onClick={clearFilters}
                            className="mt-2 px-2.5 py-1 text-xs font-medium border"
                            style={{ borderColor: 'var(--border-default)', borderRadius: 'var(--app-radius)', color: 'var(--text-secondary)' }}
                        >
                            {t('studio_apps_runtime.grid.clear_filters', 'Clear filters')}
                        </button>
                    </>
                ) : null}
            </td>
        </tr>
    );
}
