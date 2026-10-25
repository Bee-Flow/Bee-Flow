import { ChevronLeft, ChevronRight, Search, X } from 'lucide-react';
import type { Dispatch, SetStateAction } from 'react';
import type { RowSelectionState } from '@tanstack/table-core';
import useTranslation from '../../../../../../../hooks/useTranslation';
import { ROLE_COLORS } from '../../styleResolver.constants';
import { describeFilter as describeFilterJs } from '../gridColumnFilters';
import GridViewMenu from '../GridViewMenu';
import type { GridAction, GridColumnMeta, GridTable, RunAction } from './gridTypes';

/**
 * The chrome around the App Studio data grid's table: the selection bar, the
 * search / filter-chip / toolbar row and the pagination footer. Moved out of
 * AppDataGrid.jsx verbatim; the conditions that decide whether each one shows
 * stay in the grid.
 */

const ROLES = ROLE_COLORS as Record<string, string>;
// gridColumnFilters.js is untyped and its `= null` defaults infer as `null`.
const describeFilter = describeFilterJs as unknown as (
    kind: unknown, value: unknown, opts: { options?: unknown; t?: unknown },
) => string;

export interface GridSelectionBarProps {
    boxed: boolean;
    selectedCount: number;
    isRun: boolean;
    bulkActions: GridAction[];
    table: GridTable;
    runAction: RunAction;
    setRowSelection: Dispatch<SetStateAction<RowSelectionState>>;
}

export function GridSelectionBar({ boxed, selectedCount, isRun, bulkActions, table, runAction, setRowSelection }: GridSelectionBarProps) {
    const { t } = useTranslation();
    return (
            <div
                className={`flex flex-wrap items-center gap-x-3 gap-y-1.5 px-2.5 py-1.5 text-xs${boxed ? ' shrink-0' : ''}`}
                style={{ background: 'var(--app-primary-soft)', color: 'var(--app-primary)', borderRadius: 'var(--app-radius)' }}
                data-app-grid-selection="true"
            >
                <span className="font-medium">{t('studio_apps_runtime.grid.n_selected', '{n} selected', { n: selectedCount })}</span>
                {isRun && bulkActions.length ? bulkActions.map((a, i) => (
                    <button
                        key={i}
                        type="button"
                        onClick={() => {
                            if (!a.actionId) return;
                            const picked = table.getSelectedRowModel().rows.map((r) => r.original);
                            // Handed over as FORM VALUES, so the action reads
                            // them as form.selectedRows — the same shape every
                            // other control here uses, and no new scope root.
                            runAction(a.actionId, {
                                formValues: {
                                    selectedRows: picked,
                                    selectedIds: picked.map((r) => r && r.id).filter(Boolean),
                                    selectedCount: picked.length,
                                },
                                item: picked[0],
                            });
                            // Dropping the selection immediately is deliberate:
                            // the rows are about to change or disappear, and a
                            // tick left behind on a deleted row is a lie.
                            setRowSelection({});
                        }}
                        className="px-2 py-0.5 font-medium border"
                        style={{
                            borderColor: a.tone && ROLES[a.tone] ? ROLES[a.tone] : 'currentColor',
                            color: a.tone && ROLES[a.tone] ? ROLES[a.tone] : 'inherit',
                            borderRadius: 'var(--app-radius)',
                            background: 'var(--bg-primary)',
                        }}
                    >
                        {a.label}
                    </button>
                )) : null}
                <button
                    type="button"
                    onClick={() => setRowSelection({})}
                    className="underline underline-offset-2"
                >
                    {t('studio_apps_runtime.grid.clear', 'Clear')}
                </button>
            </div>
    );
}

export interface GridChromeRowProps {
    boxed: boolean;
    searchable: boolean;
    isRun: boolean;
    globalFilter: string;
    setGlobalFilter: (value: string) => void;
    activeColumnFilters: Array<{ id: string; value: unknown }>;
    activeFilterCount: number;
    clearFilters: () => void;
    table: GridTable;
    toolbarActions: GridAction[];
    runAction: RunAction;
    view: Record<string, string | undefined>;
    setViewKey: (key: string, value: string) => void;
    resetView: () => void;
    hasViewOverrides: boolean;
}

export function GridChromeRow({
    boxed, searchable, isRun, globalFilter, setGlobalFilter, activeColumnFilters, activeFilterCount,
    clearFilters, table, toolbarActions, runAction, view, setViewKey, resetView, hasViewOverrides,
}: GridChromeRowProps) {
    const { t } = useTranslation();
    return (
            <div className={`flex flex-wrap items-center gap-x-3 gap-y-2${boxed ? ' shrink-0' : ''}`}>
                {searchable ? (
                    <div className="relative min-w-[9rem] max-w-xs flex-1">
                        <Search className="w-3.5 h-3.5 absolute left-2.5 top-1/2 -translate-y-1/2 text-[var(--text-muted)]" aria-hidden="true" />
                        <input
                            value={globalFilter ?? ''}
                            onChange={(e) => setGlobalFilter(e.target.value)}
                            placeholder={t('studio_apps_runtime.grid.search_placeholder', 'Search…')}
                            aria-label={t('studio_apps_runtime.grid.search_rows', 'Search rows')}
                            className="w-full border pl-8 pr-2.5 py-1.5 text-sm outline-none focus:border-[var(--app-primary)] [background:var(--bg-primary)] [border-color:var(--border-default)]! [border-radius:var(--app-radius)] [color:var(--text-primary)]!"
                        />
                    </div>
                ) : null}
                {/*
                  * Filters were invisible once set: a column filter is a
                  * small box in a header row that scrolls, and a search
                  * term left in the box looked like an empty table. The
                  * count says the view is narrowed and the button undoes
                  * it — from ANY scroll position.
                  */}
                {/*
                  * One chip per column filter, in words: "Amount ≥ 500",
                  * "Status: Open". The controls themselves sit in a row
                  * that scrolls with the table, so this is where a reader
                  * sees WHAT narrowed the view — and drops one filter
                  * without losing the others.
                  */}
                {activeColumnFilters.map((f) => {
                    const column = table.getColumn(f.id);
                    if (!column) return null;
                    const meta = (column.columnDef.meta || {}) as GridColumnMeta;
                    const label = (column.columnDef.header as string | undefined) || f.id;
                    const text = describeFilter(meta.filterKind, f.value, { options: meta.filterOptions, t });
                    return (
                        <span
                            key={f.id}
                            data-app-grid-chip={f.id}
                            className="inline-flex max-w-[16rem] items-center gap-1 border pl-2 pr-1 py-0.5 text-xs [background:var(--bg-primary)] [border-color:var(--app-primary)] [color:var(--text-primary)]! [border-radius:var(--app-radius)]"
                        >
                            <span className="truncate">
                                <span className="text-[var(--text-secondary)]">{label} </span>
                                <span className="font-medium">{text}</span>
                            </span>
                            <button
                                type="button"
                                onClick={() => column.setFilterValue(undefined)}
                                className="inline-flex h-4 w-4 shrink-0 items-center justify-center rounded-full hover:bg-[var(--app-primary-soft)] [color:var(--text-muted)]"
                            >
                                <X className="h-3 w-3" aria-hidden="true" />
                                <span className="sr-only">{t('studio_apps_runtime.grid.remove_filter', 'Remove filter on {name}', { name: label })}</span>
                            </button>
                        </span>
                    );
                })}
                {activeFilterCount > 0 ? (
                    <button
                        type="button"
                        onClick={clearFilters}
                        data-app-grid-filters={activeFilterCount}
                        className="flex items-center gap-1.5 px-2 py-1 text-xs font-medium shrink-0 [background:var(--app-primary-soft)] [color:var(--app-primary)]! [border-radius:var(--app-radius)]"
                    >
                        {/* Beside chips that already say what is set, the
                            count would repeat them: the button becomes the
                            one thing the chips cannot do. */}
                        <span>{activeColumnFilters.length
                            ? t('studio_apps_runtime.grid.clear_all', 'Clear all')
                            : activeFilterCount === 1
                                ? t('studio_apps_runtime.grid.one_filter', '1 filter')
                                : t('studio_apps_runtime.grid.n_filters', '{n} filters', { n: activeFilterCount })}</span>
                        <X className="w-3 h-3" aria-hidden="true" />
                        <span className="sr-only">{t('studio_apps_runtime.grid.clear_all_filters', 'Clear all filters')}</span>
                    </button>
                ) : null}
                {/* Pushed right: these belong to the table as a whole, not
                    to the search term sitting next to it. */}
                {isRun ? (
                    <div className="ml-auto flex items-center gap-2">
                        {toolbarActions.map((a, i) => {
                            const filled = a.tone === 'primary';
                            return (
                                <button
                                    key={i}
                                    type="button"
                                    onClick={() => { if (a.actionId) runAction(a.actionId, {}); }}
                                    className="inline-flex shrink-0 items-center px-2.5 py-1.5 text-xs font-medium border whitespace-nowrap"
                                    style={{
                                        background: filled ? 'var(--app-primary)' : 'var(--bg-primary)',
                                        color: filled ? 'var(--app-primary-contrast)' : 'var(--text-secondary)',
                                        borderColor: filled ? 'var(--app-primary)' : 'var(--border-default)',
                                        borderRadius: 'var(--app-radius)',
                                    }}
                                >
                                    {a.label}
                                </button>
                            );
                        })}
                        <GridViewMenu
                            view={view}
                            onChange={setViewKey}
                            onReset={resetView}
                            hasOverrides={hasViewOverrides}
                        />
                    </div>
                ) : null}
            </div>
    );
}

export interface GridFooterProps {
    boxed: boolean;
    rangeFrom: number;
    rangeTo: number;
    filteredCount: number;
    pageSize: number;
    setPageSize: (size: number) => void;
    setPageIndex: (index: number) => void;
    pageSizeChoices: number[];
    table: GridTable;
}

export function GridFooter({ boxed, rangeFrom, rangeTo, filteredCount, pageSize, setPageSize, setPageIndex, pageSizeChoices, table }: GridFooterProps) {
    const { t } = useTranslation();
    return (
            <div className={`flex flex-wrap items-center justify-between gap-x-3 gap-y-2 text-xs${boxed ? ' shrink-0' : ''} text-[var(--text-secondary)]`}>
                {/*
                  * "Page 3 of 12" tells you where you are but not how much
                  * there IS — the number people actually want from a table.
                  */}
                <div className="flex items-center gap-3">
                    <span>{t('studio_apps_runtime.grid.range', '{from}–{to} of {total}', { from: rangeFrom, to: rangeTo, total: filteredCount })}</span>
                    <label className="inline-flex items-center gap-1.5">
                        <span className="sr-only">{t('studio_apps_runtime.grid.rows_per_page', 'Rows per page')}</span>
                        <select
                            value={pageSize}
                            onChange={(e) => { setPageSize(Number(e.target.value)); setPageIndex(0); }}
                            aria-label={t('studio_apps_runtime.grid.rows_per_page', 'Rows per page')}
                            className="border px-1.5 py-0.5 text-xs outline-none focus:border-[var(--app-primary)] [background:var(--bg-primary)] [border-color:var(--border-default)]! [border-radius:var(--app-radius)] [color:var(--text-primary)]!"
                        >
                            {pageSizeChoices.map((n) => <option key={n} value={n}>{n}</option>)}
                        </select>
                        <span aria-hidden="true">{t('studio_apps_runtime.grid.per_page', 'per page')}</span>
                    </label>
                </div>
                <div className="flex items-center gap-1">
                    <button
                        type="button"
                        onClick={() => table.previousPage()}
                        disabled={!table.getCanPreviousPage()}
                        className="inline-flex items-center gap-1 px-2 py-1 border disabled:opacity-40 [border-color:var(--border-default)] [border-radius:var(--app-radius)]"
                        aria-label={t('studio_apps_runtime.grid.previous_page', 'Previous page')}
                    >
                        <ChevronLeft className="w-3.5 h-3.5" aria-hidden="true" /> {t('studio_apps_runtime.grid.prev', 'Prev')}
                    </button>
                    <button
                        type="button"
                        onClick={() => table.nextPage()}
                        disabled={!table.getCanNextPage()}
                        className="inline-flex items-center gap-1 px-2 py-1 border disabled:opacity-40 [border-color:var(--border-default)] [border-radius:var(--app-radius)]"
                        aria-label={t('studio_apps_runtime.grid.next_page', 'Next page')}
                    >
                        {t('studio_apps_runtime.grid.next', 'Next')} <ChevronRight className="w-3.5 h-3.5" aria-hidden="true" />
                    </button>
                </div>
            </div>
    );
}
